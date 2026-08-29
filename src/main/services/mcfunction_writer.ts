/**
 * Writing a document out as `.mcfunction`.
 *
 * Apart from `writers.ts` because this one does not produce a file: it produces
 * a *set* of them, and `writeDocument`'s contract is one buffer. The reason for
 * the set is the reason for most of this module.
 *
 * ## Runs of one block become `fill`
 *
 * One `setblock` per cell is what the obvious writer does and it is unusable: a
 * 64x46x88 schematic is a quarter of a million commands, and the game stops
 * reading a function after 65,536 of them **without an error**. Growing boxes
 * takes an ordinary build to a few thousand.
 *
 * The growth is greedy and in one fixed order -- a run along x, then extended
 * along z while the whole row still matches, then along y while the whole plate
 * does. Deterministic on purpose: the output is checked by reading it back, and
 * a decomposition that depended on the order cells happened to be visited in
 * could not be checked that way.
 *
 * Three constraints, each of which is a way to fail in silence:
 *
 * - **A box never exceeds `MAX_FILL_VOLUME`.** Past it the game changes no
 *   blocks at all and says nothing useful, so the file looks fine and the build
 *   comes out with holes.
 * - **A cell with a block entity is never inside a box.** `fill` carries one
 *   block argument for the whole region, so a chest merged into a box would
 *   come out empty -- or, worse, would fill the box with copies of its
 *   contents.
 * - **The parts are split at `MAX_COMMANDS_PER_FUNCTION`**, so each one is
 *   runnable on its own. Splitting does *not* raise the ceiling: a dispatcher
 *   calling twenty parts still runs every one of their commands against one
 *   budget. The dispatcher says so in a comment rather than letting the game
 *   trim the build.
 *
 * ## Air is written
 *
 * A schematic is a volume, not a scattering of blocks, and a file that placed
 * only the solid cells would not reproduce it -- the size would be whatever the
 * outermost block happened to be, and running it over existing terrain would
 * leave that terrain inside the build. `fill` is what makes it affordable: the
 * empty half of an ordinary schematic is a handful of large boxes.
 *
 * ## What it cannot carry
 *
 * Entities. `summon` is a different command with a different grammar and no way
 * back, so they are reported through `dropped` rather than half-written. The
 * *anchor* survives, and that is the pleasant surprise of this format: `~ ~ ~`
 * is where the function is run from, which is exactly what the anchor means, so
 * the coordinates carry it for free. The world origin does not.
 */

import { mkdir, writeFile } from "fs/promises";
import path from "path";

import {
  documentSize,
  posKey,
  type SchematicDocument,
} from "../domain/document.js";
import { stringifySnbt } from "../domain/snbt.js";
import type { PaletteEntry } from "../pipeline/types.js";
import { MAX_COMMANDS_PER_FUNCTION, MAX_FILL_VOLUME } from "../../shared/command_syntax.js";

export interface McfunctionFile {
  /** File name only; the caller decides the directory. */
  readonly name: string;
  readonly text: string;
}

export interface McfunctionOutput {
  readonly files: readonly McfunctionFile[];
  /** How many commands in total, which is what the game's limit counts. */
  readonly commands: number;
  /** What the format cannot carry at all, by name. */
  readonly dropped: readonly string[];
}

export interface McfunctionOptions {
  /** The base name, without extension. Parts are `<stem>_0`, `<stem>_1`, … */
  readonly stem: string;
  /**
   * The datapack namespace the dispatcher's `function` lines name.
   *
   * Defaults to the stem, which is the guessable answer and the one the
   * dispatcher's header tells the reader to change if their pack is called
   * something else. There is nothing in a document that knows this.
   */
  readonly namespace?: string;
}

/** `~`, `~4`, `~-2` — the game's spelling, and the shortest of it. */
function relative(value: number): string {
  return value === 0 ? "~" : `~${value}`;
}

/** `minecraft:oak_stairs[facing=north]`, properties in a fixed order. */
function blockText(entry: PaletteEntry, nbt: string | null): string {
  const keys = Object.keys(entry.properties).sort();
  const states =
    keys.length === 0 ? "" : `[${keys.map((k) => `${k}=${entry.properties[k]}`).join(",")}]`;
  return `${entry.namespacedName}${states}${nbt ?? ""}`;
}

/** A box that has been claimed, in document coordinates. */
interface Grown {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  l: number;
}

/**
 * Turns the document into commands.
 *
 * Exported without the file-splitting around it so the decomposition can be
 * checked on its own: the properties worth stating -- no box past the volume
 * cap, no block entity inside one, every cell covered exactly once -- are
 * properties of this list and not of how it is chopped up.
 */
export function mcfunctionCommands(doc: SchematicDocument): string[] {
  const [width, height, length] = documentSize(doc);
  const anchor = doc.offset ?? [0, 0, 0];
  const at = (x: number, y: number, z: number): number => x * height * length + y * length + z;

  const taken = new Uint8Array(width * height * length);
  /*
   * A cell whose block entity means it cannot join a box. Looked up once into a
   * flat array rather than asked per candidate cell: growing a box asks about
   * every cell it considers, and `blockEntities` is a Map keyed by a string.
   */
  const pinned = new Uint8Array(width * height * length);
  for (const record of doc.blockEntities.values()) {
    const [x, y, z] = record.pos;
    if (x >= 0 && x < width && y >= 0 && y < height && z >= 0 && z < length) {
      pinned[at(x, y, z)] = 1;
    }
  }

  const matches = (index: number, value: number): boolean =>
    taken[index] === 0 && pinned[index] === 0 && doc.voxels[index] === value;

  const out: string[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let z = 0; z < length; z += 1) {
      for (let x = 0; x < width; x += 1) {
        const start = at(x, y, z);
        if (taken[start] === 1) continue;
        const value = doc.voxels[start];
        const entry = doc.palette[value] ?? { namespacedName: "minecraft:air", properties: {} };

        if (pinned[start] === 1) {
          taken[start] = 1;
          const record = doc.blockEntities.get(posKey(x, y, z));
          const payload =
            record === undefined || Object.keys(record.nbt).length === 0
              ? null
              : stringifySnbt({ type: "compound", value: record.nbt }, true);
          out.push(
            `setblock ${relative(x + anchor[0])} ${relative(y + anchor[1])} ` +
              `${relative(z + anchor[2])} ${blockText(entry, payload)}`,
          );
          continue;
        }

        const box: Grown = { x, y, z, w: 1, h: 1, l: 1 };
        // Along x first, which is the innermost axis of the walk, so the run is
        // already contiguous in the loop above.
        while (
          box.x + box.w < width &&
          box.w + 1 <= MAX_FILL_VOLUME &&
          matches(at(box.x + box.w, y, z), value)
        ) {
          box.w += 1;
        }
        // Then z, one row at a time, and only if the whole row matches.
        for (;;) {
          const nz = box.z + box.l;
          if (nz >= length) break;
          if (box.w * (box.l + 1) * box.h > MAX_FILL_VOLUME) break;
          let ok = true;
          for (let i = 0; i < box.w && ok; i += 1) {
            if (!matches(at(box.x + i, y, nz), value)) ok = false;
          }
          if (!ok) break;
          box.l += 1;
        }
        // Then y, one plate at a time.
        for (;;) {
          const ny = box.y + box.h;
          if (ny >= height) break;
          if (box.w * box.l * (box.h + 1) > MAX_FILL_VOLUME) break;
          let ok = true;
          for (let dz = 0; dz < box.l && ok; dz += 1) {
            for (let dx = 0; dx < box.w; dx += 1) {
              if (!matches(at(box.x + dx, ny, box.z + dz), value)) {
                ok = false;
                break;
              }
            }
          }
          if (!ok) break;
          box.h += 1;
        }

        for (let dy = 0; dy < box.h; dy += 1) {
          for (let dz = 0; dz < box.l; dz += 1) {
            for (let dx = 0; dx < box.w; dx += 1) {
              taken[at(box.x + dx, box.y + dy, box.z + dz)] = 1;
            }
          }
        }

        const text = blockText(entry, null);
        if (box.w === 1 && box.h === 1 && box.l === 1) {
          out.push(
            `setblock ${relative(x + anchor[0])} ${relative(y + anchor[1])} ` +
              `${relative(z + anchor[2])} ${text}`,
          );
        } else {
          out.push(
            `fill ${relative(box.x + anchor[0])} ${relative(box.y + anchor[1])} ` +
              `${relative(box.z + anchor[2])} ${relative(box.x + box.w - 1 + anchor[0])} ` +
              `${relative(box.y + box.h - 1 + anchor[1])} ` +
              `${relative(box.z + box.l - 1 + anchor[2])} ${text}`,
          );
        }
      }
    }
  }

  return out;
}

/** The files a document becomes, dispatcher included when there is more than one. */
export function buildMcfunction(
  doc: SchematicDocument,
  options: McfunctionOptions,
): McfunctionOutput {
  const commands = mcfunctionCommands(doc);
  const stem = options.stem;
  const namespace = options.namespace ?? stem;

  const dropped: string[] = [];
  if (doc.entities.length > 0) {
    dropped.push(
      `${doc.entities.length} entit${doc.entities.length === 1 ? "y" : "ies"}`,
    );
  }
  if (doc.worldOrigin !== null) dropped.push("the world origin");

  const [width, height, length] = documentSize(doc);
  const banner =
    `# ${width}x${height}x${length}, ${commands.length} command` +
    `${commands.length === 1 ? "" : "s"}, written by Schematic AI Studio.`;

  if (commands.length <= MAX_COMMANDS_PER_FUNCTION) {
    return {
      files: [{ name: `${stem}.mcfunction`, text: `${banner}\n${commands.join("\n")}\n` }],
      commands: commands.length,
      dropped,
    };
  }

  const parts: McfunctionFile[] = [];
  for (let i = 0; i * MAX_COMMANDS_PER_FUNCTION < commands.length; i += 1) {
    const slice = commands.slice(
      i * MAX_COMMANDS_PER_FUNCTION,
      (i + 1) * MAX_COMMANDS_PER_FUNCTION,
    );
    parts.push({
      name: `${stem}_${i}.mcfunction`,
      text: `# Part ${i + 1} of the ${width}x${height}x${length} build.\n${slice.join("\n")}\n`,
    });
  }

  /*
   * The warning is the point of the dispatcher, more than the calls are. A
   * function's command budget covers everything it *runs*, nested calls
   * included, so this file cannot get past the limit -- it can only make each
   * part reachable on its own. Saying that here is the difference between a
   * user who runs the parts by hand and one who wonders why the roof is
   * missing.
   */
  const header = [
    banner,
    `# Split into ${parts.length} parts because a function stops after`,
    `# ${MAX_COMMANDS_PER_FUNCTION.toLocaleString()} commands, silently.`,
    `# That limit covers nested calls too, so running this dispatcher does not`,
    `# lift it: run the parts one at a time if the build comes out incomplete.`,
    `# The namespace below assumes the pack is called "${namespace}".`,
  ].join("\n");

  return {
    files: [
      {
        name: `${stem}.mcfunction`,
        text: `${header}\n${parts
          .map((part) => `function ${namespace}:${part.name.replace(/\.mcfunction$/, "")}`)
          .join("\n")}\n`,
      },
      ...parts,
    ],
    commands: commands.length,
    dropped,
  };
}

/** Writes the set beside `filePath`, whose own name decides the stem. */
export async function saveMcfunction(
  doc: SchematicDocument,
  filePath: string,
  options: { namespace?: string } = {},
): Promise<McfunctionOutput> {
  const directory = path.dirname(filePath);
  const stem = path.basename(filePath).replace(/\.mcfunction$/i, "");
  const built = buildMcfunction(doc, { stem, ...options });
  await mkdir(directory, { recursive: true });
  for (const file of built.files) {
    await writeFile(path.join(directory, file.name), file.text, "utf8");
  }
  return built;
}
