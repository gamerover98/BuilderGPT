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

export interface Bounds {
  /** The area the panel must stay reachable within. */
  paneWidth: number;
  paneHeight: number;
  /** The panel's own width; its height is not constrained from the bottom. */
  panelWidth: number;
  /** How much of the panel must remain on screen at each edge. */
  margin: number;
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
 */
export function clampToBounds(point: Point, bounds: Bounds): Point {
  const minX = bounds.margin - bounds.panelWidth;
  const maxX = Math.max(0, bounds.paneWidth - bounds.margin);
  const maxY = Math.max(0, bounds.paneHeight - bounds.margin);
  return {
    x: Math.round(Math.min(Math.max(point.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(point.y, 0), maxY)),
  };
}

/** Whether `point` is already where `clampToBounds` would put it. */
export function isWithinBounds(point: Point, bounds: Bounds): boolean {
  const clamped = clampToBounds(point, bounds);
  return clamped.x === point.x && clamped.y === point.y;
}
