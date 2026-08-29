/**
 * SNBT: Minecraft's own text form of NBT, read and written.
 *
 * `{Offset:[I;-2,0,-2], Width:7s}` — the syntax anyone who has typed `/data` or
 * opened NBTExplorer already knows, and the reason the NBT panel offers text at
 * all rather than a tree of widgets. `prismarine-nbt` does not implement it:
 * that library parses and writes the binary format and nothing else, so both
 * directions live here.
 *
 * Pure, and separate from `nbt_edit.ts` for the usual reason — no document, no
 * window, no file, so `tests/snbt.ts` can drive it directly.
 *
 * ## The shape on the other side
 *
 * `prismarine-nbt`'s, with the two traps `nbt_edit.ts` already documents. A
 * list is `{type: "list", value: {type: <element>, value: [...]}}` and its
 * elements are **unwrapped** — a list of compounds holds bare compounds, a list
 * of strings holds bare strings — so the element of any list is exactly the
 * `value` half of the tag it would otherwise be. And a long is `[high, low]`
 * rather than a number, because 64 bits do not survive a double past 2^53;
 * `longToText`/`textToLong` in `nbt_edit.ts` are the conversions, imported
 * rather than rewritten so the two cannot drift.
 *
 * ## Types are written down, not inferred
 *
 * Every scalar but `int` carries its suffix on the way out. Vanilla's rule is
 * that a bare integer is an `int` and a bare decimal is a `double`, which this
 * honours on the way *in* — but relying on it on the way out would mean a
 * `double` holding exactly 1 printing as `1` and coming back an `int`. The
 * point of the round trip is that it is exact.
 *
 * ## Two extensions, both forced
 *
 * `prismarine-nbt` has a `shortArray` that Minecraft does not, so there is no
 * vanilla spelling to use: `[S; …]` is invented here by analogy. And an empty
 * list has no element type to declare, so it round-trips through `end`, which
 * is the same shape `writers.ts`'s `compoundList` refuses to *emit* into a file
 * — readers disagree about what belongs there — and is perfectly well defined
 * in memory.
 */

import { longToText, textToLong } from "./nbt_edit.js";
import type { NbtCompound, NbtTag } from "../pipeline/types.js";

/** Where in the text something went wrong. Both are 1-based, as an editor counts. */
export class SnbtError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = "SnbtError";
    this.line = line;
    this.column = column;
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The suffix each scalar type is spelled with; `int` alone is bare. */
const SUFFIX: Readonly<Record<string, string>> = {
  byte: "b",
  short: "s",
  int: "",
  long: "L",
  float: "f",
  double: "d",
};

/** Element type -> the array's own header letter. */
const ARRAY_HEADER: Readonly<Record<string, string>> = {
  byteArray: "B",
  shortArray: "S",
  intArray: "I",
  longArray: "L",
};

/** Element type each array holds, for coercing its entries. */
const ARRAY_ELEMENT: Readonly<Record<string, string>> = {
  byteArray: "byte",
  shortArray: "short",
  intArray: "int",
  longArray: "long",
};

/** A key needs no quotes when it is only the characters vanilla leaves bare. */
const BARE_KEY = /^[A-Za-z0-9_.+-]+$/;

function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function key(name: string): string {
  return BARE_KEY.test(name) ? name : quote(name);
}

function scalar(type: string, value: unknown): string {
  if (type === "string") {
    return quote(String(value));
  }
  if (type === "long") {
    return `${longToText(value)}L`;
  }
  const suffix = SUFFIX[type];
  if (suffix === undefined) {
    throw new SnbtError(`No text form for a ${type}`, 1, 1);
  }
  return `${String(value)}${suffix}`;
}

/**
 * Whether a list's elements are big enough to deserve a line each.
 *
 * An entity's `Pos` is three doubles and reads far better as `[0.5d, 0d, 0.5d]`;
 * a list of four hundred chests does not read at all on one line.
 */
function isBulky(elementType: string): boolean {
  return elementType === "compound" || elementType === "list";
}

function writeValue(type: string, value: unknown, depth: number, compact = false): string {
  const pad = compact ? "" : "  ".repeat(depth + 1);
  const closePad = compact ? "" : "  ".repeat(depth);
  const br = compact ? "" : "\n";
  const gap = compact ? "" : " ";

  if (type === "compound") {
    const entries = Object.entries((value ?? {}) as NbtCompound);
    if (entries.length === 0) {
      return "{}";
    }
    const body = entries
      .map(
        ([name, tag]) =>
          `${pad}${key(name)}:${gap}${writeValue(tag.type, tag.value, depth + 1, compact)}`,
      )
      .join(`,${br}`);
    return `{${br}${body}${br}${closePad}}`;
  }

  if (type === "list") {
    const inner = (value ?? {}) as { type?: string; value?: unknown[] };
    const items = Array.isArray(inner.value) ? inner.value : [];
    if (items.length === 0) {
      return "[]";
    }
    const elementType = inner.type ?? "end";
    const parts = items.map((item) => writeValue(elementType, item, depth + 1, compact));
    return isBulky(elementType) && !compact
      ? `[\n${parts.map((part) => pad + part).join(",\n")}\n${closePad}]`
      : `[${parts.join(compact ? "," : ", ")}]`;
  }

  const header = ARRAY_HEADER[type];
  if (header !== undefined) {
    const items = Array.isArray(value) ? value : [];
    const elementType = ARRAY_ELEMENT[type];
    // One line whatever the length. These are bulk data by definition, and a
    // heightmap down the side of the panel is worse than a long line.
    const joined = items.map((item) => scalar(elementType, item)).join(compact ? "," : ", ");
    return `[${header};${items.length === 0 ? "" : `${gap}${joined}`}]`;
  }

  return scalar(type, value);
}

/**
 * A tag as SNBT text, pretty-printed over as many lines as it needs.
 *
 * `compact` puts it on one line instead, and exists for one caller: a
 * `.mcfunction` is **one command per line**, so a chest's contents written the
 * readable way would break the `setblock` carrying them across a dozen lines,
 * every one of which the game would then try to run as a command of its own.
 * Found by round-tripping a real file with 509 chests in it — the panel had
 * never had a reason to care, because a text area has as many lines as it likes.
 */
export function stringifySnbt(tag: NbtTag, compact = false): string {
  return writeValue(tag.type, tag.value, 0, compact);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const NUMERIC = /^([+-]?(?:\d+\.?\d*|\.\d+))([bBsSlLfFdD]?)$/;
const SUFFIX_TYPE: Readonly<Record<string, string>> = {
  b: "byte",
  s: "short",
  l: "long",
  f: "float",
  d: "double",
};

/** Characters an unquoted token may hold, which is vanilla's own set. */
const BARE_TOKEN = /[A-Za-z0-9_.+-]/;

/** Integer bounds, so a byte written as 300 is refused rather than wrapped. */
const RANGES: Readonly<Record<string, { min: bigint; max: bigint }>> = {
  byte: { min: -128n, max: 127n },
  short: { min: -32768n, max: 32767n },
  int: { min: -2147483648n, max: 2147483647n },
  long: { min: -(2n ** 63n), max: 2n ** 63n - 1n },
};

class Reader {
  private at = 0;

  constructor(private readonly text: string) {}

  /** 1-based line and column of the current position, for an error message. */
  private where(index = this.at): { line: number; column: number } {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < index && i < this.text.length; i += 1) {
      if (this.text[i] === "\n") {
        line += 1;
        lineStart = i + 1;
      }
    }
    return { line, column: index - lineStart + 1 };
  }

  fail(message: string, index = this.at): never {
    const { line, column } = this.where(index);
    throw new SnbtError(message, line, column);
  }

  skipSpace(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at])) {
      this.at += 1;
    }
  }

  peek(): string {
    return this.at < this.text.length ? this.text[this.at] : "";
  }

  /** Consumes `char`, or says what it found instead. */
  expect(char: string): void {
    this.skipSpace();
    if (this.peek() !== char) {
      const found = this.peek();
      this.fail(`Expected ${char} but found ${found === "" ? "the end of the text" : found}`);
    }
    this.at += 1;
  }

  atEnd(): boolean {
    this.skipSpace();
    return this.at >= this.text.length;
  }

  readString(): string {
    const quoteChar = this.text[this.at];
    this.at += 1;
    let out = "";
    while (this.at < this.text.length) {
      const char = this.text[this.at];
      if (char === "\\") {
        const next = this.text[this.at + 1];
        if (next === undefined) {
          this.fail("The text ends in the middle of an escape");
        }
        // Only the three escapes vanilla defines. An unknown one is kept
        // literally rather than swallowed, so a Windows path in a string
        // survives instead of quietly losing its separators.
        out += next === "\\" || next === '"' || next === "'" ? next : `\\${next}`;
        this.at += 2;
        continue;
      }
      if (char === quoteChar) {
        this.at += 1;
        return out;
      }
      out += char;
      this.at += 1;
    }
    return this.fail("The text ends before this string is closed");
  }

  readBareToken(): string {
    const start = this.at;
    while (this.at < this.text.length && BARE_TOKEN.test(this.text[this.at])) {
      this.at += 1;
    }
    if (this.at === start) {
      const found = this.peek();
      this.fail(`Expected a value but found ${found === "" ? "the end of the text" : found}`);
    }
    return this.text.slice(start, this.at);
  }

  /** A number written the way that type wants it, range-checked not truncated. */
  private coerce(type: string, digits: string, index: number): unknown {
    if (type === "float" || type === "double") {
      const parsed = Number(digits);
      if (!Number.isFinite(parsed)) {
        this.fail(`"${digits}" is not a ${type}`, index);
      }
      return parsed;
    }
    let parsed: bigint;
    try {
      parsed = BigInt(digits);
    } catch {
      return this.fail(`"${digits}" is not a whole number, which a ${type} must be`, index);
    }
    const range = RANGES[type];
    if (parsed < range.min || parsed > range.max) {
      this.fail(`${digits} is out of range for a ${type} (${range.min}...${range.max})`, index);
    }
    return type === "long" ? textToLong(digits) : Number(parsed);
  }

  /** An unquoted token as the tag it spells: a number, a boolean, or a string. */
  private fromToken(token: string, index: number): NbtTag {
    if (token === "true" || token === "false") {
      return { type: "byte", value: token === "true" ? 1 : 0 };
    }
    const match = NUMERIC.exec(token);
    if (!match) {
      // Not a number and not a boolean, so it is a string that did not need
      // quoting -- `{id: minecraft:stone}` is valid SNBT and common in the wild.
      return { type: "string", value: token };
    }
    const [, digits, suffix] = match;
    if (suffix !== "") {
      const type = SUFFIX_TYPE[suffix.toLowerCase()];
      return { type, value: this.coerce(type, digits, index) };
    }
    // Vanilla's own defaults for a bare number: a decimal point makes it a
    // double, and anything else is an int.
    const type = digits.includes(".") ? "double" : "int";
    return { type, value: this.coerce(type, digits, index) };
  }

  /** One value, whatever kind it is. */
  readValue(): NbtTag {
    this.skipSpace();
    const char = this.peek();
    if (char === "") {
      this.fail("Expected a value but found the end of the text");
    }
    if (char === "{") {
      return { type: "compound", value: this.readCompound() };
    }
    if (char === "[") {
      return this.readArrayOrList();
    }
    if (char === '"' || char === "'") {
      return { type: "string", value: this.readString() };
    }
    const index = this.at;
    return this.fromToken(this.readBareToken(), index);
  }

  readCompound(): NbtCompound {
    this.expect("{");
    const out: NbtCompound = {};
    this.skipSpace();
    if (this.peek() === "}") {
      this.at += 1;
      return out;
    }
    for (;;) {
      this.skipSpace();
      const nameAt = this.at;
      const name =
        this.peek() === '"' || this.peek() === "'" ? this.readString() : this.readBareToken();
      if (name in out) {
        this.fail(`${name} appears twice in the same compound`, nameAt);
      }
      this.expect(":");
      out[name] = this.readValue();
      this.skipSpace();
      if (this.peek() === ",") {
        this.at += 1;
        // A trailing comma before the brace is accepted: it is what anyone
        // deleting the last entry of a compound by hand leaves behind.
        this.skipSpace();
        if (this.peek() === "}") {
          this.at += 1;
          return out;
        }
        continue;
      }
      this.expect("}");
      return out;
    }
  }

  private readArrayOrList(): NbtTag {
    const openAt = this.at;
    this.expect("[");
    this.skipSpace();

    // `[B;`, `[I;`, `[L;`, `[S;` -- the header is one letter and a semicolon,
    // which is what tells a byte array from a list of bytes.
    const header = this.peek();
    if (/[BILS]/.test(header) && this.text[this.at + 1] === ";") {
      this.at += 2;
      return this.readTypedArray(header);
    }

    const items: NbtTag[] = [];
    this.skipSpace();
    if (this.peek() === "]") {
      this.at += 1;
      // Nothing in it, so nothing declares what would go in it.
      return { type: "list", value: { type: "end", value: [] } };
    }
    for (;;) {
      items.push(this.readValue());
      this.skipSpace();
      if (this.peek() === ",") {
        this.at += 1;
        this.skipSpace();
        if (this.peek() === "]") {
          this.at += 1;
          break;
        }
        continue;
      }
      this.expect("]");
      break;
    }

    const elementType = items[0].type;
    for (const item of items) {
      if (item.type !== elementType) {
        // NBT lists are homogeneous -- the binary format writes the element
        // type once, at the front -- so a mixed one has no encoding at all.
        this.fail(
          `This list mixes ${elementType} and ${item.type}; a list holds one type`,
          openAt,
        );
      }
    }
    return { type: "list", value: { type: elementType, value: items.map((item) => item.value) } };
  }

  private readTypedArray(header: string): NbtTag {
    const type = Object.keys(ARRAY_HEADER).find((name) => ARRAY_HEADER[name] === header) as string;
    const elementType = ARRAY_ELEMENT[type];
    const values: unknown[] = [];

    this.skipSpace();
    if (this.peek() === "]") {
      this.at += 1;
      return { type, value: values };
    }
    for (;;) {
      this.skipSpace();
      const index = this.at;
      const token =
        this.peek() === '"' || this.peek() === "'" ? this.fail("An array holds numbers, not strings") : this.readBareToken();
      const match = NUMERIC.exec(token);
      if (!match) {
        this.fail(`"${token}" is not a number, and a ${type} holds only numbers`, index);
      }
      // The suffix is optional inside an array and is ignored when present:
      // the array's header already decided the width, and vanilla writes
      // `[B;1b,2b]` and `[I;1,2]` with equal enthusiasm.
      values.push(this.coerce(elementType, match[1], index));
      this.skipSpace();
      if (this.peek() === ",") {
        this.at += 1;
        this.skipSpace();
        if (this.peek() === "]") {
          this.at += 1;
          break;
        }
        continue;
      }
      this.expect("]");
      break;
    }
    return { type, value: values };
  }
}

/**
 * SNBT text as the tag it spells.
 *
 * Throws `SnbtError`, which carries the line and column: "unexpected }" in four
 * hundred lines of chest contents is not a message anybody can act on.
 */
export function parseSnbt(text: string): NbtTag {
  const reader = new Reader(text);
  const value = reader.readValue();
  if (!reader.atEnd()) {
    reader.fail("Text after the end of the value");
  }
  return value;
}
