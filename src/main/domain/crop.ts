/**
 * Trimming the empty air from around a schematic.
 *
 * Editing tends to leave padding. You grow the box to have somewhere to build,
 * and what you build does not fill it; the file then carries a shell of air
 * around the structure, which every reader has to allocate and every viewer has
 * to frame around. Saving trims it to the outermost non-air block on each of
 * the six sides.
 *
 * **The open document is never modified.** That is not tidiness, it is the
 * `history.ts` invariant: a voxel index only means anything relative to the
 * dimensions in force when it was recorded, so re-dimensioning the live
 * document would invalidate every delta on the undo stack. The crop produces a
 * *copy* for the writer, exactly as the writers already build their own local
 * palette rather than compacting the document's.
 */

import type { BlockEntityRecord } from "../pipeline/types.js";
import { documentSize, posKey, type SchematicDocument } from "./document.js";

/** The tight box around the non-air voxels, in the document's own coordinates. */
export interface ContentBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * The smallest box containing every non-air voxel, or `null` when there are
 * none.
 *
 * An all-air document has no content to bound, and cropping it to some
 * arbitrary 1x1x1 corner would be inventing a position. The caller writes it
 * out as it stands instead.
 */
export function contentBounds(doc: SchematicDocument): ContentBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  // One pass over the flat array rather than three nested loops with a multiply
  // each: this runs on every save, over every voxel.
  const { height, length } = doc;
  const plane = height * length;
  for (let index = 0; index < doc.voxels.length; index += 1) {
    if (doc.voxels[index] === 0) continue;
    const x = Math.floor(index / plane);
    const rest = index - x * plane;
    const y = Math.floor(rest / length);
    const z = rest - y * length;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  if (minX === Infinity) return null;
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** What a crop did, for the UI to report. */
export interface CropSummary {
  from: [number, number, number];
  to: [number, number, number];
}

export interface CroppedDocument {
  doc: SchematicDocument;
  summary: CropSummary;
}

/**
 * A copy of `doc` trimmed to its content, or `null` when there is nothing to
 * trim — already tight, or nothing but air.
 *
 * The palette is shared by reference rather than copied. Nothing here writes
 * to it, and the writers build their own local palette from the voxels anyway,
 * so a copy would be allocated only to be thrown away.
 */
export function cropToContent(doc: SchematicDocument): CroppedDocument | null {
  const bounds = contentBounds(doc);
  if (bounds === null) return null;

  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  const length = bounds.maxZ - bounds.minZ + 1;
  if (width === doc.width && height === doc.height && length === doc.length) {
    return null;
  }

  const voxels = new Int32Array(width * height * length);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let z = 0; z < length; z += 1) {
        const source =
          (x + bounds.minX) * doc.height * doc.length +
          (y + bounds.minY) * doc.length +
          (z + bounds.minZ);
        voxels[x * height * length + y * length + z] = doc.voxels[source];
      }
    }
  }

  // Block entities and entities travel with their blocks. Anything outside the
  // content box is beside a voxel that is air, so it has nothing to belong to.
  const blockEntities = new Map<string, BlockEntityRecord>();
  for (const record of doc.blockEntities.values()) {
    const x = record.pos[0] - bounds.minX;
    const y = record.pos[1] - bounds.minY;
    const z = record.pos[2] - bounds.minZ;
    if (x < 0 || x >= width || y < 0 || y >= height || z < 0 || z >= length) continue;
    blockEntities.set(posKey(x, y, z), { ...record, pos: [x, y, z] });
  }

  const entities = doc.entities
    .filter((entity) => {
      const x = entity.pos[0] - bounds.minX;
      const y = entity.pos[1] - bounds.minY;
      const z = entity.pos[2] - bounds.minZ;
      return x >= -0.5 && x <= width && y >= -0.5 && y <= height && z >= -0.5 && z <= length;
    })
    .map((entity) => ({
      ...entity,
      pos: [
        entity.pos[0] - bounds.minX,
        entity.pos[1] - bounds.minY,
        entity.pos[2] - bounds.minZ,
      ] as const,
    }));

  return {
    doc: {
      ...doc,
      width,
      height,
      length,
      voxels,
      blockEntities,
      entities,
      // The schematic's world origin moves the *opposite* way to its content,
      // so pasting the file back into the world it came from lands the blocks
      // where they were. Same reasoning as `resizeDocument`'s shift.
      offset: [
        doc.offset[0] + bounds.minX,
        doc.offset[1] + bounds.minY,
        doc.offset[2] + bounds.minZ,
      ],
    },
    summary: { from: documentSize(doc), to: [width, height, length] },
  };
}
