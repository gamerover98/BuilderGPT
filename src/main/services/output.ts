/**
 * Where generated files land, and what happens when a name is already taken.
 *
 * `component.py:137-146` wrote into a `generated/` folder next to the module
 * and named every file `{name}-{uuid4}`. The UUID was not a naming decision so
 * much as a collision decision: with a random suffix no file can ever overwrite
 * another, and the cost is a directory of names nobody can read.
 *
 * Now that the output directory is the user's to choose -- and therefore
 * somewhere they actually browse -- the trade is worth reversing. Files are
 * named after the structure, and a collision moves the existing file aside
 * under a timestamp instead of destroying it.
 */

import { mkdir, rename, rm, writeFile } from "fs/promises";
import path from "path";

export interface ResolvedOutput {
  filePath: string;
  /** Absolute path the previous file was moved to, or `null` if there was none. */
  backedUpTo: string | null;
}

/**
 * `2026-08-09T14:30:00.123Z` -> `2026-08-09T14-30-00`.
 *
 * Colons are illegal in Windows filenames and the sub-second part buys nothing
 * a human reading a directory listing would want.
 */
function timestampSuffix(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
}

/**
 * Reserves `<dir>/<name>.<ext>`, moving any existing file to
 * `<name>.<timestamp>.bak.<ext>` first.
 *
 * Uses `rename` and catches ENOENT rather than testing with `existsSync`: the
 * same no-TOCTOU-pre-check rule the rest of the pipeline follows
 * (RULEBOOK.md §1 "Standard library I/O"). Here it is not merely stylistic --
 * the gap between "does it exist" and "move it" is exactly where a file the
 * user just dropped in would be silently destroyed.
 */
export async function resolveOutputPath(
  dir: string,
  name: string,
  ext: string,
  now: Date = new Date(),
): Promise<ResolvedOutput> {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.${ext}`);
  const backupPath = path.join(dir, `${name}.${timestampSuffix(now)}.bak.${ext}`);

  try {
    await rename(filePath, backupPath);
    return { filePath, backedUpTo: backupPath };
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      // Nothing to preserve: the common case.
      return { filePath, backedUpTo: null };
    }
    throw err;
  }
}

export class OutputDirectoryError extends Error {
  constructor(dir: string, reason: string) {
    super(`Cannot use ${dir} as the output folder: ${reason}`);
    this.name = "OutputDirectoryError";
  }
}

/**
 * Proves the directory is writable by writing to it.
 *
 * Checking permission bits would be both less accurate and less honest: a
 * network share, a read-only mount and a folder owned by another user all
 * report differently across platforms, and the only question that matters is
 * whether the app can put a file there. Failing here means failing at the
 * moment the user picks the folder, rather than after a paid LLM call.
 */
export async function assertWritableDirectory(dir: string): Promise<void> {
  const probe = path.join(dir, `.buildergpt-write-test-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "", "utf-8");
  } catch (err: unknown) {
    throw new OutputDirectoryError(dir, err instanceof Error ? err.message : String(err));
  } finally {
    await rm(probe, { force: true }).catch(() => {
      // A probe we could not clean up is not worth failing the selection over.
    });
  }
}
