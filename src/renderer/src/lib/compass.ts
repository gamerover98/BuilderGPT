/**
 * The corner gizmo: which way is north, and getting the camera to look from it.
 *
 * A viewport that can be orbited freely has no other answer to "which way am I
 * facing", and in an app whose whole subject is a world with named directions
 * that is a question asked constantly -- `facing=north` is written into the
 * file, and it is not derivable from the screen.
 *
 * A plain module for `build_grid.ts`'s and `framing.ts`'s reason. All of this
 * is consulted from `requestAnimationFrame`, which this project's browser
 * harness does not run: the decision lives here where a check can state it, and
 * only the trigger stays unobservable.
 *
 * ## What is deliberately not here
 *
 * Any three.js. The gizmo is drawn with three, in the viewer, and none of the
 * arithmetic below needs it -- rotating a vector by a quaternion is six lines,
 * and `tests/ui.ts` importing a renderer would buy nothing.
 */

import { FACE_VECTOR, type Face } from "../../../shared/block_orientation.js";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** `x, y, z, w`, the order three.js stores a quaternion in. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface CompassAxis {
  readonly face: Face;
  /** What is drawn on the handle. One character, because the gizmo is ~110px. */
  readonly label: string;
  /**
   * The custom property its colour comes from.
   *
   * A token rather than a literal for the reason the hover outline learned the
   * hard way: it was the one colour in `Viewer.svelte` not taken from the
   * theme, and so the one that stayed put when the window went light.
   */
  readonly token: string;
  /**
   * Whether this is the positive end of its axis.
   *
   * Vanilla CAD convention, and it earns its place: the two ends of an axis are
   * the same colour, so with both drawn as filled discs a view from due east
   * and one from due west are the same picture. The negative end is drawn
   * hollow.
   */
  readonly positive: boolean;
}

/**
 * The six, in the order they are drawn.
 *
 * Colours are the universal ones -- X red, Y green, Z blue -- rather than
 * anything about Minecraft, because that is what anyone arriving from Blender,
 * Cinema 4D or a CAD package already reads without being told.
 *
 * The labels are Minecraft's, though, and that is the deliberate half: a
 * builder thinks in north and east, not in +Z and +X, and `facing=north` is
 * what the file says. `U` and `D` rather than `Y+`/`Y-` to stay one character.
 */
export const COMPASS_AXES: readonly CompassAxis[] = [
  { face: "east", label: "E", token: "--axis-x", positive: true },
  { face: "west", label: "W", token: "--axis-x", positive: false },
  { face: "up", label: "U", token: "--axis-y", positive: true },
  { face: "down", label: "D", token: "--axis-y", positive: false },
  { face: "south", label: "S", token: "--axis-z", positive: true },
  { face: "north", label: "N", token: "--axis-z", positive: false },
];

/** How far out from the centre of the gizmo a handle sits, as a fraction. */
export const HANDLE_REACH = 0.72;

/** And how big it is, in the same units. Its own radius, for hit testing. */
export const HANDLE_RADIUS = 0.19;

/** How long a click on a handle takes to fly the camera, in milliseconds. */
export const FLIGHT_MS = 420;

function rotate(v: Vec3, q: Quat): Vec3 {
  // The usual `v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)`.
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** The rotation that takes world space into the camera's own. */
function inverse(q: Quat): Quat {
  // A camera quaternion is a unit quaternion, so the inverse is the conjugate.
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export interface AxisPoint {
  /** Pixels from the left of the gizmo's square. */
  x: number;
  /** Pixels from the *top* of it, which is the direction screen y runs. */
  y: number;
  /** How near the viewer, -1 to 1. Larger is nearer. */
  depth: number;
}

/**
 * Where a handle lands in the gizmo's square, for a camera in this orientation.
 *
 * Orthographic and looking down its own -Z, which is what the gizmo's camera
 * is: the handles are on a unit sphere, so `x` and `y` in view space *are* the
 * projection and `z` is the depth. Nothing here needs a projection matrix.
 *
 * The `y` flip is the one thing to get wrong. View space has y upwards and a
 * mouse event has it downwards, and a compass mirrored top to bottom still
 * looks like a compass -- so it is checked rather than eyeballed.
 */
export function projectAxis(face: Face, camera: Quat, size: number): AxisPoint {
  const view = rotate(FACE_VECTOR[face], inverse(camera));
  const half = size / 2;
  return {
    x: half + view.x * HANDLE_REACH * half,
    y: half - view.y * HANDLE_REACH * half,
    depth: view.z,
  };
}

/**
 * Which handle a click at `point` landed on, or `null` for the gap between.
 *
 * **Nearest the viewer wins**, not nearest the pointer. The two ends of an
 * axis project to the very same place when that axis points at the camera --
 * looking north, both the north and the south handle land dead centre -- and
 * the one drawn on top is the one pointing back out of the screen, which
 * there is *south*. Picking by distance would be a coin toss between two
 * exact ties, so half the time a click would fly the camera to the opposite
 * side of the build from the handle it was over.
 */
export function axisAt(
  point: { x: number; y: number },
  camera: Quat,
  size: number,
): Face | null {
  const radius = HANDLE_RADIUS * (size / 2);
  let best: { face: Face; depth: number } | null = null;
  for (const axis of COMPASS_AXES) {
    const at = projectAxis(axis.face, camera, size);
    if (Math.hypot(at.x - point.x, at.y - point.y) > radius) continue;
    if (best === null || at.depth > best.depth) {
      best = { face: axis.face, depth: at.depth };
    }
  }
  return best?.face ?? null;
}

/**
 * Where the camera goes to look from `face`, keeping `distance` and `target`.
 *
 * Clicking a handle means "show me this side", so the camera lands *on* that
 * axis: north puts it north of the build looking south, and up puts it
 * overhead looking down. That is the CAD convention and it is also the reading
 * the request asked for in as many words.
 *
 * **The poles are nudged off vertical, and that is not cosmetic.**
 * OrbitControls derives its azimuth from `atan2` of the horizontal offset,
 * which for a camera exactly above the target is `atan2(0, 0)` -- zero, by
 * definition rather than by intent, so the view would silently swing to face
 * whatever azimuth zero happens to be. Leaning a thousandth of the distance
 * towards +Z makes the answer deterministic *and* the one a map has: north
 * ends up at the top of the screen.
 */
export function orbitFor(face: Face, target: Vec3, distance: number): Vec3 {
  const step = FACE_VECTOR[face];
  const reach = Math.max(distance, 1e-3);
  const lean = face === "up" || face === "down" ? reach * 1e-3 : 0;
  return {
    x: target.x + step.x * reach,
    y: target.y + step.y * reach,
    z: target.z + step.z * reach + lean,
  };
}

/** Slow at both ends, which is what makes a 400ms move read as a move. */
export function easeInOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped < 0.5
    ? 4 * clamped * clamped * clamped
    : 1 - (-2 * clamped + 2) ** 3 / 2;
}

function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/**
 * A point `t` of the way from `a` to `b`, **around** `centre` rather than
 * through it.
 *
 * A straight line between two points on a sphere is a chord, so a plain lerp
 * dives towards the middle of the build and back out -- a quarter turn would
 * pass a third of the way in. Interpolating the direction and the radius apart
 * keeps the camera on the sphere it was orbiting on.
 *
 * The antipodal case is the one that has to be written down, because it is not
 * exotic here: it is clicking north and then south. Two opposite directions
 * span no plane, so there is no arc between them and any half-way point is as
 * good as any other -- this picks one by leaning on the least-aligned world
 * axis, which is stable and gets the camera over the top rather than through
 * the middle.
 */
export function arcBetween(centre: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  const from = { x: a.x - centre.x, y: a.y - centre.y, z: a.z - centre.z };
  const to = { x: b.x - centre.x, y: b.y - centre.y, z: b.z - centre.z };
  const fromLength = length(from);
  const toLength = length(to);
  if (fromLength < 1e-9 || toLength < 1e-9) {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
  }

  const u = { x: from.x / fromLength, y: from.y / fromLength, z: from.z / fromLength };
  let v = { x: to.x / toLength, y: to.y / toLength, z: to.z / toLength };
  let dot = u.x * v.x + u.y * v.y + u.z * v.z;

  if (dot < -0.9999) {
    // Opposite ends of the same axis. Bend the destination a hair towards
    // whichever world axis it leans on least, which is always well defined and
    // never the axis being reversed.
    const away =
      Math.abs(u.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    v = {
      x: v.x + away.x * 1e-3,
      y: v.y + away.y * 1e-3,
      z: v.z + away.z * 1e-3,
    };
    const fix = length(v);
    v = { x: v.x / fix, y: v.y / fix, z: v.z / fix };
    dot = u.x * v.x + u.y * v.y + u.z * v.z;
  }

  const radius = fromLength + (toLength - fromLength) * t;
  const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sin = Math.sin(angle);

  const direction =
    sin < 1e-6
      ? u
      : (() => {
          const wa = Math.sin((1 - t) * angle) / sin;
          const wb = Math.sin(t * angle) / sin;
          const mixed = {
            x: u.x * wa + v.x * wb,
            y: u.y * wa + v.y * wb,
            z: u.z * wa + v.z * wb,
          };
          const norm = length(mixed);
          return norm < 1e-9
            ? u
            : { x: mixed.x / norm, y: mixed.y / norm, z: mixed.z / norm };
        })();

  return {
    x: centre.x + direction.x * radius,
    y: centre.y + direction.y * radius,
    z: centre.z + direction.z * radius,
  };
}

export interface CameraFlight {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly around: Vec3;
  readonly startedAt: number;
}

/**
 * Where the camera is `now`, and whether it has arrived.
 *
 * `done` is reported rather than inferred from the position, because the two
 * are different questions at the end: the last frame of a flight is *at* the
 * destination and the flight is over, and a caller comparing coordinates would
 * either hand back control a frame early or never.
 */
export function flightAt(
  flight: CameraFlight,
  now: number,
  duration = FLIGHT_MS,
): { position: Vec3; done: boolean } {
  // A flight with no span has arrived, rather than lasting one
  // millisecond: the caller wants the destination, and a frame of limbo
  // is a frame in which the camera is under nobody's control.
  if (duration <= 0) return { position: flight.to, done: true };
  const raw = (now - flight.startedAt) / duration;
  const done = raw >= 1;
  return {
    position: arcBetween(flight.around, flight.from, flight.to, easeInOutCubic(raw)),
    done,
  };
}
