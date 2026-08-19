/**
 * Folding a turn's running commentary into something drawable.
 *
 * Main owns the order and assigns the ids — see `main/services/trace.ts` — and
 * hands back the finished array on the chat entry. This is what the panel draws
 * until it does.
 *
 * It lives here and not beside the emitter because the renderer may not import
 * out of `main/`. What keeps the two halves honest is `tests/agent.ts`: it
 * drives a real agent run, collects the events main emitted, folds them with
 * *this* function, and requires the result to equal main's own record. A fold
 * that drifted from the emitter would fail there rather than in front of a
 * user, which is the only reason it is safe for them to be apart.
 *
 * Plain `.ts` and no runes: this is a pure reduction over data, which is what
 * makes it testable at all.
 */

import type { TraceEvent, TraceItem } from "../../../shared/ipc.js";

export function applyTraceEvent(items: readonly TraceItem[], event: TraceEvent): TraceItem[] {
  if (event.type === "item") {
    const at = items.findIndex((item) => item.id === event.item.id);
    // Announced, or replaced by its finished form once it is over.
    if (at === -1) return [...items, event.item];
    const next = [...items];
    next[at] = event.item;
    return next;
  }
  const at = items.findIndex((item) => item.id === event.id);
  /*
   * An append for an item that never arrived is dropped rather than invented.
   * It can happen legitimately: a run that started before this window was
   * listening, or an event that outran the item it belongs to. The finished
   * trace replaces all of this anyway, so a gap is a flicker — whereas a
   * placeholder row would be a lie that outlives the turn.
   */
  if (at === -1) return [...items];
  const next = [...items];
  next[at] = { ...next[at], text: next[at].text + event.text };
  return next;
}
