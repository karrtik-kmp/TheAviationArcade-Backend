import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, errors, importX509, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

/**
 * Firebase ID token verification. Same checks and principal format as the website
 * (website/lib/firebase-verifier.ts) so a player is one principal across app, site and backend.
 */
const FIREBASE_JWKS = new URL(
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
);

/**
 * Product login is Firebase email/password, Google and Apple (project rule; Apple added 2026-11-27 for the app's
 * Sign in with Apple); `anonymous` guests only when the caller enables them.
 */
const ALLOWED_PROVIDERS = new Set(["password", "google.com", "apple.com"]);
const ANONYMOUS_PROVIDER = "anonymous";

export type FirebaseIdentity = {
  /** Server principal: firebase:<project>:<uid>. The only identifier stored against progress. */
  principal: string;
  uid: string;
  emailVerified: boolean;
  /** The token's email claim, only when it is a string of at most 320 chars. Only the role check's verified-email rule reads it; never stored. */
  email: string | undefined;
  /**
   * A Firebase Anonymous guest (docs/plans/guest-callsign.md G1): `sign_in_provider` is `anonymous` and `firebase.identities` holds
   * no `email` / `google.com` / `apple.com` login. A token that still names `anonymous` after `linkWithCredential` is an account (see guestFor).
   */
  anonymous: boolean;
  /** The token's `auth_time` claim in seconds; a session cookie is compared with the account's `validSince` (docs/plans/session-cookies.md C5). */
  authTime: number;
};

export type FirebaseTokenOptions = {
  projectId: string;
  /** Accept unsigned Auth Emulator tokens. Set only via emulatorTokensAllowed(). */
  emulator: boolean;
  /** Accept guests (FIREBASE_ANONYMOUS_PLAYERS). Off = a guest token is invalid (401); a linked `anonymous` token is still accepted. */
  anonymousPlayers?: boolean;
};

/** Firebase iat/auth_time may run slightly ahead of this server's clock. exp stays strict. */
const CLOCK_SKEW_SECONDS = 60;

/** The only project whose unsigned Auth Emulator tokens are ever accepted. */
export const EMULATOR_PROJECT_ID = "demo-airplane-games";

export class InvalidTokenError extends Error {
  constructor() {
    super("Invalid Firebase ID token.");
  }
}

/** Google's signing keys could not be fetched. Not the caller's fault: retry, never a 401. */
export class AuthUnavailableError extends Error {
  constructor() {
    super("Firebase signing keys are unavailable.");
  }
}

/**
 * Emulator tokens are unsigned, so they are accepted only when explicitly enabled AND the project
 * is exactly the demo project. The production project ID can never satisfy the second condition.
 */
export function emulatorTokensAllowed(projectId: string, flag: string | undefined): boolean {
  return flag === "true" && projectId === EMULATOR_PROJECT_ID;
}

/**
 * Wrap a key resolver so that any failure to obtain keys (non-200, bad JSON, timeout, network) is an
 * AuthUnavailableError, i.e. 503, never a 401 that would sign players out during a Google outage. Only
 * "this token's kid is not in the key set" is a property of the token, so it stays a validation error.
 */
export function failClosedKeys(inner: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (protectedHeader, token) => {
    try {
      return await inner(protectedHeader, token);
    } catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) {
        throw error;
      }
      throw new AuthUnavailableError();
    }
  };
}

const remoteFirebaseKeys = failClosedKeys(createRemoteJWKSet(FIREBASE_JWKS));

function invalidToken(): never {
  throw new InvalidTokenError();
}

/** The identity keys that make an `anonymous`-provider token a linked account: the three product logins (project rule). */
const LINKED_IDENTITY_KEYS = ["email", "google.com", "apple.com"] as const;

/**
 * Whether `firebase.identities` shows a linked product login: `email`, `google.com` or `apple.com` as a non-empty array of strings.
 * Other keys (phone, ...) do not count. `malformed` when the map, or one of those keys, has the wrong shape.
 */
function linkedIdentity(identities: unknown): boolean | "malformed" {
  if (identities === undefined) return false;
  if (identities === null || typeof identities !== "object" || Array.isArray(identities)) return "malformed";
  let linked = false;
  for (const key of LINKED_IDENTITY_KEYS) {
    const ids = (identities as Record<string, unknown>)[key];
    if (ids === undefined) continue;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0)) return "malformed";
    if (ids.length > 0) linked = true;
  }
  return linked;
}

/**
 * The guest test (docs/plans/guest-callsign.md G1). `password`, `google.com` and `apple.com` tokens are accounts. An `anonymous` token
 * whose identities hold `email`, `google.com` or `apple.com` is a LINKED account (whatever FIREBASE_ANONYMOUS_PLAYERS says: Firebase documents no
 * promise that `sign_in_provider` changes on `linkWithCredential`, and a rollback of the flag must not lock linked players out). Any
 * other `anonymous` token is a guest, accepted only with the flag. Undefined = refuse the token.
 */
function guestFor(provider: unknown, identities: unknown, anonymousPlayers: boolean): boolean | undefined {
  if (typeof provider !== "string") return undefined;
  if (ALLOWED_PROVIDERS.has(provider)) return false;
  if (provider !== ANONYMOUS_PROVIDER) return undefined;
  const linked = linkedIdentity(identities);
  if (linked === "malformed") return undefined;
  if (linked) return false;
  return anonymousPlayers ? true : undefined;
}

/** Longest session cookie Firebase issues: two weeks (docs/plans/session-cookies.md C2). */
const MAX_SESSION_COOKIE_SECONDS = 1_209_600;

export type CredentialKind = "idToken" | "sessionCookie";

const sessionIssuer = (projectId: string): string => `https://session.firebase.google.com/${projectId}`;

function validateIdentity(
  claims: JWTPayload,
  projectId: string,
  anonymousPlayers: boolean,
  kind: CredentialKind = "idToken",
): FirebaseIdentity {
  const now = Math.floor(Date.now() / 1000);
  const { sub, exp, iat } = claims;
  const authTime = claims.auth_time;
  const firebase =
    claims.firebase !== null && typeof claims.firebase === "object" && !Array.isArray(claims.firebase)
      ? (claims.firebase as Record<string, unknown>)
      : undefined;
  // A session cookie is a member credential: never a guest, whatever the flag says; `anonymous` (even linked) is refused.
  const provider = firebase?.sign_in_provider;
  const anonymous =
    kind === "sessionCookie"
      ? typeof provider === "string" && ALLOWED_PROVIDERS.has(provider)
        ? false
        : undefined
      : guestFor(provider, firebase?.identities, anonymousPlayers);
  const expectedIssuer = kind === "sessionCookie" ? sessionIssuer(projectId) : `https://securetoken.google.com/${projectId}`;
  const lifetimeBad =
    kind === "sessionCookie" &&
    (typeof exp !== "number" || typeof iat !== "number" || exp <= iat || exp - iat > MAX_SESSION_COOKIE_SECONDS);

  if (
    lifetimeBad ||
    claims.aud !== projectId ||
    claims.iss !== expectedIssuer ||
    typeof sub !== "string" ||
    sub.length === 0 ||
    sub.length > 128 ||
    sub.trim() !== sub ||
    typeof exp !== "number" ||
    !Number.isFinite(exp) ||
    exp <= now ||
    typeof iat !== "number" ||
    !Number.isFinite(iat) ||
    iat > now + CLOCK_SKEW_SECONDS ||
    typeof authTime !== "number" ||
    !Number.isFinite(authTime) ||
    authTime > now + CLOCK_SKEW_SECONDS ||
    anonymous === undefined
  ) {
    return invalidToken();
  }

  return {
    principal: `firebase:${projectId}:${sub}`,
    uid: sub,
    emailVerified: claims.email_verified === true,
    email: typeof claims.email === "string" && claims.email.length <= 320 ? claims.email : undefined,
    anonymous,
    authTime,
  };
}

/**
 * Verify a Firebase ID token against Google's signing keys. The key resolver parameter exists for
 * tests only; production callers omit it so only the fixed Firebase JWKS can verify tokens.
 *
 * Throws InvalidTokenError for a bad token and AuthUnavailableError when the keys cannot be fetched.
 *
 * Revocation is not checked: a disabled account's token stays valid until its (short) expiry.
 */
export async function verifyFirebaseToken(
  token: string,
  options: FirebaseTokenOptions,
  optionalKeyResolverForTests?: JWTVerifyGetKey,
): Promise<FirebaseIdentity> {
  if (token.length === 0 || token.length > 24_000 || !options.projectId.trim()) {
    return invalidToken();
  }

  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return invalidToken();
  }

  if (header.alg === "none") {
    // Defence in depth: the caller's flag alone is not enough, the project must be the demo one.
    if (!options.emulator || options.projectId !== EMULATOR_PROJECT_ID) return invalidToken();
    let claims;
    try {
      claims = decodeJwt(token);
    } catch {
      return invalidToken();
    }
    return validateIdentity(claims, options.projectId, options.anonymousPlayers === true);
  }

  if (header.alg !== "RS256") return invalidToken();
  try {
    const { payload } = await jwtVerify(token, optionalKeyResolverForTests ?? remoteFirebaseKeys, {
      algorithms: ["RS256"],
      issuer: `https://securetoken.google.com/${options.projectId}`,
      audience: options.projectId,
      requiredClaims: ["sub", "iat", "exp", "auth_time"],
      clockTolerance: 0,
    });
    return validateIdentity(payload, options.projectId, options.anonymousPlayers === true);
  } catch (error) {
    if (error instanceof InvalidTokenError || error instanceof AuthUnavailableError) throw error;
    // Key-fetch trouble is infrastructure, not a bad token. A missing kid (JWKSNoMatchingKey) and
    // every other JOSE error is a genuine validation failure. Non-JOSE errors (fetch TypeError)
    // can only come from the key fetch here.
    if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) {
      throw new AuthUnavailableError();
    }
    if (!(error instanceof errors.JOSEError)) throw new AuthUnavailableError();
    return invalidToken();
  }
}

// ---- Session cookies (docs/plans/session-cookies.md C1-C3, C7) ----

const SESSION_KEYS_URL = "https://www.googleapis.com/identitytoolkit/v3/relyingparty/publicKeys";
const KEY_FETCH_TIMEOUT_MS = 3_000;
const KEY_MIN_AGE_MS = 60_000;
const KEY_MAX_AGE_MS = 86_400_000;
const KEY_STALE_GRACE_MS = 3_600_000;
const KEY_REFETCH_COOLDOWN_MS = 60_000;
const KEY_FAILURE_BACKOFF_MS = 5_000;
const MAX_KEY_COUNT = 50;
const MAX_KID_LENGTH = 128;

export type SessionKeyOptions = {
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; tests inject a clock. */
  now?: () => number;
};

/**
 * The key resolver for Firebase session cookies. Google publishes them as a `{ kid: X.509 PEM }` map (not a JWKS), cached by
 * `Cache-Control: max-age`. One fetch in flight; an unknown `kid` refetches at most once a minute (inside the cooldown it is a 503,
 * so a random kid cannot make the website clear real members' cookies); any fetch/parse/import failure is AuthUnavailableError, the
 * last good set is served for up to an hour past its expiry, and a failure backs off for 5 s before the next fetch.
 */
export function sessionCookieKeys(options: SessionKeyOptions = {}): JWTVerifyGetKey {
  const fetchImpl = options.fetch ?? fetch;
  const clock = options.now ?? Date.now;
  let keys: Map<string, CryptoKey> | undefined;
  let expiresAt = 0;
  let lastFetchAt: number | undefined;
  let backoffUntil = 0;
  let inflight: Promise<void> | undefined;

  async function load(): Promise<void> {
    try {
      const response = await fetchImpl(SESSION_KEYS_URL, { signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new AuthUnavailableError();
      const body: unknown = await response.json();
      if (body === null || typeof body !== "object" || Array.isArray(body)) throw new AuthUnavailableError();
      const entries = Object.entries(body as Record<string, unknown>);
      if (entries.length === 0 || entries.length > MAX_KEY_COUNT) throw new AuthUnavailableError();
      const next = new Map<string, CryptoKey>();
      for (const [kid, pem] of entries) {
        if (typeof pem !== "string") throw new AuthUnavailableError();
        next.set(kid, await importX509(pem, "RS256"));
      }
      const directive = /(?:^|[\s,])max-age=(\d+)(?=$|[\s,])/i.exec(response.headers.get("cache-control") ?? "");
      const ageMs = directive ? Math.min(Math.max(Number(directive[1]) * 1000, KEY_MIN_AGE_MS), KEY_MAX_AGE_MS) : KEY_MIN_AGE_MS;
      const t = clock();
      keys = next;
      expiresAt = t + ageMs;
      lastFetchAt = t;
      backoffUntil = 0;
    } catch {
      backoffUntil = clock() + KEY_FAILURE_BACKOFF_MS;
      throw new AuthUnavailableError();
    }
  }

  function refresh(): Promise<void> {
    if (inflight) return inflight;
    if (clock() < backoffUntil) return Promise.reject(new AuthUnavailableError());
    inflight = load().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  return async (protectedHeader) => {
    const kid = protectedHeader.kid;
    if (typeof kid !== "string" || kid.length === 0 || kid.length > MAX_KID_LENGTH) {
      throw new errors.JWSInvalid("Session cookie kid is missing or malformed.");
    }
    if (keys && clock() < expiresAt) {
      const known = keys.get(kid);
      if (known) return known;
      // Unknown kid on a fresh set: refetch at most once per cooldown, otherwise a rotation cannot be told from a forged kid.
      if (lastFetchAt !== undefined && clock() - lastFetchAt < KEY_REFETCH_COOLDOWN_MS) throw new AuthUnavailableError();
      await refresh();
      const after = keys?.get(kid);
      if (after) return after;
      throw new errors.JWKSNoMatchingKey();
    }
    try {
      await refresh();
    } catch (error) {
      // A failed refresh: the last good set still serves for an hour past its expiry (a kid it lacks is undecidable, so 503).
      const stale = keys !== undefined && clock() < expiresAt + KEY_STALE_GRACE_MS ? keys.get(kid) : undefined;
      if (stale) return stale;
      throw error;
    }
    const fresh = keys?.get(kid);
    if (fresh) return fresh;
    throw new errors.JWKSNoMatchingKey();
  };
}

const defaultSessionKeys = sessionCookieKeys();

/**
 * Verify a website credential: a Firebase ID token or a Firebase session cookie. The unverified `iss` only chooses the path (exact
 * match on the session issuer); each path then verifies with its own fixed issuer, key set and RS256 only. Key parameters are for
 * tests only. Throws InvalidTokenError (401) or AuthUnavailableError (503). Revocation is not checked here.
 */
export async function verifyCredential(
  token: string,
  options: FirebaseTokenOptions,
  keysForTests?: { idToken?: JWTVerifyGetKey; sessionCookie?: JWTVerifyGetKey },
): Promise<{ identity: FirebaseIdentity; kind: CredentialKind }> {
  if (token.length === 0 || token.length > 24_000 || !options.projectId.trim()) return invalidToken();
  let unverifiedIssuer: unknown;
  try {
    unverifiedIssuer = decodeJwt(token).iss;
  } catch {
    return invalidToken();
  }
  if (unverifiedIssuer !== sessionIssuer(options.projectId)) {
    return { identity: await verifyFirebaseToken(token, options, keysForTests?.idToken), kind: "idToken" };
  }

  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return invalidToken();
  }
  if (header.alg === "none") {
    if (!options.emulator || options.projectId !== EMULATOR_PROJECT_ID) return invalidToken();
    let claims;
    try {
      claims = decodeJwt(token);
    } catch {
      return invalidToken();
    }
    return { identity: validateIdentity(claims, options.projectId, false, "sessionCookie"), kind: "sessionCookie" };
  }
  if (header.alg !== "RS256") return invalidToken();
  try {
    const { payload } = await jwtVerify(token, keysForTests?.sessionCookie ?? defaultSessionKeys, {
      algorithms: ["RS256"],
      issuer: sessionIssuer(options.projectId),
      audience: options.projectId,
      requiredClaims: ["sub", "iat", "exp", "auth_time"],
      clockTolerance: 0,
    });
    return { identity: validateIdentity(payload, options.projectId, false, "sessionCookie"), kind: "sessionCookie" };
  } catch (error) {
    if (error instanceof InvalidTokenError || error instanceof AuthUnavailableError) throw error;
    if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) throw new AuthUnavailableError();
    if (!(error instanceof errors.JOSEError)) throw new AuthUnavailableError();
    return invalidToken();
  }
}
