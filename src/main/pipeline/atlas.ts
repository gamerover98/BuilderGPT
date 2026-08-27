// Ported from app/pipeline/atlas.py.
//
// Image composition: RULEBOOK.md §1 "Image composition" row — `pngjs` only
// covers PNG decode/encode, not `Image.new`/`.paste`/`.resize`/`np.pad`-style
// composition. Sanctioned pattern: hand-rolled composition against the plain
// `RgbaImage {width, height, data: Uint8Array}` struct from types.ts, with
// resize/pad/paste as free functions operating on that struct — never a
// native-binding library like `sharp`.
//
// Param type for `images`: inventory.tsv row `app/pipeline/atlas.py build_atlas`
// flags the source's declared `Mapping[str, np.ndarray]` as under-documenting
// the real contract (atlas.py:34 `isinstance(img, Image.Image)` proves PIL
// images are also accepted at runtime). types.ts's `RgbaImage` struct is the
// sanctioned uniform representation for "an image" on this side of the port
// (see its doc comment), so both source-side accepted shapes (raw array data,
// PIL Image) collapse to one target-side type: `Record<string, RgbaImage>`.
// Callers decoding PNGs (via pngjs) or building pixel data any other way must
// normalize to RgbaImage before calling build_atlas — that normalization is
// each caller's job, not this function's.

import type { AtlasResult, RgbaImage, UVRect } from "./types.js";

/** Allocate a new RgbaImage filled with a single RGBA color (all pixels identical). */
function createFilledRgba(width: number, height: number, r: number, g: number, b: number, a: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { width, height, data };
}

/** Allocate a new, zero-filled (transparent black) RgbaImage. */
function createBlankRgba(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/**
 * Nearest-neighbor resize, matching Python's `Image.resize(size, resample=Image.NEAREST)`
 * (atlas.py:38). PIL's NEAREST sampling is CENTER-based, not top-left-based: it maps
 * each destination pixel to the source pixel at `floor((dst + 0.5) * srcSize / dstSize)`.
 * Fixed 2026-08-05 per Step 3 review (atlas.ts reviewer 1): the original `floor(dst *
 * srcSize / dstSize)` formula (no +0.5) was empirically verified against a real Pillow
 * install to pick the wrong source texel in the majority of non-integer-ratio resizes —
 * a real pixel-level parity break, not cosmetic, since build_atlas always resizes to a
 * fixed tile_size. Residual gap: Pillow's internal fixed-point arithmetic can diverge from
 * this floating-point formula by one pixel at exact half-boundary cases — not chased here.
 */
function resizeNearest(src: RgbaImage, dstWidth: number, dstHeight: number): RgbaImage {
  const dst = createBlankRgba(dstWidth, dstHeight);
  for (let dy = 0; dy < dstHeight; dy++) {
    const sy = Math.min(src.height - 1, Math.floor(((dy + 0.5) * src.height) / dstHeight));
    for (let dx = 0; dx < dstWidth; dx++) {
      const sx = Math.min(src.width - 1, Math.floor(((dx + 0.5) * src.width) / dstWidth));
      const srcIdx = (sy * src.width + sx) * 4;
      const dstIdx = (dy * dstWidth + dx) * 4;
      dst.data[dstIdx] = src.data[srcIdx];
      dst.data[dstIdx + 1] = src.data[srcIdx + 1];
      dst.data[dstIdx + 2] = src.data[srcIdx + 2];
      dst.data[dstIdx + 3] = src.data[srcIdx + 3];
    }
  }
  return dst;
}

/**
 * Edge-clamped padding, matching `np.pad(array, ((p,p),(p,p),(0,0)), mode="edge")`
 * (atlas.py:41-45): every added border pixel copies the value of the nearest
 * in-bounds source pixel (clamped coordinates), not zero-fill.
 */
function padEdge(src: RgbaImage, padding: number): RgbaImage {
  if (padding <= 0) {
    return src;
  }
  const dstWidth = src.width + padding * 2;
  const dstHeight = src.height + padding * 2;
  const dst = createBlankRgba(dstWidth, dstHeight);
  for (let dy = 0; dy < dstHeight; dy++) {
    const sy = Math.min(src.height - 1, Math.max(0, dy - padding));
    for (let dx = 0; dx < dstWidth; dx++) {
      const sx = Math.min(src.width - 1, Math.max(0, dx - padding));
      const srcIdx = (sy * src.width + sx) * 4;
      const dstIdx = (dy * dstWidth + dx) * 4;
      dst.data[dstIdx] = src.data[srcIdx];
      dst.data[dstIdx + 1] = src.data[srcIdx + 1];
      dst.data[dstIdx + 2] = src.data[srcIdx + 2];
      dst.data[dstIdx + 3] = src.data[srcIdx + 3];
    }
  }
  return dst;
}

/** In-place paste of `src` into `dest` at top-left offset (x, y), matching `Image.paste` (atlas.py:49). */
function pasteInto(dest: RgbaImage, src: RgbaImage, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dest.height) {
      continue;
    }
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dest.width) {
        continue;
      }
      const srcIdx = (sy * src.width + sx) * 4;
      const dstIdx = (dy * dest.width + dx) * 4;
      dest.data[dstIdx] = src.data[srcIdx];
      dest.data[dstIdx + 1] = src.data[srcIdx + 1];
      dest.data[dstIdx + 2] = src.data[srcIdx + 2];
      dest.data[dstIdx + 3] = src.data[srcIdx + 3];
    }
  }
}

/**
 * The smallest tile the half-pixel inset still makes sense on, and the largest
 * one a single texture may claim.
 *
 * The floor is not decoration: the rect is inset half a pixel at each edge, so
 * a one-pixel tile would come out with `u0 > u1` and draw mirrored. The cap is
 * what stops one enormous sheet in some pack deciding the size of the atlas.
 */
const MIN_TILE = 16;
const MAX_TILE = 256;
/** The blank returned for an empty input. Its size is not part of the contract. */
const FALLBACK_TILE = 64;

/** The square a texture is drawn into: its own resolution, within reason. */
function tileSizeFor(image: RgbaImage, maxTile: number): number {
  return Math.min(maxTile, Math.max(MIN_TILE, image.width, image.height));
}

/**
 * Ported from `build_atlas` (atlas.py:12-61).
 *
 * Packs a set of per-key images into a single atlas, applying edge-clamped
 * padding per tile to avoid bleed when the resulting atlas is sampled with
 * bilinear/mipmapped filtering, and returns the UV rect (half-pixel-inset,
 * per atlas.py:54-58) for each key.
 *
 * ## Every texture keeps its own resolution, and one fixed size was the fault
 *
 * This resized *everything* to a single square — atlas.py's 32, then 64 here —
 * which is right exactly while every texture is the same size. Ordinary block
 * textures in the bundled pack are 64x64 and passed through untouched; a
 * **chest sheet is 256x256** and a sign sheet 128x128, because a block-entity
 * sheet carries a whole model's parts rather than one face. Those were
 * subsampled 4:1 and 2:1 on the way in.
 *
 * What that costs is worse than "a bit soft", and worse than vanilla: nearest
 * subsampling of a 4x sheet keeps one pixel in sixteen of art drawn at 4x, so
 * the result is not the 16x texture the pack was made from but an arbitrary
 * sample of the 64x one. A chest's plank lines and the border round its lid
 * landed or missed by a pixel, which is why chests came out both chunkier and
 * patchier than the blocks standing beside them.
 *
 * Per-key UV rects are what make the fix cheap: the mesher looks each texture's
 * rect up by name and never assumed they were the same size, so only the
 * packing changed. Tiles go into shelves of descending size, ordered by size
 * then by key, so the layout is a function of the *set* of textures and not of
 * the order the baker happened to decode them — `services/block_icons.ts`
 * requires two runs over the same set to produce identical UVs.
 *
 * Bleed is less of a constraint than it reads as: both consumers sample the
 * atlas with `NearestFilter` and no mipmaps, so the padding is a margin against
 * a future change of filter rather than something in use.
 */
export function buildAtlas(
  images: Record<string, RgbaImage>,
  maxTile = MAX_TILE,
  padding = 6,
): AtlasResult {
  const keys = Object.keys(images);

  if (keys.length === 0) {
    // Empty-input sentinel: inventory.tsv row `app/pipeline/atlas.py build_atlas`
    // (empty-input branch) — preserve the literal key "default" and the
    // exact rect (0.0, 0.0, 1.0, 1.0) verbatim; this is an intentional
    // fallback contract, not a bug, and downstream/external callers may
    // depend on the exact values.
    const blank = createFilledRgba(FALLBACK_TILE, FALLBACK_TILE, 255, 255, 255, 255);
    const uvRects: Record<string, UVRect> = { default: [0.0, 0.0, 1.0, 1.0] };
    return { image: blank, uvRects };
  }

  const tiles = keys
    .map((key) => ({ key, size: tileSizeFor(images[key], maxTile) }))
    .sort((a, b) => b.size - a.size || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // A roughly square sheet: the total area rounded up, but never narrower than
  // the widest tile, which would leave that one nowhere to go.
  const area = tiles.reduce((sum, tile) => sum + (tile.size + padding * 2) ** 2, 0);
  const width = Math.max(tiles[0].size + padding * 2, Math.ceil(Math.sqrt(area)));

  const placed: Array<{ key: string; size: number; x: number; y: number }> = [];
  let penX = 0;
  let penY = 0;
  let shelfHeight = 0;
  for (const tile of tiles) {
    const stride = tile.size + padding * 2;
    if (penX > 0 && penX + stride > width) {
      penX = 0;
      penY += shelfHeight;
      shelfHeight = 0;
    }
    placed.push({ ...tile, x: penX, y: penY });
    penX += stride;
    shelfHeight = Math.max(shelfHeight, stride);
  }
  const height = penY + shelfHeight;

  const atlas = createBlankRgba(width, height);
  const uvRects: Record<string, UVRect> = {};

  for (const { key, size, x, y } of placed) {
    const source = images[key];
    let tile =
      source.width === size && source.height === size ? source : resizeNearest(source, size, size);
    if (padding > 0) {
      tile = padEdge(tile, padding);
    }
    pasteInto(atlas, tile, x, y);

    const innerLeft = x + padding;
    const innerTop = y + padding;
    const innerRight = innerLeft + size;
    const innerBottom = innerTop + size;
    const halfPx = 0.5;
    const u0 = (innerLeft + halfPx) / width;
    const v0 = (innerTop + halfPx) / height;
    const u1 = (innerRight - halfPx) / width;
    const v1 = (innerBottom - halfPx) / height;
    uvRects[key] = [u0, v0, u1, v1];
  }

  return { image: atlas, uvRects };
}

// PORT STATUS: confidence=high todos=0
