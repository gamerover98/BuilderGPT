/**
 * When the anchor modal's fields may be overwritten from the document.
 *
 * A panel that edits a value main owns has to mirror it in, and the naive way
 * to do that — an effect that assigns the fields whenever the prop arrives —
 * fights the user. `anchor` reaches the modal from a `$derived` that builds a
 * fresh array every time `docState` is reassigned, which is after every edit
 * anywhere in the app. Identity changes constantly; the value does not. Mirror
 * on identity and half-typed coordinates are wiped back to what is stored, so
 * pressing Move sends the value that was already there and the anchor sits
 * still while the button looks broken.
 *
 * So the rule is keyed on the **value**, and it lives here rather than inside
 * the component for the reason the rest of `selection_drag.ts` and
 * `floating.ts` do: an `$effect` is a rendering step, the Browser pane here is
 * often not compositing, and a rule that cannot be observed is a rule that
 * cannot be defended. `tests/ui.ts` drives this directly.
 */

/** What a set of fields was mirrored from; `""` is "no anchor". */
export function anchorKey(anchor: readonly [number, number, number] | null): string {
  return anchor === null ? "" : anchor.join(",");
}

/**
 * The fields to show, or `null` to leave whatever is in them alone.
 *
 * `null` is the common answer: it means the document's anchor has not actually
 * changed since these fields were last filled, whatever the prop's identity did.
 */
export function mirrorAnchor(
  anchor: readonly [number, number, number] | null,
  mirrored: string | null,
): [string, string, string] | null {
  const key = anchorKey(anchor);
  if (key === mirrored) {
    return null;
  }
  return anchor === null
    ? ["", "", ""]
    : [String(anchor[0]), String(anchor[1]), String(anchor[2])];
}
