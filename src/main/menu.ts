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
  about: () => send(IPC.menuAbout),
};

function toElectron(item: MenuItemModel): MenuItemConstructorOptions {
  if (item.separator === true) return { type: "separator" };

  const built: MenuItemConstructorOptions = {};
  if (item.label !== undefined) built.label = item.label;
  if (item.accelerator !== undefined) built.accelerator = item.accelerator;
  if (item.registerAccelerator !== undefined) built.registerAccelerator = item.registerAccelerator;
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
function menuSignature(
  hasDocument: boolean,
  recents: readonly { filePath: string }[],
  keysToCamera: boolean,
): string {
  // JSON rather than a joined string: any separator a path can legitimately
  // contain would make two different lists compare equal.
  return JSON.stringify([hasDocument, recents.map((entry) => entry.filePath), keysToCamera]);
}

let lastSignature: string | null = null;

/**
 * Whether the keyboard is flying the camera, as the renderer last said.
 *
 * `false` until it says otherwise, which is the right answer before the window
 * exists and after it has gone: a menu that had quietly stopped claiming its
 * keys would be a far worse failure than one that claims them a moment early.
 *
 * It lives here because the menu is its only consumer -- and the menu is the
 * only part of the app that can act on it at all, the accelerators being
 * claimed before the window sees the keystroke. Putting it in `handlers.ts`
 * beside `viewportRect`, which is the state it most resembles, would have that
 * module and this one importing each other.
 */
let keysToCamera = false;

/**
 * The renderer reporting that the pointer was locked, or released.
 *
 * Rebuilds through `refreshShell` rather than mutating the live menu items:
 * `MenuItem.registerAccelerator` can be changed in place, and doing so would
 * put a second answer to "what does the menu contain" beside `menu_model.ts`,
 * which is the module that is supposed to hold all of them. A lock is taken and
 * released a few times a minute, not a few times a second, so the rebuild this
 * costs is nothing like the one `menuSignature` exists to avoid.
 */
export function setKeysToCamera(next: boolean): void {
  if (next === keysToCamera) return;
  keysToCamera = next;
  void refreshShell();
}

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

  const signature = menuSignature(hasDocument, recents, keysToCamera);
  if (signature !== lastSignature) {
    lastSignature = signature;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(menuModel({ hasDocument, recents, keysToCamera }).map(toElectron)),
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
