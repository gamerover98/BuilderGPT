<script lang="ts">
  /**
   * Nine blocks along the bottom, in creative.
   *
   * The block to place used to be a text field with a dropdown — right for a
   * form, wrong for building, where the whole point is that changing material
   * costs no attention. Keys 1–9 pick a slot and the wheel steps through them,
   * which is what anyone who has played the game will try first.
   *
   * ## The wheel is already the zoom, and has to be taken
   *
   * `OrbitControls` maps it, so this listens with `capture` and calls
   * `preventDefault` — the same problem the left mouse button poses for
   * selection drags, and the same remedy. Only in flight (`ownsWheel`): in
   * orbit the wheel is the zoom, and the bar is on screen there too now, so
   * "there is no hotbar to step through" has stopped being the reason. The
   * reason is that the game has no zoom to lose and this does.
   *
   * ## Only what it is told
   *
   * The slot and the contents are props, and every change goes out through
   * `onchange`. They live in `UiSettings`, so the component holding its own copy
   * would mean two answers to "what am I holding" — and the one on screen would
   * be the one that failed to persist.
   */
  import { HOTBAR_SLOTS } from "../../../shared/settings.js";
  import { t } from "./i18n.svelte.js";
  import { isTyping } from "./typing.js";

  interface Props {
    /** Exactly `HOTBAR_SLOTS` block ids; `coerceUi` guarantees the length. */
    slots: readonly string[];
    /** Which one is held, 0-based. */
    active: number;
    /** Shown whenever a document is open, in either camera mode. */
    visible: boolean;
    /**
     * Whether the wheel belongs to this bar.
     *
     * Only in flight. In orbit the wheel is the zoom, and taking it would trade
     * a control the user needs constantly for one the number keys already
     * provide -- the game gets to claim the wheel because the game has no zoom.
     */
    ownsWheel: boolean;
    onselect: (slot: number) => void;
    /** A slot was emptied or asked to be filled from the inventory. */
    onedit?: (slot: number) => void;
    /** The button past the ninth slot: open the full block list. */
    onopeninventory?: () => void;
  }

  const { slots, active, visible, ownsWheel, onselect, onedit, onopeninventory }: Props = $props();

  /** `minecraft:oak_planks` → `oak planks`, which is what fits under a tile. */
  function label(id: string): string {
    return id.replace(/^minecraft:/, "").replace(/\[.*$/, "").replace(/_/g, " ");
  }

  /**
   * A stable colour per block, so slots are told apart at a glance.
   *
   * The same hashed-colour idea the mesher falls back to for a block it has no
   * texture for. A real texture would be better and is what the inventory is
   * for; this only has to make nine tiles distinguishable.
   */
  function hue(id: string): number {
    let hash = 2166136261;
    for (let i = 0; i < id.length; i += 1) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % 360;
  }

  function step(by: number): void {
    onselect(((active + by) % HOTBAR_SLOTS + HOTBAR_SLOTS) % HOTBAR_SLOTS);
  }

  $effect(() => {
    if (!visible) return;

    const onKey = (event: KeyboardEvent) => {
      // Not while the user is typing: this listens on `window`, so a "3" in the
      // chat would otherwise change what is in your hand mid-sentence.
      if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= HOTBAR_SLOTS) {
        event.preventDefault();
        onselect(digit - 1);
      }
    };

    /*
     * `capture` and `passive: false`, both load-bearing. OrbitControls listens
     * on the canvas, so without capture the zoom happens first; without
     * `passive: false` the browser refuses `preventDefault` and the zoom happens
     * anyway. Registered on `window` so it works wherever the pointer is.
     */
    const onWheel = (event: WheelEvent) => {
      if (isTyping(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      step(event.deltaY > 0 ? 1 : -1);
    };

    window.addEventListener("keydown", onKey);
    if (ownsWheel) {
      window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  });
</script>

{#if visible}
  <div class="hotbar" role="toolbar" aria-label={t("hotbar.label")}>
    {#each slots as id, index (index)}
      <button
        class="slot"
        class:active={index === active}
        onclick={() => onselect(index)}
        oncontextmenu={(event) => {
          event.preventDefault();
          onedit?.(index);
        }}
        title={`${id} — ${t("hotbar.slotHint", { key: String(index + 1) })}`}
        aria-pressed={index === active}
      >
        <span class="swatch" style={`--swatch-hue: ${hue(id)}`} aria-hidden="true"></span>
        <span class="key" aria-hidden="true">{index + 1}</span>
        <span class="name">{label(id)}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .hotbar {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    gap: 3px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-panel);
    box-shadow: 0 6px 20px var(--shadow);
  }

  .slot {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    width: 62px;
    padding: 4px 2px 3px;
    border: 2px solid transparent;
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text-dim);
    cursor: pointer;
  }

  .slot.active {
    border-color: var(--accent);
    color: var(--text);
  }

  .swatch {
    width: 26px;
    height: 26px;
    border-radius: 4px;
    background: hsl(var(--swatch-hue) 45% 52%);
  }

  .key {
    position: absolute;
    top: 2px;
    left: 4px;
    font-size: 9px;
    opacity: 0.6;
  }

  /*
   * One line, cut rather than wrapped. Nine tiles that each grow to fit their
   * own name turn the row into a ragged strip that moves every time the
   * contents change.
   */
  .name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 9px;
    line-height: 1.1;
  }
</style>
