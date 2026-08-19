/**
 * The agent loop: one user request, one transaction, however many tool calls.
 *
 * This is the change the plan is really about. Generation used to be a single
 * completion whose text was parsed for a `<code>` block — the model could
 * describe a structure and nothing else, and could not see, measure or modify
 * anything. Here it works against the open document through `agent/tools.ts`,
 * in a loop, and what it does is an ordinary editor transaction.
 *
 * ## One request is one undo
 *
 * The whole run sits inside `runTransactionAsync`, so five hundred blocks
 * across nine tool calls is one CTRL+Z. It also means a run that throws leaves
 * the document exactly as it was, rather than half-edited — the rollback is the
 * transaction's, not something this file has to remember to do.
 *
 * ## Context is resolved, not dumped
 *
 * The schematic never goes to the model. It gets its dimensions, the twenty
 * commonest blocks, and the selection; everything else it has to ask for. A
 * 100x100x100 build is a million cells, and no useful amount of it fits in a
 * prompt — but almost every request only needs a corner of it.
 *
 * ## The conversation is remembered, the schematic is not
 *
 * Prior turns — the user's words, the tool calls, their results — are passed in
 * and replayed, so "now make it taller" knows what "it" is. They are passed
 * rather than read off the session because the conversation outlives it: it is
 * saved per schematic and restored when that file is opened again, which is
 * `services/conversation.ts`'s job, not this file's. What is *not* replayed is
 * the description of the schematic: it is regenerated into
 * the instructions on every turn instead of being prepended to each user
 * message. A transcript of stale descriptions is worse than none, because the
 * model has no way to tell which of five conflicting block counts is current.
 * This way there is exactly one, it is always the live one, and the history
 * holds only what was said.
 */

import { generateText, stepCountIs, type ModelMessage } from "ai";

import { runTransactionAsync, summarizeTransaction, type BlockTally } from "../domain/history.js";
import type { Region } from "../domain/document.js";
import { countBlocks, normalizeRegion, paletteHistogram } from "../domain/document.js";
import { LlmError, resolveModel } from "../services/llm.js";
import type { DocumentSession } from "../services/session.js";
import { buildTools } from "./tools.js";

/** How many tool round trips one request may take before it is cut off. */
const MAX_STEPS = 24;

/**
 * The user stopped the run.
 *
 * Its own type rather than an `LlmError` because nothing failed. Everything
 * downstream keys off that distinction: the document still rolls back, but the
 * UI says "stopped" instead of showing an error, and `classifyGenerateError`
 * never sees it.
 */
export class AgentCancelledError extends Error {
  constructor() {
    super("The request was stopped");
    this.name = "AgentCancelledError";
  }
}

/**
 * How many past exchanges ride along with a request.
 *
 * A cap rather than a token budget: counting tokens needs the provider's own
 * tokenizer, and there are four of them. Twelve is well inside every context
 * window the app can reach while being more conversation than anyone holds in
 * their head.
 */
const MAX_REMEMBERED_TURNS = 12;

export interface AgentStep {
  tool: string;
  summary: string;
}

export interface AgentRequest {
  session: DocumentSession;
  provider: import("../../shared/settings.js").Provider;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** What the user typed. */
  prompt: string;
  /**
   * Prior turns to replay, oldest first.
   *
   * Trimmed here rather than by the caller, because the window is this file's
   * rule (`MAX_REMEMBERED_TURNS`) and the caller storing an already-trimmed
   * transcript would lose turns it is meant to be keeping.
   */
  history: ModelMessage[];
  selection: Region | null;
  allowedBlocks: ReadonlySet<string>;
  onStep?: (step: AgentStep) => void;
  signal?: AbortSignal;
  /**
   * Test seam: a language model to use instead of the one the provider fields
   * would resolve to. Exists so the tool loop can be driven by a scripted model
   * without a network or an API key — the tools and the transaction are what
   * this app owns and what is worth testing.
   */
  modelOverride?: Parameters<typeof generateText>[0]["model"];
}

export interface AgentResult {
  /** The model's closing explanation. */
  text: string;
  /** Voxels changed across the whole request. */
  changed: number;
  steps: AgentStep[];
  /** Exchanges the next request will carry, this one included. */
  remembered: number;
  /**
   * The conversation after this turn, for the caller to store.
   *
   * Returned rather than written through the session: a run that throws never
   * reaches this, which is exactly the property that keeps a rolled-back edit
   * from being described to the next turn as though it had happened.
   */
  messages: ModelMessage[];
  /** What it took out and what it put in, by block type. */
  summary: { removed: BlockTally[]; added: BlockTally[]; changed: number };
  /**
   * The undo entry this run created, or `null` if it changed nothing. The UI
   * offers "Undo this" only while this still matches the top of the stack.
   */
  undoLabel: string | null;
}

const SYSTEM_PROMPT = [
  "You edit Minecraft schematics on behalf of the user, by calling tools.",
  "",
  "Rules:",
  "- Look before you write. get_schematic_info and get_palette are cheap; guessing a block's exact",
  "  spelling is not, because a replace that matches nothing reports zero and changes nothing.",
  "- Block ids are namespaced and carry their block states, e.g. minecraft:oak_stairs[facing=north].",
  "  get_palette shows exactly how each block in this schematic is spelled.",
  "- When the user has a selection, tools default to it. Do not restate its coordinates unless you",
  "  mean somewhere else.",
  "- For anything structural, write one build script rather than hundreds of set_block calls.",
  "- Coordinates start at 0 and y is up. Everything is inclusive of both ends.",
  "- Finish by telling the user what you changed, in one or two sentences. Be specific about",
  "  counts and materials. If a tool reported that nothing matched, say so rather than claiming",
  "  success.",
  "- Earlier turns are what was said, not what is true now. The summary below describes the",
  "  schematic as it stands this instant, and the user may have edited or undone things in",
  "  between; where the two disagree, the summary wins.",
].join("\n");

/** The context that rides along with the request, resolved rather than dumped. */
function describeDocument(session: DocumentSession, selection: Region | null): string {
  const { doc } = session;
  const top = [...paletteHistogram(doc).entries()]
    .filter(([block]) => !block.startsWith("minecraft:air"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([block, count]) => `  ${block} x${count}`)
    .join("\n");

  const lines = [
    `Schematic: ${doc.width}x${doc.height}x${doc.length} (x, y up, z), ${countBlocks(doc)} non-air blocks.`,
    top === "" ? "It is empty." : `Most common blocks:\n${top}`,
  ];
  if (selection) {
    const region = normalizeRegion(doc, selection);
    lines.push(
      `The user has selected (${region.minX},${region.minY},${region.minZ}) to ` +
        `(${region.maxX},${region.maxY},${region.maxZ}). Tools act on this by default.`,
    );
  } else {
    lines.push("The user has selected nothing; tools act on the whole schematic by default.");
  }
  return lines.join("\n");
}

/** A short label for the undo menu, from the user's own words. */
function undoLabel(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length <= 48 ? `AI: ${oneLine}` : `AI: ${oneLine.slice(0, 45)}…`;
}

/**
 * Drops the oldest exchanges, cutting only where a user message starts.
 *
 * The cut point is the whole point. An assistant message carrying a tool call
 * and the tool message carrying its result are one indivisible pair — slice
 * between them and the next request sends a `tool_call_id` that answers
 * nothing, which providers reject outright rather than ignore. Every turn
 * begins at a user message, so cutting there can never split one.
 */
function trimToRecentTurns(messages: readonly ModelMessage[], maxTurns: number): ModelMessage[] {
  const turnStarts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role === "user") {
      turnStarts.push(i);
    }
  }
  if (turnStarts.length <= maxTurns) {
    return [...messages];
  }
  return messages.slice(turnStarts[turnStarts.length - maxTurns]);
}

/** How many exchanges a transcript holds. */
function countTurns(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + (message.role === "user" ? 1 : 0), 0);
}

export async function runAgent(request: AgentRequest): Promise<AgentResult> {
  const steps: AgentStep[] = [];
  const { session } = request;

  const asked: ModelMessage = { role: "user", content: request.prompt };
  const history = trimToRecentTurns(request.history, MAX_REMEMBERED_TURNS - 1);
  const label = undoLabel(request.prompt);

  // Held so the transaction this run commits can be told apart afterwards. By
  // identity, not by depth: the stack has a size limit, so pushing onto a full
  // one leaves the length unchanged and a depth comparison would conclude that
  // nothing was recorded.
  const topBefore = session.history.undoStack[session.history.undoStack.length - 1];

  const result = await runTransactionAsync(
    session.doc,
    session.history,
    label,
    async (tx) => {
      const tools = buildTools({
        doc: session.doc,
        tx,
        selection: request.selection,
        allowedBlocks: request.allowedBlocks,
        onStep: (step) => {
          steps.push(step);
          request.onStep?.(step);
        },
      });

      try {
        return await generateText({
          model: request.modelOverride ?? resolveModel(request),
          // Rebuilt every turn, so the state the model reasons from is the
          // state the document is actually in — see the note at the top.
          instructions: `${SYSTEM_PROMPT}\n\n${describeDocument(session, request.selection)}`,
          messages: [...history, asked],
          tools,
          // Without a stop condition the SDK returns after the first tool call
          // and never feeds the result back, so the model would place one block
          // and stop mid-thought.
          stopWhen: stepCountIs(MAX_STEPS),
          temperature: 0.2,
          abortSignal: request.signal,
        });
      } catch (err) {
        // Asked first, and from the signal rather than from the error: an
        // aborted `generateText` reports itself in more than one shape
        // depending on where in the loop it was, but the signal is unambiguous.
        // Getting this backwards would show the user an LLM failure for
        // something they did on purpose.
        if (request.signal?.aborted) {
          throw new AgentCancelledError();
        }
        // Same contract as `callLlm`: everything leaves as an LlmError, because
        // that prefix is what the UI and `classifyGenerateError` recognise.
        throw new LlmError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Only now, past everything that throws. A run that failed rolled the
  // document back, and a transcript describing edits that were rolled back
  // would have the next turn building on something that never happened.
  //
  // `responseMessages`, not `response.messages`: the latter is deprecated and
  // carries only the *final* step, so a turn that called four tools would be
  // remembered as its closing sentence and nothing else — the model would have
  // no record of what it had already looked up. Replaying the tool traffic is
  // affordable because `tools.ts` caps a result at MAX_REPORTED_BLOCKS.
  const messages: ModelMessage[] = [...history, asked, ...result.responseMessages];

  // `changed` is counted from the tool results rather than from the transaction,
  // which does not expose its size once committed.
  const changed = steps.length === 0 ? 0 : countChanged(result);

  // A run that changed nothing records no transaction, in which case the top of
  // the stack is somebody else's edit and summarising it would report their
  // work as this run's.
  const committed = session.history.undoStack[session.history.undoStack.length - 1];
  const summary =
    committed !== undefined && committed !== topBefore
      ? summarizeTransaction(session.doc, committed)
      : { removed: [], added: [], changed: 0 };

  return {
    text: result.text,
    changed,
    steps,
    remembered: countTurns(messages),
    messages,
    summary,
    undoLabel: summary.changed > 0 ? label : null,
  };
}

/** Adds up the `changed` each mutating tool reported. */
function countChanged(result: Awaited<ReturnType<typeof generateText>>): number {
  let total = 0;
  for (const step of result.steps) {
    for (const toolResult of step.toolResults ?? []) {
      const output = (toolResult as { output?: unknown }).output;
      if (output && typeof output === "object" && typeof (output as { changed?: unknown }).changed === "number") {
        total += (output as { changed: number }).changed;
      }
    }
  }
  return total;
}
