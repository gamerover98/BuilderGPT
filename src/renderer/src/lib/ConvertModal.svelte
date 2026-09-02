<script lang="ts">
  /**
   * One file into another, without opening either.
   *
   * The only panel here that is **not** about the open document, which is why
   * it is the one whose button is never disabled: converting a `.litematic`
   * somebody sent you is a thing to do before there is anything open at all.
   *
   * It does not preview. The costs a conversion can have -- a block MCEdit
   * cannot spell, an anchor Litematica has nowhere to keep, entities a
   * `.mcfunction` cannot summon -- are all facts about the *source*, and this
   * has not read it. Main reports them afterwards, by name, and nothing is
   * overwritten in the meantime, so the honest order is convert-then-say rather
   * than a promise made from a filename.
   */
  import { FILE_KINDS, FILE_KIND_LABEL, type FileKind } from "../../../shared/ipc.js";
  import { MC_VERSION_NAMES, mcVersion, refusalFor } from "../../../shared/mc_versions.js";
  import type { SchematicFormat } from "../../../shared/schematic.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    open: boolean;
    busy: boolean;
    /** Main's wording for whatever it refused, shown inside the modal. */
    error: string;
    /** What the last run wrote, so the panel can say it landed. */
    report: string;
    onpicksource: () => void;
    onpicktarget: (format: FileKind) => void;
    source: string;
    target: string;
    onconvert: (request: {
      source: string;
      target: string;
      format: FileKind;
      version?: string;
    }) => void;
    onclose: () => void;
  }

  const {
    open,
    busy,
    error,
    report,
    onpicksource,
    onpicktarget,
    source,
    target,
    onconvert,
    onclose,
  }: Props = $props();

  let dialog = $state<HTMLDivElement | null>(null);
  let format = $state<FileKind>("sponge3");
  /** Empty means "whatever the source says", which is what a conversion wants. */
  let version = $state<string>("");

  /**
   * A container cannot hold every version, and the rule is not this panel's.
   *
   * `formatsFor` is the same function the New and Save As dialogs ask, so a
   * `.litematic` is refused for 1.13 here for the reason it is refused there:
   * Litematica converts the palette of anything older than 1.13.2. A
   * `.mcfunction` is not in that table at all -- it is not a container -- and
   * carries no version tag, so it accepts any of them.
   */
  const refusal = $derived.by(() => {
    if (version === "" || format === "mcfunction") return null;
    return refusalFor(format as SchematicFormat, version);
  });

  const ready = $derived(source !== "" && target !== "" && refusal === null && !busy);

  function apply(): void {
    if (!ready) return;
    onconvert({
      source,
      target,
      format,
      ...(version === "" ? {} : { version }),
    });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onclose();
    }
  }

  $effect(() => {
    if (open) dialog?.focus();
  });

</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={onclose} onkeydown={onKeydown}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={dialog}
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label={t("convert.title")}
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={onKeydown}
    >
      <header>
        <h2>{t("convert.title")}</h2>
        <button class="icon" onclick={onclose} aria-label={t("common.close")}>&times;</button>
      </header>

      <p class="hint">{t("convert.hint")}</p>

      <fieldset>
        <legend>{t("convert.from")}</legend>
        <div class="row">
          <input type="text" readonly value={source} placeholder={t("convert.nothing")} />
          <button onclick={onpicksource} disabled={busy}>{t("convert.browse")}</button>
        </div>
      </fieldset>

      <fieldset>
        <legend>{t("convert.to")}</legend>
        <label class="field">
          <span>{t("convert.format")}</span>
          <select bind:value={format} disabled={busy}>
            {#each FILE_KINDS as option (option)}
              <option value={option}>{FILE_KIND_LABEL[option]}</option>
            {/each}
          </select>
        </label>

        <!--
          Blank first, and it is the default: a conversion keeps whatever the
          source said unless somebody means to change it. Stamping the newest
          version on a file cut from 1.16 would be a claim nobody made.
        -->
        <label class="field">
          <span>{t("convert.version")}</span>
          <select bind:value={version} disabled={busy || format === "mcfunction"}>
            <option value="">{t("convert.keepVersion")}</option>
            {#each MC_VERSION_NAMES as name (name)}
              <option value={name}>{mcVersion(name)?.label ?? name}</option>
            {/each}
          </select>
        </label>

        <div class="row">
          <input type="text" readonly value={target} placeholder={t("convert.nothing")} />
          <button onclick={() => onpicktarget(format)} disabled={busy}>
            {t("convert.browse")}
          </button>
        </div>

        {#if refusal !== null}
          <p class="warn">{refusal}</p>
        {/if}
      </fieldset>

      {#if error !== ""}
        <p class="error">{error}</p>
      {/if}
      {#if report !== ""}
        <p class="report">{report}</p>
      {/if}

      <footer>
        <button onclick={onclose}>{t("common.close")}</button>
        <button class="primary" disabled={!ready} onclick={apply}>{t("convert.apply")}</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--scrim);
  }

  .modal {
    width: min(520px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
    overflow: auto;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
    box-shadow: 0 18px 48px var(--shadow);
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }

  h2 {
    flex: 1 1 auto;
    margin: 0;
    font-size: 15px;
  }

  .icon {
    padding: 2px 8px;
    border: none;
    background: transparent;
    font-size: 18px;
    line-height: 1;
  }

  .hint {
    margin: 0 0 12px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-dim);
  }

  fieldset {
    margin: 0 0 12px;
    padding: 10px 12px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  legend {
    padding: 0 4px;
    font-size: 12px;
    color: var(--text-dim);
  }

  .row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .row input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 4px 6px;
    font-size: 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-bottom: 8px;
    font-size: 12px;
  }

  .field select {
    padding: 4px 6px;
  }

  .warn {
    margin: 10px 0 0;
    font-size: 12px;
    color: var(--warn);
  }

  .error {
    margin: 0 0 12px;
    font-size: 12px;
    color: var(--danger);
  }

  .report {
    margin: 0 0 12px;
    font-size: 12px;
    color: var(--text-dim);
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .primary {
    background: var(--accent);
    color: var(--accent-contrast);
    border-color: var(--accent);
  }
</style>
