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
  type ChatState,
  type ConversationList,
  type Failure,
  type FailureKind,
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
  type RecentDocument,
  type RecoveryPeekResponse,
  type SaveRequest,
  type SaveResponse,
  type ClipboardResponse,
  type PasteRequest,
  type RegionSpec,
  type SetNbtRequest,
  type TransformRequest,
} from "../../shared/ipc.js";
import {
  providerRequiresApiKey,
  type KeyStorageStatus,
  type PreviewSettings,
  type Provider,
  type Settings,
} from "../../shared/settings.js";
import {
  adoptDocument,
  applyEdit,
  closeDocument,
  copySelection,
  currentSession,
  cutSelection,
  documentMesh,
  documentState,
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
import { UnrepresentableBlocksError } from "../services/writers.js";
import { AgentCancelledError, runAgent } from "../agent/agent.js";
import {
  adoptSubject,
  appendEntry,
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
  autosaveDir,
  conversationsDir,
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

function emitProgress(window: BrowserWindow | null, event: ProgressEvent): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(IPC.progress, event);
  }
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
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
  ipcMain.handle(
    IPC.blocksList,
    async (): Promise<string[]> => [...(await loadAllowedBlocks(resourcesDir()))].sort(),
  );

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
    const settle = (response: GenerateResponse): GenerateResponse => {
      if (req.viaChat !== true) return response;
      appendEntry(
        response.ok
          ? { role: "agent", text: `Built ${response.name}.${response.exportType}.` }
          : { role: "error", text: response.message },
      );
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
      return settle({ ok: true, ...outcome });
    } catch (err) {
      return settle({ ok: false, ...classifyGenerateError(err) });
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
      /*
       * Not an unconditional reset. A chat that built this file with nothing
       * open is *about* it, and this is the moment it gets opened -- clearing
       * here is what used to erase the question and leave only the answer.
       * Opening some other file is still a change of subject and still clears.
       */
      await adoptSubject(filePath);
      return { ok: true, state: documentState(session) };
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
    async (
      _event,
      size: { width: number; height: number; length: number },
    ): Promise<DocumentStateResponse> => {
      try {
        const state = documentState(newDocument(size));
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
  });

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
      return { ok: true, changed, state: documentState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(IPC.docTransform, async (_event, request: TransformRequest): Promise<EditResponse> => {
    try {
      const session = requireSession();
      const changed = transformRegion(session, request.region, request.transform);
      return { ok: true, changed, state: documentState(session) };
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
      return { ok: true, clipboard: clipboardInfo(copySelection(session, region)), state: documentState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(IPC.docCut, async (_event, region: RegionSpec): Promise<ClipboardResponse> => {
    try {
      const session = requireSession();
      return { ok: true, clipboard: clipboardInfo(cutSelection(session, region)), state: documentState(session) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(IPC.docPaste, async (_event, request: PasteRequest): Promise<EditResponse> => {
    try {
      const session = requireSession();
      const changed = pasteSelection(session, request, { includeAir: request.includeAir });
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
      /*
       * A conversation started with nothing open has no key to be stored under
       * -- this is the moment it gets one. A *Save As* onto a different path is
       * the same call and does the same thing: the conversation follows the
       * document to where the document went.
       */
      await adoptSubject(result.filePath);
      return {
        ok: true,
        filePath: result.filePath,
        format: result.format,
        degraded: [...result.degraded],
        cropped: result.cropped,
        state: documentState(session),
      };
    } catch (err) {
      return failure(err);
    }
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
        return { ok: true, state: documentState(requireSession()) };
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
        const result = await runAgent({
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
          undoLabel: result.undoLabel,
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
          state: documentState(session),
          remembered: result.remembered,
          summary,
          undoLabel: result.undoLabel,
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
