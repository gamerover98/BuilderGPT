/**
 * Where the ground grid sits, and where the camera starts looking.
 *
 * Both used to answer "the world origin" and neither should. A schematic
 * occupies `(0,0,0)` to `(w,h,l)` -- there are no negative block coordinates,
 * so the origin is a *corner* of the work, not its middle. The grid was
 * centred on that corner, which put three of its four quadrants over space no
 * block can ever occupy, and the camera framed the loaded geometry, which on an
 * empty document is nothing at all.
 *
 * A plain module for `build_grid.ts`'s reason: this is consulted from the
 * rendering steps, which this project's browser harness does not run -- so the
 * decision lives where a check can state it and only the trigger stays
 * unobservable.
 */

import { GRID_DIVISIONS, GRID_SIZE } from "./depth.js";

/** One cell of the `GridHelper`, in blocks. 256 across in 32 divisions is 8. */
export const GRID_CELL = GRID_SIZE / GRID_DIVISIONS;

/** The open document's dimensions, in blocks. */
export interface BoxSize {
  width: number;
  height: number;
  length: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Where to put the middle of the ground grid, for a document of this size.
 *
 * **Snapped to `GRID_CELL`, and that is the whole subtlety.** A `GridHelper`
 * draws its lines at multiples of one cell *from its own centre*, so a helper
 * centred at `x = 7.5` puts lines at 7.5, 15.5, 23.5 -- no longer on integers,
 * let alone on multiples of eight. The build-grid patch under the cursor is
 * drawn on integer cells, so the two would visibly disagree everywhere.
 *
 * Snapping costs at most half a cell of centring and buys lines that still land
 * where a block boundary is. `null` -- nothing open -- keeps the grid on the
 * origin, which is where it was before any of this.
 */
export function gridCentre(size: BoxSize | null): { x: number; z: number } {
  if (size === null) return { x: 0, z: 0 };
  return {
    x: Math.round(size.width / 2 / GRID_CELL) * GRID_CELL,
    z: Math.round(size.length / 2 / GRID_CELL) * GRID_CELL,
  };
}

/**
 * The establishing shot for a document of this size.
 *
 * Derived from the **document box** rather than from the geometry in it, which
 * is the fix as much as the centring is: `Box3.setFromObject` on an empty
 * document is an empty box, so framing gave up and left the camera wherever it
 * had been mounted -- pointed at nothing, at the exact moment the user most
 * needs to see where the work surface is.
 *
 * The angle and the 1.6 are the ones the mesh-bounds version used, kept so an
 * ordinary document opens looking the way it always did.
 */
export function documentFraming(size: BoxSize): { target: Vec3; position: Vec3 } {
  const target = {
    x: size.width / 2,
    y: size.height / 2,
    z: size.length / 2,
  };
  const distance = Math.max(size.width, size.height, size.length) * 1.6;
  return {
    target,
    position: {
      x: target.x + distance,
      y: target.y + distance * 0.7,
      z: target.z + distance,
    },
  };
}

/**
 * The viewport's vertical field of view, in degrees.
 *
 * Named here rather than left as a literal at the `PerspectiveCamera` call
 * because the orthographic camera has to match it: switching projection must
 * not resize the build on screen, and the only way to be sure of that is for
 * both to be derived from one number.
 */
export const ORBIT_FOV = 60;

/**
 * How tall a slice of the world an orthographic camera must show to frame the
 * same thing a perspective one frames at `distance`.
 *
 * A perspective camera's frustum widens with depth; an orthographic one's does
 * not, so "the same view" is only well defined at one distance. The distance to
 * `controls.target` is the right one: it is what the user is looking *at*, and
 * matching there is what makes the toggle read as a change of projection rather
 * than as a jump.
 *
 * Clamped away from zero. The target can be reached exactly -- fly into the
 * middle of a build, switch back to orbit, and the distance is whatever is
 * left -- and a zero-height frustum is a camera with a degenerate projection
 * matrix, which renders nothing at all and reports no error.
 */
export function orthoFrustumHeight(fovDeg: number, distance: number): number {
  const height = 2 * Math.max(0, distance) * Math.tan(((fovDeg * Math.PI) / 180) / 2);
  return Math.max(height, 1e-3);
}

/**
 * That height as the four sides an `OrthographicCamera` wants.
 *
 * Height is the invariant and width follows the aspect, which is the same way
 * round as a perspective camera: `fov` is vertical there too, so a window made
 * wider shows more of the world at the sides rather than less of it top to
 * bottom. Getting this the other way round is invisible on a square viewport.
 */
export function orthoBounds(
  height: number,
  aspect: number,
): { left: number; right: number; top: number; bottom: number } {
  const half = height / 2;
  const wide = half * (aspect > 0 ? aspect : 1);
  return { left: -wide, right: wide, top: half, bottom: -half };
}
