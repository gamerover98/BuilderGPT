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

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}`);
    if (detail) console.log(`         ${detail}`);
    failures++;
  }
}

console.log(`=== Schematic AI Studio TS port smoke test (core.ts VERSION=${VERSION}) ===\n`);

// --- Scenario 1: jscode2blocks ---
console.log("--- jscode2blocks ---");
{
  const allowed = await loadAllowedBlocks(REPO_ROOT);
  check("loadAllowedBlocks found real block ids", allowed.size > 0);
  check("minecraft:stone is an allowed block", allowed.has("minecraft:stone"));

  const code = "function buildCreation(x,y,z){ safeSetBlock(0,0,0,'stone',null); }";
  const { placements, rejections } = await executeJsBuild(code, allowed);
  check("executeJsBuild placed exactly one block", placements.length === 1);
  check("a clean build reports no dropped blocks", rejections.length === 0);
  check(
    "placement is (0,0,0,minecraft:stone)",
    placements.length === 1 &&
      placements[0]![0] === 0 &&
      placements[0]![1] === 0 &&
      placements[0]![2] === 0 &&
      placements[0]![3] === "minecraft:stone",
  );

  // Determinism check, same technique as the Python judge's run_self_check.py.
  const second = await executeJsBuild(code, allowed);
  check(
    "executeJsBuild is deterministic (same input, same output)",
    JSON.stringify(placements) === JSON.stringify(second.placements),
  );
}

// --- Scenario 2: schem2glb ---
console.log("\n--- schem2glb ---");
{
  const structure = await loadStructure(path.join(REPO_ROOT, "tests/fixtures/sample.schem"));
  check("loadStructure read the fixture", structure.voxels.length > 0);

  // Explicitly no translator, which is the case being exercised. It used to
  // be an omitted argument, which reads the same and is a different thing:
  // `normalizePalette` takes two, and only tests/ going unchecked hid it.
  const normalized = normalizePalette(structure, undefined);
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

// --- Scenario 3: a GLB too big for a plain array ---
//
// `meshToGlb` used to assemble its binary chunk by pushing one byte at a time
// into a `number[]`. V8 caps a plain array's backing store at 134,217,727
// elements, so past ~128 MB of geometry it threw `RangeError: Invalid array
// length` and the preview died outright — measured, a 96x96x96 structure was
// enough. The buffers are built directly rather than by running the pipeline,
// because the point is the assembly step and culling a real structure that
// large would take seconds.
console.log("\n--- a GLB larger than a plain array can hold ---");
{
  const vertices = 4_000_000; // ~145 MB of binary chunk, comfortably over the cap
  const quads = vertices / 4;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  const indices = new Uint32Array(quads * 6);
  // Real-ish values: a zero-size bounding box would take the empty-mesh path
  // and never reach the assembly this is here to exercise.
  for (let i = 0; i < vertices; i += 1) {
    positions[i * 3] = i % 512;
    positions[i * 3 + 1] = (i >> 9) % 512;
    positions[i * 3 + 2] = (i >> 18) % 512;
    normals[i * 3 + 1] = 1;
  }
  for (let q = 0; q < quads; q += 1) {
    const v = q * 4;
    indices.set([v, v + 2, v + 1, v, v + 3, v + 2], q * 6);
  }

  const atlas = buildAtlas((await ModelBaker.create(null)).textures);
  const big = meshToGlb({ positions, normals, uvs, indices }, atlas);
  const magic = Buffer.from(big.glbBytes.buffer, big.glbBytes.byteOffset, 4).toString("ascii");
  check("a 145 MB GLB is produced rather than throwing", magic === "glTF");
  check(
    "...and is larger than the plain-array ceiling that used to stop it",
    big.glbBytes.length > 134_217_727,
    `${(big.glbBytes.length / 1048576).toFixed(0)} MB`,
  );
  // The GLB container declares its own total length in the header; if the
  // assembly miscounted, every reader would reject the file.
  const declared = new DataView(
    big.glbBytes.buffer,
    big.glbBytes.byteOffset,
    big.glbBytes.length,
  ).getUint32(8, true);
  check("the header's declared length matches the bytes emitted", declared === big.glbBytes.length);
}

console.log(`\n=== ${failures === 0 ? "PASS" : "FAIL"}: smoke test ${failures === 0 ? "succeeded" : `(${failures} check(s) failed)`} ===`);
process.exit(failures === 0 ? 0 : 1);
