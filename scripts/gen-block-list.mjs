// Regenerates `block_id_list.txt`, the set of block ids the generator and the
// AI tools are allowed to place.
//
// Usage, from the repo root:
//
//   node scripts/gen-block-list.mjs > block_id_list.txt
//
// stderr carries a report. Read it, don't just count it.
//
// ## It is the registry now, and it used to be a table
//
// This was built from `legacy_blocks.json` plus hand-written family tables for
// everything after 1.13 -- one entry per wood, per stone, per copper oxidation
// stage -- and it seeded itself from the list it was regenerating, so it could
// only ever grow and only ever by hand. It was **189 blocks behind** the
// registry already vendored beside it: no coral fans, no firefly bush, no
// `pale_oak` anything, half the stone slabs, the banners, the heads, and
// `pumpkin` and `short_grass`.
//
// Nobody had noticed, because a missing block is invisible from inside the app
// -- you cannot miss what the inventory never offered. That is the same failure
// the hand-written `DEFAULT_STATE` had, one layer down.
//
// So the bulk now comes from `resources/block_states.json`, which is the game's
// own registry with provenance, refreshed by `.claude/skills/mc-blockstates`.
// Two smaller sources sit beside it, and both earn their place.

import { readFileSync } from "node:fs";

const P = "minecraft:";

// --- source 1: the vendored registry ----------------------------------------
const registry = JSON.parse(readFileSync("resources/block_states.json", "utf8"));
const ids = new Set(Object.keys(registry.blocks).map((name) => P + name));

// --- source 2: the pre-Flattening names the modern registry has dropped -----
//
// `legacy_blocks.json` maps `"id:meta"` to a flattened name, so it is a record
// of what those names *were*. Four survive only here -- `grass`, `grass_path`,
// `sign`, `wall_sign` -- and the app offers them on purpose: it writes
// schematics for 1.8 onward, and a file for 1.16 names its dirt path
// `grass_path`. Dropping them would silently stop those files round-tripping.
const legacy = JSON.parse(readFileSync("resources/legacy_blocks.json", "utf8"));
const fromLegacy = [];
for (const value of Object.values(legacy.blocks)) {
  if (typeof value !== "string") continue;
  const name = value.split("[")[0];
  if (!ids.has(name)) {
    ids.add(name);
    fromLegacy.push(name.slice(P.length));
  }
}

// --- what an editor has no business offering --------------------------------
//
// Short and explained, because every exclusion is a block somebody will one day
// look for. `air` is deliberately **not** here: it is the eraser, every empty
// cell in a document is air, and the agent names it by hand.
const EXCLUDED = new Map([
  ["cave_air", "air by another name; the game uses it for cave carving"],
  ["void_air", "air by another name; the game uses it outside loaded chunks"],
  ["test_block", "a debug block, not craftable and not in any world"],
  ["test_instance_block", "a debug block, not craftable and not in any world"],
]);
for (const name of EXCLUDED.keys()) ids.delete(P + name);

const sorted = [...ids].sort();

const header = [
  "# Block ids the generated build script and the AI tools are allowed to place.",
  "#",
  "# GENERATED -- do not edit by hand.",
  "#   node scripts/gen-block-list.mjs > block_id_list.txt",
  "#",
  `# Source: resources/block_states.json (Minecraft ${registry._source.minecraftVersion},`,
  `# union with ${registry._source.unionWith}), plus the pre-Flattening names only`,
  "# resources/legacy_blocks.json still carries.",
  "#",
  "# This list is spliced into the generation prompt, so the set the model is told",
  "# about cannot drift from the set it is judged against -- and tests/blocks.ts",
  "# requires every id here to resolve a real texture in the bundled pack.",
  "#",
];

process.stdout.write(`${[...header, ...sorted].join("\n")}\n`);

process.stderr.write(
  `${sorted.length} ids: ${Object.keys(registry.blocks).length} from the registry, ` +
    `${fromLegacy.length} only from the legacy table, ${EXCLUDED.size} excluded.\n`,
);
if (fromLegacy.length > 0) {
  process.stderr.write(`  pre-Flattening only: ${fromLegacy.sort().join(" ")}\n`);
}
process.stderr.write(
  "  excluded: " +
    [...EXCLUDED].map(([name, why]) => `${name} (${why})`).join(", ") +
    "\n",
);
