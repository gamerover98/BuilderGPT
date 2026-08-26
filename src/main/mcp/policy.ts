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
export function acceptsRequest(
  headers: { host?: string; origin?: string },
  port: number,
): Verdict<null> {
  const host = (headers.host ?? "").trim().toLowerCase();
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  if (!allowed.has(host)) {
    return refuse(`Host ${headers.host ?? "(none)"} is not this server.`);
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
