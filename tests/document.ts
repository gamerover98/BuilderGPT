/**
 * `domain/document.ts` — the mutable schematic.
 *
 * The properties worth defending here are the ones the rest of the editor will
 * lean on without checking:
 *
 * - the palette interns, so writing the same block a thousand times adds one
 *   entry, and index 0 stays air whatever the file that was loaded looked like;
 * - `toStructureData` is a faithful view, because the mesher reads it directly
 *   and a disagreement between the two would show up as a wrong render rather
 *   than an error;
 * - a resize moves the box, not the blocks;
 * - block entities follow their blocks, and a block that is replaced takes its
 *   block entity with it -- reported, so undo can put it back.
 */

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import {
  compactPalette,
  countBlocks,
  createDocument,
  documentFromLoaded,
  getBlock,
  getBlockEntity,
  internPalette,

  markSaved,
  normalizeRegion,
  paletteHistogram,
  posKey,
  regionVolume,
  resizeDocument,
  setBlock,
  setBlockEntity,
  toStructureData,
  voxelIndex,
} from "../src/main/domain/document.js";
import { loadStructure } from "../src/main/pipeline/loader.js";
import { paletteEntryCacheKey, type PaletteEntry } from "../src/main/pipeline/types.js";
import { SpongeSchematicWriter } from "../src/main/services/schematic.js";
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

const STONE = block("minecraft:stone");
const PLANKS = block("minecraft:oak_planks");
const STAIRS_N = block("minecraft:oak_stairs", { facing: "north" });
const STAIRS_S = block("minecraft:oak_stairs", { facing: "south" });

console.log("=== Schematic AI Studio: document ===\n");

// --- shape and indexing -----------------------------------------------------
console.log("--- shape ---");
{
  const doc = createDocument({ width: 3, height: 4, length: 5 });
  equal("voxel count is the product of the dimensions", doc.voxels.length, 60);
  equal("a new document is entirely air", countBlocks(doc), 0);
  equal("index 0 of the palette is air", doc.palette[0]?.namespacedName, "minecraft:air");

  // The flat formula is shared with the mesher and the loader; a disagreement
  // here transposes an axis and renders a mirrored structure.
  equal("flat index follows x*h*l + y*l + z", voxelIndex(doc, 2, 3, 4), 2 * 4 * 5 + 3 * 5 + 4);
  equal("out of bounds is -1, not a wrapped index", voxelIndex(doc, 3, 0, 0), -1);
  equal("negative is out of bounds too", voxelIndex(doc, -1, 0, 0), -1);

  check("a 0-sized document is refused", (() => {
    try {
      createDocument({ width: 0, height: 1, length: 1 });
      return false;
    } catch {
      return true;
    }
  })());
}

// --- palette interning ------------------------------------------------------
console.log("\n--- palette ---");
{
  const doc = createDocument({ width: 4, height: 1, length: 1 });
  const a = internPalette(doc, STONE);
  const b = internPalette(doc, { namespacedName: "minecraft:stone", properties: {} });
  equal("the same block interns to the same index", a, b);
  equal("...and adds one entry, not two", doc.palette.length, 2);

  // Block states are part of the identity: a north stair and a south stair are
  // different blocks, and collapsing them would silently rotate geometry.
  const n = internPalette(doc, STAIRS_N);
  const s = internPalette(doc, STAIRS_S);
  check("block states distinguish palette entries", n !== s);
  equal("property order does not", internPalette(doc, block("minecraft:oak_stairs", { facing: "north" })), n);

  setBlock(doc, 0, 0, 0, STONE);
  setBlock(doc, 1, 0, 0, STONE);
  setBlock(doc, 2, 0, 0, PLANKS);
  const histogram = paletteHistogram(doc);
  equal("histogram counts voxels, not palette entries", histogram.get("minecraft:stone"), 2);
  equal("...for each entry present", histogram.get("minecraft:oak_planks"), 1);
  check("...and omits entries no voxel uses", !histogram.has(paletteEntryCacheKey(STAIRS_N)));

  // Interning during editing must never renumber: the undo stack holds indices.
  const stoneIndex = doc.paletteIndex.get("minecraft:stone");
  internPalette(doc, block("minecraft:diamond_block"));
  equal("adding an entry leaves the existing indices alone", doc.paletteIndex.get("minecraft:stone"), stoneIndex);

  compactPalette(doc);
  equal("compaction drops the unused entries", doc.palette.length, 3);
  equal("...and rewrites the voxels to match", getBlock(doc, 0, 0, 0).namespacedName, "minecraft:stone");
  equal("...keeping air at index 0", doc.palette[0]?.namespacedName, "minecraft:air");
  equal("...and the block count", countBlocks(doc), 3);
}

// --- writing blocks ---------------------------------------------------------
console.log("\n--- set and get ---");
{
  const doc = createDocument({ width: 2, height: 2, length: 2 });
  const change = setBlock(doc, 1, 1, 1, STONE);
  equal("a write reports what it displaced", change?.before, 0);
  equal("...and what it wrote", change?.after, doc.paletteIndex.get("minecraft:stone"));
  equal("the block reads back", getBlock(doc, 1, 1, 1).namespacedName, "minecraft:stone");
  equal("its neighbour is untouched", getBlock(doc, 0, 0, 0).namespacedName, "minecraft:air");

  check("rewriting the same block changes nothing", setBlock(doc, 1, 1, 1, STONE) === null);
  check("an out-of-bounds write is refused", setBlock(doc, 9, 9, 9, STONE) === null);
  equal("reading out of bounds is air, not a crash", getBlock(doc, 9, 9, 9).namespacedName, "minecraft:air");
}

// --- block entities ---------------------------------------------------------
console.log("\n--- block entities ---");
{
  const doc = createDocument({ width: 2, height: 1, length: 1 });
  const chest = {
    id: "minecraft:chest",
    pos: [0, 0, 0] as const,
    nbt: { Items: { type: "list", value: [] } },
  };
  setBlock(doc, 0, 0, 0, block("minecraft:chest"));
  setBlockEntity(doc, 0, 0, 0, chest);
  equal("the block entity is found by position", getBlockEntity(doc, 0, 0, 0)?.id, "minecraft:chest");

  // Replacing a chest with stone must take the contents with it -- and hand
  // them back, or an undo could not restore them.
  const replaced = setBlock(doc, 0, 0, 0, STONE);
  equal("replacing the block returns its block entity", replaced?.beforeEntity?.id, "minecraft:chest");
  check("...and detaches it", getBlockEntity(doc, 0, 0, 0) === null);
}

// --- the revision counter ---------------------------------------------------
//
// Monotonic, because it is a cache key: "is the mesh I built still the mesh for
// this document". Dirtiness is a different question and lives in history.ts.
console.log("\n--- revision ---");
{
  const doc = createDocument({ width: 2, height: 1, length: 1 });
  const start = doc.revision;
  setBlock(doc, 0, 0, 0, STONE);
  check("a write advances the revision", doc.revision > start);
  const after = doc.revision;
  setBlock(doc, 0, 0, 0, STONE);
  equal("a write that changed nothing does not", doc.revision, after);

  markSaved(doc, "C:/tmp/x.schem");
  equal("saving records the path", doc.filePath, "C:/tmp/x.schem");
}

// --- regions ----------------------------------------------------------------
console.log("\n--- regions ---");
{
  const doc = createDocument({ width: 4, height: 4, length: 4 });
  const region = normalizeRegion(doc, { minX: 3, minY: 2, minZ: 1, maxX: 1, maxY: 0, maxZ: 3 });
  equal("corners are sorted", [region.minX, region.maxX], [1, 3]);
  equal("...on every axis", [region.minY, region.maxY, region.minZ, region.maxZ], [0, 2, 1, 3]);
  equal("volume is inclusive of both corners", regionVolume(region), 3 * 3 * 3);

  const clipped = normalizeRegion(doc, { minX: -5, minY: -5, minZ: -5, maxX: 99, maxY: 99, maxZ: 99 });
  equal("a region larger than the document is clipped to it", regionVolume(clipped), 64);
}

// --- resize -----------------------------------------------------------------
console.log("\n--- resize ---");
{
  const doc = createDocument({ width: 2, height: 2, length: 2 });
  setBlock(doc, 0, 0, 0, STONE);
  setBlock(doc, 1, 1, 1, PLANKS);
  setBlockEntity(doc, 1, 1, 1, {
    id: "minecraft:barrel",
    pos: [1, 1, 1] as const,
    nbt: {},
  });

  // "Make the tower taller": the box grows, the blocks stay put.
  resizeDocument(doc, { width: 2, height: 6, length: 2 });
  equal("the box grew", [doc.width, doc.height, doc.length], [2, 6, 2]);
  equal("a block kept its coordinates", getBlock(doc, 0, 0, 0).namespacedName, "minecraft:stone");
  equal("...and so did the other", getBlock(doc, 1, 1, 1).namespacedName, "minecraft:oak_planks");
  equal("the new space is air", getBlock(doc, 1, 5, 1).namespacedName, "minecraft:air");
  equal("nothing was lost", countBlocks(doc), 2);
  equal("the block entity came along", getBlockEntity(doc, 1, 1, 1)?.id, "minecraft:barrel");

  // Growing downwards: the grid has no negative coordinates, so the content
  // shifts up instead and the world offset compensates.
  const before = [...doc.offset];
  resizeDocument(doc, { width: 2, height: 8, length: 2 }, [0, 2, 0]);
  equal("a shift moves the content", getBlock(doc, 0, 2, 0).namespacedName, "minecraft:stone");
  equal("...leaving air beneath it", getBlock(doc, 0, 0, 0).namespacedName, "minecraft:air");
  equal("...and the block entity with it", getBlockEntity(doc, 1, 3, 1)?.id, "minecraft:barrel");
  equal("the world offset compensates, so nothing moved in the world", doc.offset[1], before[1] - 2);

  // Shrinking is allowed and lossy, which is the caller's problem -- but it
  // must not strand a block entity at a position that no longer exists.
  resizeDocument(doc, { width: 1, height: 1, length: 1 });
  equal("shrinking drops what falls outside", countBlocks(doc), 0);
  equal("...including block entities", doc.blockEntities.size, 0);
}

// --- the view the mesher takes ----------------------------------------------
console.log("\n--- toStructureData ---");
{
  const doc = createDocument({ width: 3, height: 2, length: 2 });
  setBlock(doc, 2, 1, 1, STONE);
  const view = toStructureData(doc);
  equal("bounds describe the same box", [view.bounds.maxX, view.bounds.maxY, view.bounds.maxZ], [2, 1, 1]);
  check("the voxel array is shared, not copied", view.voxels === doc.voxels);
  check("the palette is shared too", view.palette === doc.palette);
  equal(
    "a voxel reads the same through the view",
    view.palette[view.voxels[voxelIndex(doc, 2, 1, 1)]]?.namespacedName,
    "minecraft:stone",
  );
}

// --- round trip through a real file -----------------------------------------
//
// The one test that ties the document to the rest of the app: a file written by
// the app's own writer, read by the app's own loader, adopted as a document,
// and compared block for block. Anything the adoption step gets wrong about
// palette remapping or index order shows up here.
console.log("\n--- adopting a loaded schematic ---");
{
  const workDir = await mkdtemp(path.join(tmpdir(), "bgpt-doc-"));
  try {
    const writer = new SpongeSchematicWriter();
    const placed: Array<[number, number, number, string]> = [
      [0, 0, 0, "minecraft:stone"],
      [1, 0, 0, "minecraft:oak_planks"],
      [2, 1, 1, "minecraft:oak_stairs[facing=north]"],
      [0, 2, 3, "minecraft:glass"],
    ];
    for (const [x, y, z, name] of placed) {
      writer.setBlock([x, y, z], name);
    }
    const filePath = await writer.save(workDir, "doc-round-trip", dataVersionFor("JE_1_20_4"));

    const loaded = await loadStructure(filePath);
    const doc = documentFromLoaded(loaded, filePath);

    equal("dimensions survive", [doc.width, doc.height, doc.length], [3, 3, 4]);
    equal("the block count survives", countBlocks(doc), placed.length);
    equal("air is still index 0 after remapping", doc.palette[0]?.namespacedName, "minecraft:air");

    for (const [x, y, z, name] of placed) {
      const base = name.split("[")[0];
      equal(`block at ${posKey(x, y, z)}`, getBlock(doc, x, y, z).namespacedName, base);
    }
    equal(
      "block states survive the round trip",
      getBlock(doc, 2, 1, 1).properties.facing,
      "north",
    );
    equal("a freshly loaded document starts at revision 0", doc.revision, 0);
    equal("...and knows where it came from", doc.filePath, filePath);
    equal("the format is remembered", doc.format, "sponge2");
    equal("the DataVersion is remembered", doc.dataVersion, dataVersionFor("JE_1_20_4"));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
