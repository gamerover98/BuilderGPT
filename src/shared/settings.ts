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

/**
 * How the orbit camera projects: with a vanishing point, or without one.
 *
 * `"orthographic"` is the isometric look -- parallel lines stay parallel and a
 * block the far side of the build is drawn exactly as large as one at the near
 * side, which is what makes a schematic readable as a plan rather than as a
 * photograph.
 *
 * A union, and the one field in `PreviewSettings` that is not a number or a
 * boolean, so it is worth saying why it needs no validation while `ui.theme`
 * does: `coerceSettings` spreads `preview` over the defaults without checking
 * anything, and the read of this is *total* -- anything that is not exactly
 * `"orthographic"` is drawn with perspective, which is the default. A junk
 * value is therefore indistinguishable from an absent one, which is the only
 * property that makes the spread safe.
 */
export type Projection = "perspective" | "orthographic";

export interface PreviewSettings {
  projection: Projection;
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  maxDpr: number;
  renderScale: number;
  maxDrawDistance: number;
  showGrid: boolean;
  wireframe: boolean;
  /**
   * Ambient occlusion, and it means the real thing now.
   *
   * It used to nudge the intensity of two lights, which is not occlusion by
   * any reading -- occlusion at a corner depends on the blocks around it, and
   * the viewer has no blocks. So this reaches the *mesher*: it bakes a
   * darkening factor into every vertex, and turning it off re-meshes.
   */
  ambientOcclusion: boolean;
  /**
   * Whether blocks that glow light the scene.
   *
   * Also the mesher's: light is a flood fill over the voxel grid, so it is
   * baked into the vertices with the occlusion. Off is a flat, evenly lit
   * structure, which is what the viewport did before there was any such thing.
   */
  blockLight: boolean;
  /**
   * Whether a vertex takes the average of the light around it.
   *
   * The game's "smooth lighting", and the mesher's like the other two: off is
   * flat, per-face light. It costs the same lookups occlusion already makes,
   * so it is nearly free once that is on.
   */
  smoothLighting: boolean;
  /**
   * The sky: a gradient, a square sun and moon, and stars.
   *
   * The viewer's own, and free to change: nothing about it touches geometry.
   * Off leaves the flat background the window painted before.
   */
  sky: boolean;
  /**
   * Where in the day it is, in Minecraft's own ticks: 0 is sunrise, 6000 noon,
   * 12000 sunset, 18000 midnight, 24000 back to sunrise.
   *
   * The unit is the game's rather than an angle or a clock time because it is
   * the one everybody building a schematic already thinks in -- `/time set
   * 18000` is a thing people type.
   */
  timeOfDay: number;
  /** Whether the time advances on its own. */
  daylightCycle: boolean;
  /** How many game minutes pass per real second while it does. */
  daylightSpeed: number;
  /**
   * Whether the sun and moon cast shadows.
   *
   * The most expensive thing in the viewport by a distance -- a whole extra
   * pass over the geometry from the light's point of view, every frame the
   * light moves. Off by default for that reason.
   */
  shadows: boolean;
  /** Shadow map resolution, in pixels along one side. */
  shadowQuality: number;
  /**
   * A virtual floor at y=0, wide enough to reach the horizon.
   *
   * Nothing to do with the schematic: it is not a block and is never saved. It
   * is there so a build has ground under it and something for its shadow to
   * fall on -- without it a house at the origin floats in the sky, and every
   * shadow it casts falls into nothing and is invisible.
   */
  ground: boolean;
  /**
   * `#rrggbb` for that floor, or empty to follow the theme.
   *
   * Empty rather than a colour as the default, and that distinction is the
   * whole reason this is a string: a stored `#161d27` would stay dark after
   * switching to the light theme, and nothing on screen would say why.
   */
  groundColor: string;
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
  /**
   * Whether barriers and structure voids are drawn.
   *
   * They are invisible to a player and placed on purpose — a barrier keeps
   * people out of somewhere, and a shell of them is a decision somebody has to
   * be able to review. So the default is on, which is deliberately *not* the
   * game's own view: this app is for the builder, and the builder is the one
   * person who needs to see them. Turn it off to see the build as a player
   * would.
   *
   * Like the two tints, this one is consumed by the mesher rather than the
   * viewer, so changing it rebuilds the mesh.
   */
  showMarkers: boolean;
  /**
   * Draw the schematic's own box as a transparent cage.
   *
   * The document has a size and, until this, no way to see it: the build
   * inside it is not its edge, and empty space at the top of a box looks
   * exactly like empty space outside one. Off by default, because on a
   * build that fills its box it is a wire cage around everything.
   *
   * The viewer's, not the mesher's -- it is not a block, never reaches the
   * atlas, and is not raycast -- so it is a visibility toggle rather than a
   * rebuild.
   */
  showBounds: boolean;
  /**
   * Draw WorldEdit's paste anchor as a marker in the viewport.
   *
   * Applied by the viewer, not the mesher: the anchor is not a block and never
   * reaches the atlas, so turning it off is a visibility toggle rather than a
   * rebuild. It also has nothing to hide when the schematic carries no anchor.
   */
  showWorldEditOffset: boolean;
}

/** component.py:319-328 slider/checkbox defaults, verbatim. */
export const DEFAULT_PREVIEW_SETTINGS: PreviewSettings = {
  projection: "perspective",
  sunAzimuthDeg: 60,
  sunElevationDeg: 35,
  maxDpr: 1.6,
  renderScale: 1.0,
  maxDrawDistance: 512,
  showGrid: true,
  wireframe: false,
  ambientOcclusion: true,
  blockLight: true,
  smoothLighting: true,
  sky: true,
  // Mid-morning: the sun is up and off to one side, so a build has a lit face
  // and a shaded one. Noon is flatter and reads worse.
  timeOfDay: 2000,
  daylightCycle: false,
  daylightSpeed: 60,
  shadows: false,
  shadowQuality: 2048,
  ground: true,
  groundColor: "",
  biomeColor: DEFAULT_BIOME_COLOR,
  waterColor: DEFAULT_WATER_COLOR,
  flySpeed: 12,
  showMarkers: true,
  showBounds: false,
  showWorldEditOffset: true,
};

/** Slider bounds from component.py:319-328, reused by the renderer's inputs. */
export const PREVIEW_SETTING_RANGES = {
  sunAzimuthDeg: { min: 0, max: 360, step: 1 },
  sunElevationDeg: { min: -30, max: 90, step: 1 },
  maxDpr: { min: 0.5, max: 3, step: 0.1 },
  renderScale: { min: 0.5, max: 2, step: 0.1 },
  maxDrawDistance: { min: 64, max: 2048, step: 8 },
  flySpeed: { min: 2, max: 60, step: 1 },
  timeOfDay: { min: 0, max: 24000, step: 100 },
  daylightSpeed: { min: 5, max: 600, step: 5 },
} as const;

/** Shadow map sizes offered, in pixels along one side. */
export const SHADOW_QUALITIES = [1024, 2048, 4096] as const;

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
   * And how big it is. The panel was a hard-coded 232px, which is what sent
   * the version history off to a modal and what left the inspector showing
   * `Items[0].tag.display.Name` three characters at a time.
   */
  toolWindowW: number;
  toolWindowH: number;
  /**
   * The inspector's own floating window.
   *
   * A separate pair rather than one shared position, because both windows can
   * be open at once and a single stored position would stack them.
   */
  inspectorWindowX: number;
  inspectorWindowY: number;
  inspectorWindowW: number;
  inspectorWindowH: number;
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

/*
 * There is no `sidebarTab` any more, and there are no tabs.
 *
 * The second one was called Schematic and then Generate, and neither name was
 * wrong -- the drawer really did hold three unrelated things, and renaming it
 * only ever narrowed which of the three the name lied about. The file verbs
 * went to the menu and the start screen, the version history went to a floating
 * window, the generated files went to the start screen beside the recents, and
 * the generator form turned out to be a second, worse chat: the chat has built
 * a schematic from a sentence since the day it learned to, with the same model
 * and the same progress. What was left to keep was the reference image and the
 * export format, and those are inputs to a message rather than a panel.
 *
 * So the sidebar is the chat, and a tab strip over a single panel is a control
 * with nothing to choose.
 */

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
  // Not air: there is nothing to hold and nothing to draw. A block is removed
  // by breaking it, which is the only gesture that ever means air.
  "minecraft:torch",
];

/**
 * The upper bound is also enforced against the live window width at drag time
 * (the viewport keeps at least SIDEBAR_WIDTH.minViewport), so this is the
 * clamp that survives a settings file written on a wider screen.
 */
export const SIDEBAR_WIDTH = { min: 320, max: 720, minViewport: 360 } as const;

/**
 * What a resizable floating panel may become, in CSS pixels.
 *
 * A minimum because a panel dragged to nothing cannot be dragged back -- the
 * resize handle would have no room to exist in. A maximum because these hover
 * over the viewport they are used to edit, and one grown past the window is a
 * panel that hides the thing it acts on.
 *
 * Clamped twice, the way `SIDEBAR_WIDTH` is: once on the stored value, which
 * main can check without seeing a window, and again against the live pane on
 * every move, which only the renderer can do.
 */
export const PANEL_SIZE = { minWidth: 232, minHeight: 160 } as const;

export const DEFAULT_UI_SETTINGS: UiSettings = {
  sidebarWidth: 420,
  sidebarCollapsed: false,
  theme: "system",
  language: "en",
  // Below the viewport's HUD line rather than on top of it: both were at 16,
  // in the same containing block, so the panel opened over the text telling
  // you how to fly.
  toolWindowX: 16,
  toolWindowY: 64,
  toolWindowW: 232,
  toolWindowH: 420,
  // Below the tool window rather than beside it: the viewport is wider than it
  // is tall, and two panels down the same edge leave the middle clear.
  inspectorWindowX: 16,
  inspectorWindowY: 500,
  inspectorWindowW: 300,
  inspectorWindowH: 320,
  hotbar: [...DEFAULT_HOTBAR],
  hotbarSlot: 0,
};

/**
 * The MCP server: whether it runs, where, and what it may do.
 *
 * Every field is a decision about what somebody else's model is allowed to do
 * to your build, which is why none of them defaults to permissive.
 */
export interface McpSettings {
  /**
   * Off until asked for.
   *
   * This opens a listening socket in the privileged process, so the safe
   * default is the only defensible one — and it is *intent*, not state: the
   * server may still fail to start because the port is taken. What is actually
   * listening is `McpStatus`, which comes from main.
   */
  enabled: boolean;
  /** `0` asks the OS for a free one, which is what a second instance needs. */
  port: number;
  /**
   * The directory outside which the server will not open, save or delete.
   *
   * Empty means the output directory, which is where the app's own files
   * already go. A root is what keeps a mistyped path from reaching the rest of
   * the disk; it is not a sandbox against a hostile client, and does not claim
   * to be one.
   */
  root: string;
  /**
   * Whether `delete_document` exists at all.
   *
   * Separate from `enabled` because the two questions are different: "may
   * another program edit my schematics" is most of the value here, and "may it
   * throw them away" is the one verb that leaves the app's own safety net.
   * Even on, the file goes to the OS trash rather than being unlinked.
   */
  allowDelete: boolean;
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  port: 4571,
  root: "",
  allowDelete: false,
};

/** What the port may be. `0` is legal and means "any free one". */
export const MCP_PORT = { min: 0, max: 65535 } as const;

/**
 * What an edit *does*, as opposed to how the result is drawn.
 *
 * A third bag rather than more fields in `preview` or `ui`, because these
 * are neither: they change what ends up in the file, and main has to honour
 * them. `preview` is spread over the defaults without validation, which is
 * the right trade for numbers a slider wrote and the wrong one for a rule
 * that decides whether a fill is allowed to resize somebody's schematic.
 */
export interface EditingSettings {
  /**
   * Whether a fill or a placement outside the box grows the document.
   *
   * On is what the editor has always done: the region leads and the
   * document follows, in one transaction so growing and filling are one
   * undo step. Off makes the box a fixed frame -- which is what somebody
   * building to a size wants -- and then an edit that reaches outside it is
   * **refused by name** rather than clipped. Silent clipping is the failure
   * this codebase has already written down once.
   *
   * Growth only. There is no shrink-on-delete to turn off: breaking never
   * grows, saving already crops to content, and shrinking under the user
   * would throw away the room they made to build in.
   */
  autoGrow: boolean;
  /*
   * `voidBlock` used to be here and deliberately is not any more.
   *
   * What empty space is made of is a fact about *one schematic*, not a
   * preference about editing: it is written into that file when a block is
   * broken, and an underwater jetty and a cathedral have different answers.
   * As a global it followed you from document to document silently changing
   * what a break wrote, which is the wrong direction for a setting that
   * ends up in somebody's file.
   *
   * It lives on the open session and is remembered per path in
   * `ProjectNotes`, beside the version and the container -- the sidecar that
   * already answers "what is this schematic for". See
   * `services/conversation_store.ts`.
   *
   * `voidOpacity` stayed, and the split is the rule rather than an
   * inconsistency: opacity is about *looking* at empty space and never
   * reaches the file, so it is a preference and belongs to the person, not
   * to the schematic.
   */
  /**
   * How solid the void block looks, 0 to 1.
   *
   * A viewport property with nowhere else to live: it belongs with the
   * block it applies to, and splitting the pair across `preview` and
   * `editing` would put one panel's two controls in two settings files.
   *
   * Never zero. A void block that draws nothing is a void block that is
   * not there, and the checkbox for that is choosing air.
   */
  voidOpacity: number;
}

export const DEFAULT_EDITING_SETTINGS: EditingSettings = {
  autoGrow: true,
  voidOpacity: 0.4,
};

/** What the void block's opacity may be. Never 0; see `voidOpacity`. */
export const VOID_OPACITY = { min: 0.05, max: 1 } as const;

/**
 * What empty space is made of, normalised. `""` is air.
 *
 * Every spelling of air heals to `""`, and that is load-bearing rather than
 * tidiness: `fillVoid` rewrites the *air palette entry* into the chosen block,
 * so a void block that is itself air would intern air over air and hand the
 * mesher a palette in which every index is void and none of them draws
 * anything -- the expensive way of doing exactly what the default already does
 * for free.
 *
 * Here rather than in `settings_coerce.ts`, where it began, because it is no
 * longer a setting: main normalises it on the way onto the session and the
 * renderer needs the same answer to decide what a break will write.
 */
export function normaliseVoidBlock(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") return "";
  const bare = value.split("[")[0].replace(/^minecraft:/, "");
  return bare === "air" ? "" : value;
}

/**
 * The blocks a change of empty space converts **from**, as ids.
 *
 * One function because there are two callers and they must not disagree:
 * `setSessionVoidBlock` does the converting, and the panel decides from the
 * same answer whether there is anything to convert. Two copies of this rule is
 * how the button comes to be live over an edit that changes nothing, or dead
 * over one that would work.
 *
 * **Air is always a source**, and that is the whole of a bug worth keeping
 * written down. Taking the previous choice alone cannot separate two states
 * that look identical from the setting: a schematic whose empty space is *set*
 * to barrier with its cells still air -- reopened from its sidecar, or one
 * Ctrl+Z after a conversion -- against one where the conversion already
 * happened. Both say barrier, and only one has anything to do. Reading the
 * setting refused both, so the one gesture that would have fixed it was the
 * one with no answer.
 *
 * The previous choice is **added** to air rather than standing in for it,
 * because a conversion leaves its own block behind: swapping barrier for
 * structure_void has to find the barrier, and air alone would not.
 *
 * The target is never a source. Converting a block into itself can only
 * change nothing, and offering it would put an empty step on the undo stack.
 */
export function voidSources(previous: string, next: string): string[] {
  const id = (value: string): string => (value === "" ? "minecraft:air" : value);
  const target = id(normaliseVoidBlock(next));
  return [...new Set(["minecraft:air", id(normaliseVoidBlock(previous))])].filter(
    (source) => source !== target,
  );
}
/**
 * Every block a document contains, **air included**, without block states.
 *
 * `DocumentState.palette` deliberately leaves air out -- it is the materials
 * list, and a schematic is mostly air -- so a caller asking "does this document
 * hold any air" from it alone always gets no, whatever the document. That is
 * the second half of the empty-space button's bug: the sources were right and
 * the set they were looked up in could never contain the commonest one.
 *
 * Air is recovered rather than transported: `countBlocks` counts every voxel
 * whose palette index is not zero, and index 0 is always air, so the document
 * holds air exactly when `blockCount` is short of the volume. Exact, and out of
 * two numbers `DocumentState` already carries.
 */
export function blocksInDocument(
  palette: readonly { block: string }[],
  size: readonly [number, number, number],
  blockCount: number,
): Set<string> {
  const held = new Set(palette.map((entry) => entry.block.split("[")[0]));
  if (blockCount < size[0] * size[1] * size[2]) held.add("minecraft:air");
  return held;
}
/**
 * What a schematic may be resized to by hand, per axis.
 *
 * The ceiling is per *axis* and is not the volume guard: 4096 cubed is far
 * past what `MAX_DOCUMENT_VOLUME` allows, and the volume is checked
 * separately by main. This is only what a number field will accept, so a
 * fat-fingered extra digit is refused where it is typed.
 */
export const DOCUMENT_SIZE = { min: 1, max: 4096 } as const;

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
  mcp: McpSettings;
  editing: EditingSettings;
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
  mcp: { ...DEFAULT_MCP_SETTINGS },
  editing: { ...DEFAULT_EDITING_SETTINGS },
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
