/**
 * The transform gizmo's arithmetic.
 *
 * Pure, with no `three` import, for `selection_drag.ts`'s reason: what decides
 * has to be readable by `tests/ui.ts`, and everything that draws runs from
 * `requestAnimationFrame`, which this harness does not turn. The half worth
 * checking is not that a cone got added to a group -- it is what a drag along
 * an axis pointed almost at the camera produces, and where a region lands when
 * it is turned about a corner rather than about its own middle.
 *
 * It builds on `selection_drag.ts` rather than beside it. Dragging one arrow is
 * `dragFace`'s problem with the whole region moving instead of one face, so the
 * plane arithmetic -- `dragPlaneNormal`, `intersectPlane` -- is imported rather
 * than written a second time. Two copies of that is how one of them comes to
 * disagree about which way is up.
 */

import {
  dragPlaneNormal,
  intersectPlane,
  MAX_COORDINATE,
  type Axis,
  type Ray,
  type Region,
  type Vec3,
} from "./selection_drag.js";

export type { Axis, Ray, Region, Vec3 };

/**
 * What the gizmo is doing, which is what it draws.
 *
 * `pivot` is a mode rather than a modifier because it is the one that moves
 * nothing: it drags the same arrows, and the difference is entirely in what
 * they carry. Cinema 4D makes it a mode for the same reason.
 */
export type GizmoMode = "move" | "rotate" | "scale" | "pivot";

/** Quarter turns, the only rotation a voxel grid can hold. */
export type Quarter = 0 | 1 | 2 | 3;

export interface GizmoHandle {
  kind: "arrow" | "ring" | "cube";
  axis: Axis;
}

/** A whole cell, as the document indexes them. */
export interface Cell {
  x: number;
  y: number;
  z: number;
}

export type RegionTransform =
  | { kind: "rotate"; axis: Axis; steps: Quarter }
  | { kind: "mirror"; axis: Axis };

/**
 * Scaling a voxel region is resampling, so only whole factors are offered.
 *
 * `multiply` is exact -- one block becomes n^3 of itself. `divide` is not:
 * n^3 - 1 cells out of every n^3 are discarded, and the survivor is the one at
 * the low corner. That asymmetry is why the two are different shapes rather
 * than one signed number: they are not each other's inverse, and a caller that
 * treats them as one will eventually round-trip and be surprised.
 */
export type ScaleSpec = { kind: "multiply"; factor: number } | { kind: "divide"; factor: number };

/** Past this the arithmetic has stopped meaning anything. See `MAX_SCALE`. */
export const MAX_SCALE = 8;

const AXIS_VECTOR: Readonly<Record<Axis, Vec3>> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
};

/**
 * The two axes a ring sweeps, first then second.
 *
 * The pair is ordered so that one positive step sends `first` to `second`,
 * which for the Y ring has to be **east to south** -- main's convention,
 * stated at `domain/transform.ts` as `(x, z) -> (length - 1 - z, x)`. In
 * relative terms that is `(dx, dz) -> (-dz, dx)`, so the pair is `x, z` and
 * not `z, x`. Written the other way round the whole thing still turns, still
 * lands on cells, and turns the wrong way -- and a build rotated backwards
 * looks exactly like a build rotated.
 *
 * `ringAngleAt` reads the same pair, which is what keeps a ring dragged
 * clockwise from producing an anticlockwise turn.
 */
const RING_PLANE: Readonly<Record<Axis, readonly [Axis, Axis]>> = {
  x: ["y", "z"],
  y: ["x", "z"],
  z: ["x", "y"],
};

const QUARTER = Math.PI / 2;

function component(v: Vec3, axis: Axis): number {
  return axis === "x" ? v.x : axis === "y" ? v.y : v.z;
}

/**
 * The continuous middle of a region's box.
 *
 * `max + 1` because a block occupies a whole cell and the far face of `max` is
 * at `max + 1` -- `faceCentre`'s rule, and the reason a 1x1x1 selection's
 * centre is at `+0.5` rather than on the block's own index.
 */
export function regionCentre(region: Region): Vec3 {
  return {
    x: (region.minX + region.maxX + 1) / 2,
    y: (region.minY + region.maxY + 1) / 2,
    z: (region.minZ + region.maxZ + 1) / 2,
  };
}

/**
 * Where the gizmo stands: the region's middle, or the pivot if one was placed.
 *
 * A pivot is stored as a *cell* rather than as a point, so it is something a
 * person can read off the same coordinates as everything else in the app -- and
 * it stands at that cell's middle, which is what keeps a mirror across it
 * landing on cell boundaries instead of halfway through blocks.
 */
export function gizmoOrigin(region: Region, pivot: Cell | null): Vec3 {
  if (pivot === null) return regionCentre(region);
  return { x: pivot.x + 0.5, y: pivot.y + 0.5, z: pivot.z + 0.5 };
}

/** The cell a fresh pivot starts on: the one the region's middle falls in. */
export function defaultPivot(region: Region): Cell {
  const centre = regionCentre(region);
  return {
    x: Math.floor(centre.x),
    y: Math.floor(centre.y),
    z: Math.floor(centre.z),
  };
}

/**
 * Where along `axis` the pointer is, in world units.
 *
 * The drag plane is the one `dragFace` already picks -- it contains the axis,
 * and of those it is the one most square to the view. Null when that plane
 * cannot be built or the ray misses it, which is the same "the axis points at
 * the camera" case, and refusing is better than travelling the length of the
 * schematic for one pixel.
 */
export function axisPointAt(input: {
  origin: Vec3;
  axis: Axis;
  ray: Ray;
  view: Vec3;
}): number | null {
  const normal = dragPlaneNormal(input.axis, input.view);
  if (normal === null) return null;
  const hit = intersectPlane(input.ray, input.origin, normal);
  if (hit === null) return null;
  const along = component(hit, input.axis);
  if (!Number.isFinite(along) || Math.abs(along) > MAX_COORDINATE) return null;
  return along;
}

/**
 * How many whole cells the region has been dragged along one axis.
 *
 * `grab` is where the press landed, in the same units, so the answer is a
 * difference rather than a position -- which is what lets the arrow be grabbed
 * anywhere along its length without the region jumping to the cursor.
 *
 * Rounded, because a schematic has no half cells. Null means "leave it where it
 * is": the caller must not read that as zero, or a drag that briefly loses its
 * plane would snap the region back to where it started.
 */
export function dragAlongAxis(input: {
  origin: Vec3;
  axis: Axis;
  ray: Ray;
  view: Vec3;
  grab: number;
}): number | null {
  const along = axisPointAt(input);
  if (along === null) return null;
  const delta = Math.round(along - input.grab);
  if (Math.abs(delta) > MAX_COORDINATE) return null;
  return delta;
}

/**
 * The pointer's angle around `axis`, for a ring drag.
 *
 * A different plane from the arrows': a ring lies *across* its axis, so the
 * plane is the one the axis is normal to. Null when the ray runs along that
 * plane -- the ring seen exactly edge-on, where there is no angle to read.
 */
export function ringAngleAt(input: { origin: Vec3; axis: Axis; ray: Ray }): number | null {
  const hit = intersectPlane(input.ray, input.origin, AXIS_VECTOR[input.axis]);
  if (hit === null) return null;
  const [first, second] = RING_PLANE[input.axis];
  const u = component(hit, first) - component(input.origin, first);
  const v = component(hit, second) - component(input.origin, second);
  if (Math.abs(u) < 1e-6 && Math.abs(v) < 1e-6) return null;
  return Math.atan2(v, u);
}

/**
 * The quarter turns swept between two ring angles.
 *
 * Rounded to a quarter and nothing finer, which is the whole rotation story:
 * an integer grid cannot hold 37 degrees, and a block state cannot either --
 * `facing=north` turned by an arbitrary angle is not any of the four things
 * that property can say. So the ring turns under the pointer in steps, and what
 * the user sees is what will be written.
 */
export function quartersBetween(from: number, to: number): Quarter {
  const steps = Math.round((to - from) / QUARTER);
  return (((steps % 4) + 4) % 4) as Quarter;
}

/**
 * The whole factor a scale handle has been dragged to, or null for "unchanged".
 *
 * The dead band either side of 1 is deliberate and wide: every ratio between
 * 0.75 and 1.5 means "I have not decided yet", and snapping to x2 the moment
 * the cursor twitched would make an irreversible-feeling edit out of a nudge.
 */
export function scaleFromRatio(ratio: number): ScaleSpec | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  if (ratio >= 1.5) {
    return { kind: "multiply", factor: Math.min(MAX_SCALE, Math.round(ratio)) };
  }
  if (ratio <= 0.75) {
    return { kind: "divide", factor: Math.min(MAX_SCALE, Math.max(2, Math.round(1 / ratio))) };
  }
  return null;
}

/**
 * The region a transform sends this one to.
 *
 * Worked in continuous corner coordinates and converted back, rather than on
 * the inclusive cell indices directly. Both maps here are signed permutations
 * of the axes, so carrying the two corners through and re-sorting is exact --
 * whereas reflecting an inclusive `maxX` gives an answer that is off by one in
 * a way that only shows on regions of even width, which is the half of the
 * cases a hand-checked example is least likely to be.
 */
export function transformedRegion(
  region: Region,
  origin: Vec3,
  transform: RegionTransform,
): Region {
  const lo: Vec3 = { x: region.minX, y: region.minY, z: region.minZ };
  const hi: Vec3 = { x: region.maxX + 1, y: region.maxY + 1, z: region.maxZ + 1 };
  const a = mapPoint(lo, origin, transform);
  const b = mapPoint(hi, origin, transform);
  return {
    minX: Math.round(Math.min(a.x, b.x)),
    minY: Math.round(Math.min(a.y, b.y)),
    minZ: Math.round(Math.min(a.z, b.z)),
    maxX: Math.round(Math.max(a.x, b.x)) - 1,
    maxY: Math.round(Math.max(a.y, b.y)) - 1,
    maxZ: Math.round(Math.max(a.z, b.z)) - 1,
  };
}

/**
 * One point through one transform.
 *
 * The rotation convention is main's, stated once in `domain/transform.ts` and
 * reproduced here rather than re-derived: one step sends **east to south**. In
 * a right-handed frame where north is -Z and east is +X that is
 * `(x, z) -> (-z, x)` about the origin, and getting the sign backwards is
 * invisible -- a build turned the wrong way is still a build turned.
 */
function mapPoint(point: Vec3, origin: Vec3, transform: RegionTransform): Vec3 {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const dz = point.z - origin.z;

  if (transform.kind === "mirror") {
    return {
      x: transform.axis === "x" ? origin.x - dx : point.x,
      y: transform.axis === "y" ? origin.y - dy : point.y,
      z: transform.axis === "z" ? origin.z - dz : point.z,
    };
  }

  const [first, second] = RING_PLANE[transform.axis];
  const out: Record<Axis, number> = { x: dx, y: dy, z: dz };
  let u = out[first];
  let v = out[second];
  // One step at a time rather than a closed form. Four steps is nothing, and
  // the closed form is where a transposed sign hides.
  for (let step = 0; step < transform.steps; step += 1) {
    const turned = -v;
    v = u;
    u = turned;
  }
  out[first] = u;
  out[second] = v;
  return { x: origin.x + out.x, y: origin.y + out.y, z: origin.z + out.z };
}

/**
 * The region a whole-factor scale sends this one to.
 *
 * Anchored at the origin, so scaling about a corner grows away from it and
 * scaling about the middle grows both ways -- which is the payoff for the pivot
 * being a real point rather than a label.
 *
 * A division that would leave nothing keeps one cell per axis instead. An empty
 * region is not a state the rest of the editor has an answer for, and refusing
 * the whole gesture over one thin axis would be worse than the rounding.
 */
export function scaledRegion(region: Region, origin: Vec3, scale: ScaleSpec): Region {
  const ratio = scale.kind === "multiply" ? scale.factor : 1 / scale.factor;
  const lo: Vec3 = { x: region.minX, y: region.minY, z: region.minZ };
  const hi: Vec3 = { x: region.maxX + 1, y: region.maxY + 1, z: region.maxZ + 1 };
  const at = (point: Vec3, axis: Axis): number =>
    component(origin, axis) + (component(point, axis) - component(origin, axis)) * ratio;

  const minX = Math.round(at(lo, "x"));
  const minY = Math.round(at(lo, "y"));
  const minZ = Math.round(at(lo, "z"));
  return {
    minX,
    minY,
    minZ,
    maxX: Math.max(minX, Math.round(at(hi, "x")) - 1),
    maxY: Math.max(minY, Math.round(at(hi, "y")) - 1),
    maxZ: Math.max(minZ, Math.round(at(hi, "z")) - 1),
  };
}

/**
 * Whether a region is entirely inside a document of this size.
 *
 * Asked before a gesture is committed rather than after, because with automatic
 * resizing off the answer decides between growing the schematic and refusing --
 * and a refusal delivered after the blocks have moved is not a refusal.
 */
export function regionFits(
  region: Region,
  size: { width: number; height: number; length: number },
): boolean {
  return (
    region.minX >= 0 &&
    region.minY >= 0 &&
    region.minZ >= 0 &&
    region.maxX < size.width &&
    region.maxY < size.height &&
    region.maxZ < size.length
  );
}
