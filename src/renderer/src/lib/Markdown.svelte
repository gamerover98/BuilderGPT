<script lang="ts">
  /**
   * An agent's answer, rendered.
   *
   * This is the one place in the app that uses `{@html}`, and the only reason
   * it is tolerable is that nothing reaches it except through `toSafeHtml`,
   * which sanitises with the allowlist in `markdown_policy.ts`. If you are
   * adding a second caller, send it through the same function; if you are
   * tempted to pass `entry.text` straight in, that is the mistake this comment
   * exists to stop.
   *
   * Only `agent` turns come here. What the user typed stays literal — echoing
   * someone's own words back with the asterisks eaten is a small betrayal, and
   * this app's users type `minecraft:oak_log` all day.
   */
  import DOMPurify from "dompurify";

  import { t } from "./i18n.svelte.js";
  import { toSafeHtml, type Purifier } from "./markdown.js";

  interface Props {
    source: string;
  }

  const { source }: Props = $props();

  const html = $derived(toSafeHtml(source, DOMPurify as unknown as Purifier));

  let container = $state<HTMLDivElement | undefined>(undefined);
  /** Which `<pre>` last had its contents copied, so the label can say so. */
  let copied = $state<HTMLElement | null>(null);

  /**
   * Hangs a copy button off every code block.
   *
   * Done to the DOM after injection rather than in the markdown pipeline,
   * because a button is a control and controls have no business being produced
   * by a sanitiser — anything `toSafeHtml` emits has to survive the allowlist,
   * and adding `<button>` to that list to get this would widen the one thing
   * the file exists to keep narrow.
   *
   * The click is handled by delegation on the container instead of by a
   * listener per button, so the buttons are inert markup and there is nothing
   * to unbind when the message re-renders.
   */
  $effect(() => {
    // Depend on the rendered html, not just the element: a new answer replaces
    // the whole subtree and the buttons go with it.
    void html;
    if (!container) return;
    copied = null;

    for (const pre of container.querySelectorAll("pre")) {
      if (pre.parentElement?.classList.contains("code")) continue;

      const wrapper = document.createElement("div");
      wrapper.className = "code";
      pre.replaceWith(wrapper);
      wrapper.append(pre);

      const button = document.createElement("button");
      button.className = "copy";
      button.type = "button";
      button.dataset.copy = "";
      button.textContent = t("chat.copyCode");
      wrapper.append(button);
    }
  });

  async function onClick(event: MouseEvent): Promise<void> {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLElement>("[data-copy]");
    const pre = button?.parentElement?.querySelector("pre");
    if (!button || !pre) return;

    try {
      await navigator.clipboard.writeText(pre.textContent ?? "");
      button.textContent = t("chat.copied");
      copied = button;
    } catch {
      // A clipboard the browser refused is not worth an error banner in a chat
      // log. The button simply does not change, and the text is still there to
      // select by hand.
    }
  }

  /** Puts every other button's label back once one of them says "Copied". */
  $effect(() => {
    if (!container || copied === null) return;
    for (const button of container.querySelectorAll<HTMLElement>("[data-copy]")) {
      if (button !== copied) button.textContent = t("chat.copyCode");
    }
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="markdown" bind:this={container} onclick={onClick}>{@html html}</div>

<style>
  .markdown {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    /* The container itself must never scroll sideways -- individual wide
       children do that for themselves, below. */
    overflow-wrap: anywhere;
  }

  /*
   * Everything below is `:global`, because none of it is in this component's
   * markup: it is injected. Svelte scopes styles by adding a class at compile
   * time, and there is nothing to add it to.
   */
  .markdown :global(p) {
    margin: 0 0 8px;
  }

  .markdown :global(> *:last-child) {
    margin-bottom: 0;
  }

  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4),
  .markdown :global(h5),
  .markdown :global(h6) {
    margin: 12px 0 6px;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
  }

  .markdown :global(h1) {
    font-size: 15px;
  }

  .markdown :global(h2) {
    font-size: 14px;
  }

  .markdown :global(ul),
  .markdown :global(ol) {
    margin: 0 0 8px;
    padding-left: 20px;
  }

  .markdown :global(li) {
    margin: 2px 0;
  }

  .markdown :global(blockquote) {
    margin: 0 0 8px;
    padding: 2px 0 2px 10px;
    border-left: 2px solid var(--border);
    color: var(--text-dim);
  }

  .markdown :global(hr) {
    margin: 12px 0;
    border: none;
    border-top: 1px solid var(--border);
  }

  .markdown :global(code) {
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--bg-input);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
  }

  /* The wrapper the effect adds, so the button has something to sit against. */
  .markdown :global(.code) {
    position: relative;
    margin: 0 0 8px;
  }

  .markdown :global(pre) {
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-input);
    /* A long line scrolls inside the block rather than widening the panel. */
    overflow-x: auto;
  }

  .markdown :global(pre code) {
    padding: 0;
    background: none;
  }

  .markdown :global(.copy) {
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--text-dim);
    font-size: 11px;
    /* Out of the way until wanted: the code is what you came to read. */
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .markdown :global(.code:hover .copy),
  .markdown :global(.copy:focus-visible) {
    opacity: 1;
  }

  /*
   * A table in a 380px column does not fit, and the panel must not be the thing
   * that scrolls -- that would drag the whole conversation sideways.
   * `display: block` turns the table into its own scroll container, which is
   * the one way to get this without wrapping it in an extra element.
   */
  .markdown :global(table) {
    display: block;
    width: max-content;
    max-width: 100%;
    margin: 0 0 8px;
    overflow-x: auto;
    border-collapse: collapse;
    font-size: 12px;
  }

  .markdown :global(th),
  .markdown :global(td) {
    padding: 3px 8px;
    border: 1px solid var(--border);
    text-align: left;
  }

  .markdown :global(th) {
    background: var(--bg-input);
    font-weight: 600;
  }

  /* `marked` writes the GFM alignment row as an attribute, not a class. */
  .markdown :global([align="center"]) {
    text-align: center;
  }

  .markdown :global([align="right"]) {
    text-align: right;
  }

  .markdown :global(a) {
    color: var(--accent);
  }
</style>
