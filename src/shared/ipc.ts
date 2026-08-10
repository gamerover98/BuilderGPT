/**
 * The app's entire IPC surface, in one file.
 *
 * ARCHITECTURE.md §2 rule R-2: one channel per verb, no generic dispatcher.
 * Rule R-3: every type below must be structured-clone-safe -- plain objects,
 * primitives, arrays, and `Uint8Array`. No classes, no functions, no `Buffer`.
 */

import type {
  ExportType,
  KeyStorageStatus,
  PreviewSettings,
  Provider,
  Settings,
} from "./settings.js";

export const IPC = {
  settingsGet: "bgpt:settings:get",
  settingsSet: "bgpt:settings:set",
  keysStatus: "bgpt:keys:status",
  keysSet: "bgpt:keys:set",
  keysClear: "bgpt:keys:clear",

  versionsList: "bgpt:versions:list",
  opencodeModels: "bgpt:opencode:models",

  pickFile: "bgpt:dialog:pickFile",
  revealPath: "bgpt:shell:reveal",
  /** The app's own `generated/` folder — what an empty `outputDir` resolves to. */
  defaultOutputDir: "bgpt:output:defaultDir",

  generate: "bgpt:generate",
  preview: "bgpt:preview",

  artifactsList: "bgpt:artifacts:list",

  /** main → renderer, `ipcRenderer.on`. Replaces `st.progress`. */
  progress: "bgpt:progress",
} as const;

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export type ProgressPhase =
  | "prompting"
  | "generating"
  | "converting"
  | "naming"
  | "saving"
  | "previewing"
  | "done";

export interface ProgressEvent {
  /** Correlates with the `requestId` of the invoke that started the work. */
  requestId: string;
  phase: ProgressPhase;
  /** 0..1, matching component.py's `progress.progress(...)` checkpoints. */
  fraction: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * ARCHITECTURE.md §4 change 3: the Python UI collapsed everything into one
 * `st.error(f"Generation failed: {e}")`. `core.ts` already distinguishes
 * bad-LLM-output from a sandbox escape attempt; that distinction now reaches
 * the user.
 */
export type FailureKind =
  | "no-api-key"
  | "llm-error"
  | "generated-code-error"
  | "sandbox-violation"
  | "sandbox-unavailable"
  | "empty-result"
  | "io-error"
  | "invalid-input";

export interface Failure {
  ok: false;
  kind: FailureKind;
  message: string;
  /** Present for `sandbox-violation` -- surfaced prominently in the UI. */
  detail?: string;
}

export type Result<T> = ({ ok: true } & T) | Failure;

// ---------------------------------------------------------------------------
// Requests / responses
// ---------------------------------------------------------------------------

export interface SetKeyRequest {
  provider: Provider;
  apiKey: string;
}

/**
 * One OpenCode Zen model, as the renderer needs to reason about it.
 *
 * `component.py:192-199` had only `{id, label}` and derived the label from the
 * id ("free" in the name meant free). Both facts below are now read from
 * models.dev instead of guessed, because both drive behaviour: `pricing`
 * decides whether an API key is required, and `imageInput` decides whether the
 * reference image can be sent at all.
 *
 * `"unknown"` means models.dev has no entry for the id. It is treated
 * permissively everywhere -- see `mergeCatalogue` for why.
 */
export interface OpenCodeModelInfo {
  id: string;
  /** Human name from models.dev, or a title-cased id when it has none. */
  name: string;
  description?: string;
  pricing: "free" | "paid" | "unknown";
  imageInput: "yes" | "no" | "unknown";
  contextTokens?: number;
  /** USD per million tokens, as models.dev states it. */
  cost?: { input: number; output: number };
  reasoning?: boolean;
}

/**
 * The key gate for OpenCode, replacing the blanket provider-level exemption in
 * `providerRequiresApiKey`. A model missing from the catalogue is let through:
 * the gateway's own 401 is a better answer than refusing to try.
 */
export function openCodeModelRequiresKey(model: OpenCodeModelInfo | undefined): boolean {
  return model?.pricing === "paid";
}

export interface PickFileRequest {
  /**
   * The first three mirror the `st.file_uploader` call sites in component.py.
   * `directory` is new -- it opens a folder chooser rather than a file one --
   * and rides this channel instead of a new one because the response shape is
   * identical and the preload signature does not have to change.
   */
  kind: "image" | "resource-pack" | "schem" | "directory";
}

export interface PickFileResponse {
  /** `null` when the user cancelled, or when the choice was rejected. */
  path: string | null;
  name: string | null;
  /** Set when a choice was rejected -- e.g. a folder that cannot be written to. */
  error?: string;
}

export interface GenerateRequest {
  requestId: string;
  description: string;
  version: string;
  exportType: ExportType;
  /** Path from `pickFile`, not bytes -- ARCHITECTURE.md §4 change 5. */
  imagePath: string | null;
}

/** One block type the build script asked for and the allowlist refused. */
export interface DroppedBlock {
  /** Namespaced id, or `null` when the script passed an empty block type. */
  blockId: string | null;
  reason: string;
  /** Refused bridge calls, not refused blocks: one fill counts once. */
  calls: number;
}

export interface GenerateSuccess {
  /** Absolute path of the saved artifact, in the configured output folder. */
  path: string;
  name: string;
  exportType: ExportType;
  /**
   * Absolute path a same-named file was moved to before this one was written,
   * or `null` if there was nothing to preserve. Surfaced so "I overwrote my
   * previous build" is never something the user finds out later.
   */
  backedUpTo: string | null;
  /**
   * Blocks that never made it into the file, most-refused first. Empty on a
   * clean build.
   *
   * This crosses the boundary because the alternative is what the app did
   * before: a structure missing its walls, and no way for the user to learn
   * that the model had asked for a block the allowlist does not carry.
   */
  droppedBlocks: DroppedBlock[];
}

export type GenerateResponse = Result<GenerateSuccess>;

export interface PreviewRequest {
  requestId: string;
  schemPath: string;
  resourcePackPath: string | null;
  settings: PreviewSettings;
}

export interface PreviewSuccess {
  /**
   * Raw GLB. ARCHITECTURE.md §3 "Viewer lifecycle": no base64, no `data:` URL
   * -- `app/preview.py`'s base64 step existed only to embed the payload in the
   * Streamlit iframe's HTML.
   */
  glb: Uint8Array;
  center: [number, number, number];
  size: [number, number, number];
  /** Radians, as the viewer consumes them. */
  sunAzimuth: number;
  sunElevation: number;
  cached: boolean;
}

export type PreviewResponse = Result<PreviewSuccess>;

export interface Artifact {
  path: string;
  name: string;
  type: ExportType;
  description: string;
  createdAt: string;
}

/** The object `preload` exposes as `window.bgpt`. */
export interface BgptApi {
  getSettings(): Promise<Settings>;
  setSettings(settings: Settings): Promise<Settings>;

  getKeyStatus(): Promise<KeyStorageStatus>;
  setKey(req: SetKeyRequest): Promise<KeyStorageStatus>;
  clearKey(provider: Provider): Promise<KeyStorageStatus>;

  listVersions(): Promise<string[]>;
  listOpenCodeModels(): Promise<OpenCodeModelInfo[] | null>;

  pickFile(req: PickFileRequest): Promise<PickFileResponse>;
  revealPath(path: string): Promise<void>;
  getDefaultOutputDir(): Promise<string>;

  generate(req: GenerateRequest): Promise<GenerateResponse>;
  preview(req: PreviewRequest): Promise<PreviewResponse>;

  listArtifacts(): Promise<Artifact[]>;

  onProgress(listener: (event: ProgressEvent) => void): () => void;
}
