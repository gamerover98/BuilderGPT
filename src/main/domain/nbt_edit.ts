/**
 * Editing the NBT a block entity carries, without losing its types.
 *
 * NBT is typed, and the types are load-bearing: a chest's `Count` is a *byte*,
 * a sign's text is a *string*, and Minecraft rejects a file that says otherwise.
 * The inspector displays NBT with the `{type, value}` wrappers stripped because
 * they are unreadable — but that stripped form is exactly what must not be
 * written back, since re-inferring a type from "5" cannot tell a byte from an
 * int from a string.
 *
 * So editing works on *leaves in place*: the tree's shape is fixed, every
 * editable scalar is addressed by a path, and writing one keeps the tag type it
 * already had and coerces the text to fit. What that rules out is adding or
 * removing keys and list entries; what it rules out in exchange is producing
 * NBT that no longer loads.
 *
 * Pure, and separate from `document.ts`, so the coercion rules can be tested
 * without a document, a window or a file.
 *
 * ## The shape `prismarine-nbt` produces
 *
 * A compound is `Record<string, {type, value}>`. A list is the awkward one:
 * `{type: "list", value: {type: <elementType>, value: [...]}}` — doubly nested,
 * and its elements are **unwrapped**. Elements of a compound list are bare
 * compounds; elements of a string list are bare strings carrying no type of
 * their own, so their type comes from the list's element type rather than from
 * the element. Walking either one as though it were a compound produces
 * nonsense, which is why `walk` treats lists as their own case.
 */

import type { NbtCompound, NbtTag } from "../pipeline/types.js";

/** A scalar the inspector can offer as a field. */
export interface NbtField {
  /** Keys and list indices from the root, e.g. `["Items", 0, "Count"]`. */
  path: (string | number)[];
  /** How that path reads, e.g. `Items[0].Count`. */
  label: string;
  /** The NBT tag type, shown so the user knows what they are editing. */
  type: string;
  /** The current value as text. */
  value: string;
  /**
   * Types this module refuses to write are still listed, so the inspector can
   * show them greyed rather than pretend they are absent.
   */
  editable: boolean;
}

/** Scalars whose text form round-trips to exactly one value. */
const NUMERIC_RANGES: Readonly<Record<string, { min: bigint; max: bigint }>> = {
  byte: { min: -128n, max: 127n },
  short: { min: -32768n, max: 32767n },
  int: { min: -2147483648n, max: 2147483647n },
  long: { min: -(2n ** 63n), max: 2n ** 63n - 1n },
};

const FLOATS = new Set(["float", "double"]);

export function isEditableType(type: string): boolean {
  return type === "string" || type in NUMERIC_RANGES || FLOATS.has(type);
}

export class NbtEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NbtEditError";
  }
}

/**
 * A long is two 32-bit halves, not a JS number.
 *
 * `prismarine-nbt` represents it as `[high, low]` because a 64-bit integer does
 * not survive a double past 2^53 — and a chest's `UUID` or a spawner's
 * `LastSpawn` lives well past that. Going through `BigInt` keeps every bit.
 */
export function longToText(value: unknown): string {
  if (Array.isArray(value) && value.length === 2) {
    const [high, low] = value as [number, number];
    return ((BigInt(high | 0) << 32n) | (BigInt(low >>> 0) & 0xffffffffn)).toString();
  }
  return String(value);
}

export function textToLong(text: string): [number, number] {
  const wide = BigInt(text);
  const masked = BigInt.asUintN(64, wide);
  return [Number(BigInt.asIntN(32, masked >> 32n)), Number(BigInt.asIntN(32, masked & 0xffffffffn))];
}

function scalarText(type: string, value: unknown): string {
  return type === "long" ? longToText(value) : String(value);
}

/**
 * The text a user typed, as the value that tag type must hold.
 *
 * Range-checked rather than truncated: a byte written as 300 would be silently
 * wrapped by the writer, and a chest that quietly holds 44 diamonds instead of
 * 300 is worse than a refusal.
 */
export function coerceNbtValue(type: string, text: string): unknown {
  if (type === "string") {
    return text;
  }

  const trimmed = text.trim();
  if (trimmed === "") {
    throw new NbtEditError(`${type} cannot be empty`);
  }

  if (FLOATS.has(type)) {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new NbtEditError(`"${text}" is not a ${type}`);
    }
    return parsed;
  }

  const range = NUMERIC_RANGES[type];
  if (!range) {
    throw new NbtEditError(`${type} cannot be edited here`);
  }

  let parsed: bigint;
  try {
    parsed = BigInt(trimmed);
  } catch {
    throw new NbtEditError(`"${text}" is not a whole number`);
  }
  if (parsed < range.min || parsed > range.max) {
    throw new NbtEditError(`${trimmed} is out of range for a ${type} (${range.min}…${range.max})`);
  }
  return type === "long" ? textToLong(trimmed) : Number(parsed);
}

function joinLabel(path: (string | number)[]): string {
  return path
    .map((step, i) => (typeof step === "number" ? `[${step}]` : i === 0 ? step : `.${step}`))
    .join("");
}

/** Is this a `{type, value}` wrapper rather than a bare compound? */
function isTag(node: unknown): node is NbtTag {
  return (
    typeof node === "object" &&
    node !== null &&
    typeof (node as NbtTag).type === "string" &&
    "value" in (node as object)
  );
}

/**
 * Every scalar in the tree, in reading order, with the path that addresses it.
 *
 * Containers are walked into rather than listed: what a user edits is a value,
 * and a row saying "Items: list" with a text box beside it would invite typing
 * into something that cannot take text.
 */
export function flattenNbt(nbt: NbtCompound): NbtField[] {
  const out: NbtField[] = [];

  const visitValue = (type: string, value: unknown, path: (string | number)[]): void => {
    if (type === "compound") {
      visitCompound(value as NbtCompound, path);
      return;
    }
    if (type === "list") {
      const inner = value as { type?: string; value?: unknown[] };
      const elementType = inner?.type ?? "end";
      const items = Array.isArray(inner?.value) ? inner.value : [];
      items.forEach((item, index) => visitValue(elementType, item, [...path, index]));
      return;
    }
    if (type.endsWith("Array")) {
      // byteArray/intArray/longArray are bulk data — a heightmap, a block state
      // bitfield. Editing one entry of a few thousand through a text box is not
      // a feature, it is a way to corrupt a file slowly.
      out.push({
        path,
        label: joinLabel(path),
        type,
        value: `${Array.isArray(value) ? value.length : 0} entries`,
        editable: false,
      });
      return;
    }
    out.push({
      path,
      label: joinLabel(path),
      type,
      value: scalarText(type, value),
      editable: isEditableType(type),
    });
  };

  const visitCompound = (compound: NbtCompound, path: (string | number)[]): void => {
    for (const [key, tag] of Object.entries(compound ?? {})) {
      if (isTag(tag)) {
        visitValue(tag.type, tag.value, [...path, key]);
      }
    }
  };

  visitCompound(nbt, []);
  return out;
}

/**
 * A copy of `nbt` with one leaf replaced, keeping its tag type.
 *
 * Structural: nothing in the original is mutated, because the original is the
 * `before` half of an undo delta and writing through it would quietly make the
 * undo a no-op.
 */
export function setNbtValue(
  nbt: NbtCompound,
  path: readonly (string | number)[],
  text: string,
): NbtCompound {
  if (path.length === 0) {
    throw new NbtEditError("No field was named");
  }

  // Cloned up front so every level below can be written into freely. NBT is
  // small — a chest is a few dozen tags — so a deep copy costs nothing worth
  // trading correctness for.
  const root = structuredClone(nbt) as NbtCompound;

  const key = path[0];
  if (typeof key !== "string" || !isTag(root[key])) {
    throw new NbtEditError(`${String(key)} is not a field of this block entity`);
  }

  const write = (type: string, value: unknown, rest: readonly (string | number)[]): unknown => {
    if (rest.length === 0) {
      if (!isEditableType(type)) {
        throw new NbtEditError(`A ${type} cannot be edited here`);
      }
      return coerceNbtValue(type, text);
    }

    const step = rest[0];
    if (type === "compound") {
      const compound = value as NbtCompound;
      if (typeof step !== "string" || !isTag(compound?.[step])) {
        throw new NbtEditError(`${String(step)} is not a field of this block entity`);
      }
      const child = compound[step];
      return { ...compound, [step]: { ...child, value: write(child.type, child.value, rest.slice(1)) } };
    }

    if (type === "list") {
      const inner = value as { type: string; value: unknown[] };
      const items = Array.isArray(inner?.value) ? inner.value : [];
      if (typeof step !== "number" || step < 0 || step >= items.length) {
        throw new NbtEditError(`There is no entry ${String(step)} in that list`);
      }
      const next = [...items];
      next[step] = write(inner.type, items[step], rest.slice(1));
      return { type: inner.type, value: next };
    }

    throw new NbtEditError(`A ${type} has no field ${String(step)}`);
  };

  const tag = root[key];
  root[key] = { ...tag, value: write(tag.type, tag.value, path.slice(1)) };
  return root;
}
