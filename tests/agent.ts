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
  | { kind: "throw"; message: string };

function scriptedModel(turns: Turn[]) {
  let index = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
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

console.log("=== BuilderGPT schematic agent ===\n");

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

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exitCode = failures === 0 ? 0 : 1;
