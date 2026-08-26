/**
 * "The open document moved" — and the two different things that can mean.
 *
 * Every path to a `DocumentState` used to be an *answer*: the renderer asked,
 * a handler edited, and the new state came back as the return value of the
 * invoke. That is why main has never had a way to push one, and it was the
 * right shape for as long as the window was the only thing that could edit.
 *
 * The MCP server breaks that assumption — it edits the same session the window
 * is showing, and nobody in the window asked. Without a push the viewport keeps
 * drawing a build that is no longer there and the title bar keeps the wrong
 * dirty marker until the user happens to do something that asks.
 *
 * ## Two functions, because there are two questions
 *
 * `shellState` is for an edit the renderer *asked for*. It brings the menu and
 * the title back in step and hands the state back to be returned. It must not
 * push: the caller is already receiving this exact value, and a selection-face
 * drag sends an edit many times a second — pushing there would have the window
 * re-request the whole mesh on every frame of a drag it is already driving.
 *
 * `announceDocument` is for an edit *nobody in the window asked for*. Same
 * chrome refresh, plus the push.
 *
 * Keeping them apart is the whole design. Folding them into one function with
 * a `push` flag would put the decision at twenty-one call sites, which is the
 * arrangement this codebase already knows is wrong at whichever one is added
 * next.
 */

import type { BrowserWindow } from "electron";

import { IPC, type DocumentState } from "../../shared/ipc.js";
import { refreshShell } from "../menu.js";
import { documentState, type DocumentSession } from "./session.js";

let window: (() => BrowserWindow | null) | null = null;

/**
 * Where the pushes go. Installed once, from `registerIpcHandlers`.
 *
 * A getter rather than the window itself, exactly as `menu.ts` takes one: the
 * window is created after the handlers are registered, and on macOS it can be
 * closed and made again while the process lives.
 */
export function useWindow(getWindow: () => BrowserWindow | null): void {
  window = getWindow;
}

/** The live window, or `null` if there is none to talk to. */
function target(): BrowserWindow | null {
  const found = window?.() ?? null;
  return found !== null && !found.isDestroyed() ? found : null;
}

/**
 * The state to answer with, and the window chrome brought back in step.
 *
 * Every handler that answers with a `DocumentState` has, by construction, just
 * changed one — so this is the single place the title bar and the File menu are
 * refreshed, rather than twenty-one separate reminders to remember to.
 *
 * Not awaited: nothing downstream depends on the chrome having repainted, and
 * making every edit wait on a native menu rebuild would be the wrong trade.
 */
export function shellState(session: DocumentSession): DocumentState {
  void refreshShell();
  return documentState(session);
}

/**
 * Tells the window the document changed under it.
 *
 * `null` is a real answer and means the document was closed — the renderer has
 * to clear the viewport, and a channel that could only ever carry a live state
 * would leave closing from outside the window as the one case with no way to
 * say it.
 *
 * Returns the state it sent, so a caller that also needs it does not have to
 * build it twice.
 */
export function announceDocument(session: DocumentSession | null): DocumentState | null {
  const state = session === null ? null : shellState(session);
  if (session === null) void refreshShell();
  target()?.webContents.send(IPC.docChanged, state);
  return state;
}
