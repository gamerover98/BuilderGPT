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
    AA_LEVELS,
    DEFAULT_BIOME_COLOR,
    DEFAULT_WATER_COLOR,
    LANGUAGES,
    MCP_PORT,
    PREVIEW_SETTING_RANGES,
    SHADER_MODES,
    SHADOW_QUALITIES,
    THEMES,
    type KeyStorageStatus,
    type Language,
    type PreviewSettings,
    type ShaderMode,
    type Provider,
    type Settings,
    type Theme,
  } from "../../../shared/settings.js";
  import ApiKeysSection from "./ApiKeysSection.svelte";
  import { t, tn } from "./i18n.svelte.js";
  import type { McpActivity, McpStatus } from "../../../shared/ipc.js";
  import { dotColor, dotFor, maskToken } from "./mcp_status.js";
import {
  bindAddressRefusal,
  isLoopbackAddress,
} from "../../../shared/settings.js";
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
  onrevealpath: (target: string) => void;
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
  onrevealpath,
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

  /*
   * The token is no longer required for there to be a command: with
   * authentication off there is a perfectly good one, it simply carries no
   * `--header`. Gating on the token emptied this field in the one
   * configuration where somebody most needs to see what they are serving.
   */
  const command = $derived(
    mcpStatus?.url ? connectCommand(mcpStatus.url, mcpStatus.token) : "",
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
   * The same rules main enforces, mirrored rather than reinvented -- the
   * arrangement `openCodeModelRequiresKey` and the era rule already have. A
   * renderer deciding this for itself would be a second answer to a question
   * that has one, and the two would drift.
   */
  const bindProblem = $derived(bindAddressRefusal(settings.mcp.bindAddress));
  const onLoopback = $derived(isLoopbackAddress(settings.mcp.bindAddress));

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
        // The count *is* the state here, so it is said once rather than beside
        // a label that says the same thing less precisely.
        return tn("mcp.clients", mcpStatus?.clients ?? 0);
      case "listening":
        return t("mcp.stateListening");
      // Said in words as well as painted on the dot: a colour only means
      // something to somebody who already knows what it means.
      case "unauthenticated":
        return t("mcp.stateUnauthenticated");
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
  let dialog = $state<HTMLDivElement | null>(null);

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
            Disabled rather than hidden where the sky is off, and it says which
            of the two it needs. The environment *is* the sky dome, so there is
            genuinely nothing to gather light from -- and a control that came
            and went with a checkbox above it would be one nobody ever learns
            is there. Same reason the impossible versions are shown disabled.
          -->
          <label class="check">
            <input
              type="checkbox"
              checked={preview.globalIllumination}
              disabled={!preview.sky}
              onchange={(event) =>
                onpreviewchange({ globalIllumination: event.currentTarget.checked })}
            />
            {t("preview.globalIllumination")}
          </label>
          <p class="hint">
            {preview.sky
              ? t("preview.globalIlluminationHint")
              : t("preview.globalIlluminationNeedsSky")}
          </p>

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
            Presets rather than shader packs: the renderer opens no connection
            of any kind, so there is nothing to download and no safe way to run
            GLSL somebody sent you. Each one is a bundle of renderer and light
            state, and `vanilla` is the identity.
          -->
          <div class="field">
            <label for="shader-mode">{t("preview.shaderMode")}</label>
            <select
              id="shader-mode"
              value={preview.shaderMode}
              onchange={(event) =>
                onpreviewchange({ shaderMode: event.currentTarget.value as ShaderMode })}
            >
              {#each SHADER_MODES as mode (mode)}
                <option value={mode}>{t(`preview.shaderMode.${mode}`)}</option>
              {/each}
            </select>
            <p class="hint">{t(`preview.shaderMode.${preview.shaderMode}.hint`)}</p>
          </div>

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
          <!--
            Live, which is the whole reason it is not the context's own
            `antialias` flag: that one is fixed for the life of the WebGL
            context, so a setting built on it would do nothing until the app
            was restarted.
          -->
          <div class="field">
            <label for="antialias">{t("preview.antialias")}</label>
            <select
              id="antialias"
              value={String(preview.antialias)}
              onchange={(event) =>
                onpreviewchange({ antialias: Number(event.currentTarget.value) })}
            >
              {#each AA_LEVELS as level (level)}
                <option value={String(level)}>
                  {level === 0 ? t("preview.antialias.off") : `${level}\u00d7 MSAA`}
                </option>
              {/each}
            </select>
            <p class="hint">{t("preview.antialiasHint")}</p>
          </div>
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
          <label class="check">
            <input
              type="checkbox"
              checked={preview.showFps}
              onchange={(event) => onpreviewchange({ showFps: event.currentTarget.checked })}
            />
            {t("preview.showFps")}
          </label>
          <p class="hint">{t("preview.showFpsHint")}</p>
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
            </p>
          </div>

          <!--
            A line of its own rather than a clause inside the state.

            It used to be the *label* of the `active` state, which meant the
            unauthenticated state displaced it -- a warning arrived and the
            count silently left. Two facts, two lines: what the server is doing,
            and how many clients are on it.
          -->
          {#if mcpStatus !== null && mcpStatus.state === "listening"}
            <div class="field">
              <span class="label">{t("mcp.clients")}</span>
              <p class="state">{tn("mcp.clients", mcpStatus.clients)}</p>
            </div>
          {/if}

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

            <!--
              Shown from the **setting**, not from the status.

              This is the pane where the token is configured, and the intent is
              what is being configured: tick the box and you need the string
              immediately, whatever the listener has caught up to. Keyed on the
              status it vanished the moment authentication was turned off and
              did not come back when it was turned on again, because nothing
              restarted the listener -- the dot is where reality belongs.
            -->
            {#if settings.mcp.requireAuth}
            <div class="field">
              <label for="mcp-token">{t("mcp.token")}</label>
              <div class="pick-row">
                <input
                  id="mcp-token"
                  readonly
                  value={revealed ? (mcpStatus.token ?? "") : maskToken(mcpStatus.token)}
                />
                <!--
                  Icons, with the words in `title` and `aria-label`: a glyph is
                  not a label, and three of them in a row would otherwise be
                  three buttons nobody can tell apart from a screen reader.
                -->
                <button
                  class="glyph"
                  onclick={() => (revealed = !revealed)}
                  title={revealed ? t("mcp.hide") : t("mcp.reveal")}
                  aria-label={revealed ? t("mcp.hide") : t("mcp.reveal")}
                >
                  {revealed ? "🙈" : "👁"}
                </button>
                <button
                  class="glyph"
                  onclick={() => copy("token", mcpStatus?.token ?? "")}
                  title={copied === "token" ? t("mcp.copied") : t("mcp.copy")}
                  aria-label={t("mcp.copy")}
                >
                  {copied === "token" ? "✅" : "📋"}
                </button>
                <button
                  class="glyph"
                  onclick={onmcpregenerate}
                  disabled={busy}
                  title={t("mcp.regenerate")}
                  aria-label={t("mcp.regenerate")}
                >
                  🔄
                </button>
              </div>
              <p class="hint">{t("mcp.tokenHint")}</p>
            </div>
            {/if}

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
            <label for="mcp-bind">{t("mcp.bindAddress")}</label>
            <input
              id="mcp-bind"
              value={settings.mcp.bindAddress}
              disabled={busy}
              onchange={(event) =>
                onchange({ mcp: { ...settings.mcp, bindAddress: event.currentTarget.value } })}
            />
            {#if bindProblem !== null}
              <p class="hint bad">{bindProblem}</p>
            {:else}
              <p class="hint">{t("mcp.bindAddressHint")}</p>
            {/if}
          </div>

          <!--
            Off is offered on loopback only. The two together are an anonymous
            write endpoint on somebody's files over the network, and main
            refuses to start in that state -- so the box is disabled rather
            than being a way to arrive at a server that will not run.
          -->
          <label class="check">
            <input
              type="checkbox"
              checked={settings.mcp.requireAuth}
              disabled={busy || !onLoopback}
              onchange={(event) =>
                onchange({ mcp: { ...settings.mcp, requireAuth: event.currentTarget.checked } })}
            />
            {t("mcp.requireAuth")}
          </label>
          <p class="hint" class:warn={!settings.mcp.requireAuth}>
            {t("mcp.requireAuthHint")}
          </p>

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
          <ApiKeysSection {settings} {keyStatus} {onchange} {onsavekey} {onclearkey} {onrevealpath} />
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

  /* Square, and never the thing that grows when the row does -- the input is.
     `line-height: 1` because an emoji's own box is taller than the text
     beside it and would set the height of the whole row. */
  .pick-row button.glyph {
    flex: none;
    width: 32px;
    padding: 0;
    line-height: 1;
    font-size: 14px;
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

  /* A refused value, and a permitted one worth knowing about. Two colours
     because they are two different things: an address that cannot be bound
     is a mistake, and a server with no token is a decision. */
  .hint.bad {
    color: var(--danger);
  }

  .hint.warn {
    color: var(--warn);
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
