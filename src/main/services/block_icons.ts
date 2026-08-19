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
const MAX_CACHED_ICONS = 2048;

/** A one-block document, which is what an icon is a picture of. */
function documentFor(block: string): SchematicDocument {
  const doc = createDocument({ width: 1, height: 1, length: 1, format: "sponge3" });
  setBlock(doc, 0, 0, 0, parsePaletteEntry(block));
  return doc;
}

export async function buildBlockIcons(
  blocks: readonly string[],
  options: DocumentPreviewOptions,
  knownAtlasVersion: number | null,
): Promise<BlockIconsResult> {
  const icons: BlockIcon[] = [];
  let atlas: MeshAtlas | null = null;
  let atlasVersion = knownAtlasVersion ?? 0;

  for (const block of blocks) {
    const key = `${atlasVersion}:${block}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      icons.push({ block, geometry: hit });
      continue;
    }

    let geometry: ChunkGeometry | null = null;
    try {
      const preview = await buildDocumentPreview(documentFor(block), options);
      geometry = preview.mesh.chunks[0] ?? null;
      // The first real build settles the version, and every later key uses it.
      // Doing this inside the loop rather than before it keeps the cache honest
      // when a resource pack changes between calls.
      if (preview.mesh.atlas !== null && preview.mesh.atlasVersion !== knownAtlasVersion) {
        atlas = preview.mesh.atlas;
      }
      atlasVersion = preview.mesh.atlasVersion;
    } catch {
      // A block the mesher will not draw is a tile with a placeholder in it,
      // not a failed request: one bad id must not empty the whole inventory.
      geometry = null;
    }

    cache.set(`${atlasVersion}:${block}`, geometry);
    icons.push({ block, geometry });
  }

  // Oldest-first eviction, which `Map` gives for free by insertion order.
  while (cache.size > MAX_CACHED_ICONS) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }

  return { icons, atlas, atlasVersion };
}

/** Drops every cached icon. Called when the resource pack changes. */
export function forgetBlockIcons(): void {
  cache.clear();
}
