/**
 * Which way a placed block ends up pointing.
 *
 * Every block placed by hand until now landed in its default state, which for
 * anything with a direction is a lie the file then carries: a staircase always
 * `facing=north`, a log always `axis=y`, a slab always `bottom`. Building a
 * roof meant placing the stairs and then editing four properties by hand, and
 * building a floor of them meant doing it once per block.
 *
 * The game answers this from two things — where the player is looking, and
 * which face of which block they clicked — and so does this. It is the same
 * rule, transcribed; the point is not to invent a placement policy but to
 * reproduce the one whose muscle memory everyone already has.
 *
 * **This lives in `shared/` because it is a fact about Minecraft, not about a
 * process.** The renderer applies it at the moment of the click, which is the
 * only place the look direction exists; main needs the same answer the day the
 * agent is allowed to place a block the way a person does. Two tables would be
 * two tables to get wrong.
 *
 * ## What it deliberately does not do
 *
 * Only families this file can state with confidence appear below. A block that
 * is not named keeps its default state, which is exactly what happened before —
 * so an omission costs nothing, while a wrong guess writes a block state that
 * is *worse* than the default because it looks deliberate. `observer` and
 * `anvil` are the two that were left out for that reason, not overlooked.
 *
 * Stairs' `shape` is also absent, and that one is structural: a corner is
 * decided by what the *neighbours* are, which is a question about the document
 * and not about the click. It belongs to whoever holds the voxels.
 */

import { defaultStateFor, hasProperty } from "./block_states.js";

/** A face of a cell, named as Minecraft names its directions. */
export type Face = "up" | "down" | "north" | "south" | "east" | "west";

/** The four a `facing` property can take when it is horizontal-only. */
export type HorizontalFacing = "north" | "south" | "east" | "west";

/** Where the camera was, and what it was pointing at, when the click landed. */
export interface PlacementLook {
  /**
   * The direction the camera is looking, in the schematic's own axes — which
   * are Minecraft's: north is -Z, south +Z, east +X, west -X.
   */
  readonly direction: { readonly x: number; readonly y: number; readonly z: number };
  /**
   * The face the new block is placed against: `"up"` when it lands on top of
   * something (or on the build grid, which is a floor), `"down"` under a
   * ceiling, a compass point when it is stuck to a side.
   *
   * `null` when there is no such face and the answer has to come from the look
   * direction alone.
   */
  readonly against: Face | null;
  /**
   * How far up the target cell the cursor was, 0 at its floor and 1 at its
   * ceiling. Only consulted for a side face, where it is what separates a
   * top-half slab from a bottom-half one.
   */
  readonly cursorY: number;
}

/**
 * Which way a face points, as a unit vector in the schematic's own axes.
 *
 * The convention is stated in prose a few lines above and was, until this
 * table, stated only in prose: north is -Z, south +Z, east +X, west -X.
 * `main/domain/connect.ts` kept the same six numbers as its own neighbour
 * offsets, which is two places deciding where north is -- and a viewport
 * compass that disagreed with the writers by a quarter turn would be
 * invisible until somebody pasted a build into a world and found it facing
 * the wrong way.
 *
 * `horizontalFacing` below is the inverse for the four horizontal ones, so
 * `tests/blocks.ts` can require the pair to round-trip.
 */
export const FACE_VECTOR: Record<Face, { x: number; y: number; z: number }> = {
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
};

/** The axis a face lies along, which is the axis a pillar placed on it runs. */
const FACE_AXIS: Record<Face, "x" | "y" | "z"> = {
  up: "y",
  down: "y",
  north: "z",
  south: "z",
  east: "x",
  west: "x",
};

const OPPOSITE: Record<Face, Face> = {
  up: "down",
  down: "up",
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

/**
 * Pillars: `axis` comes from the face, never from the look direction.
 *
 * `_stem` is deliberately not a suffix here. `crimson_stem` is a pillar and
 * `melon_stem` is a crop with an `age`, and writing `axis` onto the crop would
 * produce a block state that does not exist.
 */
const AXIS_SUFFIXES = ["_log", "_wood", "_hyphae"] as const;

const AXIS_NAMES: ReadonlySet<string> = new Set([
  "crimson_stem",
  "stripped_crimson_stem",
  "warped_stem",
  "stripped_warped_stem",
  "bone_block",
  "hay_block",
  "purpur_pillar",
  "quartz_pillar",
  "basalt",
  "polished_basalt",
  "deepslate",
  "infested_deepslate",
  "muddy_mangrove_roots",
  "ochre_froglight",
  "verdant_froglight",
  "pearlescent_froglight",
  "chain",
  "bamboo_block",
  "stripped_bamboo_block",
]);

/**
 * Blocks whose front turns to face the player — the reason a freshly placed
 * dispenser shoots at you rather than away.
 *
 * Horizontal only: looking at your feet and placing a furnace still gives a
 * furnace facing one of the four compass points.
 */
const FRONT_TO_PLAYER: ReadonlySet<string> = new Set([
  "furnace",
  "blast_furnace",
  "smoker",
  "chest",
  "trapped_chest",
  "ender_chest",
  "carved_pumpkin",
  "jack_o_lantern",
  "beehive",
  "bee_nest",
  "loom",
  "stonecutter",
  "lectern",
  "campfire",
  "soul_campfire",
  "end_portal_frame",
]);

/** The same, for the ones whose `facing` also takes `up` and `down`. */
const FRONT_TO_PLAYER_ANY_AXIS: ReadonlySet<string> = new Set([
  "dispenser",
  "dropper",
  "barrel",
]);

/**
 * Blocks that point **into** the block they were clicked onto.
 *
 * A hopper is the whole family, and it is the one everybody notices: you put
 * one against the side of a chest so that it feeds the chest, and the spout
 * has to end up pointing at it. `facing` is the clicked face reversed, with
 * one exception the game states outright -- there is no upward-facing hopper,
 * so a click on a floor gives `down` rather than `up`.
 *
 * Absent from every table until now, so every hopper ever placed here landed
 * on the registry default `down` and its spout hung in mid-air beside whatever
 * it was meant to feed.
 */
const POINTS_INTO_CLICKED: ReadonlySet<string> = new Set(["hopper"]);

/**
 * The one block carrying a sixteenth-turn `rotation` that the registry cannot
 * be asked about.
 *
 * **Everything else asks the registry.** `hasProperty(name, "rotation")` is
 * `isOpenable`'s move one file over, for `isOpenable`'s reason: the blocks
 * that carry the property are twelve standing signs, twelve hanging ones,
 * sixteen banners and seven heads, and a list of families is a list to keep
 * up to date. It was one -- `["_sign", "_hanging_sign"]` -- so **every head
 * and every standing banner** fell through to the end of this function and
 * took the registry default, and no camera was ever consulted for either.
 *
 * Three things fall out of asking the registry instead, and all three look
 * like omissions:
 *
 * - **the wall families exclude themselves.** `oak_wall_sign`,
 *   `white_wall_banner`, `skeleton_wall_skull` and `oak_wall_hanging_sign`
 *   carry a `facing` and no `rotation`, so the rule no longer depends on
 *   being written below `WALL_MOUNTED`, and the wall hanging sign no longer
 *   needs excluding by name. Both of those were real and both are gone.
 * - **`piston_head` excludes itself.** It ends in `_head` and carries no
 *   `rotation`, so a hand-written `_head` suffix -- the obvious way to write
 *   this -- would have put a property on a block that has none. That is the
 *   failure this file exists to avoid, arriving in the fix for another one.
 * - **the pre-Flattening `sign` does not**, and is why this set survives with
 *   one member. It is deliberately outside the modern registry, which holds
 *   the flat era only, while `legacy_blocks.json` enumerates its sixteen
 *   values as `63:0`..`63:15`. `ORIENTED_BLOCK_NAMES` publishes it to the
 *   check that reads every named id back out of `block_id_list.txt`.
 */
const SPUN_LEGACY: ReadonlySet<string> = new Set(["sign"]);

/**
 * Vanilla's own sixteenth of a turn, from the direction the camera was facing.
 *
 * `RotationSegment.convertToSegment(yaw + 180)`, which is
 * `floor(degrees * 16 / 360 + 0.5) & 15`. The `+ 180` is what turns the block
 * round to face the person who placed it, and it is the half that cannot be
 * checked by looking at a screenshot: a sign facing exactly the wrong way still
 * reads as a sign, and the mistake only shows when somebody walks round it.
 * minecraft.wiki states it outright for the two families where it is
 * observable from outside -- a standing sign "face[s] toward the player who
 * placed it", and a head on a **wall** pointedly does not, "but forward".
 *
 * Named for vanilla's class rather than for signs, because signs turned out to
 * be one of four families that reach it and the only one that ever did.
 *
 * Minecraft's yaw is zero at south and increases towards west, which is
 * `atan2(-x, z)` in this app's axes.
 */
export function rotationSegment(direction: {
  readonly x: number;
  readonly z: number;
}): number {
  const yaw = (Math.atan2(-direction.x, direction.z) * 180) / Math.PI;
  return Math.floor(((yaw + 180) * 16) / 360 + 0.5) & 15;
}

/** Blocks that point where you are looking, because that is where they act. */
const AWAY_FROM_PLAYER_ANY_AXIS: ReadonlySet<string> = new Set(["piston", "sticky_piston"]);

/**
 * Blocks that stick to whatever they were clicked onto.
 *
 * `facing` here means "the way it looks out of the wall", which is the face
 * that was clicked. A wall torch on the west face of a block stands in the cell
 * west of it and points west, away from the block holding it up: `facing` and
 * the clicked face are the same word.
 *
 * That is worth saying out loud because it reads backwards. Placing one means
 * *looking at* the wall, so the block ends up pointing back at the camera --
 * "where I am looking" is the one answer that is always wrong here, and it is
 * the natural guess. The two agree on the sign of nothing: look east, click the
 * block's west face, and the torch faces west.
 *
 * Every one of these was landing on `facing=north` whatever the click, which
 * for a torch is a torch bolted to thin air on the wrong side of the cell.
 */
const WALL_MOUNTED: ReadonlySet<string> = new Set([
  "ladder",
  // The two pre-Flattening spellings the app still offers; every other member
  // of both families is caught by the suffixes below.
  "wall_torch",
  "wall_sign",
]);

/**
 * The same rule, by family.
 *
 * `_wall_hanging_sign` is deliberately absent and is the one that would be
 * wrong: it hangs *between* two blocks on the axis across its `facing`, not off
 * the face it was clicked onto, so the clicked face is not its answer. It does
 * not match `_wall_sign` either -- the two are checked by name in
 * `tests/blocks.ts`, because a suffix list is exactly where that would be
 * assumed rather than known.
 */
const WALL_MOUNTED_SUFFIXES = [
  "_wall_torch",
  "_wall_sign",
  "_wall_banner",
  "_wall_fan",
  "_wall_head",
  "_wall_skull",
] as const;

/**
 * Blocks carrying `face` (floor/wall/ceiling) alongside a horizontal `facing`.
 *
 * Worth stating even though `block_shapes.ts` draws a button lying on the
 * floor whatever its `face` says: the schematic is the product, and a button
 * saved as a floor button is wrong in the world it is pasted into, where the
 * renderer's opinion does not travel.
 */
const FACE_AND_FACING: ReadonlySet<string> = new Set(["lever"]);

const FACE_AND_FACING_SUFFIXES = ["_button"] as const;

/** `minecraft:oak_stairs[facing=east]` and `oak_stairs` both come back bare. */
export function baseBlockName(id: string): string {
  const withoutState = id.split("[")[0].trim();
  const colon = withoutState.lastIndexOf(":");
  return colon === -1 ? withoutState : withoutState.slice(colon + 1);
}

/**
 * The compass point a look direction is nearest to.
 *
 * Ties go to the X axis. Exactly 45° has no right answer and a rule that picks
 * one is better than one that depends on a rounding error.
 */
export function horizontalFacing(direction: {
  readonly x: number;
  readonly z: number;
}): HorizontalFacing {
  if (Math.abs(direction.x) >= Math.abs(direction.z)) {
    return direction.x >= 0 ? "east" : "west";
  }
  return direction.z >= 0 ? "south" : "north";
}

/**
 * The face a look direction is nearest to, vertical included — the game's own
 * `Direction.getNearest`, which is the largest component of the vector.
 */
export function nearestFace(direction: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): Face {
  const ay = Math.abs(direction.y);
  if (ay > Math.abs(direction.x) && ay > Math.abs(direction.z)) {
    return direction.y >= 0 ? "up" : "down";
  }
  return horizontalFacing(direction);
}

/**
 * Whether a slab or a staircase placed by this click belongs to the upper half
 * of its cell.
 *
 * Clicking the top of a block puts the new one on its floor and clicking the
 * underside puts it on the ceiling; only a side face is ambiguous, and there
 * the game asks which half of the face was clicked.
 */
export function placedInUpperHalf(look: PlacementLook): boolean {
  if (look.against === "up") return false;
  if (look.against === "down") return true;
  return look.cursorY > 0.5;
}

/**
 * The properties a freshly placed block should carry, given where it was
 * placed from. An empty object for anything with no direction to get wrong.
 *
 * Nothing here overrides: the caller merges these *under* whatever the user
 * spelled out, because `oak_stairs[facing=north]` typed into the block field is
 * an instruction and this is only a default.
 */
export function orientPlacement(id: string, look: PlacementLook): Record<string, string> {
  const name = baseBlockName(id);
  const upper = placedInUpperHalf(look);

  if (AXIS_NAMES.has(name) || AXIS_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    // No face means no answer here: a pillar's axis is a property of the
    // surface it was placed on, and the look direction cannot stand in for it.
    return look.against === null ? {} : { axis: FACE_AXIS[look.against] };
  }

  if (name.endsWith("_stairs")) {
    return { facing: horizontalFacing(look.direction), half: upper ? "top" : "bottom" };
  }

  if (name.endsWith("_slab")) {
    return { type: upper ? "top" : "bottom" };
  }

  if (name.endsWith("_trapdoor")) {
    /*
     * The same two branches as the wall-mounted family below, and that is not
     * a coincidence: a trapdoor's `facing` names the side it swings out over,
     * so vanilla takes it from the clicked face where there is one and from
     * the opposite of the look direction where there is not.
     *
     * This used to answer `half` alone, on the reasoning that a trapdoor's
     * `facing` is decided by the edge it hinges on and that a confidently
     * wrong hinge is worse than the default. The premise is the wrong
     * property: `hinge` is a *door*'s, and a trapdoor has none. What decides
     * `facing` is exactly the two things `PlacementLook` already carries, and
     * both were already written out four arms further down. So every trapdoor
     * ever placed by hand landed on `facing=north` -- the one value that is
     * right a quarter of the time and looks deliberate every time.
     *
     * `half` is untouched. `placedInUpperHalf` is already vanilla's rule for
     * it, on both branches: the floor for a click on a top face, the ceiling
     * for one underneath, and which half of the face was hit otherwise.
     */
    const half = upper ? "top" : "bottom";
    if (look.against !== null && look.against !== "up" && look.against !== "down") {
      return { facing: look.against, half };
    }
    return { facing: OPPOSITE[horizontalFacing(look.direction)], half };
  }

  // A door is walked through in the direction you were looking when you hung
  // it; a gate blocks the way you were walking; a bed's head goes away from
  // you. Three blocks, one rule.
  if (name.endsWith("_door") || name.endsWith("_fence_gate") || name.endsWith("_bed")) {
    return { facing: horizontalFacing(look.direction) };
  }

  if (WALL_MOUNTED.has(name) || WALL_MOUNTED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    /*
     * The clicked face is the answer wherever there is one.
     *
     * Where there is not -- placed on a floor, on a ceiling, or on the build
     * grid -- the wall is taken to be the one the camera was looking at, which
     * puts the block's front back towards the viewer. That is not a second rule:
     * it is the same answer the side click gives, because clicking a block's
     * west face means looking east. It differs only at a glancing angle, where
     * the face that was actually hit wins, as it should.
     *
     * There is no such thing as a wall torch on a floor in the game -- you get
     * a standing `torch` instead -- but the inventory here offers the wall
     * variant by name, so there is no standing block to fall back to and a
     * permanent `facing=north` was the alternative.
     */
    if (look.against !== null && look.against !== "up" && look.against !== "down") {
      return { facing: look.against };
    }
    return { facing: OPPOSITE[horizontalFacing(look.direction)] };
  }

  /*
   * Still below the wall-mounted arm, and no longer *because* of it: the
   * registry keeps every wall variant out of here on its own. It stays here
   * because the three names in that table are the ones with an answer up
   * there, and because moving it would make the order matter again the day a
   * wall-mounted block turns up carrying a `rotation`.
   */
  if (SPUN_LEGACY.has(name) || hasProperty(name, "rotation")) {
    return { rotation: String(rotationSegment(look.direction)) };
  }

  if (POINTS_INTO_CLICKED.has(name)) {
    if (look.against === null) return {};
    const into = OPPOSITE[look.against];
    return { facing: into === "up" ? "down" : into };
  }

  if (FACE_AND_FACING.has(name) || FACE_AND_FACING_SUFFIXES.some((s) => name.endsWith(s))) {
    if (look.against === "up") return { face: "floor", facing: horizontalFacing(look.direction) };
    if (look.against === "down") {
      return { face: "ceiling", facing: horizontalFacing(look.direction) };
    }
    return look.against === null ? {} : { face: "wall", facing: look.against };
  }

  if (FRONT_TO_PLAYER.has(name)) {
    return { facing: OPPOSITE[horizontalFacing(look.direction)] };
  }

  if (FRONT_TO_PLAYER_ANY_AXIS.has(name)) {
    return { facing: OPPOSITE[nearestFace(look.direction)] };
  }

  if (AWAY_FROM_PLAYER_ANY_AXIS.has(name)) {
    return { facing: nearestFace(look.direction) };
  }

  return {};
}

/**
 * The rest of the state a freshly placed block carries, beside its direction.
 *
 * ## Why write states nobody chose
 *
 * A door placed by hand used to land as `minecraft:oak_door[facing=north]`, and
 * the inspector shows the properties an entry *has* -- so four of the five
 * things that make a door a door were not on screen and could not be edited.
 * They exist on the block either way; the only question is whether the person
 * building can see them.
 *
 * That is what makes these values a *starting point* rather than a claim.
 * `facing=north` on a door is not more true than `facing=south`; it is the one
 * the file would have carried anyway, now written where it can be changed. A
 * schematic read from disk already spells every property out -- this is what
 * makes a hand-placed block look like one that was loaded.
 *
 * ## It used to be a table here, and being hand-written was the fault
 *
 * Twenty-one families, keyed by suffix, against the two hundred-odd blocks that
 * carry properties at all. Everything else was placed bare, which is one cause
 * with two symptoms: an empty inspector, and -- for anything `block_shapes.ts`
 * reads a property to draw -- the wrong shape. A fence had no `north`, so it
 * drew as a bare post, and the panel that exists to fix that had nothing in it.
 *
 * `shared/block_states.ts` is generated from the game's own data, so the list
 * cannot drift from the set of blocks the app offers. What stayed hand-written
 * is everything above this line: `orientPlacement` asks where the camera was,
 * and no dataset knows that.
 */
function defaultState(id: string): Record<string, string> {
  return defaultStateFor(id);
}

/**
 * The complete state a placed block starts in: its direction, and every other
 * property the family carries.
 *
 * Orientation wins over the defaults, because `facing` appears in both and only
 * one of them looked at the camera.
 */
export function placementState(id: string, look: PlacementLook): Record<string, string> {
  return { ...defaultState(id), ...orientPlacement(id, look) };
}

/**
 * Every block id this file claims to know how to orient, by exact name.
 *
 * Exported for the suite that checks each one against `block_id_list.txt` —
 * the same discipline the block-list generator applies to itself. A typo here
 * writes a state onto a block that does not exist, which is not something the
 * app would ever notice.
 */
export const ORIENTED_BLOCK_NAMES: readonly string[] = [
  ...AXIS_NAMES,
  ...FRONT_TO_PLAYER,
  ...FRONT_TO_PLAYER_ANY_AXIS,
  ...AWAY_FROM_PLAYER_ANY_AXIS,
  ...WALL_MOUNTED,
  ...FACE_AND_FACING,
  ...POINTS_INTO_CLICKED,
  ...SPUN_LEGACY,
];
