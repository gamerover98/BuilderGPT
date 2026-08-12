/**
 * `services/session.ts` — the open document, as the IPC handlers drive it.
 *
 * The handlers themselves need Electron, so this exercises the layer under
 * them: the same calls in the same order, checking the things a thin handler
 * cannot get wrong on its own — that an edit is one undo step, that saving in a
 * new format sticks, that a mesh is not handed out stale, and that a request
 * with nothing open is refused rather than crashing the main process.
 */

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

import { getBlock, setBlock, setBlockEntity } from "../src/main/domain/document.js";
import {
  applyEdit,
  closeDocument,
  copySelection,
  currentClipboard,
  currentSession,
  cutSelection,
  documentMesh,
  documentState,
  editBlockEntityValue,
  EditTooLargeError,
  inspect,
  MAX_EDIT_VOLUME,
  newDocument,
  NoBlockEntityError,
  NoDocumentError,
  NoSaveTargetError,
  NotSquareError,
  openDocument,
  pasteSelection,
  redoEdit,
  requireSession,
  saveSession,
  transformRegion,
  undoEdit,
} from "../src/main/services/session.js";
import { clearBakerCache } from "../src/main/services/preview.js";
import { UnrepresentableBlocksError } from "../src/main/services/writers.js";
import { SpongeSchematicWriter } from "../src/main/services/schematic.js";
import { dataVersionFor } from "../src/main/services/versions.js";

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

const LEGACY_BLOCKS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "resources",
  "legacy_blocks.json",
);

const stone = { namespacedName: "minecraft:stone" };
const planks = { namespacedName: "minecraft:oak_planks" };

console.log("=== Schematic AI Studio document session ===\n");

const workDir = await mkdtemp(path.join(tmpdir(), "bgpt-session-"));

try {
  // --- nothing open ---------------------------------------------------------
  console.log("--- with no document open ---");
  {
    closeDocument();
    check("there is no session", currentSession() === null);
    check(
      "asking for one is a named error, not a crash",
      (() => {
        try {
          requireSession();
          return false;
        } catch (err) {
          return err instanceof NoDocumentError;
        }
      })(),
    );
  }

  // --- opening --------------------------------------------------------------
  console.log("\n--- opening a file ---");
  const writer = new SpongeSchematicWriter();
  for (const [x, y, z, block] of [
    [0, 0, 0, "minecraft:stone"],
    [1, 0, 0, "minecraft:cobblestone"],
    [2, 0, 0, "minecraft:cobblestone"],
    [0, 1, 0, "minecraft:glass"],
    [2, 2, 2, "minecraft:oak_planks"],
  ] as const) {
    writer.setBlock([x, y, z], block);
  }
  const schemPath = await writer.save(workDir, "session", dataVersionFor("JE_1_20_4"));

  {
    const session = await openDocument(schemPath, { legacyBlocksPath: LEGACY_BLOCKS });
    const state = documentState(session);
    equal("the state names the file", state.fileName, "session.schem");
    equal("...its format", state.format, "sponge2");
    equal("...its size", state.size, [3, 3, 3]);
    equal("...and its block count", state.blockCount, 5);
    check("it opens clean", !state.dirty);
    check("with nothing to undo", !state.canUndo && !state.canRedo);

    // The palette summary is what the UI lists; air must not be in it, and the
    // most common block comes first.
    equal("the palette is summarised commonest-first", state.palette[0], {
      block: "minecraft:cobblestone",
      count: 2,
    });
    check(
      "air is not listed as a material",
      !state.palette.some((entry) => entry.block.includes("air")),
    );
  }

  // --- editing --------------------------------------------------------------
  console.log("\n--- editing ---");
  {
    const session = requireSession();
    const changed = applyEdit(session, {
      kind: "replace",
      region: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 },
      from: { namespacedName: "minecraft:cobblestone" },
      to: stone,
    });
    equal("the replace reports how many blocks it touched", changed, 2);

    const state = documentState(session);
    check("the document is now dirty", state.dirty);
    check("...and there is something to undo", state.canUndo);
    equal(
      "...labelled from the request, not from the renderer",
      state.undoLabel,
      "Replace minecraft:cobblestone with minecraft:stone",
    );
    equal("the blocks really changed", getBlock(session.doc, 1, 0, 0).namespacedName, "minecraft:stone");

    undoEdit(session);
    equal(
      "one undo reverses the whole replace",
      getBlock(session.doc, 1, 0, 0).namespacedName,
      "minecraft:cobblestone",
    );
    check("...and the document reads clean again", !documentState(session).dirty);

    redoEdit(session);
    equal("redo reapplies it", getBlock(session.doc, 1, 0, 0).namespacedName, "minecraft:stone");

    // A fill and a single block, to be sure each is one step.
    const before = documentState(session).canUndo;
    applyEdit(session, {
      kind: "fill",
      region: { minX: 0, minY: 2, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 },
      block: planks,
    });
    equal("a fill is one step", documentState(session).undoLabel, "Fill with minecraft:oak_planks");
    check("...on top of the previous one", before);

    applyEdit(session, { kind: "setBlock", x: 1, y: 1, z: 1, block: stone });
    equal("a single block is its own step", documentState(session).undoLabel, "Place minecraft:stone");
    equal("...and it landed", getBlock(session.doc, 1, 1, 1).namespacedName, "minecraft:stone");
  }

  // --- an edit that would swallow the machine -------------------------------
  console.log("\n--- oversized edits ---");
  {
    const session = newDocument({ width: 8, height: 8, length: 8 });
    // The region is clipped to the document before the volume is measured, so
    // asking for the universe on a small schematic is simply a full fill.
    const changed = applyEdit(session, {
      kind: "fill",
      region: { minX: -1000, minY: -1000, minZ: -1000, maxX: 1000, maxY: 1000, maxZ: 1000 },
      block: stone,
    });
    equal("an unbounded region is clipped to the document", changed, 512);

    // ...but a genuinely enormous document must still refuse.
    const huge = newDocument({ width: 256, height: 256, length: 256 });
    check(
      "an edit over the volume limit is refused by name",
      (() => {
        try {
          applyEdit(huge, {
            kind: "fill",
            region: { minX: 0, minY: 0, minZ: 0, maxX: 255, maxY: 255, maxZ: 255 },
            block: stone,
          });
          return false;
        } catch (err) {
          return err instanceof EditTooLargeError;
        }
      })(),
      `limit is ${MAX_EDIT_VOLUME}`,
    );
    check("...leaving the document untouched", !documentState(huge).dirty);
  }

  // --- the mesh -------------------------------------------------------------
  console.log("\n--- meshing ---");
  {
    clearBakerCache();
    const session = await openDocument(schemPath, { legacyBlocksPath: LEGACY_BLOCKS });
    const previewOptions = {
      resourcePackPath: null,
      fallbackResourcePackPath: null,
      biomeColor: "#91bd59",
      waterColor: "#3f76e4",
    };

    const first = await documentMesh(session, previewOptions);
    check("the first mesh is built", !first.cached && first.glb.length > 0);
    const second = await documentMesh(session, previewOptions);
    check("asking again with no change returns the cached one", second.cached);

    applyEdit(session, { kind: "setBlock", x: 2, y: 2, z: 0, block: stone });
    const third = await documentMesh(session, previewOptions);
    check("an edit invalidates it", !third.cached);
    check(
      "...and the geometry actually differs",
      Buffer.compare(Buffer.from(first.glb), Buffer.from(third.glb)) !== 0,
    );

    // The subtle one: undo also moves the revision forward, so a mesh built
    // before an edit must not be served after it is undone.
    undoEdit(session);
    const fourth = await documentMesh(session, previewOptions);
    check("undo invalidates the mesh too", !fourth.cached);
    check(
      "...and lands back on the original geometry",
      Buffer.compare(Buffer.from(first.glb), Buffer.from(fourth.glb)) === 0,
    );
  }

  // --- inspecting -----------------------------------------------------------
  console.log("\n--- inspecting ---");
  {
    const session = requireSession();
    setBlock(session.doc, 0, 2, 0, { namespacedName: "minecraft:chest", properties: { facing: "north" } });
    session.doc.blockEntities.set("0,2,0", {
      id: "minecraft:chest",
      pos: [0, 2, 0],
      nbt: { Lock: { type: "string", value: "key" } },
    });

    const found = inspect(session, 0, 2, 0);
    equal("the block is named", found.block, "minecraft:chest");
    equal("...with its states", found.properties, { facing: "north" });
    equal("...and its block entity", found.blockEntity?.id, "minecraft:chest");
    check(
      "the NBT crosses as JSON, not as a tag tree",
      typeof found.blockEntity?.nbt === "string" && found.blockEntity.nbt.includes("key"),
    );

    const empty = inspect(session, 1, 2, 1);
    equal("an empty cell reports air", empty.block, "minecraft:air");
    check("...with no block entity", empty.blockEntity === null);
  }

  // --- saving ---------------------------------------------------------------
  console.log("\n--- saving ---");
  {
    const session = await openDocument(schemPath, { legacyBlocksPath: LEGACY_BLOCKS });
    applyEdit(session, { kind: "setBlock", x: 1, y: 1, z: 1, block: planks });
    check("dirty before saving", documentState(session).dirty);

    const saved = await saveSession(session, { legacyBlocksPath: LEGACY_BLOCKS });
    equal("a plain save writes over the file it came from", saved.filePath, schemPath);
    equal("...in the format it came in", saved.format, "sponge2");
    check("...and the document reads clean", !documentState(session).dirty);

    // Save As into another container: the file must be renamed to suit, and the
    // document must remember that it is now that file in that format.
    const target = path.join(workDir, "converted.schematic");
    const asV3 = await saveSession(session, { filePath: target, format: "sponge3" });
    check(
      "saving as v3 corrects the extension",
      asV3.filePath.endsWith(".schem") && !asV3.filePath.endsWith(".schematic"),
      asV3.filePath,
    );
    const state = documentState(session);
    equal("the document adopts the new format", state.format, "sponge3");
    equal("...and the new path", state.filePath, asV3.filePath);

    // A later plain save must go to the new file, not back to the original.
    applyEdit(session, { kind: "setBlock", x: 0, y: 2, z: 2, block: stone });
    const again = await saveSession(session);
    equal("a subsequent save follows the document", again.filePath, asV3.filePath);
    equal("...and its format", again.format, "sponge3");
  }

  console.log("\n--- saving what a format cannot hold ---");
  {
    const session = newDocument({ width: 2, height: 1, length: 1 }, "mcedit");
    applyEdit(session, { kind: "setBlock", x: 0, y: 0, z: 0, block: { namespacedName: "minecraft:deepslate_tiles" } });
    const target = path.join(workDir, "refused.schematic");

    check(
      "the save fails rather than dropping the block",
      await (async () => {
        try {
          await saveSession(session, { filePath: target, legacyBlocksPath: LEGACY_BLOCKS });
          return false;
        } catch (err) {
          return err instanceof UnrepresentableBlocksError;
        }
      })(),
    );
    check("...and the document is still dirty, since nothing was written", documentState(session).dirty);
  }

  console.log("\n--- saving a document that has no file ---");
  {
    const session = newDocument({ width: 2, height: 2, length: 2 });
    applyEdit(session, { kind: "setBlock", x: 0, y: 0, z: 0, block: stone });
    check(
      "a plain save with nowhere to go is refused by name",
      await (async () => {
        try {
          await saveSession(session);
          return false;
        } catch (err) {
          return err instanceof NoSaveTargetError;
        }
      })(),
    );

    const target = path.join(workDir, "brand-new.schem");
    const saved = await saveSession(session, { filePath: target });
    equal("...and succeeds once given one", saved.filePath, target);
    check("...leaving it clean", !documentState(session).dirty);
  }
} finally {
  closeDocument();
  await rm(workDir, { recursive: true, force: true });
}

// --- editing a block entity through the session --------------------------------
//
// The inspector claims each NBT change is its own undo step. That claim is the
// reason the edit goes through a transaction at all, so it is worth checking
// against the real session rather than against the pure helper.
console.log("\n--- editing block entity data ---");
{
  const session = newDocument({ width: 2, height: 2, length: 2 });
  setBlock(session.doc, 0, 0, 0, { namespacedName: "minecraft:oak_sign", properties: {} });
  setBlockEntity(session.doc, 0, 0, 0, {
    id: "minecraft:oak_sign",
    pos: [0, 0, 0],
    nbt: { Text1: { type: "string", value: "before" }, Glow: { type: "byte", value: 0 } },
  });
  session.history.undoStack.length = 0;
  session.history.redoStack.length = 0;
  session.history.savedDepth = 0;

  const field = (label: string) =>
    inspect(session, 0, 0, 0).blockEntity?.fields.find((f) => f.label === label);

  equal("the inspector offers the sign's text", field("Text1")?.value, "before");

  editBlockEntityValue(session, 0, 0, 0, ["Text1"], "after");
  equal("editing it changes what the inspector reports", field("Text1")?.value, "after");
  equal("...as exactly one undo step", session.history.undoStack.length, 1);
  check(
    "...labelled for the menu",
    session.history.undoStack[0]?.label.includes("Text1"),
    session.history.undoStack[0]?.label,
  );

  undoEdit(session);
  equal("undo puts the old text back", field("Text1")?.value, "before");
  equal("...and the tag is still a string", field("Text1")?.type, "string");

  redoEdit(session);
  equal("redo reapplies it", field("Text1")?.value, "after");

  // A second field must not disturb the first.
  editBlockEntityValue(session, 0, 0, 0, ["Glow"], "1");
  equal("a second field writes independently", field("Glow")?.value, "1");
  equal("...leaving the first alone", field("Text1")?.value, "after");

  // A refusal must not leave a half-step on the stack, or CTRL+Z would undo
  // something the user never saw happen.
  const depth = session.history.undoStack.length;
  let refused = false;
  try {
    editBlockEntityValue(session, 0, 0, 0, ["Glow"], "not a number");
  } catch {
    refused = true;
  }
  check("a value that cannot be coerced is refused", refused);
  equal("...leaving the data as it was", field("Glow")?.value, "1");
  equal("...and adding no undo step", session.history.undoStack.length, depth);

  // Nowhere to write is its own answer, not a crash.
  let missing = false;
  try {
    editBlockEntityValue(session, 1, 1, 1, ["Text1"], "x");
  } catch (err) {
    missing = err instanceof NoBlockEntityError;
  }
  check("a block with no block entity is refused by name", missing);
  closeDocument();
}

// --- rotating and mirroring ----------------------------------------------------
//
// Moving the voxels is the half that looks finished. The half that decides
// whether the build survives is the block states: a staircase turned a quarter
// without its `facing` following runs into a wall.
console.log("\n--- turning a region ---");
{
  const session = newDocument({ width: 4, height: 1, length: 4 });
  const stairs = (facing: string) => ({
    namespacedName: "minecraft:oak_stairs",
    properties: { facing, half: "bottom", shape: "straight" },
  });
  setBlock(session.doc, 0, 0, 0, stairs("north"));
  setBlock(session.doc, 3, 0, 0, { namespacedName: "minecraft:oak_log", properties: { axis: "x" } });
  session.history.undoStack.length = 0;
  session.history.savedDepth = 0;

  const whole = { minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3 };
  const at = (x: number, z: number) => getBlock(session.doc, x, 0, z);
  const snapshot = () => {
    const out: string[] = [];
    for (let x = 0; x < 4; x += 1)
      for (let z = 0; z < 4; z += 1) {
        const b = at(x, z);
        out.push(`${x},${z}:${b.namespacedName}${JSON.stringify(b.properties)}`);
      }
    return out.join("|");
  };
  const before = snapshot();

  transformRegion(session, whole, { kind: "rotate", steps: 1 });

  // The mesher's convention: one step sends (x, z) -> (size - 1 - z, x), and
  // east to south. A north-facing stair therefore becomes east-facing.
  equal("the block moved where the mesher says it should", at(3, 0).namespacedName, "minecraft:oak_stairs");
  equal("...and its facing turned with it", at(3, 0).properties.facing, "east");
  equal("...while a log's axis swapped", at(3, 3).properties.axis, "z");
  equal("...leaving where it came from empty", at(0, 0).namespacedName, "minecraft:air");
  equal("the whole turn is one undo step", session.history.undoStack.length, 1);

  // The property that catches almost any mistake at once.
  transformRegion(session, whole, { kind: "rotate", steps: 1 });
  transformRegion(session, whole, { kind: "rotate", steps: 1 });
  transformRegion(session, whole, { kind: "rotate", steps: 1 });
  equal("four quarter turns return everything exactly as it was", snapshot(), before);

  undoEdit(session);
  undoEdit(session);
  undoEdit(session);
  undoEdit(session);
  equal("...and so does undoing all four", snapshot(), before);
}

console.log("\n--- mirroring a region ---");
{
  const session = newDocument({ width: 4, height: 1, length: 4 });
  setBlock(session.doc, 0, 0, 1, {
    namespacedName: "minecraft:oak_stairs",
    properties: { facing: "east", shape: "inner_left" },
  });
  setBlock(session.doc, 1, 0, 0, {
    namespacedName: "minecraft:oak_door",
    properties: { facing: "north", hinge: "left" },
  });
  session.history.undoStack.length = 0;

  const whole = { minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3 };
  const at = (x: number, z: number) => getBlock(session.doc, x, 0, z);

  transformRegion(session, whole, { kind: "mirror", axis: "x" });
  equal("the block reflected across x", at(3, 1).namespacedName, "minecraft:oak_stairs");
  equal("...and east became west", at(3, 1).properties.facing, "west");
  // A reflection is what turns a left-hand staircase into a right-hand one.
  equal("...and the corner changed hand", at(3, 1).properties.shape, "inner_right");
  equal("a door's hinge changed hand too", at(2, 0).properties.hinge, "right");
  equal("...while a north-facing door still faces north", at(2, 0).properties.facing, "north");

  // A mirror is its own inverse, which is the cheapest check there is.
  const mirrored = at(3, 1).properties.facing;
  transformRegion(session, whole, { kind: "mirror", axis: "x" });
  equal("mirroring twice restores the facing", at(0, 1).properties.facing, "east");
  equal("...and the shape", at(0, 1).properties.shape, "inner_left");
  check("...having actually changed it in between", mirrored === "west");
}

console.log("\n--- what a turn refuses, and what it carries ---");
{
  const session = newDocument({ width: 6, height: 1, length: 3 });
  const oblong = { minX: 0, minY: 0, minZ: 0, maxX: 5, maxY: 0, maxZ: 2 };

  let refused = false;
  try {
    transformRegion(session, oblong, { kind: "rotate", steps: 1 });
  } catch (err) {
    refused = err instanceof NotSquareError;
  }
  check("a quarter turn of an oblong is refused by name", refused);
  equal("...leaving no undo step behind", session.history.undoStack.length, 0);

  // A half turn maps the box onto itself whatever its shape, so it is allowed.
  setBlock(session.doc, 0, 0, 0, { namespacedName: "minecraft:stone", properties: {} });
  transformRegion(session, oblong, { kind: "rotate", steps: 2 });
  equal("a half turn of the same oblong is fine", getBlock(session.doc, 5, 0, 2).namespacedName, "minecraft:stone");

  // A chest that moves must take its contents with it, and say where it is now.
  const chest = newDocument({ width: 2, height: 1, length: 2 });
  setBlock(chest.doc, 0, 0, 0, { namespacedName: "minecraft:chest", properties: { facing: "north" } });
  setBlockEntity(chest.doc, 0, 0, 0, {
    id: "minecraft:chest",
    pos: [0, 0, 0],
    nbt: { Loot: { type: "string", value: "diamonds" } },
  });
  transformRegion(chest, { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 1 }, { kind: "rotate", steps: 1 });

  const moved = chest.doc.blockEntities.get("1,0,0") ?? null;
  check("the chest's block entity moved with it", moved !== null);
  equal("...keeping its contents", JSON.stringify(moved?.nbt), JSON.stringify({ Loot: { type: "string", value: "diamonds" } }));
  equal("...and knowing where it now is", moved?.pos, [1, 0, 0]);
  check("...leaving none behind", (chest.doc.blockEntities.get("0,0,0") ?? null) === null);
  closeDocument();
}

// --- copy and paste ------------------------------------------------------------
console.log("\n--- copying a region ---");
{
  const session = newDocument({ width: 8, height: 2, length: 8 });
  const stair = { namespacedName: "minecraft:oak_stairs", properties: { facing: "north" } };
  setBlock(session.doc, 0, 0, 0, { namespacedName: "minecraft:stone", properties: {} });
  setBlock(session.doc, 1, 0, 0, stair);
  setBlock(session.doc, 0, 0, 1, { namespacedName: "minecraft:chest", properties: {} });
  setBlockEntity(session.doc, 0, 0, 1, {
    id: "minecraft:chest",
    pos: [0, 0, 1],
    nbt: { Loot: { type: "string", value: "diamonds" } },
  });
  session.history.undoStack.length = 0;
  session.history.savedDepth = 0;

  const source = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 1 };
  const held = copySelection(session, source);
  equal("the clipboard knows its shape", [held.width, held.height, held.length], [2, 1, 2]);
  equal("...and how much is in it", held.blocks, 3);
  check("copying alone changes nothing", session.history.undoStack.length === 0);

  // Paste somewhere else and compare cell for cell.
  pasteSelection(session, { x: 5, y: 0, z: 5 });
  equal("the plain block arrived", getBlock(session.doc, 5, 0, 5).namespacedName, "minecraft:stone");
  equal("...the stair too", getBlock(session.doc, 6, 0, 5).namespacedName, "minecraft:oak_stairs");
  equal("...keeping its block state", getBlock(session.doc, 6, 0, 5).properties.facing, "north");
  equal("the source is untouched", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:stone");
  equal("a paste is one undo step", session.history.undoStack.length, 1);

  // A chest must arrive with its contents, and know where it now is.
  const pasted = session.doc.blockEntities.get("5,0,6") ?? null;
  check("the chest's data came with it", pasted !== null);
  equal("...its contents intact", JSON.stringify(pasted?.nbt), JSON.stringify({ Loot: { type: "string", value: "diamonds" } }));
  equal("...and its position updated", pasted?.pos, [5, 0, 6]);

  undoEdit(session);
  equal("undo removes the whole paste", getBlock(session.doc, 5, 0, 5).namespacedName, "minecraft:air");
  check("...including the block entity", (session.doc.blockEntities.get("5,0,6") ?? null) === null);

}

// The default that makes paste usable: a copied box is mostly air, and writing
// that air would punch a rectangular hole in whatever the paste lands on.
console.log("\n--- pasted air leaves what is under it alone ---");
{
  const session = newDocument({ width: 6, height: 2, length: 6 });
  // A 2x1x2 box holding a single block: three of its four cells are air.
  setBlock(session.doc, 0, 0, 0, { namespacedName: "minecraft:glass", properties: {} });
  copySelection(session, { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 1 });

  // Ground to paste onto.
  for (let x = 3; x <= 4; x += 1) {
    for (let z = 3; z <= 4; z += 1) {
      setBlock(session.doc, x, 0, z, { namespacedName: "minecraft:stone", properties: {} });
    }
  }
  session.history.undoStack.length = 0;

  pasteSelection(session, { x: 3, y: 0, z: 3 });
  equal("the block landed", getBlock(session.doc, 3, 0, 3).namespacedName, "minecraft:glass");
  equal("...and the ground beside it survived", getBlock(session.doc, 4, 0, 3).namespacedName, "minecraft:stone");
  equal("...all of it", getBlock(session.doc, 4, 0, 4).namespacedName, "minecraft:stone");

  // ...and the other behaviour, for when you are moving a region rather than
  // stamping one.
  pasteSelection(session, { x: 3, y: 0, z: 3 }, { includeAir: true });
  equal("asking for air erases instead", getBlock(session.doc, 4, 0, 4).namespacedName, "minecraft:air");
}

console.log("\n--- cutting, clipping, and an empty clipboard ---");
{
  const session = newDocument({ width: 6, height: 2, length: 6 });
  setBlock(session.doc, 0, 0, 0, { namespacedName: "minecraft:stone", properties: {} });
  setBlock(session.doc, 1, 0, 0, { namespacedName: "minecraft:stone", properties: {} });
  session.history.undoStack.length = 0;

  const held = cutSelection(session, { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 0 });
  equal("a cut fills the clipboard", held.blocks, 2);
  equal("...and clears the region", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:air");
  equal("...as one undo step", session.history.undoStack.length, 1);
  undoEdit(session);
  equal("undoing a cut puts the blocks back", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:stone");

  // Pasting over an edge writes the part that fits rather than refusing.
  const changed = pasteSelection(session, { x: 5, y: 0, z: 0 });
  equal("the half that fits lands", changed, 1);
  equal("...at the edge", getBlock(session.doc, 5, 0, 0).namespacedName, "minecraft:stone");

  closeDocument();
}

// The reason the clipboard is not on the session: carrying between documents is
// most of what a clipboard is for.
console.log("\n--- the clipboard outlives the document ---");
{
  const first = newDocument({ width: 4, height: 1, length: 4 });
  setBlock(first.doc, 0, 0, 0, { namespacedName: "minecraft:diamond_block", properties: {} });
  copySelection(first, { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 });
  closeDocument();

  const second = newDocument({ width: 4, height: 1, length: 4 });
  check("it survived closing the document it came from", currentClipboard() !== null);
  pasteSelection(second, { x: 2, y: 0, z: 2 });
  equal(
    "...and pastes into a different one",
    getBlock(second.doc, 2, 0, 2).namespacedName,
    "minecraft:diamond_block",
  );
  closeDocument();
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
