<script lang="ts" module>
  export type SidebarTab = "chat" | "schematic" | "inspector";
</script>

<script lang="ts">
  /**
   * Which of the three panels the sidebar is showing.
   *
   * The column used to stack all of them and scroll. That was survivable at
   * three fieldsets and stopped being so at six: the chat -- the thing you use
   * most -- sat in the middle with its input drifting off-screen, and finding
   * anything meant scrolling past everything else.
   *
   * The badge on Inspector exists because that panel is empty until you click a
   * block, and a tab that is blank half the time looks broken. A dot when it
   * has something to show is the cheapest way to say "there is something here".
   */
  import { t } from "./i18n.svelte.js";

  interface Props {
    active: SidebarTab;
    /** True when the inspector has a block to show. */
    hasInspection: boolean;
    onselect: (tab: SidebarTab) => void;
  }

  const { active, hasInspection, onselect }: Props = $props();

  const TABS: readonly { id: SidebarTab; key: string }[] = [
    { id: "chat", key: "tabs.chat" },
    { id: "schematic", key: "tabs.schematic" },
    { id: "inspector", key: "tabs.inspector" },
  ];
</script>

<div class="tabs" role="tablist" aria-label={t("tabs.label")}>
  {#each TABS as tab (tab.id)}
    <button
      role="tab"
      aria-selected={active === tab.id}
      class:active={active === tab.id}
      onclick={() => onselect(tab.id)}
    >
      {t(tab.key)}
      {#if tab.id === "inspector" && hasInspection && active !== "inspector"}
        <span class="dot" aria-hidden="true"></span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    flex: none;
    gap: 2px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  button {
    position: relative;
    flex: 1;
    padding: 7px 6px 9px;
    border: none;
    border-radius: 0;
    background: none;
    color: var(--text-dim);
    font-size: 13px;
    /* Sits on the container's border rather than beside it, so the active tab
       covers the line instead of pushing the row down by a pixel. */
    margin-bottom: -1px;
    border-bottom: 2px solid transparent;
  }

  button:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--border);
  }

  button.active {
    color: var(--text);
    border-color: var(--accent);
  }

  .dot {
    display: inline-block;
    width: 5px;
    height: 5px;
    margin-left: 5px;
    border-radius: 50%;
    background: var(--accent);
    vertical-align: middle;
  }
</style>
