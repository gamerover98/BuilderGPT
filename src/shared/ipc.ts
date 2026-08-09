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

export interface OpenCodeModel {
  id: string;
  /** e.g. `"mimo-v2.5-free (Gratuito | Thinking)"` -- component.py:192-199. */
  label: string;
}

export interface PickFileRequest {
  /** Mirrors the four `st.file_uploader` call sites in component.py. */
  kind: "image" | "resource-pack" | "schem";
}

export interface PickFileResponse {
  /** `null` when the user cancelled. */
  path: string | null;
  name: string | null;
}

export interface GenerateRequest {
  requestId: string;
  description: string;
  version: string;
  exportType: ExportType;
  /** Path from `pickFile`, not bytes -- ARCHITECTURE.md §4 change 5. */
  imagePath: string | null;
}

export interface GenerateSuccess {
  /** Absolute path of the saved artifact under `userData/generated/`. */
  path: string;
  name: string;
  exportType: ExportType;
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
  listOpenCodeModels(): Promise<OpenCodeModel[] | null>;

  pickFile(req: PickFileRequest): Promise<PickFileResponse>;
  revealPath(path: string): Promise<void>;

  generate(req: GenerateRequest): Promise<GenerateResponse>;
  preview(req: PreviewRequest): Promise<PreviewResponse>;

  listArtifacts(): Promise<Artifact[]>;

  onProgress(listener: (event: ProgressEvent) => void): () => void;
}
