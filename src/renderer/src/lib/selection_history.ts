/**
 * Undo and redo that include the selection, not only the blocks.
 *
 * Ctrl+Z used to reach only the main process, because only the main process
 * had anything to undo: the selection is renderer state and had no history at
 * all. So dragging a face across a build, realising it was wrong, and pressing
 * Ctrl+Z undid the last *block edit* instead — destroying work in answer to a
 * request to undo a highlight.
 *
 * ## One timeline out of two stacks
 *
 * The block edits live in main and the selections live here, and interleaving
 * them needs a shared ordering. `DocumentState.undoDepth` is that ordering: how
 * many transactions are on main's undo stack. Every selection change records
 * the depth it happened at, and the rule is a single sentence — **a selection
 * is undone only while no block edit has landed on top of it.**
 *
 * That gives the behaviour without a second copy of anything. Select, select,
 * fill, select: Ctrl+Z takes back the last selection, then the fill, then the
 * two selections, in that order.
 *
 * Pure and separate because the alternative is testing it through a viewport
 * that this project's harness cannot drive — the same split `build_grid.ts` and
 * `selection_drag.ts` were made for.
 */

import type { RegionSpec } from "../../../shared/ipc.js";

export interface Anchor {
  x: number;
  y: number;
  z: number;
}

/** Everything a selection is, so a step can put it all back. */
export interface SelectionState {
  selection: RegionSpec | null;
  anchor: Anchor | null;
}

export interface SelectionStep {
  /** `undoDepth` when this change was made. */
  depth: number;
  before: SelectionState;
  after: SelectionState;
  /**
   * Whether this change arrived *with* the block edit that took the document
   * from `depth` to `depth + 1`.
   *
   * The gizmo's move, turn and scale all change the blocks and the box in one
   * gesture. Recorded apart they cost two presses of Ctrl+Z -- one to put the
   * box back on the space the blocks had left, one to put the blocks back --
   * which reads as the editor having done two things when the user did one.
   */
  withEdit?: boolean;
}

/** What Ctrl+Z should reach for. */
export type UndoTarget = "selection" | "document" | "none";

export interface Timeline {
  undo: SelectionStep[];
  redo: SelectionStep[];
}

export function emptyTimeline(): Timeline {
  return { undo: [], redo: [] };
}

export function sameSelection(a: SelectionState, b: SelectionState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Records a selection change.
 *
 * A new step drops the redo stack, exactly as it does in any editor: once you
 * branch, the future you branched away from is not reachable any more.
 *
 * Steps recorded above the current depth are dropped too. They belong to block
 * edits that were undone and then written over, so main's own redo stack has
 * already discarded them — keeping ours would leave selections that could be
 * restored into a document that never had them.
 */
export function recordSelection(
  timeline: Timeline,
  depth: number,
  before: SelectionState,
  after: SelectionState,
): Timeline {
  if (sameSelection(before, after)) return timeline;
  return {
    undo: [...timeline.undo.filter((step) => step.depth <= depth), { depth, before, after }],
    redo: [],
  };
}

/**
 * A block edit landed, and it moved the selection with it.
 *
 * `depthBefore` is the depth the document was at *before* the edit, and that
 * is what pairs the two: at the new depth the step no longer answers
 * `undoTarget`, so the document is undone first -- and `takeEditUndo` hands
 * the box back in the same press.
 *
 * Stamping the post-edit depth instead is exactly the bug this replaces. The
 * catch-all recorder in `App.svelte` reads whatever `undoDepth` says at flush
 * time, and the commit handlers write `selection` *after* awaiting the edit --
 * so the step came out keyed to the depth it should have been under.
 */
export function recordEditSelection(
  timeline: Timeline,
  depthBefore: number,
  before: SelectionState,
  after: SelectionState,
): Timeline {
  if (sameSelection(before, after)) return timeline;
  return {
    undo: [
      ...timeline.undo.filter((step) => step.depth <= depthBefore),
      { depth: depthBefore, before, after, withEdit: true },
    ],
    redo: [],
  };
}

/**
 * A block edit landed.
 *
 * Nothing is recorded — main owns that step — but the redo stack goes, for the
 * reason above, and so do any selection steps stranded above the new depth.
 */
export function recordDocumentEdit(timeline: Timeline, depth: number): Timeline {
  return { undo: timeline.undo.filter((step) => step.depth <= depth), redo: [] };
}

/**
 * The document was replaced wholesale — opened, closed, restored from a
 * checkpoint. Main starts a fresh history, so ours cannot mean anything either.
 */
export function forgetTimeline(): Timeline {
  return emptyTimeline();
}

/**
 * What the next press should reach for.
 *
 * A paired step needs no clause here, and that is worth writing down because
 * one was tried. It is keyed one below the current depth, so the comparison
 * already sends the press to the document; and in the one case where the
 * depths *do* meet -- the edit was undone by something that bypassed
 * `undoAnything`, which the chat panel's per-message undo does -- the right
 * answer is the one the arithmetic gives. The blocks are already back, so the
 * box should follow.
 *
 * Adding the clause anyway was tested by adding it: nothing failed when it
 * was removed again, which is what a rule with no case behind it looks like.
 */
export function undoTarget(timeline: Timeline, depth: number, canUndo: boolean): UndoTarget {
  const top = timeline.undo[timeline.undo.length - 1];
  if (top !== undefined && top.depth === depth) return "selection";
  return canUndo ? "document" : top === undefined ? "none" : "selection";
}

/**
 * The mirror, and the one place the flag is load-bearing.
 *
 * Undoing a pair leaves its step on the redo stack keyed at the depth the
 * document has just come back to -- so here the depths *do* meet, and without
 * the clause the press would move the box forward while the blocks stayed
 * behind. That is the same two-press fault the pairing exists to remove,
 * pointing the other way.
 */
export function redoTarget(timeline: Timeline, depth: number, canRedo: boolean): UndoTarget {
  const top = timeline.redo[timeline.redo.length - 1];
  if (top !== undefined && top.depth === depth && top.withEdit !== true) return "selection";
  return canRedo ? "document" : top === undefined ? "none" : "selection";
}

export interface UndoResult {
  timeline: Timeline;
  /** What to put back on screen. */
  state: SelectionState;
}

/** Takes the top selection step off the undo stack. `null` when there is none. */
export function takeUndo(timeline: Timeline): UndoResult | null {
  const step = timeline.undo[timeline.undo.length - 1];
  if (step === undefined) return null;
  return {
    timeline: { undo: timeline.undo.slice(0, -1), redo: [...timeline.redo, step] },
    state: step.before,
  };
}

/** The mirror. */
export function takeRedo(timeline: Timeline): UndoResult | null {
  const step = timeline.redo[timeline.redo.length - 1];
  if (step === undefined) return null;
  return {
    timeline: { undo: [...timeline.undo, step], redo: timeline.redo.slice(0, -1) },
    state: step.after,
  };
}

/**
 * The selection that rode in with the edit the document has just been taken
 * back to, if there was one.
 *
 * Asked *after* the document undo, when the depth has come back down to meet
 * the step. Returns `null` for an ordinary step, which is what keeps a
 * selection somebody made on purpose before the edit from being swallowed by
 * the same press.
 */
export function takeEditUndo(timeline: Timeline, depth: number): UndoResult | null {
  const step = timeline.undo[timeline.undo.length - 1];
  if (step === undefined || step.withEdit !== true || step.depth !== depth) return null;
  return {
    timeline: { undo: timeline.undo.slice(0, -1), redo: [...timeline.redo, step] },
    state: step.before,
  };
}

/**
 * The mirror, and it has to be asked *before* the redo rather than after.
 *
 * A redo raises the depth exactly as a fresh edit does, and `App.svelte`'s
 * depth watcher cannot tell them apart -- so it calls `recordDocumentEdit`,
 * which empties the redo stack. Taking the step first is what saves it. That
 * emptying is wrong for a redo either way: the branch was never abandoned.
 */
export function takeEditRedo(timeline: Timeline, depth: number): UndoResult | null {
  const step = timeline.redo[timeline.redo.length - 1];
  if (step === undefined || step.withEdit !== true || step.depth !== depth) return null;
  return {
    timeline: { undo: [...timeline.undo, step], redo: timeline.redo.slice(0, -1) },
    state: step.after,
  };
}
