<script lang="ts">
  /**
   * Port of `BuilderGPTComponent.render` (component.py:231-417) plus
   * `run_app.py`'s page setup.
   *
   * What Streamlit's rerun loop did implicitly, this does explicitly:
   * `st.session_state["bgpt_last_schem_path"]` becomes `lastSchemPath`,
   * `st.progress` becomes the `bgpt:progress` subscription, and `st.error` /
   * `st.warning` / `st.success` become one `status` banner. The
   * `_initialized`/`_instance` singleton guard from component.py:35-42 has no
   * counterpart and is deliberately dropped -- it existed only to survive the
   * module being re-executed on every interaction (ARCHITECTURE.md §4 change 2).
   */
  import { onMount } from "svelte";

  import ArtifactList from "./lib/ArtifactList.svelte";
  import ChatPanel, { type ChatEntry } from "./lib/ChatPanel.svelte";
  import CommandPalette, { type Command } from "./lib/CommandPalette.svelte";
  import DocumentPanel from "./lib/DocumentPanel.svelte";
  import InspectorPanel from "./lib/InspectorPanel.svelte";
  import SettingsModal from "./lib/SettingsModal.svelte";
  import SelectionTools from "./lib/SelectionTools.svelte";
  import SidebarTabs, { type SidebarTab } from "./lib/SidebarTabs.svelte";
  import ToolWindow from "./lib/ToolWindow.svelte";
  import { findOpenCodeModel, loadOpenCodeModels } from "./lib/models.svelte.js";
  import SidebarSplitter from "./lib/SidebarSplitter.svelte";
  import Viewer, { type CameraMode, type PickedBlock } from "./lib/Viewer.svelte";
  import { api, bridgeAvailable, forIpc, bridgeMissingMessage } from "./lib/bridge.svelte.js";
  import { t, tn, setLocale } from "./lib/i18n.svelte.js";
  import {
    openCodeModelRequiresKey,
    type AgentStepEvent,
    type Artifact,
    type BlockInspection,
    type DocumentState,
    type EditResponse,
    type OpenCodeModelInfo,
    type ProgressEvent,
    type RecoveryOffer,
    type ClipboardInfo,
    type MeshPayload,
    type RegionSpec,
    type TransformRequest,
  } from "../../shared/ipc.js";
  import type { SchematicFormat } from "../../shared/schematic.js";
  import {
    DEFAULT_SETTINGS,
    DEFAULT_UI_SETTINGS,
    providerRequiresApiKey,
    type ExportType,
    type KeyStorageStatus,
    type PreviewSettings,
    type Provider,
    type ResolvedTheme,
    type Settings,
  } from "../../shared/settings.js";

  type Status = { tone: "info" | "ok" | "warn" | "error"; text: string; detail?: string } | null;

  let settings = $state<Settings>({ ...DEFAULT_SETTINGS });

  /**
   * Sidebar geometry is mirrored locally so a drag repaints at pointer speed;
   * `settings.ui` is only written when the gesture ends. Persisting per
   * pointermove would be a disk write per frame.
   */
  let sidebarWidth = $state(DEFAULT_UI_SETTINGS.sidebarWidth);
  let sidebarCollapsed = $state(DEFAULT_UI_SETTINGS.sidebarCollapsed);
  let keyStatus = $state<KeyStorageStatus | null>(null);
  let versions = $state<string[]>([]);
  let artifacts = $state<Artifact[]>([]);
  /** What an empty `settings.outputDir` resolves to, shown as the placeholder. */
  let defaultOutputDir = $state("");

  let description = $state("");
  let imagePath = $state<string | null>(null);
  let imageName = $state<string | null>(null);
  let resourcePackPath = $state<string | null>(null);
  let resourcePackName = $state<string | null>(null);

  /** component.py:281-282's `st.session_state["bgpt_last_schem_path"]`. */
  let lastSchemPath = $state<string | null>(null);

  let busy = $state(false);
  let progress = $state<ProgressEvent | null>(null);
  let status = $state<Status>(null);

  /**
   * Whether the OS is asking for a dark window right now.
   *
   * Only consulted when the theme setting is `"system"`, but tracked
   * unconditionally: the listener is one line and the alternative is
   * subscribing and unsubscribing as the setting changes, for no gain.
   */
  let systemDark = $state(true);

  /**
   * The theme with `"system"` resolved -- what is actually on screen.
   *
   * Anything that has to *draw* a colour needs this rather than the setting:
   * "system" names where to look, not what to paint.
   */
  const resolvedTheme = $derived<ResolvedTheme>(
    settings.ui.theme === "system" ? (systemDark ? "dark" : "light") : settings.ui.theme,
  );

  let mesh = $state<MeshPayload | null>(null);
  let bounds = $state<{ center: number[]; size: number[] } | null>(null);
  /**
   * The sun's direction, in radians, straight from the two sliders.
   *
   * These used to be `$state` initialised to zero and written only by whatever
   * came back from a preview or a mesh rebuild. Since neither of the sun
   * settings rebuilds anything, `patchPreview` returned early and no round trip
   * ever happened -- so moving the sliders persisted the numbers and changed
   * nothing on screen until some unrelated action happened to refresh the mesh.
   * The viewer's effect was ready the whole time; the props feeding it never
   * moved.
   *
   * Derived from the settings instead, using the same degrees-to-radians the
   * main process applies in `sunAnglesRadians`. `PreviewSuccess` still carries
   * the angles and nothing reads them now; they are the main process's answer
   * to a question the renderer can answer itself.
   */
  const sunAzimuth = $derived((settings.preview.sunAzimuthDeg * Math.PI) / 180);
  const sunElevation = $derived((settings.preview.sunElevationDeg * Math.PI) / 180);

  /**
   * The open document, as main last described it. The renderer holds no
   * schematic of its own -- every edit is a request, and this is the summary
   * that comes back.
   */
  let docState = $state<DocumentState | null>(null);
  let selection = $state<RegionSpec | null>(null);
  /** The first corner of a selection being built, before Shift-click extends it. */
  let anchor = $state<{ x: number; y: number; z: number } | null>(null);

  /** The last block clicked, and where — the inspector's subject. */
  let inspection = $state<BlockInspection | null>(null);
  let inspectedAt = $state<{ x: number; y: number; z: number } | null>(null);

  /**
   * Not persisted, deliberately: launching into flight with the pointer not yet
   * captured is a confusing place to start, and the mode is one click away.
   */
  let cameraMode = $state<CameraMode>("orbit");

  /**
   * The block Fill writes and the one Creative mode places. Held here rather
   * than in the panel because the viewport places it too, and one of them
   * having a different idea of "the current block" would be a bug nobody could
   * see.
   */
  let activeBlock = $state("minecraft:stone");

  /** The registry, for the block pickers to search — fetched once at startup. */
  let blockRegistry = $state<string[]>([]);

  /** Recently opened schematics. Owned by main; re-read after every open. */
  let recentDocuments = $state<string[]>([]);

  /**
   * What main's clipboard holds, as it last reported.
   *
   * Mirrored rather than asked for: the clipboard lives in main and outlives
   * the document, so the renderer only needs enough to enable Paste and say how
   * big the thing is. It starts null because at launch it genuinely is.
   */
  let clipboard = $state<ClipboardInfo | null>(null);

  /**
   * Bumped when the viewport starts showing a *different* structure, and only
   * then. The viewer frames the camera on a change and leaves it alone
   * otherwise, so an edit — or an undo — no longer throws the view back to
   * where it started.
   *
   * A counter rather than the file path: a path is `null` for a document that
   * has never been saved, and Save As changes it without changing what is on
   * screen.
   */
  let framingEpoch = $state(0);

  /**
   * Building from the crosshair. One block, one transaction — the same edit the
   * panel makes, so Ctrl+Z treats them alike.
   */
  async function onBuild(
    action: "place" | "break",
    at: { x: number; y: number; z: number },
  ): Promise<void> {
    if (busy) return;
    const block =
      action === "break" ? { namespacedName: "minecraft:air" } : parseBlock(activeBlock);
    await runDocument(action === "break" ? t("task.breakingBlock") : t("task.placingBlock"), () =>
      api().applyEdit({ kind: "setBlock", x: at.x, y: at.y, z: at.z, block }),
    );
  }

  let chat = $state<ChatEntry[]>([]);
  /** Tool calls for the turn in flight, so the panel narrates rather than hangs. */
  let liveSteps = $state<AgentStepEvent[]>([]);
  /**
   * How many exchanges the agent is carrying, as main last reported. The
   * transcript itself lives there — this is only enough to tell the user
   * whether "make it taller" will be understood.
   */
  let remembered = $state(0);

  /** The agent request in flight, if any — what Stop cancels. */
  let agentRequestId = $state<string | null>(null);

  /**
   * Asks main to stop the run.
   *
   * Deliberately does not touch `chat` or `busy`: the request is still in
   * flight and will settle through `askAgent` as a `cancelled` failure, which
   * is the one place that should report what happened. Ending the turn from
   * here as well would write the outcome twice.
   */
  async function stopAgent(): Promise<void> {
    const id = agentRequestId;
    if (id === null) return;
    await api().cancelAgent(id);
  }

  /**
   * Throws away the visible log *and* the transcript behind it.
   *
   * Both, always: main forgets the conversation whenever the open document
   * changes, and a log left on screen after that would show the user exchanges
   * the agent can no longer refer to.
   */
  async function forgetConversation(): Promise<void> {
    chat = [];
    liveSteps = [];
    remembered = 0;
    if (bridgeAvailable) {
      await api().resetAgentConversation();
    }
  }

  /** Unsaved work found from a session that ended badly. */
  let recovery = $state<RecoveryOffer | null>(null);

  /** A schematic is being dragged over the viewport. */
  let dropActive = $state(false);
  /**
   * `dragenter`/`dragleave` fire for every child element the pointer crosses,
   * so a plain boolean flickers off as soon as the cursor moves onto the
   * canvas. Counting enters against leaves is the usual fix.
   */
  let dragDepth = 0;

  const SCHEMATIC_EXTENSIONS = [".schem", ".schematic"];

  function isSchematicPath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return SCHEMATIC_EXTENSIONS.some((extension) => lower.endsWith(extension));
  }

  function onDragEnter(event: DragEvent): void {
    if (!bridgeAvailable) return;
    // The dragged file's *name* is not readable during a drag — only its type,
    // for privacy — so the highlight cannot promise the file is supported. It
    // says "you can drop here"; the drop itself says whether it worked.
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dragDepth += 1;
    dropActive = true;
  }

  function onDragOver(event: DragEvent): void {
    if (!dropActive) return;
    // Without this the browser refuses the drop and shows a "no entry" cursor.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  }

  function onDragLeave(): void {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropActive = false;
    }
  }

  async function onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    dragDepth = 0;
    dropActive = false;

    const file = event.dataTransfer?.files?.[0];
    if (!file) return;

    const filePath = api().pathForDroppedFile(file);
    if (!filePath) {
      status = { tone: "warn", text: t("status.notOnDisk", { name: file.name }) };
      return;
    }
    if (!isSchematicPath(filePath)) {
      status = {
        tone: "warn",
        text: t("status.notASchematic", { name: file.name }),
      };
      return;
    }
    await openDocumentAt(filePath);
  }

  async function resolveRecovery(restore: boolean): Promise<void> {
    const offer = recovery;
    // Dismissed first: whichever way this goes, the prompt is answered, and
    // leaving it up while the restore runs invites a second click.
    recovery = null;
    busy = true;
    try {
      const response = await api().resolveRecovery(restore);
      if (!response.ok) {
        status = { tone: "error", text: response.message };
        return;
      }
      docState = response.state;
      if (restore && response.state) {
        // Recovered work is a structure the camera has not seen either.
        framingEpoch += 1;
        // ...and a session whose conversation did not survive the crash.
        chat = [];
        liveSteps = [];
        remembered = 0;
        await refreshDocument();
        status = {
          tone: "ok",
          text: offer?.fileName
            ? t("status.recoveredNamed", { name: offer.fileName })
            : t("status.recovered"),
          detail: t("recovery.notOnDisk"),
        };
      }
    } catch (err) {
      failed(err, t("task.recovering"));
    } finally {
      busy = false;
    }
  }

  /**
   * The OpenCode model in use, when there is one. Everything below is UI
   * mirroring: `ipc/handlers.ts` applies the same two rules authoritatively,
   * because a renderer check is a courtesy, not a gate.
   */
  /**
   * The catalogue entry for the chosen model, when there is a catalogue.
   *
   * Used to gate the reference-image picker on whether the model reads
   * pictures. It used to be pushed up from `ProviderConfig` through an
   * `onmodelinfo` callback; now that the model picker lives in the chat and the
   * catalogue is shared, both readers derive it from the same place.
   */
  const openCodeModel = $derived<OpenCodeModelInfo | null>(
    findOpenCodeModel(settings.provider, settings.model),
  );

  const hasProviderKey = $derived(
    keyStatus?.keys.find((entry) => entry.provider === settings.provider)?.hasKey ?? false,
  );
  const blockedOnKey = $derived(
    settings.provider === "OpenCode"
      ? openCodeModelRequiresKey(openCodeModel ?? undefined) && !hasProviderKey
      : providerRequiresApiKey(settings.provider) && !hasProviderKey,
  );
  /** Text-only models: the picker is disabled rather than silently ignored. */
  const acceptsImages = $derived(openCodeModel === null || openCodeModel.imageInput !== "no");

  const canGenerate = $derived(description.trim() !== "" && !busy && !blockedOnKey);
  /**
   * Re-render rebuilds a *file* preview. With a document open the document owns
   * the viewport — painting a file into it would show something the next edit
   * would silently replace.
   */
  const canRerender = $derived(lastSchemPath !== null && docState === null && !busy);

  /**
   * Puts the chosen palette on `<html>`, where `app.css` can see it.
   *
   * `"system"` *removes* the attribute rather than setting a third value,
   * because there is no third palette: it hands the decision to the
   * `prefers-color-scheme` rule, which is the only thing that knows the answer.
   *
   * `$effect.pre` rather than `$effect`, and that is load-bearing. `Viewer`
   * reads these same custom properties back out with `getComputedStyle` to
   * colour the 3D scene, which CSS cannot reach. Pre-effects all flush before
   * regular ones, so the attribute is guaranteed to be in place before the
   * viewer looks; as a plain effect the two would race and the viewport would
   * trail the window by one theme change.
   */
  $effect.pre(() => {
    const root = document.documentElement;
    if (settings.ui.theme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", settings.ui.theme);
    }
  });

  /**
   * Puts the chosen language into force.
   *
   * `setLocale` writes the `$state` every `t()` reads, so this re-renders every
   * string in the window rather than needing a reload. `lang` goes on `<html>`
   * beside it for the things CSS and the OS read rather than us: hyphenation,
   * spellcheck dictionaries, and what a screen reader pronounces.
   */
  $effect.pre(() => {
    setLocale(settings.ui.language);
    document.documentElement.setAttribute("lang", settings.ui.language);
  });

  onMount(() => {
    // Registered before the bridge check on purpose: collapsing the panel is
    // pure UI, and a window whose preload failed to load is exactly the one
    // where reaching the whole viewport still matters.
    window.addEventListener("keydown", onWindowKey);

    // The OS preference is a live thing -- a desktop on a sunset schedule
    // changes it under a running window -- so it is watched, not sampled once.
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    systemDark = dark.matches;
    const onSystemTheme = (event: MediaQueryListEvent) => (systemDark = event.matches);
    dark.addEventListener("change", onSystemTheme);

    if (!bridgeAvailable) {
      status = { tone: "error", text: bridgeMissingMessage() };
      return () => {
        window.removeEventListener("keydown", onWindowKey);
        dark.removeEventListener("change", onSystemTheme);
      };
    }

    void (async () => {
      settings = await api().getSettings();
      sidebarWidth = settings.ui.sidebarWidth;
      sidebarCollapsed = settings.ui.sidebarCollapsed;
      toolWindowX = settings.ui.toolWindowX;
      toolWindowY = settings.ui.toolWindowY;
      keyStatus = await api().getKeyStatus();
      versions = await api().listVersions();
      artifacts = await api().listArtifacts();
      defaultOutputDir = await api().getDefaultOutputDir();
      blockRegistry = await api().listBlocks();
      recentDocuments = await api().listRecentDocuments();

      // Asked once, at startup, before the user has done anything they could
      // lose by answering it.
      const found = await api().peekRecovery();
      if (found.ok) {
        recovery = found.recovery;
      }
    })();

    const unsubscribe = api().onProgress((event) => {
      progress = event.phase === "done" ? null : event;
    });
    const unsubscribeSteps = api().onAgentStep((event) => {
      liveSteps = [...liveSteps, event];
    });
    return () => {
      window.removeEventListener("keydown", onWindowKey);
      dark.removeEventListener("change", onSystemTheme);
      unsubscribe();
      unsubscribeSteps();
    };
  });

  function onWindowKey(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }
    const key = event.key.toLowerCase();
    // Ctrl+K and Ctrl+Shift+P, the two everyone reaches for. Handled before the
    // "is a document open" gate below, because the palette is also how you open
    // one — and toggling, so the same keystroke closes it again.
    if (key === "k" || (key === "p" && event.shiftKey)) {
      event.preventDefault();
      togglePalette();
      return;
    }
    // Anything else typed into the palette belongs to the palette.
    if (paletteOpen) {
      return;
    }
    if (key === "b") {
      event.preventDefault();
      toggleSidebar();
      return;
    }
    // Ctrl+, is what every editor binds settings to.
    if (event.key === ",") {
      event.preventDefault();
      settingsOpen = !settingsOpen;
      return;
    }
    // The document shortcuts only exist while a document does, and never while
    // something else is already running -- an undo racing an edit would apply
    // to a state neither of them saw.
    if (docState === null || busy) {
      return;
    }
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      void runDocument(t("task.undoing"), () => api().undo());
    } else if (key === "y" || (key === "z" && event.shiftKey)) {
      event.preventDefault();
      void runDocument(t("task.redoing"), () => api().redo());
    } else if (key === "s") {
      event.preventDefault();
      // Nowhere to save to yet means Save As, which is what every editor does.
      void (docState.filePath === null ? saveDocumentAs() : saveDocument());
    }
  }

  let paletteOpen = $state(false);
  let settingsOpen = $state(false);
  let sidebarTab = $state<SidebarTab>("chat");
  /**
   * The half-written chat message.
   *
   * Up here rather than in the composer because switching sidebar tabs
   * unmounts it, and losing a half-typed question to a glance at the Schematic
   * tab is exactly the kind of thing tabs make easy to do by accident.
   */
  let chatDraft = $state("");

  /**
   * Whether the floating tool window is showing.
   *
   * Not persisted, and closing it is not permanent: it comes back with the next
   * selection. A tool palette you can dismiss for good is one a user can lose,
   * and the command palette is a poor place to have to go looking for it.
   */
  let toolsOpen = $state(true);

  /** Mirrored locally so a drag repaints at pointer speed, like the sidebar. */
  let toolWindowX = $state(DEFAULT_UI_SETTINGS.toolWindowX);
  let toolWindowY = $state(DEFAULT_UI_SETTINGS.toolWindowY);

  /**
   * Fetches OpenCode's model list when the provider calls for it.
   *
   * Lives here rather than in the picker because the answer can rewrite
   * `settings.model` -- when the stored model is not in the list, the port's
   * behaviour (component.py:251-255) is to fall back to `mimo-v2.5-free` -- and
   * the settings belong to this component.
   */
  $effect(() => {
    loadOpenCodeModels(settings.provider, settings.model, (model) => {
      void patchSettings({ model });
    });
  });

  function togglePalette(): void {
    const next = !paletteOpen;
    // Creative mode holds the pointer, and a locked pointer means the keys the
    // user is about to type are also steering the camera. Releasing it is what
    // makes the palette usable from flight rather than a way to fly into a wall.
    if (next && document.pointerLockElement) {
      document.exitPointerLock();
    }
    paletteOpen = next;
  }

  /**
   * Everything the app can do, by name.
   *
   * Built here rather than inside the palette so each entry calls the same
   * function its button does — the palette cannot offer an action the UI has
   * stopped having, and `enabled` is derived from the same state that greys the
   * buttons out.
   */
  const commands = $derived<Command[]>([
    {
      id: "open",
      title: t("command.open"),
      group: t("group.file"),
      keywords: t("command.open.keywords"),
      enabled: !busy,
      run: () => void openDocument(),
    },
    ...recentDocuments.slice(0, 5).map((filePath) => ({
      id: `recent:${filePath}`,
      title: t("command.openRecent", { name: filePath.split(/[\\/]/).pop() ?? filePath }),
      group: t("group.recent"),
      keywords: filePath,
      enabled: !busy,
      run: () => void openDocumentAt(filePath),
    })),
    {
      id: "save",
      title: t("command.save"),
      group: t("group.file"),
      shortcut: "Ctrl+S",
      enabled: !busy && docState !== null,
      run: () => void (docState?.filePath === null ? saveDocumentAs() : saveDocument()),
    },
    {
      id: "save-as",
      title: t("command.saveAs"),
      group: t("group.file"),
      keywords: t("command.saveAs.keywords"),
      enabled: !busy && docState !== null,
      run: () => void saveDocumentAs(),
    },
    {
      id: "undo",
      title: t("command.undo"),
      group: t("group.edit"),
      shortcut: "Ctrl+Z",
      enabled: !busy && docState?.canUndo === true,
      run: () => void runDocument(t("task.undoing"), () => api().undo()),
    },
    {
      id: "redo",
      title: t("command.redo"),
      group: t("group.edit"),
      shortcut: "Ctrl+Y",
      enabled: !busy && docState?.canRedo === true,
      run: () => void runDocument(t("task.redoing"), () => api().redo()),
    },
    {
      id: "select-all",
      title: t("command.selectAll"),
      group: t("group.edit"),
      keywords: t("command.selectAll.keywords"),
      enabled: !busy && docState !== null,
      run: selectAll,
    },
    {
      id: "copy",
      title: t("command.copy"),
      group: t("group.edit"),
      shortcut: "Ctrl+C",
      enabled: !busy && selection !== null,
      run: () => void copySelection(false),
    },
    {
      id: "cut",
      title: t("command.cut"),
      group: t("group.edit"),
      shortcut: "Ctrl+X",
      enabled: !busy && selection !== null,
      run: () => void copySelection(true),
    },
    {
      id: "paste",
      title: t("command.paste"),
      group: t("group.edit"),
      shortcut: "Ctrl+V",
      enabled: !busy && clipboard !== null && selection !== null,
      run: pasteHere,
    },
    {
      id: "rotate-90",
      title: t("command.rotate90"),
      group: t("group.edit"),
      keywords: t("command.rotate90.keywords"),
      enabled: !busy && selection !== null,
      run: () => void transformSelection({ kind: "rotate", steps: 1 }),
    },
    {
      id: "rotate-180",
      title: t("command.rotate180"),
      group: t("group.edit"),
      keywords: t("command.rotate180.keywords"),
      enabled: !busy && selection !== null,
      run: () => void transformSelection({ kind: "rotate", steps: 2 }),
    },
    {
      id: "mirror-x",
      title: t("command.mirrorX"),
      group: t("group.edit"),
      keywords: t("command.mirrorX.keywords"),
      enabled: !busy && selection !== null,
      run: () => void transformSelection({ kind: "mirror", axis: "x" }),
    },
    {
      id: "mirror-z",
      title: t("command.mirrorZ"),
      group: t("group.edit"),
      keywords: t("command.mirrorZ.keywords"),
      enabled: !busy && selection !== null,
      run: () => void transformSelection({ kind: "mirror", axis: "z" }),
    },
    {
      id: "clear-selection",
      title: t("command.clearSelection"),
      group: t("group.edit"),
      enabled: !busy && selection !== null,
      run: () => {
        selection = null;
        anchor = null;
      },
    },
    {
      id: "camera-orbit",
      title: t("command.cameraOrbit"),
      group: t("group.view"),
      keywords: t("command.cameraOrbit.keywords"),
      enabled: cameraMode !== "orbit",
      run: () => (cameraMode = "orbit"),
    },
    {
      id: "camera-fly",
      title: t("command.cameraFly"),
      group: t("group.view"),
      keywords: t("command.cameraFly.keywords"),
      enabled: cameraMode !== "fly",
      run: () => (cameraMode = "fly"),
    },
    {
      id: "toggle-grid",
      title: settings.preview.showGrid ? t("command.hideGrid") : t("command.showGrid"),
      group: t("group.view"),
      enabled: true,
      run: () => void patchPreview({ showGrid: !settings.preview.showGrid }),
    },
    {
      id: "toggle-wireframe",
      title: settings.preview.wireframe ? t("command.wireframeOff") : t("command.wireframeOn"),
      group: t("group.view"),
      enabled: true,
      run: () => void patchPreview({ wireframe: !settings.preview.wireframe }),
    },
    {
      id: "toggle-tools",
      title: toolsOpen ? t("command.hideTools") : t("command.showTools"),
      group: t("group.view"),
      keywords: t("command.showTools.keywords"),
      enabled: docState !== null,
      run: () => (toolsOpen = !toolsOpen),
    },
    {
      id: "settings",
      title: t("settings.title"),
      group: t("group.view"),
      keywords: t("settings.keywords"),
      shortcut: "Ctrl+,",
      enabled: true,
      run: () => (settingsOpen = true),
    },
    {
      id: "toggle-sidebar",
      title: sidebarCollapsed ? t("sidebar.show") : t("sidebar.hide"),
      group: t("group.view"),
      shortcut: "Ctrl+B",
      enabled: true,
      run: toggleSidebar,
    },
    {
      id: "new-chat",
      title: t("command.newChat"),
      group: t("group.ai"),
      keywords: t("command.newChat.keywords"),
      enabled: !busy && (chat.length > 0 || remembered > 0),
      run: () => void forgetConversation(),
    },
    {
      id: "stop-agent",
      title: t("command.stopAgent"),
      group: t("group.ai"),
      keywords: t("command.stopAgent.keywords"),
      enabled: agentRequestId !== null,
      run: () => void stopAgent(),
    },
  ]);

  function toggleSidebar(): void {
    sidebarCollapsed = !sidebarCollapsed;
    void patchUi({ sidebarCollapsed });
  }

  /**
   * Layout gestures must not depend on the settings write succeeding: the
   * panel has already moved on screen by the time this runs, and a failed
   * persist is worth a banner, not a stuck sidebar.
   */
  async function patchUi(patch: Partial<Settings["ui"]>): Promise<void> {
    try {
      await patchSettings({ ui: { ...settings.ui, ...patch } });
    } catch (err) {
      failed(err, t("task.savingLayout"));
    }
  }

  /** Persist on every change; the Python UI persisted nothing at all. */
  async function patchSettings(patch: Partial<Settings>): Promise<void> {
    settings = await api().setSettings(forIpc({ ...settings, ...patch }));
  }

  async function patchPreview(patch: Partial<PreviewSettings>): Promise<void> {
    await patchSettings({ preview: { ...settings.preview, ...patch } });
    // Every other preview setting is applied by the viewer on the GLB it
    // already has. The two tints are baked into the texture atlas, so they are
    // the ones that need the mesh rebuilt.
    const rebuilds = patch.biomeColor !== undefined || patch.waterColor !== undefined;
    if (!rebuilds || busy) return;
    // Whichever of the two is showing. Before this the tints only ever reached
    // the file-preview path, so changing one with a document open did nothing
    // at all — and it is the one setting pair that cannot be applied by the
    // viewer, because it is multiplied into the atlas.
    if (docState !== null) {
      await refreshDocument();
    } else if (lastSchemPath) {
      await runPreview(lastSchemPath);
    }
  }

  async function saveKey(provider: Provider, apiKey: string): Promise<void> {
    keyStatus = await api().setKey({ provider, apiKey });
  }

  async function clearKey(provider: Provider): Promise<void> {
    keyStatus = await api().clearKey(provider);
  }

  const requestId = () => crypto.randomUUID();

  /**
   * Every `api().*` call below is wrapped. An `ipcRenderer.invoke` that
   * rejects -- a handler that threw before its own try/catch, a payload that
   * failed to structured-clone -- used to surface as an unhandled rejection
   * with `busy` cleared by `finally` and nothing at all shown, which reads as
   * "the button does nothing".
   */
  function failed(err: unknown, doing: string): void {
    // The `doing` prefix is not decoration. An `ipcRenderer.invoke` rejection
    // carries no channel and no argument -- "An object could not be cloned."
    // is the entire message -- so without naming the operation there is
    // nothing to act on.
    const message = err instanceof Error ? err.message : String(err);
    status = { tone: "error", text: t("status.failed", { doing, message }) };
  }

  async function pick(kind: "image" | "resource-pack" | "directory"): Promise<void> {
    let picked: Awaited<ReturnType<ReturnType<typeof api>["pickFile"]>>;
    try {
      picked = await api().pickFile({ kind });
    } catch (err) {
      failed(err, t("task.openingPicker"));
      return;
    }
    if (picked.error) {
      // A rejected choice, not a cancellation — say so rather than looking
      // like the dialog did nothing.
      status = { tone: "error", text: picked.error };
      return;
    }
    if (!picked.path) return;
    if (kind === "image") {
      imagePath = picked.path;
      imageName = picked.name;
    } else if (kind === "resource-pack") {
      resourcePackPath = picked.path;
      resourcePackName = picked.name;
    } else if (kind === "directory") {
      void patchSettings({ outputDir: picked.path });
    }
  }

  async function renderPreview(schemPath: string): Promise<void> {
    let response: Awaited<ReturnType<ReturnType<typeof api>["preview"]>>;
    try {
      response = await api().preview({
        requestId: requestId(),
        schemPath,
        resourcePackPath,
        settings: forIpc(settings.preview),
      });
    } catch (err) {
      failed(err, t("task.rendering"));
      return;
    }
    if (!response.ok) {
      // component.py:456 used st.warning, not st.error: a failed preview never
      // invalidates the generated file.
      status = { tone: "warn", text: response.message };
      return;
    }
    // A different file is a different structure and gets framed; re-rendering
    // the same one — which is what changing a biome tint does — must not move
    // a camera the user has placed.
    if (schemPath !== lastSchemPath) {
      framingEpoch += 1;
    }
    mesh = response.mesh;
    bounds = { center: response.center, size: response.size };
    lastSchemPath = schemPath;
  }

  async function runPreview(schemPath: string): Promise<void> {
    busy = true;
    try {
      await renderPreview(schemPath);
    } finally {
      busy = false;
    }
  }

  // --- the open document ----------------------------------------------------

  /**
   * Redraws from whatever main last said.
   *
   * The mesh is fetched separately from the state because it is the expensive
   * half: main serves it from cache whenever `revision` has not moved, so
   * calling this after every edit costs nothing when nothing changed.
   */
  async function refreshDocument(): Promise<void> {
    if (docState === null) {
      mesh = null;
      bounds = null;
      return;
    }
    const response = await api().getDocumentMesh(forIpc(settings.preview));
    if (!response.ok) {
      status = { tone: "warn", text: response.message };
      return;
    }
    mesh = response.mesh;
    bounds = { center: response.center, size: response.size };
  }

  /**
   * Every document call funnels through here so failures cannot go unreported.
   * Returns how many blocks changed, or `null` if the call did not succeed.
   */
  async function runDocument(
    doing: string,
    call: () => Promise<EditResponse>,
  ): Promise<number | null> {
    busy = true;
    try {
      const response = await call();
      if (!response.ok) {
        status = { tone: "warn", text: response.message };
        return null;
      }
      docState = response.state;
      await refreshDocument();
      // The inspected block may well have been one of the ones that changed --
      // a fill over it, or an undo of the edit that made it. Showing what it
      // used to be is worse than showing nothing.
      if (inspectedAt) {
        await inspectBlock(inspectedAt.x, inspectedAt.y, inspectedAt.z);
      }
      return response.changed;
    } catch (err) {
      failed(err, doing);
      return null;
    } finally {
      busy = false;
    }
  }

  async function openDocument(): Promise<void> {
    let picked: Awaited<ReturnType<ReturnType<typeof api>["pickFile"]>>;
    try {
      picked = await api().pickFile({ kind: "schem" });
    } catch (err) {
      failed(err, t("task.openingChooser"));
      return;
    }
    if (picked.error) {
      status = { tone: "error", text: picked.error };
      return;
    }
    if (!picked.path) return;
    await openDocumentAt(picked.path);
  }

  /** Opens a schematic by path — from the picker, or from a drop. */
  async function openDocumentAt(filePath: string): Promise<void> {
    busy = true;
    try {
      const response = await api().openDocument(filePath);
      // Re-read either way: main adds the file on success and drops it on
      // failure, so a stale entry for a schematic that has moved disappears the
      // moment it is clicked rather than sitting there failing forever.
      recentDocuments = await api().listRecentDocuments();
      if (!response.ok) {
        status = { tone: "error", text: response.message };
        return;
      }
      docState = response.state;
      selection = null;
      anchor = null;
      inspection = null;
      inspectedAt = null;
      status = null;
      // A conversation is about a schematic. Opening another one makes every
      // "it" in the log refer to something that is no longer on screen, and
      // main has already dropped its side with the old session.
      chat = [];
      liveSteps = [];
      remembered = 0;
      // A newly opened document is the one case where framing the camera is
      // what the user wants: they have not aimed it at anything yet.
      framingEpoch += 1;
      await refreshDocument();
    } catch (err) {
      failed(err, t("task.opening"));
    } finally {
      busy = false;
    }
  }

  /**
   * A click sets the anchor and selects that one block; Shift-click grows the
   * box to include it. Two corners is the whole gesture -- it is what a region
   * *is*, and it does not fight the orbit controls for the drag.
   */
  /** Fetches what the clicked block is, for the inspector. */
  async function inspectBlock(x: number, y: number, z: number): Promise<void> {
    inspectedAt = { x, y, z };
    try {
      const response = await api().inspectBlock(x, y, z);
      inspection = response.ok ? response : null;
    } catch {
      // A failed inspection is not worth a banner — the panel simply stays
      // empty, and the click still moved the selection, which is the part the
      // user was asking for.
      inspection = null;
    }
  }

  function onPick(block: PickedBlock | null): void {
    if (block === null) {
      // Clicked past the structure. That is the gesture for "never mind" —
      // it drops the selection and empties the inspector.
      selection = null;
      anchor = null;
      inspection = null;
      inspectedAt = null;
      return;
    }
    void inspectBlock(block.x, block.y, block.z);
    // Selecting something is the gesture that wants the tools. Closing the
    // panel is therefore "not now" rather than "never" -- which is what keeps
    // it from being a thing a user can lose.
    toolsOpen = true;
    if (block.extend && anchor !== null) {
      selection = {
        minX: Math.min(anchor.x, block.x),
        minY: Math.min(anchor.y, block.y),
        minZ: Math.min(anchor.z, block.z),
        maxX: Math.max(anchor.x, block.x),
        maxY: Math.max(anchor.y, block.y),
        maxZ: Math.max(anchor.z, block.z),
      };
      return;
    }
    anchor = { x: block.x, y: block.y, z: block.z };
    selection = {
      minX: block.x,
      minY: block.y,
      minZ: block.z,
      maxX: block.x,
      maxY: block.y,
      maxZ: block.z,
    };
  }

  /**
   * A face of the selection box was dragged in the viewport.
   *
   * The region arrives already snapped to whole blocks and clamped to the
   * document, so there is nothing to validate here. The anchor moves to the
   * box's near corner so a following Shift-click extends from where the box now
   * is rather than from wherever it was first clicked — otherwise resizing a
   * selection and then extending it would jump somewhere unrelated.
   */
  function onSelectionDragged(region: RegionSpec): void {
    selection = region;
    anchor = { x: region.minX, y: region.minY, z: region.minZ };
  }

  function selectAll(): void {
    if (!docState) return;
    toolsOpen = true;
    anchor = { x: 0, y: 0, z: 0 };
    selection = {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: docState.size[0] - 1,
      maxY: docState.size[1] - 1,
      maxZ: docState.size[2] - 1,
    };
  }

  function parseBlock(text: string): { namespacedName: string; properties?: Record<string, string> } {
    const trimmed = text.trim();
    const name = trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`;
    const bracket = name.indexOf("[");
    if (bracket === -1) {
      return { namespacedName: name };
    }
    // `oak_stairs[facing=north]` typed by hand: the same spelling the palette
    // list shows, so a material can be copied straight back into the field.
    const properties: Record<string, string> = {};
    for (const part of name.slice(bracket + 1).replace(/\]$/, "").split(",")) {
      const eq = part.indexOf("=");
      if (eq > 0) properties[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return { namespacedName: name.slice(0, bracket), properties };
  }

  /**
   * Rewrites one of the inspected block's states.
   *
   * There is no "change a property" operation in the domain, and there should
   * not be: a block plus its states *is* the block, so this places the same
   * block again with one state different. That makes it an ordinary edit, on
   * the ordinary undo stack.
   */
  async function changeBlockProperty(name: string, value: string): Promise<void> {
    if (!inspection || !inspectedAt) return;
    const at = inspectedAt;
    const properties = { ...inspection.properties, [name]: value.trim() };
    await runDocument(t("task.changingBlockState"), () =>
      api().applyEdit({
        kind: "setBlock",
        x: at.x,
        y: at.y,
        z: at.z,
        block: { namespacedName: inspection!.block, properties },
      }),
    );
    // No re-inspect here: `runDocument` already refreshes the inspected block.
  }

  /**
   * Writes one NBT leaf.
   *
   * `runDocument` re-inspects afterwards, which matters more here than for a
   * block state: main coerces the text to the tag's type, so 007 comes back as
   * 7 and the field has to show what was actually stored rather than what was
   * typed.
   */
  async function changeNbtValue(path: (string | number)[], value: string): Promise<void> {
    if (!inspectedAt) return;
    const at = inspectedAt;
    await runDocument(t("task.editingNbt"), () =>
      api().setNbtValue({ x: at.x, y: at.y, z: at.z, path: forIpc(path), value }),
    );
  }

  async function copySelection(cut: boolean): Promise<void> {
    if (!selection) return;
    const region = selection;
    busy = true;
    try {
      const response = await (cut
        ? api().cutRegion(forIpc(region))
        : api().copyRegion(forIpc(region)));
      if (!response.ok) {
        status = { tone: "error", text: response.message };
        return;
      }
      clipboard = response.clipboard;
      docState = response.state;
      if (cut) await refreshDocument();
      status = {
        tone: "ok",
        text: t(cut ? "status.cut" : "status.copied", {
          count: response.clipboard.blocks.toLocaleString(),
        }),
      };
    } catch (err) {
      failed(err, cut ? t("task.cutting") : t("task.copying"));
    } finally {
      busy = false;
    }
  }

  /**
   * Pastes at the selection's corner.
   *
   * The corner rather than the centre, and rather than wherever the camera is
   * looking: it is the one point of a selection the user can see and predict,
   * and it makes pasting back into the place something was cut from exact.
   */
  async function pasteHere(): Promise<void> {
    if (!selection) return;
    const at = { x: selection.minX, y: selection.minY, z: selection.minZ };
    const changed = await runDocument(t("task.pasting"), () => api().pasteClipboard(at));
    reportChange(changed);
  }

  /**
   * Turns or reflects the selection.
   *
   * The selection itself is left alone: a quarter turn needs a square
   * footprint, so the box the user drew still describes exactly the region that
   * moved, and clearing it would take away the obvious way to turn it back.
   */
  async function transformSelection(transform: TransformRequest["transform"]): Promise<void> {
    if (!selection) return;
    const region = selection;
    const changed = await runDocument(t("task.transforming"), () =>
      api().transformRegion({ region: forIpc(region), transform }),
    );
    reportChange(changed);
  }

  async function fillSelection(block: string): Promise<void> {
    if (!selection) return;
    const region = selection;
    const changed = await runDocument(t("task.filling"), () =>
      api().applyEdit({ kind: "fill", region: forIpc(region), block: parseBlock(block) }),
    );
    reportChange(changed);
  }

  async function replaceInSelection(from: string, to: string): Promise<void> {
    if (!selection) return;
    const region = selection;
    const changed = await runDocument(t("task.replacing"), () =>
      api().applyEdit({
        kind: "replace",
        region: forIpc(region),
        from: parseBlock(from),
        to: parseBlock(to),
      }),
    );
    reportChange(changed);
  }

  /**
   * An edit that matched nothing is indistinguishable from a broken button, so
   * it says so. A successful one needs no announcement: the viewport is the
   * confirmation.
   */
  function reportChange(changed: number | null): void {
    if (changed === 0) {
      status = { tone: "info", text: t("status.nothingMatched") };
    }
  }

  async function saveDocument(format?: SchematicFormat, filePath?: string): Promise<void> {
    busy = true;
    try {
      const response = await api().saveDocument({ filePath: filePath ?? null, format });
      if (!response.ok) {
        status = { tone: "error", text: response.message };
        return;
      }
      docState = response.state;
      status = {
        tone: response.degraded.length > 0 ? "warn" : "ok",
        text: t("status.saved", { name: response.filePath.split(/[\\/]/).pop() ?? "" }),
        detail:
          response.degraded.length > 0
            ? t("status.degraded", {
                count: response.degraded.length,
                blocks: response.degraded.slice(0, 3).join(", "),
              })
            : undefined,
      };
    } catch (err) {
      failed(err, t("task.saving"));
    } finally {
      busy = false;
    }
  }

  async function saveDocumentAs(): Promise<void> {
    let picked: Awaited<ReturnType<ReturnType<typeof api>["pickFile"]>>;
    try {
      picked = await api().pickFile({ kind: "directory" });
    } catch (err) {
      failed(err, t("task.choosingSaveLocation"));
      return;
    }
    if (!picked.path || !docState) return;
    const name = docState.fileName ?? "untitled.schem";
    await saveDocument(docState.format, `${picked.path}/${name}`);
  }

  async function askAgent(prompt: string): Promise<void> {
    chat = [...chat, { role: "user", text: prompt }];
    liveSteps = [];
    busy = true;
    const id = requestId();
    // Held so Stop can name the run. Cleared in `finally`, which is what makes
    // the button disappear the instant the request settles, however it settled.
    agentRequestId = id;
    try {
      const response = await api().askAgent({
        requestId: id,
        prompt,
        selection: selection ? forIpc(selection) : null,
      });
      if (!response.ok) {
        // Stopping is something the user did, not something that went wrong,
        // so it reads as an ordinary note rather than a failure.
        chat = [
          ...chat,
          { role: response.kind === "cancelled" ? "note" : "error", text: response.message },
        ];
        return;
      }
      docState = response.state;
      chat = [
        ...chat,
        {
          role: "agent",
          // A model can answer with tool calls and no closing text; saying
          // nothing at all would read as a failure.
          text: response.text.trim() === "" ? t("chat.done") : response.text,
          steps: response.steps,
          changed: response.changed,
          summary: response.summary,
          undoLabel: response.undoLabel,
        },
      ];
      remembered = response.remembered;
      await refreshDocument();
    } catch (err) {
      chat = [
        ...chat,
        { role: "error", text: err instanceof Error ? err.message : String(err) },
      ];
    } finally {
      agentRequestId = null;
      liveSteps = [];
      busy = false;
    }
  }

  async function onGenerate(): Promise<void> {
    busy = true;
    status = null;
    try {
      let response: Awaited<ReturnType<ReturnType<typeof api>["generate"]>>;
      try {
        response = await api().generate({
          requestId: requestId(),
          description,
          version: settings.version,
          exportType: settings.exportType,
          imagePath,
        });
      } catch (err) {
        failed(err, t("task.generating"));
        return;
      }
      if (!response.ok) {
        status = {
          tone:
            response.kind === "sandbox-violation" || response.kind === "sandbox-unavailable"
              ? "error"
              : "warn",
          text: response.message,
          detail: response.detail,
        };
        return;
      }
      // Two independent things worth saying about a successful save, either of
      // which may be absent. Dropped blocks downgrade the tone: the file was
      // written, but it is not the structure the model described.
      const notes: string[] = [];
      if (response.backedUpTo) {
        notes.push(
          t("status.backedUp", { name: response.backedUpTo.split(/[\\/]/).pop() ?? "" }),
        );
      }
      if (response.droppedBlocks.length > 0) {
        const named = response.droppedBlocks
          .slice(0, 3)
          .map((dropped) => `${dropped.blockId ?? t("status.emptyBlock")} ×${dropped.calls}`)
          .join(", ");
        const rest = response.droppedBlocks.length - 3;
        notes.push(
          t("status.droppedBlocks", {
            count: response.droppedBlocks.length,
            blocks: named + (rest > 0 ? t("status.droppedAndMore", { count: rest }) : ""),
          }),
        );
      }
      status = {
        tone: response.droppedBlocks.length > 0 ? "warn" : "ok",
        text: t("status.saved", { name: `${response.name}.${response.exportType}` }),
        detail: notes.length > 0 ? notes.join(". ") : undefined,
      };
      artifacts = await api().listArtifacts();
      // component.py:401-404 -- only .schem gets a preview, and only then does
      // it become the "last schem" for Re-render.
      if (response.exportType === "schem") {
        // Opened rather than merely previewed. Generating used to hand back a
        // picture of a file: the chat still said "open a schematic first" and
        // none of the editing tools could touch what had just been made. It is
        // a document now, like anything else that arrives on screen.
        await openDocumentAt(response.path);
      }
    } finally {
      busy = false;
      progress = null;
    }
  }
</script>

<CommandPalette open={paletteOpen} {commands} onclose={() => (paletteOpen = false)} />

<SettingsModal
  open={settingsOpen}
  {settings}
  {keyStatus}
  {resourcePackPath}
  {resourcePackName}
  {busy}
  onclose={() => (settingsOpen = false)}
  onchange={patchSettings}
  onpreviewchange={patchPreview}
  onuichange={patchUi}
  onpickresourcepack={() => pick("resource-pack")}
  onclearresourcepack={() => {
    resourcePackPath = null;
    resourcePackName = null;
  }}
  onsavekey={saveKey}
  onclearkey={clearKey}
/>

<main
  class:collapsed={sidebarCollapsed}
  style={`--sidebar-w: ${sidebarCollapsed ? 0 : sidebarWidth}px`}
>
  <!--
    The application bar. Everything in it is left-aligned by request, and the
    order is identity, then mode, then configuration.

    The camera switch used to float over the viewport's top-right corner. It is
    here now because it is a mode the whole window is in, not a control that
    belongs to the canvas -- and moving it gives the canvas that corner back.
  -->
  <header class="navbar">
    <h1>{t("app.title")}</h1>

    <div class="camera-modes" role="group" aria-label={t("viewport.cameraMode")}>
      <button
        class:active={cameraMode === "orbit"}
        onclick={() => (cameraMode = "orbit")}
        title={t("viewport.orbitHint")}
      >
        {t("viewport.orbit")}
      </button>
      <button
        class:active={cameraMode === "fly"}
        onclick={() => (cameraMode = "fly")}
        title={t("viewport.creativeHint")}
      >
        {t("viewport.creative")}
      </button>
    </div>

    <button
      class="icon gear"
      onclick={() => (settingsOpen = true)}
      title={t("settings.openShortcut")}
      aria-label={t("settings.title")}>&#x2699;</button
    >
  </header>

  <section class="controls">
    <header class="sidebar-head">
      <button
        class="icon"
        onclick={toggleSidebar}
        title={t("sidebar.hideShortcut")}
        aria-label={t("sidebar.hide")}>&#x203a;</button
      >
    </header>

    <SidebarTabs
      active={sidebarTab}
      hasInspection={inspection !== null}
      onselect={(tab) => (sidebarTab = tab)}
    />

    <!--
      The chat is the one tab that manages its own scrolling, so it must not be
      put inside a second scroller: nesting them is what made the old panel's
      input drift away down the column.
    -->
    <div class="tab-body" class:owns-scroll={sidebarTab === "chat"}>
      {#if sidebarTab === "chat"}
        <ChatPanel
          entries={chat}
          live={liveSteps}
          {selection}
          {remembered}
          enabled={docState !== null}
          {busy}
          {settings}
          {keyStatus}
          draft={chatDraft}
          ondraftchange={(next) => (chatDraft = next)}
          undoLabel={docState?.undoLabel ?? null}
          onask={askAgent}
          onforget={forgetConversation}
          onstop={stopAgent}
          onundo={() => runDocument(t("task.undoing"), () => api().undo())}
          onsettingschange={patchSettings}
          onopensettings={() => (settingsOpen = true)}
        />
      {:else if sidebarTab === "inspector"}
        <InspectorPanel
          {inspection}
          at={inspectedAt}
          {busy}
          onchangeproperty={changeBlockProperty}
          onchangenbt={changeNbtValue}
        />
      {:else}
        <DocumentPanel
          doc={docState}
          {busy}
          recent={recentDocuments}
          onopenrecent={openDocumentAt}
          onblockchange={(next) => (activeBlock = next)}
          onopen={openDocument}
          onsave={(format) => saveDocument(format)}
          onsaveas={saveDocumentAs}
          onundo={() => runDocument(t("task.undoing"), () => api().undo())}
          onredo={() => runDocument(t("task.redoing"), () => api().redo())}
        />

        <fieldset>
      <legend>{t("structure.legend")}</legend>

      <div class="row">
        <div>
          <label for="version">{t("structure.version")}</label>
          <select
            id="version"
            value={settings.version}
            onchange={(event) => patchSettings({ version: event.currentTarget.value })}
          >
            {#each versions as version (version)}
              <option value={version}>{version}</option>
            {/each}
          </select>
        </div>
        <div>
          <label for="export-type">{t("structure.exportType")}</label>
          <select
            id="export-type"
            value={settings.exportType}
            onchange={(event) =>
              patchSettings({ exportType: event.currentTarget.value as ExportType })}
          >
            <option value="schem">schem</option>
            <option value="mcfunction">mcfunction</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label for="description">{t("structure.description")}</label>
        <textarea
          id="description"
          bind:value={description}
          placeholder={t("structure.descriptionPlaceholder")}
        ></textarea>
      </div>

      <div class="field">
        <label for="image">{t("structure.image")}</label>
        <div class="pick-row">
          <input
            id="image"
            readonly
            value={imageName ?? ""}
            placeholder={acceptsImages
              ? t("structure.noImage")
              : t("structure.imageUnsupported")}
          />
          <button onclick={() => pick("image")} disabled={!acceptsImages}>{t("common.choose")}</button>
          <button
            onclick={() => {
              imagePath = null;
              imageName = null;
            }}
            disabled={!imagePath}>{t("common.clear")}</button
          >
        </div>
        {#if !acceptsImages}
          <p class="hint">{t("structure.imageHint", { model: openCodeModel?.name ?? "" })}</p>
        {/if}
      </div>

      <div class="field">
        <label for="output-dir">{t("structure.outputDir")}</label>
        <div class="pick-row">
          <input
            id="output-dir"
            readonly
            value={settings.outputDir}
            placeholder={defaultOutputDir}
            title={settings.outputDir || defaultOutputDir}
          />
          <button onclick={() => pick("directory")}>{t("common.choose")}</button>
          <button
            onclick={() => patchSettings({ outputDir: "" })}
            disabled={settings.outputDir === ""}>{t("structure.default")}</button
          >
          <button onclick={() => api().revealPath(settings.outputDir || defaultOutputDir)}>
            {t("common.open")}
          </button>
        </div>
        <p class="hint">{t("structure.outputHint")}</p>
      </div>

      <div class="buttons">
        <button class="primary" onclick={onGenerate} disabled={!canGenerate}>
          {t("structure.generate")}
        </button>
        <button
          onclick={() => lastSchemPath && runPreview(lastSchemPath)}
          disabled={!canRerender}
          title={t("structure.rerenderHint")}
        >
          {t("structure.rerender")}
        </button>
      </div>
      <!--
        The model picker lives in the chat now, so this says which model
        Generate will actually run on. There is one LLM configuration in the
        app and both use it; leaving that implicit here would make choosing a
        model in the chat look like it had nothing to do with this button.
      -->
      <p class="hint">
        {t("structure.usesModel", { model: openCodeModel?.name ?? settings.model })}
      </p>

      {#if progress}
        <div class="progress" role="progressbar" aria-valuenow={Math.round(progress.fraction * 100)}>
          <div class="bar" style={`width: ${Math.round(progress.fraction * 100)}%`}></div>
        </div>
        <p class="hint">{progress.message}</p>
      {/if}

    </fieldset>

        <ArtifactList {artifacts} onselect={(artifact) => runPreview(artifact.path)} />
      {/if}
    </div>
  </section>

  {#if !sidebarCollapsed}
    <SidebarSplitter
      width={sidebarWidth}
      onresize={(next) => (sidebarWidth = next)}
      oncommit={(next) => {
        sidebarWidth = next;
        void patchUi({ sidebarWidth: next });
      }}
    />
  {/if}

  <!--
    The drop target is the whole viewport rather than a dedicated zone: an
    empty viewport is exactly where someone will try to drop a file, and a
    small target inside it would be a worse guess than the obvious one.
  -->
  <section
    class="preview"
    class:drop-active={dropActive}
    aria-label={t("viewport.label")}
    ondragenter={onDragEnter}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    {#if sidebarCollapsed}
      <button
        class="icon show-panel"
        onclick={toggleSidebar}
        title={t("sidebar.showShortcut")}
        aria-label={t("sidebar.show")}>&#x2039;</button
      >
    {/if}

    <!--
      The status banner lives here, not in the Structure fieldset it was ported
      into. A preview error raised from the Render button at the bottom of a
      scrolling column used to render above the fold, off-screen -- visually
      indistinguishable from nothing happening.
    -->
    {#if dropActive}
      <div class="drop-hint" aria-hidden="true">
        <strong>{t("viewport.dropTitle")}</strong>
        <span>{t("viewport.dropTypes")}</span>
      </div>
    {/if}

    {#if recovery}
      <!--
        Deliberately blocking, unlike the status banner: this is the one
        question where dismissing it by accident loses work permanently, so it
        does not have a close button and both answers are explicit.
      -->
      <div class="recovery" role="alertdialog" aria-labelledby="recovery-title">
        <strong id="recovery-title">{t("recovery.title")}</strong>
        <p>
          {t("recovery.body", {
            name: recovery.fileName ?? t("recovery.unnamed"),
            blocks: recovery.blockCount.toLocaleString(),
            when: new Date(recovery.savedAt).toLocaleString(),
          })}
        </p>
        <div class="buttons">
          <button class="primary" onclick={() => resolveRecovery(true)} disabled={busy}>
            {t("recovery.restore")}
          </button>
          <button onclick={() => resolveRecovery(false)} disabled={busy}>
            {t("recovery.discard")}
          </button>
        </div>
      </div>
    {/if}

    {#if status}
      <div class={`status ${status.tone}`} role="status">
        <div>
          {status.text}
          {#if status.detail}<br /><small>{status.detail}</small>{/if}
        </div>
        <button class="icon" onclick={() => (status = null)} aria-label={t("common.dismiss")}>
          &#x00d7;
        </button>
      </div>
    {/if}

    {#if docState && toolsOpen}
      <ToolWindow
        title={t("selection.legend")}
        x={toolWindowX}
        y={toolWindowY}
        closeLabel={t("common.close")}
        onmove={(x, y) => {
          toolWindowX = x;
          toolWindowY = y;
        }}
        oncommit={(x, y) => {
          toolWindowX = x;
          toolWindowY = y;
          void patchUi({ toolWindowX: x, toolWindowY: y });
        }}
        onclose={() => (toolsOpen = false)}
      >
        <SelectionTools
          {selection}
          {busy}
          blocks={blockRegistry}
          block={activeBlock}
          onblockchange={(next) => (activeBlock = next)}
          {clipboard}
          onfill={fillSelection}
          onreplace={replaceInSelection}
          ontransform={transformSelection}
          oncopy={() => void copySelection(false)}
          oncut={() => void copySelection(true)}
          onpaste={pasteHere}
          onclearselection={() => {
            selection = null;
            anchor = null;
          }}
          onselectall={selectAll}
        />
      </ToolWindow>
    {/if}

    <Viewer
      {mesh}
      {sunAzimuth}
      {sunElevation}
      selection={docState ? selection : null}
      onpick={docState ? onPick : undefined}
      {cameraMode}
      flySpeed={settings.preview.flySpeed}
      framingKey={framingEpoch}
      onbuild={docState ? onBuild : undefined}
      extent={docState
        ? { width: docState.size[0], height: docState.size[1], length: docState.size[2] }
        : null}
      onselectionchange={docState ? onSelectionDragged : undefined}
      maxDpr={settings.preview.maxDpr}
      renderScale={settings.preview.renderScale}
      maxDrawDistance={settings.preview.maxDrawDistance}
      showGrid={settings.preview.showGrid}
      wireframe={settings.preview.wireframe}
      ambientOcclusion={settings.preview.ambientOcclusion}
      theme={resolvedTheme}
    />
    {#if bounds}
      <!-- component.py:465-469's caption, same two-decimal formatting. -->
      <footer>
        {t("viewport.bounds", {
          center: bounds.center.map((n) => n.toFixed(2)).join(", "),
          size: bounds.size.map((n) => n.toFixed(2)).join(", "),
        })}
      </footer>
    {/if}
  </section>
</main>

<style>
  /*
   * `grid-template-rows: 100%` is the fix, not decoration. With only
   * `grid-template-columns` declared, the single implicit row is `auto` and
   * grows to the tallest item -- so `main`'s `height: 100%` was never the
   * height of anything, the left column's `overflow-y: auto` had no box to
   * overflow, and the excess propagated to the document scrollbar, which
   * scrolled the canvas along with the controls.
   *
   * `min-height: 0` on the children is the second half: a grid item's
   * automatic minimum size is its content size, so without it a tall column
   * refuses to shrink into the row no matter what the row says.
   */
  main {
    --navbar-h: 44px;

    display: grid;
    /* Viewport, splitter, sidebar -- the sidebar is the *last* column now. */
    grid-template-columns: 1fr auto var(--sidebar-w);
    grid-template-rows: var(--navbar-h) minmax(0, 1fr);
    height: 100%;
    overflow: hidden;
  }

  main.collapsed {
    grid-template-columns: 1fr 0 0;
  }

  .navbar {
    grid-column: 1 / -1;
    grid-row: 1;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 14px;
    min-width: 0;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
  }

  /*
   * Every track is assigned explicitly. Auto-placement is not safe here: the
   * splitter leaves the DOM when the panel collapses, and without these the
   * viewport slid into the (0px) splitter track and rendered at zero width --
   * the precise opposite of what collapsing is for.
   */
  /*
   * A flex column that does not scroll: the tab body below does. The column
   * itself scrolling is what put the chat's input off the bottom of the window
   * as a conversation grew, and it is why the chat gets a tab of its own.
   */
  .controls {
    grid-column: 3;
    grid-row: 2;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
    min-height: 0;
    padding: 12px 18px 16px;
    border-left: 1px solid var(--border);
  }

  .tab-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  /* The chat scrolls its own log and pins its own composer; a scroller around
     it would defeat both. */
  .tab-body.owns-scroll {
    overflow: hidden;
  }

  main :global(.splitter) {
    grid-column: 2;
    grid-row: 2;
  }

  main.collapsed .controls {
    display: none;
  }

  /*
   * The collapse arrow alone, and pushed to the right-hand edge: the title it
   * used to sit beside now lives in the navbar, and the arrow has to point at
   * the edge the panel disappears towards or it reads as the wrong control.
   */
  .sidebar-head {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 12px;
  }

  h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }

  .preview {
    grid-column: 1;
    grid-row: 2;
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  /* Against the edge the panel will slide back in from. */
  .show-panel {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 3;
  }

  .preview.drop-active::after {
    content: "";
    position: absolute;
    inset: 8px;
    z-index: 4;
    border: 2px dashed var(--accent);
    border-radius: 10px;
    background: var(--accent-tint);
    /* The overlay must not eat the drop event it is drawn for. */
    pointer-events: none;
  }

  .drop-hint {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 14px 22px;
    border-radius: 10px;
    background: var(--bg-panel);
    box-shadow: 0 8px 28px var(--shadow);
    pointer-events: none;
  }

  .drop-hint span {
    font-size: 12px;
    color: var(--text-dim);
  }

  .recovery {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 6;
    width: min(440px, calc(100% - 48px));
    padding: 16px 18px;
    border: 1px solid var(--accent);
    border-radius: 10px;
    background: var(--bg-panel);
    box-shadow: 0 12px 40px var(--shadow);
  }

  .recovery p {
    margin: 8px 0 14px;
    font-size: 13px;
    color: var(--text-dim);
  }

  .recovery .buttons {
    display: flex;
    gap: 8px;
  }

  /* Pushed against the title and the modes, not floated to the far edge:
     the bar's contents are one left-aligned group by request. */
  .gear {
    font-size: 18px;
  }

  .camera-modes {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: 8px;
    background: var(--bg-input);
    border: 1px solid var(--border);
  }

  .camera-modes button {
    padding: 4px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    font-size: 12px;
  }

  .camera-modes button.active {
    background: var(--accent);
    color: var(--accent-contrast);
  }

  .preview :global(.viewer) {
    flex: 1;
  }

  footer {
    padding: 8px 16px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-dim);
  }

  .pick-row {
    display: flex;
    gap: 8px;
  }

  .pick-row input {
    flex: 1;
  }

  .buttons {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  .progress {
    height: 6px;
    margin-top: 12px;
    background: var(--bg-input);
    border-radius: 3px;
    overflow: hidden;
  }

  .bar {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }

  .status {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 4;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    max-width: min(680px, calc(100% - 96px));
    padding: 10px 10px 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-panel);
    box-shadow: 0 6px 20px var(--shadow);
    font-size: 13px;
  }

  .status.ok {
    color: var(--ok);
    border-color: var(--ok);
  }

  .status.warn {
    color: var(--warn);
    border-color: var(--warn);
  }

  .status.error {
    color: var(--danger);
    border-color: var(--danger);
  }
</style>
