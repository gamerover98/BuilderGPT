/**
 * Where the block outline takes its ray from, if anywhere.
 *
 * The outline itself is older than this module and was flight's alone: in
 * flight the crosshair is the pointer, so "what am I about to click" answers
 * itself. In orbit there was no answer at all — you clicked a block to inspect
 * it, or Shift-clicked to select it, and nothing on screen said which block the
 * ray was on until after the click had already happened. The pick was being
 * computed either way; it simply was not drawn.
 *
 * This is a plain module rather than a branch inside `updateBlockHighlight` for
 * the standing reason `selection_drag.ts` and `floating.ts` are: the outline is
 * refreshed from the render loop, `requestAnimationFrame` callbacks belong to
 * the rendering steps, and the Browser pane here is frequently not compositing
 * — so a rule left inside the component is a rule that cannot be defended.
 * Only the trigger stays unobservable; the decision is `tests/ui.ts`'s.
 */

/** Where to cast from, or that there is nothing to draw. */
export type HoverSource =
  | { readonly kind: "none" }
  | { readonly kind: "crosshair" }
  | { readonly kind: "pointer"; readonly x: number; readonly y: number };

const NONE: HoverSource = { kind: "none" };

export interface HoverState {
  readonly cameraMode: "orbit" | "fly";
  /** Whether the canvas holds the pointer lock. Flight's crosshair is real only then. */
  readonly flying: boolean;
  /** Whether there is a mesh to raycast at all. */
  readonly loaded: boolean;
  /** Latest pointer position over the canvas, or `null` once it has left. */
  readonly pointer: { readonly x: number; readonly y: number } | null;
  /**
   * Whether the pointer is over one of the selection's six face handles.
   *
   * The cursor has already become `ns-resize`/`ew-resize` there, and the press
   * will drag the face rather than touch the block underneath — so outlining
   * that block would promise something the click does not do.
   */
  readonly overHandle: boolean;
  /**
   * Whether the pointer is over one of the transform gizmo's handles.
   *
   * The same sentence as the one above, about a different thing drawn for the
   * same purpose. It is a field of its own rather than folded into
   * `overHandle` because the two come from different raycasts and a failure
   * should name which one was forgotten.
   */
  readonly overGizmo: boolean;
  /** Whether a drag is in flight. The outline must not chase it. */
  readonly dragging: boolean;
}

/**
 * Whether the pointer is promising a handle rather than what is behind it.
 *
 * Two consumers, which is why it is a function rather than a condition inside
 * `hoverSource`: the block outline, which must not draw around a block the
 * click will not touch, and the build grid's patch, which must not draw a
 * target on the floor behind an arrow. The second was missing -- hovering a
 * gizmo arrow over open ground lit a cell at y=0 that the press had nothing to
 * do with, which reads as the editor being about to place something there.
 */
export function pointerOnHandle(state: {
  readonly overHandle: boolean;
  readonly overGizmo: boolean;
  readonly dragging: boolean;
}): boolean {
  return state.overHandle || state.overGizmo || state.dragging;
}

export function hoverSource(state: HoverState): HoverSource {
  // Nothing to hit. Also the empty-document case, where the build grid is the
  // only thing under the pointer and it is not a block.
  if (!state.loaded) return NONE;

  if (state.cameraMode === "fly") {
    // Before the lock the click means "capture the pointer", not "build here",
    // and the crosshair is not yet where the ray goes.
    return state.flying ? { kind: "crosshair" } : NONE;
  }

  if (pointerOnHandle(state) || state.pointer === null) return NONE;
  return { kind: "pointer", x: state.pointer.x, y: state.pointer.y };
}

/**
 * The centre of a cell, which is where a 1x1x1 outline sits.
 *
 * A cell spans `[x, x+1]`, so its centre is half a block along each axis.
 * Written down rather than inlined because getting it wrong draws the outline
 * over the block's corner, which reads as a rendering glitch rather than as
 * arithmetic.
 */
export function outlineCentre(cell: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): { x: number; y: number; z: number } {
  return { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
}

/**
 * The hit normal, turned to face the ray that found it.
 *
 * `pickBlockAt` steps a hair *inwards* from the surface along `-normal`, and
 * that is right only for a face the ray struck from the front. The block
 * material is `DoubleSide` — it has to be, because a cross and every other
 * paper-thin element in the game is one quad seen from both sides — so a ray
 * can perfectly well arrive at a face's back, and there `-normal` points back
 * out along the line of sight instead of into the block.
 *
 * The azalea is where that shows. Vanilla's `template_azalea` states its lid as
 * a zero-thickness element at `y = 16` carrying **both** an `up` and a `down`
 * face, so the block's top surface sits exactly on the boundary with the cell
 * above and half of it points the wrong way. Whichever of the two the raycaster
 * returned decided the answer: on the `down` one the pick landed one cell up,
 * and since that cell is air the outline drew around nothing, breaking it
 * changed nothing, and placing went a cell too high. The report was "placing an
 * azalea puts an air block above it that cannot be removed", which is exactly
 * what that looks like from the outside.
 *
 * Turning the normal costs nothing and cannot change a front-face answer: there
 * the dot product is already negative and the vector is returned as it came.
 */
export function facingNormal(
  normal: readonly [number, number, number],
  direction: readonly [number, number, number],
): readonly [number, number, number] {
  const towardsRay =
    normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2] > 0;
  return towardsRay ? [-normal[0], -normal[1], -normal[2]] : normal;
}
