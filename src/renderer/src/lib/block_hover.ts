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
  /** Whether a face drag is in flight. The outline must not chase it. */
  readonly dragging: boolean;
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

  if (state.dragging || state.overHandle || state.pointer === null) return NONE;
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
