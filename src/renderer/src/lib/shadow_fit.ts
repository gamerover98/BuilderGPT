/**
 * Where the shadow camera goes.
 *
 * A directional light casts shadows through an orthographic camera looking down
 * its own direction, and the whole question is how big its box is: a shadow map
 * has a fixed pixel budget, so a box sized for the largest schematic anyone
 * might open spends nearly all of it on empty air when the schematic is a
 * house. Fitting it to the document is what puts the resolution on the thing
 * actually casting the shadow.
 *
 * Pure, and here rather than in the component, because it is arithmetic with
 * edges — a box off by a factor, a degenerate light direction, a one-block
 * document smaller than the depth bias — and none of it is observable from
 * something that owns a WebGL context.
 *
 * ## There is no texel snapping here, and that is on purpose
 *
 * The usual companion to a fitted box is quantising the camera to the shadow
 * map's texel grid, so that the depth samples land on the same world points
 * from frame to frame and shadow edges stop shimmering. It was written, and
 * then removed: it fixes crawl caused by the box **translating**, and this box
 * does not translate. It is centred on the document, which does not move. What
 * makes the edges move here is the light *rotating*, and no amount of snapping
 * a rotating frame removes that — the texel grid rotates with it.
 *
 * So it would have been complexity that reads as a fix and is not one. If the
 * box ever starts following the camera instead of the document, this is the
 * first thing to add back.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ShadowFit {
  /** Where to put the light. */
  readonly position: Vec3;
  /** What it looks at. Snapped, which is the whole point. */
  readonly target: Vec3;
  /** Half-extent of the orthographic box, in world units. */
  readonly radius: number;
  readonly near: number;
  readonly far: number;
}

/** Length of a vector, and a safe direction when it has none. */
function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z);
  // Straight down, which is the one direction that always lights a floor.
  if (!(length > 1e-6)) return { x: 0, y: 1, z: 0 };
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * The box and the distance for a structure lit from a direction.
 *
 * `size` is the document's own extent; the radius is half its diagonal, so the
 * box covers it however it is turned relative to the light. That is a little
 * generous for an axis-aligned build lit from directly above, and being exactly
 * right there would mean being wrong at every other hour.
 */
export function fitShadow(params: {
  /** The middle of what is being lit. */
  readonly center: Vec3;
  /** Its extent along each axis. */
  readonly size: Vec3;
  /** Unit-ish vector pointing from the world *towards* the light. */
  readonly direction: Vec3;
  /** Shadow map resolution along one side, in pixels. */
  readonly mapSize: number;
}): ShadowFit {
  const { center, size, mapSize } = params;
  const direction = normalize(params.direction);

  const diagonal = Math.hypot(size.x, size.y, size.z);
  // A floor for the tiny cases: a one-block document would otherwise get a box
  // smaller than the bias, and every surface would shadow itself.
  const radius = Math.max(8, diagonal / 2);

  // The camera looks at the middle of the document, from along the light.
  const target: Vec3 = center;

  /*
   * Far enough back that nothing casting a shadow is behind the near plane,
   * and no further: `far - near` is the depth range the map has to resolve, and
   * a light parked a mile away spends its precision on empty space.
   */
  const distance = radius * 2;
  return {
    position: {
      x: target.x + direction.x * distance,
      y: target.y + direction.y * distance,
      z: target.z + direction.z * distance,
    },
    target,
    radius,
    near: Math.max(0.5, distance - radius * 1.5),
    far: distance + radius * 1.5,
  };
}
