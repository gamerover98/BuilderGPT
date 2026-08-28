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
  runTransaction,
  undo,
  type History,
} from "../domain/history.js";

import {
  copyRegion,
  pasteClipboard,
  type Clipboard,
  type PasteOptions,
} from "../domain/clipboard.js";
import { flattenNbt, setNbtValue } from "../domain/nbt_edit.js";
import {
  applyRegionTransform,
  describeTransform,
  NotSquareError,
  type RegionTransform,
} from "../domain/transform.js";

export { NotSquareError, type RegionTransform };
import { loadStructure } from "../pipeline/loader.js";
import type { PaletteEntry } from "../pipeline/types.js";
import { hasProperty } from "../../shared/block_states.js";
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
} from "../domain/grow.js";

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
  sent?: { token: string; chunks: Map<number, Float32Array> } | null;
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
  current = {
    doc: documentFromLoaded(loaded, filePath),
    history: createHistory(),
    mesh: null,
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
  current = { doc, history: history ?? createHistory(), mesh: null };
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
    revision: doc.revision,
  };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function toEntry(block: { namespacedName: string; properties?: Record<string, string> }): PaletteEntry {
  return { namespacedName: block.namespacedName, properties: block.properties ?? {} };
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
 * What an edit is allowed to do beyond writing blocks.
 *
 * Passed in rather than read from the settings store, because this module is
 * reachable from the suites and `settings-store.ts` imports Electron -- the
 * same reason `settings_coerce.ts` was split out of it.
 */
export interface EditOptions {
  /** Default true, which is what the editor did before there was a setting. */
  autoGrow?: boolean;
}

export function applyEdit(
  session: DocumentSession,
  request: EditRequest,
  options: EditOptions = {},
): number {
  const { doc, history } = session;
  const mayGrow = options.autoGrow !== false;

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
  if (request.kind === "setBlock") {
    const entry = floodedPlacement(doc, request, toEntry(request.block));

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
    const wanted =
      entry.namespacedName === "minecraft:air" ? null : growthToInclude(doc, cell);
    // Refused rather than clipped: see `OutsideDocumentError`. A break is
    // exempt because it never wanted to grow in the first place, so with
    // auto-grow off it goes on doing exactly what it did before.
    if (wanted !== null && !mayGrow) throw new OutsideDocumentError();
    const growth = wanted;
    if (growth !== null && extentVolume(growth.size) > MAX_DOCUMENT_VOLUME) {
      throw new DocumentTooLargeError(extentVolume(growth.size));
    }
    const at = growth === null ? cell : shiftRegion(cell, growth.shift);

    return runTransaction(doc, history, `Place ${entry.namespacedName}`, (tx) => {
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
      return tx.setBlock(at.minX, at.minY, at.minZ, entry) ? 1 : 0;
    });
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
    const entry = toEntry(request.block);
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
    const entry = toEntry(request.block);
    return runTransaction(doc, history, `Fill with ${entry.namespacedName}`, (tx) => {
      // One transaction, so growing and filling are one undo step -- and the
      // resize goes in first, because a block delta recorded before it would be
      // an index into the old shape. `history.ts` flushes on resize for exactly
      // that reason.
      if (growth !== null) tx.resize(growth.size, growth.shift);
      return tx.fill(region, entry);
    });
  }

  const from = toEntry(request.from);
  const to = toEntry(request.to);
  return runTransaction(
    doc,
    history,
    `Replace ${from.namespacedName} with ${to.namespacedName}`,
    (tx) => tx.replace(region, from, to),
  );
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

export function currentClipboard(): Clipboard | null {
  return clipboard;
}

/** Copies a region out. Reads only, so no transaction. */
export function copySelection(session: DocumentSession, request: RegionSpec): Clipboard {
  clipboard = copyRegion(session.doc, normalizeRegion(session.doc, request));
  return clipboard;
}

/** Copies, then clears — one undoable step for the clearing half. */
export function cutSelection(session: DocumentSession, request: RegionSpec): Clipboard {
  const { doc, history } = session;
  const region = normalizeRegion(doc, request);
  clipboard = copyRegion(doc, region);
  runTransaction(doc, history, "Cut the selection", (tx) =>
    tx.fill(region, { namespacedName: "minecraft:air", properties: {} }),
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
export function moveRegion(
  session: DocumentSession,
  request: RegionSpec,
  to: { x: number; y: number; z: number },
): number {
  const { doc, history } = session;
  const region = normalizeRegion(doc, request);
  const held = copyRegion(doc, region);
  return runTransaction(doc, history, "Move the selection", (tx) => {
    let changed = tx.fill(region, { namespacedName: "minecraft:air", properties: {} });
    changed += pasteClipboard(doc, tx, held, to, { includeAir: true });
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
export function transformRegion(
  session: DocumentSession,
  request: RegionSpec,
  transform: RegionTransform,
): number {
  const { doc, history } = session;
  return runTransaction(doc, history, describeTransform(transform), (tx) =>
    applyRegionTransform(doc, tx, request, transform),
  );
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

  const chunks = incremental
    ? payload.chunks.filter((chunk) => sent!.chunks.get(chunk.key) !== chunk.positions)
    : payload.chunks;

  let dropped: number[] = [];
  if (incremental) {
    const present = new Set(payload.chunks.map((chunk) => chunk.key));
    dropped = [...sent!.chunks.keys()].filter((chunkKey) => !present.has(chunkKey));
  }

  session.sent = {
    token,
    chunks: new Map(payload.chunks.map((chunk) => [chunk.key, chunk.positions])),
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
