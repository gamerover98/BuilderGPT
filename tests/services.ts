/**
 * Redesign-slice validation harness (ARCHITECTURE.md §6 item 3).
 *
 * Same shape and spirit as `smoke.ts`: cheap, headless, real execution. Covers
 * the new main-process services that do NOT need an Electron app object --
 * `schematic.ts`, `versions.ts`, `preview.ts`, and the pure helpers in
 * `llm.ts`/`opencode.ts`/`generate.ts`/`artifacts.ts`.
 *
 * The centrepiece is the schematic **round-trip**: write placements with the
 * new `SpongeSchematicWriter`, read them back with `pipeline/loader.ts`, and
 * require an exact match. That is a real referee rather than a self-consistency
 * check, because `loader.ts` was parity-verified against the Python
 * implementation at Step 6 -- if the writer emits a malformed or
 * differently-ordered schematic, the already-trusted reader disagrees.
 */

import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

import { loadStructure } from "../src/main/pipeline/loader.js";
import { LlmError, resolveBaseUrl } from "../src/main/services/llm.js";
import { describeFor, sanitizeName } from "../src/main/services/naming.js";
import { labelFor } from "../src/main/services/opencode.js";
import { buildPreview, clearPreviewCache, sunAnglesRadians } from "../src/main/services/preview.js";
import { SpongeSchematicWriter } from "../src/main/services/schematic.js";
import { dataVersionFor, VERSION_NAMES, VERSION_TABLE } from "../src/main/services/versions.js";

/**
 * Mirrors `services/resources.ts`'s `defaultResourcePackPath()` without pulling
 * in Electron: same directory, same "first .zip wins" rule.
 */
async function findBundledResourcePack(): Promise<string | null> {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "resources");
  try {
    const zips = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".zip")).sort();
    return zips.length > 0 ? path.join(dir, zips[0]) : null;
  } catch {
    return null;
  }
}

let failures = 0;

function check(label: string, cond: boolean): void {
  if (cond) {
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

console.log("=== BuilderGPT redesign-slice service smoke test ===\n");

const workDir = await mkdtemp(path.join(tmpdir(), "bgpt-smoke-"));

try {
  // --- versions.ts ---------------------------------------------------------
  console.log("--- versions ---");
  check("version table is non-empty", VERSION_NAMES.length > 0);
  check("default version is present", "JE_1_20_4" in VERSION_TABLE);
  equal("JE_1_20_4 -> DataVersion 3700", dataVersionFor("JE_1_20_4"), 3700);
  check(
    "unknown version throws",
    (() => {
      try {
        dataVersionFor("JE_9_9_9");
        return false;
      } catch {
        return true;
      }
    })(),
  );

  // --- schematic.ts round-trip through the parity-verified loader ----------
  console.log("\n--- schematic write -> loader read round-trip ---");
  const writer = new SpongeSchematicWriter();
  const placements: Array<readonly [number, number, number, string]> = [
    [0, 0, 0, "minecraft:stone"],
    [1, 0, 0, "minecraft:oak_planks"],
    [2, 0, 0, "minecraft:stone"],
    [0, 1, 0, "minecraft:glass"],
    [0, 0, 1, "minecraft:oak_stairs[facing=east,half=bottom]"],
  ];
  for (const [x, y, z, block] of placements) {
    writer.setBlock([x, y, z], block);
  }
  equal("writer holds 5 blocks", writer.blockCount, 5);

  const schemPath = await writer.save(workDir, "roundtrip", dataVersionFor("JE_1_20_4"));
  const structure = await loadStructure(schemPath);

  equal("bounds width  (x: 0..2)", structure.bounds.maxX - structure.bounds.minX + 1, 3);
  equal("bounds height (y: 0..1)", structure.bounds.maxY - structure.bounds.minY + 1, 2);
  equal("bounds length (z: 0..1)", structure.bounds.maxZ - structure.bounds.minZ + 1, 2);

  const height = structure.bounds.maxY - structure.bounds.minY + 1;
  const length = structure.bounds.maxZ - structure.bounds.minZ + 1;
  // Flat-index formula per RULEBOOK.md §2: x * height * length + y * length + z.
  const at = (x: number, y: number, z: number) => {
    const entry = structure.palette[structure.voxels[x * height * length + y * length + z]];
    if (!entry) return "<missing>";
    const props = Object.entries(entry.properties);
    if (props.length === 0) return entry.namespacedName;
    return `${entry.namespacedName}[${props.map(([k, v]) => `${k}=${v}`).join(",")}]`;
  };

  for (const [x, y, z, block] of placements) {
    equal(`voxel (${x},${y},${z}) === ${block}`, at(x, y, z), block);
  }
  equal("unset voxel (1,1,1) is air", at(1, 1, 1), "minecraft:air");

  // --- preview.ts ----------------------------------------------------------
  console.log("\n--- preview ---");
  // The bundled pack is normally resolved by the IPC handler through
  // `defaultResourcePackPath()`, which needs Electron. Resolve it directly here
  // so this suite keeps exercising the textured path instead of silently
  // degrading to flat colours.
  const bundledPack = await findBundledResourcePack();
  check("bundled default resource pack is present", bundledPack !== null);

  const preview = await buildPreview({
    schemPath,
    resourcePackPath: null,
    fallbackResourcePackPath: bundledPack,
  });
  check("GLB magic is 'glTF'", Buffer.from(preview.glb.slice(0, 4)).toString("ascii") === "glTF");
  check("GLB is non-trivial", preview.glb.byteLength > 512);
  check("first build is not cached", preview.cached === false);
  const cachedPreview = await buildPreview({
    schemPath,
    resourcePackPath: null,
    fallbackResourcePackPath: bundledPack,
  });
  check("second build hits the cache", cachedPreview.cached === true);
  check(
    "cached GLB is byte-identical",
    Buffer.compare(Buffer.from(preview.glb), Buffer.from(cachedPreview.glb)) === 0,
  );

  // Proves the bundled pack is actually *applied*, not merely accepted: with it,
  // the atlas carries real block textures; without it, flat colours. A wiring
  // regression would make these two identical.
  clearPreviewCache();
  const untextured = await buildPreview({
    schemPath,
    resourcePackPath: null,
    fallbackResourcePackPath: null,
  });
  check(
    "bundled pack changes the render (textures vs flat colours)",
    Buffer.compare(Buffer.from(preview.glb), Buffer.from(untextured.glb)) !== 0,
  );

  const sun = sunAnglesRadians({
    sunAzimuthDeg: 180,
    sunElevationDeg: 90,
    maxDpr: 1,
    renderScale: 1,
    maxDrawDistance: 512,
    showGrid: true,
    wireframe: false,
    ambientOcclusion: true,
  });
  check("180 deg -> pi rad", Math.abs(sun.azimuth - Math.PI) < 1e-12);
  check("90 deg -> pi/2 rad", Math.abs(sun.elevation - Math.PI / 2) < 1e-12);

  // --- llm.ts / opencode.ts / generate.ts pure helpers ---------------------
  console.log("\n--- helpers ---");
  equal(
    "OpenAI default base URL",
    resolveBaseUrl("OpenAI", ""),
    "https://api.openai.com/v1",
  );
  equal("explicit base URL wins", resolveBaseUrl("OpenAI", "https://x.test/v1"), "https://x.test/v1");
  check(
    "Custom provider without a base URL fails loudly",
    (() => {
      try {
        resolveBaseUrl("Custom (OpenAI Compatible)", "  ");
        return false;
      } catch (err) {
        return err instanceof LlmError;
      }
    })(),
  );

  equal("free model label", labelFor("mimo-v2.5-free"), "mimo-v2.5-free (Gratuito)");
  equal("paid thinking label", labelFor("gpt-5-reasoning"), "gpt-5-reasoning (A pagamento | Thinking)");

  equal("path traversal is stripped from names", sanitizeName("../../evil"), "evil");
  equal("empty model name falls back", sanitizeName("   "), "structure");
  equal("normal name survives", sanitizeName("Stone Tower"), "Stone Tower");
  equal(
    "description truncates at 50 with ellipsis",
    describeFor("x".repeat(60)),
    `${"x".repeat(50)}...`,
  );
  equal("short description keeps no ellipsis", describeFor("small house"), "small house");
} finally {
  await rm(workDir, { recursive: true, force: true });
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
