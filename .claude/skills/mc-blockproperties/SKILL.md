---
name: mc-blockproperties
description: Look up what a Minecraft block state property *means* — what it controls, and when its meaning or its type changed between versions — and vendor the prose into this app's generated reference. Use when `describe_block` answers `description: null`, when the generator reports an undescribed property/value combination, when a description reads wrong, or when `resources/block_properties.json` needs refreshing after the block registry moves.
---

# Saying what a block state is *for*

`mc-blockstates` vendors the game's own registry: which properties a block has,
what values they take, and what state it is born in. That is enough to validate
an edit and enough to fill a dropdown.

It is not enough to **choose**. `signal_fire` and `lit` are both booleans on a
campfire, and nothing in the registry says one makes a tall column of smoke and
the other decides whether the fire is burning at all. `half` is `top|bottom` on
a staircase and `upper|lower` on a door, and those are not the same question
asked twice — one is which half of a cell the block occupies, the other is which
of two blocks this one is.

This skill vendors the sentence. `describe_block` in `src/main/agent/tools.ts`
serves it to whichever model is driving the app, which is the whole reason it
has to be right: a plausible sentence about a property is acted on.

## The shape of it

```
resources/block_properties.json    the prose, with provenance   ← you edit this
scripts/gen-block-properties.mjs   JSON -> the table            ← you run this
src/shared/block_properties.ts     the table, plus the lookups
```

The generator replaces only the rows between two markers. The lookups above and
below them, and the prose explaining what is *not* decided there, are
hand-written and must stay that way. Same arrangement as `mc_versions.json` and
`block_states.json`, for the same reason.

## Keyed by property and value set, not by block

1197 blocks carry 93 distinct property names between them, in **121 distinct
forms**. The key is the pair — the name, and the exact set of values.

Keyed by block, `facing` would be described 335 times and the 335 copies would
drift. Keyed by name alone, a fence and a wall would have to share one sentence
about `north` while the game gives them different **types**.

That second one is not hypothetical, and it is the reason the key is what it is:

> **A wall's `north` is `none|low|tall`; a fence's is `true|false`.** Code that
> tests `properties.north === "true"` does not fail on a 1.16+ wall — it
> silently reads every connection as absent. `block_shapes.ts` has a `wall()`
> that knows this and a `fence()` that deliberately does not.

13 of the 93 properties appear in more than one form. They are the 13 that
matter.

## How this skill's trust rule differs from both its siblings

| skill | what buys trust | why |
|---|---|---|
| `mc-versions` | **two independent sources that agree** | a transposed DataVersion is undetectable by any local check |
| `mc-blockstates` | **the data is the game's own, and the tripwire is mechanical** | a wrong property name fails a suite |
| `mc-blockproperties` | **corroboration** | a wrong *sentence* fails nothing, anywhere, ever |

This is the `mc-versions` rule arrived at from the other direction. A wrong
description is invisible to every check this repo could ever run: the file
saves, the block is placed, the picture is right, and a model reads the sentence
and builds the wrong thing on the strength of it.

So: **do not write a description from memory.** Look it up, and where the claim
is about behaviour rather than about a name, corroborate it. Where two sources
disagree, report both and change nothing — unless the game's own data settles
it, which happens more here than it does for versions (see below).

What is *not* on you to establish: the values and the defaults. Those come from
`block_states.json`, and the generator refuses a row naming a combination the
registry does not have.

## The sources

| source | what it gives | independence |
|---|---|---|
| `minecraft.wiki/w/Block_states` | the canonical table: every property, its values, a one-sentence description | a human transcription |
| `minecraft.wiki/w/<Block>` | the per-block **Block states** table and the **History** section | the same wiki, but written and edited separately |
| `resources/block_states.json` | the values and the defaults, from the game jar | the game itself |

The third one is a genuine arbiter and should be used as one. A worked example
from this file's first pass:

> `minecraft.wiki/w/Block_states` says the sign and banner `rotation` default
> changed from 0 to 8 in **26.1 (snapshot 11)**. `minecraft.wiki/w/Sign` says
> the default "has consistently been 0". The vendored registry, pinned at 26.2,
> says **`"rotation": "8"`** — so the Block_states page is right and the Sign
> page's History section is stale. Both are recorded in the row's `versions`
> note, because the next person to check will find the same contradiction.

## Version drift is the substance, not a footnote

This app writes schematics for 1.8 onward, so a property's history is part of
its meaning. The changes worth recording are the ones that *look like* nothing:

- **A type change wearing the costume of a value change.** Walls, 1.16
  (20w06a): `north`/`east`/`south`/`west` went from `true|false` to
  `none|low|tall`. Nothing breaks loudly.
- **A default moving.** Sign and banner `rotation`, 26.1: 0 to 8. A file written
  before and after that release describes two different-looking builds from the
  same prose.
- **A property that used to be a different block.** Before 1.13 a lit block was
  a separate id — furnace 61 against lit furnace 62 — so `lit` does not exist in
  a pre-Flattening file at all. `legacy_blocks.json` turns the numeric pair into
  `lit=true` on the way in.

Record the version as the wiki names it, and say what the change *costs* rather
than only that it happened. A note that reads "changed in 1.16" tells the next
reader nothing they can act on.

## Doing it

1. **Read `resources/block_properties.json`** to see what is described and when
   it was last checked.

2. **Find out what is missing.**

   ```bash
   node scripts/gen-block-properties.mjs
   ```

   Its stderr reports every property/value combination the registry has and
   this file does not, with a block count and an example. That list is the work.

3. **Look up a short list at a time.** Start from
   `minecraft.wiki/w/Block_states`, which has the canonical one-line
   description, then open the block's own page for anything about *behaviour* or
   *history*.

   **A short list, deliberately.** A model asked to summarise a 121-row table
   paraphrases, and a paraphrase is exactly where `none|low|tall` quietly
   becomes `true|false`.

4. **Write the row.** `values` copied from `block_states.json` — not retyped —
   `description` in one or two sentences, `versions` only where there is a real
   source, and `sources` only for a page beyond the ones in `_source`.

5. **Regenerate, and read the two halves of what it says.**

   ```bash
   node scripts/gen-block-properties.mjs
   ```

   - A row naming a combination the registry does not have **fails the build**.
     Do not widen the check: the row describes something that is not in the
     game, or the registry has moved under it — a rename, or a type change.
   - A combination with no row is reported and nothing more.
     `describe_block` answers `description: null`, which is honest.

6. **Check.**

   ```bash
   npx tsx tests/blocks.ts
   ```

   That suite states the cross-check from both sides, and states the fence/wall
   distinction by name.

7. **Show the user what changed**, by property, before treating it as settled.

## Notes worth having

- **Running with nothing new must change no bytes.** The generator prints
  "already matches" and exits. If it rewrites the file every run, the ordering
  or the formatting has drifted, and that is the bug rather than the diff.
- **A description is not a defaults claim.** `describe_block` gets the default
  from the registry, and `waterlogged` deliberately has none — it is legal on
  hundreds of blocks and is not part of what a placed one is born with. Do not
  write "defaults to false" into a description; it would contradict the
  `placedAs` string in the same answer.
- **Describe the property, not the block.** `facing` on a staircase and `facing`
  on a wall torch differ in which direction counts as the front, and that
  belongs in the sentence as a named exception — not as a second row, because
  the value set is identical and the generator would refuse it as a duplicate of
  a combination already described.
- **Say what a value means where the name does not.** `tip_merge`,
  `single_wall`, `ascending_east` and `inner_left` are opaque; `true` and
  `false` are not.
- **A property that is only ever set by the game is worth saying so about.**
  `instrument` is derived from the block under a note block, and a model told
  that will stop trying to set it.
