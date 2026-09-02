<script lang="ts">
  /**
   * Every block the app can place, as they look, on `E`.
   *
   * ## The drawing is not here
   *
   * `block_icons.svelte.ts` owns the one renderer the window is allowed, and
   * the hotbar draws from the same cache — two components showing the same
   * blocks two different ways was how the hotbar came to be a row of hashed
   * colours next to a grid of actual blocks.
   *
   * ## Virtualised, and the arithmetic is not here
   *
   * `inventory.ts` decides which slice needs drawing, because a scroll offset is
   * not something this project's test harness can produce — the same split
   * `build_grid.ts` and `selection_drag.ts` use.
   */
  import { blockIcons, iconsReady, requestBlockIcons } from "./block_icons.svelte.js";
  import { mcVersion } from "../../../shared/mc_versions.js";
  import { blockLabel, gridWindow, inventoryBlocks } from "./inventory.js";
import { legacyIdFor, type LegacyIndex } from "../../../shared/legacy_ids.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    open: boolean;
    /** Every placeable block id, as main lists them. */
    blocks: readonly string[];
    /** Shown beside the search, so the target is never a mystery. */
    version: string;
    /**
     * The names this schematic can hold, or `null` for no restriction.
     *
     * Only a legacy document supplies one: `legacy_blocks.json` says exactly
     * which blocks a pre-Flattening file can name, and it is the same table
     * the writer refuses a save on. Above 1.13 there is no such data and
     * nothing is cut -- see `inventoryBlocks`.
     */
    placeable?: ReadonlySet<string> | null;
    /**
     * The pre-Flattening table, when this schematic is one.
     *
     * A legacy file stores `35:14`, not `minecraft:red_wool` -- so on a legacy
     * document the grid says both. Naming only the modern spelling would be
     * telling somebody the app's word for a block instead of the file's.
     */
    legacy?: LegacyIndex | null;
    /** What the chosen block is for — named so the title can say it. */
    purpose: "hand" | "fill" | "replace";
    onclose: () => void;
    onpick: (block: string) => void;
  }

  const {
    open,
    blocks,
    version,
    placeable = null,
    legacy = null,
    purpose,
    onclose,
    onpick,
  }: Props = $props();

  const TILE = 68;
  const COLUMNS = 8;

  let query = $state("");
  let scrollTop = $state(0);
  let viewportHeight = $state(420);
  let scroller = $state<HTMLDivElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);

  const filtered = $derived(inventoryBlocks(blocks, query, placeable));
  const view = $derived(
    gridWindow({
      count: filtered.length,
      columns: COLUMNS,
      rowHeight: TILE,
      viewportHeight,
      scrollTop,
    }),
  );
  const visible = $derived(filtered.slice(view.firstIndex, view.lastIndex));

  /** The rendered icons. Read through the getter so this depends on the map. */
  const icons = $derived(blockIcons());

  $effect(() => {
    if (!open) return;
    // Read, so the warm-up landing re-runs this rather than waiting for a scroll.
    void iconsReady();
    requestBlockIcons(visible);
  });

  /*
   * The pointer belongs to the menu now.
   *
   * In flight the canvas holds a pointer lock, and opening this over the top of
   * it left the camera still turning with every movement while the cursor was
   * nowhere to be seen -- so the list could not be clicked at all. Releasing it
   * also stops the flight keys: the viewer only records WASD while the lock is
   * held, so W goes back to being a letter you can type into the search box.
   */
  $effect(() => {
    if (open) document.exitPointerLock();
  });

  $effect(() => {
    if (open) search?.focus();
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    }
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
    <div class="modal" role="dialog" aria-modal="true" aria-label={t("inventory.title")} tabindex="-1">
      <header>
        <strong class="purpose">{t(`inventory.for.${purpose}`)}</strong>
        <input
          bind:this={search}
          bind:value={query}
          type="search"
          placeholder={t("inventory.search")}
          aria-label={t("inventory.search")}
        />
        <span class="hint">
          {t("inventory.count", { count: filtered.length.toLocaleString() })}
          · {mcVersion(version)?.label ?? version}
        </span>
        <button class="icon" onclick={onclose} aria-label={t("common.close")}>&#x00d7;</button>
      </header>

      <div
        class="grid"
        bind:this={scroller}
        bind:clientHeight={viewportHeight}
        onscroll={() => (scrollTop = scroller?.scrollTop ?? 0)}
      >
        <!-- One tall spacer, with only the visible rows positioned inside it.
             The spacer is what gives the scrollbar the right length without
             nine hundred elements existing. -->
        <div class="spacer" style={`height: ${view.totalRows * TILE}px`}>
          {#each visible as block, offset (block)}
            {@const index = view.firstIndex + offset}
            <button
              class="tile"
              style={`
                top: ${Math.floor(index / COLUMNS) * TILE}px;
                left: ${(index % COLUMNS) * TILE}px;
              `}
              onclick={() => {
                onpick(block);
                onclose();
              }}
              title={legacyIdFor(legacy, block) ?? block}
            >
              {#if icons.get(block)}
                <img src={icons.get(block)} alt="" width="40" height="40" />
              {:else}
                <!-- Not empty while it is being built: a blank tile that later
                     fills in reads as a broken image until it does. -->
                <span class="pending" aria-hidden="true"></span>
              {/if}
              <span class="name">{blockLabel(block)}</span>
              {#if legacyIdFor(legacy, block)}
                <span class="legacy">{legacyIdFor(legacy, block)}</span>
              {/if}
            </button>
          {/each}
        </div>
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
    display: flex;
    flex-direction: column;
    width: min(620px, calc(100vw - 48px));
    height: min(560px, calc(100vh - 64px));
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
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }

  .purpose {
    flex: none;
    font-size: 12px;
  }

  input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text);
    font: inherit;
  }

  .hint {
    flex: none;
    font-size: 11px;
    color: var(--text-dim);
  }

  .grid {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 8px;
  }

  .spacer {
    position: relative;
    width: 100%;
  }

  .tile {
    position: absolute;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    width: 68px;
    height: 68px;
    padding: 2px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
    overflow: hidden;
  }

  .tile:hover {
    border-color: var(--accent);
    background: var(--bg-input);
    color: var(--text);
  }

  img {
    width: 40px;
    height: 40px;
    /* The atlas is 16px art; anything but nearest turns a face into mush. */
    image-rendering: pixelated;
  }

  .pending {
    width: 40px;
    height: 40px;
    border-radius: 4px;
    background: var(--bg-input);
  }

  /*
   * The `ID:DATA` the file will really store, on a legacy schematic only.
   * Smaller than the name and dimmer, because it answers a question the name
   * has already answered -- it is there for the person writing commands
   * against the same build.
   */
  .legacy {
    font-size: 8px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }

  .name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 9px;
    line-height: 1.1;
  }
</style>
