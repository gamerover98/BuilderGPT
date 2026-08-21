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
  moveRegion,
  editBlockEntityValue,
  DocumentTooLargeError,
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
import {
  applyNbt,
  schematicNbtText,
  setWorldEditAnchor,
  setWorldOrigin,
} from "../src/main/services/schematic_nbt.js";
import { parseSnbt, stringifySnbt } from "../src/main/domain/snbt.js";
import type { NbtCompound } from "../src/main/pipeline/types.js";
import type { DocumentSession } from "../src/main/services/session.js";
import { clearBakerCache } from "../src/main/services/preview.js";
import { loadStructure } from "../src/main/pipeline/loader.js";
import {
  checkpointExists,
  forgetCheckpointMemo,
  readCheckpoint,
  removeCheckpoints,
  takeCheckpoint,
  useCheckpointDirectory,
} from "../src/main/services/checkpoints.js";
import { isDirty } from "../src/main/domain/history.js";
import { countBlocks, createDocument, documentFromLoaded } from "../src/main/domain/document.js";
import { UnrepresentableBlocksError } from "../src/main/services/writers.js";
import { SpongeSchematicWriter } from "../src/main/services/schematic.js";
import { dataVersionFor } from "../src/main/services/versions.js";


/** A comparable digest of a mesh payload, for the equality checks below. */
function meshDigest(payload: {
  chunks: { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array }[];
  atlas: { width: number; height: number; pixels: Uint8Array } | null;
}): string {
  const hash = (array: Float32Array | Uint32Array | Uint8Array): string => {
    let h = 2166136261;
    for (let i = 0; i < array.length; i += 1) {
      h ^= Math.round(array[i] * 1000) | 0;
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  };
  const chunks = payload.chunks
    .map((c) => [c.positions.length, hash(c.positions), hash(c.normals), hash(c.uvs), hash(c.indices)].join(":"))
    .join("|");
  const atlas = payload.atlas
    ? `${payload.atlas.width}x${payload.atlas.height}:${hash(payload.atlas.pixels)}`
    : "none";
  return `${chunks}#${atlas}`;
}

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
    /*
     * A fill used to be clipped to the document before its volume was measured,
     * so asking for the universe quietly became a full fill of whatever was
     * open. That silence is the thing the free-footprint editor replaces: a
     * region outside the box now grows the box, and one that could not
     * possibly be built says so instead of doing something smaller than what
     * was asked.
     */
    check(
      "an unbounded region is refused rather than quietly clipped",
      (() => {
        try {
          applyEdit(session, {
            kind: "fill",
            region: { minX: -1000, minY: -1000, minZ: -1000, maxX: 1000, maxY: 1000, maxZ: 1000 },
            block: stone,
          });
          return false;
        } catch (err) {
          return err instanceof EditTooLargeError || err instanceof DocumentTooLargeError;
        }
      })(),
    );
    equal("...and the document is untouched", documentState(session).size, [8, 8, 8]);

    const changed = applyEdit(session, {
      kind: "fill",
      region: { minX: 0, minY: 0, minZ: 0, maxX: 7, maxY: 7, maxZ: 7 },
      block: stone,
    });
    equal("a fill of the whole document still works", changed, 512);

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
    check("the first mesh is built", !first.cached && first.mesh.chunks.length > 0);
    const second = await documentMesh(session, previewOptions);
    check("asking again with no change returns the cached one", second.cached);

    applyEdit(session, { kind: "setBlock", x: 2, y: 2, z: 0, block: stone });
    const third = await documentMesh(session, previewOptions);
    check("an edit invalidates it", !third.cached);
    check(
      "...and the geometry actually differs",
      meshDigest(first.mesh) !== meshDigest(third.mesh),
    );

    // The tints are multiplied into the texture atlas rather than applied by
    // the viewer, so changing one has to rebuild the mesh — and it moves no
    // revision, because it changes no block. Before the cache key included
    // them, changing the biome colour with a document open did nothing at all.
    //
    // What is asserted is that it *rebuilds*, not that the bytes differ: this
    // fixture has no resource pack, so blocks render as hashed colours and a
    // tint has nothing to multiply into. That the tint reaches the pixels is
    // `tests/blocks.ts`'s job, where there is a real pack to tint.
    const tinted = await documentMesh(session, { ...previewOptions, biomeColor: "#ff0000" });
    check("a different biome tint rebuilds rather than serving the cache", !tinted.cached);
    const water = await documentMesh(session, {
      ...previewOptions,
      biomeColor: "#ff0000",
      waterColor: "#00ff00",
    });
    check("so does a different water tint", !water.cached);
    check(
      "...and asking for the same tints again is cached",
      (await documentMesh(session, { ...previewOptions, biomeColor: "#ff0000", waterColor: "#00ff00" }))
        .cached,
    );
    // Back to the original tints for the checks below.
    await documentMesh(session, previewOptions);

    // The subtle one: undo also moves the revision forward, so a mesh built
    // before an edit must not be served after it is undone.
    undoEdit(session);
    const fourth = await documentMesh(session, previewOptions);
    check("undo invalidates the mesh too", !fourth.cached);
    check(
      "...and lands back on the original geometry",
      meshDigest(first.mesh) === meshDigest(fourth.mesh),
    );
  }

  /*
   * --- what an edit actually ships ------------------------------------------
   *
   * The chunked mesher re-meshes only the chunks an edit touched, and main
   * then shipped all of them anyway, with the atlas: on a 128x32x128 that was
   * 17.5 MB of geometry and 20.8 MB of pixels, structured-cloned across the
   * boundary and rebuilt into fresh BufferGeometry on arrival, for every single
   * block placed. That was the stutter, and none of it was the meshing.
   *
   * Nothing about the picture changes if this regresses, which is why the size
   * of the answer is asserted rather than its contents.
   */
  console.log("\n--- what an edit ships ---");
  {
    const session = requireSession();
    const previewOptions = {
      resourcePackPath: null,
      fallbackResourcePackPath: null,
      biomeColor: "#91bd59",
      waterColor: "#3f76e4",
    };

    // A window that has nothing gets everything, including the pixels.
    const full = await documentMesh(session, previewOptions, { mesh: null, atlas: null });
    check("a window holding nothing is sent every chunk", !full.mesh.partial);
    check("...and the atlas with it", full.mesh.atlas !== null);
    check("...and a token to hand back", full.mesh.token !== "");
    const chunkCount = full.mesh.chunks.length;
    check("the fixture has geometry to ship", chunkCount > 0);

    // Same document, same token: there is nothing to say.
    const again = await documentMesh(session, previewOptions, {
      mesh: full.mesh.token,
      atlas: full.mesh.atlasVersion,
    });
    check("asking again with the same token ships no geometry", again.mesh.chunks.length === 0);
    check("...and is marked as a delta, not as an empty document", again.mesh.partial);
    check("...and no atlas, because the window already has it", again.mesh.atlas === null);

    // One block, in one chunk.
    applyEdit(session, { kind: "setBlock", x: 1, y: 1, z: 1, block: stone });
    const delta = await documentMesh(session, previewOptions, {
      mesh: again.mesh.token,
      atlas: again.mesh.atlasVersion,
    });
    check("an edit ships something", delta.mesh.chunks.length > 0);
    check(
      "...but not the whole document, when only one chunk moved",
      delta.mesh.chunks.length < chunkCount || chunkCount === 1,
      `${delta.mesh.chunks.length} of ${chunkCount}`,
    );
    check("...still without the atlas", delta.mesh.atlas === null);

    // A token from before that edit is not one main can subtract from.
    const stale = await documentMesh(session, previewOptions, {
      mesh: "not-a-token-main-issued",
      atlas: null,
    });
    check("an unrecognised token is answered in full", !stale.mesh.partial);
    equal("...meaning every chunk", stale.mesh.chunks.length, chunkCount);
    check("...and the atlas again", stale.mesh.atlas !== null);

    undoEdit(session);
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

// --- the schematic's own NBT, as text ------------------------------------------
//
// The panel shows the root compound the file would carry and writes back what
// comes home. Everything below is a way of getting that wrong: a structural tag
// changed, a key deleted, two chests in one cell, a chest outside the grid, and
// an Apply built against a document that has since moved.
console.log("\n--- editing the schematic's NBT ---");
{
  const withSign = (): DocumentSession => {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    setBlock(session.doc, 1, 0, 1, { namespacedName: "minecraft:oak_sign", properties: {} });
    setBlockEntity(session.doc, 1, 0, 1, {
      id: "minecraft:oak_sign",
      pos: [1, 0, 1],
      nbt: { Text1: { type: "string", value: "before" } },
    });
    session.doc.offset = [-4, 64, 12];
    session.doc.worldOrigin = [201, 92, 3];
    session.history.undoStack.length = 0;
    session.history.redoStack.length = 0;
    session.history.savedDepth = 0;
    return session;
  };

  /** Applies `edit` to the current text and returns what main said about it. */
  const applying = (
    session: DocumentSession,
    edit: (text: string) => string,
  ): { ok: boolean; message: string } => {
    const read = schematicNbtText(session.doc);
    try {
      applyNbt(session.doc, session.history, edit(read.text), read.revision, "Edit the NBT");
      return { ok: true, message: "" };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  };

  {
    const session = withSign();
    const read = schematicNbtText(session.doc);
    check("the text is offered for editing", read.editable);
    check("...naming what it left out", read.omitted.includes("Blocks.Palette"), read.omitted.join());
    check("...and holds the Origin", read.text.includes("Origin: [I; 201, 92, 3]"), read.text);
    check("...and the sign's text", read.text.includes("before"));

    // The round trip on its own: applying the text unchanged changes nothing,
    // which is the baseline every failure below is measured against.
    const same = applying(session, (text) => text);
    check("applying it unchanged is accepted", same.ok, same.message);
    equal("...and records nothing to undo", session.history.undoStack.length, 0);
    closeDocument();
  }

  {
    const session = withSign();
    const done = applying(session, (text) => text.replace('"before"', '"after"'));
    check("editing the sign's text through the NBT is accepted", done.ok, done.message);
    equal(
      "...and the block entity really changed",
      session.doc.blockEntities.get("1,0,1")?.nbt.Text1,
      { type: "string", value: "after" },
    );
    equal("...as exactly one undo step", session.history.undoStack.length, 1);
    undoEdit(session);
    equal(
      "...which one CTRL+Z puts back",
      session.doc.blockEntities.get("1,0,1")?.nbt.Text1,
      { type: "string", value: "before" },
    );
    closeDocument();
  }

  {
    const session = withSign();
    const done = applying(session, (text) => text.replace("Origin: [I; 201, 92, 3]", "Origin: [I; 1, 2, 3]"));
    check("moving the Origin through the text is accepted", done.ok, done.message);
    equal("...and the document has it", session.doc.worldOrigin, [1, 2, 3]);
    closeDocument();
  }

  {
    // A structural tag is shown so it can be read, and refused so it cannot be
    // used to claim the schematic is a size it is not.
    const session = withSign();
    const done = applying(session, (text) => text.replace("Width: 4s", "Width: 40s"));
    check("changing Width is refused", !done.ok);
    check("...by name", done.message.includes("Width"), done.message);
    equal("...leaving the document alone", session.doc.width, 4);
    equal("...and nothing on the undo stack", session.history.undoStack.length, 0);
    closeDocument();
  }

  {
    // Deleting a key is refused rather than guessed at -- unless its absence is
    // itself a state the document holds. `Width` has no such state, so removing
    // it is a slip and is named as one.
    const session = withSign();
    const done = applying(session, (text) => text.replace(/\n\s*Width: 4s,/, ""));
    check("deleting Width is refused", !done.ok);
    check("...as missing, by name", done.message.includes("Width is missing"), done.message);
    equal("...leaving the document alone", session.doc.width, 4);
    closeDocument();
  }

  {
    // And the other side of the same rule: the anchor is optional, so deleting
    // its tag means "no anchor" -- the same act as the modal's Delete button --
    // rather than a slip to refuse or a [0,0,0] to guess at.
    const session = withSign();
    const done = applying(session, (text) =>
      text.replace(/\n\s*Offset: \[I; -4, 64, 12\],/, ""),
    );
    check("deleting Offset is accepted", done.ok, done.message);
    equal("...and removes the anchor rather than zeroing it", session.doc.offset, null);
    undoEdit(session);
    equal("...undoably", session.doc.offset, [-4, 64, 12]);
    closeDocument();
  }

  /*
   * The cases below reshape the block-entity list, which is nested three deep
   * and formatted over many lines -- so they go through the parser rather than
   * through a regex over the text. A test that edits SNBT with a regex is a
   * test that starts failing when the indentation changes.
   */
  const editingEntries = (
    session: DocumentSession,
    edit: (entries: NbtCompound[]) => NbtCompound[],
  ): { ok: boolean; message: string } => {
    const read = schematicNbtText(session.doc);
    const root = parseSnbt(read.text).value as NbtCompound;
    const blocks = (root.Blocks as { value: NbtCompound }).value;
    const list = blocks.BlockEntities as { value: { type: string; value: NbtCompound[] } };
    blocks.BlockEntities = {
      type: "list",
      value: { type: "compound", value: edit(list.value.value) },
    };
    try {
      applyNbt(
        session.doc,
        session.history,
        stringifySnbt({ type: "compound", value: root }),
        read.revision,
        "Edit the NBT",
      );
      return { ok: true, message: "" };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  };

  {
    const session = withSign();
    const done = editingEntries(session, ([entry]) => [
      { ...entry, Pos: { type: "intArray", value: [1, 0, 40] } },
    ]);
    check("a block entity outside the grid is refused", !done.ok);
    check("...naming where it was", done.message.includes("(1, 0, 40)"), done.message);
    equal("...leaving the sign where it is", session.doc.blockEntities.size, 1);
    closeDocument();
  }

  {
    // Two entries in one cell have one destination and cannot both reach it;
    // the map they are written into would silently keep the second.
    const session = withSign();
    const done = editingEntries(session, ([entry]) => [entry, entry]);
    check("two block entities in one cell are refused", !done.ok);
    check("...naming the cell", done.message.includes("(1, 0, 1)"), done.message);
    closeDocument();
  }

  {
    // An entry with no id cannot be placed anywhere. `readBlockEntities` drops
    // one of these without a word, which is right for a file somebody else
    // wrote and wrong for a line somebody just typed -- so the count going in
    // is compared with the count coming out.
    const session = withSign();
    const done = editingEntries(session, ([entry]) => {
      const { Id: _dropped, ...rest } = entry;
      return [rest];
    });
    check("a block entity with no id is refused", !done.ok, done.message);
    equal("...leaving the sign in place", session.doc.blockEntities.size, 1);
    closeDocument();
  }

  {
    // Writing the list as [] really does empty it -- that is the documented way
    // to remove every entry, and the only thing an absent key does not mean.
    const session = withSign();
    const done = editingEntries(session, () => []);
    check("an empty list is accepted", done.ok, done.message);
    equal("...and the sign is gone", session.doc.blockEntities.size, 0);
    undoEdit(session);
    equal("...undoably", session.doc.blockEntities.size, 1);
    closeDocument();
  }

  {
    // And the same rule protects the list from a slip: an absent
    // `BlockEntities` is a missing key, not an instruction to empty it.
    const session = withSign();
    const read = schematicNbtText(session.doc);
    const root = parseSnbt(read.text).value as NbtCompound;
    delete (root.Blocks as { value: NbtCompound }).value.BlockEntities;
    let refusal = "";
    try {
      applyNbt(
        session.doc,
        session.history,
        stringifySnbt({ type: "compound", value: root }),
        read.revision,
        "Edit the NBT",
      );
    } catch (err) {
      refusal = (err as Error).message;
    }
    // Named, and named as *missing* -- v3 keeps this list inside `Blocks`,
    // which is still present holding nothing, so the top-level walk cannot see
    // it and an earlier version of this reported "too large to edit" instead.
    check(
      "deleting the block entity list is refused by name",
      refusal.includes("BlockEntities is missing"),
      refusal,
    );
    equal("...leaving the sign in place", session.doc.blockEntities.size, 1);
    closeDocument();
  }

  {
    // The optimistic lock. The panel reads once, on open; without this an Apply
    // would put the entity list back over an undo that happened underneath it.
    const session = withSign();
    const read = schematicNbtText(session.doc);
    applyEdit(session, { kind: "setBlock", x: 3, y: 3, z: 3, block: stone });
    let stale = "";
    try {
      applyNbt(session.doc, session.history, read.text, read.revision, "Edit the NBT");
    } catch (err) {
      stale = (err as Error).message;
    }
    check("an Apply built against a stale read is refused", stale !== "");
    check("...saying the schematic moved", stale.includes("changed while this was open"), stale);
    closeDocument();
  }

  {
    // Malformed text is the parser's job, and its message has to survive the
    // trip: a position is the whole value of the error.
    const session = withSign();
    let broken = "";
    try {
      applyNbt(
        session.doc,
        session.history,
        "{Width: 4s,",
        session.doc.revision,
        "Edit the NBT",
      );
    } catch (err) {
      broken = (err as Error).message;
    }
    check("unparseable text is refused with a position", broken.includes("line 1"), broken);
    closeDocument();
  }

  {
    /*
     * The anchor's own verb, which the modal drives.
     *
     * It takes the *cell*, not the stored offset: the negation lives in main so
     * that the number the user types is the one the marker is drawn at. And it
     * is optional in a way the rest of the header is not -- a document starts
     * without one, and deleting it is a thing you can do.
     */
    const session = withSign();
    // `withSign` seeds one, so that the NBT tests above have a tag to edit.
    // This one is about not having one, which is how a document starts.
    session.doc.offset = null;
    const blocksBefore = countBlocks(session.doc);
    const paletteBefore = session.doc.palette.length;

    equal(
      "a document starts with no anchor at all",
      createDocument({ width: 1, height: 1, length: 1 }).offset,
      null,
    );

    setWorldEditAnchor(session.doc, session.history, [2, 0, 2], "Set the anchor");
    equal("the anchor verb stores the negated cell", session.doc.offset, [-2, 0, -2]);

    // The whole point of it not being a block: it occupies a cell in the
    // viewport and nothing in the grid, so nothing is exported and no palette
    // entry appears for it.
    equal("...and places no block", countBlocks(session.doc), blocksBefore);
    equal("...and adds nothing to the palette", session.doc.palette.length, paletteBefore);

    setWorldEditAnchor(session.doc, session.history, [0, 0, 0], "Move the anchor");
    equal("an anchor at the corner stores zero, which is not absence", session.doc.offset, [0, 0, 0]);

    setWorldEditAnchor(session.doc, session.history, null, "Delete the anchor");
    equal("...and null really removes it", session.doc.offset, null);

    undoEdit(session);
    equal("deleting it is undoable", session.doc.offset, [0, 0, 0]);
    undoEdit(session);
    equal("...as is moving it", session.doc.offset, [-2, 0, -2]);
    undoEdit(session);
    equal("...and creating it", session.doc.offset, null);
    closeDocument();
  }

  {
    // The anchor and the NBT panel are two views of one tag, so the text has to
    // show what the verb just wrote.
    const session = withSign();
    setWorldEditAnchor(session.doc, session.history, [2, 0, 2], "Set the anchor");
    const read = schematicNbtText(session.doc);
    check("the NBT panel shows the anchor the verb set", read.text.includes("Offset: [I; -2, 0, -2]"), read.text);

    setWorldEditAnchor(session.doc, session.history, null, "Delete the anchor");
    check(
      "...and shows no Offset tag at all once it is gone",
      !schematicNbtText(session.doc).text.includes("Offset"),
    );
    closeDocument();
  }

  {
    // Optional means the text can create one too: typing the tag in is the same
    // act as pressing Create, and deleting it is the same act as Delete.
    const session = withSign();
    session.doc.offset = null;
    const read = schematicNbtText(session.doc);
    applyNbt(
      session.doc,
      session.history,
      read.text.replace("Version: 3,", "Version: 3,\n  Offset: [I; -2, 0, -2],"),
      read.revision,
      "Edit the NBT",
    );
    equal("writing the Offset tag by hand creates the anchor", session.doc.offset, [-2, 0, -2]);

    const withAnchor = schematicNbtText(session.doc);
    applyNbt(
      session.doc,
      session.history,
      withAnchor.text.replace(/\n\s*Offset: \[I; -2, 0, -2\],/, ""),
      withAnchor.revision,
      "Edit the NBT",
    );
    equal("...and deleting it removes it", session.doc.offset, null);
    closeDocument();
  }

  {
    // The Origin's own verb: three fields and a way back to "not set".
    const session = withSign();
    setWorldOrigin(session.doc, session.history, [10, 20, 30], "Set the origin");
    equal("the origin verb writes it", session.doc.worldOrigin, [10, 20, 30]);
    setWorldOrigin(session.doc, session.history, null, "Clear the origin");
    equal("...and null removes it, which is not zero", session.doc.worldOrigin, null);
    undoEdit(session);
    equal("...undoably", session.doc.worldOrigin, [10, 20, 30]);
    closeDocument();
  }
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

/*
 * Moving a region: not cut-then-paste through the clipboard.
 *
 * That would throw away whatever the user had copied, and two transactions
 * mean a move interrupted between them leaves a hole where the build used to
 * be.
 */
console.log("\n--- moving a region ---");
{
  const session = newDocument({ width: 8, height: 4, length: 8 });
  const rock = { namespacedName: "minecraft:stone", properties: {} };
  const pane = { namespacedName: "minecraft:glass", properties: {} };
  setBlock(session.doc, 1, 0, 1, rock);
  setBlock(session.doc, 2, 0, 1, pane);
  // Something standing where the move is going, to be overwritten.
  setBlock(session.doc, 5, 0, 5, rock);
  copySelection(session, { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 });
  const clipboardBefore = currentClipboard();
  session.history.undoStack.length = 0;

  moveRegion(
    session,
    { minX: 1, minY: 0, minZ: 1, maxX: 2, maxY: 0, maxZ: 1 },
    { x: 5, y: 0, z: 5 },
  );

  equal("the blocks arrive", getBlock(session.doc, 5, 0, 5).namespacedName, "minecraft:stone");
  equal("...in order", getBlock(session.doc, 6, 0, 5).namespacedName, "minecraft:glass");
  equal(
    "...and the ground they came from is empty",
    getBlock(session.doc, 1, 0, 1).namespacedName,
    "minecraft:air",
  );
  equal("a move is one undo step", session.history.undoStack.length, 1);

  undoEdit(session);
  equal(
    "...so one undo puts it all back",
    getBlock(session.doc, 1, 0, 1).namespacedName,
    "minecraft:stone",
  );
  equal(
    "...including what it landed on",
    getBlock(session.doc, 6, 0, 5).namespacedName,
    "minecraft:air",
  );

  // The clipboard belongs to the user; moving something is not copying it.
  equal("the clipboard is untouched", currentClipboard(), clipboardBefore);

  /*
   * Overlap is the case that decides whether the snapshot is taken before
   * anything is written. Sliding a region one block along its own axis has to
   * carry it, not smear it.
   */
  const overlap = newDocument({ width: 8, height: 4, length: 8 });
  setBlock(overlap.doc, 1, 0, 0, rock);
  setBlock(overlap.doc, 2, 0, 0, pane);
  moveRegion(
    overlap,
    { minX: 1, minY: 0, minZ: 0, maxX: 2, maxY: 0, maxZ: 0 },
    { x: 2, y: 0, z: 0 },
  );
  equal(
    "a region slid onto itself carries its far end",
    getBlock(overlap.doc, 3, 0, 0).namespacedName,
    "minecraft:glass",
  );
  equal("...and its near end", getBlock(overlap.doc, 2, 0, 0).namespacedName, "minecraft:stone");
  equal(
    "...leaving only the cell it vacated",
    getBlock(overlap.doc, 1, 0, 0).namespacedName,
    "minecraft:air",
  );

  /*
   * And the air travels with it. Without that, moving a hollow room three
   * blocks along keeps whatever was standing inside the box it landed on.
   */
  const hollow = newDocument({ width: 8, height: 4, length: 8 });
  setBlock(hollow.doc, 0, 0, 0, rock);
  // Under the *air* half of the region, which is the only cell that can tell
  // a move from a stamp: the solid half overwrites whatever it lands on either
  // way, so a check there would pass against both.
  setBlock(hollow.doc, 5, 0, 0, pane);
  moveRegion(
    hollow,
    { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 0 },
    { x: 4, y: 0, z: 0 },
  );
  equal(
    "a moved region's air erases what it lands on",
    getBlock(hollow.doc, 5, 0, 0).namespacedName,
    "minecraft:air",
  );
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

// --- a fill outside the box grows the box ---------------------------------
console.log("\n--- growing to reach a region ---");
{
  const stone = { namespacedName: "minecraft:stone", properties: {} };

  // Outwards, on the high side: the document simply gets bigger.
  {
    const session = newDocument({ width: 8, height: 8, length: 8 });
    const changed = applyEdit(session, {
      kind: "fill",
      region: { minX: 6, minY: 0, minZ: 0, maxX: 11, maxY: 1, maxZ: 1 },
      block: stone,
    });
    equal("the fill writes every cell it asked for", changed, 6 * 2 * 2);
    equal("...and the document grew to hold them", documentState(session).size, [12, 8, 8]);
    equal(
      "the far corner is where it was asked for",
      getBlock(session.doc, 11, 1, 1)?.namespacedName,
      "minecraft:stone",
    );

    // Growing and filling are one gesture, so they are one undo step.
    undoEdit(session);
    equal("one undo puts the size back", documentState(session).size, [8, 8, 8]);
    equal("...and takes the blocks with it", documentState(session).blockCount, 0);
    closeDocument();
  }

  /*
   * Downwards, which is the case with a sign in it. There is no index -1, so
   * reaching below the origin moves the *content* up and grows the box; the
   * blocks already in the document must come along rather than staying at the
   * coordinates they had.
   */
  {
    const session = newDocument({ width: 8, height: 8, length: 8 });
    applyEdit(session, { kind: "setBlock", x: 0, y: 0, z: 0, block: stone });
    applyEdit(session, {
      kind: "fill",
      region: { minX: -3, minY: 0, minZ: 0, maxX: -1, maxY: 0, maxZ: 0 },
      block: stone,
    });
    equal("reaching below zero grows the box", documentState(session).size, [11, 8, 8]);
    equal(
      "the block that was at the origin moved with the content",
      getBlock(session.doc, 3, 0, 0)?.namespacedName,
      "minecraft:stone",
    );
    equal(
      "...and the new blocks are where the region pointed",
      getBlock(session.doc, 0, 0, 0)?.namespacedName,
      "minecraft:stone",
    );
    equal("nothing was lost or invented", documentState(session).blockCount, 4);
    closeDocument();
  }

  // Replace deliberately does not grow: there are no blocks outside the box to
  // rewrite, so growing would add air and then replace nothing in it.
  {
    const session = newDocument({ width: 8, height: 8, length: 8 });
    applyEdit(session, {
      kind: "fill",
      region: { minX: 0, minY: 0, minZ: 0, maxX: 7, maxY: 0, maxZ: 0 },
      block: stone,
    });
    applyEdit(session, {
      kind: "replace",
      region: { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 0, maxZ: 0 },
      from: stone,
      to: { namespacedName: "minecraft:oak_planks", properties: {} },
    });
    equal("a replace past the edge leaves the size alone", documentState(session).size, [8, 8, 8]);
    equal(
      "...and still rewrites what is there",
      getBlock(session.doc, 7, 0, 0)?.namespacedName,
      "minecraft:oak_planks",
    );
    closeDocument();
  }

  // The one limit left is the one that stops the process dying, and it says so.
  {
    const session = newDocument({ width: 8, height: 8, length: 8 });
    let raised: unknown = null;
    try {
      applyEdit(session, {
        kind: "fill",
        region: { minX: 0, minY: 0, minZ: 0, maxX: 4000, maxY: 4000, maxZ: 4000 },
        block: stone,
      });
    } catch (err) {
      raised = err;
    }
    check(
      "an impossible footprint is refused rather than attempted",
      raised instanceof DocumentTooLargeError || raised instanceof EditTooLargeError,
      raised instanceof Error ? raised.name : String(raised),
    );
    equal("...leaving the document as it was", documentState(session).size, [8, 8, 8]);
    closeDocument();
  }
}

// --- saving trims the air the editor left behind --------------------------
console.log("\n--- crop on save ---");
{
  const session = newDocument({ width: 24, height: 24, length: 24 });
  applyEdit(session, {
    kind: "fill",
    region: { minX: 8, minY: 3, minZ: 5, maxX: 11, maxY: 4, maxZ: 9 },
    block: { namespacedName: "minecraft:stone", properties: {} },
  });

  const target = path.join(workDir, "trimmed.schem");
  const saved = await saveSession(session, { filePath: target, format: "sponge3" });

  equal("the save reports the trim", saved.cropped, { from: [24, 24, 24], to: [4, 2, 5] });

  const reloaded = documentFromLoaded(await loadStructure(saved.filePath), saved.filePath);
  equal(
    "the file on disk is the trimmed box",
    [reloaded.width, reloaded.height, reloaded.length],
    [4, 2, 5],
  );
  equal("...with every block still in it", countBlocks(reloaded), 4 * 2 * 5);

  /*
   * The reason the crop copies instead of resizing in place. A block delta is
   * an index into a voxel array of a particular shape; re-dimensioning the live
   * document would leave every entry on the undo stack pointing at a cell that
   * is no longer the one it described. Saving must not cost the user their
   * history.
   */
  const state = documentState(session);
  equal("the open document keeps its size", state.size, [24, 24, 24]);
  check("...and its undo stack", state.canUndo);
  undoEdit(session);
  equal("...which still undoes the right thing", documentState(session).blockCount, 0);

  // A second save with nothing left to trim says so rather than inventing a box.
  const empty = await saveSession(session, { filePath: target, format: "sponge3" });
  equal("an all-air document reports no trim", empty.cropped, null);

  closeDocument();
}

// --- going back to how it was ---------------------------------------------
console.log("\n--- checkpoints ---");
{
  const dir = path.join(workDir, "checkpoints");
  useCheckpointDirectory(dir);
  forgetCheckpointMemo();

  const stone = { namespacedName: "minecraft:stone", properties: {} };
  const session = newDocument({ width: 24, height: 24, length: 24 });

  // A build in a deliberately roomy volume, which is the case the crop rule
  // exists for and the case a checkpoint must *not* apply it to.
  applyEdit(session, {
    kind: "fill",
    region: { minX: 2, minY: 0, minZ: 2, maxX: 5, maxY: 1, maxZ: 5 },
    block: stone,
  });

  const before = await takeCheckpoint(session, [{ role: "user", content: "the first turn" }]);
  check("a checkpoint was written", before !== null, String(before));

  /*
   * Keyed on `doc.revision`, so an unchanged document reuses the file rather
   * than writing an identical one. This is what makes a failed turn free: a run
   * that rolls back leaves the revision where it started.
   */
  equal(
    "an unchanged document reuses its snapshot",
    await takeCheckpoint(session, []),
    before,
  );

  // Now change it, and go back.
  applyEdit(session, {
    kind: "fill",
    region: { minX: 10, minY: 0, minZ: 10, maxX: 20, maxY: 5, maxZ: 20 },
    block: stone,
  });
  const grown = documentState(session).blockCount;
  check("the second edit landed", grown > 4 * 2 * 4, String(grown));
  check("...and produced a new snapshot", (await takeCheckpoint(session, [])) !== before);

  const restored = await readCheckpoint(before!, null);
  check("the snapshot reads back", restored !== null);
  equal(
    "the working box is intact, not cropped to the build",
    [restored!.session.doc.width, restored!.session.doc.height, restored!.session.doc.length],
    [24, 24, 24],
  );
  equal("...with the blocks that were there", countBlocks(restored!.session.doc), 4 * 2 * 4);
  equal(
    "...and the model's memory of that moment",
    JSON.stringify(restored!.messages).includes("the first turn"),
    true,
  );

  /*
   * The restored document differs from what is on disk and no sequence of undos
   * can prove otherwise -- the same arrangement the crash-recovery path uses.
   * A restore that came back looking "saved" would let the user close the app
   * and lose the thing they had just gone back to.
   */
  check("a restored document is not clean", isDirty(restored!.session.history));

  equal("a snapshot that never existed reads as nothing", await readCheckpoint("k-nope", null), null);
  check("...and reports itself missing", !(await checkpointExists("k-nope")));
  check("a real one reports itself present", await checkpointExists(before!));

  await removeCheckpoints([before!]);
  check("...and is gone once removed", !(await checkpointExists(before!)));

  closeDocument();
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
