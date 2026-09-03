---
name: mc-block-versions
description: Derive which Minecraft version each block and block state exists in, and vendor it into this app's version table. Use when a new Minecraft release needs adding to the table, when a backport keeps or drops the wrong blocks, when a block that was renamed comes back as empty space, or when `resources/block_versions.json` needs refreshing.
---

# Knowing when a block arrived, and when it stopped being called that

`src/shared/block_versions.ts` is what makes changing a schematic's Minecraft
version mean anything. Without it, backporting a 1.21 build to 1.13 moved the
`DataVersion` tag and left up to 501 kinds of block in a file for a game that
has never heard of them.

The failure this skill exists to prevent is **not** an omission. It is the
opposite: a block wrongly recorded as arriving late, or a rename wrongly
recorded as a removal, makes the app **destroy** the build it was asked to
convert — replacing every one of those blocks with empty space, reporting a
healthy count, and looking entirely deliberate.

So the dates are not remembered, they are derived from two sources, checked
against each other, and recorded with where they came from.

## The shape of it

```
resources/block_versions.json     the data, with provenance   ← you edit this
scripts/gen-block-versions.mjs    JSON → the tables           ← you run this
src/shared/block_versions.ts      the tables, plus the lookups (hand-written)
```

The generator replaces only what is between the two markers. The lookups below
them — and the prose about why a rename is asked before existence — are
hand-written and stay that way.

## How this skill's trust rule differs from its siblings

| skill | what buys trust | why |
|---|---|---|
| `mc-versions` | **two independent sources that agree** | a transposed DataVersion is undetectable by any local check |
| `mc-blockstates` | **the data is the game's own, and the tripwire is mechanical** | a wrong property name fails a suite |
| `mc-blockproperties` | **corroboration** | a wrong *sentence* fails nothing, anywhere, ever |
| `mc-block-versions` | **both, on different halves of one file** | one half is diffable and one half is a judgement |

The split runs through the middle of this dataset rather than around it.

**`blocks` and `properties` are derived and mechanically checked.** They come
out of a diff, and the generator re-checks them: every label must resolve in
`resources/mc_versions.json`, every rename must meet the table at both ends,
every value map may only name values its own row declares.

**`renames` and `propertyValues` are neither.** A diff sees `chain` disappear
at 1.21.9 and `iron_chain` appear and **cannot tell that from a removal plus an
unrelated addition** — the link is prose on a wiki page and is in no dataset.
The same is true of a value map: nothing anywhere can tell you that a 1.16 wall's
`tall` should come back as `true` rather than `false`. Those rows are looked up,
corroborated, and carry their `evidence`.

**Absence is not disagreement**, which `mc-versions` already says and which here
is load-bearing rather than decorative — see the coverage trap below.

## The sources

| source | what it gives | independence |
|---|---|---|
| `raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/<version>/blocks.json` | every block at that version, with its property **names** | a community extraction, uniform across the whole range |
| `raw.githubusercontent.com/misode/mcmeta/<version>-summary/blocks/data.min.json` | every block with properties, and its property **values** | extracted from the game jar |
| `minecraft.wiki/w/<Block>` — the **History** section | when a block arrived and what it used to be called | a human transcription, and the only source for a rename |

Resolve minecraft-data's per-version path through
`data/dataPaths.json`, not by guessing: it **shares directories between
versions** (`1.16` → `pc/1.16.1`, `1.18.2` → `pc/1.18`, `1.21.10` →
`pc/1.21.9`), so its granularity is coarser than this app's version list and a
guessed path is a 404 that reads as a missing version.

**Do not read minecraft-data for property *values*.** It types an integer
property as `num_values` with no range, and its own count moves between
releases: read naively it has `snow.layers` going from 1..8 to 0..7 in 1.17 and
back in 1.18, four times over, for a property the game has never changed. Values
come from mcmeta, which lists them.

## The coverage trap, which is the reason for all of the above

**mcmeta's summary changed what it lists at 1.20.5.** Up to 1.20.4 it holds only
blocks that carry properties; from 1.20.5 it holds every block. 686 entries, then
1060, with `stone` appearing at the boundary.

A plain diff of mcmeta therefore dates `stone`, `dirt`, `cobblestone`,
`oak_planks` and some 370 others to 1.20.5. Acting on that, **a backport to 1.19
replaces every stone block in the build with empty space.** Nothing written
against the data itself could ever have caught it.

The same mechanism manufactures a false rename: `cauldron` vanishes from mcmeta
between 1.16.5 and 1.17 because its `level` property moved to `water_cauldron`,
not because the block went anywhere.

So: **block presence comes from minecraft-data, and mcmeta only corroborates.**
mcmeta's silence before 1.20.5 is meaningful for a block only when it lists that
block at every version from the claimed arrival to the end of its life — which
is to say, only when the block has always had properties.

## What reads this downstream

Two consumers, and they fail in opposite ways.

`describe_block` over MCP reports `since` and `until` from this table, through
`versionSpan`. That is what stops a model reaching for a block the open
schematic's version predates, and it is derived -- a release added here reaches
the wire with no code change.

`set_document_version`, also over MCP, is the other one, and it is the reason
the warning at the top of this file is not decorative: a client can now
backport somebody's open schematic, and this table decides what survives. The
other six datasets fail by being incomplete; a wrong row here replaces real
blocks with empty space, reports a healthy count, and looks entirely
deliberate.

The verification step is `set_document_version` on a document holding blocks
from the release under test, in both directions: forward, then back, and the
blocks must be the ones that went in. A rename that is missing shows up
precisely here and nowhere else.

## Doing it

1. **Read `resources/block_versions.json` first**, especially `coverage`. If a
   source's shape has moved since `checkedAt`, that is the finding, and it comes
   before any new rows.

2. **Fetch both sources for every flat version in `MC_VERSIONS`.** Resolve
   minecraft-data's paths through `dataPaths.json`. Two versions have one source
   each and must be handled by name: 1.13 and 1.13.2 have no mcmeta summary,
   1.21.7 and 26.2 have no minecraft-data entry. 1.21.7 is interpolated from its
   neighbours, which mcmeta shows are identical.

3. **Derive `since` and `until` per block**, oldest version first, from
   minecraft-data. Then check three things and report each:

   - **monotonicity** — a block present, absent, then present again is a data
     fault, not a re-release. minecraft-data had zero of these when this was
     written and mcmeta had exactly one, which was `cauldron`;
   - **the coverage sentinel** — `stone` must be in every version a source
     claims full coverage of;
   - **structural corroboration for 1.13/1.13.2**, which have one source: every
     block there must exist in 1.14 too, except the renames 1.14 made
     (`sign`, `wall_sign`). A violation is an unrecorded rename.

4. **Every disappearance is a rename until proven otherwise.** Take the list the
   generator prints and look each one up on the wiki's History section. Record
   the pair in `renames` with its `evidence`; only leave it out if the History
   says the block was genuinely removed, and say so in a `note`.

   There were five across the whole flat era when this was written — `sign`,
   `wall_sign`, `grass_path`, `grass`, `chain` — so this is a short list, and a
   long one is itself a finding.

5. **Derive property value changes from mcmeta only**, and write the map for
   each **in both directions, by hand**. There were seven, and only the walls'
   1.16 change touches a real build. Say in `lossy` what the backport gives up:
   `tall -> true` is not reversible and the file must say so rather than let a
   reader assume a round trip.

6. **Regenerate, and read both halves of what it says.**

   ```bash
   node scripts/gen-block-versions.mjs
   ```

   It **refuses** on a label `mc_versions.json` does not have, on a
   `sinceDataVersion` that disagrees with it, on a rename that does not meet the
   derived table at both ends, and on a value map naming a value its row does
   not declare. It **reports** — to stderr, to be read and not counted — every
   block that stops existing with no rename recorded.

   Then check idempotence by running it twice: the second run must print
   `already matches`. If it rewrites the file every time, the ordering or the
   formatting has drifted and *that* is the bug.

   ```bash
   npx tsx tests/formats.ts
   npx tsx tests/session.ts
   ```

   The first states the table's own properties, including that `stone` did not
   arrive in 1.20.5. The second is where a version change is exercised for real:
   renaming before checking existence, restating a wall, and replacing what is
   left with the document's empty space.

7. **Show the user what changed**, by block and by rename, with the wiki
   quotation for each rename, before treating anything as settled. A date with
   no provenance is indistinguishable from an invented one, and here an invented
   one deletes somebody's build.

## Notes worth having

- **Running with nothing new must change no bytes.** The six sibling generators'
  rule, and it holds here for the same reason: if it rewrites every run, the
  ordering or the formatting has drifted and that is the diff to fix, not to
  commit.

- **The table is the flat era only.** The generator refuses a pre-Flattening
  label outright. Below 1.13 the authority is `resources/legacy_blocks.json`,
  which the MCEdit writer already decides saves on — two tables answering one
  question is how they come to disagree.

- **`until` is almost never a removal.** Four of the five recorded renames are
  spellings this app still offers on purpose, and the fifth is `chain`. If a
  future disappearance really is a removal, the `note` on the row has to say so,
  because the next person to read the file will assume it is a rename nobody
  looked up.

- **Ask about specific blocks, a short list at a time.** `mc-blockstates`' rule
  and its reason: a summarising model reading a version table and reporting
  "chain became iron_chain around 1.19" is a paraphrase, and here a paraphrase
  is a wrong number that destroys blocks. That exact error has been made once
  already — the rename is 1.21.9, snapshot 25w35a — and the generator's
  both-ends check is what caught it.

- **A block outside the table is allowed everywhere.** `blockExistsIn` answers
  `true` for an id it has never heard of. The cost of an omission is a block
  that survives a backport it maybe should not have; the cost of a wrong guess
  is a block destroyed. The two are not comparable, so the doubt goes one way.

- **`blocksIn` is namespaced and the table's keys are not.** Both sources spell
  a block bare and everything in this app that consumes the set does not, so a
  set of bare names intersects `block_id_list.txt` nowhere and empties the
  inventory for every flat document. `tests/formats.ts` and `tests/ui.ts` both
  state it.
