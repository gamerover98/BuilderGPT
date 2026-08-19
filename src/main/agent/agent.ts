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

import { generateText, stepCountIs, streamText, type ModelMessage } from "ai";

import type { TraceItem } from "../../shared/ipc.js";
import { formatJson, TraceRecorder, type TraceSink } from "../services/trace.js";
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
  /** Which run this is, so trace events can be told from another run's. */
  requestId: string;
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
  /**
   * Where the running commentary goes.
   *
   * Optional, and the loop is identical without it: the tests drive `runAgent`
   * with no sink and assert on the trace it returns, which is the same array
   * these events describe.
   */
  onTrace?: TraceSink;
  signal?: AbortSignal;
  /**
   * Test seam: a language model to use instead of the one the provider fields
   * would resolve to. Exists so the tool loop can be driven by a scripted model
   * without a network or an API key — the tools and the transaction are what
   * this app owns and what is worth testing.
   *
   * Typed off `generateText` and handed to `streamText`, which take the same
   * `LanguageModel`. Naming the type through the function that no longer runs
   * the loop would be a trap, so it names neither: the scripted model must
   * implement `doStream`, because that is what the loop calls now.
   */
  modelOverride?: Parameters<typeof streamText>[0]["model"];
  /** Test seam: the clock the trace times itself against. */
  now?: () => number;
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
   * Everything the turn did, in order — the request, the thinking, the calls.
   *
   * Returned rather than only streamed, because the stream is a courtesy and
   * this is the record: it goes onto the chat entry, and it is what the panel
   * draws when the conversation is opened again tomorrow.
   */
  trace: TraceItem[];
  /**
   * The undo entry this run created, or `null` if it changed nothing. The UI
   * offers "Undo this" only while this still matches the top of the stack.
   */
  undoLabel: string | null;
  /** Which transaction that was, for the chat to match against the live one. */
  undoTransactionId: number | null;
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
  // The old wording was "rather than hundreds of set_block calls", which a
  // model reading it takes as an argument about *cost*: if it is reaching for
  // replace_blocks it concludes the rule does not apply to it. A sloping roof
  // is not hundreds of set_blocks, it is a shape, and shapes are what the
  // script is for.
  "- A shape is a build script. Anything whose blocks depend on where they are — a roof, an arch,",
  "  a spiral, anything sloping or tapering — is run_build_script, because it is the only tool that",
  "  can vary a block by coordinate. fill_region and replace_blocks cannot make a shape: they apply",
  "  one block to a box, so reaching for them here gives a solid box of that block instead.",
  "- Coordinates start at 0 and y is up. Everything is inclusive of both ends.",
  // The clamp used to be silent, so a fill above the ceiling landed *at* the
  // ceiling and reported a healthy count. It says so now, and this is the way
  // out that the tools list alone did not make obvious.
  "- The schematic is a fixed box and every region is trimmed to it. If what the user wants does not",
  "  fit — a roof on a build that already reaches the top — call resize_document first. Nothing moves",
  "  when you do: the room is added at the far side.",
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
    `Valid coordinates: x 0-${doc.width - 1}, y 0-${doc.height - 1}, z 0-${doc.length - 1}. There is nothing above` +
      ` y=${doc.height - 1} until you resize.`,
    top === "" ? "It is empty." : `Most common blocks:\n${top}`,
  ];
  if (selection) {
    const region = normalizeRegion(doc, selection);
    /*
     * Its *size*, not only its corners.
     *
     * Two corners is the same information and it is not the same message: a
     * model handed "(0,7,0) to (15,7,9)" spends its reasoning working out that
     * this is one block tall, and sometimes gets it wrong. Saying "16 wide x 1
     * tall x 10 long" costs nine words and removes the question -- and naming
     * the case where the selection is a single plane removes the follow-up,
     * because "build a roof in here" has no answer inside a plane.
     */
    const size = [
      region.maxX - region.minX + 1,
      region.maxY - region.minY + 1,
      region.maxZ - region.minZ + 1,
    ] as const;
    lines.push(
      `The user has selected (${region.minX},${region.minY},${region.minZ}) to ` +
        `(${region.maxX},${region.maxY},${region.maxZ}): ${size[0]} wide x ${size[1]} tall x ${size[2]} long, ` +
        `${(size[0] * size[1] * size[2]).toLocaleString()} cells. Tools act on this by default.`,
    );
    if (size[1] === 1) {
      lines.push(
        `That selection is a single flat layer at y=${region.minY}, so nothing with height fits inside it. ` +
          `Build above it, and resize first if y=${region.minY} is already the top.`,
      );
    }
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

/** One message, rendered the way it will be read rather than as JSON. */
function renderMessage(message: ModelMessage): string {
  const { content } = message;
  if (typeof content === "string") return `[${message.role}] ${content}`;
  // Tool traffic: an assistant message carrying calls, or a tool message
  // carrying results. Rendered as their JSON, because that is what they are.
  const parts = (content as unknown[]).map((part) => {
    const typed = part as { type?: string; text?: string };
    return typed.type === "text" && typeof typed.text === "string"
      ? typed.text
      : formatJson(part);
  });
  return `[${message.role}] ${parts.join("\n")}`;
}

/**
 * Exactly what is about to be sent, as one readable block.
 *
 * The instructions and the replayed conversation, in the order the model
 * receives them. This is the thing that was previously impossible to see: the
 * document summary is regenerated every turn and the history is trimmed here,
 * so neither the prompt box nor the chat log shows what actually went.
 */
function renderRequest(instructions: string, messages: readonly ModelMessage[]): string {
  return [
    "=== instructions ===",
    instructions,
    "",
    `=== messages (${messages.length}) ===`,
    ...messages.map(renderMessage),
  ].join("\n");
}

/**
 * Drops a trailing `text` item that only repeats the answer.
 *
 * The closing sentence arrives as a text part like any other, so without this
 * every turn ends with the same paragraph twice: once in the bubble and once at
 * the bottom of its own trace. Only the last one, and only when it matches —
 * prose the model wrote *before* a tool call is exactly what this feature is
 * for, and must survive.
 */
export function dropClosingText(trace: readonly TraceItem[], answer: string): TraceItem[] {
  const wanted = answer.trim();
  if (wanted === "") return [...trace];
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    if (trace[i].kind !== "text") continue;
    return trace[i].text.trim() === wanted
      ? [...trace.slice(0, i), ...trace.slice(i + 1)]
      : [...trace];
  }
  return [...trace];
}

export async function runAgent(request: AgentRequest): Promise<AgentResult> {
  const steps: AgentStep[] = [];
  const { session } = request;
  const recorder = new TraceRecorder(request.requestId, request.onTrace, request.now);

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
      /*
       * A tool's own phrasing of what it did, by call id.
       *
       * Held rather than written straight onto the trace row because the two
       * arrive from different directions: this comes from inside `execute`,
       * while the row was opened by the `tool-call` part and is closed by the
       * `tool-result` part. The id is what ties them together — see the note on
       * `ToolContext.onStep`.
       */
      const summaries = new Map<string, string>();
      const tools = buildTools({
        doc: session.doc,
        tx,
        selection: request.selection,
        allowedBlocks: request.allowedBlocks,
        onStep: (step) => {
          if (step.id !== undefined) summaries.set(step.id, step.summary);
          steps.push({ tool: step.tool, summary: step.summary });
          request.onStep?.({ tool: step.tool, summary: step.summary });
        },
      });

      // Rebuilt every turn, so the state the model reasons from is the state
      // the document is actually in — see the note at the top.
      const instructions = `${SYSTEM_PROMPT}\n\n${describeDocument(session, request.selection)}`;
      const messages = [...history, asked];
      recorder.start({
        kind: "request",
        text: renderRequest(instructions, messages),
      });

      try {
        const stream = streamText({
          model: request.modelOverride ?? resolveModel(request),
          instructions,
          messages,
          tools,
          // Without a stop condition the SDK returns after the first tool call
          // and never feeds the result back, so the model would place one block
          // and stop mid-thought.
          stopWhen: stepCountIs(MAX_STEPS),
          temperature: 0.2,
          abortSignal: request.signal,
          // `streamText`'s default is `console.error`, which for this app means
          // every stopped run and every upstream hiccup prints a stack trace
          // that nobody sees and nothing acts on. Errors are handled below,
          // from the stream, where they can be told apart.
          onError: () => {},
        });

        /*
         * Streamed rather than awaited whole, and that is the entire point of
         * this path: `generateText` resolves once, at the end, so there was
         * nothing to show for however long the model took. The tool summaries
         * did arrive live — tools execute during the call — but the thinking
         * and the prose either side of them did not exist until it was over.
         *
         * The parts carry their own ids, so a model that interleaves two
         * reasoning blocks around a tool call keeps them apart. Ours are mapped
         * onto the recorder's, which is what the renderer folds against.
         */
        const openItems = new Map<string, number>();
        for await (const part of stream.fullStream) {
          switch (part.type) {
            case "reasoning-start":
              openItems.set(part.id, recorder.start({ kind: "reasoning", text: "", running: true }));
              break;
            case "text-start":
              openItems.set(part.id, recorder.start({ kind: "text", text: "", running: true }));
              break;
            case "reasoning-delta":
            case "text-delta": {
              const id = openItems.get(part.id);
              if (id !== undefined) recorder.append(id, part.text);
              break;
            }
            case "reasoning-end":
            case "text-end": {
              const id = openItems.get(part.id);
              if (id !== undefined) recorder.finish(id);
              openItems.delete(part.id);
              break;
            }
            case "tool-call":
              openItems.set(
                part.toolCallId,
                recorder.start({
                  kind: "tool",
                  name: part.toolName,
                  // Filled in by `finish` from the summary the tool itself
                  // reports, which is phrased for a reader; the input beside it
                  // is the literal call.
                  text: part.toolName,
                  input: formatJson(part.input),
                  running: true,
                }),
              );
              break;
            case "tool-result": {
              const id = openItems.get(part.toolCallId);
              if (id !== undefined) {
                recorder.finish(id, { text: summaries.get(part.toolCallId) ?? part.toolName, output: formatJson(part.output) });
              }
              openItems.delete(part.toolCallId);
              break;
            }
            case "tool-error": {
              const id = openItems.get(part.toolCallId);
              if (id !== undefined) {
                recorder.finish(id, {
                  error: part.error instanceof Error ? part.error.message : String(part.error),
                });
              }
              openItems.delete(part.toolCallId);
              break;
            }
            case "abort":
              // The signal check below turns this into the right error; raising
              // here only stops us waiting on promises that will never settle.
              throw new AgentCancelledError();
            case "error":
              throw part.error;
            default:
              break;
          }
        }

        // Anything the model left open — a provider that ends a stream without
        // closing its last block — is closed here, or it would draw as still
        // running for as long as the conversation exists.
        for (const id of openItems.values()) recorder.finish(id);

        return {
          text: await stream.text,
          responseMessages: await stream.responseMessages,
          steps: await stream.steps,
        };
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
    trace: dropClosingText(recorder.snapshot(), result.text),
    undoLabel: summary.changed > 0 ? label : null,
    undoTransactionId: summary.changed > 0 ? (committed?.id ?? null) : null,
  };
}

/**
 * Adds up the `changed` each mutating tool reported.
 *
 * Structurally typed rather than named off the SDK: it wants the steps and
 * nothing else, and `streamText` hands back its own result shape. Naming a
 * concrete SDK type here would have made this the reason the loop could not
 * change.
 */
function countChanged(result: {
  steps: readonly { toolResults?: readonly unknown[] }[];
}): number {
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
