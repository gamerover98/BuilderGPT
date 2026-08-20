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

/**
 * Whether the user has text highlighted somewhere on the page.
 *
 * `isTyping` is not enough for Ctrl+C. The chat log is not a text field, so
 * highlighting a block id in a reply and pressing Ctrl+C passes that guard —
 * and the shortcut would copy the *selected region of the schematic* instead,
 * silently, leaving the clipboard without the thing the user just highlighted.
 *
 * Collapsed ranges do not count: a caret sitting somewhere is not a selection,
 * and every click leaves one.
 */
export function hasTextSelection(): boolean {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString().trim() !== "";
}
