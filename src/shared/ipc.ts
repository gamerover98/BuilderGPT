/**
 * The app's entire IPC surface, in one file.
 *
 * ARCHITECTURE.md §2 rule R-2: one channel per verb, no generic dispatcher.
 * Rule R-3: every type below must be structured-clone-safe -- plain objects,
 * primitives, arrays, and `Uint8Array`. No classes, no functions, no `Buffer`.
 */

import type { SchematicFormat } from "./schematic.js";
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

  /**
   * The open document. One channel per verb (rule R-2) rather than a
   * `doc:command` dispatcher, so the payload of each is a named type the
   * compiler checks on both sides.
   */
  docOpen: "bgpt:doc:open",
  docNew: "bgpt:doc:new",
  docClose: "bgpt:doc:close",
  docState: "bgpt:doc:state",
  docMesh: "bgpt:doc:mesh",
  docApply: "bgpt:doc:apply",
  docUndo: "bgpt:doc:undo",
  docRedo: "bgpt:doc:redo",
  docInspect: "bgpt:doc:inspect",
  docSave: "bgpt:doc:save",
  /** Is there unsaved work from a session that ended badly? */
  docRecoveryPeek: "bgpt:doc:recovery:peek",
  /** Restore it, or throw it away. */
  docRecoveryResolve: "bgpt:doc:recovery:resolve",
  /** Ask the agent to edit the open document. */
  docAgent: "bgpt:doc:agent",
  /** main → renderer: one tool call the agent just made. */
  agentStep: "bgpt:agent:step",

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

// ---------------------------------------------------------------------------
// The open document
// ---------------------------------------------------------------------------

/** A block, as it crosses the boundary: a name plus its block states. */
export interface BlockSpec {
  namespacedName: string;
  properties?: Record<string, string>;
}

/** Inclusive on both corners; the main process sorts and clips it. */
export interface RegionSpec {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface PaletteCount {
  /** `minecraft:oak_stairs[facing=north]`. */
  block: string;
  count: number;
}

/**
 * Everything the renderer knows about the open schematic.
 *
 * Deliberately small and flat. The document itself is millions of voxels and a
 * map of NBT trees; it stays in main, and this is the summary the UI actually
 * draws — title bar, block count, palette list, and the state of the undo menu.
 */
export interface DocumentState {
  filePath: string | null;
  fileName: string | null;
  format: SchematicFormat;
  size: [number, number, number];
  offset: [number, number, number];
  blockCount: number;
  /** Most common first, capped — enough to show, not the whole palette. */
  palette: PaletteCount[];
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** What the undo/redo menu items should say, or `null` when unavailable. */
  undoLabel: string | null;
  redoLabel: string | null;
  /** Monotonic; the renderer uses it to tell whether its mesh is stale. */
  revision: number;
}

/**
 * One editing operation.
 *
 * The undo label is derived in main from the request, not carried on it: the
 * renderer should not be able to write history's description of what happened.
 */
export type EditRequest =
  | { kind: "setBlock"; x: number; y: number; z: number; block: BlockSpec }
  | { kind: "fill"; region: RegionSpec; block: BlockSpec }
  | { kind: "replace"; region: RegionSpec; from: BlockSpec; to: BlockSpec };

export interface DocumentMesh {
  glb: Uint8Array;
  center: [number, number, number];
  size: [number, number, number];
  /** True when the document had not changed since the last mesh was built. */
  cached: boolean;
  sunAzimuth: number;
  sunElevation: number;
}

export interface BlockInspection {
  block: string;
  properties: Record<string, string>;
  /** `nbt` is JSON, since the renderer only displays it. */
  blockEntity: { id: string; nbt: string } | null;
}

export interface EditSuccess {
  /** Voxels actually changed; 0 means the edit matched nothing. */
  changed: number;
  state: DocumentState;
}

export interface SaveRequest {
  /** Omitted means "over the file it came from"; required for Save As. */
  filePath?: string | null;
  format?: SchematicFormat;
}

export interface SaveSuccess {
  filePath: string;
  format: SchematicFormat;
  /**
   * Blocks that will not come back exactly as they went in, because the chosen
   * container cannot carry their state. Always empty for Sponge.
   */
  degraded: string[];
  state: DocumentState;
}

/** One tool call, as it happens, so the chat can narrate rather than hang. */
export interface AgentStepEvent {
  requestId: string;
  tool: string;
  summary: string;
}

export interface AgentRequestPayload {
  requestId: string;
  prompt: string;
  /** The user's selection, which the agent's tools default to. */
  selection: RegionSpec | null;
}

export interface AgentSuccess {
  /** The model's closing explanation. */
  text: string;
  changed: number;
  steps: { tool: string; summary: string }[];
  state: DocumentState;
}

export type AgentResponse = Result<AgentSuccess>;

/**
 * Unsaved work found on disk from a previous session.
 *
 * Offered on launch. `null` is the normal case and is not an error — most
 * sessions end with the document saved, or with nothing open at all.
 */
export interface RecoveryOffer {
  /** Where the document belonged, or `null` if it had never been saved. */
  filePath: string | null;
  fileName: string | null;
  format: SchematicFormat;
  /** ISO 8601. */
  savedAt: string;
  blockCount: number;
}

export type RecoveryPeekResponse = Result<{ recovery: RecoveryOffer | null }>;

export type DocumentStateResponse = Result<{ state: DocumentState | null }>;
export type DocumentMeshResponse = Result<DocumentMesh>;
export type EditResponse = Result<EditSuccess>;
export type InspectResponse = Result<BlockInspection>;
export type SaveResponse = Result<SaveSuccess>;

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

  /** The open document. `getDocumentState` resolves `{state: null}` when none is. */
  openDocument(filePath: string): Promise<DocumentStateResponse>;
  newDocument(size: { width: number; height: number; length: number }): Promise<DocumentStateResponse>;
  closeDocument(): Promise<void>;
  getDocumentState(): Promise<DocumentStateResponse>;
  getDocumentMesh(settings: PreviewSettings): Promise<DocumentMeshResponse>;
  applyEdit(request: EditRequest): Promise<EditResponse>;
  undo(): Promise<EditResponse>;
  redo(): Promise<EditResponse>;
  inspectBlock(x: number, y: number, z: number): Promise<InspectResponse>;
  saveDocument(request: SaveRequest): Promise<SaveResponse>;
  /**
   * The filesystem path behind a dropped `File`, or `""` when it has none.
   * Synchronous, and the one method here that is not an IPC call: it is
   * answered in the preload, which is the only place that can.
   */
  pathForDroppedFile(file: File): string;
  /** Unsaved work from a session that ended badly, if any. */
  peekRecovery(): Promise<RecoveryPeekResponse>;
  /** `true` restores it and opens it; `false` discards it. */
  resolveRecovery(restore: boolean): Promise<DocumentStateResponse>;
  askAgent(request: AgentRequestPayload): Promise<AgentResponse>;

  onProgress(listener: (event: ProgressEvent) => void): () => void;
  onAgentStep(listener: (event: AgentStepEvent) => void): () => void;
}
