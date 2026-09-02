/**
 * The renderer's entry, and the one place that can hear it die.
 *
 * The listeners go in **before the mount**, so a failure during mount is
 * reported too -- which is the case where nothing else in the app exists yet
 * to notice anything.
 */
import { mount } from "svelte";

import App from "./App.svelte";
import "./app.css";

const target = document.getElementById("app");
if (!target) {
  throw new Error("#app mount point missing from index.html");
}

/**
 * Tells main the window threw something nobody caught.
 *
 * The failure this exists for is silent and total: a reactive loop that Svelte
 * or the browser aborts takes every effect in the window with it, while the
 * viewport goes on drawing from its own `requestAnimationFrame` chain and main
 * goes on answering. Navigable and completely dead, with a clean console --
 * reported that way twice before anything was listening.
 *
 * Every line of this is wrapped, and it reports **once**. An error handler that
 * throws is a second error; an error handler that reports a loop is a loop of
 * reports, and a dialog per iteration is worse than the freeze it describes.
 * Main counts what follows; this side simply stops.
 */
let reported = false;

function report(kind: "error" | "rejection", error: unknown, at: string): void {
  if (reported) return;
  reported = true;
  try {
    const api = (window as { bgpt?: { reportFailure?: (report: unknown) => void } }).bgpt;
    if (typeof api?.reportFailure !== "function") return;
    api.reportFailure({
      kind,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? "") : "",
      at,
    });
  } catch {
    // Nothing left to do, and nowhere left to say it.
  }
}

window.addEventListener("error", (event) => {
  report("error", event.error ?? event.message, `${event.filename}:${event.lineno}:${event.colno}`);
});

/*
 * The asynchronous half. A rejected promise nobody handles never reaches the
 * listener above, and an `await` in a handler is exactly where this app's own
 * IPC failures would land.
 */
window.addEventListener("unhandledrejection", (event) => {
  report("rejection", event.reason, "");
});

export default mount(App, { target });
