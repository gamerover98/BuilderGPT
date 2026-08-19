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

  /** Every block the app can place — the same set the agent is judged against. */
  blocksList: "bgpt:blocks:list",

  generate: "bgpt:generate",
  preview: "bgpt:preview",

  /**
   * The open document. One channel per verb (rule R-2) rather than a
   * `doc:command` dispatcher, so the payload of each is a named type the
   * compiler checks on both sides.
   */
  docOpen: "bgpt:doc:open",
  /** Recently opened schematics, most recent first. */
  docRecentList: "bgpt:doc:recent:list",
  docNew: "bgpt:doc:new",
  docClose: "bgpt:doc:close",
  docState: "bgpt:doc:state",
  docMesh: "bgpt:doc:mesh",
  docApply: "bgpt:doc:apply",
  docUndo: "bgpt:doc:undo",
  docRedo: "bgpt:doc:redo",
  docInspect: "bgpt:doc:inspect",
  /** Write one NBT leaf of a block entity. */
  docSetNbt: "bgpt:doc:nbt:set",
  /** Turn or reflect the selection, block states with it. */
  docTransform: "bgpt:doc:transform",
  /** Copy the selection out; cut also clears it. */
  docCopy: "bgpt:doc:copy",
  docCut: "bgpt:doc:cut",
  /** Write the clipboard in, with its corner at a coordinate. */
  docPaste: "bgpt:doc:paste",
  docSave: "bgpt:doc:save",
  /** Is there unsaved work from a session that ended badly? */
  docRecoveryPeek: "bgpt:doc:recovery:peek",
  /** Restore it, or throw it away. */
  docRecoveryResolve: "bgpt:doc:recovery:resolve",
  /** Ask the agent to edit the open document. */
  docAgent: "bgpt:doc:agent",
  /** Forget the conversation so far, keeping the document open. */
  docAgentReset: "bgpt:doc:agent:reset",
  /** Read the chat log. Main owns it, so this is how the renderer re-syncs. */
  chatState: "bgpt:chat:state",
  /** Stop the request in flight. */
  docAgentCancel: "bgpt:doc:agent:cancel",
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
  | "invalid-input"
  /**
   * The user stopped it. Not a fault, and deliberately not folded into
   * `llm-error`: nothing went wrong, so the UI must not dress it up in red and
   * invite a bug report.
   */
  | "cancelled";

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
  /**
   * Whether this came from the chat rather than the Structure panel.
   *
   * The same operation reached from two places, and only one of them is a
   * conversation: asking the chat to build something with nothing open is a
   * turn and belongs in the log, while pressing Generate is not. Main needs to
   * be told which, because it is the one writing the log.
   */
  viaChat?: boolean;
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

/**
 * One chunk's geometry, as three.js consumes it.
 *
 * Typed arrays cross the boundary directly. Structured clone carries every
 * TypedArray — the rule in CLAUDE.md is about `Buffer`, a Node subclass that
 * arrives as a plain object, not about typed arrays in general.
 */
export interface ChunkGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/**
 * The texture atlas as raw pixels rather than a PNG.
 *
 * This is the whole reason the viewport no longer needs `blob:` in its CSP.
 * A PNG has to be decoded, three.js decodes it through `ImageBitmapLoader`,
 * and that `fetch`es a blob URL — which the CSP had to allow, and whose
 * failure mode was a model that rendered white while reporting success. Raw
 * RGBA has nothing to decode, so there is nothing to fail.
 */
export interface MeshAtlas {
  width: number;
  height: number;
  /** RGBA8, row-major, length = width * height * 4. */
  pixels: Uint8Array;
  /**
   * Bumped when the atlas is rebuilt. The renderer keeps its texture while
   * this is unchanged, so an edit does not re-upload a megabyte of pixels.
   */
  version: number;
}

export interface MeshPayload {
  /** One entry per non-empty chunk; the renderer draws one mesh from each. */
  chunks: ChunkGeometry[];
  /** Omitted when `atlasVersion` matches what the renderer already holds. */
  atlas: MeshAtlas | null;
  atlasVersion: number;
}

export interface PreviewSuccess {
  /**
   * Geometry and pixels, not a container format. ARCHITECTURE.md §3 "Viewer
   * lifecycle": no base64, no `data:` URL — `app/preview.py`'s base64 step
   * existed only to embed the payload in the Streamlit iframe's HTML.
   */
  mesh: MeshPayload;
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
  mesh: MeshPayload;
  center: [number, number, number];
  size: [number, number, number];
  /** True when the document had not changed since the last mesh was built. */
  cached: boolean;
  sunAzimuth: number;
  sunElevation: number;
}

/**
 * One editable scalar inside a block entity's NBT.
 *
 * The tag type travels with it because that is what makes writing safe: the
 * readable rendering strips the types, and "5" alone cannot say whether it is a
 * byte, an int or a string.
 */
export interface NbtFieldView {
  /** Keys and list indices from the root, e.g. `["Items", 0, "Count"]`. */
  path: (string | number)[];
  label: string;
  type: string;
  value: string;
  /** Containers and bulk arrays are shown but not writable. */
  editable: boolean;
}

export interface BlockInspection {
  block: string;
  properties: Record<string, string>;
  /** `nbt` is JSON for display; `fields` is the same tree flattened for editing. */
  blockEntity: { id: string; nbt: string; fields: NbtFieldView[] } | null;
}

/**
 * Turning or reflecting a region. A quarter turn needs a square footprint and
 * is refused otherwise rather than cropped.
 */
export interface TransformRequest {
  region: RegionSpec;
  transform: { kind: "rotate"; steps: 0 | 1 | 2 | 3 } | { kind: "mirror"; axis: "x" | "z" };
}

/**
 * What the clipboard holds, as much as the renderer needs to enable Paste and
 * say how big it is. The contents stay in main.
 */
export interface ClipboardInfo {
  width: number;
  height: number;
  length: number;
  blocks: number;
}

export type ClipboardResponse = Result<{ clipboard: ClipboardInfo; state: DocumentState }>;

export interface PasteRequest {
  x: number;
  y: number;
  z: number;
  /** Write the copied air too, erasing what it lands on. Off by default. */
  includeAir?: boolean;
}

export interface SetNbtRequest {
  x: number;
  y: number;
  z: number;
  path: (string | number)[];
  value: string;
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
  /**
   * The schematic was trimmed to its content before being written, and by how
   * much. `null` when it was already tight, or when there was nothing but air
   * to bound.
   *
   * Reported rather than done silently: the file on disk has different
   * dimensions from the document still open in the editor, and someone who
   * built inside a deliberately roomy box should be told where the edges went.
   */
  cropped: { from: [number, number, number]; to: [number, number, number] } | null;
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

/**
 * What an edit took out and what it put in, counted by block type.
 *
 * "1,247 blocks changed" does not tell anyone whether their oak farmhouse
 * survived. This is the receipt for it, read from the deltas the undo stack
 * recorded, so it cannot disagree with what undo would put back.
 */
export interface EditSummary {
  removed: { block: string; count: number }[];
  added: { block: string; count: number }[];
  changed: number;
}

/**
 * One turn in the chat log, as the renderer draws it.
 *
 * It crosses the boundary because main owns the log: it appends every turn,
 * including the failures and the stopped runs, and hands the whole thing back.
 * The renderer used to build these itself, which meant the visible log and the
 * model's memory of it had two authors and could disagree.
 */
export interface ChatEntry {
  /** `note` is something that happened but did not go wrong -- a stopped run. */
  role: "user" | "agent" | "error" | "note";
  text: string;
  /** Tool calls made while answering; agent turns only. */
  steps?: { tool: string; summary: string }[];
  changed?: number;
  /** What was taken out and put in, by block type. */
  summary?: EditSummary;
  /** The undo entry this turn created, for matching against the live one. */
  undoLabel?: string | null;
  /**
   * Set on a user turn once it has actually reached the model.
   *
   * A run that fails leaves its entry in the log and never enters the agent's
   * memory, so this is what keeps `rememberedFrom` from drifting by one for
   * every error above it.
   */
  remembered?: boolean;
}

/** The log and where the agent's memory into it begins. */
export interface ChatState {
  entries: ChatEntry[];
  /**
   * Index into `entries` of the oldest turn the agent still carries.
   *
   * `0` means the whole log is remembered, and the renderer draws no divider.
   */
  rememberedFrom: number;
}

export interface AgentSuccess {
  /** The model's closing explanation. */
  text: string;
  changed: number;
  steps: { tool: string; summary: string }[];
  state: DocumentState;
  summary: EditSummary;
  /**
   * The undo entry this run created, or `null` if it changed nothing. The chat
   * offers "Undo this" only while it still matches `state.undoLabel` — once
   * anything else has been done, undoing would revert that instead.
   */
  undoLabel: string | null;
  /**
   * Exchanges the agent is carrying, this one included. The transcript itself
   * stays in main — this is the one thing the UI needs from it, to say whether
   * the next question will be understood in context.
   */
  remembered: number;
}

/**
 * Carries the log on both branches, on purpose.
 *
 * A failed run is a turn too -- it puts a `note` or an `error` in the log --
 * so a failure that could not carry the log back would leave the renderer
 * having to write that entry itself, which is the split this change exists to
 * close.
 */
export type AgentResponse =
  | ({ ok: true } & AgentSuccess & { chat: ChatState })
  | (Failure & { chat: ChatState });

/**
 * A schematic opened before, and when.
 *
 * `openedAt` is epoch milliseconds, and `0` means "no date recorded" rather
 * than 1970: settings files written before this list carried timestamps hold
 * bare paths, and those entries keep their place in the list without inventing
 * a time they were never opened at. The renderer shows nothing in that column
 * rather than a date it made up.
 */
export interface RecentDocument {
  filePath: string;
  openedAt: number;
}

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
  listBlocks(): Promise<string[]>;

  generate(req: GenerateRequest): Promise<GenerateResponse>;
  preview(req: PreviewRequest): Promise<PreviewResponse>;

  listArtifacts(): Promise<Artifact[]>;

  /** The open document. `getDocumentState` resolves `{state: null}` when none is. */
  openDocument(filePath: string): Promise<DocumentStateResponse>;
  /**
   * Recently opened schematics, most recent first. Main-owned: it is not part
   * of `Settings`, so saving settings cannot overwrite it with a stale copy.
   */
  listRecentDocuments(): Promise<RecentDocument[]>;
  newDocument(size: { width: number; height: number; length: number }): Promise<DocumentStateResponse>;
  closeDocument(): Promise<void>;
  getDocumentState(): Promise<DocumentStateResponse>;
  getDocumentMesh(settings: PreviewSettings): Promise<DocumentMeshResponse>;
  applyEdit(request: EditRequest): Promise<EditResponse>;
  undo(): Promise<EditResponse>;
  redo(): Promise<EditResponse>;
  inspectBlock(x: number, y: number, z: number): Promise<InspectResponse>;
  /** Write one NBT leaf. Undoable like any other edit. */
  setNbtValue(request: SetNbtRequest): Promise<EditResponse>;
  /** Turn or reflect the selection. Undoable as one step. */
  transformRegion(request: TransformRequest): Promise<EditResponse>;
  /**
   * Copy the selection out, or cut it. The clipboard lives in main and
   * deliberately outlives the open document, so it can carry between two.
   */
  copyRegion(region: RegionSpec): Promise<ClipboardResponse>;
  cutRegion(region: RegionSpec): Promise<ClipboardResponse>;
  /** Write the clipboard in. Undoable as one step. */
  pasteClipboard(request: PasteRequest): Promise<EditResponse>;
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
  /** Forget the conversation so far. Resolves even when nothing is open. */
  resetAgentConversation(): Promise<void>;
  /**
   * The chat log as main holds it.
   *
   * `askAgent` returns it with every reply, so this is for the paths that
   * change the log without going through the agent -- building from the chat,
   * and opening a document, which may adopt the conversation or clear it.
   */
  getChatState(): Promise<ChatState>;
  /**
   * Stop the request with this id. Resolves `true` if one was in flight.
   *
   * The request itself still settles through `askAgent`, as a `cancelled`
   * failure — this only asks it to stop.
   */
  cancelAgent(requestId: string): Promise<boolean>;

  onProgress(listener: (event: ProgressEvent) => void): () => void;
  onAgentStep(listener: (event: AgentStepEvent) => void): () => void;
}
