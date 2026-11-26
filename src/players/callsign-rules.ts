/**
 * Callsign rules (docs/plans/guest-callsign.md C1). Mirrors Unity `CallsignRules` (Application/Services/CallsignRules.cs): trim,
 * upper-case, then 3 to 16 of A-Z / 0-9. One deliberate difference: the server checks ASCII BEFORE upper-casing, so letters
 * that upper-case to ASCII (`ı`, `ſ`, and in JS also `ß` -> `SS`) are invalid here though Unity's client check passes them. The
 * app sends the normalized value, so this only matters for those few letters.
 */

export const CALLSIGN_MIN_LENGTH = 3;
export const CALLSIGN_MAX_LENGTH = 16;
/** Longest raw value the availability route echoes back; anything longer is `invalid` and echoed cut to this length. */
export const CALLSIGN_RAW_MAX = 64;

const TRIMMED_VALID = /^[A-Za-z0-9]{3,16}$/;

/**
 * ASSUMPTION (plan C1): Unity has no reserved or profanity list, so the server reserves only names that would impersonate staff,
 * plus the app's own placeholders (`PILOT` is the greeting when no Callsign is set; `GUEST`). Exact matches only. A client
 * profanity list is an open client question (Unity docs/implementation/CLIENT_CONTENT_IMPORT.md).
 */
export const RESERVED_CALLSIGNS: ReadonlySet<string> = new Set([
  "ADMIN",
  "ADMINISTRATOR",
  "MODERATOR",
  "STAFF",
  "SUPPORT",
  "SYSTEM",
  "OFFICIAL",
  "PILOT",
  "GUEST",
]);

/** ASSUMPTION (plan C1): after the one free change, a Callsign may change once per 30 days. */
export const CALLSIGN_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** The normalized Callsign, or null when the value breaks the format. Reserved names are normalized (see isReservedCallsign). */
export function normalizeCallsign(raw: string): string | null {
  if (raw.length > CALLSIGN_RAW_MAX) return null;
  const trimmed = raw.trim();
  return TRIMMED_VALID.test(trimmed) ? trimmed.toUpperCase() : null;
}

export function isReservedCallsign(normalized: string): boolean {
  return RESERVED_CALLSIGNS.has(normalized);
}
