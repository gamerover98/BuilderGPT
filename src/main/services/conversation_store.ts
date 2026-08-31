/**
 * The on-disk shape of a schematic's conversations, and the arithmetic on it.
 *
 * Split from `conversation.ts` for the reason `recent_documents.ts` states
 * about `settings-store.ts`: the other half touches the filesystem and is given
 * a directory by the app, which puts it out of reach of a test that just wants
 * to know whether a hand-edited file is read safely. What is worth testing is
 * here, and none of it opens anything.
 *
 * ## One file per schematic
 *
 * Not one index for all of them. An index would be rewritten in full after
 * every single turn, and a half-written index loses every conversation rather
 * than one.
 *
 * ## The stored model messages are somebody else's type
 *
 * `messages` is `ModelMessage[]` from the `ai` package — third-party shape,
 * written to disk, and therefore able to change under us on an upgrade. So the
 * record carries a `version`, and a mismatch drops **only** the messages while
 * keeping the entries. The user's own words are the part that cannot be
 * regenerated, and a log shown without a memory behind it is exactly what the
 * memory divider was built to make legible: everything reads as history.
 */

import type { ChatEntry, TraceItem } from "../../shared/ipc.js";
import { SCHEMATIC_FORMATS, type SchematicFormat } from "../../shared/schematic.js";
import { normaliseVoidBlock } from "../../shared/settings.js";

/** Bumped when the stored shape changes in a way older readers cannot take. */
export const CONVERSATION_FORMAT = 1;

/** How many conversations one schematic keeps before the oldest are dropped. */
export const MAX_CONVERSATIONS_PER_DOCUMENT = 10;

/** Characters a title may run to before it is cut. */
const TITLE_LIMIT = 60;

export interface StoredConversation {
  id: string;
  /** Drawn from the first thing the user said. */
  title: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  entries: ChatEntry[];
  /**
   * The model's half, as `ai` shapes it. Deliberately `unknown[]` here: this
   * module refuses to depend on a third-party type it only ever passes through,
   * and pretending to validate its interior would be a lie either way.
   */
  messages: unknown[];
  rememberedFrom: number;
}

/**
 * What this schematic is *for*, remembered alongside the talking about it.
 *
 * There is no project file and there is deliberately not going to be one. The
 * `.schem` stays the only thing the user sees and moves, and this rides in the
 * sidecar that already exists per path — so a schematic sent to somebody else
 * opens with sensible defaults rather than with none, and nothing has to be
 * kept in step with anything.
 *
 * Every field is optional and a missing sidecar is not an error. That is the
 * property that makes this better than a `.saproj`: lose it and the file still
 * opens, you just answer the New/Save As dialog yourself.
 */
export interface ProjectNotes {
  /** The Minecraft version last chosen for this file, by name. */
  version?: string;
  /** The container last written, so Save As opens on it. */
  format?: SchematicFormat;
  /** What the user says this build is. Not shown yet; recorded for the panel. */
  description?: string;
  /**
   * What empty space is made of in this schematic. `""` is air.
   *
   * Here rather than in `Settings` because it is written *into this file*:
   * breaking a block writes it, so an underwater jetty and a cathedral want
   * different answers and a global one followed you silently between them.
   *
   * Absent means air, which is what every schematic written before this was
   * full of -- so an old sidecar needs no migration and reads correctly.
   */
  voidBlock?: string;
}

export interface ConversationRecord {
  version: number;
  /** The schematic these are about, as it was when they were written. */
  filePath: string;
  conversations: StoredConversation[];
  /**
   * The per-file settings, when any have been recorded.
   *
   * Beside the conversations rather than in them: it belongs to the *file*, and
   * a copy per conversation would give one schematic several answers to "which
   * Minecraft is this for".
   */
  project?: ProjectNotes;
}

/** Reads project notes defensively; anything unrecognised simply is not there. */
export function coerceProject(raw: unknown): ProjectNotes | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const source = raw as Partial<ProjectNotes>;
  const notes: ProjectNotes = {};
  if (typeof source.version === "string" && source.version !== "") notes.version = source.version;
  /*
   * Checked against the format list rather than against three names written
   * out here, which is how this came to drop `litematic` in silence: the
   * fourth container was added to `SchematicFormat` and this line was not,
   * so a `.litematic` remembered its container and then opened Save As on
   * Sponge, with nothing failing anywhere.
   */
  if (SCHEMATIC_FORMATS.includes(source.format as SchematicFormat)) {
    notes.format = source.format as SchematicFormat;
  }
  if (typeof source.description === "string" && source.description !== "") {
    notes.description = source.description;
  }
  // Normalised on the way in, not only on the way out: every spelling of air
  // has to reach `fillVoid` as the empty string. A sidecar written by hand
  // or by an older build is exactly where the other spelling comes from.
  if (typeof source.voidBlock === "string") {
    const block = normaliseVoidBlock(source.voidBlock);
    if (block !== "") notes.voidBlock = block;
  }
  return Object.keys(notes).length === 0 ? undefined : notes;
}

/**
 * A conversation's name, taken from the first thing the user said.
 *
 * Falls back rather than showing an empty row: a conversation with no user turn
 * yet is one that was just started, and "New chat" is what it is.
 */
export function titleFor(entries: readonly ChatEntry[]): string {
  const first = entries.find((entry) => entry.role === "user");
  const text = (first?.text ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return "New chat";
  return text.length <= TITLE_LIMIT ? text : `${text.slice(0, TITLE_LIMIT - 1)}…`;
}

/**
 * The stable file name for a schematic's conversations.
 *
 * A hash rather than the path itself: paths contain separators, colons and
 * characters no filesystem agrees on, and the file only ever has to be found
 * again, never read by a human. Case-folded because Windows and macOS reach the
 * same file through paths that differ only in case, and two records for one
 * schematic would each hold half a history.
 *
 * FNV-1a: not a security hash and not used as one. A collision would merge two
 * schematics' conversations, which is why the record also stores `filePath` and
 * the reader checks it.
 */
export function storeFileName(filePath: string): string {
  const normalised = filePath.replace(/\\/g, "/").toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < normalised.length; i += 1) {
    hash ^= normalised.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16).padStart(8, "0")}.json`;
}

/** Whether a value is a plausible chat entry. Shape only; text is text. */
function isEntry(value: unknown): value is ChatEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<ChatEntry>;
  return (
    (entry.role === "user" ||
      entry.role === "agent" ||
      entry.role === "error" ||
      entry.role === "note") &&
    typeof entry.text === "string"
  );
}

/**
 * How much of one trace item's text is worth keeping on disk.
 *
 * A generation's request carries the whole block-id list: 933 ids, 24 kB, and
 * the same 24 kB every single time, because it is a constant of the app rather
 * than anything about that turn. Ten conversations per schematic across a
 * hundred schematics would be hundreds of megabytes of the same file.
 *
 * So it is shown in full while the turn is live — that is the copy that answers
 * "what did you actually send" — and stored abridged, saying so. Nothing is
 * really lost: the omitted part is `block_id_list.txt`, which ships with the
 * app and is generated by `scripts/gen-block-list.mjs`.
 */
export const MAX_STORED_TRACE_TEXT = 4_000;

/**
 * The trace as it should be written down.
 *
 * Exported and pure so the cap is a thing that can be tested rather than a
 * number buried in a writer. It runs on the way *out* only: what the panel drew
 * while the turn was running is not touched.
 */
export function abridgeTrace(trace: readonly TraceItem[]): TraceItem[] {
  return trace.map((item) => {
    if (item.text.length <= MAX_STORED_TRACE_TEXT) return { ...item };
    const dropped = item.text.length - MAX_STORED_TRACE_TEXT;
    return {
      ...item,
      text: item.text.slice(0, MAX_STORED_TRACE_TEXT),
      elided: `${dropped.toLocaleString()} more characters, kept only while the turn was live`,
    };
  });
}

/**
 * Reads a record written by this app, a future build of it, or a text editor.
 *
 * Returns `null` when there is nothing usable, and otherwise the most it can
 * salvage. The one asymmetry worth knowing: a `version` it does not recognise
 * keeps the entries and drops the messages, with `rememberedFrom` set past the
 * end so the whole log reads as history. Refusing the file outright would throw
 * away the user's own words to protect a field they never see.
 */
export function coerceRecord(raw: unknown, filePath: string): ConversationRecord | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Partial<ConversationRecord>;
  if (!Array.isArray(record.conversations)) return null;

  // A hash collision, or a record copied between machines. Either way these are
  // not this schematic's conversations, and showing them would be worse than
  // showing none.
  if (typeof record.filePath === "string" && record.filePath !== "" ) {
    const same =
      record.filePath.replace(/\\/g, "/").toLowerCase() ===
      filePath.replace(/\\/g, "/").toLowerCase();
    if (!same) return null;
  }

  const usable = record.version === CONVERSATION_FORMAT;

  const conversations: StoredConversation[] = [];
  for (const value of record.conversations) {
    if (value === null || typeof value !== "object") continue;
    const stored = value as Partial<StoredConversation>;
    const entries = Array.isArray(stored.entries) ? stored.entries.filter(isEntry) : [];
    if (entries.length === 0) continue;

    const messages = usable && Array.isArray(stored.messages) ? stored.messages : [];
    const rememberedFrom = usable ? Number(stored.rememberedFrom) : entries.length;

    conversations.push({
      id: typeof stored.id === "string" && stored.id !== "" ? stored.id : `c${conversations.length}`,
      title: typeof stored.title === "string" && stored.title !== "" ? stored.title : titleFor(entries),
      createdAt: finiteOr(stored.createdAt, 0),
      updatedAt: finiteOr(stored.updatedAt, 0),
      entries,
      messages,
      rememberedFrom:
        Number.isFinite(rememberedFrom) && rememberedFrom >= 0
          ? Math.min(Math.round(rememberedFrom), entries.length)
          : entries.length,
    });
  }

  const project = coerceProject((record as { project?: unknown }).project);
  // A record with notes but no conversations is still worth keeping: someone
  // may have set a version and never opened the chat.
  if (conversations.length === 0 && project === undefined) return null;
  return { version: CONVERSATION_FORMAT, filePath, conversations, ...(project ? { project } : {}) };
}

function finiteOr(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

/** Newest first, and no more than the cap. */
export function pruneConversations(
  conversations: readonly StoredConversation[],
  max = MAX_CONVERSATIONS_PER_DOCUMENT,
): StoredConversation[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, max);
}

/** The one to show when a document is opened: whichever was touched last. */
export function mostRecent(
  conversations: readonly StoredConversation[],
): StoredConversation | null {
  return pruneConversations(conversations)[0] ?? null;
}
