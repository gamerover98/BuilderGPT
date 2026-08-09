/**
 * Single accessor for the preload bridge.
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
  "This page is not running inside the BuilderGPT desktop app, so the backend is " +
  "unavailable. Start it with `npm run dev` (or the packaged app) rather than " +
  "opening the dev-server URL in a browser.";

export function api(): BgptApi {
  if (!window.bgpt) {
    throw new Error(BRIDGE_MISSING_MESSAGE);
  }
  return window.bgpt;
}
