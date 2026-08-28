/**
 * Which block-state rows the inspector shows, and what each one is holding.
 *
 * A plain module for `selection_drag.ts`'s reason: this is a decision with edge
 * cases, and a decision written inside a `$derived.by` cannot be stated by a
 * check -- only grepped for, which proves the call is there and nothing about
 * what it answers.
 *
 * ## The rule
 *
 * The rows are the **union** of what the block carries and what the game says
 * it may carry, and both halves are load-bearing.
 *
 * The panel used to list the entry's own keys and nothing else. That is right
 * for a block that arrived from a file, where the states are all written down,
 * and useless for one that arrived bare -- so a campfire placed over MCP showed
 * "This block has no block states" and offered nothing, on a block with four.
 * The properties were never missing from the game; they were missing from the
 * entry, and this panel is where somebody would have gone to fix that.
 *
 * The registry alone would be the mirror mistake. A schematic may hold a
 * property the block does not legally have -- another tool wrote it, or the
 * block was renamed under it -- and that is exactly the state somebody opens
 * this panel to delete. Listing only what is legal would hide it while leaving
 * it in the file.
 *
 * A block the registry does not know contributes nothing, so an unknown block
 * behaves precisely as it did before any of this. An omission costs nothing.
 */

import { legalValuesFor, propertiesOf } from "../../../shared/block_states.js";

export interface PropertyRow {
  readonly name: string;
  /**
   * What the block carries, or `null` for a property it may hold and does not.
   *
   * `null` rather than the default it would take, because those are different
   * claims: the panel has to be able to say "this is not set" without implying
   * the block is behaving as though it were.
   */
  readonly value: string | null;
  /** The legal values, or `null` where the registry has none to offer. */
  readonly values: readonly string[] | null;
}

/**
 * Sorted by name, and not by whether the row is set.
 *
 * Grouping the set ones first reads better in a screenshot and is worse to use:
 * filling in a blank row would move it, so the next thing you typed would land
 * in whatever row slid into its place.
 */
export function propertyRows(
  block: string,
  carried: Readonly<Record<string, string>>,
): PropertyRow[] {
  const names = new Set([...Object.keys(carried), ...propertiesOf(block)]);
  return [...names].sort().map((name) => ({
    name,
    value: carried[name] ?? null,
    values: legalValuesFor(block, name),
  }));
}
