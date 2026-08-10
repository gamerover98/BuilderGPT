/**
 * Crash recovery for the open document.
 *
 * The rule the plan sets is that autosave is *separate from the user's file*:
 * it must never write over what they chose to save, because the whole point is
 * to preserve work they have not decided about yet. So a snapshot is a Sponge
 * v3 `.schem` in the app's own directory, plus a sidecar recording where the
 * document actually belongs.
 *
 * ## Polling a counter, not listening for changes
 *
 * There is no `noteChange()` for callers to remember to call. A timer compares
 * `doc.revision` — monotonic, bumped by every mutation including an undo —
 * against the revision last written, and snapshots when they differ. Comparing
 * an integer every twenty seconds costs nothing, and unlike a notification it
 * cannot be forgotten at a new call site.
 *
 * ## What is deliberately not snapshotted
 *
 * The undo history. Recovering *what you had* is the promise; recovering the
 * path you took to it is not, and serialising the stack would mean versioning
 * a second on-disk format for a case nobody has asked for. A restored document
 * starts with an empty history and is marked as differing from disk.
 */

import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

import type { SchematicFormat } from "../../shared/schematic.js";
import { documentFromLoaded, type SchematicDocument } from "../domain/document.js";
import { createHistory, isDirty } from "../domain/history.js";
import { loadStructure } from "../pipeline/loader.js";
import type { DocumentSession } from "./session.js";
import { saveDocument } from "./writers.js";

/** How often the timer looks at the revision counter. */
export const AUTOSAVE_INTERVAL_MS = 20_000;

const SNAPSHOT_NAME = "autosave.schem";
const SIDECAR_NAME = "autosave.json";

/** What was recovered, as the renderer needs to describe it to the user. */
export interface AutosaveRecord {
  /** Where the document belongs, or `null` if it had never been saved. */
  filePath: string | null;
  /** The name to show — the original file's, or "Untitled". */
  fileName: string | null;
  /** The container it should go back to, which may not be the snapshot's. */
  format: SchematicFormat;
  /** ISO 8601. */
  savedAt: string;
  blockCount: number;
}

function snapshotPath(dir: string): string {
  return path.join(dir, SNAPSHOT_NAME);
}

function sidecarPath(dir: string): string {
  return path.join(dir, SIDECAR_NAME);
}

/**
 * Writes a snapshot of the document.
 *
 * Always Sponge v3, whatever the document's own format: this file is never
 * handed to the user, only read back by this module, so it should be the
 * container that loses the least. The document's real format travels in the
 * sidecar and is restored with it.
 */
export async function writeAutosave(doc: SchematicDocument, dir: string): Promise<AutosaveRecord> {
  await mkdir(dir, { recursive: true });
  await saveDocument(doc, snapshotPath(dir), { format: "sponge3" });

  let blockCount = 0;
  for (const index of doc.voxels) {
    if (index !== 0) blockCount += 1;
  }

  const record: AutosaveRecord = {
    filePath: doc.filePath,
    fileName: doc.filePath === null ? null : path.basename(doc.filePath),
    format: doc.format,
    savedAt: new Date().toISOString(),
    blockCount,
  };
  // The sidecar is written *after* the snapshot, and read first on the way
  // back: a crash between the two leaves a snapshot with no sidecar, which
  // reads as "nothing to recover" rather than as a recovery pointing at a
  // half-written file.
  await writeFile(sidecarPath(dir), JSON.stringify(record, null, 2), "utf-8");
  return record;
}

/** The pending recovery, or `null` when there is none. */
export async function readAutosave(dir: string): Promise<AutosaveRecord | null> {
  let raw: string;
  try {
    raw = await readFile(sidecarPath(dir), "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AutosaveRecord>;
    if (typeof parsed.savedAt !== "string") {
      return null;
    }
    return {
      filePath: typeof parsed.filePath === "string" ? parsed.filePath : null,
      fileName: typeof parsed.fileName === "string" ? parsed.fileName : null,
      format: (parsed.format ?? "sponge3") as SchematicFormat,
      savedAt: parsed.savedAt,
      blockCount: typeof parsed.blockCount === "number" ? parsed.blockCount : 0,
    };
  } catch {
    // A truncated sidecar is not an error worth surfacing: it means the last
    // write was interrupted, and the honest answer is that there is nothing
    // trustworthy to recover.
    return null;
  }
}

export async function clearAutosave(dir: string): Promise<void> {
  await rm(sidecarPath(dir), { force: true });
  await rm(snapshotPath(dir), { force: true });
}

/**
 * Rebuilds a session from the snapshot.
 *
 * The restored document carries the *original* path and format, so a plain
 * Save afterwards goes where the user expects rather than into the app's
 * autosave directory. It is marked as differing from disk — which it does,
 * and which no undo can be shown to reverse, since the history did not survive.
 */
export async function restoreAutosave(dir: string): Promise<DocumentSession | null> {
  const record = await readAutosave(dir);
  if (record === null) {
    return null;
  }
  let loaded;
  try {
    loaded = await loadStructure(snapshotPath(dir));
  } catch {
    return null;
  }

  const doc = documentFromLoaded(loaded, record.filePath);
  doc.format = record.format;
  const history = createHistory();
  // `savedDepth` of -1 is unreachable, which is the point: the document differs
  // from disk and there is no sequence of undos that can prove otherwise.
  history.savedDepth = -1;
  return { doc, history, mesh: null };
}

/**
 * Starts the snapshot timer. Returns a function that stops it.
 *
 * Snapshots only a dirty document, and clears the snapshot once one is saved:
 * a stale "unsaved work" prompt on next launch, for work that was in fact
 * saved, teaches people to dismiss the prompt without reading it.
 */
export function startAutosave(options: {
  dir: string;
  getSession: () => DocumentSession | null;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}): () => void {
  let lastRevision: number | null = null;
  let running = false;

  const tick = async (): Promise<void> => {
    // A snapshot of a large schematic can outlast the interval; overlapping
    // writes would race each other onto the same two files.
    if (running) return;
    running = true;
    try {
      const session = options.getSession();
      if (session === null) {
        return;
      }
      if (!isDirty(session.history)) {
        if (lastRevision !== null) {
          await clearAutosave(options.dir);
          lastRevision = null;
        }
        return;
      }
      if (session.doc.revision === lastRevision) {
        return;
      }
      await writeAutosave(session.doc, options.dir);
      lastRevision = session.doc.revision;
    } catch (err) {
      // Autosave failing must never take the app with it: the user still has
      // their document, and the next tick will try again.
      options.onError?.(err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? AUTOSAVE_INTERVAL_MS);
  // Never hold the process open on this alone.
  timer.unref?.();
  return () => clearInterval(timer);
}
