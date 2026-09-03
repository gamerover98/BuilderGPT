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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { createServer } from "http";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

import { TOOL_SPECS, buildTools, type ToolContext } from "../src/main/agent/tools.js";
import {
  callTool,
  describeTools,
  findTool,
  isReadOnly,
  serialised,
} from "../src/main/mcp/tools.js";
import { LIFECYCLE_SPECS, findLifecycle, type Lifecycle } from "../src/main/mcp/lifecycle.js";
import { DOCUMENT_SPECS, findDocumentTool } from "../src/main/mcp/document_tools.js";
import {
  acceptsRequest,
  chooseToken,
  connectCommand,
  isInside,
  mayDelete,
  mayReplaceDocument,
  routeRequest,
  servingChanged,
  samePath,
  startupRefusal,
  withinRoot,
} from "../src/main/mcp/policy.js";
import { countBlocks, getBlock } from "../src/main/domain/document.js";
import {
  MC_VERSION_NAMES,
  dataVersionOf,
} from "../src/shared/mc_versions.js";

/*
 * An absolute path, spelled the way the platform running this spells one.
 *
 * These fixtures used to say `C:/builds/x.schem`, which is absolute on Windows
 * and **relative everywhere else** -- there is no drive letter on Linux, so
 * `withinRoot` resolved it *under* the root and the path doubled:
 * `.../C:/builds/C:/builds/x.schem`. That is `path.resolve(root, candidate)`
 * doing exactly the right thing with a string that is only a path on one
 * operating system, so the fixture is what was wrong and not the rule.
 *
 * Worth knowing because of how it failed. Two of the three checks reported a
 * doubled path and read as a normalisation bug; the third reported that a file
 * had been trashed when the run expected nothing at all -- the "you may not
 * delete the open document" guard comparing `.../open.schem` against
 * `.../C:/builds/open.schem`, finding them different, and standing aside. A
 * guard that silently stops guarding is the failure this suite exists to catch,
 * and here it was the test's own doing.
 */
const abs = (...parts: string[]): string => path.resolve("/", ...parts);
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

/** The vendored flattening table, for the tools that read it. */
const LEGACY_BLOCKS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "resources",
  "legacy_blocks.json",
);

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
    /*
     * Honoured rather than ignored, because what is under test is that the
     * name reaching here is already canonical: `create_document` resolves a
     * label before calling, so a fake that dropped the argument would let the
     * whole fix be deleted with every check still green.
     */
    create: async (size, format, version) => {
      log.push(`create:${format}:${version}`);
      closeDocument();
      newDocument(size, format, dataVersionOf(version));
      const session = currentSession();
      if (session === null) throw new Error("newDocument left nothing open");
      return session;
    },
    save: async (_session, options) => {
      log.push(`save:${options.filePath ?? "(same)"}`);
      return {
        filePath: options.filePath ?? abs("builds", "x.schem"),
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
    recents: async () => [{ filePath: abs("builds", "a.schem"), openedAt: 1 }],
    trash: async (filePath) => {
      log.push(`trash:${filePath}`);
    },
    root: async () => abs("builds"),
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
    // Without this `describe_block` cannot answer what a block was before the
    // Flattening, and `convert_schematic` cannot write MCEdit at all -- which
    // is the gap this field was added to close.
    legacyBlocksPath: LEGACY_BLOCKS,
    onChanged: (_session: DocumentSession) => {
      sink.changed += 1;
    },
  };
}

/**
 * A call whose failure is a value rather than the end of the suite.
 *
 * Every check below is about a call that is *supposed* to work, so a bare
 * `await` would abort the run on the first regression and hide everything
 * after it -- which is the arrangement `check.sh` deliberately avoids. The
 * error message comes back as the result instead, and the equality check that
 * was going to name the fault still names it.
 */
async function attempt(
  tool: string,
  args: unknown,
  opts: Parameters<typeof callTool>[2],
): Promise<Record<string, unknown>> {
  try {
    return ((await callTool(tool, args, opts)).result ?? {}) as Record<string, unknown>;
  } catch (err) {
    return { refused: err instanceof Error ? err.message : String(err) };
  }
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

    /*
     * There is no `generate_schematic`, and that is the check.
     *
     * It asked the model the *user* configured in this app to build the
     * schematic -- a second model on a second budget, doing what the model
     * driving the connection was already doing with `run_build_script`. This
     * server's whole stated value is what a harness cannot do for itself, and
     * calling an LLM is exactly what it can.
     *
     * It also made the app's provider key a precondition for a connection that
     * has nothing to do with it, so a missing key came back as the gateway's
     * `Invalid API key.` -- reported twice as an MCP authentication failure
     * before anyone doubted the tool.
     */
    check(
      "no tool asks the app's own model to do the work",
      !describeTools().some((tool) => tool.name === "generate_schematic"),
      "generate_schematic is back on the wire",
    );
    // The one that replaces it, and needs no key from anybody.
    check(
      "...and the block tools are what a model builds with",
      describeTools().some((tool) => tool.name === "run_build_script"),
    );

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
  // Writing the default states onto `from` would quietly change which blocks a
  // replacement finds: "take out the campfires" would take out the ones that
  // happen to face north and be alight, and report a healthy count for those.
  //
  // This comment used to add that `Recorder.replace` matched on an exact
  // palette index, "which is what `replace_blocks`' own description already
  // says". Both were true and both were the bug: a name on its own then matched
  // only an entry carrying no properties at all, so on a legacy schematic --
  // where nearly every entry carries states -- no replace ever matched
  // anything. A bare name is a pattern over every state now, which is what the
  // `toEntry` choice was always for.
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
      await callTool("open_document", { path: abs("builds", "other.schem") }, options(sink, dirty));
    } catch (err) {
      raised = err instanceof Error ? err.message : String(err);
    }
    check("opening over unsaved work is refused", raised !== null, String(raised));
    equal("...and nothing was opened", log, []);

    // With the flag, the same call goes through -- and the window is told,
    // because what is open has changed.
    await callTool(
      "open_document",
      { path: abs("builds", "other.schem"), discardUnsavedChanges: true },
      options(sink, dirty),
    );
    equal("...until the user says to discard", log, [
      `open:${abs("builds", "other.schem")}`,
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
        { path: abs("builds", "old.schem") },
        options(sink, fakeLifecycle({ log })),
      );
    } catch (err) {
      raised = err instanceof Error ? err.message : String(err);
    }
    check("with the flag off it is refused", raised !== null, String(raised));
    equal("...and nothing was trashed", log, []);

    const allowed = fakeLifecycle({ log, allowDelete: async () => true });
    await callTool("delete_document", { path: abs("builds", "old.schem") }, options(sink, allowed));
    equal("...with the flag on it goes to the trash", log, [
      `trash:${abs("builds", "old.schem")}`,
    ]);

    // The file that is open is refused even with the flag on: the app must not
    // be left editing something that no longer exists.
    log.length = 0;
    const session = currentSession();
    if (session !== null) session.doc.filePath = abs("builds", "open.schem");
    let onOpen: string | null = null;
    try {
      await callTool("delete_document", { path: abs("builds", "open.schem") }, options(sink, allowed));
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

  }

  // --- the version is the client's to choose -------------------------------
  //
  // The report this section came from: asked for a 26.2 schematic, an MCP client
  // produced a 1.20.4 one every time. Four separate faults arrived at that, and
  // the first is the one below -- `create_document` took any string at all,
  // `dataVersionOf` failed open on it, and the document was created carrying no
  // version tag with nothing raised anywhere.
  console.log("\n--- the version a client asks for is the version it gets ---");
  {
    const sink = { changed: 0 };
    const log: string[] = [];
    const host = fakeLifecycle({ log });

    /*
     * The label, which is what a model actually sends. `26.2` is how the request
     * arrives -- nobody asks for `JE_26_2` -- and it used to resolve to nothing,
     * silently, because that is also what 1.8.8's genuine absence of a
     * DataVersion looks like from inside `dataVersionOf`.
     */
    const made = await attempt(
      "create_document",
      { width: 4, height: 4, length: 4, format: "sponge3", version: "26.2" },
      options(sink, host),
    );
    equal(
      "a version asked for by label reaches the host canonically",
      log.filter((entry) => entry.startsWith("create:")),
      ["create:sponge3:JE_26_2"],
    );
    equal("...and the document carries its DataVersion", made.dataVersion, dataVersionOf("JE_26_2"));
    /*
     * Reported back as well, because a client that cannot read what it got has
     * no way to notice the thing that was reported.
     */
    equal("...and the answer says which version that is", made.version, "JE_26_2");

    // The canonical name still works, and must: it is what settings round-trip
    // and what every other table is keyed on.
    await attempt(
      "create_document",
      { width: 4, height: 4, length: 4, version: "JE_1_21_4" },
      options(sink, host),
    );
    equal(
      "...and so does the canonical name",
      log.filter((entry) => entry.startsWith("create:")).slice(-1),
      ["create:sponge3:JE_1_21_4"],
    );

    /*
     * And the fault itself, from the other side. This is the check that fails
     * with the guard deleted: before it, an unrecognised string produced a
     * document rather than a refusal.
     */
    let unknown: string | null = null;
    const before = log.length;
    try {
      await callTool(
        "create_document",
        { width: 4, height: 4, length: 4, version: "banana" },
        options(sink, host),
      );
    } catch (err) {
      unknown = err instanceof Error ? err.message : String(err);
    }
    check("a version this build does not know is refused by name", unknown !== null, String(unknown));
    check(
      "...and the refusal repeats what was asked for",
      (unknown ?? "").includes("banana"),
      unknown ?? "(none)",
    );
    equal("...and no document was created", log.length, before);

    /*
     * Required, not defaulted. The container and the version are not
     * independent -- `NewDocumentRequest.version` has been required on IPC for
     * exactly that reason -- and an optional one here is what produced a
     * schematic with no version at all.
     */
    const spec = findLifecycle("create_document");
    const required = ((spec?.schema ?? {}) as { required?: string[] }).required ?? [];
    check("create_document requires a version", required.includes("version"), required.join(","));

    /*
     * The verb that did not exist. `setDocumentVersion` was IPC-only, so a
     * client that guessed wrong, or opened a file carrying no tag, had no way
     * back at all.
     */
    const changer = findDocumentTool("set_document_version");
    check("an open schematic's version can be changed", changer !== null);
    check(
      "...and the window is told, because the document moved",
      changer?.changesDocument === true,
    );

    {
      const session = open();
      const raised: string[] = [];
      try {
        await callTool("set_document_version", { version: "nope" }, options(sink, host));
      } catch (err) {
        raised.push(err instanceof Error ? err.message : String(err));
      }
      check(
        "...and it refuses a version this build does not know",
        raised.length === 1,
        raised.join(" "),
      );
      equal(
        "...without touching the document",
        session.history.undoStack.length,
        0,
      );

      const moved = await attempt(
        "set_document_version",
        { version: "1.16.5" },
        options(sink, host),
      );
      equal("a label works here too", moved.version, "JE_1_16_5");
      equal(
        "...and it is one undo step, so the version comes back with the blocks",
        session.history.undoStack.length,
        1,
      );
      equal("...and the document says so", session.doc.dataVersion, dataVersionOf("JE_1_16_5"));
    }

  }

  // --- nothing on the wire repeats a vendored fact -------------------------
  //
  // The check that makes the next Minecraft release free.
  //
  // The fault underneath the report was a hand-typed `JE_1_20_4` going stale: it
  // was the only spelling a model could see, in a schema that offered no `enum`
  // at all. Writing out fifty names and a sentence saying "39 versions" would
  // have been that same mistake four tools wide, so every version fact on the
  // wire is read from the table -- and this is what says so.
  console.log("\n--- the schemas quote the table, never a copy of it ---");
  {
    const descriptions: { tool: string; text: string }[] = [];
    const enums: { tool: string; values: readonly unknown[] }[] = [];

    const walk = (tool: string, node: unknown, key: string | null): void => {
      if (Array.isArray(node)) return;
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (typeof record.description === "string") {
        descriptions.push({ tool, text: record.description });
      }
      if (key === "version" && Array.isArray(record.enum)) {
        enums.push({ tool, values: record.enum });
      }
      for (const [name, value] of Object.entries(record)) {
        if (name === "enum") continue;
        walk(tool, value, name);
      }
    };
    for (const tool of describeTools()) {
      descriptions.push({ tool: tool.name, text: tool.description });
      walk(tool.name, tool.inputSchema, null);
    }

    /*
     * Every `version` enum is the table itself. Deep equality rather than a
     * length or a spot check: a list copied today and edited tomorrow is exactly
     * the failure being prevented.
     */
    const copied = enums.filter(
      (found) => found.values.join("\u0000") !== MC_VERSION_NAMES.join("\u0000"),
    );
    equal("every version enum is the version table", copied.map((f) => f.tool), []);
    /*
     * ...and there are the four there should be. Without this the walk is
     * satisfied by finding none, which is what deleting an enum would leave.
     *
     * It was five. `generate_schematic` carried one too, and went with the
     * tool -- listed here rather than counted, so removing another one names
     * which.
     */
    equal(
      "...on every tool that names a version",
      enums.map((found) => found.tool).sort(),
      [
        "convert_schematic",
        "create_document",
        "save_document_as",
        "set_document_version",
      ],
    );

    /*
     * And no prose names a version except the newest, which is the one place a
     * derived example can legitimately land. A literal `JE_1_20_4` typed into a
     * description -- which is what shipped -- fails here by naming its tool.
     */
    const stale: string[] = [];
    for (const { tool, text } of descriptions) {
      for (const found of text.match(/JE_[A-Za-z0-9_]+/g) ?? []) {
        if (found !== MC_VERSION_NAMES[0]) stale.push(`${tool}: ${found}`);
      }
    }
    equal("no schema spells out a version but the newest", stale, []);
  }

  // --- one session per client, and a reload is a new one ---------------------
  //
  // The report: with Antigravity connected, pressing Reload answered
  // `Session not found` and the server had to be switched off and on again.
  //
  // The server held **one** `StreamableHTTPServerTransport` for its whole life,
  // and the SDK's stateful mode is one per session: a second `initialize` on an
  // initialised transport is refused outright, and any other session id comes
  // back 404. So a reload could not get back in, and a second client could never
  // connect at all.
  //
  // The decision is `routeRequest` because `server.ts` imports `electron` and
  // `node:http` and cannot be loaded here -- `selection_drag.ts`'s arrangement,
  // for `selection_drag.ts`'s reason.
  console.log("\n--- routing a request to a session ---");
  {
    equal(
      "a session this server holds is answered by it",
      routeRequest({ sessionId: "s1", known: true, isInitialize: false }).kind,
      "existing",
    );
    /*
     * An `initialize` with no id opens one. This is the reload: the client has
     * thrown its session away and is starting again, and before this it met a
     * transport that had already been initialised and refused.
     */
    equal(
      "an initialize with no session opens one",
      routeRequest({ sessionId: null, known: false, isInitialize: true }).kind,
      "new",
    );
    /*
     * ...and it must keep opening one. Two clients, or one client twice, are
     * the same request twice, and the shared transport could serve it once.
     */
    equal(
      "...and a second one opens another",
      routeRequest({ sessionId: null, known: false, isInitialize: true }).kind,
      "new",
    );

    /*
     * A session id this server never issued -- held across a restart, say. 404
     * rather than a fresh session under the same id: handing back a different
     * session would look like success and behave like amnesia.
     */
    const stale = routeRequest({ sessionId: "gone", known: false, isInitialize: false });
    equal("a session this server forgot is refused", stale.kind, "refused");
    check(
      "...with 404, and naming the id",
      stale.kind === "refused" && stale.status === 404 && stale.refused.includes("gone"),
      stale.kind === "refused" ? stale.refused : stale.kind,
    );
    /*
     * Even an initialize carrying an unknown id: the client is confused about
     * which session it has, and inventing one for it hides that.
     */
    equal(
      "...even when it is an initialize",
      routeRequest({ sessionId: "gone", known: false, isInitialize: true }).kind,
      "refused",
    );

    /*
     * No id and not an initialize. Refused rather than opened, or every
     * malformed POST would leave a transport and a `Server` behind that nothing
     * ever closes -- which is a leak reachable by anything that can reach the
     * port.
     */
    const nothing = routeRequest({ sessionId: null, known: false, isInitialize: false });
    equal("a request that is neither is refused", nothing.kind, "refused");
    check(
      "...with 400, and says what to send",
      nothing.kind === "refused" && nothing.status === 400 && nothing.refused.includes("initialize"),
      nothing.kind === "refused" ? nothing.refused : nothing.kind,
    );
  }

  // --- the two things the harness cannot watch, checked in the source --------
  //
  // `server.ts` cannot be imported here, and both of these are single calls
  // whose absence is invisible from every angle except the one that matters.
  console.log("\n--- what server.ts must not stop doing ---");
  {
    const source = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main", "mcp", "server.ts"),
      "utf8",
    );

    /*
     * The hang. `server.close()` stops new connections and waits for the open
     * ones to finish; it does not finish them. An MCP client holds a keep-alive
     * connection, so the callback never came -- and `regenerateMcpToken` and the
     * Enabled checkbox both await this. That is why Regenerate did nothing
     * until the app was restarted: the token had already been written.
     */
    check(
      "stopping the server closes the connections it is waiting on",
      source.includes("closeAllConnections()"),
      "server.close() alone never resolves while a client is attached",
    );

    /*
     * And the shape that made a reload impossible. A single module-level
     * transport is the thing being prevented; a map keyed by session is what
     * replaced it.
     */
    check(
      "there is a transport per session, not one for the server",
      /const transports = new Map</.test(source),
      "a single shared transport can only ever hold one session",
    );
  }

  // --- a setting that only reaches the disk is not applied -------------------
  //
  // `mcpSetEnabled` starts and stops the listener, and for a long time it was
  // the only thing that reached it: the port, the address and whether a token
  // is required were written and then ignored until the next launch.
  //
  // What that cost was reported: turning authentication off and back on left
  // the running server still serving anybody, and the token row -- which keyed
  // on what the server said -- gone with no way to bring it back.
  console.log("\n--- which settings the listener is built from ---");
  {
    const base = { port: 4571, bindAddress: "127.0.0.1", requireAuth: true };
    equal("nothing moved, nothing restarts", servingChanged(base, { ...base }), false);
    check("the port is one it is built from", servingChanged(base, { ...base, port: 4600 }));
    check("...and the address", servingChanged(base, { ...base, bindAddress: "0.0.0.0" }));
    /*
     * The one the report turned on: without this, the checkbox wrote to disk
     * and the socket went on doing what it had been doing.
     */
    check("...and whether a token is required", servingChanged(base, { ...base, requireAuth: false }));
  }
  // --- the address, and the one combination that is refused -----------------
  console.log("\n--- where it listens, and to whom ---");
  {
    /*
     * The `Host` check is the DNS-rebinding defence: a page on the open web
     * resolves a name it controls to this machine and then talks to whatever is
     * listening. Binding to loopback does not stop it -- the browser really is
     * on loopback -- so the header has to be checked, and it stays checked with
     * authentication off. Turning off a token is not a reason to let a web page
     * in.
     */
    check("our own host is still served", acceptsRequest({ host: "127.0.0.1:4571" }, 4571).ok);
    check("a host on another port is still not", !acceptsRequest({ host: "127.0.0.1:9999" }, 4571).ok);

    // Bound to one real address: that address is served, and loopback with it,
    // because a server is always reachable from the machine it runs on.
    check(
      "the address it is bound to is served",
      acceptsRequest({ host: "192.168.1.42:4571" }, 4571, "192.168.1.42").ok,
    );
    check(
      "...and loopback alongside it",
      acceptsRequest({ host: "127.0.0.1:4571" }, 4571, "192.168.1.42").ok,
    );
    check(
      "...but not some other address",
      !acceptsRequest({ host: "10.0.0.9:4571" }, 4571, "192.168.1.42").ok,
    );

    /*
     * Bound to every interface, which address a client arrived on is not
     * knowable -- but a **name** still must not be served, and that is the whole
     * of the rebinding defence: the attack is a domain resolving here, and a
     * domain is a name. An IP literal has nothing to resolve.
     */
    check(
      "on every interface, an address is served",
      acceptsRequest({ host: "192.168.1.42:4571" }, 4571, "0.0.0.0").ok,
    );
    check(
      "...and a name is not, which is the rebinding rule",
      !acceptsRequest({ host: "evil.example.com:4571" }, 4571, "0.0.0.0").ok,
    );
    // The Origin rule is untouched by any of this.
    check(
      "a web page is refused wherever it is bound",
      !acceptsRequest({ host: "192.168.1.42:4571", origin: "https://evil.example.com" }, 4571, "0.0.0.0").ok,
    );

    /*
     * The one combination refused rather than warned about. Each half alone is
     * defensible -- on loopback the token is a convenience rather than the
     * boundary, and off loopback the token *is* the access control -- and
     * together they are an anonymous write endpoint on somebody's files.
     */
    equal(
      "loopback with a token is fine",
      startupRefusal({ requireAuth: true, bindAddress: "127.0.0.1" }),
      null,
    );
    equal(
      "...and loopback without one",
      startupRefusal({ requireAuth: false, bindAddress: "127.0.0.1" }),
      null,
    );
    equal(
      "...and the network with one",
      startupRefusal({ requireAuth: true, bindAddress: "0.0.0.0" }),
      null,
    );
    const both = startupRefusal({ requireAuth: false, bindAddress: "0.0.0.0" });
    check("the network without one is refused", both !== null);
    check(
      "...and the refusal says which of the two to change",
      (both ?? "").includes("token") && (both ?? "").includes("127.0.0.1"),
      both ?? "(none)",
    );
    // The address is checked here too, so a bad one is named before `listen`
    // turns it into an EADDRNOTAVAIL that explains nothing.
    check(
      "a range is refused before the socket exists",
      (startupRefusal({ requireAuth: true, bindAddress: "192.168.1.0/24" }) ?? "").includes("range"),
    );
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
    const fakeUserData = path.join(workDir, "userdata", "schematic-ai-studio");
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


// --- the tools that answer without a schematic open --------------------------
//
// `NO_DOCUMENT` is a different question from `READ_ONLY`, and the two are not
// the same set: `describe_block` is both, and `convert_schematic` is neither --
// it writes a file, so it is not read-only, and it reads no document, so
// refusing it because none is open would be refusing it for a reason that has
// nothing to do with it.
//
// Before this, `describe_block` came back "No schematic is open" for a question
// about Minecraft. Nobody reported it, because a client connected to this app
// usually has one open, which is exactly the kind of wrongness that survives.
console.log("\n--- answering with nothing open ---");
{
  closeDocument();
  const sink = { changed: 0 };

  const described = await callTool(
    "describe_block",
    { blocks: ["minecraft:campfire"] },
    options(sink),
  );
  check("describe_block answers with nothing open", described.result !== undefined);

  /*
   * And a tool that *does* read the document is still refused, in the sentence
   * that says what to do about it. That is the half that fails if somebody adds
   * a name to `NO_DOCUMENT` to make an error go away.
   */
  let refused: string | null = null;
  try {
    await callTool("get_schematic_info", {}, options(sink));
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  check("...while one that reads it is not", refused !== null);
  check(
    "...saying which way forward",
    (refused ?? "").includes("open_document"),
    refused ?? "",
  );

  let converted: string | null = null;
  try {
    await callTool(
      "convert_schematic",
      { source: abs("nowhere", "absent.schem"), target: abs("nowhere", "out.litematic"), format: "litematic" },
      options(sink),
    );
  } catch (err) {
    converted = err instanceof Error ? err.message : String(err);
  }
  check("convert_schematic gets past the document check", converted !== null);
  check(
    "...and fails on the file it was given instead",
    !(converted ?? "").includes("No schematic is open"),
    converted ?? "",
  );

  equal("...and nothing told the window anything", sink.changed, 0);
}
// --- what may be placed here, and it must agree with what places -----------
/*
 * `list_blocks` arrived when `generate_schematic` left. That tool handed the
 * whole job to the app's own model -- the one thing this server is explicitly
 * not for -- and what it was genuinely carrying was the block list, which the
 * app splices into its own prompt and no MCP client could obtain:
 * `describe_block` answers about ids you already have, `get_palette` lists what
 * the schematic already uses, and nothing enumerated.
 */
console.log("\n--- what this schematic may hold ---");
{
  const sink = { changed: 0 };

  /*
   * A set with both eras in it. `ALLOWED` above is four blocks, which is right
   * for the checks it serves and useless here: every question below is about
   * the *difference* between what a legacy document may hold and what a modern
   * one may, and four blocks cannot show a difference.
   *
   * The first eight are in `legacy_blocks.json`, the last four are not --
   * verified against the vendored table rather than assumed.
   */
  const BOTH_ERAS = new Set([
    "minecraft:stone",
    "minecraft:oak_planks",
    "minecraft:oak_stairs",
    "minecraft:cobblestone",
    "minecraft:oak_fence",
    "minecraft:sandstone",
    "minecraft:glass",
    "minecraft:torch",
    "minecraft:deepslate",
    "minecraft:copper_block",
    "minecraft:jungle_hanging_sign",
    "minecraft:campfire",
    "minecraft:air",
  ]);
  const rich = (lifecycle?: Lifecycle) => ({
    ...options(sink, lifecycle),
    allowedBlocks: BOTH_ERAS,
  });

  /*
   * The rule the whole tool stands on: it is `checkBlockAllowed` read
   * backwards. Every name it offers has to be one `set_block` will take, on the
   * *same* document -- a list that disagrees with the verb that places blocks is
   * worse than no list, because it sends a model to build with names that
   * cannot land, confidently.
   *
   * Stated on a **legacy** document, which is the only place the two can come
   * apart: `checkBlockAllowed` asks `legacy_blocks.json` there and nowhere
   * else, so the same check on a flat document would pass with that half
   * deleted.
   */
  {
    closeDocument();
    newDocument({ width: 4, height: 4, length: 4 }, "sponge3", 3953);
    const flat = (await callTool("list_blocks", {}, rich())).result as { total: number };

    closeDocument();
    newDocument({ width: 4, height: 4, length: 4 }, "mcedit", 1343);
    const legacy = (await callTool("list_blocks", {}, rich())).result as {
      blocks: string[];
      total: number;
    };
    check(
      "a legacy schematic is offered fewer blocks than a modern one",
      legacy.total < flat.total,
      `${legacy.total} legacy vs ${flat.total} flat`,
    );
    check(
      "...and the ones 1.12 never had are the ones missing",
      !legacy.blocks.includes("minecraft:deepslate") &&
        !legacy.blocks.includes("minecraft:copper_block"),
      legacy.blocks.join(" "),
    );
    check(
      "...while the ones it did have are there",
      legacy.blocks.includes("minecraft:oak_stairs") && legacy.blocks.includes("minecraft:torch"),
      legacy.blocks.join(" "),
    );

    // And the round trip: every name it offered, placed for real on the
    // document it offered them for.
    const refused: string[] = [];
    for (const block of legacy.blocks) {
      try {
        await callTool("set_block", { x: 0, y: 0, z: 0, block }, rich());
      } catch (err) {
        refused.push(`${block}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    equal("every block it offers is one set_block accepts", refused, []);

    /*
     * ...and the other direction, which is what makes the first one mean
     * something: a name the list left out really is refused. Without this, a
     * `list_blocks` that returned nothing at all would pass the check above.
     */
    let deep: string | null = null;
    try {
      await callTool("set_block", { x: 0, y: 0, z: 0, block: "minecraft:deepslate" }, rich());
    } catch (err) {
      deep = err instanceof Error ? err.message : String(err);
    }
    check("a block it left out is refused by set_block", deep !== null, String(deep));
  }

  /*
   * The namespace is not a filter.
   *
   * `block_search.ts` had this exact bug and it is written up at length: every
   * block is `minecraft:something`, so matching the namespaced id makes every
   * letter of `minecraft:` return the whole set. Letter by letter rather than
   * as one predicate, so a failure names which letter -- the way that check is
   * written, for its reason.
   */
  {
    closeDocument();
    newDocument({ width: 4, height: 4, length: 4 }, "sponge3", 3953);
    const all = (await callTool("list_blocks", {}, rich())).result as { total: number };
    for (const letter of ["m", "i", "n", "e", "c", "r", "a", "f", "t"]) {
      const hit = (await callTool("list_blocks", { contains: letter }, rich())).result as {
        total: number;
      };
      check(
        `${letter} does not match every block`,
        hit.total < all.total,
        `${letter} matched ${hit.total} of ${all.total}`,
      );
    }
    /*
     * ...and pasting the namespace still works, because that is a real thing
     * somebody does. Stripped from the *query*, never matched against the id.
     */
    const pasted = (await callTool("list_blocks", { contains: "minecraft:oak_st" }, rich())).result as {
      blocks: string[];
    };
    check(
      "a query may still carry the namespace",
      pasted.blocks.includes("minecraft:oak_stairs"),
      pasted.blocks.join(" "),
    );

    /*
     * Two numbers, and they are different questions. `ROW_LIMIT`'s rule in the
     * block picker: a limit bounds what comes back, never what was found. A
     * list truncated in silence is how a model concludes a block does not
     * exist.
     */
    const capped = (await callTool("list_blocks", { contains: "o", limit: 2 }, rich())).result as {
      blocks: string[];
      total: number;
      shown: number;
      note?: string;
    };
    equal("the limit bounds the rows", capped.blocks.length, 2);
    equal("...and shown counts them", capped.shown, 2);
    check(
      "...while total counts what matched",
      capped.total > capped.shown,
      `${capped.total} vs ${capped.shown}`,
    );
    check(
      "...and it says the list was cut",
      typeof capped.note === "string",
      capped.note ?? "(none)",
    );

    // Air is a real id and is not a thing anybody builds with -- `get_palette`
    // leaves it out for the same reason.
    const air = (await callTool("list_blocks", { contains: "air" }, rich())).result as {
      blocks: string[];
    };
    check(
      "air is not offered as a building block",
      !air.blocks.includes("minecraft:air"),
      air.blocks.join(" "),
    );
  }
}
// --- the model is told which Minecraft it is working in ---------------------
/*
 * It was not, and nothing in ten tool descriptions said the words legacy,
 * Flattening, 1.12 or DataVersion. `get_schematic_info` reported the container
 * and not the version, so a model driving a 1.12 schematic reached for modern
 * blocks all turn and met the objection at save time, from a writer.
 */
console.log("\n--- the model is told which Minecraft it is working in ---");
{
  const sink = { changed: 0 };

  {
    closeDocument();
    newDocument({ width: 4, height: 4, length: 4 }, "mcedit", 1343);
    const info = (await callTool("get_schematic_info", {}, options(sink))).result as {
      era: string;
      version: string;
      dataVersion: number | null;
      blocks: string;
    };
    equal("a legacy schematic says so", info.era, "legacy");
    equal("...and names the version a person would", info.version, "1.12.2");
    equal("...beside the raw tag, which is what the file carries", info.dataVersion, 1343);
    check(
      "...and says what that costs, in words a model can act on",
      info.blocks.includes("before the Flattening") && info.blocks.includes("refused"),
      info.blocks,
    );
    /*
     * And it says *not* to change how blocks are spelled. That is the obvious
     * wrong inference from "this is 1.12", and this app takes flattened names
     * in both eras.
     */
    check(
      "...while telling it to keep naming blocks the modern way",
      info.blocks.includes("minecraft:oak_fence"),
      info.blocks,
    );
  }

  {
    closeDocument();
    newDocument({ width: 4, height: 4, length: 4 }, "sponge3", 3700);
    const info = (await callTool("get_schematic_info", {}, options(sink))).result as {
      era: string;
      version: string;
    };
    equal("a flat schematic says so too", info.era, "flat");
    equal("...and names its version", info.version, "1.20.4");
  }

  {
    /*
     * `describe_block` answers the era question in the only way it is allowed
     * to.
     *
     * It is in `NO_DOCUMENT` -- answered before any schematic exists, with a
     * `doc` that throws on every read -- so it cannot say whether *this*
     * document can hold a block. It can say what the block was before the
     * Flattening, which is a fact about Minecraft, and a `null` there is the
     * same sentence as "it did not exist yet".
     */
    const answer = (
      await callTool(
        "describe_block",
        { blocks: ["minecraft:red_wool", "minecraft:deepslate"] },
        options(sink),
      )
    ).result as {
      blocks: {
        block: string;
        legacyId: string | null;
        since?: string | null;
        until?: string | null;
      }[];
    };
    equal("a pre-Flattening block names its id:data", answer.blocks[0].legacyId, "35:14");
    equal(
      "...and one added later names none, which is the answer",
      answer.blocks[1].legacyId,
      null,
    );

    /*
     * And the flat era's half of the same question, which is what stops a
     * model reaching for a block the open schematic's version predates. A
     * label rather than a DataVersion: 2724 is not something a model can
     * reason about and "1.17" is.
     */
    equal("...and says when it arrived", answer.blocks[1].since, "1.17");
    equal(
      "a block that never went away has no end",
      answer.blocks[1].until,
      undefined,
    );

    /*
     * A block whose name was retired reports it, and that is deliberately not
     * the same message as a removal. Told only that `chain` ends at 1.21.8, a
     * model would conclude the block was deleted and stop offering it -- when
     * what it needs is that a newer version calls it something else.
     */
    const renamed = (
      await callTool(
        "describe_block",
        { blocks: ["minecraft:chain", "minecraft:iron_chain"] },
        options(sink),
      )
    ).result as { blocks: { since?: string | null; until?: string | null }[] };
    equal("the old name runs from 1.16", renamed.blocks[0].since, "1.16");
    equal("...to 1.21.8", renamed.blocks[0].until, "1.21.8");
    equal("...and the new one starts exactly there", renamed.blocks[1].since, "1.21.9");
    equal(
      "...and has no end",
      renamed.blocks[1].until,
      undefined,
    );
  }
}


console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
