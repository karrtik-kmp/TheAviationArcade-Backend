/** A photo description: staff-only text of 1-2000 characters (code points, as Postgres length() counts them). */
export const MEDIA_DESCRIPTION_MAX = 2000;

/** A review reason (docs/plans/media-review-feedback.md R2): staff-written text of 1-500 code points, the same text rules as a description. */
export const MEDIA_REVIEW_REASON_MAX = 500;

/** Every control character except line feed. */
const CONTROL_EXCEPT_LF = /[^\P{Cc}\n]/u;

/** A lone surrogate (a UTF-16 unit that is not half of a pair); with the `u` flag a valid pair is one code point and never matches. */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * The stored form of a staff text, or null when it is not acceptable. CRLF becomes LF; then `\n` is the only control character
 * allowed anywhere, leading and trailing included (a lone CR, a tab and the rest are refused, never stripped); then surrounding
 * whitespace is trimmed and the result must be 1-`max` code points.
 */
export function normaliseMediaText(value: string, max: number): string | null {
  const unified = value.replace(/\r\n/g, "\n");
  if (CONTROL_EXCEPT_LF.test(unified)) return null;
  const text = unified.trim();
  const length = [...text].length;
  return length >= 1 && length <= max ? text : null;
}

/** The stored form of a description (1-2000 code points). Shared by the PATCH route and the D1 import, which refuse rather than truncate or strip. */
export function normaliseMediaDescription(value: string): string | null {
  return normaliseMediaText(value, MEDIA_DESCRIPTION_MAX);
}

/** The stored form of a review reason (1-500 code points): the description rules plus a well-formed check (a lone surrogate is refused). */
export function normaliseMediaReason(value: string): string | null {
  return LONE_SURROGATE.test(value) ? null : normaliseMediaText(value, MEDIA_REVIEW_REASON_MAX);
}
