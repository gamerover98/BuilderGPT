/**
 * The schematic tools, as MCP sees them.
 *
 * `agent/tools.ts` holds the definitions; this file is the adapter and the
 * safety rail around them. Nothing here re-describes what `fill_region` does —
 * two places deciding that is how you get a tool that works in the chat and not
 * over MCP.
 *
 * ## One tool call is one transaction
 *
 * The in-app agent wraps a whole *turn* in one transaction, because a turn is
 * one thing the user asked for. MCP has no turns: a call arrives from a model
 * this process knows nothing about, and there is no signal that says the next
 * one belongs with it. So each call is its own transaction, which is also what
 * a hand edit is — a fill from the selection tools is one undo step too, and
 * `run_build_script` exists precisely so a large build is one call rather than
 * four hundred.
 *
 * What that buys, for free and at every call: rollback when a tool throws, the
 * neighbour-connection pass in `domain/connect.ts`, and one Ctrl+Z per thing
 * the model did.
 *
 * ## Calls are serialised
 *
 * `runTransactionAsync` awaits, so two overlapping mutations would interleave
 * inside one document — one recorder's rollback undoing the other's writes.
 * Main is single-threaded but that is no protection here, because the await is
 * exactly where another request gets in. Every mutating call therefore queues
 * behind the last one. Read-only calls do not queue: they take no recorder, and
 * making them wait would mean a `get_region` blocking behind a build script.
 */

import {
  TOOL_SPECS,
  type ToolContext,
  type ToolSpec,
} from "../agent/tools.js";
import { findLifecycle, LIFECYCLE_SPECS, McpRefusal, type Lifecycle } from "./lifecycle.js";
import { DOCUMENT_SPECS, findDocumentTool } from "./document_tools.js";
import { runTransactionAsync } from "../domain/history.js";
import { type Region } from "../domain/document.js";
import { type DocumentSession } from "../services/session.js";

/** What MCP puts on the wire for one tool. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
  };
}

/**
 * The tools that only read.
 *
 * Named rather than derived, because "does this write" is not something a
 * schema can be asked. Getting it wrong in the safe direction costs a queued
 * read; getting it wrong the other way costs interleaved transactions, so the
 * list is the ones that are *certainly* read-only and everything else is
 * treated as a write.
 */
const READ_ONLY = new Set([
  "get_schematic_info",
  "get_palette",
  "get_region",
  // Not about the open document at all -- it answers a question about
  // Minecraft. It still belongs here rather than in a table of its own,
  // because "does this write" is the only question this set asks.
  "describe_block",
]);

/**
 * The tools that answer without a schematic open.
 *
 * A different question from `READ_ONLY`, and the two are not the same set:
 * `describe_block` is both, and `convert_schematic` is neither — it writes a
 * file, so it is not read-only, and it reads no document, so refusing it
 * because none is open would be refusing it for a reason that has nothing to do
 * with it.
 *
 * Without this, `describe_block` was refused with "No schematic is open" for a
 * question about Minecraft. Nobody reported it, because a client that has
 * connected to this app usually has one open — which is exactly the kind of
 * wrongness that survives.
 */
const NO_DOCUMENT = new Set(["describe_block", "convert_schematic"]);

/**
 * The tools a careful client should confirm before running.
 *
 * `destructiveHint` is advisory — a client is free to ignore it — but the ones
 * that overwrite blocks in bulk are exactly where a confirmation is worth the
 * interruption. `set_block` is left off: one block is one Ctrl+Z.
 */
const DESTRUCTIVE = new Set(["fill_region", "replace_blocks", "resize_document"]);

/**
 * Every tool, block-editing and file-level together.
 *
 * Two tables rather than one because they answer to different things: the ten
 * come from `agent/tools.ts` and are shared with the in-app agent, while the
 * lifecycle verbs are MCP's alone -- the agent has no business opening a
 * different schematic while somebody is typing to it. A client sees one list,
 * which is right: from the outside they are all just tools.
 */
export function describeTools(): McpToolDescriptor[] {
  return [
    ...TOOL_SPECS.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.schema,
      annotations: {
        readOnlyHint: READ_ONLY.has(spec.name),
        destructiveHint: DESTRUCTIVE.has(spec.name),
      },
    })),
    ...LIFECYCLE_SPECS.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.schema,
      annotations: { readOnlyHint: spec.readOnly, destructiveHint: spec.destructive },
    })),
    ...DOCUMENT_SPECS.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.schema,
      annotations: { readOnlyHint: spec.readOnly, destructiveHint: spec.destructive },
    })),
  ];
}

export function findTool(name: string): ToolSpec | null {
  return TOOL_SPECS.find((spec) => spec.name === name) ?? null;
}

export function isReadOnly(name: string): boolean {
  return READ_ONLY.has(name);
}

/**
 * The queue of one.
 *
 * A promise chain rather than a lock with a flag, because a flag needs a
 * waiting list and this is the waiting list. Errors are swallowed on the tail
 * so one failed call does not poison every call after it — the failure is
 * still delivered to its own caller.
 */
let tail: Promise<unknown> = Promise.resolve();

/**
 * Exported to be tested, and it has to be tested directly.
 *
 * Driving it through two `fill_region` calls proves nothing: that tool's body
 * has no real `await` in it, so the first runs to completion before the second
 * starts whether or not this queue exists — a check written that way passes
 * with the queue deleted, which is worse than no check. What the rule actually
 * says is "a second body does not begin until the first has finished", and that
 * is a statement about this function.
 */
export function serialised<T>(body: () => Promise<T>): Promise<T> {
  const next = tail.then(body, body);
  // Errors are swallowed on the *tail* only, so one failed call does not poison
  // every call behind it. The failure still reaches its own caller through
  // `next`, which is what is returned.
  tail = next.catch(() => undefined);
  return next;
}

/**
 * The scope a read-only call is handed.
 *
 * Every method throws by name, rather than the alternative — passing `null` and
 * letting the first write be a `TypeError` about reading a property of null,
 * from inside a tool, with nothing in the message saying which tool or why.
 *
 * It is also the tripwire for `READ_ONLY` itself: mark a tool that writes as
 * read-only and the very first call says so, in a sentence that names the
 * mistake, instead of quietly editing the document outside the queue and
 * outside the undo stack.
 */
function refusingScope(name: string): ToolContext["tx"] {
  const no = (): never => {
    throw new Error(
      `${name} is listed as read-only in mcp/tools.ts but tried to edit the document. ` +
        `Take it out of READ_ONLY: writing outside a transaction leaves nothing on the undo stack.`,
    );
  };
  return {
    setBlock: no,
    setBlockEntity: no,
    fill: no,
    replace: no,
    resize: no,
    setHeader: no,
    get changed(): number {
      return 0;
    },
  };
}

/**
 * The document a tool listed in `NO_DOCUMENT` is handed when there is none.
 *
 * `refusingScope`'s idiom, for its reason: every access throws by name, rather
 * than passing `null` and letting the first read be a `TypeError` about a
 * property of null, from inside a tool, with nothing in the message saying
 * which tool or why. It is the tripwire for `NO_DOCUMENT` itself — list a
 * tool that reads the schematic and the very first call says so.
 */
function refusingDocument(name: string): ToolContext["doc"] {
  return new Proxy({} as ToolContext["doc"], {
    get(_target, property) {
      throw new Error(
        `${name} is listed in NO_DOCUMENT in mcp/tools.ts but read doc.${String(property)}. ` +
          `Take it out of that set: it needs a schematic open.`,
      );
    },
  });
}

export interface CallOutcome {
  /** What the tool returned, as MCP's structured content. */
  result: unknown;
  /** The tool's own phrasing of what it did, for the activity log. */
  summary: string;
}

export interface CallOptions {
  client: string;
  selection: Region | null;
  allowedBlocks: ReadonlySet<string>;
  /**
   * The file-level verbs and everything they need to reach.
   *
   * Also how a block-editing tool finds the open document: `lifecycle.session()`
   * is asked at the moment of the call rather than passed in, because a client
   * can call `open_document` and `fill_region` one after the other and the
   * second must land on what the first opened.
   */
  lifecycle: Lifecycle;
  /**
   * Called after a mutation lands, so the window can be told.
   *
   * Injected rather than imported, because `services/broadcast.ts` reaches
   * Electron through `menu.ts` and importing it here would put this whole
   * module out of the suites' reach — the same split `discard_prompt.ts` and
   * `settings_coerce.ts` were made for. Required rather than optional: a caller
   * that forgot it would leave the viewport drawing a build that had changed,
   * which is the one failure this whole channel exists to prevent, so the
   * compiler asks for it.
   */
  onChanged: (session: DocumentSession) => void;
}

/**
 * Runs one tool, whichever table it came from.
 *
 * The two are dispatched here rather than in the server so that both go through
 * the same queue: a `save_document` landing halfway through a `run_build_script`
 * would write a file that is neither the before nor the after.
 *
 * The transaction label names the client rather than the tool alone. "Claude
 * Code: fill_region" is something a user can recognise in the undo list a week
 * later; "fill_region" is not.
 */
export async function callTool(
  name: string,
  args: unknown,
  options: CallOptions,
): Promise<CallOutcome> {
  const lifecycle = findLifecycle(name);
  if (lifecycle !== null) {
    const run = async (): Promise<CallOutcome> => ({
      result: await lifecycle.run(options.lifecycle, args ?? {}),
      summary: name,
    });
    return lifecycle.readOnly ? await run() : await serialised(run);
  }

  const spec = findTool(name);
  const owned = findDocumentTool(name);
  if (spec === null && owned === null) {
    throw new Error(`No such tool: ${name}`);
  }

  const session = options.lifecycle.session();
  if (session === null && !NO_DOCUMENT.has(name)) {
    /*
     * A refusal rather than a transport error, so the model reads it and can
     * say something useful. It names the way forward, because a client that has
     * just connected has no way to know whether a window is even open.
     */
    throw new McpRefusal(
      "No schematic is open. Use open_document or create_document first, or ask the user " +
        "to open one.",
    );
  }

  /*
   * The verbs that already run their own transaction.
   *
   * `pasteSelection` and its neighbours call `runTransaction` themselves and
   * take no `tx`, so there is nothing to wrap them in. Queued like every other
   * mutation, and otherwise left alone — see the note at the top of
   * `document_tools.ts` for why wrapping them anyway would be misleading rather
   * than broken.
   */
  if (owned !== null) {
    /*
     * `NO_DOCUMENT` holds only `TOOL_SPECS` names, so a document tool always
     * has a session by here. Said out loud rather than narrowed away: listing
     * one of these there would otherwise surface as a `TypeError` from inside
     * `paste_clipboard`, naming neither the tool nor the mistake.
     */
    if (session === null) {
      throw new Error(
        `${name} is a document tool and cannot be listed in NO_DOCUMENT: it needs one open.`,
      );
    }
    const run = async (): Promise<CallOutcome> => {
      const result = await owned.run(session, args ?? {});
      if (owned.changesDocument) options.onChanged(session);
      return { result, summary: name };
    };
    // `changesDocument`, not `readOnly`: `copy_region` is not read-only -- it
    // writes the clipboard the user's own paste reads -- but the schematic did
    // not move, so there is nothing for the viewport to redraw and nothing to
    // queue behind.
    return owned.changesDocument ? await serialised(run) : await run();
  }
  if (spec === null) {
    throw new Error(`No such tool: ${name}`);
  }

  let summary = name;
  const context: ToolContext = {
    doc: session === null ? refusingDocument(name) : session.doc,
    // Replaced by the real recorder inside the transaction below. A read-only
    // tool keeps this one, which is what lets those skip the transaction — and
    // says so loudly if the classification was wrong.
    tx: refusingScope(name),
    selection: options.selection,
    allowedBlocks: options.allowedBlocks,
    onStep: (step) => {
      summary = step.summary;
    },
  };

  if (isReadOnly(name)) {
    const result = await spec.run(context, args, `mcp-${name}`);
    return { result, summary };
  }

  /*
   * Queued, because it writes files, but with no transaction: there is nothing
   * to record and there may be no document to record it against. `session`
   * being null past this point is exactly the `NO_DOCUMENT` case, and the
   * branch below would otherwise dereference it.
   */
  if (session === null) {
    return await serialised(async () => {
      const result = await spec.run(context, args, `mcp-${name}`);
      return { result, summary };
    });
  }

  return await serialised(async () => {
    const result = await runTransactionAsync(
      session.doc,
      session.history,
      `${options.client}: ${name}`,
      async (tx) => await spec.run({ ...context, tx }, args, `mcp-${name}`),
    );
    // The window is showing this document and did not ask for the change, so
    // it has to be told. Inside the queue, so the state pushed is the state
    // after this call rather than after whichever one finished last.
    options.onChanged(session);
    return { result, summary };
  });
}
