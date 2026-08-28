/**
 * Meshing a document one chunk at a time, and re-meshing only what changed.
 *
 * Rebuilding the whole structure after every edit is what the app did, and it
 * is fine at the size of a house — measured, 167 ms — and slow at the size of a
 * castle: 1.5 s for a 256x64x256, of which culling alone is 1.1 s. Placing one
 * block should not cost that.
 *
 * The structure is cut into 16-block cubes, each meshed independently and
 * cached. A rebuild re-meshes only the chunks whose contents moved and
 * concatenates the rest.
 *
 * ## Which chunks are dirty is *observed*, not announced
 *
 * The cache keeps a snapshot of the voxel grid and diffs it. No caller has to
 * remember to report an edit, which matters because there are several ways to
 * make one — the panel, the crosshair, the agent's tools, an undo — and a
 * notification missed at any of them would render a stale chunk with no clue
 * as to why. Comparing two typed arrays of four million entries costs a few
 * milliseconds; being wrong costs a bug nobody can reproduce.
 *
 * ## A changed block dirties its neighbours' chunks too
 *
 * Whether a face is drawn depends on the block next to it, so a block on a
 * chunk boundary changes what the chunk across that boundary should draw.
 * Every changed voxel therefore dirties its own chunk and those of its six
 * face-neighbours.
 *
 * ## What invalidates everything
 *
 * The dimensions changing (a resize renumbers every index) and the atlas
 * changing (cached UVs address the old layout). The palette growing does not:
 * it is append-only, so an index cached earlier still means the same block.
 */

import type { MeshBuffers, StructureData } from "./types.js";
import type { LightGrid } from "./lighting.js";
import type { Shading } from "./mesher.js";
import { buildMesh, culledFaces } from "./mesher.js";
import { signDigest, type SignText } from "./sign_text.js";
import type { ModelBaker } from "./model_baker.js";
import type { UVRect } from "./types.js";

export const CHUNK_SIZE = 16;

export interface ChunkMeshCache {
  width: number;
  height: number;
  length: number;
  /** Bumped by the caller whenever the atlas is rebuilt; see the note above. */
  atlasVersion: number;
  /** The grid as it was when the cached chunks were built. */
  voxels: Int32Array;
  /**
   * The light as it was, for the same reason: a torch changes what a chunk
   * looks like fifteen blocks away without changing a single voxel there.
   *
   * Diffed exactly like the voxels are, which keeps the rule the same one --
   * dirtiness is *observed*, not announced. A caller that had to remember to
   * say "and light spread this far" would forget, and the chunk that stayed
   * dark would be a bug nobody could reproduce.
   */
  light: Uint8Array;
  /**
   * What each sign said, by flat voxel index, as `signDigest` renders it.
   *
   * The same rule again, and the third thing it has caught: a sign's text is
   * neither a voxel nor a photon, so retyping one moved nothing either array
   * compares and the chunk stayed as it was -- the old words on screen and the
   * new ones in the file. Digests rather than the text because this is only
   * ever compared, and a map with one entry per sign is nothing beside a grid
   * with one per cell.
   */
  signs: Map<number, string>;
  /** Chunk key -> that chunk's geometry. */
  chunks: Map<number, MeshBuffers>;
}

export interface ChunkedMeshResult {
  buffers: MeshBuffers;
  /**
   * The same geometry, still separated by chunk.
   *
   * The renderer draws one mesh per chunk rather than one fused mesh, so it
   * gets per-chunk frustum culling for nothing, and a later change can send
   * only the chunks that moved.
   */
  pieces: MeshBuffers[];
  /**
   * The chunk key of each entry in `pieces`, in the same order.
   *
   * Carried so a payload can name what it is replacing. Without it the only
   * thing a caller can do with a changed chunk is send every chunk, which is
   * what an edit used to cost.
   */
  pieceKeys: number[];
  cache: ChunkMeshCache;
  /** How many chunks had to be re-meshed, and how many there are. */
  rebuilt: number;
  total: number;
}

function chunkCounts(width: number, height: number, length: number): [number, number, number] {
  return [
    Math.ceil(width / CHUNK_SIZE),
    Math.ceil(height / CHUNK_SIZE),
    Math.ceil(length / CHUNK_SIZE),
  ];
}

/** Chunk coordinates packed into one number, so the map can key on a primitive. */
function chunkKey(cx: number, cy: number, cz: number, nx: number, ny: number): number {
  return cx + nx * (cy + ny * cz);
}

function emptyBuffers(): MeshBuffers {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    indices: new Uint32Array(0),
    light: new Float32Array(0),
    opaqueIndices: 0,
  };
}

/**
 * Joins chunk geometry into one mesh.
 *
 * Indices are per-chunk — each chunk numbers its vertices from zero — so they
 * are shifted by the running vertex count as they are copied. That shift is the
 * only per-element work here; everything else is `set`, which is a memcpy.
 */
function concatChunks(pieces: readonly MeshBuffers[]): MeshBuffers {
  let positionCount = 0;
  let uvCount = 0;
  let indexCount = 0;
  for (const piece of pieces) {
    positionCount += piece.positions.length;
    uvCount += piece.uvs.length;
    indexCount += piece.indices.length;
  }
  if (indexCount === 0) {
    return emptyBuffers();
  }

  const positions = new Float32Array(positionCount);
  const normals = new Float32Array(positionCount);
  const uvs = new Float32Array(uvCount);
  const light = new Float32Array(positionCount);
  const indices = new Uint32Array(indexCount);

  /*
   * The vertices concatenate straight through; the indices do not.
   *
   * Every piece keeps its opaque indices in front of its translucent ones, and
   * the joined buffer has to hold the same shape — all the opaque ones, then
   * all the translucent ones — or the single number that says where the split
   * is would be a lie about the middle of the array. So the indices are copied
   * in two passes over the same pieces.
   */
  let opaqueTotal = 0;
  for (const piece of pieces) opaqueTotal += piece.opaqueIndices;

  let positionAt = 0;
  let uvAt = 0;
  let opaqueAt = 0;
  let translucentAt = opaqueTotal;
  let vertexBase = 0;
  for (const piece of pieces) {
    positions.set(piece.positions, positionAt);
    normals.set(piece.normals, positionAt);
    light.set(piece.light, positionAt);
    uvs.set(piece.uvs, uvAt);
    for (let i = 0; i < piece.indices.length; i += 1) {
      const shifted = piece.indices[i] + vertexBase;
      if (i < piece.opaqueIndices) {
        indices[opaqueAt] = shifted;
        opaqueAt += 1;
      } else {
        indices[translucentAt] = shifted;
        translucentAt += 1;
      }
    }
    positionAt += piece.positions.length;
    uvAt += piece.uvs.length;
    vertexBase += piece.positions.length / 3;
  }
  return { positions, normals, uvs, indices, light, opaqueIndices: opaqueTotal };
}

/** The chunks a changed voxel invalidates: its own, and its face-neighbours'. */
function markDirty(
  dirty: Set<number>,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
): void {
  for (const [dx, dy, dz] of [
    [0, 0, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ]) {
    const cx = Math.floor((x + dx) / CHUNK_SIZE);
    const cy = Math.floor((y + dy) / CHUNK_SIZE);
    const cz = Math.floor((z + dz) / CHUNK_SIZE);
    if (cx < 0 || cy < 0 || cz < 0 || cx >= nx || cy >= ny || cz >= nz) {
      continue;
    }
    dirty.add(chunkKey(cx, cy, cz, nx, ny));
  }
}

export function createChunkMeshCache(): ChunkMeshCache {
  return {
    width: -1,
    height: -1,
    length: -1,
    atlasVersion: -1,
    voxels: new Int32Array(0),
    light: new Uint8Array(0),
    signs: new Map(),
    chunks: new Map(),
  };
}

/**
 * The two light grids packed into one byte per cell, for diffing.
 *
 * Sky in the high nibble and block in the low one. A single array to compare
 * rather than two, and the comparison is the whole reason it exists -- the
 * values themselves are read from the `LightGrid` where they are separate.
 */
function packLight(lighting: LightGrid | null, cells: number): Uint8Array {
  const packed = new Uint8Array(cells);
  if (lighting === null) return packed;
  for (let i = 0; i < cells; i += 1) {
    packed[i] = (lighting.sky[i] << 4) | lighting.block[i];
  }
  return packed;
}

/**
 * Meshes the structure, reusing whatever the cache still holds good.
 *
 * The returned cache replaces the one passed in. Passing a fresh cache — or one
 * whose dimensions or atlas version no longer match — meshes everything, which
 * is also what happens the first time.
 */
export async function buildChunkedMesh(
  struct: StructureData,
  baker: ModelBaker,
  atlasUv: Record<string, UVRect>,
  atlasVersion: number,
  cache: ChunkMeshCache,
  shading: Shading | null = null,
  signs: ReadonlyMap<number, SignText> | null = null,
): Promise<ChunkedMeshResult> {
  const width = struct.bounds.maxX - struct.bounds.minX + 1;
  const height = struct.bounds.maxY - struct.bounds.minY + 1;
  const length = struct.bounds.maxZ - struct.bounds.minZ + 1;
  const [nx, ny, nz] = chunkCounts(width, height, length);

  const light = packLight(shading?.light ?? null, struct.voxels.length);
  const reusable =
    cache.width === width &&
    cache.height === height &&
    cache.length === length &&
    cache.atlasVersion === atlasVersion &&
    cache.voxels.length === struct.voxels.length &&
    cache.light.length === light.length;

  const dirty = new Set<number>();
  if (!reusable) {
    for (let cz = 0; cz < nz; cz += 1) {
      for (let cy = 0; cy < ny; cy += 1) {
        for (let cx = 0; cx < nx; cx += 1) {
          dirty.add(chunkKey(cx, cy, cz, nx, ny));
        }
      }
    }
  } else {
    const previous = cache.voxels;
    const current = struct.voxels;
    const wasLit = cache.light;
    for (let i = 0; i < current.length; i += 1) {
      if (current[i] !== previous[i] || light[i] !== wasLit[i]) {
        // The flat layout is x-major: i = x*height*length + y*length + z.
        const x = Math.floor(i / (height * length));
        const rest = i - x * height * length;
        markDirty(dirty, x, Math.floor(rest / length), rest % length, nx, ny, nz);
      }
    }
  }

  /*
   * The signs, diffed the same way and marking only their own chunk.
   *
   * `markDirty` spreads to the face-neighbours because light does; text does
   * not leave the block it is written on, so spreading here would re-mesh six
   * chunks to redraw one word.
   */
  const written = new Map<number, string>();
  if (signs !== null) {
    for (const [at, text] of signs) written.set(at, signDigest(text));
  }
  if (reusable) {
    for (const at of new Set([...written.keys(), ...cache.signs.keys()])) {
      if (written.get(at) === cache.signs.get(at)) continue;
      const x = Math.floor(at / (height * length));
      const rest = at - x * height * length;
      const cx = Math.floor(x / CHUNK_SIZE);
      const cy = Math.floor(Math.floor(rest / length) / CHUNK_SIZE);
      const cz = Math.floor((rest % length) / CHUNK_SIZE);
      if (cx < nx && cy < ny && cz < nz) dirty.add(chunkKey(cx, cy, cz, nx, ny));
    }
  }

  const chunks = reusable ? new Map(cache.chunks) : new Map<number, MeshBuffers>();

  for (const key of dirty) {
    const cx = key % nx;
    const cy = Math.floor(key / nx) % ny;
    const cz = Math.floor(key / (nx * ny));
    const faces = await culledFaces(
      struct,
      baker,
      {
        minX: cx * CHUNK_SIZE,
        minY: cy * CHUNK_SIZE,
        minZ: cz * CHUNK_SIZE,
        maxX: cx * CHUNK_SIZE + CHUNK_SIZE - 1,
        maxY: cy * CHUNK_SIZE + CHUNK_SIZE - 1,
        maxZ: cz * CHUNK_SIZE + CHUNK_SIZE - 1,
      },
      shading,
      signs ?? undefined,
    );
    const buffers = buildMesh(faces, atlasUv, (key) => baker.isTextureTranslucent(key));
    if (buffers.indices.length === 0) {
      // An all-air chunk holds nothing; dropping it keeps the concatenation
      // short rather than walking thousands of empty entries.
      chunks.delete(key);
    } else {
      chunks.set(key, buffers);
    }
  }

  // Concatenated in a fixed chunk order so the same document always produces
  // the same bytes, however it was reached — which is what makes an
  // incremental build comparable to a rebuilt-from-scratch one.
  const ordered: MeshBuffers[] = [];
  const orderedKeys: number[] = [];
  for (let cz = 0; cz < nz; cz += 1) {
    for (let cy = 0; cy < ny; cy += 1) {
      for (let cx = 0; cx < nx; cx += 1) {
        const key = chunkKey(cx, cy, cz, nx, ny);
        const piece = chunks.get(key);
        if (piece) {
          ordered.push(piece);
          orderedKeys.push(key);
        }
      }
    }
  }

  return {
    buffers: concatChunks(ordered),
    pieces: ordered,
    pieceKeys: orderedKeys,
    cache: {
      width,
      height,
      length,
      atlasVersion,
      // A copy, not the document's own array: the document keeps mutating it,
      // and a shared reference would compare equal to itself and see no change.
      voxels: Int32Array.from(struct.voxels),
      light,
      signs: written,
      chunks,
    },
    rebuilt: dirty.size,
    total: nx * ny * nz,
  };
}
