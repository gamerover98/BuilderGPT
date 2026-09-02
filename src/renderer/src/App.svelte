<script lang="ts">
  /**
   * Port of `BuilderGPTComponent.render` (component.py:231-417) plus
   * `run_app.py`'s page setup.
   *
   * What Streamlit's rerun loop did implicitly, this does explicitly:
   * `st.session_state["bgpt_last_schem_path"]` becomes `lastSchemPath`,
   * `st.progress` becomes the `bgpt:progress` subscription, and `st.error` /
   * `st.warning` / `st.success` become one `status` banner. The
   * `_initialized`/`_instance` singleton guard from component.py:35-42 has no
   * counterpart and is deliberately dropped -- it existed only to survive the
   * module being re-executed on every interaction (ARCHITECTURE.md §4 change 2).
   */
  import { onMount, untrack } from "svelte";

    import ChatPanel from "./lib/ChatPanel.svelte";
  import CommandPalette, { type Command } from "./lib/CommandPalette.svelte";
  import DocumentBar from "./lib/DocumentBar.svelte";
  import McpIndicator from "./lib/McpIndicator.svelte";
  import { showsIndicator } from "./lib/mcp_status.js";
  import type { McpActivity, McpStatus } from "../../shared/ipc.js";
  import InspectorPanel from "./lib/InspectorPanel.svelte";
  import AboutModal from "./lib/AboutModal.svelte";
  import AnchorModal from "./lib/AnchorModal.svelte";
  import DimensionsModal from "./lib/DimensionsModal.svelte";
import VoidBlockModal from "./lib/VoidBlockModal.svelte";
import VersionModal from "./lib/VersionModal.svelte";
import {
  buildLegacyIndex,
  resolveBlockInput,
  type LegacyIndex,
} from "../../shared/legacy_ids.js";
import NbtModal from "./lib/NbtModal.svelte";
  import SettingsModal from "./lib/SettingsModal.svelte";
  import SelectionTools from "./lib/SelectionTools.svelte";
    import ToolWindow from "./lib/ToolWindow.svelte";
  import { findOpenCodeModel, loadOpenCodeModels } from "./lib/models.svelte.js";
  import SidebarSplitter from "./lib/SidebarSplitter.svelte";
import StartScreen from "./lib/StartScreen.svelte";
import StartupScreen, { type StartupStep } from "./lib/StartupScreen.svelte";
import VersionsModal from "./lib/VersionsModal.svelte";
  import Viewer, { type CameraMode, type PickedBlock } from "./lib/Viewer.svelte";
  import { api, bridgeAvailable, forIpc, bridgeMissingMessage } from "./lib/bridge.svelte.js";
  import { applyTraceEvent } from "./lib/trace.js";
  import { primeBlockIcons } from "./lib/block_icons.svelte.js";
  import {
    emptyTimeline,
    forgetTimeline,
    recordDocumentEdit,
    recordSelection,
    redoTarget,
    takeRedo,
    takeUndo,
    undoTarget,
    type SelectionState,
    type Timeline,
  } from "./lib/selection_history.js";
  import SchematicDialog from "./lib/SchematicDialog.svelte";
  import Hotbar from "./lib/Hotbar.svelte";
  import CreativeInventory from "./lib/CreativeInventory.svelte";
  import { hasTextSelection, isTyping } from "./lib/typing.js";
  import { documentEra, documentVersionName, mcVersion } from "../../shared/mc_versions.js";
  import { blocksIn } from "../../shared/block_versions.js";
  import { placementState, type PlacementLook } from "../../shared/block_orientation.js";
  import { movedRegion } from "./lib/selection_drag.js";
  import { t, tn, setLocale } from "./lib/i18n.svelte.js";
  import {
    openCodeModelRequiresKey,
    type TraceItem,
    type Artifact,
    type BlockInspection,
    type ChatEntry,
  type ChunkGeometry,
  type PackTexture,
  type SkyTextures,
    type ProjectNotes,
    type ChatState,
    type ConversationSummary,
    type AppInfo,
    type DocumentState,
    type EditResponse,
    type OpenCodeModelInfo,
    type ProgressEvent,
    type DocumentVersion,
  type RecentDocument,
    type RecoveryOffer,
    type ClipboardInfo,
    type MeshPayload,
    type RegionSpec,
    type TransformRequest,
  } from "../../shared/ipc.js";
  import type { SchematicFormat } from "../../shared/schematic.js";
import { schematicExtension } from "../../shared/schematic.js";
import type { FileKind } from "../../shared/ipc.js";
import ConvertModal from "./lib/ConvertModal.svelte";
  import {
    blocksInDocument,
    DEFAULT_SETTINGS,
    DEFAULT_PREVIEW_SETTINGS,
  DEFAULT_UI_SETTINGS,
    providerRequiresApiKey,
    type ExportType,
    type KeyStorageStatus,
    type PreviewSettings,
    type Provider,
    type ResolvedTheme,
    type Settings,
  } from "../../shared/settings.js";

  type Status = { tone: "info" | "ok" | "warn" | "error"; text: string; detail?: string } | null;

  let settings = $state<Settings>({ ...DEFAULT_SETTINGS });

  /**
   * Sidebar geometry is mirrored locally so a drag repaints at pointer speed;
   * `settings.ui` is only written when the gesture ends. Persisting per
   * pointermove would be a disk write per frame.
   */
  let sidebarWidth = $state(DEFAULT_UI_SETTINGS.sidebarWidth);
  let sidebarCollapsed = $state(DEFAULT_UI_SETTINGS.sidebarCollapsed);
  let keyStatus = $state<KeyStorageStatus | null>(null);
  let versions = $state<string[]>([]);

  /**
   * Which of New / Save As is asking, or nothing.
   *
   * One dialog for both, because they ask the same three questions. The mode
   * only decides whether the size is a field or a fact -- see the component.
   */
  let schematicDialog = $state<"new" | "save-as" | null>(null);
  /** The creative inventory, on `E`. */
  let inventoryOpen = $state(false);

  /**
   * What the open file is for, as main last recorded beside it.
   *
   * Preferred over the document's own `DataVersion` when the dialog opens,
   * because the tag cannot answer for every file: an MCEdit schematic carries
   * none at all, so without this a legacy build asked which Minecraft it was
   * every single time and got no help from the answer it gave last time.
   */
  let project = $state<ProjectNotes | null>(null);
  let artifacts = $state<Artifact[]>([]);
  /** What an empty `settings.outputDir` resolves to, shown as the placeholder. */
  let defaultOutputDir = $state("");

  let imagePath = $state<string | null>(null);
  let imageName = $state<string | null>(null);
  let resourcePackPath = $state<string | null>(null);
  let resourcePackName = $state<string | null>(null);

  /** component.py:281-282's `st.session_state["bgpt_last_schem_path"]`. */

  let busy = $state(false);
  let progress = $state<ProgressEvent | null>(null);
  let status = $state<Status>(null);

  /**
   * Whether the OS is asking for a dark window right now.
   *
   * Only consulted when the theme setting is `"system"`, but tracked
   * unconditionally: the listener is one line and the alternative is
   * subscribing and unsubscribing as the setting changes, for no gain.
   */
  let systemDark = $state(true);

  /**
   * The theme with `"system"` resolved -- what is actually on screen.
   *
   * Anything that has to *draw* a colour needs this rather than the setting:
   * "system" names where to look, not what to paint.
   */
  const resolvedTheme = $derived<ResolvedTheme>(
    settings.ui.theme === "system" ? (systemDark ? "dark" : "light") : settings.ui.theme,
  );

  let mesh = $state<MeshPayload | null>(null);
  let bounds = $state<{ center: number[]; size: number[] } | null>(null);
  /**
   * The sun's direction, in radians, straight from the two sliders.
   *
   * These used to be `$state` initialised to zero and written only by whatever
   * came back from a preview or a mesh rebuild. Since neither of the sun
   * settings rebuilds anything, `patchPreview` returned early and no round trip
   * ever happened -- so moving the sliders persisted the numbers and changed
   * nothing on screen until some unrelated action happened to refresh the mesh.
   * The viewer's effect was ready the whole time; the props feeding it never
   * moved.
   *
   * Derived from the settings instead, using the same degrees-to-radians the
   * main process applies in `sunAnglesRadians`. `PreviewSuccess` still carries
   * the angles and nothing reads them now; they are the main process's answer
   * to a question the renderer can answer itself.
   */
  const sunAzimuth = $derived((settings.preview.sunAzimuthDeg * Math.PI) / 180);
  const sunElevation = $derived((settings.preview.sunElevationDeg * Math.PI) / 180);

  /**
   * The open document, as main last described it. The renderer holds no
   * schematic of its own -- every edit is a request, and this is the summary
   * that comes back.
   */
  let docState = $state<DocumentState | null>(null);
  let selection = $state<RegionSpec | null>(null);
  /** The first corner of a selection being built, before Shift-click extends it. */
  let anchor = $state<{ x: number; y: number; z: number } | null>(null);

  /**
   * Undo and redo that reach the selection as well as the blocks.
   *
   * Kept here rather than in `SelectionTools`, because the two keys are a
   * window-level binding and the document state they interleave with lives
   * here. The rule and the arithmetic are in `selection_history.ts`; this is
   * only the plumbing.
   */
  let selectionTimeline = $state<Timeline>(emptyTimeline());
  /** The selection as it was when the timeline last agreed with the screen. */
  let lastSelection: SelectionState = { selection: null, anchor: null };
  /** True while a step is being put back, so restoring is not itself recorded. */
  let restoringSelection = false;
  /**
   * Where a drag started, or `null` when no drag is in progress.
   *
   * A drag reports the region on every pointer move. Recording each one would
   * put a step on the stack per frame and make Ctrl+Z walk backwards through a
   * gesture the user experienced as one movement.
   */
  let gestureFrom: SelectionState | null = null;
  /** Main's undo depth as of the last time it was accounted for. */
  let lastUndoDepth = 0;

  /*
   * Whether there is anything at all to take back, from either stack. The
   * buttons and the palette read this rather than `docState.canUndo`, or they
   * would sit greyed out with a selection change waiting to be undone.
   */
  const canUndoAnything = $derived(
    undoTarget(selectionTimeline, docState?.undoDepth ?? 0, docState?.canUndo === true) !== "none",
  );
  const canRedoAnything = $derived(
    redoTarget(selectionTimeline, docState?.undoDepth ?? 0, docState?.canRedo === true) !== "none",
  );

  /**
   * Whether the selection is exactly one block.
   *
   * What the inspector is gated on: it describes *a* block, and a region is not
   * one. A plain click sets the selection to the block it hit, so the ordinary
   * way of asking still works -- what stops is the panel lingering with a stale
   * subject after a sweep.
   */
  const singleBlockSelection = $derived(
    selection !== null &&
      selection.minX === selection.maxX &&
      selection.minY === selection.maxY &&
      selection.minZ === selection.maxZ,
  );

  /** The last block clicked, and where — the inspector's subject. */
  let inspection = $state<BlockInspection | null>(null);
  let inspectedAt = $state<{ x: number; y: number; z: number } | null>(null);

  /**
   * Not persisted, deliberately: launching into flight with the pointer not yet
   * captured is a confusing place to start, and the mode is one click away.
   */
  let cameraMode = $state<CameraMode>("orbit");

  /**
   * What is in your hand: the active hotbar slot, in both camera modes.
   *
   * There used to be two answers — a `activeBlock` for orbit and the hotbar for
   * flight — with a `$derived` picking between them by camera mode. That was
   * only tenable while the hotbar was creative-only. It is on screen in both
   * modes now, and two controls each claiming to say what you are holding is
   * one too many: Fill would write one block and a click would place another,
   * with nothing on screen to say why.
   *
   * So the slot is the value. Everything that chooses a block — the inventory,
   * the field in the selection tools, the middle button — writes the slot.
   */
  /**
   * Mirrored locally, like the sidebar's width and the tool windows' positions.
   *
   * Persisting is a round trip through main and a write to disk, and the block
   * field emits on every keystroke — so writing straight through meant sixteen
   * saves to type `minecraft:stone`, with the field's own value liable to jump
   * backwards as an earlier response landed after a later one. The mirror is
   * what is on screen; the write follows behind.
   */
  let hotbar = $state<string[]>([...DEFAULT_UI_SETTINGS.hotbar]);
  let hotbarSlot = $state(DEFAULT_UI_SETTINGS.hotbarSlot);

  const activeBlock = $derived(hotbar[hotbarSlot] ?? "minecraft:stone");
  const placingBlock = $derived(activeBlock);

  /** The pending persist, so a burst of keystrokes costs one write. */
  let hotbarWrite: ReturnType<typeof setTimeout> | null = null;

  /**
   * How long a burst is allowed to be. Long enough that typing a block name is
   * one write, short enough to be on disk before anyone could close the window.
   */
  const HOTBAR_WRITE_DELAY = 400;

  function persistHotbar(): void {
    if (hotbarWrite !== null) clearTimeout(hotbarWrite);
    hotbarWrite = setTimeout(() => {
      hotbarWrite = null;
      void patchUi({ hotbar: [...hotbar], hotbarSlot });
    }, HOTBAR_WRITE_DELAY);
  }

  /** Reaches for a different slot. */
  function holdSlot(slot: number): void {
    hotbarSlot = slot;
    persistHotbar();
  }

  /**
   * Who the block list is answering for.
   *
   * The same overlay serves three questions -- what am I holding, what does
   * Fill write, what is Replace looking for -- because they are the same
   * question about the same nine hundred blocks. Only the destination differs,
   * and the header says which one is being asked.
   */
  let inventoryFor = $state<"hand" | "fill" | "replace">("hand");

  /**
   * The block Replace looks for.
   *
   * Lifted out of `SelectionTools` when the block list gained the ability to
   * fill it in: a value with two writers cannot live inside one of them.
   */
  let replaceBlock = $state("");

  /** Re-reads the version history. Cheap, and always after something wrote. */
  async function refreshVersions(): Promise<void> {
    if (!bridgeAvailable) return;
    try {
      documentVersions = await api().listDocumentVersions();
    } catch {
      // A list that could not be read is an empty list, not a banner: nothing
      // the user did has failed, and the schematic is untouched.
      documentVersions = [];
    }
  }

  /** Keeps a version of the document as it stands. */
  async function saveVersion(source: "generated" | "manual" | "opened", label: string): Promise<void> {
    if (!bridgeAvailable) return;
    try {
      documentVersions = await api().saveDocumentVersion({ source, label });
    } catch (err) {
      failed(err, t("task.savingVersion"));
    }
  }

  /**
   * Puts the schematic back to one of its versions.
   *
   * Confirmed in the panel rather than here, because the panel is where the row
   * being replaced is visible. Main snapshots what is being left before it
   * adopts the old one, so this is a fork and not a one-way door — which is
   * what makes a confirmation enough rather than a warning.
   */
  async function restoreVersion(id: string): Promise<void> {
    busy = true;
    try {
      const response = await api().restoreDocumentVersion(id);
      if (!response.ok) {
        status = { tone: "error", text: response.message };
        return;
      }
      docState = response.state;
      selection = null;
      anchor = null;
      inspection = null;
      inspectedAt = null;
      selectionTimeline = forgetTimeline();
      framingEpoch += 1;
      await refreshDocument();
      await refreshVersions();
      status = { tone: "ok", text: t("status.wentBack") };
    } catch (err) {
      failed(err, t("task.restoringVersion"));
    } finally {
      busy = false;
    }
  }

  async function deleteVersion(id: string): Promise<void> {
    if (!bridgeAvailable) return;
    try {
      documentVersions = await api().deleteDocumentVersion(id);
    } catch (err) {
      failed(err, t("task.deletingVersion"));
    }
  }

  /** Opens the block list for one of the three. */
  function browseBlocks(purpose: "hand" | "fill" | "replace"): void {
    inventoryFor = purpose;
    inventoryOpen = true;
  }

  /** Puts a block in the hand, which is to say into the active slot. */
  function holdBlock(block: string): void {
    hotbar = hotbar.map((id, at) => (at === hotbarSlot ? block : id));
    persistHotbar();
  }

  /**
   * The middle button, on a block: hold what it is made of.
   *
   * The viewer sends a coordinate because it has nothing else — the mesh is one
   * fused geometry and the palette lives in main — so the block id comes back
   * from the same `inspectBlock` the inspector uses. Its base name, not the
   * full state: picking a stair should hand you a stair, not one facing the way
   * that particular one happened to face.
   */
  async function onPickMaterial(at: { x: number; y: number; z: number }): Promise<void> {
    if (busy) return;
    try {
      const response = await api().inspectBlock(at.x, at.y, at.z);
      if (!response.ok || response.block === "minecraft:air") return;
      holdBlock(response.block.split("[")[0]);
    } catch (err) {
      failed(err, t("task.pickingBlock"));
    }
  }

  /**
   * The registry, for the block pickers to search — fetched once at startup.
   *
   * **`$state.raw`, for the reason spelled out on `legacyIndex` below**, which
   * is the line this one was missed beside. Plain `$state` on an array is a
   * deep proxy, so reading it inside a `$derived` registers a signal *per
   * entry* -- 1197 of them -- and every keystroke in a block field re-ran the
   * filter, rebuilt a keyed `{#each}` of up to that many rows, and ran the
   * update again.
   *
   * It stayed dormant here for a specific reason worth knowing, because the
   * reason expired: `placeableBlocks` used to be `null` for every flat
   * document, so `offered` was `blocks` itself and nothing allocated. Giving
   * flat documents a per-version block set turned that alias into a fresh
   * 1197-element array per keystroke, and woke it for every schematic rather
   * than only the legacy ones.
   *
   * Raw because nothing writes *into* it: it is fetched once and replaced or
   * not at all, which is the one thing `raw` is for.
   */
  let blockRegistry = $state.raw<string[]>([]);
  /**
   * The pre-Flattening block table, inverted once and then never again.
   *
   * Two jobs, both of which need it here: deciding which blocks a legacy
   * schematic may be offered, and naming the `ID:DATA` a legacy file will
   * really store. Main reads the file; the rule for inverting it is shared, so
   * both sides agree on the tie-break when several ids give one name.
   *
   * **The *index* is the state, not the table, and that is load-bearing.**
   * This began as `$state` holding the raw table with a `$derived` inverting
   * it, and that shape froze the app. Two things were wrong with it and only
   * one is obvious:
   *
   * - plain `$state` on an object is a *deep* proxy, so a 1,682-key lookup
   *   table became a signal per entry;
   * - `buildLegacyIndex` returns fresh `Map`s and a fresh `Set` every time it
   *   runs, and consumers compare those **by identity** -- `placeable` is a
   *   prop. So the pickers re-filtered, the keyed `{#each}` rebuilt, and the
   *   update ran again. Svelte aborts a loop like that, and it takes every
   *   effect in the window with it.
   *
   * The viewport went on drawing throughout, because its render loop is a
   * `requestAnimationFrame` chain that owes Svelte nothing -- so the app was
   * *navigable and completely dead*, which is exactly how it was reported.
   *
   * Building it at the fetch removes the class rather than making it unlikely:
   * one assignment, one object, and `.names` is the same `Set` forever. It only
   * ever bit a legacy document, because everywhere this is read `docEra` is
   * tested first and `&&` short-circuits.
   *
   * `$state.raw` because nothing writes *into* it. It is reference data that is
   * replaced or not at all, which is the one thing `raw` is for.
   */
  let legacyIndex = $state.raw<LegacyIndex | null>(null);
  /**
   * Which era the open document is in, derived rather than carried.
   *
   * `DocumentState` already has both facts this is a function of, so a third
   * field beside them would be a second copy of one answer.
   */
  const docEra = $derived(
    docState === null ? null : documentEra(docState.format, docState.dataVersion),
  );
  /**
   * The blocks this schematic can hold, or `null` for no restriction.
   *
   * Two tables, and which one answers is decided by the era rather than
   * merged: `legacy_blocks.json` enumerates the pre-Flattening set exactly and
   * `block_versions.json` is the flat era only, so each is authoritative
   * where the other says nothing. Asking both would be two answers to one
   * question.
   *
   * `null` means no restriction, and it is the answer in three cases that are
   * genuinely different and all end the same way: nothing is open, the legacy
   * table has not arrived yet -- an empty set would empty the inventory, which
   * reads as the app being broken rather than as a file being late -- and a
   * document that names no version at all, which is not a question either
   * table can be asked.
   */
  const placeableBlocks = $derived.by(() => {
    if (docState === null) return null;
    if (docEra === "legacy") return legacyIndex === null ? null : legacyIndex.names;
    return docState.dataVersion === null ? null : blocksIn(docState.dataVersion);
  });

  /**
   * The legacy table, but only when the open document is one.
   *
   * Separate from `legacyIndex`, which is always loaded: labelling a 1.21
   * schematic with pre-Flattening ids would be naming a number its file will
   * never contain.
   */
  const legacyForDoc = $derived(docEra === "legacy" ? legacyIndex : null);

  /**
   * Where in the day the viewport is, in Minecraft ticks.
   *
   * Mirrored from the setting rather than read from it, because the daylight
   * cycle advances it many times a second: writing that through `patchPreview`
   * would be a disk write per frame. The setting is the *starting* point and
   * what a fresh window opens on; this is what is on screen.
   */
  let clockTicks = $state(DEFAULT_PREVIEW_SETTINGS.timeOfDay);

  /** The pack's own sun and moon, or nulls until they have been read. */
  let skyTextures = $state<SkyTextures>({ sun: null, moon: null });

  /**
   * The daylight cycle, which is a timer and not an animation frame.
   *
   * `requestAnimationFrame` would be the obvious home and is the wrong one:
   * the viewport already has a render loop, and a second one running at the
   * display's rate would advance the clock at a different speed on a 144Hz
   * screen. A timer moves the sun in wall-clock time, which is what "sixty
   * game minutes per real second" means.
   */
  $effect(() => {
    if (!settings.preview.daylightCycle) return;
    const perSecond = (settings.preview.daylightSpeed / 1440) * 24000;
    const step = 100;
    const timer = setInterval(
      () => (clockTicks = (clockTicks + perSecond * (step / 1000)) % 24000),
      step,
    );
    return () => clearInterval(timer);
  });

  /** Recently opened schematics. Owned by main; re-read after every open. */
  let recentDocuments = $state<RecentDocument[]>([]);

  /**
   * What the app is doing before it can be used, and whether it still is.
   *
   * There was no startup phase, which was survivable until the block warm-up
   * arrived: it is seconds of the main process, and starting it lazily meant
   * starting it the moment a schematic opened — with every other IPC call
   * queued behind it, which is exactly what "the program freezes" was.
   */
  let startupSteps = $state<StartupStep[]>([]);
  let startingUp = $state(true);

  function step(id: string, state: StartupStep["state"], progress?: { done: number; total: number }): void {
    startupSteps = startupSteps.map((entry) =>
      entry.id === id ? { ...entry, state, ...(progress === undefined ? {} : { progress }) } : entry,
    );
  }

  /**
   * The open schematic's own version history.
   *
   * Refreshed from main rather than kept in step here, for the same reason the
   * chat log is: main owns the files, and a list the renderer maintained would
   * drift the first time a write failed.
   */
  let documentVersions = $state<DocumentVersion[]>([]);

  /**
   * What main's clipboard holds, as it last reported.
   *
   * Mirrored rather than asked for: the clipboard lives in main and outlives
   * the document, so the renderer only needs enough to enable Paste and say how
   * big the thing is. It starts null because at launch it genuinely is.
   */
  let clipboard = $state<ClipboardInfo | null>(null);

  /**
   * Bumped when the viewport starts showing a *different* structure, and only
   * then. The viewer frames the camera on a change and leaves it alone
   * otherwise, so an edit — or an undo — no longer throws the view back to
   * where it started.
   *
   * A counter rather than the file path: a path is `null` for a document that
   * has never been saved, and Save As changes it without changing what is on
   * screen.
   */
  let framingEpoch = $state(0);

  let dimensionsOpen = $state(false);
  let voidOpen = $state(false);
  let voidError = $state("");
  /**
   * What the empty cells are believed to hold, which is not the same question
   * as what empty space is *chosen* to be.
   *
   * The choice lands the moment it is picked -- that is what makes the
   * viewport show it -- so `docState.voidBlock` is the new block from then on
   * and could never say what a rewrite should convert *from*. This is the only
   * thing still holding the old one.
   *
   * A belief, and it can go stale: converting the cells some other way, from
   * the selection tools, does not reach it. Wrong, it costs a rewrite that
   * reports zero and says so -- which is why it is allowed to be a belief.
   */
  let voidFilledWith = $state("");
  /**
   * Every block the open document contains, air included.
   *
   * `DocumentState.palette` is the whole histogram and main rebuilds it on
   * every state push, so this is exact rather than a belief -- which is the
   * whole reason the empty-space button reads it. A schematic whose empty
   * space is *set* to barrier with its cells still air is indistinguishable,
   * from the setting, from one where the conversion already happened; it is
   * only distinguishable by looking.
   */
  const documentBlocks = $derived(
    docState === null
      ? new Set<string>()
      : blocksInDocument(docState.palette, docState.size, docState.blockCount),
  );
  let mcVersionOpen = $state(false);
  let mcVersionError = $state("");
  /**
   * Whether main has already refused this version change for destroying blocks.
   *
   * `dimensionsConfirm`'s shape: the count cannot be known until main has
   * looked at the palette, so the offer to go ahead can only exist after a
   * refusal. Cleared whenever the modal closes, so a fresh open never starts
   * on a button that agrees to something nobody has been told about.
   */
  let mcVersionConfirm = $state(false);
  let dimensionsError = $state("");
  /**
   * Whether main has already refused this resize for losing blocks.
   *
   * Held here rather than in the modal because it is a fact about the last
   * answer from main, and it is cleared whenever the request changes -- so
   * a confirmation cannot be carried over onto a different size than the
   * one it was given for.
   */
  let dimensionsConfirmable = $state(false);

  /**
   * Building from the crosshair. One block, one transaction — the same edit the
   * panel makes, so Ctrl+Z treats them alike.
   *
   * The block is turned to face the way the game would turn it, and lands
   * carrying the rest of its family's state -- `half`, `hinge`, `open` and
   * `powered` for a door, not `facing` alone. Those properties are on the block
   * whether or not anyone writes them; writing them is what puts them in the
   * inspector, where they can be changed.
   *
   * All of it is a default and not an instruction, which is why it goes *under*
   * whatever the held block already spelled out: `oak_stairs[facing=north]`
   * typed into the block field means north, wherever the camera is pointing.
   */
  async function onBuild(
    action: "place" | "break" | "use",
    at: { x: number; y: number; z: number },
    look: PlacementLook,
  ): Promise<void> {
    if (busy) return;
    const held = parseBlock(placingBlock);
    /*
     * Breaking writes the *void block*, which is air unless somebody chose
     * otherwise.
     *
     * The point of choosing otherwise: an underwater build wants water in
     * the cell a block came out of, because that is what the game would
     * leave there and what the file has to say for the paste to come out
     * right. Parsed like any other id, so `minecraft:water[level=0]` is a
     * thing somebody can type.
     */
    const block =
      action === "break"
        ? parseBlock(docState?.voidBlock || "minecraft:air")
        : {
            ...held,
            properties: {
              ...placementState(held.namespacedName, look),
              ...(held.properties ?? {}),
            },
          };
    const label =
      action === "break"
        ? t("task.breakingBlock")
        : action === "use"
          ? t("task.usingBlock")
          : t("task.placingBlock");
    /*
     * `"use"` is one verb meaning "open it, or place if it does not open",
     * and it carries exactly what a placement carries. Only main can tell the
     * two apart -- this half holds no schematic, so it does not know whether
     * the cell the crosshair found is a door -- and asking first would be a
     * round trip per click and a race with any edit in flight.
     *
     * The block travels either way, because the fall-through half of the verb
     * is a placement and needs it.
     */
    await runDocument(label, () =>
      api().applyEdit({
        kind: action === "use" ? "use" : "setBlock",
        x: at.x,
        y: at.y,
        z: at.z,
        block,
        // Only main can see what was clicked -- the renderer holds no schematic
        // -- so it needs the direction to look in. Two slabs meeting reads it,
        // and so does `use`: the block that might open is one step back along
        // this face from the cell a placement would fill.
        ...(look.against === null ? {} : { against: look.against }),
      }),
    );
  }

  /**
   * A drag across the build grid, meaning "select this footprint".
   *
   * The grid is the answer to an empty schematic having nothing to raycast: no
   * geometry meant no target, so neither a selection nor a placement could be
   * started at all. This is one block tall at the base, which is what a
   * footprint is -- drag the top face upwards afterwards to give it height.
   */
  function onGridSelect(region: RegionSpec): void {
    selection = region;
    anchor = null;
  }

  /** The selection as a plain value — `$state` proxies do not compare. */
  function selectionNow(): SelectionState {
    return {
      selection: selection === null ? null : { ...selection },
      anchor: anchor === null ? null : { ...anchor },
    };
  }

  function restoreSelection(state: SelectionState): void {
    restoringSelection = true;
    selection = state.selection === null ? null : { ...state.selection };
    anchor = state.anchor === null ? null : { ...state.anchor };
    lastSelection = state;
    // Cleared after the assignments rather than in an effect: the recorder
    // below runs synchronously off these writes.
    restoringSelection = false;
  }

  /**
   * A drag is one step, not one step per frame.
   *
   * The viewer reports the region continuously — that is what makes the box
   * feel attached to the pointer — so the boundary has to come from the gesture
   * itself. Between `start` and `end` nothing is recorded; on `end` the whole
   * movement goes on the stack as a single change.
   */
  function onSelectionGesture(phase: "start" | "end"): void {
    if (phase === "start") {
      gestureFrom = lastSelection;
      return;
    }
    const from = gestureFrom;
    gestureFrom = null;
    if (from === null) return;
    const now = selectionNow();
    selectionTimeline = recordSelection(selectionTimeline, docState?.undoDepth ?? 0, from, now);
    lastSelection = now;
  }

  /*
   * Every other way the selection changes, recorded in one place.
   *
   * An effect rather than a call at each site, because there are a dozen sites
   * — a click, a transform, a paste, Select all, Clear, closing the document —
   * and the one that gets forgotten is the one that breaks Ctrl+Z. The writes
   * are wrapped in `untrack` so recording does not re-trigger the effect that
   * did the recording.
   */
  $effect(() => {
    const now = selectionNow();
    untrack(() => {
      if (restoringSelection || gestureFrom !== null) {
        lastSelection = now;
        return;
      }
      selectionTimeline = recordSelection(
        selectionTimeline,
        docState?.undoDepth ?? 0,
        lastSelection,
        now,
      );
      lastSelection = now;
    });
  });

  /*
   * A block edit landed, or the document was replaced.
   *
   * Main owns those steps; all this does is keep the two stacks in the same
   * ordering and drop selection steps that belong to a future main has
   * discarded.
   */
  $effect(() => {
    const depth = docState?.undoDepth ?? null;
    untrack(() => {
      if (depth === null) {
        selectionTimeline = forgetTimeline();
        lastUndoDepth = 0;
        return;
      }
      if (depth > lastUndoDepth) {
        selectionTimeline = recordDocumentEdit(selectionTimeline, depth);
      }
      lastUndoDepth = depth;
    });
  });

  /**
   * Ctrl+Z, over both stacks.
   *
   * The selection comes back first while nothing has been built on top of it,
   * which is what "undo" means when the last thing you did was drag a box.
   */
  async function undoAnything(): Promise<void> {
    if (busy) return;
    const target = undoTarget(selectionTimeline, docState?.undoDepth ?? 0, docState?.canUndo === true);
    if (target === "document") {
      await runDocument(t("task.undoing"), () => api().undo());
      return;
    }
    if (target !== "selection") return;
    const taken = takeUndo(selectionTimeline);
    if (taken === null) return;
    selectionTimeline = taken.timeline;
    restoreSelection(taken.state);
  }

  async function redoAnything(): Promise<void> {
    if (busy) return;
    const target = redoTarget(selectionTimeline, docState?.undoDepth ?? 0, docState?.canRedo === true);
    if (target === "document") {
      await runDocument(t("task.redoing"), () => api().redo());
      return;
    }
    if (target !== "selection") return;
    const taken = takeRedo(selectionTimeline);
    if (taken === null) return;
    selectionTimeline = taken.timeline;
    restoreSelection(taken.state);
  }

  /**
   * A click on the build grid, meaning "put a block here".
   *
   * A press that never moved, rather than a one-cell selection: with nothing
   * built yet "click the floor" plainly means place, and requiring a one-cell
   * drag first would be a rule with nothing behind it.
   */
  async function onGridPlace(
    at: { x: number; y: number; z: number },
    look: PlacementLook,
  ): Promise<void> {
    if (busy || cameraMode !== "orbit") return;
    await onBuild("place", at, look);
  }

  /**
   * A mirror of main's log, not the log itself.
   *
   * Assigned wholesale from whatever main last returned. The one entry written
   * locally is the failure of the IPC call itself: if the bridge is gone, main
   * never saw the turn, and it must not look as though it had.
   */
  let chat = $state<ChatEntry[]>([]);
  /** Index into `chat` where the agent's memory begins; 0 draws no divider. */
  let rememberedFrom = $state(0);

  /**
   * The other conversations about this schematic, for the picker.
   *
   * Fetched when the picker opens rather than kept in step: main retitles and
   * reorders them as turns land, and a copy held here would go stale in ways
   * nothing would notice.
   */
  let conversations = $state<ConversationSummary[]>([]);
  let activeConversationId = $state("");
  /** Tool calls for the turn in flight, so the panel narrates rather than hangs. */
  /**
   * What the turn in flight is doing, folded from main's events.
   *
   * A mirror, not a record: main assembles the same array and hands back the
   * finished one on the chat entry, which this is then thrown away in favour
   * of. The fold lives in `trace.ts` beside the emitter, because the two have
   * to agree about what an append means and the surest way to make them agree
   * is to keep them in one file.
   */
  let liveTrace = $state<TraceItem[]>([]);
  /**
   * How many exchanges the agent is carrying, as main last reported. The
   * transcript itself lives there — this is only enough to tell the user
   * whether "make it taller" will be understood.
   */
  let remembered = $state(0);

  /**
   * The run Stop cancels, if any.
   *
   * Carries its kind because a message typed with nothing open goes to the
   * generator instead of the agent, and the two are stopped through different
   * channels. It used to hold only the agent's id, so a chat that was building
   * showed the Stop button — `busy` was true — with nothing behind it.
   *
   * This is also what decides whether the button is shown at all. `busy` is not
   * that question: switching conversations and restoring a checkpoint both set
   * it, and neither is something to stop.
   */
  let inFlight = $state<{ id: string; kind: "agent" | "build" } | null>(null);

  /**
   * The generation in flight, if any — which progress events belong to it.
   *
   * Separate from `inFlight` because it is set for a build from either place,
   * while only a build from the chat is stoppable there. `progress` events
   * arrive for previews too, so an id is the only way to tell them apart.
   */
  let buildRequestId = $state<string | null>(null);

  /**
   * Asks main to stop whichever run is going.
   *
   * Deliberately does not touch `chat` or `busy`: the request is still in
   * flight and will settle as a `cancelled` failure, which is the one place
   * that should report what happened. Ending the turn from here as well would
   * write the outcome twice.
   */
  async function stopAgent(): Promise<void> {
    const run = inFlight;
    if (run === null) return;
    if (run.kind === "agent") await api().cancelAgent(run.id);
    else await api().cancelGenerate(run.id);
  }

  /**
   * Throws away the visible log *and* the transcript behind it.
   *
   * Both, always: main forgets the conversation whenever the open document
   * changes, and a log left on screen after that would show the user exchanges
   * the agent can no longer refer to.
   */
  /**
   * Starts another conversation about the same schematic.
   *
   * The one on screen is kept, not thrown away -- it stays in the picker's list
   * and can be returned to. The name is what it always was because the button
   * is what it always was; what changed is that "new" stopped meaning "gone".
   */
  async function forgetConversation(): Promise<void> {
    chat = [];
    liveTrace = [];
    remembered = 0;
    rememberedFrom = 0;
    if (bridgeAvailable) {
      await api().resetAgentConversation();
      await refreshConversations();
    }
  }

  /** Unsaved work found from a session that ended badly. */
  let recovery = $state<RecoveryOffer | null>(null);

  /** A schematic is being dragged over the viewport. */
  let dropActive = $state(false);
  /**
   * `dragenter`/`dragleave` fire for every child element the pointer crosses,
   * so a plain boolean flickers off as soon as the cursor moves onto the
   * canvas. Counting enters against leaves is the usual fix.
   */
  let dragDepth = 0;

  const SCHEMATIC_EXTENSIONS = [".schem", ".schematic", ".litematic", ".mcfunction"];

  function isSchematicPath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return SCHEMATIC_EXTENSIONS.some((extension) => lower.endsWith(extension));
  }

  function onDragEnter(event: DragEvent): void {
    if (!bridgeAvailable) return;
    // The dragged file's *name* is not readable during a drag — only its type,
    // for privacy — so the highlight cannot promise the file is supported. It
    // says "you can drop here"; the drop itself says whether it worked.
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dragDepth += 1;
    dropActive = true;
  }

  function onDragOver(event: DragEvent): void {
    if (!dropActive) return;
    // Without this the browser refuses the drop and shows a "no entry" cursor.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  }

  function onDragLeave(): void {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropActive = false;
    }
  }

  async function onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    dragDepth = 0;
    dropActive = false;

    const file = event.dataTransfer?.files?.[0];
    if (!file) return;

    const filePath = api().pathForDroppedFile(file);
    if (!filePath) {
      status = { tone: "warn", text: t("status.notOnDisk", { name: file.name }) };
      return;
    }
    if (!isSchematicPath(filePath)) {
      status = {
        tone: "warn",
        text: t("status.notASchematic", { name: file.name }),
      };
      return;
    }
    await openDocumentAt(filePath);
  }

  async function resolveRecovery(restore: boolean): Promise<void> {
    const offer = recovery;
    // Dismissed first: whichever way this goes, the prompt is answered, and
    // leaving it up while the restore runs invites a second click.
    recovery = null;
    busy = true;
    try {
      const response = await api().resolveRecovery(restore);
      if (!response.ok) {
        status = { tone: "error", text: response.message };
        return;
      }
      docState = response.state;
      if (restore && response.state) {
        // Recovered work is a structure the camera has not seen either.
        framingEpoch += 1;
        liveTrace = [];
        remembered = 0;
        /*
         * The conversation comes back with it.
         *
         * This used to clear, on the reasoning that a crashed session's chat
         * did not survive it -- true when the transcript hung off the
         * `DocumentSession` and died with it. It is stored per file path now,
         * and a recovered document carries its original path, so the history is
         * on disk and this was throwing it away. The same file opened from the
         * recents came back with its chat, which is what made the difference
         * visible.
         */
        if (response.chat) adoptChat(response.chat);
        await refreshConversations();
        await refreshDocument();
        status = {
          tone: "ok",
          text: offer?.fileName
            ? t("status.recoveredNamed", { name: offer.fileName })
            : t("status.recovered"),
          detail: t("recovery.notOnDisk"),
        };
      }
    } catch (err) {
      failed(err, t("task.recovering"));
    } finally {
      busy = false;
    }
  }

  /**
   * The OpenCode model in use, when there is one. Everything below is UI
   * mirroring: `ipc/handlers.ts` applies the same two rules authoritatively,
   * because a renderer check is a courtesy, not a gate.
   */
  /**
   * The catalogue entry for the chosen model, when there is a catalogue.
   *
   * Used to gate the reference-image picker on whether the model reads
   * pictures. It used to be pushed up from `ProviderConfig` through an
   * `onmodelinfo` callback; now that the model picker lives in the chat and the
   * catalogue is shared, both readers derive it from the same place.
   */
  const openCodeModel = $derived<OpenCodeModelInfo | null>(
    findOpenCodeModel(settings.provider, settings.model),
  );

  const hasProviderKey = $derived(
    keyStatus?.keys.find((entry) => entry.provider === settings.provider)?.hasKey ?? false,
  );
  const blockedOnKey = $derived(
    settings.provider === "OpenCode"
      ? openCodeModelRequiresKey(openCodeModel ?? undefined) && !hasProviderKey
      : providerRequiresApiKey(settings.provider) && !hasProviderKey,
  );
  /** Text-only models: the picker is disabled rather than silently ignored. */
  const acceptsImages = $derived(openCodeModel === null || openCodeModel.imageInput !== "no");

  /**
   * Puts the chosen palette on `<html>`, where `app.css` can see it.
   *
   * `"system"` *removes* the attribute rather than setting a third value,
   * because there is no third palette: it hands the decision to the
   * `prefers-color-scheme` rule, which is the only thing that knows the answer.
   *
   * `$effect.pre` rather than `$effect`, and that is load-bearing. `Viewer`
   * reads these same custom properties back out with `getComputedStyle` to
   * colour the 3D scene, which CSS cannot reach. Pre-effects all flush before
   * regular ones, so the attribute is guaranteed to be in place before the
   * viewer looks; as a plain effect the two would race and the viewport would
   * trail the window by one theme change.
   */
  $effect.pre(() => {
    const root = document.documentElement;
    if (settings.ui.theme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", settings.ui.theme);
    }
  });

  /**
   * Puts the chosen language into force.
   *
   * `setLocale` writes the `$state` every `t()` reads, so this re-renders every
   * string in the window rather than needing a reload. `lang` goes on `<html>`
   * beside it for the things CSS and the OS read rather than us: hyphenation,
   * spellcheck dictionaries, and what a screen reader pronounces.
   */
  $effect.pre(() => {
    setLocale(settings.ui.language);
    document.documentElement.setAttribute("lang", settings.ui.language);
  });

  onMount(() => {
    // Registered before the bridge check on purpose: collapsing the panel is
    // pure UI, and a window whose preload failed to load is exactly the one
    // where reaching the whole viewport still matters.
    window.addEventListener("keydown", onWindowKey);

    // The OS preference is a live thing -- a desktop on a sunset schedule
    // changes it under a running window -- so it is watched, not sampled once.
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    systemDark = dark.matches;
    const onSystemTheme = (event: MediaQueryListEvent) => (systemDark = event.matches);
    dark.addEventListener("change", onSystemTheme);

    if (!bridgeAvailable) {
      status = { tone: "error", text: bridgeMissingMessage() };
      return () => {
        window.removeEventListener("keydown", onWindowKey);
        dark.removeEventListener("change", onSystemTheme);
      };
    }

    /*
     * Telling main when the keyboard stops belonging to it.
     *
     * `document.pointerLockElement` is the truth and this window can read it
     * whenever it likes -- `onWindowKey` does exactly that. Main cannot, and
     * the File menu's accelerators are taken before this window sees the
     * keystroke, so Ctrl+W is the menu's whatever the camera is doing with it.
     * Hence a report rather than a shared state: it is the only way the menu
     * can be told to let go.
     *
     * Sent once on mount as well as on every change, because main's flag
     * outlives this component: a reload in dev leaves it holding whatever the
     * previous instance last said.
     */
    const onPointerLock = () => {
      void api().reportPointerLock(document.pointerLockElement !== null);
    };
    document.addEventListener("pointerlockchange", onPointerLock);
    onPointerLock();

    /*
     * Startup, in named steps.
     *
     * The order is not decoration: the block models come last of the slow
     * ones because everything above them is needed to draw a window at all,
     * and they are the only step long enough that finishing without them
     * would be a lie. Nothing here can fail in a way worth stopping for — a
     * settings read that throws leaves the defaults, and the app is more
     * useful up than not.
     */
    startupSteps = [
      { id: "settings", label: t("startup.settings"), state: "pending" },
      { id: "catalogue", label: t("startup.catalogue"), state: "pending" },
      { id: "models", label: t("startup.models"), state: "pending" },
      { id: "recent", label: t("startup.recent"), state: "pending" },
    ];

    void (async () => {
      try {
        step("settings", "running");
        settings = await api().getSettings();
        sidebarWidth = settings.ui.sidebarWidth;
        sidebarCollapsed = settings.ui.sidebarCollapsed;
        toolWindowX = settings.ui.toolWindowX;
        toolWindowY = settings.ui.toolWindowY;
        toolWindowW = settings.ui.toolWindowW;
        toolWindowH = settings.ui.toolWindowH;
        inspectorWindowX = settings.ui.inspectorWindowX;
        inspectorWindowY = settings.ui.inspectorWindowY;
        inspectorWindowW = settings.ui.inspectorWindowW;
        inspectorWindowH = settings.ui.inspectorWindowH;
        clockTicks = settings.preview.timeOfDay;
        hotbar = [...settings.ui.hotbar];
        hotbarSlot = settings.ui.hotbarSlot;
        keyStatus = await api().getKeyStatus();
        step("settings", "done");

        step("catalogue", "running");
        versions = await api().listVersions();
        artifacts = await api().listArtifacts();
        defaultOutputDir = await api().getDefaultOutputDir();
        blockRegistry = await api().listBlocks();
        legacyIndex = buildLegacyIndex(await api().listLegacyBlocks());
        step("catalogue", "done");

        /*
         * The slow one, and the reason this screen exists. Awaited here so it
         * is over before anything can be opened -- lazily, it started the
         * moment a schematic did, and held the process for the whole of it.
         */
        step("models", "running", { done: 0, total: blockRegistry.length * 2 });
        await primeBlockIcons();
        step("models", "done");

        step("recent", "running");
        recentDocuments = await api().listRecentDocuments();
        // The sun and the moon, out of the pack. Read once: they never change
        // while the app is open, and a pack that ships neither is a sky of
        // plain squares rather than an error.
        skyTextures = await api().getSkyTextures();
        // And the wooden axe the anchor marker is drawn with, for the same
        // reason and out of the same pack.
        anchorTexture = await api().getAnchorTexture();
        // Asked once, at startup, before the user has done anything they could
        // lose by answering it.
        const found = await api().peekRecovery();
        if (found.ok) {
          recovery = found.recovery;
        }
        step("recent", "done");
      } catch (err) {
        // Up with less is better than not up: the steps that did finish stand,
        // and whatever failed will fail again where it is asked for, with a
        // message about what it was.
        status = { tone: "error", text: err instanceof Error ? err.message : String(err) };
      } finally {
        startingUp = false;
      }
    })();

    const unsubscribe = api().onProgress((event) => {
      progress = event.phase === "done" ? null : event;
    });
    const unsubscribeStartup = api().onStartupProgress((event) => {
      step("models", "running", event);
    });
    const unsubscribeTrace = api().onAgentTrace((event) => {
      // Every run in flight sends on one channel; a reply from a run this
      // window has already finished with would otherwise reopen its panel.
      if (event.requestId !== inFlight?.id) return;
      liveTrace = applyTraceEvent(liveTrace, event);
    });
    /*
     * Somebody outside this window edited the document.
     *
     * The MCP server acts on the same session the viewport is drawing, and it
     * is the only thing that can move the document without this window having
     * asked — so every other path to a `DocumentState` arrives as the return
     * value of an invoke and this one arrives here.
     *
     * `refreshDocument` reads `docState`, so the assignment has to land first;
     * it also handles the `null` case by clearing the mesh, which is what
     * makes closing from outside the window work.
     */
    const unsubscribeMcp = api().onMcpStatusChanged((next) => {
      mcpStatus = next;
      void refreshMcpActivity();
    });
    void (async () => {
      try {
        mcpStatus = await api().getMcpStatus();
      } catch {
        // Leaving it null reads as "starting", which is the honest answer to a
        // question that has not come back -- see `dotFor`.
      }
    })();
    const unsubscribeDocument = api().onDocumentChanged((state) => {
      docState = state;
      void refreshDocument();
    });
    /*
     * The application menu, one subscription per verb.
     *
     * The menu is main's because the accelerators are: a key claimed by a
     * `Menu` never reaches this window, so Ctrl+N, Ctrl+O, Ctrl+S,
     * Ctrl+Shift+S and Ctrl+W are no longer handled in `onWindowKey` — they
     * arrive here instead. Undo and redo deliberately have no accelerator in
     * the menu and stay on the keyboard handler, where they can ask whether
     * the caret is in a text field.
     *
     * Every one of these lands on the same function the buttons call, so the
     * confirmations and the Save-As fallthrough come along for free.
     */
    const unsubscribeMenu = [
      api().onMenuNew(() => void startNewDocument()),
      api().onMenuOpen(() => void openDocument()),
      api().onMenuOpenRecent((filePath) => void openDocumentAt(filePath)),
      api().onMenuSave(() => {
        if (docState !== null && !busy) void saveDocument();
      }),
      api().onMenuSaveAs(() => {
        if (docState !== null && !busy) saveDocumentAs();
      }),
      api().onMenuClose(() => void closeDocument()),
      api().onMenuUndo(() => void undoAnything()),
      api().onMenuRedo(() => void redoAnything()),
      api().onMenuAbout(() => {
        aboutOpen = true;
        if (appInfo === null) void loadAppInfo();
      }),
    ];

    return () => {
      window.removeEventListener("keydown", onWindowKey);
      document.removeEventListener("pointerlockchange", onPointerLock);
      dark.removeEventListener("change", onSystemTheme);
      unsubscribe();
      unsubscribeStartup();
      unsubscribeTrace();
      unsubscribeDocument();
      unsubscribeMcp();
      for (const off of unsubscribeMenu) off();
    };
  });

  function onWindowKey(event: KeyboardEvent): void {
    /*
     * With the pointer locked, Ctrl belongs to the camera and to nothing else.
     *
     * In flight Ctrl is the sprint modifier and WASD is the direction, so every
     * Ctrl+letter this window binds is also a way of moving: Ctrl+A selected
     * the whole schematic while strafing left, and Ctrl+W -- the File menu's
     * Close Schematic -- closed it while running forwards. The menu half of
     * that is fixed where it has to be, in main (`IPC.pointerLock`); this is
     * the window's half.
     *
     * Blanket, and first in the function, which are the same decision twice.
     * An allowlist would have to be re-judged against the movement keys every
     * time a shortcut was added, by whoever added it; and a gate further down
     * would be a rule anything written above it silently escapes. Escape is the
     * way back: it releases the lock, and every shortcut here works again.
     *
     * Unmodified keys are untouched. `E` opens the inventory in flight because
     * that is where you want it, exactly as the game binds it.
     */
    if ((event.ctrlKey || event.metaKey) && document.pointerLockElement !== null) {
      return;
    }
    /*
     * `E` opens the inventory, unmodified, the way the game binds it.
     *
     * Before the modifier gate below, which every other shortcut here is behind
     * -- and behind `isTyping`, because a window listener sees the `e` in
     * "stone" typed into the chat. That guard is the whole reason single-key
     * shortcuts are safe to add at all.
     */
    if (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key.toLowerCase() === "e" &&
      !isTyping(event.target) &&
      docState !== null &&
      !settingsOpen &&
      !paletteOpen &&
      schematicDialog === null
    ) {
      event.preventDefault();
      // `E` always asks about the hand; the tools' fields ask for themselves.
      inventoryFor = "hand";
      inventoryOpen = !inventoryOpen;
      return;
    }
    /*
     * Escape drops the selection, and Delete empties it.
     *
     * Unmodified, like `E`, so both are behind the same two guards: not while
     * typing, and not while something modal is up -- Escape belongs to whatever
     * is on top of the viewport, and a dialog that closed *and* cleared the
     * selection would be one keystroke doing two jobs.
     */
    if (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !isTyping(event.target) &&
      !settingsOpen &&
      !paletteOpen &&
      !inventoryOpen &&
      schematicDialog === null
    ) {
      if (event.key === "Escape" && moving !== null) {
        // A move in flight is what Escape means first: it is the thing on
        // screen that is mid-gesture, and cancelling it must not also throw
        // away the selection it was going to land on.
        event.preventDefault();
        cancelMove();
        return;
      }
      if (event.key === "Escape" && selection !== null) {
        event.preventDefault();
        clearSelection();
        return;
      }
      if (event.key === "Delete" && docState !== null && !busy && selection !== null) {
        event.preventDefault();
        void deleteSelection();
        return;
      }
    }
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }
    const key = event.key.toLowerCase();
    // Ctrl+K and Ctrl+Shift+P, the two everyone reaches for. Handled before the
    // "is a document open" gate below, because the palette is also how you open
    // one — and toggling, so the same keystroke closes it again.
    if (key === "k" || (key === "p" && event.shiftKey)) {
      event.preventDefault();
      togglePalette();
      return;
    }
    // Anything else typed into the palette belongs to the palette.
    if (paletteOpen) {
      return;
    }
    if (key === "b") {
      event.preventDefault();
      toggleSidebar();
      return;
    }
    // Ctrl+, is what every editor binds settings to.
    if (event.key === ",") {
      event.preventDefault();
      settingsOpen = !settingsOpen;
      return;
    }
    // The document shortcuts only exist while a document does, and never while
    // something else is already running -- an undo racing an edit would apply
    // to a state neither of them saw.
    if (docState === null || busy) {
      return;
    }
    /*
     * Undo and redo belong to whatever has the caret.
     *
     * Without this, Ctrl+Z with the cursor in the chat box undid a *block edit*
     * instead of the half-typed sentence -- and the sentence was still there,
     * so nothing looked like it had happened until you went back to the
     * viewport. `isTyping` was already guarding `E` for the same reason: a
     * window listener sees the "e" in "stone".
     *
     * Save is deliberately not guarded. Ctrl+S while typing means save the
     * document; no text field in this app claims that key.
     */
    const editingText = isTyping(event.target);
    if (key === "z" && !event.shiftKey && !editingText) {
      event.preventDefault();
      void undoAnything();
      return;
    }
    if ((key === "y" || (key === "z" && event.shiftKey)) && !editingText) {
      event.preventDefault();
      void redoAnything();
      return;
    }
    /*
     * The clipboard keys, which mean the *region* only when nothing else has a
     * claim on them.
     *
     * `isTyping` is not enough for these. The chat log is not a text field, so
     * highlighting a block id in a reply and pressing Ctrl+C would pass that
     * guard and quietly copy a region of the schematic instead of the text the
     * user had just highlighted -- with the highlight still on screen, saying
     * it had worked.
     */
    if (editingText || hasTextSelection()) {
      return;
    }
    if (key === "a") {
      event.preventDefault();
      selectAll();
      return;
    }
    if (key === "c" && selection !== null) {
      event.preventDefault();
      void copySelection(false);
      return;
    }
    if (key === "x" && selection !== null) {
      event.preventDefault();
      void copySelection(true);
      return;
    }
    if (key === "v" && selection !== null && clipboard !== null) {
      event.preventDefault();
      void pasteHere();
      return;
    }
    /*
     * No Ctrl+S here any more, and none of the other file keys either.
     *
     * The File menu declares them as accelerators, and an accelerator is
     * claimed by Electron before this window sees the keystroke — so a branch
     * here would simply never run, and anyone reading it would believe it did.
     */
  }

  let paletteOpen = $state(false);
  let settingsOpen = $state(false);

  /*
   * The MCP server, as main reports it.
   *
   * Kept apart from `settings.mcp.enabled` on purpose: that is what the user
   * asked for and this is what is actually listening. They disagree when a port
   * is already taken, which is exactly the case the indicator has to be able to
   * show. `mcp_status.ts` holds the rule.
   */
  let mcpStatus = $state<McpStatus | null>(null);
  let mcpActivity = $state<McpActivity[]>([]);
  /** Which pane the gear opens on. Set by the indicator, cleared by the modal. */
  let settingsCategory = $state<"mcp" | null>(null);

  async function refreshMcpActivity(): Promise<void> {
    // Only while the pane that shows it is open: it is a hundred rows fetched
    // over IPC, and nothing else in the window reads them.
    if (!settingsOpen) return;
    try {
      mcpActivity = await api().getMcpActivity();
    } catch {
      // A log that cannot be read is not worth a banner over.
    }
  }

  async function setMcpEnabled(enabled: boolean): Promise<void> {
    busy = true;
    try {
      mcpStatus = await api().setMcpEnabled(enabled);
      // The checkbox reads from `settings`, which main has just written, so the
      // local copy has to catch up or it would spring back on the next paint.
      settings = { ...settings, mcp: { ...settings.mcp, enabled } };
      if (mcpStatus.state === "error" && mcpStatus.message !== null) {
        status = { tone: "error", text: mcpStatus.message };
      }
    } catch (err) {
      failed(err, t("mcp.title"));
    } finally {
      busy = false;
    }
  }

  async function regenerateMcpToken(): Promise<void> {
    busy = true;
    try {
      mcpStatus = await api().regenerateMcpToken();
    } catch (err) {
      failed(err, t("mcp.title"));
    } finally {
      busy = false;
    }
  }

  function openMcpSettings(): void {
    settingsCategory = "mcp";
    settingsOpen = true;
    void refreshMcpActivity();
  }


  /**
   * The schematic's own NBT, as text.
   *
   * The text is main's and is fetched once, when the panel opens — `nbtRevision`
   * is what it was read at, and goes back with an Apply so an edit built against
   * a stale read is refused rather than putting an old entity list back over an
   * undo that happened underneath it.
   */
  /**
   * WorldEdit's paste anchor.
   *
   * The *cell* comes from `docState.worldOrigin`'s neighbour, `docState.offset`,
   * negated — but the negation is main's, so this only ever holds what main
   * hands over. `anchorTexture` is the wooden axe, fetched once: it is a
   * property of the resource pack, not of the document.
   */
  let anchorOpen = $state(false);
  let anchorError = $state("");
  let anchorTexture = $state<PackTexture | null>(null);

  let nbtOpen = $state(false);
  let nbtText = $state("");
  let nbtEditable = $state(true);
  let nbtOmitted = $state<string[]>([]);
  let nbtRevision = $state(0);
  let nbtError = $state("");
  /**
   * The half-written chat message.
   *
   * Up here rather than in the composer because that is where the rest of the
   * conversation's state lives. It began as a defence against a tab switch
   * unmounting the composer mid-sentence; the tabs are gone and the ownership
   * is still right.
   */
  let chatDraft = $state("");

  /**
   * Whether the floating tool window is showing.
   *
   * Not persisted, and closing it is not permanent: it comes back with the next
   * selection. A tool palette you can dismiss for good is one a user can lose,
   * and the command palette is a poor place to have to go looking for it.
   */
  let toolsOpen = $state(true);

  /** Mirrored locally so a drag repaints at pointer speed, like the sidebar. */
  let toolWindowX = $state(DEFAULT_UI_SETTINGS.toolWindowX);
  let toolWindowY = $state(DEFAULT_UI_SETTINGS.toolWindowY);
  let toolWindowW = $state(DEFAULT_UI_SETTINGS.toolWindowW);
  let toolWindowH = $state(DEFAULT_UI_SETTINGS.toolWindowH);

  /**
   * The inspector, which used to be the sidebar's third tab.
   *
   * Same arrangement as the tools: closing it means "not now", and clicking a
   * block brings it back. That is what stops a closed panel from being one the
   * user has lost; it is reachable from Ctrl+K as well.
   */
  let inspectorOpen = $state(true);
  let inspectorWindowX = $state(DEFAULT_UI_SETTINGS.inspectorWindowX);
  let inspectorWindowY = $state(DEFAULT_UI_SETTINGS.inspectorWindowY);
  let inspectorWindowW = $state(DEFAULT_UI_SETTINGS.inspectorWindowW);
  let inspectorWindowH = $state(DEFAULT_UI_SETTINGS.inspectorWindowH);

  /**
   * The version history, which used to be the first thing in the Generate tab.
   *
   * One difference from the other two floating windows: nothing summons it. A
   * selection brings back the tools and a click brings back the inspector, so
   * both can default to open without ever being in the way. This one is asked
   * for -- from the button in the document bar, or from Ctrl+K -- so it starts
   * closed.
   */
  let versionsOpen = $state(false);

  /**
   * The About box, and the facts it shows.
   *
   * Opened only from Help → About, which is main's menu, so there is no
   * button and no palette entry to keep in step with it.
   *
   * `appInfo` is fetched on first open rather than at mount: it never
   * changes, nothing else reads it, and asking for it at startup would put
   * one more round trip in front of the first paint for a panel most
   * sessions never open.
   */
  let aboutOpen = $state(false);
  let appInfo = $state<AppInfo | null>(null);

  async function loadAppInfo(): Promise<void> {
    try {
      appInfo = await api().getAppInfo();
    } catch {
      // The box is worth showing without it: the name, the licence and the
      // credits do not depend on main having answered, and the two rows
      // that do already draw a dash while `appInfo` is null.
    }
  }

  /**
   * Whether the start screen has been put away for now.
   *
   * It blocks the window, so it must be dismissable: with nothing open a chat
   * message goes to the *generator*, and a screen covering the chat that could
   * not be closed would delete the path it exists to advertise.
   */
  let startDismissed = $state(false);

  /**
   * `recovery` keeps precedence, as it always did -- that one is a question
   * about work that may be lost, and it must not be behind anything.
   */
  const startVisible = $derived(docState === null && recovery === null && !startDismissed);

  /**
   * Fetches OpenCode's model list when the provider calls for it.
   *
   * Lives here rather than in the picker because the answer can rewrite
   * `settings.model` -- when the stored model is not in the list, the port's
   * behaviour (component.py:251-255) is to fall back to `mimo-v2.5-free` -- and
   * the settings belong to this component.
   */
  $effect(() => {
    loadOpenCodeModels(settings.provider, settings.model, (model) => {
      void patchSettings({ model });
    });
  });

  function togglePalette(): void {
    const next = !paletteOpen;
    /*
     * A locked pointer means the keys the user is about to type are also
     * steering the camera, so the lock goes before the palette opens.
     *
     * Ctrl+K cannot reach here while the lock is held any more -- `onWindowKey`
     * declines everything Ctrl-modified for as long as it is, so from flight
     * the palette is Escape and then Ctrl+K. This stays because it costs
     * nothing and it is what any other way in would need: the modals all do the
     * same, and the palette is the one that would be typed into.
     */
    if (next && document.pointerLockElement) {
      document.exitPointerLock();
    }
    paletteOpen = next;
  }

  /**
   * Everything the app can do, by name.
   *
   * Built here rather than inside the palette so each entry calls the same
   * function its button does — the palette cannot offer an action the UI has
   * stopped having, and `enabled` is derived from the same state that greys the
   * buttons out.
   */
  const commands = $derived<Command[]>([
    {
      id: "new",
      title: t("command.new"),
      group: t("group.file"),
      keywords: t("command.new.keywords"),
      enabled: !busy,
      run: () => void startNewDocument(),
    },
    {
      id: "open",
      title: t("command.open"),
      group: t("group.file"),
      keywords: t("command.open.keywords"),
      enabled: !busy,
      run: () => void openDocument(),
    },
    ...recentDocuments.slice(0, 5).map(({ filePath }) => ({
      id: `recent:${filePath}`,
      title: t("command.openRecent", { name: filePath.split(/[\\/]/).pop() ?? filePath }),
      group: t("group.recent"),
      keywords: filePath,
      enabled: !busy,
      run: () => void openDocumentAt(filePath),
    })),
    {
      id: "save",
      title: t("command.save"),
      group: t("group.file"),
      shortcut: "Ctrl+S",
      enabled: !busy && docState !== null,
      run: () => void saveDocument(),
    },
    {
      id: "save-as",
      title: t("command.saveAs"),
      group: t("group.file"),
      keywords: t("command.saveAs.keywords"),
      enabled: !busy && docState !== null,
      run: () => void saveDocumentAs(),
    },
    {
      id: "close",
      title: t("command.close"),
      group: t("group.file"),
      keywords: t("command.close.keywords"),
      shortcut: "Ctrl+W",
      enabled: !busy && docState !== null,
      run: () => void closeDocument(),
    },
    {
      id: "undo",
      title: t("command.undo"),
      group: t("group.edit"),
      shortcut: "Ctrl+Z",
      enabled: !busy && canUndoAnything,
      run: () => void undoAnything(),
    },
    {
      id: "redo",
      title: t("command.redo"),
      group: t("group.edit"),
      shortcut: "Ctrl+Y",
      enabled: !busy && canRedoAnything,
      run: () => void redoAnything(),
    },
    {
      id: "select-all",
      title: t("command.selectAll"),
      group: t("group.edit"),
      keywords: t("command.selectAll.keywords"),
      shortcut: "Ctrl+A",
      enabled: !busy && docState !== null,
      run: selectAll,
    },
    {
      id: "delete-blocks",
      title: t("command.deleteBlocks"),
      group: t("group.edit"),
      keywords: t("command.deleteBlocks.keywords"),
      shortcut: "Del",
      enabled: !busy && selection !== null,
      run: () => void deleteSelection(),
    },
    {
      id: "clear-selection",
      title: t("command.clearSelection"),
      group: t("group.edit"),
      keywords: t("command.clearSelection.keywords"),
      shortcut: "Esc",
      enabled: selection !== null,
      run: clearSelection,
    },
    {
      id: "copy",
      title: t("command.copy"),
      group: t("group.edit"),
      shortcut: "Ctrl+C",
      enabled: !busy && selection !== null,
      run: () => void copySelection(false),
    },
    {
      id: "cut",
      title: t("command.cut"),
      group: t("group.edit"),
      shortcut: "Ctrl+X",
      enabled: !busy && selection !== null,
      run: () => void copySelection(true),
    },
    {
      id: "paste",
      title: t("command.paste"),
      group: t("group.edit"),
      shortcut: "Ctrl+V",
      enabled: !busy && clipboard !== null && selection !== null,
      run: pasteHere,
    },
    {
      id: "rotate-90",
      title: t("command.rotate90"),
      group: t("group.edit"),
      keywords: t("command.rotate90.keywords"),
      enabled: !busy && selection !== null,
      run: () => void transformSelection({ kind: "rotate", steps: 1 }),
    },
    {
      id: "rotate-180",
      title: t("command.rotate180"),
      group: t("group.edit"),
      keywords: t("command.rotate180.keywords"),
      enabled: !busy && selection !== null,
      run: () => void transformSelection({ kind: "rotate", steps: 2 }),
    },
    {
      id: "mirror-x",
      title: t("command.mirrorX"),
      group: t("group.edit"),
      keywords: t("command.mirrorX.keywords"),
      enabled: !busy && selection !== null,
      run: () => void transformSelection({ kind: "mirror", axis: "x" }),
    },
    {
      id: "mirror-z",
      title: t("command.mirrorZ"),
      group: t("group.edit"),
      keywords: t("command.mirrorZ.keywords"),
      enabled: !busy && selection !== null,
      run: () => void transformSelection({ kind: "mirror", axis: "z" }),
    },
    {
      id: "camera-orbit",
      title: t("command.cameraOrbit"),
      group: t("group.view"),
      keywords: t("command.cameraOrbit.keywords"),
      enabled: cameraMode !== "orbit",
      run: () => (cameraMode = "orbit"),
    },
    {
      id: "camera-fly",
      title: t("command.cameraFly"),
      group: t("group.view"),
      keywords: t("command.cameraFly.keywords"),
      enabled: cameraMode !== "fly",
      run: () => (cameraMode = "fly"),
    },
    {
      id: "toggle-grid",
      title: settings.preview.showGrid ? t("command.hideGrid") : t("command.showGrid"),
      group: t("group.view"),
      enabled: true,
      run: () => void patchPreview({ showGrid: !settings.preview.showGrid }),
    },
    {
      id: "toggle-wireframe",
      title: settings.preview.wireframe ? t("command.wireframeOff") : t("command.wireframeOn"),
      group: t("group.view"),
      enabled: true,
      run: () => void patchPreview({ wireframe: !settings.preview.wireframe }),
    },
    {
      id: "toggle-tools",
      title: toolsOpen ? t("command.hideTools") : t("command.showTools"),
      group: t("group.view"),
      keywords: t("command.showTools.keywords"),
      enabled: docState !== null,
      run: () => (toolsOpen = !toolsOpen),
    },
    {
      id: "toggle-inspector",
      title: inspectorOpen ? t("command.hideInspector") : t("command.showInspector"),
      group: t("group.view"),
      keywords: t("command.showInspector.keywords"),
      // Nothing to show until a block has been asked about, and offering to
      // reveal an empty panel is how a command reads as broken.
      enabled: inspection !== null && singleBlockSelection,
      run: () => (inspectorOpen = !inspectorOpen),
    },
    {
      id: "toggle-versions",
      title: versionsOpen ? t("command.hideVersions") : t("command.showVersions"),
      group: t("group.view"),
      keywords: t("command.showVersions.keywords"),
      enabled: docState !== null,
      run: () => (versionsOpen = !versionsOpen),
    },
    {
      id: "show-start",
      title: t("start.reopen"),
      group: t("group.view"),
      keywords: t("start.reopen.keywords"),
      // Only when it is dismissable and dismissed: it blocks the window, so
      // offering to summon one already on screen would be a command that does
      // nothing, and offering it over a document would take the document away.
      enabled: docState === null && startDismissed,
      run: () => (startDismissed = false),
    },
    {
      id: "settings",
      title: t("settings.title"),
      group: t("group.view"),
      keywords: t("settings.keywords"),
      shortcut: "Ctrl+,",
      enabled: true,
      run: () => (settingsOpen = true),
    },
    {
      // The one way to find the MCP server before it has been switched on --
      // the indicator only appears once it is, so without this the feature is
      // discoverable by scrolling the settings rail and no other way.
      id: "mcp",
      title: t("mcp.title"),
      group: t("group.view"),
      keywords: t("mcp.keywords"),
      enabled: true,
      run: openMcpSettings,
    },
    {
      id: "toggle-sidebar",
      title: sidebarCollapsed ? t("sidebar.show") : t("sidebar.hide"),
      group: t("group.view"),
      shortcut: "Ctrl+B",
      enabled: true,
      run: toggleSidebar,
    },
    {
      id: "new-chat",
      title: t("command.newChat"),
      group: t("group.ai"),
      keywords: t("command.newChat.keywords"),
      enabled: !busy && (chat.length > 0 || remembered > 0),
      run: () => void forgetConversation(),
    },
    {
      id: "stop-agent",
      title: t("command.stopAgent"),
      group: t("group.ai"),
      keywords: t("command.stopAgent.keywords"),
      enabled: inFlight !== null,
      run: () => void stopAgent(),
    },
  ]);

  function toggleSidebar(): void {
    sidebarCollapsed = !sidebarCollapsed;
    void patchUi({ sidebarCollapsed });
  }

  /**
   * Layout gestures must not depend on the settings write succeeding: the
   * panel has already moved on screen by the time this runs, and a failed
   * persist is worth a banner, not a stuck sidebar.
   */
  async function patchUi(patch: Partial<Settings["ui"]>): Promise<void> {
    try {
      await patchSettings({ ui: { ...settings.ui, ...patch } });
    } catch (err) {
      failed(err, t("task.savingLayout"));
    }
  }

  /** Persist on every change; the Python UI persisted nothing at all. */
  async function patchSettings(patch: Partial<Settings>): Promise<void> {
    settings = await api().setSettings(forIpc({ ...settings, ...patch }));
  }

  async function patchPreview(patch: Partial<PreviewSettings>): Promise<void> {
    // The clock on screen follows the setting when the setting is what moved
    // it; the daylight cycle writes only the mirror.
    if (patch.timeOfDay !== undefined) clockTicks = patch.timeOfDay;
    await patchSettings({ preview: { ...settings.preview, ...patch } });
    // Every other preview setting is applied by the viewer on the GLB it
    // already has. The two tints are baked into the texture atlas, so they are
    // the ones that need the mesh rebuilt.
    const rebuilds =
      patch.biomeColor !== undefined ||
      patch.waterColor !== undefined ||
      // Light and occlusion are baked into the vertices by the mesher, not
      // applied by the viewer -- which is the whole reason ambient occlusion
      // finally means occlusion.
      patch.blockLight !== undefined ||
      patch.ambientOcclusion !== undefined ||
      patch.smoothLighting !== undefined ||
      // The markers are turned back into air by the mesher, not hidden by the
      // viewer, so this one rebuilds too — see `hideMarkers`.
      patch.showMarkers !== undefined;
    if (!rebuilds || busy) return;
    // Whichever of the two is showing. Before this the tints only ever reached
    // the file-preview path, so changing one with a document open did nothing
    // at all — and it is the one setting pair that cannot be applied by the
    // viewer, because it is multiplied into the atlas.
    if (docState !== null) await refreshDocument();
  }

  /**
   * The nothing-open path: generate, then report into the log.
   *
   * `generateFrom` already raises its own banner for the file it wrote (and for
   * any blocks it had to drop), so this adds only what the conversation needs:
   * a line saying the build happened, or the reason it did not.
   */
  /**
   * A prompt with nothing open builds something, and that is a turn.
   *
   * Both entries are written by main, inside the `generate` handler, which is
   * why nothing is appended here. That is not tidiness: generating *opens* what
   * it made, and opening used to clear the renderer's log -- so the question
   * vanished and only the answer survived. Main's log is adopted by the new
   * document rather than cleared, and this reads it back afterwards.
   */
  async function buildFromChat(prompt: string): Promise<void> {
    chat = [...chat, { role: "user", text: prompt }];
    liveTrace = [];
    await generateFrom(prompt, true);
    if (bridgeAvailable) adoptChat(await api().getChatState());
  }

  /** Takes main's copy of the log as the truth. */
  function adoptChat(state: ChatState): void {
    chat = state.entries;
    rememberedFrom = state.rememberedFrom;
  }

  async function refreshConversations(): Promise<void> {
    if (!bridgeAvailable) return;
    const list = await api().listConversations();
    conversations = list.conversations;
    activeConversationId = list.activeId;
  }

  async function openConversation(id: string): Promise<void> {
    if (!bridgeAvailable) return;
    busy = true;
    try {
      adoptChat(await api().openConversation(id));
      liveTrace = [];
      await refreshConversations();
    } finally {
      busy = false;
    }
  }

  /**
   * Puts the schematic back to how it was before one of the turns.
   *
   * Confirmed first, and the confirmation says what it costs in the terms the
   * user can check: how many edits go, and how many of those were not the
   * agent's. Going back takes manual work with it -- that is what was asked
   * for, and it is not something to discover afterwards.
   */
  async function restoreCheckpoint(entryIndex: number): Promise<void> {
    if (!bridgeAvailable) return;
    busy = true;
    try {
      const response = await api().restoreCheckpoint(entryIndex);
      if (!response.ok) {
        status = { tone: "error", text: response.message };
        return;
      }
      docState = response.state;
      adoptChat(response.chat);
      liveTrace = [];
      remembered = 0;
      selection = null;
      anchor = null;
      inspection = null;
      inspectedAt = null;
      status = { tone: "ok", text: tn("status.restored", response.undoneEdits) };
      await refreshConversations();
      await refreshDocument();
    } catch (err) {
      failed(err, t("task.restoring"));
    } finally {
      busy = false;
    }
  }

  async function deleteConversation(id: string): Promise<void> {
    if (!bridgeAvailable) return;
    adoptChat(await api().deleteConversation(id));
    await refreshConversations();
  }

  async function saveKey(provider: Provider, apiKey: string): Promise<void> {
    keyStatus = await api().setKey({ provider, apiKey });
  }

  async function clearKey(provider: Provider): Promise<void> {
    keyStatus = await api().clearKey(provider);
  }

  const requestId = () => crypto.randomUUID();

  /**
   * Every `api().*` call below is wrapped. An `ipcRenderer.invoke` that
   * rejects -- a handler that threw before its own try/catch, a payload that
   * failed to structured-clone -- used to surface as an unhandled rejection
   * with `busy` cleared by `finally` and nothing at all shown, which reads as
   * "the button does nothing".
   */
  function failed(err: unknown, doing: string): void {
    // The `doing` prefix is not decoration. An `ipcRenderer.invoke` rejection
    // carries no channel and no argument -- "An object could not be cloned."
    // is the entire message -- so without naming the operation there is
    // nothing to act on.
    const message = err instanceof Error ? err.message : String(err);
    status = { tone: "error", text: t("status.failed", { doing, message }) };
  }

  async function pick(
    kind: "image" | "resource-pack" | "directory" | "mcp-root",
  ): Promise<void> {
    let picked: Awaited<ReturnType<ReturnType<typeof api>["pickFile"]>>;
    try {
      // The MCP root is a directory like the output folder; only what happens
      // to the answer differs.
      picked = await api().pickFile({ kind: kind === "mcp-root" ? "directory" : kind });
    } catch (err) {
      failed(err, t("task.openingPicker"));
      return;
    }
    if (picked.error) {
      // A rejected choice, not a cancellation — say so rather than looking
      // like the dialog did nothing.
      status = { tone: "error", text: picked.error };
      return;
    }
    if (!picked.path) return;
    if (kind === "image") {
      imagePath = picked.path;
      imageName = picked.name;
    } else if (kind === "resource-pack") {
      resourcePackPath = picked.path;
      resourcePackName = picked.name;
    } else if (kind === "mcp-root") {
      void patchSettings({ mcp: { ...settings.mcp, root: picked.path } });
    } else if (kind === "directory") {
      void patchSettings({ outputDir: picked.path });
    }
  }

  /*
   * There is no `renderPreview` here any more, and that is a deletion worth
   * naming rather than noticing.
   *
   * It drew a *file* without opening it, which is what the app did before a
   * generated schematic became a document: you got a picture of what had been
   * made and none of the editing tools could touch it. Generating opens its
   * result now, dropping a file opens it, and the start screen opens one --
   * so every route that used to end in a preview ends in a document, which can
   * do everything a preview could and more.
   *
   * `IPC.preview` and `services/preview.ts`'s `buildPreview` are therefore
   * left with no caller. They are still served and still tested; treat them
   * like `pipeline/gltf_builder.ts` -- delete them or grow the feature that
   * wants them, but do not leave them drifting unnamed.
   */

  // --- the open document ----------------------------------------------------

  /**
   * Redraws from whatever main last said.
   *
   * The mesh is fetched separately from the state because it is the expensive
   * half: main serves it from cache whenever `revision` has not moved, so
   * calling this after every edit costs nothing when nothing changed.
   */
  /**
   * What the viewport is currently drawing, so main can answer with the
   * difference.
   *
   * Both are "I hold this", never "send me this". Cleared whenever the mesh is
   * taken down, because after that the window holds nothing and a token
   * claiming otherwise would be answered with a delta against geometry that is
   * no longer on screen.
   */
  let meshToken = $state<string | null>(null);
  let heldAtlas = $state<number | null>(null);

  async function refreshDocument(): Promise<void> {
    if (docState === null) {
      mesh = null;
      bounds = null;
      meshToken = null;
      return;
    }
    const response = await api().getDocumentMesh({
      settings: forIpc(settings.preview),
      haveMesh: meshToken,
      haveAtlas: heldAtlas,
    });
    if (!response.ok) {
      /*
       * Cleared either way. Leaving the last mesh up meant deleting every block
       * left its ghost on screen, still selectable, until something else
       * happened to succeed.
       */
      mesh = null;
      bounds = null;
      /*
       * An empty document is not a failure; it is where every build starts.
       * `buildDocumentPreview` raises `EmptyPreviewError` rather than handing
       * back an empty mesh, which is right for previewing a *generated* file
       * and wrong for the editor — so pressing New was answered with "the
       * schematic contains no blocks other than air" every single time.
       */
      if (docState.blockCount > 0) {
        status = { tone: "warn", text: response.message };
      }
      meshToken = null;
      return;
    }
    mesh = response.mesh;
    bounds = { center: response.center, size: response.size };
    meshToken = response.mesh.token;
    heldAtlas = response.mesh.atlasVersion;
  }

  /**
   * Every document call funnels through here so failures cannot go unreported.
   * Returns how many blocks changed, or `null` if the call did not succeed.
   */
  async function runDocument(
    doing: string,
    call: () => Promise<EditResponse>,
  ): Promise<number | null> {
    busy = true;
    try {
      const response = await call();
      if (!response.ok) {
        status = { tone: "warn", text: response.message };
        return null;
      }
      docState = response.state;
      await refreshDocument();
      // The inspected block may well have been one of the ones that changed --
      // a fill over it, or an undo of the edit that made it. Showing what it
      // used to be is worse than showing nothing.
      if (inspectedAt) {
        await inspectBlock(inspectedAt.x, inspectedAt.y, inspectedAt.z);
      }
      return response.changed;
    } catch (err) {
      failed(err, doing);
      return null;
    } finally {
      busy = false;
    }
  }

  /**
   * Asks before work is thrown away, and answers `true` when there is none.
   *
   * `newDocument` in main reassigns the open session without looking at what
   * was there, and opening another file does the same — so the only defence is
   * in front of the call. It cannot be inside `session.ts`: by the time main
   * has the request, the user has already been shown a dialog they answered
   * about the *new* document.
   *
   * The box itself is native and lives in main, which is what lets the window's
   * own close button ask the identical question with no renderer involved.
   */
  async function mayDiscard(intent: "new" | "open" | "close"): Promise<boolean> {
    if (docState === null || !docState.dirty) return true;
    try {
      return await api().confirmDiscard({ intent, fileName: docState.fileName });
    } catch (err) {
      /*
       * A dialog that could not be shown must not become a silent yes. Refusing
       * leaves the document exactly as it was, which is the answer that cannot
       * lose anything.
       */
      failed(err, t("task.confirming"));
      return false;
    }
  }

  /** New, but only after the open document has been asked about. */
  async function startNewDocument(): Promise<void> {
    if (!(await mayDiscard("new"))) return;
    schematicDialog = "new";
  }

  /**
   * Puts the document away and goes back to the start screen.
   *
   * `closeDocument` has been on the bridge since it was written and had no
   * caller at all: there was no way to stop editing a schematic short of
   * quitting. Everything derived from the document is cleared here rather than
   * left to fall out of `docState = null`, because a stale selection or
   * inspection would be re-applied to whatever is opened next.
   */
  async function closeDocument(): Promise<void> {
    if (!(await mayDiscard("close"))) return;
    busy = true;
    try {
      await api().closeDocument();
      docState = null;
      mesh = null;
      // Nothing on screen holds nothing: a token left behind here would ask
      // main for the difference from geometry that has been taken down.
      meshToken = null;
      documentVersions = [];
      chat = [];
      liveTrace = [];
      selection = null;
      anchor = null;
      inspection = null;
      inspectedAt = null;
      project = null;
      inventoryOpen = false;
      recentDocuments = await api().listRecentDocuments();
      status = null;
    } catch (err) {
      failed(err, t("task.closing"));
    } finally {
      busy = false;
    }
  }

  async function openDocument(): Promise<void> {
    let picked: Awaited<ReturnType<ReturnType<typeof api>["pickFile"]>>;
    try {
      picked = await api().pickFile({ kind: "schem" });
    } catch (err) {
      failed(err, t("task.openingChooser"));
      return;
    }
    if (picked.error) {
      status = { tone: "error", text: picked.error };
      return;
    }
    if (!picked.path) return;
    await openDocumentAt(picked.path);
  }

  /** Opens a schematic by path — from the picker, from a drop, or from recents. */
  async function openDocumentAt(filePath: string): Promise<void> {
    // Here rather than in `openDocument`, because that is only one of four
    // ways in: the picker, a drop on the viewport, a recent entry, and the
    // File menu all end up on this line.
    if (!(await mayDiscard("open"))) return;
    busy = true;
    try {
      const response = await api().openDocument(filePath);
      // Re-read either way: main adds the file on success and drops it on
      // failure, so a stale entry for a schematic that has moved disappears the
      // moment it is clicked rather than sitting there failing forever.
      recentDocuments = await api().listRecentDocuments();
      if (!response.ok) {
        status = { tone: "error", text: response.message };
        return;
      }
      docState = response.state;
      // Whatever this file was last saved as, so the dialogs open on it rather
      // than on a default the user has already overruled once.
      project = response.project ?? null;
      selection = null;
      anchor = null;
      inspection = null;
      inspectedAt = null;
      /*
       * Only a `.mcfunction` ever brings notes: a container either parses or it
       * does not, while a list of commands can be partly read. Shown as a
       * warning rather than swallowed, because "half the build is in a file I
       * could not find" is indistinguishable from "the app lost it".
       */
      status =
        response.notes === undefined || response.notes.length === 0
          ? null
          : { tone: "warn", text: t("status.opened"), detail: response.notes.join(" · ") };
      /*
       * A conversation is about a schematic, but *which* one is main's call now
       * -- `adoptSubject` clears the log when another file is opened and keeps
       * it when the conversation is the reason this file exists. Clearing here
       * unconditionally is what erased the prompt that built it.
       */
      liveTrace = [];
      remembered = 0;
      if (bridgeAvailable) {
        adoptChat(await api().getChatState());
        await refreshConversations();
      }
      // A newly opened document is the one case where framing the camera is
      // what the user wants: they have not aimed it at anything yet.
      framingEpoch += 1;
      await refreshDocument();
      /*
       * A baseline, once per schematic: how the file was when it was first
       * opened. Only when there is no history yet, so this costs one snapshot
       * per file rather than one per open -- and it is the version people
       * actually want when a session has gone wrong.
       */
      await refreshVersions();
      if (documentVersions.length === 0) await saveVersion("opened", "");
    } catch (err) {
      failed(err, t("task.opening"));
    } finally {
      busy = false;
    }
  }

  /**
   * A click sets the anchor and selects that one block; Shift-click grows the
   * box to include it. Two corners is the whole gesture -- it is what a region
   * *is*, and it does not fight the orbit controls for the drag.
   */
  /** Fetches what the clicked block is, for the inspector. */
  async function inspectBlock(x: number, y: number, z: number): Promise<void> {
    inspectedAt = { x, y, z };
    try {
      const response = await api().inspectBlock(x, y, z);
      inspection = response.ok ? response : null;
      // Asking what a block is is the gesture that wants the inspector, exactly
      // as selecting something is the gesture that wants the tools.
      if (inspection !== null) inspectorOpen = true;
    } catch {
      // A failed inspection is not worth a banner — the panel simply stays
      // empty, and the click still moved the selection, which is the part the
      // user was asking for.
      inspection = null;
    }
  }

  function onPick(block: PickedBlock | null): void {
    if (block === null) {
      // Clicked past the structure. That is the gesture for "never mind" —
      // it drops the selection and empties the inspector.
      selection = null;
      anchor = null;
      inspection = null;
      inspectedAt = null;
      return;
    }
    void inspectBlock(block.x, block.y, block.z);
    /*
     * The tools no longer reappear here.
     *
     * They used to, on the grounds that closing them meant "not now" and a
     * panel you can dismiss for good is one you can lose. That reasoning
     * assumed there was no way back — there is one now, a button in the corner
     * of the viewport — and without it "close" did not mean close: the panel
     * came back on the very next selection, which is the gesture you were
     * most likely to make next.
     */
    if (block.extend && anchor !== null) {
      selection = {
        minX: Math.min(anchor.x, block.x),
        minY: Math.min(anchor.y, block.y),
        minZ: Math.min(anchor.z, block.z),
        maxX: Math.max(anchor.x, block.x),
        maxY: Math.max(anchor.y, block.y),
        maxZ: Math.max(anchor.z, block.z),
      };
      return;
    }
    anchor = { x: block.x, y: block.y, z: block.z };
    selection = {
      minX: block.x,
      minY: block.y,
      minZ: block.z,
      maxX: block.x,
      maxY: block.y,
      maxZ: block.z,
    };
  }

  /**
   * A face of the selection box was dragged in the viewport.
   *
   * The region arrives already snapped to whole blocks and clamped to the
   * document, so there is nothing to validate here. The anchor moves to the
   * box's near corner so a following Shift-click extends from where the box now
   * is rather than from wherever it was first clicked — otherwise resizing a
   * selection and then extending it would jump somewhere unrelated.
   */
  function onSelectionDragged(region: RegionSpec): void {
    selection = region;
    anchor = { x: region.minX, y: region.minY, z: region.minZ };
  }

  function selectAll(): void {
    if (!docState) return;
    anchor = { x: 0, y: 0, z: 0 };
    selection = {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: docState.size[0] - 1,
      maxY: docState.size[1] - 1,
      maxZ: docState.size[2] - 1,
    };
  }

  function parseBlock(text: string): { namespacedName: string; properties?: Record<string, string> } {
    /*
     * `35:14` becomes red wool before anything else looks at it.
     *
     * It has to happen here rather than in the picker, because this is where
     * every string becomes a block: the hotbar, the fill field, the replace
     * field and a paste all arrive through it. And it has to happen *first*,
     * because the line below treats a colon as a namespace separator and would
     * otherwise intern a block literally called `35:14`.
     *
     * Only on a legacy document. Above 1.13 a file holds no `ID:DATA`, so
     * resolving one would answer a question the schematic cannot ask.
     */
    const trimmed = resolveBlockInput(text, legacyForDoc).trim();
    const name = trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`;
    const bracket = name.indexOf("[");
    if (bracket === -1) {
      return { namespacedName: name };
    }
    // `oak_stairs[facing=north]` typed by hand: the same spelling the palette
    // list shows, so a material can be copied straight back into the field.
    const properties: Record<string, string> = {};
    for (const part of name.slice(bracket + 1).replace(/\]$/, "").split(",")) {
      const eq = part.indexOf("=");
      if (eq > 0) properties[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return { namespacedName: name.slice(0, bracket), properties };
  }

  /**
   * Rewrites one of the inspected block's states.
   *
   * There is no "change a property" operation in the domain, and there should
   * not be: a block plus its states *is* the block, so this places the same
   * block again with one state different. That makes it an ordinary edit, on
   * the ordinary undo stack.
   */
  async function changeBlockProperty(name: string, value: string): Promise<void> {
    if (!inspection || !inspectedAt) return;
    const at = inspectedAt;
    /*
     * Empty means remove, and this is the only place that decides so.
     *
     * The panel has no separate delete verb: clearing the field takes the
     * property off, and the button beside a set row is a shortcut for clearing
     * it. Two ways of saying "gone" is how they come to disagree about what an
     * empty box means, and this one used to write `name: ""` -- a property with
     * an empty value, which is a state no block has and which the writers would
     * have put in the file verbatim.
     *
     * Removing a state is legitimate rather than merely the inverse of adding
     * one: a partial state is legal in a schematic -- the game fills the rest in
     * from its own defaults -- and it is how the MCEdit writer's exact-state
     * match is kept clean, which is the same reasoning that keeps `waterlogged`
     * out of what a placed block is born with.
     *
     * Removing something that was not there changes nothing, and costs nothing:
     * `runTransaction` pushes no undo step for a recorder with no commands.
     */
    const next = value.trim();
    const properties = { ...inspection.properties };
    if (next === "") {
      delete properties[name];
    } else {
      properties[name] = next;
    }
    await runDocument(
      next === "" ? t("task.removingBlockState") : t("task.changingBlockState"),
      () =>
        // `setState`, not `setBlock`: every ordinary write re-derives the states
        // that depend on neighbours, so typing `north=false` here and sending it
        // as a placement would have it overwritten inside the same transaction.
        api().applyEdit({
          kind: "setState",
          x: at.x,
          y: at.y,
          z: at.z,
          block: { namespacedName: inspection!.block, properties },
        }),
    );
    // No re-inspect here: `runDocument` already refreshes the inspected block.
  }

  /**
   * Writes one NBT leaf.
   *
   * `runDocument` re-inspects afterwards, which matters more here than for a
   * block state: main coerces the text to the tag's type, so 007 comes back as
   * 7 and the field has to show what was actually stored rather than what was
   * typed.
   */
  async function changeNbtValue(path: (string | number)[], value: string): Promise<void> {
    if (!inspectedAt) return;
    const at = inspectedAt;
    await runDocument(t("task.editingNbt"), () =>
      api().setNbtValue({ x: at.x, y: at.y, z: at.z, path: forIpc(path), value }),
    );
  }

  /**
   * The cell WorldEdit would paste from, out of the offset the file stores.
   *
   * The negation is main's rule (`anchorOf`), and this mirrors it for the one
   * thing the renderer has to do with it: draw a box. Wrong here and the marker
   * appears mirrored about the corner, which looks plausible and is not.
   */
  const worldEditAnchor = $derived.by((): [number, number, number] | null => {
    const offset = docState?.offset ?? null;
    return offset === null ? null : [-offset[0], -offset[1], -offset[2]];
  });

  /**
   * Sets, moves or removes the anchor, reporting into the modal.
   *
   * Deliberately not through `runDocument`: that puts a failure in the app's
   * status banner, which sits *behind* the modal's scrim — so a refusal, or a
   * channel the main process does not answer, would look exactly like a button
   * that does nothing.
   */
  /**
   * Sets the schematic's size, and relays main's refusal into the panel.
   *
   * Two answers rather than one, and the second is the point. A shrink that
   * would destroy blocks comes back as a failure carrying the count -- main is
   * the only side that knows, because it holds the voxels -- and the button
   * then offers to go ahead. Asking *before* the request would mean guessing
   * that number here, which would be wrong in exactly the case that matters.
   *
   * The confirmation is cleared on every attempt, so it can never be carried
   * from the size it was given for onto a different one.
   */
  async function resizeDocument(
    size: [number, number, number],
    confirmLoss: boolean,
  ): Promise<void> {
    dimensionsError = "";
    dimensionsConfirmable = false;
    busy = true;
    try {
      const response = await api().resizeDocument({
        width: size[0],
        height: size[1],
        length: size[2],
        confirmLoss,
      });
      if (!response.ok) {
        dimensionsError = response.message;
        // Only a loss is worth offering to override. Anything else -- a size
        // out of range, a volume past the cap -- is not a decision the user
        // can make differently, so offering to force it would be a lie.
        //
        // On the kind, never on the wording: matching the sentence is how a
        // reworded refusal silently becomes a dead end, and nothing would
        // fail when it did.
        dimensionsConfirmable = !confirmLoss && response.kind === "needs-confirmation";
        return;
      }
      docState = response.state;
      await refreshDocument();
    } catch (err) {
      dimensionsError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  /**
   * Chooses what empty space is made of, and optionally rewrites the cells
   * that already hold the old answer.
   *
   * A document call rather than a settings write, which is the whole of why
   * the viewport now keeps up: `patchSettings` writes the store and stops, so
   * the choice landed on disk and the picture did not change until the file
   * was closed and opened again. This answers with a `DocumentState`, so it
   * takes the ordinary path every other document change takes.
   */
  /**
   * Changes which Minecraft version the schematic is for.
   *
   * The refusal for destroying blocks is recognised by its **kind**, never by
   * its wording. A renderer matching on the sentence turns a reworded message
   * into a dead end with nothing failing anywhere, which is why
   * `needs-confirmation` exists as a `FailureKind` at all.
   */
  async function changeMcVersion(version: string, drop: boolean): Promise<void> {
    mcVersionError = "";
    busy = true;
    try {
      const response = await api().setDocumentVersion({
        version,
        dropUnrepresentable: drop,
      });
      if (!response.ok) {
        mcVersionConfirm = response.kind === "needs-confirmation";
        mcVersionError = response.message;
        return;
      }
      mcVersionConfirm = false;
      /*
       * A version change does three things and only one of them is a loss, so
       * `changed` alone would report a rename and a demolition identically.
       * Main sends the sentence; the banner is where it goes, because the modal
       * closes on success and there would be nowhere else to read it.
       */
      if (response.notes) {
        status = {
          tone: "ok",
          text: t("status.versionChanged", {
            version: mcVersion(version)?.label ?? version,
            notes: response.notes,
          }),
        };
      }
      docState = response.state;
      // The version is a fact the sidebar and the dialogs read, and the era
      // decides what the inventory offers -- so the local copy has to move too.
      project = { ...(project ?? {}), version };
      await refreshDocument();
      if (nbtOpen) await refreshSchematicNbt();
      mcVersionOpen = false;
    } catch (err) {
      mcVersionError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }


  async function changeVoidBlock(block: string): Promise<void> {
    voidError = "";
    busy = true;
    try {
      const response = await api().setVoidBlock({ block });
      if (!response.ok) {
        // Inside the modal: the app's status banner is behind the scrim, so a
        // failure reported there is one nobody can see.
        voidError = response.message;
        return;
      }
      docState = response.state;
      await refreshDocument();
    } catch (err) {
      voidError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  /**
   * Converts the cells that hold `from` so they hold `to`, as one undoable step.
   *
   * `from` is named rather than left to main, because main's own value is the
   * block that was just chosen: the choice takes effect at the pick, so by the
   * time this runs the session already says water and would convert water into
   * water. See `voidFilledWith`.
   */
  async function replaceVoidBlock(from: string, to: string): Promise<void> {
    voidError = "";
    busy = true;
    try {
      const response = await api().setVoidBlock({
        block: to,
        replaceExisting: true,
        replaceFrom: from,
      });
      if (!response.ok) {
        voidError = response.message;
        return;
      }
      // Only on success: a failed rewrite leaves the cells as they were, and
      // a belief updated anyway would disable the button that could retry it.
      voidFilledWith = to;
      docState = response.state;
      await refreshDocument();
    } catch (err) {
      voidError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }


  async function changeWorldEditAnchor(
    next: [number, number, number] | null,
  ): Promise<void> {
    anchorError = "";
    busy = true;
    try {
      const response = await api().setWorldEditAnchor(forIpc(next));
      if (!response.ok) {
        anchorError = response.message;
        return;
      }
      docState = response.state;
      await refreshDocument();
      // The NBT panel shows the same tag, so it is stale the moment this lands.
      if (nbtOpen) await refreshSchematicNbt();
    } catch (err) {
      anchorError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  /** Fetches the schematic's NBT afresh. Called on open and on Revert. */
  async function refreshSchematicNbt(): Promise<void> {
    if (!bridgeAvailable) return;
    try {
      const response = await api().readSchematicNbt();
      if (!response.ok) {
        nbtError = response.message;
        return;
      }
      nbtText = response.text;
      nbtEditable = response.editable;
      nbtOmitted = response.omitted;
      nbtRevision = response.revision;
      nbtError = "";
    } catch (err) {
      failed(err, t("task.readingNbt"));
    }
  }

  async function openNbtPanel(): Promise<void> {
    if (!docState) return;
    nbtError = "";
    await refreshSchematicNbt();
    nbtOpen = true;
  }

  async function applySchematicNbt(text: string): Promise<void> {
    const revision = nbtRevision;
    nbtError = "";
    const response = await api()
      .applySchematicNbt({ text, revision })
      .catch((err: unknown) => {
        failed(err, t("task.editingSchematicNbt"));
        return null;
      });
    if (response === null) return;
    if (!response.ok) {
      // Main's own wording, shown as it arrived: it names a line and a column,
      // or a tag, and rephrasing it here could only lose that.
      nbtError = response.message;
      return;
    }
    docState = response.state;
    busy = true;
    try {
      await refreshDocument();
    } finally {
      busy = false;
    }
    // The document moved, so the revision the panel is holding is stale.
    await refreshSchematicNbt();
  }

  async function changeWorldOrigin(origin: [number, number, number] | null): Promise<void> {
    nbtError = "";
    await runDocument(t("task.settingOrigin"), () => api().setWorldOrigin(forIpc(origin)));
    await refreshSchematicNbt();
  }

  async function copySelection(cut: boolean): Promise<void> {
    if (!selection) return;
    const region = selection;
    busy = true;
    try {
      const response = await (cut
        ? api().cutRegion(forIpc(region))
        : api().copyRegion(forIpc(region)));
      if (!response.ok) {
        status = { tone: "error", text: response.message };
        return;
      }
      clipboard = response.clipboard;
      docState = response.state;
      if (cut) await refreshDocument();
      status = {
        tone: "ok",
        text: t(cut ? "status.cut" : "status.copied", {
          count: response.clipboard.blocks.toLocaleString(),
        }),
      };
    } catch (err) {
      failed(err, cut ? t("task.cutting") : t("task.copying"));
    } finally {
      busy = false;
    }
  }

  /**
   * Pastes at the selection's corner.
   *
   * The corner rather than the centre, and rather than wherever the camera is
   * looking: it is the one point of a selection the user can see and predict,
   * and it makes pasting back into the place something was cut from exact.
   */
  async function pasteHere(): Promise<void> {
    if (!selection) return;
    const at = { x: selection.minX, y: selection.minY, z: selection.minZ };
    const changed = await runDocument(t("task.pasting"), () => api().pasteClipboard(at));
    reportChange(changed);
  }

  /**
   * Turns or reflects the selection.
   *
   * The selection itself is left alone: a quarter turn needs a square
   * footprint, so the box the user drew still describes exactly the region that
   * moved, and clearing it would take away the obvious way to turn it back.
   */
  async function transformSelection(transform: TransformRequest["transform"]): Promise<void> {
    if (!selection) return;
    const region = selection;
    const changed = await runDocument(t("task.transforming"), () =>
      api().transformRegion({ region: forIpc(region), transform }),
    );
    reportChange(changed);
  }

  /**
   * The region being moved, and its contents as geometry.
   *
   * A mode rather than a drag, because the gesture does not start on the box:
   * a press on the selection is already the camera's, and taking it would cost
   * the one thing that made orbiting bearable. So Move arms it, the pointer
   * places it, a click puts it down, and Escape puts it back.
   */
  let moving = $state<{ region: RegionSpec; chunks: ChunkGeometry[] } | null>(null);

  async function startMove(): Promise<void> {
    if (!selection || busy) return;
    const region = selection;
    busy = true;
    try {
      const response = await api().regionMesh(forIpc(region));
      if (!response.ok) {
        status = { tone: "warn", text: response.message };
        return;
      }
      moving = { region: { ...region }, chunks: response.chunks };
    } catch (err) {
      failed(err, t("task.moving"));
    } finally {
      busy = false;
    }
  }

  function cancelMove(): void {
    moving = null;
  }

  /**
   * Puts the region down, and takes the selection with it.
   *
   * The selection follows because the blocks did: leaving the box behind on the
   * empty space they came from would make the very next operation act on
   * nothing, and every editor that moves a thing leaves it selected.
   */
  async function commitMove(to: { x: number; y: number; z: number }): Promise<void> {
    const held = moving;
    if (held === null) return;
    moving = null;
    const changed = await runDocument(t("task.moving"), () =>
      api().moveRegion({ region: forIpc(held.region), to }),
    );
    if (changed !== null) {
      selection = movedRegion(held.region, to);
      anchor = { x: to.x, y: to.y, z: to.z };
    }
    reportChange(changed);
  }

  /** Drops the selection without touching a block. */
  function clearSelection(): void {
    selection = null;
    anchor = null;
  }

  /**
   * Empties the selection, which is a fill with air.
   *
   * Air is a real block everywhere in this app -- every empty cell in the
   * document is one, and the writers and the agent both name it -- so there is
   * no separate "erase" operation to add. It goes through `applyEdit` like any
   * other fill, which is what makes it one undo step.
   */
  async function deleteSelection(): Promise<void> {
    if (!selection) return;
    const region = selection;
    const changed = await runDocument(t("task.deleting"), () =>
      api().applyEdit({ kind: "fill", region: forIpc(region), block: { namespacedName: "minecraft:air" } }),
    );
    reportChange(changed);
  }

  async function fillSelection(block: string): Promise<void> {
    if (!selection) return;
    const region = selection;
    const changed = await runDocument(t("task.filling"), () =>
      api().applyEdit({ kind: "fill", region: forIpc(region), block: parseBlock(block) }),
    );
    reportChange(changed);
  }

  async function replaceInSelection(from: string, to: string): Promise<void> {
    if (!selection) return;
    const region = selection;
    const changed = await runDocument(t("task.replacing"), () =>
      api().applyEdit({
        kind: "replace",
        region: forIpc(region),
        from: parseBlock(from),
        to: parseBlock(to),
      }),
    );
    reportChange(changed);
  }

  /**
   * An edit that matched nothing is indistinguishable from a broken button, so
   * it says so. A successful one needs no announcement: the viewport is the
   * confirmation.
   */
  function reportChange(changed: number | null): void {
    if (changed === 0) {
      status = { tone: "info", text: t("status.nothingMatched") };
    }
  }

  async function saveDocument(
    format?: SchematicFormat,
    filePath?: string,
    /*
     * Omitted means "leave whatever the document carries", which is what a plain
     * Save wants; naming a version stamps it, and main refuses the pairs that
     * cannot work. Sending one unconditionally would rewrite the version of
     * every file the app saved over.
     */
    version?: string,
  ): Promise<void> {
    /*
     * Nowhere to save to yet means Save As, which is what every editor does.
     *
     * Here rather than at the call sites, and that is the whole point: this
     * check used to live in the Ctrl+S branch and in the command palette, and
     * the third caller -- the Save button in the sidebar -- did not have it. It
     * reached `saveSession`, which threw `NoSaveTargetError`, and the user got
     * a red banner reading "choose where to put it": advice, where the app
     * could simply have asked. Three affordances for one verb, and correctness
     * by discipline instead of by construction.
     *
     * Only when no path was *named*: a Save As has already chosen one and
     * passes it in, and re-entering the dialog from here would loop.
     */
    if (filePath === undefined && docState?.filePath === null) {
      saveDocumentAs();
      return;
    }
    busy = true;
    try {
      const response = await api().saveDocument({
        filePath: filePath ?? null,
        format,
        ...(version === undefined ? {} : { version }),
      });
      if (!response.ok) {
        status = { tone: "error", text: response.message };
        return;
      }
      docState = response.state;
      status = {
        tone: response.degraded.length > 0 || response.dropped.length > 0 ? "warn" : "ok",
        text: t("status.saved", { name: response.filePath.split(/[\\/]/).pop() ?? "" }),
        detail: [
          response.cropped
            ? t("status.cropped", {
                from: response.cropped.from.join("×"),
                to: response.cropped.to.join("×"),
              })
            : null,
          response.degraded.length > 0
            ? t("status.degraded", {
                count: response.degraded.length,
                blocks: response.degraded.slice(0, 3).join(", "),
              })
            : null,
          /*
           * A different sentence from `degraded`, because it is a different
           * loss. A degraded block is in the file, approximated; a dropped
           * thing is not there at all, and the container has nowhere to put it.
           */
          response.dropped.length > 0
            ? t("status.dropped", { things: response.dropped.join(", ") })
            : null,
        ]
          .filter((note) => note !== null)
          .join(" · ") || undefined,
      };
    } catch (err) {
      failed(err, t("task.saving"));
    } finally {
      busy = false;
    }
  }

  /**
   * Creates a schematic, or saves one under a new name.
   *
   * Both arrive here from the same dialog, and the split is at the end rather
   * than the start: everything up to "what should it be" is one question.
   */
  async function confirmSchematicDialog(choice: {
    width: number;
    height: number;
    length: number;
    format: SchematicFormat;
    version: string;
  }): Promise<void> {
    const mode = schematicDialog;
    schematicDialog = null;
    if (mode === null) return;

    if (mode === "new") {
      busy = true;
      try {
        const response = await api().newDocument({
          width: choice.width,
          height: choice.height,
          length: choice.length,
          format: choice.format,
          version: choice.version,
        });
        if (!response.ok) {
          status = { tone: "error", text: response.message };
          return;
        }
        docState = response.state;
        project = { format: choice.format, version: choice.version };
        // A brand-new document has no file, so it has nowhere to keep versions
        // until it is saved. Clearing beats showing the last file's history.
        documentVersions = [];
        chat = [];
        liveTrace = [];
        selection = null;
        anchor = null;
        inspection = null;
        await refreshDocument();
        await refreshConversations();
        status = { tone: "ok", text: t("status.created") };
      } catch (err) {
        failed(err, t("task.creating"));
      } finally {
        busy = false;
      }
      return;
    }

    /*
     * The OS dialog comes *after* the format is settled, and cannot be asked to
     * settle it: `.schem` is both Sponge v2 and v3, and Electron reports the
     * path the user chose but not which filter produced it.
     */
    let picked: Awaited<ReturnType<ReturnType<typeof api>["pickFile"]>>;
    try {
      picked = await api().pickFile({
        kind: "save-schematic",
        format: choice.format,
        defaultPath: suggestedSavePath(choice.format),
      });
    } catch (err) {
      failed(err, t("task.choosingSaveLocation"));
      return;
    }
    if (!picked.path) return;
    await saveDocument(choice.format, picked.path, choice.version);
  }


  /*
   * The converter, which is the one panel here that is not about the open
   * document -- so it is also the one whose button is never disabled.
   * Converting a `.litematic` somebody sent you is a thing to do before there
   * is anything open at all.
   */
  let convertOpen = $state(false);
  let convertBusy = $state(false);
  let convertSource = $state("");
  let convertTarget = $state("");
  let convertError = $state("");
  let convertReport = $state("");

  async function pickConvertSource(): Promise<void> {
    const picked = await api().pickFile({ kind: "schem" });
    if (picked.path) {
      convertSource = picked.path;
      convertError = "";
      convertReport = "";
    }
  }

  async function pickConvertTarget(format: FileKind): Promise<void> {
    /*
     * The format goes to the dialog, because the extension cannot be recovered
     * from a path -- `.schem` is both Sponge versions -- and a dialog that
     * suggested one name while main wrote another would be the same silence
     * `pickFile` already forces the extension to avoid.
     */
    const stem = convertSource.split(/[\\/]/).pop()?.replace(/\.[^.]*$/, "") ?? "converted";
    const picked = await api().pickFile({
      kind: "save-schematic",
      format,
      defaultPath: stem,
    });
    if (picked.path) {
      convertTarget = picked.path;
      convertError = "";
      convertReport = "";
    }
  }

  async function runConversion(request: {
    source: string;
    target: string;
    format: FileKind;
    version?: string;
  }): Promise<void> {
    convertBusy = true;
    convertError = "";
    convertReport = "";
    try {
      const response = await api().convertFile(request);
      if (!response.ok) {
        convertError = response.message;
        return;
      }
      /*
       * Reported afterwards, by name, rather than promised beforehand: every
       * cost a conversion can have is a fact about the *source*, and the panel
       * has not read it. Nothing is overwritten in the meantime, so
       * convert-then-say is the honest order.
       */
      convertReport = [
        t("convert.wrote", {
          count: response.files.length,
          name: response.files[0]?.split(/[\\/]/).pop() ?? "",
          size: response.size.join(String.fromCharCode(215)),
          blocks: response.blocks.toLocaleString(),
        }),
        response.backedUp.length > 0
          ? t("convert.backedUp", { count: response.backedUp.length })
          : null,
        response.degraded.length > 0
          ? t("status.degraded", {
              count: response.degraded.length,
              blocks: response.degraded.slice(0, 3).join(", "),
            })
          : null,
        response.dropped.length > 0
          ? t("status.dropped", { things: response.dropped.join(", ") })
          : null,
        ...response.notes,
      ]
        .filter((note) => note !== null)
        .join(" \u00b7 ");
    } catch (err) {
      convertError = err instanceof Error ? err.message : String(err);
    } finally {
      convertBusy = false;
    }
  }

  /** Where Save As opens: this file's own folder and name, or a plain default. */
  function suggestedSavePath(format: SchematicFormat): string {
    const extension = schematicExtension(format);
    const current = docState?.filePath;
    if (current === null || current === undefined) return `untitled.${extension}`;
    const cut = current.length - (current.split(/[\\/]/).pop() ?? "").length;
    const stem = (current.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "");
    return `${current.slice(0, cut)}${stem}.${extension}`;
  }

  function saveDocumentAs(): void {
    schematicDialog = "save-as";
  }

  /**
   * A message to the AI, meaning whichever of the two things it can mean.
   *
   * With a document open the agent edits it. With nothing open there is nothing
   * to edit, and the prompt is a description of something to *build* -- so it
   * goes to the generator, which writes a schematic and opens it. Every message
   * after that edits what the first one created.
   *
   * The chat used to refuse outright and tell the user to open a schematic
   * first, which was only ever true of half the app: the generator has always
   * been able to make one from a sentence. It was asking people to go and find
   * a second text box to type the same sentence into.
   */
  async function askAgent(prompt: string): Promise<void> {
    if (docState === null) {
      await buildFromChat(prompt);
      return;
    }
    // Optimistic, because a request takes seconds and the message has to
    // appear now. Main appends its own copy and the response replaces this.
    chat = [...chat, { role: "user", text: prompt }];
    liveTrace = [];
    busy = true;
    const id = requestId();
    // Held so Stop can name the run. Cleared in `finally`, which is what makes
    // the button disappear the instant the request settles, however it settled.
    inFlight = { id, kind: "agent" };
    try {
      const response = await api().askAgent({
        requestId: id,
        prompt,
        selection: selection ? forIpc(selection) : null,
      });
      // Both branches carry the log, because a stopped or failed run is a
      // turn too and main has already written it.
      adoptChat(response.chat);
      if (!response.ok) return;
      docState = response.state;
      remembered = response.remembered;
      await refreshDocument();
    } catch (err) {
      chat = [
        ...chat,
        { role: "error", text: err instanceof Error ? err.message : String(err) },
      ];
    } finally {
      inFlight = null;
      liveTrace = [];
      busy = false;
    }
  }

  /**
   * Builds a schematic from a description and opens it.
   *
   * Returns `null` on success, or the failure's message. Both callers -- the
   * Generate button and the chat with nothing open -- want the file written and
   * opened; only the way they report it differs, so that is the only part left
   * to them.
   */
  async function generateFrom(prompt: string, viaChat = false): Promise<string | null> {
    busy = true;
    status = null;
    const id = requestId();
    // Only a build the chat asked for is stoppable from the chat, because the
    // Structure panel has no Stop button to press. The id is held either way so
    // the progress subscription can tell this build's phases from a preview's.
    if (viaChat) inFlight = { id, kind: "build" };
    buildRequestId = id;
    try {
      let response: Awaited<ReturnType<ReturnType<typeof api>["generate"]>>;
      try {
        response = await api().generate({
          requestId: id,
          description: prompt,
          version: settings.version,
          exportType: settings.exportType,
          imagePath,
          viaChat,
        });
      } catch (err) {
        failed(err, t("task.generating"));
        return err instanceof Error ? err.message : String(err);
      }
      if (!response.ok) {
        // Stopping is not a failure and gets no banner: the user asked for it,
        // and the chat already carries main's note saying so. Same treatment
        // the agent's own cancellation gets.
        if (response.kind !== "cancelled") {
          status = {
            tone:
              response.kind === "sandbox-violation" || response.kind === "sandbox-unavailable"
                ? "error"
                : "warn",
            text: response.message,
            detail: response.detail,
          };
        }
        return response.message;
      }
      // Two independent things worth saying about a successful save, either of
      // which may be absent. Dropped blocks downgrade the tone: the file was
      // written, but it is not the structure the model described.
      const notes: string[] = [];
      if (response.backedUpTo) {
        notes.push(
          t("status.backedUp", { name: response.backedUpTo.split(/[\\/]/).pop() ?? "" }),
        );
      }
      if (response.droppedBlocks.length > 0) {
        const named = response.droppedBlocks
          .slice(0, 3)
          .map((dropped) => `${dropped.blockId ?? t("status.emptyBlock")} ×${dropped.calls}`)
          .join(", ");
        const rest = response.droppedBlocks.length - 3;
        notes.push(
          t("status.droppedBlocks", {
            count: response.droppedBlocks.length,
            blocks: named + (rest > 0 ? t("status.droppedAndMore", { count: rest }) : ""),
          }),
        );
      }
      status = {
        tone: response.droppedBlocks.length > 0 ? "warn" : "ok",
        text: t("status.saved", { name: `${response.name}.${response.exportType}` }),
        detail: notes.length > 0 ? notes.join(". ") : undefined,
      };
      artifacts = await api().listArtifacts();
      // component.py:401-404 -- only .schem gets a preview, and only then does
      // it become the "last schem" for Re-render.
      if (response.exportType === "schem") {
        // Opened rather than merely previewed. Generating used to hand back a
        // picture of a file: the chat still said "open a schematic first" and
        // none of the editing tools could touch what had just been made. It is
        // a document now, like anything else that arrives on screen.
        //
        // Which means it inherits the unsaved-work question, and should: this
        // replaces whatever was open. Answering no is safe -- the generated
        // file is already on disk and in the artifact list, so it can be opened
        // whenever the work in hand has been dealt with. The usual case is a
        // build asked for with nothing open, where there is nothing to ask.
        await openDocumentAt(response.path);
        /*
         * And a version of what it produced, labelled with the prompt that
         * produced it. This is the whole reason the history exists: generating
         * replaces everything that was open, and until now the only record of
         * what it replaced was the file it had overwritten.
         */
        await saveVersion("generated", prompt);
      }
      return null;
    } finally {
      if (inFlight?.id === id) inFlight = null;
      buildRequestId = null;
      liveTrace = [];
      busy = false;
      progress = null;
    }
  }
</script>

<CommandPalette open={paletteOpen} {commands} onclose={() => (paletteOpen = false)} />

<CreativeInventory
  open={inventoryOpen}
  blocks={blockRegistry}
  placeable={placeableBlocks}
  legacy={legacyForDoc}
  version={project?.version ?? documentVersionName(docState?.format ?? "sponge3", docState?.dataVersion ?? null) ?? settings.version}
  purpose={inventoryFor}
  onclose={() => (inventoryOpen = false)}
  onpick={(block) => {
    /*
     * Where the block goes depends on who asked. The list is the same list --
     * a second block browser for the tools' two fields would be the same nine
     * hundred tiles behind a different scrollbar, and would drift.
     */
    if (inventoryFor === "replace") replaceBlock = block;
    else holdBlock(block);
  }}
/>

<SchematicDialog
  open={schematicDialog !== null}
  mode={schematicDialog ?? "new"}
  initial={{
    width: docState?.size[0] ?? 16,
    height: docState?.size[1] ?? 16,
    length: docState?.size[2] ?? 16,
    format: project?.format ?? docState?.format ?? "sponge3",
    /*
     * `documentVersionName`, not `versionNameOf`.
     *
     * A legacy `.schematic` carries no DataVersion, so the bare lookup came
     * back `null` and this fell through to the *global* setting -- which is a
     * flat version, preselected against a legacy document. Save As then opened
     * on 1.20.4 for a 1.12 file, and the container list with it.
     */
    version:
      project?.version ??
      documentVersionName(docState?.format ?? "sponge3", docState?.dataVersion ?? null) ??
      settings.version,
  }}
  suggestedName={(docState?.fileName ?? "untitled").replace(/\.[^.]*$/, "")}
  onclose={() => (schematicDialog = null)}
  onconfirm={(choice) => void confirmSchematicDialog(choice)}
/>

<SettingsModal
  open={settingsOpen}
  {settings}
  {keyStatus}
  {resourcePackPath}
  {resourcePackName}
  {versions}
  {defaultOutputDir}
  {busy}
  onpickoutputdir={() => pick("directory")}
  onrevealoutputdir={() => api().revealPath(settings.outputDir || defaultOutputDir)}
  onclose={() => {
    settingsOpen = false;
    settingsCategory = null;
  }}
  onchange={patchSettings}
  onpreviewchange={patchPreview}
  onuichange={patchUi}
  onpickresourcepack={() => pick("resource-pack")}
  onclearresourcepack={() => {
    resourcePackPath = null;
    resourcePackName = null;
  }}
  onsavekey={saveKey}
  onclearkey={clearKey}
  {mcpStatus}
  {mcpActivity}
  startOn={settingsCategory}
  onmcpenabled={(enabled) => void setMcpEnabled(enabled)}
  onmcpregenerate={() => void regenerateMcpToken()}
  onpickmcproot={() => pick("mcp-root")}
/>

<VersionModal
  open={docState !== null && mcVersionOpen}
  format={docState?.format ?? "sponge3"}
  current={documentVersionName(docState?.format ?? "sponge3", docState?.dataVersion ?? null) ?? ""}
  {busy}
  error={mcVersionError}
  needsConfirmation={mcVersionConfirm}
  onapply={(version, drop) => void changeMcVersion(version, drop)}
  onclose={() => {
    mcVersionOpen = false;
    mcVersionError = "";
    mcVersionConfirm = false;
  }}
/>

<VoidBlockModal
  open={docState !== null && voidOpen}
  block={docState?.voidBlock ?? ""}
  opacity={settings.editing.voidOpacity}
  error={voidError}
  {busy}
  blocks={blockRegistry}
  placeable={placeableBlocks}
  legacy={legacyForDoc}
  converted={voidFilledWith}
  present={documentBlocks}
  onblock={(block) => void changeVoidBlock(block)}
  onreplace={(from, to) => void replaceVoidBlock(from, to)}
  onopacity={(voidOpacity) =>
    void patchSettings({ editing: { ...settings.editing, voidOpacity } })}
  onclose={() => {
    voidOpen = false;
    voidError = "";
  }}
/>

<ConvertModal
  open={convertOpen}
  busy={convertBusy}
  error={convertError}
  report={convertReport}
  source={convertSource}
  target={convertTarget}
  onpicksource={() => void pickConvertSource()}
  onpicktarget={(format) => void pickConvertTarget(format)}
  onconvert={(request) => void runConversion(request)}
  onclose={() => {
    convertOpen = false;
    convertError = "";
  }}
/>

<DimensionsModal
  open={docState !== null && dimensionsOpen}
  size={docState?.size ?? [1, 1, 1]}
  autoGrow={settings.editing.autoGrow}
  showBounds={settings.preview.showBounds}
  {busy}
  error={dimensionsError}
  confirmable={dimensionsConfirmable}
  onresize={(size, confirmLoss) => void resizeDocument(size, confirmLoss)}
  onautogrow={(autoGrow) => void patchSettings({ editing: { ...settings.editing, autoGrow } })}
  onbounds={(showBounds) => void patchPreview({ showBounds })}
  onclose={() => {
    dimensionsOpen = false;
    dimensionsError = "";
    dimensionsConfirmable = false;
  }}
/>

<NbtModal
  open={nbtOpen}
  text={nbtText}
  editable={nbtEditable}
  omitted={nbtOmitted}
  origin={docState?.worldOrigin ?? null}
  format={docState?.format ?? "sponge3"}
  {busy}
  error={nbtError}
  onapply={(text) => void applySchematicNbt(text)}
  onrevert={() => void refreshSchematicNbt()}
  onorigin={(origin) => void changeWorldOrigin(origin)}
  onclose={() => (nbtOpen = false)}
/>

<AboutModal open={aboutOpen} info={appInfo} onclose={() => (aboutOpen = false)} />

<VersionsModal
  open={docState !== null && versionsOpen}
  versions={documentVersions}
  {busy}
  saved={docState?.filePath != null}
  onsave={() => void saveVersion("manual", "")}
  onrestore={(id) => void restoreVersion(id)}
  ondelete={(id) => void deleteVersion(id)}
  onclose={() => (versionsOpen = false)}
/>

<AnchorModal
  open={anchorOpen}
  anchor={worldEditAnchor}
  offset={docState?.offset ?? null}
  format={docState?.format ?? "sponge3"}
  size={docState?.size ?? [1, 1, 1]}
  visible={settings.preview.showWorldEditOffset}
  {busy}
  error={anchorError}
  onset={(next) => void changeWorldEditAnchor(next)}
  onclear={() => void changeWorldEditAnchor(null)}
  onvisibility={(showWorldEditOffset) => void patchPreview({ showWorldEditOffset })}
  onclose={() => {
    anchorOpen = false;
    anchorError = "";
  }}
/>

{#if startingUp}
  <StartupScreen steps={startupSteps} />
{/if}

<main
  class:collapsed={sidebarCollapsed}
  style={`--sidebar-w: ${sidebarCollapsed ? 0 : sidebarWidth}px`}
>
  <!--
    The application bar: identity and mode on the left, configuration on the
    right. The gear is deliberately apart from the other two -- they say what
    you are looking at and how, it opens something that covers all of it.

    The camera switch used to float over the viewport's top-right corner. It is
    here now because it is a mode the whole window is in, not a control that
    belongs to the canvas -- and moving it gives the canvas that corner back.
  -->
  <header class="navbar">
    <DocumentBar
      doc={docState}
      {busy}
      canundo={canUndoAnything}
      canredo={canRedoAnything}
      onundo={() => void undoAnything()}
      onredo={() => void redoAnything()}
      onversions={() => (versionsOpen = !versionsOpen)}
      onstart={() => (startDismissed = false)}
      startvisible={startVisible}
    />

    <div class="camera-modes" role="group" aria-label={t("viewport.cameraMode")}>
      <button
        class:active={cameraMode === "orbit"}
        onclick={() => (cameraMode = "orbit")}
        title={t("viewport.orbitHint")}
      >
        {t("viewport.orbit")}
      </button>
      <button
        class:active={cameraMode === "fly"}
        onclick={() => (cameraMode = "fly")}
        title={t("viewport.creativeHint")}
      >
        {t("viewport.creative")}
      </button>
    </div>

    <!--
      A real checkbox rather than a third button in the group above: it is
      not a fourth camera mode, it is a property of one of them.

      Disabled in flight, and that is the same rule the Stop button is
      under -- an orthographic projection has no point of view for
      `PointerLockControls` to move, so flight ignores it, and a live
      control that does nothing is worse than a greyed one that says why.
      The viewer forces perspective regardless, because the *setting* is
      on disk and outlives the mode: launching straight into flight with
      `orthographic` stored has to come out right too.
    -->
    <label class="projection" title={t("viewport.orthographicHint")}>
      <input
        type="checkbox"
        checked={settings.preview.projection === "orthographic"}
        disabled={cameraMode === "fly"}
        onchange={(event) =>
          void patchPreview({
            projection: event.currentTarget.checked ? "orthographic" : "perspective",
          })}
      />
      {t("viewport.orthographic")}
    </label>

    <!--
      Text buttons rather than icons: there is no glyph for "the file's NBT" or
      "WorldEdit's paste anchor" that anyone would read correctly, and the bar
      already mixes both. They sit before the gear, which carries the auto
      margin, so they land at the trailing edge beside it.
    -->
    <!--
      Never disabled, unlike its neighbours: this one converts a file on disk
      and does not consult the open document at all, so needing one open would
      be a rule with nothing behind it.
    -->
    <button
      class="nbt-open"
      onclick={() => (convertOpen = true)}
      title={t("convert.openHint")}
    >
      {t("convert.open")}
    </button>

    <button
      class="nbt-open"
      disabled={docState === null}
      onclick={() => (mcVersionOpen = true)}
      title={t("mcversion.openHint")}
    >
      {t("mcversion.open")}
    </button>
    <button
      class="nbt-open"
      disabled={docState === null}
      onclick={() => (dimensionsOpen = true)}
      title={t("dimensions.openHint")}
    >
      {t("dimensions.open")}
    </button>

    <button
      class="nbt-open"
      disabled={docState === null}
      onclick={() => {
        // Seeded on open, not derived: with nothing converted yet, what the
        // empty cells hold *is* the current choice.
        voidFilledWith = docState?.voidBlock ?? "";
        voidOpen = true;
      }}
      title={t("void.openHint")}
    >
      {t("void.open")}
    </button>

    <button
      class="nbt-open"
      disabled={docState === null}
      onclick={() => (anchorOpen = true)}
      title={t("anchor.openHint")}
    >
      {t("anchor.open")}
    </button>

    <button
      class="nbt-open"
      disabled={docState === null}
      onclick={() => void openNbtPanel()}
      title={t("nbt.openHint")}
    >
      {t("nbt.open")}
    </button>

    <!--
      Present only while the server is on, rather than a permanently dim dot in
      a bar that already carries five controls. It is a button because a status
      light with no way to act on what it reports is a half-feature.
    -->
    {#if showsIndicator(settings.mcp.enabled, mcpStatus)}
      <McpIndicator status={mcpStatus} onopen={openMcpSettings} />
    {/if}

    <button
      class="icon gear"
      onclick={() => (settingsOpen = true)}
      title={t("settings.openShortcut")}
      aria-label={t("settings.title")}>&#x2699;</button
    >
  </header>

  <section class="controls">
    <header class="sidebar-head">
      <button
        class="icon"
        onclick={toggleSidebar}
        title={t("sidebar.hideShortcut")}
        aria-label={t("sidebar.hide")}>&#x203a;</button
      >
    </header>

    <!--
      No tab strip: the sidebar is the chat.

      The second tab was called Schematic and then Generate, and neither name
      was wrong -- the drawer really did hold three unrelated things, so every
      rename only changed which of the three the name lied about. The file verbs
      went to the menu and the start screen, the version history to a floating
      window, the generated files to the start screen beside the recents, and
      the generator form turned out to be a second, worse chat: the chat has
      built a schematic from a sentence since the day it learned to, with the
      same model and the same progress. What was worth keeping from the form
      was the reference image and the export format, and those are inputs to a
      message rather than a panel.
    -->
    <div class="tab-body">
      <ChatPanel
        entries={chat}
        live={liveTrace}
        progress={progress !== null && progress.requestId === buildRequestId ? progress : null}
        {selection}
        {remembered}
        {rememberedFrom}
        {conversations}
        {activeConversationId}
        onrefreshconversations={() => void refreshConversations()}
        onrestore={(index) => void restoreCheckpoint(index)}
        onopenconversation={(id) => void openConversation(id)}
        ondeleteconversation={(id) => void deleteConversation(id)}
        hasDocument={docState !== null}
        {imageName}
        {acceptsImages}
        {blockedOnKey}
        imageHint={t("chat.imageUnsupported", { model: openCodeModel?.name ?? "" })}
        onpickimage={() => void pick("image")}
        onclearimage={() => {
          imagePath = null;
          imageName = null;
        }}
        {busy}
        running={inFlight !== null}
        {settings}
        {keyStatus}
        draft={chatDraft}
        ondraftchange={(next) => (chatDraft = next)}
        undoLabel={docState?.undoLabel ?? null}
        undoTransactionId={docState?.undoTransactionId ?? null}
        onask={askAgent}
        onforget={forgetConversation}
        onstop={stopAgent}
        onundo={() => runDocument(t("task.undoing"), () => api().undo())}
        onsettingschange={patchSettings}
        onopensettings={() => (settingsOpen = true)}
      />
    </div>
  </section>

  {#if !sidebarCollapsed}
    <SidebarSplitter
      width={sidebarWidth}
      onresize={(next) => (sidebarWidth = next)}
      oncommit={(next) => {
        sidebarWidth = next;
        void patchUi({ sidebarWidth: next });
      }}
    />
  {/if}

  <!--
    The drop target is the whole viewport rather than a dedicated zone: an
    empty viewport is exactly where someone will try to drop a file, and a
    small target inside it would be a worse guess than the obvious one.
  -->
  <section
    class="preview"
    class:drop-active={dropActive}
    aria-label={t("viewport.label")}
    ondragenter={onDragEnter}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    {#if sidebarCollapsed}
      <button
        class="icon show-panel"
        onclick={toggleSidebar}
        title={t("sidebar.showShortcut")}
        aria-label={t("sidebar.show")}>&#x2039;</button
      >
    {/if}

    <!--
      The status banner lives here, not in the Structure fieldset it was ported
      into. A preview error raised from the Render button at the bottom of a
      scrolling column used to render above the fold, off-screen -- visually
      indistinguishable from nothing happening.
    -->
    <!--
      Nothing open: say so, and offer the two things that fix it. Above the
      canvas rather than instead of it -- the scene keeps its floor. It covers
      the window now, and dropping a file still works: the handlers are on this
      section, the card stays a DOM child of it, and drag events bubble.
    -->
    {#if startVisible}
      <StartScreen
        ondismiss={() => (startDismissed = true)}
        recent={recentDocuments}
        {artifacts}
        {busy}
        onnew={() => void startNewDocument()}
        onopen={() => void openDocument()}
        onopenrecent={openDocumentAt}
        onopenartifact={(artifact) => void openDocumentAt(artifact.path)}
        onrevealartifact={(artifact) => api().revealPath(artifact.path)}
      />
    {/if}

    {#if dropActive}
      <div class="drop-hint" aria-hidden="true">
        <strong>{t("viewport.dropTitle")}</strong>
        <span>{t("viewport.dropTypes")}</span>
      </div>
    {/if}

    {#if recovery}
      <!--
        Deliberately blocking, unlike the status banner: this is the one
        question where dismissing it by accident loses work permanently, so it
        does not have a close button and both answers are explicit.
      -->
      <div class="recovery" role="alertdialog" aria-labelledby="recovery-title">
        <strong id="recovery-title">{t("recovery.title")}</strong>
        <p>
          {t("recovery.body", {
            name: recovery.fileName ?? t("recovery.unnamed"),
            blocks: recovery.blockCount.toLocaleString(),
            when: new Date(recovery.savedAt).toLocaleString(),
          })}
        </p>
        <div class="buttons">
          <button class="primary" onclick={() => resolveRecovery(true)} disabled={busy}>
            {t("recovery.restore")}
          </button>
          <button onclick={() => resolveRecovery(false)} disabled={busy}>
            {t("recovery.discard")}
          </button>
        </div>
      </div>
    {/if}

    {#if status}
      <div class={`status ${status.tone}`} role="status">
        <div>
          {status.text}
          {#if status.detail}<br /><small>{status.detail}</small>{/if}
        </div>
        <button class="icon" onclick={() => (status = null)} aria-label={t("common.dismiss")}>
          &#x00d7;
        </button>
      </div>
    {/if}

    <!--
      The way back to the tools, and the reason "close" can mean close.
      Top-left, which is where the window itself opens, so the panel appears
      more or less from under the button that summoned it -- but below the
      HUD line, which it used to sit on top of.
    -->
    {#if docState && !toolsOpen && selection !== null}
      <button
        class="reopen-tools"
        onclick={() => (toolsOpen = true)}
        title={t("command.showTools")}
      >
        {t("selection.legend")}
      </button>
    {/if}

    <!--
      Only while there is something selected.
      
      Every control in it acts on a region, so with none there was a panel of
      disabled buttons taking up the corner of the viewport and explaining
      itself with a hint. Select All moved to Ctrl+A and the palette, which is
      the one thing in here that never needed a selection to begin with.
    -->
    {#if docState && toolsOpen && selection !== null}
      <ToolWindow
        title={t("selection.legend")}
        x={toolWindowX}
        y={toolWindowY}
        width={toolWindowW}
        height={toolWindowH}
        closeLabel={t("common.close")}
        onmove={(x, y) => {
          toolWindowX = x;
          toolWindowY = y;
        }}
        oncommit={(x, y) => {
          toolWindowX = x;
          toolWindowY = y;
          void patchUi({ toolWindowX: x, toolWindowY: y });
        }}
        onresize={(w, h) => {
          toolWindowW = w;
          toolWindowH = h;
        }}
        onresizecommit={(w, h) => {
          toolWindowW = w;
          toolWindowH = h;
          void patchUi({ toolWindowW: w, toolWindowH: h });
        }}
        onclose={() => (toolsOpen = false)}
      >
        <SelectionTools
          {selection}
          {busy}
          blocks={blockRegistry}
          placeable={placeableBlocks}
          legacy={legacyForDoc}
          block={activeBlock}
          onblockchange={holdBlock}
          replaceFrom={replaceBlock}
          onreplacefromchange={(next) => (replaceBlock = next)}
          onbrowse={browseBlocks}
          palette={docState?.palette ?? []}
          {clipboard}
          onfill={fillSelection}
          onreplace={replaceInSelection}
          ontransform={transformSelection}
          oncopy={() => void copySelection(false)}
          oncut={() => void copySelection(true)}
          onpaste={pasteHere}
          ondelete={() => void deleteSelection()}
          moving={moving !== null}
          onmove={() => (moving === null ? void startMove() : cancelMove())}
          onclearselection={clearSelection}
          onselectall={selectAll}
        />
      </ToolWindow>
    {/if}

    <!--
      Only for a single block, because that is the only time the panel is
      telling the truth. Sweeping out a region left it showing whichever block
      the gesture happened to start on, labelled with that block's coordinates,
      beside a selection of nine hundred others.
    -->
    {#if docState && inspectorOpen && inspection !== null && singleBlockSelection}
      <ToolWindow
        title={t("inspector.title")}
        x={inspectorWindowX}
        y={inspectorWindowY}
        width={inspectorWindowW}
        height={inspectorWindowH}
        closeLabel={t("common.close")}
        onmove={(x, y) => {
          inspectorWindowX = x;
          inspectorWindowY = y;
        }}
        oncommit={(x, y) => {
          inspectorWindowX = x;
          inspectorWindowY = y;
          void patchUi({ inspectorWindowX: x, inspectorWindowY: y });
        }}
        onresize={(w, h) => {
          inspectorWindowW = w;
          inspectorWindowH = h;
        }}
        onresizecommit={(w, h) => {
          inspectorWindowW = w;
          inspectorWindowH = h;
          void patchUi({ inspectorWindowW: w, inspectorWindowH: h });
        }}
        onclose={() => (inspectorOpen = false)}
      >
        <InspectorPanel
          {inspection}
          at={inspectedAt}
          {busy}
          legacy={legacyForDoc}
          onchangeproperty={changeBlockProperty}
          onchangenbt={changeNbtValue}
        />
      </ToolWindow>
    {/if}

    <!--
      The version history. A reflection of the open document, exactly like the
      inspector, and it was a sidebar tab for the same bad reason: it arrived
      when there was a drawer to put things in.
    -->

    <Viewer
      {mesh}
      {sunAzimuth}
      {sunElevation}
      selection={docState ? selection : null}
      onpick={docState ? onPick : undefined}
      {cameraMode}
      flySpeed={settings.preview.flySpeed}
      framingKey={framingEpoch}
      onbuild={docState ? (action, at, look) => void onBuild(action, at, look) : undefined}
      onselectionchange={docState ? onSelectionDragged : undefined}
      onselectiongesture={docState ? onSelectionGesture : undefined}
      onpickmaterial={docState ? onPickMaterial : undefined}
      ghost={moving}
      onghostcommit={(to) => void commitMove(to)}
      documentSize={docState?.size ?? null}
      ongridselect={docState ? onGridSelect : undefined}
      ongridplace={docState ? (at, look) => void onGridPlace(at, look) : undefined}
      maxDpr={settings.preview.maxDpr}
      renderScale={settings.preview.renderScale}
      maxDrawDistance={settings.preview.maxDrawDistance}
      projection={settings.preview.projection}
      showGrid={settings.preview.showGrid}
      showBounds={settings.preview.showBounds}
      voidOpacity={settings.editing.voidOpacity}
      wireframe={settings.preview.wireframe}
      sky={settings.preview.sky}
      {skyTextures}
      anchor={worldEditAnchor}
      {anchorTexture}
      showAnchor={settings.preview.showWorldEditOffset}
      timeOfDay={clockTicks}
      shadows={settings.preview.shadows}
      shadowQuality={settings.preview.shadowQuality}
      ground={settings.preview.ground}
      groundColor={settings.preview.groundColor}
      theme={resolvedTheme}
    />

    <!--
      In both camera modes. It was creative-only while orbit had a block field
      of its own; that field writes the slot now, so there is one answer to
      "what am I holding" and it is on screen wherever you are.
    -->
    <Hotbar
      slots={hotbar}
      active={hotbarSlot}
      visible={docState !== null}
      ownsWheel={cameraMode === "fly" && !inventoryOpen}
      onopeninventory={() => browseBlocks("hand")}
      onselect={holdSlot}
      onedit={(slot) => {
        hotbar = hotbar.map((id, at) => (at === slot ? activeBlock : id));
        persistHotbar();
      }}
    />
    {#if bounds}
      <!-- component.py:465-469's caption, same two-decimal formatting. -->
      <footer>
        {t("viewport.bounds", {
          center: bounds.center.map((n) => n.toFixed(2)).join(", "),
          size: bounds.size.map((n) => n.toFixed(2)).join(", "),
        })}
      </footer>
    {/if}
  </section>
</main>

<style>
  /*
   * `grid-template-rows: 100%` is the fix, not decoration. With only
   * `grid-template-columns` declared, the single implicit row is `auto` and
   * grows to the tallest item -- so `main`'s `height: 100%` was never the
   * height of anything, the left column's `overflow-y: auto` had no box to
   * overflow, and the excess propagated to the document scrollbar, which
   * scrolled the canvas along with the controls.
   *
   * `min-height: 0` on the children is the second half: a grid item's
   * automatic minimum size is its content size, so without it a tall column
   * refuses to shrink into the row no matter what the row says.
   */
  main {
    --navbar-h: 44px;

    display: grid;
    /* Viewport, splitter, sidebar -- the sidebar is the *last* column now. */
    grid-template-columns: 1fr auto var(--sidebar-w);
    grid-template-rows: var(--navbar-h) minmax(0, 1fr);
    height: 100%;
    overflow: hidden;
  }

  main.collapsed {
    grid-template-columns: 1fr 0 0;
  }

  .navbar {
    grid-column: 1 / -1;
    grid-row: 1;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 14px;
    min-width: 0;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
  }

  /*
   * Every track is assigned explicitly. Auto-placement is not safe here: the
   * splitter leaves the DOM when the panel collapses, and without these the
   * viewport slid into the (0px) splitter track and rendered at zero width --
   * the precise opposite of what collapsing is for.
   */
  /*
   * A flex column that does not scroll: the tab body below does. The column
   * itself scrolling is what put the chat's input off the bottom of the window
   * as a conversation grew, and it is why the chat gets a tab of its own.
   */
  .controls {
    grid-column: 3;
    grid-row: 2;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
    min-height: 0;
    padding: 12px 18px 16px;
    border-left: 1px solid var(--border);
  }

  /* The chat scrolls its own log and pins its own composer, so this must not
     scroll: nesting two scrollers is what made the old panel's input drift
     away down the column. */
  .tab-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  main :global(.splitter) {
    grid-column: 2;
    grid-row: 2;
  }

  main.collapsed .controls {
    display: none;
  }

  /*
   * The collapse arrow alone, and pushed to the right-hand edge: the title it
   * used to sit beside now lives in the navbar, and the arrow has to point at
   * the edge the panel disappears towards or it reads as the wrong control.
   */
  .sidebar-head {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 12px;
  }

  .preview {
    grid-column: 1;
    grid-row: 2;
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  /*
   * Where the tool window lives, so the two read as the same object: the
   * button is what the panel collapses into.
   *
   * Below the viewport's HUD line, not on it. Both were at `top: 16px;
   * left: 16px` in the same containing block, and this one carries a
   * `z-index` while the HUD does not -- so a 26px glyph painted straight over
   * the text telling you how to fly. It is named rather than glyphed for the
   * same reason: there is no icon for "the selection tools" anyone reads
   * correctly, and this is the only thing that brings them back.
   */
  .reopen-tools {
    position: absolute;
    top: 64px;
    left: 16px;
    z-index: 3;
    padding: 5px 12px;
    font-size: 12px;
  }

  /* Against the edge the panel will slide back in from. */
  .show-panel {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 3;
  }

  .preview.drop-active::after {
    content: "";
    position: absolute;
    inset: 8px;
    z-index: 4;
    border: 2px dashed var(--accent);
    border-radius: 10px;
    background: var(--accent-tint);
    /* The overlay must not eat the drop event it is drawn for. */
    pointer-events: none;
  }

  .drop-hint {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 14px 22px;
    border-radius: 10px;
    background: var(--bg-panel);
    box-shadow: 0 8px 28px var(--shadow);
    pointer-events: none;
  }

  .drop-hint span {
    font-size: 12px;
    color: var(--text-dim);
  }

  .recovery {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 6;
    width: min(440px, calc(100% - 48px));
    padding: 16px 18px;
    border: 1px solid var(--accent);
    border-radius: 10px;
    background: var(--bg-panel);
    box-shadow: 0 12px 40px var(--shadow);
  }

  .recovery p {
    margin: 8px 0 14px;
    font-size: 13px;
    color: var(--text-dim);
  }

  .recovery .buttons {
    display: flex;
    gap: 8px;
  }

  /* Floated to the trailing edge, away from the title-and-mode group. */
  .gear {
    margin-left: auto;
    font-size: 18px;
  }

  /* Sized like the camera-mode buttons beside it rather than like a `.icon`,
     which is a 28px square and would crop the word. */
  .nbt-open {
    padding: 4px 10px;
    font-size: 12px;
  }

  .camera-modes {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: 8px;
    background: var(--bg-input);
    border: 1px solid var(--border);
  }

  .camera-modes button {
    padding: 4px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    font-size: 12px;
  }

  .camera-modes button.active {
    background: var(--accent);
    color: var(--accent-contrast);
  }

  .projection {
    display: flex;
    flex: none;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    white-space: nowrap;
  }

  /* Greyed rather than hidden: a control that comes and goes with the
     camera mode reads as a bug in the bar. */
  .projection:has(input:disabled) {
    opacity: 0.5;
  }

  .preview :global(.viewer) {
    flex: 1;
  }

  footer {
    padding: 8px 16px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-dim);
  }

  .status {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 4;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    max-width: min(680px, calc(100% - 96px));
    padding: 10px 10px 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-panel);
    box-shadow: 0 6px 20px var(--shadow);
    font-size: 13px;
  }

  .status.ok {
    color: var(--ok);
    border-color: var(--ok);
  }

  .status.warn {
    color: var(--warn);
    border-color: var(--warn);
  }

  .status.error {
    color: var(--danger);
    border-color: var(--danger);
  }
</style>
