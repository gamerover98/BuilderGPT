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
// directly (not the dependency-injection pattern — DI is reserved for
// genuinely no-equivalent cases, and this row explicitly narrows that
// pattern to exclude nbtlib now that a real package is named). Replaces
// loader.py:10-23's `try: import nbtlib except ImportError` optional-
// dependency guard (inventory.tsv row "module-level nbtlib import guard",
// loader.py:10-23) — resolved by the same rulebook decision as the
// translate.py/pymctranslate row per that inventory row's own note: bundle
// as a hard dependency, no runtime-optional path.
import { readFile } from "fs/promises";
import { parse as parseNbt } from "prismarine-nbt";

import type { PaletteEntry, StructureBounds, StructureData } from "./types.js";

/**
 * Loose shape of a decoded NBT tag as returned by `prismarine-nbt`'s
 * `parse()`. `prismarine-nbt` does not ship first-class TS types for the
 * tag tree shape in all versions, so this is a conservative structural
 * type covering the tags this file actually reads (short/int/compound/
 * byteArray/longArray).
 *
 * TODO(port): the exact `long`/`longArray` element representation
 * (`[high, low]` 32-bit signed pair, per node-protodef's convention, which
 * is what `prismarine-nbt` is built on) is asserted here from the library's
 * documented format, not verified by running it — RULEBOOK.md §0 forbids
 * running the compiler/build in this loop. Re-verify against the installed
 * `prismarine-nbt` version at Step 4's compile gate; if the shape differs,
 * only `longPairToBigUint64` below needs to change.
 */
interface NbtTag {
  readonly type: string;
  readonly value: unknown;
}

type NbtCompound = Record<string, NbtTag>;

function asCompound(tag: NbtTag | undefined, context: string): NbtCompound {
  if (!tag || typeof tag.value !== "object" || tag.value === null) {
    throw new Error(`Malformed schematic: expected compound tag for ${context}`);
  }
  return tag.value as NbtCompound;
}

/**
 * Fixed 2026-08-05 per Step 3 review (loader.ts reviewer 2): a missing Width/Height/
 * Length tag was silently coalescing to 0 via `?? 0` instead of failing loudly, unlike
 * Python's `int(root["Width"])`, which raises `KeyError` immediately on a missing key —
 * an unflagged behavior divergence on malformed input, inconsistent with this same
 * function's Palette handling (asCompound), which already throws. Required numeric tags
 * must throw, matching the source and the rest of this function's own pattern.
 */
function requireNumberTag(tag: NbtTag | undefined, context: string): number {
  if (!tag || typeof tag.value !== "number") {
    throw new Error(`Malformed schematic: expected numeric tag for ${context}`);
  }
  return tag.value;
}

/**
 * Unwraps the (sometimes-present) anonymous root compound that some NBT
 * writers nest the real payload under (`{"": {Width: ..., ...}}`).
 * `nbtlib.load` on the Python side transparently returns the payload
 * compound directly; `prismarine-nbt`'s `parse()` returns the raw root tag,
 * which may or may not have that extra empty-name wrapper depending on the
 * writer. TODO(port): narrow this once verified against real fixture files
 * at Step 4/5 — kept conservative (checks both shapes) per §2's UNKNOWN rule.
 */
function unwrapRoot(root: NbtCompound): NbtCompound {
  const keys = Object.keys(root);
  if (keys.length === 1 && keys[0] === "" && root[""]?.type === "compound") {
    return root[""].value as NbtCompound;
  }
  return root;
}

/** Ported from `_parse_palette_entry` (loader.py:26-40). */
function parsePaletteEntry(blockState: string): PaletteEntry {
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
 * `load_structure`'s BlockData/BlockStates format choice — RULEBOOK.md §2
 * canonical row (restated after Step 2 round 2 found the weaker
 * two-independently-optional-fields pattern shipped once already).
 * Resolved ONCE at parse time in `loadStructure` below; every downstream
 * consumer only ever sees this union, never the raw NBT tags.
 */
type SchemBlockData =
  | { readonly kind: "varint"; readonly data: readonly number[] }
  | { readonly kind: "packed"; readonly data: readonly bigint[]; readonly paletteSize: number };

/**
 * Converts a `prismarine-nbt` `long` element (`[high, low]`, both 32-bit
 * signed, per node-protodef convention — see the `NbtTag` TODO above) into
 * an unsigned 64-bit `bigint`, matching Python's
 * `int(long_val).to_bytes(8, "little", signed=False)` source semantics
 * (loader.py:156-157).
 */
function longPairToBigUint64(pair: readonly [number, number]): bigint {
  const [high, low] = pair;
  const highBits = BigInt(high >>> 0);
  const lowBits = BigInt(low >>> 0);
  return (highBits << 32n) | lowBits;
}

/**
 * `_decode_packed_block_states` (loader.py:43-71) — decodes legacy Sponge
 * schematic block data packed into 64-bit longs.
 *
 * Parameter type: RULEBOOK.md §2 "decode-function-parameter-types" row —
 * packed path takes `Uint8Array` (distinct, narrower than the shared
 * `Iterable[int]` the Python source used at loader.py:43-46; 32-bit-safe
 * arithmetic is fine here per the rulebook's bounds justification —
 * realistic palette sizes never approach where it wouldn't be).
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
 * `_decode_varint_block_data` (loader.py:74-105) — decodes schematic block
 * data stored as Minecraft-style VarInts.
 *
 * Parameter type: RULEBOOK.md §2 row — varint path is distinct from the
 * packed path's `Uint8Array` (this one takes the raw decoded NBT numeric
 * array). Precision: accumulates into a `bigint`, not a JS `number` with
 * `<<`/`|` (which truncate to 32-bit signed), so a 5th continuation byte
 * cannot silently lose precision the way round 2's stress test found
 * unflagged in the pilot's shared-signature translation.
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
        // Palette indices realistically fit well within int32; source also
        // stores into an np.int32 array (loader.py:80).
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

/**
 * Load a schematic structure from disk.
 *
 * Ported from `load_structure` (loader.py:108-168). Implements the Sponge
 * `.schem` format produced by the `mcschematic` library.
 */
export async function loadStructure(inputPath: string): Promise<StructureData> {
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
  const root = unwrapRoot(parsed.value as unknown as NbtCompound);

  const width = requireNumberTag(root.Width, "Width");
  const height = requireNumberTag(root.Height, "Height");
  const length = requireNumberTag(root.Length, "Length");

  const paletteTag = asCompound(root.Palette, "Palette");
  const paletteReverse = new Map<number, PaletteEntry>();
  for (const [blockState, valueTag] of Object.entries(paletteTag)) {
    paletteReverse.set(Number(valueTag.value), parsePaletteEntry(blockState));
  }

  let maxIndex = 0;
  for (const key of paletteReverse.keys()) {
    if (key > maxIndex) {
      maxIndex = key;
    }
  }
  const paletteList: PaletteEntry[] = [];
  for (let i = 0; i <= maxIndex; i += 1) {
    paletteList.push({ namespacedName: "minecraft:air", properties: {} });
  }
  for (const [paletteIndex, entry] of paletteReverse.entries()) {
    if (paletteIndex >= 0 && paletteIndex < paletteList.length) {
      paletteList[paletteIndex] = entry;
    }
  }

  const totalBlocks = width * height * length;

  // Discriminated union resolved ONCE here, per RULEBOOK.md §2's canonical
  // BlockData/BlockStates row — never re-checked downstream via two
  // independently-optional fields.
  let schemBlockData: SchemBlockData;
  const blockDataTag = root.BlockData;
  if (blockDataTag !== undefined) {
    // NBT byteArray tag: signed bytes. Match Python's `int(raw) & 0xFF`
    // masking inside the decode loop (loader.py:86) by passing raw numbers
    // through unchanged; masking happens inside `decodeVarintBlockData`.
    const rawData = Array.from(blockDataTag.value as ArrayLike<number>);
    schemBlockData = { kind: "varint", data: rawData };
  } else {
    // Legacy schematics may store data as a LongArray named `BlockStates`.
    const blockStatesTag = root.BlockStates;
    if (blockStatesTag === undefined) {
      throw new Error("Schematic does not contain BlockData or BlockStates");
    }
    schemBlockData = {
      kind: "packed",
      data: (blockStatesTag.value as ReadonlyArray<readonly [number, number]>).map(longPairToBigUint64),
      paletteSize: paletteList.length,
    };
  }

  let indices: Int32Array;
  switch (schemBlockData.kind) {
    case "varint":
      indices = decodeVarintBlockData(schemBlockData.data, totalBlocks);
      break;
    case "packed": {
      // Expand the packed longs into little-endian bytes, matching
      // loader.py:153-157 (`value.to_bytes(8, byteorder="little", signed=False)`).
      const rawBytes = new Uint8Array(schemBlockData.data.length * 8);
      let offset = 0;
      for (const longValue of schemBlockData.data) {
        for (let byteIndex = 0; byteIndex < 8; byteIndex += 1) {
          rawBytes[offset] = Number((longValue >> BigInt(8 * byteIndex)) & 0xffn);
          offset += 1;
        }
      }
      indices = decodePackedBlockStates(rawBytes, schemBlockData.paletteSize, totalBlocks);
      break;
    }
  }

  // Flat-index formula per RULEBOOK.md §2 "StructureData.voxels flat-array
  // index formula" row: x * height * length + y * length + z (row-major
  // over (width, height, length), matching numpy's C-order storage that
  // the source relies on).
  const voxels = new Int32Array(width * height * length);
  const limit = Math.min(indices.length, totalBlocks);
  for (let i = 0; i < limit; i += 1) {
    const x = i % width;
    const z = Math.floor(i / width) % length;
    const y = Math.floor(i / (width * length));
    voxels[x * height * length + y * length + z] = indices[i];
  }

  const bounds: StructureBounds = {
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: width - 1,
    maxY: height - 1,
    maxZ: length - 1,
  };

  return { bounds, palette: paletteList, voxels };
}

// PORT STATUS: confidence=medium todos=2
