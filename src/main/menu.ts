/**
 * The application menu, and the window title.
 *
 * There was none at all before this — `Menu.setApplicationMenu` appeared
 * nowhere in the project — which meant no File, no Ctrl+N, no Ctrl+O and no
 * Open Recent. Everything about files existed and worked, and lived entirely
 * inside a sidebar tab that is not the default one, plus a command palette you
 * have to already know about. On Windows the menu bar is the first place a
 * person looks.
 *
 * This module is the Electron half and holds no decisions: what the menu
 * contains, which items are enabled, and what the title says are all in
 * `menu_model.ts`, which imports nothing and can therefore be tested.
 *
 * ## Why the menu is main's
 *
 * Because the accelerators are. An accelerator declared in a `Menu` is claimed
 * before the window ever sees the keystroke, so a menu and a `keydown`
 * listener cannot both own Ctrl+S — one of them silently stops working. Where
 * this menu takes a key, `App.svelte` has given it up.
 */

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";

import { IPC } from "../shared/ipc.js";
import { menuModel, windowTitle, type MenuCommand, type MenuItemModel } from "./menu_model.js";
import { isDirty } from "./domain/history.js";
import { currentSession } from "./services/session.js";
import { getRecentDocuments } from "./services/settings-store.js";
import path from "path";

let window: (() => BrowserWindow | null) | null = null;

function send(channel: string, ...args: unknown[]): void {
  const target = window?.() ?? null;
  if (target && !target.isDestroyed()) {
    target.webContents.send(channel, ...args);
  }
}

/**
 * What each verb sends, written out one call at a time.
 *
 * A table mapping the verb to a channel constant would be shorter and would
 * defeat the point: `tests/services.ts` proves every channel in `IPC` is
 * actually served by looking for the *call*, not for the identifier, so
 * `{ new: IPC.menuNew }` would read as a mention and the tripwire would go
 * quiet on the very eight channels it was widened to cover.
 */
const DISPATCH: Record<MenuCommand, (item: MenuItemModel) => void> = {
  new: () => send(IPC.menuNew),
  open: () => send(IPC.menuOpen),
  openRecent: (item) => {
    // The one verb with something to say. Nothing is sent without a path:
    // an `openRecent` row built without one is a bug here, not a message.
    if (item.filePath !== undefined) send(IPC.menuOpenRecent, item.filePath);
  },
  save: () => send(IPC.menuSave),
  saveAs: () => send(IPC.menuSaveAs),
  close: () => send(IPC.menuClose),
  undo: () => send(IPC.menuUndo),
  redo: () => send(IPC.menuRedo),
};

function toElectron(item: MenuItemModel): MenuItemConstructorOptions {
  if (item.separator === true) return { type: "separator" };

  const built: MenuItemConstructorOptions = {};
  if (item.label !== undefined) built.label = item.label;
  if (item.accelerator !== undefined) built.accelerator = item.accelerator;
  if (item.enabled !== undefined) built.enabled = item.enabled;
  if (item.role !== undefined) built.role = item.role;
  if (item.submenu !== undefined) built.submenu = item.submenu.map(toElectron);

  if (item.command !== undefined) {
    const dispatch = DISPATCH[item.command];
    built.click = () => dispatch(item);
  }
  return built;
}

/**
 * What the menu's *shape* depends on. The title changes far more often.
 *
 * Every handler that answers with a `DocumentState` has, by construction, just
 * changed one -- so `refreshShell` is called from all of them, which is many
 * times per second during a drag. Rebuilding a native menu at that rate is
 * visible on Windows: the bar flickers. The title is cheap and always set; the
 * menu is rebuilt only when one of the two things it actually reads has moved.
 */
function menuSignature(hasDocument: boolean, recents: readonly { filePath: string }[]): string {
  // JSON rather than a joined string: any separator a path can legitimately
  // contain would make two different lists compare equal.
  return JSON.stringify([hasDocument, recents.map((entry) => entry.filePath)]);
}

let lastSignature: string | null = null;

/**
 * Brings the window chrome back in step with main's own state.
 *
 * Nothing is reported back from the renderer for this to be right: main knows
 * whether a session is open, whether it is dirty, and owns the recents list.
 * That is the whole reason the menu can be enabled correctly at all -- a
 * renderer-driven menu would need a channel going the other way and would be
 * wrong for one paint every time either changed.
 */
export async function refreshShell(): Promise<void> {
  const session = currentSession();
  const hasDocument = session !== null;
  const recents = await getRecentDocuments();

  const signature = menuSignature(hasDocument, recents);
  if (signature !== lastSignature) {
    lastSignature = signature;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(menuModel({ hasDocument, recents }).map(toElectron)),
    );
  }

  const target = window?.() ?? null;
  if (target && !target.isDestroyed()) {
    const filePath = session?.doc.filePath ?? null;
    target.setTitle(
      windowTitle({
        hasDocument,
        fileName: filePath === null ? null : path.basename(filePath),
        dirty: session === null ? false : isDirty(session.history),
      }),
    );
  }
}

/**
 * Installs the menu and keeps the OS's own recent-documents list in step.
 *
 * `app.addRecentDocument` is the jump list — the history Windows already knows
 * how to show, for free, outside the app entirely. It costs one call and is
 * the only part of "where are my previous schematics" that survives the app
 * not being open.
 */
export function installMenu(getWindow: () => BrowserWindow | null): void {
  window = getWindow;
  lastSignature = null;
  void refreshShell();
}

export function rememberInOsRecents(filePath: string): void {
  app.addRecentDocument(filePath);
}
