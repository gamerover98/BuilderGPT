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
   * A texture per face, for a box whose sides do not all wear the same one.
   *
   * `texture` covers "this box is made of something else"; this covers "and
   * its ends are made of a third thing". A grindstone's wheel is the case that
   * needed it — `#round` on the two flat faces and `#side` on the rim, from
   * one element of one vanilla model — and the anvil's block is the other:
   * `#body` all round with `#top` on the face the hammer lands on.
   *
   * Before it, the only per-face rule was `SPECIAL_FACE_RULES`, which is keyed
   * on the *block*: saying "up is anvil_top" there puts the anvil's top on the
   * up face of every box in the anvil, including the ledge round its foot,
   * which vanilla textures with the body.
   */
  readonly textures?: Readonly<Record<string, string>>;
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
   * A vanilla face's `rotation`: the texture turned clockwise within the face,
   * in whole quarter-turns. It is a property of the *window*, not of the box —
   * the anvil states its foot's west face as `[0, 2, 4, 14]` rotated 90°, a
   * window that is 4 wide and 12 tall wrapped onto a face that is 12 wide and
   * 4 tall — so a window without its rotation addresses the right pixels and
   * lays them across the face sideways.
   */
  readonly uvRotation?: Readonly<Record<string, number>>;
  /**
   * Faces to leave out because another box of the same block covers them. Two
   * coincident faces z-fight, which is what a chest's lid resting exactly on
   * its body looks like: a flickering seam of the chest's dark interior.
   */
  readonly omit?: readonly string[];
}

/*
 * There is no "invisible" kind, and there used to be. `light` was the only
 * block that produced one, on the argument that it has no in-game appearance to
 * reproduce -- which is true and beside the point, because neither does a
 * barrier. Now that it draws, nothing is invisible, and a variant nothing
 * produces is a branch nothing tests.
 */
export type BlockShape =
  /** The default: one 0..16 box, handled on the existing fast path. */
  | { readonly kind: "cube" }
  | { readonly kind: "boxes"; readonly boxes: readonly ShapeBox[] }
  /** Two diagonal quads, the vanilla shape for flowers, grass and saplings. */
  | { readonly kind: "cross" };

const CUBE: BlockShape = { kind: "cube" };

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

/**
 * Carries anything keyed by face name through the model's `y` rotation.
 *
 * The values are untouched: a window, a texture name and a quarter-turn count
 * all describe the face they are attached to, and the rotation only moves which
 * face that is. Written once rather than three times because the three maps on
 * a `ShapeBox` have to move together — a texture that stayed put while its
 * window turned would be a fault nothing in the app could notice.
 */
function rotateFaceMap<T>(
  map: Readonly<Record<string, T>> | undefined,
  steps: number,
): Readonly<Record<string, T>> | undefined {
  if (!map) return undefined;
  let current = map;
  for (let i = 0; i < ((steps % 4) + 4) % 4; i += 1) {
    const next: Record<string, T> = {};
    for (const [face, value] of Object.entries(current)) {
      next[ROTATED_FACE[face] ?? face] = value;
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
    uv: rotateFaceMap(entry.uv, steps),
    textures: rotateFaceMap(entry.textures, steps),
    uvRotation: rotateFaceMap(entry.uvRotation, steps),
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
  /**
   * The sheet's own width, in its own texels.
   *
   * The windows below are stated in sheet texels and `UvWindow` is in
   * sixteenths of the tile, so the two only agree once the sheet's size is
   * known. It was hardcoded as 64 — right for every sheet this function had
   * been used on, and wrong the moment a 32-wide one arrived: a sign's board
   * came out wearing a quarter of its own sheet blown up to fill the face,
   * which reads as a plank and is why it nearly passed.
   */
  sheet = 64,
): Record<string, UvWindow> {
  const scale = 16 / sheet;
  const w = (x: number, y: number, width: number, height: number): UvWindow => [
    x * scale,
    y * scale,
    (x + width) * scale,
    (y + height) * scale,
  ];
  /*
   * The four side strips run **bottom-up**, and the lock says so.
   *
   * A chest's lock plate straddles the joint: it is a notch in the *bottom* of
   * the lid's front and the *top* of the body's front. In the sheet that notch
   * sits two rows into the lid strip and two rows short of the end of the body
   * strip -- which puts both of them at the joint only if the first row of a
   * side strip is the box's bottom edge.
   *
   * Read the strips top-down instead and the chest comes out with its lock in
   * two places it cannot be: near the top of the lid and near the bottom of the
   * body. That is what it was doing, and it is the kind of fault that survives
   * two rounds of looking at it, because every plank still lines up and only
   * one small detail is in the wrong place.
   *
   * Expressed by handing back a window whose v descends. `windowUvsFrom` does
   * no ordering check, so a reversed window flips the face -- the same
   * mechanism vanilla's own models use to mirror one.
   */
  const side = (x: number, y: number, width: number, height: number): UvWindow => [
    x * scale,
    (y + height) * scale,
    (x + width) * scale,
    y * scale,
  ];
  return {
    down: w(u + dz, v, dx, dz),
    up: w(u + dz + dx, v, dx, dz),
    west: side(u, v + dz, dz, dy),
    north: side(u + dz, v + dz, dx, dy),
    east: side(u + dz + dx, v + dz, dz, dy),
    south: side(u + 2 * dz + dx, v + dz, dx, dy),
  };
}

/**
 * A bed: the mattress and four legs.
 *
 * It used to carry `unwrapCube` windows into a per-colour `entity/bed/<colour>`
 * sheet, and every one of them is gone -- **1.21.9 moved beds onto ordinary
 * per-face block textures**, so `model_baker.ts`'s `bedCandidates` names
 * `red_bed_head_up` and the rest directly and there is no unwrap left to get
 * wrong. Two classes of bug went with it: a leg wearing the mattress window,
 * and the head and foot disagreeing about which way the sheet ran.
 *
 * The geometry stays. The model is authored with the head toward **north**,
 * which is what `bedCandidates` undoes when it maps a world face back into the
 * model's own axes; the foot is the same shape turned 180 degrees so the two
 * halves meet head-to-foot.
 *
 * Nothing here decides where the *pillow* lands, and that is the point: a bed
 * is the block that finally made the mirrored UV convention legible, because
 * `<colour>_bed_head_up` is white over the half of its tile the model calls
 * north and black over the other. Read backwards it put the pillow at the joint
 * — a white patch in the middle of the bed with the headboard beyond it — and
 * every leg's two side faces sampled the empty end of their own strip, so each
 * leg drew as two cards rather than a post. The fix is in
 * `model_baker.ts`'s `boxFaceGeometry`; this file needed no change at all,
 * which is why the fault looked like a bed for three rounds of looking at it.
 */
function bed(entry: PaletteEntry): BlockShape {
  const head = entry.properties.part !== "foot";
  /*
   * Two legs, at the half's *outer* end, and there used to be four on each.
   *
   * A bed has four legs and this gave it eight: both halves carried the whole
   * set, so a pair had two legs standing in the middle where the two blocks
   * meet. Vanilla's `bed_head` and `bed_foot` are separate models and each has
   * the two at its own end.
   */
  const legs: Box[] = head
    ? [
        [0, 0, 0, 3, 3, 3],
        [13, 0, 0, 16, 3, 3],
      ]
    : [
        [0, 0, 13, 3, 3, 16],
        [13, 0, 13, 16, 3, 16],
      ];
  /*
   * ...and the joint is not drawn, on either half.
   *
   * The two halves meet at one plane and both were putting a face there, with
   * an *end* texture on it -- `bed_head_north` against `red_bed_foot_south`,
   * coincident and z-fighting across the middle of every bed. That is the
   * "badly stitched" report, and it is two faces where there should be none.
   *
   * Named before the rotation, so `rotateShapeBox` carries it: for the head the
   * joint is at the model's south, for the foot at its north.
   */
  const joint = head ? "south" : "north";
  /*
   * **One rotation for both halves**, where the foot used to get an extra
   * half-turn.
   *
   * The two share one geometry here where vanilla has two models, and turning
   * the foot 180 degrees was how its legs got to the far end. Stating the legs
   * and the joint per half does the same job with no rotation, and it is worth
   * preferring only because the `omit` above can then be read in the half's own
   * terms rather than in the model's.
   *
   * It is **not** where the fault was, which is worth writing down because it
   * was the first place looked. A half-turn about y maps the model's west face
   * onto the world's east, and `boxFaceGeometry` gives a west face `u = 1 - z`
   * against an east face's `u = z` -- so the rotation's flip and the face's own
   * cancel, and the sides came out identical either way. Sabotaging this back
   * to the half-turn fails the leg and joint checks below and nothing about the
   * sides, which is the honest answer.
   */
  return transform(
    [
      { box: [0, 3, 0, 16, 9, 16], omit: [joint] },
      // A leg's top is under the mattress and would z-fight with its floor.
      ...legs.map((box) => ({ box, omit: ["up"] })),
    ],
    northFacingSteps(entry),
    false,
  );
}

/**
 * Chest: a 14x10x14 body at texture offset (0,19) and a 14x5x14 lid at (0,0),
 * exactly as the vanilla renderer builds them.
 *
 * ## It faced backwards, and the sheet says so
 *
 * The model is authored **facing south**, not north. Diffing the four side
 * windows of the body against each other leaves exactly one that differs --
 * `south` -- and a chest has exactly one side that differs, the front. Rotated
 * as if it were north-authored, every chest in the app wore its front on its
 * back.
 *
 * The double-chest sheets corroborate it independently. `normal_left`'s seam --
 * the dark, textureless join where the other half goes -- is on its *west*
 * window and `normal_right`'s is on its *east*, and those land on the model's
 * east and west faces only under this rotation. That is also what makes
 * `getConnectedDirection`'s convention come out right: a `left` chest's partner
 * is clockwise of its facing.
 *
 * ## A double half is 15 wide
 *
 * Vanilla joins the two halves into one 30-wide chest, so each is 15 and they
 * meet with no seam. Drawn as two 14-wide chests they stand a pixel apart with
 * a wall of interior texture between them, which reads as two chests that
 * happen to be adjacent -- which is exactly what a double chest is not.
 */
function chest(entry: PaletteEntry): BlockShape {
  /*
   * A double half's sheet is unwrapped **15 wide**, not 14.
   *
   * The unwrap lays the six faces out end to end, so one extra column of width
   * shifts every window after the first: the front sat one column left of where
   * it is, and the sides sampled a stripe of their neighbour. Passing the
   * single chest's 14 for a `normal_left` sheet is a fault that looks like a
   * texture drawn slightly wrong rather than a texture read from the wrong
   * place, which is why it survived the rotation fix.
   *
   * Confirmed against the sheets: the seam column -- the dark, textureless join
   * -- starts at 29 on `normal_right`, which is `d + w` for d=14 and w=15.
   */
  const type = entry.properties.type;
  const wide = type === "left" || type === "right";
  const width = wide ? 15 : 14;
  /*
   * The body is **nine** rows tall, not ten, and the tenth is the seam.
   *
   * A chest is 14 tall and its two strips are 10 and 5, which is 15 -- so one
   * row is spent twice, and the sheet says which. The body's last row and the
   * lid's first are *byte-identical*: at every column of the front strip,
   * `46 48 48 46 46 36 36 36 48 46 46 48 48 59`. That is the dark line where
   * the lid meets the body, painted once and read by both boxes.
   *
   * Drawn as vanilla states them the two boxes overlap over that row and their
   * four side faces are coplanar there. In the game the z-fight is invisible
   * because both surfaces are the same pixels; here it was a dotted black line
   * across every chest in the build, because the atlas resamples each window
   * separately and the two stop agreeing to the texel.
   *
   * So the body stops at 9 and the lid keeps the seam. Nothing is squashed and
   * nothing is invented: both strips still map one row to one unit, and the
   * only row dropped is the one that was drawn twice.
   */
  const body = unwrapCube(0, 19, width, 9, 14);
  const lid = unwrapCube(0, 0, width, 5, 14);
  /*
   * The seam faces the partner: `left` is joined clockwise of its facing, which
   * for a north-facing chest is east.
   *
   * Written **inverted**, and that is not a slip. These coordinates are the
   * model before `transform` turns it, and a south-authored model reaches a
   * north-facing block through a half-turn -- so the side written at +x is the
   * side that ends up at -x. Getting it the intuitive way round put every
   * double chest's seam on its outer edge and its open side against its
   * partner, which reads as two chests pushed apart rather than one joined.
   */
  const x0 = type === "left" ? 0 : 1;
  const x1 = type === "right" ? 16 : 15;
  /*
   * The face that meets the partner is not drawn.
   *
   * Both halves put one there, at the same world position, and both windows
   * hold the sheet's seam -- the dark, textureless join. Two coincident faces
   * z-fighting over the chest's own interior is exactly the black line down the
   * middle of a double chest.
   *
   * Named before the rotation, because `rotateShapeBox` turns `omit` with the
   * box: `left` is joined clockwise of its facing, which is the model's *west*
   * face before the half-turn puts it east.
   */
  const inner = wide ? [type === "left" ? "west" : "east"] : [];
  /*
   * The lock: the latch on the front, straddling the joint.
   *
   * It was simply missing -- the sheet has it at (0,0), 2x4x1, and the notch it
   * leaves in the two front strips was being drawn with nothing standing in it.
   * Four rows centred on the joint puts it at 7..11, which is where the notch
   * is: the dark core sits at the body's rows 40-41 and the lid's 15-16.
   *
   * A double half's latch is **one** wide, because vanilla's is two wide
   * centred on the pair and each half carries the half of it that is on its
   * own side of the seam. The sheets say so on their own: `normal_left` leaves
   * its lock's west window blank and `normal_right` its east, which is the
   * same face `inner` already names for the chest itself.
   *
   * `north` goes, on all three: it lies in the plane of the chest's own front.
   */
  const lockWide = wide ? 1 : 2;
  const lockX0 = wide ? (type === "left" ? 0 : 15) : 7;
  const lock = unwrapCube(0, 0, lockWide, 4, 1);
  return transform(
    [
      // The body's top and the lid's underside are coincident planes, and the
      // body's top window is the chest's dark *interior* -- left in, they
      // z-fight and the seam flickers black.
      { box: [x0, 0, 1, x1, 9, 15], uv: body, omit: ["up", ...inner] },
      { box: [x0, 9, 1, x1, 14, 15], uv: lid, omit: ["down", ...inner] },
      {
        box: [lockX0, 7, 15, lockX0 + lockWide, 11, 16],
        uv: lock,
        omit: ["north", ...inner],
      },
    ],
    southFacingSteps(entry),
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
  /*
   * The copper chests came with the copper golem and only ever got half the
   * treatment: `entityTextureAlias` knows their sheets, so they wore a chest
   * and were shaped like a solid cube -- which also walled off all six of
   * their neighbours. A suffix rather than eight more exact names, and it
   * catches `ender_chest` and `trapped_chest` on the way past, which have the
   * same shape and only differ in which sheet they wear.
   */
  ["_chest", chest],
  ["_banner", (e) => againstWall(e, 2)],
  // Order matters: a wall hanging sign ends in `_hanging_sign` too, and a wall
  // sign ends in `_sign`.
  ["_wall_hanging_sign", hangingSign],
  ["_hanging_sign", hangingSign],
  ["_wall_sign", wallSign],
  ["_sign", standingSign],
  ["_torch", torchShape],
  ["_rail", () => boxes([0, 0, 0, 16, 1, 16])],
  ["_candle", () => boxes([7, 0, 7, 9, 6, 9])],
  ["_sapling", () => ({ kind: "cross" })],
  /*
   * `_chain` covers the rename and everything that came with it: `chain` became
   * `iron_chain` in 1.21.9, and the copper golem update added a copper chain in
   * each of the four oxidation stages plus their waxed mirrors. Eighteen ids,
   * one entry, and the bare `chain` still reaches it through EXACT_SHAPES.
   */
  ["_chain", chain],
  /*
   * `_bars` and `_lantern` are families now, not one block each: the copper
   * golem update added bars and a lantern in four oxidation stages plus their
   * waxed mirrors, twenty ids that all arrived as full opaque cubes.
   *
   * `_lantern` has two exceptions and they are both real blocks that really are
   * cubes -- `sea_lantern` and `jack_o_lantern` end in the same six letters and
   * are nothing to do with lanterns. Matching by suffix without checking would
   * have turned two solid blocks into hanging lamps.
   */
  ["_bars", pane],
  [
    "_lantern",
    (e) => {
      const name = baseName(e);
      return name === "sea_lantern" || name === "jack_o_lantern" ? CUBE : lantern(e);
    },
  ],
  // A shelf against the wall, opening away from it.
  ["_shelf", shelf],
  /*
   * Coral. The *blocks* are cubes and stay cubes -- `_coral_block` does not end
   * in `_coral` -- while the plants are crosses and the fans lie flat, wall fans
   * against whatever they grew on. As cubes all thirty of them were solid
   * lumps that deleted the seabed they stood on.
   */
  ["_coral_wall_fan", (e) => againstWall(e, 1)],
  ["_coral_fan", () => boxes([0, 0, 0, 16, 1, 16])],
  ["_coral", () => ({ kind: "cross" })],
  // A head or a skull sits in the middle of its cell; a wall one hangs on the
  // face opposite the one it looks out of.
  ["_wall_head", (e) => transform([[4, 4, 8, 12, 12, 16]], facingSteps(e) + 2, false)],
  ["_wall_skull", (e) => transform([[4, 4, 8, 12, 12, 16]], facingSteps(e) + 2, false)],
  ["_head", () => boxes([4, 0, 4, 12, 8, 12])],
  ["_skull", () => boxes([4, 0, 4, 12, 8, 12])],
  // A cake with a candle on it: the cake, and the candle standing on top.
  ["_candle_cake", () => boxes([1, 0, 1, 15, 8, 15], [7, 8, 7, 9, 14, 9])],
  // A cauldron with something in it is the same iron pot.
  ["_cauldron", () => boxes([0, 0, 0, 16, 16, 16])],
  // The copper golem, stood still. A statue is not a cube and drawing it as one
  // walled off whatever it was standing next to.
  ["_golem_statue", (e) => transform([[4, 0, 4, 12, 14, 12]], facingSteps(e), false)],
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
  {
    box: [5, 0, 5, 6, 6, 11],
    texture: "flower_pot",
    uv: {
      down: [5, 5, 6, 11],
      up: [5, 5, 6, 11],
      north: [10, 10, 11, 16],
      south: [5, 10, 6, 16],
      west: [5, 10, 11, 16],
      east: [5, 10, 11, 16],
    },
  },
  {
    box: [10, 0, 5, 11, 6, 11],
    texture: "flower_pot",
    uv: {
      down: [10, 5, 11, 11],
      up: [10, 5, 11, 11],
      north: [5, 10, 6, 16],
      south: [10, 10, 11, 16],
      west: [5, 10, 11, 16],
      east: [5, 10, 11, 16],
    },
  },
  {
    box: [6, 0, 5, 10, 6, 6],
    texture: "flower_pot",
    uv: { down: [6, 10, 10, 11], up: [6, 5, 10, 6], north: [6, 10, 10, 16], south: [6, 10, 10, 16] },
    // The two ends butt against the tall staves either side of them.
    omit: ["west", "east"],
  },
  {
    box: [6, 0, 10, 10, 6, 11],
    texture: "flower_pot",
    uv: { down: [6, 5, 10, 6], up: [6, 10, 10, 11], north: [6, 10, 10, 16], south: [6, 10, 10, 16] },
    omit: ["west", "east"],
  },
  {
    // The soil. Its underside is the pot's floor and wears the pot; its four
    // sides are inside the pot's walls, which is where vanilla leaves them out
    // and where drawing them would z-fight with the staves.
    box: [6, 0, 6, 10, 4, 10],
    texture: "flower_pot",
    textures: { up: "dirt" },
    uv: { down: [6, 12, 10, 16], up: [6, 6, 10, 10] },
    omit: ["north", "south", "west", "east"],
  },
];

/**
 * The plant in the pot: two crossed planes, from `flower_pot_cross.json`.
 *
 * They are **4 to 16**, and they were 6 to 22 — six units above the block, on a
 * plane whose derived UVs then ran from `v = 0.625` to `v = -0.375`. Past the
 * edge of the tile the atlas clamps, so the top third of every potted flower in
 * the game was the top row of its own texture smeared upwards: a stem that
 * grows out of the block and fades into a stripe.
 *
 * The window is vanilla's `[0, 0, 16, 16]` and has to be stated, because the
 * plane is 12 units tall and the plant's picture fills its whole tile —
 * coordinate-derived UVs would show the top three quarters of it.
 */
const POT_PLANT_UV: Readonly<Record<string, UvWindow>> = {
  north: [0, 0, 16, 16],
  south: [0, 0, 16, 16],
  west: [0, 0, 16, 16],
  east: [0, 0, 16, 16],
};

function pottedPlant(): BlockShape {
  const spin: BoxRotation = { origin: [8, 8, 8], axis: "y", angle: 45 };
  return boxes(
    ...FLOWER_POT,
    // Vanilla writes these 2.6..13.4 with `rescale: true`, which grows the
    // rotated plane back out to the block's diagonal. There is no rescale
    // here, so the plane is written at its rescaled width instead: 0..16
    // turned 45 degrees reaches 8 +/- 8/sqrt(2), which is what `kind: "cross"`
    // already builds and what vanilla's rescale arrives at.
    { box: [0, 4, 8, 16, 16, 8], rotation: spin, uv: POT_PLANT_UV },
    { box: [8, 4, 0, 8, 16, 16], rotation: spin, uv: POT_PLANT_UV },
  );
}

/**
 * A brewing stand: the rod and its three-lobed base, from `brewing_stand.json`.
 *
 * The base plates carry explicit UVs because `brewing_stand_base.png` is a
 * *plan view* of all three lobes at once -- the box coordinates would pick a
 * different lobe for each plate, and one of them a corner of nothing.
 */
function brewingStand(): BlockShape {
  const base = (box: Box, uv: UvWindow): ShapeBox => ({
    box,
    texture: "brewing_stand_base",
    uv: { up: uv, down: uv },
  });
  return boxes(
    { box: [7, 0, 7, 9, 14, 9] },
    base([9, 0, 5, 15, 2, 11], [9, 5, 15, 11]),
    base([1, 0, 1, 7, 2, 7], [1, 1, 7, 7]),
    base([1, 0, 9, 7, 2, 15], [1, 9, 7, 15]),
  );
}

/**
 * A grindstone: the wheel between two legs, on two pivots.
 *
 * It was the wheel alone -- one box, floating -- which is the half of the model
 * that does not tell you what the block is. The legs take `dark_oak_log`
 * whatever the pack, exactly as vanilla's model does.
 *
 * ## The wheel has two textures and used to wear one
 *
 * `#round` is the wheel seen face-on -- the circular stone -- and `#side` is
 * its rim. Drawing the whole wheel in `#side` is what turned the one part of
 * the block anybody recognises into a blank slab, and it is the same class of
 * fault as the anvil's: a block whose model names three textures cannot be
 * served by a function that guesses one from its name.
 *
 * ## Authored facing north
 *
 * `face=floor,facing=north` carries no rotation in the blockstate, so this is
 * `northFacingSteps` and was `facingSteps` -- a quarter-turn out, which on a
 * symmetric shape is invisible and on this one puts the wheel across the run.
 * `face=wall` and `face=ceiling` also carry an `x` rotation, which this file
 * has no way to express; those two still draw as a floor grindstone.
 *
 * Every window below is vanilla's, and so is every omission: the legs have no
 * top (the pivot sits on it) and each pivot has no face toward the wheel.
 */
const GRINDSTONE_PARTS: readonly ShapeBox[] = [
  {
    box: [12, 0, 6, 14, 7, 10],
    texture: "dark_oak_log",
    uv: {
      north: [2, 9, 4, 16],
      east: [10, 16, 6, 9],
      south: [12, 9, 14, 16],
      west: [6, 9, 10, 16],
      down: [12, 6, 14, 10],
    },
    omit: ["up"],
  },
  {
    box: [2, 0, 6, 4, 7, 10],
    texture: "dark_oak_log",
    uv: {
      north: [12, 9, 14, 16],
      east: [10, 16, 6, 9],
      south: [2, 9, 4, 16],
      west: [6, 9, 10, 16],
      down: [2, 6, 4, 10],
    },
    omit: ["up"],
  },
  {
    box: [12, 7, 5, 14, 13, 11],
    texture: "grindstone_pivot",
    uv: {
      north: [6, 0, 8, 6],
      east: [0, 0, 6, 6],
      south: [6, 0, 8, 6],
      up: [8, 0, 10, 6],
      down: [8, 0, 10, 6],
    },
    omit: ["west"],
  },
  {
    box: [2, 7, 5, 4, 13, 11],
    texture: "grindstone_pivot",
    uv: {
      north: [6, 0, 8, 6],
      south: [6, 0, 8, 6],
      west: [0, 0, 6, 6],
      up: [8, 0, 10, 6],
      down: [8, 0, 10, 6],
    },
    omit: ["east"],
  },
  {
    box: [4, 4, 2, 12, 16, 14],
    textures: {
      north: "grindstone_round",
      south: "grindstone_round",
      east: "grindstone_side",
      west: "grindstone_side",
      up: "grindstone_round",
      down: "grindstone_round",
    },
    uv: {
      north: [0, 0, 8, 12],
      south: [0, 0, 8, 12],
      east: [0, 0, 12, 12],
      west: [0, 0, 12, 12],
      up: [0, 0, 8, 12],
      down: [0, 0, 8, 12],
    },
  },
];

function grindstone(entry: PaletteEntry): BlockShape {
  return transform(GRINDSTONE_PARTS, northFacingSteps(entry), false);
}

/**
 * An anvil, from `template_anvil.json`: a wide foot, a waist, and the block on
 * top that the hammer lands on.
 *
 * Authored **facing south** -- its blockstate gives `facing=south` no rotation,
 * which is worth reading off the file rather than guessing, because the anvil
 * is not symmetric and a quarter-turn puts its long axis across the run.
 *
 * ## Two textures, and one of them is the whole point of the block
 *
 * `#body` is `block/anvil` on every face but one, and `#top` -- `anvil_top`,
 * `chipped_anvil_top`, `damaged_anvil_top` -- is the face the hammer lands on.
 * **That face is the only difference between the three anvils**, so a block
 * that does not state it draws all three identically.
 *
 * Naming them here rather than leaving it to `cubeFaceTextures` is not a
 * refinement, it is the fix. That function guesses from the block's name, and
 * `chipped_anvil` has exactly one texture in the pack: `chipped_anvil_top`. So
 * it answered that for all six faces and a chipped anvil came out as a solid
 * shape wearing the picture of its own dented top, base included.
 *
 * ## Its windows are the model's, and they are rotated
 *
 * `anvil.png` is a *sheet* rather than a full-block tile -- the foot's band,
 * the waist and the block are cut from different parts of it -- so the windows
 * are transcribed, and several carry vanilla's `rotation`: the west face of the
 * foot is a 4-wide, 12-tall window laid onto a face 12 wide and 4 tall. The
 * reversed pairs (`east: [4, 2, 0, 14]`) are vanilla mirroring a face, which
 * `windowUvsFrom` reproduces by doing no ordering check.
 *
 * Faces vanilla omits are omitted: the waist has no top or bottom and the
 * step above it no bottom, because in each case the next box covers it.
 */
const ANVIL_PARTS: readonly ShapeBox[] = [
  {
    box: [2, 0, 2, 14, 4, 14],
    uv: {
      down: [2, 2, 14, 14],
      up: [2, 2, 14, 14],
      north: [2, 12, 14, 16],
      south: [2, 12, 14, 16],
      west: [0, 2, 4, 14],
      east: [4, 2, 0, 14],
    },
    uvRotation: { down: 180, up: 180, west: 90, east: 270 },
  },
  {
    box: [4, 4, 3, 12, 5, 13],
    uv: {
      up: [4, 3, 12, 13],
      north: [4, 11, 12, 12],
      south: [4, 11, 12, 12],
      west: [4, 3, 5, 13],
      east: [5, 3, 4, 13],
    },
    uvRotation: { up: 180, west: 90, east: 270 },
    omit: ["down"],
  },
  {
    box: [6, 5, 4, 10, 10, 12],
    uv: {
      north: [6, 6, 10, 11],
      south: [6, 6, 10, 11],
      west: [5, 4, 10, 12],
      east: [10, 4, 5, 12],
    },
    uvRotation: { west: 90, east: 270 },
    omit: ["up", "down"],
  },
  {
    box: [3, 10, 0, 13, 16, 16],
    uv: {
      down: [3, 0, 13, 16],
      up: [3, 0, 13, 16],
      north: [3, 0, 13, 6],
      south: [3, 0, 13, 6],
      west: [10, 0, 16, 16],
      east: [16, 0, 10, 16],
    },
    uvRotation: { down: 180, up: 180, west: 90, east: 270 },
  },
];

function anvil(entry: PaletteEntry): BlockShape {
  const name = entry.namespacedName.slice(entry.namespacedName.indexOf(":") + 1);
  const parts = ANVIL_PARTS.map((part, index) => ({
    ...part,
    texture: "anvil",
    // Only the last box has a top face anyone sees, and it is the one that
    // says which of the three anvils this is.
    textures: index === ANVIL_PARTS.length - 1 ? { up: `${name}_top` } : undefined,
  }));
  return transform(parts, southFacingSteps(entry), false);
}

/**
 * A shelf: the back panel against the wall, with a lip top and bottom.
 *
 * `template_shelf_body.json` puts the panel at z 13..16, so the model is
 * authored with its opening facing **north**.
 *
 * ## Its UVs are the model's, and they have to be
 *
 * `oak_shelf.png` is a *sheet* -- 128x128 where an ordinary block texture is
 * 64x64 -- with the panel, the lips and their ends laid out in separate
 * regions. UVs derived from box coordinates address none of them, which is the
 * lantern and chain failure a third time: the block was the right shape wearing
 * pieces of itself from the wrong places.
 *
 * Several windows are **reversed** (`up: [16, 5, 8, 3.5]` has both u and v
 * descending). That is vanilla mirroring a face, and `windowUvsFrom` carries it
 * through unchanged because it does no ordering check.
 *
 * The `omit` lists are vanilla's too: the model simply has no `north` face on
 * the panel and no `south` on either lip, because each is covered by what sits
 * against it.
 */
const SHELF_PARTS: readonly ShapeBox[] = [
  {
    box: [0, 0, 13, 16, 16, 16],
    uv: {
      east: [8, 0, 9.5, 8],
      south: [8, 0, 16, 8],
      west: [14.5, 0, 16, 8],
      up: [16, 5, 8, 3.5],
      down: [16, 6, 8, 4.5],
    },
    omit: ["north"],
  },
  {
    box: [0, 0, 11, 16, 4, 13],
    uv: {
      north: [0, 6, 8, 8],
      east: [1.5, 6, 2.5, 8],
      west: [5.5, 6, 6.5, 8],
      up: [8, 3.5, 16, 4.5],
      down: [16, 4.5, 8, 3.5],
    },
    omit: ["south"],
  },
  {
    box: [0, 12, 11, 16, 16, 13],
    uv: {
      north: [0, 0, 8, 2],
      east: [1.5, 0, 2.5, 2],
      west: [5.5, 0, 6.5, 2],
      up: [16, 6, 8, 5],
      down: [8, 5, 16, 6],
    },
    omit: ["south"],
  },
];

function shelf(entry: PaletteEntry): BlockShape {
  return transform(SHELF_PARTS, northFacingSteps(entry), false);
}

/**
 * Azalea: a hollow shell of leaves with the bush hanging inside it.
 *
 * Drawn as a solid cube it lost the whole lower half of the block -- the report
 * was "only the top with the leaves, no bottom", and that is exactly right:
 * vanilla's `template_azalea` is a lid at y=16, four paper-thin walls from y=5
 * up, and a cross of `azalea_plant` filling the space under them. The cross is
 * the part a cube cannot express at all.
 */
function azalea(entry: PaletteEntry): BlockShape {
  const plant = baseName(entry) === "flowering_azalea" ? "flowering_azalea_top" : "azalea_plant";
  const tilt: BoxRotation = { origin: [8, 8, 8], axis: "y", angle: 45 };
  return boxes(
    { box: [0, 16, 0, 16, 16, 16] },
    { box: [0, 5, 0, 16, 16, 0.01] },
    { box: [0, 5, 15.99, 16, 16, 16] },
    { box: [0, 5, 0, 0.01, 16, 16] },
    { box: [15.99, 5, 0, 16, 16, 16] },
    { box: [0.1, 0, 8, 15.9, 15.9, 8], rotation: tilt, texture: plant },
    { box: [8, 0, 0.1, 8, 15.9, 15.9], rotation: tilt, texture: plant },
  );
}

/**
 * A flowerbed — pink petals, wildflowers, leaf litter: one quarter-plate per
 * segment, scattered across the floor of the cell.
 *
 * It was a full 16x16 plate at `y = 0` whatever the count, which is wrong twice
 * over. One petal covered the whole cell, so `flower_amount` did nothing and
 * `leaf_litter[segment_amount=1]` looked exactly like a carpet of it. And a
 * plate that spans the square *at* `y = 0` **covers the face below it**, so the
 * grass it was scattered on lost its top face and the transparent half of the
 * petals became a hole through the floor — which is what was reported.
 *
 * Vanilla's `flowerbed_1..4` are a multipart: `flower_amount=3` applies models
 * 1, 2 and 3, one 8x8 plate each, and they sit at four different heights so a
 * patch does not read as a grid. The heights are transcribed rather than
 * levelled -- they are what makes it look scattered. The blockstate turns the
 * whole thing by `facing`, north unrotated.
 *
 * The stems in those models are not here: each is a one-pixel sliver rotated
 * about the cell's *corner*, and a row of them is a smaller thing than the
 * plates by any measure. Their absence is a plant with no visible stalk, which
 * is what the block looked like before this anyway.
 */
const FLOWERBED_PLATES: readonly Box[] = [
  [0, 2.99, 0, 8, 2.99, 8],
  [0, 1, 8, 8, 1, 16],
  [8, 2, 8, 16, 2, 16],
  [8, 2, 0, 16, 2, 8],
];

function flowerbed(entry: PaletteEntry): BlockShape {
  const stated = entry.properties.flower_amount ?? entry.properties.segment_amount ?? "1";
  const parsed = Number(stated);
  const count = Number.isFinite(parsed) ? Math.min(4, Math.max(1, Math.round(parsed))) : 1;
  return transform(FLOWERBED_PLATES.slice(0, count), northFacingSteps(entry), false);
}

/**
 * A vine: one flat sheet per face it clings to.
 *
 * It was a cross, which is the shape of a *plant standing in a cell* and not of
 * something growing on a wall -- a curtain of vines down a cliff came out as a
 * row of little shrubs floating a half-block off it. Vanilla draws one plane
 * per connected side, and now that `block_connections.ts` derives those sides
 * this can too.
 *
 * A vine with nothing to cling to keeps the cross. That is the state a vine
 * arrives in when it is placed with no rule having run yet, and an empty shape
 * would make it vanish.
 */
function vine(entry: PaletteEntry): BlockShape {
  const list: ShapeBox[] = [];
  for (const [direction, box] of [
    ["north", [0, 0, 0.05, 16, 16, 0.05]],
    ["south", [0, 0, 15.95, 16, 16, 15.95]],
    ["west", [0.05, 0, 0, 0.05, 16, 16]],
    ["east", [15.95, 0, 0, 15.95, 16, 16]],
    ["up", [0, 15.95, 0, 16, 15.95, 16]],
  ] as const) {
    if (entry.properties[direction] === "true") {
      list.push({ box: box as unknown as Box });
    }
  }
  return list.length === 0 ? { kind: "cross" } : boxes(...list);
}

/**
 * Signs: a board, and whatever holds it up.
 *
 * All three kinds were `againstWall(e, 2)` -- a full-height slab flat against
 * one side of the cell. That is roughly right for a *wall* sign and plainly
 * wrong for the other two: a standing sign stands on a post in the middle of
 * its cell, and a hanging one hangs from a bar. Both were pressed against a
 * wall that is often not there.
 *
 * ## Their UVs are derived, and that is a stated limit rather than an oversight
 *
 * Vanilla ships **no model** for a sign -- 1.21.9 moved the texture into
 * `block/` but the geometry still comes from a block-entity renderer -- so
 * there is no `uv` to transcribe, and `oak_sign.png` is a 128x128 sheet whose
 * layout does not match any unwrap this file could derive with confidence.
 * Guessing at it is what produced two rounds of chests with their fronts on
 * their backs, so it is not guessed at: the boxes take coordinate-derived UVs
 * and a sign reads as the plank it is cut from.
 *
 * The shape is the half that was visibly wrong, and it is the half that can be
 * fixed without inventing anything.
 */
/**
 * The sign sheets are **32 wide**, and their parts are unwrapped on them.
 *
 * The comment above used to say the layout "does not match any unwrap this
 * file could derive with confidence", and the reason it did not was arithmetic:
 * `unwrapCube` assumed a 64-wide sheet, so every window it produced on a 32-wide
 * one covered a quarter of what it named. Told the width, it lands.
 *
 * The hanging sign's board settles it, because four independent numbers agree
 * with one box. `oak_hanging_sign.png` has exactly one 14-wide patch at
 * `(2, 14)-(16, 16)` and one 32-wide band at `(0, 16)-(32, 26)`, and
 * `unwrapCube(0, 14, 14, 10, 2)` puts `down` at `(2, 14)` 14 wide, and the four
 * sides in a band `2 * (14 + 2) = 32` wide and `dy = 10` tall. Nothing was
 * chosen to make that come out; it is where the paint is.
 *
 * The standing sign's board is the same reasoning with one number left over:
 * its side band is 26 wide, which is `2 * (11 + 2)`, and its cap band is two
 * rows tall, which is `dz = 2` — but the caps run from 0 rather than from
 * `dz`, and 24 columns rather than 22. So `dx = 11` is what the band widths
 * say and the two extra columns are unexplained. It is stated here rather than
 * smoothed over: the board lands in the plank field either way, and the
 * difference between this and a neighbouring fit is a column.
 *
 * The bar, the post and the chains are approximations of a different kind:
 * a window over the right *material* rather than a transcription of the right
 * part. Before them the chains sampled whatever a box's coordinates happened
 * to point at, which for one of the two was the plank field — a wooden chain
 * beside a metal one, on the same sign.
 */
const SIGN_SHEET = 32;
const SIGN_BOARD = unwrapCube(0, 0, 11, 12, 2, SIGN_SHEET);
const SIGN_POST = unwrapCube(28, 0, 1, 13, 1, SIGN_SHEET);
const HANGING_BOARD = unwrapCube(0, 14, 14, 10, 2, SIGN_SHEET);
const HANGING_BAR = unwrapCube(0, 0, 8, 2, 4, SIGN_SHEET);

/** A window on the sheet, in its own texels, for the sides of a box. */
function sheetWindow(x: number, y: number, w: number, h: number): UvWindow {
  const scale = 16 / SIGN_SHEET;
  // v descends, exactly as `unwrapCube`'s side strips do: the sheet's first
  // row is the box's bottom edge.
  return [x * scale, (y + h) * scale, (x + w) * scale, y * scale];
}

/**
 * The chain links, from the metal art in the sheet's top-right corner.
 *
 * Two 2x4 sticks against a 5x6 patch of chain: not the transcription the board
 * gets, but the right material on the right part, which is the whole of what
 * was wrong.
 */
const HANGING_CHAIN: Readonly<Record<string, UvWindow>> = {
  north: sheetWindow(21, 7, 5, 6),
  south: sheetWindow(21, 7, 5, 6),
  east: sheetWindow(21, 7, 5, 6),
  west: sheetWindow(21, 7, 5, 6),
};

function standingSign(entry: PaletteEntry): BlockShape {
  // `rotation` is 0..15 around the compass; the boards are square in plan, so
  // the sixteenth-turns land on the nearest quarter.
  const sixteenths = Number(entry.properties.rotation ?? "0");
  const steps = Number.isFinite(sixteenths) ? Math.round(sixteenths / 4) : 0;
  return transform(
    [
      { box: [0, 9, 7, 16, 16, 9], uv: SIGN_BOARD },
      { box: [7, 0, 7, 9, 9, 9], uv: SIGN_POST, omit: ["up"] },
    ],
    steps,
    false,
  );
}

/** A board flat on the wall, at the height a sign sits rather than floor to ceiling. */
function wallSign(entry: PaletteEntry): BlockShape {
  return transform(
    [{ box: [0, 4, 14, 16, 12, 16], uv: SIGN_BOARD }],
    facingSteps(entry) + 2,
    false,
  );
}

/** A board on a bar, hanging clear of whatever is above it. */
function hangingSign(entry: PaletteEntry): BlockShape {
  const attached = entry.properties.attached === "true";
  const parts: ShapeBox[] = [
    // The board.
    { box: [1, 0, 7, 15, 10, 9], uv: HANGING_BOARD },
    // The bar it hangs from, and the two chains, or the one plate that
    // replaces them when it is bolted straight to the block above.
    { box: [1, 14, 6, 15, 16, 10], uv: HANGING_BAR },
  ];
  if (!attached) {
    parts.push(
      { box: [3, 10, 7.5, 5, 14, 8.5], uv: HANGING_CHAIN },
      { box: [11, 10, 7.5, 13, 14, 8.5], uv: HANGING_CHAIN },
    );
  }
  const sixteenths = Number(entry.properties.rotation ?? "0");
  const steps = Number.isFinite(sixteenths) ? Math.round(sixteenths / 4) : 0;
  return transform(parts, steps, false);
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
   * `light` is one of them now, and used to be the exception. The argument for
   * leaving it out was that it has no in-game appearance to reproduce -- which
   * is true and beside the point, because neither does a barrier. A light block
   * is placed deliberately, at a level somebody chose, and a build lit by a
   * dozen of them looked exactly like a build lit by nothing. What it wears is
   * the icon the game shows you in your hand, and vanilla ships **sixteen** of
   * those, one per level, each with its number drawn on it -- so the level is
   * legible on every face without this code drawing a single glyph.
   */
  barrier: () => CUBE,
  structure_void: () => CUBE,
  light: () => CUBE,

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
  grindstone,
  brewing_stand: brewingStand,
  anvil,
  chipped_anvil: anvil,
  damaged_anvil: anvil,
  azalea,
  flowering_azalea: azalea,
  vine,
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
   * A flowerbed: petals lying on the ground, like a carpet with a stem.
   *
   * Vanilla varies the number of petals with `flower_amount`; one flat plate is
   * the shape that matters, because as a full cube it was a solid pink block
   * that also deleted the grass underneath it.
   */
  pink_petals: flowerbed,
  wildflowers: flowerbed,
  leaf_litter: flowerbed,

  // The nether's dripstone: same silhouette, same reasoning as its overworld
  // twin -- a narrow column is the reach a neighbour needs to know about.
  sulfur_spike: () => boxes([5, 0, 5, 11, 16, 11]),

  /*
   * The rest of the blocks the registry brought in that a cube gets wrong.
   *
   * A cube here is not merely the wrong silhouette: it culls, so each of these
   * was deleting a face from all six of its neighbours. A crop stem across a
   * field took the field with it.
   */
  candle_cake: () => boxes([1, 0, 1, 15, 8, 15], [7, 8, 7, 9, 14, 9]),
  dragon_egg: () => boxes([1, 0, 1, 15, 16, 15]),
  turtle_egg: () => boxes([5, 0, 5, 11, 7, 11]),
  chorus_flower: () => boxes([2, 2, 2, 14, 14, 14]),
  big_dripleaf: () => boxes([0, 11, 0, 16, 15, 16]),
  big_dripleaf_stem: () => boxes([5, 0, 5, 11, 16, 11]),

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
  /*
   * The two bare pre-Flattening names. `SUFFIX_SHAPES` keys `_sign` and
   * `_wall_sign`, and neither matches a name that *is* those words -- so
   * `wall_sign` fell through to the standing shape and stood a board on a post
   * in mid-air where a wall sign belongs flat on the wall.
   */
  sign: standingSign,
  wall_sign: wallSign,
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
  /*
   * Hanging and standing plants that were full opaque cubes. `cave_vines` is
   * vanilla's `block/cross` verbatim; `firefly_bush` and the dry grasses came
   * with the registry and had never been drawn at all.
   */
  "cave_vines",
  "cave_vines_plant",
  "firefly_bush",
  "bush",
  "short_dry_grass",
  "tall_dry_grass",
  "open_eyeblossom",
  "closed_eyeblossom",
  "cactus_flower",
  "golden_dandelion",
  "pale_hanging_moss",
  "resin_clump",
  /*
   * Crops and fungi that arrived with the registry. `_stem` is emphatically not
   * a suffix rule here -- `crimson_stem` is a log and a full cube -- so the two
   * crop stems and their attached forms are named one at a time.
   */
  "crimson_fungus",
  "warped_fungus",
  "mangrove_propagule",
  "hanging_roots",
  "small_dripleaf",
  "melon_stem",
  "pumpkin_stem",
  "attached_melon_stem",
  "attached_pumpkin_stem",
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

/** The six sides of a cell, as the mesher names them. */
export type CellFace = "north" | "south" | "east" | "west" | "up" | "down";

const FACE_AXIS: Readonly<Record<CellFace, 0 | 1 | 2>> = {
  west: 0,
  east: 0,
  down: 1,
  up: 1,
  north: 2,
  south: 2,
};

/** Whether the face sits at the cell's 0 edge rather than its 16 edge. */
const FACE_AT_MIN: Readonly<Record<CellFace, boolean>> = {
  west: true,
  east: false,
  down: true,
  up: false,
  north: true,
  south: false,
};

/**
 * Whether this block's geometry fills one side of its cell, edge to edge.
 *
 * The question the mesher actually needs, and it is not the one
 * `occludesNeighbours` answers. That one asks "is this a solid block", which is
 * right for lighting and too blunt for culling: a slab covers the cell below it
 * completely and the cell beside it not at all, and a shelf's back panel covers
 * the wall it is hung on.
 *
 * A rotated box is refused outright. A tilted plane can pass through a face
 * without covering it, and the arithmetic that would tell the two apart is
 * worth less than the one block it would win -- nothing in this file tilts a
 * box that also reaches a boundary.
 */
export function coversFace(entry: PaletteEntry, face: CellFace): boolean {
  const shape = shapeFor(entry);
  if (shape.kind === "cube") return true;
  if (shape.kind !== "boxes") return false;

  const axis = FACE_AXIS[face];
  const atMin = FACE_AT_MIN[face];
  const others: Array<0 | 1 | 2> = [0, 1, 2].filter((a) => a !== axis) as Array<0 | 1 | 2>;

  return shape.boxes.some(({ box, rotation }) => {
    if (rotation !== undefined) return false;
    // The box has to touch the boundary this face sits on...
    if (atMin ? box[axis] > 0 : box[axis + 3] < 16) return false;
    // ...and span the whole square on the other two axes.
    return others.every((a) => box[a] <= 0 && box[a + 3] >= 16);
  });
}

/**
 * Whether this block hides the neighbour's face on the given side.
 *
 * `coversFace` plus opacity: glass covers every side of its cell and hides
 * nothing behind it. The see-through list is the same one `occludesNeighbours`
 * consults, which is what keeps the two answers from drifting apart.
 */
export function occludesFace(entry: PaletteEntry, face: CellFace): boolean {
  if (paletteEntryIsAir(entry)) return false;
  return coversFace(entry, face) && !isSeeThrough(entry);
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
    name === "light" ||
    name.endsWith("_ice")
  );
}
