<script lang="ts">
  /**
   * The chat input: one bordered box holding the textarea, what the request
   * will act on, and the model it will go to.
   *
   * Pinned to the bottom of the panel with the log scrolling above it, which is
   * the arrangement every chat converges on and the one this replaces did not
   * have -- the old prompt box sat in the middle of a scrolling column and went
   * off-screen as the conversation grew.
   *
   * The context chip replaces a `<label>` that read "Acts on your selection
   * unless you say otherwise". Same fact, but as a chip it reads as part of the
   * request being composed rather than as instructions about it, and it can
   * carry the actual size.
   */
  import type { RegionSpec } from "../../../shared/ipc.js";
  import type { KeyStorageStatus, Settings } from "../../../shared/settings.js";
  import { t } from "./i18n.svelte.js";
  import ModelPicker from "./ModelPicker.svelte";

  interface Props {
    selection: RegionSpec | null;
    busy: boolean;
    enabled: boolean;
    settings: Settings;
    keyStatus: KeyStorageStatus | null;
    /**
     * The half-written message.
     *
     * Owned by `App.svelte` rather than held here, and that is not tidiness.
     * Switching sidebar tabs unmounts this component, so a draft living in it
     * would be thrown away by a glance at the Schematic tab -- which is exactly
     * the sort of thing someone does mid-sentence to check a block name.
     */
    draft: string;
    ondraftchange: (draft: string) => void;
    onask: (prompt: string) => void;
    onstop: () => void;
    onsettingschange: (patch: Partial<Settings>) => void;
    onopensettings: () => void;
  }

  const {
    selection,
    busy,
    enabled,
    settings,
    keyStatus,
    draft,
    ondraftchange,
    onask,
    onstop,
    onsettingschange,
    onopensettings,
  }: Props = $props();

  let input = $state<HTMLTextAreaElement | undefined>(undefined);

  const volume = $derived(
    selection === null
      ? 0
      : (selection.maxX - selection.minX + 1) *
          (selection.maxY - selection.minY + 1) *
          (selection.maxZ - selection.minZ + 1),
  );

  /**
   * Grows with the text, up to a point.
   *
   * Height has to be reset to `auto` before reading `scrollHeight`, or the box
   * only ever grows: `scrollHeight` of an element already tall enough is its
   * own height, so it would latch at each maximum and never shrink back.
   */
  function autosize(): void {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  $effect(() => {
    void draft;
    autosize();
  });

  function submit(): void {
    const prompt = draft.trim();
    if (prompt === "" || busy || !enabled) return;
    ondraftchange("");
    onask(prompt);
  }

  function onKeydown(event: KeyboardEvent): void {
    // Enter sends, Shift+Enter breaks the line -- the convention everywhere.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }
</script>

<div class="composer" class:disabled={!enabled}>
  <textarea
    bind:this={input}
    value={draft}
    oninput={(event) => ondraftchange(event.currentTarget.value)}
    onkeydown={onKeydown}
    placeholder={enabled ? t("chat.placeholder") : t("chat.needDocument")}
    disabled={!enabled}
    rows="1"
    aria-label={t("chat.legend")}
  ></textarea>

  <div class="context">
    {#if selection}
      <span class="chip" title={t("chat.actsOnSelection")}>
        #selection
        <em>
          {selection.maxX - selection.minX + 1}×{selection.maxY - selection.minY + 1}×{selection.maxZ -
            selection.minZ +
            1}
          · {volume.toLocaleString()}
        </em>
      </span>
    {:else}
      <span class="chip dim" title={t("chat.actsOnAll")}>#whole-schematic</span>
    {/if}
  </div>

  <div class="actions">
    <ModelPicker {settings} {keyStatus} onchange={onsettingschange} {onopensettings} />
    {#if busy}
      <!--
        Never disabled. A Stop that is greyed out while the thing it stops is
        running is the one state this button must not have.
      -->
      <button class="send stop" onclick={onstop} title={t("chat.stopHint")}>
        {t("chat.stop")}
      </button>
    {:else}
      <button
        class="send primary"
        onclick={submit}
        disabled={!enabled || draft.trim() === ""}
        aria-label={t("chat.send")}
        title={t("chat.send")}
      >
        &#x27a4;
      </button>
    {/if}
  </div>
</div>

<style>
  .composer {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "text text"
      "context actions";
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-input);
  }

  .composer:focus-within {
    border-color: var(--accent);
  }

  .composer.disabled {
    opacity: 0.65;
  }

  textarea {
    grid-area: text;
    width: 100%;
    min-height: 22px;
    max-height: 180px;
    padding: 2px 4px;
    border: none;
    background: none;
    resize: none;
    overflow-y: auto;
  }

  textarea:focus {
    outline: none;
  }

  .context {
    grid-area: context;
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-panel);
    font-size: 11px;
    color: var(--accent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip.dim {
    color: var(--text-dim);
  }

  .chip em {
    font-style: normal;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .actions {
    grid-area: actions;
    display: flex;
    align-items: center;
    gap: 4px;
    justify-content: flex-end;
  }

  .send {
    flex: none;
    padding: 4px 12px;
    font-size: 13px;
    line-height: 1.2;
  }
</style>
