#!/usr/bin/env node
/**
 * stdio in, the running app's MCP server out.
 *
 * Every harness accepts a stdio MCP server; not all of them accept an HTTP one.
 * But stdio means the *client* spawns the process, and a freshly spawned
 * process has no schematic open — the whole point of this integration is the
 * document the user is looking at, changing while they watch. So this is the
 * shape that satisfies both: the client spawns *this*, and this forwards to the
 * app that already has the document.
 *
 * Usage, in a client's MCP configuration:
 *
 *   claude mcp add schematic -- node <path to this file>
 *
 * It takes no arguments and needs no configuration: the app writes its URL and
 * token to `mcp.json` in its userData directory when the server starts, and
 * this reads it. That is why the port may be `0` — nothing has to agree on a
 * number in two places.
 *
 * ## Deliberately dependency-free
 *
 * Plain Node, no imports beyond the standard library, including no MCP SDK.
 * It is shipped as an `extraResource` and run by whatever `node` the user's
 * client has, which is not this app's Electron and has no access to its
 * `node_modules`. A bridge that needed an install step is a bridge nobody sets
 * up.
 *
 * It is a *pipe*, not a participant: it does not parse the protocol beyond
 * framing, so it needs no updating when MCP gains a method.
 */

import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Where Electron puts `userData` for this app, per platform.
 *
 * This string has to equal `package.json`'s `name`, because that is what
 * `app.getName()` resolves to and therefore what Electron calls the directory.
 * The two are a pair with nothing linking them: this file is dependency-free
 * plain Node run by the *client's* node, so it cannot import the manifest, and
 * nothing here fails at build time when they drift.
 *
 * They drifted once, on the rename to `schematic-ai-studio`, and the symptom is
 * worth recognising: everything about the app keeps working and only the stdio
 * bridge stops finding it, reporting that the server is off while it is plainly
 * running. `tests/mcp.ts` spawns this file against a fake APPDATA for that
 * reason -- it is the only check that can see the pair disagree.
 */
function userDataDir() {
  const app = "schematic-ai-studio";
  if (platform() === "win32") {
    return path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), app);
  }
  if (platform() === "darwin") {
    return path.join(homedir(), "Library", "Application Support", app);
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), app);
}

async function discover() {
  const file = path.join(userDataDir(), "mcp.json");
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(
      `Schematic AI Studio is not serving MCP. Start the app and turn the server on in ` +
        `Settings → MCP server. (Looked for ${file}.)`,
    );
  }
  const parsed = JSON.parse(raw);
  /*
   * `token` may be `null`: the app can be told to serve without one. Requiring
   * a string here meant that turning authentication off left this bridge
   * refusing to start, with a message about the file being malformed -- which
   * it is not.
   */
  if (typeof parsed.url !== "string") {
    throw new Error(`${file} does not look like a discovery file this bridge understands.`);
  }
  if (parsed.token !== null && typeof parsed.token !== "string") {
    throw new Error(`${file} does not look like a discovery file this bridge understands.`);
  }
  return parsed;
}

/**
 * One JSON-RPC message per line, which is what MCP's stdio transport is.
 *
 * Buffered rather than assuming a message arrives in one `data` event: a large
 * `tools/call` result comes back in several, and splitting on newline without
 * keeping the remainder truncates it. This is the only piece of framing here
 * and it is the only piece there needs to be.
 */
function readMessages(stream, onMessage) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line !== "") onMessage(line);
    }
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** A JSON-RPC error for the id that asked, so the client is never left waiting. */
function fail(id, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

async function main() {
  const { url, token } = await discover();

  /**
   * The session id the app handed out, carried on every later request.
   *
   * The server runs in stateful mode, so the id from `initialize` has to come
   * back or subsequent requests are refused. Held here rather than passed
   * through, because a stdio client never sees an HTTP header.
   */
  let sessionId = null;

  readMessages(process.stdin, async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    try {
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      // Omitted rather than sent empty: `Bearer ` with nothing after it is a
      // credential the server would compare and reject, which reads as a wrong
      // token rather than as no token being wanted.
      if (token !== null) headers.authorization = `Bearer ${token}`;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;

      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
      const handed = response.headers.get("mcp-session-id");
      if (handed !== null) sessionId = handed;

      // A notification is answered with 202 and no body, and forwarding an
      // empty line as a message would be a parse error at the other end.
      if (response.status === 202) return;

      if (!response.ok) {
        fail(message.id, `Schematic AI Studio answered ${response.status}: ${await response.text()}`);
        return;
      }

      const type = response.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream")) {
        // SSE: the payloads are the `data:` lines. Everything else in the
        // stream is framing this side does not need to understand.
        const text = await response.text();
        for (const chunk of text.split("\n")) {
          if (chunk.startsWith("data:")) process.stdout.write(`${chunk.slice(5).trim()}\n`);
        }
        return;
      }
      send(await response.json());
    } catch (err) {
      fail(message.id, err instanceof Error ? err.message : String(err));
    }
  });

  // Nothing else keeps the process alive once stdin is exhausted, which is how
  // a client shuts a stdio server down.
  process.stdin.on("end", () => process.exit(0));
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
