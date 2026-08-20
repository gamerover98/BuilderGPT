/**
 * One block, meshed on its own, so the inventory can draw it.
 *
 * The creative inventory shows blocks as they look, not as names — a stairs
 * block has to *be* a stairs block on screen. That geometry is described in
 * `pipeline/block_shapes.ts`, which lives in main and cannot be imported by the
 * renderer, so the icons are built here and the geometry crosses the boundary
 * the same way the viewport's does.
 *
 * ## It is the same pipeline, on a 1x1x1 document
 *
 * Not a second mesher, not a table of pre-rendered sprites. A one-block
 * document goes through `buildDocumentPreview` exactly as an open schematic
 * does, which means an icon cannot disagree with what appears in the viewport
 * when the block is placed. A stand-in built by other means would drift the
 * moment `block_shapes.ts` gained a shape — and drift silently, because nothing
 * compares the two.
 *
 * Face culling removes nothing here: a lone block has all six faces exposed,
 * which is what an icon wants.
 *
 * ## Cached, because the answer never changes
 *
 * A block's geometry depends on the block and on the texture atlas, and the
 * atlas has a version already. So the cache is keyed on both and a scroll
 * through the inventory re-meshes nothing it has seen. Without it, sixty
 * one-block documents would be built per row of scrolling.
 */

import { createDocument, setBlock, type SchematicDocument } from "../domain/document.js";
import { parsePaletteEntry } from "../pipeline/loader_formats.js";
import type { ChunkGeometry, MeshAtlas } from "../../shared/ipc.js";
import { buildDocumentPreview, type DocumentPreviewOptions } from "./preview.js";

export interface BlockIcon {
  block: string;
  /**
   * The block's geometry, or `null` when it meshed to nothing.
   *
   * Air does, and so does anything the mesher declines to draw. `null` rather
   * than an empty geometry so the renderer can show a placeholder instead of an
   * invisible tile that looks like a failure to load.
   */
  geometry: ChunkGeometry | null;
}

export interface BlockIconsResult {
  icons: BlockIcon[];
  /** Omitted when the caller already holds this version — same rule as the viewport. */
  atlas: MeshAtlas | null;
  atlasVersion: number;
}

/** Icons already built, by `${atlasVersion}:${block}`. */
const cache = new Map<string, ChunkGeometry | null>();

/**
 * Enough for several screens of scrolling and nowhere near enough to matter.
 *
 * Each entry is one block's worth of triangles — a few kilobytes — so this is
 * megabytes at worst, against a 900-block list somebody may scroll all of.
 */
const MAX_CACHED_ICONS = 4096;

/** A one-block document, which is what an icon is a picture of. */
function documentFor(block: string): SchematicDocument {
  const doc = createDocument({ width: 1, height: 1, length: 1, format: "sponge3" });
  setBlock(doc, 0, 0, 0, parsePaletteEntry(block));
  return doc;
}

/**
 * The atlas the cached geometry addresses, once it has stopped moving.
 *
 * Held because a caller that already has this version needs no pixels back,
 * and because a cache key without it would be a lie -- see `buildBlockIcons`.
 */
let settled: { version: number; atlas: MeshAtlas } | null = null;

/**
 * Meshes one block and reports which atlas its UVs address.
 *
 * `null` geometry for anything the mesher declines to draw, which is a tile
 * with a placeholder in it rather than a failed request: one bad id must not
 * empty the whole inventory.
 */
async function meshOne(
  block: string,
  options: DocumentPreviewOptions,
): Promise<{ geometry: ChunkGeometry | null; atlas: MeshAtlas | null; version: number } | null> {
  try {
    const preview = await buildDocumentPreview(documentFor(block), options);
    return {
      geometry: preview.mesh.chunks[0] ?? null,
      atlas: preview.mesh.atlas,
      version: preview.mesh.atlasVersion,
    };
  } catch {
    return null;
  }
}

/**
 * Decodes what a set of blocks needs, so the atlas stops growing under them.
 *
 * This is the whole bug, and it was not in the renderer. The baker decodes a
 * texture the first time a block asks for it, and `atlasVersion` *is* the
 * texture count -- so meshing sixty blocks in a row produced sixty geometries,
 * each with UVs addressing a different atlas layout, and one atlas to draw them
 * all with. Fifty-nine of them were wrong. Scrolling away and back looked like
 * a fix because by then everything had been decoded and the count had stopped
 * changing.
 *
 * So: prime first, discarding what it builds, and only then mesh. The discarded
 * pass is cheap -- a 1x1x1 document is a handful of triangles, and the
 * expensive half, decoding the textures, is what it exists to do once.
 */
async function prime(
  blocks: readonly string[],
  options: DocumentPreviewOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  for (const [index, block] of blocks.entries()) {
    await meshOne(block, options);
    if (onProgress !== undefined) {
      await breathe(index, blocks.length, onProgress);
    }
  }
}

/**
 * How often a long warm-up lets the process do something else.
 *
 * `await` alone does not: it queues a microtask, and microtasks run *before*
 * I/O, so a loop of awaited work starves the event loop exactly as a
 * synchronous one would. That is what froze the window while nine hundred
 * blocks were meshed -- every IPC call, including the one opening the
 * schematic, sat behind it. `setImmediate` runs in the check phase, after I/O,
 * which is the yield that actually hands the process back.
 */
const YIELD_EVERY = 16;

async function breathe(
  index: number,
  total: number,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  if (index % YIELD_EVERY !== 0 && index !== total - 1) return;
  onProgress(index + 1, total);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Meshes every block there is, so the atlas reaches its final size once.
 *
 * Without this the atlas keeps growing as someone scrolls, and every growth
 * invalidates every icon already drawn -- correct, and visible as the whole
 * grid blanking and refilling. Nine hundred one-block documents is a few
 * seconds in the main process, spent once, off the renderer's thread; the
 * geometry is kept, so afterwards every request is a cache hit.
 */
export async function warmBlockIcons(
  blocks: readonly string[],
  options: DocumentPreviewOptions,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<number> {
  /*
   * Two passes, and the progress reported covers both -- the first is the slow
   * one (it decodes every texture) and the second is nearly free, so a bar that
   * counted only one of them would stall at half and then leap.
   */
  const total = blocks.length * 2;
  await prime(blocks, options, (done) => onProgress(done, total));

  let version = settled?.version ?? 0;
  let atlas = settled?.atlas ?? null;
  for (const [index, block] of blocks.entries()) {
    const built = await meshOne(block, options);
    if (built !== null) {
      version = built.version;
      if (built.atlas !== null) atlas = built.atlas;
      cache.set(`${built.version}:${block}`, built.geometry);
    }
    await breathe(blocks.length + index, total, onProgress);
  }
  if (atlas !== null) settled = { version, atlas };

  evict();
  return version;
}

export async function buildBlockIcons(
  blocks: readonly string[],
  options: DocumentPreviewOptions,
  knownAtlasVersion: number | null,
): Promise<BlockIconsResult> {
  const wanted = [...new Set(blocks)];

  /*
   * The fast path, and after a warm-up it is the only one: every block already
   * meshed against the atlas that is still in force.
   */
  if (settled !== null && wanted.every((block) => cache.has(`${settled!.version}:${block}`))) {
    return {
      icons: wanted.map((block) => ({
        block,
        geometry: cache.get(`${settled!.version}:${block}`) ?? null,
      })),
      atlas: knownAtlasVersion === settled.version ? null : settled.atlas,
      atlasVersion: settled.version,
    };
  }

  await prime(wanted, options);

  const icons: BlockIcon[] = [];
  let version = settled?.version ?? 0;
  let atlas = settled?.atlas ?? null;
  for (const block of wanted) {
    const built = await meshOne(block, options);
    if (built === null) {
      icons.push({ block, geometry: null });
      continue;
    }
    version = built.version;
    if (built.atlas !== null) atlas = built.atlas;
    cache.set(`${built.version}:${block}`, built.geometry);
    icons.push({ block, geometry: built.geometry });
  }
  if (atlas !== null) settled = { version, atlas };

  evict();
  return {
    icons,
    // Only when the caller does not already hold it: the pixels are the large
    // part of this message and re-sending them is most of its cost.
    atlas: knownAtlasVersion === version ? null : atlas,
    atlasVersion: version,
  };
}

/** Oldest-first eviction, which `Map` gives for free by insertion order. */
function evict(): void {
  while (cache.size > MAX_CACHED_ICONS) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

/** Drops every cached icon. Called when the resource pack changes. */
export function forgetBlockIcons(): void {
  cache.clear();
  settled = null;
}
