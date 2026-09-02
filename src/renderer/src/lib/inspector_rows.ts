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
 * ## And the registry is the *flat era's* answer, not every era's
 *
 * Before 1.13 a block is a numeric `ID:DATA` pair and the modern registry has
 * nothing true to say about it. Asked anyway, it offered `waterlogged` on every
 * fence, stair, slab and pane in a 1.12.2 schematic -- a property 1.13
 * introduced, on a document from a version with no such idea. Reported exactly
 * that way.
 *
 * So a legacy document answers from `legacy_blocks.json` instead, which is the
 * table CLAUDE.md already names as authoritative there and which the writer
 * already decides the save on. Its 1,682 rows give 216 block names and their
 * states, and **not one of them carries `waterlogged`**.
 *
 * A block that era cannot name at all contributes nothing rather than falling
 * back to the registry: falling back is the claim this exists to stop making.
 * What the entry carries is still listed, which is what lets somebody see the
 * property and delete it.
 *
 * A block the registry does not know contributes nothing, so an unknown block
 * behaves precisely as it did before any of this. An omission costs nothing.
 */

import { legalValuesFor, propertiesOf } from "../../../shared/block_states.js";
import { legacyPropertiesOf, type LegacyIndex } from "../../../shared/legacy_ids.js";

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
  /** The open document's legacy table, or `null` when it is a flat one. */
  legacy: LegacyIndex | null = null,
): PropertyRow[] {
  const legal = legacy === null ? propertiesOf(block) : (legacyPropertiesOf(legacy, block) ?? []);
  const names = new Set([...Object.keys(carried), ...legal]);
  return [...names].sort().map((name) => ({
    name,
    value: carried[name] ?? null,
    values: legalValuesFor(block, name),
  }));
}
