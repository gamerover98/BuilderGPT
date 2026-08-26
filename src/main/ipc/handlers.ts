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
  type DocumentState,
  type DocumentStateResponse,
  type EditRequest,
  type EditResponse,
  type ChatState,
  type ConversationList,
  type RestoreResponse,
  type Failure,
  type FailureKind,
  type GenerateRequest,
  type GenerateResponse,
  type InspectResponse,
  openCodeModelRequiresKey,
  type OpenCodeModelInfo,
  type ConfirmDiscardRequest,
  type DocumentVersion,
  type SaveVersionRequest,
  type PickFileRequest,
  type PickFileResponse,
  type PreviewRequest,
  type PreviewResponse,
  type BlockIconsRequest,
  type BlockIconsResponse,
  type NewDocumentRequest,
  type ProgressEvent,
  type TraceItem,
  type RecentDocument,
  type RecoveryPeekResponse,
  type SaveRequest,
  type SaveResponse,
  type ClipboardResponse,
  type PasteRequest,
  type RegionSpec,
  type DocumentMeshRequest,
  type MoveRegionRequest,
  type RegionMeshResponse,
  type ApplyNbtRequest,
  type PackTexture,
  type SchematicNbtResponse,
  type SetNbtRequest,
  type SkyTextures,
  type StartupProgressEvent,
  type TransformRequest,
} from "../../shared/ipc.js";
import { SCHEMATIC_FORMAT_LABEL, schematicExtension } from "../../shared/schematic.js";
import { dataVersionOf, refusalFor } from "../../shared/mc_versions.js";
import {
  providerRequiresApiKey,
  type KeyStorageStatus,
  type PreviewSettings,
  type Provider,
  type Settings,
} from "../../shared/settings.js";
import {
  type DocumentSession,
  adoptDocument,
  applyEdit,
  closeDocument,
  copySelection,
  currentSession,
  cutSelection,
  documentMesh,
  documentState,
  moveRegion,
  regionMesh,
  editBlockEntityValue,
  EditTooLargeError,
  EmptyClipboardError,
  inspect,
  newDocument,
  NoBlockEntityError,
  NoDocumentError,
  NoSaveTargetError,
  openDocument,
  pasteSelection,
  redoEdit,
  requireSession,
  saveSession,
  NotSquareError,
  transformRegion,
  undoEdit,
} from "../services/session.js";
import { NbtEditError } from "../domain/nbt_edit.js";
import { SnbtError } from "../domain/snbt.js";
import {
  applyNbt,
  NbtApplyError,
  schematicNbtText,
  setWorldEditAnchor,
  setWorldOrigin,
} from "../services/schematic_nbt.js";
import { UnrepresentableBlocksError } from "../services/writers.js";
import { AgentCancelledError, runAgent } from "../agent/agent.js";
import {
  adoptSubject,
  appendEntry,
  projectNotes,
  rememberProject,
  checkpointAt,
  forkAt,
  stampCheckpoint,
  conversationMessages,
  conversationState,
  deleteConversation,
  listConversations,
  newConversation,
  noteTurn,
  openConversation,
  resetConversation,
  saveConversation,
  useConversationDirectory,
} from "../services/conversation.js";
import { clearAutosave, readAutosave, restoreAutosave, startAutosave } from "../services/autosave.js";
import {
  checkpointExists,
  forgetCheckpointMemo,
  readCheckpoint,
  takeCheckpoint,
  useCheckpointDirectory,
} from "../services/checkpoints.js";
import { loadAllowedBlocks, traceOf } from "../core.js";
import { buildBlockIcons, warmBlockIcons } from "../services/block_icons.js";
import { listArtifacts } from "../services/artifacts.js";
import { loadAnchorTexture, loadSkyTextures } from "../services/sky_textures.js";
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
  autosaveDir,
  checkpointsDir,
  conversationsDir,
  snapshotsDir,
  defaultResourcePackPath,
  generatedDir,
  legacyBlocksPath,
  openCodeSnapshotPath,
  resourcesDir,
} from "../services/resources.js";
import {
  clearApiKey,
  forgetRecentDocument,
  getApiKey,
  getKeyStatus,
  getRecentDocuments,
  getSettings,
  rememberRecentDocument,
  setApiKey,
  setSettings,
} from "../services/settings-store.js";
import { discardPrompt } from "../services/discard_prompt.js";
import {
  deleteSnapshot,
  listSnapshots,
  readSnapshot,
  takeSnapshot,
  useSnapshotDirectory,
} from "../services/snapshots.js";
import { refreshShell, rememberInOsRecents } from "../menu.js";
import { shellState, useWindow } from "../services/broadcast.js";
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

/**
 * Agent runs the user can still stop, by request id.
 *
 * Keyed rather than a single slot because the renderer being busy is a UI
 * convention, not something main can rely on — nothing stops a retry or a
 * second window from overlapping, and aborting the wrong run is worse than not
 * offering the button. Entries are removed in the `finally` of the run itself,
 * so a finished run cannot be cancelled and the map cannot grow.
 */
const inFlightAgentRuns = new Map<string, AbortController>();

/**
 * The same, for generation.
 *
 * Two maps rather than one, because the two runs are started by two different
 * handlers and cancelled through two different channels; sharing a map would
 * let a stale id from one abort the other. From the chat they are the same
 * button, and that is a renderer concern.
 */
const inFlightGenerations = new Map<string, AbortController>();

/**
 * How many block icons one request may ask for.
 *
 * The inventory grid is virtualised and asks for what is on screen, which is
 * around sixty. This is the guard against a bug there asking for the whole
 * block list, which would mesh nine hundred documents while the window sat
 * still and looked frozen.
 */
const MAX_ICONS_PER_REQUEST = 128;

function emitProgress(window: BrowserWindow | null, event: ProgressEvent): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(IPC.progress, event);
  }
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  // Where `announceDocument` pushes. Installed here because this is where the
  // window getter arrives, and before anything can edit a document.
  useWindow(getWindow);


  // Snapshots the open document while it differs from disk. Started here
  // because this is where the app's wiring lives, and left running for the
  // process's lifetime — there is nothing to tear down that outlives it.
  startAutosave({
    dir: autosaveDir(),
    getSession: currentSession,
    onError: (err) => console.warn("[autosave] snapshot failed:", err),
  });

  // Injected rather than imported: `conversation.ts` must not pull in Electron,
  // or the suites cannot reach it -- the same split `recent_documents.ts` was
  // made for.
  useConversationDirectory(conversationsDir());
  useCheckpointDirectory(checkpointsDir());
  useSnapshotDirectory(snapshotsDir());

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

  /*
   * Asked before anything that would drop unsaved work on the floor.
   *
   * `newDocument` reassigns the open session without looking at what was there,
   * and so does opening another file -- which was survivable only because
   * nobody had noticed. The check has to be in front of the call, not inside
   * it: by the time `session.ts` has the request the renderer has already
   * committed to the new document.
   */
  ipcMain.handle(
    IPC.confirmDiscard,
    async (_event, req: ConfirmDiscardRequest): Promise<boolean> => {
      const window = getWindow();
      const prompt = discardPrompt(req.intent, req.fileName);
      const options: Electron.MessageBoxOptions = {
        type: "warning",
        // Confirm first, cancel second, and `cancelId` named rather than
        // inferred: Escape and the window's close button both have to land on
        // "keep my work", whatever the platform decides the order should be.
        buttons: [prompt.confirmLabel, prompt.cancelLabel],
        defaultId: 1,
        cancelId: 1,
        message: prompt.message,
        detail: prompt.detail,
      };
      const answer = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      return answer.response === 0;
    },
  );

  ipcMain.handle(IPC.pickFile, async (_event, req: PickFileRequest): Promise<PickFileResponse> => {
    const window = getWindow();

    /*
     * Saving is the one kind that asks where a file should *go*, so it is the
     * one kind that goes to `showSaveDialog`. There was no call to it anywhere
     * in the app, which is why Save As made you choose a *folder* and then
     * reused the name and format the document already had — not a missing
     * feature so much as a missing dialog, with everything else downstream of
     * that.
     */
    if (req.kind === "save-schematic") {
      const format = req.format ?? "sponge3";
      const extension = schematicExtension(format);
      const options: Electron.SaveDialogOptions = {
        title: `Save as ${SCHEMATIC_FORMAT_LABEL[format]}`,
        defaultPath: req.defaultPath ?? undefined,
        filters: [{ name: SCHEMATIC_FORMAT_LABEL[format], extensions: [extension] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      };
      const saved = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (saved.canceled || !saved.filePath) {
        return { path: null, name: null };
      }
      /*
       * The extension is forced rather than trusted. The dialog appends one only
       * on some platforms and only when the user typed none, and a `.schem`
       * holding MCEdit bytes is a file nothing will open — `saveSession` already
       * corrects this for the same reason, and doing it here means the path the
       * user is shown is the path that gets written.
       */
      const wanted = `.${extension}`;
      const target = saved.filePath.toLowerCase().endsWith(wanted)
        ? saved.filePath
        : saved.filePath + wanted;
      return { path: target, name: target.split(/[\\/]/).pop() ?? target };
    }

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
  ipcMain.handle(
    IPC.blocksList,
    async (): Promise<string[]> => [...(await loadAllowedBlocks(resourcesDir()))].sort(),
  );

  ipcMain.handle(
    IPC.blockIcons,
    async (_event, req: BlockIconsRequest): Promise<BlockIconsResponse> => {
      try {
        const settings = await getSettings();
        const result = await buildBlockIcons(
          // Capped here rather than trusted: the renderer asks for what is on
          // screen, and a bug there asking for all 933 would mesh 933
          // documents while the window sat still.
          req.blocks.slice(0, MAX_ICONS_PER_REQUEST),
          {
            resourcePackPath: null,
            fallbackResourcePackPath: await defaultResourcePackPath(),
            biomeColor: settings.preview.biomeColor,
            waterColor: settings.preview.waterColor,
          },
          req.atlasVersion ?? null,
        );
        return { ok: true, ...result };
      } catch (err) {
        return failure(err);
      }
    },
  );

  /*
   * Decodes every block's textures once, so the atlas stops growing under the
   * icons.
   *
   * It runs *now*, at registration, rather than when the renderer asks for it.
   * That is the only concurrency available to a single-threaded main process
   * and it is the useful kind: this overlaps with creating the window, loading
   * the renderer, mounting it, and the three IPC round-trips it makes before it
   * gets here. It is under a second of work and most of that second happens
   * while there is nothing else to wait on.
   *
   * `breathe` inside the loop is what makes that safe -- without a yield that
   * runs *after* I/O, this would starve the very window creation it is meant to
   * overlap with.
   *
   * The promise is held rather than the result, so the renderer's call joins
   * the run in flight instead of starting another.
   */
  let warming: Promise<number> | null = null;
  /*
   * The last progress reported, so a renderer that subscribes mid-run is not
   * left looking at a bar that never moves. Starting the work before the window
   * exists means the first events have nowhere to go -- which is the price of
   * starting early, and this is the whole of it.
   */
  let warmProgress: StartupProgressEvent = { done: 0, total: 0 };

  const sendWarmProgress = (event: StartupProgressEvent): void => {
    warmProgress = event;
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.startupProgress, event);
    }
  };

  const startWarming = (): Promise<number> => {
    if (warming !== null) return warming;
    warming = (async () => {
      const settings = await getSettings();
      return await warmBlockIcons(
        [...(await loadAllowedBlocks(resourcesDir()))],
        {
          resourcePackPath: null,
          fallbackResourcePackPath: await defaultResourcePackPath(),
          biomeColor: settings.preview.biomeColor,
          waterColor: settings.preview.waterColor,
        },
        (done, total) => sendWarmProgress({ done, total }),
      );
    })();
    return warming;
  };

  ipcMain.handle(IPC.blockIconsWarm, async (): Promise<number> => {
    const run = startWarming();
    // Whatever it has reached, to the renderer that just started listening.
    if (warmProgress.total > 0) sendWarmProgress(warmProgress);
    try {
      return await run;
    } catch {
      // Let it be asked for again: a warm-up that failed leaves the icons
      // working exactly as they did before it, only slower.
      warming = null;
      return 0;
    }
  });

  // Off it goes, before the window exists. Errors are the handler's problem;
  // an unhandled rejection here would be a crash on a slow disk.
  void startWarming().catch(() => {});

  ipcMain.handle(IPC.artifactsList, async (): Promise<Artifact[]> => await listArtifacts());

  ipcMain.handle(IPC.generate, async (_event, req: GenerateRequest): Promise<GenerateResponse> => {
    const window = getWindow();
    const settings = await getSettings();

    /*
     * Records the outcome in the chat log, when the request came from the chat.
     *
     * Wrapped around each return rather than written at each one: there are
     * five ways out of this handler and every one of them is something the user
     * asked for and should be able to see.
     */
    const settle = (response: GenerateResponse, trace?: TraceItem[]): GenerateResponse => {
      if (req.viaChat !== true) return response;
      if (response.ok) {
        appendEntry({
          role: "agent",
          text: `Built ${response.name}.${response.exportType}.`,
          trace: response.trace,
        });
      } else {
        // Stopping is not a failure — the user did it on purpose — so it reads
        // as a note, exactly as it does on the agent path. An error bubble
        // would make pressing Stop look like something went wrong.
        //
        // The trace goes on either way, and on a failure it is the whole point:
        // "the model's output could not be converted" is only actionable next
        // to the output it could not convert.
        appendEntry({
          role: response.kind === "cancelled" ? "note" : "error",
          text: response.message,
          trace,
        });
      }
      return response;
    };

    if (req.description.trim() === "") {
      // Nothing was said, so nothing goes in the log -- not even from the chat.
      // component.py:417's `st.warning("Please provide a description...")`.
      return { ok: false, kind: "invalid-input", message: "Please describe the structure you want to build." };
    }

    // The question goes in before anything that can refuse it, exactly as in
    // `askAgent`, so a refusal is shown under the thing it refused.
    if (req.viaChat === true) appendEntry({ role: "user", text: req.description });

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
        return settle({
          ok: false,
          kind: "no-api-key",
          message:
            `${model?.name ?? settings.model} is a paid OpenCode model. Add an API key, ` +
            `or pick one of the free models in the LLM provider panel.`,
        });
      }
      acceptsImages = model?.imageInput !== "no";
    } else if (apiKey.trim() === "" && providerRequiresApiKey(settings.provider)) {
      return settle({
        ok: false,
        kind: "no-api-key",
        message: `Add an API key for ${settings.provider} in Settings.`,
      });
    }

    /*
     * Registered before the run, for the same reason the agent's is: a Stop
     * arriving while the model is still being resolved has to find something
     * to abort. `generate` has taken a signal since it was written and was
     * never given one, so the chat's Stop button was shown and did nothing.
     */
    const controller = new AbortController();
    inFlightGenerations.set(req.requestId, controller);
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
        requestId: req.requestId,
        onTrace: (event) => {
          if (window && !window.isDestroyed()) window.webContents.send(IPC.agentTrace, event);
        },
        signal: controller.signal,
      });
      return settle({ ok: true, ...outcome });
    } catch (err) {
      // Asked of the signal rather than of the error, the same way `agent.ts`
      // does it: an aborted call reports itself in more than one shape
      // depending on which of the two LLM requests it was in, but the signal is
      // unambiguous.
      if (controller.signal.aborted) {
        return settle(
          { ok: false, kind: "cancelled", message: "Stopped. Nothing was built." },
          traceOf<TraceItem>(err),
        );
      }
      return settle({ ok: false, ...classifyGenerateError(err) }, traceOf<TraceItem>(err));
    } finally {
      inFlightGenerations.delete(req.requestId);
    }
  });

  ipcMain.handle(IPC.generateCancel, async (_event, requestId: string): Promise<boolean> => {
    const controller = inFlightGenerations.get(requestId);
    // Same contract as the agent's: not finding one is not an error, because
    // the button and the run settling race by nature.
    if (!controller) return false;
    controller.abort();
    return true;
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
    if (err instanceof EmptyClipboardError) {
      return { ok: false, kind: "invalid-input", message: err.message };
    }
    if (err instanceof NotSquareError) {
      return { ok: false, kind: "invalid-input", message: err.message };
    }
    if (err instanceof NbtEditError || err instanceof NoBlockEntityError) {
      // "300 is out of range for a byte" is the whole message the user needs,
      // and it is theirs to fix — not an io-error.
      return { ok: false, kind: "invalid-input", message: err.message };
    }
    if (err instanceof SnbtError || err instanceof NbtApplyError) {
      // Both already name a line and column, or a tag. An error that says
      // where it is is not an io-error.
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
      // Only once it really opened. Recording the attempt would fill the list
      // with paths that fail every time they are clicked.
      await rememberRecentDocument(filePath);
      // The OS keeps its own list, and it is the only part of "what was I
      // working on" that survives the app not being open.
      rememberInOsRecents(filePath);
      /*
       * Not an unconditional reset. A chat that built this file with nothing
       * open is *about* it, and this is the moment it gets opened -- clearing
       * here is what used to erase the question and leave only the answer.
       * Opening some other file is still a change of subject and still clears.
       */
      await adoptSubject(filePath);
      forgetCheckpointMemo();
      return { ok: true, state: shellState(session), project: await projectNotes(filePath) };
    } catch (err) {
      // Moved, deleted, or no longer readable: take it off the list rather than
      // leave an entry whose only behaviour is to produce this same error.
      await forgetRecentDocument(filePath);
      return failure(err);
    }
  });

  ipcMain.handle(
    IPC.docRecentList,
    async (): Promise<RecentDocument[]> => await getRecentDocuments(),
  );

  ipcMain.handle(
    IPC.docNew,
    async (_event, req: NewDocumentRequest): Promise<DocumentStateResponse> => {
      try {
        // Mirrored by the dialog and enforced here. A renderer that filtered
        // correctly today is not the same thing as a rule, and this is the only
        // side that writes files.
        const refusal = refusalFor(req.format, req.version);
        if (refusal !== null) {
          return { ok: false, kind: "invalid-input", message: refusal };
        }
        const state = shellState(
          newDocument(
            { width: req.width, height: req.height, length: req.length },
            req.format,
            dataVersionOf(req.version),
          ),
        );
        await adoptSubject(null);
        return { ok: true, state };
      } catch (err) {
        return failure(err);
      }
    },
  );

  ipcMain.handle(IPC.docClose, async (): Promise<void> => {
    // The last chance to write it: nothing further happens to a conversation
    // whose document has gone.
    await saveConversation();
    resetConversation(null);
    closeDocument();
    // The only handler that changes whether a document exists and answers with
    // nothing, so it is the only one `shellState` cannot cover.
    await refreshShell();
  });

  ipcMain.handle(IPC.docState, async (): Promise<DocumentStateResponse> => {
    const session = currentSession();
    // Not an error: "nothing is open" is the app's starting state.
    return { ok: true, state: session === null ? null : documentState(session) };
  });

  ipcMain.handle(
    IPC.docMesh,
    async (_event, request: DocumentMeshRequest): Promise<DocumentMeshResponse> => {
      try {
        const { settings } = request;
        const session = requireSession();
        const mesh = await documentMesh(
          session,
          {
            resourcePackPath: null,
            fallbackResourcePackPath: await defaultResourcePackPath(),
            biomeColor: settings.biomeColor,
            showMarkers: settings.showMarkers,
            waterColor: settings.waterColor,
            blockLight: settings.blockLight,
            occlusion: settings.ambientOcclusion,
            smoothLighting: settings.smoothLighting,
          },
          // What the window says it already has. Main decides what to send
          // from it; it is never a request for anything in particular.
          { mesh: request.haveMesh, atlas: request.haveAtlas },
        );
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
      return { ok: true, changed, state: shellState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(IPC.docSetNbt, async (_event, request: SetNbtRequest): Promise<EditResponse> => {
    try {
      const session = requireSession();
      const changed = editBlockEntityValue(
        session,
        request.x,
        request.y,
        request.z,
        request.path,
        request.value,
      );
      return { ok: true, changed, state: shellState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(IPC.docNbtRead, async (): Promise<SchematicNbtResponse> => {
    try {
      const session = requireSession();
      const { text, editable, omitted, revision } = schematicNbtText(session.doc);
      return { ok: true, text, editable, omitted: [...omitted], revision };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(
    IPC.docNbtApply,
    async (_event, request: ApplyNbtRequest): Promise<EditResponse> => {
      try {
        const session = requireSession();
        const changed = applyNbt(
          session.doc,
          session.history,
          request.text,
          request.revision,
          "Edit the schematic's NBT",
        );
        return { ok: true, changed, state: shellState(session) };
      } catch (err) {
        return failure(err);
      }
    },
  );

  ipcMain.handle(IPC.anchorTexture, async (): Promise<PackTexture | null> => {
    try {
      return await loadAnchorTexture(null, await defaultResourcePackPath());
    } catch {
      // A pack that cannot be read means the marker is drawn as the plain green
      // box, which still says where the anchor is. Not worth a banner.
      return null;
    }
  });

  ipcMain.handle(
    IPC.docSetOffset,
    async (_event, anchor: [number, number, number] | null): Promise<EditResponse> => {
      try {
        const session = requireSession();
        setWorldEditAnchor(session.doc, session.history, anchor, "Set the WorldEdit anchor");
        return { ok: true, changed: 0, state: shellState(session) };
      } catch (err) {
        return failure(err);
      }
    },
  );

  ipcMain.handle(
    IPC.docSetOrigin,
    async (_event, origin: [number, number, number] | null): Promise<EditResponse> => {
      try {
        const session = requireSession();
        setWorldOrigin(session.doc, session.history, origin, "Set the WorldEdit origin");
        return { ok: true, changed: 0, state: shellState(session) };
      } catch (err) {
        return failure(err);
      }
    },
  );

  ipcMain.handle(IPC.docMove, async (_event, request: MoveRegionRequest): Promise<EditResponse> => {
    try {
      const session = requireSession();
      const changed = moveRegion(session, request.region, request.to);
      return { ok: true, changed, state: shellState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(
    IPC.docRegionMesh,
    async (_event, region: RegionSpec): Promise<RegionMeshResponse> => {
      try {
        const settings = await getSettings();
        const result = await regionMesh(requireSession(), region, {
          resourcePackPath: null,
          fallbackResourcePackPath: await defaultResourcePackPath(),
          biomeColor: settings.preview.biomeColor,
          showMarkers: settings.preview.showMarkers,
          waterColor: settings.preview.waterColor,
        });
        return { ok: true, ...result };
      } catch (err) {
        return failure(err);
      }
    },
  );

  ipcMain.handle(IPC.skyTextures, async (): Promise<SkyTextures> => {
    try {
      return await loadSkyTextures(null, await defaultResourcePackPath());
    } catch {
      // A pack that cannot be read is a sky drawn with plain squares, which is
      // what it was before the pack was asked. Not worth a banner.
      return { sun: null, moon: null };
    }
  });

  ipcMain.handle(IPC.docTransform, async (_event, request: TransformRequest): Promise<EditResponse> => {
    try {
      const session = requireSession();
      const changed = transformRegion(session, request.region, request.transform);
      return { ok: true, changed, state: shellState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  const clipboardInfo = (held: { width: number; height: number; length: number; blocks: number }) => ({
    width: held.width,
    height: held.height,
    length: held.length,
    blocks: held.blocks,
  });

  ipcMain.handle(IPC.docCopy, async (_event, region: RegionSpec): Promise<ClipboardResponse> => {
    try {
      const session = requireSession();
      return { ok: true, clipboard: clipboardInfo(copySelection(session, region)), state: shellState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(IPC.docCut, async (_event, region: RegionSpec): Promise<ClipboardResponse> => {
    try {
      const session = requireSession();
      return { ok: true, clipboard: clipboardInfo(cutSelection(session, region)), state: shellState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(IPC.docPaste, async (_event, request: PasteRequest): Promise<EditResponse> => {
    try {
      const session = requireSession();
      const changed = pasteSelection(session, request, { includeAir: request.includeAir });
      return { ok: true, changed, state: shellState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(IPC.docUndo, async (): Promise<EditResponse> => {
    try {
      const session = requireSession();
      undoEdit(session);
      return { ok: true, changed: 0, state: shellState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(IPC.docRedo, async (): Promise<EditResponse> => {
    try {
      const session = requireSession();
      redoEdit(session);
      return { ok: true, changed: 0, state: shellState(session) };
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
      if (request.version !== undefined) {
        const refusal = refusalFor(request.format ?? session.doc.format, request.version);
        if (refusal !== null) {
          return { ok: false, kind: "invalid-input", message: refusal };
        }
      }
      const result = await saveSession(session, {
        filePath: request.filePath ?? null,
        format: request.format,
        // Only when asked. Omitting it means "keep what the document carries",
        // which is what a plain Save wants; passing `null` unconditionally would
        // strip the version tag off every file the app touched.
        ...(request.version === undefined ? {} : { dataVersion: dataVersionOf(request.version) }),
        legacyBlocksPath: legacyBlocksPath(),
      });
      /*
       * A conversation started with nothing open has no key to be stored under
       * -- this is the moment it gets one. A *Save As* onto a different path is
       * the same call and does the same thing: the conversation follows the
       * document to where the document went.
       */
      await adoptSubject(result.filePath);
      /*
       * What this file is for, remembered beside the talking about it.
       *
       * Written after the save rather than before, so a save that failed does
       * not leave a note claiming a format the file is not in. Merged, never
       * replaced -- see `rememberProject`.
       */
      await rememberProject(result.filePath, {
        format: result.format,
        ...(request.version === undefined ? {} : { version: request.version }),
      });
      return {
        ok: true,
        filePath: result.filePath,
        format: result.format,
        degraded: [...result.degraded],
        cropped: result.cropped,
        state: shellState(session),
      };
    } catch (err) {
      return failure(err);
    }
  });

  /*
   * The open schematic's own version history.
   *
   * Keyed on the file, so "which schematic is this a version of" has an answer
   * that survives the session. A document that has never been saved has no key
   * and therefore no history -- the same rule conversations follow, and the
   * list is empty rather than an error, because having none is ordinary.
   */
  ipcMain.handle(IPC.docVersionList, async (): Promise<DocumentVersion[]> => {
    const session = currentSession();
    return await listSnapshots(session?.doc.filePath ?? null);
  });

  ipcMain.handle(
    IPC.docVersionSave,
    async (_event, req: SaveVersionRequest): Promise<DocumentVersion[]> => {
      const session = currentSession();
      if (session === null) return [];
      await takeSnapshot(session, req.source, req.label);
      return await listSnapshots(session.doc.filePath);
    },
  );

  /*
   * Going back is a fork, not a one-way door.
   *
   * `adoptDocument` starts a fresh history, so a restore cannot be undone --
   * which is exactly why the state being left is snapshotted first. Same shape
   * as the chat's checkpoint restore, and for the same reason.
   */
  ipcMain.handle(
    IPC.docVersionRestore,
    async (_event, id: string): Promise<DocumentStateResponse> => {
      try {
        const session = requireSession();
        const filePath = session.doc.filePath;
        if (filePath === null) {
          return {
            ok: false,
            kind: "invalid-input",
            message: "This schematic has never been saved, so it has no versions",
          };
        }
        const restored = await readSnapshot(filePath, id);
        if (restored === null) {
          return {
            ok: false,
            kind: "io-error",
            message: "That version is no longer on disk",
          };
        }
        await takeSnapshot(session, "manual", "Before going back");
        adoptDocument(restored.doc, restored.history);
        forgetCheckpointMemo();
        return { ok: true, state: shellState(requireSession()) };
      } catch (err) {
        return failure(err);
      }
    },
  );

  ipcMain.handle(IPC.docVersionDelete, async (_event, id: string): Promise<DocumentVersion[]> => {
    const session = currentSession();
    if (session?.doc.filePath == null) return [];
    return await deleteSnapshot(session.doc.filePath, id);
  });

  ipcMain.handle(IPC.docRecoveryPeek, async (): Promise<RecoveryPeekResponse> => {
    try {
      // Only offered when nothing is open. A snapshot found while the user is
      // already working belongs to *this* session and is not a recovery.
      if (currentSession() !== null) {
        return { ok: true, recovery: null };
      }
      return { ok: true, recovery: await readAutosave(autosaveDir()) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(
    IPC.docRecoveryResolve,
    async (_event, restore: boolean): Promise<DocumentStateResponse> => {
      try {
        if (!restore) {
          await clearAutosave(autosaveDir());
          return { ok: true, state: null };
        }
        const session = await restoreAutosave(autosaveDir());
        if (session === null) {
          // The snapshot turned out to be unreadable. Clear it rather than
          // offering it again on every launch.
          await clearAutosave(autosaveDir());
          return { ok: false, kind: "io-error", message: "The recovered file could not be read." };
        }
        adoptDocument(session.doc, session.history);
        /*
         * Recovering is opening, so the conversation follows the file.
         *
         * This was missing, and the symptom was precise: a schematic restored
         * at launch came back with an empty chat, while the *same file* opened
         * from File > Open Recent came back with its history. A recovered
         * document carries its original path -- see `restoreAutosave` -- and
         * that path is the key the conversation is stored under, so there is
         * nothing else to look it up by and nothing else to do.
         *
         * The two other `adoptDocument` calls in this file deliberately do not
         * do this: going back to a version or a checkpoint replaces the
         * document with another state of the *same* file, and the subject has
         * not moved.
         */
        await adoptSubject(session.doc.filePath);
        forgetCheckpointMemo();
        return { ok: true, state: shellState(requireSession()), chat: conversationState() };
      } catch (err) {
        return failure(err);
      }
    },
  );

  ipcMain.handle(
    IPC.docAgent,
    async (_event, req: AgentRequestPayload): Promise<AgentResponse> => {
      const window = getWindow();
      const settings = await getSettings();

      if (req.prompt.trim() === "") {
        // Nothing was said, so nothing goes in the log.
        return {
          ok: false,
          kind: "invalid-input",
          message: "Say what you want changed.",
          chat: conversationState(),
        };
      }

      /*
       * The user's turn goes in before anything that can refuse it, because it
       * happened: they typed it and pressed send. Every failure below therefore
       * shows the question above the answer, which is what makes "add an API
       * key" legible rather than a message floating on its own.
       *
       * It is *not* marked remembered here. That only becomes true once
       * `runAgent` returns, and the gap between the two is exactly what keeps
       * the memory divider honest when a run fails.
       */
      appendEntry({ role: "user", text: req.prompt });

      /** Puts main's own wording in the log and hands the log back with it. */
      const refuse = (kind: FailureKind, message: string): AgentResponse => ({
        ok: false,
        kind,
        message,
        chat: appendEntry({ role: "error", text: message }),
      });

      let session;
      try {
        session = requireSession();
      } catch (err) {
        const failed = failure(err);
        return refuse(failed.kind, failed.message);
      }

      // The same key gate as generation, for the same reason: a paid model with
      // no key returns an opaque 401 that reaches the user as "LLM API Error".
      const apiKey = await getApiKey(settings.provider);
      if (settings.provider === "OpenCode") {
        const catalogue = await fetchOpenCodeModels({ snapshotPath: openCodeSnapshotPath() });
        const model = catalogue?.find((entry) => entry.id === settings.model);
        if (apiKey.trim() === "" && openCodeModelRequiresKey(model)) {
          return refuse(
            "no-api-key",
            `${model?.name ?? settings.model} is a paid OpenCode model. Add an API key, or pick a free one.`,
          );
        }
      } else if (apiKey.trim() === "" && providerRequiresApiKey(settings.provider)) {
        return refuse("no-api-key", `Add an API key for ${settings.provider} in Settings.`);
      }

      // Registered before the run so a Stop arriving while the model is still
      // being resolved still finds something to abort.
      const controller = new AbortController();
      inFlightAgentRuns.set(req.requestId, controller);
      try {
        /*
         * The state as it stands, before this turn changes anything -- which is
         * what "go back to before I asked this" means. Taken with the messages
         * the model is about to be given, so going back restores its memory too
         * rather than leaving a conversation it has no record of.
         *
         * A turn that fails costs nothing here: `takeCheckpoint` keys on
         * `doc.revision`, and a rolled-back run leaves that where it started.
         *
         * Inside the controller's window, not above it: this writes a whole
         * schematic to disk, and while it ran there was nothing registered for
         * `cancelAgent` to find -- so Stop, pressed during it, silently did
         * nothing. A Stop landing here now aborts the signal before `runAgent`
         * ever uses it, which it already handles.
         */
        const checkpoint = await takeCheckpoint(session, conversationMessages());
        if (checkpoint !== null) stampCheckpoint(checkpoint);

        const result = await runAgent({
          requestId: req.requestId,
          session,
          provider: settings.provider,
          model: settings.model,
          apiKey,
          baseUrl: settings.baseUrl,
          prompt: req.prompt,
          // What the conversation holds, replayed. `runAgent` trims it to its
          // own window; handing it something already trimmed would quietly
          // shorten what gets stored.
          history: conversationMessages() as Parameters<typeof runAgent>[0]["history"],
          selection: req.selection,
          signal: controller.signal,
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
          onTrace: (event) => {
            if (window && !window.isDestroyed()) {
              window.webContents.send(IPC.agentTrace, event);
            }
          },
        });
        // Only now is the user's turn actually in the model's memory --
        // `runAgent` returns past everything that throws, which is what keeps a
        // rolled-back edit from being described to the next turn.
        noteTurn(result.messages, result.remembered);
        const summary = {
          removed: [...result.summary.removed],
          added: [...result.summary.added],
          changed: result.summary.changed,
        };
        const chat = appendEntry({
          role: "agent",
          // A model can answer with tool calls and no closing text, and an empty
          // bubble reads as a failure. Main's own wording, like every other
          // message it produces, and so not translated.
          text: result.text.trim() === "" ? "Done." : result.text,
          steps: [...result.steps],
          changed: result.changed,
          summary,
          trace: result.trace,
          undoLabel: result.undoLabel,
          undoTransactionId: result.undoTransactionId,
        });
        // Both halves are one record, so this is one write. Not awaited: the
        // answer is ready and the user should have it now, and a conversation
        // that fails to reach disk is not worth stalling the reply for.
        void saveConversation();
        return {
          ok: true,
          text: result.text,
          changed: result.changed,
          steps: [...result.steps],
          state: shellState(session),
          remembered: result.remembered,
          summary,
          undoLabel: result.undoLabel,
          undoTransactionId: result.undoTransactionId,
          chat,
        };
      } catch (err) {
        if (err instanceof AgentCancelledError) {
          // The document rolled back with the transaction, so there is nothing
          // to clean up here — only something to say. The user's turn stays in
          // the log without being marked remembered, which is the truth: it
          // never reached the model's memory.
          const stopped = "Stopped. Nothing was changed.";
          return {
            ok: false,
            kind: "cancelled",
            message: stopped,
            chat: appendEntry({ role: "note", text: stopped }),
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        // `runAgent` wraps everything as an LlmError, so the prefix is the
        // signal — same convention `classifyGenerateError` uses.
        return {
          ok: false,
          kind: message.startsWith("LLM API Error") ? "llm-error" : "io-error",
          message,
          chat: appendEntry({ role: "error", text: message }),
        };
      } finally {
        inFlightAgentRuns.delete(req.requestId);
      }
    },
  );

  ipcMain.handle(IPC.docAgentCancel, async (_event, requestId: string): Promise<boolean> => {
    const controller = inFlightAgentRuns.get(requestId);
    if (!controller) {
      // Already finished, or never started. Not an error: the button and the
      // run settling race by nature, and pressing Stop a moment too late
      // should not produce a message.
      return false;
    }
    controller.abort();
    return true;
  });

  ipcMain.handle(IPC.chatState, async (): Promise<ChatState> => conversationState());

  ipcMain.handle(IPC.chatList, async (): Promise<ConversationList> => await listConversations());

  ipcMain.handle(
    IPC.chatOpen,
    async (_event, id: string): Promise<ChatState> => await openConversation(id),
  );

  ipcMain.handle(IPC.chatNew, async (): Promise<ChatState> => await newConversation());

  ipcMain.handle(
    IPC.chatDelete,
    async (_event, id: string): Promise<ChatState> => await deleteConversation(id),
  );

  ipcMain.handle(
    IPC.chatRestore,
    async (_event, entryIndex: number): Promise<RestoreResponse> => {
      const id = checkpointAt(entryIndex);
      if (id === null) {
        return { ok: false, kind: "invalid-input", message: "That turn has no saved snapshot." };
      }
      if (!(await checkpointExists(id))) {
        return {
          ok: false,
          kind: "io-error",
          message: "That snapshot is no longer on disk. Older ones are cleared as room is needed.",
        };
      }

      let session;
      try {
        session = requireSession();
      } catch (err) {
        return failure(err);
      }

      /*
       * The way back, taken before anything moves. Restoring cannot be undone
       * -- `adoptDocument` starts a fresh history -- so the only route forward
       * again is a snapshot of where we are now, carried on the note left in
       * the conversation being archived. That makes this a fork, not a door
       * that locks behind you.
       */
      const undoneEdits = session.history.undoStack.length;
      const back = await takeCheckpoint(session, conversationMessages());

      const restored = await readCheckpoint(id, session.doc.filePath);
      if (restored === null) {
        return { ok: false, kind: "io-error", message: "That snapshot could not be read." };
      }

      adoptDocument(restored.session.doc, restored.session.history);
      // The memo describes a document that is no longer the open one.
      forgetCheckpointMemo();

      const chat = await forkAt(
        entryIndex,
        {
          role: "note",
          text: "Went back to an earlier version. This conversation was kept.",
          ...(back === null ? {} : { checkpoint: back }),
        },
        restored.messages,
      );
      await saveConversation();

      return { ok: true, state: shellState(requireSession()), chat, undoneEdits };
    },
  );

  ipcMain.handle(IPC.docAgentReset, async (): Promise<void> => {
    /*
     * Kept, not discarded. "New chat" means the next question starts fresh; the
     * one before it stays in the list and can be returned to from the picker.
     */
    await newConversation();
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
        biomeColor: req.settings.biomeColor,
        showMarkers: req.settings.showMarkers,
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
        mesh: outcome.mesh,
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
