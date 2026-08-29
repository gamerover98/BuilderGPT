/**
 * Reading a `.mcfunction` as a schematic.
 *
 * The odd one out among the formats this app handles: not NBT, not a container,
 * not even a file that knows how big it is. It is a list of commands, one per
 * line, and what makes it a schematic is that `setblock` and `fill` are enough
 * to describe a build. Everything else about it -- the size, the origin, where
 * the palette starts -- has to be worked out from the commands themselves.
 *
 * ## What is read, and what is counted
 *
 * `setblock`, `fill` and `function`. Every other line is **counted and
 * reported** rather than ignored: a file full of `summon` and `data merge` that
 * loaded as an empty schematic with no explanation would read as the app being
 * broken, and the count is the difference between "there is nothing here" and
 * "there is plenty here that I cannot place".
 *
 * ## The block argument cannot be split on whitespace
 *
 * `setblock ~0 ~1 ~2 chest[facing=north]{Items:[{id:"minecraft:stone",count:1}]}`
 * has spaces inside the NBT, and a naive `split(/\s+/)` cuts the block in half
 * and then fails to parse either piece. So the block is scanned with a depth
 * counter over `[]`, `{}` and quotes, and what follows it at depth zero is the
 * mode word. That scan is also what tells a trailing `replace` apart from a
 * block called `replace`, which is why it is not a regex.
 *
 * ## The modes that decide which cells are written are honoured
 *
 * `hollow` and `outline` write a shell rather than a box, `keep` writes only
 * into air, and `fill ... replace <filter>` writes only over a named block.
 * Ignoring them would not fail -- it would produce a solid box where the file
 * asked for a frame, silently. `destroy` and `strict` change what happens to
 * the *old* block in a live world and mean nothing to an empty grid, so they
 * are accepted and have no effect.
 *
 * The syntax itself is stable from 1.13 and is recorded, with the wiki section
 * it came from, in `resources/command_syntax.json`.
 */

import { parsePaletteEntry } from "./loader_formats.js";
import { parseSnbt, SnbtError } from "../domain/snbt.js";
import type { NbtCompound, PaletteEntry } from "./types.js";

export class McfunctionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McfunctionError";
  }
}

/** A box in the file's own coordinates, which may be negative on any axis. */
export interface CommandBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Which cells of the box a command actually writes. */
export type FillShape = "solid" | "hollow" | "outline";

/** One `setblock` or `fill`, already resolved to a box and a block. */
export interface BlockCommand {
  readonly box: CommandBox;
  readonly entry: PaletteEntry;
  /** The `{...}` payload, for a block entity. `null` when the block had none. */
  readonly nbt: NbtCompound | null;
  readonly shape: FillShape;
  /** `keep` writes only into air. */
  readonly onlyAir: boolean;
  /** `fill ... replace <filter>`: only over this block. */
  readonly onlyOver: PaletteEntry | null;
}

export interface ParsedFunction {
  readonly commands: readonly BlockCommand[];
  /** `namespace:path` from every `function` line, in order. */
  readonly calls: readonly string[];
  /** Lines that were none of the three, and are therefore not in the build. */
  readonly ignored: number;
  /** True when the coordinates were `~`-relative. `null` when there were none. */
  readonly relative: boolean | null;
}

const MODES = new Set(["destroy", "keep", "replace", "strict", "outline", "hollow"]);

/**
 * Joins continuation lines and drops comments and blanks.
 *
 * A single backslash as the last non-whitespace character continues the command
 * on the next line, with the leading and trailing whitespace of that line
 * stripped before appending. 1.20.2 added it; a file that uses it on an older
 * server is that file's problem, and a reader that choked on it would be ours.
 */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let pending: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const continues = line.endsWith("\\");
    const body = continues ? line.slice(0, -1).trim() : line;
    pending = pending === null ? body : `${pending}${body}`;
    if (continues) continue;
    const joined = pending;
    pending = null;
    if (joined === "" || joined.startsWith("#")) continue;
    out.push(joined);
  }
  if (pending !== null && pending !== "" && !pending.startsWith("#")) out.push(pending);
  return out;
}

/**
 * The end of the block argument that starts at `from`.
 *
 * Depth over `[` and `{`, and a quoted string is opaque so a `}` inside a sign's
 * text cannot close the compound around it. Returns the index one past the
 * block, which is either whitespace at depth zero or the end of the line.
 */
function endOfBlock(line: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (depth === 0 && /\s/.test(ch)) return i;
  }
  return line.length;
}

/** `~`, `~4`, `-2` -- and a refusal for `^`, which needs a facing this has not. */
function coordinate(token: string, line: string): { value: number; relative: boolean } {
  if (token.startsWith("^")) {
    throw new McfunctionError(
      `Local coordinates (^) are relative to where the player is looking, which a schematic ` +
        `has no answer for: ${line}`,
    );
  }
  const relative = token.startsWith("~");
  const body = relative ? token.slice(1) : token;
  if (body === "") return { value: 0, relative };
  const value = Number(body);
  if (!Number.isFinite(value)) {
    throw new McfunctionError(`${token} is not a coordinate: ${line}`);
  }
  // A command may name a block at a fractional position; the cell is the floor,
  // which is what the game does.
  return { value: Math.floor(value), relative };
}

/** Splits `id[state]{nbt}` into the palette entry and the block entity payload. */
function blockArgument(text: string, line: string): { entry: PaletteEntry; nbt: NbtCompound | null } {
  const brace = (() => {
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quote !== null) {
        if (ch === "\\") i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "[") depth += 1;
      else if (ch === "]") depth -= 1;
      else if (ch === "{" && depth === 0) return i;
    }
    return -1;
  })();

  const head = brace === -1 ? text : text.slice(0, brace);
  const entry = parsePaletteEntry(head);
  // The id may be written without a namespace, which means `minecraft:`. Every
  // other reader in this app namespaces on the way in, so this one does too.
  const namespacedName = entry.namespacedName.includes(":")
    ? entry.namespacedName
    : `minecraft:${entry.namespacedName}`;
  if (brace === -1) return { entry: { ...entry, namespacedName }, nbt: null };

  try {
    const tag = parseSnbt(text.slice(brace));
    if (tag.type !== "compound") {
      throw new McfunctionError(`The block data on this line is not a compound: ${line}`);
    }
    return { entry: { ...entry, namespacedName }, nbt: tag.value as NbtCompound };
  } catch (err) {
    if (err instanceof SnbtError) {
      throw new McfunctionError(`${err.message}, in: ${line}`);
    }
    throw err;
  }
}

/**
 * Reads one function file. Nothing is resolved and nothing is placed yet.
 *
 * The coordinate kind is checked across the whole file rather than per command:
 * a file that mixes `~2` with `2` describes two builds in two frames, and
 * picking one silently is how a structure comes out with half of itself
 * somewhere else.
 */
export function parseMcfunction(text: string): ParsedFunction {
  const commands: BlockCommand[] = [];
  const calls: string[] = [];
  let ignored = 0;
  let relative: boolean | null = null;

  const noteFrame = (isRelative: boolean, line: string): void => {
    if (relative === null) {
      relative = isRelative;
      return;
    }
    if (relative !== isRelative) {
      throw new McfunctionError(
        `This file mixes absolute and ~ relative coordinates, which describe two different ` +
          `builds: ${line}`,
      );
    }
  };

  for (const line of logicalLines(text)) {
    const verb = line.slice(0, endOfBlock(line, 0));
    const rest = line.slice(verb.length).trim();

    if (verb === "function") {
      const target = rest.split(/\s+/)[0] ?? "";
      if (target !== "") calls.push(target);
      continue;
    }

    if (verb !== "setblock" && verb !== "fill") {
      ignored += 1;
      continue;
    }

    const wanted = verb === "setblock" ? 3 : 6;
    const numbers: { value: number; relative: boolean }[] = [];
    let cursor = 0;
    for (let i = 0; i < wanted; i += 1) {
      while (cursor < rest.length && /\s/.test(rest[cursor])) cursor += 1;
      let end = cursor;
      while (end < rest.length && !/\s/.test(rest[end])) end += 1;
      const token = rest.slice(cursor, end);
      if (token === "") {
        throw new McfunctionError(`${verb} wants ${wanted} coordinates: ${line}`);
      }
      numbers.push(coordinate(token, line));
      cursor = end;
    }
    for (const number of numbers) noteFrame(number.relative, line);

    while (cursor < rest.length && /\s/.test(rest[cursor])) cursor += 1;
    const blockEnd = endOfBlock(rest, cursor);
    const blockText = rest.slice(cursor, blockEnd);
    if (blockText === "") throw new McfunctionError(`${verb} wants a block: ${line}`);
    const { entry, nbt } = blockArgument(blockText, line);

    const trailing = rest.slice(blockEnd).trim().split(/\s+/).filter((word) => word !== "");
    const mode = trailing[0] ?? "";
    if (mode !== "" && !MODES.has(mode)) {
      throw new McfunctionError(`${mode} is not one of ${[...MODES].join(", ")}: ${line}`);
    }
    let onlyOver: PaletteEntry | null = null;
    if (verb === "fill" && mode === "replace" && trailing.length > 1) {
      onlyOver = blockArgument(trailing.slice(1).join(" "), line).entry;
    }

    const box: CommandBox =
      verb === "setblock"
        ? {
            minX: numbers[0].value,
            minY: numbers[1].value,
            minZ: numbers[2].value,
            maxX: numbers[0].value,
            maxY: numbers[1].value,
            maxZ: numbers[2].value,
          }
        : {
            minX: Math.min(numbers[0].value, numbers[3].value),
            minY: Math.min(numbers[1].value, numbers[4].value),
            minZ: Math.min(numbers[2].value, numbers[5].value),
            maxX: Math.max(numbers[0].value, numbers[3].value),
            maxY: Math.max(numbers[1].value, numbers[4].value),
            maxZ: Math.max(numbers[2].value, numbers[5].value),
          };

    commands.push({
      box,
      entry,
      nbt,
      shape: mode === "hollow" ? "hollow" : mode === "outline" ? "outline" : "solid",
      onlyAir: mode === "keep",
      onlyOver,
    });
  }

  return { commands, calls, ignored, relative };
}

/** Whether a cell of the box is on its shell, which is what `outline` writes. */
export function onShell(box: CommandBox, x: number, y: number, z: number): boolean {
  return (
    x === box.minX ||
    x === box.maxX ||
    y === box.minY ||
    y === box.maxY ||
    z === box.minZ ||
    z === box.maxZ
  );
}
