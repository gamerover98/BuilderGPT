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
  import InspectorPanel from "./lib/InspectorPanel.svelte";
  import SettingsModal from "./lib/SettingsModal.svelte";
  import SelectionTools from "./lib/SelectionTools.svelte";
    import ToolWindow from "./lib/ToolWindow.svelte";
  import { findOpenCodeModel, loadOpenCodeModels } from "./lib/models.svelte.js";
  import SidebarSplitter from "./lib/SidebarSplitter.svelte";
import StartScreen from "./lib/StartScreen.svelte";
import StartupScreen, { type StartupStep } from "./lib/StartupScreen.svelte";
import VersionList from "./lib/VersionList.svelte";
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
  import { isTyping } from "./lib/typing.js";
  import { versionNameOf } from "../../shared/mc_versions.js";
  import { orientPlacement, type PlacementLook } from "../../shared/block_orientation.js";
  import { t, tn, setLocale } from "./lib/i18n.svelte.js";
  import {
    openCodeModelRequiresKey,
    type TraceItem,
    type Artifact,
    type BlockInspection,
    type ChatEntry,
    type ProjectNotes,
    type ChatState,
    type ConversationSummary,
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
  import {
    DEFAULT_SETTINGS,
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

  /** The registry, for the block pickers to search — fetched once at startup. */
  let blockRegistry = $state<string[]>([]);

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

  /**
   * Building from the crosshair. One block, one transaction — the same edit the
   * panel makes, so Ctrl+Z treats them alike.
   *
   * The block is turned to face the way the game would turn it. That is a
   * default and not an instruction, which is why the orientation goes *under*
   * whatever the held block already spelled out: `oak_stairs[facing=north]`
   * typed into the block field means north, wherever the camera happens to be
   * pointing.
   */
  async function onBuild(
    action: "place" | "break",
    at: { x: number; y: number; z: number },
    look: PlacementLook,
  ): Promise<void> {
    if (busy) return;
    const held = parseBlock(placingBlock);
    const block =
      action === "break"
        ? { namespacedName: "minecraft:air" }
        : {
            ...held,
            properties: {
              ...orientPlacement(held.namespacedName, look),
              ...(held.properties ?? {}),
            },
          };
    await runDocument(action === "break" ? t("task.breakingBlock") : t("task.placingBlock"), () =>
      api().applyEdit({ kind: "setBlock", x: at.x, y: at.y, z: at.z, block }),
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

  const SCHEMATIC_EXTENSIONS = [".schem", ".schematic"];

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
        // ...and a session whose conversation did not survive the crash.
        chat = [];
        liveTrace = [];
        remembered = 0;
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
        inspectorWindowX = settings.ui.inspectorWindowX;
        inspectorWindowY = settings.ui.inspectorWindowY;
        versionsWindowX = settings.ui.versionsWindowX;
        versionsWindowY = settings.ui.versionsWindowY;
        hotbar = [...settings.ui.hotbar];
        hotbarSlot = settings.ui.hotbarSlot;
        keyStatus = await api().getKeyStatus();
        step("settings", "done");

        step("catalogue", "running");
        versions = await api().listVersions();
        artifacts = await api().listArtifacts();
        defaultOutputDir = await api().getDefaultOutputDir();
        blockRegistry = await api().listBlocks();
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
    ];

    return () => {
      window.removeEventListener("keydown", onWindowKey);
      dark.removeEventListener("change", onSystemTheme);
      unsubscribe();
      unsubscribeStartup();
      unsubscribeTrace();
      for (const off of unsubscribeMenu) off();
    };
  });

  function onWindowKey(event: KeyboardEvent): void {
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
    } else if ((key === "y" || (key === "z" && event.shiftKey)) && !editingText) {
      event.preventDefault();
      void redoAnything();
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
  let versionsWindowX = $state(DEFAULT_UI_SETTINGS.versionsWindowX);
  let versionsWindowY = $state(DEFAULT_UI_SETTINGS.versionsWindowY);

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
    // Creative mode holds the pointer, and a locked pointer means the keys the
    // user is about to type are also steering the camera. Releasing it is what
    // makes the palette usable from flight rather than a way to fly into a wall.
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
      enabled: !busy && docState !== null,
      run: selectAll,
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
      id: "clear-selection",
      title: t("command.clearSelection"),
      group: t("group.edit"),
      enabled: !busy && selection !== null,
      run: () => {
        selection = null;
        anchor = null;
      },
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
      enabled: inspection !== null,
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
      id: "settings",
      title: t("settings.title"),
      group: t("group.view"),
      keywords: t("settings.keywords"),
      shortcut: "Ctrl+,",
      enabled: true,
      run: () => (settingsOpen = true),
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
    await patchSettings({ preview: { ...settings.preview, ...patch } });
    // Every other preview setting is applied by the viewer on the GLB it
    // already has. The two tints are baked into the texture atlas, so they are
    // the ones that need the mesh rebuilt.
    const rebuilds =
      patch.biomeColor !== undefined ||
      patch.waterColor !== undefined ||
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

  async function pick(kind: "image" | "resource-pack" | "directory"): Promise<void> {
    let picked: Awaited<ReturnType<ReturnType<typeof api>["pickFile"]>>;
    try {
      picked = await api().pickFile({ kind });
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
      status = null;
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
    const trimmed = text.trim();
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
    const properties = { ...inspection.properties, [name]: value.trim() };
    await runDocument(t("task.changingBlockState"), () =>
      api().applyEdit({
        kind: "setBlock",
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
        tone: response.degraded.length > 0 ? "warn" : "ok",
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

  /** Where Save As opens: this file's own folder and name, or a plain default. */
  function suggestedSavePath(format: SchematicFormat): string {
    const extension = format === "mcedit" ? "schematic" : "schem";
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
  version={project?.version ?? versionNameOf(docState?.dataVersion ?? null) ?? settings.version}
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
    version:
      project?.version ?? versionNameOf(docState?.dataVersion ?? null) ?? settings.version,
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
  onclose={() => (settingsOpen = false)}
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
      canvas rather than instead of it -- the scene keeps its floor, and the
      card is the only part that takes the pointer, so a file can still be
      dropped anywhere around it.
    -->
    {#if docState === null && recovery === null}
      <StartScreen
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
      more or less from under the button that summoned it.
    -->
    {#if docState && !toolsOpen}
      <button
        class="icon reopen-tools"
        onclick={() => (toolsOpen = true)}
        title={t("command.showTools")}
        aria-label={t("command.showTools")}
      >
        &#x2317;
      </button>
    {/if}

    {#if docState && toolsOpen}
      <ToolWindow
        title={t("selection.legend")}
        x={toolWindowX}
        y={toolWindowY}
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
        onclose={() => (toolsOpen = false)}
      >
        <SelectionTools
          {selection}
          {busy}
          blocks={blockRegistry}
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
          onclearselection={() => {
            selection = null;
            anchor = null;
          }}
          onselectall={selectAll}
        />
      </ToolWindow>
    {/if}

    {#if docState && inspectorOpen && inspection !== null}
      <ToolWindow
        title={t("inspector.title")}
        x={inspectorWindowX}
        y={inspectorWindowY}
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
        onclose={() => (inspectorOpen = false)}
      >
        <InspectorPanel
          {inspection}
          at={inspectedAt}
          {busy}
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
    {#if docState && versionsOpen}
      <ToolWindow
        title={t("versions.legend")}
        x={versionsWindowX}
        y={versionsWindowY}
        closeLabel={t("common.close")}
        onmove={(x, y) => {
          versionsWindowX = x;
          versionsWindowY = y;
        }}
        oncommit={(x, y) => {
          versionsWindowX = x;
          versionsWindowY = y;
          void patchUi({ versionsWindowX: x, versionsWindowY: y });
        }}
        onclose={() => (versionsOpen = false)}
      >
        <VersionList
          versions={documentVersions}
          {busy}
          saved={docState?.filePath != null}
          onsave={() => void saveVersion("manual", "")}
          onrestore={(id) => void restoreVersion(id)}
          ondelete={(id) => void deleteVersion(id)}
        />
      </ToolWindow>
    {/if}

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
      documentSize={docState?.size ?? null}
      ongridselect={docState ? onGridSelect : undefined}
      ongridplace={docState ? (at, look) => void onGridPlace(at, look) : undefined}
      maxDpr={settings.preview.maxDpr}
      renderScale={settings.preview.renderScale}
      maxDrawDistance={settings.preview.maxDrawDistance}
      showGrid={settings.preview.showGrid}
      wireframe={settings.preview.wireframe}
      ambientOcclusion={settings.preview.ambientOcclusion}
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
   */
  .reopen-tools {
    position: absolute;
    top: 16px;
    left: 16px;
    z-index: 3;
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
