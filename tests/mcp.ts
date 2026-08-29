/**
 * The MCP server's rules, without the server.
 *
 * `mcp/server.ts` opens a socket and reaches Electron through the broadcast, so
 * it cannot be loaded here. `mcp/tools.ts` and `mcp/policy.ts` deliberately can
 * — the first takes its "tell the window" callback as an argument and the
 * second is pure — and between them they hold everything worth checking:
 * whether a call is one transaction, whether a refusal actually refuses, and
 * whether the tools MCP offers are the tools the app has.
 *
 * The one thing a suite cannot check is the part where somebody else's model is
 * on the other end. What it can check is that when that model does the wrong
 * thing, the app says no.
 */

import { spawn } from "child_process";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { createServer } from "http";
import { tmpdir } from "os";
import path from "path";

import { TOOL_SPECS, buildTools, type ToolContext } from "../src/main/agent/tools.js";
import { callTool, describeTools, findTool, isReadOnly, serialised } from "../src/main/mcp/tools.js";
import { LIFECYCLE_SPECS, findLifecycle, type Lifecycle } from "../src/main/mcp/lifecycle.js";
import { DOCUMENT_SPECS, findDocumentTool } from "../src/main/mcp/document_tools.js";
import {
  acceptsRequest,
  chooseToken,
  connectCommand,
  isInside,
  mayDelete,
  mayReplaceDocument,
  samePath,
  withinRoot,
} from "../src/main/mcp/policy.js";
import { countBlocks, getBlock } from "../src/main/domain/document.js";
import { paletteEntryCacheKey } from "../src/main/pipeline/types.js";
import {
  applyEdit,
  closeDocument,
  currentSession,
  newDocument,
  undoEdit,
} from "../src/main/services/session.js";
import type { DocumentSession } from "../src/main/services/session.js";

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
  "minecraft:oak_planks",
  "minecraft:air",
  // Carries four properties, one of which is deliberately not part of what a
  // placed block is born with -- which is the whole of what the default-state
  // checks below are about.
  "minecraft:campfire",
]);

/**
 * A `Lifecycle` whose effects are recorded rather than performed.
 *
 * The point of injecting them: a refusal can be checked by what it *stopped*
 * rather than only by what it said, which is the difference between testing a
 * guard and testing a sentence.
 */
function fakeLifecycle(over: Partial<Lifecycle> & { log?: string[] } = {}): Lifecycle {
  const log = over.log ?? [];
  const base: Lifecycle = {
    session: currentSession,
    isDirty: () => false,
    open: async (filePath) => {
      log.push(`open:${filePath}`);
      return open();
    },
    create: async () => {
      log.push("create");
      return open();
    },
    save: async (_session, options) => {
      log.push(`save:${options.filePath ?? "(same)"}`);
      return {
        filePath: options.filePath ?? "C:/builds/x.schem",
        format: "sponge3" as const,
        degraded: [],
    dropped: [],
        cropped: null,
      };
    },
    close: () => {
      log.push("close");
      closeDocument();
    },
    recents: async () => [{ filePath: "C:/builds/a.schem", openedAt: 1 }],
    trash: async (filePath) => {
      log.push(`trash:${filePath}`);
    },
    root: async () => "C:/builds",
    allowDelete: async () => false,
    refusalFor: () => null,
    announce: () => {
      log.push("announce");
    },
    capture: async () => null,
    versions: async () => [{ id: "v1", label: "before the roof", at: 1 }],
    saveVersion: async (label) => {
      log.push(`version:${label}`);
      return [{ id: "v2", label, at: 2 }];
    },
    restoreVersion: async (id) => {
      log.push(`restore:${id}`);
      return id === "v1" ? open() : null;
    },
    generate: async (prompt) => {
      log.push(`generate:${prompt}`);
      return { filePath: "C:/builds/made.schem", blocks: 12 };
    },
    ...over,
  };
  return base;
}

/** The options every call needs, with a spy for the "tell the window" callback. */
function options(sink: { changed: number }, lifecycle?: Lifecycle) {
  return {
    client: "Test",
    selection: null,
    allowedBlocks: ALLOWED,
    lifecycle: lifecycle ?? fakeLifecycle(),
    onChanged: (_session: DocumentSession) => {
      sink.changed += 1;
    },
  };
}

function open(): DocumentSession {
  closeDocument();
  newDocument({ width: 8, height: 8, length: 8 });
  const session = currentSession();
  if (session === null) throw new Error("newDocument left nothing open");
  return session;
}

console.log("=== Schematic AI Studio MCP ===\n");

const workDir = await mkdtemp(path.join(tmpdir(), "bgpt-mcp-"));

try {
  // --- the surface MCP offers is the surface the app has --------------------
  //
  // The anti-duplication tripwire. `agent/tools.ts` declares the tools once and
  // two things consume it; this fails the moment somebody adds a tool to one
  // side only, which is the failure the refactor exists to make impossible.
  console.log("--- the tools are the app's own ---");
  {
    const context = {
      doc: open().doc,
      tx: null,
      selection: null,
      allowedBlocks: ALLOWED,
    } as unknown as ToolContext;

    const fromAgent = Object.keys(buildTools(context)).sort();
    const fromMcp = describeTools().map((tool) => tool.name);
    const lifecycle = [
      ...LIFECYCLE_SPECS.map((spec) => spec.name),
      ...DOCUMENT_SPECS.map((spec) => spec.name),
    ];

    /*
     * The anti-duplication rule, stated from both sides.
     *
     * Every block-editing tool the agent has must be offered over MCP -- that
     * is the half that fails if somebody adds a tool to `agent/tools.ts` and
     * forgets this file. And the MCP list must be exactly those plus the
     * file-level verbs, which is the half that fails if somebody writes a
     * second `fill_region` here instead of reusing the one that exists.
     */
    const missing = fromAgent.filter((name) => !fromMcp.includes(name));
    equal("every agent tool is offered over MCP", missing, []);
    const extra = fromMcp.filter((name) => !fromAgent.includes(name) && !lifecycle.includes(name));
    equal("...and MCP invented none of its own", extra, []);
    equal("...with nothing listed twice", fromMcp.length, new Set(fromMcp).size);
    check("...and there are some", fromAgent.length >= 9, String(fromAgent.length));

    // A tool with no description is a tool a model will not choose correctly,
    // and an empty schema object is not the same as "no arguments".
    const bad = describeTools().filter(
      (tool) =>
        tool.description.trim() === "" ||
        typeof tool.inputSchema !== "object" ||
        tool.inputSchema.type !== "object",
    );
    equal("every tool has a description and an object schema", bad.map((t) => t.name), []);

    equal("an unknown tool is not found", findTool("no_such_tool"), null);
    check(
      "the read-only ones are the getters",
      isReadOnly("get_region") && !isReadOnly("fill_region"),
    );
    // ...and the one that is not about the document at all. It writes nothing,
    // so making it queue behind every mutation would be a `get_region` waiting
    // on a build script for no reason.
    check("...and so is the block reference", isReadOnly("describe_block"));

    // `describeTools` reads the two tables and must not be a copy of either.
    equal(
      "nothing was left out of the descriptors",
      describeTools().length,
      TOOL_SPECS.length + LIFECYCLE_SPECS.length + DOCUMENT_SPECS.length,
    );
  }

  // --- one call is one transaction -----------------------------------------
  console.log("\n--- one call, one undo step ---");
  {
    const session = open();
    const sink = { changed: 0 };
    const before = session.history.undoStack.length;

    await callTool(
      "fill_region",
      { minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3, block: "minecraft:stone" },
      options(sink),
    );

    equal("the fill landed", countBlocks(session.doc), 16);
    equal("...as exactly one undo step", session.history.undoStack.length - before, 1);
    equal("...and the window was told once", sink.changed, 1);

    undoEdit(session);
    equal("one undo takes all of it back", countBlocks(session.doc), 0);
  }

  // --- a failed call leaves nothing behind ---------------------------------
  //
  // The property `runTransactionAsync` is used for. A tool that throws halfway
  // through has already written blocks, and without the rollback those stay --
  // a half-built structure with no entry on the undo stack describing it.
  console.log("\n--- a call that throws changes nothing ---");
  {
    const session = open();
    const sink = { changed: 0 };
    await callTool(
      "fill_region",
      { minX: 0, minY: 0, minZ: 0, maxX: 7, maxY: 7, maxZ: 7, block: "minecraft:stone" },
      options(sink),
    );
    const filled = countBlocks(session.doc);
    const depth = session.history.undoStack.length;

    let raised: string | null = null;
    try {
      // Not in the allowlist, and `checkBlockAllowed` throws *after* the region
      // has been resolved -- so this is a real mid-tool failure.
      await callTool(
        "fill_region",
        { minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 3, maxZ: 3, block: "minecraft:beacon" },
        options(sink),
      );
    } catch (err) {
      raised = err instanceof Error ? err.message : String(err);
    }

    check("a block the app cannot place is refused", raised !== null, String(raised));
    equal("...the document is untouched", countBlocks(session.doc), filled);
    equal("...and nothing was pushed onto the undo stack", session.history.undoStack.length, depth);
    equal("...and the window was not told about a change that did not happen", sink.changed, 1);
  }

  // --- read-only calls take no transaction ---------------------------------
  //
  // And must not be able to. `refusingScope` is what turns a mis-classification
  // into a sentence naming the mistake rather than an edit that never reached
  // the undo stack.
  console.log("\n--- reading takes no transaction ---");
  {
    const session = open();
    const sink = { changed: 0 };
    const depth = session.history.undoStack.length;
    const outcome = await callTool("get_schematic_info", {}, options(sink));

    equal("the read answered", (outcome.result as { width: number }).width, 8);
    equal("...with no undo step", session.history.undoStack.length, depth);
    equal("...and no push to the window", sink.changed, 0);

    /*
     * Every tool marked read-only, actually run.
     *
     * The spot check above says `fill_region` is not on the list; this says the
     * ones that *are* on it do not write — which is the claim that matters, and
     * the one `refusingScope` is the backstop for. A tool that edited here would
     * throw with a sentence naming the mistake rather than quietly editing the
     * document outside the undo stack.
     */
    // A superset of the arguments any read-only tool wants: a region for the
    // ones that take one, a coordinate for the ones that take that. Nothing
    // validates against the schema here, so the extras are ignored -- and the
    // point of the loop is what the tools *do*, not what they accept.
    const region = {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: 1,
      maxY: 1,
      maxZ: 1,
      x: 0,
      y: 0,
      z: 0,
      // ...and a block list for the one read-only tool that is not about the
      // document at all.
      blocks: ["minecraft:stone"],
    };
    for (const tool of describeTools().filter((t) => t.annotations.readOnlyHint)) {
      const spy = { changed: 0 };
      const at = session.history.undoStack.length;
      let raised: string | null = null;
      try {
        // A working camera, so `capture_viewport` is exercised for what this
        // loop is about -- whether a read-only tool writes -- rather than
        // failing on the window that a test process does not have.
        await callTool(
          tool.name,
          region,
          options(spy, fakeLifecycle({ capture: async () => ({ data: "iVBOR", width: 8, height: 8 }) })),
        );
      } catch (err) {
        raised = err instanceof Error ? err.message : String(err);
      }
      check(`${tool.name} reads without writing`, raised === null, String(raised));
      equal(`...${tool.name} left the undo stack alone`, session.history.undoStack.length, at);
      equal(`...${tool.name} told the window nothing`, spy.changed, 0);
    }
  }

  // --- a block named by a tool is born in its state -------------------------
  //
  // `placementState` has filled in a placed block's properties since the
  // generated table landed, and for a long time it ran in exactly one place --
  // `App.svelte`, at the click. Every other way a block gets written named it
  // and stopped, so an MCP client, the in-app agent and a build script all
  // interned `minecraft:campfire` with an empty property bag.
  //
  // Nothing downstream notices, which is why this needs a check rather than a
  // bug report: the writers write what they are given, the mesher ignores what
  // it does not recognise, and the game fills in whatever the file left out. It
  // surfaces two steps away, as an inspector with nothing in it.
  console.log("\n--- a tool places a block in the state the game would give it ---");
  {
    const session = open();
    const sink = { changed: 0 };

    await callTool("set_block", { x: 1, y: 1, z: 1, block: "minecraft:campfire" }, options(sink));
    const bare = getBlock(session.doc, 1, 1, 1);
    equal("a bare id lands carrying its default state", bare?.properties.lit, "true");
    equal("...all of it", bare?.properties.signal_fire, "false");
    equal("...direction included", bare?.properties.facing, "north");
    /*
     * And not `waterlogged`, which is legal on a campfire and deliberately not
     * part of what a new one is born with: `legacy_blocks.json`'s rows carry the
     * connections and not that, and the MCEdit writer matches the exact state.
     * Writing it here would turn a clean 1.12 save into a page of degraded
     * reports, on every stair, slab, fence and pane in the build.
     */
    equal("...and nothing that is not part of a birth state", bare?.properties.waterlogged, undefined);

    await callTool(
      "set_block",
      { x: 2, y: 1, z: 1, block: "minecraft:campfire[lit=false]" },
      options(sink),
    );
    const spelled = getBlock(session.doc, 2, 1, 1);
    equal("what the caller spelled out wins over the default", spelled?.properties.lit, "false");
    equal("...and the rest is still filled in", spelled?.properties.signal_fire, "false");

    // A fill is a placement too, and so is the `to` side of a replacement.
    await callTool(
      "fill_region",
      { minX: 4, minY: 4, minZ: 4, maxX: 4, maxY: 4, maxZ: 4, block: "minecraft:campfire" },
      options(sink),
    );
    equal("a fill places them the same way", getBlock(session.doc, 4, 4, 4)?.properties.lit, "true");

    /*
     * And a build script, which is the path that had its own way of writing a
     * block: it called `parsePaletteEntry` directly rather than going through
     * the parse the other tools share, so it would have been the one route left
     * placing them bare.
     */
    await callTool(
      "run_build_script",
      {
        code:
          "function buildCreation(x, y, z) { safeSetBlock(5, 5, 5, 'minecraft:campfire'); }",
      },
      options(sink),
    );
    equal(
      "a build script places them the same way too",
      getBlock(session.doc, 5, 5, 5)?.properties.signal_fire,
      "false",
    );

    /*
     * The two halves composed, which is the point of the tool existing.
     *
     * `describe_block` says what will be written and `set_block` writes it.
     * Both were separately true of the campfire that came out bare -- the tool
     * would have described its properties correctly while the placement carried
     * none of them -- so the claim worth checking is that the same function
     * answers both, and `placedAs` is built by `toPlacedEntry` rather than
     * describing what it does.
     */
    const answer = await callTool(
      "describe_block",
      { blocks: ["minecraft:campfire"] },
      options(sink),
    );
    await callTool("set_block", { x: 3, y: 3, z: 3, block: "minecraft:campfire" }, options(sink));
    equal(
      "describe_block's placedAs is what set_block actually writes",
      paletteEntryCacheKey(getBlock(session.doc, 3, 3, 3)),
      (answer.result as { blocks: { placedAs: string }[] }).blocks[0].placedAs,
    );
  }

  // --- but `from` is a pattern, not a placement -----------------------------
  //
  // The sharp edge of the change above, and the way it would have gone wrong.
  // `Recorder.replace` interns `from` and matches on the palette *index*, so
  // the state has to be identical -- which is what `replace_blocks`' own
  // description and its zero-result note already say. Filling in the defaults
  // on that side would quietly change which blocks a replacement finds: "take
  // out the campfires" would take out the ones that happen to face north and be
  // alight, and report a healthy count for those.
  console.log("\n--- replace matches on what it was given ---");
  {
    const session = open();
    const sink = { changed: 0 };

    /*
     * A schematic holding a campfire with no states at all. Two ordinary ways
     * to get one: a file written by another tool, and the inspector, where
     * removing every property is now something a person can do.
     */
    applyEdit(session, {
      kind: "setState",
      x: 0,
      y: 0,
      z: 0,
      block: { namespacedName: "minecraft:campfire" },
    });
    equal(
      "the fixture really is bare",
      Object.keys(getBlock(session.doc, 0, 0, 0)?.properties ?? { a: "1" }).length,
      0,
    );

    const outcome = await callTool(
      "replace_blocks",
      {
        minX: 0,
        minY: 0,
        minZ: 0,
        maxX: 7,
        maxY: 7,
        maxZ: 7,
        from: "minecraft:campfire",
        to: "minecraft:stone",
      },
      options(sink),
    );
    equal(
      "a bare `from` still finds the bare block",
      (outcome.result as { changed: number }).changed,
      1,
    );

    // ...while `to` is a placement like any other.
    await callTool(
      "replace_blocks",
      {
        minX: 0,
        minY: 0,
        minZ: 0,
        maxX: 7,
        maxY: 7,
        maxZ: 7,
        from: "minecraft:stone",
        to: "minecraft:campfire",
      },
      options(sink),
    );
    equal(
      "...and `to` arrives in its full state",
      getBlock(session.doc, 0, 0, 0)?.properties.lit,
      "true",
    );
  }

  // --- describing a block is not a question about the document --------------
  console.log("\n--- describe_block ---");
  {
    const session = open();
    const sink = { changed: 0 };
    const outcome = await callTool(
      "describe_block",
      { blocks: ["minecraft:campfire", "minecraft:stone", "minecraft:beacon"] },
      options(sink),
    );
    const blocks = (
      outcome.result as {
        blocks: {
          block: string;
          placeable: boolean;
          properties: { name: string; default: string | null; description: string | null }[];
        }[];
      }
    ).blocks;

    equal("it answers about each block asked", blocks.length, 3);
    equal(
      "...naming the properties the game gives it",
      blocks[0].properties.map((p) => p.name),
      ["facing", "lit", "signal_fire", "waterlogged"],
    );
    check(
      "...with a sentence about each",
      blocks[0].properties.every((p) => (p.description ?? "").length > 0),
      JSON.stringify(blocks[0].properties.map((p) => p.description)),
    );
    // A property that is legal and is not written on a new block reports no
    // default, rather than the value it would have had -- which would
    // contradict `placedAs`, where it does not appear.
    equal(
      "...and a legal property that is not part of a birth state has no default",
      blocks[0].properties.find((p) => p.name === "waterlogged")?.default,
      null,
    );
    equal("a block with no states says so", blocks[1].properties.length, 0);
    // Reported per block rather than thrown, so one bad id in a batch of
    // sixteen does not cost the answer for the other fifteen.
    equal("a block this app cannot place is named, not thrown", blocks[2].placeable, false);
    equal("...and asking changed nothing", sink.changed, 0);
    equal("...and left the undo stack alone", session.history.undoStack.length, 0);

    let raised: string | null = null;
    try {
      await callTool("describe_block", { blocks: [] }, options(sink));
    } catch (err) {
      raised = err instanceof Error ? err.message : String(err);
    }
    check("asking about nothing is refused", raised !== null, String(raised));
  }

  // --- mutations are serialised --------------------------------------------
  //
  // Two overlapping `runTransactionAsync` bodies would interleave, one
  // recorder's rollback undoing the other's writes. Main being single-threaded
  // is no protection: the `await` is exactly where the second one gets in.
  //
  // Tested against `serialised` itself rather than through two tool calls, and
  // that is not a shortcut — it is the only way to test it. `fill_region`'s body
  // contains no real `await`, so two of them run to completion in order whether
  // or not the queue exists: a check written that way passes with the queue
  // deleted. Removing the queue makes *this* one fail, which was verified by
  // doing it.
  console.log("\n--- mutations queue behind each other ---");
  {
    const order: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name}:end`);
      return name;
    };

    // The first one takes longer, so without a queue the second would finish
    // first and its start would land between the first's start and end.
    await Promise.all([serialised(slow("a", 20)), serialised(slow("b", 1))]);
    equal("the second waits for the first", order, ["a:start", "a:end", "b:start", "b:end"]);

    // A failure must not poison the queue: the next call still runs.
    const failed: string[] = [];
    await Promise.allSettled([
      serialised(async () => {
        failed.push("boom");
        throw new Error("boom");
      }),
      serialised(async () => {
        failed.push("after");
      }),
    ]);
    equal("a failed call does not block the ones behind it", failed, ["boom", "after"]);
  }

  console.log("\n--- two calls, two undo steps ---");
  {
    const session = open();
    const sink = { changed: 0 };
    const before = session.history.undoStack.length;

    await Promise.all([
      callTool(
        "fill_region",
        { minX: 0, minY: 0, minZ: 0, maxX: 7, maxY: 0, maxZ: 7, block: "minecraft:stone" },
        options(sink),
      ),
      callTool(
        "fill_region",
        { minX: 0, minY: 1, minZ: 0, maxX: 7, maxY: 1, maxZ: 7, block: "minecraft:oak_planks" },
        options(sink),
      ),
    ]);

    equal("both fills landed", countBlocks(session.doc), 128);
    equal("...as two separate undo steps", session.history.undoStack.length - before, 2);
    equal(
      "...and neither overwrote the other",
      getBlock(session.doc, 3, 1, 3).namespacedName,
      "minecraft:oak_planks",
    );

    undoEdit(session);
    equal("undoing one leaves the other", countBlocks(session.doc), 64);
  }

  // --- replacing the open document -----------------------------------------
  //
  // Refused rather than asked about: a background agent must not be able to put
  // a modal on somebody's screen, and certainly not to answer its own question
  // about throwing away their work.
  console.log("\n--- unsaved work is not the model's to discard ---");
  {
    const clean = mayReplaceDocument(false, "house.schem", false);
    check("a saved document may be replaced", clean.ok);

    const dirty = mayReplaceDocument(true, "house.schem", false);
    check("...an unsaved one may not", !dirty.ok);
    check(
      "...and the refusal names the file and the way forward",
      !dirty.ok && dirty.refused.includes("house.schem") && dirty.refused.includes("discardUnsavedChanges"),
      dirty.ok ? "" : dirty.refused,
    );

    const forced = mayReplaceDocument(true, "house.schem", true);
    check("...unless the user said to", forced.ok);

    const unnamed = mayReplaceDocument(true, null, false);
    check(
      "a document with no name still gets a sentence",
      !unnamed.ok && unnamed.refused.trim() !== "",
      unnamed.ok ? "" : unnamed.refused,
    );
  }

  // --- the verbs that own their own transaction ----------------------------
  //
  // The third table's defining property. `pasteSelection` and its neighbours
  // call `runTransaction` themselves, so `callTool` must not wrap them again:
  // nested, the inner one pushes onto the undo stack and the outer records
  // nothing, so the label a user reads is the wrong one and the rollback
  // belongs to the wrong scope. One step in, one step back out.
  console.log("\n--- copy, paste and undo ---");
  {
    const session = open();
    const sink = { changed: 0 };
    await callTool(
      "fill_region",
      { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 1, block: "minecraft:stone" },
      options(sink),
    );
    const afterFill = session.history.undoStack.length;

    const copied = (await callTool(
      "copy_region",
      { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 1 },
      options(sink),
    )).result as { width: number };
    equal("copying took the region", copied.width, 2);
    equal("...and left the undo stack alone", session.history.undoStack.length, afterFill);
    // The clipboard is not the document, so the viewport has nothing to redraw
    // -- which is why `changesDocument` is a separate question from `readOnly`.
    equal("...and told the window nothing", sink.changed, 1);

    await callTool("paste_clipboard", { x: 4, y: 0, z: 4 }, options(sink));
    equal("pasting landed", countBlocks(session.doc), 8);
    equal("...as exactly one more step", session.history.undoStack.length - afterFill, 1);
    equal("...and the window was told", sink.changed, 2);

    const undone = (await callTool("undo", {}, options(sink))).result as { undone: string | null };
    check("undo names what it took back", typeof undone.undone === "string", JSON.stringify(undone));
    equal("...and one undo was enough", countBlocks(session.doc), 4);

    await callTool("redo", {}, options(sink));
    equal("redo puts it back", countBlocks(session.doc), 8);

    /*
     * "Pasting with an empty clipboard is refused" is deliberately not checked
     * here, and the reason is worth writing down rather than leaving as a gap:
     * the clipboard is module-level state in `session.ts` with no exported way
     * to clear it, so by this point in the file it is never empty. A check that
     * cannot fail is worse than no check, so this is a note instead of one.
     */
    equal("an unknown document tool is not found", findDocumentTool("no_such_tool"), null);
  }

  // --- the guards actually stop things -------------------------------------
  //
  // The section above checks that a refusal says the right words. This one
  // checks that nothing happened: a guard that returns a polite sentence and
  // then opens the file anyway would pass every check up there.
  console.log("\n--- refusing means not doing ---");
  {
    open();
    const log: string[] = [];
    const dirty = fakeLifecycle({ log, isDirty: () => true });
    const sink = { changed: 0 };

    let raised: string | null = null;
    try {
      await callTool("open_document", { path: "C:/builds/other.schem" }, options(sink, dirty));
    } catch (err) {
      raised = err instanceof Error ? err.message : String(err);
    }
    check("opening over unsaved work is refused", raised !== null, String(raised));
    equal("...and nothing was opened", log, []);

    // With the flag, the same call goes through -- and the window is told,
    // because what is open has changed.
    await callTool(
      "open_document",
      { path: "C:/builds/other.schem", discardUnsavedChanges: true },
      options(sink, dirty),
    );
    equal("...until the user says to discard", log, [
      `open:${path.resolve("C:/builds/other.schem")}`,
      "announce",
    ]);
  }

  console.log("\n--- deleting, end to end ---");
  {
    open();
    const log: string[] = [];
    const sink = { changed: 0 };

    let raised: string | null = null;
    try {
      await callTool(
        "delete_document",
        { path: "C:/builds/old.schem" },
        options(sink, fakeLifecycle({ log })),
      );
    } catch (err) {
      raised = err instanceof Error ? err.message : String(err);
    }
    check("with the flag off it is refused", raised !== null, String(raised));
    equal("...and nothing was trashed", log, []);

    const allowed = fakeLifecycle({ log, allowDelete: async () => true });
    await callTool("delete_document", { path: "C:/builds/old.schem" }, options(sink, allowed));
    equal("...with the flag on it goes to the trash", log, [
      `trash:${path.resolve("C:/builds/old.schem")}`,
    ]);

    // The file that is open is refused even with the flag on: the app must not
    // be left editing something that no longer exists.
    log.length = 0;
    const session = currentSession();
    if (session !== null) session.doc.filePath = path.resolve("C:/builds/open.schem");
    let onOpen: string | null = null;
    try {
      await callTool("delete_document", { path: "C:/builds/open.schem" }, options(sink, allowed));
    } catch (err) {
      onOpen = err instanceof Error ? err.message : String(err);
    }
    check("the open schematic is never deleted", onOpen !== null, String(onOpen));
    equal("...and was not trashed", log, []);
  }

  console.log("\n--- the file-level verbs ---");
  {
    open();
    const sink = { changed: 0 };

    const info = (await callTool("get_document", {}, options(sink))).result as {
      open: boolean;
      width: number;
    };
    check("get_document describes what is open", info.open && info.width === 8, JSON.stringify(info));

    // And answers rather than failing when nothing is: a client that has just
    // connected has no other way to find out.
    closeDocument();
    const empty = (await callTool("get_document", {}, options(sink))).result as { open: boolean };
    equal("...and says so when nothing is open", empty.open, false);

    // A document that has never been saved has nowhere to go, and the refusal
    // has to name the tool that does.
    open();
    let raised: string | null = null;
    try {
      await callTool("save_document", {}, options(sink));
    } catch (err) {
      raised = err instanceof Error ? err.message : String(err);
    }
    check(
      "saving an unsaved document points at save_document_as",
      raised !== null && raised.includes("save_document_as"),
      String(raised),
    );

    // A block tool with nothing open is a refusal, not a crash -- and it names
    // the way forward.
    closeDocument();
    let noDoc: string | null = null;
    try {
      await callTool("get_palette", {}, options(sink));
    } catch (err) {
      noDoc = err instanceof Error ? err.message : String(err);
    }
    check(
      "a block tool with nothing open says what to do",
      noDoc !== null && noDoc.includes("open_document"),
      String(noDoc),
    );

    equal("an unknown lifecycle tool is not found", findLifecycle("no_such_tool"), null);

    /*
     * A picture, and the case where there is not one.
     *
     * The process outlives its window on macOS, so "no window to photograph" is
     * a state that really happens -- and a model handed a blank image would
     * describe the blank image. It gets a sentence instead.
     */
    open();
    let noWindow: string | null = null;
    try {
      await callTool("capture_viewport", {}, options(sink));
    } catch (err) {
      noWindow = err instanceof Error ? err.message : String(err);
    }
    check(
      "capturing with no window says so",
      noWindow !== null && noWindow.includes("window"),
      String(noWindow),
    );

    const shot = (await callTool(
      "capture_viewport",
      {},
      options(sink, fakeLifecycle({ capture: async () => ({ data: "iVBOR", width: 1024, height: 640 }) })),
    )).result as { data: string; width: number };
    equal("...and otherwise hands back the image", shot.width, 1024);
    // Read-only: photographing the window is not an edit, so nothing queues and
    // the viewport has nothing to redraw.
    equal("...without touching the undo stack", currentSession()?.history.undoStack.length ?? -1, 0);

    /*
     * Going back to a version that is not there.
     *
     * A restore that silently did nothing would be the worst answer available:
     * the model would carry on believing the schematic is in a state it never
     * reached. It is refused by name, and pointed at the tool that lists them.
     */
    const log: string[] = [];
    const host = fakeLifecycle({ log });
    let gone: string | null = null;
    try {
      await callTool("restore_version", { id: "nope" }, options(sink, host));
    } catch (err) {
      gone = err instanceof Error ? err.message : String(err);
    }
    check(
      "restoring a version that is gone is refused",
      gone !== null && gone.includes("list_versions"),
      String(gone),
    );

    await callTool("restore_version", { id: "v1" }, options(sink, host));
    /*
     * The whole sequence, which says two things rather than one: the failed
     * restore above *did* go looking -- it has to, to find out the id is gone --
     * and it did **not** announce, so the window was never told about a document
     * that did not change.
     */
    equal("...and a real one restores and tells the window", log, [
      "restore:nope",
      "restore:v1",
      "announce",
    ]);

    // Generation spends the *user's* API budget, not the calling model's, so an
    // empty prompt is refused rather than sent.
    let blank: string | null = null;
    try {
      await callTool("generate_schematic", { prompt: "   " }, options(sink, host));
    } catch (err) {
      blank = err instanceof Error ? err.message : String(err);
    }
    check("an empty generation prompt is refused", blank !== null, String(blank));
    equal("...and nothing was generated", log.filter((entry) => entry.startsWith("generate:")), []);
  }

  // --- the root ------------------------------------------------------------
  console.log("\n--- the write root ---");
  {
    const root = path.join(workDir, "builds");

    const inside = withinRoot(root, path.join(root, "castle.schem"));
    check("a file in the root is allowed", inside.ok);

    const climbing = withinRoot(root, path.join(root, "..", "..", "secrets.txt"));
    check("`..` cannot climb out", !climbing.ok);
    check(
      "...and the refusal says where the root is",
      !climbing.ok && climbing.refused.includes(path.resolve(root)),
      climbing.ok ? "" : climbing.refused,
    );

    const empty = withinRoot(root, "   ");
    check("an empty path is refused rather than resolved to the root", !empty.ok);

    // The classic prefix bug: `/build` must not be judged to contain
    // `/build-backup`. A `startsWith` without the separator gets this wrong,
    // and gets it wrong in the permissive direction.
    check(
      "a sibling with a shared prefix is outside",
      !isInside(path.join(workDir, "build"), path.join(workDir, "build-backup", "x.schem")),
    );
    check("the root contains itself", isInside(root, root));
    check("a path is itself", samePath(path.join(root, "a.schem"), path.join(root, ".", "a.schem")));
  }

  // --- deleting ------------------------------------------------------------
  //
  // Three questions, not one, and the default answer to the first is no.
  console.log("\n--- deleting is off until it is not ---");
  {
    const root = path.join(workDir, "builds");
    const victim = path.join(root, "old.schem");
    await mkdir(root, { recursive: true });
    await writeFile(victim, "not really a schematic", "utf8");

    const off = mayDelete({ allowDelete: false, root, openFilePath: null }, victim);
    check("with the flag off, nothing is deleted", !off.ok);
    check(
      "...and the refusal says where to turn it on",
      !off.ok && off.refused.includes("Settings"),
      off.ok ? "" : off.refused,
    );

    const outside = mayDelete(
      { allowDelete: true, root, openFilePath: null },
      path.join(workDir, "elsewhere.schem"),
    );
    check("with the flag on, outside the root is still refused", !outside.ok);

    const isOpen = mayDelete({ allowDelete: true, root, openFilePath: victim }, victim);
    check("the open document cannot be deleted under the app", !isOpen.ok);

    const allowed = mayDelete({ allowDelete: true, root, openFilePath: null }, victim);
    check("otherwise it is allowed", allowed.ok);
    equal("...and resolves to the real path", allowed.ok ? allowed.value : null, path.resolve(victim));
  }

  // --- who may talk to the server ------------------------------------------
  //
  // DNS rebinding is the attack: a page on the open web resolves a name it
  // controls to 127.0.0.1 and talks to whatever is listening. Binding to
  // loopback does not stop it, because the browser really is on loopback.
  console.log("\n--- Host and Origin ---");
  {
    check("our own host is served", acceptsRequest({ host: "127.0.0.1:4571" }, 4571).ok);
    check("...and localhost by name", acceptsRequest({ host: "localhost:4571" }, 4571).ok);
    check("a host on another port is not", !acceptsRequest({ host: "127.0.0.1:9999" }, 4571).ok);
    check(
      "a rebound name is not",
      !acceptsRequest({ host: "evil.example.com:4571" }, 4571).ok,
    );
    check(
      "a page on the web is not",
      !acceptsRequest({ host: "127.0.0.1:4571", origin: "https://evil.example.com" }, 4571).ok,
    );
    // A command-line client sends no Origin at all, and that is the normal case
    // here -- so absence has to be allowed, which is what makes refusing every
    // *present* foreign value the meaningful rule.
    check(
      "a client with no Origin is served",
      acceptsRequest({ host: "127.0.0.1:4571" }, 4571).ok,
    );
    check(
      "a local page is served",
      acceptsRequest({ host: "127.0.0.1:4571", origin: "http://localhost:5173" }, 4571).ok,
    );
    check("garbage in Origin is refused rather than parsed", !acceptsRequest({ host: "127.0.0.1:4571", origin: "not a url" }, 4571).ok);
  }

  // --- the stdio bridge, actually spawned ----------------------------------
  //
  // The one part of this feature that cannot be checked by reading it: the
  // bridge is a separate process, run by whatever `node` the user's client has,
  // talking newline-framed JSON-RPC on one side and HTTP on the other. Every
  // way it can be wrong is a framing bug, and framing bugs are invisible until
  // something is at the other end.
  //
  // No Electron involved: the discovery file it reads is found through APPDATA
  // (or XDG_CONFIG_HOME), which a spawned process can be given.
  console.log("\n--- the stdio bridge ---");
  {
    const seen: unknown[] = [];
    const stub = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method?: string };
        seen.push({ method: message.method, auth: request.headers.authorization });
        // A notification has no id and is answered 202 with no body -- which the
        // bridge must not forward, or the client gets a parse error.
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        response.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "session-1",
        });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }));
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", () => resolve()));
    const port = (stub.address() as { port: number }).port;

    // The bridge looks for `mcp.json` under the platform's config directory,
    // and both of the ones it consults come from the environment.
    const fakeUserData = path.join(workDir, "userdata", "buildergpt");
    await mkdir(fakeUserData, { recursive: true });
    await writeFile(
      path.join(fakeUserData, "mcp.json"),
      JSON.stringify({ version: 1, url: `http://127.0.0.1:${port}/mcp`, token: "t0ken", pid: 1 }),
      "utf8",
    );
    const home = path.join(workDir, "userdata");

    const bridge = spawn(process.execPath, [path.resolve("resources/mcp-bridge.mjs")], {
      env: { ...process.env, APPDATA: home, XDG_CONFIG_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines: string[] = [];
    let buffered = "";
    bridge.stdout.setEncoding("utf8");
    bridge.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let at: number;
      while ((at = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, at).trim();
        buffered = buffered.slice(at + 1);
        if (line !== "") lines.push(line);
      }
    });
    let stderr = "";
    bridge.stderr.setEncoding("utf8");
    bridge.stderr.on("data", (chunk: string) => (stderr += chunk));

    const waitForLines = async (count: number): Promise<void> => {
      for (let tries = 0; tries < 100 && lines.length < count; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    await waitForLines(1);
    check("the bridge answered", lines.length === 1, `${lines.join(" | ")} ${stderr}`);
    equal("...with the reply the server gave", JSON.parse(lines[0] ?? "{}"), {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    equal("...having sent the token from the discovery file", seen[0], {
      method: "initialize",
      auth: "Bearer t0ken",
    });

    // A notification: answered 202 with no body, and the bridge must stay
    // quiet. Forwarding an empty line would be a parse error at the client.
    bridge.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await waitForLines(2);
    equal("a notification produces no line", lines.length, 2);
    equal("...and the next request still answers", JSON.parse(lines[1] ?? "{}").id, 2);

    bridge.kill();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }

  // --- the token survives a restart ----------------------------------------
  //
  // It used to live in a module variable and nowhere else, so every launch
  // minted a fresh one and silently invalidated whatever the user had already
  // pasted into their client. That reads as "the integration stopped working",
  // which is a long way from "the token changed".
  console.log("\n--- the token is kept until somebody asks ---");
  {
    equal("a stored token is used again", chooseToken("keep-me", false, "brand-new"), "keep-me");
    equal("...and only replaced when asked", chooseToken("keep-me", true, "brand-new"), "brand-new");
    equal("a first run makes one", chooseToken(null, false, "brand-new"), "brand-new");
    // A settings file edited by hand into `""` heals rather than serving an
    // empty bearer token, which would authorise everyone.
    equal("an empty string is not a token", chooseToken("", false, "brand-new"), "brand-new");
    equal("...nor is whitespace", chooseToken("   ", false, "brand-new"), "brand-new");
    // Stored tokens are trimmed on the way out, so a stray newline from a
    // hand-edited file cannot make the header not match.
    equal("a stored token is trimmed", chooseToken(" keep-me\n", false, "brand-new"), "keep-me");
  }

  // --- the command the settings pane offers --------------------------------
  //
  // The one string in this feature that has to be exactly right: a wrong flag
  // produces a client that cannot connect and an error about neither.
  console.log("\n--- the connect command ---");
  {
    const command = connectCommand("http://127.0.0.1:4571/mcp", "s3cret");
    check("names the transport", command.includes("--transport http"), command);
    check("carries the url", command.includes("http://127.0.0.1:4571/mcp"), command);
    check("carries the token as a bearer header", command.includes('Authorization: Bearer s3cret'), command);
  }
} finally {
  closeDocument();
  await rm(workDir, { recursive: true, force: true });
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
