/**
 * The viewer's calendar day for the Plane of the Day read (docs/plans/website-content.md §1.4). The server takes an IANA time zone
 * and computes the day itself from the DATABASE instant; no client clock or client-sent date is trusted.
 */

/** 1-64 characters, a letter first (so no leading `+` or `-`), then letters, digits, `_`, `/` and `-`. No `.`, so no `..` path tricks. */
const ZONE_TEXT = /^[A-Za-z][A-Za-z0-9_/-]{0,63}$/;

/** The furthest real zone ahead of UTC (Pacific/Kiritimati, `Etc/GMT-14`). No viewer's day can be later than this zone's. */
export const FURTHEST_AHEAD_ZONE = "Etc/GMT-14";

/**
 * The resolved zone name when `raw` is a real IANA zone, else undefined. Offset zones are refused even though Node 24 accepts them
 * (`+2359`, `+23:59`, `+14`, `-05`): `+23:59` would show tomorrow's UTC feature from 00:01 UTC. Both the text form and the zone
 * Node resolved are checked, so an offset spelling cannot get through either way.
 */
export function parseTimeZone(raw: string): string | undefined {
  if (!ZONE_TEXT.test(raw)) return undefined;
  let resolved: string | undefined;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  if (typeof resolved !== "string" || resolved === "" || resolved.startsWith("+") || resolved.startsWith("-")) return undefined;
  return resolved;
}

/** `YYYY-MM-DD` of the instant in the zone, from `formatToParts` (the numeric parts, never the locale's output format). */
export function calendarDay(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const part = (type: "year" | "month" | "day"): string => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`No ${type} part for time zone ${timeZone}.`);
    return found.value;
  };
  return `${part("year").padStart(4, "0")}-${part("month").padStart(2, "0")}-${part("day").padStart(2, "0")}`;
}

/**
 * The day a viewer in `timeZone` is in at `now`, never later than the date in the furthest-ahead real zone. The clamp is an
 * independent bound: whatever the zone resolves to, the worst case is the next UTC date from 10:00 UTC, never the one after.
 */
export function viewerDay(timeZone: string, now: Date): string {
  return clampToFurthest(calendarDay(timeZone, now), now);
}

/** `day`, or, when it is later than the date in the furthest-ahead zone at `now`, that date. `YYYY-MM-DD` strings compare as dates. */
export function clampToFurthest(day: string, now: Date): string {
  const bound = calendarDay(FURTHEST_AHEAD_ZONE, now);
  return day <= bound ? day : bound;
}
