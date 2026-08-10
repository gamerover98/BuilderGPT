/**
 * `SchematicDocument` — the schematic being worked on, in memory and mutable.
 *
 * The app had no such thing. It had two representations that never met: the
 * writer's sparse `Map<"x,y,z", string>`, which only knows how to be appended
 * to, and the loader's dense read-only `StructureData`, which only knows how to
 * be meshed. Generation produced a file; preview consumed a file; the file on
 * disk was the only shared state. Selection, undo, incremental edit, autosave
 * and dirty state all need one object to hang off, and this is it.
 *
 * It takes the dense shape rather than the sparse one for three reasons: the
 * mesher already consumes exactly that layout, so `toStructureData` is a view
 * rather than a conversion; get and set are O(1), which is what region
 * operations need; and the flat index is the natural key for a delta-based
 * history.
 *
 * ## Invariants
 *
 * - **Palette index 0 is always air.** Same guarantee `SpongeSchematicWriter`
 *   relies on, so an unset voxel needs no explicit write.
 * - **The palette is append-only while editing.** Clearing an entry that fell
 *   out of use would renumber the ones after it, and every delta already
 *   recorded in the undo stack refers to the old numbers. Reclaiming is a
 *   save-time concern -- see `compactPalette`.
 * - **`revision` increases on every mutation.** `savedRevision` records the one
 *   that was last written to disk, so dirtiness is a comparison rather than a
 *   flag somebody has to remember to set.
 *
 * Interface plus free functions, not a class: RULEBOOK.md §1's "Data-object
 * shape" row, and the same reason it gives -- plain objects survive the
 * structured-clone IPC boundary, objects with methods do not.
 */

import type { SchematicFormat } from "../pipeline/loader_formats.js";
import type { LoadedStructure } from "../pipeline/loader.js";
import {
  paletteEntryCacheKey,
  paletteEntryIsAir,
  type BlockEntityRecord,
  type EntityRecord,
  type PaletteEntry,
  type StructureBounds,
  type StructureData,
} from "../pipeline/types.js";

export const AIR: PaletteEntry = { namespacedName: "minecraft:air", properties: {} };

export interface SchematicDocument {
  width: number;
  height: number;
  length: number;
  /** Palette indices, row-major over (width, height, length) — the same flat
   * order `StructureData.voxels` documents, since the mesher reads this array
   * directly. */
  voxels: Int32Array;
  /** Index 0 is air; append-only during editing. */
  palette: PaletteEntry[];
  /** `paletteEntryCacheKey` -> index into `palette`. */
  paletteIndex: Map<string, number>;
  /** Keyed by `posKey`, so replacing a block can find what it displaces. */
  blockEntities: Map<string, BlockEntityRecord>;
  entities: EntityRecord[];
  /** The container this was read from, and the one a plain save writes back. */
  format: SchematicFormat;
  dataVersion: number | null;
  /** Where the schematic sat in the world it was cut from. */
  offset: [number, number, number];
  /** `null` until it has been saved somewhere. */
  filePath: string | null;
  revision: number;
  savedRevision: number;
}

/** The key both `core.ts` and `services/schematic.ts` already use. */
export function posKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export function documentSize(doc: SchematicDocument): [number, number, number] {
  return [doc.width, doc.height, doc.length];
}

export function documentBounds(doc: SchematicDocument): StructureBounds {
  return {
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: doc.width - 1,
    maxY: doc.height - 1,
    maxZ: doc.length - 1,
  };
}

export function inBounds(doc: SchematicDocument, x: number, y: number, z: number): boolean {
  return x >= 0 && x < doc.width && y >= 0 && y < doc.height && z >= 0 && z < doc.length;
}

/** Flat index, or `-1` when the coordinate is outside the document. */
export function voxelIndex(doc: SchematicDocument, x: number, y: number, z: number): number {
  if (!inBounds(doc, x, y, z)) {
    return -1;
  }
  return x * doc.height * doc.length + y * doc.length + z;
}

export function isDirty(doc: SchematicDocument): boolean {
  return doc.revision !== doc.savedRevision;
}

/** Marks the current state as the one on disk. */
export function markSaved(doc: SchematicDocument, filePath: string): void {
  doc.filePath = filePath;
  doc.savedRevision = doc.revision;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface CreateDocumentOptions {
  width: number;
  height: number;
  length: number;
  format?: SchematicFormat;
  dataVersion?: number | null;
}

/** An empty document, all air. */
export function createDocument(options: CreateDocumentOptions): SchematicDocument {
  const { width, height, length } = options;
  if (width < 1 || height < 1 || length < 1) {
    throw new Error(`A schematic must be at least 1x1x1, got ${width}x${height}x${length}`);
  }
  return {
    width,
    height,
    length,
    voxels: new Int32Array(width * height * length),
    palette: [AIR],
    paletteIndex: new Map([[paletteEntryCacheKey(AIR), 0]]),
    blockEntities: new Map(),
    entities: [],
    format: options.format ?? "sponge3",
    dataVersion: options.dataVersion ?? null,
    offset: [0, 0, 0],
    filePath: null,
    revision: 0,
    savedRevision: 0,
  };
}

/**
 * Adopts what `loadStructure` produced.
 *
 * The loader's palette may not start with air -- nothing requires it to -- so
 * the palette is rebuilt through `internPalette` and the voxels remapped. That
 * costs one pass over the grid and buys the index-0-is-air invariant every
 * other function here leans on.
 */
export function documentFromLoaded(
  loaded: LoadedStructure,
  filePath: string | null = null,
): SchematicDocument {
  const width = loaded.bounds.maxX - loaded.bounds.minX + 1;
  const height = loaded.bounds.maxY - loaded.bounds.minY + 1;
  const length = loaded.bounds.maxZ - loaded.bounds.minZ + 1;

  const doc = createDocument({
    width,
    height,
    length,
    format: loaded.format,
    dataVersion: loaded.dataVersion,
  });

  const remap = loaded.palette.map((entry) =>
    paletteEntryIsAir(entry) ? 0 : internPalette(doc, entry),
  );
  for (let i = 0; i < doc.voxels.length && i < loaded.voxels.length; i += 1) {
    doc.voxels[i] = remap[loaded.voxels[i]] ?? 0;
  }

  for (const record of loaded.blockEntities) {
    doc.blockEntities.set(posKey(record.pos[0], record.pos[1], record.pos[2]), record);
  }
  doc.entities = [...loaded.entities];
  doc.offset = [loaded.offset[0], loaded.offset[1], loaded.offset[2]];
  doc.filePath = filePath;
  // Freshly loaded is not modified, whatever the remapping above did.
  doc.revision = 0;
  doc.savedRevision = 0;
  return doc;
}

/**
 * The read-only view the existing pipeline takes.
 *
 * The arrays are shared, not copied: a schematic is millions of voxels and the
 * mesher only reads. `StructureData`'s `readonly` fields are what makes that
 * safe to hand out.
 */
export function toStructureData(doc: SchematicDocument): StructureData {
  return { bounds: documentBounds(doc), palette: doc.palette, voxels: doc.voxels };
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** The index for an entry, adding it to the palette if it is new. */
export function internPalette(doc: SchematicDocument, entry: PaletteEntry): number {
  const key = paletteEntryCacheKey(entry);
  const existing = doc.paletteIndex.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const index = doc.palette.length;
  doc.palette.push(entry);
  doc.paletteIndex.set(key, index);
  return index;
}

/** How many voxels carry each palette entry, keyed by `paletteEntryCacheKey`. */
export function paletteHistogram(doc: SchematicDocument): Map<string, number> {
  const counts = new Int32Array(doc.palette.length);
  for (const index of doc.voxels) {
    if (index >= 0 && index < counts.length) {
      counts[index] += 1;
    }
  }
  const out = new Map<string, number>();
  doc.palette.forEach((entry, index) => {
    if (counts[index] > 0) {
      out.set(paletteEntryCacheKey(entry), counts[index]);
    }
  });
  return out;
}

/**
 * Drops palette entries no voxel refers to and renumbers the rest.
 *
 * Only safe when nothing holds an index across the call -- which means at save
 * time, not during editing, because the undo stack is full of them. See the
 * append-only invariant at the top.
 */
export function compactPalette(doc: SchematicDocument): void {
  const used = new Uint8Array(doc.palette.length);
  for (const index of doc.voxels) {
    if (index >= 0 && index < used.length) {
      used[index] = 1;
    }
  }
  used[0] = 1; // air stays, so index 0 keeps its meaning

  const remap = new Int32Array(doc.palette.length);
  const next: PaletteEntry[] = [];
  for (let i = 0; i < doc.palette.length; i += 1) {
    if (used[i] === 1) {
      remap[i] = next.length;
      next.push(doc.palette[i]);
    }
  }
  if (next.length === doc.palette.length) {
    return;
  }
  for (let i = 0; i < doc.voxels.length; i += 1) {
    doc.voxels[i] = remap[doc.voxels[i]] ?? 0;
  }
  doc.palette = next;
  doc.paletteIndex = new Map(next.map((entry, index) => [paletteEntryCacheKey(entry), index]));
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export function getBlock(doc: SchematicDocument, x: number, y: number, z: number): PaletteEntry {
  const index = voxelIndex(doc, x, y, z);
  // Outside the document is air, matching how the mesher treats out of bounds.
  return index === -1 ? AIR : (doc.palette[doc.voxels[index]] ?? AIR);
}

export function getBlockEntity(
  doc: SchematicDocument,
  x: number,
  y: number,
  z: number,
): BlockEntityRecord | null {
  return doc.blockEntities.get(posKey(x, y, z)) ?? null;
}

/** What a `setBlock` displaced, or `null` when it changed nothing. */
export interface BlockChange {
  /** Flat voxel index, the key a history delta is recorded against. */
  readonly index: number;
  readonly before: number;
  readonly after: number;
  /**
   * The block entity that stood there, if any. Replacing a chest with stone
   * must take the chest's contents with it -- and an undo must be able to put
   * them back, which is why they leave through the return value rather than
   * being quietly discarded.
   */
  readonly beforeEntity: BlockEntityRecord | null;
}

/**
 * Writes one block. Returns what it displaced, or `null` if the voxel already
 * held that block and carried no block entity to clear.
 *
 * Out-of-bounds writes are refused rather than silently dropped or coerced:
 * growing the document is `resizeDocument`'s job, and a caller that meant to
 * grow it should say so.
 */
export function setBlock(
  doc: SchematicDocument,
  x: number,
  y: number,
  z: number,
  entry: PaletteEntry,
): BlockChange | null {
  const index = voxelIndex(doc, x, y, z);
  if (index === -1) {
    return null;
  }
  const after = internPalette(doc, entry);
  const before = doc.voxels[index];
  const key = posKey(x, y, z);
  const beforeEntity = doc.blockEntities.get(key) ?? null;
  if (before === after && beforeEntity === null) {
    return null;
  }
  doc.voxels[index] = after;
  if (beforeEntity !== null) {
    doc.blockEntities.delete(key);
  }
  doc.revision += 1;
  return { index, before, after, beforeEntity };
}

/** Attaches (or with `null`, removes) the block entity at a position. */
export function setBlockEntity(
  doc: SchematicDocument,
  x: number,
  y: number,
  z: number,
  record: BlockEntityRecord | null,
): void {
  const key = posKey(x, y, z);
  if (record === null) {
    doc.blockEntities.delete(key);
  } else {
    doc.blockEntities.set(key, record);
  }
  doc.revision += 1;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Region {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/** A region with its corners sorted and clipped to the document. */
export function normalizeRegion(doc: SchematicDocument, region: Region): Region {
  const clamp = (value: number, limit: number) => Math.max(0, Math.min(limit - 1, Math.trunc(value)));
  return {
    minX: clamp(Math.min(region.minX, region.maxX), doc.width),
    minY: clamp(Math.min(region.minY, region.maxY), doc.height),
    minZ: clamp(Math.min(region.minZ, region.maxZ), doc.length),
    maxX: clamp(Math.max(region.minX, region.maxX), doc.width),
    maxY: clamp(Math.max(region.minY, region.maxY), doc.height),
    maxZ: clamp(Math.max(region.minZ, region.maxZ), doc.length),
  };
}

export function regionVolume(region: Region): number {
  return (
    (region.maxX - region.minX + 1) *
    (region.maxY - region.minY + 1) *
    (region.maxZ - region.minZ + 1)
  );
}

/**
 * Grows or shrinks the document, keeping existing blocks at the same
 * coordinates plus `shift`.
 *
 * This is what "make the tower twenty blocks taller" needs: the blocks do not
 * move, the box around them gets bigger. A negative `shift` component moves the
 * content the other way, which is how growth on the low side is expressed --
 * the grid has no negative coordinates.
 *
 * The palette is carried over untouched so indices already recorded in the undo
 * stack stay valid.
 */
export function resizeDocument(
  doc: SchematicDocument,
  size: { width: number; height: number; length: number },
  shift: readonly [number, number, number] = [0, 0, 0],
): void {
  const { width, height, length } = size;
  if (width < 1 || height < 1 || length < 1) {
    throw new Error(`A schematic must be at least 1x1x1, got ${width}x${height}x${length}`);
  }
  const next = new Int32Array(width * height * length);
  const [dx, dy, dz] = shift;

  for (let x = 0; x < doc.width; x += 1) {
    const nx = x + dx;
    if (nx < 0 || nx >= width) continue;
    for (let y = 0; y < doc.height; y += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let z = 0; z < doc.length; z += 1) {
        const nz = z + dz;
        if (nz < 0 || nz >= length) continue;
        next[nx * height * length + ny * length + nz] =
          doc.voxels[x * doc.height * doc.length + y * doc.length + z];
      }
    }
  }

  // Block entities move with their blocks, and any that fell outside the new
  // box go with them -- leaving them behind would strand a chest's contents at
  // a position that no longer exists.
  const movedEntities = new Map<string, BlockEntityRecord>();
  for (const record of doc.blockEntities.values()) {
    const nx = record.pos[0] + dx;
    const ny = record.pos[1] + dy;
    const nz = record.pos[2] + dz;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) {
      continue;
    }
    movedEntities.set(posKey(nx, ny, nz), { ...record, pos: [nx, ny, nz] });
  }

  doc.voxels = next;
  doc.width = width;
  doc.height = height;
  doc.length = length;
  doc.blockEntities = movedEntities;
  doc.entities = doc.entities.map((entity) => ({
    ...entity,
    pos: [entity.pos[0] + dx, entity.pos[1] + dy, entity.pos[2] + dz] as const,
  }));
  // The schematic's world origin moves the opposite way, so the content stays
  // where it was in the world it came from.
  doc.offset = [doc.offset[0] - dx, doc.offset[1] - dy, doc.offset[2] - dz];
  doc.revision += 1;
}

/** Non-air voxels. */
export function countBlocks(doc: SchematicDocument): number {
  let count = 0;
  for (const index of doc.voxels) {
    if (index !== 0) {
      count += 1;
    }
  }
  return count;
}
