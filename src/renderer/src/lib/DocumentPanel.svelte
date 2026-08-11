<script lang="ts">
  /**
   * The editing surface: what is open, what is selected, and what can be done
   * to it.
   *
   * Everything here is a request to the main process — the renderer holds no
   * schematic, only the `DocumentState` summary it was last handed back. That
   * is why every button is disabled from `doc` rather than from anything this
   * component tracks itself: there is only one copy of the truth and it is not
   * in here.
   *
   * The prop is `doc`, not `state`, and that is load-bearing. A local binding
   * called `state` makes every `$state(...)` in the same component parse as a
   * store subscription to it (`store_rune_conflict`), so `fromBlock` below
   * would silently stop being reactive.
   */
  import type { DocumentState, RegionSpec } from "../../../shared/ipc.js";
  import { SCHEMATIC_FORMAT_LABEL, type SchematicFormat } from "../../../shared/schematic.js";
  import BlockPicker from "./BlockPicker.svelte";

  interface Props {
    doc: DocumentState | null;
    selection: RegionSpec | null;
    busy: boolean;
    /** The registry to search — the same set the agent is judged against. */
    blocks: readonly string[];
    /** Recently opened schematics, most recent first. */
    recent: readonly string[];
    onopenrecent: (filePath: string) => void;
    /**
     * The block Fill writes and the one Creative mode places. Owned by the app
     * rather than by this panel, because the viewport places it too and the two
     * must not disagree about what "the current block" is.
     */
    block: string;
    onblockchange: (block: string) => void;
    onopen: () => void;
    onsave: (format?: SchematicFormat) => void;
    onsaveas: () => void;
    onundo: () => void;
    onredo: () => void;
    onfill: (block: string) => void;
    onreplace: (from: string, to: string) => void;
    onclearselection: () => void;
    onselectall: () => void;
  }

  const {
    doc,
    selection,
    busy,
    blocks,
    recent,
    onopenrecent,
    block,
    onblockchange,
    onopen,
    onsave,
    onsaveas,
    onundo,
    onredo,
    onfill,
    onreplace,
    onclearselection,
    onselectall,
  }: Props = $props();

  let fromBlock = $state("");

  const selectedVolume = $derived(
    selection === null
      ? 0
      : (selection.maxX - selection.minX + 1) *
          (selection.maxY - selection.minY + 1) *
          (selection.maxZ - selection.minZ + 1),
  );

  /** A palette key is `name[a=b,c=d]`; the base name is enough to type back. */
  function baseName(block: string): string {
    return block.split("[")[0];
  }

  /** The file's own name; the full path stays in the tooltip. */
  function fileName(filePath: string): string {
    return filePath.split(/[\\/]/).pop() ?? filePath;
  }

  /**
   * The open document is the first recent entry, and offering to reopen what is
   * already open is a button that does nothing visible.
   */
  const reopenable = $derived(
    recent.filter((entry) => doc === null || entry !== doc.filePath).slice(0, 6),
  );
</script>

<fieldset>
  <legend>Schematic</legend>

  {#if doc === null}
    <p class="hint">Nothing open. Open a <code>.schem</code> or <code>.schematic</code> to edit it.</p>
    <div class="buttons">
      <button class="primary" onclick={onopen} disabled={busy}>Open…</button>
    </div>
    {#if reopenable.length > 0}
      <div class="field">
        <label for="recent-empty">Recent</label>
        <ul id="recent-empty" class="recent">
          {#each reopenable as filePath (filePath)}
            <li>
              <button class="link" onclick={() => onopenrecent(filePath)} disabled={busy} title={filePath}>
                {fileName(filePath)}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  {:else}
    <div class="file">
      <strong title={doc.filePath ?? "Not saved yet"}>
        {doc.fileName ?? "Untitled"}{doc.dirty ? " •" : ""}
      </strong>
      <span class="hint">{SCHEMATIC_FORMAT_LABEL[doc.format]}</span>
    </div>
    <p class="hint">
      {doc.size[0]}×{doc.size[1]}×{doc.size[2]} · {doc.blockCount.toLocaleString()} blocks
      {#if doc.dirty}· unsaved changes{/if}
    </p>

    <div class="buttons">
      <button onclick={onopen} disabled={busy}>Open…</button>
      <button onclick={() => onsave()} disabled={busy || !doc.dirty}>Save</button>
      <button onclick={onsaveas} disabled={busy}>Save as…</button>
    </div>

    <div class="buttons">
      <button
        onclick={onundo}
        disabled={busy || !doc.canUndo}
        title={doc.undoLabel ?? "Nothing to undo"}
      >
        Undo
      </button>
      <button
        onclick={onredo}
        disabled={busy || !doc.canRedo}
        title={doc.redoLabel ?? "Nothing to redo"}
      >
        Redo
      </button>
    </div>
    {#if doc.undoLabel}
      <p class="hint">Next undo: {doc.undoLabel}</p>
    {/if}

    {#if reopenable.length > 0}
      <div class="field">
        <label for="recent">Recent</label>
        <ul id="recent" class="recent">
          {#each reopenable as filePath (filePath)}
            <li>
              <button class="link" onclick={() => onopenrecent(filePath)} disabled={busy} title={filePath}>
                {fileName(filePath)}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- Selection -->
    <div class="field">
      <label for="selection">Selection</label>
      {#if selection === null}
        <p class="hint" id="selection">
          Click a block in the viewport to select it, Shift-click another to extend the box.
        </p>
      {:else}
        <p class="hint" id="selection">
          ({selection.minX}, {selection.minY}, {selection.minZ}) → ({selection.maxX}, {selection.maxY},
          {selection.maxZ}) · {selectedVolume.toLocaleString()} blocks
        </p>
      {/if}
      <div class="buttons">
        <button onclick={onselectall} disabled={busy}>Select all</button>
        <button onclick={onclearselection} disabled={busy || selection === null}>Clear</button>
      </div>
    </div>

    <!-- Editing -->
    <div class="field">
      <label for="to-block">Block</label>
      <BlockPicker id="to-block" value={block} placeholder="minecraft:stone" {blocks} onchange={onblockchange} />
      <div class="buttons">
        <button
          class="primary"
          onclick={() => onfill(block)}
          disabled={busy || selection === null || block.trim() === ""}
          title={selection === null ? "Select a region first" : "Fill the selection"}
        >
          Fill
        </button>
      </div>
    </div>

    <div class="field">
      <label for="from-block">Replace</label>
      <BlockPicker
        id="from-block"
        value={fromBlock}
        placeholder="minecraft:cobblestone"
        {blocks}
        onchange={(next) => (fromBlock = next)}
      />
      <div class="buttons">
        <button
          onclick={() => onreplace(fromBlock, block)}
          disabled={busy || selection === null || fromBlock.trim() === "" || block.trim() === ""}
          title={selection === null ? "Select a region first" : "Replace within the selection"}
        >
          Replace with the block above
        </button>
      </div>
    </div>

    <!-- Palette -->
    {#if doc.palette.length > 0}
      <div class="field">
        <label for="palette">Materials</label>
        <ul id="palette" class="palette">
          {#each doc.palette.slice(0, 12) as entry (entry.block)}
            <li>
              <button
                class="link"
                onclick={() => (fromBlock = baseName(entry.block))}
                title={`Use ${entry.block} as the block to replace`}
              >
                {entry.block}
              </button>
              <span class="count">{entry.count.toLocaleString()}</span>
            </li>
          {/each}
        </ul>
        {#if doc.palette.length > 12}
          <p class="hint">…and {doc.palette.length - 12} more</p>
        {/if}
      </div>
    {/if}
  {/if}
</fieldset>

<style>
  .file {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 2px;
  }

  .file strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .buttons {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    flex-wrap: wrap;
  }

  .palette {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 190px;
    overflow-y: auto;
    font-size: 12px;
  }

  .recent {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 12px;
  }

  .recent li {
    padding: 2px 0;
  }

  button.link:disabled {
    color: var(--text-dim);
    cursor: default;
    text-decoration: none;
  }

  .palette li {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 0;
  }

  .palette .count {
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  button.link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button.link:hover {
    text-decoration: underline;
  }
</style>
