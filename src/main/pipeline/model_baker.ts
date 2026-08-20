// Ported from app/pipeline/model_baker.py.
//
// RULEBOOK.md §2 `_bake_with_reader` / `ModelLoader` row (DEV-008, confirmed
// 2026-08-05): the Python method always returned `None` regardless of
// whether the optional `minecraft_model_reader` import succeeded — confirmed
// dead code. `_bake_with_reader` and any `ModelLoader` type are DROPPED
// ENTIRELY in this port, not stubbed. `ModelBaker` goes straight to the
// fallback baker.
//
// RULEBOOK.md §1 "Async model" row: file I/O (reading resource-pack bytes,
// decoding PNGs) is async/`Promise`-based at the I/O boundary. Pure in-memory
// computation (face geometry, hashing, key normalization) stays synchronous.
// RULEBOOK.md §1 "Standard library I/O" row: `fs/promises`, catch-ENOENT-
// rethrow-else — except at the one site inventory.tsv explicitly overrides
// this (see `readBytes` below).
// RULEBOOK.md §1 "Third-party deps" / "Image composition" rows: `pngjs` for
// PNG decode only (no composition needed in this file), `adm-zip` for zip
// reading (sync API is the named, sanctioned exception).
// RULEBOOK.md §1 "Data-object shape" row: interface + free functions, not
// class + getters, for ported `@dataclass`es — applies to `BakedBlock` below.
// RULEBOOK.md §1 "Internal keyed-collection type" row: `Record<string, T>`
// for the texture/palette caches and `_SPECIAL_FACE_RULES`-equivalent table.
// RULEBOOK.md §2 error-recovery rule: every guard in this file's
// inventory.tsv rows is `precondition-guard` (confirmed, no allocation-class
// sites) — collapsed-to-null sentinels below are intentional, not bugs.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { PNG } from "pngjs";

import { DEFAULT_BIOME_COLOR, DEFAULT_WATER_COLOR } from "../../shared/settings.js";
import { shapeFor, type BlockShape, type BoxRotation, type UvWindow } from "./block_shapes.js";
import type { BakedFace, PaletteEntry, RgbaImage } from "./types.js";
import { paletteEntryCacheKey } from "./types.js";

/**
 * `BakedBlock` — ported from `model_baker.py:21-24` (`@dataclass(frozen=True)`).
 * inventory.tsv row `BakedBlock` (model_baker.py:21-23): same
 * immutability-implied-not-enforced pattern as `PaletteEntry` in types.ts —
 * one rulebook-level decision (interface + `readonly` fields, no
 * `Object.freeze`), applied uniformly here, not re-litigated per class.
 */
export interface BakedBlock {
  /**
   * The six cube faces, by direction name. Only populated for full cubes --
   * they are the only shape whose faces can be culled against a neighbour.
   */
  readonly faces: Record<string, BakedFace>;
  /**
   * Geometry emitted unconditionally: every box of a multi-box shape, and the
   * two quads of a cross. A staircase has faces at coordinates its neighbours
   * do not cover, so culling them against a neighbour would be wrong.
   */
  readonly extraFaces: readonly BakedFace[];
  readonly textureKey: string;
  /** False for anything that is not one solid 0..16 box. */
  readonly isFullCube: boolean;
}

const FACE_ORDER = ["north", "south", "east", "west", "up", "down"] as const;
const HORIZONTAL_FACES = ["north", "south", "east", "west"] as const;

/** Suffixes naming a *shape* cut from a material, not a texture of its own. */
const SHAPE_SUFFIXES = [
  "_stairs",
  "_slab",
  "_fence_gate",
  "_fence",
  "_wall",
  "_pane",
  "_button",
  "_pressure_plate",
  "_carpet",
] as const;

/**
 * inventory.tsv row `_SPECIAL_FACE_RULES` (model_baker.py:29-71): the inner
 * keys are a fixed small set ("top"/"side"/"bottom"), not arbitrary strings
 * — an explicit interface says so even though the Python type hint
 * (`Dict[str, Dict[str, list[str]]]`) doesn't.
 */
interface SpecialFaceRule {
  readonly top?: readonly string[];
  readonly side?: readonly string[];
  readonly bottom?: readonly string[];
}

const SPECIAL_FACE_RULES: Record<string, SpecialFaceRule> = {
  /*
   * The markers, and the only two rules here that point at `item/`.
   *
   * Neither block has a block texture, because neither is drawn in the world —
   * what the game has is the icon it shows you in your hand, and that icon is
   * exactly what identifies it here. `normalizeTextureKey` already honours an
   * `item/` prefix, so this needs nothing else.
   */
  barrier: { top: ["item/barrier"], side: ["item/barrier"], bottom: ["item/barrier"] },
  structure_void: {
    top: ["item/structure_void"],
    side: ["item/structure_void"],
    bottom: ["item/structure_void"],
  },
  // The extended arm, which is what `moving_piston` is a picture of.
  moving_piston: { top: ["piston_top"], side: ["piston_side"], bottom: ["piston_side"] },

  // Dirt-like blocks with distinct top/bottom.
  grass_block: { top: ["grass_block_top"], side: ["grass_block_side"], bottom: ["dirt"] },
  podzol: { top: ["podzol_top"], side: ["podzol_side"], bottom: ["dirt"] },
  mycelium: { top: ["mycelium_top"], side: ["mycelium_side"], bottom: ["dirt"] },
  dirt_path: { top: ["dirt_path_top"], side: ["dirt_path_side"], bottom: ["dirt"] },
  grass_path: {
    top: ["dirt_path_top", "grass_path_top"],
    side: ["dirt_path_side", "grass_path_side"],
    bottom: ["dirt"],
  },
  crimson_nylium: { top: ["crimson_nylium"], side: ["crimson_nylium_side"], bottom: ["netherrack"] },
  warped_nylium: { top: ["warped_nylium"], side: ["warped_nylium_side"], bottom: ["netherrack"] },
  snow_block: { top: ["snow"], side: ["snow"], bottom: ["snow"] },

  // Fluids: the block is `water`, the texture is `water_still`. None of the
  // generic candidates (`water_side`, `water_top`, `water`) exists, so water
  // used to fall through to the hashed-colour cube — whose hash for
  // `minecraft:water[level=0]` happens to be a vivid green.
  water: { top: ["water_still"], side: ["water_still"], bottom: ["water_still"] },
  flowing_water: { top: ["water_still"], side: ["water_flow"], bottom: ["water_flow"] },
  bubble_column: { top: ["water_still"], side: ["water_still"], bottom: ["water_still"] },
  lava: { top: ["lava_still"], side: ["lava_still"], bottom: ["lava_still"] },
  flowing_lava: { top: ["lava_still"], side: ["lava_flow"], bottom: ["lava_flow"] },
};

/**
 * Face geometry for an arbitrary box, in place of model_baker.py:283-290's
 * hardcoded unit cube.
 *
 * Positions reproduce the old `_FACE_DEFINITIONS` exactly when the box is
 * 0..1, so full cubes are unchanged. **UVs are not**: the old `_UNIT_UVS`
 * mapped the world-bottom of a face to V=0, but glTF puts V=0 at the *top* of
 * the image, so every side texture was drawn upside down -- visible on
 * `grass_block`, whose green overhang appeared along the bottom edge. The
 * formulas below put V=0 at the top, deliberately diverging from the Python
 * original, which had the same inversion.
 *
 * Deriving UVs from the box coordinates rather than a fixed 0..1 quad is what
 * keeps a slab's side showing the bottom half of its texture instead of the
 * whole tile squashed into half the height.
 */
interface FaceGeometry {
  readonly positions: Float32Array;
  readonly uvs: Float32Array;
  readonly normal: readonly [number, number, number];
}

function boxFaceGeometry(
  box: readonly [number, number, number, number, number, number],
): Record<string, FaceGeometry> {
  const [x0, y0, z0, x1, y1, z1] = box;
  const quad = (...p: number[]) => new Float32Array(p);
  const uv = (...p: number[]) => new Float32Array(p);
  return {
    north: {
      positions: quad(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0),
      uvs: uv(x0, 1 - y0, x1, 1 - y0, x1, 1 - y1, x0, 1 - y1),
      normal: [0, 0, -1],
    },
    south: {
      positions: quad(x1, y0, z1, x0, y0, z1, x0, y1, z1, x1, y1, z1),
      uvs: uv(1 - x1, 1 - y0, 1 - x0, 1 - y0, 1 - x0, 1 - y1, 1 - x1, 1 - y1),
      normal: [0, 0, 1],
    },
    west: {
      positions: quad(x0, y0, z1, x0, y0, z0, x0, y1, z0, x0, y1, z1),
      uvs: uv(1 - z1, 1 - y0, 1 - z0, 1 - y0, 1 - z0, 1 - y1, 1 - z1, 1 - y1),
      normal: [-1, 0, 0],
    },
    east: {
      positions: quad(x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0),
      uvs: uv(z0, 1 - y0, z1, 1 - y0, z1, 1 - y1, z0, 1 - y1),
      normal: [1, 0, 0],
    },
    down: {
      positions: quad(x0, y0, z1, x1, y0, z1, x1, y0, z0, x0, y0, z0),
      uvs: uv(x0, z1, x1, z1, x1, z0, x0, z0),
      normal: [0, -1, 0],
    },
    up: {
      positions: quad(x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1),
      uvs: uv(x0, 1 - z0, x1, 1 - z0, x1, 1 - z1, x0, 1 - z1),
      normal: [0, 1, 0],
    },
  };
}

const UNIT_BOX = [0, 0, 0, 1, 1, 1] as const;

/**
 * Textures Minecraft ships **greyscale** and tints at render time with the
 * biome's grass or foliage colour. Left untinted they come out a flat grey,
 * which is what made grass tops, leaves and vines look washed out next to
 * correctly-coloured dirt and planks. Matched by suffix so modded and
 * per-wood variants are covered without listing every one.
 */
const BIOME_TINTED: readonly string[] = [
  "block/grass_block_top",
  "block/grass_block_side_overlay",
  "block/short_grass",
  "block/grass",
  "block/tall_grass_top",
  "block/tall_grass_bottom",
  "block/fern",
  "block/large_fern_top",
  "block/large_fern_bottom",
  "block/vine",
  "block/lily_pad",
  "block/sugar_cane",
  "block/attached_melon_stem",
  "block/attached_pumpkin_stem",
  "block/melon_stem",
  "block/pumpkin_stem",
];

/**
 * Water ships greyscale too, but takes the biome's **water** colour, which is
 * a different number from the grass/foliage one — hence two settings rather
 * than one. Lava is not tinted: its texture is already orange.
 */
const WATER_TINTED: readonly string[] = [
  "block/water_still",
  "block/water_flow",
  "block/water_overlay",
];

/** Which of the two tints a texture takes, if any. */
function tintKindFor(textureKey: string): "foliage" | "water" | null {
  const path = textureKey.slice(textureKey.indexOf(":") + 1);
  if (WATER_TINTED.includes(path)) {
    return "water";
  }
  return path.endsWith("_leaves") || BIOME_TINTED.includes(path) ? "foliage" : null;
}

function parseHexColor(value: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) {
    return parseHexColor(DEFAULT_BIOME_COLOR);
  }
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Minecraft stores an animated block texture as its frames stacked vertically
 * in one file — `lantern.png` is 16x48, three frames of 16x16 — with the
 * timing in a sibling `.mcmeta`. Anything downstream that treats the file as a
 * single image gets a squashed, unusable strip: the atlas resizes it to a
 * square tile, so a lantern's UV windows then address the wrong pixels
 * entirely. Taking frame 0 is the still-image equivalent and is what a preview
 * wants.
 *
 * Detected by shape rather than by reading the `.mcmeta`: block textures are
 * square by convention, so a height that is an exact multiple of the width is
 * the animation layout and nothing else.
 */
function firstAnimationFrame(image: RgbaImage): RgbaImage {
  const { width, height } = image;
  if (height <= width || height % width !== 0) {
    return image;
  }
  return { width, height: width, data: image.data.slice(0, width * width * 4) };
}

/**
 * Applies a vanilla model element's `rotation` to a baked face.
 *
 * Boxes are axis-aligned by construction, so a tilt cannot be expressed in the
 * box bounds — it has to move the vertices. Normals are rotated with them, or
 * a leaning wall torch would be lit as though it stood upright.
 */
function tiltFace(face: BakedFace, rotation: BoxRotation): BakedFace {
  const radians = (rotation.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // The origin is stated in the model's 0..16 units; positions are 0..1.
  const [ox, oy, oz] = rotation.origin.map((n) => n / 16);

  const spin = (x: number, y: number, z: number): [number, number, number] => {
    switch (rotation.axis) {
      case "x":
        return [x, y * cos - z * sin, y * sin + z * cos];
      case "y":
        return [x * cos + z * sin, y, -x * sin + z * cos];
      default:
        return [x * cos - y * sin, x * sin + y * cos, z];
    }
  };

  const positions = new Float32Array(face.positions.length);
  for (let i = 0; i < face.positions.length; i += 3) {
    const [x, y, z] = spin(
      face.positions[i] - ox,
      face.positions[i + 1] - oy,
      face.positions[i + 2] - oz,
    );
    positions[i] = x + ox;
    positions[i + 1] = y + oy;
    positions[i + 2] = z + oz;
  }
  const normal = spin(face.normal[0], face.normal[1], face.normal[2]);
  return { positions, uvs: face.uvs.slice(), normal, textureKey: face.textureKey };
}

/** Multiplies RGB by the tint, the same operation the game's shader performs. */
function applyTint(image: RgbaImage, tint: readonly [number, number, number]): RgbaImage {
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < image.data.length; i += 4) {
    data[i] = (image.data[i] * tint[0]) / 255;
    data[i + 1] = (image.data[i + 1] * tint[1]) / 255;
    data[i + 2] = (image.data[i + 2] * tint[2]) / 255;
    data[i + 3] = image.data[i + 3];
  }
  return { width: image.width, height: image.height, data };
}

/**
 * A vanilla model's explicit `uv` window, `[u0, v0, u1, v1]` in the tile's
 * 0..16 space with V already running downward, expanded to the four corners in
 * the same vertex order `boxFaceGeometry` emits.
 */
function windowUvsFrom(window: readonly [number, number, number, number]): Float32Array {
  const [u0, v0, u1, v1] = window.map((n) => n / 16) as [number, number, number, number];
  return new Float32Array([u0, v1, u1, v1, u1, v0, u0, v0]);
}

/**
 * Thin wrapper around either a directory or `.zip` resource pack.
 * Ported from `_ResourcePackSource` (model_baker.py:74-100). Not exported —
 * module-private, matching the Python leading-underscore convention.
 */
class ResourcePackSource {
  private constructor(
    private readonly rootPath: string,
    private readonly isDir: boolean,
    private readonly zip: AdmZip | null,
  ) {}

  static async create(rootPath: string): Promise<ResourcePackSource> {
    // RULEBOOK §1 "Standard library I/O" row: stat, not existsSync (TOCTOU).
    const stat = await fs.stat(rootPath).catch(() => null);
    const isDir = stat !== null && stat.isDirectory();
    // SAFETY: adm-zip's constructor synchronously loads the whole zip into
    // memory — RULEBOOK §1 names adm-zip as the sync-API sanctioned
    // exception for zip reading, specifically because this matches the
    // source's own `zipfile.ZipFile(str(path))` usage pattern.
    const zip = isDir ? null : new AdmZip(rootPath);
    return new ResourcePackSource(rootPath, isDir, zip);
  }

  /**
   * Ported from `read_bytes` (model_baker.py:84-100).
   * inventory.tsv row `ResourcePackTextures.read_bytes`: collapses three
   * causes (file missing, OSError-on-read, missing zip entry) into one
   * `null` — confirmed precondition-guard, intentional. This OVERRIDES the
   * general fs-convention row (RULEBOOK §1, catch-ENOENT-rethrow-else) for
   * this specific site: the inventory row is authoritative per §2's
   * delegating rule, and here the source's own `except OSError: return None`
   * is broader than ENOENT alone, so every read error collapses to `null`,
   * not just missing-file.
   */
  async readBytes(relativePath: string): Promise<Uint8Array | null> {
    const normalized = relativePath.replace(/\\/g, "/");
    if (this.isDir) {
      const filePath = path.join(this.rootPath, relativePath);
      try {
        return await fs.readFile(filePath);
      } catch {
        return null;
      }
    }
    if (this.zip === null) {
      return null;
    }
    const entry = this.zip.getEntry(normalized);
    if (entry === null) {
      return null;
    }
    try {
      return entry.getData();
    } catch {
      return null;
    }
  }
}

function splitTextureKey(textureKey: string): [namespace: string, texturePath: string] {
  let namespace = "minecraft";
  let texturePath = textureKey;
  if (textureKey.includes(":")) {
    const idx = textureKey.indexOf(":");
    namespace = textureKey.slice(0, idx);
    texturePath = textureKey.slice(idx + 1);
  }
  texturePath = texturePath.trim().replace(/^\/+/, "").replace(/\\/g, "/");
  if (texturePath.startsWith("textures/")) {
    texturePath = texturePath.slice("textures/".length);
  }
  if (texturePath.endsWith(".png")) {
    texturePath = texturePath.slice(0, -4);
  }
  return [namespace, texturePath];
}

function candidatePaths(namespace: string, texturePath: string): string[] {
  const relPaths: string[] = [];
  const primary = `assets/${namespace}/textures/${texturePath}.png`;
  relPaths.push(primary);
  const alternative = `assets/${namespace}/${texturePath}.png`;
  if (alternative !== primary) {
    relPaths.push(alternative);
  }
  return relPaths;
}


/**
 * Utility that fetches textures from user-supplied or bundled resource
 * packs. Ported from `ResourcePackTextures` (model_baker.py:103-194).
 *
 * Construction does I/O (stat, possibly zip load, possibly a `readdir` for
 * the fallback pack) — RULEBOOK §1's async-model row requires that at the
 * I/O boundary, and a constructor can't be async, so this uses a static
 * async factory (`create`) instead of a public constructor.
 */
export class ResourcePackTextures {
  private readonly sources: ResourcePackSource[];
  // RULEBOOK §1 "Internal keyed-collection type" row: Record, not Map — this
  // dict is one of the row's own named examples ("texture ... caches").
  private readonly cache: Record<string, RgbaImage> = {};
  private readonly missing = new Set<string>();

  private constructor(sources: ResourcePackSource[]) {
    this.sources = sources;
  }

  /**
   * Sources are consulted in order, so a user-supplied pack that only covers
   * some blocks still falls back to the bundled one for the rest — the layering
   * the Python original got from `_discover_fallback`.
   *
   * Both paths are supplied by the caller. This used to discover the bundled
   * pack itself by walking up from `import.meta.url` to find `public/*.zip`,
   * which broke as soon as the main process was bundled into a single file (see
   * `services/resources.ts`'s `defaultResourcePackPath`). Passing it in also
   * keeps this module free of any Electron import, so it stays testable
   * headlessly.
   */
  static async create(
    primaryPath: string | null,
    fallbackPath: string | null = null,
  ): Promise<ResourcePackTextures> {
    const sources: ResourcePackSource[] = [];
    const seen = new Set<string>();

    for (const candidate of [primaryPath, fallbackPath]) {
      if (!candidate) {
        continue;
      }
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) {
        // The user picked the bundled pack explicitly; don't load it twice.
        continue;
      }
      const exists = await fs
        .stat(candidate)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        sources.push(await ResourcePackSource.create(candidate));
        seen.add(resolved);
      }
    }

    return new ResourcePackTextures(sources);
  }

  get hasSources(): boolean {
    return this.sources.length > 0;
  }

  /**
   * Ported from `load_texture` (model_baker.py:148-171).
   * inventory.tsv row: collapses "not found in any source" and "found but
   * failed to decode" into one `null` — confirmed intentional (best-effort
   * multi-candidate lookup; a decode failure on one candidate must not
   * abort the search for the next candidate/source).
   */
  async loadTexture(textureKey: string): Promise<RgbaImage | null> {
    if (textureKey in this.cache) {
      return this.cache[textureKey];
    }
    if (this.missing.has(textureKey) || this.sources.length === 0) {
      return null;
    }

    const [namespace, texturePath] = splitTextureKey(textureKey);
    const relCandidates = candidatePaths(namespace, texturePath);

    for (const relPath of relCandidates) {
      for (const source of this.sources) {
        const data = await source.readBytes(relPath);
        if (data === null) {
          continue;
        }
        let rgba: RgbaImage;
        try {
          // RULEBOOK §1 "Third-party deps" / "Image composition" rows:
          // pngjs decode only — PNG.sync.read always decodes to RGBA8,
          // matching the source's `img.convert("RGBA")`.
          const png = PNG.sync.read(Buffer.from(data));
          rgba = firstAnimationFrame({
            width: png.width,
            height: png.height,
            data: new Uint8Array(png.data),
          });
        } catch {
          continue;
        }
        this.cache[textureKey] = rgba;
        return rgba;
      }
    }

    this.missing.add(textureKey);
    return null;
  }
}

/**
 * Fallback-friendly block baker.
 *
 * Ported from `ModelBaker` (model_baker.py:197-415). The Python class kept
 * an optional `minecraft_model_reader`-backed path
 * (`_bake_with_reader`/`ModelLoader`) that always returned `None` — RULEBOOK
 * §2 confirms this as dead code (DEV-008) and mandates dropping it entirely.
 * This port has NO `_bake_with_reader` method and NO `ModelLoader` type —
 * `bakeBlockstate` goes straight from cache-miss to the fallback baker.
 * (inventory.tsv's `ModelBaker.__init__` row, about the broad
 * `except Exception` around `ModelLoader(...)` construction, is therefore
 * moot too: there is nothing left to construct.)
 */
export class ModelBaker {
  // RULEBOOK §1 Record-over-Map row: both caches below.
  private readonly cache: Record<string, BakedBlock> = {};
  private readonly textureCache: Record<string, RgbaImage> = {};
  private readonly textureSource: ResourcePackTextures;

  private readonly biomeTint: readonly [number, number, number];
  private readonly waterTint: readonly [number, number, number];

  private constructor(
    textureSource: ResourcePackTextures,
    biomeTint: readonly [number, number, number],
    waterTint: readonly [number, number, number],
  ) {
    this.textureSource = textureSource;
    this.biomeTint = biomeTint;
    this.waterTint = waterTint;
  }

  /**
   * Async factory — construction needs `ResourcePackTextures.create`'s I/O
   * (see that class's doc comment for why it can't be a plain constructor).
   *
   * `biomeColor` is a `#rrggbb` string; see `BIOME_TINTED` for what it is
   * multiplied into and why those textures are grey without it.
   */
  static async create(
    resourcePackPath: string | null = null,
    fallbackResourcePackPath: string | null = null,
    biomeColor: string = DEFAULT_BIOME_COLOR,
    waterColor: string = DEFAULT_WATER_COLOR,
  ): Promise<ModelBaker> {
    const textureSource = await ResourcePackTextures.create(resourcePackPath, fallbackResourcePackPath);
    return new ModelBaker(textureSource, parseHexColor(biomeColor), parseHexColor(waterColor));
  }

  get textures(): Readonly<Record<string, RgbaImage>> {
    return this.textureCache;
  }

  /**
   * Ported from `bake_blockstate` (model_baker.py:220-229).
   * inventory.tsv row `ModelBaker.bake_blockstate cache`: the cache is
   * keyed ONLY by `paletteEntryCacheKey(entry)` (types.ts) — the sole
   * sanctioned cache key everywhere `BakedBlock` is memoized. A second
   * ad-hoc key format anywhere would silently fragment the cache.
   */
  async bakeBlockstate(entry: PaletteEntry): Promise<BakedBlock> {
    const cacheKey = paletteEntryCacheKey(entry);
    if (cacheKey in this.cache) {
      return this.cache[cacheKey];
    }

    // RULEBOOK §2 `_bake_with_reader` row (DEV-008): dropped entirely, go
    // straight to the fallback baker.
    const baked = await this.bakeFallback(entry);
    this.cache[cacheKey] = baked;
    return baked;
  }

  private async bakeFallback(entry: PaletteEntry): Promise<BakedBlock> {
    const shape = shapeFor(entry);
    if (shape.kind === "invisible") {
      // Nothing to draw and nothing to cull against — `barrier` is the reason
      // this exists (see block_shapes.ts).
      return { faces: {}, extraFaces: [], textureKey: "", isFullCube: false };
    }

    const texturedFaces = await this.cubeFaceTextures(entry);
    if (texturedFaces !== null) {
      // inventory.tsv row `_cube_face_textures` (6-way first-non-null-wins
      // chain): `??` chain is a direct fit — texture keys are never empty
      // strings (normalizeTextureKey always produces a non-empty
      // "namespace:path"), so `??` vs `||` doesn't diverge here.
      const primaryKey =
        texturedFaces.north ??
        texturedFaces.east ??
        texturedFaces.west ??
        texturedFaces.south ??
        texturedFaces.up ??
        texturedFaces.down;
      if (primaryKey) {
        return await this.bakeShape(shape, primaryKey, texturedFaces);
      }
    }
    return await this.hashedColorCube(entry, shape);
  }

  /**
   * Resolves a `ShapeBox`'s own texture (a beacon's glass shell, say). Falls
   * back to the block's texture if the pack does not have it, so an override
   * can never make a block disappear.
   */
  private async resolveBoxTexture(name: string | undefined, fallback: string): Promise<string> {
    if (name === undefined) {
      return fallback;
    }
    const key = ModelBaker.normalizeTextureKey(name);
    return (await this.ensureTextureCached(key)) ? key : fallback;
  }

  /** Turns a `BlockShape` into geometry, once its textures are known. */
  private async bakeShape(
    shape: BlockShape,
    primaryKey: string,
    faceKeys: Record<string, string>,
  ): Promise<BakedBlock> {
    if (shape.kind === "cube") {
      return {
        faces: ModelBaker.boxFaces(UNIT_BOX, primaryKey, faceKeys),
        extraFaces: [],
        textureKey: primaryKey,
        isFullCube: true,
      };
    }

    if (shape.kind === "cross") {
      return {
        faces: {},
        extraFaces: ModelBaker.crossFaces(primaryKey),
        textureKey: primaryKey,
        isFullCube: false,
      };
    }

    if (shape.kind !== "boxes") {
      // `invisible` is handled before textures are ever resolved; reaching
      // here would mean a new shape kind was added without a branch.
      return { faces: {}, extraFaces: [], textureKey: primaryKey, isFullCube: false };
    }

    const extraFaces: BakedFace[] = [];
    for (const part of shape.boxes) {
      // block_shapes.ts works in Minecraft's 0..16 model units; the mesher
      // works in 0..1 block units.
      const scaled: [number, number, number, number, number, number] = [
        part.box[0] / 16,
        part.box[1] / 16,
        part.box[2] / 16,
        part.box[3] / 16,
        part.box[4] / 16,
        part.box[5] / 16,
      ];
      const boxKey = await this.resolveBoxTexture(part.texture, primaryKey);
      // A box with its own texture uses it on every face; a face override map
      // aimed at the block's own textures would not apply to it.
      const boxFaceKeys = part.texture === undefined ? faceKeys : {};
      const all = ModelBaker.boxFaces(scaled, boxKey, boxFaceKeys, part.uv);
      for (const name of part.omit ?? []) {
        delete all[name];
      }
      const built = Object.values(all);
      extraFaces.push(
        ...(part.rotation ? built.map((face) => tiltFace(face, part.rotation!)) : built),
      );
    }
    return { faces: {}, extraFaces, textureKey: primaryKey, isFullCube: false };
  }

  /**
   * Two diagonal quads, vanilla's shape for flowers, grass and saplings. They
   * are drawn from both sides — the glTF material is `doubleSided` — so a
   * flower is not invisible from half the compass.
   */
  private static crossFaces(textureKey: string): BakedFace[] {
    const s = Math.SQRT1_2;
    const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
    return [
      {
        positions: new Float32Array([0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0]),
        uvs: uvs.slice(),
        normal: [-s, 0, s],
        textureKey,
      },
      {
        positions: new Float32Array([1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0]),
        uvs: uvs.slice(),
        normal: [-s, 0, -s],
        textureKey,
      },
    ];
  }

  private async hashedColorCube(entry: PaletteEntry, shape: BlockShape): Promise<BakedBlock> {
    const textureKey = paletteEntryCacheKey(entry);
    if (!(textureKey in this.textureCache)) {
      const color = ModelBaker.colorFromKey(textureKey);
      const tile = new Uint8Array(16 * 16 * 4);
      for (let i = 0; i < tile.length; i += 4) {
        tile[i] = color[0];
        tile[i + 1] = color[1];
        tile[i + 2] = color[2];
        tile[i + 3] = color[3];
      }
      this.textureCache[textureKey] = { width: 16, height: 16, data: tile };
    }

    // The colour stands in for a texture, but the *shape* is still known, so a
    // fence whose texture could not be resolved is at least fence-shaped.
    return await this.bakeShape(shape, textureKey, {});
  }

  private static colorFromKey(key: string): [number, number, number, number] {
    const digest = createHash("sha1").update(key, "utf8").digest();
    // Mix with a lighter base so even dark blocks remain visible.
    const r = (digest[0] + 64) % 256;
    const g = (digest[1] + 64) % 256;
    const b = (digest[2] + 64) % 256;
    return [r, g, b, 255];
  }

  /**
   * Ported from `_unit_cube_faces` (model_baker.py:277-302).
   * inventory.tsv row: `face_overrides: Optional[Mapping[str,str]] = None`
   * — TS optional param, `undefined` means "omitted" (use `textureKey` for
   * every face), matching the default-parameter site at
   * model_baker.py:264 (`_unit_cube_faces(texture_key)`, no override).
   * TODO(port): the inventory row also asks whether the port should accept
   * an explicit `null` as equivalent to omitted (Python callers can pass
   * `None` explicitly, same as omitting) — no rulebook row settles this.
   * Current signature only accepts `undefined`/omission; an explicit
   * `null` argument is a type error, not silently treated as "no override".
   */
  private static boxFaces(
    box: readonly [number, number, number, number, number, number],
    textureKey: string,
    faceOverrides?: Record<string, string>,
    uvOverrides?: Readonly<Record<string, UvWindow>>,
  ): Record<string, BakedFace> {
    const faces: Record<string, BakedFace> = {};
    for (const [name, definition] of Object.entries(boxFaceGeometry(box))) {
      // inventory.tsv row `_unit_cube_faces` nested-default-chain: written
      // as explicit statements (per-face override, else the generic "side"
      // override, else the plain texture key), NOT a nested ternary, so the
      // fallback order stays reviewable at a glance (confirmed correct in
      // stress-test round 1's pilot).
      let key: string;
      if (faceOverrides !== undefined && faceOverrides[name] !== undefined) {
        key = faceOverrides[name];
      } else if (faceOverrides !== undefined && faceOverrides.side !== undefined) {
        key = faceOverrides.side;
      } else {
        key = textureKey;
      }
      const window = uvOverrides?.[name];
      faces[name] = {
        positions: definition.positions.slice(),
        // An explicit window replaces the coordinate-derived UVs entirely: it
        // is given in the tile's own 0..16 space, in glTF's V-down convention,
        // exactly as a vanilla model states it.
        uvs: window ? windowUvsFrom(window) : definition.uvs.slice(),
        normal: definition.normal,
        textureKey: key,
      };
    }
    return faces;
  }

  /**
   * Ported from `_cube_face_textures` (model_baker.py:307-348).
   * inventory.tsv row: returns `null` when zero candidate textures resolved
   * for any face — a distinct "nothing at all found" sentinel from the
   * two-cause sentinels on `readBytes`/`loadTexture` above. Caller
   * (`bakeFallback`) already treats null identically to "no textured
   * faces", matching the source.
   */
  private async cubeFaceTextures(entry: PaletteEntry): Promise<Record<string, string> | null> {
    if (!this.textureSource.hasSources) {
      return null;
    }

    const baseName = entry.namespacedName.split(":").pop() ?? entry.namespacedName;
    const faces: Record<string, string> = {};

    for (const face of FACE_ORDER) {
      const candidates = ModelBaker.faceCandidates(entry, baseName, face);
      for (const candidate of candidates) {
        const textureKey = ModelBaker.normalizeTextureKey(candidate);
        if (await this.ensureTextureCached(textureKey)) {
          faces[face] = textureKey;
          break;
        }
      }
    }

    if (Object.keys(faces).length === 0) {
      return null;
    }

    const fallback = FACE_ORDER.map((face) => faces[face]).find((key) => key !== undefined);
    for (const face of FACE_ORDER) {
      if (faces[face] === undefined && fallback !== undefined) {
        faces[face] = fallback;
      }
    }

    // inventory.tsv row `PaletteEntry.properties consumer`: "axis" is a
    // known key read out of the generic property bag (values "x"/"y"/"z").
    const axis = entry.properties.axis;
    if (axis === "x" || axis === "y" || axis === "z") {
      const topKey = faces.up;
      const bottomKey = faces.down;
      const sideKey = faces.north;
      if (axis === "x") {
        faces.east = topKey;
        faces.west = topKey;
        faces.up = sideKey;
        faces.down = sideKey;
      } else if (axis === "z") {
        faces.north = topKey;
        faces.south = topKey;
        faces.up = sideKey;
        faces.down = sideKey;
      } else {
        // axis === "y"
        faces.up = topKey;
        faces.down = bottomKey;
      }
    }

    return faces;
  }

  /**
   * Blocks whose texture is not derivable from their name at all, because
   * Minecraft draws them as block *entities* rather than from a baked model:
   * their art lives under `textures/entity/`, in a layout and with colours
   * this code has no way to compose. The stand-ins below are the closest
   * plain block texture — a red bed reads as red wool. Without them these
   * blocks fell through to the hashed-colour cube, which is what put the
   * magenta and cyan patches on the render.
   */
  private static entityTextureAlias(entry: PaletteEntry, name: string): string | null {
    // Real entity sheets where the pack ships them. `block_shapes.ts` builds
    // the matching geometry and UV windows; without both halves a bed is just
    // a coloured slab.
    const bed = /^([a-z_]+)_bed$/.exec(name);
    if (bed) return `entity/bed/${bed[1]}`;
    if (name === "chest" || name === "trapped_chest" || name === "ender_chest") {
      const sheet =
        name === "ender_chest" ? "ender" : name === "trapped_chest" ? "trapped" : "normal";
      // A double chest is two blocks, each wearing one half of a wider sheet.
      const type = entry.properties.type;
      const suffix = type === "left" ? "_left" : type === "right" ? "_right" : "";
      return `entity/chest/${sheet}${suffix}`;
    }
    if (name.endsWith("_sign")) {
      const wood = name.replace(/_(?:wall_)?sign$/, "");
      return `entity/signs/${wood}`;
    }

    // No sheet is usable for these: a banner's art is a base plus a stack of
    // pattern layers this code cannot compose, and a shulker box's sheet is
    // laid out for an animated lid. The dyed wool is the honest stand-in.
    const banner = /^([a-z_]+?)_(?:wall_)?banner$/.exec(name);
    if (banner) return `${banner[1]}_wool`;
    const shulker = /^([a-z_]+)_shulker_box$/.exec(name);
    if (shulker) return `${shulker[1]}_wool`;
    return null;
  }

  private static faceCandidates(entry: PaletteEntry, baseName: string, face: string): string[] {
    const normalized = baseName.replace("minecraft:", "");

    const alias = ModelBaker.entityTextureAlias(entry, normalized);
    if (alias) {
      return [alias];
    }

    // Two-block-tall plants and doors carry their half in a property and split
    // their texture accordingly. Without this a peony draws its flowering top
    // on both halves, because the generic `_top` candidate wins for every face.
    const half = entry.properties.half;
    if (half === "upper") {
      return [`${normalized}_top`, `${normalized}_upper`, normalized];
    }
    if (half === "lower") {
      return [`${normalized}_bottom`, `${normalized}_lower`, normalized];
    }

    const rules = SPECIAL_FACE_RULES[normalized];
    if (rules) {
      if (face === "up" && rules.top) {
        return [...rules.top];
      }
      if (face === "down" && rules.bottom) {
        return [...rules.bottom];
      }
      if ((HORIZONTAL_FACES as readonly string[]).includes(face) && rules.side) {
        return [...rules.side];
      }
    }

    let candidates: string[];
    if (face === "up") {
      candidates = [
        `${normalized}_top`,
        `${normalized}_up`,
        `${normalized}_upper`,
        `${normalized}_end`,
        `${normalized}_face`,
        normalized,
      ];
    } else if (face === "down") {
      candidates = [
        `${normalized}_bottom`,
        `${normalized}_down`,
        `${normalized}_lower`,
        `${normalized}_end`,
        `${normalized}_face`,
        normalized,
      ];
    } else {
      // Horizontal faces.
      candidates = [
        `${normalized}_side`,
        `${normalized}_side0`,
        `${normalized}_side1`,
        `${normalized}_front`,
        normalized,
      ];
    }
    return [...candidates, ...ModelBaker.materialCandidates(normalized)];
  }

  /**
   * Shaped blocks borrow the texture of the material they are cut from: there
   * is no `oak_stairs.png`, only `oak_planks.png`, and no `cobblestone_wall.png`,
   * only `cobblestone.png`. Every candidate above fails for those, which sent
   * the 85 stairs, 33 fences, 12 slabs and 8 walls of a village schematic to
   * the hashed-colour fallback — the coloured patches on an otherwise
   * plausible-looking render.
   *
   * The suffix is stripped and several spellings of the base material are
   * offered; which one exists is decided by the resource pack rather than by a
   * hardcoded table of wood types, so a modded or updated pack needs no change
   * here.
   */
  private static materialCandidates(name: string): string[] {
    const stripped = SHAPE_SUFFIXES.reduce(
      (current, suffix) => (current.endsWith(suffix) ? current.slice(0, -suffix.length) : current),
      name.startsWith("wall_") ? name.slice("wall_".length) : name,
    );
    if (stripped === name) {
      return [];
    }
    return [stripped, `${stripped}_planks`, `${stripped}s`, `${stripped}_block`];
  }

  private static normalizeTextureKey(name: string): string {
    let trimmed = name.trim();
    if (!trimmed) {
      return "minecraft:block/missingno";
    }
    if (trimmed.startsWith("#")) {
      trimmed = trimmed.slice(1);
    }
    let namespace = "minecraft";
    let texturePath = trimmed;
    if (trimmed.includes(":")) {
      const idx = trimmed.indexOf(":");
      namespace = trimmed.slice(0, idx);
      texturePath = trimmed.slice(idx + 1);
    }
    texturePath = texturePath.trim().replace(/^\/+/, "").replace(/\\/g, "/");
    if (texturePath.endsWith(".png")) {
      texturePath = texturePath.slice(0, -4);
    }
    if (texturePath.startsWith("textures/")) {
      texturePath = texturePath.slice("textures/".length);
    }
    if (
      !texturePath.startsWith("block/") &&
      !texturePath.startsWith("item/") &&
      // Block entities (beds, chests, signs) live outside `block/`.
      !texturePath.startsWith("entity/")
    ) {
      texturePath = `block/${texturePath}`;
    }
    return `${namespace}:${texturePath}`;
  }

  private async ensureTextureCached(textureKey: string): Promise<boolean> {
    if (textureKey in this.textureCache) {
      return true;
    }
    const texture = await this.textureSource.loadTexture(textureKey);
    if (texture === null) {
      return false;
    }
    // Tinting here rather than at draw time keeps the atlas the single source
    // of colour: the mesh carries no per-vertex tint and the glTF material has
    // no second colour input.
    const kind = tintKindFor(textureKey);
    this.textureCache[textureKey] =
      kind === null
        ? texture
        : applyTint(texture, kind === "water" ? this.waterTint : this.biomeTint);
    return true;
  }
}

// PORT STATUS: confidence=medium todos=2
