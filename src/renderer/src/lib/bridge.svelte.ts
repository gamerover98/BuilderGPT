/**
 * Single accessor for the preload bridge.
 *
 * The `.svelte.ts` extension is load-bearing: `forIpc` below uses the
 * `$state.snapshot` rune, and runes are only compiled inside `.svelte` and
 * `.svelte.js/ts` modules. In a plain `.ts` the call survives typechecking and
 * then throws `rune_outside_svelte` at runtime.
 *
 * `window.bgpt` is injected by `src/preload/index.ts`. It is absent in exactly
 * two situations: the page was opened in a plain browser (e.g. hitting the Vite
 * dev server's URL directly rather than through Electron), or the preload
 * script failed to load. Calling straight through `window.bgpt.x()` in those
 * cases produces a pile of `Cannot read properties of undefined` traces that
 * say nothing about the actual cause -- so every call site goes through here.
 */

import type { BgptApi } from "../../../shared/ipc.js";

export const bridgeAvailable = typeof window !== "undefined" && Boolean(window.bgpt);

export const BRIDGE_MISSING_MESSAGE =
  "This page is not running inside the Schematic AI Studio desktop app, so the backend is " +
  "unavailable. Start it with `npm run dev` (or the packaged app) rather than " +
  "opening the dev-server URL in a browser.";

export function api(): BgptApi {
  if (!window.bgpt) {
    throw new Error(BRIDGE_MISSING_MESSAGE);
  }
  return window.bgpt;
}

/**
 * Strips Svelte reactivity before a value crosses IPC.
 *
 * `$state` on an object is a deep `Proxy`, and the structured clone algorithm
 * cannot serialize a Proxy: `ipcRenderer.invoke` rejects with the famously
 * uninformative **"An object could not be cloned."**, naming neither the value
 * nor the channel. Spreading is not enough -- `{ ...settings }` is a plain
 * object whose `preview` and `ui` fields are still proxies.
 *
 * So any *object* built from `$state` must go through here on its way out.
 * Primitives read off a proxy are already plain and need nothing.
 */
export function forIpc<T>(value: T): T {
  return $state.snapshot(value) as T;
}
