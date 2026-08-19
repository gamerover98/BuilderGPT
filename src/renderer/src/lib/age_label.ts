/**
 * "3 hours ago", from a timestamp.
 *
 * The arithmetic is `recent_age.ts`, which is pure and tested; this is only the
 * wording, and it lives here because two places now need it — the recently
 * opened list and the conversation picker. Two of these in one window would be
 * two chances to phrase it differently, and eventually two chances to get the
 * boundaries wrong.
 */

import { t } from "./i18n.svelte.js";
import { openedAge } from "./recent_age.js";

/** Empty string when no time was recorded, which the callers render as nothing. */
export function ageLabel(at: number, now = Date.now()): string {
  const age = openedAge(at, now);
  switch (age.kind) {
    case "none":
      return "";
    case "justNow":
      return t("doc.openedJustNow");
    case "minutes":
      return t("doc.openedMinutes", { count: age.count });
    case "hours":
      return t("doc.openedHours", { count: age.count });
    case "days":
      return t("doc.openedDays", { count: age.count });
    default:
      // `toLocaleDateString` follows the OS rather than our locale, which is
      // the right authority for a date: it is how every other date on this
      // machine is written.
      return new Date(at).toLocaleDateString();
  }
}
