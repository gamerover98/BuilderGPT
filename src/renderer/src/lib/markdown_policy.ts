/**
 * What a model's answer is allowed to become once it is HTML.
 *
 * The chat renders the agent's markdown through `marked` and injects the result
 * with `{@html}`. That is a deliberate trade — full GFM for very little code —
 * and the price is that safety stops being structural and becomes a matter of
 * configuration. So the configuration lives here, in one readable file with no
 * DOM in it, rather than as an options object buried in a component.
 *
 * The rule the whole thing rests on: **an allowlist of what may survive**, not
 * a denylist of what may not. DOMPurify's defaults are broad on purpose — they
 * are meant to keep arbitrary rich text working. This app renders one narrow
 * thing, so it can afford to name every tag it expects and drop the rest.
 *
 * Read `ALLOWED_TAGS` against what `marked` actually emits: paragraphs,
 * headings, emphasis, code, lists, quotes, rules, links and GFM tables. If a
 * tag is not in that list it is because nothing we render produces it.
 */

/**
 * Every element `marked` emits for the subset the chat renders.
 *
 * `img` is deliberately absent — see `IMAGES_BECOME_LINKS` below.
 */
export const ALLOWED_TAGS: readonly string[] = [
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "blockquote",
  "a",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

/**
 * The only two attributes that carry meaning here.
 *
 * `align` is what `marked` puts on table cells for `|:--|--:|`. `href` is the
 * one attribute that carries a URL, which is why it gets its own scheme check.
 *
 * **`style` is not on this list and must not be**, and it is worth saying why
 * rather than leaving it to be re-litigated: the renderer's CSP is
 * `style-src 'self' 'unsafe-inline'`, so unlike a script an inline style really
 * would apply. A model — or anything that reached one — could then draw an
 * element over the rest of the window.
 *
 * `id` is absent for a smaller reason: an injected id can collide with the
 * app's own and silently steal a `<label for=…>` or an `aria-labelledby`.
 *
 * `target` and `rel` are absent because they are not read from the markdown at
 * all; `hardenLink` sets them afterwards.
 */
export const ALLOWED_ATTR: readonly string[] = ["href", "align"];

/**
 * Links may only be `http:` or `https:`.
 *
 * Not a denylist of `javascript:` and friends: schemes are open-ended, and
 * `data:text/html` is as good as script while looking nothing like it.
 */
const SAFE_SCHEME = /^https?:\/\//i;

/**
 * The highest code point a browser ignores while parsing a URL.
 *
 * Everything from NUL up to and including the space: ASCII control characters
 * and the space itself.
 */
const URL_IGNORED_MAX = 0x20;

/**
 * Whether an `href` may stay on the element.
 *
 * The stripping needs its reasoning stated precisely, because the obvious
 * story about it is backwards. This is an **allowlist anchored at the start**
 * -- `^https?://` -- so ignoring characters can only ever let *more* strings
 * through, never fewer. A tab-split `java<TAB>script:` is refused whether or
 * not the tab is stripped, because neither form begins with `http`.
 *
 * What stripping buys is the other direction: browsers ignore ASCII whitespace
 * and control characters while parsing a URL, so a perfectly good link that
 * picked up a leading newline is one the browser would follow and a raw check
 * would reject. It stays safe while doing so precisely because of the anchor:
 * strip everything ignorable from a tab-prefixed `javascript:` and you still
 * have `javascript:`, which still fails.
 *
 * So the risk here is over-stripping, not under-stripping -- take one
 * character class too many and every href silently stops working. Which is
 * exactly what happened once: a mangled escape turned the range into the whole
 * of ASCII, every URL collapsed to the empty string, and every link died.
 * Hence the loop rather than a regular expression, and hence the test that a
 * real URL survives it.
 */
export function isSafeHref(href: string): boolean {
  let collapsed = "";
  for (const character of href) {
    const code = character.codePointAt(0);
    if (code !== undefined && code > URL_IGNORED_MAX) collapsed += character;
  }
  return SAFE_SCHEME.test(collapsed);
}

/**
 * The configuration handed to `DOMPurify.sanitize`.
 *
 * **There is deliberately no `ALLOWED_URI_REGEXP` here**, and that absence is
 * the most surprising thing in this file, so it gets the long note.
 *
 * Setting it to `SAFE_SCHEME` is the obvious move and it is wrong. DOMPurify
 * tests that expression against *every* attribute value, not only the ones that
 * carry a URL — so with `/^https?:\/\//` in place, `align="right"` on a table
 * cell fails the test and the attribute is dropped. GFM table alignment
 * silently stopped working, which is how this was found: a test, not a user.
 *
 * DOMPurify's own default expression already refuses `javascript:` and friends
 * while letting scheme-less values like `right` through, so leaving it alone is
 * both safer and more correct than a stricter-looking replacement. The
 * http/https rule is then enforced where it actually belongs, on the one
 * attribute that carries a URL, by `hardenLink` — and `href` is the *only* such
 * attribute in `ALLOWED_ATTR`, so that hook covers all of them. It runs from
 * `afterSanitizeAttributes`, which means it gets the last word.
 */
export const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  /**
   * A disallowed tag loses the tag and keeps its text. That is the right
   * failure for this content: if something arrives as `<span>hello</span>`,
   * the user should still read "hello" rather than watch a word vanish.
   */
  KEEP_CONTENT: true,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
} as const;

/**
 * Sends a surviving link somewhere it cannot hurt anything.
 *
 * `main/index.ts` already answers `setWindowOpenHandler` with
 * `shell.openExternal` and refuses `will-navigate` outright, so a `_blank`
 * link opens in the user's own browser and the app window cannot be navigated
 * away from the app. `noopener` matters even so: without it the opened page
 * gets a handle on `window.opener`.
 *
 * Run from an `afterSanitizeAttributes` hook, so these two attributes are set
 * *after* filtering rather than having to be allowed through it.
 */
export function hardenLink(node: Element): void {
  if (node.tagName !== "A") return;
  const href = node.getAttribute("href");
  if (href === null) return;
  if (!isSafeHref(href)) {
    // Belt and braces with `ALLOWED_URI_REGEXP`. The text stays; only the
    // navigation goes, which is the least surprising thing to lose.
    node.removeAttribute("href");
    return;
  }
  node.setAttribute("target", "_blank");
  node.setAttribute("rel", "noopener noreferrer");
}

/**
 * Images are rendered as links to the image instead of as `<img>`.
 *
 * The CSP is `img-src 'self' data:`, so a remote image cannot load anyway. The
 * choice is therefore only between a broken-image icon and a link, and dropping
 * the tag silently would be the worst of the three — the alt text would vanish
 * with it and the answer would read as if it had never mentioned a picture.
 */
export const IMAGES_BECOME_LINKS = true;

/** `marked`'s options. GFM is what makes tables tables. */
export const MARKED_OPTIONS = {
  async: false,
  gfm: true,
  /**
   * A single newline is a line break.
   *
   * Models write prose with one newline between lines and expect it to show.
   * Strict markdown would join those into one paragraph — and the chat already
   * behaved the other way, because the plain-text version this replaces was
   * rendered with `white-space: pre-wrap`.
   */
  breaks: true,
} as const;
