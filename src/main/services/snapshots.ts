/**
 * A schematic's own version history, on disk, per file.
 *
 * The chat can already put a schematic back to how it was before a question —
 * that is `checkpoints.ts`, and it belongs to a conversation, dies with it, and
 * only ever covers agent turns. This is the other half: versions of the *file*,
 * kept beside it in userData, surviving the conversation, the session and the
 * app being closed.
 *
 * It is what the Generate tab shows. A generation replaces everything that was
 * open, which makes it the single most destructive thing the app does and the
 * one place a way back is worth the disk.
 *
 * ## Uncropped, like every other snapshot here
 *
 * `saveSession` trims a schematic to its content on the way out, which is right
 * for the user's file and wrong for this: coming back would hand them the build
 * without the room they had made to build in. So this calls the writers
 * directly, exactly as `autosave.ts` and `checkpoints.ts` do.
 *
 * ## Sponge v3, whatever the document is
 *
 * These files are only ever read back by this module, so they should be in the
 * container that loses the least — an MCEdit round trip would quietly drop
 * block states the document still has.
 *
 * ## Keyed by path, and a document with no path has no history
 *
 * The key is the file, so the history follows the schematic rather than the
 * session. An unsaved document therefore has nowhere to keep one; it gets a
 * history the moment it is first saved, which is the same rule conversations
 * follow.
 */

import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

import {
  countBlocks,
  documentFromLoaded,
  type SchematicDocument,
} from "../domain/document.js";
import { createHistory, type History } from "../domain/history.js";
import { loadStructure } from "../pipeline/loader.js";
import { saveDocument } from "./writers.js";
import { storeFileName } from "./conversation_store.js";
import type { DocumentSession } from "./session.js";
import {
  addSnapshot,
  coerceSnapshots,
  removeSnapshot,
  snapshotId,
  snapshotLabel,
  type Snapshot,
  type SnapshotSource,
} from "./snapshots_core.js";

let directory: string | null = null;

/** Where versions are kept. Called once, at startup. */
export function useSnapshotDirectory(dir: string): void {
  directory = dir;
}

/**
 * One folder per schematic, named by a hash of its path.
 *
 * The same hash the conversations use, minus the `.json` — one schematic's
 * versions and one schematic's conversations then sit under names that can be
 * matched up by eye when something needs looking at on disk.
 */
function folderFor(filePath: string): string | null {
  if (directory === null) return null;
  return path.join(directory, storeFileName(filePath).replace(/\.json$/, ""));
}

function indexFile(filePath: string): string | null {
  const folder = folderFor(filePath);
  return folder === null ? null : path.join(folder, "index.json");
}

async function readIndex(filePath: string): Promise<Snapshot[]> {
  const file = indexFile(filePath);
  if (file === null) return [];
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { versions?: unknown };
    return coerceSnapshots(parsed.versions);
  } catch {
    // No history yet, or one this build cannot read. Either way the answer is
    // the same and it is not an error: the schematic is fine, it just has no
    // versions to offer.
    return [];
  }
}

async function writeIndex(filePath: string, versions: readonly Snapshot[]): Promise<void> {
  const folder = folderFor(filePath);
  const file = indexFile(filePath);
  if (folder === null || file === null) return;
  await mkdir(folder, { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, versions }, null, 2), "utf8");
}

async function removeFiles(filePath: string, ids: readonly string[]): Promise<void> {
  const folder = folderFor(filePath);
  if (folder === null) return;
  for (const id of ids) {
    try {
      await rm(path.join(folder, `${id}.schem`), { force: true });
    } catch {
      // Swept next time, or never. An orphaned file costs disk and nothing else.
    }
  }
}

/** Every version of this schematic, newest first. */
export async function listSnapshots(filePath: string | null): Promise<Snapshot[]> {
  return filePath === null ? [] : await readIndex(filePath);
}

/**
 * Writes the open document as a version of its file.
 *
 * `null` when there is nowhere to put it — no path yet, or no directory
 * injected. Callers treat that as "no version recorded" rather than as a
 * failure: whatever produced the document is what the user asked for, and it
 * must not be refused because a convenience could not be kept.
 */
export async function takeSnapshot(
  session: DocumentSession,
  source: SnapshotSource,
  label: string,
  now: number = Date.now(),
): Promise<Snapshot | null> {
  const filePath = session.doc.filePath;
  const folder = filePath === null ? null : folderFor(filePath);
  if (filePath === null || folder === null) return null;

  const entry: Snapshot = {
    id: snapshotId(now),
    at: now,
    source,
    label: snapshotLabel(source, label),
    size: [session.doc.width, session.doc.height, session.doc.length],
    blockCount: countBlocks(session.doc),
  };

  try {
    await mkdir(folder, { recursive: true });
    // Sponge v3 and *not* cropped — see the note at the top of this file.
    await saveDocument(session.doc, path.join(folder, `${entry.id}.schem`), { format: "sponge3" });
  } catch {
    return null;
  }

  const { kept, dropped } = addSnapshot(await readIndex(filePath), entry);
  await writeIndex(filePath, kept);
  await removeFiles(filePath, dropped);
  return entry;
}

/** A restored version, ready for `adoptDocument`. `null` if it has gone. */
export async function readSnapshot(
  filePath: string,
  id: string,
): Promise<{ doc: SchematicDocument; history: History } | null> {
  const folder = folderFor(filePath);
  if (folder === null) return null;
  try {
    const doc = documentFromLoaded(await loadStructure(path.join(folder, `${id}.schem`)), filePath);
    /*
     * A fresh history with an unreachable saved point, the same arrangement
     * `readCheckpoint` and `restoreAutosave` use: the document differs from
     * what is on disk and no sequence of undos can prove otherwise.
     */
    const history = createHistory();
    history.savedDepth = -1;
    return { doc, history };
  } catch {
    return null;
  }
}

/** Throws one away for good, file and row together. */
export async function deleteSnapshot(filePath: string, id: string): Promise<Snapshot[]> {
  const { kept, dropped } = removeSnapshot(await readIndex(filePath), id);
  await writeIndex(filePath, kept);
  await removeFiles(filePath, dropped);
  return kept;
}
