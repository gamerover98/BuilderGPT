<div align="center">
   <h1>Schematic AI Studio</h1>
   <img src="https://img.shields.io/badge/Electron-desktop-47848F" alt="Electron">
   <img src="https://img.shields.io/badge/TypeScript-strict-3178C6" alt="TypeScript">
   <img src="https://img.shields.io/github/license/CyniaAI/BuilderGPT" alt="License">
   <br>
</div>

An AI-assisted 3D editor for Minecraft schematics. Open a build, select part of
it, and either edit it by hand or ask for the change in plain language — the AI
works on the schematic itself, not on a description of it. Everything it does is
an ordinary editor action: one request is one <kbd>Ctrl</kbd>+<kbd>Z</kbd>.

It also still generates a structure from nothing, which is where the project
started. Files are `.schem` or `.mcfunction`, importable with tools like
WorldEdit.

Schematic AI Studio is a **desktop application**: one installer, no runtime to
set up.

> Formerly BuilderGPT, and originally
> [CyniaAI/BuilderGPT](https://github.com/CyniaAI/BuilderGPT), a Python/Streamlit
> web app. The generation approach and prompt design come from that project; see
> [Why this was rewritten](#why-this-was-rewritten) and [Credits](#credits).

## Features

- **Edit schematics**: select a region in the viewport, fill or replace inside
  it, with full undo/redo
- **Ask the AI to edit them**: it inspects the build through tools and changes
  it directly, and the whole request undoes in one step
- Generate structures from natural language, with an optional reference image
- Live 3D preview, textured with a bundled resource pack (or your own)
- Read and write Sponge v2, Sponge v3 (WorldEdit / FAWE) and legacy MCEdit
  `.schematic`, keeping the format a file came in — chest contents and sign text
  included
- Providers: OpenAI, Google Gemini, OpenCode Zen, or any OpenAI-compatible
  endpoint. OpenCode's free models need no API key at all
- API keys encrypted by the OS keychain — no `.env` file, no plaintext on disk
- Installers for Windows, Linux and macOS

## Why this was rewritten

The original is a Python app built on Streamlit. The rewrite to
Electron/TypeScript was not a preference about languages — it removes a set of
concrete constraints that came from that stack rather than from the problem.

**The application's own output was already JavaScript.** The model is asked to
write `buildCreation(x, y, z)` in JS, using `safeSetBlock` and `safeFill`. The
Python version therefore had to embed a *separate* JavaScript engine and marshal
every block-placement call across a Python↔JS FFI boundary. That boundary was
not free: during the port it turned out to be hiding a real defect, where a
non-numeric coordinate coming back from the sandbox silently became `NaN`
instead of being rejected. In TypeScript the host and the generated program
share one runtime and one type system, and the boundary is gone.

**Everything else followed from Streamlit being a web framework.** It serves a
page on `localhost:8501` that you open in a browser, which means the UI lives in
a browser sandbox: provider calls are subject to CORS, and the 3D preview had to
be base64-encoded into an iframe to reach the viewer. Streamlit also re-executes
the whole module on every interaction, which forced defensive singleton code
whose only job was surviving that. In Electron the backend is a Node process:
HTTP calls go out directly, the preview is passed as bytes over IPC, and the UI
holds its own state.

| | Python / Streamlit | Electron / TypeScript |
|---|---|---|
| Runtime dependencies | 12 (`amulet-core`, `numpy`, `Pillow`, `quickjs`, `mcschematic`, …) | 7, all pure JS/WASM |
| Toolchain to install | `build-essential`, `cmake`, `gcc`, `g++`, `python3-dev`, `zlib1g-dev`, `libbz2-dev`, `libsnappy-dev` | none |
| Packaging constraints | `setuptools<71.0.0`, pinned because `pkg_resources` was removed in v71 | none |
| Delivery | Docker image + a server on `localhost:8501`, opened in a browser | native installer per platform |
| Provider calls | from the browser, subject to CORS | from the Node main process, direct |
| API keys | `.env` in plaintext on disk | encrypted via the OS keychain |
| 3D preview | GLB base64-encoded into a Streamlit iframe | bytes over IPC, straight into Three.js |

For the end user the practical difference is the first two rows: the Python
version needed a working C/C++ toolchain to install at all, because two of its
dependencies compile native extensions. This one has no native dependency, so
the same build runs everywhere and there is nothing to compile.

### On the migration itself

The port was carried out with AI assistance, and verified rather than trusted.
The structure-preserving part — the schematic-to-GLB pipeline and the sandbox
core — was checked for parity against the running Python original: identical
block placements, byte-identical geometry, and byte-identical decoded texture
pixels. The one measured divergence was in UV coordinates, at roughly one unit
in the last place of float32, from NumPy and V8 rounding the same formula
differently.

Five automated suites remain in `tests/`, including one that asserts the
sandbox's containment properties directly and one that requires the three
schematic container formats to decode to the same voxel grid.

## Running from source

Requires [Node.js](https://nodejs.org/) 20 or newer. Dependencies install
automatically on first run.

| | Windows | Linux / macOS |
|---|---|---|
| Start (dev, hot reload) | `scripts\start.ps1` | `scripts/start.sh` |
| Build | `scripts\build.ps1` | `scripts/build.sh` |
| Build an installer | `scripts\build.ps1 -Package win` | `scripts/build.sh --package linux` |
| Run all checks | `scripts\check.ps1` | `scripts/check.sh` |

Builds land in `out/`, installers in `release/`. The equivalent npm scripts
(`npm run dev`, `npm run build`, `npm run package:win`, …) work directly too.

## Usage

Pick a provider in the left panel and paste an API key — it is encrypted with
your OS keychain and never sent back to the window. With OpenCode Zen the model
list is grouped by what it costs, and the free models generate without a key;
only the paid ones ask for one. Models that cannot read images say so, and the
reference-image picker disables itself rather than sending a request the model
will reject.

Choose a Minecraft version and an export format, describe what you want, and
press **Generate**. Files are named after the structure and written to the
output folder you pick; if a file of that name already exists it is renamed with
a timestamp rather than overwritten. Everything generated is listed under
*Generated files*, where it can be previewed again or revealed on disk.

The left panel scrolls independently of the 3D view, and can be resized by
dragging its edge or hidden entirely with **Ctrl+B**.

Preview settings — sun angle, render scale, draw distance, grid, wireframe,
ambient occlusion — apply live without regenerating. **Re-render** rebuilds the
preview from the last schematic, and an existing schematic can be loaded
directly without generating anything.

## How generation works

1. **Prompting** — the Minecraft version, your description, and the allowed
   block IDs (`block_id_list.txt`) are injected into the templates in
   `prompts.json`.
2. **Program synthesis** — the model writes JavaScript implementing
   `buildCreation(startX, startY, startZ)` using `safeSetBlock` and `safeFill`.
3. **Sandboxed execution** — that code runs in QuickJS compiled to WebAssembly,
   with a wall-clock deadline, a memory cap, and no ambient authority: the only
   things reachable from inside are two validated block-placement callbacks.
   Coordinates and block IDs are checked at that boundary, not trusted.
4. **Export** — placements become a Sponge v2 `.schem`, or a `.mcfunction`
   command script.
5. **Preview** — the schematic is turned into a GLB (blocks → culled faces →
   texture atlas → mesh) and rendered with Three.js.

## Credits

- [CyniaAI/BuilderGPT](https://github.com/CyniaAI/BuilderGPT) — the original
  Python implementation this desktop version is derived from.
- [MCBench (mcbench.ai)](https://mcbench.ai) — BuilderGPT's support for a
  JavaScript-based building/structure representation and elements of its
  prompting approach are inspired by MCBench. The JavaScript parsing and
  integration code used here was implemented independently for this project.
- [Faithful](https://faithfulpack.net/) — the 64x resource pack bundled to
  texture the 3D preview, used under its own license.
- [PrismarineJS/minecraft-data](https://github.com/PrismarineJS/minecraft-data)
  (MIT) — `resources/legacy_blocks.json` is its pre-1.13 flattening table, used
  to read legacy MCEdit `.schematic` files.
- [models.dev](https://models.dev) — the OpenCode-maintained model catalogue
  that supplies pricing and modality data for OpenCode Zen models.

## License

This project is licensed under the Apache 2.0 License. See [LICENSE](LICENSE) for details.
