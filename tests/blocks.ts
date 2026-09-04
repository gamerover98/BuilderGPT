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
  FACE_VECTOR,
  horizontalFacing,
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
import {
  isSignBlock,
  plainText,
  readSignText,
  signFacing,
  type SignText,
} from "../src/main/pipeline/sign_text.js";
import { buildAtlas } from "../src/main/pipeline/atlas.js";
import { atlasAnimations } from "../src/main/services/preview.js";
import type { BakedFace, PaletteEntry, StructureData } from "../src/main/pipeline/types.js";
import { paletteEntryCacheKey, paletteEntryIsAir } from "../src/main/pipeline/types.js";
import { connectedState } from "../src/shared/block_connections.js";
import {
  describeProperty,
  documentedProperties,
} from "../src/shared/block_properties.js";
import {
  defaultStateFor,
  hasProperty,
  isKnownBlock,
  knownBlockCount,
  knownBlockNames,
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

/**
 * The normal a face's winding produces, which is the one the GPU decides
 * front from.
 *
 * `buildMesh` emits `[0, 2, 1, 0, 3, 2]`, so the first triangle is
 * `(v0, v2, v1)` and its right-hand normal is `cross(v2 - v0, v1 - v0)`. The
 * `normal` *attribute* beside it is a separate statement about the same quad,
 * and nothing anywhere made the two agree.
 */
function windingNormal(face: BakedFace): [number, number, number] {
  const at = (i: number) => [
    face.positions[i * 3],
    face.positions[i * 3 + 1],
    face.positions[i * 3 + 2],
  ];
  const [a, b, c] = [at(0), at(1), at(2)];
  const e1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const e2 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  return [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
}

/**
 * Whether a face's two normals point the same way.
 *
 * A dot product rather than an equality: a cross-quad's normal is diagonal and
 * `tiltFace` turns a wall torch by 22.5 degrees, so neither is ever an axis
 * vector. What is being refused is a face pointing the *other* way, which is a
 * dot of -1 and cannot be mistaken for rounding.
 */
function windingAgrees(face: BakedFace): boolean {
  const w = windingNormal(face);
  const n = face.normal;
  const lw = Math.hypot(w[0], w[1], w[2]);
  const ln = Math.hypot(n[0], n[1], n[2]);
  if (lw < 1e-9 || ln < 1e-9) return false;
  return (w[0] * n[0] + w[1] * n[1] + w[2] * n[2]) / (lw * ln) > 0.99;
}

const pack = await findBundledResourcePack();
const baker = await ModelBaker.create(null, pack);

/**
 * The texel a point on a face's own plane samples.
 *
 * Reading the picture back out in *world* coordinates is what makes an
 * orientation check legible: "the pillow is over the outer half" is a sentence
 * about the block, where the four uv pairs that produce it are not.
 */
function texelOn(
  face: BakedFace,
  point: readonly [number, number, number],
): { inside: boolean; alpha: number; luminance: number; rgba: string } {
  const at = (i: number, axis: number) => face.positions[i * 3 + axis];
  const edge = (i: number) => [0, 1, 2].map((axis) => at(i, axis) - at(0, axis));
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const across = edge(1);
  const down = edge(3);
  const from = [0, 1, 2].map((axis) => point[axis] - at(0, axis));
  const s = dot(from, across) / dot(across, across);
  const t = dot(from, down) / dot(down, down);
  const u = face.uvs[0] + (face.uvs[2] - face.uvs[0]) * s + (face.uvs[6] - face.uvs[0]) * t;
  const v = face.uvs[1] + (face.uvs[3] - face.uvs[1]) * s + (face.uvs[7] - face.uvs[1]) * t;
  const image = baker.textures[face.textureKey];
  const x = Math.min(image.width - 1, Math.max(0, Math.floor(u * image.width)));
  const y = Math.min(image.height - 1, Math.max(0, Math.floor(v * image.height)));
  const i = (y * image.width + x) * 4;
  const within = (n: number) => n >= -1e-6 && n <= 1 + 1e-6;
  return {
    inside: within(s) && within(t),
    alpha: image.data[i + 3],
    luminance: image.data[i] * 0.3 + image.data[i + 1] * 0.59 + image.data[i + 2] * 0.11,
    rgba: `${image.data[i]},${image.data[i + 1]},${image.data[i + 2]},${image.data[i + 3]}`,
  };
}

/**
 * Whether a face has **any** opaque texel anywhere in the window it samples.
 *
 * The failure this exists for is the one that produced a block nobody could
 * see. `candle.png` is a sheet: its art lives at texels `x 0..1`, and the
 * candle's box sits at `x 7..9`, so UVs derived from the box addressed a
 * corner of the tile with nothing in it. Every face was emitted, textured, and
 * drawn -- entirely transparent. Reported as candles having no model at all.
 *
 * Nothing else could catch it. The block resolves a real texture, so the
 * hashed-cube walk passes; the window is inside the tile, so the off-tile walk
 * passes; the geometry is vanilla's, so every orientation check passes. What
 * is wrong is only *where on the tile* a correct box looked, and that is a
 * question about pixels.
 *
 * Every texel in the rect is read rather than a sample grid: the rects are a
 * few hundred pixels and a sliver of art is exactly what a grid steps over.
 */
function facePaintsSomething(face: BakedFace): boolean {
  const image = baker.textures[face.textureKey];
  if (image === undefined) return true;
  const us = [face.uvs[0], face.uvs[2], face.uvs[4], face.uvs[6]];
  const vs = [face.uvs[1], face.uvs[3], face.uvs[5], face.uvs[7]];
  const span = (values: number[], size: number): [number, number] => {
    const lo = Math.max(0, Math.floor(Math.min(...values) * size));
    const hi = Math.min(size, Math.ceil(Math.max(...values) * size));
    return [lo, Math.max(lo + 1, hi)];
  };
  const [x0, x1] = span(us, image.width);
  const [y0, y1] = span(vs, image.height);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] > 0) return true;
    }
  }
  return false;
}

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

// --- which way round a texture goes -----------------------------------------
//
// The check above is the vertical half of the rule, and it held while the
// horizontal half was wrong on **every face of every block**. The app mirrored
// each one against vanilla's `uvsByFace`, which reads `u = 16 - x` on north,
// `u = x` on south, `u = z` on west, `u = 16 - z` on east, `v = z` on up and
// `v = 16 - z` on down.
//
// A mirror is invisible on nearly everything in the game — a plank, a stone, an
// ore is either symmetric or noise — which is how it survived. Where it showed,
// it showed as a report about something else: a bed whose pillow sat at the
// joint instead of under the headboard, a double chest bordered down its middle
// and open at its outer ends, and every bed leg's side faces landing on the
// transparent part of their own strip.
//
// So the rule is stated here in the terms a texture is *painted* to: seen from
// outside the block, U runs to the viewer's right and V downward. On the top
// and the bottom the viewer's "up" is north and south respectively, which is
// the convention every top texture in the game is drawn to.
console.log("\n--- which way round a texture goes ---");
{
  const outside: Record<string, { right: readonly number[]; up: readonly number[] }> = {
    north: { right: [-1, 0, 0], up: [0, 1, 0] },
    south: { right: [1, 0, 0], up: [0, 1, 0] },
    west: { right: [0, 0, 1], up: [0, 1, 0] },
    east: { right: [0, 0, -1], up: [0, 1, 0] },
    up: { right: [1, 0, 0], up: [0, 0, -1] },
    down: { right: [1, 0, 0], up: [0, 0, 1] },
  };
  const facing = (face: BakedFace) => {
    const [x, y, z] = face.normal;
    if (x !== 0) return x === 1 ? "east" : "west";
    if (y !== 0) return y === 1 ? "up" : "down";
    return z === 1 ? "south" : "north";
  };
  /** Whether one face reads the right way round on both axes. */
  const readsRight = (face: BakedFace): [boolean, boolean] => {
    const axes = outside[facing(face)];
    const along = (dir: readonly number[], i: number) =>
      face.positions[i * 3] * dir[0] +
      face.positions[i * 3 + 1] * dir[1] +
      face.positions[i * 3 + 2] * dir[2];
    const furthest = (dir: readonly number[]) =>
      [0, 1, 2, 3].reduce((best, i) => (along(dir, i) > along(dir, best) ? i : best), 0);
    const us = [0, 1, 2, 3].map((i) => face.uvs[i * 2]);
    const vs = [0, 1, 2, 3].map((i) => face.uvs[i * 2 + 1]);
    return [
      us[furthest(axes.right)] === Math.max(...us),
      vs[furthest(axes.up)] === Math.min(...vs),
    ];
  };

  const cube = await baker.bakeBlockstate(block("stone"));
  for (const name of Object.keys(outside)) {
    const face = cube.faces[name];
    if (face === undefined) {
      check(`a cube has a ${name} face`, false);
      continue;
    }
    const [horizontal, vertical] = readsRight(face);
    check(`${name}: U runs to the viewer's right`, horizontal);
    check(`${name}: ...and V downward from the top`, vertical);
  }

  /*
   * ...and a stated window has to agree with the derived UVs face by face, or
   * a shape that uses both — which most of the hand-transcribed ones do — comes
   * out with some of its boxes mirrored and the rest not. The flower pot is the
   * proof that the rule above is vanilla's own and not merely self-consistent:
   * its windows are transcribed verbatim, and `north: [10, 10, 11, 16]` on a
   * box spanning x 5..6 is only `16 - x`.
   */
  for (const name of ["flower_pot", "torch", "lantern", "brewing_stand", "oak_stairs"]) {
    const baked = await baker.bakeBlockstate(block(name));
    const faces = [...Object.values(baked.faces), ...baked.extraFaces];
    const wrong = faces.filter((face) => readsRight(face).includes(false));
    check(
      `every face of ${name} reads the right way round (${faces.length})`,
      wrong.length === 0,
      `${wrong.length} do not`,
    );
  }
}

// --- a texture with a right way up ------------------------------------------
//
// The rule above is geometry and could be restated wrongly in both places at
// once, so here is the same thing in pixels, on the one block in the game whose
// texture is chiral: `light` wears its own level as a **number**. Mirrored, the
// 7 reads backwards — which is what every block in the app was doing, and what
// no amount of staring at cobblestone would ever have shown.
console.log("\n--- a texture with a right way up ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  // `light_07`'s digit is drawn in the top-left corner of its tile: the bar
  // across the top of the 7 reaches the left edge, and the right edge of that
  // row is empty. Seen from the south, the left of the picture is the west.
  const lit = await baker.bakeBlockstate(block("light", { level: "7" }));
  const south = [...Object.values(lit.faces), ...lit.extraFaces].find((f) => f.normal[2] === 1);
  check("the light block bakes a south face", south !== undefined);
  if (south !== undefined) {
    equal("it is the numbered texture", south.textureKey, "minecraft:item/light_07");
    check("the 7's bar is on the west", texelOn(south, [0.1, 0.98, 1]).alpha > 128);
    check("...and nothing is drawn opposite it", texelOn(south, [0.9, 0.98, 1]).alpha < 128);
  }
}

// --- turning a block turns its picture with it ------------------------------
//
// The four sides get this for free and that is what hid it: a side texture is
// painted "U to the viewer's right", the viewer walks round with the block, and
// `rotateFaceMap` delivers the right name to the right face. The **top and the
// bottom** get nothing — `up` rotates to `up`, so the map is an identity there
// — and their pictures are painted with the model's north at the top, which
// after a quarter-turn is not the world's north.
//
// It was reported as a bed that only looked right facing north: its pillow came
// out at the joint facing south, and at east and west the white/black split ran
// across the mattress instead of along it. `turnFlatFaces` turns the picture and
// `pinFlatWindows` keeps it reading the patch of tile it read before the box
// moved; without the second, an off-centre box like a bed's leg lands a couple
// of texels out.
//
// Stated as the property rather than as four pillow positions, because the
// property is what the two functions are for: the texel under a world point on
// a turned block is the texel under the un-turned point on the un-turned one.
console.log("\n--- turning a block turns its picture with it ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const compass = ["north", "east", "south", "west"];
  // One clockwise quarter-turn about the block's vertical axis, which is
  // `rotateBoxY`'s `(x, z) -> (16 - z, x)` in 0..1 space.
  const turn = (p: [number, number, number]): [number, number, number] => [1 - p[2], p[1], p[0]];
  const unturn = (p: [number, number, number], steps: number) => {
    let out = p;
    for (let i = 0; i < ((4 - (steps % 4)) % 4); i += 1) out = turn(out);
    return out;
  };
  const flatFaces = (baked: BakedBlock) =>
    [...Object.values(baked.faces), ...baked.extraFaces].filter((f) => f.normal[1] !== 0);

  for (const [name, extra] of [
    ["black_bed", { part: "head" }],
    ["black_bed", { part: "foot" }],
    ["anvil", {}],
    ["grindstone", {}],
    ["oak_shelf", {}],
    ["oak_stairs", {}],
  ] as Array<[string, Record<string, string>]>) {
    const base = await baker.bakeBlockstate(block(name, { ...extra, facing: "north" }));
    let compared = 0;
    let differed = 0;
    for (let steps = 1; steps < 4; steps += 1) {
      const turned = await baker.bakeBlockstate(block(name, { ...extra, facing: compass[steps] }));
      for (const face of flatFaces(turned)) {
        const height = face.positions[1];
        for (let x = 1; x < 8; x += 1) {
          for (let z = 1; z < 8; z += 1) {
            const point: [number, number, number] = [x / 8, height, z / 8];
            const got = texelOn(face, point);
            if (!got.inside) continue;
            const before = unturn(point, steps);
            const want = flatFaces(base)
              .filter(
                (f) => f.normal[1] === face.normal[1] && Math.abs(f.positions[1] - height) < 1e-6,
              )
              .map((f) => texelOn(f, before))
              .find((sample) => sample.inside);
            if (want === undefined) continue;
            compared += 1;
            if (want.rgba !== got.rgba) differed += 1;
          }
        }
      }
    }
    check(
      `${name}${extra.part ? ` ${extra.part}` : ""} draws the same picture at every facing (${compared})`,
      compared > 40 && differed === 0,
      `${differed} of ${compared} texels moved`,
    );
  }

  /*
   * ...and the bed said in its own terms, because that is the sentence the
   * report was filed in. Black rather than red: a red bed's mattress and its
   * pillow are both light, and the difference has to be legible in one number.
   */
  const outer: Record<string, [number, number]> = {
    north: [0.5, 0.2],
    south: [0.5, 0.8],
    east: [0.8, 0.5],
    west: [0.2, 0.5],
  };
  for (const [facing, [x, z]] of Object.entries(outer)) {
    const head = await baker.bakeBlockstate(block("black_bed", { part: "head", facing }));
    const top = head.extraFaces.find((f) => f.normal[1] === 1);
    if (top === undefined) {
      check(`a ${facing}-facing bed head has a top`, false);
      continue;
    }
    const joint: [number, number] = [1 - x === 0.5 ? 0.5 : 1 - x, 1 - z === 0.5 ? 0.5 : 1 - z];
    check(
      `a ${facing}-facing head keeps its pillow at the outer end`,
      texelOn(top, [x, top.positions[1], z]).luminance > 200 &&
        texelOn(top, [joint[0], top.positions[1], joint[1]]).luminance < 60,
    );
  }
}
/*
 * There is deliberately nothing here about the chest, and that is worth writing
 * down because it is the block this rule was first checked against.
 *
 * `entity/chest/normal.png` is left-right symmetric on every face it draws: the
 * four side strips are the same planks, the lock notch is centred, and the one
 * asymmetric mark in a strip is the dark line at its last column — the vertical
 * shadow where two faces meet. Every strip carries it at the same end, so
 * whichever way round the strips are read, each of the four corners is drawn
 * exactly once and the picture is identical.
 *
 * A check written on those columns fails when the mapping changes and would
 * therefore look like a good tripwire. It is not: it fails on both arrangements
 * being different rather than on one being wrong, which is a check that bites
 * without being true.
 */

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

/*
 * A lit candle, which is the second block whose level is in its state.
 *
 * It was in no table at all -- not `EMISSION`, not either of the two `lit`
 * sets -- so a lit candle emitted nothing. That is a lacuna on its own, and it
 * is also what would have made the flame this app draws for a lit candle a dark
 * smudge in a sealed room, for the reason a campfire's fire is visible.
 *
 * `3 per candle` is the game's, and it is a *count* rather than a level, which
 * is why this is a predicate and a function instead of thirty-four rows.
 */
console.log("\n--- a lit candle lights the room ---");
{
  for (const [candles, level] of [
    ["1", 3],
    ["2", 6],
    ["3", 9],
    ["4", 12],
  ] as const) {
    equal(
      `${candles} lit candles emit ${level}`,
      blockEmission(block("candle", { candles, lit: "true" })),
      level,
    );
  }
  equal("an unlit candle emits nothing", blockEmission(block("candle", { candles: "4", lit: "false" })), 0);
  /*
   * A candle with no `candles` is one candle -- the registry's own default --
   * and a candle cake carries no such property at all, so it falls out of the
   * same line rather than needing a row of its own.
   */
  equal("a candle with no count is one", blockEmission(block("candle", { lit: "true" })), 3);
  equal("a lit candle cake is one too", blockEmission(block("white_candle_cake", { lit: "true" })), 3);
  equal("...and an unlit one is dark", blockEmission(block("candle_cake", { lit: "false" })), 0);
  // The dyed ones are the same block by another name, and there are sixteen.
  equal("a dyed candle lights the same", blockEmission(block("red_candle", { candles: "2", lit: "true" })), 6);
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
  /*
   * Four quads, not two: two crossed planes, each drawn from both sides.
   *
   * It was two, and read correctly only because the material was double-sided.
   * `cross.json` states each element with a `north` face and a `south` face,
   * which is the same four, and it is the spelling that survives the material
   * becoming single-sided. Stated as opposite pairs rather than as a count,
   * because four quads all facing the same way is also four.
   */
  const flower = await baker.bakeBlockstate(block("peony", { half: "upper" }));
  equal("a flower is two crossed planes drawn from both sides", flower.extraFaces.length, 4);
  const normals = flower.extraFaces.map((f) => f.normal);
  check(
    "...so every one of its quads has its opposite among them",
    normals.every((n) =>
      normals.some(
        (other) =>
          Math.abs(other[0] + n[0]) < 1e-6 &&
          Math.abs(other[1] + n[1]) < 1e-6 &&
          Math.abs(other[2] + n[2]) < 1e-6,
      ),
    ),
  );
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
  /*
   * And the two halves composed, which is what the sign of this bug needs.
   *
   * Above, `orientPlacement` says a wall torch faces the way it was clicked;
   * further up, the baker says a torch's foot is planted in the wall opposite
   * its `facing`. Both were true while every wall torch in the app came out on
   * the wrong side of its cell, because nothing put them together. Place one by
   * clicking a block's face and the foot has to end up *inside that block*.
   */
  const AS_VECTOR: Record<string, readonly [number, number, number]> = {
    east: [1, 0, 0],
    west: [-1, 0, 0],
    south: [0, 0, 1],
    north: [0, 0, -1],
  };
  const AXIS_OF: Record<string, 0 | 2> = { east: 0, west: 0, south: 2, north: 2 };

  for (const clicked of ["north", "south", "east", "west"] as const) {
    const face = AS_VECTOR[clicked];
    // Looking straight at the face that was hit, which is how one is placed:
    // the wall is in front of you and the torch goes onto it.
    const state = orientPlacement("minecraft:wall_torch", {
      direction: { x: -face[0], y: 0, z: -face[2] },
      against: clicked,
      cursorY: 0.5,
    });
    const baked = await baker.bakeBlockstate(block("wall_torch", state));
    const base = allVertices(baked).filter((vertex) => vertex[1] < 0.35);
    // The block that was clicked is on the far side of that face, so the foot
    // has to reach out of the cell in the direction *opposite* the click.
    const axis = AXIS_OF[clicked];
    const coordinates = base.map((vertex) => vertex[axis]);
    const reach = face[axis] > 0 ? Math.min(...coordinates) : Math.max(...coordinates);
    check(
      `a torch placed on a ${clicked} face is footed in the block behind it`,
      face[axis] > 0 ? reach < 0 : reach > 1,
      `facing=${state.facing} reaches ${reach}`,
    );
  }
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
    /*
     * A banner's pole and crossbar are the two parts of it that are not dyed,
     * so the block's own texture is the sheet they are on; the cloth names
     * its own, tinted, per box. Only the *patterns* are still not composed.
     */
    [block("red_wall_banner", { facing: "north" }), "minecraft:entity/banner/banner_base"],
    // A shulker box's sheet is still laid out for an animated lid, so the
    // dyed wool stays the stand-in there.
    [block("red_shulker_box"), "minecraft:block/red_wool"],
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
  const invisible: string[] = [];
  const backwards: string[] = [];
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
    if (all.length > 0 && !all.some(facePaintsSomething)) {
      invisible.push(id.replace("minecraft:", ""));
    }
    if (!all.every(windingAgrees)) {
      backwards.push(id.replace("minecraft:", ""));
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
  /*
   * ...and none of them is drawn out of thin air.
   *
   * A block whose every face samples empty pixels is emitted, textured and
   * invisible -- which is what candles were, and which passes both checks
   * above. `some` rather than `every`: a chest's hidden faces and a plane's
   * back are legitimately blank, and it is a block with **nothing** anywhere
   * that is the defect.
   */
  check(
    "...and none of them draws nothing at all",
    invisible.length === 0,
    invisible.length === 0
      ? undefined
      : `${invisible.length} are invisible: ${invisible.join(" ")}`,
  );
  /*
   * ...and every face agrees with itself about which way it points.
   *
   * This is what makes the block material safe to be `FrontSide`, and it is
   * the only thing that does: single-sided, a face whose winding disagrees
   * with its declared normal is simply not drawn, and no other check in this
   * file can see the difference -- the geometry is in the right place, the
   * texture resolves, the uvs are inside the tile.
   *
   * It was false for 85 of the 1197 when it was written: every `cross` shape,
   * because `crossFaces` declared the opposite of what it wound. Double-sided
   * that was invisible twice over -- the quad was drawn either way, and the
   * shader flips the normal per side, so even the lighting came out right.
   */
  check(
    "...and every face's winding agrees with the normal it declares",
    backwards.length === 0,
    backwards.length === 0
      ? undefined
      : `${backwards.length} are wound backwards: ${backwards.join(" ")}`,
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
  /*
   * A `#rrggbb` suffix is `resolveBoxTexture`'s spelling for "this texture
   * multiplied by this colour", so the file to look for is the half in front
   * of it. The colour is checked too, and separately: a malformed one is not
   * refused anywhere -- `parseHexColor` falls back to the biome green -- so a
   * banner with a typo in its dye would come out the colour of grass with
   * nothing anywhere saying why.
   */
  const badTint = [...overrides].filter((name) => {
    const hex = name.split("#")[1];
    return hex !== undefined && !/^[0-9a-f]{6}$/.test(hex);
  });
  equal("every box tint is a colour parseHexColor accepts", badTint, []);
  const missingOverrides = [...overrides].filter((name) => !inPack(name.split("#")[0]));
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
// --- a rail knows which way it runs -----------------------------------------
//
// `shape` was decoded out of the file, derived from the neighbours, and rotated
// with the schematic -- and read by nobody in the pipeline, so every rail in
// the game drew the same flat plate whichever way the track went. `powered` was
// the same story one property over: four textures shipped in the pack that
// nothing could name.
console.log("\n--- a rail knows which way it runs ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const railFaces = async (name: string, props: Record<string, string>): Promise<BakedFace[]> => {
    const baked = await baker.bakeBlockstate(block(name, props));
    return [...Object.values(baked.faces), ...baked.extraFaces];
  };
  const railTop = async (name: string, props: Record<string, string>): Promise<BakedFace> => {
    const faces = await railFaces(name, props);
    return faces.filter((f) => f.normal[1] > 0)[0];
  };

  /*
   * Two quads, because vanilla writes a rail as a plane and `boxFaces` drops a
   * face with no area. It used to be a box one unit thick: six.
   */
  const flat = await railFaces("rail", { shape: "north_south" });
  equal("a rail is a plane, not a box", flat.length, 2);
  equal("...lying one unit off the floor", Math.round(flat[0].positions[1] * 16), 1);

  /*
   * The picture turns with the track. Both straight shapes draw the same box
   * out of the same texture, so the only thing that can tell them apart is the
   * quarter-turn `turnFlatFaces` puts on the two flat faces.
   */
  const straight = await railTop("rail", { shape: "north_south" });
  const across = await railTop("rail", { shape: "east_west" });
  equal("both straight rails wear the same texture", straight.textureKey, across.textureKey);
  check(
    "...and an east-west one is turned a quarter",
    [...straight.uvs].join() !== [...across.uvs].join(),
    [...across.uvs].join(),
  );

  /*
   * The four curves take `rail_corner`, which is in the pack and was reachable
   * from nothing, and each takes it a different way round.
   */
  const corners = new Map<string, string>();
  for (const shape of ["south_east", "south_west", "north_west", "north_east"]) {
    const face = await railTop("rail", { shape });
    equal(`a ${shape} rail is a corner`, face.textureKey, "minecraft:block/rail_corner");
    corners.set(shape, [...face.uvs].map((n) => n.toFixed(3)).join());
  }
  equal("...and no two corners face the same way", new Set(corners.values()).size, 4);

  /*
   * Only the bare rail curves, which is the game's rule and `railShape`'s in
   * `block_connections.ts` already. A file naming a corner on a powered rail
   * gets the straight plate rather than a texture that does not exist.
   */
  equal(
    "a powered rail cannot curve",
    (await railTop("powered_rail", { shape: "south_east", powered: "false" })).textureKey,
    "minecraft:block/powered_rail",
  );

  /*
   * `powered` chooses the texture, and it has to be chosen here rather than in
   * `SPECIAL_FACE_RULES`: a candidate list cannot see a property, which is the
   * campfire's lesson paid once already.
   */
  for (const name of ["powered_rail", "detector_rail", "activator_rail"]) {
    equal(
      `an unpowered ${name} is dark`,
      (await railTop(name, { shape: "north_south", powered: "false" })).textureKey,
      `minecraft:block/${name}`,
    );
    equal(
      `...and a powered one is lit`,
      (await railTop(name, { shape: "north_south", powered: "true" })).textureKey,
      `minecraft:block/${name}_on`,
    );
  }

  /*
   * A ramp rises towards the side its shape names. The sign of the tilt is the
   * part that is easy to get backwards, and a rail sloping the wrong way still
   * looks exactly like a rail sloping.
   */
  const risesAt = async (shape: string): Promise<string> => {
    const face = await railTop("rail", { shape });
    // The two highest, not the highest: a ramp's top *edge* has two vertices at
    // the same height, and either of them on its own is a corner of the cell.
    const at = [0, 1, 2, 3]
      .map((i) => [face.positions[i * 3], face.positions[i * 3 + 1], face.positions[i * 3 + 2]])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    const x = (at[0][0] + at[1][0]) / 2;
    const z = (at[0][2] + at[1][2]) / 2;
    return Math.abs(z - 0.5) > Math.abs(x - 0.5) ? (z < 0.5 ? "north" : "south") : x < 0.5 ? "west" : "east";
  };
  for (const side of ["north", "south", "east", "west"]) {
    equal(`an ascending_${side} rail is highest at its ${side} edge`, await risesAt(`ascending_${side}`), side);
  }

  /*
   * And the ramp's box reaches from -3.3 to 19.3 along its axis, because
   * vanilla's `rescale: true` has to be written out as coordinates here. Its
   * UVs are stated for that reason, and this is the check that says so: derived
   * ones would run a fifth of the way outside the tile, where the atlas clamps
   * and smears the edge pixel across the whole ramp.
   */
  const ramp = await railFaces("rail", { shape: "ascending_east" });
  const uvs = ramp.flatMap((f) => [...f.uvs]);
  check(
    "a ramp still samples inside its own tile",
    Math.min(...uvs) >= -1e-6 && Math.max(...uvs) <= 1 + 1e-6,
    `${Math.min(...uvs)}..${Math.max(...uvs)}`,
  );
  const ys = ramp.flatMap((f) => [0, 3, 6, 9].map((i) => f.positions[i + 1]));
  check(
    "...and reaches a pixel above its own cell, as vanilla's does",
    Math.max(...ys) > 1 && Math.max(...ys) < 1.1,
    String(Math.max(...ys)),
  );
}

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

// --- textures that move ------------------------------------------------------
//
// The atlas holds frame 0 and always will: 32 frames of water in a square tile
// would either grow the atlas thirty-twofold or leave each frame eleven pixels
// across. So the frames travel beside it and the viewer blits one into the
// atlas texture per tick.
//
// That makes the *position* of each tile a number the payload has to carry, and
// it is derived from the UV rect rather than returned by the packer — one
// source, because two would come to disagree. The check is the one that
// matters: the pixels already in the atlas at that position must be frame 0.
// Off by a row, a column or a tile and they are not.
console.log("\n--- textures that move ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  for (const name of ["water", "lava", "sea_lantern", "prismarine"]) {
    await baker.bakeBlockstate(block(name));
  }
  await baker.bakeBlockstate(block("stone"));
  const atlas = buildAtlas(baker.textures);
  const animations = atlasAnimations(atlas, baker.animations);
  check(`the moving textures are found (${animations.length})`, animations.length >= 4);

  let misplaced = 0;
  for (const animation of animations) {
    const bytes = animation.size * animation.size * 4;
    for (let row = 0; row < animation.size; row += 1) {
      const from = ((animation.y + row) * atlas.image.width + animation.x) * 4;
      for (let i = 0; i < animation.size * 4; i += 1) {
        if (atlas.image.data[from + i] !== animation.frames[row * animation.size * 4 + i]) {
          misplaced += 1;
          break;
        }
      }
    }
    if (bytes * animation.frameCount !== animation.frames.length) misplaced += 1;
  }
  equal("every one names the tile the atlas already drew", misplaced, 0);

  const byKey = (key: string) => baker.animations[key];
  // Straight from each texture's own `.mcmeta`, which is the only reason
  // prismarine shimmers once every fifteen seconds and water ripples ten times
  // a second. A constant here would make them the same block.
  equal("water runs at the mcmeta's two ticks", byKey("minecraft:block/water_still")?.frameTime, 2);
  equal(
    "...and prismarine at its three hundred",
    byKey("minecraft:block/prismarine")?.frameTime,
    300,
  );
  check(
    "an animation has more than one frame by definition",
    animations.every((a) => a.frameCount > 1),
  );
  // A still texture must not become an animation: `stone` is one frame and the
  // strip test is a shape test, so a square texture can never be mistaken for
  // a stack of them.
  equal("a still texture is not animated", byKey("minecraft:block/stone"), undefined);
}

// --- a fluid stands as tall as its level ------------------------------------
//
// `level` was read, shown in the inspector and written back to the file, and
// changed nothing on screen: a stream at level 5 was a solid block of water,
// and the top of every pond was flush with the block above instead of the small
// step down that makes a surface read as a surface.
//
// Vanilla's rule is `(8 - level) / 9` for 0..7 and a full cell for 8 and up,
// which is "falling". Stated as fractions rather than decimals because the
// ninths are the whole point and 0.888… is not something anyone can check.
console.log("\n--- a fluid stands as tall as its level ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  /** The height of the fluid's top surface in the cell at y=0. */
  const surfaceOf = async (palette: PaletteEntry[], voxels: number[], maxY: number) => {
    const struct: StructureData = {
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY, maxZ: 0 },
      palette,
      voxels: new Int32Array(voxels),
    };
    const faces = await culledFaces(struct, baker);
    const up = faces.filter((f) => f.normal[1] === 1);
    // Positions are float32, so 8/9 comes back a few bits off exactly.
    return up.length === 0 ? null : Math.round(up[0].positions[1] * 1e4) / 1e4;
  };
  const water = (level: string) => block("water", { level });
  for (const [level, ninths] of [
    ["0", 8],
    ["1", 7],
    ["4", 4],
    ["7", 1],
  ] as const) {
    equal(
      `water at level ${level} stands ${ninths}/9 tall`,
      await surfaceOf([block("air"), water(level)], [1], 0),
      Math.round((ninths / 9) * 1e4) / 1e4,
    );
  }
  // 8 and above are the falling states, and a falling fluid fills its cell.
  equal("a falling fluid fills the cell", await surfaceOf([block("air"), water("12")], [1], 0), 1);
  equal(
    "lava reads the same property the same way",
    await surfaceOf([block("air"), block("lava", { level: "3" })], [1], 0),
    Math.round((5 / 9) * 1e4) / 1e4,
  );
  /*
   * ...and anything with the same fluid above it is full height whatever its
   * level says. Without that every layer of a pool would stand 8/9 tall with a
   * gap over it, and a deep pond would come out as stripes.
   */
  {
    const struct: StructureData = {
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 1, maxZ: 0 },
      palette: [block("air"), water("0")],
      voxels: new Int32Array([1, 1]),
    };
    const faces = await culledFaces(struct, baker);
    const sides = faces.filter((f) => f.normal[1] === 0 && f.positions[1] < 1);
    const lower = sides.filter((f) => Math.max(...[1, 4, 7, 10].map((i) => f.positions[i])) === 1);
    check(
      "a layer with water above it reaches the cell's ceiling",
      lower.length > 0 && lower.length === sides.length,
      `${lower.length} of ${sides.length}`,
    );
  }
  /*
   * And the UVs come down with them.
   *
   * `boxFaceGeometry` gives a side face `v = 1 - y`, so a top edge left at
   * `v = 0` while its vertices moved would stretch the whole tile over the
   * shorter face instead of cropping it — a full block of water squashed into
   * four ninths, which is the same picture from a distance and wrong up close.
   */
  {
    const struct: StructureData = {
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
      palette: [block("air"), water("4")],
      voxels: new Int32Array([1]),
    };
    const faces = await culledFaces(struct, baker);
    const side = faces.find((f) => f.normal[1] === 0);
    const topV = side === undefined ? null : Math.min(side.uvs[1], side.uvs[3], side.uvs[5], side.uvs[7]);
    equal(
      "a lowered side crops its texture rather than squashing it",
      topV === null ? null : Math.round(topV * 1e4) / 1e4,
      Math.round((5 / 9) * 1e4) / 1e4,
    );
  }
  // And the sides come down with the top, or the block would be a full cube
  // wearing a lowered lid.
  {
    const struct: StructureData = {
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
      palette: [block("air"), water("4")],
      voxels: new Int32Array([1]),
    };
    const faces = await culledFaces(struct, baker);
    const sides = faces.filter((f) => f.normal[1] === 0);
    check(
      "its sides stop where its surface does",
      sides.length === 4 &&
        sides.every(
          (f) =>
            Math.round(Math.max(...[1, 4, 7, 10].map((i) => f.positions[i])) * 1e4) / 1e4 ===
            Math.round((4 / 9) * 1e4) / 1e4,
        ),
    );
  }
}

// --- a bed's two halves meet without fighting -------------------------------
//
// The two share one geometry here where vanilla has two models, so the foot was
// turned 180 degrees to get its outer end to the far side. But the textures are
// named in the *unrotated* bed's own terms — `red_bed_foot_east` is the east
// side of a bed lying head-to-north, whichever way it is turned — and
// `bedCandidates` undoes `facing` and nothing else. The geometry was half a turn
// ahead of the lookup: the foot's sides came out mirrored and its ends swapped.
// --- a cauldron with something in it ----------------------------------------
//
// It was a solid 16x16x16 box wearing the pot's own textures, so there was no
// inside for anything to be in: `level` was not merely unread, a liquid drawn
// against it would have been sealed inside a block of iron. Transcribed from
// `template_cauldron_full` and its two shorter siblings (1.21.4).
console.log("\n--- a cauldron with something in it ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const potFaces = async (name: string, props: Record<string, string> = {}): Promise<BakedFace[]> => {
    const baked = await baker.bakeBlockstate(block(name, props));
    return [...Object.values(baked.faces), ...baked.extraFaces];
  };
  /** The surface of whatever is in it: the one upward face that is not the pot. */
  const liquid = async (
    name: string,
    props: Record<string, string> = {},
  ): Promise<{ at: number; texture: string } | null> => {
    const faces = await potFaces(name, props);
    const up = faces.filter(
      (f) => f.normal[1] > 0.9 && !f.textureKey.includes("cauldron_"),
    );
    if (up.length === 0) return null;
    return {
      at: Math.round(up[0].positions[1] * 16),
      texture: up[0].textureKey.replace("minecraft:block/", ""),
    };
  };

  /*
   * The pot is hollow, and the proof is a face that a solid box cannot have:
   * `cauldron_inner` looking *up* from the floor of the bowl. That texture ships
   * in the pack and nothing in this app could name it.
   */
  const empty = await potFaces("cauldron");
  check(
    "a cauldron has a bowl with a floor in it",
    empty.some(
      (f) => f.normal[1] > 0.9 && f.textureKey === "minecraft:block/cauldron_inner" &&
        Math.round(f.positions[1] * 16) === 4,
    ),
    [...new Set(empty.map((f) => f.textureKey))].join(" "),
  );
  check("...and it is not a cube any more", empty.length > 6, String(empty.length));

  /*
   * And it stopped hiding what it stands on. A full box covered all six faces,
   * so a cauldron deleted the top of the block under it -- through the gap
   * between its own feet, where the game shows you the floor.
   */
  check("a cauldron no longer covers the floor under it", !coversFace(block("cauldron"), "down"));
  check("...nor the wall beside it", !coversFace(block("water_cauldron"), "north"));

  // Empty is empty: nothing is drawn rather than a surface at zero.
  equal("an empty cauldron holds nothing", await liquid("cauldron"), null);
  equal("...and neither does one that says so", await liquid("cauldron", { level: "0" }), null);

  /*
   * The three heights are vanilla's `_level1`, `_level2` and `_full`, and they
   * are not evenly spaced -- 9, 12, 15 rather than thirds of anything.
   */
  for (const [level, at] of [
    ["1", 9],
    ["2", 12],
    ["3", 15],
  ] as const) {
    equal(`water_cauldron[level=${level}] stands at ${at}`, await liquid("water_cauldron", { level }), {
      at,
      texture: "water_still",
    });
  }

  /*
   * **The two eras spell it differently, and that is the finding rather than a
   * bug in the table.** 1.17 split the block: a modern `cauldron` has no
   * properties at all and the water moved to `water_cauldron[level=1..3]`.
   * Before the Flattening there was one `cauldron` with `level=0..3`, and
   * `legacy_blocks.json` maps `118:2` to `minecraft:cauldron[level=2]` exactly
   * -- so a 1.12 schematic arrives holding a state the modern registry says
   * that block cannot have, and a cauldron of water arrives called `cauldron`.
   * Reading `level` off both spellings is what makes one function serve both.
   */
  equal("a pre-Flattening cauldron holds its water under the old name", await liquid("cauldron", { level: "2" }), {
    at: 12,
    texture: "water_still",
  });

  /*
   * A `water_cauldron` with nothing said is the state the game places it in,
   * which is one third full. It matters because the walk over every offered id
   * bakes with an empty property bag, and an empty pot there would be the
   * commonest cauldron in the app looking like the bug this fixes.
   */
  equal("...and a bare water cauldron is the state it is placed in", await liquid("water_cauldron"), {
    at: 9,
    texture: "water_still",
  });

  // Lava and powder snow have no level in any version: full, or a different
  // block. Neither is tinted, which is vanilla -- only water registers a colour.
  equal("lava fills the pot", await liquid("lava_cauldron"), { at: 15, texture: "lava_still" });
  equal("...and so does powder snow", await liquid("powder_snow_cauldron"), {
    at: 15,
    texture: "powder_snow",
  });
}

console.log("\n--- a bed's two halves meet without fighting ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const bedFaces = async (part: string, facing: string) =>
    (await baker.bakeBlockstate(block("red_bed", { part, facing }))).extraFaces;
  const at = (faces: readonly BakedFace[], axis: 0 | 1 | 2, sign: number, plane: number) =>
    faces.filter(
      (f) => f.normal[axis] === sign && Math.abs(f.positions[axis] - plane) < 1e-6,
    );

  /*
   * Nothing is drawn at the joint. Both halves used to put a face there, with
   * an *end* texture on it — `bed_head_north` against `red_bed_foot_south`,
   * coincident and z-fighting across the middle of every bed.
   */
  const head = await bedFaces("head", "north");
  const foot = await bedFaces("foot", "north");
  equal("the head draws nothing at the joint", at(head, 2, 1, 1).length, 0);
  equal("...and neither does the foot", at(foot, 2, -1, 0).length, 0);

  // Four legs to a bed, two to a half. Both halves used to carry the whole set,
  // which put two of them in the middle where the blocks meet.
  const legsOf = (faces: readonly BakedFace[]) =>
    new Set(
      faces
        .filter((f) => f.normal[1] === -1 && f.positions[1] === 0)
        .map((f) => `${f.positions[0]},${f.positions[2]}`),
    ).size;
  equal("a head has two legs", legsOf(head), 2);
  equal("...and so has a foot", legsOf(foot), 2);
  // At its own end: the head's are under the headboard.
  check(
    "the head's legs are at its outer end",
    head
      .filter((f) => f.normal[1] === -1 && f.positions[1] === 0)
      .every((f) => f.positions[2] < 0.5),
  );
  check(
    "the foot's are at its own",
    foot
      .filter((f) => f.normal[1] === -1 && f.positions[1] === 0)
      .every((f) => f.positions[2] > 0.5),
  );

  /*
   * And the sides are not mirrored. This is the half-turn showing: with it, the
   * foot's world-east face was the model's *west*, so the two halves of one bed
   * wore each other's sides.
   */
  const sideKey = (faces: readonly BakedFace[], sign: number) => {
    const found = faces.find((f) => f.normal[0] === sign && f.positions[1] > 0.15);
    return found?.textureKey ?? null;
  };
  equal("the head's east side is the east one", sideKey(head, 1), "minecraft:block/red_bed_head_east");
  equal("...and the foot's east side too", sideKey(foot, 1), "minecraft:block/red_bed_foot_east");
  equal("the head's west side is the west one", sideKey(head, -1), "minecraft:block/red_bed_head_west");
  equal("...and the foot's west side too", sideKey(foot, -1), "minecraft:block/red_bed_foot_west");
  /*
   * ...and each half shows exactly one end, its own.
   *
   * This is the other half of the joint fault and the part that reads as "the
   * head is facing the wrong way". `red_bed_head_south` does not exist, because
   * that end of the head is never seen — so the joint face fell back through
   * the candidate list to `bed_head_north` and the head block came out with a
   * headboard at **both** ends, z-fighting with the foot's own end texture in
   * the middle of the bed.
   */
  const endKeys = (faces: readonly BakedFace[]) =>
    faces
      .filter((f) => f.normal[1] === 0 && f.normal[0] === 0 && f.positions[1] > 0.15)
      .map((f) => f.textureKey);
  equal("a head shows one end, the headboard", endKeys(head), ["minecraft:block/bed_head_north"]);
  equal("a foot shows one end, its own", endKeys(foot), ["minecraft:block/red_bed_foot_south"]);

  /*
   * The ends, at a facing that actually rotates. `bed_head_north` is the
   * headboard whichever way the bed lies, so an east-facing head shows it on
   * its world-*east* face — which is the check that the geometry and the
   * texture lookup are turning together.
   */
  const eastHead = await bedFaces("head", "east");
  const outer = eastHead.find((f) => f.normal[0] === 1 && f.positions[1] > 0.15);
  equal("an east-facing head shows its headboard east", outer?.textureKey, "minecraft:block/bed_head_north");
  equal("...and nothing at the joint on its west", at(eastHead, 0, -1, 0).filter((f) => f.positions[1] > 0.15).length, 0);

  /*
   * And the pillow is over the head's **outer** half, which is the part that
   * was reported and the part the checks above could not see: they are about
   * which texture goes on which face, and this one was mirrored *within* the
   * face. `black_bed_head_up` is white over the half of its tile the model
   * calls north and black over the other, so a mirrored V put the pillow at the
   * joint — a white patch in the middle of the bed with the headboard beyond it.
   *
   * Black rather than red because a red bed's mattress and its pillow are both
   * light: the difference has to be legible in one number.
   */
  const headTop = (await baker.bakeBlockstate(block("black_bed", { part: "head", facing: "north" })))
    .extraFaces.find((f) => f.normal[1] === 1);
  check("a bed head has a top", headTop !== undefined);
  if (headTop !== undefined) {
    equal("...wearing its own texture", headTop.textureKey, "minecraft:block/black_bed_head_up");
    const outerHalf = texelOn(headTop, [0.5, headTop.positions[1], 0.25]).luminance;
    const jointHalf = texelOn(headTop, [0.5, headTop.positions[1], 0.75]).luminance;
    check("the pillow is over the outer half", outerHalf > 200, `${outerHalf}`);
    check("...and the mattress over the joint", jointHalf < 60, `${jointHalf}`);
  }

  /*
   * A leg's four side faces used to land on the transparent part of their own
   * strip, so each leg drew as two cards rather than a post. `head_west` paints
   * its leg at the low end of the tile and `head_east` at the high one; U
   * mirrored, both boxes read the other end and found nothing.
   */
  const legSides = (await baker.bakeBlockstate(block("black_bed", { part: "head", facing: "north" })))
    .extraFaces.filter((f) => f.normal[1] === 0 && f.normal[0] !== 0 && f.positions[1] < 0.15);
  equal("a head's two legs have four side faces", legSides.length, 4);
  const blank = legSides.filter(
    (f) => texelOn(f, [f.positions[0], 0.09, 0.09]).alpha < 128,
  );
  equal("...and every one of them is drawn", blank.length, 0);
}

// --- what a sign says -------------------------------------------------------
//
// Two spellings, both still in circulation: 1.20 replaced `Text1`..`Text4` with
// `front_text`/`back_text`, and nothing migrates a schematic cut before that.
// Each message is a JSON text component rather than a string, which is the part
// that reads as "the sign is blank" when it is skipped.
// --- a head wears its own face ----------------------------------------------
//
// The box was right and the texture was right; what was missing between them
// was the unwrap. With no `uv` a face takes coordinate-derived UVs, and those
// are correct for a shape cut out of a full-block tile and meaningless on a
// *sheet*: the front of a skeleton's skull was the middle quarter of a whole
// skeleton, stretched over eight pixels. Reported as the heads being smeared.
console.log("\n--- a head wears its own face ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  /** A baked face's window, back in the sheet's own texels. */
  const sheetRect = (face: BakedFace, w: number, h: number): number[] => {
    const us = [0, 2, 4, 6].map((i) => face.uvs[i] * w);
    const vs = [1, 3, 5, 7].map((i) => face.uvs[i] * h);
    return [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)].map((n) =>
      Math.round(n * 100) / 100,
    );
  };
  const facesOf = async (name: string, props: Record<string, string>): Promise<BakedFace[]> => {
    const baked = await baker.bakeBlockstate(block(name, props));
    return [...Object.values(baked.faces), ...baked.extraFaces];
  };
  const towards = (face: BakedFace, axis: number, sign: number): boolean =>
    Math.round(face.normal[axis]) === sign;

  /*
   * `rotation=8` is the one value that turns the model not at all -- vanilla's
   * `RotationSegment` puts south at 0 and north half a turn later -- so the
   * model's own axes and the world's coincide and the windows can be read off
   * directly.
   */
  const steve = await facesOf("player_head", { rotation: "8" });
  const front = steve.find((f) => towards(f, 2, -1));
  const back = steve.find((f) => towards(f, 2, 1));
  const top = steve.find((f) => towards(f, 1, 1));
  const under = steve.find((f) => towards(f, 1, -1));
  check("a head bakes all six faces", steve.length === 6, String(steve.length));
  if (front && back && top && under) {
    /*
     * The head cube is `unwrapCube(0, 0, 8, 8, 8)`, which is the layout every
     * mob sheet in the game has carried since skins existed: the four sides in
     * a band at v 8..16 -- right, front, left, back -- with the two flat faces
     * above them.
     */
    equal("the front of the head is the front of the sheet", sheetRect(front, 64, 64), [8, 8, 16, 16]);
    equal("...and the back is the back", sheetRect(back, 64, 64), [24, 8, 32, 16]);
    equal("the top is the patch above the face", sheetRect(top, 64, 64), [8, 0, 16, 8]);
    equal("...and the underside is the one beside it", sheetRect(under, 64, 64), [16, 0, 24, 8]);

    /*
     * And those last two were the wrong way round, in `unwrapCube` itself,
     * since it was written. Nothing could see it: a chest's top is under its
     * lid, a bell's cap is a flat colour, and a sign's board is two texels of
     * plank -- the three callers it had. A head is the first block where the
     * two patches differ, and there they differ by a whole face: the top of the
     * head is hair and the underside is the neck.
     *
     * Stated against the sheet's own structure rather than against a colour,
     * so it holds for any pack: the top of the head adjoins the top of the
     * face, whatever either happens to be painted.
     */
    const across = [0.3, 0.4, 0.5, 0.6, 0.7];
    const band = (face: BakedFace, at: (n: number) => [number, number, number]): number =>
      across.reduce((sum, n) => sum + texelOn(face, at(n)).luminance, 0) / across.length;
    const hair = band(front, (x) => [x, 0.48, 0.25]);
    const chin = band(front, (x) => [x, 0.02, 0.25]);
    const crown = band(top, (z) => [0.5, 0.5, z]);
    check(
      "the top of the head is the same hair the top of the face is",
      Math.abs(crown - hair) < Math.abs(crown - chin),
      `crown ${crown.toFixed(0)}, hair ${hair.toFixed(0)}, chin ${chin.toFixed(0)}`,
    );
    /*
     * Whole rows rather than one texel each, because a single sample down the
     * middle of Steve's chin lands in the shadow under his mouth and reads as
     * dark as his hair. The row average does not: the cheeks either side of it
     * are skin.
     */
    check(
      "...and the underside is not",
      Math.abs(band(under, (z) => [0.5, 0, z]) - chin) <
        Math.abs(band(under, (z) => [0.5, 0, z]) - hair),
      `under ${band(under, (z) => [0.5, 0, z]).toFixed(0)}`,
    );

    /*
     * And the strip itself is the right way up, which is a separate mistake
     * and was the visible one: with the four sides reversed the head wears its
     * own face upside down, hair on the chin.
     *
     * Stated geometrically so it owes the pack nothing. The reason it is
     * *this* way up rather than the chest's is a measurement, and it is
     * written out beside `upright` in `block_shapes.ts`.
     */
    const sheetRow = (face: BakedFace, highest: boolean): number => {
      let best = 0;
      for (let i = 1; i < 4; i += 1) {
        const better = face.positions[i * 3 + 1] > face.positions[best * 3 + 1];
        if (better === highest) best = i;
      }
      return face.uvs[best * 2 + 1];
    };
    check(
      "the top of the head's face is the top of its patch",
      sheetRow(front, true) < sheetRow(front, false),
      `${sheetRow(front, true)} over ${sheetRow(front, false)}`,
    );
  }

  /*
   * A skeleton's sheet is 64x32 and a player's is 64x64, and `unwrapCube` used
   * to take one number for both axes. Read at the width, the head's band lands
   * at v 8..16 of *64* -- the top quarter of a sheet that is only half that
   * tall, which is a rib.
   */
  const bone = await facesOf("skeleton_skull", { rotation: "8" });
  const boneFront = bone.find((f) => towards(f, 2, -1));
  if (boneFront) {
    equal("a 64x32 sheet is read at its own height", sheetRect(boneFront, 64, 32), [8, 8, 16, 16]);
    check(
      "...which is half way down it, not a quarter",
      boneFront.uvs[1] > 0.24 && boneFront.uvs[1] < 0.51,
      String(boneFront.uvs[1]),
    );
  }

  /*
   * The dragon is deliberately not in the table. Its head is not an 8x8x8 cube
   * on a 64-wide sheet, so there is no window to write that would not be
   * invented -- it keeps the crop it has always had, which is wrong in a way
   * somebody can report rather than wrong in a way that looks deliberate.
   */
  const dragon = await facesOf("dragon_head", {});
  const dragonFront = dragon.find((f) => towards(f, 2, -1));
  if (dragonFront) {
    equal("the dragon keeps its derived crop", sheetRect(dragonFront, 16, 16), [4, 8, 12, 16]);
  }

  /*
   * Sixteen positions, not four. A standing sign rounds `rotation` to the
   * nearest quarter because its board is square in plan and says the same thing
   * on both faces; a head has a face, and rounding would put half the values
   * 22.5 degrees out.
   */
  const looksWhere = async (rotation: string): Promise<string> => {
    const faces = await facesOf("player_head", { rotation });
    const face = faces.find((f) => sheetRect(f, 64, 64).join() === "8,8,16,16");
    if (face === undefined) return "?";
    const [x, , z] = face.normal;
    // A half turn is `Math.sin(Math.PI)`, which is 1.2e-16 rather than zero,
    // and `(-1.2e-16).toFixed(2)` is `"-0.00"`.
    const plain = (n: number): string => (Math.abs(n) < 1e-9 ? 0 : n).toFixed(2);
    return `${plain(x)},${plain(z)}`;
  };
  equal("rotation 0 looks south", await looksWhere("0"), "0.00,1.00");
  equal("rotation 4 looks west", await looksWhere("4"), "-1.00,0.00");
  equal("rotation 8 looks north", await looksWhere("8"), "0.00,-1.00");
  equal("rotation 12 looks east", await looksWhere("12"), "1.00,0.00");
  const between = await looksWhere("2");
  check("...and rotation 2 looks between two of them", between === "-0.71,0.71", between);

  /*
   * The wall variant was a quarter turn out, on every wall head in the game.
   *
   * Vanilla states the shape as its `facing=north` case -- against the *south*
   * wall -- so it is north-authored, and it was being turned by `facingSteps +
   * 2`, which is what an east-authored box needs and what `againstWall`
   * correctly does for a ladder. Invisible until now for two reasons at once: a
   * skull is very nearly symmetric in plan, and every check there was asked
   * `orientPlacement` for the property rather than the baker for the box.
   */
  const wallAt = async (facing: string): Promise<string> => {
    const faces = await facesOf("skeleton_wall_skull", { facing });
    const at = faces.flatMap((f) => [0, 3, 6, 9].map((i) => [f.positions[i], f.positions[i + 2]]));
    const xs = at.map((p) => p[0]);
    const zs = at.map((p) => p[1]);
    if (Math.min(...zs) >= 0.5) return "south wall";
    if (Math.max(...zs) <= 0.5) return "north wall";
    if (Math.min(...xs) >= 0.5) return "east wall";
    return "west wall";
  };
  equal("a north-facing wall skull hangs on the south wall", await wallAt("north"), "south wall");
  equal("...a south-facing one on the north wall", await wallAt("south"), "north wall");
  equal("...an east-facing one on the west wall", await wallAt("east"), "west wall");
  equal("...and a west-facing one on the east wall", await wallAt("west"), "east wall");

  /*
   * And the chest is stated here too, from the other side, so the pair reads as
   * one decision rather than as an oversight in whichever was looked at second.
   * Its strips run the other way -- measured off the lock, which straddles the
   * joint and lands two rows into the lid's strip and two short of the end of
   * the body's.
   */
  const lid = await facesOf("chest", { facing: "north", type: "single" });
  const lidFront = lid.filter((f) => towards(f, 2, -1)).sort((a, b) => b.positions[1] - a.positions[1])[0];
  if (lidFront) {
    const highest = (f: BakedFace, top: boolean): number => {
      let best = 0;
      for (let i = 1; i < 4; i += 1) {
        if (f.positions[i * 3 + 1] > f.positions[best * 3 + 1] === top) best = i;
      }
      return f.uvs[best * 2 + 1];
    };
    check(
      "a chest is not read the same way up, and that is measured too",
      highest(lidFront, true) > highest(lidFront, false),
      `${highest(lidFront, true)} over ${highest(lidFront, false)}`,
    );
  }

  // And it wears the same face the floor one does, on the side it looks out of.
  const hung = await facesOf("creeper_wall_head", { facing: "north" });
  const hungFront = hung.find((f) => towards(f, 2, -1));
  check(
    "a wall head looks out of the wall wearing its face",
    hungFront !== undefined && sheetRect(hungFront, 64, 32).join() === "8,8,16,16",
    hungFront === undefined ? "no north face" : sheetRect(hungFront, 64, 32).join(),
  );
}

// --- a banner is two blocks of cloth ----------------------------------------
//
// It was a 2-thick slab of dyed wool filling the whole cell. A banner standing
// on the ground has no `facing` at all, so `facingSteps` fell back to east and
// every one of the sixteen rotations came out flat against the west wall.
console.log("\n--- a banner is two blocks of cloth ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const bannerFaces = async (name: string, props: Record<string, string>): Promise<BakedFace[]> => {
    const baked = await baker.bakeBlockstate(block(name, props));
    return [...Object.values(baked.faces), ...baked.extraFaces];
  };
  const span = (faces: BakedFace[], axis: number): [number, number] => {
    const at = faces.flatMap((f) => [0, 3, 6, 9].map((i) => f.positions[i + axis]));
    return [Math.min(...at), Math.max(...at)];
  };

  /*
   * Three parts, and the sheet says so: the flag's unwrap runs u 0..42 by
   * v 0..41, the pole's u 44..52 by v 0..44 and the bar's u 0..44 by v 42..46,
   * which is `unwrapCube` evaluated for a 20x40x1 at (0,0), a 2x42x2 at (44,0)
   * and a 20x2x2 at (0,42). Nothing else produces that layout.
   */
  const standing = await bannerFaces("white_banner", { rotation: "0" });
  check("a standing banner is a pole, a bar and cloth", standing.length === 16, String(standing.length));

  /*
   * And it is taller than its own cell, by three quarters of a block. That is
   * the block rather than a liberty: vanilla's pole is 42 units rendered at two
   * thirds, which is 28, with the bar on top of it.
   */
  const tall = span(standing, 1);
  equal("...standing on the floor of its cell", Math.round(tall[0] * 16), 0);
  check("...and reaching well above it", tall[1] > 1.8 && tall[1] < 1.9, String(tall[1]));

  /*
   * Sixteen positions, like a head and for the same reason: a banner has a
   * front. Before this every one of them was the same slab.
   */
  const turns = new Set<string>();
  for (let rotation = 0; rotation < 16; rotation += 1) {
    const faces = await bannerFaces("white_banner", { rotation: String(rotation) });
    turns.add(faces.map((f) => f.positions.join()).join("|"));
  }
  equal("all sixteen rotations are different", turns.size, 16);

  /*
   * A wall banner has no pole -- vanilla hides it -- and **hangs into the cell
   * below**, which is the whole of what makes it read as two blocks tall while
   * its hitbox is one.
   *
   * It has a consequence worth stating rather than discovering: `pickBlockAt`
   * derives the cell from where the ray hit, so a click on the lower half of
   * the cloth selects the empty cell underneath. Minecraft does the same --
   * there is no hitbox down there either -- but the outline round that cell is
   * this app's own.
   */
  const hung = await bannerFaces("red_wall_banner", { facing: "south" });
  check("a wall banner drops its pole", hung.length === 11, String(hung.length));
  const hangs = span(hung, 1);
  check("...and hangs into the cell below it", hangs[0] < -0.8 && hangs[0] > -0.9, String(hangs[0]));
  check("...from just under the top of its own", hangs[1] > 0.8 && hangs[1] < 0.9, String(hangs[1]));

  /*
   * On the face opposite the one it looks out of, which is `againstWall`'s rule
   * arrived at from vanilla's own `facing=south` shape.
   */
  const wallOf = async (facing: string): Promise<string> => {
    const faces = await bannerFaces("red_wall_banner", { facing });
    const [minX, maxX] = span(faces, 0);
    const [minZ, maxZ] = span(faces, 2);
    if (maxZ < 0.5) return "north wall";
    if (minZ > 0.5) return "south wall";
    return maxX < 0.5 ? "west wall" : "east wall";
  };
  equal("a south-facing wall banner is on the north wall", await wallOf("south"), "north wall");
  equal("...a north-facing one on the south wall", await wallOf("north"), "south wall");
  equal("...an east-facing one on the west wall", await wallOf("east"), "west wall");
  equal("...and a west-facing one on the east wall", await wallOf("west"), "east wall");

  /*
   * The colour. The baker's own tint is keyed on the texture path and is one
   * constant per document, so it cannot express a colour that varies with the
   * *state*; the cloth names a synthetic key instead, which is the mechanism
   * the glyphs already used.
   */
  const clothKey = async (name: string): Promise<string> => {
    const faces = await bannerFaces(name, { rotation: "0" });
    return faces.map((f) => f.textureKey).find((k) => k.includes("banner/base")) ?? "none";
  };
  equal("a red banner's cloth is the base tinted red", await clothKey("red_banner"), "minecraft:entity/banner/base#b02e26");
  const dyes = new Set<string>();
  for (const colour of [
    "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray",
    "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black",
  ]) {
    dyes.add(await clothKey(`${colour}_banner`));
  }
  equal("...and all sixteen are different colours", dyes.size, 16);

  /*
   * And the tint is real pixels rather than a name: the base sheet is white, so
   * a red banner's tile has to come out red. Without this the key could be
   * minted, put in the atlas and never multiplied by anything.
   */
  const white = baker.textures["minecraft:entity/banner/base"];
  const red = baker.textures["minecraft:entity/banner/base#b02e26"];
  check("the tinted tile is in the atlas at all", red !== undefined);
  if (white !== undefined && red !== undefined) {
    const mean = (image: { data: Uint8Array }, channel: number): number => {
      let total = 0;
      let n = 0;
      for (let i = 0; i < image.data.length; i += 4) {
        if (image.data[i + 3] === 0) continue;
        total += image.data[i + channel];
        n += 1;
      }
      return n === 0 ? 0 : total / n;
    };
    check("the base sheet is white", mean(white, 0) > 200 && mean(white, 2) > 200);
    check(
      "...and the red one is red",
      mean(red, 0) > 2 * mean(red, 1) && mean(red, 0) > 2 * mean(red, 2),
      `${mean(red, 0).toFixed(0)},${mean(red, 1).toFixed(0)},${mean(red, 2).toFixed(0)}`,
    );
  }

  // The pole and the bar are the two parts a banner does not dye, so they wear
  // the sheet they are on, untinted.
  check(
    "the pole and the bar are not dyed",
    standing.some((f) => f.textureKey === "minecraft:entity/banner/banner_base"),
    [...new Set(standing.map((f) => f.textureKey))].join(" "),
  );
}

console.log("\n--- what a sign says ---");
{
  const str = (value: string) => ({ type: "string", value });
  const modern = (lines: string[], color = "black", glowing = false) =>
    ({
      front_text: {
        type: "compound",
        value: {
          messages: {
            type: "list",
            value: { type: "string", value: lines.map((l) => JSON.stringify({ text: l })) },
          },
          color: str(color),
          has_glowing_text: { type: "byte", value: glowing ? 1 : 0 },
        },
      },
    }) as never;

  const read = readSignText(modern(["Ciao", "mondo"], "red", true));
  equal("a modern sign reads its front", read?.front.lines, ["Ciao", "mondo", "", ""]);
  equal("...with its colour", read?.front.color, "red");
  equal("...and whether it glows", read?.front.glowing, true);
  equal("...padded to four lines however many it holds", read?.front.lines.length, 4);

  const legacy = readSignText({
    Text1: str('{"text":"Vecchio"}'),
    Text2: str('{"text":"cartello"}'),
    Color: str("blue"),
  } as never);
  equal("a pre-1.20 sign reads Text1..Text4", legacy?.front.lines, [
    "Vecchio",
    "cartello",
    "",
    "",
  ]);
  equal("...and its Color", legacy?.front.color, "blue");

  /*
   * A component, not a string. `{"text":"x"}` is what the game writes and
   * `"x"` is what a hand-edited file often holds, and anything that parses as
   * neither is used verbatim -- a sign nobody can read is worse than a sign
   * with the raw text on it.
   */
  equal("a text component is the words in it", plainText('{"text":"Ciao"}'), "Ciao");
  equal("...a bare JSON string too", plainText('"Ciao"'), "Ciao");
  equal("...`extra` is joined on", plainText('{"text":"a","extra":[{"text":"b"},"c"]}'), "abc");
  equal("...an array is joined too", plainText('[{"text":"a"},{"text":"b"}]'), "ab");
  equal("...and what will not parse is left alone", plainText("Ciao mondo"), "Ciao mondo");

  // Nothing to draw is `null`, which is not the same as an empty sign: a blank
  // one still has a `front_text`, and a value for it would put four empty lines
  // through the layout for every sign in the build.
  equal("a blank sign says nothing", readSignText(modern(["", "", "", ""])), null);
  equal("...and neither does a chest", readSignText({ Items: { type: "list", value: { type: "compound", value: [] } } } as never), null);

  check("every sign block is one", isSignBlock("minecraft:oak_sign"));
  check("...wall signs included", isSignBlock("minecraft:oak_wall_sign"));
  check("...and hanging ones", isSignBlock("minecraft:oak_wall_hanging_sign"));
  check("...and a chest is not", !isSignBlock("minecraft:chest"));

  // `rotation` is sixteen steps clockwise from **south**, which is the one that
  // has no `facing` to read and the one that is easy to start from north.
  equal("rotation 0 looks south", signFacing(block("oak_sign", { rotation: "0" })), "south");
  equal("rotation 4 looks west", signFacing(block("oak_sign", { rotation: "4" })), "west");
  equal("rotation 8 looks north", signFacing(block("oak_sign", { rotation: "8" })), "north");
  equal("rotation 12 looks east", signFacing(block("oak_sign", { rotation: "12" })), "east");
  equal(
    "a wall sign says so outright",
    signFacing(block("oak_wall_sign", { facing: "east" })),
    "east",
  );
}

// --- and where it says it ---------------------------------------------------
//
// The text is the only geometry in the pipeline that is a function of a
// *position* rather than of a palette entry — two signs of one block state say
// different things — so it is built per cell by `culledFaces` and cannot be
// checked by baking a blockstate. These drive the real mesher.
console.log("\n--- and where it says it ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const str = (value: string) => ({ type: "string", value });
  const sideNbt = (key: string, lines: string[], color: string, glowing: boolean) => ({
    [key]: {
      type: "compound",
      value: {
        messages: {
          type: "list",
          value: { type: "string", value: lines.map((l) => JSON.stringify({ text: l })) },
        },
        color: str(color),
        has_glowing_text: { type: "byte", value: glowing ? 1 : 0 },
      },
    },
  });
  const textOf = (
    front: string[],
    options: { back?: string[]; color?: string; glowing?: boolean } = {},
  ): SignText => {
    const nbt = {
      ...sideNbt("front_text", front, options.color ?? "black", options.glowing ?? false),
      ...(options.back ? sideNbt("back_text", options.back, "black", false) : {}),
    };
    const read = readSignText(nbt as never);
    if (read === null) throw new Error("the fixture says nothing");
    return read;
  };

  /** One sign alone, meshed the way a document is. */
  const meshSign = async (id: string, properties: Record<string, string>, text: SignText) => {
    const sign = block(id, properties);
    const struct: StructureData = {
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
      palette: [block("air"), sign],
      voxels: Int32Array.from([1]),
    };
    for (const side of [text.front, text.back]) {
      for (const line of side.lines) {
        for (const character of line) {
          await baker.glyph(character.codePointAt(0) ?? 0, [0, 0, 0]);
        }
      }
    }
    const faces = await culledFaces(struct, baker, undefined, null, new Map([[0, text]]));
    return {
      all: faces,
      glyphs: faces.filter((f) => f.textureKey.includes("font/glyph_")),
      board: faces.filter((f) => !f.textureKey.includes("font/glyph_")),
    };
  };

  const plain = await meshSign("oak_sign", { rotation: "0" }, textOf(["Ciao"]));
  check("a sign with nothing on it still draws its board", plain.board.length > 0);
  equal("...and one quad per letter", plain.glyphs.length, 4);
  /*
   * ...and every one of them is wound the way it says it is.
   *
   * The 1197-id walk above cannot reach these: `bakeBlockstate` never
   * produces them, because what a sign says is a fact about a *position*.
   * So the one place in the pipeline the general check does not cover is
   * stated here, and it is the place that was wrong -- `sign_faces.ts` built
   * its corners from the bottom up, which put the front of every line of text
   * behind the board. Double-sided nothing showed it; single-sided the words
   * would have gone missing from in front of every sign in the world.
   */
  check(
    "...each wound the way its normal says",
    plain.glyphs.every(windingAgrees),
    plain.glyphs
      .map((f) => `${f.normal.join()} vs ${windingNormal(f).join()}`)
      .join(" | "),
  );

  // A space takes room and draws nothing, exactly as the font has it: an empty
  // glyph with an advance. Counting quads is what tells the two apart.
  const spaced = await meshSign("oak_sign", { rotation: "0" }, textOf(["Ci ao"]));
  equal("a space is width, not a quad", spaced.glyphs.length, 4);

  /*
   * The front is the side the sign looks at, at every orientation. This is the
   * check the whole feature rests on: the board is turned by `signBoard` and
   * the text by `signTextPlanes`, and if the two ever disagree the words end up
   * on the back of the sign or floating a quarter-turn off it.
   */
  const NORMALS: Record<string, readonly [number, number, number]> = {
    north: [0, 0, -1],
    south: [0, 0, 1],
    east: [1, 0, 0],
    west: [-1, 0, 0],
  };
  for (const [id, properties] of [
    ["oak_sign", { rotation: "0" }],
    ["oak_sign", { rotation: "4" }],
    ["oak_sign", { rotation: "8" }],
    ["oak_sign", { rotation: "12" }],
    ["oak_wall_sign", { facing: "north" }],
    ["oak_wall_sign", { facing: "east" }],
    ["oak_wall_sign", { facing: "south" }],
    ["oak_wall_sign", { facing: "west" }],
    ["oak_wall_hanging_sign", { facing: "north" }],
    ["oak_wall_hanging_sign", { facing: "east" }],
    ["oak_hanging_sign", { rotation: "4", attached: "false" }],
  ] as Array<[string, Record<string, string>]>) {
    const facing = signFacing(block(id, properties));
    const want = NORMALS[facing];
    const meshed = await meshSign(id, properties, textOf(["Ciao"]));
    const label = `${id.replace("oak_", "")} ${Object.values(properties)[0]}`;
    check(
      `${label}: the front text faces ${facing}`,
      meshed.glyphs.length > 0 && meshed.glyphs.every((f) => f.normal.join() === want.join()),
      meshed.glyphs.map((f) => f.normal.join()).join(" "),
    );
    /*
     * ...and stands off the board rather than in it. Coplanar is unresolvable
     * at any distance — the arithmetic is in `depth.ts` — so text written on the
     * board's own plane would stipple against it from halfway across a build.
     */
    const axis = want[0] !== 0 ? 0 : 2;
    const outward = want[axis];
    // The board, meaning the part of the sign the text is written on: a hanging
    // sign's bar reaches further out than its board and a standing sign's post
    // reaches further down, and neither is anything the text has to clear.
    const lows = meshed.glyphs.flatMap((f) => [0, 1, 2, 3].map((i) => f.positions[i * 3 + 1]));
    const lowest = Math.min(...lows);
    const highest = Math.max(...lows);
    const behind = meshed.board.filter((f) => {
      const ys = [0, 1, 2, 3].map((i) => f.positions[i * 3 + 1]);
      return Math.min(...ys) < highest && Math.max(...ys) > lowest;
    });
    const boardEdge = Math.max(
      ...behind.map((f) =>
        outward > 0
          ? Math.max(...[0, 1, 2, 3].map((i) => f.positions[i * 3 + axis]))
          : -Math.min(...[0, 1, 2, 3].map((i) => f.positions[i * 3 + axis])),
      ),
    );
    const textEdge = Math.min(
      ...meshed.glyphs.map((f) =>
        outward > 0
          ? Math.min(...[0, 1, 2, 3].map((i) => f.positions[i * 3 + axis]))
          : -Math.max(...[0, 1, 2, 3].map((i) => f.positions[i * 3 + axis])),
      ),
    );
    check(`${label}: ...and stands off it`, textEdge > boardEdge, `${textEdge} vs ${boardEdge}`);
  }

  /*
   * ...and the board is where the sign says it is.
   *
   * This is a fact about the *shape*, and the checks above cannot see it: the
   * text plane is derived from the same rotated box, so the two agree wherever
   * the box ends up. Sabotage either turn and every check above still passes
   * while the sign hangs on the wrong wall — which is exactly the state both of
   * these were shipped in, because a sign is a plausible sign at any quarter.
   */
  const boardOf = (id: string, properties: Record<string, string>) => {
    const shape = shapeFor(block(id, properties));
    if (shape.kind !== "boxes") return null;
    const volume = (b: readonly number[]) => (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]);
    return [...shape.boxes].sort((a, b) => volume(b.box) - volume(a.box))[0].box;
  };
  // A wall sign hangs on the block behind it, so its board is against the far
  // side of its own cell. Turned by `facingSteps + 2` it went against a wall to
  // one side: a sign that reads `facing=north` bolted to the west.
  //
  // Both halves are needed and the edge alone is not enough: turned a quarter,
  // a north-facing board lands at x 0..2 spanning the whole of z, so its `z1`
  // is still 16 and an edge check passes while the sign is on the west wall.
  // Which way it is *thin* is what says it is against the right one.
  const mounted = (box: readonly number[] | null, facing: string) => {
    if (box === null) return null;
    const thin = box[3] - box[0] < box[5] - box[2] ? "x" : "z";
    const edge =
      facing === "north" ? box[5] : facing === "south" ? box[2] : facing === "east" ? box[0] : box[3];
    return [thin, edge];
  };
  const backsOnto: Record<string, [string, number]> = {
    north: ["z", 16],
    south: ["z", 0],
    east: ["x", 0],
    west: ["x", 16],
  };
  for (const [facing, want] of Object.entries(backsOnto)) {
    equal(
      `a ${facing}-facing wall sign backs onto the wall behind it`,
      mounted(boardOf("oak_wall_sign", { facing }), facing),
      want,
    );
  }
  /*
   * A wall hanging sign hangs in the middle rather than against anything, so
   * what says it turned at all is which way its board is thin. It carries
   * `facing` and no `rotation`, and the hanging shape read `rotation`:
   * `Number(undefined)` is `NaN`, the guard turned that into no rotation, and
   * all twelve of them faced south whatever the file said.
   */
  const thinAxis = (box: readonly number[] | null) =>
    box === null ? null : box[3] - box[0] < box[5] - box[2] ? "x" : "z";
  equal("a north-facing wall hanging sign is thin north-south", thinAxis(boardOf("oak_wall_hanging_sign", { facing: "north" })), "z");
  equal("...and an east-facing one is thin east-west", thinAxis(boardOf("oak_wall_hanging_sign", { facing: "east" })), "x");
  // ...while the one that hangs from a ceiling reads `rotation` and must not
  // fall through to a `facing` it does not have, which defaults to east.
  equal("a hanging sign with no rotation is unturned", thinAxis(boardOf("oak_hanging_sign", { attached: "false" })), "z");
  equal("...and rotation 4 turns it", thinAxis(boardOf("oak_hanging_sign", { rotation: "4" })), "x");

  // Both sides, because a sign has two and the back is the half nobody
  // remembers writing on.
  const twoSided = await meshSign(
    "oak_sign",
    { rotation: "0" },
    textOf(["Ciao"], { back: ["Addio"] }),
  );
  equal("a two-sided sign writes on both", new Set(twoSided.glyphs.map((f) => f.normal[2])).size, 2);
  equal("...four letters one way and five the other", twoSided.glyphs.length, 9);
  const oneSided = await meshSign("oak_sign", { rotation: "0" }, textOf(["Ciao"]));
  equal("...and a blank back draws nothing", new Set(oneSided.glyphs.map((f) => f.normal[2])).size, 1);

  /*
   * Colour is baked into the glyph's own tile, like every other colour in this
   * pipeline: the mesh carries no per-vertex tint and the atlas is the single
   * source. So a red A and a black A are two tiles, and the check is on the
   * pixels rather than on the key.
   */
  const red = await meshSign("oak_sign", { rotation: "0" }, textOf(["A"], { color: "red" }));
  const ink = baker.textures[red.glyphs[0].textureKey];
  let reddest = 0;
  for (let i = 0; i < ink.data.length; i += 4) {
    if (ink.data[i + 3] > 128) reddest = Math.max(reddest, ink.data[i] - ink.data[i + 1]);
  }
  check("red text is red", reddest > 100, `${reddest}`);

  // Glowing text is lit by itself. `shade` is normally filled in by the mesher
  // from where the block ended up; a face that arrives already knowing keeps it,
  // which is what lets a glowing sign be read in an unlit room.
  const glowing = await meshSign("oak_sign", { rotation: "0" }, textOf(["A"], { glowing: true }));
  check(
    "glowing text carries its own light",
    glowing.glyphs.every((f) => f.shade !== undefined && [...f.shade].every((v) => v === 1)),
  );
  const dark = await meshSign("oak_sign", { rotation: "0" }, textOf(["A"]));
  check("...and ordinary text does not", dark.glyphs.every((f) => f.shade === undefined));

  /*
   * The font is proportional and measured, not tabulated: the game finds the
   * last column with a pixel in it. Laid out fixed-width the text is instantly
   * recognisable as wrong, and `i` against `m` is where it shows first.
   */
  const advance = async (character: string) =>
    (await baker.glyph(character.codePointAt(0) ?? 0, [0, 0, 0]))?.advance;
  equal("an i is two wide", await advance("i"), 2);
  equal("...an m is six", await advance("m"), 6);
  equal("...and a space is four, which it has no pixels to say", await advance(" "), 4);
  equal("a character off the ascii page draws nothing", await baker.glyph(0x2603, [0, 0, 0]), null);
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

  /*
   * A wall torch points out of the wall, and the sign of that is the whole bug.
   *
   * Every one of these landed on `facing=north` whatever the click, which for a
   * torch is a torch bolted to nothing on the wrong side of the cell. The
   * natural fix is "point it where the camera is looking" and it is exactly
   * backwards: placing one means *looking at* the wall, so it ends up pointing
   * back at you.
   */
  equal(
    "a wall torch faces out of the wall it was stuck to",
    orientPlacement("minecraft:wall_torch", looking(1, 0, 0, "west")),
    { facing: "west" },
  );
  check(
    "...which is the opposite of where the camera was looking",
    orientPlacement("minecraft:wall_torch", looking(1, 0, 0, "west")).facing !==
      orientPlacement("minecraft:oak_stairs", looking(1, 0, 0, "west")).facing,
  );
  /*
   * With no wall to go on -- a floor, a ceiling, the build grid -- the wall is
   * taken to be the one that was being looked at. Not a second rule: it is the
   * same answer the side click gives, because clicking a block's west face
   * means looking east.
   */
  equal(
    "with no wall it faces back down the look direction",
    orientPlacement("minecraft:wall_torch", looking(1, 0, 0, "up")),
    { facing: "west" },
  );
  equal(
    "...and the two agree wherever both apply",
    orientPlacement("minecraft:soul_wall_torch", looking(0, 0, -1, "south")).facing,
    orientPlacement("minecraft:soul_wall_torch", looking(0, 0, -1, "up")).facing,
  );

  // The rest of the family, which is the same fact and was the same bug: a
  // wall sign, a banner, a mob head and a coral fan all read out of the wall.
  for (const id of [
    "minecraft:redstone_wall_torch",
    "minecraft:copper_wall_torch",
    "minecraft:oak_wall_sign",
    "minecraft:wall_sign",
    "minecraft:red_wall_banner",
    "minecraft:creeper_wall_head",
    "minecraft:skeleton_wall_skull",
    "minecraft:brain_coral_wall_fan",
  ]) {
    equal(`${id} faces out of the wall`, orientPlacement(id, looking(0, 0, 1, "north")).facing, "north");
  }

  /*
   * And the one the suffix must not catch.
   *
   * A wall hanging sign hangs *between* two blocks, on the axis across its
   * `facing`, rather than off the face it was clicked onto -- so the clicked
   * face is not its answer and a confident wrong one is worse than the default.
   * It does not end in `_wall_sign` either ("..._wall_hanging_sign" does not),
   * which is a true sentence about string endings that nobody would check and
   * everybody would rely on.
   */
  equal(
    "a wall hanging sign is left alone",
    orientPlacement("minecraft:oak_wall_hanging_sign", looking(0, 0, 1, "north")),
    {},
  );
  // Nor a standing torch, which has no `facing` at all: writing one would be a
  // state the game refuses, on a block whose name is one character away.
  equal("a standing torch is left alone", orientPlacement("minecraft:torch", north), {});

  /*
   * A trapdoor is the wall-mounted rule with a second property, and for a
   * long time it was neither half of that: `orientPlacement` answered `half`
   * alone, so every trapdoor ever placed by hand came out `facing=north`.
   *
   * The two branches are the two ways of putting one down. Clicked on a side
   * face it takes that face -- the side it swings out over, which is the side
   * you were standing on. Clicked on a floor or a ceiling there is no face to
   * take, so it faces back down the look direction, exactly as a wall torch
   * does with no wall.
   */
  for (const face of ["north", "south", "east", "west"] as const) {
    equal(
      `a trapdoor clicked on a ${face} face swings out over it`,
      orientPlacement("minecraft:oak_trapdoor", looking(0, 0, 1, face, 0.2)),
      { facing: face, half: "bottom" },
    );
  }
  equal(
    "on a floor it faces back at you, like a wall torch with no wall",
    orientPlacement("minecraft:iron_trapdoor", looking(1, 0, 0, "up")),
    { facing: "west", half: "bottom" },
  );
  equal(
    "...and under a ceiling it is a top trapdoor facing the same way",
    orientPlacement("minecraft:iron_trapdoor", looking(1, 0, 0, "down")),
    { facing: "west", half: "top" },
  );
  /*
   * `half` is the half that already worked, and it has to go on working: a
   * fix to `facing` that quietly pinned every trapdoor to the floor would
   * trade one report for another.
   */
  equal(
    "the upper half of a side face still gives a top trapdoor",
    orientPlacement("minecraft:oak_trapdoor", looking(0, 0, 1, "north", 0.8)).half,
    "top",
  );
  /*
   * Stated as the *opposite* of the staircase rather than as "not the same":
   * with `facing` missing entirely -- which is what this arm used to answer --
   * an inequality passes, and a check that survives the bug it was written for
   * is worse than no check.
   */
  equal(
    "...and a trapdoor points the opposite way to a staircase",
    orientPlacement("minecraft:oak_trapdoor", looking(1, 0, 0, "up")).facing,
    "west",
  );
  equal(
    "...which is the way the staircase does not",
    orientPlacement("minecraft:oak_stairs", looking(1, 0, 0, "up")).facing,
    "east",
  );

  /*
   * A standing sign is **not** left alone, and this check used to say it was.
   *
   * It carries a sixteenth-turn `rotation` rather than a `facing`, and nothing
   * here derived one -- the word did not appear in `block_orientation.ts` at
   * all -- so every sign ever placed by hand landed on `rotation=0`, which is
   * a sign facing south, whatever the camera was doing. Reported against the
   * pre-Flattening `sign`, whose sixteen values `legacy_blocks.json` spells
   * out as `63:0`..`63:15`, and true of every modern one as well.
   *
   * The formula is vanilla's: `floor((yaw + 180) * 16 / 360 + 0.5) & 15`. The
   * `+ 180` is the half that cannot be checked by looking -- a sign turned
   * exactly the wrong way still reads as a sign -- so it is checked here
   * against the four cardinal answers the wiki names: rotation 0 faces south,
   * 4 west, 8 north, 12 east.
   */
  for (const [name, direction, expected] of [
    ["looking north", [0, 0, -1], "0"],
    ["looking east", [1, 0, 0], "4"],
    ["looking south", [0, 0, 1], "8"],
    ["looking west", [-1, 0, 0], "12"],
  ] as const) {
    const look = looking(direction[0], direction[1], direction[2], "up");
    equal(
      `a standing sign placed ${name} faces back at you`,
      orientPlacement("minecraft:oak_sign", look).rotation,
      expected,
    );
    equal(
      `...and so does the pre-Flattening one`,
      orientPlacement("minecraft:sign", look).rotation,
      expected,
    );
  }
  /*
   * A ceiling-hung sign is the same property and the same rule. A wall-hung
   * one is neither, and is the name both suffixes catch by accident.
   */
  equal(
    "a hanging sign is spun too",
    orientPlacement("minecraft:oak_hanging_sign", looking(0, 0, 1, "down")).rotation,
    "8",
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

  /*
   * ...and the boxes of a shape are taken **together**, which is vanilla's
   * `faceShapeOccludes` and was `.some(box)` here: one box had to cover the
   * whole square by itself. A staircase's back is covered by two, the lower
   * slab from 0 to 8 and the step from 8 to 16, and by neither alone.
   *
   * The straight model is authored facing east with its tall half at x 8..16,
   * so `facing=east` is the one whose *back* is the east face.
   */
  const eastStair = block("oak_stairs", { facing: "east", half: "bottom", shape: "straight" });
  check("a staircase covers the back two boxes make", coversFace(eastStair, "east"));
  check("...and not the side it opens onto", !coversFace(eastStair, "west"));
  check("...nor its own profile", !coversFace(eastStair, "north"));
}

// --- a shape's own faces are culled too --------------------------------------
//
// Culling used to run one way only. A slab could take the face off the block
// beneath it, and never lost anything of its own: a `boxes` shape leaves the
// six-direction path entirely -- `isFullCube` is false -- and its faces were
// emitted unconditionally. So a staircase pushed against a wall drew its whole
// back, and the wall drew the face behind it, and neither was ever visible.
//
// `BakedFace.cullFace` is vanilla's `cullface`, derived: a box's face carries
// one when its plane is exactly the cell boundary it points at.
console.log("\n--- a shape's own faces are culled too ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  /**
   * The faces of the middle cell of a 3x3x3, alone or walled in on all six
   * sides.
   *
   * The `region` argument restricts which voxels are *visited* and not which
   * are read, so this is exactly the middle cell's own geometry with every
   * neighbour lookup intact -- which is the only way to count one block's
   * faces without its neighbours' faces in the total.
   */
  const middleFaces = async (subject: PaletteEntry, walled: boolean): Promise<BakedFace[]> => {
    const air = block("air");
    const stone = block("stone");
    const struct = structureOf(3, 3, 3, [air, subject, stone], (x, y, z) => {
      if (x === 1 && y === 1 && z === 1) return 1;
      if (!walled) return 0;
      const off = Math.abs(x - 1) + Math.abs(y - 1) + Math.abs(z - 1);
      return off === 1 ? 2 : 0;
    });
    return culledFaces(struct, baker, { minX: 1, minY: 1, minZ: 1, maxX: 1, maxY: 1, maxZ: 1 });
  };

  const stair = block("oak_stairs", { facing: "east", half: "bottom", shape: "straight" });
  equal("a staircase in the open draws both its boxes whole", (await middleFaces(stair, false)).length, 12);
  /*
   * Walled in, what is left is the three surfaces that are *inside* the block:
   * the tread, the riser, and the underside of the step. Every other face of
   * both boxes lies on a side of the cell.
   */
  equal("...and walled in, only the three surfaces inside it", (await middleFaces(stair, true)).length, 3);

  /*
   * And the same in the other direction, which is the half `coversFace` had to
   * learn: the wall behind a staircase loses the face it is hiding.
   */
  const beside = async (facing: string): Promise<number> => {
    const air = block("air");
    const stone = block("stone");
    const stairs = block("oak_stairs", { facing, half: "bottom", shape: "straight" });
    const struct = structureOf(2, 1, 1, [air, stairs, stone], (x) => (x === 0 ? 1 : 2));
    const faces = await culledFaces(struct, baker, {
      minX: 1,
      minY: 0,
      minZ: 0,
      maxX: 1,
      maxY: 0,
      maxZ: 0,
    });
    return faces.filter((f) => f.normal[0] === -1).length;
  };
  equal("a wall behind a staircase loses the face it hides", await beside("east"), 0);
  equal("...and keeps it where the staircase opens away", await beside("west"), 1);

  /*
   * **A flame is not culled, whatever it is standing against.** This is the
   * whole reason the rule is vanilla's and not "the face is thin, drop it":
   * a candle's flame and a campfire's are boxes in mid-air, and fire is a
   * cross, so none of them lies on a side of the cell and none of them can
   * carry a `cullFace`. Walled in on all six sides they come out identical.
   */
  const flamesOf = async (subject: PaletteEntry, walled: boolean): Promise<number> =>
    (await middleFaces(subject, walled)).filter((f) =>
      /flame|campfire_fire|fire_0/.test(f.textureKey),
    ).length;
  const litCandle = block("candle", { lit: "true", candles: "1" });
  equal("a lit candle has a flame", await flamesOf(litCandle, false), 4);
  equal("...and still has it walled in", await flamesOf(litCandle, true), 4);
  const campfire = block("campfire", { lit: "true" });
  equal("a campfire has its two crossed sheets", await flamesOf(campfire, false), 4);
  equal("...and still has them walled in", await flamesOf(campfire, true), 4);
  equal(
    "and fire, being a cross, loses nothing at all",
    (await middleFaces(block("fire"), true)).length,
    (await middleFaces(block("fire"), false)).length,
  );

  /*
   * The derivation itself, stated on the two faces of one slab: the underside
   * lies on the cell's floor and the top does not lie on anything, so only one
   * of them is ever a candidate.
   */
  const slabFaces = (await baker.bakeBlockstate(block("oak_slab", { type: "bottom" }))).extraFaces;
  equal(
    "a slab's underside is on the cell's own floor",
    slabFaces.find((f) => f.normal[1] === -1)?.cullFace,
    "down",
  );
  equal(
    "...and its top is on nothing, being half way up",
    slabFaces.find((f) => f.normal[1] === 1)?.cullFace,
    undefined,
  );
  check(
    "a cross quad lies on no side of its cell",
    (await baker.bakeBlockstate(block("dandelion"))).extraFaces.every(
      (f) => f.cullFace === undefined,
    ),
  );
  /*
   * And a tilted box gets none, because it lies on no plane at all.
   *
   * Said plainly: **this one cannot fail today**, and deleting the `rotation`
   * guard in `bakeShape` fails nothing anywhere. Measured over all 1197 ids,
   * no tilted box has a surviving face on a cell boundary -- a chain's planes
   * run the full height of the cell but the two faces that would claim it are
   * the degenerate ones `boxFaces` already drops. So the guard is what will be
   * right the day somebody transcribes a leaning box flush to a wall, and this
   * is a statement of the rule rather than a tripwire that has ever bitten.
   */
  check(
    "nor does a tilted box, which lies on no plane at all",
    (await baker.bakeBlockstate(block("wall_torch", { facing: "north" }))).extraFaces.every(
      (f) => f.cullFace === undefined,
    ),
  );
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
  // Two legs to a half, four to a bed: both halves used to carry the whole set,
  // which put two of them in the middle where the blocks meet.
  check("a bed half is a mattress on two legs", boxCount("red_bed", { part: "head" }) === 3);
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

  /*
   * Nothing is dropped -- against the block **name**, which is the rule now.
   * This check used to compare against `b.includes(q)` on the namespaced id,
   * so it did not merely miss the bug below: it stated it as the requirement.
   */
  const named = (block: string): string => block.slice(block.indexOf(":") + 1);
  check(
    "nothing is dropped for any query",
    ["a", "e", "stone", "wood", "_"].every(
      (q) => searchBlocks(registry, q).length === registry.filter((b) => named(b).includes(q)).length,
    ),
  );

  /*
   * **No letter of `minecraft` returns the whole registry.**
   *
   * `rank` used to fall back to matching the namespaced id, and every block
   * here is `minecraft:something` -- so `m`, `i`, `n`, `e`, `c`, `r`, `a`, `f`
   * and `t`, nine of the commonest letters in English, each returned all 1197
   * ids. `mi` returned 1197 to show the one block whose name contains it.
   *
   * A bad search on its own, and the load behind a total freeze: the picker
   * mounts a row per match, so a single keystroke built and threw away some
   * five thousand DOM nodes inside a panel a few rows tall.
   *
   * Stated letter by letter rather than as one predicate, because a failure
   * here should name which letter -- and because this is the check that would
   * otherwise be deleted as redundant with the one above it.
   */
  for (const letter of "minecraft") {
    const hits = searchBlocks(registry, letter).length;
    check(
      `"${letter}" does not return the whole registry`,
      hits < registry.length,
      `${hits} of ${registry.length}`,
    );
  }
  equal(
    "...and `mi` returns the one block whose name has it",
    searchBlocks(registry, "mi").length,
    registry.filter((b) => named(b).includes("mi")).length,
  );
  check(
    "...which is one",
    searchBlocks(registry, "mi").length === 1,
    String(searchBlocks(registry, "mi").length),
  );

  /*
   * A query may still *carry* the namespace, because pasting a full id is a
   * real thing to do. It is stripped from the query rather than matched in the
   * id, so there is one place that decides and no way back to matching
   * everything.
   */
  equal(
    "a pasted namespace is stripped, not matched",
    searchBlocks(registry, "minecraft:sto").length,
    searchBlocks(registry, "sto").length,
  );
  equal(
    "...and the namespace alone names no block",
    searchBlocks(registry, "minecraft").length,
    0,
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

// ---------------------------------------------------------------------------
// The property descriptions, against the game's own registry
// ---------------------------------------------------------------------------
//
// `block_properties.json` says what a property *means*; `block_states.json`
// says which properties exist and what values they take. Only the second is
// the game's data, so the first is checked against it and never the other way
// round.
//
// The generator already refuses an invented row, and this is the same claim
// made where it can fail at build time rather than only when somebody
// remembers to run a script -- the same reason `tests/formats.ts` walks the
// tag paths that `shared/schematic.ts` names.
console.log("\n--- block state descriptions ---");
{
  const registry = documentedProperties();

  // Every described form has to be a form the game actually has. A plausible
  // sentence about a property that is not in the game is the failure that
  // matters here: it is served by `describe_block` to a model that will act on
  // it, and nothing downstream would ever contradict it.
  const invented: string[] = [];
  const described = new Set<string>();
  for (const [property, rows] of Object.entries(registry)) {
    for (const row of rows) {
      const key = `${property}[${row.values.join("|")}]`;
      described.add(key);
      const holder = knownBlockNames().find(
        (name) => (legalValuesFor(name, property) ?? []).join(" ") === row.values.join(" "),
      );
      if (holder === undefined) invented.push(key);
    }
  }
  equal("every described property form exists in the game's registry", invented, []);

  // ...and stated from the other side, so a row cannot be quietly deleted. Not
  // a coverage floor with a number in it: the count is what it is, and what
  // this asserts is that no *form* went undescribed, which is the thing a
  // refresh of the registry can silently create.
  const undescribed = new Set<string>();
  for (const name of knownBlockNames()) {
    for (const property of propertiesOf(name)) {
      const key = `${property}[${(legalValuesFor(name, property) ?? []).join("|")}]`;
      if (!described.has(key)) undescribed.add(key);
    }
  }
  equal("...and every form the registry has is described", [...undescribed].sort(), []);

  /*
   * The distinction the whole file is keyed on.
   *
   * A fence's `north` is a boolean and a wall's is `none|low|tall` -- the same
   * name, different types, and `block_shapes.ts` has a `wall()` that knows it
   * and a `fence()` that deliberately does not. Keyed by name alone the two
   * would share one sentence, and the sentence would be wrong for one of them.
   */
  const fence = describeProperty("north", legalValuesFor("minecraft:oak_fence", "north") ?? []);
  const wall = describeProperty("north", legalValuesFor("minecraft:brick_wall", "north") ?? []);
  check("a fence's north is described", fence !== null);
  check("...and so is a wall's", wall !== null);
  check("...and they are not the same description", fence?.description !== wall?.description);
  check(
    "...with the wall's naming the version its type changed",
    (wall?.versions ?? []).some((note) => note.version === "1.16"),
    JSON.stringify(wall?.versions ?? []),
  );

  // Values must match exactly, or a lookup would answer with the nearest row
  // that happens to share a name -- which is the failure above, arrived at
  // through the front door.
  equal(
    "a value set the registry does not have is not described",
    describeProperty("north", ["true", "false", "maybe"]),
    null,
  );
  equal("...nor is a property nobody has heard of", describeProperty("nonsense", ["a"]), null);
}

/** The literal the neighbour table used to hold, kept apart from the check
    that forbids it so the check cannot match itself. */
const NORTH_LITERAL = '["north", 0, 0, -1]';

// --- one table for which way is north ---------------------------------------
//
// `block_orientation.ts` placed blocks by these six vectors and
// `main/domain/connect.ts` walked to its neighbours by its own copy of them.
// Two places deciding where north is, and a viewport compass a quarter turn out
// of step with the writers would stay invisible until somebody pasted a build
// into a world and found it facing the wrong way.
console.log("\n--- face vectors ---");
{
  /*
   * `horizontalFacing` is the inverse for the four horizontal ones, so the pair
   * has to round-trip. This is what catches a transposed sign, which is the
   * only way a table of six unit vectors ever goes wrong.
   */
  for (const face of ["north", "south", "east", "west"] as const) {
    equal(`${face} reads back as ${face}`, horizontalFacing(FACE_VECTOR[face]), face);
  }

  equal("north is -Z, as the file says", FACE_VECTOR.north, { x: 0, y: 0, z: -1 });
  equal("east is +X", FACE_VECTOR.east, { x: 1, y: 0, z: 0 });
  equal("up is +Y", FACE_VECTOR.up, { x: 0, y: 1, z: 0 });

  for (const [a, b] of [
    ["north", "south"],
    ["east", "west"],
    ["up", "down"],
  ] as const) {
    check(
      `${a} and ${b} are opposite`,
      FACE_VECTOR[a].x === -FACE_VECTOR[b].x &&
        FACE_VECTOR[a].y === -FACE_VECTOR[b].y &&
        FACE_VECTOR[a].z === -FACE_VECTOR[b].z,
    );
  }

  /*
   * And the neighbour walk reads this table rather than restating it. Checked
   * by reading the source, because those offsets are a module-private constant
   * -- exporting one for a test's benefit is a worse trade than a grep.
   */
  const connect = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "main",
      "domain",
      "connect.ts",
    ),
    "utf8",
  );
  check(
    "the neighbour offsets come from the shared table",
    connect.includes("FACE_VECTOR[face]"),
  );
  check(
    "...rather than from six numbers of their own",
    !connect.includes(NORTH_LITERAL),
  );
}

// --- the five blocks that were reported unrendered --------------------------
//
// Candles invisible, a candle cake with no candle, and a bell, a hopper and a
// campfire drawn as single crude boxes. One cause behind four of the five: UVs
// derived from box coordinates over a texture that is a **sheet of parts**, so
// a correct box read the wrong -- often empty -- corner of a correct texture.
//
// The invisibility itself is caught by the 920-id walk above, which is where it
// belongs: it is a property every block must have, not a fact about candles.
// What is here is what that walk cannot see -- that the right *number* of
// things is drawn, and that a property changes what it is supposed to change.
console.log("\n--- the five blocks that were reported unrendered ---");
if (pack === null) {
  console.log("  SKIP: no bundled resource pack");
} else {
  const shapeOf = (name: string, props: Record<string, string> = {}) =>
    shapeFor({ namespacedName: `minecraft:${name}`, properties: props });
  const parts = (name: string, props: Record<string, string> = {}) => {
    const shape = shapeOf(name, props);
    return shape.kind === "boxes" ? shape.boxes : [];
  };
  const keysOf = async (name: string, props: Record<string, string> = {}) => {
    const baked = await baker.bakeBlockstate({
      namespacedName: `minecraft:${name}`,
      properties: props,
    });
    return new Set([...Object.values(baked.faces), ...baked.extraFaces].map((f) => f.textureKey));
  };

  /*
   * A candle group is one body plus two crossed quads per candle, so the count
   * is `3n`. Vanilla writes four separate models and the heights differ inside
   * a group -- one arrangement scaled by n would draw four identical posts.
   */
  for (const n of [1, 2, 3, 4]) {
    const held = parts("candle", { candles: String(n) });
    equal(`a candle group of ${n} is ${3 * n} boxes`, held.length, 3 * n);
    equal(
      `...standing ${n} of them on the floor`,
      held.filter((box) => box.box[1] === 0).length,
      n,
    );
  }
  /*
   * Vanilla's own heights, which is the half that stops four candles reading
   * as a grid: 3, 5, 5 and 6 units, not four of anything.
   */
  equal(
    "four candles stand at four vanilla heights",
    parts("candle", { candles: "4" })
      .filter((box) => box.box[1] === 0)
      .map((box) => box.box[4])
      .sort((a, b) => a - b),
    [3, 5, 5, 6],
  );

  /*
   * `lit` swaps the texture and moves **nothing that vanilla states** -- the
   * body and the wick are identical either way, which is all the real model
   * does. This check used to say the geometry was identical *full stop*, and
   * that was true of the model and wrong about the block: no vanilla model
   * has a candle flame, because in the game it is a particle. A lit candle
   * was faithful and still looked unlit, which is how it was reported.
   *
   * So the flame is an approximation, and the checks below are what keep it
   * an *addition*: the transcribed part must not move to make room for it.
   */
  /*
   * Compared by *which boxes are not the flame* rather than by a prefix of the
   * list: the flame is pushed beside the wick it sits on, so a lit candle
   * interleaves the two and an order-based check would only be testing the
   * order they happen to be pushed in.
   */
  const notFlame = (props: Record<string, string>) =>
    parts("candle", props)
      .filter((box) => box.texture !== "particle/flame")
      .map((box) => box.box);
  equal(
    "lighting a candle moves nothing vanilla states",
    notFlame({ lit: "true" }),
    notFlame({ lit: "false" }),
  );
  check("...and does change what it wears", (await keysOf("candle", { lit: "true" })).has("minecraft:block/candle_lit"));
  check("...which an unlit one does not", !(await keysOf("candle", { lit: "false" })).has("minecraft:block/candle_lit"));

  /*
   * The flame itself: two more quads per candle, wearing the sprite the
   * game's own particle is drawn from. An unlit candle has neither.
   */
  for (const n of [1, 2, 3, 4]) {
    equal(
      `a lit group of ${n} adds ${2 * n} quads`,
      parts("candle", { candles: String(n), lit: "true" }).length -
        parts("candle", { candles: String(n), lit: "false" }).length,
      2 * n,
    );
  }
  /*
   * ...and it really resolves. `normalizeTextureKey` rewrites anything not
   * under `block/`, `item/` or `entity/` into `block/`, so before this the
   * path became `block/particle/flame`, resolved nothing, and
   * `resolveBoxTexture` fell back to the candle: a flame made of wax,
   * silently. That fallback is exactly what a texture check cannot see from
   * the geometry, so it is asserted by name.
   */
  check(
    "a lit candle wears the flame sprite",
    (await keysOf("candle", { lit: "true" })).has("minecraft:particle/flame"),
    [...(await keysOf("candle", { lit: "true" }))].join(" "),
  );
  check(
    "...and an unlit one does not",
    !(await keysOf("candle", { lit: "false" })).has("minecraft:particle/flame"),
  );

  /*
   * The candle cake's candle wears a **candle**. `model_baker.ts` aliases the
   * whole block to `cake` so the cake is drawn right, and without a box naming
   * its own texture the candle was a slice of cake standing on a cake --
   * reported as the candle simply not being there.
   */
  const cakeKeys = await keysOf("white_candle_cake");
  check("a candle cake wears cake", cakeKeys.has("minecraft:block/cake_side"), [...cakeKeys].join(" "));
  check("...and its candle wears a candle", cakeKeys.has("minecraft:block/white_candle"), [...cakeKeys].join(" "));

  /*
   * The bell is drawn from the block-entity sheet, like a chest. Its four
   * attachments differ only in what holds it up, so the bell's own two boxes
   * are in all of them and the support count is what moves: a floor bell has
   * a bar and two posts, the other three have a bar.
   */
  for (const [attachment, total] of [
    ["floor", 5],
    ["ceiling", 3],
    ["single_wall", 3],
    ["double_wall", 3],
  ] as const) {
    equal(`a ${attachment} bell is ${total} boxes`, parts("bell", { attachment, facing: "north" }).length, total);
  }
  const bellKeys = await keysOf("bell", { attachment: "floor", facing: "north" });
  check("a bell wears its entity sheet", bellKeys.has("minecraft:entity/bell/bell_body"), [...bellKeys].join(" "));
  check("...and its posts are stone", bellKeys.has("minecraft:block/stone"), [...bellKeys].join(" "));

  /*
   * A hopper has a bowl, a funnel and a spout, and `hopper_inside` is a
   * texture nothing could reach before: the generic candidate list asks for
   * `hopper_side`, which is not a file this pack -- or vanilla -- contains.
   */
  equal("a hopper is seven boxes", parts("hopper", { facing: "down" }).length, 7);
  const hopperKeys = await keysOf("hopper", { facing: "down" });
  for (const wanted of [
    "minecraft:block/hopper_top",
    "minecraft:block/hopper_outside",
    "minecraft:block/hopper_inside",
  ]) {
    check(`a hopper wears ${wanted.replace("minecraft:block/", "")}`, hopperKeys.has(wanted), [...hopperKeys].join(" "));
  }
  /*
   * ...and its spout moves when it is asked to feed something sideways. The
   * down spout hangs below the funnel; the side one comes out of a wall at mid
   * height. Compared as the lowest box, which is the spout in both.
   */
  const downSpout = Math.min(...parts("hopper", { facing: "down" }).map((b) => b.box[1]));
  const sideSpout = Math.min(...parts("hopper", { facing: "north" }).map((b) => b.box[1]));
  check("a hopper facing down drops its spout to the floor", downSpout === 0, String(downSpout));
  check("...and one facing north does not", sideSpout > 0, String(sideSpout));

  /*
   * A campfire is four logs and an ash plate, plus two sheets of flame when it
   * is lit. An unlit one drawing fire is the failure the old candidate list
   * had -- `campfire_log_lit` came first, so a cold campfire wore burning logs.
   */
  equal("an unlit campfire is five boxes", parts("campfire", { lit: "false", facing: "south" }).length, 5);
  equal("...and a lit one is seven", parts("campfire", { lit: "true", facing: "south" }).length, 7);
  const cold = await keysOf("campfire", { lit: "false", facing: "south" });
  const hot = await keysOf("campfire", { lit: "true", facing: "south" });
  check("a cold campfire wears no lit log", !cold.has("minecraft:block/campfire_log_lit"), [...cold].join(" "));
  check("...and no fire", !cold.has("minecraft:block/campfire_fire"), [...cold].join(" "));
  check("a lit one wears both", hot.has("minecraft:block/campfire_log_lit") && hot.has("minecraft:block/campfire_fire"), [...hot].join(" "));
  const soul = await keysOf("soul_campfire", { lit: "true", facing: "south" });
  check("a soul campfire burns blue", soul.has("minecraft:block/soul_campfire_fire"), [...soul].join(" "));

  /*
   * And the sign, which is a different fault in the same file: `signBoard`
   * asked `endsWith("_wall_sign")`, and the pre-Flattening name `wall_sign`
   * does not end in that. It fell through to the standing board -- in the
   * **middle** of the cell, turned by a `rotation` a wall sign never carries,
   * so `NaN`, guarded to zero, so north. Both halves of the report, one
   * missing underscore.
   *
   * Stated as the two spellings agreeing, because that is the rule: a bare
   * family name is a member of its own family.
   */
  for (const facing of ["north", "east", "south", "west"]) {
    equal(`wall_sign and oak_wall_sign agree facing ${facing}`, parts("wall_sign", { facing }).map((b) => b.box), parts("oak_wall_sign", { facing }).map((b) => b.box));
  }
  /*
   * ...and the board really is against a wall rather than in mid-air. A wall
   * sign facing north is bolted to the south face of its cell: thin in z, and
   * the standing board it used to draw was at z 7..9, the middle.
   */
  const wallBoard = parts("wall_sign", { facing: "north" })[0].box;
  check("a north-facing wall sign is against the far wall", wallBoard[2] >= 14, wallBoard.join(","));
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
