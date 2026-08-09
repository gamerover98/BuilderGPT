/**
 * Container-format parity for `pipeline/loader.ts`.
 *
 * The app used to read exactly one layout -- Sponge v2, the one its own writer
 * emits -- because the Python original only ever read files it had written
 * itself. With a file picker in the UI it also meets Sponge v3 (WorldEdit
 * 7.3+, FAWE) and legacy MCEdit `.schematic`, and a v3 file failed with
 * "expected numeric tag for Width" on a file that is perfectly well formed.
 *
 * The referee here is equivalence, not self-consistency: one structure is
 * encoded three ways and all three must decode to the *same* voxel grid. The
 * v2 encoding comes from `SpongeSchematicWriter`, which is itself already
 * round-trip verified in `services.ts` against the parity-checked reader, so
 * the other two are being compared against a known-good baseline rather than
 * against each other.
 */

import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { gzip as gzipCb } from "zlib";

import { writeUncompressed } from "prismarine-nbt";

import { loadStructure, SchematicFormatError } from "../src/main/pipeline/loader.js";
import { SpongeSchematicWriter } from "../src/main/services/schematic.js";
import { dataVersionFor } from "../src/main/services/versions.js";

const gzip = promisify(gzipCb);

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

const LEGACY_BLOCKS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "resources",
  "legacy_blocks.json",
);

// --- the one structure, described once --------------------------------------
//
// 3 x 2 x 2, deliberately non-cubic so a transposed axis cannot pass by
// coincidence. Only blocks with no block-state properties are used: MCEdit
// carries state in a 4-bit metadata nibble and the flattening table decides
// how that becomes a modern state string, so including a stair here would be
// testing the table rather than the decoders.
const WIDTH = 3;
const HEIGHT = 2;
const LENGTH = 2;

/** `[x, y, z, modern name, legacy id]`. */
const BLOCKS: ReadonlyArray<readonly [number, number, number, string, number]> = [
  [0, 0, 0, "minecraft:stone", 1],
  [1, 0, 0, "minecraft:oak_planks", 5],
  [2, 0, 0, "minecraft:stone", 1],
  [0, 1, 0, "minecraft:glass", 20],
  [0, 0, 1, "minecraft:oak_planks", 5],
  [2, 1, 1, "minecraft:stone", 1],
];

/** Modern name at each cell, in the app's own flat order. */
function expectedGrid(): string[] {
  const grid = new Array<string>(WIDTH * HEIGHT * LENGTH).fill("minecraft:air");
  for (const [x, y, z, name] of BLOCKS) {
    grid[x * HEIGHT * LENGTH + y * LENGTH + z] = name;
  }
  return grid;
}

/** Reads a loaded structure back into that same flat order. */
function actualGrid(structure: {
  palette: readonly { namespacedName: string; properties: Record<string, string> }[];
  voxels: Int32Array;
}): string[] {
  return Array.from(structure.voxels, (index) => structure.palette[index]?.namespacedName ?? "<missing>");
}

/** Minecraft VarInt: 7 bits per byte, high bit = continuation. */
function writeVarint(out: number[], value: number): void {
  let remaining = value >>> 0;
  for (;;) {
    if ((remaining & ~0x7f) === 0) {
      out.push(remaining);
      return;
    }
    out.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
}

const toSignedByte = (byte: number): number => (byte << 24) >> 24;

/** YZX: the linear order every one of the three formats uses. */
function yzxIndex(x: number, y: number, z: number): number {
  return (y * LENGTH + z) * WIDTH + x;
}

async function writeNbtGz(filePath: string, root: unknown): Promise<string> {
  await writeFile(filePath, await gzip(writeUncompressed(root as never, "big")));
  return filePath;
}

/**
 * Sponge v3 as WorldEdit 7.3+ writes it: the payload one level down under a
 * `Schematic` compound, and the block arrays inside a `Blocks` sub-compound
 * where `BlockData` has been renamed `Data`.
 */
async function writeSpongeV3(filePath: string): Promise<string> {
  const palette = new Map<string, number>([["minecraft:air", 0]]);
  const indexFor = (block: string): number => {
    const existing = palette.get(block);
    if (existing !== undefined) return existing;
    const next = palette.size;
    palette.set(block, next);
    return next;
  };

  const byCell = new Map<number, string>();
  for (const [x, y, z, name] of BLOCKS) {
    byCell.set(yzxIndex(x, y, z), name);
  }

  const varints: number[] = [];
  for (let i = 0; i < WIDTH * HEIGHT * LENGTH; i += 1) {
    writeVarint(varints, indexFor(byCell.get(i) ?? "minecraft:air"));
  }

  const paletteCompound: Record<string, { type: "int"; value: number }> = {};
  for (const [block, index] of palette) {
    paletteCompound[block] = { type: "int", value: index };
  }

  return await writeNbtGz(filePath, {
    type: "compound",
    name: "",
    value: {
      Schematic: {
        type: "compound",
        value: {
          Version: { type: "int", value: 3 },
          DataVersion: { type: "int", value: dataVersionFor("JE_1_20_4") },
          Width: { type: "short", value: WIDTH },
          Height: { type: "short", value: HEIGHT },
          Length: { type: "short", value: LENGTH },
          Offset: { type: "intArray", value: [0, 0, 0] },
          Blocks: {
            type: "compound",
            value: {
              Palette: { type: "compound", value: paletteCompound },
              Data: { type: "byteArray", value: varints.map(toSignedByte) },
            },
          },
        },
      },
    },
  });
}

/**
 * MCEdit: parallel `Blocks` (numeric id) and `Data` (metadata nibble) byte
 * arrays, no palette at all -- the ids only become block names by way of the
 * vendored flattening table.
 */
async function writeMcEdit(filePath: string, withAddBlocks = false): Promise<string> {
  const total = WIDTH * HEIGHT * LENGTH;
  const blocks = new Array<number>(total).fill(0);
  const data = new Array<number>(total).fill(0);
  for (const [x, y, z, , legacyId] of BLOCKS) {
    blocks[yzxIndex(x, y, z)] = legacyId & 0xff;
  }

  const value: Record<string, unknown> = {
    Materials: { type: "string", value: "Alpha" },
    Width: { type: "short", value: WIDTH },
    Height: { type: "short", value: HEIGHT },
    Length: { type: "short", value: LENGTH },
    Blocks: { type: "byteArray", value: blocks.map(toSignedByte) },
    Data: { type: "byteArray", value: data.map(toSignedByte) },
  };

  if (withAddBlocks) {
    // All-zero high nibbles, which is the only case worth asserting: the
    // flattening table tops out at id 255, so a non-zero nibble only ever
    // names modded content it could not map anyway. What this does catch is a
    // decoder that reads the packed array at all when it should be a no-op --
    // an off-by-one in the nibble split would shift ids into nonsense here.
    value.AddBlocks = { type: "byteArray", value: new Array(Math.ceil(total / 2)).fill(0) };
  }

  return await writeNbtGz(filePath, { type: "compound", name: "Schematic", value });
}

console.log("=== BuilderGPT schematic container-format parity ===\n");

const workDir = await mkdtemp(path.join(tmpdir(), "bgpt-schem-"));

try {
  const expected = expectedGrid();

  // --- Sponge v2, via the app's own writer (the baseline) -------------------
  console.log("--- Sponge v2 (baseline: the app's own writer) ---");
  const writer = new SpongeSchematicWriter();
  for (const [x, y, z, name] of BLOCKS) {
    writer.setBlock([x, y, z], name);
  }
  const v2Path = await writer.save(workDir, "parity-v2", dataVersionFor("JE_1_20_4"));
  const v2 = await loadStructure(v2Path);
  equal("format detected", v2.format, "sponge2");
  equal("dimensions", [v2.bounds.maxX + 1, v2.bounds.maxY + 1, v2.bounds.maxZ + 1], [WIDTH, HEIGHT, LENGTH]);
  equal("voxel grid", actualGrid(v2), expected);

  // --- Sponge v3 ------------------------------------------------------------
  console.log("\n--- Sponge v3 (WorldEdit 7.3+ / FAWE) ---");
  const v3Path = await writeSpongeV3(path.join(workDir, "parity-v3.schem"));
  const v3 = await loadStructure(v3Path);
  equal("format detected", v3.format, "sponge3");
  equal("dimensions", [v3.bounds.maxX + 1, v3.bounds.maxY + 1, v3.bounds.maxZ + 1], [WIDTH, HEIGHT, LENGTH]);
  equal("voxel grid matches v2", actualGrid(v3), expected);

  // --- MCEdit ---------------------------------------------------------------
  console.log("\n--- MCEdit .schematic (numeric ids via the flattening table) ---");
  const mcPath = await writeMcEdit(path.join(workDir, "parity-mcedit.schematic"));
  const mc = await loadStructure(mcPath, { legacyBlocksPath: LEGACY_BLOCKS });
  equal("format detected", mc.format, "mcedit");
  equal("dimensions", [mc.bounds.maxX + 1, mc.bounds.maxY + 1, mc.bounds.maxZ + 1], [WIDTH, HEIGHT, LENGTH]);
  equal("voxel grid matches v2", actualGrid(mc), expected);
  equal("no unmapped legacy ids", mc.unmappedLegacyIds, []);

  const mcAddPath = await writeMcEdit(path.join(workDir, "parity-mcedit-add.schematic"), true);
  const mcAdd = await loadStructure(mcAddPath, { legacyBlocksPath: LEGACY_BLOCKS });
  equal("AddBlocks with zero high nibbles changes nothing", actualGrid(mcAdd), expected);

  // Without the table an MCEdit file must fail loudly. Decoding it to a grid of
  // air would be the exact silent-blank-render this whole suite exists to stop.
  check(
    "MCEdit without the flattening table fails explicitly",
    await (async () => {
      try {
        await loadStructure(mcPath);
        return false;
      } catch (err) {
        return err instanceof SchematicFormatError;
      }
    })(),
  );

  // --- unrecognised container ----------------------------------------------
  console.log("\n--- rejection ---");
  const junkPath = await writeNbtGz(path.join(workDir, "junk.schem"), {
    type: "compound",
    name: "",
    value: { Hello: { type: "string", value: "world" } },
  });
  check(
    "an NBT file that is not a schematic is named as such",
    await (async () => {
      try {
        await loadStructure(junkPath, { legacyBlocksPath: LEGACY_BLOCKS });
        return false;
      } catch (err) {
        return err instanceof SchematicFormatError && err.message.includes("Unrecognised schematic");
      }
    })(),
  );
} finally {
  await rm(workDir, { recursive: true, force: true });
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
