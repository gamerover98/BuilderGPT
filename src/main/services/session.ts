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
  DocumentState,
  EditRequest,
  PaletteCount,
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
  type SchematicDocument,
} from "../domain/document.js";
import {
  canRedo,
  canUndo,
  createHistory,
  isDirty,
  markHistorySaved,
  nextRedoLabel,
  nextUndoLabel,
  redo,
  runTransaction,
  undo,
  type History,
} from "../domain/history.js";
import type { ModelMessage } from "ai";

import { flattenNbt, setNbtValue } from "../domain/nbt_edit.js";
import { loadStructure } from "../pipeline/loader.js";
import type { PaletteEntry } from "../pipeline/types.js";
import { buildDocumentPreview, type DocumentPreviewOptions } from "./preview.js";
import type { ChunkMeshCache } from "../pipeline/chunked_mesh.js";
import { saveDocument, type WriteResult } from "./writers.js";

export interface DocumentSession {
  readonly doc: SchematicDocument;
  readonly history: History;
  /** The GLB last handed out, and the revision it was built from. */
  mesh: { revision: number; glb: Uint8Array; center: [number, number, number]; size: [number, number, number] } | null;
  /**
   * Per-chunk geometry carried between rebuilds, so an edit re-meshes only the
   * chunks it touched. Belongs to the session because it is per document; the
   * baker and atlas behind it are shared and live in `preview.ts`.
   */
  meshCache?: ChunkMeshCache;
  /**
   * What has been said to the agent about this document, in the shape the model
   * consumes — user turns, its tool calls, and their results.
   *
   * Per session because a conversation is *about* a schematic: "make it taller"
   * means nothing once a different file is open, so closing the document has to
   * take the conversation with it. That happens for free by living here rather
   * than in a module-level map.
   *
   * It deliberately holds no summary of the schematic; `agent.ts` regenerates
   * that into the instructions each turn. The renderer keeps its own display
   * copy of the exchange and never sees this one.
   */
  conversation?: ModelMessage[];
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

/** The most common blocks first, so the UI can show a meaningful few. */
function paletteCounts(doc: SchematicDocument, limit = 64): PaletteCount[] {
  return [...paletteHistogram(doc).entries()]
    .filter(([block]) => !block.startsWith("minecraft:air"))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([block, count]) => ({ block, count }));
}

export function documentState(session: DocumentSession): DocumentState {
  const { doc, history } = session;
  return {
    filePath: doc.filePath,
    fileName: doc.filePath === null ? null : path.basename(doc.filePath),
    format: doc.format,
    size: [doc.width, doc.height, doc.length],
    offset: [...doc.offset] as [number, number, number],
    blockCount: countBlocks(doc),
    palette: paletteCounts(doc),
    dirty: isDirty(history),
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    undoLabel: nextUndoLabel(history),
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
 * Applies one request as one undoable step.
 *
 * The label is what the undo menu will say, so it is built from the request
 * rather than passed in: the renderer should not be able to mislabel history.
 */
export function applyEdit(session: DocumentSession, request: EditRequest): number {
  const { doc, history } = session;

  if (request.kind === "setBlock") {
    const entry = toEntry(request.block);
    return runTransaction(doc, history, `Place ${entry.namespacedName}`, (tx) =>
      tx.setBlock(request.x, request.y, request.z, entry) ? 1 : 0,
    );
  }

  const region = normalizeRegion(doc, request.region);
  const volume = regionVolume(region);
  if (volume > MAX_EDIT_VOLUME) {
    throw new EditTooLargeError(volume);
  }

  if (request.kind === "fill") {
    const entry = toEntry(request.block);
    return runTransaction(doc, history, `Fill with ${entry.namespacedName}`, (tx) =>
      tx.fill(region, entry),
    );
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
export function clearConversation(session: DocumentSession): void {
  session.conversation = [];
}

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
): Promise<{ glb: Uint8Array; center: [number, number, number]; size: [number, number, number]; cached: boolean }> {
  if (session.mesh && session.mesh.revision === session.doc.revision) {
    const { glb, center, size } = session.mesh;
    return { glb, center, size, cached: true };
  }
  const built = await buildDocumentPreview(session.doc, options, session.meshCache);
  session.meshCache = built.meshCache;
  session.mesh = {
    revision: session.doc.revision,
    glb: built.glb,
    center: built.center,
    size: built.size,
  };
  return { glb: built.glb, center: built.center, size: built.size, cached: false };
}

/** Drops the cached mesh — the tints changed, so the atlas will differ. */
export function invalidateMesh(session: DocumentSession): void {
  session.mesh = null;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export interface SaveOptions {
  /** Omitted means "save over the file it came from". */
  filePath?: string | null;
  format?: SchematicFormat;
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
): Promise<WriteResult & { filePath: string }> {
  const format = options.format ?? session.doc.format;
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

  const result = await saveDocument(session.doc, target, {
    format,
    legacyBlocksPath: options.legacyBlocksPath ?? null,
  });

  // The document now *is* that file, in that format: a later plain Save must
  // write the same one rather than reverting to where it was opened from.
  session.doc.format = format;
  markSaved(session.doc, target);
  markHistorySaved(session.history);
  return { ...result, filePath: target };
}
