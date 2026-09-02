<script lang="ts">
  /**
   * The schematic's version history, as a modal.
   *
   * It was a `ToolWindow`, put there because it is a reflection of the open
   * document exactly as the inspector is. That is true of its *nature* and was
   * false about its size: a tool window is a fixed 232px, and a row here reads
   * `manual · 64×32×64 · 12,048 blocks` with a Restore button and a delete
   * beside it. Every row ellipsised, and the panel was too small to hold the
   * list it exists to show.
   *
   * Same skeleton as every other modal in the app, including the pointer-lock
   * release: this opens over the viewport, and in flight the canvas holds the
   * pointer, so a panel over a camera still turning underneath is the
   * documented failure.
   */
  import type { DocumentVersion } from "../../../shared/ipc.js";
  import { t } from "./i18n.svelte.js";
  import VersionList from "./VersionList.svelte";

  interface Props {
    open: boolean;
    versions: readonly DocumentVersion[];
    busy: boolean;
    /** Whether the open document has a file yet; the history is keyed on the path. */
    saved: boolean;
    onsave: () => void;
    onrestore: (id: string) => void;
    ondelete: (id: string) => void;
    onclose: () => void;
  }

  const { open, versions, busy, saved, onsave, onrestore, ondelete, onclose }: Props = $props();

  let dialog = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (open) {
      document.exitPointerLock();
      dialog?.focus();
    }
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
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label={t("versions.legend")}
      tabindex="-1"
      bind:this={dialog}
    >
      <header>
        <h2>{t("versions.legend")}</h2>
        <button class="icon close" onclick={onclose} aria-label={t("common.close")}>&#x00d7;</button>
      </header>

      <div class="body">
        <VersionList {versions} {busy} {saved} {onsave} {onrestore} {ondelete} />
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
    position: relative;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    width: min(640px, calc(100vw - 48px));
    max-height: min(620px, calc(100vh - 64px));
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
    padding: 14px 18px 8px;
  }

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  .close {
    position: absolute;
    top: 10px;
    right: 12px;
  }

  /* `min-height: 0` so the list scrolls inside the modal rather than growing it
     past the viewport — the same grid-child rule the other modals need. */
  .body {
    min-height: 0;
    padding: 8px 18px 18px;
    overflow-y: auto;
  }
</style>
