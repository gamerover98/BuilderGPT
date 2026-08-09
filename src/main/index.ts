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

const dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    // `layout="wide"` + the dark viewer background from app/viewer/index.html.
    backgroundColor: "#0b0f14",
    title: "BuilderGPT - AI Minecraft Structure Generator", // run_app.py:6
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
