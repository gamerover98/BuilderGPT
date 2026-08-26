/**
 * The verbs that already knew how to be one edit.
 *
 * Copy, cut, paste, move, undo, redo, the block-entity editor, the schematic's
 * own NBT, the WorldEdit anchor and the version history. Every one of these
 * exists in `services/session.ts` or `services/schematic_nbt.ts` because the
 * window needed it first; this file is exposure, not new logic.
 *
 * ## Why these are a third table
 *
 * There are three relationships a tool can have with a transaction, and mixing
 * them is how you get an edit that cannot be undone or one that is undone in
 * two steps:
 *
 * | | |
 * |---|---|
 * | `agent/tools.ts` | needs one **wrapped around it** — `callTool` provides it |
 * | `mcp/lifecycle.ts` | needs **none** — it replaces the document rather than editing it |
 * | here | **owns its own**, because `pasteSelection` and friends already call `runTransaction` |
 *
 * The first reason is mechanical: these take a `DocumentSession` and have no
 * `tx` parameter to be handed one, so they do not fit `ToolSpec` at all.
 *
 * The second is worth stating precisely, because it is *not* the dramatic one
 * it looks like. Wrapping them anyway is harmless -- an outer transaction they
 * never write through records nothing, and `runTransactionAsync` pushes nothing
 * when its recorder is empty, so the undo stack still grows by exactly one with
 * the inner label. That was verified by doing it: the suite stays green. What
 * it *would* be is code that reads as though it provided atomicity while
 * providing none -- the outer scope could not roll back an inner transaction
 * that has already committed. So they are queued like every other mutation and
 * otherwise left alone.
 *
 * ## Directly imported, not injected
 *
 * Unlike `lifecycle.ts`, which reaches Electron for the trash and the recents.
 * `session.ts` and `schematic_nbt.ts` import no Electron at all — that is what
 * `tests/session.ts` relies on — so there is nothing to inject and a fake would
 * only be a way for this file to disagree with the app.
 */

import { type Region } from "../domain/document.js";
import {
  copySelection,
  cutSelection,
  currentClipboard,
  editBlockEntityValue,
  inspect,
  moveRegion,
  pasteSelection,
  redoEdit,
  undoEdit,
  type DocumentSession,
} from "../services/session.js";
import { applyNbt, schematicNbtText, setWorldEditAnchor, setWorldOrigin } from "../services/schematic_nbt.js";
import { McpRefusal } from "./lifecycle.js";

export interface DocumentSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: Record<string, unknown>;
  /**
   * The MCP annotation: a promise to the client that this changes *nothing*.
   *
   * Not the same question as `changesDocument`, and conflating them would make
   * one of the two a lie. `copy_region` writes the app's clipboard -- the same
   * one the user's own paste reads -- so it is not read-only, while the
   * document is untouched and the viewport has nothing to redraw.
   */
  readonly readOnly: boolean;
  readonly destructive: boolean;
  /** Whether the schematic itself moved: queued, and the window is told. */
  readonly changesDocument: boolean;
  run(session: DocumentSession, args: unknown): Promise<unknown>;
}

const REGION = {
  minX: { type: "integer" },
  minY: { type: "integer" },
  minZ: { type: "integer" },
  maxX: { type: "integer" },
  maxY: { type: "integer" },
  maxZ: { type: "integer" },
} as const;

const REGION_KEYS = ["minX", "minY", "minZ", "maxX", "maxY", "maxZ"] as const;

function region(args: unknown): Region {
  const a = (args ?? {}) as Record<string, unknown>;
  for (const key of REGION_KEYS) {
    if (typeof a[key] !== "number") {
      throw new McpRefusal(`${key} is required and must be a number.`);
    }
  }
  return {
    minX: a.minX as number,
    minY: a.minY as number,
    minZ: a.minZ as number,
    maxX: a.maxX as number,
    maxY: a.maxY as number,
    maxZ: a.maxZ as number,
  };
}

/** `[x, y, z]` from three fields, or `null` where that is a legal answer. */
function vector(args: unknown, keys: readonly [string, string, string]): [number, number, number] {
  const a = (args ?? {}) as Record<string, unknown>;
  return keys.map((key) => {
    const value = Number(a[key]);
    if (!Number.isFinite(value)) throw new McpRefusal(`${key} is required and must be a number.`);
    return Math.trunc(value);
  }) as [number, number, number];
}

export const DOCUMENT_SPECS: readonly DocumentSpec[] = [
  {
    name: "undo",
    description:
      "Take back the last change to the schematic, whoever made it — yours, the user's, or the app's own agent. They share one undo stack.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: false,
    destructive: false,
    changesDocument: true,
    async run(session) {
      const label = undoEdit(session);
      return label === null
        ? { undone: null, note: "There was nothing left to undo." }
        : { undone: label };
    },
  },

  {
    name: "redo",
    description: "Put back the last change that was undone.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: false,
    destructive: false,
    changesDocument: true,
    async run(session) {
      const label = redoEdit(session);
      return label === null
        ? { redone: null, note: "There was nothing to redo." }
        : { redone: label };
    },
  },

  {
    name: "copy_region",
    description:
      "Copy a region to the app's clipboard, block states and block entities with it. The user's own paste uses the same clipboard.",
    schema: { type: "object", properties: { ...REGION }, required: [...REGION_KEYS], additionalProperties: false },
    readOnly: false,
    destructive: false,
    changesDocument: false,
    async run(session, args) {
      const clipboard = copySelection(session, region(args));
      return { width: clipboard.width, height: clipboard.height, length: clipboard.length };
    },
  },

  {
    name: "cut_region",
    description: "Copy a region to the clipboard and clear it in one step.",
    schema: { type: "object", properties: { ...REGION }, required: [...REGION_KEYS], additionalProperties: false },
    readOnly: false,
    destructive: true,
    changesDocument: true,
    async run(session, args) {
      const clipboard = cutSelection(session, region(args));
      return { width: clipboard.width, height: clipboard.height, length: clipboard.length };
    },
  },

  {
    name: "paste_clipboard",
    description:
      "Write the clipboard into the schematic with its minimum corner at a coordinate. Copy or cut something first.",
    schema: {
      type: "object",
      properties: { x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" } },
      required: ["x", "y", "z"],
      additionalProperties: false,
    },
    readOnly: false,
    destructive: true,
    changesDocument: true,
    async run(session, args) {
      if (currentClipboard() === null) {
        throw new McpRefusal("The clipboard is empty. Use copy_region or cut_region first.");
      }
      const [x, y, z] = vector(args, ["x", "y", "z"]);
      return { changed: pasteSelection(session, { x, y, z }) };
    },
  },

  {
    name: "move_region",
    description:
      "Pick a region up and put it down elsewhere, as one undoable step. The space it left becomes air.",
    schema: {
      type: "object",
      properties: {
        ...REGION,
        toX: { type: "integer" },
        toY: { type: "integer" },
        toZ: { type: "integer" },
      },
      required: [...REGION_KEYS, "toX", "toY", "toZ"],
      additionalProperties: false,
    },
    readOnly: false,
    destructive: true,
    changesDocument: true,
    async run(session, args) {
      const [x, y, z] = vector(args, ["toX", "toY", "toZ"]);
      return { changed: moveRegion(session, region(args), { x, y, z }) };
    },
  },

  {
    name: "inspect_block",
    description:
      "Everything about one cell: the block, its state, and its block entity if it has one — a chest's contents, a sign's text.",
    schema: {
      type: "object",
      properties: { x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" } },
      required: ["x", "y", "z"],
      additionalProperties: false,
    },
    readOnly: true,
    destructive: false,
    changesDocument: false,
    async run(session, args) {
      const [x, y, z] = vector(args, ["x", "y", "z"]);
      return inspect(session, x, y, z);
    },
  },

  {
    name: "set_block_entity_value",
    description:
      "Write one value inside a block entity's NBT — a sign's line, an item in a chest. Use inspect_block first to see the paths that exist.",
    schema: {
      type: "object",
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        z: { type: "integer" },
        path: {
          type: "string",
          description: 'Dotted path into the NBT, e.g. "front_text.messages.0" or "Items.0.Count".',
        },
        value: { type: "string", description: "The new value, as text. Numbers are parsed." },
      },
      required: ["x", "y", "z", "path", "value"],
      additionalProperties: false,
    },
    readOnly: false,
    destructive: false,
    changesDocument: true,
    async run(session, args) {
      const a = args as { path: string; value: string };
      const [x, y, z] = vector(args, ["x", "y", "z"]);
      /*
       * A dotted path, split here rather than asked for as an array.
       *
       * A model writes `front_text.messages.0` far more reliably than
       * `["front_text", "messages", 0]`, and the numeric segments have to
       * become numbers or the walk indexes an array with a string. `inspect_block`
       * prints the paths in this same spelling, so the two agree.
       */
      const segments = a.path
        .split(".")
        .filter((part) => part !== "")
        .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
      if (segments.length === 0) {
        throw new McpRefusal("A path into the block entity's NBT is required.");
      }
      return {
        changed: editBlockEntityValue(session, x, y, z, segments, a.value),
      };
    },
  },

  {
    name: "get_schematic_nbt",
    description:
      "The whole schematic's NBT as SNBT text, exactly as the file would contain it in its own format. Carries a revision to hand back to apply_schematic_nbt.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    destructive: false,
    changesDocument: false,
    async run(session) {
      return schematicNbtText(session.doc);
    },
  },

  {
    name: "apply_schematic_nbt",
    description:
      "Write edited SNBT back. Pass the revision get_schematic_nbt returned: if the document has changed since, this is refused rather than overwriting what happened in between.",
    schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        revision: { type: "integer" },
      },
      required: ["text", "revision"],
      additionalProperties: false,
    },
    readOnly: false,
    destructive: true,
    changesDocument: true,
    async run(session, args) {
      const a = args as { text: string; revision: number };
      return {
        changed: applyNbt(session.doc, session.history, a.text, a.revision, "Edit the NBT"),
      };
    },
  },

  {
    name: "set_paste_anchor",
    description:
      "WorldEdit's paste anchor, as a cell of this schematic — where the player was standing when they copied it. Omit the coordinates to remove it.",
    schema: {
      type: "object",
      properties: { x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" } },
      additionalProperties: false,
    },
    readOnly: false,
    destructive: false,
    changesDocument: true,
    async run(session, args) {
      const a = (args ?? {}) as Record<string, unknown>;
      const clearing = a.x === undefined && a.y === undefined && a.z === undefined;
      const anchor = clearing ? null : vector(args, ["x", "y", "z"]);
      setWorldEditAnchor(session.doc, session.history, anchor, "Set the paste anchor");
      return { anchor };
    },
  },

  {
    name: "set_world_origin",
    description:
      "The absolute world position the schematic's (0,0,0) corner came from. Omit the coordinates to remove it — absent and zero are different answers.",
    schema: {
      type: "object",
      properties: { x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" } },
      additionalProperties: false,
    },
    readOnly: false,
    destructive: false,
    changesDocument: true,
    async run(session, args) {
      const a = (args ?? {}) as Record<string, unknown>;
      const clearing = a.x === undefined && a.y === undefined && a.z === undefined;
      const origin = clearing ? null : vector(args, ["x", "y", "z"]);
      setWorldOrigin(session.doc, session.history, origin, "Set the world origin");
      return { worldOrigin: origin };
    },
  },
];

export function findDocumentTool(name: string): DocumentSpec | null {
  return DOCUMENT_SPECS.find((spec) => spec.name === name) ?? null;
}
