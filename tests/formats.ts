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

import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

import { parse as parseNbt } from "prismarine-nbt";

import {
  omittedTags,
  schematicNbtTree,
} from "../src/main/services/schematic_nbt.js";
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
import {
  extensionFor,
  saveDocument,
  UnrepresentableBlocksError,
} from "../src/main/services/writers.js";
import { dataVersionFor } from "../src/main/services/versions.js";
import { dataVersionFor as _unusedDataVersionFor, VERSION_NAMES } from "../src/main/services/versions.js";
import {
  dataVersionOf,
  eraOf,
  formatsFor,
  formatSupportsVersion,
  MC_VERSION_NAMES,
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
  for (const format of ["sponge2", "sponge3", "mcedit"] as const) {
    // MCEdit cannot carry an oak sign at all, so that case gets a document the
    // legacy table knows every block of. Everything else about it is the same.
    const doc = format === "mcedit" ? legacySafeDocument() : sampleDocument(format);
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

    equal(
      `${format}: the panel shows exactly the file's own tags`,
      schematicNbtTree(doc, true),
      fromFile,
    );
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
  equal("a flat version gets all three", formatsFor("JE_1_20_4"), ["sponge3", "sponge2", "mcedit"]);
  equal("nothing is refused there", refusalFor("sponge3", "JE_1_20_4"), null);

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

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
