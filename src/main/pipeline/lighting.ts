/**
 * How bright each cell is, and how buried each corner is.
 *
 * Two grids and one corner test, all of it the game's own arithmetic:
 *
 * - **block light** spreads from things that glow, losing one level per step.
 * - **sky light** falls straight down a column until something stops it, then
 *   spreads sideways losing a level per step. It is stored separately from
 *   block light because it is the half that *changes with the time of day*:
 *   the viewer dims it and leaves a torch alone, which is what makes a lit
 *   room stay lit at night.
 * - **ambient occlusion** is per vertex, from the three cells that meet at that
 *   corner. Nothing to do with the two grids; it is geometry, not light.
 *
 * ## Why this is in main
 *
 * Occlusion at a vertex depends on the blocks *around* it, and the renderer has
 * no blocks -- it receives geometry. The same is true of light: propagation is
 * a flood fill over the voxel grid. Both have to be baked into the mesh, which
 * means both belong beside the mesher. `preview.showAmbientOcclusion` used to
 * be a viewer setting that changed the intensity of two lights, which is a
 * different thing wearing the same name.
 *
 * ## What crosses to the renderer
 *
 * Three numbers per vertex, packed into the colour attribute: block light, sky
 * light, and occlusion, each 0..1. The material decides what to do with them,
 * which is what lets the time of day move without re-meshing anything.
 */

import { occludesNeighbours } from "./block_shapes.js";
import { paletteEntryIsAir, type PaletteEntry, type StructureData } from "./types.js";

/** The brightest a cell can be, as Minecraft counts it. */
export const MAX_LIGHT = 15;

export interface LightGrid {
  /** 0..15 per cell, from blocks that glow. */
  readonly block: Uint8Array;
  /** 0..15 per cell, from the sky. Dimmed by the viewer, never by this. */
  readonly sky: Uint8Array;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
}

/**
 * What a block emits, by name.
 *
 * A subset, and deliberately so: an unlisted block emits nothing, which is
 * what all but a few dozen of them do. Getting one wrong here is a room that
 * is too dark or too bright, so the list holds the ones whose level is not in
 * doubt rather than every block that has ever glowed.
 *
 * The `lit` cases are the reason this takes an entry and not a name. A furnace
 * that is not burning emits nothing, and `placementState` writes `lit=false`
 * on a placed one -- so reading the name alone would light a village by its
 * cold furnaces.
 */
const EMISSION: Record<string, number> = {
  // 15 — the full-strength sources.
  glowstone: 15,
  sea_lantern: 15,
  lantern: 15,
  shroomlight: 15,
  beacon: 15,
  conduit: 15,
  jack_o_lantern: 15,
  lava: 15,
  campfire: 15,
  redstone_lamp: 15,
  ochre_froglight: 15,
  verdant_froglight: 15,
  pearlescent_froglight: 15,
  end_gateway: 15,
  fire: 15,
  end_portal: 15,
  // 14
  torch: 14,
  wall_torch: 14,
  end_rod: 14,
  // 13
  furnace: 13,
  blast_furnace: 13,
  smoker: 13,
  // 11
  nether_portal: 11,
  // 10
  soul_torch: 10,
  soul_wall_torch: 10,
  soul_lantern: 10,
  soul_campfire: 10,
  crying_obsidian: 10,
  soul_fire: 10,
  // 9
  redstone_ore: 9,
  deepslate_redstone_ore: 9,
  // 7
  enchanting_table: 7,
  ender_chest: 7,
  glow_lichen: 7,
  redstone_torch: 7,
  redstone_wall_torch: 7,
  // 6
  sculk_catalyst: 6,
  // 5
  amethyst_cluster: 5,
  // 4
  large_amethyst_bud: 4,
  // 3
  magma_block: 3,
  medium_amethyst_bud: 2,
  small_amethyst_bud: 1,
  brown_mushroom: 1,
  sculk_sensor: 1,
  brewing_stand: 1,
  dragon_egg: 1,
};

/**
 * Blocks that glow only while `lit`, and what a bare one is.
 *
 * The two lists exist because the game's defaults differ: a bare
 * `minecraft:campfire` is burning and a bare `minecraft:furnace` is not, so one
 * rule for both would either light every cold furnace in a village or put out
 * every campfire.
 *
 * **This is also where pre-1.13 lands.** In 1.8.8–1.12.2 a lit block is a
 * different `ID:DATA` entirely — a furnace is 61 and a burning one is 62, a
 * redstone lamp 123 and a lit one 124 — and the loader has already turned that
 * into `lit=true` through `legacy_blocks.json` by the time anything gets here.
 * So the property is the right key for both eras, and there is nothing legacy
 * to special-case: `62:2` arrives as `furnace[facing=north,lit=true]`.
 */
const LIT_DEFAULT_OFF: ReadonlySet<string> = new Set([
  "furnace",
  "blast_furnace",
  "smoker",
  "redstone_lamp",
  "redstone_ore",
  "deepslate_redstone_ore",
]);

const LIT_DEFAULT_ON: ReadonlySet<string> = new Set([
  "campfire",
  "soul_campfire",
  "redstone_torch",
  "redstone_wall_torch",
]);

/**
 * `minecraft:light`, whose whole purpose is a level you choose.
 *
 * The one block where the number is in the state rather than in the name, and
 * the reason this reads `level` at all. It draws nothing — see
 * `block_shapes.ts` — and lights everything.
 */
function lightBlockLevel(entry: PaletteEntry): number {
  const level = Number.parseInt(entry.properties.level ?? "15", 10);
  if (!Number.isFinite(level)) return MAX_LIGHT;
  return Math.max(0, Math.min(MAX_LIGHT, level));
}

export function blockEmission(entry: PaletteEntry): number {
  const name = entry.namespacedName.split(":").pop() ?? entry.namespacedName;
  if (name === "light") return lightBlockLevel(entry);

  const level = EMISSION[name];
  if (level === undefined) return 0;
  if (LIT_DEFAULT_OFF.has(name) && entry.properties.lit !== "true") return 0;
  if (LIT_DEFAULT_ON.has(name) && entry.properties.lit === "false") return 0;
  return level;
}

/** Whether light stops here. Glass, slabs and fences all let it through. */
function blocksLight(entry: PaletteEntry): boolean {
  return !paletteEntryIsAir(entry) && occludesNeighbours(entry);
}

/**
 * Both light grids for a structure.
 *
 * One pass to seed and two breadth-first fills, which is linear in the number
 * of cells and runs beside the meshing rather than inside it -- light crosses
 * chunk boundaries, so it cannot be computed a chunk at a time.
 */
export function computeLight(struct: StructureData): LightGrid {
  const sizeX = struct.bounds.maxX - struct.bounds.minX + 1;
  const sizeY = struct.bounds.maxY - struct.bounds.minY + 1;
  const sizeZ = struct.bounds.maxZ - struct.bounds.minZ + 1;
  const cells = sizeX * sizeY * sizeZ;

  const block = new Uint8Array(cells);
  const sky = new Uint8Array(cells);
  const solid = new Uint8Array(cells);

  const at = (x: number, y: number, z: number): number => x * sizeY * sizeZ + y * sizeZ + z;

  /*
   * Opacity is asked once per *palette entry*, not once per cell. A structure
   * has a few dozen distinct blocks and millions of cells, and
   * `occludesNeighbours` walks a shape table.
   */
  const opaque = struct.palette.map((entry) => blocksLight(entry));
  const emits = struct.palette.map((entry) => blockEmission(entry));

  const queue: number[] = [];

  // Seed: what glows, and what the sky reaches straight down.
  for (let x = 0; x < sizeX; x += 1) {
    for (let z = 0; z < sizeZ; z += 1) {
      let open = true;
      for (let y = sizeY - 1; y >= 0; y -= 1) {
        const index = at(x, y, z);
        const paletteIndex = struct.voxels[index];
        const isOpaque = opaque[paletteIndex] === true;
        if (isOpaque) {
          solid[index] = 1;
          open = false;
        } else if (open) {
          sky[index] = MAX_LIGHT;
        }
        const emission = emits[paletteIndex] ?? 0;
        if (emission > 0) {
          block[index] = emission;
          queue.push(index);
        }
      }
    }
  }

  spread(block, solid, queue, sizeX, sizeY, sizeZ);

  /*
   * The sky fill is seeded from the *edge* of the open sky, not from all of it.
   *
   * Every open cell in an unroofed column is already at 15, and on an open
   * build that is most of the volume -- half a million of them. Queuing them
   * all was 200ms an edit: each one is dequeued, decomposed into coordinates
   * and asked about six neighbours, only to find every one of them already at
   * 15 and do nothing. The only cells that can spread are the ones next to
   * something dimmer, which is to say next to a solid block or the grid's edge,
   * and there are a few thousand of those.
   */
  const skyQueue: number[] = [];
  const strideX = sizeY * sizeZ;
  for (let index = 0; index < cells; index += 1) {
    if (sky[index] !== MAX_LIGHT) continue;
    const x = (index / strideX) | 0;
    const rest = index - x * strideX;
    const y = (rest / sizeZ) | 0;
    const z = rest - y * sizeZ;
    const edge =
      (x > 0 && solid[index - strideX] === 1) ||
      (x + 1 < sizeX && solid[index + strideX] === 1) ||
      (y > 0 && solid[index - sizeZ] === 1) ||
      (y + 1 < sizeY && solid[index + sizeZ] === 1) ||
      (z > 0 && solid[index - 1] === 1) ||
      (z + 1 < sizeZ && solid[index + 1] === 1);
    if (edge) skyQueue.push(index);
  }
  spread(sky, solid, skyQueue, sizeX, sizeY, sizeZ);

  return { block, sky, sizeX, sizeY, sizeZ };
}

/**
 * Breadth-first, one level lost per step, and never into a solid cell.
 *
 * A plain array used as a FIFO with a moving head rather than `shift()`:
 * shifting a million-entry array is quadratic, and a lit cave is a million
 * entries.
 */
function spread(
  levels: Uint8Array,
  solid: Uint8Array,
  queue: number[],
  sizeX: number,
  sizeY: number,
  sizeZ: number,
): void {
  const strideX = sizeY * sizeZ;
  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head];
    const level = levels[index];
    if (level <= 1) continue;
    const next = level - 1;

    /*
     * Coordinates only to know which of the six neighbours exist; the
     * neighbours themselves are index arithmetic. Written out six times rather
     * than through a closure because this is the inner loop of the inner loop
     * -- a closure allocated per dequeue was most of what made a lit build cost
     * a fifth of a second.
     */
    const x = (index / strideX) | 0;
    const rest = index - x * strideX;
    const y = (rest / sizeZ) | 0;
    const z = rest - y * sizeZ;

    let at = index - strideX;
    if (x > 0 && solid[at] !== 1 && levels[at] < next) {
      levels[at] = next;
      queue.push(at);
    }
    at = index + strideX;
    if (x + 1 < sizeX && solid[at] !== 1 && levels[at] < next) {
      levels[at] = next;
      queue.push(at);
    }
    at = index - sizeZ;
    if (y > 0 && solid[at] !== 1 && levels[at] < next) {
      levels[at] = next;
      queue.push(at);
    }
    at = index + sizeZ;
    if (y + 1 < sizeY && solid[at] !== 1 && levels[at] < next) {
      levels[at] = next;
      queue.push(at);
    }
    at = index - 1;
    if (z > 0 && solid[at] !== 1 && levels[at] < next) {
      levels[at] = next;
      queue.push(at);
    }
    at = index + 1;
    if (z + 1 < sizeZ && solid[at] !== 1 && levels[at] < next) {
      levels[at] = next;
      queue.push(at);
    }
  }
}

/**
 * How dark a corner is, from the three cells that meet at it.
 *
 * The standard voxel rule, and the one vanilla uses: two solid sides fully
 * enclose the corner however the diagonal falls, and otherwise each solid
 * neighbour takes one step off. Returns 0 (buried) to 3 (open).
 */
export function cornerOcclusion(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 0;
  return 3 - (Number(side1) + Number(side2) + Number(corner));
}

/** What each occlusion step is worth as a brightness multiplier. */
export const OCCLUSION_LEVELS = [0.45, 0.65, 0.83, 1] as const;
