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

import { existsSync, readFileSync } from "fs";
import { createServer } from "http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
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
  abridgeTrace,
  MAX_STORED_TRACE_TEXT,
  mostRecent,
  storeFileName,
  titleFor,
} from "../src/main/services/conversation_store.js";
import type { ChatEntry } from "../src/shared/ipc.js";
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
  buildDocumentPreview,
  buildPreview,
  clearBakerCache,
  clearPreviewCache,
  sunAnglesRadians,
} from "../src/main/services/preview.js";
import { documentFromLoaded, setBlock } from "../src/main/domain/document.js";
import { SpongeSchematicWriter } from "../src/main/services/schematic.js";
import { dataVersionFor, VERSION_NAMES, VERSION_TABLE } from "../src/main/services/versions.js";
import { coerceSettings, coerceUi } from "../src/main/services/settings_coerce.js";
import {
  extentVolume,
  growthToInclude,
  orderRegion,
  shiftRegion,
} from "../src/main/domain/grow.js";
import {
  DEFAULT_SETTINGS,
  DEFAULT_UI_SETTINGS,
  SIDEBAR_WIDTH,
  type Settings,
  type UiSettings,
} from "../src/shared/settings.js";

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
      return (await readdir(outDir)).every((n) => !n.startsWith(".buildergpt-write-test"));
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
    inspectorWindowX: 300,
    inspectorWindowY: 480,
    // Nine entries, none of them the default, so a `coerceUi` that quietly
    // substituted the default hotbar would not survive the comparison.
    hotbar: [
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
    hotbarSlot: 4,
  } satisfies UiSettings;

  equal("every ui field survives a round-trip", coerceUi(ui), ui);

  const settings = {
    provider: "OpenAI",
    model: "gpt-4o-mini",
    baseUrl: "https://example.invalid/v1",
    version: "JE_1_20_1",
    exportType: "mcfunction",
    outputDir: "C:/builds",
    preview: { ...DEFAULT_SETTINGS.preview, wireframe: true, maxDrawDistance: 1024 },
    ui,
  } satisfies Settings;

  equal("every settings field survives a round-trip", coerceSettings(settings), settings);

  // A file written by an older build, or edited by hand into nonsense.
  const fallback = coerceUi({ theme: "neon", language: "xx", sidebarWidth: "wide" });
  equal("an unknown theme falls back", fallback.theme, DEFAULT_UI_SETTINGS.theme);
  equal("an unknown language falls back", fallback.language, DEFAULT_UI_SETTINGS.language);
  equal(
    "a non-numeric width falls back",
    fallback.sidebarWidth,
    DEFAULT_UI_SETTINGS.sidebarWidth,
  );
  equal("a missing ui block is all defaults", coerceUi(undefined), DEFAULT_UI_SETTINGS);

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
console.log("\n--- ipc channels ---");
{
  const handlers = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main", "ipc", "handlers.ts"),
    "utf8",
  );

  // Two ways a channel is legitimately served: answered as a request, or sent
  // as an event. A mention in a comment or a name in a type does not count,
  // which is the whole point of matching the call and not the identifier.
  // The whitespace is loose because a handler with a long signature is split
  // across lines by the formatter, and a check that only recognised the
  // one-line form would report perfectly good channels as unserved.
  const served = (name: string): boolean =>
    new RegExp(`(?:ipcMain\\.handle|\\.send)\\(\\s*IPC\\.${name}\\s*,`).test(handlers);

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
