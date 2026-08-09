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
  import PreviewSettingsPanel from "./lib/PreviewSettingsPanel.svelte";
  import ProviderConfig from "./lib/ProviderConfig.svelte";
  import SidebarSplitter from "./lib/SidebarSplitter.svelte";
  import Viewer from "./lib/Viewer.svelte";
  import { api, bridgeAvailable, forIpc, BRIDGE_MISSING_MESSAGE } from "./lib/bridge.svelte.js";
  import type { Artifact, ProgressEvent } from "../../shared/ipc.js";
  import {
    DEFAULT_SETTINGS,
    DEFAULT_UI_SETTINGS,
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

  const canGenerate = $derived(description.trim() !== "" && !busy);
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
    })();

    const unsubscribe = api().onProgress((event) => {
      progress = event.phase === "done" ? null : event;
    });
    return () => {
      window.removeEventListener("keydown", onWindowKey);
      unsubscribe();
    };
  });

  function onWindowKey(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      toggleSidebar();
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
      status = {
        tone: "ok",
        text: `Saved ${response.name}.${response.exportType}`,
        detail: response.backedUpTo
          ? `The previous file of that name was kept as ${response.backedUpTo
              .split(/[\\/]/)
              .pop()}`
          : undefined,
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
      <h1>BuilderGPT</h1>
      <button
        class="icon"
        onclick={toggleSidebar}
        title="Hide the control panel (Ctrl+B)"
        aria-label="Hide the control panel">&#x2039;</button
      >
    </header>

    <ProviderConfig
      {settings}
      {keyStatus}
      onchange={patchSettings}
      onsavekey={saveKey}
      onclearkey={clearKey}
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
            placeholder="No image chosen"
          />
          <button onclick={() => pick("image")}>Choose…</button>
          <button
            onclick={() => {
              imagePath = null;
              imageName = null;
            }}
            disabled={!imagePath}>Clear</button
          >
        </div>
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

  <section class="preview">
    {#if sidebarCollapsed}
      <button
        class="icon show-panel"
        onclick={toggleSidebar}
        title="Show the control panel (Ctrl+B)"
        aria-label="Show the control panel">&#x203a;</button
      >
    {/if}

    <!--
      The status banner lives here, not in the Structure fieldset it was ported
      into. A preview error raised from the Render button at the bottom of a
      scrolling column used to render above the fold, off-screen -- visually
      indistinguishable from nothing happening.
    -->
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
