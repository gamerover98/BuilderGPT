/**
 * The conversation: the visible log, the model's memory of it, and its file.
 *
 * ## Both halves, one object
 *
 * The log used to live in the renderer and the model's messages on the session.
 * Two owners of one thing, which only worked because they were always thrown
 * away together. They are written to disk now, and a crash between two writes
 * would leave a log describing edits the agent has no record of — so they are
 * one record, saved in one call.
 *
 * ## Why not on `DocumentSession`
 *
 * Hanging it there made it die with the document for free, which was most of
 * the appeal. It cannot take that deal any more, for two reasons that pull the
 * same way. It has to *survive* a document swap in one case — asking the chat
 * to build something with nothing open generates a file and then opens it, and
 * the question must not vanish with the session. And it has to survive the
 * document being closed entirely, because reopening that schematic brings the
 * conversation back.
 *
 * So the rule is written out instead of inherited: a conversation has a
 * **subject**, the document it is about. Opening a file it has no subject for
 * is an adoption; opening a different one saves what is there and loads that
 * file's own.
 *
 * ## The directory is injected
 *
 * `app.getPath("userData")` lives in Electron, and importing Electron here
 * would put this module out of reach of the test suites — the same trap
 * `recent_documents.ts` was split out of `settings-store.ts` to avoid. The app
 * calls `useConversationDirectory` at startup; the tests point it at a temp
 * folder and exercise the real files.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import path from "path";

import type { ChatEntry, ChatState } from "../../shared/ipc.js";
import { pathsMatch } from "./recent_documents.js";
import { rememberedFromIndex } from "./conversation_core.js";
import {
  CONVERSATION_FORMAT,
  coerceRecord,
  mostRecent,
  pruneConversations,
  storeFileName,
  titleFor,
  type ConversationRecord,
  type StoredConversation,
} from "./conversation_store.js";

/** How many schematics keep a conversation file before the oldest are swept. */
export const MAX_CONVERSATION_FILES = 100;

interface Live {
  id: string;
  /** The document this is about, or `null` while it is about nothing yet. */
  subject: string | null;
  createdAt: number;
  entries: ChatEntry[];
  messages: unknown[];
  rememberedFrom: number;
  /** Exchanges the agent last reported carrying. */
  turns: number;
}

/** Windows and macOS reach the same file through paths differing in case. */
const caseSensitive = process.platform !== "win32" && process.platform !== "darwin";

let directory: string | null = null;
let current: Live = fresh(null);

function fresh(subject: string | null): Live {
  return {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    subject,
    createdAt: Date.now(),
    entries: [],
    messages: [],
    rememberedFrom: 0,
    turns: 0,
  };
}

/** Where conversations are kept. Called once, at startup. */
export function useConversationDirectory(dir: string): void {
  directory = dir;
}

/** What the renderer mirrors. Copied, because it crosses a process boundary. */
export function conversationState(): ChatState {
  return { entries: [...current.entries], rememberedFrom: current.rememberedFrom };
}

/** The model's half, for `runAgent` to replay. */
export function conversationMessages(): unknown[] {
  return current.messages;
}

/** Adds a turn to the log and returns the log as it now stands. */
export function appendEntry(entry: ChatEntry): ChatState {
  current.entries.push(entry);
  recompute();
  return conversationState();
}

/**
 * Stores what a completed turn produced.
 *
 * Called only after `runAgent` returns, because that is when it becomes true: a
 * failed run rolls back, and its user entry stays in the log while never
 * entering the model's memory. That gap is what `rememberedFromIndex` reads.
 */
export function noteTurn(messages: unknown[], turns: number): void {
  for (let index = current.entries.length - 1; index >= 0; index -= 1) {
    if (current.entries[index].role === "user") {
      current.entries[index] = { ...current.entries[index], remembered: true };
      break;
    }
  }
  current.messages = messages;
  current.turns = turns;
  recompute();
}

function recompute(): void {
  current.rememberedFrom = rememberedFromIndex(current.entries, current.turns);
}

/** Throws the conversation away, keeping whatever it was about. */
export function resetConversation(subject: string | null = current.subject): void {
  current = fresh(subject);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function fileFor(subject: string): string | null {
  return directory === null ? null : path.join(directory, storeFileName(subject));
}

async function readRecord(subject: string): Promise<ConversationRecord | null> {
  const file = fileFor(subject);
  if (file === null) return null;
  try {
    return coerceRecord(JSON.parse(await readFile(file, "utf8")), subject);
  } catch {
    // Missing, unreadable, or not JSON. A conversation that cannot be found is
    // a conversation that has not happened yet, which is a normal state.
    return null;
  }
}

/** The live conversation as it would be stored. */
function snapshot(): StoredConversation {
  return {
    id: current.id,
    title: titleFor(current.entries),
    createdAt: current.createdAt,
    updatedAt: Date.now(),
    entries: [...current.entries],
    messages: current.messages,
    rememberedFrom: current.rememberedFrom,
  };
}

/**
 * Writes the conversation next to its schematic's other conversations.
 *
 * Silent about a subject it has none for: a document that has never been saved
 * has no path to key on, and that is not a failure — it is the state every new
 * schematic starts in. `adoptSubject` picks it up on the first save.
 */
export async function saveConversation(): Promise<void> {
  if (current.subject === null || current.entries.length === 0) return;
  const file = fileFor(current.subject);
  if (file === null) return;

  const existing = await readRecord(current.subject);
  const others = (existing?.conversations ?? []).filter((one) => one.id !== current.id);
  const record: ConversationRecord = {
    version: CONVERSATION_FORMAT,
    filePath: current.subject,
    conversations: pruneConversations([snapshot(), ...others]),
  };

  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(record), "utf8");
  } catch {
    // Losing a conversation is not worth failing the operation that triggered
    // the save -- which is a save of the user's actual schematic, or closing
    // the app. The next turn tries again.
  }
  await sweep();
}

/** Loads whichever of a schematic's conversations was touched last. */
async function loadFor(subject: string): Promise<void> {
  const record = await readRecord(subject);
  const stored = record === null ? null : mostRecent(record.conversations);
  if (stored === null) {
    current = fresh(subject);
    return;
  }
  current = {
    id: stored.id,
    subject,
    createdAt: stored.createdAt,
    entries: [...stored.entries],
    messages: stored.messages,
    rememberedFrom: stored.rememberedFrom,
    // Recomputed from the flags rather than stored: `rememberedFrom` came back
    // with the record, and the count that produced it did not.
    turns: stored.entries.filter((entry) => entry.role === "user" && entry.remembered).length,
  };
}

/**
 * Points the conversation at a document, saving and swapping if it moves.
 *
 * The cases, in the order they are decided:
 *
 * - **Nothing said yet** — take the subject and load that file's history.
 *   Opening a file before typing anything is not a change of topic.
 * - **No subject yet** — adopt, and keep what has been said. This is the chat
 *   that built something with nothing open: the conversation produced this
 *   document, so it is about it.
 * - **The same document** — nothing to do.
 * - **A different one** — save this one where it belongs, then load that one's.
 */
export async function adoptSubject(filePath: string | null): Promise<void> {
  if (current.entries.length === 0) {
    if (filePath === null) {
      current = fresh(null);
      return;
    }
    await loadFor(filePath);
    return;
  }

  if (current.subject === null) {
    current.subject = filePath;
    await saveConversation();
    return;
  }

  if (filePath !== null && pathsMatch(current.subject, filePath, caseSensitive)) return;

  await saveConversation();
  if (filePath === null) {
    current = fresh(null);
    return;
  }
  await loadFor(filePath);
}

/**
 * Drops the least recently touched files past the cap.
 *
 * By modification time, read from the records themselves rather than from the
 * filesystem: a backup tool or a sync client rewrites mtimes, and losing
 * someone's conversation to a file copy would be a poor way to find that out.
 */
async function sweep(): Promise<void> {
  if (directory === null) return;
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  if (names.length <= MAX_CONVERSATION_FILES) return;

  const dated: { name: string; updatedAt: number }[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(await readFile(path.join(directory, name), "utf8")) as {
        conversations?: { updatedAt?: number }[];
      };
      const newest = (parsed.conversations ?? []).reduce(
        (best, one) => Math.max(best, Number(one.updatedAt) || 0),
        0,
      );
      dated.push({ name, updatedAt: newest });
    } catch {
      // Unreadable: sweep it, since nothing can restore it anyway.
      dated.push({ name, updatedAt: 0 });
    }
  }

  dated.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const stale of dated.slice(MAX_CONVERSATION_FILES)) {
    try {
      await rm(path.join(directory, stale.name), { force: true });
    } catch {
      // Nothing to do about a file that will not go; it is swept next time.
    }
  }
}
