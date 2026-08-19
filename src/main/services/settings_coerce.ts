/**
 * Merging a persisted settings blob over the defaults, as pure data.
 *
 * Split from `settings-store.ts` for the same reason `recent_documents.ts` was:
 * that module imports Electron for `app.getPath` and `safeStorage`, which puts
 * everything in it out of reach of the test suites. And this is the part that
 * most needs reaching, because its failure mode is silence.
 *
 * `coerceUi` builds a fresh object literal instead of spreading, and it runs on
 * read *and* on write. A field added to `UiSettings` but not named here is
 * therefore dropped when the renderer saves -- the setting appears to work for
 * the rest of the session and is gone after a reload, with nothing logged.
 * CLAUDE.md records this as a standing trap; `tests/services.ts` now holds a
 * test that fails if a field goes missing from either object.
 */

import {
  DEFAULT_SETTINGS,
  DEFAULT_UI_SETTINGS,
  LANGUAGES,
  PROVIDERS,
  SIDEBAR_WIDTH,
  THEMES,
  type Language,
  type Provider,
  type Settings,
  type Theme,
  type UiSettings,
} from "../../shared/settings.js";

function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * The sidebar width is the one persisted number a user can drive to a value
 * that makes the window unusable (a settings file copied from a 4K screen onto
 * a laptop), so it is clamped on read rather than trusted.
 *
 * Every field of `UiSettings` must be named below. See the module comment.
 */
export function coerceUi(raw: unknown): UiSettings {
  const source = (raw ?? {}) as Partial<UiSettings>;
  const width = Number(source.sidebarWidth);
  return {
    sidebarWidth: Number.isFinite(width)
      ? Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(width)))
      : DEFAULT_UI_SETTINGS.sidebarWidth,
    sidebarCollapsed: source.sidebarCollapsed === true,
    theme: isTheme(source.theme) ? source.theme : DEFAULT_UI_SETTINGS.theme,
    language: isLanguage(source.language) ? source.language : DEFAULT_UI_SETTINGS.language,
    // Only non-negative here. The real clamp is the live window, which this
    // process cannot see, so the renderer applies it again on every drag and on
    // resize -- the same two-stage arrangement `sidebarWidth` uses.
    toolWindowX: coordinate(source.toolWindowX, DEFAULT_UI_SETTINGS.toolWindowX),
    toolWindowY: coordinate(source.toolWindowY, DEFAULT_UI_SETTINGS.toolWindowY),
    inspectorWindowX: coordinate(source.inspectorWindowX, DEFAULT_UI_SETTINGS.inspectorWindowX),
    inspectorWindowY: coordinate(source.inspectorWindowY, DEFAULT_UI_SETTINGS.inspectorWindowY),
  };
}

function coordinate(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

/**
 * Merges a persisted blob over the defaults field by field. A settings file
 * written by an older build must not be able to produce `undefined` where the
 * renderer expects a value, so nothing is spread blindly.
 *
 * `preview` is the exception, and deliberately: it *is* spread over the
 * defaults, so a new `PreviewSettings` field survives with no change here. The
 * cost is that its values are not validated -- whatever the file holds is
 * passed through. That trade is fine for numbers a slider wrote and would not
 * be for `ui`, which decides what the window looks like before anything is
 * drawn.
 */
export function coerceSettings(raw: unknown): Settings {
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
