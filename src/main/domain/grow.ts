/**
 * Making room for a region that reaches outside the schematic.
 *
 * The editor lets a selection leave the box — you drag a face out past the edge
 * because that is where you want to build next, not because you first went and
 * resized the document. Filling such a region grows the document to contain it,
 * and saving trims whatever air is left over (`crop.ts`). Between those two the
 * footprint stops being something the user has to manage.
 *
 * The arithmetic is here, apart from the transaction that applies it, because
 * the interesting part is the sign of the shift. The grid has no negative
 * coordinates, so a region reaching below zero cannot be reached by growing —
 * the *content* has to move up instead, and the world offset move the other way
 * to compensate. Getting that backwards puts the new space on the wrong side.
 */

import type { Region } from "./document.js";

export interface Extent {
  width: number;
  height: number;
  length: number;
}

export interface Growth {
  size: Extent;
  /** How far existing content moves, always zero or positive. */
  shift: [number, number, number];
}

/** A region with its corners sorted, and *not* clipped to anything. */
export function orderRegion(region: Region): Region {
  return {
    minX: Math.min(region.minX, region.maxX),
    minY: Math.min(region.minY, region.maxY),
    minZ: Math.min(region.minZ, region.maxZ),
    maxX: Math.max(region.minX, region.maxX),
    maxY: Math.max(region.minY, region.maxY),
    maxZ: Math.max(region.minZ, region.maxZ),
  };
}

/** The same region after the content it sits in has moved by `shift`. */
export function shiftRegion(region: Region, shift: readonly [number, number, number]): Region {
  return {
    minX: region.minX + shift[0],
    minY: region.minY + shift[1],
    minZ: region.minZ + shift[2],
    maxX: region.maxX + shift[0],
    maxY: region.maxY + shift[1],
    maxZ: region.maxZ + shift[2],
  };
}

/**
 * The resize that would make `region` fit inside `extent`, or `null` when it
 * already does.
 *
 * `region` is taken in the document's current coordinates and may be negative
 * on any axis. The returned `shift` is what existing content must move by, and
 * is what the caller must also apply to the region before writing into it —
 * after the resize, the cells the region named have moved with everything else.
 */
export function growthToInclude(extent: Extent, region: Region): Growth | null {
  const ordered = orderRegion(region);

  const low = [
    Math.min(0, ordered.minX),
    Math.min(0, ordered.minY),
    Math.min(0, ordered.minZ),
  ];
  const high = [
    Math.max(extent.width - 1, ordered.maxX),
    Math.max(extent.height - 1, ordered.maxY),
    Math.max(extent.length - 1, ordered.maxZ),
  ];

  const size: Extent = {
    width: high[0] - low[0] + 1,
    height: high[1] - low[1] + 1,
    length: high[2] - low[2] + 1,
  };
  // Growing downwards is expressed as moving the content up, because index -1
  // does not exist.
  const shift: [number, number, number] = [-low[0], -low[1], -low[2]];

  if (
    size.width === extent.width &&
    size.height === extent.height &&
    size.length === extent.length &&
    shift[0] === 0 &&
    shift[1] === 0 &&
    shift[2] === 0
  ) {
    return null;
  }
  return { size, shift };
}

/** Voxels in a box. */
export function extentVolume(extent: Extent): number {
  return extent.width * extent.height * extent.length;
}
