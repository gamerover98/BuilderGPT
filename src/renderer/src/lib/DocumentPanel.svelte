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
  import type { DocumentState } from "../../../shared/ipc.js";
  import { SCHEMATIC_FORMAT_LABEL, type SchematicFormat } from "../../../shared/schematic.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    doc: DocumentState | null;
    busy: boolean;
    /** Recently opened schematics, most recent first. */
    recent: readonly string[];
    onopenrecent: (filePath: string) => void;
    /**
     * The block Fill writes and the one Creative mode places. Owned by the app
     * rather than by this panel, because the viewport places it too and the two
     * must not disagree about what "the current block" is. Set from here by
     * clicking a material.
     */
    onblockchange: (block: string) => void;
    onopen: () => void;
    onsave: (format?: SchematicFormat) => void;
    onsaveas: () => void;
    onundo: () => void;
    onredo: () => void;
  }

  const {
    doc,
    busy,
    recent,
    onopenrecent,
    onblockchange,
    onopen,
    onsave,
    onsaveas,
    onundo,
    onredo,
  }: Props = $props();

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
  <legend>{t("doc.legend")}</legend>

  {#if doc === null}
    <p class="hint">{t("doc.empty")}</p>
    <div class="buttons">
      <button class="primary" onclick={onopen} disabled={busy}>{t("doc.open")}</button>
    </div>
    {#if reopenable.length > 0}
      <div class="field">
        <label for="recent-empty">{t("doc.recent")}</label>
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
      <strong title={doc.filePath ?? t("doc.notSaved")}>
        {doc.fileName ?? t("doc.untitled")}{doc.dirty ? " •" : ""}
      </strong>
      <span class="hint">{SCHEMATIC_FORMAT_LABEL[doc.format]}</span>
    </div>
    <p class="hint">
      {t(doc.dirty ? "doc.summaryDirty" : "doc.summary", {
        width: doc.size[0],
        height: doc.size[1],
        length: doc.size[2],
        blocks: doc.blockCount.toLocaleString(),
      })}
    </p>

    <div class="buttons">
      <button onclick={onopen} disabled={busy}>{t("doc.open")}</button>
      <button onclick={() => onsave()} disabled={busy || !doc.dirty}>{t("doc.save")}</button>
      <button onclick={onsaveas} disabled={busy}>{t("doc.saveAs")}</button>
    </div>

    <div class="buttons">
      <button
        onclick={onundo}
        disabled={busy || !doc.canUndo}
        title={doc.undoLabel ?? t("doc.nothingToUndo")}
      >
        {t("doc.undo")}
      </button>
      <button
        onclick={onredo}
        disabled={busy || !doc.canRedo}
        title={doc.redoLabel ?? t("doc.nothingToRedo")}
      >
        {t("doc.redo")}
      </button>
    </div>
    {#if doc.undoLabel}
      <p class="hint">{t("doc.nextUndo", { label: doc.undoLabel })}</p>
    {/if}

    {#if reopenable.length > 0}
      <div class="field">
        <label for="recent">{t("doc.recent")}</label>
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

    <!-- Palette -->
    {#if doc.palette.length > 0}
      <div class="field">
        <label for="palette">{t("doc.materials")}</label>
        <ul id="palette" class="palette">
          {#each doc.palette.slice(0, 12) as entry (entry.block)}
            <li>
              <button
                class="link"
                onclick={() => onblockchange(baseName(entry.block))}
                title={t("doc.useAsBlock", { block: entry.block })}
              >
                {entry.block}
              </button>
              <span class="count">{entry.count.toLocaleString()}</span>
            </li>
          {/each}
        </ul>
        {#if doc.palette.length > 12}
          <p class="hint">{t("doc.moreMaterials", { count: doc.palette.length - 12 })}</p>
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
