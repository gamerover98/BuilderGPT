---
name: mc-blockstates
description: Look up a Minecraft block's state properties on the web — the legal values, the vanilla defaults, and when they changed between versions — and vendor them into this app's generated table. Use when a placed block shows no properties in the inspector, when a property name or value looks wrong, when adding a block family to the orientation or connection tables, or when `resources/block_states.json` needs refreshing.
---

# Knowing what properties a block actually has

A block state is the part of a block that is not its name: `facing`, `half`,
`north`, `age`, `shape`. This app writes them, reads them, meshes from them and
saves them, and until this skill existed it **invented** them.

Two failures, and they are mirror images.

**A property written onto a block that does not carry it** is invisible here and
fatal there. Nothing in this codebase validates a property name: the inspector
shows whatever the entry has, the writers put whatever they are given into the
file, and the mesher ignores what it does not recognise. The schematic then
lands in a game that refuses the block — a long way from here, in front of
somebody who has no reason to suspect the editor.

**A property missing** is an empty inspector and a block drawn wrong.
`block_shapes.ts` reads `entry.properties.north` to decide whether a fence has an
arm on its north side; a fence placed without that property is a bare post, and
the panel that exists to let you fix it has nothing to show.

So the properties are not remembered. They are looked up, vendored with
provenance, and checked mechanically.

## The shape of it

```
resources/block_states.json     the data, with provenance   ← you edit this
scripts/gen-block-states.mjs    JSON -> the table           ← you run this
src/shared/block_states.ts      the table, plus the hand-written rules
```

The generator replaces only the rows between two markers. Everything above and
below them — the exclusions, the lookup helpers, the prose explaining why
`waterlogged` is not there — is hand-written and must stay that way. This is the
same arrangement as `resources/mc_versions.json`, for the same reason.

`src/shared/block_orientation.ts` is **not** generated and must not become so.
It answers "which way does a block placed by this click point", which depends on
where the camera was. No dataset knows that.

## How this skill's trust rule differs from `mc-versions`

`mc-versions` buys trust with **two independent sources that agree**, because a
transposed digit in a DataVersion is undetectable by any check this repo could
run: the file saves, opens, and misbehaves in game.

A wrong property is not like that. It is **mechanically detectable**:

- every block id must appear in `block_id_list.txt`
- every property this app writes must appear in the generated table for that
  block
- every value must be one the table lists

So this skill's job is not to count sources — it is to **keep the tripwire
honest**, and to be sure the data feeding it is the game's own. Corroboration
still matters where the machine cannot check: the *history*, which is prose on a
wiki page and appears in no dataset. Disagreement is still resolved the same
way — report both and change nothing.

## The sources

| source | what it gives | independence |
|---|---|---|
| `raw.githubusercontent.com/misode/mcmeta/summary/blocks/data.json` | every block -> `[{prop: [legal values]}, {prop: default}]` | extracted from the game jar |
| `raw.githubusercontent.com/InventivetalentDev/minecraft-assets/<version>/assets/minecraft/blockstates/<block>.json` | which model each state selects — names the properties that *render* | extracted from the game jar |
| `minecraft.wiki/w/<Block>` | the **Block states** table, and the **History** section | a human transcription, genuinely independent |

`PrismarineJS/minecraft-data`'s `blocks.json` also carries states, and is what
`resources/legacy_blocks.json` already comes from — but it is about a megabyte
and **WebFetch truncates it silently**, answering "I could not find that block"
for a block that is in the file. Use it only through a per-version path you have
confirmed is small, or not at all.

**Ask about specific blocks, a short list at a time.** The same discipline
`mc-versions` states, and here it has a second reason: a summarising model
reading a 900-entry table and reporting "the fence has north, east, south, west"
is a paraphrase, and a paraphrase is where a value quietly becomes `true|false`
when the game says `none|low|tall`.

## Version drift is the substance, not a footnote

This app offers Minecraft 1.8 through the present. Properties are not stable
across that range, and the interesting changes are the ones that *look like*
nothing:

- **`grass` -> `short_grass` in 1.20.3.** A rename. Both spellings are in
  `block_shapes.ts`'s `CROSS_BLOCKS` today because of it.
- **`grass_path` -> `dirt_path` in 1.17.** Both are in `SPECIAL_FACE_RULES`.
- **`sign` -> `oak_sign` in 1.14.** The bare `sign` is still in
  `block_id_list.txt`.
- **Walls, 1.16 (snapshot 20w06a): `north`/`east`/`south`/`west` changed from
  `true|false` to `none|low|tall`.** This is the one to recognise by shape — a
  **type** change wearing the costume of a value change. Code that tests
  `properties.north === "true"` does not fail on a 1.16+ wall, it silently reads
  every connection as absent. `block_shapes.ts`'s `wall()` handles it and
  `fence()` deliberately does not, because a fence never made that change.

Record the version a property applies to. Do not fold two eras into one row.

**Pre-Flattening is not this table's business.** Before 1.13 a block state is a
metadata nibble, and `resources/legacy_blocks.json` already maps
`"id:meta" -> "minecraft:name[state]"`. `shared/mc_versions.ts` draws that
boundary. If a question is about 1.12.2 or earlier, the answer is in the legacy
table, not here.

## `waterlogged` is excluded on purpose, and here is the evidence

`legacy_blocks.json` maps

```
85:0  ->  minecraft:oak_fence[east=false,south=false,north=false,west=false]
101:0 ->  minecraft:iron_bars[east=false,south=false,north=false,west=false]
53:0  ->  minecraft:oak_stairs[half=bottom,shape=outer_right,facing=east]
```

The MCEdit writer matches a block's **exact** state against that table and
reports anything else as `degraded`. So:

- writing the four connections **improves** the legacy match — those rows expect
  them;
- writing `shape` on stairs likewise;
- writing `waterlogged=false` **breaks** it, on every stair, slab, fence, wall
  and pane in the build, turning a clean 1.12 save into a page of degraded
  reports.

`waterlogged` also carries nothing anyone hand-edits, and did not exist before
1.13. The generator therefore drops it, and the reason lives in a comment beside
the exclusion — not only here — because this is precisely the kind of rule a
future refresh removes for looking arbitrary.

## Doing it

1. **Read `resources/block_states.json`** to see what is known and when it was
   last checked.

2. **Fetch the summary.**
   `https://raw.githubusercontent.com/misode/mcmeta/summary/blocks/data.json`

   Its entries look like:

   ```json
   "acacia_fence": [
     { "east": ["true","false"], "north": ["true","false"],
       "south": ["true","false"], "waterlogged": ["true","false"],
       "west": ["true","false"] },
     { "east": "false", "north": "false", "south": "false",
       "waterlogged": "false", "west": "false" }
   ]
   ```

   Index 0 is the legal values, index 1 is the vanilla default state.

3. **Corroborate anything you are about to hand-write** — a connection rule, a
   family in `block_orientation.ts`, a claim about which version introduced
   something — against the block's wiki page. The dataset has no history and the
   wiki has no machine-readable defaults; they are complementary, not redundant.

4. **Write the JSON**, blocks sorted, `checkedAt` updated, and the `_source`
   block naming the URL and the commit or tag it was read at. A value with no
   provenance is indistinguishable from an invented one.

5. **Regenerate.**

   ```bash
   node scripts/gen-block-states.mjs
   ```

   Read its stderr: it reports blocks in the dataset that are not in
   `block_id_list.txt` and vice versa. That list is to be **read, not counted** —
   a block missing from one side is usually a rename, which is the thing this
   skill exists to catch.

6. **Check.**

   ```bash
   npx tsx tests/blocks.ts
   ```

   That suite is where the table is used for real: every id against
   `block_id_list.txt`, every property this app writes against the table, and the
   placement states end to end.

7. **Show the user what changed**, by block, before treating it as settled.

## Notes worth having

- **Running with nothing new must change no bytes.** The generator prints
  "already matches" and exits. If it rewrites the file every run, the ordering or
  formatting has drifted and that is the bug, not the diff.
- **An empty property bag is a real answer.** `minecraft:stone` has no
  properties, and the inspector saying so is correct. Do not invent one to make
  the panel look full.
- **A default is not a truth claim.** `facing=north` on a door is not more
  correct than `facing=south`; it is what the file would have carried anyway,
  written where the inspector can show it. `orientPlacement` overrides it,
  because only that function looked at the camera.
- **`_stem` is not a suffix.** `crimson_stem` is a pillar with an `axis`,
  `melon_stem` is a crop with an `age`. `block_orientation.ts` says so already;
  the same trap is live for anything matched by ending.
