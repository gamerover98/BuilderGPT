/**
 * Sponge Schematic v2 writer -- the concrete implementation behind
 * `core.ts`'s `SchematicWriter` / `SchematicWriterFactory` DI seam.
 *
 * RULEBOOK.md §1 "no-equivalent-library pattern": `mcschematic` has no npm
 * equivalent, so `core.ts` deliberately takes the writer as a parameter and
 * `textToSchem` never names a backend. This module is that backend. It is the
 * symmetric counterpart of `pipeline/loader.ts` (the already-parity-verified
 * read path) and is validated by round-tripping through it -- see
 * ARCHITECTURE.md §6 item 3.
 *
 * Format reference: the same layout `loader.ts` parses --
 *   Version(int)=2, DataVersion(int), Width/Height/Length(short),
 *   Offset(intArray), PaletteMax(int), Palette(compound name->index),
 *   BlockData(byteArray of varint-encoded palette indices in YZX order).
 * The whole compound is gzipped, which is what `prismarine-nbt`'s `parse()`
 * auto-detects on the way back in.
 */

import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { gzip as gzipCb } from "zlib";

import { writeUncompressed } from "prismarine-nbt";

import type { SchematicWriter, SchematicWriterFactory } from "../core.js";

const gzip = promisify(gzipCb);

const AIR = "minecraft:air";

export class SpongeSchematicWriter implements SchematicWriter {
  /** Sparse block map keyed by `"x,y,z"`, mirroring `core.ts`'s own `posKey`. */
  private readonly blocks = new Map<string, string>();

  setBlock(pos: readonly [number, number, number], blockData: string): void {
    const [x, y, z] = pos;
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
      throw new Error(`setBlock requires integer coordinates, got (${x}, ${y}, ${z})`);
    }
    this.blocks.set(`${x},${y},${z}`, blockData);
  }

  get blockCount(): number {
    return this.blocks.size;
  }

  /**
   * Placements as `core.ts`'s `BlockPlacement` tuples, for tests and for the
   * round-trip check. Order is insertion order and carries no meaning.
   */
  placements(): Array<readonly [number, number, number, string]> {
    const out: Array<readonly [number, number, number, string]> = [];
    for (const [key, block] of this.blocks) {
      const [x, y, z] = key.split(",").map(Number) as [number, number, number];
      out.push([x, y, z, block]);
    }
    return out;
  }

  /**
   * Builds the gzipped NBT bytes. `dataVersion` comes from
   * `services/versions.ts`'s compile-time table (RULEBOOK.md DEV-014).
   */
  async toBytes(dataVersion: number): Promise<Buffer> {
    const nbtValue = this.buildCompound(dataVersion);
    // `writeUncompressed` is the "no gzip wrapper" call -- we apply gzip
    // ourselves below, since that is what the Sponge convention (and
    // `loader.ts`'s `parse()`) expects on disk.
    const raw = writeUncompressed(nbtValue as never, "big");
    return await gzip(raw);
  }

  /** `MCSchematic.save(outputFolderPath, schemName, version)` equivalent. */
  async save(outputDir: string, name: string, dataVersion: number): Promise<string> {
    await mkdir(outputDir, { recursive: true });
    const filePath = path.join(outputDir, `${name}.schem`);
    await writeFile(filePath, await this.toBytes(dataVersion));
    return filePath;
  }

  // -------------------------------------------------------------------------

  private bounds(): { minX: number; minY: number; minZ: number; width: number; height: number; length: number } {
    if (this.blocks.size === 0) {
      // An empty schematic is still a valid 1x1x1 of air -- `loader.ts` would
      // reject Width=0 downstream in the mesher, and mcschematic likewise
      // never writes a zero-volume schematic.
      return { minX: 0, minY: 0, minZ: 0, width: 1, height: 1, length: 1 };
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const key of this.blocks.keys()) {
      const [x, y, z] = key.split(",").map(Number) as [number, number, number];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    return {
      minX,
      minY,
      minZ,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      length: maxZ - minZ + 1,
    };
  }

  private buildCompound(dataVersion: number): unknown {
    const { minX, minY, minZ, width, height, length } = this.bounds();

    // Palette index 0 is always air, so unset voxels need no explicit write --
    // matching what `loader.ts` assumes when it pre-fills its palette list
    // with `minecraft:air`.
    const palette = new Map<string, number>([[AIR, 0]]);
    const indexFor = (block: string): number => {
      const existing = palette.get(block);
      if (existing !== undefined) {
        return existing;
      }
      const next = palette.size;
      palette.set(block, next);
      return next;
    };

    // YZX order: index = (y * length + z) * width + x, the order `loader.ts`
    // decodes with (loader.ts:325-330).
    const varints: number[] = [];
    for (let y = 0; y < height; y += 1) {
      for (let z = 0; z < length; z += 1) {
        for (let x = 0; x < width; x += 1) {
          const block = this.blocks.get(`${x + minX},${y + minY},${z + minZ}`) ?? AIR;
          writeVarint(varints, indexFor(block));
        }
      }
    }

    const paletteCompound: Record<string, { type: "int"; value: number }> = {};
    for (const [block, index] of palette) {
      paletteCompound[block] = { type: "int", value: index };
    }

    return {
      type: "compound",
      name: "Schematic",
      value: {
        Version: { type: "int", value: 2 },
        DataVersion: { type: "int", value: dataVersion },
        Width: { type: "short", value: width },
        Height: { type: "short", value: height },
        Length: { type: "short", value: length },
        Offset: { type: "intArray", value: [minX, minY, minZ] },
        PaletteMax: { type: "int", value: palette.size },
        Palette: { type: "compound", value: paletteCompound },
        BlockData: { type: "byteArray", value: varints.map(toSignedByte) },
        Metadata: {
          type: "compound",
          value: {
            Name: { type: "string", value: "BuilderGPT" },
          },
        },
      },
    };
  }
}

export class SpongeSchematicWriterFactory implements SchematicWriterFactory {
  create(): SchematicWriter {
    return new SpongeSchematicWriter();
  }
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

/** NBT byteArray elements are signed int8; 0..255 -> -128..127. */
function toSignedByte(byte: number): number {
  return (byte << 24) >> 24;
}
