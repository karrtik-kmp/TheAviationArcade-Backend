import { ApiError } from "../common/errors.js";

/** The longest uid Firebase tokens are accepted with (src/auth/firebase.ts). */
export const MAX_UID_LENGTH = 128;

/**
 * Shared principal validator (plan R-b; also used by the operator command, R-c). Returns the uid when `value` is exactly
 * `firebase:<projectId>:<uid>` for the CONFIGURED project, otherwise undefined. The uid is 1-128 characters, has no
 * surrounding whitespace and contains no `:`, `/` or control character. `value` must already be URL-decoded.
 */
export function uidOfAccountPrincipal(value: unknown, projectId: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const prefix = `firebase:${projectId}:`;
  if (!value.startsWith(prefix)) return undefined;
  const uid = value.slice(prefix.length);
  if (uid.length < 1 || uid.length > MAX_UID_LENGTH) return undefined;
  if (uid.trim() !== uid) return undefined;
  if (/[:/]/.test(uid) || /\p{Cc}/u.test(uid)) return undefined;
  return uid;
}

/** The principal for a uid of the configured project. The uid is checked by the same rules as `uidOfAccountPrincipal`. */
export function accountPrincipalFor(uid: string, projectId: string): string | undefined {
  const principal = `firebase:${projectId}:${uid}`;
  return uidOfAccountPrincipal(principal, projectId) === undefined ? undefined : principal;
}

/** The principal itself, or 400 `invalid_request`. For route parameters. */
export function requireAccountPrincipal(value: unknown, projectId: string): string {
  if (uidOfAccountPrincipal(value, projectId) === undefined) {
    throw new ApiError(400, "invalid_request", `Expected a principal of the form firebase:${projectId}:<uid>.`);
  }
  return value as string;
}
