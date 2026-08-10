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

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

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
import { paletteEntryCacheKey, type PaletteEntry } from "../src/main/pipeline/types.js";
import {
  extensionFor,
  saveDocument,
  UnrepresentableBlocksError,
} from "../src/main/services/writers.js";
import { dataVersionFor } from "../src/main/services/versions.js";

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
    doc.offset = [-8, 32, 5];
    setBlockEntity(doc, 2, 0, 1, {
      id: "minecraft:chest",
      pos: [2, 0, 1],
      nbt: { Lock: { type: "string", value: "key" } },
    });

    const filePath = path.join(workDir, "round-trip.schematic");
    const result = await saveDocument(doc, filePath, { legacyBlocksPath: LEGACY_BLOCKS });
    equal("written as MCEdit", result.format, "mcedit");

    const reloaded = documentFromLoaded(
      await loadStructure(filePath, { legacyBlocksPath: LEGACY_BLOCKS }),
      filePath,
    );
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
    equal("no legacy id went unmapped on the way back", reloaded.unmappedLegacyIds ?? [], []);
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
    equal("the WorldEdit offset survives its three shorts", reloaded.offset, [-8, 32, 5]);
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
} finally {
  await rm(workDir, { recursive: true, force: true });
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
