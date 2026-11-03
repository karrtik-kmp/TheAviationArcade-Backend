import { ApiError } from "../common/errors.js";

/** Same limit as the `account_roles` CHECKs on `request_email` and `grant_email`, in code points (Postgres length). */
export const MIN_EMAIL_LENGTH = 3;
export const MAX_EMAIL_LENGTH = 320;

/**
 * Shared validator for an email TYPED by an admin or the operator (plan R-d): trimmed, lowercased, exactly one `@` with text on
 * both sides, no whitespace or control character, 3-320 code points. A typed email is unverified and display only, never used
 * for authorisation. Throws 400 `invalid_request`. (A token email in `request_email` is stored as the token gives it.)
 */
export function normalizeTypedEmail(value: unknown): string {
  const invalid = (why: string) => new ApiError(400, "invalid_request", `The email is not acceptable: ${why}.`);
  if (typeof value !== "string") throw invalid("expected a string");
  // Cheap bound first, so a huge string is never lowercased or spread into an array.
  if (value.length > MAX_EMAIL_LENGTH * 2 + 64) throw invalid(`at most ${MAX_EMAIL_LENGTH} characters`);
  const email = value.trim().toLowerCase();
  const length = [...email].length;
  if (length < MIN_EMAIL_LENGTH || length > MAX_EMAIL_LENGTH) throw invalid(`${MIN_EMAIL_LENGTH} to ${MAX_EMAIL_LENGTH} characters`);
  if (/[\s\p{Cc}]/u.test(email)) throw invalid("no spaces or control characters");
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid("exactly one @ with text on both sides");
  return email;
}
