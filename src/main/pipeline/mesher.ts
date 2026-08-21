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
import {
  cornerOcclusion,
  MAX_LIGHT,
  OCCLUSION_LEVELS,
  type LightGrid,
} from "./lighting.js";

/**
 * What a face should be shaded by, if anything.
 *
 * The two halves are separate settings and separate work: light is a flood
 * fill over the whole grid, occlusion is three lookups per vertex. Either can
 * be off, and `light: null` with `occlusion: true` is a perfectly ordinary
 * combination -- evenly lit, with the corners still reading as corners.
 */
export interface Shading {
  readonly light: LightGrid | null;
  readonly occlusion: boolean;
  /**
   * Whether a vertex takes the average of the four cells that meet at it
   * rather than the one in front of its face.
   *
   * This is the game's "smooth lighting" and it is the same four cells the
   * occlusion already reads, so it costs the lookups and nothing else. Off is
   * flat, per-face light -- which is what vanilla looks like with the setting
   * off, and is perfectly readable; what it loses is the gradient across a
   * floor as a torch's light falls away, which is most of what makes a lit
   * room look lit.
   */
  readonly smooth: boolean;
}

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
export async function culledFaces(
  struct: StructureData,
  baker: ModelBaker,
  /**
   * Restricts which voxels are *visited*, not which are *read*.
   *
   * Neighbour lookups still range over the whole grid, so the faces produced
   * for a sub-region are exactly the ones a full pass would produce for those
   * voxels — which is what lets `chunked_mesh.ts` re-cull one chunk after an
   * edit and keep the rest. Omitted means the whole structure.
   */
  region?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  /**
   * The light in the structure, if it has been worked out.
   *
   * Optional because meshing does not depend on it: without it every face comes
   * out at full daylight with no occlusion, which is what the viewport looked
   * like before there was any such thing. `preview.ts` computes the light grid
   * once per document and hands the same one to every chunk -- light crosses
   * chunk boundaries, so it cannot be a per-chunk job.
   */
  shading?: Shading | null,
): Promise<BakedFace[]> {
  const voxels = struct.voxels;
  const [sizeX, sizeY, sizeZ] = [
    struct.bounds.maxX - struct.bounds.minX + 1,
    struct.bounds.maxY - struct.bounds.minY + 1,
    struct.bounds.maxZ - struct.bounds.minZ + 1,
  ];

  const fromX = region ? Math.max(0, region.minX) : 0;
  const fromY = region ? Math.max(0, region.minY) : 0;
  const fromZ = region ? Math.max(0, region.minZ) : 0;
  const toX = region ? Math.min(sizeX - 1, region.maxX) : sizeX - 1;
  const toY = region ? Math.min(sizeY - 1, region.maxY) : sizeY - 1;
  const toZ = region ? Math.min(sizeZ - 1, region.maxZ) : sizeZ - 1;

  // voxels.shape in the source is (width, height, length); StructureData
  // does not carry shape separately from bounds, so size is derived the
  // same way loader.ts/types.ts do (bounds size == voxel array dims).
  const flatIndex = (x: number, y: number, z: number): number =>
    // RULEBOOK.md §2 canonical formula.
    x * sizeY * sizeZ + y * sizeZ + z;

  const faces: BakedFace[] = [];

  /*
   * Opacity per *palette entry*, not per cell: a structure has a few dozen
   * distinct blocks and millions of cells, and `occludesNeighbours` walks a
   * shape table every time it is asked.
   */
  const opaqueEntry = struct.palette.map(
    (entry) => !paletteEntryIsAir(entry) && occludesNeighbours(entry),
  );

  const inside = (x: number, y: number, z: number): boolean =>
    x >= 0 && y >= 0 && z >= 0 && x < sizeX && y < sizeY && z < sizeZ;

  /** Out of bounds is open sky, which is what makes an outside wall lit. */
  const solidAt = (x: number, y: number, z: number): boolean =>
    inside(x, y, z) ? opaqueEntry[voxels[flatIndex(x, y, z)]] === true : false;

  /**
   * How lit a face is: the cell it looks into.
   *
   * A face is lit by the air in front of it, which is what the game does. Two
   * cases have no air to read -- a face pointing out of the grid, and the
   * inside faces of a shape like a staircase, whose normal points back into
   * its own block. The first is sky, the second takes the brightest of the
   * block's six neighbours, because a step in a lit room is lit even though
   * nothing is directly in front of it.
   */
  const lighting = shading?.light ?? null;

  const lightAt = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
  ): [number, number] => {
    if (!lighting) return [0, MAX_LIGHT];
    const front = [x + nx, y + ny, z + nz] as const;
    if (!inside(front[0], front[1], front[2])) return [0, MAX_LIGHT];
    const frontIndex = flatIndex(front[0], front[1], front[2]);
    if (opaqueEntry[voxels[frontIndex]] !== true) {
      return [lighting.block[frontIndex], lighting.sky[frontIndex]];
    }
    let block = 0;
    let sky = 0;
    for (const [dx, dy, dz] of Object.values(DIRECTIONS)) {
      if (!inside(x + dx, y + dy, z + dz)) continue;
      const index = flatIndex(x + dx, y + dy, z + dz);
      if (opaqueEntry[voxels[index]] === true) continue;
      block = Math.max(block, lighting.block[index]);
      sky = Math.max(sky, lighting.sky[index]);
    }
    return [block, sky];
  };

  /**
   * The twelve numbers a face carries: block light, sky light and occlusion,
   * for each of its four vertices.
   *
   * The light is per face and the occlusion is per vertex, which is the split
   * that makes this cheap and still look right -- flat lighting is what vanilla
   * does with smooth lighting off, and the corner shading is what the eye
   * actually reads as depth.
   *
   * A vertex's three occluding cells are found from which side of the block's
   * centre it sits on, along the two axes the normal does not use. That works
   * for any vertex of any shape; a diagonal normal (a cross quad) has no such
   * axes, and those faces are left unoccluded rather than guessed at.
   */
  const shadeFace = (face: BakedFace, x: number, y: number, z: number): Float32Array | undefined => {
    if (!shading) return undefined;
    const [nx, ny, nz] = face.normal;
    const [blockLight, skyLight] = lightAt(x, y, z, Math.round(nx), Math.round(ny), Math.round(nz));
    const block = blockLight / MAX_LIGHT;
    const sky = skyLight / MAX_LIGHT;

    // The two axes in the face's plane, or none when the normal is diagonal.
    const axis = Math.abs(nx) > 0.9 ? 0 : Math.abs(ny) > 0.9 ? 1 : Math.abs(nz) > 0.9 ? 2 : -1;
    const out = new Float32Array(12);
    for (let v = 0; v < 4; v += 1) {
      let occlusion = 1;
      let vertexBlock = block;
      let vertexSky = sky;
      if (axis !== -1) {
        const local = [
          face.positions[v * 3] - 0.5,
          face.positions[v * 3 + 1] - 0.5,
          face.positions[v * 3 + 2] - 0.5,
        ];
        const step = [Math.round(nx), Math.round(ny), Math.round(nz)];
        const t1 = (axis + 1) % 3;
        const t2 = (axis + 2) % 3;
        const s1 = local[t1] >= 0 ? 1 : -1;
        const s2 = local[t2] >= 0 ? 1 : -1;
        /*
         * The four cells that meet at this corner, on the *outside* of the
         * face: the one it looks into, the two beside it, and the diagonal.
         * They are what both halves below read -- occlusion asks whether they
         * are solid and smooth lighting averages how bright they are, which is
         * why the two settings cost the same lookups.
         */
        const corner = (a: number, b: number): [number, number, number] => {
          const at = [x + step[0], y + step[1], z + step[2]];
          at[t1] += a;
          at[t2] += b;
          return [at[0], at[1], at[2]];
        };
        const cells: [number, number, number][] = [
          corner(0, 0),
          corner(s1, 0),
          corner(0, s2),
          corner(s1, s2),
        ];

        if (shading.occlusion) {
          occlusion =
            OCCLUSION_LEVELS[
              cornerOcclusion(
                solidAt(...cells[1]),
                solidAt(...cells[2]),
                solidAt(...cells[3]),
              )
            ];
        }

        if (shading.smooth && lighting) {
          /*
           * Solid cells are skipped rather than counted as dark. A torch on a
           * floor lights the wall beside it, and averaging in the wall's own
           * unlit interior would put a dark seam along every corner in the
           * build -- which is exactly what occlusion is already there to say,
           * more honestly.
           */
          let blockSum = 0;
          let skySum = 0;
          let counted = 0;
          for (const [cx, cy, cz] of cells) {
            if (!inside(cx, cy, cz)) {
              // Outside the grid is open sky, the same answer `lightAt` gives.
              skySum += MAX_LIGHT;
              counted += 1;
              continue;
            }
            const index = flatIndex(cx, cy, cz);
            if (opaqueEntry[voxels[index]] === true) continue;
            blockSum += lighting.block[index];
            skySum += lighting.sky[index];
            counted += 1;
          }
          if (counted > 0) {
            vertexBlock = blockSum / counted / MAX_LIGHT;
            vertexSky = skySum / counted / MAX_LIGHT;
          }
        }
      }
      out[v * 3] = vertexBlock;
      out[v * 3 + 1] = vertexSky;
      out[v * 3 + 2] = occlusion;
    }
    return out;
  };

  function paletteEntry(index: number): PaletteEntry {
    if (index < 0 || index >= struct.palette.length) {
      return { namespacedName: "minecraft:air", properties: {} };
    }
    return struct.palette[index];
  }

  for (let x = fromX; x <= toX; x++) {
    for (let y = fromY; y <= toY; y++) {
      for (let z = fromZ; z <= toZ; z++) {
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
          faces.push(bakedFaceOffset(face, x, y, z, shadeFace(face, x, y, z)));
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
          faces.push(bakedFaceOffset(bakedFace, x, y, z, shadeFace(bakedFace, x, y, z)));
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
    light: new Float32Array(0),
  };
}

/**
 * What a vertex looks like with nothing known about where it is: full daylight,
 * no torch, no occlusion.
 *
 * The default matters. A face meshed without a light grid -- a block icon, a
 * test, anything built before this existed -- has to come out looking exactly
 * as it did, and this is the triple that means "unshaded".
 */
const UNSHADED = [0, 1, 1] as const;

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
  const lightChunks: Float32Array[] = [];
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

    if (face.shade !== undefined) {
      lightChunks.push(face.shade);
    } else {
      const flat = new Float32Array(12);
      for (let v = 0; v < 4; v += 1) {
        flat[v * 3] = UNSHADED[0];
        flat[v * 3 + 1] = UNSHADED[1];
        flat[v * 3 + 2] = UNSHADED[2];
      }
      lightChunks.push(flat);
    }

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
    light: concatFloat32(lightChunks),
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
