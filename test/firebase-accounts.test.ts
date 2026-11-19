import { exportPKCS8, generateKeyPair, decodeJwt, decodeProtectedHeader } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { firebaseAccountsFor, IdentityToolkitAccounts } from "../src/accounts/firebase-accounts.js";
import type { FirebaseAdminConfig } from "../src/config/config.module.js";

// The Firebase admin client in service-account mode, against a fake fetch (ADR-0002 follow-up 2026-11-19). The emulator mode is
// covered end to end by test/admin-grant-email.e2e.test.ts. Sources: Identity Toolkit v1 projects.accounts.lookup / update
// (docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts, checked 2026-11-19).

const PROJECT = "airplane-games-9fe1e";
let config: Extract<FirebaseAdminConfig, { kind: "service_account" }>;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  config = {
    kind: "service_account",
    projectId: PROJECT,
    clientEmail: "grant-bot@airplane-games-9fe1e.iam.gserviceaccount.com",
    privateKeyId: "abc123",
    privateKeyPem: await exportPKCS8(privateKey),
  };
});

type Seen = { url: string; body: string; auth: string | null };
type Reply = { status: number; json: unknown } | "throw";

/** A fake fetch answering the token exchange, then each Identity Toolkit call from `replies` in order. */
function fake(replies: Reply[]) {
  const seen: Seen[] = [];
  let tokens = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, body: String(init?.body ?? ""), auth: headers.get("authorization") });
    if (url === "https://oauth2.googleapis.com/token") {
      tokens += 1;
      return new Response(JSON.stringify({ access_token: `token-${tokens}`, expires_in: 3600 }), { status: 200 });
    }
    const reply = replies.shift();
    if (reply === undefined || reply === "throw") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply.json), { status: reply.status });
  }) as typeof fetch;
  return { fetchFn, seen, calls: () => seen.filter((s) => !s.url.includes("oauth2")), tokens: () => tokens };
}

const user = (fields: Record<string, unknown>) => ({ status: 200, json: { users: [{ localId: "u1", ...fields }] } });
const notFoundError = { status: 400, json: { error: { code: 400, message: "USER_NOT_FOUND", errors: [{ message: "USER_NOT_FOUND" }] } } };

describe("IdentityToolkitAccounts (service account)", () => {
  it("looks up by uid, then sets emailVerified on the configured project, with a JWT-bearer token", async () => {
    const f = fake([user({ email: "editor@example.test", emailVerified: false }), { status: 200, json: { localId: "u1", emailVerified: true } }]);
    const accounts = new IdentityToolkitAccounts(config, { fetch: f.fetchFn });
    expect(await accounts.ensureEmailVerified("u1", null)).toEqual({ kind: "ok", emailVerification: "verified" });
    const [lookup, update] = f.calls();
    expect(lookup?.url).toBe(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`);
    expect(JSON.parse(lookup?.body ?? "")).toEqual({ localId: ["u1"] });
    expect(update?.url).toBe(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`);
    expect(JSON.parse(update?.body ?? "")).toEqual({ localId: "u1", email: "editor@example.test", emailVerified: true });
    expect(lookup?.auth).toBe("Bearer token-1");
    // The assertion: RS256 with the key id, issuer = the service account, scope cloud-platform, audience the token endpoint.
    const exchange = f.seen.find((s) => s.url.includes("oauth2"));
    const assertion = new URLSearchParams(exchange?.body).get("assertion") ?? "";
    expect(decodeProtectedHeader(assertion)).toMatchObject({ alg: "RS256", kid: "abc123" });
    expect(decodeJwt(assertion)).toMatchObject({
      iss: config.clientEmail,
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/cloud-platform",
    });
    expect(f.tokens()).toBe(1); // cached for the second call
  });

  it("an already verified account is not updated; an account without an email is not updated", async () => {
    const a = fake([user({ email: "x@example.test", emailVerified: true })]);
    expect(await new IdentityToolkitAccounts(config, { fetch: a.fetchFn }).ensureEmailVerified("u1", null)).toEqual({ kind: "ok", emailVerification: "already_verified" });
    expect(a.calls()).toHaveLength(1);
    const b = fake([user({})]);
    expect(await new IdentityToolkitAccounts(config, { fetch: b.fetchFn }).ensureEmailVerified("u1", null)).toEqual({ kind: "ok", emailVerification: "no_email" });
    expect(b.calls()).toHaveLength(1);
  });

  it("no such account (no users field, or USER_NOT_FOUND on update), disabled, and a typed email that differs", async () => {
    const run = (replies: Reply[], email: string | null = null) => new IdentityToolkitAccounts(config, { fetch: fake(replies).fetchFn }).ensureEmailVerified("u1", email);
    expect(await run([{ status: 200, json: {} }])).toEqual({ kind: "not_found" });
    expect(await run([{ status: 200, json: { users: [{ localId: "someone-else" }] } }])).toEqual({ kind: "not_found" });
    expect(await run([user({ email: "e@example.test" }), notFoundError])).toEqual({ kind: "not_found" });
    expect(await run([user({ email: "e@example.test", disabled: true })])).toEqual({ kind: "disabled" });
    expect(await run([user({ email: "e@example.test" })], "other@example.test")).toEqual({ kind: "email_mismatch" });
    expect(await run([user({})], "e@example.test")).toEqual({ kind: "email_mismatch" });
    expect(await run([user({ email: "E@Example.test", emailVerified: true })], "e@example.test")).toEqual({ kind: "ok", emailVerification: "already_verified" });
  });

  it("refusals and outages are unavailable; one retry after a network failure or 5xx; a 401 drops the token and retries", async () => {
    const run = (replies: Reply[]) => new IdentityToolkitAccounts(config, { fetch: fake(replies).fetchFn }).ensureEmailVerified("u1", null);
    expect(await run([{ status: 403, json: { error: { message: "PERMISSION_DENIED" } } }])).toEqual({ kind: "unavailable" });
    expect(await run(["throw", "throw"])).toEqual({ kind: "unavailable" });
    expect(await run([{ status: 500, json: {} }, user({ emailVerified: true, email: "e@example.test" })])).toEqual({ kind: "ok", emailVerification: "already_verified" });
    const f = fake([{ status: 401, json: {} }, user({ emailVerified: true, email: "e@example.test" })]);
    expect(await new IdentityToolkitAccounts(config, { fetch: f.fetchFn }).ensureEmailVerified("u1", null)).toEqual({ kind: "ok", emailVerification: "already_verified" });
    expect(f.tokens()).toBe(2);
  });

  it("an update answer without the flag is confirmed by a second lookup, never assumed", async () => {
    const run = (replies: Reply[]) => new IdentityToolkitAccounts(config, { fetch: fake(replies).fetchFn }).ensureEmailVerified("u1", null);
    const unverified = user({ email: "e@example.test", emailVerified: false });
    expect(await run([unverified, { status: 200, json: { localId: "u1" } }, user({ email: "e@example.test", emailVerified: true })])).toEqual({ kind: "ok", emailVerification: "verified" });
    expect(await run([unverified, { status: 200, json: { localId: "u1" } }, unverified])).toEqual({ kind: "unavailable" });
  });

  it("a failed token exchange is unavailable and nothing is called", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as typeof fetch;
    expect(await new IdentityToolkitAccounts(config, { fetch: fetchFn }).ensureEmailVerified("u1", null)).toEqual({ kind: "unavailable" });
    expect(calls).toBe(2); // the exchange, tried once per attempt; no Identity Toolkit call
  });
});

describe("firebaseAccountsFor", () => {
  it("without configuration answers not_configured", async () => {
    expect(await firebaseAccountsFor(undefined).ensureEmailVerified("u1", null)).toEqual({ kind: "not_configured" });
  });

  it("the emulator form calls http://<host>/identitytoolkit.googleapis.com/v1/projects/<demo project> with Bearer owner", async () => {
    const f = fake([user({ email: "e@example.test", emailVerified: true })]);
    const accounts = firebaseAccountsFor({ kind: "emulator", projectId: "demo-airplane-games", host: "127.0.0.1:9199" }, { fetch: f.fetchFn });
    await accounts.ensureEmailVerified("u1", null);
    expect(f.seen[0]).toMatchObject({
      url: "http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/projects/demo-airplane-games/accounts:lookup",
      auth: "Bearer owner",
    });
    expect(f.tokens()).toBe(0);
  });
});
