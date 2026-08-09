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

import type { ProgressEvent } from "../../shared/ipc.js";
import type { ExportType, Provider } from "../../shared/settings.js";
import {
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
import { resolveOutputPath } from "./output.js";
import { generatedDir, loadBlockIdListText, loadPrompts, resourcesDir } from "./resources.js";
import { SpongeSchematicWriter, SpongeSchematicWriterFactory } from "./schematic.js";
import { VERSION_TABLE } from "./versions.js";

export class EmptyResultError extends Error {
  constructor() {
    // component.py:406's `st.error("Failed to generate schematic")` -- the
    // `result is None` branch, which happens when text_to_schem could neither
    // run the JS nor parse legacy JSON.
    super("Failed to generate schematic: the model's output could not be converted");
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
  signal?: AbortSignal;
}

export interface GenerateOutcome {
  path: string;
  name: string;
  exportType: ExportType;
  /** Set when a file of the same name was moved aside to make room. */
  backedUpTo: string | null;
}

export async function generate(options: GenerateOptions): Promise<GenerateOutcome> {
  const report = options.onProgress ?? (() => {});

  const prompts = await loadPrompts();
  const blockIdList = await loadBlockIdListText();

  // component.py:112-118
  const humanVersion = formatVersionForPrompt(options.version);
  const sysPrompt = prompts.SYS_GEN.replace("%MINECRAFT_VERSION%", humanVersion)
    .replace("%BUILD_SPEC%", options.description)
    .replace("%BLOCK_TYPES_LIST%", blockIdList);
  // component.py:120 -- "Keep user prompt minimal to satisfy providers that
  // require both roles."
  const userPrompt = "Generate the structure.";

  report("prompting", 0.2, "Sending the build spec to the model");

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
  });

  report("converting", 0.6, "Running the generated build script");

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
    throw new EmptyResultError();
  }

  report("naming", 0.8, "Naming the structure");

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
  return { path: filePath, name, exportType: options.exportType, backedUpTo };
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
