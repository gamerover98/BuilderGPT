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
  import Viewer from "./lib/Viewer.svelte";
  import { api, bridgeAvailable, BRIDGE_MISSING_MESSAGE } from "./lib/bridge.js";
  import type { Artifact, ProgressEvent } from "../../shared/ipc.js";
  import {
    DEFAULT_SETTINGS,
    type ExportType,
    type KeyStorageStatus,
    type PreviewSettings,
    type Provider,
    type Settings,
  } from "../../shared/settings.js";

  type Status = { tone: "info" | "ok" | "warn" | "error"; text: string; detail?: string } | null;

  let settings = $state<Settings>({ ...DEFAULT_SETTINGS });
  let keyStatus = $state<KeyStorageStatus | null>(null);
  let versions = $state<string[]>([]);
  let artifacts = $state<Artifact[]>([]);

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
    if (!bridgeAvailable) {
      status = { tone: "error", text: BRIDGE_MISSING_MESSAGE };
      return;
    }
    void (async () => {
      settings = await api().getSettings();
      keyStatus = await api().getKeyStatus();
      versions = await api().listVersions();
      artifacts = await api().listArtifacts();
    })();
    return api().onProgress((event) => {
      progress = event.phase === "done" ? null : event;
    });
  });

  /** Persist on every change; the Python UI persisted nothing at all. */
  async function patchSettings(patch: Partial<Settings>): Promise<void> {
    settings = await api().setSettings({ ...settings, ...patch });
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

  async function pick(kind: "image" | "resource-pack" | "schem"): Promise<void> {
    const picked = await api().pickFile({ kind });
    if (!picked.path) return;
    if (kind === "image") {
      imagePath = picked.path;
      imageName = picked.name;
    } else if (kind === "resource-pack") {
      resourcePackPath = picked.path;
      resourcePackName = picked.name;
    } else {
      pickedSchemPath = picked.path;
      pickedSchemName = picked.name;
    }
  }

  async function renderPreview(schemPath: string): Promise<void> {
    const response = await api().preview({
      requestId: requestId(),
      schemPath,
      resourcePackPath,
      settings: settings.preview,
    });
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
      const response = await api().generate({
        requestId: requestId(),
        description,
        version: settings.version,
        exportType: settings.exportType,
        imagePath,
      });
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
      status = { tone: "ok", text: `Saved ${response.name}.${response.exportType}` };
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

<main>
  <section class="controls">
    <h1>BuilderGPT</h1>

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
          <input id="image" readonly value={imageName ?? ""} placeholder="No image chosen" />
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

      {#if status}
        <p class={`status ${status.tone}`}>
          {status.text}
          {#if status.detail}<br /><small>{status.detail}</small>{/if}
        </p>
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

  <section class="preview">
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
  main {
    display: grid;
    grid-template-columns: minmax(380px, 460px) 1fr;
    height: 100%;
  }

  .controls {
    overflow-y: auto;
    padding: 20px;
    border-right: 1px solid var(--border);
  }

  h1 {
    margin: 0 0 20px;
    font-size: 22px;
    letter-spacing: -0.01em;
  }

  .preview {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
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
    margin: 12px 0 0;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
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
