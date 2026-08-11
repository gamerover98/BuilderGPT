// Ported from app/pipeline/gltf_builder.py.
//
// migration/inventory.tsv has zero rows for this file — confirmed clean by
// two Step 2 stress-test rounds' file-selection scoring (RULEBOOK.md
// Amendment history; also DEV-010, which logs that a 3rd stress-test round
// on this file was offered and explicitly declined by the human). No
// site-specific gaps are recorded; general RULEBOOK.md conventions apply.
//
// PNG encoding: `atlas.image` is an `RgbaImage` (RULEBOOK.md §1 "Image
// composition" row: plain {width, height, data: Uint8Array} struct, not a
// PIL.Image equivalent). The source calls `PIL.Image.save(..., format="PNG")`
// to get PNG-encoded bytes for the glTF image chunk; the sanctioned PNG
// codec per RULEBOOK.md §1 "Third-party deps" row is `pngjs` (decode/encode
// only — composition itself is hand-rolled elsewhere, per the same row).
import { PNG } from "pngjs";

import type { AtlasResult, GLBResult, MeshBuffers } from "./types.js";

const GLTF_HEADER_MAGIC = 0x46546c67;
const GLTF_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a; // "JSON"
const BIN_CHUNK_TYPE = 0x004e4942; // "BIN\0"

/**
 * Ported from `_append_with_padding` (gltf_builder.py:16-23). Records `data`
 * as the next piece of the binary chunk, plus zero padding to the next 4-byte
 * boundary — glTF binary chunks (and the overall GLB container) must be 4-byte
 * aligned. Padding math `(4 - (length % 4)) % 4` reproduced exactly.
 *
 * The pieces are kept as typed arrays and joined once, at the end. This began
 * as a `number[]` appended to one byte at a time, which is how the Python read,
 * and it had two problems that only appear at scale:
 *
 * - **It could not build a large schematic at all.** V8 caps a plain array's
 *   backing store at 134,217,727 elements, so a binary chunk past ~128 MB threw
 *   `RangeError: Invalid array length` — measured, a 96x96x96 structure is
 *   enough to hit it, and the preview died rather than degrading.
 * - It was the single most expensive step in the pipeline. At 64x64x64 the
 *   byte-by-byte append cost 1173 ms of a 1952 ms build, more than the culling
 *   and meshing put together, because every byte was a boxed array slot.
 *
 * `Uint8Array.set` is a memcpy and has no such ceiling.
 */
function appendWithPadding(target: Uint8Array[], data: Uint8Array): [offset: number, length: number] {
  // Summed rather than tracked: there are five pieces, so this is cheaper than
  // another variable to keep in step with the array.
  const offset = byteLength(target);
  target.push(data);
  const padding = (4 - (data.length % 4)) % 4;
  if (padding > 0) {
    target.push(new Uint8Array(padding));
  }
  return [offset, data.length];
}

function byteLength(pieces: readonly Uint8Array[]): number {
  let total = 0;
  for (const piece of pieces) {
    total += piece.length;
  }
  return total;
}

function concatBytes(pieces: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(byteLength(pieces));
  let cursor = 0;
  for (const piece of pieces) {
    out.set(piece, cursor);
    cursor += piece.length;
  }
  return out;
}

/**
 * Pads to the next 4-byte boundary with `fill`.
 *
 * The two chunk kinds pad with different bytes: glTF requires the JSON chunk to
 * be padded with spaces and the binary chunk with zeros.
 */
function padTo4(data: Uint8Array, fill: number): Uint8Array {
  const padding = (4 - (data.length % 4)) % 4;
  if (padding === 0) {
    return data;
  }
  const out = new Uint8Array(data.length + padding);
  out.set(data, 0);
  out.fill(fill, data.length);
  return out;
}

/**
 * Little-endian `struct.pack("<III", ...)` equivalent — three uint32 values.
 * DataView with littleEndian=true reproduces Python's `<` byte-order
 * specifier exactly, per the task brief.
 */
function packUint32x3LE(a: number, b: number, c: number): Uint8Array {
  const buf = new Uint8Array(12);
  const view = new DataView(buf.buffer);
  view.setUint32(0, a, true);
  view.setUint32(4, b, true);
  view.setUint32(8, c, true);
  return buf;
}

/** Little-endian `struct.pack("<II", ...)` equivalent — two uint32 values. */
function packUint32x2LE(a: number, b: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint32(0, a, true);
  view.setUint32(4, b, true);
  return buf;
}

/** Little-endian float32 array pack — equivalent of `ndarray.astype(np.float32).tobytes()`. */
function packFloat32ArrayLE(values: ArrayLike<number>): Uint8Array {
  const buf = new Uint8Array(values.length * 4);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setFloat32(i * 4, values[i], true);
  }
  return buf;
}

/** Little-endian uint32 array pack — equivalent of `ndarray.astype(np.uint32).tobytes()`. */
function packUint32ArrayLE(values: ArrayLike<number>): Uint8Array {
  const buf = new Uint8Array(values.length * 4);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setUint32(i * 4, values[i], true);
  }
  return buf;
}

/** min/max over a flat float array interpreted as N x `comps`-wide rows, per-component. */
function componentMinMax(
  flat: ArrayLike<number>,
  comps: number,
): { min: number[]; max: number[] } {
  const min = new Array<number>(comps).fill(Number.POSITIVE_INFINITY);
  const max = new Array<number>(comps).fill(Number.NEGATIVE_INFINITY);
  const count = flat.length / comps;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < comps; c++) {
      const v = flat[i * comps + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

/**
 * Encode an `RgbaImage` (RULEBOOK.md §1 "Image composition" row struct) as
 * PNG bytes via `pngjs` (RULEBOOK.md §1 "Third-party deps" row — named
 * exception, decode/encode only).
 */
function encodeRgbaImageToPng(image: AtlasResult["image"]): Uint8Array {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return new Uint8Array(PNG.sync.write(png));
}

/**
 * Ported from `mesh_to_glb` (gltf_builder.py:26-187). Builds a binary GLB
 * (glTF 2.0 binary container) from mesh buffers + atlas texture data.
 */
export function meshToGlb(mesh: MeshBuffers, atlas: AtlasResult): GLBResult {
  if (mesh.positions.length === 0) {
    // Ported from gltf_builder.py:27-44 — empty-mesh short-circuit, JSON-only
    // GLB (no BIN chunk at all, not just an empty one).
    const empty = {
      asset: { version: "2.0", generator: "Schematic AI Studio Preview" },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [] }],
      buffers: [{ byteLength: 0 }],
      bufferViews: [],
      accessors: [],
      materials: [],
    };
    // Padded with ASCII space (0x20), per the glTF spec: the JSON chunk pads
    // with spaces, unlike the BIN chunk's zeros.
    const jsonBytesArr = padTo4(Buffer.from(JSON.stringify(empty), "utf-8"), 0x20);
    const header = packUint32x3LE(GLTF_HEADER_MAGIC, GLTF_VERSION, 12 + 8 + jsonBytesArr.length);
    const jsonChunkHeader = packUint32x2LE(jsonBytesArr.length, JSON_CHUNK_TYPE);
    return {
      glbBytes: concatBytes([header, jsonChunkHeader, jsonBytesArr]),
      center: [0, 0, 0],
      size: [0, 0, 0],
    };
  }

  const positions = mesh.positions; // already Float32Array per MeshBuffers
  const normals = mesh.normals;
  const uvs = mesh.uvs;
  const indices = mesh.indices; // already Uint32Array per MeshBuffers

  const atlasBytes = encodeRgbaImageToPng(atlas.image);

  const binChunk: Uint8Array[] = [];
  const bufferViews: Array<Record<string, unknown>> = [];
  const accessors: Array<Record<string, unknown>> = [];

  const [posOffset, posLength] = appendWithPadding(binChunk, packFloat32ArrayLE(positions));
  bufferViews.push({
    buffer: 0,
    byteOffset: posOffset,
    byteLength: posLength,
    target: 34962,
  });
  const posMinMax = componentMinMax(positions, 3);
  const posVertexCount = positions.length / 3;
  accessors.push({
    bufferView: bufferViews.length - 1,
    componentType: 5126,
    count: posVertexCount,
    type: "VEC3",
    min: posMinMax.min,
    max: posMinMax.max,
  });

  const [normalOffset, normalLength] = appendWithPadding(binChunk, packFloat32ArrayLE(normals));
  bufferViews.push({
    buffer: 0,
    byteOffset: normalOffset,
    byteLength: normalLength,
    target: 34962,
  });
  accessors.push({
    bufferView: bufferViews.length - 1,
    componentType: 5126,
    count: normals.length / 3,
    type: "VEC3",
  });

  const [uvOffset, uvLength] = appendWithPadding(binChunk, packFloat32ArrayLE(uvs));
  bufferViews.push({
    buffer: 0,
    byteOffset: uvOffset,
    byteLength: uvLength,
    target: 34962,
  });
  accessors.push({
    bufferView: bufferViews.length - 1,
    componentType: 5126,
    count: uvs.length / 2,
    type: "VEC2",
  });

  const [idxOffset, idxLength] = appendWithPadding(binChunk, packUint32ArrayLE(indices));
  bufferViews.push({
    buffer: 0,
    byteOffset: idxOffset,
    byteLength: idxLength,
    target: 34963,
  });
  accessors.push({
    bufferView: bufferViews.length - 1,
    componentType: 5125,
    count: indices.length,
    type: "SCALAR",
  });

  const [imageOffset, imageLength] = appendWithPadding(binChunk, atlasBytes);
  bufferViews.push({
    buffer: 0,
    byteOffset: imageOffset,
    byteLength: imageLength,
  });

  const gltf = {
    asset: { version: "2.0", generator: "Schematic AI Studio Preview" },
    scenes: [{ nodes: [0] }],
    scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: {
              POSITION: 0,
              NORMAL: 1,
              TEXCOORD_0: 2,
            },
            indices: 3,
            material: 0,
          },
        ],
      },
    ],
    buffers: [{ byteLength: binChunk.length }],
    bufferViews,
    accessors,
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0.0,
          roughnessFactor: 1.0,
        },
        // Without these the material is OPAQUE and single-sided, which is what
        // made glass and glass panes render as solid tiles: the alpha channel
        // of the texture was simply ignored. MASK rather than BLEND because
        // Minecraft textures are cut-outs, not translucency, and BLEND would
        // need back-to-front sorting to look right.
        alphaMode: "MASK",
        alphaCutoff: 0.5,
        // Required by the thin geometry: a pane, a ladder or a flower's cross
        // quads are visible from both sides, and a single-sided material makes
        // them vanish when viewed from behind.
        doubleSided: true,
      },
    ],
    samplers: [
      {
        magFilter: 9728, // NEAREST
        minFilter: 9728, // NEAREST (no mipmaps to prevent bleeding)
        wrapS: 33071, // CLAMP_TO_EDGE
        wrapT: 33071,
      },
    ],
    images: [
      {
        bufferView: bufferViews.length - 1,
        mimeType: "image/png",
      },
    ],
    textures: [{ sampler: 0, source: 0 }],
  };

  const jsonBytes = padTo4(Buffer.from(JSON.stringify(gltf), "utf-8"), 0x20);
  const binChunkBytes = concatBytes(binChunk);

  const totalLength = 12 + 8 + jsonBytes.length + 8 + binChunkBytes.length;
  const header = packUint32x3LE(GLTF_HEADER_MAGIC, GLTF_VERSION, totalLength);
  const jsonChunkHeader = packUint32x2LE(jsonBytes.length, JSON_CHUNK_TYPE);
  const binChunkHeader = packUint32x2LE(binChunkBytes.length, BIN_CHUNK_TYPE);

  const glbBytes = concatBytes([
    header,
    jsonChunkHeader,
    jsonBytes,
    binChunkHeader,
    binChunkBytes,
  ]);

  const posMinMaxFinal = componentMinMax(positions, 3);
  const center: [number, number, number] = [
    (posMinMaxFinal.min[0] + posMinMaxFinal.max[0]) / 2.0,
    (posMinMaxFinal.min[1] + posMinMaxFinal.max[1]) / 2.0,
    (posMinMaxFinal.min[2] + posMinMaxFinal.max[2]) / 2.0,
  ];
  const size: [number, number, number] = [
    posMinMaxFinal.max[0] - posMinMaxFinal.min[0],
    posMinMaxFinal.max[1] - posMinMaxFinal.min[1],
    posMinMaxFinal.max[2] - posMinMaxFinal.min[2],
  ];

  return { glbBytes, center, size };
}

// PORT STATUS: confidence=high todos=0
