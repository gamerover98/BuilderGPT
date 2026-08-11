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

import { MockLanguageModelV3 } from "ai/test";

import { runAgent } from "../src/main/agent/agent.js";
import { getBlock, setBlock, type SchematicDocument } from "../src/main/domain/document.js";
import { canUndo, undo } from "../src/main/domain/history.js";
import { clearConversation, newDocument, type DocumentSession } from "../src/main/services/session.js";

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
  | { kind: "throw"; message: string };

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

function scriptedModel(turns: Turn[], seen?: Seen) {
  let index = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options: { prompt: unknown }) => {
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
      if (turn.kind === "throw") {
        throw new Error(turn.message);
      }
      if (turn.kind === "text") {
        return {
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [{ type: "text" as const, text: turn.text }],
          warnings: [],
        };
      }
      return {
        finishReason: "tool-calls" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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

  await runAgent({
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

  await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "place one block",
    modelOverride: scriptedModel([{ kind: "text", text: "Placed it." }], seen),
  });

  try {
    await runAgent({
      ...baseRequest,
      session,
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
  for (let turn = 0; turn < 16; turn += 1) {
    const result = await runAgent({
      ...baseRequest,
      session,
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

// --- starting over -----------------------------------------------------------
console.log("\n--- clearing the conversation ---");
{
  const session = seeded();
  const seen: Seen = { prompts: [], systems: [] };

  await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "something memorable",
    modelOverride: scriptedModel([{ kind: "text", text: "Noted." }], seen),
  });
  clearConversation(session);

  const after = await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "a fresh start",
    modelOverride: scriptedModel([{ kind: "text", text: "Hello." }], seen),
  });

  const fresh = textOf(seen.prompts[seen.prompts.length - 1]);
  check("the old exchange is gone", !fresh.includes("something memorable"), fresh);
  check("...and the new one is there", fresh.includes("a fresh start"));
  equal("counting starts again", after.remembered, 1);
}

// --- a conversation belongs to its document ----------------------------------
console.log("\n--- opening another document starts over ---");
{
  const session = seeded();
  const seen: Seen = { prompts: [], systems: [] };
  await runAgent({
    ...baseRequest,
    session,
    selection: null,
    prompt: "about the first schematic",
    modelOverride: scriptedModel([{ kind: "text", text: "Noted." }], seen),
  });

  // What `newDocument`/`openDocument`/`adoptDocument` all do: a new session.
  const other = seeded();
  const next = await runAgent({
    ...baseRequest,
    session: other,
    selection: null,
    prompt: "about the second",
    modelOverride: scriptedModel([{ kind: "text", text: "Noted." }], seen),
  });

  check(
    "the other document's conversation does not follow it",
    !textOf(seen.prompts[seen.prompts.length - 1]).includes("about the first schematic"),
  );
  equal("...it starts at one", next.remembered, 1);
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exitCode = failures === 0 ? 0 : 1;
