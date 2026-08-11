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
  type AgentStepEvent,
  type Artifact,
  type BgptApi,
  type DocumentMeshResponse,
  type DocumentStateResponse,
  type EditRequest,
  type EditResponse,
  type GenerateRequest,
  type GenerateResponse,
  type InspectResponse,
  type OpenCodeModelInfo,
  type PickFileRequest,
  type PickFileResponse,
  type PreviewRequest,
  type PreviewResponse,
  type ProgressEvent,
  type RecoveryPeekResponse,
  type SaveRequest,
  type SaveResponse,
  type SetKeyRequest,
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
  revealPath: (target: string) => ipcRenderer.invoke(IPC.revealPath, target) as Promise<void>,
  getDefaultOutputDir: () => ipcRenderer.invoke(IPC.defaultOutputDir) as Promise<string>,
  listBlocks: () => ipcRenderer.invoke(IPC.blocksList) as Promise<string[]>,

  generate: (req: GenerateRequest) => ipcRenderer.invoke(IPC.generate, req) as Promise<GenerateResponse>,
  preview: (req: PreviewRequest) => ipcRenderer.invoke(IPC.preview, req) as Promise<PreviewResponse>,

  listArtifacts: () => ipcRenderer.invoke(IPC.artifactsList) as Promise<Artifact[]>,

  openDocument: (filePath: string) =>
    ipcRenderer.invoke(IPC.docOpen, filePath) as Promise<DocumentStateResponse>,
  newDocument: (size) => ipcRenderer.invoke(IPC.docNew, size) as Promise<DocumentStateResponse>,
  closeDocument: () => ipcRenderer.invoke(IPC.docClose) as Promise<void>,
  getDocumentState: () => ipcRenderer.invoke(IPC.docState) as Promise<DocumentStateResponse>,
  getDocumentMesh: (settings) =>
    ipcRenderer.invoke(IPC.docMesh, settings) as Promise<DocumentMeshResponse>,
  applyEdit: (request: EditRequest) =>
    ipcRenderer.invoke(IPC.docApply, request) as Promise<EditResponse>,
  undo: () => ipcRenderer.invoke(IPC.docUndo) as Promise<EditResponse>,
  redo: () => ipcRenderer.invoke(IPC.docRedo) as Promise<EditResponse>,
  inspectBlock: (x: number, y: number, z: number) =>
    ipcRenderer.invoke(IPC.docInspect, { x, y, z }) as Promise<InspectResponse>,
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
  cancelAgent: (requestId: string) =>
    ipcRenderer.invoke(IPC.docAgentCancel, requestId) as Promise<boolean>,

  onProgress(listener) {
    // The raw IpcRendererEvent must not leak into the renderer -- it carries
    // `sender`, a live handle back into the main process.
    const wrapped = (_event: unknown, payload: ProgressEvent) => listener(payload);
    ipcRenderer.on(IPC.progress, wrapped);
    return () => ipcRenderer.removeListener(IPC.progress, wrapped);
  },

  onAgentStep(listener) {
    const wrapped = (_event: unknown, payload: AgentStepEvent) => listener(payload);
    ipcRenderer.on(IPC.agentStep, wrapped);
    return () => ipcRenderer.removeListener(IPC.agentStep, wrapped);
  },
};

contextBridge.exposeInMainWorld("bgpt", api);
