// Schematic container formats: NBT primitives, format detection, and one
// decoder per format.
//
// `loader.py` knew exactly one layout -- Sponge v2, the one `mcschematic`
// writes -- because the Python app only ever read files it had written itself.
// The desktop app has a file picker, so it meets schematics written by
// WorldEdit, FAWE and MCEdit, and "I picked a .schem and nothing rendered" was
// the result: a v3 file has no top-level `Width`, so the v2 reader threw
// `Malformed schematic: expected numeric tag for Width` on a file that is not
// malformed at all.
//
// This module owns everything format-specific; `loader.ts` is the orchestrator
// on top of it. The dependency runs one way, formats <- loader, so the NBT
// primitives live here rather than being imported back out of loader.ts.
//
// No Electron imports, by the same rule the rest of `pipeline/` follows: the
// test suite drives these headlessly.

import { readFile } from "fs/promises";

import type { SchematicFormat } from "../../shared/schematic.js";
import type {
  BlockEntityRecord,
  EntityRecord,
  NbtCompound,
  NbtTag,
  PaletteEntry,
} from "./types.js";

// Re-exported: these two started here, and moved to `types.ts` once block
// entities gave the document model a reason to name them too.
export type { NbtCompound, NbtTag } from "./types.js";

/**
 * Raised when the file parses as NBT but is not a schematic this app can read.
 * Distinct from "malformed": the caller turns it into a message that names the
 * format and says what to do, rather than a generic I/O failure.
 */
export class SchematicFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchematicFormatError";
  }
}

export function asCompound(tag: NbtTag | undefined, context: string): NbtCompound {
  if (!tag || typeof tag.value !== "object" || tag.value === null) {
    throw new Error(`Malformed schematic: expected compound tag for ${context}`);
  }
  return tag.value as NbtCompound;
}

/**
 * Fixed 2026-08-05 per Step 3 review (loader.ts reviewer 2): a missing Width/Height/
 * Length tag was silently coalescing to 0 via `?? 0` instead of failing loudly, unlike
 * Python's `int(root["Width"])`, which raises `KeyError` immediately on a missing key --
 * an unflagged behavior divergence on malformed input, inconsistent with this same
 * function's Palette handling (asCompound), which already throws. Required numeric tags
 * must throw, matching the source and the rest of this function's own pattern.
 */
export function requireNumberTag(tag: NbtTag | undefined, context: string): number {
  if (!tag || typeof tag.value !== "number") {
    throw new Error(`Malformed schematic: expected numeric tag for ${context}`);
  }
  return tag.value;
}

/**
 * Unwraps the (sometimes-present) anonymous root compound that some NBT
 * writers nest the real payload under (`{"": {Width: ..., ...}}`).
 * `prismarine-nbt`'s `parse()` normally strips it into the root tag's `name`,
 * but not every writer produces the shape it expects.
 */
export function unwrapRoot(root: NbtCompound): NbtCompound {
  const keys = Object.keys(root);
  if (keys.length === 1 && keys[0] === "" && root[""]?.type === "compound") {
    return root[""].value as NbtCompound;
  }
  return root;
}

/** Ported from `_parse_palette_entry` (loader.py:26-40). */
export function parsePaletteEntry(blockState: string): PaletteEntry {
  if (!blockState.includes("[")) {
    return { namespacedName: blockState, properties: {} };
  }
  const bracketIndex = blockState.indexOf("[");
  const name = blockState.slice(0, bracketIndex);
  let props = blockState.slice(bracketIndex + 1);
  if (props.endsWith("]")) {
    props = props.slice(0, -1);
  }
  const propDict: Record<string, string> = {};
  for (const part of props.split(",")) {
    if (part === "") {
      continue;
    }
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) {
      propDict[part] = "true";
      continue;
    }
    const key = part.slice(0, eqIndex);
    const value = part.slice(eqIndex + 1);
    propDict[key] = value;
  }
  return { namespacedName: name, properties: propDict };
}

/**
 * Converts a `prismarine-nbt` `long` element (`[high, low]`, both 32-bit
 * signed, per node-protodef convention) into an unsigned 64-bit `bigint`,
 * matching Python's `int(long_val).to_bytes(8, "little", signed=False)`
 * source semantics (loader.py:156-157).
 */
function longPairToBigUint64(pair: readonly [number, number]): bigint {
  const [high, low] = pair;
  const highBits = BigInt(high >>> 0);
  const lowBits = BigInt(low >>> 0);
  return (highBits << 32n) | lowBits;
}

/**
 * `_decode_packed_block_states` (loader.py:43-71) -- decodes legacy Sponge
 * schematic block data packed into 64-bit longs.
 */
function decodePackedBlockStates(
  data: Uint8Array,
  paletteSize: number,
  totalBlocks: number,
): Int32Array {
  // Minimum bits per block is 4 according to the Sponge schematic spec.
  const bitsPerBlock = Math.max(4, 32 - Math.clz32(Math.max(1, paletteSize - 1)));
  const mask = (1 << bitsPerBlock) - 1;

  const values = new Int32Array(totalBlocks);
  let bitBuffer = 0;
  let bitCount = 0;
  let index = 0;

  for (const byte of data) {
    bitBuffer |= (byte & 0xff) << bitCount;
    bitCount += 8;
    while (bitCount >= bitsPerBlock && index < totalBlocks) {
      values[index] = bitBuffer & mask;
      bitBuffer >>>= bitsPerBlock;
      bitCount -= bitsPerBlock;
      index += 1;
    }
  }
  // Remaining values already default to 0 (air) via Int32Array zero-init,
  // matching the source's explicit `values[index:] = 0` (loader.py:69-70).
  return values;
}

/**
 * `_decode_varint_block_data` (loader.py:74-105) -- decodes schematic block
 * data stored as Minecraft-style VarInts.
 *
 * Precision: accumulates into a `bigint`, not a JS `number` with `<<`/`|`
 * (which truncate to 32-bit signed), so a 5th continuation byte cannot
 * silently lose precision.
 */
function decodeVarintBlockData(data: readonly number[], totalBlocks: number): Int32Array {
  const values = new Int32Array(totalBlocks);
  let value = 0n;
  let shift = 0n;
  let index = 0;

  for (const raw of data) {
    const byte = raw & 0xff;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (index < totalBlocks) {
        values[index] = Number(BigInt.asIntN(32, value));
      }
      index += 1;
      value = 0n;
      shift = 0n;
      if (index >= totalBlocks) {
        break;
      }
    } else {
      shift += 7n;
      if (shift >= 35n) {
        // Defensive reset on malformed data that never terminates, matching
        // loader.py:98-101.
        value = 0n;
        shift = 0n;
      }
    }
  }
  // Remaining values already default to 0 (air), matching loader.py:103-104.
  return values;
}

// --- block entities and entities -------------------------------------------
//
// Read permissively, on purpose. The three container formats spell the same
// data three ways -- Sponge v2 puts the block entity's NBT inline beside `Id`
// and `Pos`, v3 nests it under `Data`, MCEdit uses lowercase `id` with separate
// `x`/`y`/`z` ints -- and a reader that insisted on one spelling would drop the
// contents of every chest written by the other two. Whatever is not recognised
// as identity or position is kept as-is under `nbt`, so a field this code has
// never heard of survives a load/save round trip.

/** Elements of a `list` tag of compounds; `[]` for anything else. */
function compoundList(tag: NbtTag | undefined): NbtCompound[] {
  if (!tag || tag.value === null || typeof tag.value !== "object") {
    return [];
  }
  // prismarine-nbt nests a list as `{type:"list", value:{type, value:[...]}}`,
  // but a bare array is accepted too rather than silently yielding nothing.
  const inner = (tag.value as { value?: unknown }).value;
  const items = Array.isArray(inner) ? inner : Array.isArray(tag.value) ? tag.value : [];
  return items.filter(
    (item): item is NbtCompound => typeof item === "object" && item !== null,
  );
}

function numberOf(tag: NbtTag | undefined): number | null {
  return tag && typeof tag.value === "number" ? tag.value : null;
}

function stringOf(tag: NbtTag | undefined): string | null {
  return tag && typeof tag.value === "string" ? tag.value : null;
}

/** `Pos` as a 3-vector, whether it arrived as an int array or a list of numbers. */
function vectorOf(tag: NbtTag | undefined): [number, number, number] | null {
  if (!tag || tag.value === null || typeof tag.value !== "object") {
    return null;
  }
  const inner = (tag.value as { value?: unknown }).value;
  const raw = Array.isArray(inner) ? inner : Array.isArray(tag.value) ? tag.value : null;
  if (!raw || raw.length < 3) {
    return null;
  }
  const nums = raw.slice(0, 3).map((item) => {
    if (typeof item === "number") return item;
    // A list of tagged doubles, as Sponge writes entity positions.
    if (item && typeof item === "object" && typeof (item as NbtTag).value === "number") {
      return (item as NbtTag).value as number;
    }
    return Number.NaN;
  });
  return nums.every((n) => Number.isFinite(n)) ? [nums[0], nums[1], nums[2]] : null;
}

/** Everything except the keys that carried identity and position. */
function remainingNbt(entry: NbtCompound, consumed: readonly string[]): NbtCompound {
  // A `Data` compound (Sponge v3) *is* the payload, so it is unwrapped rather
  // than kept as a nested tag -- otherwise the same chest would come back with
  // its items one level deeper than it went in.
  const data = entry.Data;
  if (data && data.type === "compound" && data.value && typeof data.value === "object") {
    return { ...(data.value as NbtCompound) };
  }
  const out: NbtCompound = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!consumed.includes(key)) {
      out[key] = value;
    }
  }
  return out;
}

function namespaced(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

const BLOCK_ENTITY_KEYS = ["Id", "id", "Pos", "pos", "x", "y", "z", "X", "Y", "Z", "Data"];

/**
 * Sponge `BlockEntities`/`TileEntities` and MCEdit `TileEntities`.
 *
 * An entry with no usable identity or position is skipped: it cannot be placed
 * back anywhere, and carrying it would corrupt a later save.
 */
export function readBlockEntities(tag: NbtTag | undefined): BlockEntityRecord[] {
  const out: BlockEntityRecord[] = [];
  for (const entry of compoundList(tag)) {
    const id = stringOf(entry.Id) ?? stringOf(entry.id);
    if (id === null) {
      continue;
    }
    // Sponge: a single `Pos` array. MCEdit: three separate int tags.
    const pos =
      vectorOf(entry.Pos) ??
      (() => {
        const x = numberOf(entry.x) ?? numberOf(entry.X);
        const y = numberOf(entry.y) ?? numberOf(entry.Y);
        const z = numberOf(entry.z) ?? numberOf(entry.Z);
        return x !== null && y !== null && z !== null
          ? ([x, y, z] as [number, number, number])
          : null;
      })();
    if (pos === null) {
      continue;
    }
    out.push({ id: namespaced(id), pos, nbt: remainingNbt(entry, BLOCK_ENTITY_KEYS) });
  }
  return out;
}

/** Sponge and MCEdit `Entities`. Positions stay floating point. */
export function readEntities(tag: NbtTag | undefined): EntityRecord[] {
  const out: EntityRecord[] = [];
  for (const entry of compoundList(tag)) {
    const id = stringOf(entry.Id) ?? stringOf(entry.id);
    const pos = vectorOf(entry.Pos) ?? vectorOf(entry.pos);
    if (id === null || pos === null) {
      continue;
    }
    out.push({ id: namespaced(id), pos, nbt: remainingNbt(entry, ["Id", "id", "Pos", "pos", "Data"]) });
  }
  return out;
}

// --- format detection ------------------------------------------------------

// Declared in `shared/` because the renderer names it too; re-exported here so
// this module stays the one place the pipeline asks about container formats.
export type { SchematicFormat };

export interface DecodedSchematic {
  readonly format: SchematicFormat;
  readonly width: number;
  readonly height: number;
  readonly length: number;
  readonly palette: readonly PaletteEntry[];
  /**
   * Palette indices in YZX order (`i = y*width*length + z*width + x`).
   *
   * All three formats agree on this ordering -- Sponge specifies it and MCEdit
   * happens to use `(y*Length + z)*Width + x`, which is the same expression --
   * so the caller's voxel-write loop is format-independent.
   */
  readonly indices: Int32Array;
  /** Block ids the legacy table had no entry for; MCEdit only. */
  readonly unmappedLegacyIds: readonly string[];
  /** Chest contents, sign text, spawner data. Empty when the file carried none. */
  readonly blockEntities: readonly BlockEntityRecord[];
  /** Mobs, item frames, armour stands. Empty when the file carried none. */
  readonly entities: readonly EntityRecord[];
  /**
   * Where the schematic sat in the world it was cut from. Preserved so a save
   * can put it back rather than silently re-anchoring it at the origin.
   */
  readonly offset: readonly [number, number, number];
  /**
   * WorldEdit's Origin: the world position of the schematic's (0,0,0) corner,
   * or `null` when the file named none. A different vector from `offset` --
   * see `SchematicDocument.worldOrigin`.
   */
  readonly worldOrigin: readonly [number, number, number] | null;
  /** The file's own `Metadata` compound, minus the Origin lifted out above. */
  readonly metadata: NbtCompound;
  /** The Minecraft `DataVersion` the file declares, or `null` for MCEdit. */
  readonly dataVersion: number | null;
}

/**
 * The `Metadata` compound and WorldEdit's Origin, separated.
 *
 * The Origin is lifted *out* of the bag rather than left in it because the app
 * owns that one field: it has to move when the content moves, and a copy of it
 * sitting in an opaque compound would go stale on the first crop. Everything
 * else is kept exactly as found, `Platforms` and `EditingPlatform` included --
 * a `WorldEdit` sub-compound survives with a hole in it rather than being
 * replaced by one this app invented.
 *
 * The sub-compound is dropped when the Origin was all it held: an empty
 * `WorldEdit: {}` is noise in a file and noise in the NBT panel.
 */
function readMetadata(tag: NbtTag | undefined): {
  metadata: NbtCompound;
  worldOrigin: readonly [number, number, number] | null;
} {
  if (!tag || tag.type !== "compound" || tag.value === null || typeof tag.value !== "object") {
    return { metadata: {}, worldOrigin: null };
  }
  const metadata: NbtCompound = { ...(tag.value as NbtCompound) };

  const worldEditTag = metadata.WorldEdit;
  if (
    !worldEditTag ||
    worldEditTag.type !== "compound" ||
    worldEditTag.value === null ||
    typeof worldEditTag.value !== "object"
  ) {
    return { metadata, worldOrigin: null };
  }

  const worldEdit: NbtCompound = { ...(worldEditTag.value as NbtCompound) };
  const worldOrigin = vectorOf(worldEdit.Origin);
  if (worldOrigin === null) {
    return { metadata, worldOrigin: null };
  }

  delete worldEdit.Origin;
  if (Object.keys(worldEdit).length === 0) {
    delete metadata.WorldEdit;
  } else {
    metadata.WorldEdit = { type: "compound", value: worldEdit };
  }
  return { metadata, worldOrigin };
}

/**
 * Sponge v3 moves the payload one level down, under a `Schematic` compound,
 * and the block arrays into a `Blocks` sub-compound. Everything else -- varint
 * data, YZX order, `name -> index` palette -- is unchanged from v2, which is
 * why the two share every decoder below the container.
 */
function detectFormat(root: NbtCompound): { format: SchematicFormat; payload: NbtCompound } {
  const nested = root.Schematic;
  if (nested && typeof nested.value === "object" && nested.value !== null) {
    return { format: "sponge3", payload: nested.value as NbtCompound };
  }
  if (root.Blocks !== undefined && root.Palette === undefined && root.BlockData === undefined) {
    // MCEdit: a `Blocks` *byte array* of numeric ids. Sponge v3's `Blocks` is a
    // compound, and it has already been claimed above, so reaching here with a
    // `Blocks` tag and no Sponge palette means the legacy format.
    return { format: "mcedit", payload: root };
  }
  if (root.Width !== undefined || root.Palette !== undefined) {
    return { format: "sponge2", payload: root };
  }
  const keys = Object.keys(root).slice(0, 12).join(", ");
  throw new SchematicFormatError(
    `Unrecognised schematic: expected a Sponge (v2 or v3) or MCEdit structure, ` +
      `found a root compound with [${keys}]`,
  );
}

// --- Sponge v2 / v3 --------------------------------------------------------

/**
 * Both Sponge versions store the palette as `blockState -> index`, so the map
 * is read in reverse and any gap left by a non-contiguous palette is filled
 * with air rather than left `undefined` (loader.py:126-135).
 */
function readSpongePalette(paletteTag: NbtCompound): PaletteEntry[] {
  const byIndex = new Map<number, PaletteEntry>();
  for (const [blockState, valueTag] of Object.entries(paletteTag)) {
    byIndex.set(Number(valueTag.value), parsePaletteEntry(blockState));
  }
  let maxIndex = 0;
  for (const key of byIndex.keys()) {
    if (key > maxIndex) {
      maxIndex = key;
    }
  }
  const list: PaletteEntry[] = [];
  for (let i = 0; i <= maxIndex; i += 1) {
    list.push({ namespacedName: "minecraft:air", properties: {} });
  }
  for (const [index, entry] of byIndex.entries()) {
    if (index >= 0 && index < list.length) {
      list[index] = entry;
    }
  }
  return list;
}

function decodeSponge(
  format: "sponge2" | "sponge3",
  payload: NbtCompound,
  blocks: NbtCompound,
): DecodedSchematic {
  const width = requireNumberTag(payload.Width, "Width");
  const height = requireNumberTag(payload.Height, "Height");
  const length = requireNumberTag(payload.Length, "Length");
  const totalBlocks = width * height * length;

  const palette = readSpongePalette(asCompound(blocks.Palette, "Palette"));

  // v2 calls it BlockData, v3 calls it Data; a very old v1 file uses a
  // LongArray named BlockStates. Resolved once, here, so nothing downstream
  // re-checks which field was present.
  const varintTag = blocks.BlockData ?? blocks.Data;
  let indices: Int32Array;
  if (varintTag !== undefined) {
    // NBT byteArray: signed bytes, masked to 0..255 inside the decoder.
    indices = decodeVarintBlockData(Array.from(varintTag.value as ArrayLike<number>), totalBlocks);
  } else {
    const packedTag = blocks.BlockStates;
    if (packedTag === undefined) {
      throw new SchematicFormatError(
        "Schematic contains no block data (expected BlockData, Data or BlockStates)",
      );
    }
    const longs = (packedTag.value as ReadonlyArray<readonly [number, number]>).map(
      longPairToBigUint64,
    );
    // Expand the packed longs into little-endian bytes, matching
    // loader.py:153-157 (`value.to_bytes(8, byteorder="little", signed=False)`).
    const rawBytes = new Uint8Array(longs.length * 8);
    let offset = 0;
    for (const longValue of longs) {
      for (let byteIndex = 0; byteIndex < 8; byteIndex += 1) {
        rawBytes[offset] = Number((longValue >> BigInt(8 * byteIndex)) & 0xffn);
        offset += 1;
      }
    }
    indices = decodePackedBlockStates(rawBytes, palette.length, totalBlocks);
  }

  return {
    format,
    width,
    height,
    length,
    palette,
    indices,
    unmappedLegacyIds: [],
    // v3 moved block entities down into `Blocks` alongside the block data; v2
    // keeps them at the top level, and v1-era WorldEdit files spell it
    // `TileEntities`. First one present wins -- and it must be *one*, not the
    // concatenation of all three: for v2 `blocks` and `payload` are the same
    // compound, so reading both yielded every chest twice.
    blockEntities: readBlockEntities(
      blocks.BlockEntities ?? payload.BlockEntities ?? payload.TileEntities,
    ),
    entities: readEntities(payload.Entities),
    offset: vectorOf(payload.Offset) ?? [0, 0, 0],
    // `payload` is already the right compound for both versions: v3's is the
    // `Schematic` compound and v2's is the root, which is where each writes it.
    ...readMetadata(payload.Metadata),
    dataVersion: numberOf(payload.DataVersion),
  };
}

// --- MCEdit ----------------------------------------------------------------

/** `"id:meta" -> "minecraft:name[state=value]"`, the pre-1.13 flattening table. */
export type LegacyBlockTable = Readonly<Record<string, string>>;

let cachedLegacyTable: { path: string; table: LegacyBlockTable } | null = null;

/**
 * Reads the vendored flattening table. Cached by path: it is ~100 KB of JSON
 * and a session may load many schematics.
 */
export async function loadLegacyBlockTable(tablePath: string): Promise<LegacyBlockTable> {
  if (cachedLegacyTable && cachedLegacyTable.path === tablePath) {
    return cachedLegacyTable.table;
  }
  const raw = await readFile(tablePath, "utf-8");
  const parsed = JSON.parse(raw) as { blocks?: Record<string, string> };
  const table = parsed.blocks;
  if (!table || typeof table !== "object") {
    throw new SchematicFormatError(`${tablePath} has no "blocks" map`);
  }
  cachedLegacyTable = { path: tablePath, table };
  return table;
}

/**
 * MCEdit's optional `AddBlocks` (also seen as `Add`) carries the high nibble of
 * block ids above 255, packed two blocks per byte: the high nibble belongs to
 * the even index, the low nibble to the odd one.
 */
function highNibble(addBlocks: Uint8Array | null, index: number): number {
  if (!addBlocks) {
    return 0;
  }
  const byte = addBlocks[index >> 1];
  if (byte === undefined) {
    return 0;
  }
  return (index & 1) === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
}

function byteArrayOf(tag: NbtTag | undefined): Uint8Array | null {
  if (!tag || tag.value === null || tag.value === undefined) {
    return null;
  }
  return Uint8Array.from(tag.value as ArrayLike<number>);
}

function decodeMcEdit(payload: NbtCompound, table: LegacyBlockTable): DecodedSchematic {
  const width = requireNumberTag(payload.Width, "Width");
  const height = requireNumberTag(payload.Height, "Height");
  const length = requireNumberTag(payload.Length, "Length");
  const totalBlocks = width * height * length;

  const blocks = byteArrayOf(payload.Blocks);
  if (!blocks) {
    throw new SchematicFormatError("MCEdit schematic has no Blocks array");
  }
  const data = byteArrayOf(payload.Data);
  const addBlocks = byteArrayOf(payload.AddBlocks) ?? byteArrayOf(payload.Add);

  // The palette is built as we go: legacy files have no palette of their own,
  // and a full 4096-entry table would make every downstream loop pay for
  // blocks the file does not contain.
  const palette: PaletteEntry[] = [{ namespacedName: "minecraft:air", properties: {} }];
  const indexByState = new Map<string, number>([["minecraft:air", 0]]);
  const unmapped = new Set<string>();
  const indices = new Int32Array(totalBlocks);

  const limit = Math.min(totalBlocks, blocks.length);
  for (let i = 0; i < limit; i += 1) {
    const id = (highNibble(addBlocks, i) << 8) | (blocks[i] & 0xff);
    const meta = data ? data[i] & 0x0f : 0;
    if (id === 0) {
      continue; // air, already index 0
    }

    // Exact `id:meta` first; a metadata value the table does not enumerate
    // (an unused bit combination, or one that only affects a tile entity)
    // falls back to the base block rather than to air.
    const state = table[`${id}:${meta}`] ?? table[`${id}:0`];
    if (state === undefined) {
      unmapped.add(`${id}:${meta}`);
      continue;
    }

    let paletteIndex = indexByState.get(state);
    if (paletteIndex === undefined) {
      paletteIndex = palette.length;
      palette.push(parsePaletteEntry(state));
      indexByState.set(state, paletteIndex);
    }
    indices[i] = paletteIndex;
  }

  return {
    format: "mcedit",
    width,
    height,
    length,
    palette,
    indices,
    unmappedLegacyIds: [...unmapped].sort(),
    // MCEdit's tile entities are pre-flattening: a chest's `id` is `Chest`, not
    // `minecraft:chest`, and its items are named by numeric id. The NBT is kept
    // exactly as found -- translating it would need a second flattening table
    // this app does not vendor, and a wrong translation is worse than an
    // untranslated one that still round-trips.
    blockEntities: readBlockEntities(payload.TileEntities),
    entities: readEntities(payload.Entities),
    // MCEdit spells the offset as three separate tags -- shorts in some
    // writers, ints in WorldEdit's own. `numberOf` does not care which.
    offset: [
      numberOf(payload.WEOffsetX) ?? 0,
      numberOf(payload.WEOffsetY) ?? 0,
      numberOf(payload.WEOffsetZ) ?? 0,
    ],
    // And the Origin as three more. All three or none: two thirds of a position
    // is not a position, and defaulting the missing one to zero would put the
    // build somewhere nobody asked for.
    worldOrigin: mcEditOrigin(payload),
    // MCEdit has no `Metadata` compound at all -- WorldEdit writes its tags
    // straight onto the root, which is where `worldOrigin` just came from.
    metadata: {},
    // Legacy files predate DataVersion entirely.
    dataVersion: null,
  };
}

/** `WEOriginX/Y/Z`, or `null` unless all three are there. */
function mcEditOrigin(payload: NbtCompound): readonly [number, number, number] | null {
  const x = numberOf(payload.WEOriginX);
  const y = numberOf(payload.WEOriginY);
  const z = numberOf(payload.WEOriginZ);
  return x === null || y === null || z === null ? null : [x, y, z];
}

// --- entry point -----------------------------------------------------------

/**
 * Decodes an already-parsed NBT root into dimensions, palette and YZX-ordered
 * palette indices, whichever of the three container formats it is.
 *
 * `legacyBlockTable` is only consulted for MCEdit files; passing `null` makes
 * those fail with an explanatory error instead of silently decoding to air.
 */
export function decodeSchematic(
  root: NbtCompound,
  legacyBlockTable: LegacyBlockTable | null,
): DecodedSchematic {
  const { format, payload } = detectFormat(unwrapRoot(root));

  if (format === "mcedit") {
    if (!legacyBlockTable) {
      throw new SchematicFormatError(
        "This is a legacy MCEdit .schematic and the block conversion table is unavailable",
      );
    }
    return decodeMcEdit(payload, legacyBlockTable);
  }

  // v3 keeps the block arrays in a `Blocks` compound; v2 keeps them alongside
  // the dimensions. One lookup, then a single shared decoder.
  const blocks =
    format === "sponge3" ? asCompound(payload.Blocks, "Schematic.Blocks") : payload;
  return decodeSponge(format, payload, blocks);
}

/** Test seam: drops the cached flattening table. */
export function resetLegacyTableCacheForTests(): void {
  cachedLegacyTable = null;
}
