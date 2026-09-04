/**
 * Redesign-slice validation harness (ARCHITECTURE.md §6 item 3).
 *
 * Same shape and spirit as `smoke.ts`: cheap, headless, real execution. Covers
 * the new main-process services that do NOT need an Electron app object --
 * `schematic.ts`, `versions.ts`, `preview.ts`, and the pure helpers in
 * `llm.ts`/`opencode.ts`/`generate.ts`/`artifacts.ts`.
 *
 * The centrepiece is the schematic **round-trip**: write placements with the
 * new `SpongeSchematicWriter`, read them back with `pipeline/loader.ts`, and
 * require an exact match. That is a real referee rather than a self-consistency
 * check, because `loader.ts` was parity-verified against the Python
 * implementation at Step 6 -- if the writer emits a malformed or
 * differently-ordered schematic, the already-trusted reader disagrees.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { createServer } from "http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

import { loadStructure } from "../src/main/pipeline/loader.js";
import { IPC, openCodeModelRequiresKey } from "../src/shared/ipc.js";
import { rememberedFromIndex } from "../src/main/services/conversation_core.js";
import {
  adoptSubject,
  appendEntry,
  conversationMessages,
  conversationState,
  deleteConversation,
  listConversations,
  newConversation,
  noteTurn,
  openConversation,
  resetConversation,
  saveConversation,
  useConversationDirectory,
} from "../src/main/services/conversation.js";
import {
  readHotbar,
  useHotbarDirectory,
  writeHotbar,
} from "../src/main/services/hotbars.js";
import {
  abridgeTrace,
  coerceProject,
  coerceRecord,
  MAX_STORED_TRACE_TEXT,
  mostRecent,
  storeFileName,
  titleFor,
} from "../src/main/services/conversation_store.js";
import type { ChatEntry, RecentDocument } from "../src/shared/ipc.js";
import { callLlm, LlmError, resolveBaseUrl } from "../src/main/services/llm.js";
import { describeFor, sanitizeName } from "../src/main/services/naming.js";
import {
  coerceRecents,
  forgetRecent,
  rememberRecent,
} from "../src/main/services/recent_documents.js";
import {
  assertWritableDirectory,
  OutputDirectoryError,
  resolveOutputPath,
} from "../src/main/services/output.js";
import { labelFor, mergeCatalogue } from "../src/main/services/opencode.js";
import {
  clipboardMesh,
  closeDocument,
  cutSelection,
  newDocument,
  regionMesh,
} from "../src/main/services/session.js";
import {
  atlasBuildCount,
  buildDocumentPreview,
  buildPreview,
  clearBakerCache,
  clearPreviewCache,
  sunAnglesRadians,
} from "../src/main/services/preview.js";
import {
  createDocument,
  documentFromLoaded,
  setBlock,
  setBlockEntity,
} from "../src/main/domain/document.js";
import { SpongeSchematicWriter } from "../src/main/services/schematic.js";
import { loadSkyTextures } from "../src/main/services/sky_textures.js";
import { dataVersionFor, VERSION_NAMES, VERSION_TABLE } from "../src/main/services/versions.js";
import {
  coerceEditing,
  coerceMcp,
  coerceSettings,
  coerceHotbar,
  coerceUi,
} from "../src/main/services/settings_coerce.js";
import { discardPrompt } from "../src/main/services/discard_prompt.js";
import {
  failurePrompt,
  failureReport,
  issueBody,
  issueUrl,
} from "../src/main/services/failure_prompt.js";
import {
  buildBlockIcons,
  forgetBlockIcons,
  warmBlockIcons,
} from "../src/main/services/block_icons.js";
import {
  addSnapshot,
  coerceSnapshots,
  MAX_SNAPSHOTS,
  order,
  removeSnapshot,
  snapshotLabel,
  type Snapshot,
} from "../src/main/services/snapshots_core.js";
import {
  APP_NAME,
  escapeMenuLabel,
  menuModel,
  recentLabels,
  windowTitle,
  type MenuItemModel,
} from "../src/main/menu_model.js";
import {
  extentVolume,
  growthToInclude,
  orderRegion,
  shiftRegion,
} from "../src/main/domain/grow.js";
import {
  DEFAULT_EDITING_SETTINGS,
  normaliseVoidBlock,
  DEFAULT_HOTBAR,
  HOTBAR_SLOTS,
  type Hotbar,
  DEFAULT_MCP_SETTINGS,
  bindAddressRefusal,
  isLoopbackAddress,
  DEFAULT_SETTINGS,
  DEFAULT_UI_SETTINGS,
  SIDEBAR_WIDTH,
  VOID_OPACITY,
  type EditingSettings,
  type McpSettings,
  type Settings,
  type UiSettings,
} from "../src/shared/settings.js";
import { MC_VERSIONS, eraOf, resolveVersionName } from "../src/shared/mc_versions.js";

/**
 * Mirrors `services/resources.ts`'s `defaultResourcePackPath()` without pulling
 * in Electron: same directory, same "first .zip wins" rule.
 */
async function findBundledResourcePack(): Promise<string | null> {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "resources");
  try {
    const zips = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".zip")).sort();
    return zips.length > 0 ? path.join(dir, zips[0]) : null;
  } catch {
    return null;
  }
}


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
    console.log(`  FAIL: ${label}`);
    if (detail) console.log(`         ${detail}`);
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

import { apiKeyRefusal } from "../src/main/services/llm_key.js";
import {
  orphanedProfile,
  type OrphanedProfile,
} from "../src/main/services/legacy_profile.js";

console.log("=== Schematic AI Studio redesign-slice service smoke test ===\n");

const workDir = await mkdtemp(path.join(tmpdir(), "bgpt-smoke-"));

try {
  // --- versions.ts ---------------------------------------------------------
  console.log("--- versions ---");
  check("version table is non-empty", VERSION_NAMES.length > 0);
  check("default version is present", "JE_1_20_4" in VERSION_TABLE);
  equal("JE_1_20_4 -> DataVersion 3700", dataVersionFor("JE_1_20_4"), 3700);
  check(
    "unknown version throws",
    (() => {
      try {
        dataVersionFor("JE_9_9_9");
        return false;
      } catch {
        return true;
      }
    })(),
  );

  // --- schematic.ts round-trip through the parity-verified loader ----------
  console.log("\n--- schematic write -> loader read round-trip ---");
  const writer = new SpongeSchematicWriter();
  const placements: Array<readonly [number, number, number, string]> = [
    [0, 0, 0, "minecraft:stone"],
    [1, 0, 0, "minecraft:oak_planks"],
    [2, 0, 0, "minecraft:stone"],
    [0, 1, 0, "minecraft:glass"],
    [0, 0, 1, "minecraft:oak_stairs[facing=east,half=bottom]"],
  ];
  for (const [x, y, z, block] of placements) {
    writer.setBlock([x, y, z], block);
  }
  equal("writer holds 5 blocks", writer.blockCount, 5);

  const schemPath = await writer.save(workDir, "roundtrip", dataVersionFor("JE_1_20_4"));

  // `generate.ts` no longer calls `save()`: it asks `output.ts` for the target
  // path (so a collision can be backed up first) and writes `toBytes()` there.
  // These two must stay byte-identical or that swap silently changed the file.
  check(
    "toBytes() matches what save() writes",
    Buffer.compare(
      await readFile(schemPath),
      await writer.toBytes(dataVersionFor("JE_1_20_4")),
    ) === 0,
  );
  const structure = await loadStructure(schemPath);

  equal("bounds width  (x: 0..2)", structure.bounds.maxX - structure.bounds.minX + 1, 3);
  equal("bounds height (y: 0..1)", structure.bounds.maxY - structure.bounds.minY + 1, 2);
  equal("bounds length (z: 0..1)", structure.bounds.maxZ - structure.bounds.minZ + 1, 2);

  const height = structure.bounds.maxY - structure.bounds.minY + 1;
  const length = structure.bounds.maxZ - structure.bounds.minZ + 1;
  // Flat-index formula per RULEBOOK.md §2: x * height * length + y * length + z.
  const at = (x: number, y: number, z: number) => {
    const entry = structure.palette[structure.voxels[x * height * length + y * length + z]];
    if (!entry) return "<missing>";
    const props = Object.entries(entry.properties);
    if (props.length === 0) return entry.namespacedName;
    return `${entry.namespacedName}[${props.map(([k, v]) => `${k}=${v}`).join(",")}]`;
  };

  for (const [x, y, z, block] of placements) {
    equal(`voxel (${x},${y},${z}) === ${block}`, at(x, y, z), block);
  }
  equal("unset voxel (1,1,1) is air", at(1, 1, 1), "minecraft:air");

  // --- preview.ts ----------------------------------------------------------
  console.log("\n--- preview ---");
  // The bundled pack is normally resolved by the IPC handler through
  // `defaultResourcePackPath()`, which needs Electron. Resolve it directly here
  // so this suite keeps exercising the textured path instead of silently
  // degrading to flat colours.
  const bundledPack = await findBundledResourcePack();
  check("bundled default resource pack is present", bundledPack !== null);

  const preview = await buildPreview({
    schemPath,
    resourcePackPath: null,
    fallbackResourcePackPath: bundledPack,
  });
  check("the mesh has geometry", preview.mesh.chunks.length > 0);
  check(
    "...with vertices in it",
    preview.mesh.chunks.every((chunk) => chunk.positions.length > 0),
  );
  // Raw RGBA, not a PNG: nothing for the renderer to decode, which is what
  // let `connect-src` become 'none'.
  check("...and an atlas of raw pixels", preview.mesh.atlas !== null);
  check(
    "...sized exactly width * height * 4",
    preview.mesh.atlas !== null &&
      preview.mesh.atlas.pixels.length === preview.mesh.atlas.width * preview.mesh.atlas.height * 4,
  );
  check("first build is not cached", preview.cached === false);
  const cachedPreview = await buildPreview({
    schemPath,
    resourcePackPath: null,
    fallbackResourcePackPath: bundledPack,
  });
  check("second build hits the cache", cachedPreview.cached === true);
  check(
    "cached GLB is byte-identical",
    meshDigest(preview.mesh) === meshDigest(cachedPreview.mesh),
  );

  // Proves the bundled pack is actually *applied*, not merely accepted: with it,
  // the atlas carries real block textures; without it, flat colours. A wiring
  // regression would make these two identical.
  clearPreviewCache();
  const untextured = await buildPreview({
    schemPath,
    resourcePackPath: null,
    fallbackResourcePackPath: null,
  });
  check(
    "bundled pack changes the render (textures vs flat colours)",
    meshDigest(preview.mesh) !== meshDigest(untextured.mesh),
  );

  // --- previewing an open document -----------------------------------------
  //
  // The edit loop. What matters is that it produces the same picture as the
  // file-based path -- otherwise editing and re-opening would disagree -- and
  // that it stays out of the resource pack, which is what makes it fast enough
  // to run after every change.
  console.log("\n--- document preview ---");
  {
    clearPreviewCache();
    clearBakerCache();

    const doc = documentFromLoaded(await loadStructure(schemPath), schemPath);
    const fromDocument = await buildDocumentPreview(doc, {
      resourcePackPath: null,
      fallbackResourcePackPath: bundledPack,
    });
    // Byte equality, and it holds only because this fixture is 3x3x3 and fits
    // inside a single 16-block chunk, so the chunked path emits its geometry in
    // the same order the whole-structure path does. Enlarge the fixture past
    // one chunk and the orders diverge while both stay correct — which is why
    // the bounds check below is the one that generalises, and why
    // `tests/chunks.ts` compares the chunked path against itself.
    check(
      "a single-chunk document renders byte-identically to the file it came from",
      meshDigest(preview.mesh) === meshDigest(fromDocument.mesh),
    );
    equal("...with the same bounds", fromDocument.size, preview.size);
    equal("...and the whole structure fits in one chunk, as assumed above", fromDocument.totalChunks, 1);

    // An edit has to change the picture, or the whole loop is decorative.
    // (2,1,1) is empty in the fixture above; asserting the write landed keeps
    // this from passing on a no-op, which is exactly how it failed first time.
    check(
      "the test edit actually writes a block",
      setBlock(doc, 2, 1, 1, { namespacedName: "minecraft:glass", properties: {} }) !== null,
    );
    const afterEdit = await buildDocumentPreview(doc, {
      resourcePackPath: null,
      fallbackResourcePackPath: bundledPack,
    });
    check(
      "editing a block changes the render",
      meshDigest(fromDocument.mesh) !== meshDigest(afterEdit.mesh),
    );

    /*
     * Block icons, and the property that was broken: every geometry in one
     * batch has to address the atlas that comes back with it.
     *
     * The baker decodes a texture the first time a block asks for it, and the
     * atlas version *is* the texture count -- so meshing blocks one after
     * another produced a geometry per block, each with UVs into a different
     * layout, and one atlas to draw them all with. All but the last were wrong.
     *
     * The referee is a second call. Once everything is decoded the atlas cannot
     * grow, so a settled first call must produce exactly what the second one
     * does. Before the fix the first call's UVs were built against atlases that
     * no longer existed and the two disagreed.
     */
    console.log("\n--- block icons ---");
    forgetBlockIcons();
    clearBakerCache();
    const iconBlocks = [
      "minecraft:stone",
      "minecraft:oak_planks",
      "minecraft:glass",
      "minecraft:oak_stairs",
      "minecraft:cobblestone",
      "minecraft:sandstone",
      "minecraft:bricks",
      "minecraft:oak_log",
    ];
    const iconOptions = { resourcePackPath: null, fallbackResourcePackPath: bundledPack };

    const firstPass = await buildBlockIcons(iconBlocks, iconOptions, null);
    const secondPass = await buildBlockIcons(iconBlocks, iconOptions, firstPass.atlasVersion);

    equal("every block asked for comes back", firstPass.icons.length, iconBlocks.length);
    check("the first batch carries its atlas", firstPass.atlas !== null);
    equal(
      "a caller that already holds the atlas is not sent it again",
      secondPass.atlas,
      null,
    );
    equal("the atlas has settled between calls", secondPass.atlasVersion, firstPass.atlasVersion);

    const uvsOf = (result: typeof firstPass): string =>
      result.icons.map((icon) => (icon.geometry === null ? "-" : [...icon.geometry.uvs].join(","))).join("|");
    check(
      "every icon in a batch addresses the atlas that came with it",
      uvsOf(firstPass) === uvsOf(secondPass),
      "the first pass meshed against an atlas that was still growing",
    );

    check(
      "and they are real geometry, not empty",
      firstPass.icons.every((icon) => icon.geometry !== null && icon.geometry.indices.length > 0),
    );

    /*
     * And the cost of that guarantee, which is the part that was catastrophic
     * and invisible.
     *
     * Packing the atlas is O(every texture decoded so far), and the texture set
     * grows as blocks are asked for -- so the priming pass, which used to make
     * the atlas stop moving by *meshing* every block and discarding it, packed
     * the atlas once per block over an ever-larger set. On the real 920-block
     * list that was 38.7 seconds of the 39 the warm-up took; decoding every
     * texture is ~740 ms and packing once is ~150 ms.
     *
     * Nothing about that reads as a defect from the outside: it is the right
     * picture, slowly. So the referee is a counter, and it is exact -- "once",
     * not "not too many", because there is no reason for a second.
     */
    /*
     * The sun and the moon, which come from the pack and from nowhere near the
     * blocks -- `textures/environment/`, never asked for by anything that
     * meshes. The check that matters is that the moon is *cropped*: the file is
     * eight phases in a four-by-two grid, and drawing the sheet whole would put
     * a strip of eight moons in the sky.
     */
    console.log("\n--- the sun and the moon ---");
    {
      const art = await loadSkyTextures(null, bundledPack);
      check("the pack has a sun", art.sun !== null);
      check("...and a moon", art.moon !== null);
      if (art.sun && art.moon) {
        check("the sun is square", art.sun.width === art.sun.height);
        check(
          "the sun's pixels are RGBA and all there",
          art.sun.pixels.length === art.sun.width * art.sun.height * 4,
        );
        check(
          "the moon is one phase, not the sheet",
          art.moon.width === art.moon.height,
          `${art.moon.width}x${art.moon.height}`,
        );
        check(
          "...and its pixels match its size",
          art.moon.pixels.length === art.moon.width * art.moon.height * 4,
        );
      }
    }

    console.log("\n--- and it packs the atlas once ---");
    forgetBlockIcons();
    clearBakerCache();
    const packedBefore = atlasBuildCount();
    await warmBlockIcons(iconBlocks, iconOptions);
    equal(
      "warming packs the atlas once, not once per block",
      atlasBuildCount() - packedBefore,
      1,
    );

    /*
     * A sign says what it says, on the *first* preview.
     *
     * A glyph is an atlas tile like any other, and the atlas is packed once,
     * before the chunks are meshed — so a letter first cut during meshing lands
     * in a layout the mesh has no UVs into, and `buildMesh` drops every face
     * whose key the atlas has never heard of. The visible result is a sign that
     * is blank until something else happens to re-mesh its chunk, which reads
     * as "sometimes the text does not load". `primeBaker` cuts them first, and
     * this is the check that says so: the same document, with and without words
     * on the sign, has to render differently the first time it is asked.
     */
    console.log("\n--- a sign says what it says ---");
    {
      const written = (line: string) => {
        const doc = createDocument({ width: 1, height: 1, length: 1, format: "sponge3" });
        setBlock(doc, 0, 0, 0, {
          namespacedName: "minecraft:oak_sign",
          properties: { rotation: "0" },
        });
        setBlockEntity(doc, 0, 0, 0, {
          id: "minecraft:sign",
          pos: [0, 0, 0],
          nbt: {
            front_text: {
              type: "compound",
              value: {
                messages: {
                  type: "list",
                  value: { type: "string", value: [JSON.stringify({ text: line }), "", "", ""] },
                },
                color: { type: "string", value: "black" },
              },
            },
          },
        });
        return doc;
      };
      const options = { resourcePackPath: null, fallbackResourcePackPath: bundledPack };

      clearBakerCache();
      const blank = await buildDocumentPreview(written(""), options);
      clearBakerCache();
      const says = await buildDocumentPreview(written("Ciao"), options);
      check(
        "text on a sign is drawn the first time it is previewed",
        says.mesh.chunks[0].positions.length > blank.mesh.chunks[0].positions.length,
        `${says.mesh.chunks[0].positions.length} vs ${blank.mesh.chunks[0].positions.length}`,
      );

      // ...and it is the same picture on the second pass, which is what says
      // the first one was not built against a layout that had since moved.
      const again = await buildDocumentPreview(written("Ciao"), options);
      check("...and identically the second time", meshDigest(says.mesh) === meshDigest(again.mesh));
    }

    /*
     * Barriers, and the setting that decides whether they are drawn.
     *
     * They are invisible to a player and placed on purpose -- a barrier keeps
     * people out of somewhere -- so the builder is the one person who needs to
     * see them, and the default is deliberately not the game's own view.
     * Turning it off has to reach the *mesher*, not the viewer: a drawn barrier
     * has to stop culling its neighbours, which is a meshing decision.
     */
    console.log("\n--- markers ---");
    {
      const markers = createDocument({ width: 2, height: 1, length: 1, format: "sponge3" });
      setBlock(markers, 0, 0, 0, { namespacedName: "minecraft:stone", properties: {} });
      setBlock(markers, 1, 0, 0, { namespacedName: "minecraft:barrier", properties: {} });

      const shown = await buildDocumentPreview(markers, {
        resourcePackPath: null,
        fallbackResourcePackPath: bundledPack,
        showMarkers: true,
      });
      const hidden = await buildDocumentPreview(markers, {
        resourcePackPath: null,
        fallbackResourcePackPath: bundledPack,
        showMarkers: false,
      });

      const triangles = (mesh: { chunks: { indices: Uint32Array }[] }): number =>
        mesh.chunks.reduce((total, chunk) => total + chunk.indices.length, 0);

      check("a barrier is drawn when markers are shown", triangles(shown.mesh) > 0);
      check(
        "hiding them leaves less geometry, not the same",
        triangles(hidden.mesh) < triangles(shown.mesh),
        `${triangles(hidden.mesh)} vs ${triangles(shown.mesh)}`,
      );
      check(
        "...and the stone beside it survives either way",
        triangles(hidden.mesh) > 0,
        "hiding markers took the whole document with it",
      );
    }

    // The baker cache is the point of the exercise. Reading the bundled pack is
    // ~17 MB of zip and dominates a cold build; a warm rebuild must not do it
    // again. Timing is a blunt instrument, so the bar is deliberately loose --
    // it is there to catch the cache being bypassed entirely, not to police
    // milliseconds on a busy machine.
    clearBakerCache();
    const coldStart = Date.now();
    await buildDocumentPreview(doc, {
      resourcePackPath: null,
      fallbackResourcePackPath: bundledPack,
    });
    const cold = Date.now() - coldStart;

    setBlock(doc, 1, 1, 1, { namespacedName: "minecraft:stone", properties: {} });
    const warmStart = Date.now();
    await buildDocumentPreview(doc, {
      resourcePackPath: null,
      fallbackResourcePackPath: bundledPack,
    });
    const warm = Date.now() - warmStart;
    check(
      "a warm rebuild is substantially faster than a cold one",
      warm * 2 < cold,
      `cold ${cold} ms, warm ${warm} ms`,
    );
  }

  /*
   * Over the defaults rather than a hand-written literal: this call only cares
   * about two of the fields, and listing the rest meant the literal drifted out
   * of date every time `PreviewSettings` grew -- silently, because tests/ was
   * not typechecked.
   */
  const sun = sunAnglesRadians({
    ...DEFAULT_SETTINGS.preview,
    sunAzimuthDeg: 180,
    sunElevationDeg: 90,
  });
  check("180 deg -> pi rad", Math.abs(sun.azimuth - Math.PI) < 1e-12);
  check("90 deg -> pi/2 rad", Math.abs(sun.elevation - Math.PI / 2) < 1e-12);

  // --- output.ts: naming and the backup-on-collision rule ------------------
  console.log("\n--- output directory ---");
  const outDir = path.join(workDir, "out");

  const first = await resolveOutputPath(outDir, "castle", "schem", new Date("2026-08-09T14:30:00Z"));
  equal("fresh name needs no backup", first.backedUpTo, null);
  equal("path is <dir>/<name>.<ext>", path.basename(first.filePath), "castle.schem");
  await writeFile(first.filePath, "original", "utf-8");

  const second = await resolveOutputPath(outDir, "castle", "schem", new Date("2026-08-09T14:30:00Z"));
  equal("collision reuses the same target path", second.filePath, first.filePath);
  equal(
    "the previous file is renamed, not deleted",
    second.backedUpTo === null ? null : path.basename(second.backedUpTo),
    "castle.2026-08-09T14-30-00.bak.schem",
  );
  check("no colons in the backup name (illegal on Windows)", !path.basename(second.backedUpTo ?? "").includes(":"));
  equal(
    "the backup still holds the original bytes",
    await readFile(second.backedUpTo ?? "", "utf-8"),
    "original",
  );
  check("the target path is free again", !existsSync(second.filePath));

  check(
    "an unwritable output folder is rejected at selection time",
    await (async () => {
      try {
        // A path *under an existing file* can never be a directory, on any
        // platform. It has to be the backup: `first.filePath` was renamed away
        // a few lines above, so mkdir -p would happily create it.
        await assertWritableDirectory(path.join(second.backedUpTo ?? "", "nope"));
        return false;
      } catch (err) {
        return err instanceof OutputDirectoryError;
      }
    })(),
  );
  check(
    "a writable folder leaves no probe file behind",
    await (async () => {
      await assertWritableDirectory(outDir);
      return (await readdir(outDir)).every((n) => !n.startsWith(".schematic-ai-studio-write-test"));
    })(),
  );

  // --- llm.ts / opencode.ts / generate.ts pure helpers ---------------------
  console.log("\n--- helpers ---");
  equal(
    "OpenAI default base URL",
    resolveBaseUrl("OpenAI", ""),
    "https://api.openai.com/v1",
  );
  equal("explicit base URL wins", resolveBaseUrl("OpenAI", "https://x.test/v1"), "https://x.test/v1");
  check(
    "Custom provider without a base URL fails loudly",
    (() => {
      try {
        resolveBaseUrl("Custom (OpenAI Compatible)", "  ");
        return false;
      } catch (err) {
        return err instanceof LlmError;
      }
    })(),
  );

  equal("free model label", labelFor("mimo-v2.5-free"), "mimo-v2.5-free (Gratuito)");
  equal("paid thinking label", labelFor("gpt-5-reasoning"), "gpt-5-reasoning (A pagamento | Thinking)");

  // --- opencode.ts: the catalogue merge -------------------------------------
  //
  // Offline by construction: `mergeCatalogue` is pure, and these payloads are
  // trimmed copies of what the two real sources return. Zen's `/models` gives
  // ids and nothing else; models.dev gives cost and modalities. What is being
  // asserted is the classification, since it now decides whether an API key is
  // demanded and whether a reference image may be sent.
  console.log("\n--- opencode catalogue ---");
  const liveIds = ["gpt-5.5", "mimo-v2.5-free", "big-pickle", "brand-new-model"];
  const metadata = {
    "gpt-5.5": {
      name: "GPT-5.5",
      cost: { input: 5, output: 30 },
      modalities: { input: ["text", "image", "pdf"] },
      limit: { context: 400000 },
    },
    "mimo-v2.5-free": {
      name: "MiMo V2.5 Free",
      cost: { input: 0, output: 0 },
      modalities: { input: ["text", "image", "audio", "video"] },
    },
    "big-pickle": {
      name: "Big Pickle",
      cost: { input: 0, output: 0 },
      modalities: { input: ["text"] },
    },
  };
  const catalogue = mergeCatalogue(liveIds, metadata);
  const byId = new Map(catalogue.map((model) => [model.id, model]));

  equal("every live id survives the merge", catalogue.length, liveIds.length);
  equal("zero cost means free", byId.get("mimo-v2.5-free")?.pricing, "free");
  equal("non-zero cost means paid", byId.get("gpt-5.5")?.pricing, "paid");
  equal("image modality is detected", byId.get("mimo-v2.5-free")?.imageInput, "yes");
  equal("text-only is detected", byId.get("big-pickle")?.imageInput, "no");
  equal("context window is carried through", byId.get("gpt-5.5")?.contextTokens, 400000);

  // An id models.dev has not caught up with must still be selectable, and must
  // fail *open*: gating it behind a key would turn a metadata gap into "this
  // model is unusable".
  equal("an unknown id still appears", byId.get("brand-new-model")?.pricing, "unknown");
  equal("an unknown id gets a readable name", byId.get("brand-new-model")?.name, "Brand New Model");
  check("an unknown id is not gated behind a key", !openCodeModelRequiresKey(byId.get("brand-new-model")));
  check("a paid model is gated behind a key", openCodeModelRequiresKey(byId.get("gpt-5.5")));
  check("a free model is not gated behind a key", !openCodeModelRequiresKey(byId.get("mimo-v2.5-free")));

  equal("free models sort ahead of paid", catalogue[0]?.pricing, "free");
  equal("paid models sort last", catalogue[catalogue.length - 1]?.pricing, "paid");

  // The whole models.dev fetch failing is not the same as the gateway failing:
  // the model list must still come back, just without the facts.
  const noMetadata = mergeCatalogue(liveIds, null);
  equal("no metadata still yields every model", noMetadata.length, liveIds.length);
  check(
    "no metadata means everything is unknown, not everything is paid",
    noMetadata.every((model) => model.pricing === "unknown"),
  );

  // The vendored snapshot is what makes that case rare; if it stops parsing,
  // the offline fallback is silently gone.
  const snapshot = JSON.parse(
    await readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "resources", "opencode_models.json"),
      "utf-8",
    ),
  ) as { models?: Record<string, { cost?: { input?: number; output?: number } }> };
  check("the bundled models.dev snapshot parses", typeof snapshot.models === "object");
  check(
    "the snapshot knows about free models",
    Object.values(snapshot.models ?? {}).some((m) => m.cost?.input === 0 && m.cost?.output === 0),
  );

  // --- llm.ts: the OpenCode transport ---------------------------------------
  //
  // A real `callLlm` against a throwaway OpenAI-compatible server on localhost.
  // Offline, but not a stub of our own code: the AI SDK really builds the
  // request, so anything it rejects fails here rather than in front of a user.
  //
  // It exists because a whole class of defect is invisible to the pure-helper
  // checks above and to typecheck. AI SDK 7 forbids `{role:"system"}` inside
  // `messages` -- the system prompt belongs in `instructions` -- yet
  // `ModelMessage` still admits that role, because an opt-in flag can re-enable
  // it. So the wrong spelling compiled cleanly and threw `InvalidPromptError`
  // on every single generation. What follows pins both halves: the request is
  // accepted, and the system prompt still arrives as a system message on the
  // wire.
  console.log("\n--- LLM transport: four providers, one client ---");
  let captured: { messages?: Array<{ role: string; content: unknown }> } | null = null;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      captured = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      /*
       * Server-sent events, because `callLlm` streams now -- it has to, or the
       * generation panel could not show the build script being written. The
       * answer is split across two deltas for the same reason the agent's mock
       * splits its text: a single chunk would pass while proving nothing about
       * reassembly.
       */
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
      const head = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "mimo-v2.5-free" };
      res.write(frame({ ...head, choices: [{ index: 0, delta: { role: "assistant", content: "builder." } }] }));
      res.write(frame({ ...head, choices: [{ index: 0, delta: { content: "setBlock(0,0,0)" } }] }));
      res.write(
        frame({
          ...head,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  // Every provider goes through one transport now, so every provider gets the
  // same referee: a real HTTP server that records what actually went out. The
  // three that used to take the hand-rolled `fetch` path are the point -- they
  // are the ones the change could have broken, and the ones that could not do
  // tool calling before it.
  for (const provider of [
    "OpenCode",
    "OpenAI",
    "Google Gemini",
    "Custom (OpenAI Compatible)",
  ] as const) {
    captured = null;
    try {
      const answer = await callLlm({
        provider,
        model: "test-model",
        apiKey: provider === "OpenCode" ? "" : "sk-test",
        // Every provider is pointed at the local server: what is being checked
        // is the transport, not where each one lives by default.
        baseUrl: `http://127.0.0.1:${port}/v1`,
        systemPrompt: "You are a Minecraft builder.",
        userPrompt: "a small stone tower",
      });
      equal(`${provider} returns the assistant text`, answer, "builder.setBlock(0,0,0)");
    } catch (err) {
      check(
        `${provider} request is accepted (${err instanceof Error ? err.message : String(err)})`,
        false,
      );
    }

    const sent =
      (captured as { messages?: Array<{ role: string; content: unknown }> } | null)?.messages ?? [];
    check(`${provider}: the system prompt reaches the wire as a system message`, sent[0]?.role === "system");
    equal(`${provider}: the system prompt survives intact`, sent[0]?.content, "You are a Minecraft builder.");
    check(`${provider}: the user prompt follows it`, sent.some((m) => m.role === "user"));
  }

  // The one provider that must still refuse: "Custom" with no base URL has
  // nowhere to go, and defaulting it to OpenAI (as the Python original did)
  // is a silent wrong answer.
  check(
    "Custom without a base URL is refused rather than defaulted",
    await (async () => {
      try {
        await callLlm({
          provider: "Custom (OpenAI Compatible)",
          model: "test-model",
          apiKey: "sk-test",
          baseUrl: "",
          systemPrompt: "s",
          userPrompt: "u",
        });
        return false;
      } catch (err) {
        return err instanceof LlmError && err.message.includes("Base URL");
      }
    })(),
  );

  // `close()` alone waits for the keep-alive sockets these four calls leave
  // behind, which would hold the suite open; dropping them first keeps the
  // teardown prompt. (This is not what fixes the exit code — see the note at
  // the bottom of the file. The handles that mattered were the client's.)
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  equal("path traversal is stripped from names", sanitizeName("../../evil"), "evil");
  equal("empty model name falls back", sanitizeName("   "), "structure");
  equal("normal name survives", sanitizeName("Stone Tower"), "Stone Tower");
  equal(
    "description truncates at 50 with ellipsis",
    describeFor("x".repeat(60)),
    `${"x".repeat(50)}...`,
  );
  equal("short description keeps no ellipsis", describeFor("small house"), "small house");
} finally {
  await rm(workDir, { recursive: true, force: true });
}

// --- the recently-opened list -------------------------------------------------
console.log("\n--- recent documents ---");
{
  const A = "C:/builds/house.schem";
  const B = "C:/builds/castle.schem";
  const C = "C:/builds/tower.schem";

  /** A list from paths, oldest timestamps first, so order is visible. */
  const list = (...entries: [string, number][]) =>
    entries.map(([filePath, openedAt]) => ({ filePath, openedAt }));
  const paths = (entries: readonly { filePath: string }[]) => entries.map((e) => e.filePath);

  equal("a new list starts with what was opened", rememberRecent([], A, true, 100), [
    { filePath: A, openedAt: 100 },
  ]);
  equal("the newest goes first", paths(rememberRecent(list([A, 1]), B, true, 2)), [B, A]);

  // The point of the list: reopening something you already have moves it up
  // rather than giving it a second slot that opens the same file.
  equal(
    "reopening promotes rather than duplicates",
    paths(rememberRecent(list([A, 1], [B, 2], [C, 3]), C, true, 9)),
    [C, A, B],
  );
  equal(
    "...and the list does not grow doing it",
    rememberRecent(list([A, 1], [B, 2], [C, 3]), C, true, 9).length,
    3,
  );
  equal(
    "...and the promoted entry carries the new time",
    rememberRecent(list([A, 1], [C, 3]), C, true, 9)[0].openedAt,
    9,
  );

  // On Windows the same schematic reached through the picker and through a drop
  // can differ only in the drive letter's case.
  equal(
    "a path differing only in case is the same file when case is ignored",
    paths(rememberRecent(list([A, 1]), A.toUpperCase(), false, 2)),
    [A.toUpperCase()],
  );
  equal(
    "...and a different one where case matters",
    rememberRecent(list([A, 1]), A.toUpperCase(), true, 2).length,
    2,
  );

  // The cap has to drop the *oldest*, which is the end of the list.
  const many = Array.from({ length: 10 }, (_, i) => ({
    filePath: `C:/builds/${i}.schem`,
    openedAt: i + 1,
  }));
  const capped = rememberRecent(many, "C:/builds/new.schem", true, 99, 10);
  equal("the list stops at the cap", capped.length, 10);
  equal("...keeping the newest", capped[0].filePath, "C:/builds/new.schem");
  check("...and dropping the oldest", !paths(capped).includes("C:/builds/9.schem"));

  equal("forgetting removes it", paths(forgetRecent(list([A, 1], [B, 2]), A, true)), [B]);
  equal(
    "forgetting something absent changes nothing",
    paths(forgetRecent(list([A, 1], [B, 2]), C, true)),
    [A, B],
  );

  // A settings file written by another build, or edited by hand.
  equal("a non-array reads as empty", coerceRecents({ nope: true }), []);
  equal(
    "malformed entries are dropped",
    coerceRecents([{ filePath: A, openedAt: 5 }, null, 7, { openedAt: 9 }, { filePath: "" }]),
    [{ filePath: A, openedAt: 5 }],
  );
  equal("...and the cap still applies", coerceRecents(many, 3).length, 3);

  /*
   * The upgrade path. Every settings file written before this list carried
   * timestamps holds bare strings; dropping them would empty the recents of
   * anyone who updated, to gain a column. They are kept with `openedAt: 0`,
   * which the UI reads as "no date recorded" rather than as 1970.
   */
  equal("a pre-timestamp file still reads", coerceRecents([A, B]), [
    { filePath: A, openedAt: 0 },
    { filePath: B, openedAt: 0 },
  ]);
  equal(
    "a nonsense timestamp becomes no timestamp",
    coerceRecents([{ filePath: A, openedAt: "yesterday" }])[0].openedAt,
    0,
  );
  equal(
    "a negative timestamp becomes no timestamp",
    coerceRecents([{ filePath: A, openedAt: -5 }])[0].openedAt,
    0,
  );
}

// --- the "you have unsaved work" box ---------------------------------------
//
// Wording, and only wording -- the dialog itself belongs to Electron. What is
// worth pinning is that the destructive button never becomes a bare "OK":
// "Discard changes?" answered with OK/Cancel is a coin flip, and half the
// flips lose work.
console.log("\n--- discard prompt ---");
{
  const named = discardPrompt("new", "castle.schem");
  check("the headline names the file", named.message.includes("castle.schem"), named.message);
  check("...and says what is at stake", named.message.includes("unsaved"), named.message);

  const unnamed = discardPrompt("close", null);
  equal("a document with no file is Untitled", unnamed.message, "Untitled has unsaved changes.");

  // Each intent names its own verb, so the button says what pressing it does.
  equal("new says what it will do", discardPrompt("new", "a").confirmLabel, "Discard and create");
  equal("open says what it will do", discardPrompt("open", "a").confirmLabel, "Discard and open");
  equal("close says what it will do", discardPrompt("close", "a").confirmLabel, "Discard and close");

  for (const intent of ["new", "open", "close"] as const) {
    const prompt = discardPrompt(intent, "a.schem");
    check(
      `${intent}: the button is never a bare OK`,
      prompt.confirmLabel.toLowerCase() !== "ok" && prompt.confirmLabel !== prompt.cancelLabel,
      prompt.confirmLabel,
    );
    check(`${intent}: it says the loss is permanent`, prompt.detail.includes("cannot be undone"), prompt.detail);
  }
}

// --- a schematic's version history -----------------------------------------
//
// The list itself is the feature: a generation replaces everything that was
// open, and until this existed the only record of what it replaced was the file
// it had overwritten. What is worth pinning is the housekeeping, because every
// row is a whole .schem on disk and a row without its file is a button that
// fails.
console.log("\n--- version history ---");
{
  const made = (id: string, at: number): Snapshot => ({
    id,
    at,
    source: "manual",
    label: id,
    size: [1, 1, 1],
    blockCount: 1,
  });

  equal("newest first", order([made("a", 1), made("c", 3), made("b", 2)]).map((v) => v.id), ["c", "b", "a"]);

  /*
   * Adding past the cap says which files are now unreferenced. The eviction
   * list is returned rather than acted on inside, because a caller that forgets
   * to delete leaves orphans -- and that is visible here.
   */
  const full = Array.from({ length: MAX_SNAPSHOTS }, (_unused, i) => made(`v${i}`, i + 1));
  const added = addSnapshot(full, made("new", 999));
  equal("the cap holds", added.kept.length, MAX_SNAPSHOTS);
  equal("the newest is kept", added.kept[0].id, "new");
  equal("...and the oldest is named for deletion", added.dropped, ["v0"]);

  // Re-adding the same id replaces rather than duplicating, and takes nothing
  // with it: the file is being overwritten, not evicted.
  const again = addSnapshot([made("a", 1)], made("a", 5));
  equal("an id is not duplicated", again.kept.length, 1);
  equal("...and nothing is deleted for it", again.dropped, []);

  const removed = removeSnapshot([made("a", 1), made("b", 2)], "a");
  equal("removing takes the row", removed.kept.map((v) => v.id), ["b"]);
  equal("...and names the file", removed.dropped, ["a"]);
  equal("removing what is not there deletes nothing", removeSnapshot([made("b", 2)], "a").dropped, []);

  /*
   * An index written by hand, or by another build. A row with no id or no size
   * cannot name a file or describe one, so it goes -- and must not cost the
   * user the rows either side of it.
   */
  const coerced = coerceSnapshots([
    { id: "good", at: 5, source: "generated", label: "a castle", size: [2, 3, 4], blockCount: 9 },
    { at: 5, size: [1, 1, 1] },
    { id: "nosize", at: 5 },
    { id: "odd", at: "yesterday", source: "wat", label: 7, size: [1, 1, 1], blockCount: -3 },
  ]);
  equal("bad rows are dropped, good ones survive", coerced.map((v) => v.id), ["good", "odd"]);
  equal("an unreadable date becomes none", coerced[1].at, 0);
  equal("an unknown source falls back", coerced[1].source, "manual");
  equal("a non-string label becomes empty", coerced[1].label, "");
  equal("a negative block count becomes zero", coerced[1].blockCount, 0);
  equal("a non-array index is no history", coerceSnapshots("nope"), []);

  /*
   * A label is never empty. A row with no words cannot be told from the one
   * above it, and "which of these do I want" is the only question the list
   * exists to answer.
   */
  equal("the prompt becomes the label", snapshotLabel("generated", "  a  stone   tower "), "a stone tower");
  equal("a generation with no words still says what it was", snapshotLabel("generated", ""), "Generated");
  equal("...and so does an opening", snapshotLabel("opened", "   "), "As opened");
  equal("...and a manual one", snapshotLabel("manual", ""), "Saved version");
}

// --- the application menu --------------------------------------------------
//
// The menu itself is Electron's; what is worth pinning is everything the model
// decides before Electron sees it. Enablement is the load-bearing half: main
// builds this from its own state, so a wrong answer here is a Save that
// silently does nothing rather than a Save that is greyed out.
console.log("\n--- application menu ---");
{
  const at = (items: MenuItemModel[], label: string): MenuItemModel | undefined =>
    items.find((item) => item.label === label);
  const fileMenu = (state: Parameters<typeof menuModel>[0]): MenuItemModel[] =>
    at(menuModel(state), "File")?.submenu ?? [];
  const editMenu = (state: Parameters<typeof menuModel>[0]): MenuItemModel[] =>
    at(menuModel(state), "Edit")?.submenu ?? [];
  const helpMenu = (state: Parameters<typeof menuModel>[0]): MenuItemModel[] =>
    at(menuModel(state), "Help")?.submenu ?? [];

  const empty = { hasDocument: false, recents: [] as RecentDocument[], keysToCamera: false };
  const open = { hasDocument: true, recents: [] as RecentDocument[], keysToCamera: false };

  // New and Open never depend on a document -- they are how you get one.
  equal("New works with nothing open", at(fileMenu(empty), "New…")?.enabled, true);
  equal("Open works with nothing open", at(fileMenu(empty), "Open…")?.enabled, true);

  for (const label of ["Save", "Save As…", "Close Schematic"]) {
    equal(`${label} is off with nothing open`, at(fileMenu(empty), label)?.enabled, false);
    equal(`${label} is on with a document`, at(fileMenu(open), label)?.enabled, true);
  }
  /*
   * No Edit menu at all with nothing open, rather than one holding two greyed
   * rows. Both were already disabled, which is the honest answer to "can I
   * undo" and the wrong shape of answer: with no document there is nothing the
   * menu could ever offer, so it was a heading existing only to be dead. The
   * File menu keeps its disabled rows because it has live ones beside them.
   */
  equal("there is no Edit menu with nothing open", at(menuModel(empty), "Edit"), undefined);
  equal("...and there is one with a document", at(menuModel(open), "Edit")?.label, "Edit");
  equal("Undo is on with a document", at(editMenu(open), "Undo")?.enabled, true);
  equal("Redo is on with a document", at(editMenu(open), "Redo")?.enabled, true);
  // The File menu is never conditional: it is the only way to get a document.
  equal("File is there either way", at(menuModel(empty), "File")?.label, "File");

  /*
   * Help is unconditional too, and this is the check that says so out loud.
   *
   * The Edit menu two lines up is the tempting pattern to copy and it is the
   * wrong one here: Edit is hidden with nothing open because every row it could
   * show would be dead, while About answers exactly as well with no document as
   * with one. Copying the conditional would hide it on the empty start screen,
   * which is the one moment somebody looking the app over is most likely to go
   * looking for what it is.
   */
  equal("Help is there with nothing open", at(menuModel(empty), "Help")?.label, "Help");
  equal("...and with a document", at(menuModel(open), "Help")?.label, "Help");
  equal("About works with nothing open", at(helpMenu(empty), "About Schematic AI Studio")?.enabled, true);
  equal("...and names the app", helpMenu(open)[0]?.label, `About ${APP_NAME}`);

  /*
   * And no accelerator on it, stated because it looks like an omission.
   *
   * Conventional for the item, and it keeps the row out of the flight-mode
   * argument entirely: `releaseAccelerators` has to hand back every key the
   * menu declares while the pointer is locked, and a key that was never claimed
   * cannot be got wrong.
   */
  for (const item of helpMenu(open)) {
    equal(`${item.label ?? "?"} has no accelerator`, item.accelerator, undefined);
  }

  /*
   * No accelerator on Undo/Redo, and this is the check that keeps it that way.
   *
   * Electron claims an accelerator before the window sees the keystroke, and a
   * menu item cannot ask where the caret is -- so Ctrl+Z here would stop
   * undoing what you are typing in the chat and start undoing block edits.
   */
  for (const item of editMenu(open)) {
    equal(`${item.label ?? "?"} has no accelerator`, item.accelerator, undefined);
  }
  equal("Save keeps its accelerator", at(fileMenu(open), "Save")?.accelerator, "CmdOrCtrl+S");

  // The recents submenu.
  const recent = (paths: string[]): RecentDocument[] =>
    paths.map((filePath, index) => ({ filePath, openedAt: 1000 - index }));

  const withNone = at(fileMenu(empty), "Open Recent");
  equal("with no history the submenu is off", withNone?.enabled, false);
  equal("...and empty", withNone?.submenu?.length, 0);

  const some = at(
    fileMenu({
      hasDocument: false,
      recents: recent(["C:/a/one.schem", "C:/b/two.schem"]),
      keysToCamera: false,
    }),
    "Open Recent",
  );
  equal("history switches it on", some?.enabled, true);
  equal("one row per file", some?.submenu?.length, 2);
  equal("rows are named by the file", some?.submenu?.[0].label, "one.schem");
  equal("...and carry the path", some?.submenu?.[0].filePath, "C:/a/one.schem");

  /*
   * Two builds called `house.schem` in two folders is the ordinary case -- a
   * build and its backup -- and a menu offering the same word twice is a coin
   * flip. Only the names that actually repeat pay for the folder.
   */
  const clashing = recentLabels(recent(["C:/mine/house.schem", "D:/old/house.schem", "C:/mine/hut.schem"]));
  equal("a repeated name gets its folder", clashing[0], "house.schem — mine");
  equal("...both of them", clashing[1], "house.schem — old");
  equal("a unique name stays short", clashing[2], "hut.schem");

  // `&` is a mnemonic marker in a native menu, so `A&B.schem` would render as
  // "AB" with the B underlined -- and pressing B would open it.
  equal("an ampersand in a file name is escaped", escapeMenuLabel("A&B.schem"), "A&&B.schem");
  equal(
    "...on the way into the menu, not only in principle",
    at(
      fileMenu({ hasDocument: false, recents: recent(["C:/a/A&B.schem"]), keysToCamera: false }),
      "Open Recent",
    )?.submenu?.[0].label,
    "A&&B.schem",
  );

  /*
   * In flight the menu prints its keys and claims none of them.
   *
   * With the pointer locked Ctrl is the sprint modifier and WASD is the
   * direction, so Ctrl+W -- Close Schematic -- is also "run forwards", and an
   * accelerator is taken before the window sees the keystroke. The renderer
   * cannot decline it on the camera's behalf, so the menu has to let go.
   *
   * Walked over the whole tree rather than checked on Close alone, because the
   * rule is about every accelerator the menu declares including the one added
   * next -- which is exactly what `releaseAccelerators` is a single pass for.
   */
  const flying = { hasDocument: true, recents: recent(["C:/a/one.schem"]), keysToCamera: true };
  const walk = (items: MenuItemModel[]): MenuItemModel[] =>
    items.flatMap((item) => [item, ...walk(item.submenu ?? [])]);

  const claimed = walk(menuModel(flying)).filter(
    (item) => item.accelerator !== undefined && item.registerAccelerator !== false,
  );
  equal("in flight the menu claims no accelerator", claimed.length, 0);
  // Printed, not deleted: the row still says which key it is, and still works
  // when clicked. Releasing is about the keyboard and nothing else.
  equal(
    "...but Close still shows its key",
    at(fileMenu(flying), "Close Schematic")?.accelerator,
    "CmdOrCtrl+W",
  );
  equal("...and is still clickable", at(fileMenu(flying), "Close Schematic")?.enabled, true);
  equal(
    "...and the recents are still there",
    at(fileMenu(flying), "Open Recent")?.submenu?.length,
    1,
  );
  // Escape releases the lock and the keys come straight back. Nothing else in
  // the menu moves with it -- same rows, same enablement.
  equal(
    "out of flight it claims them again",
    at(fileMenu(open), "Save")?.registerAccelerator,
    undefined,
  );
  equal(
    "...which is the only difference the flag makes",
    JSON.stringify(menuModel({ ...flying, keysToCamera: false })).replace(
      /,"registerAccelerator":false/g,
      "",
    ),
    JSON.stringify(menuModel(flying)).replace(/,"registerAccelerator":false/g, ""),
  );

  /*
   * Every field of the model reaches Electron.
   *
   * `menu_model.ts` decides and `menu.ts` copies, which is a division of labour
   * with one failure mode: a field added to the model and not to `toElectron`
   * is dropped in silence, and the decision looks taken while nothing happens.
   * That is `coerceSettings`'s bug in a different module, and this is the same
   * answer -- a fully populated value, `satisfies` so the compiler breaks when
   * a required field appears, and the copy checked field by field.
   *
   * `registerAccelerator` is the one that prompted it: dropped, the menu would
   * go on claiming Ctrl+W in flight with every check above still green.
   */
  const everyField = {
    command: "save",
    filePath: "C:/a/one.schem",
    label: "Save",
    accelerator: "CmdOrCtrl+S",
    registerAccelerator: false,
    enabled: true,
    separator: false,
    role: "quit",
    submenu: [],
  } satisfies Required<MenuItemModel>;

  const electronHalf = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main", "menu.ts"),
    "utf8",
  );
  const dropped = Object.keys(everyField).filter(
    // `item.<field>` is how `toElectron` reads each one. A name that appears
    // only in a comment or a type would not be written that way.
    (field) => !electronHalf.includes(`item.${field}`),
  );
  equal("every field of a menu item reaches Electron", dropped.join(", "), "");

  // The title bar. Name first, app second: both the taskbar and Alt-Tab
  // truncate from the right, and which schematic this is survives.
  equal("nothing open is just the app", windowTitle({ hasDocument: false, fileName: null, dirty: false }), "Schematic AI Studio");
  equal(
    "a saved document leads with its name",
    windowTitle({ hasDocument: true, fileName: "castle.schem", dirty: false }),
    "castle.schem — Schematic AI Studio",
  );
  equal(
    "unsaved work is marked, and the marker leads",
    windowTitle({ hasDocument: true, fileName: "castle.schem", dirty: true }),
    "• castle.schem — Schematic AI Studio",
  );
  equal(
    "a document with no file is Untitled here too",
    windowTitle({ hasDocument: true, fileName: null, dirty: true }),
    "• Untitled — Schematic AI Studio",
  );
}

// --- growing the document to reach a region outside it ---------------------
console.log("\n--- growth ---");
{
  const extent = { width: 16, height: 16, length: 16 };
  const box = (minX: number, maxX: number) => ({
    minX, minY: 0, minZ: 0, maxX, maxY: 0, maxZ: 0,
  });

  equal("a region already inside needs no growth", growthToInclude(extent, box(2, 5)), null);
  equal("...and neither does one exactly filling it", growthToInclude(extent, box(0, 15)), null);

  equal("reaching past the far edge grows that side", growthToInclude(extent, box(2, 19)), {
    size: { width: 20, height: 16, length: 16 },
    shift: [0, 0, 0],
  });

  /*
   * The sign of the shift, which is the whole reason this is a function and not
   * two lines at the call site. The grid has no negative coordinates, so a
   * region reaching below zero cannot be reached by growing downwards -- the
   * *content* moves up instead, and the region has to move with it. Get this
   * backwards and the new space appears on the wrong side, silently.
   */
  equal("reaching below the origin moves the content up", growthToInclude(extent, box(-4, 5)), {
    size: { width: 20, height: 16, length: 16 },
    shift: [4, 0, 0],
  });
  equal(
    "the region moves with the content it sits in",
    shiftRegion(box(-4, 5), [4, 0, 0]),
    box(0, 9),
  );

  equal("both sides at once", growthToInclude(extent, box(-4, 19)), {
    size: { width: 24, height: 16, length: 16 },
    shift: [4, 0, 0],
  });

  equal(
    "each axis grows independently",
    growthToInclude(extent, { minX: -1, minY: 3, minZ: 0, maxX: 3, maxY: 20, maxZ: 4 }),
    { size: { width: 17, height: 21, length: 16 }, shift: [1, 0, 0] },
  );

  // Corners arrive in whatever order the drag left them.
  equal(
    "an inverted region is ordered first",
    orderRegion({ minX: 9, minY: 2, minZ: 7, maxX: 1, maxY: 5, maxZ: 3 }),
    { minX: 1, minY: 2, minZ: 3, maxX: 9, maxY: 5, maxZ: 7 },
  );
  equal(
    "...and growth reads it the same way round",
    growthToInclude(extent, { minX: 19, minY: 0, minZ: 0, maxX: 2, maxY: 0, maxZ: 0 }),
    { size: { width: 20, height: 16, length: 16 }, shift: [0, 0, 0] },
  );

  equal("volume is the product", extentVolume({ width: 3, height: 4, length: 5 }), 60);
}

// --- settings coercion: the fields that vanish when nobody names them ------
console.log("\n--- a stored key and a readable one ---");
{
  /*
   * `settings-store.ts` imports `safeStorage`, so it cannot be loaded here --
   * which is why `settings_coerce.ts` exists at all. The rule is checked in the
   * source, like `closeAllConnections` in `tests/mcp.ts`, because the mistake is
   * a single predicate and its absence is invisible from every angle but one.
   *
   * The mistake: `hasKey` was `Boolean(encryptedKeys[provider])` -- the presence
   * of *ciphertext*. `getApiKey` returns `""` for absent, for no keyring, and
   * for ciphertext that will not decrypt, so a key encrypted under a keyring
   * this profile no longer has presents as **saved** in the pane and as
   * **missing** to every caller. The provider then answers `Invalid API key.`
   * and nothing anywhere suggests the app is the one that lost it.
   */
  const store = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main", "services", "settings-store.ts"),
    "utf8",
  );
  const status = store.slice(store.indexOf("export async function getKeyStatus"));
  check(
    "a saved key is one that decrypts, not one that is merely there",
    status.includes("decrypts("),
    "hasKey read the presence of ciphertext, which getApiKey does not",
  );
  /*
   * And the two states stay apart. `unreadable` is what lets the pane say
   * "paste it again" rather than "paste one", which is the only part of this
   * that is not obvious from `hasKey: false`.
   */
  check(
    "...and ciphertext that will not decrypt says so",
    status.includes("unreadable"),
    "the two states were collapsed into one",
  );
}
console.log("\n--- the profile the rename left behind ---");
{
  /*
   * `app.getName()` names the userData directory, so renaming the app at 1.0.0
   * started it on an empty profile. Nothing migrates, which is defensible --
   * and was done in silence, which is what cost.
   *
   * The whole failure, once: an install with working keys came back with none.
   * Generation stopped and every other part of the app kept working, because
   * nothing else needs a key. What surfaced was the provider's own
   * `Invalid API key.` -- true, and pointing at a key that *was* set, in a
   * folder this app no longer reads. It took two reports and a wrong diagnosis
   * about the MCP bearer token to find.
   */
  const root = await mkdtemp(path.join(tmpdir(), "bgpt-profiles-"));
  const make = async (name: string, body: unknown): Promise<string> => {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    if (body !== undefined) {
      await writeFile(path.join(dir, "settings.json"), JSON.stringify(body), "utf8");
    }
    return dir;
  };

  /*
   * Every call below goes through this. `orphanedProfile` runs at startup and
   * its whole contract on a bad directory is *silence*, so a guard removed
   * makes these throw -- and an uncaught throw takes the rest of the suite
   * with it, which is the failure `check.sh` is arranged not to have. The
   * message comes back as the value and the equality names the fault.
   */
  const orphan = async (a: string, b: string): Promise<unknown> => {
    try {
      return await orphanedProfile(a, b);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  const withKeys = await make("old", {
    encryptedKeys: { OpenCode: "AAAA", "Custom (OpenAI Compatible)": "BBBB" },
  });
  const empty = await make("new", { encryptedKeys: {} });

  {
    const found = (await orphan(empty, withKeys)) as OrphanedProfile | null;
    check("a profile with keys beside one without is found", found !== null);
    equal(
      "...and it names which providers, so the sentence can",
      found?.providers,
      ["Custom (OpenAI Compatible)", "OpenCode"],
    );
    equal("...and where to look", found?.path, withKeys);
  }

  /*
   * The one that stops the notice outliving its cause. Once a key has been
   * pasted back, there is nothing to recover and a warning still on screen is
   * one people learn to ignore.
   */
  const alsoHasOne = await make("done", { encryptedKeys: { OpenAI: "CCCC" } });
  equal(
    "a profile that already has a key is told nothing",
    await orphan(alsoHasOne, withKeys),
    null,
  );

  /*
   * Existing is not the same as holding something. A fresh install on a machine
   * that once ran the old build leaves the directory behind with no keys in it.
   */
  const oldButEmpty = await make("old-empty", { encryptedKeys: {} });
  equal(
    "an old profile with no keys is nothing to report",
    await orphan(empty, oldButEmpty),
    null,
  );
  equal(
    "...and neither is one that was never there",
    await orphan(empty, path.join(root, "never-existed")),
    null,
  );

  /*
   * And it must not be able to stop the app starting. This runs at startup, and
   * a corrupt file in a directory the app has *stopped using* is the least
   * deserving reason to fail to launch there is.
   */
  const corrupt = path.join(root, "corrupt");
  await mkdir(corrupt, { recursive: true });
  await writeFile(path.join(corrupt, "settings.json"), "{ not json at all", "utf8");
  equal(
    "an unreadable old profile is silence, not an exception",
    await orphan(empty, corrupt),
    null,
  );

  // Same directory twice: nothing is next door to itself.
  equal(
    "a profile is not its own predecessor",
    await orphan(withKeys, withKeys),
    null,
  );

  /*
   * Conversations are counted but do not raise the notice on their own: losing
   * a chat log is an inconvenience, and losing a key looks like the app being
   * broken. They are worth naming once somebody is being sent to the folder.
   */
  await mkdir(path.join(withKeys, "conversations"), { recursive: true });
  await writeFile(path.join(withKeys, "conversations", "a.json"), "{}", "utf8");
  await writeFile(path.join(withKeys, "conversations", "b.json"), "{}", "utf8");
  equal(
    "the conversations left behind are counted",
    ((await orphan(empty, withKeys)) as OrphanedProfile | null)?.conversations,
    2,
  );

  /*
   * And the clause reaches the sentence somebody actually reads. Without a
   * legacy profile it says nothing about folders -- a clean install must not be
   * told about a directory that was never there.
   */
  const plain = await apiKeyRefusal({
    provider: "OpenAI",
    model: "gpt-4o-mini",
    apiKey: "",
    snapshotPath: null,
  });
  check(
    "a refusal on a clean install invents no folder",
    !(plain ?? "").includes("earlier version"),
    plain ?? "(none)",
  );
  const hinted = await apiKeyRefusal({
    provider: "OpenAI",
    model: "gpt-4o-mini",
    apiKey: "",
    snapshotPath: null,
    legacyProfilePath: withKeys,
  });
  check(
    "...and one with a profile next door says where",
    (hinted ?? "").includes(withKeys),
    hinted ?? "(none)",
  );

  await rm(root, { recursive: true, force: true });
}
console.log("\n--- whose API key it is ---");
{
  /*
   * Reported as an MCP authentication failure, and it is not one.
   *
   * `generate_schematic` spends the *user's* provider budget, and with no key
   * the provider's own answer came back verbatim through `LlmError`:
   *
   *     generate_schematic  LLM API Error: Invalid API key.
   *
   * A sentence about an API key, arriving over a connection the reader had just
   * authenticated to with a bearer token. The two IPC callers had a gate that
   * says which key and where it lives; the MCP one had none -- this file's
   * recurring shape, a rule reaching every place that asks but one.
   *
   * The OpenCode arm is deliberately not exercised here: it consults the live
   * catalogue, and a check that reaches the network is a check that fails on a
   * train. What is covered is every path that decides without one.
   */
  const refusal = await apiKeyRefusal({
    provider: "OpenAI",
    model: "gpt-4o-mini",
    apiKey: "",
    snapshotPath: null,
  });
  check("a provider with no key is refused", refusal !== null);
  check(
    "...and the refusal names the provider",
    (refusal ?? "").includes("OpenAI"),
    refusal ?? "(none)",
  );
  equal(
    "...and a key is all it takes",
    await apiKeyRefusal({ provider: "OpenAI", model: "gpt-4o-mini", apiKey: "sk-x", snapshotPath: null }),
    null,
  );
  // Whitespace is not a key. This is what a field pasted into and cleared again
  // leaves behind.
  check(
    "blank space is not a key",
    (await apiKeyRefusal({ provider: "OpenAI", model: "m", apiKey: "   ", snapshotPath: null })) !== null,
  );

  /*
   * There is deliberately no second function relabelling the provider's own
   * refusal.
   *
   * There were two, because `generate_schematic` carried this sentence to a
   * reader outside the window and it had to say *whose* key it was. That tool
   * is gone -- it asked a second model to do what the calling one was already
   * doing -- so the only readers left are in front of the pane that has the
   * field in it, and a paragraph explaining where they are would be noise.
   */
}
console.log("\n--- settings coercion ---");
{
  /*
   * The point of this block is the two `satisfies` annotations below.
   *
   * `coerceUi` and `coerceSettings` build fresh object literals and run on read
   * *and* on write, so a field added to the type but not to the function is
   * dropped when the renderer saves -- it works for the rest of the session and
   * is gone after a reload, with nothing logged. That is the failure this
   * guards, and a test that merely checked today's fields would not: it would
   * still pass on the day someone adds the twelfth one.
   *
   * Annotating these as the full types is what closes it. Add a required field
   * to `UiSettings` and this file stops compiling until the literal names it;
   * name it here and the round-trip below fails until `coerceUi` names it too.
   * The type system supplies the reminder, the assertion supplies the referee.
   */
  const ui = {
    sidebarWidth: 555,
    sidebarCollapsed: true,
    theme: "light",
    language: "en",
    toolWindowX: 240,
    toolWindowY: 96,
    // Both above the minimum and neither the default, so a `coerceUi` that
    // substituted either would not survive the comparison.
    toolWindowW: 340,
    toolWindowH: 520,
    inspectorWindowX: 300,
    inspectorWindowY: 480,
    inspectorWindowW: 380,
    inspectorWindowH: 400,
    /*
     * `hotbar` and `hotbarSlot` were here and belong to a *document* now,
     * keyed on its path, so they are no longer part of the window's state.
     * The check they used to earn is below, on `coerceHotbar`, which is the
     * same validation moved rather than dropped.
     */
  } satisfies UiSettings;

  equal("every ui field survives a round-trip", coerceUi(ui), ui);

  // Every field the opposite of its default, so a `coerceMcp` that dropped one
  // and substituted the default could not survive the comparison below.
  const mcp = {
    enabled: true,
    port: 4600,
    root: "C:/builds/mcp",
    allowDelete: true,
    // The opposite of the default, so a `coerceMcp` that dropped the field
    // and substituted the default would fail rather than round-trip.
    requireAuth: false,
    bindAddress: "127.0.0.1",
  } satisfies McpSettings;

  equal("every mcp field survives a round-trip", coerceMcp(mcp), mcp);

  /*
   * The one field here whose safe answer is `true`, and therefore the one
   * read as `!== false` while `enabled` and `allowDelete` are read as
   * `=== true`.
   *
   * This is the check that fails if somebody copies the two lines above it.
   * **No settings file in existence carries this key** -- it did not exist
   * until now -- so `=== true` would come back `false` for every user the app
   * has, and turn authentication off on the next launch without a word.
   */
  equal("a settings file with no mcp block still requires a token", coerceMcp(undefined).requireAuth, true);
  equal("...and one with an mcp block that predates the field", coerceMcp({ port: 4571 }).requireAuth, true);
  // Only an explicit `false` turns it off, which is what the checkbox writes.
  equal("an explicit false is honoured", coerceMcp({ requireAuth: false }).requireAuth, false);
  equal("...and a truthy string does not turn it off", coerceMcp({ requireAuth: "no" }).requireAuth, true);

  /*
   * The address is a single address, and the CIDR case is the one worth
   * naming: it is what somebody reaches for when they mean "only my LAN",
   * and it is not a thing `listen` can bind. Which clients may connect is the
   * token's question, not this one.
   */
  equal("loopback is an address", bindAddressRefusal("127.0.0.1"), null);
  equal("...and so is every interface", bindAddressRefusal("0.0.0.0"), null);
  equal("...and a real IPv4 one", bindAddressRefusal("192.168.1.42"), null);
  equal("...and IPv6", bindAddressRefusal("::1"), null);
  check(
    "a CIDR is refused as the range it is",
    (bindAddressRefusal("192.168.1.0/24") ?? "").includes("range"),
    bindAddressRefusal("192.168.1.0/24") ?? "(none)",
  );
  /*
   * A hostname is refused too, and the reason is not tidiness: the `Host`
   * header is compared against this string as written, so a value that would
   * have to be resolved first could never be compared at all.
   */
  check("a hostname is refused", bindAddressRefusal("my-desktop.local") !== null);
  check("...and so is nonsense", bindAddressRefusal("999.1.1.1") !== null);
  check("an empty address says what to type", (bindAddressRefusal("") ?? "").includes("127.0.0.1"));
  // A bad value falls back rather than reaching `listen`, where it would come
  // back as EADDRNOTAVAIL naming nothing.
  equal(
    "a refused address falls back to the default",
    coerceMcp({ bindAddress: "192.168.1.0/24" }).bindAddress,
    DEFAULT_MCP_SETTINGS.bindAddress,
  );

  // The opposite of its default, for the reason above: a `coerceEditing`
  // that dropped the field and substituted the default would still pass a
  // round-trip written with the default in it.
  const editing = {
    autoGrow: false,
    voidOpacity: 0.75,
  } satisfies EditingSettings;

  equal("every editing field survives a round-trip", coerceEditing(editing), editing);

  /*
   * Absent has to read as *on*, not as off.
   *
   * Growing on a fill outside the box is what the editor did before there
   * was a setting, so every settings file written until now has no
   * `editing` block at all -- and reading that as `false` would silently
   * turn the behaviour off for everyone who had never asked.
   */
  equal("a missing editing block still grows", coerceEditing(undefined).autoGrow, true);
  equal("...and so does an empty one", coerceEditing({}).autoGrow, true);
  equal(
    "...while an explicit false is honoured",
    coerceEditing({ autoGrow: false }).autoGrow,
    false,
  );

  /*
   * Air is the empty string, and an id that *says* air is healed into it.
   *
   * Two spellings of one state is how they come to disagree: `fillVoid`
   * would intern air over air and hand the mesher a palette where every
   * index is void and none of them draws anything -- the expensive way of
   * doing precisely what the default already does for free.
   */
  for (const spelling of ["minecraft:air", "air", "  minecraft:air  "]) {
    equal(
      `${JSON.stringify(spelling)} is stored as no void block at all`,
      normaliseVoidBlock(spelling),
      "",
    );
  }
  equal("a real block survives, trimmed", normaliseVoidBlock("  minecraft:water  "), "minecraft:water");
  equal(
    "...and so does one carrying a state",
    normaliseVoidBlock("minecraft:water[level=0]"),
    "minecraft:water[level=0]",
  );
  equal("...and air carrying one is still air", normaliseVoidBlock("minecraft:air[x=1]"), "");
  equal("anything that is not a string is air", normaliseVoidBlock(undefined), "");

  /*
   * `voidBlock` is gone from the settings, and this states it rather than
   * leaving it to the type.
   *
   * What empty space is made of is written into one schematic, so it belongs
   * to the document; as a global it followed you between files silently
   * changing what a break wrote. `coerceEditing` names every field it keeps,
   * so a settings file from an older build still carrying the key must come
   * back without it -- and that is a runtime fact, not a compile-time one.
   */
  check(
    "an older settings file's void block is not carried into `editing`",
    !("voidBlock" in coerceEditing({ voidBlock: "minecraft:lava" })),
  );

  /*
   * Never zero. A void block drawn at nothing is a void block that is not
   * there, and the control for that is choosing air -- so a slider that
   * could reach zero would be a second, silent way of turning the feature
   * off, with the block still being written into the file.
   */
  check("opacity never reaches zero", coerceEditing({ voidOpacity: 0 }).voidOpacity > 0);
  equal(
    "...nor past full",
    coerceEditing({ voidOpacity: 4 }).voidOpacity,
    VOID_OPACITY.max,
  );
  equal(
    "junk falls back to the default",
    coerceEditing({ voidOpacity: "quite" }).voidOpacity,
    DEFAULT_EDITING_SETTINGS.voidOpacity,
  );

  const settings = {
    provider: "OpenAI",
    model: "gpt-4o-mini",
    baseUrl: "https://example.invalid/v1",
    version: "JE_1_20_1",
    exportType: "mcfunction",
    outputDir: "C:/builds",
    preview: { ...DEFAULT_SETTINGS.preview, wireframe: true, maxDrawDistance: 1024 },
    ui,
    mcp,
    editing,
  } satisfies Settings;

  equal("every settings field survives a round-trip", coerceSettings(settings), settings);

  /*
   * The default version is the newest release this build knows.
   *
   * A **decision** rather than a derivation -- a default is a statement to a
   * person, the same argument that keeps this app's own version bump manual --
   * so it is written out in `settings.ts` and pinned here instead of being read
   * from `MC_VERSIONS[0]` at runtime. What that costs is one edit per release;
   * what it buys is that the edit cannot be forgotten in silence.
   *
   * It was forgotten in silence. `JE_1_20_4` stood through fifteen newer
   * releases while generation stamped it and the New and Save As dialogs fell
   * back to it, and the first anybody heard was a report that an MCP client
   * would not stop producing 1.20.4 schematics. Nothing in the app could have
   * said so, because nothing was looking.
   */
  equal(
    "the default version is the newest the table knows",
    DEFAULT_SETTINGS.version,
    MC_VERSIONS[0].name,
  );
  /*
   * And it has to be a flat one, which is not pedantry: generation writes
   * Sponge, and Sponge cannot express a pre-Flattening version at all, so a
   * legacy default would make the app's own default configuration unable to
   * generate anything.
   */
  equal("...and is one Sponge can carry", eraOf(DEFAULT_SETTINGS.version), "flat");
  /*
   * Stated as a resolution as well, because the two spellings are now both
   * accepted and a default written as a label -- 26.2 -- would round-trip
   * through settings, work everywhere, and quietly stop matching the name
   * every other table is keyed on.
   */
  equal(
    "...spelled as a canonical name rather than a label",
    resolveVersionName(DEFAULT_SETTINGS.version),
    DEFAULT_SETTINGS.version,
  );

  /*
   * The two flags are compared against `true` rather than coerced, because
   * anything that is not exactly `true` has to be off: one opens a listening
   * socket and the other decides whether a delete verb exists at all, and a
   * settings file carrying `"yes"` or `1` must not be read as permission.
   */
  equal("a truthy string does not enable the server", coerceMcp({ enabled: "yes" }).enabled, false);
  equal("...nor deletion", coerceMcp({ allowDelete: 1 }).allowDelete, false);
  equal("a missing mcp block is all defaults", coerceMcp(undefined), DEFAULT_MCP_SETTINGS);
  // `0` is legal and means "any free port", so it must survive rather than
  // being read as absent and replaced by the default.
  equal("port 0 is a real answer", coerceMcp({ port: 0 }).port, 0);
  equal("a port past the range falls back", coerceMcp({ port: 99999 }).port, DEFAULT_MCP_SETTINGS.port);

  // A file written by an older build, or edited by hand into nonsense.
  const fallback = coerceUi({ theme: "neon", language: "xx", sidebarWidth: "wide" });
  equal("an unknown theme falls back", fallback.theme, DEFAULT_UI_SETTINGS.theme);
  equal("an unknown language falls back", fallback.language, DEFAULT_UI_SETTINGS.language);
  // The tabs are gone, and so is the field that remembered which one was
  // showing. A settings file written by a build that had them still carries
  // it, and this function drops anything it does not name -- which is the
  // whole reason it does not spread.
  check(
    "a field from an older build is dropped rather than carried",
    !("sidebarTab" in coerceUi({ sidebarTab: "generate" })),
  );
  equal(
    "a non-numeric width falls back",
    fallback.sidebarWidth,
    DEFAULT_UI_SETTINGS.sidebarWidth,
  );
  equal("a missing ui block is all defaults", coerceUi(undefined), DEFAULT_UI_SETTINGS);

  /*
   * The hotbar's own coercion, which used to live inside `coerceUi` and now
   * answers for a per-document file as well. Both callers read something
   * nobody validated, so there is one function rather than two that come to
   * disagree about what a hotbar is.
   */
  const bar = {
    slots: [
      "minecraft:granite",
      "minecraft:andesite",
      "minecraft:diorite",
      "minecraft:birch_planks",
      "minecraft:glass_pane",
      "minecraft:red_sand",
      "minecraft:mossy_cobblestone",
      "minecraft:sea_lantern",
      "minecraft:water",
    ],
    slot: 4,
  } satisfies Hotbar;
  equal("a hotbar survives a round-trip", coerceHotbar(bar), bar);

  /*
   * A slot holding air draws nothing and places nothing, and a file written
   * before that rule has one in slot nine -- the old default. Refused on
   * read, so it heals rather than needing a migration.
   */
  equal(
    "air is refused from a hotbar slot",
    coerceHotbar({ slots: ["minecraft:air", ...DEFAULT_HOTBAR.slice(1)], slot: 0 }).slots[0],
    DEFAULT_HOTBAR[0],
  );
  check(
    "...and the default hotbar has none of its own",
    DEFAULT_HOTBAR.every((block) => block !== "minecraft:air"),
    DEFAULT_HOTBAR.join(", "),
  );
  /*
   * Length is not negotiable: the template indexes by slot and the keys 1-9
   * have to land somewhere. Short is padded, long is cut.
   */
  equal(
    "a short hotbar is padded to nine",
    coerceHotbar({ slots: ["minecraft:stone"], slot: 0 }).slots.length,
    HOTBAR_SLOTS,
  );
  equal(
    "...and a long one cut back",
    coerceHotbar({
      slots: Array.from({ length: 20 }, () => "minecraft:stone"),
      slot: 0,
    }).slots.length,
    HOTBAR_SLOTS,
  );
  // Wrapped rather than clamped, so an index from a build with a different
  // slot count lands somewhere reachable instead of always on the first.
  equal("a slot past the end wraps", coerceHotbar({ slot: 11 }).slot, 2);
  equal("...and nonsense reads as the first", coerceHotbar({ slot: "x" }).slot, 0);
  equal("a hotbar from nothing at all is the default", coerceHotbar(undefined).slots, [
    ...DEFAULT_HOTBAR,
  ]);

  // A settings file copied from a 4K screen onto a laptop.
  equal(
    "an over-wide sidebar is clamped down",
    coerceUi({ sidebarWidth: 9999 }).sidebarWidth,
    SIDEBAR_WIDTH.max,
  );
  equal(
    "...and a hairline one clamped up",
    coerceUi({ sidebarWidth: 10 }).sidebarWidth,
    SIDEBAR_WIDTH.min,
  );

  equal("an empty file is the defaults", coerceSettings({}), DEFAULT_SETTINGS);
}

// --- where the agent's memory begins ---------------------------------------
console.log("\n--- chat memory boundary ---");
{
  const user = (text: string, remembered = true): ChatEntry => ({
    role: "user",
    text,
    remembered,
  });
  const agent = (text: string): ChatEntry => ({ role: "agent", text });

  const log: ChatEntry[] = [
    user("one"),
    agent("1"),
    user("two"),
    agent("2"),
    user("three"),
    agent("3"),
  ];

  equal("a window wider than the log starts at the top", rememberedFromIndex(log, 9), 0);
  equal("...and so does one exactly as wide", rememberedFromIndex(log, 3), 0);
  equal("the last two turns start at the second user entry", rememberedFromIndex(log, 2), 2);
  equal("...and one turn, at the last", rememberedFromIndex(log, 1), 4);

  /*
   * The case this function exists for, and the reason it is not "count back N
   * user entries" in the renderer.
   *
   * The middle turn failed: its entry is in the log, and `agent.ts` updates the
   * conversation only after everything that can throw, so it never entered the
   * model's memory. Counting user entries would put the boundary one turn too
   * early and claim the agent remembers something it does not.
   */
  const withFailure: ChatEntry[] = [
    user("one"),
    agent("1"),
    user("two", false),
    { role: "error", text: "LLM API Error: 503" },
    user("three"),
    agent("3"),
  ];
  equal("a failed turn is skipped, not counted", rememberedFromIndex(withFailure, 2), 0);
  equal("...and the last landed turn is still found", rememberedFromIndex(withFailure, 1), 4);
  check(
    "counting user entries instead would land on the failed one",
    rememberedFromIndex(withFailure, 2) !== 2,
  );

  // "New chat" leaves the log on screen for a moment with nothing remembered,
  // and a restored conversation whose model half could not be read is the same
  // shape. Both must put the divider above everything, not below.
  equal("nothing remembered puts the line at the top of nothing", rememberedFromIndex(log, 0), 6);
  equal("an empty log has no boundary", rememberedFromIndex([], 4), 0);
}

// --- a hotbar belongs to a schematic ---------------------------------------
//
// It used to be one bar for the whole app, in `UiSettings`. That is right for
// a window's chrome and wrong for what you are *holding*: opening the next
// schematic handed you the last one's blocks, and a legacy `.schematic`
// inherited nine that its version does not have.
//
// Keyed on the file path, like the conversation above and the version history
// -- the same `storeFileName` hash, so one schematic's three files can be
// matched up by eye on disk.
console.log("\n--- a hotbar belongs to a schematic ---");
{
  const dir = path.join(workDir, "hotbars");
  useHotbarDirectory(dir);
  const houseA = path.join(workDir, "house.schem");
  const houseB = path.join(workDir, "tower.schem");

  equal(
    "a schematic nobody has built in yet gets the factory nine",
    (await readHotbar(houseA)).slots,
    [...DEFAULT_HOTBAR],
  );

  await writeHotbar(houseA, { slots: Array.from({ length: HOTBAR_SLOTS }, () => "minecraft:sandstone"), slot: 3 });
  await writeHotbar(houseB, { slots: Array.from({ length: HOTBAR_SLOTS }, () => "minecraft:obsidian"), slot: 7 });

  /*
   * Two schematics, two bars. This is the whole feature: without the path in
   * the key the second write would answer for the first, which is exactly what
   * one shared bar did.
   */
  equal("one schematic keeps its own blocks", (await readHotbar(houseA)).slots[0], "minecraft:sandstone");
  equal("...and another keeps its own", (await readHotbar(houseB)).slots[0], "minecraft:obsidian");
  equal("...including which slot was held", (await readHotbar(houseA)).slot, 3);
  equal("...separately", (await readHotbar(houseB)).slot, 7);

  /*
   * Coerced on the way in as well as out. Validating only on read would let a
   * bad value sit on disk; only on write would trust whatever an older build
   * left there. Air is the case that matters, because it was a *default* once.
   */
  await writeHotbar(houseA, { slots: ["minecraft:air"], slot: 99 });
  const healed = await readHotbar(houseA);
  equal("air never reaches the file", healed.slots[0], DEFAULT_HOTBAR[0]);
  equal("...and a short one comes back full length", healed.slots.length, HOTBAR_SLOTS);
  equal("...with the slot wrapped into range", healed.slot, 99 % HOTBAR_SLOTS);

  /*
   * Unreadable is not an error. A file half-written by a crash, or one from a
   * build that spelled this differently, is answered with the factory nine --
   * a hotbar is a convenience, and refusing to open the schematic over one
   * would be wildly out of proportion.
   */
  await writeFile(path.join(dir, storeFileName(houseB)), "{ not json", "utf8");
  equal("a corrupt file reads as the default", (await readHotbar(houseB)).slots, [...DEFAULT_HOTBAR]);

  /*
   * And with no directory injected -- which is every suite that does not ask
   * for one, and main before startup -- nothing is written and nothing throws.
   * A document with no path never reaches here at all: the renderer has
   * nothing to key on and keeps its bar in memory.
   */
  useHotbarDirectory(null as unknown as string);
}

// --- conversations on disk -------------------------------------------------
console.log("\n--- conversation persistence ---");
{
  const dir = path.join(workDir, "conversations");
  useConversationDirectory(dir);

  const houseA = path.join(workDir, "house.schem");
  const houseB = path.join(workDir, "tower.schem");

  // A conversation about one schematic, saved and read back with both halves.
  {
    resetConversation(null);
    await adoptSubject(houseA);
    appendEntry({ role: "user", text: "add a roof" });
    noteTurn([{ role: "user", content: "add a roof" }], 1);
    appendEntry({ role: "agent", text: "Added one." });
    await saveConversation();

    // Somewhere else entirely, then back.
    await adoptSubject(houseB);
    equal("opening another schematic starts empty", conversationState().entries.length, 0);

    await adoptSubject(houseA);
    const back = conversationState();
    equal("reopening brings the log back", back.entries.map((e) => e.text), [
      "add a roof",
      "Added one.",
    ]);
    equal("...with the memory boundary intact", back.rememberedFrom, 0);
    check(
      "...and the model's half too, which is what makes the next turn work",
      JSON.stringify(conversationMessages()).includes("add a roof"),
      JSON.stringify(conversationMessages()),
    );
  }

  /*
   * The build-from-chat case, which is the reason a conversation has a subject
   * at all. Typing with nothing open, then saving what got built, must file the
   * conversation under the new document rather than lose it.
   */
  {
    resetConversation(null);
    appendEntry({ role: "user", text: "build me a shed" });
    appendEntry({ role: "agent", text: "Built shed.schem." });
    const shed = path.join(workDir, "shed.schem");
    await adoptSubject(shed);

    equal("adoption keeps what was said", conversationState().entries.length, 2);
    resetConversation(null);
    await adoptSubject(shed);
    equal("...and it was filed under the new document", conversationState().entries.length, 2);
  }

  // Windows reaches the same file through paths differing only in case, and two
  // records for one schematic would each hold half a history.
  {
    resetConversation(null);
    await adoptSubject(houseA);
    const shouted = houseA.toUpperCase();
    resetConversation(null);
    await adoptSubject(shouted);
    equal(
      "a differently-cased path finds the same conversation",
      conversationState().entries.map((e) => e.text),
      ["add a roof", "Added one."],
    );
  }

  /*
   * A record from a build that stored `messages` differently. The entries are
   * the user's own words and cannot be regenerated; the messages can be lived
   * without. So the log survives, marked entirely as history -- which is
   * exactly what the memory divider was built to show.
   */
  {
    const orphan = path.join(workDir, "orphan.schem");
    await writeFile(
      path.join(dir, storeFileName(orphan)),
      JSON.stringify({
        version: 999,
        filePath: orphan,
        conversations: [
          {
            id: "old",
            title: "from the future",
            createdAt: 1,
            updatedAt: 2,
            entries: [{ role: "user", text: "something I typed", remembered: true }],
            messages: [{ shape: "nobody here recognises" }],
            rememberedFrom: 0,
          },
        ],
      }),
      "utf8",
    );

    resetConversation(null);
    await adoptSubject(orphan);
    const salvaged = conversationState();
    equal("an unreadable version keeps the words", salvaged.entries.length, 1);
    equal("...and marks the whole log as history", salvaged.rememberedFrom, 1);
    equal("...having dropped the part it cannot trust", conversationMessages().length, 0);
  }

  // A file that is not this schematic's -- a hash collision, or a record copied
  // between machines. Showing it would be worse than showing nothing.
  {
    const stranger = path.join(workDir, "stranger.schem");
    await writeFile(
      path.join(dir, storeFileName(stranger)),
      JSON.stringify({
        version: 1,
        filePath: path.join(workDir, "somebody-else.schem"),
        conversations: [
          { id: "x", title: "t", createdAt: 1, updatedAt: 2, entries: [{ role: "user", text: "not yours" }], messages: [], rememberedFrom: 0 },
        ],
      }),
      "utf8",
    );
    resetConversation(null);
    await adoptSubject(stranger);
    equal("a record for another path is not shown", conversationState().entries.length, 0);
  }

  // Nonsense on disk must not take the app down with it.
  {
    const broken = path.join(workDir, "broken.schem");
    await writeFile(path.join(dir, storeFileName(broken)), "{ this is not json", "utf8");
    resetConversation(null);
    await adoptSubject(broken);
    equal("a corrupt file reads as no conversation", conversationState().entries.length, 0);
  }

  // The pure arithmetic, which the file cases above exercise only indirectly.
  equal("a title is the first thing the user said", titleFor([
    { role: "agent", text: "hello" },
    { role: "user", text: "  make   it taller " },
  ]), "make it taller");
  equal("...and something readable when they have said nothing", titleFor([]), "New chat");
  check(
    "a long first message is cut, not wrapped",
    titleFor([{ role: "user", text: "x".repeat(200) }]).length <= 60,
  );
  equal(
    "the newest conversation is the one reopened",
    mostRecent([
      { id: "a", title: "a", createdAt: 0, updatedAt: 10, entries: [], messages: [], rememberedFrom: 0 },
      { id: "b", title: "b", createdAt: 0, updatedAt: 99, entries: [], messages: [], rememberedFrom: 0 },
    ])?.id,
    "b",
  );

  /*
   * Several conversations about one schematic, which is what the picker lists.
   *
   * The property that matters: "new chat" *keeps* the old one. It used to
   * delete it, and the difference is the whole feature.
   */
  {
    const many = path.join(workDir, "many.schem");
    resetConversation(null);
    await adoptSubject(many);

    appendEntry({ role: "user", text: "the first conversation" });
    await newConversation();
    equal("a new conversation starts empty", conversationState().entries.length, 0);

    appendEntry({ role: "user", text: "the second conversation" });
    const list = await listConversations();
    equal("both are listed", list.conversations.length, 2);
    check(
      "the one on screen is marked active",
      list.conversations.some((one) => one.id === list.activeId),
    );
    equal(
      "...and they are titled by what was said",
      [...list.conversations].map((one) => one.title).sort(),
      ["the first conversation", "the second conversation"],
    );

    // Going back to the earlier one, and finding it intact.
    const earlier = list.conversations.find((one) => one.title === "the first conversation");
    const back = await openConversation(earlier?.id ?? "");
    equal("switching back brings its log", back.entries.map((e) => e.text), [
      "the first conversation",
    ]);

    // And the one we left is still there, not lost by the switch.
    const after = await listConversations();
    equal("...and the one we left is still listed", after.conversations.length, 2);

    // An id that is not there changes nothing. The renderer's list can be a
    // moment out of date and a stale click should be a no-op, not an error.
    const unchanged = await openConversation("no-such-id");
    equal("an unknown id is a no-op", unchanged.entries.length, 1);

    // Deleting one that is not on screen leaves the current one alone.
    const other = after.conversations.find((one) => one.title === "the second conversation");
    const kept = await deleteConversation(other?.id ?? "");
    equal("deleting another leaves this one", kept.entries.length, 1);
    equal("...and it is gone from the list", (await listConversations()).conversations.length, 1);

    // Deleting the one on screen leaves an empty one rather than guessing which
    // of the others to jump to.
    const current = await listConversations();
    const emptied = await deleteConversation(current.activeId);
    equal("deleting the active one empties the panel", emptied.entries.length, 0);
  }

  resetConversation(null);
}

// --- what a schematic is for ------------------------------------------------
//
// No project file, deliberately: this rides in the per-path sidecar the
// conversations already use, so the .schem stays the only thing the user sees
// and moves. Losing the sidecar loses the convenience and nothing else, which
// is the property a .saproj would not have.
console.log("\n--- project notes ---");
{
  equal(
    "a full set is kept",
    coerceProject({ version: "JE_1_12_2", format: "mcedit", description: "a windmill" }),
    { version: "JE_1_12_2", format: "mcedit", description: "a windmill" },
  );
  // Field by field, never spread: a sidecar edited by hand, or written by a
  // build that stored something else there, must not put a nonsense format into
  // a dialog that then writes a file in it.
  equal("a bogus format is dropped rather than trusted", coerceProject({ format: "zip" }), undefined);
  equal("...and so is a blank version", coerceProject({ version: "" }), undefined);
  equal("nothing at all is nothing", coerceProject(null), undefined);
  equal("a partial set keeps what it has", coerceProject({ format: "sponge2", extra: 1 }), {
    format: "sponge2",
  });

  /*
   * `litematic` used to be dropped here, in silence.
   *
   * The fourth container was added to `SchematicFormat` and this whitelist was
   * written out as three names, so a `.litematic` remembered its container and
   * then opened Save As on Sponge -- with nothing failing anywhere, because a
   * missing note is a legal state. It is checked against the format list now,
   * which is why a fifth container cannot repeat it.
   */
  equal("the fourth container is remembered like the other three", coerceProject({ format: "litematic" }), {
    format: "litematic",
  });

  /*
   * What empty space is made of rides here too, and for the reason the whole
   * sidecar exists: it is written into *this* file when a block is broken, so
   * an underwater jetty and a cathedral want different answers. As a global
   * setting it followed you between them, silently changing what a break wrote.
   */
  equal("the void block is remembered per file", coerceProject({ voidBlock: "minecraft:water" }), {
    voidBlock: "minecraft:water",
  });
  equal(
    "...carrying its state, because that is what a break writes",
    coerceProject({ voidBlock: "minecraft:water[level=0]" }),
    { voidBlock: "minecraft:water[level=0]" },
  );
  /*
   * Air is absence, both ways round. A sidecar written by an older build, or
   * by hand, can spell it out; storing that rather than nothing would make
   * `fillVoid` intern air over air and hand the mesher a palette in which every
   * index is void and none of them draws anything.
   */
  equal("air is no answer at all", coerceProject({ voidBlock: "minecraft:air" }), undefined);
  equal("...however it is spelled", coerceProject({ voidBlock: "  air  " }), undefined);
  equal("...and an empty one is the same", coerceProject({ voidBlock: "" }), undefined);

  /*
   * A record with notes and no conversations survives. Someone can set a
   * version on a file and never open the chat, and reading that back as "no
   * record" would throw the setting away on the next save.
   */
  const notesOnly = coerceRecord(
    { version: 1, filePath: "C:/a.schem", conversations: [], project: { format: "mcedit" } },
    "C:/a.schem",
  );
  check("a record with only notes is still a record", notesOnly !== null);
  equal("...and the notes came through", notesOnly?.project, { format: "mcedit" });

  const nothing = coerceRecord({ version: 1, filePath: "C:/a.schem", conversations: [] }, "C:/a.schem");
  equal("...but an empty record with no notes is nothing", nothing, null);
}

// --- what a trace costs on disk ---------------------------------------------
//
// A generation's request carries the whole block-id list: 933 ids, 24 kB, the
// same 24 kB every time, because it is a constant of the app rather than
// anything about that turn. Ten conversations per schematic across a hundred
// schematics is where that arithmetic ends up, so it is shown in full while the
// turn is live and written down abridged.
console.log("\n--- what a trace costs on disk ---");
{
  const long = "x".repeat(MAX_STORED_TRACE_TEXT * 3);
  const [abridged, short] = abridgeTrace([
    { id: 1, kind: "request", text: long },
    { id: 2, kind: "tool", name: "fill_region", text: "filling", output: "{}" },
  ]);

  check("a long item is cut to the cap", abridged.text.length === MAX_STORED_TRACE_TEXT, String(abridged.text.length));
  // Said out loud, never trailing off: a request silently cut in half reads as
  // a request that really was that short.
  check("...and says what it dropped", (abridged.elided ?? "").includes("more characters"), abridged.elided);
  equal("a short one is untouched", short.text, "filling");
  equal("...keeping everything else about it", [short.name, short.output], ["fill_region", "{}"]);
  check("the original is not modified", long.length === MAX_STORED_TRACE_TEXT * 3);
}

// --- opening a document points the conversation at it -----------------------
//
// A conversation is stored under the *file path*, so every way of putting a
// file on screen has to say which file that is. There are two, and only one of
// them was doing it: a schematic restored from the previous session's autosave
// came back with an empty chat, while the same file opened from the recents
// came back with its history. The difference was one missing call.
//
// Restoring a *version* or a *checkpoint* deliberately does not adopt anything:
// those replace the document with another state of the same file, and the
// subject has not moved. So this names the two handlers rather than every
// `adoptDocument` in the file — the rule is about opening, not about adopting.
console.log("\n--- recovering is opening ---");
{
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main", "ipc", "handlers.ts"),
    "utf8",
  );

  /** The body of one `ipcMain.handle(IPC.x, ...)` registration. */
  const bodyOf = (channel: string): string => {
    const at = source.indexOf(`IPC.${channel}`);
    if (at === -1) return "";
    // To the next registration, which is where this one stops mattering.
    const next = source.indexOf("ipcMain.handle(", at + 1);
    return source.slice(at, next === -1 ? source.length : next);
  };

  for (const channel of ["docOpen", "docRecoveryResolve"]) {
    const body = bodyOf(channel);
    check(`${channel} is registered`, body !== "");
    check(
      `...and points the conversation at the file it opened`,
      /adoptSubject\(/.test(body),
      `${channel} puts a document on screen without saying which conversation it belongs to`,
    );
  }
}

// --- what the window says on its way down -----------------------------------
/*
 * The failure this wording is for is silent and total: a reactive loop that
 * Svelte or the browser aborts takes every effect in the window with it, while
 * the viewport goes on drawing and main goes on answering. Navigable and
 * completely dead, with a clean console -- reported that way twice before
 * anything was listening for it.
 */
console.log("\n--- what the window says on its way down ---");
{
  const plain = failurePrompt("");
  /*
   * Escape and the window's close button both land on `cancelId`, so the half
   * that reloads must never be the one they reach. `discard_prompt`'s rule, and
   * here it matters more: this dialog is raised *by* an error, so it can appear
   * while somebody is in the middle of something else.
   *
   * The indices are literal types, so `tsc` rejects any comparison between them
   * outright -- which is a stronger statement than a check could make, and is
   * why there is not one. What no type states is that they are three distinct
   * buttons with words on them.
   */
  check(
    "three buttons, and they say different things",
    plain.buttons.length === 3 &&
      plain.buttons.every((label) => label.trim() !== "") &&
      new Set(plain.buttons).size === 3,
    plain.buttons.join(" | "),
  );
  check(
    "it says what a reload costs",
    plain.detail.includes("undo history"),
    plain.detail,
  );
  /*
   * And what it does not cost. Autosave lives in main, on a 20-second timer,
   * and main is the half still working -- so the snapshot is current however
   * long the window has been dead. A dialog that only warned would leave
   * somebody weighing a reload against an unknown.
   */
  check(
    "...and what it does not",
    plain.detail.includes("20 seconds"),
    plain.detail,
  );

  const said = failurePrompt("effect_update_depth_exceeded");
  check(
    "what the renderer managed to say is carried through",
    said.detail.includes("effect_update_depth_exceeded"),
    said.detail,
  );

  /*
   * The count, and only when there is one. The renderer reports once, so a
   * number here means something genuinely kept failing underneath -- worth
   * knowing before choosing, and misleading shown as a zero.
   */
  check("no count when nothing followed", !plain.detail.includes("further"), plain.detail);
  check(
    "...and one when something did",
    failurePrompt("x", 3).detail.includes("3 further errors"),
  );
  check(
    "...counted in the singular when it is one",
    failurePrompt("x", 1).detail.includes("1 further error since"),
  );

  /*
   * The report, which is the thing a person actually pastes. The versions are
   * in it because an issue asks for them every time, and because main has all
   * of them without asking the renderer -- which matters when the renderer is
   * the half that has stopped answering.
   */
  const facts = {
    appName: "Schematic AI Studio",
    appVersion: "1.0.0",
    platform: "win32 x64",
    electron: "33.0.0",
    chrome: "130.0.0",
    node: "20.18.0",
    kind: "error" as const,
    message: "Cannot read properties of null (reading 'children')",
    at: "app.js:1:2",
    stack: "at $effect (BlockPicker.svelte)",
  };
  const text = failureReport(facts);
  for (const wanted of [
    "1.0.0",
    "win32 x64",
    "33.0.0",
    "Cannot read properties of null",
    "BlockPicker.svelte",
  ]) {
    check(`the report carries ${wanted}`, text.includes(wanted), text);
  }

  /*
   * An empty stack or location leaves no ragged blank line behind. It is the
   * ordinary case for a rejection, not an edge one.
   */
  const bare = failureReport({ ...facts, at: "", stack: "" });
  check(
    "...and says nothing where there was nothing to say",
    !bare.includes("at ") && !/\n\s*\n\s*$/.test(bare),
    JSON.stringify(bare),
  );

  /*
   * The issue URL is built from the repository the manifest already names, and
   * carries an **abridged** body: GitHub takes it as a query parameter, so it
   * travels in a URL, and a stack clears that ceiling easily. `abridgeTrace`'s
   * rule -- cap on the way out and say what was dropped. The whole report is on
   * the clipboard by then, so the sentence is an instruction, not an apology.
   */
  const long = failureReport({ ...facts, stack: "at frame\n".repeat(400) });
  check(
    "a long report is abridged for the URL",
    issueBody(long).length < long.length,
    `${issueBody(long).length} vs ${long.length}`,
  );
  check(
    "...and says where the rest of it is",
    issueBody(long).includes("clipboard"),
  );
  check(
    "a short one is carried whole",
    issueBody(text).includes(facts.message),
  );

  const url = issueUrl("https://github.com/gamerover98/Schematic-Ai-Studio", text);
  check(
    "the URL points at the repository the manifest names",
    url.startsWith("https://github.com/gamerover98/Schematic-Ai-Studio/issues/new?"),
    url,
  );
  /*
   * And it survives the round trip. A body that arrived percent-mangled would
   * still open a page, which is exactly the kind of wrong that looks right.
   */
  const body = new URL(url).searchParams.get("body") ?? "";
  check(
    "...and the body decodes back to what was put in it",
    body === issueBody(text),
  );
  check(
    "...trailing slash or not",
    issueUrl("https://example.com/repo/", text).includes("/repo/issues/new?"),
  );
}

// --- every declared channel is actually served ------------------------------
//
// `shared/ipc.ts` is a list of verbs and `handlers.ts` is where they are
// answered, and nothing but care connects the two: a channel can be declared,
// exposed through the preload bridge and called from the renderer while never
// being registered -- at which point the button that calls it looks inert, or
// `invoke` rejects naming a channel the reader has just been looking at.
//
// That is not hypothetical. `generateCancel` is here because the chat's Stop
// button was shown for a generation and did nothing: `generate` had accepted an
// `AbortSignal` since it was written and was never handed one, and there was no
// channel to ask for it. This walks the source rather than the module, because
// `handlers.ts` imports Electron and cannot be loaded here.
// --- the picture a copy leaves behind ------------------------------------------
//
// Ctrl+C arms a ghost of what is held, drawn where Ctrl+V would put it. It is
// the *clipboard's* geometry and not the selection's, and a **cut** is the one
// gesture that can tell those apart: by the time the ghost is asked for, the
// region it came from is empty, so a picture meshed from the region would be
// nothing at all -- on the gesture where seeing what you are holding matters
// most.
console.log("\n--- the picture a copy leaves behind ---");
{
  const pack = await findBundledResourcePack();
  const options = { resourcePackPath: null, fallbackResourcePackPath: pack };
  const session = newDocument({ width: 8, height: 4, length: 8 });

  // Nothing has been copied in this suite, so this is genuinely the state
  // before the first copy rather than a leftover -- which is the null arm.
  const nothing = await clipboardMesh(session, options);
  equal("nothing copied yet is nothing to draw", nothing.chunks.length, 0);

  for (let x = 1; x <= 2; x += 1) {
    for (let z = 1; z <= 2; z += 1) {
      setBlock(session.doc, x, 0, z, { namespacedName: "minecraft:stone", properties: {} });
    }
  }
  const region = { minX: 1, minY: 0, minZ: 1, maxX: 2, maxY: 0, maxZ: 2 };
  cutSelection(session, region);

  const fromRegion = await regionMesh(session, region, options);
  equal("a cut region has nothing left to draw", fromRegion.chunks.length, 0);
  const held = await clipboardMesh(session, options);
  check(
    "...and the clipboard still draws what was taken",
    held.chunks.some((chunk) => chunk.positions.length > 0),
    String(held.chunks.length),
  );
  closeDocument();
}

console.log("\n--- ipc channels ---");
{
  /*
   * Every `.ts` under `src/main`, not only `handlers.ts`.
   *
   * It read that one file, which was right while it was the only place a
   * channel was ever served from. The menu broke that: its eight channels are
   * sent from `menu.ts`, and a check pinned to one file would have called all
   * eight unserved — reporting a correct menu as broken, which is the failure
   * mode that gets a tripwire deleted instead of fixed. The rule was always
   * "main serves it", never "this file serves it".
   */
  const mainDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main");
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) sources.push(readFileSync(full, "utf8"));
    }
  };
  walk(mainDir);
  const handlers = sources.join("\n");

  // Three ways a channel is legitimately served: answered as a request, sent
  // as an event, or *listened for* as one. A mention in a comment or a name in
  // a type does not count, which is the whole point of matching the call and
  // not the identifier.
  // `ipcMain.on` is the third and arrived with `rendererFailed`, which is sent
  // by a window that may be moments from being unable to run anything -- so it
  // has to be an event with nothing to reply to, and a walk that knew only the
  // other two called a served channel unserved.
  // The whitespace is loose because a handler with a long signature is split
  // across lines by the formatter, and a check that only recognised the
  // one-line form would report perfectly good channels as unserved.
  // `\bsend(` rather than `.send(`, and `[,)]` rather than `,`: an event with
  // no payload is `send(IPC.menuNew)` through a local helper, and the older
  // pattern would have missed every one of them.
  const served = (name: string): boolean =>
    new RegExp(`(?:ipcMain\\.(?:handle|on)|\\bsend)\\(\\s*IPC\\.${name}\\s*[,)]`).test(handlers);

  const unserved = Object.keys(IPC).filter((name) => !served(name));
  equal("every channel in IPC is handled or sent by main", unserved.join(", "), "");
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);

// `exitCode` rather than `exit()`, unlike the other suites, and not by taste.
// The four provider calls above leave keep-alive sockets in fetch's connection
// pool; `process.exit()` tears libuv down while they are still open, and Node
// on Windows aborts with
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
// *after* printing that every check passed -- so the suite reported success and
// exited 127. Setting the code and letting the event loop drain lets those
// sockets close themselves. It costs a second or two at the end of this suite.
process.exitCode = failures === 0 ? 0 : 1;
