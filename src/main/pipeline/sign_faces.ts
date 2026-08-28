/**
 * A sign's text, laid out on its board as quads.
 *
 * This is the only geometry in the pipeline that is a function of a *position*
 * rather than of a palette entry: two signs of the same block state say
 * different things. So it cannot be baked — `bakeBlockstate` is memoised on the
 * state and would hand the second sign the first one's words — and it is built
 * here, per cell, by `culledFaces`.
 *
 * Everything about *where* the board is lives in `block_shapes.ts` and arrives
 * as a `SignTextPlane`. What is left is layout, and the layout is deliberately
 * free of compass arithmetic: the pen walks along the plane's `right` and the
 * lines step down its `up`, so the same code writes all eight orientations and
 * a sign turned east cannot come out mirrored.
 */

import { signTextPlanes, type SignTextPlane } from "./block_shapes.js";
import type { ModelBaker } from "./model_baker.js";
import {
  isSignBlock,
  signColour,
  signFacing,
  SIGN_LINES,
  type SignSide,
  type SignText,
} from "./sign_text.js";
import type { BakedFace, PaletteEntry } from "./types.js";

/**
 * The font's own units, and the sign's, related by one number.
 *
 * Vanilla cuts a sign's text off at 90 font pixels and steps 10 down per line,
 * so four lines are 40 — which is what fixes the size here: 90 across the
 * board's width, and whichever of that and the height is tighter wins, so the
 * text fits the board it is on rather than a board this code assumed. A hanging
 * sign is shorter and wider than a standing one and neither was written down.
 */
const LINE_HEIGHT = 10;
const GLYPH = 8;
const LINE_WIDTH = 90;

/** A measured line: its glyphs' atlas keys, and where the pen was for each. */
interface Measured {
  readonly glyphs: readonly { key: string; at: number }[];
  readonly width: number;
}

async function measure(line: string, baker: ModelBaker, colour: readonly [number, number, number]) {
  const glyphs: { key: string; at: number }[] = [];
  let pen = 0;
  for (const character of line) {
    const code = character.codePointAt(0) ?? 0;
    const glyph = await baker.glyph(code, colour);
    if (glyph === null) {
      // Off the ASCII page. It takes no room either: guessing a width for a
      // glyph nobody can see would push the rest of the line off centre for no
      // gain.
      continue;
    }
    // A space is a width with no key, and the pen moves for it.
    if (glyph.key !== null) glyphs.push({ key: glyph.key, at: pen });
    pen += glyph.advance;
  }
  return { glyphs, width: pen } satisfies Measured;
}

/** Full daylight and no occlusion, for text that says it glows. */
const GLOWING = (() => {
  const shade = new Float32Array(12);
  shade.fill(1);
  return shade;
})();

function quad(
  plane: SignTextPlane,
  left: number,
  bottom: number,
  size: number,
  textureKey: string,
  glowing: boolean,
): BakedFace {
  const at = (u: number, v: number): [number, number, number] => [
    (plane.origin[0] + plane.right[0] * u + plane.up[0] * v) / 16,
    (plane.origin[1] + plane.right[1] * u + plane.up[1] * v) / 16,
    (plane.origin[2] + plane.right[2] * u + plane.up[2] * v) / 16,
  ];
  const corners = [
    at(left, bottom),
    at(left + size, bottom),
    at(left + size, bottom + size),
    at(left, bottom + size),
  ];
  return {
    positions: new Float32Array(corners.flat()),
    // The image's left at the reader's left and its top at the top, which is
    // what the corner order above already says; V=0 is the top of a tile.
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    normal: plane.normal as [number, number, number],
    textureKey,
    shade: glowing ? GLOWING : undefined,
  };
}

async function sideFaces(
  plane: SignTextPlane,
  side: SignSide,
  baker: ModelBaker,
): Promise<BakedFace[]> {
  const colour = signColour(side.color);
  const lines: Measured[] = [];
  for (const line of side.lines.slice(0, SIGN_LINES)) {
    lines.push(await measure(line, baker, colour));
  }
  const widest = Math.max(LINE_WIDTH, ...lines.map((line) => line.width));
  // A line longer than the game would accept shrinks the whole side rather than
  // running off the board: a schematic can hold text no sign editor would have
  // let anyone type, and a word hanging in the air beside the sign reads as a
  // rendering fault rather than as long text.
  const px = Math.min(plane.width / widest, plane.height / (SIGN_LINES * LINE_HEIGHT));
  const top = (plane.height + SIGN_LINES * LINE_HEIGHT * px) / 2;

  const faces: BakedFace[] = [];
  lines.forEach((line, index) => {
    const bottom = top - (index * LINE_HEIGHT + GLYPH) * px;
    const start = (plane.width - line.width * px) / 2;
    for (const glyph of line.glyphs) {
      faces.push(quad(plane, start + glyph.at * px, bottom, GLYPH * px, glyph.key, side.glowing));
    }
  });
  return faces;
}

/**
 * Every quad a sign's text needs, in block-local 0..1 coordinates.
 *
 * Both faces, because a sign has two and the back is the half a schematic is
 * most likely to have something on that nobody remembers writing.
 */
export async function signTextFaces(
  entry: PaletteEntry,
  text: SignText,
  baker: ModelBaker,
): Promise<BakedFace[]> {
  // Guarded here rather than trusted from the caller. `signsIn` already filters
  // by the block, but this is the function that would silently write four lines
  // of poetry onto a chest by borrowing a standing sign's board for it.
  if (!isSignBlock(entry.namespacedName)) return [];
  const faces: BakedFace[] = [];
  for (const plane of signTextPlanes(entry, signFacing(entry))) {
    const side = plane.side === "front" ? text.front : text.back;
    if (side.lines.every((line) => line === "")) continue;
    faces.push(...(await sideFaces(plane, side, baker)));
  }
  return faces;
}
