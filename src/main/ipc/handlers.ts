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
  type AgentRequestPayload,
  type AgentResponse,
  type Artifact,
  type DocumentMeshResponse,
  type DocumentStateResponse,
  type EditRequest,
  type EditResponse,
  type Failure,
  type GenerateRequest,
  type GenerateResponse,
  type InspectResponse,
  openCodeModelRequiresKey,
  type OpenCodeModelInfo,
  type PickFileRequest,
  type PickFileResponse,
  type PreviewRequest,
  type PreviewResponse,
  type ProgressEvent,
  type SaveRequest,
  type SaveResponse,
} from "../../shared/ipc.js";
import {
  providerRequiresApiKey,
  type KeyStorageStatus,
  type PreviewSettings,
  type Provider,
  type Settings,
} from "../../shared/settings.js";
import {
  applyEdit,
  closeDocument,
  currentSession,
  documentMesh,
  documentState,
  EditTooLargeError,
  inspect,
  newDocument,
  NoDocumentError,
  NoSaveTargetError,
  openDocument,
  redoEdit,
  requireSession,
  saveSession,
  undoEdit,
} from "../services/session.js";
import { UnrepresentableBlocksError } from "../services/writers.js";
import { runAgent } from "../agent/agent.js";
import { loadAllowedBlocks } from "../core.js";
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
import { assertWritableDirectory } from "../services/output.js";
import {
  defaultResourcePackPath,
  generatedDir,
  legacyBlocksPath,
  openCodeSnapshotPath,
  resourcesDir,
} from "../services/resources.js";
import {
  clearApiKey,
  getApiKey,
  getKeyStatus,
  getSettings,
  setApiKey,
  setSettings,
} from "../services/settings-store.js";
import { VERSION_NAMES } from "../services/versions.js";

/** File-picking kinds only; `directory` takes the folder branch instead. */
const FILE_FILTERS: Readonly<
  Partial<Record<PickFileRequest["kind"], Electron.FileFilter[]>>
> = {
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

  ipcMain.handle(IPC.opencodeModels, async (): Promise<OpenCodeModelInfo[] | null> => {
    return await fetchOpenCodeModels({ snapshotPath: openCodeSnapshotPath() });
  });

  ipcMain.handle(IPC.pickFile, async (_event, req: PickFileRequest): Promise<PickFileResponse> => {
    const window = getWindow();
    const wantsDirectory = req.kind === "directory";
    const filters = wantsDirectory ? undefined : FILE_FILTERS[req.kind];
    if (!wantsDirectory && !filters) {
      return { path: null, name: null };
    }

    const options: Electron.OpenDialogOptions = wantsDirectory
      ? { properties: ["openDirectory", "createDirectory"] }
      : { properties: ["openFile"], filters };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const picked = result.canceled ? undefined : result.filePaths[0];
    if (!picked) {
      return { path: null, name: null };
    }

    if (wantsDirectory) {
      // Proved writable now rather than at save time: the alternative is
      // discovering the folder is read-only after two paid LLM calls.
      try {
        await assertWritableDirectory(picked);
      } catch (err) {
        return {
          path: null,
          name: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { path: picked, name: picked.split(/[\\/]/).pop() ?? picked };
  });

  ipcMain.handle(IPC.revealPath, async (_event, target: string): Promise<void> => {
    shell.showItemInFolder(target);
  });

  ipcMain.handle(IPC.defaultOutputDir, async (): Promise<string> => generatedDir());

  ipcMain.handle(IPC.artifactsList, async (): Promise<Artifact[]> => await listArtifacts());

  ipcMain.handle(IPC.generate, async (_event, req: GenerateRequest): Promise<GenerateResponse> => {
    const window = getWindow();
    const settings = await getSettings();

    if (req.description.trim() === "") {
      // component.py:417's `st.warning("Please provide a description...")`.
      return { ok: false, kind: "invalid-input", message: "Please describe the structure you want to build." };
    }

    const apiKey = await getApiKey(settings.provider);

    // component.py:383-384 exempted OpenCode from the key gate wholesale,
    // because "OpenCode has free models". Most of them are not: 9 of the 61
    // models it serves are free and the rest bill per token. The gate is now
    // per model, and the reference image is gated the same way -- a text-only
    // model answers an image with an opaque 400.
    let acceptsImages: boolean | undefined;
    if (settings.provider === "OpenCode") {
      const catalogue = await fetchOpenCodeModels({ snapshotPath: openCodeSnapshotPath() });
      const model = catalogue?.find((entry) => entry.id === settings.model);
      if (apiKey.trim() === "" && openCodeModelRequiresKey(model)) {
        return {
          ok: false,
          kind: "no-api-key",
          message:
            `${model?.name ?? settings.model} is a paid OpenCode model. Add an API key, ` +
            `or pick one of the free models in the LLM provider panel.`,
        };
      }
      acceptsImages = model?.imageInput !== "no";
    } else if (apiKey.trim() === "" && providerRequiresApiKey(settings.provider)) {
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
        acceptsImages,
        outputDir: settings.outputDir,
        onProgress: (phase, fraction, message) =>
          emitProgress(window, { requestId: req.requestId, phase, fraction, message }),
      });
      return { ok: true, ...outcome };
    } catch (err) {
      return { ok: false, ...classifyGenerateError(err) };
    }
  });

  // --- the open document ---------------------------------------------------
  //
  // Each of these is the same three lines: resolve the session, do one thing to
  // it, hand back the state the renderer redraws from. The state comes back on
  // every mutating call rather than on a separate round trip, because there is
  // no case where the renderer wants one without the other.

  const failure = (err: unknown): Failure => {
    if (err instanceof NoDocumentError) {
      return { ok: false, kind: "invalid-input", message: err.message };
    }
    if (err instanceof NoSaveTargetError || err instanceof EditTooLargeError) {
      return { ok: false, kind: "invalid-input", message: err.message };
    }
    if (err instanceof UnrepresentableBlocksError) {
      // Its message already names the blocks and suggests .schem; wrapping it
      // would only bury the one thing the user needs to read.
      return { ok: false, kind: "invalid-input", message: err.message };
    }
    if (err instanceof SchematicFormatError || err instanceof EmptyPreviewError) {
      return { ok: false, kind: "invalid-input", message: err.message };
    }
    return {
      ok: false,
      kind: "io-error",
      message: err instanceof Error ? err.message : String(err),
    };
  };

  ipcMain.handle(IPC.docOpen, async (_event, filePath: string): Promise<DocumentStateResponse> => {
    try {
      const session = await openDocument(filePath, { legacyBlocksPath: legacyBlocksPath() });
      return { ok: true, state: documentState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(
    IPC.docNew,
    async (
      _event,
      size: { width: number; height: number; length: number },
    ): Promise<DocumentStateResponse> => {
      try {
        return { ok: true, state: documentState(newDocument(size)) };
      } catch (err) {
        return failure(err);
      }
    },
  );

  ipcMain.handle(IPC.docClose, async (): Promise<void> => closeDocument());

  ipcMain.handle(IPC.docState, async (): Promise<DocumentStateResponse> => {
    const session = currentSession();
    // Not an error: "nothing is open" is the app's starting state.
    return { ok: true, state: session === null ? null : documentState(session) };
  });

  ipcMain.handle(
    IPC.docMesh,
    async (_event, settings: PreviewSettings): Promise<DocumentMeshResponse> => {
      try {
        const session = requireSession();
        const mesh = await documentMesh(session, {
          resourcePackPath: null,
          fallbackResourcePackPath: await defaultResourcePackPath(),
          biomeColor: settings.biomeColor,
          waterColor: settings.waterColor,
        });
        const sun = sunAnglesRadians(settings);
        return {
          ok: true,
          ...mesh,
          sunAzimuth: sun.azimuth,
          sunElevation: sun.elevation,
        };
      } catch (err) {
        return failure(err);
      }
    },
  );

  ipcMain.handle(IPC.docApply, async (_event, request: EditRequest): Promise<EditResponse> => {
    try {
      const session = requireSession();
      const changed = applyEdit(session, request);
      return { ok: true, changed, state: documentState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(IPC.docUndo, async (): Promise<EditResponse> => {
    try {
      const session = requireSession();
      undoEdit(session);
      return { ok: true, changed: 0, state: documentState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(IPC.docRedo, async (): Promise<EditResponse> => {
    try {
      const session = requireSession();
      redoEdit(session);
      return { ok: true, changed: 0, state: documentState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(
    IPC.docInspect,
    async (_event, at: { x: number; y: number; z: number }): Promise<InspectResponse> => {
      try {
        return { ok: true, ...inspect(requireSession(), at.x, at.y, at.z) };
      } catch (err) {
        return failure(err);
      }
    },
  );

  ipcMain.handle(IPC.docSave, async (_event, request: SaveRequest): Promise<SaveResponse> => {
    try {
      const session = requireSession();
      const result = await saveSession(session, {
        filePath: request.filePath ?? null,
        format: request.format,
        legacyBlocksPath: legacyBlocksPath(),
      });
      return {
        ok: true,
        filePath: result.filePath,
        format: result.format,
        degraded: [...result.degraded],
        state: documentState(session),
      };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(
    IPC.docAgent,
    async (_event, req: AgentRequestPayload): Promise<AgentResponse> => {
      const window = getWindow();
      const settings = await getSettings();

      if (req.prompt.trim() === "") {
        return { ok: false, kind: "invalid-input", message: "Say what you want changed." };
      }

      let session;
      try {
        session = requireSession();
      } catch (err) {
        return failure(err);
      }

      // The same key gate as generation, for the same reason: a paid model with
      // no key returns an opaque 401 that reaches the user as "LLM API Error".
      const apiKey = await getApiKey(settings.provider);
      if (settings.provider === "OpenCode") {
        const catalogue = await fetchOpenCodeModels({ snapshotPath: openCodeSnapshotPath() });
        const model = catalogue?.find((entry) => entry.id === settings.model);
        if (apiKey.trim() === "" && openCodeModelRequiresKey(model)) {
          return {
            ok: false,
            kind: "no-api-key",
            message: `${model?.name ?? settings.model} is a paid OpenCode model. Add an API key, or pick a free one.`,
          };
        }
      } else if (apiKey.trim() === "" && providerRequiresApiKey(settings.provider)) {
        return {
          ok: false,
          kind: "no-api-key",
          message: `Add an API key for ${settings.provider} in Settings.`,
        };
      }

      try {
        const result = await runAgent({
          session,
          provider: settings.provider,
          model: settings.model,
          apiKey,
          baseUrl: settings.baseUrl,
          prompt: req.prompt,
          selection: req.selection,
          allowedBlocks: await loadAllowedBlocks(resourcesDir()),
          onStep: (step) => {
            if (window && !window.isDestroyed()) {
              window.webContents.send(IPC.agentStep, {
                requestId: req.requestId,
                tool: step.tool,
                summary: step.summary,
              });
            }
          },
        });
        return {
          ok: true,
          text: result.text,
          changed: result.changed,
          steps: [...result.steps],
          state: documentState(session),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // `runAgent` wraps everything as an LlmError, so the prefix is the
        // signal — same convention `classifyGenerateError` uses.
        return {
          ok: false,
          kind: message.startsWith("LLM API Error") ? "llm-error" : "io-error",
          message,
        };
      }
    },
  );

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
        biomeColor: req.settings.biomeColor,
        waterColor: req.settings.waterColor,
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
