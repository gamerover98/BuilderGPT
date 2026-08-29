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
import path from "path";
import { parse as parseNbt } from "prismarine-nbt";

import {
  McfunctionError,
  onShell,
  parseMcfunction,
  type BlockCommand,
} from "./mcfunction.js";
import {
  paletteEntryCacheKey,
  paletteEntryIsAir,
} from "./types.js";

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
  PaletteEntry,
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

/**
 * What a file turned out to be, which is not always a container.
 *
 * `.mcfunction` is the odd one: it is read, but a document does not *become*
 * one. It has no metadata, no anchor tag, no `DataVersion` and no NBT root, so
 * making it a `SchematicFormat` would force every part of the app that switches
 * on the format to invent an answer about tags that do not exist. Opening one
 * therefore produces a Sponge v3 document with no file path, and Save falls
 * through to Save As on its own -- which `saveDocument` already does.
 */
export type FileKind = SchematicFormat | "mcfunction";

/** Whether this path is read as commands rather than as NBT. */
export function isMcfunctionPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".mcfunction");
}

/** What was read, beyond the voxels themselves. */
export interface LoadedStructure extends StructureData {
  readonly format: SchematicFormat;
  /** What the file on disk was, which for everything but commands is `format`. */
  readonly sourceKind: FileKind;
  /**
   * Things the reader had to say about the file, for the status line.
   *
   * Empty for every container: an NBT file either parses or it does not.
   * A `.mcfunction` is the one that can be *partly* read -- lines that are
   * neither `setblock` nor `fill` are not in the build, and a `function` call
   * that resolves to nothing is a whole file's worth of it missing.
   */
  readonly notes: readonly string[];
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


// ---------------------------------------------------------------------------
// .mcfunction
// ---------------------------------------------------------------------------

/**
 * How far a chain of `function` calls is followed, and how many files.
 *
 * A cap rather than a promise: the reference file this was built against is a
 * one-line dispatcher calling a sibling, and a datapack that splits a cathedral
 * into forty parts is the ordinary large case. What the cap is really for is
 * the pathological one -- a pack whose functions call each other in a fan --
 * where the visited set already stops a cycle but not an exponential walk.
 */
const MAX_FUNCTION_FILES = 256;
const MAX_FUNCTION_DEPTH = 16;

/**
 * Where `function <namespace>:<path>` might live, best first.
 *
 * Two shapes, because two are in circulation. A real datapack keeps functions
 * at `data/<namespace>/function/<path>.mcfunction` -- `functions`, plural,
 * before 1.21 -- and the file being opened is somewhere underneath that same
 * `data` directory, so the pack root can be found by walking up to it. A file
 * exported by a converter is usually just a pair sitting in a folder together,
 * which is what the reference files are, so the sibling by basename is tried
 * as well.
 *
 * Nothing here guesses at a *namespace*: the pack root is found from the path
 * of the file doing the calling, so a call into another namespace resolves only
 * if that namespace really is there.
 */
function functionCandidates(target: string, fromPath: string): string[] {
  const colon = target.indexOf(":");
  const namespace = colon === -1 ? "minecraft" : target.slice(0, colon);
  const inner = colon === -1 ? target : target.slice(colon + 1);
  const leaf = inner.split("/").pop() ?? inner;
  const out: string[] = [];

  const parts = path.resolve(fromPath).split(path.sep);
  const dataAt = parts.lastIndexOf("data");
  if (dataAt > 0) {
    const root = parts.slice(0, dataAt).join(path.sep);
    for (const folder of ["function", "functions"]) {
      out.push(path.join(root, "data", namespace, folder, `${inner}.mcfunction`));
    }
  }
  out.push(path.join(path.dirname(fromPath), `${leaf}.mcfunction`));
  return out;
}

/** Every command in a file and in whatever it calls, in the order they run. */
async function collectCommands(
  entryPath: string,
): Promise<{ commands: BlockCommand[]; notes: string[]; relative: boolean }> {
  const commands: BlockCommand[] = [];
  const notes: string[] = [];
  const visited = new Set<string>();
  let ignored = 0;
  let files = 0;
  let relative: boolean | null = null;

  const walk = async (filePath: string, depth: number): Promise<void> => {
    const resolved = path.resolve(filePath);
    // A cycle is not an error: a pack whose two functions call each other is
    // odd but readable, and the second visit simply has nothing new to add.
    if (visited.has(resolved)) return;
    if (files >= MAX_FUNCTION_FILES || depth > MAX_FUNCTION_DEPTH) {
      notes.push(`Stopped after ${files} function files; the rest were not read`);
      return;
    }
    visited.add(resolved);
    files += 1;

    const text = await readFile(resolved, "utf8");
    const parsed = parseMcfunction(text);
    /*
     * Checked across the whole chain, not per file. A dispatcher that places
     * nothing has no frame of its own, so the first file that does decides it,
     * and a later one that disagrees is describing a second build.
     */
    if (parsed.relative !== null) {
      if (relative === null) relative = parsed.relative;
      else if (relative !== parsed.relative) {
        throw new McfunctionError(
          `${path.basename(resolved)} uses ${parsed.relative ? "~ relative" : "absolute"} ` +
            `coordinates where the files before it used the other kind, which describes two ` +
            `different builds`,
        );
      }
    }
    commands.push(...parsed.commands);
    ignored += parsed.ignored;

    for (const call of parsed.calls) {
      let found: string | null = null;
      for (const candidate of functionCandidates(call, resolved)) {
        try {
          await readFile(candidate);
          found = candidate;
          break;
        } catch {
          // Next candidate. A missing file here is the ordinary case, not an
          // error: only having tried them all is.
        }
      }
      if (found === null) {
        notes.push(`function ${call} could not be found, so its blocks are not here`);
        continue;
      }
      await walk(found, depth + 1);
    }
  };

  await walk(entryPath, 0);

  if (ignored > 0) {
    notes.push(
      `${ignored} line${ignored === 1 ? "" : "s"} were neither setblock nor fill and are not ` +
        `in the schematic`,
    );
  }
  // A file with nothing but a dispatcher line never set a frame; `true` is
  // the harmless answer there, because there are no coordinates to place.
  return { commands, notes, relative: relative ?? true };
}

/**
 * A `.mcfunction`, or the chain of them one dispatcher reaches.
 *
 * The commands are applied **in order**, into a grid sized from all of them, so
 * a later `fill` over an earlier one wins exactly as it would in the game. That
 * ordering is also what makes `keep` and `replace <filter>` mean anything: both
 * ask what is already in the cell.
 *
 * The frame becomes the anchor. `~ ~ ~` is wherever the function is run from,
 * so the cell it names is `-min` in the document's coordinates and `doc.offset`
 * is its negation -- which is exactly what the tag means everywhere else here.
 * Absolute coordinates name a world position instead, so those set
 * `worldOrigin` and no anchor.
 */
async function loadMcfunction(filePath: string): Promise<LoadedStructure> {
  const { commands, notes, relative } = await collectCommands(filePath);

  if (commands.length === 0) {
    throw new McfunctionError(
      `No setblock or fill commands here.` +
        (notes.length === 0 ? "" : ` ${notes.join("; ")}.`),
    );
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const command of commands) {
    minX = Math.min(minX, command.box.minX);
    minY = Math.min(minY, command.box.minY);
    minZ = Math.min(minZ, command.box.minZ);
    maxX = Math.max(maxX, command.box.maxX);
    maxY = Math.max(maxY, command.box.maxY);
    maxZ = Math.max(maxZ, command.box.maxZ);
  }
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const length = maxZ - minZ + 1;

  const palette: PaletteEntry[] = [{ namespacedName: "minecraft:air", properties: {} }];
  const byKey = new Map<string, number>([[paletteEntryCacheKey(palette[0]), 0]]);
  const intern = (entry: PaletteEntry): number => {
    if (paletteEntryIsAir(entry)) return 0;
    const key = paletteEntryCacheKey(entry);
    const found = byKey.get(key);
    if (found !== undefined) return found;
    const next = palette.length;
    palette.push(entry);
    byKey.set(key, next);
    return next;
  };

  const indices = new Int32Array(width * height * length);
  const blockEntities = new Map<string, BlockEntityRecord>();
  for (const command of commands) {
    const value = intern(command.entry);
    const over = command.onlyOver === null ? null : intern(command.onlyOver);
    for (let y = command.box.minY; y <= command.box.maxY; y += 1) {
      for (let z = command.box.minZ; z <= command.box.maxZ; z += 1) {
        for (let x = command.box.minX; x <= command.box.maxX; x += 1) {
          const shell = onShell(command.box, x, y, z);
          if (command.shape === "outline" && !shell) continue;
          const at =
            (y - minY) * width * length + (z - minZ) * width + (x - minX);
          // `hollow` is `outline` plus an emptied middle, which is the one mode
          // that writes a block the command did not name.
          const write = command.shape === "hollow" && !shell ? 0 : value;
          if (command.onlyAir && indices[at] !== 0) continue;
          if (over !== null && indices[at] !== over) continue;
          indices[at] = write;
          const key = `${x - minX},${y - minY},${z - minZ}`;
          if (write !== 0 && command.nbt !== null) {
            blockEntities.set(key, {
              id: command.entry.namespacedName,
              pos: [x - minX, y - minY, z - minZ],
              nbt: command.nbt,
            });
          } else {
            // Anything written over loses whatever record was there, exactly as
            // `setBlock` treats a write as displacing what it lands on.
            blockEntities.delete(key);
          }
        }
      }
    }
  }
  const voxels = new Int32Array(width * height * length);
  for (let i = 0; i < indices.length; i += 1) {
    const x = i % width;
    const z = Math.floor(i / width) % length;
    const y = Math.floor(i / (width * length));
    voxels[x * height * length + y * length + z] = indices[i];
  }

  return {
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: width - 1, maxY: height - 1, maxZ: length - 1 },
    palette,
    voxels,
    // A document is a container, and a `.mcfunction` is not one. Sponge v3 is
    // what it becomes; `sourceKind` is what it was.
    format: "sponge3",
    sourceKind: "mcfunction",
    notes,
    unmappedLegacyIds: [],
    blockEntities: [...blockEntities.values()],
    entities: [],
    /*
     * `~ ~ ~` is wherever the function is run from, so the cell it names sits
     * at `-min` in the document's coordinates -- and the anchor tag is the
     * negation of the anchor's cell, which is `min` itself. Writing it is
     * honest rather than a default: the file really did say where its corner
     * was relative to the player, and `[0, 0, 0]` here means the corner *is*
     * the anchor rather than "nobody said".
     */
    offset: relative ? [minX, minY, minZ] : null,
    // Absolute coordinates name a position in a world instead, which is the
    // other tag entirely. A file cannot carry both, because it cannot mix the
    // two kinds of coordinate.
    worldOrigin: relative ? null : [minX, minY, minZ],
    metadata: {},
    dataVersion: null,
  };
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
  /*
   * By extension, and *before* the read, because `parseNbt` on a text file
   * fails with a message about a byte at an offset that names neither the file
   * nor the reason. There is no sniffing to be done either: a `.mcfunction` has
   * no magic number, it starts with whatever its first command is.
   */
  if (isMcfunctionPath(inputPath)) {
    return await loadMcfunction(inputPath);
  }

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
    sourceKind: decoded.format,
    notes: [],
    unmappedLegacyIds: decoded.unmappedLegacyIds,
    blockEntities: decoded.blockEntities,
    entities: decoded.entities,
    offset: decoded.offset,
    worldOrigin: decoded.worldOrigin,
    metadata: decoded.metadata,
    dataVersion: decoded.dataVersion,
  };
}
