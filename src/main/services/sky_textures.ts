/**
 * The sun and the moon, as the resource pack draws them.
 *
 * They live at `textures/environment/`, which is nowhere near the block
 * textures and is never asked for by anything that meshes a block — so this
 * does not go through the baker or the atlas. It is two images, read once,
 * handed to the renderer as pixels.
 *
 * Pixels rather than a PNG for the same reason the atlas is pixels: the
 * renderer's CSP forbids `blob:`, three.js decodes an embedded image through
 * `ImageBitmapLoader`, and a decode that cannot happen fails by rendering white
 * while reporting success. Raw RGBA has nothing to decode.
 *
 * A pack that ships neither is not a failure — `null` means the viewer draws
 * plain squares, which is what it did before this existed.
 */

import { ResourcePackTextures } from "../pipeline/model_baker.js";
import type { RgbaImage } from "../pipeline/types.js";
import type { SkyTexture } from "../../shared/ipc.js";

/** One reader per pack pair, because opening a 17 MB zip is not free. */
let cached: { key: string; textures: ResourcePackTextures } | null = null;

async function reader(
  resourcePackPath: string | null,
  fallbackResourcePackPath: string | null,
): Promise<ResourcePackTextures> {
  const key = `${resourcePackPath ?? ""}\n${fallbackResourcePackPath ?? ""}`;
  if (cached?.key === key) return cached.textures;
  const textures = await ResourcePackTextures.create(resourcePackPath, fallbackResourcePackPath);
  cached = { key, textures };
  return textures;
}

function toSkyTexture(image: RgbaImage): SkyTexture {
  return { width: image.width, height: image.height, pixels: image.data };
}

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
): Promise<{ sun: SkyTexture | null; moon: SkyTexture | null }> {
  const textures = await reader(resourcePackPath, fallbackResourcePackPath);
  const sun = await textures.loadTexture("environment/sun");
  const moonSheet = await textures.loadTexture("environment/moon_phases");
  return {
    sun: sun === null ? null : toSkyTexture(sun),
    moon: moonSheet === null ? null : toSkyTexture(fullMoon(moonSheet)),
  };
}

/** Dropped when the resource pack changes, like every other cached read. */
export function forgetSkyTextures(): void {
  cached = null;
}
