import type { ThrottlerStorage } from "@nestjs/throttler";
import type { SessionRevocation } from "../accounts/session-revocation.js";
import { ApiError } from "../common/errors.js";
import type { AppConfig } from "../config/config.module.js";
import { alreadyCounted, countAuthenticatedRequest } from "../platform/rate-limit.js";
import { AuthUnavailableError, verifyCredential } from "./firebase.js";
import type { CredentialKind, FirebaseIdentity } from "./firebase.js";

const UNAUTHORIZED_HEADERS = { "WWW-Authenticate": "Bearer" } as const;

const unauthorized = (): ApiError => new ApiError(401, "unauthorized", "Sign in required.", UNAUTHORIZED_HEADERS);
const unavailable = (retryAfterSeconds: number): ApiError =>
  new ApiError(503, "auth_unavailable", "Sign-in is temporarily unavailable. Retry shortly.", { "Retry-After": String(retryAfterSeconds) });

export type AuthenticateDeps = {
  config: Pick<AppConfig, "firebaseProjectId" | "emulatorTokens" | "anonymousPlayers" | "firebaseAdmin" | "rateLimitAuthPerMin">;
  revocation: Pick<SessionRevocation, "check">;
  storage: ThrottlerStorage;
};

export type Authenticated = { identity: FirebaseIdentity; kind: CredentialKind };

/**
 * One place that turns a Bearer token into an identity for FirebaseAuthGuard and the upload pre-reader (docs/plans/session-cookies.md
 * C6). Order, exactly:
 *  1. verify signature and claims: 401 `unauthorized`, or 503 `auth_unavailable` (Retry-After 5) when Google's keys are unreachable;
 *  2. a session cookie on a route that does not allow it: 401;
 *  3. a session cookie is counted against the principal's rate limit (the request is marked so RateLimitGuard skips it): 429;
 *  4. a session cookie with no Firebase Admin credential: 503 `auth_unavailable`, Retry-After 60 (operator error, never a 401 that
 *     would make the website clear every member's cookie);
 *  5. revocation: revoked / disabled / unknown account 401, lookup unavailable 503 (Retry-After 5).
 * An ID token skips 2-5 and behaves exactly as before; its rate-limit count stays with its caller (RateLimitGuard, or the pre-reader).
 */
export async function authenticate(token: string, deps: AuthenticateDeps, req: object, sessionCookieAllowed: boolean): Promise<Authenticated> {
  const { config } = deps;
  let verified: Authenticated;
  try {
    verified = await verifyCredential(token, {
      projectId: config.firebaseProjectId,
      emulator: config.emulatorTokens,
      anonymousPlayers: config.anonymousPlayers,
    });
  } catch (error) {
    // Google's keys being unreachable is our outage, not a bad token: tell the client to retry.
    if (error instanceof AuthUnavailableError) throw unavailable(5);
    throw unauthorized();
  }
  if (verified.kind === "idToken") return verified;

  if (!sessionCookieAllowed) throw unauthorized();
  const { identity } = verified;
  if (!alreadyCounted(req)) await countAuthenticatedRequest(deps.storage, config, identity.principal, req);
  if (config.firebaseAdmin === undefined) throw unavailable(60);
  const verdict = await deps.revocation.check(identity.uid, identity.authTime);
  if (verdict === "revoked") throw unauthorized();
  if (verdict === "not_configured") throw unavailable(60);
  if (verdict === "unavailable") throw unavailable(5);
  return verified;
}
