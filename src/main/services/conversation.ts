/**
 * The conversation, as main holds it.
 *
 * The visible log used to live in the renderer (`chat = $state<ChatEntry[]>`)
 * while the model's half lived on the session. Two owners of one thing, which
 * was survivable only because they were thrown away together. They are not
 * thrown away together any more, so the log moves here, where main can append
 * to it from every path that produces a turn.
 *
 * ## Why this is not on `DocumentSession`
 *
 * That is where the model's half lives, and the comment there explains the
 * appeal: a conversation is *about* a schematic, so hanging it off the session
 * makes it die with the document for free. The log cannot take that deal,
 * because of one flow it would break. Asking the chat to build something with
 * nothing open runs the generator and then *opens* what it made -- and if the
 * log died with the session swap, the question would vanish and only the answer
 * would remain. That is what happened before this module existed.
 *
 * So the rule is explicit instead of free: a conversation has a **subject**,
 * the document it is about. Opening a document it has no subject for is an
 * adoption, not a reset -- which is exactly the build-then-open case. Opening a
 * *different* document is a reset, which is the behaviour the session gave away
 * for nothing.
 */

import type { ChatEntry } from "../../shared/ipc.js";
import { pathsMatch } from "./recent_documents.js";
import { rememberedFromIndex } from "./conversation_core.js";

export interface ConversationState {
  entries: ChatEntry[];
  /** Index into `entries` where the agent's memory begins. */
  rememberedFrom: number;
}

interface Conversation extends ConversationState {
  /** The document this is about, or `null` while it is about nothing yet. */
  subject: string | null;
  /** Exchanges the agent last reported carrying. */
  turns: number;
}

/** Windows reaches the same file through paths differing only in case. */
const caseSensitive = process.platform !== "win32" && process.platform !== "darwin";

let current: Conversation = { subject: null, entries: [], rememberedFrom: 0, turns: 0 };

/** What the renderer mirrors. Copied, because it crosses a process boundary. */
export function conversationState(): ConversationState {
  return { entries: [...current.entries], rememberedFrom: current.rememberedFrom };
}

/** Adds a turn to the log and returns the log as it now stands. */
export function appendEntry(entry: ChatEntry): ConversationState {
  current.entries.push(entry);
  recompute();
  return conversationState();
}

/**
 * Records that the turn at the end of the log actually reached the model.
 *
 * Called only after `runAgent` returns, because that is when it becomes true:
 * a failed run rolls back and its user entry stays in the log while never
 * entering the model's memory. `turns` is what the agent reports carrying.
 */
export function noteTurnRemembered(turns: number): void {
  for (let index = current.entries.length - 1; index >= 0; index -= 1) {
    if (current.entries[index].role === "user") {
      current.entries[index] = { ...current.entries[index], remembered: true };
      break;
    }
  }
  current.turns = turns;
  recompute();
}

function recompute(): void {
  current.rememberedFrom = rememberedFromIndex(current.entries, current.turns);
}

/** Throws the log away. The model's half is cleared by its own owner. */
export function resetConversation(subject: string | null = current.subject): void {
  current = { subject, entries: [], rememberedFrom: 0, turns: 0 };
}

/**
 * Points the conversation at a document, resetting it if it was about another.
 *
 * The three cases, in the order they are decided:
 *
 * - **Nothing said yet** -- take the subject and carry on. Opening a file
 *   before typing anything should not count as a change of topic.
 * - **No subject yet** -- adopt. This is the chat that built something with
 *   nothing open: the conversation produced this document, so it is about it.
 * - **A different document** -- reset. "Make it taller" means nothing once
 *   another file is on screen.
 */
export function adoptSubject(filePath: string | null): void {
  if (current.entries.length === 0) {
    current.subject = filePath;
    return;
  }
  if (current.subject === null) {
    current.subject = filePath;
    return;
  }
  if (filePath === null || !pathsMatch(current.subject, filePath, caseSensitive)) {
    resetConversation(filePath);
  }
}
