/**
 * The floor, the grid, and why they cannot be separated by a small number.
 *
 * Three surfaces live at y=0 in the viewport: the virtual floor, the 256-block
 * `GridHelper` over it, and the build-grid patch that follows the cursor. They
 * are coplanar by design -- the grid is a drawing *on* the floor -- and each was
 * nudged apart by a hand-picked epsilon instead: the floor at -0.02, the grid at
 * -0.01, the patch at +0.002.
 *
 * That works near the camera and cannot work far from it, because **depth
 * precision is not uniform in world space**. A perspective depth buffer stores
 * a value linear in `1/z`, so one step of it is worth
 *
 *     dz = z^2 * (1/near - 1/far) / (2^bits - 1)
 *
 * world units at distance `z`. With this viewer's near plane of 0.1 and a
 * 24-bit buffer, one step is a thousandth of a block at 40 blocks out and a
 * *fiftieth* of a block at 180 -- which is exactly where the far corner of the
 * grid sits. Past that the floor and the grid round to the same depth value and
 * the winner is decided per pixel by whatever the rasteriser did last: the
 * stipple that gets reported as "the grid and the floor intersect".
 *
 * No epsilon fixes it. Any constant large enough to survive the far corner is a
 * grid visibly floating above the floor near the camera, and the floor is
 * 20,000 blocks across, so there is no far corner to stop at.
 *
 * `polygonOffset` is the fix, and it is the fix because it is expressed in the
 * two quantities that actually vary: `units` counts *depth-buffer steps*, not
 * world units, and `factor` scales with the polygon's depth slope, which is
 * what grows as a surface turns edge-on -- a ground plane running to the
 * horizon being the worst case there is. It applies to filled polygons only
 * (`GL_POLYGON_OFFSET_FILL`), which suits this exactly: the floor is the only
 * polygon of the three, and pushing it one step away wins the argument for the
 * two sets of lines drawn on it, at every distance, for free.
 *
 * Positive values push *away* from the camera. It is the base that moves, not
 * the decals: nothing is behind the floor -- the sky is a separate pass that
 * clears the depth buffer before the world is drawn -- so it can lose depth
 * without ever losing to anything.
 */

/** The `GridHelper` over the floor: 256 blocks across, in 8-block cells. */
export const GRID_SIZE = 256;
export const GRID_DIVISIONS = 32;

/**
 * What the floor's material declares so that everything drawn on it wins.
 *
 * One step and one slope, which is the conventional minimum for a decal and is
 * enough by construction: `units` is denominated in the smallest difference the
 * buffer can hold, so one of them is always resolvable, wherever the surface is.
 */
export const COPLANAR_OFFSET = { factor: 1, units: 1 } as const;

/**
 * The smallest world-space gap a depth buffer can still tell apart at
 * `distance`, for a camera with these clipping planes.
 *
 * Exported to be *tested* rather than called: it is the arithmetic behind
 * `COPLANAR_OFFSET`, and the check that fails if anyone puts the epsilons back.
 * `bits` defaults to the 24 a desktop browser gives; a 16-bit buffer is 256
 * times worse and the answer is the same one.
 */
export function depthEpsilon(near: number, far: number, distance: number, bits = 24): number {
  const safeFar = far > 0 ? far : 2048;
  const safeNear = near > 0 && near < safeFar ? near : safeFar / 1000;
  const steps = 2 ** bits - 1;
  return (distance * distance * (1 / safeNear - 1 / safeFar)) / steps;
}
