/**
 * Settings shape shared by main, preload and renderer.
 *
 * ARCHITECTURE.md §3 "Secrets": this module is pure data + defaults, no I/O and
 * no Electron imports, precisely so the renderer can import it. API keys are
 * NOT part of this shape -- they live encrypted, main-side only, and the
 * renderer only ever learns whether one exists (`ProviderKeyStatus`).
 */

export const PROVIDERS = [
  "OpenAI",
  "Google Gemini",
  "OpenCode",
  "Custom (OpenAI Compatible)",
] as const;

export type Provider = (typeof PROVIDERS)[number];

export type ExportType = "schem" | "mcfunction";

/** Ported from component.py:66-77 -- the four provider branches of `call_llm`. */
export const PROVIDER_DEFAULT_BASE_URL: Readonly<Record<Provider, string>> = {
  OpenAI: "https://api.openai.com/v1",
  "Google Gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
  // component.py:73 used `https://console.opencode.ai/inference/openai/v1`,
  // which still answers but is not the endpoint OpenCode publishes. This is
  // the one its own model registry declares for the `opencode` provider
  // (models.dev -> `api`), and it is where `/models` is documented to live.
  OpenCode: "https://opencode.ai/zen/v1",
  "Custom (OpenAI Compatible)": "",
};

/** Ported from component.py:239-244. */
export const PROVIDER_DEFAULT_MODEL: Readonly<Record<Provider, string>> = {
  OpenAI: "gpt-4o",
  "Google Gemini": "gemini-2.5-pro",
  OpenCode: "mimo-v2.5-free",
  "Custom (OpenAI Compatible)": "",
};

/**
 * component.py:383 -- OpenCode is the one provider whose key is optional
 * ("API Key (Optional for free models)"), and the one the Generate gate lets
 * through with an empty key.
 */
export function providerRequiresApiKey(provider: Provider): boolean {
  return provider !== "OpenCode";
}

/**
 * Preview options as the UI holds them: **degrees**, matching component.py's
 * sliders. `math.radians` was applied at the call site (component.py:331-332);
 * here the conversion happens in the main process, at the same boundary.
 */
/**
 * Plains grass — the colour Minecraft tints grass, leaves and vines with in the
 * biome most schematics are built for.
 */
export const DEFAULT_BIOME_COLOR = "#91bd59";

/**
 * Plains water. A separate number from the grass tint on purpose — Minecraft
 * tints water from its own biome colour, and `water_still.png` is as greyscale
 * as `grass_block_top.png`.
 */
export const DEFAULT_WATER_COLOR = "#3f76e4";

export interface PreviewSettings {
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  maxDpr: number;
  renderScale: number;
  maxDrawDistance: number;
  showGrid: boolean;
  wireframe: boolean;
  ambientOcclusion: boolean;
  /**
   * `#rrggbb` multiplied into the greyscale textures Minecraft tints per
   * biome. Unlike every other field here this one is consumed by the *mesher*,
   * not the viewer, so changing it rebuilds the GLB rather than applying live.
   */
  biomeColor: string;
  /** `#rrggbb` for water; see `DEFAULT_WATER_COLOR`. Also rebuilds the mesh. */
  waterColor: string;
  /** Blocks per second in the Creative flight camera. */
  flySpeed: number;
}

/** component.py:319-328 slider/checkbox defaults, verbatim. */
export const DEFAULT_PREVIEW_SETTINGS: PreviewSettings = {
  sunAzimuthDeg: 60,
  sunElevationDeg: 35,
  maxDpr: 1.6,
  renderScale: 1.0,
  maxDrawDistance: 512,
  showGrid: true,
  wireframe: false,
  ambientOcclusion: true,
  biomeColor: DEFAULT_BIOME_COLOR,
  waterColor: DEFAULT_WATER_COLOR,
  flySpeed: 12,
};

/** Slider bounds from component.py:319-328, reused by the renderer's inputs. */
export const PREVIEW_SETTING_RANGES = {
  sunAzimuthDeg: { min: 0, max: 360, step: 1 },
  sunElevationDeg: { min: -30, max: 90, step: 1 },
  maxDpr: { min: 0.5, max: 3, step: 0.1 },
  renderScale: { min: 0.5, max: 2, step: 0.1 },
  maxDrawDistance: { min: 64, max: 2048, step: 8 },
  flySpeed: { min: 2, max: 60, step: 1 },
} as const;

/**
 * The three values a theme setting can take.
 *
 * `"system"` is deliberately a stored value rather than the absence of one:
 * "follow the OS" is a choice the user made and can go back to, and a nullable
 * field could not tell it apart from "never asked".
 */
export const THEMES = ["system", "light", "dark"] as const;

export type Theme = (typeof THEMES)[number];

/**
 * `Theme` with `"system"` already resolved against the OS preference.
 *
 * The distinction matters to anything that has to *draw* rather than store:
 * "system" names a source of truth, not a colour, and a renderer asked to paint
 * it has nothing to paint.
 */
export type ResolvedTheme = Exclude<Theme, "system">;

/**
 * UI languages. English only for now, and the default -- the list exists so
 * adding a second one is a data change rather than a type change.
 */
export const LANGUAGES = ["en"] as const;

export type Language = (typeof LANGUAGES)[number];

/**
 * Window chrome the user can rearrange. Streamlit owned its own layout and
 * offered none of this, so there is nothing to port -- these exist because the
 * 3D viewport and the control column now share one window and compete for it.
 */
export interface UiSettings {
  /** Sidebar width in CSS pixels; clamped to SIDEBAR_WIDTH on both sides. */
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /**
   * Which palette the window paints itself with. `"system"` is not a third
   * palette -- it is the absence of a choice, and defers to the OS through
   * `prefers-color-scheme`.
   */
  theme: Theme;
  /** UI language. The renderer's strings only; main's errors are not translated. */
  language: Language;
  /**
   * Where the floating tool window sits, in pixels from the viewport's
   * top-left corner.
   *
   * Clamped on read the way the sidebar width is, and again against the live
   * window at drag time: a position saved on a second monitor is otherwise a
   * panel nobody can reach.
   */
  toolWindowX: number;
  toolWindowY: number;
  /**
   * The inspector's own floating window.
   *
   * A separate pair rather than one shared position, because both windows can
   * be open at once and a single stored position would stack them.
   */
  inspectorWindowX: number;
  inspectorWindowY: number;
  /**
   * The nine blocks on the creative hotbar, and which one is held.
   *
   * Persisted because a hotbar you have to refill every launch is not a hotbar.
   * Always exactly `HOTBAR_SLOTS` long after `coerceUi` — a short array would
   * leave the template indexing past the end, and a long one would draw slots
   * no key can reach.
   */
  hotbar: string[];
  hotbarSlot: number;
}

/** Nine, because that is how many keys there are between 1 and 9. */
export const HOTBAR_SLOTS = 9;

/**
 * What a fresh hotbar holds.
 *
 * Blocks that exist in every version this app supports, so the default is
 * usable whichever era the document targets — no point starting someone on
 * deepslate if they opened a 1.8.8 schematic.
 */
export const DEFAULT_HOTBAR: readonly string[] = [
  "minecraft:stone",
  "minecraft:cobblestone",
  "minecraft:oak_planks",
  "minecraft:oak_log",
  "minecraft:glass",
  "minecraft:sandstone",
  "minecraft:bricks",
  "minecraft:glowstone",
  "minecraft:air",
];

/**
 * The upper bound is also enforced against the live window width at drag time
 * (the viewport keeps at least SIDEBAR_WIDTH.minViewport), so this is the
 * clamp that survives a settings file written on a wider screen.
 */
export const SIDEBAR_WIDTH = { min: 320, max: 720, minViewport: 360 } as const;

export const DEFAULT_UI_SETTINGS: UiSettings = {
  sidebarWidth: 420,
  sidebarCollapsed: false,
  theme: "system",
  language: "en",
  toolWindowX: 16,
  toolWindowY: 16,
  // Below the tool window rather than beside it: the viewport is wider than it
  // is tall, and two panels down the same edge leave the middle clear.
  inspectorWindowX: 16,
  inspectorWindowY: 320,
  hotbar: [...DEFAULT_HOTBAR],
  hotbarSlot: 0,
};

export interface Settings {
  provider: Provider;
  model: string;
  /** Empty means "use PROVIDER_DEFAULT_BASE_URL[provider]". */
  baseUrl: string;
  version: string;
  exportType: ExportType;
  /** Empty means "use the app's default generated/ directory under userData". */
  outputDir: string;
  preview: PreviewSettings;
  ui: UiSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  // component.py:239 opened on OpenAI, which cannot generate anything until you
  // paste a paid API key. OpenCode's free tier can, so a first run now works
  // out of the box. This is only the *initial* value: `settings.json` records
  // whatever you last chose, and that wins on every subsequent launch.
  provider: "OpenCode",
  model: PROVIDER_DEFAULT_MODEL.OpenCode,
  baseUrl: "",
  version: "JE_1_20_4",
  exportType: "schem",
  outputDir: "",
  preview: { ...DEFAULT_PREVIEW_SETTINGS },
  ui: { ...DEFAULT_UI_SETTINGS },
};

/**
 * What the renderer is allowed to know about stored keys. Never the key itself
 * -- see ARCHITECTURE.md §3 "API keys over IPC".
 */
export interface ProviderKeyStatus {
  provider: Provider;
  hasKey: boolean;
}

/**
 * `safeStorage.isEncryptionAvailable() === false` on this OS/session. The UI
 * must warn and keys stay in memory for the session only; we never write a
 * plaintext key to disk.
 */
export interface KeyStorageStatus {
  encryptionAvailable: boolean;
  keys: ProviderKeyStatus[];
}
