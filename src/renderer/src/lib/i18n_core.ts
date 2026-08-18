/**
 * Message lookup and interpolation, as pure functions.
 *
 * Kept apart from `i18n.svelte.ts` on purpose. That module holds the current
 * locale in a `$state` rune, which means it can only be compiled inside Svelte
 * and only be *run* by Svelte -- `tsx` cannot import it, so anything living
 * there is untestable. Everything here is a plain function over a plain object
 * and `tests/ui.ts` exercises it directly.
 *
 * There is no i18n library behind this. One locale, a flat map of dotted keys,
 * and `{name}` placeholders is the whole requirement, and a dependency that
 * brings ICU message syntax, a loader and a plural-rules table would be paying
 * for six features to use one.
 */

/** A locale's messages: dotted key -> English-style template. */
export type Catalog = Readonly<Record<string, string>>;

/** Values substituted into `{placeholder}` slots. */
export type MessageParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Looks up `key` and fills its placeholders.
 *
 * A key with no entry comes back as **the key itself** rather than as an empty
 * string. That is the whole design of the failure mode: `chat.send` sitting in
 * a button is unmistakable on sight and greppable, whereas a blank button is
 * indistinguishable from a styling bug and can ship.
 *
 * A placeholder with no matching parameter is left standing for the same
 * reason -- `{count}` in the middle of a sentence names its own omission.
 */
export function translate(catalog: Catalog, key: string, params?: MessageParams): string {
  const template = catalog[key];
  if (template === undefined) {
    return key;
  }
  if (params === undefined) {
    return template;
  }
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Looks up the singular or plural form of `key`, and passes `count` through.
 *
 * The catalogue holds `key.one` and `key.other`; the caller names only `key`.
 * English needs nothing cleverer than "is it exactly one", but keeping the
 * choice *here* rather than as a ternary at each call site means a language
 * with three forms is a change to this function and its catalogue, not to
 * forty components.
 */
export function translatePlural(
  catalog: Catalog,
  key: string,
  count: number,
  params?: MessageParams,
): string {
  return translate(catalog, `${key}.${count === 1 ? "one" : "other"}`, { ...params, count });
}

/**
 * Which of `keys` the catalogue has no entry for.
 *
 * Exists for the test suite: a missing message degrades to something visible
 * rather than something loud, so the only way it gets caught before a user
 * sees it is by asking.
 */
export function missingKeys(catalog: Catalog, keys: Iterable<string>): string[] {
  const missing: string[] = [];
  for (const key of keys) {
    if (catalog[key] === undefined) {
      missing.push(key);
    }
  }
  return missing;
}
