/**
 * The MCP server: a listener on loopback, and the app's editing surface behind
 * it.
 *
 * The app's own agent is only as good as the model behind it. This lets a
 * stronger harness — Claude Code, Codex, whatever comes next — drive the same
 * schematic, through the same tools, with the same undo stack underneath. What
 * those harnesses cannot do for themselves is exactly what this exposes: read
 * and write the container formats, place a block with the state and the
 * neighbour connections the game would give it, and mesh the result.
 *
 * ## Why HTTP, when stdio is the universal transport
 *
 * Because stdio means the *client* spawns the server, and a freshly spawned
 * process has no document open. The whole point here is the session the user
 * is looking at: they watch the build change while the model works, and their
 * Ctrl+Z takes it back. A listener in the running app is the only shape that
 * has. `resources/mcp-bridge.mjs` covers the stdio-only clients by forwarding
 * to this.
 *
 * ## The low-level `Server`, not `McpServer`
 *
 * The high-level API registers tools with Standard Schema (Zod and friends).
 * Ours are plain JSON Schema objects written by hand in `agent/tools.ts`, which
 * is what MCP puts on the wire anyway — so the low-level `Server` lets both
 * sides skip a translation, and keeps zod out of this codebase for the reason
 * `agent/tools.ts` already gives.
 *
 * ## What is not defended against
 *
 * A client that reaches this server can run `run_build_script`, so it can run
 * code in the QuickJS sandbox. The token and the Host/Origin checks are there
 * to stop *another program on this machine*, and a web page in this user's
 * browser, from reaching it by accident or by DNS rebinding. They are not a
 * boundary against a client the user has deliberately connected: that client is
 * as trusted as the app's own agent, which is the bargain being made when the
 * toggle goes on.
 */

import { randomUUID, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { writeFile, rm } from "node:fs/promises";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { type McpActivity, type McpStatus } from "../../shared/ipc.js";
import { type McpSettings } from "../../shared/settings.js";
import { acceptsRequest } from "./policy.js";
import { callTool, describeTools } from "./tools.js";
import { shell } from "electron";

import {
  closeDocument,
  currentSession,
  newDocument,
  openDocument,
  saveSession,
} from "../services/session.js";
import { announceDocument } from "../services/broadcast.js";
import { isDirty } from "../domain/history.js";
import { dataVersionOf, refusalFor } from "../../shared/mc_versions.js";
import { legacyBlocksPath } from "../services/resources.js";
import { adoptSubject } from "../services/conversation.js";
import { getRecentDocuments, getSettings, rememberRecentDocument } from "../services/settings-store.js";
import { rememberInOsRecents } from "../menu.js";
import { type Lifecycle } from "./lifecycle.js";

/** How many calls the activity log remembers. */
const ACTIVITY_LIMIT = 100;

export interface McpHost {
  /** Every block this app can place — the set the tools are judged against. */
  allowedBlocks(): Promise<ReadonlySet<string>>;
  /** Where the discovery file goes, so the stdio bridge can find the server. */
  discoveryFile: string;
  /** What an empty `mcp.root` means — the app's own output directory. */
  defaultRoot(): Promise<string>;
  /** Called whenever the status moves, so the window can be told. */
  onStatus(status: McpStatus): void;
}

let host: McpHost | null = null;
let http: HttpServer | null = null;
let mcp: Server | null = null;
let transport: StreamableHTTPServerTransport | null = null;

let state: McpStatus["state"] = "off";
let message: string | null = null;
let token: string | null = null;
let url: string | null = null;
let calls = 0;
const sessions = new Set<string>();
const activity: McpActivity[] = [];

export function useHost(next: McpHost): void {
  host = next;
}

function requireHost(): McpHost {
  if (host === null) throw new Error("The MCP server has no host: useHost was never called.");
  return host;
}

export function mcpStatus(): McpStatus {
  return {
    state,
    url,
    token,
    clients: sessions.size,
    calls,
    message,
  };
}

export function mcpActivity(): McpActivity[] {
  return [...activity].reverse();
}

function announce(): void {
  host?.onStatus(mcpStatus());
}

function record(tool: string, summary: string, ok: boolean): void {
  activity.push({ at: Date.now(), tool, summary, ok });
  // A ring rather than a growing array: this runs for the life of the process
  // and nothing else prunes it.
  if (activity.length > ACTIVITY_LIMIT) activity.splice(0, activity.length - ACTIVITY_LIMIT);
  calls += 1;
  announce();
}

/**
 * A token, or the one already in use.
 *
 * 32 bytes from the CSPRNG, base64url so it survives being pasted into a shell
 * command and a JSON file without quoting. Regenerating is the whole mitigation
 * for a token that has to be readable in the UI, so it is cheap on purpose.
 */
function ensureToken(fresh: boolean): string {
  if (fresh || token === null) {
    token = randomBytes(32).toString("base64url");
  }
  return token;
}

function bearerOf(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1].trim();
}

/**
 * Constant-time comparison.
 *
 * The timing channel on a local token is close to theoretical, but "close to
 * theoretical" is not a reason to write the version that leaks — and the safe
 * one is three lines.
 */
function tokenMatches(offered: string | null, expected: string | null): boolean {
  if (offered === null || expected === null) return false;
  if (offered.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < offered.length; i += 1) {
    difference |= offered.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

function deny(response: ServerResponse, status: number, reason: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: reason },
      id: null,
    }),
  );
}

/**
 * The effects the file-level tools are allowed to have.
 *
 * Assembled here because this is the layer that may import Electron and the
 * settings store; `mcp/lifecycle.ts` holds the rules and takes this as an
 * argument, which is what lets `tests/mcp.ts` drive all of them with fakes.
 */
function lifecycleHost(): Lifecycle {
  return {
    session: currentSession,
    isDirty: (session) => isDirty(session.history),
    open: async (filePath) => {
      const session = await openDocument(filePath, { legacyBlocksPath: legacyBlocksPath() });
      // The same three follow-ups the window's own Open does. A file opened
      // over MCP that skipped them would be missing from the recents and would
      // arrive without its conversation -- "recovering is opening", and so is
      // this.
      await rememberRecentDocument(filePath);
      rememberInOsRecents(filePath);
      await adoptSubject(filePath);
      return session;
    },
    create: async (size, format, version) => {
      const session = newDocument(size, format, dataVersionOf(version ?? ""));
      await adoptSubject(null);
      return session;
    },
    save: async (session, options) => {
      const result = await saveSession(session, {
        filePath: options.filePath,
        format: options.format,
        legacyBlocksPath: legacyBlocksPath(),
      });
      await adoptSubject(result.filePath);
      return result;
    },
    close: closeDocument,
    recents: async () =>
      (await getRecentDocuments()).map((entry) => ({
        filePath: entry.filePath,
        openedAt: entry.openedAt,
      })),
    // `shell.trashItem`, never `unlink`: the way back is the user's own recycle
    // bin, and that is what makes deletion something this server may do at all.
    trash: async (filePath) => await shell.trashItem(filePath),
    root: async () => {
      const settings = await getSettings();
      return settings.mcp.root.trim() === "" ? await requireHost().defaultRoot() : settings.mcp.root;
    },
    allowDelete: async () => (await getSettings()).mcp.allowDelete,
    refusalFor: (format, version) => refusalFor(format, version ?? ""),
    announce: announceDocument,
  };
}

function buildMcpServer(): Server {
  const server = new Server(
    { name: "schematic-ai-studio", version: "3.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Edits the Minecraft schematic currently open in Schematic AI Studio. " +
        "Every change lands on the app's undo stack, so the user can take back " +
        "anything you do. Coordinates are the schematic's own: x is 0..width-1, " +
        "y is 0..height-1 with y up, z is 0..length-1, all inclusive. " +
        "Call get_schematic_info first.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: describeTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    try {
      const outcome = await callTool(name, request.params.arguments ?? {}, {
        client: "MCP",
        // The selection lives in the renderer and main is not told about it, so
        // an MCP tool has no selection to default to and must be given explicit
        // coordinates. `resolveRegion` already treats that as "the whole
        // document", which is the honest answer rather than a guessed one.
        selection: null,
        allowedBlocks: (await host?.allowedBlocks()) ?? new Set<string>(),
        lifecycle: lifecycleHost(),
        onChanged: announceDocument,
      });
      record(name, outcome.summary, true);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(outcome.result, null, 2) }],
        structuredContent: outcome.result as Record<string, unknown>,
      };
    } catch (err) {
      /*
       * Returned as a tool error rather than thrown past the transport.
       *
       * A refusal is *information* -- "that file is outside the folder I may
       * touch", "the open document has unsaved changes" -- and a model that
       * reads it can relay it or correct itself. Thrown, it reaches the client
       * as a protocol failure with no way to tell it apart from the server
       * being broken.
       */
      const text = err instanceof Error ? err.message : String(err);
      record(name, text, false);
      return { isError: true, content: [{ type: "text" as const, text }] };
    }
  });

  return server;
}

async function writeDiscovery(): Promise<void> {
  if (host === null || url === null || token === null) return;
  await writeFile(
    host.discoveryFile,
    `${JSON.stringify({ version: 1, url, token, pid: process.pid }, null, 2)}\n`,
    // 0600 where the platform honours it. Windows ignores the mode, which is
    // why this file holds a token that can be rotated rather than one that has
    // to stay secret forever.
    { encoding: "utf8", mode: 0o600 },
  );
}

async function clearDiscovery(): Promise<void> {
  if (host === null) return;
  await rm(host.discoveryFile, { force: true }).catch(() => undefined);
}

/**
 * Starts listening, or reports why not.
 *
 * The failure that actually happens is `EADDRINUSE`, from a second copy of the
 * app: this process takes no single-instance lock, so two windows really can
 * race for one port. It is reported into the status rather than thrown, because
 * the app must keep working — everything else about it is unaffected.
 */
export async function startMcpServer(settings: McpSettings): Promise<McpStatus> {
  await stopMcpServer();
  state = "starting";
  message = null;
  announce();

  const secret = ensureToken(false);
  mcp = buildMcpServer();
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.add(id);
      announce();
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
      announce();
    },
  });
  await mcp.connect(transport);

  const server = createServer((request, response) => {
    void handle(request, response, secret);
  });
  http = server;

  return await new Promise<McpStatus>((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      state = "error";
      message =
        err.code === "EADDRINUSE"
          ? `Port ${settings.port} is already in use — another copy of this app may be running. ` +
            `Choose a different port, or 0 to let the system pick one.`
          : err.message;
      url = null;
      http = null;
      announce();
      resolve(mcpStatus());
    });
    // Loopback only. The address is not a preference: everything about this
    // server assumes the client is on this machine, and binding anywhere else
    // would put the editing surface on the network.
    server.listen(settings.port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : settings.port;
      url = `http://127.0.0.1:${port}/mcp`;
      state = "listening";
      message = null;
      void writeDiscovery();
      announce();
      resolve(mcpStatus());
    });
  });
}

/** The port the listener actually got, for the Host check. */
function boundPort(): number {
  const address = http?.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  secret: string,
): Promise<void> {
  const accepted = acceptsRequest(
    { host: request.headers.host, origin: request.headers.origin },
    boundPort(),
  );
  if (!accepted.ok) {
    deny(response, 403, accepted.refused);
    return;
  }
  if (!tokenMatches(bearerOf(request), secret)) {
    deny(response, 401, "A bearer token is required. Settings → MCP has the current one.");
    return;
  }
  if (!request.url?.startsWith("/mcp")) {
    deny(response, 404, "This server speaks MCP at /mcp.");
    return;
  }
  if (transport === null) {
    deny(response, 503, "The server is not ready.");
    return;
  }
  await transport.handleRequest(request, response);
}

export async function stopMcpServer(): Promise<McpStatus> {
  const server = http;
  http = null;
  if (server !== null) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await transport?.close().catch(() => undefined);
  await mcp?.close().catch(() => undefined);
  transport = null;
  mcp = null;
  sessions.clear();
  url = null;
  state = "off";
  message = null;
  await clearDiscovery();
  announce();
  return mcpStatus();
}

/**
 * A new token, and every client holding the old one stops working.
 *
 * That is the point rather than a side effect: this is the answer to "the token
 * was on my screen while I was sharing it", and an answer that left the old
 * sessions running would not be one. The listener is restarted so the new
 * secret is the one being checked.
 */
export async function regenerateMcpToken(settings: McpSettings): Promise<McpStatus> {
  ensureToken(true);
  if (state !== "listening") {
    announce();
    return mcpStatus();
  }
  return await startMcpServer(settings);
}
