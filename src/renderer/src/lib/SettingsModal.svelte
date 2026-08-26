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
    MCP_PORT,
    PREVIEW_SETTING_RANGES,
    SHADOW_QUALITIES,
    THEMES,
    type KeyStorageStatus,
    type Language,
    type PreviewSettings,
    type Provider,
    type Settings,
    type Theme,
  } from "../../../shared/settings.js";
  import ApiKeysSection from "./ApiKeysSection.svelte";
  import { t, tn } from "./i18n.svelte.js";
  import type { McpActivity, McpStatus } from "../../../shared/ipc.js";
  import { dotColor, dotFor, maskToken } from "./mcp_status.js";
  import { bridgeCommand, connectCommand } from "../../../shared/mcp.js";
  import { api } from "./bridge.svelte.js";

  type Category =
    | "appearance"
    | "schematic"
    | "sky"
    | "viewport"
    | "quality"
    | "textures"
    | "providers"
    | "mcp";

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
    /**
     * The MCP server, from main rather than from the settings above.
     *
     * `settings.mcp.enabled` is the checkbox and this is what is actually
     * listening; they come apart when a port is taken, which is exactly the
     * case worth showing. See `mcp_status.ts`.
     */
    /**
     * The pane to open on, when something else chose it.
     *
     * `startOn`, not `category`: the local `$state` below is already called
     * that, and a prop of the same name would shadow it — the same class of
     * collision `DocumentPanel`'s `doc` prop exists to avoid.
     */
    startOn: Category | null;
    mcpStatus: McpStatus | null;
    mcpActivity: readonly McpActivity[];
    onmcpenabled: (enabled: boolean) => void;
    onmcpregenerate: () => void;
    onpickmcproot: () => void;
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
    startOn,
    mcpStatus,
    mcpActivity,
    onmcpenabled,
    onmcpregenerate,
    onpickmcproot,
  }: Props = $props();

  /**
   * A tick count as a clock face.
   *
   * Ticks are what the setting stores and what anyone typing `/time set` knows,
   * but "18000" does not read as midnight to anybody. Both, then: the slider is
   * in ticks and the label says what hour that is.
   */
  function clockLabel(ticks: number): string {
    // Tick 0 is dawn, which the game puts at 06:00.
    const minutes = Math.round(((ticks / 24000) * 24 * 60 + 6 * 60) % (24 * 60));
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  /**
   * What the theme's floor colour is right now, for the picker to start from.
   *
   * An `<input type="color">` has no empty value -- it always shows *some*
   * colour -- so with the setting empty it has to show the one actually being
   * drawn, or opening Settings would suggest the floor is black.
   */
  const themeGround = $derived.by(() => {
    void open;
    if (typeof document === "undefined") return "#161d27";
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue("--viewport-ground")
      .trim();
    return value === "" ? "#161d27" : value;
  });

  /** Whether the token is shown in the clear. Off every time the modal opens. */
  let revealed = $state(false);
  /** Which field was last copied, so the button can say so briefly. */
  let copied = $state<"url" | "token" | "command" | "bridge" | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    // Re-masked whenever the modal is closed: a token left revealed would still
    // be on screen the next time this pane is opened, which is the one place it
    // could be read by somebody standing behind you.
    if (!open) revealed = false;
  });

  async function copy(what: "url" | "token" | "command" | "bridge", value: string): Promise<void> {
    if (value === "") return;
    await api().copyToClipboard(value);
    copied = what;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied = null), 1500);
  }

  const command = $derived(
    mcpStatus?.url && mcpStatus.token ? connectCommand(mcpStatus.url, mcpStatus.token) : "",
  );
  /*
   * The same, for a client that will not speak HTTP.
   *
   * Shown beside the HTTP one rather than instead of it: some clients take
   * either, and the HTTP form is one fewer process. The bridge is here because
   * some take only stdio, and without this line it would be a file in the
   * install directory that nobody could be expected to find.
   */
  const bridge = $derived(mcpStatus?.bridge ? bridgeCommand(mcpStatus.bridge) : "");

  /*
   * The state in words.
   *
   * An error carries main's own message, which is not translated -- it arrives
   * already phrased, like every other `Failure.message`, and it is the one that
   * names the port. The generic key is the fallback for an error with nothing
   * to say.
   */
  const stateLabel = $derived.by(() => {
    switch (dotFor(mcpStatus)) {
      case "active":
        return t("mcp.stateActive");
      case "listening":
        return t("mcp.stateListening");
      case "error":
        return mcpStatus?.message ?? t("mcp.stateError");
      case "starting":
        return t("mcp.stateStarting");
      default:
        return t("mcp.stateOff");
    }
  });

  const CATEGORIES: readonly { id: Category; key: string }[] = [
    { id: "appearance", key: "settings.appearance" },
    { id: "schematic", key: "settings.schematic" },
    { id: "sky", key: "settings.sky" },
    { id: "viewport", key: "settings.viewport" },
    { id: "quality", key: "settings.quality" },
    { id: "textures", key: "settings.textures" },
    { id: "providers", key: "settings.providers" },
    { id: "mcp", key: "settings.mcp" },
  ];

  let category = $state<Category>("appearance");

  /*
   * Opening on a named pane, when the caller had one in mind.
   *
   * The MCP indicator opens this modal to say something about the MCP server,
   * and landing on Appearance would make it a button that appears to do nothing.
   * Only while `open`, so choosing a pane by hand is not overwritten on the next
   * paint; `startOn` is cleared by the caller on close.
   */
  $effect(() => {
    if (open && startOn !== null) category = startOn;
  });
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
        {:else if category === "sky"}
          <label class="check">
            <input
              type="checkbox"
              checked={preview.sky}
              onchange={(event) => onpreviewchange({ sky: event.currentTarget.checked })}
            />
            {t("preview.sky")}
          </label>
          <p class="hint">{t("preview.skyHint")}</p>

          {#if preview.sky}
            <div class="field">
              <label for="time-of-day">
                {t("preview.timeOfDay", { time: clockLabel(preview.timeOfDay) })}
              </label>
              <input
                id="time-of-day"
                type="range"
                min={PREVIEW_SETTING_RANGES.timeOfDay.min}
                max={PREVIEW_SETTING_RANGES.timeOfDay.max}
                step={PREVIEW_SETTING_RANGES.timeOfDay.step}
                value={preview.timeOfDay}
                oninput={(event) =>
                  onpreviewchange({ timeOfDay: Number(event.currentTarget.value) })}
              />
              <p class="hint">{t("preview.timeOfDayHint")}</p>
            </div>

            <label class="check">
              <input
                type="checkbox"
                checked={preview.daylightCycle}
                onchange={(event) =>
                  onpreviewchange({ daylightCycle: event.currentTarget.checked })}
              />
              {t("preview.daylightCycle")}
            </label>

            {#if preview.daylightCycle}
              <div class="field">
                <label for="daylight-speed">
                  {t("preview.daylightSpeed", { value: preview.daylightSpeed.toFixed(0) })}
                </label>
                <input
                  id="daylight-speed"
                  type="range"
                  min={PREVIEW_SETTING_RANGES.daylightSpeed.min}
                  max={PREVIEW_SETTING_RANGES.daylightSpeed.max}
                  step={PREVIEW_SETTING_RANGES.daylightSpeed.step}
                  value={preview.daylightSpeed}
                  oninput={(event) =>
                    onpreviewchange({ daylightSpeed: Number(event.currentTarget.value) })}
                />
              </div>
            {/if}
          {:else}
            <!--
              With no sky there is no hour, so the light is placed by hand.
              These two are the controls the app has always had; they are shown
              here rather than always, because with the sky on the sun's
              elevation is the time of day and two answers to that would be one
              too many.
            -->
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
                oninput={(event) =>
                  onpreviewchange({ sunAzimuthDeg: Number(event.currentTarget.value) })}
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
                oninput={(event) =>
                  onpreviewchange({ sunElevationDeg: Number(event.currentTarget.value) })}
              />
            </div>
          {/if}

          <label class="check">
            <input
              type="checkbox"
              checked={preview.shadows}
              onchange={(event) => onpreviewchange({ shadows: event.currentTarget.checked })}
            />
            {t("preview.shadows")}
          </label>
          <p class="hint">{t("preview.shadowsHint")}</p>

          {#if preview.shadows}
            <div class="field">
              <label for="shadow-quality">{t("preview.shadowQuality")}</label>
              <select
                id="shadow-quality"
                value={String(preview.shadowQuality)}
                onchange={(event) =>
                  onpreviewchange({ shadowQuality: Number(event.currentTarget.value) })}
              >
                {#each SHADOW_QUALITIES as size (size)}
                  <option value={String(size)}>{size}&#xd7;{size}</option>
                {/each}
              </select>
            </div>
          {/if}

          <!--
            The floor. Nothing to do with the schematic -- it is not a block and
            is never saved -- but a build with nothing under it floats, and
            every shadow it casts falls into nothing and is invisible.
          -->
          <label class="check">
            <input
              type="checkbox"
              checked={preview.ground}
              onchange={(event) => onpreviewchange({ ground: event.currentTarget.checked })}
            />
            {t("preview.ground")}
          </label>
          <p class="hint">{t("preview.groundHint")}</p>

          {#if preview.ground}
            <div class="field">
              <label for="ground-color">{t("preview.groundColor")}</label>
              <div class="pick-row">
                <input
                  id="ground-color"
                  class="swatch"
                  type="color"
                  value={preview.groundColor === "" ? themeGround : preview.groundColor}
                  oninput={(event) => onpreviewchange({ groundColor: event.currentTarget.value })}
                />
                <!--
                  Empty is not a colour, it is "whichever the theme says" -- so
                  there has to be a way back to it once a colour has been
                  picked, or the light theme keeps a dark floor for ever with
                  nothing on screen to say why.
                -->
                <button
                  onclick={() => onpreviewchange({ groundColor: "" })}
                  disabled={preview.groundColor === ""}
                >
                  {t("preview.groundFollowTheme")}
                </button>
              </div>
            </div>
          {/if}

          <!--
            The two that reach the mesher rather than the viewer, which is why
            they say so: turning either on or off rebuilds the mesh.
          -->
          <label class="check">
            <input
              type="checkbox"
              checked={preview.blockLight}
              onchange={(event) => onpreviewchange({ blockLight: event.currentTarget.checked })}
            />
            {t("preview.blockLight")}
          </label>
          <p class="hint">{t("preview.blockLightHint")}</p>

          <label class="check">
            <input
              type="checkbox"
              checked={preview.smoothLighting}
              onchange={(event) =>
                onpreviewchange({ smoothLighting: event.currentTarget.checked })}
            />
            {t("preview.smoothLighting")}
          </label>
          <p class="hint">{t("preview.smoothLightingHint")}</p>

          <label class="check">
            <input
              type="checkbox"
              checked={preview.ambientOcclusion}
              onchange={(event) =>
                onpreviewchange({ ambientOcclusion: event.currentTarget.checked })}
            />
            {t("preview.ambientOcclusion")}
          </label>
          <p class="hint">{t("preview.ambientOcclusionHint")}</p>
        {:else if category === "viewport"}
          <!--
            No sun here. Where the light is belongs to Sky & light, which is the
            only place that can also say what it is a function of: with the sky
            on that is the hour, and these two sliders would be a second answer
            to the same question.
          -->
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
        {:else if category === "mcp"}
          <label class="check">
            <input
              type="checkbox"
              checked={settings.mcp.enabled}
              disabled={busy}
              onchange={(event) => onmcpenabled(event.currentTarget.checked)}
            />
            {t("mcp.enable")}
          </label>
          <p class="hint">{t("mcp.enableHint")}</p>

          <!--
            The status is main's, not the checkbox's. They disagree exactly when
            it matters — a port already held by a second copy of the app — and
            that disagreement is the thing this row exists to show.
          -->
          <div class="field">
            <span class="label">{t("mcp.status")}</span>
            <p class="state">
              <span class="dot" style={`background: var(${dotColor(dotFor(mcpStatus))})`}></span>
              <span>{stateLabel}</span>
              {#if mcpStatus !== null && mcpStatus.clients > 0}
                <span class="muted">· {tn("mcp.clients", mcpStatus.clients)}</span>
              {/if}
            </p>
          </div>

          {#if mcpStatus?.url}
            <div class="field">
              <label for="mcp-url">{t("mcp.url")}</label>
              <div class="pick-row">
                <input id="mcp-url" readonly value={mcpStatus.url} />
                <button onclick={() => copy("url", mcpStatus?.url ?? "")}>
                  {copied === "url" ? t("mcp.copied") : t("mcp.copy")}
                </button>
              </div>
            </div>

            <div class="field">
              <label for="mcp-token">{t("mcp.token")}</label>
              <div class="pick-row">
                <input
                  id="mcp-token"
                  readonly
                  value={revealed ? (mcpStatus.token ?? "") : maskToken(mcpStatus.token)}
                />
                <button onclick={() => (revealed = !revealed)}>
                  {revealed ? t("mcp.hide") : t("mcp.reveal")}
                </button>
                <button onclick={() => copy("token", mcpStatus?.token ?? "")}>
                  {copied === "token" ? t("mcp.copied") : t("mcp.copy")}
                </button>
                <button onclick={onmcpregenerate} disabled={busy}>{t("mcp.regenerate")}</button>
              </div>
              <p class="hint">{t("mcp.tokenHint")}</p>
            </div>

            <div class="field">
              <label for="mcp-command">{t("mcp.command")}</label>
              <div class="pick-row">
                <input id="mcp-command" readonly value={command} title={command} />
                <button onclick={() => copy("command", command)}>
                  {copied === "command" ? t("mcp.copied") : t("mcp.copy")}
                </button>
              </div>
              <p class="hint">{t("mcp.commandHint")}</p>
            </div>

            {#if bridge !== ""}
              <div class="field">
                <label for="mcp-bridge">{t("mcp.bridge")}</label>
                <div class="pick-row">
                  <input id="mcp-bridge" readonly value={bridge} title={bridge} />
                  <button onclick={() => copy("bridge", bridge)}>
                    {copied === "bridge" ? t("mcp.copied") : t("mcp.copy")}
                  </button>
                </div>
                <p class="hint">{t("mcp.bridgeHint")}</p>
              </div>
            {/if}
          {/if}

          <div class="field">
            <label for="mcp-port">{t("mcp.port")}</label>
            <input
              id="mcp-port"
              type="number"
              min={MCP_PORT.min}
              max={MCP_PORT.max}
              value={settings.mcp.port}
              onchange={(event) =>
                onchange({ mcp: { ...settings.mcp, port: Number(event.currentTarget.value) } })}
            />
            <p class="hint">{t("mcp.portHint")}</p>
          </div>

          <div class="field">
            <label for="mcp-root">{t("mcp.root")}</label>
            <div class="pick-row">
              <input
                id="mcp-root"
                readonly
                value={settings.mcp.root}
                placeholder={defaultOutputDir}
                title={settings.mcp.root || defaultOutputDir}
              />
              <button onclick={onpickmcproot} disabled={busy}>{t("common.choose")}</button>
              <button
                onclick={() => onchange({ mcp: { ...settings.mcp, root: "" } })}
                disabled={busy || settings.mcp.root === ""}>{t("mcp.rootDefault")}</button
              >
            </div>
            <p class="hint">{t("mcp.rootHint")}</p>
          </div>

          <label class="check">
            <input
              type="checkbox"
              checked={settings.mcp.allowDelete}
              disabled={busy}
              onchange={(event) =>
                onchange({ mcp: { ...settings.mcp, allowDelete: event.currentTarget.checked } })}
            />
            {t("mcp.allowDelete")}
          </label>
          <p class="hint">{t("mcp.allowDeleteHint")}</p>

          <!--
            Letting somebody else's model edit your build is only reasonable if
            you can see what it did. Newest first, because that is the one
            anybody is looking for.
          -->
          <div class="field">
            <span class="label">{t("mcp.activity")}</span>
            {#if mcpActivity.length === 0}
              <p class="hint">{t("mcp.activityEmpty")}</p>
            {:else}
              <ul class="activity">
                {#each mcpActivity as call, index (`${call.at}-${index}`)}
                  <li class:failed={!call.ok}>
                    <span class="when">{new Date(call.at).toLocaleTimeString()}</span>
                    <span class="tool">{call.tool}</span>
                    <span class="summary">{call.summary}</span>
                    <!-- In words, not only in colour: the summary of a failed
                         call is the error text, which on its own reads like an
                         unusually chatty success. -->
                    {#if !call.ok}<span class="tag">{t("mcp.activityFailed")}</span>{/if}
                  </li>
                {/each}
              </ul>
            {/if}
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

  /* A label for a row that is read, not edited -- the status and the activity
     list have no control to be the `for` of. */
  .label {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--text-dim);
  }

  .state {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
  }

  .state .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }

  .state .muted {
    color: var(--text-dim);
  }

  .activity {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 220px;
    overflow-y: auto;
    font-size: 12px;
  }

  .activity li {
    display: flex;
    gap: 8px;
    padding: 3px 0;
    border-bottom: 1px solid var(--border);
  }

  .activity .when {
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    flex: none;
  }

  .activity .tool {
    flex: none;
    font-family: var(--mono, monospace);
  }

  /* The summary is the long one, so it is the one that gives way. */
  .activity .summary {
    flex: 1;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .activity .tag {
    flex: none;
    color: var(--danger);
  }

  .activity li.failed .tool {
    color: var(--danger);
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
