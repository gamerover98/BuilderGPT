/**
 * Keeping a floating panel reachable.
 *
 * Pure arithmetic, deliberately outside `ToolWindow.svelte`, because the two
 * ways it gets used are not equally easy to observe. The drag path can be
 * driven from a browser and watched; the *re-clamp on resize* path runs from a
 * `ResizeObserver`, whose callbacks are delivered as part of the rendering
 * steps -- so in a hidden or non-compositing page it never fires at all, and no
 * amount of driving the DOM will exercise it. Testing the decision here means
 * the part that decides is checked even when the part that triggers cannot be.
 */

import { PANEL_SIZE } from "../../../shared/settings.js";

export interface Bounds {
  /** The area the panel must stay reachable within. */
  paneWidth: number;
  paneHeight: number;
  /** The panel's own size. */
  panelWidth: number;
  panelHeight: number;
  /** How much of the panel must remain on screen at each edge. */
  margin: number;
}


/** The size to use, given what the pane can actually hold. */
export function clampPanelSize(
  size: { width: number; height: number },
  pane: { width: number; height: number },
): { width: number; height: number } {
  // `Math.max` against the minimum last, so a pane smaller than the minimum
  // gives a panel that overflows rather than one that has collapsed: an
  // unusable window you can see beats a usable one you cannot.
  return {
    width: Math.round(Math.max(PANEL_SIZE.minWidth, Math.min(size.width, pane.width))),
    height: Math.round(Math.max(PANEL_SIZE.minHeight, Math.min(size.height, pane.height))),
  };
}

export interface Point {
  x: number;
  y: number;
}

/**
 * The nearest position to `point` that keeps `margin` pixels of the panel
 * inside the pane.
 *
 * Asymmetric on purpose, and the asymmetry is the whole design:
 *
 * - Left: the panel may hang off, down to `margin` of its right edge showing.
 *   Its title bar is the drag handle and runs the full width, so any sliver is
 *   enough to grab.
 * - Top: never above zero. Sliding up hides the title bar first, which is the
 *   one part that must stay reachable -- a panel dragged up by its own height
 *   could not be dragged back.
 * - Right and bottom: at most `paneWidth/Height - margin`, so a corner always
 *   protrudes.
 *
 * `panelHeight` joined `panelWidth` when the panels became resizable, and only
 * the top rule uses it: a panel taller than the pane would otherwise be pinned
 * at `y = 0` with its bottom edge -- and its resize handle -- unreachable, so
 * it is allowed to hang off the top far enough to grab that corner. The title
 * bar stays reachable in every case a panel that fits can produce.
 */
export function clampToBounds(point: Point, bounds: Bounds): Point {
  const minX = bounds.margin - bounds.panelWidth;
  const maxX = Math.max(0, bounds.paneWidth - bounds.margin);
  // Only a panel too tall for the pane may go above zero, and only far enough
  // to bring its bottom edge back into reach.
  const minY = Math.min(0, bounds.paneHeight - bounds.panelHeight);
  const maxY = Math.max(0, bounds.paneHeight - bounds.margin);
  return {
    x: Math.round(Math.min(Math.max(point.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(point.y, minY), maxY)),
  };
}

/** Whether `point` is already where `clampToBounds` would put it. */
export function isWithinBounds(point: Point, bounds: Bounds): boolean {
  const clamped = clampToBounds(point, bounds);
  return clamped.x === point.x && clamped.y === point.y;
}

/** Where a popover's control is, in viewport coordinates. */
export interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PopoverBounds {
  viewportWidth: number;
  viewportHeight: number;
  popoverWidth: number;
  popoverHeight: number;
  /** Kept clear of every window edge. */
  margin: number;
  /** Left between the popover and the control that opened it. */
  gap: number;
}

/**
 * Where to put a popover so that all of it is on screen.
 *
 * The preferences are the readable placement; the clamp is the guarantee, and
 * the guarantee is the point. A popover positioned only by preference is
 * correct exactly where it was designed and wrong everywhere else -- the model
 * picker grew rightwards from a control that lives at the *right* edge of a
 * right-hand panel, so most of it was outside the window.
 *
 * - Horizontally it hangs to the left, its right edge on the control's. That
 *   is the side with room when the control is in a trailing rail, which is
 *   where popovers in this app are.
 * - Vertically it opens upwards, and only falls below when there is no room
 *   above. The chat composer is pinned to the bottom of its panel, so upwards
 *   is where the space is.
 *
 * Both are then clamped into the window. A popover too large to fit even so is
 * pinned to the top-left margin rather than centred on nothing: the controls
 * are read from the top down, so that is the half worth keeping.
 */
/**
 * Which side to try first, when both fit.
 *
 * `"above"` is the default and is what a control at the bottom of a panel
 * wants. `"below"` is for a field you are **typing into**: an autocomplete that
 * appears above the caret is surprising, and worse, `placePopover` would put it
 * above or below depending on where the panel happened to be — so the same
 * field would behave differently after dragging its window.
 *
 * Only the preference. Either way the result is clamped into the viewport, and
 * the clamp is the guarantee.
 */
export type PopoverSide = "above" | "below";

export function placePopover(
  anchor: AnchorRect,
  bounds: PopoverBounds,
  prefer: PopoverSide = "above",
): Point {
  const preferredLeft = anchor.left + anchor.width - bounds.popoverWidth;
  const above = anchor.top - bounds.gap - bounds.popoverHeight;
  const below = anchor.top + anchor.height + bounds.gap;
  const preferredTop =
    prefer === "below"
      ? (below + bounds.popoverHeight <= bounds.viewportHeight - bounds.margin
          ? below
          : (above >= bounds.margin ? above : below))
      : (above >= bounds.margin ? above : below);

  // `max` last, so it wins when the popover is wider or taller than the window
  // allows -- `maxLeft` is below `margin` then, and clamping the other way
  // round would push the popover off the near edge instead of the far one.
  const maxLeft = bounds.viewportWidth - bounds.popoverWidth - bounds.margin;
  const maxTop = bounds.viewportHeight - bounds.popoverHeight - bounds.margin;
  return {
    x: Math.round(Math.max(bounds.margin, Math.min(preferredLeft, maxLeft))),
    y: Math.round(Math.max(bounds.margin, Math.min(preferredTop, maxTop))),
  };
}
