/**
 * `domain/history.ts` — transactions, undo and redo.
 *
 * The property that matters more than any single assertion: **N edits followed
 * by N undos must restore the starting grid, voxel for voxel.** Everything else
 * here supports that one, because a history that is subtly lossy looks fine
 * until someone relies on it.
 *
 * The other thing being defended is the transaction boundary. One agent request
 * that rewrites five hundred blocks has to be one CTRL+Z, not five hundred, and
 * a request that fails halfway has to leave nothing behind.
 */

import {
  countBlocks,
  createDocument,
  getBlock,
  getBlockEntity,
  setBlockEntity,
  type SchematicDocument,
} from "../src/main/domain/document.js";
import {
  canRedo,
  canUndo,
  createHistory,
  isDirty,
  markHistorySaved,
  nextUndoLabel,
  redo,
  runTransaction,
  undo,
} from "../src/main/domain/history.js";
import type { PaletteEntry } from "../src/main/pipeline/types.js";

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
const COBBLE = block("minecraft:cobblestone");
const GLASS = block("minecraft:glass");

/** The whole grid as a comparable string, for the round-trip property. */
function snapshot(doc: SchematicDocument): string {
  const cells: string[] = [];
  for (let x = 0; x < doc.width; x += 1) {
    for (let y = 0; y < doc.height; y += 1) {
      for (let z = 0; z < doc.length; z += 1) {
        cells.push(getBlock(doc, x, y, z).namespacedName);
      }
    }
  }
  return `${doc.width}x${doc.height}x${doc.length}|${cells.join(",")}`;
}

console.log("=== Schematic AI Studio edit history ===\n");

// --- one transaction is one step --------------------------------------------
console.log("--- transaction grouping ---");
{
  const doc = createDocument({ width: 8, height: 8, length: 8 });
  const history = createHistory();
  const before = snapshot(doc);

  const written = runTransaction(doc, history, "Fill the floor", (tx) =>
    tx.fill({ minX: 0, minY: 0, minZ: 0, maxX: 7, maxY: 0, maxZ: 7 }, STONE),
  );
  equal("the fill wrote 64 blocks", written, 64);
  equal("...as one entry on the stack", history.undoStack.length, 1);
  equal("the entry is labelled", nextUndoLabel(history), "Fill the floor");

  undo(doc, history);
  equal("one undo reverses all 64", countBlocks(doc), 0);
  equal("...restoring the grid exactly", snapshot(doc), before);
  check("...and moves the step to the redo stack", canRedo(history));

  redo(doc, history);
  equal("redo puts all 64 back", countBlocks(doc), 64);
  check("nothing is left to redo", !canRedo(history));
}

// --- the round-trip property ------------------------------------------------
console.log("\n--- N edits, N undos ---");
{
  const doc = createDocument({ width: 6, height: 6, length: 6 });
  const history = createHistory();

  // A deliberately awkward starting state: overlapping writes, a block entity,
  // and cells touched more than once, so coalescing has something to get wrong.
  runTransaction(doc, history, "seed", (tx) => {
    tx.fill({ minX: 0, minY: 0, minZ: 0, maxX: 5, maxY: 0, maxZ: 5 }, COBBLE);
    tx.setBlock(2, 0, 2, PLANKS);
    tx.setBlockEntity(2, 0, 2, { id: "minecraft:barrel", pos: [2, 0, 2], nbt: {} });
  });
  const start = snapshot(doc);
  const startDepth = history.undoStack.length;

  const edits: Array<[string, (tx: import("../src/main/domain/history.js").TransactionScope) => void]> = [
    ["walls", (tx) => tx.fill({ minX: 0, minY: 1, minZ: 0, maxX: 5, maxY: 3, maxZ: 0 }, PLANKS)],
    ["swap", (tx) => tx.replace({ minX: 0, minY: 0, minZ: 0, maxX: 5, maxY: 5, maxZ: 5 }, COBBLE, STONE)],
    ["window", (tx) => tx.fill({ minX: 2, minY: 2, minZ: 0, maxX: 3, maxY: 2, maxZ: 0 }, GLASS)],
    ["overwrite the same cell repeatedly", (tx) => {
      tx.setBlock(1, 1, 1, STONE);
      tx.setBlock(1, 1, 1, PLANKS);
      tx.setBlock(1, 1, 1, GLASS);
    }],
    ["clear the barrel's block", (tx) => tx.setBlock(2, 0, 2, STONE)],
    ["grow", (tx) => tx.resize({ width: 6, height: 10, length: 6 })],
    ["build on the new space", (tx) => tx.fill({ minX: 0, minY: 8, minZ: 0, maxX: 5, maxY: 8, maxZ: 5 }, PLANKS)],
  ];

  for (const [label, body] of edits) {
    runTransaction(doc, history, label, body);
  }
  equal("every edit landed on the stack", history.undoStack.length, startDepth + edits.length);
  check("the document actually changed", snapshot(doc) !== start);

  for (let i = 0; i < edits.length; i += 1) {
    undo(doc, history);
  }
  equal(
    "undoing all of them restores the grid voxel for voxel",
    snapshot(doc),
    start,
  );
  equal("...including the dimensions", [doc.width, doc.height, doc.length], [6, 6, 6]);
  equal("...and the block entity", getBlockEntity(doc, 2, 0, 2)?.id, "minecraft:barrel");

  // And forwards again, to the same place.
  const end = (() => {
    for (let i = 0; i < edits.length; i += 1) {
      redo(doc, history);
    }
    return snapshot(doc);
  })();
  for (let i = 0; i < edits.length; i += 1) {
    undo(doc, history);
  }
  for (let i = 0; i < edits.length; i += 1) {
    redo(doc, history);
  }
  equal("redo is stable across a second round trip", snapshot(doc), end);
}

// --- resize, the awkward one -------------------------------------------------
//
// A voxel index only means something relative to the dimensions in force when
// it was recorded, and a shrink genuinely destroys blocks. Both have to survive
// an undo.
console.log("\n--- resize ---");
{
  const doc = createDocument({ width: 4, height: 4, length: 4 });
  const history = createHistory();
  runTransaction(doc, history, "seed", (tx) => {
    tx.fill({ minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 3, maxZ: 3 }, STONE);
    tx.setBlockEntity(3, 3, 3, { id: "minecraft:chest", pos: [3, 3, 3], nbt: {} });
  });
  const before = snapshot(doc);

  runTransaction(doc, history, "shrink", (tx) => tx.resize({ width: 2, height: 2, length: 2 }));
  equal("the shrink dropped blocks", countBlocks(doc), 8);
  check("...including the chest", getBlockEntity(doc, 3, 3, 3) === null);

  undo(doc, history);
  equal("undoing a shrink brings the blocks back", countBlocks(doc), 64);
  equal("...and the grid matches exactly", snapshot(doc), before);
  equal("...and the chest is where it was", getBlockEntity(doc, 3, 3, 3)?.id, "minecraft:chest");

  // A resize mixed with block writes in one transaction: the deltas either side
  // of it are in different coordinate frames and must not be merged.
  const mixed = snapshot(doc);
  runTransaction(doc, history, "mixed", (tx) => {
    tx.setBlock(0, 0, 0, PLANKS);
    tx.resize({ width: 4, height: 8, length: 4 });
    tx.setBlock(0, 7, 0, GLASS);
  });
  equal("the write before the resize applied", getBlock(doc, 0, 0, 0).namespacedName, "minecraft:oak_planks");
  equal("the write after it applied too", getBlock(doc, 0, 7, 0).namespacedName, "minecraft:glass");
  undo(doc, history);
  equal("undoing across a resize restores everything", snapshot(doc), mixed);
}

// --- atomicity ---------------------------------------------------------------
//
// "A complex AI request must complete entirely or be rolled back."
console.log("\n--- a failed transaction leaves nothing behind ---");
{
  const doc = createDocument({ width: 4, height: 4, length: 4 });
  const history = createHistory();
  runTransaction(doc, history, "seed", (tx) => tx.fill({ minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3 }, STONE));
  const before = snapshot(doc);
  const depth = history.undoStack.length;

  let thrown: unknown = null;
  try {
    runTransaction(doc, history, "half an edit", (tx) => {
      tx.fill({ minX: 0, minY: 1, minZ: 0, maxX: 3, maxY: 1, maxZ: 3 }, PLANKS);
      tx.resize({ width: 4, height: 8, length: 4 });
      tx.setBlock(0, 5, 0, GLASS);
      throw new Error("the model changed its mind");
    });
  } catch (err) {
    thrown = err;
  }
  check("the error propagates", thrown instanceof Error);
  equal("the document is exactly as it was", snapshot(doc), before);
  equal("...including its dimensions", [doc.width, doc.height, doc.length], [4, 4, 4]);
  equal("nothing was pushed onto the stack", history.undoStack.length, depth);
}

// --- no empty entries --------------------------------------------------------
console.log("\n--- transactions that change nothing ---");
{
  const doc = createDocument({ width: 4, height: 4, length: 4 });
  const history = createHistory();
  runTransaction(doc, history, "fill", (tx) => tx.fill({ minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3 }, STONE));

  runTransaction(doc, history, "write the same thing again", (tx) =>
    tx.fill({ minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3 }, STONE),
  );
  equal("a no-op transaction adds no undo step", history.undoStack.length, 1);

  runTransaction(doc, history, "replace a block that is not there", (tx) =>
    tx.replace({ minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 3, maxZ: 3 }, GLASS, PLANKS),
  );
  equal("neither does a replace that matched nothing", history.undoStack.length, 1);
}

// --- dirty tracking ----------------------------------------------------------
//
// By stack depth, not by a revision counter: undoing back to the saved state
// has to read as clean, and a monotonic counter cannot say that.
console.log("\n--- dirty state ---");
{
  const doc = createDocument({ width: 4, height: 4, length: 4 });
  const history = createHistory();
  check("a new document is clean", !isDirty(history));

  runTransaction(doc, history, "one", (tx) => tx.setBlock(0, 0, 0, STONE));
  check("an edit makes it dirty", isDirty(history));

  markHistorySaved(history);
  check("saving makes it clean", !isDirty(history));

  runTransaction(doc, history, "two", (tx) => tx.setBlock(1, 0, 0, STONE));
  check("a further edit dirties it again", isDirty(history));

  undo(doc, history);
  check("undoing back to the saved state makes it clean again", !isDirty(history));

  redo(doc, history);
  check("...and redoing past it makes it dirty", isDirty(history));

  undo(doc, history);
  undo(doc, history);
  check("undoing past the saved point is dirty too", isDirty(history));
}

// --- the stack does not grow without bound -----------------------------------
console.log("\n--- stack limit ---");
{
  // Each edit writes a distinct cell: repeating a cell would record nothing,
  // which is correct behaviour but would leave this measuring the wrong thing.
  const doc = createDocument({ width: 8, height: 4, length: 4 });
  const history = createHistory(3);
  for (let i = 0; i < 6; i += 1) {
    runTransaction(doc, history, `edit ${i}`, (tx) => tx.setBlock(i, 0, 0, STONE));
  }
  equal("the oldest entries are discarded", history.undoStack.length, 3);
  equal("the newest is kept", nextUndoLabel(history), "edit 5");

  // Once the saved point has been discarded the document can never be shown as
  // clean again -- better than sliding the mark onto a different edit and
  // calling a modified document saved.
  const trimmed = createHistory(2);
  const doc2 = createDocument({ width: 4, height: 4, length: 4 });
  runTransaction(doc2, trimmed, "a", (tx) => tx.setBlock(0, 0, 0, STONE));
  markHistorySaved(trimmed);
  for (let i = 0; i < 4; i += 1) {
    runTransaction(doc2, trimmed, `later ${i}`, (tx) => tx.setBlock(i % 4, 1, 0, STONE));
  }
  check("a discarded save point never reads as clean", isDirty(trimmed));
}

// --- undo and redo at the ends -----------------------------------------------
console.log("\n--- boundaries ---");
{
  const doc = createDocument({ width: 2, height: 2, length: 2 });
  const history = createHistory();
  check("undo on an empty stack is a no-op", undo(doc, history) === null);
  check("so is redo", redo(doc, history) === null);
  check("neither is offered", !canUndo(history) && !canRedo(history));

  runTransaction(doc, history, "one", (tx) => tx.setBlock(0, 0, 0, STONE));
  undo(doc, history);
  runTransaction(doc, history, "a different branch", (tx) => tx.setBlock(1, 1, 1, PLANKS));
  check("a new edit discards the redo branch", !canRedo(history));
}

// --- block entities across undo ----------------------------------------------
console.log("\n--- block entities ---");
{
  const doc = createDocument({ width: 2, height: 1, length: 1 });
  const history = createHistory();
  const chest = {
    id: "minecraft:chest",
    pos: [0, 0, 0] as const,
    nbt: { Items: { type: "list", value: [{ id: { type: "string", value: "minecraft:diamond" } }] } },
  };
  setBlockEntity(doc, 0, 0, 0, chest);

  runTransaction(doc, history, "replace the chest with stone", (tx) => tx.setBlock(0, 0, 0, STONE));
  check("the chest is gone", getBlockEntity(doc, 0, 0, 0) === null);

  undo(doc, history);
  equal("undo brings the chest back", getBlockEntity(doc, 0, 0, 0)?.id, "minecraft:chest");
  equal(
    "...with its contents intact",
    JSON.stringify(getBlockEntity(doc, 0, 0, 0)?.nbt),
    JSON.stringify(chest.nbt),
  );
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
