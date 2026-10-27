function base64url(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unsigned token shaped like the Firebase Auth Emulator's. */
export function emulatorToken(
  uid: string,
  projectId = "demo-airplane-games",
  provider = "password",
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
    email: `${uid}@sites.test`,
    email_verified: true,
    firebase: { sign_in_provider: provider },
  };
  return `${base64url(header)}.${base64url(claims)}.`;
}
