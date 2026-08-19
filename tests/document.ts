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
import { flattenNbt, NbtEditError, setNbtValue } from "../src/main/domain/nbt_edit.js";
import { mirrorProperties, rotateProperties } from "../src/main/domain/transform.js";
import { loadStructure } from "../src/main/pipeline/loader.js";
import { saveDocument } from "../src/main/services/writers.js";
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

// --- editing NBT ---------------------------------------------------------------
//
// NBT is typed and the types are load-bearing: a chest's Count is a byte, a
// sign's text is a string, and a file that says otherwise does not load. The
// inspector renders NBT with the type wrappers stripped because they are
// unreadable — so the one thing these have to prove is that writing a value
// back does *not* go through that stripped form.
console.log("\n--- flattening NBT for the inspector ---");
{
  const nbt = {
    Text1: { type: "string", value: '{"text":"hello"}' },
    Lock: { type: "string", value: "" },
    Items: {
      type: "list",
      value: {
        type: "compound",
        value: [
          { id: { type: "string", value: "minecraft:diamond" }, Count: { type: "byte", value: 5 } },
          { id: { type: "string", value: "minecraft:emerald" }, Count: { type: "byte", value: 1 } },
        ],
      },
    },
    Bulk: { type: "intArray", value: [1, 2, 3, 4] },
    Big: { type: "long", value: [1, 2] },
  };

  const fields = flattenNbt(nbt);
  const byLabel = new Map(fields.map((f) => [f.label, f]));

  equal("a top-level string is offered", byLabel.get("Text1")?.value, '{"text":"hello"}');
  // The doubly-nested list shape is the one that trips naive walkers: a list's
  // value is `{type, value: [...]}` and its compound elements are unwrapped.
  equal("a value inside a list is reached", byLabel.get("Items[0].Count")?.value, "5");
  equal("...and the second element too", byLabel.get("Items[1].id")?.value, "minecraft:emerald");
  equal("...carrying its tag type", byLabel.get("Items[0].Count")?.type, "byte");
  equal(
    "...with a path that addresses it",
    byLabel.get("Items[0].Count")?.path,
    ["Items", 0, "Count"],
  );

  // A long is two 32-bit halves, not a number: (1 << 32) | 2.
  equal("a long reads as one number, not a pair", byLabel.get("Big")?.value, "4294967298");

  check("bulk arrays are listed but not editable", byLabel.get("Bulk")?.editable === false);
  check("...while scalars are", byLabel.get("Text1")?.editable === true);
  check(
    "no container is offered as a field",
    !fields.some((f) => f.type === "compound" || f.type === "list"),
  );
}

console.log("\n--- writing a value keeps its type ---");
{
  const nbt = {
    Text1: { type: "string", value: "old" },
    Items: {
      type: "list",
      value: {
        type: "compound",
        value: [{ id: { type: "string", value: "minecraft:diamond" }, Count: { type: "byte", value: 5 } }],
      },
    },
  };

  const edited = setNbtValue(nbt, ["Items", 0, "Count"], "42");
  const count = (edited.Items.value as { value: Record<string, { type: string; value: unknown }>[] })
    .value[0].Count;
  equal("the value changed", count.value, 42);
  equal("...and is still a byte, not a string", count.type, "byte");
  check("...and is a number, not the text that was typed", typeof count.value === "number");

  // The original is the `before` half of an undo delta. Writing through it
  // would make undoing this edit restore the value it was changing to.
  equal(
    "the original is untouched",
    ((nbt.Items.value as { value: Record<string, { value: unknown }>[] }).value[0].Count.value),
    5,
  );

  const renamed = setNbtValue(nbt, ["Text1"], "new");
  equal("a top-level string writes too", renamed.Text1.value, "new");
  equal("...leaving its siblings alone", JSON.stringify(renamed.Items), JSON.stringify(nbt.Items));
}

console.log("\n--- what it refuses ---");
{
  const nbt = {
    Count: { type: "byte", value: 5 },
    Name: { type: "string", value: "x" },
    Items: { type: "list", value: { type: "compound", value: [{}] } },
    Bulk: { type: "intArray", value: [1, 2] },
  };
  const refuses = (path: (string | number)[], value: string): string | null => {
    try {
      setNbtValue(nbt, path, value);
      return null;
    } catch (err) {
      return err instanceof NbtEditError ? err.message : `wrong error: ${String(err)}`;
    }
  };

  // Truncating would leave a chest quietly holding 44 diamonds instead of 300,
  // which is worse than a refusal because nothing says it happened.
  check("a byte out of range is refused", refuses(["Count"], "300") !== null, "accepted 300");
  check("...and a negative one past the floor", refuses(["Count"], "-200") !== null);
  check("a byte within range is accepted", refuses(["Count"], "127") === null);
  check("text where a number belongs is refused", refuses(["Count"], "many") !== null);
  check("an empty number is refused", refuses(["Count"], "  ") !== null);
  check("an empty string is fine, though", refuses(["Name"], "") === null);

  check("a container cannot be written", refuses(["Items"], "nope") !== null);
  check("nor a bulk array", refuses(["Bulk"], "1,2,3") !== null);
  check("nor a field that does not exist", refuses(["Nope"], "x") !== null);
  check("nor an index past the end of a list", refuses(["Items", 9, "x"], "1") !== null);
  check("nor an empty path", refuses([], "x") !== null);
}

// The property everything else is for: an edited value survives being written
// to a file and read back, still typed.
console.log("\n--- an edited value survives a round trip ---");
{
  const workDir = await mkdtemp(path.join(tmpdir(), "bgpt-nbt-"));
  try {
    const doc = createDocument({ width: 2, height: 2, length: 2, format: "sponge3" });
    setBlock(doc, 0, 0, 0, { namespacedName: "minecraft:chest", properties: {} });
    setBlockEntity(doc, 0, 0, 0, {
      id: "minecraft:chest",
      pos: [0, 0, 0],
      nbt: {
        Items: {
          type: "list",
          value: {
            type: "compound",
            value: [
              { id: { type: "string", value: "minecraft:diamond" }, Count: { type: "byte", value: 1 } },
            ],
          },
        },
      },
    });

    const before = getBlockEntity(doc, 0, 0, 0)!;
    setBlockEntity(doc, 0, 0, 0, {
      ...before,
      nbt: setNbtValue(before.nbt, ["Items", 0, "Count"], "64"),
    });

    const filePath = path.join(workDir, "chest.schem");
    await saveDocument(doc, filePath, { legacyBlocksPath: null });
    const reloaded = documentFromLoaded(await loadStructure(filePath), filePath);

    const roundTripped = flattenNbt(getBlockEntity(reloaded, 0, 0, 0)!.nbt);
    const count = roundTripped.find((f) => f.label === "Items[0].Count");
    equal("the edited count came back", count?.value, "64");
    equal("...still a byte", count?.type, "byte");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// --- orientation under a transform ---------------------------------------------
//
// A quarter turn here is the mesher's: east becomes south.
console.log("\n--- block states follow a rotation ---");
{
  const r = (props: Record<string, string>, steps: 0 | 1 | 2 | 3) => rotateProperties(props, steps);

  equal("east becomes south", r({ facing: "east" }, 1).facing, "south");
  equal("...and the cycle closes", r({ facing: "north" }, 1).facing, "east");
  equal("a half turn is the opposite side", r({ facing: "north" }, 2).facing, "south");
  equal("up is not a compass direction", r({ facing: "up" }, 1).facing, "up");

  equal("a log's axis swaps on a quarter turn", r({ axis: "x" }, 1).axis, "z");
  equal("...but not on a half turn, which maps each axis onto itself", r({ axis: "x" }, 2).axis, "x");
  equal("...and the turning axis is never touched", r({ axis: "y" }, 1).axis, "y");

  // Signs and banners use a 16-step dial where 0 is south and it counts up
  // through west; a quarter turn is four steps of it.
  equal("the sign dial turns with everything else", r({ rotation: "0" }, 1).rotation, "4");
  equal("...and wraps", r({ rotation: "14" }, 1).rotation, "2");

  // A fence's connections are one flag per side, so they move rather than
  // change value.
  const fence = r({ north: "true", east: "false", south: "false", west: "false" }, 1);
  equal("a fence's north connection moves to east", fence.east, "true");
  equal("...leaving north as it found it", fence.north, "false");

  // Left and right are relative to `facing`, which is turning with them.
  equal("a stair's corner is unchanged by a turn", r({ shape: "inner_left" }, 1).shape, "inner_left");
  equal("...and so is a door's hinge", r({ hinge: "left" }, 1).hinge, "left");

  equal("a rail's straight run swaps", r({ shape: "north_south" }, 1).shape, "east_west");
  equal("...its climb turns", r({ shape: "ascending_east" }, 1).shape, "ascending_south");
  equal("...and its corner turns too", r({ shape: "south_east" }, 1).shape, "south_west");

  equal("properties that name no direction are carried across", r({ half: "top", waterlogged: "true" }, 1), {
    half: "top",
    waterlogged: "true",
  });

  // Four quarter turns are the identity, which catches a table that is right
  // in one direction and wrong in the other.
  const varied = {
    facing: "north",
    axis: "x",
    rotation: "7",
    shape: "ascending_west",
    north: "true",
    east: "false",
  };
  // `Record<string, string>`, because that is what `rotateProperties` returns;
  // inferring the narrow shape of `varied` made the reassignment below a type
  // error that nothing was compiling to notice.
  let turned: Record<string, string> = { ...varied };
  for (let i = 0; i < 4; i += 1) turned = rotateProperties(turned, 1);
  equal("four quarter turns return every property to itself", turned, varied);
}

console.log("\n--- block states follow a mirror ---");
{
  const m = mirrorProperties;

  equal("mirroring x swaps east and west", m({ facing: "east" }, "x").facing, "west");
  equal("...and leaves north alone", m({ facing: "north" }, "x").facing, "north");
  equal("mirroring z swaps north and south", m({ facing: "north" }, "z").facing, "south");

  // A reflection has no effect on which way an axis lies.
  equal("an axis is unmoved by a mirror", m({ axis: "x" }, "x").axis, "x");

  // The dial: mirroring x fixes south (0) and north (8), swapping east and west.
  equal("the dial's south is a fixed point of an x mirror", m({ rotation: "0" }, "x").rotation, "0");
  equal("...and east becomes west", m({ rotation: "12" }, "x").rotation, "4");
  equal("mirroring z fixes west instead", m({ rotation: "4" }, "z").rotation, "4");

  // A reflection is what turns a left-hand staircase into a right-hand one.
  equal("a stair's corner changes hand", m({ shape: "inner_left" }, "x").shape, "inner_right");
  equal("...as does a door's hinge", m({ hinge: "left" }, "x").hinge, "right");

  const fence = m({ north: "true", east: "true", south: "false", west: "false" }, "x");
  equal("a fence's east connection becomes west", fence.west, "true");
  equal("...while north stays north", fence.north, "true");

  equal("a rail corner reflects", m({ shape: "south_east" }, "x").shape, "south_west");

  // A mirror is its own inverse.
  const varied = { facing: "east", rotation: "3", shape: "outer_left", hinge: "right", north: "true" };
  equal("mirroring twice is the identity", m(m(varied, "x"), "x"), varied);
  equal("...on the other axis too", m(m(varied, "z"), "z"), varied);
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
