/**
 * Going back to how the schematic was before a question.
 *
 * A snapshot is taken *before* each agent turn, and the chat offers to return
 * to it from the user message that started that turn. On disk, so it outlives
 * the session — walking the undo stack would have been cheaper and would have
 * stopped working the moment the file was closed, which is precisely when
 * someone wants it.
 *
 * ## The three things that are easy to get wrong here
 *
 * **A checkpoint must not be cropped.** `saveSession` trims a schematic to its
 * content on the way out, which is right for the user's file and wrong for
 * this: coming back would hand them the build without the room they had made
 * to build in. So this calls the writers directly, exactly as `autosave.ts`
 * does and for the same reason.
 *
 * **`doc.revision` is the key.** It is monotonic and bumped by every mutation,
 * so an unchanged revision means an unchanged document and the previous
 * snapshot still describes it. That is what makes the failed-turn case free: a
 * run that rolls back leaves the revision where it started, and the next turn
 * reuses the same file rather than writing an identical one.
 *
 * **Restoring cannot be undone.** `adoptDocument` starts a fresh history, so
 * there is no stack to walk back across. The way back is that restoring takes
 * a checkpoint of the current state first — a fork, not a one-way door.
 *
 * ## What is stored
 *
 * A Sponge v3 `.schem` and a `.json` beside it holding the model's messages as
 * they stood. The messages matter: without them, going back would leave a
 * conversation the agent has no memory of, and every turn above the fork would
 * read as history. Sponge v3 whatever the document's own format, like the
 * autosave, because this file is only ever read back by this module and should
 * be the container that loses the least.
 */

import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

import { documentFromLoaded, type SchematicDocument } from "../domain/document.js";
import { createHistory } from "../domain/history.js";
import { loadStructure } from "../pipeline/loader.js";
import { saveDocument } from "./writers.js";
import type { DocumentSession } from "./session.js";

/** A restored document, ready for `adoptDocument`. */
export interface RestoredCheckpoint {
  session: DocumentSession;
  /** The model's memory as it stood, to put back with the conversation. */
  messages: unknown[];
}

let directory: string | null = null;

/**
 * Reuse memo for the current document.
 *
 * Held by session identity as well as revision: two different documents can
 * both be sitting at revision 5, and a memo keyed on the number alone would
 * hand the second one the first one's snapshot.
 */
let memo: { session: DocumentSession; revision: number; id: string } | null = null;

/** Where checkpoints are kept. Called once, at startup. */
export function useCheckpointDirectory(dir: string): void {
  directory = dir;
}

function schemFile(id: string): string | null {
  return directory === null ? null : path.join(directory, `${id}.schem`);
}

function metaFile(id: string): string | null {
  return directory === null ? null : path.join(directory, `${id}.json`);
}

/**
 * Snapshots the document as it stands, or returns the id of one that already
 * describes it.
 *
 * `null` when there is nowhere to write, which is the state before startup has
 * injected a directory. Callers treat that as "no checkpoint for this turn"
 * rather than as a failure: the turn is what the user asked for, and it should
 * not be refused because a convenience could not be recorded.
 */
export async function takeCheckpoint(
  session: DocumentSession,
  messages: unknown[],
): Promise<string | null> {
  if (directory === null) return null;

  if (memo !== null && memo.session === session && memo.revision === session.doc.revision) {
    return memo.id;
  }

  const id = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const schem = schemFile(id);
  const meta = metaFile(id);
  if (schem === null || meta === null) return null;

  try {
    await mkdir(directory, { recursive: true });
    // Sponge v3 and *not* cropped -- see the note at the top of this file.
    await saveDocument(session.doc, schem, { format: "sponge3" });
    await writeFile(meta, JSON.stringify({ messages }), "utf8");
  } catch {
    // A checkpoint that could not be written is a button that will be shown as
    // unavailable. Failing the turn over it would be a poor trade.
    return null;
  }

  memo = { session, revision: session.doc.revision, id };
  return id;
}

/**
 * Reads a checkpoint back as a document, or `null` if it has gone.
 *
 * The history is fresh and its saved point unreachable, the same arrangement
 * `restoreAutosave` uses: the document differs from what is on disk and no
 * sequence of undos can prove otherwise.
 */
export async function readCheckpoint(
  id: string,
  filePath: string | null,
): Promise<RestoredCheckpoint | null> {
  const schem = schemFile(id);
  const meta = metaFile(id);
  if (schem === null || meta === null) return null;

  let doc: SchematicDocument;
  try {
    doc = documentFromLoaded(await loadStructure(schem), filePath);
  } catch {
    return null;
  }

  let messages: unknown[] = [];
  try {
    const parsed = JSON.parse(await readFile(meta, "utf8")) as { messages?: unknown };
    if (Array.isArray(parsed.messages)) messages = parsed.messages;
  } catch {
    // The schematic is the part that matters. Without the messages the
    // conversation comes back as history, which the memory divider already
    // renders honestly.
  }

  const history = createHistory();
  history.savedDepth = -1;
  return { session: { doc, history, mesh: null }, messages };
}

/** Whether a checkpoint is still on disk, so the UI can offer it or not. */
export async function checkpointExists(id: string): Promise<boolean> {
  const schem = schemFile(id);
  if (schem === null) return false;
  try {
    await readFile(schem);
    return true;
  } catch {
    return false;
  }
}

/** Deletes checkpoints by id, ignoring ones that are already gone. */
export async function removeCheckpoints(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    for (const file of [schemFile(id), metaFile(id)]) {
      if (file === null) continue;
      try {
        await rm(file, { force: true });
      } catch {
        // Swept next time, or never; neither is worth reporting.
      }
    }
  }
}

/** Forgets the reuse memo. Called when the open document changes. */
export function forgetCheckpointMemo(): void {
  memo = null;
}
