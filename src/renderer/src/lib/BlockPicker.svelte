<script lang="ts">
  /**
   * A searchable block field, replacing a bare text input with the actual
   * registry — the same `block_id_list.txt` set the agent is judged against
   * (CLAUDE.md: "the set the model is told about cannot drift from the set it
   * is judged against"). Typing anything the list does not contain is still
   * allowed; this only makes the common case a click instead of a memory test.
   */
  interface Props {
    id?: string;
    value: string;
    placeholder?: string;
    blocks: readonly string[];
    onchange: (block: string) => void;
  }

  const { id, value, placeholder, blocks, onchange }: Props = $props();

  let open = $state(false);
  let highlighted = $state(0);
  let root: HTMLDivElement | undefined;

  const matches = $derived.by(() => {
    const query = value.trim().toLowerCase();
    const pool = query === "" ? blocks : blocks.filter((b) => b.toLowerCase().includes(query));
    return pool.slice(0, 40);
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
    <ul class="dropdown" role="listbox">
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
            {block}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
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
    max-height: 220px;
    overflow-y: auto;
    margin: 0;
    padding: 4px;
    list-style: none;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  }

  .dropdown button {
    display: block;
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
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dropdown button.highlighted,
  .dropdown button:hover {
    background: var(--accent-dim);
  }
</style>
