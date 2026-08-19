/**
 * What a turn is doing, recorded as it does it.
 *
 * The chat used to narrate a run as a list of one-line summaries — "filling
 * (0,0,0)-(9,3,9) with minecraft:stone" — which says what happened and nothing
 * about *why*, and for the generation path said only "Sending the build spec to
 * the model" followed by a wait. This records the whole shape of a turn: the
 * request that was sent, the model thinking out loud where it does that, the
 * prose it wrote, and every tool call with its arguments and its result.
 *
 * ## Main owns the order, the renderer mirrors it
 *
 * Ids are assigned here because this is the only place that knows what happened
 * first. The renderer folds the events into a mirror to draw while the turn is
 * running, and then adopts main's finished array off the chat entry — the same
 * arrangement the chat log itself uses, and for the same reason: two owners of
 * one ordering is how they end up disagreeing.
 *
 * ## Deltas are batched, and not by a timer
 *
 * Reasoning arrives a few characters at a time and an IPC message per token
 * would be most of the cost of the feature. Appends accumulate and flush once
 * they pass `FLUSH_AFTER_CHARS`, or when something else happens — a new item, a
 * finished one, the end of the turn. A character budget rather than a timer
 * because it is deterministic: the tests drive this by calling it, with no
 * clock to wait for and nothing left scheduled if a run throws.
 */

import type { TraceEvent, TraceItem } from "../../shared/ipc.js";

/** How much text may accumulate on an item before it is worth an IPC message. */
const FLUSH_AFTER_CHARS = 200;

/**
 * Caps on what one item may carry, so a runaway tool result cannot fill the
 * window or the conversation file.
 *
 * Generous rather than tight: `tools.ts` already caps a region read at 2048
 * blocks, so these bound the pathological case rather than the ordinary one.
 * Truncation is always said out loud in `elided` — a result silently cut in
 * half reads as a tool that returned half a result.
 */
const MAX_ITEM_CHARS = 200_000;
const MAX_FIELD_CHARS = 20_000;

export type TraceSink = (event: TraceEvent) => void;

/** Cuts a string to a budget, saying so rather than trailing off. */
export function capText(text: string, limit: number): { text: string; elided?: string } {
  if (text.length <= limit) return { text };
  return {
    text: text.slice(0, limit),
    elided: `${(text.length - limit).toLocaleString()} more characters, not shown`,
  };
}

/** Formats a tool's arguments or result, falling back to text it cannot parse. */
export function formatJson(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // A circular structure, or a BigInt. Neither should reach here, and neither
    // is worth failing a turn over.
    return String(value);
  }
}

export class TraceRecorder {
  private readonly items: TraceItem[] = [];
  private readonly byId = new Map<number, TraceItem>();
  /** Text appended but not yet sent, by item id. */
  private readonly pending = new Map<number, string>();
  private readonly startedAt = new Map<number, number>();
  private nextId = 1;
  private pendingChars = 0;

  constructor(
    private readonly requestId: string,
    private readonly sink: TraceSink | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Opens an item and returns its id.
   *
   * Anything already accumulated is flushed first: an item announced before the
   * text of the one above it would arrive out of order, and the renderer folds
   * events in the order they land.
   */
  start(item: Omit<TraceItem, "id">): number {
    this.flush();
    const id = this.nextId;
    this.nextId += 1;
    const created: TraceItem = { ...item, id };
    this.items.push(created);
    this.byId.set(id, created);
    this.startedAt.set(id, this.now());
    this.sink?.({ requestId: this.requestId, type: "item", item: { ...created } });
    return id;
  }

  /** Extends an item's text. Batched; see the note at the top. */
  append(id: number, text: string): void {
    if (text === "" || !this.byId.has(id)) return;
    const item = this.byId.get(id)!;
    // Dropped rather than grown without bound. The cap is on the stored item,
    // so `elided` is set here and survives onto the finished form.
    if (item.text.length >= MAX_ITEM_CHARS) {
      item.elided = "output too long to record in full";
      return;
    }
    item.text += text;
    this.pending.set(id, (this.pending.get(id) ?? "") + text);
    this.pendingChars += text.length;
    if (this.pendingChars >= FLUSH_AFTER_CHARS) this.flush();
  }

  /**
   * Closes an item, optionally replacing fields, and sends its finished form.
   *
   * The whole item goes rather than a patch: this is once per tool call, and a
   * patch protocol would need the renderer to know which fields may change.
   */
  finish(id: number, patch: Partial<Omit<TraceItem, "id">> = {}): void {
    this.flush();
    const item = this.byId.get(id);
    if (!item) return;
    Object.assign(item, patch);
    for (const field of ["input", "output", "error"] as const) {
      const value = item[field];
      if (typeof value === "string" && value.length > MAX_FIELD_CHARS) {
        const capped = capText(value, MAX_FIELD_CHARS);
        item[field] = capped.text;
        item.elided = capped.elided;
      }
    }
    item.running = false;
    const started = this.startedAt.get(id);
    if (started !== undefined) item.ms = Math.max(0, this.now() - started);
    this.sink?.({ requestId: this.requestId, type: "item", item: { ...item } });
  }

  /** Sends whatever has accumulated. Safe to call when nothing has. */
  flush(): void {
    if (this.pending.size === 0) return;
    const batched = [...this.pending.entries()];
    this.pending.clear();
    this.pendingChars = 0;
    for (const [id, text] of batched) {
      this.sink?.({ requestId: this.requestId, type: "append", id, text });
    }
  }

  /**
   * The trace as it stands, flushed.
   *
   * A copy of each item, because this is handed to the chat entry and then to
   * the renderer, and the recorder may still be appending to its own.
   */
  snapshot(): TraceItem[] {
    this.flush();
    return this.items.map((item) => ({ ...item }));
  }
}

/*
 * The other half of this protocol — folding the events back into an array — is
 * `renderer/src/lib/trace.ts`, and it is over there rather than here because
 * the renderer must not import out of `main/`. The two have to agree about what
 * an `append` means, and what makes them agree is not proximity but
 * `tests/agent.ts`, which drives a real run through this recorder and then
 * folds the emitted events with the renderer's own function, requiring the
 * result to match this one's `snapshot()`.
 */
