<script lang="ts">
  /**
   * A searchable block field, replacing a bare text input with the actual
   * registry — the same `block_id_list.txt` set the agent is judged against
   * (CLAUDE.md: "the set the model is told about cannot drift from the set it
   * is judged against"). Typing anything the list does not contain is still
   * allowed; this only makes the common case a click instead of a memory test.
   *
   * Every match is listed. The registry is ~920 blocks, so an earlier cap of 40
   * meant the list silently stopped a third of the way through the As — and
   * worse, a search that genuinely had 41 answers quietly showed 40 with nothing
   * to say it had. A dropdown that hides matches is harder to trust than a plain
   * text field, which was the thing this replaced.
   */
  import { searchBlocks } from "./block_search.js";
import {
  legacyIdFor,
  resolveBlockInput,
  type LegacyIndex,
} from "../../../shared/legacy_ids.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    id?: string;
    value: string;
    placeholder?: string;
    blocks: readonly string[];
    /**
     * The only names this schematic can hold, or `null` for no restriction.
     *
     * Air is deliberately *not* excluded here, unlike the creative grid: a
     * fill with air is how you clear a region, so it is a real answer in this
     * field and not in that one.
     */
    placeable?: ReadonlySet<string> | null;
    /**
     * The pre-Flattening table, when this schematic is one.
     *
     * Two jobs: every row is labelled with the `ID:DATA` the file will store,
     * and typing one *finds* the block. On a legacy schematic that is the
     * vocabulary the file is in, and it is the one somebody arrives with.
     */
    legacy?: LegacyIndex | null;
    onchange: (block: string) => void;
  }

  const {
    id,
    value,
    placeholder,
    blocks,
    placeable = null,
    legacy = null,
    onchange,
  }: Props = $props();

  let open = $state(false);
  let highlighted = $state(0);
  let root: HTMLDivElement | undefined;
  /**
   * `$state`, unlike `root` below it, because the scroll effect reads it: a
   * plain `let` is written by `bind:this` without waking anything, so the
   * effect would not re-run when the dropdown opens and the element appears.
   */
  let list = $state<HTMLUListElement | undefined>(undefined);

  const offered = $derived(
    placeable === null ? blocks : blocks.filter((block) => placeable.has(block)),
  );
  /*
   * `35:14` typed here finds red wool.
   *
   * Resolved before the search rather than as a separate mode: anything that
   * is not a legacy id comes back untouched, so the ordinary case pays
   * nothing and there is no state for the two vocabularies to get out of.
   */
  const query = $derived(resolveBlockInput(value, legacy));
  const matches = $derived(searchBlocks(offered, query));

  /**
   * Keeps the highlighted row on screen.
   *
   * Not a nicety at this length: arrowing down a 920-row list without it moves
   * a selection the user cannot see, which reads as the keys doing nothing.
   *
   * **`list.scrollTop`, never `scrollIntoView`.** That method scrolls *every*
   * scrollable ancestor, and this list lives inside a floating tool window
   * that is watched by a `ResizeObserver` -- so a row wide enough to overflow
   * made it scroll the panel, the panel relaid out, the observer fired, and
   * the browser stopped delivering updates. Silently: that loop is reported as
   * an error *event*, not as anything the console shows in red, so the app
   * simply stopped responding while the viewport went on drawing and the main
   * process went on answering. It cost a long time to find from the outside.
   *
   * Writing one number touches nothing above this element, which is the whole
   * point. The `min-width: 0` in the styles keeps the row from overflowing in
   * the first place; this makes it not matter if something ever does again.
   */
  $effect(() => {
    if (!open || list === undefined) return;
    const row = list.children[highlighted] as HTMLElement | undefined;
    if (row === undefined) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  });

  function choose(block: string): void {
    onchange(block);
    open = false;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!open) {
      if (event.key === "ArrowDown") open = true;
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlighted = Math.min(highlighted + 1, matches.length - 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
    } else if (event.key === "Enter") {
      if (matches[highlighted]) {
        event.preventDefault();
        choose(matches[highlighted]);
      }
    } else if (event.key === "Escape") {
      open = false;
    }
  }

  function onWindowClick(event: MouseEvent): void {
    if (root && !root.contains(event.target as Node)) {
      open = false;
    }
  }
</script>

<svelte:window onclick={onWindowClick} />

<div class="picker" bind:this={root}>
  <input
    {id}
    {value}
    {placeholder}
    spellcheck="false"
    autocomplete="off"
    oninput={(event) => {
      onchange(event.currentTarget.value);
      highlighted = 0;
      open = true;
    }}
    onfocus={() => (open = true)}
    onkeydown={onKeydown}
  />
  {#if open && matches.length > 0}
    <div class="dropdown">
      <!--
        Outside the scrolling list on purpose: `list.children` is indexed by the
        highlighted row, so anything else living in that element would put the
        keyboard selection one off from what is drawn.
      -->
      <p class="count">
        {#if matches.length === offered.length}
          {t("blocks.all", { count: offered.length })}
        {:else}
          {t("blocks.matches", { count: matches.length, total: offered.length })}
        {/if}
      </p>
      <ul role="listbox" bind:this={list}>
      {#each matches as block, i (block)}
        <li>
          <button
            type="button"
            class:highlighted={i === highlighted}
            onmouseenter={() => (highlighted = i)}
            onmousedown={(event) => {
              // mousedown, not click: fires before the input's blur, so the
              // dropdown is still open when the selection lands.
              event.preventDefault();
              choose(block);
            }}
          >
            <span>{block}</span>
            {#if legacyIdFor(legacy, block)}
              <span class="legacy">{legacyIdFor(legacy, block)}</span>
            {/if}
          </button>
        </li>
      {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  /*
   * The `ID:DATA` sits at the trailing edge of the row, on a legacy schematic
   * only. Right-aligned rather than beside the name so the column of numbers
   * lines up and can be read down.
   */
  li button .legacy {
    flex: none;
    margin-left: auto;
    padding-left: 10px;
    font-variant-numeric: tabular-nums;
    opacity: 0.6;
  }

  .picker {
    position: relative;
  }

  input {
    width: 100%;
    box-sizing: border-box;
  }

  .dropdown {
    position: absolute;
    z-index: 20;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    padding: 4px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 4px 12px var(--shadow);
  }

  .count {
    margin: 0 0 4px;
    padding: 0 6px;
    font-size: 11px;
    color: var(--text-dim);
  }

  .dropdown ul {
    /* The list scrolls, not the panel, so the count stays put while it does. */
    max-height: 220px;
    overflow-y: auto;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /*
   * A flex row rather than a block, so the legacy id can be pushed to the
   * trailing edge. The ellipsis moves with it: `text-overflow` needs the
   * element that actually overflows, which is now the name rather than the
   * button.
   */
  .dropdown button {
    display: flex;
    align-items: baseline;
    width: 100%;
    box-sizing: border-box;
    text-align: left;
    padding: 4px 6px;
    background: none;
    border: none;
    border-radius: 3px;
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    overflow: hidden;
  }

  /*
   * `min-width: 0` is the load-bearing line here, not the ellipsis.
   *
   * A flex item will not shrink below its content by default, so without it a
   * long block id makes the row *wider than the button* -- which this row could
   * never do while it was `display: block`. An overflowing row is what turns
   * the `scrollIntoView` below into something that scrolls ancestors.
   */
  .dropdown button > span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dropdown button.highlighted,
  .dropdown button:hover {
    background: var(--accent-dim);
  }
</style>
