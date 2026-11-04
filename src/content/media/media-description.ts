/** A photo description: staff-only text of 1-2000 characters (code points, as Postgres length() counts them). */
export const MEDIA_DESCRIPTION_MAX = 2000;

/** Every control character except line feed. */
const CONTROL_EXCEPT_LF = /[^\P{Cc}\n]/u;

/**
 * The stored form of a description, or null when it is not acceptable. CRLF becomes LF; then `\n` is the only control character
 * allowed anywhere, leading and trailing included (a lone CR, a tab and the rest are refused, never stripped); then surrounding
 * whitespace is trimmed and the result must be 1-2000 code points. Shared by the PATCH route and the D1 import, which refuse
 * rather than truncate or strip.
 */
export function normaliseMediaDescription(value: string): string | null {
  const unified = value.replace(/\r\n/g, "\n");
  if (CONTROL_EXCEPT_LF.test(unified)) return null;
  const text = unified.trim();
  const length = [...text].length;
  return length >= 1 && length <= MEDIA_DESCRIPTION_MAX ? text : null;
}
