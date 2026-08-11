<script lang="ts" module>
  export interface Command {
    id: string;
    title: string;
    /** Where it lives in the UI, shown beside the title. */
    group: string;
    /** Extra words to match on — what someone might call this instead. */
    keywords?: string;
    /** Shown right-aligned, e.g. "Ctrl+S". */
    shortcut?: string;
    enabled: boolean;
    run: () => void;
  }

  /**
   * Commands matching `query`, best first, with the unavailable ones last.
   *
   * Disabled commands are kept rather than filtered out. "Save" vanishing
   * because nothing is open reads as a missing feature; "Save" greyed out
   * says the app has it and this is not the moment.
   */
  export function searchCommands(commands: readonly Command[], query: string): Command[] {
    const needle = query.trim().toLowerCase();
    const rank = (command: Command): number => {
      if (needle === "") return 0;
      const title = command.title.toLowerCase();
      if (title === needle) return 0;
      if (title.startsWith(needle)) return 1;
      if (title.includes(needle)) return 2;
      const haystack = `${command.group} ${command.keywords ?? ""}`.toLowerCase();
      return haystack.includes(needle) ? 3 : -1;
    };

    return commands
      .map((command) => ({ command, rank: rank(command) }))
      .filter((entry) => entry.rank >= 0)
      .sort(
        (a, b) =>
          // Available first, whatever the text says: offering something that
          // cannot run above something that can wastes the top of the list.
          Number(b.command.enabled) - Number(a.command.enabled) || a.rank - b.rank,
      )
      .map((entry) => entry.command);
  }
</script>

<script lang="ts">
  /**
   * Every action in the app, by name.
   *
   * The commands are built in `App.svelte`, beside the handlers they call, so
   * the palette cannot drift into offering something the buttons no longer do.
   */
  interface Props {
    open: boolean;
    commands: readonly Command[];
    onclose: () => void;
  }

  const { open, commands, onclose }: Props = $props();

  let query = $state("");
  let highlighted = $state(0);
  let input = $state<HTMLInputElement | undefined>(undefined);
  let list = $state<HTMLUListElement | undefined>(undefined);

  const matches = $derived(searchCommands(commands, query));

  // Opening starts fresh and takes the keyboard. Without the focus the first
  // thing typed goes to whatever had it before — in Creative mode, the camera.
  $effect(() => {
    if (open) {
      query = "";
      highlighted = 0;
      input?.focus();
    }
  });

  $effect(() => {
    if (!open || list === undefined) return;
    (list.children[highlighted] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  });

  function choose(command: Command): void {
    if (!command.enabled) return;
    // Closed first: several of these open a dialog of their own, and a palette
    // still sitting over it would take the keys meant for it.
    onclose();
    command.run();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      highlighted = Math.min(highlighted + 1, matches.length - 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = matches[highlighted];
      if (command) choose(command);
    }
  }
</script>

{#if open}
  <!--
    `keydown` is handled on the wrapper rather than on `window`: while this is
    open it is the only thing that should see the keyboard, and the app's own
    single-key shortcuts must not fire on what is being typed here.
  -->
  <div
    class="scrim"
    role="presentation"
    onkeydown={onKeydown}
    onclick={(event) => {
      // Only a click on the backdrop itself. Comparing target to currentTarget
      // rather than stopping propagation inside the dialog: the dialog is not
      // an interactive element and hanging a click handler on it just to
      // swallow events is what the a11y lint is objecting to.
      if (event.target === event.currentTarget) onclose();
    }}
  >
    <div class="palette" role="dialog" aria-label="Commands">
      <input
        bind:this={input}
        bind:value={query}
        placeholder="Type a command…"
        spellcheck="false"
        autocomplete="off"
        oninput={() => (highlighted = 0)}
      />
      {#if matches.length === 0}
        <p class="empty">Nothing matches “{query}”.</p>
      {:else}
        <ul bind:this={list}>
          {#each matches as command, i (command.id)}
            <li>
              <button
                type="button"
                class:highlighted={i === highlighted}
                disabled={!command.enabled}
                onmouseenter={() => (highlighted = i)}
                onclick={() => choose(command)}
              >
                <span class="title">{command.title}</span>
                <span class="group">{command.group}</span>
                {#if command.shortcut}
                  <kbd>{command.shortcut}</kbd>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    justify-content: center;
    /* Not centred: a dialog that grows and shrinks around the midpoint moves
       the first row while the user is aiming at it. */
    align-items: flex-start;
    padding-top: 12vh;
  }

  .palette {
    width: min(560px, 90vw);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }

  .palette input {
    width: 100%;
    box-sizing: border-box;
    border: none;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    padding: 12px 14px;
    font-size: 15px;
  }

  .palette ul {
    list-style: none;
    margin: 0;
    padding: 4px;
    max-height: 46vh;
    overflow-y: auto;
  }

  .palette button {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    box-sizing: border-box;
    text-align: left;
    padding: 7px 10px;
    background: none;
    border: none;
    border-radius: 4px;
    color: inherit;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .palette button.highlighted:not(:disabled) {
    background: var(--accent-dim);
  }

  .palette button:disabled {
    color: var(--text-dim);
    cursor: default;
  }

  .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .group {
    font-size: 11px;
    color: var(--text-dim);
  }

  kbd {
    font: inherit;
    font-size: 11px;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 5px;
  }

  .empty {
    margin: 0;
    padding: 14px;
    font-size: 13px;
    color: var(--text-dim);
  }
</style>
