---
name: mc-litematic
description: Look up which Litematica schematic format version a Minecraft release writes, and vendor it into this app's table. Use when a .litematic fails to open, when Litematica refuses or silently converts a file this app wrote, when a new Minecraft release needs adding to the litematic writer, or when `resources/litematica_versions.json` needs refreshing.
---

# Keeping the Litematica version table honest

`src/shared/litematica_versions.ts` decides which `Version` and `SubVersion`
this app stamps on a `.litematic`, and from which Minecraft release the
container is offered at all. Both numbers matter for the same reason this skill
exists: **Litematica reads a file according to what it says it is.**

Below schematic version 5, *or* below Minecraft DataVersion 1631, its reader
runs the palette through `convertBlockStatePalette_1_12_to_1_13_2`. So a file
carrying a modern flattened palette under an old label does not fail — it comes
back converted. The user sees a build made of the wrong blocks and has no reason
to suspect the editor that wrote it.

That is the same shape of failure as Sponge v2 and v3 both spelling a tag
`Offset` and not meaning the same vector by it: silent in both directions, and
discovered a long way from here.

## The shape of it

```
resources/litematica_versions.json     the data, with provenance   ← you edit this
scripts/gen-litematica-versions.mjs    JSON → the table            ← you run this
src/shared/litematica_versions.ts      the table, plus the rules (hand-written)
```

The generator replaces only the rows between two markers. The prose above them
— why the floor is 1.13.2 rather than 1.13, why block storage stopped moving at
version 5, why `litematicCanCarry` refuses a `null` DataVersion instead of
defaulting — is hand-written and stays hand-written.

## What corroboration means here

Two independent sources that agree, as in `mc-versions`, and for the identical
reason: nothing local can detect a wrong `Version`. The file writes, opens, and
misbehaves in somebody else's Minecraft.

The two sources are not "two web pages". They are:

1. **The mod's own constants**, read per branch. `SCHEMATIC_VERSION` and
   `SCHEMATIC_VERSION_SUB` in
   `src/main/java/fi/dy/masa/litematica/schematic/LitematicaSchematic.java`.
   A *boundary* needs two branches: the one that has the new number and the one
   before it that still has the old one. One branch alone tells you a version
   exists, not when it started.
2. **litemapy**, `litemapy/info.py` — `LITEMATIC_VERSION`,
   `LITEMATIC_SUBVERSION` and `MC_DATA_VERSION` together. It is an independent
   reimplementation, and the fact that it pairs version 6 with DataVersion 2975
   is a second statement of the 6-starts-at-1.18 boundary.

Where a version is only claimed by prose — a changelog, a discussion thread —
record it in `evidence` and leave `verified: false`. The generator drops it and
prints it to stderr. That list is to be **read**, not counted.

## What reads this downstream

`LITEMATIC_MIN_LABEL` is now quoted **to an MCP client**, not only to the
format picker: `versionRangesSentence()` in `src/shared/mc_versions.ts` reads
it, and every MCP tool that takes a version puts that sentence in its schema.
So a model choosing a container is told this floor in the words this file
decides.

Nothing there has to be edited when the floor moves -- it is read, not copied,
which is the same arrangement `formatsFor` already had. It is written down
because the alternative is somebody finding the sentence in a tool description
and hard-coding 1.13.2 into it.

## Doing it

1. **Read `resources/litematica_versions.json`** for what is known and when it
   was last checked.

2. **Find the branches.** `maruohon/litematica`'s default branch is the 1.12.2
   legacy one; the modern work is on `pre-rewrite/fabric/<mc version>` branches
   and, more recently, on the `sakura-ryoko/litematica` fork whose default
   branch is named after the Minecraft version. List them:

   ```
   https://api.github.com/repos/maruohon/litematica/branches?per_page=100
   ```

3. **Read the constant on the branch you care about and on the one before it.**

   ```
   https://raw.githubusercontent.com/maruohon/litematica/pre-rewrite/fabric/1.18.x/src/main/java/fi/dy/masa/litematica/schematic/LitematicaSchematic.java
   ```

   Ask for **named constants**, not "what changed". A summarising model handed a
   thousand-line Java file will paraphrase, and a paraphrase of an integer is
   how a boundary lands one release out.

4. **Get the DataVersion from `mc-versions`, not from here.** This file records
   `sinceDataVersion`, and it must equal what `resources/mc_versions.json` says
   for that release. The generator refuses on disagreement — that check has
   already caught one wrong number (1.18 written as 2825, which is a snapshot;
   the release is 2860). If the release is missing from `mc_versions.json`, run
   the `mc-versions` skill first.

5. **Write the JSON.** Newest version first, `evidence` naming the branch each
   constant was read from, and update `checkedAt`. Never overwrite a
   `verified: true` row with a less corroborated one.

6. **Regenerate and check.**

   ```bash
   node scripts/gen-litematica-versions.mjs
   npx tsx tests/formats.ts
   ```

   Read the generator's stderr. Then check idempotence by running it twice: the
   second run must print "already matches". If it rewrites the file every time,
   the ordering or the formatting has drifted and *that* is the bug.

7. **Show the user the branches and the constants** before treating anything as
   settled. A version number with no provenance is indistinguishable from an
   invented one.

## Notes worth having

- **The floor is 1.13.2, not 1.13.** The app's own era rule calls 1.13 flat and
  is right about Sponge. Litematica's reader converts anything below
  DataVersion 1631, so this container starts one release later. Do not "fix"
  that to match the era rule.
- **Versions 6 and 7 do not change block storage.** The palette, the packed
  longs and `Position`/`Size` have been the same since 5. What moved is what
  goes inside an entity or a block entity, and this app carries that NBT
  verbatim — which is why one decoder reads all three and why the writer's only
  version-dependent decision is which number to stamp.
- **`SubVersion` is absent, not zero, before version 6.** Litematica reads it as
  `nbt.get("SubVersion", 0)`. Writing `SubVersion: 0` into a version 5 file
  would be writing a tag that era never had.
- **Versions 1 to 4 are pre-Flattening and are not writable.** They are kept in
  the JSON with what is known about them because a refusal that can name the
  version is better than one that cannot, and because "nobody has told us what
  changed at 4" is a fact worth keeping rather than a gap to fill by guessing.
- **Running with nothing new must change no bytes.**
