/**
 * The current locale, and the `t()` every component calls.
 *
 * **The `.svelte.ts` extension is load-bearing.** `locale` below is a `$state`
 * rune, and runes are only compiled inside `.svelte` and `.svelte.js/ts`
 * modules. In a plain `.ts` this file would typecheck cleanly and then throw
 * `rune_outside_svelte` the moment it was imported -- and `svelte-check` would
 * not say a word, because as far as TypeScript is concerned nothing is wrong.
 * `bridge.svelte.ts` carries the same warning for the same reason.
 *
 * Holding the locale in module-level `$state` is what makes translation live:
 * `t()` reads it, components call `t()` while rendering, so every string in the
 * window is downstream of one variable. Changing the language re-renders the
 * app rather than requiring a reload.
 *
 * The lookup and interpolation themselves are in `i18n_core.ts`, which has no
 * runes and can therefore be tested.
 */

import { DEFAULT_UI_SETTINGS, type Language } from "../../../shared/settings.js";
import { translate, translatePlural, type Catalog, type MessageParams } from "./i18n_core.js";
import { en } from "./locales/en.js";

const CATALOGS: Readonly<Record<Language, Catalog>> = { en };

let locale = $state<Language>(DEFAULT_UI_SETTINGS.language);

/**
 * Switches the language.
 *
 * Assigns unconditionally, and the missing `if (locale !== next)` guard is the
 * point. Svelte already skips the update when a `$state` primitive is assigned
 * its current value, so the guard bought nothing -- and it *read* `locale`,
 * which is what made it actively wrong. `App.svelte` calls this from an
 * `$effect.pre`; a read inside that effect made the effect depend on the very
 * variable it sets, so any change to the locale from anywhere else re-ran it
 * and put the old value straight back. Setting the language appeared to do
 * nothing at all.
 */
export function setLocale(next: Language): void {
  locale = next;
}

export function currentLocale(): Language {
  return locale;
}

/** A message by key, with `{placeholder}` slots filled from `params`. */
export function t(key: string, params?: MessageParams): string {
  return translate(CATALOGS[locale], key, params);
}

/**
 * A message by key in its singular or plural form, chosen by `count`.
 *
 * The catalogue holds `key.one` and `key.other`; callers name only `key`, and
 * `count` is passed through as a parameter so the message can print it.
 */
export function tn(key: string, count: number, params?: MessageParams): string {
  return translatePlural(CATALOGS[locale], key, count, params);
}

