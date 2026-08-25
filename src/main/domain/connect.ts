/**
 * Rewriting the block states that depend on what is next to them.
 *
 * A fence has an arm on its north side because there is something to the north,
 * and `block_shapes.ts` draws it from `properties.north`. Nobody was setting
 * that: a fence placed by hand carried the vanilla default, `north=false` on
 * all four sides, which is a bare post. Same for a wall's `up`, a staircase's
 * `shape`, a rail's, and a chest's half of a double chest.
 *
 * `shared/block_connections.ts` holds the rules -- what connects to what -- and
 * knows nothing about documents. This file is the other half: which cells to
 * ask about, and how to ask cheaply enough to run on every edit.
 *
 * ## It runs in one place, and that is the point
 *
 * `runTransaction` calls it, so place, break, fill, replace, paste, move,
 * transform, every agent tool and every generated build script all get the same
 * answer. A rule enforced by discipline at nine call sites is a rule that is
 * wrong at one of them -- and it would be wrong at whichever one was added
 * next.
 *
 * Undo does not go through here, because undo replays recorded deltas rather
 * than running a body; and loading is not a transaction at all. Both are
 * correct: a file that arrives with its own connections keeps exactly those.
 *
 * ## What it costs
 *
 * The obvious implementation reads seven blocks per touched cell and asks each
 * one's *name* whether it is a fence. `occludesNeighbours` alone -- the "is
 * this something a fence attaches to" question -- calls `shapeFor`, which
 * normalises a name with a regex and walks three tables, six times per cell,
 * for a value that cannot differ between two cells holding the same palette
 * entry.
 *
 * So the question is asked of the **palette** instead, once. A document's
 * palette is tens of entries where the cells are millions, and the scan that
 * chooses which cells to visit is seven integer reads with no strings and no
 * allocation. On a 200x50x200 fill of fence -- two million cells every one of
 * which connects on all four sides, the worst case that exists -- that took
 * 17.5 s down to 7.7 s, and the remainder is the two million genuinely
 * different block states it then has to write.
 *
 * What matters more is that the cases anyone actually builds are free:
 *
 * | | | |
 * |---|---|---|
 * | a 100-block fence line | 100 cells | **3 ms** |
 * | one wall of a 64x64 fenced perimeter | 192 cells | **4 ms** |
 * | a 64x32x64 house of stone | 131,072 cells | 125 ms, none of it here |
 * | a 64x8x64 *solid slab of fence* | 32,768 cells | 145 ms |
 *
 * There is deliberately no size cap. A threshold would be a second answer to
 * the same question -- fills under N connect, fills over N do not -- which is
 * the "two doors, two answers" fault this pass exists to remove; and the only
 * shape that reaches seconds is a solid volume of fence, which the fill itself
 * already makes slow and which nobody wants.
 */

import {
  connectedState,
  isNeighbourDependent,
  type Face,
  type NeighbourBlock,
  type Neighbours,
} from "../../shared/block_connections.js";
import { occludesNeighbours } from "../pipeline/block_shapes.js";
import { paletteEntryIsAir, type PaletteEntry } from "../pipeline/types.js";
import { getBlock, getBlockEntity, type SchematicDocument } from "./document.js";
import type { TransactionScope } from "./history.js";

/** The six neighbours, as offsets. Order matches nothing and need not. */
/** Stands in for a palette slot that does not exist; every rule reads it as air. */
const AIR_ENTRY: PaletteEntry = { namespacedName: "minecraft:air", properties: {} };

const OFFSETS: ReadonlyArray<readonly [Face, number, number, number]> = [
  ["north", 0, 0, -1],
  ["south", 0, 0, 1],
  ["east", 1, 0, 0],
  ["west", -1, 0, 0],
  ["up", 0, 1, 0],
  ["down", 0, -1, 0],
];

function bareName(entry: PaletteEntry): string {
  return entry.namespacedName.replace(/^minecraft:/, "");
}

/**
 * Everything the pass needs to know about a block, indexed by palette index.
 *
 * Built once per transaction, and it is the difference between this being free
 * and this being unusable. The palette is tens of entries; the cells are
 * millions. Measured on a 200x50x200 fill of fence -- two million dependent
 * cells, the worst case that exists:
 *
 * | | |
 * |---|---|
 * | asking each of the seven lookups per cell afresh | **17,480 ms** |
 * | asking the palette once and the cells never | ~1,900 ms |
 *
 * The cost was never the neighbour arithmetic. It was `occludesNeighbours`,
 * which calls `shapeFor`, which normalises a name with a regex and walks three
 * tables -- six times per cell, for a value that cannot differ between two
 * cells holding the same palette entry. Same for the name and the properties
 * object.
 *
 * This is the same shape of mistake as the atlas being repacked per block, and
 * it is worth recognising: the *right answer*, computed per cell, where the
 * question was only ever per palette entry.
 */
interface PaletteFacts {
  /**
   * `null` for air, which every rule treats as "nothing there".
   *
   * **Grows during the pass, and must.** Writing a correction interns a new
   * palette entry, so a cell this pass has already fixed carries an index past
   * the end of the array it was built with -- and reading that as "no entry"
   * makes the corrected neighbour look like *air*. The visible symptom is a
   * connection that works in one direction only: placing a fence connected the
   * new block and did not reach back to the old one, because by the time the
   * old one was examined the new one had become invisible.
   */
  readonly blocks: Array<NeighbourBlock | null>;
  /**
   * 1 where this block's own state depends on its neighbours.
   *
   * Does **not** grow, and does not need to: it is only read while choosing
   * which cells to visit, which happens before anything is written.
   */
  readonly dependent: Uint8Array;
}

function factsOf(entry: PaletteEntry): NeighbourBlock | null {
  if (paletteEntryIsAir(entry)) {
    return null;
  }
  return {
    name: bareName(entry),
    properties: entry.properties,
    // What a fence or a wall attaches to is a full opaque cube, which is the
    // question `occludesNeighbours` already answers for the mesher.
    solid: occludesNeighbours(entry),
  };
}

function paletteFacts(doc: SchematicDocument): PaletteFacts {
  const blocks: Array<NeighbourBlock | null> = new Array(doc.palette.length);
  const dependent = new Uint8Array(doc.palette.length);
  for (let i = 0; i < doc.palette.length; i += 1) {
    const facts = factsOf(doc.palette[i]);
    blocks[i] = facts;
    if (facts !== null && isNeighbourDependent(facts.name)) {
      dependent[i] = 1;
    }
  }
  return { blocks, dependent };
}

/**
 * Applies the neighbour rules around every cell a transaction touched.
 *
 * `indices` are flat voxel indices in the document's **current** shape. A
 * resize flushes the recorder, so the live set after a body has run is always
 * in the frame in force now — mixing the two would index the old dimensions and
 * rewrite an unrelated block.
 *
 * Writes through the same `tx`, so a correction lands in the same undo step as
 * the edit that caused it. Placing a fence next to a fence is one Ctrl+Z, not
 * two.
 */
export function deriveConnections(
  doc: SchematicDocument,
  tx: TransactionScope,
  indices: Iterable<number>,
): void {
  const { blocks, dependent } = paletteFacts(doc);
  const { width, height, length } = doc;
  const plane = height * length;
  const voxels = doc.voxels;

  /*
   * A palette entry interned *during* the pass sits past the end of these
   * arrays. Treated as "not dependent" rather than indexed blindly -- and it is
   * the right answer as well as the safe one, because a block this pass wrote
   * is a correction, not an edit to correct around. One sweep, not a fixed
   * point.
   */
  const isDependent = (at: number): boolean => {
    const index = voxels[at];
    return index < dependent.length && dependent[index] === 1;
  };
  /** Memoised per palette index, filling in entries the pass itself interned. */
  const factsAt = (index: number): NeighbourBlock | null => {
    if (index >= blocks.length || blocks[index] === undefined) {
      blocks[index] = factsOf(doc.palette[index] ?? AIR_ENTRY);
    }
    return blocks[index] ?? null;
  };
  const blockAt = (x: number, y: number, z: number): NeighbourBlock | null => {
    if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= length) {
      // Outside the schematic reads as air, which is how the mesher treats it.
      return null;
    }
    return factsAt(voxels[x * plane + y * length + z]);
  };

  // Collected first, applied second. Writing while scanning would grow the
  // recorder's own set under the iterator, and a correction would then be
  // treated as an edit to correct around.
  const work = new Set<number>();
  for (const index of indices) {
    const x = Math.floor(index / plane);
    const y = Math.floor((index - x * plane) / length);
    const z = index - x * plane - y * length;

    if (isDependent(index)) {
      work.add(index);
    }
    for (const [, dx, dy, dz] of OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= width || ny >= height || nz >= length) {
        continue;
      }
      const at = nx * plane + ny * length + nz;
      if (isDependent(at)) {
        work.add(at);
      }
    }
  }

  // Reused across cells: `connectedState` reads it and keeps no reference, and
  // one object per work cell is a million allocations on a large fill.
  const around: Partial<Record<Face, NeighbourBlock | null>> = {};

  for (const index of work) {
    const x = Math.floor(index / plane);
    const y = Math.floor((index - x * plane) / length);
    const z = index - x * plane - y * length;

    const self = factsAt(voxels[index]);
    if (self === null) {
      continue;
    }
    for (const [face, dx, dy, dz] of OFFSETS) {
      around[face] = blockAt(x + dx, y + dy, z + dz);
    }
    const derived = connectedState(self, around);

    let changed = false;
    for (const property in derived) {
      if (self.properties[property] !== derived[property]) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      continue;
    }
    /*
     * The block entity has to be put back by hand.
     *
     * `setBlock` treats any write as *displacing* what was there and drops the
     * block entity with it, which is right when a chest becomes stone and
     * catastrophic here: this only ever changes a property of the block already
     * in the cell, and the family whose connection matters most -- chests -- is
     * the one whose whole content lives in that record. Deriving `type=left` on
     * a double chest emptied it.
     *
     * Restoring rather than teaching `setBlock` to keep the entity when the id
     * is unchanged: that is a wider rule with a wider blast radius, and the
     * narrow one is what this pass can defend. `tests/session.ts` moves and
     * pastes a chest with contents, which is what caught it.
     */
    const record = getBlockEntity(doc, x, y, z);
    tx.setBlock(x, y, z, {
      namespacedName: getBlock(doc, x, y, z).namespacedName,
      properties: { ...self.properties, ...derived },
    });
    if (record !== null) {
      tx.setBlockEntity(x, y, z, record);
    }
  }
}
