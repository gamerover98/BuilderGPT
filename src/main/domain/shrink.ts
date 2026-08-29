/**
 * Taking the box back in when a break empties the face it was standing on.
 *
 * `grow.ts` is the other half of one sentence -- **the editor imposes no
 * footprint, the document follows the content** -- and for a long time only
 * half of it was written. Placing a block past the edge grew the schematic to
 * contain it and breaking that same block left it grown, so one gesture had two
 * answers depending on which way round you did it, and a block placed outside
 * by accident cost a resize to take back.
 *
 * **One slab per face, and that number is the whole design.** The obvious rule
 * is "shrink to the content", and it is the rule that eats work: a schematic
 * 16 wide with a house between x=2 and x=12 is 3 slabs of room somebody made on
 * purpose, and breaking one block at the far face would take all three. One
 * slab gives back exactly what the matching growth added -- a click on an edge
 * block's outer face grows the box by one -- so the gesture round-trips and
 * nothing else moves. A wall built outwards peels back one break at a time, in
 * the same order it was built.
 *
 * It also means room is untouchable rather than merely usually safe: a face
 * with nothing on it is never named by the caller, because the cell that was
 * broken has to *be* that face. A deliberately roomy box has no block on its
 * outer faces to break.
 *
 * **Only the far faces, never the origin.** Retreating at the near side would
 * move all the content down, and every coordinate anybody has been given -- a
 * selection, a number in the inspector, a `get_region` result -- would stop
 * meaning what it meant. That is `resizeSession`'s restriction and
 * `resize_document`'s, arrived at from a third direction.
 *
 * Emptiness is the caller's predicate rather than "is it air", because with a
 * void block chosen a break writes *that*. Keyed on air, the schematic would go
 * on growing underwater and never come back in -- which is exactly the build
 * the void block exists for.
 */

import type { SchematicDocument } from "./document.js";
import type { Extent } from "./grow.js";

/** Which far faces the edit could have emptied. */
export interface FarFaces {
  x: boolean;
  y: boolean;
  z: boolean;
}

/**
 * The extent left after peeling one empty slab off each named far face, or
 * `null` when none of them came off.
 *
 * `isEmpty` is asked about a *palette index*, not about a cell: two cells
 * holding one entry cannot differ, and the palette is a few dozen entries
 * against millions of voxels.
 *
 * The axes are taken in order and each reads what the ones before it left, so
 * the answer is a function of the document rather than of the order the caller
 * happened to list the faces in.
 */
export function peelEmptyFaces(
  doc: SchematicDocument,
  isEmpty: (paletteIndex: number) => boolean,
  faces: FarFaces,
  minimum = 1,
): Extent | null {
  const plane = doc.height * doc.length;
  const at = (x: number, y: number, z: number): number =>
    doc.voxels[x * plane + y * doc.length + z];

  let width = doc.width;
  let height = doc.height;
  let length = doc.length;

  if (faces.x && width > minimum) {
    let bare = true;
    for (let y = 0; bare && y < height; y += 1) {
      for (let z = 0; z < length; z += 1) {
        if (!isEmpty(at(width - 1, y, z))) {
          bare = false;
          break;
        }
      }
    }
    if (bare) width -= 1;
  }

  if (faces.y && height > minimum) {
    let bare = true;
    for (let x = 0; bare && x < width; x += 1) {
      for (let z = 0; z < length; z += 1) {
        if (!isEmpty(at(x, height - 1, z))) {
          bare = false;
          break;
        }
      }
    }
    if (bare) height -= 1;
  }

  if (faces.z && length > minimum) {
    let bare = true;
    for (let x = 0; bare && x < width; x += 1) {
      for (let y = 0; y < height; y += 1) {
        if (!isEmpty(at(x, y, length - 1))) {
          bare = false;
          break;
        }
      }
    }
    if (bare) length -= 1;
  }

  if (width === doc.width && height === doc.height && length === doc.length) return null;
  return { width, height, length };
}
