/**
 * Every `ipcMain.handle` registration, and nothing else.
 *
 * ARCHITECTURE.md §2 rule R-2: thin handlers, no business logic. Each one
 * validates, delegates to a service, and maps thrown errors onto the typed
 * `Failure` in `shared/ipc.ts`. That mapping is the whole reason these are not
 * one-liners: the renderer must never receive a raw stack trace, and
 * `ipcMain.handle` rethrows serialize as opaque `Error: Error invoking remote
 * method` strings on the other side.
 */

import { BrowserWindow, dialog, ipcMain, shell } from "electron";

import {
  IPC,
  type Artifact,
  type GenerateRequest,
  type GenerateResponse,
  type OpenCodeModel,
  type PickFileRequest,
  type PickFileResponse,
  type PreviewRequest,
  type PreviewResponse,
  type ProgressEvent,
} from "../../shared/ipc.js";
import {
  providerRequiresApiKey,
  type KeyStorageStatus,
  type Provider,
  type Settings,
} from "../../shared/settings.js";
import { listArtifacts } from "../services/artifacts.js";
import { SchematicFormatError } from "../pipeline/loader.js";
import { classifyGenerateError, generate } from "../services/generate.js";
import { fetchOpenCodeModels } from "../services/opencode.js";
import {
  buildPreview,
  EmptyPreviewError,
  PreviewTooLargeError,
  sunAnglesRadians,
} from "../services/preview.js";
import { defaultResourcePackPath, legacyBlocksPath } from "../services/resources.js";
import {
  clearApiKey,
  getApiKey,
  getKeyStatus,
  getSettings,
  setApiKey,
  setSettings,
} from "../services/settings-store.js";
import { VERSION_NAMES } from "../services/versions.js";

const FILE_FILTERS: Readonly<Record<PickFileRequest["kind"], Electron.FileFilter[]>> = {
  // component.py:288 -- the image uploader's accepted extensions.
  image: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "bmp"] }],
  "resource-pack": [{ name: "Resource pack", extensions: ["zip"] }],
  // `.schematic` is the legacy MCEdit container; the loader reads it via the
  // vendored pre-1.13 block table (pipeline/loader_formats.ts).
  schem: [{ name: "Schematic", extensions: ["schem", "schematic"] }],
};

function emitProgress(window: BrowserWindow | null, event: ProgressEvent): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(IPC.progress, event);
  }
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.settingsGet, async (): Promise<Settings> => await getSettings());

  ipcMain.handle(IPC.settingsSet, async (_event, next: Settings): Promise<Settings> => {
    return await setSettings(next);
  });

  ipcMain.handle(IPC.keysStatus, async (): Promise<KeyStorageStatus> => await getKeyStatus());

  ipcMain.handle(
    IPC.keysSet,
    async (_event, req: { provider: Provider; apiKey: string }): Promise<KeyStorageStatus> => {
      await setApiKey(req.provider, req.apiKey);
      return await getKeyStatus();
    },
  );

  ipcMain.handle(IPC.keysClear, async (_event, provider: Provider): Promise<KeyStorageStatus> => {
    await clearApiKey(provider);
    return await getKeyStatus();
  });

  ipcMain.handle(IPC.versionsList, (): string[] => [...VERSION_NAMES]);

  ipcMain.handle(IPC.opencodeModels, async (): Promise<OpenCodeModel[] | null> => {
    return await fetchOpenCodeModels();
  });

  ipcMain.handle(IPC.pickFile, async (_event, req: PickFileRequest): Promise<PickFileResponse> => {
    const window = getWindow();
    const filters = FILE_FILTERS[req.kind];
    if (!filters) {
      return { path: null, name: null };
    }
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ["openFile"], filters })
      : await dialog.showOpenDialog({ properties: ["openFile"], filters });
    const picked = result.canceled ? undefined : result.filePaths[0];
    if (!picked) {
      return { path: null, name: null };
    }
    return { path: picked, name: picked.split(/[\\/]/).pop() ?? picked };
  });

  ipcMain.handle(IPC.revealPath, async (_event, target: string): Promise<void> => {
    shell.showItemInFolder(target);
  });

  ipcMain.handle(IPC.artifactsList, async (): Promise<Artifact[]> => await listArtifacts());

  ipcMain.handle(IPC.generate, async (_event, req: GenerateRequest): Promise<GenerateResponse> => {
    const window = getWindow();
    const settings = await getSettings();

    if (req.description.trim() === "") {
      // component.py:417's `st.warning("Please provide a description...")`.
      return { ok: false, kind: "invalid-input", message: "Please describe the structure you want to build." };
    }

    const apiKey = await getApiKey(settings.provider);
    if (apiKey.trim() === "" && providerRequiresApiKey(settings.provider)) {
      // component.py:383-384, same gate, same exemption for OpenCode.
      return {
        ok: false,
        kind: "no-api-key",
        message: `Add an API key for ${settings.provider} in Settings.`,
      };
    }

    try {
      const outcome = await generate({
        provider: settings.provider,
        model: settings.model,
        apiKey,
        baseUrl: settings.baseUrl,
        description: req.description,
        version: req.version,
        exportType: req.exportType,
        imagePath: req.imagePath,
        onProgress: (phase, fraction, message) =>
          emitProgress(window, { requestId: req.requestId, phase, fraction, message }),
      });
      return { ok: true, ...outcome };
    } catch (err) {
      return { ok: false, ...classifyGenerateError(err) };
    }
  });

  ipcMain.handle(IPC.preview, async (_event, req: PreviewRequest): Promise<PreviewResponse> => {
    const window = getWindow();
    emitProgress(window, {
      requestId: req.requestId,
      phase: "previewing",
      fraction: 0.1,
      message: "Building preview",
    });
    try {
      const outcome = await buildPreview({
        schemPath: req.schemPath,
        resourcePackPath: req.resourcePackPath,
        // The bundled default pack. Resolved here because this is the Electron
        // boundary — `preview.ts` and the pipeline stay import-free of electron
        // so the test suite can drive them headlessly.
        fallbackResourcePackPath: await defaultResourcePackPath(),
        legacyBlocksPath: legacyBlocksPath(),
      });
      const sun = sunAnglesRadians(req.settings);
      emitProgress(window, {
        requestId: req.requestId,
        phase: "done",
        fraction: 1,
        message: "Preview ready",
      });
      return {
        ok: true,
        glb: outcome.glb,
        center: outcome.center,
        size: outcome.size,
        sunAzimuth: sun.azimuth,
        sunElevation: sun.elevation,
        cached: outcome.cached,
      };
    } catch (err) {
      emitProgress(window, {
        requestId: req.requestId,
        phase: "done",
        fraction: 1,
        message: "Preview failed",
      });
      if (err instanceof PreviewTooLargeError) {
        return { ok: false, kind: "invalid-input", message: err.message };
      }
      if (err instanceof EmptyPreviewError) {
        return { ok: false, kind: "empty-result", message: err.message };
      }
      if (err instanceof SchematicFormatError) {
        // Its message already names the format and the reason; prefixing it
        // with "Failed to build preview" would only bury that.
        return { ok: false, kind: "invalid-input", message: err.message };
      }
      // component.py:455-457 -- "Failed to build preview: {exc}", a warning
      // rather than a hard error, because a failed preview never invalidates
      // the generated file itself.
      return {
        ok: false,
        kind: "io-error",
        message: `Failed to build preview: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}
