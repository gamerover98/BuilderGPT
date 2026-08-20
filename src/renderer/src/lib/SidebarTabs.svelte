
<script lang="ts">
  /**
   * Which of the two panels the sidebar is showing.
   *
   * The column used to stack all of them and scroll. That was survivable at
   * three fieldsets and stopped being so at six: the chat -- the thing you use
   * most -- sat in the middle with its input drifting off-screen, and finding
   * anything meant scrolling past everything else.
   *
   * The second was called Schematic, which was the honest name for a drawer
   * holding three unrelated things: the file verbs, the generator form, and the
   * list of files it had produced. The file verbs have a menu and a start
   * screen now, so what is left is one thing and is named after it.
   *
   * The type itself lives in `shared/settings.ts`, not here, because the choice
   * is persisted and `coerceUi` in main has to validate it.
   *
   * There were three tabs, and the third was Inspector. It has moved out to a
   * floating window over the canvas, because it is not the same *kind* of thing
   * as the other two: Chat is a place you stay and Schematic is a drawer you
   * visit, while the inspector only ever reflects the block you just clicked.
   * The badge it needed here is the tell -- a tab that has to announce "there is
   * something here now" is blank the rest of the time, and being mutually
   * exclusive with the chat meant looking at a block cost you the conversation.
   */
  import type { SidebarTab } from "../../../shared/settings.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    active: SidebarTab;
    onselect: (tab: SidebarTab) => void;
  }

  const { active, onselect }: Props = $props();

  const TABS: readonly { id: SidebarTab; key: string }[] = [
    { id: "chat", key: "tabs.chat" },
    { id: "generate", key: "tabs.generate" },
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

</style>
