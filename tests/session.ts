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

import { getBlock, setBlock } from "../src/main/domain/document.js";
import {
  applyEdit,
  closeDocument,
  currentSession,
  documentMesh,
  documentState,
  EditTooLargeError,
  inspect,
  MAX_EDIT_VOLUME,
  newDocument,
  NoDocumentError,
  NoSaveTargetError,
  openDocument,
  redoEdit,
  requireSession,
  saveSession,
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

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
