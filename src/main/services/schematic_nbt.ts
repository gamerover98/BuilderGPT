/**
 * The schematic's NBT, as text, and the text back again.
 *
 * What the NBT panel shows is **the root compound as this document's format
 * would write it**, minus the bulk block payload. That is the whole design, and
 * everything awkward here follows from it: an MCEdit document shows
 * `TileEntities` with a lowercase `id` and separate `x`/`y`/`z` ints, a Sponge
 * v3 one shows `BlockEntities` with `Id`, `Pos` and a nested `Data`, and
 * reading the text back goes through `readBlockEntities` / `readEntities` --
 * the *loader's* own decoders, which already accept all three spellings. There
 * is no second parser here to disagree with the first.
 *
 * ## What is omitted, and what is merely refused
 *
 * `Palette`, `PaletteMax`, the varint block data and MCEdit's `AddBlocks` are
 * **left out**. They are the schematic itself, they are rebuilt from the grid on
 * every save, and half a megabyte of varints in a textarea is not a feature.
 *
 * `Width`, `Height`, `Length`, `Version` and `Materials` are **shown and
 * refused**. Showing beats omitting -- they are the first thing anyone opens
 * this to check -- and refusing by name beats ignoring silently.
 *
 * ## One rule for applying: every key the read produced must still be there
 *
 * Delete `Offset` and it is refused by name rather than guessed at as
 * `[0,0,0]`; delete `BlockEntities` and it is refused rather than read as
 * "remove every chest". To empty a list you write `[]`. One rule, so there is
 * never a second mode in which a missing key means "leave it alone".
 *
 * ## The revision is an optimistic lock
 *
 * The text is fetched once, when the panel opens. Without a check, an Apply
 * built against that read would happily resurrect the entity list over an undo
 * that happened underneath it. The read hands out `doc.revision` and the apply
 * hands it back.
 */

import {
  documentSize,
  offsetFor,
  posKey,
  type SchematicDocument,
} from "../domain/document.js";
import {
  readHeader,
  type History,
  type HeaderState,
  runTransaction,
} from "../domain/history.js";
import { parseSnbt, stringifySnbt } from "../domain/snbt.js";
import {
  readBlockEntities,
  readEntities,
  readMetadata,
  type SchematicFormat,
} from "../pipeline/loader_formats.js";
import type {
  BlockEntityRecord,
  EntityRecord,
  NbtCompound,
  NbtTag,
} from "../pipeline/types.js";
import {
  compound,
  compoundList,
  int,
  mcEditEntities,
  mcEditEntries,
  short,
  spongeBlockEntities,
  spongeEntities,
  spongeMetadata,
  str,
} from "./writers.js";

/** Raised when the submitted text is well-formed NBT that this cannot accept. */
export class NbtApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NbtApplyError";
  }
}

/**
 * How much text the panel will hand over before it stops offering to edit.
 *
 * Not a design limit -- the same kind of number as `MAX_DOCUMENT_VOLUME`. A
 * schematic with tens of thousands of signs renders tens of megabytes of SNBT,
 * and a textarea holding that locks the window. Past either cap the two lists
 * are left out and the panel goes read-only, which keeps exactly one apply rule
 * rather than inventing a second one where absence means "leave alone".
 *
 * Two caps because neither alone is a proxy for the other: a shulker box of
 * shulker boxes is one entry and a great deal of text, and the entry count is
 * what makes the cheap check possible before anything is rendered.
 */
export const MAX_NBT_ENTRIES = 20_000;
export const MAX_NBT_TEXT = 2_000_000;

/** Which tags this refuses to let the text change, per format. */
const STRUCTURAL = ["Width", "Height", "Length", "Version", "Materials", "PaletteMax"];

/**
 * Tags a document can genuinely be without, so deleting one is an instruction
 * rather than a slip.
 *
 * This is the exception to "every key the read produced must still be there",
 * and the two are one rule seen from opposite sides: nothing is ever *guessed
 * at*. Deleting `BlockEntities` cannot mean anything — there is no state
 * "this schematic has no block-entity list", only one with nothing in it, which
 * is written `[]` — so it is a slip and is refused. Deleting `Offset` maps
 * exactly onto a state the document holds: no anchor. So it removes the anchor,
 * which is the same act as the modal's Delete button.
 */
const OPTIONAL = [
  "Offset",
  "WEOffsetX",
  "WEOffsetY",
  "WEOffsetZ",
  "WEOriginX",
  "WEOriginY",
  "WEOriginZ",
  "DataVersion",
  "Metadata",
];

export interface SchematicNbt {
  /** The header as SNBT. */
  readonly text: string;
  /** False when a cap was hit: the lists are absent and Apply is refused. */
  readonly editable: boolean;
  /** Tag names left out of the text, for the panel's hint. */
  readonly omitted: readonly string[];
  /** What `applyNbt` must be handed back, so a stale Apply is refused. */
  readonly revision: number;
}

// ---------------------------------------------------------------------------
// Building the tree
// ---------------------------------------------------------------------------

/** Where each format keeps its block-entity list, and what it calls it. */
function blockEntityKey(format: SchematicFormat): string {
  return format === "mcedit" ? "TileEntities" : "BlockEntities";
}

/**
 * The header the file would carry, as an NBT compound.
 *
 * `withLists` is what the cap turns off. Note that Sponge v3 keeps its block
 * entities inside `Blocks`, beside the palette and the varints that are not
 * here -- so `Blocks` appears with one key in it, which is exactly the file's
 * own shape minus the two omissions.
 */
export function schematicNbtTree(doc: SchematicDocument, withLists = true): NbtCompound {
  const [width, height, length] = documentSize(doc);

  if (doc.format === "mcedit") {
    return compound({
      Materials: str("Alpha"),
      Width: short(width),
      Height: short(height),
      Length: short(length),
      TileEntities: withLists
        ? compoundList(mcEditEntries(doc.blockEntities.values()))
        : undefined,
      Entities: withLists ? compoundList(mcEditEntities(doc.entities)) : undefined,
      WEOffsetX: doc.offset === null ? undefined : int(doc.offset[0]),
      WEOffsetY: doc.offset === null ? undefined : int(doc.offset[1]),
      WEOffsetZ: doc.offset === null ? undefined : int(doc.offset[2]),
      WEOriginX: doc.worldOrigin === null ? undefined : int(doc.worldOrigin[0]),
      WEOriginY: doc.worldOrigin === null ? undefined : int(doc.worldOrigin[1]),
      WEOriginZ: doc.worldOrigin === null ? undefined : int(doc.worldOrigin[2]),
    });
  }

  const version = doc.format === "sponge3" ? 3 : 2;
  const metadata: NbtTag = { type: "compound", value: spongeMetadata(doc, version) };
  // v3's `Offset` is the displacement from the anchor; v2's is the world
  // corner, and v2 keeps the displacement in `Metadata.WEOffset*`. The table is
  // in `spongeVectors` (`loader_formats.ts`).
  const declared = version === 3 ? doc.offset : doc.worldOrigin;
  const offsetTag: NbtTag | undefined =
    declared === null ? undefined : { type: "intArray", value: [...declared] };
  const blockEntities = withLists
    ? compoundList(spongeBlockEntities(doc.blockEntities.values(), version))
    : undefined;
  const entities = withLists ? compoundList(spongeEntities(doc.entities, version)) : undefined;

  if (version === 3) {
    return compound({
      Version: int(3),
      DataVersion: doc.dataVersion === null ? undefined : int(doc.dataVersion),
      Width: short(width),
      Height: short(height),
      Length: short(length),
      Offset: offsetTag,
      Metadata: metadata,
      // One key where the file has three. The other two are the schematic.
      Blocks: blockEntities === undefined ? undefined : {
        type: "compound",
        value: { BlockEntities: blockEntities },
      },
      Entities: entities,
    });
  }

  return compound({
    Version: int(2),
    DataVersion: doc.dataVersion === null ? undefined : int(doc.dataVersion),
    Width: short(width),
    Height: short(height),
    Length: short(length),
    Offset: offsetTag,
    BlockEntities: blockEntities,
    Entities: entities,
    Metadata: metadata,
  });
}

/** The tags this deliberately leaves out of the text, for the panel to name. */
export function omittedTags(format: SchematicFormat): string[] {
  if (format === "mcedit") return ["Blocks", "Data", "AddBlocks"];
  if (format === "sponge3") return ["Blocks.Palette", "Blocks.Data"];
  return ["Palette", "PaletteMax", "BlockData"];
}

/**
 * The tree to offer, and whether it is the whole document.
 *
 * Both sides go through here: the read renders it, and the apply asks it
 * whether the document was offerable at all. Deciding twice by two routes is
 * how "the panel let me edit it and then refused the edit" happens.
 */
function offerable(doc: SchematicDocument): { tree: NbtCompound; text: string; editable: boolean } {
  if (doc.blockEntities.size + doc.entities.length <= MAX_NBT_ENTRIES) {
    const tree = schematicNbtTree(doc, true);
    const text = stringifySnbt({ type: "compound", value: tree });
    if (text.length <= MAX_NBT_TEXT) {
      return { tree, text, editable: true };
    }
  }
  const tree = schematicNbtTree(doc, false);
  return { tree, text: stringifySnbt({ type: "compound", value: tree }), editable: false };
}

/** The document's NBT as text, or as much of it as is safe to offer. */
export function schematicNbtText(doc: SchematicDocument): SchematicNbt {
  const { text, editable } = offerable(doc);
  const omitted = omittedTags(doc.format);
  return {
    text,
    editable,
    omitted: editable ? omitted : [...omitted, blockEntityKey(doc.format), "Entities"],
    revision: doc.revision,
  };
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

function sameTag(a: NbtTag | undefined, b: NbtTag | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function requireCompound(tag: NbtTag | undefined, name: string): NbtCompound {
  if (!tag || tag.type !== "compound" || tag.value === null || typeof tag.value !== "object") {
    throw new NbtApplyError(`${name} must be a compound`);
  }
  return tag.value as NbtCompound;
}

/** Three ints, however they were spelled. */
function requireVector(tag: NbtTag | undefined, name: string): [number, number, number] {
  const raw = tag?.value;
  const items = Array.isArray(raw) ? raw : Array.isArray((raw as { value?: unknown })?.value)
    ? ((raw as { value: unknown[] }).value)
    : null;
  if (!items || items.length !== 3) {
    throw new NbtApplyError(`${name} must be three numbers, as [I; x, y, z]`);
  }
  const numbers = items.map((item) =>
    typeof item === "number" ? item : Number((item as NbtTag)?.value),
  );
  if (!numbers.every((value) => Number.isFinite(value))) {
    throw new NbtApplyError(`${name} must be three numbers, as [I; x, y, z]`);
  }
  return [numbers[0], numbers[1], numbers[2]];
}

function requireNumber(tag: NbtTag | undefined, name: string): number {
  if (!tag || typeof tag.value !== "number") {
    throw new NbtApplyError(`${name} must be a number`);
  }
  return tag.value;
}

/**
 * How many entries a list tag holds, so a decoder that silently skipped one can
 * be caught.
 *
 * `readBlockEntities` drops an entry with no usable id or position without a
 * word, which is right for a file somebody else wrote and wrong for a line
 * somebody just typed.
 */
function listLength(tag: NbtTag | undefined): number {
  const inner = (tag?.value ?? {}) as { value?: unknown };
  return Array.isArray(inner.value) ? inner.value.length : 0;
}

interface Parsed {
  readonly header: HeaderState;
  readonly blockEntities: readonly BlockEntityRecord[];
}

/**
 * Sponge v3 nests its block entities under `Blocks`; the others keep them at
 * the top. One place, because the read and the apply must agree on where to
 * look or a list would be read as missing from the very text that produced it.
 */
function blockEntityTagOf(compoundOf: NbtCompound, format: SchematicFormat): NbtTag | undefined {
  if (format !== "sponge3") {
    return compoundOf[blockEntityKey(format)];
  }
  const blocks = compoundOf.Blocks;
  if (!blocks || blocks.type !== "compound" || blocks.value === null) {
    return undefined;
  }
  return (blocks.value as NbtCompound).BlockEntities;
}

/**
 * Everything the submitted text says, validated, with nothing applied yet.
 *
 * Validation is complete before the first write for the usual reason: a
 * transaction that throws half way is rolled back, but a message naming the
 * fourth of six problems is still a worse experience than one naming the first.
 */
function parseHeader(doc: SchematicDocument, text: string, expected: NbtCompound): Parsed {
  const root = parseSnbt(text);
  if (root.type !== "compound") {
    throw new NbtApplyError("The text must be a compound, wrapped in { }");
  }
  const submitted = root.value as NbtCompound;

  // Every key the read produced, still present -- unless its absence is itself
  // a state the document can hold. Nothing is guessed at either way.
  for (const name of Object.keys(expected)) {
    if (!OPTIONAL.includes(name) && !(name in submitted)) {
      throw new NbtApplyError(`${name} is missing. To empty a list, write it as []`);
    }
  }
  for (const name of STRUCTURAL) {
    if (name in expected && !sameTag(submitted[name], expected[name])) {
      throw new NbtApplyError(
        `${name} is decided by the schematic itself and cannot be changed here`,
      );
    }
  }

  const mcedit = doc.format === "mcedit";
  const listKey = blockEntityKey(doc.format);

  const blockEntityTag = blockEntityTagOf(submitted, doc.format);
  if (blockEntityTag === undefined && blockEntityTagOf(expected, doc.format) !== undefined) {
    // The top-level walk above cannot see this one: for v3 the list is inside
    // `Blocks`, which is still there holding nothing.
    throw new NbtApplyError(`${listKey} is missing. To empty a list, write it as []`);
  }
  if (doc.format === "sponge3" && "Blocks" in submitted) {
    requireCompound(submitted.Blocks, "Blocks");
  }

  /**
   * One of MCEdit's two triples, present in full or not at all.
   *
   * Both are optional, so absence is a real answer -- and a partial trio is
   * refused rather than filled in, because the reader at the other end falls
   * back instead of guessing and the build would land somewhere nobody chose.
   */
  const mcEditTriple = (prefix: "WEOffset" | "WEOrigin"): [number, number, number] | null => {
    const axes = [`${prefix}X`, `${prefix}Y`, `${prefix}Z`] as const;
    const present = axes.filter((axis) => axis in submitted);
    if (present.length === 0) return null;
    if (present.length !== 3) {
      throw new NbtApplyError(
        `${axes.join(", ")} go together: ${present.join(", ")} alone says nothing`,
      );
    }
    return [
      requireNumber(submitted[axes[0]], axes[0]),
      requireNumber(submitted[axes[1]], axes[1]),
      requireNumber(submitted[axes[2]], axes[2]),
    ];
  };

  // Optional in every container, so writing a tag by hand creates the anchor
  // and deleting it removes one, exactly as the modal's buttons do.
  let offset: readonly [number, number, number] | null;
  let worldOrigin: readonly [number, number, number] | null;
  let metadata: NbtCompound;

  if (mcedit) {
    offset = mcEditTriple("WEOffset");
    worldOrigin = mcEditTriple("WEOrigin");
    metadata = {};
  } else {
    /*
     * The lift goes through the loader's own `readMetadata`, so the panel and
     * the file agree about where each vector lives -- which matters more here
     * than anywhere else, because v2 and v3 disagree: v3's `Offset` is the
     * displacement from the anchor and v2's is the world corner, with v2
     * keeping the displacement in `Metadata.WEOffset*`.
     */
    const lifted = readMetadata(submitted.Metadata, doc.format);
    const declared = "Offset" in submitted ? requireVector(submitted.Offset, "Offset") : null;
    if (doc.format === "sponge3") {
      offset = declared;
      worldOrigin = lifted.worldOrigin;
    } else {
      offset = lifted.weOffset;
      worldOrigin = declared;
    }

    /*
     * The bag alone gets a shortcut, and it has to be said explicitly rather
     * than fallen into. The tree the panel showed was built by
     * `spongeMetadata`, which stamps the app's own `Name` onto a document that
     * carries none -- so reading it back naively adopts the stamp, and pressing
     * Apply having edited nothing leaves a step on the undo stack and a dirty
     * document. What the file would contain is unchanged either way.
     *
     * Only the bag: the vectors above are read from the submitted text whatever
     * happens, or an edit to v2's `WEOffset*` would be thrown away by the very
     * shortcut that exists to preserve an unedited one.
     */
    metadata = sameTag(submitted.Metadata, expected.Metadata) ? doc.metadata : lifted.metadata;
  }

  // Block entities and entities, through the loader's own decoders.
  const blockEntities = readBlockEntities(blockEntityTag);
  const entities = readEntities(submitted.Entities);

  if (blockEntities.length !== listLength(blockEntityTag)) {
    throw new NbtApplyError(
      `Every entry in ${listKey} needs an id and a position; ${
        listLength(blockEntityTag) - blockEntities.length
      } of them has neither`,
    );
  }
  if (entities.length !== listLength(submitted.Entities)) {
    throw new NbtApplyError(
      `Every entry in Entities needs an id and a position; ${
        listLength(submitted.Entities) - entities.length
      } of them has neither`,
    );
  }

  const [width, height, length] = documentSize(doc);
  const seen = new Set<string>();
  for (const record of blockEntities) {
    const [x, y, z] = record.pos;
    if (x < 0 || x >= width || y < 0 || y >= height || z < 0 || z >= length) {
      throw new NbtApplyError(
        `${record.id} is at (${x}, ${y}, ${z}), which is outside this ${width}x${height}x${length} schematic`,
      );
    }
    const key = posKey(x, y, z);
    if (seen.has(key)) {
      throw new NbtApplyError(`Two entries in ${listKey} are both at (${x}, ${y}, ${z})`);
    }
    seen.add(key);
  }

  return {
    header: {
      offset,
      worldOrigin,
      dataVersion: mcedit ? null : submitted.DataVersion === undefined
        ? null
        : requireNumber(submitted.DataVersion, "DataVersion"),
      metadata,
      entities,
    },
    blockEntities,
  };
}

/** Whether two records are the same, so an unchanged chest records no delta. */
function sameRecord(a: BlockEntityRecord | undefined, b: BlockEntityRecord | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Writes edited SNBT onto the document, as one undoable step.
 *
 * Returns how many block entities moved, which is what an `EditResponse`
 * reports as `changed` -- the header itself has no count worth showing, and
 * saying `0` for an edit that renamed the schematic would read as a failure.
 */
export function applyNbt(
  doc: SchematicDocument,
  history: History,
  text: string,
  revision: number,
  label: string,
): number {
  if (revision !== doc.revision) {
    throw new NbtApplyError(
      "The schematic changed while this was open. Reopen the panel to see it as it is now.",
    );
  }

  const offer = offerable(doc);
  if (!offer.editable) {
    // The cap path. Decided here by the same function the read decides it by,
    // so the panel can never offer an edit this then refuses -- and refused
    // before anything is parsed, because text that never held the lists cannot
    // be the source of truth for them.
    throw new NbtApplyError(
      "This schematic is too large to edit as text, so the panel is read-only.",
    );
  }

  const parsed = parseHeader(doc, text, offer.tree);

  return runTransaction(doc, history, label, (tx) => {
    tx.setHeader({ ...readHeader(doc), ...parsed.header });

    const wanted = new Map<string, BlockEntityRecord>();
    for (const record of parsed.blockEntities) {
      wanted.set(posKey(record.pos[0], record.pos[1], record.pos[2]), record);
    }

    let changed = 0;
    for (const key of doc.blockEntities.keys()) {
      if (!wanted.has(key)) {
        const [x, y, z] = key.split(",").map(Number);
        tx.setBlockEntity(x, y, z, null);
        changed += 1;
      }
    }
    for (const [key, record] of wanted) {
      if (sameRecord(doc.blockEntities.get(key), record)) continue;
      tx.setBlockEntity(record.pos[0], record.pos[1], record.pos[2], record);
      changed += 1;
    }
    return changed;
  });
}

/**
 * WorldEdit's paste anchor, given as the **cell** it occupies.
 *
 * The negation between a cell and the stored offset lives in `anchorOf` /
 * `offsetFor`, and this is the only place the panel can reach it — so the modal
 * hands over what the user sees in the viewport and never has to know that the
 * tag holds the opposite sign.
 */
export function setWorldEditAnchor(
  doc: SchematicDocument,
  history: History,
  anchor: readonly [number, number, number] | null,
  label: string,
): void {
  runTransaction(doc, history, label, (tx) => {
    tx.setHeader({ ...readHeader(doc), offset: offsetFor(anchor) });
  });
}

/** The Origin on its own, for the panel's three number fields. */
export function setWorldOrigin(
  doc: SchematicDocument,
  history: History,
  origin: readonly [number, number, number] | null,
  label: string,
): void {
  runTransaction(doc, history, label, (tx) => {
    tx.setHeader({
      ...readHeader(doc),
      worldOrigin: origin === null ? null : [origin[0], origin[1], origin[2]],
    });
  });
}

export type { EntityRecord };
