/**
 * The hostile inputs the chat's markdown renderer has to survive.
 *
 * Kept apart from `tests/ui.ts` so the list reads as a list. Each case is a
 * string a model could plausibly emit -- either because it was asked to, or
 * because something upstream of it was -- paired with what must not survive.
 *
 * `mustNotContain` is checked against the *rendered HTML*, lowercased. It is
 * deliberately crude: these are not assertions about how DOMPurify chooses to
 * neutralise something, only that the dangerous substring is gone. A test that
 * pinned the exact output would fail on a DOMPurify upgrade that got safer.
 */

export interface HostileCase {
  readonly name: string;
  readonly source: string;
  /** Lowercased substrings that must be absent from the rendered HTML. */
  readonly mustNotContain: readonly string[];
  /** Substrings that must survive -- the text should not vanish with the tag. */
  readonly mustContain?: readonly string[];
}

export const HOSTILE_CASES: readonly HostileCase[] = [
  {
    name: "a script tag",
    source: "hello <script>alert(1)</script> world",
    mustNotContain: ["<script", "alert(1)"],
    mustContain: ["hello", "world"],
  },
  {
    name: "an inline event handler",
    source: '<img src=x onerror="alert(1)">',
    mustNotContain: ["onerror", "<img"],
  },
  {
    name: "a javascript: link",
    source: "[click me](javascript:alert(1))",
    mustNotContain: ["javascript:"],
    // The words stay; only the navigation goes.
    mustContain: ["click me"],
  },
  {
    name: "a javascript: link with the scheme split by a tab",
    source: '<a href="java\tscript:alert(1)">click</a>',
    mustNotContain: ["javascript:", "java\tscript:"],
  },
  {
    name: "a data: URL that is really a document",
    source: "[doc](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    mustNotContain: ["data:text/html"],
  },
  /*
   * These two are what make `hardenLink` load-bearing rather than decoration.
   * DOMPurify's own default URI expression permits `mailto:` and `tel:` -- they
   * are perfectly ordinary on a web page -- so nothing but this app's own
   * http/https rule takes them off. Without a case like this the hook could be
   * deleted entirely and the suite would not notice, which is how a redundant
   * layer quietly becomes an absent one.
   */
  {
    name: "a mailto link, which DOMPurify itself allows",
    source: "[write](mailto:someone@example.com)",
    mustNotContain: ["mailto:"],
    mustContain: ["write"],
  },
  {
    name: "a tel link, likewise",
    source: "[call](tel:+15550100)",
    mustNotContain: ["tel:+15550100"],
    mustContain: ["call"],
  },
  {
    name: "an inline style, which the CSP would actually honour",
    source: '<p style="position:fixed;inset:0;background:url(https://x/y)">covered</p>',
    mustNotContain: ["style=", "position:fixed"],
    mustContain: ["covered"],
  },
  {
    name: "an iframe",
    source: '<iframe src="https://example.com"></iframe>',
    mustNotContain: ["<iframe"],
  },
  {
    name: "markup smuggled inside a table cell",
    source: "| a | b |\n|---|---|\n| <script>alert(1)</script> | ok |",
    mustNotContain: ["<script", "alert(1)"],
    mustContain: ["<table", "ok"],
  },
  {
    name: "a script inside svg, which is not an html script tag",
    source: "<svg><script>alert(1)</script></svg>",
    mustNotContain: ["<svg", "<script", "alert(1)"],
  },
  {
    name: "a form that could phish",
    source: '<form action="https://evil.example"><input name="key"></form>',
    mustNotContain: ["<form", "<input"],
  },
  {
    name: "an id that could steal a label",
    source: '<p id="description">text</p>',
    mustNotContain: ['id="description"'],
    mustContain: ["text"],
  },
  {
    name: "a base tag, which would re-point every relative URL",
    source: '<base href="https://evil.example/">',
    mustNotContain: ["<base"],
  },
];
