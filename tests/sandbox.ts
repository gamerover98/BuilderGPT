/**
 * Sandbox containment checks for the QuickJS/WASM engine (RULEBOOK.md §3 as
 * amended by DEV-015).
 *
 * The engine behind `executeJsBuild` was swapped from isolated-vm to
 * quickjs-emscripten because isolated-vm cannot be loaded in Electron at all.
 * §3's guarantees are properties of *an* engine, not of that specific one, so
 * they have to be re-demonstrated against the replacement rather than assumed
 * to carry over. This file is that demonstration.
 *
 * Every check below is a claim §3 makes:
 *   - no ambient authority reaches the guest (no require/process/fs/network)
 *   - the deadline is enforced, and surfaces as a SandboxViolationError
 *   - bad generated code surfaces as a GeneratedCodeError, NOT as a violation
 *   - coordinate values crossing the bridge are rejected, never coerced to NaN
 *   - the host is not reachable through the bridge's own arguments
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  executeJsBuild,
  loadAllowedBlocks,
  textToSchem,
  attachTrace,
  conversionFailureMessage,
  traceOf,
  GeneratedCodeError,
  SandboxViolationError,
} from "../src/main/core.js";
import { SpongeSchematicWriterFactory } from "../src/main/services/schematic.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failures += 1;
  }
}

/**
 * Runs guest code and reports what escaped, if anything.
 *
 * Only the placements: every containment check below is phrased in terms of
 * what the guest managed to write. The refusals `executeJsBuild` also returns
 * are exercised separately, in the allowlist section.
 */
async function run(code: string, allowed: ReadonlySet<string>) {
  const outcome = await executeJsBuild(code, allowed);
  return outcome.placements;
}

console.log("=== Schematic AI Studio sandbox containment checks (quickjs-emscripten) ===\n");

const allowed = await loadAllowedBlocks(REPO_ROOT);

// --- 1. No ambient authority --------------------------------------------
console.log("--- ambient authority ---");
{
  // The guest reports what it can see by encoding findings into block
  // coordinates: if a global exists, it places a block. No block placed for a
  // given probe means that global was genuinely absent.
  const probes = ["require", "process", "globalThis.process", "fetch", "XMLHttpRequest", "Deno"];
  const code = `
    function buildCreation(x, y, z) {
      var probes = [${probes.map((p) => JSON.stringify(p)).join(", ")}];
      for (var i = 0; i < probes.length; i++) {
        var found = false;
        try { found = eval("typeof " + probes[i]) !== "undefined"; } catch (e) { found = false; }
        if (found) { safeSetBlock(i, 0, 0, 'stone', null); }
      }
    }
  `;
  const placements = await run(code, allowed);
  check(
    "no host global is reachable from the guest",
    placements.length === 0,
    placements.length > 0
      ? `reachable: ${placements.map(([x]) => probes[x]).join(", ")}`
      : undefined,
  );
}

// --- 2. Deadline enforcement --------------------------------------------
console.log("\n--- deadline ---");
{
  const started = Date.now();
  let thrown: unknown = null;
  try {
    await run("function buildCreation(x,y,z){ while (true) {} }", allowed);
  } catch (e) {
    thrown = e;
  }
  const elapsed = Date.now() - started;
  check("an infinite loop is interrupted", thrown !== null);
  check(
    "interrupt is classified as a sandbox violation",
    thrown instanceof SandboxViolationError,
    thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
  );
  // JS_EXECUTION_TIMEOUT_MS is 5s; allow generous slack for a slow machine but
  // fail if the deadline is not actually bounding anything.
  check(`interrupt happened promptly (${elapsed}ms)`, elapsed < 30_000);
}

// --- 3. Bad code is NOT a violation -------------------------------------
console.log("\n--- error classification ---");
{
  let thrown: unknown = null;
  try {
    await run("function buildCreation(x,y,z){ nope.nope(); }", allowed);
  } catch (e) {
    thrown = e;
  }
  check(
    "a plain guest ReferenceError is a GeneratedCodeError",
    thrown instanceof GeneratedCodeError,
    thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
  );
  check("...and is NOT reported as a sandbox violation", !(thrown instanceof SandboxViolationError));

  let syntaxThrown: unknown = null;
  try {
    await run("function buildCreation(x,y,z){ this is not javascript }", allowed);
  } catch (e) {
    syntaxThrown = e;
  }
  check("a syntax error is a GeneratedCodeError", syntaxThrown instanceof GeneratedCodeError);
}

// --- 4. Coordinate rejection at the bridge ------------------------------
console.log("\n--- bridge coordinate validation ---");
{
  // RULEBOOK.md §3's coordinate rule (the round-1 stress-test bug): non-finite
  // coordinates must be REJECTED and the placement discarded, never written as
  // "NaN,NaN,NaN".
  const code = `
    function buildCreation(x, y, z) {
      safeSetBlock('not-a-number', 0, 0, 'stone', null);
      safeSetBlock(NaN, 0, 0, 'stone', null);
      safeSetBlock(Infinity, 0, 0, 'stone', null);
      safeSetBlock(1, 2, 3, 'stone', null);
    }
  `;
  const placements = await run(code, allowed);
  check("only the valid placement survives", placements.length === 1);
  check(
    "the surviving placement is (1,2,3)",
    placements[0]?.[0] === 1 && placements[0]?.[1] === 2 && placements[0]?.[2] === 3,
    JSON.stringify(placements),
  );
  check(
    "no NaN coordinate was ever written",
    placements.every(([x, y, z]) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)),
  );
}

// --- 5. Disallowed blocks are filtered ----------------------------------
console.log("\n--- block allowlist ---");
{
  const code = `
    function buildCreation(x, y, z) {
      safeSetBlock(0, 0, 0, 'definitely_not_a_real_block', null);
      safeSetBlock(1, 0, 0, 'stone', null);
    }
  `;
  const { placements, rejections } = await executeJsBuild(code, allowed);
  check("an unknown block id is dropped", placements.length === 1);
  check("the allowed block is kept", placements[0]?.[3] === "minecraft:stone");

  // Dropping it is correct; dropping it silently was the bug. A build that
  // loses every wall to an unlisted block used to be indistinguishable from
  // one the model simply never wrote.
  check("the drop is reported, not swallowed", rejections.length === 1);
  check(
    "the report names the block and the reason",
    rejections[0]?.blockId === "minecraft:definitely_not_a_real_block" &&
      rejections[0]?.reason === "unsupported" &&
      rejections[0]?.calls === 1,
    JSON.stringify(rejections),
  );

  // A fill counts once however large the region, and repeats accumulate.
  const repeated = `
    function buildCreation(x, y, z) {
      safeFill(0, 0, 0, 9, 9, 9, 'definitely_not_a_real_block', null);
      safeSetBlock(0, 0, 0, 'definitely_not_a_real_block', null);
      safeSetBlock(1, 0, 0, 'definitely_not_a_real_block', null);
    }
  `;
  const second = await executeJsBuild(repeated, allowed);
  check("nothing was placed", second.placements.length === 0);
  check(
    "one entry per block id, counting calls not blocks",
    second.rejections.length === 1 && second.rejections[0]?.calls === 3,
    JSON.stringify(second.rejections),
  );
}

// --- 5b. The allowlist covers the blocks a real build needs -------------
console.log("\n--- allowlist coverage ---");
{
  // The list used to hold 234 ids and none of these. Every one of them is
  // ordinary in a house, so their absence meant the model could describe a
  // door and never place one.
  const staples = [
    "minecraft:oak_door",
    "minecraft:oak_stairs",
    "minecraft:oak_slab",
    "minecraft:oak_fence",
    "minecraft:oak_trapdoor",
    "minecraft:glass_pane",
    "minecraft:chest",
    "minecraft:torch",
    "minecraft:crafting_table",
    "minecraft:ladder",
    "minecraft:water",
  ];
  const missing = staples.filter((id) => !allowed.has(id));
  check("the allowlist carries ordinary building blocks", missing.length === 0, missing.join(", "));
  check("the header comment is not parsed as a block id", ![...allowed].some((id) => id.startsWith("#")));
}

// --- 6. Guest cannot reach host objects through the bridge --------------
console.log("\n--- bridge argument isolation ---");
{
  // A getter on the options object must not be able to run host-side, and a
  // self-referential object must not crash the host copy step.
  const code = `
    function buildCreation(x, y, z) {
      var evil = {};
      Object.defineProperty(evil, 'blockStates', {
        get: function() { return { hacked: true }; },
        enumerable: true
      });
      safeSetBlock(0, 0, 0, 'stone', evil);
    }
  `;
  let thrown: unknown = null;
  let placements: Awaited<ReturnType<typeof run>> = [];
  try {
    placements = await run(code, allowed);
  } catch (e) {
    thrown = e;
  }
  check(
    "an options object with a getter does not crash the host",
    thrown === null,
    thrown instanceof Error ? thrown.message : undefined,
  );
  check("the placement still resolves", placements.length === 1);
}

// --- a failure carries what the run had done ------------------------------
//
// The trace used to ride only on success, which is exactly backwards: a run
// that worked left a file to look at, and one that failed left a sentence. The
// answer the model gave is the only thing that explains why nothing could be
// built from it, and it went out with the exception.
console.log("\n--- a failure carries its trace ---");
{
  const trace = [{ id: 1, kind: "request", text: "what went out" }];

  // Through an actual throw, because that is the journey it has to survive:
  // the property has to still be there after the stack has unwound to a catch
  // several frames up.
  let caught: unknown;
  try {
    throw attachTrace(new Error("nothing could be built"), trace);
  } catch (err) {
    caught = err;
  }
  check("the error still says what it says", (caught as Error).message === "nothing could be built");
  check("...and carries the run with it", JSON.stringify(traceOf(caught)) === JSON.stringify(trace), JSON.stringify(traceOf(caught)));

  // An error nobody attached anything to, and a thrown non-Error. Neither is a
  // failure of this mechanism, and inventing an empty trace for either would
  // put an empty panel under a message that has no run behind it.
  check("an untouched error carries nothing", traceOf(new Error("plain")) === undefined);
  check("...and neither does a thrown string", traceOf("not an error") === undefined);

  // Copied out, not aliased: the recorder goes on owning its array, and a
  // reader that mutated what it was handed would edit the record.
  const roundTripped = traceOf(caught) as { id: number }[];
  roundTripped.push({ id: 99 });
  check("the caller cannot grow the stored trace", traceOf(caught)!.length === 1);
}

// --- turning an answer into a schematic, and failing legibly ---------------
//
// `textToSchem` is where a generation actually succeeds or fails, and it had no
// test at all. Both of its failures produced one sentence -- "the model's output
// could not be converted" -- which is true and unactionable: the two want
// opposite things from the reader, and neither is addressed by rewording the
// build spec.
console.log("\n--- converting the model's answer ---");
{
  const deps = {
    schematicWriterFactory: new SpongeSchematicWriterFactory(),
    allowedBlocks: await loadAllowedBlocks(REPO_ROOT),
    generatedDir: path.join(REPO_ROOT, "node_modules", ".cache", "bgpt-test"),
  };

  const good = await textToSchem(
    "<code>function buildCreation(x, y, z) { safeSetBlock(x, y, z, 'stone'); }</code>",
    "schem",
    deps,
  );
  check("a well-formed answer builds", good.kind === "schematic", good.kind);

  /*
   * The model wrote code and the code is wrong. Asking again usually fixes it,
   * which is only obvious if the message says the script threw and names why.
   */
  const broken = await textToSchem("<code>this is not javascript(((</code>", "schem", deps);
  check("a script that will not run says so", broken.kind === "none" && broken.reason === "script-failed", broken.kind);
  check(
    "...and names what went wrong",
    broken.kind === "none" && broken.detail.length > 0,
    broken.kind === "none" ? broken.detail : "",
  );
  check(
    "...which the error repeats rather than swallowing",
    broken.kind === "none" && conversionFailureMessage(broken).includes(broken.detail),
    broken.kind === "none" ? conversionFailureMessage(broken) : "",
  );

  /*
   * No `<code>` block at all -- the model answered in prose, or in a markdown
   * fence, or ran out of tokens before closing the tag. Nothing about the build
   * spec is wrong and rewriting it will not help, so the message has to say
   * that this is about the *format* of the answer.
   */
  const prose = await textToSchem(
    "Here is a lovely tower!\n\n```javascript\nfunction buildCreation(){}\n```",
    "schem",
    deps,
  );
  check("an answer with no <code> block says so", prose.kind === "none" && prose.reason === "no-script", prose.kind);
  check(
    "...and the error points at the answer rather than the request",
    prose.kind === "none" && conversionFailureMessage(prose).includes("<code>"),
    prose.kind === "none" ? conversionFailureMessage(prose) : "",
  );
}

console.log(
  `\n=== ${failures === 0 ? "ALL SANDBOX CHECKS PASSED" : `${failures} SANDBOX CHECK(S) FAILED`} ===`,
);
process.exit(failures === 0 ? 0 : 1);
