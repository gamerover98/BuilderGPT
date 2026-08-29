---
name: mc-commands
description: Look up the Minecraft command syntax and command limits this app writes into a .mcfunction, and vendor them into its table. Use when an exported .mcfunction is rejected by the game, when a build placed by one comes out truncated or incomplete, when adding support for a new Minecraft release, or when `resources/command_syntax.json` needs refreshing.
---

# Keeping the command table honest

`src/shared/command_syntax.ts` holds the two commands this app writes into a
`.mcfunction` and the two limits that decide how it writes them. The two halves
are held to **different standards**, and knowing which is which is most of this
skill.

## The syntax cannot lie for long

`setblock <pos> <block>` and `fill <from> <to> <block>` are checked
mechanically: the writer emits them, the reader parses them back, and
`tests/formats.ts` fails on a document that does not survive the round trip. One
good source is enough — this is `mc-blockstates`' rule, not `mc-versions`'.

So the job for the syntax rows is to keep the **tripwire** honest, not to count
sources. If you change a form, the round trip must still cover it.

## The limits cannot fail here at all

Neither of these is observable from inside this repo, ever:

- a function past **`max_command_sequence_length`** (65,536) has its remaining
  commands **ignored, with no error**. The file is valid, the game accepts it,
  and the build is simply missing its top half.
- a `fill` past **`max_block_modifications`** (32,768) places nothing and
  reports nothing useful.

No test here can see either, because neither is a property of the file. So those
rows are corroborated like `mc-versions`' numbers, and the writer stays strictly
*inside* them rather than at them.

## The shape of it

```
resources/command_syntax.json     the data, with provenance   ← you edit this
scripts/gen-command-syntax.mjs    JSON → the two tables       ← you run this
src/shared/command_syntax.ts      the tables, plus the constants derived from them
```

`MAX_COMMANDS_PER_FUNCTION` and `MAX_FILL_VOLUME` are **read out of the limits
table**, not written beside it. That is the point of vendoring them: refreshing
the data moves the writer, and there is no second copy of 32,768 anywhere to
drift.

## Doing it

1. **Read `resources/command_syntax.json`** for what is known and when it was
   last checked.

2. **Fetch the command pages** and ask for the syntax line *and the History
   section*, by name:

   - `https://minecraft.wiki/w/Commands/setblock`
   - `https://minecraft.wiki/w/Commands/fill`

   The History section is the half that matters. The current syntax tells you
   what the newest release accepts; only the history tells you the oldest one
   that accepts the same spelling, which is the number this app writes down.

3. **Fetch the limits**, from two places that state them independently:

   - `https://minecraft.wiki/w/Function_(Java_Edition)` — states the function
     command limit in prose, in the page about functions.
   - `https://minecraft.wiki/w/Game_rule` — states both game rules, their
     defaults, and when they were renamed.

   Ask about **one rule at a time, by name**. Asked to summarise the whole game
   rule table, a model will hand back a neighbouring rule with a similar name:
   `max_command_forks` is about `/execute` contexts and is not this.

4. **Cross-check `sinceDataVersion` against `resources/mc_versions.json`**,
   which is the corroborated table. The generator refuses on disagreement. If a
   release is missing there, run the `mc-versions` skill first.

5. **Write the JSON**, with `evidence` quoting the wiki line each fact came
   from, and update `checkedAt`.

6. **Regenerate and check.**

   ```bash
   node scripts/gen-command-syntax.mjs
   npx tsx tests/formats.ts
   ```

   Then run the generator a second time: it must print "already matches".

7. **Show the user the wiki sections** before treating anything as settled.

## Notes worth having

- **The mode word is left off on purpose.** Omitted means `replace`, which is
  what a schematic wants, and the bare form is the one spelling every release
  from 1.13 accepts. 1.21.5 added `strict` and made `replace` non-terminal;
  both are additions, and the bare form never had to know.
- **1.13 is the floor, and it is not the litematic floor.** The bracketed
  block-state syntax is older — 1.11 added it — but flattened ids are not, and
  `birch_stairs[facing=south]` means nothing to 1.12. `.litematic` starts a
  release later still, at 1.13.2, because Litematica's own reader converts
  anything below DataVersion 1631. Two formats, two answers; keep both.
- **Splitting a function does not raise the ceiling.** A dispatcher calling
  twenty parts still runs every one of their commands against one budget of
  65,536. What splitting buys is that each part is runnable on its own, and that
  the output is editable. The writer says so in the dispatcher rather than
  letting the game trim the build in silence — if that sentence ever stops being
  true of the game, this is the row to change.
- **Game rule names churn; the defaults do not.** 25w44a renamed every rule to
  snake_case. `formerName` and `renamedIn` are kept so a message can name
  whichever spelling the user's version has.
- **Running with nothing new must change no bytes.**
