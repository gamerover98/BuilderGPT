<script lang="ts">
  /**
   * Asking the agent to change the open schematic.
   *
   * The tool calls arrive as they happen rather than all at the end, because a
   * request can take half a minute and a panel that shows nothing for that long
   * is indistinguishable from one that has hung.
   */
  import type { AgentStepEvent, EditSummary, RegionSpec } from "../../../shared/ipc.js";

  export interface ChatEntry {
    /** `note` is something that happened but did not go wrong — a stopped run. */
    role: "user" | "agent" | "error" | "note";
    text: string;
    /** Tool calls made while answering; agent turns only. */
    steps?: { tool: string; summary: string }[];
    changed?: number;
    /** What was taken out and put in, by block type. */
    summary?: EditSummary;
    /** The undo entry this turn created, for matching against the live one. */
    undoLabel?: string | null;
  }

  interface Props {
    entries: ChatEntry[];
    /** Tool calls for the turn in flight, cleared when it lands. */
    live: AgentStepEvent[];
    selection: RegionSpec | null;
    /** Exchanges the agent is carrying into the next question. */
    remembered: number;
    enabled: boolean;
    busy: boolean;
    /**
     * The undo entry currently on top of the stack. A turn offers "Undo this"
     * only while it matches its own — once anything else has been done, that
     * button would revert the wrong thing.
     */
    undoLabel: string | null;
    onask: (prompt: string) => void;
    onforget: () => void;
    onstop: () => void;
    onundo: () => void;
  }

  const {
    entries,
    live,
    selection,
    remembered,
    enabled,
    busy,
    undoLabel,
    onask,
    onforget,
    onstop,
    onundo,
  }: Props = $props();

  /** The few that matter, and how many were left out. */
  const SHOWN = 4;

  let draft = $state("");

  function submit(): void {
    const prompt = draft.trim();
    if (prompt === "" || busy || !enabled) return;
    draft = "";
    onask(prompt);
  }

  function onKeydown(event: KeyboardEvent): void {
    // Enter sends, Shift+Enter breaks the line — the convention everywhere else.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }
</script>

<fieldset>
  <legend>Ask the AI</legend>

  {#if !enabled}
    <p class="hint">Open a schematic first — the AI edits the one you have open.</p>
  {:else}
    {#if entries.length > 0 || live.length > 0}
      <ul class="log">
        {#each entries as entry, index (index)}
          <li class={entry.role}>
            <span class="who">
              {#if entry.role === "user"}You{:else if entry.role === "error"}Failed{:else if entry.role === "note"}Stopped{:else}AI{/if}
            </span>
            <span class="text">{entry.text}</span>
            {#if entry.steps && entry.steps.length > 0}
              <ul class="steps">
                {#each entry.steps as step, stepIndex (stepIndex)}
                  <li>{step.summary}</li>
                {/each}
              </ul>
            {/if}
            {#if entry.summary && entry.summary.changed > 0}
              <div class="receipt">
                {#if entry.summary.removed.length > 0}
                  <p class="removed">
                    {#each entry.summary.removed.slice(0, SHOWN) as tally, i (tally.block)}
                      {i > 0 ? ", " : ""}−{tally.count.toLocaleString()}
                      {tally.block}
                    {/each}
                    {#if entry.summary.removed.length > SHOWN}
                      and {entry.summary.removed.length - SHOWN} more
                    {/if}
                  </p>
                {/if}
                {#if entry.summary.added.length > 0}
                  <p class="added">
                    {#each entry.summary.added.slice(0, SHOWN) as tally, i (tally.block)}
                      {i > 0 ? ", " : ""}+{tally.count.toLocaleString()}
                      {tally.block}
                    {/each}
                    {#if entry.summary.added.length > SHOWN}
                      and {entry.summary.added.length - SHOWN} more
                    {/if}
                  </p>
                {/if}
              </div>
              {#if entry.undoLabel && entry.undoLabel === undoLabel}
                <div class="buttons">
                  <button onclick={onundo} disabled={busy}>Undo this</button>
                </div>
              {/if}
            {:else if entry.changed !== undefined && entry.changed > 0}
              <span class="hint">{entry.changed.toLocaleString()} blocks changed</span>
            {/if}
          </li>
        {/each}
        {#if live.length > 0}
          <li class="agent">
            <span class="who">AI</span>
            <ul class="steps">
              {#each live as step, index (index)}
                <li>{step.summary}</li>
              {/each}
            </ul>
          </li>
        {/if}
      </ul>
    {/if}

    <div class="field">
      <label for="prompt">
        {#if selection}
          Acts on your selection unless you say otherwise
        {:else}
          Acts on the whole schematic — select a region to narrow it
        {/if}
      </label>
      <textarea
        id="prompt"
        bind:value={draft}
        onkeydown={onKeydown}
        placeholder="Replace the cobblestone with stone…"
        rows="3"
      ></textarea>
    </div>

    <div class="buttons">
      <button class="primary" onclick={submit} disabled={busy || draft.trim() === ""}>
        {busy ? "Working…" : "Send"}
      </button>
      {#if busy}
        <!--
          Only while a run is in flight, and never disabled. A Stop that is
          greyed out while the thing it stops is running is the one state this
          button must not have.
        -->
        <button onclick={onstop} title="Stop this request; nothing will be changed">Stop</button>
      {:else}
        <button
          onclick={onforget}
          disabled={entries.length === 0 && remembered === 0}
          title="Forget what has been said so far and start over"
        >
          New chat
        </button>
      {/if}
    </div>

    {#if remembered > 0}
      <p class="hint">
        Follow-ups can refer back — the AI remembers
        {remembered === 1 ? "this exchange" : `the last ${remembered} exchanges`}.
      </p>
    {/if}
  {/if}
</fieldset>

<style>
  .log {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    max-height: 320px;
    overflow-y: auto;
    font-size: 13px;
  }

  .log > li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
  }

  .who {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
  }

  .log > li.error .who {
    color: var(--danger);
  }

  .log > li.note .who {
    color: var(--warn);
  }

  .text {
    white-space: pre-wrap;
  }

  .receipt {
    margin: 4px 0 0;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .receipt p {
    margin: 0;
    /* Long block ids wrap rather than stretching the sidebar. */
    overflow-wrap: anywhere;
  }

  .receipt .removed {
    color: var(--danger);
  }

  .receipt .added {
    color: var(--ok);
  }

  .steps {
    list-style: none;
    margin: 4px 0 0;
    padding: 0 0 0 10px;
    border-left: 2px solid var(--border);
    font-size: 12px;
    color: var(--text-dim);
  }

  .buttons {
    display: flex;
    gap: 8px;
  }

  textarea {
    width: 100%;
    resize: vertical;
  }
</style>
