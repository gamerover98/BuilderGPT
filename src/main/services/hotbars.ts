/**
 * One hotbar per schematic, kept beside its conversation and its versions.
 *
 * It used to be one bar for the whole app, in `UiSettings`, written with
 * `patchUi`. That is the right home for a window's chrome and the wrong one for
 * what you are *holding*: a schematic is a thing you build with a particular
 * set of blocks, and opening the next one handed you the last one's. A legacy
 * `.schematic` is where that stops being a nuisance and becomes wrong — it
 * inherited nine blocks that version does not have, from a document that had
 * nothing to do with it.
 *
 * So it is keyed on the **file path**, which is the shape `conversation.ts` and
 * `snapshots.ts` already use, down to the hash: `storeFileName` turns a path
 * into a name, and one schematic's chat, versions and hotbar then sit under
 * names that can be matched up by eye when something needs looking at on disk.
 *
 * A document with **no path** — a new one, or a `.mcfunction`, which is read
 * and can never be a document's format — has nowhere to keep one. It starts
 * from the factory nine and its bar lives exactly as long as it does. Writing a
 * file for it would mean inventing a name, and a name invented here is a file
 * nothing ever comes back for.
 *
 * Electron-free, for `recent_documents.ts`' reason: the directory is injected
 * at startup so the suites can point it at a temporary one.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

import { DEFAULT_HOTBAR, type Hotbar } from "../../shared/settings.js";
import { coerceHotbar } from "./settings_coerce.js";
import { storeFileName } from "./conversation_store.js";

let directory: string | null = null;

/** Where hotbars are kept. Called once, at startup. */
export function useHotbarDirectory(dir: string): void {
  directory = dir;
}

/** What a document nobody has held anything in yet starts with. */
export const FRESH_HOTBAR: Hotbar = { slots: DEFAULT_HOTBAR, slot: 0 };

function fileFor(filePath: string): string | null {
  return directory === null ? null : path.join(directory, storeFileName(filePath));
}

/**
 * The hotbar this schematic was last built with, or the factory one.
 *
 * Never an error and never `null`: a document with no stored bar is the
 * ordinary case, not a failure, and a caller that had to tell "no file" apart
 * from "unreadable file" would have nothing different to do about it. What it
 * returns is always usable, because `coerceHotbar` is the same validation the
 * settings file goes through and a hotbar is a convenience rather than a
 * record.
 */
export async function readHotbar(filePath: string): Promise<Hotbar> {
  const file = fileFor(filePath);
  if (file === null) return FRESH_HOTBAR;
  try {
    return coerceHotbar(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return FRESH_HOTBAR;
  }
}

/**
 * Remember it, coerced on the way in as well as on the way out.
 *
 * Both ends, because this is written from the renderer and read back by a
 * later launch: validating only on read would let a bad value sit on disk, and
 * validating only on write would trust whatever an older build left there.
 */
export async function writeHotbar(filePath: string, hotbar: Hotbar): Promise<void> {
  const file = fileFor(filePath);
  if (file === null) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(coerceHotbar(hotbar), null, 2), "utf8");
}
