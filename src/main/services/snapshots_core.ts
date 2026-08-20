/**
 * The arithmetic behind a schematic's version history — no filesystem, no
 * Electron, so the suites can referee it.
 *
 * Same split as `recent_documents.ts` and `conversation_store.ts`, and for the
 * same reason: the module that touches disk imports paths the tests cannot
 * resolve, so the parts worth being wrong about live here.
 */

/** Why a version exists. Shown as a word, so a list of eight is readable. */
export type SnapshotSource = "generated" | "manual" | "opened";

export interface Snapshot {
  id: string;
  /** Epoch milliseconds. */
  at: number;
  source: SnapshotSource;
  /** What the user typed to produce it, when there was anything. */
  label: string;
  size: [number, number, number];
  blockCount: number;
}

/**
 * How many versions one schematic keeps.
 *
 * Each is a whole `.schem`, so this is a disk budget rather than a design
 * limit. Twelve is a working session's worth; beyond that the oldest go.
 */
export const MAX_SNAPSHOTS = 12;

/** As long a label as is worth storing; the rest is in the file. */
export const MAX_LABEL_CHARS = 120;

function isSource(value: unknown): value is SnapshotSource {
  return value === "generated" || value === "manual" || value === "opened";
}

function isSize(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
  );
}

/**
 * Reads an index written by another build, or edited by hand into nonsense.
 *
 * Entries that cannot be trusted are dropped rather than repaired: a version
 * row whose id does not name a real file is a Restore button that fails, and
 * one bad row must not cost the user the other eleven.
 */
export function coerceSnapshots(raw: unknown): Snapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: Snapshot[] = [];
  for (const value of raw) {
    if (value === null || typeof value !== "object") continue;
    const entry = value as Partial<Snapshot>;
    if (typeof entry.id !== "string" || entry.id === "") continue;
    if (!isSize(entry.size)) continue;
    out.push({
      id: entry.id,
      at: typeof entry.at === "number" && entry.at > 0 ? entry.at : 0,
      source: isSource(entry.source) ? entry.source : "manual",
      label: typeof entry.label === "string" ? entry.label.slice(0, MAX_LABEL_CHARS) : "",
      size: entry.size,
      blockCount:
        typeof entry.blockCount === "number" && entry.blockCount >= 0
          ? Math.trunc(entry.blockCount)
          : 0,
    });
  }
  return order(out);
}

/** Newest first, which is the order the panel reads in. */
export function order(list: readonly Snapshot[]): Snapshot[] {
  return [...list].sort((a, b) => b.at - a.at);
}

export interface PruneResult {
  kept: Snapshot[];
  /** Ids whose files are now unreferenced and should be deleted. */
  dropped: string[];
}

/**
 * Adds one and trims to the cap, saying which files fell off.
 *
 * The eviction list is returned rather than acted on here, because deleting is
 * the filesystem's job and this module has none — and because a caller that
 * forgets to delete leaves orphans, which is visible in a test.
 */
export function addSnapshot(
  list: readonly Snapshot[],
  next: Snapshot,
  max: number = MAX_SNAPSHOTS,
): PruneResult {
  const ordered = order([next, ...list.filter((entry) => entry.id !== next.id)]);
  return { kept: ordered.slice(0, max), dropped: ordered.slice(max).map((entry) => entry.id) };
}

export function removeSnapshot(list: readonly Snapshot[], id: string): PruneResult {
  const kept = list.filter((entry) => entry.id !== id);
  return { kept, dropped: kept.length === list.length ? [] : [id] };
}

/**
 * A label for a version, from whatever there is to make one out of.
 *
 * Never empty: a row with no words is a row that cannot be told from the one
 * above it, and "which of these do I want" is the only question this list
 * exists to answer.
 */
export function snapshotLabel(source: SnapshotSource, text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed !== "") return trimmed.slice(0, MAX_LABEL_CHARS);
  return source === "generated" ? "Generated" : source === "opened" ? "As opened" : "Saved version";
}

/** Ids are timestamped so a directory listing sorts the way the list does. */
export function snapshotId(now: number, random: () => number = Math.random): string {
  return `v${now.toString(36)}${random().toString(36).slice(2, 8)}`;
}
