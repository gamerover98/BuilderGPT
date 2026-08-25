// Block geometry beyond the unit cube.
//
// `model_baker.py` only ever produced full cubes. Its model-driven path
// (`_bake_with_reader`) always returned `None` and was dropped as dead code
// during the port (RULEBOOK §2 DEV-008), so a staircase, a fence and a slab all
// came out as solid 1x1x1 blocks -- which is why a village schematic rendered
// as a featureless box.
//
// The proper fix is to read `assets/minecraft/models/block/*.json` out of a
// resource pack, but that is not available: Faithful is a *texture* pack and
// ships no block models at all (3 model files, one of them an item). The
// vanilla models live in the Minecraft client jar, which this app cannot
// redistribute. So the shapes are described here instead, in the same 0..16
// coordinate space vanilla models use, transcribed from them.
//
// This is a deliberate approximation, not a model loader. Blocks with no entry
// stay full cubes, which is the same answer as before for anything not listed.

import { paletteEntryIsAir, type PaletteEntry } from "./types.js";

/** A box in Minecraft's 1/16 units: `[x0, y0, z0, x1, y1, z1]`, each 0..16. */
export type Box = readonly [number, number, number, number, number, number];

/** A texture window, `[u0, v0, u1, v1]`, also in 1/16 units of the tile. */
export type UvWindow = readonly [number, number, number, number];

/**
 * A vanilla model element's `rotation`: a tilt about one axis through a point.
 * Angles are the only ones vanilla allows (±22.5, ±45).
 */
export interface BoxRotation {
  readonly origin: readonly [number, number, number];
  readonly axis: "x" | "y" | "z";
  /** Degrees, counter-clockwise looking down the axis. */
  readonly angle: number;
}

export interface ShapeBox {
  readonly box: Box;
  /**
   * Tilts the box's vertices after they are placed. A wall torch is the case
   * that needs it: it is a 22.5° lean off the wall, and an axis-aligned box
   * cannot express that.
   */
  readonly rotation?: BoxRotation;
  /**
   * A texture other than the block's own, by plain name (`glass`). Beacons are
   * the reason: they are a glass shell around a glowing core, two textures in
   * one block.
   */
  readonly texture?: string;
  /**
   * Explicit texture windows per face.
   *
   * UVs are normally derived from the box coordinates, which is right for
   * anything cut from a full-block texture — a slab shows the bottom half of
   * its tile. It is wrong for blocks whose texture is a *sheet* of parts laid
   * out for one specific model: a lantern's sides live at `[0,2,6,9]` of
   * `lantern.png`, nowhere near where its geometry sits in the block. Those
   * windows are transcribed from the vanilla model.
   */
  readonly uv?: Readonly<Record<string, UvWindow>>;
  /**
   * Faces to leave out because another box of the same block covers them. Two
   * coincident faces z-fight, which is what a chest's lid resting exactly on
   * its body looks like: a flickering seam of the chest's dark interior.
   */
  readonly omit?: readonly string[];
}

export type BlockShape =
  /** Not drawn at all. */
  | { readonly kind: "invisible" }
  /** The default: one 0..16 box, handled on the existing fast path. */
  | { readonly kind: "cube" }
  | { readonly kind: "boxes"; readonly boxes: readonly ShapeBox[] }
  /** Two diagonal quads, the vanilla shape for flowers, grass and saplings. */
  | { readonly kind: "cross" };

const CUBE: BlockShape = { kind: "cube" };
const INVISIBLE: BlockShape = { kind: "invisible" };

const boxes = (...list: (Box | ShapeBox)[]): BlockShape => ({
  kind: "boxes",
  boxes: list.map((entry) => (Array.isArray(entry) ? { box: entry as Box } : (entry as ShapeBox))),
});

// --- rotation ---------------------------------------------------------------

/**
 * One 90° step of Minecraft's model `y` rotation, which maps east -> south.
 *
 * Derived rather than tabulated: `(x, z) -> (16 - z, x)`. Check it against the
 * east half of a block, `x in [8,16]`, which must become the south half: the
 * transform gives `x' = 16 - z in [0,16]` and `z' = x in [8,16]`. It does.
 */
function rotateBoxY(box: Box, steps: number): Box {
  let [x0, y0, z0, x1, y1, z1] = box;
  for (let i = 0; i < ((steps % 4) + 4) % 4; i += 1) {
    const nx0 = 16 - z1;
    const nx1 = 16 - z0;
    const nz0 = x0;
    const nz1 = x1;
    x0 = nx0;
    x1 = nx1;
    z0 = nz0;
    z1 = nz1;
  }
  return [x0, y0, z0, x1, y1, z1];
}

/** The same quarter-turn, applied to face names: a north face becomes east. */
const ROTATED_FACE: Readonly<Record<string, string>> = {
  north: "east",
  east: "south",
  south: "west",
  west: "north",
  up: "up",
  down: "down",
};

function rotateUv(
  uv: Readonly<Record<string, UvWindow>> | undefined,
  steps: number,
): Readonly<Record<string, UvWindow>> | undefined {
  if (!uv) return undefined;
  let current = uv;
  for (let i = 0; i < ((steps % 4) + 4) % 4; i += 1) {
    const next: Record<string, UvWindow> = {};
    for (const [face, window] of Object.entries(current)) {
      next[ROTATED_FACE[face] ?? face] = window;
    }
    current = next;
  }
  return current;
}

/** Carries an element rotation through the model's own `y` rotation. */
function rotateBoxRotation(rotation: BoxRotation | undefined, steps: number): BoxRotation | undefined {
  if (!rotation) return undefined;
  let current = rotation;
  for (let i = 0; i < ((steps % 4) + 4) % 4; i += 1) {
    const [ox, oy, oz] = current.origin;
    current = {
      // Same `(x, z) -> (16 - z, x)` map as the boxes.
      origin: [16 - oz, oy, ox],
      // A tilt about x becomes a tilt about z, and a tilt about z becomes a
      // tilt about x in the opposite sense.
      axis: current.axis === "x" ? "z" : current.axis === "z" ? "x" : "y",
      angle: current.axis === "y" ? current.angle : current.axis === "x" ? current.angle : -current.angle,
    };
  }
  return current;
}

function rotateShapeBox(entry: ShapeBox, steps: number): ShapeBox {
  const turns = ((steps % 4) + 4) % 4;
  let omit = entry.omit;
  for (let i = 0; i < turns && omit; i += 1) {
    omit = omit.map((face) => ROTATED_FACE[face] ?? face);
  }
  return {
    ...entry,
    box: rotateBoxY(entry.box, steps),
    uv: rotateUv(entry.uv, steps),
    rotation: rotateBoxRotation(entry.rotation, steps),
    omit,
  };
}

/** Mirrors a box about the horizontal mid-plane, for `half=top` variants. */
function flipShapeBox(entry: ShapeBox): ShapeBox {
  const [x0, y0, z0, x1, y1, z1] = entry.box;
  return { ...entry, box: [x0, 16 - y1, z0, x1, 16 - y0, z1] };
}

/** Quarter-turns to apply so a canonically east-facing model faces `facing`. */
const FACING_STEPS: Readonly<Record<string, number>> = {
  east: 0,
  south: 1,
  west: 2,
  north: 3,
};

function facingSteps(entry: PaletteEntry): number {
  return FACING_STEPS[entry.properties.facing ?? "east"] ?? 0;
}

function transform(list: readonly (Box | ShapeBox)[], steps: number, flip: boolean): BlockShape {
  const shape = boxes(...list);
  if (shape.kind !== "boxes") return shape;
  const out = shape.boxes.map((entry) => {
    const rotated = rotateShapeBox(entry, steps);
    return flip ? flipShapeBox(rotated) : rotated;
  });
  return { kind: "boxes", boxes: out };
}

/**
 * Quarter-turns for a model vanilla authored facing **south** rather than east.
 * Fence gates are the case: `template_fence_gate.json` is drawn with its posts
 * spanning x and its thickness in z, which is a south-facing gate, and the
 * blockstate rotates from there.
 */
function southFacingSteps(entry: PaletteEntry): number {
  return facingSteps(entry) + 3;
}

// --- families ---------------------------------------------------------------

/**
 * Transcribed from vanilla `block/stairs.json`, `stairs_outer.json` and
 * `stairs_inner.json`, which are authored facing east; the blockstate file
 * rotates them, and `shape=*_left` is the `*_right` model turned 270°.
 */
const STAIRS_STRAIGHT: Box[] = [
  [0, 0, 0, 16, 8, 16],
  [8, 8, 0, 16, 16, 16],
];
const STAIRS_OUTER: Box[] = [
  [0, 0, 0, 16, 8, 16],
  [8, 8, 8, 16, 16, 16],
];
const STAIRS_INNER: Box[] = [
  [0, 0, 0, 16, 8, 16],
  [8, 8, 0, 16, 16, 16],
  [0, 8, 8, 8, 16, 16],
];

function stairs(entry: PaletteEntry): BlockShape {
  const shape = entry.properties.shape ?? "straight";
  const left = shape.endsWith("_left");
  const base = shape.startsWith("outer")
    ? STAIRS_OUTER
    : shape.startsWith("inner")
      ? STAIRS_INNER
      : STAIRS_STRAIGHT;
  // The blockstate expresses `*_left` as the right-hand model rotated 270°.
  const steps = facingSteps(entry) + (left ? 3 : 0);
  return transform(base, steps, entry.properties.half === "top");
}

function slab(entry: PaletteEntry): BlockShape {
  const type = entry.properties.type ?? "bottom";
  if (type === "double") {
    return CUBE;
  }
  return type === "top" ? boxes([0, 8, 0, 16, 16, 16]) : boxes([0, 0, 0, 16, 8, 16]);
}

/** `block/fence_post.json` + `fence_side.json`, two rails per connection. */
function fence(entry: PaletteEntry): BlockShape {
  const list: Box[] = [[6, 0, 6, 10, 16, 10]];
  const side: Box[] = [
    [7, 12, 0, 9, 15, 7],
    [7, 6, 0, 9, 9, 7],
  ];
  // The canonical side is north; rotateBoxY's east->south step means north is
  // reached from east by three quarter-turns.
  for (const [direction, steps] of [
    ["north", 0],
    ["east", 1],
    ["south", 2],
    ["west", 3],
  ] as const) {
    if (entry.properties[direction] === "true") {
      for (const box of side) {
        list.push(rotateBoxY(box, steps));
      }
    }
  }
  return boxes(...list);
}

/** `wall_post` + `wall_side` / `wall_side_tall`, connections are none|low|tall. */
function wall(entry: PaletteEntry): BlockShape {
  const list: Box[] = [];
  if (entry.properties.up !== "false") {
    list.push([4, 0, 4, 12, 16, 12]);
  }
  for (const [direction, steps] of [
    ["north", 0],
    ["east", 1],
    ["south", 2],
    ["west", 3],
  ] as const) {
    const connection = entry.properties[direction] ?? "none";
    if (connection === "none") {
      continue;
    }
    const height = connection === "tall" ? 16 : 14;
    list.push(rotateBoxY([5, 0, 0, 11, height, 8], steps));
  }
  return list.length > 0 ? boxes(...list) : boxes([4, 0, 4, 12, 16, 12]);
}

/** Glass panes and iron bars: a thin post plus a thin arm per connection. */
function pane(entry: PaletteEntry): BlockShape {
  const list: Box[] = [[7, 0, 7, 9, 16, 9]];
  for (const [direction, steps] of [
    ["north", 0],
    ["east", 1],
    ["south", 2],
    ["west", 3],
  ] as const) {
    if (entry.properties[direction] === "true") {
      list.push(rotateBoxY([7, 0, 0, 9, 16, 8], steps));
    }
  }
  return boxes(...list);
}

function trapdoor(entry: PaletteEntry): BlockShape {
  if (entry.properties.open === "true") {
    // `template_orientable_trapdoor_open.json` is authored facing **north**
    // with the panel on the south side, and the blockstate turns it from
    // there. Rotating it as if it were east-authored, as everything else in
    // this file is, put every open trapdoor a quarter-turn out.
    return transform([[0, 0, 13, 16, 16, 16]], northFacingSteps(entry), false);
  }
  return entry.properties.half === "top"
    ? boxes([0, 13, 0, 16, 16, 16])
    : boxes([0, 0, 0, 16, 3, 16]);
}

/**
 * Quarter-turns for a model vanilla authored facing **north**. Trapdoors and
 * most `facing`-oriented templates are drawn this way; stairs and torches are
 * the east-authored exceptions.
 */
function northFacingSteps(entry: PaletteEntry): number {
  return facingSteps(entry) + 1;
}

// --- block entities ---------------------------------------------------------
//
// Beds, chests and signs have no block model at all: the game draws them with
// a dedicated renderer from a texture under `textures/entity/`, unwrapped the
// way Minecraft lays out a `ModelPart` cube. For a box `dx x dy x dz` at
// texture offset `(u, v)` that unwrap is:
//
//   down  (u+dz,       v,    dx, dz)      west  (u,          v+dz, dz, dy)
//   up    (u+dz+dx,    v,    dx, dz)      north (u+dz,       v+dz, dx, dy)
//                                         east  (u+dz+dx,    v+dz, dz, dy)
//                                         south (u+2dz+dx,   v+dz, dx, dy)
//
// The windows below are that formula evaluated for the vanilla box sizes, then
// scaled from the 64x64 sheet into the 0..16 window space these shapes use
// (divide by 4). Getting this right is what turns a bed from "a red block"
// into a bed.
function unwrapCube(
  u: number,
  v: number,
  dx: number,
  dy: number,
  dz: number,
): Record<string, UvWindow> {
  const w = (x: number, y: number, width: number, height: number): UvWindow => [
    x / 4,
    y / 4,
    (x + width) / 4,
    (y + height) / 4,
  ];
  return {
    down: w(u + dz, v, dx, dz),
    up: w(u + dz + dx, v, dx, dz),
    west: w(u, v + dz, dz, dy),
    north: w(u + dz, v + dz, dx, dy),
    east: w(u + dz + dx, v + dz, dz, dy),
    south: w(u + 2 * dz + dx, v + dz, dx, dy),
  };
}

/**
 * A bed's two halves are separate boxes in the sheet: the head at texture
 * offset (0,0), the foot at (0,22). `part` says which one this block is.
 *
 * The sheet lays the bed out lying down, so the box's "north" face in the
 * unwrap is the mattress surface you look at from above; the windows are
 * re-pointed accordingly.
 */
function bed(entry: PaletteEntry): BlockShape {
  const head = entry.properties.part !== "foot";
  const uv = unwrapCube(0, head ? 0 : 22, 16, 16, 6);
  // The legs have their own offsets on the sheet, four 3x3x3 unwraps stacked
  // at x=50. Giving them the mattress window instead — and leaving five of
  // their six faces with no window at all, free to sample empty sheet — is
  // what put pale rectangles under every bed.
  const legUv = [0, 6, 12, 18].map((v) => unwrapCube(50, v, 3, 3, 3));
  const legs: Box[] = [
    [0, 0, 0, 3, 3, 3],
    [13, 0, 0, 16, 3, 3],
    [0, 0, 13, 3, 3, 16],
    [13, 0, 13, 16, 3, 16],
  ];
  return transform(
    [
      {
        // The sheet lays the bed out lying down, so the box's `north` face in
        // the unwrap is the mattress you look at from above — verified against
        // the texture: that window holds the white pillow on the head piece
        // and plain red on the foot.
        box: [0, 3, 0, 16, 9, 16],
        uv: {
          up: uv.north,
          down: uv.south,
          north: uv.down,
          south: uv.up,
          east: uv.east,
          west: uv.west,
        },
      },
      ...legs.map((box, i) => ({ box, uv: legUv[i], omit: ["up"] })),
    ],
    // The foot is rendered turned 180° from the head, so the two halves meet
    // head-to-foot instead of both pointing the same way.
    northFacingSteps(entry) + (head ? 0 : 2),
    false,
  );
}

/**
 * Chest: a 14x10x14 body at texture offset (0,19) and a 14x5x14 lid at (0,0),
 * exactly as the vanilla renderer builds them. `type` picks the sheet — a
 * double chest is two blocks each wearing half of `normal_left`/`normal_right`.
 */
function chest(entry: PaletteEntry): BlockShape {
  const body = unwrapCube(0, 19, 14, 10, 14);
  const lid = unwrapCube(0, 0, 14, 5, 14);
  return transform(
    [
      // The body's top and the lid's underside are coincident planes, and the
      // body's top window is the chest's dark *interior* — left in, they
      // z-fight and the seam flickers black.
      { box: [1, 0, 1, 15, 10, 15], uv: body, omit: ["up"] },
      { box: [1, 9, 1, 15, 14, 15], uv: lid, omit: ["down"] },
    ],
    northFacingSteps(entry),
    false,
  );
}

/**
 * Doors are approximated: closed is the 3/16 slab against the face it faces,
 * open is that slab turned a quarter-turn. Which way it turns depends on
 * `hinge`, and vanilla also offsets the open leaf; neither is modelled here.
 */
function door(entry: PaletteEntry): BlockShape {
  const open = entry.properties.open === "true";
  const hinge = entry.properties.hinge === "left" ? -1 : 1;
  const steps = facingSteps(entry) + (open ? hinge : 0);
  return transform([[13, 0, 0, 16, 16, 16]], steps, false);
}

/** Ladders and wall banners hang on the face *opposite* the one they face. */
function againstWall(entry: PaletteEntry, thickness: number): BlockShape {
  return transform([[16 - thickness, 0, 0, 16, 16, 16]], facingSteps(entry) + 2, false);
}

const SNOW_LAYER = (entry: PaletteEntry): BlockShape => {
  const layers = Number(entry.properties.layers ?? "1");
  const height = Number.isFinite(layers) ? Math.min(8, Math.max(1, layers)) * 2 : 2;
  return height >= 16 ? CUBE : boxes([0, 0, 0, 16, height, 16]);
};

/** Suffix-matched families, checked after the exact-name table. */
const SUFFIX_SHAPES: ReadonlyArray<readonly [string, (entry: PaletteEntry) => BlockShape]> = [
  ["_slab", slab],
  ["_stairs", stairs],
  ["_fence_gate", fenceGate],
  ["_fence", fence],
  ["_wall", wall],
  ["_pane", pane],
  ["_trapdoor", trapdoor],
  ["_door", door],
  ["_carpet", () => boxes([0, 0, 0, 16, 1, 16])],
  ["_pressure_plate", () => boxes([1, 0, 1, 15, 1, 15])],
  ["_button", (e) => transform([[5, 0, 6, 11, 2, 10]], facingSteps(e), false)],
  ["_bed", bed],
  ["_banner", (e) => againstWall(e, 2)],
  ["_sign", (e) => againstWall(e, 2)],
  ["_torch", torchShape],
  ["_rail", () => boxes([0, 0, 0, 16, 1, 16])],
  ["_candle", () => boxes([7, 0, 7, 9, 6, 9])],
  ["_sapling", () => ({ kind: "cross" })],
  ["_tulip", () => ({ kind: "cross" })],
  ["_mushroom", () => ({ kind: "cross" })],
];

/**
 * `template_fence_gate.json`: two posts and the bars between them, authored
 * facing south. Getting the authoring direction wrong is what made gates sit
 * across the fence line instead of in it.
 */
const FENCE_GATE_POSTS: Box[] = [
  [0, 5, 7, 2, 16, 9],
  [14, 5, 7, 16, 16, 9],
];
const FENCE_GATE_BARS: Box[] = [
  [6, 6, 7, 10, 15, 9],
  [2, 12, 7, 6, 15, 9],
  [10, 12, 7, 14, 15, 9],
  [2, 6, 7, 6, 9, 9],
  [10, 6, 7, 14, 9, 9],
];

function fenceGate(entry: PaletteEntry): BlockShape {
  // An open gate swings its leaves flat against the posts; drawing just the
  // posts reads as "open" and avoids modelling the swing.
  const parts =
    entry.properties.open === "true"
      ? FENCE_GATE_POSTS
      : [...FENCE_GATE_POSTS, ...FENCE_GATE_BARS];
  return transform(parts, southFacingSteps(entry), false);
}

/**
 * `torch.png` is a 16x16 tile with the stick at x 7..9, y 6..16, so the
 * standing torch's box coordinates already address it correctly. The wall
 * torch does not: `wall_torch.json` puts the box at x -1..1 — outside the
 * block — and leans it 22.5° off the wall, so it states its UVs explicitly.
 */
const TORCH_UV: Readonly<Record<string, UvWindow>> = {
  north: [7, 6, 9, 16],
  south: [7, 6, 9, 16],
  east: [7, 6, 9, 16],
  west: [7, 6, 9, 16],
  up: [7, 6, 9, 8],
  down: [7, 13, 9, 15],
};

function torchShape(entry: PaletteEntry): BlockShape {
  if (entry.namespacedName.includes("wall_torch")) {
    // `wall_torch.json`, verbatim: the blockstate rotates from facing=east, so
    // a torch that faces east is mounted on the wall to its west.
    return transform(
      [
        {
          box: [-1, 3.5, 7, 1, 13.5, 9],
          uv: TORCH_UV,
          // The sign is the one that leans the flame *away* from the wall. A
          // wall torch mounted at the -X edge and facing east must tip toward
          // +X; the opposite sign buries it in the block behind it, which is
          // how it first came out.
          rotation: { origin: [0, 3.5, 8], axis: "z", angle: -22.5 },
        },
      ],
      facingSteps(entry),
      false,
    );
  }
  return boxes({ box: [7, 0, 7, 9, 10, 9], uv: TORCH_UV });
}

/**
 * `lantern.json` / `lantern_hanging.json`. The UV windows matter here more
 * than the boxes: `lantern.png` is a sheet, and the body's sides are drawn
 * from `[0,2,6,9]` of it — a region the box coordinates would never pick.
 */
function lantern(entry: PaletteEntry): BlockShape {
  const hanging = entry.properties.hanging === "true";
  const bodyY = hanging ? 1 : 0;
  const sideUv: UvWindow = [0, 2, 6, 9];
  const capUv: UvWindow = [0, 9, 6, 15];
  const body: ShapeBox = {
    box: [5, bodyY, 5, 11, bodyY + 7, 11],
    uv: { north: sideUv, south: sideUv, east: sideUv, west: sideUv, up: capUv, down: capUv },
  };
  if (!hanging) {
    // A lantern standing on the ground has only the small handle on its lid.
    // The chain belongs to `lantern_hanging` and drawing it on both variants
    // left every floor lantern trailing a chain into thin air.
    return boxes(body, {
      box: [6, bodyY + 7, 7.5, 10, bodyY + 9, 8.5],
      uv: { north: [11, 1, 15, 3], south: [11, 1, 15, 3] },
    });
  }
  return boxes(body, {
    // The chain, from the lid up to the ceiling.
    box: [6, bodyY + 7, 7.5, 10, 16, 8.5],
    uv: { north: [11, 1, 15, 9], south: [11, 1, 15, 9] },
  });
}

/**
 * A chain, transcribed from `chain.json`.
 *
 * It was a solid 3x3 post, and that is the wrong *kind* of wrong: `chain.png`
 * is a sheet, three pixels of link beside three pixels of link seen edge-on,
 * so a box wearing it does not merely have the wrong silhouette, it samples
 * pixels that were never meant for those faces. The lantern failure again,
 * which this file already carries a note about.
 *
 * Vanilla draws two **zero-thickness planes** crossed at 45 degrees, each with
 * an explicit UV window into that sheet. Both are expressible here: `tiltFace`
 * takes any of the three axes, `boxFaces` drops the four faces a plane has no
 * area on, and the viewport's material is `DoubleSide`, so a plane is visible
 * from behind.
 *
 * The reversed windows -- `[3, 0, 0, 16]` has `u0 > u1` -- are vanilla's way of
 * mirroring a face, and `windowUvsFrom` does no ordering check, so they carry
 * across unchanged.
 *
 * ## What a horizontal chain does not get
 *
 * `axis` is honoured for the geometry, which is the part that reads as broken:
 * a chain strung sideways lies along its axis instead of standing up. Its
 * *texture* still runs across the plane rather than along it, because the
 * blockstate rotates the whole model 90 degrees about X and a UV window cannot
 * transpose a quad's axes. Chains hang; this is the rare case, and a wrong
 * silhouette was the visible half.
 */
const CHAIN_TILT: BoxRotation = { origin: [8, 8, 8], axis: "y", angle: 45 };

function chain(entry: PaletteEntry): BlockShape {
  const axis = entry.properties.axis ?? "y";
  if (axis === "x") {
    return boxes(
      { box: [0, 6.5, 8, 16, 9.5, 8], rotation: { ...CHAIN_TILT, axis: "x" } },
      { box: [0, 8, 6.5, 16, 8, 9.5], rotation: { ...CHAIN_TILT, axis: "x" } },
    );
  }
  if (axis === "z") {
    return boxes(
      { box: [6.5, 8, 0, 9.5, 8, 16], rotation: { ...CHAIN_TILT, axis: "z" } },
      { box: [8, 6.5, 0, 8, 9.5, 16], rotation: { ...CHAIN_TILT, axis: "z" } },
    );
  }
  return boxes(
    {
      box: [6.5, 0, 8, 9.5, 16, 8],
      rotation: CHAIN_TILT,
      uv: { north: [3, 0, 0, 16], south: [0, 0, 3, 16] },
    },
    {
      box: [8, 0, 6.5, 8, 16, 9.5],
      rotation: CHAIN_TILT,
      uv: { west: [6, 0, 3, 16], east: [3, 0, 6, 16] },
    },
  );
}

/**
 * A potted plant: the pot from `flower_pot.json`, the plant as a cross above it.
 *
 * Both halves are needed and neither is enough. Before the texture rules
 * reached them these were hashed-colour cubes; with the texture alone they
 * became a *cube wearing a poppy*, which is arguably worse, because it looks
 * like a decision.
 *
 * The plant is written as two crossed planes rather than `kind: "cross"`
 * because a shape is one kind or the other and a pot with a flower in it is
 * both. That costs nothing: a cross *is* two planes at 45 degrees, which is
 * what `crossFaces` builds, and expressing it as boxes is what lets the pot
 * keep its own texture through `ShapeBox.texture` while the plant keeps the
 * block's.
 *
 * It reaches above the block, exactly as vanilla's does -- boxes here are not
 * clamped to 0..16, which is the same latitude a wall torch uses to hang off
 * the side.
 */
const FLOWER_POT: readonly ShapeBox[] = [
  { box: [5, 0, 5, 6, 6, 11], texture: "flower_pot" },
  { box: [10, 0, 5, 11, 6, 11], texture: "flower_pot" },
  { box: [6, 0, 5, 10, 6, 6], texture: "flower_pot" },
  { box: [6, 0, 10, 10, 6, 11], texture: "flower_pot" },
  { box: [6, 0, 6, 10, 4, 10], texture: "dirt" },
];

function pottedPlant(): BlockShape {
  return boxes(
    ...FLOWER_POT,
    { box: [4.8, 6, 8, 11.2, 22, 8], rotation: { origin: [8, 8, 8], axis: "y", angle: 45 } },
    { box: [8, 6, 4.8, 8, 22, 11.2], rotation: { origin: [8, 8, 8], axis: "y", angle: 45 } },
  );
}

/**
 * A piston head: the plate you see, and the rod holding it out.
 *
 * Vanilla's own model, in the same 0..16 units — a 4-deep plate at the far
 * face and a 4x4 rod running back through the block. Facing is ignored: the
 * property exists, but `moving_piston` is a transient the schematic happens to
 * have caught, and a rod pointing the wrong way is a far smaller lie than a
 * hole where a block should be.
 */
function pistonHead(): BlockShape {
  return boxes(
    // The plate.
    { box: [0, 0, 0, 16, 4, 16] },
    // The rod, back through the middle.
    { box: [6, 4, 6, 10, 16, 10] },
  );
}

/** Exact block names, taking precedence over the suffix table. */
const EXACT_SHAPES: Readonly<Record<string, (entry: PaletteEntry) => BlockShape>> = {
  /*
   * Markers: invisible in the world, drawn in the editor.
   *
   * A barrier is invisible to a *player* and is exactly what someone building a
   * schematic needs to see — it is placed on purpose, to keep players out of
   * somewhere, and a shell of them is a decision that has to be reviewable.
   * Drawing nothing meant a build could be full of them and look empty.
   *
   * They are cubes with a see-through texture (`isSeeThrough` below keeps them
   * from culling their neighbours), so a wall of barriers reads as a wall
   * without hiding what is behind it. `preview.showMarkers` turns them back
   * into air for anyone who wants the player's view.
   *
   * `light` stays invisible: it has no in-game appearance to reproduce and no
   * structural meaning to review.
   */
  barrier: () => CUBE,
  structure_void: () => CUBE,
  light: () => INVISIBLE,

  /*
   * The block the game puts where a pushed block is on its way to.
   *
   * It is rendered in vanilla -- it is what you see mid-push -- so drawing
   * nothing left a hole in any schematic captured with a piston firing. The
   * head: a plate across the face and a rod back into the block behind it,
   * which is what `piston_head` is.
   */
  moving_piston: pistonHead,

  // `SUFFIX_SHAPES` keys `"_torch"`, which catches `wall_torch`, `soul_torch`
  // and `redstone_torch` but not the bare name -- so the commonest torch in the
  // game was a full opaque cube that also walled off its neighbours.
  torch: torchShape,

  iron_bars: pane,
  ladder: (e) => againstWall(e, 1),

  // Flat against the face they sit on. As cubes they hid the block underneath,
  // which for a rail means the track is invisible and the ground is too.
  rail: () => boxes([0, 0, 0, 16, 1, 16]),
  lever: (e) => againstWall(e, 3),
  tripwire_hook: (e) => againstWall(e, 3),
  glow_lichen: (e) => againstWall(e, 1),

  // Vanilla insets the cactus by 1/16 on all four sides; drawn as a full cube
  // it merges with whatever it stands next to.
  cactus: () => boxes([1, 0, 1, 15, 16, 15]),
  scaffolding: () => boxes([0, 14, 0, 16, 16, 16]),
  bamboo: () => boxes([6.5, 0, 6.5, 9.5, 16, 9.5]),
  kelp: () => ({ kind: "cross" }),
  kelp_plant: () => ({ kind: "cross" }),
  sea_pickle: () => boxes([6, 0, 6, 10, 6, 10]),
  candle: () => boxes([7, 0, 7, 9, 6, 9]),

  // Workstations that are not full blocks. `composter` is left a cube on
  // purpose: its outer shell really is 16x16x16, only its inside is hollow.
  stonecutter: () => boxes([0, 0, 0, 16, 9, 16]),
  grindstone: (e) => transform([[4, 4, 2, 12, 16, 14]], facingSteps(e), false),
  lectern: () => boxes([0, 0, 0, 16, 2, 16], [4, 2, 4, 12, 15, 12]),
  chest,
  trapped_chest: chest,
  ender_chest: chest,
  enchanting_table: () => boxes([0, 0, 0, 16, 12, 16]),
  cake: () => boxes([1, 0, 1, 15, 8, 15]),
  snow: SNOW_LAYER,
  farmland: () => boxes([0, 0, 0, 16, 15, 16]),
  dirt_path: () => boxes([0, 0, 0, 16, 15, 16]),
  grass_path: () => boxes([0, 0, 0, 16, 15, 16]),
  lantern,
  soul_lantern: lantern,

  // A glass shell around a glowing core, which is why it is two boxes with
  // two different textures rather than one cube wearing `beacon.png`.
  beacon: () =>
    boxes(
      { box: [0, 0, 0, 16, 16, 16], texture: "glass" },
      { box: [2, 2, 2, 14, 14, 14], texture: "beacon" },
    ),
  flower_pot: () => boxes(...FLOWER_POT),
  campfire: () => boxes([0, 0, 0, 16, 7, 16]),
  soul_campfire: () => boxes([0, 0, 0, 16, 7, 16]),
  cauldron: () => boxes([0, 0, 0, 16, 16, 16]),
  hopper: () => boxes([0, 10, 0, 16, 16, 16]),
  end_rod: () => boxes([6, 0, 6, 10, 16, 10]),
  chain,
  bell: () => boxes([4, 4, 4, 12, 12, 12]),
  conduit: () => boxes([5, 5, 5, 11, 11, 11]),
  lily_pad: () => boxes([0, 0, 0, 16, 1, 16]),

  /*
   * Blocks that had a texture before they had a shape.
   *
   * Every one of these was a full opaque cube, which is two faults rather than
   * one: the wrong silhouette, and -- because only a full opaque cube may cull
   * -- a hole punched in each of its six neighbours. A line of redstone drawn
   * as a cube does not merely look like a wall, it deletes the floor it is
   * lying on.
   *
   * These are approximations and are worth having as approximations. The rule
   * this file states elsewhere -- an unlisted block stays a cube, because a
   * confidently wrong shape looks deliberate -- assumes a cube is the harmless
   * answer. For these it is the harmful one, so a close box beats it.
   */
  redstone_wire: () => boxes([0, 0, 0, 16, 1, 16]),
  skeleton_skull: () => boxes([4, 0, 4, 12, 8, 12]),
  skeleton_wall_skull: (e) => transform([[4, 4, 8, 12, 12, 16]], facingSteps(e) + 2, false),
  decorated_pot: () => boxes([1, 0, 1, 15, 16, 15]),
  sniffer_egg: () => boxes([1, 0, 1, 15, 16, 15]),
  // Tapered in vanilla, and a taper is a stack of boxes this does not build.
  // A narrow column is the shape's *reach*, which is what a neighbour needs.
  pointed_dripstone: () => boxes([5, 0, 5, 11, 16, 11]),
  // The board on its post. `SUFFIX_SHAPES` keys "_sign", which catches
  // `oak_sign` and `oak_wall_sign` and not the bare pre-Flattening name.
  sign: () => boxes([0, 9, 7, 16, 16, 9], [7, 0, 7, 9, 9, 9]),
  cocoa: (e) => transform([[6, 7, 11, 10, 12, 15]], northFacingSteps(e), false),
  /*
   * The two blocks vanilla draws with a shader over a starfield. There is
   * nothing in a resource pack to read, so the texture is a deliberate black
   * stand-in and the shape is the surface it sits on: 12/16 up, which is where
   * you fall through.
   */
  end_portal: () => boxes([0, 11, 0, 16, 12, 16]),
  end_gateway: () => boxes([0, 11, 0, 16, 12, 16]),
  // The same plate and rod as `moving_piston`, which is what a piston head is.
  piston_head: pistonHead,
};

/** Blocks drawn as two crossed quads rather than boxes. */
const CROSS_BLOCKS: ReadonlySet<string> = new Set([
  "short_grass",
  "grass",
  "tall_grass",
  "fern",
  "large_fern",
  "dead_bush",
  "seagrass",
  "sugar_cane",
  "wheat",
  "carrots",
  "potatoes",
  "beetroots",
  "nether_wart",
  "sweet_berry_bush",
  "cobweb",
  "vine",
  "dandelion",
  "poppy",
  "blue_orchid",
  "allium",
  "azure_bluet",
  "oxeye_daisy",
  "cornflower",
  "lily_of_the_valley",
  "wither_rose",
  "torchflower",
  "sunflower",
  "lilac",
  "rose_bush",
  "peony",
  "pitcher_plant",
  "crimson_roots",
  "warped_roots",
  "nether_sprouts",
  "brown_mushroom",
  "red_mushroom",
  /*
   * Fire is two crossed planes in vanilla too, and was a solid cube here --
   * so a burning campfire walled off whatever it stood on. `torchflower_crop`
   * is an ordinary crop that the `age` texture rule reached before any shape
   * table did.
   */
  "fire",
  "soul_fire",
  "torchflower_crop",
]);

function baseName(entry: PaletteEntry): string {
  return entry.namespacedName.replace(/^minecraft:/, "");
}

export function shapeFor(entry: PaletteEntry): BlockShape {
  const name = baseName(entry);

  const exact = EXACT_SHAPES[name];
  if (exact) {
    return exact(entry);
  }
  if (name.startsWith("potted_")) {
    return pottedPlant();
  }
  if (CROSS_BLOCKS.has(name)) {
    return { kind: "cross" };
  }
  for (const [suffix, build] of SUFFIX_SHAPES) {
    if (name.endsWith(suffix)) {
      return build(entry);
    }
  }
  return CUBE;
}

/**
 * Whether this block hides the face of the neighbour behind it.
 *
 * Only a full opaque cube does. Culling against a slab or a fence is what made
 * a staircase look like a wall: the block behind it lost its face to a
 * neighbour that covers an eighth of it.
 *
 * **Air is the case that has to come first.** It is not in any shape table, so
 * it used to fall through to `CUBE` and answer yes -- and since every exposed
 * face of a structure has air behind it, that culled all of them. What survived
 * was the shell of the bounding box and nothing else: measured on a 21x14x26
 * house, 216 faces out of 1700. It went unnoticed for so long because a dense
 * build that fills its own bounding box looks almost right as a shell; a house
 * with a wide lawn and thin walls disappears entirely.
 */
export function occludesNeighbours(entry: PaletteEntry): boolean {
  if (paletteEntryIsAir(entry)) {
    return false;
  }
  return shapeFor(entry).kind === "cube" && !isSeeThrough(entry);
}

/**
 * Blocks you can see through, so they must not occlude even though their
 * geometry is a full cube.
 *
 * Fluids belong here for the same reason glass does -- the sand under a pond is
 * visible from above, so it keeps its top face. What stops that from meshing
 * the interior of an ocean is the identical-neighbour rule in `mesher.ts`:
 * water still hides water, glass still hides glass.
 */
function isSeeThrough(entry: PaletteEntry): boolean {
  const name = baseName(entry);
  return (
    name.startsWith("glass") ||
    name.endsWith("_glass") ||
    name.endsWith("_leaves") ||
    name === "water" ||
    name === "lava" ||
    name === "bubble_column" ||
    name === "ice" ||
    name === "frosted_ice" ||
    name === "slime_block" ||
    name === "honey_block" ||
    /*
     * The markers. They are drawn as cubes so they can be seen, and they must
     * not cull: a barrier hides nothing in the game, so a barrier that deleted
     * the face of the wall behind it would be worse than not drawing it at all.
     */
    name === "barrier" ||
    name === "structure_void" ||
    name.endsWith("_ice")
  );
}
