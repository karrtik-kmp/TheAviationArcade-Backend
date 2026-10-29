import { createRemoteJWKSet, decodeProtectedHeader, errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { AuthUnavailableError, failClosedKeys } from "../auth/firebase.js";

/**
 * UGS (Unity Authentication) player token verification. Verified 2026-10-28 from the UGS docs: RS256, JWKS at
 * the URL below (kid `public:<uuid>`), iss `https://player-auth.services.api.unity.com`, `sub` = the UGS player
 * id, `exp`/`nbf`. UNVERIFIED until a real token is decoded: the project and environment claim names
 * (`project_id` or `upid`, `envId`) and the `idd` claim, which only a support article describes. The code
 * therefore requires a project claim from either name, checks `envId` whenever it is present, and ignores `idd`.
 */
export const UGS_ISSUER = "https://player-auth.services.api.unity.com";
const UGS_JWKS = new URL("https://player-auth.services.api.unity.com/.well-known/jwks.json");

/** The token is not acceptable. `reason` is safe to show: it names the failed check, never a claim value. */
export class InvalidUgsTokenError extends Error {
  constructor(readonly reason: string) {
    super(`UGS token rejected: ${reason}.`);
  }
}

export type UgsTokenOptions = { projectId: string; environmentId: string };

/** Same fail-closed handling as Firebase: unreachable keys are AuthUnavailableError (503), never a bad token. */
export const remoteUgsKeys: JWTVerifyGetKey = failClosedKeys(createRemoteJWKSet(UGS_JWKS));

const PLAYER_ID = /^[A-Za-z0-9_-]{1,64}$/;

function stringClaim(claims: JWTPayload, name: string): string | undefined {
  const value = claims[name];
  return typeof value === "string" ? value : undefined;
}

/** Returns the UGS player id (`sub`). Throws InvalidUgsTokenError or AuthUnavailableError. */
export async function verifyUgsToken(
  token: string,
  options: UgsTokenOptions,
  keys: JWTVerifyGetKey = remoteUgsKeys,
): Promise<{ ugsPlayerId: string }> {
  if (token.length === 0 || token.length > 8000) throw new InvalidUgsTokenError("malformed");
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "RS256") throw new InvalidUgsTokenError("unsupported algorithm");
  } catch (error) {
    if (error instanceof InvalidUgsTokenError) throw error;
    throw new InvalidUgsTokenError("malformed");
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      issuer: UGS_ISSUER,
      requiredClaims: ["sub", "exp"],
      clockTolerance: 5,
    }));
  } catch (error) {
    if (error instanceof AuthUnavailableError) throw error;
    if (error instanceof errors.JWTExpired) throw new InvalidUgsTokenError("expired");
    if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) throw new AuthUnavailableError();
    if (!(error instanceof errors.JOSEError)) throw new AuthUnavailableError();
    if (error instanceof errors.JWTClaimValidationFailed && error.claim === "iss") {
      throw new InvalidUgsTokenError("wrong issuer");
    }
    throw new InvalidUgsTokenError("signature or claims invalid");
  }

  // A project claim is mandatory (either name); every one present must match. envId is checked when present.
  const projectClaims = [stringClaim(payload, "project_id"), stringClaim(payload, "upid")].filter(
    (value): value is string => value !== undefined,
  );
  if (projectClaims.length === 0) throw new InvalidUgsTokenError("no project claim");
  if (projectClaims.some((value) => value !== options.projectId)) throw new InvalidUgsTokenError("wrong project");
  if ("envId" in payload && stringClaim(payload, "envId") !== options.environmentId) {
    throw new InvalidUgsTokenError("wrong environment");
  }

  const sub = payload.sub;
  if (typeof sub !== "string" || !PLAYER_ID.test(sub)) throw new InvalidUgsTokenError("bad subject");
  return { ugsPlayerId: sub };
}
