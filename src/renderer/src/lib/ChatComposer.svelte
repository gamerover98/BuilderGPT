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
  import type { ExportType, KeyStorageStatus, Settings } from "../../../shared/settings.js";
  import { t } from "./i18n.svelte.js";
  import ModelPicker from "./ModelPicker.svelte";

  interface Props {
    selection: RegionSpec | null;
    busy: boolean;
    /**
     * Whether there is a run that `onstop` can actually stop.
     *
     * Not the same question as `busy`, and that difference is the whole point:
     * switching conversations, restoring a checkpoint and refreshing the
     * document all set `busy`, and none of them is stoppable. Deciding the
     * button from `busy` put a Stop on screen that did nothing at all.
     */
    running: boolean;
    /** Whether a schematic is open; decides what a message means, not whether one can be sent. */
    hasDocument: boolean;
    /**
     * The reference image a *build* will be given, if any.
     *
     * Only ever consulted with nothing open, because that is the only time a
     * message goes to the generator. It used to live in a form in a sidebar tab
     * next to a second text box for the description -- which is to say the app
     * had two places to ask a model to build something, and this one already
     * had the conversation.
     */
    imageName: string | null;
    /** Whether the chosen model can read an image at all. */
    acceptsImages: boolean;
    imageHint: string;
    /**
     * Whether the chosen provider has no key.
     *
     * The generator's own button had this guard and the chat never did, so the
     * same missing key greyed one control out and let the other send a message
     * that could only come back as an error. Only one of those controls is left.
     */
    blockedOnKey: boolean;
    onpickimage: () => void;
    onclearimage: () => void;
    settings: Settings;
    keyStatus: KeyStorageStatus | null;
    /**
     * The half-written message.
     *
     * Owned by `App.svelte` rather than held here. It was tabs that made this
     * necessary -- switching one unmounted the composer and threw the draft
     * away -- and the tabs are gone, but the ownership stays: a draft is part
     * of the conversation's state, and the conversation belongs to the app.
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
    running,
    hasDocument,
    imageName,
    acceptsImages,
    imageHint,
    blockedOnKey,
    onpickimage,
    onclearimage,
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
    if (prompt === "" || busy || blockedOnKey) return;
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

<div class="composer">
  <textarea
    bind:this={input}
    value={draft}
    oninput={(event) => ondraftchange(event.currentTarget.value)}
    onkeydown={onKeydown}
    placeholder={hasDocument ? t("chat.placeholder") : t("chat.buildPlaceholder")}
    rows="1"
    aria-label={t("chat.legend")}
  ></textarea>

  <div class="context">
    {#if !hasDocument}
      <!-- Nothing to act *on*: the message describes what to make. -->
      <span class="chip dim" title={t("chat.actsAsBuild")}>#new-schematic</span>
      <!--
        And the two things a build takes that a message cannot carry by itself.
        Shown only here, because with a document open the message goes to the
        agent and neither of them means anything.
      -->
      {#if imageName === null}
        <button
          class="chip attach"
          onclick={onpickimage}
          disabled={!acceptsImages || busy}
          title={acceptsImages ? t("chat.attachImageHint") : imageHint}
        >
          &#x1f4ce; {t("chat.attachImage")}
        </button>
      {:else}
        <span class="chip" title={imageName}>
          &#x1f4ce; <em>{imageName}</em>
          <button class="clear" onclick={onclearimage} aria-label={t("common.clear")}>&#x00d7;</button>
        </span>
      {/if}
      <select
        class="format"
        value={settings.exportType}
        onchange={(event) =>
          onsettingschange({ exportType: event.currentTarget.value as ExportType })}
        title={t("chat.exportTypeHint")}
        aria-label={t("chat.exportType")}
      >
        <option value="schem">.schem</option>
        <option value="mcfunction">.mcfunction</option>
      </select>
    {:else if selection}
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
    {#if running}
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
        disabled={busy || blockedOnKey || draft.trim() === ""}
        aria-label={t("chat.send")}
        title={blockedOnKey ? t("chat.needsKey", { provider: settings.provider }) : t("chat.send")}
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
    gap: 4px;
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

  /* A chip that is also a button: same shape, so the row reads as one strip of
     small facts about the request rather than as a toolbar. */
  .chip.attach {
    color: var(--text-dim);
    cursor: pointer;
  }

  .chip.attach:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--accent);
  }

  .chip .clear {
    padding: 0 2px;
    border: none;
    background: none;
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1;
  }

  .format {
    flex: none;
    padding: 1px 4px;
    border-radius: 999px;
    font-size: 11px;
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
