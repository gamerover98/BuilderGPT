/**
 * Locates and loads the two data files `component.py` read from its own module
 * directory: `prompts.json` (component.py:44-52) and `block_id_list.txt`
 * (component.py:53-54, and `core.loadAllowedBlocks`'s `baseDir`).
 *
 * In a packaged Electron app there is no "module directory" -- app code lives
 * inside `app.asar`. These two are shipped as `extraResources` so they sit
 * beside the executable and stay editable by the user, which also means
 * `process.resourcesPath` is the packaged lookup and the repo root is the dev
 * lookup.
 */

import { readdir, readFile } from "fs/promises";
import path from "path";

import { app } from "electron";

export interface Prompts {
  SYS_GEN: string;
  USR_GEN: string;
  SYS_GEN_NAME: string;
  USR_GEN_NAME: string;
}

let cachedPrompts: Prompts | null = null;

export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

/**
 * component.py:47-52 joined list-valued prompt entries into one string, so the
 * JSON file can keep long prompts as arrays of lines. Preserved exactly --
 * `prompts.json` uses that form today.
 */
function flatten(raw: Record<string, unknown>): Prompts {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = Array.isArray(value) ? value.join("") : String(value);
  }
  for (const required of ["SYS_GEN", "USR_GEN", "SYS_GEN_NAME", "USR_GEN_NAME"]) {
    if (!(required in out)) {
      throw new Error(`prompts.json is missing "${required}"`);
    }
  }
  return out as unknown as Prompts;
}

export async function loadPrompts(): Promise<Prompts> {
  if (cachedPrompts) {
    return cachedPrompts;
  }
  const raw = await readFile(path.join(resourcesDir(), "prompts.json"), "utf-8");
  cachedPrompts = flatten(JSON.parse(raw) as Record<string, unknown>);
  return cachedPrompts;
}

/** The raw text spliced into `%BLOCK_TYPES_LIST%` (component.py:117). */
export async function loadBlockIdListText(): Promise<string> {
  return await readFile(path.join(resourcesDir(), "block_id_list.txt"), "utf-8");
}

/**
 * The resource pack used for previews when the user has not chosen one.
 *
 * Replaces `model_baker.ts`'s old `discoverFallback`, which scanned `public/`
 * relative to a repo root derived from `import.meta.url`. That worked under
 * `tsx` (where the file really is `src/main/pipeline/model_baker.ts`) but not in
 * a build: electron-vite bundles the main process into a single
 * `out/main/index.js`, so walking three levels up landed outside the project and
 * the default pack silently disappeared. `resourcesDir()` knows the difference
 * between dev and packaged, which is exactly what that code was missing.
 *
 * Directory scan rather than a hardcoded filename, so swapping or updating the
 * bundled pack is a file drop with no code change — the one property of the old
 * `discoverFallback` worth keeping.
 */
export async function defaultResourcePackPath(): Promise<string | null> {
  const dir = path.join(resourcesDir(), "resources");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // No bundled pack is a supported state: previews fall back to flat colours.
    return null;
  }
  const zips = entries.filter((name) => name.toLowerCase().endsWith(".zip")).sort();
  return zips.length > 0 ? path.join(dir, zips[0]) : null;
}

/** `generated/` (component.py:137-138), relocated to a writable location. */
export function generatedDir(): string {
  return path.join(app.getPath("userData"), "generated");
}

/** `temp_uploads/` (component.py:296, 352), relocated likewise. */
export function tempDir(): string {
  return path.join(app.getPath("temp"), "buildergpt");
}
