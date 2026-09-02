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
  DEFAULT_HOTBAR,
  DEFAULT_MCP_SETTINGS,
  DEFAULT_SETTINGS,
  DEFAULT_UI_SETTINGS,
  HOTBAR_SLOTS,
  LANGUAGES,
  MCP_PORT,
  PROVIDERS,
  SIDEBAR_WIDTH,
  THEMES,
  DEFAULT_EDITING_SETTINGS,
  VOID_OPACITY,
  type EditingSettings,
  type Hotbar,
  type Language,
  type McpSettings,
  type Provider,
  type Settings,
  type Theme,
  type UiSettings,
  PANEL_SIZE,
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
    // Sizes get the floor, not the ceiling: the pane a panel has to fit in is
    // the renderer's to measure, and it clamps again on every drag.
    toolWindowW: extent(source.toolWindowW, DEFAULT_UI_SETTINGS.toolWindowW, PANEL_SIZE.minWidth),
    toolWindowH: extent(source.toolWindowH, DEFAULT_UI_SETTINGS.toolWindowH, PANEL_SIZE.minHeight),
    inspectorWindowX: coordinate(source.inspectorWindowX, DEFAULT_UI_SETTINGS.inspectorWindowX),
    inspectorWindowY: coordinate(source.inspectorWindowY, DEFAULT_UI_SETTINGS.inspectorWindowY),
    inspectorWindowW: extent(
      source.inspectorWindowW,
      DEFAULT_UI_SETTINGS.inspectorWindowW,
      PANEL_SIZE.minWidth,
    ),
    inspectorWindowH: extent(
      source.inspectorWindowH,
      DEFAULT_UI_SETTINGS.inspectorWindowH,
      PANEL_SIZE.minHeight,
    ),
    /*
     * `hotbar` and `hotbarSlot` were here and are gone: a hotbar belongs to a
     * document now, keyed on its path, not to the window. `sidebarTab` went
     * the same way when the tabs did. Not naming a field is how this
     * function drops one, which is exactly what should happen to a value a
     * newer build no longer has a meaning for.
     */
  };
}

/**
 * Exactly `HOTBAR_SLOTS` block ids and a slot to hold, whatever was on disk.
 *
 * Padded and truncated rather than rejected: a hotbar is a convenience, and
 * losing all nine because one entry was edited badly is a worse trade than
 * quietly restoring the default in that slot. The length itself is not
 * negotiable — the template indexes by slot, and the keys 1-9 have to land.
 *
 * Exported because it is read in two places now: `settings-store.ts` used to
 * be the only one, and the per-document store reads files nobody has
 * validated either. One coercion, or the two come to disagree about what a
 * hotbar is.
 */
export function coerceHotbar(raw: unknown): Hotbar {
  const source =
    raw !== null && typeof raw === "object" ? (raw as { slots?: unknown; slot?: unknown }) : {};
  return {
    slots: hotbarSlots(source.slots),
    // Wrapped rather than clamped, so a stored index from a build with a
    // different slot count lands somewhere reachable instead of always on 0.
    slot: (((Math.trunc(Number(source.slot)) || 0) % HOTBAR_SLOTS) + HOTBAR_SLOTS) % HOTBAR_SLOTS,
  };
}

function hotbarSlots(raw: unknown): string[] {
  const source = Array.isArray(raw) ? raw : [];
  return Array.from({ length: HOTBAR_SLOTS }, (_unused, index) => {
    const value = source[index];
    const held = typeof value === "string" ? value.trim() : "";
    /*
     * Air is refused, not just blank entries. It is a legitimate block id
     * everywhere else in the app -- the document is mostly made of it -- but a
     * slot holding air is a slot that draws nothing and places nothing, and a
     * settings file from before this rule has one in slot nine.
     */
    return held !== "" && !isAir(held) ? held : DEFAULT_HOTBAR[index];
  });
}

function isAir(block: string): boolean {
  return block.split("[")[0].replace(/^minecraft:/, "") === "air";
}

/** A stored panel dimension: a number, at least the minimum, or the default. */
function extent(raw: unknown, fallback: number, minimum: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(minimum, Math.round(value)) : fallback;
}

function coordinate(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

/**
 * Every field of `McpSettings`, named — see the module comment.
 *
 * Whitelisted rather than spread for a reason sharper than `ui`'s: these decide
 * whether a socket is opened and whether a delete verb exists, so a field that
 * arrives from a settings file this build does not understand must not survive
 * into one that does. `enabled` and `allowDelete` are compared against `true`
 * rather than coerced, so anything that is not exactly `true` is off.
 */
/**
 * Named field by field, like `coerceUi` and unlike the `preview` spread.
 *
 * These decide what an edit is allowed to do to a file, so a value arriving
 * from disk in a shape nobody checked is not a cosmetic risk. The cost is
 * the usual one and it is the point: a field added to `EditingSettings` and
 * not named here is silently dropped on the next save, and
 * `tests/services.ts` round-trips a fully-populated `Settings` so that
 * breaks the compile before it can break a user's settings file.
 */
export function coerceEditing(raw: unknown): EditingSettings {
  const source = (raw ?? {}) as Partial<EditingSettings>;
  return {
    // Defaults to on, which is what the editor did before there was a
    // setting -- so `!== false` rather than `=== true`: an absent value has
    // to mean the old behaviour, not the safe-looking one.
    autoGrow: source.autoGrow !== false,
    /*
     * `voidBlock` is deliberately absent, and its normaliser moved rather
     * than went away.
     *
     * What empty space is made of is a fact about one schematic -- it is
     * written into that file when a block is broken -- so it lives on the
     * open session and is remembered per path in `ProjectNotes`. As a
     * global it followed you between documents quietly changing what a
     * break wrote.
     *
     * The air-heals-to-empty-string rule is still needed wherever the
     * value now enters, or `fillVoid` interns air over air; it is
     * `normaliseVoidBlock` in `shared/settings.ts`.
     *
     * A settings file written by an older build still carries the key. It
     * is simply not read, which is this function's whole contract: only
     * what is named survives.
     */
    voidOpacity: opacity(source.voidOpacity),
  };
}

function opacity(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_EDITING_SETTINGS.voidOpacity;
  return Math.min(VOID_OPACITY.max, Math.max(VOID_OPACITY.min, value));
}

export function coerceMcp(raw: unknown): McpSettings {
  const source = (raw ?? {}) as Partial<McpSettings>;
  const port = Number(source.port);
  return {
    enabled: source.enabled === true,
    port:
      Number.isFinite(port) && port >= MCP_PORT.min && port <= MCP_PORT.max
        ? Math.trunc(port)
        : DEFAULT_MCP_SETTINGS.port,
    root: typeof source.root === "string" ? source.root : DEFAULT_MCP_SETTINGS.root,
    allowDelete: source.allowDelete === true,
  };
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
  const mcp = coerceMcp(source.mcp);
  const editing = coerceEditing(source.editing);
  return {
    provider: isProvider(source.provider) ? source.provider : DEFAULT_SETTINGS.provider,
    model: typeof source.model === "string" ? source.model : DEFAULT_SETTINGS.model,
    baseUrl: typeof source.baseUrl === "string" ? source.baseUrl : DEFAULT_SETTINGS.baseUrl,
    version: typeof source.version === "string" ? source.version : DEFAULT_SETTINGS.version,
    exportType: source.exportType === "mcfunction" ? "mcfunction" : "schem",
    outputDir: typeof source.outputDir === "string" ? source.outputDir : DEFAULT_SETTINGS.outputDir,
    preview,
    ui,
    mcp,
    editing,
  };
}
