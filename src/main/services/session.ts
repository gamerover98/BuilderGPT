/**
 * The open document: what the window is currently editing.
 *
 * One session at a time, matching one window. Everything the renderer can do to
 * a schematic goes through here, and nothing else holds a reference to the
 * document -- so the invariants that make undo work (the append-only palette,
 * mutations only inside a transaction) have exactly one place to be enforced.
 *
 * The renderer never receives the document. It receives `DocumentState`, which
 * is small, flat and structured-clone-safe, plus a GLB when it asks for one. A
 * schematic is millions of voxels and a `Map` of NBT; neither survives the IPC
 * boundary, and neither should try.
 */

import path from "path";

import type {
  ChunkGeometry,
  ChunkLayer,
  ChunkRef,
  DocumentState,
  EditRequest,
  MeshPayload,
  PaletteCount,
  RegionSpec,
} from "../../shared/ipc.js";
import type { SchematicFormat } from "../../shared/schematic.js";
import { schematicExtension } from "../../shared/schematic.js";
import {
  countBlocks,
  createDocument,
  documentFromLoaded,
  getBlock,
  markSaved,
  normalizeRegion,
  paletteHistogram,
  regionVolume,
  setBlock,
  type Region,
  type SchematicDocument,
} from "../domain/document.js";
import {
  canRedo,
  canUndo,
  createHistory,
  isDirty,
  markHistorySaved,
  nextRedoLabel,
  nextUndoId,
  nextUndoLabel,
  redo,
  readHeader,
  runTransaction,
  undo,
  type History,
  type TransactionScope,
} from "../domain/history.js";

import {
  copyRegion,
  pasteClipboard,
  type Clipboard,
  type PasteOptions,
} from "../domain/clipboard.js";
import { flattenNbt, setNbtValue } from "../domain/nbt_edit.js";
import {
  applyRegionScale,
  applyRegionTransform,
  describeTransform,
  NotSquareError,
  scaledExtent,
  scaleWouldDrop,
  type RegionTransform,
  type ScaleSpec,
} from "../domain/transform.js";

export { NotSquareError, type RegionTransform };
import { loadStructure } from "../pipeline/loader.js";
import type { PaletteEntry } from "../pipeline/types.js";
import { matchesBlockPattern, paletteEntryCacheKey } from "../pipeline/types.js";
import { parsePaletteEntry } from "../pipeline/loader_formats.js";
import { hasProperty, isOpenable } from "../../shared/block_states.js";
import { FACE_VECTOR } from "../../shared/block_orientation.js";
import { normaliseVoidBlock, voidSources } from "../../shared/settings.js";
import { mcVersion, refusalFor } from "../../shared/mc_versions.js";
import {
  blockExistsIn,
  propertyExistsIn,
  propertyValueIn,
  renameFor,
} from "../../shared/block_versions.js";
import { DOCUMENT_SIZE } from "../../shared/settings.js";
import { buildDocumentPreview, type DocumentPreviewOptions } from "./preview.js";
import type { ChunkMeshCache } from "../pipeline/chunked_mesh.js";
import { saveDocument, type WriteResult } from "./writers.js";
import { cropToContent, type CropSummary } from "../domain/crop.js";
import {
  extentVolume,
  growthToInclude,
  orderRegion,
  shiftRegion,
  type Extent,
} from "../domain/grow.js";
import { peelEmptyFaces } from "../domain/shrink.js";

export interface DocumentSession {
  readonly doc: SchematicDocument;
  readonly history: History;
  /**
   * The GLB last handed out, and everything it was built from — the document's
   * revision *and* the preview options that reach the atlas. See `documentMesh`.
   */
  mesh: { key: string; payload: MeshPayload; center: [number, number, number]; size: [number, number, number] } | null;
  /**
   * Per-chunk geometry carried between rebuilds, so an edit re-meshes only the
   * chunks it touched. Belongs to the session because it is per document; the
   * baker and atlas behind it are shared and live in `preview.ts`.
   */
  meshCache?: ChunkMeshCache;
  /**
   * What the renderer was last *sent*, so the next answer can be the
   * difference.
   *
   * The token is the mesh key it was sent with; the map is chunk key to the
   * `positions` array of the geometry it received. Identity is the whole test:
   * `buildChunkedMesh` reuses the very same `MeshBuffers` object for a chunk it
   * did not re-mesh, so a chunk whose positions array is the one already on the
   * other side is a chunk that has not changed.
   *
   * Kept per session because it describes one document. There is exactly one
   * window, which is what makes "what the renderer holds" a thing main can
   * know at all -- and the token means a wrong guess costs a full payload
   * rather than a wrong picture.
   */
  sent?: { token: string; chunks: Map<string, Float32Array> } | null;
  /**
   * What empty space is made of in *this* document. `""` is air.
   *
   * On the session rather than in `Settings`, and that is the whole change:
   * a break writes this block into the file, so it is a fact about one
   * schematic. As a global it followed you between documents quietly
   * changing what a break wrote.
   *
   * Seeded from `ProjectNotes` when the document has a path and written
   * back there on save. A document with **no path has no sidecar**, so the
   * value lives here for the session and is persisted at the first save --
   * the same rule conversations and version history already follow.
   *
   * Not on `SchematicDocument`: it is not part of the schematic, it does
   * not belong on the undo stack, and putting it there would make it a
   * thing `history.ts` had to capture and restore.
   */
  voidBlock: string;
  /**
   * What the reader had to say about the file it came from.
   *
   * Only a `.mcfunction` ever fills this: an NBT container either parses or it
   * does not, but a list of commands can be *partly* read -- lines that are
   * neither `setblock` nor `fill` are not in the build, and a `function` call
   * that resolves to nothing is a whole file's worth of it missing. Silence
   * there would read as the app having lost half the schematic.
   */
  notes?: readonly string[];
}

let current: DocumentSession | null = null;

export class NoDocumentError extends Error {
  constructor() {
    super("No schematic is open");
    this.name = "NoDocumentError";
  }
}

/**
 * A region larger than this is refused rather than attempted.
 *
 * Not arbitrary: an edit records one delta per changed voxel, so an unbounded
 * fill is an unbounded allocation on the undo stack, reached by typing two
 * numbers. The limit is generous next to any hand-made build and small enough
 * that hitting it by accident costs a message rather than the process.
 */
export const MAX_EDIT_VOLUME = 8_000_000;

export function currentSession(): DocumentSession | null {
  return current;
}

export function requireSession(): DocumentSession {
  if (current === null) {
    throw new NoDocumentError();
  }
  return current;
}

export function closeDocument(): void {
  current = null;
}

export interface OpenOptions {
  legacyBlocksPath?: string | null;
}

export async function openDocument(
  filePath: string,
  options: OpenOptions = {},
): Promise<DocumentSession> {
  const loaded = await loadStructure(filePath, {
    legacyBlocksPath: options.legacyBlocksPath ?? null,
  });
  /*
   * A `.mcfunction` is read but never *becomes* the document's format: it has
   * no metadata, no anchor tag, no DataVersion and no NBT root. So the document
   * is a Sponge v3 one with **no path**, and Save falls through to Save As on
   * its own -- which `saveDocument` has done since the day the third caller
   * turned out not to have that check written out.
   *
   * Keeping the path would be worse than losing it: a plain Save would write a
   * Sponge file over the `.mcfunction` it came from, under that name.
   */
  const imported = loaded.sourceKind === "mcfunction";
  current = {
    doc: documentFromLoaded(loaded, imported ? null : filePath),
    history: createHistory(),
    mesh: null,
    // Air until the caller says otherwise. `openDocument` cannot read the
    // sidecar itself: `conversation.ts` needs Electron for `userData`, and
    // this module is reachable from the suites. The handler seeds it.
    voidBlock: "",
    notes: loaded.notes,
  };
  return current;
}

/** A blank document, for building from nothing. */
export function newDocument(
  size: { width: number; height: number; length: number },
  format: SchematicFormat = "sponge3",
  dataVersion: number | null = null,
): DocumentSession {
  current = {
    doc: createDocument({ ...size, format, dataVersion }),
    history: createHistory(),
    mesh: null,
    voidBlock: "",
  };
  return current;
}

/**
 * Adopts an already-built document, as generation produces and as crash
 * recovery rebuilds.
 *
 * `history` is optional but load-bearing when it is passed: a recovered
 * document arrives with a history whose saved point is deliberately
 * unreachable, marking it as differing from disk. Handing it a fresh one would
 * open unsaved recovered work and call it clean.
 */
export function adoptDocument(doc: SchematicDocument, history?: History): DocumentSession {
  /*
   * The void block carries over, and that is decided here rather than at
   * the call sites on purpose.
   *
   * Every caller of this function is restoring *another state of the same
   * file* -- a version, a checkpoint, a crash snapshot. What empty space is
   * made of has not changed, so resetting it to air would quietly undo the
   * choice on every Ctrl+Z-shaped gesture that is not actually an undo, and
   * the next break would start writing air into an underwater build.
   *
   * Opening a *different* file goes through `openDocument`, which builds a
   * session from nothing and never comes through here. That asymmetry is
   * what makes inheriting safe: there is no path into this function that
   * means "a different schematic".
   */
  current = {
    doc,
    history: history ?? createHistory(),
    mesh: null,
    voidBlock: current?.voidBlock ?? "",
  };
  return current;
}

// ---------------------------------------------------------------------------
// State for the renderer
// ---------------------------------------------------------------------------

/**
 * Every block in the document, most common first.
 *
 * It was capped at 64, silently, while the panel showing it capped at 8 and
 * said "…and N more" -- so past 64 distinct states that sentence *understated*
 * the palette, which is worse than either cap alone. A schematic's materials
 * list is one of the few things worth being complete: it is how you find the
 * one stray block you did not mean to place.
 *
 * The cost is already paid. `paletteHistogram` walks every voxel and runs on
 * every state push either way; dropping the `.slice` adds payload, not work.
 */
function paletteCounts(doc: SchematicDocument): PaletteCount[] {
  return [...paletteHistogram(doc).entries()]
    .filter(([block]) => !block.startsWith("minecraft:air"))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([block, count]) => ({ block, count }));
}

export function documentState(session: DocumentSession): DocumentState {
  const { doc, history } = session;
  return {
    filePath: doc.filePath,
    fileName: doc.filePath === null ? null : path.basename(doc.filePath),
    format: doc.format,
    dataVersion: doc.dataVersion,
    size: [doc.width, doc.height, doc.length],
    offset: doc.offset === null ? null : ([...doc.offset] as [number, number, number]),
    worldOrigin: doc.worldOrigin === null ? null : ([...doc.worldOrigin] as [number, number, number]),
    blockCount: countBlocks(doc),
    palette: paletteCounts(doc),
    dirty: isDirty(history),
    canUndo: canUndo(history),
    undoDepth: history.undoStack.length,
    canRedo: canRedo(history),
    undoLabel: nextUndoLabel(history),
    undoTransactionId: nextUndoId(history),
    redoLabel: nextRedoLabel(history),
    voidBlock: session.voidBlock,
    revision: doc.revision,
  };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function toEntry(block: { namespacedName: string; properties?: Record<string, string> }): PaletteEntry {
  return { namespacedName: block.namespacedName, properties: block.properties ?? {} };
}

/**
 * A block that cannot exist in the version this schematic is for.
 *
 * Refused where it is typed rather than at save time, which is the whole
 * point: `buildMcEdit` already refuses these, by throwing
 * `UnrepresentableBlocksError` over the *whole palette* once the user asks to
 * save. That is a correct objection arriving hours late, naming blocks placed
 * long enough ago to have been built around.
 *
 * The message names the way out as well as the problem, because there is one
 * and it is not obvious: the schematic's version can be changed. Without that
 * sentence this is a dead end that reads as the app refusing to let you build.
 */
/**
 * A version change that would destroy blocks, refused until it is confirmed.
 *
 * `resizeSession`'s shape and for its reason: the count is the thing the user
 * needs, it can only be known by looking, so the first attempt is the one that
 * reports it. Main must not raise a dialog -- the request may not have come
 * from anybody at a keyboard.
 *
 * **It counts only what is actually lost.** A block that was *renamed* is not in
 * here: `chain` becoming `iron_chain` costs nothing, and asking somebody to
 * confirm it would teach them to confirm the sentence that means the opposite.
 *
 * `FailureKind` carries `needs-confirmation` already, which is what lets the
 * panel offer to go ahead **without matching on this wording**. A renderer that
 * read the sentence would turn a reworded refusal into a silent dead end.
 */
export class VersionWouldLoseBlocksError extends Error {
  constructor(
    readonly blocks: readonly string[],
    readonly count: number,
    readonly versionLabel: string,
    readonly replacement: string,
  ) {
    const shown = blocks.slice(0, 6).join(", ");
    const rest = blocks.length - 6;
    const more = rest > 0 ? ", and " + String(rest) + " more" : "";
    super(
      `${count.toLocaleString()} block(s) of ${blocks.length} type(s) do not exist in ` +
        `Minecraft ${versionLabel} and would be replaced with ${replacement}: ` +
        `${shown}${more}. This can be undone.`,
    );
    this.name = "VersionWouldLoseBlocksError";
  }
}

/** A version string this build has never heard of. */
export class UnknownVersionError extends Error {
  constructor(version: string) {
    super(`${version} is not a Minecraft version this build knows.`);
    this.name = "UnknownVersionError";
  }
}

/** A version the open container cannot carry; the message is `refusalFor`'s. */
export class VersionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionRefusedError";
  }
}

export class BlockNotInVersionError extends Error {
  constructor(
    readonly block: string,
    readonly versionLabel: string,
  ) {
    super(
      `${block} does not exist in Minecraft ${versionLabel}, which is what this ` +
        `schematic is for. Pick a block from that version, or change the ` +
        `schematic's Minecraft version.`,
    );
    this.name = "BlockNotInVersionError";
  }
}

export class EditTooLargeError extends Error {
  constructor(volume: number) {
    super(
      `That region covers ${volume.toLocaleString()} blocks, more than the ` +
        `${MAX_EDIT_VOLUME.toLocaleString()} an edit may touch at once.`,
    );
    this.name = "EditTooLargeError";
  }
}

/**
 * How large the schematic itself may become.
 *
 * The editor imposes no footprint of its own -- a region may be dragged outside
 * the box and filling it grows the document to suit. This is not that kind of
 * limit; it is the one that stops the process dying. The voxels are an
 * `Int32Array`, so this is four bytes each, and a document big enough to
 * exhaust memory would take the app down rather than report anything.
 */
export const MAX_DOCUMENT_VOLUME = 32_000_000;

/**
 * The edit reached outside the box and the box is not allowed to move.
 *
 * Refused by name rather than clipped. Clipping is the failure this codebase
 * already wrote down once: a fill asking for the universe quietly became a
 * full fill of whatever was open, reported a healthy `changed`, and read as
 * success. With auto-grow off the same silence would put the same edit
 * against the wall of the box and say nothing about the part that fell off.
 */
export class OutsideDocumentError extends Error {
  constructor() {
    super(
      "That reaches outside the schematic, and automatic resizing is off. Turn it back on in Dimensions, or set the size you want there first.",
    );
    this.name = "OutsideDocumentError";
  }
}

/**
 * A shrink that would destroy blocks, asked for without saying so.
 *
 * The refusal *is* the answer, which is `discard_prompt.ts`'s rule arrived at
 * from a different direction: a warning shown after the blocks are gone is
 * not a warning, and main cannot raise a dialog of its own for something that
 * may not have come from a person at the keyboard. So it comes back counted,
 * and the caller asks again with `confirmLoss`.
 *
 * The step is undoable either way -- `tx.resize` records what it dropped --
 * so this is about not being surprised, not about being unable to recover.
 */
export class ResizeWouldLoseBlocksError extends Error {
  constructor(public readonly blocks: number) {
    super(
      `That size leaves ${blocks.toLocaleString()} block${blocks === 1 ? "" : "s"} outside ` +
        `the schematic, and they would be removed. Confirm to go ahead.`,
    );
    this.name = "ResizeWouldLoseBlocksError";
  }
}

export class DocumentTooLargeError extends Error {
  constructor(volume: number) {
    super(
      `That would make the schematic ${volume.toLocaleString()} blocks, more than the ` +
        `${MAX_DOCUMENT_VOLUME.toLocaleString()} one may hold. Build it in pieces, or trim ` +
        `it back by saving -- saving keeps only what is not air.`,
    );
    this.name = "DocumentTooLargeError";
  }
}

/**
 * Where a placed slab should merge into the slab it was placed against, if it
 * should merge at all.
 *
 * `null` means "place normally", which is every case but one: the block is a
 * slab, the click came off a vertical face, and the cell on the other side of
 * that face holds *the same* slab in the complementary half. Same material,
 * because an oak slab does not merge into a stone one; complementary half,
 * because two bottom slabs are not a full block and never become one.
 */
function doubleSlabTarget(
  doc: SchematicDocument,
  request: { x: number; y: number; z: number; against?: string },
  entry: PaletteEntry,
): { x: number; y: number; z: number; entry: PaletteEntry } | null {
  if (!entry.namespacedName.endsWith("_slab")) return null;
  const below = request.against === "up";
  if (!below && request.against !== "down") return null;

  const y = below ? request.y - 1 : request.y + 1;
  const existing = getBlock(doc, request.x, y, request.z);
  if (existing.namespacedName !== entry.namespacedName) return null;

  // The clicked slab must be the half nearest the click: a bottom slab clicked
  // on its top, or a top slab clicked on its underside.
  const wanted = below ? "bottom" : "top";
  if ((existing.properties.type ?? "bottom") !== wanted) return null;
  if ((entry.properties.type ?? "bottom") === wanted) return null;

  return {
    x: request.x,
    y,
    z: request.z,
    entry: { ...existing, properties: { ...existing.properties, type: "double" } },
  };
}

/**
 * A block placed into water comes out waterlogged.
 *
 * That is what the game does — a fence, a slab or a stair put into a pond
 * displaces nothing, it floods — and doing it here is what makes the property
 * reachable without opening the inspector for every block of a jetty.
 *
 * Three guards, and each of them is a way it could be wrong:
 *
 * - **Only if the block can hold it.** `hasProperty` asks the registry, so a
 *   stone block dropped in a pond does not come back carrying a state that no
 *   version of it has.
 * - **Only if the request did not say.** A caller that spelled `waterlogged`
 *   out — the inspector, a paste, an agent tool — meant it, and this is a
 *   default rather than a correction.
 * - **Only water.** Lava is not a fluid anything is waterlogged in, and a cell
 *   holding a *waterlogged* block counts, because that cell is water too.
 */
function floodedPlacement(
  doc: SchematicDocument,
  request: { x: number; y: number; z: number },
  entry: PaletteEntry,
): PaletteEntry {
  if (entry.properties.waterlogged !== undefined) return entry;
  if (!hasProperty(entry.namespacedName, "waterlogged")) return entry;
  const existing = getBlock(doc, request.x, request.y, request.z);
  const flooded =
    existing.namespacedName === "minecraft:water" || existing.properties.waterlogged === "true";
  if (!flooded) return entry;
  return { ...entry, properties: { ...entry.properties, waterlogged: "true" } };
}

interface OpenTarget {
  readonly cells: readonly { x: number; y: number; z: number; entry: PaletteEntry }[];
  /** `true` when the door is being opened; only the undo label reads it. */
  readonly opening: boolean;
  readonly name: string;
}

/**
 * What a right-click should **open**, or `null` when it should place instead.
 *
 * The gesture is the game's: right-click a door and it swings, and you have to
 * sneak to put a block on it. Here it did the second thing always, so the one
 * way to open a door was the inspector.
 *
 * The clicked cell is one step back along `against` from the cell a placement
 * would use -- the same arithmetic `doubleSlabTarget` does for its two faces,
 * generalised to six through `FACE_VECTOR`, which `block_orientation.ts` owns
 * and `connect.ts` already reads rather than keeping six numbers of its own.
 * With no `against` there is no clicked block: a click on the build grid is a
 * placement and nothing else.
 *
 * **Both halves of a door, or neither.** A door open at the bottom and shut at
 * the top is a shape the game cannot hold, and it is what one `setBlock` would
 * leave -- so the far half is found through `TWO_PART`, the table that already
 * knows a door is two blocks and which way the second one lies. Reading it
 * rather than writing `_door` a second time is what makes clicking the *upper*
 * half work, which is the half a person reaches first when the door is at eye
 * level.
 *
 * The far half is only taken when it is the same block. A door with something
 * else above it is already broken, and opening half of it would not mend it.
 */
function openTarget(
  doc: SchematicDocument,
  request: { x: number; y: number; z: number; against?: string },
): OpenTarget | null {
  const against = request.against;
  if (against === undefined) return null;
  const step = FACE_VECTOR[against as keyof typeof FACE_VECTOR];
  if (step === undefined) return null;
  const at = { x: request.x - step.x, y: request.y - step.y, z: request.z - step.z };

  const existing = getBlock(doc, at.x, at.y, at.z);
  /*
   * The registry decides, which excludes air for free and covers every wood
   * without a list. A block carrying `open` that the registry has never heard
   * of is left alone -- an omission that costs nothing, where a wrong guess
   * would write a state onto something that has no such property.
   */
  if (!isOpenable(existing.namespacedName)) return null;
  const opening = existing.properties.open !== "true";
  const next = opening ? "true" : "false";
  const swung = (entry: PaletteEntry): PaletteEntry => ({
    ...entry,
    properties: { ...entry.properties, open: next },
  });

  const cells = [{ ...at, entry: swung(existing) }];
  const family = TWO_PART.find((candidate) =>
    existing.namespacedName.endsWith(candidate.suffix),
  );
  const held = family === undefined ? undefined : existing.properties[family.property];
  if (family !== undefined && family.step !== null && (held === family.near || held === family.far)) {
    const away = held === family.near ? 1 : -1;
    const other = {
      x: at.x + family.step[0] * away,
      y: at.y + family.step[1] * away,
      z: at.z + family.step[2] * away,
    };
    const there = getBlock(doc, other.x, other.y, other.z);
    if (there.namespacedName === existing.namespacedName) {
      cells.push({ ...other, entry: swung(there) });
    }
  }
  return { cells, opening, name: existing.namespacedName };
}

/**
 * The families that are one block to place and two blocks in the file.
 *
 * A bed is a foot and a head; a door is a lower half and an upper. Both are
 * states the game cannot hold on their own -- a lone bed foot drops as an item
 * the moment anything updates it, and a lone door half is a door you can walk
 * through -- and both were being written as one block, so the schematic looked
 * right here and came apart when it was pasted.
 *
 * `step` is `null` for the family whose second cell is decided by `facing`,
 * which is the bed: its head goes one cell the way you were looking when you
 * laid it. A door's is always the cell above, whichever way it faces.
 *
 * A request that already names the far half -- `part=head`, `half=upper` -- is
 * somebody placing one half on purpose: the inspector, a paste, an agent tool.
 * Those are left alone. Only an absent value, or the near one, means "place the
 * whole thing".
 */
const TWO_PART: readonly {
  readonly suffix: string;
  readonly property: string;
  readonly near: string;
  readonly far: string;
  readonly step: readonly [number, number, number] | null;
}[] = [
  { suffix: "_bed", property: "part", near: "foot", far: "head", step: null },
  // `_trapdoor` does not end in `_door`, which is why this needs no guard --
  // `tests/session.ts` says so, because it is the kind of thing that reads as
  // true and would be relied on without ever being checked.
  { suffix: "_door", property: "half", near: "lower", far: "upper", step: [0, 1, 0] },
];

/** One cell along each horizontal facing, as `[dx, dy, dz]`. */
const FACING_STEP: Readonly<Record<string, readonly [number, number, number]>> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

interface TwoPartPlacement {
  readonly other: { x: number; y: number; z: number };
  readonly here: PaletteEntry;
  readonly there: PaletteEntry;
}

/**
 * The two cells one of those blocks occupies.
 *
 * `null` when this is not one of them, or is one half placed deliberately.
 * `"blocked"` when the far cell has something in it: **nothing is placed at
 * all.** That is the game's rule and it is the safe half of it -- refusing over
 * a flower is a smaller wrong than destroying whatever was there, and the block
 * in the way is on screen, so the silence says as much as a message would.
 *
 * A cell *outside* the document is not blocked. The region the growth is
 * measured against spans both, so a bed laid against the edge or a door hung at
 * the ceiling makes room for itself exactly as a single block does.
 */
function twoPartPlacement(
  doc: SchematicDocument,
  request: { x: number; y: number; z: number },
  entry: PaletteEntry,
): TwoPartPlacement | "blocked" | null {
  const family = TWO_PART.find((candidate) => entry.namespacedName.endsWith(candidate.suffix));
  if (family === undefined) return null;
  if (entry.properties[family.property] === family.far) return null;

  const step = family.step ?? FACING_STEP[entry.properties.facing ?? "north"];
  // A facing outside the four is something no placement produces and no file
  // should carry. Placing half of the block would be worse than placing none.
  if (step === undefined) return "blocked";

  const other = { x: request.x + step[0], y: request.y + step[1], z: request.z + step[2] };
  const inDocument =
    other.x >= 0 &&
    other.y >= 0 &&
    other.z >= 0 &&
    other.x < doc.width &&
    other.y < doc.height &&
    other.z < doc.length;
  if (inDocument && getBlock(doc, other.x, other.y, other.z).namespacedName !== "minecraft:air") {
    return "blocked";
  }
  return {
    other,
    here: { ...entry, properties: { ...entry.properties, [family.property]: family.near } },
    there: { ...entry, properties: { ...entry.properties, [family.property]: family.far } },
  };
}

/**
 * Applies one request as one undoable step.
 *
 * The label is what the undo menu will say, so it is built from the request
 * rather than passed in: the renderer should not be able to mislabel history.
 */
/**
 * The box follows the content back in, when a break empties the face it was on.
 *
 * The mirror of `growthToInclude`, and it was missing: placing a block past the
 * edge grew the schematic and breaking that same block left it grown, so one
 * gesture had two answers depending on which way round you did it. Reported
 * exactly that way -- "deleting a block does not resize the area, and setting
 * one does".
 *
 * One slab, off the faces the broken cell *was*. Both halves keep it from
 * eating work: a face with nothing on it is never named, because the broken
 * cell has to be that face, and even a named one gives back only what the
 * matching growth added. `shrink.ts` holds the rest of the reasoning, including
 * why the near side is left alone.
 *
 * Emptiness is `applyEdit`'s own predicate, so with a void block chosen the
 * water a break wrote counts as empty here too. That has a consequence worth
 * knowing before it is reported: water put down by hand at the outer face is
 * empty space by the same rule that makes it unpickable, and comes off with the
 * slab. It is one undo step, like the rest of the break.
 */
function takeBoxBack(
  doc: SchematicDocument,
  tx: TransactionScope,
  cell: { x: number; y: number; z: number },
  isEmpty: (entry: PaletteEntry) => boolean,
): void {
  const faces = {
    x: cell.x === doc.width - 1,
    y: cell.y === doc.height - 1,
    z: cell.z === doc.length - 1,
  };
  if (!faces.x && !faces.y && !faces.z) return;

  /*
   * Read here rather than passed in: the connection pass runs before this and
   * interns as it goes, so a table built before it would be short by however
   * many entries a fence's arms had just added -- and an index past the end
   * would read as "not empty", which is the safe direction but the wrong
   * answer. `connect.ts` records the same trap one layer down.
   */
  const empty = doc.palette.map((entry) => isEmpty(entry));
  const next = peelEmptyFaces(doc, (index) => empty[index] === true, faces);
  if (next !== null) tx.resize(next);
}

/**
 * What an edit is allowed to do beyond writing blocks.
 *
 * Passed in rather than read from the settings store, because this module is
 * reachable from the suites and `settings-store.ts` imports Electron -- the
 * same reason `settings_coerce.ts` was split out of it.
 */
export interface EditOptions {
  /** Default true, which is what the editor did before there was a setting. */
  autoGrow?: boolean;
  /**
   * What a break writes instead of air, when somebody has chosen one.
   *
   * Needed here for one rule and one only: **breaking never grows.** That
   * guard reads `namespacedName === "minecraft:air"`, which was the whole
   * of what a break was until empty space could be made of water. Left
   * alone, the rule would go on being true of the word `air` while
   * quietly ceasing to be true of *breaking*, and nothing would fail --
   * because a break comes from a pick, so the block exists and the case
   * never arises. Which is exactly why it is written down.
   */
  voidBlock?: string;
  /**
   * If given, the only block names that may be written.
   *
   * The legacy name table, for a document in the legacy era. `undefined` means
   * no restriction, which is every flat document -- this app has no per-block
   * introduction data for the flat era, so there is nothing honest to check
   * against there and pretending otherwise would hide blocks that do exist.
   *
   * Passed in rather than read here for the module's standing reason: the
   * table is loaded from `resources/` by a path only main knows, and this file
   * has to stay reachable from the suites.
   */
  placeableNames?: ReadonlySet<string> | null;
  /** How to name the version in a refusal. Only read when one is raised. */
  versionLabel?: string;
}

export function applyEdit(
  session: DocumentSession,
  request: EditRequest,
  options: EditOptions = {},
): number {
  const { doc, history } = session;
  const mayGrow = options.autoGrow !== false;
  /*
   * What counts as empty space, matched the way `fillVoid` matches it.
   *
   * This compared a bare `namespacedName` against the *raw setting string*,
   * which are two different vocabularies: the picker can hand back
   * `minecraft:water[level=0]` and a cell holding it has the name
   * `minecraft:water`, so they never matched and a break into that void
   * silently went back to growing the box. `preview.ts` was already
   * comparing `paletteEntryCacheKey`, so the two halves of one feature
   * disagreed about which cells were empty -- one drawing them, the other
   * not counting them.
   *
   * Whole entries rather than names, because the key needs the properties.
   */
  const voidPattern =
    options.voidBlock === undefined || options.voidBlock === ""
      ? null
      : parsePaletteEntry(options.voidBlock);
  /*
   * ...and a **pattern**, not an exact state. `fillVoid` draws the void by the
   * same rule, and the two have to agree cell for cell or a break into a cell
   * that is drawn as empty space would not count as emptying it -- so the box
   * would not peel back. They disagreed: both compared full state strings, and
   * a barrier from a file carries `[waterlogged=false]` while the setting says
   * `minecraft:barrier`.
   */
  const emptiness = (entry: PaletteEntry): boolean =>
    entry.namespacedName === "minecraft:air" ||
    (voidPattern !== null && matchesBlockPattern(entry, voidPattern));

  /*
   * Every block *written* by this edit has to exist in the schematic's
   * version. Names only -- see `legacyBlockNames` for why that is the line and
   * not a shortcut.
   *
   * Air is always allowed and is not in the table under that spelling in every
   * direction; more to the point, air is what a break writes, and a document
   * you cannot empty a cell in is not an editor.
   */
  const placeable = (entry: PaletteEntry): PaletteEntry => {
    const allowed = options.placeableNames;
    if (allowed === undefined || allowed === null) return entry;
    if (entry.namespacedName === "minecraft:air") return entry;
    if (allowed.has(entry.namespacedName)) return entry;
    throw new BlockNotInVersionError(entry.namespacedName, options.versionLabel ?? "this version");
  };

  /*
   * Placing one block grows the document, exactly as filling does.
   *
   * It did not, and the asymmetry was invisible: `document.setBlock` refuses an
   * out-of-bounds write by returning `null`, so a block placed past the edge
   * reported `changed: 0` and looked like a click that had missed. In flight
   * that is the ordinary way to build outwards -- right-click the outer face of
   * an edge block -- and it was the one gesture with no answer at all, while
   * the same act performed by dragging a selection and filling it worked.
   *
   * Below the origin the content moves up and the placement moves with it,
   * because the grid has no negative index; that is `grow.ts`'s arithmetic and
   * the same answer a fill dragged under the floor already gives.
   */
  /*
   * Open what was clicked, or fall through and place what is held.
   *
   * The fall-through is a rewrite rather than a copy, so a right-click that
   * turns out to be a placement is the *same* placement in every respect --
   * the slab merge, the two-part rule, the flooding, the growth and the
   * volume guard. A second path here is how one of those comes to be missing
   * from the commonest gesture in the app.
   *
   * Both halves land in one transaction, or Ctrl+Z would take a door back a
   * half at a time -- which is the rule the placement below already keeps,
   * arrived at from the other direction. None of these blocks carries a block
   * entity, so `setBlock` dropping one is not a hazard here the way it is in
   * `connect.ts`.
   */
  if (request.kind === "use") {
    const target = openTarget(doc, request);
    if (target === null) {
      return applyEdit(session, { ...request, kind: "setBlock" }, options);
    }
    return runTransaction(
      doc,
      history,
      `${target.opening ? "Open" : "Close"} ${target.name}`,
      (tx) =>
        target.cells.reduce(
          (changed, cell) => changed + (tx.setBlock(cell.x, cell.y, cell.z, cell.entry) ? 1 : 0),
          0,
        ),
    );
  }

  if (request.kind === "setBlock") {
    const entry = placeable(floodedPlacement(doc, request, toEntry(request.block)));

    /*
     * Two slabs meeting in one cell are one double slab.
     *
     * In the game a slab placed against the top of a matching bottom slab does
     * not go in the cell above -- it fills the one that is already there, and
     * the pair becomes a single full block. Without this the editor stacked
     * them, which is a shape the game cannot hold and a file the game will not
     * paste back the way it looks here.
     *
     * `against` is the only thing the renderer can contribute: `x/y/z` is the
     * empty cell the click landed in, and the mesh has no per-block identity,
     * so neither side can find the clicked slab on its own.
     *
     * Vertical faces only. The game also merges when you click the upper half
     * of a slab's *side*, and that needs where on the face the cursor was --
     * `placedInUpperHalf`'s question, which does not travel. Left out rather
     * than guessed: merging on a side click that meant "place beside it" would
     * destroy the slab already there.
     */
    const merged = doubleSlabTarget(doc, request, entry);
    if (merged !== null) {
      return runTransaction(doc, history, `Place ${entry.namespacedName}`, (tx) =>
        tx.setBlock(merged.x, merged.y, merged.z, merged.entry) ? 1 : 0,
      );
    }
    /*
     * A bed is two blocks, a door is two blocks, and both were being placed as
     * one.
     *
     * Both halves in one transaction, so Ctrl+Z takes the whole thing back --
     * two edits would leave you undoing a door one half at a time, and a lone
     * half is a state the game cannot hold. The region below spans both cells
     * so the growth covers the far one as well: a bed laid against the edge of
     * the document, or a door hung at the ceiling, makes room for itself
     * exactly as a single block does.
     */
    const pair = twoPartPlacement(doc, request, entry);
    // The far cell has something in it. The game does not place it either, and
    // the block in the way is on screen.
    if (pair === "blocked") return 0;

    const cell = {
      minX: Math.min(request.x, pair?.other.x ?? request.x),
      minY: Math.min(request.y, pair?.other.y ?? request.y),
      minZ: Math.min(request.z, pair?.other.z ?? request.z),
      maxX: Math.max(request.x, pair?.other.x ?? request.x),
      maxY: Math.max(request.y, pair?.other.y ?? request.y),
      maxZ: Math.max(request.z, pair?.other.z ?? request.z),
    };
    /*
     * Breaking is `setBlock` with air, and growing to make room for air would
     * be a resize and nothing else -- the same reason `replace` below does not
     * grow. Nothing sends a break from outside the box today (it comes from a
     * pick, so the block exists), which is exactly why this is written down:
     * the day something does, the failure would be a document that quietly got
     * larger.
     */
    const wanted = emptiness(entry) ? null : growthToInclude(doc, cell);
    // Refused rather than clipped: see `OutsideDocumentError`. A break is
    // exempt because it never wanted to grow in the first place, so with
    // auto-grow off it goes on doing exactly what it did before.
    if (wanted !== null && !mayGrow) throw new OutsideDocumentError();
    const growth = wanted;
    if (growth !== null && extentVolume(growth.size) > MAX_DOCUMENT_VOLUME) {
      throw new DocumentTooLargeError(extentVolume(growth.size));
    }
    const at = growth === null ? cell : shiftRegion(cell, growth.shift);

    /*
     * Set by the body, read by `after`, because only the body knows whether the
     * write landed. Breaking a cell that was already empty must move nothing --
     * the slab would come off on a click that did nothing at all -- and that
     * half is a correctness guard, checked by name.
     *
     * The `emptiness` half is not, and saying so is the point. A *placement*
     * could take the same path harmlessly: the cell written is on every face
     * `takeBoxBack` would name, because a face is named by the coordinate that
     * equals the boundary, so the peel finds it occupied and declines. What the
     * test buys is that an ordinary placement never scans a face for nothing.
     */
    let broke = false;

    return runTransaction(
      doc,
      history,
      `Place ${entry.namespacedName}`,
      (tx) => {
        // Resize first, for the reason the fill below states: a block delta
        // recorded before it would be an index into the old shape.
        if (growth !== null) tx.resize(growth.size, growth.shift);
        if (pair !== null) {
          const [sx, sy, sz] = growth?.shift ?? [0, 0, 0];
          const here = tx.setBlock(request.x + sx, request.y + sy, request.z + sz, pair.here) ? 1 : 0;
          const there = tx.setBlock(
            pair.other.x + sx,
            pair.other.y + sy,
            pair.other.z + sz,
            pair.there,
          )
            ? 1
            : 0;
          return here + there;
        }
        const wrote = tx.setBlock(at.minX, at.minY, at.minZ, entry) ? 1 : 0;
        broke = wrote > 0 && emptiness(entry);
        return wrote;
      },
      {
        /*
         * After the connection pass, never in the body: `tx.resize` flushes,
         * and the pass reads the live set. In the body this would not reorder
         * the two, it would delete the derivation outright -- see
         * `TransactionOptions.after`.
         *
         * Behind `mayGrow` because it is the same setting seen from the other
         * side. "Resize automatically while editing" that grew and never came
         * back in would be half a checkbox.
         */
        after: (tx) => {
          if (!broke || !mayGrow) return;
          takeBoxBack(doc, tx, { x: at.minX, y: at.minY, z: at.minZ }, emptiness);
        },
      },
    );
  }

  /*
   * The inspector's own edit: exactly this state, no derivation.
   *
   * It goes before the growth logic on purpose -- the block is already there,
   * so there is nothing to grow towards, for the same reason `replace` does not
   * grow. A `setState` aimed outside the document changes nothing and says so
   * through `changed: 0`.
   */
  if (request.kind === "setState") {
    const entry = placeable(toEntry(request.block));
    return runTransaction(
      doc,
      history,
      `Edit ${entry.namespacedName}`,
      (tx) => (tx.setBlock(request.x, request.y, request.z, entry) ? 1 : 0),
      { derive: false },
    );
  }

  /*
   * A region may reach outside the document, and a fill into it grows the
   * document to suit. `replace` deliberately does not: it rewrites blocks that
   * are already there, and there are none outside the box -- growing first would
   * add air and then replace nothing in it, which is a resize the user did not
   * ask for and would have to undo.
   */
  const asked = orderRegion(request.region);
  const wantedGrowth = request.kind === "fill" ? growthToInclude(doc, asked) : null;
  if (wantedGrowth !== null && !mayGrow) throw new OutsideDocumentError();
  const growth = wantedGrowth;

  // In the document's coordinates *after* the resize: existing content moves by
  // `shift`, and so does the region naming the cells to write.
  const region =
    growth === null ? normalizeRegion(doc, asked) : shiftRegion(asked, growth.shift);

  const volume = regionVolume(region);
  if (volume > MAX_EDIT_VOLUME) {
    throw new EditTooLargeError(volume);
  }
  if (growth !== null && extentVolume(growth.size) > MAX_DOCUMENT_VOLUME) {
    throw new DocumentTooLargeError(extentVolume(growth.size));
  }

  if (request.kind === "fill") {
    const entry = placeable(toEntry(request.block));
    return runTransaction(doc, history, `Fill with ${entry.namespacedName}`, (tx) => {
      // One transaction, so growing and filling are one undo step -- and the
      // resize goes in first, because a block delta recorded before it would be
      // an index into the old shape. `history.ts` flushes on resize for exactly
      // that reason.
      if (growth !== null) tx.resize(growth.size, growth.shift);
      return tx.fill(region, entry);
    });
  }

  // `from` is a pattern over what is already there, so it is deliberately not
  // guarded: refusing it would make "take out the block some other tool wrote"
  // impossible, which is exactly when somebody needs it.
  const from = toEntry(request.from);
  const to = placeable(toEntry(request.to));
  return runTransaction(
    doc,
    history,
    `Replace ${from.namespacedName} with ${to.namespacedName}`,
    (tx) => tx.replace(region, from, to),
  );
}

/**
 * Changes what empty space is made of in this document, and optionally
 * rewrites the cells that already hold the old answer.
 *
 * Two things happen here and they are deliberately not the same thing:
 *
 * - **The choice itself is a preference, not a mutation.** It changes what
 *   empty space is *drawn* as and what a future break will *write*; it moves
 *   no block, so it is not on the undo stack. Ctrl+Z after changing it takes
 *   back whatever you did before it, which is the honest answer.
 * - **The rewrite is an edit**, and it is one transaction, so a swap of a
 *   quarter of a million cells is one Ctrl+Z.
 *
 * They are asked for separately, and that is the second thing this got wrong.
 * The rewrite used to ride along with the choice, read from a checkbox at the
 * moment the block changed -- so ticking the box *after* picking water did
 * nothing at all, and re-picking water to make it fire hit a short-circuit that
 * said you had chosen what was already chosen. The one gesture anybody would
 * try was the one with no answer.
 *
 * So `replaceFrom` is explicit rather than read from the session. By the time
 * somebody presses the button the choice has already landed -- that is what
 * makes the viewport show it -- so `session.voidBlock` is the *new* value and
 * would convert a block into itself. The caller names the old one because the
 * caller is the only one still holding it.
 *
 * It is not enough on its own, and `sources` below says why: the setting and
 * the cells can disagree, and two documents that look identical from the
 * setting can differ entirely in what they contain.
 *
 * `from` is built with `toEntry` and not with any defaults-filling helper,
 * because it is a *pattern*: `tx.replace` interns it and matches on the
 * palette index, so writing default properties onto it would turn "take out
 * the water" into "take out the water that happens to be at level 0" -- which
 * finds a fraction of it and reports a healthy count for those. Same reason
 * `replace_blocks` parses its `from` and places its `to`.
 *
 * The volume goes through `MAX_EDIT_VOLUME` like any other edit. It is not a
 * formality here: air is most of an ordinary schematic, so this is the one
 * edit that genuinely does touch every cell, and one delta per changed voxel
 * is exactly the unbounded allocation that cap exists to stop.
 */
export function setSessionVoidBlock(
  session: DocumentSession,
  block: string,
  options: { replaceExisting?: boolean; replaceFrom?: string } = {},
): number {
  const next = normaliseVoidBlock(block);
  /*
   * What the empty cells could be holding, and **air is always one of them**.
   *
   * That is the whole of a bug worth keeping written down. `replaceFrom` alone
   * cannot separate two states that look identical from the setting: a
   * document whose empty space is *set* to barrier with its cells still air --
   * reopened from the sidecar, or one Ctrl+Z after a conversion -- against one
   * where the conversion already happened. Both say barrier, and only one has
   * anything to do. Reading the setting refused both, so the one gesture that
   * would have fixed it was the one with no answer.
   *
   * Air is what empty means in a schematic whatever the setting says, so it
   * goes in unconditionally; `replaceFrom` is *added* to it rather than
   * standing in for it, because a previous choice leaves its own block behind
   * and swapping barrier for structure_void has to find the barrier.
   */
  const sources = voidSources(options.replaceFrom ?? session.voidBlock, next);
  /*
   * Converting a block into itself can only ever change nothing, so it is not
   * an edit and does not reach the transaction -- which is what keeps a second
   * press of the button, or a re-pick of the block already chosen, from
   * putting an empty step on the undo stack.
   *
   * The corner this removes is worth naming, because it read as a bug and was
   * one: undoing a rewrite puts the blocks back and leaves the *choice*
   * standing -- they are deliberately different things -- and while the two
   * were fused, re-picking the block could not re-apply it. With the rewrite
   * on a press of its own, pressing again is exactly the gesture for that.
   */
  let changed = 0;
  if (options.replaceExisting === true && sources.length > 0) {
    const { doc, history } = session;
    const region = {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: doc.width - 1,
      maxY: doc.height - 1,
      maxZ: doc.length - 1,
    };
    const volume = regionVolume(region);
    if (volume > MAX_EDIT_VOLUME) throw new EditTooLargeError(volume);

    // `""` means air on both sides, which is what makes going back to air the
    // same operation rather than a special case.
    const wanted = sources.map((id) => parsePaletteEntry(id));
    const to = parsePaletteEntry(next === "" ? "minecraft:air" : next);
    changed = runTransaction(
      doc,
      history,
      `Replace ${wanted.map((entry) => entry.namespacedName).join(" and ")} with ${to.namespacedName}`,
      // One pass whatever the number of sources, which is what `replaceAny`
      // is for: this edit already touches most of the document.
      (tx) => tx.replaceAny(region, wanted, to),
    );
  }

  session.voidBlock = next;
  return changed;
}

/** What a version change did, for the sentence the panel shows afterwards. */
export interface VersionChangeResult {
  /** Cells written, of any of the three kinds below. */
  changed: number;
  renamed: number;
  rewritten: number;
  dropped: number;
  /** A sentence, or `""` when nothing moved. */
  notes: string;
}

/**
 * Changes which Minecraft version this schematic is for, as one undoable step.
 *
 * There was no way to do this at all. A version could be chosen when a document
 * was created and stamped when it was saved, and nothing in between -- so
 * saying "this is a 1.12 schematic" about a file that arrived without a tag
 * meant a Save As, and so did changing 1.21 to 1.16.
 *
 * **The container is not changed here, and a version it cannot carry is
 * refused.** `doc.format` is what a plain Save writes back, so flipping it
 * under an open file would leave the next Ctrl+S writing MCEdit bytes into
 * something still called `.schem`. Save As and Convert both exist and both
 * change the pair together; this verb changes one thing.
 *
 * ## Three things happen, in this order, and the order is the whole design
 *
 * 1. **Rename.** `chain` becomes `iron_chain` going past 1.21.9 and back again
 *    coming under it. Nothing is lost, nothing is counted, nothing is asked.
 * 2. **Rewrite the states** the target cannot say -- a wall's `north=tall`
 *    becomes `north=true` before 1.16, because that release is where a wall
 *    connection stopped being a boolean.
 * 3. **Drop what is left**, and only that.
 *
 * Doing 3 before 1 is not a worse version of this: it is the demolition this
 * function exists to prevent. A registry diff sees `chain` disappear at 1.21.9
 * and `iron_chain` appear and cannot tell that from two unrelated events, so a
 * backport that checked existence first would find `iron_chain` absent from
 * 1.16 and replace every one of them with empty space -- while the correct
 * answer, `chain`, is a name that version has had since it shipped.
 *
 * ## What replaces a dropped block
 *
 * The document's **empty space** (`session.voidBlock`), not air. A break already
 * writes it, and an underwater build that came back full of air bubbles would
 * have lost exactly what that setting exists to preserve. It falls back to air
 * when the empty space block is itself too new for the target -- which is a real
 * case, `structure_void` being 1.10.
 *
 * A backport is refused first and counted, and only goes through with
 * `dropUnrepresentable`: a warning shown after the blocks are gone is not a
 * warning.
 *
 * One transaction, so Ctrl+Z takes back the version, the names, the states
 * *and* the blocks together. That costs nothing to arrange: `HeaderState` has
 * captured and restored `dataVersion` since it existed.
 */
export function setDocumentVersion(
  session: DocumentSession,
  version: string,
  options: { dropUnrepresentable?: boolean; placeableNames?: ReadonlySet<string> | null } = {},
): VersionChangeResult {
  const { doc, history } = session;
  const info = mcVersion(version);
  if (info === undefined) throw new UnknownVersionError(version);
  const refusal = refusalFor(doc.format, version);
  if (refusal !== null) throw new VersionRefusedError(refusal);

  /*
   * `block_versions.json` is the **flat era only** -- its generator refuses a
   * pre-Flattening label outright -- so a legacy target is not a question it
   * may be asked. Below 1.13 the authority is `legacy_blocks.json`, which the
   * caller passes as `placeableNames` and which the MCEdit writer already uses
   * to decide the same thing. Two tables answering one question is how they
   * come to disagree.
   */
  const target = info.era === "flat" ? info.dataVersion : null;
  const allowed = options.placeableNames ?? null;
  /*
   * Names only, which is the line `buildMcEdit` already draws: a missing name
   * is fatal, an uncarryable state is written as the base block and reported
   * as degraded. The legacy table answers when there is one -- it is exact
   * where this dataset stops -- and `blockExistsIn` answers otherwise.
   */
  const exists = (name: string): boolean => {
    if (allowed !== null) return allowed.has(name);
    return target === null ? true : blockExistsIn(name, target);
  };

  /*
   * The empty space this document is made of, or air when the target is too old
   * to have it. Resolved once: it is the same answer for every dropped block.
   */
  const AIR: PaletteEntry = { namespacedName: "minecraft:air", properties: {} };
  const chosen =
    session.voidBlock === "" ? AIR : parsePaletteEntry(session.voidBlock);
  const fill = exists(chosen.namespacedName) ? chosen : AIR;

  type Kind = "rename" | "rewrite" | "drop";
  const plan = new Map<string, { to: PaletteEntry; kind: Kind }>();
  const doomed: string[] = [];

  for (const entry of doc.palette) {
    if (entry.namespacedName === AIR.namespacedName) continue;

    // 1. the name.
    const renamed = target === null ? null : renameFor(entry.namespacedName, target);
    const name = renamed === null ? entry.namespacedName : `minecraft:${renamed}`;

    // 3, asked early because it decides whether 2 is worth doing at all.
    if (!exists(name)) {
      plan.set(paletteEntryCacheKey(entry), { to: fill, kind: "drop" });
      doomed.push(entry.namespacedName);
      continue;
    }

    // 2. the states, against the name the target will actually use.
    // Copied only when something actually moves: most entries need nothing,
    // and a copy per palette row on every version change is pure waste.
    let states: Record<string, string> | null = null;
    if (target !== null) {
      for (const [property, value] of Object.entries(entry.properties)) {
        if (!propertyExistsIn(name, property, target)) {
          states ??= { ...entry.properties };
          delete states[property];
          continue;
        }
        const next = propertyValueIn(name, property, value, target);
        if (next === null) continue;
        states ??= { ...entry.properties };
        states[property] = next;
      }
    }

    if (renamed === null && states === null) continue;
    plan.set(paletteEntryCacheKey(entry), {
      to: { namespacedName: name, properties: states ?? entry.properties },
      kind: renamed === null ? "rewrite" : "rename",
    });
  }

  /*
   * Counted in cells, not in palette entries: "3 types" is not the number
   * somebody deciding whether to go ahead is weighing. The histogram is keyed
   * the same way the plan is, so this is a lookup rather than a second walk.
   */
  const counts = paletteHistogram(doc);
  let renamedCells = 0;
  let rewrittenCells = 0;
  let droppedCells = 0;
  for (const [key, cells] of counts) {
    const step = plan.get(key);
    if (step === undefined) continue;
    if (step.kind === "drop") droppedCells += cells;
    else if (step.kind === "rename") renamedCells += cells;
    else rewrittenCells += cells;
  }

  if (droppedCells > 0 && options.dropUnrepresentable !== true) {
    const names = [...new Set(doomed)].sort();
    throw new VersionWouldLoseBlocksError(
      names,
      droppedCells,
      info.label,
      fill.namespacedName === AIR.namespacedName ? "air" : fill.namespacedName,
    );
  }

  const region = {
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: doc.width - 1,
    maxY: doc.height - 1,
    maxZ: doc.length - 1,
  };

  const changed = runTransaction(
    doc,
    history,
    `Set the Minecraft version to ${info.label}`,
    (tx) => {
      // Blocks first, then the header: a run that threw half way must never
      // leave a document claiming a version its palette contradicts.
      const wrote =
        plan.size === 0
          ? 0
          : tx.remap(region, (entry) => plan.get(paletteEntryCacheKey(entry))?.to ?? null);
      tx.setHeader({ ...readHeader(doc), dataVersion: info.dataVersion });
      return wrote;
    },
  );

  const parts: string[] = [];
  if (renamedCells > 0) parts.push(`${renamedCells.toLocaleString()} renamed`);
  if (rewrittenCells > 0) parts.push(`${rewrittenCells.toLocaleString()} restated`);
  if (droppedCells > 0) {
    parts.push(
      `${droppedCells.toLocaleString()} replaced with ` +
        (fill.namespacedName === AIR.namespacedName ? "air" : fill.namespacedName),
    );
  }
  return {
    changed,
    renamed: renamedCells,
    rewritten: rewrittenCells,
    dropped: droppedCells,
    notes: parts.length === 0 ? "" : `${parts.join(", ")}.`,
  };
}

/**
 * Sets the schematic's size by hand, as one undoable step.
 *
 * **At the far side, never with a shift**, which is `resize_document`'s pair of
 * restrictions and is here for the same reason: every coordinate anybody has
 * already been given -- a selection, a block they are looking at, a number in
 * the inspector -- is still valid afterwards. Making room *below* the origin
 * would move all the content up instead, because the grid has no negative
 * index, and then nothing anyone had written down would mean what it meant.
 *
 * Shrinking is allowed, unlike the agent's tool, because this is somebody
 * typing a size on purpose: the box is theirs to set. `tx.resize` records the
 * blocks and block entities it drops, so the step comes back in full on Ctrl+Z.
 *
 * What it will not do is take them by surprise. A shrink that would destroy
 * blocks is refused, counted, and only goes through when the caller says so --
 * the refusal is the answer, because a warning shown after the fact is not a
 * warning and main must not raise a dialog for a request that may not have come
 * from a person at the keyboard.
 */
export function resizeSession(
  session: DocumentSession,
  size: { width: number; height: number; length: number },
  options: { confirmLoss?: boolean } = {},
): number {
  const { doc, history } = session;
  const width = Math.trunc(size.width);
  const height = Math.trunc(size.height);
  const length = Math.trunc(size.length);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(length) ||
    width < DOCUMENT_SIZE.min ||
    height < DOCUMENT_SIZE.min ||
    length < DOCUMENT_SIZE.min ||
    width > DOCUMENT_SIZE.max ||
    height > DOCUMENT_SIZE.max ||
    length > DOCUMENT_SIZE.max
  ) {
    throw new Error(
      `A schematic is between ${DOCUMENT_SIZE.min} and ${DOCUMENT_SIZE.max} blocks on each ` +
        `side; got ${size.width}x${size.height}x${size.length}.`,
    );
  }

  const volume = width * height * length;
  if (volume > MAX_DOCUMENT_VOLUME) throw new DocumentTooLargeError(volume);

  if (width === doc.width && height === doc.height && length === doc.length) {
    // Nothing to record. `runTransaction` would push no undo step for an empty
    // recorder anyway; returning here also keeps the count honest.
    return 0;
  }

  /*
   * Counted before anything moves, over exactly the cells the new box does not
   * reach. Air is not counted -- losing air is losing nothing, and a shrink into
   * empty space is the ordinary case this must not interrupt.
   */
  if (!options.confirmLoss) {
    let lost = 0;
    for (let x = 0; x < doc.width; x += 1) {
      for (let y = 0; y < doc.height; y += 1) {
        for (let z = 0; z < doc.length; z += 1) {
          if (x < width && y < height && z < length) continue;
          if (doc.voxels[x * doc.height * doc.length + y * doc.length + z] !== 0) lost += 1;
        }
      }
    }
    if (lost > 0) throw new ResizeWouldLoseBlocksError(lost);
  }

  return runTransaction(
    doc,
    history,
    `Resize to ${width}x${height}x${length}`,
    (tx) => {
      tx.resize({ width, height, length });
      // A resize moves no voxel that stays, so it contributes nothing to the
      // recorder's own tally; the answer worth giving back is how much the box
      // changed by, which the caller reads off the state it gets anyway.
      return 0;
    },
  );
}

export function undoEdit(session: DocumentSession): string | null {
  return undo(session.doc, session.history)?.label ?? null;
}

export function redoEdit(session: DocumentSession): string | null {
  return redo(session.doc, session.history)?.label ?? null;
}

/**
 * Forgets what has been said to the agent, keeping the document.
 *
 * Worth having as a verb rather than leaving the user to close and reopen: a
 * conversation that has gone somewhere unhelpful is a reason to start over on
 * the talking, not on the work.
 */

/** What block sits at a coordinate, for the inspector. */
export function inspect(session: DocumentSession, x: number, y: number, z: number) {
  const entry = getBlock(session.doc, x, y, z);
  const blockEntity = session.doc.blockEntities.get(`${x},${y},${z}`) ?? null;
  return {
    block: entry.namespacedName,
    properties: { ...entry.properties },
    blockEntity:
      blockEntity === null
        ? null
        : {
            id: blockEntity.id,
            // Serialised rather than handed over raw: NBT is a tree of tagged
            // values and the renderer displays it whole.
            nbt: JSON.stringify(blockEntity.nbt),
            // ...and flattened, because editing needs the tag types, which the
            // readable rendering deliberately throws away.
            fields: flattenNbt(blockEntity.nbt),
          },
  };
}

/**
 * What was last copied.
 *
 * Module-level, not on the session, and that is the point: a clipboard whose
 * life ended with the document could never carry anything between two of them,
 * which is most of what a clipboard is for. Copy a tower out of one schematic,
 * open another, paste it in.
 *
 * It holds palette entries by value, so nothing here refers into a document
 * that may since have been closed.
 */
let clipboard: Clipboard | null = null;

/**
 * Empty space, when nothing else has been chosen.
 *
 * A constant rather than an object literal at each call site: `cutSelection`
 * and `moveRegion` each wrote their own, which is how they came to ignore the
 * document's void block while `applyEdit`'s break path honoured it -- an
 * underwater build cut and pasted came back with air pockets in it.
 */
const AIR_ENTRY: PaletteEntry = { namespacedName: "minecraft:air", properties: {} };
export function currentClipboard(): Clipboard | null {
  return clipboard;
}

/** Copies a region out. Reads only, so no transaction. */
export function copySelection(session: DocumentSession, request: RegionSpec): Clipboard {
  clipboard = copyRegion(session.doc, normalizeRegion(session.doc, request));
  return clipboard;
}

/**
 * Copies, then clears — one undoable step for the clearing half.
 *
 * What is left behind is the document's empty space rather than the word air,
 * for `applyEdit`'s reason: with water chosen as the void, a cut that wrote air
 * would punch a dry hole in a pond.
 */
export function cutSelection(
  session: DocumentSession,
  request: RegionSpec,
  options: RegionEditOptions = {},
): Clipboard {
  const { doc, history } = session;
  const region = normalizeRegion(doc, request);
  clipboard = copyRegion(doc, region);
  runTransaction(doc, history, "Cut the selection", (tx) =>
    tx.fill(region, emptyEntry(options.voidBlock)),
  );
  return clipboard;
}

export class EmptyClipboardError extends Error {
  constructor() {
    super("Nothing has been copied yet");
    this.name = "EmptyClipboardError";
  }
}

/** Pastes the clipboard with its corner at `at`, as one undoable step. */
export function pasteSelection(
  session: DocumentSession,
  at: { x: number; y: number; z: number },
  options: PasteOptions = {},
): number {
  if (clipboard === null) {
    throw new EmptyClipboardError();
  }
  const held = clipboard;
  const { doc, history } = session;
  return runTransaction(doc, history, "Paste", (tx) =>
    pasteClipboard(doc, tx, held, at, options),
  );
}

/**
 * Picks a region up and puts it down somewhere else, as one undoable step.
 *
 * Not cut-then-paste through the clipboard, for two reasons that both matter:
 * the clipboard belongs to the user and moving something must not throw away
 * what they had copied, and cut and paste are two transactions -- a move
 * interrupted between them would leave a hole where the build used to be.
 *
 * The snapshot is taken before anything is written, so a destination that
 * overlaps the source is safe: what is pasted came from the document as it was,
 * not as the clearing left it.
 *
 * `includeAir` is what makes this a move rather than a stamp. Without it the
 * destination keeps whatever was already standing inside the moved box, so
 * dragging a hollow room three blocks along would smear its walls.
 */
/**
 * What every region edit may be told, beyond the region itself.
 *
 * The three questions are the same for a move, a turn and a scale, and before
 * this they were answered in three different places or not at all: `autoGrow`
 * reached only `applyEdit`, so a move that carried blocks past the edge lost
 * them silently -- `pasteClipboard` clips by letting `tx.setBlock` return
 * false, and `changed` came back short with nothing to say why.
 */
export interface RegionEditOptions {
  /** Whether the schematic grows to hold the result. Refuses by name when off. */
  autoGrow?: boolean;
  /**
   * What the region leaves behind: the document's own empty space.
   *
   * A string, the way `EditOptions.voidBlock` is, and parsed here for the same
   * reason -- so a caller passes what the session holds rather than converting
   * it. Before this, `cutSelection` and `moveRegion` each wrote
   * `minecraft:air` inline, so an underwater build cut and pasted came back
   * with air pockets where the water had been.
   */
  voidBlock?: string;
}

/** The block a region leaves behind, from whatever the session was told. */
function emptyEntry(voidBlock: string | undefined): PaletteEntry {
  if (voidBlock === undefined || voidBlock === "") return AIR_ENTRY;
  return parsePaletteEntry(voidBlock);
}

/**
 * The growth a destination box needs, refusing rather than clipping.
 *
 * One place, because the alternative is this rule written out at three call
 * sites and wrong at whichever is added next -- which is exactly how move,
 * paste and transform came to ignore the setting while `applyEdit` honoured it.
 */
function growthFor(
  doc: SchematicDocument,
  box: Region,
  mayGrow: boolean,
): { size: Extent; shift: readonly [number, number, number] } | null {
  const growth = growthToInclude(doc, orderRegion(box));
  if (growth === null) return null;
  if (!mayGrow) throw new OutsideDocumentError();
  if (extentVolume(growth.size) > MAX_DOCUMENT_VOLUME) {
    throw new DocumentTooLargeError(extentVolume(growth.size));
  }
  return growth;
}

/** The box a region occupies once a transform has been applied to it. */
function transformedBox(
  region: Region,
  transform: RegionTransform,
  to: { x: number; y: number; z: number } | null,
): Region {
  const width = region.maxX - region.minX + 1;
  const height = region.maxY - region.minY + 1;
  const length = region.maxZ - region.minZ + 1;
  const quarter = transform.kind === "rotate" && (transform.steps === 1 || transform.steps === 3);
  const size = quarter
    ? { width: length, height, length: width }
    : { width, height, length };
  const corner = to ?? { x: region.minX, y: region.minY, z: region.minZ };
  return {
    minX: corner.x,
    minY: corner.y,
    minZ: corner.z,
    maxX: corner.x + size.width - 1,
    maxY: corner.y + size.height - 1,
    maxZ: corner.z + size.length - 1,
  };
}

export function moveRegion(
  session: DocumentSession,
  request: RegionSpec,
  to: { x: number; y: number; z: number },
  options: RegionEditOptions = {},
): number {
  const { doc, history } = session;
  const region = normalizeRegion(doc, request);
  const volume = regionVolume(region);
  if (volume > MAX_EDIT_VOLUME) throw new EditTooLargeError(volume);

  const landing: Region = {
    minX: to.x,
    minY: to.y,
    minZ: to.z,
    maxX: to.x + (region.maxX - region.minX),
    maxY: to.y + (region.maxY - region.minY),
    maxZ: to.z + (region.maxZ - region.minZ),
  };
  const growth = growthFor(doc, landing, options.autoGrow !== false);
  const held = copyRegion(doc, region);
  const empty = emptyEntry(options.voidBlock);

  return runTransaction(doc, history, "Move the selection", (tx) => {
    /*
     * The resize comes first, and alone in its command: a voxel index means
     * nothing except against the dimensions in force when it was recorded, so a
     * block delta written before it would index the old shape.
     */
    if (growth !== null) tx.resize(growth.size, growth.shift);
    const shift = growth?.shift ?? ([0, 0, 0] as const);
    const source = growth === null ? region : shiftRegion(region, growth.shift);
    let changed = tx.fill(source, empty);
    changed += pasteClipboard(
      doc,
      tx,
      held,
      { x: to.x + shift[0], y: to.y + shift[1], z: to.z + shift[2] },
      { includeAir: true },
    );
    return changed;
  });
}

/**
 * A region's contents as standalone geometry, for the ghost that shows where a
 * move would land.
 *
 * A one-off document of exactly the region's size, meshed by the same pipeline
 * as everything else -- so the preview cannot disagree with what the move
 * actually produces, for the same reason a block icon cannot disagree with the
 * viewport. Its coordinates come out relative to the region's own corner, which
 * is what lets the renderer simply position the group.
 *
 * No mesh cache: this is built once when the gesture starts and thrown away
 * when it ends.
 */
export async function regionMesh(
  session: DocumentSession,
  request: RegionSpec,
  options: DocumentPreviewOptions,
): Promise<{ chunks: ChunkGeometry[]; atlasVersion: number }> {
  const region = normalizeRegion(session.doc, request);
  const held = copyRegion(session.doc, region);
  const scratch = createDocument({
    width: held.width,
    height: held.height,
    length: held.length,
    format: session.doc.format,
  });
  for (const cell of held.cells) {
    setBlock(scratch, cell.dx, cell.dy, cell.dz, cell.entry);
  }
  try {
    const built = await buildDocumentPreview(scratch, options);
    return { chunks: built.mesh.chunks, atlasVersion: built.mesh.atlasVersion };
  } catch {
    // An all-air region meshes to nothing, which is not a failure -- it is a
    // ghost with nothing in it, and the box the viewer draws says where it
    // would go perfectly well on its own.
    return { chunks: [], atlasVersion: -1 };
  }
}

/**
 * Turns or reflects a region as one undoable step.
 *
 * The mechanics live in `domain/transform.ts` so the agent can drive the same
 * code inside its own transaction; this is only the UI's wrapper around them.
 */
/**
 * Turns or reflects a region, optionally landing it somewhere else.
 *
 * The destination is what makes the gizmo's pivot work: turning about a corner
 * is turning in place and then moving, and doing that as two transactions would
 * let Ctrl+Z take back half of one gesture. It is also what removes
 * `NotSquareError` for callers that supply one -- an oblong quarter-turn is
 * simply a box of the other shape, and only the demand that it land back on its
 * own footprint ever made it impossible.
 */
export function transformRegion(
  session: DocumentSession,
  request: RegionSpec,
  transform: RegionTransform,
  options: RegionEditOptions & { to?: { x: number; y: number; z: number } | null } = {},
): number {
  const { doc, history } = session;
  const region = normalizeRegion(doc, request);
  const volume = regionVolume(region);
  if (volume > MAX_EDIT_VOLUME) throw new EditTooLargeError(volume);

  const to = options.to ?? null;
  const landing = transformedBox(region, transform, to);
  const growth = growthFor(doc, landing, options.autoGrow !== false);

  return runTransaction(doc, history, describeTransform(transform), (tx) => {
    if (growth !== null) tx.resize(growth.size, growth.shift);
    const shift = growth?.shift ?? ([0, 0, 0] as const);
    const source = growth === null ? region : shiftRegion(region, growth.shift);
    const corner =
      to === null
        ? null
        : { x: to.x + shift[0], y: to.y + shift[1], z: to.z + shift[2] };
    return applyRegionTransform(doc, tx, source, transform, {
      to: corner,
      empty: emptyEntry(options.voidBlock),
    });
  });
}

/**
 * Thrown when a division would discard blocks, so it can be confirmed.
 *
 * `resizeSession`'s shape, and for its reason: counted and refused *before*
 * anything is written, because a warning shown after the blocks are gone is a
 * report. It maps to `needs-confirmation`, so the panel can offer the second
 * press without reading the sentence.
 */
export class ScaleWouldLoseBlocksError extends Error {
  constructor(public readonly blocks: number) {
    super(
      `Shrinking discards ${blocks.toLocaleString()} block${blocks === 1 ? "" : "s"}: only ` +
        `one cell in each group survives. Confirm to go ahead.`,
    );
    this.name = "ScaleWouldLoseBlocksError";
  }
}

/**
 * Resamples a region by a whole factor.
 *
 * The least useful of the gizmo's four modes and the one most able to destroy
 * something, which is why it is the only one that ever asks first.
 */
export function scaleRegion(
  session: DocumentSession,
  request: RegionSpec,
  spec: ScaleSpec,
  options: RegionEditOptions & {
    to?: { x: number; y: number; z: number } | null;
    confirmLoss?: boolean;
  } = {},
): number {
  const { doc, history } = session;
  const region = normalizeRegion(doc, request);
  const size = {
    width: region.maxX - region.minX + 1,
    height: region.maxY - region.minY + 1,
    length: region.maxZ - region.minZ + 1,
  };
  const out = scaledExtent(size, spec);
  /*
   * The *destination* is what has to fit, not the source: multiplying by three
   * turns a hundred blocks a side into twenty-seven million cells, which is
   * past what one edit may touch and well past what the process survives.
   */
  const volume = out.width * out.height * out.length;
  if (volume > MAX_EDIT_VOLUME) throw new EditTooLargeError(volume);

  if (spec.kind === "divide" && options.confirmLoss !== true) {
    const lost = scaleWouldDrop(doc, region, spec);
    if (lost > 0) throw new ScaleWouldLoseBlocksError(lost);
  }

  const to = options.to ?? { x: region.minX, y: region.minY, z: region.minZ };
  const landing: Region = {
    minX: to.x,
    minY: to.y,
    minZ: to.z,
    maxX: to.x + out.width - 1,
    maxY: to.y + out.height - 1,
    maxZ: to.z + out.length - 1,
  };
  const growth = growthFor(doc, landing, options.autoGrow !== false);
  const label = spec.kind === "multiply" ? `Scale up ${spec.factor}x` : `Scale down ${spec.factor}x`;

  return runTransaction(doc, history, label, (tx) => {
    if (growth !== null) tx.resize(growth.size, growth.shift);
    const shift = growth?.shift ?? ([0, 0, 0] as const);
    const source = growth === null ? region : shiftRegion(region, growth.shift);
    return applyRegionScale(doc, tx, source, spec, {
      to: { x: to.x + shift[0], y: to.y + shift[1], z: to.z + shift[2] },
      empty: emptyEntry(options.voidBlock),
    });
  });
}

export class NoBlockEntityError extends Error {
  constructor() {
    super("There is no block entity there to edit");
    this.name = "NoBlockEntityError";
  }
}

/**
 * Writes one NBT leaf, as one undoable step.
 *
 * Through the transaction like every other edit, so a mistyped sign is a
 * CTRL+Z rather than a reload — `setBlockEntity` records the whole record
 * either side, which is what makes that exact.
 */
export function editBlockEntityValue(
  session: DocumentSession,
  x: number,
  y: number,
  z: number,
  path: readonly (string | number)[],
  value: string,
): number {
  const existing = session.doc.blockEntities.get(`${x},${y},${z}`) ?? null;
  if (existing === null) {
    throw new NoBlockEntityError();
  }
  // Coerced before the transaction opens: `setNbtValue` throws on anything it
  // cannot represent, and a transaction that opens only to roll back would
  // still have bumped the revision and thrown away the redo stack.
  const nbt = setNbtValue(existing.nbt, path, value);
  const label = `Edit ${existing.id} ${path.join(".")}`;
  return runTransaction(session.doc, session.history, label, (tx) => {
    tx.setBlockEntity(x, y, z, { ...existing, nbt });
    return 1;
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The GLB for the current state, rebuilt only when the document has moved on.
 *
 * `doc.revision` is exactly the right key: monotonic, and bumped by every
 * mutation including an undo, so a stale mesh can never masquerade as current.
 */
export async function documentMesh(
  session: DocumentSession,
  options: DocumentPreviewOptions,
  held: { mesh: string | null; atlas: number | null } = { mesh: null, atlas: null },
): Promise<{ mesh: MeshPayload; center: [number, number, number]; size: [number, number, number]; cached: boolean }> {
  // The revision is not the whole key. The two biome tints are multiplied into
  // the texture atlas rather than applied by the viewer, so changing one has to
  // rebuild the mesh — and it changes no revision, because it changes no block.
  // Keying on what the mesh was actually built from means nobody has to
  // remember to invalidate it: the same "observed, not announced" reasoning
  // `chunked_mesh.ts` uses for dirty chunks.
  const key = [
    session.doc.revision,
    options.resourcePackPath ?? options.fallbackResourcePackPath ?? "",
    options.biomeColor ?? "",
    options.waterColor ?? "",
    // Same reasoning as the tints: it changes the mesh and changes no block, so
    // the revision alone would hand back a stale one.
    options.showMarkers === false ? "hide" : "show",
    // And the same again: light and occlusion are baked into the vertices.
    options.blockLight === false ? "flat" : "lit",
    options.occlusion === false ? "open" : "ao",
    options.smoothLighting === false ? "flat-light" : "smooth",
    // And once more: the void block is drawn into the geometry and moves
    // no revision, so the same stale mesh would come back after changing it.
    options.voidBlock ?? "",
  ].join("|");

  const cached = session.mesh !== null && session.mesh.key === key;
  if (!cached) {
    const built = await buildDocumentPreview(session.doc, options, session.meshCache);
    session.meshCache = built.meshCache;
    session.mesh = {
      key,
      payload: built.mesh,
      center: built.center,
      size: built.size,
    };
  }
  const { payload, center, size } = session.mesh!;
  return { mesh: shipMesh(session, key, payload, held), center, size, cached };
}

/**
 * The smallest honest answer to "what changed since the thing you already
 * have".
 *
 * Main re-meshes only the chunks an edit touched -- three of a hundred and
 * twenty-eight, for one placed block -- and then shipped all of them anyway,
 * with the atlas: 17.5 MB of geometry plus 20.8 MB of pixels, structured-cloned
 * across the boundary and rebuilt into fresh `BufferGeometry` on arrival, per
 * block. That is what the stutter was, and none of it was the meshing.
 *
 * The test for "changed" is object identity on the positions array, which is
 * exact rather than approximate: `buildChunkedMesh` carries the very same
 * `MeshBuffers` forward for a chunk it did not re-mesh, so a different array
 * means a different chunk and the same array means the same one. No hashing,
 * no bookkeeping at the call sites, nothing to forget.
 *
 * A token the renderer does not recognise -- or does not send -- costs a full
 * payload, which is the right failure: everything is a correct answer to
 * everything, and only the size varies.
 */
/**
 * The two numbers that identify a chunk's geometry, as one string.
 *
 * A composite key rather than a nested map because the only thing done
 * with it is equality, and `refOfChunkId` next door is what keeps it from
 * being a one-way encoding nobody can read back.
 */
function chunkId(chunk: { key: number; layer: ChunkLayer }): string {
  return `${chunk.layer}:${chunk.key}`;
}

function refOfChunkId(id: string): ChunkRef {
  const cut = id.indexOf(":");
  return {
    layer: id.slice(0, cut) as ChunkLayer,
    key: Number(id.slice(cut + 1)),
  };
}

function shipMesh(
  session: DocumentSession,
  token: string,
  payload: MeshPayload,
  held: { mesh: string | null; atlas: number | null },
): MeshPayload {
  const sent = session.sent ?? null;
  /*
   * `sent.chunks.size > 0` keeps the renderer's side simple.
   *
   * An empty document sends no chunks, so the viewport takes its model down --
   * and a delta against nothing would then arrive at a scene with nothing to
   * update. Answering the first payload after an empty one in full means the
   * renderer never has to reason about that case at all.
   */
  const incremental =
    sent !== null && sent.chunks.size > 0 && held.mesh !== null && held.mesh === sent.token;

  /*
   * Identity is per (layer, key), not per key.
   *
   * The two layers of one chunk are different geometry under one number,
   * and they move in opposite directions: breaking the last block in a
   * chunk empties its solid layer and fills its void one. Keyed on the
   * number alone, one of the two would stand in for the other and the
   * renderer would be told nothing changed.
   */
  const chunks = incremental
    ? payload.chunks.filter((chunk) => sent!.chunks.get(chunkId(chunk)) !== chunk.positions)
    : payload.chunks;

  let dropped: ChunkRef[] = [];
  if (incremental) {
    const present = new Set(payload.chunks.map(chunkId));
    dropped = [...sent!.chunks.keys()]
      .filter((id) => !present.has(id))
      .map(refOfChunkId);
  }

  session.sent = {
    token,
    chunks: new Map(payload.chunks.map((chunk) => [chunkId(chunk), chunk.positions])),
  };

  return {
    chunks,
    dropped,
    partial: incremental,
    token,
    // The atlas is the larger half and changes far less often than the
    // geometry: it grows only when a block type nothing has drawn before
    // appears, which after the startup warm-up is never.
    atlas: held.atlas === payload.atlasVersion ? null : payload.atlas,
    atlasVersion: payload.atlasVersion,
  };
}


// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export interface SaveOptions {
  /** Omitted means "save over the file it came from". */
  filePath?: string | null;
  format?: SchematicFormat;
  /**
   * The Minecraft version to stamp, as a `DataVersion`.
   *
   * Omitted keeps what the document carries; `null` writes no tag at all, which
   * is what a pre-Flattening container wants and is a different instruction
   * from "leave it alone".
   */
  dataVersion?: number | null;
  legacyBlocksPath?: string | null;
}

export class NoSaveTargetError extends Error {
  constructor() {
    super("This schematic has never been saved; choose where to put it");
    this.name = "NoSaveTargetError";
  }
}

export async function saveSession(
  session: DocumentSession,
  options: SaveOptions = {},
): Promise<WriteResult & { filePath: string; cropped: CropSummary | null }> {
  const format = options.format ?? session.doc.format;
  /*
   * `undefined` keeps what the document carries; `null` is a real choice and
   * means "write no version tag", which is what a pre-Flattening container
   * wants. Conflating the two would make it impossible to ask for either.
   */
  if (options.dataVersion !== undefined) {
    session.doc.dataVersion = options.dataVersion;
  }
  let target = options.filePath ?? session.doc.filePath;
  if (!target) {
    throw new NoSaveTargetError();
  }
  // Save As into a different container renames the file to match, so a v3
  // schematic does not end up sitting in a `.schematic`.
  const wanted = `.${schematicExtension(format)}`;
  if (path.extname(target).toLowerCase() !== wanted) {
    target = target.slice(0, target.length - path.extname(target).length) + wanted;
  }

  /*
   * Trim the air the editor left around the build.
   *
   * The *copy* is written, never the open document: a voxel index means
   * nothing except relative to the dimensions in force when it was recorded,
   * so re-dimensioning the live document would invalidate every delta on the
   * undo stack. Saving must not cost you your history.
   */
  const cropped = cropToContent(session.doc);
  const result = await saveDocument(cropped?.doc ?? session.doc, target, {
    format,
    // Named rather than left to the copy: `cropToContent` builds a new document
    // and the version has to survive the trip, which is the sort of thing that
    // works until someone adds a field to the crop and forgets this one.
    dataVersion: session.doc.dataVersion,
    legacyBlocksPath: options.legacyBlocksPath ?? null,
  });

  // The document now *is* that file, in that format: a later plain Save must
  // write the same one rather than reverting to where it was opened from.
  session.doc.format = format;
  markSaved(session.doc, target);
  markHistorySaved(session.history);
  return { ...result, filePath: target, cropped: cropped?.summary ?? null };
}
