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
import { buildMesh, culledFaces } from "./mesher.js";
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
  const indices = new Uint32Array(indexCount);

  let positionAt = 0;
  let uvAt = 0;
  let indexAt = 0;
  let vertexBase = 0;
  for (const piece of pieces) {
    positions.set(piece.positions, positionAt);
    normals.set(piece.normals, positionAt);
    uvs.set(piece.uvs, uvAt);
    for (let i = 0; i < piece.indices.length; i += 1) {
      indices[indexAt + i] = piece.indices[i] + vertexBase;
    }
    positionAt += piece.positions.length;
    uvAt += piece.uvs.length;
    indexAt += piece.indices.length;
    vertexBase += piece.positions.length / 3;
  }
  return { positions, normals, uvs, indices };
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
    chunks: new Map(),
  };
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
): Promise<ChunkedMeshResult> {
  const width = struct.bounds.maxX - struct.bounds.minX + 1;
  const height = struct.bounds.maxY - struct.bounds.minY + 1;
  const length = struct.bounds.maxZ - struct.bounds.minZ + 1;
  const [nx, ny, nz] = chunkCounts(width, height, length);

  const reusable =
    cache.width === width &&
    cache.height === height &&
    cache.length === length &&
    cache.atlasVersion === atlasVersion &&
    cache.voxels.length === struct.voxels.length;

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
    for (let i = 0; i < current.length; i += 1) {
      if (current[i] !== previous[i]) {
        // The flat layout is x-major: i = x*height*length + y*length + z.
        const x = Math.floor(i / (height * length));
        const rest = i - x * height * length;
        markDirty(dirty, x, Math.floor(rest / length), rest % length, nx, ny, nz);
      }
    }
  }

  const chunks = reusable ? new Map(cache.chunks) : new Map<number, MeshBuffers>();

  for (const key of dirty) {
    const cx = key % nx;
    const cy = Math.floor(key / nx) % ny;
    const cz = Math.floor(key / (nx * ny));
    const faces = await culledFaces(struct, baker, {
      minX: cx * CHUNK_SIZE,
      minY: cy * CHUNK_SIZE,
      minZ: cz * CHUNK_SIZE,
      maxX: cx * CHUNK_SIZE + CHUNK_SIZE - 1,
      maxY: cy * CHUNK_SIZE + CHUNK_SIZE - 1,
      maxZ: cz * CHUNK_SIZE + CHUNK_SIZE - 1,
    });
    const buffers = buildMesh(faces, atlasUv);
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
      chunks,
    },
    rebuilt: dirty.size,
    total: nx * ny * nz,
  };
}
