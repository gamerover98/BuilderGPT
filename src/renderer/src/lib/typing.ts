/**
 * Is this event coming out of somewhere the user is entering text?
 *
 * Single-key shortcuts in this app listen on `window`, which sees every
 * keypress including the ones meant for a text field. Without this guard the
 * viewport's shortcuts fire while someone types in the sidebar — the `r` in
 * "birch" threw the camera back to its framing position mid-word, which is the
 * bug that first made this necessary.
 *
 * Extracted from `Viewer.svelte` once the hotbar needed the same answer. Two
 * copies of a rule about which elements swallow keys is two rules, and only one
 * of them would get the next fix.
 *
 * Duck-typed rather than `instanceof HTMLElement`: the target of a keyboard
 * event is whatever had focus, which can be a `Document` or a `Window`, and
 * neither has a `tagName` to read.
 */
export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") {
    return false;
  }
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable;
}
