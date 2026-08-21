// Ported from app/pipeline/loader.py.
//
// Async model: RULEBOOK.md §1 "Async model" row — this file's only I/O
// boundary (reading the .schem file off disk) is async/await via
// `fs/promises`; the decode loops themselves stay synchronous internally.
//
// Standard library I/O: RULEBOOK.md §1 "Standard library I/O" row —
// `fs.readFile` + catch-ENOENT-rethrow-else, never a pre-check
// existsSync/statSync (TOCTOU race).
//
// NBT parsing: RULEBOOK.md §1 "Third-party deps" row names `prismarine-nbt`
// directly. Replaces loader.py:10-23's `try: import nbtlib except ImportError`
// optional-dependency guard — bundled as a hard dependency, no runtime-optional
// path.
//
// Container formats live in `loader_formats.ts`. `loader.py` only ever read
// Sponge v2 because the Python app only read files it had written itself; the
// desktop app has a file picker, so it also meets Sponge v3 (WorldEdit 7.3+,
// FAWE) and legacy MCEdit `.schematic`.
import { readFile } from "fs/promises";
import { parse as parseNbt } from "prismarine-nbt";

import {
  decodeSchematic,
  loadLegacyBlockTable,
  type LegacyBlockTable,
  type NbtCompound,
  type SchematicFormat,
} from "./loader_formats.js";
import type {
  BlockEntityRecord,
  EntityRecord,
  StructureBounds,
  StructureData,
} from "./types.js";

export { SchematicFormatError } from "./loader_formats.js";

export interface LoadStructureOptions {
  /**
   * Path to the vendored `legacy_blocks.json`. Required only for MCEdit files.
   * Passed in rather than resolved here because this module must stay free of
   * Electron imports — `services/resources.ts` owns the packaged-vs-dev lookup.
   */
  legacyBlocksPath?: string | null;
}

/** What was read, beyond the voxels themselves. */
export interface LoadedStructure extends StructureData {
  readonly format: SchematicFormat;
  /** MCEdit only: `id:meta` pairs the flattening table had no entry for. */
  readonly unmappedLegacyIds: readonly string[];
  /** Chest contents, sign text and the like, verbatim. */
  readonly blockEntities: readonly BlockEntityRecord[];
  /** Mobs and item frames stored with the schematic, verbatim. */
  readonly entities: readonly EntityRecord[];
  /** The schematic's origin in the world it was cut from. */
  readonly offset: readonly [number, number, number] | null;
  /** WorldEdit's Origin, or `null` when the file named none. Not `offset`. */
  readonly worldOrigin: readonly [number, number, number] | null;
  /** The file's own `Metadata`, minus the Origin lifted out of it. */
  readonly metadata: NbtCompound;
  /** The file's declared `DataVersion`; `null` for MCEdit, which has none. */
  readonly dataVersion: number | null;
}

/**
 * Load a schematic structure from disk.
 *
 * Ported from `load_structure` (loader.py:108-168), widened to the three
 * container formats a user can realistically pick from their own disk.
 */
export async function loadStructure(
  inputPath: string,
  options: LoadStructureOptions = {},
): Promise<LoadedStructure> {
  let buffer: Buffer;
  try {
    buffer = await readFile(inputPath);
  } catch (err: unknown) {
    // RULEBOOK.md §1 "Standard library I/O" row: catch-ENOENT-rethrow-else
    // pattern, never a pre-check existsSync/statSync.
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") {
      throw new Error(`Schematic file not found: ${inputPath}`);
    }
    throw err;
  }

  const { parsed } = await parseNbt(buffer);

  // The table is loaded eagerly when a path is given: `decodeSchematic` is
  // synchronous, and making it async purely for a file that is usually not
  // needed would push the await into every decoder.
  let legacyTable: LegacyBlockTable | null = null;
  if (options.legacyBlocksPath) {
    legacyTable = await loadLegacyBlockTable(options.legacyBlocksPath);
  }

  const decoded = decodeSchematic(parsed.value as unknown as NbtCompound, legacyTable);
  const { width, height, length } = decoded;

  // Flat-index formula per RULEBOOK.md §2 "StructureData.voxels flat-array
  // index formula" row: x * height * length + y * length + z (row-major
  // over (width, height, length), matching numpy's C-order storage that
  // the source relies on).
  //
  // The source index is YZX for all three formats, so this loop is
  // format-independent — see `DecodedSchematic.indices`.
  const totalBlocks = width * height * length;
  const voxels = new Int32Array(totalBlocks);
  const limit = Math.min(decoded.indices.length, totalBlocks);
  for (let i = 0; i < limit; i += 1) {
    const x = i % width;
    const z = Math.floor(i / width) % length;
    const y = Math.floor(i / (width * length));
    voxels[x * height * length + y * length + z] = decoded.indices[i];
  }

  const bounds: StructureBounds = {
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: width - 1,
    maxY: height - 1,
    maxZ: length - 1,
  };

  return {
    bounds,
    palette: decoded.palette as StructureData["palette"],
    voxels,
    format: decoded.format,
    unmappedLegacyIds: decoded.unmappedLegacyIds,
    blockEntities: decoded.blockEntities,
    entities: decoded.entities,
    offset: decoded.offset,
    worldOrigin: decoded.worldOrigin,
    metadata: decoded.metadata,
    dataVersion: decoded.dataVersion,
  };
}
