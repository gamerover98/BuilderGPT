/**
 * What to say when the window stops updating.
 *
 * `discard_prompt.ts`'s shape and for its reason: the wording is the whole of
 * the feature here, and it must be reachable by the suites, so it lives in a
 * module that has never heard of Electron.
 *
 * ## The failure this describes
 *
 * A reactive loop that Svelte or the browser aborts takes every effect in the
 * window with it. The viewport goes on drawing -- its `requestAnimationFrame`
 * chain owes Svelte nothing -- and the main process goes on answering, so the
 * menu still opens and a dialog still appears. What is gone is every update:
 * buttons do nothing, the selection does nothing, and closing the schematic
 * leaves it on screen. Navigable and completely dead.
 *
 * It has been reported twice in exactly those words, both times with a clean
 * console, because nothing was listening for the error.
 *
 * ## Why offering a reload is safe to offer
 *
 * Autosave lives in **main**, on a 20-second timer, and main is the half that
 * is still working. So the snapshot is current to within that interval however
 * long the window has been dead, and the sentence can say so rather than
 * leaving the user to weigh a reload against an unknown.
 *
 * What a reload does cost is the undo history and anything typed since the last
 * save, and that is said too. A dialog that only advertises the upside is one
 * people learn to dismiss.
 */

export interface FailurePrompt {
  message: string;
  detail: string;
  buttons: readonly [string, string, string];
  /** Copies the report and opens the issue form. Does not close the matter. */
  reportIndex: 0;
  /** Which button reloads. Stated rather than inferred; `discard_prompt`'s rule. */
  confirmIndex: 1;
  /** Escape and the window's close button both land here. */
  cancelIndex: 2;
}

/** Everything a bug report wants, and everything this side can know. */
export interface FailureFacts {
  appName: string;
  appVersion: string;
  platform: string;
  electron: string;
  chrome: string;
  node: string;
  kind: "error" | "rejection";
  message: string;
  /** `file:line:column`, or `""`. */
  at: string;
  stack: string;
}

/**
 * @param summary what the renderer managed to say, or `""`.
 * @param repeats how many further failures arrived while this was being shown.
 */
export function failurePrompt(summary: string, repeats = 0): FailurePrompt {
  /*
   * The count, and only when there is one. A loop reports once from the
   * renderer's side, so a number here means something genuinely kept failing --
   * which is worth knowing before choosing, and misleading if shown as "0".
   */
  const more =
    repeats > 0
      ? `\n\n${repeats} further error${repeats === 1 ? "" : "s"} since.`
      : "";
  const said = summary.trim() === "" ? "" : `\n\n${summary.trim()}`;
  return {
    message: "The window has stopped updating.",
    detail:
      "Something failed in a way the interface could not recover from. The 3D " +
      "view still draws and the menus still open, but nothing else will " +
      "respond.\n\nReloading fixes it. Your schematic is saved automatically " +
      "every 20 seconds by the part of the app that is still working, so at " +
      "most that much editing is lost — along with the undo history.\n\n" +
      "Copying the details puts the whole report on your clipboard and opens a " +
      "pre-filled issue in your browser. It publishes nothing: the Submit is " +
      "yours." +
      said +
      more,
    buttons: ["Copy the details and report it", "Reload the window", "Leave it as it is"],
    reportIndex: 0,
    confirmIndex: 1,
    cancelIndex: 2,
  };
}

/**
 * The whole report, for the clipboard.
 *
 * The versions are here because an issue asks for them every time and nobody
 * enjoys hunting for them twice -- and because main has all of them for free,
 * without asking the renderer anything, which matters when the renderer is the
 * half that has stopped answering.
 */
export function failureReport(facts: FailureFacts): string {
  const lines = [
    `${facts.appName} ${facts.appVersion} on ${facts.platform}`,
    `Electron ${facts.electron} · Chromium ${facts.chrome} · Node ${facts.node}`,
    "",
    `${facts.kind}: ${facts.message}`,
  ];
  if (facts.at !== "") lines.push(`at ${facts.at}`);
  if (facts.stack.trim() !== "") lines.push("", facts.stack.trim());
  return lines.join("\n");
}

/**
 * How much of the report a URL may carry.
 *
 * GitHub takes the issue body as a query parameter, so it travels in a URL --
 * and a URL has a practical ceiling that a stack trace clears easily. Encoding
 * roughly triples a newline-heavy string, so this is well under where browsers
 * and servers start truncating silently, which is the failure worth avoiding: a
 * body cut in the middle looks like a complete one.
 */
export const MAX_ISSUE_BODY = 1500;

/**
 * The issue body, abridged, with the clipboard named as the rest of it.
 *
 * `abridgeTrace`'s rule: cap on the way out and **say what was dropped**. The
 * full report is already on the clipboard by the time this URL opens, so the
 * sentence is an instruction rather than an apology.
 */
export function issueBody(report: string): string {
  const head = [
    "<!-- The full report is on your clipboard: paste it below. -->",
    "",
    "### What happened",
    "",
    "The window stopped updating.",
    "",
    "### Report",
    "",
    "```",
  ];
  const kept =
    report.length <= MAX_ISSUE_BODY
      ? report
      : `${report.slice(0, MAX_ISSUE_BODY)}\n… cut here; the full report is on your clipboard.`;
  return [...head, kept, "```", ""].join("\n");
}

/**
 * Where to send it. Built from the repository the manifest already names, so
 * there is no second place in this app that knows where its issues live.
 */
export function issueUrl(homepage: string, report: string): string {
  const base = homepage.replace(/\/+$/, "");
  const query = new URLSearchParams({
    title: "The window stopped updating",
    body: issueBody(report),
  });
  return `${base}/issues/new?${query.toString()}`;
}
