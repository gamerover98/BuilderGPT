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
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { type McpActivity, type McpStatus } from "../../shared/ipc.js";
import {
  DEFAULT_MCP_SETTINGS,
  isWildcardAddress,
  type McpSettings,
} from "../../shared/settings.js";
import { acceptsRequest, chooseToken, routeRequest, startupRefusal } from "./policy.js";
import { callTool, describeTools } from "./tools.js";
import { app, shell } from "electron";

import {
  adoptDocument,
  closeDocument,
  currentSession,
  newDocument,
  openDocument,
  saveSession,
} from "../services/session.js";
import { listSnapshots, readSnapshot, takeSnapshot } from "../services/snapshots.js";
import { announceDocument } from "../services/broadcast.js";
import { isDirty } from "../domain/history.js";
import { dataVersionOf, refusalFor } from "../../shared/mc_versions.js";
import { legacyBlocksPath } from "../services/resources.js";
import { adoptSubject } from "../services/conversation.js";
import {
  getMcpToken,
  getRecentDocuments,
  getSettings,
  rememberRecentDocument,
  setMcpToken,
} from "../services/settings-store.js";
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
  /** Where `mcp-bridge.mjs` ended up, which differs between dev and installed. */
  bridgeFile: string;
  /** A PNG of the 3D viewport, base64-encoded, or `null` if there is no window. */
  capture(): Promise<{ data: string; width: number; height: number } | null>;
  /** Called whenever the status moves, so the window can be told. */
  onStatus(status: McpStatus): void;
}

let host: McpHost | null = null;
let http: HttpServer | null = null;

/**
 * One transport per session, which is what the SDK's stateful mode means.
 *
 * This was a single `transport` shared by the whole server, and that is a
 * one-session server wearing the shape of a many-session one. The SDK is
 * explicit about both halves: a second `initialize` on an already-initialised
 * transport is refused outright (*«Invalid Request: Server already
 * initialized»*), and any `mcp-session-id` other than the single one it holds
 * comes back 404 `Session not found`.
 *
 * So a client that reloaded -- which re-sends `initialize` -- could not get
 * back in without the whole server being restarted, and a second client could
 * not connect at all. Reported as both.
 *
 * A `Server` goes with each one, because `Server.connect` binds one to one.
 * That costs nothing: `buildMcpServer` holds no state of its own -- every
 * answer comes through `host` and `currentSession()`.
 */
const transports = new Map<string, { transport: StreamableHTTPServerTransport; mcp: Server }>();

let state: McpStatus["state"] = "off";
let message: string | null = null;
let token: string | null = null;
let url: string | null = null;
let calls = 0;
/*
 * What the listener is *doing*, as opposed to what the settings ask for.
 * `handle` reads these per request rather than closing over them, so a
 * change takes effect without a restart and a restart that failed cannot
 * leave the old answer being served.
 */
let requireAuth = DEFAULT_MCP_SETTINGS.requireAuth;
let bindAddress = DEFAULT_MCP_SETTINGS.bindAddress;
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
    clients: transports.size,
    calls,
    message,
    bridge: host?.bridgeFile ?? null,
    requiresAuth: requireAuth,
    bindAddress,
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
 * The token to serve with, remembered across launches.
 *
 * 32 bytes from the CSPRNG, base64url so it survives being pasted into a shell
 * command and a JSON file without quoting — but only *made* when there is
 * nothing stored or somebody asked for a new one. It used to live in this
 * module and nowhere else, so every launch minted a fresh one and silently
 * broke whatever the user had already configured in their client.
 *
 * `chooseToken` is in `policy.ts` because that rule is worth a test and this
 * file cannot have one.
 */
async function ensureToken(regenerate: boolean): Promise<string> {
  const stored = await getMcpToken();
  const next = chooseToken(stored, regenerate, randomBytes(32).toString("base64url"));
  if (next !== stored) await setMcpToken(next);
  token = next;
  return next;
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
    /*
     * `version` arrives already resolved to a canonical name, so
     * `dataVersionOf` is asked a question it can answer. It used to be
     * handed whatever the client typed, and it fails open: an unknown name
     * came back `null`, which is exactly what 1.8.8 and "no version at all"
     * also look like from here. Asking for 26.2 and getting a document with
     * no version tag was that `null`, in silence.
     */
    create: async (size, format, version) => {
      const session = newDocument(size, format, dataVersionOf(version));
      await adoptSubject(null);
      return session;
    },
    save: async (session, options) => {
      const result = await saveSession(session, {
        filePath: options.filePath,
        format: options.format,
        // Only when asked, for `SaveRequest.version`'s reason: passing `null`
        // unconditionally would strip the tag off every file saved.
        ...(options.version === undefined
          ? {}
          : { dataVersion: dataVersionOf(options.version) }),
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
    capture: async () => await requireHost().capture(),
    versions: async () => {
      const session = currentSession();
      if (session === null) return [];
      return (await listSnapshots(session.doc.filePath)).map((snapshot) => ({
        id: snapshot.id,
        label: snapshot.label,
        at: snapshot.at,
      }));
    },
    saveVersion: async (label) => {
      const session = currentSession();
      if (session === null) return [];
      await takeSnapshot(session, "manual", label);
      return (await listSnapshots(session.doc.filePath)).map((snapshot) => ({
        id: snapshot.id,
        label: snapshot.label,
        at: snapshot.at,
      }));
    },
    restoreVersion: async (id) => {
      const session = currentSession();
      if (session === null || session.doc.filePath === null) return null;
      const restored = await readSnapshot(session.doc.filePath, id);
      if (restored === null) return null;
      // What is being left, kept first. `adoptDocument` starts a fresh history,
      // so a restore cannot be undone -- this snapshot is the way back, and it
      // is what makes going back a fork rather than a one-way door.
      await takeSnapshot(session, "manual", "Before going back");
      return adoptDocument(restored.doc, restored.history);
    },
  };
}

function buildMcpServer(): Server {
  const server = new Server(
    /*
     * The version an MCP client sees for this server. Read from the manifest
     * rather than written here: it was a literal "3.0.0", which the drop to
     * 1.0.0 left behind, and a hardcoded one is only ever right on the day it
     * is typed. Nothing downstream validates it, so it goes stale in silence.
     */
    { name: "schematic-ai-studio", version: app.getVersion() },
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

  /*
   * Every tool, unconditionally.
   *
   * This briefly filtered the list, because `generate_schematic` needed the
   * *app's* provider key and was the one tool that could fail for a reason
   * having nothing to do with schematics. That tool is gone -- see the note
   * on `Lifecycle` -- and with it the only reason a tool here could be
   * unavailable. Nothing left in this list depends on anything but the app
   * being open.
   */
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
        legacyBlocksPath: legacyBlocksPath(),
        lifecycle: lifecycleHost(),
        onChanged: announceDocument,
      });
      record(name, outcome.summary, true);
      /*
       * A picture goes back as an image block, not as JSON with base64 in it.
       *
       * MCP has a content type for this and a client that gets it shows the
       * model an image; the same bytes inside a `text` block are a wall of
       * base64 that costs the tokens and conveys nothing.
       */
      const shot = outcome.result as { data?: unknown; width?: unknown };
      if (typeof shot?.data === "string" && typeof shot.width === "number") {
        return {
          content: [{ type: "image" as const, data: shot.data, mimeType: "image/png" }],
        };
      }
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
  if (host === null || url === null) return;
  /*
   * Written even with no token, as `token: null`. It used to return early on
   * that, which with authentication off would have left the stdio bridge
   * unable to find the app at all -- the file is how it does that, and the
   * port may be 0 precisely so nothing has to agree on a number twice.
   */
  const offered = requireAuth ? token : null;
  await writeFile(
    host.discoveryFile,
    `${JSON.stringify({ version: 1, url, token: offered, pid: process.pid }, null, 2)}\n`,
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
  requireAuth = settings.requireAuth;
  bindAddress = settings.bindAddress;
  announce();

  /*
   * Refused before the socket exists, not after. `startupRefusal` holds the
   * one combination that is not allowed -- no token, bound past loopback --
   * and the address check with it, so a bad address says what is wrong with
   * it instead of arriving as EADDRNOTAVAIL.
   */
  const refusal = startupRefusal(settings);
  if (refusal !== null) {
    state = "error";
    message = refusal;
    url = null;
    announce();
    return mcpStatus();
  }

  /*
   * The token is made ready but **not** captured: `handle` reads the module
   * variable per request instead. A closure over the secret meant a setting
   * could only take effect by restarting, and left a regenerate whose restart
   * failed still checking against the old one.
   */
  await ensureToken(false);

  const server = createServer((request, response) => {
    void handle(request, response);
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
    /*
     * Loopback unless somebody typed otherwise, and typing otherwise puts the
     * editing surface on the network -- which is why the combination with no
     * token is refused above rather than merely warned about.
     */
    server.listen(settings.port, settings.bindAddress, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : settings.port;
      url = `http://${reachableHost(settings.bindAddress)}:${port}/mcp`;
      state = "listening";
      message = null;
      void writeDiscovery();
      announce();
      resolve(mcpStatus());
    });
  });
}

/**
 * The address to *show*, which is not always the address bound to.
 *
 * `0.0.0.0` is every interface, and is not something anybody can connect to:
 * offered as a URL it is a copyable string that does not work. What is always
 * true of a server bound to it is that loopback reaches it, so that is what
 * the pane shows -- and a client elsewhere on the network needs this
 * machine's own address, which is a thing only its user knows.
 */
function reachableHost(address: string): string {
  if (isWildcardAddress(address)) return "127.0.0.1";
  const trimmed = address.trim();
  // A bare IPv6 literal has to be bracketed inside a URL.
  if (trimmed.includes(":") && !trimmed.startsWith("[")) return `[${trimmed}]`;
  return trimmed;
}

/** The port the listener actually got, for the Host check. */
function boundPort(): number {
  const address = http?.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

/**
 * The request body, as far as `MAX_BODY`.
 *
 * Read here rather than left to the transport because routing needs it: an
 * `initialize` is what may open a session, and telling one apart from any other
 * POST is a question about the payload. `handleRequest` takes the parsed body
 * back, so nothing is read twice.
 *
 * The cap is not decoration. This is a listening socket, and an unbounded read
 * into memory is the one thing that turns a local convenience into a way to
 * exhaust the app.
 */
const MAX_BODY = 8 * 1024 * 1024;

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = chunk as Buffer;
    size += piece.length;
    if (size > MAX_BODY) throw new Error(`Body larger than ${MAX_BODY} bytes.`);
    chunks.push(piece);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Builds a session, and remembers it only once the SDK says it has one. */
async function openSession(): Promise<StreamableHTTPServerTransport> {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    /*
     * Added here and nowhere earlier: a POST that is not an `initialize`, or
     * one the SDK refuses, must not leave a transport behind in the map.
     */
    onsessioninitialized: (id) => {
      transports.set(id, { transport, mcp: server });
      announce();
    },
    onsessionclosed: (id) => {
      transports.delete(id);
      announce();
    },
  });
  /*
   * `onsessionclosed` is the DELETE, which a well-behaved client sends and a
   * client that simply goes away does not. Without this second hook the count
   * in the settings pane only ever grows, and every dead session's `Server`
   * stays alive with it.
   */
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id !== undefined) transports.delete(id);
    void server.close().catch(() => undefined);
    announce();
  };
  await server.connect(transport);
  return transport;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const accepted = acceptsRequest(
    { host: request.headers.host, origin: request.headers.origin },
    boundPort(),
    bindAddress,
  );
  if (!accepted.ok) {
    deny(response, 403, accepted.refused);
    return;
  }
  /*
   * Read per request rather than captured when the listener started -- see
   * `startMcpServer`. The Host and Origin checks above are **not** skipped
   * with authentication off: they are the rebinding defence, which is about
   * who may reach the server rather than who may use it, and turning off a
   * token is not a reason to let a web page in.
   */
  if (requireAuth && !tokenMatches(bearerOf(request), token)) {
    deny(response, 401, "A bearer token is required. Settings → MCP has the current one.");
    return;
  }
  if (!request.url?.startsWith("/mcp")) {
    deny(response, 404, "This server speaks MCP at /mcp.");
    return;
  }

  const header = request.headers["mcp-session-id"];
  const id = typeof header === "string" ? header : null;
  const held = id === null ? undefined : transports.get(id);
  if (held !== undefined) {
    await held.transport.handleRequest(request, response);
    return;
  }

  let body: unknown;
  try {
    body = await readBody(request);
  } catch (err) {
    deny(response, 400, err instanceof Error ? err.message : String(err));
    return;
  }

  // The decision itself is `policy.ts`'s, where it can be checked.
  const route = routeRequest({ sessionId: id, known: false, isInitialize: isInitializeRequest(body) });
  if (route.kind === "refused") {
    deny(response, route.status, route.refused);
    return;
  }

  const fresh = await openSession();
  await fresh.handleRequest(request, response, body);
}

/**
 * Stops listening, and **returns**.
 *
 * `server.close()` stops new connections and waits for the open ones to end;
 * it does not end them. An MCP client holds a keep-alive connection and often
 * an SSE stream, so the callback never came and this promise never settled --
 * which took `regenerateMcpToken` and the Enabled checkbox down with it, both
 * of which await this. The token had already been written by then, so the
 * button looked inert until the app was restarted and the new one appeared.
 * `closeAllConnections` is the missing half.
 *
 * The transports go first, so each client sees its stream end rather than the
 * socket vanish, and the state is reported before the sockets are cut: a
 * window that learns nothing is half of what was reported.
 */
export async function stopMcpServer(): Promise<McpStatus> {
  const server = http;
  http = null;
  for (const { transport, mcp } of transports.values()) {
    await transport.close().catch(() => undefined);
    await mcp.close().catch(() => undefined);
  }
  transports.clear();
  url = null;
  state = "off";
  message = null;
  announce();
  if (server !== null) {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
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
  await ensureToken(true);
  if (state !== "listening") {
    announce();
    return mcpStatus();
  }
  return await startMcpServer(settings);
}
