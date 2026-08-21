/**
 * Block geometry and texture orientation.
 *
 * These are the properties that were wrong in the first textured render and
 * are invisible to every other suite: the schematic decoded correctly, the GLB
 * was well formed, and the picture was still wrong. Each check below encodes
 * one of those defects so it cannot come back quietly.
 */

import { readFileSync } from "fs";
import { readdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { parseBlockList } from "../src/main/core.js";
import { searchBlocks } from "../src/renderer/src/lib/block_search.js";
import {
  ORIENTED_BLOCK_NAMES,
  orientPlacement,
  placementState,
  type PlacementLook,
} from "../src/shared/block_orientation.js";
import { occludesNeighbours, shapeFor } from "../src/main/pipeline/block_shapes.js";
import { ModelBaker, type BakedBlock } from "../src/main/pipeline/model_baker.js";
import { buildMesh, culledFaces } from "../src/main/pipeline/mesher.js";
import { buildAtlas } from "../src/main/pipeline/atlas.js";
import type { BakedFace, PaletteEntry, StructureData } from "../src/main/pipeline/types.js";
import {
  blockEmission,
  computeLight,
  cornerOcclusion,
  MAX_LIGHT,
  OCCLUSION_LEVELS,
} from "../src/main/pipeline/lighting.js";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) {
    if (detail) console.log(`         ${detail}`);
    failures += 1;
  }
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

console.log("=== Schematic AI Studio block geometry ===\n");

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
console.log("\n--- invisible blocks ---");
{
  /*
   * `light` really is invisible: it has no in-game appearance to reproduce and
   * no structural meaning to review.
   */
  const baked = await baker.bakeBlockstate(block("light"));
  equal("light bakes no geometry", allVertices(baked).length, 0);
  check("light does not occlude its neighbours", !occludesNeighbours(block("light")));
}

// --- markers ----------------------------------------------------------------
//
// barrier and structure_void are invisible to a *player* and are exactly what
// the person building a schematic needs to see: a barrier is placed on purpose,
// to keep people out of somewhere, and a shell of them is a decision that has to
// be reviewable. They used to bake nothing, which meant a build could be full of
// them and look empty.
//
// The pair of properties below is what makes drawing them safe. Cull, and a
// barrier would delete the face of the wall behind it -- worse than not drawing
// it at all, because the wall is real and the barrier is not.
console.log("\n--- markers ---");
for (const name of ["barrier", "structure_void"]) {
  const baked = await baker.bakeBlockstate(block(name));
  check(`${name} is drawn`, allVertices(baked).length > 0, "it bakes nothing");
  check(
    `${name} still does not occlude its neighbours`,
    !occludesNeighbours(block(name)),
  );
  /*
   * And it is the *item* icon, because neither block has a block texture --
   * what the game has is the picture it shows you in your hand, which is the
   * thing that identifies it.
   */
  const keys = [...Object.values(baked.faces), ...baked.extraFaces].map((f) => f.textureKey);
  check(
    `${name} is drawn with its own icon`,
    keys.length > 0 && keys.every((key) => key === `minecraft:item/${name}`),
    keys.join(", "),
  );
}

{
  /*
   * The block the game puts where a pushed block is on its way to. It is
   * rendered in vanilla -- it is what you see mid-push -- so drawing nothing
   * left a hole in any schematic captured with a piston firing.
   */
  const baked = await baker.bakeBlockstate(block("moving_piston"));
  const vertices = allVertices(baked);
  check("moving_piston is drawn", vertices.length > 0, "it bakes nothing");
  check(
    "...and is not a full cube, because a piston head is a plate and a rod",
    !baked.isFullCube,
  );
  const ys = vertices.map((v) => v[1]);
  check(
    "...reaching from the face it pushes to the block behind it",
    Math.min(...ys) === 0 && Math.max(...ys) === 1,
    `${Math.min(...ys)}..${Math.max(...ys)}`,
  );
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

// --- which way a placed block points -----------------------------------------
//
// Everything placed by hand used to land in its default state, which for a
// block with a direction is a lie the file then carries: every staircase
// facing north, every log standing up, every slab on the floor. The game
// answers this from where the player is looking and which face they clicked,
// and so does `block_orientation.ts`.
//
// Two kinds of check below, and both are needed. The arithmetic ones say the
// rule is the game's rule. The baking ones say the property reaches the
// picture -- a `facing` the mesher ignores would pass every arithmetic check
// ever written and still place the same staircase four times.
console.log("\n--- placement orientation ---");
{
  const looking = (
    x: number,
    y: number,
    z: number,
    against: PlacementLook["against"],
    cursorY = 0,
  ): PlacementLook => ({ direction: { x, y, z }, against, cursorY });

  // North is -Z and east is +X, as Minecraft has it.
  const north = looking(0, 0, -1, "up");
  const east = looking(1, 0, 0, "up");

  equal(
    "a staircase rises away from you",
    orientPlacement("minecraft:oak_stairs", north),
    { facing: "north", half: "bottom" },
  );
  equal(
    "...whichever way you happen to be turned",
    orientPlacement("minecraft:oak_stairs", east).facing,
    "east",
  );
  // A namespace and a state are both things a caller may be holding: the
  // hotbar keeps ids, the block field keeps whatever was typed into it.
  equal(
    "the id may arrive bare, or spelled out, or already stated",
    orientPlacement("oak_stairs[facing=west]", east).facing,
    "east",
  );

  // The half rule. A click on top of something puts the new block on its
  // floor; a click underneath puts it on the ceiling; only a side face has to
  // ask *where* on the face, which is what the game does too.
  equal(
    "placed on a floor, a slab is a bottom slab",
    orientPlacement("minecraft:oak_slab", looking(0, -1, 0, "up")),
    { type: "bottom" },
  );
  equal(
    "placed under a ceiling, it is a top slab",
    orientPlacement("minecraft:oak_slab", looking(0, 1, 0, "down")),
    { type: "top" },
  );
  equal(
    "on the upper half of a side, it is a top slab",
    orientPlacement("minecraft:oak_slab", looking(1, 0, 0, "west", 0.8)),
    { type: "top" },
  );
  equal(
    "on the lower half of the same side, it is not",
    orientPlacement("minecraft:oak_slab", looking(1, 0, 0, "west", 0.2)),
    { type: "bottom" },
  );

  // Pillars take their axis from the face, never from the look direction --
  // laying a log down by clicking the side of a block is the whole gesture.
  equal("a log clicked on top stands up", orientPlacement("minecraft:oak_log", north), {
    axis: "y",
  });
  equal(
    "...and clicked on a north face, lies along Z",
    orientPlacement("minecraft:oak_log", looking(0, 0, -1, "north")),
    { axis: "z" },
  );
  equal(
    "...and on an east face, along X",
    orientPlacement("minecraft:stripped_spruce_wood", looking(0, 0, -1, "east")),
    { axis: "x" },
  );
  equal(
    "a nether stem is a pillar",
    orientPlacement("minecraft:crimson_hyphae", looking(0, 0, -1, "east")),
    { axis: "x" },
  );
  /*
   * The trap the suffix rule falls into if it is written as "_stem":
   * `crimson_stem` is a pillar and `melon_stem` is a crop with an `age`.
   * Writing an axis onto the crop invents a block state that does not exist.
   */
  equal(
    "a melon stem is not, whatever its name ends with",
    orientPlacement("minecraft:melon_stem", looking(0, 0, -1, "east")),
    {},
  );

  // A furnace turns its front to you. It is why a freshly placed dispenser
  // fires at the person who placed it.
  equal("a furnace faces the player", orientPlacement("minecraft:furnace", east).facing, "west");
  equal(
    "...and so does a dropper, up or down included",
    orientPlacement("minecraft:dropper", looking(0, -1, 0, "up")).facing,
    "up",
  );
  // A piston is the other way round: it acts where you are pointing.
  equal(
    "a piston points where you are looking",
    orientPlacement("minecraft:sticky_piston", looking(0, -1, 0, "up")).facing,
    "down",
  );

  equal(
    "a ladder faces out of the wall it was hung on",
    orientPlacement("minecraft:ladder", looking(0, 0, -1, "south")),
    { facing: "south" },
  );
  equal(
    "a button on a wall knows it is on a wall",
    orientPlacement("minecraft:stone_button", looking(0, 0, -1, "south")),
    { face: "wall", facing: "south" },
  );
  equal(
    "...and on the floor takes the direction you were facing",
    orientPlacement("minecraft:stone_button", north),
    { face: "floor", facing: "north" },
  );

  // Silence for anything with nothing to get wrong. An omission costs nothing;
  // a state written onto a block that has no such property is worse than the
  // default, because it looks deliberate.
  equal("a plain block is left alone", orientPlacement("minecraft:stone", north), {});
  equal("...and so is one this file does not claim to know", orientPlacement("minecraft:observer", north), {});

  // Exactly 45 degrees has no right answer; having *an* answer is the point.
  check(
    "a diagonal look still resolves to one direction",
    ["east", "south"].includes(orientPlacement("minecraft:oak_stairs", looking(1, 0, 1, "up")).facing),
  );
}

/*
 * The rest of the state, which is the difference between a block you can edit
 * and one you can only look at.
 *
 * A door placed by hand landed as `oak_door[facing=north]`, and the inspector
 * shows the properties an entry *has* -- so four of the five things that make a
 * door a door were not on screen and could not be changed. They are on the
 * block either way; the only question is whether the builder can see them.
 */
console.log("\n--- the state a placed block starts in ---");
{
  const onFloor = (x: number, z: number): PlacementLook => ({
    direction: { x, y: 0, z },
    against: "up",
    cursorY: 0,
  });

  const door = placementState("minecraft:oak_door", onFloor(0, -1));
  equal("a door carries every property a door has", Object.keys(door).sort(), [
    "facing",
    "half",
    "hinge",
    "open",
    "powered",
  ]);
  equal("...with the direction decided by the camera", door.facing, "north");
  equal("...and the rest at the state the game would place it in", door.half, "lower");

  // The orientation wins where the two overlap: only one of them looked at the
  // camera.
  const chest = placementState("minecraft:chest", onFloor(1, 0));
  equal("a chest still turns its front to you", chest.facing, "west");
  equal("...and knows it is not half of a double one", chest.type, "single");

  const stairs = placementState("minecraft:oak_stairs", onFloor(1, 0));
  equal("stairs gain their shape", stairs.shape, "straight");
  /*
   * And do not gain `waterlogged`, which is the one property that would cost
   * something: the MCEdit writer matches a block's *exact* state against the
   * legacy table, so putting it on every stair and slab turns a clean 1.12 save
   * into a page of degraded blocks.
   */
  check("...but not waterlogged", !("waterlogged" in stairs), Object.keys(stairs).join(", "));

  // A trapdoor has no hinge, and `oak_trapdoor` does not end in `_door` -- but
  // it very nearly does, and a family table matched by suffix is exactly where
  // that stops being true one refactor later.
  const trapdoor = placementState("minecraft:oak_trapdoor", onFloor(0, -1));
  check(
    "a trapdoor is not a door with a longer name",
    !("hinge" in trapdoor),
    Object.keys(trapdoor).join(", "),
  );

  equal("a block with no state to carry gains none", placementState("minecraft:stone", onFloor(0, -1)), {});
}

// The ids this file names have to be ids. A typo writes a state onto a block
// that does not exist, which nothing else in the app would ever notice -- the
// same reason the block-list generator checks itself against the resource pack.
{
  const registry = new Set(parseBlockList(readFileSync("block_id_list.txt", "utf-8")));
  const unknown = ORIENTED_BLOCK_NAMES.filter((name) => !registry.has(`minecraft:${name}`));
  check("every block it claims to orient is a real block", unknown.length === 0, unknown.join(", "));
}

// And the half that says the property reaches the picture. Without it every
// arithmetic check above would still pass against a mesher that drew the same
// staircase four times.
{
  const east = await baker.bakeBlockstate(block("oak_stairs", { facing: "east", half: "bottom" }));
  const west = await baker.bakeBlockstate(block("oak_stairs", { facing: "west", half: "bottom" }));
  const top = await baker.bakeBlockstate(block("oak_stairs", { facing: "east", half: "top" }));
  check(
    "facing turns the staircase",
    JSON.stringify(allVertices(east)) !== JSON.stringify(allVertices(west)),
    "the mesher ignores facing, so orienting one places the same block four times",
  );
  check("half flips it", JSON.stringify(allVertices(east)) !== JSON.stringify(allVertices(top)));

  const upright = await baker.bakeBlockstate(block("oak_log", { axis: "y" }));
  const lying = await baker.bakeBlockstate(block("oak_log", { axis: "x" }));
  const uvsOf = (baked: BakedBlock): string =>
    JSON.stringify(Object.entries(baked.faces).map(([face, f]) => [face, f.textureKey, f.uvs]));
  check(
    "axis turns the log",
    uvsOf(upright) !== uvsOf(lying),
    "the baker ignores axis, so a lying log draws as a standing one",
  );
}

// --- light, and how far it gets -----------------------------------------------
//
// Two grids and a flood fill, all of it the game's own arithmetic. It is in
// main because propagation is a walk over the voxel grid and the renderer has
// no voxels -- it receives geometry.
console.log("\n--- lighting ---");
{
  const size = { x: 9, y: 5, z: 9 };
  const palette: PaletteEntry[] = [
    { namespacedName: "minecraft:air", properties: {} },
    { namespacedName: "minecraft:stone", properties: {} },
    { namespacedName: "minecraft:torch", properties: {} },
    { namespacedName: "minecraft:glass", properties: {} },
  ];
  const voxels = new Int32Array(size.x * size.y * size.z);
  const at = (x: number, y: number, z: number): number => x * size.y * size.z + y * size.z + z;
  const structure = (): StructureData => ({
    palette,
    voxels,
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: size.x - 1, maxY: size.y - 1, maxZ: size.z - 1 },
  });

  // An open box of air: everything sees the sky, nothing glows.
  {
    const light = computeLight(structure());
    equal("open air is fully sky-lit", light.sky[at(4, 0, 4)], MAX_LIGHT);
    equal("...and unlit by blocks", light.block[at(4, 0, 4)], 0);
  }

  // A roof at the top. Underneath it the sky stops -- but only underneath: the
  // sky spreads sideways in from the open edges, one level per step.
  {
    voxels.fill(0);
    for (let x = 2; x <= 6; x += 1) {
      for (let z = 2; z <= 6; z += 1) voxels[at(x, size.y - 1, z)] = 1;
    }
    const light = computeLight(structure());
    check(
      "under the middle of a roof the sky is dimmed",
      light.sky[at(4, size.y - 2, 4)] < MAX_LIGHT,
      String(light.sky[at(4, size.y - 2, 4)]),
    );
    equal("beside the roof it is undimmed", light.sky[at(0, size.y - 2, 0)], MAX_LIGHT);
  }

  /*
   * A torch, and the level it loses per step -- one per *step*, which is
   * Manhattan distance and not a radius. The corner of this grid is twenty
   * steps from the corner the torch is in, which is what makes "and then it
   * runs out" a thing the fixture can actually show.
   */
  {
    voxels.fill(0);
    voxels[at(0, 0, 0)] = 2;
    const light = computeLight(structure());
    equal("a torch is as bright as a torch", light.block[at(0, 0, 0)], 14);
    equal("...one block away it is one dimmer", light.block[at(1, 0, 0)], 13);
    equal("...and three steps away, three", light.block[at(1, 1, 1)], 11);
    equal("...and past fourteen steps, nothing", light.block[at(8, 4, 8)], 0);
  }

  /*
   * Glass is not a wall, and a single stone block is not one either -- light
   * goes round it. So the wall has to be a wall: a whole plane, or the check
   * passes against a version of this that does not block light at all.
   *
   * What is asked is `occludesNeighbours`, which is the same question the
   * mesher asks about culling. A shape that does not cover a face does not
   * stop light through it either, and that is one rule rather than two.
   */
  {
    const wall = (kind: number): void => {
      voxels.fill(0);
      voxels[at(0, 2, 4)] = 2;
      for (let y = 0; y < size.y; y += 1) {
        for (let z = 0; z < size.z; z += 1) voxels[at(4, y, z)] = kind;
      }
    };

    wall(3);
    const throughGlass = computeLight(structure());
    check(
      "light passes through a wall of glass",
      throughGlass.block[at(5, 2, 4)] > 0,
      String(throughGlass.block[at(5, 2, 4)]),
    );

    wall(1);
    const walled = computeLight(structure());
    equal("...and stops at a wall of stone", walled.block[at(5, 2, 4)], 0);
  }

  // A furnace that is not burning is not a light. `placementState` writes
  // `lit=false` on a placed one, so reading the name alone would light a
  // village by its cold furnaces.
  equal(
    "an unlit furnace emits nothing",
    blockEmission({ namespacedName: "minecraft:furnace", properties: { lit: "false" } }),
    0,
  );
  equal(
    "...and a burning one does",
    blockEmission({ namespacedName: "minecraft:furnace", properties: { lit: "true" } }),
    13,
  );
  equal(
    "a block nobody listed emits nothing",
    blockEmission({ namespacedName: "minecraft:stone", properties: {} }),
    0,
  );
}

// --- smooth lighting ----------------------------------------------------------
//
// A vertex takes the average of the four cells that meet at it, which is the
// same four the occlusion reads -- so the two settings cost the same lookups.
// What it buys is the gradient across a floor as a torch's light falls away,
// which is most of what makes a lit room look lit.
console.log("\n--- smooth lighting ---");
{
  const size = { x: 16, y: 4, z: 16 };
  const palette: PaletteEntry[] = [
    { namespacedName: "minecraft:air", properties: {} },
    { namespacedName: "minecraft:stone", properties: {} },
    { namespacedName: "minecraft:glowstone", properties: {} },
  ];
  const voxels = new Int32Array(size.x * size.y * size.z);
  const at = (x: number, y: number, z: number): number => x * size.y * size.z + y * size.z + z;
  // A floor with one glowstone in it: the light falls away across the floor,
  // which is exactly the gradient this is for.
  for (let x = 0; x < size.x; x += 1) {
    for (let z = 0; z < size.z; z += 1) voxels[at(x, 0, z)] = 1;
  }
  voxels[at(2, 0, 2)] = 2;
  const struct: StructureData = {
    palette,
    voxels,
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: size.x - 1, maxY: size.y - 1, maxZ: size.z - 1 },
  };
  const light = computeLight(struct);

  const topFaces = async (smooth: boolean): Promise<number[]> => {
    const faces = await culledFaces(struct, baker, undefined, {
      light,
      occlusion: false,
      smooth,
    });
    // Only the tops, and only their block-light channel.
    return faces
      .filter((face) => face.normal[1] > 0.9 && face.shade !== undefined)
      .flatMap((face) => [face.shade![0], face.shade![3], face.shade![6], face.shade![9]]);
  };

  const flat = await topFaces(false);
  const smooth = await topFaces(true);
  check("there are faces to shade", flat.length > 0);

  // Flat lighting gives one value per face, so its four vertices agree.
  const flatFaceIsUniform = (values: number[]): boolean => {
    for (let i = 0; i < values.length; i += 4) {
      if (new Set(values.slice(i, i + 4)).size !== 1) return false;
    }
    return true;
  };
  check("flat lighting is flat across a face", flatFaceIsUniform(flat));
  check(
    "...and smooth lighting is not",
    !flatFaceIsUniform(smooth),
    "every face still came out uniform",
  );

  // And it is still *light*: the brightest vertex is next to the glowstone and
  // the far corner is dark either way.
  check("the lit end is bright", Math.max(...smooth) > 0.5);
  check("...and the far end is not", Math.min(...smooth) < 0.2);
  // The two settings are separate, and asking for one must not deliver the
  // other: with occlusion off every vertex's third channel is untouched.
  const withoutOcclusion = await culledFaces(struct, baker, undefined, {
    light,
    occlusion: false,
    smooth: true,
  });
  check(
    "occlusion stays out of it when it is off",
    withoutOcclusion
      .filter((face) => face.shade !== undefined)
      .every((face) => [2, 5, 8, 11].every((i) => face.shade![i] === 1)),
  );
}

// --- how buried a corner is ---------------------------------------------------
console.log("\n--- ambient occlusion ---");
{
  equal("an open corner is open", cornerOcclusion(false, false, false), 3);
  equal("one neighbour takes a step", cornerOcclusion(true, false, false), 2);
  equal("the diagonal alone takes one too", cornerOcclusion(false, false, true), 2);
  equal("two sides and a diagonal is nearly buried", cornerOcclusion(true, false, true), 1);
  /*
   * Two solid sides enclose the corner whatever the diagonal does, and that
   * special case is the whole reason this is a named function rather than a
   * subtraction: without it a corner between two walls reads one step lighter
   * than a corner between two walls and a diagonal, which is not what an eye
   * expects of a corner it cannot see into.
   */
  equal("two sides bury it however the diagonal falls", cornerOcclusion(true, true, false), 0);
  equal("...including with it", cornerOcclusion(true, true, true), 0);

  check("every step has a brightness", OCCLUSION_LEVELS.length === 4);
  check("...and the open one is full", OCCLUSION_LEVELS[3] === 1);
  check(
    "...getting darker as it closes",
    OCCLUSION_LEVELS.every((level, i) => i === 0 || level > OCCLUSION_LEVELS[i - 1]),
  );
}

// --- searching the registry from the UI --------------------------------------
//
// The picker is where the user meets all ~920 blocks. It shipped capped at 40
// results, which is not a shortfall anyone can see: a search with 41 answers
// showed 40 and said nothing. These run against the real list rather than a
// fixture, because "does it show everything" is only meaningful at full size.
console.log("\n--- the block picker's search ---");
{
  const registry = [...parseBlockList(readFileSync("block_id_list.txt", "utf-8"))].sort();
  check("the registry is the big one, not a stub", registry.length > 900, `${registry.length}`);

  equal("an empty query offers every block", searchBlocks(registry, "").length, registry.length);

  // The exact case the cap used to clip, and the reason a cap is the wrong
  // shape of answer: the number is just over a round one nobody would question.
  const oak = searchBlocks(registry, "oak");
  equal(
    "every oak block is offered, not the first forty",
    oak.length,
    registry.filter((b) => b.includes("oak")).length,
  );
  check("...which is more than forty", oak.length > 40, `${oak.length}`);

  check(
    "nothing is dropped for any query",
    ["a", "e", "stone", "wood", "minecraft", "_"].every(
      (q) => searchBlocks(registry, q).length === registry.filter((b) => b.includes(q)).length,
    ),
  );

  // Ranking. Alphabetically `minecraft:stone` lands after `blackstone` and the
  // rest of the Bs, so an unranked list puts the obvious answer out of sight.
  equal("an exact id comes first", searchBlocks(registry, "minecraft:stone")[0], "minecraft:stone");
  equal("...and so does a bare name that is exact", searchBlocks(registry, "stone")[0], "minecraft:stone");
  check(
    "a name starting with the query beats one merely containing it",
    searchBlocks(registry, "oak").indexOf("minecraft:oak_planks") <
      searchBlocks(registry, "oak").indexOf("minecraft:dark_oak_planks"),
  );
  check(
    "...even when the containing one sorts earlier alphabetically",
    "minecraft:dark_oak_planks" < "minecraft:oak_planks",
  );

  equal("a query matching nothing offers nothing", searchBlocks(registry, "zzzznope").length, 0);
  equal(
    "case does not matter",
    searchBlocks(registry, "OAK").length,
    searchBlocks(registry, "oak").length,
  );
  equal(
    "surrounding space does not either",
    searchBlocks(registry, "  stone  ")[0],
    "minecraft:stone",
  );
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
