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
  assertWritableDirectory,
  OutputDirectoryError,
  resolveOutputPath,
} from "../src/main/services/output.js";
import { labelFor, mergeCatalogue } from "../src/main/services/opencode.js";
import { buildPreview, clearPreviewCache, sunAnglesRadians } from "../src/main/services/preview.js";
import { SpongeSchematicWriter } from "../src/main/services/schematic.js";
import { dataVersionFor, VERSION_NAMES, VERSION_TABLE } from "../src/main/services/versions.js";

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

console.log("=== BuilderGPT redesign-slice service smoke test ===\n");

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
  check("GLB magic is 'glTF'", Buffer.from(preview.glb.slice(0, 4)).toString("ascii") === "glTF");
  check("GLB is non-trivial", preview.glb.byteLength > 512);
  check("first build is not cached", preview.cached === false);
  const cachedPreview = await buildPreview({
    schemPath,
    resourcePackPath: null,
    fallbackResourcePackPath: bundledPack,
  });
  check("second build hits the cache", cachedPreview.cached === true);
  check(
    "cached GLB is byte-identical",
    Buffer.compare(Buffer.from(preview.glb), Buffer.from(cachedPreview.glb)) === 0,
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
    Buffer.compare(Buffer.from(preview.glb), Buffer.from(untextured.glb)) !== 0,
  );

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
  console.log("\n--- opencode transport ---");
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

  try {
    const answer = await callLlm({
      provider: "OpenCode",
      model: "mimo-v2.5-free",
      apiKey: "",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      systemPrompt: "You are a Minecraft builder.",
      userPrompt: "a small stone tower",
    });
    equal("OpenCode returns the assistant text", answer, "builder.setBlock(0,0,0)");
  } catch (err) {
    check(`OpenCode request is accepted by the SDK (${err instanceof Error ? err.message : String(err)})`, false);
  }

  const sent = (captured as { messages?: Array<{ role: string; content: unknown }> } | null)?.messages ?? [];
  check("the system prompt reaches the wire as a system message", sent[0]?.role === "system");
  equal("the system prompt survives intact", sent[0]?.content, "You are a Minecraft builder.");
  check("the user prompt follows it", sent.some((m) => m.role === "user"));

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

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
