/**
 * `services/session.ts` — the open document, as the IPC handlers drive it.
 *
 * The handlers themselves need Electron, so this exercises the layer under
 * them: the same calls in the same order, checking the things a thin handler
 * cannot get wrong on its own — that an edit is one undo step, that saving in a
 * new format sticks, that a mesh is not handed out stale, and that a request
 * with nothing open is refused rather than crashing the main process.
 */

import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

import { documentSize, getBlock, setBlock, setBlockEntity } from "../src/main/domain/document.js";
import { DOCUMENT_SIZE } from "../src/shared/settings.js";
import {
  DEFAULT_LEGACY_VERSION,
  dataVersionOf,
  documentEra,
  documentVersionName,
} from "../src/shared/mc_versions.js";
import type { SchematicFormat } from "../src/shared/schematic.js";
import { legacyBlockNames } from "../src/main/services/writers.js";
import { loadLegacyBlockTable } from "../src/main/pipeline/loader_formats.js";
import {
  applyEdit,
  setDocumentVersion,
  type VersionChangeResult,
  UnknownVersionError,
  VersionRefusedError,
  VersionWouldLoseBlocksError,
  BlockNotInVersionError,
  setSessionVoidBlock,
  OutsideDocumentError,
  ResizeWouldLoseBlocksError,
  resizeSession,
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
  scaleRegion,
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
import { isDirty, undo } from "../src/main/domain/history.js";
import { anchorOf, countBlocks, createDocument, documentFromLoaded } from "../src/main/domain/document.js";
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

// --- the right button opens what it lands on ------------------------------
//
// In the game, right-clicking a door swings it and you have to sneak to place
// a block against it. Here the right button always placed, so the only way to
// open a door in a schematic was the inspector -- twice, once per half.
//
// `use` is one verb because only this side can tell the two apart. The renderer
// holds no schematic, so it cannot know whether the cell under the crosshair is
// a door; asking first would be a round trip per click.
console.log("\n--- the right button opens what it lands on ---");
{
  const door = (half: string, open: string) => ({
    namespacedName: "minecraft:oak_door",
    properties: { facing: "north", half, hinge: "left", open, powered: "false" },
  });
  const withDoor = (): DocumentSession => {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    setBlock(session.doc, 1, 0, 1, door("lower", "false"));
    setBlock(session.doc, 1, 1, 1, door("upper", "false"));
    return session;
  };
  const openAt = (session: DocumentSession, y: number) => getBlock(session.doc, 1, y, 1).properties.open;

  /*
   * Clicking the **lower** half. The click lands in the empty cell in front of
   * it, and `against` is the face that was hit -- so the door is one step back
   * along that face, which is the arithmetic the slab merge already does.
   */
  {
    const session = withDoor();
    const changed = applyEdit(session, {
      kind: "use",
      x: 1,
      y: 0,
      z: 0,
      block: { namespacedName: "minecraft:stone", properties: {} },
      against: "north",
    });
    equal("opening a door writes both halves", changed, 2);
    equal("...the one that was clicked", openAt(session, 0), "true");
    equal("...and the one above it", openAt(session, 1), "true");
    /*
     * One transaction, or Ctrl+Z would take a door back a half at a time --
     * and half an open door is a shape the game cannot hold. The same rule the
     * placement of a door already keeps, arrived at from the other end.
     */
    undoEdit(session);
    equal("one undo closes both", `${openAt(session, 0)} ${openAt(session, 1)}`, "false false");
  }

  /*
   * ...and the **upper** half, which is the one a person reaches first when the
   * door is at eye level. It works because the far cell comes from `TWO_PART`
   * rather than from a hard-coded step: the table already knows which way the
   * second half lies, and reading it is what makes this direction free.
   */
  {
    const session = withDoor();
    applyEdit(session, {
      kind: "use",
      x: 1,
      y: 1,
      z: 0,
      block: { namespacedName: "minecraft:stone", properties: {} },
      against: "north",
    });
    equal("clicking the top opens the bottom too", `${openAt(session, 0)} ${openAt(session, 1)}`, "true true");
  }

  // An open door closes. The state is toggled from what is there, not set.
  {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    setBlock(session.doc, 1, 0, 1, door("lower", "true"));
    setBlock(session.doc, 1, 1, 1, door("upper", "true"));
    applyEdit(session, {
      kind: "use",
      x: 1,
      y: 0,
      z: 0,
      block: { namespacedName: "minecraft:stone", properties: {} },
      against: "north",
    });
    equal("an open door closes", `${openAt(session, 0)} ${openAt(session, 1)}`, "false false");
  }

  /*
   * A trapdoor is one block and must not drag its neighbour with it. The check
   * is the block *above* rather than the trapdoor itself: a rule that reached
   * for a second cell by height alone would open whatever happened to be there.
   */
  {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    setBlock(session.doc, 1, 0, 1, {
      namespacedName: "minecraft:oak_trapdoor",
      properties: { facing: "north", half: "bottom", open: "false", powered: "false" },
    });
    setBlock(session.doc, 1, 1, 1, {
      namespacedName: "minecraft:oak_trapdoor",
      properties: { facing: "north", half: "bottom", open: "false", powered: "false" },
    });
    const changed = applyEdit(session, {
      kind: "use",
      x: 1,
      y: 0,
      z: 0,
      block: { namespacedName: "minecraft:stone", properties: {} },
      against: "north",
    });
    equal("a trapdoor opens alone", changed, 1);
    equal(
      "...leaving the one above it shut",
      getBlock(session.doc, 1, 1, 1).properties.open,
      "false",
    );
  }

  /*
   * Everything that does not open is a placement, and it is the **same**
   * placement -- the verb falls through by rewriting itself rather than by
   * copying the placement path, so the slab merge, the two-part rule, the
   * flooding and the growth all still apply. A second path here is how one of
   * those comes to be missing from the commonest gesture in the app.
   */
  {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    setBlock(session.doc, 1, 0, 1, { namespacedName: "minecraft:oak_slab", properties: { type: "bottom" } });
    applyEdit(session, {
      kind: "use",
      x: 1,
      y: 1,
      z: 1,
      block: { namespacedName: "minecraft:oak_slab", properties: { type: "top" } },
      against: "up",
    });
    equal(
      "a right-click on a slab still merges it",
      getBlock(session.doc, 1, 0, 1).properties.type,
      "double",
    );
  }

  // No `against` is a click on the build grid: there is no block to open.
  {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    applyEdit(session, {
      kind: "use",
      x: 2,
      y: 0,
      z: 2,
      block: { namespacedName: "minecraft:stone", properties: {} },
    });
    equal(
      "with nothing to open, it places",
      getBlock(session.doc, 2, 0, 2).namespacedName,
      "minecraft:stone",
    );
  }

  /*
   * A barrel carries `open`, and it is not a door: the property reflects a
   * container being looked into. Toggling it would write a state that means
   * nothing here and draws nothing, so the registry rule excludes it by name
   * and the click places, as it did before.
   */
  {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    setBlock(session.doc, 1, 0, 1, {
      namespacedName: "minecraft:barrel",
      properties: { facing: "up", open: "false" },
    });
    applyEdit(session, {
      kind: "use",
      x: 1,
      y: 0,
      z: 0,
      block: { namespacedName: "minecraft:stone", properties: {} },
      against: "north",
    });
    equal("a barrel is not opened", getBlock(session.doc, 1, 0, 1).properties.open, "false");
    equal(
      "...the block is placed in front of it instead",
      getBlock(session.doc, 1, 0, 0).namespacedName,
      "minecraft:stone",
    );
  }
}

// --- two slabs are one block ------------------------------------------------
//
// In the game a slab placed against the top of a matching bottom slab does not
// go in the cell above -- it fills the one already there, and the pair becomes a
// single full block. The editor stacked them instead, which is a shape the game
// cannot hold: the file pastes back looking nothing like it did here.
console.log("\n--- two slabs are one block ---");
{
  const session = newDocument({ width: 4, height: 4, length: 4 });
  const slab = (type: string) => ({
    namespacedName: "minecraft:oak_slab",
    properties: { type },
  });
  const at = (y: number) => getBlock(session.doc, 1, y, 1);

  applyEdit(session, { kind: "setBlock", x: 1, y: 0, z: 1, block: slab("bottom") });
  // Clicking the top of that slab targets the cell above, and `against: "up"`
  // is the only thing that lets main find the slab that was clicked -- the
  // renderer holds no schematic and the mesh has no per-block identity.
  const changed = applyEdit(session, {
    kind: "setBlock",
    x: 1,
    y: 1,
    z: 1,
    block: slab("top"),
    against: "up",
  });
  equal("the second slab merges into the first", at(0).properties.type, "double");
  equal("...leaving the cell above empty", at(1).namespacedName, "minecraft:air");
  equal("...and reporting the one block it changed", changed, 1);

  // Same material only: an oak slab does not merge into a stone one.
  applyEdit(session, { kind: "setBlock", x: 2, y: 0, z: 1, block: slab("bottom") });
  applyEdit(session, {
    kind: "setBlock",
    x: 2,
    y: 1,
    z: 1,
    block: { namespacedName: "minecraft:stone_slab", properties: { type: "top" } },
    against: "up",
  });
  equal(
    "a different material stacks instead",
    getBlock(session.doc, 2, 0, 1).properties.type,
    "bottom",
  );
  equal("...in its own cell", getBlock(session.doc, 2, 1, 1).namespacedName, "minecraft:stone_slab");

  // Two bottom slabs are not a full block and never become one.
  applyEdit(session, { kind: "setBlock", x: 3, y: 0, z: 1, block: slab("bottom") });
  applyEdit(session, {
    kind: "setBlock",
    x: 3,
    y: 1,
    z: 1,
    block: slab("bottom"),
    against: "up",
  });
  equal("two bottom slabs do not merge", getBlock(session.doc, 3, 0, 1).properties.type, "bottom");
  equal("...they stack", getBlock(session.doc, 3, 1, 1).properties.type, "bottom");

  // A fill carries no `against`, which is what keeps this a click gesture: a
  // region filled with slabs is a region of slabs, not half as many doubles.
  const filled = newDocument({ width: 2, height: 4, length: 2 });
  applyEdit(filled, {
    kind: "fill",
    region: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 1, maxZ: 0 },
    block: slab("bottom"),
  });
  equal("a fill never merges", getBlock(filled.doc, 0, 0, 0).properties.type, "bottom");
  equal("...at either level", getBlock(filled.doc, 0, 1, 0).properties.type, "bottom");
}

// --- connecting to the neighbours -------------------------------------------
//
// The rules themselves are tests/blocks.ts's. This is the pass: which cells get
// asked, that it runs from every write rather than from one of them, and that a
// correction lands in the same undo step as the edit that caused it.
console.log("\n--- connecting to the neighbours ---");
{
  const fence = (properties: Record<string, string> = {}) => ({
    namespacedName: "minecraft:oak_fence",
    properties: { north: "false", east: "false", south: "false", west: "false", ...properties },
  });
  const session = newDocument({ width: 5, height: 2, length: 5 });
  const at = (x: number, z: number) => getBlock(session.doc, x, 0, z);

  applyEdit(session, { kind: "setBlock", x: 1, y: 0, z: 1, block: fence() });
  equal("a lone fence connects to nothing", at(1, 1).properties.north, "false");

  /*
   * The half that a rule applied at the click could not do: placing the second
   * fence has to reach *back* and connect the first, or a run of fence is a row
   * of posts each attached only to what came after it.
   */
  applyEdit(session, { kind: "setBlock", x: 1, y: 0, z: 2, block: fence() });
  equal("placing a second fence connects the new one", at(1, 2).properties.north, "true");
  equal("...and reaches back to connect the first", at(1, 1).properties.south, "true");

  // One transaction. The correction to the neighbour is part of the placement,
  // not a second step somebody has to undo separately.
  const before = session.history.undoStack.length;
  applyEdit(session, { kind: "setBlock", x: 1, y: 0, z: 3, block: fence() });
  equal("a placement and its corrections are one undo step", session.history.undoStack.length, before + 1);
  undoEdit(session);
  equal("...so one undo removes the block", at(1, 3).namespacedName, "minecraft:air");
  equal("...and the connection it caused", at(1, 2).properties.south, "false");

  // Breaking is a write like any other, so what is left behind lets go.
  applyEdit(session, {
    kind: "setBlock",
    x: 1,
    y: 0,
    z: 2,
    block: { namespacedName: "minecraft:air" },
  });
  equal("breaking a fence disconnects its neighbour", at(1, 1).properties.south, "false");

  /*
   * A fill is the other door into the same room, and the one the rule would
   * have been missing from if it lived in applyEdit's setBlock arm. Asking the
   * chat or the agent to build a fence goes through here too.
   */
  const filled = newDocument({ width: 6, height: 2, length: 6 });
  applyEdit(filled, {
    kind: "fill",
    region: { minX: 0, minY: 0, minZ: 2, maxX: 4, maxY: 0, maxZ: 2 },
    block: fence(),
  });
  const line = (x: number) => getBlock(filled.doc, x, 0, 2).properties;
  equal("a filled line of fence connects along itself", [line(1).east, line(1).west], ["true", "true"]);
  equal("...and the end knows it is an end", [line(0).west, line(0).east], ["false", "true"]);

  // A wall is the family whose connections are none|low|tall rather than
  // booleans -- the 1.16 type change that reads as a value change.
  const walls = newDocument({ width: 5, height: 2, length: 5 });
  const wall = {
    namespacedName: "minecraft:cobblestone_wall",
    properties: { north: "none", east: "none", south: "none", west: "none", up: "true" },
  };
  applyEdit(walls, {
    kind: "fill",
    region: { minX: 1, minY: 0, minZ: 1, maxX: 3, maxY: 0, maxZ: 1 },
    block: wall,
  });
  const middle = getBlock(walls.doc, 2, 0, 1).properties;
  equal("a wall in a run connects both ways", [middle.east, middle.west], ["low", "low"]);
  equal("...and drops its post", middle.up, "false");

  /*
   * The exception that makes "editable afterwards" true.
   *
   * The inspector sends `setState`, which derives nothing. Sent as an ordinary
   * `setBlock` the typed value would be overwritten inside the same transaction
   * that carried it, and the panel would appear to ignore what was typed.
   */
  const typed = at(1, 1).properties;
  applyEdit(session, {
    kind: "setState",
    x: 1,
    y: 0,
    z: 1,
    block: { namespacedName: "minecraft:oak_fence", properties: { ...typed, north: "true" } },
  });
  equal("a hand-typed state is not re-derived", at(1, 1).properties.north, "true");

  // ...until something is placed next to it, which is what the game does.
  applyEdit(session, { kind: "setBlock", x: 1, y: 0, z: 2, block: fence() });
  equal("...but a placement beside it takes it back", at(1, 1).properties.north, "false");
}

console.log("\n--- mirroring a region ---");
{
  /*
   * The corner is real geometry, and has to be.
   *
   * This used to be one staircase carrying `shape: inner_left` with nothing
   * around it -- a state the game never produces, and one the derivation pass
   * now normalises to `straight` on any edit, exactly as a neighbour update in
   * the game would. So the fixture builds the corner it is claiming: a stair
   * facing east whose *back* neighbour faces north is an inner-left corner, and
   * mirroring the pair is what turns it into an inner-right one.
   *
   * The claim under test is unchanged -- a reflection changes a corner's hand --
   * it is now made against an arrangement that can exist.
   */
  const session = newDocument({ width: 4, height: 1, length: 4 });
  setBlock(session.doc, 1, 0, 1, {
    namespacedName: "minecraft:oak_stairs",
    properties: { facing: "east", shape: "inner_left" },
  });
  setBlock(session.doc, 0, 0, 1, {
    namespacedName: "minecraft:oak_stairs",
    properties: { facing: "north", shape: "straight" },
  });
  setBlock(session.doc, 1, 0, 0, {
    namespacedName: "minecraft:oak_door",
    properties: { facing: "north", hinge: "left" },
  });
  session.history.undoStack.length = 0;

  const whole = { minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3 };
  const at = (x: number, z: number) => getBlock(session.doc, x, 0, z);

  transformRegion(session, whole, { kind: "mirror", axis: "x" });
  equal("the block reflected across x", at(2, 1).namespacedName, "minecraft:oak_stairs");
  equal("...and east became west", at(2, 1).properties.facing, "west");
  // A reflection is what turns a left-hand staircase into a right-hand one.
  equal("...and the corner changed hand", at(2, 1).properties.shape, "inner_right");
  equal("a door's hinge changed hand too", at(2, 0).properties.hinge, "right");
  equal("...while a north-facing door still faces north", at(2, 0).properties.facing, "north");

  // A mirror is its own inverse, which is the cheapest check there is.
  const mirrored = at(2, 1).properties.facing;
  transformRegion(session, whole, { kind: "mirror", axis: "x" });
  equal("mirroring twice restores the facing", at(1, 1).properties.facing, "east");
  equal("...and the shape", at(1, 1).properties.shape, "inner_left");
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
console.log("\n--- a region edit stays inside the schematic ---");
{
  /*
   * `autoGrow` reached `applyEdit` and nothing else, so a move that carried
   * blocks past the edge lost them without a word: `pasteClipboard` clips by
   * letting `tx.setBlock` return false, and `changed` came back short with
   * nothing anywhere saying why. Turning and scaling had the same hole.
   */
  const session = newDocument({ width: 8, height: 4, length: 8 });
  const rock = { namespacedName: "minecraft:stone", properties: {} };
  const wood = { namespacedName: "minecraft:oak_planks", properties: {} };
  setBlock(session.doc, 0, 0, 0, rock);
  setBlock(session.doc, 1, 0, 0, rock);
  session.history.undoStack.length = 0;

  moveRegion(
    session,
    { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 0 },
    { x: 7, y: 0, z: 0 },
    { autoGrow: true },
  );
  equal("a move past the edge grows the schematic", documentState(session).size, [9, 4, 8]);
  equal(
    "...and carries the block that would have fallen off",
    getBlock(session.doc, 8, 0, 0).namespacedName,
    "minecraft:stone",
  );
  equal("...in one undo step", session.history.undoStack.length, 1);
  undoEdit(session);
  equal("...which takes the size back too", documentState(session).size, [8, 4, 8]);
  equal(
    "...and the blocks with it",
    getBlock(session.doc, 0, 0, 0).namespacedName,
    "minecraft:stone",
  );

  let raised: unknown = null;
  try {
    moveRegion(
      session,
      { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 0 },
      { x: 7, y: 0, z: 0 },
      { autoGrow: false },
    );
  } catch (err) {
    raised = err;
  }
  check("with resizing off it is refused by name", raised instanceof OutsideDocumentError);
  /*
   * The half that matters: nothing was written, not even the block that fitted.
   * A refusal that had already moved half the region would be worse than the
   * silent clipping it replaces.
   */
  equal(
    "...and nothing moved, not even the part that fitted",
    getBlock(session.doc, 0, 0, 0).namespacedName,
    "minecraft:stone",
  );
  equal("...and no step was pushed", session.history.undoStack.length, 0);
  closeDocument();
}

// --- and a paste is a region edit too -----------------------------------------
//
// The same hole, one verb further on, and the stamp is what made it a daily
// gesture: Ctrl+C now leaves a ghost that is carried somewhere else *before*
// Ctrl+V, so landing past the edge stopped being a thing you had to go out of
// your way to do. `pasteClipboard` clips by letting `tx.setBlock` return
// false, so the overhang used to vanish with a short count and no sentence.
console.log("\n--- a paste stays inside the schematic ---");
{
  const session = newDocument({ width: 8, height: 4, length: 8 });
  const rock = { namespacedName: "minecraft:stone", properties: {} };
  setBlock(session.doc, 0, 0, 0, rock);
  setBlock(session.doc, 1, 0, 0, rock);
  copySelection(session, { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 0 });
  session.history.undoStack.length = 0;

  pasteSelection(session, { x: 7, y: 0, z: 0 }, { autoGrow: true });
  equal("a paste past the edge grows the schematic", documentState(session).size, [9, 4, 8]);
  equal(
    "...and the overhanging block lands",
    getBlock(session.doc, 8, 0, 0).namespacedName,
    "minecraft:stone",
  );
  equal("...in one undo step", session.history.undoStack.length, 1);
  undoEdit(session);
  equal("...which takes the size back too", documentState(session).size, [8, 4, 8]);

  let refused: unknown = null;
  try {
    pasteSelection(session, { x: 7, y: 0, z: 0 }, { autoGrow: false });
  } catch (err) {
    refused = err;
  }
  check("with resizing off it is refused by name", refused instanceof OutsideDocumentError);
  // Nothing written, not even the half that fitted -- `moveRegion`'s rule.
  equal(
    "...and not even the part that fitted was written",
    getBlock(session.doc, 7, 0, 0).namespacedName,
    "minecraft:air",
  );
  equal("...and no step was pushed", session.history.undoStack.length, 0);
  closeDocument();
}

console.log("\n--- turning a region somewhere else ---");
{
  /*
   * In place, a quarter turn has to land back on its own footprint, so an
   * oblong one cannot -- that is `NotSquareError`, and it is right. With a
   * destination the same turn is simply a box of the other shape, which is what
   * lets the gizmo turn a selection about a corner rather than about its middle.
   */
  const session = newDocument({ width: 8, height: 4, length: 8 });
  const rock = { namespacedName: "minecraft:stone", properties: {} };
  const wood = { namespacedName: "minecraft:oak_planks", properties: {} };
  setBlock(session.doc, 0, 0, 0, rock);
  setBlock(session.doc, 4, 0, 0, wood);
  const oblong = { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 0, maxZ: 2 };

  let raised: unknown = null;
  try {
    transformRegion(session, oblong, { kind: "rotate", steps: 1 });
  } catch (err) {
    raised = err;
  }
  check("an oblong turned in place is still refused", raised instanceof NotSquareError);

  session.history.undoStack.length = 0;
  transformRegion(session, oblong, { kind: "rotate", steps: 1 }, { to: { x: 0, y: 0, z: 0 } });
  equal(
    "...and goes through when it is told where to land",
    getBlock(session.doc, 2, 0, 0).namespacedName,
    "minecraft:stone",
  );
  equal(
    "...with the far end a quarter turn round",
    getBlock(session.doc, 2, 0, 4).namespacedName,
    "minecraft:oak_planks",
  );
  equal("a turn is one undo step", session.history.undoStack.length, 1);
  undoEdit(session);
  equal(
    "...and one undo puts the row back",
    getBlock(session.doc, 4, 0, 0).namespacedName,
    "minecraft:oak_planks",
  );
  closeDocument();
}

console.log("\n--- flipping a region over ---");
{
  /*
   * The vertical mirror, which is a different set of properties from the other
   * two rather than the same rule with a letter changed. Stated one block at a
   * time, because a failure has to name which family was forgotten -- and
   * `face` and `attachment` are the two that get forgotten.
   */
  const session = newDocument({ width: 4, height: 4, length: 4 });
  const rock = { namespacedName: "minecraft:stone", properties: {} };
  const wood = { namespacedName: "minecraft:oak_planks", properties: {} };
  const put = (y: number, name: string, properties: Record<string, string>) =>
    setBlock(session.doc, 0, y, 0, { namespacedName: name, properties });

  put(0, "minecraft:oak_stairs", { facing: "north", half: "bottom" });
  put(1, "minecraft:oak_door", { facing: "north", half: "upper", hinge: "left" });
  put(2, "minecraft:stone_slab", { type: "top" });
  put(3, "minecraft:lever", { face: "floor", facing: "north" });

  transformRegion(session, { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 3, maxZ: 0 }, {
    kind: "mirror",
    axis: "y",
  });

  // The column is turned over, so what was at y=0 is now at y=3.
  equal("a stair's half turns over", getBlock(session.doc, 0, 3, 0).properties.half, "top");
  equal(
    "...and its facing does not",
    getBlock(session.doc, 0, 3, 0).properties.facing,
    "north",
  );
  equal("a door's upper half becomes its lower", getBlock(session.doc, 0, 2, 0).properties.half, "lower");
  equal(
    "...and a reflection swaps its hinge",
    getBlock(session.doc, 0, 2, 0).properties.hinge,
    "right",
  );
  equal("a slab's type turns over", getBlock(session.doc, 0, 1, 0).properties.type, "bottom");
  equal(
    "a lever on the floor ends up on the ceiling",
    getBlock(session.doc, 0, 0, 0).properties.face,
    "ceiling",
  );

  /*
   * The one that cannot be reflected, and is therefore left exactly as it was.
   * `ascending_north` upside down would be a rail going *down* to the north,
   * and the game has no such state -- every rail that is not flat ascends. So
   * the value stands rather than being turned into a neighbouring direction:
   * inventing a state is the one thing this file may not do.
   */
  setBlock(session.doc, 1, 0, 0, {
    namespacedName: "minecraft:rail",
    properties: { shape: "ascending_north" },
  });
  transformRegion(session, { minX: 1, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 0 }, {
    kind: "mirror",
    axis: "y",
  });
  equal(
    "an ascending rail has no reflection, and keeps its own",
    getBlock(session.doc, 1, 0, 0).properties.shape,
    "ascending_north",
  );
  closeDocument();
}

console.log("\n--- resampling a region ---");
{
  const session = newDocument({ width: 8, height: 8, length: 8 });
  const rock = { namespacedName: "minecraft:stone", properties: {} };
  const wood = { namespacedName: "minecraft:oak_planks", properties: {} };
  setBlock(session.doc, 0, 0, 0, rock);
  setBlock(session.doc, 1, 0, 0, wood);
  session.history.undoStack.length = 0;

  const doubled = scaleRegion(
    session,
    { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 0 },
    { kind: "multiply", factor: 2 },
  );
  // Multiplying loses nothing, so it has nothing to say beyond the count.
  equal("doubling throws nothing away", doubled.dropped, 0);
  equal("...and so says nothing", doubled.notes, "");
  equal(
    "doubling makes one block into a cube of itself",
    getBlock(session.doc, 1, 1, 1).namespacedName,
    "minecraft:stone",
  );
  equal(
    "...and the block beside it follows",
    getBlock(session.doc, 2, 0, 0).namespacedName,
    "minecraft:oak_planks",
  );
  equal("a scale is one undo step", session.history.undoStack.length, 1);
  undoEdit(session);
  equal(
    "...and one undo puts the row back",
    getBlock(session.doc, 1, 0, 0).namespacedName,
    "minecraft:oak_planks",
  );

  /*
   * Halving discards seven cells in every eight, and says so rather than
   * refusing.
   *
   * It used to refuse and ask to be called again with `confirmLoss`, which is
   * `resizeSession`'s shape -- and the wrong shape borrowed. A resize is a
   * number typed blind into a panel that has a second button; a scale is a
   * cube dragged with the destination drawn under the pointer and one CTRL+Z
   * away. So the refusal named a confirmation that existed nowhere in the app
   * and the gesture was simply cancelled. Reported as exactly that.
   */
  setBlock(session.doc, 0, 0, 0, rock);
  setBlock(session.doc, 1, 0, 0, rock);
  setBlock(session.doc, 0, 0, 1, rock);
  setBlock(session.doc, 1, 0, 1, rock);
  const half = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
  const halved = scaleRegion(session, half, { kind: "divide", factor: 2 });
  check("halving goes ahead rather than asking", halved.changed > 0, String(halved.changed));
  // Four stone cells in, one out: three thrown away.
  equal("...and counts what it threw away", halved.dropped, 3);
  check(
    "...in a sentence that names the number",
    halved.notes.includes("3"),
    halved.notes,
  );
  check(
    "...and points at the way back",
    halved.notes.includes("CTRL+Z"),
    halved.notes,
  );
  equal(
    "the cell at the low corner is the one that survives",
    getBlock(session.doc, 0, 0, 0).namespacedName,
    "minecraft:stone",
  );
  closeDocument();
}

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

  /*
   * Pasting over an edge makes room for it. This used to write the half that
   * fitted and drop the rest, which is what `pasteClipboard` still does when
   * it is reached -- and it is still what a refusal relies on never reaching.
   * What changed is that `pasteSelection` decides first.
   */
  const changed = pasteSelection(session, { x: 5, y: 0, z: 0 });
  equal("a paste over the edge lands whole", changed, 2);
  equal("...at the edge", getBlock(session.doc, 5, 0, 0).namespacedName, "minecraft:stone");
  equal("...having made room for the rest", session.doc.width, 7);

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

// --- the anchor reaches the file ------------------------------------------
//
// The whole chain the modal drives, end to end: set it, save it, read the file
// back off disk. Everything up to `doc.offset` was covered; nothing checked
// that a save actually carried it, in every format, through the crop that
// happens on the way out.
console.log("\n--- the anchor survives a save ---");
for (const format of ["sponge3", "sponge2", "mcedit"] as const) {
  const session = newDocument({ width: 16, height: 16, length: 16 }, format);
  applyEdit(session, {
    kind: "fill",
    region: { minX: 4, minY: 2, minZ: 4, maxX: 6, maxY: 3, maxZ: 6 },
    block: { namespacedName: "minecraft:stone", properties: {} },
  });
  setWorldEditAnchor(session.doc, session.history, [5, 2, 5], "Set the anchor");

  const target = path.join(workDir, `anchored.${format === "mcedit" ? "schematic" : "schem"}`);
  const saved = await saveSession(session, {
    filePath: target,
    format,
    legacyBlocksPath: LEGACY_BLOCKS,
  });

  const reloaded = documentFromLoaded(
    await loadStructure(saved.filePath, { legacyBlocksPath: LEGACY_BLOCKS }),
    saved.filePath,
  );

  /*
   * The crop is what makes this worth its own check. Saving trims to content,
   * so the corner the anchor is measured from moves from (0,0,0) to (4,2,4) --
   * and the anchor has to move with it or the build pastes off by the padding
   * the user happened to have around it. Cell (5,2,5) in the roomy box is cell
   * (1,0,1) in the trimmed one.
   */
  equal(`${format}: the file was trimmed`, saved.cropped, { from: [16, 16, 16], to: [3, 2, 3] });
  equal(`${format}: the anchor is in the file`, anchorOf(reloaded.offset), [1, 0, 1]);
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

// --- placing a block outside the box --------------------------------------
//
// It could not be done, in either camera mode, and the failure was silent:
// `document.setBlock` refuses an out-of-bounds write by returning `null`, so
// the answer was `changed: 0` and a click that looked like it had missed. In
// flight that is the ordinary way to build outwards -- right-click the outer
// face of an edge block -- while the same act performed by dragging a
// selection and filling it grew the document happily. One editor, two answers.
console.log("\n--- a placed block grows the document ---");
{
  const stone = { namespacedName: "minecraft:stone", properties: {} };
  const session = newDocument({ width: 4, height: 4, length: 4 });
  applyEdit(session, { kind: "setBlock", x: 0, y: 0, z: 0, block: stone });

  // Past the far side: the box extends and nothing already in it moves, so
  // every coordinate the user has been told is still the coordinate they mean.
  const changed = applyEdit(session, { kind: "setBlock", x: 6, y: 0, z: 0, block: stone });
  equal("the block was written", changed, 1);
  equal("...and the document grew to hold it", documentSize(session.doc), [7, 4, 4]);
  equal("...without moving what was there", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:stone");
  equal("...and the new block is where it was asked for", getBlock(session.doc, 6, 0, 0).namespacedName, "minecraft:stone");

  // One undo step, because the resize and the write are one transaction. Two
  // would leave a document that had grown for a block that is no longer in it.
  undoEdit(session);
  equal("undo takes back the size too", documentSize(session.doc), [4, 4, 4]);
  equal("...and the block with it", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:stone");
}

console.log("\n--- ...and below the origin it moves the content up ---");
{
  const stone = { namespacedName: "minecraft:stone", properties: {} };
  const oak = { namespacedName: "minecraft:oak_planks", properties: {} };
  const session = newDocument({ width: 4, height: 4, length: 4 });
  applyEdit(session, { kind: "setBlock", x: 0, y: 0, z: 0, block: stone });

  /*
   * The grid has no negative index, so making room underneath is expressed as
   * moving the content up -- `grow.ts`'s arithmetic, and the answer a fill
   * dragged under the floor has always given. The alternative was refusing,
   * which would have left the two gestures disagreeing about what the editor
   * is.
   */
  applyEdit(session, { kind: "setBlock", x: 0, y: -2, z: 0, block: oak });
  equal("the document grew downwards", documentSize(session.doc), [4, 6, 4]);
  equal("the old content moved up by the shift", getBlock(session.doc, 0, 2, 0).namespacedName, "minecraft:stone");
  equal("...and the new block landed at the new floor", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:oak_planks");

  undoEdit(session);
  equal("undo puts the origin back", documentSize(session.doc), [4, 4, 4]);
  equal("...and the content with it", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:stone");
}

console.log("\n--- breaking never grows ---");
{
  const stone = { namespacedName: "minecraft:stone", properties: {} };
  const air = { namespacedName: "minecraft:air", properties: {} };
  const session = newDocument({ width: 4, height: 4, length: 4 });
  applyEdit(session, { kind: "setBlock", x: 0, y: 0, z: 0, block: stone });

  // Growing to make room for air is a resize and nothing else -- the same
  // reason `replace` does not grow. Nothing sends a break from outside the box
  // today, because a break comes from a pick and the block therefore exists;
  // this is here so that stays true.
  const changed = applyEdit(session, { kind: "setBlock", x: 9, y: 9, z: 9, block: air });
  equal("air outside the box changes nothing", changed, 0);
  equal("...and the document is the size it was", documentSize(session.doc), [4, 4, 4]);
}

// --- the materials list is the whole palette -------------------------------
//
// It was cut to 64 here, silently, while the panel showing it cut to 8 and
// said "…and N more" -- so past 64 distinct states that sentence *understated*
// the palette, which is worse than either cap on its own. A materials list is
// one of the few things worth being complete: it is how the one stray block
// nobody meant to place gets found.
console.log("\n--- every material is reported ---");
{
  const session = newDocument({ width: 16, height: 4, length: 16 });

  // Comfortably past the old cap, and past it in *states* rather than blocks:
  // `oak_log[axis=x]` and `oak_log[axis=y]` are two entries and one material,
  // which is exactly the case that makes a schematic's palette long.
  const wanted = 100;
  for (let i = 0; i < wanted; i += 1) {
    applyEdit(session, {
      kind: "setBlock",
      x: i % 16,
      y: Math.floor(i / 16),
      z: 0,
      block: { namespacedName: "minecraft:oak_log", properties: { axis: "y", variant: String(i) } },
    });
  }

  const { palette } = documentState(session);
  equal("every distinct state is listed", palette.length, wanted);
  check(
    "...most common first",
    palette.every((entry, index) => index === 0 || palette[index - 1].count >= entry.count),
    palette.slice(0, 3).map((entry) => entry.count).join(","),
  );
  // Air is every empty cell in the document, so listing it would put one entry
  // at the top with a count larger than the build.
  check(
    "and air is not a material",
    palette.every((entry) => !entry.block.startsWith("minecraft:air")),
  );
}

/*
 * A bed is two blocks, and was being placed as one.
 *
 * A lone foot is a state the game cannot hold: it drops as an item the moment
 * anything updates it, and until then it draws as half a bed. The head goes one
 * cell along `facing`, which is where the camera was looking when the block was
 * picked up -- so all of this is `applyEdit`'s, not the renderer's.
 */
console.log("\n--- a bed is two blocks ---");
{
  const bedAt = (
    session: ReturnType<typeof newDocument>,
    x: number,
    z: number,
    facing: string,
  ): number =>
    applyEdit(session, {
      kind: "setBlock",
      x,
      y: 0,
      z,
      block: { namespacedName: "minecraft:red_bed", properties: { facing } },
    });
  const nameAt = (session: ReturnType<typeof newDocument>, x: number, y: number, z: number) => {
    const at = getBlock(session.doc, x, y, z);
    return at === null ? null : `${at.namespacedName}:${at.properties.part ?? "-"}`;
  };

  {
    const session = newDocument({ width: 5, height: 3, length: 5 });
    equal("laying a bed places both halves", bedAt(session, 2, 2, "north"), 2);
    equal("the clicked cell is the foot", nameAt(session, 2, 0, 2), "minecraft:red_bed:foot");
    equal(
      "...and the head is one cell along the facing",
      nameAt(session, 2, 0, 1),
      "minecraft:red_bed:head",
    );
    // One transaction, so one Ctrl+Z takes the bed back rather than half of it.
    undo(session.doc, session.history);
    equal("one undo takes the whole bed", nameAt(session, 2, 0, 2), "minecraft:air:-");
    equal("...both halves of it", nameAt(session, 2, 0, 1), "minecraft:air:-");
  }

  // The other three facings, because a table of steps is exactly the thing to
  // get one sign wrong in and never notice on the axis you happened to test.
  for (const [facing, dx, dz] of [
    ["south", 0, 1],
    ["west", -1, 0],
    ["east", 1, 0],
  ] as const) {
    const session = newDocument({ width: 5, height: 3, length: 5 });
    bedAt(session, 2, 2, facing);
    equal(
      `facing ${facing} puts the head one cell that way`,
      nameAt(session, 2 + dx, 0, 2 + dz),
      "minecraft:red_bed:head",
    );
  }

  {
    // Blocked: the game does not place the bed, and neither does this. Nothing
    // at all is written -- not even the foot, which is the half that would
    // otherwise be left behind as a block the game cannot hold.
    const session = newDocument({ width: 5, height: 3, length: 5 });
    applyEdit(session, {
      kind: "setBlock",
      x: 2,
      y: 0,
      z: 1,
      block: { namespacedName: "minecraft:stone" },
    });
    equal("a blocked head refuses the whole bed", bedAt(session, 2, 2, "north"), 0);
    equal("...leaving the foot's cell empty", nameAt(session, 2, 0, 2), "minecraft:air:-");
  }

  {
    // At the edge it grows, exactly as a single block does: the region the
    // growth is measured against spans both cells.
    const session = newDocument({ width: 5, height: 3, length: 5 });
    equal("a bed laid at the edge makes room", bedAt(session, 2, 0, "north"), 2);
    equal("...by growing the document", session.doc.length, 6);
    equal("...with the head in the new cell", nameAt(session, 2, 0, 0), "minecraft:red_bed:head");
  }

  {
    // Placing one half on purpose is somebody else's business -- the inspector,
    // a paste, an agent tool. Only a request with no `part`, or `foot`, means
    // "lay a bed".
    const session = newDocument({ width: 5, height: 3, length: 5 });
    const changed = applyEdit(session, {
      kind: "setBlock",
      x: 2,
      y: 0,
      z: 2,
      block: { namespacedName: "minecraft:red_bed", properties: { facing: "north", part: "head" } },
    });
    equal("an explicit head is placed alone", changed, 1);
    equal("...with nothing beside it", nameAt(session, 2, 0, 1), "minecraft:air:-");
  }
}

/*
 * A door is two blocks too, and the second one is above rather than along.
 *
 * Same rule as the bed, same transaction, same refusal -- which is the point of
 * `twoPartPlacement` being one function: the bed's checks above and these are
 * the same list, and a family added later gets both for free or neither.
 */
console.log("\n--- a door is two blocks ---");
{
  const doorAt = (
    session: ReturnType<typeof newDocument>,
    y: number,
    facing: string,
  ): number =>
    applyEdit(session, {
      kind: "setBlock",
      x: 2,
      y,
      z: 2,
      block: { namespacedName: "minecraft:oak_door", properties: { facing, hinge: "right" } },
    });
  const halfAt = (session: ReturnType<typeof newDocument>, y: number) => {
    const at = getBlock(session.doc, 2, y, 2);
    return at === null ? null : `${at.namespacedName}:${at.properties.half ?? "-"}`;
  };

  {
    const session = newDocument({ width: 5, height: 5, length: 5 });
    equal("hanging a door places both halves", doorAt(session, 1, "north"), 2);
    equal("the clicked cell is the lower half", halfAt(session, 1), "minecraft:oak_door:lower");
    equal("...and the upper is the cell above", halfAt(session, 2), "minecraft:oak_door:upper");
    /*
     * Both halves carry the same everything else. In the game they have to --
     * a door whose halves disagree about `facing` or `hinge` draws as two
     * different doors and swings as neither.
     */
    const lower = getBlock(session.doc, 2, 1, 2);
    const upper = getBlock(session.doc, 2, 2, 2);
    equal("the upper half faces the same way", upper?.properties.facing, lower?.properties.facing);
    equal("...and hangs on the same hinge", upper?.properties.hinge, "right");
    // One transaction, so one Ctrl+Z takes the door back rather than half of it.
    undo(session.doc, session.history);
    equal("one undo takes the whole door", halfAt(session, 1), "minecraft:air:-");
    equal("...both halves of it", halfAt(session, 2), "minecraft:air:-");
  }

  // The upper half is straight up whichever way the door faces -- the bed's
  // step is the one that follows `facing`, and sharing a function is exactly
  // where that could have been got wrong for one of them.
  for (const facing of ["north", "south", "east", "west"] as const) {
    const session = newDocument({ width: 5, height: 5, length: 5 });
    doorAt(session, 1, facing);
    equal(`facing ${facing} still puts the upper half above`, halfAt(session, 2), "minecraft:oak_door:upper");
  }

  {
    // Blocked above: nothing at all is written, not even the lower half.
    const session = newDocument({ width: 5, height: 5, length: 5 });
    applyEdit(session, {
      kind: "setBlock",
      x: 2,
      y: 2,
      z: 2,
      block: { namespacedName: "minecraft:stone" },
    });
    equal("a blocked upper half refuses the whole door", doorAt(session, 1, "north"), 0);
    equal("...leaving the lower cell empty", halfAt(session, 1), "minecraft:air:-");
  }

  {
    // At the ceiling it grows, exactly as the bed does at the edge.
    const session = newDocument({ width: 5, height: 3, length: 5 });
    equal("a door hung at the ceiling makes room", doorAt(session, 2, "north"), 2);
    equal("...by growing the document", session.doc.height, 4);
    equal("...with the upper half in the new cell", halfAt(session, 3), "minecraft:oak_door:upper");
  }

  {
    // One half on purpose is somebody else's business, exactly as `part=head`.
    const session = newDocument({ width: 5, height: 5, length: 5 });
    const changed = applyEdit(session, {
      kind: "setBlock",
      x: 2,
      y: 1,
      z: 2,
      block: { namespacedName: "minecraft:oak_door", properties: { half: "upper" } },
    });
    equal("an explicit upper half is placed alone", changed, 1);
    equal("...with nothing above it", halfAt(session, 2), "minecraft:air:-");
  }

  {
    /*
     * And a trapdoor is not a door.
     *
     * `_trapdoor` does not end in `_door` -- "oak_trapdoor" ends "pdoor" -- so
     * the suffix needs no guard. That is a true sentence about string endings
     * which nobody would ever check, and if it stopped being true every
     * trapdoor in the app would start placing a second one above itself.
     */
    const session = newDocument({ width: 5, height: 5, length: 5 });
    const changed = applyEdit(session, {
      kind: "setBlock",
      x: 2,
      y: 1,
      z: 2,
      block: { namespacedName: "minecraft:oak_trapdoor", properties: { half: "bottom" } },
    });
    equal("a trapdoor is one block", changed, 1);
    equal(
      "...with nothing above it",
      getBlock(session.doc, 2, 2, 2)?.namespacedName,
      "minecraft:air",
    );
  }
}

/*
 * A block placed into water comes out waterlogged.
 *
 * That is what the game does — a fence, a slab or a stair put into a pond
 * displaces nothing, it floods — and doing it here is what makes the property
 * reachable without opening the inspector for every block of a jetty.
 */
console.log("\n--- placing into water floods the block ---");
{
  const flood = (session: ReturnType<typeof newDocument>, x: number) =>
    applyEdit(session, {
      kind: "setBlock",
      x,
      y: 0,
      z: 0,
      block: { namespacedName: "minecraft:water", properties: { level: "0" } },
    });
  const put = (
    session: ReturnType<typeof newDocument>,
    x: number,
    name: string,
    properties: Record<string, string> = {},
  ) =>
    applyEdit(session, {
      kind: "setBlock",
      x,
      y: 0,
      z: 0,
      block: { namespacedName: `minecraft:${name}`, properties },
    });
  const loggedAt = (session: ReturnType<typeof newDocument>, x: number) =>
    getBlock(session.doc, x, 0, 0).properties.waterlogged ?? null;

  const session = newDocument({ width: 6, height: 2, length: 2 });
  flood(session, 0);
  put(session, 0, "oak_fence");
  equal("a fence placed in water is waterlogged", loggedAt(session, 0), "true");

  put(session, 1, "oak_fence");
  equal("...and one placed on dry land is not", loggedAt(session, 1), null);

  // Only blocks that can hold it. `hasProperty` asks the registry, so stone
  // does not come back carrying a state no version of it has.
  flood(session, 2);
  put(session, 2, "stone");
  equal("stone dropped in a pond stays stone", loggedAt(session, 2), null);

  // A caller that spelled it out meant it: this is a default, not a correction.
  flood(session, 3);
  put(session, 3, "oak_fence", { waterlogged: "false" });
  equal("an explicit false is left alone", loggedAt(session, 3), "false");

  // A cell holding a waterlogged block is water too, which is what makes a
  // second fence beside the first behave like the first.
  flood(session, 4);
  put(session, 4, "oak_slab");
  put(session, 4, "oak_stairs");
  equal("replacing a flooded block keeps the water", loggedAt(session, 4), "true");
}


// --- the box as a fixed frame, and setting it by hand ----------------------
//
// The editor imposes no footprint: a region may be dragged outside the box and
// filling it grows the document to suit. That is right for building freely and
// wrong for building *to a size*, so it is a setting -- and with it off the
// edit is refused by name rather than clipped, which is the failure this
// codebase already wrote down once.
console.log("\n--- dimensions ---");
{
  const at = (session: ReturnType<typeof newDocument>, x: number, y: number, z: number) =>
    getBlock(session.doc, x, y, z).namespacedName;

  const outside = (session: ReturnType<typeof newDocument>, autoGrow: boolean) =>
    applyEdit(
      session,
      {
        kind: "fill",
        region: { minX: 0, minY: 0, minZ: 0, maxX: 9, maxY: 0, maxZ: 0 },
        block: { namespacedName: "minecraft:stone" },
      },
      { autoGrow },
    );

  {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    equal("with growing on, a fill past the edge still grows", outside(session, true), 10);
    equal("...and the document followed the region", session.doc.width, 10);
  }

  {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    let raised: unknown = null;
    try {
      outside(session, false);
    } catch (err) {
      raised = err;
    }
    check("with it off the same fill is refused", raised instanceof OutsideDocumentError);
    /*
     * Refused, not clipped. Clipping is what makes this worth a check: it would
     * have written four blocks, reported `changed: 4`, and read as success --
     * so the difference between the two behaviours is invisible from the
     * answer alone.
     */
    equal("...and nothing was written", session.doc.width, 4);
    equal("...not even the part that fitted", countBlocks(session.doc), 0);
  }

  {
    // An edit that fits is untouched by the setting; the guard is on growth and
    // nothing else.
    const session = newDocument({ width: 4, height: 4, length: 4 });
    const changed = applyEdit(
      session,
      {
        kind: "fill",
        region: { minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 0 },
        block: { namespacedName: "minecraft:stone" },
      },
      { autoGrow: false },
    );
    equal("a fill that fits is unaffected", changed, 4);
  }

  {
    /*
     * A break is exempt, because it never wanted to grow. Making room for air
     * is a resize and nothing else, so with the setting off a break outside the
     * box goes on doing exactly what it did before: nothing, quietly.
     */
    const session = newDocument({ width: 4, height: 4, length: 4 });
    const changed = applyEdit(
      session,
      { kind: "setBlock", x: 9, y: 0, z: 0, block: { namespacedName: "minecraft:air" } },
      { autoGrow: false },
    );
    equal("a break outside the box is not a refusal", changed, 0);
    equal("...and still does not grow", session.doc.width, 4);
  }

  // --- resizing by hand ---
  {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    resizeSession(session, { width: 8, height: 6, length: 5 });
    equal("a size typed in is taken", documentSize(session.doc), [8, 6, 5]);

    /*
     * At the far side, never with a shift. Making room below the origin would
     * move all the content up instead -- the grid has no negative index -- and
     * then every coordinate anybody had written down would mean something else.
     */
    setBlock(session.doc, 0, 0, 0, { namespacedName: "minecraft:stone", properties: {} });
    resizeSession(session, { width: 12, height: 6, length: 5 });
    equal("growing leaves the content where it was", at(session, 0, 0, 0), "minecraft:stone");
  }

  {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    resizeSession(session, { width: 6, height: 6, length: 6 });
    undoEdit(session);
    equal("a resize is one undo step", documentSize(session.doc), [4, 4, 4]);
  }

  {
    // Shrinking into empty space is the ordinary case and must not be
    // interrupted: losing air is losing nothing.
    const session = newDocument({ width: 8, height: 8, length: 8 });
    setBlock(session.doc, 1, 1, 1, { namespacedName: "minecraft:stone", properties: {} });
    resizeSession(session, { width: 4, height: 4, length: 4 });
    equal("a shrink over empty space goes through", documentSize(session.doc), [4, 4, 4]);
  }

  {
    const session = newDocument({ width: 8, height: 8, length: 8 });
    setBlock(session.doc, 7, 0, 0, { namespacedName: "minecraft:stone", properties: {} });
    setBlock(session.doc, 6, 0, 0, { namespacedName: "minecraft:stone", properties: {} });
    let raised: unknown = null;
    try {
      resizeSession(session, { width: 4, height: 8, length: 8 });
    } catch (err) {
      raised = err;
    }
    check(
      "a shrink that would destroy blocks is refused",
      raised instanceof ResizeWouldLoseBlocksError,
    );
    /*
     * Counted, because the refusal *is* the warning -- a message shown after
     * the blocks are gone is not one, and main must not raise a dialog for a
     * request that may not have come from a person at the keyboard.
     */
    equal(
      "...and says how many",
      raised instanceof ResizeWouldLoseBlocksError ? raised.blocks : -1,
      2,
    );
    equal("...having changed nothing", documentSize(session.doc), [8, 8, 8]);

    resizeSession(session, { width: 4, height: 8, length: 8 }, { confirmLoss: true });
    equal("confirmed, it goes through", documentSize(session.doc), [4, 8, 8]);
    /*
     * And it is still one Ctrl+Z away. `tx.resize` records the blocks it drops,
     * which is what makes confirming a decision rather than a commitment.
     */
    undoEdit(session);
    equal("...and comes back whole", at(session, 7, 0, 0), "minecraft:stone");
  }

  {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    equal("resizing to the size it already is changes nothing", resizeSession(session, { width: 4, height: 4, length: 4 }), 0);
    //  pushes no step for a recorder with no commands, so a
    // resize to the size it already is must not leave one to take back.
    equal("...and leaves nothing to undo", undoEdit(session), null);
  }

  {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    /*
     * Per axis, and each case chosen so that nothing *downstream* would catch
     * it on this function's behalf.
     *
     * `document.resizeDocument` already refuses anything below 1x1x1, so a zero
     * proves only that something refused it somewhere. The ceiling has no such
     * backstop: 8192 x 1 x 1 is 8,192 cells, comfortably inside
     * `MAX_DOCUMENT_VOLUME`, so with the per-axis maximum gone it would simply
     * succeed and leave a schematic eight thousand blocks long on one side.
     */
    for (const bad of [
      { width: 0, height: 4, length: 4 },
      { width: 4, height: -1, length: 4 },
      { width: 4, height: 4, length: 0 },
      { width: DOCUMENT_SIZE.max + 1, height: 1, length: 1 },
      { width: 1, height: DOCUMENT_SIZE.max + 1, length: 1 },
      { width: 1, height: 1, length: DOCUMENT_SIZE.max + 1 },
    ]) {
      let raised: unknown = null;
      try {
        resizeSession(session, bad);
      } catch (err) {
        raised = err;
      }
      check(`${JSON.stringify(bad)} is refused`, raised instanceof Error);
    }
    equal("...and the document is untouched", documentSize(session.doc), [4, 4, 4]);

    /*
     * And it is refused *here*, with a message naming the range.
     *
     *  already declines anything under 1x1x1, so the
     * minimum could be left to it -- and then the message would say "at least
     * 1x1x1" and stop, which tells somebody who typed 9000 nothing about why.
     * Naming the ceiling is the whole of what this guard buys over the one
     * underneath it, so that is what is checked.
     */
    let small: unknown = null;
    try {
      resizeSession(session, { width: 0, height: 4, length: 4 });
    } catch (err) {
      small = err;
    }
    check(
      "...and the refusal names the range it wanted",
      small instanceof Error && small.message.includes(String(DOCUMENT_SIZE.max)),
      small instanceof Error ? small.message : String(small),
    );

    /*
     * The volume cap is a separate guard from the per-axis one and catches what
     * the axes cannot: every side inside its own limit, and the product past
     * what an `Int32Array` should hold.
     */
    let huge: unknown = null;
    try {
      resizeSession(session, { width: 4000, height: 4000, length: 4000 });
    } catch (err) {
      huge = err;
    }
    check("a volume past the cap is refused", huge instanceof DocumentTooLargeError);
  }
}


// --- empty space made of something else -------------------------------------
//
// With a void block chosen, breaking writes *it* rather than air -- which is
// what an underwater build needs the file to say. The rule that has to survive
// that is `Breaking never grows`: it read `namespacedName === "minecraft:air"`,
// which was the whole of what a break was until empty space could be water.
console.log("\n--- breaking into the void ---");
{
  const at = (session: ReturnType<typeof newDocument>, x: number, y: number, z: number) =>
    getBlock(session.doc, x, y, z).namespacedName;

  {
    const session = newDocument({ width: 4, height: 4, length: 4 });
    setBlock(session.doc, 1, 1, 1, { namespacedName: "minecraft:stone", properties: {} });
    const changed = applyEdit(
      session,
      { kind: "setBlock", x: 1, y: 1, z: 1, block: { namespacedName: "minecraft:water" } },
      { voidBlock: "minecraft:water" },
    );
    equal("breaking writes the void block", changed, 1);
    equal("...into the cell the block was in", at(session, 1, 1, 1), "minecraft:water");
  }

  {
    /*
     * And it still does not grow.
     *
     * Nothing sends a break from outside the box today -- a break comes from a
     * pick, so the block exists -- which is exactly why this is written down:
     * left keyed on the word `air`, the rule would go on being true of the word
     * while quietly ceasing to be true of *breaking*, and nothing would fail.
     */
    const session = newDocument({ width: 4, height: 4, length: 4 });
    const changed = applyEdit(
      session,
      { kind: "setBlock", x: 9, y: 0, z: 0, block: { namespacedName: "minecraft:water" } },
      { voidBlock: "minecraft:water" },
    );
    equal("breaking outside the box changes nothing", changed, 0);
    equal("...and does not grow the document", session.doc.width, 4);
  }

  {
    /*
     * The other half of the same sentence: with no void block chosen, water is
     * an ordinary block and placing it outside the box grows the document like
     * anything else. The guard is about emptiness, not about water.
     */
    const session = newDocument({ width: 4, height: 4, length: 4 });
    applyEdit(session, {
      kind: "setBlock",
      x: 9,
      y: 0,
      z: 0,
      block: { namespacedName: "minecraft:water" },
    });
    equal("placing water with no void block set grows", session.doc.width, 10);
  }

  {
    // And air is still air, whatever else is chosen.
    const session = newDocument({ width: 4, height: 4, length: 4 });
    const changed = applyEdit(
      session,
      { kind: "setBlock", x: 9, y: 0, z: 0, block: { namespacedName: "minecraft:air" } },
      { voidBlock: "minecraft:water" },
    );
    equal("a plain break is unaffected", changed, 0);
    equal("...and grows nothing either", session.doc.width, 4);
  }
}


// --- the box follows the content back in ------------------------------------
//
// The mirror of "a single placed block grows it too", and it was missing:
// placing past the edge grew the schematic and breaking that same block left it
// grown. Reported exactly that way -- "deleting a block does not resize the
// area, and setting one does".
console.log("\n--- breaking takes the box back ---");
{
  const stone = { namespacedName: "minecraft:stone" };
  const air = { namespacedName: "minecraft:air" };
  const place = (
    session: DocumentSession,
    x: number,
    y: number,
    z: number,
    block: { namespacedName: string } = stone,
    options: { autoGrow?: boolean; voidBlock?: string } = {},
  ) => applyEdit(session, { kind: "setBlock", x, y, z, block }, options);
  const put = (session: DocumentSession, x: number, y: number, z: number) =>
    setBlock(session.doc, x, y, z, { namespacedName: "minecraft:stone", properties: {} });

  {
    // The round trip, which is the whole complaint.
    const session = newDocument({ width: 4, height: 4, length: 4 });
    place(session, 4, 0, 0);
    equal("placing outside grows the box", session.doc.width, 5);
    place(session, 4, 0, 0, air);
    equal("...and breaking it takes the box back", session.doc.width, 4);
    equal("...leaving the other axes alone", [session.doc.height, session.doc.length], [4, 4]);
  }

  {
    /*
     * One slab, not "shrink to the content".
     *
     * Shrinking to the content is the obvious rule and is the one that eats
     * work: this document has empty slabs behind the block being broken, and
     * they are room somebody made on purpose.
     */
    const session = newDocument({ width: 8, height: 4, length: 4 });
    put(session, 7, 0, 0);
    place(session, 7, 0, 0, air);
    equal("breaking the outer face peels one slab", session.doc.width, 7);
  }

  {
    // A face with something else still on it is not a face that came free.
    const session = newDocument({ width: 4, height: 4, length: 4 });
    put(session, 3, 0, 0);
    put(session, 3, 2, 2);
    place(session, 3, 0, 0, air);
    equal("a face still holding a block does not come off", session.doc.width, 4);
  }

  {
    /*
     * Room is untouchable rather than usually safe: the broken cell has to *be*
     * the outer face, and a roomy box has nothing on its outer faces.
     */
    const session = newDocument({ width: 16, height: 16, length: 16 });
    put(session, 5, 5, 5);
    place(session, 5, 5, 5, air);
    equal(
      "breaking inside a roomy schematic moves nothing",
      [session.doc.width, session.doc.height, session.doc.length],
      [16, 16, 16],
    );
  }

  {
    // A corner is on three faces at once, and all three come off.
    const session = newDocument({ width: 4, height: 4, length: 4 });
    put(session, 3, 3, 3);
    place(session, 3, 3, 3, air);
    equal(
      "a corner break peels all three",
      [session.doc.width, session.doc.height, session.doc.length],
      [3, 3, 3],
    );
  }

  {
    /*
     * Never at the near side. Retreating there would move all the content down,
     * and every coordinate anybody has been given would stop meaning what it
     * meant -- `resizeSession`'s restriction, from the other direction.
     */
    const session = newDocument({ width: 4, height: 4, length: 4 });
    put(session, 0, 0, 0);
    put(session, 2, 2, 2);
    place(session, 0, 0, 0, air);
    equal("breaking at the origin moves nothing", session.doc.width, 4);
    equal(
      "...and leaves the rest of the content where it was",
      getBlock(session.doc, 2, 2, 2).namespacedName,
      "minecraft:stone",
    );
  }

  {
    // It is the same setting seen from the other side, so it is off with it.
    const session = newDocument({ width: 4, height: 4, length: 4 });
    put(session, 3, 0, 0);
    place(session, 3, 0, 0, air, { autoGrow: false });
    equal("with automatic resizing off nothing moves", session.doc.width, 4);
  }

  {
    /*
     * And underwater. Keyed on the word `air` this would grow and never come
     * back in, which is exactly the build the void block exists for -- the
     * break writes water, and water is what empty means there.
     */
    const session = newDocument({ width: 4, height: 4, length: 4 });
    put(session, 3, 0, 0);
    place(session, 3, 0, 0, { namespacedName: "minecraft:water" }, {
      voidBlock: "minecraft:water",
    });
    equal("a break into water peels the face too", session.doc.width, 3);
  }

  {
    /*
     * A break that wrote nothing peels nothing. Nothing sends one today -- a
     * break comes from a pick, so the block is there -- which is why it is
     * written down: without the guard, clicking an empty cell at the outer
     * face would take a slab off on a click that did nothing at all.
     */
    const session = newDocument({ width: 4, height: 4, length: 4 });
    put(session, 1, 1, 1);
    place(session, 3, 3, 3, air);
    equal(
      "breaking a cell that is already empty moves nothing",
      [session.doc.width, session.doc.height, session.doc.length],
      [4, 4, 4],
    );
  }

  {
    // Never below the smallest schematic there is.
    const session = newDocument({ width: 1, height: 1, length: 1 });
    put(session, 0, 0, 0);
    place(session, 0, 0, 0, air);
    equal(
      "a 1x1x1 stays a 1x1x1",
      [session.doc.width, session.doc.height, session.doc.length],
      [1, 1, 1],
    );
  }

  {
    // One step, both halves: the size and the block come back together.
    const session = newDocument({ width: 4, height: 4, length: 4 });
    place(session, 4, 0, 0);
    place(session, 4, 0, 0, air);
    equal("the box is back in", session.doc.width, 4);
    undoEdit(session);
    equal("undo restores the size", session.doc.width, 5);
    equal(
      "...and the block with it",
      getBlock(session.doc, 4, 0, 0).namespacedName,
      "minecraft:stone",
    );
  }

  {
    /*
     * The ordering check, and the one worth having.
     *
     * `tx.resize` calls `flush()`, and the connection pass reads the recorder's
     * *live* set -- so a peel written into the transaction body would not
     * reorder the two, it would delete the derivation outright. The fence
     * beside the one you broke would keep an arm pointing at nothing, with
     * every other check here still green. `TransactionOptions.after` is what
     * puts it on the far side of the pass.
     */
    const session = newDocument({ width: 4, height: 4, length: 4 });
    const fence = { namespacedName: "minecraft:oak_fence" };
    place(session, 1, 0, 2, fence);
    place(session, 1, 0, 3, fence);
    equal("two fences in a row connect", getBlock(session.doc, 1, 0, 2).properties.south, "true");
    place(session, 1, 0, 3, air);
    equal("breaking the outer one peels the face", session.doc.length, 3);
    equal(
      "...and its neighbour still loses the arm",
      getBlock(session.doc, 1, 0, 2).properties.south,
      "false",
    );
  }
}


// --- opening a .mcfunction is importing, not opening -------------------------
//
// A list of commands has no metadata, no anchor tag, no DataVersion and no NBT
// root, so a document never *becomes* one: it comes in as Sponge v3 and, most
// of all, **with no path**. Keeping the path would be worse than losing it --
// a plain Save would then write a Sponge file over the `.mcfunction` it came
// from, under that name, and the user would have one file that is neither.
console.log("\n--- importing a mcfunction ---");
{
  const workDir = await mkdtemp(path.join(tmpdir(), "sas-import-"));
  try {
    const target = path.join(workDir, "house.mcfunction");
    await writeFile(
      target,
      ["setblock ~ ~ ~ minecraft:stone", "setblock ~2 ~ ~ minecraft:glass"].join(
        String.fromCharCode(10),
      ),
      "utf8",
    );

    const session = await openDocument(target);
    equal("it opens", countBlocks(session.doc), 2);
    equal("...as a container that can hold everything", session.doc.format, "sponge3");
    equal("...and with no file to save over", session.doc.filePath, null);

    /*
     * So Save falls through to Save As, which `saveSession` already does by
     * refusing without a target rather than by every call site remembering to
     * check.
     */
    let refused = false;
    try {
      await saveSession(session);
    } catch (err) {
      refused = err instanceof NoSaveTargetError;
    }
    check("saving asks where to put it", refused);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
// --- choosing what empty space is made of -----------------------------------
console.log("\n--- choosing what empty space is made of ---");
{
  /*
   * Emptiness is matched the way `fillVoid` matches it: by palette key, not by
   * bare name against the raw setting string.
   *
   * Those are two vocabularies. The picker hands back
   * `minecraft:water[level=0]`, and a cell holding it has the *name*
   * `minecraft:water` -- so the old comparison never matched, and a break into
   * that void quietly went back to growing the box while `preview.ts` was
   * already drawing those same cells as empty. One feature, two halves,
   * disagreeing about which cells were void.
   */
  const session = newDocument({ width: 4, height: 4, length: 4 });
  const changed = applyEdit(
    session,
    {
      kind: "setBlock",
      x: 9,
      y: 0,
      z: 0,
      block: { namespacedName: "minecraft:water", properties: { level: "0" } },
    },
    { voidBlock: "minecraft:water[level=0]" },
  );
  equal("a stated void block matches a cell carrying the same state", changed, 0);
  equal("...so breaking into it still does not grow", session.doc.width, 4);
}

{
  /*
   * And the asymmetry that makes it a key match rather than a name match: a
   * *different* state is a different block, so it is an ordinary placement and
   * grows like one. `fillVoid` draws it the same way.
   */
  const session = newDocument({ width: 4, height: 4, length: 4 });
  applyEdit(
    session,
    { kind: "setBlock", x: 9, y: 0, z: 0, block: { namespacedName: "minecraft:water" } },
    { voidBlock: "minecraft:water[level=0]" },
  );
  equal("a different state is an ordinary block and grows", session.doc.width, 10);
}

{
  /*
   * ...and the direction the two comments above never covered: a **bare**
   * void block is that block in any state.
   *
   * Both halves used to compare full state strings, so `minecraft:barrier`
   * chosen over a schematic full of `barrier[waterlogged=false]` matched
   * nothing -- reported as the cells staying opaque and clickable, and here
   * as a break that grows the box instead of emptying a cell. Every preset in
   * the modal is a bare id and every block out of a file carries its state, so
   * this is the ordinary case rather than an edge one.
   *
   * `matchesBlockPattern` is `replaceAny`'s rule, which is why the reported
   * workaround went through *Replace*: that verb already knew.
   */
  const session = newDocument({ width: 4, height: 4, length: 4 });
  const changed = applyEdit(
    session,
    {
      kind: "setBlock",
      x: 9,
      y: 0,
      z: 0,
      block: { namespacedName: "minecraft:barrier", properties: { waterlogged: "false" } },
    },
    { voidBlock: "minecraft:barrier" },
  );
  equal("a bare void block matches a cell carrying a state", changed, 0);
  equal("...so breaking into it does not grow either", session.doc.width, 4);
}

{
  /*
   * The choice on its own moves no block, so it leaves nothing to undo.
   *
   * It changes what empty space is *drawn* as and what a future break will
   * *write*. Putting that on the undo stack would make Ctrl+Z after a session
   * of building take back a preference rather than the wall you just placed.
   */
  const session = newDocument({ width: 4, height: 4, length: 4 });
  const before = documentState(session).undoDepth;
  const changed = setSessionVoidBlock(session, "minecraft:water");
  equal("choosing alone changes no blocks", changed, 0);
  equal("...and leaves the undo stack alone", documentState(session).undoDepth, before);
  equal("...but the document now says what it is made of", session.voidBlock, "minecraft:water");
  equal("...as the renderer will be told", documentState(session).voidBlock, "minecraft:water");
}

{
  /*
   * Asked for, the rewrite is one transaction: a swap of every empty cell in
   * the schematic is one Ctrl+Z, not one per cell.
   */
  const session = newDocument({ width: 4, height: 4, length: 4 });
  setBlock(session.doc, 1, 1, 1, { namespacedName: "minecraft:stone", properties: {} });
  const before = documentState(session).undoDepth;
  const changed = setSessionVoidBlock(session, "minecraft:water", { replaceExisting: true });
  equal("the air already there becomes the new void block", changed, 63);
  equal("...in one undoable step", documentState(session).undoDepth, before + 1);
  equal("...leaving the blocks alone", getBlock(session.doc, 1, 1, 1).namespacedName, "minecraft:stone");
  equal("...and filling the rest", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:water");

  undoEdit(session);
  equal("undo puts the air back", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:air");
  equal(
    "...and the choice itself is not undone, because it was never an edit",
    session.voidBlock,
    "minecraft:water",
  );

}

{
  /*
   * Going back to air is the same operation rather than a special case: `""`
   * means air on both sides of the swap, so there is no separate "clear" verb
   * to keep in step with this one.
   */
  const session = newDocument({ width: 4, height: 4, length: 4 });
  setSessionVoidBlock(session, "minecraft:water", { replaceExisting: true });
  equal("the water went in", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:water");
  const back = setSessionVoidBlock(session, "", { replaceExisting: true });
  equal("going back to air replaces the water", back, 64);
  equal("...and the document says so", session.voidBlock, "");
  equal("...cell by cell", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:air");
}

{
  /*
   * Choosing what is already chosen is not an edit -- but **asking for the
   * rewrite still is**, and that asymmetry is the point rather than an
   * oversight. The two are separate acts now, so a press means convert
   * whatever the setting happens to say already.
   */
  const session = newDocument({ width: 4, height: 4, length: 4 });
  setSessionVoidBlock(session, "minecraft:water");
  const before = documentState(session).undoDepth;
  equal("re-choosing the same block moves nothing on its own", setSessionVoidBlock(session, "minecraft:water"), 0);
  equal("...and leaves no undo step", documentState(session).undoDepth, before);
  equal(
    "...while pressing the button still converts the air",
    setSessionVoidBlock(session, "minecraft:water", { replaceExisting: true }),
    64,
  );
  equal("...as one step", documentState(session).undoDepth, before + 1);
  undoEdit(session);
  // Every spelling of air is the same answer, so this is not a change either.
  setSessionVoidBlock(session, "");
  equal("air normalises", setSessionVoidBlock(session, "minecraft:air"), 0);
  equal("...to the empty string", session.voidBlock, "");
}

{
  /*
   * The button's case, which is the one the checkbox could not reach.
   *
   * Choosing takes effect at the pick -- that is what makes the viewport show
   * it -- so by the time somebody presses Replace, the session already says
   * water. Left to work it out for itself, main would convert water into water
   * and report nothing changed, which is exactly what the panel did before the
   * two acts were split. `replaceFrom` is the caller saying what the cells
   * actually hold, because the caller is the only thing still holding it.
   */
  const session = newDocument({ width: 4, height: 4, length: 4 });
  setBlock(session.doc, 1, 1, 1, { namespacedName: "minecraft:stone", properties: {} });

  setSessionVoidBlock(session, "minecraft:water");
  equal("choosing alone leaves the air where it was", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:air");

  const before = documentState(session).undoDepth;
  equal(
    "the rewrite names what it converts from",
    setSessionVoidBlock(session, "minecraft:water", { replaceExisting: true, replaceFrom: "" }),
    63,
  );
  equal("...in one undoable step", documentState(session).undoDepth, before + 1);
  equal("...and the air is water", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:water");
  equal("...while the choice is where it already was", session.voidBlock, "minecraft:water");

  /*
   * Pressing again converts water into water, which cannot change anything --
   * so it is not an edit and leaves no empty step behind.
   */
  equal(
    "converting a block into itself does nothing",
    setSessionVoidBlock(session, "minecraft:water", { replaceExisting: true, replaceFrom: "minecraft:water" }),
    0,
  );
  equal("...and pushes no step", documentState(session).undoDepth, before + 1);

  /*
   * And undoing it is now re-appliable, which it was not while the two acts
   * were fused: the choice survives the undo by design, so re-picking the
   * block was refused as choosing what was already chosen. With the rewrite on
   * a press of its own, pressing again is the gesture.
   */
  undoEdit(session);
  equal("undo puts the air back", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:air");
  equal(
    "...and the rewrite can simply be asked for again",
    setSessionVoidBlock(session, "minecraft:water", { replaceExisting: true, replaceFrom: "" }),
    63,
  );
}

{
  /*
   * Absent, `replaceFrom` is the session's own value -- so a caller that does
   * both at once behaves exactly as it always did. That is what keeps the
   * checks above this one true of the same function.
   */
  const session = newDocument({ width: 4, height: 4, length: 4 });
  equal(
    "with nothing named, the session says what to convert",
    setSessionVoidBlock(session, "minecraft:water", { replaceExisting: true }),
    64,
  );
  equal("...which was air", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:water");
}

{
  /*
   * The choice and the cells can disagree, and the panel cannot tell from the
   * choice alone which of two identical-looking states it is in.
   *
   * A document whose empty space is *set* to barrier but whose cells still hold
   * air -- reopened from the sidecar, or one Ctrl+Z after a conversion -- looks
   * exactly like one where the conversion already happened. Deciding from the
   * setting disabled the button in both, so the one gesture that would have
   * fixed it was the one with no answer.
   *
   * The fix is that **air is always a source**. It is what empty means in a
   * schematic, whatever the setting says.
   */
  const session = newDocument({ width: 4, height: 4, length: 4 });
  setBlock(session.doc, 1, 1, 1, { namespacedName: "minecraft:stone", properties: {} });
  setSessionVoidBlock(session, "minecraft:barrier");

  equal(
    "the cells can be converted even when the setting already names the block",
    setSessionVoidBlock(session, "minecraft:barrier", {
      replaceExisting: true,
      replaceFrom: "minecraft:barrier",
    }),
    63,
  );
  equal(
    "...which is what the air becomes",
    getBlock(session.doc, 0, 0, 0).namespacedName,
    "minecraft:barrier",
  );

  /*
   * And doing it again converts nothing, because there is no air left -- not
   * because a flag says so. The two cases are only distinguishable by looking.
   */
  equal(
    "...and a second press finds nothing to do",
    setSessionVoidBlock(session, "minecraft:barrier", {
      replaceExisting: true,
      replaceFrom: "minecraft:barrier",
    }),
    0,
  );

  /*
   * Swapping one for another still converts what the last one left behind, so
   * air is an *addition* to the source set rather than a replacement for it.
   */
  equal(
    "swapping to another block converts what the previous one left",
    setSessionVoidBlock(session, "minecraft:structure_void", {
      replaceExisting: true,
      replaceFrom: "minecraft:barrier",
    }),
    63,
  );
  equal(
    "...leaving the build alone",
    getBlock(session.doc, 1, 1, 1).namespacedName,
    "minecraft:stone",
  );
}

// --- changing which Minecraft a schematic is for ----------------------------
/*
 * There was no way to do this. A version could be chosen at New and stamped at
 * Save As, and nothing in between -- so saying "this is a 1.12 schematic" about
 * a file that arrived carrying no tag meant a Save As, and so did 1.21 to 1.16.
 */
console.log("\n--- changing which Minecraft a schematic is for ---");
{
  const names = legacyBlockNames(await loadLegacyBlockTable(LEGACY_BLOCKS));
  const thrown = (run: () => void): Error | null => {
    try {
      run();
      return null;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  {
    // The ordinary case: a legacy file that names no version is told which one
    // it is. That is the gesture this exists for, and it moves no blocks.
    const session = newDocument({ width: 4, height: 4, length: 4 }, "mcedit", null);
    setBlock(session.doc, 1, 1, 1, { namespacedName: "minecraft:stone", properties: {} });
    equal("naming a version moves no blocks", setDocumentVersion(session, "JE_1_12_2").changed, 0);
    equal("...and the document carries it", session.doc.dataVersion, 1343);
    equal(
      "...which is what a save would stamp",
      documentState(session).dataVersion,
      1343,
    );

    undoEdit(session);
    equal("...and it comes back off on Ctrl+Z", session.doc.dataVersion, null);
  }

  {
    /*
     * A backport is refused first and counted, never done and reported. A
     * warning shown after the blocks are gone is not a warning.
     */
    const session = newDocument({ width: 4, height: 4, length: 4 }, "mcedit", 3700);
    for (let x = 0; x < 3; x += 1) {
      setBlock(session.doc, x, 0, 0, { namespacedName: "minecraft:deepslate", properties: {} });
    }
    setBlock(session.doc, 0, 1, 0, { namespacedName: "minecraft:stone", properties: {} });

    const refusal = thrown(() =>
      setDocumentVersion(session, "JE_1_12_2", { placeableNames: names }),
    );
    check(
      "backporting is refused rather than done",
      refusal instanceof VersionWouldLoseBlocksError,
      String(refusal),
    );
    check(
      "...counting the cells, not the block types",
      refusal?.message.includes("3 block(s)") === true,
      refusal?.message ?? "",
    );
    check(
      "...and naming what would go",
      refusal?.message.includes("minecraft:deepslate") === true,
      refusal?.message ?? "",
    );
    equal("nothing was changed by the refusal", session.doc.dataVersion, 3700);
    equal(
      "...and nothing was destroyed",
      getBlock(session.doc, 0, 0, 0).namespacedName,
      "minecraft:deepslate",
    );

    /*
     * Confirmed, it goes through as **one** transaction: the version and the
     * blocks move together, so one Ctrl+Z takes both back. That is free --
     * `HeaderState` has captured `dataVersion` since it existed -- and it is
     * the whole reason this is a transaction rather than two writes.
     */
    const before = documentState(session).undoDepth;
    equal(
      "confirmed, it drops them",
      setDocumentVersion(session, "JE_1_12_2", {
        placeableNames: names,
        dropUnrepresentable: true,
      }).changed,
      3,
    );
    equal("...in one undoable step", documentState(session).undoDepth, before + 1);
    equal("...leaving air", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:air");
    equal("...and the version changed", session.doc.dataVersion, 1343);
    equal(
      "...while a block the version has is untouched",
      getBlock(session.doc, 0, 1, 0).namespacedName,
      "minecraft:stone",
    );

    undoEdit(session);
    equal(
      "undo brings the blocks back",
      getBlock(session.doc, 0, 0, 0).namespacedName,
      "minecraft:deepslate",
    );
    equal("...and the version with them, in the same step", session.doc.dataVersion, 3700);
  }

  {
    /*
     * The container is not changed here, so a version it cannot carry is
     * refused with `refusalFor`'s own sentence. Sponge has no way to name a
     * pre-Flattening block, and flipping `doc.format` under an open file would
     * leave the next plain Save writing MCEdit bytes under a `.schem` name.
     */
    const session = newDocument({ width: 2, height: 2, length: 2 }, "sponge3", 3700);
    const refusal = thrown(() => setDocumentVersion(session, "JE_1_12_2"));
    check(
      "a container that cannot carry the version refuses it",
      refusal instanceof VersionRefusedError,
      String(refusal),
    );
    check(
      "...with the reason, not just a no",
      refusal?.message.includes("1.13") === true,
      refusal?.message ?? "",
    );
    equal("...and changes nothing", session.doc.dataVersion, 3700);

    check(
      "a version this build never heard of is refused too",
      thrown(() => setDocumentVersion(session, "JE_9_9_9")) instanceof UnknownVersionError,
    );
  }

  {
    /*
     * Flat to flat, which used to do nothing at all: `placeableNames` was only
     * passed for a legacy target, so backporting 1.21.4 to 1.13 moved the tag
     * and left 501 kinds of block in a file for a game that never had them.
     */
    const session = newDocument({ width: 2, height: 2, length: 2 }, "sponge3", 4189);
    setBlock(session.doc, 0, 0, 0, { namespacedName: "minecraft:deepslate", properties: {} });
    setBlock(session.doc, 1, 0, 0, { namespacedName: "minecraft:stone", properties: {} });

    const refusal = thrown(() => setDocumentVersion(session, "JE_1_16_5"));
    check(
      "a flat backport now refuses rather than carrying a block the target lacks",
      refusal instanceof VersionWouldLoseBlocksError,
      String(refusal),
    );
    check(
      "...naming it",
      refusal?.message.includes("minecraft:deepslate") === true,
      refusal?.message ?? "",
    );
    check(
      "...and not the block 1.16.5 does have",
      refusal?.message.includes("minecraft:stone") === false,
      refusal?.message ?? "",
    );

    equal(
      "confirmed, the deepslate goes",
      setDocumentVersion(session, "JE_1_16_5", { dropUnrepresentable: true }).dropped,
      1,
    );
    equal("...and the tag moves", session.doc.dataVersion, 2586);
    equal(
      "...while the stone stays",
      getBlock(session.doc, 1, 0, 0).namespacedName,
      "minecraft:stone",
    );
  }

  {
    /*
     * The trap, said as the case it would have produced.
     *
     * mcmeta's summary lists only blocks with properties before 1.20.5 and
     * every block after, so a plain diff of it dates `stone` to 1.20.5. Acted
     * on, this backport replaces the whole floor with empty space and reports
     * a healthy count for it.
     */
    const session = newDocument({ width: 4, height: 1, length: 4 }, "sponge3", 4189);
    for (let x = 0; x < 4; x += 1) {
      for (let z = 0; z < 4; z += 1) {
        setBlock(session.doc, x, 0, z, { namespacedName: "minecraft:stone", properties: {} });
      }
    }
    equal(
      "a floor of stone survives a backport to 1.19",
      setDocumentVersion(session, "JE_1_19").dropped,
      0,
    );
    equal(
      "...every block of it",
      getBlock(session.doc, 2, 0, 2).namespacedName,
      "minecraft:stone",
    );
  }

  {
    /*
     * A rename is not a removal, and this is the reported case from both ends.
     *
     * Read as a removal, going under 1.21.9 replaces every chain in the build
     * with empty space; read as a rename it writes the name the older game uses
     * and loses nothing. So it must not be counted, and must not be refused.
     */
    const session = newDocument({ width: 2, height: 2, length: 2 }, "sponge3", 4903);
    setBlock(session.doc, 0, 0, 0, {
      namespacedName: "minecraft:iron_chain",
      properties: { axis: "y" },
    });

    /*
     * Captured rather than called plainly, so that getting the order wrong
     * fails **by name** instead of throwing a stack trace out of the suite. It
     * is the check that separates renaming from demolishing, and it should read
     * as a check.
     */
    let back: VersionChangeResult | undefined;
    const refused = thrown(() => {
      back = setDocumentVersion(session, "JE_1_21_4");
    });
    equal(
      "backporting an iron_chain is not refused -- a rename loses nothing",
      refused === null ? null : refused.message,
      null,
    );
    equal("...so it drops nothing", back?.dropped, 0);
    equal("...and counts as renamed", back?.renamed, 1);
    equal(
      "...writing the name 1.21.4 uses",
      getBlock(session.doc, 0, 0, 0).namespacedName,
      "minecraft:chain",
    );
    equal(
      "...keeping the state it was in",
      getBlock(session.doc, 0, 0, 0).properties.axis,
      "y",
    );

    // And forward again, which is the second half of the report.
    const forward = setDocumentVersion(session, "JE_26_2");
    equal("and forward it comes back", forward.renamed, 1);
    equal(
      "...as iron_chain",
      getBlock(session.doc, 0, 0, 0).namespacedName,
      "minecraft:iron_chain",
    );

    undoEdit(session);
    equal(
      "undo takes the name back",
      getBlock(session.doc, 0, 0, 0).namespacedName,
      "minecraft:chain",
    );
    equal("...and the version with it, in one step", session.doc.dataVersion, 4189);
  }

  {
    /*
     * A wall's connections stopped being a boolean in 1.16, and it is the one
     * value change in the flat era that touches a real build. Restated, not
     * dropped: the wall is still there, one connection shorter.
     */
    const session = newDocument({ width: 2, height: 2, length: 2 }, "sponge3", 4189);
    setBlock(session.doc, 0, 0, 0, {
      namespacedName: "minecraft:cobblestone_wall",
      properties: { north: "tall", up: "true" },
    });

    const result = setDocumentVersion(session, "JE_1_15_2");
    equal("a wall backported under 1.16 is restated, not dropped", result.dropped, 0);
    equal("...and counted as restated", result.rewritten, 1);
    equal(
      "...with a connection 1.15 can say",
      getBlock(session.doc, 0, 0, 0).properties.north,
      "true",
    );
    equal(
      "...leaving the boolean it already had alone",
      getBlock(session.doc, 0, 0, 0).properties.up,
      "true",
    );
    equal(
      "...and the block itself untouched",
      getBlock(session.doc, 0, 0, 0).namespacedName,
      "minecraft:cobblestone_wall",
    );
  }

  {
    /*
     * What replaces a dropped block is the document's **empty space**, not air.
     * A break already writes it, and an underwater build coming back full of
     * bubbles would have lost exactly what that setting exists to preserve.
     */
    const session = newDocument({ width: 2, height: 2, length: 2 }, "sponge3", 4189);
    setSessionVoidBlock(session, "minecraft:water");
    setBlock(session.doc, 0, 0, 0, { namespacedName: "minecraft:deepslate", properties: {} });

    const refusal = thrown(() => setDocumentVersion(session, "JE_1_16_5"));
    check(
      "the refusal says what the block would become",
      refusal?.message.includes("minecraft:water") === true,
      refusal?.message ?? "",
    );
    setDocumentVersion(session, "JE_1_16_5", { dropUnrepresentable: true });
    equal(
      "...and that is what it becomes",
      getBlock(session.doc, 0, 0, 0).namespacedName,
      "minecraft:water",
    );
  }

  {
    /*
     * ...falling back to air when the empty space block is itself too new for
     * the target. `structure_void` is 1.10, so this is a real case rather than
     * a defensive one, and the alternative is writing a block the file cannot
     * hold in the course of making the file holdable.
     */
    const session = newDocument({ width: 2, height: 2, length: 2 }, "sponge3", 4903);
    setSessionVoidBlock(session, "minecraft:pale_hanging_moss");
    setBlock(session.doc, 0, 0, 0, { namespacedName: "minecraft:copper_chain", properties: {} });
    setDocumentVersion(session, "JE_1_16_5", { dropUnrepresentable: true });
    equal(
      "an empty space block the target lacks falls back to air",
      getBlock(session.doc, 0, 0, 0).namespacedName,
      "minecraft:air",
    );
  }

  {
    /*
     * Order. Doing existence before renaming is not a worse version of this --
     * it is the demolition the whole function exists to prevent: `iron_chain`
     * is genuinely absent from 1.16, and the correct answer is a name that
     * version has had since it shipped.
     */
    const session = newDocument({ width: 2, height: 2, length: 2 }, "sponge3", 4903);
    setBlock(session.doc, 0, 0, 0, { namespacedName: "minecraft:iron_chain", properties: {} });
    const result = setDocumentVersion(session, "JE_1_16_5");
    equal("a rename is resolved before existence is asked", result.dropped, 0);
    equal(
      "...so the chain survives a backport to 1.16.5",
      getBlock(session.doc, 0, 0, 0).namespacedName,
      "minecraft:chain",
    );
    // ...and one version earlier there is no chain at all, under either name.
    check(
      "...while 1.15.2, which has neither name, refuses",
      thrown(() => setDocumentVersion(session, "JE_1_15_2")) instanceof
        VersionWouldLoseBlocksError,
    );
  }
}

// --- a replace names a block, not one of its states -------------------------
/*
 * Reported as: whatever you try to replace, it says nothing matched.
 *
 * `from` was interned and compared as an exact palette index, so a bare name
 * matched only an entry carrying no properties at all -- and interning it
 * *added* that entry, leaving a dead row behind on every miss. The rest of the
 * codebase already assumed otherwise: it is the stated reason `replace_blocks`
 * parses its `from` with `toEntry` rather than `toPlacedEntry`.
 *
 * On a flat document it reads as an occasional puzzle. On a legacy one it is
 * total, and that is why it surfaced here: `legacy_blocks.json` gives a state
 * to 1,449 of its 1,682 rows, so a `.schematic` opens holding
 * `oak_fence[east=false,...]` and `grass_block[snowy=false]` and nothing a
 * person can type matches any of it.
 */
console.log("\n--- a replace names a block, not one of its states ---");
{
  const stateful = (facing: string) => ({
    namespacedName: "minecraft:oak_stairs",
    properties: { half: "bottom", shape: "straight", facing },
  });

  {
    const session = newDocument({ width: 4, height: 1, length: 4 });
    setBlock(session.doc, 0, 0, 0, stateful("north"));
    setBlock(session.doc, 1, 0, 0, stateful("south"));
    setBlock(session.doc, 2, 0, 0, stateful("east"));
    const before = session.doc.palette.length;

    equal(
      "a bare name matches every state of that block",
      applyEdit(session, {
        kind: "replace",
        region: { minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3 },
        from: { namespacedName: "minecraft:oak_stairs" },
        to: { namespacedName: "minecraft:stone" },
      }),
      3,
    );
    equal(
      "...leaving none of them behind",
      getBlock(session.doc, 1, 0, 0).namespacedName,
      "minecraft:stone",
    );
    check(
      "...and inventing no palette entry to do it",
      session.doc.palette.length <= before + 1,
      `${before} -> ${session.doc.palette.length}`,
    );
  }

  {
    /*
     * Spelling the state out still means exactly that state. That is how you
     * take out one stair orientation and leave the others, and it is the half
     * that must not be lost in making a bare name mean the block.
     */
    const session = newDocument({ width: 4, height: 1, length: 4 });
    setBlock(session.doc, 0, 0, 0, stateful("north"));
    setBlock(session.doc, 1, 0, 0, stateful("south"));
    equal(
      "a stated from matches only that state",
      applyEdit(session, {
        kind: "replace",
        region: { minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3 },
        from: stateful("north"),
        to: { namespacedName: "minecraft:stone" },
      }),
      1,
    );
    equal(
      "...and leaves the other one alone",
      getBlock(session.doc, 1, 0, 0).properties.facing,
      "south",
    );
  }

  {
    /*
     * A miss must intern nothing. Interning `from` to compare it added a row
     * for a block the schematic does not contain, on every failed replace.
     */
    const session = newDocument({ width: 2, height: 1, length: 2 });
    setBlock(session.doc, 0, 0, 0, { namespacedName: "minecraft:stone", properties: {} });
    const before = session.doc.palette.length;
    equal(
      "replacing something that is not there changes nothing",
      applyEdit(session, {
        kind: "replace",
        region: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 1 },
        from: { namespacedName: "minecraft:deepslate" },
        to: { namespacedName: "minecraft:stone" },
      }),
      0,
    );
    equal("...and adds no palette entry for it", session.doc.palette.length, before);
  }
}

{
  /*
   * The same thing against a real file, which is where it was found: a legacy
   * `.schematic` comes back with states on nearly everything, because that is
   * what a metadata value *means*.
   */
  const dir = await mkdtemp(path.join(tmpdir(), "sas-replace-"));
  try {
    const built = newDocument({ width: 4, height: 1, length: 4 }, "mcedit", 1343);
    for (let x = 0; x < 4; x += 1) {
      setBlock(built.doc, x, 0, 0, {
        namespacedName: "minecraft:oak_fence",
        properties: { east: "false", south: "false", north: "false", west: "false" },
      });
    }
    const saved = await saveSession(built, {
      filePath: path.join(dir, "replace.schematic"),
      format: "mcedit",
      legacyBlocksPath: LEGACY_BLOCKS,
    });

    const session = await openDocument(saved.filePath, { legacyBlocksPath: LEGACY_BLOCKS });
    check(
      "a reopened legacy file carries states on its blocks",
      Object.keys(getBlock(session.doc, 0, 0, 0).properties).length > 0,
      JSON.stringify(getBlock(session.doc, 0, 0, 0)),
    );
    equal(
      "...and the name a person types still matches them",
      applyEdit(session, {
        kind: "replace",
        region: { minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3 },
        from: { namespacedName: "minecraft:oak_fence" },
        to: { namespacedName: "minecraft:cobblestone" },
      }),
      4,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    closeDocument();
  }
}

// --- a legacy schematic refuses blocks that did not exist yet ---------------
/*
 * Reported as: on a .schematic you can place 1.13+ blocks. It was exactly that.
 *
 * Nothing in `applyEdit` had ever read the version. The only enforcement was
 * `buildMcEdit`, which throws over the whole palette when the user finally asks
 * to save -- a correct objection arriving hours late, about blocks that have
 * since been built around.
 */
console.log("\n--- a legacy schematic refuses blocks that did not exist yet ---");
{
  const names = legacyBlockNames(await loadLegacyBlockTable(LEGACY_BLOCKS));
  const legacy = { placeableNames: names, versionLabel: "1.12.2" };
  const refusal = (run: () => void): string | null => {
    try {
      run();
      return null;
    } catch (err) {
      return err instanceof BlockNotInVersionError
        ? err.message
        : `wrong error: ${String(err)}`;
    }
  };

  {
    const session = newDocument({ width: 4, height: 4, length: 4 }, "mcedit", 1343);
    const message = refusal(() =>
      applyEdit(
        session,
        { kind: "setBlock", x: 1, y: 1, z: 1, block: { namespacedName: "minecraft:deepslate" } },
        legacy,
      ),
    );
    check("placing a 1.13+ block is refused", message !== null);
    check("...naming the block", message?.includes("minecraft:deepslate") === true, message ?? "");
    check("...and the version", message?.includes("1.12.2") === true, message ?? "");
    /*
     * The way out is part of the message, and that is not politeness. Without
     * it this is a dead end that reads as the app refusing to let you build:
     * the schematic can have its version changed, and nothing else on screen
     * says so.
     */
    check("...and the way out", message?.includes("version") === true, message ?? "");
    equal("nothing was written", getBlock(session.doc, 1, 1, 1).namespacedName, "minecraft:air");
  }

  {
    // Fill and replace go through the same guard.
    const session = newDocument({ width: 4, height: 4, length: 4 }, "mcedit", 1343);
    check(
      "filling with one is refused too",
      refusal(() =>
        applyEdit(
          session,
          {
            kind: "fill",
            region: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
            block: { namespacedName: "minecraft:deepslate" },
          },
          legacy,
        ),
      ) !== null,
    );
    check(
      "...and replacing into one",
      refusal(() =>
        applyEdit(
          session,
          {
            kind: "replace",
            region: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
            from: { namespacedName: "minecraft:stone" },
            to: { namespacedName: "minecraft:deepslate" },
          },
          legacy,
        ),
      ) !== null,
    );
  }

  {
    /*
     * The **from** of a replace is deliberately not guarded.
     *
     * It is a pattern over what is already in the document, not something being
     * written. Refusing it would make: take out the block some other tool put
     * here, impossible -- which is precisely when somebody needs it.
     */
    const session = newDocument({ width: 4, height: 4, length: 4 }, "mcedit", 1343);
    equal(
      "searching for a block the version cannot hold is allowed",
      applyEdit(
        session,
        {
          kind: "replace",
          region: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
          from: { namespacedName: "minecraft:deepslate" },
          to: { namespacedName: "minecraft:stone" },
        },
        legacy,
      ),
      0,
    );
  }

  {
    /*
     * **Names, not states**, and that is the line rather than a shortcut.
     *
     * `buildMcEdit` treats a missing *name* as fatal and a state it cannot
     * carry as `degraded` -- written as the base block and reported. So a
     * waterlogged fence is a legal thing to build on a 1.12 schematic and a
     * documented lossy save, not a mistake. Guarding states here would refuse
     * it, and the editor would be stricter than the writer for no reason.
     */
    const session = newDocument({ width: 4, height: 4, length: 4 }, "mcedit", 1343);
    equal(
      "a state the format cannot carry is still placed",
      applyEdit(
        session,
        {
          kind: "setBlock",
          x: 1,
          y: 1,
          z: 1,
          block: { namespacedName: "minecraft:oak_fence", properties: { waterlogged: "true" } },
        },
        legacy,
      ),
      1,
    );
    equal(
      "...as the block it names",
      getBlock(session.doc, 1, 1, 1).namespacedName,
      "minecraft:oak_fence",
    );
  }

  {
    // Air is always allowed: a document you cannot empty a cell in is not an
    // editor, and a break is how air gets written.
    const session = newDocument({ width: 4, height: 4, length: 4 }, "mcedit", 1343);
    setBlock(session.doc, 1, 1, 1, { namespacedName: "minecraft:stone", properties: {} });
    equal(
      "breaking a block still works",
      applyEdit(
        session,
        { kind: "setBlock", x: 1, y: 1, z: 1, block: { namespacedName: "minecraft:air" } },
        legacy,
      ),
      1,
    );
  }

  {
    /*
     * And a flat document is not restricted at all. This app has no per-block
     * introduction data above 1.13, so there is nothing honest to check
     * against -- and hiding a block that does exist is the one failure a user
     * cannot work around.
     */
    const session = newDocument({ width: 4, height: 4, length: 4 }, "sponge3", 3700);
    equal(
      "a flat document places whatever it likes",
      applyEdit(session, {
        kind: "setBlock",
        x: 1,
        y: 1,
        z: 1,
        block: { namespacedName: "minecraft:deepslate" },
      }),
      1,
    );
  }
}

// --- which era a document is in ---------------------------------------------
/*
 * The keystone, and the one worth checking hardest: four separate features
 * read this answer, and when it is wrong they are all wrong quietly.
 *
 * The failure it replaces: a `.schematic` loaded from disk has no DataVersion
 * -- MCEdit has no such tag -- so `versionNameOf` gave `null`, `eraOf("")`
 * gave its permissive `flat`, and every legacy schematic in the app presented
 * itself as 1.13+. The inventory offered it deepslate and the editor placed
 * it; the objection arrived at save time, from `buildMcEdit`, a long way from
 * the click.
 */
console.log("\n--- which era a document is in ---");
{
  // Every way a document can come to exist, as a table. The pairs are what
  // each path really produces -- the block below builds two of them for real.
  const cases: [string, SchematicFormat, number | null, string][] = [
    ["a 1.12 .schematic off disk", "mcedit", null, "legacy"],
    ["a Sponge file with a tag", "sponge3", 3700, "flat"],
    ["a Sponge file that omitted the tag", "sponge2", null, "flat"],
    ["a .litematic, which must carry one", "litematic", 4189, "flat"],
    ["a .mcfunction, read as Sponge v3", "sponge3", null, "flat"],
    ["a new document at 1.12.2", "mcedit", 1343, "legacy"],
    ["a new document at 1.8.8", "mcedit", null, "legacy"],
    ["a modern build saved as MCEdit", "mcedit", 3700, "flat"],
  ];
  for (const [label, format, dataVersion, era] of cases) {
    equal(label, documentEra(format, dataVersion), era);
  }

  /*
   * The last row is what makes this more than a format check.
   *
   * Keying the era on the container alone is the tempting one-liner, and it is
   * wrong in the direction that costs something: saving a modern build as
   * MCEdit is a legitimate lossy thing to do -- it is what `degraded` reports
   * on -- and reading that document as legacy would refuse every block in it.
   */
  check(
    "the era is not decided by the container alone",
    documentEra("mcedit", 3700) !== documentEra("mcedit", null),
  );

  // The version name falls back inside the document's own era rather than to a
  // global default, which for a legacy file would be a flat version displayed
  // against it.
  equal(
    "a legacy file with no tag names one anyway",
    documentVersionName("mcedit", null),
    DEFAULT_LEGACY_VERSION,
  );
  equal(
    "...and that name is itself legacy",
    documentEra("mcedit", dataVersionOf(DEFAULT_LEGACY_VERSION)),
    "legacy",
  );
  equal("a flat file with no tag names none", documentVersionName("sponge3", null), null);
  equal("an exact tag wins over the fallback", documentVersionName("mcedit", 1343), "JE_1_12_2");
}

{
  /*
   * The same rule against a real file rather than a table, because the pairs
   * above are only true if the loader really produces them.
   */
  const dir = await mkdtemp(path.join(tmpdir(), "sas-era-"));
  try {
    const built = newDocument({ width: 4, height: 4, length: 4 }, "sponge3", 3700);
    applyEdit(built, {
      kind: "setBlock",
      x: 1,
      y: 1,
      z: 1,
      block: { namespacedName: "minecraft:stone" },
    });
    equal(
      "a new Sponge document is flat",
      documentEra(built.doc.format, built.doc.dataVersion),
      "flat",
    );

    const saved = await saveSession(built, {
      filePath: path.join(dir, "era.schematic"),
      format: "mcedit",
      legacyBlocksPath: LEGACY_BLOCKS,
    });
    const reopened = await openDocument(saved.filePath, { legacyBlocksPath: LEGACY_BLOCKS });
    equal("an MCEdit file comes back with no DataVersion", reopened.doc.dataVersion, null);
    equal("...and in the mcedit container", reopened.doc.format, "mcedit");
    equal(
      "...so it reads as legacy, which is what it now is",
      documentEra(reopened.doc.format, reopened.doc.dataVersion),
      "legacy",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    closeDocument();
  }
}


console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
