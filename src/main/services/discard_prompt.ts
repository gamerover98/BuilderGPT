/**
 * The wording of "you have unsaved work" — and nothing else.
 *
 * Its own module, Electron-free, for the reason `recent_documents.ts` and
 * `settings_coerce.ts` are: the module that would otherwise hold it imports
 * Electron and the suites cannot load it at all.
 *
 * It is also asked from two places that have nothing else in common — the
 * `confirmDiscard` channel, and `mainWindow.on("close")`, where there is no
 * renderer left to ask with — and two dialogs phrasing the same question
 * differently is how a user learns to stop reading them.
 */

import type { DiscardIntent } from "../../shared/ipc.js";

export interface DiscardPrompt {
  /** The headline. Names the file, because "a document" is not reassuring. */
  message: string;
  /** What is actually at stake, in one sentence. */
  detail: string;
  /** The button that loses the work. Never "OK" — see below. */
  confirmLabel: string;
  cancelLabel: string;
}

/**
 * A destructive button says what it destroys.
 *
 * "OK" and "Cancel" on a question phrased as "Discard changes?" are ambiguous
 * in exactly the wrong direction: the answer is a guess, and the guess loses
 * work half the time. So each intent names its own verb.
 */
const CONFIRM_LABEL: Record<DiscardIntent, string> = {
  new: "Discard and create",
  open: "Discard and open",
  close: "Discard and close",
};

const INTENT_DETAIL: Record<DiscardIntent, string> = {
  new: "Creating a new schematic will replace it.",
  open: "Opening another schematic will replace it.",
  close: "Closing it will throw them away.",
};

export function discardPrompt(intent: DiscardIntent, fileName: string | null): DiscardPrompt {
  /*
   * A document that was never saved has no name to offer, and "Untitled" is
   * the name every editor gives it. Saying "this schematic" instead would be
   * vaguer for no gain.
   */
  const name = fileName ?? "Untitled";
  return {
    message: `${name} has unsaved changes.`,
    detail: `${INTENT_DETAIL[intent]} This cannot be undone.`,
    confirmLabel: CONFIRM_LABEL[intent],
    cancelLabel: "Cancel",
  };
}
