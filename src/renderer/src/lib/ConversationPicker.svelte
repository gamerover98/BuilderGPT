<script lang="ts">
  /**
   * Which conversation about this schematic you are looking at.
   *
   * A button naming the current one, opening a list of the rest. The list is
   * fetched when the popover opens rather than held: conversations change from
   * main's side — a turn retitles one, a save reorders them — and a list kept
   * in the renderer would be a second copy going quietly stale.
   *
   * Positioned by `placePopover`, not by CSS. Every panel between here and
   * `<body>` is `overflow: hidden`, and this control sits at the top of the
   * right-hand column, so a popover laid out from its trigger is either clipped
   * by an ancestor or off the screen — which is exactly the bug the model
   * picker had before that function existed.
   */
  import type { ConversationSummary } from "../../../shared/ipc.js";
  import { ageLabel } from "./age_label.js";
  import { placePopover } from "./floating.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    conversations: ConversationSummary[];
    activeId: string;
    busy: boolean;
    /** Fetches the list; called when the popover opens. */
    onrefresh: () => void;
    onopen: (id: string) => void;
    ondelete: (id: string) => void;
  }

  const { conversations, activeId, busy, onrefresh, onopen, ondelete }: Props = $props();

  let open = $state(false);
  let root: HTMLDivElement | null = null;
  let trigger = $state<HTMLButtonElement | null>(null);
  let panel = $state<HTMLDivElement | null>(null);
  let placement = $state<{ x: number; y: number } | null>(null);
  let innerWidth = $state(0);
  let innerHeight = $state(0);

  const active = $derived(conversations.find((one) => one.id === activeId) ?? null);
  const label = $derived(
    active === null || active.entryCount === 0 ? t("chat.newChat") : active.title,
  );

  function toggle(): void {
    open = !open;
    if (open) onrefresh();
  }

  function onWindowClick(event: MouseEvent): void {
    // The popover is `position: fixed` but still a child of `root`, so this
    // stays a plain containment test rather than needing a portal.
    if (root && !root.contains(event.target as Node)) open = false;
  }

  /** Measure, then place. Rendered hidden for one flush; an `$effect` runs
      after the DOM updates and before paint, so there is nothing to see. */
  $effect(() => {
    if (!open || !panel || !trigger) {
      placement = null;
      return;
    }
    // The list arriving changes the popover's height, so re-place on it.
    void conversations;

    const anchor = trigger.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    placement = placePopover(
      { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height },
      {
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        popoverWidth: box.width,
        popoverHeight: box.height,
        margin: 8,
        gap: 6,
      },
    );
  });
</script>

<svelte:window onclick={onWindowClick} bind:innerWidth bind:innerHeight />

<div class="picker" bind:this={root}>
  <button
    class="trigger"
    bind:this={trigger}
    onclick={toggle}
    disabled={busy}
    title={t("chat.historyHint")}
  >
    <span class="label">{label}</span>
    <span class="caret" aria-hidden="true">&#x25be;</span>
  </button>

  {#if open}
    <div
      class="popover"
      role="dialog"
      aria-label={t("chat.historyHint")}
      bind:this={panel}
      style={placement === null
        ? "visibility: hidden"
        : `left: ${placement.x}px; top: ${placement.y}px`}
    >
      {#if conversations.length === 0}
        <p class="hint">{t("chat.noHistory")}</p>
      {:else}
        <ul>
          {#each conversations as one (one.id)}
            <li class:active={one.id === activeId}>
              <button
                class="entry"
                onclick={() => {
                  open = false;
                  if (one.id !== activeId) onopen(one.id);
                }}
              >
                <span class="title">{one.entryCount === 0 ? t("chat.newChat") : one.title}</span>
                <span class="when">{ageLabel(one.updatedAt)}</span>
              </button>
              <button
                class="remove"
                title={t("chat.deleteChat")}
                aria-label={t("chat.deleteChat")}
                onclick={() => ondelete(one.id)}>&#x00d7;</button
              >
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .picker {
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
    background: var(--bg-input);
    border-radius: 6px;
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

  /* Against the window; see the note at the top of the component. */
  .popover {
    position: fixed;
    z-index: 20;
    width: min(320px, calc(100vw - 16px));
    max-height: min(420px, calc(100vh - 16px));
    overflow-y: auto;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
    box-shadow: 0 8px 28px var(--shadow);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    border-radius: 6px;
  }

  li:hover {
    background: var(--bg-input);
  }

  li.active {
    background: var(--accent-tint);
  }

  .entry {
    display: grid;
    gap: 1px;
    min-width: 0;
    padding: 6px 8px;
    border: none;
    background: none;
    text-align: left;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    color: var(--text);
  }

  .when {
    font-size: 11px;
    color: var(--text-dim);
  }

  .remove {
    flex: none;
    padding: 2px 8px;
    border: none;
    background: none;
    color: var(--text-dim);
    font-size: 14px;
    /* Hidden until the row is pointed at: a delete button on every row of a
       list you are only reading is an invitation to a mistake. */
    opacity: 0;
  }

  li:hover .remove,
  .remove:focus-visible {
    opacity: 1;
  }

  .remove:hover {
    color: var(--danger);
  }
</style>
