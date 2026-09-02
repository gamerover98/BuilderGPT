<script lang="ts">
  /**
   * The schematic's own NBT, as text you can edit.
   *
   * A modal rather than a `ToolWindow` for one plain reason: the tool window is
   * a fixed 232px, and this holds a whole schematic's block-entity list. It also
   * needs no persisted position and no `UiSettings` fields, which a floating
   * panel would have wanted.
   *
   * Main is the referee. This holds a string, sends a string, and shows whatever
   * came back -- the parsing, the validation and the line numbers are all on the
   * other side of the bridge, where the document is.
   */
  import {
    anchorLocation,
    originLocation,
    tagPathLabel,
    type SchematicFormat,
  } from "../../../shared/schematic.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    open: boolean;
    /** SNBT from main, refetched on open and on Revert. */
    text: string;
    /** False when the schematic was too large to offer: read-only. */
    editable: boolean;
    /** Tags left out of the text, named so the panel can say which. */
    omitted: string[];
    /** WorldEdit's Origin, or `null` when the file names none. */
    origin: [number, number, number] | null;
    /** The container, which decides where in this text the two vectors land. */
    format: SchematicFormat;
    busy: boolean;
    /** Main's wording for whatever went wrong, shown as it arrived. */
    error: string;
    onapply: (text: string) => void;
    onrevert: () => void;
    onorigin: (origin: [number, number, number] | null) => void;
    onclose: () => void;
  }

  const {
    open,
    text,
    editable,
    omitted,
    origin,
    format,
    busy,
    error,
    onapply,
    onrevert,
    onorigin,
    onclose,
  }: Props = $props();

  let dialog = $state<HTMLDivElement | null>(null);
  /** The edit in progress. Reset from `text` whenever main hands over a new one. */
  let draft = $state("");
  let originDraft = $state<[string, string, string]>(["", "", ""]);

  // Main owns the text; this mirrors it whenever a fresh one arrives, which is
  // on open and after a Revert or an Apply.
  $effect(() => {
    draft = text;
  });

  $effect(() => {
    originDraft = origin === null
      ? ["", "", ""]
      : [String(origin[0]), String(origin[1]), String(origin[2])];
  });

  // Opening over the viewport with the pointer locked leaves the camera turning
  // under the panel with no cursor to click anything with. Same rule, and the
  // same fix, as the creative inventory.
  $effect(() => {
    if (open) {
      document.exitPointerLock();
      dialog?.focus();
    }
  });

  /*
   * Where the two WorldEdit vectors are in the text below.
   *
   * Worth a line of its own because the answer is not guessable and differs
   * per container: v3 puts the anchor at the top level as `Offset` and leaves
   * `Metadata` holding only the Origin, so someone who set an anchor and then
   * went looking for a `WE*` key in `Metadata` — which is where WorldEdit's
   * *MCEdit* files keep it — finds nothing and concludes it was never written.
   */
  const anchorAt = $derived.by(() => {
    const location = anchorLocation(format);
    return location === null ? null : tagPathLabel(location);
  });
  const originAt = $derived.by(() => {
    const location = originLocation(format);
    return location === null ? null : tagPathLabel(location);
  });

  const dirty = $derived(draft !== text);
  const originComplete = $derived(
    originDraft.every((value) => value.trim() !== "" && Number.isFinite(Number(value))),
  );

  function onKeydown(event: KeyboardEvent): void {
    // Escape only. Enter belongs to the textarea -- a newline is the one key an
    // NBT editor cannot afford to have taken away from it, which is why this
    // deliberately does not copy the chat composer's Enter/Shift+Enter split.
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    }
  }

  function applyOrigin(): void {
    if (!originComplete) return;
    onorigin([Number(originDraft[0]), Number(originDraft[1]), Number(originDraft[2])]);
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
      aria-label={t("nbt.title")}
      tabindex="-1"
      bind:this={dialog}
    >
      <header>
        <h2>{t("nbt.title")}</h2>
        <button class="icon close" onclick={onclose} aria-label={t("common.close")}>&#x00d7;</button>
      </header>

      <section class="origin">
        <h3>{t("nbt.originTitle")}</h3>
        <p class="hint">{t("nbt.originHint")}</p>
        <div class="fields">
          {#each ["x", "y", "z"] as axis, index (axis)}
            <label>
              <span>{axis.toUpperCase()}</span>
              <input
                type="number"
                step="1"
                value={originDraft[index]}
                placeholder={t("nbt.originUnset")}
                disabled={busy}
                oninput={(event) => (originDraft[index] = event.currentTarget.value)}
                onkeydown={(event) => {
                  if (event.key === "Enter") applyOrigin();
                }}
              />
            </label>
          {/each}
          <button disabled={busy || !originComplete} onclick={applyOrigin}>
            {t("nbt.originSet")}
          </button>
          <button disabled={busy || origin === null} onclick={() => onorigin(null)}>
            {t("nbt.originClear")}
          </button>
        </div>
        <p class="hint">
        {#if anchorAt === null || originAt === null}
          {t("nbt.whereNone")}
        {:else}
          {t("nbt.whereHint", { anchor: anchorAt, origin: originAt })}
        {/if}
      </p>
      </section>

      <section class="text">
        <p class="hint">
          {editable ? t("nbt.omittedHint", { tags: omitted.join(", ") }) : t("nbt.readOnly")}
        </p>
        <textarea
          spellcheck="false"
          value={draft}
          readonly={!editable}
          disabled={busy}
          aria-label={t("nbt.title")}
          oninput={(event) => (draft = event.currentTarget.value)}
        ></textarea>
        {#if error}
          <p class="error" role="alert">{error}</p>
        {/if}
      </section>

      <footer>
        <button disabled={busy || !dirty} onclick={onrevert}>{t("nbt.revert")}</button>
        <button
          class="primary"
          disabled={busy || !editable || !dirty}
          onclick={() => onapply(draft)}
        >
          {t("nbt.apply")}
        </button>
      </footer>
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

  /* Rows, not columns: the text is the point and everything else is trim, so
     the middle row takes what is left with `minmax(0, 1fr)`. */
  .modal {
    position: relative;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    width: min(820px, calc(100vw - 48px));
    height: min(680px, calc(100vh - 64px));
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-panel);
    box-shadow: 0 16px 48px var(--shadow);
    outline: none;
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: center;
    padding: 14px 18px 10px;
  }

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  h3 {
    margin: 0 0 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-dim);
  }

  .close {
    position: absolute;
    top: 10px;
    right: 12px;
  }

  .origin {
    padding: 0 18px 12px;
    border-bottom: 1px solid var(--border);
  }

  .fields {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    margin-top: 8px;
  }

  .fields label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-dim);
  }

  .fields input {
    width: 92px;
  }

  /* `min-height: 0` so the textarea scrolls inside the modal instead of
     growing it past the viewport. */
  .text {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    min-height: 0;
    padding: 12px 18px;
  }

  textarea {
    min-height: 0;
    height: 100%;
    resize: none;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    tab-size: 2;
    white-space: pre;
    overflow: auto;
  }

  .error {
    margin: 8px 0 0;
    padding: 7px 10px;
    border-left: 2px solid var(--danger);
    border-radius: 0 6px 6px 0;
    background: var(--bg-input);
    color: var(--text);
    font-size: 12px;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 0 18px 16px;
  }

  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-contrast);
  }
</style>
