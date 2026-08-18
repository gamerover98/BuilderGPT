<script lang="ts">
  /**
   * Replaces the "added to Artifact Center" affordance (component.py:400),
   * which pointed at a host-framework panel that no longer exists. Backed by
   * `main/services/artifacts.ts`.
   */
  import type { Artifact } from "../../../shared/ipc.js";
  import { api } from "./bridge.svelte.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    artifacts: Artifact[];
    onselect: (artifact: Artifact) => void;
  }

  const { artifacts, onselect }: Props = $props();
</script>

<fieldset>
  <legend>{t("artifacts.legend")}</legend>
  {#if artifacts.length === 0}
    <p class="hint">{t("artifacts.empty")}</p>
  {:else}
    <ul>
      {#each artifacts as artifact (artifact.path)}
        <li>
          <div class="meta">
            <span class="badge">{artifact.type}</span>
            <span class="name" title={artifact.path}>{artifact.name}</span>
          </div>
          <div class="actions">
            {#if artifact.type === "schem"}
              <button onclick={() => onselect(artifact)}>{t("artifacts.preview")}</button>
            {/if}
            <button onclick={() => api().revealPath(artifact.path)}>{t("artifacts.reveal")}</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</fieldset>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 220px;
    overflow-y: auto;
  }

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
  }

  li:last-child {
    border-bottom: none;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badge {
    flex: none;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
  }

  .actions {
    display: flex;
    gap: 6px;
    flex: none;
  }

  .actions button {
    padding: 4px 10px;
    font-size: 12px;
  }
</style>
