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
 * Ported from `build_atlas` (atlas.py:12-61).
 *
 * Packs a set of per-key images into a single atlas, applying edge-clamped
 * padding per tile to avoid bleed when the resulting atlas is sampled with
 * bilinear/mipmapped filtering, and returns the UV rect (half-pixel-inset,
 * per atlas.py:54-58) for each key.
 */
export function buildAtlas(
  images: Record<string, RgbaImage>,
  tileSize = 32,
  padding = 6,
): AtlasResult {
  const keys = Object.keys(images);

  if (keys.length === 0) {
    // Empty-input sentinel: inventory.tsv row `app/pipeline/atlas.py build_atlas`
    // (empty-input branch) — preserve the literal key "default" and the
    // exact rect (0.0, 0.0, 1.0, 1.0) verbatim; this is an intentional
    // fallback contract, not a bug, and downstream/external callers may
    // depend on the exact values.
    const blank = createFilledRgba(tileSize, tileSize, 255, 255, 255, 255);
    const uvRects: Record<string, UVRect> = { default: [0.0, 0.0, 1.0, 1.0] };
    return { image: blank, uvRects };
  }

  const count = keys.length;
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  // Each texture tile gains mirrored padding to avoid bleeding when sampling.
  const stride = tileSize + padding * 2;
  const width = columns * stride;
  const height = rows * stride;
  const atlas = createBlankRgba(width, height);
  const uvRects: Record<string, UVRect> = {};

  for (let idx = 0; idx < keys.length; idx++) {
    const key = keys[idx];
    let tile = resizeNearest(images[key], tileSize, tileSize);
    if (padding > 0) {
      tile = padEdge(tile, padding);
    }
    const x = (idx % columns) * stride;
    const y = Math.floor(idx / columns) * stride;
    pasteInto(atlas, tile, x, y);

    const innerLeft = x + padding;
    const innerTop = y + padding;
    const innerRight = innerLeft + tileSize;
    const innerBottom = innerTop + tileSize;
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
