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
import { blocksInDocument, PANEL_SIZE, voidSources } from "../src/shared/settings.js";
import {
  facingNormal,
  hoverSource,
  outlineCentre,
  pointerOnHandle,
} from "../src/renderer/src/lib/block_hover.js";
import {
  blockLabel,
  gridWindow,
  inventoryBlocks,
  OVERSCAN_ROWS,
} from "../src/renderer/src/lib/inventory.js";
import { blocksIn } from "../src/shared/block_versions.js";
import { buildLegacyIndex } from "../src/shared/legacy_ids.js";
import {
  emptyTimeline,
  recordDocumentEdit,
  recordEditSelection,
  recordSelection,
  redoTarget,
  takeEditRedo,
  takeEditUndo,
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
import {
  defaultPivot,
  dragAlongAxis,
  gizmoOrigin,
  quartersBetween,
  regionCentre,
  regionFits,
  ringAngleAt,
  scaleFromRatio,
  scaledRegion,
  transformedRegion,
} from "../src/renderer/src/lib/gizmo.js";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

import { toSafeHtml } from "../src/renderer/src/lib/markdown.js";
import { isSafeHref } from "../src/renderer/src/lib/markdown_policy.js";
import { HOSTILE_CASES } from "./markdown_cases.js";
import { missingKeys, translate, translatePlural } from "../src/renderer/src/lib/i18n_core.js";
import { openedAge } from "../src/renderer/src/lib/recent_age.js";
import { DEFAULT_PREVIEW_SETTINGS, PREVIEW_SETTING_RANGES } from "../src/shared/settings.js";
import {
  COPLANAR_OFFSET,
  depthEpsilon,
  GRID_SIZE,
  orthoDepthEpsilon,
} from "../src/renderer/src/lib/depth.js";
import {
  documentFraming,
  GRID_CELL,
  gridCentre,
  ORBIT_FOV,
  orthoBounds,
  orthoFrustumHeight,
} from "../src/renderer/src/lib/framing.js";
import {
  dotColor,
  dotFor,
  maskToken,
  showsIndicator,
} from "../src/renderer/src/lib/mcp_status.js";
import { bridgeCommand, connectCommand } from "../src/shared/mcp.js";
import type { PaletteCount, McpStatus } from "../src/shared/ipc.js";
import { normalizeTicks, skyAt, skyDistance } from "../src/renderer/src/lib/sky.js";
import { fitShadow } from "../src/renderer/src/lib/shadow_fit.js";
import { anchorKey, mirrorAnchor } from "../src/renderer/src/lib/anchor_draft.js";
import {
  isSpuriousLook,
  LOCK_SETTLE_MS,
  MAX_LOOK_STEP,
} from "../src/renderer/src/lib/look_filter.js";
import { en } from "../src/renderer/src/lib/locales/en.js";
import { propertyRows } from "../src/renderer/src/lib/inspector_rows.js";
import {
  arcBetween,
  axisAt,
  COMPASS_AXES,
  easeInOutCubic,
  flightAt,
  HANDLE_REACH,
  orbitFor,
  projectAxis,
  type Quat,
} from "../src/renderer/src/lib/compass.js";
import { FACE_VECTOR, type Face } from "../src/shared/block_orientation.js";

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

console.log("\n--- the transform gizmo ---");
{
  /*
   * The arithmetic behind the handles. Everything that draws runs from
   * `requestAnimationFrame`, which this harness does not turn, so what is
   * checked here is what a drag *decides* -- and in particular the two signs
   * that no screenshot can catch: which way a ring turns, and which way a
   * mirror reflects.
   */
  const cell = (x: number, y: number, z: number) => ({
    minX: x,
    minY: y,
    minZ: z,
    maxX: x,
    maxY: y,
    maxZ: z,
  });
  const down = (x: number, z: number) => ({
    origin: { x, y: 10, z },
    direction: { x: 0, y: -1, z: 0 },
  });

  // Where it stands.
  equal("a single cell's middle is at its own centre", regionCentre(cell(0, 0, 0)), {
    x: 0.5,
    y: 0.5,
    z: 0.5,
  });
  equal(
    "with no pivot the gizmo stands in the middle of the region",
    gizmoOrigin({ minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 1, maxZ: 3 }, null),
    { x: 2, y: 1, z: 2 },
  );
  equal(
    "...and on the pivot's own cell once one is placed",
    gizmoOrigin({ minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 1, maxZ: 3 }, { x: 7, y: 2, z: 9 }),
    { x: 7.5, y: 2.5, z: 9.5 },
  );
  equal(
    "a fresh pivot lands on the cell the middle falls in",
    defaultPivot({ minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 }),
    { x: 1, y: 1, z: 1 },
  );

  /*
   * Dragging an arrow. The answer is a difference from where the press
   * landed, which is what lets an arrow be grabbed anywhere along its length
   * without the region jumping to sit under the cursor.
   */
  const origin = { x: 0.5, y: 0.5, z: 0.5 };
  equal(
    "an arrow drag answers in whole cells",
    dragAlongAxis({ origin, axis: "x", ray: down(4.4, 0.5), view: { x: 0, y: -1, z: 0 }, grab: 0.5 }),
    4,
  );
  equal(
    "...and a drag back to where it was grabbed is zero, not a jump",
    dragAlongAxis({ origin, axis: "x", ray: down(0.5, 0.5), view: { x: 0, y: -1, z: 0 }, grab: 0.5 }),
    0,
  );
  /*
   * An axis pointed straight at the camera has no usable drag plane: the
   * region would travel the length of the schematic for one pixel. `null` is
   * "leave it alone", and the caller must not read it as zero -- doing so
   * would snap the region back to the start the moment a drag grazed that
   * angle.
   */
  equal(
    "an axis pointed at the camera refuses rather than guessing",
    dragAlongAxis({ origin, axis: "z", ray: down(0, 0), view: { x: 0, y: 0, z: 1 }, grab: 0 }),
    null,
  );

  /*
   * The ring, and the sign that matters. Main turns a region by
   * `(x, z) -> (length - 1 - z, x)`, which sends **east to south**; the ring
   * has to read the same way round or dragging clockwise would turn the build
   * anticlockwise. Stated as the four compass points rather than as one
   * predicate, so a failure names which one went wrong.
   */
  const angle = (x: number, z: number) => ringAngleAt({ origin, axis: "y", ray: down(x, z) });
  equal("the Y ring reads east as its zero", angle(4.5, 0.5), 0);
  equal("...south as a quarter turn on", angle(0.5, 4.5), Math.PI / 2);
  equal("...and west as a half turn", Math.abs(angle(-3.5, 0.5) ?? 0), Math.PI);
  check(
    "...with north on the other side of zero",
    (angle(0.5, -3.5) ?? 0) < 0,
    String(angle(0.5, -3.5)),
  );
  equal("a ring grabbed exactly at its centre has no angle", angle(0.5, 0.5), null);

  equal("east to south is one quarter turn", quartersBetween(0, Math.PI / 2), 1);
  equal("...and it wraps rather than counting past four", quartersBetween(0, 2 * Math.PI), 0);
  equal("...backwards is three, not minus one", quartersBetween(0, -Math.PI / 2), 3);
  equal("a twitch is no turn at all", quartersBetween(0, 0.2), 0);

  /*
   * Where a turn puts the region. The pivot is the whole point of this one:
   * a square turned about its own middle must not move, and a cell turned
   * about a *different* cell must swing round it. Without the second check a
   * pivot that was quietly ignored would pass.
   */
  const square = { minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 3 };
  equal(
    "a square turned about its own middle stays where it is",
    transformedRegion(square, gizmoOrigin(square, null), { kind: "rotate", axis: "y", steps: 1 }),
    square,
  );
  equal(
    "a cell two east of the pivot lands two south of it",
    transformedRegion(cell(2, 0, 0), origin, { kind: "rotate", axis: "y", steps: 1 }),
    cell(0, 0, 2),
  );
  equal(
    "...and four steps is where it started",
    transformedRegion(cell(2, 0, 0), origin, { kind: "rotate", axis: "y", steps: 0 }),
    cell(2, 0, 0),
  );
  /*
   * An oblong is the case a turn in place cannot do at all -- main refuses it
   * with `NotSquareError`, because the destination is the source. With a
   * destination it is simply a box of the other shape.
   */
  equal(
    "an oblong turns into its own transpose",
    transformedRegion(
      { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 0, maxZ: 2 },
      gizmoOrigin({ minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 0, maxZ: 2 }, null),
      { kind: "rotate", axis: "y", steps: 1 },
    ),
    { minX: 1, minY: 0, minZ: -1, maxX: 3, maxY: 0, maxZ: 3 },
  );

  /*
   * Mirroring, in continuous coordinates rather than on the inclusive index.
   * Cell 2 spans [2, 3); reflected about 0.5 that is (-2, -1], which is cell
   * -2. Doing it on `maxX` directly is off by one, and only on regions of
   * even width -- the half of the cases a hand-picked example misses.
   */
  equal(
    "a mirror reflects the cell, not its index",
    transformedRegion(cell(2, 0, 0), origin, { kind: "mirror", axis: "x" }),
    cell(-2, 0, 0),
  );
  equal(
    "...and an even-width region keeps its width",
    transformedRegion({ minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 0, maxZ: 0 }, origin, {
      kind: "mirror",
      axis: "x",
    }),
    { minX: -3, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
  );
  equal(
    "mirroring twice is where it started",
    transformedRegion(
      transformedRegion(cell(2, 0, 0), origin, { kind: "mirror", axis: "y" }),
      origin,
      { kind: "mirror", axis: "y" },
    ),
    cell(2, 0, 0),
  );

  /*
   * Scaling. The dead band is deliberately wide: every ratio between 0.75 and
   * 1.5 means "I have not decided", and snapping to x2 on a twitch would make
   * a destructive edit out of a nudge.
   */
  equal("a nudge is not a scale", scaleFromRatio(1.2), null);
  equal("...nor is a small shrink", scaleFromRatio(0.9), null);
  equal("doubling is a whole factor", scaleFromRatio(2.1), { kind: "multiply", factor: 2 });
  equal("halving is its own shape", scaleFromRatio(0.5), { kind: "divide", factor: 2 });
  equal("...and never a factor of one", scaleFromRatio(0.75), { kind: "divide", factor: 2 });
  equal("a runaway ratio is capped", scaleFromRatio(500), { kind: "multiply", factor: 8 });
  equal("a ratio of nothing is refused", scaleFromRatio(0), null);

  equal(
    "doubling about the low corner grows away from it",
    scaledRegion({ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }, { x: 0, y: 0, z: 0 }, {
      kind: "multiply",
      factor: 2,
    }),
    { minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 3, maxZ: 3 },
  );
  /*
   * A thin axis divided away would leave an empty region, which nothing else
   * in the editor has an answer for. One cell is kept instead -- worse
   * arithmetic, and the only option that produces a region at all.
   */
  equal(
    "halving never divides an axis out of existence",
    scaledRegion(cell(0, 0, 0), { x: 0, y: 0, z: 0 }, { kind: "divide", factor: 2 }),
    cell(0, 0, 0),
  );

  const size = { width: 8, height: 8, length: 8 };
  check("a region inside the document fits", regionFits(cell(0, 0, 0), size));
  check("...one past the far face does not", !regionFits(cell(8, 0, 0), size));
  check("...and neither does one below the origin", !regionFits(cell(0, -1, 0), size));
}
console.log("\n--- the gizmo takes the press, and gives the camera back ---");
{
  /*
   * Pointer choreography, which this harness cannot drive: there is no canvas,
   * no camera and no render loop. Read out of the source instead, the way the
   * framing call site and the flight-mode key gate already are.
   */
  const viewer = readFileSync(path.join(RENDERER, "lib", "Viewer.svelte"), "utf8");

  /*
   * Placing a block in orbit is gone, and with it the only thing that ever
   * happened without Shift. That is what frees the plain left press for the
   * gizmo's handles -- the two halves are one change, so the absence is checked
   * rather than assumed.
   */
  check(
    "a plain orbit press no longer places a block",
    !viewer.includes("placeCandidate"),
    "placeCandidate is still in Viewer.svelte",
  );
  check(
    "...and the build grid is drawn in flight, where placing went",
    viewer.includes("gridCellAtCrosshair"),
  );

  /*
   * The one that would be silently wrong. A press on a handle that never moved
   * still ends as a click, and without `draggedThisGesture` it falls through to
   * `clickIntent` -- which picks whatever block is behind the gizmo and
   * collapses the selection the user was about to transform.
   */
  const grabAt = viewer.indexOf("const handle = selection === null ? null : gizmoAt(");
  const shiftGate = viewer.indexOf("if (!event.shiftKey) return;");
  const grab = viewer.slice(grabAt, shiftGate);
  check("the gizmo grab is found at all", grab.length > 0);
  check(
    "a handle press marks the gesture as a drag",
    grab.includes("draggedThisGesture = true"),
    "a stationary press on a handle would fall through to clickIntent",
  );
  check(
    "...and takes the left button from the camera",
    grab.includes("controls.enabled = false"),
    "LEFT is THREE.MOUSE.PAN, so the camera would pan instead",
  );
  check(
    "...without asking for Shift",
    grabAt >= 0 && shiftGate > grabAt,
    "a handle is drawn for this gesture; behind the Shift gate it would need one",
  );

  /*
   * And the release puts the camera back. Written as `cameraMode !== "fly"`
   * rather than `true`, because re-enabling OrbitControls while the pointer is
   * locked would give the flight camera a second controller.
   */
  check(
    "the release hands the button back",
    viewer.includes('if (controls) controls.enabled = cameraMode !== "fly";'),
  );

  /*
   * Rotation is offered on one axis, and that is a decision rather than an
   * omission: a quarter turn about X or Z would have to write `facing=up` on a
   * staircase, which is a state no version of the game has. Checked so that
   * "completing" the set is a deliberate act.
   */
  check(
    "only the vertical ring is built",
    viewer.includes('gizmoMode === "rotate" ? (["y"] as const)'),
    "a horizontal ring would write block states the game cannot hold",
  );

  /*
   * The ground patch yields to a handle as well. Reported as an arrow with a
   * lit cell on the floor behind it -- two indicators, one of which was about
   * to do nothing.
   */
  check(
    "the build grid asks whether the pointer is on a handle",
    viewer.includes("pointerOnHandle({"),
  );
  /*
   * And the hover is refreshed before the two things that read it. After
   * them, each would be deciding from the previous frame's answer -- which
   * on a 50ms throttle is a visible flicker as the pointer crosses a handle.
   */
  const order = (name: string) => viewer.indexOf(`${name}(performance.now())`);
  check(
    "the hover is refreshed before the outline that reads it",
    order("updateHover") >= 0 && order("updateHover") < order("updateBlockHighlight"),
  );
  check(
    "...and before the build grid",
    order("updateHover") < order("updateBuildGrid"),
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
    requiresAuth: true,
    bindAddress: "127.0.0.1",
    ...over,
  });

  /*
   * The fifth state, and the reason it outranks the other two.
   *
   * A server with no token is the most permissive thing this app can be doing,
   * and `active` would hide it at exactly the wrong moment: somebody connecting
   * is when "anybody could" stops being hypothetical. So it wins over both.
   *
   * Read from the status rather than from the setting, like everything else
   * here -- `requiresAuth` is what the listener is doing, and the checkbox is
   * only what was asked for.
   */
  equal("a listening server with no token warns", dotFor(listening({ requiresAuth: false })), "unauthenticated");
  equal(
    "...and goes on warning once a client arrives",
    dotFor(listening({ requiresAuth: false, clients: 3 })),
    "unauthenticated",
  );
  equal("a listening server that wants one does not", dotFor(listening()), "listening");
  equal("...and still says when somebody is using it", dotFor(listening({ clients: 1 })), "active");
  /*
   * Off is off. The warning is about a server that is serving, and a dot that
   * warned about a stopped one would be the boy who cried wolf.
   */
  equal(
    "a server that is not running warns about nothing",
    dotFor(listening({ state: "off", requiresAuth: false })),
    "off",
  );
  /*
   * Its own colour, and not `--danger`: nothing has gone wrong. A red dot over
   * a working server teaches people that red means nothing.
   */
  equal("the warning has its own colour", dotColor("unauthenticated"), "--warn");
  check("...which is not the error colour", dotColor("unauthenticated") !== dotColor("error"));
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
   * ...and omits it when there is none, which authentication being off is.
   * An empty `Bearer ` would be a command that looks right, runs, and fails to
   * connect -- with an error naming authentication on a server not asking for
   * any.
   */
  check(
    "no token, no header",
    !connectCommand("http://127.0.0.1:4571/mcp", null).includes("--header"),
    connectCommand("http://127.0.0.1:4571/mcp", null),
  );
  check("...and the address is still there", connectCommand("http://x/mcp", null).includes("http://x/mcp"));

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

// --- where the grid sits and where the camera starts ------------------------
//
// Both used to answer "the world origin", and a schematic's origin is a corner
// of the work rather than its middle: there are no negative block coordinates,
// so three quadrants of the grid covered space no block can occupy, and
// orbiting turned around the corner instead of around the build.
console.log("\n--- framing ---");
{
  const box = (width: number, height: number, length: number) => ({ width, height, length });

  equal("nothing open leaves the grid on the origin", gridCentre(null), { x: 0, z: 0 });

  equal(
    "a box whose middle is already on a cell gets exactly its middle",
    gridCentre(box(64, 16, 64)),
    { x: 32, z: 32 },
  );

  /*
   * The snap is the whole subtlety, and it is invisible in a screenshot.
   *
   * A `GridHelper` draws its lines one cell apart *from its own centre*, so a
   * centre at 10 puts lines at 10, 18, 26 -- off every block boundary, while
   * the build-grid patch under the cursor is still drawn on integer cells. The
   * two would disagree everywhere, by a constant, which reads as a rendering
   * bug rather than as a centring one.
   */
  for (const [w, l] of [
    [20, 20],
    [1, 1],
    [13, 47],
    [255, 3],
    [7, 9],
  ]) {
    const centre = gridCentre(box(w, 8, l));
    check(
      `a ${w}x${l} box still lands on the cell grid`,
      centre.x % GRID_CELL === 0 && centre.z % GRID_CELL === 0,
      JSON.stringify(centre),
    );
    check(
      `...within half a cell of the real middle of ${w}x${l}`,
      Math.abs(centre.x - w / 2) <= GRID_CELL / 2 && Math.abs(centre.z - l / 2) <= GRID_CELL / 2,
      JSON.stringify(centre),
    );
  }

  const framed = documentFraming(box(32, 16, 48));
  equal("the camera is aimed at the middle of the box", framed.target, { x: 16, y: 8, z: 24 });

  /*
   * The establishing shot itself is unchanged -- above the box, off one corner
   * -- because an ordinary document should open looking the way it always did.
   * Only what it is measured against moved.
   */
  check("...from above it", framed.position.y > framed.target.y);
  check(
    "...and off the +x/+z corner, as it always was",
    framed.position.x > framed.target.x && framed.position.z > framed.target.z,
  );
  check(
    "...far enough out to see the whole box",
    Math.hypot(
      framed.position.x - framed.target.x,
      framed.position.y - framed.target.y,
      framed.position.z - framed.target.z,
    ) > 48,
  );

  /*
   * The reason this is measured from the box rather than from the geometry.
   * `Box3.setFromObject` of an empty document is an empty box, so the old
   * framing returned without moving anything and left the camera at wherever it
   * was mounted -- pointed at no part of a work surface that has nothing else
   * on it to navigate by.
   */
  const empty = documentFraming(box(1, 1, 1));
  check(
    "a document with nothing in it still gets a shot",
    Number.isFinite(empty.position.x) && empty.position.y > empty.target.y,
    JSON.stringify(empty),
  );

  const small = documentFraming(box(8, 8, 8));
  const large = documentFraming(box(128, 8, 8));
  check(
    "a bigger box is framed from further away",
    large.position.x - large.target.x > small.position.x - small.target.x,
  );

  /*
   * And the viewer asks this module rather than working it out again.
   *
   * The arithmetic above is only worth having if it is the arithmetic that
   * runs, and the call site is inside a `requestAnimationFrame`-driven
   * component this harness cannot mount -- so the trigger is checked the way
   * the Ctrl gate and the coplanar epsilons are, by reading the source.
   */
  const viewer = readFileSync(path.join(RENDERER, "lib", "Viewer.svelte"), "utf8");
  check("the viewer asks this module where its grid goes", viewer.includes("gridCentre("));
  /*
   * And then *moves* it. Checking only for the call proves the call is there
   * and nothing about what is done with the answer -- which is the whole of
   * what a grep can say, so the grep has to name the effect as well.
   */
  check(
    "...and moves it there on both axes",
    /grid\.position\.x\s*=/.test(viewer) && /grid\.position\.z\s*=/.test(viewer),
  );
  check("...and frames its camera from it too", viewer.includes("documentFraming("));
  /*
   * The old version measured `Box3.setFromObject(loaded)`, which is an empty
   * box on an empty document -- so it returned without moving anything and
   * the camera stayed where it was mounted. Nothing else in that file frames
   * anything, so its absence is the whole rule.
   */
  check(
    "...and no longer measures the geometry to do it",
    !/setFromObject\([a-z]/.test(viewer),
  );
}

// --- drawing without a vanishing point --------------------------------------
//
// The 2.5D mode. An orthographic frustum does not widen with depth, so
// "the same view" as a perspective camera is only well defined at one
// distance -- and picking the wrong one turns a projection toggle into a
// zoom, which is what it looks like when it is wrong.
console.log("\n--- orthographic projection ---");
{
  /*
   * The frustum matches the perspective one *at the orbit target*, which is
   * the arithmetic worth stating: half the height over the distance is the
   * tangent of half the field of view, and nothing else.
   */
  const height = orthoFrustumHeight(60, 100);
  check(
    "the frustum subtends the field of view at the target",
    Math.abs(height / 2 / 100 - Math.tan(Math.PI / 6)) < 1e-9,
    String(height),
  );
  check(
    "...so twice as far out shows twice as much",
    Math.abs(orthoFrustumHeight(60, 200) - 2 * height) < 1e-9,
  );

  /*
   * Zero is reachable: fly into the middle of a build, come back to orbit,
   * and the distance is whatever is left. A zero-height frustum is a
   * degenerate projection matrix, which draws nothing and reports nothing.
   */
  check("a camera sitting on its own target still has a frustum", orthoFrustumHeight(60, 0) > 0);
  check("...and so does one behind it", orthoFrustumHeight(60, -5) > 0);

  /*
   * Height is the invariant and width follows the aspect, the same way round
   * as `PerspectiveCamera.fov` -- which is vertical too, so a wider window
   * shows more at the sides rather than less top to bottom. On a square
   * viewport the two conventions agree, which is why this is stated at 2:1.
   */
  const wide = orthoBounds(10, 2);
  equal("a wide window keeps its height", [wide.top, wide.bottom], [5, -5]);
  equal("...and gains width", [wide.left, wide.right], [-10, 10]);
  const tall = orthoBounds(10, 0.5);
  equal("a tall one keeps it too", [tall.top, tall.bottom], [5, -5]);
  equal("...and loses width", [tall.left, tall.right], [-2.5, 2.5]);
  check("a degenerate aspect still gives a usable box", orthoBounds(10, 0).right > 0);

  /*
   * One field of view, used twice. The perspective camera is constructed
   * with it and the orthographic frustum is derived from it, so a literal 60
   * left at either call site is a toggle that resizes the build.
   */
  const viewer = readFileSync(path.join(RENDERER, "lib", "Viewer.svelte"), "utf8");
  check("the viewer builds its camera with the shared field of view", /PerspectiveCamera\(ORBIT_FOV/.test(viewer));
  check("...and derives the orthographic frustum from the same one", viewer.includes("orthoFrustumHeight(ORBIT_FOV"));
  check("ORBIT_FOV is the 60 the viewport always used", ORBIT_FOV === 60);

  /*
   * Flight forces perspective. Not belt-and-braces over the greyed checkbox:
   * the setting is on disk, so a window that opens with `orthographic`
   * stored and goes straight into flight never passes through the control.
   */
  check(
    "flight is drawn with a point of view whatever the setting says",
    /cameraMode === \"fly" \|\| projection !== \"orthographic"/.test(viewer),
  );
  check("...and the flight controller is bound to that camera", viewer.includes("PointerLockControls(perspective"));

  /*
   * And the epsilons stay gone.
   *
   * Orthographic depth is linear, so precision is uniform and the coplanar
   * problem is *easier* than under perspective -- which is exactly the
   * argument someone reaches for when putting a hand-picked constant back.
   * It would be safe here and wrong again one checkbox later.
   */
  const NEAR = 0.1;
  const FAR = 512;
  check(
    "orthographic depth resolves finer than the perspective far corner",
    orthoDepthEpsilon(NEAR, FAR) < depthEpsilon(NEAR, FAR, (GRID_SIZE / 2) * Math.SQRT2),
  );
  check(
    "...and does not vary with distance, because there is no 1/z in it",
    orthoDepthEpsilon(NEAR, FAR) === orthoDepthEpsilon(NEAR, FAR),
  );
  check("the floor still wins by depth-buffer steps, not by world units", COPLANAR_OFFSET.units >= 1);
}

// --- the compass in the corner ----------------------------------------------
//
// A viewport that orbits freely has no other answer to which way you are
// facing, and this app's whole subject is a world with named directions:
// `facing=north` is written into the file and is not derivable from the screen.
// Everything below is consulted from `requestAnimationFrame`, which this
// harness does not run, so the decision is here and only the trigger stays
// unobservable.
console.log("\n--- compass ---");
{
  const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };
  const SIZE = 100;
  const faces: Face[] = ["up", "down", "north", "south", "east", "west"];

  /*
   * With the camera unrotated it looks down its own -Z, which in world
   * terms is *north* -- so north is the direction going away into the
   * screen and **south** is the handle pointing back out at the viewer.
   * That is the way round it is easy to state backwards, and stating it
   * backwards costs nothing visible: a compass whose near and far ends
   * are swapped still looks exactly like a compass.
   */
  const reach = HANDLE_REACH * (SIZE / 2);
  equal("east goes right", projectAxis("east", IDENTITY, SIZE).x, SIZE / 2 + reach);
  equal("west goes left", projectAxis("west", IDENTITY, SIZE).x, SIZE / 2 - reach);
  /*
   * The y flip is the one worth stating. View space has y upwards, a mouse
   * event has it downwards, and a compass mirrored top to bottom still looks
   * exactly like a compass.
   */
  equal("up goes towards the top", projectAxis("up", IDENTITY, SIZE).y, SIZE / 2 - reach);
  equal("down goes to the bottom", projectAxis("down", IDENTITY, SIZE).y, SIZE / 2 + reach);
  check(
    "looking north, it is south that faces the viewer",
    projectAxis("south", IDENTITY, SIZE).depth > projectAxis("north", IDENTITY, SIZE).depth,
  );

  /*
   * A quarter turn about Y takes the camera to look west, so the handle that
   * was on the right is now the one facing the viewer. This is the check that
   * fails if the projection uses the camera's rotation rather than its inverse
   * -- everything above passes either way, because the identity is its own.
   */
  const s = Math.SQRT1_2;
  const turned: Quat = { x: 0, y: s, z: 0, w: s };
  check(
    "turning the camera turns the compass with it",
    projectAxis("east", turned, SIZE).depth > 0.99,
    String(projectAxis("east", turned, SIZE).depth),
  );

  /*
   * Each handle picks itself -- from an angle where all six are separated.
   * Axis-aligned is the degenerate case rather than the ordinary one: two
   * of the handles land on top of each other in the middle, which is the
   * tie the rule below exists for and cannot be asserted through.
   */
  const oblique: Quat = { x: -0.2, y: 0.36, z: 0.08, w: 0.906 };
  for (const face of faces) {
    const spot = projectAxis(face, oblique, SIZE);
    equal(
      `a click on ${face} picks it`,
      axisAt({ x: spot.x, y: spot.y }, oblique, SIZE),
      face,
    );
  }
  equal("the gap between handles is nothing", axisAt({ x: 50, y: 50 }, oblique, SIZE), null);
  equal("nor is a corner", axisAt({ x: 2, y: 2 }, oblique, SIZE), null);

  /*
   * Nearest the viewer wins, not nearest the pointer.
   *
   * Looking straight north, the north and south handles project to the very
   * same point -- the centre -- and the one drawn on top is south, the one
   * pointing back out of the screen. Picking by distance would be a coin
   * toss between two exact ties, and half the time a click on the handle
   * under the cursor would fly the camera to the opposite side of the
   * build.
   */
  const at = projectAxis("north", IDENTITY, SIZE);
  equal(
    "two ends of one axis resolve to the near one",
    axisAt({ x: at.x, y: at.y }, IDENTITY, SIZE),
    "south",
  );
  check(
    "...which is the one the click was actually over",
    Math.abs(projectAxis("south", IDENTITY, SIZE).x - at.x) < 1e-9,
  );

  /*
   * Clicking a handle means show me this side, so the camera lands *on* that
   * axis: north puts it north of the build looking south, and up puts it
   * overhead looking down.
   */
  const target = { x: 10, y: 4, z: 6 };
  for (const face of faces) {
    const seat = orbitFor(face, target, 50);
    const step = FACE_VECTOR[face];
    const along =
      (seat.x - target.x) * step.x +
      (seat.y - target.y) * step.y +
      (seat.z - target.z) * step.z;
    check(`looking from ${face} seats the camera on that side`, along > 49, String(along));
    check(
      `...at the distance it was already orbiting from`,
      Math.abs(Math.hypot(seat.x - target.x, seat.y - target.y, seat.z - target.z) - 50) < 0.1,
    );
  }

  /*
   * The poles lean, and it is not cosmetic. OrbitControls takes its azimuth
   * from `atan2` of the horizontal offset, which straight overhead is
   * `atan2(0, 0)` -- zero by definition rather than by intent, so the view
   * would swing to whatever azimuth zero happens to be.
   */
  for (const pole of ["up", "down"] as const) {
    const seat = orbitFor(pole, target, 50);
    const lean = Math.hypot(seat.x - target.x, seat.z - target.z);
    check(`${pole} is not exactly over the target`, lean > 0, String(lean));
    check(`...but only just`, lean < 0.5, String(lean));
  }
  check(
    "a camera already at the target still gets a seat",
    Number.isFinite(orbitFor("north", target, 0).z),
  );

  /*
   * The flight goes *around* the build, not through it. A straight line between
   * two points on a sphere is a chord: a quarter turn lerped would pass a third
   * of the way into the structure and out the other side.
   */
  const centre = { x: 0, y: 0, z: 0 };
  const east = { x: 50, y: 0, z: 0 };
  const north = { x: 0, y: 0, z: -50 };
  const half = arcBetween(centre, east, north, 0.5);
  check(
    "half way round a quarter turn is still at the orbit radius",
    Math.abs(Math.hypot(half.x, half.y, half.z) - 50) < 1e-6,
    String(Math.hypot(half.x, half.y, half.z)),
  );
  check(
    "...which a straight line would not be",
    Math.hypot((east.x + north.x) / 2, 0, (east.z + north.z) / 2) < 49,
  );
  equal("the start is the start", arcBetween(centre, east, north, 0), east);
  check("the end is the end", Math.abs(arcBetween(centre, east, north, 1).z + 50) < 1e-6);

  /*
   * Antipodal is not exotic here: it is clicking north and then south. Two
   * opposite directions span no plane, so there is no arc between them and the
   * arithmetic has to choose one rather than divide by a sine of zero.
   */
  const south = { x: 0, y: 0, z: 50 };
  const across = arcBetween(centre, north, south, 0.5);
  check(
    "reversing an axis still goes round rather than through the middle",
    Math.abs(Math.hypot(across.x, across.y, across.z) - 50) < 1e-3,
    JSON.stringify(across),
  );
  check("...over the top, not through a wall", across.y > 49, JSON.stringify(across));
  check(
    "a radius of nothing does not divide by zero",
    Number.isFinite(arcBetween(centre, centre, north, 0.5).z),
  );

  equal("the ease starts still", easeInOutCubic(0), 0);
  equal("...and finishes still", easeInOutCubic(1), 1);
  equal("...and is half way at half way", easeInOutCubic(0.5), 0.5);
  check("a tick before the start is clamped", easeInOutCubic(-1) === 0);
  check("and one after the end", easeInOutCubic(2) === 1);

  /*
   * `done` is reported rather than inferred from the position: the last frame
   * of a flight is *at* the destination, so a caller comparing coordinates
   * would either hand control back a frame early or never hand it back.
   */
  const flight = { from: east, to: north, around: centre, startedAt: 1000 };
  check("a flight that has not started is at its start", flightAt(flight, 1000).position.x > 49.9);
  check("...and is not done", !flightAt(flight, 1000).done);
  check("one past its span is done", flightAt(flight, 1000 + 421).done);
  check("...and has arrived", Math.abs(flightAt(flight, 1000 + 421).position.z + 50) < 1e-6);
  check(
    "a zero-length flight cannot divide by zero",
    flightAt(flight, 1000, 0).done && Number.isFinite(flightAt(flight, 1000, 0).position.x),
  );

  /*
   * Six handles, three axes, and the two ends of each told apart. They share a
   * colour, so drawn the same a view from due east and one from due west would
   * be the same picture.
   */
  equal("there are six handles", COMPASS_AXES.length, 6);
  equal("...three colours between them", new Set(COMPASS_AXES.map((a) => a.token)).size, 3);
  equal("...one positive end each", COMPASS_AXES.filter((a) => a.positive).length, 3);
  equal("...and a distinct letter each", new Set(COMPASS_AXES.map((a) => a.label)).size, 6);

  /*
   * And it points where the writers point. A compass a quarter turn out of step
   * with the file is invisible until somebody pastes a build into a world and
   * finds it facing the wrong way.
   */
  check(
    "north on the gizmo is north in the schematic",
    FACE_VECTOR.north.z === -1 && FACE_VECTOR.east.x === 1,
  );

  /*
   * And the viewer asks this module rather than working any of it out again.
   *
   * The click handler is sliced out and checked as a *chain* rather than the
   * file being grepped for three names: every one of those names still
   * appears in a file where the handler computes a face and drops it, which
   * was verified by writing exactly that. A grep has to name the wiring.
   */
  const viewerSource = readFileSync(path.join(RENDERER, "lib", "Viewer.svelte"), "utf8");
  const handlerFrom = viewerSource.indexOf("function onCompassClick");
  // Two spaces is the function's own indentation; every block inside it
  // closes further in.
  const handler = viewerSource.slice(handlerFrom, viewerSource.indexOf("\n  }", handlerFrom));
  check("there is a handler for a click on the gizmo", handlerFrom > 0 && handler.length > 0);
  check("...it asks this module which handle was hit", handler.includes("axisAt("));
  check("...and does something with the answer", /flyToAxis\(\s*face\s*\)/.test(handler));
  check("the camera is seated by this module", viewerSource.includes("orbitFor("));
  check("...and flown by it", viewerSource.includes("flightAt("));
  /*
   * Drawn in the same renderer, not a second one. A browser gives a page on
   * the order of sixteen live WebGL contexts before it starts silently
   * dropping the oldest, which is why the block icons already share one --
   * spending a context on an ornament would be the worst use of it there is.
   */
  equal(
    "the gizmo costs no second WebGL context",
    viewerSource.split("new THREE.WebGLRenderer").length - 1,
    1,
  );
  check("...it is a scissored pass over the one there is", viewerSource.includes("setScissorTest(true)"));
}

// --- the schematic's own box -------------------------------------------------
//
// The build inside a document is not its edge: empty room at the top of a box
// looks exactly like empty space outside one, so without the cage there is no
// way to see how much is left except by running out of it.
console.log("\n--- bounds cage ---");
{
  const viewer = readFileSync(path.join(RENDERER, "lib", "Viewer.svelte"), "utf8");

  check("the viewer builds a cage for the document's box", viewer.includes("function buildBounds"));
  /*
   * It has to follow a resize, because the cage *is* the size -- and unlike the
   * grid, which only moves, it is rebuilt: a scaled cube would need its own
   * inverse to keep the edge lines an even width.
   */
  check("...and rebuilds it when the size changes", /void documentSize;[^}]*buildBounds\(\)/s.test(viewer));

  /*
   * And it is never raycast. This is the half that would go wrong silently: a
   * transparent cage around the whole build, handed to the picker, swallows
   * every click meant for a block inside it -- and the click still *does*
   * something, so it reads as the inspector picking the wrong block rather
   * than as the cage being in the way.
   *
   * Checked by requiring the block raycast to name `loaded` and nothing else,
   * which is what keeps a new decorative object out of it by default.
   */
  const casts = viewer.match(/raycaster\.intersectObjects?\([^)]*\)/g) ?? [];
  check("there are raycasts to check", casts.length > 0);
  check(
    "no raycast reaches the cage",
    casts.every((cast) => !cast.includes("bounds")),
    casts.join(" | "),
  );
  check(
    "...the block pick tests the structure alone",
    casts.some((cast) => cast.includes("intersectObject(loaded")),
  );
}

// --- a click passes through the void ----------------------------------------
//
// Empty space made of water is only usable if the pointer ignores it. The rule
// is one object: every raycast in the viewer names `loaded`, so the void living
// in a group beside it is the whole of what makes a click reach the build
// inside. Checked by reading the source, because `Mesh.raycast` runs from the
// rendering steps and this harness composites no frames.
console.log("\n--- the void block ---");
{
  const viewer = readFileSync(path.join(RENDERER, "lib", "Viewer.svelte"), "utf8");

  check("the void has a group of its own", viewer.includes("voidLoaded"));
  const casts = viewer.match(/raycaster\.intersectObjects?\([^)]*\)/g) ?? [];
  check("there are raycasts to check", casts.length > 0);
  check(
    "none of them reaches it",
    casts.every((cast) => !cast.includes("voidLoaded")),
    casts.join(" | "),
  );

  /*
   * Two layers of one chunk are two meshes under one number, so the map has to
   * be keyed on the pair. Keyed on the number alone a void chunk would evict
   * the solid chunk beside it, and the build would develop holes wherever
   * there was empty space next to it -- a delta only, so it would appear on
   * the second edit and not the first.
   */
  check("chunk meshes are keyed by layer as well as key", /chunkMeshes = new Map<string,/.test(viewer));
  check("...through one place that decides the id", viewer.includes("function meshId("));

  /*
   * A material of its own is not a nicety: the opacity is a material property,
   * and it is what forces the separate object that buys the picking rule.
   */
  check("the void draws with a material of its own", viewer.includes("function ensureVoidMaterial"));
  check("...whose opacity is the setting", /voidMaterial\.opacity = voidOpacity/.test(viewer));

  /*
   * And it casts no shadow. A document-sized volume of it would put the whole
   * build in its own shade -- and it is not there in the sense a shadow means.
   */
  /*
   * Both places that build a chunk mesh, counted rather than found.
   *
   * There are two -- the full build and the delta -- and a check that merely
   * *finds* the rule passes while one of them has lost it. That is the shape
   * of the fault this would be: the shadow appears only after an edit, and
   * only in the chunk the edit touched.
   */
  const shadowed = viewer.match(/mesh\.(?:cast|receive)Shadow = !isVoid/g) ?? [];
  equal("neither place lets the void cast a shadow", shadowed.length, 4);
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
console.log("\n--- a gesture that moved both is one press ---");
{
  /*
   * The gizmo's move, turn and scale change the blocks *and* the box. Recorded
   * apart they cost two presses of Ctrl+Z: one to put the box back on the space
   * the blocks had left, one to put the blocks back. Reported as exactly that.
   *
   * The pairing is a step keyed to the depth *before* the edit and flagged, so
   * it does not answer `undoTarget` while the depth is up -- and `takeEditUndo`
   * hands it back the moment the document comes down to meet it.
   */
  const box = (n: number) => ({ minX: n, minY: 0, minZ: 0, maxX: n, maxY: 0, maxZ: 0 });
  const at = (n: number): SelectionState => ({ selection: box(n), anchor: { x: n, y: 0, z: 0 } });

  // Depth was 4 before the edit and is 5 after it.
  const paired = recordEditSelection(emptyTimeline(), 4, at(1), at(7));

  equal(
    "a step that rode in with an edit does not claim the press",
    undoTarget(paired, 5, true),
    "document",
  );
  equal(
    "...and is handed back once the document has come back to it",
    takeEditUndo(paired, 4)?.state.selection,
    box(1),
  );
  equal(
    "...but not at a depth it does not belong to",
    takeEditUndo(paired, 5),
    null,
  );
  /*
   * And once the document is back down at it -- undone by something that did
   * not go through `undoAnything`, which the chat panel's per-message undo does
   * -- the box is the thing left to put back, so it claims the press after all.
   * The undo side deliberately has no `withEdit` clause; the redo side does.
   */
  equal(
    "...and once the blocks are back it is the box that is left",
    undoTarget(paired, 4, true),
    "selection",
  );

  /*
   * The check that separates the pair from the ordinary case. Without it the
   * flag could be ignored everywhere and every one of these would still pass:
   * a selection somebody made on purpose has to go on claiming its own press,
   * and must not be swallowed by an undo of the edit above it.
   */
  const ordinary = recordSelection(emptyTimeline(), 4, at(1), at(7));
  equal(
    "an ordinary step at the current depth still claims it",
    undoTarget(ordinary, 4, true),
    "selection",
  );
  equal(
    "...and is not swallowed by a document undo",
    takeEditUndo(ordinary, 4),
    null,
  );

  /*
   * The redo side, which has to be asked *before* main is told -- a redo raises
   * the depth exactly as a fresh edit does, so the depth watcher clears the redo
   * stack and the step would already be gone.
   */
  const undone = takeEditUndo(paired, 4);
  equal("undoing the pair leaves it on the redo stack", undone?.timeline.redo.length, 1);
  equal(
    "...where the redo does not claim the press either",
    redoTarget(undone?.timeline ?? emptyTimeline(), 4, true),
    "document",
  );
  equal(
    "...and it comes back pointing forwards",
    takeEditRedo(undone?.timeline ?? emptyTimeline(), 4)?.state.selection,
    box(7),
  );
  equal(
    "a redo of nothing paired is nothing",
    takeEditRedo(emptyTimeline(), 4),
    null,
  );

  // A gesture that moved nothing is not a step, paired or otherwise.
  equal("a pair that changed nothing records nothing", recordEditSelection(emptyTimeline(), 4, at(1), at(1)).undo.length, 0);
}
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

  /*
   * And the version filter, which this module used to argue against having.
   *
   * The old comment said filtering by version would mean guessing when each
   * block was added. That is true above 1.13 and it is *not* true at the
   * Flattening: `legacy_blocks.json` enumerates every block a pre-Flattening
   * file can name, and it is the same table `buildMcEdit` refuses a save on.
   * Generalising from the hard half to the easy one let a 1.12 schematic offer
   * deepslate -- placeable, drawable, and fatal at save time.
   */
  const legacy = new Set([
    "minecraft:stone",
    "minecraft:oak_planks",
  ]);
  equal(
    "a restriction cuts the list",
    inventoryBlocks(
      ["minecraft:stone", "minecraft:deepslate", "minecraft:oak_planks"],
      "",
      legacy,
    ),
    ["minecraft:stone", "minecraft:oak_planks"],
  );
  equal(
    "...and a search cannot reach past it",
    inventoryBlocks(["minecraft:deepslate"], "deepslate", legacy),
    [],
  );
  /*
   * `null` is no restriction, and it has to be a distinct answer from an empty
   * set: the table is fetched over IPC, so there is a moment at start-up when
   * nothing has arrived. An empty set there would empty the inventory, which
   * reads as the app being broken rather than as a file not having landed.
   */
  equal(
    "no restriction is not the same as an empty one",
    inventoryBlocks(["minecraft:deepslate"], "", null),
    ["minecraft:deepslate"],
  );
  equal(
    "...and an empty set really does offer nothing",
    inventoryBlocks(["minecraft:deepslate"], "", new Set()),
    [],
  );
  // Air is out whatever the era: there is nothing to pick up.
  equal(
    "air is still excluded under a restriction",
    inventoryBlocks(["minecraft:air", "minecraft:stone"], "", legacy),
    ["minecraft:stone"],
  );

  /*
   * And the flat era supplies one now too, from `block_versions.json`. The
   * spelling is the part worth checking rather than the cut: this set is
   * intersected with `block_id_list.txt`, which is namespaced, so a set of bare
   * names would match nothing and empty the inventory for every flat document
   * -- an outage that reads as the app being broken.
   */
  {
    const at1_21_4 = blocksIn(4189);
    equal(
      "a 1.21.4 schematic is not offered a block 1.21.9 added",
      inventoryBlocks(
        ["minecraft:stone", "minecraft:copper_chain"],
        "",
        at1_21_4,
      ),
      ["minecraft:stone"],
    );
    equal(
      "...and 26.2 is offered both",
      inventoryBlocks(["minecraft:stone", "minecraft:copper_chain"], "", blocksIn(4903)),
      ["minecraft:stone", "minecraft:copper_chain"],
    );
  }


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
    overGizmo: false,
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
  /*
   * A gizmo arrow says exactly the same thing, and it is a separate field
   * because it comes from a separate raycast: outlining the block behind an
   * arrow promises a click that will move the region instead.
   */
  equal(
    "a gizmo handle takes it too",
    hoverSource({ ...base, overGizmo: true }),
    { kind: "none" },
  );
  check(
    "the two handles and the drag are one question",
    pointerOnHandle({ overHandle: false, overGizmo: true, dragging: false }) &&
      pointerOnHandle({ overHandle: true, overGizmo: false, dragging: false }) &&
      pointerOnHandle({ overHandle: false, overGizmo: false, dragging: true }),
  );
  check(
    "...and an idle pointer is over none of them",
    !pointerOnHandle({ overHandle: false, overGizmo: false, dragging: false }),
  );

  // Neither of those is flight's business: there are no handles under a
  // crosshair, and a gesture in orbit must not reach across the mode switch.
  equal(
    "flight ignores all three",
    hoverSource({
      ...base,
      cameraMode: "fly",
      flying: true,
      overHandle: true,
      overGizmo: true,
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

/*
 * In flight, Ctrl belongs to the camera.
 *
 * One sentence, enforced in three places and runnable in none of them here:
 * `menu_model.ts` stops the File menu claiming its accelerators (checked in
 * `tests/services.ts`), `App.svelte` declines every Ctrl-modified keystroke,
 * and `Hotbar.svelte` stops refusing them. Both renderer halves are a
 * `document.pointerLockElement` read inside a `window` listener, which is a
 * browser fact this harness has no browser for.
 *
 * So the source is checked, exactly as the coplanar epsilons are: not that the
 * gate works, but that it is still there and still in the one position that
 * makes it a rule rather than a habit.
 */
console.log("\n--- in flight Ctrl belongs to the camera ---");
{
  const app = readFileSync(path.join(RENDERER, "App.svelte"), "utf8");
  const from = app.indexOf("function onWindowKey");
  // Two spaces, which is the function's own indentation: every block inside it
  // closes further in.
  const body = app.slice(from, app.indexOf("\n  }", from));
  check("there is a keyboard handler to gate", from > 0 && body.length > 0);

  const lines = body.split(/\r?\n/);
  const gate = lines.findIndex((line) => line.includes("document.pointerLockElement"));
  const modifier = lines.findIndex((line) => /event\.(?:ctrlKey|metaKey)/.test(line));
  check("it declines Ctrl while the pointer is locked", gate >= 0);
  /*
   * And the gate is the *first* thing in it that looks at a modifier.
   *
   * This is the half worth checking. A gate further down is a rule anything
   * written above it silently escapes, and a shortcut added above it would work
   * in flight while every other one did not -- which reads as that shortcut
   * being special rather than as the gate being in the wrong place.
   */
  check(
    "...before anything else asks about one",
    modifier === gate,
    `gate at ${gate}, first modifier at ${modifier}`,
  );
  // Blanket, not an allowlist: the point is that no Ctrl shortcut added later
  // has to be re-judged against WASD by whoever adds it.
  check("...and Ctrl and Cmd both count", /event\.ctrlKey \|\| event\.metaKey/.test(lines[gate] ?? ""));

  /*
   * The other side of the same sentence: with the lock held, Ctrl must stop
   * *suppressing* the keys the game does bind. Ctrl+3 picks the third slot
   * while sprinting, and refusing it was the mirror image of the bug above.
   */
  const hotbar = readFileSync(path.join(RENDERER, "lib", "Hotbar.svelte"), "utf8");
  check("the hotbar knows about the lock too", hotbar.includes("document.pointerLockElement"));
  check(
    "...and no longer refuses Ctrl outright",
    !/isTyping\(event\.target\) \|\| event\.ctrlKey/.test(hotbar),
  );
}

// ---------------------------------------------------------------------------
// The inspector lists what a block *may* hold, not only what it happens to
// ---------------------------------------------------------------------------
//
// The panel listed the entry's own keys, which is right for a block that came
// out of a file and useless for one that arrived bare. A campfire placed over
// MCP had an empty property bag, so the panel that exists to let you point it
// somewhere said "This block has no block states" -- about a block with four.
console.log("\n--- the inspector's block-state rows ---");
{
  const campfire = propertyRows("minecraft:campfire", {});
  equal(
    "a bare block still lists everything it may hold",
    campfire.map((row) => row.name),
    ["facing", "lit", "signal_fire", "waterlogged"],
  );
  check(
    "...with none of them set",
    campfire.every((row) => row.value === null),
  );
  check(
    "...and the legal values offered anyway",
    (campfire.find((row) => row.name === "facing")?.values ?? []).includes("east"),
  );

  const lit = propertyRows("minecraft:campfire", { lit: "false" });
  equal("what the block carries is shown as carried", lit.find((row) => row.name === "lit")?.value, "false");
  equal(
    "...and the rest is still offered",
    lit.find((row) => row.name === "signal_fire")?.value,
    null,
  );

  /*
   * The other half of the union, and the one that is easy to leave out.
   *
   * A schematic may hold a property the block does not legally have -- another
   * tool wrote it, or the block was renamed under it. Listing only what is
   * legal would hide it here while leaving it in the file, and this panel is
   * the only place it could ever be taken off.
   */
  const odd = propertyRows("minecraft:stone", { nonsense: "yes" });
  equal("a property the block should not have is still shown", odd.map((row) => row.name), ["nonsense"]);
  equal("...carrying its value", odd[0].value, "yes");
  equal("...with no values to offer for it", odd[0].values, null);

  // A block the registry does not know contributes nothing, which is exactly
  // what the panel did before any of this.
  equal("an unknown block is listed from the entry alone", propertyRows("minecraft:nonsense", {}), []);
  equal(
    "...and keeps whatever it carries",
    propertyRows("minecraft:nonsense", { a: "1" }).map((row) => row.name),
    ["a"],
  );

  // A block with genuinely no states is genuinely empty -- 346 of them are, and
  // the panel saying so is correct rather than a gap.
  equal("a block with no states has no rows", propertyRows("minecraft:stone", {}), []);

  // Sorted by name and not by whether it is set: a blank row that jumped
  // somewhere else the moment it was filled in would send the next keystroke
  // into whichever row slid into its place.
  const order = propertyRows("minecraft:campfire", { waterlogged: "true" }).map((row) => row.name);
  equal("the rows are in name order however they are set", order, [...order].sort());
}

// ---------------------------------------------------------------------------
// ...and an empty value means remove, decided in one place
// ---------------------------------------------------------------------------
//
// The panel has no separate delete verb: clearing the field takes the property
// off and the button beside a set row is a shortcut for clearing it. Two ways
// of saying "gone" is how they come to disagree, so the rule is in the handler
// and the markup only calls it. Before this, clearing the box wrote `name: ""`
// -- a property with an empty value, which is a state no block has and which
// the writers would have put into the file verbatim.
{
  const app = readFileSync(path.join(RENDERER, "App.svelte"), "utf8");
  const from = app.indexOf("async function changeBlockProperty");
  check("the block-state handler is still there", from !== -1);
  const body = app.slice(from, app.indexOf("\n  }", from));
  check("an empty value deletes the property", /delete properties\[name\]/.test(body), body.slice(0, 200));
  check(
    "...rather than writing an empty one",
    !/properties\[name\] = ""/.test(body) && !/\[name\]: value\.trim\(\)/.test(body),
  );

  const panel = readFileSync(path.join(RENDERER, "lib", "InspectorPanel.svelte"), "utf8");
  check("the panel decides its rows in the module that can be checked", panel.includes("propertyRows("));
  check(
    "...and the remove button goes through the same handler as typing",
    /onchangeproperty\(row\.name, ""\)/.test(panel),
  );
}

// --- what a change of empty space converts from -----------------------------
/*
 * One function, two callers: `setSessionVoidBlock` converts with it and the
 * panel decides from it whether the button is live. Two copies of this rule is
 * how the button comes to be dead over an edit that would work -- which is
 * exactly what was reported.
 */
console.log("\n--- what a change of empty space converts from ---");
{
  /*
   * Air is always a source, whatever the setting says. This is the reported
   * case: a schematic whose empty space is *set* to barrier with its cells
   * still air -- reopened from its sidecar, or one Ctrl+Z after a conversion
   * -- looks identical, from the setting, to one already converted. Deciding
   * from the setting refused both.
   */
  equal(
    "picking the block that is already chosen still offers to convert the air",
    voidSources("minecraft:barrier", "minecraft:barrier"),
    ["minecraft:air"],
  );
  equal(
    "...and so does picking one for the first time",
    voidSources("", "minecraft:barrier"),
    ["minecraft:air"],
  );

  /*
   * The previous choice is *added* to air rather than standing in for it: a
   * conversion leaves its own block behind, so swapping barrier for
   * structure_void has to find the barrier, and air alone would not.
   */
  equal(
    "swapping one for another looks for both",
    voidSources("minecraft:barrier", "minecraft:structure_void"),
    ["minecraft:air", "minecraft:barrier"],
  );

  /*
   * The target is never a source. Converting a block into itself can only
   * change nothing, and offering it would put an empty step on the undo stack.
   */
  equal(
    "going back to air has nothing to look for",
    voidSources("", ""),
    [],
  );
  equal(
    "...and neither does undoing a swap in place",
    voidSources("minecraft:air", "minecraft:air"),
    [],
  );

  // Every spelling of air is one answer, which is what `normaliseVoidBlock` is
  // for -- so it cannot appear twice in the list, nor survive as the target.
  equal(
    "air spelled out is still air on both sides",
    voidSources("minecraft:air", "minecraft:barrier"),
    ["minecraft:air"],
  );

  /*
   * And the set those sources are looked up in has to contain air, which is
   * the half that made the first fix inert. `DocumentState.palette` leaves air
   * out on purpose -- it is the materials list, and a schematic is mostly air
   * -- so asking it alone always answered no, whatever the document held.
   *
   * It is recovered from two numbers rather than transported: `countBlocks`
   * counts every voxel whose palette index is not zero and index 0 is always
   * air, so the document holds air exactly when `blockCount` is short of the
   * volume.
   */
  {
    // Typed as the real payload rather than trimmed to what the function reads:
    // `PaletteCount` is what `DocumentState` carries, and a fixture narrower
    // than the caller is a fixture that cannot catch the caller.
    const palette: PaletteCount[] = [{ block: "minecraft:stone", count: 1 }];
    equal(
      "a document with room left in it holds air",
      [...blocksInDocument(palette, [4, 4, 4], 1)].sort(),
      ["minecraft:air", "minecraft:stone"],
    );
    equal(
      "...and one packed to the walls does not",
      [...blocksInDocument(palette, [4, 4, 4], 64)].sort(),
      ["minecraft:stone"],
    );
    /*
     * Both spellings, and this check used to say the opposite.
     *
     * A source may be bare or stated -- every preset is bare, and anything
     * somebody types may not be -- while a palette entry is always a full
     * state string. Keeping only the bare name made a *stated* source
     * unmatchable, so the button died over an edit that would have worked;
     * keeping only the full key would make every preset unmatchable.
     *
     * Holding both is `matchesBlockPattern`'s rule as a set: bare finds the
     * block in any state, stated finds only that state.
     */
    const stairs: PaletteCount[] = [
      { block: "minecraft:oak_stairs[facing=north]", count: 1 },
      { block: "minecraft:oak_stairs[facing=east]", count: 1 },
    ];
    const held = blocksInDocument(stairs, [4, 4, 4], 64);
    check(
      "a bare source finds the block whatever state it is in",
      held.has("minecraft:oak_stairs"),
      [...held].join(" "),
    );
    check(
      "...and a stated one finds that state",
      held.has("minecraft:oak_stairs[facing=east]"),
      [...held].join(" "),
    );
    check(
      "...and not a state the document does not have",
      !held.has("minecraft:oak_stairs[facing=south]"),
      [...held].join(" "),
    );

    /*
     * The two together, on the reported case: empty space *set* to barrier
     * with the cells still air. The sources say air, the document has air, so
     * the button is live -- where reading the setting called this identical to
     * the already-converted document and refused both.
     */
    const sources = voidSources("minecraft:barrier", "minecraft:barrier");
    const stillAir = blocksInDocument(palette, [4, 4, 4], 1);
    const filled: PaletteCount[] = [...palette, { block: "minecraft:barrier", count: 63 }];
    const converted = blocksInDocument(filled, [4, 4, 4], 64);
    check(
      "the setting already naming the block does not disable the button",
      sources.some((id) => stillAir.has(id)),
    );
    check(
      "...while the same setting over a converted document does",
      !sources.some((id) => converted.has(id)),
    );
  }
}


// --- the picker draws a bounded number of rows ------------------------------
/*
 * The freeze was made of DOM nodes. `rank` used to fall back to matching the
 * namespaced id, so nine of the commonest letters in English each returned all
 * 1197 blocks -- one row apiece, built and thrown away per keystroke, inside a
 * floating panel a few rows tall.
 *
 * The search fix takes the worst case from 1197 to 974, which is still too
 * many, so the picker draws a window of them. That is deliberately NOT the cap
 * its header forbids: nothing is hidden silently, because the line above the
 * list says both numbers.
 *
 * Checked as source, the way the flight gate and the framing calls are: the
 * markup is a browser fact this harness has no browser for, and what can be
 * stated here is that the rows come from the bounded list and the count line
 * from the unbounded one.
 */
console.log("\n--- the picker draws a bounded number of rows ---");
{
  const picker = readFileSync("src/renderer/src/lib/BlockPicker.svelte", "utf-8");

  check(
    "there is a limit, and it is a named constant",
    /const ROW_LIMIT = \d+;/.test(picker),
  );
  check(
    "the rows are drawn from the bounded list",
    /\{#each shown as block/.test(picker),
  );
  /*
   * And the count is not. This is the half that keeps the limit honest: report
   * `shown.length` as the total and the limit silently becomes the cap the
   * file's own header argues against.
   */
  check(
    "...while the count line reports the real number of matches",
    /blocks\.capped[^]{0,80}matches\.length/.test(picker),
  );
  check(
    "...and the keyboard cannot walk past what is drawn",
    !/matches\.length - 1/.test(picker) && /shown\.length - 1/.test(picker),
  );

  /*
   * No hover writing the highlighted row. The effect beside it writes
   * `list.scrollTop`; scrolling moves a different row under a *stationary*
   * pointer, the browser fires `mouseenter` for it, and that writes the
   * highlight again. The CSS `:hover` already draws the row under the pointer,
   * so the handler bought one nicety and cost a feedback path.
   */
  check(
    "hovering a row does not write state",
    // The attribute, not the word: the reason it is gone is written down two
    // lines above where it used to be, and a check on the word finds that.
    !/onmouseenter=/.test(picker),
  );

  /*
   * And the registry it filters is `$state.raw`. Plain `$state` on an array is
   * a deep proxy -- a signal per entry, 1197 of them, read inside a `$derived`
   * on every keystroke. It is the fault `legacyIndex` was already fixed for,
   * on the line below the one that still had it.
   */
  const app = readFileSync("src/renderer/src/App.svelte", "utf-8");
  check(
    "the block registry is raw state, not a deep proxy",
    /let blockRegistry = \$state\.raw</.test(app),
  );

  /*
   * And the list is positioned against the window rather than the field. Laid
   * out from the field it is clipped by a `ToolWindow` a few rows tall, and its
   * own margin box drives that panel's scroller -- so what it can reach, it can
   * also resize.
   */
  check(
    "the dropdown is placed against the window",
    /placePopover\(/.test(picker) && /position: fixed/.test(picker),
  );
  check(
    "...below the field it belongs to, not above it",
    /"below"/.test(picker),
  );
}

{
  /*
   * `placePopover`'s new preference, and the reason it is not merely taste: a
   * list that opens above the caret when the panel is low and below it when the
   * panel is high behaves differently after you drag its window.
   *
   * The preference is the design; the clamp is the guarantee, and only the
   * clamp is load-bearing.
   */
  const anchor = { left: 400, top: 300, width: 180, height: 24 };
  const box = {
    viewportWidth: 1280,
    viewportHeight: 800,
    popoverWidth: 320,
    popoverHeight: 240,
    margin: 8,
    gap: 4,
  };
  equal(
    "with room on both sides, above is still the default",
    placePopover(anchor, box).y,
    300 - 4 - 240,
  );
  equal(
    "...and below is taken when it is asked for",
    placePopover(anchor, box, "below").y,
    300 + 24 + 4,
  );
  /*
   * Asking for below and not fitting falls back to above rather than hanging
   * off the bottom -- a list of blocks under a field near the foot of the
   * window is the ordinary case, not an edge one.
   */
  const low = { ...anchor, top: 700 };
  equal(
    "...falling back to above when below does not fit",
    placePopover(low, box, "below").y,
    700 - 4 - 240,
  );
  /*
   * And when neither fits, the clamp still puts it on screen. That is the half
   * that is a guarantee rather than a preference.
   */
  const tall = { ...box, popoverHeight: 780 };
  const squeezed = placePopover({ ...anchor, top: 400 }, tall, "below");
  check(
    "with room nowhere it is still inside the window",
    squeezed.y >= 8 && squeezed.y <= 800 - 8,
    String(squeezed.y),
  );
}


// --- `bind:this` writes null ------------------------------------------------
/*
 * The rule, and the freeze it cost.
 *
 * `bind:this` sets its binding to **`null`** when the element goes away. Three
 * of them were declared `| undefined` and guarded with `=== undefined`, so at
 * exactly the moment the element vanished the guard was false and the next line
 * read a property off `null` -- inside the effect flush, where Svelte has
 * nowhere to put it. The scheduler is left broken and takes every effect in the
 * window with it, while the viewport keeps drawing from its own
 * `requestAnimationFrame` chain and main keeps answering. Navigable and
 * completely dead, twice reported that way.
 *
 * The type was a lie `tsc` could not catch: it validated a comparison that can
 * never be true. Declared honestly, `=== undefined` no longer compiles.
 *
 * Which is not enough on its own, and that is why this check exists rather than
 * being redundant with the compiler. `tsc` catches the *mismatch*; put the
 * declaration and the guard back **together** and it is silent again -- verified
 * by doing exactly that. A consistent pair of wrong answers compiles clean and
 * freezes the window, so the thing that has to be refused is the declaration.
 */
console.log("\n--- `bind:this` writes null ---");
{
  function svelteFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) found.push(...svelteFiles(full));
      else if (entry.endsWith(".svelte")) found.push(full);
    }
    return found;
  }

  /*
   * Named rather than skipped. `Viewer`'s two are declared non-nullable and
   * are not in a conditional, so they exist for the whole life of the component
   * and are only ever read from `onMount` and from handlers bound to them --
   * never after the element is gone. Making them `| null` would add a `!` at
   * every use across a 140 kB file and buy nothing.
   */
  const UNCONDITIONAL = new Set(["canvas", "container"]);

  const offenders: string[] = [];
  const compared: string[] = [];
  for (const file of svelteFiles(RENDERER)) {
    /*
     * Comments stripped first, and that is not fastidiousness: the whole reason
     * these sites are recognisable is that somebody wrote down what went wrong,
     * quoting the guard that was there. A scan that read prose would find the
     * explanation and call it the fault.
     */
    const source = readFileSync(file, "utf-8")
      .replace(/\/\*[^]*?\*\//g, " ")
      .replace(/<!--[^]*?-->/g, " ")
      .replace(/(^|[^:])\/\/.*/g, "$1");
    const name = path.basename(file);
    for (const match of source.matchAll(/bind:this=\{(\w+)\}/g)) {
      const bound = match[1];
      if (UNCONDITIONAL.has(bound)) continue;
      /*
       * The declaration, in either form this codebase uses: a rune for the ones
       * an effect reads, a plain `let` for the ones only a handler does.
       */
      const declared = new RegExp(
        `let ${bound}(?:\\s*[:=]\\s*\\$state<([^>]*)>|\\s*:\\s*([^;=]*))`,
      ).exec(source);
      const type = declared === null ? null : (declared[1] ?? declared[2] ?? "");
      if (type !== null && /undefined/.test(type)) {
        offenders.push(`${name}: ${bound} is ${type.trim()}`);
      }
      if (new RegExp(`\\b${bound}\\s*[!=]==\\s*undefined`).test(source)) {
        compared.push(`${name}: ${bound}`);
      }
    }
  }

  equal(
    "no `bind:this` binding is declared undefined",
    offenders.join(", "),
    "",
  );
  /*
   * And nothing compares one against `undefined`. Once the declarations are
   * honest `tsc` refuses this on its own -- so this half is here to say *why*,
   * and to catch the pair arriving together in a file nobody has typed yet.
   */
  equal(
    "...and none is compared against it",
    compared.join(", "),
    "",
  );

  /*
   * The two that were reported, by name, so a regression says which. Both
   * unmount their list the moment a query matches nothing -- typing `aa` in a
   * block field, or `zzzz` after Ctrl+K.
   */
  for (const [file, binding] of [
    ["BlockPicker.svelte", "list"],
    ["CommandPalette.svelte", "list"],
  ] as const) {
    const source = readFileSync(path.join(RENDERER, "lib", file), "utf-8")
      .replace(/\/\*[^]*?\*\//g, " ");
    check(
      `${file} guards its list against null`,
      new RegExp(`${binding} === null`).test(source),
    );
  }
}


// --- what a block may hold depends on the era -------------------------------
//
// A 1.12.2 schematic showed `waterlogged` on its fences, stairs, slabs and
// panes. The property is 1.13's; the document is from a version with no such
// idea. Reported exactly that way.
//
// The inspector lists the union of what the entry carries and what the game
// says it may carry, and the second half was asking the **modern registry** --
// which has nothing true to say about a numeric `ID:DATA` block. Before 1.13
// the authority is `legacy_blocks.json`, which is the same table the MCEdit
// writer decides the save on, so what the panel offers is what the file can
// hold.
console.log("\n--- what a block may hold depends on the era ---");
{
  const table = JSON.parse(
    readFileSync(path.join(here, "..", "resources", "legacy_blocks.json"), "utf8"),
  ) as { blocks: Record<string, string> };
  const legacy = buildLegacyIndex(table.blocks);

  /*
   * The fact underneath all of it, stated once: the property is not in the
   * table anywhere. Not an accident of the data -- it is the era.
   */
  const anyWaterlogged = [...legacy.properties.values()].some((held) => held.has("waterlogged"));
  check("no pre-Flattening block holds waterlogged", !anyWaterlogged);

  /*
   * The four families it was reported on. Each is checked from both sides,
   * because a rule that returned nothing at all would pass the first half.
   */
  for (const [name, wanted] of [
    ["minecraft:oak_fence", ["east", "north", "south", "west"]],
    ["minecraft:oak_stairs", ["facing", "half", "shape"]],
    ["minecraft:stone_slab", ["type"]],
    ["minecraft:oak_door", ["facing", "half", "hinge", "open", "powered"]],
  ] as const) {
    const rows = propertyRows(name, {}, legacy).map((row) => row.name);
    equal(`${name.replace("minecraft:", "")} holds exactly its legacy states`, rows, [...wanted]);
  }

  /*
   * ...and the flat era is untouched, which is the half that says the fix is a
   * rule about versions rather than a property nobody may see.
   */
  check(
    "a flat document still offers waterlogged on a stair",
    propertyRows("minecraft:oak_stairs", {}, null).some((row) => row.name === "waterlogged"),
  );

  /*
   * What the entry *carries* is always listed, whatever the era says. That is
   * what lets somebody see a property another tool wrote and delete it -- and
   * it is why the registry half being wrong was a bug rather than a mercy.
   */
  check(
    "a state the file carries is shown even where the era denies it",
    propertyRows("minecraft:oak_fence", { waterlogged: "true" }, legacy).some(
      (row) => row.name === "waterlogged" && row.value === "true",
    ),
  );

  /*
   * A block that era cannot name at all contributes nothing rather than
   * falling back to the registry. Falling back is the claim the change exists
   * to stop making, so an unlisted block is the case that would silently undo
   * it.
   */
  equal(
    "a block the era never had offers none of the registry's states",
    propertyRows("minecraft:lantern", {}, legacy).map((row) => row.name),
    [],
  );
}

// --- the right button opens, and Shift places -------------------------------
//
// The split is the game's, and the *decision* is main's -- the renderer holds
// no schematic, so it cannot know whether the cell under the crosshair opens.
// What lives here is only which verb the click sends, which is a browser fact
// this harness has no browser for. So it is read out of the source, the way the
// flight-mode modifier gate is.
//
// Shift is already the descend key in flight, so sneak-to-place costs nothing
// and collides with nothing -- and that is the whole reason this arrangement is
// available at all rather than needing a key nobody uses.
console.log("\n--- the right button opens, and Shift places ---");
{
  const viewer = readFileSync(path.join(RENDERER, "lib", "Viewer.svelte"), "utf-8");
  check(
    "the right button dispatches on Shift",
    /onbuild\(\s*event\.shiftKey \? "place" : "use"/.test(viewer),
  );
  /*
   * And the left one is untouched. A gesture that started opening things on
   * the *break* button would be a very fast way to lose a build, and it is one
   * character away.
   */
  check(
    "the left button still breaks",
    /event\.button === 0\)\s*\{\s*\n?\s*onbuild\("break"/.test(viewer.replace(/\r/g, "")),
  );
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
