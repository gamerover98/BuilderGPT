/**
 * Which pointer-lock movements are the mouse, and which are the browser.
 *
 * In Creative flight the camera is driven by `movementX`/`movementY` from
 * pointer-locked `mousemove` events, and those are not always a mouse moving.
 * Chromium delivers a spurious one immediately after the lock is acquired,
 * carrying the distance from wherever the cursor happened to be to the point it
 * was warped to — hundreds of pixels, applied in a single frame. That is the
 * "the view suddenly snaps somewhere" report: not a hook, not the app's own
 * input, an event the page is told to believe.
 *
 * Two rules, because the two causes are different:
 *
 * - anything in the first instants after the lock is discarded outright. There
 *   is no legitimate movement to lose there: the gesture that acquired the lock
 *   was a *click*, and a click that also spun the camera is exactly the fault.
 * - after that, a single event larger than any hand could produce between two
 *   frames is discarded on its own. A fast flick across a 4K screen is a few
 *   hundred pixels *per second*; a single event carrying more than a couple of
 *   hundred is not a wrist.
 *
 * Deliberately a filter and not a clamp. A clamped spike still turns the camera,
 * just less — and a movement this size is not a small truth, it is not the
 * user's at all.
 */

/**
 * How long after acquiring the lock every movement is ignored, in ms.
 *
 * Long enough to cover the warp event, short enough that nobody can have
 * started aiming: two frames at 60Hz is 33ms, and the spurious event arrives in
 * the first one.
 */
export const LOCK_SETTLE_MS = 120;

/**
 * The largest movement, in pixels on one axis, a single event may carry.
 *
 * Generous on purpose: this is a guard against events that are not the mouse,
 * not a speed limit on the mouse.
 */
export const MAX_LOOK_STEP = 240;

export function isSpuriousLook(event: {
  readonly movementX: number;
  readonly movementY: number;
  /** Milliseconds since the pointer lock was acquired. */
  readonly sinceLock: number;
}): boolean {
  if (event.sinceLock < LOCK_SETTLE_MS) return true;
  return Math.abs(event.movementX) > MAX_LOOK_STEP || Math.abs(event.movementY) > MAX_LOOK_STEP;
}
