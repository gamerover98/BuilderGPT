// Regenerates every application icon from one master.
//
// Usage, from the repo root:
//
//   node scripts/gen-icons.mjs        (or: npm run gen:icons)
//
// stderr carries a report. Read it, don't just count it.
//
// ## One master, four consumers
//
// `build/logo.png` is the only file a human edits. Everything this writes is
// output, and there are four destinations because four different things resolve
// an icon in four different ways:
//
//   build/icon.png          electron-builder's auto-detect. It generates the
//                           Windows .ico and the macOS .icns from this, which
//                           is why nothing of that kind is committed -- and why
//                           it must stay at least 256px.
//   build/icons/<n>x<n>.png electron-builder's documented Linux icon set.
//   src/renderer/src/assets/ the About box. It lives inside the vite root
//                           rather than being imported across it from `build/`,
//                           which would depend on `server.fs.allow`'s search.
//   images/logo.png         the README header, beside the screenshots it
//                           already references.
//
// Every size is a downscale from 1254, the 1024 included. Nothing is upscaled.
//
// ## The premultiply pair is the whole reason this is a script
//
// `scale` does not premultiply alpha, so it interpolates the RGB of fully
// transparent pixels -- which in a generated PNG are (0,0,0,0) -- into the
// opaque ones beside them. Measured on this master at 16px: semi-transparent
// edge pixels come out **41.8/255 darker** without the pair than with it. That
// is a dark halo tracing the mark, worst at the small sizes where one pixel of
// fringe is a fifth of the icon, and it reads as artwork that was cut out badly
// rather than as a missing scaling flag.
//
// So the filters are checked for by name before anything is written. Falling
// back to a bare `scale` would produce every file, report success, and be wrong
// in a way nobody attributes to this script.
//
// ## It must be idempotent
//
// ffmpeg's PNG encoder embeds no timestamp, so identical input and identical
// flags give byte-identical output. Running this with an unchanged master must
// therefore leave `git status` clean -- if it rewrites the files every time,
// the flags or the ordering have drifted and *that* is the bug.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = path.join(ROOT, "build", "logo.png");

/**
 * The Linux icon set, and the sizes an .ico is cut from.
 *
 * 16 through 1024 is electron-builder's documented set; the file names are its
 * convention too (`<size>x<size>.png`), and it reads the directory rather than
 * a manifest, so a name that does not match that shape is simply ignored.
 */
const ICON_SET = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

/** The three destinations outside `build/icons/`, each at the size it is used. */
const EXTRA = [
  { size: 512, to: ["build", "icon.png"], why: "electron-builder auto-detect" },
  { size: 256, to: ["src", "renderer", "src", "assets", "logo.png"], why: "the About box" },
  { size: 256, to: ["images", "logo.png"], why: "the README header" },
];

function ffmpeg(args) {
  return execFileSync("ffmpeg", args, {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    // The 1024px PNG is over a megabyte, which is `execFileSync`'s default cap.
    // Past it the child is killed with SIGTERM mid-write and the failure reads
    // as ENOBUFS rather than as "the buffer was too small".
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Fail by name rather than silently scaling without them. */
function requireAlphaFilters() {
  let listing;
  try {
    listing = execFileSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
  } catch (err) {
    throw new Error(
      `ffmpeg is not runnable (${err.message}). It must be on PATH -- this script ` +
        "shells out to it rather than taking an image dependency.",
    );
  }
  for (const name of ["premultiply", "unpremultiply"]) {
    // Anchored to the listing's own column layout: a bare substring test
    // matches "unpremultiply" when looking for "premultiply".
    if (!new RegExp(`^\\s*[A-Z.]+\\s+${name}\\s`, "m").test(listing)) {
      throw new Error(
        `This ffmpeg has no "${name}" filter. Scaling RGBA without the ` +
          "premultiply pair puts a dark halo on every edge of the logo -- see " +
          "the comment at the top of this file. Refusing to write anything.",
      );
    }
  }
}

/**
 * One size, straight to a buffer.
 *
 * Written to a pipe rather than to the destination so an unchanged file is left
 * alone: `writeFileSync` would update the mtime on every run, which is not a
 * correctness problem but makes "did this change anything" unanswerable at a
 * glance.
 */
function scaleTo(size) {
  return ffmpeg([
    "-y",
    "-v",
    "error",
    "-i",
    MASTER,
    "-vf",
    `premultiply=inplace=1,scale=${size}:${size}:flags=lanczos,unpremultiply=inplace=1`,
    "-pix_fmt",
    "rgba",
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-c:v",
    "png",
    "-",
  ]);
}

function writeIfChanged(file, buffer) {
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (readFileSync(file).equals(buffer)) return false;
  } catch {
    // Absent, which is a write like any other.
  }
  writeFileSync(file, buffer);
  return true;
}

requireAlphaFilters();

let master;
try {
  master = readFileSync(MASTER);
} catch {
  throw new Error(`No master at ${MASTER}. That file is the one a human edits.`);
}

// Cache per size: `build/icons/256x256.png` and the two 256px copies are the
// same bytes, so scaling once and writing three times is both faster and the
// only arrangement in which they cannot differ.
const scaled = new Map();
function at(size) {
  if (!scaled.has(size)) scaled.set(size, scaleTo(size));
  return scaled.get(size);
}

const written = [];
const targets = [
  ...ICON_SET.map((size) => ({
    size,
    to: ["build", "icons", `${size}x${size}.png`],
    why: "Linux icon set",
  })),
  ...EXTRA,
];

for (const { size, to, why } of targets) {
  const file = path.join(ROOT, ...to);
  if (writeIfChanged(file, at(size))) {
    written.push(`${to.join("/")} (${size}px, ${why})`);
  }
}

process.stderr.write(
  `${targets.length} targets from ${path.relative(ROOT, MASTER).replace(/\\/g, "/")} ` +
    `(${master.length.toLocaleString()} bytes), ${scaled.size} distinct sizes.\n`,
);
if (written.length === 0) {
  process.stderr.write("  nothing changed -- the outputs were already current.\n");
} else {
  for (const line of written) process.stderr.write(`  wrote ${line}\n`);
}
