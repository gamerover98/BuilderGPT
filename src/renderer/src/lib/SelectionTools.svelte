<script lang="ts">
  /**
   * What you can do to the selected region, next to the region.
   *
   * These controls used to live in `DocumentPanel`, in the sidebar, which meant
   * driving a 3D box from a form on the other side of the window. They are the
   * same requests to the same handlers -- nothing about the domain changed --
   * but a fill button an inch from the thing being filled is a different tool
   * from one across the room.
   *
   * Every button is disabled from `selection` and `busy` rather than from
   * anything tracked here. The renderer holds no schematic; there is one copy
   * of the truth and it is in the main process.
   */
  import type { ClipboardInfo, PaletteCount, RegionSpec, TransformRequest } from "../../../shared/ipc.js";
  import BlockPicker from "./BlockPicker.svelte";
  import { t } from "./i18n.svelte.js";

  interface Props {
    selection: RegionSpec | null;
    busy: boolean;
    /** The registry to search — the same set the agent is judged against. */
    blocks: readonly string[];
    /**
     * The block Fill writes and the one Creative mode places. Owned by the app,
     * because the viewport places it too and the two must not disagree about
     * what "the current block" is.
     */
    block: string;
    onblockchange: (block: string) => void;
    /**
     * What the open document is actually made of, most common first.
     *
     * It used to sit in the sidebar's document panel, which is where it was
     * least useful: clicking a material means "use this one", and the field it
     * fills is here. It is also only ever meaningful while a document is open,
     * which is exactly when this window exists.
     */
    palette: readonly PaletteCount[];
    /**
     * The block Replace looks for.
     *
     * A prop rather than local state because the block list can fill it in too,
     * and a value with two writers cannot live inside one of them.
     */
    replaceFrom: string;
    onreplacefromchange: (block: string) => void;
    /**
     * Open the full block list for one of these two fields.
     *
     * The typing picker stays: it is faster when you know the name. This is for
     * when you do not, which is most of the time — and it is the same list `E`
     * opens, because a second block browser would be the same nine hundred
     * tiles behind a different scrollbar.
     */
    onbrowse: (purpose: "fill" | "replace") => void;
    clipboard: ClipboardInfo | null;
    onfill: (block: string) => void;
    onreplace: (from: string, to: string) => void;
    ontransform: (transform: TransformRequest["transform"]) => void;
    oncopy: () => void;
    oncut: () => void;
    onpaste: () => void;
    /**
     * Empties the selection, which is a fill with air.
     *
     * Beside Copy and Cut rather than beside Fill, because that is the group it
     * belongs to by *gesture*: these four are what the keyboard does to a
     * region, and Delete is the one of them with no other way in.
     */
    ondelete: () => void;
    /** Whether a move is in flight, so the button can offer to call it off. */
    moving: boolean;
    /**
     * Arms the move, or cancels it.
     *
     * A mode rather than a drag on the box, because a press on the selection
     * already belongs to the camera -- taking it back is what made orbiting a
     * build nearly impossible the first time, and this gesture is not worth
     * paying that again.
     */
    onmove: () => void;
    onclearselection: () => void;
    onselectall: () => void;
  }

  const {
    selection,
    busy,
    blocks,
    block,
    onblockchange,
    palette,
    replaceFrom,
    onreplacefromchange,
    onbrowse,
    clipboard,
    onfill,
    onreplace,
    ontransform,
    oncopy,
    oncut,
    onpaste,
    ondelete,
    moving,
    onmove,
    onclearselection,
    onselectall,
  }: Props = $props();

  /** A palette key is `name[a=b,c=d]`; the base name is enough to type back. */
  function baseName(entry: string): string {
    return entry.split("[")[0];
  }


  const volume = $derived(
    selection === null
      ? 0
      : (selection.maxX - selection.minX + 1) *
          (selection.maxY - selection.minY + 1) *
          (selection.maxZ - selection.minZ + 1),
  );

  const none = $derived(selection === null);
</script>

<div class="tools">
  {#if selection}
    <p class="readout">
      {t("selection.size", {
        width: selection.maxX - selection.minX + 1,
        height: selection.maxY - selection.minY + 1,
        length: selection.maxZ - selection.minZ + 1,
      })}
    </p>
    <p class="coords">
      {t("selection.range", {
        minX: selection.minX,
        minY: selection.minY,
        minZ: selection.minZ,
        maxX: selection.maxX,
        maxY: selection.maxY,
        maxZ: selection.maxZ,
        volume: volume.toLocaleString(),
      })}
    </p>
  {:else}
    <p class="hint">{t("selection.hint")}</p>
  {/if}

  {#if palette.length > 0}
    <div class="group">
      <label for="tool-materials">{t("doc.materials")}</label>
      <ul id="tool-materials" class="palette">
        {#each palette as entry (entry.block)}
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
    </div>
  {/if}

  <div class="group">
    <label for="tool-to-block">{t("selection.block")}</label>
    <div class="field">
      <BlockPicker
        id="tool-to-block"
        value={block}
        placeholder="minecraft:stone"
        {blocks}
        onchange={onblockchange}
      />
      <button
        class="icon browse"
        onclick={() => onbrowse("fill")}
        title={t("selection.browse")}
        aria-label={t("selection.browse")}
      >
        &#x229E;
      </button>
    </div>
    <button
      class="primary wide"
      onclick={() => onfill(block)}
      disabled={busy || none || block.trim() === ""}
      title={none ? t("selection.selectFirst") : t("selection.fillHint")}
    >
      {t("selection.fill")}
    </button>
  </div>

  <div class="group">
    <label for="tool-from-block">{t("selection.replace")}</label>
    <div class="field">
      <BlockPicker
        id="tool-from-block"
        value={replaceFrom}
        placeholder="minecraft:cobblestone"
        {blocks}
        onchange={onreplacefromchange}
      />
      <button
        class="icon browse"
        onclick={() => onbrowse("replace")}
        title={t("selection.browse")}
        aria-label={t("selection.browse")}
      >
        &#x229E;
      </button>
    </div>
    <button
      class="wide"
      onclick={() => onreplace(replaceFrom, block)}
      disabled={busy || none || replaceFrom.trim() === "" || block.trim() === ""}
      title={none ? t("selection.selectFirst") : t("selection.replaceHint")}
    >
      {t("selection.replaceButton")}
    </button>
  </div>

  <div class="row">
    <button onclick={oncopy} disabled={busy || none} title={t("selection.copy")}>
      {t("selection.copy")}
    </button>
    <button onclick={oncut} disabled={busy || none} title={t("selection.cut")}>
      {t("selection.cut")}
    </button>
    <button
      onclick={onpaste}
      disabled={busy || clipboard === null || none}
      title={clipboard === null
        ? t("selection.pasteNoClipboard")
        : none
          ? t("selection.pasteNoSelection")
          : t("selection.pasteHint", {
              width: clipboard.width,
              height: clipboard.height,
              length: clipboard.length,
            })}
    >
      {t("selection.paste")}
    </button>
  </div>

  {#if clipboard}
    <p class="hint">
      {t("selection.clipboard", {
        width: clipboard.width,
        height: clipboard.height,
        length: clipboard.length,
        blocks: clipboard.blocks.toLocaleString(),
      })}
    </p>
  {/if}

  <div class="row">
    <button
      class:active={moving}
      onclick={onmove}
      disabled={busy || none}
      title={moving ? t("selection.moveCancelHint") : t("selection.moveHint")}
    >
      {moving ? t("selection.moveCancel") : t("selection.move")}
    </button>
  </div>

  <div class="row">
    <button
      onclick={() => ontransform({ kind: "rotate", steps: 1 })}
      disabled={busy || none}
      title={t("selection.rotate90Hint")}
    >
      {t("selection.rotate90")}
    </button>
    <button
      onclick={() => ontransform({ kind: "rotate", steps: 2 })}
      disabled={busy || none}
      title={t("selection.rotate180Hint")}
    >
      {t("selection.rotate180")}
    </button>
  </div>
  <div class="row">
    <button
      onclick={() => ontransform({ kind: "mirror", axis: "x" })}
      disabled={busy || none}
      title={t("selection.flipXHint")}
    >
      {t("selection.flipX")}
    </button>
    <button
      onclick={() => ontransform({ kind: "mirror", axis: "z" })}
      disabled={busy || none}
      title={t("selection.flipZHint")}
    >
      {t("selection.flipZ")}
    </button>
  </div>

  <div class="row">
    <button onclick={onselectall} disabled={busy}>{t("selection.all")}</button>
    <button onclick={onclearselection} disabled={busy || none} title={t("selection.clearHint")}>
      {t("selection.clear")}
    </button>
    <button
      class="danger"
      onclick={ondelete}
      disabled={busy || none}
      title={t("selection.deleteHint")}
    >
      {t("selection.delete")}
    </button>
  </div>
</div>

<style>
  .tools {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
  }

  .readout {
    margin: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .coords {
    margin: -4px 0 0;
    font-size: 11px;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .group label {
    margin: 0;
  }

  .row {
    display: flex;
    gap: 5px;
  }

  .row button {
    flex: 1;
    min-width: 0;
    padding: 5px 6px;
    font-size: 12px;
  }

  /* Armed, so the button says the app is waiting for a click in the viewport
     rather than for another press on itself. */
  .row button.active {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* The one button here that destroys blocks rather than moving or copying
     them, coloured like the risk it carries. */
  .danger {
    border-color: var(--danger);
    color: var(--danger);
  }

  /* The picker takes the room; the browse button is a fixed square beside it. */
  .field {
    display: flex;
    align-items: stretch;
    gap: 4px;
  }

  .field :global(> *:first-child) {
    flex: 1 1 auto;
    min-width: 0;
  }

  .browse {
    flex: none;
    width: 26px;
  }

  .wide {
    width: 100%;
    padding: 6px 8px;
    font-size: 12px;
  }

  .tools :global(.hint) {
    margin: 0;
  }

  /*
   * Scrolls inside itself rather than growing the window, and the whole palette
   * is in it now.
   *
   * It used to show eight and say "…and N more", over a `DocumentState` that
   * had already been cut to 64 without saying anything -- so on any schematic
   * with more distinct states than that, the sentence understated the palette.
   * "The window has nowhere to grow" was the reason for the cap, and the window
   * can be resized now, so the height is a share of it: drag the panel taller
   * and the list gets taller with it.
   */
  .palette {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: max(132px, 22vh);
    overflow-y: auto;
    font-size: 11px;
  }

  .palette li {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 1px 0;
  }

  .palette .count {
    flex: none;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  button.link {
    overflow: hidden;
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button.link:hover {
    text-decoration: underline;
  }
</style>
