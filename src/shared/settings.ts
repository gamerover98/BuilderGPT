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
  OpenCode: "https://console.opencode.ai/inference/openai/v1",
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
export interface PreviewSettings {
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  maxDpr: number;
  renderScale: number;
  maxDrawDistance: number;
  showGrid: boolean;
  wireframe: boolean;
  ambientOcclusion: boolean;
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
};

/** Slider bounds from component.py:319-328, reused by the renderer's inputs. */
export const PREVIEW_SETTING_RANGES = {
  sunAzimuthDeg: { min: 0, max: 360, step: 1 },
  sunElevationDeg: { min: -30, max: 90, step: 1 },
  maxDpr: { min: 0.5, max: 3, step: 0.1 },
  renderScale: { min: 0.5, max: 2, step: 0.1 },
  maxDrawDistance: { min: 64, max: 2048, step: 8 },
} as const;

/**
 * Window chrome the user can rearrange. Streamlit owned its own layout and
 * offered none of this, so there is nothing to port -- these exist because the
 * 3D viewport and the control column now share one window and compete for it.
 */
export interface UiSettings {
  /** Sidebar width in CSS pixels; clamped to SIDEBAR_WIDTH on both sides. */
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}

/**
 * The upper bound is also enforced against the live window width at drag time
 * (the viewport keeps at least SIDEBAR_WIDTH.minViewport), so this is the
 * clamp that survives a settings file written on a wider screen.
 */
export const SIDEBAR_WIDTH = { min: 320, max: 720, minViewport: 360 } as const;

export const DEFAULT_UI_SETTINGS: UiSettings = {
  sidebarWidth: 420,
  sidebarCollapsed: false,
};

export interface Settings {
  provider: Provider;
  model: string;
  /** Empty means "use PROVIDER_DEFAULT_BASE_URL[provider]". */
  baseUrl: string;
  version: string;
  exportType: ExportType;
  preview: PreviewSettings;
  ui: UiSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "OpenAI",
  model: PROVIDER_DEFAULT_MODEL.OpenAI,
  baseUrl: "",
  version: "JE_1_20_4",
  exportType: "schem",
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
