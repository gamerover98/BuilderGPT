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
  import DocumentPanel from "./lib/DocumentPanel.svelte";
  import InspectorPanel from "./lib/InspectorPanel.svelte";
  import PreviewSettingsPanel from "./lib/PreviewSettingsPanel.svelte";
  import ProviderConfig from "./lib/ProviderConfig.svelte";
  import SidebarSplitter from "./lib/SidebarSplitter.svelte";
  import Viewer, { type CameraMode, type PickedBlock } from "./lib/Viewer.svelte";
  import { api, bridgeAvailable, forIpc, BRIDGE_MISSING_MESSAGE } from "./lib/bridge.svelte.js";
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
    type RegionSpec,
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
  let pickedSchemPath = $state<string | null>(null);
  let pickedSchemName = $state<string | null>(null);

  /** component.py:281-282's `st.session_state["bgpt_last_schem_path"]`. */
  let lastSchemPath = $state<string | null>(null);

  let busy = $state(false);
  let progress = $state<ProgressEvent | null>(null);
  let status = $state<Status>(null);

  let glb = $state<Uint8Array | null>(null);
  let bounds = $state<{ center: number[]; size: number[] } | null>(null);
  let sunAzimuth = $state(0);
  let sunElevation = $state(0);

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
    await runDocument(action === "break" ? "Breaking a block" : "Placing a block", () =>
      api().applyEdit({ kind: "setBlock", x: at.x, y: at.y, z: at.z, block }),
    );
  }

  let chat = $state<ChatEntry[]>([]);
  /** Tool calls for the turn in flight, so the panel narrates rather than hangs. */
  let liveSteps = $state<AgentStepEvent[]>([]);

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
      status = { tone: "warn", text: `${file.name} does not come from a file on disk.` };
      return;
    }
    if (!isSchematicPath(filePath)) {
      status = {
        tone: "warn",
        text: `${file.name} is not a schematic — open a .schem or .schematic.`,
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
        await refreshDocument();
        status = {
          tone: "ok",
          text: `Recovered your unsaved work${offer?.fileName ? ` on ${offer.fileName}` : ""}.`,
          detail: "It has not been written to disk yet — save when you are happy with it.",
        };
      }
    } catch (err) {
      failed(err, "Recovering unsaved work");
    } finally {
      busy = false;
    }
  }

  /**
   * The OpenCode model in use, when there is one. Everything below is UI
   * mirroring: `ipc/handlers.ts` applies the same two rules authoritatively,
   * because a renderer check is a courtesy, not a gate.
   */
  let openCodeModel = $state<OpenCodeModelInfo | null>(null);

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
  const canRerender = $derived(lastSchemPath !== null && !busy);

  onMount(() => {
    // Registered before the bridge check on purpose: collapsing the panel is
    // pure UI, and a window whose preload failed to load is exactly the one
    // where reaching the whole viewport still matters.
    window.addEventListener("keydown", onWindowKey);

    if (!bridgeAvailable) {
      status = { tone: "error", text: BRIDGE_MISSING_MESSAGE };
      return () => window.removeEventListener("keydown", onWindowKey);
    }

    void (async () => {
      settings = await api().getSettings();
      sidebarWidth = settings.ui.sidebarWidth;
      sidebarCollapsed = settings.ui.sidebarCollapsed;
      keyStatus = await api().getKeyStatus();
      versions = await api().listVersions();
      artifacts = await api().listArtifacts();
      defaultOutputDir = await api().getDefaultOutputDir();

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
      unsubscribe();
      unsubscribeSteps();
    };
  });

  function onWindowKey(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "b") {
      event.preventDefault();
      toggleSidebar();
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
      void runDocument("Undoing", () => api().undo());
    } else if (key === "y" || (key === "z" && event.shiftKey)) {
      event.preventDefault();
      void runDocument("Redoing", () => api().redo());
    } else if (key === "s") {
      event.preventDefault();
      // Nowhere to save to yet means Save As, which is what every editor does.
      void (docState.filePath === null ? saveDocumentAs() : saveDocument());
    }
  }

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
      failed(err, "Saving the panel layout");
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
    if (rebuilds && lastSchemPath && !busy) {
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
    status = { tone: "error", text: `${doing}: ${message}` };
  }

  async function pick(kind: "image" | "resource-pack" | "schem" | "directory"): Promise<void> {
    let picked: Awaited<ReturnType<ReturnType<typeof api>["pickFile"]>>;
    try {
      picked = await api().pickFile({ kind });
    } catch (err) {
      failed(err, `Opening the ${kind} chooser`);
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
    } else {
      pickedSchemPath = picked.path;
      pickedSchemName = picked.name;
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
      failed(err, "Rendering the schematic");
      return;
    }
    if (!response.ok) {
      // component.py:456 used st.warning, not st.error: a failed preview never
      // invalidates the generated file.
      status = { tone: "warn", text: response.message };
      return;
    }
    glb = response.glb;
    bounds = { center: response.center, size: response.size };
    sunAzimuth = response.sunAzimuth;
    sunElevation = response.sunElevation;
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
      glb = null;
      bounds = null;
      return;
    }
    const mesh = await api().getDocumentMesh(forIpc(settings.preview));
    if (!mesh.ok) {
      status = { tone: "warn", text: mesh.message };
      return;
    }
    glb = mesh.glb;
    bounds = { center: mesh.center, size: mesh.size };
    sunAzimuth = mesh.sunAzimuth;
    sunElevation = mesh.sunElevation;
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
      failed(err, "Opening the schematic chooser");
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
      await refreshDocument();
    } catch (err) {
      failed(err, "Opening the schematic");
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

  function onPick(block: PickedBlock): void {
    void inspectBlock(block.x, block.y, block.z);
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

  function selectAll(): void {
    if (!docState) return;
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
    await runDocument("Changing a block state", () =>
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

  async function fillSelection(block: string): Promise<void> {
    if (!selection) return;
    const region = selection;
    const changed = await runDocument("Filling the selection", () =>
      api().applyEdit({ kind: "fill", region: forIpc(region), block: parseBlock(block) }),
    );
    reportChange(changed);
  }

  async function replaceInSelection(from: string, to: string): Promise<void> {
    if (!selection) return;
    const region = selection;
    const changed = await runDocument("Replacing blocks", () =>
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
      status = { tone: "info", text: "No blocks matched, so nothing changed." };
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
        text: `Saved ${response.filePath.split(/[\\/]/).pop()}`,
        detail:
          response.degraded.length > 0
            ? `${response.degraded.length} block type(s) cannot keep their block state in this ` +
              `format and will come back changed: ${response.degraded.slice(0, 3).join(", ")}`
            : undefined,
      };
    } catch (err) {
      failed(err, "Saving the schematic");
    } finally {
      busy = false;
    }
  }

  async function saveDocumentAs(): Promise<void> {
    let picked: Awaited<ReturnType<ReturnType<typeof api>["pickFile"]>>;
    try {
      picked = await api().pickFile({ kind: "directory" });
    } catch (err) {
      failed(err, "Choosing where to save");
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
    try {
      const response = await api().askAgent({
        requestId: requestId(),
        prompt,
        selection: selection ? forIpc(selection) : null,
      });
      if (!response.ok) {
        chat = [...chat, { role: "error", text: response.message }];
        return;
      }
      docState = response.state;
      chat = [
        ...chat,
        {
          role: "agent",
          // A model can answer with tool calls and no closing text; saying
          // nothing at all would read as a failure.
          text: response.text.trim() === "" ? "Done." : response.text,
          steps: response.steps,
          changed: response.changed,
        },
      ];
      await refreshDocument();
    } catch (err) {
      chat = [
        ...chat,
        { role: "error", text: err instanceof Error ? err.message : String(err) },
      ];
    } finally {
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
        failed(err, "Generating the structure");
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
          `The previous file of that name was kept as ${response.backedUpTo.split(/[\\/]/).pop()}`,
        );
      }
      if (response.droppedBlocks.length > 0) {
        const named = response.droppedBlocks
          .slice(0, 3)
          .map((dropped) => `${dropped.blockId ?? "(empty)"} ×${dropped.calls}`)
          .join(", ");
        const rest = response.droppedBlocks.length - 3;
        notes.push(
          `${response.droppedBlocks.length} block type(s) were left out because they are not in ` +
            `block_id_list.txt: ${named}${rest > 0 ? `, and ${rest} more` : ""}`,
        );
      }
      status = {
        tone: response.droppedBlocks.length > 0 ? "warn" : "ok",
        text: `Saved ${response.name}.${response.exportType}`,
        detail: notes.length > 0 ? notes.join(". ") : undefined,
      };
      artifacts = await api().listArtifacts();
      // component.py:401-404 -- only .schem gets a preview, and only then does
      // it become the "last schem" for Re-render.
      if (response.exportType === "schem") {
        await renderPreview(response.path);
      }
    } finally {
      busy = false;
      progress = null;
    }
  }
</script>

<main
  class:collapsed={sidebarCollapsed}
  style={`--sidebar-w: ${sidebarCollapsed ? 0 : sidebarWidth}px`}
>
  <section class="controls">
    <header class="sidebar-head">
      <h1>Schematic AI Studio</h1>
      <button
        class="icon"
        onclick={toggleSidebar}
        title="Hide the control panel (Ctrl+B)"
        aria-label="Hide the control panel">&#x2039;</button
      >
    </header>

    <DocumentPanel
      doc={docState}
      {selection}
      {busy}
      block={activeBlock}
      onblockchange={(next) => (activeBlock = next)}
      onopen={openDocument}
      onsave={(format) => saveDocument(format)}
      onsaveas={saveDocumentAs}
      onundo={() => runDocument("Undoing", () => api().undo())}
      onredo={() => runDocument("Redoing", () => api().redo())}
      onfill={fillSelection}
      onreplace={replaceInSelection}
      onclearselection={() => {
        selection = null;
        anchor = null;
      }}
      onselectall={selectAll}
    />

    <InspectorPanel
      {inspection}
      at={inspectedAt}
      {busy}
      onchangeproperty={changeBlockProperty}
    />

    <ChatPanel
      entries={chat}
      live={liveSteps}
      {selection}
      enabled={docState !== null}
      {busy}
      onask={askAgent}
    />

    <ProviderConfig
      {settings}
      {keyStatus}
      onchange={patchSettings}
      onsavekey={saveKey}
      onclearkey={clearKey}
      onmodelinfo={(model) => (openCodeModel = model)}
    />

    <fieldset>
      <legend>Structure</legend>

      <div class="row">
        <div>
          <label for="version">Game version</label>
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
          <label for="export-type">Export type</label>
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
        <label for="description">Description</label>
        <textarea
          id="description"
          bind:value={description}
          placeholder="Describe the structure you want to build..."
        ></textarea>
      </div>

      <div class="field">
        <label for="image">Optional reference image</label>
        <div class="pick-row">
          <input
            id="image"
            readonly
            value={imageName ?? ""}
            placeholder={acceptsImages ? "No image chosen" : "Not supported by this model"}
          />
          <button onclick={() => pick("image")} disabled={!acceptsImages}>Choose…</button>
          <button
            onclick={() => {
              imagePath = null;
              imageName = null;
            }}
            disabled={!imagePath}>Clear</button
          >
        </div>
        {#if !acceptsImages}
          <p class="hint">
            {openCodeModel?.name} takes text only. Pick a model marked “images” to use a reference
            picture.
          </p>
        {/if}
      </div>

      <div class="field">
        <label for="output-dir">Output folder</label>
        <div class="pick-row">
          <input
            id="output-dir"
            readonly
            value={settings.outputDir}
            placeholder={defaultOutputDir}
            title={settings.outputDir || defaultOutputDir}
          />
          <button onclick={() => pick("directory")}>Choose…</button>
          <button
            onclick={() => patchSettings({ outputDir: "" })}
            disabled={settings.outputDir === ""}>Default</button
          >
          <button onclick={() => api().revealPath(settings.outputDir || defaultOutputDir)}>
            Open
          </button>
        </div>
        <p class="hint">
          A file of the same name is renamed with a timestamp before being replaced, never
          overwritten.
        </p>
      </div>

      <div class="buttons">
        <button class="primary" onclick={onGenerate} disabled={!canGenerate}>Generate</button>
        <button
          onclick={() => lastSchemPath && runPreview(lastSchemPath)}
          disabled={!canRerender}
          title="Refresh the preview using the last schematic without regenerating"
        >
          Re-render
        </button>
      </div>

      {#if progress}
        <div class="progress" role="progressbar" aria-valuenow={Math.round(progress.fraction * 100)}>
          <div class="bar" style={`width: ${Math.round(progress.fraction * 100)}%`}></div>
        </div>
        <p class="hint">{progress.message}</p>
      {/if}

    </fieldset>

    <PreviewSettingsPanel
      settings={settings.preview}
      {resourcePackPath}
      {resourcePackName}
      schemPath={pickedSchemPath}
      schemName={pickedSchemName}
      {busy}
      onchange={patchPreview}
      onpickresourcepack={() => pick("resource-pack")}
      onclearresourcepack={() => {
        resourcePackPath = null;
        resourcePackName = null;
      }}
      onpickschem={() => pick("schem")}
      onrenderschem={() => pickedSchemPath && runPreview(pickedSchemPath)}
    />

    <ArtifactList {artifacts} onselect={(artifact) => runPreview(artifact.path)} />
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
    aria-label="3D viewport"
    ondragenter={onDragEnter}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    {#if sidebarCollapsed}
      <button
        class="icon show-panel"
        onclick={toggleSidebar}
        title="Show the control panel (Ctrl+B)"
        aria-label="Show the control panel">&#x203a;</button
      >
    {/if}

    {#if glb}
      <div class="camera-modes" role="group" aria-label="Camera mode">
        <button
          class:active={cameraMode === "orbit"}
          onclick={() => (cameraMode = "orbit")}
          title="Orbit around the structure, and click to select"
        >
          Orbit
        </button>
        <button
          class:active={cameraMode === "fly"}
          onclick={() => (cameraMode = "fly")}
          title="Fly through it — WASD, Space and Shift"
        >
          Creative
        </button>
      </div>
    {/if}

    <!--
      The status banner lives here, not in the Structure fieldset it was ported
      into. A preview error raised from the Render button at the bottom of a
      scrolling column used to render above the fold, off-screen -- visually
      indistinguishable from nothing happening.
    -->
    {#if dropActive}
      <div class="drop-hint" aria-hidden="true">
        <strong>Drop to open</strong>
        <span>.schem or .schematic</span>
      </div>
    {/if}

    {#if recovery}
      <!--
        Deliberately blocking, unlike the status banner: this is the one
        question where dismissing it by accident loses work permanently, so it
        does not have a close button and both answers are explicit.
      -->
      <div class="recovery" role="alertdialog" aria-labelledby="recovery-title">
        <strong id="recovery-title">Unsaved work was found</strong>
        <p>
          {recovery.fileName ?? "An unsaved schematic"} — {recovery.blockCount.toLocaleString()}
          blocks, from {new Date(recovery.savedAt).toLocaleString()}. The last session ended before
          it was saved.
        </p>
        <div class="buttons">
          <button class="primary" onclick={() => resolveRecovery(true)} disabled={busy}>
            Restore it
          </button>
          <button onclick={() => resolveRecovery(false)} disabled={busy}>Discard</button>
        </div>
      </div>
    {/if}

    {#if status}
      <div class={`status ${status.tone}`} role="status">
        <div>
          {status.text}
          {#if status.detail}<br /><small>{status.detail}</small>{/if}
        </div>
        <button class="icon" onclick={() => (status = null)} aria-label="Dismiss">&#x00d7;</button>
      </div>
    {/if}

    <Viewer
      {glb}
      {sunAzimuth}
      {sunElevation}
      selection={docState ? selection : null}
      onpick={docState ? onPick : undefined}
      {cameraMode}
      flySpeed={settings.preview.flySpeed}
      onbuild={docState ? onBuild : undefined}
      maxDpr={settings.preview.maxDpr}
      renderScale={settings.preview.renderScale}
      maxDrawDistance={settings.preview.maxDrawDistance}
      showGrid={settings.preview.showGrid}
      wireframe={settings.preview.wireframe}
      ambientOcclusion={settings.preview.ambientOcclusion}
    />
    {#if bounds}
      <!-- component.py:465-469's caption, same two-decimal formatting. -->
      <footer>
        Preview bounds center: ({bounds.center.map((n) => n.toFixed(2)).join(", ")}) · size: ({bounds.size
          .map((n) => n.toFixed(2))
          .join(", ")})
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
    display: grid;
    grid-template-columns: var(--sidebar-w) auto 1fr;
    grid-template-rows: 100%;
    height: 100%;
    overflow: hidden;
  }

  main.collapsed {
    grid-template-columns: 0 0 1fr;
  }

  /*
   * Every track is assigned explicitly. Auto-placement is not safe here: the
   * splitter leaves the DOM when the panel collapses, and without these the
   * viewport slid into the (0px) splitter track and rendered at zero width --
   * the precise opposite of what collapsing is for.
   */
  .controls {
    grid-column: 1;
    overflow-y: auto;
    overflow-x: hidden;
    min-width: 0;
    min-height: 0;
    padding: 20px;
    border-right: 1px solid var(--border);
  }

  main :global(.splitter) {
    grid-column: 2;
  }

  main.collapsed .controls {
    display: none;
  }

  .sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 20px;
  }

  h1 {
    margin: 0;
    font-size: 22px;
    letter-spacing: -0.01em;
  }

  .preview {
    grid-column: 3;
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .show-panel {
    position: absolute;
    top: 12px;
    left: 12px;
    z-index: 3;
  }

  .preview.drop-active::after {
    content: "";
    position: absolute;
    inset: 8px;
    z-index: 4;
    border: 2px dashed var(--accent);
    border-radius: 10px;
    background: rgb(110 168 254 / 8%);
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
    box-shadow: 0 8px 28px rgb(0 0 0 / 45%);
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
    box-shadow: 0 12px 40px rgb(0 0 0 / 55%);
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

  .camera-modes {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 3;
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: 8px;
    background: rgb(10 14 20 / 65%);
    backdrop-filter: blur(6px);
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
    color: #fff;
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
    box-shadow: 0 6px 20px rgb(0 0 0 / 45%);
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
