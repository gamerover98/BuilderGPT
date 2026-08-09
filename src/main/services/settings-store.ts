/**
 * Settings + API-key persistence.
 *
 * Replaces `.env` (user requirement, Step 00 answer 3) and `component.py`'s
 * `st.text_input(type="password")`, which held keys in Streamlit session state
 * and lost them on every reload.
 *
 * ARCHITECTURE.md §3 "Secrets": keys are encrypted with Electron's
 * `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on
 * Linux) and the ciphertext is stored base64 in `settings.json` under
 * `app.getPath("userData")`. When `safeStorage.isEncryptionAvailable()` is
 * false -- a real case on Linux without a keyring daemon -- we keep the key in
 * memory for the session and **refuse to write it to disk**. Plaintext keys on
 * disk are exactly what the `.env` removal was for.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

import { app, safeStorage } from "electron";

import {
  DEFAULT_SETTINGS,
  DEFAULT_UI_SETTINGS,
  PROVIDERS,
  SIDEBAR_WIDTH,
  type KeyStorageStatus,
  type Provider,
  type Settings,
  type UiSettings,
} from "../../shared/settings.js";

interface PersistedFile {
  settings: Settings;
  /** provider -> base64 ciphertext. Never plaintext. */
  encryptedKeys: Record<string, string>;
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/** Session-only keys, used when encryption is unavailable. */
const memoryKeys = new Map<Provider, string>();

let cache: PersistedFile | null = null;

function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Merges a persisted blob over the defaults field by field. A settings file
 * written by an older build must not be able to produce `undefined` where the
 * renderer expects a value, so nothing is spread blindly.
 */
function coerceSettings(raw: unknown): Settings {
  const source = (raw ?? {}) as Partial<Settings>;
  const preview = { ...DEFAULT_SETTINGS.preview, ...(source.preview ?? {}) };
  const ui = coerceUi(source.ui);
  return {
    provider: isProvider(source.provider) ? source.provider : DEFAULT_SETTINGS.provider,
    model: typeof source.model === "string" ? source.model : DEFAULT_SETTINGS.model,
    baseUrl: typeof source.baseUrl === "string" ? source.baseUrl : DEFAULT_SETTINGS.baseUrl,
    version: typeof source.version === "string" ? source.version : DEFAULT_SETTINGS.version,
    exportType: source.exportType === "mcfunction" ? "mcfunction" : "schem",
    outputDir: typeof source.outputDir === "string" ? source.outputDir : DEFAULT_SETTINGS.outputDir,
    preview,
    ui,
  };
}

/**
 * The sidebar width is the one persisted number a user can drive to a value
 * that makes the window unusable (a settings file copied from a 4K screen onto
 * a laptop), so it is clamped on read rather than trusted.
 */
function coerceUi(raw: unknown): UiSettings {
  const source = (raw ?? {}) as Partial<UiSettings>;
  const width = Number(source.sidebarWidth);
  return {
    sidebarWidth: Number.isFinite(width)
      ? Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(width)))
      : DEFAULT_UI_SETTINGS.sidebarWidth,
    sidebarCollapsed: source.sidebarCollapsed === true,
  };
}

async function load(): Promise<PersistedFile> {
  if (cache) {
    return cache;
  }
  try {
    const text = await readFile(settingsPath(), "utf-8");
    const parsed = JSON.parse(text) as Partial<PersistedFile>;
    cache = {
      settings: coerceSettings(parsed.settings),
      encryptedKeys:
        parsed.encryptedKeys && typeof parsed.encryptedKeys === "object" ? parsed.encryptedKeys : {},
    };
  } catch (err: unknown) {
    // RULEBOOK.md §1 "Standard library I/O": catch-ENOENT, rethrow-else. A
    // corrupt JSON file is also recoverable-by-reset here (SyntaxError), since
    // the alternative is an app that cannot start.
    const code = (err as { code?: string } | null)?.code;
    if (code !== "ENOENT" && !(err instanceof SyntaxError)) {
      throw err;
    }
    cache = { settings: { ...DEFAULT_SETTINGS }, encryptedKeys: {} };
  }
  return cache;
}

async function persist(): Promise<void> {
  const data = await load();
  await mkdir(path.dirname(settingsPath()), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(data, null, 2), "utf-8");
}

export async function getSettings(): Promise<Settings> {
  return (await load()).settings;
}

export async function setSettings(next: Settings): Promise<Settings> {
  const data = await load();
  data.settings = coerceSettings(next);
  await persist();
  return data.settings;
}

export async function getApiKey(provider: Provider): Promise<string> {
  const memory = memoryKeys.get(provider);
  if (memory !== undefined) {
    return memory;
  }
  const data = await load();
  const encoded = data.encryptedKeys[provider];
  if (!encoded) {
    return "";
  }
  if (!safeStorage.isEncryptionAvailable()) {
    // Ciphertext on disk we can no longer decrypt (keyring went away). Not an
    // error worth crashing on -- report "no key" and let the UI ask again.
    return "";
  }
  try {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch {
    return "";
  }
}

export async function setApiKey(provider: Provider, apiKey: string): Promise<void> {
  const data = await load();
  const trimmed = apiKey.trim();
  if (trimmed === "") {
    delete data.encryptedKeys[provider];
    memoryKeys.delete(provider);
    await persist();
    return;
  }
  if (safeStorage.isEncryptionAvailable()) {
    data.encryptedKeys[provider] = safeStorage.encryptString(trimmed).toString("base64");
    memoryKeys.delete(provider);
    await persist();
    return;
  }
  // No OS-backed encryption: session-only, never written. The renderer learns
  // this from `KeyStorageStatus.encryptionAvailable` and warns.
  memoryKeys.set(provider, trimmed);
}

export async function clearApiKey(provider: Provider): Promise<void> {
  await setApiKey(provider, "");
}

export async function getKeyStatus(): Promise<KeyStorageStatus> {
  const data = await load();
  const encryptionAvailable = safeStorage.isEncryptionAvailable();
  return {
    encryptionAvailable,
    keys: PROVIDERS.map((provider) => ({
      provider,
      hasKey: memoryKeys.has(provider) || Boolean(data.encryptedKeys[provider]),
    })),
  };
}

/** Test seam: drops the in-process cache so the next read hits disk. */
export function resetCacheForTests(): void {
  cache = null;
  memoryKeys.clear();
}
