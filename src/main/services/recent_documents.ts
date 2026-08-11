/**
 * The recently-opened list, as list arithmetic.
 *
 * Split from `settings-store.ts` because that module imports Electron for
 * `app.getPath` and `safeStorage`, which makes everything in it unreachable
 * from the test suites. What is worth testing here is not the file write — it
 * is that the same schematic never occupies two slots, that reopening one moves
 * it to the front instead of duplicating it, and that a hand-edited file cannot
 * put a non-string where the UI will call `.split()` on a path.
 *
 * Case sensitivity is a parameter rather than a `process.platform` check inside,
 * so both behaviours can be exercised on whichever machine the tests run on.
 */

/**
 * How many are kept. Long enough to cover what anyone is actually working on,
 * short enough that the list stays scannable at a glance.
 */
export const MAX_RECENT_DOCUMENTS = 10;

/** Windows reaches the same file through paths differing only in case. */
export function pathsMatch(a: string, b: string, caseSensitive: boolean): boolean {
  return caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
}

/**
 * Keeps the strings, drops everything else.
 *
 * The same defensive read the settings get, and for the same reason: a file
 * written by a future build, or edited by hand, must not reach the renderer
 * carrying a `null` where a path belongs.
 */
export function coerceRecents(raw: unknown, max = MAX_RECENT_DOCUMENTS): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .slice(0, max);
}

/** Moves a path to the front, or adds it there, and trims the tail. */
export function rememberRecent(
  list: readonly string[],
  filePath: string,
  caseSensitive: boolean,
  max = MAX_RECENT_DOCUMENTS,
): string[] {
  return [filePath, ...list.filter((entry) => !pathsMatch(entry, filePath, caseSensitive))].slice(
    0,
    max,
  );
}

/** Drops a path — used when opening it fails, because it moved or went away. */
export function forgetRecent(
  list: readonly string[],
  filePath: string,
  caseSensitive: boolean,
): string[] {
  return list.filter((entry) => !pathsMatch(entry, filePath, caseSensitive));
}
