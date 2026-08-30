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

import { parseBlockList } from "../core.js";

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

/**
 * The text spliced into `%BLOCK_TYPES_LIST%` (component.py:117).
 *
 * Comments are stripped rather than passed through: the list is generated and
 * carries a header saying so, and the model has no use for the regeneration
 * command. `parseBlockList` is shared with `core.ts`'s `loadAllowedBlocks` so
 * the set the model is told about cannot drift from the set it is judged
 * against -- they are now the same file read the same way.
 */
export async function loadBlockIdListText(): Promise<string> {
  const raw = await readFile(path.join(resourcesDir(), "block_id_list.txt"), "utf-8");
  return [...parseBlockList(raw)].join("\n");
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

/**
 * The vendored pre-1.13 block flattening table, used to read legacy MCEdit
 * `.schematic` files (`pipeline/loader_formats.ts`). Ships alongside the
 * resource pack rather than inside the asar so the same `resourcesDir()`
 * lookup covers dev and packaged builds.
 */
export function legacyBlocksPath(): string {
  return path.join(resourcesDir(), "resources", "legacy_blocks.json");
}

/**
 * Recorded models.dev metadata for OpenCode Zen. Only consulted when the live
 * models.dev fetch fails, so the model list still says which models are free
 * and which accept images on an offline first run.
 */
export function openCodeSnapshotPath(): string {
  return path.join(resourcesDir(), "resources", "opencode_models.json");
}

/*
 * Everything below hangs off `app.getPath("userData")`, which Electron names
 * after `app.getName()` -- that is, after `package.json`'s `name`.
 *
 * That name changed at 1.0.0, from `buildergpt` to `schematic-ai-studio`, so an
 * install predating the rename has its settings, encrypted API keys,
 * conversations, checkpoints and version history under the old directory and
 * this app does not read them. Nothing migrates: the files are still there and
 * are recoverable by hand, and writing a migration for an app with no audience
 * yet would be more code to be wrong than the case is worth.
 */

/**
 * Where crash-recovery snapshots live.
 *
 * Under userData, deliberately far from anything the user browses: an autosave
 * that appeared beside their own files would look like clutter they should
 * delete, and it is not their copy to manage.
 */
export function autosaveDir(): string {
  return path.join(app.getPath("userData"), "autosave");
}

/**
 * Where a schematic's chat history is kept.
 *
 * Beside the autosaves and for the same reason: it belongs to the app, not to
 * the user's project folder. Worth knowing, and not hidden: these files are
 * plain JSON. API keys are encrypted through `safeStorage`; conversations are
 * not, so anything typed into the chat is readable by anything that can read
 * the user's own profile.
 */
export function conversationsDir(): string {
  return path.join(app.getPath("userData"), "conversations");
}

/**
 * Where the per-turn snapshots live.
 *
 * A directory of its own rather than mixed in with the conversation records:
 * these are schematics, they are much the larger of the two, and being able to
 * delete the lot without touching the transcripts is worth the extra folder.
 */
export function checkpointsDir(): string {
  return path.join(app.getPath("userData"), "checkpoints");
}

/**
 * Where a schematic's own version history lives, one folder per file.
 *
 * Apart from `checkpoints/` on purpose, though both hold schematics: a
 * checkpoint belongs to a conversation and dies with it, while these belong to
 * the file and outlive everything. Mixing them would mean a conversation being
 * deleted could take a version of the file with it.
 */
export function snapshotsDir(): string {
  return path.join(app.getPath("userData"), "versions");
}

/** `generated/` (component.py:137-138), relocated to a writable location. */
export function generatedDir(): string {
  return path.join(app.getPath("userData"), "generated");
}

/**
 * The stdio bridge, for MCP clients that will not speak HTTP.
 *
 * Beside the resource pack because it ships the same way -- `resources/` goes
 * out whole as an extraResource -- and `resourcesDir()` is the one function
 * that knows whether this is a dev run or an installed copy.
 */
export function mcpBridgeFile(): string {
  // Two levels, exactly like `legacyBlocksPath`: `extraResources` copies the
  // repo's `resources/` folder to `<resourcesPath>/resources/`, so the inner
  // segment is part of the path in a packaged build as well as in a dev run.
  return path.join(resourcesDir(), "resources", "mcp-bridge.mjs");
}

/**
 * The application icon, as a file the running process can read.
 *
 * The one helper here that cannot use `resourcesDir()`, and the reason is worth
 * stating: the master lives in `build/`, which is electron-builder's
 * *buildResources* directory -- a build input, not something that ships. What
 * ships from it is the .ico embedded in the .exe and the .icns inside the .app,
 * and neither of those is a file this process could open. So `electron-builder.yml`
 * copies `build/icon.png` to a flat `icon.png` beside the executable, and the
 * two lookups genuinely differ rather than differing by an oversight.
 *
 * macOS ignores `BrowserWindow.icon` entirely and Windows takes a packaged
 * window's icon from the executable, so what this is actually for is **every
 * platform in development** -- where the alternative is Electron's own logo --
 * and **Linux everywhere**, where the running process has to supply its own.
 */
export function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(app.getAppPath(), "build", "icon.png");
}

/**
 * Where the MCP server writes its URL and token, for the stdio bridge to read.
 *
 * A file rather than a fixed port, because the port can be `0` — and because a
 * bridge that had to be reconfigured every time the port moved would be a
 * bridge nobody keeps working.
 */
export function mcpDiscoveryFile(): string {
  return path.join(app.getPath("userData"), "mcp.json");
}

/** `temp_uploads/` (component.py:296, 352), relocated likewise. */
export function tempDir(): string {
  return path.join(app.getPath("temp"), "schematic-ai-studio");
}
