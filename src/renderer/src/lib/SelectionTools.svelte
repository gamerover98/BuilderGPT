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
  import type { ClipboardInfo, RegionSpec, TransformRequest } from "../../../shared/ipc.js";
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
    clipboard: ClipboardInfo | null;
    onfill: (block: string) => void;
    onreplace: (from: string, to: string) => void;
    ontransform: (transform: TransformRequest["transform"]) => void;
    oncopy: () => void;
    oncut: () => void;
    onpaste: () => void;
    onclearselection: () => void;
    onselectall: () => void;
  }

  const {
    selection,
    busy,
    blocks,
    block,
    onblockchange,
    clipboard,
    onfill,
    onreplace,
    ontransform,
    oncopy,
    oncut,
    onpaste,
    onclearselection,
    onselectall,
  }: Props = $props();

  let fromBlock = $state("");

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

  <div class="group">
    <label for="tool-to-block">{t("selection.block")}</label>
    <BlockPicker
      id="tool-to-block"
      value={block}
      placeholder="minecraft:stone"
      {blocks}
      onchange={onblockchange}
    />
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
    <BlockPicker
      id="tool-from-block"
      value={fromBlock}
      placeholder="minecraft:cobblestone"
      {blocks}
      onchange={(next) => (fromBlock = next)}
    />
    <button
      class="wide"
      onclick={() => onreplace(fromBlock, block)}
      disabled={busy || none || fromBlock.trim() === "" || block.trim() === ""}
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
    <button onclick={onclearselection} disabled={busy || none}>{t("selection.clear")}</button>
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

  .wide {
    width: 100%;
    padding: 6px 8px;
    font-size: 12px;
  }

  .tools :global(.hint) {
    margin: 0;
  }
</style>
