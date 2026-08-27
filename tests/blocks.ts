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

import AdmZip from "adm-zip";

import { parseBlockList } from "../src/main/core.js";
import { searchBlocks } from "../src/renderer/src/lib/block_search.js";
import {
  ORIENTED_BLOCK_NAMES,
  orientPlacement,
  placementState,
  type PlacementLook,
} from "../src/shared/block_orientation.js";
import {
  coversFace,
  occludesFace,
  occludesNeighbours,
  shapeFor,
} from "../src/main/pipeline/block_shapes.js";
import {
  ModelBaker,
  SPECIAL_FACE_RULES,
  type BakedBlock,
} from "../src/main/pipeline/model_baker.js";
import { buildMesh, culledFaces } from "../src/main/pipeline/mesher.js";
import { buildAtlas } from "../src/main/pipeline/atlas.js";
import type { BakedFace, PaletteEntry, StructureData } from "../src/main/pipeline/types.js";
import { paletteEntryCacheKey, paletteEntryIsAir } from "../src/main/pipeline/types.js";
import { connectedState } from "../src/shared/block_connections.js";
import {
  defaultStateFor,
  hasProperty,
  isKnownBlock,
  knownBlockCount,
  legalValuesFor,
  propertiesOf,
} from "../src/shared/block_states.js";
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

// --- the light block --------------------------------------------------------
//
// It used to bake nothing, on the argument that it has no in-game appearance to
// reproduce. That is true and beside the point: neither does a barrier, and a
// build lit by a dozen light blocks looked exactly like a build lit by none.
//
// What it wears is the icon the game puts in your hand, and vanilla ships
// sixteen of those -- one per level, each with its number drawn on it -- so the
// level is legible on every face without this code drawing a glyph.
console.log("\n--- the light block ---");
{
  const baked = await baker.bakeBlockstate(block("light", { level: "15" }));
  check("a light block is drawn", allVertices(baked).length > 0);
  equal("...wearing the level it was set to", baked.textureKey, "minecraft:item/light_15");
  equal(
    "...zero-padded, so 7 is light_07",
    (await baker.bakeBlockstate(block("light", { level: "7" }))).textureKey,
    "minecraft:item/light_07",
  );
  equal(
    "a light block with no level is a full one",
    (await baker.bakeBlockstate(block("light"))).textureKey,
    "minecraft:item/light_15",
  );
  // It must not cull, for the reason the barrier must not: it hides nothing in
  // the game, so deleting the face of the wall behind it would be worse than
  // not drawing it.
  check("light does not occlude its neighbours", !occludesNeighbours(block("light")));
  // Its *geometry* is a full cube -- that is how it gets six faces to write the
  // level on -- so the thing that must be false is the opacity, not the shape.
  check("its geometry is a full cube", coversFace(block("light"), "down"));
  check("...but it hides nothing behind it", !occludesFace(block("light"), "down"));

  // And it still lights the mesh, which is the whole point of the block.
  equal("it emits the level it names", blockEmission(block("light", { level: "9" })), 9);
  equal("...and a full one by default", blockEmission(block("light")), MAX_LIGHT);
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

  /*
   * A bed used to be one `entity/bed/<colour>` sheet unwrapped by hand, and the
   * checks here were about that unwrap: that the legs did not reuse the
   * mattress window, that the head and foot read from different halves.
   *
   * **1.21.9 moved beds onto per-face block textures**, so there is no sheet
   * and no unwrap left to get wrong -- two whole classes of bug deleted rather
   * than fixed. What replaces them is the claim that the halves are still told
   * apart, which is now a question about texture *names*.
   */
  const bedHead = await baker.bakeBlockstate(block("red_bed", { part: "head", facing: "north" }));
  const bedFoot = await baker.bakeBlockstate(block("red_bed", { part: "foot", facing: "north" }));
  const keysOf = (b: BakedBlock) => new Set(b.extraFaces.map((f) => f.textureKey));
  check(
    "a bed's head and foot wear different textures",
    [...keysOf(bedHead)].some((k) => !keysOf(bedFoot).has(k)),
    [...keysOf(bedHead)].join(" "),
  );
  check(
    "the mattress and the legs are told apart",
    keysOf(bedHead).size > 1,
    [...keysOf(bedHead)].join(" "),
  );
  // The underside is the one texture every bed in the game shares, so it
  // carries no colour -- a coloured candidate would miss and fall back.
  check(
    "the underside is the shared bed_down",
    keysOf(bedHead).has("minecraft:block/bed_down"),
    [...keysOf(bedHead)].join(" "),
  );

  /*
   * The chest's lid rests on its body, and the joint has to be a single plane.
   *
   * Two things meet here. The lid's underside and the body's top are coincident
   * and both are omitted -- the body's top window is the chest's dark interior,
   * so drawn it flickers black through the lid. And the two boxes must not
   * *overlap*: vanilla's are 10 and 5 rows tall in a chest 14 tall, so one row
   * is spent twice, and drawn as stated the four side faces are coplanar over
   * it. In the game that z-fight is invisible because both surfaces are the
   * same pixels; here the atlas resamples each window on its own and it came
   * out as a dotted black line across every chest in the build.
   */
  const chestBlock = await baker.bakeBlockstate(block("chest", { facing: "north", type: "single" }));
  const topOf = (f: BakedFace) => Math.max(f.positions[1], f.positions[4], f.positions[7], f.positions[10]);
  const bottomOf = (f: BakedFace) => Math.min(f.positions[1], f.positions[4], f.positions[7], f.positions[10]);
  const upFaces = chestBlock.extraFaces.filter((f) => f.normal[1] === 1 && topOf(f) === 14 / 16);
  equal("a chest draws one face at its top, not two", upFaces.length, 1);
  const downFaces = chestBlock.extraFaces.filter((f) => f.normal[1] === -1 && bottomOf(f) === 0);
  equal("and one at its bottom", downFaces.length, 1);
  equal(
    "nothing is drawn at the joint, from either side",
    chestBlock.extraFaces.filter((f) => f.normal[1] !== 0 && topOf(f) === 9 / 16).length,
    0,
  );
  {
    /*
     * The lid and the body may touch and may not overlap: a side face of one
     * must not share a y with a side face of the other.
     *
     * The lock is left out by its width. It sits on the front and straddles the
     * joint on purpose -- that is what a latch is -- so it overlaps both, and
     * including it would make this check unsatisfiable rather than strict.
     */
    const widthOf = (f: BakedFace) => {
      const xs = [f.positions[0], f.positions[3], f.positions[6], f.positions[9]];
      const zs = [f.positions[2], f.positions[5], f.positions[8], f.positions[11]];
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    };
    const sides = chestBlock.extraFaces.filter((f) => f.normal[1] === 0 && widthOf(f) > 0.5);
    const spans = [...new Set(sides.map((f) => `${bottomOf(f)}:${topOf(f)}`))].map((s) =>
      s.split(":").map(Number),
    );
    const overlaps = spans.some(([a0, a1]) =>
      spans.some(([b0, b1]) => (a0 !== b0 || a1 !== b1) && a0 < b1 && b0 < a1),
    );
    check("the lid and the body do not overlap", !overlaps, JSON.stringify(spans));
  }
  /*
   * And the lock, which was simply not drawn: the sheet has it at (0,0), the
   * notch it leaves is painted into both front strips, and there was nothing
   * standing in it. It is the one part of a chest that is not a plank.
   */
  {
    const proud = chestBlock.extraFaces.filter(
      (f) => f.normal[2] === -1 && Math.min(f.positions[2], f.positions[5]) === 0,
    );
    check("a chest has a lock, standing proud of its front", proud.length === 1);
  }

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
    /*
     * Beds and signs are ordinary block textures as of 1.21.9, and were block
     * entities before it. These two cases are the tripwire for that: the old
     * `entity/bed/<colour>` and `entity/signs/<wood>` rules matched first and
     * kept matching after the pack moved, which sent all sixteen beds and all
     * 44 signs to the hashed-colour cube in one step.
     *
     * The head's *north* face is the joint end, and it is deliberately the
     * uncoloured `bed_head_north`: every bed's joint looks the same, so vanilla
     * ships one texture for all of them.
     */
    [block("red_bed", { part: "head", facing: "north" }), "minecraft:block/bed_head_north"],
    [block("red_bed", { part: "foot", facing: "north" }), "minecraft:block/red_bed_foot_south"],
    // Block entities: the sheets that really are still sheets.
    [block("chest", { facing: "north", type: "single" }), "minecraft:entity/chest/normal"],
    [block("chest", { facing: "north", type: "left" }), "minecraft:entity/chest/normal_left"],
    [block("chest", { facing: "north", type: "right" }), "minecraft:entity/chest/normal_right"],
    [block("trapped_chest", { type: "single" }), "minecraft:entity/chest/trapped"],
    [block("oak_wall_sign", { facing: "north" }), "minecraft:block/oak_sign"],
    [block("oak_hanging_sign", {}), "minecraft:block/oak_hanging_sign"],
    // The lit face is a different texture, and nothing used to ask for it: a
    // furnace wore `furnace_side` on all four sides, fire included.
    [block("furnace", { facing: "north", lit: "false" }), "minecraft:block/furnace_front"],
    [block("furnace", { facing: "north", lit: "true" }), "minecraft:block/furnace_front_on"],
    // The rename the pack forced: `chain` is `iron_chain` from 1.21.9, and the
    // app still offers both spellings.
    [block("chain", {}), "minecraft:block/iron_chain"],
    [block("iron_chain", {}), "minecraft:block/iron_chain"],
    // No usable sheet: a banner is a base plus pattern layers this code cannot
    // compose, so the dyed wool is the deliberate stand-in.
    [block("red_wall_banner", { facing: "north" }), "minecraft:block/red_wool"],
  ];
  for (const [entry, expected] of expectations) {
    const baked = await baker.bakeBlockstate(entry);
    equal(`${entry.namespacedName.replace("minecraft:", "")} -> ${expected}`, baked.textureKey, expected);
  }
}

// --- every block the app offers can be drawn --------------------------------
//
// The failure this catches is silent by construction. When no candidate texture
// name resolves, `bakeFallback` falls through to `hashedColorCube`, which
// colours a cube by hashing the block's name: no error, no log, and a plausible
// solid block in an arbitrary colour. `minecraft:water[level=0]` hashed to a
// vivid green and read as a strange-looking pond rather than as a defect.
//
// A hashed cube is exactly detectable and needs no new state. Its `textureKey`
// is `paletteEntryCacheKey(entry)` -- `minecraft:name[props]`, which carries no
// slash -- while `normalizeTextureKey` always yields
// `namespace:block|item|entity/...`. The two cannot collide.
//
// When this check was written, 140 of the 920 ids failed it, and every one of
// their correct textures was already in the shipped pack: not a single asset was
// missing, they were all naming rules. So this is not a coverage aspiration. It
// is a list that must stay empty.
console.log("\n--- every offered block resolves a texture ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack to resolve against");
} else {
  const listPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "block_id_list.txt",
  );
  const ids = [...parseBlockList(readFileSync(listPath, "utf8"))];
  const unresolved: string[] = [];
  const offTile: string[] = [];
  for (const id of ids) {
    const entry: PaletteEntry = { namespacedName: id, properties: {} };
    // Air is every empty cell in the document and is never drawn; it has no
    // texture by definition, so it would fail this on a technicality.
    if (paletteEntryIsAir(entry)) continue;
    const baked = await baker.bakeBlockstate(entry);
    if (baked.textureKey === paletteEntryCacheKey(entry)) {
      unresolved.push(id.replace("minecraft:", ""));
    }
    const all: BakedFace[] = [...Object.values(baked.faces), ...baked.extraFaces];
    if (all.some((f) => [...f.uvs].some((n) => n < -1e-6 || n > 1 + 1e-6))) {
      offTile.push(id.replace("minecraft:", ""));
    }
  }
  check(
    `all ${ids.length} offered ids resolve a real texture`,
    unresolved.length === 0,
    unresolved.length === 0
      ? undefined
      : `${unresolved.length} fall back to the hashed-colour cube: ${unresolved.join(" ")}`,
  );
  /*
   * ...and every one of them samples inside its own tile.
   *
   * Derived UVs cannot fail this: they come from box coordinates, which are
   * already 0..16. An explicit window can, and does so silently -- the atlas
   * clamps, so the face draws the tile's edge pixels smeared across it, which
   * reads as a badly drawn texture rather than as a window that missed.
   *
   * The way it happens is arithmetic, not typing. `unwrapCube` states its
   * windows in the *sheet's* texels and had the sheet's width baked in at 64;
   * handed a 32-wide sign sheet it produced windows that named the right place
   * and covered a quarter of it, and handed the same sheet with a 16-wide part
   * on it, windows that ran off the end.
   */
  check(
    "...and none of them samples outside its own tile",
    offTile.length === 0,
    offTile.length === 0 ? undefined : `${offTile.length} run off the tile: ${offTile.join(" ")}`,
  );
}

// --- the atlas keeps each texture's own resolution ---------------------------
//
// `buildAtlas` used to resize everything to one square, which is right exactly
// while every texture is the same size. Ordinary block textures in the bundled
// pack are 64x64 and passed through untouched; a **chest sheet is 256x256**,
// because a block-entity sheet carries a whole model's parts rather than one
// face. Those were subsampled 4:1 on the way in.
//
// And nearest subsampling of a 4x sheet is not the 16x texture the pack was
// made from — it keeps one pixel in sixteen of art drawn at 4x. A chest's plank
// lines and the border round its lid landed or missed by a pixel, so chests
// came out both chunkier and patchier than the blocks beside them. Stated in
// atlas pixels, because that is the thing that was being thrown away.
console.log("\n--- the atlas keeps each texture's own resolution ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  await baker.bakeBlockstate(block("chest", { facing: "north" }));
  await baker.bakeBlockstate(block("oak_planks"));
  const atlas = buildAtlas(baker.textures);
  // The rect is inset half a pixel at each edge, so it spans size - 1 pixels.
  const spanOf = (key: string): number | null => {
    const rect = atlas.uvRects[key];
    return rect === undefined ? null : Math.round((rect[2] - rect[0]) * atlas.image.width);
  };
  equal(
    "a 256px chest sheet gets 256 pixels of atlas",
    spanOf("minecraft:entity/chest/normal"),
    255,
  );
  equal("...and a 64px block texture still gets 64", spanOf("minecraft:block/oak_planks"), 63);
  /*
   * ...and the layout is a function of the set, not of the order the baker
   * happened to decode them in.
   *
   * Fed the **same textures in a different order**, deliberately: building
   * twice from the same object proves nothing, because `Object.keys` and
   * `Array.sort` are both stable and would agree with a packer that had no
   * ordering rule at all. `services/block_icons.ts` meshes every block against
   * one atlas and requires two runs to produce identical UVs, and what would
   * break that is one more texture having been decoded first.
   */
  const reversed: Record<string, (typeof baker.textures)[string]> = {};
  for (const key of Object.keys(baker.textures).reverse()) reversed[key] = baker.textures[key];
  const again = buildAtlas(reversed);
  equal(
    "the same set in another order packs to the same atlas",
    [again.image.width, again.image.height],
    [atlas.image.width, atlas.image.height],
  );
  const moved = Object.keys(atlas.uvRects).filter(
    (k) => JSON.stringify(again.uvRects[k]) !== JSON.stringify(atlas.uvRects[k]),
  );
  equal("...and every key lands in the same place", moved, []);
}

// --- every texture name a rule can produce exists ---------------------------
//
// The check above catches a block with *no* texture at all. This one catches
// the narrower slip it cannot see: a rule that names a texture the pack does
// not ship, on a block whose other faces resolve anyway. `faceCandidates`
// returns a `SPECIAL_FACE_RULES` row and stops, so a typo in the `top` entry
// leaves that face silently wearing the side texture, and the block still bakes
// and still looks like a block.
//
// Read straight out of the zip rather than through the baker, because the thing
// under test is the *name*, not whether some earlier bake happened to cache it.
console.log("\n--- every texture a rule names is in the pack ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const shipped = new Set(
    new AdmZip(pack)
      .getEntries()
      .map((e) => e.entryName)
      .filter((n) => n.endsWith(".png"))
      .map((n) => n.replace(/^assets\/minecraft\/textures\//, "").replace(/\.png$/, "")),
  );
  /** `normalizeTextureKey`'s rule, without reaching into the class. */
  const inPack = (name: string): boolean => {
    const bare = name.replace(/^#/, "").replace(/^minecraft:/, "");
    const withDir =
      bare.startsWith("block/") || bare.startsWith("item/") || bare.startsWith("entity/")
        ? bare
        : `block/${bare}`;
    return shipped.has(withDir);
  };

  // A rule is a *candidate list*, not a name, so the invariant is that each
  // face it names resolves **something** -- not that every spelling exists.
  // `grass_path` is the case that settles it: `["dirt_path_top",
  // "grass_path_top"]` is one row covering the 1.17 rename, and the older name
  // is legitimately absent from a modern pack. Requiring every candidate would
  // fail that row and teach whoever hit it to delete the legacy spelling, which
  // is the opposite of what it is for. A single-candidate row with a typo in it
  // still fails, which is the case this exists to catch.
  const missing: string[] = [];
  for (const [name, rule] of Object.entries(SPECIAL_FACE_RULES)) {
    for (const [face, candidates] of Object.entries(rule) as Array<
      [string, readonly string[] | undefined]
    >) {
      if (candidates === undefined || candidates.length === 0) continue;
      if (!candidates.some(inPack)) missing.push(`${name}.${face} -> ${candidates.join("|")}`);
    }
  }
  check(
    `every SPECIAL_FACE_RULES face resolves (${Object.keys(SPECIAL_FACE_RULES).length} rules)`,
    missing.length === 0,
    missing.join(", "),
  );

  // `ShapeBox.texture` overrides a box's texture -- a beacon's glass shell is
  // the reason the field exists. `resolveBoxTexture` falls back to the block's
  // own texture when the override misses, so a typo here does not break the
  // render, it just quietly stops doing what it was added to do.
  const listPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "block_id_list.txt",
  );
  const overrides = new Set<string>();
  for (const id of parseBlockList(readFileSync(listPath, "utf8"))) {
    const shape = shapeFor({ namespacedName: id, properties: {} });
    if (shape.kind !== "boxes") continue;
    for (const entry of shape.boxes) {
      if (entry.texture !== undefined) overrides.add(entry.texture);
    }
  }
  const missingOverrides = [...overrides].filter((name) => !inPack(name));
  check(
    `every box texture override is shipped (${overrides.size} checked)`,
    missingOverrides.length === 0,
    missingOverrides.join(", "),
  );
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

// --- planes -----------------------------------------------------------------
//
// Vanilla writes a *plane* as an element whose `from` and `to` agree on one
// axis. Four of its six faces then have no area, and emitting them is eight
// degenerate triangles z-fighting along the edge they share with the two real
// ones. `boxFaces` decides that from the box rather than from a hand-written
// `omit`, so a plane added later cannot arrive missing its entry.
console.log("\n--- planes ---");
{
  // Two crossed planes, two drawn faces each. As a solid post it was 6, and
  // wearing a sheet texture it sampled pixels meant for the other link.
  const chain = await baker.bakeBlockstate(block("chain"));
  equal("a chain is four faces, not a box", chain.extraFaces.length, 4);
  check("a chain is not a full cube", chain.isFullCube !== true);

  const verts = allVertices(chain);
  check(
    "and it spans its full height",
    Math.min(...verts.map((v) => v[1])) === 0 && Math.max(...verts.map((v) => v[1])) === 1,
  );
  /*
   * The signature of the tilt is that the plane gains depth it did not have.
   * Untilted, the first plane sits at z = 8/16 exactly, so its z extent is
   * zero; a 45 degree turn about Y trades width for depth and leaves the two
   * equal.
   *
   * Not "it reaches further across x" -- rotating a thin plane about its own
   * centre makes its x extent *smaller*, 3/16 * cos45 rather than 3/16, and a
   * check written the other way round fails on correct geometry. Worth leaving
   * as a comment because it is the obvious wrong guess.
   */
  const span = (i: number): number =>
    Math.max(...verts.map((v) => v[i])) - Math.min(...verts.map((v) => v[i]));
  check("the planes are tilted, not axis-aligned", span(2) > 1e-6);
  check("...by 45 degrees, so width and depth come out equal", Math.abs(span(0) - span(2)) < 1e-6);
  check("...trading width for depth", Math.abs(span(0) - (3 / 16) * Math.SQRT1_2) < 1e-6);

  // A sideways chain lies along its axis instead of standing up. Only the
  // geometry follows `axis`; the texture still runs across the plane, which is
  // written down in block_shapes.ts rather than left to be discovered.
  const sideways = await baker.bakeBlockstate(block("chain", { axis: "x" }));
  const sx = allVertices(sideways).map((v) => v[0]);
  equal("a chain on the x axis spans x", [Math.min(...sx), Math.max(...sx)], [0, 1]);
  const sy = allVertices(sideways).map((v) => v[1]);
  check("...and no longer spans y", Math.max(...sy) - Math.min(...sy) < 1);
}

// --- what is scattered on the floor -----------------------------------------
//
// Pink petals, wildflowers and leaf litter were one 16x16 plate at y=0, whatever
// the count. That is wrong twice: `flower_amount` did nothing, so one petal
// carpeted the cell; and a plate that spans the square *at* y=0 covers the face
// below it, so the grass underneath lost its top face and the gaps in the
// petals became a hole through the floor.
console.log("\n--- what is scattered on the floor ---");
{
  const platesOf = (name: string, props: Record<string, string>): number => {
    const shape = shapeFor(block(name, props));
    return shape.kind === "boxes" ? shape.boxes.length : -1;
  };
  equal("one petal is one quarter-plate", platesOf("pink_petals", { flower_amount: "1" }), 1);
  equal("...and four are four", platesOf("pink_petals", { flower_amount: "4" }), 4);
  equal(
    "leaf litter counts segments rather than flowers",
    platesOf("leaf_litter", { segment_amount: "3" }),
    3,
  );
  // The plates sit a little above the floor, at the four heights vanilla gives
  // them, so none of them lies in the plane it would have to cover.
  for (const name of ["pink_petals", "wildflowers", "leaf_litter"]) {
    check(
      `${name} covers nothing below it, at any count`,
      ["1", "2", "3", "4"].every(
        (n) =>
          !coversFace(block(name, { flower_amount: n, segment_amount: n }), "down") &&
          !occludesNeighbours(block(name, { flower_amount: n, segment_amount: n })),
      ),
    );
  }
}

// --- a cutout texture may not hide what is behind it ------------------------
//
// The end-to-end half of the same rule, and the one that would have caught it:
// `occludesFace` answers from `isSeeThrough`, a list of names in a module that
// is geometry and cannot open a PNG. So every block whose *shape* covers a face
// while its *art* does not had to be remembered by hand, and the ones nobody
// remembered deleted the face behind them — a rail on a floor, a lily pad on
// water, petals on grass.
//
// Driven through `culledFaces` rather than the predicate, because the predicate
// is only half of it: what matters is the face that survives.
console.log("\n--- a cutout texture may not hide what is behind it ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  /** The number of upward faces the block at y=0 keeps, with `above` over it. */
  const topFacesUnder = async (above: PaletteEntry): Promise<number> => {
    const palette: PaletteEntry[] = [block("air"), block("grass_block"), above];
    const struct: StructureData = {
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 1, maxZ: 0 },
      palette,
      voxels: new Int32Array([1, 2]),
    };
    const faces = await culledFaces(struct, baker);
    return faces.filter((f) => f.normal[1] === 1 && f.positions[1] === 1).length;
  };
  equal("stone on grass takes the grass's top face", await topFacesUnder(block("stone")), 0);
  equal(
    "pink petals do not",
    await topFacesUnder(block("pink_petals", { flower_amount: "4" })),
    1,
  );
  equal("...nor does a rail", await topFacesUnder(block("rail")), 1);
  equal("...nor a lily pad", await topFacesUnder(block("lily_pad")), 1);
}

// --- leaf litter takes the foliage colour -----------------------------------
//
// It ships **greyscale**, exactly as leaves and grass do, and takes the biome's
// foliage colour at render time. Untinted it came out flat grey, which reads as
// a texture that failed to load rather than one waiting for a colour. Pink
// petals are painted their own colour and must stay untinted, or the check
// below would pass on a rule that tinted everything.
console.log("\n--- leaf litter takes the foliage colour ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const isGrey = (key: string): boolean => {
    const tex = baker.textures[key];
    if (tex === undefined) return true;
    for (let i = 0; i < tex.data.length; i += 4) {
      if (tex.data[i + 3] < 8) continue;
      if (tex.data[i] !== tex.data[i + 1] || tex.data[i + 1] !== tex.data[i + 2]) return false;
    }
    return true;
  };
  const litter = await baker.bakeBlockstate(block("leaf_litter", { segment_amount: "4" }));
  check("leaf litter is not left grey", !isGrey(litter.textureKey), litter.textureKey);
  const petals = await baker.bakeBlockstate(block("pink_petals", { flower_amount: "4" }));
  check("...and pink petals were coloured to begin with", !isGrey(petals.textureKey));
}

// --- water is blended, and cutouts are not ----------------------------------
//
// The block material alpha-tests at 0.5 and does not blend, which is right for
// a cutout and wrong for water: `water_still` is alpha 180 across its whole
// tile, so it passes any alpha test and then draws **solid**. That is the whole
// of "the water block has no transparency".
//
// The fix is a second pass, and a second pass is worth paying for only where it
// is needed — so the three cases have to stay told apart. Blending a cutout
// would cost the sorting for nothing, and blending everything would move the
// block mesh wholesale into three's transparent pass, where it would sort
// against the selection box and the grid.
console.log("\n--- water is blended, and cutouts are not ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  for (const name of ["water", "ice", "nether_portal"]) {
    const baked = await baker.bakeBlockstate(block(name));
    check(`${name} is blended`, baker.isTextureTranslucent(baked.textureKey), baked.textureKey);
  }
  for (const name of ["oak_leaves", "pink_petals", "rail"]) {
    const baked = await baker.bakeBlockstate(block(name));
    check(
      `${name} is a cutout, not a blend`,
      !baker.isTextureOpaque(baked.textureKey) && !baker.isTextureTranslucent(baked.textureKey),
      baked.textureKey,
    );
  }
  const stone = await baker.bakeBlockstate(block("stone"));
  check("stone is neither", baker.isTextureOpaque(stone.textureKey));

  /*
   * ...and the split reaches the geometry, at the end of the index buffer.
   *
   * One number over one set of vertices: the renderer draws `[0, opaqueIndices)`
   * with the alpha-tested material and the tail with the blended one. Ordering
   * matters — a translucent index in the middle would make that number a lie
   * about which faces it names.
   */
  const both: PaletteEntry[] = [block("air"), block("stone"), block("water")];
  const struct: StructureData = {
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 0 },
    palette: both,
    voxels: new Int32Array([1, 2]),
  };
  const faces = await culledFaces(struct, baker);
  const mesh = buildMesh(faces, buildAtlas(baker.textures).uvRects, (key) =>
    baker.isTextureTranslucent(key),
  );
  check("a stone-and-water pair meshes both", mesh.indices.length > 0);
  check(
    "...with some of it blended and some not",
    mesh.opaqueIndices > 0 && mesh.opaqueIndices < mesh.indices.length,
    `${mesh.opaqueIndices} of ${mesh.indices.length}`,
  );
  // Without the predicate every face is opaque, which is what a block icon and
  // the GLB path get, and what every caller written before the split saw.
  const flat = buildMesh(faces, buildAtlas(baker.textures).uvRects);
  equal("...and nothing is blended when nobody asks", flat.opaqueIndices, flat.indices.length);
}

// --- waterlogged is water ---------------------------------------------------
//
// `waterlogged` is how the game puts water in a cell that already holds a fence
// or a slab or a stair. It was read, shown in the inspector and written back to
// the file, and never drawn — so a waterlogged fence in the middle of a pond
// was a fence-shaped hole in the water.
console.log("\n--- waterlogged is water ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const waterFaces = async (palette: PaletteEntry[], voxels: number[], maxX: number) => {
    const struct: StructureData = {
      bounds: { minX: 0, minY: 0, minZ: 0, maxX, maxY: 0, maxZ: 0 },
      palette,
      voxels: new Int32Array(voxels),
    };
    const faces = await culledFaces(struct, baker);
    return faces.filter((f) => f.textureKey.includes("water")).length;
  };
  equal(
    "a dry fence stands in nothing",
    await waterFaces([block("air"), block("oak_fence")], [1], 0),
    0,
  );
  equal(
    "a waterlogged one is under water on all six sides",
    await waterFaces([block("air"), block("oak_fence", { waterlogged: "true" })], [1], 0),
    6,
  );
  /*
   * And it is one body of water, not two blocks of it. Two waterlogged cells
   * side by side do not draw the surface between them, for the same reason an
   * ocean does not mesh its own interior — five faces each, not six.
   */
  equal(
    "two of them share the water between",
    await waterFaces(
      [block("air"), block("oak_fence", { waterlogged: "true" })],
      [1, 1],
      1,
    ),
    10,
  );
  equal(
    "...and a water block counts as the same body",
    await waterFaces(
      [block("air"), block("oak_fence", { waterlogged: "true" }), block("water")],
      [1, 2],
      1,
    ),
    // Five for the fence's water, and the water block's own five.
    10,
  );
}

// --- potted plants ----------------------------------------------------------
//
// Both halves are needed and neither is enough on its own. With no texture rule
// these were hashed-colour cubes; with the texture alone they became a cube
// wearing a poppy, which looks like a decision rather than a gap.
console.log("\n--- potted plants ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const potted = await baker.bakeBlockstate(block("potted_poppy"));
  const keys = new Set([...potted.extraFaces].map((face) => face.textureKey));
  check("the pot is drawn from flower_pot", keys.has("minecraft:block/flower_pot"));
  check("its soil is dirt", keys.has("minecraft:block/dirt"));
  check("and the plant is the plant", keys.has("minecraft:block/poppy"));
  /*
   * The plant fills the block and stops there.
   *
   * It used to run to y = 22/16, on a comment claiming vanilla's does too.
   * Vanilla's is `[2.6, 4, 8] to [13.4, 16, 8]`: it stops at the block's top.
   * Six units of overshoot is not just a stem poking through the floor above —
   * the plane's derived UVs ran to `v = -0.375`, off the tile, where the atlas
   * clamps, so the top third of every potted flower was one row of its own
   * texture smeared upward.
   */
  const ys = allVertices(potted).map((v) => v[1]);
  equal("the plant fills the block and stops at its top", Math.max(...ys), 1);
  equal("...standing in the soil rather than on it", Math.min(...ys), 0);
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

// --- the generated state table ----------------------------------------------
//
// `DEFAULT_STATE` was twenty-one families written by hand, against the two
// hundred-odd blocks that carry properties at all. Everything else was placed
// bare -- one cause with two symptoms: an empty inspector, and the wrong shape
// for anything `block_shapes.ts` reads a property to draw. A fence had no
// `north`, so it drew as a bare post.
console.log("\n--- the generated state table ---");
{
  const registry = [...parseBlockList(readFileSync("block_id_list.txt", "utf-8"))].map((id) =>
    id.replace("minecraft:", ""),
  );
  const unknown = registry.filter((id) => !isKnownBlock(id));
  /*
   * The four are `grass`, `grass_path`, `sign` and `wall_sign`: pre-Flattening
   * spellings the app still offers and the modern game no longer has. Named
   * rather than counted, so a fifth cannot join them quietly -- which is the
   * whole failure mode a rename produces.
   */
  equal("only the pre-Flattening spellings are outside the table", unknown.sort(), [
    "grass",
    "grass_path",
    "sign",
    "wall_sign",
  ]);
  check(`the table describes ${knownBlockCount()} blocks`, knownBlockCount() > 1000);

  // The reason the table exists, stated as a check: the blocks whose *shape* is
  // read out of their properties must arrive carrying them.
  const onFloor: PlacementLook = { direction: { x: 0, y: 0, z: -1 }, against: "up", cursorY: 0 };
  for (const [id, property] of [
    ["minecraft:oak_fence", "north"],
    ["minecraft:cobblestone_wall", "up"],
    ["minecraft:iron_bars", "east"],
    ["minecraft:glass_pane", "west"],
    ["minecraft:snow", "layers"],
    ["minecraft:chain", "axis"],
    ["minecraft:grass_block", "snowy"],
    ["minecraft:redstone_wire", "power"],
  ] as const) {
    const state = placementState(id, onFloor);
    check(
      `${id.replace("minecraft:", "")} is placed carrying ${property}`,
      property in state,
      Object.keys(state).join(", ") || "(nothing)",
    );
  }

  // A wall's connections are `none|low|tall`, not booleans -- the 1.16 change
  // that reads as a value change and is a type change. Code testing
  // `=== "true"` does not fail on a wall, it silently sees no connections.
  equal("a wall's connections are not booleans", defaultStateFor("cobblestone_wall").north, "none");
  equal("a fence's are", defaultStateFor("oak_fence").north, "false");

  // Excluded from the default, kept in the legal values: the inspector should
  // still offer it, and a file that arrives carrying it keeps it.
  check(
    "waterlogged is on no block's default state",
    registry.every((id) => !("waterlogged" in defaultStateFor(id))),
  );
  equal("...but is still offered where it is legal", legalValuesFor("oak_stairs", "waterlogged"), [
    "true",
    "false",
  ]);

  // `null` and `[]` mean different things to the inspector: no knowledge is a
  // free-text field, an empty list would claim the property accepts nothing.
  equal("an unknown property has no value list", legalValuesFor("oak_stairs", "nonsense"), null);
  equal("and neither does an unknown block", legalValuesFor("minecraft:not_a_block", "facing"), null);

  equal("a block with no properties reports none", propertiesOf("stone"), []);
}

// --- nothing is a cube by accident ------------------------------------------
//
// Only a full opaque cube may cull, so a block wrongly left as one does not
// merely have the wrong silhouette -- it deletes a face from each of its six
// neighbours. A line of redstone drawn as a cube deletes the floor it lies on.
//
// Named rather than swept, because "is this block really a cube" is a question
// about Minecraft that no property of the code can answer. The list is the ones
// that were wrong; a sweep would need the answer it is trying to check.
console.log("\n--- nothing is a cube by accident ---");
{
  const notCubes = [
    "redstone_wire",
    "skeleton_skull",
    "skeleton_wall_skull",
    "decorated_pot",
    "sniffer_egg",
    "pointed_dripstone",
    "sign",
    "wall_sign",
    "fire",
    "soul_fire",
    "end_portal",
    "end_gateway",
    "piston_head",
    "cocoa",
    "torchflower_crop",
    "chain",
    "potted_poppy",
    "white_carpet",
    "oak_hanging_sign",
  ];
  const wrong = notCubes.filter((name) =>
    occludesNeighbours({ namespacedName: `minecraft:${name}`, properties: {} }),
  );
  check("none of these culls its neighbours", wrong.length === 0, wrong.join(", "));

  /*
   * The families the registry brought in. `_bars` and `_lantern` are twenty ids
   * between them -- the copper golem update added both in four oxidation stages
   * and their waxed mirrors -- and every one arrived as a full opaque cube.
   */
  const families = [
    "copper_bars",
    "waxed_oxidized_copper_bars",
    "copper_lantern",
    "waxed_exposed_copper_lantern",
    "candle_cake",
    "dragon_egg",
    "turtle_egg",
    "chorus_flower",
    "big_dripleaf",
    "small_dripleaf",
    "crimson_fungus",
    "mangrove_propagule",
    "melon_stem",
    "attached_pumpkin_stem",
  ];
  const solid = families.filter((name) =>
    occludesNeighbours({ namespacedName: `minecraft:${name}`, properties: {} }),
  );
  check("nor do the families the registry brought in", solid.length === 0, solid.join(", "));

  /*
   * And the other half of the same rule: the blocks that really are cubes must
   * stay cubes, or a wall of them stops hiding its own interior.
   *
   * The last five are the trap. `sea_lantern` and `jack_o_lantern` end in the
   * same six letters as a lantern and are nothing to do with one; `crimson_stem`
   * is a *log*, which is why `_stem` is not a suffix rule anywhere in this
   * codebase; `mushroom_stem` is a full block. Matching any of them by suffix
   * turns a solid block into a hanging lamp or a sapling.
   */
  const cubes = [
    "stone",
    "oak_wood",
    "magma_block",
    "dried_kelp_block",
    "suspicious_sand",
    "sea_lantern",
    "jack_o_lantern",
    "crimson_stem",
    "stripped_warped_stem",
    "mushroom_stem",
  ];
  const soft = cubes.filter(
    (name) => !occludesNeighbours({ namespacedName: `minecraft:${name}`, properties: {} }),
  );
  check("...and the ones that are cubes still are", soft.length === 0, soft.join(", "));
}

// --- culling is a question about a face, not about a block ------------------
//
// `occludesNeighbours` asks "is this a solid block", which is right for
// lighting and too blunt for culling. Two faults came out of the gap.
console.log("\n--- culling per face ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const air = block("air");
  /** Faces of the block at x=0 that point east, toward its neighbour at x=1. */
  const eastFacesOf = async (here: PaletteEntry, beside: PaletteEntry): Promise<number> => {
    const struct = structureOf(2, 1, 1, [air, here, beside], (x) => (x === 0 ? 1 : 2));
    const faces = await culledFaces(struct, baker);
    return faces.filter((f) => f.normal[0] === 1 && f.positions[0] <= 1.01).length;
  };
  /** Faces of the block at y=0 that point up, toward its neighbour at y=1. */
  const upFacesOf = async (lower: PaletteEntry, upper: PaletteEntry): Promise<number> => {
    const struct = structureOf(1, 2, 1, [air, lower, upper], (_x, y) => (y === 0 ? 1 : 2));
    const faces = await culledFaces(struct, baker);
    return faces.filter((f) => f.normal[1] === 1 && f.positions[1] <= 1.01).length;
  };
  const slab = (type: string) => block("oak_slab", { type });

  /*
   * A hole across the middle of a double slab's face.
   *
   * `namespacedName` carries no block state, so the identical-neighbour rule --
   * the one that keeps an ocean from meshing its own interior -- read a double
   * slab and a single slab of the same wood as the same block and culled the
   * face between them. A single slab covers half of that face, so the other
   * half of the double slab was simply missing.
   *
   * Side by side, which is the arrangement that shows it: stacked, a bottom
   * slab really does cover the whole top of the block beneath it, so there is
   * nothing to lose.
   */
  equal("a double slab keeps the side a half slab only half covers", await eastFacesOf(slab("double"), slab("bottom")), 1);
  equal("...and the side facing air", await eastFacesOf(slab("double"), air), 1);
  // The rule still has to do its job where the blocks really are identical.
  equal("...but not beside another double slab", await eastFacesOf(slab("double"), slab("double")), 0);
  equal("nor does glass mesh its own interior", await eastFacesOf(block("glass"), block("glass")), 0);

  /*
   * The other half of the same gap: a slab *does* cover the cell below it, and
   * a shelf covers the wall it hangs on. Without that the shelf's back panel
   * and the wall's face are coplanar, which is the z-fighting that was reported
   * as the shelf passing through its neighbour.
   */
  equal("a stone top is hidden by the slab resting on it", await upFacesOf(block("stone"), slab("bottom")), 0);
  equal("...and not by a top slab, which does not touch it", await upFacesOf(block("stone"), slab("top")), 1);
  equal(
    "a wall loses the face a shelf hangs on",
    await eastFacesOf(block("stone"), block("oak_shelf", { facing: "east" })),
    0,
  );
  equal(
    "...and keeps it when the shelf faces away",
    await eastFacesOf(block("stone"), block("oak_shelf", { facing: "west" })),
    1,
  );

  for (const [face, facing] of [
    ["south", "north"],
    ["north", "south"],
    ["east", "west"],
    ["west", "east"],
  ] as const) {
    check(
      `a ${facing}-facing shelf covers its ${face} side`,
      coversFace(block("oak_shelf", { facing }), face),
    );
    check(
      `...and not the ${facing} one it opens onto`,
      !coversFace(block("oak_shelf", { facing }), facing),
    );
  }

  // A cross has no side to cover, and a rotated box is refused outright: a
  // tilted plane can pass through a face without covering it.
  check("a cross covers nothing", !coversFace(block("dandelion"), "down"));
  check("nor does a chain, whose planes are tilted", !coversFace(block("chain"), "down"));
}

// --- the blocks that were reported wrong ------------------------------------
//
// One check per fault, named after what was on screen. Every one of these was a
// block somebody looked at and could tell was wrong; the shapes are transcribed
// from the vanilla models, and the tripwires above already guarantee the
// textures exist.
console.log("\n--- the blocks that were reported wrong ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const shapeOf = (name: string, props: Record<string, string> = {}) =>
    shapeFor({ namespacedName: `minecraft:${name}`, properties: props });
  const boxCount = (name: string, props: Record<string, string> = {}): number => {
    const shape = shapeOf(name, props);
    return shape.kind === "boxes" ? shape.boxes.length : -1;
  };
  const bakedKey = async (name: string, props: Record<string, string> = {}) =>
    (await baker.bakeBlockstate({ namespacedName: `minecraft:${name}`, properties: props }))
      .textureKey;

  // 1. A chest faced backwards: the sheet's front window landed on the model's
  // back. Two independent facts pin the rotation -- the body's `south` window
  // is the only one that differs from the other three, and the double sheets'
  // seams line up with getConnectedDirection only this way round.
  const single = allVertices(await baker.bakeBlockstate(block("chest", { facing: "north" })));
  const xs = single.map((v) => v[0]);
  equal("a single chest is inset on both sides", [Math.min(...xs), Math.max(...xs)], [1 / 16, 15 / 16]);
  const left = allVertices(
    await baker.bakeBlockstate(block("chest", { facing: "north", type: "left" })),
  ).map((v) => v[0]);
  // A double half reaches the cell edge on the side its partner is on, so the
  // two meet with no seam. `left` is joined clockwise of its facing.
  equal("a left half reaches its partner", [Math.min(...left), Math.max(...left)], [1 / 16, 1]);
  const right = allVertices(
    await baker.bakeBlockstate(block("chest", { facing: "north", type: "right" })),
  ).map((v) => v[0]);
  equal("...and the right half reaches back", [Math.min(...right), Math.max(...right)], [0, 15 / 16]);

  /*
   * The sheet windows, read back in the sheet's own 64-unit space.
   *
   * A double half is unwrapped **15 wide** where a single is 14, and the unwrap
   * lays the six faces out end to end -- so one extra column shifts every
   * window after the first. Passing 14 for a `normal_left` sheet put the front
   * one column off and gave each side a stripe of its neighbour, which looks
   * like a texture drawn slightly wrong rather than one read from the wrong
   * place. That is why it outlived the rotation fix.
   *
   * The front is the sheet's `south` window and it must land on the model's
   * *north* face, which is what `facing=north` means.
   */
  const windowOf = (baked: BakedBlock, axis: 0 | 2, sign: number): [number, number] | null => {
    const face = baked.extraFaces.find((f) => f.normal[axis] === sign && f.normal[1] === 0);
    if (!face) return null;
    const us = [face.uvs[0], face.uvs[2], face.uvs[4], face.uvs[6]].map((n) => n * 64);
    return [Math.min(...us), Math.max(...us)];
  };
  const singleChest = await baker.bakeBlockstate(block("chest", { facing: "north", type: "single" }));
  equal("a single chest's front is the sheet's south window", windowOf(singleChest, 2, -1), [42, 56]);
  const leftChest = await baker.bakeBlockstate(block("chest", { facing: "north", type: "left" }));
  equal("a double half's front is fifteen wide", windowOf(leftChest, 2, -1), [43, 58]);
  equal("...and its outer side is where the wider unwrap puts it", windowOf(leftChest, 0, -1), [29, 43]);

  /*
   * The face that meets the partner is not drawn at all. Both halves put one
   * there, at the same world position, both holding the sheet's dark seam --
   * two coincident faces z-fighting over the chest's own interior, which is the
   * black line down the middle of a double chest.
   */
  /*
   * The lock straddles the joint, and that is what says the side strips run
   * bottom-up.
   *
   * A chest's lock plate is a notch in the *bottom* of the lid's front and the
   * *top* of the body's front. Read the sheet's side strips top-down -- the
   * obvious way, and the way this did for two rounds -- and the chest comes out
   * with its lock in two places it cannot be: near the top of the lid and near
   * the bottom of the body. Every plank still lines up, which is why it
   * survived being looked at twice.
   *
   * Checked by sampling the texture where the lock must be against the same
   * column at the far end of each part. A re-inversion swaps which of the two
   * is the notch, so the pair has to disagree in this direction specifically.
   */
  // The lock is on the front too, and stands a unit proud of it; the two
  // wanted here are the parts of the chest itself.
  const frontFaces = singleChest.extraFaces.filter(
    (f) => f.normal[2] === -1 && f.positions[2] === 1 / 16,
  );
  equal("the front is two parts, lid and body", frontFaces.length, 2);
  const sampleFace = (face: BakedFace, fx: number, fy: number): number => {
    const tex = baker.textures[face.textureKey];
    const us = [face.uvs[0], face.uvs[2], face.uvs[4], face.uvs[6]];
    const vs = [face.uvs[1], face.uvs[3], face.uvs[5], face.uvs[7]];
    const u = us[3] + (us[2] - us[3]) * fx;
    const v = vs[3] + (vs[0] - vs[3]) * fy;
    const x = Math.min(tex.width - 1, Math.max(0, Math.floor(u * tex.width)));
    const y = Math.min(tex.height - 1, Math.max(0, Math.floor(v * tex.height)));
    const i = (tex.width * y + x) << 2;
    return tex.data[i] * 0.299 + tex.data[i + 1] * 0.587 + tex.data[i + 2] * 0.114;
  };
  // Sort by height: the lid is the upper of the two.
  const heightOf = (f: BakedFace) => Math.max(f.positions[1], f.positions[4], f.positions[7], f.positions[10]);
  const [lidFace, bodyFace] = [...frontFaces].sort((a, b) => heightOf(b) - heightOf(a));
  // fy runs 0 at the face's top to 1 at its bottom; fx 0.5 is the middle.
  const lidNearJoint = sampleFace(lidFace, 0.5, 0.9);
  const lidFarFromJoint = sampleFace(lidFace, 0.5, 0.1);
  const bodyNearJoint = sampleFace(bodyFace, 0.5, 0.1);
  const bodyFarFromJoint = sampleFace(bodyFace, 0.5, 0.9);
  check(
    "the lid's lock is at its bottom, against the body",
    lidNearJoint < lidFarFromJoint - 8,
    `near ${lidNearJoint.toFixed(0)} vs far ${lidFarFromJoint.toFixed(0)}`,
  );
  check(
    "...and the body's is at its top, against the lid",
    bodyNearJoint < bodyFarFromJoint - 8,
    `near ${bodyNearJoint.toFixed(0)} vs far ${bodyFarFromJoint.toFixed(0)}`,
  );

  equal("a double half draws no face toward its partner", windowOf(leftChest, 0, 1), null);
  const rightChest = await baker.bakeBlockstate(block("chest", { facing: "north", type: "right" }));
  equal("...on the other side for the other half", windowOf(rightChest, 0, -1), null);
  // One face each from the body, the lid and the lock: all three sit against
  // the partner, and all three would z-fight with its own.
  check(
    "so a half has three fewer faces than a single chest",
    leftChest.extraFaces.length === singleChest.extraFaces.length - 3,
    `${leftChest.extraFaces.length} vs ${singleChest.extraFaces.length}`,
  );

  // 2. A furnace wore furnace_side on all four sides, fire included.
  equal("a furnace has a front", await bakedKey("furnace", { facing: "north" }), "minecraft:block/furnace_front");
  equal(
    "...and a lit one is a different texture",
    await bakedKey("furnace", { facing: "north", lit: "true" }),
    "minecraft:block/furnace_front_on",
  );
  equal(
    "the rule is derived, so a smoker has one too",
    await bakedKey("smoker", { facing: "north" }),
    "minecraft:block/smoker_front",
  );

  // 3, 4, 7. Workstations that were solid cubes.
  check("a brewing stand is a rod on a base", boxCount("brewing_stand") === 4);
  check("a grindstone has its legs and pivots back", boxCount("grindstone", { facing: "north" }) === 5);
  for (const name of ["anvil", "chipped_anvil", "damaged_anvil"]) {
    check(`${name} is an anvil, not a cube`, boxCount(name, { facing: "north" }) === 4);
  }

  /*
   * ...and having the right shape is not having the right textures.
   *
   * Both blocks name more than one in their vanilla model and neither can be
   * served by `cubeFaceTextures`, which guesses from the block's *name*. Both
   * failed in the way that guess fails, and both failures were invisible from
   * inside the app because the result is a plausible block in the right shape.
   */
  const facesOf = async (name: string, props: Record<string, string> = {}) => {
    const baked = await baker.bakeBlockstate(block(name, props));
    return baked.extraFaces;
  };

  /*
   * A chipped anvil differs from an anvil in **one face**. There is no
   * `chipped_anvil` texture and no `chipped_anvil_side`, so the guess found
   * `chipped_anvil_top` and answered it for all six: the whole block, base
   * included, wore the picture of its own dented top.
   */
  for (const name of ["anvil", "chipped_anvil", "damaged_anvil"]) {
    const faces = await facesOf(name, { facing: "north" });
    const keys = new Set(faces.map((f) => f.textureKey));
    equal(
      `${name} is body plus one top`,
      [...keys].sort(),
      ["minecraft:block/anvil", `minecraft:block/${name}_top`].sort(),
    );
    // And the top is on the top -- one face, the one at y = 16.
    const wearing = faces.filter((f) => f.textureKey === `minecraft:block/${name}_top`);
    equal(`...and the top is the face the hammer lands on`, wearing.length, 1);
    check(
      "...which is at the anvil's own top",
      wearing[0] !== undefined && Math.max(...[1, 4, 7, 10].map((i) => wearing[0].positions[i])) === 1,
    );
  }
  /*
   * Two anvils that draw identically are two anvils nobody can tell apart, and
   * that is what the guess produced from the other end: `anvil` resolved
   * `anvil_top` for its up faces and `chipped_anvil` resolved
   * `chipped_anvil_top` for everything, so they differed everywhere except
   * where it means something.
   */
  {
    const a = new Set((await facesOf("anvil", { facing: "north" })).map((f) => f.textureKey));
    const b = new Set((await facesOf("chipped_anvil", { facing: "north" })).map((f) => f.textureKey));
    equal("the three anvils share a body", [...a].filter((k) => b.has(k)), ["minecraft:block/anvil"]);
  }

  /*
   * The anvil is also the only block in the app that needs a face `rotation`,
   * and it needs it for a reason a check can state: vanilla gives its foot's
   * west face the window `[0, 2, 4, 14]` — four wide and twelve tall — on a
   * face that is twelve wide and four tall. Applied flat, that window is the
   * right pixels laid across the face sideways.
   *
   * Rotated, the four corners are read in a shifted order, and the signature of
   * that is exactly this: two vertices at the same height no longer share a
   * `v`. Unrotated they always do, whatever the window is, so the check cannot
   * pass by accident.
   */
  {
    const faces = await facesOf("anvil", { facing: "south" });
    const foot = faces.filter((f) => f.normal[0] === -1).sort((a, b) => a.positions[1] - b.positions[1])[0];
    check("the anvil's foot has a west face", foot !== undefined);
    if (foot) {
      const level = [0, 1, 2, 3].filter((i) => foot.positions[i * 3 + 1] === foot.positions[1]);
      const vs = new Set(level.map((i) => foot.uvs[i * 2 + 1]));
      check(
        "...whose window is turned, not stretched across it",
        level.length >= 2 && vs.size > 1,
        `${level.length} vertices level, ${vs.size} distinct v`,
      );
    }
  }

  /*
   * A grindstone's wheel has two textures and wore one. `#round` is the narrow
   * face and `#side` is the disc -- the part anybody would point at to say what
   * the block is -- and the whole wheel was drawn in `#round`'s neighbour,
   * because that is what the block's name resolves to.
   */
  {
    const faces = await facesOf("grindstone", { facing: "north", face: "floor" });
    const keys = new Set(faces.map((f) => f.textureKey));
    for (const wanted of ["grindstone_round", "grindstone_side", "grindstone_pivot", "dark_oak_log"]) {
      check(`a grindstone wears ${wanted}`, keys.has(`minecraft:block/${wanted}`), [...keys].join(" "));
    }
    const disc = faces.filter((f) => f.textureKey === "minecraft:block/grindstone_side");
    equal("the disc is on the wheel's two wide faces", disc.length, 2);
  }
  /*
   * ...and it turns with the block.
   *
   * Checked at every facing rather than at one, because at `north` the model
   * is unrotated: a per-face texture map that failed to turn with its box
   * would be right there and wrong everywhere else, which is the shape of bug
   * that ships. The wheel's axis is across the facing, so the disc's normal is
   * the other horizontal one.
   */
  for (const [facing, discAxis] of [
    ["north", 0],
    ["east", 2],
    ["south", 0],
    ["west", 2],
  ] as const) {
    const faces = await facesOf("grindstone", { facing, face: "floor" });
    const disc = faces.filter((f) => f.textureKey === "minecraft:block/grindstone_side");
    check(
      `a ${facing}-facing grindstone shows its disc across the run`,
      disc.length === 2 && disc.every((f) => Math.abs(f.normal[discAxis]) === 1),
      disc.map((f) => f.normal.join(",")).join(" | "),
    );
  }

  // 5, 6. Blocks the app did not offer at all until the registry generated the
  // list, and the pack was updated to one that has them.
  check("a shelf is a back panel and two lips", boxCount("oak_shelf", { facing: "north" }) === 3);
  equal("...wearing its own texture", await bakedKey("oak_shelf", { facing: "north" }), "minecraft:block/oak_shelf");
  /*
   * `oak_shelf.png` is a *sheet* -- 128x128 where an ordinary block texture is
   * 64x64 -- with the panel, the lips and their ends in separate regions. UVs
   * derived from box coordinates address none of them, so the block came out
   * the right shape wearing pieces of itself from the wrong places: the lantern
   * and chain failure a third time.
   *
   * The check is that the windows are the *model's*, not the box's. A
   * coordinate-derived window spans the face's own extent -- the panel is full
   * width, so its south face would run u 0..16 -- while vanilla puts it at
   * 8..16, the right half of the sheet.
   */
  const shelfBlock = await baker.bakeBlockstate(block("oak_shelf", { facing: "north" }));
  const shelfSouth = shelfBlock.extraFaces.find((f) => f.normal[2] === 1);
  check("its UVs come from the model, not from its boxes", shelfSouth !== undefined);
  if (shelfSouth) {
    const us = [shelfSouth.uvs[0], shelfSouth.uvs[2], shelfSouth.uvs[4], shelfSouth.uvs[6]];
    equal("the panel reads the sheet's right half", [Math.min(...us) * 16, Math.max(...us) * 16], [8, 16]);
  }
  // Vanilla draws no face where one part covers another, and says so per face
  // rather than leaving them to z-fight.
  // Three boxes of six faces, less the one each that another part covers: the
  // panel has no north, and neither lip has a south.
  check(
    "and the covered faces are left out",
    shelfBlock.extraFaces.length === 15,
    `${shelfBlock.extraFaces.length} faces, expected 18 less the three vanilla omits`,
  );
  check("an iron chain is two planes", boxCount("iron_chain") === 2);
  check("...and so is a copper one", boxCount("copper_chain") === 2);
  // The rename: both spellings are offered and both draw the same thing.
  equal("chain and iron_chain draw alike", await bakedKey("chain"), await bakedKey("iron_chain"));

  // 8, 9, 14. Flat and 2D things that were full opaque cubes -- each of them
  // also deleting a face from six neighbours.
  equal("a firefly bush is a cross", shapeOf("firefly_bush").kind, "cross");
  check("pink petals lie on the ground", boxCount("pink_petals") === 1);
  equal("a coral plant is a cross", shapeOf("tube_coral").kind, "cross");
  check("a coral fan lies flat", boxCount("tube_coral_fan") === 1);
  check("a wall fan hangs on the wall", boxCount("tube_coral_wall_fan", { facing: "north" }) === 1);
  // And the block really is a block: `_coral_block` does not end in `_coral`.
  equal("a coral *block* is still a cube", shapeOf("tube_coral_block").kind, "cube");

  // 10. The mature plant wore the seedling's texture.
  equal(
    "a pitcher plant is fully grown",
    await bakedKey("pitcher_plant", { half: "upper" }),
    "minecraft:block/pitcher_crop_top_stage_4",
  );

  // 11. "Only the top with the leaves, no bottom" -- vanilla's azalea is a
  // hollow shell with the bush hanging inside it, and the bush is the part a
  // cube cannot express at all.
  check("an azalea has its bush", boxCount("flowering_azalea") === 7);
  check("...and so does the plain one", boxCount("azalea") === 7);

  // 12. Vines are a sheet per face they cling to, not a shrub in the middle of
  // the cell. With nothing to cling to they keep the cross, which is the state
  // one arrives in before any rule has run.
  check("a vine clings to one wall", boxCount("vine", { north: "true" }) === 1);
  check("...to two", boxCount("vine", { north: "true", up: "true" }) === 2);
  equal("...and falls back to a cross with nothing to hold", shapeOf("vine").kind, "cross");
  equal("cave vines hang as a cross", shapeOf("cave_vines").kind, "cross");

  /*
   * Signs: three kinds, three shapes, where there was one.
   *
   * All of them were a full-height slab flat against one side of the cell --
   * roughly right for a wall sign and plainly wrong for the other two, which
   * were pressed against a wall that is often not there.
   *
   * The two bare pre-Flattening names are the trap: `wall_sign` does not end in
   * `_wall_sign`, so it fell through to the standing shape and stood a board on
   * a post in mid-air.
   */
  check("a standing sign is a board on a post", boxCount("oak_sign", { rotation: "0" }) === 2);
  check("a wall sign is just the board", boxCount("oak_wall_sign", { facing: "north" }) === 1);
  check("a hanging sign hangs from two chains", boxCount("oak_hanging_sign", { attached: "false" }) === 4);
  check(
    "...or straight off the block above when it is attached",
    boxCount("oak_hanging_sign", { attached: "true" }) === 2,
  );
  check("the bare `sign` stands", boxCount("sign") === 2);
  check("...and the bare `wall_sign` does not", boxCount("wall_sign", { facing: "north" }) === 1);

  /*
   * ...and the board has to land on the board.
   *
   * A sign's texture is a *sheet* -- the board, the post and, on a hanging
   * sign, the chain links -- and the shapes took coordinate-derived UVs over
   * the whole of it, so what a face showed was whatever its own coordinates
   * happened to point at. On a hanging sign that put the dark metal of the
   * chains across the middle of the board and gave one of the two chains the
   * plank field: a wooden chain beside a metal one, on the same sign.
   *
   * The check is on the pixels rather than on the numbers, because a window
   * that is off by a column is not worth failing a build over and a window on
   * the wrong *part* always is. The chain art is near-black navy against a
   * plank field that never goes near it.
   */
  const darkestOn = (face: BakedFace): number => {
    const tex = baker.textures[face.textureKey];
    const us = [face.uvs[0], face.uvs[2], face.uvs[4], face.uvs[6]];
    const vs = [face.uvs[1], face.uvs[3], face.uvs[5], face.uvs[7]];
    let darkest = 255;
    for (let i = 0; i <= 8; i += 1) {
      for (let j = 0; j <= 8; j += 1) {
        const u = Math.min(...us) + ((Math.max(...us) - Math.min(...us)) * i) / 8;
        const v = Math.min(...vs) + ((Math.max(...vs) - Math.min(...vs)) * j) / 8;
        const x = Math.min(tex.width - 1, Math.max(0, Math.floor(u * tex.width)));
        const y = Math.min(tex.height - 1, Math.max(0, Math.floor(v * tex.height)));
        const k = (tex.width * y + x) << 2;
        if (tex.data[k + 3] < 8) continue;
        const lum = tex.data[k] * 0.299 + tex.data[k + 1] * 0.587 + tex.data[k + 2] * 0.114;
        darkest = Math.min(darkest, lum);
      }
    }
    return darkest;
  };
  const widestFace = (baked: BakedBlock, axis: 0 | 2, sign: number): BakedFace | undefined => {
    const candidates = baked.extraFaces.filter((f) => f.normal[axis] === sign);
    const spread = (f: BakedFace) => {
      const xs = [0, 3, 6, 9].map((i) => f.positions[i]);
      return Math.max(...xs) - Math.min(...xs);
    };
    return [...candidates].sort((a, b) => spread(b) - spread(a))[0];
  };
  for (const [name, props] of [
    ["oak_sign", { rotation: "0" }],
    ["oak_wall_sign", { facing: "north" }],
    ["oak_hanging_sign", { attached: "false" }],
  ] as const) {
    const baked = await baker.bakeBlockstate(block(name, props));
    const board = widestFace(baked, 2, -1);
    check(`${name} draws a board`, board !== undefined);
    if (board) {
      const darkest = darkestOn(board);
      check(
        `...on the plank field, not across the chains`,
        darkest > 90,
        `darkest sample ${darkest.toFixed(0)}`,
      );
    }
  }
  /*
   * And the hanging sign's board is the one fit the sheet settles outright:
   * `oak_hanging_sign.png` has exactly one 14-wide patch at (2,14) and one
   * 32-wide band at (0,16), which is `unwrapCube(0, 14, 14, 10, 2)` on a
   * 32-wide sheet and nothing else. Stated in sheet texels, because that is
   * where the evidence is.
   */
  {
    const baked = await baker.bakeBlockstate(block("oak_hanging_sign", { attached: "false" }));
    const board = widestFace(baked, 2, -1);
    const texels = (values: number[]) => [Math.min(...values) * 32, Math.max(...values) * 32];
    equal(
      "the hanging board's front is the sheet's north window",
      board === undefined ? null : texels([board.uvs[0], board.uvs[2], board.uvs[4], board.uvs[6]]),
      [2, 16],
    );
    equal(
      "...over the side band, not the caps",
      board === undefined ? null : texels([board.uvs[1], board.uvs[3], board.uvs[5], board.uvs[7]]),
      [16, 26],
    );
  }

  // 15. Beds stopped being block entities in 1.21.9; the geometry survived the
  // move and the unwrap did not.
  check("a bed is a mattress on four legs", boxCount("red_bed", { part: "head" }) === 5);
  equal(
    "the foot's outer end is its own texture",
    await bakedKey("red_bed", { part: "foot", facing: "north" }),
    "minecraft:block/red_bed_foot_south",
  );
}

// --- neighbour-derived state ------------------------------------------------
//
// The rules alone, driven with literals. The pass that finds the cells to ask
// about is main's and lives in tests/session.ts; this is the half that says
// what the answer should be.
console.log("\n--- neighbour-derived state ---");
{
  const solid = (name: string, properties: Record<string, string> = {}) => ({
    name,
    properties,
    solid: true,
  });
  const thin = (name: string, properties: Record<string, string> = {}) => ({
    name,
    properties,
    solid: false,
  });
  const self = (name: string, properties: Record<string, string> = {}) => ({ name, properties });

  // Fences.
  equal(
    "a lone fence connects to nothing",
    connectedState(self("oak_fence"), {}),
    { north: "false", east: "false", south: "false", west: "false" },
  );
  equal(
    "a fence connects to a fence",
    connectedState(self("oak_fence"), { north: thin("spruce_fence") }).north,
    "true",
  );
  equal(
    "...and to a solid block",
    connectedState(self("oak_fence"), { east: solid("stone") }).east,
    "true",
  );
  equal(
    "...but not through a pane",
    connectedState(self("oak_fence"), { west: thin("glass_pane") }).west,
    "false",
  );
  // Two materials that deliberately do not meet.
  equal(
    "a wooden fence does not connect to a nether brick one",
    connectedState(self("oak_fence"), { south: thin("nether_brick_fence") }).south,
    "false",
  );
  equal(
    "...and the nether brick fence agrees",
    connectedState(self("nether_brick_fence"), { south: thin("oak_fence") }).south,
    "false",
  );
  equal(
    "nether brick fences connect to each other",
    connectedState(self("nether_brick_fence"), { south: thin("nether_brick_fence") }).south,
    "true",
  );
  // A gate stands in the line, so it counts across the line and not along it.
  equal(
    "a fence connects through a gate set across it",
    connectedState(self("oak_fence"), { north: thin("oak_fence_gate", { facing: "east" }) }).north,
    "true",
  );
  equal(
    "...and not to one facing the same way it runs",
    connectedState(self("oak_fence"), { north: thin("oak_fence_gate", { facing: "north" }) }).north,
    "false",
  );

  // Walls: none/low/tall, not booleans, and the post.
  const lone = connectedState(self("cobblestone_wall"), {});
  equal("a lone wall is all post", [lone.north, lone.up], ["none", "true"]);
  const run = connectedState(self("cobblestone_wall"), {
    north: thin("cobblestone_wall"),
    south: thin("cobblestone_wall"),
  });
  equal("a straight run connects both ways", [run.north, run.south], ["low", "low"]);
  // The one case vanilla drops the post: exactly two opposite low sides.
  equal("...and drops its post", run.up, "false");
  const corner = connectedState(self("cobblestone_wall"), {
    north: thin("cobblestone_wall"),
    east: thin("cobblestone_wall"),
  });
  equal("a corner keeps its post", corner.up, "true");
  const loaded = connectedState(self("cobblestone_wall"), {
    north: thin("cobblestone_wall"),
    south: thin("cobblestone_wall"),
    up: solid("stone"),
  });
  equal("a wall under a block goes tall", [loaded.north, loaded.up], ["tall", "true"]);

  // Panes and bars.
  equal(
    "iron bars connect to bars",
    connectedState(self("iron_bars"), { east: thin("iron_bars") }).east,
    "true",
  );
  equal(
    "...and to glass panes",
    connectedState(self("iron_bars"), { west: thin("glass_pane") }).west,
    "true",
  );
  equal(
    "a pane connects to a solid block",
    connectedState(self("glass_pane"), { north: solid("stone") }).north,
    "true",
  );

  // Chests: exactly one left and one right, and each knows where the other is.
  const east = connectedState(self("chest", { facing: "north" }), {
    east: thin("chest", { facing: "north" }),
  });
  const west = connectedState(self("chest", { facing: "north" }), {
    west: thin("chest", { facing: "north" }),
  });
  equal("a chest with a partner to its east is the left half", east.type, "left");
  equal("...and the one to its west is the right half", west.type, "right");
  equal(
    "a chest facing the other way is not a partner",
    connectedState(self("chest", { facing: "north" }), { east: thin("chest", { facing: "south" }) })
      .type,
    "single",
  );

  // Rails: flat shapes only, which is the whole visible difference.
  equal("a lone rail lies north-south", connectedState(self("rail"), {}).shape, "north_south");
  equal(
    "a rail with a neighbour east lies east-west",
    connectedState(self("rail"), { east: thin("rail") }).shape,
    "east_west",
  );
  equal(
    "a rail turning a corner curves",
    connectedState(self("rail"), { north: thin("rail"), east: thin("rail") }).shape,
    "north_east",
  );
  // Only the plain rail has curves in its shape at all.
  equal(
    "a powered rail at a corner stays straight",
    connectedState(self("powered_rail"), { north: thin("powered_rail"), east: thin("powered_rail") })
      .shape,
    "north_south",
  );

  // Grass under snow.
  equal(
    "grass under snow is snowy",
    connectedState(self("grass_block"), { up: thin("snow") }).snowy,
    "true",
  );
  equal("...and is not otherwise", connectedState(self("grass_block"), {}).snowy, "false");

  // Nothing is written onto a block that does not carry it. This is the guard
  // that makes a family matched by suffix safe: `hasProperty` refuses before a
  // rule can invent a property the game would reject.
  equal("a block with no connections gains none", connectedState(self("stone"), {
    north: solid("stone"),
  }), {});
  check(
    "and every property a rule writes is one the block has",
    ["oak_fence", "cobblestone_wall", "iron_bars", "chest", "rail", "grass_block", "oak_stairs"]
      .flatMap((name) =>
        Object.keys(
          connectedState(self(name, { facing: "north", half: "bottom" }), {
            north: thin(name),
            east: thin(name),
            up: solid("stone"),
          }),
        ).map((property) => [name, property] as const),
      )
      .every(([name, property]) => hasProperty(name, property)),
  );
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

  /*
   * A furnace that is not burning is not a light, and the two defaults differ:
   * a bare `minecraft:campfire` is burning and a bare `minecraft:furnace` is
   * not. One rule for both would either light a village by its cold furnaces or
   * put out every campfire in it.
   *
   * This is also where pre-1.13 lands. In 1.8.8-1.12.2 a lit block is a
   * different ID:DATA -- furnace 61 against lit furnace 62, redstone lamp 123
   * against 124 -- and `legacy_blocks.json` has already turned that into
   * `lit=true` by the time anything gets here. The property is the right key
   * for both eras and there is nothing legacy left to special-case.
   */
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
    "...and one with nothing said about it is cold, as the game has it",
    blockEmission({ namespacedName: "minecraft:furnace", properties: {} }),
    0,
  );
  equal(
    "a campfire is the other way round: lit unless it says otherwise",
    blockEmission({ namespacedName: "minecraft:campfire", properties: {} }),
    15,
  );
  equal(
    "...and out when it does",
    blockEmission({ namespacedName: "minecraft:campfire", properties: { lit: "false" } }),
    0,
  );

  // What a legacy `.schematic` actually arrives as, through the flattening
  // table: id 124 and id 74 are the *lit* blocks and carry the property.
  equal(
    "a legacy lit redstone lamp glows",
    blockEmission({ namespacedName: "minecraft:redstone_lamp", properties: { lit: "true" } }),
    15,
  );
  equal(
    "...and the unlit one it shares a name with does not",
    blockEmission({ namespacedName: "minecraft:redstone_lamp", properties: { lit: "false" } }),
    0,
  );
  equal(
    "a lit redstone ore glows a little",
    blockEmission({ namespacedName: "minecraft:redstone_ore", properties: { lit: "true" } }),
    9,
  );

  /*
   * The one block whose level is in its state rather than in its name, which
   * is the whole of what it is for.
   */
  equal(
    "a light block emits its level",
    blockEmission({ namespacedName: "minecraft:light", properties: { level: "7" } }),
    7,
  );
  equal(
    "...zero included",
    blockEmission({ namespacedName: "minecraft:light", properties: { level: "0" } }),
    0,
  );
  equal(
    "...and a nonsense level does not become NaN light",
    blockEmission({ namespacedName: "minecraft:light", properties: { level: "banana" } }),
    MAX_LIGHT,
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
