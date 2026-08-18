/**
 * The renderer's pure modules.
 *
 * Svelte components cannot be exercised here -- there is no component runner in
 * this project, and adding one would be a bigger decision than any single
 * feature warrants. So the parts of the renderer worth testing are deliberately
 * written *outside* the components: `i18n_core.ts` holds the lookup and
 * interpolation while `i18n.svelte.ts` holds only the rune, and that split is
 * what makes this file possible.
 *
 * The centrepiece is not the interpolation tests -- those are arithmetic. It is
 * `every key used by the renderer exists`, which walks the actual source and
 * resolves every `t(...)`/`tn(...)` against the catalogue. A missing message
 * degrades to the key itself, which is visible but not loud, and would
 * otherwise reach a user before it reached anyone else.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { missingKeys, translate, translatePlural } from "../src/renderer/src/lib/i18n_core.js";
import { en } from "../src/renderer/src/lib/locales/en.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(here, "..", "src", "renderer", "src");

let failures = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}`);
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

console.log("=== Schematic AI Studio renderer unit tests ===\n");

// --- i18n_core: lookup and interpolation ----------------------------------
console.log("--- i18n lookup ---");
{
  const catalog = {
    plain: "Save",
    greet: "Hello {name}, you have {count} messages",
    "thing.one": "{count} thing",
    "thing.other": "{count} things",
  };

  equal("a plain message comes back", translate(catalog, "plain"), "Save");
  equal(
    "placeholders are filled",
    translate(catalog, "greet", { name: "Ada", count: 3 }),
    "Hello Ada, you have 3 messages",
  );
  equal(
    "a repeated placeholder is filled every time",
    translate({ x: "{a} and {a}" }, "x", { a: "one" }),
    "one and one",
  );

  // The whole design of the failure mode: loud enough to spot, quiet enough to
  // ship the rest of the screen.
  equal("a missing key returns itself", translate(catalog, "no.such.key"), "no.such.key");
  equal(
    "a missing parameter leaves its placeholder standing",
    translate(catalog, "greet", { name: "Ada" }),
    "Hello Ada, you have {count} messages",
  );
  equal(
    "a message with no params is returned untouched",
    translate({ x: "{literal}" }, "x"),
    "{literal}",
  );

  equal("one selects the singular", translatePlural(catalog, "thing", 1), "1 thing");
  equal("two selects the plural", translatePlural(catalog, "thing", 2), "2 things");
  equal("zero selects the plural", translatePlural(catalog, "thing", 0), "0 things");

  equal("missingKeys finds the gaps", missingKeys(catalog, ["plain", "nope", "gone"]), [
    "nope",
    "gone",
  ]);
  equal("...and nothing when there are none", missingKeys(catalog, ["plain"]), []);
}

// --- every key the renderer asks for exists -------------------------------
console.log("\n--- catalogue coverage ---");
{
  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
      else if (/\.(svelte|ts)$/.test(entry)) found.push(full);
    }
    return found;
  }

  /*
   * `t(` and `tn(` call sites, and every string literal in the first argument.
   *
   * Reading the argument rather than assuming `t("literal")` is what makes this
   * cover the two conditional call sites -- `t(doc.dirty ? "a" : "b")` names two
   * keys, and a test that only understood the simple form would check neither.
   */
  const CALL = /(?<![\w.])(tn?)\(\s*([^,)]*)/g;
  const LITERAL = /"([^"\n]+)"/g;

  const used = new Map<string, { key: string; plural: boolean; file: string }>();
  const files = sourceFiles(RENDERER).filter(
    (file) => !file.includes("locales") && !file.endsWith("i18n_core.ts"),
  );

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const call of text.matchAll(CALL)) {
      const plural = call[1] === "tn";
      for (const literal of call[2].matchAll(LITERAL)) {
        const key = literal[1];
        // A key, not some other string that happened to be an argument.
        // Digits are part of a key -- `selection.rotate90` is one, and a
        // pattern that stopped at letters silently skipped those call sites,
        // which is how the orphan check below first earned its keep.
        if (!/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/.test(key)) continue;
        used.set(`${key}|${plural}`, { key, plural, file: path.relative(RENDERER, file) });
      }
    }
  }

  check("the scan found call sites at all", used.size > 40);

  const wanted: string[] = [];
  for (const { key, plural } of used.values()) {
    if (plural) wanted.push(`${key}.one`, `${key}.other`);
    else wanted.push(key);
  }

  const absent = missingKeys(en, wanted);
  if (absent.length > 0) {
    console.log(`         missing from en.ts: ${absent.join(", ")}`);
  }
  check("every key the renderer asks for is in the catalogue", absent.length === 0);

  /*
   * And the other direction. An unused message is not a bug the way a missing
   * one is, but it is how a catalogue rots: strings outlive the components that
   * showed them, a translator pays to translate them, and nobody can tell which
   * ones still matter.
   */
  const asked = new Set(wanted);
  const orphans = Object.keys(en).filter((key) => !asked.has(key));
  if (orphans.length > 0) {
    console.log(`         unused in en.ts: ${orphans.join(", ")}`);
  }
  check("no message sits in the catalogue unused", orphans.length === 0);
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
