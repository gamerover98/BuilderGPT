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

export function undoTarget(timeline: Timeline, depth: number, canUndo: boolean): UndoTarget {
  const top = timeline.undo[timeline.undo.length - 1];
  if (top !== undefined && top.depth === depth) return "selection";
  return canUndo ? "document" : top === undefined ? "none" : "selection";
}

export function redoTarget(timeline: Timeline, depth: number, canRedo: boolean): UndoTarget {
  const top = timeline.redo[timeline.redo.length - 1];
  if (top !== undefined && top.depth === depth) return "selection";
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
