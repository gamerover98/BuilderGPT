/**
 * What the sky looks like at a given moment, as numbers.
 *
 * Pure, and separate from the viewer for the usual reason: everything here is
 * a set of curves through the day, every one of them has boundaries where it is
 * easy to be off by a whole phase, and none of it is observable from a
 * component that owns a WebGL context. `tests/ui.ts` drives it directly.
 *
 * ## The clock is Minecraft's
 *
 * Ticks, 0..24000, because that is the unit anyone building a schematic
 * already thinks in: 0 is sunrise, 6000 noon, 12000 sunset, 18000 midnight.
 * `/time set 18000` is a thing people type. Converting to hours here would mean
 * everyone converting back.
 *
 * ## The sun travels east to west, and the azimuth turns the whole path
 *
 * Vanilla's sun runs exactly east-west, which is right and also means a build
 * squared to the axes gets a flat, symmetrical light. The azimuth setting turns
 * the *path* about the vertical, so the light can be aimed at a facade without
 * inventing a time of day that does not exist.
 */

/** A colour as three components, 0..1, the way three.js wants them. */
export type Rgb = readonly [number, number, number];

export interface SkyState {
  /** The colour at the horizon, and the colour straight up. */
  readonly horizon: Rgb;
  readonly zenith: Rgb;
  /** Unit vector from the world *towards* the sun; below the horizon at night. */
  readonly sunDirection: Rgb;
  /** The moon, which is always exactly opposite. */
  readonly moonDirection: Rgb;
  /**
   * How much of the sky-light channel reaches a surface, 0..1.
   *
   * Never zero. A build at midnight is dim, not invisible — and this is an
   * editor, where "you cannot see what you are working on" is a bug however
   * faithful it is.
   */
  readonly daylight: number;
  /** The colour and strength of whichever body is currently up. */
  readonly lightColor: Rgb;
  readonly lightIntensity: number;
  /** How visible the stars are, 0..1. */
  readonly starOpacity: number;
  /** Whether the moon is the one doing the lighting. */
  readonly night: boolean;
}

export const TICKS_PER_DAY = 24000;

/**
 * How far out the sky dome sits, for a camera with these clipping planes.
 *
 * A fraction of the far plane rather than a fixed distance, and that is not a
 * refinement — it is the whole of a bug. The dome was a sphere of radius 3000
 * while the draw-distance setting defaults to **512**, so every vertex of it
 * fell outside the frustum and was clipped: nothing was drawn, the viewport
 * showed the renderer's clear colour, and the sky was simply black.
 *
 * The answer has to hold for every draw distance the slider offers, which is
 * what makes it worth a function and a test rather than a constant. Strictly
 * inside both planes: touching either is the same failure by a hair.
 */
export function skyDistance(near: number, far: number): number {
  const safeFar = far > 0 ? far : 2048;
  const safeNear = near > 0 && near < safeFar ? near : safeFar / 1000;

  // Where it would like to be: far enough that nothing is behind it, close
  // enough that the depth range is not spent reaching it.
  const wanted = safeFar * 0.4;
  // Where it is allowed to be. Both margins are what makes the answer *strictly*
  // inside: a dome exactly on a clipping plane is clipped by a rounding error,
  // which is the same black viewport arrived at more slowly.
  const nearest = safeNear * 2;
  const furthest = safeFar * 0.9;
  if (nearest >= furthest) {
    // A frustum too thin for any margin still gets a dome inside it.
    return (safeNear + safeFar) / 2;
  }
  return Math.min(furthest, Math.max(nearest, wanted));
}

/** Wraps a tick count into one day, negatives included. */
export function normalizeTicks(ticks: number): number {
  const wrapped = ticks % TICKS_PER_DAY;
  return wrapped < 0 ? wrapped + TICKS_PER_DAY : wrapped;
}

/**
 * A value picked out of a set of keyframes on the tick axis, wrapping at
 * midnight so dusk runs into dawn without a seam.
 */
function ramp(ticks: number, stops: readonly (readonly [number, number])[]): number {
  const at = normalizeTicks(ticks);
  for (let i = 0; i < stops.length - 1; i += 1) {
    const [t0, v0] = stops[i];
    const [t1, v1] = stops[i + 1];
    if (at >= t0 && at <= t1) {
      const span = t1 - t0;
      return span === 0 ? v1 : v0 + ((v1 - v0) * (at - t0)) / span;
    }
  }
  return stops[stops.length - 1][1];
}

function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = Math.min(1, Math.max(0, amount));
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Vanilla's daytime sky, its dusk, and its night. */
const DAY_SKY: Rgb = [0.47, 0.65, 1.0];
const DUSK_SKY: Rgb = [0.95, 0.45, 0.16];
const NIGHT_SKY: Rgb = [0.02, 0.03, 0.09];

const SUN_LIGHT: Rgb = [1.0, 0.96, 0.86];
const DUSK_LIGHT: Rgb = [1.0, 0.62, 0.36];
const MOON_LIGHT: Rgb = [0.62, 0.7, 0.95];

/**
 * How bright the sky-light channel is through the day.
 *
 * The floor is 0.2 rather than 0: sky light at night in the game is dim, and
 * an editor that went black at 18000 would be a setting nobody could use.
 */
const DAYLIGHT_STOPS: readonly (readonly [number, number])[] = [
  [0, 0.5],
  [1500, 1],
  [11000, 1],
  [12800, 0.35],
  [13500, 0.2],
  [22200, 0.2],
  [23000, 0.35],
  [TICKS_PER_DAY, 0.5],
];

/** How much of the sky is dusk-coloured: peaks at sunrise and sunset. */
const DUSK_STOPS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1800, 0],
  [10800, 0],
  [12000, 1],
  [13200, 0],
  [22200, 0],
  [23400, 1],
  [TICKS_PER_DAY, 1],
];

/** How much of the sky is night-coloured. */
const NIGHT_STOPS: readonly (readonly [number, number])[] = [
  [0, 0.15],
  [1200, 0],
  [11500, 0],
  [13000, 1],
  [22500, 1],
  [23400, 0.15],
  [TICKS_PER_DAY, 0.15],
];

export function skyAt(ticks: number, azimuthDeg = 0): SkyState {
  const at = normalizeTicks(ticks);

  /*
   * The sun's angle around its path: sunrise on the eastern horizon, straight
   * up at noon, western horizon at sunset. Note the *east* is +X and this puts
   * the sun there at tick 0 — the same axes the schematic uses, so a wall
   * facing east is lit at dawn.
   */
  const angle = (at / TICKS_PER_DAY) * Math.PI * 2;
  const height = Math.sin(angle);
  const along = Math.cos(angle);
  const yaw = (azimuthDeg * Math.PI) / 180;
  const sunDirection: Rgb = [along * Math.cos(yaw), height, along * Math.sin(yaw)];
  const moonDirection: Rgb = [-sunDirection[0], -sunDirection[1], -sunDirection[2]];

  const duskAmount = ramp(at, DUSK_STOPS);
  const nightAmount = ramp(at, NIGHT_STOPS);
  const daylight = ramp(at, DAYLIGHT_STOPS);
  const night = height < 0;

  const base = mix(DAY_SKY, DUSK_SKY, duskAmount);
  const horizon = mix(base, NIGHT_SKY, nightAmount);
  // Straight up stays bluer than the horizon in daylight and goes darker at
  // night, which is the whole of what makes a gradient read as sky.
  const zenith = mix(mix(DAY_SKY, [0.24, 0.42, 0.86], 0.6), NIGHT_SKY, nightAmount);

  const lightColor = night ? MOON_LIGHT : mix(SUN_LIGHT, DUSK_LIGHT, duskAmount);
  /*
   * Intensity follows how high the body is, so a low sun is a weak one -- and
   * the moon is a fifth of the sun, which is roughly what the game does and is
   * enough to keep a night scene readable without pretending it is daytime.
   */
  const elevation = Math.max(0, Math.abs(height));
  const lightIntensity = (night ? 0.22 : 1) * (0.35 + 0.65 * elevation);

  return {
    horizon,
    zenith,
    sunDirection,
    moonDirection,
    daylight,
    lightColor,
    lightIntensity,
    starOpacity: nightAmount,
    night,
  };
}
