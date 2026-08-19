<script lang="ts">
  /**
   * What a turn did, drawn.
   *
   * The chat used to narrate a run as a list of one-line summaries — "filling
   * (0,0,0)-(9,3,9) with minecraft:stone" — which says what happened and
   * nothing about *why*, and for a build said "Sending the build spec to the
   * model" and then nothing at all. Here every part of a turn is a row that can
   * be opened: the request that was sent verbatim, the model thinking where it
   * does that, and each tool call with the arguments it was given and the
   * result it returned.
   *
   * ## Everything is collapsed except the thinking, and that is deliberate
   *
   * A trace is long. Opened by default it would push the answer — the thing
   * the user is waiting for — off the bottom of the panel. Reasoning is the
   * exception while it is still arriving, because a model that thinks for
   * thirty seconds and shows a closed box is the problem this replaces.
   *
   * ## Only the reader's own clicks decide what is open
   *
   * `open` is keyed by item id and nothing writes it but the toggles. An
   * earlier arrangement re-derived it from `running`, which snapped rows shut
   * the instant they finished — under the reader's cursor, mid-sentence.
   */
  import type { TraceItem } from "../../../shared/ipc.js";
  import { t, tn } from "./i18n.svelte.js";

  interface Props {
    items: readonly TraceItem[];
    /** Whether the turn is still going; only then is a running row honest. */
    live?: boolean;
  }

  const { items, live = false }: Props = $props();

  let open = $state<Record<number, boolean>>({});
  /** Rows the reader has deliberately shut, so "open while running" can yield. */
  let dismissed = $state<Record<number, boolean>>({});

  function toggle(id: number): void {
    const next = !isOpen(id);
    open = { ...open, [id]: next };
    if (!next) dismissed = { ...dismissed, [id]: true };
  }

  function isOpen(item: TraceItem | number): boolean {
    const id = typeof item === "number" ? item : item.id;
    if (open[id] !== undefined) return open[id];
    // Thinking, while it is still being written. Everything else stays shut
    // until asked for.
    if (typeof item === "number" || dismissed[id]) return false;
    return item.kind === "reasoning" && item.running === true;
  }

  /** The row's heading: what this part of the turn is. */
  function label(item: TraceItem): string {
    if (item.kind === "tool") return item.name ?? t("trace.tool");
    if (item.kind === "request") return t("trace.request");
    if (item.kind === "reasoning") return t("trace.reasoning");
    if (item.kind === "note") return t("trace.note");
    return t("trace.wrote");
  }

  /** `1.4s`, or nothing while it is still going. */
  function duration(item: TraceItem): string {
    if (item.ms === undefined) return "";
    return item.ms < 1000 ? `${item.ms}ms` : `${(item.ms / 1000).toFixed(1)}s`;
  }

  /**
   * A note is one line and has nothing to open; everything else does.
   *
   * A row with a caret that opens an empty box is worse than no caret: it
   * invites a click that answers nothing.
   */
  function hasBody(item: TraceItem): boolean {
    return item.kind !== "note" && (item.text !== "" || item.input !== undefined);
  }
</script>

{#if items.length > 0}
  <div class="trace" class:live>
    {#each items as item (item.id)}
      <div class="row" class:running={item.running}>
        {#if hasBody(item)}
          <button
            class="head"
            aria-expanded={isOpen(item)}
            onclick={() => toggle(item.id)}
          >
            <span class="caret" aria-hidden="true">{isOpen(item) ? "▾" : "▸"}</span>
            <span class="kind {item.kind}">{label(item)}</span>
            <span class="gist">{item.kind === "tool" ? item.text : ""}</span>
            {#if item.running}
              <span class="spinner" aria-hidden="true">●</span>
            {:else if duration(item) !== ""}
              <span class="ms">{duration(item)}</span>
            {/if}
          </button>
        {:else}
          <div class="head static">
            <span class="caret" aria-hidden="true">·</span>
            <span class="kind {item.kind}">{label(item)}</span>
            <span class="gist">{item.text}</span>
          </div>
        {/if}

        {#if isOpen(item) && hasBody(item)}
          <div class="body">
            {#if item.error !== undefined}
              <p class="failed">{item.error}</p>
            {/if}
            {#if item.input !== undefined}
              <p class="caption">{t("trace.arguments")}</p>
              <pre><code>{item.input}</code></pre>
            {/if}
            {#if item.output !== undefined}
              <p class="caption">{t("trace.result")}</p>
              <pre><code>{item.output}</code></pre>
            {/if}
            {#if item.text !== ""}
              {#if item.kind === "reasoning"}
                <!--
                  Prose, not code: reasoning is sentences, and a monospace box
                  with no wrapping turns a paragraph into a horizontal scroll.
                -->
                <p class="thinking">{item.text}</p>
              {:else if item.kind !== "tool"}
                <pre><code>{item.text}</code></pre>
              {/if}
            {/if}
            {#if item.elided !== undefined}
              <p class="elided">{item.elided}</p>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
    {#if live}
      <p class="hint">{tn("trace.stepCount", items.length)}</p>
    {/if}
  </div>
{/if}

<style>
  .trace {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 6px 0;
    padding: 4px 0;
    border-left: 2px solid var(--border);
    padding-left: 8px;
  }

  .trace.live {
    border-left-color: var(--accent);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    padding: 2px 0;
    border: none;
    background: none;
    color: var(--text-dim);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }

  .head.static {
    cursor: default;
  }

  .head:hover:not(.static) {
    color: var(--text);
  }

  .caret {
    flex: none;
    width: 9px;
    font-size: 9px;
  }

  .kind {
    flex: none;
    font-family: var(--mono, ui-monospace, monospace);
    color: var(--text);
  }

  .kind.reasoning {
    color: var(--accent);
    font-style: italic;
  }

  .kind.request {
    color: var(--text-dim);
  }

  /*
   * The one-line gist of a tool call. Truncated rather than wrapped: these sit
   * in a 380px column and a summary naming two coordinate triples would
   * otherwise take three lines each, turning a nine-call turn into a wall.
   */
  .gist {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ms {
    flex: none;
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }

  .spinner {
    flex: none;
    color: var(--accent);
    animation: pulse 1.1s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }

  /* Someone who asked not to see motion is not asking to see less. */
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
      opacity: 0.8;
    }
  }

  .body {
    padding: 2px 0 6px 15px;
  }

  .caption {
    margin: 4px 0 2px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
  }

  /*
   * Scrolls inside itself, both ways. A build script is long and a block-id
   * list is 933 lines; without the cap one trace row would own the panel.
   */
  pre {
    max-height: 240px;
    margin: 0;
    padding: 6px 8px;
    overflow: auto;
    border-radius: 6px;
    background: var(--bg-input);
    font-size: 11px;
    line-height: 1.45;
  }

  code {
    font-family: var(--mono, ui-monospace, monospace);
    white-space: pre;
  }

  .thinking {
    max-height: 240px;
    margin: 0;
    padding: 6px 8px;
    overflow-y: auto;
    border-radius: 6px;
    background: var(--bg-input);
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    color: var(--text-dim);
  }

  .failed {
    margin: 2px 0;
    font-size: 11px;
    color: var(--danger, #e06c75);
  }

  .elided,
  .hint {
    margin: 4px 0 0;
    font-size: 10px;
    color: var(--text-dim);
    font-style: italic;
  }
</style>
