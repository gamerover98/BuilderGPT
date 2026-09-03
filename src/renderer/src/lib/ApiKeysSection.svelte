<script lang="ts">
  /**
   * A stored API key for each provider, not just the one in use.
   *
   * The old panel showed a single key row belonging to whichever provider was
   * selected, which made "have I set up Gemini?" a question you answered by
   * switching provider and looking. Keys are account-level facts, not part of
   * the current job, so all four live here together and switching provider in
   * the chat no longer changes what you can see.
   *
   * This component only ever learns *whether* a key exists. `safeStorage`
   * encrypts them main-side and `ProviderKeyStatus` carries a boolean; there is
   * no channel that would hand the key back to this window.
   */
  import {
    PROVIDERS,
    PROVIDER_DEFAULT_BASE_URL,
    providerRequiresApiKey,
    type KeyStorageStatus,
    type Provider,
    type Settings,
  } from "../../../shared/settings.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    settings: Settings;
    keyStatus: KeyStorageStatus | null;
    onchange: (patch: Partial<Settings>) => void;
    onsavekey: (provider: Provider, apiKey: string) => Promise<void>;
    onclearkey: (provider: Provider) => Promise<void>;
    /** Opens a folder in the OS file browser. Used for the orphaned profile. */
    onrevealpath: (target: string) => void;
  }

  const { settings, keyStatus, onchange, onsavekey, onclearkey, onrevealpath }: Props =
    $props();

  /** Per-provider draft, so typing into one row does not disturb another. */
  let drafts = $state<Record<string, string>>({});
  let saving = $state<Provider | null>(null);

  function hasKey(provider: Provider): boolean {
    return keyStatus?.keys.find((entry) => entry.provider === provider)?.hasKey ?? false;
  }

  async function save(provider: Provider): Promise<void> {
    const key = (drafts[provider] ?? "").trim();
    if (key === "") return;
    saving = provider;
    try {
      await onsavekey(provider, key);
      drafts = { ...drafts, [provider]: "" };
    } finally {
      saving = null;
    }
  }
</script>

{#if keyStatus && !keyStatus.encryptionAvailable}
  <p class="hint warn">{t("provider.noEncryption")}</p>
{/if}

<!--
  The keys the 1.0.0 rename left behind. `app.getName()` names the userData
  directory, so the rename started the app on an empty profile and nothing
  migrates -- which is a defensible decision that was taken in silence, and
  the silence is what cost: generation stopped, and what surfaced was the
  provider saying the key was invalid. It was not invalid, it was next door.

  Shown here because this is where somebody comes to fix it, with the folder
  one click away.
-->
{#if keyStatus?.legacyProfile}
  <p class="hint warn">
    {t("provider.legacyProfile", {
      providers: keyStatus.legacyProfile.providers.join(", "),
      path: keyStatus.legacyProfile.path,
    })}
  </p>
  <button onclick={() => onrevealpath(keyStatus?.legacyProfile?.path ?? "")}>
    {t("provider.legacyProfileReveal")}
  </button>
{/if}

{#each PROVIDERS as provider (provider)}
  <div class="field">
    <label for={`key-${provider}`}>
      {provider}{providerRequiresApiKey(provider) ? "" : ` — ${t("provider.apiKeyOptional")}`}
    </label>
    <div class="key-row">
      <input
        id={`key-${provider}`}
        type="password"
        autocomplete="off"
        value={drafts[provider] ?? ""}
        placeholder={hasKey(provider)
          ? t("provider.keyStoredPlaceholder")
          : t("provider.keyPlaceholder")}
        oninput={(event) => (drafts = { ...drafts, [provider]: event.currentTarget.value })}
      />
      <button
        onclick={() => save(provider)}
        disabled={saving !== null || (drafts[provider] ?? "").trim() === ""}
      >
        {t("common.save")}
      </button>
      <button onclick={() => onclearkey(provider)} disabled={!hasKey(provider)}>
        {t("common.clear")}
      </button>
    </div>
    {#if hasKey(provider)}
      <p class="hint ok">{t("provider.keyStored", { provider })}</p>
    <!--
      A key is on disk and this machine cannot read it back -- a keyring that
      changed, or a profile copied to another machine. Said out loud, because
      the alternative is what was reported: the pane claimed the key was
      saved, every caller got an empty string, and the provider answered
      `Invalid API key.` with nothing pointing here.
    -->
    {:else if keyStatus?.keys.find((entry) => entry.provider === provider)?.unreadable}
      <p class="hint warn">{t("provider.keyUnreadable", { provider })}</p>
    {/if}
  </div>
{/each}

<div class="field">
  <label for="base-url">{t("provider.baseUrl")}</label>
  <input
    id="base-url"
    value={settings.baseUrl}
    placeholder={PROVIDER_DEFAULT_BASE_URL[settings.provider] || "https://api.openai.com/v1"}
    oninput={(event) => onchange({ baseUrl: event.currentTarget.value })}
  />
  <p class="hint">{t("provider.baseUrlHint")}</p>
</div>

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
