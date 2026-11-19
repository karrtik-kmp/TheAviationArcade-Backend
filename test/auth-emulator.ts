// e2e helper: Firebase accounts in the Auth Emulator (test/global-setup.ts starts it). The admin grant marks the account's email
// verified there (ADR-0002 follow-up 2026-11-19), so a grant target needs an emulator account with the token's uid.
// Admin calls use `Authorization: Bearer owner`, the emulator's privileged form.

const PROJECT = "demo-airplane-games";

function base(): string {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!host) throw new Error("FIREBASE_AUTH_EMULATOR_HOST is not set.");
  return `http://${host}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}`;
}

async function post(method: string, body: object): Promise<Record<string, unknown>> {
  const response = await fetch(`${base()}/${method}`, {
    method: "POST",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Auth Emulator ${method} answered ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

export type EmulatorUser = { email?: string | null; emailVerified?: boolean; disabled?: boolean };

/**
 * (Re)create the account `uid`. The default email is `<uid>@sites.test` (the emulator tokens' default, test/tokens.ts), unverified.
 * `email: null` creates an account without an email.
 */
export async function createFirebaseUser(uid: string, user: EmulatorUser = {}): Promise<void> {
  await deleteFirebaseUser(uid);
  const email = user.email === null ? undefined : (user.email ?? `${uid}@sites.test`).trim().toLowerCase();
  if (email !== undefined) await freeEmail(email);
  await post("accounts", { localId: uid, ...(email === undefined ? {} : { email, password: "not-a-real-password" }), emailVerified: user.emailVerified ?? false });
  if (user.disabled) await post("accounts:update", { localId: uid, disableUser: true });
}

/** Change the account's email (unverified), e.g. to the one a test then types at grant. */
export async function setFirebaseEmail(uid: string, email: string): Promise<void> {
  const address = email.trim().toLowerCase();
  await freeEmail(address, uid);
  await post("accounts:update", { localId: uid, email: address, emailVerified: false });
}

/** Firebase allows one account per email: delete any other test account holding `email` (earlier tests reuse addresses). */
async function freeEmail(email: string, keep?: string): Promise<void> {
  const json = await post("accounts:lookup", { email: [email] });
  const users = Array.isArray(json.users) ? (json.users as { localId?: string }[]) : [];
  for (const user of users) if (user.localId && user.localId !== keep) await deleteFirebaseUser(user.localId);
}

/** Remove the account if it exists. */
export async function deleteFirebaseUser(uid: string): Promise<void> {
  const response = await fetch(`${base()}/accounts:delete`, {
    method: "POST",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({ localId: uid }),
  });
  await response.body?.cancel();
}

/** The account as the emulator holds it, or undefined. */
export async function getFirebaseUser(uid: string): Promise<{ email?: string; emailVerified?: boolean; disabled?: boolean } | undefined> {
  const json = await post("accounts:lookup", { localId: [uid] });
  const users = Array.isArray(json.users) ? (json.users as Record<string, unknown>[]) : [];
  return users[0] as { email?: string; emailVerified?: boolean } | undefined;
}

/** The uid of a demo principal. */
export const uidOf = (principal: string): string => principal.slice(principal.lastIndexOf(":") + 1);
