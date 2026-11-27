import { generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { KJUR } from "jsrsasign";
import { SignJWT } from "jose";

function base64url(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unsigned token shaped like the Firebase Auth Emulator's. */
/** A Firebase Anonymous guest's emulator token: no email claim, empty identities (docs/plans/guest-callsign.md G1). */
export function guestToken(uid: string, projectId = "demo-airplane-games"): string {
  return emulatorToken(uid, projectId, "anonymous", { email: null, emailVerified: false, identities: {} });
}

/** The same uid after linking email/password: a password token with an email identity (the uid stays, ruling 2026-11-26). */
export function linkedToken(uid: string, projectId = "demo-airplane-games"): string {
  return emulatorToken(uid, projectId, "password", { emailVerified: false, identities: { email: [`${uid}@sites.test`] } });
}

export function emulatorToken(
  uid: string,
  projectId = "demo-airplane-games",
  provider = "password",
  /** email: null omits the claim; the default is `<uid>@sites.test`. identities: the `firebase.identities` map (omitted when unset). */
  options: { email?: string | null; emailVerified?: boolean; identities?: unknown } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "none", typ: "JWT" };
  const claims = {
    iss: `https://securetoken.google.com/${projectId}`,
    aud: projectId,
    sub: uid,
    iat: now - 10,
    exp: now + 3600,
    auth_time: now - 10,
    ...(options.email === null ? {} : { email: options.email ?? `${uid}@sites.test` }),
    email_verified: options.emailVerified ?? true,
    firebase: { sign_in_provider: provider, ...(options.identities === undefined ? {} : { identities: options.identities }) },
  };
  return `${base64url(header)}.${base64url(claims)}.`;
}

/** An unsigned session cookie shaped like the Auth Emulator's `createSessionCookie`: `alg: none`, the session issuer. */
export function emulatorSessionCookie(
  uid: string,
  projectId = "demo-airplane-games",
  provider = "password",
  options: { lifetimeSeconds?: number; identities?: unknown } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: `https://session.firebase.google.com/${projectId}`,
    aud: projectId,
    sub: uid,
    iat: now - 10,
    exp: now - 10 + (options.lifetimeSeconds ?? 432_000),
    auth_time: now - 10,
    email: `${uid}@sites.test`,
    email_verified: true,
    firebase: { sign_in_provider: provider, ...(options.identities === undefined ? {} : { identities: options.identities }) },
  };
  return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claims)}.`;
}

export type SessionTestKey = { kid: string; privateKey: KeyObject; publicKey: KeyObject; certPem: string };

/** A fresh RSA key with a self-signed X.509 certificate, as Google's `publicKeys` endpoint publishes them. */
export function makeSessionKey(kid: string): SessionTestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const certificate = new KJUR.asn1.x509.Certificate({
    version: 3,
    serial: { int: 1 },
    issuer: { str: "/CN=session-test" },
    notbefore: "200101000000Z",
    notafter: "400101000000Z",
    subject: { str: "/CN=session-test" },
    sbjpubkey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sigalg: "SHA256withRSA",
    cakey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  } as never);
  return { kid, privateKey, publicKey, certPem: certificate.getPEM() };
}

export type SignedCookieOptions = {
  uid?: string;
  provider?: string;
  identities?: unknown;
  issuerProject?: string;
  audience?: string;
  /** Seconds relative to now. */
  iat?: number;
  exp?: number;
  authTime?: number;
  /** `null` omits the header kid. */
  kid?: string | null;
};

/** A signed session cookie (RS256). Defaults are valid: five days, password sign-in. */
export async function signedSessionCookie(
  key: SessionTestKey,
  projectId: string,
  options: SignedCookieOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header: { alg: string; kid?: string } = { alg: "RS256" };
  if (options.kid !== null) header.kid = options.kid ?? key.kid;
  const identities = options.identities;
  return new SignJWT({
    auth_time: now + (options.authTime ?? -60),
    email: "member@sites.test",
    email_verified: true,
    firebase: { sign_in_provider: options.provider ?? "password", ...(identities === undefined ? {} : { identities }) },
  })
    .setProtectedHeader(header)
    .setIssuer(`https://session.firebase.google.com/${options.issuerProject ?? projectId}`)
    .setAudience(options.audience ?? projectId)
    .setSubject(options.uid ?? "uid-123")
    .setIssuedAt(now + (options.iat ?? -60))
    .setExpirationTime(now + (options.exp ?? 432_000))
    .sign(key.privateKey);
}
