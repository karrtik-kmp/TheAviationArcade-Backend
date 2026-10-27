import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

/**
 * Firebase ID token verification. Same checks and principal format as the website
 * (website/lib/firebase-verifier.ts) so a player is one principal across app, site and backend.
 */
const FIREBASE_JWKS = new URL(
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
);

/** Product login is Firebase email/password and Google only (project rule). */
const ALLOWED_PROVIDERS = new Set(["password", "google.com"]);

export type FirebaseIdentity = {
  /** Server principal: firebase:<project>:<uid>. The only identifier stored against progress. */
  principal: string;
  uid: string;
  emailVerified: boolean;
};

export type FirebaseTokenOptions = {
  projectId: string;
  /** Accept unsigned Auth Emulator tokens. Set only via emulatorTokensAllowed(). */
  emulator: boolean;
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

function validateIdentity(claims: JWTPayload, projectId: string): FirebaseIdentity {
  const now = Math.floor(Date.now() / 1000);
  const { sub, exp, iat } = claims;
  const authTime = claims.auth_time;
  const firebase = claims.firebase;
  const provider =
    firebase !== null && typeof firebase === "object" && !Array.isArray(firebase)
      ? (firebase as Record<string, unknown>).sign_in_provider
      : undefined;

  if (
    claims.aud !== projectId ||
    claims.iss !== `https://securetoken.google.com/${projectId}` ||
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
    typeof provider !== "string" ||
    !ALLOWED_PROVIDERS.has(provider)
  ) {
    return invalidToken();
  }

  return {
    principal: `firebase:${projectId}:${sub}`,
    uid: sub,
    emailVerified: claims.email_verified === true,
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
    return validateIdentity(claims, options.projectId);
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
    return validateIdentity(payload, options.projectId);
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
