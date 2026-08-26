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
const READ_ONLY = new Set(["get_schematic_info", "get_palette", "get_region"]);

/**
 * The tools a careful client should confirm before running.
 *
 * `destructiveHint` is advisory — a client is free to ignore it — but the ones
 * that overwrite blocks in bulk are exactly where a confirmation is worth the
 * interruption. `set_block` is left off: one block is one Ctrl+Z.
 */
const DESTRUCTIVE = new Set(["fill_region", "replace_blocks", "resize_document"]);

export function describeTools(): McpToolDescriptor[] {
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.schema,
    annotations: {
      readOnlyHint: READ_ONLY.has(spec.name),
      destructiveHint: DESTRUCTIVE.has(spec.name),
    },
  }));
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

export interface CallOutcome {
  /** What the tool returned, as MCP's structured content. */
  result: unknown;
  /** The tool's own phrasing of what it did, for the activity log. */
  summary: string;
}

/**
 * Runs one tool against the open session.
 *
 * `label` is what the undo stack shows, so it names the client rather than the
 * tool alone: "Claude Code: fill_region" is something a user can recognise a
 * week later, and "fill_region" is not.
 */
export interface CallOptions {
  client: string;
  selection: Region | null;
  allowedBlocks: ReadonlySet<string>;
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

export async function callTool(
  session: DocumentSession,
  name: string,
  args: unknown,
  options: CallOptions,
): Promise<CallOutcome> {
  const spec = findTool(name);
  if (spec === null) {
    throw new Error(`No such tool: ${name}`);
  }

  let summary = name;
  const context: ToolContext = {
    doc: session.doc,
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
