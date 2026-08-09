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
  readonly faces: Record<string, BakedFace>;
  readonly textureKey: string;
}

const FACE_ORDER = ["north", "south", "east", "west", "up", "down"] as const;
const HORIZONTAL_FACES = ["north", "south", "east", "west"] as const;

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
};

/** Unit-cube face geometry, counter-clockwise winding — model_baker.py:283-290. */
const FACE_DEFINITIONS: Record<string, { positions: Float32Array; normal: readonly [number, number, number] }> = {
  north: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), normal: [0.0, 0.0, -1.0] },
  south: { positions: new Float32Array([1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1]), normal: [0.0, 0.0, 1.0] },
  west: { positions: new Float32Array([0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1]), normal: [-1.0, 0.0, 0.0] },
  east: { positions: new Float32Array([1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0]), normal: [1.0, 0.0, 0.0] },
  down: { positions: new Float32Array([0, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0]), normal: [0.0, -1.0, 0.0] },
  up: { positions: new Float32Array([0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1]), normal: [0.0, 1.0, 0.0] },
};
const UNIT_UVS = new Float32Array([0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]);

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
          rgba = { width: png.width, height: png.height, data: new Uint8Array(png.data) };
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

  private constructor(textureSource: ResourcePackTextures) {
    this.textureSource = textureSource;
  }

  /**
   * Async factory — construction needs `ResourcePackTextures.create`'s I/O
   * (see that class's doc comment for why it can't be a plain constructor).
   */
  static async create(
    resourcePackPath: string | null = null,
    fallbackResourcePackPath: string | null = null,
  ): Promise<ModelBaker> {
    const textureSource = await ResourcePackTextures.create(resourcePackPath, fallbackResourcePackPath);
    return new ModelBaker(textureSource);
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
        const cubeFaces = ModelBaker.unitCubeFaces(primaryKey, texturedFaces);
        return { faces: cubeFaces, textureKey: primaryKey };
      }
    }
    return this.hashedColorCube(entry);
  }

  private hashedColorCube(entry: PaletteEntry): BakedBlock {
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

    const cubeFaces = ModelBaker.unitCubeFaces(textureKey);
    return { faces: cubeFaces, textureKey };
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
  private static unitCubeFaces(
    textureKey: string,
    faceOverrides?: Record<string, string>,
  ): Record<string, BakedFace> {
    const faces: Record<string, BakedFace> = {};
    for (const [name, definition] of Object.entries(FACE_DEFINITIONS)) {
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
      faces[name] = {
        positions: definition.positions.slice(),
        uvs: UNIT_UVS.slice(),
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
      const candidates = ModelBaker.faceCandidates(baseName, face);
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

  private static faceCandidates(baseName: string, face: string): string[] {
    const normalized = baseName.replace("minecraft:", "");
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

    if (face === "up") {
      return [
        `${normalized}_top`,
        `${normalized}_up`,
        `${normalized}_upper`,
        `${normalized}_end`,
        `${normalized}_face`,
        normalized,
      ];
    }
    if (face === "down") {
      return [
        `${normalized}_bottom`,
        `${normalized}_down`,
        `${normalized}_lower`,
        `${normalized}_end`,
        `${normalized}_face`,
        normalized,
      ];
    }
    // Horizontal faces.
    return [`${normalized}_side`, `${normalized}_side0`, `${normalized}_side1`, `${normalized}_front`, normalized];
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
    if (!texturePath.startsWith("block/") && !texturePath.startsWith("item/")) {
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
    this.textureCache[textureKey] = texture;
    return true;
  }
}

// PORT STATUS: confidence=medium todos=2
