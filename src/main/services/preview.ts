/**
 * Ported from `app/preview.py` (`build_preview`, `PreviewOptions`,
 * `PreviewPayload`) plus `component.py:419-434`'s `_cached_preview`.
 *
 * Two things from the Python version deliberately do not survive
 * (ARCHITECTURE.md §3 "Viewer lifecycle"):
 *
 * 1. **base64.** `preview.py:88-89` encoded the GLB so it could be embedded in
 *    the viewer HTML that Streamlit injected into an iframe. The renderer here
 *    receives the raw bytes over IPC.
 * 2. **The temp directory.** `preview.py:69-87` wrote the schem and the
 *    resource pack to a `TemporaryDirectory` only because `load_structure` and
 *    `ModelBaker` take paths, not bytes. The Electron flow already has real
 *    paths (the file picker returns one), so the round-trip through disk is
 *    gone; callers that only hold bytes write them once, up front.
 *
 * `PreviewPayload.to_viewer_params` is gone entirely -- that dict existed to
 * be JSON-embedded in the viewer template. Its fields are now the typed
 * `PreviewSuccess` in `shared/ipc.ts`.
 */

import { createHash } from "crypto";
import { readFile } from "fs/promises";

import {
  DEFAULT_BIOME_COLOR,
  DEFAULT_WATER_COLOR,
  type PreviewSettings,
} from "../../shared/settings.js";
import { buildAtlas } from "../pipeline/atlas.js";
import { meshToGlb } from "../pipeline/gltf_builder.js";
import { loadStructure } from "../pipeline/loader.js";
import type { SchematicFormat } from "../pipeline/loader_formats.js";
import { buildMesh, culledFaces } from "../pipeline/mesher.js";
import { ModelBaker } from "../pipeline/model_baker.js";
import { normalizePalette } from "../pipeline/translate.js";
import { paletteEntryCacheKey, paletteEntryIsAir, type StructureData } from "../pipeline/types.js";
import { toStructureData, type SchematicDocument } from "../domain/document.js";
import {
  buildChunkedMesh,
  createChunkMeshCache,
  type ChunkMeshCache,
} from "../pipeline/chunked_mesh.js";

/** preview.py:66-67 -- "50 MB is generous for a .schem file". */
export const MAX_SCHEM_BYTES = 50 * 1024 * 1024;

export class PreviewTooLargeError extends Error {
  constructor() {
    super("Schematic too large to preview (over 50 MB)");
    this.name = "PreviewTooLargeError";
  }
}

/**
 * The schematic decoded, but produced no drawable geometry.
 *
 * This used to be the quietest failure in the app: `mesher.ts` drops faces it
 * cannot resolve (an unknown face name, a texture missing from the atlas), and
 * when *every* face drops, `gltf_builder.ts` still emits a structurally valid
 * GLB with zero primitives and a zero bounding box. The renderer parsed it
 * without complaint and drew nothing, so a schematic full of blocks the
 * resource pack could not texture was indistinguishable from a dead button.
 */
export class EmptyPreviewError extends Error {
  constructor(readonly blockCount: number) {
    super(
      blockCount === 0
        ? "The schematic contains no blocks other than air"
        : `The schematic decoded to ${blockCount} block(s) but produced no visible geometry ` +
          `— none of its blocks could be matched to a model in the resource pack`,
    );
    this.name = "EmptyPreviewError";
  }
}

export interface PreviewResult {
  glb: Uint8Array;
  center: [number, number, number];
  size: [number, number, number];
}

/**
 * `@st.cache_data` replacement. Kept for the reason the decorator was there in
 * the first place -- meshing a large schematic is seconds of CPU, and
 * "Re-render" exists precisely to re-run it with the same input.
 *
 * Note the cache key covers only what actually changes the GLB: the schematic
 * bytes and the resource pack. The lighting/camera fields of `PreviewSettings`
 * are consumed by the *viewer*, not the mesher, so including them would
 * needlessly evict on every slider move -- which is also why they are returned
 * alongside the cached GLB rather than baked into it.
 */
const CACHE_LIMIT = 8;

/**
 * Field separator for the cache key, so that two different field splits cannot
 * hash the same ("ab" + "c" must not collide with "a" + "bc").
 *
 * It used to be a literal NUL byte, which works but made git classify this
 * source file as **binary** -- no diffs, no merges, no review on it. A newline
 * separates just as unambiguously here: every field is a hex colour or a
 * filesystem path, and none of them can contain one.
 */
const SEPARATOR = "\n";
type CachedPreview = PreviewResult & {
  format: SchematicFormat;
  unmappedLegacyIds: readonly string[];
};
const cache = new Map<string, CachedPreview>();

function cacheKey(
  schemBytes: Uint8Array,
  resourcePackPath: string | null,
  fallbackResourcePackPath: string | null,
  biomeColor: string,
  waterColor: string,
): string {
  const hash = createHash("sha256");
  hash.update(schemBytes);
  // The tints are baked into the atlas, so they change the GLB — unlike the
  // rest of PreviewSettings, which the viewer applies without a rebuild.
  hash.update(biomeColor);
  hash.update(SEPARATOR);
  hash.update(waterColor);
  hash.update(SEPARATOR);
  // The pack paths, not their bytes: the bundled pack is 17 MB and hashing it
  // on every preview would cost more than the mesh build this cache exists to
  // avoid. Paths are stable identifiers here — the bundled one ships with the
  // app, and a user-picked one changing underneath us mid-session is not a case
  // worth paying that price for.
  hash.update(resourcePackPath ?? "");
  hash.update(SEPARATOR);
  hash.update(fallbackResourcePackPath ?? "");
  return hash.digest("hex");
}

/**
 * Model bakers, kept alive across previews.
 *
 * `ModelBaker.create` opens the resource pack -- 17 MB of zip for the bundled
 * one -- and everything it accumulates afterwards (baked blockstates, decoded
 * textures) is a pure function of the pack and the two tints. So a baker can be
 * reused by any preview that agrees on those four things, which during an
 * editing session means all of them.
 *
 * That is what takes the pack read out of the edit loop: with the baker cached,
 * re-previewing after a change is culling, atlas and mesh, and no I/O at all.
 *
 * The texture set only ever grows, so the atlas is memoised against its size --
 * a count that changes exactly when a block the pack had not been asked for
 * before shows up.
 */
interface CachedBaker {
  baker: ModelBaker;
  atlas: ReturnType<typeof buildAtlas> | null;
  atlasTextureCount: number;
}

const BAKER_CACHE_LIMIT = 3;
const bakers = new Map<string, CachedBaker>();

function bakerKey(
  resourcePackPath: string | null,
  fallbackResourcePackPath: string | null,
  biomeColor: string,
  waterColor: string,
): string {
  return [resourcePackPath ?? "", fallbackResourcePackPath ?? "", biomeColor, waterColor].join(
    SEPARATOR,
  );
}

async function cachedBaker(
  resourcePackPath: string | null,
  fallbackResourcePackPath: string | null,
  biomeColor: string,
  waterColor: string,
): Promise<CachedBaker> {
  const key = bakerKey(resourcePackPath, fallbackResourcePackPath, biomeColor, waterColor);
  const hit = bakers.get(key);
  if (hit) {
    bakers.delete(key);
    bakers.set(key, hit);
    return hit;
  }
  const entry: CachedBaker = {
    baker: await ModelBaker.create(
      resourcePackPath,
      fallbackResourcePackPath,
      biomeColor,
      waterColor,
    ),
    atlas: null,
    atlasTextureCount: -1,
  };
  bakers.set(key, entry);
  while (bakers.size > BAKER_CACHE_LIMIT) {
    const oldest = bakers.keys().next();
    if (oldest.done) break;
    bakers.delete(oldest.value);
  }
  return entry;
}

/**
 * The atlas for whatever the baker has decoded so far, rebuilt only when that
 * grew.
 *
 * The texture count doubles as the atlas's version: it changes exactly when
 * the layout does, which is what `chunked_mesh.ts` needs to know to throw away
 * UVs that address the old one.
 */
function cachedAtlas(entry: CachedBaker): { atlas: ReturnType<typeof buildAtlas>; version: number } {
  const count = Object.keys(entry.baker.textures).length;
  if (entry.atlas === null || entry.atlasTextureCount !== count) {
    entry.atlas = buildAtlas(entry.baker.textures);
    entry.atlasTextureCount = count;
  }
  return { atlas: entry.atlas, version: entry.atlasTextureCount };
}

export function clearBakerCache(): void {
  bakers.clear();
}

export interface BuildPreviewOptions {
  schemPath: string;
  resourcePackPath: string | null;
  /**
   * The bundled pack, used for any texture the user's pack does not provide (or
   * for everything, when they have not picked one). Resolved by the caller —
   * `services/resources.ts`'s `defaultResourcePackPath` — so this module stays
   * free of Electron imports and testable headlessly.
   */
  fallbackResourcePackPath?: string | null;
  /**
   * The vendored pre-1.13 block table, needed only to read legacy MCEdit
   * `.schematic` files. Resolved by the caller for the same reason as the
   * pack paths above: this module imports no Electron.
   */
  legacyBlocksPath?: string | null;
  /** `#rrggbb`; see `PreviewSettings.biomeColor`. */
  biomeColor?: string;
  /** `#rrggbb`; see `PreviewSettings.waterColor`. */
  waterColor?: string;
}

export interface BuildPreviewOutcome extends PreviewResult {
  cached: boolean;
  format: SchematicFormat;
  /** MCEdit only: `id:meta` pairs with no entry in the flattening table. */
  unmappedLegacyIds: readonly string[];
}

/** Non-air voxels, used to tell "empty schematic" from "nothing was drawable". */
function countSolidBlocks(structure: StructureData): number {
  const airIndices = new Set<number>();
  structure.palette.forEach((entry, index) => {
    // `paletteEntryIsAir` rather than a literal: it also covers `cave_air` and
    // `void_air`, which a schematic cut out of a cave is full of.
    if (paletteEntryIsAir(entry)) {
      airIndices.add(index);
    }
  });
  let count = 0;
  for (const index of structure.voxels) {
    if (!airIndices.has(index)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Names palette entries that are present in the voxels but contributed no
 * geometry at all.
 *
 * Two places drop faces without a word: `mesher.ts` skips a face whose name the
 * baked block does not carry, and `buildMesh` skips one whose texture never
 * made it into the atlas. Until now the only alarm was `EmptyPreviewError`, and
 * only when *everything* fell -- so "the walls of my house are missing" left no
 * trace anywhere. This is that trace.
 */
async function warnAboutBlocksWithNoGeometry(
  structure: StructureData,
  baker: ModelBaker,
  atlasUvKeys: ReadonlySet<string>,
): Promise<void> {
  const present = new Set(structure.voxels);
  const silent: string[] = [];
  for (const [index, entry] of structure.palette.entries()) {
    if (!present.has(index) || paletteEntryIsAir(entry)) {
      continue;
    }
    const baked = await baker.bakeBlockstate(entry);
    const keys = [
      ...(baked.isFullCube ? Object.values(baked.faces) : []),
      ...baked.extraFaces,
    ].map((face) => face.textureKey);
    // Not "did this block end up on screen" — a block can legitimately have
    // every face culled by its neighbours. The question is whether it *could*
    // have drawn anything: no faces to emit, or no texture for any of them.
    if (keys.length === 0 || keys.every((key) => !atlasUvKeys.has(key))) {
      silent.push(paletteEntryCacheKey(entry));
    }
  }
  if (silent.length > 0) {
    console.warn(
      `[preview] ${silent.length} block type(s) present in the schematic can draw ` +
        `nothing and are invisible in the preview: ${silent.join(", ")}`,
    );
  }
}

export async function buildPreview(options: BuildPreviewOptions): Promise<BuildPreviewOutcome> {
  const schemBytes = await readFile(options.schemPath);
  if (schemBytes.length > MAX_SCHEM_BYTES) {
    throw new PreviewTooLargeError();
  }
  const fallbackResourcePackPath = options.fallbackResourcePackPath ?? null;

  const biomeColor = options.biomeColor ?? DEFAULT_BIOME_COLOR;
  const waterColor = options.waterColor ?? DEFAULT_WATER_COLOR;
  const key = cacheKey(
    schemBytes,
    options.resourcePackPath,
    fallbackResourcePackPath,
    biomeColor,
    waterColor,
  );
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency (Map preserves insertion order, so re-insert = MRU).
    cache.delete(key);
    cache.set(key, hit);
    return { ...hit, cached: true };
  }

  // preview.py:80-87, same call order, same arguments.
  const structure = await loadStructure(options.schemPath, {
    legacyBlocksPath: options.legacyBlocksPath ?? null,
  });
  // `normalizePalette`'s translator is the still-open `pymctranslate` DI seam
  // (RULEBOOK.md DEV-014's note / translate.ts's TODO(port)). `undefined` is
  // its documented identity behavior, which is also what Python's
  // `normalize_palette` did whenever PyMCTranslate wasn't installed.
  const normalized = normalizePalette(structure, undefined);

  const cached = await cachedBaker(
    options.resourcePackPath,
    fallbackResourcePackPath,
    biomeColor,
    waterColor,
  );
  const baker = cached.baker;
  const faces = await culledFaces(normalized, baker);
  // After culling, not before: `culledFaces` is what asks the baker for each
  // blockstate, so the texture set is only complete once it has run.
  const { atlas } = cachedAtlas(cached);
  const mesh = buildMesh(faces, atlas.uvRects);
  await warnAboutBlocksWithNoGeometry(normalized, baker, new Set(Object.keys(atlas.uvRects)));
  if (mesh.indices.length === 0) {
    // Deliberately raised before `meshToGlb`, which would happily produce a
    // valid-but-blank GLB. Not cached: the next attempt may use a different
    // resource pack, which is exactly the fix for this failure.
    throw new EmptyPreviewError(countSolidBlocks(structure));
  }
  const glb = meshToGlb(mesh, atlas);

  const result: CachedPreview = {
    glb: glb.glbBytes,
    center: [...glb.center] as [number, number, number],
    size: [...glb.size] as [number, number, number],
    format: structure.format,
    unmappedLegacyIds: structure.unmappedLegacyIds,
  };

  cache.set(key, result);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      break;
    }
    cache.delete(oldest.value);
  }

  return { ...result, cached: false };
}

export interface DocumentPreviewOptions {
  resourcePackPath: string | null;
  fallbackResourcePackPath?: string | null;
  biomeColor?: string;
  waterColor?: string;
}

export interface DocumentPreviewResult extends PreviewResult {
  /** Hand this back on the next call to re-mesh only what changed. */
  meshCache: ChunkMeshCache;
  rebuiltChunks: number;
  totalChunks: number;
}

/**
 * The same pipeline, driven from an open document rather than a file.
 *
 * This is the edit loop: no read, no decode, no `loadStructure`, and -- thanks
 * to the baker cache above -- no resource pack either. What is left is the work
 * that genuinely depends on the blocks having changed.
 *
 * There is no content cache here on purpose. `buildPreview` hashes the file
 * bytes because the same file gets previewed repeatedly; a document is
 * previewed because it just changed, so a cache keyed on its contents would
 * miss every time and cost a hash of the whole grid to find that out. The
 * caller has `doc.revision`, which answers "is my last mesh still current" for
 * free.
 */
export async function buildDocumentPreview(
  doc: SchematicDocument,
  options: DocumentPreviewOptions,
  meshCache?: ChunkMeshCache,
): Promise<DocumentPreviewResult> {
  const cached = await cachedBaker(
    options.resourcePackPath,
    options.fallbackResourcePackPath ?? null,
    options.biomeColor ?? DEFAULT_BIOME_COLOR,
    options.waterColor ?? DEFAULT_WATER_COLOR,
  );
  const structure = toStructureData(doc);

  /*
   * The atlas has to exist before the chunks are meshed, because their UVs
   * address it -- but it only knows about a block once the baker has been
   * asked for it, and that is what culling does. So the first pass over a
   * document primes the baker, and the atlas built after it is complete.
   *
   * Only the first pass: `cachedAtlas` rebuilds nothing when the texture set
   * has not grown, and `buildChunkedMesh` re-meshes nothing when no voxel has
   * moved, so the steady-state cost of an edit is the chunks it touched.
   */
  await primeBaker(structure, cached.baker);
  const { atlas, version } = cachedAtlas(cached);

  const chunked = await buildChunkedMesh(
    structure,
    cached.baker,
    atlas.uvRects,
    version,
    meshCache ?? createChunkMeshCache(),
  );
  await warnAboutBlocksWithNoGeometry(structure, cached.baker, new Set(Object.keys(atlas.uvRects)));
  if (chunked.buffers.indices.length === 0) {
    throw new EmptyPreviewError(countSolidBlocks(structure));
  }
  const glb = meshToGlb(chunked.buffers, atlas);
  return {
    glb: glb.glbBytes,
    center: [...glb.center] as [number, number, number],
    size: [...glb.size] as [number, number, number],
    meshCache: chunked.cache,
    rebuiltChunks: chunked.rebuilt,
    totalChunks: chunked.total,
  };
}

/**
 * Makes sure the baker has decoded every block the structure uses.
 *
 * Cheaper than it looks: `bakeBlockstate` is memoised per blockstate, so this
 * is one bake per *distinct* block and a map lookup for the rest, however many
 * voxels there are.
 */
async function primeBaker(structure: StructureData, baker: ModelBaker): Promise<void> {
  const present = new Set(structure.voxels);
  for (const [index, entry] of structure.palette.entries()) {
    if (present.has(index) && !paletteEntryIsAir(entry)) {
      await baker.bakeBlockstate(entry);
    }
  }
}

/**
 * component.py:331-332 applied `math.radians` when constructing
 * `PreviewOptions`; the UI holds degrees, the viewer wants radians, and this
 * is the same single conversion point.
 */
export function sunAnglesRadians(settings: PreviewSettings): { azimuth: number; elevation: number } {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  return {
    azimuth: toRad(settings.sunAzimuthDeg),
    elevation: toRad(settings.sunElevationDeg),
  };
}

export function clearPreviewCache(): void {
  cache.clear();
}
