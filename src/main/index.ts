/**
 * Electron entry point. Replaces `run_app.py` (`st.set_page_config` + a render
 * call), which is all Streamlit needed to own a process.
 *
 * ARCHITECTURE.md §2 rule R-1: the renderer runs with `nodeIntegration: false`,
 * `contextIsolation: true`, `sandbox: true`. This app executes LLM-authored
 * JavaScript; the isolate that runs it lives in the main process behind
 * `core.ts`, and the renderer has no reason to hold a single Node primitive.
 */

import path from "path";
import { fileURLToPath } from "url";

import { app, BrowserWindow, shell } from "electron";

import { registerIpcHandlers } from "./ipc/handlers.js";
import { installMenu } from "./menu.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    /*
     * What the frame paints before the renderer's first frame arrives, and the
     * one colour in the app that themes cannot reach: it is chosen here, in the
     * main process, before there is a window to ask about `prefers-color-scheme`
     * and before `settings.json` has been read. It stays the dark value from
     * app/viewer/index.html because a wrong guess shows for a few milliseconds,
     * whereas plumbing the theme this far forward would mean blocking the
     * window on a disk read.
     */
    backgroundColor: "#0b0f14",
    title: "Schematic AI Studio", // run_app.py:6 set a title too
    webPreferences: {
      preload: path.join(dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Nothing in this app should ever open a second window or navigate away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  registerIpcHandlers(() => mainWindow);
  createWindow();
  /*
   * After the window, because the menu titles it as well as builds itself, and
   * before anything can be opened. It rebuilds from main's own state on every
   * document change -- see `refreshMenu`.
   */
  installMenu(() => mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
