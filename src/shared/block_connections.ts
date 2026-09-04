/**
 * The part of a block's state that its *neighbours* decide.
 *
 * ## Why this exists
 *
 * `block_shapes.ts` reads `properties.north` to decide whether a fence has an
 * arm on its north side, `properties.up` for a wall's post, `properties.shape`
 * for a staircase's corner. A block placed by hand carried none of them, so a
 * fence drew as a bare post, a wall as a lone pillar, and a run of rails as a
 * line of parallel sleepers going nowhere. The properties now exist --
 * `block_states.ts` gives every placed block its full default state -- but a
 * *default* fence is `north=false` on all four sides, which is still a post.
 *
 * Somebody has to look at what is next to it. That is this file.
 *
 * ## Why it is `shared/` and pure
 *
 * It is a fact about Minecraft, not about a process -- the same reason
 * `block_orientation.ts` is here. Pure so the suites can drive it with literals
 * instead of building a document, and because the caller is inside a
 * transaction where allocating a document would be absurd.
 *
 * Solidity is passed in rather than decided here. "Is this a full opaque cube"
 * is `occludesNeighbours`' question and it lives in `main/pipeline`, which the
 * renderer may not import; main computes it and hands it over.
 *
 * ## Every write is guarded by `hasProperty`
 *
 * A rule that sets `north` on something with no `north` produces a block state
 * the game refuses, and *nothing in this app would notice*: the inspector shows
 * whatever the entry has, the writers write it, the mesher ignores what it does
 * not know. So no rule here writes a property without asking the generated
 * table first. That is also what makes the family tests cheap -- a family
 * matched too broadly by name is caught by the guard rather than by a reader.
 *
 * ## What is deliberately not here
 *
 * `tripwire`'s `attached`, which depends on hooks two blocks away in a line and
 * is not a neighbour question; doors' `hinge`, which is decided at the click by
 * where the player stood and belongs to `block_orientation.ts`; and beds'
 * `part`, for the same reason. Left out rather than overlooked: a confidently
 * wrong state is worse than a default, because it looks deliberate.
 */

import { hasProperty } from "./block_states.js";

export type Face = "up" | "down" | "north" | "south" | "east" | "west";

/** The four a connection can run along. Order is north, east, south, west. */
export const HORIZONTAL_FACES: readonly Face[] = ["north", "east", "south", "west"];

export interface NeighbourBlock {
  /** Bare name: `oak_fence`, not `minecraft:oak_fence[north=true]`. */
  readonly name: string;
  readonly properties: Readonly<Record<string, string>>;
  /**
   * Whether this is a full opaque cube — what a fence, wall or pane attaches
   * to. `occludesNeighbours`' answer, computed by main and passed in.
   */
  readonly solid: boolean;
}

/**
 * A cell to ask about: one of the six faces, or the cell above or below one
 * of the four horizontal ones.
 *
 * The eight diagonals are redstone's alone and are the whole of what lets a
 * wire run up and down a step. Nothing else here looks past a face, and a
 * caller that does not fill them simply gets `undefined`, which reads as air
 * -- the same answer as before they existed.
 */
export type NeighbourKey = Face | `${string}_up` | `${string}_down`;

/** `null` means air, or outside the schematic. The two behave the same. */
export type Neighbours = Readonly<Partial<Record<NeighbourKey, NeighbourBlock | null>>>;

const CLOCKWISE: Readonly<Record<string, Face>> = {
  north: "east",
  east: "south",
  south: "west",
  west: "north",
};

const OPPOSITE: Readonly<Record<string, Face>> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
  up: "down",
  down: "up",
};

function clockwise(face: string): Face {
  return CLOCKWISE[face] ?? "north";
}

function counterClockwise(face: string): Face {
  return OPPOSITE[clockwise(face)] ?? "north";
}

function axisOf(face: string): "x" | "z" {
  return face === "east" || face === "west" ? "x" : "z";
}

// --- what a thing is --------------------------------------------------------

const isFence = (name: string): boolean => name.endsWith("_fence");
const isFenceGate = (name: string): boolean => name.endsWith("_fence_gate");
const isWall = (name: string): boolean => name.endsWith("_wall");
const isPane = (name: string): boolean => name.endsWith("_pane") || name === "iron_bars";
const isStairs = (name: string): boolean => name.endsWith("_stairs");
const isRail = (name: string): boolean => name === "rail" || name.endsWith("_rail");
const isChest = (name: string): boolean => name === "chest" || name === "trapped_chest";

/**
 * Whether two fences are the same *kind*.
 *
 * A wooden fence does not connect to a nether brick fence -- they are separate
 * materials in the game and a run of one meeting the other leaves a gap on
 * purpose. Everything that is not the nether brick fence is wooden, including
 * modded woods, which is why this is a two-way check on one name rather than a
 * list of the sixteen woods.
 */
function sameFenceKind(a: string, b: string): boolean {
  return (a === "nether_brick_fence") === (b === "nether_brick_fence");
}

/** A gate stands *in* a fence line, so it counts as a connection across it. */
function gateFaces(gate: NeighbourBlock, direction: Face): boolean {
  const facing = gate.properties.facing ?? "north";
  return axisOf(facing) !== axisOf(direction);
}

// --- the families -----------------------------------------------------------

function fenceConnects(self: string, neighbour: NeighbourBlock | null, direction: Face): boolean {
  if (neighbour === null) return false;
  if (isFence(neighbour.name)) return sameFenceKind(self, neighbour.name);
  if (isFenceGate(neighbour.name)) return gateFaces(neighbour, direction);
  if (isWall(neighbour.name)) return true;
  return neighbour.solid;
}

function paneConnects(neighbour: NeighbourBlock | null): boolean {
  if (neighbour === null) return false;
  if (isPane(neighbour.name) || isWall(neighbour.name)) return true;
  return neighbour.solid;
}

function wallConnects(neighbour: NeighbourBlock | null, direction: Face): boolean {
  if (neighbour === null) return false;
  if (isWall(neighbour.name) || isPane(neighbour.name)) return true;
  if (isFenceGate(neighbour.name)) return gateFaces(neighbour, direction);
  return neighbour.solid;
}

/**
 * A wall's four sides and its post.
 *
 * Two things separate it from a fence and both were silent failures waiting to
 * happen. Its connections are `none|low|tall` rather than `true|false` -- the
 * 1.16 change that reads as a value change and is a *type* change, so code
 * testing `=== "true"` does not fail on a wall, it sees no connections at all.
 * And it has a `up`, the post, which vanilla drops only in the one case where
 * the wall is a straight run: exactly two opposite low connections and nothing
 * on top. Any other arrangement keeps the post, which is why the test is
 * written as "is this the one case" rather than as a list of the others.
 */
function wallState(neighbours: Neighbours): Record<string, string> {
  const above = neighbours.up ?? null;
  // A side reaches full height when something sits on the wall: the tall model
  // is what closes the gap under it.
  const tall = above !== null && above.solid;
  const state: Record<string, string> = {};
  const connected: Face[] = [];
  for (const direction of HORIZONTAL_FACES) {
    if (wallConnects(neighbours[direction] ?? null, direction)) {
      state[direction] = tall ? "tall" : "low";
      connected.push(direction);
    } else {
      state[direction] = "none";
    }
  }
  const straightRun =
    connected.length === 2 && OPPOSITE[connected[0]] === connected[1] && !tall;
  state.up = straightRun ? "false" : "true";
  return state;
}

/**
 * A staircase's corner, transcribed from `StairBlock.getShape`.
 *
 * The block *in front* makes an outer corner and the block *behind* makes an
 * inner one, in both cases only when its facing is on the other axis and only
 * when the two halves agree -- a top slab stair and a bottom one meeting at a
 * corner are two separate runs, not one turn.
 *
 * `canTakeShape` is the part that is easy to leave out and produces a visible
 * fault when it is: without it, a straight run of stairs with a matching stair
 * beyond the corner shapes itself anyway, and a staircase in the middle of a
 * flight grows a notch.
 */
function stairsShape(
  self: Readonly<Record<string, string>>,
  neighbours: Neighbours,
): string {
  const facing = self.facing ?? "north";
  const half = self.half ?? "bottom";
  const matching = (face: Face): NeighbourBlock | null => {
    const block = neighbours[face] ?? null;
    if (block === null || !isStairs(block.name)) return null;
    return (block.properties.half ?? "bottom") === half ? block : null;
  };
  /** Whether the neighbour that way is *not* a stair aligned with this one. */
  const canTakeShape = (face: Face): boolean => {
    const block = matching(face);
    return block === null || (block.properties.facing ?? "north") !== facing;
  };

  const front = matching(facing as Face);
  if (front !== null) {
    const frontFacing = front.properties.facing ?? "north";
    if (axisOf(frontFacing) !== axisOf(facing) && canTakeShape(OPPOSITE[frontFacing])) {
      return frontFacing === counterClockwise(facing) ? "outer_left" : "outer_right";
    }
  }

  const back = matching(OPPOSITE[facing]);
  if (back !== null) {
    const backFacing = back.properties.facing ?? "north";
    if (axisOf(backFacing) !== axisOf(facing) && canTakeShape(backFacing as Face)) {
      return backFacing === counterClockwise(facing) ? "inner_left" : "inner_right";
    }
  }
  return "straight";
}

/**
 * A rail's shape.
 *
 * Two of the ten values are straight, four are curves, and four ascend.
 * **Ascending is deliberately not derived**, and the reason is structural
 * rather than an oversight: a rail ascends towards a rail one block *up and
 * over*, which is a diagonal, and `Neighbours` is the six faces. Extending it
 * for one family would put four more lookups on every cell the pass visits.
 *
 * Flat-correct is still the whole visible difference here: every rail in the
 * game used to be `north_south`, so a line running east lay across its own
 * track and a corner did not turn at all.
 *
 * Only the plain `rail` curves. Powered, detector and activator rails have no
 * curve in their `shape` at all, so offering one would write a value the game
 * refuses -- `hasProperty` would not catch that, because the property is real
 * and only the value is not.
 */
const RAIL_CURVES: ReadonlyArray<readonly [Face, Face, string]> = [
  ["north", "east", "north_east"],
  ["north", "west", "north_west"],
  ["south", "east", "south_east"],
  ["south", "west", "south_west"],
];

function railShape(self: string, neighbours: Neighbours): string {
  const links = HORIZONTAL_FACES.filter((direction) => {
    const side = neighbours[direction] ?? null;
    return side !== null && isRail(side.name);
  });

  const straight = (face: Face): string => (axisOf(face) === "x" ? "east_west" : "north_south");

  // No neighbour, or one: lie along whatever axis is implied. `north_south` is
  // the default state and the answer for a lone rail.
  if (links.length === 0) return "north_south";
  if (links.length === 1) return straight(links[0]);

  if (links.length === 2) {
    if (OPPOSITE[links[0]] === links[1]) return straight(links[0]);
    if (self === "rail") {
      const curve = RAIL_CURVES.find(
        ([a, b]) => links.includes(a) && links.includes(b),
      );
      if (curve !== undefined) return curve[2];
    }
    // A powered rail at a corner cannot turn, so it keeps a straight run.
    return straight(links[0]);
  }

  // Three or four ways is a junction, which a rail cannot express. Vanilla
  // keeps a straight run through it; north/south wins because it is the
  // default and the choice has to be made somewhere.
  return links.includes("north") || links.includes("south") ? "north_south" : "east_west";
}

/**
 * A chest's half of a double chest.
 *
 * The convention is `ChestBlock.getConnectedDirection`'s: a `left` chest has
 * its partner clockwise of its facing, a `right` chest counter-clockwise. The
 * wiki's block-state table does not say which half is which -- it describes the
 * *inventory* layout and stops -- so this is taken from the game's own rule
 * rather than corroborated against prose.
 *
 * What `tests/blocks.ts` checks is therefore the property that actually
 * matters: a pair comes out as exactly one `left` and one `right`, and each
 * agrees about where the other is. Two chests both claiming `left` is the
 * visible failure. Which of the two sheet halves each wears is cosmetic, and if
 * the convention is backwards it is backwards consistently.
 *
 * Only chests facing the same way pair. Two side by side facing apart are two
 * single chests, in the game and here.
 */
function chestType(
  self: { readonly name: string; readonly properties: Readonly<Record<string, string>> },
  neighbours: Neighbours,
): string {
  const facing = self.properties.facing ?? "north";
  const pairsAt = (face: Face): boolean => {
    const side = neighbours[face] ?? null;
    return (
      side !== null &&
      side.name === self.name &&
      (side.properties.facing ?? "north") === facing
    );
  };
  if (pairsAt(clockwise(facing))) return "left";
  if (pairsAt(counterClockwise(facing))) return "right";
  return "single";
}

/** Blocks whose six faces show their skin where no sibling covers them. */
/**
 * What redstone dust attaches to, which is `RedStoneWireBlock.shouldConnectTo`
 * read as a list.
 *
 * The check it replaces was `side.name.includes("redstone")`, which is wrong
 * in both directions at once: it took `redstone_ore`, `deepslate_redstone_ore`
 * and `redstone_lamp`, none of which dust connects to, and missed every source
 * that is not spelled with the word -- a repeater, a comparator, a lever, a
 * button, a pressure plate, an observer, a tripwire hook, a daylight detector,
 * a target, a trapped chest, a lectern, a detector rail, a sculk sensor and a
 * lightning rod.
 *
 * A **repeater** connects only along its own axis and an **observer** only out
 * of its face; vanilla names those two specially and everything else answers
 * `isSignalSource`, which is direction-blind. A comparator is deliberately in
 * the blind half -- it is a signal source and dust runs to any of its sides.
 */
const SIGNAL_SOURCES: ReadonlySet<string> = new Set([
  "redstone_wire",
  "redstone_torch",
  "redstone_wall_torch",
  "redstone_block",
  "lever",
  "comparator",
  "tripwire_hook",
  "daylight_detector",
  "detector_rail",
  "trapped_chest",
  "target",
  "lectern",
  "sculk_sensor",
  "calibrated_sculk_sensor",
  "lightning_rod",
]);

const SIGNAL_SUFFIXES: readonly string[] = ["_button", "_pressure_plate"];

const AXIS_OF: Readonly<Record<string, "x" | "z">> = {
  north: "z",
  south: "z",
  east: "x",
  west: "x",
};

/** Whether dust in a cell attaches to `side`, approached from `direction`. */
function connectsToDust(side: NeighbourBlock | null, direction: Face): boolean {
  if (side === null) return false;
  if (side.name === "repeater") {
    const facing = side.properties.facing ?? "north";
    return AXIS_OF[facing] === AXIS_OF[direction];
  }
  if (side.name === "observer") {
    // The observer faces *into* what it watches, so dust on the far side of
    // it is the one this direction points back along.
    return (side.properties.facing ?? "south") === OPPOSITE[direction];
  }
  return SIGNAL_SOURCES.has(side.name) || SIGNAL_SUFFIXES.some((s) => side.name.endsWith(s));
}

/**
 * One of `none`, `side` or `up`, by vanilla's own order of questions.
 *
 * The two vertical arms are the part that was missing entirely -- `"up"` was
 * never produced by any code path in this repo, so no wire ever climbed a
 * step and the geometry that draws one had nothing to draw it from.
 */
function redstoneSide(neighbours: Neighbours, direction: Face, roofed: boolean): string {
  const side = neighbours[direction] ?? null;
  const above = neighbours[`${direction}_up`] ?? null;
  const below = neighbours[`${direction}_down`] ?? null;
  // Up the side of the neighbour, if there is something on top of it to
  // reach and nothing on top of this wire to stop it.
  if (!roofed && side !== null && side.solid && connectsToDust(above, direction)) {
    return "up";
  }
  if (connectsToDust(side, direction)) return "side";
  // A solid neighbour blocks the view of whatever is under it; anything else
  // -- a slab, a fence, air -- lets the wire drop a step.
  if (side !== null && side.solid) return "none";
  return connectsToDust(below, direction) ? "side" : "none";
}

const MUSHROOM_BLOCKS: ReadonlySet<string> = new Set([
  "brown_mushroom_block",
  "red_mushroom_block",
  "mushroom_stem",
]);

const ALL_FACES: readonly Face[] = ["north", "east", "south", "west", "up", "down"];

/**
 * The complete neighbour-derived state for one block.
 *
 * Returns only what it is sure of, and only properties the block actually has.
 * An empty object means "nothing here depends on the neighbours", which is the
 * answer for most of the game.
 */
export function connectedState(
  block: { readonly name: string; readonly properties: Readonly<Record<string, string>> },
  neighbours: Neighbours,
): Record<string, string> {
  const name = block.name;
  const out: Record<string, string> = {};
  const put = (property: string, value: string): void => {
    if (hasProperty(name, property)) out[property] = value;
  };

  if (isFenceGate(name)) {
    // A gate set into a wall drops to the wall's height. Both sides across the
    // gate are checked, because a gate at the end of a wall still sits in it.
    const across = [clockwise(block.properties.facing ?? "north"), counterClockwise(block.properties.facing ?? "north")];
    const inWall = across.some((face) => {
      const side = neighbours[face] ?? null;
      return side !== null && isWall(side.name);
    });
    put("in_wall", inWall ? "true" : "false");
    return out;
  }

  if (isFence(name)) {
    for (const direction of HORIZONTAL_FACES) {
      put(direction, fenceConnects(name, neighbours[direction] ?? null, direction) ? "true" : "false");
    }
    return out;
  }

  if (isWall(name)) {
    for (const [property, value] of Object.entries(wallState(neighbours))) {
      put(property, value);
    }
    return out;
  }

  if (isPane(name)) {
    for (const direction of HORIZONTAL_FACES) {
      put(direction, paneConnects(neighbours[direction] ?? null) ? "true" : "false");
    }
    return out;
  }

  if (isStairs(name)) {
    put("shape", stairsShape(block.properties, neighbours));
    return out;
  }

  if (isRail(name)) {
    put("shape", railShape(name, neighbours));
    return out;
  }

  if (isChest(name)) {
    put("type", chestType(block, neighbours));
    return out;
  }

  if (name === "redstone_wire") {
    /*
     * `RedStoneWireBlock.getConnectingSide`, transcribed. The wire can climb
     * only while nothing solid is sitting on top of it -- a wire under a
     * block cannot run up the side of anything.
     */
    const roofed = (neighbours.up ?? null)?.solid === true;
    for (const direction of HORIZONTAL_FACES) {
      put(direction, redstoneSide(neighbours, direction, roofed));
    }
    return out;
  }

  if (name === "chorus_plant") {
    for (const face of ALL_FACES) {
      const side = neighbours[face] ?? null;
      const connects =
        side !== null && (side.name === "chorus_plant" || side.name === "chorus_flower");
      put(face, connects ? "true" : "false");
    }
    return out;
  }

  if (name === "vine") {
    // A vine clings to what is beside and above it, and has no `down`.
    for (const face of [...HORIZONTAL_FACES, "up" as Face]) {
      const side = neighbours[face] ?? null;
      put(face, side !== null && side.solid ? "true" : "false");
    }
    return out;
  }

  if (MUSHROOM_BLOCKS.has(name)) {
    // Inverted: a face is *true* where the skin shows, which is where there is
    // no sibling covering it.
    for (const face of ALL_FACES) {
      const side = neighbours[face] ?? null;
      put(face, side !== null && MUSHROOM_BLOCKS.has(side.name) ? "false" : "true");
    }
    return out;
  }

  // `snowy` is the only neighbour-derived state on an ordinary cube, and it
  // reads upward rather than sideways.
  if (hasProperty(name, "snowy")) {
    const above = neighbours.up ?? null;
    const snow = above !== null && (above.name === "snow" || above.name === "snow_block");
    put("snowy", snow ? "true" : "false");
    return out;
  }

  return out;
}

/**
 * Whether a block's state depends on its neighbours at all.
 *
 * The caller uses it to skip cells rather than to decide what to write --
 * `connectedState` is still the authority, and answering `true` here only costs
 * a lookup that returns `{}`.
 */
export function isNeighbourDependent(name: string): boolean {
  return (
    isFence(name) ||
    isFenceGate(name) ||
    isWall(name) ||
    isPane(name) ||
    isStairs(name) ||
    isRail(name) ||
    isChest(name) ||
    name === "redstone_wire" ||
    name === "chorus_plant" ||
    name === "vine" ||
    MUSHROOM_BLOCKS.has(name) ||
    hasProperty(name, "snowy")
  );
}
