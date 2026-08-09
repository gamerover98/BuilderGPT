/**
 * Pure naming/formatting helpers used by `generate.ts` and `artifacts.ts`.
 *
 * They live in their own module for one reason: those two both import
 * `electron`, which cannot be imported outside an Electron process. Keeping the
 * pure parts separate lets `tests/services.ts` exercise them
 * headlessly (ARCHITECTURE.md §6 item 3).
 */

/**
 * The generated name goes straight into a filesystem path. component.py:135 did
 * `f"{raw_name}-{uuid4()}"` with the model's raw response, which is
 * attacker-influenced text -- a response of `../../evil` would have escaped
 * `generated/`. Sanitized here; the uuid suffix still guarantees uniqueness.
 */
export function sanitizeName(raw: string): string {
  const collapsed = raw.trim().split(/\s+/).join(" ");
  const safe = collapsed
    .replace(/[^\p{L}\p{N} _.-]/gu, "")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 64)
    .trim();
  return safe === "" ? "structure" : safe;
}

/**
 * component.py:150 / 172: the artifact description is the user's prompt,
 * truncated to 50 chars with an ellipsis appended only when it was longer.
 */
export function describeFor(description: string): string {
  const truncated = description.slice(0, 50);
  return `${truncated}${description.length > 50 ? "..." : ""}`;
}
