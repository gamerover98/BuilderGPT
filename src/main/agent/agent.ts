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
 */

import { generateText, stepCountIs, type ModelMessage } from "ai";

import { runTransactionAsync } from "../domain/history.js";
import type { Region } from "../domain/document.js";
import { countBlocks, normalizeRegion, paletteHistogram } from "../domain/document.js";
import { LlmError, resolveModel } from "../services/llm.js";
import type { DocumentSession } from "../services/session.js";
import { buildTools } from "./tools.js";

/** How many tool round trips one request may take before it is cut off. */
const MAX_STEPS = 24;

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

export async function runAgent(request: AgentRequest): Promise<AgentResult> {
  const steps: AgentStep[] = [];
  const { session } = request;

  const result = await runTransactionAsync(
    session.doc,
    session.history,
    undoLabel(request.prompt),
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

      const messages: ModelMessage[] = [
        {
          role: "user",
          content: `${describeDocument(session, request.selection)}\n\n${request.prompt}`,
        },
      ];

      try {
        return await generateText({
          model: request.modelOverride ?? resolveModel(request),
          instructions: SYSTEM_PROMPT,
          messages,
          tools,
          // Without a stop condition the SDK returns after the first tool call
          // and never feeds the result back, so the model would place one block
          // and stop mid-thought.
          stopWhen: stepCountIs(MAX_STEPS),
          temperature: 0.2,
          abortSignal: request.signal,
        });
      } catch (err) {
        // Same contract as `callLlm`: everything leaves as an LlmError, because
        // that prefix is what the UI and `classifyGenerateError` recognise.
        throw new LlmError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // `changed` is counted from the tool results rather than from the transaction,
  // which does not expose its size once committed.
  const changed = steps.length === 0 ? 0 : countChanged(result);

  return { text: result.text, changed, steps };
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
