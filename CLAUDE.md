# BuilderGPT — operating manual

An Electron desktop app that generates Minecraft structures with an LLM and
previews them in 3D. Node/TypeScript main process, Svelte 5 renderer, Three.js
viewport.

It began as a Python/Streamlit app and was ported in full. The Python sources
are gone from the working tree; they remain in git history as the spec.

## Layout

```
src/
  shared/     types crossing the process boundary — ipc.ts (channel list), settings.ts
  main/       everything privileged: fs, network, the JS sandbox, the schem->GLB pipeline
    ipc/      ipcMain.handle registrations — thin, no business logic
    services/ llm, opencode, generate, preview, schematic, output, settings-store, …
    pipeline/ schem -> GLB (loader, loader_formats, model_baker, mesher, atlas, …)
    core.ts   sandboxed execution of LLM-generated build scripts
  preload/    contextBridge — the only renderer↔main surface
  renderer/   Svelte 5 UI + the Three.js viewer
resources/    shipped as extraResources: the default pack, legacy_blocks.json,
              opencode_models.json
tests/        the automated suites (see Commands)
scripts/      build / start / check, in PowerShell and sh
```

## Commands

```bash
scripts/start.sh          # or scripts\start.ps1   — dev mode, hot reload
scripts/build.sh          # or scripts\build.ps1   — typecheck + build into out/
scripts/build.sh --package win   # ...and produce an installer in release/
scripts/check.sh          # or scripts\check.ps1   — typecheck + all four test suites
```

They are thin wrappers over the npm scripts, which stay the source of truth:
`npm run dev｜build｜typecheck｜package:{win,linux,mac}｜smoke｜smoke:{hello,sandbox,services,schematics}`.

## Invariants — do not quietly change these

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
`contextIsolation: true`, `sandbox: true`, and a CSP whose `connect-src` allows
only `blob:` — a scheme that names no host, so no egress is possible. Every HTTP
call is made by the main process — that is the whole reason this is an Electron
app rather than a web app. If a feature seems to need network access in the
renderer, it belongs in main.

`blob:` is there because three.js reads a GLB's embedded texture through
`ImageBitmapLoader`, which `fetch`es a blob URL. Removing it does not fail
loudly: `GLTFLoader.loadTextureImage` ends in `.catch(() => null)`, so the model
loads and renders **untextured white** while `onLoad` reports success. There is
no way to select a different loader — GLTFLoader only consults
`manager.getHandler()` for images that carry a `uri`, and ours live in a
bufferView. `Viewer.svelte`'s `untexturedReason()` is the tripwire for it.

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

**`coerceSettings` in `settings-store.ts` whitelists every field by name.** It
runs on read *and* on write, and it does not spread. A field added to `Settings`
but not to that function is silently dropped on save — it appears to work until
the next reload.

**Do not adopt `@opencode-ai/sdk`.** It looks like the obvious dependency for
the OpenCode provider and is not: it is a client for a *local opencode agent
server*, spawns the opencode CLI, and has no path to a chat completion against
OpenCode Zen. The client OpenCode's own registry designates for Zen is
`@ai-sdk/openai-compatible`, which is what `services/llm.ts` uses.

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
