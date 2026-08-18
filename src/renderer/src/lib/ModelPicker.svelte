<script lang="ts">
  /**
   * Which model answers, chosen from inside the chat composer.
   *
   * A button showing `provider · model` that opens a popover, rather than two
   * selects sitting in the footer: the footer is one line under a textarea and
   * two dropdowns would own it. This is the shape Copilot uses for the same
   * reason.
   *
   * Worth being clear about, because it surprises people: this is
   * `settings.provider` / `settings.model`, the same pair **Generate** uses.
   * There is one LLM configuration in this app, and changing the model here
   * changes what generation runs on too. Structure says so beside its button
   * rather than pretending otherwise.
   */
  import { openCodeModelRequiresKey, type OpenCodeModelInfo } from "../../../shared/ipc.js";
  import {
    PROVIDERS,
    PROVIDER_DEFAULT_MODEL,
    type KeyStorageStatus,
    type Provider,
    type Settings,
  } from "../../../shared/settings.js";
  import { t } from "./i18n.svelte.js";
  import { findOpenCodeModel, openCodeCatalogue, openCodeFetchFailed } from "./models.svelte.js";

  interface Props {
    settings: Settings;
    keyStatus: KeyStorageStatus | null;
    onchange: (patch: Partial<Settings>) => void;
    /** Opens the settings modal on the Providers section. */
    onopensettings: () => void;
  }

  const { settings, keyStatus, onchange, onopensettings }: Props = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined;

  const catalogue = $derived(openCodeCatalogue());
  const selected = $derived(findOpenCodeModel(settings.provider, settings.model));

  const hasKey = $derived(
    keyStatus?.keys.find((entry) => entry.provider === settings.provider)?.hasKey ?? false,
  );
  /** The gate the main process applies, mirrored here for the UI only. */
  const needsKey = $derived(openCodeModelRequiresKey(selected ?? undefined) && !hasKey);

  const free = $derived(catalogue?.filter((m) => m.pricing === "free") ?? []);
  const paid = $derived(catalogue?.filter((m) => m.pricing === "paid") ?? []);
  const unknown = $derived(catalogue?.filter((m) => m.pricing === "unknown") ?? []);

  /** `mimo-v2.5-free · 262k ctx · images` */
  function describe(model: OpenCodeModelInfo): string {
    const bits: string[] = [model.name];
    if (model.contextTokens) {
      bits.push(t("provider.contextTokens", { count: Math.round(model.contextTokens / 1000) }));
    }
    if (model.imageInput === "yes") bits.push(t("provider.images"));
    if (model.pricing === "paid" && model.cost) {
      bits.push(t("provider.cost", { input: model.cost.input, output: model.cost.output }));
    }
    return bits.join(" · ");
  }

  function selectProvider(provider: Provider): void {
    // component.py:239-243 reset the model box to the provider's default.
    onchange({ provider, model: PROVIDER_DEFAULT_MODEL[provider] });
  }

  function onWindowClick(event: MouseEvent): void {
    if (root && !root.contains(event.target as Node)) open = false;
  }
</script>

<svelte:window onclick={onWindowClick} />

<div class="picker" bind:this={root}>
  <button
    class="trigger"
    class:warn={needsKey}
    onclick={() => (open = !open)}
    title={t("chat.modelPickerHint")}
  >
    <span class="label">{selected?.name ?? (settings.model || settings.provider)}</span>
    <span class="caret" aria-hidden="true">&#x25be;</span>
  </button>

  {#if open}
    <div class="popover" role="dialog" aria-label={t("chat.modelPickerHint")}>
      <div class="field">
        <label for="picker-provider">{t("provider.provider")}</label>
        <select
          id="picker-provider"
          value={settings.provider}
          onchange={(event) => selectProvider(event.currentTarget.value as Provider)}
        >
          {#each PROVIDERS as provider (provider)}
            <option value={provider}>{provider}</option>
          {/each}
        </select>
      </div>

      <div class="field">
        <label for="picker-model">{t("provider.model")}</label>
        {#if catalogue}
          <select
            id="picker-model"
            value={settings.model}
            onchange={(event) => onchange({ model: event.currentTarget.value })}
          >
            <!--
              Grouped by what you have to do to use them rather than
              alphabetically: the free ones work with no setup at all, so they
              belong at the top and visibly separated.
            -->
            {#if free.length > 0}
              <optgroup label={t("provider.free", { count: free.length })}>
                {#each free as model (model.id)}
                  <option value={model.id}>{describe(model)}</option>
                {/each}
              </optgroup>
            {/if}
            {#if paid.length > 0}
              <optgroup label={t("provider.paid", { count: paid.length })}>
                {#each paid as model (model.id)}
                  <option value={model.id}>{describe(model)}</option>
                {/each}
              </optgroup>
            {/if}
            {#if unknown.length > 0}
              <optgroup label={t("provider.unknownPricing", { count: unknown.length })}>
                {#each unknown as model (model.id)}
                  <option value={model.id}>{describe(model)}</option>
                {/each}
              </optgroup>
            {/if}
          </select>
          {#if selected}
            <p class="hint">
              {t("provider.modelSummary", { id: selected.id, count: catalogue.length })}
              {#if selected.imageInput === "no"}
                {t("provider.textOnly")}
              {:else if selected.imageInput === "unknown"}
                {t("provider.imageUnknown")}
              {/if}
            </p>
          {/if}
        {:else}
          <input
            id="picker-model"
            value={settings.model}
            placeholder={PROVIDER_DEFAULT_MODEL[settings.provider]}
            oninput={(event) => onchange({ model: event.currentTarget.value })}
          />
          {#if openCodeFetchFailed()}
            <p class="hint">{t("provider.fetchFailed")}</p>
          {/if}
        {/if}
      </div>

      {#if needsKey}
        <p class="hint warn">
          {t("provider.needsKey", { model: selected?.name ?? settings.model })}
          <button
            class="link"
            onclick={() => {
              open = false;
              onopensettings();
            }}>{t("provider.addKey")}</button
          >
        </p>
      {/if}

      <p class="hint">{t("chat.modelSharedHint")}</p>
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
    min-width: 0;
  }

  .trigger {
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: 220px;
    padding: 3px 8px;
    border: none;
    background: none;
    color: var(--text-dim);
    font-size: 12px;
  }

  .trigger:hover:not(:disabled) {
    color: var(--text);
    background: var(--bg-panel);
    border-radius: 6px;
  }

  .trigger.warn {
    color: var(--warn);
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .caret {
    flex: none;
    font-size: 10px;
  }

  /* Opens upwards: the composer is pinned to the bottom of the panel, so a
     popover hanging down would be off-screen. */
  .popover {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 20;
    width: min(340px, calc(100vw - 64px));
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
    box-shadow: 0 8px 28px var(--shadow);
  }

  .popover .field:last-of-type {
    margin-bottom: 0;
  }

  .warn {
    color: var(--warn);
  }

  button.link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
  }
</style>
