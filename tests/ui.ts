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

import {
  clampPanelSize,
  clampToBounds,
  isWithinBounds,
  placePopover,
} from "../src/renderer/src/lib/floating.js";
import { PANEL_SIZE } from "../src/shared/settings.js";
import { facingNormal, hoverSource, outlineCentre } from "../src/renderer/src/lib/block_hover.js";
import {
  blockLabel,
  gridWindow,
  inventoryBlocks,
  OVERSCAN_ROWS,
} from "../src/renderer/src/lib/inventory.js";
import {
  emptyTimeline,
  recordDocumentEdit,
  recordSelection,
  redoTarget,
  takeRedo,
  takeUndo,
  undoTarget,
  type SelectionState,
} from "../src/renderer/src/lib/selection_history.js";
import {
  cellFade,
  cellUnderRay,
  isInsideBox,
  cellRegion,
  placementNeeds,
  regionBetween,
  visibleCells,
  MAX_GRID_REACH,
} from "../src/renderer/src/lib/build_grid.js";
import {
  clickIntent,
  dragFace,
  moveDestination,
  movedRegion,
  dragPlaneNormal,
  faceCentre,
  intersectPlane,
  plateScale,
  type Ray,
} from "../src/renderer/src/lib/selection_drag.js";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

import { toSafeHtml } from "../src/renderer/src/lib/markdown.js";
import { isSafeHref } from "../src/renderer/src/lib/markdown_policy.js";
import { HOSTILE_CASES } from "./markdown_cases.js";
import { missingKeys, translate, translatePlural } from "../src/renderer/src/lib/i18n_core.js";
import { openedAge } from "../src/renderer/src/lib/recent_age.js";
import { DEFAULT_PREVIEW_SETTINGS, PREVIEW_SETTING_RANGES } from "../src/shared/settings.js";
import { COPLANAR_OFFSET, depthEpsilon, GRID_SIZE } from "../src/renderer/src/lib/depth.js";
import {
  dotColor,
  dotFor,
  maskToken,
  showsIndicator,
} from "../src/renderer/src/lib/mcp_status.js";
import { bridgeCommand, connectCommand } from "../src/shared/mcp.js";
import type { McpStatus } from "../src/shared/ipc.js";
import { normalizeTicks, skyAt, skyDistance } from "../src/renderer/src/lib/sky.js";
import { fitShadow } from "../src/renderer/src/lib/shadow_fit.js";
import { anchorKey, mirrorAnchor } from "../src/renderer/src/lib/anchor_draft.js";
import {
  isSpuriousLook,
  LOCK_SETTLE_MS,
  MAX_LOOK_STEP,
} from "../src/renderer/src/lib/look_filter.js";
import { en } from "../src/renderer/src/lib/locales/en.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(here, "..", "src", "renderer", "src");

let failures = 0;

/**
 * `detail` is printed only on failure, and only when there is something to say.
 *
 * It exists because this file used not to be typechecked -- `tsconfig.node.json`
 * covers `src/**` and not `tests/**` -- so an extra argument passed to a
 * two-parameter function was silently dropped rather than refused, which is
 * exactly what had been happening here. `tsconfig.tests.json` closed that; the
 * parameter stays because the call sites want it.
 */
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}`);
    if (detail !== undefined && detail !== "") console.log(`         ${detail}`);
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

  /*
   * A plural message may only ask for `{count}`.
   *
   * `translatePlural` supplies exactly that one name, and no `tn(...)` call site
   * passes anything else. A placeholder it does not fill is not an error and not
   * blank -- it renders as itself, so the user reads a literal `{n}` in the
   * middle of a sentence. That shipped once: `mcp.clients` was written with
   * `{n}` and the settings pane said "{n} client connected".
   *
   * Narrow on purpose. If a plural message ever legitimately needs a second
   * parameter, this is where to say so deliberately rather than a rule to work
   * around silently.
   */
  const PLACEHOLDER = /\{(\w+)\}/g;
  const wrongPlaceholders: string[] = [];
  for (const [key, message] of Object.entries(en)) {
    if (!key.endsWith(".one") && !key.endsWith(".other")) continue;
    for (const found of String(message).matchAll(PLACEHOLDER)) {
      if (found[1] !== "count") wrongPlaceholders.push(`${key}: {${found[1]}}`);
    }
  }
  equal("a plural message only asks for {count}", wrongPlaceholders, []);

  /*
   * And every *singular* form that has a plural sibling names no number at all.
   *
   * "1 client connected" rather than "{count} client connected": the count is
   * known to be one, and spelling it is what makes the two forms read as one
   * sentence rather than as a template.
   */
  const chattySingulars = Object.entries(en)
    .filter(([key, message]) => key.endsWith(".one") && String(message).includes("{count}"))
    .map(([key]) => key);
  equal("a singular form spells its one out", chattySingulars, []);
}

// --- keeping the floating tool window reachable ---------------------------
console.log("\n--- floating panel bounds ---");
{
  // A 232px panel in an 800x600 pane, keeping 24px reachable.
  const bounds = { paneWidth: 800, paneHeight: 600, panelWidth: 232, panelHeight: 420, margin: 24 };

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
  const shrunk = { paneWidth: 133, paneHeight: 396, panelWidth: 232, panelHeight: 300, margin: 24 };
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
    panelHeight: 160,
    margin: 24,
  }), { x: 0, y: 0 });

  equal("fractional positions are rounded", clampToBounds({ x: 10.4, y: 10.6 }, bounds), {
    x: 10,
    y: 11,
  });

  /*
   * `panelHeight` joined `panelWidth` when these panels became resizable, and
   * it changes exactly one rule: a panel *taller than the pane* may go above
   * zero, far enough to bring its bottom edge -- and the resize corner that
   * lives there -- back into reach. Without it such a panel is pinned at the
   * top with no way to make itself smaller, which is a window you cannot
   * recover from.
   */
  const tall = { paneWidth: 800, paneHeight: 300, panelWidth: 232, panelHeight: 500, margin: 24 };
  equal("a panel taller than the pane may hang off the top", clampToBounds({ x: 40, y: -5000 }, tall), {
    x: 40,
    y: -200,
  });
  equal("...and no further than its bottom edge", clampToBounds({ x: 40, y: -180 }, tall), {
    x: 40,
    y: -180,
  });
  // One that fits keeps the old rule exactly: the title bar never leaves.
  equal("a panel that fits still cannot go above zero", clampToBounds({ x: 40, y: -5000 }, bounds), {
    x: 40,
    y: 0,
  });
}

// --- how big a floating panel may be ---------------------------------------
//
// The tool window was a hard-coded 232px. That is what sent the version
// history off to a modal, and what left the inspector rendering
// `Items[0].tag.display.Name` in a column narrower than the path.
console.log("\n--- floating panel size ---");
{
  const pane = { width: 900, height: 700 };

  equal("a size that fits is kept", clampPanelSize({ width: 400, height: 300 }, pane), {
    width: 400,
    height: 300,
  });

  // The minimum exists because a panel dragged to nothing cannot be dragged
  // back: the corner that resizes it would have no room to exist in.
  equal("...and one dragged to nothing stops at the minimum", clampPanelSize({ width: 0, height: 0 }, pane), {
    width: PANEL_SIZE.minWidth,
    height: PANEL_SIZE.minHeight,
  });

  // The maximum is the pane, because these hover over the thing they edit.
  equal("a panel cannot outgrow its pane", clampPanelSize({ width: 5000, height: 5000 }, pane), {
    width: 900,
    height: 700,
  });

  /*
   * The order of the two clamps, which is the part worth pinning. In a pane
   * smaller than the minimum, taking the pane last would collapse the panel to
   * something with no resize corner and no way out. Taking the minimum last
   * overflows instead: an unusable window you can see and drag beats a usable
   * one you cannot reach.
   */
  equal("a pane smaller than the minimum overflows rather than collapsing", clampPanelSize(
    { width: 300, height: 300 },
    { width: 100, height: 100 },
  ), { width: PANEL_SIZE.minWidth, height: PANEL_SIZE.minHeight });

  equal("fractional sizes are rounded", clampPanelSize({ width: 400.4, height: 300.6 }, pane), {
    width: 400,
    height: 301,
  });
}

// --- the chat's markdown, and what it must not let through -----------------
console.log("\n--- markdown rendering ---");
{
  /*
   * The real sanitiser, against a real DOM. Checking the configuration object
   * would only prove I wrote the allowlist I meant to write -- not that the
   * allowlist holds. jsdom is a devDependency for exactly this: it never
   * reaches the bundle, and without it this whole block would be a table
   * inspecting itself.
   */
  const window = new JSDOM("").window;
  const purify = createDOMPurify(window as unknown as Window & typeof globalThis);
  const render = (source: string): string => toSafeHtml(source, purify);

  // The thing the user actually reported.
  {
    const html = render("| Block | Count |\n|:------|------:|\n| stone | 12 |");
    check("a pipe table becomes a table", html.includes("<table"), html);
    check("...with a header row", html.includes("<th"), html);
    check("...and the alignment survives", html.includes('align="right"'), html);
  }

  equal(
    "a fenced block keeps its text verbatim",
    render("```\na | b\n```").includes("a | b"),
    true,
  );
  check("...inside a pre", render("```js\nlet x = 1;\n```").includes("<pre"));
  check("a nested list nests", render("- a\n  - b").split("<ul").length - 1 === 2);
  check("a heading is a heading", render("## Title").includes("<h2"));
  check("bold is bold", render("**yes**").includes("<strong>"));

  /*
   * Block ids are full of underscores, and this app says `minecraft:oak_log`
   * more than it says anything else. GFM only opens emphasis at a word
   * boundary, so this holds -- but it is the single most likely thing to break
   * on a parser change, and it would break quietly, as missing text.
   */
  {
    const html = render("place minecraft:oak_log and quartz_block_top here");
    check("intra-word underscores are not emphasis", !html.includes("<em>"), html);
    check("...and the id survives whole", html.includes("minecraft:oak_log"), html);
  }

  // A link that is fine gets sent to the system browser, not followed in-app.
  {
    const html = render("[docs](https://example.com/x)");
    check("a good link keeps its href", html.includes('href="https://example.com/x"'), html);
    check("...opens outside the app", html.includes('target="_blank"'), html);
    check("...and cannot reach back through window.opener", html.includes("noopener"), html);
  }

  // The hook is added per purifier, not per message: DOMPurify *appends*
  // hooks, so re-registering would stack a duplicate on every single turn.
  {
    const before = render("[a](https://example.com)");
    for (let i = 0; i < 5; i += 1) render("[a](https://example.com)");
    equal("rendering repeatedly does not change the output", render("[a](https://example.com)"), before);
    equal(
      "...and the rel is written once",
      (render("[a](https://example.com)").match(/noopener/g) ?? []).length,
      1,
    );
  }

  // An image cannot load under this CSP, so it becomes something readable
  // rather than a broken icon or -- worse -- nothing at all.
  {
    const html = render("![a diagram](https://example.com/x.png)");
    check("an image becomes a link", html.includes("<a "), html);
    check("...and keeps its alt text", html.includes("a diagram"), html);
    check("...with no img tag left", !html.includes("<img"), html);
  }

  // The list itself.
  for (const hostile of HOSTILE_CASES) {
    const html = render(hostile.source).toLowerCase();
    const leaked = hostile.mustNotContain.filter((needle) => html.includes(needle.toLowerCase()));
    check(`${hostile.name} is neutralised`, leaked.length === 0, `leaked ${JSON.stringify(leaked)} in ${html}`);

    const lost = (hostile.mustContain ?? []).filter(
      (needle) => !html.includes(needle.toLowerCase()),
    );
    if ((hostile.mustContain ?? []).length > 0) {
      check(`...without losing the text`, lost.length === 0, `lost ${JSON.stringify(lost)} in ${html}`);
    }
  }
}

// --- which hrefs may survive ----------------------------------------------
console.log("\n--- link schemes ---");
{
  check("https is fine", isSafeHref("https://example.com"));
  check("http is fine", isSafeHref("http://example.com"));
  check("...case does not matter", isSafeHref("HTTPS://EXAMPLE.COM"));

  check("javascript is not", !isSafeHref("javascript:alert(1)"));
  check("data is not", !isSafeHref("data:text/html,<script>alert(1)</script>"));
  check("a bare mailto is not", !isSafeHref("mailto:someone@example.com"));
  check("a relative path is not", !isSafeHref("/etc/passwd"));
  check("an empty href is not", !isSafeHref(""));

  /*
   * The reason this function strips before it tests. A browser ignores ASCII
   * control characters and whitespace while parsing a URL, so every one of
   * these navigates -- and every one of them fails a naive `startsWith`.
   */
  check("a scheme split by a tab is still javascript", !isSafeHref("java\tscript:alert(1)"));
  check("...by a newline too", !isSafeHref("java\nscript:alert(1)"));
  check("...and leading whitespace does not launder it", !isSafeHref("  javascript:alert(1)"));
  check("...nor a leading NUL", !isSafeHref(" javascript:alert(1)"));

  // The other half of that: stripping must not eat the good ones.
  check("a real URL survives the stripping", isSafeHref(" https://example.com "));
  check("...including its own path and query", isSafeHref("https://example.com/a b?c=d"));
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

// --- what a stationary click means -----------------------------------------
//
// The rule that broke. Selecting became a Shift gesture so a plain *drag*
// would belong to the camera, and the click was taken along with it -- which
// quietly removed the block inspector, because asking what a block is had
// never been anything but a click. It was in an event handler, where a rule
// cannot be read, which is why it is here now.
console.log("\n--- click intent ---");
{
  const click = (hit: boolean, shift = false, ctrl = false) => clickIntent({ hit, shift, ctrl });

  equal("a plain click on a block asks what it is", click(true), "pick");
  equal("...and so does a Shift-click, which also selects it", click(true, true), "pick");
  equal("Ctrl grows the selection, behind Shift", click(true, true, true), "extend");
  // Ctrl without Shift is not the extend gesture: extending is a selection
  // gesture and every one of those takes Shift.
  equal("Ctrl alone is still a plain pick", click(true, false, true), "pick");

  // The asymmetry on a miss, which is the whole of the second half of the rule.
  equal("Shift-clicking past the structure clears the selection", click(false, true), "clear");
  equal(
    "...but a plain click past it does nothing, because that is the usual accident",
    click(false),
    "ignore",
  );
}

// --- moving a region --------------------------------------------------------
//
// The region's min corner follows the cursor, which is the rule paste already
// uses. Keeping a grab point under the cursor would read better for a box you
// pressed on, and this gesture does not start with a press on the box: it
// starts from a button, so there is no grab point to keep.
console.log("\n--- moving a region ---");
{
  const region = { minX: 4, minY: 2, minZ: 6, maxX: 7, maxY: 3, maxZ: 6 };

  equal("the corner goes where the pointer is", moveDestination({ x: 10, y: 1, z: 2 }), {
    x: 10,
    y: 1,
    z: 2,
  });
  /*
   * The grid has nothing below the origin. Moving "down past zero" cannot mean
   * pushing everything else up -- that is what growth-on-fill does, and doing it
   * here would move the coordinates the user is aiming at, under the pointer,
   * mid-gesture.
   */
  equal("below the origin it stops at the origin", moveDestination({ x: -3, y: -1, z: 0 }), {
    x: 0,
    y: 0,
    z: 0,
  });

  equal("the moved box keeps its size", movedRegion(region, { x: 0, y: 0, z: 0 }), {
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 3,
    maxY: 1,
    maxZ: 0,
  });
  equal(
    "...and a move to where it already is changes nothing",
    movedRegion(region, { x: region.minX, y: region.minY, z: region.minZ }),
    region,
  );
}

// --- the camera's own input -------------------------------------------------
//
// In Creative flight the camera is driven by movementX/movementY from
// pointer-locked mousemove events, and those are not always a mouse. Chromium
// delivers a spurious one the instant the lock is acquired, carrying the
// distance from wherever the cursor was to where it was warped -- which is the
// "the view snaps somewhere at random" report.
console.log("\n--- look filter ---");
{
  const look = (movementX: number, movementY: number, sinceLock: number): boolean =>
    isSpuriousLook({ movementX, movementY, sinceLock });

  check("an ordinary movement is the user's", !look(12, -7, 1000));
  check("...however fast, within reason", !look(MAX_LOOK_STEP, -MAX_LOOK_STEP, 1000));

  // The click that entered flight must not also spin the camera.
  check("everything in the first instants after the lock is discarded", look(1, 0, 0));
  check("...including a movement that would otherwise be fine", look(3, 3, LOCK_SETTLE_MS - 1));
  check("...and it stops being discarded once settled", !look(3, 3, LOCK_SETTLE_MS));

  // And the general case: no wrist produces this between two frames.
  check("a jump larger than any hand is discarded", look(MAX_LOOK_STEP + 1, 0, 5000));
  check("...on either axis", look(0, -(MAX_LOOK_STEP + 1), 5000));
}

// --- the sky through a day --------------------------------------------------
//
// Curves through a 24000-tick day, every one of them with boundaries where it
// is easy to be a whole phase out, and none of it observable from a component
// that owns a WebGL context.
console.log("\n--- sky ---");
{
  const dawn = skyAt(0);
  const noon = skyAt(6000);
  const dusk = skyAt(12000);
  const midnight = skyAt(18000);

  // The sun rises in the east (+X), is overhead at noon, sets in the west.
  check("at dawn the sun is on the eastern horizon", dawn.sunDirection[0] > 0.99);
  check("at noon it is overhead", noon.sunDirection[1] > 0.99);
  check("at dusk it is west", dusk.sunDirection[0] < -0.99);
  check("at midnight it is under the world", midnight.sunDirection[1] < -0.99);
  check("the moon is always opposite", Math.abs(noon.moonDirection[1] + 1) < 1e-6);

  check("noon is day", !noon.night);
  check("midnight is not", midnight.night);

  /*
   * The floor is what makes this usable. Sky light at night in the game is
   * dim, and an editor that went black at 18000 would be a setting nobody
   * could turn on -- "you cannot see what you are working on" is a bug however
   * faithful it is.
   */
  check("full daylight at noon", noon.daylight === 1);
  check("...dimmed at midnight", midnight.daylight < 0.5);
  check("...but never dark", midnight.daylight > 0);

  check("stars are out at midnight", midnight.starOpacity > 0.9);
  check("...and gone at noon", noon.starOpacity === 0);

  // Dusk is orange, and noon is not.
  check("the horizon warms at dusk", dusk.horizon[0] > dusk.horizon[2]);
  check("...and is blue at noon", noon.horizon[2] > noon.horizon[0]);

  // The moon lights far less than the sun, which is what keeps night readable
  // without pretending it is daytime.
  check("the moon is weaker than the sun", midnight.lightIntensity < noon.lightIntensity);
  check("...but not nothing", midnight.lightIntensity > 0);

  /*
   * The dome has to be inside the frustum, and this is the check that would
   * have caught a black sky.
   *
   * It was a sphere of radius 3000 while the draw-distance setting defaults to
   * 512: every vertex outside the far plane, clipped, nothing drawn, and the
   * viewport showing the renderer's clear colour. Every draw distance the
   * slider offers has to work, which is why this is a function and not a
   * constant.
   */
  for (const far of [
    PREVIEW_SETTING_RANGES.maxDrawDistance.min,
    512,
    PREVIEW_SETTING_RANGES.maxDrawDistance.max,
  ]) {
    const distance = skyDistance(0.1, far);
    check(`the sky is nearer than the far plane at ${far}`, distance < far, String(distance));
    check(`...and further than the near plane at ${far}`, distance > 0.1, String(distance));
  }
  // A frustum with no room for a margin still has to put it somewhere inside.
  const pinched = skyDistance(10, 12);
  check("a pinched frustum still fits the sky in it", pinched > 10 && pinched < 12, String(pinched));
  // And nonsense planes do not produce a NaN scale, which would take the whole
  // sky out of the scene rather than merely misplace it.
  check("a zero far plane still answers", Number.isFinite(skyDistance(0, 0)));

  // The clock wraps, and midnight-to-dawn has no seam in it.
  equal("a day later is the same sky", skyAt(24000).daylight, dawn.daylight);
  equal("...and so is a day earlier", skyAt(-24000).daylight, dawn.daylight);
  equal("ticks wrap", normalizeTicks(-1000), 23000);

  // The azimuth turns the whole path, so a facade can be lit without inventing
  // an hour that does not exist.
  const turned = skyAt(6000, 90);
  check("turning the path leaves noon overhead", turned.sunDirection[1] > 0.99);
  const morning = skyAt(1000, 90);
  check(
    "...but moves where the low sun comes from",
    Math.abs(morning.sunDirection[2]) > Math.abs(skyAt(1000, 0).sunDirection[2]),
  );
}

// --- where the shadow camera goes ---------------------------------------------
//
// Two properties, and the second is the one nobody thinks of. The box has to
// cover the build -- a shadow map has a fixed pixel budget, and a box sized for
// the largest possible schematic spends it all on empty air. And it has to move
// in whole texels: slide it half a texel and every receiver lands on a
// different depth sample, so the edge of every shadow shimmers as the sun
// moves. Along a straight wall, which is what a schematic is made of, that is
// the only thing you can see.
console.log("\n--- the MCP indicator ---");
{
  const listening = (over: Partial<McpStatus> = {}): McpStatus => ({
    state: "listening",
    url: "http://127.0.0.1:4571/mcp",
    token: "abcdefghijklmnop",
    clients: 0,
    calls: 0,
    message: null,
    bridge: "C:/app/resources/mcp-bridge.mjs",
    ...over,
  });

  /*
   * The whole reason this is a function of `McpStatus` and not of the setting.
   *
   * The checkbox says "on" and the server is not listening, because a second
   * copy of the app has the port. A dot derived from the setting is green over
   * nothing; this one is red, and the message beside it names the port.
   */
  equal(
    "a server that failed to start is not green",
    dotFor({ ...listening(), state: "error", url: null, message: "Port 4571 is already in use" }),
    "error",
  );
  equal("...listening with nobody connected is", dotFor(listening()), "listening");
  equal("...and a connected client is louder still", dotFor(listening({ clients: 1 })), "active");
  equal("off is off", dotFor({ ...listening(), state: "off", url: null }), "off");

  /*
   * The dangerous default. A status that has not come back must not read as
   * "listening" — green means "something outside can edit this build", and it
   * cannot appear because a question is still in flight.
   */
  equal("no answer yet is not an answer", dotFor(null), "starting");

  // Four states, four distinct tokens, all of which exist in app.css in both
  // palettes -- a dot that shares a colour with another state says nothing.
  const colors = (["off", "starting", "listening", "active", "error"] as const).map(dotColor);
  check("the states are told apart by colour", new Set(colors).size === 4, colors.join(" "));

  /*
   * Visibility. Hidden while off, so the bar is not carrying a dim dot for a
   * feature nobody switched on -- but a *listening* server is never hidden,
   * whatever the setting says, because the warning is the point.
   */
  check("hidden while the server is off", !showsIndicator(false, { ...listening(), state: "off" }));
  check("...shown once it is enabled", showsIndicator(true, null));
  check(
    "...and never hidden while something is listening",
    showsIndicator(false, listening()),
  );

  // The token is shown at all -- a deliberate exception to "secrets stay in
  // main" -- so it is masked by default, and the tail is what lets someone tell
  // which token they are looking at without revealing it.
  const masked = maskToken("abcdefghijklmnop");
  check("a masked token hides the secret", !masked.includes("abcdefghijkl"), masked);
  check("...but shows enough to recognise it", masked.endsWith("mnop"), masked);
  equal("no token, nothing to mask", maskToken(null), "");

  // The one string in this feature that has to be exactly right: a wrong flag
  // is a client that cannot connect and an error message about neither.
  const command = connectCommand("http://127.0.0.1:4571/mcp", "s3cret");
  check("the connect command names the transport", command.includes("--transport http"), command);
  check("...and carries the token as a bearer header", command.includes("Bearer s3cret"), command);

  /*
   * The stdio form quotes the path, and that is not cosmetic: the bridge ships
   * under the app's install directory, which on Windows is under "Program
   * Files". Unquoted, the command a user pastes stops at the space.
   */
  const stdio = bridgeCommand("C:/Program Files/Schematic AI Studio/resources/mcp-bridge.mjs");
  check("the bridge command quotes the path", stdio.includes('"C:/Program Files/'), stdio);
  check("...and passes it to node after the separator", stdio.includes("-- node"), stdio);
}

console.log("\n--- the floor and the grid ---");
{
  /*
   * Three surfaces share y=0: the virtual floor, the 256-block grid over it and
   * the build-grid patch under the cursor. They used to be held apart by
   * hand-picked epsilons -- -0.02, -0.01, +0.002 -- and those *are* the bug
   * rather than the fix, because a perspective depth buffer's precision is a
   * function of distance. What follows is the arithmetic that says so, and it
   * fails if anyone reaches for a constant again.
   */
  const CORNER = (GRID_SIZE / 2) * Math.SQRT2;
  const NEAR = 0.1;
  const FAR = DEFAULT_PREVIEW_SETTINGS.maxDrawDistance;

  check(
    "near the camera an epsilon looks like it works",
    depthEpsilon(NEAR, FAR, 16) < 0.002,
    String(depthEpsilon(NEAR, FAR, 16)),
  );
  check(
    "...the build grid's 0.002 is gone by 64 blocks",
    depthEpsilon(NEAR, FAR, 64) > 0.002,
    String(depthEpsilon(NEAR, FAR, 64)),
  );
  check(
    "...and the grid's 0.01 by its own far corner",
    depthEpsilon(NEAR, FAR, CORNER) > 0.01,
    String(depthEpsilon(NEAR, FAR, CORNER)),
  );
  // The corner is inside the frustum at the default draw distance, so this is
  // not a hypothetical: it is on screen whenever the floor and the grid are.
  check("...which is a place you can see", CORNER < FAR, String(CORNER));

  /*
   * Every draw distance the slider offers, at the furthest point of the grid
   * that distance can show.
   *
   * The near plane dominates the expression, so raising the far plane barely
   * moves the answer and lowering it only hides the far half of the grid. No
   * setting rescues an epsilon: at the minimum draw distance one step is
   * already thicker than the 0.002 the build grid had.
   */
  for (const far of [
    PREVIEW_SETTING_RANGES.maxDrawDistance.min,
    FAR,
    PREVIEW_SETTING_RANGES.maxDrawDistance.max,
  ]) {
    const reach = Math.min(far, CORNER);
    check(
      `an epsilon is still too thin at ${far}`,
      depthEpsilon(NEAR, far, reach) > 0.002,
      String(depthEpsilon(NEAR, far, reach)),
    );
  }

  // Positive pushes the base *away*, which is the direction that lets the lines
  // drawn on it win; a unit is one whole depth step, so one is always enough.
  check("the floor is offset away from the camera", COPLANAR_OFFSET.factor > 0);
  check("...by at least one whole depth step", COPLANAR_OFFSET.units >= 1);

  // A 16-bit depth buffer is 256 times coarser, and the same offset answers it.
  check(
    "a coarser buffer is worse, not different",
    depthEpsilon(NEAR, FAR, CORNER, 16) > depthEpsilon(NEAR, FAR, CORNER, 24),
  );
  // Nonsense planes must not produce a NaN, which would read as "no gap at all".
  check("zero planes still answer", Number.isFinite(depthEpsilon(0, 0, 100)));

  /*
   * And the viewer has to be the thing doing it. This is the check that bites
   * on a revert: the epsilons are easy to put back, they look like care, and
   * nothing else in the app would notice.
   */
  const viewer = readFileSync(path.join(RENDERER, "lib", "Viewer.svelte"), "utf8");
  check("the floor declares a polygon offset", viewer.includes("polygonOffset: true"));
  check(
    "...and nothing at y=0 is nudged apart by hand",
    !/(?:grid|groundPlane)\.position\.y\s*=/.test(viewer),
  );
}

console.log("\n--- shadow fit ---");
{
  const box = { center: { x: 32, y: 16, z: 32 }, size: { x: 64, y: 32, z: 64 } };
  const noon = fitShadow({ ...box, direction: { x: 0, y: 1, z: 0 }, mapSize: 2048 });

  check("the box covers the whole diagonal", noon.radius >= Math.hypot(64, 32, 64) / 2 - 1e-6);
  check("...and not a great deal more", noon.radius < Math.hypot(64, 32, 64));
  check("the light is above what it lights", noon.position.y > noon.target.y);
  check("the near plane is in front of it", noon.near > 0);
  check("...and the far plane past it", noon.far > noon.near + noon.radius);

  // A one-block document must not get a box smaller than the depth bias, or
  // every surface shadows itself.
  const tiny = fitShadow({
    center: { x: 0.5, y: 0.5, z: 0.5 },
    size: { x: 1, y: 1, z: 1 },
    direction: { x: 0, y: 1, z: 0 },
    mapSize: 1024,
  });
  check("a one-block document still gets a usable box", tiny.radius >= 8);

  /*
   * The camera aims at the document and stays there as the sun goes round.
   * Only the position moves, which is what keeps the shadow of a wall attached
   * to the wall.
   *
   * There is no texel snapping to check, and that is deliberate -- see the note
   * at the top of `shadow_fit.ts`. Snapping fixes crawl from a box that
   * *translates*, and this box is centred on a document that does not move.
   */
  const evening = fitShadow({ ...box, direction: { x: 0.8, y: 0.6, z: 0 }, mapSize: 2048 });
  equal("the camera keeps aiming at the document", evening.target, box.center);
  check(
    "...and only the light moves round it",
    Math.abs(evening.position.x - noon.position.x) > 1,
  );
  check(
    "the light stays the same distance out",
    Math.abs(
      Math.hypot(
        evening.position.x - box.center.x,
        evening.position.y - box.center.y,
        evening.position.z - box.center.z,
      ) -
        Math.hypot(
          noon.position.x - box.center.x,
          noon.position.y - box.center.y,
          noon.position.z - box.center.z,
        ),
    ) < 1e-6,
  );

  // A direction pointing straight along the axis the perpendicular is picked
  // from would give a zero vector, and every shadow would land at the origin.
  for (const direction of [
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 0 },
  ]) {
    const fit = fitShadow({ ...box, direction, mapSize: 1024 });
    check(
      `a light pointing (${direction.x}, ${direction.y}, ${direction.z}) still has a place`,
      Number.isFinite(fit.position.x) &&
        Number.isFinite(fit.position.y) &&
        Number.isFinite(fit.position.z) &&
        Number.isFinite(fit.target.x),
    );
  }
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

// --- the build grid --------------------------------------------------------
//
// With zero blocks there is nothing to raycast, so neither a selection nor a
// placement had a target and an empty schematic was untouchable. The grid is
// the target. The raycast itself runs from the rendering steps and cannot be
// observed in this project's browser harness, so the decision lives here and
// only the trigger stays unobservable -- the same split `selection_drag.ts`
// was written for.
console.log("\n--- build grid ---");
{
  const size = { width: 8, height: 8, length: 8 };
  const down = (x: number, z: number) => ({
    origin: { x, y: 10, z },
    direction: { x: 0, y: -1, z: 0 },
  });

  equal("a ray straight down lands on the cell under it", cellUnderRay(down(3.4, 5.7), size), {
    x: 3,
    y: 0,
    z: 5,
  });
  /*
   * `floor`, not `round`. Rounding snaps to the nearest corner, which is half a
   * block out in both axes everywhere -- and passes any test that only ever
   * points at the middle of a cell.
   */
  equal("...and at 3.9 it is still that cell, not the next", cellUnderRay(down(3.9, 0.1), size), {
    x: 3,
    y: 0,
    z: 0,
  });
  equal("a negative coordinate floors away from zero", cellUnderRay(down(-0.2, -0.2), size), {
    x: -1,
    y: 0,
    z: -1,
  });

  check("a ray parallel to the plane hits nothing", cellUnderRay({ origin: { x: 0, y: 5, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, size) === null);
  check("a ray pointing away from the plane hits nothing", cellUnderRay({ origin: { x: 0, y: 5, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, size) === null);

  /*
   * A ray grazing the plane near the horizon lands thousands of blocks out.
   * Turning that into a fill would ask for a resize nobody wanted, so it reads
   * as "not over the grid" instead.
   */
  check(
    "a graze near the horizon is refused rather than answered",
    cellUnderRay(down(MAX_GRID_REACH + 40, 0), size) === null,
  );
  check(
    "...but just inside the reach still answers",
    cellUnderRay(down(size.width - 1 + MAX_GRID_REACH - 1, 0), size) !== null,
  );

  check("a cell in the box is inside it", isInsideBox({ x: 0, y: 0, z: 0 }, size));
  check("...and the far corner is too", isInsideBox({ x: 7, y: 7, z: 7 }, size));
  check("...but one past it is not", !isInsideBox({ x: 8, y: 0, z: 0 }, size));
  check("...and neither is a negative one", !isInsideBox({ x: -1, y: 0, z: 0 }, size));

  // A click is a drag that ended where it started, and needs no special case.
  equal("a drag between two cells is the box they span", regionBetween({ x: 5, y: 0, z: 1 }, { x: 2, y: 0, z: 6 }), {
    minX: 2,
    minY: 0,
    minZ: 1,
    maxX: 5,
    maxY: 0,
    maxZ: 6,
  });
  equal("a drag that went nowhere is one cell", regionBetween({ x: 2, y: 0, z: 2 }, { x: 2, y: 0, z: 2 }), {
    minX: 2,
    minY: 0,
    minZ: 2,
    maxX: 2,
    maxY: 0,
    maxZ: 2,
  });

  equal("nothing is drawn when the pointer is off the grid", visibleCells(null, 3), []);
  equal("a radius of 2 draws a 5x5", visibleCells({ x: 0, y: 0, z: 0 }, 2).length, 25);
  equal("the centre is fully lit", cellFade({ x: 4, y: 0, z: 4 }, { x: 4, y: 0, z: 4 }, 3), 1);
  check("...and the far corner has faded out", cellFade({ x: 7, y: 0, z: 7 }, { x: 4, y: 0, z: 4 }, 3) === 0);
  check(
    "the falloff is radial, so the square corner is dimmer than the square edge",
    cellFade({ x: 6, y: 0, z: 6 }, { x: 4, y: 0, z: 4 }, 3) <
      cellFade({ x: 6, y: 0, z: 4 }, { x: 4, y: 0, z: 4 }, 3),
  );

  /*
   * Reaching past the far side is a fill's business: `domain/grow.ts` extends
   * the document in the same transaction, so growing and filling are one undo
   * step. Reaching below the origin is not the same operation -- the grid has
   * no negative coordinates, so growing that way moves the content instead, and
   * a stray drag must not trigger it.
   */
  equal("a region inside the box just fits", placementNeeds(regionBetween({ x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 2 }), size), "fits");
  equal("...past the far side asks to grow", placementNeeds(regionBetween({ x: 1, y: 0, z: 1 }, { x: 20, y: 0, z: 2 }), size), "grows");
  /*
   * Below the origin used to be "blocked", on the reasoning that growing that
   * way moves the *content* instead. The reasoning is sound; the conclusion was
   * wrong for this app, because a fill dragged under the floor has always moved
   * the content up -- so refusing the same act to a single click left the two
   * gestures disagreeing about what the editor is. One arithmetic, in `grow.ts`.
   */
  equal("...and below the origin also grows", placementNeeds(regionBetween({ x: -1, y: 0, z: 1 }, { x: 2, y: 0, z: 2 }), size), "grows");
  equal("...as does a cell below the floor", placementNeeds(cellRegion({ x: 1, y: -1, z: 1 }), size), "grows");
  equal("a single cell inside is still just a fit", placementNeeds(cellRegion({ x: 1, y: 0, z: 1 }), size), "fits");
}

// --- undo that reaches the selection ---------------------------------------
//
// Ctrl+Z used to reach only the main process, because only the main process had
// anything to undo. So dragging a face across a build, seeing it was wrong, and
// pressing Ctrl+Z undid the last *block edit* -- destroying work in answer to a
// request to undo a highlight.
//
// The rule is one sentence: a selection is undone only while no block edit has
// landed on top of it. `undoDepth` is what makes that answerable.
console.log("\n--- selection history ---");
{
  const box = (n: number) => ({ minX: n, minY: 0, minZ: 0, maxX: n, maxY: 0, maxZ: 0 });
  const at = (n: number): SelectionState => ({ selection: box(n), anchor: { x: n, y: 0, z: 0 } });
  const none: SelectionState = { selection: null, anchor: null };

  // Nothing recorded, nothing to do -- and "none" rather than a document undo
  // that main would refuse.
  equal("an empty timeline with a clean document has nothing to undo", undoTarget(emptyTimeline(), 0, false), "none");
  equal("...but defers to the document when it has something", undoTarget(emptyTimeline(), 3, true), "document");

  // A selection made since the last block edit comes back first.
  let timeline = recordSelection(emptyTimeline(), 0, none, at(1));
  equal("a fresh selection is the thing to undo", undoTarget(timeline, 0, true), "selection");

  /*
   * ...and a block edit on top of it buries it. This is the whole feature: the
   * selection is still on the stack, but the last thing that happened was the
   * fill, so that is what Ctrl+Z takes.
   */
  timeline = recordDocumentEdit(timeline, 1);
  equal("a block edit on top takes precedence", undoTarget(timeline, 1, true), "document");
  // Undoing it puts the depth back, and the selection surfaces again.
  equal("...and once it is undone the selection surfaces", undoTarget(timeline, 0, false), "selection");

  // Restoring walks back through the recorded states.
  let stack = recordSelection(emptyTimeline(), 0, none, at(1));
  stack = recordSelection(stack, 0, at(1), at(2));
  const first = takeUndo(stack);
  equal("undo restores what was there before the last change", first?.state.selection, box(1));
  const second = takeUndo(first!.timeline);
  equal("...and then before the one before that", second?.state.selection, null);
  equal("nothing left to take", takeUndo(second!.timeline), null);

  // Redo is the mirror, and only while the depth still matches.
  const back = takeRedo(second!.timeline);
  equal("redo puts the change back", back?.state.selection, box(1));
  equal("redo knows there is one waiting", redoTarget(second!.timeline, 0, false), "selection");

  /*
   * A new change discards the redo stack, as it does in any editor: once you
   * branch, the future you branched away from is gone.
   */
  const branched = recordSelection(second!.timeline, 0, none, at(9));
  equal("a new change drops the redo stack", branched.redo.length, 0);
  equal("...and is the thing to redo nothing of", redoTarget(branched, 0, false), "none");

  /*
   * Steps stranded above the current depth go. They belong to block edits that
   * were undone and then written over -- main has already dropped its own redo,
   * and keeping ours would offer to restore a selection into a document that
   * never had it.
   */
  let stranded = recordSelection(emptyTimeline(), 2, none, at(5));
  stranded = recordDocumentEdit(stranded, 1);
  equal("a selection above the new depth is dropped", stranded.undo.length, 0);

  /*
   * The same, reached the other way: a block edit is undone -- which lowers the
   * depth without `recordDocumentEdit` ever running -- and then a new selection
   * is made. The step recorded at the higher depth belongs to a future main has
   * already dropped, so recording must drop it too.
   */
  let afterUndo = recordSelection(emptyTimeline(), 1, none, at(4));
  afterUndo = recordSelection(afterUndo, 0, none, at(6));
  equal("recording at a lower depth strands nothing above it", afterUndo.undo.length, 1);
  equal("...and what remains is the new one", afterUndo.undo[0].after.selection, box(6));

  // A change to nothing is not a change.
  equal(
    "recording the same selection twice records once",
    recordSelection(recordSelection(emptyTimeline(), 0, none, at(1)), 0, at(1), at(1)).undo.length,
    1,
  );
}

// --- the creative inventory ------------------------------------------------
//
// Nine hundred blocks is nine hundred one-block meshes if drawn naively, and
// the panel shows about sixty. So the grid is virtualised, which means the
// visible slice has to be computed from a scroll offset -- and a scroll offset
// is not something this harness can produce, so the arithmetic lives apart from
// the component and only the scrolling stays unobservable.
console.log("\n--- creative inventory ---");
{
  const base = { count: 100, columns: 10, rowHeight: 50, viewportHeight: 200 };

  const top = gridWindow({ ...base, scrollTop: 0 });
  equal("at the top it starts at the first row", top.firstRow, 0);
  equal("...and knows how many rows there are", top.totalRows, 10);
  /*
   * Four rows fit; the overscan adds two below. Drawing exactly what fits shows
   * empty tiles for as long as an icon takes to build, which for a mesh made in
   * main is long enough to see.
   */
  equal("...drawing the visible rows plus overscan", top.lastRow, 4 + OVERSCAN_ROWS);

  const middle = gridWindow({ ...base, scrollTop: 250 });
  equal("scrolled down, it starts an overscan above the fold", middle.firstRow, 5 - OVERSCAN_ROWS);
  equal("...and the index follows the row", middle.firstIndex, (5 - OVERSCAN_ROWS) * 10);

  /*
   * Both ends clamp. A scroll offset can be negative during an elastic
   * overscroll and can exceed the content while the list is being refiltered
   * under the scroller -- neither is a state the grid should answer with a
   * negative row or an index past the end.
   */
  const above = gridWindow({ ...base, scrollTop: -400 });
  equal("an overscroll upwards still starts at zero", above.firstRow, 0);
  const past = gridWindow({ ...base, scrollTop: 99999 });
  check("...and one past the end never exceeds the row count", past.lastRow <= past.totalRows, String(past.lastRow));
  check("...nor the item count", past.lastIndex <= base.count, String(past.lastIndex));

  // A partly-filled last row must not ask for tiles that do not exist.
  const ragged = gridWindow({ count: 93, columns: 10, rowHeight: 50, viewportHeight: 1000, scrollTop: 0 });
  equal("a ragged last row stops at the real count", ragged.lastIndex, 93);
  equal("...but still gets a row of its own", ragged.totalRows, 10);

  // Zero columns is a layout that has not measured itself yet, not a division
  // by zero.
  const unmeasured = gridWindow({ count: 10, columns: 0, rowHeight: 0, viewportHeight: 0, scrollTop: 0 });
  check("an unmeasured grid answers something sane", Number.isFinite(unmeasured.totalRows) && unmeasured.totalRows > 0);

  equal("an empty query shows everything", inventoryBlocks(["a", "b"], "  "), ["a", "b"]);

  /*
   * Except air. It is a real id everywhere else -- every empty cell in the
   * document is air, and the writers and the agent both name it -- but there is
   * nothing to pick up and nothing to draw, so it showed as a permanently blank
   * tile that read as a failure to load. Air is placed by breaking a block.
   */
  equal(
    "air is not offered",
    inventoryBlocks(["minecraft:air", "minecraft:stone"], ""),
    ["minecraft:stone"],
  );
  equal(
    "...not even when searched for by name",
    inventoryBlocks(["minecraft:air", "minecraft:stone"], "air"),
    [],
  );
  check(
    "a query filters",
    inventoryBlocks(["minecraft:stone", "minecraft:oak_planks"], "oak").length === 1,
  );

  equal("a label loses its namespace and its underscores", blockLabel("minecraft:oak_planks"), "oak planks");
  equal("...and its block states", blockLabel("minecraft:oak_stairs[facing=north]"), "oak stairs");
}

// --- the anchor modal does not fight the fields ------------------------------
//
// The panel edits a value main owns, so it has to mirror it in -- and the naive
// way to do that wipes whatever is half-typed. `anchor` arrives from a
// `$derived` that builds a fresh array whenever `docState` is reassigned, which
// is after every edit anywhere in the app, so its *identity* churns constantly
// while its value sits still. Mirroring on identity means the fields snap back
// mid-edit, and Move then sends the value that was already there -- an anchor
// that will not move, and a button that looks broken.
console.log("\n--- mirroring the anchor into the fields ---");
{
  const cell: [number, number, number] = [2, 0, 2];

  equal("a first arrival fills the fields", mirrorAnchor(cell, null), ["2", "0", "2"]);

  // The one that matters: same value, different array, already mirrored.
  check(
    "the same anchor arriving again leaves them alone",
    mirrorAnchor([2, 0, 2], anchorKey(cell)) === null,
  );
  check(
    "...however many times it arrives",
    mirrorAnchor([...cell] as [number, number, number], anchorKey(cell)) === null,
  );

  equal(
    "a genuinely different anchor does fill them",
    mirrorAnchor([1, 0, 1], anchorKey(cell)),
    ["1", "0", "1"],
  );
  equal("...and one axis is enough", mirrorAnchor([2, 0, 3], anchorKey(cell)), ["2", "0", "3"]);

  // Clearing empties them; an already-empty panel is left alone.
  equal(
    "removing the anchor empties the fields",
    mirrorAnchor(null, anchorKey(cell)),
    ["", "", ""],
  );
  check("...and stays empty", mirrorAnchor(null, anchorKey(null)) === null);

  // An anchor outside the build is legal, so negatives have to survive as text.
  equal("a negative coordinate survives", mirrorAnchor([-5, 3, -7], null), ["-5", "3", "-7"]);
  // And "no anchor" is not the same key as "anchor at the corner", or deleting
  // one while the other was showing would leave the old numbers in the fields.
  check("no anchor and a zero anchor are different keys", anchorKey([0, 0, 0]) !== anchorKey(null));
}

// --- what the pointer is about to hit ---------------------------------------
//
// The block outline was flight's alone, because in flight the crosshair *is*
// the pointer. In orbit there was no answer at all: you clicked a block to
// inspect it, or Shift-clicked to select it, and nothing said which block the
// ray was on until the click had already landed. The pick was being computed
// either way -- it simply was not drawn.
//
// The rule is `hoverSource`'s and is driven here rather than in the component
// because the outline is refreshed from `requestAnimationFrame`, which the
// Browser pane here often does not run at all.
console.log("\n--- the block under the pointer ---");
{
  const base = {
    cameraMode: "orbit",
    flying: false,
    loaded: true,
    pointer: { x: 120, y: 80 },
    overHandle: false,
    dragging: false,
  } as const;

  equal("orbit casts from the pointer", hoverSource(base), {
    kind: "pointer",
    x: 120,
    y: 80,
  });

  // Flight keeps the crosshair it always had, and only once the canvas holds
  // the pointer: before the lock, the click means "capture", not "build here".
  equal(
    "flight casts from the crosshair",
    hoverSource({ ...base, cameraMode: "fly", flying: true }),
    { kind: "crosshair" },
  );
  equal(
    "...but not before the pointer is locked",
    hoverSource({ ...base, cameraMode: "fly", flying: false }),
    { kind: "none" },
  );

  // The pointer leaving the canvas nulls `pointerAt`, and a stale outline left
  // behind would claim the ray is still somewhere it is not.
  equal(
    "a pointer that has left the canvas outlines nothing",
    hoverSource({ ...base, pointer: null }),
    { kind: "none" },
  );

  // Nothing to raycast: the empty document, where the only thing under the
  // pointer is the build grid and the build grid is not a block.
  equal("an empty document outlines nothing", hoverSource({ ...base, loaded: false }), {
    kind: "none",
  });
  equal(
    "...in flight either",
    hoverSource({ ...base, cameraMode: "fly", flying: true, loaded: false }),
    { kind: "none" },
  );

  /*
   * The two that are easy to get wrong, and both are about promising a click
   * that does something else. Over a selection face handle the cursor has
   * already become a resize cursor and the press drags the face; during a drag
   * the face is already moving. Outlining the block underneath either would be
   * a lie about what the button does.
   */
  equal(
    "a face handle takes the hover",
    hoverSource({ ...base, overHandle: true }),
    { kind: "none" },
  );
  equal("and a face drag keeps it", hoverSource({ ...base, dragging: true }), { kind: "none" });

  // Neither of those is flight's business: there are no handles under a
  // crosshair, and a gesture in orbit must not reach across the mode switch.
  equal(
    "flight ignores both",
    hoverSource({
      ...base,
      cameraMode: "fly",
      flying: true,
      overHandle: true,
      dragging: true,
    }),
    { kind: "crosshair" },
  );

  // A cell spans [x, x+1]. Getting this wrong draws the box over the block's
  // corner, which reads as a rendering glitch rather than as arithmetic.
  equal("the outline sits at the cell's centre", outlineCentre({ x: 3, y: 0, z: -2 }), {
    x: 3.5,
    y: 0.5,
    z: -1.5,
  });
}

/*
 * Which side of a surface the block is on.
 *
 * `pickBlockAt` steps a hair inwards along `-normal`, which is right only for a
 * face struck from the front. The block material is `DoubleSide` -- it has to
 * be, because a cross and every other paper-thin element in the game is one
 * quad seen from both sides -- so a ray can arrive at a face's back, and there
 * `-normal` points back out along the line of sight.
 *
 * The azalea is where it showed. Vanilla's `template_azalea` states its lid as
 * a zero-thickness element at y=16 carrying both an `up` and a `down` face, so
 * half of the block's top surface points into the cell above. Landing on the
 * `down` one put the pick one cell up: the outline drew around air, breaking it
 * did nothing, and placing went a cell too high -- reported as "placing an
 * azalea leaves an air block above it that cannot be removed".
 */
console.log("\n--- which side of a surface the block is on ---");
{
  const down: readonly [number, number, number] = [0, -1, 0];
  const up: readonly [number, number, number] = [0, 1, 0];
  // Looking down at a lid's up face: the front, and nothing moves.
  equal("a face struck from the front is left alone", facingNormal(up, down), up);
  // The same plane's down face, struck from above: its normal runs with the
  // ray, so the block is the other way.
  equal("one struck from behind is turned to face the ray", facingNormal(down, down), up);
  // And it is the *ray* that decides, not the axis: the same face seen from
  // below is a front hit again.
  equal("...decided by the ray, not by the axis", facingNormal(down, up), down);
  // A grazing ray is still on one side or the other. Exactly perpendicular
  // cannot be hit at all, and falls to the front branch rather than flipping.
  equal("a grazing hit keeps its side", facingNormal(up, [0.999, -0.01, 0]), up);
  equal("a perpendicular one is left alone", facingNormal(up, [1, 0, 0]), up);
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
