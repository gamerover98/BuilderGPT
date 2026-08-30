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

import { app, BrowserWindow, dialog, shell } from "electron";

import { registerIpcHandlers } from "./ipc/handlers.js";
import { installMenu } from "./menu.js";
import { isDirty } from "./domain/history.js";
import { currentSession } from "./services/session.js";
import { discardPrompt } from "./services/discard_prompt.js";
import { appIconPath } from "./services/resources.js";
import { stopMcpServer } from "./mcp/server.js";

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
    /*
     * Without this the dev run shows Electron's own logo, which it always has.
     * See `appIconPath()`: macOS ignores this and a packaged Windows build
     * takes its icon from the executable, so this row is for development on
     * every platform and for Linux in a packaged build too.
     */
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  /*
   * The window's own close button asks about unsaved work.
   *
   * Entirely in main, with no channel, because main already knows both halves:
   * whether a document is open and whether it differs from disk. There is also
   * nowhere else it could live — by the time the renderer could be asked, the
   * decision to close has already been taken.
   *
   * `close` is not async, so the only way to ask is to refuse the first one and
   * close again once answered. `closing` is what stops that second `close()`
   * from asking the same question forever.
   */
  let closing = false;
  mainWindow.on("close", (event) => {
    if (closing) return;
    const session = currentSession();
    if (session === null || !isDirty(session.history)) return;

    event.preventDefault();
    const target = mainWindow;
    if (!target) return;

    const prompt = discardPrompt(
      "close",
      session.doc.filePath === null ? null : path.basename(session.doc.filePath),
    );
    void dialog
      .showMessageBox(target, {
        type: "warning",
        buttons: [prompt.confirmLabel, prompt.cancelLabel],
        // Escape and the box's own close button both land on "keep my work".
        defaultId: 1,
        cancelId: 1,
        message: prompt.message,
        detail: prompt.detail,
      })
      .then((answer) => {
        if (answer.response !== 0) return;
        closing = true;
        target.close();
      });
  });

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
   * document change -- see `refreshShell`.
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

/*
 * The MCP listener goes down with the app, and the discovery file with it.
 *
 * `will-quit` rather than `window-all-closed`, because on macOS the process
 * outlives its window and the server should keep serving until the app really
 * is going away. Leaving the file behind would point the stdio bridge at a port
 * nobody is listening on, which is a confusing failure a long way from here.
 */
app.on("will-quit", () => {
  void stopMcpServer();
});
