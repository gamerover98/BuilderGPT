<script lang="ts">
  /**
   * WorldEdit's paste anchor: create it, move it, show it, take it away.
   *
   * The anchor is a *cell*, and that is what this panel is about — the number
   * the file stores is its negation, and `anchorOf`/`offsetFor` in main are the
   * only two places that know. What is shown here is what is drawn in the
   * viewport, so the two can never disagree by a sign.
   *
   * The INFO block is not decoration. This is a tag nobody has heard of until
   * they need it, and the difference between a schematic that pastes where it
   * should and one that lands three blocks off is entirely inside it.
   */
  import { anchorKey, mirrorAnchor } from "./anchor_draft.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    open: boolean;
    /** The cell the anchor occupies, or `null` when there is no anchor. */
    anchor: [number, number, number] | null;
    /** What the file actually stores, shown so the negation is not a secret. */
    offset: [number, number, number] | null;
    /** The schematic's size, for the centre preset and the inside/outside note. */
    size: [number, number, number];
    /** Whether the marker is drawn in the viewport. */
    visible: boolean;
    busy: boolean;
    /**
     * Main's wording for whatever went wrong, shown *inside* the modal.
     *
     * The app's status banner is behind the scrim, so a failure reported there
     * is a failure nobody can see: the button appears to do nothing at all.
     */
    error: string;
    onset: (anchor: [number, number, number]) => void;
    onclear: () => void;
    onvisibility: (visible: boolean) => void;
    onclose: () => void;
  }

  const {
    open,
    anchor,
    offset,
    size,
    visible,
    busy,
    error,
    onset,
    onclear,
    onvisibility,
    onclose,
  }: Props = $props();

  let dialog = $state<HTMLDivElement | undefined>(undefined);
  let draft = $state<[string, string, string]>(["", "", ""]);

  /**
   * Main owns the anchor; this mirrors whatever comes back, including a Clear.
   *
   * The decision is `mirrorAnchor`'s, and it is keyed on the value rather than
   * on the prop's identity — see that module for what mirroring on identity
   * does to anything half-typed.
   */
  let mirrored = $state<string | null>(null);
  $effect(() => {
    const next = mirrorAnchor(anchor, mirrored);
    if (next === null) return;
    mirrored = anchorKey(anchor);
    draft = next;
  });

  // A typing surface over the viewport: in flight the canvas holds the pointer,
  // and a camera still turning underneath is the documented failure.
  $effect(() => {
    if (open) {
      document.exitPointerLock();
      dialog?.focus();
    }
  });

  const complete = $derived(
    draft.every((value) => value.trim() !== "" && Number.isFinite(Number(value))),
  );
  const values = $derived(
    [Number(draft[0]), Number(draft[1]), Number(draft[2])] as [number, number, number],
  );

  /**
   * The middle of the build, which is where somebody copying a selection
   * usually stands. Floored, because a cell is a whole number and the centre of
   * an even span falls between two.
   */
  const centre = $derived(
    [
      Math.floor(size[0] / 2),
      0,
      Math.floor(size[2] / 2),
    ] as [number, number, number],
  );

  const outside = $derived(
    anchor !== null &&
      (anchor[0] < 0 ||
        anchor[1] < 0 ||
        anchor[2] < 0 ||
        anchor[0] >= size[0] ||
        anchor[1] >= size[1] ||
        anchor[2] >= size[2]),
  );

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    }
  }

  function preset(next: [number, number, number]): void {
    draft = [String(next[0]), String(next[1]), String(next[2])];
    onset(next);
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
      aria-label={t("anchor.title")}
      tabindex="-1"
      bind:this={dialog}
    >
      <header>
        <h2>{t("anchor.title")}</h2>
        <button class="icon close" onclick={onclose} aria-label={t("common.close")}>&#x00d7;</button>
      </header>

      <div class="body">
        <section class="info">
          <h3>{t("anchor.infoTitle")}</h3>
          <p>{t("anchor.infoWhat")}</p>
          <p>{t("anchor.infoExample")}</p>
          <p>{t("anchor.infoPivot")}</p>
          <p class="hint">{t("anchor.infoStorage")}</p>
        </section>

        <section>
          <h3>{t("anchor.positionTitle")}</h3>
          {#if anchor === null}
            <p class="hint">{t("anchor.none")}</p>
          {/if}

          <div class="fields">
            {#each ["x", "y", "z"] as axis, index (axis)}
              <label>
                <span>{axis.toUpperCase()}</span>
                <input
                  type="number"
                  step="1"
                  value={draft[index]}
                  placeholder="0"
                  disabled={busy}
                  oninput={(event) => (draft[index] = event.currentTarget.value)}
                  onkeydown={(event) => {
                    if (event.key === "Enter" && complete) onset(values);
                  }}
                />
              </label>
            {/each}
            <button class="primary" disabled={busy || !complete} onclick={() => onset(values)}>
              {anchor === null ? t("anchor.create") : t("anchor.move")}
            </button>
          </div>

          <div class="presets">
            <button disabled={busy} onclick={() => preset(centre)}>{t("anchor.atCentre")}</button>
            <button disabled={busy} onclick={() => preset([0, 0, 0])}>{t("anchor.atCorner")}</button>
            <button class="danger" disabled={busy || anchor === null} onclick={onclear}>
              {t("anchor.delete")}
            </button>
          </div>

          {#if outside}
            <p class="hint">{t("anchor.outside")}</p>
          {/if}

          {#if offset !== null}
            <p class="hint stored">
              {t("anchor.stored", { x: offset[0], y: offset[1], z: offset[2] })}
            </p>
          {/if}

          {#if error}
            <p class="error" role="alert">{error}</p>
          {/if}
        </section>

        <section>
          <h3>{t("anchor.viewTitle")}</h3>
          <label class="toggle">
            <input
              type="checkbox"
              checked={visible}
              disabled={busy}
              onchange={(event) => onvisibility(event.currentTarget.checked)}
            />
            {t("anchor.showMarker")}
          </label>
          <p class="hint">{t("anchor.markerHint")}</p>
        </section>
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
    position: relative;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    width: min(620px, calc(100vw - 48px));
    max-height: min(660px, calc(100vh - 64px));
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
    padding: 14px 18px 8px;
  }

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  h3 {
    margin: 0 0 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-dim);
  }

  .close {
    position: absolute;
    top: 10px;
    right: 12px;
  }

  /* `min-height: 0` so the body scrolls inside the modal instead of growing it
     past the viewport — the same grid-child rule the app shell needs. */
  .body {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 8px 18px 18px;
    overflow-y: auto;
  }

  /* The accent bar is the same device the settings modal uses for "read this
     before you change it", so the two read as one language. */
  .info {
    padding: 10px 12px;
    border-left: 2px solid var(--accent);
    border-radius: 0 8px 8px 0;
    background: var(--bg-input);
  }

  .info p {
    margin: 0 0 8px;
    font-size: 13px;
    line-height: 1.5;
  }

  .info p:last-child {
    margin-bottom: 0;
  }

  .fields {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .fields label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-dim);
  }

  .fields input {
    width: 88px;
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-contrast);
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    color: var(--text);
    font-size: 14px;
  }

  .stored {
    font-family: var(--mono);
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
</style>
