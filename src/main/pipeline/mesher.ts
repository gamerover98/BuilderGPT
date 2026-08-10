// Ported from app/pipeline/mesher.py.
//
// Voxel-grid face culling + indexed mesh-buffer construction.
//
// RULEBOOK.md §2 "StructureData.voxels flat-array index formula" row:
// x * height * length + y * length + z (row-major over (width, height,
// length), matches numpy C-order storage). This file is one of the named
// consumers that must match loader.ts/types.ts exactly.
// RULEBOOK.md §1 "Async model" row: bakeBlockstate (model_baker.ts) is now
// async per that row, so culledFaces (its caller) is async too and awaits
// it; the rest of this file (pure coordinate/geometry math, buildMesh) stays
// synchronous, matching "pure in-memory computation stays synchronous".
// RULEBOOK.md §1 "Data-object shape"/"Internal keyed-collection type" rows:
// interface + free functions (types.ts), Record<string, T> not Map — no new
// data shapes are introduced in this file, only consumed.
// inventory.tsv row `app/pipeline/mesher.py culled_faces / build_mesh`:
// two Mapping.get() + skip-on-None(undefined) sites, both silent
// (no log) on miss — preserved verbatim below, see comments at each site.

import { occludesNeighbours } from "./block_shapes.js";
import type { BakedFace, MeshBuffers, PaletteEntry, StructureData, UVRect } from "./types.js";
import { bakedFaceOffset, paletteEntryIsAir } from "./types.js";
import type { BakedBlock, ModelBaker } from "./model_baker.js";

/**
 * `_DIRECTIONS` — ported from mesher.py:10-17. 6 face-name -> offset-tuple
 * entries. Record<string, T>, not Map, per RULEBOOK.md §1 "Internal
 * keyed-collection type" row (this file's dictionaries are all
 * string-keyed, no non-string-key or insertion-order need).
 */
const DIRECTIONS: Record<string, readonly [number, number, number]> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
  down: [0, -1, 0],
  up: [0, 1, 0],
};

/**
 * Ported from `culled_faces` (mesher.py:20-53).
 *
 * Async because `baker.bakeBlockstate` (model_baker.ts) is async per
 * RULEBOOK.md §1's async-model row — awaited below, unlike the source's
 * synchronous `baker.bake_blockstate(entry)` call.
 */
export async function culledFaces(struct: StructureData, baker: ModelBaker): Promise<BakedFace[]> {
  const voxels = struct.voxels;
  const [sizeX, sizeY, sizeZ] = [
    struct.bounds.maxX - struct.bounds.minX + 1,
    struct.bounds.maxY - struct.bounds.minY + 1,
    struct.bounds.maxZ - struct.bounds.minZ + 1,
  ];

  // voxels.shape in the source is (width, height, length); StructureData
  // does not carry shape separately from bounds, so size is derived the
  // same way loader.ts/types.ts do (bounds size == voxel array dims).
  const flatIndex = (x: number, y: number, z: number): number =>
    // RULEBOOK.md §2 canonical formula.
    x * sizeY * sizeZ + y * sizeZ + z;

  const faces: BakedFace[] = [];

  function paletteEntry(index: number): PaletteEntry {
    if (index < 0 || index >= struct.palette.length) {
      return { namespacedName: "minecraft:air", properties: {} };
    }
    return struct.palette[index];
  }

  for (let x = 0; x < sizeX; x++) {
    for (let y = 0; y < sizeY; y++) {
      for (let z = 0; z < sizeZ; z++) {
        const paletteIndex = voxels[flatIndex(x, y, z)];
        const entry = paletteEntry(paletteIndex);
        if (paletteEntryIsAir(entry)) {
          continue;
        }
        const bakedBlock: BakedBlock = await baker.bakeBlockstate(entry);

        // Geometry that never participates in culling: every box of a
        // multi-box shape (a staircase's step, a fence's rails) and the two
        // quads of a cross. Their surfaces sit inside the block, where a
        // neighbour cannot cover them.
        for (const face of bakedBlock.extraFaces) {
          faces.push(bakedFaceOffset(face, x, y, z));
        }
        if (!bakedBlock.isFullCube) {
          continue;
        }

        for (const [faceName, offset] of Object.entries(DIRECTIONS)) {
          const [dx, dy, dz] = offset;
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (nx >= 0 && nx < sizeX && ny >= 0 && ny < sizeY && nz >= 0 && nz < sizeZ) {
            const neighbor = paletteEntry(voxels[flatIndex(nx, ny, nz)]);
            // mesher.py asked `is_transparent`, a hardcoded name list. The
            // real question is whether the neighbour *covers* this face, which
            // a slab, a fence or a pane does not however opaque its texture.
            if (occludesNeighbours(neighbor)) {
              continue;
            }
            // A block always hides the identical block next to it, even when
            // both are see-through. This is what keeps a body of water or a
            // wall of glass from meshing every internal face now that neither
            // occludes an opaque neighbour — and it is what the game does.
            if (neighbor.namespacedName === entry.namespacedName) {
              continue;
            }
          }
          // Out of bounds is air, matching mesher.py:47-48.

          // inventory.tsv `culled_faces / build_mesh` row, site 1
          // (mesher.py:49): Mapping.get() + skip-on-None(undefined),
          // silent — a face name missing from the baked block's face map
          // is dropped without any log, preserved as-is.
          const bakedFace = bakedBlock.faces[faceName];
          if (bakedFace === undefined) {
            continue;
          }
          faces.push(bakedFaceOffset(bakedFace, x, y, z));
        }
      }
    }
  }
  return faces;
}

function emptyMeshBuffers(): MeshBuffers {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    indices: new Uint32Array(0),
  };
}

/**
 * Ported from `build_mesh` (mesher.py:56-104). Synchronous — pure in-memory
 * mesh-buffer construction, no I/O, per RULEBOOK.md §1's async-model row.
 */
export function buildMesh(faces: readonly BakedFace[], atlasUv: Record<string, UVRect>): MeshBuffers {
  if (faces.length === 0) {
    return emptyMeshBuffers();
  }

  const positionsChunks: Float32Array[] = [];
  const normalsChunks: Float32Array[] = [];
  const uvsChunks: Float32Array[] = [];
  const indices: number[] = [];

  let vertexOffset = 0;
  // Counter-clockwise winding when looking from the face normal so front
  // faces render — mesher.py:71-72.
  const quadIndices = [0, 2, 1, 0, 3, 2] as const;

  for (const face of faces) {
    // inventory.tsv `culled_faces / build_mesh` row, site 2 (mesher.py:75):
    // Mapping.get() + skip-on-None(undefined), silent — a texture key
    // missing from the atlas UV rects silently drops the face's geometry,
    // no log, preserved as-is.
    const rect = atlasUv[face.textureKey];
    if (rect === undefined) {
      // Skip faces without texture information.
      continue;
    }
    const [u0, v0, u1, v1] = rect;

    const uv = face.uvs.slice();
    for (let i = 0; i < uv.length; i += 2) {
      uv[i] = u0 + (u1 - u0) * uv[i];
      uv[i + 1] = v0 + (v1 - v0) * uv[i + 1];
    }

    positionsChunks.push(face.positions);
    const normalTile = new Float32Array(12);
    for (let v = 0; v < 4; v++) {
      normalTile[v * 3] = face.normal[0];
      normalTile[v * 3 + 1] = face.normal[1];
      normalTile[v * 3 + 2] = face.normal[2];
    }
    normalsChunks.push(normalTile);
    uvsChunks.push(uv);

    for (const qi of quadIndices) {
      indices.push(qi + vertexOffset);
    }
    vertexOffset += 4;
  }

  if (positionsChunks.length === 0) {
    return emptyMeshBuffers();
  }

  return {
    positions: concatFloat32(positionsChunks),
    normals: concatFloat32(normalsChunks),
    uvs: concatFloat32(uvsChunks),
    indices: new Uint32Array(indices),
  };
}

function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// PORT STATUS: confidence=high todos=0
