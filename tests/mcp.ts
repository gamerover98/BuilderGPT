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

import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { TOOL_SPECS, buildTools, type ToolContext } from "../src/main/agent/tools.js";
import { callTool, describeTools, findTool, isReadOnly, serialised } from "../src/main/mcp/tools.js";
import { LIFECYCLE_SPECS, findLifecycle, type Lifecycle } from "../src/main/mcp/lifecycle.js";
import {
  acceptsRequest,
  connectCommand,
  isInside,
  mayDelete,
  mayReplaceDocument,
  samePath,
  withinRoot,
} from "../src/main/mcp/policy.js";
import { countBlocks, getBlock } from "../src/main/domain/document.js";
import { closeDocument, currentSession, newDocument, undoEdit } from "../src/main/services/session.js";
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

const ALLOWED = new Set(["minecraft:stone", "minecraft:oak_planks", "minecraft:air"]);

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
    const lifecycle = LIFECYCLE_SPECS.map((spec) => spec.name);

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
    check("the read-only ones are the getters", isReadOnly("get_region") && !isReadOnly("fill_region"));

    // `describeTools` reads the two tables and must not be a copy of either.
    equal(
      "nothing was left out of the descriptors",
      describeTools().length,
      TOOL_SPECS.length + LIFECYCLE_SPECS.length,
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
    const region = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
    for (const tool of describeTools().filter((t) => t.annotations.readOnlyHint)) {
      const spy = { changed: 0 };
      const at = session.history.undoStack.length;
      let raised: string | null = null;
      try {
        await callTool(tool.name, region, options(spy));
      } catch (err) {
        raised = err instanceof Error ? err.message : String(err);
      }
      check(`${tool.name} reads without writing`, raised === null, String(raised));
      equal(`...${tool.name} left the undo stack alone`, session.history.undoStack.length, at);
      equal(`...${tool.name} told the window nothing`, spy.changed, 0);
    }
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
