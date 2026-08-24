/**
 * What the application menu contains, as data.
 *
 * Electron-free on purpose, the same split `recent_documents.ts` and
 * `settings_coerce.ts` were made for: `menu.ts` imports Electron and the suites
 * cannot load it at all, so everything worth being wrong about — which items
 * are enabled, what the recents submenu says, what the window is called — lives
 * here where a test can ask.
 *
 * The window title is here too, though it is not a menu. It is rebuilt from the
 * same facts on the same event, and two modules reading "is there a document
 * and is it dirty" is two chances to disagree about it.
 */

import type { RecentDocument } from "../shared/ipc.js";

/**
 * The verbs the menu can ask the renderer for.
 *
 * One channel each in `shared/ipc.ts` rather than a single `menuCommand`
 * carrying a string: that would be the generic dispatcher rule R-2 exists to
 * refuse, and it would blind the channel walk in `tests/services.ts`, which
 * only catches a forgotten wiring because each verb has a name of its own.
 */
export type MenuCommand =
  | "new"
  | "open"
  | "openRecent"
  | "save"
  | "saveAs"
  | "close"
  | "undo"
  | "redo";

export interface MenuItemModel {
  /** Absent for a separator or a plain container. */
  command?: MenuCommand;
  /** `openRecent` only: which file this item opens. */
  filePath?: string;
  label?: string;
  accelerator?: string;
  enabled?: boolean;
  separator?: boolean;
  /** Handed to Electron as-is; the only one used here is `quit`. */
  role?: "quit";
  submenu?: MenuItemModel[];
}

export interface MenuState {
  hasDocument: boolean;
  recents: readonly RecentDocument[];
}

export interface TitleState {
  fileName: string | null;
  hasDocument: boolean;
  dirty: boolean;
}

export const APP_NAME = "Schematic AI Studio";

/** What a document with no file of its own is called, here and in the box. */
export const UNTITLED = "Untitled";

/**
 * How many recents the submenu shows.
 *
 * The stored list is capped at `MAX_RECENT_DOCUMENTS` (10) already; this is a
 * second, smaller cap because a menu that has to scroll is a menu nobody
 * scrolls.
 */
export const MAX_RECENT_MENU_ITEMS = 10;

/**
 * `&` in a menu label is a mnemonic marker on Windows.
 *
 * So a schematic actually called `A&B.schem` renders as `AB` with the B
 * underlined, and pressing B while the menu is open opens it. Doubling is the
 * documented escape. Nothing else in the app puts user text in a native
 * control, which is why this lives here and not in a shared helper.
 */
export function escapeMenuLabel(text: string): string {
  return text.replace(/&/g, "&&");
}

/** The last path segment, on either platform's separator. */
export function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).filter((part) => part !== "").pop() ?? filePath;
}

function folderNameOf(filePath: string): string | null {
  const parts = filePath.split(/[\\/]/).filter((part) => part !== "");
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

/**
 * Labels for the recents submenu, disambiguated only where they need to be.
 *
 * Two schematics called `house.schem` in two folders is the ordinary case, not
 * a corner one — a build and its backup, or last week's and this week's — and
 * a menu offering the same word twice is a coin flip. Only the names that
 * actually repeat get their folder, because appending it to every row turns a
 * readable list into a column of paths.
 */
export function recentLabels(recents: readonly RecentDocument[]): string[] {
  const names = recents.map((entry) => fileNameOf(entry.filePath));
  const seen = new Map<string, number>();
  for (const name of names) seen.set(name, (seen.get(name) ?? 0) + 1);
  return recents.map((entry, index) => {
    const name = names[index];
    if ((seen.get(name) ?? 0) < 2) return name;
    const folder = folderNameOf(entry.filePath);
    return folder === null ? entry.filePath : `${name} — ${folder}`;
  });
}

/**
 * The menu bar.
 *
 * Enablement comes from main's own knowledge — `currentSession() !== null` and
 * the recents list it owns — so nothing has to be reported back from the
 * renderer for the menu to be right. `busy` is deliberately not modelled: it is
 * a renderer convention, and every action behind these items already refuses
 * while something is running.
 */
export function menuModel(state: MenuState): MenuItemModel[] {
  const recents = state.recents.slice(0, MAX_RECENT_MENU_ITEMS);
  const labels = recentLabels(recents);

  const menus: MenuItemModel[] = [
    {
      label: "File",
      submenu: [
        { command: "new", label: "New…", accelerator: "CmdOrCtrl+N", enabled: true },
        { command: "open", label: "Open…", accelerator: "CmdOrCtrl+O", enabled: true },
        {
          label: "Open Recent",
          // An empty submenu renders as an empty box on some platforms, so the
          // container itself goes dark instead. "Nothing here yet" as a
          // disabled row would be a second way of saying the same thing.
          enabled: recents.length > 0,
          submenu: recents.map((entry, index) => ({
            command: "openRecent" as const,
            filePath: entry.filePath,
            label: escapeMenuLabel(labels[index]),
            enabled: true,
          })),
        },
        { separator: true },
        {
          command: "save",
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          enabled: state.hasDocument,
        },
        {
          command: "saveAs",
          label: "Save As…",
          accelerator: "CmdOrCtrl+Shift+S",
          enabled: state.hasDocument,
        },
        { separator: true },
        {
          command: "close",
          label: "Close Schematic",
          accelerator: "CmdOrCtrl+W",
          enabled: state.hasDocument,
        },
        { separator: true },
        { role: "quit", label: "Exit" },
      ],
    },
  ];

  /*
   * No Edit menu at all with nothing open, rather than one holding two dead
   * rows.
   *
   * Both were already `enabled: false`, which is the honest answer to "can I
   * undo" and the wrong shape of answer: with no document there is nothing the
   * menu could ever offer, so it was a heading that existed only to be greyed
   * out. The File menu keeps its dead rows because it has live ones beside
   * them; this one has nothing to be beside.
   *
   * `menuSignature` already carries `hasDocument`, so the bar is rebuilt when
   * one is opened or closed and nothing else needs to know.
   */
  if (state.hasDocument) {
    menus.push({
      label: "Edit",
      submenu: [
        /*
         * No accelerators, and that is the point.
         *
         * An accelerator declared here is claimed by Electron before the
         * window sees the keystroke, and a menu item cannot ask where the
         * caret is. Ctrl+Z would therefore stop undoing what you are typing in
         * the chat and start undoing block edits — irreversibly, and from a
         * field where nothing on screen suggests it. The renderer keeps those
         * two keys, behind `isTyping`; these rows exist to be *found*, and the
         * buttons in the document bar do the work.
         */
        { command: "undo", label: "Undo", enabled: true },
        { command: "redo", label: "Redo", enabled: true },
      ],
    });
  }

  return menus;
}

/**
 * What the title bar says.
 *
 * Name first, app second: a taskbar button and an Alt-Tab card both truncate
 * from the right, and the half worth keeping is which schematic this is. The
 * dirty marker leads for the same reason — it survives the truncation.
 */
export function windowTitle(state: TitleState): string {
  if (!state.hasDocument) return APP_NAME;
  const name = state.fileName ?? UNTITLED;
  return `${state.dirty ? "• " : ""}${name} — ${APP_NAME}`;
}
