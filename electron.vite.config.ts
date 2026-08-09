import { resolve } from "path";

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

/**
 * `src/renderer/index.html` ships a deliberately strict CSP -- notably
 * `connect-src 'none'`, which is the enforcement of ARCHITECTURE.md §3's rule
 * that the renderer makes zero network calls. Vite's dev server needs one
 * exception to that: its HMR websocket.
 *
 * Rather than weakening the shipped policy, this plugin patches the directive
 * only while `electron-vite dev` is serving. The built output in `out/renderer`
 * keeps `connect-src 'none'` verbatim -- verifiable by grepping the built
 * index.html.
 */
function relaxCspForDevServer(): Plugin {
  return {
    name: "bgpt:relax-csp-for-dev-server",
    apply: "serve",
    transformIndexHtml(html: string) {
      // Anchored to the meta element's content attribute on purpose: the same
      // literal `connect-src 'none'` also appears in the explanatory comment
      // above it, and a bare string replace patches the comment instead.
      return html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*?)connect-src 'none'/,
        "$1connect-src 'self' ws: wss:",
      );
    },
  };
}

export default defineConfig({
  main: {
    // `isolated-vm`, `pngjs`, `adm-zip` and `prismarine-nbt` must stay external:
    // the first has a native `.node` binding that cannot be bundled, and
    // bundling the rest buys nothing in a process that already loads from disk.
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      lib: { entry: resolve(__dirname, "src/main/index.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      lib: { entry: resolve(__dirname, "src/preload/index.ts") },
      rollupOptions: {
        // `sandbox: true` renderers load the preload script as CommonJS, so it
        // must be emitted as .cjs even though the package is type: module.
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [svelte(), relaxCspForDevServer()],
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
