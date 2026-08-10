/**
 * Block geometry and texture orientation.
 *
 * These are the properties that were wrong in the first textured render and
 * are invisible to every other suite: the schematic decoded correctly, the GLB
 * was well formed, and the picture was still wrong. Each check below encodes
 * one of those defects so it cannot come back quietly.
 */

import { readdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { occludesNeighbours, shapeFor } from "../src/main/pipeline/block_shapes.js";
import { ModelBaker, type BakedBlock } from "../src/main/pipeline/model_baker.js";
import { buildMesh, culledFaces } from "../src/main/pipeline/mesher.js";
import { buildAtlas } from "../src/main/pipeline/atlas.js";
import type { BakedFace, PaletteEntry, StructureData } from "../src/main/pipeline/types.js";

let failures = 0;

function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures += 1;
}

function equal(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) console.log(`         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  check(label, ok);
}

function block(name: string, properties: Record<string, string> = {}): PaletteEntry {
  return { namespacedName: `minecraft:${name}`, properties };
}

async function findBundledResourcePack(): Promise<string | null> {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "resources");
  try {
    const zips = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".zip")).sort();
    return zips.length > 0 ? path.join(dir, zips[0]) : null;
  } catch {
    return null;
  }
}

/** Every vertex of every face a block bakes to, in block-local 0..1 space. */
function allVertices(baked: BakedBlock): Array<[number, number, number]> {
  const faces: BakedFace[] = [...Object.values(baked.faces), ...baked.extraFaces];
  const out: Array<[number, number, number]> = [];
  for (const face of faces) {
    for (let i = 0; i < face.positions.length; i += 3) {
      out.push([face.positions[i], face.positions[i + 1], face.positions[i + 2]]);
    }
  }
  return out;
}

console.log("=== BuilderGPT block geometry ===\n");

const pack = await findBundledResourcePack();
const baker = await ModelBaker.create(null, pack);

// --- texture orientation ----------------------------------------------------
//
// The defect: `_UNIT_UVS` put V=0 at the world *bottom* of a face, but glTF
// puts V=0 at the *top* of the image, so every side texture was upside down.
// It showed on grass_block, whose green overhang appeared along the bottom.
console.log("--- texture orientation ---");
{
  const baked = await baker.bakeBlockstate(block("grass_block"));
  const north = baked.faces.north;
  check("grass_block bakes a north face", north !== undefined);
  if (north) {
    // uvs are (u,v) per vertex, in the same order as positions.
    let vAtTop = -1;
    let vAtBottom = -1;
    for (let i = 0; i < 4; i += 1) {
      const y = north.positions[i * 3 + 1];
      const v = north.uvs[i * 2 + 1];
      if (y === 1) vAtTop = v;
      if (y === 0) vAtBottom = v;
    }
    check("the top of a face samples the top of its tile (V=0)", vAtTop === 0);
    check("the bottom of a face samples the bottom of its tile (V=1)", vAtBottom === 1);
  }
}

// --- invisible blocks -------------------------------------------------------
//
// barrier is 65% of the block count in a typical village schematic. Drawn as a
// solid cube it encloses and hides the entire structure.
console.log("\n--- invisible blocks ---");
for (const name of ["barrier", "light", "structure_void"]) {
  const baked = await baker.bakeBlockstate(block(name));
  equal(`${name} bakes no geometry`, allVertices(baked).length, 0);
  check(`${name} does not occlude its neighbours`, !occludesNeighbours(block(name)));
}

// --- shapes -----------------------------------------------------------------
console.log("\n--- shapes ---");
{
  const bottom = await baker.bakeBlockstate(block("oak_slab", { type: "bottom" }));
  const ys = allVertices(bottom).map((v) => v[1]);
  check("a bottom slab occupies only the lower half", Math.max(...ys) === 0.5 && Math.min(...ys) === 0);

  const top = await baker.bakeBlockstate(block("oak_slab", { type: "top" }));
  const topYs = allVertices(top).map((v) => v[1]);
  check("a top slab occupies only the upper half", Math.min(...topYs) === 0.5 && Math.max(...topYs) === 1);

  const double = await baker.bakeBlockstate(block("oak_slab", { type: "double" }));
  check("a double slab is a full cube again", double.isFullCube);
}

{
  // Vanilla `stairs.json` is authored facing east with the step at x 8..16, so
  // the raised half must sit on the side the block faces.
  const cases = [
    ["east", (v: [number, number, number]) => v[0] >= 0.5],
    ["west", (v: [number, number, number]) => v[0] <= 0.5],
    ["south", (v: [number, number, number]) => v[2] >= 0.5],
    ["north", (v: [number, number, number]) => v[2] <= 0.5],
  ] as const;
  for (const [facing, onFacingSide] of cases) {
    const baked = await baker.bakeBlockstate(
      block("oak_stairs", { facing, half: "bottom", shape: "straight" }),
    );
    const upper = allVertices(baked).filter((v) => v[1] > 0.5);
    check(`stairs facing ${facing} raise the ${facing} half`, upper.length > 0 && upper.every(onFacingSide));
  }

  const top = await baker.bakeBlockstate(
    block("oak_stairs", { facing: "east", half: "top", shape: "straight" }),
  );
  const solidLow = allVertices(top).filter((v) => v[1] < 0.5);
  check(
    "half=top mirrors the step to the bottom",
    solidLow.length > 0 && solidLow.every((v) => v[0] >= 0.5),
  );
}

{
  const fence = await baker.bakeBlockstate(
    block("oak_fence", { north: "false", south: "false", east: "false", west: "false" }),
  );
  const xs = allVertices(fence).map((v) => v[0]);
  check(
    "an unconnected fence is just its post",
    Math.min(...xs) === 0.375 && Math.max(...xs) === 0.625,
  );

  const connected = await baker.bakeBlockstate(
    block("oak_fence", { north: "true", south: "false", east: "false", west: "false" }),
  );
  const zs = allVertices(connected).map((v) => v[2]);
  check("a north-connected fence reaches the north edge", Math.min(...zs) === 0);
}

{
  const flower = await baker.bakeBlockstate(block("peony", { half: "upper" }));
  equal("a flower is two crossed quads", flower.extraFaces.length, 2);
  check("a flower is never a full cube", !flower.isFullCube);
}

{
  // A gate must sit *in* the fence line, not across it. The vanilla template is
  // authored facing south, and treating it as east-authored turned every gate
  // 90 degrees.
  const gate = await baker.bakeBlockstate(block("oak_fence_gate", { facing: "south", open: "false" }));
  const verts = allVertices(gate);
  const zs = verts.map((v) => v[2]);
  const xs = verts.map((v) => v[0]);
  check(
    "a south-facing gate spans east-west and is thin north-south",
    Math.min(...xs) === 0 && Math.max(...xs) === 1 && Math.min(...zs) === 7 / 16 && Math.max(...zs) === 9 / 16,
  );

  const east = await baker.bakeBlockstate(block("oak_fence_gate", { facing: "east", open: "false" }));
  const eastVerts = allVertices(east);
  check(
    "an east-facing gate spans north-south instead",
    Math.min(...eastVerts.map((v) => v[2])) === 0 &&
      Math.max(...eastVerts.map((v) => v[2])) === 1 &&
      Math.min(...eastVerts.map((v) => v[0])) === 7 / 16,
  );

  const open = await baker.bakeBlockstate(block("oak_fence_gate", { facing: "south", open: "true" }));
  check("an open gate drops its bars", open.extraFaces.length < gate.extraFaces.length);
}

{
  // `wall_torch.json` hangs the torch off the -X edge and the blockstate
  // rotates from facing=east: a torch facing east is mounted on the wall to
  // its west, not its east. The *base* is what has to touch that wall — the
  // top leans out past the block, which is the point of the tilt.
  const east = await baker.bakeBlockstate(block("wall_torch", { facing: "east" }));
  const eastBase = allVertices(east).filter((v) => v[1] < 0.35);
  check("an east-facing wall torch is footed on the west wall", Math.min(...eastBase.map((v) => v[0])) < 0);

  const north = await baker.bakeBlockstate(block("wall_torch", { facing: "north" }));
  const northBase = allVertices(north).filter((v) => v[1] < 0.35);
  check(
    "a north-facing wall torch is footed on the south wall",
    Math.max(...northBase.map((v) => v[2])) > 1,
  );
}

{
  const lantern = await baker.bakeBlockstate(block("lantern"));
  const side = lantern.extraFaces.find((f) => f.normal[2] === -1);
  check("a lantern bakes a side face", side !== undefined);
  if (side) {
    // Vanilla `lantern.json` draws the body's sides from uv [0,2,6,9]; the box
    // coordinates would have picked a region of the sheet with nothing on it.
    const us = [side.uvs[0], side.uvs[2], side.uvs[4], side.uvs[6]];
    const vs = [side.uvs[1], side.uvs[3], side.uvs[5], side.uvs[7]];
    check("its UVs come from the model's window, not its box", Math.min(...us) === 0);
    check("the window's V range is the model's", Math.min(...vs) === 2 / 16 && Math.max(...vs) === 9 / 16);
  }

  // A bed's legs have their own offsets on the sheet. Sharing the mattress
  // window, and leaving five of their six faces with no window at all, put
  // pale rectangles of empty sheet under every bed.
  const bedHead = await baker.bakeBlockstate(block("red_bed", { part: "head", facing: "north" }));
  const bedFoot = await baker.bakeBlockstate(block("red_bed", { part: "foot", facing: "north" }));
  const windows = new Set(
    bedHead.extraFaces.map((f) => [...f.uvs].map((n) => n.toFixed(4)).join(",")),
  );
  check("a bed's legs do not reuse the mattress window", windows.size > 2);
  check(
    "head and foot read from different halves of the sheet",
    JSON.stringify([...bedHead.extraFaces[0].uvs]) !== JSON.stringify([...bedFoot.extraFaces[0].uvs]),
  );
  check(
    "every bed face has an explicit window",
    bedHead.extraFaces.every((f) => f.uvs.some((n) => n !== 0 && n !== 1)),
  );

  // The chest's lid rests exactly on its body; two coincident planes z-fight,
  // and the body's top window is the chest's dark interior.
  const chestBlock = await baker.bakeBlockstate(block("chest", { facing: "north", type: "single" }));
  const upFaces = chestBlock.extraFaces.filter((f) => f.normal[1] === 1);
  equal("a chest draws one top face, not two", upFaces.length, 1);
  const downFaces = chestBlock.extraFaces.filter((f) => f.normal[1] === -1);
  equal("and one bottom face", downFaces.length, 1);

  const beacon = await baker.bakeBlockstate(block("beacon"));
  const keys = new Set(beacon.extraFaces.map((f) => f.textureKey));
  check("a beacon is a glass shell around a separate core", keys.size === 2);
  check("one of them is glass", keys.has("minecraft:block/glass"));
}

// --- culling ----------------------------------------------------------------
//
// mesher.py culled against a hardcoded "is transparent" name list, so a solid
// block next to a slab or a fence lost the face behind it -- a hole exactly
// where the neighbour does not actually cover anything.
console.log("\n--- culling ---");
check("a plain cube occludes", occludesNeighbours(block("stone")));
check("a slab does not occlude", !occludesNeighbours(block("oak_slab", { type: "bottom" })));
check("a fence does not occlude", !occludesNeighbours(block("oak_fence")));
check("a stair does not occlude", !occludesNeighbours(block("oak_stairs")));
check("glass does not occlude", !occludesNeighbours(block("glass")));
check("leaves do not occlude", !occludesNeighbours(block("oak_leaves")));

// The one that was missing, and it cost the whole render: air is in no shape
// table, so it fell through to CUBE and answered "yes, I cover that face" --
// for every exposed face in every schematic.
for (const name of ["air", "cave_air", "void_air"]) {
  check(`${name} does not occlude`, !occludesNeighbours(block(name)));
}
check("water does not occlude the ground under it", !occludesNeighbours(block("water")));
check("lava does not occlude either", !occludesNeighbours(block("lava")));

// Same class of gap as air: a name absent from every table becomes a full
// opaque cube. `SUFFIX_SHAPES` keys "_torch", which the bare name does not end
// with, so the commonest light source in the game was a solid block.
check("a standing torch is not a cube", shapeFor(block("torch")).kind !== "cube");
check("a standing torch does not occlude", !occludesNeighbours(block("torch")));
for (const name of ["rail", "lever", "cactus", "lectern", "stonecutter", "scaffolding"]) {
  check(`${name} is not a full cube`, shapeFor(block(name)).kind !== "cube");
}

{
  // Two blocks side by side on the x axis: stone at x=0, a slab at x=1.
  const palette: PaletteEntry[] = [block("air"), block("stone"), block("oak_slab", { type: "bottom" })];
  const voxels = new Int32Array([1, 2]);
  const struct: StructureData = {
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 0 },
    palette,
    voxels,
  };
  const faces = await culledFaces(struct, baker);
  const stoneEast = faces.filter((f) => f.normal[0] === 1 && f.positions[0] === 1);
  check("a cube keeps the face it shares with a slab", stoneEast.length === 1);

  const mesh = buildMesh(faces, buildAtlas(baker.textures).uvRects);
  check("the pair meshes to real geometry", mesh.indices.length > 0);
}

// --- how much geometry a real structure produces -----------------------------
//
// The checks above are all predicate-level, and that is exactly how the air bug
// survived: `occludesNeighbours(air)` was never asked. These run whole voxel
// grids through `culledFaces` and compare against a total anyone can count by
// hand. With air occluding, the first two came back with 0 faces and the third
// with 20 instead of 70 — the outer shell of the bounding box and nothing else.
console.log("\n--- geometry from a real voxel grid ---");

/** Builds a structure of the given size, filling voxels from `at`. */
function structureOf(
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  palette: PaletteEntry[],
  at: (x: number, y: number, z: number) => number,
): StructureData {
  const voxels = new Int32Array(sizeX * sizeY * sizeZ);
  for (let x = 0; x < sizeX; x += 1) {
    for (let y = 0; y < sizeY; y += 1) {
      for (let z = 0; z < sizeZ; z += 1) {
        // The canonical flat index, RULEBOOK.md §2.
        voxels[x * sizeY * sizeZ + y * sizeZ + z] = at(x, y, z);
      }
    }
  }
  return {
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: sizeX - 1, maxY: sizeY - 1, maxZ: sizeZ - 1 },
    palette,
    voxels,
  };
}

{
  // One stone block floating in the middle of a 3x3x3 of air. Every one of its
  // six faces looks at air, so all six must survive.
  const struct = structureOf(3, 3, 3, [block("air"), block("stone")], (x, y, z) =>
    x === 1 && y === 1 && z === 1 ? 1 : 0,
  );
  equal("a lone block surrounded by air keeps all 6 faces", (await culledFaces(struct, baker)).length, 6);
}

{
  // A solid 3x3x3 core of stone inside a 5x5x5 of air: 9 faces per side, and
  // not one of the 27-block interior.
  const struct = structureOf(5, 5, 5, [block("air"), block("stone")], (x, y, z) =>
    x >= 1 && x <= 3 && y >= 1 && y <= 3 && z >= 1 && z <= 3 ? 1 : 0,
  );
  equal("a 3x3x3 core shows its 54 outer faces and no interior", (await culledFaces(struct, baker)).length, 54);
}

{
  // A lawn: 5x5 of grass with a layer of air above it. This is the shape the
  // generated house was mostly made of, and the shape that made the defect
  // visible — its 25 top faces are the ones the player actually looks at.
  const struct = structureOf(5, 2, 5, [block("air"), block("grass_block")], (_x, y) => (y === 0 ? 1 : 0));
  const faces = await culledFaces(struct, baker);
  equal("a 5x5 lawn keeps its 25 top faces", faces.filter((f) => f.normal[1] === 1).length, 25);
  // 25 up + 25 down (the grid floor) + 4 sides of 5.
  equal("and 70 faces in total", faces.length, 70);
}

{
  // See-through blocks: glass must not cull the stone beside it, but must still
  // cull the glass beside it — otherwise a window pane meshes its own interior.
  const struct = structureOf(3, 1, 1, [block("air"), block("glass"), block("stone")], (x) =>
    x === 0 ? 1 : x === 1 ? 1 : 2,
  );
  const faces = await culledFaces(struct, baker);
  const stoneWest = faces.filter((f) => f.normal[0] === -1 && f.positions[0] === 2);
  check("stone keeps the face it shares with glass", stoneWest.length === 1);
  const glassBetween = faces.filter((f) => f.normal[0] === 1 && f.positions[0] === 1);
  check("glass drops the face it shares with glass", glassBetween.length === 0);
}

// --- shaped blocks borrow their material's texture ---------------------------
//
// There is no oak_stairs.png. Before the material fallback existed, every
// stair, slab, fence and wall fell through to the hashed-colour cube.
console.log("\n--- texture resolution for shaped blocks ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack to resolve against");
} else {
  const expectations: Array<[PaletteEntry, string]> = [
    [block("oak_stairs", { facing: "east" }), "minecraft:block/oak_planks"],
    [block("oak_slab", { type: "bottom" }), "minecraft:block/oak_planks"],
    [block("oak_fence"), "minecraft:block/oak_planks"],
    [block("cobblestone_wall"), "minecraft:block/cobblestone"],
    [block("cobblestone_stairs", { facing: "east" }), "minecraft:block/cobblestone"],
    [block("glass_pane"), "minecraft:block/glass"],
    [block("wall_torch", { facing: "east" }), "minecraft:block/torch"],
    // Block entities: real sheets under textures/entity/, not stand-ins.
    [block("red_bed", { part: "head" }), "minecraft:entity/bed/red"],
    [block("chest", { facing: "north", type: "single" }), "minecraft:entity/chest/normal"],
    [block("chest", { facing: "north", type: "left" }), "minecraft:entity/chest/normal_left"],
    [block("chest", { facing: "north", type: "right" }), "minecraft:entity/chest/normal_right"],
    [block("trapped_chest", { type: "single" }), "minecraft:entity/chest/trapped"],
    [block("oak_wall_sign", { facing: "north" }), "minecraft:entity/signs/oak"],
    // No usable sheet: a banner is a base plus pattern layers this code cannot
    // compose, so the dyed wool is the deliberate stand-in.
    [block("red_wall_banner", { facing: "north" }), "minecraft:block/red_wool"],
  ];
  for (const [entry, expected] of expectations) {
    const baked = await baker.bakeBlockstate(entry);
    equal(`${entry.namespacedName.replace("minecraft:", "")} -> ${expected}`, baked.textureKey, expected);
  }
}

// --- animated textures ------------------------------------------------------
//
// Minecraft stacks an animated texture's frames vertically in one file:
// lantern.png is 3 frames tall. Treated as one image the atlas squashes it,
// and every UV window then addresses the wrong pixels — which is exactly how a
// lantern ends up wearing a smear of its own chain.
console.log("\n--- animated textures ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const lanternBaker = await ModelBaker.create(null, pack);
  await lanternBaker.bakeBlockstate(block("lantern"));
  const tex = lanternBaker.textures["minecraft:block/lantern"];
  check("the lantern texture loads", tex !== undefined);
  if (tex) {
    equal("only the first animation frame is kept", [tex.width, tex.height], [tex.width, tex.width]);
  }
}

// --- element rotation -------------------------------------------------------
console.log("\n--- element rotation ---");
{
  const wall = await baker.bakeBlockstate(block("wall_torch", { facing: "east" }));
  const verts = allVertices(wall);
  const ys = verts.map((v) => v[1]);
  // A 22.5-degree lean cannot leave every vertex on one of two heights, which
  // is what an untilted box would give.
  check("a wall torch is tilted, not an upright box", new Set(ys.map((y) => y.toFixed(4))).size > 2);
  check("it still hangs off the wall it is mounted on", Math.min(...verts.map((v) => v[0])) < 0);

  const standing = await baker.bakeBlockstate(block("torch"));
  const standingYs = allVertices(standing).map((v) => v[1]);
  equal("a standing torch is not tilted", new Set(standingYs.map((y) => y.toFixed(4))).size, 2);

  // The lean must be *away* from the wall. Asserting the physical property
  // rather than the rotation's sign, because the sign depends on a convention
  // that is easy to get backwards -- and was: the torches first came out
  // leaning into the block they were mounted on.
  const leanAxis: Array<[string, (v: [number, number, number]) => number, number]> = [
    ["east", (v) => v[0], 1],
    ["west", (v) => v[0], -1],
    ["south", (v) => v[2], 1],
    ["north", (v) => v[2], -1],
  ];
  for (const [facing, axis, sign] of leanAxis) {
    const torch = await baker.bakeBlockstate(block("wall_torch", { facing }));
    const vs = allVertices(torch);
    const top = vs.filter((v) => v[1] > 0.5);
    const bottom = vs.filter((v) => v[1] < 0.35);
    const mean = (list: typeof vs) => list.reduce((s, v) => s + axis(v), 0) / list.length;
    check(
      `a ${facing}-facing wall torch leans ${facing}, away from its wall`,
      (mean(top) - mean(bottom)) * sign > 0,
    );
  }
}

// --- lantern ----------------------------------------------------------------
console.log("\n--- lantern ---");
{
  const standing = await baker.bakeBlockstate(block("lantern", { hanging: "false" }));
  const hanging = await baker.bakeBlockstate(block("lantern", { hanging: "true" }));
  const topOf = (b: BakedBlock) => Math.max(...allVertices(b).map((v) => v[1]));
  check("a floor lantern grows no chain to the ceiling", topOf(standing) < 0.75);
  check("a hanging lantern's chain reaches the ceiling", topOf(hanging) === 1);
}

// --- trapdoor ---------------------------------------------------------------
console.log("\n--- trapdoor ---");
{
  // The open template is authored facing north with the panel on the south
  // side; treating it as east-authored put every open trapdoor a quarter-turn
  // out of true.
  const north = await baker.bakeBlockstate(block("oak_trapdoor", { facing: "north", open: "true", half: "bottom" }));
  check(
    "an open north-facing trapdoor lies against the south wall",
    Math.min(...allVertices(north).map((v) => v[2])) >= 0.8125,
  );
  const east = await baker.bakeBlockstate(block("oak_trapdoor", { facing: "east", open: "true", half: "bottom" }));
  check(
    "an open east-facing trapdoor lies against the west wall",
    Math.max(...allVertices(east).map((v) => v[0])) <= 0.1875,
  );
  const closed = await baker.bakeBlockstate(block("oak_trapdoor", { facing: "north", open: "false", half: "top" }));
  check(
    "a closed top trapdoor is a thin panel at the ceiling",
    Math.min(...allVertices(closed).map((v) => v[1])) === 0.8125,
  );
}

// --- biome tint -------------------------------------------------------------
//
// Minecraft ships grass, leaves and vines greyscale and tints them per biome.
// Untinted they render a flat grey next to correctly-coloured dirt and planks.
console.log("\n--- biome tint ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack to tint");
} else {
  const plain = await ModelBaker.create(null, pack, "#ffffff");
  const green = await ModelBaker.create(null, pack, "#91bd59");
  const red = await ModelBaker.create(null, pack, "#ff0000");
  for (const baker2 of [plain, green, red]) {
    await baker2.bakeBlockstate(block("grass_block"));
    await baker2.bakeBlockstate(block("oak_leaves"));
    await baker2.bakeBlockstate(block("cobblestone"));
  }

  const key = "minecraft:block/grass_block_top";
  const untinted = plain.textures[key];
  const tinted = green.textures[key];
  check("the grass top texture is present", untinted !== undefined && tinted !== undefined);
  if (untinted && tinted) {
    check(
      "a tint changes it",
      Buffer.compare(Buffer.from(untinted.data), Buffer.from(tinted.data)) !== 0,
    );
    // Green tint: the red channel must come down, the green channel much less.
    let redDrop = 0;
    let greenDrop = 0;
    for (let i = 0; i < untinted.data.length; i += 4) {
      redDrop += untinted.data[i] - tinted.data[i];
      greenDrop += untinted.data[i + 1] - tinted.data[i + 1];
    }
    check("a green tint suppresses red more than green", redDrop > greenDrop);
  }

  const leaves = "minecraft:block/oak_leaves";
  check(
    "leaves are tinted too",
    plain.textures[leaves] !== undefined &&
      Buffer.compare(
        Buffer.from(plain.textures[leaves].data),
        Buffer.from(red.textures[leaves].data),
      ) !== 0,
  );

  const stone = "minecraft:block/cobblestone";
  check(
    "an untinted block is left alone",
    Buffer.compare(
      Buffer.from(plain.textures[stone].data),
      Buffer.from(red.textures[stone].data),
    ) === 0,
  );

  // --- water ----------------------------------------------------------------
  //
  // `minecraft:water`'s texture is `water_still`, a name none of the generic
  // candidates produce, so water used to fall through to the hashed-colour
  // cube — whose hash for `water[level=0]` is a vivid green. And once found it
  // is as greyscale as grass, but takes the biome's *water* colour, a separate
  // number from the foliage one.
  console.log("\n--- water ---");
  const water = await ModelBaker.create(null, pack, "#91bd59", "#3f76e4");
  const baked = await water.bakeBlockstate(block("water", { level: "0" }));
  equal("water resolves to its real texture", baked.textureKey, "minecraft:block/water_still");
  equal("lava too", (await water.bakeBlockstate(block("lava"))).textureKey, "minecraft:block/lava_still");

  const still = water.textures["minecraft:block/water_still"];
  check("the water texture is present", still !== undefined);
  if (still) {
    equal("only its first animation frame is kept", still.height, still.width);
    let r = 0;
    let b = 0;
    for (let i = 0; i < still.data.length; i += 4) {
      r += still.data[i];
      b += still.data[i + 2];
    }
    check("a blue water tint leaves it blue, not green", b > r);
  }

  // The two tints must be independent: changing foliage must not move water.
  const otherFoliage = await ModelBaker.create(null, pack, "#ff0000", "#3f76e4");
  await otherFoliage.bakeBlockstate(block("water", { level: "0" }));
  check(
    "the foliage tint does not touch water",
    Buffer.compare(
      Buffer.from(still.data),
      Buffer.from(otherFoliage.textures["minecraft:block/water_still"].data),
    ) === 0,
  );
  const otherWater = await ModelBaker.create(null, pack, "#91bd59", "#ff0000");
  await otherWater.bakeBlockstate(block("water", { level: "0" }));
  check(
    "the water tint does move water",
    Buffer.compare(
      Buffer.from(still.data),
      Buffer.from(otherWater.textures["minecraft:block/water_still"].data),
    ) !== 0,
  );
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
