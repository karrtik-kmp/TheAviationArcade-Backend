function base64url(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unsigned token shaped like the Firebase Auth Emulator's. */
export function emulatorToken(
  uid: string,
  projectId = "demo-airplane-games",
  provider = "password",
  /** email: null omits the claim; the default is `<uid>@sites.test`. */
  options: { email?: string | null; emailVerified?: boolean } = {},
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
    firebase: { sign_in_provider: provider },
  };
  return `${base64url(header)}.${base64url(claims)}.`;
}
