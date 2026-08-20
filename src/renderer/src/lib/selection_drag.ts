/**
 * Dragging one face of the selection box.
 *
 * Pure arithmetic over plain triples, with no `three` import, so `tests/ui.ts`
 * can exercise it directly. The component that uses this owns a WebGL context,
 * a camera and a render loop, none of which exist in a test runner -- and the
 * part worth checking is not that a mesh got added to a scene, it is what
 * happens at the edges: a face dragged past its opposite number, past the ends
 * of the document, or along an axis pointed almost straight at the camera.
 */

export type Axis = "x" | "y" | "z";

/** Which end of the box a handle belongs to. */
export type Side = "min" | "max";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Region {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface Ray {
  origin: Vec3;
  direction: Vec3;
}

/**
 * How far a face may be dragged from the origin, on either side.
 *
 * Not a design limit — the editor deliberately imposes no footprint, because a
 * fill past the edge grows the schematic and saving trims the air back off. It
 * is a sanity bound on the arithmetic: a ray nearly parallel to its drag plane
 * produces enormous intersections, and a selection reported in millions would
 * be useless to everything downstream. The near-parallel guard catches the
 * worst of it; this catches the rest.
 */
export const MAX_COORDINATE = 100_000;

const AXES: Readonly<Record<Axis, Vec3>> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
};

/**
 * How nearly parallel is too parallel.
 *
 * Both guards below are the same idea: a projection whose length has fallen to
 * nothing carries no direction any more, and normalising it would amplify
 * floating-point noise into a wild answer. Refusing is better than moving the
 * face somewhere the user did not point.
 */
const EPSILON = 1e-6;

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

function normalize(v: Vec3): Vec3 | null {
  const len = length(v);
  if (len < EPSILON) return null;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * The normal of the plane a face slides in.
 *
 * The plane has to contain the drag axis -- the face may only move along it --
 * which fixes its normal as perpendicular to that axis. Of all such planes, the
 * best conditioned one for intersecting a mouse ray is the one most square to
 * the view, so the normal is the view direction with its axis-parallel part
 * removed.
 *
 * Returns null when the axis points almost straight at the camera. There is no
 * usable plane there, and no sensible drag either: the face would travel the
 * length of the schematic for a pixel of mouse movement.
 */
export function dragPlaneNormal(axis: Axis, view: Vec3): Vec3 | null {
  const a = AXES[axis];
  const along = dot(view, a);
  return normalize({
    x: view.x - along * a.x,
    y: view.y - along * a.y,
    z: view.z - along * a.z,
  });
}

/**
 * Where `ray` meets the plane through `point` with normal `normal`.
 *
 * Null when the ray runs parallel to the plane, and also when the hit lies
 * behind the ray's origin -- a plane behind the camera is not something the
 * user can be pointing at.
 */
export function intersectPlane(ray: Ray, point: Vec3, normal: Vec3): Vec3 | null {
  const denominator = dot(ray.direction, normal);
  if (Math.abs(denominator) < EPSILON) return null;

  const offset: Vec3 = {
    x: point.x - ray.origin.x,
    y: point.y - ray.origin.y,
    z: point.z - ray.origin.z,
  };
  const t = dot(offset, normal) / denominator;
  if (t < 0) return null;

  return {
    x: ray.origin.x + ray.direction.x * t,
    y: ray.origin.y + ray.direction.y * t,
    z: ray.origin.z + ray.direction.z * t,
  };
}

/** The world-space centre of one face of the region's box. */
export function faceCentre(region: Region, axis: Axis, side: Side): Vec3 {
  const centre: Vec3 = {
    x: (region.minX + region.maxX + 1) / 2,
    y: (region.minY + region.maxY + 1) / 2,
    z: (region.minZ + region.maxZ + 1) / 2,
  };
  // A block occupies a whole unit cell, so the far face of `max` is at max + 1.
  if (axis === "x") centre.x = side === "min" ? region.minX : region.maxX + 1;
  else if (axis === "y") centre.y = side === "min" ? region.minY : region.maxY + 1;
  else centre.z = side === "min" ? region.minZ : region.maxZ + 1;
  return centre;
}


function read(region: Region, axis: Axis, side: Side): number {
  if (axis === "x") return side === "min" ? region.minX : region.maxX;
  if (axis === "y") return side === "min" ? region.minY : region.maxY;
  return side === "min" ? region.minZ : region.maxZ;
}

function write(region: Region, axis: Axis, side: Side, value: number): Region {
  const next = { ...region };
  if (axis === "x") {
    if (side === "min") next.minX = value;
    else next.maxX = value;
  } else if (axis === "y") {
    if (side === "min") next.minY = value;
    else next.maxY = value;
  } else {
    if (side === "min") next.minZ = value;
    else next.maxZ = value;
  }
  return next;
}

/**
 * The region with one face moved to wherever the ray now points.
 *
 * Snapped to whole blocks, and clamped only against its opposite face, so the
 * box never turns inside out. Pushing a face past its partner stops at one
 * block thick rather than swapping the two, which is what MCEdit does and what
 * people expect; a box that silently inverted would make every subsequent fill
 * act on a region the user was no longer looking at.
 *
 * It is **not** clamped to the document. A face may be dragged out past the
 * edge, because that is where the next thing is going to be built: filling
 * such a region grows the schematic to contain it, and saving trims the air
 * back off. Clamping here would have made the editor's box the thing the user
 * has to manage, which is the job this pair of features exists to remove.
 *
 * Returns null when there is no usable answer -- an unusable drag plane, or a
 * ray that misses it -- rather than a guess. The caller leaves the selection
 * alone.
 */
export function dragFace(params: {
  region: Region;
  axis: Axis;
  side: Side;
  ray: Ray;
  /** The camera's viewing direction; need not be normalised. */
  view: Vec3;
}): Region | null {
  const { region, axis, side, ray, view } = params;

  const normal = dragPlaneNormal(axis, view);
  if (normal === null) return null;

  const hit = intersectPlane(ray, faceCentre(region, axis, side), normal);
  if (hit === null) return null;

  const along = axis === "x" ? hit.x : axis === "y" ? hit.y : hit.z;
  // `max` handles sit on the far side of their cell, so the cell they name is
  // one back from the plane they are drawn at.
  const raw = side === "min" ? Math.round(along) : Math.round(along) - 1;

  const opposite = read(region, axis, side === "min" ? "max" : "min");
  const bounded = Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, raw));
  const value =
    side === "min" ? Math.min(bounded, opposite) : Math.max(bounded, opposite);

  return write(region, axis, side, value);
}

/**
 * How wide and tall to scale the flat plate that stands in for a face.
 *
 * A `PlaneGeometry` lies in its local XY and faces +Z, so each plate is turned
 * to face its own axis and its local X/Y then land on two *world* axes -- which
 * two, and in which order, is what this returns.
 *
 * The X face is the one that catches people out, and did catch me. Rotating
 * +90° about Y sends local +X to world **-Z** and leaves local Y on world Y, so
 * its width comes from the Z size and its height from Y. Taking the two
 * remaining axes in their natural order gives (Y, Z) -- the right pair,
 * transposed -- which is invisible on a cubic selection and wrong on every
 * other one.
 */
export function plateScale(
  axis: Axis,
  size: { x: number; y: number; z: number },
): { width: number; height: number } {
  if (axis === "x") return { width: size.z, height: size.y };
  if (axis === "y") return { width: size.x, height: size.z };
  return { width: size.x, height: size.y };
}

/**
 * What a stationary click in orbit mode means.
 *
 * Written out because it is the rule that broke. Selecting was made a Shift
 * gesture so that a plain *drag* would belong to the camera — orbiting a build
 * was close to impossible while the press that started the orbit collapsed the
 * selection to the block underneath — and the click went along with it, which
 * silently took the block inspector with it. Asking what a block is had never
 * been anything but a click.
 *
 * A drag never reaches this: the caller only asks once the pointer has been
 * shown to have stayed put, so nothing is taken back from the camera here.
 *
 * The asymmetry on a miss is deliberate and is the other half of the same
 * lesson. Clearing the selection by clicking past the structure is right when
 * the click *meant* something, and clicking past the structure is also the most
 * ordinary accident there is while framing a shot — so it stays behind Shift.
 */
export type ClickIntent = "pick" | "extend" | "clear" | "ignore";

export function clickIntent(gesture: {
  /** Whether the ray found a block at all. */
  readonly hit: boolean;
  /** Shift: the modifier every selection gesture takes. */
  readonly shift: boolean;
  /** Ctrl: grow the selection from the anchor, the job Shift gave up. */
  readonly ctrl: boolean;
}): ClickIntent {
  if (!gesture.hit) return gesture.shift ? "clear" : "ignore";
  if (gesture.shift && gesture.ctrl) return "extend";
  return "pick";
}
