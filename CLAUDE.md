# Schematic AI Studio — operating manual

An Electron desktop app for editing Minecraft schematics, by hand and by AI.
Node/TypeScript main process, Svelte 5 renderer, Three.js viewport.

The product name is **Schematic AI Studio**. Technical identifiers are
deliberately *not* renamed: `package.json`'s `name` is still `buildergpt`
because that is what `app.getName()` resolves to and therefore what the userData
directory is called, `appId` is install identity, and the IPC channels are
prefixed `bgpt:`. Rename branding; leave identifiers alone unless there is a
concrete benefit.

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

**Breaking never grows.** A break is `setBlock` with air, and growing to make
room for air is a resize and nothing else — the same reason `replace` does not.
Nothing sends a break from outside the box today, because a break comes from a
pick and the block therefore exists; the guard exists so that stays true, and
`tests/session.ts` fails without it.

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

**Three vendored datasets, three generators, three skills.** The pattern is the
same each time and it is the one to copy: the answers are looked up, recorded
with where they came from, and the generator replaces only the rows between two
markers. Running with nothing new must change no bytes — if it rewrites the file
every time, the ordering or the formatting has drifted and *that* is the bug.

| data | generator | skill |
|---|---|---|
| `resources/mc_versions.json` | `gen-mc-versions.mjs` | `mc-versions` |
| `resources/block_states.json` | `gen-block-states.mjs` | `mc-blockstates` |
| `block_id_list.txt` | `gen-block-list.mjs` | `mc-block-models` (for what the ids must draw as) |

The skills' trust rules deliberately differ, and the difference is the point.
`mc-versions` buys trust with **two independent sources that agree**, because a
transposed digit in a DataVersion is undetectable by any local check — the file
saves, opens, and misbehaves in game. A wrong property name or texture name is
**mechanically detectable**, so those two skills' job is to keep the tripwire
honest rather than to count sources. Corroboration still applies where no
machine can check: the *history*, which is prose on a wiki page and appears in
no dataset.

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

**Enablement is decided from main's own state**, not reported back by the
renderer: `currentSession() !== null` plus the recents list main already owns.
`busy` is deliberately not modelled — it is a renderer convention, and every
action behind these items refuses on its own. `refreshShell` rebuilds the menu
only when its *shape* moved (a signature over `hasDocument` and the recent
paths) and always retitles, because it is called from every handler that answers
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

`mc_versions.json`'s arrangement for its reason. 1105 blocks come out as 118
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

**OpenCode's API key is required per model, not per provider.** 9 of its 61
models are free; the rest bill per token. `openCodeModelRequiresKey` in
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
