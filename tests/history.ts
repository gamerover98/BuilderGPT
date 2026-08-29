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
  nextUndoId,
  nextUndoLabel,
  readHeader,
  redo,
  runTransaction,
  summarizeTransaction,
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
const AIR = block("minecraft:air");

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

// --- the header: everything about a schematic that is not a block -----------
//
// Where it sat in the world, what wrote it, the file's own metadata, and the
// entities inside it. None of these are voxels, so none of them were on the
// undo stack at all until the NBT panel needed to change them.
console.log("\n--- the header ---");
{
  const doc = createDocument({ width: 2, height: 2, length: 2 });
  const history = createHistory();
  doc.offset = [-4, 64, 12];
  doc.worldOrigin = [201, 92, 3];
  doc.metadata = { Author: { type: "string", value: "gamerover98" } };

  const before = readHeader(doc);
  runTransaction(doc, history, "edit the NBT", (tx) =>
    tx.setHeader({
      offset: [1, 2, 3],
      worldOrigin: [500, 70, -300],
      dataVersion: 3700,
      metadata: { Name: { type: "string", value: "renamed" } },
      entities: [{ id: "minecraft:armor_stand", pos: [0.5, 0, 0.5], nbt: {} }],
    }),
  );

  equal("the offset changed", doc.offset, [1, 2, 3]);
  equal("...and the Origin", doc.worldOrigin, [500, 70, -300]);
  equal("...and the DataVersion", doc.dataVersion, 3700);
  equal("...and the metadata bag, wholesale", doc.metadata, {
    Name: { type: "string", value: "renamed" },
  });
  equal("...and the entity list", doc.entities.length, 1);

  // A header edit moves no voxels, so `changed` is zero -- and it must land on
  // the stack anyway, or the one edit nobody can undo is the one that moved the
  // whole build in the world.
  check("a header-only transaction is undoable", canUndo(history));
  check("...and makes the document dirty", isDirty(history));

  undo(doc, history);
  equal("undo puts all five back", readHeader(doc), before);
  redo(doc, history);
  equal("redo puts all five forward again", doc.worldOrigin, [500, 70, -300]);
  equal("...including the entities", doc.entities.length, 1);

  // The stack keeps its own copy: writing through the document afterwards must
  // not reach into what the undo entry recorded.
  undo(doc, history);
  doc.metadata.Author = { type: "string", value: "someone else" };
  doc.entities.push({ id: "minecraft:pig", pos: [0, 0, 0], nbt: {} });
  redo(doc, history);
  undo(doc, history);
  equal("...so a later mutation cannot reach back into it", readHeader(doc), before);
}

// --- a resize carries the world position with it ----------------------------
//
// `resizeDocument` recomputes both from the shift, which is right forwards and
// not necessarily backwards -- so the command records them and the revert puts
// back what it recorded.
console.log("\n--- resize and the world position ---");
{
  const doc = createDocument({ width: 2, height: 2, length: 2 });
  const history = createHistory();
  doc.offset = [-4, 64, 12];
  doc.worldOrigin = [201, 92, 3];

  runTransaction(doc, history, "grow downwards", (tx) =>
    tx.resize({ width: 2, height: 4, length: 2 }, [0, 2, 0]),
  );
  equal("the shift moved the offset", doc.offset, [-4, 62, 12]);
  equal("...and the Origin with it", doc.worldOrigin, [201, 90, 3]);

  undo(doc, history);
  equal("undo restores the offset", doc.offset, [-4, 64, 12]);
  equal("...and the Origin", doc.worldOrigin, [201, 92, 3]);

  redo(doc, history);
  equal("redo re-derives both from the shift", [doc.offset, doc.worldOrigin], [
    [-4, 62, 12],
    [201, 90, 3],
  ]);
}

// --- summarising a transaction -----------------------------------------------
//
// The chat shows what an edit took out, so the user can tell whether their
// build survived. It reads the recorded deltas rather than re-deriving the
// difference, which is what stops it claiming something undo would not restore.
console.log("\n--- what a transaction did, by block ---");
{
  const doc = createDocument({ width: 4, height: 4, length: 4 });
  const history = createHistory();
  runTransaction(doc, history, "seed", (tx) => {
    tx.fill({ minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3 }, STONE);
    tx.setBlock(0, 0, 0, PLANKS);
  });

  runTransaction(doc, history, "swap", (tx) =>
    tx.replace({ minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3 }, STONE, GLASS),
  );
  const swap = summarizeTransaction(doc, history.undoStack[history.undoStack.length - 1]);
  equal("it names what was taken", swap.removed, [{ block: "minecraft:stone", count: 15 }]);
  equal("...and what replaced it", swap.added, [{ block: "minecraft:glass", count: 15 }]);
  equal("...and how many voxels moved", swap.changed, 15);

  // Air is absence. Reporting it would turn a demolition into a gain.
  runTransaction(doc, history, "demolish", (tx) =>
    tx.fill({ minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3 }, AIR),
  );
  const demolished = summarizeTransaction(doc, history.undoStack[history.undoStack.length - 1]);
  equal("a demolition adds nothing", demolished.added, []);
  equal("...and is all loss", demolished.changed, 16);
  check(
    "...with air named nowhere",
    demolished.removed.every((tally) => !tally.block.startsWith("minecraft:air")),
    JSON.stringify(demolished.removed),
  );

  // Deltas are coalesced per voxel, keeping the first `before` and the latest
  // `after`. So a run that writes a cell and then puts it back leaves a delta
  // that records no change at all — and reporting that as damage would have the
  // chat claim a loss the user can see is not there.
  const settled = createDocument({ width: 2, height: 2, length: 2 });
  const settledHistory = createHistory();
  runTransaction(settled, settledHistory, "seed", (tx) => tx.setBlock(0, 0, 0, STONE));
  runTransaction(settled, settledHistory, "there and back", (tx) => {
    tx.setBlock(0, 0, 0, GLASS);
    tx.setBlock(0, 0, 0, STONE);
    // A second cell that really does change, so the transaction is not empty
    // and the zero-delta one has to be excluded on its own merits.
    tx.setBlock(1, 1, 1, PLANKS);
    return 0;
  });
  const net = summarizeTransaction(settled, settledHistory.undoStack[settledHistory.undoStack.length - 1]);
  equal("a cell put back the way it was is not counted", net.changed, 1);
  equal("...and is not reported as a loss", net.removed, []);
  equal("...only the cell that really changed is reported", net.added, [
    { block: "minecraft:oak_planks", count: 1 },
  ]);

  // A shrink is the most destructive edit there is, and the blocks it throws
  // away are recorded nowhere except the command's own `dropped` list. Summing
  // only the `blocks` commands would report the worst case as harmless.
  const tall = createDocument({ width: 4, height: 4, length: 4 });
  const tallHistory = createHistory();
  runTransaction(tall, tallHistory, "seed", (tx) =>
    tx.fill({ minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 3, maxZ: 3 }, STONE),
  );
  runTransaction(tall, tallHistory, "shrink", (tx) =>
    tx.resize({ width: 2, height: 2, length: 2 }),
  );
  const shrunk = summarizeTransaction(tall, tallHistory.undoStack[tallHistory.undoStack.length - 1]);
  equal("a shrink reports the blocks it destroyed", shrunk.removed, [
    { block: "minecraft:stone", count: 56 },
  ]);
  equal("...all 64 less the 8 that survived", shrunk.changed, 56);
  equal("...having added nothing", shrunk.added, []);
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

// --- naming a transaction ---------------------------------------------------
console.log("\n--- transactions have identities ---");
{
  const doc = createDocument({ width: 4, height: 4, length: 4, format: "sponge3" });
  const history = createHistory();
  // The entry itself: `tx.setBlock` interns for you, and handing it an index
  // is the mistake this file has made before.
  const stone: PaletteEntry = { namespacedName: "minecraft:stone", properties: {} };

  /*
   * The case the id exists for. Labels are derived from what was asked, so two
   * turns asking the same thing carry the same string -- and the chat matched
   * on that string to decide whether its "Undo this" was still the top of the
   * stack. It could offer to undo the wrong turn, and the user could not tell.
   */
  runTransaction(doc, history, "Fill with minecraft:stone", (tx) =>
    tx.setBlock(0, 0, 0, stone),
  );
  const first = nextUndoId(history);

  runTransaction(doc, history, "Fill with minecraft:stone", (tx) =>
    tx.setBlock(1, 0, 0, stone),
  );
  const second = nextUndoId(history);

  equal("the two turns share a label", nextUndoLabel(history), "Fill with minecraft:stone");
  check("...and are told apart by id anyway", first !== second, `${first} vs ${second}`);

  // Undoing the second leaves the first on top -- and a caller still holding
  // the second's id can now see that it is stale.
  undo(doc, history);
  equal("the id follows the stack down", nextUndoId(history), first);

  // Ids are never reused, so a stale one can only fail to match; it can never
  // silently name a different transaction.
  runTransaction(doc, history, "Fill with minecraft:stone", (tx) =>
    tx.setBlock(2, 0, 0, stone),
  );
  const third = nextUndoId(history);
  check("a new transaction takes a fresh id", third !== first && third !== second, `${third}`);

  equal("an empty stack has no id", nextUndoId(createHistory()), null);
}


// --- a command on the far side of the connection pass ------------------------
//
// `TransactionOptions.after` exists for one caller and one shape of command: a
// resize that follows an edit rather than preceding one. `tx.resize` calls
// `flush()`, and the pass reads the recorder's *live* set -- so written into
// the body it would not reorder the two, it would delete the derivation. What
// is checked here is the half that has nothing to do with connections: it is
// part of the same step, and a throw inside it takes the whole step back.
console.log("\n--- after the derivation ---");
{
  {
    const doc = createDocument({ width: 4, height: 4, length: 4 });
    const history = createHistory();
    const order: string[] = [];
    runTransaction(doc, history, "resize after", (tx) => {
      tx.setBlock(1, 1, 1, STONE);
      order.push("body");
    }, {
      after: (tx) => {
        order.push("after");
        tx.resize({ width: 3, height: 3, length: 3 });
      },
    });
    equal("it runs, and after the body", order, ["body", "after"]);
    equal("its command lands in the same step", history.undoStack.length, 1);
    equal("...alongside the edit", [doc.width, doc.height, doc.length], [3, 3, 3]);
    undo(doc, history);
    equal("one undo takes both back", [doc.width, doc.height, doc.length], [4, 4, 4]);
    equal("...the block included", getBlock(doc, 1, 1, 1).namespacedName, "minecraft:air");
  }

  {
    /*
     * Inside the try, like the derivation above it. Outside, a rule that threw
     * here would leave the document edited with no entry describing it -- the
     * exact failure `runTransactionAsync` exists to prevent one layer up.
     */
    const doc = createDocument({ width: 4, height: 4, length: 4 });
    const history = createHistory();
    let raised = false;
    try {
      runTransaction(doc, history, "throws late", (tx) => {
        tx.setBlock(1, 1, 1, STONE);
      }, {
        after: () => {
          throw new Error("no");
        },
      });
    } catch {
      raised = true;
    }
    check("a throw in it is not swallowed", raised);
    equal("...and the edit is rolled back", getBlock(doc, 1, 1, 1).namespacedName, "minecraft:air");
    equal("...leaving nothing on the stack", history.undoStack.length, 0);
  }
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
