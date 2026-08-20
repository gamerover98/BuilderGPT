/**
 * How long ago a schematic was opened, as a decision rather than a string.
 *
 * Returns which form to use and the number to put in it; the component turns
 * that into words with `t()`. Splitting it this way is what makes the
 * boundaries testable — there are five of them, each an off-by-one waiting to
 * happen, and none of them observable from a component that reads the clock
 * itself.
 */

export type OpenedAge =
  /** No timestamp was recorded — an entry from before the list kept them. */
  | { kind: "none" }
  | { kind: "justNow" }
  | { kind: "minutes"; count: number }
  | { kind: "hours"; count: number }
  | { kind: "days"; count: number }
  /** Older than a week: show the date itself, not the distance. */
  | { kind: "date" };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function openedAge(openedAt: number, now: number): OpenedAge {
  // Zero means "never recorded". Anything in the future is a clock that moved
  // backwards — a timezone change, an NTP correction — and "just now" is the
  // honest reading of a moment that has not happened yet.
  // `!(x > 0)` rather than `x <= 0` so a NaN lands here too: the generated-file
  // list stores its timestamp as an ISO string, and a `Date.parse` of a
  // corrupted one otherwise fell through every branch below and rendered
  // "Invalid Date".
  if (!(openedAt > 0)) return { kind: "none" };

  const elapsed = now - openedAt;
  if (elapsed < MINUTE) return { kind: "justNow" };
  if (elapsed < HOUR) return { kind: "minutes", count: Math.floor(elapsed / MINUTE) };
  if (elapsed < DAY) return { kind: "hours", count: Math.floor(elapsed / HOUR) };
  if (elapsed < WEEK) return { kind: "days", count: Math.floor(elapsed / DAY) };

  // Past a week the elapsed time stops being the useful fact and the calendar
  // date starts being one: "9d ago" is arithmetic the reader has to do.
  return { kind: "date" };
}
