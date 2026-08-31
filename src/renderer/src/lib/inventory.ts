/**
 * What the creative inventory shows, and which part of it needs drawing.
 *
 * The grid is virtualised: nine hundred blocks is nine hundred one-block meshes
 * if drawn naively, and the panel shows about sixty. So the list is filtered
 * once and only the visible window is asked for — which means the window has to
 * be computed from a scroll offset, and that arithmetic is here rather than in
 * the component because a scroll position is not something this project's test
 * harness can produce.
 *
 * Same reasoning as `build_grid.ts` and `selection_drag.ts`, and the same
 * split: the decision is testable, only the trigger is not.
 */

import { searchBlocks } from "./block_search.js";

export interface GridWindow {
  /** Index of the first row that needs drawing. */
  firstRow: number;
  /** One past the last. */
  lastRow: number;
  /** Indices into the filtered list, for the tiles to request icons for. */
  firstIndex: number;
  lastIndex: number;
  /** Total rows, so the scroller can size its spacer. */
  totalRows: number;
}

/**
 * Rows drawn beyond the viewport, above and below.
 *
 * Without overscan a fast scroll shows empty tiles for as long as the icons
 * take to arrive, which for a mesh built in main is long enough to see. Two
 * rows is roughly one flick of a wheel.
 */
export const OVERSCAN_ROWS = 2;

/**
 * Which slice of a virtualised grid is worth drawing.
 *
 * Clamped at both ends, because a scroll offset can be negative during an
 * elastic overscroll and can exceed the content height while the list is being
 * refiltered under the scroller.
 */
export function gridWindow(params: {
  count: number;
  columns: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
}): GridWindow {
  const columns = Math.max(1, Math.trunc(params.columns));
  const rowHeight = Math.max(1, params.rowHeight);
  const totalRows = Math.ceil(Math.max(0, params.count) / columns);

  const firstVisible = Math.floor(Math.max(0, params.scrollTop) / rowHeight);
  const visibleRows = Math.ceil(Math.max(0, params.viewportHeight) / rowHeight);

  const firstRow = Math.max(0, Math.min(totalRows, firstVisible - OVERSCAN_ROWS));
  const lastRow = Math.max(firstRow, Math.min(totalRows, firstVisible + visibleRows + OVERSCAN_ROWS));

  return {
    firstRow,
    lastRow,
    firstIndex: firstRow * columns,
    // Capped at the count, or the last row of a partly-filled grid would ask
    // for tiles that do not exist and get placeholders for them.
    lastIndex: Math.min(params.count, lastRow * columns),
    totalRows,
  };
}

/**
 * The blocks to offer, filtered by the search and by what this schematic can
 * actually hold.
 *
 * `placeable` is the set of block names the document's Minecraft version can
 * name, or `null` for no restriction. Only the **legacy era** supplies one
 * today, and the asymmetry is the honest part rather than an oversight:
 *
 * - Before 1.13 a block is a numeric `ID:DATA` pair, and
 *   `resources/legacy_blocks.json` enumerates every one of them. That is not a
 *   guess -- it is the same table `buildMcEdit` decides the save on, so what
 *   the inventory hides is exactly what the writer would refuse.
 * - Above 1.13 this app has no per-block introduction data, so a filter would
 *   mean inventing when each block was added. **Showing a block that does not
 *   exist yet is recoverable -- hiding one that does is the mistake nobody can
 *   work around**, so nothing is cut there and the caller shows the target
 *   version beside the grid instead.
 *
 * This comment used to argue against filtering by version at all, on the
 * second bullet's reasoning alone. It was right about the flat era and wrong
 * to generalise: the legacy boundary is exactly known, and leaving it unfiltered
 * let a 1.12 schematic offer deepslate -- placeable, drawable, and fatal at
 * save time, a long way from the click.
 *
 * Air is always excluded, whatever the era: there is nothing to pick up.
 */
export function inventoryBlocks(
  all: readonly string[],
  query: string,
  placeable: ReadonlySet<string> | null = null,
): string[] {
  const offered = all.filter(
    (block) => !isAir(block) && (placeable === null || placeable.has(block)),
  );
  const trimmed = query.trim();
  return trimmed === "" ? offered : searchBlocks(offered, trimmed);
}


/**
 * Air is not a block you can hold.
 *
 * It is in the registry because the *document* is full of it — every empty cell
 * is air, and the writers and the agent both name it. But there is nothing to
 * pick up and nothing to draw: its icon meshes to nothing, so it showed as a
 * permanently blank tile that looked like a failure to load. Air is placed by
 * removing a block, which is the only gesture that ever means it.
 */
export function isAir(block: string): boolean {
  return block.split("[")[0].replace(/^minecraft:/, "") === "air";
}

/** `minecraft:oak_planks` → `oak planks`, which is what fits under a tile. */
export function blockLabel(id: string): string {
  return id.replace(/^minecraft:/, "").replace(/\[.*$/, "").replace(/_/g, " ");
}
