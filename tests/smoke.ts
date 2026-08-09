/**
 * End-to-end smoke test for the two things this app fundamentally does:
 * turn an LLM-written build script into block placements (jscode2blocks), and
 * turn a schematic into a renderable GLB (schem2glb).
 *
 * These two scenarios are the ones that were verified byte-for-byte against the
 * original Python implementation during the port, so keeping them green is what
 * says the pipeline still behaves like the spec it was translated from.
 */
import { loadAllowedBlocks, executeJsBuild, VERSION } from "../src/main/core.js";
import { loadStructure } from "../src/main/pipeline/loader.js";
import { normalizePalette } from "../src/main/pipeline/translate.js";
import { ModelBaker } from "../src/main/pipeline/model_baker.js";
import { culledFaces, buildMesh } from "../src/main/pipeline/mesher.js";
import { buildAtlas } from "../src/main/pipeline/atlas.js";
import { meshToGlb } from "../src/main/pipeline/gltf_builder.js";

import path from "node:path";
import { fileURLToPath } from "node:url";

// Was hardcoded to "/app", the Docker container path -- the only place this
// test could run while the sandbox needed a native build. quickjs-emscripten
// is WASM (DEV-015), so it now runs anywhere; resolve the repo root instead.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;

function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}`);
    failures++;
  }
}

console.log(`=== BuilderGPT TS port smoke test (core.ts VERSION=${VERSION}) ===\n`);

// --- Scenario 1: jscode2blocks ---
console.log("--- jscode2blocks ---");
{
  const allowed = await loadAllowedBlocks(REPO_ROOT);
  check("loadAllowedBlocks found real block ids", allowed.size > 0);
  check("minecraft:stone is an allowed block", allowed.has("minecraft:stone"));

  const code = "function buildCreation(x,y,z){ safeSetBlock(0,0,0,'stone',null); }";
  const placements = await executeJsBuild(code, allowed);
  check("executeJsBuild placed exactly one block", placements.length === 1);
  check(
    "placement is (0,0,0,minecraft:stone)",
    placements.length === 1 &&
      placements[0]![0] === 0 &&
      placements[0]![1] === 0 &&
      placements[0]![2] === 0 &&
      placements[0]![3] === "minecraft:stone",
  );

  // Determinism check, same technique as the Python judge's run_self_check.py.
  const placements2 = await executeJsBuild(code, allowed);
  check(
    "executeJsBuild is deterministic (same input, same output)",
    JSON.stringify(placements) === JSON.stringify(placements2),
  );
}

// --- Scenario 2: schem2glb ---
console.log("\n--- schem2glb ---");
{
  const structure = await loadStructure(path.join(REPO_ROOT, "tests/fixtures/sample.schem"));
  check("loadStructure read the fixture", structure.voxels.length > 0);

  const normalized = normalizePalette(structure); // no translator injected -> pass-through
  check("normalizePalette pass-through (no translator) returns input unchanged", normalized === structure);

  const baker = await ModelBaker.create(null);
  const faces = await culledFaces(normalized, baker);
  check("culledFaces produced faces for the 2-stone-block fixture", faces.length > 0);

  const atlasResult = buildAtlas(baker.textures);
  const mesh = buildMesh(faces, atlasResult.uvRects);
  check("buildMesh produced vertices", mesh.positions.length > 0);

  const glb = meshToGlb(mesh, atlasResult);
  const magic = Buffer.from(glb.glbBytes.buffer, glb.glbBytes.byteOffset, 4).toString("ascii");
  check("meshToGlb produced a valid GLB magic header", magic === "glTF");
  check("meshToGlb reports non-zero bounds size", glb.size.some((v) => v !== 0));

  console.log(`  (GLB: ${glb.glbBytes.length} bytes, center=${JSON.stringify(glb.center)}, size=${JSON.stringify(glb.size)})`);
}

console.log(`\n=== ${failures === 0 ? "PASS" : "FAIL"}: smoke test ${failures === 0 ? "succeeded" : `(${failures} check(s) failed)`} ===`);
process.exit(failures === 0 ? 0 : 1);
