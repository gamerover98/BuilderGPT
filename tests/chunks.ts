/**
 * `pipeline/chunked_mesh.ts` — meshing only what changed.
 *
 * The property everything else rests on: **an incrementally updated mesh is
 * identical to one built from scratch.** A chunk cache that is merely
 * *plausible* renders a structure that looks right until the one chunk it
 * forgot, and there is no error to notice — so the suite compares bytes, over a
 * sequence of edits chosen to land on the awkward places: chunk interiors,
 * chunk boundaries, corners where three chunks meet, and a block removed rather
 * than added.
 *
 * The second property is that it actually saves the work it exists to save.
 * A cache that quietly rebuilds everything would pass every equality check
 * above and be worthless, so the number of chunks rebuilt is asserted too.
 */

import {
  createDocument,
  setBlock,
  toStructureData,
  type SchematicDocument,
} from "../src/main/domain/document.js";
import { buildAtlas } from "../src/main/pipeline/atlas.js";
import {
  buildChunkedMesh,
  createChunkMeshCache,
  CHUNK_SIZE,
  type ChunkMeshCache,
} from "../src/main/pipeline/chunked_mesh.js";
import { buildMesh, culledFaces } from "../src/main/pipeline/mesher.js";
import { readSignText, type SignText } from "../src/main/pipeline/sign_text.js";
import { ModelBaker } from "../src/main/pipeline/model_baker.js";
import type { MeshBuffers, PaletteEntry } from "../src/main/pipeline/types.js";

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

const block = (name: string, properties: Record<string, string> = {}): PaletteEntry => ({
  namespacedName: name,
  properties,
});
const STONE = block("minecraft:stone");
const PLANKS = block("minecraft:oak_planks");
const GLASS = block("minecraft:glass");
const SIGN = block("minecraft:oak_sign", { rotation: "0" });

/** A sign saying one thing, as the mesher is handed it. */
function sign(line: string): SignText {
  const read = readSignText({
    Text1: { type: "string", value: JSON.stringify({ text: line }) },
  } as never);
  if (read === null) throw new Error("the fixture says nothing");
  return read;
}
const AIR = block("minecraft:air");

/** A stable fingerprint of the geometry, order included. */
function fingerprint(buffers: MeshBuffers): string {
  const hash = (array: Float32Array | Uint32Array): string => {
    let h = 2166136261;
    for (let i = 0; i < array.length; i += 1) {
      h ^= Math.round(array[i] * 1000) | 0;
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  };
  return [
    buffers.positions.length,
    buffers.indices.length,
    hash(buffers.positions),
    hash(buffers.normals),
    hash(buffers.uvs),
    hash(buffers.indices),
  ].join(":");
}

console.log("=== Schematic AI Studio: chunked meshing ===\n");

const baker = await ModelBaker.create(null);

/** A structure spanning several chunks, with something in every one. */
function seeded(): SchematicDocument {
  const doc = createDocument({ width: 40, height: 40, length: 40 });
  for (let x = 0; x < 40; x += 1) {
    for (let z = 0; z < 40; z += 1) {
      setBlock(doc, x, 0, z, STONE);
      if (x % 5 === 0 || z % 5 === 0) setBlock(doc, x, 1, z, PLANKS);
    }
  }
  for (let y = 0; y < 40; y += 1) setBlock(doc, 20, y, 20, GLASS);
  return doc;
}

/** Meshes from a cold cache — the "from scratch" reference. */
async function fromScratch(doc: SchematicDocument) {
  const structure = toStructureData(doc);
  // Prime the baker so the atlas is complete before UVs are computed, exactly
  // as `preview.ts` does.
  await culledFaces(structure, baker);
  const atlas = buildAtlas(baker.textures);
  return buildChunkedMesh(structure, baker, atlas.uvRects, 1, createChunkMeshCache());
}

async function incremental(
  doc: SchematicDocument,
  cache: ChunkMeshCache,
  signs: ReadonlyMap<number, SignText> | null = null,
) {
  const structure = toStructureData(doc);
  const atlas = buildAtlas(baker.textures);
  return buildChunkedMesh(structure, baker, atlas.uvRects, 1, cache, null, signs);
}

// --- chunked output matches the unchunked mesher ----------------------------
//
// Different order, so the bytes differ; what must agree is how much geometry
// there is. A chunked pass that dropped or duplicated a face would show here.
console.log("--- against the whole-structure mesher ---");
{
  const doc = seeded();
  const structure = toStructureData(doc);
  const faces = await culledFaces(structure, baker);
  const atlas = buildAtlas(baker.textures);
  const whole = buildMesh(faces, atlas.uvRects);
  const chunked = await fromScratch(doc);

  equal("the same number of vertices", chunked.buffers.positions.length, whole.positions.length);
  equal("the same number of indices", chunked.buffers.indices.length, whole.indices.length);
  equal("the same number of UVs", chunked.buffers.uvs.length, whole.uvs.length);
  check(
    "every index still addresses a real vertex",
    chunked.buffers.indices.every((i) => i < chunked.buffers.positions.length / 3),
  );
}

// --- the property that matters ----------------------------------------------
console.log("\n--- incremental equals from-scratch ---");
{
  // Deliberately awkward positions: inside a chunk, on a face boundary, on an
  // edge, on the corner where eight chunks meet, and a removal.
  const edits: Array<[string, (doc: SchematicDocument) => void]> = [
    ["deep inside one chunk", (d) => setBlock(d, 5, 5, 5, STONE)],
    ["on an x boundary", (d) => setBlock(d, CHUNK_SIZE - 1, 4, 4, GLASS)],
    ["across that boundary", (d) => setBlock(d, CHUNK_SIZE, 4, 4, GLASS)],
    ["on a y boundary", (d) => setBlock(d, 4, CHUNK_SIZE, 4, PLANKS)],
    ["on the corner of eight chunks", (d) => setBlock(d, CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE, STONE)],
    ["removing a block", (d) => setBlock(d, 20, 10, 20, AIR)],
    ["removing one on a boundary", (d) => setBlock(d, 20, CHUNK_SIZE, 20, AIR)],
    ["re-adding it", (d) => setBlock(d, 20, CHUNK_SIZE, 20, GLASS)],
  ];

  const doc = seeded();
  let result = await fromScratch(doc);
  let mismatches = 0;

  for (const [label, edit] of edits) {
    edit(doc);
    result = await incremental(doc, result.cache);

    // The same document, meshed with no history behind it.
    const clean = createDocument({ width: doc.width, height: doc.height, length: doc.length });
    clean.voxels.set(doc.voxels);
    clean.palette = [...doc.palette];
    clean.paletteIndex = new Map(doc.paletteIndex);
    const reference = await fromScratch(clean);

    const same = fingerprint(result.buffers) === fingerprint(reference.buffers);
    if (!same) mismatches += 1;
    check(`${label}: incremental matches a rebuild`, same);
  }
  equal("no edit produced a different mesh", mismatches, 0);
}

// --- it really does skip work -----------------------------------------------
//
// Everything above would also pass if the cache silently rebuilt the whole
// structure every time, which would make it pointless.
console.log("\n--- and it skips the untouched chunks ---");
{
  const doc = seeded();
  const cold = await fromScratch(doc);
  equal("a cold cache builds every chunk", cold.rebuilt, cold.total);
  check("the structure really spans many chunks", cold.total >= 27, `${cold.total} chunks`);

  const unchanged = await incremental(doc, cold.cache);
  equal("meshing again with no edit rebuilds nothing", unchanged.rebuilt, 0);
  check(
    "...and produces the same geometry",
    fingerprint(unchanged.buffers) === fingerprint(cold.buffers),
  );

  setBlock(doc, 5, 5, 5, STONE);
  const one = await incremental(doc, unchanged.cache);
  equal("one block deep inside a chunk rebuilds exactly that chunk", one.rebuilt, 1);

  // A block on a boundary has to dirty the chunk across it, or that chunk
  // keeps drawing a face the new neighbour now hides.
  setBlock(doc, CHUNK_SIZE - 1, 5, 5, GLASS);
  const boundary = await incremental(doc, one.cache);
  equal("one on an x boundary rebuilds two", boundary.rebuilt, 2);

  setBlock(doc, CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE, PLANKS);
  const corner = await incremental(doc, boundary.cache);
  equal("one on a three-axis corner rebuilds four", corner.rebuilt, 4);

  /*
   * ...and a sign that has been retyped, which is the third thing this cache
   * has had to learn to see.
   *
   * The rule is the same one and this is why it is a rule: a voxel grid and a
   * light grid are what the cache compares, and text is neither. Editing a
   * sign's words moved nothing either array holds, so the chunk stayed exactly
   * as it was -- the old sign on screen and the new one in the file, until some
   * unrelated edit nearby happened to dirty it.
   *
   * One chunk and not seven. `markDirty` spreads to the face-neighbours because
   * light does; text does not leave the block it is written on.
   */
  setBlock(doc, 5, 5, 5, SIGN);
  const at = 5 * doc.height * doc.length + 5 * doc.length + 5;
  const said = (line: string) => new Map([[at, sign(line)]]);
  const written = await incremental(doc, corner.cache, said("prima"));
  check("placing the sign rebuilt its chunk", written.rebuilt >= 1);

  const same = await incremental(doc, written.cache, said("prima"));
  equal("the same words rebuild nothing", same.rebuilt, 0);

  const retyped = await incremental(doc, same.cache, said("dopo"));
  equal("retyping it rebuilds exactly its chunk", retyped.rebuilt, 1);

  const rubbedOut = await incremental(doc, retyped.cache, new Map());
  equal("...and rubbing it out does too", rubbedOut.rebuilt, 1);
}

// --- what has to invalidate everything --------------------------------------
console.log("\n--- full invalidation ---");
{
  const doc = seeded();
  const first = await fromScratch(doc);

  const atlas = buildAtlas(baker.textures);
  const newAtlas = await buildChunkedMesh(
    toStructureData(doc),
    baker,
    atlas.uvRects,
    // A different atlas version: cached UVs address a layout that no longer
    // exists, so keeping them would texture the whole structure wrongly.
    99,
    first.cache,
  );
  equal("a rebuilt atlas invalidates every chunk", newAtlas.rebuilt, newAtlas.total);

  const resized = createDocument({ width: 48, height: 40, length: 40 });
  resized.voxels.set(doc.voxels.subarray(0, Math.min(doc.voxels.length, resized.voxels.length)));
  resized.palette = [...doc.palette];
  resized.paletteIndex = new Map(doc.paletteIndex);
  const afterResize = await buildChunkedMesh(
    toStructureData(resized),
    baker,
    atlas.uvRects,
    1,
    first.cache,
  );
  equal("so does a resize", afterResize.rebuilt, afterResize.total);
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exitCode = failures === 0 ? 0 : 1;
