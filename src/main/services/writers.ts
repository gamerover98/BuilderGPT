/**
 * Writing a `SchematicDocument` back out, in the container it came from.
 *
 * The app could read three formats and write exactly one -- Sponge v2, from
 * `SpongeSchematicWriter` -- so "save" could only ever mean "convert to v2",
 * and it emitted no block entities at all. Opening a v3 file with a stocked
 * barrel and saving it produced a v2 file with an empty one.
 *
 * ## The palette is rebuilt locally
 *
 * Not by calling `compactPalette` on the document: that renumbers entries the
 * undo stack still refers to, and saving must not cost you your history. Each
 * writer walks the voxels, builds its own dense palette, and leaves the
 * document exactly as it found it.
 *
 * ## MCEdit is lossy, and says so
 *
 * Pre-1.13 has no block states and no namespaced ids -- a block is a byte and
 * a nibble. Writing a modern document back to it therefore has two distinct
 * failure modes, kept distinct:
 *
 * - a block with **no legacy equivalent at all** (`minecraft:deepslate`) makes
 *   the save fail, with the offending blocks named. Silently turning them into
 *   air or stone would hand back a file that looks fine and is not.
 * - a block that exists but whose **state cannot be carried** (an oak stair's
 *   `shape=outer_left`) is written as the base block and reported as degraded.
 *   That is a real loss, but a recoverable one, and refusing the whole save
 *   over it would make the format useless.
 */

import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { gzip as gzipCb } from "zlib";

import { writeUncompressed } from "prismarine-nbt";

import {
  documentSize,
  type SchematicDocument,
} from "../domain/document.js";
import {
  loadLegacyBlockTable,
  parsePaletteEntry,
  type LegacyBlockTable,
  type SchematicFormat,
} from "../pipeline/loader_formats.js";
import {
  paletteEntryCacheKey,
  paletteEntryIsAir,
  type BlockEntityRecord,
  type EntityRecord,
  type NbtCompound,
  type NbtTag,
  type PaletteEntry,
} from "../pipeline/types.js";

const gzip = promisify(gzipCb);

const AIR_NAME = "minecraft:air";

/** Raised when the chosen container cannot represent some of the blocks. */
export class UnrepresentableBlocksError extends Error {
  constructor(
    readonly format: SchematicFormat,
    /** Namespaced ids, sorted, deduplicated. */
    readonly blocks: readonly string[],
  ) {
    const shown = blocks.slice(0, 6).join(", ");
    const rest = blocks.length - 6;
    super(
      `${blocks.length} block type(s) have no equivalent in the legacy ` +
        `.schematic format and would be lost: ${shown}${rest > 0 ? `, and ${rest} more` : ""}. ` +
        `Save as a Sponge schematic (.schem) instead.`,
    );
    this.name = "UnrepresentableBlocksError";
  }
}

export interface WriteOptions {
  /** Defaults to the document's own format, which is what "Save" means. */
  format?: SchematicFormat;
  /** Overrides the document's; required when it has none and the format wants one. */
  dataVersion?: number | null;
  /** Path to `legacy_blocks.json`. Required only to write MCEdit. */
  legacyBlocksPath?: string | null;
}

export interface WriteResult {
  readonly bytes: Buffer;
  readonly format: SchematicFormat;
  /**
   * Blocks that will not come back exactly as they went in, because the
   * container cannot express their state. Empty for both Sponge versions,
   * which always can.
   */
  readonly degraded: readonly string[];
}

// ---------------------------------------------------------------------------
// Shared: the local palette and the block data array
// ---------------------------------------------------------------------------

interface LocalPalette {
  /** Dense, air first, in write order. */
  readonly entries: PaletteEntry[];
  /** Document palette index -> local index. */
  readonly remap: Int32Array;
}

/**
 * The palette this file will actually carry: only the entries some voxel uses,
 * numbered from zero with air at index 0.
 *
 * Built per write and thrown away, so the document's own palette -- and every
 * index the undo stack holds against it -- is untouched.
 */
function buildLocalPalette(doc: SchematicDocument): LocalPalette {
  const used = new Uint8Array(doc.palette.length);
  for (const index of doc.voxels) {
    if (index >= 0 && index < used.length) {
      used[index] = 1;
    }
  }
  const remap = new Int32Array(doc.palette.length);
  const entries: PaletteEntry[] = [{ namespacedName: AIR_NAME, properties: {} }];
  for (let i = 0; i < doc.palette.length; i += 1) {
    const entry = doc.palette[i];
    if (paletteEntryIsAir(entry)) {
      remap[i] = 0;
      continue;
    }
    if (used[i] === 0) {
      remap[i] = 0;
      continue;
    }
    remap[i] = entries.length;
    entries.push(entry);
  }
  return { entries, remap };
}

/** Minecraft VarInt: 7 bits per byte, high bit = continuation. */
function writeVarint(out: number[], value: number): void {
  let remaining = value >>> 0;
  for (;;) {
    if ((remaining & ~0x7f) === 0) {
      out.push(remaining);
      return;
    }
    out.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
}

/** NBT byteArray elements are signed int8; 0..255 -> -128..127. */
function toSignedByte(byte: number): number {
  return (byte << 24) >> 24;
}

/**
 * Walks the document in YZX -- the linear order all three containers use --
 * handing each cell's local palette index to `visit`.
 *
 * The document itself is stored x-major (`x*h*l + y*l + z`), so this is where
 * the two orders are reconciled. Exactly one place, because getting it wrong
 * transposes the structure.
 */
function forEachCellYzx(
  doc: SchematicDocument,
  palette: LocalPalette,
  visit: (localIndex: number, x: number, y: number, z: number) => void,
): void {
  const [width, height, length] = documentSize(doc);
  for (let y = 0; y < height; y += 1) {
    for (let z = 0; z < length; z += 1) {
      for (let x = 0; x < width; x += 1) {
        const documentIndex = x * height * length + y * length + z;
        visit(palette.remap[doc.voxels[documentIndex]] ?? 0, x, y, z);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// NBT helpers
// ---------------------------------------------------------------------------

export const str = (value: string): NbtTag => ({ type: "string", value });
export const int = (value: number): NbtTag => ({ type: "int", value });
export const short = (value: number): NbtTag => ({ type: "short", value });

/**
 * A list of compounds, or `undefined` when there is nothing to write.
 *
 * Omitted rather than emitted empty on purpose: an empty NBT list has to
 * declare an element type it has no elements of, and readers disagree about
 * what belongs there. A missing tag is unambiguous.
 */
export function compoundList(entries: NbtCompound[]): NbtTag | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  return { type: "list", value: { type: "compound", value: entries } };
}

/** Drops the keys whose value is `undefined`, so optional tags simply vanish. */
export function compound(fields: Record<string, NbtTag | undefined>): Record<string, NbtTag> {
  const out: Record<string, NbtTag> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sponge v2 and v3
// ---------------------------------------------------------------------------

export function spongeBlockEntities(
  records: Iterable<BlockEntityRecord>,
  version: 2 | 3,
): NbtCompound[] {
  const out: NbtCompound[] = [];
  for (const record of records) {
    const identity: NbtCompound = {
      Id: str(record.id),
      Pos: { type: "intArray", value: [record.pos[0], record.pos[1], record.pos[2]] },
    };
    // v3 nests the payload under `Data`; v2 keeps it inline. The reader accepts
    // both, but a file has to pick one and be consistent about it.
    out.push(
      version === 3
        ? { ...identity, Data: { type: "compound", value: record.nbt } }
        : { ...identity, ...record.nbt },
    );
  }
  return out;
}

export function spongeEntities(records: readonly EntityRecord[], version: 2 | 3): NbtCompound[] {
  return records.map((record) => {
    const identity: NbtCompound = {
      Id: str(record.id),
      Pos: {
        type: "list",
        value: { type: "double", value: [record.pos[0], record.pos[1], record.pos[2]] },
      },
    };
    return version === 3
      ? { ...identity, Data: { type: "compound", value: record.nbt } }
      : { ...identity, ...record.nbt };
  });
}

/**
 * The `Metadata` compound: what the file arrived with, plus the Origin.
 *
 * Two orderings, and both are load-bearing. `Name` goes in *first*, so it is a
 * default that a schematic which arrived named overrides rather than a stamp
 * that overwrites it. `Origin` goes in *last* and is merged into whatever
 * `WorldEdit` sub-compound survived the load, so `Platforms` and
 * `EditingPlatform` come back out beside it instead of being replaced by a
 * sub-compound this app invented.
 *
 * A null origin writes no tag at all rather than `[I;0,0,0]`, which would tell
 * every tool downstream to paste the build at the world origin.
 */
export function spongeMetadata(doc: SchematicDocument): NbtCompound {
  const out: NbtCompound = { Name: str("Schematic AI Studio"), ...doc.metadata };
  if (doc.worldOrigin === null) {
    return out;
  }
  const carried = out.WorldEdit;
  const existing =
    carried && carried.type === "compound" && carried.value !== null && typeof carried.value === "object"
      ? (carried.value as NbtCompound)
      : {};
  out.WorldEdit = {
    type: "compound",
    value: { ...existing, Origin: { type: "intArray", value: [...doc.worldOrigin] } },
  };
  return out;
}

function buildSponge(doc: SchematicDocument, version: 2 | 3, dataVersion: number | null): unknown {
  const [width, height, length] = documentSize(doc);
  const palette = buildLocalPalette(doc);

  const varints: number[] = [];
  forEachCellYzx(doc, palette, (localIndex) => writeVarint(varints, localIndex));

  const paletteCompound: Record<string, NbtTag> = {};
  palette.entries.forEach((entry, index) => {
    paletteCompound[paletteEntryCacheKey(entry)] = int(index);
  });

  const blockEntities = compoundList(spongeBlockEntities(doc.blockEntities.values(), version));
  const entities = compoundList(spongeEntities(doc.entities, version));
  const blockData: NbtTag = { type: "byteArray", value: varints.map(toSignedByte) };
  const metadata: NbtTag = { type: "compound", value: spongeMetadata(doc) };

  if (version === 3) {
    // v3 moves the palette and block data into a `Blocks` compound, renames
    // `BlockData` to `Data`, and puts block entities alongside them.
    return {
      type: "compound",
      name: "",
      value: {
        Schematic: {
          type: "compound",
          value: compound({
            Version: int(3),
            DataVersion: dataVersion === null ? undefined : int(dataVersion),
            Width: short(width),
            Height: short(height),
            Length: short(length),
            Offset:
        doc.offset === null ? undefined : { type: "intArray", value: [...doc.offset] },
            Metadata: metadata,
            Blocks: {
              type: "compound",
              value: compound({
                Palette: { type: "compound", value: paletteCompound },
                Data: blockData,
                BlockEntities: blockEntities,
              }),
            },
            Entities: entities,
          }),
        },
      },
    };
  }

  return {
    type: "compound",
    name: "Schematic",
    value: compound({
      Version: int(2),
      DataVersion: dataVersion === null ? undefined : int(dataVersion),
      Width: short(width),
      Height: short(height),
      Length: short(length),
      Offset:
        doc.offset === null ? undefined : { type: "intArray", value: [...doc.offset] },
      PaletteMax: int(palette.entries.length),
      Palette: { type: "compound", value: paletteCompound },
      BlockData: blockData,
      BlockEntities: blockEntities,
      Entities: entities,
      Metadata: metadata,
    }),
  };
}

// ---------------------------------------------------------------------------
// MCEdit
// ---------------------------------------------------------------------------

interface LegacyId {
  readonly id: number;
  readonly meta: number;
}

interface ReverseLegacyTable {
  /** Exact `name[sorted=states]` -> id:meta. */
  readonly byState: ReadonlyMap<string, LegacyId>;
  /** Base name -> the lowest id:meta that produces it, for state-less fallback. */
  readonly byName: ReadonlyMap<string, LegacyId>;
}

let cachedReverse: { table: LegacyBlockTable; reverse: ReverseLegacyTable } | null = null;

/**
 * Inverts the flattening table.
 *
 * Both sides are re-keyed through `parsePaletteEntry` + `paletteEntryCacheKey`
 * so property order cannot decide a match -- the table spells
 * `grass_block[snowy=false]`, a document might spell the same state the other
 * way round, and a string compare would miss it.
 *
 * Where several `id:meta` produce the same modern state (74 of them do), the
 * numerically lowest wins, so the output is deterministic.
 */
export function buildReverseLegacyTable(table: LegacyBlockTable): ReverseLegacyTable {
  if (cachedReverse && cachedReverse.table === table) {
    return cachedReverse.reverse;
  }
  const byState = new Map<string, LegacyId>();
  const byName = new Map<string, LegacyId>();

  const rank = (a: LegacyId, b: LegacyId) => a.id - b.id || a.meta - b.meta;

  for (const [legacy, modern] of Object.entries(table)) {
    const [rawId, rawMeta] = legacy.split(":");
    const id = Number(rawId);
    const meta = Number(rawMeta);
    if (!Number.isInteger(id) || !Number.isInteger(meta)) {
      continue;
    }
    const candidate: LegacyId = { id, meta };
    const entry = parsePaletteEntry(modern);

    const stateKey = paletteEntryCacheKey(entry);
    const existingState = byState.get(stateKey);
    if (!existingState || rank(candidate, existingState) < 0) {
      byState.set(stateKey, candidate);
    }

    const existingName = byName.get(entry.namespacedName);
    if (!existingName || rank(candidate, existingName) < 0) {
      byName.set(entry.namespacedName, candidate);
    }
  }

  const reverse: ReverseLegacyTable = { byState, byName };
  cachedReverse = { table, reverse };
  return reverse;
}

/** Test seam: drops the memoised inversion. */
export function resetReverseLegacyCacheForTests(): void {
  cachedReverse = null;
}

export function mcEditEntries(
  records: Iterable<BlockEntityRecord>,
): NbtCompound[] {
  const out: NbtCompound[] = [];
  for (const record of records) {
    out.push({
      // MCEdit predates namespaces: `minecraft:chest` was just `Chest`. The
      // namespace is dropped rather than translated -- mapping modern block
      // entity ids onto their pre-flattening names needs a second table this
      // app does not vendor, and a wrong name is worse than a bare one.
      id: str(record.id.replace(/^[^:]*:/, "")),
      x: int(record.pos[0]),
      y: int(record.pos[1]),
      z: int(record.pos[2]),
      ...record.nbt,
    });
  }
  return out;
}

/** MCEdit's `Entities`: a bare `id` with the namespace dropped, and a Pos list. */
export function mcEditEntities(records: readonly EntityRecord[]): NbtCompound[] {
  return records.map((record) => ({
    id: str(record.id.replace(/^[^:]*:/, "")),
    Pos: {
      type: "list",
      value: { type: "double", value: [record.pos[0], record.pos[1], record.pos[2]] },
    },
    ...record.nbt,
  }));
}

function buildMcEdit(
  doc: SchematicDocument,
  reverse: ReverseLegacyTable,
): { root: unknown; degraded: string[] } {
  const [width, height, length] = documentSize(doc);
  const palette = buildLocalPalette(doc);

  // Resolve the palette once rather than per voxel: a 1M-block structure has
  // maybe fifty distinct blocks in it.
  const resolved: LegacyId[] = [];
  const missing = new Set<string>();
  const degraded = new Set<string>();
  for (const entry of palette.entries) {
    if (paletteEntryIsAir(entry)) {
      resolved.push({ id: 0, meta: 0 });
      continue;
    }
    const exact = reverse.byState.get(paletteEntryCacheKey(entry));
    if (exact) {
      resolved.push(exact);
      continue;
    }
    const base = reverse.byName.get(entry.namespacedName);
    if (base) {
      // The block survives; its exact state does not. Reported whether or not
      // it *had* properties, because the loss runs both ways: a stair with
      // `shape=outer_left` comes back without it, and a state-less
      // `minecraft:chest` comes back as `chest[facing=north,type=single]` --
      // MCEdit keeps a chest's orientation in the metadata nibble, so there is
      // no such thing as an unoriented one. Either way the block does not come
      // back as it went in, which is the only thing the caller needs told.
      degraded.add(paletteEntryCacheKey(entry));
      resolved.push(base);
      continue;
    }
    missing.add(entry.namespacedName);
    resolved.push({ id: 0, meta: 0 });
  }

  if (missing.size > 0) {
    throw new UnrepresentableBlocksError("mcedit", [...missing].sort());
  }

  const total = width * height * length;
  const blocks = new Array<number>(total).fill(0);
  const data = new Array<number>(total).fill(0);
  // Whether any id needs its high nibble is already decided by the resolved
  // palette, so the array is allocated up front rather than lazily inside the
  // loop -- which also keeps it out of the closure, where its type could not be
  // narrowed afterwards.
  const needsAddBlocks = resolved.some((legacy) => legacy.id > 0xff);
  const addBlocks = needsAddBlocks ? new Array<number>(Math.ceil(total / 2)).fill(0) : null;

  let cursor = 0;
  forEachCellYzx(doc, palette, (localIndex) => {
    const legacy = resolved[localIndex] ?? { id: 0, meta: 0 };
    blocks[cursor] = legacy.id & 0xff;
    data[cursor] = legacy.meta & 0x0f;
    if (addBlocks !== null && legacy.id > 0xff) {
      // Ids above 255 carry their high nibble in the packed `AddBlocks` array:
      // high nibble for an even index, low nibble for an odd one, matching what
      // the reader's `highNibble` expects.
      const high = (legacy.id >> 8) & 0x0f;
      addBlocks[cursor >> 1] |= (cursor & 1) === 0 ? high << 4 : high;
    }
    cursor += 1;
  });

  const root = {
    type: "compound",
    name: "Schematic",
    value: compound({
      Materials: str("Alpha"),
      Width: short(width),
      Height: short(height),
      Length: short(length),
      Blocks: { type: "byteArray", value: blocks.map(toSignedByte) },
      Data: { type: "byteArray", value: data.map(toSignedByte) },
      AddBlocks:
        addBlocks === null
          ? undefined
          : { type: "byteArray", value: addBlocks.map(toSignedByte) },
      TileEntities: compoundList(mcEditEntries(doc.blockEntities.values())),
      Entities: compoundList(mcEditEntities(doc.entities)),
      // Ints, not shorts, because WorldEdit's own writer uses ints -- and
      // because a short cannot hold the coordinate. A build cut from past
      // +-32767 on any axis failed the save outright: `prismarine-nbt` range
      // checks, so it threw out of the buffer writer with a message naming
      // neither the tag nor the document. The reader is unaffected either way,
      // since `numberOf` takes whichever it finds.
      WEOffsetX: doc.offset === null ? undefined : int(doc.offset[0]),
      WEOffsetY: doc.offset === null ? undefined : int(doc.offset[1]),
      WEOffsetZ: doc.offset === null ? undefined : int(doc.offset[2]),
      // The Origin, or nothing at all: `compound()` drops undefined, so the
      // three tags vanish together, which is what WorldEdit's reader needs --
      // it takes the trio or falls back, and two thirds of one is worse than
      // none.
      WEOriginX: doc.worldOrigin === null ? undefined : int(doc.worldOrigin[0]),
      WEOriginY: doc.worldOrigin === null ? undefined : int(doc.worldOrigin[1]),
      WEOriginZ: doc.worldOrigin === null ? undefined : int(doc.worldOrigin[2]),
    }),
  };

  return { root, degraded: [...degraded].sort() };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function writeDocument(
  doc: SchematicDocument,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const format = options.format ?? doc.format;
  const dataVersion = options.dataVersion !== undefined ? options.dataVersion : doc.dataVersion;

  let root: unknown;
  let degraded: readonly string[] = [];

  if (format === "mcedit") {
    if (!options.legacyBlocksPath) {
      throw new Error(
        "Writing a legacy .schematic needs the block conversion table (legacy_blocks.json)",
      );
    }
    const table = await loadLegacyBlockTable(options.legacyBlocksPath);
    const built = buildMcEdit(doc, buildReverseLegacyTable(table));
    root = built.root;
    degraded = built.degraded;
  } else {
    root = buildSponge(doc, format === "sponge3" ? 3 : 2, dataVersion);
  }

  const raw = writeUncompressed(root as never, "big");
  return { bytes: await gzip(raw), format, degraded };
}

/** Writes the document to disk. Creates the containing directory if needed. */
export async function saveDocument(
  doc: SchematicDocument,
  filePath: string,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const result = await writeDocument(doc, options);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, result.bytes);
  return result;
}

/** The extension a format is conventionally stored under. */
export function extensionFor(format: SchematicFormat): string {
  return format === "mcedit" ? "schematic" : "schem";
}
