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
    onblock: (block: string) => void;
    onopacity: (opacity: number) => void;
    onclose: () => void;
  }

  const { open, block, opacity, busy, blocks, onblock, onopacity, onclose }: Props = $props();

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

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onclose();
    }
  }

  $effect(() => {
    if (open) dialog?.focus();
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
        {#each SUGGESTED as candidate (candidate)}
          <button
            class:active={block === candidate}
            disabled={busy}
            onclick={() => onblock(candidate)}
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
          onchange={(next) => onblock(next)}
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
