/**
 * `services/writers.ts` — writing a document back out.
 *
 * The referee is a round trip through the app's own reader, which is itself
 * parity-checked against hand-built fixtures in `schematics.ts`: build a
 * document, save it, load it, adopt it, and require the two documents to agree
 * block for block and chest for chest.
 *
 * That is a stronger test than comparing NBT, because it is indifferent to how
 * the file spells things and sensitive to whether the information survived --
 * which is the only property that matters here. The app used to write exactly
 * one format and no block entities at all, so a v3 file with a stocked barrel
 * came back as a v2 file with an empty one.
 */

import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { promisify } from "util";
import { gzip as gzipCb } from "zlib";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

import { parse as parseNbt, writeUncompressed } from "prismarine-nbt";

const gzipAsync = promisify(gzipCb);

import {
  applyNbt,
  omittedTags,
  schematicNbtText,
  schematicNbtTree,
} from "../src/main/services/schematic_nbt.js";
import { createHistory } from "../src/main/domain/history.js";
import type { NbtCompound } from "../src/main/pipeline/types.js";

import {
  countBlocks,
  createDocument,
  documentFromLoaded,
  getBlock,
  getBlockEntity,
  internPalette,
  setBlock,
  setBlockEntity,
  type SchematicDocument,
} from "../src/main/domain/document.js";
import { loadStructure } from "../src/main/pipeline/loader.js";
import { contentBounds, cropToContent } from "../src/main/domain/crop.js";
import { paletteEntryCacheKey, type PaletteEntry } from "../src/main/pipeline/types.js";
import { posKey } from "../src/main/domain/document.js";
import {
  extensionFor,
  int,
  saveDocument,
  UnrepresentableBlocksError,
} from "../src/main/services/writers.js";
import { dataVersionFor } from "../src/main/services/versions.js";
import { bitsPerEntry } from "../src/main/pipeline/litematic_bits.js";
import { parseMcfunction } from "../src/main/pipeline/mcfunction.js";
import { convertFile, extensionForKind } from "../src/main/services/convert.js";
import {
  buildMcfunction,
  mcfunctionCommands,
  saveMcfunction,
} from "../src/main/services/mcfunction_writer.js";

/** Written out rather than typed, because this file is checked in as LF. */
const NEWLINE = String.fromCharCode(10);
import {
  LITEMATIC_MIN_DATA_VERSION,
  LITEMATIC_VERSIONS,
  litematicCanCarry,
  litematicVersionFor,
} from "../src/shared/litematica_versions.js";
import {
  COMMAND_FORMS,
  MAX_COMMANDS_PER_FUNCTION,
  MAX_FILL_VOLUME,
  MCFUNCTION_MIN_DATA_VERSION,
  commandLimit,
} from "../src/shared/command_syntax.js";
import { dataVersionFor as _unusedDataVersionFor, VERSION_NAMES } from "../src/main/services/versions.js";
import {
  anchorLocation,
  originLocation,
  SCHEMATIC_FORMATS,
  schematicExtension,
  tagPathLabel,
  type TagLocation,
} from "../src/shared/schematic.js";
import {
  dataVersionOf,
  eraOf,
  formatsFor,
  formatSupportsVersion,
  MC_VERSION_NAMES,
  MC_VERSIONS,
  mcVersion,
  refusalFor,
  versionNameOf,
} from "../src/shared/mc_versions.js";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failures += 1;
  }
}

function equal(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.log(`         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  check(label, ok);
}

const block = (name: string, properties: Record<string, string> = {}): PaletteEntry => ({
  namespacedName: name,
  properties,
});

import {
  buildLegacyIndex,
  legacyIdLabel,
  parseLegacyId,
} from "../src/shared/legacy_ids.js";
import { loadLegacyBlockTable } from "../src/main/pipeline/loader_formats.js";
import { buildReverseLegacyTable } from "../src/main/services/writers.js";
const LEGACY_BLOCKS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "resources",
  "legacy_blocks.json",
);

/** Every cell as `name[states]` — the strict comparison, for Sponge. */
function grid(doc: SchematicDocument): string {
  return cells(doc, (entry) => paletteEntryCacheKey(entry));
}

/** Every cell as just the block name — what MCEdit can promise. */
function names(doc: SchematicDocument): string {
  return cells(doc, (entry) => entry.namespacedName);
}

function cells(doc: SchematicDocument, describe: (entry: PaletteEntry) => string): string {
  const out: string[] = [];
  for (let x = 0; x < doc.width; x += 1) {
    for (let y = 0; y < doc.height; y += 1) {
      for (let z = 0; z < doc.length; z += 1) {
        out.push(describe(getBlock(doc, x, y, z)));
      }
    }
  }
  return out.join(",");
}

/**
 * A document exercising the things that go wrong: a non-cubic box so a
 * transposed axis cannot pass by luck, blocks with and without states, two
 * block entities with real payloads, an entity off the grid, and a non-zero
 * world offset.
 */
function sampleDocument(format: SchematicDocument["format"]): SchematicDocument {
  const doc = createDocument({
    width: 5,
    height: 3,
    length: 4,
    format,
    dataVersion: dataVersionFor("JE_1_20_4"),
  });
  setBlock(doc, 0, 0, 0, block("minecraft:stone"));
  setBlock(doc, 4, 0, 0, block("minecraft:cobblestone"));
  setBlock(doc, 0, 2, 3, block("minecraft:glass"));
  setBlock(doc, 1, 1, 1, block("minecraft:oak_planks"));
  setBlock(doc, 2, 0, 2, block("minecraft:chest"));
  setBlock(doc, 3, 0, 2, block("minecraft:oak_sign"));
  doc.offset = [-12, 64, 7];
  // A different vector from the offset, deliberately: a writer that confused
  // the two would still round-trip if they held the same numbers.
  doc.worldOrigin = [201, 92, 3];
  // Two tags the app has no opinion about, which must come back untouched --
  // one beside the Origin inside `WorldEdit`, one at the top of the bag.
  doc.metadata = {
    Author: { type: "string", value: "gamerover98" },
    WorldEdit: {
      type: "compound",
      value: { EditingPlatform: { type: "string", value: "intellectualsites:bukkit" } },
    },
  };

  setBlockEntity(doc, 2, 0, 2, {
    id: "minecraft:chest",
    pos: [2, 0, 2],
    nbt: {
      Items: {
        type: "list",
        value: {
          type: "compound",
          value: [
            { id: { type: "string", value: "minecraft:diamond" }, Count: { type: "byte", value: 5 } },
          ],
        },
      },
    },
  });
  setBlockEntity(doc, 3, 0, 2, {
    id: "minecraft:oak_sign",
    pos: [3, 0, 2],
    nbt: { Text1: { type: "string", value: '{"text":"round trip"}' } },
  });
  doc.entities = [
    {
      id: "minecraft:armor_stand",
      pos: [1.5, 0, 2.5],
      nbt: { Invisible: { type: "byte", value: 1 } },
    },
  ];
  return doc;
}

/**
 * The same idea as `sampleDocument`, in blocks the pre-1.13 table knows.
 *
 * MCEdit has no oak sign and refuses the whole save over it, which is the
 * behaviour the format section tests deliberately -- so anything that wants an
 * MCEdit file of its own needs a document that can become one.
 */
function legacySafeDocument(): SchematicDocument {
  const doc = createDocument({ width: 4, height: 2, length: 3, format: "mcedit" });
  setBlock(doc, 0, 0, 0, block("minecraft:stone"));
  setBlock(doc, 1, 0, 0, block("minecraft:oak_planks"));
  setBlock(doc, 2, 0, 1, block("minecraft:chest"));
  doc.offset = [-8, 32, 5];
  doc.worldOrigin = [201, 92, 3];
  setBlockEntity(doc, 2, 0, 1, {
    id: "minecraft:chest",
    pos: [2, 0, 1],
    nbt: { Lock: { type: "string", value: "key" } },
  });
  doc.entities = [
    { id: "minecraft:armor_stand", pos: [1.5, 0, 2.5], nbt: { Invisible: { type: "byte", value: 1 } } },
  ];
  return doc;
}

console.log("=== Schematic AI Studio: writers ===\n");

const workDir = await mkdtemp(path.join(tmpdir(), "bgpt-write-"));

try {
  // --- Sponge, both versions ------------------------------------------------
  for (const format of ["sponge2", "sponge3"] as const) {
    console.log(`--- ${format} round trip ---`);
    const original = sampleDocument(format);
    const filePath = path.join(workDir, `round-trip-${format}.${extensionFor(format)}`);
    const result = await saveDocument(original, filePath, { legacyBlocksPath: LEGACY_BLOCKS });

    equal("written in the document's own format", result.format, format);
    equal("Sponge loses nothing, so nothing is reported degraded", result.degraded, []);

    const reloaded = documentFromLoaded(await loadStructure(filePath), filePath);
    equal("the reader agrees on the format", reloaded.format, format);
    equal(
      "dimensions survive",
      [reloaded.width, reloaded.height, reloaded.length],
      [original.width, original.height, original.length],
    );
    equal("every voxel survives", grid(reloaded), grid(original));
    equal("the block count agrees", countBlocks(reloaded), countBlocks(original));
    equal("the world offset survives", reloaded.offset, original.offset);
    equal("the WorldEdit Origin survives beside it", reloaded.worldOrigin, original.worldOrigin);
    equal(
      "...and the metadata the app has no opinion about",
      reloaded.metadata,
      {
        // The app's own Name is a default, so a document that carried none
        // acquires it; everything the file held is over the top of it.
        Name: { type: "string", value: "Schematic AI Studio" },
        Author: { type: "string", value: "gamerover98" },
        WorldEdit: {
          type: "compound",
          value: { EditingPlatform: { type: "string", value: "intellectualsites:bukkit" } },
        },
      },
    );
    equal("the DataVersion survives", reloaded.dataVersion, original.dataVersion);

    equal("both block entities come back", reloaded.blockEntities.size, 2);
    equal("the chest is at its position", getBlockEntity(reloaded, 2, 0, 2)?.id, "minecraft:chest");
    equal(
      "...with its contents byte for byte",
      JSON.stringify(getBlockEntity(reloaded, 2, 0, 2)?.nbt),
      JSON.stringify(getBlockEntity(original, 2, 0, 2)?.nbt),
    );
    equal(
      "the sign keeps its text",
      JSON.stringify(getBlockEntity(reloaded, 3, 0, 2)?.nbt),
      JSON.stringify(getBlockEntity(original, 3, 0, 2)?.nbt),
    );
    equal(
      "the entity keeps its fractional position",
      reloaded.entities.map((e) => [e.id, e.pos]),
      [["minecraft:armor_stand", [1.5, 0, 2.5]]],
    );
    console.log("");
  }

  // --- the palette written is the palette used ------------------------------
  console.log("--- the file carries no dead palette entries ---");
  {
    const doc = sampleDocument("sponge3");
    // Interning without placing is exactly what an edit-then-undo leaves behind.
    internPalette(doc, block("minecraft:diamond_block"));
    internPalette(doc, block("minecraft:bedrock"));
    const before = doc.palette.length;

    const filePath = path.join(workDir, "dead-entries.schem");
    await saveDocument(doc, filePath);
    const reloaded = documentFromLoaded(await loadStructure(filePath), filePath);

    check(
      "entries no voxel uses are left out of the file",
      reloaded.palette.length < before,
      `document had ${before}, file produced ${reloaded.palette.length}`,
    );
    equal("...without disturbing the document's own palette", doc.palette.length, before);
    equal("...and the blocks are unaffected", grid(reloaded), grid(doc));
  }

  // --- format conversion ----------------------------------------------------
  console.log("\n--- saving in a different format than the source ---");
  {
    const doc = sampleDocument("sponge2");
    const filePath = path.join(workDir, "converted.schem");
    const result = await saveDocument(doc, filePath, { format: "sponge3" });
    equal("the override wins over the document's format", result.format, "sponge3");
    const reloaded = documentFromLoaded(await loadStructure(filePath), filePath);
    equal("the file really is v3", reloaded.format, "sponge3");
    equal("the blocks came across", grid(reloaded), grid(doc));
    equal("so did the chest", getBlockEntity(reloaded, 2, 0, 2)?.id, "minecraft:chest");
  }

  // --- MCEdit ---------------------------------------------------------------
  console.log("\n--- MCEdit round trip ---");
  {
    // Only blocks the pre-1.13 table knows, since that is the format's whole
    // limitation and the next section tests the failure separately.
    const doc = createDocument({ width: 4, height: 2, length: 3, format: "mcedit" });
    setBlock(doc, 0, 0, 0, block("minecraft:stone"));
    setBlock(doc, 1, 0, 0, block("minecraft:oak_planks"));
    setBlock(doc, 3, 1, 2, block("minecraft:glass"));
    setBlock(doc, 2, 0, 1, block("minecraft:chest"));
    // Past a short on two axes. WorldEdit writes these as ints and this app
    // wrote shorts, so before the fix saving a build cut from the far end of a
    // world did not wrap -- it threw, out of `prismarine-nbt`'s buffer writer,
    // naming neither the tag nor the file.
    doc.offset = [-40000, 32, 70000];
    doc.worldOrigin = [201, 92, 3];
    setBlockEntity(doc, 2, 0, 1, {
      id: "minecraft:chest",
      pos: [2, 0, 1],
      nbt: { Lock: { type: "string", value: "key" } },
    });

    const filePath = path.join(workDir, "round-trip.schematic");
    const result = await saveDocument(doc, filePath, { legacyBlocksPath: LEGACY_BLOCKS });
    equal("written as MCEdit", result.format, "mcedit");

    /*
     * The loaded structure is kept, not just the document built from it:
     * `unmappedLegacyIds` is reported by the *loader* and does not survive into
     * `SchematicDocument`. Reading it off the document -- which is what this
     * did until tests/ was typechecked -- yields `undefined`, so the assertion
     * below compared `[]` against `[]` and could never fail.
     */
    const loaded = await loadStructure(filePath, { legacyBlocksPath: LEGACY_BLOCKS });
    const reloaded = documentFromLoaded(loaded, filePath);
    equal("the reader agrees", reloaded.format, "mcedit");
    equal(
      "dimensions survive",
      [reloaded.width, reloaded.height, reloaded.length],
      [4, 2, 3],
    );
    // Base names, not exact states. MCEdit stores a block as a byte and a
    // nibble, so a state-less `minecraft:chest` necessarily comes back as
    // `chest[facing=north,type=single]` -- the nibble has to say *something*
    // about which way it faces. What the format can promise is the block, and
    // that is what is asserted; the difference is reported through `degraded`,
    // checked below.
    equal("every block survives the numeric-id round trip", names(reloaded), names(doc));
    equal("no legacy id went unmapped on the way back", [...loaded.unmappedLegacyIds], []);
    check(
      "the chest, whose orientation the format invents, is reported",
      result.degraded.includes("minecraft:chest"),
      JSON.stringify(result.degraded),
    );
    check(
      "a block that round trips exactly is not reported",
      !result.degraded.includes("minecraft:stone"),
      JSON.stringify(result.degraded),
    );
    equal(
      "the WorldEdit offset survives its three ints, past a short on two axes",
      reloaded.offset,
      [-40000, 32, 70000],
    );
    equal("the WorldEdit Origin survives its own three", reloaded.worldOrigin, [201, 92, 3]);
    equal("the chest survives", getBlockEntity(reloaded, 2, 0, 1)?.id, "minecraft:chest");
    equal(
      "...with its payload",
      JSON.stringify(getBlockEntity(reloaded, 2, 0, 1)?.nbt.Lock),
      JSON.stringify({ type: "string", value: "key" }),
    );
  }

  // --- MCEdit refuses what it cannot represent ------------------------------
  //
  // The behaviour the plan asked for by name: never degrade in silence. A block
  // the legacy table has never heard of stops the save and says which.
  console.log("\n--- MCEdit refuses modern blocks ---");
  {
    const doc = createDocument({ width: 2, height: 1, length: 1, format: "mcedit" });
    setBlock(doc, 0, 0, 0, block("minecraft:stone"));
    setBlock(doc, 1, 0, 0, block("minecraft:deepslate_tiles"));

    let thrown: unknown = null;
    try {
      await saveDocument(doc, path.join(workDir, "refused.schematic"), {
        legacyBlocksPath: LEGACY_BLOCKS,
      });
    } catch (err) {
      thrown = err;
    }
    check("the save fails rather than dropping the block", thrown instanceof UnrepresentableBlocksError);
    check(
      "the message names the offending block",
      thrown instanceof Error && thrown.message.includes("minecraft:deepslate_tiles"),
      thrown instanceof Error ? thrown.message : String(thrown),
    );
    check(
      "...and points at the format that can hold it",
      thrown instanceof Error && thrown.message.includes(".schem"),
    );

    // The same document is perfectly writable as Sponge, which is the point of
    // the suggestion in that message.
    const rescued = path.join(workDir, "rescued.schem");
    await saveDocument(doc, rescued, { format: "sponge3" });
    const reloaded = documentFromLoaded(await loadStructure(rescued), rescued);
    equal("the modern block survives a Sponge save", grid(reloaded), grid(doc));
  }

  // --- MCEdit reports what it flattens --------------------------------------
  console.log("\n--- MCEdit reports lost block states ---");
  {
    const doc = createDocument({ width: 2, height: 1, length: 1, format: "mcedit" });
    // A state combination the flattening table does not enumerate: the block
    // exists in 1.12, this exact state does not round-trip through a nibble.
    setBlock(doc, 0, 0, 0, block("minecraft:oak_stairs", { facing: "north", shape: "outer_left" }));
    setBlock(doc, 1, 0, 0, block("minecraft:stone"));

    const filePath = path.join(workDir, "degraded.schematic");
    const result = await saveDocument(doc, filePath, { legacyBlocksPath: LEGACY_BLOCKS });

    check("the save succeeds", result.bytes.length > 0);
    check(
      "the flattened block is reported, not swallowed",
      result.degraded.some((id) => id.startsWith("minecraft:oak_stairs")),
      JSON.stringify(result.degraded),
    );
    check(
      "a block that survived intact is not reported",
      !result.degraded.some((id) => id.startsWith("minecraft:stone")),
    );

    const reloaded = documentFromLoaded(
      await loadStructure(filePath, { legacyBlocksPath: LEGACY_BLOCKS }),
      filePath,
    );
    equal(
      "the block itself is still a staircase",
      getBlock(reloaded, 0, 0, 0).namespacedName,
      "minecraft:oak_stairs",
    );
    equal("and the untouched block is untouched", getBlock(reloaded, 1, 0, 0).namespacedName, "minecraft:stone");
  }

  // --- MCEdit needs its table -----------------------------------------------
  console.log("\n--- MCEdit without the table ---");
  {
    const doc = createDocument({ width: 1, height: 1, length: 1, format: "mcedit" });
    setBlock(doc, 0, 0, 0, block("minecraft:stone"));
    let thrown: unknown = null;
    try {
      await saveDocument(doc, path.join(workDir, "no-table.schematic"));
    } catch (err) {
      thrown = err;
    }
    check(
      "writing MCEdit without the flattening table fails explicitly",
      thrown instanceof Error && thrown.message.includes("legacy_blocks.json"),
      thrown instanceof Error ? thrown.message : String(thrown),
    );
  }

  // --- an empty document ----------------------------------------------------
  console.log("\n--- degenerate cases ---");
  {
    const doc = createDocument({ width: 1, height: 1, length: 1, format: "sponge3" });
    const filePath = path.join(workDir, "empty.schem");
    await saveDocument(doc, filePath);
    const reloaded = documentFromLoaded(await loadStructure(filePath), filePath);
    equal("an all-air document round trips", countBlocks(reloaded), 0);
    equal("...at the right size", [reloaded.width, reloaded.height, reloaded.length], [1, 1, 1]);
    equal("...with no block entities invented", reloaded.blockEntities.size, 0);
  }

  // --- the anchor is optional, in every container ---------------------------
  //
  // A schematic without one must write no tag at all. `[0,0,0]` is a position
  // like any other — the corner of the build — so a default would claim a pivot
  // nobody placed, and every tool downstream would honour it.
  console.log("\n--- an optional anchor ---");
  for (const format of ["sponge2", "sponge3", "mcedit"] as const) {
    const doc = format === "mcedit" ? legacySafeDocument() : sampleDocument(format);
    doc.offset = null;

    const filePath = path.join(workDir, `no-anchor-${format}.${extensionFor(format)}`);
    await saveDocument(doc, filePath, { legacyBlocksPath: LEGACY_BLOCKS });

    const { parsed } = await parseNbt(await readFile(filePath));
    const root = parsed.value as unknown as NbtCompound;
    const payload =
      format === "sponge3" ? (root.Schematic as { value: NbtCompound }).value : root;

    /*
     * Where the anchor would have been, per container. The three are genuinely
     * different places, and v2 is the one that catches people out: its `Offset`
     * tag is the world corner, and the anchor displacement lives in
     * `Metadata.WEOffsetX/Y/Z` — so checking `Offset` there would test nothing.
     */
    const metadata = (payload.Metadata as { value?: NbtCompound } | undefined)?.value ?? {};
    const where: Record<string, NbtCompound> =
      format === "sponge2" ? { WEOffsetX: metadata, WEOffsetY: metadata, WEOffsetZ: metadata }
      : format === "mcedit" ? { WEOffsetX: payload, WEOffsetY: payload, WEOffsetZ: payload }
      : { Offset: payload };

    for (const [tag, holder] of Object.entries(where)) {
      check(
        `${format}: ${tag} is absent, not zero`,
        !(tag in holder),
        Object.keys(holder).join(),
      );
    }

    const reloaded = documentFromLoaded(await loadStructure(filePath, {
      legacyBlocksPath: LEGACY_BLOCKS,
    }), filePath);
    equal(`${format}: and it comes back with no anchor`, reloaded.offset, null);

    // The marker is not a block: a document with an anchor and one without have
    // the same grid, the same count, and the same palette in the file.
    const anchored = format === "mcedit" ? legacySafeDocument() : sampleDocument(format);
    equal(`${format}: an anchor changes no blocks`, countBlocks(anchored), countBlocks(doc));
  }

  // --- v2 and v3 mean different things by "Offset" --------------------------
  //
  // The one real incompatibility between the two Sponge versions, and it is
  // silent in both directions: a file written with them swapped loads, looks
  // right, and pastes somewhere else entirely. From WorldEdit's own writer,
  // `Offset` in v2 is `min` — the world corner — with the anchor displacement
  // in `Metadata.WEOffsetX/Y/Z`; v3's spec says `Offset` is "the relative
  // offset of the schematic from the paster", and puts the corner in
  // `Metadata.WorldEdit.Origin`.
  console.log("\n--- Offset means two different things ---");
  {
    const anchorDisplacement: [number, number, number] = [-2, 0, -2];
    const worldCorner: [number, number, number] = [201, 92, 3];

    for (const format of ["sponge2", "sponge3"] as const) {
      const doc = sampleDocument(format);
      doc.offset = anchorDisplacement;
      doc.worldOrigin = worldCorner;

      const filePath = path.join(workDir, `versions-${format}.schem`);
      await saveDocument(doc, filePath, { legacyBlocksPath: LEGACY_BLOCKS });
      const { parsed } = await parseNbt(await readFile(filePath));
      const root = parsed.value as unknown as NbtCompound;
      const payload =
        format === "sponge3" ? (root.Schematic as { value: NbtCompound }).value : root;
      const metadata = (payload.Metadata as { value: NbtCompound }).value;

      if (format === "sponge3") {
        equal("v3 puts the displacement in Offset", payload.Offset, {
          type: "intArray",
          value: anchorDisplacement,
        });
        equal("...and the corner in Metadata.WorldEdit.Origin", (
          metadata.WorldEdit as { value: NbtCompound }
        ).value.Origin, { type: "intArray", value: worldCorner });
        check("...and writes no WEOffset* at all", !("WEOffsetX" in metadata));
      } else {
        equal("v2 puts the corner in Offset", payload.Offset, {
          type: "intArray",
          value: worldCorner,
        });
        equal("...and the displacement in Metadata.WEOffsetX", metadata.WEOffsetX, {
          type: "int",
          value: -2,
        });
        equal("...WEOffsetY", metadata.WEOffsetY, { type: "int", value: 0 });
        equal("...WEOffsetZ", metadata.WEOffsetZ, { type: "int", value: -2 });
      }

      // And both come back as the same two vectors, which is what makes saving
      // a v3 document as v2 (or the reverse) safe.
      const reloaded = documentFromLoaded(await loadStructure(filePath), filePath);
      equal(`${format}: the displacement round-trips`, reloaded.offset, anchorDisplacement);
      equal(`${format}: the corner round-trips`, reloaded.worldOrigin, worldCorner);
    }

    // The conversion the split exists to make safe: open as one version, save
    // as the other, and both vectors still mean what they meant.
    const doc = sampleDocument("sponge3");
    doc.offset = anchorDisplacement;
    doc.worldOrigin = worldCorner;
    const asV2 = path.join(workDir, "v3-saved-as-v2.schem");
    await saveDocument(doc, asV2, { format: "sponge2", legacyBlocksPath: LEGACY_BLOCKS });
    const converted = documentFromLoaded(await loadStructure(asV2), asV2);
    equal("a v3 document saved as v2 keeps its anchor", converted.offset, anchorDisplacement);
    equal("...and its corner", converted.worldOrigin, worldCorner);
  }

  // --- the NBT panel shows what the file will contain -----------------------
  //
  // The panel builds its own tree rather than sharing the writer's, because the
  // writer's is welded to the block payload. That is a drift risk and this is
  // the tripwire for it: save the document, read the *real file* back, strip
  // the tags the panel deliberately omits, and require what is left to be
  // exactly what the panel would have shown. A tag that appears in one and not
  // the other fails here rather than in front of a user.
  console.log("\n--- the panel's tree is the file's tree ---");
  for (const format of ["sponge2", "sponge3", "mcedit", "litematic"] as const) {
    // MCEdit cannot carry an oak sign at all, so that case gets a document the
    // legacy table knows every block of. Everything else about it is the same.
    const doc = format === "mcedit" ? legacySafeDocument() : sampleDocument(format);
    /*
     * Litematica has nowhere to put either vector, so the sample's anchor and
     * origin would be reported as dropped and would not come back. They are
     * cleared here rather than left, because this check is about the *tags*,
     * and `dropped` gets a check of its own below.
     */
    if (format === "litematic") {
      doc.offset = null;
      doc.worldOrigin = null;
    }
    const filePath = path.join(workDir, `panel-${format}.${extensionFor(format)}`);
    await saveDocument(doc, filePath, { legacyBlocksPath: LEGACY_BLOCKS });

    const { parsed } = await parseNbt(await readFile(filePath));
    const root = parsed.value as unknown as NbtCompound;
    // v3 puts everything one level down, under an anonymous root.
    const fromFile: NbtCompound = {
      ...(format === "sponge3" ? (root.Schematic as { value: NbtCompound }).value : root),
    };

    // Strip what the panel says it leaves out. The dotted names are inside
    // `Blocks`, which itself survives holding only what the panel keeps.
    for (const name of omittedTags(format)) {
      if (!name.includes(".")) delete fromFile[name];
    }
    if (format === "sponge3") {
      const blocks = { ...(fromFile.Blocks as { value: NbtCompound }).value };
      delete blocks.Palette;
      delete blocks.Data;
      fromFile.Blocks = { type: "compound", value: blocks };
    }

    let expectedTree = schematicNbtTree(doc, true);
    if (format === "litematic") {
      // The two arrays that *are* the schematic live inside the region, one
      // level deeper than the top-level strip above can reach -- the same
      // arrangement as v3's `Blocks`, in a different container.
      const regions = { ...(fromFile.Regions as { value: NbtCompound }).value };
      const [name] = Object.keys(regions);
      const region = { ...(regions[name] as { value: NbtCompound }).value };
      delete region.BlockStatePalette;
      delete region.BlockStates;
      regions[name] = { type: "compound", value: region };
      fromFile.Regions = { type: "compound", value: regions };

      /*
       * And the two clocks are normalised out of both sides. `TimeModified` is
       * stamped when the file is written and the panel's tree is built when the
       * panel opens, so the two are milliseconds apart by construction and
       * comparing them would make this check fail at random. It is the one pair
       * of tags this tripwire cannot speak for, which is why it says so.
       */
      const clocks = (tree: NbtCompound): NbtCompound => {
        const metadata = { ...(tree.Metadata as { value: NbtCompound }).value };
        metadata.TimeCreated = { type: "long", value: [0, 0] };
        metadata.TimeModified = { type: "long", value: [0, 0] };
        return { ...tree, Metadata: { type: "compound", value: metadata } };
      };
      expectedTree = clocks(expectedTree);
      Object.assign(fromFile, clocks(fromFile));
    }

    equal(
      `${format}: the panel shows exactly the file's own tags`,
      expectedTree,
      fromFile,
    );
  }


// --- Litematica -------------------------------------------------------------
//
// The referee is the same round trip as everywhere else in this file: build a
// document, save it, load it, and require the two to agree block for block and
// chest for chest. What is worth checking beyond that is the packing, because
// it is the one thing here that is not shared with any other container -- and
// the width at which it goes wrong is not the width the obvious test uses.
console.log("\n--- litematic ---");
{
  /*
   * A document whose palette forces a given bit width, filled so that every
   * index is used and no two neighbours share one.
   *
   * The widths matter more than the count. At 8 bits an entry never crosses a
   * long boundary, so a packer that refused to straddle would agree exactly --
   * and 8 bits is what an ordinary schematic has. 5 and 9 are where the two
   * arrangements diverge, which is why they are here and why the first sample
   * file anyone reaches for cannot catch it.
   */
  const spread = (entries: number): SchematicDocument => {
    const side = Math.ceil(Math.cbrt(entries + 1));
    const doc = createDocument({
      width: side,
      height: side,
      length: side,
      format: "litematic",
      dataVersion: 3837,
    });
    let n = 0;
    for (let x = 0; x < side; x += 1) {
      for (let y = 0; y < side; y += 1) {
        for (let z = 0; z < side; z += 1) {
          if (n >= entries) break;
          setBlock(doc, x, y, z, {
            namespacedName: "minecraft:stone",
            properties: { n: String(n) },
          });
          n += 1;
        }
      }
    }
    return doc;
  };

  /*
   * The sizes are chosen so that each one fails a different way of getting the
   * width wrong. `1` is the only size the floor of 2 shows up at -- everything
   * larger needs two bits anyway. `256` is the only one where "bits for the
   * largest index" and "bits for the count" disagree, because 256 blocks plus
   * air is 257 entries and 257 needs nine bits where 256 needs eight. And 5 and
   * 9 are where an entry crosses a long boundary at all; at 8 it never does,
   * which is exactly the width an ordinary schematic has and exactly why the
   * first file anyone reaches for cannot catch a packer that refuses to
   * straddle.
   */
  for (const [entries, bits] of [
    [1, 2],
    [3, 2],
    [20, 5],
    [200, 8],
    [256, 9],
    [400, 9],
  ] as const) {
    const doc = spread(entries);
    equal(`a palette of ${entries + 1} packs at ${bits} bits`, bitsPerEntry(entries + 1), bits);

    const filePath = path.join(workDir, `packed-${entries}.litematic`);
    await saveDocument(doc, filePath, { format: "litematic" });
    const back = documentFromLoaded(await loadStructure(filePath), filePath);
    equal(`...and ${entries} distinct blocks survive it`, countBlocks(back), countBlocks(doc));
    equal(`...cell for cell at ${bits} bits`, grid(back), grid(doc));
    equal(`...with the same names`, names(back), names(doc));
  }

  {
    // The whole document, the way every other container here is checked.
    const doc = sampleDocument("litematic");
    doc.offset = null;
    doc.worldOrigin = null;
    const filePath = path.join(workDir, "sample.litematic");
    const result = await saveDocument(doc, filePath, { format: "litematic" });
    equal("nothing is degraded", [...result.degraded], []);
    equal("...and nothing is dropped", [...result.dropped], []);

    const back = documentFromLoaded(await loadStructure(filePath), filePath);
    equal("the grid survives", grid(back), grid(doc));
    equal("the palette survives", names(back), names(doc));
    equal("the block entities survive", back.blockEntities.size, doc.blockEntities.size);
    equal("the entities survive", back.entities.length, doc.entities.length);
    equal("the DataVersion survives", back.dataVersion, doc.dataVersion);
    equal("...and it comes back as a litematic", back.format, "litematic");
  }

  {
    /*
     * The two vectors the container has nowhere to keep. Reported by name
     * rather than lost quietly, which is the whole reason `dropped` is a
     * separate list from `degraded`: a degraded block is in the file,
     * approximated, and these are simply not there.
     */
    const doc = sampleDocument("litematic");
    const filePath = path.join(workDir, "anchored.litematic");
    const result = await saveDocument(doc, filePath, { format: "litematic" });
    equal("the anchor and the origin are reported as dropped", [...result.dropped], [
      "the paste anchor",
      "the world origin",
    ]);
    const back = documentFromLoaded(await loadStructure(filePath), filePath);
    equal("...and they really are gone", [back.offset, back.worldOrigin], [null, null]);
  }

  {
    /*
     * The version stamped on the file is chosen from the document's own
     * DataVersion. Always 7 writes files Litematica below 1.20.6 refuses
     * outright; always 6 puts component-shaped item NBT under a label promising
     * the older shape.
     */
    const stamped = async (dataVersion: number): Promise<[number, number | null]> => {
      const doc = createDocument({ width: 2, height: 2, length: 2, format: "litematic", dataVersion });
      setBlock(doc, 0, 0, 0, { namespacedName: "minecraft:stone", properties: {} });
      const filePath = path.join(workDir, `stamp-${dataVersion}.litematic`);
      await saveDocument(doc, filePath, { format: "litematic" });
      const { parsed } = await parseNbt(await readFile(filePath));
      const root = parsed.value as unknown as NbtCompound;
      const sub = root.SubVersion;
      return [
        Number((root.Version as { value: number }).value),
        sub === undefined ? null : Number((sub as { value: number }).value),
      ];
    };
    equal("1.13.2 is stamped version 5, with no SubVersion", await stamped(1631), [5, null]);
    equal("1.18 is stamped 6, SubVersion 1", await stamped(2860), [6, 1]);
    equal("1.20.4 is still 6", await stamped(3700), [6, 1]);
    equal("1.20.5 moves to 7", await stamped(3837), [7, 1]);
  }

  {
    /*
     * And the refusals. This is the one container that has to carry a
     * DataVersion -- Sponge omits the tag when there is none and MCEdit has no
     * such tag at all -- so a document that names no version cannot be written
     * as one, and stamping 1631 would tell every reader it was cut from 1.13.2.
     */
    const noVersion = createDocument({ width: 2, height: 2, length: 2, format: "litematic" });
    let refused: string | null = null;
    try {
      await saveDocument(noVersion, path.join(workDir, "no-version.litematic"), {
        format: "litematic",
      });
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    check("a document with no version is refused", refused !== null);
    check("...by name, saying what to do", (refused ?? "").includes("1.13.2"), refused ?? "");

    const tooOld = createDocument({
      width: 2,
      height: 2,
      length: 2,
      format: "litematic",
      dataVersion: 1519,
    });
    let old: string | null = null;
    try {
      await saveDocument(tooOld, path.join(workDir, "too-old.litematic"), { format: "litematic" });
    } catch (err) {
      old = err instanceof Error ? err.message : String(err);
    }
    check("1.13 is refused too", old !== null);
    check(
      "...and the sentence is about the conversion, not the Flattening",
      (old ?? "").includes("converts"),
      old ?? "",
    );
  }


  {
    /*
     * Several regions become one box, and this is the only place that can be
     * seen. A litematic may hold any number of them, each with its own
     * position, size and palette; a document is one box, so the union becomes
     * the document and each region is written in at its own offset.
     *
     * The second region also states its box **backwards** -- a negative `Size`
     * means the region runs back from `Position`, so the corner its array is
     * indexed from is `Position + Size + 1`. Litematica normalises on save, so
     * no file anyone is likely to open carries one, which is exactly why it is
     * built by hand here.
     *
     * And it takes two regions to see either rule. With one, a wrong corner
     * simply translates the whole document and the union translates it back:
     * the box comes out the right size holding the right blocks, and the sign
     * error is invisible until something else has to be placed relative to it.
     */
    const stone: PaletteEntry = { namespacedName: "minecraft:stone", properties: {} };
    const blockPalette: NbtCompound[] = [
      { Name: { type: "string", value: "minecraft:air" } },
      { Name: { type: "string", value: "minecraft:stone" } },
    ];
    /**
     * One region, `span` cells along x, holding stone in its first cell.
     *
     * `span` is 2 for the backwards one and that is not decoration: at a span
     * of 1 the two readings coincide, because `Position + Size + 1` is
     * `Position` exactly when `Size` is -1. A test written with 1x1x1 regions
     * passes with the sign dropped altogether.
     */
    const region = (
      at: [number, number, number],
      span: number,
      backwards: boolean,
    ): NbtCompound => ({
      Position: {
        type: "compound",
        value: { x: int(at[0]), y: int(at[1]), z: int(at[2]) },
      },
      Size: {
        type: "compound",
        value: backwards
          ? { x: int(-span), y: int(-1), z: int(-1) }
          : { x: int(span), y: int(1), z: int(1) },
      },
      BlockStatePalette: { type: "list", value: { type: "compound", value: blockPalette } },
      // Two entries, so two bits per cell: stone in the first cell, air after
      // it, and the whole thing sits in the low bits of one long.
      BlockStates: { type: "longArray", value: [[0, 1]] },
      TileEntities: { type: "list", value: { type: "compound", value: [] } },
      Entities: { type: "list", value: { type: "compound", value: [] } },
    });

    const pairPath = path.join(workDir, "two-regions.litematic");
    await writeFile(
      pairPath,
      await gzipAsync(
        writeUncompressed(
          {
            type: "compound",
            name: "",
            value: {
              MinecraftDataVersion: int(3837),
              Version: int(7),
              SubVersion: int(1),
              Metadata: { type: "compound", value: { Name: { type: "string", value: "Pair" } } },
              Regions: {
                type: "compound",
                value: {
                  // At the origin, stated forwards.
                  near: { type: "compound", value: region([0, 0, 0], 1, false) },
                  /*
                   * Two wide, stated backwards from its own far corner: it
                   * occupies x = 4 and 5, and its array is indexed from 4.
                   */
                  far: { type: "compound", value: region([5, 0, 0], 2, true) },
                },
              },
            },
          } as never,
          "big",
        ),
      ),
    );

    const merged = documentFromLoaded(await loadStructure(pairPath), pairPath);
    equal(
      "two regions become one box spanning both",
      [merged.width, merged.height, merged.length],
      [6, 1, 1],
    );
    equal("...with a block at each end", countBlocks(merged), 2);
    equal(
      "...the near one where it was",
      getBlock(merged, 0, 0, 0).namespacedName,
      stone.namespacedName,
    );
    equal(
      "...and the backwards one four along, not five",
      getBlock(merged, 4, 0, 0).namespacedName,
      stone.namespacedName,
    );
  }

  {
    /*
     * A schematic version below 5 is refused by name rather than read as best
     * it can be: its palette is pre-Flattening numeric ids, which is a
     * different table and a different decoder, and guessing would produce a
     * document full of the wrong blocks that looked like a successful load.
     */
    const doc = sampleDocument("litematic");
    doc.offset = null;
    doc.worldOrigin = null;
    const filePath = path.join(workDir, "old-version.litematic");
    await saveDocument(doc, filePath, { format: "litematic" });
    const { parsed } = await parseNbt(await readFile(filePath));
    const root = { ...(parsed.value as unknown as NbtCompound), Version: int(4) };
    const agedPath = path.join(workDir, "aged.litematic");
    await writeFile(agedPath, await gzipAsync(writeUncompressed(
      { type: "compound", name: "", value: root } as never,
      "big",
    )));

    let refused: string | null = null;
    try {
      await loadStructure(agedPath);
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    check("version 4 is refused", refused !== null);
    check(
      "...saying which version and what to do about it",
      (refused ?? "").includes("version 4") && (refused ?? "").includes("1.13.2"),
      refused ?? "",
    );
  }

  {
    /*
     * The five derived fields are lifted out of the bag on the way in, for
     * `readMetadata`'s reason: every one of them is a function of the blocks,
     * so a copy left behind goes stale on the first edit and is written back
     * out as fact.
     */
    const doc = sampleDocument("litematic");
    doc.offset = null;
    doc.worldOrigin = null;
    const filePath = path.join(workDir, "metadata.litematic");
    await saveDocument(doc, filePath, { format: "litematic" });
    const back = documentFromLoaded(await loadStructure(filePath), filePath);
    const carried = Object.keys(back.metadata).sort();
    /*
     * `WorldEdit` is in there because the sample carries one and unknown
     * metadata survives a save, which is the rule for every container here --
     * the same reason opening a WorldEdit file and saving it stopped destroying
     * its `Platforms`. What must *not* survive is the five this app recomputes.
     */
    equal("the derived metadata does not reach the document", carried, [
      "Author",
      "Description",
      "Name",
      "TimeCreated",
      "WorldEdit",
    ]);
    for (const derived of ["EnclosingSize", "TotalBlocks", "TotalVolume", "RegionCount", "TimeModified"]) {
      check(`...${derived} in particular`, !(derived in back.metadata));
    }
  }

  {
    // One answer for the extension, and four containers to give it for.
    equal("a litematic is called .litematic", schematicExtension("litematic"), "litematic");
    for (const format of SCHEMATIC_FORMATS) {
      equal(
        `${format}: writers.ts agrees with shared/schematic.ts`,
        extensionFor(format),
        schematicExtension(format),
      );
    }
  }

  {
    /*
     * The region is named after the schematic, so a named document puts its
     * lists under a key the panel cannot know in advance. Looked up by name
     * rather than by position, an Apply that renamed the schematic would report
     * its own block entities as missing.
     */
    const doc = sampleDocument("litematic");
    doc.offset = null;
    doc.worldOrigin = null;
    doc.metadata = { ...doc.metadata, Name: { type: "string", value: "Castle" } };
    const filePath = path.join(workDir, "named.litematic");
    await saveDocument(doc, filePath, { format: "litematic" });
    const { parsed } = await parseNbt(await readFile(filePath));
    const regions = ((parsed.value as unknown as NbtCompound).Regions as { value: NbtCompound })
      .value;
    equal("the region takes the schematic's name", Object.keys(regions), ["Castle"]);

    const history = createHistory();
    const shown = schematicNbtText(doc);
    check("the panel offers it", shown.editable);
    const before = doc.blockEntities.size;
    applyNbt(doc, history, shown.text, shown.revision, "NBT");
    equal("...and applying it back keeps the block entities", doc.blockEntities.size, before);
  }

  {
    // Converting between containers, which is what the format union buys.
    const doc = sampleDocument("sponge3");
    const asLitematic = path.join(workDir, "converted.litematic");
    await saveDocument(doc, asLitematic, { format: "litematic" });
    const viaLitematic = documentFromLoaded(await loadStructure(asLitematic), asLitematic);
    const backToSponge = path.join(workDir, "converted-back.schem");
    await saveDocument(viaLitematic, backToSponge, { format: "sponge3" });
    const round = documentFromLoaded(await loadStructure(backToSponge), backToSponge);
    equal("sponge3 -> litematic -> sponge3 keeps the grid", grid(round), grid(doc));
    equal("...and the palette", names(round), names(doc));
    equal("...and the block entities", round.blockEntities.size, doc.blockEntities.size);
  }
}


// --- .mcfunction ------------------------------------------------------------
//
// The one format here that is not a container: a list of commands, and what
// makes it a schematic is that `setblock` and `fill` are enough to describe a
// build. Everything else -- the size, the frame, where the palette starts --
// is worked out from the commands.
//
// The referee is the same round trip as everywhere else, and it is a stronger
// one here than it looks: the writer decomposes the grid into boxes and the
// reader replays them in order, so a decomposition that overlapped, missed a
// cell or grew past a block entity comes back as a different document.
console.log("\n--- mcfunction ---");
{
  const stone: PaletteEntry = { namespacedName: "minecraft:stone", properties: {} };
  const glass: PaletteEntry = { namespacedName: "minecraft:glass", properties: {} };

  const commandsOf = (text: string): string[] =>
    text
      .split(NEWLINE)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

  {
    // The whole document, block entities and all.
    const doc = sampleDocument("sponge3");
    const target = path.join(workDir, "sample.mcfunction");
    const built = await saveMcfunction(doc, target);
    equal("one file is enough for a small build", built.files.length, 1);

    const back = documentFromLoaded(await loadStructure(target), target);
    equal("the grid survives", grid(back), grid(doc));
    equal("the palette survives", names(back), names(doc));
    equal("the block entities survive", back.blockEntities.size, doc.blockEntities.size);
    equal(
      "the size survives, which is what writing the air buys",
      [back.width, back.height, back.length],
      [doc.width, doc.height, doc.length],
    );
  }

  {
    /*
     * `fill` is the whole reason this is usable. One setblock per cell would be
     * 4,096 commands for this box and a quarter of a million for an ordinary
     * schematic -- past the point where the game stops reading and says
     * nothing.
     */
    const doc = createDocument({ width: 16, height: 16, length: 16, format: "sponge3" });
    for (let x = 0; x < 16; x += 1) {
      for (let y = 0; y < 16; y += 1) {
        for (let z = 0; z < 16; z += 1) setBlock(doc, x, y, z, stone);
      }
    }
    const commands = mcfunctionCommands(doc);
    equal("a solid box is one fill", commands.length, 1);
    check("...and it is a fill, not a setblock", commands[0].startsWith("fill "), commands[0]);
  }

  {
    /*
     * No box past the volume limit. A `fill` beyond it changes no blocks at all
     * and reports nothing useful, so the file looks fine and the build comes
     * out with holes -- which nothing in this repo could ever observe. Hence a
     * check on the boxes rather than on the result.
     */
    const side = 64;
    const doc = createDocument({ width: side, height: side, length: side, format: "sponge3" });
    for (let x = 0; x < side; x += 1) {
      for (let y = 0; y < side; y += 1) {
        for (let z = 0; z < side; z += 1) setBlock(doc, x, y, z, stone);
      }
    }
    const commands = mcfunctionCommands(doc);
    const volumes = commands.map((line) => {
      const parts = line.split(/\s+/);
      if (parts[0] !== "fill") return 1;
      const at = (i: number): number => Number(parts[i].slice(1) === "" ? 0 : parts[i].slice(1));
      return (
        (Math.abs(at(4) - at(1)) + 1) *
        (Math.abs(at(5) - at(2)) + 1) *
        (Math.abs(at(6) - at(3)) + 1)
      );
    });
    check(
      "no fill covers more cells than the game will change",
      volumes.every((volume) => volume <= MAX_FILL_VOLUME),
      String(Math.max(...volumes)),
    );
    equal("...so the box is split rather than truncated", volumes.reduce((a, b) => a + b, 0), side ** 3);
  }

  {
    /*
     * A block entity is never inside a box. `fill` carries one block argument
     * for the whole region, so a chest merged into one would come back empty --
     * or would fill the region with copies of its contents.
     */
    const doc = createDocument({ width: 8, height: 8, length: 8, format: "sponge3" });
    for (let x = 0; x < 8; x += 1) {
      for (let y = 0; y < 8; y += 1) {
        for (let z = 0; z < 8; z += 1) setBlock(doc, x, y, z, stone);
      }
    }
    setBlock(doc, 4, 4, 4, { namespacedName: "minecraft:chest", properties: { facing: "north" } });
    setBlockEntity(doc, 4, 4, 4, {
      id: "minecraft:chest",
      pos: [4, 4, 4],
      nbt: { Items: { type: "list", value: { type: "compound", value: [] } } },
    });

    const commands = mcfunctionCommands(doc);
    const chest = commands.filter((line) => line.includes("minecraft:chest"));
    equal("the chest is one command", chest.length, 1);
    check("...a setblock, not a fill", chest[0].startsWith("setblock "), chest[0]);
    check("...carrying its contents", chest[0].includes("{Items:"), chest[0]);
    check(
      "...on one line, because a function is one command per line",
      !chest[0].includes(NEWLINE),
      chest[0],
    );

    const target = path.join(workDir, "chest.mcfunction");
    await saveMcfunction(doc, target);
    const back = documentFromLoaded(await loadStructure(target), target);
    equal("and it comes back", back.blockEntities.size, 1);
    equal("...with the block", getBlock(back, 4, 4, 4).namespacedName, "minecraft:chest");
    equal("...and its state", getBlock(back, 4, 4, 4).properties.facing, "north");
  }


  {
    /*
     * Two chests side by side, same block state, different contents. This is
     * the only shape that can see the rule: a chest surrounded by *stone* stops
     * a box on the block value alone, so a writer that had forgotten block
     * entities entirely would still get that case right. Here the two cells
     * agree on everything the palette knows, and merging them into one `fill`
     * would give the second chest the first one's contents.
     */
    const doc = createDocument({ width: 4, height: 1, length: 1, format: "sponge3" });
    const chest: PaletteEntry = {
      namespacedName: "minecraft:chest",
      properties: { facing: "north" },
    };
    const item = (id: string): NbtCompound => ({
      Items: {
        type: "list",
        value: {
          type: "compound",
          value: [
            {
              id: { type: "string", value: id },
              Count: { type: "byte", value: 1 },
              Slot: { type: "byte", value: 0 },
            },
          ],
        },
      },
    });
    /*
     * The empty one goes **first**, and the order is the whole test.
     *
     * A recorded cell is handled before any box begins, so two of them side by
     * side come out as two commands even from a writer that has never heard of
     * block entities. The only cell a box ever *grows into* is one that comes
     * later in the walk -- so the box has to start on an identical block with
     * no record of its own, which is an ordinary document: a chest placed and
     * left empty, beside two that were filled.
     */
    setBlock(doc, 0, 0, 0, chest);
    for (const x of [1, 2]) {
      setBlock(doc, x, 0, 0, chest);
      setBlockEntity(doc, x, 0, 0, {
        id: "minecraft:chest",
        pos: [x, 0, 0],
        nbt: item(x === 1 ? "minecraft:diamond" : "minecraft:coal"),
      });
    }

    const commands = mcfunctionCommands(doc);
    const chests = commands.filter((line) => line.includes("minecraft:chest"));
    equal("three adjacent chests are three commands", chests.length, 3);
    check(
      "...none of them a fill, so no box swallowed a record",
      chests.every((line) => line.startsWith("setblock ")),
      chests.join(" | "),
    );

    const target = path.join(workDir, "chests.mcfunction");
    await saveMcfunction(doc, target);
    const back = documentFromLoaded(await loadStructure(target), target);
    equal("both come back", back.blockEntities.size, 2);
    const carried = [1, 2].map((x) =>
      JSON.stringify(back.blockEntities.get(posKey(x, 0, 0))?.nbt ?? null),
    );
    check("...with their own contents", carried[0].includes("diamond"), carried[0]);
    check("...not the same ones twice", carried[1].includes("coal"), carried[1]);
  }

  {
    /*
     * Splitting. Every cell of a checkerboard is its own box, so this is the
     * cheapest way to a document that will not fit in one function.
     *
     * What splitting buys is that each part is runnable on its own. It does
     * *not* raise the ceiling -- a function's budget covers what it calls --
     * which is why the dispatcher says so rather than leaving the user to
     * wonder where the roof went.
     */
    const side = 42;
    const doc = createDocument({ width: side, height: side, length: side, format: "sponge3" });
    for (let x = 0; x < side; x += 1) {
      for (let y = 0; y < side; y += 1) {
        for (let z = 0; z < side; z += 1) {
          if ((x + y + z) % 2 === 0) setBlock(doc, x, y, z, stone);
        }
      }
    }
    const built = buildMcfunction(doc, { stem: "big" });
    check(
      "a build past the limit is split",
      built.commands > MAX_COMMANDS_PER_FUNCTION,
      String(built.commands),
    );
    equal("...into a dispatcher and its parts", built.files.length, 3);
    equal("the dispatcher comes first", built.files[0].name, "big.mcfunction");
    equal("...and the parts are numbered", built.files[1].name, "big_0.mcfunction");
    for (const part of built.files.slice(1)) {
      check(
        `${part.name} fits in one function`,
        commandsOf(part.text).length <= MAX_COMMANDS_PER_FUNCTION,
        String(commandsOf(part.text).length),
      );
    }
    check(
      "the dispatcher warns that splitting does not lift the limit",
      built.files[0].text.includes("does not"),
      built.files[0].text.split(NEWLINE)[0],
    );
    equal(
      "...and calls each part once",
      commandsOf(built.files[0].text),
      ["function big:big_0", "function big:big_1"],
    );
  }

  {
    /*
     * `~ ~ ~` is where the function is run from, which is exactly what the
     * anchor means -- so the coordinates carry it for free, and this is the
     * one thing a `.mcfunction` keeps that Litematica cannot.
     */
    const doc = createDocument({ width: 4, height: 4, length: 4, format: "sponge3" });
    setBlock(doc, 1, 2, 3, stone);
    doc.offset = [-1, 0, -1];
    const target = path.join(workDir, "anchored.mcfunction");
    await saveMcfunction(doc, target);
    const text = await readFile(target, "utf8");
    check(
      "the coordinates are written from the anchor",
      text.includes("setblock ~ ~2 ~2 minecraft:stone"),
      commandsOf(text).find((line) => line.includes("stone")) ?? "",
    );

    const back = documentFromLoaded(await loadStructure(target), target);
    equal("...and reading it back recovers the anchor", back.offset, [-1, 0, -1]);
    equal("...with the block where it was", getBlock(back, 1, 2, 3).namespacedName, "minecraft:stone");
  }

  {
    // Entities have no command with a way back, so they are named, not halved.
    const doc = sampleDocument("sponge3");
    doc.entities = [{ id: "minecraft:armor_stand", pos: [1, 1, 1], nbt: {} }];
    doc.worldOrigin = [10, 20, 30];
    const built = buildMcfunction(doc, { stem: "lossy" });
    equal("what it cannot carry is named", [...built.dropped], ["1 entity", "the world origin"]);
  }

  // --- reading commands ------------------------------------------------------
  {
    const parsed = parseMcfunction(
      [
        "# a comment",
        "",
        "  setblock ~ ~ ~ stone  ",
        "fill ~1 ~ ~ ~2 ~ ~ minecraft:glass",
        "say hello",
        "function pack:more",
        "scoreboard players set @a x 1",
      ].join(NEWLINE),
    );
    equal("two commands are read", parsed.commands.length, 2);
    equal("...the call is noted", [...parsed.calls], ["pack:more"]);
    equal("...and the rest is counted, not ignored", parsed.ignored, 2);
    equal(
      "an id with no namespace means minecraft:",
      parsed.commands[0].entry.namespacedName,
      "minecraft:stone",
    );
  }

  {
    /*
     * The block argument cannot be split on whitespace: a chest's contents have
     * spaces in them, and cutting there leaves two halves that each fail to
     * parse. The scan is a depth counter over brackets, braces and quotes.
     */
    const parsed = parseMcfunction(
      'setblock ~ ~ ~ chest[facing=north]{Items: [{id: "minecraft:stone", Count: 1b}]} replace',
    );
    equal("the block survives its own spaces", parsed.commands.length, 1);
    equal(
      "...with its state",
      parsed.commands[0].entry.properties.facing,
      "north",
    );
    check("...and its NBT", parsed.commands[0].nbt !== null);
    check(
      "...and the trailing word is read as the mode",
      parsed.commands[0].shape === "solid",
    );
  }

  {
    // The modes that decide which cells are written are honoured, because
    // ignoring them writes a solid box where the file asked for a frame.
    const shell = parseMcfunction("fill ~ ~ ~ ~2 ~2 ~2 stone hollow");
    equal("hollow is read as a shape", shell.commands[0].shape, "hollow");
    const outline = parseMcfunction("fill ~ ~ ~ ~2 ~2 ~2 stone outline");
    equal("...and so is outline", outline.commands[0].shape, "outline");
    const keep = parseMcfunction("fill ~ ~ ~ ~2 ~2 ~2 stone keep");
    check("keep writes only into air", keep.commands[0].onlyAir);
    const over = parseMcfunction("fill ~ ~ ~ ~2 ~2 ~2 stone replace minecraft:dirt");
    equal(
      "...and a filter is the block it may write over",
      over.commands[0].onlyOver?.namespacedName,
      "minecraft:dirt",
    );
  }

  {
    /*
     * A file that mixes `~2` with `2` describes two builds in two frames, and
     * picking one silently is how a structure comes out with half of itself
     * somewhere else.
     */
    let mixed: string | null = null;
    try {
      parseMcfunction(["setblock ~ ~ ~ stone", "setblock 4 4 4 stone"].join(NEWLINE));
    } catch (err) {
      mixed = err instanceof Error ? err.message : String(err);
    }
    check("mixing the two coordinate kinds is refused", mixed !== null);
    check("...by name", (mixed ?? "").includes("relative"), mixed ?? "");

    let local: string | null = null;
    try {
      parseMcfunction("setblock ^ ^ ^1 stone");
    } catch (err) {
      local = err instanceof Error ? err.message : String(err);
    }
    check("local (^) coordinates are refused too", local !== null);
    check(
      "...because they need a facing a schematic has not got",
      (local ?? "").includes("looking"),
      local ?? "",
    );
  }

  {
    // A file with nothing placeable in it is refused with what it did find,
    // rather than opening as an empty schematic.
    const target = path.join(workDir, "empty.mcfunction");
    await writeFile(target, "say hello" + NEWLINE + "function nowhere:at_all" + NEWLINE, "utf8");
    let refused: string | null = null;
    try {
      await loadStructure(target);
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    check("a file with no blocks is refused", refused !== null);
    check(
      "...naming the call it could not follow",
      (refused ?? "").includes("nowhere:at_all"),
      refused ?? "",
    );
  }

  {
    /*
     * A dispatcher is followed to its sibling, which is the shape every
     * converter writes and the shape of the reference files this was built
     * against: one line calling a file next to it.
     */
    const doc = createDocument({ width: 3, height: 1, length: 1, format: "sponge3" });
    setBlock(doc, 0, 0, 0, stone);
    setBlock(doc, 2, 0, 0, glass);
    const parts = path.join(workDir, "split_0.mcfunction");
    await saveMcfunction(doc, parts);
    const dispatcher = path.join(workDir, "split.mcfunction");
    await writeFile(dispatcher, "function anything:split_0" + NEWLINE, "utf8");

    const back = documentFromLoaded(await loadStructure(dispatcher), dispatcher);
    equal("the dispatcher's blocks are the ones it calls", grid(back), grid(doc));
    equal("...and the ignored count is zero", countBlocks(back), countBlocks(doc));
  }
}


// --- converting one file into another ---------------------------------------
//
// The verb that makes the four-and-a-half kinds worth having. There is no
// format code in `convert.ts` at all -- it loads with `loadStructure`, builds a
// document with `documentFromLoaded` and writes with `writeDocument` or the
// mcfunction writer -- so what is checked here is the wiring and the two rules
// it adds on top: it never overwrites, and it never crops.
console.log("\n--- convert ---");
{
  const stone: PaletteEntry = { namespacedName: "minecraft:stone", properties: {} };

  /** A roomy box with a small build off-centre, so a crop would be visible. */
  const roomy = (): SchematicDocument => {
    const doc = createDocument({
      width: 12,
      height: 8,
      length: 12,
      format: "sponge3",
      dataVersion: 3837,
    });
    for (let x = 4; x <= 6; x += 1) {
      for (let z = 4; z <= 6; z += 1) setBlock(doc, x, 2, z, stone);
    }
    return doc;
  };

  {
    // Every pair, through the app's own reader and writer.
    const start = path.join(workDir, "start.schem");
    await saveDocument(roomy(), start, { format: "sponge3" });

    for (const format of ["litematic", "sponge2", "mcfunction"] as const) {
      const target = path.join(workDir, `via-${format}.${extensionForKind(format)}`);
      const out = await convertFile({ source: start, target, format });
      equal(`sponge3 -> ${format}: the size is unchanged`, [...out.size], [12, 8, 12]);
      equal(`...and the blocks are all there`, out.blocks, 9);

      const back = documentFromLoaded(await loadStructure(out.files[0]), out.files[0]);
      equal(`...and it reads back the same`, grid(back), grid(roomy()));
    }
  }

  {
    /*
     * It does not crop, and that is the difference from Save. `saveSession`
     * trims to content because saving ends an editing session and the room you
     * made to build in is not part of the build; a conversion is a fact about a
     * file, and quietly handing back a smaller one would make the two disagree
     * about what the schematic is.
     */
    const start = path.join(workDir, "roomy.schem");
    await saveDocument(roomy(), start, { format: "sponge3" });
    const target = path.join(workDir, "roomy.litematic");
    const out = await convertFile({ source: start, target, format: "litematic" });
    equal("a conversion keeps the empty room", [...out.size], [12, 8, 12]);
  }

  {
    /*
     * Nothing is overwritten. This verb is reachable by an agent, and an agent
     * that guesses a path badly should cost a rename rather than somebody's
     * build -- `save_document_as`'s rule, arrived at from the same direction.
     */
    const start = path.join(workDir, "twice.schem");
    await saveDocument(roomy(), start, { format: "sponge3" });
    const target = path.join(workDir, "twice-out.litematic");
    const first = await convertFile({ source: start, target, format: "litematic" });
    equal("the first run backs nothing up", [...first.backedUp], []);
    const second = await convertFile({ source: start, target, format: "litematic" });
    equal("the second moves the first aside", second.backedUp.length, 1);
    check(
      "...under a timestamp, not a number",
      (second.backedUp[0] ?? "").includes(".bak."),
      second.backedUp[0] ?? "",
    );
    // And the file that was moved is still readable, which is the whole point.
    const rescued = documentFromLoaded(
      await loadStructure(second.backedUp[0]),
      second.backedUp[0],
    );
    equal("...and it still holds what it held", grid(rescued), grid(roomy()));
  }

  {
    /*
     * A `.mcfunction` may be several files, and every one of their names is
     * reserved -- not just the dispatcher's. A part left to overwrite is the
     * half of the rule that never gets noticed: export as eight parts, edit
     * down, export as five, and `_5` through `_7` are still there from last
     * time, beside a dispatcher that no longer calls them.
     */
    const side = 42;
    const doc = createDocument({ width: side, height: side, length: side, format: "sponge3" });
    for (let x = 0; x < side; x += 1) {
      for (let y = 0; y < side; y += 1) {
        for (let z = 0; z < side; z += 1) {
          if ((x + y + z) % 2 === 0) setBlock(doc, x, y, z, stone);
        }
      }
    }
    const start = path.join(workDir, "many.schem");
    await saveDocument(doc, start, { format: "sponge3" });
    const target = path.join(workDir, "many.mcfunction");
    const first = await convertFile({ source: start, target, format: "mcfunction" });
    check("it comes out as several files", first.files.length > 2, String(first.files.length));
    const second = await convertFile({ source: start, target, format: "mcfunction" });
    equal(
      "...and every one of them is reserved on the way back",
      second.backedUp.length,
      first.files.length,
    );
  }

  {
    /*
     * The version is refused by the same function the format picker asks, so a
     * `.litematic` is refused for 1.13 here for the reason it is refused there.
     * Before anything is written, because a file already moved aside for a
     * conversion that then failed is a rename nobody asked for.
     */
    const start = path.join(workDir, "versioned.schem");
    await saveDocument(roomy(), start, { format: "sponge3" });
    let refused: string | null = null;
    try {
      await convertFile({
        source: start,
        target: path.join(workDir, "refused.litematic"),
        format: "litematic",
        version: "JE_1_13",
      });
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    check("1.13 as a litematic is refused", refused !== null);
    check("...by name", (refused ?? "").includes("1.13.2"), refused ?? "");

    /*
     * And the *Sponge* case, which is the one only this check can see. A
     * litematic refuses a version it cannot carry on its own, in the writer, so
     * removing the check here changes nothing for it. Sponge has no such guard:
     * without `refusalFor`, a pre-Flattening version would be written into a
     * file whose palette holds flattened block names, and that file opens fine
     * and misbehaves in game -- the exact failure `formatsFor` exists for.
     */
    let legacy: string | null = null;
    try {
      await convertFile({
        source: start,
        target: path.join(workDir, "legacy.schem"),
        format: "sponge3",
        version: "JE_1_12_2",
      });
    } catch (err) {
      legacy = err instanceof Error ? err.message : String(err);
    }
    check("a pre-Flattening version as Sponge is refused", legacy !== null);
    check(
      "...with the Flattening sentence, not the Litematica one",
      (legacy ?? "").includes("flattened names"),
      legacy ?? "",
    );

    const stamped = await convertFile({
      source: start,
      target: path.join(workDir, "stamped.schem"),
      format: "sponge3",
      version: "JE_1_16_5",
    });
    const back = documentFromLoaded(
      await loadStructure(stamped.files[0]),
      stamped.files[0],
    );
    equal("...and a version that fits is stamped", back.dataVersion, dataVersionOf("JE_1_16_5"));
  }

  {
    // The one direction that only exists because of the converter: commands in,
    // a container out. Save As could never do this -- a document is not a
    // `.mcfunction`, so there was nothing to save *as*.
    const doc = createDocument({ width: 4, height: 2, length: 4, format: "sponge3" });
    setBlock(doc, 1, 1, 1, stone);
    const commands = path.join(workDir, "in.mcfunction");
    await saveMcfunction(doc, commands);
    const target = path.join(workDir, "out.litematic");

    /*
     * And it needs a version told to it, which is the honest consequence of two
     * rules meeting: a `.mcfunction` carries no `DataVersion`, and a
     * `.litematic` is the one container that cannot omit one -- Litematica
     * reads the file *according to* it. So the refusal is the right answer, and
     * the panel offers the picker for exactly this case.
     */
    let needsVersion: string | null = null;
    try {
      await convertFile({ source: commands, target, format: "litematic" });
    } catch (err) {
      needsVersion = err instanceof Error ? err.message : String(err);
    }
    check("commands carry no version, so a litematic is refused", needsVersion !== null);
    check(
      "...saying to pick one",
      (needsVersion ?? "").includes("Pick a version"),
      needsVersion ?? "",
    );

    const out = await convertFile({
      source: commands,
      target,
      format: "litematic",
      version: "JE_1_20_5",
    });
    equal("mcfunction -> litematic keeps the size", [...out.size], [4, 2, 4]);
    const back = documentFromLoaded(await loadStructure(out.files[0]), out.files[0]);
    equal("...and the block", grid(back), grid(doc));
    equal("...and comes out a litematic", back.format, "litematic");
  }
}

  // --- cropping to the content ---------------------------------------------
  console.log("\n--- crop on save ---");
  {
    const stone: PaletteEntry = { namespacedName: "minecraft:stone", properties: {} };

    /** A roomy box with a small build sitting off-centre inside it. */
    const padded = () => {
      const doc = createDocument({ width: 16, height: 16, length: 16, format: "sponge3" });
      doc.offset = [100, 64, -20];
      doc.worldOrigin = [500, 70, -300];
      for (let x = 4; x <= 6; x += 1) {
        for (let y = 2; y <= 3; y += 1) {
          for (let z = 9; z <= 12; z += 1) {
            setBlock(doc, x, y, z, stone);
          }
        }
      }
      return doc;
    };

    equal("the content box is the outermost block on each side", contentBounds(padded()), {
      minX: 4,
      minY: 2,
      minZ: 9,
      maxX: 6,
      maxY: 3,
      maxZ: 12,
    });

    const cropped = cropToContent(padded());
    equal("the crop reports what it did", cropped?.summary, {
      from: [16, 16, 16],
      to: [3, 2, 4],
    });
    equal("...and the copy is that size", [
      cropped?.doc.width,
      cropped?.doc.height,
      cropped?.doc.length,
    ], [3, 2, 4]);
    equal("no blocks are lost to the trim", countBlocks(cropped!.doc), 3 * 2 * 4);
    equal("the corner block moved to the origin", getBlock(cropped!.doc, 0, 0, 0)?.namespacedName, "minecraft:stone");

    /*
     * The offset moves the *opposite* way to the content, so the file dropped
     * back into the world it came from lands where it was. Getting this
     * backwards is silent -- the schematic looks right and pastes 4 blocks off.
     */
    equal("the world offset follows the trim", cropped?.doc.offset, [104, 66, -11]);
    // The Origin is the world position of the corner cell, and the trim has
    // just moved that corner to what used to be (4, 2, 9) -- so it takes the
    // same correction. An Origin left where it was would paste the build into
    // the padding it no longer has.
    equal("...and so does the WorldEdit Origin", cropped?.doc.worldOrigin, [504, 72, -291]);

    // A document that never had one must not acquire one on the way out.
    {
      const unpositioned = padded();
      unpositioned.worldOrigin = null;
      equal("a document with no Origin still has none after a trim", cropToContent(unpositioned)?.doc.worldOrigin, null);
    }

    // The invariant this whole design exists for: a voxel index means nothing
    // except against the dimensions it was recorded under, so saving must not
    // re-dimension the document the undo stack is describing.
    const live = padded();
    const before = [live.width, live.height, live.length, live.voxels.length, live.revision];
    cropToContent(live);
    equal(
      "cropping never touches the open document",
      [live.width, live.height, live.length, live.voxels.length, live.revision],
      before,
    );

    // Block entities travel with their blocks.
    {
      const doc = padded();
      setBlockEntity(doc, 4, 2, 9, {
        id: "minecraft:chest",
        pos: [4, 2, 9],
        nbt: { Items: { type: "list", value: { type: "compound", value: [] } } },
      });
      const trimmed = cropToContent(doc);
      equal("a block entity keeps its block", trimmed?.doc.blockEntities.size, 1);
      equal(
        "...at the shifted position",
        getBlockEntity(trimmed!.doc, 0, 0, 0)?.pos,
        [0, 0, 0],
      );
    }

    // Nothing to do, in both of the ways there can be nothing to do.
    {
      const tight = createDocument({ width: 2, height: 2, length: 2, format: "sponge3" });
      for (let x = 0; x < 2; x += 1)
        for (let y = 0; y < 2; y += 1)
          for (let z = 0; z < 2; z += 1) setBlock(tight, x, y, z, stone);
      equal("an already tight document is not cropped", cropToContent(tight), null);

      const empty = createDocument({ width: 8, height: 8, length: 8, format: "sponge3" });
      equal("an all-air document has no content box", contentBounds(empty), null);
      equal("...and is written as it stands", cropToContent(empty), null);
    }

    /*
     * A cropped copy round-trips like any other document.
     *
     * The trim itself is applied by `saveSession`, not by the writers -- the
     * writers are also what autosave calls, and a crash snapshot must keep the
     * roomy box the user was working in rather than hand back a trimmed one.
     * `tests/session.ts` covers the save path; this covers the shape the crop
     * produces.
     */
    {
      const trimmed = cropToContent(padded())!.doc;
      const filePath = path.join(workDir, "cropped.schem");
      await saveDocument(trimmed, filePath);
      const reloaded = documentFromLoaded(await loadStructure(filePath), filePath);
      equal(
        "a cropped copy writes at its trimmed size",
        [reloaded.width, reloaded.height, reloaded.length],
        [3, 2, 4],
      );
      equal("...and keeps every block", countBlocks(reloaded), 3 * 2 * 4);
      equal("...and its shifted offset", reloaded.offset, [104, 66, -11]);
    }
  }

} finally {
  await rm(workDir, { recursive: true, force: true });
}

// --- two eras, and which containers exist in each ---------------------------
//
// Sponge's palette is flattened `namespace:id[state]` strings, and those did
// not exist before the Flattening. Offering Sponge for 1.12.2 would write a
// file whose palette names blocks that version has never heard of -- a file
// that saves without complaint and cannot be read, which is the failure this
// rule exists to make impossible.
console.log("\n--- eras ---");
{
  equal("1.13 is where the flat era starts", eraOf("JE_1_13"), "flat");
  equal("...and 1.12.2 is the last legacy one", eraOf("JE_1_12_2"), "legacy");
  equal("the oldest supported version is legacy", eraOf("JE_1_8_8"), "legacy");

  equal("a legacy version can only be MCEdit", formatsFor("JE_1_12_2"), ["mcedit"]);
  check("...so Sponge is refused for it", !formatSupportsVersion("sponge3", "JE_1_12_2"));
  check(
    "...by name, saying why rather than just no",
    (refusalFor("sponge3", "JE_1_12_2") ?? "").includes("1.13"),
    refusalFor("sponge3", "JE_1_12_2") ?? "",
  );

  // MCEdit works in both eras -- lossily above 1.13, which the writers already
  // report through `degraded`, and natively below it.
  check("MCEdit is offered in both", formatSupportsVersion("mcedit", "JE_1_12_2") && formatSupportsVersion("mcedit", "JE_1_20_4"));
  equal("a flat version gets all four", formatsFor("JE_1_20_4"), [
    "sponge3",
    "litematic",
    "sponge2",
    "mcedit",
  ]);
  equal("nothing is refused there", refusalFor("sponge3", "JE_1_20_4"), null);

  /*
   * Litematica needs one release more than the era does, and that is the whole
   * of why this rule is not `eraOf`. 1.13 is flat and can be Sponge; a
   * .litematic claiming it is converted by the mod's own reader.
   */
  equal("1.13 gets no litematic", formatsFor("JE_1_13"), ["sponge3", "sponge2", "mcedit"]);
  equal("...and 1.13.2 does", formatsFor("JE_1_13_2"), [
    "sponge3",
    "litematic",
    "sponge2",
    "mcedit",
  ]);
  check(
    "...refused by its own sentence, not the Flattening one",
    (refusalFor("litematic", "JE_1_13") ?? "").includes("1.13.2") &&
      !(refusalFor("litematic", "JE_1_13") ?? "").includes("flattened names"),
    refusalFor("litematic", "JE_1_13") ?? "",
  );

  /*
   * A legacy version has a perfectly real DataVersion -- what it does not have
   * is a container that can carry one, because Sponge is refused for it. That
   * distinction is why the generator's table filters on era and not on whether
   * the number exists: filtering on the number would let 1343 be stamped onto a
   * schematic whose palette is flattened block names.
   */
  equal("a legacy version still has a DataVersion", dataVersionOf("JE_1_12_2"), 1343);
  // 1.8.x is the one era with no number at all: the tag began in 15w32a.
  equal("...but 1.8.8 predates the tag entirely", dataVersionOf("JE_1_8_8"), null);
  equal("a flat one does", dataVersionOf("JE_1_20_4"), 3700);
  equal("...and the mapping goes back the other way", versionNameOf(3700), "JE_1_20_4");
  equal("a DataVersion nothing claims maps to nothing", versionNameOf(999999), null);

  /*
   * A settings file written by a newer build names a version this one has never
   * heard of. Refusing every container for it would leave the user unable to
   * save at all, and the guess costs nothing when it is wrong because MCEdit is
   * offered either way.
   */
  equal("an unknown version is assumed flat", eraOf("JE_2_99"), "flat");

  // The generator's table is the flat rows only, because generation writes
  // Sponge. The editor's picker is the full list and filters by container.
  check(
    "generation is offered only versions Sponge can express",
    VERSION_NAMES.every((name) => eraOf(name) === "flat"),
    VERSION_NAMES.filter((name) => eraOf(name) !== "flat").join(", "),
  );
  check(
    "...and the full list is longer than it",
    MC_VERSION_NAMES.length > VERSION_NAMES.length,
    `${MC_VERSION_NAMES.length} vs ${VERSION_NAMES.length}`,
  );
  /*
   * One list, derived: two hand-written tables would be two things to keep in
   * step, and they would not stay in step. The generator's table is exactly the
   * flat rows -- not "everything with a number", which is the mistake this
   * check exists to catch, and did.
   */
  equal(
    "the generator's table is exactly the flat era",
    [...VERSION_NAMES].sort(),
    MC_VERSION_NAMES.filter((name) => eraOf(name) === "flat").sort(),
  );
}


// --- the app can say where it put them --------------------------------------
//
// `shared/schematic.ts` names the tag each vector is written to, because the
// anchor panel has to tell you where to look and the renderer may not import
// out of `main/`. That makes it a second copy of `spongeVectors`' table, and a
// second copy is a thing that drifts -- so this walks the path it names into a
// file the writers actually produced and requires the vector to be exactly
// there.
//
// The failure it exists for is not hypothetical: the panel said "Offset" for
// every container. In a v2 file that tag holds the *world corner*, so someone
// who set an anchor, looked where the app told them, and found a different
// vector would report the anchor as never written -- and be reasoning correctly
// from a false sentence.

// --- the two vendored tables the new containers read ------------------------
//
// Both are generated from JSON with provenance, and both hold numbers nothing
// in this repo can otherwise observe: a wrong Litematica `Version` produces a
// file Litematica opens and silently converts, and a wrong command limit
// produces a function the game truncates without an error. So the facts are
// stated here as well as in the data, which is what makes a regenerated table
// that lost a row fail rather than quietly change what gets written.
console.log("\n--- litematic and mcfunction floors ---");
{
  /*
   * Newest first is not cosmetic: `litematicVersionFor` returns the first row a
   * DataVersion reaches, so a table sorted the other way would answer 5 for
   * everything and every file this app wrote would claim 1.13.2.
   */
  const versions = LITEMATIC_VERSIONS.map((row) => row.version);
  equal("the litematic table is newest first", versions, [...versions].sort((a, b) => b - a));
  check("...and has the three writable versions", versions.length >= 3, versions.join(","));

  /*
   * The boundaries, from both sides. One release below each is the case that
   * catches a table built with `>` where it wanted `>=`, or a row whose
   * DataVersion landed on a snapshot rather than the release.
   */
  equal("1.13.2 writes version 5", litematicVersionFor(1631).version, 5);
  equal("1.14 still writes 5", litematicVersionFor(1952).version, 5);
  equal("1.18 moves to 6", litematicVersionFor(2860).version, 6);
  equal("...and 1.17.1 does not", litematicVersionFor(2859).version, 5);
  equal("1.20.5 moves to 7", litematicVersionFor(3837).version, 7);
  equal("...and 1.20.4 does not", litematicVersionFor(3700).version, 6);

  equal("5 wrote no SubVersion", litematicVersionFor(1631).subVersion, 0);
  equal("6 and 7 write 1", litematicVersionFor(3837).subVersion, 1);

  /*
   * The floor is 1.13.2 and not 1.13, and the difference is the whole reason
   * this table exists: Litematica converts the palette of anything below
   * DataVersion 1631, so a file claiming 1.13 comes back as the wrong blocks
   * rather than as an error.
   */
  check("1.13 cannot be a litematic", !litematicCanCarry(1519));
  check("...but 1.13.2 can", litematicCanCarry(1631));
  check("a document with no version cannot", !litematicCanCarry(null));

  /*
   * The two floors differ on purpose, and this states it so nobody harmonises
   * them. `setblock` needs flattened ids, which is 1.13; a litematic needs
   * Litematica not to convert it, which is 1.13.2.
   */
  check(
    "the mcfunction floor is a release earlier",
    MCFUNCTION_MIN_DATA_VERSION < LITEMATIC_MIN_DATA_VERSION,
    `${MCFUNCTION_MIN_DATA_VERSION} vs ${LITEMATIC_MIN_DATA_VERSION}`,
  );
  equal("...and it is 1.13", MCFUNCTION_MIN_DATA_VERSION, mcVersion("JE_1_13")?.dataVersion ?? -1);
  equal(
    "...while the litematic floor is 1.13.2",
    LITEMATIC_MIN_DATA_VERSION,
    mcVersion("JE_1_13_2")?.dataVersion ?? -1,
  );

  /*
   * Every release a litematic row names has to be the same release
   * `mc_versions.json` knows, which is the corroborated table. The generator
   * refuses on disagreement; this says it again, because a table edited by hand
   * never meets the generator.
   */
  for (const row of LITEMATIC_VERSIONS) {
    equal(
      `version ${row.version} agrees with the version table about ${row.since}`,
      row.sinceDataVersion,
      MC_VERSIONS.find((entry) => entry.label === row.since)?.dataVersion ?? null,
    );
  }

  /*
   * The two constants the mcfunction writer uses are read out of the limits
   * table rather than written beside it, which is the whole point of vendoring
   * them -- there is no second copy of 32,768 to drift. `commandLimit` throwing
   * is what keeps that true: a regenerated table that had dropped a row would
   * otherwise fall back to a number nobody checked.
   */
  equal("a fill may cover 32,768 cells", MAX_FILL_VOLUME, 32768);
  equal("a function may hold 65,536 commands", MAX_COMMANDS_PER_FUNCTION, 65536);
  let refused = false;
  try {
    commandLimit("no_such_rule");
  } catch {
    refused = true;
  }
  check("an unknown limit throws rather than defaulting", refused);

  /*
   * The forms are the ones the writer emits, without a mode word. Omitted means
   * `replace`, and it is the one spelling every release from 1.13 accepts --
   * 1.21.5 added `strict` without touching it.
   */
  const setblock = COMMAND_FORMS.find((form) => form.command === "setblock");
  check("setblock is in the table", setblock !== undefined);
  check(
    "...in the form the writer emits, with no mode word",
    setblock?.syntax === "setblock <pos> <block>",
    setblock?.syntax ?? "missing",
  );
  const fill = COMMAND_FORMS.find((form) => form.command === "fill");
  check("...and so is fill", fill?.syntax === "fill <from> <to> <block>", fill?.syntax ?? "missing");
}

console.log("\n--- the tag the panel names is the tag the file uses ---");
{
  /** Walks a `TagLocation` into a parsed root and returns the three numbers. */
  function vectorAt(payload: NbtCompound, location: TagLocation): number[] | null {
    let here: NbtCompound = payload;
    for (const step of location.path) {
      const next = (here[step] as { value?: NbtCompound } | undefined)?.value;
      if (!next) return null;
      here = next;
    }
    if (location.kind === "triple") {
      const parts = ["X", "Y", "Z"].map((axis) => here[`${location.tag}${axis}`]);
      if (parts.some((part) => part === undefined)) return null;
      return parts.map((part) => Number((part as { value: unknown }).value));
    }
    const raw = (here[location.tag] as { value?: unknown } | undefined)?.value;
    return Array.isArray(raw) ? raw.map(Number) : null;
  }

  /*
   * The three that have somewhere to put a vector. Litematica does not, and is
   * checked below rather than here: `anchorLocation` answers `null` for it, and
   * a loop that quietly skipped a `null` would pass just as well with a real
   * location deleted.
   */
  const located = (location: TagLocation | null): TagLocation => {
    if (location === null) throw new Error("this format has no such tag");
    return location;
  };

  for (const format of ["sponge2", "sponge3", "mcedit"] as const) {
    const doc = format === "mcedit" ? legacySafeDocument() : sampleDocument(format);
    const filePath = path.join(workDir, `located-${format}.${extensionFor(format)}`);
    await saveDocument(doc, filePath, { legacyBlocksPath: LEGACY_BLOCKS });

    const { parsed } = await parseNbt(await readFile(filePath));
    const root = parsed.value as unknown as NbtCompound;
    const payload =
      format === "sponge3" ? (root.Schematic as { value: NbtCompound }).value : root;

    equal(
      `${format}: the anchor is at ${tagPathLabel(located(anchorLocation(format)))}`,
      vectorAt(payload, located(anchorLocation(format))),
      [...doc.offset!],
    );
    equal(
      `${format}: the origin is at ${tagPathLabel(located(originLocation(format)))}`,
      vectorAt(payload, located(originLocation(format))),
      [...doc.worldOrigin!],
    );

    /*
     * And the two locations are distinct in every format, which is the whole
     * reason there are two functions. A table that collapsed them would pass
     * both checks above only if the writers had collapsed them too -- but it
     * would still be wrong the moment the vectors differ, which is why
     * `sampleDocument` gives them different values.
     */
    check(
      `${format}: and they are not the same place`,
      tagPathLabel(located(anchorLocation(format))) !== tagPathLabel(located(originLocation(format))),
      tagPathLabel(located(anchorLocation(format))),
    );
  }

  // Read as a person reads it, since that is the only thing it is for.
  equal("v3 keeps the anchor at the top level", tagPathLabel(located(anchorLocation("sponge3"))), "Offset");
  equal(
    "...and v2 does not, whatever its `Offset` tag suggests",
    tagPathLabel(located(anchorLocation("sponge2"))),
    "Metadata.WEOffsetX/Y/Z",
  );
  equal(
    "MCEdit keeps both at the root",
    [tagPathLabel(located(anchorLocation("mcedit"))), tagPathLabel(located(originLocation("mcedit")))],
    ["WEOffsetX/Y/Z", "WEOriginX/Y/Z"],
  );
  equal(
    "and v3's origin is the one that is nested",
    tagPathLabel(located(originLocation("sponge3"))),
    "Metadata.WorldEdit.Origin",
  );

  /*
   * And Litematica has neither, which is a fact about the container rather than
   * a gap in the table. It stores a region `Position` and an `EnclosingSize`
   * and has no concept of a paste anchor at all, so pointing these at some
   * plausible tag would be the exact mistake the pair exists to prevent -- the
   * file would round-trip through this app and mean nothing to the mod.
   */
  equal("a litematic has nowhere to keep an anchor", anchorLocation("litematic"), null);
  equal("...nor a world origin", originLocation("litematic"), null);
}
// --- the legacy id table, read both ways ------------------------------------
/*
 * `shared/legacy_ids.ts` exists because three places now ask which `ID:DATA` a
 * block name maps to: the MCEdit writer, the inventory that labels a legacy
 * schematic with what its file will really store, and the block field that
 * accepts one typed in. The answer involves a tie-break, and two
 * implementations of a tie-break is how they come to disagree.
 */
console.log("\n--- the legacy id table, read both ways ---");
{
  const table = await loadLegacyBlockTable(LEGACY_BLOCKS);
  const index = buildLegacyIndex(table);

  /*
   * Seventy-four modern states come from more than one `id:meta`. Water is the
   * one everybody meets: `8:0` is still water and `9:0` is flowing, and both
   * flatten to `minecraft:water[level=0]`. Lowest wins, so the answer does not
   * depend on which order the JSON happened to be written in.
   */
  equal("water resolves to the lower of its two ids", index.byName.get("minecraft:water"), {
    id: 8,
    meta: 0,
  });
  equal("...and reads back", index.byId.get("8:0"), table["8:0"]);

  // The writer and the shared index are one table, not two that agree.
  const reverse = buildReverseLegacyTable(table);
  let mismatched = 0;
  for (const [name, id] of index.byName) {
    const theirs = reverse.byName.get(name);
    if (theirs === undefined || theirs.id !== id.id || theirs.meta !== id.meta) mismatched += 1;
  }
  equal("the writer names blocks the same way, on every row", mismatched, 0);
  equal("...over the whole table", index.byName.size, reverse.byName.size);

  /*
   * The name set is what the editor refuses against, so it has to be exactly
   * what the writer can encode -- not a superset, which would let a block
   * through to fail at save time, and not a subset, which would refuse one that
   * is fine.
   */
  check("a 1.12 block is in the set", index.names.has("minecraft:oak_fence"));
  check("...and a 1.17 one is not", !index.names.has("minecraft:deepslate"));
  equal("the set is exactly what can be named", index.names.size, index.byName.size);

  // A legacy id is a shape, not just a string with a colon in it. This decides
  // whether something typed into the block field is an id at all, and
  // `minecraft:stone` has a colon too.
  equal("a plain pair parses", parseLegacyId("35:14"), { id: 35, meta: 14 });
  equal("...with spaces round it", parseLegacyId("  35:14  "), { id: 35, meta: 14 });
  equal("a block id does not", parseLegacyId("minecraft:stone"), null);
  equal("nor does a nibble out of range", parseLegacyId("35:16"), null);
  equal("nor an empty string", parseLegacyId(""), null);
  equal("and it round-trips", legacyIdLabel({ id: 35, meta: 14 }), "35:14");
}


console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
