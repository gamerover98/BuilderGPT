/**
 * Turning a pointer into a cell on the build grid.
 *
 * With zero blocks there is nothing to raycast, so there was no way to start:
 * neither a selection nor a placement had a target, and an empty schematic was
 * literally untouchable. The grid is that target — a plane of block-sized cells
 * at the document's base, which a ray can hit whether or not anything has been
 * built yet.
 *
 * ## Why the arithmetic is here and not in the viewer
 *
 * The raycast runs from the rendering steps, and those cannot be observed in
 * this project's browser harness: `requestAnimationFrame` callbacks do not fire
 * while the pane is not compositing, measurably so. The response — already
 * established by `selection_drag.ts` — is to keep the *decision* in a plain
 * module and test that, leaving only the trigger unobservable.
 *
 * Document coordinates are world coordinates in the viewer (the pipeline emits
 * no node transform), so a cell `(x, y, z)` is the unit cube from `(x, y, z)`
 * to `(x+1, y+1, z+1)`. Everything below assumes that and nothing else.
 */

import { intersectPlane, type Ray, type Region, type Vec3 } from "./selection_drag.js";

/** The dimensions of the open document, in blocks. */
export interface BoxSize {
  width: number;
  height: number;
  length: number;
}

export interface Cell {
  x: number;
  y: number;
  z: number;
}

/**
 * How far outside the document a grid cell may sit before it is refused.
 *
 * The grid extends past the box on purpose — that is how you grow a build
 * outwards — but a ray that grazes the plane near the horizon lands thousands
 * of blocks away, and turning that into a fill would ask for a resize nobody
 * wanted. Generous enough to build with, small enough that a mistake is
 * obviously a mistake.
 */
export const MAX_GRID_REACH = 512;

/**
 * The cell a ray lands on, on the horizontal plane at the base of the document.
 *
 * `null` when the ray runs parallel to the plane, points away from it, or lands
 * absurdly far out — see `MAX_GRID_REACH`. Callers treat all three as "the
 * pointer is not over the grid", which is the truth in each case.
 */
export function cellUnderRay(ray: Ray, size: BoxSize, planeY = 0): Cell | null {
  const point = intersectPlane(ray, { x: 0, y: planeY, z: 0 }, { x: 0, y: 1, z: 0 });
  if (point === null) return null;

  const cell = {
    // `floor`, not `round`: the cell is the one the point falls *inside*, and
    // rounding would snap to the nearest corner — half a block out, in both
    // axes, everywhere.
    x: Math.floor(point.x),
    y: planeY,
    z: Math.floor(point.z),
  };

  const reach = Math.max(
    -cell.x,
    cell.x - (size.width - 1),
    -cell.z,
    cell.z - (size.length - 1),
  );
  return reach > MAX_GRID_REACH ? null : cell;
}

/** Whether a cell is inside the document as it currently stands. */
export function isInsideBox(cell: Cell, size: BoxSize): boolean {
  return (
    cell.x >= 0 &&
    cell.y >= 0 &&
    cell.z >= 0 &&
    cell.x < size.width &&
    cell.y < size.height &&
    cell.z < size.length
  );
}

/**
 * The region two cells describe, corners in either order.
 *
 * A drag from one cell to another is a box, and a click is a drag that ended
 * where it started — one cell, which this returns without a special case.
 */
export function regionBetween(a: Cell, b: Cell): Region {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    minZ: Math.min(a.z, b.z),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
    maxZ: Math.max(a.z, b.z),
  };
}

/**
 * The cells to draw, as a square around the pointer.
 *
 * The grid is only visible near the cursor, which is the difference between a
 * usable aid and a permanent lattice in front of the model. Returned as a list
 * rather than drawn here so the caller can build geometry from it and this
 * stays testable.
 *
 * `null` for the centre means the pointer is off the grid and nothing is drawn.
 */
export function visibleCells(centre: Cell | null, radius: number): Cell[] {
  if (centre === null) return [];
  const cells: Cell[] = [];
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      cells.push({ x: centre.x + dx, y: centre.y, z: centre.z + dz });
    }
  }
  return cells;
}

/**
 * How strongly a cell should show, given how far it is from the pointer.
 *
 * A radial falloff rather than a hard square edge: the square is an artefact of
 * how the cells are enumerated, and showing it makes the grid look like an
 * object rather than like a hint about where the cursor is.
 */
export function cellFade(cell: Cell, centre: Cell, radius: number): number {
  if (radius <= 0) return 1;
  const distance = Math.hypot(cell.x - centre.x, cell.z - centre.z);
  return Math.max(0, 1 - distance / radius);
}

/**
 * What placing into this region would cost the document.
 *
 * `"fits"` when it is already inside the box; `"grows"` when it is not, in any
 * direction. `domain/grow.ts` extends the document to suit in the same
 * transaction, so growing and placing are one undo step.
 *
 * There used to be a third answer, `"blocked"`, for a region reaching below the
 * origin — on the reasoning that the grid has no negative index, so growing
 * that way moves the *content* instead and a stray drag should not trigger it.
 * The reasoning is sound and the conclusion was wrong for this app: a fill
 * dragged under the floor has always moved the content up, and refusing the
 * same act to a single click meant the two gestures disagreed about what the
 * editor is. `grow.ts` is the one arithmetic and this reports it, nothing more.
 *
 * It reports rather than decides. Main grows on its own and does not consult
 * this; what it is for is saying so *before* the click, because a build-grid
 * cell that will resize the document should not look identical to one that
 * will not.
 */
export function placementNeeds(region: Region, size: BoxSize): "fits" | "grows" {
  const outside =
    region.minX < 0 ||
    region.minY < 0 ||
    region.minZ < 0 ||
    region.maxX >= size.width ||
    region.maxY >= size.height ||
    region.maxZ >= size.length;
  return outside ? "grows" : "fits";
}

/** The one-cell region a single placement covers, for `placementNeeds`. */
export function cellRegion(cell: Cell): Region {
  return {
    minX: cell.x,
    minY: cell.y,
    minZ: cell.z,
    maxX: cell.x,
    maxY: cell.y,
    maxZ: cell.z,
  };
}

export type { Cell as GridCell, Ray, Region, Vec3 };
