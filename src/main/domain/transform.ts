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

/** Which coordinate is negated: `x` swaps east and west, `z` north and south. */
export type MirrorAxis = "x" | "z";

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

export function mirrorProperties(
  properties: Readonly<Record<string, string>>,
  axis: MirrorAxis,
): Record<string, string> {
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
export function applyRegionTransform(
  doc: SchematicDocument,
  tx: TransactionScope,
  request: RegionSpec,
  transform: RegionTransform,
): number {
  const region = normalizeRegion(doc, request);
  const width = region.maxX - region.minX + 1;
  const length = region.maxZ - region.minZ + 1;

  if (transform.kind === "rotate" && (transform.steps === 1 || transform.steps === 3)) {
    if (width !== length) {
      throw new NotSquareError(width, length);
    }
  }

  /** Where a cell in the region ends up, in region-local coordinates. */
  const move = (x: number, z: number): [number, number] => {
    if (transform.kind === "mirror") {
      return transform.axis === "x" ? [width - 1 - x, z] : [x, length - 1 - z];
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
        return [length - 1 - z, x];
      case 2:
        return [width - 1 - x, length - 1 - z];
      case 3:
        return [z, width - 1 - x];
      default:
        return [x, z];
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

  // No clearing pass first, though one looks prudent. Both a turn and a
  // reflection are bijections on the region, so every destination cell is
  // written by exactly one source and none can keep a stale value; and
  // `setBlock` detaches the block entity of whatever it replaces, so a chest
  // that moved away leaves nothing behind either. Clearing first would only add
  // a second delta for every voxel in the region.
  let changed = 0;
  for (const cell of cells) {
    const [lx, lz] = move(cell.x - region.minX, cell.z - region.minZ);
    const x = region.minX + lx;
    const z = region.minZ + lz;
    if (tx.setBlock(x, cell.y, z, { ...cell.entry, properties: properties(cell.entry.properties) })) {
      changed += 1;
    }
    if (cell.entity !== null) {
      tx.setBlockEntity(x, cell.y, z, { ...cell.entity, pos: [x, cell.y, z] });
    }
  }
  return changed;
}
