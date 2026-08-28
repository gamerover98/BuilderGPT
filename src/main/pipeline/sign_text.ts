/**
 * The text a sign carries, read out of its block entity.
 *
 * `BlockEntityRecord.nbt` is kept verbatim and unmodelled on purpose -- that is
 * what stops an import throwing away the fields nobody anticipated -- so
 * anything that wants to *draw* one has to read it back out. This module is
 * that reading, and nothing else: no geometry, no textures, no document. It is
 * pure so the two spellings below can be tested without a resource pack.
 *
 * ## Two spellings, and both are still in circulation
 *
 * 1.20 replaced `Text1`..`Text4` with `front_text` and `back_text`, each a
 * compound holding a `messages` list. A schematic cut before that is not
 * migrated by anything here, and files from both eras are opened side by side,
 * so both are read. Only the modern one has a back.
 *
 * Each message is a **JSON text component**, not a string: `{"text":"Hello"}`
 * far more often than `"Hello"`. `plainText` flattens one to what it says,
 * because a sign in a viewport is a picture and the styling a component can
 * carry has nowhere to go. Anything it cannot parse is used as it stands --
 * a sign someone wrote with a plain string in it should read, not vanish.
 */

import type { NbtCompound, NbtTag, PaletteEntry } from "./types.js";

/** One face of a sign. Always four lines, padded rather than short. */
export interface SignSide {
  readonly lines: readonly string[];
  /** A dye name, `black` when the file said nothing. */
  readonly color: string;
  readonly glowing: boolean;
}

export interface SignText {
  readonly front: SignSide;
  readonly back: SignSide;
}

export const SIGN_LINES = 4;

/**
 * What each dye does to sign text.
 *
 * From minecraft.wiki's Sign article ("Glow ink colors", the *main* colour
 * column, which is the text's own; the outline column beside it belongs to
 * glowing text and is not used here). Hard-coded in the game rather than
 * derived from the dye's own colour, which is why they have to be listed.
 *
 * One source rather than the two `mc-versions` insists on, and the difference
 * is the failure mode: a wrong DataVersion is undetectable from here and
 * misbehaves in game a long way away, while a wrong colour is *a wrong colour
 * on the screen*. There is corroboration of a kind anyway -- fourteen of the
 * sixteen are X11 colour names exactly (`saddlebrown`, `hotpink`, `lightgray`,
 * `lightblue3`, `purple`), which no single transcription slip would produce.
 */
export const SIGN_DYE_COLOURS: Readonly<Record<string, readonly [number, number, number]>> = {
  black: [0x00, 0x00, 0x00],
  red: [0xff, 0x00, 0x00],
  green: [0x00, 0xff, 0x00],
  brown: [0x8b, 0x45, 0x13],
  blue: [0x00, 0x00, 0xff],
  purple: [0xa0, 0x20, 0xf0],
  cyan: [0x00, 0xff, 0xff],
  light_gray: [0xd3, 0xd3, 0xd3],
  gray: [0x80, 0x80, 0x80],
  pink: [0xff, 0x69, 0xb4],
  lime: [0xbf, 0xff, 0x00],
  yellow: [0xff, 0xff, 0x00],
  light_blue: [0x9a, 0xc0, 0xcd],
  magenta: [0xff, 0x00, 0xff],
  orange: [0xff, 0x68, 0x1f],
  white: [0xff, 0xff, 0xff],
};

export function signColour(name: string): readonly [number, number, number] {
  return SIGN_DYE_COLOURS[name] ?? SIGN_DYE_COLOURS.black;
}

/** Every sign block: standing, wall, hanging and wall hanging. */
export function isSignBlock(namespacedName: string): boolean {
  return namespacedName.replace(/^[^:]*:/, "").endsWith("_sign");
}

function compoundOf(tag: NbtTag | undefined): NbtCompound | null {
  if (tag === undefined || tag.type !== "compound") return null;
  return tag.value as NbtCompound;
}

function stringOf(tag: NbtTag | undefined): string | null {
  if (tag === undefined || tag.type !== "string") return null;
  return typeof tag.value === "string" ? tag.value : null;
}

function truthy(tag: NbtTag | undefined): boolean {
  if (tag === undefined) return false;
  return typeof tag.value === "number" ? tag.value !== 0 : tag.value === true;
}

/**
 * A list of strings, out of `prismarine-nbt`'s doubly-nested list shape.
 *
 * `{type: "list", value: {type: "string", value: [...]}}`, and the elements are
 * bare -- they carry no type of their own. Walking it as a compound produces
 * nonsense, which is the same trap `nbt_edit.ts` documents.
 */
function stringListOf(tag: NbtTag | undefined): string[] | null {
  if (tag === undefined || tag.type !== "list") return null;
  const inner = tag.value as { type?: string; value?: unknown };
  if (!Array.isArray(inner?.value)) return null;
  return inner.value.map((entry) => (typeof entry === "string" ? entry : ""));
}

/**
 * A JSON text component as the words it puts on the sign.
 *
 * Recursive because `extra` is, and total because the alternative is a sign
 * that disappears: anything unparseable is returned as it stands, which for a
 * file holding a bare string is the right answer rather than a fallback.
 */
export function plainText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return raw;
  }
  return flatten(parsed);
}

function flatten(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  if (node === null || typeof node !== "object") return "";
  const record = node as Record<string, unknown>;
  const own = typeof record.text === "string" ? record.text : "";
  const extra = Array.isArray(record.extra) ? record.extra.map(flatten).join("") : "";
  return own + extra;
}

const BLANK: SignSide = { lines: ["", "", "", ""], color: "black", glowing: false };

function sideFrom(compound: NbtCompound | null): SignSide {
  if (compound === null) return BLANK;
  const messages = stringListOf(compound.messages) ?? [];
  const lines: string[] = [];
  for (let i = 0; i < SIGN_LINES; i += 1) lines.push(plainText(messages[i] ?? ""));
  return {
    lines,
    color: stringOf(compound.color) ?? "black",
    glowing: truthy(compound.has_glowing_text),
  };
}

function legacySide(nbt: NbtCompound): SignSide {
  const lines: string[] = [];
  for (let i = 1; i <= SIGN_LINES; i += 1) lines.push(plainText(stringOf(nbt[`Text${i}`]) ?? ""));
  return {
    lines,
    color: stringOf(nbt.Color) ?? "black",
    glowing: truthy(nbt.GlowingText),
  };
}

/**
 * `null` when there is nothing to draw, which is not the same as an empty sign:
 * a blank sign still has a `front_text`, and returning a value for it would put
 * four empty lines through the whole layout for every one in the build.
 */
export function readSignText(nbt: NbtCompound): SignText | null {
  const front = compoundOf(nbt.front_text);
  const back = compoundOf(nbt.back_text);
  const text: SignText =
    front !== null || back !== null
      ? { front: sideFrom(front), back: sideFrom(back) }
      : { front: legacySide(nbt), back: BLANK };
  const empty = (side: SignSide) => side.lines.every((line) => line === "");
  return empty(text.front) && empty(text.back) ? null : text;
}

/**
 * Which way a sign looks, as a compass direction.
 *
 * A wall sign and a wall hanging sign say so outright. A standing or hanging
 * one carries `rotation`, sixteen steps clockwise **from south** -- 0 south, 4
 * west, 8 north, 12 east -- which is rounded to the nearest quarter here for
 * the same reason `block_shapes.ts` rounds the geometry: there are only four
 * orientations of a box to put it on.
 */
export function signFacing(entry: PaletteEntry): "north" | "east" | "south" | "west" {
  const facing = entry.properties.facing;
  if (facing === "north" || facing === "east" || facing === "south" || facing === "west") {
    return facing;
  }
  const sixteenths = Number(entry.properties.rotation ?? "0");
  const steps = Number.isFinite(sixteenths) ? Math.round(sixteenths / 4) : 0;
  return (["south", "west", "north", "east"] as const)[((steps % 4) + 4) % 4];
}

/**
 * A sign's text as one comparable string.
 *
 * `chunked_mesh.ts` observes dirtiness rather than being told about it, and
 * text changes without moving a voxel or a photon -- so it needs something to
 * diff. Everything that reaches the mesh is in here and nothing else is.
 */
export function signDigest(text: SignText): string {
  const side = (s: SignSide) => `${s.color}|${s.glowing ? 1 : 0}|${s.lines.join(" ")}`;
  return `${side(text.front)}${side(text.back)}`;
}
