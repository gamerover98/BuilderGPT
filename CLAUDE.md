# Schematic AI Studio — operating manual

An Electron desktop app for editing Minecraft schematics, by hand and by AI.
Node/TypeScript main process, Svelte 5 renderer, Three.js viewport.

The product name is **Schematic AI Studio**. At 1.0.0 the two *install*
identifiers were renamed with it — `package.json`'s `name` is
`schematic-ai-studio` and `appId` is `it.gamerover98.schematicaistudio` — which
is a one-time cost taken deliberately before the app had an audience: the name
is what `app.getName()` returns and therefore what Electron calls the userData
directory, so an older install's settings, encrypted keys, conversations and
version history sit under `buildergpt` and are not read. Nothing migrates them.

**The IPC channels stay `bgpt:` and the contextBridge key stays `window.bgpt`.**
Those are internal wire names that no user ever sees, so renaming them is churn
with a failure mode — main and preload disagreeing on a channel — and no
benefit. Rename branding; leave a wire name alone unless there is a concrete
reason.

**A rename has one pair with nothing linking it: `package.json`'s `name` and
the `app` string in `resources/mcp-bridge.mjs`.** The bridge is dependency-free
plain Node run by the *client's* node, so it cannot import the manifest, and
nothing fails at build time when the two drift. They drifted on exactly this
rename, and the symptom is that every part of the app keeps working while the
stdio bridge alone reports the server is off with it plainly running.
`tests/mcp.ts` spawns the bridge against a fake `APPDATA`, which is the only
check that can see it.

It began as a Python/Streamlit generator and was ported in full, then grew an
editor around the generated output. The Python sources are gone from the working
tree; they remain in git history as the spec.

## Layout

```
src/
  shared/     types crossing the process boundary — ipc.ts (channel list),
              settings.ts, schematic.ts (the container-format union)
  main/       everything privileged: fs, network, the JS sandbox, the schem->GLB pipeline
    ipc/      ipcMain.handle registrations — thin, no business logic
    domain/   document.ts (the mutable schematic), history.ts (transactions, undo)
    agent/    agent.ts (the AI tool loop), tools.ts (what it may do)
    services/ session (the open document), writers, llm, opencode, generate,
              preview, schematic, output, settings-store, snapshots, …
    pipeline/ schem -> GLB (loader, loader_formats, model_baker, mesher, atlas, …)
    mcp/      the MCP server: policy.ts (the rules, pure), tools.ts (dispatch
              and the queue), lifecycle.ts + document_tools.ts (the two
              non-agent tables), server.ts (the listener)
    core.ts   sandboxed execution of LLM-generated build scripts
    menu.ts   the application menu + window title (Electron half)
    menu_model.ts  what the menu contains, as data — testable, no Electron
  preload/    contextBridge — the only renderer↔main surface
  renderer/   Svelte 5 UI + the Three.js viewer
resources/    shipped as extraResources: the default pack, legacy_blocks.json,
              opencode_models.json, mcp-bridge.mjs
tests/        the automated suites (see Commands)
scripts/      build / start / check, in PowerShell and sh; gen-block-list.mjs
```

## The shape of the thing

There is **one open document at a time**, owned by `services/session.ts`.
Nothing else holds a reference to it. Every path in and out goes through there:

```
loader ─► SchematicDocument ─► mesher ─► GLB ─► viewer
             ▲        │
   UI edits ─┤        └─► writers ─► file
   AI tools ─┘
        (both via history.ts transactions)
```

The renderer holds no schematic. It gets `DocumentState` — a flat summary — and
a GLB, and every edit is a request. That is why the UI disables its buttons from
the state main last returned rather than from anything it tracks itself.

## Commands

```bash
scripts/start.sh          # or scripts\start.ps1   — dev mode, hot reload
scripts/build.sh          # or scripts\build.ps1   — typecheck + build into out/
scripts/build.sh --package win   # ...and produce an installer in release/
scripts/check.sh          # or scripts\check.ps1   — typecheck + all four test suites
```

They are thin wrappers over the npm scripts, which stay the source of truth:
`npm run dev｜build｜typecheck｜package:{win,linux,mac}｜smoke｜smoke:{hello,sandbox,services,schematics,blocks,document,history,formats,session,agent,mcp}`.

`check.sh` runs typecheck plus every suite and does **not** stop at the first
failure — a runner that aborts early hides how much else is broken.

## Invariants — do not quietly change these

**The document's palette is append-only while editing.** Clearing an entry that
fell out of use renumbers the ones after it, and the undo stack is full of those
numbers. `compactPalette` therefore invalidates every recorded delta and is only
safe when the history is being discarded too. It is **not** a save-time step,
whatever an earlier comment claimed: the writers build their own local palette
from the voxels instead, which reaches the same file without touching the
document.

**The editor imposes no footprint; the document follows the region.** A
selection may be dragged outside the schematic, and a **fill** into it grows the
document to contain it (`domain/grow.ts`) — one transaction, so growing and
filling are one undo step, with the resize first because a block delta recorded
before it would index the old shape. The grid has no negative coordinates, so
reaching below the origin moves the *content* up and the region with it; that
sign is the part that fails silently.

**A single placed block grows it too, and for a while it did not.** That
asymmetry was invisible from either side: `document.setBlock` refuses an
out-of-bounds write by returning `null`, so a block placed past the edge came
back `changed: 0` and read as a click that had missed. In flight that *is* how
you build outwards — right-click the outer face of an edge block — so the one
gesture with no answer was the one that mode exists for, while the same act
done by dragging a selection and filling it worked. One editor, two answers,
depending on which door you came in by. `applyEdit`'s `setBlock` arm now takes
the same path as `fill`, including the volume guard.

**Two slabs meeting in one cell are one double slab.** In the game a slab placed
against the top of a matching bottom slab does not go in the cell above — it
fills the one already there. The editor stacked them, which is a shape the game
cannot hold: the file pastes back looking nothing like it did here.

`EditRequest.setBlock` carries `against` for exactly this rule and nothing else.
`x/y/z` is the *empty* cell the click landed in, and the mesh has no per-block
identity, so **neither side can find the clicked slab alone** — main has the
document but not the direction, the renderer has the direction but not the
document. Vertical faces only: the game also merges on a side click, and that
needs where on the face the cursor was, which does not travel. Merging on a side
click that meant "place beside it" would destroy the slab already there. A fill
carries no `against`, which is what keeps this a click gesture rather than
something that halves a filled region.

**A block placed into water comes out waterlogged.** That is what the game does
— a fence, a slab or a stair put into a pond displaces nothing, it floods — and
`floodedPlacement` is what makes the property reachable without opening the
inspector for every block of a jetty. Three guards, each a way it could be
wrong: only if `hasProperty` says the block can hold it, so stone does not come
back carrying a state no version of it has; only if the request did not spell it
out, because a caller that did meant it; and only water, where a cell holding a
*waterlogged* block counts, since that cell is water too.

**A bed is two blocks, a door is two blocks, and placing one places both.** A
lone bed foot is a state the game cannot hold — it drops as an item the moment
anything updates it, and until then it draws as half a bed — and a lone door
half is a door you walk through. Both were written as one block, so the
schematic looked right here and came apart when it was pasted.

`TWO_PART` in `services/session.ts` is the table and there are two rows, which
is one more than there are shapes of answer: the far cell is one step along
`facing` for a bed — where the camera was looking when the block was picked up —
and always the cell above for a door. Both halves go in **one transaction**, or
Ctrl+Z would take a door back a half at a time. `_trapdoor` does not end in
`_door` (it ends "pdoor"), which is why the suffix needs no guard and why
`tests/session.ts` says so out loud: it is a true sentence about string endings
that nobody would check and everybody would rely on.

**Nothing is placed if the far half has nowhere to go.** That is the game's rule
and it is the safe half of it: refusing over a flower is a smaller wrong than
destroying what was there, and the block in the way is on screen, so the silence
says as much as a message would. A cell *outside* the document is not a
refusal — the region the growth is measured against spans both cells, so a bed
laid at the edge or a door hung at the ceiling makes room exactly as a single
block does.

A request that already names the far half — `part=head`, `half=upper` — is
somebody placing one on purpose: the inspector, a paste, an agent tool. Those
are left alone. Only an absent value, or the near one, means "place the whole
thing".

A door's `hinge` is **not** derived, here or in `connect.ts`. Vanilla decides it
at the click from the neighbours and from which side of the block was hit, and
then never revisits it — so it is neither a placement fact this file knows nor a
neighbour rule, and it stays at its default where the inspector can change it.

**Breaking never grows.** A break is `setBlock` with air, and growing to make
room for air is a resize and nothing else — the same reason `replace` does not.
Nothing sends a break from outside the box today, because a break comes from a
pick and the block therefore exists; the guard exists so that stays true, and
`tests/session.ts` fails without it.

**A schematic's Minecraft version can be changed in place, and the container
deliberately cannot.** `setDocumentVersion` moves `doc.dataVersion` and stops
there. `doc.format` is what a plain Save writes back, so flipping it under an
open file would leave the next Ctrl+S writing MCEdit bytes into something still
called `.schem`; a version the open container cannot carry is refused with
`refusalFor`'s own sentence and the panel points at Save As and Convert, which
change the pair together.

It is **one transaction**, so Ctrl+Z takes back the version *and* the blocks a
backport dropped, together. That costs nothing to arrange -- `HeaderState` has
captured and restored `dataVersion` since it existed -- and getting it wrong
would leave the one edit nobody could undo being the one that changed what game
the file is for.

A backport is **refused first and counted**, and only goes through with
`dropUnrepresentable`: a warning shown after the blocks are gone is not a
warning. That is `resizeSession`'s shape and it reuses its `FailureKind` --
`needs-confirmation`, so the panel offers the second press **without reading the
sentence**. A renderer matching on wording turns a rephrased message into a
silent dead end.

**A version change does three things, and the order decides between renaming
and demolishing.** Rename first, restate second, drop third:

- **rename** — `chain` becomes `iron_chain` going past 1.21.9 and back again
  coming under it. Nothing is lost, nothing is counted, nothing is asked;
- **restate** — a wall's `north=tall` becomes `north=true` before 1.16, which
  is where a wall connection stopped being a boolean;
- **drop** what is left, and only that.

Asking existence before renaming is not a worse version of this. `iron_chain`
is genuinely absent from 1.16, so a backport that checked first would replace
every one of them with empty space — while the correct answer, `chain`, is a
name that version has had since it shipped. `tests/session.ts` states it as
seven named checks, and deleting the rename step fails all seven.

**What replaces a dropped block is the document's empty space, not air.** A
break already writes it, and an underwater build coming back full of bubbles
would have lost exactly what `editing.voidBlock` exists to preserve. It falls
back to air when the empty space block is itself too new for the target —
`structure_void` being 1.10, that is a real case rather than a defensive one.

**Two tables, and which one answers is decided by the era rather than by
merging them.** `legacy_blocks.json` enumerates the pre-Flattening set exactly;
`block_versions.json` is the flat era only and its generator refuses a
pre-Flattening label outright. Each is authoritative where the other says
nothing, and asking both would be two answers to one question.

The panel used to declare the limit instead: *«this build has no record of
which release each block arrived in»*, which was true and is the sentence the
seventh dataset removed. Saying nothing there would have read as "checked,
nothing to lose", which is a promise it could not keep — the same reason the
impossible versions are shown **disabled** rather than filtered out.

**And the count distinguishes the three.** One number for all of them would
report a rename and a demolition identically, so `EditSuccess.notes` carries
the sentence. It is `DocumentSession.notes`' rule in a second place and has no
other user: most edits do one kind of thing, so `changed` is the whole answer,
and a field filled by everything would be a field nobody reads.

`TransactionScope.replaceAny` exists for this one caller. Calling `replace` per
offending entry is N passes over the voxels, and a backport can name fifty
blocks across a document of tens of millions of cells -- one pass is the
difference between a wait and a hang.

**`TransactionScope.remap` is its sibling and exists for the same arithmetic
one step further on.** The three steps above as three `replaceAny` calls are
three passes over the voxels, and this is the one edit that genuinely may touch
every block in the document. `remap` asks its function **once per palette
entry** and reads the answer per cell. The palette grows underneath the pass —
`setBlock` interns a target that is new — so an index past the end of the
target array reads as `undefined`, which is falsy and is the right answer: a row
added during the pass is something the pass just wrote, and rewriting it again
would chase its own tail.

**A `replace`'s `from` is a pattern, and naming no state means the block in any
state.** That is what the rest of the codebase already assumed: it is the stated
reason `replace_blocks` parses its `from` with `toEntry` rather than
`toPlacedEntry`, so that "take out the campfires" does not quietly become "take
out the ones that happen to face north and be alight".

It was not one. `from` was interned and compared as an exact palette index, so a
bare name matched only an entry carrying no properties at all -- and interning it
*added* that entry, leaving a dead row behind on every miss.

On a flat document that reads as an occasional puzzle. **On a legacy one it is
total**, which is where it was found and why it took a report to find:
`legacy_blocks.json` gives a state to **1,449 of its 1,682 rows**, so a
`.schematic` opens holding `grass_block[snowy=false]` and
`oak_fence[east=false,south=false,north=false,west=false]` and *nothing a person
can type* matches any of it. Every replace answered `changed: 0`. The suites
missed it because they replace inside fixtures they built themselves, where the
entry has no state to disagree about.

Spelling the state out still means exactly that state, which is how you take out
one stair orientation and leave the others. The match is decided once over the
palette into a `Uint8Array` and read per voxel, so it costs what the interned
index cost. The palette may grow underneath the pass -- `setBlock` interns `to`
if it is new -- and reading past the end yields `undefined`, which is falsy and
is the right answer: a row added during the pass *is* `to`.

**A search that matches the namespace matches everything, and that was the
load behind a total freeze.** `rank` in `block_search.ts` ended with
`id.includes(query)` on the **namespaced** id. Every block here is
`minecraft:something`, so every letter of `minecraft:` returned the whole
registry — measured on the shipped list of 1197: `a`, `m`, `e`, `c`, `r` and
`t` each returned all 1197, and **`mi` returned 1197 to show the one block
whose name contains it.**

Nine of the commonest letters in English, each mounting one row per match —
some five thousand DOM nodes built and thrown away per keystroke, inside a
floating panel a few rows tall where almost none of them is visible. Reported
as typing `aaa` into the selection panel's block field: fine after the first
`a`, dead the instant the second arrived, because that is the keystroke that
takes 1197 keyed rows to nothing.

A query may still *carry* the namespace — pasting `minecraft:sto` has to work
— so it is stripped from the query rather than matched in the id. One place
decides, and the namespace cannot come back as a way of matching everything.
`tests/blocks.ts` states it letter by letter rather than as one predicate, so
a failure names which letter; the check it replaced compared against
`b.includes(q)` on the full id, which did not merely miss the fault, it stated
it as the requirement.

**`blockRegistry` is `$state.raw`, and the line below it says why.** Plain
`$state` on an array is a deep proxy, so reading it inside a `$derived`
registers a signal per entry. It sat next to `legacyIndex`, which had been
moved to `raw` for exactly that, with the post-mortem written on it — and it
was missed.

It stayed dormant for a reason that then expired, which is the part worth
knowing: `placeableBlocks` used to be `null` for every flat document, so
`offered` was `blocks` itself and nothing allocated. **Giving flat documents a
per-version block set turned that alias into a fresh 1197-element array per
keystroke**, and woke the fault for every schematic rather than only the legacy
ones. A dormant hazard and a feature that removes the thing keeping it dormant
are one change apart.

**`ROW_LIMIT` bounds the rows that exist, not the matches that are found.**
The picker's own header forbids a cap, and is right: *«a search that genuinely
had 41 answers quietly showed 40 with nothing to say it had»*. This is not
that. The line above the list reports `matches.length`, so both numbers are on
screen and nothing is hidden silently — which is the property that paragraph
is actually about. Reporting `shown.length` there would turn it back into the
cap it argues against, so `tests/ui.ts` checks that the count comes from the
unbounded list and the rows from the bounded one.

**And no `onmouseenter` writing the highlighted row.** The effect beside it
writes `list.scrollTop`; scrolling moves a different row under a *stationary*
pointer, the browser fires `mouseenter` for it, and that writes the highlight
again. The CSS `:hover` already draws the row under the pointer, so the handler
bought one nicety — Enter taking the hovered row — and cost a feedback path.

**`bind:this` writes `null`, and a binding typed `| undefined` is a lie the
compiler cannot catch.** That was the freeze, all of it. The picker's scroll
effect guarded `list === undefined` on a `$state<HTMLUListElement | undefined>`
— so at exactly the moment the element went away the guard was **false**, and
the next line read `.children` off `null` *inside the effect flush*, where
Svelte has nowhere to put it. The scheduler is left broken and takes every
effect in the window with it.

The trigger is any query that matches nothing, because that is what unmounts
the list: `aa` in a block field, or `zzzz` after Ctrl+K. **`CommandPalette` had
the identical fault and nobody had reported it** — which is the argument for
fixing the class rather than the site.

So every `bind:this` target in the renderer is declared `| null` and
initialised `null`. That makes `=== undefined` a **compile** error, TS2367, and
it named all three sites the moment the types changed rather than waiting for
somebody to type `aa`.

`tests/ui.ts` still checks it, and the reason is worth keeping: **`tsc` catches
the mismatch, not the mistake.** Put the declaration and the guard back
*together* and it compiles clean and freezes the window — verified by doing
exactly that. What has to be refused is the declaration, so the check walks
every `bind:this` and reads the type behind it, with comments stripped first
because these sites are recognisable precisely by the prose explaining them.

The two in `Viewer.svelte` are named exceptions rather than skipped: they are
not inside a conditional, so they live as long as the component and are only
read from `onMount` and from handlers bound to them.

**Three things were fixed before this one that were not this one**, and the
distinction is worth keeping: the namespace search returning all 1197 blocks,
the deep `$state` proxy over the registry, and the unbounded rows were the
*load*. This was the *crash*. Correcting the load made the picker faster and
the search right, and would never have closed the report.

**The dialog hands over the report.** It copies the whole thing — app version,
platform, Electron, Chromium, Node, then the message and the stack — and opens
a pre-filled issue on the repository `package.json` already names, imported
rather than written out a second time. It publishes nothing; the Submit is the
user's.

Two details that are not decoration. The dialog is **shown again** after a
copy, because copying is not an answer to "what do you want to do about the
window" — closing on it would leave the app just as dead with the report in
hand. And **the URL carries an abridged body while the clipboard carries
everything**: GitHub takes the body as a query parameter, a stack clears that
ceiling easily, and a body truncated by a browser looks exactly like a complete
one. `abridgeTrace`'s rule — cap on the way out and say what was dropped.

**The window can now say that it died, and could not before.** There was no
`window.onerror`, no `unhandledrejection`, and nothing in main for
`render-process-gone` or `unresponsive`: zero occurrences across `src/`. So a
loop that Svelte or the browser aborts took every effect in the window with it
and **nothing anywhere heard**, which is why the same failure was reported
twice with a clean console.

`IPC.rendererFailed` is an **event, not a request**, and that is the design: it
is sent from a window that may be moments from being unable to run anything,
and a promise to await is exactly what would never come back. The renderer's
entry registers the listeners **before the mount**, so a failure during mount
is reported too, and reports **once** — an error handler that reports a loop is
a loop of reports. Main counts what follows and says so in the dialog.

Offering a reload is safe to offer for a reason worth stating: **autosave is
main's**, on a 20-second timer, and main is the half still working. So the
snapshot is current however long the window has been dead, and
`failure_prompt.ts` says so rather than leaving somebody to weigh a reload
against an unknown. It is Electron-free for `discard_prompt.ts`'s reason, and
`ipcMain.on` is a third way to serve a channel that `tests/services.ts`'s walk
had to be taught — it knew `handle` and `send`, and called a served channel
unserved.

**`scrollIntoView` scrolls every scrollable ancestor, and this app has a
floating panel that watches its own geometry.** `BlockPicker`'s dropdown keeps
the highlighted row in view; it did so with `scrollIntoView({block:"nearest"})`,
which was harmless only because the row could not overflow. Making that row a
flex container -- to push a legacy `ID:DATA` to the trailing edge -- removed
that accident: a flex item does not shrink below its content without
`min-width: 0`, so a long block id made the row wider than the button.

From there: the browser scrolled the panel the list sits in, `ToolWindow`'s
`ResizeObserver` found the panel out of bounds and called `onmove`, the panel
moved, and the observer fired again. The browser stops that loop by emitting an
*ErrorEvent*, not a console error -- so the app simply stopped updating while
the viewport went on drawing (its own `requestAnimationFrame` chain owes Svelte
nothing) and the main process went on answering (the menu still opened). A
silent, total freeze with a clean console, reachable only by typing in the one
field whose value changes per keystroke.

The list's own CSS had already written the rule down -- *"The list scrolls, not
the panel"* -- and `scrollIntoView` had been quietly breaking it. It writes
`list.scrollTop` now, which touches nothing above itself.

**`replace` deliberately does not grow.** It rewrites blocks that are already
there and there are none outside the box, so growing first would add air and
then replace nothing in it — a resize the user did not ask for and would have
to undo.

A fill used to be *clipped* to the document before its volume was measured, so
asking for the universe quietly became a full fill of whatever was open. That
silence is what this replaces: too big now says so, by name.
`MAX_DOCUMENT_VOLUME` is not a design limit, it is the one that stops the
process dying — the voxels are an `Int32Array`.

**Saving trims the schematic to its content, on a copy.** `domain/crop.ts`
finds the outermost non-air block on each of the six sides and writes that box,
so a build made inside a deliberately roomy editing volume does not ship a shell
of air around it. Block entities, entities and `offset` all move with the
content — the offset the *opposite* way, so the file pasted back into the world
it came from lands where it was.

It is a copy for the same reason `compactPalette` is not a save-time step: a
voxel index means nothing except against the dimensions in force when it was
recorded, so re-dimensioning the live document would invalidate every delta on
the undo stack. Saving must not cost you your history.

The trim belongs to `saveSession`, not to the writers. **Autosave calls the
writers directly and must keep the full working box** — a crash snapshot that
came back trimmed would silently discard the room the user had made to build in.

**The anchor is a cell, and the tag is its negation.** WorldEdit stores
`min - anchor` and the minimum corner is the grid's origin, so the cell the
anchor occupies is **`-offset`**: a 7×4 selection copied with the player in the
middle writes `[-2, 0, -2]`, and the anchor is `(2, 0, 2)`. `anchorOf` and
`offsetFor` in `domain/document.ts` are the only two places that know, and both
the modal's fields and the viewport marker are in *cells*. Getting the sign
backwards is invisible: the marker appears, the file saves, and the paste lands
mirrored about the corner.

`doc.offset` is therefore `| null`, and a document starts without one. `[0,0,0]`
is a position like any other — the corner of the build — so defaulting to it
claims a pivot nobody placed and writes the tag into every file. The generation
writer used to stamp `Offset: [minX, minY, minZ]`, which was not that tag's
meaning at all; it writes none now, like the Origin.

**The marker is drawn, never meshed, and never exported.** It occupies a cell in
the viewport and nothing in the grid: no voxel, no palette entry, no block in
the file. The wooden axe on all six faces is WorldEdit's own wand, read from
`textures/item/` by `pack_reader.ts` — the same "textures the mesher never asks
for" path as the sun and the moon, and pixels for the same CSP reason. The green
perimeter is `EdgesGeometry` over a cube, whose twelve edges *are* the perimeter
of every face. It may sit outside the schematic, because the player who copied
may have been standing clear of the build.

**`Origin` and `Offset` are two different tags, and the app keeps both.**
`doc.offset` is the vector from the paste anchor to the schematic's minimum
corner; `doc.worldOrigin` is the absolute world position of that corner.
WorldEdit's own readers recover the anchor as `Origin - Offset`, so neither is
derivable from the other and a file carries both.

**There is a fourth container, and it is the one people actually swap builds
in.** Litematica's `.litematic` is NBT like the other three, carries a full
block-state palette like Sponge, and is read and written whole — palette,
block entities, entities, `Metadata`.

**Half of it was already written.** `readBlockEntities` and `readEntities` in
`loader_formats.ts` are deliberately permissive, and Litematica spells a tile
entity with a lowercase `id` and three separate int coordinates (MCEdit's
spelling) and an entity with `id` and a `Pos` of three doubles (Sponge's). Both
were handled years before this container arrived. Reading 509 chests out of a
real file needed no new code at that layer at all.

**The packing is `litematic_bits.ts`, and it is none of the three this app
already had.** Sponge v2 packs into a byte stream, v3 into varints, and modern
Minecraft chunks pack into longs *without* letting an entry cross a long
boundary. Litematica's crosses: an entry starts at bit `i * bits` from the least
significant bit of long 0, and runs into the next long if it has to. Width is
`max(2, bits for the largest index)` and the array is `ceil(bits * cells / 64)`
longs.

The difference is **invisible at 8 bits**, where the two arrangements agree
exactly — and 8 bits is what an ordinary schematic's palette needs. So the
checks are at 2, 5, 9 and at a 257-entry palette, which are the widths where a
straddling packer and an aligned one diverge and where "bits for the count" and
"bits for the largest index" disagree. Verified against two real files as well:
241 entries over 64x46x88 gives 8 bits and 32,384 longs, 367 over 122x145x54
gives 9 and 134,334, and both repack byte-identical.

**Several regions become one box, and it takes two of them to see any of the
arithmetic.** A litematic may hold any number of named regions, each with its
own position, size and palette; a document is one box, so the union becomes the
document and each region is written in at its own offset. A `Size` may be
*negative*, meaning the region runs back from `Position`, so the corner its
array is indexed from is `Position + Size + 1`.

With a single region none of that is observable: a wrong corner translates the
whole document and the union translates it back, so the box comes out the right
size holding the right blocks. And a 1x1x1 region cannot see the sign either,
because `Position + Size + 1` is `Position` exactly when `Size` is -1. The check
therefore builds *two* regions, one of them two wide and stated backwards.
Litematica normalises on save, so no file anyone is likely to open carries one
— which is the argument for constructing it by hand rather than waiting for a
fixture.

What the merge loses is the *partition*: saving puts one region back where there
were three. The blocks, the block entities and the entities all survive; the
seams do not, and keeping them would need a second notion of what a document is.

**The floor is 1.13.2, one release later than this app's own flat era.**
Litematica's reader converts the palette of anything whose schematic `Version`
is below 5 *or* whose `MinecraftDataVersion` is below 1631, so a `.litematic`
claiming 1.13 opens in the mod as the wrong blocks rather than as an error.
`formatsFor` is where that lives, and `refusalFor` grew a second sentence:
sending someone who picked Litematica for 1.13 to read about flattened block
names would be true and useless, because 1.13 *has* those.

**Which `Version` gets stamped is chosen from the document's DataVersion**, 7
from 1.20.5 and 6 below it. Always 7 writes files Litematica below 1.20.6
refuses outright; always 6 puts component-shaped item NBT under a label
promising the older shape. `SubVersion` is written only when it is not zero,
because Litematica reads it as `get("SubVersion", 0)` and a version 5 file never
had the tag.

**It is the one container that cannot omit its version.** Sponge leaves the
`DataVersion` tag out when there is none and MCEdit has no such tag at all, but
Litematica reads the file *according to* `MinecraftDataVersion`. So
`litematicCanCarry(null)` is false and the save is refused by name: stamping
1631 on a document that named no version would tell every reader downstream it
was cut from 1.13.2.

**`TotalBlocks` counts what `paletteEntryIsAir` already calls air**, which is
the mod's own rule and comes out free. Checked against a real file whose
metadata says 24,705 where a naive non-air count says 24,759 — the difference
being its 54 `cave_air` cells. Worth knowing before somebody "fixes" the count
by walking the voxels directly.

**`anchorLocation` and `originLocation` return `null` now, and Litematica is
why.** It has a region `Position` and a `Metadata.EnclosingSize` and no concept
of a paste anchor at all. Pointing those functions at some plausible tag would
be the exact mistake they were added to prevent, in a new container — and the
file would even round-trip through this app while meaning nothing to the mod. So
`WriteResult` grew **`dropped`** beside `degraded`, which is a different
question: a degraded block is in the file, approximated, and a dropped thing is
simply not there. The Anchor panel and the NBT panel both say so.

**And `schematicExtension` is the only copy now.** It was written out three
times — in `shared/schematic.ts`, as `extensionFor` in `writers.ts`, and
inline in `App.svelte` — which was harmless while there were three containers
and two answers. A fourth would have had two of the three go on calling a
`.litematic` a `.schem`, and the file would have saved.

The five `Metadata` fields the writer recomputes — `EnclosingSize`,
`TotalBlocks`, `TotalVolume`, `RegionCount`, `TimeModified` — are lifted out
of the bag on the way in, for `readMetadata`'s reason: each is a function of the
blocks, so a copy left behind goes stale on the first edit and is written back
out as fact. `TimeCreated` is deliberately *not* lifted; it is the one time in
that compound this app does not own.

The panel's tripwire covers this container too, with one stated exception: the
two clocks are normalised out of both sides, because `TimeModified` is stamped
when the file is written and the panel's tree is built when the panel opens, so
comparing them would fail at random.

**A `.mcfunction` is read and written, and it is not a container.** It has no
metadata, no anchor tag, no `DataVersion` and no NBT root — what makes it a
schematic is only that `setblock` and `fill` are enough to describe a build. So
it is a `FileKind` and not a `SchematicFormat`: opening one produces a **Sponge
v3 document with no path**, and Save falls through to Save As on its own, which
`saveDocument` has done since the day the third caller turned out not to have
that check written out. Keeping the path would be worse than losing it — a
plain Save would write a Sponge file over the `.mcfunction`, under that name.

**The frame is the anchor, and that is the one thing this format keeps that
Litematica cannot.** `~ ~ ~` is wherever the function is run from, which is
exactly what a paste anchor means, so the coordinates carry it for free:
reading sets `doc.offset` from the minimum corner, writing emits every
coordinate relative to it. Absolute coordinates name a world position instead
and set `worldOrigin`; a file cannot carry both, because **mixing the two kinds
is refused by name.** A file that mixes `~2` with `2` describes two builds in
two frames, and picking one quietly is how a structure comes out with half of
itself somewhere else. `^` is refused too: it is relative to where the player is
*looking*, which a schematic has no answer for.

**Every line that is neither `setblock`, `fill`, `function` nor a comment is
counted and reported.** A file full of `summon` and `data merge` that opened as
an empty schematic with no explanation would read as the app being broken, and
the count is the difference between "there is nothing here" and "there is
plenty here that I cannot place". `DocumentSession.notes` carries it to the
status line, and it is the only thing that ever fills that field: a container
either parses or it does not, and only a list of commands can be *partly* read.

**`function <ns>:<path>` is followed**, because the reference file this was
built against is a one-line dispatcher and the blocks are next door. Two shapes,
because two are in circulation: a real datapack's
`data/<namespace>/function/<path>.mcfunction` — `functions`, plural, before
1.21 — found by walking up from the file being opened to its `data`
directory, and the sibling by basename, which is what every converter writes. A
call that resolves to nothing is a note, not a silence. Cycles stop at the
visited set and the walk stops at a file cap.

**The block argument cannot be split on whitespace.** `chest[facing=north]{Items:
[{id: "minecraft:stone", Count: 1b}]}` has spaces inside it, and cutting there
leaves two halves that each fail to parse. It is scanned with a depth counter
over brackets, braces and quotes, and that scan is also what tells a trailing
`replace` apart from a block called `replace`.

**The modes that decide *which cells* are written are honoured.** `hollow` and
`outline` write a shell, `keep` writes only into air, and `fill … replace
<filter>` writes only over a named block. Ignoring them would not fail — it
would produce a solid box where the file asked for a frame, silently. `destroy`
and `strict` change what happens to the *old* block in a live world and mean
nothing to an empty grid, so they are accepted and do nothing. Commands are
applied **in order**, which is what makes `keep` and the filter mean anything at
all: both ask what is already in the cell.

**Runs of one block become `fill`, and that is what makes the format usable.**
One `setblock` per cell is a quarter of a million commands for an ordinary
schematic, and the game stops reading a function after 65,536 of them **with no
error**. Greedy growth in one fixed order — a run along x, extended along z
while the whole row matches, then along y while the whole plate does — takes
the two real files to 10,877 commands from 259,072 cells and 32,441 from
955,260.

Three constraints, each a way to fail in silence:

- **No box past `MAX_FILL_VOLUME`.** Beyond it the game changes no blocks at all
  and reports nothing useful, so the file looks fine and the build comes out
  with holes.
- **A cell with a block entity is never inside a box**, because `fill` carries
  one block argument for the whole region. The check for this needs an
  *unrecorded* block identical to a recorded one, and **placed before it in the
  walk**: two recorded chests side by side are each emitted before any box
  begins, so they come out right even from a writer that has never heard of
  block entities. Only a box that grows *into* a pinned cell can see the rule.
- **The parts are split at `MAX_COMMANDS_PER_FUNCTION`**, so each is runnable on
  its own. Splitting does **not** raise the ceiling: a function's budget covers
  what it calls, so the dispatcher says so in a comment rather than leaving the
  user to wonder where the roof went.

**Air is written.** A schematic is a volume, not a scattering of blocks: a file
that placed only the solid cells would come back sized to whatever the outermost
block happened to be, and would leave existing terrain inside the build. `fill`
is what makes it affordable — the empty half of a schematic is a handful of
large boxes.

**`stringifySnbt` grew a `compact` flag for one caller.** A function is one
command per line, so a chest's contents written the readable way break the
`setblock` carrying them across a dozen lines, every one of which the game then
tries to run as a command of its own. Found by round-tripping a real file with
509 chests in it; the NBT panel had never had a reason to care, because a text
area has as many lines as it likes.

**The two floors are different releases, and `command_syntax.json` records
why.** `setblock <pos> <block>` with a flattened id is **1.13**; a `.litematic`
needs Litematica's reader not to convert it, which is **1.13.2**. The mode word
is deliberately left off both commands: omitted means `replace`, which is what a
schematic wants, and it is the one spelling every release from 1.13 accepts.
1.21.5 added `strict` and relaxed `replace`, both additions the bare form never
had to know about.

**Converting is a verb of its own, and `services/convert.ts` holds no format
code.** "Convert" used to be a gesture — open the file, Save As in the other
container — which went through the open document and was wrong twice: it
costs the user whatever they had open, and it has no answer at all for
`.mcfunction`, which is read but can never *be* a document's format, so there
was nothing to save *as*. The converter loads with `loadStructure`, builds with
`documentFromLoaded` and writes with `writeDocument` or the mcfunction writer,
so a conversion cannot be right in a way that opening the file is not.

**It never overwrites.** A file already at the destination is moved aside under
a timestamp through `resolveOutputPath` — `save_document_as`'s rule, arrived
at from the same direction, because this verb is reachable by an agent and a
badly guessed path should cost a rename rather than somebody's build. For a
`.mcfunction` **every part's name is reserved**, not just the dispatcher's: the
set shrinks. Export as eight parts, edit down, export as five, and `_5` through
`_7` sit there from last time beside a dispatcher that no longer calls them.

**And it never crops.** `saveSession` trims to content because saving ends an
editing session and the room you made to build in is not part of the build. A
conversion is a fact about a file: quietly handing back a smaller one would make
the two disagree about what the schematic is.

`convert_schematic` is in **`TOOL_SPECS`**, so the chat and MCP get it from one
definition — the rule `tests/mcp.ts` states from both sides. That needed
`NO_DOCUMENT` in `mcp/tools.ts`, which is a **third** question beside `readOnly`
and `changesDocument`: `describe_block` is read-only and needs no document,
`convert_schematic` is neither read-only (it writes a file) nor a document tool.
Before it, `describe_block` came back "No schematic is open" for a question
about Minecraft — nobody reported it, because a client connected to this app
usually has one open, which is exactly the kind of wrongness that survives.
`refusingDocument` is its tripwire, `refusingScope`'s idiom for `refusingScope`'s
reason.

**The version is refused before anything is written**, by the same `refusalFor`
the format picker asks. Two containers guard themselves and one does not, which
is why the check is here rather than left to the writers: a litematic refuses a
DataVersion it cannot carry on its own, and Sponge has no such guard —
without this, a pre-Flattening version would be stamped onto a file whose
palette holds flattened block names, which opens fine and misbehaves in game.

One consequence falls out of two rules meeting and is worth knowing before it is
reported: **a `.mcfunction` cannot become a `.litematic` without being told a
version.** Commands carry no `DataVersion`, and Litematica is the one container
that cannot omit one. The refusal says to pick one, and the panel offers the
picker for exactly that case.

The converter's button is the one in that row that is **never disabled**.
Converting a `.litematic` somebody sent you is a thing to do before there is
anything open at all, so requiring a document would be a rule with nothing
behind it.

**Sponge v2 and v3 both spell a tag `Offset` and do not mean the same vector by
it.** This is the one real incompatibility between the two, it is silent in both
directions — a file written with them swapped loads, looks right and pastes
somewhere else — and it is the shape of a bug this codebase already shipped once.
`spongeVectors` in `loader_formats.ts` holds the table, and the writer, the NBT
panel and the loader all read it from there:

| | `Offset` | in `Metadata` |
|---|---|---|
| Sponge **v2** | the minimum corner (`worldOrigin`) | `WEOffsetX/Y/Z`: the anchor vector (`offset`) |
| Sponge **v3** | the anchor vector (`offset`) | `WorldEdit.Origin`: the minimum corner (`worldOrigin`) |
| MCEdit | — | `WEOriginX/Y/Z` and `WEOffsetX/Y/Z`, at the root |

Verified against WorldEdit's `SpongeSchematicWriter` (`schematic.put("Offset",
min)` beside `metadata.put("WEOffsetX", offset)`, where `offset =
min.subtract(origin)`) and its reader (`origin = min.subtract(offset)`), and
against the v3 specification, which says `Offset` is "the relative offset of the
schematic **from the paster**". So v2 is structurally MCEdit's arrangement under
different names, and v3 is the odd one out.

`readMetadata` lifts `WEOffsetX/Y/Z` **for v2 only**. In a v3 file those keys are
something another tool left behind, v3's own reader ignores them, and reading
them as an anchor would contradict `Offset` — so there they stay in the bag as
unknown metadata, like `Platforms`.

**And the panel that sets the anchor has to name the tag, per format.** It said
`Offset` for every container, which is true only of v3. In a v2 file that tag
holds the world corner and the anchor is off in `Metadata.WEOffsetX/Y/Z`; in a
v3 file `Metadata` carries the *Origin* and nothing anchor-shaped at all. So
someone who set an anchor, looked where the app told them, and found either the
wrong vector or no `WE*` key would conclude the anchor had never been written —
correctly, from a false sentence, while the file on disk was right the whole
time. `anchorLocation`/`originLocation`/`tagPathLabel` in `shared/schematic.ts`
are the answer, and they are in `shared/` for the reason
`openCodeModelRequiresKey` is: the renderer must name the tag and may not import
out of `main/`. That makes them a second copy of `spongeVectors`' table, so
`tests/formats.ts` saves a real file and walks the path they name — the vector
has to be exactly there, in all three formats, or the check fails.

The Origin is `null` when the file named none, and then no tag is written at
all. Absence and zero are different answers here: a missing `Offset` means "no
displacement" and zero says that exactly, while a missing Origin means "nobody
said" — writing `[I;0,0,0]` would tell every tool downstream to paste the build
at the world origin. MCEdit's three tags are therefore written as a trio or not
at all; two thirds of a position is not a position.

`WEOffset*` are `int()`, because WorldEdit's are and because a `short` cannot
hold the coordinate: a build cut from past ±32767 on any axis did not wrap, it
*threw*, out of `prismarine-nbt`'s buffer writer with a message naming neither
the tag nor the file. Reading is unaffected either way — `numberOf` takes
whichever it finds.

**The Origin moves with the content, exactly as the offset does.** It is the
world position of the cell the grid calls `(0,0,0)`, so anything that moves that
cell moves it: `cropToContent` adds `bounds.min` and `resizeDocument` subtracts
the shift, both `null`-guarded, both the same arithmetic as `offset`.
`history.ts`'s `Dimensions` carries it beside the offset so a resize can be
undone. The visible consequence is worth knowing before it is reported as a bug:
saving crops to content, so an Origin typed against a deliberately roomy editing
box comes back shifted — which is the whole point of it.

**The file's own `Metadata` survives, minus the one field the app owns.**
`doc.metadata` is Sponge's `Metadata` compound as loaded, and the loader lifts
`WorldEdit.Origin` *out* of it into the typed field — because that one has to
move when the content moves, and a second copy sitting in an opaque compound
would go stale on the first crop. Everything else is kept verbatim, for the same
reason a block entity's unrecognised NBT is: before this, opening a WorldEdit
file and saving it destroyed its `Platforms`, `EditingPlatform`, `Author` and
`Date` without a word.

Two orderings in `spongeMetadata` decide it, and both are load-bearing. The
app's own `Name` goes in **first**, so it is a default a file that arrived named
overrides rather than a stamp that overwrites it. The Origin goes in **last**,
merged into whatever `WorldEdit` sub-compound survived the load, so `Platforms`
comes back out beside it instead of being replaced by one this app invented. A
sub-compound the lift emptied is dropped rather than written as `{}`.

MCEdit has no `Metadata` compound — WorldEdit puts its tags straight on the
root — so the bag is empty there and a Sponge → MCEdit save cannot carry it.

**`Command` has a third kind, and it is everything that is not a block.**
`header` carries `offset`, `worldOrigin`, `dataVersion`, `metadata` and
`entities`, as one whole state rather than a patch: a partial merge is one more
place for a field added later to be silently dropped, which is the failure
`coerceSettings` exists to prevent. Block entities are deliberately *not* in it —
they already have `BlockEntityDelta` and `setBlockEntity`, which key on position,
and a whole-map snapshot beside a per-position delta would be two records of one
thing. It moves no voxels, so it contributes nothing to `summarizeTransaction`'s
tally and still lands on the undo stack: the one edit nobody could undo would
otherwise be the one that moved the whole build in the world.

**A conversation belongs to a schematic, and the rule is written out.** It used
to hang off `DocumentSession`, which made it die with the document for free —
and that was the whole appeal until it had to be *kept*. `services/conversation.ts`
owns the visible log and the model's messages as **one record**, so persisting
them is one write; a crash between two would leave a log describing edits the
agent has no memory of. `runAgent` therefore takes `history` and returns
`messages` rather than reaching through the session, which also makes the memory
a value the tests can see instead of something inferred from what the model was
sent.

**Recovering is opening, and every way of putting a file on screen has to say
so.** A conversation is stored under the file *path*, so a document that arrives
without `adoptSubject` arrives without its history — which is exactly what the
crash-recovery prompt did: the restored schematic came back with an empty chat
while the same file opened from the recents came back with everything. The
renderer made it worse by clearing on purpose, on reasoning that expired when
the transcript stopped living on the `DocumentSession`.

Restoring a **version** or a **checkpoint** deliberately does *not* adopt: those
replace the document with another state of the same file, and the subject has
not moved. So `tests/services.ts` names the two handlers that open a file rather
than walking every `adoptDocument` — the rule is about opening, not adopting.

The subject rule has one case that looks like a bug and is not: opening a file
the conversation has **no subject** for is an *adoption*, not a reset. That is
the chat that built something with nothing open — the generator writes the file
and then opens it, and clearing there erased the question and left only the
answer. Opening a *different* file still saves and swaps.

`rememberedFrom` is computed in main, and must be. "The last N user turns" is
the obvious rule and it is wrong: a run that fails leaves its entry in the log
and never enters the model's memory, so counting from the renderer drifts by one
for every error above it.

**A checkpoint is not cropped, and is keyed on `doc.revision`.** `saveSession`
trims to content; a snapshot must not, for the same reason autosave must not —
coming back would hand the user the build without the room they made to build
in. Keying on the revision is what makes a failed turn free: a rolled-back run
leaves it unchanged and the next snapshot reuses the file. **Restoring cannot be
undone** — `adoptDocument` starts a fresh history — so restoring first snapshots
the state it is leaving and hangs it on a note in the conversation it archives.
That is what makes it a fork rather than a one-way door.

**`Transaction` has an `id`, and "Undo this" matches on it.** The label is
derived from the prompt, so asking twice for the same thing produced two turns
the chat could not tell apart, and it would offer to undo whichever was on top.
Ids are never reused, so one held elsewhere can only go stale, never come to
name a different transaction.

**`doc.revision` is a cache key, not a dirty flag.** It is monotonic and is
bumped by every mutation *including an undo*, which is what makes it safe for
"is my mesh still current". It cannot answer "have you undone back to what is on
disk" — that is `history.ts`'s `isDirty`, measured by undo-stack depth.

**A resize is alone in its command.** A voxel index only means anything relative
to the dimensions in force when it was recorded, so block deltas either side of
a resize belong to different coordinate frames. A transaction is a *list* of
commands applied in order and reverted in reverse; a shrink also records the
blocks it destroyed, or undoing it could not bring them back.

**One agent request is one transaction.** `runTransactionAsync`, not
`runTransaction` — the synchronous one catches what `body(recorder)` throws,
which for an async body is nothing, so the rollback silently never runs and a
failed request leaves the document half-edited.

**Stop is shown from `inFlight`, never from `busy`.** They are different
questions and only one of them is "is there something to abort": switching
conversation, restoring a checkpoint and refreshing the document all set `busy`,
and none of them can be stopped. Deciding the button from `busy` is how it came
to be on screen doing nothing.

The chat has *two* stoppable runs, which is the part that is easy to miss. A
message typed with nothing open goes to the **generator**, not the agent — the
chat builds the schematic the rest of the conversation then edits — so
`inFlight` carries a kind and `stopAgent` dispatches on it. `generate` has taken
an `AbortSignal` since it was written; for a long time nothing passed it one and
there was no channel to ask.

Registration order is load-bearing on both paths: the controller goes into the
map **before** anything awaited, `takeCheckpoint` included. That call writes a
whole schematic, and above the registration it is a window in which `cancelAgent`
finds nothing — Stop pressed during it does nothing at all, silently. A Stop that
lands inside the window aborts the signal before `runAgent` uses it, which
`agent.ts` already handles by asking the signal rather than the error.

`tests/services.ts` walks `handlers.ts` and fails on any channel in `IPC` that is
neither `ipcMain.handle`d nor `send`ed. That is the mechanical half of the same
mistake: declaring a verb, bridging it through preload, calling it from the
renderer, and never registering it.

**The agent's only way to change the schematic's size is `resize_document`.**
`growthToInclude` belongs to `applyEdit`, which is the UI's path — a fill into a
dragged selection, or a block placed past the edge; every agent tool goes
through `normalizeRegion` and is trimmed to the current box. That asymmetry is deliberate — a fill with one bad coordinate
should not silently resize the document — but for a long time it left the agent
with *no* way to make room, so "put a roof on this" against a build that already
reached the ceiling had no correct answer and the model settled for rewriting
what was there.

The tool grows and never shrinks, at the far side and never with a shift. Both
restrictions are load-bearing rather than timid: saving already trims to content,
so the empty room a user left is theirs to keep; and growing at the far side
means every coordinate the model has already been told — the selection, a
`get_region` result — is still valid afterwards. Room *below* the origin moves
all the content up, and the model would be reasoning from coordinates that
changed under it.

**`resolveRegion` reports what it had to do.** Clamping and leaving the selection
were both silent, and both produce a result that reads as success: a fill above
the ceiling landed *at* the ceiling with a healthy `changed` count, and an
explicit region reaching 708 cells past the selection rewrote a whole structure
while the answer said `changed: 868` and nothing else. Leaving the selection
stays *allowed* — "replace all the cobblestone everywhere" is a real request —
it is only no longer quiet.

**"A shape is a build script" is phrased that way on purpose.** The rule used to
read "rather than hundreds of set_block calls", which a model takes as an
argument about cost: reaching for `replace_blocks` it concludes the rule is not
about it. A sloping roof is not hundreds of set_blocks, it is a shape, and
`fill_region`/`replace_blocks` apply one block to a box — so they answer "make a
roof" with a solid box of roof.

**The selection is described by its size, not only its corners.** Same
information, different message: handed `(0,7,0) to (15,7,9)` a model spends its
reasoning deciding whether that is one block tall. A single-layer selection is
called out by name, because "build something with height in here" has no answer
inside a plane and the follow-up question is otherwise inevitable.

**The loop streams, and that is why there is anything to watch.** Both paths
call `streamText` — `agent.ts` iterating `fullStream`, `llm.ts` for the build
script. `generateText` resolves once, at the end, so a model that thought for
thirty seconds produced thirty seconds of nothing; the thinking and the prose
either side of the tool calls did not *exist* until the call was over. Do not go
back: the tool summaries were live only because tools execute during the call,
and that is the one part this never depended on.

Two consequences worth knowing. `streamText` does not throw — errors arrive as
an `error` part in the stream, so the loop raises them itself and keeps the
existing contract (`AgentCancelledError` asked of the signal first, everything
else wrapped as `LlmError`). And its default `onError` is `console.error`, which
would print a stack trace for every stopped run; both call sites pass a no-op
because they handle errors where they can tell them apart.

**A turn's trace is main's record, and the renderer only mirrors it.**
`services/trace.ts` assigns the ids because it is the only place that knows what
happened first; the finished array comes back on the `ChatEntry` and the
renderer adopts it, exactly as it does the chat log. Appends are batched by a
**character budget, not a timer** — reasoning arrives a few characters at a time
and a message per token would be most of the cost of the feature — and a budget
is deterministic, so the tests drive it with no clock and nothing is left
scheduled when a run throws.

The fold, `applyTraceEvent`, lives in `renderer/src/lib/trace.ts` because the
renderer may not import out of `main/`. What keeps the two halves agreeing is
not proximity but `tests/agent.ts`: it drives a real run, folds the events main
emitted with the renderer's own function, and requires the result to equal
main's `snapshot()`.

A tool's readable summary is matched to its trace row **by `toolCallId`**, which
is why `ToolContext.onStep` carries an id at all. Matching on the tool's name
would do right up until a model issues two `fill_region`s in one step, which it
does whenever it builds two walls.

`dropClosingText` removes a trailing `text` item that only repeats the answer —
the closing sentence arrives as a text part like any other, and left in, every
turn ends with the same paragraph twice. Only the last one, and only when it
matches: prose written *before* a tool call is the thing this feature is for.

**The request is shown whole and stored abridged.** A generation's prompt is the
`SYS_GEN` template plus the entire block-id list — 933 ids, 24 kB, identical
every time because it is a constant of the app. Ten conversations per schematic
across a hundred schematics is where storing a copy per turn ends up, so
`abridgeTrace` caps it on the way to disk and says what it dropped. Live, it is
verbatim, because "what did you actually send" is the question it exists to
answer.

**A failure carries the trace out with it.** `attachTrace`/`traceOf` in
`core.ts`, and `generate` re-throws through them. The obvious arrangement — the
trace on the success value — is exactly backwards: a run that worked leaves a
file to look at, and one that failed leaves a sentence. The live trace is
cleared when the run settles, so without this the model's answer scrolls past
and then vanishes behind an error that cannot say what happened.

For the same reason `textToSchem`'s `{kind:"none"}` carries a `reason`. Its two
paths want opposite things from the reader — "the script threw" is fixed by
asking again, "there was no `<code>` block" is not fixed by rewording anything —
and one message for both told them neither. `conversionFailureMessage` lives in
`core.ts` rather than beside the error class because `services/generate.ts`
reaches Electron through `artifacts.ts` and the suites cannot load it at all.

**A build asked for in the chat reports itself in the chat.** Generation's only
feedback was the progress bar in the Structure panel, which since the sidebar
became tabs is a tab you are not looking at while you chat — so asking the chat
to build something showed the message and then nothing, for as long as the model
took. The same `onProgress` events are pushed into the chat's live steps, matched
by request id because previews emit progress too.

**The NBT panel shows what the file would contain, and reads it back with the
loader's own decoders.** `services/schematic_nbt.ts` builds the root compound
*as this document's format would write it* — so an MCEdit document shows
`TileEntities` with a lowercase `id` and separate `x`/`y`/`z` ints, and a Sponge
v3 one shows `BlockEntities` with `Id`, `Pos` and a nested `Data`, inside
`Blocks` where the file keeps them. Reading the text back goes through
`readBlockEntities`/`readEntities` from `loader_formats.ts`, so there is no
second parser to disagree with the first.

It builds its own tree rather than sharing the writer's, which is welded to the
block payload — so `tests/formats.ts` saves a real file, reads it back, strips
the omitted tags and requires what is left to equal the panel's tree, for all
three formats. That tripwire is what makes the duplication safe.

Omitted: `Palette`, `PaletteMax`, the varints, `AddBlocks`. Shown and **refused
by name if changed**: `Width`, `Height`, `Length`, `Version`, `Materials`. They
are the first thing anyone opens this to check, so showing beats omitting; and
refusing beats ignoring, which is the failure this file keeps a list of.

**One rule for applying: every key the read produced must still be there —
unless its absence is a state the document can hold.** The two halves are one
rule seen from opposite sides, and the rule is *nothing is ever guessed at*.
Deleting `BlockEntities` cannot mean anything: there is no "this schematic has
no block-entity list", only one with nothing in it, which is written `[]`. So it
is a slip, and it is refused. Deleting `Offset` maps exactly onto a state the
document holds — no anchor — so it removes the anchor, which is the same act as
the modal's Delete button. `OPTIONAL` in `schematic_nbt.ts` is that list;
`Width` is not on it. The v3 case needs its own check because
that list lives *inside* `Blocks`, which is still present holding nothing — the
top-level walk cannot see it, and without the nested check the refusal came out
as "too large to edit", having already deleted the chests.

Two more that are easy to get wrong:

- **The cap is decided by one function, `offerable`.** Both the read and the
  apply ask it, because a panel that offers an edit which is then refused is
  worse than one that never offered. Past `MAX_NBT_ENTRIES` or `MAX_NBT_TEXT`
  the lists are left out and the panel is read-only — not a second mode where a
  missing key means "leave alone".
- **`Metadata` that came back unchanged leaves the bag alone.** The tree the
  panel showed was built by `spongeMetadata`, which stamps the app's `Name` onto
  a document carrying none — so reading it back naively adopts the stamp, and
  Apply with nothing edited dirties the document and leaves a step on the undo
  stack. What the file would contain is identical either way.

`revision` is an optimistic lock, carried out on the read and back on the apply.
The text is fetched once, when the panel opens; without the check an Apply would
put the old entity list back over an undo that happened underneath it.

The panel is a modal rather than a `ToolWindow` because that window is a fixed
232px and this holds a schematic's whole block-entity list. It releases the
pointer lock on open, like the creative inventory, and it deliberately does
**not** copy `ChatComposer`'s Enter/Shift+Enter split: a newline is the one key
a text editor cannot give up.

**MCEdit output is lossy, and says which way.** A block with no legacy
equivalent fails the save by name; a block whose exact state the format cannot
carry is written as the base block and reported through `degraded`. Both
directions count: a state-less `minecraft:chest` comes back as
`chest[facing=north,type=single]`, because the metadata nibble has to say which
way it faces. The rule is simply "the exact state did not match".

**The outline follows the pointer in orbit, not only the crosshair in flight.**
In flight the crosshair *is* the pointer, so "what am I about to click" answered
itself and the outline was flight's alone. In orbit there was no answer: you
clicked a block to inspect it, or Shift-clicked to select it, and nothing said
which block the ray had found until after the click. The pick was already being
computed — it simply was not drawn.

`block_hover.ts` decides, and is a plain module for the reason `selection_drag.ts`
and `floating.ts` are: this runs from `requestAnimationFrame`, which belongs to
the rendering steps, and the harness here is frequently not compositing. Two
suppressions in it are the part worth knowing, and both are about not promising
a click that does something else: the outline yields over a selection **face
handle**, where the cursor has already become a resize cursor and the press
drags the face, and it yields **while a face is being dragged**.

Its colour is `--selection`, like the wire box, the plates and the build-grid
patch. It was a hardcoded black — the only colour in `Viewer.svelte` not taken
from the theme, and therefore the only one that stayed put when the window went
light.

**Block picking steps a *hair* inwards from the hit face**, not half a block.
The mesh is one fused geometry with no per-block identity, so the owning block
is found by moving `1e-3` along `-normal` from the hit point and flooring. Half
a block is the obvious choice and is wrong: a pressure plate is a sixteenth
tall, so stepping half a block in from its top face lands underneath it.

**`block_id_list.txt` is generated, and the registry decides what is in it.**
`node scripts/gen-block-list.mjs > block_id_list.txt`, idempotent, from
`resources/block_states.json` — the game's own block registry — plus the
pre-Flattening names only `legacy_blocks.json` still carries, minus four debug
and air blocks excluded by name with the reason beside each. It is also the list
spliced into the prompt, so the set the model is told about cannot drift from
the set it is judged against.

It was hand-written family tables — one entry per wood, per stone, per copper
oxidation stage — *seeded from the list it was regenerating*, so it could only
grow and only by hand. It was **189 blocks behind** the registry vendored beside
it: no coral fans, no firefly bush, no `pale_oak` anything, half the stone
slabs, the banners, the heads, `pumpkin` and `short_grass`. Nobody had noticed,
because **a missing block is invisible from inside the app** — you cannot miss
what the inventory never offered. That is the same failure the hand-written
`DEFAULT_STATE` had, one layer down, and it is the argument for generating a set
rather than curating one.

**Seven vendored datasets, seven generators, seven skills.** The pattern is the
same each time and it is the one to copy: the answers are looked up, recorded
with where they came from, and the generator replaces only the rows between two
markers. Running with nothing new must change no bytes — if it rewrites the file
every time, the ordering or the formatting has drifted and *that* is the bug.

| data | generator | skill |
|---|---|---|
| `resources/mc_versions.json` | `gen-mc-versions.mjs` | `mc-versions` |
| `resources/block_states.json` | `gen-block-states.mjs` | `mc-blockstates` |
| `resources/block_properties.json` | `gen-block-properties.mjs` | `mc-blockproperties` |
| `block_id_list.txt` | `gen-block-list.mjs` | `mc-block-models` (for what the ids must draw as) |
| `resources/litematica_versions.json` | `gen-litematica-versions.mjs` | `mc-litematic` |
| `resources/command_syntax.json` | `gen-command-syntax.mjs` | `mc-commands` |
| `resources/block_versions.json` | `gen-block-versions.mjs` | `mc-block-versions` |

The skills' trust rules deliberately differ, and the difference is the point.
`mc-versions` buys trust with **two independent sources that agree**, because a
transposed digit in a DataVersion is undetectable by any local check — the file
saves, opens, and misbehaves in game. A wrong property name or texture name is
**mechanically detectable**, so those skills' job is to keep the tripwire
honest rather than to count sources. Corroboration still applies where no
machine can check: the *history*, which is prose on a wiki page and appears in
no dataset.

`mc-blockproperties` is the `mc-versions` rule arrived at from the other
direction, and it is the one to be most careful with. Its content is **prose**
— what a property is *for* — which fails no check anywhere, ever: the file
saves, the block is placed, the picture is right, and a model reads the sentence
and builds the wrong thing on the strength of it. So corroboration, and where
two sources disagree the game's own registry is a genuine arbiter. It settled
one already: minecraft.wiki's `Block_states` page says sign and banner
`rotation` changed default from 0 to 8 in 26.1 while its own `Sign` page says
the default has always been 0, and the vendored 26.2 registry says `8`.

`mc-litematic` and `mc-commands` split along the same line, and the split lands
between the two halves of one file rather than between two files. A
`.mcfunction`'s **syntax** is mechanically detectable — the writer emits it, the
reader parses it back, and a wrong form cannot survive the round trip — so one
source is enough. Its **limits** cannot fail here at all: a function past
`max_command_sequence_length` has its remaining commands ignored with no error,
and a `fill` past `max_block_modifications` places nothing and reports nothing.
Neither is a property of the file, so no test can ever see it, and those rows
are corroborated. A Litematica `Version` is the `mc-versions` case outright:
wrong, and Litematica opens the file and *converts* it.

`mc-block-versions` is the split running through the *middle* of one file
rather than between two. Its `blocks` and `properties` halves are derived from
a diff and re-checked mechanically; its `renames` and `propertyValues` halves
cannot be, and that is not a gap in the tooling — **a diff sees `chain`
disappear at 1.21.9 and `iron_chain` appear and cannot tell that from a removal
plus an unrelated addition.** Nothing anywhere can tell you that a 1.16 wall's
`tall` should come back as `true` rather than `false` either. Those rows are
corroborated on the wiki's History section and carry their evidence.

**And that dataset is the one where a wrong answer *destroys* rather than
omits.** The other six fail by being incomplete; this one, believed, replaces
every affected block in somebody's build with empty space, reports a healthy
count, and looks entirely deliberate. It came within one design decision of
doing exactly that: `misode/mcmeta`'s summary — the source `block_states.json`
already uses — **changed what it lists at 1.20.5**, holding only blocks with
properties up to 1.20.4 and every block after. 686 entries, then 1060, with
`stone` appearing at the boundary. A plain diff of it dates `stone`, `dirt`,
`oak_planks` and some 370 others to 1.20.5, and acting on that turns any
backport to 1.19 into a demolition. The same mechanism manufactures a false
rename: `cauldron` vanishes at 1.17 because its `level` moved to
`water_cauldron`, not because the block went anywhere.

So block presence comes from **`PrismarineJS/minecraft-data`**, which lists
every block at every version — `stone` present in all 37 it covers, and zero
monotonicity gaps — and mcmeta only corroborates. `mc-versions`' rule, and its
*«absence is not disagreement»* clause, arrived at from the data rather than
from the principle. Property **values** still come from mcmeta alone, because
minecraft-data types an integer property as a count with no range and its own
count moves between releases: read naively it has `snow.layers` changing four
times for a property the game has never touched.

**The whole flat era holds five renames and seven value changes**, which is the
number worth knowing before the next person fears this dataset. The renames are
`sign`, `wall_sign`, `grass_path`, `grass` and `chain` — every one of them
already named elsewhere in this file — and of the value changes only the walls'
1.16 `true|false` → `none|low|tall` touches a real build.

**Two generators cross-check their DataVersions against `mc_versions.json`**,
which is the corroborated one, and refuse rather than write their own number.
Two datasets naming one fact is how they come to disagree, and that check has
already earned itself: the first draft of `litematica_versions.json` recorded
1.18 as 2825, which is a snapshot, where the verified table says 2860. Nothing
downstream would have noticed — the file saves, opens, and is converted by
Litematica for everyone on 1.18.0 or 1.18.1.

**The two new floors are different releases, and that is the finding rather than
an oversight.** A `.mcfunction` needs `setblock <pos> <block>` with a flattened
id, which is **1.13**. A `.litematic` needs Litematica's reader not to convert
it, and that reader converts anything whose schematic `Version` is below 5 *or*
whose `MinecraftDataVersion` is below 1631 — so the floor there is **1.13.2**,
one release later than this app's own `flat` era begins. `tests/formats.ts`
states the inequality out loud, because "harmonising" the two to 1.13 is a tidy
edit that would put every 1.13-tagged litematic through a palette conversion.

Litematic **block storage** stopped moving at version 5: the palette, the packed
longs and `Position`/`Size` are the same in 5, 6 and 7, and what changed is what
goes inside an entity or a block entity — which this app carries verbatim, as
it already does for Sponge. So one decoder reads all three, and the only
version-dependent decision on the way out is which number to stamp: 7 from
1.20.5, because always-7 writes files Litematica below 1.20.6 refuses outright
and always-6 puts component-shaped item NBT under a label promising the older
shape.

`litematicCanCarry(null)` is **false**, and that is not timidity. A litematic
must carry a `MinecraftDataVersion`; Sponge may omit its tag and MCEdit has
none, so this is the one container with no escape, and defaulting to 1631 would
tell every reader downstream that a build was cut from a version nobody named.

**There are two ways into a document and neither is a panel.** The File menu and
the start screen — the card the empty viewport shows. That is the answer to a
whole class of "X is missing" reports that turned out to be "X is in the sidebar
tab you never open": recents, New, Open and Save had all been wired end to end
for weeks, behind `sidebarTab = $state("chat")` and a name that did not say what
the tab held.

**And there is no second tab at all: the sidebar is the chat.** It was called
Schematic, then Generate, and neither name was wrong — the drawer really did
hold three unrelated things, so each rename only changed which of the three the
name lied about. Renaming a container that holds unlike things is the move to
distrust; the fix is to stop it holding them.

Where the three went, and why each destination is the honest one:

- the **version history** to a modal, after a spell as a floating window over
  the canvas. That was right about its nature — a reflection of the open
  document, exactly like the inspector — and wrong about its size: a
  `ToolWindow` was a fixed 232px and a row here reads `manual · 64×32×64 ·
  12,048 blocks` with a Restore beside it, so every row ellipsised. It differs
  from the tools and the inspector in the way that decides its default: nothing
  *summons* it — a selection brings the tools back and a click brings the
  inspector back — so it starts closed and has a button in the document bar. A
  panel with no way back is a feature you delete by accident.
- the **generated files** to the start screen beside the recents. Their only two
  verbs are "open this" and "show me where it is", which are that screen's whole
  job, and it is the one place a generated `.mcfunction` is admitted to exist —
  nothing opens one. Entries already in the recents are filtered out, because a
  generated `.schem` is opened the moment it is made.
- the **generator form** nowhere, because it was a second, worse chat. The chat
  has built a schematic from a sentence since the day it learned to, with the
  same model and the same progress. What was worth keeping was the reference
  image and the export format, and those are inputs to a *message*: they sit on
  the composer, and only with nothing open, which is exactly when a message
  builds rather than edits.

Two things fell out of that and are worth knowing. The generation progress bar
was in the form, in a tab, which is to say **not on screen while you waited for
the build you had asked for in the chat** — it is in the chat's live turn now,
matched to the build by request id because previews emit progress too. And the
form's Generate button was disabled when the provider had no key while the chat
would happily send a message that could only come back as an error; the guard
moved to the send button, which is now the only control that can start either.

The start screen is a sibling of the viewer, not part of it: `Viewer.svelte`
receives geometry and has no business knowing what a recent document is.

**It blocks the window, and it can be dismissed. Both halves are the rule.** It
used to be a card over a live app — `pointer-events: none` on the container with
`auto` on the card alone — so the camera buttons, the gear and the whole sidebar
took clicks aimed at a document that was not there. It is a scrim now, on the
modal tier, with the skeleton every other modal has.

Dropping a file still works, and the reasoning that once argued against a
full-bleed cover is the reasoning that makes it safe: the handlers are on
`section.preview`, the card stays a DOM child of it whatever `position: fixed`
does to its painting, drag events bubble, and `App.svelte` counts enters against
leaves *because* children fire them — so one more child changes nothing.

Dismissable because **with nothing open a chat message goes to the generator**.
That is how a schematic gets built from a sentence, and this screen is the only
place that says so; a screen covering the chat that could not be put away would
delete the path it advertises. So Escape, the backdrop and a close button put it
away, and it comes back from the document bar and from Ctrl+K — the same rule as
the version history, for the same reason.

**And with nothing open there is no Edit menu at all**, rather than one holding
two permanently greyed rows. Both were already disabled, which is the honest
answer to "can I undo" and the wrong *shape* of answer: with no document there is
nothing that menu could ever offer. The File menu keeps its disabled rows because
it has live ones beside them; this one has nothing to be beside. `menuSignature`
already carries `hasDocument`, so the bar rebuilds on open and close by itself.

**"Nothing open" stays a real state.** It is tempting to create an untitled
document at launch so the build grid always has a target, and it would silently
delete a feature: a message typed with nothing open goes to the **generator**,
which is how a schematic gets built from a sentence. The start screen names that
path, because it is otherwise discoverable only by accident.

**The application bar carries the document, and the window title carries both.**
Filename, size, block count, container, version and the dirty marker were all
visible only inside the sidebar's second tab — so the app could tell you there
was unsaved work, but only while you were looking away from what you were
building. The title is main's (`windowTitle` in `menu_model.ts`), with the dirty
marker leading, because a taskbar button truncates from the right.

**A floating panel is resizable, and its size is two settings per window.**
`ToolWindow` was `width: 232px` in CSS with no size props at all — the number
that sent the version history off to a modal, and that leaves the inspector
rendering `Items[0].tag.display.Name` in a column narrower than the path. The
handle is `SidebarSplitter`'s shape, which its drag code was already a fork of:
a live callback per move, one commit at the end, arrow keys, and the ARIA
separator contract.

`Bounds` carries `panelHeight` for exactly one rule: a panel **taller than the
pane** may hang off the top, far enough to bring the resize corner back into
reach. Pinned at `y = 0` it could never be made smaller again. A panel that fits
still cannot go above zero, because the first thing to disappear upwards is the
title bar.

`PANEL_SIZE` is in `shared/settings.ts` beside `SIDEBAR_WIDTH` rather than in
`floating.ts`, because `coerceUi` needs it and main must not import out of the
renderer. The order of `clampPanelSize`'s two clamps is load-bearing and named
in the checks: the **minimum is applied last**, so a pane smaller than it yields
a panel that overflows rather than one that has collapsed — an unusable window
you can see and drag beats a usable one you cannot reach.

**The materials list is the whole palette.** It showed eight and said "…and N
more", over a `DocumentState` main had already cut to 64 without a word — so
past 64 distinct states that sentence *understated* the palette, which is worse
than either cap alone. Both are gone, and the cost was already paid:
`paletteHistogram` walks every voxel on every state push either way, so dropping
the `.slice` adds payload, not work.

**A Svelte prop may not be called `state`.** A local binding of that name makes
every `$state(...)` in the same component parse as a store subscription to it
(`store_rune_conflict`), and the fields silently stop being reactive.
`DocumentPanel`'s prop is `doc` for exactly this reason.

**The sandbox engine is `quickjs-emscripten`. Do not reintroduce `isolated-vm`.**
It cannot be loaded in Electron at all: it links against `v8_inspector::*` and
`v8::SourceLocation`, which Electron's `node.lib` exports none of, and its
`inspector.cc` has no compile-time opt-out. This was verified with `dumpbin`,
not assumed. QuickJS-on-WASM also happens to match the engine the original
Python used.

**The project has zero *native* dependencies** -- the qualifier now matters.
The renderer bundles `marked` and `dompurify` (and `jsdom` for the tests), all
pure JS and all devDependencies, because the renderer is bundled by vite exactly
like `three` is; none of them reach the asar's `node_modules`. What the original
claim was protecting is intact — no `electron-rebuild`, no
`asarUnpack`, no per-platform build toolchain, one asar works everywhere. Any
new dependency with a `.node` binding gives that up; weigh it accordingly.

**`tests/sandbox.ts` guards the sandbox contract** — no ambient authority in the
guest, deadline enforced, engine-failure vs bad-generated-code kept distinct,
coordinates rejected rather than coerced, block allowlist applied, bridge
arguments isolated. It must stay green.

**The renderer is powerless by construction.** `nodeIntegration: false`,
`contextIsolation: true`, `sandbox: true`, and a CSP whose `connect-src` is
`'none'` — the renderer opens no connection of any kind. Every HTTP call is made
by the main process — that is the whole reason this is an Electron app rather
than a web app. If a feature seems to need network access in the renderer, it
belongs in main.

**A mesh answer is the difference, not the document.** The chunked mesher
re-meshes only the chunks an edit touched — three of a hundred and twenty-eight,
for one placed block — and main then shipped all of them anyway, with the atlas:
on a 128×32×128 that is **17.5 MB of geometry plus 20.8 MB of pixels**,
structured-cloned across the boundary and rebuilt into fresh `BufferGeometry` on
arrival, *per block placed*. That was the stutter, and none of it was the
meshing.

So `MeshPayload` carries `partial`, `dropped` and a `token`, and the request
carries what the window already holds. Four things about it are load-bearing:

- **"Changed" is object identity on the positions array.** `buildChunkedMesh`
  carries the very same `MeshBuffers` forward for a chunk it did not re-mesh, so
  a different array *is* a different chunk. No hashing, and nothing to remember
  at the call sites — which matters, because there are several ways to edit and
  a notification missed at any one of them would ship a stale chunk.
- **The token is main's own cache key and is opaque to the renderer**, which may
  only hand it back. An unrecognised token is not an error, it is a full
  payload: every answer is a correct answer to every question, and only the size
  varies.
- **A delta with no chunks in it is the ordinary answer to "nothing moved".**
  Read as a full payload it says the document is empty, so `Viewer.svelte` must
  check `partial` *before* it checks for emptiness or the whole structure comes
  down on a redraw.
- **Main answers in full whenever the last thing it sent was nothing.** An empty
  document takes the viewport's model down, and a delta would then arrive at a
  scene with nothing to update; refusing to be incremental there means the
  renderer never has to reason about that case.

**The viewport receives geometry, not a container format.** `docMesh` hands over
per-chunk `Float32Array`/`Uint32Array` attributes plus the atlas as raw RGBA
pixels; `Viewer.svelte` builds `BufferGeometry` and a `DataTexture` directly.
There is no glTF and no `GLTFLoader` in the renderer.

This replaced a GLB with the atlas embedded as a PNG, and it is worth knowing
what that cost, because it is the kind of failure this shape makes impossible:
three.js decodes an embedded image through `ImageBitmapLoader`, which `fetch`es
a `blob:` URL, so the CSP had to allow `blob:`. Block it and nothing raises —
`GLTFLoader.loadTextureImage` ends in `.catch(() => null)`, so the model loads,
`onLoad` reports success, and it renders **untextured white**. There was no way
to select a different loader either: GLTFLoader only consults
`manager.getHandler()` for images carrying a `uri`, and ours lived in a
bufferView. Raw pixels decode nothing, so nothing can fail quietly; the tripwire
that used to detect it (`untexturedReason`) is gone with the failure.

`pipeline/gltf_builder.ts` still builds GLBs and is still tested, but nothing in
the app calls it any more. Delete it or grow an "export .glb" feature — do not
leave it drifting.

**`IPC.preview` and `buildPreview` are now in the same position, and for a good
reason.** They drew a *file* without opening it, which is what the app did
before a generated schematic became a document: you got a picture of what had
been made and none of the editing tools could touch it. Generating opens its
result, dropping a file opens it, and the start screen opens one — every route
that used to end in a preview now ends in a document, which can do everything a
preview could. Same instruction as above: delete them or grow the feature that
wants them.

**API keys never travel main → renderer.** They are stored encrypted via
`safeStorage`; the renderer only ever learns `{ hasKey: true }`.

**The app serves its own editing surface over MCP, and the rule is one
sentence: every operation must leave a way back inside the app's own model.**
`src/main/mcp/` is a listener on loopback that lets a stronger harness — Claude
Code, Codex — drive the schematic the user has open, through the same tools,
with the same undo stack underneath. What those harnesses cannot do for
themselves is the whole value: read and write the container formats, place a
block with the state and the neighbour connections the game would give it, mesh
the result, and show a picture of it.

An external client can already destroy a build with one `fill_region`, and that
is *acceptable* because it is a transaction, on the undo stack, with a version
history behind it. So the rules are only for the verbs that would step outside
that net: a save snapshots first, `save_document_as` moves an existing file
aside under a timestamp rather than overwriting, opening over unsaved work is
**refused**, and a delete goes to `shell.trashItem` and never to `unlink`.

**HTTP, not stdio, and the reason is the whole point.** stdio means the *client*
spawns the server, and a freshly spawned process has no document open. What
makes this worth building is the session the user is looking at — they watch the
build change and their Ctrl+Z takes it back. `resources/mcp-bridge.mjs` covers
the stdio-only clients by forwarding to the running app; it is dependency-free
plain Node because it is run by whatever `node` the *client* has, which cannot
see this app's `node_modules`.

**Never a native dialog.** `discard_prompt.ts` is right for a person at the
keyboard and wrong twice over here: a background agent must not be able to make
a modal appear on somebody's screen, and must certainly not answer its own
question about throwing away their work. The refusal *is* the answer, phrased
for a model to relay and call again with `discardUnsavedChanges`.

**Four tables, because there are four relationships to a transaction**, and
mixing them is how you get an edit that cannot be undone:

| | |
|---|---|
| `agent/tools.ts` | needs one **wrapped around it** — `callTool` provides it |
| `mcp/document_tools.ts` | **owns its own** (`pasteSelection` already calls `runTransaction`) |
| `mcp/lifecycle.ts` | needs **none** — it replaces the document rather than editing it |
| `mcp/policy.ts` | pure rules, no effects at all |

`TOOL_SPECS` is why the first row is shared rather than copied: two places
deciding what `fill_region` means is how you get a tool that works in the chat
and not over MCP. `tests/mcp.ts` states that from both sides — every agent tool
must be offered, and MCP must have invented none of its own.

**Mutating calls are serialised, and `serialised` is tested directly.** Driving
it through two `fill_region`s proves nothing: that body has no real `await`, so
the two run in order whether or not the queue exists, and a check written that
way passes with the queue deleted. Verified by deleting it.

**`Recorder` is not exported, so a tool cannot edit outside a transaction at
all.** `refusingScope` covers the one case left — a writing tool wrongly listed
in `READ_ONLY` — and fires with a sentence naming the mistake.

**`readOnly` and `changesDocument` are different questions.** `copy_region`
writes the clipboard the user's own paste reads, so it is not read-only; the
schematic did not move, so the viewport has nothing to redraw. One flag would
make one of those a lie.

**The checkbox is intent; `McpStatus` is reality.** They come apart when a port
is already held by a second copy of the app, and a navbar dot derived from the
setting would be green over a server that never started. `mcp_status.ts` holds
the rule, and `showsIndicator` never hides a *listening* server whatever the
setting says — the warning is the point.

**The MCP token does travel to the renderer, deliberately.** The standing rule
protects credentials for *remote* services; this one authorises a local server
the app generates itself and exists to be pasted into another program. Masked,
re-masked when the modal closes, and regenerable — rotation is the mitigation
that matters.

**Main can now push a `DocumentState`, and could not before.** `IPC.docChanged`
and `services/broadcast.ts`. `shellState` is the *asked-for* case and must not
push — the caller already has the value, and a selection-face drag sends an edit
many times a second. `announceDocument` is the unasked case. Folding them into
one function with a flag would put that decision at twenty-one call sites.

**`capture_viewport` photographs the window, and cannot aim the camera.** Main
cannot work out where the canvas is — the layout is CSS — and cannot *ask* the
renderer anything, only be told; so the renderer reports its rect from `resize`.
Aiming would need a request from main to the renderer and a reply channel, which
does not exist.

**One IPC channel per verb, all declared in `src/shared/ipc.ts`.** No generic
dispatcher. Everything crossing must be structured-clone-safe — binary payloads
are `Uint8Array`, never `Buffer`.

The application menu is where that rule costs the most and earns it: eight
channels, `menuNew` through `menuRedo`, rather than one `menuCommand` carrying a
string. The string version is the dispatcher the rule refuses, *and* it would
blind the channel walk in `tests/services.ts` on the eight channels most likely
to be declared and never wired. For the same reason `menu.ts` writes
`send(IPC.menuNew)` out once per verb instead of looking the channel up in a
table — the walk matches the **call**, so `{ new: IPC.menuNew }` reads as a
mention and proves nothing. That walk now reads every `.ts` under `src/main`,
not `handlers.ts` alone: pinned to one file it called all eight menu channels
unserved, which is a correct menu reported as broken, and that is how a tripwire
gets deleted rather than fixed.

**The menu is main's because the accelerators are.** An accelerator declared in
a `Menu` is claimed before the window sees the keystroke, so a menu item and a
`keydown` branch cannot both own Ctrl+S — one of them silently stops working.
Where the menu takes a key, `App.svelte` has given it up.

The exception is **Undo and Redo, which have menu entries and deliberately no
accelerator.** A menu item cannot ask where the caret is, so Ctrl+Z there would
stop undoing what you are typing in the chat and start undoing block edits —
from a field where nothing on screen suggests it. They stay on the keyboard
handler, behind `isTyping`, alongside the buttons in the document bar.
`tests/services.ts` asserts the absence, because it looks like an omission.

**The Help menu is unconditional, where the Edit menu is not, and that is one
rule rather than an exception to it.** Edit is hidden with nothing open because
every row it could show would be dead; About answers exactly as well with no
document as with one — it names the version, what this is derived from, and
that it costs nothing. Copying Edit's conditional would hide it precisely on the
empty start screen, which is where somebody looking the app over for the first
time goes looking. It carries **no accelerator**, which is conventional for the
item and also keeps the row out of the flight-mode argument entirely: a key that
was never claimed cannot be handed back wrong.

**The icon has one master and every other size is generated.** `build/logo.png`
is the file a human edits; `scripts/gen-icons.mjs` writes the nine
`build/icons/<n>x<n>.png` electron-builder wants for Linux, the `build/icon.png`
the `.ico` is cut from, and the two 256px copies the About box and the README
header read. Nothing `.ico`-shaped is committed: electron-builder generates it,
and ffmpeg cannot write a multi-resolution `.ico` at all, so a hand-rolled one
would be strictly worse than the tool's own.

**`win.icon` is stated, and the icon set is why it has to be.** Left to the
buildResources scan, app-builder cuts the `.ico` from `build/icons/` rather than
from `build/icon.png` and takes the *largest* member — so adding a 1024px file
to that directory put a 1024px image into the `.ico` under a directory record
saying 256, which is the largest number an `.ico` can express (it stores 256 as
a literal `0` and has no room for more). NSIS refused the installer outright:
`invalid icon file size`, from `MUI_INTERFACE`, naming the generated cache and
nothing about where it came from. The scan is right for the other two and is
left alone — an `.icns` holds 1024 and Apple asks for it, and the Linux set *is*
that directory — so this is one platform disagreeing with the others about what
the biggest useful icon is, rather than a rule with an exception.

Worth knowing before the next size is added: the working `.ico` has **one**
entry, 256px, and always did. That is not a degraded result to be improved on.

`release/.icon-ico/icon.ico` is that generated cache under a gitignored
directory, which is why the old mark was findable only there and looked like a
source with no origin. It was never missing; it was `build/icon.png`, under a
name that does not say it is the master.

**The premultiply pair in that script is load-bearing.** `scale` does not
premultiply alpha, so it interpolates the RGB of fully transparent pixels —
`(0,0,0,0)` in a generated PNG — into the opaque ones beside them. Measured on
this master at 16px, semi-transparent edge pixels come out **41.8/255 darker**
without the pair than with it: a dark halo tracing the mark, worst at the sizes
where one pixel of fringe is a fifth of the icon. It reads as artwork that was
cut out badly rather than as a missing flag, so the script checks both filters
by name and refuses to write anything without them. Running it with an
unchanged master must rewrite no bytes — the six data generators' rule, for the
same reason.

**And `appIconPath()` is the one helper in `resources.ts` that cannot use
`resourcesDir()`.** `build/` is a build *input* and does not ship, so the
packaged copy is a flat `icon.png` placed by `extraResources` while the dev copy
is the master's own directory. It exists because `BrowserWindow` had **no
`icon:` at all** — macOS ignores the field and a packaged Windows window takes
its icon from the executable, so what it actually buys is development on every
platform, where the alternative was Electron's own logo, and Linux everywhere.

**The version in it comes from `app.getVersion()`, over IPC, not from a constant
compiled into the renderer.** A vite `define` would have worked and would have
put a second copy of the number beside `package.json` — and of two copies the
one that goes stale is the one on screen, in the box a person reads at the exact
moment they are about to report something. `AppInfo` carries the Electron,
Chromium and Node versions beside it because `process.versions` is free and
those four lines are the whole of a bug report's header.

Nothing in the app said any of this before. The licence, the origin and the
"free, and staying free" were in `README.md` alone, which is to say on GitHub
alone, which is to say nowhere at all for anyone who installed the thing.

**The app is built and released by GitHub Actions, and `develop` never commits
a version.** `master` ships the number in `package.json` exactly; `develop`
ships that number plus `-dev.<run_number>`, stamped on the runner by `npm
version --no-git-tag-version` and never written back. That single decision
removes the whole category of CI-writes-to-the-repo faults: no bot commit, no
`[skip ci]` loop, no write token on a protected branch, and no conflict on
`package.json` when develop is merged.

**A commit message that merely *mentions* the skip directive suppresses the
run.** GitHub matches `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]` and
`[actions skip]` anywhere in the message, the **body included** -- so the very
commit that introduced these workflows ran nothing at all, because its body
explained that this design avoids exactly that loop and spelled the token out to
do it. The symptom is worth recognising, because it looks like something else
entirely: zero runs *and* zero registered workflows, which is indistinguishable
from Actions being disabled on the repository, and sends you to the settings
page. When writing about it in a commit message, spell it without the brackets.

`checks.yml` carries `pull_request` **and** `workflow_call`, so the PR gate and
`build.yml`'s first job are one definition rather than two that drift. Its
concurrency group is prefixed `checks-` against the caller's `build-`, and that
difference is load-bearing: a reusable workflow declaring its caller's own group
**deadlocks**, the caller holding it while the callee queues behind it forever.
It runs `scripts/check.sh` rather than the seventeen npm scripts written out
again, which is what makes a suite added tomorrow covered with no edit to any
YAML — the script was already suited to it, with colours off a TTY, `npm ci`
only when `node_modules` is absent, and no early abort.

**Running that gate on both operating systems earned itself on the first run.**
`tests/mcp.ts` spelled its fixtures `C:/builds/x.schem`, which is absolute on
Windows and **relative everywhere else** — there is no drive letter on Linux —
so `withinRoot`'s `path.resolve(root, candidate)` placed it *under* the root and
the path doubled: `.../C:/builds/C:/builds/x.schem`. Windows was green and Linux
was not, on the same commit.

The rule was right and the fixture was wrong, which is the part worth keeping
straight: resolving a relative candidate under the root and letting an absolute
one replace it is exactly the semantics that function wants. The string simply
was not a path on the machine running it, and `abs()` in that file now spells an
absolute path the way the running platform spells one.

Two of the three failures reported a doubled path and read as a normalisation
bug. The third reported a file trashed where the run expected nothing at all —
the "you may not delete the open document" guard comparing the resolved
candidate against the open file, finding them different because one had doubled,
and standing aside. A guard that quietly stops guarding is the failure this
suite exists to catch, and here the suite had done it to itself.

Only that suite was affected. `tests/services.ts` and `tests/document.ts` carry
the same spelling, and their paths never reach `path.resolve` — `pathsMatch` is
a string comparison — so they are opaque fixtures that behave identically
everywhere.

**`BUILD_NUMBER` is set on develop and deliberately not on master.**
electron-builder reads it from the environment by itself and folds it into the
Windows file version as `major.minor.patch.<n>`, substituting `0` for anything
that is not a plain integer — so without it every dev build presents itself to
Windows as `1.0.0.0`, indistinguishable from every other one in the exact field
someone reads to say which build they have. On master `x.y.z.0` is the correct
answer instead: two rebuilds of one release *should* be identical.

**Nothing publishes except the publish job.** electron-builder publishes on its
own when it finds a `GH_TOKEN`, so the packaging step deliberately has none in
its environment; otherwise it races the job that creates the release and leaves
it half filled.

**A `master` build fails if its tag already exists.** Forgetting the bump is the
ordinary mistake and its silent form is a second release replacing the first
under one number. The bump stays manual on purpose: for an app somebody
downloads, the version is a statement to a person rather than a function of the
commit log, and `semantic-release` would additionally have to get its computed
number into `package.json` before electron-builder reads it — meaning a commit
back into a protected branch, or a repo whose version is permanently a lie and
whose local builds disagree with CI. The conventional commits already in use
still pay for themselves through `gh release create --generate-notes`, which
costs no dependency and writes nothing.

**Two Windows targets emit a `.exe`, so neither may use `win.artifactName`.**
`nsis` and `portable` would resolve one shared name to one path and the second
would overwrite the first — with **no error**, which was verified by doing it:
both targets logged themselves writing `SchematicAIStudio-1.0.0-setup-x64.exe`
and one file survived, the portable, under the installer's name. A mislabelled
artifact is worse than a missing one. Each target names its own file.

**There is no `deb` and no `rpm`, and that is not an oversight.** fpm requires a
maintainer; electron-builder takes it from `package.json`'s `author`, which here
is a plain string with no email, and raises `authorEmailIsMissed` — failing the
*whole* Linux run rather than that one target. An AppImage carries no maintainer
field, which is the only reason it is unaffected. Re-enabling is exactly two
lines: the target back in the list, and `maintainer: name <email>` under
`linux:`.

**In flight, Ctrl belongs to the camera, and only main can honour that.** With
the pointer locked the keyboard is flying: Ctrl is the sprint modifier and WASD
is the direction. So every Ctrl+letter the app binds is also a way of moving —
Ctrl+A selected the whole schematic while strafing left, and **Ctrl+W closed the
schematic while running forwards**, which is the one that costs something.

The rule is one sentence and it is enforced in three places because it has to
be:

- `App.svelte`'s `onWindowKey` returns on anything Ctrl- or Cmd-modified while
  `document.pointerLockElement` is set. **Blanket, and first in the function**,
  which is the same decision twice: an allowlist would have to be re-judged
  against the movement keys by whoever adds the next shortcut, and a gate
  further down is a rule that anything written above it silently escapes.
- The **menu cannot be fixed from the window at all.** An accelerator is claimed
  before the keystroke arrives, so `menu_model.ts` stops *registering* its
  accelerators instead — one `releaseAccelerators` pass over the finished tree,
  so it covers the accelerator somebody adds next. `registerAccelerator: false`
  prints the key and does not claim it, which is why it is that rather than
  `enabled: false`: disabling would take the mouse's way in along with the
  keyboard's, for nothing.
- `Hotbar.svelte` stops *refusing* Ctrl, which is the same sentence from the
  other side. Ctrl+3 picks the third slot while sprinting; declining it was the
  mirror image of the bug the gate fixes.

`before-input-event` is the obvious mechanism and is the wrong one: its
`preventDefault` suppresses "the page keydown/keyup events **and** the menu
shortcuts", so the viewer would never see `KeyW` go down and Ctrl would stop
being a sprint key at all — the collision removed by deleting the thing it
collided with.

**Gated on the pointer lock, not on the camera mode.** In fly mode with the lock
released `updateFlight` returns early, so nothing is steering and there is no
collision to avoid; the lock is exactly the set of moments the keys are the
camera's. It also makes Escape the way back, which is the key a player already
presses to get a cursor — and it is why Ctrl+K can no longer summon the command
palette from flight. That was deliberate once (`togglePalette` releases the lock
on the way in) and it is Escape-then-Ctrl+K now; the release stays because any
other way in would need it.

`IPC.pointerLock` is the report, and it is `viewportRect`'s shape for
`viewportRect`'s reason: main cannot work it out and has no way to ask. The flag
lives in `menu.ts` rather than beside `viewportRect` in `handlers.ts` only
because that module imports this one. It starts `false`, and the renderer
reports on mount as well as on change — main's flag outlives the component, so a
dev reload would otherwise leave the menu holding whatever the last instance
said.

`tests/services.ts` walks the whole menu tree and requires no accelerator to be
claimed in flight, that the rows keep their labels, keys, enablement and
recents, and that releasing is *all* the flag does. It also requires every field
of `MenuItemModel` to be copied in `menu.ts` — `registerAccelerator` dropped
there would leave the menu claiming Ctrl+W with every other check still green,
which is `coerceSettings`' failure in another module. The two renderer halves
are a browser fact this harness has no browser for, so `tests/ui.ts` checks the
source the way the coplanar epsilons are checked: that the gate is there, and
that it is still the first thing in the function to look at a modifier.


**Enablement is decided from main's own state**, not reported back by the
renderer: `currentSession() !== null` plus the recents list main already owns.
`busy` is deliberately not modelled — it is a renderer convention, and every
action behind these items refuses on its own. `refreshShell` rebuilds the menu
only when its *shape* moved (a signature over `hasDocument`, the recent paths
and whether the keyboard is flying the camera) and always retitles, because it is called from every handler that answers
with a `DocumentState` — which is many times a second during a drag, and
rebuilding a native menu at that rate flickers the bar.

**Anything that can throw away unsaved work asks first**, and the box lives in
main. `newDocument` reassigns the open session without looking at what was
there and opening a file does the same, so the check has to be *in front of* the
call — by the time `session.ts` has the request, the user has already been shown
a dialog about the new document. The wording is in `services/discard_prompt.ts`,
Electron-free so the suites can reach it, and shared with
`mainWindow.on("close")`, where there is no renderer left to ask with. The
destructive button never becomes a bare "OK": "Discard changes?" answered
OK/Cancel is a coin flip, and half the flips lose work.

**`saveDocument` falls through to Save As on its own.** That check used to be
written out at the call sites, and the third caller did not have it — so New,
one edit, Save produced a red banner reading "choose where to put it": advice,
where the app could have asked. A rule enforced by discipline at three call
sites is a rule that is wrong at one of them.

**An empty document is not a failure.** `buildDocumentPreview` raises
`EmptyPreviewError` rather than returning an empty mesh, which is right for
previewing a *generated* file and wrong for the editor — a new schematic has
nothing in it by definition. `refreshDocument` therefore only surfaces that
message when `blockCount > 0`, and clears the mesh on **any** failed refresh:
without that, deleting every block left its ghost on screen, still selectable.

**Objects built from `$state` must go through `forIpc()` before an IPC call.**
`$state` on an object is a deep `Proxy`, and structured clone cannot serialize a
Proxy: `ipcRenderer.invoke` rejects with `An object could not be cloned.` and
names neither the value nor the channel. Spreading does not help —
`{ ...settings }` still has proxies at `preview` and `ui`. `forIpc` lives in
`renderer/src/lib/bridge.svelte.ts`, and **that filename is load-bearing**: it
calls the `$state.snapshot` rune, which is only compiled inside `.svelte` and
`.svelte.js/ts` modules. In a plain `.ts` it typechecks and then throws
`rune_outside_svelte` at runtime, so `svelte-check` will not catch the mistake.

**`src/renderer/tsconfig.json` exists so an editor finds the renderer's own
settings, and it is not a fourth config.** It extends `tsconfig.web.json` and
adds nothing. An editor discovers a config by walking up from the file looking
for `tsconfig.json` **by name** — `tsconfig.web.json` is not a name anything
searches for — so from a `.svelte` file that walk used to reach the repo root,
whose config mirrors `tsconfig.node.json`. A renderer file was therefore being
resolved with `lib: ES2022` and `types: [node, electron]`.

The symptom is narrow enough to look like one broken line rather than a wrong
config: `import logo from "../assets/logo.png"` reported as TS2307 in the IDE
while `npm run typecheck` is green, because vite/client's asset declarations
reach the renderer through the web config's `types` and through nothing else.
The `/// <reference types="vite/client" />` in `global.d.ts` cannot help — under
the root config that file is not in the program at all.

**`coerceSettings` whitelists every field by name.** It runs on read *and* on
write, and it does not spread. A field added to `Settings` but not to that
function is silently dropped on save — it appears to work until the next
reload. It lives in `services/settings_coerce.ts`, split out of
`settings-store.ts` for the same reason `recent_documents.ts` was: that module
imports Electron, which puts it out of reach of the tests. `tests/services.ts`
now round-trips a fully-populated `Settings` annotated `satisfies Settings`, so
adding a required field breaks the *compile* until the test names it and then
breaks the *assertion* until `coerceSettings` does.

The one deliberate exception is `preview`, which **is** spread over the
defaults: a new `PreviewSettings` field survives with no change, at the cost of
no validation. That trade is right for numbers a slider wrote and wrong for
`ui`, which decides what the window looks like before anything is drawn.

**Three themes, two token sets, and some colours CSS cannot reach.** The dark
palette sits on bare `:root` — which is what made themes safe to add, because
every component written before them keeps reading the values it always did.
Light is layered over it twice, once for `[data-theme="light"]` and once for
`prefers-color-scheme: light`, and the media query excludes `[data-theme="dark"]`
so an explicit dark choice survives a light desktop. `"system"` *removes* the
attribute rather than setting a third value: there is no third palette, only a
different place to ask.

The trap is the viewport. The scene background, the grid and the selection box
are `THREE.Color`s, so they inherit nothing and a theme change leaves them
where they were — a light window with a black hole in it. `Viewer.svelte` reads
them back out of the same custom properties with `getComputedStyle`, which is
why `App.svelte` writes `data-theme` in an **`$effect.pre`**: pre-effects all
flush before regular ones, so the attribute is on `<html>` before the viewer
looks. As a plain `$effect` the two race and the viewport trails by one change.
`GridHelper` bakes its colours into a vertex attribute at construction, so it is
rebuilt rather than recoloured.

`BrowserWindow`'s `backgroundColor` in `main/index.ts` is outside all of this on
purpose — it is painted before there is a renderer to ask.

**The left mouse button pans, so anything else that drags must take it.** The
viewer maps `LEFT` to `THREE.MOUSE.PAN`. A selection-face drag therefore sets
`controls.enabled = false` for the duration, or the camera pans and the face
never moves. The same gesture also has to suppress the click-to-select path on
`pointerup`: a press that lands on a handle and does not move is still a press,
and the 4px tolerance does not help, so it would collapse the selection the
user was about to resize.

**Which is why selecting takes Shift, and a plain drag belongs to the camera.**
Every selection gesture has to take the button away from OrbitControls, so none
of them can be the default: orbiting a build was close to impossible, because
the press that started the orbit landed on it and collapsed the selection to the
block underneath. Shift-click a block, Shift-drag the grid, Shift-drag a face.
**Ctrl** took over "grow the selection from the anchor", the job Shift gave up.

Shift-dragging *across the structure* sweeps out a region, which is what anyone
tries first: before it, a Shift-press on the blocks could only ever produce the
one block under it, so picking out a wall meant clicking a corner and then
dragging a face. The reached cell is remembered rather than recomputed, because
a sweep leaves the structure constantly — the pointer passes over sky between
two towers — and a region that collapsed every time the ray missed would be
unusable. A sweep that never moved still falls through to the single-block pick,
so the click keeps its inspector and its Ctrl-extend.

Two things survive without Shift, and both for the same reason: an orbit moves
the pointer, so a gesture that only fires when it *did not* takes nothing from
the camera. A stationary click on the build grid places a block — that is how an
empty schematic gets its first one. A stationary click on a block asks what it
is, which is the inspector.

That second one is a rule that was already broken once. Selecting was made a
Shift gesture to keep the *drag* for the camera, and the click went along with
it — silently taking the block inspector, because asking what a block is had
never been anything but a click. So the rule lives in `clickIntent` in
`selection_drag.ts` rather than in a `pointerup` handler, where a rule cannot be
read: `tests/ui.ts` states it, and reverting to the Shift-only version fails
three checks by name.

Its asymmetry on a **miss** is deliberate. Shift-clicking past the structure
clears the selection; a plain click past it does nothing. Clearing is right when
the click meant something, and clicking past the build while framing a shot is
the most ordinary accident there is.

**Ctrl+Z reaches the selection, and `undoDepth` is what makes that answerable.**
The block edits live in main and the selection lives in the renderer;
interleaving two stacks needs a shared ordering, and that field — main's undo
stack depth — is it. The rule is one sentence: **a selection is undone only while
no block edit has landed on top of it.** `selection_history.ts` holds it. A drag
is one step rather than one per frame, which is why `Viewer.svelte` reports
gesture boundaries at all: only it knows where the press was.

**A wall-mounted block points *out* of the wall, and the sign of that is the
whole bug.** Wall torches, wall signs, wall banners, mob heads and coral wall
fans all landed on `facing=north` whatever the click — for a torch, a torch
bolted to nothing on the wrong side of its cell. They join `ladder` in
`WALL_MOUNTED`, where `facing` is **the face that was clicked** and nothing else.

The natural fix is "point it where the camera is looking" and it is exactly
backwards: placing one means *looking at* the wall, so it ends up pointing back
at you. Look east, click a block's west face, and the torch faces west. The two
disagree about every case, which is why `tests/blocks.ts` states it as the
difference between a torch and a staircase rather than as an absolute.

With no wall to go on — a floor, a ceiling, the build grid — the wall is taken
to be the one that was being looked at. That is not a second rule: it is the
same answer the side click gives, because clicking a block's west face means
looking east, and it differs only at a glancing angle, where the face actually
hit wins. There is no wall torch on a floor in the game — you get a standing
`torch` — but the inventory offers the wall variant by name, so there is no
standing block to fall back to and `facing=north` forever was the alternative.

**`_wall_hanging_sign` is deliberately not in the family**, and it is the one
that would be wrong: it hangs *between* two blocks on the axis across its
`facing`, not off the face it was clicked onto. It does not match `_wall_sign`
either — `oak_wall_hanging_sign` ends "hanging_sign" — and that is checked by
name, because a suffix list is exactly where it would be assumed instead.

Two halves of this were separately true while every torch came out wrong:
`orientPlacement` says which way it faces, and the baker says a torch's foot is
planted in the wall opposite its `facing`. Nothing put them together, so
`tests/blocks.ts` now does — place one by clicking a face, and the foot has to
end up inside the block that was clicked.

**A placed block points where the game would point it.** Every block placed by
hand used to land in its default state, which for anything with a direction is a
lie the file then carries: every staircase `facing=north`, every log standing
up, every slab on the floor. `shared/block_orientation.ts` answers from the two
things the game asks — where the camera is looking, and which face was clicked —
and it is in `shared/` because it is a fact about Minecraft rather than about a
process: the renderer applies it at the click, which is the only place the look
direction exists, and main will want the same answer the day the agent places a
block the way a person does.

The orientation goes **under** whatever the held block already spelled out, not
over it: `oak_stairs[facing=north]` typed into the block field is an
instruction, and this is only a default.

A block the file does not name keeps its default state, which is exactly what
happened before — so an omission costs nothing, while a wrong guess writes a
state that is *worse* than the default because it looks deliberate. `observer`
and `anvil` are left out for that reason rather than overlooked.

Two things `tests/blocks.ts` holds that are easy to lose. Every exact id the
table names is checked against `block_id_list.txt` — a typo writes a state onto
a block that does not exist, which nothing in the app would ever notice. And the
properties are **baked**, because a `facing` the mesher ignored would pass every
arithmetic check ever written and still place the same staircase four times.

**The rest of the state is generated, and being hand-written was the fault.**
`DEFAULT_STATE` was twenty-one families against the two hundred-odd blocks that
carry properties at all, so everything else was placed bare — one cause with two
symptoms: an empty inspector, and, for anything `block_shapes.ts` reads a
property to draw, the wrong shape. A fence had no `north`, so it drew as a bare
post, and the panel that exists to fix that had nothing in it.

```
resources/block_states.json     the data, with provenance   ← .claude/skills/mc-blockstates
scripts/gen-block-states.mjs    JSON → the table
src/shared/block_states.ts      the table, plus the lookups
```

`mc_versions.json`'s arrangement for its reason. 1197 blocks come out as 121
distinct shapes — every fence in the game has the same five properties — which
is both a third of the size and the only form a person can read.

**It is a union of two releases, and the union is not tidiness.** `misode/
mcmeta`'s `summary` branch tracks snapshots, so the vendored copy is pinned to
releases — 26.2, unioned with 1.21.8. `chain` became `iron_chain` in **1.21.9**
and is the only block the older snapshot has that the newer one does not; this
app writes schematics for 1.8 onward and a file cut before that release still
names it, so both spellings have to be offerable.

A rename is the one thing a union cannot paper over, because the **texture moves
too**: `block/chain` is simply absent from a modern pack, so `model_baker.ts`
carries `chain` → `iron_chain` as an alias. Any future rename needs both halves.

The four ids outside the registry are `grass`, `grass_path`, `sign` and
`wall_sign` — pre-Flattening spellings the app still offers on purpose. The
generator reports them and the suite **names** them rather than counting,
because "one more appeared" is exactly what a rename looks like from here.

**`waterlogged` is excluded from the defaults and kept in the legal values**,
which are two different questions. `legacy_blocks.json` maps `85:0` to
`oak_fence[east=false,south=false,north=false,west=false]` — four connections,
no `waterlogged` — and the MCEdit writer matches the *exact* state, so writing
the connections improves the legacy match while writing `waterlogged` breaks it
on every stair, slab and pane in the build. But the inspector should still offer
it and a file arriving with it keeps it: this decides what a *new* block is born
with, not what a block may hold.

`orientPlacement` stays hand-written and must. It asks where the camera was, and
no dataset knows that.

**A block named by a model is born in the same state as one placed by a click.**
`placementState` has filled in a placed block's properties since that table
landed, and it ran in exactly one place — `App.svelte`, at the click. Every
other way a block gets written named the id and stopped, so an MCP client, the
in-app agent and a build script all interned `minecraft:campfire` with an empty
property bag: no `facing`, no `lit`, no `signal_fire`.

Nothing downstream notices, which is why it needed a check rather than a bug
report. The writers write what they are given, the mesher ignores what it does
not recognise, and the game fills in whatever the file left out — so the picture
is right, the file is loadable, and the fault surfaces two steps away, as an
inspector with nothing in it on a block with four properties.

`toPlacedEntry` in `agent/tools.ts` is the fix and there are **two** functions
where there was one, because half the callers are not placing anything.
`replace_blocks` reads `from` as a **pattern**: `Recorder.replace` interns it and
matches on the palette index, so a default written onto that side turns "take
out the campfires" into "take out the ones that happen to face north and be
alight" — which finds a fraction of them and reports a healthy `changed` for
those. That is the failure the tool's own zero-result note already warns about,
arriving as the fix for a different bug. So `set_block`, `fill_region`,
`replace_blocks`' **`to`** and `run_build_script` place; `from` parses.

There is no orientation half here and there must not be: `orientPlacement` asks
where the camera was looking, and a tool call has no camera.

Writing more properties changes what the MCEdit writer can match exactly, and so
what it reports as `degraded`. That is already why `waterlogged` is excluded
from the defaults, so this inherits that policy rather than opening a second one.

**And the agent can now ask what a block's states are, which is what stops it
guessing.** `describe_block` is in `TOOL_SPECS`, so the in-app agent gets it
too — it had the identical problem — and MCP gets it through `describeTools()`
with no new table, which is the only placement that satisfies `tests/mcp.ts`'s
both-sides rule unchanged. It is the one tool here that is not a question about
the open document.

Its answer carries `placedAs`, which is the question underneath the question:
"what properties does a campfire have" is asked in order to find out what will
actually be written, and that is one string. It is built **by `toPlacedEntry`**
rather than describing what it does, so it cannot drift — and `tests/mcp.ts`
composes the two, placing a block and requiring the cell to equal what the tool
said. Both halves were separately true while every campfire came out bare.

A property that is legal and is not part of a birth state reports `default:
null` rather than the value it would otherwise take, or the answer would
contradict its own `placedAs`. A bad id is reported per block rather than
thrown, so one typo in a batch of sixteen does not cost the other fifteen.

**And the state the *neighbours* decide is `shared/block_connections.ts`.**
Stairs' `shape` used to be listed here as deliberately absent — "a corner is
decided by the neighbours, which is a question about the document and not about
the click" — and that was right about where it belongs, not about whether it
gets an answer. Fences, walls, panes and bars, a gate's `in_wall`, stairs
corners, rail shapes, double chests, redstone wire, chorus plant, vine, mushroom
blocks and `snowy` all now get one.

The rules are pure and know nothing about documents; `main/domain/connect.ts` is
the other half — which cells to ask. Four things about it are load-bearing:

- **It runs from `runTransaction`, once.** Place, break, fill, replace, paste,
  move, transform, every agent tool and every build script therefore agree. A
  rule enforced by discipline at nine call sites is wrong at one of them, and it
  would be wrong at whichever was added next. Undo does not go through it — undo
  replays deltas — and loading is not a transaction, so a file that arrives with
  its own connections keeps exactly those.
- **Every write is guarded by `hasProperty`.** A rule that sets `north` on
  something with no `north` produces a state the game refuses, and *nothing in
  this app would notice*: the inspector shows whatever the entry has, the
  writers write it, the mesher ignores what it does not know.
- **The block entity has to be put back by hand.** `setBlock` treats any write
  as *displacing* what was there and drops the record with it — right when a
  chest becomes stone, catastrophic when only a property changed. Deriving
  `type=left` on a double chest emptied it.
- **The palette cache grows during the pass.** Writing a correction interns a
  new entry, so a cell already fixed carries an index past the end of the array
  the pass was built with, and reading that as "no entry" makes the corrected
  neighbour look like **air**. The symptom is a connection that works one way
  only: placing a fence connected the new block and did not reach back.

Asking the palette instead of the cell is what makes it affordable —
`occludesNeighbours` calls `shapeFor`, which normalises a name with a regex and
walks three tables, and it cannot differ between two cells holding the same
entry. A 100-block fence line is **3 ms**. There is deliberately no size cap: a
threshold would be a second answer to the same question, which is the fault this
pass exists to remove.

**`EditRequest.setState` is the one caller that derives nothing, and without it
the feature would not exist.** The inspector sends its block-state edit down the
same channel as a placement, so a hand-typed `north=false` would be re-derived
and overwritten *inside the same transaction that carried it*. With it, a typed
state stands until something is placed beside it — which is what the game does,
and what "editable afterwards" has to mean.

**The inspector lists what a block *may* hold, not only what it happens to.**
It listed the entry's own keys, which is right for a block that came out of a
file and useless for one that arrived bare — so the panel that exists to let you
point a campfire somewhere said "This block has no block states" about a block
with four. The properties were never missing from the game; they were missing
from the entry, and this is where somebody would have gone to fix that.

`propertyRows` in `renderer/lib/inspector_rows.ts` is the rule, and it is the
**union** of what the entry carries and what the registry says the block may
hold. Both halves are load-bearing. The registry alone would drop a property the
*file* carries that the block does not legally have — another tool wrote it, or
the block was renamed under it — which is exactly the state somebody opens this
panel to delete. The entry alone is what was wrong. A block the registry does
not know contributes nothing, so an unknown block behaves precisely as it did
before; an omission costs nothing.

It is a plain module for `selection_drag.ts`'s reason: a rule written inside a
`$derived.by` can only be grepped for, and this one has edge cases worth stating.

**Empty means remove, and one place decides it.** There is no separate delete
verb — clearing the field takes the property off, and the button beside a set
row is a shortcut for clearing it. Two ways of saying "gone" is how they come to
disagree, so `changeBlockProperty` in `App.svelte` holds the rule and the markup
only calls it. Before this, clearing the box wrote `name: ""` — a property with
an empty value, which is a state no block has and which the writers would have
put into the file verbatim.

Removing is a real thing to want rather than the inverse of adding: a partial
state is legal in a schematic — the game fills the rest in from its own defaults
— and it is how the MCEdit writer's exact-state match is kept clean, which is
the same reasoning that keeps `waterlogged` out of what a placed block is born
with. Removing something that was not there costs nothing, because
`runTransaction` pushes no undo step for a recorder with no commands.

One consequence worth knowing before it is reported as a bug: the pass
**normalises**, so a lone staircase carrying `shape=inner_left` becomes
`straight` on the next edit near it. That is faithful — a schematic's stored
shape is advisory and the game recomputes it on every neighbour update — and it
is why `tests/session.ts`'s mirror fixture builds a real corner instead of one
staircase with a shape typed onto it.

`_stem` is not a suffix in the pillar table and must not become one:
`crimson_stem` is a pillar and `melon_stem` is a crop with an `age`.

**The hotbar's active slot is what you are holding, in both camera modes.**
There used to be two answers — an `activeBlock` for orbit, the hotbar for flight
— chosen between by camera mode. That was tenable only while the hotbar was
creative-only. Everything that picks a block writes the slot: the inventory, the
field in the selection tools, the middle mouse button. The wheel is still only
the bar's *in flight*: in orbit it is the zoom, and the game gets to claim the
wheel only because the game has no zoom to lose.

**Air is not a block you can hold.** It is a real id everywhere else — every
empty cell in the document is air, and the writers and the agent both name it —
but there is nothing to pick up and nothing to draw, so it was a permanently
blank inventory tile that read as a failure to load. `inventoryBlocks` filters
it and `coerceUi` refuses it in a slot, which heals a settings file written when
it was the ninth default.

**Closing a modal over the viewport must release the pointer lock.** In flight
the canvas holds it, so a panel opened on top of one appeared over a camera
still turning with every movement, with no cursor to click anything. Releasing
also stops the flight keys, because the viewer only records WASD while the lock
is held.

**The chat's markdown goes `sanitize(parse(source))`, in that order, and only
for `agent` turns.** `Markdown.svelte` is the only `{@html}` in the app, and
everything reaching it comes through `toSafeHtml`. The policy — allowlisted tags
and attributes, `http`/`https` links only, images rewritten to links because
`img-src` would block them anyway — lives in `markdown_policy.ts`, apart from the
machinery, because with a library instead of a hand-written parser the
*configuration* is the whole defence. `user`, `error` and `note` turns stay
literal: an error is main's own wording, and echoing someone's typing back with
the asterisks eaten is a small betrayal in an app where people type
`minecraft:oak_log` all day.

Three specifics, each of which cost something to learn:

- **Do not set `ALLOWED_URI_REGEXP`.** DOMPurify tests it against *every*
  attribute value, not just the ones holding a URL, so `/^https?:\/\//` quietly
  deleted `align="right"` from every GFM table cell. Its default expression
  already refuses `javascript:` while letting scheme-less values through. The
  http/https rule is enforced instead by `hardenLink` from
  `afterSanitizeAttributes`, and that is sufficient because `href` is the only
  URI-bearing attribute in `ALLOWED_ATTR`.
- **`style` must stay out of `ALLOWED_ATTR`.** The CSP is
  `style-src 'self' 'unsafe-inline'`, so unlike a script an injected inline
  style really does apply, and can cover the window.
- **`addHook` appends.** Registering the link hook per message stacks a fresh
  copy every turn, so `markdown.ts` keeps a `WeakSet` of purifiers it has
  already hooked.

`tests/ui.ts` runs the real DOMPurify against `tests/markdown_cases.ts` through
**jsdom, a devDependency** — checking the config object would only prove the
allowlist is the one that was intended, not that it holds. The `mailto:`/`tel:`
cases are load-bearing: DOMPurify's own default permits both, so without them
`hardenLink` could be deleted and nothing would fail.

**The block picker's list is one of those, and was not.** It was
`position: absolute` against the field, inside a `ToolWindow` whose `.body` is
`overflow-y: auto` and whose frame is `overflow: hidden` — so a list of blocks
was cut off by a panel a few rows tall, *and* its own margin box drove that
scroller's overflow. What it could reach, it could also resize. `fixed` removes
both at once: nothing clips it, and nothing it can grow into.

`placePopover` grew a `prefer` argument for it, defaulting to the old
behaviour so the two existing callers are untouched. Above is right for a
control at the foot of a panel; for a field you are **typing into** it is not,
and the arithmetic made it worse than a fixed choice — `above >= margin` is
true or false depending on where the panel happens to be, so the same field
opened upwards or downwards according to where you had dragged its window.
Below still falls back to above when it does not fit, and the clamp is still
the only part that is a guarantee.

**A popover is positioned against the window, not against its control.**
Everything from `.controls` down is `overflow: hidden`, and the controls that
open popovers sit at the trailing edge of a right-hand panel — so a popover laid
out from its trigger is either cut off by an ancestor or off the screen
entirely. The model picker's was the latter: 340px growing rightwards from a
control ~60px from the right edge of the window. They are therefore
`position: fixed` with `left`/`top` from `placePopover` in `floating.ts`, which
prefers a readable side and then *clamps* — the preference is the design, the
clamp is the guarantee, and only the clamp is load-bearing.

`fixed` escapes the clipping because no ancestor here has a `transform`,
`filter`, `perspective`, `contain` or `will-change`; any one of those on a
wrapper makes it the containing block again and the popover starts being
clipped. The popover also stays a DOM child of the picker, so dismiss-on-
outside-click remains a plain `contains()` test rather than needing a portal.

**Renderer logic that runs from the rendering steps cannot be verified in the
browser harness here.** `requestAnimationFrame` callbacks and `ResizeObserver`
deliveries both belong to those steps, and the Browser pane is often not
compositing — measurably: zero frames, and an observer that does not even fire
its initial call. Code driven that way (the hover raycast, the tool window's
pull-back on resize) will look broken when it is fine. The response is to keep
the *decision* in a plain module — `selection_drag.ts`, `floating.ts` — and test
that; only the trigger stays unobservable. `tests/ui.ts` is where those live.

**Every renderer string comes from `t()`; main's do not.** The catalogue is
`renderer/src/lib/locales/en.ts`, flat dotted keys, and a key with no entry
renders as *the key itself* — visible and greppable, where a blank would look
like a styling bug and ship. `tests/ui.ts` walks the source for `t(…)`/`tn(…)`
call sites and fails on a key the catalogue lacks **and** on a message nobody
asks for, because a catalogue rots from both ends.

Main-process wording — every `Failure.message` — is **not** translated. It
arrives already phrased and is shown as it came; translating it would mean
replacing those messages with error codes, which is a different job.

Two traps, both already paid for:

- `i18n.svelte.ts` holds the locale in a `$state` and so **must** keep that
  extension, exactly like `bridge.svelte.ts`. The lookup lives in the plain
  `i18n_core.ts` so it can be tested at all.
- **`setLocale` assigns unconditionally.** An `if (locale !== next)` guard looks
  free and is not: it *reads* `locale`, and `App.svelte` calls `setLocale` from
  an `$effect.pre`, so the read made that effect depend on the variable it
  sets — every change put the old value straight back and choosing a language
  did nothing. Svelte already skips an assignment of the same primitive, so the
  guard was never buying anything either.

**Do not adopt `@opencode-ai/sdk`.** It looks like the obvious dependency for
the OpenCode provider and is not: it is a client for a *local opencode agent
server*, spawns the opencode CLI, and has no path to a chat completion against
OpenCode Zen. The client OpenCode's own registry designates for Zen is
`@ai-sdk/openai-compatible`, which is what `services/llm.ts` uses.

Related, and worth stating because the product plan assumed otherwise: **in this
app "OpenCode" is a model gateway, not an agent framework.** It is one of four
providers, alongside OpenAI. The agent loop is built on the `ai` package, which
is why it works on all four rather than on that one.

**All four providers share one client.** `services/llm.ts` used to have a second
transport — a hand-rolled `fetch` against `/chat/completions` for OpenAI, Gemini
and Custom — which was perfectly reasonable until the app needed tool calling,
which it cannot do. Do not reintroduce it. `resolveModel` is exported so the
agent reaches the same endpoint with the same key resolved the same way; two
places deciding what a provider means is how you get something that works in
generation and not in chat.

**OpenCode's API key is required per model, not per provider.** Some of its
models are free; the rest bill per token, and the proportion moves -- the
vendored snapshot was 9 of 61 when this was written and is 26 of 87 now, which
is why neither number belongs in a sentence anybody reads as a fact about the
app. `openCodeModelRequiresKey` in
`shared/ipc.ts` is the rule, `ipc/handlers.ts` is where it is enforced, and the
renderer only mirrors it. Missing metadata fails *open* — a models.dev outage
must not make free models unusable.

**There are two eras, and the boundary is the Flattening.** `shared/mc_versions.ts`
is the rule: ≤1.12.2 is `legacy` — numeric `ID:DATA`, **MCEdit only** — and 1.13
onward is `flat` and can be Sponge. Sponge's palette is flattened
`namespace:id[state]` strings, which did not exist before 1.13, so offering it
for 1.12.2 writes a file whose palette names blocks that version never had: it
saves without complaint and cannot be read. The rule sits in `shared/` because
the format picker, the writers and the inventory all need the same answer and
only one of them is main — same reason as `openCodeModelRequiresKey`. The
dialogs mirror it; `ipc/handlers.ts` enforces it.

`SaveRequest` carries the version **by name**, not as a `DataVersion`, precisely
so it can be enforced: `null` is both "no tag" and "pre-Flattening" and only one
of those refuses Sponge. And `services/versions.ts`'s table filters on the
**era**, not on "has a number" — 1.12.2 has DataVersion 1343, and generation
stamping that onto a Sponge file would claim pre-Flattening for a flattened
palette. Only 1.8.x has no number at all; the tag began in snapshot 15w32a.

**The version numbers are looked up, not remembered.** `resources/mc_versions.json`
holds them with provenance, `scripts/gen-mc-versions.mjs` writes the rows between
two markers in `shared/mc_versions.ts`, and `.claude/skills/mc-versions` is how
they are refreshed. Two independent sources that agree or the number does not
ship — and minecraft.wiki plus its Fandom mirror is *one* source. A wrong
DataVersion produces a file that opens fine and misbehaves in game, which is
discovered a long way from here.

**`showSaveDialog` exists now, and the format is chosen before it opens.**
`.schem` is both Sponge v2 and v3 and Electron reports the chosen path but not
which filter produced it, so the container cannot be recovered from the file
name. `pickFile`'s `save-schematic` kind also forces the extension rather than
trusting the dialog to append one — that happens on some platforms and only when
the user typed none.

**The build grid is what an empty schematic can be started from.** With zero
blocks there is nothing to raycast, so no gesture had a target at all. The
arithmetic is `renderer/src/lib/build_grid.ts` — `floor` not `round`, a graze
near the horizon refused rather than answered, and below the origin *blocked*
rather than grown, because growing that way moves the content instead. Dragging
on it must take the left button for the same reason a selection-face drag does.

**The grid is centred on the schematic, and the camera starts in its middle.**
Both used to answer "the world origin", and a schematic's origin is a *corner*
of the work rather than its middle: there are no negative block coordinates, so
three of the grid's four quadrants covered space no block can ever occupy, and
orbiting turned around the corner of a build instead of around the build.

`renderer/lib/framing.ts` holds both answers, a plain module for
`build_grid.ts`'s reason. `gridCentre` **snaps to the helper's own cell**, and
that is the part that would be left out: a `GridHelper` draws its lines one cell
apart *from its own centre*, so a centre at 10 puts them at 10, 18, 26 — off
every block boundary, while the build-grid patch under the cursor is still drawn
on integer cells. The two would then disagree everywhere by a constant, which
reads as a rendering fault rather than as a centring one. Half a cell of
centring is the whole price.

`documentFraming` measures the document's **box** rather than the geometry in
it, which is the other half of the same fix. `Box3.setFromObject` of an empty
document is an empty box, so the old framing returned without moving anything
and left the camera wherever it was mounted — pointed at no part of a work
surface that has nothing else on it to navigate by. It is also why R no longer
needs a `loaded` before it will frame.

**And the framing moved out of the mesh effect into one of its own**, which is
what makes an empty document reachable at all. Inside, it had to read
`framingKey` untracked: that effect rebuilds geometry, and a key change would
have rebuilt the *outgoing* structure before the new document's mesh arrived. An
effect that only moves a camera has no geometry to get wrong, so depending on
the key there is not merely safe — it is the point, because framing then
happens when a document is *opened* rather than when its first mesh lands, and
an empty schematic has no first mesh. `documentSize` is read untracked for the
mirror reason: it moves on every resize, and a resize is not a different
schematic. The key is recorded only when a frame actually happened, so the mount
run consumes nothing.

The grid still extends past the box in every direction, and is deliberately
**not** clipped to the positive quadrant: `MAX_GRID_REACH` lets it hang over on
purpose, and hanging over is how a build grows outwards.

`tests/ui.ts` states the arithmetic and then greps `Viewer.svelte`, because the
call sites run from the rendering steps. The grep has to name the *effect* and
not only the call — checking for `gridCentre(` alone passes with the answer
computed and thrown away, which was verified by doing exactly that.

**The viewport has two cameras and draws with one of them.** `preview.projection`
picks between them: perspective, and the 2.5D orthographic view where parallel
lines stay parallel and a block at the far side of a build is drawn exactly as
large as one at the near side. Both are built at mount and kept, because the
perspective one is also the *flight* camera {EM} `PointerLockControls` binds to
whatever it was constructed with, and rebuilding under it would leave it
steering a camera nothing draws with.

Everything else in `Viewer.svelte` goes on saying `camera`, which is most of why
this is cheap: the position, the quaternion, the clipping planes,
`getWorldDirection` and `Raycaster.setFromCamera` are common to the two. Only
`applyProjection` and the construction have to know which is which.

**Flight always wins, and that rule is not the greyed checkbox restated.** An
orthographic projection has no point of view {EM} every ray through it is
parallel {EM} so there is nothing for the flight controller to move and nothing
a step forward would make larger. The checkbox is disabled in flight so it is
never a live control doing nothing, which is the Stop button's rule; the
*setting* is on disk and outlives the mode, so a window that opens with
`orthographic` stored and goes straight into flight has to come out right with
nobody having touched the checkbox at all.

**One field of view, used twice.** `ORBIT_FOV` in `framing.ts` builds the
perspective camera and `orthoFrustumHeight` derives the orthographic frustum
from it, matched **at the distance to `controls.target`**. An orthographic
frustum does not widen with depth, so "the same view" is only well defined at
one distance, and the one worth matching is the thing being looked at {EM} get
it wrong and the toggle reads as a zoom rather than as a projection. A literal
`60` left at either call site is that bug, so `tests/ui.ts` greps for both.

It stays right across a window resize because OrbitControls dollies an
orthographic camera by writing `camera.zoom` and never moves it: the distance
`applyProjection` reads does not change while zooming, so recomputing from it
cannot undo the zoom. What it does *not* survive is the target moving, which is
why leaving flight calls `resize()` after it puts the target back.

`projection` is the one field in `PreviewSettings` that is not a number or a
boolean, and it still needs no validation {EM} which is worth stating, because
`ui.theme` does. `coerceSettings` spreads `preview` over the defaults without
checking anything, and this read is **total**: anything that is not exactly
`"orthographic"` is drawn with perspective. A junk value is therefore
indistinguishable from an absent one, and that property is the whole of what
makes the spread safe for it.

**And the epsilons stay gone.** Orthographic depth is linear, so precision is
uniform and the coplanar problem is *easier* than under perspective {EM} which
is exactly the argument for putting a hand-picked constant back. It would be
safe there and wrong again one checkbox later. `orthoDepthEpsilon` exists in
`depth.ts` to be checked against `depthEpsilon` at the grid's far corner rather
than to be called; `COPLANAR_OFFSET` is denominated in depth-buffer steps and
so covers both projections unchanged.

**There is one table for which way north is, and there used to be two.**
`shared/block_orientation.ts` states the convention in prose — north is -Z,
south +Z, east +X, west -X — and now states it as `FACE_VECTOR` as well;
`main/domain/connect.ts` had kept the same six numbers as its neighbour offsets
and now reads them from there. It is one fact about Minecraft, and two copies of
it is how one of them comes to be a quarter turn out. `horizontalFacing` is the
inverse for the four horizontal ones, so `tests/blocks.ts` requires the pair to
round-trip, which is what catches the only mistake a table of six unit vectors
ever makes: a transposed sign.

**The compass is drawn in a third pass over the same renderer, and clicked
through an element on top of it.** Both halves are the design.

A pass rather than a second `WebGLRenderer`, because a browser gives a page on
the order of sixteen live contexts before it silently drops the oldest —
already the reason `block_icons.svelte.ts` shares one, and spending a context on
an ornament would be the worst possible use of it. The depth buffer is cleared
first so the build cannot occlude an overlay that is not in the world, and the
scissor is what stops the pass clearing or drawing into the rest of the frame.

An element rather than a branch in the canvas's pointer handling, because the
left button in that canvas is `THREE.MOUSE.PAN`: *every* gesture there has to be
written as something that takes the button away from OrbitControls first, and an
element on top never enters that argument. It is transparent, because what is
inside it is drawn by WebGL in the same pixels.

`compass.ts` holds the arithmetic, a plain module for `build_grid.ts`'s reason.
Three things in it are load-bearing and none of them are visible in a
screenshot:

- **The gizmo group takes the *inverse* of the camera's rotation**, and so does
  `projectAxis`. Same quaternion, same inversion, which is what keeps the hit
  test on the handle that is drawn. With the identity rotation the two agree
  either way, so this is checked with the camera turned.
- **Nearest the viewer wins a tie, not nearest the pointer.** The two ends of an
  axis project to the very same point when that axis faces the camera —
  looking north, both the north and the south handle land dead centre — and
  the one drawn on top is the one pointing back out of the screen, which there
  is *south*. Picking by distance is a coin toss between two exact ties, so half
  the time a click flies the camera to the opposite side of the build from the
  handle it was over. That "looking north, south faces you" is also the sentence
  that is easiest to write down backwards, and a compass with its near and far
  ends swapped still looks exactly like a compass.
- **The poles lean off vertical by a thousandth of the orbit distance.**
  OrbitControls takes its azimuth from `atan2` of the horizontal offset, which
  straight overhead is `atan2(0, 0)`: zero by definition rather than by intent,
  so the view would swing to whatever azimuth zero happens to be. Leaning
  towards +Z makes it deterministic *and* the one a map has, with north at the
  top.

**A flight goes around the build rather than through it.** A straight line
between two points on a sphere is a chord, so a lerped quarter turn passes a
third of the way inside the structure and out again; `arcBetween` interpolates
the direction and the radius apart. Its antipodal case is not exotic — it is
clicking north and then south — and two opposite directions span no plane, so
there is no arc and the arithmetic has to choose one rather than divide by a
sine of zero.

While a flight is running it outranks both controllers, and `controls.update()`
is still called under it: OrbitControls derives its spherical state from wherever
the camera actually is on every call, so writing the position underneath it is
safe, and skipping the update would let the damping snap on the frame the flight
ends.

The gizmo is drawn in **both** camera modes and clickable only in orbit. In
flight it is a heading indicator, which is when knowing which way is north is
hardest; it is not a control there because the pointer is locked, and
`pointer-events` says so rather than the handler declining in silence.

Its colours are `--axis-x/y/z`, defined in all three palettes. X red, Y green, Z
blue is the convention every 3D package shares and so is read without being
told; the *labels* are Minecraft's, which is the half that has to be learned —
a builder thinks in north and east, and `facing=north` is what the file says.

**The document has a size, and three different things decide it.** They live in
one panel because they are one question and they are emphatically not one
mechanism:

- **the cage** (`preview.showBounds`) is the viewer's alone — not a block,
  never in the atlas, never raycast;
- **automatic resizing** (`editing.autoGrow`) changes what an *edit* is allowed
  to do, and is honoured in main;
- **the size itself** is an edit, on the undo stack like any other.

**`Settings.editing` is a third bag, and it is not `preview` or `ui`.** Those
two are about drawing and about window chrome; this decides what ends up in the
file. `coerceSettings` spreads `preview` over the defaults without checking
anything, which is the right trade for numbers a slider wrote and the wrong one
for a rule about whether a fill may resize somebody's schematic — so
`coerceEditing` names its fields the way `coerceUi` does, and
`tests/services.ts`'s `satisfies Settings` round-trip breaks the *compile* until
a new field is named.

`autoGrow` reads **`!== false`**, not `=== true`. Growing on a fill outside the
box is what the editor did before there was a setting, so every settings file
written until now has no `editing` block at all; reading absence as `false`
would silently turn the behaviour off for everyone who never asked.

**With it off an edit outside the box is refused by name, never clipped.** Silent
clipping is the failure this file already records once: a fill asking for the
universe quietly became a full fill of whatever was open, reported a healthy
`changed`, and read as success. `OutsideDocumentError` is that sentence said out
loud. A **break** is exempt, because it never wanted to grow in the first place
— making room for air is a resize and nothing else — so with the setting
off a break outside the box goes on doing exactly what it always did.

**`resizeSession` grows at the far side and never with a shift**, which is
`resize_document`'s pair of restrictions for its reason: every coordinate
anybody has already been told stays valid. Room *below* the origin would move
all the content up instead, because the grid has no negative index.

Unlike the agent's tool it may **shrink**, because this is somebody typing a
size on purpose and the box is theirs to set. `tx.resize` records the blocks and
block entities it drops, so it comes back whole on Ctrl+Z. What it will not do
is take them by surprise: a shrink that would destroy blocks is **refused,
counted, and only goes through with `confirmLoss`**. That is
`discardUnsavedChanges`' shape and it is the only order that helps — a
warning shown after the blocks are gone is not a warning, and main must not
raise a dialog for a request that may not have come from a person at the
keyboard. Air is not counted: losing air is losing nothing, and a shrink into
empty space is the ordinary case this must not interrupt.

**The refusal is a `FailureKind`, not a sentence to match on.**
`"needs-confirmation"` sits beside `"cancelled"` for the same reason — the
request was understood and nothing went wrong — and it is what lets the panel
offer to go ahead. A renderer matching on the wording is how a reworded refusal
silently becomes a dead end with nothing failing. Only that kind is offered a
second attempt: a size out of range or a volume past the cap is not a decision
the user can make differently, so offering to force it would be a lie.

The per-axis `DOCUMENT_SIZE` guard is partly redundant —
`domain/document.ts` already refuses anything under 1x1x1 — and what it buys
is the **wording**, which names the ceiling the layer underneath knows nothing
about. So `tests/session.ts` checks the message rather than only the refusal,
and the maximum gets cases nothing downstream would catch: 8192x1x1 is well
inside `MAX_DOCUMENT_VOLUME` and would simply succeed.

**Breaking takes the box back in, one slab at a time.** This was written down
as a deliberate omission — "shrinking under the user would throw away the room
they made to build in" — and the omission was the bug. Placing a block past
the edge grew the schematic and breaking that same block left it grown, so one
gesture had two answers depending on which way round you did it. Reported as
"deleting a block does not resize the area, and setting one does", which is
exactly what it was.

**One slab per face, and that number is the whole design.** "Shrink to the
content" is the obvious rule and is the one the old note was right to fear: a
schematic 16 wide with a house between x=2 and x=12 is three slabs of room
somebody made on purpose, and one break at the far face would take all three.
One slab gives back exactly what the matching growth added — a click on an
edge block's outer face grows the box by one — so the gesture round-trips and
nothing else moves. A wall built outwards peels back one break at a time, in the
order it was built.

Room is untouchable rather than merely usually safe, and that is a second rule
rather than the same one: a face is named only when the broken cell **is** that
face, and a deliberately roomy box has nothing on its outer faces to break. At
the far side only, never the origin, for `resizeSession`'s reason — retreating
at the near side moves all the content down, and every coordinate anybody has
been given stops meaning what it meant. Behind `editing.autoGrow`, because it is
that setting seen from the other side: growing and never coming back in is half
a checkbox.

Emptiness is `applyEdit`'s own predicate, not the word `air`. With a void block
chosen a break writes *that*, so keyed on air the schematic would go on growing
underwater and never come back — which is the build the void block exists for.
The consequence to know before it is reported: water put down by hand on the
outer face is empty space by the same rule that makes it unpickable, and comes
off with the slab, in the same undo step as the break.

**And it lands through `TransactionOptions.after`, which exists for it alone.**
`tx.resize` calls `flush()`, and `deriveConnections` reads the recorder's *live*
set — so a peel written into the transaction body would not reorder the two,
it would **delete the derivation outright**: the fence beside the one you broke
would keep an arm pointing at nothing, with every other check green. A growth
has no such problem because it resizes first. Deriving before the shrink is also
the right answer rather than merely a possible one: outside the schematic reads
as air, and the slab about to come off is empty, so the two agree cell for cell.

The guard that reads `wrote > 0` is a correctness guard and is checked by name;
the `emptiness` half beside it is **not**, and saying so is the point. A
placement could take the same path harmlessly — the cell written is on every
face the peel would name, so it finds it occupied and declines — and what the
test buys is that an ordinary placement never scans a face for nothing.

Still deliberately absent: any shrink that is not this one. A fill of air over
the edge slab does not peel, because a fill reaching outside *grows* to cover
the selection, and one gesture cannot mean both. The agent's tools do not peel
either, for the reason they do not grow: `resize_document` is their one way to
change the size.

**And the shrink warning says which half of itself applies.** It read
"undoable, but you will be asked first", which is two claims where the second is
conditional: `resizeSession` counts non-air blocks and refuses only if there are
any, so shrinking into empty space simply happens and nobody is asked. Reported
as the message not being exact, alongside the observation that undo restores the
blocks and the size together — which it does, and which the wording buried
behind a "but".

**The cage is a separate object so the picker never sees it.** A transparent box
around the whole build, handed to the raycaster, swallows every click meant for
a block inside it — and the click still does *something*, so it reads as the
inspector picking the wrong block rather than as the cage being in the way.
`tests/ui.ts` requires every `intersectObject` call in the viewer to name
`loaded` and nothing else, which is what keeps the next decorative object out of
it by default. It is `BackSide` so the near faces are not in the way from
inside, which is where anyone building will be.

**Empty space can be made of something other than air, and that is three
mechanisms wearing one name.** `editing.voidBlock` is **written** when a block
is broken, **drawn** over every empty cell, and **ignored by the pointer**. An
underwater build needs all three: the file has to say water or the paste comes
back full of bubbles, the space has to be visible as space, and a click has to
reach the build inside it.

**The palette is swapped, not the grid.** `fillVoid` in `preview.ts` is
`hideMarkers` inverted: it rewrites the *air* entry into the chosen block, so
every empty cell becomes water without a voxel being touched. Index 0 is always
air, which is what makes it a one-entry edit; the voxels are shared with the
document and only the palette array is rebuilt.

**The bucket is chosen by palette entry, not by "was this cell air".** Two
populations end up holding the block — the cells drawn over air and the cells
a break actually wrote it into — and one rule covers both. The consequence is
worth knowing before it is reported: **with water as the void block,
hand-placed water is unpickable too.** That is the request rather than a side
effect; if water is what empty space is made of, a click passes through it the
way it passes through air.

**And the chunk cache diffs it, which is the fourth time that rule has earned
itself.** The palette swap is invisible to every grid `chunked_mesh.ts`
compares: the voxels do not move, no light changes, no sign is retyped, and
index 0 quietly stops meaning air. So choosing water re-meshed **nothing**.

The shape of the failure is the part worth recognising, because every layer
reported success. `documentMesh`'s own key contains the void block, so the mesh
*was* rebuilt -- over a chunk cache that found every chunk clean and carried
them all forward by reference. `shipMesh` then tested object identity on the
positions arrays, correctly found them identical, and sent a delta saying
nothing had changed. The viewport was told the truth about a lie.

On screen that is a setting that does nothing at all -- until some unrelated
edit dirties one chunk, and the new void appears in that chunk alone. Reported
exactly that way: *"the opacity only changes on one face if you add a block"*.

`voidDigest` is the answer and it is **derived from the two arguments the
mesher already receives** rather than taken as a third, so it cannot drift from
what was drawn: every index `fillVoid` marked, *and what that index now holds*.
Both halves are load-bearing. The indices alone miss a swap -- water and lava
are both written over index 0, so `{0}` either way -- and the entries alone
miss a cell a **break** filled with the void block for real, which is void by
the same rule and has an index of its own.

**Choosing and converting are two acts, so they are two controls.** The rewrite
was a checkbox carried along with the choice, read at the moment the block
changed. Ticking it *after* picking water therefore did nothing, and re-picking
water to make it fire hit `setSessionVoidBlock`'s own short-circuit -- you had
chosen what was already chosen. The one gesture anybody would try was the one
with no answer, and it failed in silence at both ends.

`replaceFrom` is what the split costs, and it has to be explicit. The choice
lands at the pick -- that is what makes the viewport show it -- so by the time
the button is pressed `session.voidBlock` is the **new** block and main working
it out for itself would convert water into water. The panel is the only thing
still holding the old value, so the panel names it.

**And it is not enough on its own, which took a second report to find.** The
setting and the cells can disagree, and from the setting the two states are
indistinguishable: a schematic whose empty space is *set* to barrier with its
cells still air -- reopened from its sidecar, or one Ctrl+Z after a conversion
-- looks exactly like one where the conversion already happened. Both say
barrier; only one has anything to do. Deciding from the setting disabled the
button in **both**, so the one gesture that would have fixed it was the one
with no answer. Reported as *«se l'aria di una schematic è già tutta barrier e
si seleziona barrier come empty space block, questo non ha alcun effetto»*,
with a workaround of picking a second block and coming back.

Two changes, and the pair is the fix rather than either alone:

- **air is always a source.** `voidSources` in `shared/settings.ts` puts it in
  unconditionally, because that is what empty means in a schematic whatever the
  setting says. `replaceFrom` is *added* to it rather than standing in for it —
  a conversion leaves its own block behind, so swapping barrier for
  structure_void has to find the barrier and air alone would not. The target is
  never a source: converting a block into itself can only change nothing.
- **whether there is anything to convert is observed, not inferred.** The panel
  asks whether the document actually holds any of the sources. That is the only
  thing that can separate the two states above, because one of them has air in
  it and the other does not.

The second of those has a half that is easy to leave out and makes the first
one inert: **`DocumentState.palette` deliberately does not contain air.** It is
the materials list and a schematic is mostly air, so asking it alone answers
"no air here" about every document ever opened — and the button, correctly
computing air as its source, would have gone on being dead for the identical
reason under a different name.

`blocksInDocument` recovers it rather than transporting it: `countBlocks`
counts every voxel whose palette index is not zero and index 0 is always air,
so the document holds air exactly when `blockCount` is short of the volume.
Two numbers `DocumentState` already carries, and exact.

`voidSources` is in `shared/` for `normaliseVoidBlock`'s reason and with a
sharper edge: main converts with it and the panel decides the button from it,
so two copies is how the button comes to be live over an edit that changes
nothing, or dead over one that would work. Deleting the air term fails seven
named checks across `tests/ui.ts` and `tests/session.ts`.

One consequence follows and is deliberate: **a press converts even when the
block picked is the one already chosen.** Choosing is not an edit and still
pushes nothing; pressing is a request, and it is answered by looking rather
than by consulting a flag.

**One culling pass, two layers.** `BakedFace.voidFill` marks the layer and
`chunked_mesh.ts` partitions before calling `buildMesh` twice. Meshing the two
*separately* is the obvious arrangement and is wrong: the water's face at a wall
and the wall's own face are the same plane, and only a pass that sees both
removes one of them. Two passes draw both and z-fight along every surface of the
build. `tests/chunks.ts` states it as a number — a stone block dropped into
the void must leave the void geometry byte for byte unchanged — with glass
beside it as the control, because a layer that culled against *everything* would
satisfy the first check and put a hole in the water behind every pane.

**Separate buffers rather than a third index range beside `opaqueIndices`, and
the reason arrives twice.** The opacity is a **material** property, so a
material of its own was required anyway; and a material of its own means an
*object* of its own in the viewer, which is what keeps it out of the raycaster.
`Mesh.raycast` tests a whole geometry and knows nothing about draw groups, so an
index range could never have bought that. Every raycast in `Viewer.svelte` names
`loaded`; `voidLoaded` is its sibling and is never handed to one.

`ChunkGeometry` carries a `layer` and `dropped` is a `ChunkRef[]`, because the
two layers of one chunk are different geometry under one number and they move in
opposite directions: breaking the last block in a chunk empties its solid layer
and fills its void one. Keyed on the number alone — in main's `sent` map or
in the renderer's `chunkMeshes` — one would stand in for the other, and the
build would develop holes on the *second* edit rather than the first.

**Light is flooded through the document without the void in it.** `lighting.ts`
floods from `occludesNeighbours`, so a void block that happens to be solid would
seal every empty cell and take the light out of the whole schematic — the
build goes black and the cause is a dropdown two panels away. The void is a way
of seeing the space; it does not decide how lit the space is. It casts no shadow
either, in both the full build and the delta, which `tests/ui.ts` **counts**
rather than finds: a check that merely finds the rule passes while one of the
two has lost it, and that fault would appear only in the chunk an edit touched.

**Breaking still never grows, and keeping that true took a parameter.** The
guard read `namespacedName === "minecraft:air"`, which was the whole of what a
break was until empty space could be water. Left alone it would have gone on
being true of the *word* while quietly ceasing to be true of *breaking*, and
nothing would have failed — a break comes from a pick, so the block exists
and the case never arises. Which is exactly why it is written down.
`EditOptions.voidBlock` is what `emptiness()` asks.

**The interior fast path is the whole cost of the feature, and it is measured.**
Without a void block the loop visits only the blocks somebody placed; with one,
every empty cell is a block too, and on an ordinary schematic that is most of the
volume. A void cell buried in void cells draws nothing, so six array reads
replace a bake and six neighbour queries. On a 128x32x128:

| | |
|---|---|
| cold mesh, no void block | 274 ms |
| cold mesh, water as the void | 676 ms |
| **one block placed, void on** | **22 ms** |
| the same three without the fast path | 279 / **3135** / 50 ms |

It is skipped for a void block with `extraFaces` — a fence draws its rails
however many fences surround it — and it does not apply on the grid boundary,
where out of bounds is open air and the outer shell genuinely is drawn. There is
no sign check in it and there must not be: a sign is a block entity on a sign
block, and no cell it skips holds one.

**Air is stored as the empty string, and an id that spells air is healed into
it.** Two spellings of one state is how they come to disagree: the other one
would have `fillVoid` intern air over air and hand the mesher a palette where
every index is void and none of them draws anything — the expensive way of
doing exactly what the default already does for free. `voidOpacity` never
reaches zero for the mirror reason: a void block drawn at nothing is a second,
silent way of turning the feature off with the block still going into the file.

**Block icons are meshed by the same pipeline as the viewport.**
`services/block_icons.ts` runs a 1×1×1 document through `buildDocumentPreview`,
so an icon cannot disagree with what appears when the block is placed. It has to
be main's job: `pipeline/block_shapes.ts` is what knows a stairs block is not a
cube, and the renderer may not import out of `main/`. The inventory keeps them
as `data:` URLs because the CSP allows `data:` and forbids `blob:`, and uses one
`WebGLRenderer` — a context per tile hits the browser's limit at about sixteen
and then silently loses the oldest.

**One renderer for the whole window, in `renderer/lib/block_icons.svelte.ts`.**
That limit is per window, not per component, so the hotbar and the inventory
cannot each keep their own — and they must not each draw their own picture
either: the bar was hashed colour swatches beside a grid of real blocks, two
answers to what gravel looks like. Three things that module gets right, each of
which was visibly wrong first:

- **`SRGBColorSpace` on the atlas**, which the viewport sets. Without it the
  identical pixels drew darker and flatter in the previews than in the scene
  they preview — the "everything looks switched off" report.
- **Face shading, not lighting.** Lambert left every face of a stairs block
  reading as one flat mass. The game does not light its inventory; it shades
  each face by which way it points, and the vanilla factors go into a
  vertex-colour attribute multiplied into an *unlit* material, so the texture's
  own colours survive exactly.
- **Requests are serialised, and the texture is uploaded with `initTexture`.**
  Overlapping requests each built their result from the icon map as they found
  it and then replaced the whole map, so a slower response erased a faster one's
  work.

**Every texture keeps its own resolution in the atlas, and one fixed tile size
was the fault.** `buildAtlas` resized everything to a single square — 32 in the
Python original, then 64 here — which is right exactly while every texture is
the same size. Ordinary block textures in the bundled pack are 64×64 and passed
through untouched; a **chest sheet is 256×256** and a sign sheet 128×128,
because a block-entity sheet carries a whole model's parts rather than one face.
Those were subsampled 4:1 and 2:1 on the way in.

What that costs is worse than "a bit soft", and worse than vanilla: nearest
subsampling of a 4× sheet keeps one pixel in sixteen of art drawn at 4×, so the
result is not the 16× texture the pack was made from but an arbitrary sample of
the 64× one. A chest's plank lines and the border round its lid landed or missed
by a pixel — chests came out both chunkier *and* patchier than the blocks beside
them, which is what "the texture is not sewn on properly" looks like.

Per-key UV rects are what made the fix cheap: the mesher looks each texture's
rect up by name and never assumed they were the same size, so only the packing
changed — shelves of descending size, ordered by size then by key, so the layout
is a function of the *set* and not of the order the baker decoded them in.
`tests/blocks.ts` feeds the same textures in reverse and requires the same
answer; building twice from one object proves nothing, because `Object.keys` and
`Array.sort` are both stable and would agree with a packer that had no ordering
rule at all.

The atlas goes from 20.8 MB to 27.6 MB over the whole 920-block set, and packs
in the same ~130 ms. It is sent only when its version moves — `MeshPayload`
carries `atlas: MeshAtlas | null` and the renderer hands back the version it
holds — so that is a cost per atlas, not per edit. `MAX_TILE` caps one texture
at 256: the ender dragon's sheet is 1024×1024, and a dragon head is one small
block.

**The atlas grows as blocks are meshed, and its version *is* the texture count.**
That is the fault behind "the icons are wrong until I scroll", and it was in
main, not the renderer: the baker decodes a texture the first time a block asks
for it, so meshing sixty blocks in a row produced sixty geometries each with UVs
into a *different* layout, and one atlas to draw them all with. Fifty-nine were
wrong. Scrolling looked like a cure only because by then everything had been
decoded and the count had stopped moving.

Two things follow, and both are load-bearing:

- **`buildBlockIcons` primes before it meshes** — the atlas has to stop moving
  before a single geometry is kept. `tests/services.ts` proves it by calling
  twice and requiring identical UVs; delete the priming pass and that check
  fails.

  **Priming decodes; it does not mesh.** It used to mesh every block and throw
  the geometry away, on the reasoning that a 1×1×1 document is a handful of
  triangles and the expensive half is the decoding. The triangles were indeed
  free. What was not free is that every one of those meshes asked for an atlas,
  and **packing the atlas is O(every texture decoded so far)** — so priming nine
  hundred blocks packed it nine hundred times over an ever-larger set. Measured
  on the real 920-block list with the bundled pack:

  | | |
  |---|---|
  | decode every texture | ~740 ms |
  | pack the atlas, once | ~150 ms |
  | mesh all 920 against a settled atlas | ~150 ms |
  | the same work in an order that let the atlas move | **~38,750 ms** |

  This is the failure mode worth recognising by shape: it is the *right
  picture*, slowly, so nothing about it reads as a defect. Concurrency is not
  the answer to it and would have hidden it — the repeated work is quadratic,
  and the baker's texture map is one mutable object that cannot be shared across
  threads anyway. `preview.ts`'s `warmBaker` is the correct order, and
  `atlasBuildCount()` exists so `tests/services.ts` can require **one** pack per
  warm-up. Not "not too many": there is no reason for a second.
- **`warmBlockIcons` meshes every block once**, because an atlas that grows
  invalidates every icon already drawn. It is not awaited before the first
  paint — nine hundred blocks is seconds, and blank tiles for all of them would
  trade one visible fault for a worse one — so icons are drawn immediately and
  redrawn once when it settles. `iconsReady()` is what makes that redraw happen
  by itself: the callers read it inside the effect that requests, so the
  re-request needs no scroll. Waiting for a scroll *was* the bug report.

**A schematic's version history is not the chat's checkpoints.** `snapshots.ts`
keys on the *file path* and lives under `userData/versions`, so it outlives the
conversation, the session and the app; `checkpoints.ts` belongs to a conversation
and dies with it. Both are uncropped Sponge v3 for the same two reasons as the
autosave: `saveSession` trims to content, and these files are read only by the
module that wrote them. A document with no path has nowhere to keep a history
and says so, rather than showing an empty list that looks broken.

Going back is a **fork**: `adoptDocument` starts a fresh history, so main
snapshots the state being left before adopting the old one. `snapshots_core.ts`
returns the ids evicted past the cap rather than deleting them, because a caller
that forgets leaves orphans and that is something a test can see.

**Barrier and structure void are drawn, and that is not a mistake.** They are
invisible to a *player* and placed on purpose — a barrier keeps people out of
somewhere, and a shell of them is a decision somebody has to be able to review.
Drawing nothing meant a build could be full of them and look empty. So the
default is deliberately *not* the game's own view, and `preview.showMarkers`
turns them back into air for anyone who wants it. `light` stays invisible: it
has no in-game appearance to reproduce and nothing structural to review.

Two things make drawing them safe, and both are load-bearing. They are in
`isSeeThrough`, so they never cull — a barrier that deleted the face of the wall
behind it would be worse than not drawing it, because the wall is real and the
barrier is not. And their texture is `item/barrier` / `item/structure_void`:
neither has a block texture, because neither is drawn in the world, and what the
game has is the icon it shows you in your hand.

**Hiding them is done to the *structure*, not to the baker.** A baker keyed on
the flag would be a second baker, a second texture set and a second atlas — and
the block icons, which always draw markers because you have to see what you are
picking, would be meshed against the wrong one. `hideMarkers` rewrites the
matching palette entries to air, which costs nothing and leaves exactly one
atlas in the process. Like the two tints it changes the mesh without changing a
block, so it is part of both preview cache keys.

`moving_piston` is drawn too, as a plate and a rod: it is rendered in vanilla —
it is what you see mid-push — so drawing nothing left a hole in any schematic
captured with a piston firing.

**A long loop in main must yield with `setImmediate`, not with `await`.**
`await` queues a microtask, and microtasks run *before* I/O, so a loop of
awaited work starves the event loop exactly as a synchronous one would. That is
what froze the window while the block warm-up ran: every IPC call sat behind it,
including the one opening the document that triggered it. `setImmediate` runs in
the check phase, after I/O, and is the yield that actually hands the process
back. It lives in `services/breathing.ts` — two loops need it, and a rule this
easy to get wrong, written twice, gets corrected once.

**The warm-up starts at handler registration, not when the renderer asks.**
That is the only concurrency a single-threaded main process has, and it is the
useful kind: it overlaps with creating the window, loading the renderer,
mounting it, and the IPC round-trips it makes before reaching
`blockIconsWarm` — which then joins the run in flight rather than starting one.
`breathe` is what makes that safe; without a yield that runs after I/O it would
starve the window creation it is supposed to overlap with. The price is that
the first progress events have nowhere to go, so the last one is re-sent when
the renderer finally subscribes; a bar that never moves would otherwise read as
a hang.

**Startup is a phase, with named steps.** The block warm-up is seconds, and
starting it lazily meant starting it the moment a schematic opened. It runs up
front now and the window is not usable until it is done, which is the honest
arrangement — it was already unusable for those seconds, it just did not say so.
A step that throws does not stop the rest: up with less beats not up, and
whatever failed will fail again where it is asked for, with a message about
what it was.

**Block geometry is hand-described in `pipeline/block_shapes.ts`, not loaded.**
The Python original only ever produced full cubes — its model-driven path was
dead code (DEV-008) — so stairs, fences and slabs all rendered as solid blocks.
Reading real models is not an option: Faithful is a texture pack and ships none,
and the vanilla models live in the client jar, which this app cannot
redistribute. Shapes are transcribed from vanilla in the same 0..16 units;
anything unlisted stays a cube. `.claude/skills/mc-block-models` is how one is
looked up, and it states the line that must not be crossed: **read and
transcribe, never vendor and never fetch at runtime.** Consequences worth
knowing:

- Only a full opaque cube may cull a neighbour's face (`occludesNeighbours`).
  Culling against a slab or a fence punches holes where nothing covers.
- **"Unlisted stays a cube" assumes a cube is the harmless answer, and for some
  blocks it is the harmful one.** Redstone wire, fire, a skull, a decorated pot
  and an end portal were all full opaque cubes, which is two faults rather than
  one: the wrong silhouette, *and* a face deleted from each of six neighbours. A
  line of redstone drawn as a cube deletes the floor it is lying on. Those get
  approximations, and a close box beats a cube there. `tests/blocks.ts` states
  it both ways — the ones that are cubes must stay cubes, or a wall of them
  stops hiding its own interior.
- **A face with no area is not drawn**, decided from the box rather than from a
  hand-written `omit`. Vanilla writes a *plane* as an element whose `from` and
  `to` agree on one axis — a chain is two of them, and so is a cross — and the
  other four faces then collapse to a line, which is eight degenerate triangles
  z-fighting along the edge they share with the two real ones. An `omit` list
  would restate what the coordinates already say, and the first plane added
  without one would read as a rendering bug rather than a missing entry.
- Shaped blocks have no texture of their own. There is no `oak_stairs.png` —
  `materialCandidates` strips the shape suffix and tries the base material.
- UVs are derived from box coordinates, which is right for anything cut from a
  full-block texture and wrong for blocks whose texture is a *sheet* of parts
  (lantern, chain, bell). Those carry an explicit `uv` window per face,
  transcribed from the vanilla model.
- **An animated texture is its frames stacked vertically in one PNG**
  (`lantern.png` is 3 frames tall). `firstAnimationFrame` crops to frame 0 on
  load — without it the atlas squashes the strip into a square tile and every
  UV window on that texture addresses the wrong pixels. Detected by shape, not
  by reading the `.mcmeta`.
- **Chests have no block model at all**, and are drawn from
  `textures/entity/…` with a `ModelPart` cube unwrap; `unwrapCube` in
  `block_shapes.ts` reproduces that layout. Banners and shulker boxes stay on
  a dyed-wool stand-in — their sheets need layer composition this code does not
  do.
- **`unwrapCube` needs the sheet's width, and it used to assume 64.** Its
  windows are stated in the *sheet's* texels while `UvWindow` is in sixteenths
  of the tile, so the two only agree once the size is known. Right for every
  sheet it had been used on and wrong the moment a 32-wide one arrived: a sign's
  board came out wearing a quarter of its own sheet blown up to fill the face,
  which reads as a plank and is why it nearly passed review.
- **Only a full opaque cube may cull — and "opaque" is a question about
  pixels.** `occludesFace` answered it from `isSeeThrough`, a list of names in
  `block_shapes.ts`, which is geometry and cannot open a PNG. So every block
  whose *shape* covers a face while its *art* does not had to be remembered by
  hand, and the ones nobody remembered deleted the face behind them: a rail on a
  floor, a lily pad on water, petals scattered on grass — and the gaps in the
  texture then showed what was behind the whole structure, which reads as a hole
  through it. `ModelBaker.isTextureOpaque` asks the decoded alpha instead,
  memoised per key, and the mesher gates culling on it. It can only ever cull
  less than the name list did, never more.

  It gates **culling and nothing else**. `opaqueEntry` in `mesher.ts` also
  answers "is that cell solid" for the light lookups, and `lighting.ts` floods
  from `occludesNeighbours` alone — fold the texture into that one and the two
  stop agreeing, so a copper grate becomes a cell the mesher reads light from
  and the flood never lit, and the wall behind it goes black.
- **A flowerbed is one quarter-plate per segment, and they sit above the
  floor.** Pink petals, wildflowers and leaf litter were a full 16×16 plate at
  `y = 0` whatever the count: one petal carpeted the cell, and a plate that
  spans the square *at* `y = 0` covers the face below it. Vanilla's
  `flowerbed_1..4` is a multipart — `flower_amount=3` applies models 1, 2 and 3
  — one 8×8 plate each at four different heights, which is what stops a patch
  reading as a grid. The heights are transcribed rather than levelled.
- **A paper-thin element points both ways, and the picker has to know which
  way the ray came.** Vanilla's `template_azalea` states its lid as a
  zero-thickness element at `y = 16` carrying **both** an `up` and a `down`
  face, so half of the block's top surface points into the cell above. The block
  material is `DoubleSide` — it has to be, for crosses — so the raycaster can
  return either, and on the `down` one `pickBlockAt`'s step along `-normal`
  landed one cell up: the outline drew around air, breaking it did nothing, and
  placing went a cell too high. Reported as "placing an azalea leaves an air
  block above it that cannot be removed". `facingNormal` in `block_hover.ts`
  turns the normal to face the ray first; a front hit is returned unchanged, so
  it cannot alter an answer that was already right.
- **Which way round a texture goes is vanilla's rule, not this app's, and it
  was the mirror of it on all six faces.** `boxFaceGeometry` now reproduces
  `BlockElement.uvsByFace` — `u = 16 - x` on north, `x` on south, `z` on west,
  `16 - z` on east; `v = z` on up and `16 - z` on down — which is one sentence
  said six ways: **seen from outside the block, U runs to the viewer's right and
  V downward**, north at the top of a top face, south at the top of a bottom one.

  It is not a convention this app may choose. Every texture in the game is
  *painted* to it, and every `uv` window in `block_shapes.ts` was transcribed
  under it — the flower pot's `north: [10, 10, 11, 16]` on a box spanning
  `x 5..6` is only `16 - x` and nothing else.

  The reason it survived is worth more than the fix: a Minecraft texture is
  almost always symmetric or noise, so a mirrored plank, ore or brick is a
  mirrored plank, ore or brick. It surfaced three separate times as a report
  about a *block* — a bed whose pillow sat at the joint instead of under the
  headboard, bed legs drawn as two cards because their side faces sampled the
  empty end of their own strip, and a chest that would not come out right
  however its windows were rearranged — and each time the block got the blame
  and the block was innocent.

  Three things travel with it. `windowUvsFrom` has to be turned round too, or a
  shape carrying both a stated window and a derived face comes out with some of
  its boxes mirrored and the rest not. **A box that does not span its axis now
  samples a different region** on north, west and down — which is exactly what
  put a bed leg's window on the blank end of its strip. And `rotateWindowUvs`'s
  direction is decided by that corner order rather than by anything in it, so a
  `rotation: 90` transcribed from vanilla used to come out as vanilla's 270: a
  half-turn, invisible on the anvil's and the grindstone's bands, corrected by
  the same edit because it is the same fact.

  `tests/blocks.ts` states the rule geometrically on all six faces of a cube and
  again on the shapes that use windows, and then states it **in pixels** on the
  one texture in the game that can be read the wrong way round: the light block
  wears its own level as a number, and mirrored the 7 reads backwards. There is
  deliberately nothing there about the chest — `entity/chest/normal.png` is
  left-right symmetric on every face it draws, so a check written on it fails
  when the mapping changes without either arrangement being wrong.
- **Turning a block turns its picture with it, and the top and the bottom get
  nothing for free.** The four sides do: a side texture is painted "U to the
  viewer's right", the viewer walks round with the block, and `rotateFaceMap`
  delivers the right name to the right face. `up` rotates to `up`, so on the two
  flat faces that map is an identity — and their pictures are painted with the
  *model's* north at the top, which after a quarter-turn is not the world's
  north. `turnFlatFaces` in `block_shapes.ts` is the quarter-turn, anticlockwise
  on the top and clockwise on the bottom, because a block that turns one way
  from above turns the other way seen from underneath.

  This is what a vanilla blockstate's `y` does — it rotates the baked model,
  UVs and all — so it belongs to `rotateShapeBox` and not to any one shape.

  `pinFlatWindows` is the other half and is easy to leave out. Coordinate-derived
  UVs are a *function of the box*, so rotating the box moves them: the picture
  would be turned and then read out of a different patch of the tile. Writing the
  un-rotated footprint down as an explicit window is how "vanilla carries the UVs
  rather than re-deriving them" is said here. It only shows on a box that is
  off-centre in plan — a bed's leg, sitting in one corner — and there it is a
  couple of texels of the same wood, which is exactly why it would have been
  left as an exception nobody remembers.

  Reported as "only the bed facing north is right": at south the pillow came out
  at the joint, and at east and west the white/black split ran across the
  mattress instead of along it. The sign is the part to get wrong — a 180° error
  leaves *south* correct and fails only east and west, which is what the checks
  key on.

  **Two families still do not turn, and both are bigger jobs than this one.** A
  full cube with a horizontal `facing` never reaches `rotateShapeBox` at all —
  `shapeFor` gives it `CUBE` and `cubeFaceTextures` picks a texture per face, so
  its top is drawn unturned (the furnace family, dispenser, dropper, observer,
  the pistons, the shulker boxes, carved pumpkin, the command blocks, loom,
  barrel, beehive, and the sixteen glazed terracottas, which additionally need
  the per-face `rotation`s `template_glazed_terracotta` states and this app has
  no entry for). And a shape whose *geometry* is rotation-invariant tends to have
  been written without passing the steps to `transform` at all — closed
  trapdoors, wall hanging signs, campfires, the stonecutter, the lectern, the
  decorated pot, the hopper, the bell. Each of those needs its own check against
  its vanilla blockstate for the authored direction, which `trapdoor`'s own
  comment shows is easy to get a quarter-turn wrong.
- **A texture that lands outside its tile is clamped, not refused.** The atlas
  smears the edge pixels across the face, which reads as a badly drawn texture
  rather than as a window that missed — so `tests/blocks.ts` walks every offered
  id and fails on any face whose UVs leave `0..1`. It found 38 potted plants on
  the first run: their crossed planes ran to `y = 22/16`, six units above the
  block, so the top third of every potted flower was one row of its own texture
  smeared upwards. Derived UVs cannot fail this — they come from box
  coordinates, which are already inside the tile — so it is a check on
  transcription, and transcription is exactly where the arithmetic goes wrong.
- **A box may name a texture per face, and some blocks are unusable without
  it.** `SPECIAL_FACE_RULES` is keyed on the *block*, so "up is `anvil_top`"
  there puts the anvil's top on the up face of every box in the anvil, the ledge
  round its foot included. `ShapeBox.textures` is keyed on the box, which is
  what a vanilla element states. The grindstone's wheel is the case that needed
  it — `#round` on the narrow faces and `#side`, the disc, on the wide ones,
  from one element of one model — and the anvil is the other.

  The anvil is also the sharper lesson, because the guess it displaced was
  *catastrophic and looked fine*. `cubeFaceTextures` works from the block's
  name, and `chipped_anvil` has exactly one texture in the pack:
  `chipped_anvil_top`. So it answered that for all six faces and a chipped
  anvil came out as a solid shape wearing the picture of its own dented top,
  base included — while the plain `anvil` resolved `anvil` plus `anvil_top`.
  The three anvils differ in **one face**, and that face was the only one they
  had in common.
- **`ShapeBox.uvRotation` is vanilla's face `rotation`, and it is not the box
  turning.** The anvil states its foot's west face as `[0, 2, 4, 14]` — four
  wide, twelve tall — on a face twelve wide and four tall; without the turn the
  window names the right pixels and lays them across the face sideways. Vanilla
  implements it by shifting which corner of the window each vertex reads, so
  `rotateWindowUvs` is a cyclic shift of four pairs and touches no coordinate.
  Its signature is what `tests/blocks.ts` checks: rotated, two vertices at the
  same height no longer share a `v`; unrotated they always do.
- **The chest's two strips are fifteen rows in a block fourteen tall, and the
  fifteenth is the seam.** The body's last row and the lid's first are
  byte-identical — `46 48 48 46 46 36 36 36 48 46 46 48 48 59` across the whole
  front — because they are the dark line where the lid meets the body, painted
  once and read by both boxes. Drawn as vanilla states them the two boxes
  overlap over that row with four coplanar side faces; in the game the z-fight
  is invisible because both surfaces are the same pixels, and here it was a
  dotted black line across every chest, because the atlas resamples each window
  on its own and the two stop agreeing to the texel. So the body stops at 9 and
  the lid keeps the seam: nothing squashed, nothing invented, and the only row
  dropped is the one that was drawn twice.

  The **lock** is a separate box and was simply missing — the sheet has it at
  `(0,0)`, 2×4×1, and the notch it leaves in both front strips had nothing
  standing in it. A double half's is **one** wide, because vanilla's is two wide
  centred on the pair; the sheets say so themselves, `normal_left` leaving its
  lock's west window blank and `normal_right` its east, which is the same face
  `inner` already names for the chest.
- **The sign sheets are 32 wide and their parts are unwrapped on them**, which
  the comment there used to deny — the layout looked underivable because
  `unwrapCube` was reading it at the wrong scale. The hanging sign's board
  settles it outright: `oak_hanging_sign.png` has exactly one 14-wide patch at
  `(2,14)` and one 32-wide band at `(0,16)`, which is
  `unwrapCube(0, 14, 14, 10, 2)` and nothing else. The standing sign's board is
  the same reasoning with one number left over, and that is written down beside
  it rather than smoothed over. The bar, the post and the chains are
  approximations of a different kind — a window over the right *material*
  rather than the right part — which is still the whole of what was wrong: with
  coordinate-derived UVs one of a hanging sign's two chains drew the plank
  field and the other the metal, on the same sign.
- **A bed's two halves meet at a plane neither of them draws.** Both used to put
  a face there, and `red_bed_head_south` does not exist — that end of the head is
  never seen — so the joint fell back through the candidate list to
  `bed_head_north` and the head came out with a **headboard at both ends**,
  z-fighting with the foot's own end texture across the middle of the bed. That
  is the "badly stitched, and the head is facing the wrong way" report, and it is
  two faces where there should be none. Each half also carries **two** legs, at
  its own end: both used to carry the whole set of four, which put two of them
  standing in the middle where the blocks meet.
- **Beds and signs used to be in that list and are not any more.** 1.21.9 moved
  them onto ordinary per-face block textures — `red_bed_head_up`,
  `block/oak_sign` — and the `entity/bed/<colour>` and `entity/signs/<wood>`
  aliases kept matching after the pack moved, returning paths it no longer
  contains: all sixteen beds and all 44 signs became hashed-colour cubes in one
  step. Deleting the aliases deleted the unwrap arithmetic with them, which is
  two classes of bug gone rather than fixed. `bedCandidates` maps a world face
  back into the model's own axes, and the head's joint end is the uncoloured
  `bed_head_north` because every bed's joint looks the same.
- **The chest is authored facing *south*, and two independent facts say so.**
  Diffing the four side windows of the body sheet leaves exactly one that
  differs, and a chest has exactly one side that differs — the front. The double
  sheets agree: `normal_left`'s seam is on its west window and `normal_right`'s
  on its east, and those land on the model's east and west faces only under this
  rotation, which is also what makes `getConnectedDirection`'s left/right
  convention come out right. A double half is 15 wide so the two meet with no
  seam, and its coordinates are written **inverted** because they describe the
  model before the half-turn.
- **A block has a front if it has a `facing` and the pack ships
  `<name>_front`.** Derived rather than tabulated, so the furnace, smoker,
  dispenser, dropper, loom, barrel and every workstation are covered at once —
  before it, every one of them wore `<name>_side` on all four sides, fire
  included, because the generic candidate list offers `_front` only after
  `_side`. `_front_on` comes first when the block is lit.

**A sign says what is written on it, and that is the one thing in the pipeline
that is a function of a *position*.** Two signs of the same block state say
different things, so it cannot be baked — `bakeBlockstate` is memoised on the
state and would hand the second sign the first one's words. It is built per
cell, in `culledFaces`, from a **per-position overlay** exactly like `shading`:
`preview.ts` reads the document's block entities once and hands the same map to
every chunk.

Four modules, and the split is the usual one. `sign_text.ts` is the reading and
nothing else — pure, so both spellings can be tested without a resource pack.
`block_shapes.ts` owns `signTextPlanes`, because the board's box and its
quarter-turns are already there and a plane derived anywhere else would be a
second copy of both. `sign_faces.ts` is layout. `model_baker.ts` cuts the
glyphs.

- **Two spellings, both still in circulation.** 1.20 replaced `Text1`..`Text4`
  with `front_text`/`back_text`, nothing migrates a schematic cut before that,
  and files from both eras get opened side by side. Each message is a **JSON
  text component** rather than a string — `{"text":"Hello"}` far more often
  than `"Hello"` — and skipping that step is what reads as "the sign is blank".
  Anything that parses as neither is used verbatim: a sign nobody can read is
  worse than a sign with the raw text on it.
- **The glyphs come out of the pack, as `textures/font/ascii.png`.** A 16x16
  grid indexed by code point, so it needs nothing vendored and nothing fetched
  — the same rule the block models are under. Cut into per-character tiles
  rather than registered whole for two reasons: `MAX_TILE` is 256 and the sheet
  is 512 in this pack, so the atlas would take a pixel in sixteen of a font;
  and the tint is per character anyway, because colour is baked into the tile
  like every other colour here.

  **Only the ASCII page.** `accented.png` and `nonlatin_european.png` are laid
  out by `font/default.json`, which lives in the client jar and is in no texture
  pack, so their code points cannot be looked up. A character off the page draws
  nothing rather than drawing the wrong glyph.
- **The advance is measured, not tabulated** — the last column with a pixel in
  it, plus one, which is what the game does. Minecraft's font is proportional,
  an `i` is two wide and an `m` is six, and laid out fixed-width the text is
  instantly recognisable as wrong. A space has no column to find and takes
  vanilla's four, which makes it the one glyph that is **a width with no key**:
  folded in with "nothing to draw" it got a tile that was never registered, and
  every space emitted a quad addressing a texture the atlas had never heard of.
- **The letters are primed before the atlas is packed**, in `primeBaker`, for
  the reason `buildBlockIcons` primes: the atlas is packed once and the chunks'
  UVs address it, so a glyph first cut *during* meshing lands in a layout the
  mesh cannot see and `buildMesh` drops the face. The symptom is a sign that is
  blank until some unrelated edit re-meshes its chunk — "sometimes the text does
  not load".
- **The chunk cache diffs the text**, as `signDigest`. Third time the same rule
  has earned its keep: dirtiness is *observed*, and text is neither a voxel nor
  a photon, so retyping a sign moved nothing either grid compares and the chunk
  kept the old words. Only its own chunk, not the face-neighbours — `markDirty`
  spreads because light does, and text does not leave the block it is on.
- **The text stands `LIFT` off the board**, half a model unit. Coplanar is
  unresolvable at any distance (`depth.ts` has the arithmetic), and the number
  is in the model's 0..16 units like everything else in that file: written as a
  block-unit `1 / 16` it was divided by 16 a second time on the way out and the
  text sank into the board.
- **Colour is the dye's, and the table is hard-coded in the game.** From
  minecraft.wiki's Sign article. One source rather than the two `mc-versions`
  insists on, and the difference is the failure mode: a wrong DataVersion is
  undetectable here and misbehaves in game a long way away, while a wrong colour
  is a wrong colour on the screen. Fourteen of the sixteen are X11 colour names
  exactly, which is corroboration no single transcription slip would produce.
- **Glowing text carries its own light** and no outline. `BakedFace.shade` is
  normally filled in by the mesher from where the block ended up; a face that
  arrives already knowing keeps it, which is the whole of what lets a glowing
  sign be read in an unlit room. Vanilla also draws an outline in a second
  colour; that is not reproduced.

Two orientation bugs came out with it, both invisible until there were words to
put on the board. A **wall sign** was turned by `facingSteps + 2` and its model
is authored on the south wall looking north, so every one of them hung a quarter
round the block — `facing=north` bolted to the west wall. And a **wall hanging
sign** was handed to the hanging shape whole, which reads `rotation`: it has
none, `Number(undefined)` is `NaN`, the guard turned that into zero, and all
twelve faced south whatever the file said. `signBoard` is now the one place that
decides, and `tests/blocks.ts` checks the **board** rather than the text for
both — the text plane is derived from the same rotated box, so the two agree
wherever the box ends up and every text check passes with the sign on the wrong
wall.

**Water is blended, and a cutout is not — they are different jobs.** The block
material alpha-tests at 0.5 and does not blend, which is right for leaves and
wrong for water: `water_still` is `alpha 180` across its whole tile, so it
passes any alpha test and then draws **solid**. That was the whole of "the water
block has no transparency".

Blending everything is not the fix. The block mesh would move wholesale into
three's transparent pass, where it would sort against the selection box, the
face plates and the grid — all of which are transparent already. So
`ModelBaker` tells the three cases apart from the decoded alpha (`opaque`,
`cutout`, `translucent`), `buildMesh` puts the translucent faces at the **end**
of the index buffer, and `MeshBuffers.opaqueIndices` says where the tail starts.
The viewer draws it as two `addGroup` ranges over one geometry with a
two-material array: no second set of vertices, and a chunk with no water is one
group and one draw exactly as before.

`concatChunks` has to preserve that shape — all the opaque indices, then all the
translucent ones — or the single number naming the split would be a lie about
the middle of the array, so it copies the indices in two passes over the same
pieces.

The blended material keeps **`depthWrite` on** (Minecraft's water is a surface,
not a fog, so a pond hides the sand under its far side), drops **`alphaTest`**
(a blended pass that discarded at 0.5 would throw away the pixels it exists to
draw), and gets **the same `shadeWithBakedLight` injection**, or water would be
the one surface in the build that ignored the sun and the torches.

**A fluid stands as tall as its `level`, and used to fill its cell.** Vanilla's
rule is `(8 - level) / 9` for 0..7 and a full cell for 8 and above, which is
*falling* — so a source with air over it sits at 8/9, the small step down that
makes the top of a pond read as a surface. The property was being read, shown in
the inspector and written back while changing nothing on screen.

It is done in `mesher.ts` by lowering the faces, not by giving the fluid a
shorter *shape*, and that is the whole reason it is there rather than in
`block_shapes.ts`: a shape of kind `boxes` leaves the culled path entirely — its
faces are `extraFaces`, which never cull — and an ocean would then mesh every one
of its own internal faces. `loweredFace` moves only the vertices on the cell's
ceiling, and moves their `v` with them, because a side face is `v = 1 - y` and a
top edge left at `v = 0` would stretch the whole tile over the shorter face
instead of cropping it.

**Anything with the same fluid above it is full height whatever its level.**
Without that every layer of a pool would stand 8/9 tall with a gap over it, and
a deep pond would come out as stripes.

**`waterlogged` puts water in the cell, and used to put nothing.** It is how the
game floods a cell that already holds a fence or a slab or a stair; this app
read it, showed it in the inspector and wrote it back to the file while drawing
nothing, so a waterlogged fence in a pond was a fence-shaped hole in the water.
The cell now gets water's own six faces, culled as a water block's would be.

Water and waterlogged are **one body of water**, which the identical-neighbour
rule cannot see on its own: a waterlogged fence is called `oak_fence`, so a
water block beside one drew the surface between them — a pane of water inside a
single body of it, right where the fence meets the pond. `holdsWaterEntry` in
`mesher.ts` is the answer both sides ask.

**A texture name that resolves nothing is a hashed-colour cube, silently.**
`bakeFallback` colours a cube by hashing the block's name: no error, no log, a
plausible solid block in an arbitrary colour. `minecraft:water[level=0]` hashed
to a vivid green and read as a strange-looking pond rather than as a defect.
**162 of the 920 ids the app offers used to land there, and every one of their
correct textures was already in the shipped pack** — not one asset was missing,
they were all naming rules.

So `tests/blocks.ts` walks all 920 and fails on any that reaches the fallback,
by name. That check is the difference between "some blocks look wrong" and a
finite list, and it is what found the 22 hanging signs a hand-written audit had
excluded as "already handled".

The fix is mostly one idea: **a name that resolves nothing is usually a variant
of one that does, and the variants compose.** `NAME_ALIASES` peels one layer
each — `waxed_`, `infested_`, `potted_`, `_wood`→`_log`, `_hyphae`→`_stem`,
`_wall_torch`→`_torch`, the shape suffix — and `aliasChain` runs them to a fixed
point, so `waxed_exposed_cut_copper_slab` needs the waxed strip and the slab
strip in either order and gets both. Making the shape suffix an *alias* rather
than only a `materialCandidates` spelling is what earns the structure: it puts
the stripped name in the chain, where a rule can be waiting for it.

Three that are not that idea. A carpet is cut from **wool** and the suffix
already stripped `white_carpet` to `white`, which is not a texture. Hanging
signs live one directory deeper and must be matched *before* the ordinary sign
rule, which otherwise reads `acacia_hanging_sign` as a wood called
"acacia_hanging". And **a crop's texture is a growth stage, which `age` is not**:
carrots and potatoes have eight ages and four textures, spent `0,0,1,1,2,2,2,3`
— weighted late, so a field looks nearly ripe for most of its life — while
nether wart is `0,1,1,2`. Transcribed per crop from its blockstate file; no
counting rule produces them.

**Updating the bundled pack moves things out from under the code.** Faithful
Release 14 is cut for the copper-golem era, and going there from Release 10
broke three things at once that no amount of care in this repo would have
prevented: beds and signs left `entity/`, `block/chain` disappeared behind
`iron_chain`, and the sky bodies moved to `environment/celestial/` with one file
per moon phase. `sky_textures.ts` therefore tries the new layout and falls
through to the old, rather than switching on `pack_format` — a missing texture
already means "draw the plain squares", so an unknown layout degrades to what
the app did before the sky existed.

The lesson is the tripwire's, not the pack's: 127 ids went to the hashed-colour
cube in one step and were listed by name in one run. Without that check the
report would have been "some blocks look odd since the update".

**One alias earned its keep over five.** `X_wall_Y` → `X_Y` covers wall signs,
wall torches, coral wall fans, wall heads and wall hanging signs together. The
*leading* form — `wall_torch`, `wall_sign` — is the shape-suffix rule's `wall_`
strip, which is a different rule for a different shape of name.

`SPECIAL_FACE_RULES` is checked **per face, not per candidate**: a row is a
candidate list, and `grass_path`'s `["dirt_path_top", "grass_path_top"]` covers
the 1.17 rename, so the older spelling is legitimately absent from a modern
pack. Requiring every candidate to exist fails that row and teaches whoever hits
it to delete the legacy name — the opposite of what the row is for.

**Light and occlusion are baked into the vertices, and that is why they are
main's.** Occlusion at a corner depends on the blocks *around* it and light is a
flood fill over the voxel grid — the renderer has neither, it receives geometry.
`preview.ambientOcclusion` used to nudge the intensity of two lights, which is a
different thing wearing the same name.

Smooth lighting reads the **same four cells** the occlusion does — the one the
face looks into, the two beside it and the diagonal — so it costs the lookups
and nothing else once occlusion is on. Solid cells are skipped rather than
counted as dark: averaging a wall's own unlit interior into the vertex beside it
would put a dark seam along every corner in the build, which is what occlusion
already says, more honestly.

Every vertex carries **three** numbers, riding the colour attribute: block
light, sky light, occlusion. Three and not one brightness, because only the sky
half moves with the hour. Folded together in main, the sun would re-mesh the
whole document every time it moved and a torch would go out at dusk; kept apart,
the viewer's `uDaylight` uniform is the entire cost of a day passing.

`vertexColors` is declared on the material to *bind* the attribute, and three's
own use of it — a plain multiply into the diffuse — is then replaced in
`onBeforeCompile`. These are not colours; left as colours a lit wall turns
green.

**The two channels are used differently, and that asymmetry is the feature.**
Sky light *dims the albedo*, so the sun still lights a surface and the shadow
map still darkens it. Block light is added to `totalEmissiveRadiance` instead,
because as a multiply it could only ever stop a surface being dark — never make
it brighter than the scene's own lights already had it. A torch in a sealed room
at night therefore lit nothing at all: the ambient there is near zero, and near
zero times anything is near zero. Emissive is added after the lighting pass and
owes nothing to `uDaylight`, which is what lets a torch light a room the sun
cannot reach and keep it lit after dark.

**A block that glows only while `lit` has two possible defaults, and they
differ.** A bare `minecraft:campfire` is burning; a bare `minecraft:furnace` is
not. One rule for both either lights a village by its cold furnaces or puts out
every campfire in it, so `lighting.ts` keeps two sets.

That is also where pre-1.13 lands, and there is nothing further to do about it:
in 1.8.8–1.12.2 a lit block is a different `ID:DATA` — furnace 61 against lit
furnace 62, redstone lamp 123 against 124 — and `legacy_blocks.json` has already
turned that into `lit=true` by the time the light pass sees it. `minecraft:light`
is the one block whose level is in its *state* rather than its name, which is
why `blockEmission` reads `level` at all.

The floor of `0.06` in that shader is deliberate: fully unlit is black, a block
in a sealed room would be a hole in the picture, and this is an editor where
"you cannot see what you are working on" is a bug however faithful it is. The
sky's night floor of `0.2` in `sky.ts` is the same decision at the other end.

Two things about the flood fill, both measured:

- **The sky pass is seeded from the edge of the open sky, not from all of it.**
  Every open cell in an unroofed column is already at 15, which on an open build
  is most of the volume — half a million cells, each dequeued, decomposed into
  coordinates and asked about six neighbours only to find them all already at 15.
  That was **223 ms an edit**; seeding from cells that touch something solid is
  **16 ms**.
- **`spread` writes its six neighbours out longhand.** A closure allocated per
  dequeue was most of the rest.

**The chunk cache diffs the light, not just the voxels.** A torch changes what a
chunk looks like fifteen blocks away without changing a voxel there, so light is
packed to a byte per cell and compared exactly as the voxels are. Same rule as
ever: dirtiness is *observed*, not announced — a caller that had to remember to
say "and the light reached this far" would forget, and the chunk that stayed
dark would be a bug nobody could reproduce.

**Animated textures are blitted into the atlas, not packed into it.** Water is
32 frames, lava 38, fire 32; a square tile holding all of them would either grow
the atlas thirty-twofold or leave each frame eleven pixels across. So the atlas
keeps **one** frame, `MeshAtlas.animations` carries the rest beside it, and the
viewer calls `copyTextureToTexture` once per texture per tick — a sub-image
upload of one tile, not of the 27MB sheet. One scratch `DataTexture` per
animation is reused, so playing a frame allocates nothing, and a texture already
showing the right frame is skipped.

Four things about it are load-bearing:

- **The clock is wall time, not frames.** The game states animation speeds in
  ticks of 50ms; driven per frame, a 144Hz display would run the water four
  times too fast.
- **`frameTime` comes from each texture's own `.mcmeta`.** Water is 2 ticks and
  prismarine is 300 — a ripple and a shimmer. A constant would make them the
  same block. The `.mcmeta` is read only for a texture whose *shape* already
  says it is a strip, so the detection rule is unchanged and no still texture
  costs a file lookup.
- **The atlas holds the first frame in play order**, not the strip's frame 0.
  Lava's `.mcmeta` reorders 20 source frames into a sequence of 38 and
  prismarine's turns 4 into 22, so the two are different pictures — and the
  payload's tile position is *derived from the UV rect*, which means
  `tests/blocks.ts` can check it by requiring the pixels already in the atlas at
  that position to be frame 0. Off by a row, a column or a tile and they are
  not.
- **The frames are tinted with the tile.** Water is the block that needs both:
  biome-tinted *and* animated. The tint is applied at bake time so the atlas is
  the single source of colour, so frames that arrived untinted would show the
  biome's water for one instant and grey for every frame after. That is exactly
  what the position check caught.

**The sun and the moon come out of the resource pack, as pixels.** They live
at `textures/environment/`, nowhere near the block textures and never asked for
by anything that meshes — so `services/sky_textures.ts` reads them directly and
they never touch the baker or the atlas. Pixels rather than a PNG for the same
reason the atlas is pixels: the CSP forbids `blob:`, three.js decodes an
embedded image through `ImageBitmapLoader`, and a decode that cannot happen
renders white while reporting success.

`moon_phases.png` is eight phases in a four-by-two grid and only the first is
used: drawing the sheet whole puts a strip of eight moons in the sky, and a
schematic has no date for a phase to track. A pack shipping neither is not a
failure — `null` means the viewer draws the plain squares it drew before.

**They are drawn with additive blending, and that is not a style choice.**
`environment/sun.png` is a *palette* PNG with no transparency chunk at all:
every pixel is opaque and everything around the sun is solid black. Blended
normally it draws exactly that — a black square with a sun in the middle. The
game renders the sky bodies additively, where black contributes nothing, and
that is what makes the file make sense.

**The shadow camera is fitted to the document, and there is deliberately no
texel snapping.** The fit is the real win: a shadow map has a fixed pixel
budget, so a box sized for the largest schematic anyone might open spends nearly
all of it on empty air when the schematic is a house.

The snap was written and then removed, which is worth recording so it is not
"added back" as an oversight. Quantising the camera to the texel grid fixes
crawl caused by the box **translating**, and this box does not translate — it is
centred on a document that does not move. What moves the shadow edges here is
the light *rotating*, and snapping a rotating frame does not touch that, because
the texel grid rotates with it. It would have been complexity that reads as a
fix. If the box ever starts following the camera rather than the document, it is
the first thing to add back.

**The sky is drawn in a pass of its own, and both halves of that are a fix.**
It was a sphere of radius 3000 in the main scene while `maxDrawDistance` — and
so `camera.far` — defaults to **512**: every vertex outside the frustum, clipped,
nothing drawn, and the viewport showing the renderer's clear colour. Black, with
no sky in it. `skyDistance` therefore derives the dome's radius from the near and
far planes and **clamps** — the clamp is the guarantee, and `tests/ui.ts` fails
three checks without it.

The separate pass is the other half. The sun and the moon are transparent, and
three.js draws transparent objects *after* every opaque one, so in a single
scene they would have painted over the schematic however their depth test was
set. Sky, then `clearDepth()`, then the world: nothing in the sky can occlude
anything, whatever its distance. The dome rides with the camera, which is also
what stops it being a sphere you can fly out of.

With the sky off there is no second pass and `scene.background` is the theme
colour again, exactly as before any of this.

**The virtual floor is not a block.** A plane at y=0, twenty thousand across,
receiving shadows and casting none. It exists because a build with nothing under
it floats, and because a shadow with nothing to fall on is invisible — which
made the shadow setting look broken. `groundColor` is a string and `""` means
"follow the theme": a stored hex would stay dark after switching to the light
theme with nothing on screen to say why, so there is a button back to it.

**It is at y=0, and so is everything drawn on it.** The floor, the 256-block
`GridHelper` over it and the build-grid patch under the cursor are coplanar by
design — the grids are a drawing *on* the floor — and they used to be held apart
by hand-picked epsilons: -0.02, -0.01, +0.002. Those are the bug rather than the
fix. A perspective depth buffer stores a value linear in `1/z`, so one step of it
is worth `z²·(1/near − 1/far)/(2^bits − 1)` world units: with this viewer's near
plane of 0.1, a thousandth of a block at 40 out and a *fiftieth* at 180 — which
is where the far corner of the grid sits. Past that they round to the same depth
and the winner is decided per pixel, which is the stipple that gets reported as
"the floor and the grid intersect".

No constant fixes it. One big enough to survive the far corner is a grid visibly
floating near the camera, and the floor is 20,000 blocks across, so there is no
far corner to stop at. The floor declares a `polygonOffset` instead, which is
denominated in the two things that actually vary — `units` counts *depth-buffer
steps* and `factor` scales with the polygon's depth slope, which is what grows as
a surface turns edge-on. It applies to filled polygons only, and that is what
makes it exact here: the floor is the only polygon of the three, so pushing it
one step away wins the argument for both sets of lines at every distance. Pushing
the base rather than pulling the decals is safe because nothing is behind the
floor — the sky is a separate pass that clears the depth buffer first.

`depth.ts` holds the arithmetic and `tests/ui.ts` states it from both ends: an
epsilon is resolvable at 16 blocks and gone by 64, at every draw distance the
slider offers. It also greps `Viewer.svelte` for a `position.y` assignment near
zero, because the epsilons are easy to reintroduce, they look like care, and
nothing else in the app would notice.

**The sky is the viewer's alone, and `sky.ts` is the part that is testable.**
The dome, the two squares and the stars are geometry with no relationship to the
schematic; what needed writing down is the set of curves through a
24000-tick day, every one of which has boundaries where being a whole phase out
is easy. The clock is Minecraft's ticks because that is the unit anyone building
a schematic already thinks in — `/time set 18000` is a thing people type.

The daylight cycle is a **timer, not an animation frame**. The viewport already
has a render loop, and a second one running at the display's rate would advance
the clock faster on a 144Hz screen; "sixty game minutes per real second" is a
claim about wall-clock time. It writes a mirror in `App.svelte` rather than the
setting, because the setting is on disk and this moves ten times a second.

**`biomeColor` and `waterColor` are the two preview settings that rebuild the
GLB.** Foliage and water both ship greyscale and are tinted per biome — from
two different colours, which is why there are two settings. The tint is
multiplied into the texture atlas, not applied by the viewer, so both are part
of `preview.ts`'s cache key and `App.svelte` re-runs the preview when either
changes. Everything else in `PreviewSettings` the viewer applies live.

Related trap: a fluid's texture is not named after its block. `minecraft:water`
is drawn from `water_still`, and none of the generic `_top`/`_side`/`_front`
candidates produce that, so water fell through to the hashed-colour cube —
which for `water[level=0]` hashes to bright green. Fluids are listed explicitly
in `SPECIAL_FACE_RULES`.

## Reading the code

Comments in `src/main/**` cite `core.py`, `component.py`, `app/pipeline/*.py`
with line numbers. These are deliberate provenance markers recording which line
of the original each decision came from, and which behaviors were preserved
versus changed on purpose. The files they name live in git history.

`migration/` and `migration-kit/` on disk are the port's working record
(rulebook, architecture notes, deviation log, parity harness). They are
gitignored and transient — useful for archaeology, not part of the project.
