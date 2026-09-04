/**
 * Copying a region out, and pasting it back somewhere else.
 *
 * The clipboard holds a *detached* snapshot: palette entries by value, not
 * palette indices. Indices only mean something relative to the document they
 * came from, and the whole point of a clipboard is to survive leaving that
 * document — copy from a castle, open a village, paste the tower. Storing
 * indices would paste the right numbers and the wrong blocks.
 *
 * ## Air is not stored, and not pasted
 *
 * A copied region is a box, and most of a box is air. Storing that air would
 * make every clipboard cost what its selection *spans* rather than what is in
 * it; pasting it would punch a rectangular hole in whatever the paste lands on,
 * so a house copied off flat ground would arrive having excavated a pit around
 * itself. Only the cells holding something are kept.
 *
 * `includeAir` still means what it says, and is reached the other way round: it
 * clears the destination box before writing. Same result for the case that
 * wants it — stamping a hollow room into solid rock — without storing a box of
 * nothing to get there.
 *
 * ## Out of bounds is clipped here, and decided one layer up
 *
 * `pasteClipboard` writes the part that fits and drops the rest, which is what
 * lets `moveRegion` and friends compose it without bounds arithmetic of their
 * own to get wrong. It is not what a user meets: `pasteSelection` grows the
 * document to hold the whole thing, or refuses by name with automatic resizing
 * off, so the clipping below is the floor rather than the policy.
 */

import {
  getBlock,
  normalizeRegion,
  type Region,
  type SchematicDocument,
} from "./document.js";
import type { TransactionScope } from "./history.js";
import type { BlockEntityRecord, PaletteEntry } from "../pipeline/types.js";
import { paletteEntryIsAir } from "../pipeline/types.js";

/** One cell of a copied region, offset from the region's own corner. */
interface ClipboardCell {
  dx: number;
  dy: number;
  dz: number;
  entry: PaletteEntry;
  entity: BlockEntityRecord | null;
}

export interface Clipboard {
  width: number;
  height: number;
  length: number;
  /** Non-air cells only; air is what a paste leaves alone. */
  cells: ClipboardCell[];
  /** How many blocks were taken, for the UI to report. */
  blocks: number;
}

export interface PasteOptions {
  /**
   * Write the copied air too, erasing whatever it lands on. Off by default —
   * see the note at the top.
   */
  includeAir?: boolean;
}

/** Snapshots a region, by value. */
export function copyRegion(doc: SchematicDocument, region: Region): Clipboard {
  const cells: ClipboardCell[] = [];
  for (let x = region.minX; x <= region.maxX; x += 1) {
    for (let y = region.minY; y <= region.maxY; y += 1) {
      for (let z = region.minZ; z <= region.maxZ; z += 1) {
        const entry = getBlock(doc, x, y, z);
        const entity = doc.blockEntities.get(`${x},${y},${z}`) ?? null;
        if (paletteEntryIsAir(entry) && entity === null) {
          // Air with nothing attached carries no information a paste could
          // use, and keeping it would make every clipboard the size of its
          // bounding box rather than of the thing in it.
          continue;
        }
        cells.push({
          dx: x - region.minX,
          dy: y - region.minY,
          dz: z - region.minZ,
          // Copied by value rather than by reference. Nothing in the app
          // mutates a palette entry in place today — an edit interns a new one
          // — so this is not fixing a live bug; it is severing the last thread
          // between a clipboard and a document it is expected to outlive, so
          // that holding one cannot keep the other's palette alive or expose it
          // to a future edit that does mutate.
          entry: { namespacedName: entry.namespacedName, properties: { ...entry.properties } },
          entity: entity === null ? null : { ...entity, nbt: structuredClone(entity.nbt) },
        });
      }
    }
  }

  return {
    width: region.maxX - region.minX + 1,
    height: region.maxY - region.minY + 1,
    length: region.maxZ - region.minZ + 1,
    cells,
    blocks: cells.filter((cell) => !paletteEntryIsAir(cell.entry)).length,
  };
}

/**
 * Writes a clipboard with its corner at `at`, and reports what landed.
 *
 * Takes a `TransactionScope` rather than opening one, for the same reason
 * `transform.ts` does: the UI wants one undo step per paste, and the agent
 * wants its whole request to be one — so the caller decides.
 */
export function pasteClipboard(
  doc: SchematicDocument,
  tx: TransactionScope,
  clipboard: Clipboard,
  at: { x: number; y: number; z: number },
  options: PasteOptions = {},
): number {
  let changed = 0;

  // `includeAir` is served by clearing the destination box first, rather than
  // by having stored the air. The copy keeps only the cells that hold
  // something, so a mostly-empty selection costs what is in it instead of what
  // it spans — and clearing first reaches the same result for the one case that
  // wants it, stamping a hollow room into solid rock.
  if (options.includeAir) {
    changed += tx.fill(
      normalizeRegion(doc, {
        minX: at.x,
        minY: at.y,
        minZ: at.z,
        maxX: at.x + clipboard.width - 1,
        maxY: at.y + clipboard.height - 1,
        maxZ: at.z + clipboard.length - 1,
      }),
      { namespacedName: "minecraft:air", properties: {} },
    );
  }

  for (const cell of clipboard.cells) {
    const x = at.x + cell.dx;
    const y = at.y + cell.dy;
    const z = at.z + cell.dz;
    // `setBlock` refuses out-of-bounds writes and reports it, which is exactly
    // the clipping this wants — no bounds arithmetic of its own to get wrong.
    if (tx.setBlock(x, y, z, cell.entry)) {
      changed += 1;
    }
    if (cell.entity !== null && x >= 0 && y >= 0 && z >= 0 && x < doc.width && y < doc.height && z < doc.length) {
      tx.setBlockEntity(x, y, z, { ...cell.entity, pos: [x, y, z] });
    }
  }
  return changed;
}
