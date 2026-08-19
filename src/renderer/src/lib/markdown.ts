/**
 * Turning a model's answer into HTML the chat can inject.
 *
 * The policy — which tags, which attributes, which URL schemes — lives next
 * door in `markdown_policy.ts`, deliberately apart from the machinery, because
 * the policy is the part worth reading and the part worth auditing.
 *
 * ## The order is the whole thing
 *
 * `sanitize(parse(source))`, never the other way round. Sanitising the markdown
 * and then parsing it would hand `marked` a string it is entitled to turn back
 * into markup — the sanitiser would have run against text that is not what the
 * browser ends up seeing, which is exactly as useful as not running it.
 *
 * ## Why the sanitiser is a parameter
 *
 * DOMPurify needs a DOM. The renderer has one; `tsx` running the test suites
 * does not, and would have to be handed a jsdom window. Passing the purifier in
 * lets both callers exist without this module knowing which world it is in —
 * the same test seam `agent.ts` uses for the language model, and for the same
 * reason: the interesting behaviour is ours, and it should be exercisable
 * without the environment it normally runs in.
 */

import { marked, type Tokens } from "marked";

import { hardenLink, MARKED_OPTIONS, SANITIZE_CONFIG } from "./markdown_policy.js";

/**
 * The slice of DOMPurify this module uses.
 *
 * Narrow on purpose: the browser's default export and a jsdom-backed instance
 * both satisfy it, and neither has to be imported here.
 */
export interface Purifier {
  sanitize(dirty: string, config: Record<string, unknown>): string;
  addHook(entryPoint: string, hook: (node: Element) => void): void;
}

/**
 * `marked` is configured once, at module scope.
 *
 * It keeps its options globally, so configuring per call would mean either
 * repeating the work on every message or — worse — leaving whichever call ran
 * last in charge of the settings.
 */
marked.use({
  ...MARKED_OPTIONS,
  renderer: {
    /**
     * An image becomes a link to the image.
     *
     * `img-src` is `'self' data:`, so a remote one cannot load whatever we do
     * here; the real choice is between a broken-image icon and something
     * readable. Doing it in the renderer rather than by dropping `img` from the
     * allowlist is what keeps the alt text: a stripped tag takes its own
     * attributes with it, and the sentence would lose the fact that a picture
     * was mentioned at all.
     */
    image({ href, title, text }: Tokens.Image): string {
      const label = text.trim() === "" ? href : text;
      const anchor = escapeHtml(href);
      return `<a href="${anchor}" title="${escapeHtml(title ?? label)}">${escapeHtml(label)}</a>`;
    },
  },
});

/**
 * Minimal HTML escaping for the strings this file builds itself.
 *
 * Only used for the image-to-link rewrite above. Everything else is `marked`'s
 * own output, and everything without exception goes through the sanitiser
 * afterwards — this is here so the rewrite does not *introduce* a hole that the
 * sanitiser then has to catch.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Whether `withPurifier` has already registered the link hook on an instance. */
const hooked = new WeakSet<Purifier>();

/**
 * Renders `source` to HTML that is safe to inject.
 *
 * The link hook is registered the first time a given purifier is seen. Hooks
 * are global to a DOMPurify instance and are *added*, not replaced, so calling
 * `addHook` per message would stack a new copy of the same hook on every turn.
 */
export function toSafeHtml(source: string, purify: Purifier): string {
  if (!hooked.has(purify)) {
    purify.addHook("afterSanitizeAttributes", hardenLink);
    hooked.add(purify);
  }
  // `async: false` is in the options, so this is a string and not a promise.
  const html = marked.parse(source) as string;
  return purify.sanitize(html, SANITIZE_CONFIG as unknown as Record<string, unknown>);
}
