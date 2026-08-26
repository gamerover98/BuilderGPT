/**
 * The verbs that need an effect this process has to inject.
 *
 * Mostly the ones about the *file* rather than the blocks in it — open, create,
 * save, close, delete — plus the one that photographs the window, which needs
 * the same treatment for the same reason: it reaches Electron, and the rule it
 * has to obey is worth testing without it.
 *
 * Deliberately not in `agent/tools.ts`, and that asymmetry is the design. The
 * in-app agent edits the schematic the user opened; it has no business opening
 * a different one, and a model that could would be able to close the document
 * out from under the person typing to it. An MCP client is in the opposite
 * position — it has no window and no hands, so if it cannot open a file it
 * cannot start.
 *
 * ## Everything is injected
 *
 * These reach the session, the recents list, the conversation store and the OS
 * trash, and half of those import Electron. So the effects arrive as a
 * `Lifecycle` object: the server passes the real ones, `tests/mcp.ts` passes
 * fakes and can then check what a refusal actually refused rather than only
 * what it said. The same split `discard_prompt.ts` was made for, one level up.
 *
 * ## Where the guards are
 *
 * In `policy.ts`, and asked *before* the effect rather than inside it —
 * `openDocument` reassigns the session without looking at what was there, so by
 * the time it has the request the work is already gone. Exactly the reasoning
 * behind the discard dialog living in front of the call rather than inside
 * `session.ts`.
 */

import path from "path";

import { type SchematicFormat } from "../../shared/schematic.js";
import { mayDelete, mayReplaceDocument, withinRoot, type Verdict } from "./policy.js";
import { type DocumentSession } from "../services/session.js";

/** Everything these tools need that they must not import for themselves. */
export interface Lifecycle {
  /** The open document, or `null`. */
  session(): DocumentSession | null;
  /** Whether it differs from disk. */
  isDirty(session: DocumentSession): boolean;
  open(filePath: string): Promise<DocumentSession>;
  create(
    size: { width: number; height: number; length: number },
    format: SchematicFormat,
    version: string | null,
  ): Promise<DocumentSession>;
  save(
    session: DocumentSession,
    options: { filePath: string | null; format?: SchematicFormat },
  ): Promise<{
    filePath: string;
    format: SchematicFormat;
    degraded: readonly string[];
    /**
     * The box the file was trimmed to, or `null` if nothing was trimmed.
     *
     * Reported rather than flattened to a boolean: saving crops to content,
     * so a model that placed a block at y=40 in a 64-tall document and then
     * saved needs to know the coordinates in the *file* are not the ones it
     * was working in.
     */
    cropped: { from: [number, number, number]; to: [number, number, number] } | null;
  }>;
  close(): void;
  recents(): Promise<readonly { filePath: string; openedAt: number }[]>;
  /** Moves a file to the OS trash. Never `unlink` — see `mayDelete`. */
  trash(filePath: string): Promise<void>;
  /** The directory the server may touch, already resolved. */
  root(): Promise<string>;
  /**
   * Whether deletion is switched on.
   *
   * Asked at the moment of the call rather than captured when the server
   * started: a user who turns the flag off has turned it off, and a value read
   * once would keep saying yes for the rest of the session.
   */
  allowDelete(): Promise<boolean>;
  /** Refuses a format the chosen game version cannot hold. `null` if it can. */
  refusalFor(format: SchematicFormat, version: string | null): string | null;
  /** Called after anything that changes what is open. */
  announce(session: DocumentSession | null): void;
  /**
   * A picture of the 3D viewport, as PNG bytes already base64-encoded.
   *
   * `null` when there is no window to photograph — the process outlives its
   * window on macOS, and a client asking then should be told so rather than
   * handed a blank image.
   */
  capture(): Promise<{ data: string; width: number; height: number } | null>;
}

export interface LifecycleSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: Record<string, unknown>;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  run(host: Lifecycle, args: unknown): Promise<unknown>;
}

/** Thrown for a refusal, so the server reports it as a tool error like any other. */
export class McpRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRefusal";
  }
}

function must<T>(verdict: Verdict<T>): T {
  if (!verdict.ok) throw new McpRefusal(verdict.refused);
  return verdict.value;
}

function describe(session: DocumentSession | null, dirty: boolean): unknown {
  if (session === null) {
    return {
      open: false,
      note: "No schematic is open. Use open_document or create_document first.",
    };
  }
  const { doc } = session;
  return {
    open: true,
    filePath: doc.filePath,
    fileName: doc.filePath === null ? null : path.basename(doc.filePath),
    width: doc.width,
    height: doc.height,
    length: doc.length,
    format: doc.format,
    dataVersion: doc.dataVersion,
    unsavedChanges: dirty,
  };
}

const DISCARD = {
  discardUnsavedChanges: {
    type: "boolean",
    description:
      "Only after the user has said to throw away their unsaved changes. Never assume it.",
  },
} as const;

/**
 * The one tool that answers with a picture.
 *
 * This is the capability no harness can get any other way: a model editing a
 * schematic through coordinates is working blind, and one look at what it built
 * catches the whole class of mistakes that are obvious to a person and
 * invisible in a block list — a roof one block short, a wall inside out, a
 * staircase facing the wall.
 *
 * It photographs the window as it *is*, including the camera angle the user
 * left it at. Aiming the camera would need main to make a request *of* the
 * renderer and wait for it, and main can only send — a correlation id and a
 * reply channel is real work and is deliberately not in this change. So the
 * description says what the picture is of, rather than letting a model assume
 * it chose the angle.
 */
const CAPTURE: LifecycleSpec = {
  name: "capture_viewport",
  description:
    "A picture of the 3D viewport as the user is currently looking at it — their camera angle, their lighting, their theme. Use it to check what you have built actually looks right; a block list cannot show you a wall facing the wrong way. You cannot aim the camera, so ask the user to move it if you need another angle.",
  schema: { type: "object", properties: {}, additionalProperties: false },
  readOnly: true,
  destructive: false,
  async run(host) {
    const shot = await host.capture();
    if (shot === null) {
      throw new McpRefusal(
        "There is no window open to photograph. Ask the user to bring Schematic AI Studio " +
          "to the front and try again.",
      );
    }
    return shot;
  },
};

export const LIFECYCLE_SPECS: readonly LifecycleSpec[] = [
  {
    name: "get_document",
    description:
      "Which schematic is open, its size and format, and whether it has unsaved changes. Answers even when nothing is open, which is how you find out.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    destructive: false,
    async run(host) {
      const session = host.session();
      return describe(session, session !== null && host.isDirty(session));
    },
  },

  {
    name: "list_recent_documents",
    description: "Schematics the user has opened recently, most recent first.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    destructive: false,
    async run(host) {
      return { documents: await host.recents() };
    },
  },

  {
    name: "open_document",
    description:
      "Open a schematic file, replacing whatever is open. Refuses if the open document has unsaved changes, unless the user has said to discard them.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to a .schem or .schematic file." },
        ...DISCARD,
      },
      required: ["path"],
      additionalProperties: false,
    },
    readOnly: false,
    destructive: false,
    async run(host, args) {
      const { path: filePath, discardUnsavedChanges } = args as {
        path: string;
        discardUnsavedChanges?: boolean;
      };
      const target = must(withinRoot(await host.root(), filePath));
      const current = host.session();
      must(
        mayReplaceDocument(
          current !== null && host.isDirty(current),
          current?.doc.filePath === undefined || current.doc.filePath === null
            ? null
            : path.basename(current.doc.filePath),
          discardUnsavedChanges === true,
        ),
      );
      const session = await host.open(target);
      host.announce(session);
      return describe(session, false);
    },
  },

  {
    name: "create_document",
    description:
      "Start a new, empty schematic, replacing whatever is open. It exists in memory only until save_document_as gives it a path.",
    schema: {
      type: "object",
      properties: {
        width: { type: "integer" },
        height: { type: "integer" },
        length: { type: "integer" },
        format: {
          type: "string",
          enum: ["sponge3", "sponge2", "mcedit"],
          description: "Container format. Defaults to sponge3.",
        },
        version: {
          type: "string",
          description:
            'Game version name, e.g. "JE_1_20_4". Anything up to 1.12.2 can only be mcedit.',
        },
        ...DISCARD,
      },
      required: ["width", "height", "length"],
      additionalProperties: false,
    },
    readOnly: false,
    destructive: false,
    async run(host, args) {
      const a = args as {
        width: number;
        height: number;
        length: number;
        format?: SchematicFormat;
        version?: string;
        discardUnsavedChanges?: boolean;
      };
      const format = a.format ?? "sponge3";
      const version = a.version ?? null;
      const refusal = host.refusalFor(format, version);
      if (refusal !== null) throw new McpRefusal(refusal);

      const current = host.session();
      must(
        mayReplaceDocument(
          current !== null && host.isDirty(current),
          current?.doc.filePath === undefined || current.doc.filePath === null
            ? null
            : path.basename(current.doc.filePath),
          a.discardUnsavedChanges === true,
        ),
      );
      const session = await host.create(
        { width: a.width, height: a.height, length: a.length },
        format,
        version,
      );
      host.announce(session);
      return describe(session, true);
    },
  },

  {
    name: "save_document",
    description:
      "Write the open schematic back to the file it came from. Fails if it has never been saved — use save_document_as for that.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: false,
    destructive: false,
    async run(host) {
      const session = host.session();
      if (session === null) throw new McpRefusal("No schematic is open.");
      if (session.doc.filePath === null) {
        throw new McpRefusal(
          "This schematic has never been saved, so there is nowhere to write it. " +
            "Use save_document_as with a path.",
        );
      }
      const result = await host.save(session, { filePath: null });
      host.announce(session);
      return {
        filePath: result.filePath,
        format: result.format,
        cropped: result.cropped,
        degraded: result.degraded,
        note:
          result.degraded.length > 0
            ? "Some blocks could not be written exactly in this format and were simplified."
            : undefined,
      };
    },
  },

  {
    name: "save_document_as",
    description:
      "Write the open schematic to a path, and keep editing it there. An existing file at that path is moved aside with a timestamp rather than overwritten.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        format: { type: "string", enum: ["sponge3", "sponge2", "mcedit"] },
      },
      required: ["path"],
      additionalProperties: false,
    },
    readOnly: false,
    destructive: false,
    async run(host, args) {
      const a = args as { path: string; format?: SchematicFormat };
      const session = host.session();
      if (session === null) throw new McpRefusal("No schematic is open.");
      const target = must(withinRoot(await host.root(), a.path));
      const result = await host.save(session, { filePath: target, format: a.format });
      host.announce(session);
      return {
        filePath: result.filePath,
        format: result.format,
        cropped: result.cropped,
        degraded: result.degraded,
      };
    },
  },

  {
    name: "close_document",
    description:
      "Close the open schematic. Refuses if it has unsaved changes, unless the user has said to discard them.",
    schema: { type: "object", properties: { ...DISCARD }, additionalProperties: false },
    readOnly: false,
    destructive: false,
    async run(host, args) {
      const { discardUnsavedChanges } = args as { discardUnsavedChanges?: boolean };
      const session = host.session();
      if (session === null) return { open: false, note: "Nothing was open." };
      must(
        mayReplaceDocument(
          host.isDirty(session),
          session.doc.filePath === null ? null : path.basename(session.doc.filePath),
          discardUnsavedChanges === true,
        ),
      );
      host.close();
      host.announce(null);
      return { open: false };
    },
  },

  {
    name: "delete_document",
    description:
      "Move a schematic file to the system trash. Switched off by default; the user turns it on in Settings. Never deletes the schematic that is currently open, and never erases — the file goes to the recycle bin.",
    schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    readOnly: false,
    destructive: true,
    async run(host, args) {
      const { path: filePath } = args as { path: string };
      const session = host.session();
      /*
       * The three questions live in `policy.ts` and the flag is read from
       * settings by the server, not from here: this module has no business
       * knowing where a preference is stored, and the suite can then drive all
       * three answers without one.
       */
      const target = must(
        mayDelete(
          {
            allowDelete: await host.allowDelete(),
            root: await host.root(),
            openFilePath: session?.doc.filePath ?? null,
          },
          filePath,
        ),
      );
      await host.trash(target);
      return {
        deleted: target,
        note: "Moved to the system trash, so the user can restore it from there.",
      };
    },
  },
  CAPTURE,
];

export function findLifecycle(name: string): LifecycleSpec | null {
  return LIFECYCLE_SPECS.find((spec) => spec.name === name) ?? null;
}
