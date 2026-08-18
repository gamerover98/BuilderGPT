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

import { existsSync } from "fs";
import { createServer } from "http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

import { loadStructure } from "../src/main/pipeline/loader.js";
import { openCodeModelRequiresKey } from "../src/shared/ipc.js";
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

function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}`);
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

  const sun = sunAnglesRadians({
    sunAzimuthDeg: 180,
    sunElevationDeg: 90,
    maxDpr: 1,
    renderScale: 1,
    maxDrawDistance: 512,
    showGrid: true,
    wireframe: false,
    ambientOcclusion: true,
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
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "mimo-v2.5-free",
          choices: [
            { index: 0, message: { role: "assistant", content: "builder.setBlock(0,0,0)" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
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

  equal("a new list starts with what was opened", rememberRecent([], A, true), [A]);
  equal("the newest goes first", rememberRecent([A], B, true), [B, A]);

  // The point of the list: reopening something you already have moves it up
  // rather than giving it a second slot that opens the same file.
  equal("reopening promotes rather than duplicates", rememberRecent([A, B, C], C, true), [C, A, B]);
  equal(
    "...and the list does not grow doing it",
    rememberRecent([A, B, C], C, true).length,
    3,
  );

  // On Windows the same schematic reached through the picker and through a drop
  // can differ only in the drive letter's case.
  equal(
    "a path differing only in case is the same file when case is ignored",
    rememberRecent([A], A.toUpperCase(), false),
    [A.toUpperCase()],
  );
  equal(
    "...and a different one where case matters",
    rememberRecent([A], A.toUpperCase(), true).length,
    2,
  );

  // The cap has to drop the *oldest*, which is the end of the list.
  const many = Array.from({ length: 10 }, (_, i) => `C:/builds/${i}.schem`);
  const capped = rememberRecent(many, "C:/builds/new.schem", true, 10);
  equal("the list stops at the cap", capped.length, 10);
  equal("...keeping the newest", capped[0], "C:/builds/new.schem");
  check("...and dropping the oldest", !capped.includes("C:/builds/9.schem"));

  equal("forgetting removes it", forgetRecent([A, B], A, true), [B]);
  equal("forgetting something absent changes nothing", forgetRecent([A, B], C, true), [A, B]);

  // A settings file written by another build, or edited by hand.
  equal("a non-array reads as empty", coerceRecents({ nope: true }), []);
  equal("nulls and numbers are dropped", coerceRecents([A, null, 7, "", B]), [A, B]);
  equal("...and the cap still applies", coerceRecents(many, 3).length, 3);
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
