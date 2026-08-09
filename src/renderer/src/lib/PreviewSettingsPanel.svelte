<script lang="ts">
  /**
   * Port of component.py:310-362 (the "Preview Settings" expander): the eight
   * sliders/checkboxes, the optional resource-pack upload, and the
   * "Render existing .schem (skip generation)" block.
   *
   * Ranges and defaults are the source's, held once in
   * `shared/settings.ts` (`PREVIEW_SETTING_RANGES`, `DEFAULT_PREVIEW_SETTINGS`)
   * rather than repeated as slider literals.
   */
  import {
    DEFAULT_BIOME_COLOR,
    DEFAULT_WATER_COLOR,
    PREVIEW_SETTING_RANGES,
    type PreviewSettings,
  } from "../../../shared/settings.js";

  interface Props {
    settings: PreviewSettings;
    resourcePackPath: string | null;
    resourcePackName: string | null;
    schemPath: string | null;
    schemName: string | null;
    busy: boolean;
    onchange: (patch: Partial<PreviewSettings>) => void;
    onpickresourcepack: () => void;
    onclearresourcepack: () => void;
    onpickschem: () => void;
    onrenderschem: () => void;
  }

  const {
    settings,
    resourcePackPath,
    resourcePackName,
    schemPath,
    schemName,
    busy,
    onchange,
    onpickresourcepack,
    onclearresourcepack,
    onpickschem,
    onrenderschem,
  }: Props = $props();

  const num = (event: Event) => Number((event.currentTarget as HTMLInputElement).value);
  const checked = (event: Event) => (event.currentTarget as HTMLInputElement).checked;
</script>

<fieldset>
  <legend>Preview settings</legend>

  <div class="field">
    <label for="resource-pack">Resource pack (.zip)</label>
    <div class="pick-row">
      <input
        id="resource-pack"
        readonly
        value={resourcePackName ?? ""}
        placeholder="Faithful 64x (bundled)"
      />
      <button onclick={onpickresourcepack}>Choose…</button>
      <button onclick={onclearresourcepack} disabled={!resourcePackPath}>Reset</button>
    </div>
    <p class="hint">
      A pack ships with the app and is used by default. Choosing your own takes
      priority, with the bundled one filling in any textures it does not provide.
      Affects the preview only, never the generated file.
    </p>
  </div>

  <div class="field">
    <label for="biome-color">Biome colours</label>
    <div class="pick-row">
      <input
        id="biome-color"
        class="swatch"
        type="color"
        title="Grass, leaves, vines"
        value={settings.biomeColor}
        oninput={(event) => onchange({ biomeColor: (event.currentTarget as HTMLInputElement).value })}
      />
      <input
        id="water-color"
        class="swatch"
        type="color"
        title="Water"
        value={settings.waterColor}
        oninput={(event) => onchange({ waterColor: (event.currentTarget as HTMLInputElement).value })}
      />
      <button
        onclick={() =>
          onchange({ biomeColor: DEFAULT_BIOME_COLOR, waterColor: DEFAULT_WATER_COLOR })}
        disabled={settings.biomeColor.toLowerCase() === DEFAULT_BIOME_COLOR &&
          settings.waterColor.toLowerCase() === DEFAULT_WATER_COLOR}>Plains</button
      >
    </div>
    <p class="hint">
      Foliage (left) and water (right) ship greyscale and are tinted per biome — they are
      separate colours in Minecraft, so they are separate here. Changing either rebuilds
      the preview.
    </p>
  </div>

  <div class="row">
    <div>
      <label for="sun-az">Sun azimuth — {settings.sunAzimuthDeg.toFixed(0)}°</label>
      <input
        id="sun-az"
        type="range"
        min={PREVIEW_SETTING_RANGES.sunAzimuthDeg.min}
        max={PREVIEW_SETTING_RANGES.sunAzimuthDeg.max}
        step={PREVIEW_SETTING_RANGES.sunAzimuthDeg.step}
        value={settings.sunAzimuthDeg}
        oninput={(event) => onchange({ sunAzimuthDeg: num(event) })}
      />
    </div>
    <div>
      <label for="sun-el">Sun elevation — {settings.sunElevationDeg.toFixed(0)}°</label>
      <input
        id="sun-el"
        type="range"
        min={PREVIEW_SETTING_RANGES.sunElevationDeg.min}
        max={PREVIEW_SETTING_RANGES.sunElevationDeg.max}
        step={PREVIEW_SETTING_RANGES.sunElevationDeg.step}
        value={settings.sunElevationDeg}
        oninput={(event) => onchange({ sunElevationDeg: num(event) })}
      />
    </div>
    <div>
      <label for="max-dpr">Max device pixel ratio — {settings.maxDpr.toFixed(1)}</label>
      <input
        id="max-dpr"
        type="range"
        min={PREVIEW_SETTING_RANGES.maxDpr.min}
        max={PREVIEW_SETTING_RANGES.maxDpr.max}
        step={PREVIEW_SETTING_RANGES.maxDpr.step}
        value={settings.maxDpr}
        oninput={(event) => onchange({ maxDpr: num(event) })}
      />
    </div>
  </div>

  <div class="row">
    <div>
      <label for="render-scale">Render scale — {settings.renderScale.toFixed(1)}</label>
      <input
        id="render-scale"
        type="range"
        min={PREVIEW_SETTING_RANGES.renderScale.min}
        max={PREVIEW_SETTING_RANGES.renderScale.max}
        step={PREVIEW_SETTING_RANGES.renderScale.step}
        value={settings.renderScale}
        oninput={(event) => onchange({ renderScale: num(event) })}
      />
    </div>
    <div>
      <label for="max-distance">Max draw distance — {settings.maxDrawDistance.toFixed(0)}</label>
      <input
        id="max-distance"
        type="range"
        min={PREVIEW_SETTING_RANGES.maxDrawDistance.min}
        max={PREVIEW_SETTING_RANGES.maxDrawDistance.max}
        step={PREVIEW_SETTING_RANGES.maxDrawDistance.step}
        value={settings.maxDrawDistance}
        oninput={(event) => onchange({ maxDrawDistance: num(event) })}
      />
    </div>
    <div class="toggles">
      <label class="toggle">
        <input
          type="checkbox"
          checked={settings.showGrid}
          onchange={(event) => onchange({ showGrid: checked(event) })}
        /> Show grid
      </label>
      <label class="toggle">
        <input
          type="checkbox"
          checked={settings.wireframe}
          onchange={(event) => onchange({ wireframe: checked(event) })}
        /> Wireframe
      </label>
      <label class="toggle">
        <input
          type="checkbox"
          checked={settings.ambientOcclusion}
          onchange={(event) => onchange({ ambientOcclusion: checked(event) })}
        /> Ambient occlusion
      </label>
    </div>
  </div>

  <hr />

  <div class="field">
    <label for="schem-upload">Render an existing .schem (skip generation)</label>
    <div class="pick-row">
      <input id="schem-upload" readonly value={schemName ?? ""} placeholder="No file chosen" />
      <button onclick={onpickschem}>Choose…</button>
      <button class="primary" onclick={onrenderschem} disabled={!schemPath || busy}>Render</button>
    </div>
  </div>
</fieldset>

<style>
  .pick-row {
    display: flex;
    gap: 8px;
  }

  .pick-row input {
    flex: 1;
  }

  /* `.pick-row input` above is a class+type selector and outranks a bare
     `.swatch`, so this has to match at least as specifically or the swatch
     stretches to fill the row. */
  .pick-row input.swatch {
    flex: 0 0 56px;
    height: 34px;
    padding: 2px;
    cursor: pointer;
  }

  .toggles {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    color: var(--text);
    font-size: 14px;
  }

  hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 16px 0;
  }
</style>
