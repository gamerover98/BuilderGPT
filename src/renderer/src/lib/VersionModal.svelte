<script lang="ts">
  /**
   * Which Minecraft this schematic is for.
   *
   * There was no way to change it. A version could be chosen at New and stamped
   * at Save As, and nothing in between — so saying "this is a 1.12 schematic"
   * about a file that arrived carrying no tag meant a Save As, and so did going
   * from 1.21 to 1.16.
   *
   * ## Why the versions the container cannot carry are shown anyway
   *
   * `SchematicDialog` filters its container list by the version, because there
   * the two are chosen together and the format is free to follow. Here it is
   * not: the version changes and the container stays, since `doc.format` is
   * what a plain Save writes back and flipping it under an open file would
   * leave the next Ctrl+S writing MCEdit bytes into something still called
   * `.schem`.
   *
   * So the impossible rows are **shown, disabled and explained** rather than
   * missing. Somebody who opens this looking for 1.12.2 on a `.schem` needs to
   * read why it is not there; a list that silently stops at 1.13 reads as a
   * build that has never heard of 1.12, and sends them looking for a setting
   * that does not exist. The explanation names the two verbs that *can* do it.
   */
  import { MC_VERSIONS, formatSupportsVersion, mcVersion, refusalFor } from "../../../shared/mc_versions.js";
  import { SCHEMATIC_FORMAT_LABEL, type SchematicFormat } from "../../../shared/schematic.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    open: boolean;
    /** The container the document is in; it is a fact here, not a choice. */
    format: SchematicFormat;
    /** The version to start on, or `""` when the file names none. */
    current: string;
    busy: boolean;
    /** A failure from main, shown here: the app banner is behind the scrim. */
    error: string;
    /**
     * Whether main has already refused this change for destroying blocks.
     *
     * Drives the second button rather than a checkbox, for `DimensionsModal`'s
     * reason: the count cannot be known until main has looked, so the offer to
     * go ahead can only exist *after* a refusal. Owned by the parent because
     * only the parent sees the response.
     */
    needsConfirmation: boolean;
    onapply: (version: string, dropUnrepresentable: boolean) => void;
    onclose: () => void;
  }

  const { open, format, current, busy, error, needsConfirmation, onapply, onclose }: Props =
    $props();

  let version = $state("");
  let dialog = $state<HTMLDivElement | null>(null);

  /**
   * Re-seeded every time it opens, not once at construction.
   *
   * `SchematicDialog`'s rule: the component stays mounted between openings, so
   * a field set from `current` at construction would show the first document's
   * version forever.
   */
  $effect(() => {
    if (!open) return;
    version = current;
    // Over the viewport, where the canvas may hold the pointer.
    document.exitPointerLock();
    dialog?.focus();
  });

  const refused = $derived(version === "" ? null : refusalFor(format, version));
  const changed = $derived(version !== "" && version !== current);

  /**
   * Whether this is a backport, which is the only direction that can lose
   * anything.
   *
   * This used to carry a disclaimer instead: going back within the flat era
   * changed the tag and nothing else, because there was no per-block record of
   * which release each block arrived in, and the panel said so rather than
   * imply a check it did not make. `block_versions.json` is that record, so
   * the sentence is now about what will happen rather than about what cannot
   * be known.
   */
  const target = $derived(version === "" ? undefined : mcVersion(version));
  const backport = $derived(
    target !== undefined &&
      target.era === "flat" &&
      current !== "" &&
      (mcVersion(current)?.dataVersion ?? 0) > (target.dataVersion ?? 0),
  );

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    }
  }
</script>

{#if open}
  <div
    class="scrim"
    role="presentation"
    onkeydown={onKeydown}
    onclick={(event) => {
      if (event.target === event.currentTarget) onclose();
    }}
  >
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label={t("mcversion.title")}
      tabindex="-1"
      bind:this={dialog}
    >
      <h2>{t("mcversion.title")}</h2>

      <p class="hint fact">
        {t("mcversion.container", { format: SCHEMATIC_FORMAT_LABEL[format] })}
      </p>

      <label class="row">
        <span>{t("doc.version")}</span>
        <select bind:value={version} disabled={busy}>
          {#if current === ""}
            <option value="">{t("mcversion.unstated")}</option>
          {/if}
          {#each MC_VERSIONS as option (option.name)}
            <!--
              Disabled rather than absent. The list is the same in every
              container, so what is missing from one is a fact about the
              container and needs saying, not hiding.
            -->
            <option value={option.name} disabled={!formatSupportsVersion(format, option.name)}>
              {option.label}{option.era === "legacy" ? ` — ${t("doc.legacyEra")}` : ""}
            </option>
          {/each}
        </select>
      </label>

      {#if refused}
        <p class="hint warn">{refused}</p>
        <p class="hint">{t("mcversion.useSaveAs")}</p>
      {:else if backport}
        <p class="hint">{t("mcversion.backport")}</p>
      {:else if target?.era === "legacy"}
        <p class="hint">{t("mcversion.toLegacy")}</p>
      {/if}

      {#if error}
        <p class="hint warn">{error}</p>
      {/if}

      <div class="buttons">
        <button onclick={onclose} disabled={busy}>{t("common.cancel")}</button>
        {#if needsConfirmation}
          <!--
            Only after a refusal, and only ever the second press. The count in
            the message above is what this is agreeing to, and it could not be
            known before main looked.
          -->
          <button class="primary" onclick={() => onapply(version, true)} disabled={busy}>
            {t("mcversion.applyAnyway")}
          </button>
        {:else}
          <button
            class="primary"
            onclick={() => onapply(version, false)}
            disabled={busy || !changed || refused !== null}
          >
            {t("mcversion.apply")}
          </button>
        {/if}
      </div>
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
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(420px, calc(100vw - 48px));
    padding: 18px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-panel);
    box-shadow: 0 16px 48px var(--shadow);
    outline: none;
  }

  h2 {
    margin: 0;
    font-size: 15px;
  }

  .row {
    display: grid;
    grid-template-columns: 90px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  select {
    width: 100%;
    min-width: 0;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text);
    font: inherit;
  }

  .hint {
    margin: 0;
    font-size: 11px;
    color: var(--text-dim);
  }

  .hint.warn,
  .hint.fact {
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--bg-input);
  }

  .hint.warn {
    color: var(--text);
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 2px;
  }
</style>
