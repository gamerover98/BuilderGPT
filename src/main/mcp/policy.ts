/**
 * What the MCP server will and will not do, as pure functions.
 *
 * Electron-free on purpose, for the reason `discard_prompt.ts` and
 * `settings_coerce.ts` are: the modules that hold the server itself import
 * `electron` and `node:http`, which puts them out of reach of the suites — and
 * these are the parts that most need reaching, because every one of them is a
 * rule about what somebody else's model may do to a build.
 *
 * ## The principle
 *
 * **Every MCP operation must leave a way back inside the app's own model.**
 *
 * A client can already destroy a build with one `fill_region` over the whole
 * document, and that is acceptable because it is a transaction, on the undo
 * stack, with a version history behind it. The rules here are for the verbs
 * that would otherwise step outside that net: opening over unsaved work,
 * writing outside a known directory, and deleting.
 */

import path from "path";

import {
  bindAddressRefusal,
  isLoopbackAddress,
  isWildcardAddress,
} from "../../shared/settings.js";

export { connectCommand } from "../../shared/mcp.js";

/** Why a request was turned down, in words meant for a model to act on. */
export interface Refusal {
  refused: string;
}

export type Verdict<T> = { ok: true; value: T } | ({ ok: false } & Refusal);

export function refuse(reason: string): { ok: false } & Refusal {
  return { ok: false, refused: reason };
}

export function allow<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/**
 * Whether `candidate` is inside `root`.
 *
 * Both are resolved first, so `..` cannot climb out and a relative path cannot
 * mean something different depending on the process's working directory. The
 * separator is appended before comparing, or `/build` would be judged to
 * contain `/build-backup` — the classic prefix bug, and the one a check like
 * this exists to not have.
 *
 * Case is folded on Windows only, because that is where the filesystem folds
 * it; doing it everywhere would let `/Home/x` pass for a root of `/home/x` on
 * a system where those are two directories.
 */
export function isInside(root: string, candidate: string): boolean {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  if (samePath(base, target)) return true;
  const prefix = fold(base.endsWith(path.sep) ? base : base + path.sep);
  return fold(target).startsWith(prefix);
}

/** Case-folded on Windows only — see `isInside`. */
function fold(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** Whether two paths name the same file. */
export function samePath(a: string, b: string): boolean {
  return fold(path.resolve(a)) === fold(path.resolve(b));
}

/**
 * A path the server is allowed to touch, or a refusal naming the root.
 *
 * The root is not a defence against a hostile client and does not claim to be:
 * a client that can call `run_build_script` is already running code in a
 * sandbox this process owns. It is a defence against a *mistyped path* — the
 * ordinary failure where a model asked for `../../Documents` and meant
 * `../Documents` — and against the blast radius of a confused one.
 */
export function withinRoot(root: string, candidate: string): Verdict<string> {
  const trimmed = String(candidate ?? "").trim();
  if (trimmed === "") {
    return refuse("A file path is required.");
  }
  const resolved = path.resolve(root, trimmed);
  if (!isInside(root, resolved)) {
    return refuse(
      `${resolved} is outside the directory this server may touch (${root}). ` +
        `Ask the user to move the file there, or to change the root in Settings → MCP.`,
    );
  }
  return allow(resolved);
}

/**
 * Whether a verb that replaces the open document may proceed.
 *
 * Refused rather than asked about. `services/discard_prompt.ts` is right for a
 * person at the keyboard and wrong twice over here: a background agent must not
 * be able to make a modal appear on somebody's screen, and it must certainly
 * not be able to answer its own question about throwing away their work.
 *
 * So the refusal is the *answer*, phrased for a model to relay to its user and
 * call again with the flag — which puts the decision back with the person whose
 * work it is.
 */
export function mayReplaceDocument(
  dirty: boolean,
  fileName: string | null,
  discardUnsavedChanges: boolean,
): Verdict<null> {
  if (!dirty || discardUnsavedChanges) {
    return allow(null);
  }
  return refuse(
    `${fileName ?? "The open schematic"} has unsaved changes and this would replace it. ` +
      `Ask the user whether to save first, or call again with discardUnsavedChanges: true ` +
      `if they say to throw the changes away.`,
  );
}

/**
 * Whether a schematic may be deleted, and it is three questions rather than one.
 *
 * `allowDelete` is off by default because "may another program edit my
 * schematics" and "may it throw them away" are different decisions, and only
 * one of them is most of the value here. The other two are not preferences:
 * deleting the file the window is showing would leave the app editing something
 * that no longer exists, and a path outside the root is the mistyped-path case
 * that the root exists for.
 *
 * Even past all three the caller moves the file to the OS trash rather than
 * unlinking it, which is what keeps this inside the principle at the top: the
 * way back is the user's own recycle bin.
 */
export function mayDelete(
  options: {
    allowDelete: boolean;
    root: string;
    openFilePath: string | null;
  },
  candidate: string,
): Verdict<string> {
  if (!options.allowDelete) {
    return refuse(
      "Deleting schematics is switched off. The user can turn it on in Settings → MCP; " +
        "until they do, this server will not remove files.",
    );
  }
  const within = withinRoot(options.root, candidate);
  if (!within.ok) return within;

  if (options.openFilePath !== null && samePath(options.openFilePath, within.value)) {
    return refuse(
      "That schematic is the one currently open. Close it first, so the app is not left " +
        "editing a file that no longer exists.",
    );
  }
  return allow(within.value);
}

/**
 * Which token the server should use: the one it already had, or a new one.
 *
 * A rule small enough to look like it does not need writing down, and it is the
 * one that was wrong. The token lived in a module variable and nowhere else, so
 * every launch minted a fresh one — silently invalidating whatever the user had
 * pasted into their client the day before, which reads as "the integration
 * stopped working" rather than as anything to do with tokens.
 *
 * So: a stored token is kept. A new one is made only when explicitly asked for,
 * or when there is nothing stored — a first run, or a settings file from before
 * this feature existed. An empty string counts as nothing rather than as a
 * token, because a file edited by hand is one of the ways it can arrive.
 */
export function chooseToken(stored: string | null, regenerate: boolean, fresh: string): string {
  if (regenerate) return fresh;
  const trimmed = (stored ?? "").trim();
  return trimmed === "" ? fresh : trimmed;
}

/**
 * Whether a request's `Host` and `Origin` may be served.
 *
 * DNS rebinding is the attack this turns away: a page on the open web resolves
 * a name it controls to 127.0.0.1 and then talks to whatever is listening there
 * with the user's own network position. Binding to loopback does not stop it —
 * the browser really is on loopback — so the request's own headers have to be
 * checked, and the MCP specification asks local servers to do exactly this.
 *
 * The SDK carries options for it that are marked deprecated in favour of
 * "external middleware", so this *is* the external middleware.
 *
 * A missing `Origin` is allowed: a command-line client sends none, and that is
 * the normal case here. A browser always sends one, which is what makes
 * refusing every value that is not ours the right rule rather than a guess.
 */
/**
 * Whether a settings change has to reach the listener, or only the disk.
 *
 * For a long time nothing but `mcpSetEnabled` reached it at all, so the port,
 * the bind address and whether a token is required were saved and then ignored
 * until the next launch. Turning authentication off and on again left the pane
 * describing one server and the socket being another -- and the token row,
 * which keys on that, gone with no way to bring it back.
 *
 * **Only the three the listener is built from.** `root` and `allowDelete` are
 * asked at the moment of each call, deliberately -- revoking deletion has to
 * revoke it now, not at the next restart -- so restarting for those would drop
 * every session and buy nothing.
 */
export function servingChanged(
  before: { port: number; bindAddress: string; requireAuth: boolean },
  after: { port: number; bindAddress: string; requireAuth: boolean },
): boolean {
  return (
    before.port !== after.port ||
    before.bindAddress !== after.bindAddress ||
    before.requireAuth !== after.requireAuth
  );
}
/**
 * Which transport a request belongs to.
 *
 * A plain function here rather than a branch inside `server.ts`'s `handle`, for
 * the reason `selection_drag.ts` and `mcp_status.ts` are plain modules: the
 * server itself imports `electron` and `node:http` and cannot be loaded by the
 * suites at all, and this is the part that was wrong.
 *
 * What was wrong: the server held **one** transport for its whole life. The SDK
 * refuses a second `initialize` on an already-initialised transport, and answers
 * 404 `Session not found` to any session id but its own -- so a client that
 * reloaded could not get back in, and a second client could not connect at all.
 * Both were reported.
 */
export type Route =
  | { kind: "existing" }
  | { kind: "new" }
  | { kind: "refused"; status: number; refused: string };

export function routeRequest(request: {
  /** The `Mcp-Session-Id` header, if the client sent one. */
  sessionId: string | null;
  /** Whether this server currently holds that session. */
  known: boolean;
  /** Whether the body is an `initialize`, which is the only thing that opens one. */
  isInitialize: boolean;
}): Route {
  if (request.sessionId !== null && request.known) return { kind: "existing" };
  /*
   * A session id this server never issued is **not** a reason to make one.
   *
   * The client is holding a session that has been forgotten -- across a restart,
   * most likely -- and handing back a different session under its id would look
   * like success and then behave like a machine with amnesia. 404 is also what
   * the specification asks for, and what a client knows how to recover from.
   */
  if (request.sessionId !== null) {
    return {
      kind: "refused",
      status: 404,
      refused: `No session ${request.sessionId}. Send initialize to start a new one.`,
    };
  }
  /*
   * No id and not an initialize. Refused rather than opened, or every malformed
   * POST would build a transport and a `Server` that nothing ever closes.
   */
  if (!request.isInitialize) {
    return {
      kind: "refused",
      status: 400,
      refused: "No session. Send initialize first, or set Mcp-Session-Id.",
    };
  }
  return { kind: "new" };
}
/** `host:port` split from the right, so an IPv6 literal's own colons survive. */
function hostName(header: string): { host: string; port: number } | null {
  if (header === "") return null;
  const bracket = header.lastIndexOf("]");
  const colon = header.lastIndexOf(":");
  if (colon === -1 || colon < bracket) return null;
  const port = Number(header.slice(colon + 1));
  if (!Number.isInteger(port)) return null;
  const host = header.slice(0, colon).replace(/^\[|\]$/g, "");
  return { host, port };
}

/** An IP literal rather than a name — the distinction rebinding turns on. */
function isNumericHost(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split(".").every((part) => Number(part) <= 255);
  }
  return /^[0-9a-f:]+$/.test(host) && host.includes(":");
}

/**
 * Why this configuration will not be served at all, or `null`.
 *
 * The one combination that is refused rather than warned about: no token, and
 * bound past loopback. Each half alone is defensible -- on loopback the token
 * is a convenience rather than the boundary, and off loopback the token *is*
 * the access control -- but together they are an anonymous write endpoint on
 * somebody's files, reachable by anything that can route to this machine.
 *
 * Refused here rather than left to the user's judgement because the two
 * settings are in different parts of the pane and neither one says what the
 * other implies.
 */
export function startupRefusal(settings: {
  requireAuth: boolean;
  bindAddress: string;
}): string | null {
  const address = bindAddressRefusal(settings.bindAddress);
  if (address !== null) return address;
  if (settings.requireAuth || isLoopbackAddress(settings.bindAddress)) return null;
  return (
    `Listening on ${settings.bindAddress} without a token would let anything that can ` +
    `reach this machine read, write and save your schematics. Either put the token back ` +
    `on, or bind to 127.0.0.1 so only this machine can connect.`
  );
}
export function acceptsRequest(
  headers: { host?: string; origin?: string },
  port: number,
  /**
   * The address the listener is bound to. Loopback by default, which is what
   * it was before there was a setting -- so the two existing call sites and
   * every check written against them keep meaning what they meant.
   */
  bindAddress: string = "127.0.0.1",
): Verdict<null> {
  const host = (headers.host ?? "").trim().toLowerCase();
  const named = hostName(host);
  if (named === null || named.port !== port) {
    return refuse(`Host ${headers.host ?? "(none)"} is not this server.`);
  }
  /*
   * Loopback is always allowed: whatever this is bound to, it is still
   * reachable from the machine it runs on, and that is the ordinary case.
   */
  const localhost = new Set(["127.0.0.1", "localhost", "::1"]);
  const bound = bindAddress.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!localhost.has(named.host)) {
    if (isWildcardAddress(bindAddress)) {
      /*
       * Bound to every interface, so which address a client arrived on is not
       * something this can know -- but a **name** still must not be served.
       * That is the whole of the rebinding defence: the attack is a domain the
       * attacker controls resolving to this machine, and a domain is a name.
       * An IP literal cannot be rebound, because there is nothing to resolve.
       */
      if (!isNumericHost(named.host)) {
        return refuse(
          `Host ${headers.host ?? "(none)"} is a name. This server answers to its own ` +
            `address, so that a page on the web cannot reach it by pointing a domain here.`,
        );
      }
    } else if (named.host !== bound) {
      return refuse(`Host ${headers.host ?? "(none)"} is not this server.`);
    }
  }
  const origin = headers.origin;
  if (origin !== undefined && origin !== "" && origin !== "null") {
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return refuse(`Origin ${origin} is not a URL.`);
    }
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
      return refuse(`Origin ${origin} is not allowed to reach this server.`);
    }
  }
  return allow(null);
}
