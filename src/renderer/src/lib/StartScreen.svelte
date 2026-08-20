<script lang="ts">
  /**
   * What the viewport says when nothing is open.
   *
   * It used to say nothing. The canvas mounted, drew its floor grid, and every
   * gesture landed on a document that was not there — the build grid is gated
   * on `documentSize`, so a click was not refused, it simply had no target and
   * nothing on screen explained why. The two things that would have fixed it,
   * New and Open, were one click away inside a sidebar tab that is not the
   * default one.
   *
   * Here rather than inside `Viewer.svelte`, and that is not arbitrary: the
   * viewer receives geometry and has no business knowing what a recent document
   * is. It is a sibling laid over the same canvas.
   *
   * It also names the other way in. With nothing open, a message typed into the
   * chat goes to the *generator* and builds the schematic the rest of the
   * conversation then edits — a real capability that is completely invisible
   * until someone tries it by accident.
   */
  import type { Artifact, RecentDocument } from "../../../shared/ipc.js";
  import { ageLabel } from "./age_label.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    recent: readonly RecentDocument[];
    /**
     * Every file the generator has ever written, newest first.
     *
     * It had a fieldset of its own in the sidebar, which is a strange place for
     * a list whose only two verbs are "open this" and "show me where it is":
     * those are the verbs of this screen. And an `.mcfunction` is never opened,
     * so this is the only thing in the app that admits it exists.
     */
    artifacts: readonly Artifact[];
    busy: boolean;
    onnew: () => void;
    onopen: () => void;
    onopenrecent: (filePath: string) => void;
    onopenartifact: (artifact: Artifact) => void;
    onrevealartifact: (artifact: Artifact) => void;
  }

  const {
    recent,
    artifacts,
    busy,
    onnew,
    onopen,
    onopenrecent,
    onopenartifact,
    onrevealartifact,
  }: Props = $props();

  /** Six is what fits without the card starting to scroll. */
  const shown = $derived(recent.slice(0, 6));

  /*
   * Fewer, and only the ones the recents do not already carry.
   *
   * A generated `.schem` is opened the moment it is made, so it is in the
   * recents by the time anyone sees this screen -- listing it twice would make
   * the card longer without making anything findable.
   */
  const generated = $derived(
    artifacts
      .filter((artifact) => !recent.some((entry) => entry.filePath === artifact.path))
      .slice(0, 4),
  );

  function fileName(filePath: string): string {
    return filePath.split(/[\\/]/).pop() ?? filePath;
  }

  /** The folder, so two builds with the same name are told apart at a glance. */
  function folder(filePath: string): string {
    const parts = filePath.split(/[\\/]/).filter((part) => part !== "");
    return parts.length >= 2 ? parts[parts.length - 2] : "";
  }
</script>

<div class="start" role="region" aria-label={t("start.title")}>
  <div class="card">
    <h2>{t("start.title")}</h2>
    <p class="lead">{t("start.lead")}</p>

    <div class="actions">
      <button class="primary" onclick={onnew} disabled={busy}>{t("doc.new")}</button>
      <button onclick={onopen} disabled={busy}>{t("doc.open")}</button>
    </div>

    {#if shown.length > 0}
      <h3>{t("doc.recent")}</h3>
      <ul class="recent">
        {#each shown as entry (entry.filePath)}
          <li>
            <button
              class="row"
              onclick={() => onopenrecent(entry.filePath)}
              disabled={busy}
              title={entry.filePath}
            >
              <span class="name">{fileName(entry.filePath)}</span>
              <span class="where">{folder(entry.filePath)}</span>
              <span class="when">{ageLabel(entry.openedAt)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if generated.length > 0}
      <h3>{t("start.generated")}</h3>
      <ul class="recent">
        {#each generated as artifact (artifact.path)}
          <li class="generated">
            <!--
              Only a `.schem` opens. An `.mcfunction` is a list of commands and
              nothing in this app reads one back, so its row reveals instead --
              a button whose only outcome is an error would be worse than one
              that does the single thing the file supports, and a disabled row
              worse still, since nothing on it would say why.
            -->
            <button
              class="row"
              onclick={() =>
                artifact.type === "schem" ? onopenartifact(artifact) : onrevealartifact(artifact)}
              disabled={busy}
              title={artifact.path}
            >
              <span class="name">{artifact.name}</span>
              <span class="where">.{artifact.type}</span>
              <span class="when">{ageLabel(Date.parse(artifact.createdAt))}</span>
            </button>
            <button
              class="reveal"
              onclick={() => onrevealartifact(artifact)}
              title={t("start.reveal")}
              aria-label={t("start.reveal")}>&#x2026;</button
            >
          </li>
        {/each}
      </ul>
    {/if}

    <p class="aside">{t("start.dropHint")}</p>
    <p class="aside">{t("start.chatHint")}</p>
  </div>
</div>

<style>
  /*
   * Centred over the canvas, and transparent to the pointer everywhere the
   * card is not. The viewport as a whole is the drag-and-drop target, and a
   * full-bleed overlay that swallowed `dragover` would break dropping a file
   * on the one screen where dropping a file is the obvious thing to do.
   */
  .start {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    pointer-events: none;
  }

  .card {
    pointer-events: auto;
    width: min(420px, 100%);
    max-height: 100%;
    overflow-y: auto;
    padding: 22px 24px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-panel);
    box-shadow: 0 16px 48px var(--shadow);
  }

  h2 {
    margin: 0 0 4px;
    font-size: 17px;
  }

  h3 {
    margin: 20px 0 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
  }

  .lead {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-dim);
  }

  .actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }

  .recent {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 5px 6px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: none;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    text-align: left;
  }

  .row:hover:not(:disabled) {
    border-color: var(--border);
    background: var(--bg-input);
  }

  .row:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .name {
    flex: none;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The folder gives way first: it is the disambiguator, not the identity. */
  .where {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-dim);
    font-size: 11px;
  }

  .when {
    flex: none;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
  }

  .generated {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  /* The one thing an `.mcfunction` can do, since nothing opens it. */
  .reveal {
    flex: none;
    padding: 2px 7px;
    border: 1px solid transparent;
    background: none;
    color: var(--text-dim);
    font-size: 12px;
  }

  .reveal:hover {
    border-color: var(--border);
    color: var(--text);
  }

  .aside {
    margin: 12px 0 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-dim);
  }
</style>
