/**
 * Searching the block registry.
 *
 * A plain module rather than logic inside `BlockPicker.svelte` so it can be
 * tested: the picker is the only place in the app where the user meets all ~920
 * blocks, and the two things that make it usable — that it hides nothing, and
 * that the obvious answer is near the top — are both easy to break by accident
 * and invisible when broken. `tests/blocks.ts` holds them.
 */

/**
 * How well a block id answers a query. Lower is better; -1 is no match.
 *
 * Ranked rather than left alphabetical because at this size alphabetical buries
 * the answer. "oak" has 41 matches and `dark_oak_*` sorts ahead of every
 * `oak_*`; "stone" has 76 and `minecraft:stone` itself lands after
 * `blackstone`, `blue_ice`-adjacent names and the rest of the Bs.
 */
function rank(block: string, query: string): number {
  const id = block.toLowerCase();
  if (id === query) return 0;
  // The namespace is `minecraft:` on everything here, so matching against the
  // bare name is what "starts with" has to mean to be worth anything.
  const name = id.slice(id.indexOf(":") + 1);
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return id.includes(query) ? 3 : -1;
}

/**
 * Every block matching `query`, best first.
 *
 * *Every* one: there is deliberately no cap. A dropdown that stops at 40 shows
 * 40 of 41 matches with nothing to say it did, which makes it less trustworthy
 * than the plain text field it replaced.
 */
export function searchBlocks(blocks: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...blocks];

  return blocks
    .map((block) => ({ block, rank: rank(block, needle) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || (a.block < b.block ? -1 : 1))
    .map((entry) => entry.block);
}
