/// <reference types="svelte" />
/// <reference types="vite/client" />

import type { BgptApi } from "../../shared/ipc.js";

declare global {
  interface Window {
    /** Injected by `src/preload/index.ts` via `contextBridge`. */
    bgpt: BgptApi;
  }
}

export {};
