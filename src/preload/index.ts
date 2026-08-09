/**
 * The only bridge between renderer and main.
 *
 * ARCHITECTURE.md §2 rule R-1/R-2: the renderer gets exactly the methods
 * declared in `BgptApi` and nothing else -- no `ipcRenderer`, no channel
 * strings, no way to invoke a channel this file does not name. That is the
 * point of enumerating channels in `shared/ipc.ts` rather than exposing a
 * generic `invoke(channel, ...)`.
 */

import { contextBridge, ipcRenderer } from "electron";

import {
  IPC,
  type Artifact,
  type BgptApi,
  type GenerateRequest,
  type GenerateResponse,
  type OpenCodeModel,
  type PickFileRequest,
  type PickFileResponse,
  type PreviewRequest,
  type PreviewResponse,
  type ProgressEvent,
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
  listOpenCodeModels: () => ipcRenderer.invoke(IPC.opencodeModels) as Promise<OpenCodeModel[] | null>,

  pickFile: (req: PickFileRequest) => ipcRenderer.invoke(IPC.pickFile, req) as Promise<PickFileResponse>,
  revealPath: (target: string) => ipcRenderer.invoke(IPC.revealPath, target) as Promise<void>,
  getDefaultOutputDir: () => ipcRenderer.invoke(IPC.defaultOutputDir) as Promise<string>,

  generate: (req: GenerateRequest) => ipcRenderer.invoke(IPC.generate, req) as Promise<GenerateResponse>,
  preview: (req: PreviewRequest) => ipcRenderer.invoke(IPC.preview, req) as Promise<PreviewResponse>,

  listArtifacts: () => ipcRenderer.invoke(IPC.artifactsList) as Promise<Artifact[]>,

  onProgress(listener) {
    // The raw IpcRendererEvent must not leak into the renderer -- it carries
    // `sender`, a live handle back into the main process.
    const wrapped = (_event: unknown, payload: ProgressEvent) => listener(payload);
    ipcRenderer.on(IPC.progress, wrapped);
    return () => ipcRenderer.removeListener(IPC.progress, wrapped);
  },
};

contextBridge.exposeInMainWorld("bgpt", api);
