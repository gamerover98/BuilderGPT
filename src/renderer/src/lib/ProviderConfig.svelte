<script lang="ts">
  /**
   * Port of component.py:234-269 (the "🤖 LLM Provider Configuration" expander).
   *
   * Same four providers, same per-provider default model, same OpenCode
   * special-casing (fetch the model list, prefer `mimo-v2.5-free`, fall back to
   * a free-text field when the fetch fails), same Base URL field shown only for
   * the Custom provider.
   *
   * One structural change (ARCHITECTURE.md §3 "Secrets"): the API key is no
   * longer a `st.text_input(type="password")` re-typed every session. It is
   * saved through `safeStorage` and this component only ever learns whether one
   * exists -- it can show "key stored", it cannot read the key back.
   */
  import { openCodeModelRequiresKey, type OpenCodeModelInfo } from "../../../shared/ipc.js";
  import { api, bridgeAvailable } from "./bridge.svelte.js";
  import { t } from "./i18n.svelte.js";
  import {
    PROVIDERS,
    PROVIDER_DEFAULT_MODEL,
    providerRequiresApiKey,
    type KeyStorageStatus,
    type Provider,
    type Settings,
  } from "../../../shared/settings.js";

  interface Props {
    settings: Settings;
    keyStatus: KeyStorageStatus | null;
    onchange: (patch: Partial<Settings>) => void;
    onsavekey: (provider: Provider, apiKey: string) => Promise<void>;
    onclearkey: (provider: Provider) => Promise<void>;
    /** Lifted so App can gate the reference-image picker on the same fact. */
    onmodelinfo?: (model: OpenCodeModelInfo | null) => void;
  }

  const { settings, keyStatus, onchange, onsavekey, onclearkey, onmodelinfo }: Props = $props();

  let openCodeModels = $state<OpenCodeModelInfo[] | null>(null);
  let openCodeFetchFailed = $state(false);
  let keyDraft = $state("");
  let saving = $state(false);

  const hasKey = $derived(
    keyStatus?.keys.find((entry) => entry.provider === settings.provider)?.hasKey ?? false,
  );

  const selectedModel = $derived(
    settings.provider === "OpenCode"
      ? (openCodeModels?.find((model) => model.id === settings.model) ?? null)
      : null,
  );

  /** The gate the main process applies, mirrored here for the UI only. */
  const needsKeyForModel = $derived(openCodeModelRequiresKey(selectedModel ?? undefined) && !hasKey);

  const freeModels = $derived(openCodeModels?.filter((m) => m.pricing === "free") ?? []);
  const paidModels = $derived(openCodeModels?.filter((m) => m.pricing === "paid") ?? []);
  const unknownModels = $derived(openCodeModels?.filter((m) => m.pricing === "unknown") ?? []);

  $effect(() => {
    onmodelinfo?.(selectedModel);
  });

  /** `mimo-v2.5-free · 262k ctx · images` */
  function describe(model: OpenCodeModelInfo): string {
    const bits: string[] = [model.name];
    if (model.contextTokens) {
      bits.push(t("provider.contextTokens", { count: Math.round(model.contextTokens / 1000) }));
    }
    if (model.imageInput === "yes") {
      bits.push(t("provider.images"));
    }
    if (model.pricing === "paid" && model.cost) {
      bits.push(t("provider.cost", { input: model.cost.input, output: model.cost.output }));
    }
    return bits.join(" · ");
  }

  $effect(() => {
    if (!bridgeAvailable) {
      return;
    }
    if (settings.provider !== "OpenCode") {
      openCodeModels = null;
      openCodeFetchFailed = false;
      return;
    }
    let cancelled = false;
    void api().listOpenCodeModels().then((models) => {
      if (cancelled) return;
      openCodeModels = models;
      openCodeFetchFailed = models === null;
      // component.py:251-255 -- prefer mimo-v2.5-free when the list contains it.
      if (models && !models.some((model) => model.id === settings.model)) {
        const preferred = models.find((model) => model.id === "mimo-v2.5-free") ?? models[0];
        if (preferred) onchange({ model: preferred.id });
      }
    });
    return () => {
      cancelled = true;
    };
  });

  function selectProvider(provider: Provider): void {
    // component.py:239-243 reset the model box to the provider's default.
    onchange({ provider, model: PROVIDER_DEFAULT_MODEL[provider] });
    keyDraft = "";
  }

  async function saveKey(): Promise<void> {
    saving = true;
    try {
      await onsavekey(settings.provider, keyDraft);
      keyDraft = "";
    } finally {
      saving = false;
    }
  }
</script>

<fieldset>
  <legend>{t("provider.legend")}</legend>

  <div class="row">
    <div>
      <label for="provider">{t("provider.provider")}</label>
      <select
        id="provider"
        value={settings.provider}
        onchange={(event) => selectProvider(event.currentTarget.value as Provider)}
      >
        {#each PROVIDERS as provider (provider)}
          <option value={provider}>{provider}</option>
        {/each}
      </select>
    </div>

    <div>
      <label for="model">{t("provider.model")}</label>
      {#if settings.provider === "OpenCode" && openCodeModels}
        <select
          id="model"
          value={settings.model}
          onchange={(event) => onchange({ model: event.currentTarget.value })}
        >
          <!--
            Grouped by what the user has to do to use them, not alphabetically:
            the free models are the ones that work with no setup at all, so
            they belong at the top and visibly separated.
          -->
          {#if freeModels.length > 0}
            <optgroup label={t("provider.free", { count: freeModels.length })}>
              {#each freeModels as model (model.id)}
                <option value={model.id}>{describe(model)}</option>
              {/each}
            </optgroup>
          {/if}
          {#if paidModels.length > 0}
            <optgroup label={t("provider.paid", { count: paidModels.length })}>
              {#each paidModels as model (model.id)}
                <option value={model.id}>{describe(model)}</option>
              {/each}
            </optgroup>
          {/if}
          {#if unknownModels.length > 0}
            <optgroup label={t("provider.unknownPricing", { count: unknownModels.length })}>
              {#each unknownModels as model (model.id)}
                <option value={model.id}>{describe(model)}</option>
              {/each}
            </optgroup>
          {/if}
        </select>
        {#if selectedModel}
          <p class="hint">
            {t("provider.modelSummary", {
              id: selectedModel.id,
              count: openCodeModels.length,
            })}
            {#if selectedModel.imageInput === "no"}
              {t("provider.textOnly")}
            {:else if selectedModel.imageInput === "unknown"}
              {t("provider.imageUnknown")}
            {/if}
          </p>
        {/if}
      {:else}
        <input
          id="model"
          value={settings.model}
          placeholder={PROVIDER_DEFAULT_MODEL[settings.provider]}
          oninput={(event) => onchange({ model: event.currentTarget.value })}
        />
        {#if openCodeFetchFailed}
          <p class="hint">{t("provider.fetchFailed")}</p>
        {/if}
      {/if}
    </div>
  </div>

  {#if settings.provider === "Custom (OpenAI Compatible)"}
    <div class="field">
      <label for="base-url">{t("provider.baseUrl")}</label>
      <input
        id="base-url"
        value={settings.baseUrl}
        placeholder="https://api.openai.com/v1"
        oninput={(event) => onchange({ baseUrl: event.currentTarget.value })}
      />
    </div>
  {/if}

  <div class="field">
    <label for="api-key">
      {providerRequiresApiKey(settings.provider)
        ? t("provider.apiKey")
        : t("provider.apiKeyOptional")}
    </label>
    <div class="key-row">
      <input
        id="api-key"
        type="password"
        autocomplete="off"
        bind:value={keyDraft}
        placeholder={hasKey ? t("provider.keyStoredPlaceholder") : t("provider.keyPlaceholder")}
      />
      <button onclick={saveKey} disabled={saving || keyDraft.trim() === ""}>{t("common.save")}</button>
      <button onclick={() => onclearkey(settings.provider)} disabled={!hasKey}>
        {t("common.clear")}
      </button>
    </div>
    {#if needsKeyForModel}
      <p class="hint warn">{t("provider.needsKey", { model: selectedModel?.name ?? "" })}</p>
    {/if}
    {#if hasKey}
      <p class="hint ok">{t("provider.keyStored", { provider: settings.provider })}</p>
    {/if}
    {#if keyStatus && !keyStatus.encryptionAvailable}
      <p class="hint warn">{t("provider.noEncryption")}</p>
    {/if}
  </div>
</fieldset>

<style>
  .key-row {
    display: flex;
    gap: 8px;
  }

  .key-row input {
    flex: 1;
  }

  .ok {
    color: var(--ok);
  }

  .warn {
    color: var(--warn);
  }
</style>
