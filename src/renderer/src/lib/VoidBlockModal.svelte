<script lang="ts">
  /**
   * What empty space is made of.
   *
   * A schematic has always been full of air, and for an underwater build that
   * is wrong in a way that only shows up after the paste: breaking a block
   * leaves a bubble, because the file says the cell is empty and the game
   * believes it.
   *
   * Choosing a block here does three things, and they are three mechanisms
   * rather than three settings:
   *
   * - it is **written** when a block is broken, so the file is right;
   * - it is **drawn** over every empty cell at the opacity below, so the space
   *     is visible as space;
   * - it is **ignored by the pointer**, so a click reaches whatever is behind
   *     it -- which is the only thing that makes editing inside it bearable.
   *
   * The last of those has a consequence worth reading before it is met: with
   * water chosen, water placed by hand is unpickable too. There is no way to
   * have both, and this is the half that was asked for.
   *
   * **The choice belongs to the schematic, not to the app.** It used to be a
   * global setting, which meant it followed you from an underwater build to
   * a cathedral quietly changing what a break wrote into the file. It is now
   * remembered per path, beside the version and the container.
   */
  import { VOID_OPACITY } from "../../../shared/settings.js";
  import BlockPicker from "./BlockPicker.svelte";
  import { t } from "./i18n.svelte.js";

  interface Props {
    open: boolean;
    /** The chosen block, or `""` for air. */
    block: string;
    opacity: number;
    busy: boolean;
    /** Every id the app can place; the picker searches it. */
    blocks: readonly string[];
    /** What this schematic can hold; see `BlockPicker`. */
    placeable?: ReadonlySet<string> | null;
    /** A failure from main, shown here: the app banner is behind the scrim. */
    error: string;
    /**
     * `replaceExisting` rewrites the cells already holding the old answer.
     *
     * Carried with the block rather than as a verb of its own, because the
     * two questions are asked at the same moment: choosing water is when
     * somebody wants to know whether the air already there becomes water.
     */
    onblock: (block: string, replaceExisting: boolean) => void;
    onopacity: (opacity: number) => void;
    onclose: () => void;
  }

  const {
    open,
    block,
    opacity,
    busy,
    blocks,
    placeable = null,
    error,
    onblock,
    onopacity,
    onclose,
  }: Props = $props();

  /**
   * Whether choosing also rewrites what is already there.
   *
   * Off by default and reset every time the panel opens, because it is a
   * destructive-shaped answer to a question that is usually about drawing.
   * Sticky, it would eventually rewrite a document somebody was only
   * looking at.
   */
  let replaceExisting = $state(false);

  let dialog = $state<HTMLDivElement | undefined>(undefined);

  /**
   * The blocks worth offering, and why they are a list rather than the whole
   * inventory.
   *
   * Every one of them is something a builder means by "the space is not empty":
   * a medium you are inside (water, lava), or a marker for a volume nobody may
   * enter (barrier, structure void). The picker below still accepts anything --
   * this is a shortcut, not a restriction, because a rule about which blocks
   * make sense as a medium is one this app would get wrong.
   */
  const SUGGESTED = [
    "",
    "minecraft:water",
    "minecraft:lava",
    "minecraft:barrier",
    "minecraft:structure_void",
  ] as const;

  /*
   * Cut to what this schematic can hold. `structure_void` arrived in 1.10 and
   * `barrier` in 1.8, so a legacy document can be offered some of these and
   * not others -- and a preset that is refused the moment it is clicked is
   * worse than one that is not there.
   */
  const offered = $derived(
    SUGGESTED.filter(
      (candidate) => candidate === "" || placeable === null || placeable.has(candidate),
    ),
  );

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onclose();
    }
  }

  $effect(() => {
    if (!open) return;
    replaceExisting = false;
    // Over the viewport, where the canvas may hold the pointer: a panel on
    // top of a camera still turning underneath is the documented failure.
    document.exitPointerLock();
    dialog?.focus();
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={onclose} onkeydown={onKeydown}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={dialog}
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label={t("void.title")}
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={onKeydown}
    >
      <header>
        <h2>{t("void.title")}</h2>
        <button class="icon" onclick={onclose} aria-label={t("common.close")}>&times;</button>
      </header>

      <p class="hint">{t("void.hint")}</p>

      <div class="presets" role="group" aria-label={t("void.presets")}>
        {#each offered as candidate (candidate)}
          <button
            class:active={block === candidate}
            disabled={busy}
            onclick={() => onblock(candidate, replaceExisting)}
          >
            {candidate === "" ? t("void.air") : candidate.replace("minecraft:", "")}
          </button>
        {/each}
      </div>

      <label class="field">
        <span>{t("void.block")}</span>
        <BlockPicker
          value={block}
          placeholder="minecraft:air"
          {blocks}
          {placeable}
          onchange={(next) => onblock(next, replaceExisting)}
        />
      </label>

      <!--
        Disabled with air chosen rather than hidden: it is the same control
        either way, and a slider that comes and goes reads as a bug in the
        panel. There is simply nothing for it to make see-through.
      -->
      <label class="field slider" class:inert={block === ""}>
        <span>{t("void.opacity", { percent: Math.round(opacity * 100) })}</span>
        <input
          type="range"
          min={VOID_OPACITY.min}
          max={VOID_OPACITY.max}
          step="0.05"
          value={opacity}
          disabled={busy || block === ""}
          oninput={(event) => onopacity(Number(event.currentTarget.value))}
        />
      </label>

      <!--
        Ticked, choosing also rewrites the cells that hold the *previous*
        answer -- the air a schematic has always been full of, or whatever was
        chosen before. One transaction, so it is one Ctrl+Z.

        It is a checkbox beside the picker rather than a button of its own
        because it is not a separate act: nobody wants to convert a build to
        water without also making water what a break writes, and offering the
        two apart would let the file and the tool disagree.
      -->
      <label class="field check">
        <input type="checkbox" bind:checked={replaceExisting} disabled={busy} />
        <span>{t("void.replace")}</span>
      </label>
      <p class="note">{t("void.replaceHint")}</p>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <p class="note">{t("void.pickNote")}</p>

      <footer>
        <button onclick={onclose}>{t("common.close")}</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--scrim);
  }

  .modal {
    width: min(440px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
    overflow: auto;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
    box-shadow: 0 18px 48px var(--shadow);
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  h2 {
    flex: 1 1 auto;
    margin: 0;
    font-size: 15px;
  }

  .icon {
    padding: 2px 8px;
    border: none;
    background: transparent;
    font-size: 18px;
    line-height: 1;
  }

  .hint {
    margin: 0 0 12px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-dim);
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 12px;
  }

  .presets button {
    padding: 4px 9px;
    font-size: 12px;
  }

  .presets button.active {
    background: var(--accent);
    color: var(--accent-contrast);
    border-color: var(--accent);
  }

  .field {
    display: block;
    margin-bottom: 12px;
    font-size: 12px;
  }

  .field > span {
    display: block;
    margin-bottom: 4px;
    color: var(--text-dim);
  }

  .slider input {
    width: 100%;
  }

  .inert {
    opacity: 0.5;
  }

  /* A checkbox reads left-to-right, unlike the label-above fields above it. */
  .field.check {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }

  .field.check input {
    margin: 0;
  }

  .field.check > span {
    color: var(--text);
  }

  .error {
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text);
    font-size: 11px;
  }

  .note {
    margin: 0 0 12px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-dim);
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
