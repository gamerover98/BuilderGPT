<script lang="ts">
  /**
   * Which schematic this is, and the two verbs you reach for most.
   *
   * It lives in the application bar because that is where it is always visible.
   * Before this, the file's name, its size and — the one that matters — whether
   * it had unsaved changes were shown *only* inside the sidebar's second tab:
   * the app could tell you that you had unpaid work, but only if you were
   * looking away from the thing you were building.
   *
   * The app's own name gave up the spot and moved to the window title, which is
   * where a desktop app puts it and where it can carry the file name too.
   *
   * Undo and Redo are here rather than in the menu with an accelerator, because
   * the menu deliberately does not claim Ctrl+Z — see `menu_model.ts`. These
   * buttons and the keyboard handler are the two ways to reach them.
   */
  import type { DocumentState } from "../../../shared/ipc.js";
  import { SCHEMATIC_FORMAT_LABEL } from "../../../shared/schematic.js";
  import { mcVersion, versionNameOf } from "../../../shared/mc_versions.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    /** `doc`, not `state`: a prop of that name breaks every rune in the file. */
    doc: DocumentState | null;
    busy: boolean;
    /**
     * Whether there is anything to take back — which is not the same question
     * as `doc.canUndo`. A selection change is undoable too, and it lives in the
     * renderer, so main's answer alone would grey the button out with a step
     * still waiting on the stack.
     */
    canundo: boolean;
    canredo: boolean;
    onundo: () => void;
    onredo: () => void;
    /**
     * Opens the version history.
     *
     * Here because nothing else summons it. The tools come back with the next
     * selection and the inspector with the next click, so both can be closed
     * without being lost; this one has no gesture of its own, and a floating
     * window with no way back is a feature you delete by accident.
     */
    onversions: () => void;
    /**
     * Brings the start screen back after it has been dismissed.
     *
     * It blocks the window now, so it has to be dismissable — the generator is
     * reached by typing into the chat with nothing open, and a screen covering
     * the chat that could not be put away would delete the path it advertises.
     * This is the way back, and `startvisible` is what stops it offering to
     * summon something already on screen.
     */
    onstart: () => void;
    startvisible: boolean;
  }

  const {
    doc,
    busy,
    canundo,
    canredo,
    onundo,
    onredo,
    onversions,
    onstart,
    startvisible,
  }: Props = $props();

  /**
   * The version the file will be stamped with, when it carries one at all.
   *
   * Nothing rather than a guess: an MCEdit file legitimately has no tag, and
   * inventing a plausible version for it would be worse than saying nothing.
   */
  const versionLabel = $derived(
    doc === null ? null : (mcVersion(versionNameOf(doc.dataVersion) ?? "")?.label ?? null),
  );

  const facts = $derived(
    doc === null
      ? ""
      : [
          `${doc.size[0]}×${doc.size[1]}×${doc.size[2]}`,
          t("bar.blocks", { count: doc.blockCount.toLocaleString() }),
          SCHEMATIC_FORMAT_LABEL[doc.format],
          versionLabel,
        ]
          .filter((part) => part !== null && part !== "")
          .join(" · "),
  );
</script>

{#if doc === null}
  <h1>{t("app.title")}</h1>
  {#if !startvisible}
    <button class="start-again" onclick={onstart} title={t("start.reopenHint")}>
      {t("start.reopen")}
    </button>
  {/if}
{:else}
  <div class="identity" title={doc.filePath ?? t("doc.notSaved")}>
    <strong class:dirty={doc.dirty}>
      {doc.fileName ?? t("doc.untitled")}{doc.dirty ? " •" : ""}
    </strong>
    <span class="facts">{facts}</span>
  </div>

  <div class="edits" role="group" aria-label={t("bar.editing")}>
    <button
      onclick={onundo}
      disabled={busy || !canundo}
      title={doc.undoLabel ?? t("doc.nothingToUndo")}
    >
      {t("doc.undo")}
    </button>
    <button
      onclick={onredo}
      disabled={busy || !canredo}
      title={doc.redoLabel ?? t("doc.nothingToRedo")}
    >
      {t("doc.redo")}
    </button>
    <button onclick={onversions} disabled={busy} title={t("versions.openHint")}>
      {t("versions.open")}
    </button>
  </div>
{/if}

<style>
  .start-again {
    margin-left: 12px;
    padding: 3px 10px;
    font-size: 12px;
  }

  h1 {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  /*
   * One line, because the bar is 44px tall. The name keeps its width and the
   * facts give way: which file this is survives a narrow window, and
   * "892 blocks" does not need to.
   */
  .identity {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
  }

  strong {
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
    font-weight: 600;
  }

  /* The marker is a colour as well as a bullet: a lone `•` beside a file name
     reads as punctuation until you already know what it means. */
  strong.dirty {
    color: var(--accent);
  }

  .facts {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    color: var(--text-dim);
  }

  .edits {
    display: flex;
    flex: none;
    gap: 4px;
  }

  .edits button {
    padding: 3px 9px;
    font-size: 12px;
  }
</style>
