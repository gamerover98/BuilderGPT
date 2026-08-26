<script lang="ts">
  /**
   * "MCP ●" in the application bar.
   *
   * It exists because letting somebody else's model edit your build is only
   * reasonable if you can see that it can. The dot answers one question — can
   * something outside this window change what I am looking at, right now — and
   * the three things it gets right are all about not lying:
   *
   * - **It reads main's status, never the checkbox.** Those come apart when a
   *   port is already taken, and a dot derived from the setting would be green
   *   over a server that never started. `mcp_status.ts` holds that rule.
   * - **It is a button.** It opens Settings on the MCP pane. A status light with
   *   no way to act on what it reports is the same half-feature as a floating
   *   panel with no way back.
   * - **Never colour alone.** The word is beside the dot, the title says the
   *   state in words, and a client actually using the server is distinguished
   *   by *motion* as well as by hue.
   */
  import type { McpStatus } from "../../../shared/ipc.js";
  import { dotColor, dotFor } from "./mcp_status.js";
  import { t } from "./i18n.svelte.js";

  interface Props {
    status: McpStatus | null;
    onopen: () => void;
  }

  const { status, onopen }: Props = $props();

  const dot = $derived(dotFor(status));

  const label = $derived.by(() => {
    switch (dot) {
      case "active":
        return t("mcp.stateActive");
      case "listening":
        return t("mcp.stateListening");
      case "error":
        return status?.message ?? t("mcp.stateError");
      default:
        return t("mcp.stateStarting");
    }
  });

  /*
   * A short pulse when the call count moves.
   *
   * Driven from the counter rather than from an event, because main sends a
   * status on every change and a separate "a call happened" message would be a
   * second way to say the same thing. The timer is cleared and restarted so a
   * burst of calls reads as one continuous pulse rather than a stutter.
   */
  let busy = $state(false);
  let seen = $state(-1);
  let timer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const calls = status?.calls ?? 0;
    if (seen === -1) {
      seen = calls;
      return;
    }
    if (calls === seen) return;
    seen = calls;
    busy = true;
    clearTimeout(timer);
    timer = setTimeout(() => (busy = false), 900);
    return () => clearTimeout(timer);
  });
</script>

<button
  class="mcp"
  class:busy
  onclick={onopen}
  title={`${t("mcp.title")} — ${label}`}
  aria-label={`${t("mcp.title")}: ${label}`}
>
  <span class="dot" style={`background: var(${dotColor(dot)})`}></span>
  <span class="name">{t("mcp.short")}</span>
</button>

<style>
  .mcp {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    font-size: 12px;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }

  /*
   * The pulse is the second channel, so the "somebody is using it" state does
   * not rest on hue alone. `prefers-reduced-motion` turns it off -- the colour
   * and the title still carry the state, so nothing is lost.
   */
  .mcp.busy .dot {
    animation: pulse 0.7s ease-in-out infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .mcp.busy .dot {
      animation: none;
    }
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.45;
      transform: scale(1.35);
    }
  }

  .name {
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }
</style>
