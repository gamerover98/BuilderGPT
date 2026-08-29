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
import { paletteEntryCacheKey } from "./types.js";

// Re-exported: these two started here, and moved to `types.ts` once block
// entities gave the document model a reason to name them too.
export type { NbtCompound, NbtTag } from "./types.js";
import {
  LITEMATIC_MIN_LABEL,
  LITEMATIC_MIN_VERSION,
} from "../../shared/litematica_versions.js";
import {
  bitsPerEntry,
  longPairsToBigints,
  unpackLitematicStates,
} from "./litematic_bits.js";

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
  readonly offset: readonly [number, number, number] | null;
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
 * The `Metadata` compound, with the two vectors the app owns lifted out of it.
 *
 * They are lifted rather than left in the bag because the app *moves* them: both
 * follow the content through a crop and a resize, and a second copy sitting in
 * an opaque compound would go stale on the first one. Everything else is kept
 * exactly as found -- `Platforms`, `EditingPlatform`, `Author` -- and a
 * `WorldEdit` sub-compound survives with a hole in it rather than being replaced
 * by one this app invented. The sub-compound is dropped when the Origin was all
 * it held: an empty `WorldEdit: {}` is noise in a file and in the NBT panel.
 *
 * **`WEOffsetX/Y/Z` are lifted for v2 only**, because only v2 keeps the paste
 * displacement there. In a v3 file those keys are something another tool left
 * behind and v3's own reader ignores them, so they stay in the bag as unknown
 * metadata rather than being read as an anchor that would contradict `Offset`.
 */
export function readMetadata(
  tag: NbtTag | undefined,
  format: SchematicFormat,
): {
  metadata: NbtCompound;
  worldOrigin: readonly [number, number, number] | null;
  /** v2's `Metadata.WEOffsetX/Y/Z`: the vector from the paste anchor. */
  weOffset: readonly [number, number, number] | null;
} {
  if (!tag || tag.type !== "compound" || tag.value === null || typeof tag.value !== "object") {
    return { metadata: {}, worldOrigin: null, weOffset: null };
  }
  const metadata: NbtCompound = { ...(tag.value as NbtCompound) };

  let weOffset: readonly [number, number, number] | null = null;
  if (format === "sponge2") {
    const x = numberOf(metadata.WEOffsetX);
    const y = numberOf(metadata.WEOffsetY);
    const z = numberOf(metadata.WEOffsetZ);
    // All three or none, as everywhere else: two thirds of a displacement is
    // not a displacement, and WorldEdit's own reader requires the trio.
    if (x !== null && y !== null && z !== null) {
      weOffset = [x, y, z];
      delete metadata.WEOffsetX;
      delete metadata.WEOffsetY;
      delete metadata.WEOffsetZ;
    }
  }

  const worldEditTag = metadata.WorldEdit;
  if (
    !worldEditTag ||
    worldEditTag.type !== "compound" ||
    worldEditTag.value === null ||
    typeof worldEditTag.value !== "object"
  ) {
    return { metadata, worldOrigin: null, weOffset };
  }

  const worldEdit: NbtCompound = { ...(worldEditTag.value as NbtCompound) };
  const worldOrigin = vectorOf(worldEdit.Origin);
  if (worldOrigin === null) {
    return { metadata, worldOrigin: null, weOffset };
  }

  delete worldEdit.Origin;
  if (Object.keys(worldEdit).length === 0) {
    delete metadata.WorldEdit;
  } else {
    metadata.WorldEdit = { type: "compound", value: worldEdit };
  }
  return { metadata, worldOrigin, weOffset };
}

/**
 * Sponge v3 moves the payload one level down, under a `Schematic` compound,
 * and the block arrays into a `Blocks` sub-compound. Everything else -- varint
 * data, YZX order, `name -> index` palette -- is unchanged from v2, which is
 * why the two share every decoder below the container.
 */
function detectFormat(root: NbtCompound): { format: SchematicFormat; payload: NbtCompound } {
  /*
   * Litematica first, and it has to be: its root carries neither `Width` nor
   * `Palette`, so it would fall past every branch below to the error -- but
   * `Regions` beside `Version` is a pair no other container here has, and
   * matching on the pair rather than on `Regions` alone is what keeps this from
   * claiming some future file that happens to have a compound by that name.
   */
  if (root.Regions !== undefined && root.Version !== undefined) {
    return { format: "litematic", payload: root };
  }
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
    // `payload` is already the right compound for both versions: v3's is the
    // `Schematic` compound and v2's is the root, which is where each writes it.
    ...spongeVectors(format, payload),
    dataVersion: numberOf(payload.DataVersion),
  };
}

/**
 * The anchor displacement and the world corner, which v2 and v3 spell in
 * opposite places.
 *
 * This is the one real incompatibility between the two versions and it is
 * silent both ways -- a file written with them swapped loads, looks right, and
 * pastes somewhere else. From WorldEdit's own writers and readers:
 *
 * | | v2 | v3 |
 * |---|---|---|
 * | `Offset` | the minimum corner, in world coordinates | the vector from the paste anchor |
 * | `Metadata` | `WEOffsetX/Y/Z`: the vector from the anchor | `WorldEdit.Origin`: the minimum corner |
 *
 * v2's reader then computes the anchor as `Offset - WEOffset`, which is the
 * same arithmetic MCEdit uses with `WEOrigin* - WEOffset*`. v3's spec puts it
 * plainly instead: "the relative offset of the schematic **from the paster**".
 *
 * Both are optional, and absent stays absent: a schematic with no anchor must
 * not acquire one at the corner of the build.
 */
function spongeVectors(
  format: "sponge2" | "sponge3",
  payload: NbtCompound,
): {
  offset: readonly [number, number, number] | null;
  worldOrigin: readonly [number, number, number] | null;
  metadata: NbtCompound;
} {
  const { metadata, worldOrigin, weOffset } = readMetadata(payload.Metadata, format);
  const declared = vectorOf(payload.Offset);

  if (format === "sponge3") {
    return { offset: declared, worldOrigin, metadata };
  }
  return {
    offset: weOffset,
    // `Offset` is v2's own spelling for the corner. The v3-style key is
    // accepted as a fallback because a file written by one of the tools that
    // stamps both is still a file somebody wants to open.
    worldOrigin: declared ?? worldOrigin,
    metadata,
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
    offset: mcEditVector(payload, "WEOffset"),
    // And the Origin as three more. All three or none: two thirds of a position
    // is not a position, and defaulting the missing one to zero would put the
    // build somewhere nobody asked for.
    worldOrigin: mcEditVector(payload, "WEOrigin"),
    // MCEdit has no `Metadata` compound at all -- WorldEdit writes its tags
    // straight onto the root, which is where `worldOrigin` just came from.
    metadata: {},
    // Legacy files predate DataVersion entirely.
    dataVersion: null,
  };
}

/**
 * `WEOffsetX/Y/Z` or `WEOriginX/Y/Z`, or `null` unless all three are there.
 *
 * All three or none, for both: two thirds of a position is not a position, and
 * defaulting the missing axis to zero would put the anchor somewhere nobody
 * asked for.
 */
function mcEditVector(
  payload: NbtCompound,
  prefix: "WEOffset" | "WEOrigin",
): readonly [number, number, number] | null {
  const x = numberOf(payload[`${prefix}X`]);
  const y = numberOf(payload[`${prefix}Y`]);
  const z = numberOf(payload[`${prefix}Z`]);
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
// --- Litematica ------------------------------------------------------------

/**
 * The `Metadata` fields this app recomputes on the way out.
 *
 * Lifted rather than kept, for `readMetadata`'s reason: every one of them is
 * derived from the blocks, so a copy left in the bag goes stale on the first
 * edit and is then written back out as fact. `TimeCreated` is deliberately
 * *not* here -- it is the one time in that compound this app does not own, and
 * a file that came from somebody else keeps theirs.
 */
export const LITEMATIC_DERIVED = [
  "EnclosingSize",
  "TotalBlocks",
  "TotalVolume",
  "RegionCount",
  "TimeModified",
];

/**
 * A litematic's `Metadata`, minus the fields this app recomputes.
 *
 * `readMetadata`'s counterpart, and shared with the NBT panel for that
 * function's reason: the panel builds the tree the writer would write, so it
 * has to strip exactly what the writer restamps or an Apply that edited nothing
 * would adopt a `TotalBlocks` from before the last edit.
 */
export function readLitematicMetadata(tag: NbtTag | undefined): NbtCompound {
  const metadata: NbtCompound =
    tag && tag.type === "compound" && tag.value !== null && typeof tag.value === "object"
      ? { ...(tag.value as NbtCompound) }
      : {};
  for (const key of LITEMATIC_DERIVED) delete metadata[key];
  return metadata;
}

/** `BlockStatePalette`: a list of `{ Name, Properties? }`, not Sponge's map. */
function readLitematicPalette(tag: NbtTag | undefined): PaletteEntry[] {
  return compoundList(tag).map((entry) => {
    const name = stringOf(entry.Name);
    const properties: Record<string, string> = {};
    const props = entry.Properties;
    if (
      props &&
      props.type === "compound" &&
      props.value !== null &&
      typeof props.value === "object"
    ) {
      for (const [key, valueTag] of Object.entries(props.value as NbtCompound)) {
        const value = stringOf(valueTag);
        if (value !== null) properties[key] = value;
      }
    }
    return { namespacedName: namespaced(name ?? "minecraft:air"), properties };
  });
}

/** One region's box, in the schematic's own coordinates. */
interface LitematicBox {
  readonly min: [number, number, number];
  readonly size: [number, number, number];
}

/**
 * Where a region actually sits, given that `Size` may be negative.
 *
 * A negative component means the region runs *back* from `Position`, so the
 * corner its block array is indexed from is `Position + Size + 1` rather than
 * `Position`. Litematica normalises on save, so every file anyone is likely to
 * open has positive sizes and the two agree -- which is exactly why this is
 * written down rather than assumed away. Getting the sign wrong mirrors the
 * region about its own corner, and a mirrored build still looks like a build.
 */
function litematicBox(region: NbtCompound): LitematicBox {
  const axis = (tag: NbtTag | undefined, key: string): number => {
    if (!tag || tag.type !== "compound" || tag.value === null || typeof tag.value !== "object") {
      return 0;
    }
    return numberOf((tag.value as NbtCompound)[key]) ?? 0;
  };
  const at = (key: string): [number, number] => {
    const p = axis(region.Position, key);
    const s = axis(region.Size, key);
    return [s < 0 ? p + s + 1 : p, Math.abs(s)];
  };
  const [minX, width] = at("x");
  const [minY, height] = at("y");
  const [minZ, length] = at("z");
  return { min: [minX, minY, minZ], size: [width, height, length] };
}

/**
 * Litematica, schematic version 5 and up.
 *
 * ## Several regions become one box
 *
 * A litematic may hold any number of named regions, each with its own position,
 * size and palette; this app has one document with one box. So the union of the
 * regions becomes the document, each region is written into it at its own
 * offset, and the palettes are merged. A cell no region covers is air, which is
 * what the gap between two regions already was.
 *
 * What that loses is the *partition*: saving puts one region back where there
 * were three. The blocks, the block entities and the entities all survive; the
 * seams do not. Keeping them would need a second notion of what a document is,
 * and a file that came apart into three documents would be worse.
 *
 * ## The union's minimum corner becomes (0,0,0)
 *
 * The grid has no negative index, so a region at a negative `Position` has to
 * move. Nothing records where it was, and deliberately: `Position` is a
 * displacement inside the schematic rather than a world coordinate, so writing
 * it into `worldOrigin` would claim a position in a world nobody named.
 * Litematica has no paste anchor either, which is why `anchorLocation` answers
 * `null` for this container.
 */
function decodeLitematic(root: NbtCompound): DecodedSchematic {
  const version = numberOf(root.Version);
  if (version === null) {
    throw new SchematicFormatError("This looks like a Litematica schematic but carries no Version");
  }
  if (version < LITEMATIC_MIN_VERSION) {
    throw new SchematicFormatError(
      `This is a Litematica schematic of version ${version}. Version ${LITEMATIC_MIN_VERSION} ` +
        `(Minecraft ${LITEMATIC_MIN_LABEL}) is the oldest that can be read: below it the palette ` +
        `is pre-Flattening numeric ids, which is a different table and a different decoder. ` +
        `Opening it in Litematica and saving it again converts it.`,
    );
  }

  const regionsTag = root.Regions;
  const regionsValue =
    regionsTag &&
    regionsTag.type === "compound" &&
    regionsTag.value !== null &&
    typeof regionsTag.value === "object"
      ? (regionsTag.value as NbtCompound)
      : {};
  const regions = Object.entries(regionsValue)
    .map(([name, tag]) => {
      const body = asCompound(tag, `Regions.${name}`);
      return { body, box: litematicBox(body) };
    })
    .filter((entry) => entry.box.size[0] > 0 && entry.box.size[1] > 0 && entry.box.size[2] > 0);

  if (regions.length === 0) {
    throw new SchematicFormatError(
      "This Litematica schematic has no regions with any volume in them",
    );
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const { box } of regions) {
    minX = Math.min(minX, box.min[0]);
    minY = Math.min(minY, box.min[1]);
    minZ = Math.min(minZ, box.min[2]);
    maxX = Math.max(maxX, box.min[0] + box.size[0] - 1);
    maxY = Math.max(maxY, box.min[1] + box.size[1] - 1);
    maxZ = Math.max(maxZ, box.min[2] + box.size[2] - 1);
  }
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const length = maxZ - minZ + 1;

  // Air first, so a cell no region covers is index 0 without a second pass.
  const palette: PaletteEntry[] = [{ namespacedName: "minecraft:air", properties: {} }];
  const paletteIndex = new Map<string, number>([[paletteEntryCacheKey(palette[0]), 0]]);
  const indices = new Int32Array(width * height * length);
  const blockEntities: BlockEntityRecord[] = [];
  const entities: EntityRecord[] = [];

  for (const { body, box } of regions) {
    const local = readLitematicPalette(body.BlockStatePalette);
    /*
     * Merged per region, because each carries its own palette. One shared cache
     * would be wrong the moment two regions number the same block differently,
     * which is the ordinary case rather than a strange one.
     */
    const remap = local.map((entry) => {
      const key = paletteEntryCacheKey(entry);
      const found = paletteIndex.get(key);
      if (found !== undefined) return found;
      const next = palette.length;
      palette.push(entry);
      paletteIndex.set(key, next);
      return next;
    });

    const [rw, rh, rl] = box.size;
    const statesTag = body.BlockStates;
    const words =
      statesTag && statesTag.type === "longArray" && Array.isArray(statesTag.value)
        ? longPairsToBigints(statesTag.value as [number, number][])
        : [];
    const packed = unpackLitematicStates(words, bitsPerEntry(local.length), rw * rh * rl);

    const dx = box.min[0] - minX;
    const dy = box.min[1] - minY;
    const dz = box.min[2] - minZ;
    for (let y = 0; y < rh; y += 1) {
      for (let z = 0; z < rl; z += 1) {
        for (let x = 0; x < rw; x += 1) {
          const value = remap[packed[y * rw * rl + z * rw + x]] ?? 0;
          if (value === 0) continue;
          // The document's own YZX order, which is Sponge's and MCEdit's too.
          indices[(y + dy) * width * length + (z + dz) * width + (x + dx)] = value;
        }
      }
    }

    /*
     * Read by the same two functions the other three containers use, and that
     * is worth saying out loud rather than glossing: Litematica spells a tile
     * entity with a lowercase `id` and separate `x`/`y`/`z` ints, which is
     * MCEdit's spelling, and an entity with `id` and a `Pos` of three doubles,
     * which is Sponge's. Both were already handled, permissively, years before
     * this container arrived.
     */
    for (const record of readBlockEntities(body.TileEntities)) {
      blockEntities.push({
        ...record,
        pos: [record.pos[0] + dx, record.pos[1] + dy, record.pos[2] + dz],
      });
    }
    for (const record of readEntities(body.Entities)) {
      entities.push({
        ...record,
        pos: [record.pos[0] + dx, record.pos[1] + dy, record.pos[2] + dz],
      });
    }
  }

  return {
    format: "litematic",
    width,
    height,
    length,
    palette,
    indices,
    unmappedLegacyIds: [],
    blockEntities,
    entities,
    offset: null,
    worldOrigin: null,
    metadata: readLitematicMetadata(root.Metadata),
    dataVersion: numberOf(root.MinecraftDataVersion),
  };
}

export function decodeSchematic(
  root: NbtCompound,
  legacyBlockTable: LegacyBlockTable | null,
): DecodedSchematic {
  const { format, payload } = detectFormat(unwrapRoot(root));

  if (format === "litematic") {
    return decodeLitematic(payload);
  }

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
