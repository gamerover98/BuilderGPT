/**
 * `agent/` — the tool loop, driven by a scripted model.
 *
 * There is no network here and no API key. What is being tested is the half
 * this app owns: that the tools do what they say to the document, that the
 * whole request lands as one undoable step, and that a run which fails leaves
 * nothing behind. Whether a given model chooses the right tool is not something
 * a test can assert, and pretending otherwise would only produce a suite that
 * breaks when a vendor changes a temperature default.
 */

import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";

import { AgentCancelledError, runAgent } from "../src/main/agent/agent.js";
import { LlmError } from "../src/main/services/llm.js";
import { getBlock, setBlock, type SchematicDocument } from "../src/main/domain/document.js";
import { canUndo, runTransaction, undo } from "../src/main/domain/history.js";
import { newDocument, type DocumentSession } from "../src/main/services/session.js";

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failures += 1;
  }
}

function equal(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.log(`         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  check(label, ok);
}

const ALLOWED = new Set([
  "minecraft:stone",
  "minecraft:cobblestone",
  "minecraft:oak_planks",
  "minecraft:glass",
  "minecraft:air",
]);

const block = (name: string) => ({ namespacedName: name, properties: {} });

/** A 6x6x6 with a cobblestone floor and a plank block in the middle of it. */
function seeded(): DocumentSession {
  const session = newDocument({ width: 6, height: 6, length: 6 });
  for (let x = 0; x < 6; x += 1) {
    for (let z = 0; z < 6; z += 1) {
      setBlock(session.doc, x, 0, z, block("minecraft:cobblestone"));
    }
  }
  setBlock(session.doc, 3, 0, 3, block("minecraft:oak_planks"));
  // A fresh document with no history: the seeding above is scenery, not an edit.
  session.history.undoStack.length = 0;
  session.history.redoStack.length = 0;
  session.history.savedDepth = 0;
  return session;
}

function grid(doc: SchematicDocument): string {
  const out: string[] = [];
  for (let x = 0; x < doc.width; x += 1) {
    for (let y = 0; y < doc.height; y += 1) {
      for (let z = 0; z < doc.length; z += 1) {
        out.push(getBlock(doc, x, y, z).namespacedName);
      }
    }
  }
  return out.join(",");
}

/**
 * A model that plays a fixed script: each entry is one turn's worth of output.
 * A `toolName` turn calls that tool; a `text` turn ends the run.
 */
type Turn =
  | { kind: "tool"; toolName: string; input: unknown }
  | { kind: "text"; text: string }
  | { kind: "throw"; message: string }
  /**
   * The user pressing Stop while the model is working: the signal trips and
   * the in-flight call rejects, which is what a real aborted fetch does.
   *
   * `name` is settable because that is the whole point of one of the tests —
   * an abort does not always arrive looking like an `AbortError`. Cut the
   * connection mid-stream and it surfaces as an ordinary socket failure.
   */
  | { kind: "abort"; controller: AbortController; message?: string; name?: string };

/**
 * What a scripted model was handed, so a test can assert on it.
 *
 * The prompts are the only way to check that the agent remembers anything:
 * the conversation lives in the session and is never returned, so the
 * observable fact is what turned up in the next request.
 */
interface Seen {
  prompts: unknown[][];
  systems: string[];
}

/**
 * A token count in the shape the provider contract wants.
 *
 * Nothing in `runAgent` reads it -- it is here because
 * `LanguageModelV3GenerateResult` requires it. It was a flat
 * `{ inputTokens: 1, outputTokens: 1, totalTokens: 2 }` until tests/ started
 * being typechecked, which is a shape the SDK moved away from: both counts are
 * now objects that break the total down by cache and by reasoning.
 */
const USAGE: LanguageModelV3GenerateResult["usage"] = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function scriptedModel(turns: Turn[], seen?: Seen) {
  let index = 0;
  return new MockLanguageModelV3({
    doGenerate: async (
      options: { prompt: unknown },
    ): Promise<LanguageModelV3GenerateResult> => {
      if (seen) {
        const messages = options.prompt as { role: string; content: unknown }[];
        seen.prompts.push(messages.filter((m) => m.role !== "system"));
        seen.systems.push(
          messages
            .filter((m) => m.role === "system")
            .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
            .join("\n"),
        );
      }
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if (turn.kind === "abort") {
        turn.controller.abort();
        const error = new Error(turn.message ?? "The operation was aborted");
        error.name = turn.name ?? "AbortError";
        throw error;
      }
      if (turn.kind === "throw") {
        throw new Error(turn.message);
      }
      if (turn.kind === "text") {
        return {
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: USAGE,
          content: [{ type: "text" as const, text: turn.text }],
          warnings: [],
        };
      }
      return {
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
        usage: USAGE,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: `call-${index}`,
            toolName: turn.toolName,
            input: JSON.stringify(turn.input),
          },
        ],
        warnings: [],
      };
    },
  });
}

const baseRequest = {
  /**
   * No prior turns, which is what all but the continuity tests want.
   *
   * It is a parameter now rather than something read off the session: the
   * conversation is stored per schematic and restored when that file is opened
   * again, so `runAgent` is handed what to replay instead of reaching for it.
   * That also makes the memory *visible* to these tests, which previously had
   * to infer it from what the model was sent.
   */
  history: [],
  provider: "OpenCode" as const,
  model: "test",
  apiKey: "none",
  baseUrl: "http://127.0.0.1:1/v1",
  allowedBlocks: ALLOWED,
};

console.log("=== Schematic AI Studio: agent ===\n");

// --- a tool call reaches the document ---------------------------------------
console.log("--- tools act on the document ---");
{
  const session = seeded();
  const result = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "replace the cobblestone with stone",
    modelOverride: scriptedModel([
      { kind: "tool", toolName: "replace_blocks", input: { from: "minecraft:cobblestone", to: "minecraft:stone" } },
      { kind: "text", text: "Replaced 35 cobblestone with stone." },
    ]),
  });

  equal("the blocks really changed", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:stone");
  equal("...and the one that did not match was left alone", getBlock(session.doc, 3, 0, 3).namespacedName, "minecraft:oak_planks");
  equal("the run reports how many it touched", result.changed, 35);
  equal("the model's closing text comes back", result.text, "Replaced 35 cobblestone with stone.");
  equal("the steps are narrated", result.steps.length, 1);
  equal("...naming the tool", result.steps[0]?.tool, "replace_blocks");
}

// --- one request is one undo -------------------------------------------------
//
// The property the whole design is for: nine tool calls, five hundred blocks,
// one CTRL+Z.
console.log("\n--- one request, one undo ---");
{
  const session = seeded();
  const before = grid(session.doc);

  const result = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "build a wall and a floor",
    modelOverride: scriptedModel([
      { kind: "tool", toolName: "fill_region", input: { minX: 0, minY: 1, minZ: 0, maxX: 5, maxY: 3, maxZ: 0, block: "minecraft:stone" } },
      { kind: "tool", toolName: "fill_region", input: { minX: 0, minY: 4, minZ: 0, maxX: 5, maxY: 4, maxZ: 5, block: "minecraft:oak_planks" } },
      { kind: "tool", toolName: "set_block", input: { x: 2, y: 2, z: 0, block: "minecraft:glass" } },
      { kind: "tool", toolName: "replace_blocks", input: { from: "minecraft:cobblestone", to: "minecraft:stone" } },
      { kind: "text", text: "Done." },
    ]),
  });

  equal("four tools ran", result.steps.length, 4);
  check("the document changed a lot", result.changed > 50, `changed ${result.changed}`);
  equal("but there is exactly one undo step", session.history.undoStack.length, 1);
  check(
    "...labelled from what the user asked for",
    session.history.undoStack[0]?.label.startsWith("AI: build a wall"),
    session.history.undoStack[0]?.label,
  );

  undo(session.doc, session.history);
  equal("one undo reverses the entire request", grid(session.doc), before);
  check("...leaving nothing further to undo", !canUndo(session.history));
}

// --- the selection is the default region -------------------------------------
console.log("\n--- the selection is context ---");
{
  const session = seeded();
  // No region in the tool call at all: it must land on the selection.
  await runAgent({
    ...baseRequest,
    session,
    selection: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 1 },
    prompt: "fill the selection with glass",
    modelOverride: scriptedModel([
      { kind: "tool", toolName: "fill_region", input: { block: "minecraft:glass" } },
      { kind: "text", text: "Filled the selection." },
    ]),
  });

  equal("inside the selection is filled", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:glass");
  equal("...and the far corner of it", getBlock(session.doc, 1, 0, 1).namespacedName, "minecraft:glass");
  equal(
    "outside the selection is untouched",
    getBlock(session.doc, 4, 0, 4).namespacedName,
    "minecraft:cobblestone",
  );
}

// --- a build script ----------------------------------------------------------
console.log("\n--- the build script tool ---");
{
  const session = seeded();
  await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "build a pillar",
    modelOverride: scriptedModel([
      {
        kind: "tool",
        toolName: "run_build_script",
        input: {
          code: "function buildCreation(x,y,z){ for (var i=1;i<5;i++){ safeSetBlock(2,i,2,'stone',null); } }",
        },
      },
      { kind: "text", text: "Built a pillar." },
    ]),
  });

  equal("the script's blocks landed", getBlock(session.doc, 2, 1, 2).namespacedName, "minecraft:stone");
  equal("...all of them", getBlock(session.doc, 2, 4, 2).namespacedName, "minecraft:stone");
  equal("...and no further", getBlock(session.doc, 2, 5, 2).namespacedName, "minecraft:air");
  equal("still one undo step", session.history.undoStack.length, 1);
}

// --- refusals ----------------------------------------------------------------
//
// A tool that refuses must tell the model why, so it can correct itself. The
// SDK feeds the error back as a tool result rather than aborting the run, which
// is what makes that possible.
console.log("\n--- a block the app cannot place ---");
{
  const session = seeded();
  const result = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "fill it with something made up",
    modelOverride: scriptedModel([
      { kind: "tool", toolName: "fill_region", input: { block: "minecraft:not_a_real_block" } },
      { kind: "text", text: "That block does not exist." },
    ]),
  });

  equal("nothing was placed", getBlock(session.doc, 0, 1, 0).namespacedName, "minecraft:air");
  equal("no undo step was created for a run that changed nothing", session.history.undoStack.length, 0);
  equal("the run still completes and explains itself", result.text, "That block does not exist.");
}

// --- a failed run leaves nothing behind --------------------------------------
console.log("\n--- the model fails mid-request ---");
{
  const session = seeded();
  const before = grid(session.doc);

  let thrown: unknown = null;
  try {
    await runAgent({
      ...baseRequest,
      session,
      selection: null,
      prompt: "start something and give up",
      modelOverride: scriptedModel([
        { kind: "tool", toolName: "fill_region", input: { minX: 0, minY: 1, minZ: 0, maxX: 5, maxY: 3, maxZ: 5, block: "minecraft:stone" } },
        { kind: "throw", message: "upstream connection reset" },
      ]),
    });
  } catch (err) {
    thrown = err;
  }

  check("the failure propagates", thrown instanceof Error);
  check(
    "...as an LLM error, which is what the UI recognises",
    thrown instanceof Error && thrown.message.startsWith("LLM API Error"),
    thrown instanceof Error ? thrown.message : String(thrown),
  );
  equal("the half-applied edit was rolled back", grid(session.doc), before);
  equal("...and left no undo step", session.history.undoStack.length, 0);
}

// --- the conversation ---------------------------------------------------------
//
// "Now make it taller" is only answerable if the previous turn is still there.
// None of this is observable from the return value — the transcript lives on
// the session and is never handed out — so these assert on what the model was
// actually sent.

/** Every scrap of text in one request's messages, flattened. */
function textOf(messages: unknown[]): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      parts.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };
  walk(messages);
  return parts.join(" ");
}

console.log("\n--- the agent remembers the conversation ---");
{
  const session = seeded();
  const seen: Seen = { prompts: [], systems: [] };

  const first = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "build a stone pillar at 2,2",
    modelOverride: scriptedModel(
      [
        { kind: "tool", toolName: "set_block", input: { x: 2, y: 1, z: 2, block: "minecraft:stone" } },
        { kind: "text", text: "Put a stone block at 2,1,2." },
      ],
      seen,
    ),
  });

  const second = await runAgent({
    ...baseRequest,
    session,
    history: first.messages,
    selection: null,
    prompt: "now make it taller",
    modelOverride: scriptedModel(
      [
        { kind: "tool", toolName: "set_block", input: { x: 2, y: 2, z: 2, block: "minecraft:stone" } },
        { kind: "text", text: "Raised it by one." },
      ],
      seen,
    ),
  });

  // seen.prompts: [turn1 call1, turn1 call2, turn2 call1, turn2 call2]
  const secondTurn = textOf(seen.prompts[2]);
  check(
    "the second request carries what the user asked the first time",
    secondTurn.includes("build a stone pillar at 2,2"),
  );
  check(
    "...and what the agent answered",
    secondTurn.includes("Put a stone block at 2,1,2."),
  );
  check("...as well as the new question", secondTurn.includes("now make it taller"));
  equal("both exchanges are remembered", second.remembered, 2);
  equal("the follow-up landed", getBlock(session.doc, 2, 2, 2).namespacedName, "minecraft:stone");

  // What the model *did*, not just what it said about it. `response.messages`
  // — the obvious field, and deprecated — holds only the final step, which
  // would drop every tool call and leave the agent re-reading what it already
  // knew. This is the assertion that catches that.
  const roles = (seen.prompts[2] as { role: string }[]).map((m) => m.role);
  check(
    "the tool call from the first turn is remembered too",
    roles.includes("tool"),
    roles.join(","),
  );
}

// --- the schematic summary is regenerated, never replayed ---------------------
//
// If the description rode along inside each user message, the transcript would
// accumulate contradictory block counts and the model would have no way to tell
// which was current.
console.log("\n--- the schematic summary is fresh, and there is only one ---");
{
  const session = seeded();
  const seen: Seen = { prompts: [], systems: [] };

  await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "fill the floor with stone",
    modelOverride: scriptedModel(
      [
        { kind: "tool", toolName: "replace_blocks", input: { from: "minecraft:cobblestone", to: "minecraft:stone" } },
        { kind: "text", text: "Done." },
      ],
      seen,
    ),
  });
  await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "and now the walls",
    modelOverride: scriptedModel([{ kind: "text", text: "Which walls?" }], seen),
  });

  const lastTurn = textOf(seen.prompts[seen.prompts.length - 1]);
  const lastSystem = seen.systems[seen.systems.length - 1];

  check("the dimensions reach the model", lastSystem.includes("6x6x6"));
  check(
    "...in the instructions, not glued onto the user's words",
    !lastTurn.includes("6x6x6"),
    lastTurn.slice(0, 200),
  );
  check(
    "the summary describes the schematic as it is now, after the first turn's edit",
    lastSystem.includes("minecraft:stone"),
  );
  check(
    "...and no longer claims the cobblestone that was replaced",
    !lastSystem.includes("minecraft:cobblestone"),
    lastSystem,
  );
}

// --- a failed run leaves the transcript alone --------------------------------
//
// The document is rolled back, so a transcript describing those edits would
// have the next turn building on something that never happened.
console.log("\n--- a failed turn is not remembered ---");
{
  const session = seeded();
  const seen: Seen = { prompts: [], systems: [] };

  const good = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "place one block",
    modelOverride: scriptedModel([{ kind: "text", text: "Placed it." }], seen),
  });

  /*
   * The invariant, stated more plainly than it used to be. A failed run throws
   * and therefore *returns no history at all*, so the caller still holds the
   * last good one and hands that to the next turn. It is not that the failed
   * turn is removed afterwards -- it is that it never became history.
   */
  try {
    await runAgent({
      ...baseRequest,
      session,
      history: good.messages,
      selection: null,
      prompt: "this request will fail",
      modelOverride: scriptedModel([{ kind: "throw", message: "upstream reset" }], seen),
    });
  } catch {
    // Expected; asserted in its own section above.
  }

  const third = await runAgent({
    ...baseRequest,
    session,
    history: good.messages,
    selection: null,
    prompt: "carry on",
    modelOverride: scriptedModel([{ kind: "text", text: "Carrying on." }], seen),
  });

  const carriedOn = textOf(seen.prompts[seen.prompts.length - 1]);
  check("the successful turn survives", carriedOn.includes("place one block"));
  check(
    "the failed one left nothing behind",
    !carriedOn.includes("this request will fail"),
    carriedOn,
  );
  equal("...and is not counted", third.remembered, 2);
}

// --- trimming ----------------------------------------------------------------
//
// The cap has to cut where a turn starts. Slicing between an assistant's tool
// call and the tool message answering it sends a tool_call_id that resolves to
// nothing, which providers reject outright.
console.log("\n--- old exchanges fall off the end, at turn boundaries ---");
{
  const session = seeded();
  const seen: Seen = { prompts: [], systems: [] };

  let last = 0;
  // Threaded, as the app threads it: each turn is handed what the one before
  // returned. The cap is `runAgent`'s own, applied to whatever it is given.
  let history: Awaited<ReturnType<typeof runAgent>>["messages"] = [];
  for (let turn = 0; turn < 16; turn += 1) {
    const result = await runAgent({
      ...baseRequest,
      session,
      history,
      selection: null,
      prompt: `turn number ${turn}`,
      modelOverride: scriptedModel(
        [
          { kind: "tool", toolName: "set_block", input: { x: 1, y: 1, z: 1, block: "minecraft:stone" } },
          { kind: "text", text: `Did turn ${turn}.` },
        ],
        seen,
      ),
    });
    last = result.remembered;
    history = result.messages;
  }

  check("the transcript stops growing", last === 12, `remembered ${last}`);

  const finalRequest = seen.prompts[seen.prompts.length - 1] as { role: string; content: unknown }[];
  equal("what is left starts at a user turn", finalRequest[0]?.role, "user");
  check(
    "the oldest turns are gone",
    !textOf(finalRequest).includes("turn number 0"),
  );
  check("the newest is not", textOf(finalRequest).includes("turn number 15"));

  // Every tool result must still be able to name the call it answers.
  const offered = new Set<string>();
  let orphans = 0;
  for (const message of finalRequest) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      const typed = part as { type?: string; toolCallId?: string };
      if (typed.type === "tool-call" && typed.toolCallId) {
        offered.add(typed.toolCallId);
      } else if (typed.type === "tool-result" && typed.toolCallId && !offered.has(typed.toolCallId)) {
        orphans += 1;
      }
    }
  }
  equal("no tool result was cut away from its call", orphans, 0);
}

/*
 * --- what "remembering" is, and whose job it is -------------------------------
 *
 * These two used to poke at `session.conversation` -- clearing it, or making a
 * second session and checking the first one's talk did not leak in. Neither is
 * `runAgent`'s rule any more. The conversation is stored per schematic and
 * restored when that file is opened, so *which* history applies is decided by
 * `services/conversation.ts` and tested against real files in tests/services.ts.
 *
 * What is left here is the contract this function actually has, and it is
 * sharper than what was being asserted before: it replays exactly the history
 * it is handed, and it returns the history the next turn should be handed. The
 * memory used to be invisible from the outside -- these had to infer it from
 * what the model was sent -- and now it is a value.
 */
console.log("\n--- the agent replays what it is given, and nothing else ---");
{
  const session = seeded();
  const seen: Seen = { prompts: [], systems: [] };

  const first = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "something memorable",
    modelOverride: scriptedModel([{ kind: "text", text: "Noted." }], seen),
  });

  check(
    "the turn comes back as history for the next one",
    textOf(first.messages).includes("something memorable"),
    textOf(first.messages),
  );

  // Handed nothing, it replays nothing -- which is what "new chat" amounts to
  // from this side, and what a conversation belonging to another document
  // amounts to as well.
  const after = await runAgent({
    ...baseRequest,
    session,
    history: [],
    selection: null,
    prompt: "a fresh start",
    modelOverride: scriptedModel([{ kind: "text", text: "Hello." }], seen),
  });

  const fresh = textOf(seen.prompts[seen.prompts.length - 1]);
  check("the old exchange is not sent", !fresh.includes("something memorable"), fresh);
  check("...and the new one is", fresh.includes("a fresh start"));
  equal("counting starts again", after.remembered, 1);

  // And handed the earlier history, it replays that -- even though the run in
  // between never touched it. Nothing is carried implicitly.
  const resumed = await runAgent({
    ...baseRequest,
    session,
    history: first.messages,
    selection: null,
    prompt: "and again",
    modelOverride: scriptedModel([{ kind: "text", text: "Sure." }], seen),
  });
  check(
    "an old history handed back is replayed",
    textOf(seen.prompts[seen.prompts.length - 1]).includes("something memorable"),
  );
  equal("...and counts both turns", resumed.remembered, 2);
}

// --- stopping a run -----------------------------------------------------------
//
// A request can be two dozen model round trips long, and the UI is disabled for
// all of it. Stop is only worth offering if it is safe, and "safe" here means
// something exact: the document ends up as it started, however far in the run
// had got.
console.log("\n--- the user stops a run ---");
{
  const session = seeded();
  const before = grid(session.doc);
  const controller = new AbortController();

  let thrown: unknown = null;
  try {
    await runAgent({
      ...baseRequest,
      session,
      selection: null,
      signal: controller.signal,
      prompt: "flatten everything",
      modelOverride: scriptedModel([
        // Real damage first, so the rollback has something to undo.
        { kind: "tool", toolName: "fill_region", input: { minX: 0, minY: 0, minZ: 0, maxX: 5, maxY: 5, maxZ: 5, block: "minecraft:stone" } },
        { kind: "abort", controller },
      ]),
    });
  } catch (err) {
    thrown = err;
  }

  check("it reports being stopped", thrown instanceof AgentCancelledError);
  check(
    "...and not as a failure, which is what keeps it out of the error UI",
    !(thrown instanceof LlmError),
  );
  equal("the document is exactly as it was", grid(session.doc), before);
  equal("...with no undo step to clean up", session.history.undoStack.length, 0);
}

// The choice this pins: cancellation is decided by the signal, not by what the
// error looked like. An aborted call reports itself differently depending on
// where in the loop it was caught, so reading the message would classify some
// stops as crashes.
console.log("\n--- a stop is recognised however the call failed ---");
{
  const session = seeded();
  const controller = new AbortController();

  let thrown: unknown = null;
  try {
    await runAgent({
      ...baseRequest,
      session,
      selection: null,
      signal: controller.signal,
      prompt: "stop me",
      modelOverride: scriptedModel([
        // Aborted, but surfacing as something that looks nothing like an
        // abort — neither the message nor the name says so. Only the signal
        // does, which is why the signal is what gets read.
        { kind: "abort", controller, message: "socket hang up", name: "Error" },
      ]),
    });
  } catch (err) {
    thrown = err;
  }

  check("still reported as stopped, not as a connection error", thrown instanceof AgentCancelledError);
}

console.log("\n--- a stopped run is not remembered ---");
{
  const session = seeded();
  const seen: Seen = { prompts: [], systems: [] };

  const before = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "the first thing",
    modelOverride: scriptedModel([{ kind: "text", text: "Done." }], seen),
  });

  const controller = new AbortController();
  try {
    await runAgent({
      ...baseRequest,
      session,
      history: before.messages,
      selection: null,
      signal: controller.signal,
      prompt: "the stopped thing",
      modelOverride: scriptedModel([{ kind: "abort", controller }], seen),
    });
  } catch {
    // Asserted above.
  }

  // Same shape as the failure case: a stopped run returns nothing, so the
  // caller is still holding the history from before it.
  const after = await runAgent({
    ...baseRequest,
    session,
    history: before.messages,
    selection: null,
    prompt: "the third thing",
    modelOverride: scriptedModel([{ kind: "text", text: "Done." }], seen),
  });

  const carried = textOf(seen.prompts[seen.prompts.length - 1]);
  check("the turn before it survives", carried.includes("the first thing"));
  check("the stopped one left nothing behind", !carried.includes("the stopped thing"), carried);
  equal("...and is not counted", after.remembered, 2);
}

// A signal that never trips must change nothing — otherwise every ordinary run
// would be at the mercy of the cancellation path.
console.log("\n--- a run nobody stops is unaffected ---");
{
  const session = seeded();
  const controller = new AbortController();
  const result = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    signal: controller.signal,
    prompt: "replace the cobblestone with stone",
    modelOverride: scriptedModel([
      { kind: "tool", toolName: "replace_blocks", input: { from: "minecraft:cobblestone", to: "minecraft:stone" } },
      { kind: "text", text: "Replaced them." },
    ]),
  });

  equal("the edit landed", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:stone");
  equal("...and is undoable as one step", session.history.undoStack.length, 1);
  equal("the run is remembered", result.remembered, 1);

  // Stopping something already finished must not reach back into it.
  controller.abort();
  equal("a late stop does not undo it", getBlock(session.doc, 0, 0, 0).namespacedName, "minecraft:stone");
  equal("...nor discard the undo step", session.history.undoStack.length, 1);
}

// --- what it actually did -----------------------------------------------------
//
// "1,247 blocks changed" does not say whether the user's build survived. The
// summary is the receipt, and the property that makes it worth trusting is that
// it is read from the same deltas undo replays — so it cannot claim something
// undo would not put back.
console.log("\n--- the run reports what it took and what it laid down ---");
{
  const session = seeded();
  const result = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "pave over the floor",
    modelOverride: scriptedModel([
      { kind: "tool", toolName: "replace_blocks", input: { from: "minecraft:cobblestone", to: "minecraft:stone" } },
      { kind: "text", text: "Paved it." },
    ]),
  });

  equal("it says what was taken out", result.summary.removed, [
    { block: "minecraft:cobblestone", count: 35 },
  ]);
  equal("...and what went in", result.summary.added, [{ block: "minecraft:stone", count: 35 }]);
  equal("...over that many voxels", result.summary.changed, 35);
  check("...and offers the undo entry it made", result.undoLabel !== null);
  equal("...which is the one on the stack", result.undoLabel, session.history.undoStack[0]?.label);
}

console.log("\n--- the receipt is ordered by how much it cost ---");
{
  const session = seeded();
  // One plank, thirty-five cobble: the bigger loss has to lead.
  const result = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "clear the floor",
    modelOverride: scriptedModel([
      { kind: "tool", toolName: "fill_region", input: { minX: 0, minY: 0, minZ: 0, maxX: 5, maxY: 0, maxZ: 5, block: "minecraft:glass" } },
      { kind: "text", text: "Cleared." },
    ]),
  });

  equal("both materials are named", result.summary.removed.length, 2);
  equal("the commonest first", result.summary.removed[0].block, "minecraft:cobblestone");
  equal("...with its count", result.summary.removed[0].count, 35);
  equal("...then the rest", result.summary.removed[1], { block: "minecraft:oak_planks", count: 1 });
}

// Air is absence, not a material. Counting it would report a demolition as
// though something had been gained.
console.log("\n--- demolition reads as loss, not as gaining air ---");
{
  const session = seeded();
  const result = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "demolish it",
    modelOverride: scriptedModel([
      { kind: "tool", toolName: "fill_region", input: { minX: 0, minY: 0, minZ: 0, maxX: 5, maxY: 0, maxZ: 5, block: "minecraft:air" } },
      { kind: "text", text: "Gone." },
    ]),
  });

  equal("36 blocks were lost", result.summary.changed, 36);
  equal("nothing was added", result.summary.added, []);
  check(
    "and air is not listed as a loss either",
    result.summary.removed.every((t) => !t.block.startsWith("minecraft:air")),
    JSON.stringify(result.summary.removed),
  );
}

// The property that makes the receipt trustworthy: undo puts back exactly what
// it said was taken.
console.log("\n--- the receipt agrees with what undo restores ---");
{
  const session = seeded();
  const before = grid(session.doc);
  const result = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "rebuild the floor in glass",
    modelOverride: scriptedModel([
      { kind: "tool", toolName: "replace_blocks", input: { from: "minecraft:cobblestone", to: "minecraft:glass" } },
      { kind: "tool", toolName: "set_block", input: { x: 3, y: 0, z: 3, block: "minecraft:stone" } },
      { kind: "text", text: "Done." },
    ]),
  });

  // Count what really moved, independently of the summary.
  const after = grid(session.doc);
  const actuallyChanged = before
    .split(",")
    .filter((block, i) => block !== after.split(",")[i]).length;
  equal("the count matches the voxels that really differ", result.summary.changed, actuallyChanged);

  const removedTotal = result.summary.removed.reduce((n, t) => n + t.count, 0);
  undo(session.doc, session.history);
  equal("undo restores the document exactly", grid(session.doc), before);
  equal(
    "...and the receipt named every block it gave back",
    removedTotal,
    // Every changed voxel held something (the fixture has no air in the floor).
    actuallyChanged,
  );
}

console.log("\n--- a run that changes nothing claims nothing ---");
{
  const session = seeded();
  // Seed an unrelated edit, so there is a transaction on the stack that this
  // run must not mistake for its own.
  setBlock(session.doc, 5, 5, 5, block("minecraft:stone"));
  runTransaction(session.doc, session.history, "Someone else's edit", (tx) =>
    tx.setBlock(4, 4, 4, block("minecraft:stone")) ? 1 : 0,
  );

  const result = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "have a look around",
    modelOverride: scriptedModel([
      { kind: "tool", toolName: "get_schematic_info", input: {} },
      { kind: "text", text: "It is a 6x6x6." },
    ]),
  });

  equal("nothing is reported as removed", result.summary.removed, []);
  equal("nothing as added", result.summary.added, []);
  equal("nothing as changed", result.summary.changed, 0);
  equal("and there is no undo entry to offer", result.undoLabel, null);
  equal("the other edit is still on the stack", session.history.undoStack.length, 1);
  equal(
    "...untouched",
    session.history.undoStack[0]?.label,
    "Someone else's edit",
  );
}

// --- turning things from chat ---------------------------------------------------
//
// The domain grew rotation and mirroring; without a tool the model cannot reach
// them, and "rotate the tower 90 degrees" is exactly the sort of thing nobody
// wants to do a block at a time.
console.log("\n--- the agent can turn a region ---");
{
  const session = seeded();
  // A stair on the floor, so both its position and its facing have to move.
  setBlock(session.doc, 0, 1, 0, {
    namespacedName: "minecraft:oak_stairs",
    properties: { facing: "north" },
  });
  session.history.undoStack.length = 0;
  const before = grid(session.doc);

  const result = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "turn the whole thing a quarter",
    modelOverride: scriptedModel([
      { kind: "tool", toolName: "transform_region", input: { rotate: 1 } },
      { kind: "text", text: "Turned it." },
    ]),
  });

  // One quarter turn of a 6x6x6: (x, z) -> (5 - z, x), east from south.
  equal("the stair moved", getBlock(session.doc, 5, 1, 0).namespacedName, "minecraft:oak_stairs");
  equal("...and turned with the region", getBlock(session.doc, 5, 1, 0).properties.facing, "east");
  check("the run reports what it moved", result.changed > 0, `${result.changed}`);
  equal("...as one undo step", session.history.undoStack.length, 1);

  undo(session.doc, session.history);
  equal("one undo puts the whole turn back", grid(session.doc), before);
}

console.log("\n--- a turn the region cannot take ---");
{
  // 6x6x6 is square, so make the selection oblong instead. The floor is uniform
  // cobblestone, so a turn of it alone would write cobblestone onto cobblestone
  // and record nothing — this one block is what makes the half turn observable.
  const session = seeded();
  setBlock(session.doc, 0, 0, 0, block("minecraft:glass"));
  session.history.undoStack.length = 0;

  const result = await runAgent({
    ...baseRequest,
    session,
    selection: { minX: 0, minY: 0, minZ: 0, maxX: 5, maxY: 0, maxZ: 2 },
    prompt: "rotate my selection",
    modelOverride: scriptedModel([
      { kind: "tool", toolName: "transform_region", input: { rotate: 1 } },
      // The refusal comes back as a tool result, so the model gets to correct
      // itself rather than the run dying.
      { kind: "tool", toolName: "transform_region", input: { rotate: 2 } },
      { kind: "text", text: "That selection is not square, so I turned it 180° instead." },
    ]),
  });

  equal("it recovered and finished", result.text.includes("180"), true);
  equal("both attempts are narrated", result.steps.length, 2);
  equal("...and the run still produced one undo step", session.history.undoStack.length, 1);
  // The half turn really landed: (x, z) -> (5 - x, 2 - z) within the selection.
  equal("the half turn moved the block", getBlock(session.doc, 5, 0, 2).namespacedName, "minecraft:glass");
}

console.log("\n--- mirroring from chat ---");
{
  const session = seeded();
  setBlock(session.doc, 0, 1, 0, {
    namespacedName: "minecraft:oak_stairs",
    properties: { facing: "east" },
  });
  session.history.undoStack.length = 0;

  await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "flip it east to west",
    modelOverride: scriptedModel([
      { kind: "tool", toolName: "transform_region", input: { mirror: "x" } },
      { kind: "text", text: "Flipped." },
    ]),
  });

  equal("the block reflected", getBlock(session.doc, 5, 1, 0).namespacedName, "minecraft:oak_stairs");
  equal("...and so did its facing", getBlock(session.doc, 5, 1, 0).properties.facing, "west");
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exitCode = failures === 0 ? 0 : 1;
