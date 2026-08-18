/**
 * The renderer's pure modules.
 *
 * Svelte components cannot be exercised here -- there is no component runner in
 * this project, and adding one would be a bigger decision than any single
 * feature warrants. So the parts of the renderer worth testing are deliberately
 * written *outside* the components: `i18n_core.ts` holds the lookup and
 * interpolation while `i18n.svelte.ts` holds only the rune, and that split is
 * what makes this file possible.
 *
 * The centrepiece is not the interpolation tests -- those are arithmetic. It is
 * `every key used by the renderer exists`, which walks the actual source and
 * resolves every `t(...)`/`tn(...)` against the catalogue. A missing message
 * degrades to the key itself, which is visible but not loud, and would
 * otherwise reach a user before it reached anyone else.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { clampToBounds, isWithinBounds, placePopover } from "../src/renderer/src/lib/floating.js";
import {
  dragFace,
  dragPlaneNormal,
  faceCentre,
  intersectPlane,
  plateScale,
  type Ray,
} from "../src/renderer/src/lib/selection_drag.js";
import { missingKeys, translate, translatePlural } from "../src/renderer/src/lib/i18n_core.js";
import { openedAge } from "../src/renderer/src/lib/recent_age.js";
import { en } from "../src/renderer/src/lib/locales/en.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(here, "..", "src", "renderer", "src");

let failures = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}`);
    failures += 1;
  }
}

function equal(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.log(`         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  check(label, ok);
}

console.log("=== Schematic AI Studio renderer unit tests ===\n");

// --- i18n_core: lookup and interpolation ----------------------------------
console.log("--- i18n lookup ---");
{
  const catalog = {
    plain: "Save",
    greet: "Hello {name}, you have {count} messages",
    "thing.one": "{count} thing",
    "thing.other": "{count} things",
  };

  equal("a plain message comes back", translate(catalog, "plain"), "Save");
  equal(
    "placeholders are filled",
    translate(catalog, "greet", { name: "Ada", count: 3 }),
    "Hello Ada, you have 3 messages",
  );
  equal(
    "a repeated placeholder is filled every time",
    translate({ x: "{a} and {a}" }, "x", { a: "one" }),
    "one and one",
  );

  // The whole design of the failure mode: loud enough to spot, quiet enough to
  // ship the rest of the screen.
  equal("a missing key returns itself", translate(catalog, "no.such.key"), "no.such.key");
  equal(
    "a missing parameter leaves its placeholder standing",
    translate(catalog, "greet", { name: "Ada" }),
    "Hello Ada, you have {count} messages",
  );
  equal(
    "a message with no params is returned untouched",
    translate({ x: "{literal}" }, "x"),
    "{literal}",
  );

  equal("one selects the singular", translatePlural(catalog, "thing", 1), "1 thing");
  equal("two selects the plural", translatePlural(catalog, "thing", 2), "2 things");
  equal("zero selects the plural", translatePlural(catalog, "thing", 0), "0 things");

  equal("missingKeys finds the gaps", missingKeys(catalog, ["plain", "nope", "gone"]), [
    "nope",
    "gone",
  ]);
  equal("...and nothing when there are none", missingKeys(catalog, ["plain"]), []);
}

// --- every key the renderer asks for exists -------------------------------
console.log("\n--- catalogue coverage ---");
{
  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
      else if (/\.(svelte|ts)$/.test(entry)) found.push(full);
    }
    return found;
  }

  /*
   * `t(` and `tn(` call sites, and every string literal in the first argument.
   *
   * Reading the argument rather than assuming `t("literal")` is what makes this
   * cover the two conditional call sites -- `t(doc.dirty ? "a" : "b")` names two
   * keys, and a test that only understood the simple form would check neither.
   */
  const CALL = /(?<![\w.])(tn?)\(\s*([^,)]*)/g;
  const LITERAL = /"([^"\n]+)"/g;

  const used = new Map<string, { key: string; plural: boolean; file: string }>();
  const files = sourceFiles(RENDERER).filter(
    (file) => !file.includes("locales") && !file.endsWith("i18n_core.ts"),
  );

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const call of text.matchAll(CALL)) {
      const plural = call[1] === "tn";
      for (const literal of call[2].matchAll(LITERAL)) {
        const key = literal[1];
        // A key, not some other string that happened to be an argument.
        // Digits are part of a key -- `selection.rotate90` is one, and a
        // pattern that stopped at letters silently skipped those call sites,
        // which is how the orphan check below first earned its keep.
        if (!/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/.test(key)) continue;
        used.set(`${key}|${plural}`, { key, plural, file: path.relative(RENDERER, file) });
      }
    }
  }

  check("the scan found call sites at all", used.size > 40);

  const wanted: string[] = [];
  for (const { key, plural } of used.values()) {
    if (plural) wanted.push(`${key}.one`, `${key}.other`);
    else wanted.push(key);
  }

  const absent = missingKeys(en, wanted);
  if (absent.length > 0) {
    console.log(`         missing from en.ts: ${absent.join(", ")}`);
  }
  check("every key the renderer asks for is in the catalogue", absent.length === 0);

  /*
   * And the other direction. An unused message is not a bug the way a missing
   * one is, but it is how a catalogue rots: strings outlive the components
   * that showed them, a translator pays to translate them, and nobody can
   * tell which ones still matter.
   *
   * This direction has to be more generous than the one above, because not
   * every key reaches `t()` as a literal, and the two shapes that do not are
   * both legitimate: a key sitting in a data table (the `{ id, key }` rows
   * the settings rail iterates) and a key assembled from a template
   * (`settings.theme.${theme}`). Counting only strict call sites here would
   * report those as unused, and a check that cries wolf gets deleted. The
   * strict set is still what the *missing* check above uses, so nothing is
   * loosened where it matters.
   */
  const asked = new Set(wanted);
  const KEY_LITERAL = /"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/g;
  const KEY_TEMPLATE = /`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*\.)\$\{/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // A key-shaped literal that *is* in the catalogue is being used as a key.
    for (const literal of text.matchAll(KEY_LITERAL)) {
      if (en[literal[1] as keyof typeof en] !== undefined) asked.add(literal[1]);
    }
    // `prefix.${…}` claims every catalogue key under that prefix.
    for (const template of text.matchAll(KEY_TEMPLATE)) {
      for (const key of Object.keys(en)) {
        if (key.startsWith(template[1])) asked.add(key);
      }
    }
  }
  const orphans = Object.keys(en).filter((key) => !asked.has(key));
  if (orphans.length > 0) {
    console.log(`         unused in en.ts: ${orphans.join(", ")}`);
  }
  check("no message sits in the catalogue unused", orphans.length === 0);
}

// --- keeping the floating tool window reachable ---------------------------
console.log("\n--- floating panel bounds ---");
{
  // A 232px panel in an 800x600 pane, keeping 24px reachable.
  const bounds = { paneWidth: 800, paneHeight: 600, panelWidth: 232, margin: 24 };

  equal("a position already inside is left alone", clampToBounds({ x: 100, y: 80 }, bounds), {
    x: 100,
    y: 80,
  });
  check("...and reported as within", isWithinBounds({ x: 100, y: 80 }, bounds));

  // Dragged off the bottom-right: a corner has to stay grabbable.
  equal("the right edge stops with a margin showing", clampToBounds({ x: 5000, y: 80 }, bounds), {
    x: 776,
    y: 80,
  });
  equal("...and so does the bottom", clampToBounds({ x: 100, y: 5000 }, bounds), {
    x: 100,
    y: 576,
  });

  /*
   * The two edges are deliberately not symmetrical, and this is the pair of
   * cases that says why. Off the left, the panel may hang out until only a
   * sliver of its right edge shows -- the title bar runs its whole width, so a
   * sliver is still something to grab. Off the top it may not go at all,
   * because the first thing to disappear upwards is that title bar, and a panel
   * dragged up by its own height could never be dragged back.
   */
  equal("off the left, a sliver stays", clampToBounds({ x: -5000, y: 80 }, bounds), {
    x: 24 - 232,
    y: 80,
  });
  equal("off the top, nothing goes above zero", clampToBounds({ x: 100, y: -5000 }, bounds), {
    x: 100,
    y: 0,
  });

  // The case the ResizeObserver exists for: the pane shrinks under a panel
  // parked in the far corner. This is the decision it makes; its trigger runs
  // in the rendering steps and cannot be driven from a hidden page.
  const parked = { x: 776, y: 576 };
  const shrunk = { paneWidth: 133, paneHeight: 396, panelWidth: 232, margin: 24 };
  check("a parked panel falls outside a shrunken pane", !isWithinBounds(parked, shrunk));
  equal("...and is pulled back to the new corner", clampToBounds(parked, shrunk), {
    x: 109,
    y: 372,
  });

  // A pane narrower than the margin must not produce a negative maximum.
  equal("a pane narrower than the margin still clamps to zero", clampToBounds({ x: 500, y: 500 }, {
    paneWidth: 10,
    paneHeight: 10,
    panelWidth: 232,
    margin: 24,
  }), { x: 0, y: 0 });

  equal("fractional positions are rounded", clampToBounds({ x: 10.4, y: 10.6 }, bounds), {
    x: 10,
    y: 11,
  });
}

// --- putting a popover somewhere it can be seen ---------------------------
console.log("\n--- popover placement ---");
{
  /*
   * The window and the control that produced the bug: a 1440x900 window, the
   * model picker at the right-hand end of the chat composer, which is itself at
   * the bottom of the right-hand panel. Laid out from the control's left edge
   * -- the obvious way, and what the CSS did -- a 340px popover reaches
   * x=1590 in a 1440px window, and a good half of it is off the screen.
   */
  const trigger = { left: 1250, top: 820, width: 120, height: 22 };
  const window1440 = {
    viewportWidth: 1440,
    viewportHeight: 900,
    popoverWidth: 340,
    popoverHeight: 260,
    margin: 8,
    gap: 6,
  };

  const placed = placePopover(trigger, window1440);
  equal("it hangs to the left of the control that opened it", placed, { x: 1030, y: 554 });
  check(
    "...and clears it rather than covering it",
    placed.y + window1440.popoverHeight <= trigger.top,
  );

  /*
   * The property the bug violated, over every place the control could be
   * rather than the one it is: all of the popover is on screen. Stated as a
   * sweep because a single position proves nothing here -- with the preference
   * the picker had, the popover is inside the window for most anchors and
   * outside it only near the edge the picker actually sits at.
   */
  {
    let worst: { x: number; y: number; at: number } | null = null;
    for (let left = 0; left <= 1440; left += 40) {
      for (const top of [0, 430, 878]) {
        const at = placePopover({ ...trigger, left, top }, window1440);
        const inside =
          at.x >= window1440.margin &&
          at.y >= window1440.margin &&
          at.x + window1440.popoverWidth <= window1440.viewportWidth - window1440.margin &&
          at.y + window1440.popoverHeight <= window1440.viewportHeight - window1440.margin;
        if (!inside && worst === null) worst = { x: at.x, y: at.y, at: left };
      }
    }
    check(
      "wherever the control is, all of the popover is on screen",
      worst === null,
      worst === null ? "" : `anchor at x=${worst.at} placed it at ${worst.x},${worst.y}`,
    );
  }

  // Narrow enough that the preferred position does not fit either: the clamp,
  // not the preference, is what keeps it on screen.
  const narrow = placePopover(trigger, { ...window1440, viewportWidth: 420 });
  equal("a window too narrow for the preference pins it to the far margin", narrow.x, 72);

  /*
   * Upwards is the preference because the composer is at the bottom. A control
   * near the *top* of the window has no room above it, and a popover that
   * insisted would be clamped to the top margin and cover the control it
   * belongs to -- so it goes below instead.
   */
  const high = placePopover({ ...trigger, top: 100 }, window1440);
  equal("with no room above, it opens downwards", high.y, 128);
  check("...still below the control", high.y >= 100 + trigger.height);

  // Bigger than the window in both directions. Something has to give; what
  // gives is the far edge, because these panels are read from the top down.
  const cramped = placePopover(trigger, {
    ...window1440,
    viewportWidth: 300,
    viewportHeight: 200,
  });
  equal("a popover larger than the window keeps its near corner", cramped, { x: 8, y: 8 });

  // Element rects are fractional; CSS pixels here should not be.
  equal(
    "a fractional anchor gives whole pixels",
    placePopover({ left: 1250.4, top: 820.5, width: 120.2, height: 22 }, window1440),
    { x: 1031, y: 555 },
  );
}

// --- dragging a face of the selection box ---------------------------------
console.log("\n--- selection face drag ---");
{
  // A 4x4x4 box in the middle of a 32-cube document.
  const region = { minX: 10, minY: 10, minZ: 10, maxX: 13, maxY: 13, maxZ: 13 };

  /** A ray straight down -Z from above the far side, as an orbit camera gives. */
  const rayAt = (x: number): Ray => ({
    origin: { x, y: 12, z: 60 },
    direction: { x: 0, y: 0, z: -1 },
  });
  // Looking down -Z, so the X axis is fully across the view: the best drag
  // plane for X is the one facing the camera.
  const view = { x: 0, y: 0, z: -1 };

  equal(
    "the plane for X drops the X component of the view",
    dragPlaneNormal("x", { x: 0.6, y: 0, z: -0.8 }),
    { x: 0, y: 0, z: -1 },
  );
  equal("an axis pointed at the camera has no usable plane", dragPlaneNormal("z", view), null);

  equal("a face centre sits on the near edge for min", faceCentre(region, "x", "min").x, 10);
  equal("...and past the far cell for max", faceCentre(region, "x", "max").x, 14);

  equal(
    "a ray parallel to the plane misses it",
    intersectPlane({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
      { x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 1 }),
    null,
  );
  equal(
    "a plane behind the ray is not a hit",
    intersectPlane({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } },
      { x: 0, y: 0, z: -5 }, { x: 0, y: 0, z: 1 }),
    null,
  );

  const dragX = (x: number, side: "min" | "max") =>
    dragFace({ region, axis: "x", side, ray: rayAt(x), view });

  equal("dragging the max face out grows the box", dragX(20.2, "max")?.maxX, 19);
  equal("dragging the max face in shrinks it", dragX(12.4, "max")?.maxX, 11);
  equal("dragging the min face out grows the box", dragX(4.6, "min")?.minX, 5);
  equal("the untouched face does not move", dragX(20.2, "max")?.minX, 10);

  /*
   * The two clamps. A face pushed past its partner stops at one block thick
   * rather than swapping the two: an inverted box would leave every subsequent
   * fill acting on a region the user is no longer looking at.
   */
  equal("max cannot be pushed below min", dragX(-100, "max")?.maxX, 10);
  equal("min cannot be pushed above max", dragX(500, "min")?.minX, 13);
  check("...and the box stays at least one block thick", (dragX(-100, "max")?.maxX ?? -1) >= region.minX);

  /*
   * The document is *not* a limit. A face may be dragged out past the edge --
   * that is where the next thing is going to be built -- and filling the region
   * grows the schematic to contain it, with saving trimming the air back off.
   * Only the sanity bound applies, and only to keep a near-parallel ray from
   * reporting a selection in the millions.
   */
  equal("a face may be dragged past the far edge", dragX(500.2, "max")?.maxX, 499);
  equal("...and below the origin", dragX(-40.4, "min")?.minX, -40);
  check(
    "a runaway ray still stops somewhere sane",
    (dragX(1e9, "max")?.maxX ?? 0) === 100_000,
  );

  /*
   * The plate mapping, on a deliberately oblong box so a transposition shows.
   * On a cube every answer is the same number and the bug is invisible, which
   * is exactly how the X face shipped wrong the first time.
   */
  const size = { x: 2, y: 3, z: 5 };
  equal("the X plate takes its width from Z and height from Y", plateScale("x", size), {
    width: 5,
    height: 3,
  });
  equal("the Y plate takes X and Z", plateScale("y", size), { width: 2, height: 5 });
  equal("the Z plate takes X and Y", plateScale("z", size), { width: 2, height: 3 });

  equal(
    "an unusable drag plane changes nothing",
    dragFace({ region, axis: "z", side: "max", ray: rayAt(12), view }),
    null,
  );
  equal(
    "a ray that misses the plane changes nothing",
    dragFace({
      region,
      axis: "x",
      side: "max",
      ray: { origin: { x: 12, y: 12, z: 60 }, direction: { x: 0, y: 0, z: 1 } },
      view,
    }),
    null,
  );
}

// --- how long ago a schematic was opened ----------------------------------
console.log("\n--- recent document age ---");
{
  const NOW = 1_700_000_000_000;
  const ago = (ms: number) => openedAge(NOW - ms, NOW);
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  equal("no timestamp is no date", openedAge(0, NOW), { kind: "none" });
  equal("...and neither is a negative one", openedAge(-1, NOW), { kind: "none" });

  equal("this second is just now", ago(0), { kind: "justNow" });
  equal("...and so is 59 seconds", ago(59_000), { kind: "justNow" });

  // Each boundary, from both sides. Five thresholds, five chances to be off by
  // one, and a label that is only ever wrong by a little is a label nobody
  // notices is wrong.
  equal("one minute becomes minutes", ago(MINUTE), { kind: "minutes", count: 1 });
  equal("59 minutes is still minutes", ago(59 * MINUTE), { kind: "minutes", count: 59 });
  equal("one hour becomes hours", ago(HOUR), { kind: "hours", count: 1 });
  equal("23 hours is still hours", ago(23 * HOUR), { kind: "hours", count: 23 });
  equal("one day becomes days", ago(DAY), { kind: "days", count: 1 });
  equal("six days is still days", ago(6 * DAY), { kind: "days", count: 6 });
  equal("a week becomes a date", ago(7 * DAY), { kind: "date" });
  equal("...and so does a year", ago(365 * DAY), { kind: "date" });

  // A clock that moved backwards -- a timezone change, an NTP correction --
  // leaves a stamp in the future. "Just now" is the honest reading of a moment
  // that has not happened yet; a negative count would not be.
  equal("a future timestamp reads as just now", openedAge(NOW + DAY, NOW), { kind: "justNow" });
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
