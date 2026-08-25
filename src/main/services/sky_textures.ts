/**
 * The sun and the moon, as the resource pack draws them.
 *
 * They live at `textures/environment/`, which is nowhere near the block
 * textures and is never asked for by anything that meshes a block — so this
 * does not go through the baker or the atlas. It is two images, read once,
 * handed to the renderer as pixels. `pack_reader.ts` owns the reader and says
 * why they are pixels.
 *
 * A pack that ships neither is not a failure — `null` means the viewer draws
 * plain squares, which is what it did before this existed.
 */

import { packTextures, toPackTexture } from "./pack_reader.js";
import type { RgbaImage } from "../pipeline/types.js";
import type { PackTexture } from "../../shared/ipc.js";

/**
 * The full moon out of the phase sheet.
 *
 * `moon_phases.png` is eight phases in a four-by-two grid, and the full one is
 * the first. Drawing the whole sheet would put a strip of eight moons in the
 * sky; there is no moon phase to track here, because a schematic has no date.
 */
function fullMoon(sheet: RgbaImage): RgbaImage {
  const width = Math.floor(sheet.width / 4);
  const height = Math.floor(sheet.height / 2);
  if (width <= 0 || height <= 0) return sheet;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const from = y * sheet.width * 4;
    data.set(sheet.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

export async function loadSkyTextures(
  resourcePackPath: string | null,
  fallbackResourcePackPath: string | null,
): Promise<{ sun: PackTexture | null; moon: PackTexture | null }> {
  const textures = await packTextures(resourcePackPath, fallbackResourcePackPath);
  /*
   * Two layouts, because the game changed one and a pack follows the version it
   * was cut for. 1.21.9 moved the sky bodies into `environment/celestial/` and
   * split the phase sheet into one file per phase; before that the sun sat at
   * `environment/sun` beside a single `moon_phases` grid.
   *
   * Tried newest-first and falling through, rather than picking by pack format:
   * a missing texture already means "draw the plain squares", so an unknown
   * layout degrades to what this did before any of it existed. The full moon is
   * named `full_moon` in the new layout and is the first cell of the old sheet.
   */
  const sun =
    (await textures.loadTexture("environment/celestial/sun")) ??
    (await textures.loadTexture("environment/sun"));
  const wholeMoon = await textures.loadTexture("environment/celestial/moon/full_moon");
  const moonSheet = wholeMoon ?? (await textures.loadTexture("environment/moon_phases"));
  return {
    sun: sun === null ? null : toPackTexture(sun),
    // Only the old layout needs cropping: the new one already *is* one moon.
    moon:
      moonSheet === null
        ? null
        : toPackTexture(wholeMoon === null ? fullMoon(moonSheet) : moonSheet),
  };
}

/**
 * The wooden axe, which is what WorldEdit's selection wand is.
 *
 * It marks the paste anchor in the viewport, on all six faces of the cell the
 * anchor occupies — the one thing in the scene that is not a block and is not
 * exported. `item/`, not `block/`: an axe has no block model and no block
 * texture, and what the game has is the icon it shows you in your hand, exactly
 * as with the barrier and the structure void.
 *
 * The legacy path is tried too, because a pre-1.13 pack spells it
 * `items/wood_axe` and someone editing a 1.8 schematic is likely to be using
 * one. `null` means the viewer draws the plain green box without it.
 */
export async function loadAnchorTexture(
  resourcePackPath: string | null,
  fallbackResourcePackPath: string | null,
): Promise<PackTexture | null> {
  const textures = await packTextures(resourcePackPath, fallbackResourcePackPath);
  for (const name of ["item/wooden_axe", "items/wood_axe"]) {
    const image = await textures.loadTexture(name);
    if (image !== null) return toPackTexture(image);
  }
  return null;
}

/** Dropped when the resource pack changes, like every other cached read. */
export { forgetPackTextures as forgetSkyTextures } from "./pack_reader.js";
