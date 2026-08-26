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
  /**
   * "You have unsaved work. Throw it away?" — asked with a native message box.
   *
   * In main rather than as a component because main already imports `dialog`,
   * and because the same question has to be asked from `mainWindow.on("close")`
   * where there is no renderer left to ask with.
   */
  confirmDiscard: "bgpt:dialog:confirmDiscard",
  revealPath: "bgpt:shell:reveal",
  /**
   * Put text on the system clipboard.
   *
   * Main's, because it has to be: the preload runs with `sandbox: true`, which
   * exposes `ipcRenderer` and `webUtils` and not `clipboard`. `navigator.clipboard`
   * would usually work in the renderer and "usually" is the problem -- it is
   * gated on a secure context and on user activation, and the one thing it is
   * needed for here is a token nobody can retype from memory.
   */
  clipboardWrite: "bgpt:clipboard:write",
  /** The app's own `generated/` folder — what an empty `outputDir` resolves to. */
  defaultOutputDir: "bgpt:output:defaultDir",

  /** Every block the app can place — the same set the agent is judged against. */
  blocksList: "bgpt:blocks:list",
  /**
   * Geometry for a handful of blocks, so the inventory can draw them.
   *
   * A handful and not all of them: the grid is virtualised and asks for what is
   * on screen. Nine hundred blocks' worth of triangles in one message would be
   * most of a second of structured clone for a panel showing sixty.
   */
  blockIcons: "bgpt:blocks:icons",
  /**
   * Mesh every block once, so the texture atlas reaches its final size.
   *
   * The atlas grows as blocks are meshed and its version *is* the texture
   * count, so every growth invalidates the UVs of everything drawn before it.
   * Doing it once up front is what stops the inventory blanking and refilling
   * as it is scrolled.
   */
  blockIconsWarm: "bgpt:blocks:icons:warm",
  /**
   * main -> renderer: how far the warm-up has got.
   *
   * It is the one startup step slow enough to need saying so. Its own channel
   * rather than reusing `progress`, which belongs to a generation and carries
   * a request id this has none of.
   */
  startupProgress: "bgpt:startup:progress",

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
  /**
   * main → renderer: the open document moved, and nobody in the window asked.
   *
   * Every other path to a `DocumentState` is an answer to a question the
   * renderer put — which is why this channel did not exist for so long, and
   * why it has to now. An edit arriving from outside the window (the MCP
   * server) would otherwise leave the viewport showing a build that is no
   * longer there and a title bar with the wrong dirty marker, until the user
   * happened to do something that asked.
   *
   * It carries the whole `DocumentState` rather than a "something changed"
   * ping: the renderer needs it either way, and a ping would only mean one
   * more round trip before the same answer. `null` means the document was
   * closed, which is a state the window has to be able to be told about.
   */
  docChanged: "bgpt:doc:changed",
  docMesh: "bgpt:doc:mesh",
  docApply: "bgpt:doc:apply",
  docUndo: "bgpt:doc:undo",
  docRedo: "bgpt:doc:redo",
  docInspect: "bgpt:doc:inspect",
  /** Write one NBT leaf of a block entity. */
  docSetNbt: "bgpt:doc:nbt:set",
  /** The whole schematic's NBT as SNBT text, and the text back again. */
  docNbtRead: "bgpt:doc:nbt:read",
  docNbtApply: "bgpt:doc:nbt:apply",
  /** WorldEdit's Origin, on its own, for the panel's three number fields. */
  docSetOrigin: "bgpt:doc:origin:set",
  /** Turn or reflect the selection, block states with it. */
  docTransform: "bgpt:doc:transform",
  /** Copy the selection out; cut also clears it. */
  docCopy: "bgpt:doc:copy",
  docCut: "bgpt:doc:cut",
  /** Write the clipboard in, with its corner at a coordinate. */
  docPaste: "bgpt:doc:paste",
  /** Pick a region up and put it down elsewhere, as one step. */
  docMove: "bgpt:doc:move",
  /** A region's contents as standalone geometry, for the move preview. */
  docRegionMesh: "bgpt:doc:region:mesh",
  /**
   * renderer → main: where the 3D canvas sits in the window.
   *
   * So `capture_viewport` can crop to the build rather than photographing the
   * sidebar and the settings gear. Main cannot work this out for itself — the
   * layout is CSS — and there is no way for main to *ask* the renderer
   * anything, only to be told. So the renderer reports it when it changes.
   */
  viewportRect: "bgpt:viewport:rect",
  /** The sun and moon images out of the resource pack. */
  skyTextures: "bgpt:sky:textures",
  /** The wooden axe, drawn on the cell WorldEdit would paste from. */
  anchorTexture: "bgpt:anchor:texture",
  /** WorldEdit's paste anchor: create it, move it, or take it away. */
  docSetOffset: "bgpt:doc:offset:set",
  docSave: "bgpt:doc:save",
  /**
   * The open schematic's own version history: list, add, go back, throw away.
   *
   * Four verbs, four channels. Distinct from the chat's checkpoints, which
   * belong to a conversation and cover agent turns; these belong to the *file*
   * and outlive both.
   */
  docVersionList: "bgpt:doc:version:list",
  docVersionSave: "bgpt:doc:version:save",
  docVersionRestore: "bgpt:doc:version:restore",
  docVersionDelete: "bgpt:doc:version:delete",
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
  /** Every conversation about the open schematic. */
  chatList: "bgpt:chat:list",
  /** Switch to one of them. */
  chatOpen: "bgpt:chat:open",
  /** Start another, keeping the current one. */
  chatNew: "bgpt:chat:new",
  /** Throw one away for good. */
  chatDelete: "bgpt:chat:delete",
  /** Put the schematic back to how it was before one of the turns. */
  chatRestore: "bgpt:chat:restore",
  /** Stop the request in flight. */
  docAgentCancel: "bgpt:doc:agent:cancel",
  /**
   * Stop a generation in flight.
   *
   * Its own channel rather than a shared "cancel", because the two runs are
   * cancelled by id out of two different maps and one verb per channel is the
   * rule here. Both reach the user as the same Stop button.
   */
  generateCancel: "bgpt:generate:cancel",
  /*
   * main → renderer, one per menu verb.
   *
   * Eight channels rather than one `menuCommand` carrying a string, because a
   * string would be exactly the generic dispatcher rule R-2 refuses — and
   * because the channel walk in `tests/services.ts` only catches a menu item
   * that was declared and never wired if each verb has a name of its own.
   *
   * The menu is main's because the accelerators are: an accelerator declared in
   * a `Menu` is claimed before the window sees the keystroke.
   */
  menuNew: "bgpt:menu:new",
  menuOpen: "bgpt:menu:open",
  /** Carries the path; the menu already knows which entry was clicked. */
  menuOpenRecent: "bgpt:menu:openRecent",
  menuSave: "bgpt:menu:save",
  menuSaveAs: "bgpt:menu:saveAs",
  menuClose: "bgpt:menu:close",
  menuUndo: "bgpt:menu:undo",
  menuRedo: "bgpt:menu:redo",

  /** main → renderer: one tool call the agent just made. */
  agentStep: "bgpt:agent:step",
  /** main → renderer: what the turn in flight is doing, as it does it. */
  agentTrace: "bgpt:agent:trace",

  /**
   * The MCP server: what it is doing, and the two things you can tell it.
   *
   * `mcpStatus` is asked; `mcpStatusChanged` is pushed, because the answer
   * moves for reasons the window did not cause — a client connecting, a call
   * arriving, a port turning out to be taken after the toggle said yes.
   *
   * `mcpSetEnabled` is deliberately not "save the setting and let something
   * else notice": starting a listener can fail, and the caller has to be told
   * whether it did. It answers with the resulting status.
   */
  mcpStatus: "bgpt:mcp:status",
  mcpStatusChanged: "bgpt:mcp:status:changed",
  mcpActivity: "bgpt:mcp:activity",
  mcpSetEnabled: "bgpt:mcp:setEnabled",
  mcpRegenerateToken: "bgpt:mcp:regenerateToken",

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

/** How far the block warm-up has got, in blocks. */
export interface StartupProgressEvent {
  done: number;
  total: number;
}

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

export interface BlockIconsRequest {
  blocks: string[];
  /**
   * The atlas version the renderer already holds, if any.
   *
   * The same arrangement `MeshPayload` uses: the atlas is megabytes of pixels
   * and is identical for every block, so it crosses once and every later
   * request says "I have version N" and gets geometry alone.
   */
  atlasVersion?: number | null;
}

export interface BlockIcon {
  block: string;
  /** `null` when the block meshed to nothing — air, or a shape not drawn. */
  geometry: ChunkGeometry | null;
}

export interface BlockIconsSuccess {
  icons: BlockIcon[];
  atlas: MeshAtlas | null;
  atlasVersion: number;
}

export type BlockIconsResponse = Result<BlockIconsSuccess>;

export interface PickFileRequest {
  /**
   * The first three mirror the `st.file_uploader` call sites in component.py.
   * `directory` opens a folder chooser rather than a file one, and
   * `save-schematic` is the only one that goes to `showSaveDialog` — every
   * other kind is asking which existing thing to open.
   *
   * They all ride one channel because the response shape is identical. That was
   * true of `directory` and it stays true here: a path or nothing.
   */
  kind: "image" | "resource-pack" | "schem" | "directory" | "save-schematic";
  /**
   * `save-schematic` only: where the dialog opens, and what it suggests.
   *
   * Save As on an open file should offer that file's own folder and name, not
   * whatever the OS last remembered — the alternative is a Save As that
   * defaults to somewhere the user has never been.
   */
  defaultPath?: string | null;
  /**
   * `save-schematic` only: which container, so the filter and the suggested
   * extension match what is about to be written.
   *
   * Needed because the format cannot be recovered from the path: `.schem` is
   * both Sponge v2 and v3, and Electron's save dialog reports the chosen path
   * but not which filter produced it. So the format is decided *before* the
   * dialog opens, and this makes the dialog agree with it.
   */
  format?: SchematicFormat;
}

export interface PickFileResponse {
  /** `null` when the user cancelled, or when the choice was rejected. */
  path: string | null;
  name: string | null;
  /** Set when a choice was rejected -- e.g. a folder that cannot be written to. */
  error?: string;
}

/**
 * What is about to happen to the unsaved work, so the box can say it.
 *
 * A verb rather than a finished sentence: main phrases it, the way it phrases
 * every other `Failure.message`, and the renderer does not have to keep three
 * near-identical strings in step with a dialog it cannot see.
 */
export type DiscardIntent = "new" | "open" | "close";

export interface ConfirmDiscardRequest {
  intent: DiscardIntent;
  /** The document's name, or `null` when it has never been saved. */
  fileName: string | null;
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
  /**
   * What the run did, in order — the request that was sent, the model writing
   * the build script, and each phase of turning it into a file.
   *
   * Carried on the response as well as streamed, so a build asked for from the
   * chat keeps its record on the entry rather than only having flickered past.
   */
  trace: TraceItem[];
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
  /**
   * Which chunk of the document this is.
   *
   * The identity that makes a partial update possible: the renderer keeps one
   * mesh per key and replaces only the ones that arrive. Zero for geometry that
   * is not part of a chunked document -- a block icon is one block.
   */
  key: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /**
   * Three floats per vertex: block light, sky light, occlusion, each 0..1.
   *
   * Three channels and not one brightness, because only the sky half moves
   * with the time of day. Folded together in main, the sun would re-mesh the
   * document every frame it moved and a torch would go out at dusk.
   */
  light: Float32Array;
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
  /**
   * Chunks the renderer should draw. Every non-empty one when `partial` is
   * false; only the ones that moved when it is true.
   */
  chunks: ChunkGeometry[];
  /**
   * Chunks that became empty and should be taken down. Only meaningful
   * alongside `partial` -- a full payload says what exists by listing it.
   */
  dropped: number[];
  /**
   * Whether `chunks` updates what the renderer holds or replaces it.
   *
   * This is what stopped a placed block from costing tens of megabytes. Main
   * re-meshes only the chunks a change touched -- three of a hundred and
   * twenty-eight, for one block -- and then used to ship all of them anyway:
   * 17.5 MB of geometry plus a 20.8 MB atlas, structured-cloned across the
   * boundary and rebuilt into fresh `BufferGeometry` on the other side, for
   * every single block placed. That was the stutter.
   */
  partial: boolean;
  /**
   * What the renderer now holds, to be handed back on the next request.
   *
   * Opaque: it is main's own cache key, and the only thing the renderer may do
   * with it is give it back. A mismatch is not an error, it is a full payload.
   */
  token: string;
  /** Omitted when `atlasVersion` matches what the renderer already holds. */
  atlas: MeshAtlas | null;
  atlasVersion: number;
}

/**
 * What the renderer already has, so main can answer with the difference.
 *
 * Both fields are "I hold this", never "send me this": main decides what to
 * send, and an unrecognised token or version simply means everything.
 */
/** Pick this region up and put its corner down at `to`. */
export interface MoveRegionRequest {
  region: RegionSpec;
  to: { x: number; y: number; z: number };
}

/**
 * A region's contents as geometry, in coordinates relative to its own corner.
 *
 * No atlas: this is only ever asked for while a document is on screen, so the
 * window is already drawing with the one these UVs address.
 */
export interface RegionMeshSuccess {
  chunks: ChunkGeometry[];
  atlasVersion: number;
}

export type RegionMeshResponse = Result<RegionMeshSuccess>;

/**
 * One image out of the pack, as pixels.
 *
 * Pixels and not a PNG for the same reason the atlas is: the renderer's CSP
 * forbids `blob:`, three.js decodes an embedded image through
 * `ImageBitmapLoader`, and a decode that cannot happen renders white while
 * reporting success. Nothing to decode, nothing to fail.
 */
/** Raw pixels out of the resource pack: RGBA8, row-major. */
export interface PackTexture {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** `null` for either means the pack ships none, and the viewer draws a square. */
export interface SkyTextures {
  sun: PackTexture | null;
  moon: PackTexture | null;
}

export interface DocumentMeshRequest {
  settings: PreviewSettings;
  /** The `token` from the last payload this window applied, if any. */
  haveMesh: string | null;
  /** The atlas version it is drawing with, if any. */
  haveAtlas: number | null;
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
  /**
   * WorldEdit's paste anchor as the file stores it, or `null` when the
   * schematic carries none — the tag is optional. The *cell* it marks is
   * `-offset`; see `SchematicDocument.offset` for why the negation is real.
   */
  offset: [number, number, number] | null;
  /**
   * WorldEdit's Origin: the world position of the schematic's (0,0,0) corner,
   * or `null` when the file named none. A different vector from `offset` --
   * see `SchematicDocument.worldOrigin`.
   */
  worldOrigin: [number, number, number] | null;
  blockCount: number;
  /** Every block in the document, most common first. Air is not one. */
  palette: PaletteCount[];
  dirty: boolean;
  canUndo: boolean;
  /**
   * How many transactions are on the undo stack.
   *
   * Not a dirty flag and not a cache key -- `revision` is those. This is the
   * one number that lets the renderer interleave its own undoable steps with
   * main's: a selection change records the depth it happened at, and Ctrl+Z
   * takes the selection back only while no block edit has landed since.
   */
  undoDepth: number;
  canRedo: boolean;
  /** What the undo/redo menu items should say, or `null` when unavailable. */
  undoLabel: string | null;
  redoLabel: string | null;
  /**
   * The id of the transaction an undo would revert.
   *
   * Beside the label rather than instead of it: the label is what the tooltip
   * shows, and the id is what anything holding a reference compares against.
   */
  undoTransactionId: number | null;
  /**
   * The Minecraft `DataVersion` this document will be written with, or `null`
   * when it carries none.
   *
   * On the state rather than left in main because the UI has to show it: until
   * now the version in Settings steered generation only, so a document edited by
   * hand went to disk with whatever tag it happened to arrive with, and nothing
   * anywhere said which.
   */
  dataVersion: number | null;
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
  | {
      kind: "setBlock";
      x: number;
      y: number;
      z: number;
      block: BlockSpec;
      /**
       * The face the new block was placed against, when a click placed it.
       *
       * Carried for exactly one rule: two slabs meeting in one cell become a
       * double slab. `x/y/z` is the *empty* cell the click landed in, so main
       * cannot see the slab that was clicked without knowing which way the
       * click came from -- and the renderer cannot decide it either, because it
       * holds no schematic and the mesh has no per-block identity.
       *
       * Absent for anything that is not a hand placement, which is why the
       * merge is a click gesture and not something a fill can trigger.
       */
      against?: "up" | "down" | "north" | "south" | "east" | "west";
    }
  /**
   * The inspector's block-state editor: write exactly this state, and derive
   * nothing.
   *
   * A separate verb rather than a flag on `setBlock`, and it has to exist at
   * all. Every write runs the neighbour rules -- that is what makes a fence
   * placed beside a fence connect at both ends, through place, break, fill,
   * paste and the agent alike -- and the inspector sends its edit down the same
   * channel. So a hand-typed `north=false` would be re-derived and overwritten
   * *inside the same transaction that carried it*, and the panel would appear
   * to ignore what you typed.
   *
   * With this, a state somebody typed stands until something is placed next to
   * it, which is what the game does and what "editable afterwards" has to mean.
   * It also grows the document no more than `replace` does: the block is
   * already there.
   */
  | { kind: "setState"; x: number; y: number; z: number; block: BlockSpec }
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

/** The schematic's own NBT, as the panel shows it. */
export interface SchematicNbtText {
  /** The root compound as SNBT, minus the block payload. */
  text: string;
  /**
   * False when the schematic is too large to offer as text: the two entry
   * lists are absent and Apply is refused, rather than the panel silently
   * accepting an edit that could only describe half the document.
   */
  editable: boolean;
  /** Tag names deliberately left out, so the panel can say which. */
  omitted: string[];
  /** Handed back on apply, so an edit built against a stale read is refused. */
  revision: number;
}

export interface ApplyNbtRequest {
  text: string;
  /** The `revision` the text was read at. */
  revision: number;
}

/** What a brand-new schematic should be. */
export interface NewDocumentRequest {
  width: number;
  height: number;
  length: number;
  /**
   * The container it will be saved as, and the version tag it will carry.
   *
   * Chosen up front rather than at save time because the two are not
   * independent: an MCEdit file cannot hold a flattened palette, so the format
   * decides which versions are even offered. Deciding at save time would let
   * someone build for 1.8.8 and then discover the container they picked cannot
   * represent it.
   */
  format: SchematicFormat;
  /**
   * The Minecraft version to build for, by name (`JE_1_20_4`).
   *
   * By name and not as a `DataVersion` integer, because the name is what the
   * era rule is written against and main is the one that has to *enforce* it —
   * a number cannot be checked against a container, since `null` is both "no
   * tag" and "pre-Flattening" and only one of those refuses Sponge.
   */
  version: string;
}

export interface SaveRequest {
  /** Omitted means "over the file it came from"; required for Save As. */
  filePath?: string | null;
  format?: SchematicFormat;
  /**
   * The Minecraft version to stamp on the file, by name (`JE_1_20_4`).
   *
   * Omitted keeps whatever the document already carries, which is what a plain
   * Save wants. Named rather than sent as a `DataVersion` so that main can
   * refuse a container the version cannot live in — see `NewDocumentRequest`.
   */
  version?: string;
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

/**
 * What a turn did, in the order it did it.
 *
 * One flat shape with a `kind` rather than a discriminated union, deliberately:
 * this is consumed by a Svelte template, and a union there means a chain of
 * `{#if item.kind === ...}` blocks each narrowing to a different member. The
 * fields that only apply to one kind are documented as such and are absent
 * otherwise, which the template reads as "nothing to draw".
 */
export interface TraceItem {
  /**
   * Stable within one turn, and how a delta finds the item it extends.
   *
   * Assigned by main, which is the only place the order is known. The renderer
   * folds events into a mirror and then throws it away when the finished trace
   * arrives on the entry — the same arrangement the chat log itself uses.
   */
  id: number;
  /**
   * `request` — what was sent to the model, verbatim.
   * `reasoning` — the model thinking out loud, for models that emit it.
   * `text` — prose the model wrote between tool calls.
   * `tool` — one tool call, with what it was given and what it returned.
   * `note` — something the app did rather than the model, e.g. running the
   *   generated script in the sandbox.
   */
  kind: "request" | "reasoning" | "text" | "tool" | "note";
  /** The body: the prompt, the thinking, the prose, or a tool's summary line. */
  text: string;
  /** `tool` only: which one. */
  name?: string;
  /** `tool` only: the arguments it was called with, as formatted JSON. */
  input?: string;
  /** `tool` only: what it returned, as formatted JSON. */
  output?: string;
  /** `tool` only, and instead of `output`: what it threw. */
  error?: string;
  /** Set while it is still going, so the UI can show it working. */
  running?: boolean;
  /** How long it took, once it is over. */
  ms?: number;
  /**
   * What was left out of this item, and why.
   *
   * Only ever set on the way to disk. A generation's request carries the whole
   * block-id list — 933 ids, 24 kB — which is a constant of the app rather than
   * anything about this turn, and storing a copy per turn across a hundred
   * conversation files is hundreds of megabytes. It is shown in full while the
   * turn is live; what is saved says exactly what is missing and where the same
   * text lives.
   */
  elided?: string;
}

/**
 * A change to the trace of the turn in flight.
 *
 * Two forms because reasoning arrives a few characters at a time: sending the
 * whole item per token would be the same text again and again. `item` announces
 * one, or replaces it with its finished form; `append` extends one already
 * sent. Main batches the appends — see `services/trace.ts`.
 */
export type TraceEvent =
  | { requestId: string; type: "item"; item: TraceItem }
  | { requestId: string; type: "append"; id: number; text: string };

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
  /**
   * What the turn did, in order: the request, the thinking, the tool calls.
   *
   * Additive rather than a replacement for `steps`, and `CONVERSATION_FORMAT`
   * stays at 1 for that reason. Bumping it would be tidier and would cost every
   * existing conversation the model's memory — `coerceRecord` keeps entries and
   * drops `messages` on a version it does not recognise — which is a steep
   * price for a display field. A record written before this has no trace, and
   * the panel falls back to `steps`.
   */
  trace?: TraceItem[];
  changed?: number;
  /** What was taken out and put in, by block type. */
  summary?: EditSummary;
  /** The undo entry this turn created; shown on the "Undo this" button. */
  undoLabel?: string | null;
  /**
   * Which transaction that was.
   *
   * Matched by id and not by `undoLabel`, because the label is derived from
   * the prompt: two turns asking for the same thing produced the same string,
   * and the button would offer to undo whichever of them was on top.
   */
  undoTransactionId?: number | null;
  /**
   * Set on a user turn once it has actually reached the model.
   *
   * A run that fails leaves its entry in the log and never enters the agent's
   * memory, so this is what keeps `rememberedFrom` from drifting by one for
   * every error above it.
   */
  remembered?: boolean;
  /**
   * The snapshot of the schematic taken just before this turn.
   *
   * Present on user turns, and on the note left behind when a restore happens.
   * The chat offers "return to this version" wherever it is set and the file is
   * still there — one rule, whichever kind of entry carries it.
   */
  checkpoint?: string;
}

/** One conversation, as the picker lists it. */
export interface ConversationSummary {
  id: string;
  /** The first thing the user said, cut to something that fits a row. */
  title: string;
  /** Epoch milliseconds; `0` when nothing was ever recorded. */
  updatedAt: number;
  /** Turns in it, so an empty one can say so rather than look broken. */
  entryCount: number;
}

/** Every conversation about the open schematic, newest first. */
export interface ConversationList {
  conversations: ConversationSummary[];
  /** Which of them is on screen. */
  activeId: string;
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
   * offers "Undo this" only while it is still on top of the stack — once
   * anything else has been done, undoing would revert that instead.
   */
  undoLabel: string | null;
  /** The same transaction, named in a way two identical prompts cannot share. */
  undoTransactionId: number | null;
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
/** What a restore produced: the document, and the conversation it forked. */
export interface RestoreSuccess {
  state: DocumentState;
  chat: ChatState;
  /** Edits undone by going back, for the UI to report what it just did. */
  undoneEdits: number;
}

export type RestoreResponse = Result<RestoreSuccess>;

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
/** One kept version of the open schematic. Mirrors `snapshots_core.ts`. */
export interface DocumentVersion {
  id: string;
  at: number;
  source: "generated" | "manual" | "opened";
  label: string;
  size: [number, number, number];
  blockCount: number;
}

export interface SaveVersionRequest {
  source: "generated" | "manual" | "opened";
  /** What produced it, when there are words for it. */
  label: string;
}

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

/**
 * What this schematic is for, as the app last recorded it.
 *
 * There is no project file and deliberately will not be one: this rides in the
 * per-path sidecar the conversations already use, so the `.schem` stays the
 * only thing the user sees and moves. Every field is optional and a missing
 * sidecar is not an error — the file opens either way, you just answer the
 * dialogs yourself. That is the property a `.saproj` would not have.
 */
export interface ProjectNotes {
  version?: string;
  format?: SchematicFormat;
  description?: string;
}

export type DocumentStateResponse = Result<{
  state: DocumentState | null;
  /** Present when a document was just opened and had notes recorded. */
  project?: ProjectNotes | null;
  /**
   * The conversation the newly open document brought with it.
   *
   * Carried on the response rather than fetched afterwards only where the
   * renderer has no other reason to ask — recovery, which is an open the user
   * did not initiate. `docOpen` still calls `chatState` itself, because it has
   * a list of conversations to refresh at the same moment anyway.
   */
  chat?: ChatState;
}>;
export type DocumentMeshResponse = Result<DocumentMesh>;
export type EditResponse = Result<EditSuccess>;
export type InspectResponse = Result<BlockInspection>;
export type SchematicNbtResponse = Result<SchematicNbtText>;
export type SaveResponse = Result<SaveSuccess>;

// ---------------------------------------------------------------------------
// The MCP server
// ---------------------------------------------------------------------------

/**
 * What the server is actually doing — as opposed to what the checkbox says.
 *
 * The two are different questions and conflating them is how you get a control
 * reading "on" while nothing is listening: `settings.mcp.enabled` is the user's
 * intent, this is main's observation. Only one of them can say "the port was
 * already taken".
 */
export type McpServerState = "off" | "starting" | "listening" | "error";

export interface McpStatus {
  state: McpServerState;
  /** Where clients connect, once there is somewhere. */
  url: string | null;
  /**
   * The bearer token, in the clear.
   *
   * A deliberate exception to "secrets never travel main → renderer". That rule
   * protects credentials for *remote* services: the renderer has no use for
   * them and a leak costs the user money. This one authorises a local server
   * this app generates itself, and its whole purpose is to be pasted into
   * another program by the user — withholding it would mean opening a file in
   * userData by hand. It is shown masked, and it can be regenerated, which is
   * the mitigation that actually matters.
   */
  token: string | null;
  /** How many clients hold a session right now. */
  clients: number;
  /**
   * Tool calls served since the server started.
   *
   * A monotonic counter rather than an "a call happened" event, so the renderer
   * can flash the indicator from the number moving and main never has to model
   * an animation.
   */
  calls: number;
  /** Why it is not running. Main's own wording, so not translated. */
  message: string | null;
  /**
   * Where the stdio bridge script is, for clients that will not speak HTTP.
   *
   * On the status rather than derived in the renderer, because only main knows
   * where the app's resources ended up — that differs between a dev run and an
   * installed copy, and a renderer guessing would be right in exactly one of
   * them.
   */
  bridge: string | null;
}

/** One line of the activity log: what was called, and when. */
export interface McpActivity {
  /** Milliseconds since the epoch, so the renderer can format it in its locale. */
  at: number;
  tool: string;
  /** The tool's own phrasing of what it did, or the error it raised. */
  summary: string;
  ok: boolean;
}

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
  /** `true` to go ahead and lose the unsaved changes. */
  confirmDiscard(req: ConfirmDiscardRequest): Promise<boolean>;
  revealPath(path: string): Promise<void>;
  /** Where the 3D canvas is, in window coordinates. See `IPC.viewportRect`. */
  reportViewportRect(rect: { x: number; y: number; width: number; height: number }): Promise<void>;
  /** Put text on the system clipboard. Main's, because the preload is sandboxed. */
  copyToClipboard(text: string): Promise<void>;
  getDefaultOutputDir(): Promise<string>;
  listBlocks(): Promise<string[]>;
  /** Geometry for the blocks the inventory is about to draw. */
  getBlockIcons(req: BlockIconsRequest): Promise<BlockIconsResponse>;
  /** Settles the atlas for the whole block list. Resolves with its version. */
  warmBlockIcons(): Promise<number>;

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
  /**
   * Versions of the open schematic, newest first.
   *
   * Empty for a document that has never been saved: the key is the file, so
   * there is nowhere to keep a history until there is a file.
   */
  listDocumentVersions(): Promise<DocumentVersion[]>;
  saveDocumentVersion(req: SaveVersionRequest): Promise<DocumentVersion[]>;
  restoreDocumentVersion(id: string): Promise<DocumentStateResponse>;
  deleteDocumentVersion(id: string): Promise<DocumentVersion[]>;
  newDocument(req: NewDocumentRequest): Promise<DocumentStateResponse>;
  closeDocument(): Promise<void>;
  getDocumentState(): Promise<DocumentStateResponse>;
  getDocumentMesh(request: DocumentMeshRequest): Promise<DocumentMeshResponse>;
  moveRegion(request: MoveRegionRequest): Promise<EditResponse>;
  regionMesh(region: RegionSpec): Promise<RegionMeshResponse>;
  getSkyTextures(): Promise<SkyTextures>;
  applyEdit(request: EditRequest): Promise<EditResponse>;
  undo(): Promise<EditResponse>;
  redo(): Promise<EditResponse>;
  inspectBlock(x: number, y: number, z: number): Promise<InspectResponse>;
  /** Write one NBT leaf. Undoable like any other edit. */
  setNbtValue(request: SetNbtRequest): Promise<EditResponse>;
  /** The whole schematic's NBT, as the file would spell it, in SNBT. */
  readSchematicNbt(): Promise<SchematicNbtResponse>;
  /** Edited SNBT back onto the document, as one undoable step. */
  applySchematicNbt(request: ApplyNbtRequest): Promise<EditResponse>;
  /** WorldEdit's Origin; `null` removes it, which is not the same as zero. */
  setWorldOrigin(origin: [number, number, number] | null): Promise<EditResponse>;
  /**
   * WorldEdit's paste anchor, as the **cell** it occupies rather than as the
   * stored offset — the negation lives in main, in one place. `null` removes
   * it, which is not the same as putting it at (0, 0, 0).
   */
  setWorldEditAnchor(anchor: [number, number, number] | null): Promise<EditResponse>;
  /** The wooden axe the anchor marker is drawn with; `null` if the pack has none. */
  getAnchorTexture(): Promise<PackTexture | null>;
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
  /** Every conversation about the open schematic, newest first. */
  listConversations(): Promise<ConversationList>;
  /** Switch to one, saving the current first. Unknown ids resolve unchanged. */
  openConversation(id: string): Promise<ChatState>;
  /**
   * Start a new one.
   *
   * The current one is *kept*, not discarded — it stays in the list and can be
   * returned to. That is the difference between this and what the button used
   * to do.
   */
  newConversation(): Promise<ChatState>;
  /** Delete one for good. Deleting the active one starts a new empty one. */
  deleteConversation(id: string): Promise<ChatState>;
  /**
   * Put the schematic back to how it was before the turn at `entryIndex`.
   *
   * Forks rather than rewinds: the conversation as it stands is archived whole
   * and stays in the picker, and what continues is a copy truncated to that
   * point. Nothing the user wrote is destroyed.
   */
  restoreCheckpoint(entryIndex: number): Promise<RestoreResponse>;
  /**
   * Stop the request with this id. Resolves `true` if one was in flight.
   *
   * The request itself still settles through `askAgent`, as a `cancelled`
   * failure — this only asks it to stop.
   */
  cancelAgent(requestId: string): Promise<boolean>;
  /**
   * Stop the generation with this id. Resolves `true` if one was in flight.
   *
   * Generation reached from the chat is a turn like any other and gets the same
   * Stop button, so it needs the same way out. Without this the button was
   * shown — `busy` was true — and did nothing at all, which is the one state it
   * must never have.
   */
  cancelGenerate(requestId: string): Promise<boolean>;

  onProgress(listener: (event: ProgressEvent) => void): () => void;
  /** How far the block warm-up has got. Only fires while it is running. */
  onStartupProgress(listener: (event: StartupProgressEvent) => void): () => void;
  onAgentStep(listener: (event: AgentStepEvent) => void): () => void;
  /**
   * What the turn in flight is doing, as it does it.
   *
   * Separate from `onAgentStep` because they answer different questions: a step
   * is one tool call the app made, a trace is everything the model did to get
   * there. The step events stay because `ChatEntry.steps` is what old
   * conversations hold.
   */
  onAgentTrace(listener: (event: TraceEvent) => void): () => void;

  /**
   * The open document changed without the renderer having asked.
   *
   * The only source today is the MCP server, which edits the same session the
   * window is showing. The renderer adopts the state and re-requests the mesh,
   * exactly as it does after one of its own edits — the difference is only who
   * started it. `null` means it was closed.
   */
  onDocumentChanged(listener: (state: DocumentState | null) => void): () => void;

  /** What the MCP server is doing right now. */
  getMcpStatus(): Promise<McpStatus>;
  /**
   * Start or stop it, and say what happened.
   *
   * Answers with the resulting status rather than a boolean: starting opens a
   * socket and can fail on a port somebody else holds, and the caller is the
   * one that has to show that.
   */
  setMcpEnabled(enabled: boolean): Promise<McpStatus>;
  /** A new token. Every client holding the old one stops working. */
  regenerateMcpToken(): Promise<McpStatus>;
  /** The last hundred tool calls, newest first. */
  getMcpActivity(): Promise<McpActivity[]>;
  onMcpStatusChanged(listener: (status: McpStatus) => void): () => void;

  /**
   * The application menu, one subscription per verb.
   *
   * They carry no payload because the menu carries no information the renderer
   * does not already have — except `onMenuOpenRecent`, where the whole point is
   * *which* entry was clicked.
   */
  onMenuNew(listener: () => void): () => void;
  onMenuOpen(listener: () => void): () => void;
  onMenuOpenRecent(listener: (filePath: string) => void): () => void;
  onMenuSave(listener: () => void): () => void;
  onMenuSaveAs(listener: () => void): () => void;
  onMenuClose(listener: () => void): () => void;
  onMenuUndo(listener: () => void): () => void;
  onMenuRedo(listener: () => void): () => void;
}
