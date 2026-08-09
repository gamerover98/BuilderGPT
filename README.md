<div align="center">
   <h1>BuilderGPT</h1>
   <img src="https://img.shields.io/badge/Electron-desktop-47848F" alt="Electron">
   <img src="https://img.shields.io/badge/TypeScript-strict-3178C6" alt="TypeScript">
   <img src="https://img.shields.io/github/license/CyniaAI/BuilderGPT" alt="License">
   <br>
</div>

Describe a building in plain language and a language model produces a
ready-to-use Minecraft structure, rendered in 3D before you export it. Output is
a `.schem` file or a `.mcfunction` script, importable with tools like WorldEdit.

BuilderGPT is a **desktop application**: one installer, no runtime to set up.

> This is a desktop rewrite of the original
> [CyniaAI/BuilderGPT](https://github.com/CyniaAI/BuilderGPT), which ran as a
> Python/Streamlit web app. The generation approach and prompt design come from
> that project; see [Why this was rewritten](#why-this-was-rewritten) and
> [Credits](#credits).

## Features

- Generate structures from natural language, with an optional reference image
- Live 3D preview, textured with a bundled resource pack (or your own)
- Export as `.schem` or `.mcfunction`
- Providers: OpenAI, Google Gemini, OpenCode, or any OpenAI-compatible endpoint
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
| Runtime dependencies | 12 (`amulet-core`, `numpy`, `Pillow`, `quickjs`, `mcschematic`, …) | 5, all pure JS/WASM |
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

Four automated suites remain in `tests/`, including one that asserts the
sandbox's containment properties directly.

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
your OS keychain and never sent back to the window. Choose a Minecraft version
and an export format, describe what you want, and press **Generate**. Results
are written to the app's data directory and listed under *Generated files*,
where they can be previewed again or revealed on disk.

Preview settings — sun angle, render scale, draw distance, grid, wireframe,
ambient occlusion — apply live without regenerating. **Re-render** rebuilds the
preview from the last schematic, and an existing `.schem` can be loaded directly
without generating anything.

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

## License

This project is licensed under the Apache 2.0 License. See [LICENSE](LICENSE) for details.
