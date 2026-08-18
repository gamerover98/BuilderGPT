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
 * The clock is a parameter for the same reason: a test that had to wait for
 * `Date.now()` to move would be a slow test that still proved nothing.
 */

import type { RecentDocument } from "../../shared/ipc.js";

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
 * Keeps the well-formed entries, drops everything else.
 *
 * The same defensive read the settings get, and for the same reason: a file
 * written by a future build, or edited by hand, must not reach the renderer
 * carrying a `null` where a path belongs.
 *
 * A bare string is accepted as well as an object, because that is what every
 * settings file written before this list carried timestamps contains. Those
 * entries get `openedAt: 0`, which the UI reads as "no date recorded" rather
 * than as 1970 — losing the whole list to gain a column would be a poor trade
 * for someone who just updated.
 */
export function coerceRecents(raw: unknown, max = MAX_RECENT_DOCUMENTS): RecentDocument[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const kept: RecentDocument[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry.trim() !== "") kept.push({ filePath: entry, openedAt: 0 });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Partial<RecentDocument>;
    if (typeof record.filePath !== "string" || record.filePath.trim() === "") continue;
    const openedAt = Number(record.openedAt);
    kept.push({
      filePath: record.filePath,
      openedAt: Number.isFinite(openedAt) && openedAt > 0 ? Math.round(openedAt) : 0,
    });
  }
  return kept.slice(0, max);
}

/** Moves a path to the front with a fresh timestamp, and trims the tail. */
export function rememberRecent(
  list: readonly RecentDocument[],
  filePath: string,
  caseSensitive: boolean,
  now: number = Date.now(),
  max = MAX_RECENT_DOCUMENTS,
): RecentDocument[] {
  return [
    { filePath, openedAt: now },
    ...list.filter((entry) => !pathsMatch(entry.filePath, filePath, caseSensitive)),
  ].slice(0, max);
}

/** Drops a path — used when opening it fails, because it moved or went away. */
export function forgetRecent(
  list: readonly RecentDocument[],
  filePath: string,
  caseSensitive: boolean,
): RecentDocument[] {
  return list.filter((entry) => !pathsMatch(entry.filePath, filePath, caseSensitive));
}
