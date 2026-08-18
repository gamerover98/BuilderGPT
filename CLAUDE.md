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
              preview, schematic, output, settings-store, …
    pipeline/ schem -> GLB (loader, loader_formats, model_baker, mesher, atlas, …)
    core.ts   sandboxed execution of LLM-generated build scripts
  preload/    contextBridge — the only renderer↔main surface
  renderer/   Svelte 5 UI + the Three.js viewer
resources/    shipped as extraResources: the default pack, legacy_blocks.json,
              opencode_models.json
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
`npm run dev｜build｜typecheck｜package:{win,linux,mac}｜smoke｜smoke:{hello,sandbox,services,schematics,blocks,document,history,formats,session,agent}`.

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

**MCEdit output is lossy, and says which way.** A block with no legacy
equivalent fails the save by name; a block whose exact state the format cannot
carry is written as the base block and reported through `degraded`. Both
directions count: a state-less `minecraft:chest` comes back as
`chest[facing=north,type=single]`, because the metadata nibble has to say which
way it faces. The rule is simply "the exact state did not match".

**Block picking steps a *hair* inwards from the hit face**, not half a block.
The mesh is one fused geometry with no per-block identity, so the owning block
is found by moving `1e-3` along `-normal` from the hit point and flooring. Half
a block is the obvious choice and is wrong: a pressure plate is a sixteenth
tall, so stepping half a block in from its top face lands underneath it.

**`block_id_list.txt` is generated.** `node scripts/gen-block-list.mjs >
block_id_list.txt`, idempotent, from `legacy_blocks.json` plus explicit family
tables for 1.13+. Editing it by hand is fine right up until someone regenerates
it. It is also the list spliced into the prompt, so the set the model is told
about cannot drift from the set it is judged against.

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

**The project has zero native dependencies.** No `electron-rebuild`, no
`asarUnpack`, no per-platform build toolchain — one asar works everywhere. Any
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

**API keys never travel main → renderer.** They are stored encrypted via
`safeStorage`; the renderer only ever learns `{ hasKey: true }`.

**One IPC channel per verb, all declared in `src/shared/ipc.ts`.** No generic
dispatcher. Everything crossing must be structured-clone-safe — binary payloads
are `Uint8Array`, never `Buffer`.

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

**Block geometry is hand-described in `pipeline/block_shapes.ts`, not loaded.**
The Python original only ever produced full cubes — its model-driven path was
dead code (DEV-008) — so stairs, fences and slabs all rendered as solid blocks.
Reading real models is not an option: Faithful is a texture pack and ships none,
and the vanilla models live in the client jar, which this app cannot
redistribute. Shapes are transcribed from vanilla in the same 0..16 units;
anything unlisted stays a cube. Two consequences worth knowing:

- Only a full opaque cube may cull a neighbour's face (`occludesNeighbours`).
  Culling against a slab or a fence punches holes where nothing covers.
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
- **Beds, chests and signs have no block model at all.** The game draws them
  from `textures/entity/…` with a `ModelPart` cube unwrap; `unwrapCube` in
  `block_shapes.ts` reproduces that layout. Banners and shulker boxes stay on
  a dyed-wool stand-in — their sheets need layer composition this code does not
  do.

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
