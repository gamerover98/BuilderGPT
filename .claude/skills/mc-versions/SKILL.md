---
name: mc-versions
description: Look up Minecraft Java Edition DataVersion numbers on the web and vendor them into this app's version table. Use when a new Minecraft release needs adding, when a version is missing from the New/Save As picker, when `resources/mc_versions.json` needs refreshing, or when a DataVersion in the app looks wrong.
---

# Keeping the Minecraft version table honest

`src/shared/mc_versions.ts` decides which Minecraft versions this app offers,
which container each can be written to, and what `DataVersion` integer goes into
a Sponge schematic. That integer is the reason this skill exists: **a wrong
DataVersion produces a file that opens without complaint and misbehaves in
game** — the kind of error that is discovered a long way from here, by somebody
who has no reason to suspect the editor.

So the numbers are not remembered, they are looked up, corroborated, and
recorded with where they came from.

## The shape of it

```
resources/mc_versions.json     the data, with provenance   ← you edit this
scripts/gen-mc-versions.mjs    JSON → the table            ← you run this
src/shared/mc_versions.ts      the table, plus the era rule (hand-written)
```

The generator replaces only the rows between two markers. Everything else in
`mc_versions.ts` — the era rule, the refusal message, the prose about why Sponge
cannot exist before the Flattening — is hand-written and must stay that way.

## The rule that makes it trustworthy

**Two independent sources that agree, or the number does not ship.**

An entry without corroboration is written into the JSON with `verified: false`,
and `gen-mc-versions.mjs` leaves it out of the table, so it is never offered in
the picker. The app offers what it knows how to write correctly. The row stays
in the JSON so a later run can promote it.

Independence is about the *content*, not the URL:

- `minecraft.wiki` and `minecraft.fandom.com` are **one** source. The Fandom
  site is a fork of the same wiki.
- A version's own wiki page and the wiki's summary table are **one** source, two
  pages.
- `PrismarineJS/minecraft-data` is independent of the wiki. So is any project
  that extracts the number from the game's own `version.json`.

**Absence is not disagreement.** A source that has no entry for a brand-new
release is lagging, not contradicting. Say which it was: "one source, the other
has no entry yet" is a different situation from "two sources, different
numbers", and the second one must never be resolved by picking a favourite —
report both and stop.

## Doing it

1. **Read `resources/mc_versions.json`** to see what is already known and when
   it was last checked.

2. **Fetch the primary table.**
   `https://minecraft.wiki/w/Data_version` — every release and its DataVersion.

3. **Fetch a second, independent source.**
   `https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/common/protocolVersions.json`
   has a `dataVersion` field per release.

   Ask for **specific versions by name**, a short list at a time. A prompt like
   "list every version" is answered by a summarising model reading a hundred-row
   table, and a single transposed digit in that answer is exactly the failure
   this skill is built to prevent. Short, named, checkable.

4. **Compare.** Agreement → `verified: true` with both source keys. Absence on
   one side → `verified: false`, and say so to the user. Disagreement → report
   both numbers and change nothing.

5. **Assign the era**, by the Flattening: `1.13` and later are `flat`, anything
   earlier is `legacy`. A new release always lands on `flat`, which is what
   keeps a new version working without anybody remembering this step.

6. **Write the JSON**, newest first, and update `checkedAt`. Never overwrite a
   `verified: true` entry with a less corroborated one.

7. **Regenerate and check.**

   ```bash
   node scripts/gen-mc-versions.mjs
   ```

   Read its stderr. It lists what it left out for want of a second source; that
   list is to be **read, not counted**, the same way `gen-block-list.mjs`'s
   plausibility warnings are.

   ```bash
   npx tsx tests/formats.ts
   ```

   That suite is where versions are used for real — it checks the era rule in
   both directions, and that the generator's table is exactly the flat era
   rather than "everything with a number". The two are different sets: 1.12.2
   has a DataVersion of 1343 and still cannot be written as Sponge.

8. **Show the user the sources** before treating anything as settled. A number
   with no provenance is indistinguishable from an invented one, and that is the
   whole point of the file.

## Notes worth having

- **DataVersion began in snapshot 15w32a.** Versions before 1.9 have none at
  all, so `dataVersion: null` for 1.8.x is the fact, not a gap. `writers.ts`
  omits the tag when it is null, which is what an MCEdit file wants anyway.
- **A legacy version having a DataVersion is not a contradiction.** 1.12.2 is
  1343. What it lacks is a container that can carry one, because Sponge is
  refused for its era.
- **The name format is `JE_<label with dots as underscores>`** — `1.21.4` →
  `JE_1_21_4`, `26.2` → `JE_26_2`. These names round-trip through saved settings,
  so renaming an existing one silently resets somebody's chosen version.
- **Running with nothing new must change no bytes.** The generator prints
  "already matches" and exits. If it rewrites the file every time, something in
  the ordering or formatting has drifted and should be fixed rather than
  committed.
