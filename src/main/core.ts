// Ported from core.py.
//
// RULEBOOK.md §3 (canonical, as amended by DEV-015) — `quickjs-emscripten` is
// the ONLY sanctioned engine for executing LLM-generated buildCreation() JS.
// Never Node's `vm` module, never unsandboxed eval/Function, never a renderer
// with nodeIntegration:true.
//
// §3 originally named `isolated-vm` here. That decision was reversed on
// 2026-08-07 because isolated-vm proved to be unloadable in Electron at all:
// it links against `v8_inspector::*` and `v8::SourceLocation`, and Electron's
// `node.lib` exports neither (verified with dumpbin against Electron 33.4.11 —
// zero matching symbols), while `inspector.cc` is compiled unconditionally by
// its binding.gyp with no opt-out. See DEV-015 for the full evidence.
//
// quickjs-emscripten runs the QuickJS engine compiled to WebAssembly, so the
// sandbox boundary is the WASM boundary: the guest has no ambient authority
// whatsoever, and nothing is bridged in except what is explicitly registered
// below. It also restores engine parity with the Python original, which used
// the `quickjs` C library (core.py:53-60).
//
// §1 "No-equivalent-library pattern" row: `mcschematic` has no npm
// equivalent -> dependency injection. This file never imports a schematic
// writer package; callers that need MCSchematic-shaped output supply a
// `SchematicWriter` (this file's own DI seam, matching the row's own named
// example) plus a version-tag lookup table, rather than this module reaching
// for an unreviewed npm pick.
//
// §1 "Data-object shape" row: interface + free functions, not class +
// methods (structured-clone-safe across the Electron IPC boundary).
//
// §1 async-model row: this file is pure in-memory JS-bridge/coordinate logic
// with two exceptions -- block-list loading and mcfunction export, which are
// file I/O and therefore async (`fs/promises`), matching the ENOENT-catch
// convention from that row, not existsSync/statSync pre-checks.

import { promises as fs } from "node:fs";
import path from "node:path";
// The "singlefile" variant embeds the WASM binary inside the JS module, so
// there is no separate .wasm file to locate at runtime. That matters for
// packaging: an asar archive can serve JS fine, and this removes any need for
// asarUnpack, a per-platform native build, or electron-rebuild.
// `.default` is not redundant: the variant package ships CommonJS, so a default
// import under NodeNext resolution yields `module.exports` (the namespace), and
// the variant itself sits on its `default` property.
import releaseSyncVariantModule from "@jitl/quickjs-singlefile-cjs-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { paletteEntryIsAir, type PaletteEntry } from "./pipeline/types.js";

export const VERSION = "3.0.0";

// ---------------------------------------------------------------------------
// Air sentinel
// ---------------------------------------------------------------------------

// inventory.tsv row `core.py fill_region (should_place closure)`: the
// "unplaced == air" default-value sentinel (core.py:140) must use the exact
// same string literal as types.ts's PaletteEntry.is_air check, not a second
// spelling. Corrected 2026-08-05 per Step 3 review (core.ts reviewer 1): this
// comment previously claimed the literal was derived from paletteEntryIsAir
// to prevent drift, but it is independently declared below -- it happens to
// agree with types.ts's paletteEntryIsAir today (verified: "minecraft:air" is
// one of the strings that function recognizes), but nothing ties the two
// together mechanically. If types.ts's canonical air spelling ever changes,
// this constant must be updated by hand to match.
const AIR_SENTINEL = "minecraft:air";

function isAirBlockData(blockData: string): boolean {
  const base = blockData.split("[", 1)[0];
  const entry: PaletteEntry = { namespacedName: base, properties: {} };
  return paletteEntryIsAir(entry);
}

// ---------------------------------------------------------------------------
// §2 "block-list load failure" row / DEV-007: throw explicitly, never
// silently fall back to an empty allowed-set.
// ---------------------------------------------------------------------------

export class BlockListLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BlockListLoadError";
  }
}

/**
 * Load the allowed-block-id set from `block_id_list.txt` next to this file.
 * Ported from `_load_allowed_blocks` (core.py:14-21). Source silently
 * returned an empty set on ANY read failure; RULEBOOK.md §2 "block-list load
 * failure" row (DEV-007, human sign-off) overrides that: fail loudly with a
 * dedicated error type instead.
 *
 * RULEBOOK.md §1 file-I/O row: `fs/promises` + catch-ENOENT(-or-other)
 * -rethrow pattern, no existsSync/statSync pre-check (TOCTOU race).
 */
export async function loadAllowedBlocks(baseDir: string): Promise<Set<string>> {
  const listPath = path.join(baseDir, "block_id_list.txt");
  let raw: string;
  try {
    raw = await fs.readFile(listPath, "utf-8");
  } catch (e) {
    throw new BlockListLoadError(`load_allowed_blocks: failed to read block list: ${String(e)}`, { cause: e });
  }
  return parseBlockList(raw);
}

/**
 * Splits the block list into ids, dropping blank lines and `#` comments.
 *
 * The comment syntax arrived with the generated list: the file records where it
 * came from and how to rebuild it, and that provenance is worth nothing if the
 * header is silently parsed as six block ids named `#`.
 *
 * Exported because `services/resources.ts` must strip the same lines before
 * splicing the list into the prompt -- the model should not be shown the
 * generator's usage instructions.
 */
export function parseBlockList(raw: string): Set<string> {
  const set = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      set.add(trimmed);
    }
  }
  return set;
}

// ---------------------------------------------------------------------------
// _normalize_block
// ---------------------------------------------------------------------------

// inventory.tsv row `core.py _normalize_block`: a single Optional[str]
// return collapsed two distinct failure causes (falsy block_type vs.
// not-in-allowlist). Mandated fix: a real discriminated result, never
// re-collapsed to one nullable string. Both current call sites (set_block,
// fillRegion below) only branch on ok/not-ok today (matching the source's
// `is None` checks at core.py:89-91/123-125), but the reason is preserved on
// the result for future callers / logging, closing the gap the source had.
export type NormalizeBlockResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: "empty"; readonly blockId: null }
  // The namespaced id as it would have been placed. Carried so a caller can
  // name what it dropped -- see `BuildRejection` below.
  | { readonly ok: false; readonly reason: "unsupported"; readonly blockId: string };

/**
 * Ported from `_normalize_block` (core.py:24-40).
 *
 * inventory.tsv row `core.py _normalize_block` (interface-contract, untyped
 * bridge value): `blockStates` arrives from `options.get("blockStates")`
 * inside JS-bridge calls (core.py:87, 120) with NO type guarantee -- it's
 * whatever the sandboxed script passed across the bridge. This
 * is the concrete runtime validation layer RULEBOOK.md §3 requires at that
 * boundary; TS's static types do not protect against a shape arriving from
 * inside the sandbox, so the isinstance-style guard from the source
 * (core.py:35, `isinstance(block_states, dict)`) is reproduced here as an
 * explicit runtime check, not assumed away.
 */
export function normalizeBlock(
  blockType: string,
  blockStates: unknown,
  allowed: ReadonlySet<string>,
): NormalizeBlockResult {
  if (!blockType) {
    return { ok: false, reason: "empty", blockId: null };
  }
  let base = blockType.trim();
  if (!base.startsWith("minecraft:")) {
    base = `minecraft:${base}`;
  }
  // Strip states for membership check.
  const baseId = base.split("[", 1)[0];
  if (!allowed.has(baseId)) {
    return { ok: false, reason: "unsupported", blockId: baseId };
  }
  if (
    blockStates !== null &&
    typeof blockStates === "object" &&
    !Array.isArray(blockStates) &&
    Object.keys(blockStates as Record<string, unknown>).length > 0
  ) {
    const states = blockStates as Record<string, unknown>;
    const items = Object.keys(states)
      .map((k) => [k, String(states[k])] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const stateStr = items.map(([k, v]) => `${k}=${v}`).join(",");
    return { ok: true, value: `${baseId}[${stateStr}]` };
  }
  return { ok: true, value: baseId };
}

// ---------------------------------------------------------------------------
// _extract_js_code — direct fit, no gap.
// ---------------------------------------------------------------------------

/** Ported from `_extract_js_code` (core.py:43-50). Baseline regex-or-null case. */
export function extractJsCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /<code>\s*([\s\S]*?)\s*<\/code>/i.exec(text);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// sandbox bridge boundary
// ---------------------------------------------------------------------------

export type BlockPlacement = readonly [x: number, y: number, z: number, blockData: string];

/**
 * A block the build script asked for and did not get.
 *
 * `normalizeBlock` has always refused ids outside the allowlist, and both
 * bridge closures have always returned early on that refusal without a word --
 * core.py:90-91 did the same. That silence is the failure mode: a script that
 * builds a house out of a block the list happens not to carry produces an empty
 * schematic and no explanation anywhere, and the only way to find out was to
 * diff the script against the list by hand.
 *
 * The placement is still dropped -- one bad block must not abort a whole build,
 * which is the fault tolerance the source was after. It is now merely dropped
 * *audibly*.
 */
export interface BuildRejection {
  /** Namespaced id, or `null` when the script passed an empty block type. */
  readonly blockId: string | null;
  readonly reason: "empty" | "unsupported";
  /** How many bridge calls were dropped for it. A fill counts once, not once per block. */
  readonly calls: number;
}

/** What `executeJsBuild` produced: the blocks placed, and the ones refused. */
export interface JsBuildOutcome {
  readonly placements: BlockPlacement[];
  readonly rejections: readonly BuildRejection[];
}

/** Accumulates rejections during one build, keyed so each id is reported once. */
type RejectionTally = Map<string, { blockId: string | null; reason: "empty" | "unsupported"; calls: number }>;

function tallyRejection(tally: RejectionTally, result: NormalizeBlockResult & { ok: false }): void {
  const key = result.blockId ?? "";
  const existing = tally.get(key);
  if (existing) {
    existing.calls += 1;
    return;
  }
  tally.set(key, { blockId: result.blockId, reason: result.reason, calls: 1 });
}

// inventory.tsv rows `core.py set_block (closure)` / `fill_region (options)`:
// set_block and fill_region parsed an identical `options` shape
// independently (core.py:86-88 vs. 119-122). RULEBOOK.md §1
// no-equivalent/dedup guidance + inventory's own recommendation: factor into
// ONE shared parsing function rather than duplicating it.
interface ParsedBridgeOptions {
  readonly blockStates: unknown;
  readonly mode: unknown;
  readonly replaceFilter: unknown;
}

function parseBridgeOptions(options: unknown): ParsedBridgeOptions {
  if (options !== null && typeof options === "object" && !Array.isArray(options)) {
    const o = options as Record<string, unknown>;
    return { blockStates: o.blockStates, mode: o.mode, replaceFilter: o.replaceFilter };
  }
  return { blockStates: undefined, mode: undefined, replaceFilter: undefined };
}

// RULEBOOK.md §3 coordinate-coercion rule (post round-1 fix, DO NOT REPEAT
// THE BUG): coordinates crossing the sandbox bridge must be validated
// with Number.isFinite() and REJECTED on failure -- never silently coerced
// via something like Math.trunc(Number(x)), which produces NaN instead of
// throwing and would corrupt placements with "NaN,NaN,NaN" coordinates.
// Round 1's coerceInt() shape is exactly what this function must NOT do.
class CoordinateCoercionError extends Error {
  constructor(label: string, value: unknown) {
    super(`invalid coordinate ${label}: ${String(value)} is not a finite number`);
    this.name = "CoordinateCoercionError";
  }
}

/**
 * Validate-and-truncate a single coordinate value crossing the bridge.
 * Throws CoordinateCoercionError (never returns NaN) if the value is not a
 * finite number. Mirrors core.py's `int(x)` / `int(float(x))` intent but
 * rejects instead of silently producing garbage -- the round-1 stress-test
 * bug this rule exists to prevent.
 */
function coerceCoordinate(label: string, value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new CoordinateCoercionError(label, value);
  }
  return Math.trunc(n);
}

/**
 * The block-placement state built during one buildCreation() execution.
 * Uses a plain Map keyed by a packed string ("x,y,z"). This map lives
 * entirely on the host (main-process) side and is never passed into the
 * sandbox -- guest code can only append to it through the two bridge
 * callbacks, and can never read it back.
 */
function posKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/**
 * Ported from the `set_block` closure (core.py:81-98).
 *
 * inventory.tsv row `core.py set_block (closure)`: the source's broad
 * `except Exception` swallowed ANY failure inside the try (coordinate
 * coercion, block normalization, AND the dict write) and always returned
 * None either way -- fault-tolerant by design (a single bad placement must
 * not abort the whole build), but so broad it could also hide unrelated
 * bugs. Reproduced narrowly here: only a CoordinateCoercionError or a
 * "unsupported"/"empty" normalizeBlock result is caught-and-discarded (the
 * two failure modes the source actually intended to tolerate); any other
 * thrown error (e.g. a real bug) propagates instead of being silently
 * absorbed.
 *
 * RULEBOOK.md §3 coordinate-coercion rule: `set_block`-shaped sites catch
 * the coordinate failure, log, and discard the placement without writing it
 * (do not propagate).
 */
function makeSetBlock(
  allowed: ReadonlySet<string>,
  placements: Map<string, string>,
  rejections: RejectionTally,
  log: (msg: string) => void,
) {
  return function setBlock(
    x: unknown,
    y: unknown,
    z: unknown,
    blockType: unknown,
    options: unknown,
  ): void {
    let bx: number, by: number, bz: number;
    try {
      bx = coerceCoordinate("x", x);
      by = coerceCoordinate("y", y);
      bz = coerceCoordinate("z", z);
    } catch (e) {
      // SAFETY: coordinate validation failure at the bridge boundary --
      // RULEBOOK.md §3, set_block-shaped sites discard rather than abort.
      log(`set_block error: ${String(e)}`);
      return;
    }
    const { blockStates, mode } = parseBridgeOptions(options);
    const result = normalizeBlock(String(blockType), blockStates, allowed);
    if (!result.ok) {
      // Still dropped, matching core.py:90-91 (`if block_data is None: return
      // None`) -- but recorded on the way out, so the caller can say what went
      // missing instead of handing back a mysteriously empty structure.
      tallyRejection(rejections, result);
      return;
    }
    const key = posKey(bx, by, bz);
    if (mode === "keep" && placements.has(key)) {
      return;
    }
    placements.set(key, result.value);
  };
}

/**
 * Ported from the `fill_region` closure (core.py:100-157).
 *
 * RULEBOOK.md §2 `"hollow"` row (DEV-006): "hollow" is dropped and aliased
 * to "outline" -- confirmed dead behavioral distinction, not reproduced
 * bug-for-bug per the human's explicit simplify decision. `mode` is typed as
 * the 3-value union per inventory.tsv's `fill_region` mode row, not the
 * source's untyped 4-string surface.
 *
 * RULEBOOK.md §3 coordinate-coercion rule: `fill_region`-shaped sites let a
 * coordinate failure PROPAGATE and abort the whole build (matching
 * core.py:100-107's own uncaught-on-double-failure shape) -- no try/catch
 * here, unlike set_block above.
 */
function makeFillRegion(
  allowed: ReadonlySet<string>,
  placements: Map<string, string>,
  rejections: RejectionTally,
) {
  return function fillRegion(
    x1: unknown,
    y1: unknown,
    z1: unknown,
    x2: unknown,
    y2: unknown,
    z2: unknown,
    blockType: unknown,
    options: unknown,
  ): void {
    // No catch here: per §3, fill_region-shaped sites propagate a
    // coordinate-coercion failure and abort the whole build.
    let ix1 = coerceCoordinate("x1", x1);
    let iy1 = coerceCoordinate("y1", y1);
    let iz1 = coerceCoordinate("z1", z1);
    let ix2 = coerceCoordinate("x2", x2);
    let iy2 = coerceCoordinate("y2", y2);
    let iz2 = coerceCoordinate("z2", z2);

    if (ix1 > ix2) [ix1, ix2] = [ix2, ix1];
    if (iy1 > iy2) [iy1, iy2] = [iy2, iy1];
    if (iz1 > iz2) [iz1, iz2] = [iz2, iz1];

    const { blockStates, mode: rawMode, replaceFilter } = parseBridgeOptions(options);
    // inventory.tsv `core.py fill_region` mode row: 3-value union, "hollow"
    // collapsed into "outline" per RULEBOOK.md §2 (DEV-006).
    const mode: "keep" | "replace" | "outline" | undefined =
      rawMode === "hollow" ? "outline" : (rawMode as "keep" | "replace" | "outline" | undefined);

    const result = normalizeBlock(String(blockType), blockStates, allowed);
    if (!result.ok) {
      // One tally entry for the whole fill: `calls` counts refused bridge
      // calls, not the blocks a successful fill would have written.
      tallyRejection(rejections, result);
      return;
    }
    const blockData = result.value;

    let replaceBase: string | null = null;
    if (replaceFilter) {
      const rf = String(replaceFilter);
      replaceBase = rf.startsWith("minecraft:") ? rf : `minecraft:${rf}`;
    }

    const shouldPlace = (px: number, py: number, pz: number): boolean => {
      const key = posKey(px, py, pz);
      if (mode === "keep" && placements.has(key)) {
        return false;
      }
      if (mode === "replace" && replaceBase !== null) {
        // core.py:140: `.get()` default-VALUE sentinel -- "unplaced == air".
        // Must use the exact same string as PaletteEntry.is_air; see
        // AIR_SENTINEL / isAirBlockData above (types.ts is the source of
        // truth for the spelling, not a second literal here).
        const existing = placements.get(key) ?? AIR_SENTINEL;
        if (existing.split("[", 1)[0] !== replaceBase) {
          return false;
        }
      }
      return true;
    };

    const outlineOnly = mode === "outline";
    for (let ix = ix1; ix <= ix2; ix++) {
      for (let iy = iy1; iy <= iy2; iy++) {
        for (let iz = iz1; iz <= iz2; iz++) {
          if (outlineOnly) {
            const atSurface = ix === ix1 || ix === ix2 || iy === iy1 || iy === iy2 || iz === iz1 || iz === iz2;
            if (!atSurface) continue;
          }
          if (shouldPlace(ix, iy, iz)) {
            placements.set(posKey(ix, iy, iz), blockData);
          }
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Sandbox-violation vs. bad-generated-code error split
// ---------------------------------------------------------------------------

/**
 * (a) bad generated code: a JS syntax/runtime error thrown from WITHIN the
 * executed script. User-facing generation error, logged normally, build
 * fails gracefully, generation may be retried.
 */
export class GeneratedCodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GeneratedCodeError";
  }
}

/**
 * (b) sandbox violation: an engine-level failure (deadline interrupt,
 * memory-limit exceeded, stack overflow, or any error originating from the
 * runtime/context machinery itself rather than from the script's own logic).
 * Security-relevant: log distinctly, fail hard, never retry.
 *
 * RULEBOOK.md §3 (amendment item 8, inventory's highest-priority row,
 * core.py:185-192): every prior agent declined to invent this policy and
 * flagged it instead -- this is the actual decision, not more deferral.
 */
export class SandboxViolationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxViolationError";
  }
}

/**
 * Distinguish an engine-machinery failure (interrupt/deadline, memory-limit,
 * stack overflow) from a plain JS error thrown by the executed script's own
 * code. Same two-bucket split RULEBOOK.md §3 has always mandated; only the
 * message vocabulary changes with the engine swap (DEV-015).
 *
 * QuickJS surfaces the deadline interrupt as `InternalError: interrupted` and
 * allocation refusals as `out of memory` / `stack overflow`. Script-thrown
 * errors do not organically produce those strings.
 */
function classifySandboxError(e: unknown): "sandbox-violation" | "generated-code" {
  const msg = e instanceof Error ? e.message : String(e);
  if (
    /interrupted/i.test(msg) ||
    /out of memory/i.test(msg) ||
    /stack overflow/i.test(msg) ||
    /script execution timed out/i.test(msg)
  ) {
    return "sandbox-violation";
  }
  return "generated-code";
}

const JS_EXECUTION_TIMEOUT_MS = 5000;
const ISOLATE_MEMORY_LIMIT_MB = 128;

/** Raised when the QuickJS WASM module cannot be instantiated at all. */
export class SandboxUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxUnavailableError";
  }
}

/**
 * The WASM module is instantiated once, on first use, and reused.
 *
 * Loading lazily is not a §3 relaxation -- it keeps a sandbox failure scoped to
 * generation instead of killing the main process at import time, so preview,
 * settings and artifact browsing stay usable. Reusing the *module* is safe and
 * is not state sharing: a fresh `Runtime` and `Context` are created per build
 * below, which is what "fresh context each time to avoid state pollution"
 * (core.py:54) actually requires.
 */
let quickJsModule: QuickJSWASMModule | null = null;

async function loadQuickJs(): Promise<QuickJSWASMModule> {
  if (quickJsModule) {
    return quickJsModule;
  }
  try {
    quickJsModule = await newQuickJSWASMModuleFromVariant(releaseSyncVariantModule.default);
    return quickJsModule;
  } catch (e) {
    throw new SandboxUnavailableError(
      `The QuickJS sandbox could not be initialized: ${String(e)}`,
      { cause: e },
    );
  }
}

/**
 * Ported from `_execute_js_build` (core.py:63-200).
 *
 * RULEBOOK.md §3 (as amended by DEV-015): quickjs-emscripten is the
 * sanctioned engine. This restores engine parity with the Python source,
 * which used the `quickjs` C library via `quickjs.Context()`. A fresh Runtime
 * + Context is created per call (same "fresh context each time to avoid state
 * pollution" intent as `_ensure_quickjs`, core.py:54).
 *
 * The pySetBlock/pyFill bridge uses explicit host-function registration (per
 * RULEBOOK.md §3, "not shared memory") -- native functions installed on the
 * guest global, invoked synchronously from inside the sandbox.
 */
/**
 * Registers one host callback on the guest's global object.
 *
 * SAFETY: `context.dump` copies each argument out of the WASM heap into a plain
 * JS value before the host callback ever sees it, so no guest handle escapes
 * into host code and the host cannot be tricked into retaining guest memory.
 * The handles passed in are owned by the engine and must not be disposed here;
 * the function handle we create *is* ours, and is disposed once installed.
 */
function registerHostFunction(
  context: QuickJSContext,
  name: string,
  handler: (args: unknown[]) => void,
): void {
  const fnHandle = context.newFunction(name, (...argHandles) => {
    handler(argHandles.map((handle) => context.dump(handle) as unknown));
    // Returning nothing yields `undefined` in the guest -- these two bridge
    // functions are void, exactly as core.py's set_block/fill_region were.
  });
  try {
    context.setProp(context.global, name, fnHandle);
  } finally {
    fnHandle.dispose();
  }
}

/**
 * `evalCode` reports failure as a returned error handle rather than a thrown
 * exception. This converts it back to a throw so the call site keeps the same
 * shape it had under isolated-vm, and so the deadline interrupt surfaces as an
 * error the classifier can see.
 */
function evalOrThrow(context: QuickJSContext, code: string, filename: string): void {
  const result = context.evalCode(code, filename);
  if (result.error) {
    const dumped = context.dump(result.error) as unknown;
    result.error.dispose();
    const message =
      dumped && typeof dumped === "object" && "message" in dumped
        ? String((dumped as { message: unknown }).message)
        : String(dumped);
    const name =
      dumped && typeof dumped === "object" && "name" in dumped
        ? String((dumped as { name: unknown }).name)
        : "Error";
    const err = new Error(message);
    err.name = name;
    throw err;
  }
  result.value.dispose();
}

export async function executeJsBuild(
  code: string,
  allowedBlocks: ReadonlySet<string>,
  log: (msg: string) => void = () => {},
): Promise<JsBuildOutcome> {
  // Transform async code to sync for backward compatibility, matching
  // core.py:75-76's safety-net regex substitution (the prompt now instructs
  // synchronous generation directly; this is a fallback for old-style code).
  let transformed = code.replace(/\basync\s+function\b/g, "function").replace(/\bawait\s+/g, "");

  const placements = new Map<string, string>();
  const rejections: RejectionTally = new Map();
  const setBlock = makeSetBlock(allowedBlocks, placements, rejections, log);
  const fillRegion = makeFillRegion(allowedBlocks, placements, rejections);

  const quickJs = await loadQuickJs();

  // SAFETY: this is the ONLY sandboxed engine sanctioned by RULEBOOK.md §3 for
  // LLM-generated code -- a fresh runtime + context per build, memory-limited
  // and deadline-interrupted, with no access to Node globals/filesystem/network
  // unless explicitly bridged below. The guest runs inside WebAssembly, so it
  // has no ambient authority to reach for in the first place.
  // (SAFETY comments live on the actual creation/bridge/eval call sites, per
  // Step 3 review of core.ts by reviewers 1+2.)
  const runtime = quickJs.newRuntime();
  runtime.setMemoryLimit(ISOLATE_MEMORY_LIMIT_MB * 1024 * 1024);
  // Replaces isolated-vm's per-eval `timeout` option: one deadline covering the
  // whole build, enforced by the engine's interrupt handler.
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + JS_EXECUTION_TIMEOUT_MS));

  // SAFETY: a fresh, empty context -- no bridged capability exists until
  // explicitly registered below.
  const context = runtime.newContext();
  try {
    // Bridge host functions into the guest as native function handles
    // (RULEBOOK.md §3 -- explicit callbacks, not shared memory). Registration
    // failures propagate (matches core.py:160-165's `except: log; raise`,
    // inventory.tsv row `core.py _execute_js_build` bridge-registration row:
    // fail loudly, unlike set_block/fill_region's own internal catches).
    // SAFETY: the ONLY two host capabilities exposed into the sandbox are
    // these two narrow, validated block-placement callbacks -- no filesystem,
    // network, process, or arbitrary-host-function access is bridged in.
    try {
      registerHostFunction(context, "pySetBlock", (args) => {
        setBlock(args[0], args[1], args[2], args[3], args[4]);
      });
      registerHostFunction(context, "pyFill", (args) => {
        fillRegion(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]);
      });
    } catch (e) {
      log(`quickjs bridge error: ${String(e)}`);
      throw e;
    }

    // Helper wrappers + minimal Promise polyfill, ported from core.py:171-184.
    // The `.applySync(..., {arguments:{copy:true}})` indirection isolated-vm
    // required is gone: host functions registered above are directly callable,
    // and arguments are copied out of the guest heap by `context.dump` inside
    // `registerHostFunction`, so no guest handle ever escapes into host code.
    const helperJs = `
      var console = { log: function() {}, warn: function() {}, error: function() {} };
      function safeSetBlock(x,y,z,blockType,options){ pySetBlock(x,y,z,blockType,options); }
      function safeFill(x1,y1,z1,x2,y2,z2,blockType,options){ pyFill(x1,y1,z1,x2,y2,z2,blockType,options); }
      function safeFillBiome(x1,y1,z1,x2,y2,z2,biome){ /* biome not supported */ }
      if (typeof Promise === 'undefined') {
        var Promise = {};
      }
      Promise.all = function(arr) { return null; };
      Promise.resolve = function(v) { return v; };
    `;

    // SAFETY: this is where untrusted, LLM-generated JS actually runs. All
    // three evals share the deadline set on the runtime above and are confined
    // to the context created above -- the only host capabilities reachable from
    // here are the two narrow callbacks registered above, nothing else.
    try {
      evalOrThrow(context, helperJs, "<helpers>");
      evalOrThrow(context, transformed, "<generated>");
      evalOrThrow(context, "buildCreation(0, 0, 0)", "<entrypoint>");
    } catch (e) {
      const kind = classifySandboxError(e);
      if (kind === "sandbox-violation") {
        // SAFETY: engine-machinery-level failure (deadline interrupt / memory
        // limit / stack overflow) -- RULEBOOK.md §3 amendment item 8:
        // security-relevant, log distinctly, fail hard, never retry.
        log(`execute_js_build: SANDBOX VIOLATION: ${String(e)}`);
        throw new SandboxViolationError(`quickjs sandbox violation: ${String(e)}`, { cause: e });
      }
      // (a) bad generated code: user-facing generation error, logged
      // normally, build fails gracefully, generation may be retried.
      log(`execute_js_build: JS error: ${String(e)}`);
      throw new GeneratedCodeError(`generated JS failed: ${String(e)}`, { cause: e });
    }
  } finally {
    // SAFETY: always tear down, even on error paths -- these hold WASM heap
    // allocations that must not leak across builds.
    context.dispose();
    runtime.dispose();
  }

  const out: BlockPlacement[] = [];
  for (const [key, block] of placements) {
    const [x, y, z] = key.split(",").map(Number);
    out.push([x, y, z, block]);
  }
  // Sort for determinism, matching core.py:199 (`out.sort()`, lexicographic
  // tuple order -> equivalent to sorting by x, then y, then z here).
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

  // Most refused calls first: if a script asked for one unknown block once and
  // another five hundred times, the second is the one worth naming.
  const refused = [...rejections.values()].sort((a, b) => b.calls - a.calls);
  for (const rejection of refused) {
    log(
      `execute_js_build: dropped ${rejection.calls} call(s) for ` +
        `${rejection.blockId ?? "(empty block type)"} (${rejection.reason})`,
    );
  }
  return { placements: out, rejections: refused };
}

// ---------------------------------------------------------------------------
// Schematic writer DI seam (RULEBOOK.md §1 "No-equivalent-library pattern"
// row, mcschematic -- this IS the row's own named example)
// ---------------------------------------------------------------------------

/**
 * DI seam replacing `mcschematic.MCSchematic`. RULEBOOK.md §1: "the
 * consuming module takes a factory/interface parameter ... rather than a
 * dead placeholder stub or an unreviewed npm pick." No ratification flag
 * needed -- this is the row's own named example, not an extension of it.
 */
export interface SchematicWriter {
  setBlock(pos: readonly [number, number, number], blockData: string): void;
}

export interface SchematicWriterFactory {
  create(): SchematicWriter;
}

// ---------------------------------------------------------------------------
// text_to_schem
// ---------------------------------------------------------------------------

export type ExportType = "schem" | "mcfunction";

export type TextToSchemResult =
  | { readonly kind: "schematic"; readonly schematic: SchematicWriter; readonly rejections: readonly BuildRejection[] }
  | { readonly kind: "mcfunctionPath"; readonly path: string; readonly rejections: readonly BuildRejection[] }
  | { readonly kind: "none" };

/**
 * Ported from `text_to_schem` (core.py:203-278).
 *
 * inventory.tsv row `core.py text_to_schem (JS path)`: presence of
 * `<code>` tags commits to the JS path with NO JSON fallback even on JS
 * failure -- source's own comment (core.py:229-230) documents this intent
 * explicitly, ported faithfully, no ambiguity.
 *
 * inventory.tsv row `core.py text_to_schem (JSON fallback path)`: legacy
 * JSON parse failure -> null (here, `{kind:"none"}`), single homogeneous
 * "parse failed" outcome, no multi-cause collapsing.
 *
 * `SchematicWriter`/`SchematicWriterFactory`/`allowedBlocks`/`baseDir` are
 * caller-supplied per the DI seam above and the file-I/O rule (block-list
 * load is async, generated dir is created via `fs/promises`).
 */
export async function textToSchem(
  text: string,
  exportType: ExportType,
  deps: {
    schematicWriterFactory: SchematicWriterFactory;
    allowedBlocks: ReadonlySet<string>;
    generatedDir: string;
    log?: (msg: string) => void;
  },
): Promise<TextToSchemResult> {
  const log = deps.log ?? (() => {});

  // 1) Try JS path first. If <code> is present, we commit to this path.
  const jsCode = extractJsCode(text);
  if (jsCode) {
    try {
      const { placements, rejections } = await executeJsBuild(jsCode, deps.allowedBlocks, log);
      if (exportType === "schem") {
        const schematic = deps.schematicWriterFactory.create();
        for (const [x, y, z, block] of placements) {
          schematic.setBlock([x, y, z], block);
        }
        return { kind: "schematic", schematic, rejections };
      } else {
        await fs.mkdir(deps.generatedDir, { recursive: true });
        const filePath = path.join(deps.generatedDir, "temp.mcfunction");
        const lines = placements.map(([x, y, z, block]) => `setblock ${x} ${y} ${z} ${block}\n`).join("");
        await fs.writeFile(filePath, lines, "utf-8");
        return { kind: "mcfunctionPath", path: filePath, rejections };
      }
    } catch (e) {
      // Environment failure, not model output: the sandbox could not be
      // loaded at all, so nothing was ever evaluated. Collapsing this into
      // "the model's output could not be converted" would send the user
      // rewriting a prompt to fix a missing native addon.
      if (e instanceof SandboxUnavailableError) {
        throw e;
      }
      // Matches core.py:227-231: any failure on the JS path (including a
      // SandboxViolationError -- the source's broad except predates the
      // sandbox-violation/bad-code split, and RULEBOOK.md §3 doesn't carve
      // out a different top-level text_to_schem behavior for it) logs and
      // returns None/{kind:"none"}. Do not fall back to JSON parsing.
      log(`text_to_schem(JS): failed with error: ${String(e)}`);
      return { kind: "none" };
    }
  }

  // 2) Fallback to legacy JSON format ONLY if no JS code was found.
  try {
    const data = JSON.parse(text) as {
      structures: Array<{
        block: string;
        x: number;
        y: number;
        z: number;
        type: string;
        toX?: number;
        toY?: number;
        toZ?: number;
      }>;
    };
    log("text_to_schem(JSON): loaded JSON data");
    if (exportType === "schem") {
      const schematic = deps.schematicWriterFactory.create();
      for (const structure of data.structures) {
        const blockId = structure.block;
        if (structure.type === "fill") {
          const { x, y, z, toX, toY, toZ } = structure;
          for (let ix = x; ix <= (toX as number); ix++) {
            for (let iy = y; iy <= (toY as number); iy++) {
              for (let iz = z; iz <= (toZ as number); iz++) {
                schematic.setBlock([ix, iy, iz], blockId);
              }
            }
          }
        } else {
          schematic.setBlock([structure.x, structure.y, structure.z], blockId);
        }
      }
      // No rejections to report: this path never consults the allowlist. It
      // writes whatever ids the JSON named, which is the source's behavior
      // (core.py:240-268 called neither `_normalize_block` nor the bridge).
      return { kind: "schematic", schematic, rejections: [] };
    } else {
      await fs.mkdir(deps.generatedDir, { recursive: true });
      const filePath = path.join(deps.generatedDir, "temp.mcfunction");
      const lines: string[] = [];
      for (const structure of data.structures) {
        const blockId = structure.block;
        if (structure.type === "fill") {
          const { x, y, z, toX, toY, toZ } = structure;
          for (let ix = x; ix <= (toX as number); ix++) {
            for (let iy = y; iy <= (toY as number); iy++) {
              for (let iz = z; iz <= (toZ as number); iz++) {
                lines.push(`setblock ${ix} ${iy} ${iz} ${blockId}\n`);
              }
            }
          }
        } else {
          lines.push(`setblock ${structure.x} ${structure.y} ${structure.z} ${blockId}\n`);
        }
      }
      await fs.writeFile(filePath, lines.join(""), "utf-8");
      return { kind: "mcfunctionPath", path: filePath, rejections: [] };
    }
  } catch (e) {
    log(`text_to_schem(JSON): failed to parse JSON: ${String(e)}`);
    return { kind: "none" };
  }
}

// ---------------------------------------------------------------------------
// input_version_to_mcs_tag
// ---------------------------------------------------------------------------

/**
 * Ported from `input_version_to_mcs_tag` (core.py:281-287).
 *
 * inventory.tsv row `core.py input_version_to_mcs_tag`: source used
 * `getattr(mcschematic.Version, input_version)`, a dynamic attribute lookup
 * with no TS/JS equivalent. Per the row's mandated fix: an explicit lookup
 * table built from the target's own MCSchematic-equivalent version enum,
 * caller-supplied here (continuing the §1 DI pattern above -- `mcschematic`
 * itself has no npm equivalent, so its "Version" enum has no canonical TS
 * source to build this table from except whatever the caller's chosen
 * schematic-writer backend defines).
 *
 * TODO(port): the caller-supplied `versionTable`'s concrete key set (i.e.
 * which MCSchematic-equivalent version enum backs it) is not decided by any
 * rulebook/inventory row read for this file -- left as the caller's
 * responsibility per §2's UNKNOWN rule, most conservative option (no
 * silent default table baked in here).
 *
 * TODO(port): NEEDS RULEBOOK RATIFICATION -- added 2026-08-05 per Step 3
 * review (core.ts reviewer 2). The inventory row's literal wording is a
 * table "built at compile time"; this implementation instead takes the
 * table as a runtime caller-supplied parameter, justified by citing §1's
 * general DI pattern. Per §2's delegating rule ("the inventory is
 * authoritative for site-specific decisions"), the inventory row's specific
 * wording should govern over §1's general pattern here -- this substitution
 * was not previously flagged as a rulebook conflict, only as an open
 * question about the table's key set. Flagging now for explicit human
 * sign-off rather than silently treating the substitution as settled.
 */
export function inputVersionToMcsTag(
  inputVersion: string,
  versionTable: Readonly<Record<string, unknown>>,
  log: (msg: string) => void = () => {},
): unknown {
  if (!(inputVersion in versionTable)) {
    log(`input_version_to_mcs_tag: failed to convert version ${inputVersion}; not in version table`);
    return null;
  }
  return versionTable[inputVersion];
}

// ---------------------------------------------------------------------------
// format_version_for_prompt
// ---------------------------------------------------------------------------

/**
 * Ported from `format_version_for_prompt` (core.py:290-301).
 *
 * inventory.tsv row `core.py format_version_for_prompt`: unlike every other
 * `except: return None` in this file, this one falls back to the INPUT
 * unchanged on failure, not null. Preserved exactly -- do not "fix" it to
 * fallback-to-null, flagged here per the inventory row precisely so this
 * outlier isn't silently normalized away.
 */
export function formatVersionForPrompt(versionEnumName: string): string {
  try {
    // JE_1_20_4 -> 1.20.4, JE_1_21 -> 1.21
    const parts = versionEnumName.split("_");
    const nums = parts.filter((p) => /^\d+$/.test(p));
    if (nums.length === 0) {
      return versionEnumName;
    }
    return nums.join(".");
  } catch {
    return versionEnumName;
  }
}

// PORT STATUS: confidence=high todos=2
