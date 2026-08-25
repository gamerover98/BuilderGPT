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
import type { MeshPayload } from "../../shared/ipc.js";
import { loadStructure } from "../pipeline/loader.js";
import type { SchematicFormat } from "../pipeline/loader_formats.js";
import { buildMesh, culledFaces } from "../pipeline/mesher.js";
import { ModelBaker } from "../pipeline/model_baker.js";
import { normalizePalette } from "../pipeline/translate.js";
import {
  paletteEntryCacheKey,
  paletteEntryIsAir,
  type MeshBuffers,
  type PaletteEntry,
  type StructureData,
} from "../pipeline/types.js";
import { toStructureData, type SchematicDocument } from "../domain/document.js";
import { breathe } from "./breathing.js";
import {
  buildChunkedMesh,
  createChunkMeshCache,
  type ChunkMeshCache,
} from "../pipeline/chunked_mesh.js";
import { computeLight } from "../pipeline/lighting.js";

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
  mesh: MeshPayload;
  center: [number, number, number];
  size: [number, number, number];
}

/**
 * The bounding box of some geometry, as `meshToGlb` used to report it.
 *
 * Midpoint and extent, which is what the viewer frames on. Computed here now
 * that nothing builds a container to ask.
 */
function boundsOf(pieces: readonly MeshBuffers[]): {
  center: [number, number, number];
  size: [number, number, number];
} {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const piece of pieces) {
    for (let i = 0; i < piece.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = piece.positions[i + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  }
  if (!Number.isFinite(min[0])) {
    return { center: [0, 0, 0], size: [0, 0, 0] };
  }
  return {
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

/** Geometry and pixels, in the shape the renderer draws from. */
function toMeshPayload(
  pieces: readonly MeshBuffers[],
  keys: readonly number[],
  atlas: ReturnType<typeof buildAtlas>,
  version: number,
): MeshPayload {
  return {
    chunks: pieces.map((piece, index) => ({
      key: keys[index] ?? 0,
      positions: piece.positions,
      normals: piece.normals,
      uvs: piece.uvs,
      indices: piece.indices,
      light: piece.light,
    })),
    // A whole payload says what exists by listing it; there is nothing left
    // over to take down, and no token because nothing here is incremental.
    dropped: [],
    partial: false,
    token: "",
    atlas: {
      width: atlas.image.width,
      height: atlas.image.height,
      pixels: atlas.image.data,
      version,
    },
    atlasVersion: version,
  };
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
  showMarkers: boolean,
): string {
  const hash = createHash("sha256");
  hash.update(schemBytes);
  // The tints are baked into the atlas, so they change the GLB — unlike the
  // rest of PreviewSettings, which the viewer applies without a rebuild.
  hash.update(biomeColor);
  hash.update(SEPARATOR);
  hash.update(waterColor);
  hash.update(SEPARATOR);
  // Same class of input as the tints: it changes the mesh and nothing else in
  // this key would notice, so a preview cached with markers shown would be
  // handed back to a caller that asked for them hidden.
  hash.update(showMarkers ? "markers" : "no-markers");
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
    atlasBuilds += 1;
  }
  return { atlas: entry.atlas, version: entry.atlasTextureCount };
}

/**
 * How many times an atlas has been packed, for the life of the process.
 *
 * A counter exists because the cost of getting this wrong is invisible and
 * enormous. Packing is O(every texture decoded so far), and the texture set
 * grows as blocks are asked for -- so a loop that meshes nine hundred blocks
 * one at a time packs the atlas nine hundred times, over an ever-larger set,
 * and takes 39 seconds to do 1 second of work. Nothing about that reads as a
 * defect from the outside: it is the right picture, slowly.
 *
 * `tests/services.ts` reads this and requires a warm-up to pack **once**.
 */
let atlasBuilds = 0;

export function atlasBuildCount(): number {
  return atlasBuilds;
}

export function clearBakerCache(): void {
  bakers.clear();
}

export interface BuildPreviewOptions {
  /** Whether barriers and structure voids are drawn. Default true. */
  showMarkers?: boolean;
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
  const showMarkers = options.showMarkers !== false;
  const key = cacheKey(
    schemBytes,
    options.resourcePackPath,
    fallbackResourcePackPath,
    biomeColor,
    waterColor,
    showMarkers,
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
  const normalized = showMarkers
    ? normalizePalette(structure, undefined)
    : hideMarkers(normalizePalette(structure, undefined));

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
  const { atlas, version } = cachedAtlas(cached);
  const mesh = buildMesh(faces, atlas.uvRects);
  await warnAboutBlocksWithNoGeometry(normalized, baker, new Set(Object.keys(atlas.uvRects)));
  if (mesh.indices.length === 0) {
    // Raised before anything is assembled: a blank result is not worth
    // caching, and the next attempt may use a different resource pack, which
    // is exactly the fix for this failure.
    throw new EmptyPreviewError(countSolidBlocks(structure));
  }
  const bounds = boundsOf([mesh]);

  const result: CachedPreview = {
    mesh: toMeshPayload([mesh], [0], atlas, version),
    center: bounds.center,
    size: bounds.size,
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
  /**
   * Whether barriers and structure voids are drawn. Default true.
   *
   * See `hideMarkers`. Off is the player's view of the build; on is the
   * builder's, and the builder is who this app is for — which is why the
   * default is the one the game does not give you.
   */
  showMarkers?: boolean;
  /**
   * Whether blocks that glow light the mesh. Default true.
   *
   * Off means every surface sits at full sky light, which is what the viewport
   * looked like before any of this existed. It is the expensive half -- a flood
   * fill over every cell, and a chunk re-meshed wherever the light reached.
   */
  blockLight?: boolean;
  /** Whether corners are darkened by what is buried in them. Default true. */
  occlusion?: boolean;
  /**
   * Whether a vertex averages the light of the four cells around it. Default
   * true.
   *
   * The game's "smooth lighting". Off is flat, per-face light, which is what
   * vanilla looks like with the setting off.
   */
  smoothLighting?: boolean;

  /*
   * Both are part of the mesh cache key, for the same reason the two tints
   * are: they change the geometry and move no revision.
   */
}

/**
 * The structure as it would look to a player: markers turned back into air.
 *
 * Done here rather than in the baker, and that is the load-bearing part. A
 * baker keyed on this flag would be a second baker, a second texture set and a
 * second atlas -- and the block icons, which always draw markers because you
 * have to see what you are picking, would be meshed against the wrong one. The
 * palette is a handful of entries; rewriting the matching ones costs nothing
 * and leaves exactly one atlas in the process.
 */
function hideMarkers(structure: StructureData): StructureData {
  const air: PaletteEntry = { namespacedName: "minecraft:air", properties: {} };
  let touched = false;
  const palette = structure.palette.map((entry) => {
    const name = entry.namespacedName.replace("minecraft:", "");
    // `light` joins the two: it is drawn for the same reason they are -- placed
    // on purpose, invisible in game, and a decision somebody has to be able to
    // review -- so it hides for the same reason too.
    if (name !== "barrier" && name !== "structure_void" && name !== "light") return entry;
    touched = true;
    return air;
  });
  // The arrays are shared with the document on purpose; only rebuild when
  // there was actually a marker to hide.
  return touched ? { ...structure, palette } : structure;
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
  const structure =
    options.showMarkers === false ? hideMarkers(toStructureData(doc)) : toStructureData(doc);

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

  /*
   * Light before geometry, and for the whole structure at once.
   *
   * It cannot be a per-chunk job: a torch lights fifteen blocks in every
   * direction, straight across chunk boundaries, so a chunk cannot know how
   * bright it is without seeing the rest of the document. The chunk cache
   * diffs the result and re-meshes whatever the light actually reached, which
   * is how placing a torch relights the room and nothing else.
   */
  const shading = {
    light: options.blockLight === false ? null : computeLight(structure),
    occlusion: options.occlusion !== false,
    smooth: options.smoothLighting !== false,
  };

  const chunked = await buildChunkedMesh(
    structure,
    cached.baker,
    atlas.uvRects,
    version,
    meshCache ?? createChunkMeshCache(),
    shading,
  );
  await warnAboutBlocksWithNoGeometry(structure, cached.baker, new Set(Object.keys(atlas.uvRects)));
  if (chunked.buffers.indices.length === 0) {
    throw new EmptyPreviewError(countSolidBlocks(structure));
  }
  const bounds = boundsOf(chunked.pieces);
  return {
    mesh: toMeshPayload(chunked.pieces, chunked.pieceKeys, atlas, version),
    center: bounds.center,
    size: bounds.size,
    meshCache: chunked.cache,
    rebuiltChunks: chunked.rebuilt,
    totalChunks: chunked.total,
  };
}

/**
 * Decodes what a set of blocks needs and packs the atlas, once.
 *
 * This is the difference between a one-second warm-up and a thirty-nine-second
 * one, and the reason is entirely in `cachedAtlas` above: the atlas is repacked
 * whenever the texture set grows, and meshing blocks one at a time grows it on
 * almost every block. Measured on the 920-block list with the bundled pack:
 * decoding every texture is ~740 ms, packing the atlas once is ~150 ms, and
 * meshing all 920 against a settled atlas is ~150 ms -- against ~38,750 ms for
 * the same work done in an order that let the atlas move.
 *
 * So the order is the fix, and no amount of concurrency substitutes for it:
 * the work being repeated is quadratic, and the baker's texture map is one
 * mutable object that cannot be shared across threads anyway.
 *
 * A block that fails to bake is skipped rather than fatal. It contributes no
 * texture, so it cannot move the atlas, and whatever is wrong with it will be
 * wrong again where it is actually asked for -- with a message about what it
 * was, which is not something this loop could give.
 */
export async function warmBaker(
  entries: readonly PaletteEntry[],
  options: DocumentPreviewOptions,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<number> {
  const cached = await cachedBaker(
    options.resourcePackPath,
    options.fallbackResourcePackPath ?? null,
    options.biomeColor ?? DEFAULT_BIOME_COLOR,
    options.waterColor ?? DEFAULT_WATER_COLOR,
  );
  for (const [index, entry] of entries.entries()) {
    try {
      await cached.baker.bakeBlockstate(entry);
    } catch {
      // Skipped, for the reason in the note above.
    }
    await breathe(index, entries.length, onProgress);
  }
  return cachedAtlas(cached).version;
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
