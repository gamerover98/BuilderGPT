<script lang="ts">
  /**
   * The open schematic's own version history, and the way back to one.
   *
   * The Generate tab used to hold the generator form and a list of every file
   * the generator had ever produced — global, across every schematic, which
   * meant it said nothing about the one on screen. This says something about
   * the one on screen: what it has been, and how to go back.
   *
   * A generation replaces everything that was open. That makes it the single
   * most destructive thing the app does, and the one place a way back is worth
   * the disk it costs.
   *
   * Distinct from the chat's "go back to before this question": those belong to
   * a conversation and die with it, and only ever cover agent turns. These
   * belong to the *file* and outlive the conversation, the session, and the app
   * being closed.
   */
  import type { DocumentVersion } from "../../../shared/ipc.js";
  import { ageLabel } from "./age_label.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    versions: readonly DocumentVersion[];
    busy: boolean;
    /**
     * Whether the open document has a file yet.
     *
     * The key is the path, so an unsaved document has nowhere to keep a
     * history. Saying so beats an empty list that looks broken.
     */
    saved: boolean;
    onsave: () => void;
    onrestore: (id: string) => void;
    ondelete: (id: string) => void;
  }

  const { versions, busy, saved, onsave, onrestore, ondelete }: Props = $props();

  /** Which row is asking "are you sure" — restoring cannot be undone. */
  let confirming = $state<string | null>(null);
</script>

<!--
  No `<fieldset>` and no legend: this lives inside `VersionsModal`, whose header
  already says what it is. It carried both while it was a floating tool window,
  which drew a second border and a second copy of the same heading inside the
  first — exactly what `InspectorPanel` renounced its own chrome to avoid.
-->
  {#if !saved}
    <p class="hint">{t("versions.unsaved")}</p>
  {:else}
    <div class="buttons">
      <button onclick={onsave} disabled={busy}>{t("versions.save")}</button>
    </div>

    {#if versions.length === 0}
      <p class="hint">{t("versions.empty")}</p>
    {:else}
      <ul>
        {#each versions as version (version.id)}
          <li>
            <div class="row">
              <span class="label" title={version.label}>{version.label}</span>
              <span class="when">{ageLabel(version.at)}</span>
            </div>
            <div class="row">
              <span class="facts">
                {t(`versions.source.${version.source}`)}
                · {version.size.join("×")}
                · {t("bar.blocks", { count: version.blockCount.toLocaleString() })}
              </span>
              {#if confirming === version.id}
                <span class="confirm">
                  <button class="danger" onclick={() => { confirming = null; onrestore(version.id); }} disabled={busy}>
                    {t("versions.confirmRestore")}
                  </button>
                  <button onclick={() => (confirming = null)} disabled={busy}>
                    {t("common.cancel")}
                  </button>
                </span>
              {:else}
                <span class="actions">
                  <!-- Confirmed, because adopting a document starts a fresh
                       history: this is not something an undo can walk back. The
                       safety net is that main snapshots the state being left,
                       so it is a fork rather than a one-way door. -->
                  <button onclick={() => (confirming = version.id)} disabled={busy}>
                    {t("versions.restore")}
                  </button>
                  <button
                    class="icon"
                    onclick={() => ondelete(version.id)}
                    disabled={busy}
                    title={t("versions.delete")}
                    aria-label={t("versions.delete")}
                  >
                    &#x00d7;
                  </button>
                </span>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      <p class="hint">{t("versions.note")}</p>
    {/if}
  {/if}

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    padding: 6px 0;
    border-top: 1px solid var(--border);
  }

  li:first-child {
    border-top: none;
  }

  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .when,
  .facts {
    flex: none;
    color: var(--text-dim);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .facts {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions,
  .confirm {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
  }

  .actions button,
  .confirm button {
    padding: 2px 7px;
    font-size: 11px;
  }

  /* The one destructive control here, coloured like the risk it carries. */
  .danger {
    border-color: var(--danger);
    color: var(--danger);
  }

  .buttons {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }
</style>
