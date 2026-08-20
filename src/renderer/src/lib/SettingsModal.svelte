<script lang="ts">
  /**
   * Everything that configures the app, out of the way of the work.
   *
   * These controls used to be a flat list of eleven sliders and checkboxes in
   * the scrolling sidebar, in the order they happened to be added. They are
   * grouped here by *what changes when you touch them*, which is the
   * distinction that matters and the one the flat list hid:
   *
   *   Appearance   the window itself
   *   Viewport     applied by the viewer on the next frame
   *   Quality      likewise, but about how hard the GPU works
   *   Textures     baked into the atlas, so they REBUILD the preview
   *   Providers    account-level, nothing to do with what is on screen
   *
   * The fourth group is separated because that difference is real and was
   * invisible: the two tints and the resource pack are multiplied into the
   * texture atlas and sit in the mesh cache key, while everything else is a
   * uniform the viewer changes between frames. Anyone wondering why one slider
   * is instant and another spins for a second could not tell from the old list.
   */
  import {
    DEFAULT_BIOME_COLOR,
    DEFAULT_WATER_COLOR,
    LANGUAGES,
    PREVIEW_SETTING_RANGES,
    THEMES,
    type KeyStorageStatus,
    type Language,
    type PreviewSettings,
    type Provider,
    type Settings,
    type Theme,
  } from "../../../shared/settings.js";
  import ApiKeysSection from "./ApiKeysSection.svelte";
  import { t } from "./i18n.svelte.js";

  type Category =
    | "appearance"
    | "schematic"
    | "viewport"
    | "quality"
    | "textures"
    | "providers";

  interface Props {
    open: boolean;
    settings: Settings;
    keyStatus: KeyStorageStatus | null;
    resourcePackPath: string | null;
    resourcePackName: string | null;
    /**
     * The Minecraft versions a schematic can be written for, and where
     * generated files land.
     *
     * Both were fields in the generator's form, in a sidebar tab, which made
     * them look like inputs to that one button. They are not: the version is
     * stamped on anything saved, and the folder is where every generation ever
     * goes. They are preferences, and this is where preferences live.
     */
    versions: readonly string[];
    defaultOutputDir: string;
    onpickoutputdir: () => void;
    onrevealoutputdir: () => void;
    busy: boolean;
    onclose: () => void;
    onchange: (patch: Partial<Settings>) => void;
    onpreviewchange: (patch: Partial<PreviewSettings>) => void;
    onuichange: (patch: Partial<Settings["ui"]>) => void;
    onpickresourcepack: () => void;
    onclearresourcepack: () => void;
    onsavekey: (provider: Provider, apiKey: string) => Promise<void>;
    onclearkey: (provider: Provider) => Promise<void>;
  }

  const {
    open,
    settings,
    keyStatus,
    resourcePackPath,
    resourcePackName,
    versions,
    defaultOutputDir,
    onpickoutputdir,
    onrevealoutputdir,
    busy,
    onclose,
    onchange,
    onpreviewchange,
    onuichange,
    onpickresourcepack,
    onclearresourcepack,
    onsavekey,
    onclearkey,
  }: Props = $props();

  const CATEGORIES: readonly { id: Category; key: string }[] = [
    { id: "appearance", key: "settings.appearance" },
    { id: "schematic", key: "settings.schematic" },
    { id: "viewport", key: "settings.viewport" },
    { id: "quality", key: "settings.quality" },
    { id: "textures", key: "settings.textures" },
    { id: "providers", key: "settings.providers" },
  ];

  let category = $state<Category>("appearance");
  let dialog = $state<HTMLDivElement | undefined>(undefined);

  const preview = $derived(settings.preview);

  const num = (event: Event) => Number((event.currentTarget as HTMLInputElement).value);
  const checked = (event: Event) => (event.currentTarget as HTMLInputElement).checked;

  // Taking the keyboard on open is what makes Escape work without the user
  // first clicking something inside.
  $effect(() => {
    if (open) dialog?.focus();
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    }
  }
</script>

{#if open}
  <!--
    Keydown on the wrapper rather than on `window`: while this is open it is the
    only thing that should see the keyboard, and the app's own single-key
    shortcuts must not fire on what is being typed in here.
  -->
  <div
    class="scrim"
    role="presentation"
    onkeydown={onKeydown}
    onclick={(event) => {
      // Only a click on the backdrop itself. Comparing target to currentTarget
      // rather than stopping propagation inside the dialog, which is what the
      // a11y lint objects to and would also swallow legitimate clicks.
      if (event.target === event.currentTarget) onclose();
    }}
  >
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title")}
      tabindex="-1"
      bind:this={dialog}
    >
      <nav class="rail" aria-label={t("settings.title")}>
        <h2>{t("settings.title")}</h2>
        {#each CATEGORIES as entry (entry.id)}
          <button
            class="rail-item"
            class:active={category === entry.id}
            onclick={() => (category = entry.id)}
          >
            {t(entry.key)}
          </button>
        {/each}
      </nav>

      <div class="pane">
        {#if category === "appearance"}
          <div class="field">
            <label for="theme">{t("settings.theme")}</label>
            <select
              id="theme"
              value={settings.ui.theme}
              onchange={(event) => onuichange({ theme: event.currentTarget.value as Theme })}
            >
              {#each THEMES as theme (theme)}
                <option value={theme}>{t(`settings.theme.${theme}`)}</option>
              {/each}
            </select>
            <p class="hint">{t("settings.themeHint")}</p>
          </div>

          <div class="field">
            <label for="language">{t("settings.language")}</label>
            <select
              id="language"
              value={settings.ui.language}
              onchange={(event) => onuichange({ language: event.currentTarget.value as Language })}
            >
              {#each LANGUAGES as language (language)}
                <option value={language}>{t(`settings.language.${language}`)}</option>
              {/each}
            </select>
            <p class="hint">{t("settings.languageHint")}</p>
          </div>
        {:else if category === "schematic"}
          <div class="field">
            <label for="target-version">{t("settings.version")}</label>
            <select
              id="target-version"
              value={settings.version}
              onchange={(event) => onchange({ version: event.currentTarget.value })}
            >
              {#each versions as version (version)}
                <option value={version}>{version}</option>
              {/each}
            </select>
            <p class="hint">{t("settings.versionHint")}</p>
          </div>

          <div class="field">
            <label for="output-dir">{t("settings.outputDir")}</label>
            <div class="pick-row">
              <input
                id="output-dir"
                readonly
                value={settings.outputDir}
                placeholder={defaultOutputDir}
                title={settings.outputDir || defaultOutputDir}
              />
              <button onclick={onpickoutputdir} disabled={busy}>{t("common.choose")}</button>
              <button
                onclick={() => onchange({ outputDir: "" })}
                disabled={busy || settings.outputDir === ""}>{t("settings.outputDefault")}</button
              >
              <!-- The way to find a generated .mcfunction, which is the one
                   output the app never opens for you. -->
              <button onclick={onrevealoutputdir}>{t("common.open")}</button>
            </div>
            <p class="hint">{t("settings.outputHint")}</p>
          </div>
        {:else if category === "viewport"}
          <div class="field">
            <label for="sun-az">
              {t("preview.sunAzimuth", { value: preview.sunAzimuthDeg.toFixed(0) })}
            </label>
            <input
              id="sun-az"
              type="range"
              min={PREVIEW_SETTING_RANGES.sunAzimuthDeg.min}
              max={PREVIEW_SETTING_RANGES.sunAzimuthDeg.max}
              step={PREVIEW_SETTING_RANGES.sunAzimuthDeg.step}
              value={preview.sunAzimuthDeg}
              oninput={(event) => onpreviewchange({ sunAzimuthDeg: num(event) })}
            />
          </div>
          <div class="field">
            <label for="sun-el">
              {t("preview.sunElevation", { value: preview.sunElevationDeg.toFixed(0) })}
            </label>
            <input
              id="sun-el"
              type="range"
              min={PREVIEW_SETTING_RANGES.sunElevationDeg.min}
              max={PREVIEW_SETTING_RANGES.sunElevationDeg.max}
              step={PREVIEW_SETTING_RANGES.sunElevationDeg.step}
              value={preview.sunElevationDeg}
              oninput={(event) => onpreviewchange({ sunElevationDeg: num(event) })}
            />
          </div>
          <div class="field">
            <label for="fly-speed">
              {t("preview.flySpeed", { value: preview.flySpeed.toFixed(0) })}
            </label>
            <input
              id="fly-speed"
              type="range"
              min={PREVIEW_SETTING_RANGES.flySpeed.min}
              max={PREVIEW_SETTING_RANGES.flySpeed.max}
              step={PREVIEW_SETTING_RANGES.flySpeed.step}
              value={preview.flySpeed}
              oninput={(event) => onpreviewchange({ flySpeed: num(event) })}
            />
          </div>
          <div class="toggles">
            <label class="toggle">
              <input
                type="checkbox"
                checked={preview.showGrid}
                onchange={(event) => onpreviewchange({ showGrid: checked(event) })}
              /> {t("preview.showGrid")}
            </label>
            <label class="toggle">
              <input
                type="checkbox"
                checked={preview.wireframe}
                onchange={(event) => onpreviewchange({ wireframe: checked(event) })}
              /> {t("preview.wireframe")}
            </label>
            <label class="toggle">
              <input
                type="checkbox"
                checked={preview.ambientOcclusion}
                onchange={(event) => onpreviewchange({ ambientOcclusion: checked(event) })}
              /> {t("preview.ambientOcclusion")}
            </label>
          </div>
        {:else if category === "quality"}
          <div class="field">
            <label for="max-dpr">{t("preview.maxDpr", { value: preview.maxDpr.toFixed(1) })}</label>
            <input
              id="max-dpr"
              type="range"
              min={PREVIEW_SETTING_RANGES.maxDpr.min}
              max={PREVIEW_SETTING_RANGES.maxDpr.max}
              step={PREVIEW_SETTING_RANGES.maxDpr.step}
              value={preview.maxDpr}
              oninput={(event) => onpreviewchange({ maxDpr: num(event) })}
            />
          </div>
          <div class="field">
            <label for="render-scale">
              {t("preview.renderScale", { value: preview.renderScale.toFixed(1) })}
            </label>
            <input
              id="render-scale"
              type="range"
              min={PREVIEW_SETTING_RANGES.renderScale.min}
              max={PREVIEW_SETTING_RANGES.renderScale.max}
              step={PREVIEW_SETTING_RANGES.renderScale.step}
              value={preview.renderScale}
              oninput={(event) => onpreviewchange({ renderScale: num(event) })}
            />
          </div>
          <div class="field">
            <label for="max-distance">
              {t("preview.maxDrawDistance", { value: preview.maxDrawDistance.toFixed(0) })}
            </label>
            <input
              id="max-distance"
              type="range"
              min={PREVIEW_SETTING_RANGES.maxDrawDistance.min}
              max={PREVIEW_SETTING_RANGES.maxDrawDistance.max}
              step={PREVIEW_SETTING_RANGES.maxDrawDistance.step}
              value={preview.maxDrawDistance}
              oninput={(event) => onpreviewchange({ maxDrawDistance: num(event) })}
            />
          </div>
          <p class="hint">{t("settings.qualityHint")}</p>
        {:else if category === "textures"}
          <p class="hint rebuilds">{t("settings.rebuildsHint")}</p>

          <div class="field">
            <label for="resource-pack">{t("preview.resourcePack")}</label>
            <div class="pick-row">
              <input
                id="resource-pack"
                readonly
                value={resourcePackName ?? ""}
                placeholder={t("preview.resourcePackPlaceholder")}
              />
              <button onclick={onpickresourcepack} disabled={busy}>{t("common.choose")}</button>
              <button onclick={onclearresourcepack} disabled={busy || !resourcePackPath}>
                {t("common.reset")}
              </button>
            </div>
            <p class="hint">{t("preview.resourcePackHint")}</p>
          </div>

          <!--
            Not a viewer toggle: main turns them back into air, because a
            barrier that is drawn has to stop culling its neighbours and that
            is a meshing decision. Changing it rebuilds.
          -->
          <label class="check">
            <input
              type="checkbox"
              checked={preview.showMarkers}
              onchange={(event) => onpreviewchange({ showMarkers: event.currentTarget.checked })}
            />
            {t("preview.showMarkers")}
          </label>
          <p class="hint">{t("preview.showMarkersHint")}</p>

          <div class="field">
            <label for="biome-color">{t("preview.biomeColors")}</label>
            <div class="pick-row">
              <input
                id="biome-color"
                class="swatch"
                type="color"
                title={t("preview.foliage")}
                value={preview.biomeColor}
                oninput={(event) => onpreviewchange({ biomeColor: event.currentTarget.value })}
              />
              <input
                id="water-color"
                class="swatch"
                type="color"
                title={t("preview.water")}
                value={preview.waterColor}
                oninput={(event) => onpreviewchange({ waterColor: event.currentTarget.value })}
              />
              <button
                onclick={() =>
                  onpreviewchange({
                    biomeColor: DEFAULT_BIOME_COLOR,
                    waterColor: DEFAULT_WATER_COLOR,
                  })}
                disabled={preview.biomeColor.toLowerCase() === DEFAULT_BIOME_COLOR &&
                  preview.waterColor.toLowerCase() === DEFAULT_WATER_COLOR}
              >
                {t("preview.plains")}
              </button>
            </div>
            <p class="hint">{t("preview.biomeHint")}</p>
          </div>
        {:else}
          <ApiKeysSection {settings} {keyStatus} {onchange} {onsavekey} {onclearkey} />
        {/if}
      </div>

      <button class="icon close" onclick={onclose} aria-label={t("common.close")}>&#x00d7;</button>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--scrim);
    backdrop-filter: blur(2px);
  }

  .modal {
    position: relative;
    display: grid;
    grid-template-columns: 180px minmax(0, 1fr);
    width: min(780px, calc(100vw - 48px));
    height: min(560px, calc(100vh - 64px));
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-panel);
    box-shadow: 0 16px 48px var(--shadow);
    outline: none;
    overflow: hidden;
  }

  .rail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 16px 10px;
    border-right: 1px solid var(--border);
    background: var(--bg);
    overflow-y: auto;
  }

  h2 {
    margin: 0 0 12px 8px;
    font-size: 15px;
    font-weight: 600;
  }

  .rail-item {
    background: none;
    border: none;
    border-radius: 6px;
    padding: 7px 10px;
    text-align: left;
    color: var(--text-dim);
    font-size: 13px;
  }

  .rail-item:hover:not(:disabled) {
    background: var(--bg-input);
    color: var(--text);
  }

  .rail-item.active {
    background: var(--accent-dim);
    color: var(--text);
  }

  /* `min-height: 0` so the pane scrolls inside the modal rather than growing
     it past the viewport -- the same grid-child rule the app shell needs. */
  .pane {
    min-height: 0;
    padding: 20px 22px;
    overflow-y: auto;
  }

  .close {
    position: absolute;
    top: 10px;
    right: 12px;
  }

  .pick-row {
    display: flex;
    gap: 8px;
  }

  .pick-row input {
    flex: 1;
  }

  /* `.pick-row input` is a class+type selector and outranks a bare `.swatch`,
     so this has to match at least as specifically or the swatch stretches. */
  .pick-row input.swatch {
    flex: 0 0 56px;
    height: 34px;
    padding: 2px;
    cursor: pointer;
  }

  .toggles {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 4px;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    color: var(--text);
    font-size: 14px;
  }

  .rebuilds {
    margin: 0 0 14px;
    padding: 8px 10px;
    border-left: 2px solid var(--warn);
    background: var(--bg-input);
    border-radius: 0 6px 6px 0;
  }
</style>
