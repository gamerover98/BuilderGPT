/**
 * Undo, redo, and the transaction boundary that makes an AI edit one step.
 *
 * The requirement that shapes everything here: if the agent rewrites five
 * hundred blocks to answer one request, CTRL+Z must undo the request, not the
 * five hundredth block. So mutations are recorded into a *transaction*, and the
 * transaction is the unit the stack holds.
 *
 * ## Deltas, not snapshots
 *
 * A transaction stores what changed -- `(voxel index, palette index before,
 * palette index after)` -- never a copy of the schematic. A 500-block edit is
 * 500 triples whatever the structure's size, so the stack costs about as much
 * as the edits it holds rather than a multiple of the document.
 *
 * This works only because of `document.ts`'s append-only palette invariant: a
 * recorded `before` index has to still mean the same block when it is put back,
 * possibly many edits later. That is also why reverting writes to `voxels`
 * directly instead of going through `setBlock` -- the index is already known
 * good, and re-interning would be a no-op at best.
 *
 * ## Resizes are their own command
 *
 * A voxel index only means anything relative to the dimensions in force when it
 * was recorded, so a resize cannot share a command with block writes. Each
 * transaction is therefore a *list* of commands applied in order and reverted
 * in reverse, and a resize always sits in one of its own.
 *
 * ## Dirtiness lives here
 *
 * Not on the document's revision counter, which is monotonic so it can serve as
 * a cache key. `savedDepth` records how deep the undo stack was when the file
 * was last written, so undoing back to that point reads as clean again -- which
 * is what every editor does and what a revision counter cannot express.
 */

import {
  paletteEntryCacheKey,
  type BlockEntityRecord,
  type EntityRecord,
  type NbtCompound,
  type PaletteEntry,
} from "../pipeline/types.js";
import { deriveConnections } from "./connect.js";
import {
  posKey,
  resizeDocument,
  setBlock,
  setBlockEntity,
  type Region,
  type SchematicDocument,
} from "./document.js";

/** One voxel that changed, in the dimensions in force at the time. */
export interface BlockDelta {
  readonly index: number;
  readonly before: number;
  readonly after: number;
}

/** One block entity that appeared, vanished, or was replaced. */
export interface BlockEntityDelta {
  readonly key: string;
  readonly before: BlockEntityRecord | null;
  readonly after: BlockEntityRecord | null;
}

interface Dimensions {
  readonly width: number;
  readonly height: number;
  readonly length: number;
  readonly offset: readonly [number, number, number] | null;
  /** Moves with the shift exactly as `offset` does; `null` stays `null`. */
  readonly worldOrigin: readonly [number, number, number] | null;
}

/**
 * Everything about a schematic that is not a block: where it sat in the world,
 * what version wrote it, the file's own metadata, and the entities inside it.
 *
 * One whole state rather than a patch of changed fields. A partial merge is one
 * more place for a field added later to be silently dropped -- the failure
 * `coerceSettings` exists to prevent -- and these are small enough that copying
 * all five costs nothing worth trading for.
 *
 * Block entities are deliberately *not* here: they already have `BlockEntityDelta`
 * and `setBlockEntity`, which key on position, and a whole-map snapshot beside
 * a per-position delta would be two records of one thing.
 */
export interface HeaderState {
  readonly offset: readonly [number, number, number] | null;
  readonly worldOrigin: readonly [number, number, number] | null;
  readonly dataVersion: number | null;
  readonly metadata: NbtCompound;
  readonly entities: readonly EntityRecord[];
}

export type Command =
  | {
      readonly kind: "blocks";
      readonly blocks: readonly BlockDelta[];
      readonly blockEntities: readonly BlockEntityDelta[];
    }
  | {
      readonly kind: "resize";
      readonly before: Dimensions;
      readonly after: Dimensions;
      readonly shift: readonly [number, number, number];
      /**
       * Voxels that fell outside the new box, indexed in the *old* frame.
       * Without these a shrink would be unundoable: the blocks are simply gone
       * from the grid, and nothing else records what they were.
       */
      readonly dropped: readonly BlockDelta[];
      readonly droppedEntities: readonly BlockEntityRecord[];
    }
  | {
      readonly kind: "header";
      readonly before: HeaderState;
      readonly after: HeaderState;
    };

export interface Transaction {
  /**
   * Unique within a history, and monotonic.
   *
   * Exists because callers need to name a particular transaction across a
   * process boundary, and the label cannot: it is derived from what the user
   * asked for, so two turns saying the same thing produce the same string. The
   * chat's "Undo this" matched on that string and could revert the wrong turn.
   */
  readonly id: number;
  readonly label: string;
  readonly commands: readonly Command[];
}

export interface History {
  readonly undoStack: Transaction[];
  readonly redoStack: Transaction[];
  /** Depth of `undoStack` when the document was last written to disk. */
  savedDepth: number;
  /** Oldest transactions are discarded past this; 0 means unlimited. */
  limit: number;
  /** Next transaction id. Never reused, including after a drop off the end. */
  nextId: number;
}

export function createHistory(limit = 200): History {
  return { undoStack: [], redoStack: [], savedDepth: 0, limit, nextId: 1 };
}

/** True when the document differs from what is on disk. */
export function isDirty(history: History): boolean {
  return history.undoStack.length !== history.savedDepth;
}

/**
 * Records the current state as saved.
 *
 * Also clears `redoStack`'s claim on the saved depth being reachable: it does
 * not, because redoing past a save is perfectly normal and simply makes the
 * document dirty again, which the depth comparison already says.
 */
export function markHistorySaved(history: History): void {
  history.savedDepth = history.undoStack.length;
}

export function canUndo(history: History): boolean {
  return history.undoStack.length > 0;
}

export function canRedo(history: History): boolean {
  return history.redoStack.length > 0;
}

/** What the next CTRL+Z would undo, for labelling the menu item. */
export function nextUndoLabel(history: History): string | null {
  return history.undoStack[history.undoStack.length - 1]?.label ?? null;
}

export function nextRedoLabel(history: History): string | null {
  return history.redoStack[history.redoStack.length - 1]?.label ?? null;
}

/**
 * The id of the transaction an undo would revert, or `null` for an empty stack.
 *
 * The label's counterpart, and the one to compare against: a caller holding an
 * id knows whether the thing it is offering to undo is still the thing on top.
 */
export function nextUndoId(history: History): number | null {
  return history.undoStack[history.undoStack.length - 1]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * The handle a transaction body mutates the document through.
 *
 * Every method here both applies the change and records it. Going around it --
 * calling `document.ts`'s `setBlock` directly during a transaction -- produces
 * an edit that cannot be undone, so callers inside a transaction should not.
 */
export interface TransactionScope {
  setBlock(x: number, y: number, z: number, entry: PaletteEntry): boolean;
  setBlockEntity(x: number, y: number, z: number, record: BlockEntityRecord | null): void;
  fill(region: Region, entry: PaletteEntry): number;
  replace(region: Region, from: PaletteEntry, to: PaletteEntry): number;
  /**
   * `replace` for several patterns at once, in **one** pass over the voxels.
   *
   * Calling `replace` in a loop is N passes, and the caller that wants this is
   * backporting a schematic: fifty blocks the older version never had, over a
   * document that may be tens of millions of cells. One pass is the difference
   * between a wait and a hang.
   */
  replaceAny(region: Region, from: readonly PaletteEntry[], to: PaletteEntry): number;
  resize(
    size: { width: number; height: number; length: number },
    shift?: readonly [number, number, number],
  ): void;
  /** Replaces everything about the schematic that is not a block. */
  setHeader(next: HeaderState): void;
  /** Voxels changed so far. */
  readonly changed: number;
}

/** The document's current header, for a caller that wants to change one field. */
export function readHeader(doc: SchematicDocument): HeaderState {
  return {
    offset: doc.offset === null ? null : ([...doc.offset] as [number, number, number]),
    worldOrigin: doc.worldOrigin === null ? null : ([...doc.worldOrigin] as [number, number, number]),
    dataVersion: doc.dataVersion,
    metadata: structuredClone(doc.metadata),
    entities: doc.entities.map((entity) => ({ ...entity, nbt: structuredClone(entity.nbt) })),
  };
}

/**
 * Writes a whole header onto the document, and says whether anything moved.
 *
 * Copies, so the stack keeps its own. The comparison is against `readHeader`
 * on both sides rather than against the argument, so a caller that assembled
 * the same values in a different key order still counts as no change.
 *
 * `revision` is bumped only when something did move. It is a mesh cache key,
 * and bumping it for an Apply that changed nothing would also invalidate the
 * `revision` the NBT panel is holding -- so pressing Apply twice would have the
 * second press refused as stale.
 */
function applyHeader(doc: SchematicDocument, state: HeaderState): boolean {
  const before = JSON.stringify(readHeader(doc));
  doc.offset = state.offset === null ? null : ([...state.offset] as [number, number, number]);
  doc.worldOrigin =
    state.worldOrigin === null ? null : ([...state.worldOrigin] as [number, number, number]);
  doc.dataVersion = state.dataVersion;
  doc.metadata = structuredClone(state.metadata) as NbtCompound;
  doc.entities = state.entities.map((entity) => ({ ...entity, nbt: structuredClone(entity.nbt) }));
  if (before === JSON.stringify(readHeader(doc))) {
    return false;
  }
  doc.revision += 1;
  return true;
}

class Recorder implements TransactionScope {
  private readonly blocks = new Map<number, { before: number; after: number }>();
  private readonly entities = new Map<string, { before: BlockEntityRecord | null; after: BlockEntityRecord | null }>();
  readonly commands: Command[] = [];

  constructor(private readonly doc: SchematicDocument) {}

  /**
   * Closes the block command currently being accumulated.
   *
   * Called before a resize and at commit, because a resize invalidates every
   * index recorded so far -- the deltas before it and after it belong to
   * different coordinate frames and must not end up in one command.
   */
  flush(): void {
    if (this.blocks.size === 0 && this.entities.size === 0) {
      return;
    }
    this.commands.push({
      kind: "blocks",
      blocks: [...this.blocks.entries()].map(([index, delta]) => ({ index, ...delta })),
      blockEntities: [...this.entities.entries()].map(([key, delta]) => ({ key, ...delta })),
    });
    this.blocks.clear();
    this.entities.clear();
  }

  /**
   * The voxels this recorder has written, in the shape currently in force.
   *
   * `deriveConnections` reads it to find where to look for blocks whose state
   * depends on a neighbour. Only the *live* set: a resize calls `flush`, so
   * anything already pushed into `commands` belongs to a different coordinate
   * frame and indexing it would rewrite an unrelated block.
   */
  touchedIndices(): Iterable<number> {
    return this.blocks.keys();
  }

  /**
   * Coalesced by voxel: the first `before` and the latest `after` win, so a
   * script that writes the same cell a hundred times leaves one delta. Reverting
   * in reverse order would also be correct, but not compact.
   */
  private recordBlock(index: number, before: number, after: number): void {
    const existing = this.blocks.get(index);
    if (existing) {
      existing.after = after;
    } else {
      this.blocks.set(index, { before, after });
    }
  }

  private recordEntity(
    key: string,
    before: BlockEntityRecord | null,
    after: BlockEntityRecord | null,
  ): void {
    const existing = this.entities.get(key);
    if (existing) {
      existing.after = after;
    } else {
      this.entities.set(key, { before, after });
    }
  }

  setBlock(x: number, y: number, z: number, entry: PaletteEntry): boolean {
    const change = setBlock(this.doc, x, y, z, entry);
    if (change === null) {
      return false;
    }
    this.recordBlock(change.index, change.before, change.after);
    if (change.beforeEntity !== null) {
      this.recordEntity(posKey(x, y, z), change.beforeEntity, null);
    }
    return true;
  }

  setBlockEntity(x: number, y: number, z: number, record: BlockEntityRecord | null): void {
    const key = posKey(x, y, z);
    const before = this.doc.blockEntities.get(key) ?? null;
    setBlockEntity(this.doc, x, y, z, record);
    this.recordEntity(key, before, record);
  }

  fill(region: Region, entry: PaletteEntry): number {
    let count = 0;
    for (let x = region.minX; x <= region.maxX; x += 1) {
      for (let y = region.minY; y <= region.maxY; y += 1) {
        for (let z = region.minZ; z <= region.maxZ; z += 1) {
          if (this.setBlock(x, y, z, entry)) {
            count += 1;
          }
        }
      }
    }
    return count;
  }

  /**
   * Rewrites every cell in `region` holding `from`.
   *
   * **`from` is a pattern, and naming no properties means the block in any
   * state.** That is what the rest of the codebase already assumed it was: it
   * is the stated reason `replace_blocks` parses its `from` with `toEntry`
   * rather than `toPlacedEntry`, so that asking to take out the campfires does
   * not quietly become asking for the ones that happen to face north.
   *
   * It was not one. `from` was interned and compared as an exact index, so a
   * bare name matched only a palette entry that carried no properties at all --
   * and interning it *added* that entry, leaving a dead row behind on every
   * miss. On a flat document that reads as an occasional puzzle. On a legacy
   * one it is total: `legacy_blocks.json` gives a state to 1,449 of its 1,682
   * rows, so a `.schematic` opens with `grass_block[snowy=false]` and
   * `oak_fence[east=false,...]` in its palette and *nothing a person can type*
   * matches any of it. Every replace answered `changed: 0`.
   *
   * Spelling the state out still means exactly that state, which is how you
   * take out one stair orientation and leave the others.
   *
   * The palette may grow underneath this: `setBlock` interns `to` if it is new.
   * Reading past the end of `wanted` yields `undefined`, which is falsy and is
   * the right answer -- a row added during the pass is `to`, and rewriting what
   * has just been written is precisely what must not happen.
   */
  replace(region: Region, from: PaletteEntry, to: PaletteEntry): number {
    return this.replaceAny(region, [from], to);
  }

  replaceAny(region: Region, from: readonly PaletteEntry[], to: PaletteEntry): number {
    /*
     * Decided once over the palette, then read per voxel. Comparing names at
     * every cell would be a string compare per block; this is an array read,
     * which is what the interned-index version bought and is worth keeping.
     */
    const wanted = new Uint8Array(this.doc.palette.length);
    let any = false;
    for (const pattern of from) {
      const exact = Object.keys(pattern.properties).length > 0;
      const key = paletteEntryCacheKey(pattern);
      for (let i = 0; i < this.doc.palette.length; i += 1) {
        if (wanted[i] === 1) continue;
        const entry = this.doc.palette[i];
        const hit = exact
          ? paletteEntryCacheKey(entry) === key
          : entry.namespacedName === pattern.namespacedName;
        if (hit) {
          wanted[i] = 1;
          any = true;
        }
      }
    }
    // Nothing to match, and deliberately nothing interned: a miss must not
    // leave a palette entry for a block the schematic does not contain.
    if (!any) return 0;

    let count = 0;
    for (let x = region.minX; x <= region.maxX; x += 1) {
      for (let y = region.minY; y <= region.maxY; y += 1) {
        for (let z = region.minZ; z <= region.maxZ; z += 1) {
          const index = x * this.doc.height * this.doc.length + y * this.doc.length + z;
          if (wanted[this.doc.voxels[index]] === 1 && this.setBlock(x, y, z, to)) {
            count += 1;
          }
        }
      }
    }
    return count;
  }

  resize(
    size: { width: number; height: number; length: number },
    shift: readonly [number, number, number] = [0, 0, 0],
  ): void {
    this.flush();
    const doc = this.doc;
    const before: Dimensions = {
      width: doc.width,
      height: doc.height,
      length: doc.length,
      offset: doc.offset === null ? null : ([...doc.offset] as [number, number, number]),
      worldOrigin:
        doc.worldOrigin === null ? null : ([...doc.worldOrigin] as [number, number, number]),
    };

    // Everything the new box will not contain, captured before it is lost.
    const dropped: BlockDelta[] = [];
    const droppedEntities: BlockEntityRecord[] = [];
    const [dx, dy, dz] = shift;
    for (let x = 0; x < doc.width; x += 1) {
      const nx = x + dx;
      for (let y = 0; y < doc.height; y += 1) {
        const ny = y + dy;
        for (let z = 0; z < doc.length; z += 1) {
          const nz = z + dz;
          const inside =
            nx >= 0 && nx < size.width && ny >= 0 && ny < size.height && nz >= 0 && nz < size.length;
          if (inside) {
            continue;
          }
          const index = x * doc.height * doc.length + y * doc.length + z;
          const value = doc.voxels[index];
          if (value !== 0) {
            dropped.push({ index, before: value, after: 0 });
          }
        }
      }
    }
    for (const record of doc.blockEntities.values()) {
      const nx = record.pos[0] + dx;
      const ny = record.pos[1] + dy;
      const nz = record.pos[2] + dz;
      if (nx < 0 || nx >= size.width || ny < 0 || ny >= size.height || nz < 0 || nz >= size.length) {
        droppedEntities.push(record);
      }
    }

    resizeDocument(doc, size, shift);

    this.commands.push({
      kind: "resize",
      before,
      after: {
        width: doc.width,
        height: doc.height,
        length: doc.length,
        offset: doc.offset === null ? null : ([...doc.offset] as [number, number, number]),
        worldOrigin:
          doc.worldOrigin === null ? null : ([...doc.worldOrigin] as [number, number, number]),
      },
      shift: [dx, dy, dz],
      dropped,
      droppedEntities,
    });
  }

  /**
   * Flushed first, like a resize, for a narrower version of the same reason:
   * this command replaces the entity list wholesale, and a block delta either
   * side of it must not end up inside the same command as the replacement.
   */
  setHeader(next: HeaderState): void {
    this.flush();
    const before = readHeader(this.doc);
    if (!applyHeader(this.doc, next)) {
      // Nothing moved, so nothing is recorded -- the same rule `runTransaction`
      // applies to a body that changes no voxels. Applying the panel's text
      // unedited must not leave a step on the stack for the user to undo.
      return;
    }
    this.commands.push({ kind: "header", before, after: readHeader(this.doc) });
  }

  get changed(): number {
    let total = this.blocks.size;
    for (const command of this.commands) {
      if (command.kind === "blocks") {
        total += command.blocks.length;
      }
    }
    return total;
  }
}

// ---------------------------------------------------------------------------
// Applying and reverting
// ---------------------------------------------------------------------------

function applyCommand(doc: SchematicDocument, command: Command): void {
  if (command.kind === "blocks") {
    for (const delta of command.blocks) {
      doc.voxels[delta.index] = delta.after;
    }
    for (const delta of command.blockEntities) {
      if (delta.after === null) {
        doc.blockEntities.delete(delta.key);
      } else {
        doc.blockEntities.set(delta.key, delta.after);
      }
    }
    doc.revision += 1;
    return;
  }

  if (command.kind === "header") {
    applyHeader(doc, command.after);
    return;
  }

  // The offset and the world origin are left to `resizeDocument` here, unlike
  // in the revert below: redoing a resize re-derives them from the shift, which
  // is exactly how they got their recorded values the first time.
  resizeDocument(
    doc,
    { width: command.after.width, height: command.after.height, length: command.after.length },
    command.shift,
  );
}

function revertCommand(doc: SchematicDocument, command: Command): void {
  if (command.kind === "blocks") {
    for (const delta of command.blocks) {
      doc.voxels[delta.index] = delta.before;
    }
    for (const delta of command.blockEntities) {
      if (delta.before === null) {
        doc.blockEntities.delete(delta.key);
      } else {
        doc.blockEntities.set(delta.key, delta.before);
      }
    }
    doc.revision += 1;
    return;
  }

  if (command.kind === "header") {
    applyHeader(doc, command.before);
    return;
  }

  // Undo the resize by resizing back with the inverse shift, then restore
  // whatever the shrink threw away. The order matters: the dropped deltas are
  // indexed in the old frame, which only exists again after the resize back.
  resizeDocument(
    doc,
    { width: command.before.width, height: command.before.height, length: command.before.length },
    [-command.shift[0], -command.shift[1], -command.shift[2]],
  );
  for (const delta of command.dropped) {
    doc.voxels[delta.index] = delta.before;
  }
  for (const record of command.droppedEntities) {
    doc.blockEntities.set(posKey(record.pos[0], record.pos[1], record.pos[2]), record);
  }
  // `resizeDocument` recomputes the offset from the shift, which is right for a
  // resize but not necessarily for the inverse of one -- restore what was
  // actually recorded rather than trusting the arithmetic to round-trip. The
  // world origin travels with it for the same reason.
  doc.offset =
    command.before.offset === null
      ? null
      : ([...command.before.offset] as [number, number, number]);
  doc.worldOrigin =
    command.before.worldOrigin === null
      ? null
      : ([...command.before.worldOrigin] as [number, number, number]);
  doc.revision += 1;
}

// ---------------------------------------------------------------------------
// The transaction boundary
// ---------------------------------------------------------------------------

export interface TransactionOptions {
  /**
   * Whether to rewrite the block states that depend on neighbours -- a fence's
   * arms, a wall's post, a staircase's corner. On by default, because being on
   * for every write is the whole design: one place, so place, break, fill,
   * replace, paste, move, transform and every agent tool agree.
   *
   * Turned **off** by exactly one caller, and without it the feature would not
   * exist. The inspector's block-state editor sends its edit as an ordinary
   * `setBlock`, so a hand-typed `north=false` would be re-derived and
   * overwritten inside the very same transaction that carried it. A state
   * somebody typed is authoritative until something is placed next to it, which
   * is what the game does and what "editable afterwards" has to mean.
   */
  readonly derive?: boolean;

  /**
   * A command that has to land *after* the connection pass, not before it.
   *
   * There is exactly one, and it is a resize that follows an edit rather than
   * preceding one. A growth resizes first, so it costs nothing; a shrink can
   * only be measured once the block is gone, and `tx.resize` calls `flush()` --
   * which empties the live set `deriveConnections` reads. Put in the body it
   * would therefore not reorder the pass, it would silently *delete* it: the
   * fence beside the one you broke would keep an arm pointing at nothing, with
   * every check still green.
   *
   * Deriving before the shrink is also the right answer rather than merely a
   * possible one -- outside the schematic reads as air (`connect.ts`), and the
   * slabs about to come off are empty, so the two agree cell for cell.
   */
  readonly after?: (tx: TransactionScope) => void;
}

/**
 * Runs `body` as one undoable step.
 *
 * If `body` throws, everything it had already applied is rolled back and the
 * error propagates: a failed agent request leaves the document exactly as it
 * was, rather than half-edited. A body that changes nothing records nothing --
 * no empty entry appears on the stack for the user to undo.
 */
export function runTransaction<T>(
  doc: SchematicDocument,
  history: History,
  label: string,
  body: (tx: TransactionScope) => T,
  options: TransactionOptions = {},
): T {
  const recorder = new Recorder(doc);
  let result: T;
  try {
    result = body(recorder);
    // Inside the try, so a rule that throws rolls the whole edit back rather
    // than leaving the document half-connected with no entry describing it.
    if (options.derive !== false) {
      deriveConnections(doc, recorder, [...recorder.touchedIndices()]);
    }
    // Also inside the try, for the reason above it: whatever this applies is
    // part of the same step and has to come back with it.
    options.after?.(recorder);
  } catch (err) {
    recorder.flush();
    for (let i = recorder.commands.length - 1; i >= 0; i -= 1) {
      revertCommand(doc, recorder.commands[i]);
    }
    throw err;
  }

  recorder.flush();
  if (recorder.commands.length === 0) {
    return result;
  }

  pushTransaction(history, { id: history.nextId, label, commands: recorder.commands });
  return result;
}

/**
 * `runTransaction` for a body that awaits.
 *
 * The agent needs this and the synchronous version cannot serve it: it calls
 * `body(recorder)` and catches what that call throws, which for an async body
 * is nothing at all -- the function returns a promise, the rejection happens
 * later, and the rollback never runs. A half-applied edit would be left on the
 * document with no undo entry describing it.
 *
 * One agent request spans one of these, however many tool calls it makes, so
 * the whole request is one CTRL+Z.
 */
export async function runTransactionAsync<T>(
  doc: SchematicDocument,
  history: History,
  label: string,
  body: (tx: TransactionScope) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const recorder = new Recorder(doc);
  let result: T;
  try {
    result = await body(recorder);
    if (options.derive !== false) {
      deriveConnections(doc, recorder, [...recorder.touchedIndices()]);
    }
    // Both runners honour it, whether or not anything asks today. An option
    // one of them quietly ignores is worse than one neither has.
    options.after?.(recorder);
  } catch (err) {
    recorder.flush();
    for (let i = recorder.commands.length - 1; i >= 0; i -= 1) {
      revertCommand(doc, recorder.commands[i]);
    }
    throw err;
  }

  recorder.flush();
  if (recorder.commands.length === 0) {
    return result;
  }
  pushTransaction(history, { id: history.nextId, label, commands: recorder.commands });
  return result;
}

/** Shared by both transaction runners: push, clear redo, honour the limit. */
function pushTransaction(history: History, transaction: Transaction): void {
  history.undoStack.push(transaction);
  // Bumped whatever happens to the stack below. Ids are never reused, so an id
  // held by something outside this module can only ever be stale, never wrong.
  history.nextId = transaction.id + 1;
  // A new edit makes the redo branch unreachable, as everywhere else.
  history.redoStack.length = 0;

  if (history.limit > 0 && history.undoStack.length > history.limit) {
    const dropped = history.undoStack.length - history.limit;
    history.undoStack.splice(0, dropped);
    // The saved point may have just been discarded. Once that happens the
    // document can no longer be shown as clean, so the depth is clamped to
    // somewhere it can never be reached again rather than silently sliding onto
    // a different transaction and calling a modified document saved.
    history.savedDepth = history.savedDepth >= dropped ? history.savedDepth - dropped : -1;
  }
}

/** One block type, and how many voxels of it a transaction took or laid down. */
export interface BlockTally {
  block: string;
  count: number;
}

/**
 * What a transaction did, counted by block type.
 *
 * "1,247 blocks changed" does not tell anyone whether their oak farmhouse is
 * still there. This does: it is the difference between a number and a receipt.
 *
 * It reads the deltas the undo stack already recorded, so it is exact rather
 * than a re-derivation that could disagree with what undo would put back —
 * there is only one record of the change and this is it.
 *
 * Palette indices are resolved against the document's *current* palette, which
 * is sound only because that palette is append-only: an index recorded earlier
 * still names the same block. `compactPalette` would break this, along with the
 * undo stack itself, which is why it is confined to the cases that discard both.
 */
export function summarizeTransaction(
  doc: SchematicDocument,
  transaction: Transaction,
): { removed: BlockTally[]; added: BlockTally[]; changed: number } {
  const removed = new Map<string, number>();
  const added = new Map<string, number>();
  let changed = 0;

  const name = (index: number): string | null => {
    // Air is index 0 by construction and is not a material: reporting it would
    // bury "-412 oak_planks" under "+412 air", which says the same thing twice
    // and reads as though something was gained.
    if (index <= 0) return null;
    const entry = doc.palette[index];
    return entry ? paletteEntryCacheKey(entry) : null;
  };

  const tally = (into: Map<string, number>, index: number): void => {
    const key = name(index);
    if (key !== null) {
      into.set(key, (into.get(key) ?? 0) + 1);
    }
  };

  const walk = (deltas: readonly BlockDelta[]): void => {
    for (const delta of deltas) {
      if (delta.before === delta.after) continue;
      changed += 1;
      tally(removed, delta.before);
      tally(added, delta.after);
    }
  };

  for (const command of transaction.commands) {
    if (command.kind === "blocks") {
      walk(command.blocks);
    } else if (command.kind === "resize") {
      // A shrink destroys everything outside the new box. Those voxels are the
      // most destructive thing an edit can do and appear nowhere else.
      walk(command.dropped);
    }
    // A header command moves no voxels, so it contributes nothing to a tally
    // counted by block type. It is still a transaction on the stack.
  }

  const ranked = (counts: Map<string, number>): BlockTally[] =>
    [...counts.entries()]
      .map(([block, count]) => ({ block, count }))
      .sort((a, b) => b.count - a.count || (a.block < b.block ? -1 : 1));

  return { removed: ranked(removed), added: ranked(added), changed };
}

export function undo(doc: SchematicDocument, history: History): Transaction | null {
  const transaction = history.undoStack.pop();
  if (!transaction) {
    return null;
  }
  for (let i = transaction.commands.length - 1; i >= 0; i -= 1) {
    revertCommand(doc, transaction.commands[i]);
  }
  history.redoStack.push(transaction);
  return transaction;
}

export function redo(doc: SchematicDocument, history: History): Transaction | null {
  const transaction = history.redoStack.pop();
  if (!transaction) {
    return null;
  }
  for (const command of transaction.commands) {
    applyCommand(doc, command);
  }
  history.undoStack.push(transaction);
  return transaction;
}
