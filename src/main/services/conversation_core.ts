/**
 * Where the agent's memory begins, as an index into the visible log.
 *
 * The agent carries a bounded number of past exchanges (`MAX_REMEMBERED_TURNS`
 * in `agent/agent.ts`), while the log on screen holds everything that has been
 * said. Those two have never agreed, and nothing said so: a long conversation
 * already shows the user exchanges the model cannot refer to, and the only
 * symptom is an agent that seems to have forgotten something plainly visible
 * three messages up.
 *
 * ## Why this cannot be counted in the renderer
 *
 * "The last N user messages" is the obvious rule and it is wrong. A turn that
 * *failed* leaves its user entry in the log and never enters the agent's
 * memory -- `agent.ts` updates the conversation only after everything that can
 * throw, deliberately, so that a rolled-back edit is not described to the next
 * turn as if it had happened. Counting user entries from the end therefore
 * drifts by one for every error in the log.
 *
 * So the boundary is computed here, from a flag main sets when a turn actually
 * lands, and travels to the renderer as an index. The renderer draws it; it
 * does not decide it.
 */

import type { ChatEntry } from "../../shared/ipc.js";

/**
 * The index of the oldest entry the agent still remembers.
 *
 * `turns` is how many exchanges the agent reports carrying. Walking back over
 * entries flagged `remembered`, the `turns`-th one from the end is where its
 * memory starts; everything above that is history the user can read and the
 * model cannot.
 *
 * Returns `0` when the whole log is remembered, which is also what a log
 * shorter than the window gives -- and `0` is what the renderer reads as "no
 * divider", so the common case draws nothing.
 */
export function rememberedFromIndex(entries: readonly ChatEntry[], turns: number): number {
  if (turns <= 0) {
    // Nothing is remembered: everything on screen is history. That happens
    // after "new chat" while the log is still on screen, and when a stored
    // conversation came back without the model's half of it.
    return entries.length;
  }

  let seen = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role !== "user" || entry.remembered !== true) continue;
    seen += 1;
    if (seen === turns) return index;
  }
  // Fewer landed turns than the agent claims to carry. Not a state worth
  // failing over -- it means the whole log is inside the window.
  return 0;
}
