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

import { defaultStateFor } from "./block_states.js";

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

/** Blocks that point where you are looking, because that is where they act. */
const AWAY_FROM_PLAYER_ANY_AXIS: ReadonlySet<string> = new Set(["piston", "sticky_piston"]);

/**
 * Blocks that stick to whatever they were clicked onto.
 *
 * `facing` here means "the way it looks out of the wall", which is the face
 * that was clicked — not a function of the look direction at all.
 */
const WALL_MOUNTED: ReadonlySet<string> = new Set(["ladder"]);

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
    // `half` only. A trapdoor's `facing` is decided by the edge it hinges on,
    // which this does not model, and a confidently wrong hinge is worse than
    // the default one.
    return { half: upper ? "top" : "bottom" };
  }

  // A door is walked through in the direction you were looking when you hung
  // it; a gate blocks the way you were walking; a bed's head goes away from
  // you. Three blocks, one rule.
  if (name.endsWith("_door") || name.endsWith("_fence_gate") || name.endsWith("_bed")) {
    return { facing: horizontalFacing(look.direction) };
  }

  if (WALL_MOUNTED.has(name)) {
    return look.against === null || look.against === "up" || look.against === "down"
      ? {}
      : { facing: look.against };
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
];
