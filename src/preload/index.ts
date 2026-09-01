/**
 * The only bridge between renderer and main.
 *
 * ARCHITECTURE.md §2 rule R-1/R-2: the renderer gets exactly the methods
 * declared in `BgptApi` and nothing else -- no `ipcRenderer`, no channel
 * strings, no way to invoke a channel this file does not name. That is the
 * point of enumerating channels in `shared/ipc.ts` rather than exposing a
 * generic `invoke(channel, ...)`.
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";

import {
  IPC,
  type AgentRequestPayload,
  type AgentResponse,
  type ChatState,
  type ConversationList,
  type ConvertRequest,
  type ConvertResponse,
  type RestoreResponse,
  type AgentStepEvent,
  type TraceEvent,
  type Artifact,
  type BlockIconsResponse,
  type BgptApi,
  type DocumentMeshResponse,
  type DocumentState,
  type DocumentStateResponse,
  type EditRequest,
  type ResizeRequest,
  type VersionRequest,
  type VoidBlockRequest,
  type EditResponse,
  type GenerateRequest,
  type GenerateResponse,
  type InspectResponse,
  type McpActivity,
  type McpStatus,
  type OpenCodeModelInfo,
  type ConfirmDiscardRequest,
  type DocumentVersion,
  type SaveVersionRequest,
  type PickFileRequest,
  type PickFileResponse,
  type PreviewRequest,
  type PreviewResponse,
  type ProgressEvent,
  type StartupProgressEvent,
  type RecentDocument,
  type RecoveryPeekResponse,
  type SaveRequest,
  type SaveResponse,
  type SetKeyRequest,
  type ClipboardResponse,
  type PasteRequest,
  type MoveRegionRequest,
  type RegionMeshResponse,
  type SkyTextures,
  type ApplyNbtRequest,
  type PackTexture,
  type SchematicNbtResponse,
  type SetNbtRequest,
  type TransformRequest,
} from "../shared/ipc.js";
import type { KeyStorageStatus, Provider, Settings } from "../shared/settings.js";

const api: BgptApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<Settings>,
  setSettings: (settings) => ipcRenderer.invoke(IPC.settingsSet, settings) as Promise<Settings>,

  getKeyStatus: () => ipcRenderer.invoke(IPC.keysStatus) as Promise<KeyStorageStatus>,
  setKey: (req: SetKeyRequest) => ipcRenderer.invoke(IPC.keysSet, req) as Promise<KeyStorageStatus>,
  clearKey: (provider: Provider) =>
    ipcRenderer.invoke(IPC.keysClear, provider) as Promise<KeyStorageStatus>,

  listVersions: () => ipcRenderer.invoke(IPC.versionsList) as Promise<string[]>,
  listOpenCodeModels: () =>
    ipcRenderer.invoke(IPC.opencodeModels) as Promise<OpenCodeModelInfo[] | null>,

  pickFile: (req: PickFileRequest) => ipcRenderer.invoke(IPC.pickFile, req) as Promise<PickFileResponse>,
  confirmDiscard: (req: ConfirmDiscardRequest) =>
    ipcRenderer.invoke(IPC.confirmDiscard, req) as Promise<boolean>,
  revealPath: (target: string) => ipcRenderer.invoke(IPC.revealPath, target) as Promise<void>,
  reportViewportRect: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke(IPC.viewportRect, rect) as Promise<void>,
  reportPointerLock: (locked: boolean) =>
    ipcRenderer.invoke(IPC.pointerLock, locked) as Promise<void>,
  copyToClipboard: (text: string) =>
    ipcRenderer.invoke(IPC.clipboardWrite, text) as Promise<void>,
  getDefaultOutputDir: () => ipcRenderer.invoke(IPC.defaultOutputDir) as Promise<string>,
  listBlocks: () => ipcRenderer.invoke(IPC.blocksList) as Promise<string[]>,
  listLegacyBlocks: () =>
    ipcRenderer.invoke(IPC.blocksLegacy) as Promise<Record<string, string>>,
  getBlockIcons: (req) => ipcRenderer.invoke(IPC.blockIcons, req) as Promise<BlockIconsResponse>,
  warmBlockIcons: () => ipcRenderer.invoke(IPC.blockIconsWarm) as Promise<number>,

  generate: (req: GenerateRequest) => ipcRenderer.invoke(IPC.generate, req) as Promise<GenerateResponse>,
  preview: (req: PreviewRequest) => ipcRenderer.invoke(IPC.preview, req) as Promise<PreviewResponse>,

  listArtifacts: () => ipcRenderer.invoke(IPC.artifactsList) as Promise<Artifact[]>,

  openDocument: (filePath: string) =>
    ipcRenderer.invoke(IPC.docOpen, filePath) as Promise<DocumentStateResponse>,
  listRecentDocuments: () =>
    ipcRenderer.invoke(IPC.docRecentList) as Promise<RecentDocument[]>,
  newDocument: (req) => ipcRenderer.invoke(IPC.docNew, req) as Promise<DocumentStateResponse>,
  closeDocument: () => ipcRenderer.invoke(IPC.docClose) as Promise<void>,
  listDocumentVersions: () => ipcRenderer.invoke(IPC.docVersionList) as Promise<DocumentVersion[]>,
  saveDocumentVersion: (req: SaveVersionRequest) =>
    ipcRenderer.invoke(IPC.docVersionSave, req) as Promise<DocumentVersion[]>,
  restoreDocumentVersion: (id: string) =>
    ipcRenderer.invoke(IPC.docVersionRestore, id) as Promise<DocumentStateResponse>,
  deleteDocumentVersion: (id: string) =>
    ipcRenderer.invoke(IPC.docVersionDelete, id) as Promise<DocumentVersion[]>,
  getDocumentState: () => ipcRenderer.invoke(IPC.docState) as Promise<DocumentStateResponse>,
  getDocumentMesh: (request) =>
    ipcRenderer.invoke(IPC.docMesh, request) as Promise<DocumentMeshResponse>,
  applyEdit: (request: EditRequest) =>
    ipcRenderer.invoke(IPC.docApply, request) as Promise<EditResponse>,
  resizeDocument: (request: ResizeRequest) =>
    ipcRenderer.invoke(IPC.docResize, request) as Promise<EditResponse>,
  setVoidBlock: (request: VoidBlockRequest) =>
    ipcRenderer.invoke(IPC.docSetVoidBlock, request) as Promise<EditResponse>,
  setDocumentVersion: (request: VersionRequest) =>
    ipcRenderer.invoke(IPC.docSetVersion, request) as Promise<EditResponse>,
  convertFile: (request: ConvertRequest) =>
    ipcRenderer.invoke(IPC.convertFile, request) as Promise<ConvertResponse>,
  undo: () => ipcRenderer.invoke(IPC.docUndo) as Promise<EditResponse>,
  redo: () => ipcRenderer.invoke(IPC.docRedo) as Promise<EditResponse>,
  inspectBlock: (x: number, y: number, z: number) =>
    ipcRenderer.invoke(IPC.docInspect, { x, y, z }) as Promise<InspectResponse>,
  setNbtValue: (request: SetNbtRequest) =>
    ipcRenderer.invoke(IPC.docSetNbt, request) as Promise<EditResponse>,
  readSchematicNbt: () =>
    ipcRenderer.invoke(IPC.docNbtRead) as Promise<SchematicNbtResponse>,
  applySchematicNbt: (request: ApplyNbtRequest) =>
    ipcRenderer.invoke(IPC.docNbtApply, request) as Promise<EditResponse>,
  setWorldOrigin: (origin: [number, number, number] | null) =>
    ipcRenderer.invoke(IPC.docSetOrigin, origin) as Promise<EditResponse>,
  transformRegion: (request: TransformRequest) =>
    ipcRenderer.invoke(IPC.docTransform, request) as Promise<EditResponse>,
  copyRegion: (region) => ipcRenderer.invoke(IPC.docCopy, region) as Promise<ClipboardResponse>,
  cutRegion: (region) => ipcRenderer.invoke(IPC.docCut, region) as Promise<ClipboardResponse>,
  pasteClipboard: (request: PasteRequest) =>
    ipcRenderer.invoke(IPC.docPaste, request) as Promise<EditResponse>,
  moveRegion: (request: MoveRegionRequest) =>
    ipcRenderer.invoke(IPC.docMove, request) as Promise<EditResponse>,
  regionMesh: (region) => ipcRenderer.invoke(IPC.docRegionMesh, region) as Promise<RegionMeshResponse>,
  getSkyTextures: () => ipcRenderer.invoke(IPC.skyTextures) as Promise<SkyTextures>,
  getAnchorTexture: () => ipcRenderer.invoke(IPC.anchorTexture) as Promise<PackTexture | null>,
  setWorldEditAnchor: (anchor: [number, number, number] | null) =>
    ipcRenderer.invoke(IPC.docSetOffset, anchor) as Promise<EditResponse>,
  saveDocument: (request: SaveRequest) =>
    ipcRenderer.invoke(IPC.docSave, request) as Promise<SaveResponse>,
  /**
   * The filesystem path of a dropped file.
   *
   * `File.path`, the obvious answer, was removed in Electron 32; `webUtils` is
   * the replacement, and it only exists on this side of the bridge. The `File`
   * itself never crosses — it goes in as an argument and a string comes back,
   * which is the whole reason this is a preload function rather than something
   * the renderer could do itself.
   */
  pathForDroppedFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      // A drag from somewhere with no path behind it — a browser, a zip
      // viewer. Reported as "not a file we can open" rather than as a crash.
      return "";
    }
  },
  peekRecovery: () => ipcRenderer.invoke(IPC.docRecoveryPeek) as Promise<RecoveryPeekResponse>,
  resolveRecovery: (restore: boolean) =>
    ipcRenderer.invoke(IPC.docRecoveryResolve, restore) as Promise<DocumentStateResponse>,
  askAgent: (request: AgentRequestPayload) =>
    ipcRenderer.invoke(IPC.docAgent, request) as Promise<AgentResponse>,
  resetAgentConversation: () => ipcRenderer.invoke(IPC.docAgentReset) as Promise<void>,
  getChatState: () => ipcRenderer.invoke(IPC.chatState) as Promise<ChatState>,
  listConversations: () => ipcRenderer.invoke(IPC.chatList) as Promise<ConversationList>,
  openConversation: (id: string) => ipcRenderer.invoke(IPC.chatOpen, id) as Promise<ChatState>,
  newConversation: () => ipcRenderer.invoke(IPC.chatNew) as Promise<ChatState>,
  deleteConversation: (id: string) =>
    ipcRenderer.invoke(IPC.chatDelete, id) as Promise<ChatState>,
  restoreCheckpoint: (entryIndex: number) =>
    ipcRenderer.invoke(IPC.chatRestore, entryIndex) as Promise<RestoreResponse>,
  cancelAgent: (requestId: string) =>
    ipcRenderer.invoke(IPC.docAgentCancel, requestId) as Promise<boolean>,
  cancelGenerate: (requestId: string) =>
    ipcRenderer.invoke(IPC.generateCancel, requestId) as Promise<boolean>,

  onProgress(listener) {
    // The raw IpcRendererEvent must not leak into the renderer -- it carries
    // `sender`, a live handle back into the main process.
    const wrapped = (_event: unknown, payload: ProgressEvent) => listener(payload);
    ipcRenderer.on(IPC.progress, wrapped);
    return () => ipcRenderer.removeListener(IPC.progress, wrapped);
  },

  onStartupProgress(listener) {
    const wrapped = (_event: unknown, payload: StartupProgressEvent) => listener(payload);
    ipcRenderer.on(IPC.startupProgress, wrapped);
    return () => ipcRenderer.removeListener(IPC.startupProgress, wrapped);
  },

  onAgentStep(listener) {
    const wrapped = (_event: unknown, payload: AgentStepEvent) => listener(payload);
    ipcRenderer.on(IPC.agentStep, wrapped);
    return () => ipcRenderer.removeListener(IPC.agentStep, wrapped);
  },

  onAgentTrace(listener) {
    const wrapped = (_event: unknown, payload: TraceEvent) => listener(payload);
    ipcRenderer.on(IPC.agentTrace, wrapped);
    return () => ipcRenderer.removeListener(IPC.agentTrace, wrapped);
  },

  getMcpStatus: () => ipcRenderer.invoke(IPC.mcpStatus) as Promise<McpStatus>,
  setMcpEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(IPC.mcpSetEnabled, enabled) as Promise<McpStatus>,
  regenerateMcpToken: () => ipcRenderer.invoke(IPC.mcpRegenerateToken) as Promise<McpStatus>,
  getMcpActivity: () => ipcRenderer.invoke(IPC.mcpActivity) as Promise<McpActivity[]>,

  onMcpStatusChanged(listener) {
    const wrapped = (_event: unknown, payload: McpStatus) => listener(payload);
    ipcRenderer.on(IPC.mcpStatusChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC.mcpStatusChanged, wrapped);
  },

  onDocumentChanged(listener) {
    const wrapped = (_event: unknown, payload: DocumentState | null) => listener(payload);
    ipcRenderer.on(IPC.docChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC.docChanged, wrapped);
  },

  /*
   * The menu, one subscription per verb.
   *
   * Written out rather than generated from a table so each name is greppable
   * from both sides -- the same reason `shared/ipc.ts` lists the channels
   * literally instead of composing them.
   */
  onMenuNew: (listener) => subscribe(IPC.menuNew, listener),
  onMenuOpen: (listener) => subscribe(IPC.menuOpen, listener),
  onMenuOpenRecent(listener) {
    const wrapped = (_event: unknown, filePath: string) => listener(filePath);
    ipcRenderer.on(IPC.menuOpenRecent, wrapped);
    return () => ipcRenderer.removeListener(IPC.menuOpenRecent, wrapped);
  },
  onMenuSave: (listener) => subscribe(IPC.menuSave, listener),
  onMenuSaveAs: (listener) => subscribe(IPC.menuSaveAs, listener),
  onMenuClose: (listener) => subscribe(IPC.menuClose, listener),
  onMenuUndo: (listener) => subscribe(IPC.menuUndo, listener),
  onMenuRedo: (listener) => subscribe(IPC.menuRedo, listener),
  onMenuAbout: (listener) => subscribe(IPC.menuAbout, listener),

  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
};

/**
 * A payload-free `ipcRenderer.on`, returning its own unsubscribe.
 *
 * The wrapper is not optional: the raw `IpcRendererEvent` carries `sender`, a
 * live handle back into the main process, and handing it to a renderer
 * listener would put it one property access away from the thing
 * `contextIsolation` exists to prevent.
 */
function subscribe(channel: string, listener: () => void): () => void {
  const wrapped = () => listener();
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("bgpt", api);
