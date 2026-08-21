/**
 * `domain/snbt.ts` — Minecraft's text form of NBT, both directions.
 *
 * The property that carries the feature: **`parse(stringify(x))` is `x`,
 * exactly.** The NBT panel shows a schematic's tags as text and writes what
 * comes back into the document, so a type lost in the round trip is a file that
 * no longer loads — a chest's `Count` arriving as an int, a sign's text as a
 * number. Every assertion below is either that property on a shape that could
 * break it, or a malformed input reporting where it went wrong.
 */

import {
  parseSnbt,
  SnbtError,
  stringifySnbt,
} from "../src/main/domain/snbt.js";
import type { NbtTag } from "../src/main/pipeline/types.js";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failures += 1;
  }
}

function equal(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.log(`         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  check(label, ok);
}

/** The property, on one tag. */
function roundTrips(label: string, tag: NbtTag): void {
  let parsed: unknown;
  try {
    parsed = parseSnbt(stringifySnbt(tag));
  } catch (err) {
    check(label, false, `threw: ${(err as Error).message}`);
    return;
  }
  equal(label, parsed, tag);
}

console.log("=== Schematic AI Studio: SNBT ===\n");

// --- every scalar keeps its type --------------------------------------------
//
// This is the whole reason the text carries suffixes at all. A double holding
// exactly 1 printed bare would come back an int, and nothing downstream would
// notice until the file was rejected by the game.
console.log("--- scalars ---");
{
  roundTrips("a byte", { type: "byte", value: 7 });
  roundTrips("a short", { type: "short", value: 300 });
  roundTrips("an int", { type: "int", value: 70000 });
  roundTrips("a float", { type: "float", value: 1.5 });
  roundTrips("a double", { type: "double", value: 1.5 });
  roundTrips("a string", { type: "string", value: "minecraft:oak_sign" });

  // The one that a bare-number default would silently break.
  roundTrips("a double holding a whole number", { type: "double", value: 1 });
  roundTrips("a float holding a whole number", { type: "float", value: 2 });

  roundTrips("a negative byte", { type: "byte", value: -128 });
  roundTrips("zero", { type: "int", value: 0 });

  equal("a bare integer is an int", parseSnbt("42"), { type: "int", value: 42 });
  equal("a bare decimal is a double", parseSnbt("4.5"), { type: "double", value: 4.5 });
  equal("...as vanilla has it", parseSnbt(".5"), { type: "double", value: 0.5 });

  for (const [text, type] of [
    ["1b", "byte"],
    ["1B", "byte"],
    ["1s", "short"],
    ["1S", "short"],
    ["1L", "long"],
    ["1l", "long"],
    ["1f", "float"],
    ["1F", "float"],
    ["1d", "double"],
    ["1D", "double"],
  ] as const) {
    equal(`${text} is a ${type}`, parseSnbt(text).type, type);
  }

  equal("true is a byte", parseSnbt("true"), { type: "byte", value: 1 });
  equal("false is a byte", parseSnbt("false"), { type: "byte", value: 0 });
}

// --- longs keep all 64 bits --------------------------------------------------
//
// `prismarine-nbt` stores a long as `[high, low]` because a double loses bits
// past 2^53, and a spawner's `LastSpawn` or an entity's `UUID` lives well past
// that. Going through the text must not undo what that representation buys.
console.log("\n--- longs ---");
{
  roundTrips("a small long", { type: "long", value: [0, 5] });
  roundTrips("a long past 2^53", { type: "long", value: [0x001fffff, 0xffffffff | 0] });
  roundTrips("a negative long", { type: "long", value: [-1, -1] });

  equal(
    "the largest long survives as text",
    stringifySnbt({ type: "long", value: [0x7fffffff, -1] }),
    "9223372036854775807L",
  );
  equal(
    "...and comes back the same two halves",
    parseSnbt("9223372036854775807L"),
    { type: "long", value: [0x7fffffff, -1] },
  );
  equal(
    "a value a double could not hold is exact",
    parseSnbt("9007199254740993L"),
    { type: "long", value: [0x00200000, 1] },
  );
}

// --- containers --------------------------------------------------------------
console.log("\n--- compounds and lists ---");
{
  roundTrips("an empty compound", { type: "compound", value: {} });
  roundTrips("a flat compound", {
    type: "compound",
    value: { Count: { type: "byte", value: 5 }, id: { type: "string", value: "minecraft:diamond" } },
  });
  roundTrips("a nested compound", {
    type: "compound",
    value: {
      WorldEdit: {
        type: "compound",
        value: { Origin: { type: "intArray", value: [201, 92, 3] } },
      },
    },
  });

  // A list's elements are unwrapped, which is the shape most easily got wrong.
  roundTrips("a list of doubles", {
    type: "list",
    value: { type: "double", value: [1.5, 0, 1.5] },
  });
  roundTrips("a list of compounds", {
    type: "list",
    value: {
      type: "compound",
      value: [
        { Count: { type: "byte", value: 1 } },
        { Count: { type: "byte", value: 2 } },
      ],
    },
  });
  roundTrips("a list of strings", {
    type: "list",
    value: { type: "string", value: ["one", "two"] },
  });
  roundTrips("a list of lists", {
    type: "list",
    value: { type: "list", value: [{ type: "int", value: [1, 2] }] },
  });

  // An empty list declares no element type, because there is nothing in it to
  // have one. `end` is what that is called.
  roundTrips("an empty list", { type: "list", value: { type: "end", value: [] } });
  equal("...and reads back as end", parseSnbt("[]"), {
    type: "list",
    value: { type: "end", value: [] },
  });
}

// --- typed arrays ------------------------------------------------------------
//
// `[B; …]` is a byteArray and `[1b, 2b]` is a list of bytes. They are different
// tags with different binary encodings, and the only thing separating them in
// the text is the header.
console.log("\n--- typed arrays ---");
{
  roundTrips("a byte array", { type: "byteArray", value: [1, -2, 3] });
  roundTrips("an int array", { type: "intArray", value: [201, 92, 3] });
  roundTrips("a long array", { type: "longArray", value: [[0, 1], [0, 2]] });
  roundTrips("an empty int array", { type: "intArray", value: [] });

  // prismarine-nbt has this and Minecraft does not, so `[S;` is invented by
  // analogy -- it still has to survive, or a Bedrock tag would be lost.
  roundTrips("a short array", { type: "shortArray", value: [1, 2, 3] });

  check(
    "an array is not a list",
    parseSnbt("[I; 1, 2]").type === "intArray" && parseSnbt("[1, 2]").type === "list",
  );
  equal(
    "a suffix inside an array is allowed and the header still decides",
    parseSnbt("[B; 1b, 2b]"),
    { type: "byteArray", value: [1, 2] },
  );
  equal("an array header tolerates no space before it", parseSnbt("[I;1,2]").type, "intArray");
}

// --- strings -----------------------------------------------------------------
console.log("\n--- strings and keys ---");
{
  roundTrips("a string with a quote in it", { type: "string", value: 'say "hello"' });
  roundTrips("a string with a backslash", { type: "string", value: "C:\\Users\\gamer" });
  roundTrips("a string holding JSON, as a sign does", {
    type: "string",
    value: '{"text":"round trip"}',
  });
  roundTrips("an empty string", { type: "string", value: "" });
  roundTrips("a string that looks like a number", { type: "string", value: "42" });

  equal("single quotes are accepted", parseSnbt("'hi'"), { type: "string", value: "hi" });
  equal("an unquoted word is a string", parseSnbt("{mode: replace}"), {
    type: "compound",
    value: { mode: { type: "string", value: "replace" } },
  });

  // Vanilla's unquoted set is `[A-Za-z0-9._+-]` and does not include the colon,
  // so a namespaced id has to be quoted -- which is how the writer emits it, and
  // how every other SNBT tool reads it. Allowing it here would be worse than a
  // refusal: the same character separates a key from its value, so a bare token
  // that swallowed colons would read `{a:1}` as one token and no key at all.
  check(
    "a namespaced id must be quoted, as vanilla requires",
    (() => {
      try {
        parseSnbt("{id: minecraft:stone}");
        return false;
      } catch (err) {
        return err instanceof SnbtError && err.column === 15;
      }
    })(),
  );

  // A key that is only bare characters is written bare, and anything else is
  // quoted -- otherwise it could not be read back.
  roundTrips("a key needing quotes", {
    type: "compound",
    value: { "a key with spaces": { type: "int", value: 1 } },
  });
  check(
    "an ordinary key is left unquoted",
    stringifySnbt({ type: "compound", value: { Width: { type: "short", value: 7 } } }).includes(
      "Width: 7s",
    ),
  );
}

// --- what the panel will actually hold ---------------------------------------
console.log("\n--- a schematic header ---");
{
  const header: NbtTag = {
    type: "compound",
    value: {
      Version: { type: "int", value: 3 },
      DataVersion: { type: "int", value: 3700 },
      Width: { type: "short", value: 7 },
      Height: { type: "short", value: 8 },
      Length: { type: "short", value: 4 },
      Offset: { type: "intArray", value: [-2, 0, -2] },
      Metadata: {
        type: "compound",
        value: {
          Name: { type: "string", value: "Schematic AI Studio" },
          WorldEdit: {
            type: "compound",
            value: {
              Origin: { type: "intArray", value: [201, 92, 3] },
              EditingPlatform: { type: "string", value: "intellectualsites:bukkit" },
            },
          },
        },
      },
      BlockEntities: {
        type: "list",
        value: {
          type: "compound",
          value: [
            {
              Id: { type: "string", value: "minecraft:chest" },
              Pos: { type: "intArray", value: [2, 0, 2] },
              Data: {
                type: "compound",
                value: {
                  Items: {
                    type: "list",
                    value: {
                      type: "compound",
                      value: [
                        {
                          id: { type: "string", value: "minecraft:diamond" },
                          Count: { type: "byte", value: 5 },
                        },
                      ],
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
  roundTrips("the whole thing", header);

  const text = stringifySnbt(header);
  check("it is written over several lines", text.split("\n").length > 10);
  check("...with the Origin readable in it", text.includes("Origin: [I; 201, 92, 3]"), text);
}

// --- malformed input says where ----------------------------------------------
//
// The panel hands the message straight to the user, so "unexpected }" with no
// position is not an error report, it is a shrug.
console.log("\n--- errors carry a position ---");
{
  const cases: Array<[string, string, number, number]> = [
    ["an unclosed compound", "{a: 1", 1, 6],
    ["an unclosed string", '{a: "oops}', 1, 11],
    ["a missing colon", "{a 1}", 1, 4],
    ["a missing value", "{a: }", 1, 5],
    ["a mixed list", "[1, 2b]", 1, 1],
    ["a byte out of range", "{a: 300b}", 1, 5],
    ["a duplicate key", "{a: 1, a: 2}", 1, 8],
    ["trailing junk", "{a: 1} oops", 1, 8],
    ["a word where a number belongs", "[I; one]", 1, 5],
    ["nothing at all", "", 1, 1],
  ];

  for (const [label, text, line, column] of cases) {
    let error: SnbtError | null = null;
    try {
      parseSnbt(text);
    } catch (err) {
      error = err instanceof SnbtError ? err : null;
    }
    if (error === null) {
      check(label, false, "no SnbtError was raised");
      continue;
    }
    equal(`${label}: line and column`, [error.line, error.column], [line, column]);
  }

  // The line count has to be real, not always 1.
  let multiline: SnbtError | null = null;
  try {
    parseSnbt("{\n  a: 1,\n  b: 300b\n}");
  } catch (err) {
    multiline = err instanceof SnbtError ? err : null;
  }
  equal("an error on the third line says so", [multiline?.line, multiline?.column], [3, 6]);
}

console.log("");
if (failures === 0) {
  console.log("=== ALL CHECKS PASSED ===");
} else {
  console.log(`=== ${failures} CHECK(S) FAILED ===`);
}
process.exit(failures === 0 ? 0 : 1);
