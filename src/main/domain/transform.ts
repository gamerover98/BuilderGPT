/**
 * Rotating and mirroring, including the block states that have to come along.
 *
 * Moving the voxels is the easy half and the half that looks finished. The
 * other half is that orientation lives in the *block state*: a
 * `oak_stairs[facing=north]` moved a quarter-turn without becoming
 * `facing=east` is a staircase that now runs into a wall, and a
 * `oak_log[axis=x]` rotated without becoming `axis=z` is a beam lying the wrong
 * way across its own joinery. A rotation that ignores block states rearranges a
 * build into rubble that is individually correct.
 *
 * ## Which way a quarter-turn goes
 *
 * `pipeline/block_shapes.ts` already fixed that convention for the mesher: one
 * step is `(x, z) -> (size - 1 - z, x)`, which sends **east to south**. This
 * uses the same one rather than inventing a second, because the two would
 * disagree exactly once — silently, in the renderer — and nobody would know
 * which was right.
 *
 * ## What is covered, and what passes through
 *
 * `facing`, `axis`, `rotation` (the 16-step sign and banner dial), the
 * per-direction booleans fences, walls, panes and redstone use, stair `shape`,
 * rail `shape`, and `hinge`. Everything else is carried across untouched, which
 * is right for `half`, `waterlogged`, `lit`, `powered` and the rest — none of
 * them name a direction.
 *
 * Anything that *does* name a direction and is not listed here would be carried
 * across wrong rather than refused, so the tables are the thing to extend when
 * a block turns out to sit crooked.
 */

import type { BlockEntityRecord, PaletteEntry } from "../pipeline/types.js";
import { getBlock, normalizeRegion, type SchematicDocument } from "./document.js";
import type { TransactionScope } from "./history.js";
import type { RegionSpec } from "../../shared/ipc.js";

/** Quarter-turns, in the east -> south direction. */
export type Quarter = 0 | 1 | 2 | 3;

/**
 * Which coordinate is negated.
 *
 * `x` swaps east and west, `z` north and south, and `y` turns the build upside
 * down. The third is not the other two with a letter changed: a vertical
 * reflection touches an entirely different set of properties -- `half`, `type`,
 * `face`, `attachment`, `vertical_direction` -- and none of the horizontal
 * ones, which is why it has a mapping of its own below rather than a third
 * branch inside `mirrorDirection`.
 */
export type MirrorAxis = "x" | "y" | "z";

/** The horizontal compass, in the order one quarter-turn walks it. */
const COMPASS = ["east", "south", "west", "north"] as const;
type Compass = (typeof COMPASS)[number];

function isCompass(value: string): value is Compass {
  return (COMPASS as readonly string[]).includes(value);
}

export function rotateDirection(direction: string, steps: Quarter): string {
  if (!isCompass(direction)) {
    // `up` and `down` survive a turn about the vertical axis unchanged.
    return direction;
  }
  return COMPASS[(COMPASS.indexOf(direction) + steps) % 4];
}

export function mirrorDirection(direction: string, axis: MirrorAxis): string {
  if (axis === "y") {
    return direction === "up" ? "down" : direction === "down" ? "up" : direction;
  }
  if (axis === "x") {
    return direction === "east" ? "west" : direction === "west" ? "east" : direction;
  }
  return direction === "north" ? "south" : direction === "south" ? "north" : direction;
}

/**
 * The 16-step dial standing signs, banners and skulls use.
 *
 * 0 is south and it counts up through west, north, east — so a quarter-turn is
 * four steps in the same direction the compass above walks.
 */
function rotateDial(value: string, steps: Quarter): string {
  const dial = Number(value);
  if (!Number.isInteger(dial)) return value;
  return String((((dial + steps * 4) % 16) + 16) % 16);
}

function mirrorDial(value: string, axis: MirrorAxis): string {
  // A vertical flip does not turn a standing sign: its dial is a yaw, and
  // reflecting through a horizontal plane leaves every yaw where it was.
  if (axis === "y") return value;
  const dial = Number(value);
  if (!Number.isInteger(dial)) return value;
  // Mirroring about x fixes south (0) and north (8) and swaps east (12) with
  // west (4); about z it fixes west and east and swaps north with south.
  const mirrored = axis === "x" ? 16 - dial : 8 - dial;
  return String(((mirrored % 16) + 16) % 16);
}

/** Rail corners are named for the two directions they join. */
const RAIL_CORNERS: Readonly<Record<string, readonly [Compass, Compass]>> = {
  south_east: ["south", "east"],
  south_west: ["south", "west"],
  north_west: ["north", "west"],
  north_east: ["north", "east"],
};

function cornerName(a: string, b: string): string | null {
  for (const [name, pair] of Object.entries(RAIL_CORNERS)) {
    if ((pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a)) {
      return name;
    }
  }
  return null;
}

/**
 * Rail and stair `shape`, under one transform.
 *
 * Derived from the direction names rather than tabulated: the alternative is
 * forty entries whose correctness nobody can check by reading, and the names
 * already say what they mean.
 */
function transformShape(value: string, move: (direction: string) => string): string {
  if (value === "north_south" || value === "east_west") {
    const moved = move(value === "north_south" ? "north" : "east");
    return moved === "north" || moved === "south" ? "north_south" : "east_west";
  }
  if (value.startsWith("ascending_")) {
    return `ascending_${move(value.slice("ascending_".length))}`;
  }
  const corner = RAIL_CORNERS[value];
  if (corner) {
    return cornerName(move(corner[0]), move(corner[1])) ?? value;
  }
  return value;
}

/**
 * Stair and door `shape`/`hinge`, which name a *side* rather than a direction.
 *
 * Left and right are relative to `facing`, so a rotation leaves them alone —
 * and a mirror swaps them, because a reflection is what turns a left-hand
 * staircase into a right-hand one.
 */
function mirrorHandedness(value: string): string {
  if (value === "left") return "right";
  if (value === "right") return "left";
  if (value.endsWith("_left")) return `${value.slice(0, -"_left".length)}_right`;
  if (value.endsWith("_right")) return `${value.slice(0, -"_right".length)}_left`;
  return value;
}

const DIRECTION_FLAGS = ["north", "east", "south", "west"] as const;

/** Applies one direction mapping to every property that names a direction. */
function transformProperties(
  properties: Readonly<Record<string, string>>,
  move: (direction: string) => string,
  dial: (value: string) => string,
  handedness: (value: string) => string,
  /**
   * Whether the transform exchanges the two horizontal axes — true of a
   * quarter and three-quarter turn, false of a half turn and of either mirror,
   * both of which send each axis back onto itself.
   */
  axisSwaps: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(properties)) {
    if (name === "facing") {
      out[name] = move(value);
    } else if (name === "axis") {
      // `y` is the axis being turned about, so it is never touched.
      out[name] = axisSwaps && value === "x" ? "z" : axisSwaps && value === "z" ? "x" : value;
    } else if (name === "rotation") {
      out[name] = dial(value);
    } else if (name === "shape") {
      out[name] = handedness(transformShape(value, move));
    } else if (name === "hinge") {
      out[name] = handedness(value);
    } else if ((DIRECTION_FLAGS as readonly string[]).includes(name)) {
      // Fences, walls, panes and redstone carry one flag per side. The flag
      // that was on `east` belongs on whatever east becomes.
      out[move(name)] = value;
    } else {
      out[name] = value;
    }
  }

  return out;
}

export function rotateProperties(
  properties: Readonly<Record<string, string>>,
  steps: Quarter,
): Record<string, string> {
  if (steps === 0) return { ...properties };
  return transformProperties(
    properties,
    (direction) => rotateDirection(direction, steps),
    (value) => rotateDial(value, steps),
    // Left and right are relative to facing, which is rotating with them.
    (value) => value,
    steps === 1 || steps === 3,
  );
}

/**
 * The properties a vertical reflection turns over.
 *
 * A different set from the horizontal ones, and that is the whole reason this
 * is its own function: flipping a build upside down never touches `facing` on
 * a staircase, and always touches `half` -- the exact opposite of a mirror
 * across x or z.
 *
 * `face` and `attachment` are the two that get forgotten. A lever on the floor
 * flipped becomes a lever on the ceiling, and a bell standing on the ground
 * becomes one hanging from it; leave them out and the build comes back with
 * every switch and every bell embedded in a block.
 */
const VERTICAL_SWAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  facing: { up: "down", down: "up" },
  // `top`/`bottom` is a slab and a stair; `upper`/`lower` is a door or a tall
  // flower. Both spellings mean the same thing and both appear as `half`.
  half: { top: "bottom", bottom: "top", upper: "lower", lower: "upper" },
  type: { top: "bottom", bottom: "top" },
  vertical_direction: { up: "down", down: "up" },
  attachment: { floor: "ceiling", ceiling: "floor" },
  face: { floor: "ceiling", ceiling: "floor" },
};

function mirrorVerticalProperties(
  properties: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(properties)) {
    /*
     * An ascending rail has no reflection. `ascending_north` upside down would
     * be a rail going *down* to the north, and the game has no such state --
     * every rail that is not flat ascends. So the value is left exactly as it
     * was rather than turned into a neighbouring direction, which is the only
     * honest answer: inventing a state is the one thing this file may not do.
     */
    if (name === "hinge") {
      // A reflection reverses chirality whichever plane it is through, so a
      // left-hung door comes back right-hung -- the same rule the horizontal
      // mirror applies, for the same reason.
      out[name] = mirrorHandedness(value);
      continue;
    }
    out[name] = VERTICAL_SWAP[name]?.[value] ?? value;
  }
  return out;
}

export function mirrorProperties(
  properties: Readonly<Record<string, string>>,
  axis: MirrorAxis,
): Record<string, string> {
  if (axis === "y") return mirrorVerticalProperties(properties);
  return transformProperties(
    properties,
    (direction) => mirrorDirection(direction, axis),
    (value) => mirrorDial(value, axis),
    mirrorHandedness,
    false,
  );
}

// ---------------------------------------------------------------------------
// Applying it to a region
// ---------------------------------------------------------------------------

export class NotSquareError extends Error {
  constructor(width: number, length: number) {
    super(
      `A quarter turn needs a square footprint; this region is ${width}×${length}. ` +
        `Turn it 180°, or square the region off.`,
    );
    this.name = "NotSquareError";
  }
}

export type RegionTransform =
  | { kind: "rotate"; steps: Quarter }
  | { kind: "mirror"; axis: MirrorAxis };

/** What the undo menu — or the agent's step log — should call this. */
export function describeTransform(transform: RegionTransform): string {
  return transform.kind === "mirror"
    ? `Mirror across ${transform.axis.toUpperCase()}`
    : `Rotate ${transform.steps * 90}°`;
}

/**
 * Turns or reflects a region in place, block states and block entities with it.
 *
 * Takes a `TransactionScope` rather than opening one, because it has two
 * callers with different ideas of what a transaction is: the UI wants one step
 * per turn, and the agent wants the whole request — however many tools it
 * called — to be a single CTRL+Z. Opening one here would nest inside the
 * agent's and break that.
 *
 * Read whole, then written: every source cell is snapshotted before the first
 * write, because a turn maps cells onto cells still to be read, and doing it in
 * one pass would feed half-turned output back in as input.
 *
 * A quarter turn needs a square footprint, and says so rather than guessing.
 * Growing the document to fit a turned oblong is a resize, and a resize is
 * alone in its command for the reasons `history.ts` sets out.
 */
export interface TransformPlacement {
  /**
   * Where the transformed box's minimum corner goes. In place when absent.
   *
   * The destination is what lets a turn be about something other than the
   * region's own middle -- the gizmo's pivot -- and it is also what removes
   * `NotSquareError` for the caller that supplies one: a quarter turn of a 5x3
   * footprint is simply a 3x5 box somewhere, and only the demand that it land
   * back on its own coordinates made it impossible.
   */
  to?: { x: number; y: number; z: number } | null;
  /**
   * What the region leaves behind when it moves off its own cells.
   *
   * Air unless told otherwise. `applyEdit`'s break path already knows that
   * empty space may be water; passing that in keeps a turned underwater build
   * from coming back full of bubbles.
   */
  empty?: PaletteEntry;
}

const AIR: PaletteEntry = { namespacedName: "minecraft:air", properties: {} };

export function applyRegionTransform(
  doc: SchematicDocument,
  tx: TransactionScope,
  request: RegionSpec,
  transform: RegionTransform,
  placement: TransformPlacement = {},
): number {
  const region = normalizeRegion(doc, request);
  const width = region.maxX - region.minX + 1;
  const height = region.maxY - region.minY + 1;
  const length = region.maxZ - region.minZ + 1;
  const quarter = transform.kind === "rotate" && (transform.steps === 1 || transform.steps === 3);

  /*
   * In place, a quarter turn has to come back onto its own footprint, so an
   * oblong one cannot. With a destination it can, which is why the check asks
   * about the destination rather than about the turn.
   */
  const to = placement.to ?? null;
  if (quarter && width !== length && to === null) {
    throw new NotSquareError(width, length);
  }

  /**
   * Where a cell ends up, in coordinates local to the destination box.
   *
   * Three axes rather than two. It was `(x, z)` while every transform this file
   * could express left the vertical alone -- and then the vertical mirror
   * arrived, which moves nothing else. Written the old way it would have turned
   * every slab and staircase over and left them all exactly where they were: a
   * build that reports a healthy `changed` and looks untouched.
   */
  const move = (x: number, y: number, z: number): [number, number, number] => {
    if (transform.kind === "mirror") {
      if (transform.axis === "x") return [width - 1 - x, y, z];
      if (transform.axis === "y") return [x, height - 1 - y, z];
      return [x, y, length - 1 - z];
    }
    // The mesher's convention, kept: one step is (x, z) -> (size - 1 - z, x).
    //
    // Written out per step rather than composed by repeating the quarter turn.
    // Composing looks tidier and is wrong: each quarter turn exchanges the two
    // extents, so repeating one expression that names only `length` holds only
    // while the region is square — and the half turn, the one case that is
    // allowed to be oblong, is exactly where that breaks.
    switch (transform.steps) {
      case 1:
        return [length - 1 - z, y, x];
      case 2:
        return [width - 1 - x, y, length - 1 - z];
      case 3:
        return [z, y, width - 1 - x];
      default:
        return [x, y, z];
    }
  };

  const properties = (source: Readonly<Record<string, string>>): Record<string, string> =>
    transform.kind === "mirror"
      ? mirrorProperties(source, transform.axis)
      : rotateProperties(source, transform.steps);

  // The snapshot. Block entities come with it: a chest that moves but loses its
  // contents is a worse outcome than one that does not move at all.
  const cells: {
    x: number;
    y: number;
    z: number;
    entry: PaletteEntry;
    entity: BlockEntityRecord | null;
  }[] = [];
  for (let x = region.minX; x <= region.maxX; x += 1) {
    for (let y = region.minY; y <= region.maxY; y += 1) {
      for (let z = region.minZ; z <= region.maxZ; z += 1) {
        cells.push({
          x,
          y,
          z,
          entry: getBlock(doc, x, y, z),
          entity: doc.blockEntities.get(`${x},${y},${z}`) ?? null,
        });
      }
    }
  }

  const corner = to ?? { x: region.minX, y: region.minY, z: region.minZ };
  const inPlace =
    corner.x === region.minX && corner.y === region.minY && corner.z === region.minZ;

  /*
   * In place there is no clearing pass, though one looks prudent: both a turn
   * and a reflection are bijections on the region, so every destination cell is
   * written by exactly one source and none can keep a stale value, and
   * `setBlock` detaches the block entity of whatever it replaces. Clearing
   * would only add a second delta per voxel.
   *
   * Somewhere else it is required, and for the opposite reason: the source and
   * the destination overlap only partly, so the cells the region has *left*
   * would keep the blocks that were there. The snapshot is already taken, so
   * emptying first is safe -- `moveRegion`'s arrangement, arrived at from the
   * same direction.
   */
  let changed = 0;
  if (!inPlace) {
    changed += tx.fill(region, placement.empty ?? AIR);
  }

  for (const cell of cells) {
    const [lx, ly, lz] = move(cell.x - region.minX, cell.y - region.minY, cell.z - region.minZ);
    const x = corner.x + lx;
    const y = corner.y + ly;
    const z = corner.z + lz;
    if (tx.setBlock(x, y, z, { ...cell.entry, properties: properties(cell.entry.properties) })) {
      changed += 1;
    }
    if (cell.entity !== null) {
      tx.setBlockEntity(x, y, z, { ...cell.entity, pos: [x, y, z] });
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Scaling
// ---------------------------------------------------------------------------

/**
 * Whole factors only, because scaling voxels is resampling.
 *
 * `multiply` is exact: one block becomes n^3 of itself and nothing is decided.
 * `divide` is not, and cannot be -- n^3 cells collapse onto one and n^3 - 1 of
 * them are discarded. The survivor is the cell at the **low corner** of each
 * group, which is a rule that can be stated and predicted rather than the
 * commonest block or the first non-air one, both of which would make the result
 * depend on what happened to be nearby.
 *
 * Neither is offered at a fractional factor. A build at 1.3x is a build with a
 * different number of blocks in every row, and no property of the original
 * survives it.
 */
export type ScaleSpec = { kind: "multiply"; factor: number } | { kind: "divide"; factor: number };

/** The box a scale sends this one to, given where its corner should land. */
export function scaledExtent(
  extent: { width: number; height: number; length: number },
  spec: ScaleSpec,
): { width: number; height: number; length: number } {
  const apply = (value: number): number =>
    spec.kind === "multiply"
      ? value * spec.factor
      : // Never zero: an axis divided out of existence would leave an empty
        // region, which nothing downstream has an answer for.
        Math.max(1, Math.floor(value / spec.factor));
  return {
    width: apply(extent.width),
    height: apply(extent.height),
    length: apply(extent.length),
  };
}

/**
 * How many non-air blocks a division would discard.
 *
 * Counted before anything is written, because a warning delivered after the
 * blocks are gone is not a warning -- `resizeSession`'s rule, and this is the
 * second place that needs it.
 */
export function scaleWouldDrop(
  doc: SchematicDocument,
  request: RegionSpec,
  spec: ScaleSpec,
): number {
  if (spec.kind === "multiply") return 0;
  const region = normalizeRegion(doc, request);
  const n = spec.factor;
  let dropped = 0;
  for (let x = region.minX; x <= region.maxX; x += 1) {
    for (let y = region.minY; y <= region.maxY; y += 1) {
      for (let z = region.minZ; z <= region.maxZ; z += 1) {
        const kept =
          (x - region.minX) % n === 0 && (y - region.minY) % n === 0 && (z - region.minZ) % n === 0;
        if (kept) continue;
        if (getBlock(doc, x, y, z).namespacedName !== AIR.namespacedName) dropped += 1;
      }
    }
  }
  return dropped;
}

/**
 * Resamples a region by a whole factor, writing it at `corner`.
 *
 * Read whole first, exactly as the turn is: on a multiplication the destination
 * swallows the source many times over, so a cell written early would be read
 * back later as its own output.
 *
 * Block entities come along on the *representative* cell only. A chest doubled
 * is one chest in a 2x2x2 of chest blocks, which is wrong in a different way
 * from eight chests all holding the same items -- and eight copies of one
 * inventory is the wrong that duplicates loot, so this is the safer half.
 */
export function applyRegionScale(
  doc: SchematicDocument,
  tx: TransactionScope,
  request: RegionSpec,
  spec: ScaleSpec,
  placement: TransformPlacement = {},
): number {
  const region = normalizeRegion(doc, request);
  const width = region.maxX - region.minX + 1;
  const height = region.maxY - region.minY + 1;
  const length = region.maxZ - region.minZ + 1;
  const out = scaledExtent({ width, height, length }, spec);
  const corner = placement.to ?? { x: region.minX, y: region.minY, z: region.minZ };

  const source: (PaletteEntry | undefined)[] = [];
  const entities: (BlockEntityRecord | null)[] = [];
  const at = (x: number, y: number, z: number): number => (y * length + z) * width + x;
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let z = 0; z < length; z += 1) {
        source[at(x, y, z)] = getBlock(doc, region.minX + x, region.minY + y, region.minZ + z);
        entities[at(x, y, z)] =
          doc.blockEntities.get(`${region.minX + x},${region.minY + y},${region.minZ + z}`) ?? null;
      }
    }
  }

  let changed = tx.fill(region, placement.empty ?? AIR);
  const n = spec.factor;
  for (let x = 0; x < out.width; x += 1) {
    for (let y = 0; y < out.height; y += 1) {
      for (let z = 0; z < out.length; z += 1) {
        const sx = spec.kind === "multiply" ? Math.floor(x / n) : x * n;
        const sy = spec.kind === "multiply" ? Math.floor(y / n) : y * n;
        const sz = spec.kind === "multiply" ? Math.floor(z / n) : z * n;
        const entry = source[at(sx, sy, sz)];
        if (entry === undefined) continue;
        const wx = corner.x + x;
        const wy = corner.y + y;
        const wz = corner.z + z;
        if (tx.setBlock(wx, wy, wz, entry)) changed += 1;
        const entity = entities[at(sx, sy, sz)];
        /*
         * Only where the group's own corner landed. Copying it to every cell of
         * an enlarged block would turn one chest into eight, each holding the
         * original's items -- the kind of duplication somebody would take into
         * a world and not notice until it had been shared.
         */
        const representative =
          spec.kind === "divide" ||
          (x % n === 0 && y % n === 0 && z % n === 0);
        if (entity !== null && representative) {
          tx.setBlockEntity(wx, wy, wz, { ...entity, pos: [wx, wy, wz] });
        }
      }
    }
  }
  return changed;
}
