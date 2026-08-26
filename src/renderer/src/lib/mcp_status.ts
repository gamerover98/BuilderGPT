/**
 * What the dot in the navbar says, as a function of what main reported.
 *
 * A plain module for the reason `selection_drag.ts` and `floating.ts` are: the
 * component around it cannot be exercised here, and this is the part worth
 * checking. It is four states and a colour, which sounds too small to be worth
 * separating — until you notice that the interesting case is the one where the
 * checkbox and the server disagree, and that a component test could not reach
 * it at all.
 *
 * ## The checkbox is intent; this is reality
 *
 * `settings.mcp.enabled` is what the user asked for. `McpStatus` is what main
 * observed. They come apart whenever starting fails — a second copy of the app
 * holding the port is the case that actually happens — and a dot derived from
 * the checkbox would then be green over a server that is not listening. That is
 * the specific failure this split exists to prevent, so the status is the only
 * input here and the setting is not.
 */

import type { McpStatus } from "../../../shared/ipc.js";

/**
 * `active` is not one of main's states, and deliberately.
 *
 * Main reports `listening` plus a client count; whether that reads as "ready"
 * or "somebody is using it right now" is a presentation question, and this is
 * where presentation questions are answered.
 */
export type McpDot = "off" | "starting" | "listening" | "active" | "error";

export function dotFor(status: McpStatus | null): McpDot {
  /*
   * No answer yet reads as "starting", never as "off" and never as "listening".
   *
   * Off would be a lie while the toggle is on and the first status is still in
   * flight; listening would be a lie in the other direction, and the more
   * dangerous one — a green dot means "something outside can edit this build",
   * and it must never appear because a question has not come back yet.
   */
  if (status === null) return "starting";
  if (status.state === "listening") return status.clients > 0 ? "active" : "listening";
  return status.state;
}

/** The theme token the dot is painted with. All four already exist in app.css. */
export function dotColor(dot: McpDot): string {
  switch (dot) {
    case "active":
      return "--accent";
    case "listening":
      return "--ok";
    case "error":
      return "--danger";
    default:
      return "--text-dim";
  }
}

/**
 * Whether the indicator is in the navbar at all.
 *
 * Hidden while the server is off, rather than a permanently dim dot in a bar
 * that already carries five controls: it appears the moment the feature is
 * switched on, which is exactly when what it reports starts to matter.
 *
 * The second half of the condition is the one that is not obvious and is not
 * optional: **a listening server is never hidden.** If the setting and reality
 * disagree, the direction that hides a running server is the wrong one — the
 * dot's whole job is to say that something outside this window can edit the
 * build, and a stale or failed write of the setting must not be able to take
 * that warning away.
 */
export function showsIndicator(enabled: boolean, status: McpStatus | null): boolean {
  return enabled || status?.state === "listening" || status?.state === "starting";
}

/** `••••••••` for a token, with just enough of it to recognise which one it is. */
export function maskToken(token: string | null): string {
  if (token === null || token === "") return "";
  return `${"•".repeat(24)}${token.slice(-4)}`;
}
