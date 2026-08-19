<script lang="ts">
  /**
   * The conversation, and the whole height of the panel.
   *
   * The previous version was a 320px-tall box wedged between five other
   * fieldsets in a scrolling column: the log scrolled inside a scroller, and
   * the prompt drifted off-screen as the page grew. Here the log is the only
   * thing that scrolls and the composer is pinned beneath it, which is the
   * arrangement that makes a chat usable and the one this was asked to match.
   *
   * Tool calls still arrive as they happen rather than all at the end, because
   * a request can take half a minute and a panel that shows nothing for that
   * long is indistinguishable from one that has hung. They fold into a
   * disclosure once the turn lands, though: while it is running they are the
   * only evidence of progress, and afterwards they are the least interesting
   * part of the answer.
   */
  import type {
    AgentStepEvent,
    ChatEntry,
    ConversationSummary,
    RegionSpec,
  } from "../../../shared/ipc.js";
  import type { KeyStorageStatus, Settings } from "../../../shared/settings.js";
  import ChatComposer from "./ChatComposer.svelte";
  import ConversationPicker from "./ConversationPicker.svelte";
  import Markdown from "./Markdown.svelte";
  import { t, tn } from "./i18n.svelte.js";

  interface Props {
    entries: ChatEntry[];
    /** Tool calls for the turn in flight, cleared when it lands. */
    live: AgentStepEvent[];
    selection: RegionSpec | null;
    /** Exchanges the agent is carrying into the next question. */
    remembered: number;
    /**
     * Index into `entries` where the agent's memory begins.
     *
     * Computed by main, not here. "The last N user turns" is the obvious rule
     * and it is wrong: a run that failed leaves its entry in the log without
     * ever entering the model's memory, so counting from this side drifts by
     * one for every error above it. `0` means everything is remembered.
     */
    rememberedFrom: number;
    /**
     * Whether a schematic is open.
     *
     * Not a gate any more — it decides what a message *means*. With something
     * open the agent edits it; with nothing open the prompt describes a
     * schematic to build, and the generator makes one.
     */
    hasDocument: boolean;
    busy: boolean;
    settings: Settings;
    keyStatus: KeyStorageStatus | null;
    /** Held by `App.svelte` so a tab switch cannot throw it away. */
    draft: string;
    ondraftchange: (draft: string) => void;
    /**
     * The undo entry currently on top of the stack. A turn offers "Undo this"
     * only while it matches its own — once anything else has been done, that
     * button would revert the wrong thing.
     */
    undoLabel: string | null;
    /** Its id, which is what the match is actually made on. */
    undoTransactionId: number | null;
    /** Every conversation about this schematic, newest first. */
    conversations: ConversationSummary[];
    activeConversationId: string;
    onask: (prompt: string) => void;
    /** Starts another conversation; the current one stays in the list. */
    onforget: () => void;
    onrefreshconversations: () => void;
    onopenconversation: (id: string) => void;
    ondeleteconversation: (id: string) => void;
    onstop: () => void;
    onundo: () => void;
    onsettingschange: (patch: Partial<Settings>) => void;
    onopensettings: () => void;
  }

  const {
    entries,
    live,
    selection,
    remembered,
    rememberedFrom,
    hasDocument,
    busy,
    settings,
    keyStatus,
    draft,
    ondraftchange,
    undoLabel,
    undoTransactionId,
    conversations,
    activeConversationId,
    onask,
    onforget,
    onrefreshconversations,
    onopenconversation,
    ondeleteconversation,
    onstop,
    onundo,
    onsettingschange,
    onopensettings,
  }: Props = $props();

  /** The few tallies that matter, and how many were left out. */
  const SHOWN = 4;

  /**
   * Starters for each of the two things a first message can be.
   *
   * With nothing open they describe a build, because that is what a prompt
   * does then; with a document they describe an edit.
   */
  const EDIT_EXAMPLES = ["chat.example1", "chat.example2", "chat.example3"];
  const BUILD_EXAMPLES = ["chat.build1", "chat.build2", "chat.build3"];
  const examples = $derived(hasDocument ? EDIT_EXAMPLES : BUILD_EXAMPLES);

  let log = $state<HTMLDivElement | undefined>(undefined);
  /** Which agent turns have had their tool list opened, by index. */
  let expanded = $state<Record<number, boolean>>({});

  /**
   * Follows the conversation down.
   *
   * Only when the user is already near the bottom: yanking the view back while
   * they are reading something further up is worse than not following at all.
   */
  $effect(() => {
    void entries;
    void live;
    const element = log;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance < 160) {
      queueMicrotask(() => element.scrollTo({ top: element.scrollHeight }));
    }
  });

  function who(role: ChatEntry["role"]): string {
    if (role === "user") return t("chat.you");
    if (role === "error") return t("chat.failed");
    if (role === "note") return t("chat.stopped");
    return t("chat.ai");
  }
</script>

<section class="chat">
<!--
    The header names the conversation you are in rather than the panel you are
    looking at: "Chat" was true and told you nothing, and with several
    conversations per schematic the useful fact is which one this is.
  -->
  <header>
    <ConversationPicker
      {conversations}
      activeId={activeConversationId}
      {busy}
      onrefresh={onrefreshconversations}
      onopen={onopenconversation}
      ondelete={ondeleteconversation}
    />
    <button
      class="icon"
      onclick={onforget}
      disabled={busy || (entries.length === 0 && remembered === 0)}
      title={t("chat.newChatHint")}
      aria-label={t("chat.newChat")}>&#x002b;</button
    >
  </header>

  <div class="log" bind:this={log}>
    {#if entries.length === 0 && live.length === 0}
      <div class="empty">
        <p>{hasDocument ? t("chat.emptyTitle") : t("chat.emptyBuildTitle")}</p>
        <ul class="examples">
          {#each examples as key (key)}
            <li><button class="example" onclick={() => onask(t(key))}>{t(key)}</button></li>
          {/each}
        </ul>
      </div>
    {/if}

    {#each entries as entry, index (index)}
      {#if index === rememberedFrom && rememberedFrom > 0}
        <!--
          Everything above this line is readable and not remembered. Without it
          the agent looks as though it has forgotten something plainly visible
          three messages up -- which it has, and which nothing said.
        -->
        <div class="boundary" role="separator">
          <span>{t("chat.memoryStarts")}</span>
        </div>
      {/if}
      <article class={`turn ${entry.role}`}>
        <div class="avatar" aria-hidden="true">{entry.role === "user" ? "●" : "✦"}</div>
        <div class="body">
          <span class="who">{who(entry.role)}</span>

          {#if entry.steps && entry.steps.length > 0}
            <button
              class="tools"
              aria-expanded={expanded[index] === true}
              onclick={() => (expanded = { ...expanded, [index]: !expanded[index] })}
            >
              <span class="caret" aria-hidden="true">{expanded[index] ? "▾" : "▸"}</span>
              {tn("chat.toolsUsed", entry.steps.length)}
            </button>
            {#if expanded[index]}
              <ul class="steps">
                {#each entry.steps as step, stepIndex (stepIndex)}
                  <li>{step.summary}</li>
                {/each}
              </ul>
            {/if}
          {/if}

          <!--
            Only the agent's turns are markdown. What the user typed is shown
            back exactly as typed -- their asterisks and their
            `minecraft:oak_log` survive -- and an error message is main's own
            wording, which arrives already phrased and is not ours to reformat.
          -->
          {#if entry.role === "agent"}
            <Markdown source={entry.text} />
          {:else}
            <p class="text">{entry.text}</p>
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
                    {t("chat.andMore", { count: entry.summary.removed.length - SHOWN })}
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
                    {t("chat.andMore", { count: entry.summary.added.length - SHOWN })}
                  {/if}
                </p>
              {/if}
            </div>
            <!--
              By id, not by label. The label comes from the prompt, so asking
              for "make it taller" twice produced two turns this could not tell
              apart, and the button offered to undo whichever was on top.
            -->
            {#if entry.undoTransactionId != null && entry.undoTransactionId === undoTransactionId}
              <div class="buttons">
                <button onclick={onundo} disabled={busy}>{t("chat.undoThis")}</button>
              </div>
            {/if}
          {:else if entry.changed !== undefined && entry.changed > 0}
            <span class="hint">
              {t("chat.blocksChanged", { count: entry.changed.toLocaleString() })}
            </span>
          {/if}
        </div>
      </article>
    {/each}

    {#if live.length > 0}
      <article class="turn agent">
        <div class="avatar pulse" aria-hidden="true">&#x2726;</div>
        <div class="body">
          <span class="who">{t("chat.ai")}</span>
          <ul class="steps live">
            {#each live as step, index (index)}
              <li>{step.summary}</li>
            {/each}
          </ul>
        </div>
      </article>
    {/if}
  </div>

  <footer>
    <ChatComposer
      {selection}
      {busy}
      {hasDocument}
      {settings}
      {keyStatus}
      {draft}
      {ondraftchange}
      {onask}
      {onstop}
      {onsettingschange}
      {onopensettings}
    />
    {#if remembered > 0}
      <p class="hint memory">{tn("chat.remembered", remembered)}</p>
    {/if}
  </footer>
</section>

<style>
  /*
   * `min-height: 0` on the log is what lets it scroll instead of stretching the
   * panel: a flex item's automatic minimum size is its content, so without it a
   * long conversation pushes the composer off the bottom of the window.
   */
  .chat {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 2px 8px;
  }

  .title {
    font-size: 12px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  .log {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-right: 4px;
  }

  .empty {
    padding: 24px 4px;
    color: var(--text-dim);
    font-size: 13px;
  }

  .empty p {
    margin: 0 0 10px;
  }

  .examples {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .example {
    width: 100%;
    padding: 7px 10px;
    text-align: left;
    font-size: 12px;
    color: var(--text-dim);
    background: var(--bg-input);
  }

  .example:hover {
    color: var(--text);
  }

  .boundary {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0 10px;
    color: var(--text-dim);
    font-size: 11px;
  }

  .boundary::before,
  .boundary::after {
    content: "";
    flex: 1;
    border-top: 1px solid var(--border);
  }

  .turn {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    gap: 8px;
    padding: 10px 0;
  }

  .turn + .turn {
    border-top: 1px solid var(--border);
  }

  .avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--bg-input);
    border: 1px solid var(--border);
    font-size: 10px;
    color: var(--text-dim);
  }

  .turn.agent .avatar {
    color: var(--accent);
  }

  .turn.error .avatar {
    color: var(--danger);
  }

  .turn.note .avatar {
    color: var(--warn);
  }

  .pulse {
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }

  .body {
    min-width: 0;
    font-size: 13px;
  }

  .who {
    display: block;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim);
    margin-bottom: 2px;
  }

  .turn.error .who {
    color: var(--danger);
  }

  .turn.note .who {
    color: var(--warn);
  }

  .text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .tools {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-bottom: 4px;
    padding: 1px 0;
    border: none;
    background: none;
    color: var(--text-dim);
    font-size: 12px;
  }

  .tools:hover:not(:disabled) {
    color: var(--text);
  }

  .caret {
    font-size: 9px;
  }

  .steps {
    list-style: none;
    margin: 0 0 6px;
    padding: 0 0 0 10px;
    border-left: 2px solid var(--border);
    font-size: 12px;
    color: var(--text-dim);
  }

  .steps.live {
    margin-top: 4px;
  }

  .receipt {
    margin: 6px 0 0;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .receipt p {
    margin: 0;
    /* Long block ids wrap rather than stretching the panel. */
    overflow-wrap: anywhere;
  }

  .receipt .removed {
    color: var(--danger);
  }

  .receipt .added {
    color: var(--ok);
  }

  .buttons {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .buttons button {
    padding: 4px 10px;
    font-size: 12px;
  }

  footer {
    flex: none;
    padding-top: 10px;
  }

  .memory {
    margin: 6px 2px 0;
  }
</style>
