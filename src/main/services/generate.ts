/**
 * Ported from `BuilderGPTComponent.generate` (component.py:106-178).
 *
 * Structure preserved: two LLM calls (structure, then name), the same prompt
 * substitutions, the same progress checkpoints, the same two export branches,
 * artifact registration at the end.
 *
 * Changed: the output location is now a setting, and the `{name}-{uuid4}`
 * filename is `{name}` -- see `services/output.ts` for why the UUID went and
 * what replaced it.
 */

import { copyFile, rename, rm, writeFile } from "fs/promises";

import type { DroppedBlock, ProgressEvent, TraceItem } from "../../shared/ipc.js";
import type { ExportType, Provider } from "../../shared/settings.js";
import {
  attachTrace,
  conversionFailureMessage,
  formatVersionForPrompt,
  inputVersionToMcsTag,
  textToSchem,
  loadAllowedBlocks,
  GeneratedCodeError,
  SandboxUnavailableError,
  SandboxViolationError,
} from "../core.js";
import { writeArtifact } from "./artifacts.js";
import { callLlm } from "./llm.js";
import { sanitizeName } from "./naming.js";
import { TraceRecorder, type TraceSink } from "./trace.js";
import { resolveOutputPath } from "./output.js";
import {
  generatedDir,
  legacyBlocksPath,
  loadBlockIdListText,
  loadPrompts,
  resourcesDir,
} from "./resources.js";
import { eraOf, mcVersion } from "../../shared/mc_versions.js";
import { blocksIn } from "../../shared/block_versions.js";
import { legacyBlockNames } from "./writers.js";
import { loadLegacyBlockTable } from "../pipeline/loader_formats.js";
import { SpongeSchematicWriter, SpongeSchematicWriterFactory } from "./schematic.js";
import { VERSION_TABLE } from "./versions.js";

/**
 * The block ids a generation for this version is allowed to name.
 *
 * Whole for the flat era, and cut to `legacy_blocks.json` below 1.13 -- the
 * same table the writer decides the save on, so the list a model is given and
 * the set it will be judged against cannot drift.
 *
 * Falls back to the whole list if the set cannot be worked out. A generation
 * that offers too much is recoverable; one that offers nothing is not.
 */
async function blockListFor(version: string): Promise<string> {
  const whole = await loadBlockIdListText();
  try {
    /*
     * Two tables, each authoritative where the other says nothing:
     * `legacy_blocks.json` enumerates the pre-Flattening set exactly, and
     * `block_versions.json` is the flat era only. Which one answers is decided
     * by the era rather than by merging them.
     */
    let names: ReadonlySet<string>;
    if (eraOf(version) === "legacy") {
      names = legacyBlockNames(await loadLegacyBlockTable(legacyBlocksPath()));
    } else {
      const dataVersion = mcVersion(version)?.dataVersion ?? null;
      // A version with no tag is not a question the flat table can be asked.
      if (dataVersion === null) return whole;
      names = blocksIn(dataVersion);
    }
    return whole
      .split(/\r?\n/)
      .filter((line) => {
        const id = line.trim();
        // Comments and blanks are the file's own header; they carry no id and
        // are what tells the model where the list came from.
        if (id === "" || id.startsWith("#")) return true;
        return names.has(id.includes(":") ? id : `minecraft:${id}`);
      })
      .join("\n");
  } catch {
    return whole;
  }
}


export class EmptyResultError extends Error {
  /*
   * component.py:406's `st.error("Failed to generate schematic")` -- the
   * `result is None` branch, which happens when text_to_schem could neither
   * run the JS nor parse legacy JSON.
   *
   * It used to say only that, which is true and useless: the two ways to reach
   * it want opposite things from the reader. A script that threw is the model's
   * code being wrong, and the error names it; an answer with no `<code>` block
   * in it is the model ignoring the output format, and no amount of rewording
   * the build spec addresses that. The raw answer is in the turn's trace either
   * way -- that is what it is there for.
   */
  constructor(outcome?: { reason: "script-failed" | "no-script"; detail: string }) {
    super(
      outcome === undefined
        ? "Failed to generate schematic: the model's output could not be converted"
        : conversionFailureMessage(outcome),
    );
    this.name = "EmptyResultError";
  }
}


export interface GenerateOptions {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl: string;
  description: string;
  version: string;
  exportType: ExportType;
  imagePath: string | null;
  /** `false` when the selected model is text-only; see `llm.ts`'s `LlmRequest`. */
  acceptsImages?: boolean;
  /**
   * Where the finished file goes. Empty/omitted means the app's own
   * `generated/` folder under userData. Resolved by the caller so this module
   * keeps taking its output location as data.
   */
  outputDir?: string | null;
  onProgress?: (phase: ProgressEvent["phase"], fraction: number, message: string) => void;
  /**
   * Where the running commentary goes.
   *
   * The progress phases were the whole of this path's feedback, and they went
   * to a bar in a panel the user is not looking at while they chat. This adds
   * the parts that were never visible anywhere: the request that was sent,
   * verbatim, and the build script as the model writes it.
   */
  onTrace?: TraceSink;
  /** Which run this is, so its trace events can be told from another's. */
  requestId?: string;
  signal?: AbortSignal;
}

export interface GenerateOutcome {
  path: string;
  name: string;
  exportType: ExportType;
  /** What the run did, in order, for the chat to show and to keep. */
  trace: TraceItem[];
  /** Set when a file of the same name was moved aside to make room. */
  backedUpTo: string | null;
  /**
   * Blocks the model asked for that the allowlist refused, most-refused first.
   * Empty on a clean build. Reported rather than swallowed -- see
   * `core.ts`'s `BuildRejection`.
   *
   * Mutable, and the IPC type rather than a local one: this array is handed
   * straight to the renderer, and `shared/ipc.ts` owns that shape.
   */
  droppedBlocks: DroppedBlock[];
}

export async function generate(options: GenerateOptions): Promise<GenerateOutcome> {
  const report = options.onProgress ?? (() => {});
  const recorder = new TraceRecorder(options.requestId ?? "", options.onTrace);
  /** A phase, said in the trace as well as on the progress bar. */
  const note = (text: string) => recorder.finish(recorder.start({ kind: "note", text }));
  /*
   * Everything the run did travels with a failure too.
   *
   * The trace used to ride only on success, which is exactly backwards: a run
   * that worked left a file to look at, and a run that failed left one
   * sentence. The answer the model actually gave -- the only thing that
   * explains why nothing could be built from it -- went out with the
   * exception.
   */
  try {

    const prompts = await loadPrompts();
    /*
     * The block list is cut to the target version, and that is not a nicety.
     *
     * The prompt says "you must only use block types from the following list"
     * and then handed the same list for every version -- so a generation aimed
     * at 1.12.2 was told, in its own instructions, that deepslate was allowed.
     * The model obeyed the list it was given and the save refused the result.
     *
     * Only the legacy boundary is cut, for `inventoryBlocks`' reason: there is
     * no per-block introduction data above 1.13, and telling a model a block
     * does not exist when it does is worse than the reverse.
     */
    const blockIdList = await blockListFor(options.version);

    // component.py:112-118
    const humanVersion = formatVersionForPrompt(options.version);
    const sysPrompt = prompts.SYS_GEN.replace("%MINECRAFT_VERSION%", humanVersion)
      .replace("%BUILD_SPEC%", options.description)
      .replace("%BLOCK_TYPES_LIST%", blockIdList);
    // component.py:120 -- "Keep user prompt minimal to satisfy providers that
    // require both roles."
    const userPrompt = "Generate the structure.";

    report("prompting", 0.2, "Sending the build spec to the model");

    /*
     * Exactly what goes out, verbatim -- the substituted template, the block-id
     * list and all. This is the one thing about a generation that was visible
     * nowhere: the description in the box is a fragment of it, and the rest is
     * assembled here from files the user never sees.
     */
    recorder.finish(
      recorder.start({
        kind: "request",
        text: ["=== system ===", sysPrompt, "", "=== user ===", userPrompt].join("\n"),
      }),
    );

    const script = recorder.start({ kind: "text", text: "", running: true });
    let thinking: number | null = null;

    const response = await callLlm({
      provider: options.provider,
      model: options.model,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      systemPrompt: sysPrompt,
      userPrompt,
      imagePath: options.imagePath,
      acceptsImages: options.acceptsImages,
      signal: options.signal,
      onDelta: (text) => recorder.append(script, text),
      onReasoning: (text) => {
        // Opened lazily: most models emit no reasoning at all, and an empty
        // block sitting above every build would read as one that failed.
        if (thinking === null) thinking = recorder.start({ kind: "reasoning", text: "", running: true });
        recorder.append(thinking, text);
      },
    });
    if (thinking !== null) recorder.finish(thinking);
    recorder.finish(script);

    report("converting", 0.6, "Running the generated build script");
    note("Running the build script in the sandbox");

    // Two different directories, deliberately. `core.ts` writes an intermediate
    // `temp.mcfunction` into whatever it is given; that is app scratch and stays
    // under userData. Only the finished file goes to the user's folder -- nobody
    // wants build litter appearing in a directory they browse.
    const scratchDir = generatedDir();
    const outDir = options.outputDir?.trim() ? options.outputDir.trim() : generatedDir();
    const allowedBlocks = await loadAllowedBlocks(resourcesDir());
    const factory = new SpongeSchematicWriterFactory();

    const result = await textToSchem(response, options.exportType, {
      schematicWriterFactory: factory,
      allowedBlocks,
      generatedDir: scratchDir,
    });

    if (result.kind === "none") {
      throw new EmptyResultError(result);
    }

    report("naming", 0.8, "Naming the structure");
    note("Asking the model to name the structure");

    // component.py:134 -- second LLM call, name only, no image.
    const rawName = await callLlm({
      provider: options.provider,
      model: options.model,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      systemPrompt: prompts.SYS_GEN_NAME,
      userPrompt: prompts.USR_GEN_NAME.replace("%DESCRIPTION%", options.description),
      signal: options.signal,
    });
    // component.py:143 appended a `uuid4` here. That was a collision strategy
    // rather than a naming one, and it is `services/output.ts`'s job now: the
    // name is the structure's, and an existing file is moved aside rather than
    // overwritten. `sanitizeName` stays -- it is the guard against an LLM
    // answering with `../../evil`.
    const name = sanitizeName(rawName);

    report("saving", 0.9, "Writing the file");

    const ext = result.kind === "schematic" ? "schem" : "mcfunction";
    const { filePath, backedUpTo } = await resolveOutputPath(outDir, name, ext);

    if (result.kind === "schematic") {
      // component.py:136 + 144: `input_version_to_mcs_tag` picks the version tag,
      // then `result.save(...)`. The tag is a DataVersion int here (see
      // services/versions.ts and RULEBOOK.md DEV-014).
      const dataVersion = inputVersionToMcsTag(options.version, VERSION_TABLE);
      if (typeof dataVersion !== "number") {
        throw new Error(`Unsupported Minecraft version: ${options.version}`);
      }
      const writer = result.schematic as SpongeSchematicWriter;
      await writeFile(filePath, await writer.toBytes(dataVersion));
    } else {
      // component.py:154-167 moved core's `temp.mcfunction` to the final name.
      // The copy fallback is new and load-bearing now that the destination can be
      // a folder the user picked: `rename` fails with EXDEV across volumes, and
      // the old fallback -- writing an empty file -- turned "your output folder
      // is on another drive" into "your structure came out blank".
      try {
        await rename(result.path, filePath);
      } catch {
        await copyFile(result.path, filePath);
        await rm(result.path, { force: true });
      }
    }

    await writeArtifact({
      filePath,
      name,
      type: options.exportType,
      description: options.description,
    });

    report("done", 1.0, "Done");
    return {
      path: filePath,
      name,
      exportType: options.exportType,
      trace: recorder.snapshot(),
      backedUpTo,
      droppedBlocks: result.rejections.map((rejection) => ({
        blockId: rejection.blockId,
        reason: rejection.reason,
        calls: rejection.calls,
      })),
    };

  } catch (err) {
    throw attachTrace(err, recorder.snapshot());
  }
}

/** Maps a thrown error onto `shared/ipc.ts`'s `FailureKind`. */
export function classifyGenerateError(err: unknown): {
  kind:
    | "llm-error"
    | "generated-code-error"
    | "sandbox-violation"
    | "sandbox-unavailable"
    | "empty-result"
    | "io-error";
  message: string;
  detail?: string;
} {
  if (err instanceof SandboxUnavailableError) {
    return { kind: "sandbox-unavailable", message: err.message };
  }
  if (err instanceof SandboxViolationError) {
    return {
      kind: "sandbox-violation",
      message: "The generated script tried to break out of the sandbox and was stopped.",
      detail: err.message,
    };
  }
  if (err instanceof GeneratedCodeError) {
    return { kind: "generated-code-error", message: err.message };
  }
  if (err instanceof EmptyResultError) {
    return { kind: "empty-result", message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("LLM API Error")) {
    return { kind: "llm-error", message };
  }
  return { kind: "io-error", message };
}
