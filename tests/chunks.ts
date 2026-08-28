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
import { fillVoid } from "../src/main/services/preview.js";
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

/** The pieces of one layer, fused, so two layers can be compared as bytes. */
function concat(pieces: readonly MeshBuffers[]): MeshBuffers {
  let vertices = 0;
  let indices = 0;
  for (const piece of pieces) {
    vertices += piece.positions.length / 3;
    indices += piece.indices.length;
  }
  const out = {
    positions: new Float32Array(vertices * 3),
    normals: new Float32Array(vertices * 3),
    uvs: new Float32Array(vertices * 2),
    indices: new Uint32Array(indices),
    light: new Float32Array(vertices * 3),
    opaqueIndices: 0,
  };
  let v = 0;
  let i = 0;
  for (const piece of pieces) {
    out.positions.set(piece.positions, v * 3);
    out.normals.set(piece.normals, v * 3);
    out.uvs.set(piece.uvs, v * 2);
    out.light.set(piece.light, v * 3);
    for (let k = 0; k < piece.indices.length; k += 1) out.indices[i + k] = piece.indices[k] + v;
    v += piece.positions.length / 3;
    i += piece.indices.length;
  }
  return out;
}


// --- empty space made of something else -------------------------------------
//
// A schematic has always been full of air, and for an underwater build that is
// wrong in a way that only shows up after the paste. Choosing a block here
// swaps the *air palette entry* for it, so every empty cell becomes a cell of
// water without a voxel being touched -- and the faces come out in a layer of
// their own, which is what lets the viewer give them their own material and
// keep them out of the raycaster.
console.log("\n--- the void block ---");
{
  const doc = createDocument({ width: 4, height: 4, length: 4 });
  setBlock(doc, 1, 1, 1, STONE);
  const real = toStructureData(doc);

  /*
   * Air is the default and has to stay free. Nothing is rebuilt, nothing is
   * marked, and the structure comes back as the very same object -- which is
   * what makes "no void block" cost nothing at all rather than cost a copy.
   */
  const untouched = fillVoid(real, "");
  check("no void block leaves the structure alone", untouched.structure === real);
  equal("...and marks nothing", untouched.voidIndices.size, 0);
  /*
   * And so does one that *spells* air. Two spellings of one state would have
   * the mesher visit every cell to draw nothing.
   */
  equal("air by name is the same as no void block", fillVoid(real, "minecraft:air").voidIndices.size, 0);

  const filled = fillVoid(real, "minecraft:water");
  /*
   * Index 0 is always air (`domain/document.ts` guarantees it), which is what
   * makes this a one-entry edit rather than a pass over the whole grid.
   */
  equal("the air entry becomes the void block", filled.structure.palette[0].namespacedName, "minecraft:water");
  check("...and is marked as void", filled.voidIndices.has(0));
  check("...while the stone beside it is not", !filled.voidIndices.has(1));
  check("the voxels are shared, not copied", filled.structure.voxels === real.voxels);
  check("...and the original palette is untouched", real.palette[0].namespacedName === "minecraft:air");

  /*
   * Both populations, one rule.
   *
   * A break writes the void block for real, so a document can hold cells of it
   * that were never air. Keyed on the palette rather than on "was this cell
   * air", they are the same thing -- which is the sentence that makes\
   * hand-placed water unpickable too, and that is the request rather than a
   * side effect.
   */
  const withWater = createDocument({ width: 4, height: 4, length: 4 });
  setBlock(withWater, 1, 1, 1, block("minecraft:water"));
  const both = fillVoid(toStructureData(withWater), "minecraft:water");
  equal("a placed void block is void as well", both.voidIndices.size, 2);
}

console.log("\n--- the two layers ---");
{
  /*
   * One pass, two layers. Culling has to see both at once: the water's face at
   * a wall and the wall's own face are the same plane, and only a pass that
   * knows about both removes one of them. Meshed separately they would both be
   * drawn and z-fight along every surface of the build.
   */
  const doc = createDocument({ width: 6, height: 6, length: 6 });
  setBlock(doc, 2, 2, 2, STONE);
  const real = toStructureData(doc);
  const filled = fillVoid(real, "minecraft:water");

  await culledFaces(filled.structure, baker, undefined, null, undefined, filled.voidIndices);
  const atlas = buildAtlas(baker.textures);

  const plain = await buildChunkedMesh(
    real,
    baker,
    atlas.uvRects,
    1,
    createChunkMeshCache(),
  );
  equal("without a void block there is no void layer", plain.voidPieces.length, 0);
  check("...and the structure is still meshed", plain.pieces.length > 0);

  const voided = await buildChunkedMesh(
    filled.structure,
    baker,
    atlas.uvRects,
    1,
    createChunkMeshCache(),
    null,
    null,
    filled.voidIndices,
  );
  check("with one, the void gets a layer of its own", voided.voidPieces.length > 0);

  /*
   * The solid layer is *unchanged* by the void, which is the property the
   * whole split exists for: the schematic is what it always was, and the void
   * is drawn beside it.
   */
  equal(
    "the structure's own geometry is untouched by it",
    fingerprint(concat(voided.pieces)),
    fingerprint(concat(plain.pieces)),
  );

  /*
   * And `buffers` -- the fused geometry, which `EmptyPreviewError` measures --
   * stays about the schematic. Folded together, an empty document would come
   * back full of water and the check that catches a deleted build showing its
   * own ghost would never fire again.
   */
  equal(
    "the fused mesh is the structure, not the void",
    fingerprint(voided.buffers),
    fingerprint(plain.buffers),
  );

  const empty = createDocument({ width: 4, height: 4, length: 4 });
  const emptyFilled = fillVoid(toStructureData(empty), "minecraft:water");
  const emptyVoided = await buildChunkedMesh(
    emptyFilled.structure,
    baker,
    atlas.uvRects,
    1,
    createChunkMeshCache(),
    null,
    null,
    emptyFilled.voidIndices,
  );
  equal("a document with nothing in it still meshes as empty", emptyVoided.buffers.indices.length, 0);
  check("...while its void has a shell", emptyVoided.voidPieces.length > 0);

  /*
   * And the interface is culled, which is the z-fighting guard stated as a
   * number.
   *
   * A stone block dropped into the middle of the void takes one cell away
   * from it -- and that cell's six faces were interior ones, culled against
   * its identical neighbours. The six water faces now *pointing at* the stone
   * are culled too, because stone covers them and its texture is opaque. So
   * the void geometry has to come out **byte for byte the same** as it does
   * with nothing in the box at all.
   *
   * If it does not, the extra faces are water drawn in the same plane as the
   * stone's own -- which is exactly what meshing the two layers in separate
   * passes would produce, and it is invisible until the two start flickering
   * against each other at a distance.
   */
  const boxed = createDocument({ width: 4, height: 4, length: 4 });
  setBlock(boxed, 1, 1, 1, STONE);
  const boxedFilled = fillVoid(toStructureData(boxed), "minecraft:water");
  const boxedVoided = await buildChunkedMesh(
    boxedFilled.structure,
    baker,
    atlas.uvRects,
    1,
    createChunkMeshCache(),
    null,
    null,
    boxedFilled.voidIndices,
  );
  equal(
    "the void draws no face where a block covers it",
    fingerprint(concat(boxedVoided.voidPieces)),
    fingerprint(concat(emptyVoided.voidPieces)),
  );

  /*
   * Glass, on the other hand, does *not* cover it: its texture is not opaque,
   * so the water behind it is drawn and has to be. The pair is what stops the
   * check above from passing for the wrong reason -- a void layer that culled
   * against everything would satisfy it just as well, and would put a hole in
   * the water behind every pane in the build.
   */
  const glazed = createDocument({ width: 4, height: 4, length: 4 });
  setBlock(glazed, 1, 1, 1, GLASS);
  const glazedFilled = fillVoid(toStructureData(glazed), "minecraft:water");
  const glazedVoided = await buildChunkedMesh(
    glazedFilled.structure,
    baker,
    atlas.uvRects,
    1,
    createChunkMeshCache(),
    null,
    null,
    glazedFilled.voidIndices,
  );
  check(
    "...but does draw one behind something see-through",
    concat(glazedVoided.voidPieces).indices.length >
      concat(emptyVoided.voidPieces).indices.length,
  );
}


console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exitCode = failures === 0 ? 0 : 1;
