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
