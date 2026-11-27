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

describe("IdentityToolkitAccounts.lookupSessionState", () => {
  const state = (replies: Reply[], uid = "u1") => {
    const f = fake(replies);
    return { f, result: () => new IdentityToolkitAccounts(config, { fetch: f.fetchFn }).lookupSessionState(uid, AbortSignal.timeout(3000)) };
  };

  it("reads disabled and validSince (seconds string) by uid, with one try", async () => {
    const { f, result } = state([user({ disabled: true, validSince: "1700000000" })]);
    expect(await result()).toEqual({ kind: "found", disabled: true, validSince: 1700000000 });
    expect(JSON.parse(f.calls()[0]?.body ?? "")).toEqual({ localId: ["u1"] });
  });

  it("absent disabled is false and absent validSince is undefined", async () => {
    expect(await state([user({})]).result()).toEqual({ kind: "found", disabled: false, validSince: undefined });
    expect(await state([user({ disabled: false, validSince: "0" })]).result()).toEqual({ kind: "found", disabled: false, validSince: 0 });
  });

  it("no matching localId, or no users field, is not_found", async () => {
    expect(await state([{ status: 200, json: {} }]).result()).toEqual({ kind: "not_found" });
    expect(await state([{ status: 200, json: { users: [] } }]).result()).toEqual({ kind: "not_found" });
    expect(await state([{ status: 200, json: { users: [{ localId: "other" }] } }]).result()).toEqual({ kind: "not_found" });
  });

  it("strict parsing: anything malformed is unavailable", async () => {
    const bad: unknown[] = [
      { users: "nope" },
      { users: {} },
      [1, 2],
      "text",
      null,
    ];
    for (const json of bad) expect(await state([{ status: 200, json }]).result()).toEqual({ kind: "unavailable" });
    for (const disabled of ["true", 1, null, {}]) expect(await state([user({ disabled })]).result()).toEqual({ kind: "unavailable" });
    for (const validSince of [1700000000, "", "-1", "1.5", "12a", "1234567890123456", null, " 1"]) {
      expect(await state([user({ validSince })]).result()).toEqual({ kind: "unavailable" });
    }
    expect(await state([user({ validSince: "123456789012345" })]).result()).toEqual({ kind: "found", disabled: false, validSince: 123456789012345 });
  });

  it("a non-JSON 200 body is unavailable", async () => {
    const fetchFn = (async (input: string | URL | Request) =>
      String(input).includes("oauth2")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 })
        : new Response("<html>", { status: 200 })) as typeof fetch;
    expect(await new IdentityToolkitAccounts(config, { fetch: fetchFn }).lookupSessionState("u1", AbortSignal.timeout(3000))).toEqual({ kind: "unavailable" });
  });

  it("any non-200 is unavailable and is not retried (not even 500, 401 or a thrown fetch)", async () => {
    for (const reply of [{ status: 500, json: {} }, { status: 401, json: {} }, { status: 403, json: { error: { message: "PERMISSION_DENIED" } } }, { status: 400, json: notFoundError.json }, "throw"] as Reply[]) {
      const { f, result } = state([reply, user({})]);
      expect(await result()).toEqual({ kind: "unavailable" });
      expect(f.calls()).toHaveLength(1);
    }
  });

  it("a failed token exchange is unavailable after a single exchange and no lookup", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response("{}", { status: 400 });
    }) as typeof fetch;
    expect(await new IdentityToolkitAccounts(config, { fetch: fetchFn }).lookupSessionState("u1", AbortSignal.timeout(3000))).toEqual({ kind: "unavailable" });
    expect(calls).toBe(1);
  });

  it("an aborted signal while the token mint is slow gives unavailable at once; the mint is shared and still completes for others", async () => {
    let release: (() => void) | undefined;
    let tokens = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      if (String(input).includes("oauth2")) {
        tokens += 1;
        await new Promise<void>((resolve) => (release = resolve));
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify(user({}).json), { status: 200 });
    }) as typeof fetch;
    const accounts = new IdentityToolkitAccounts(config, { fetch: fetchFn });
    const controller = new AbortController();
    const first = accounts.lookupSessionState("u1", controller.signal);
    const second = accounts.lookupSessionState("u1", AbortSignal.timeout(5000));
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect(await first).toEqual({ kind: "unavailable" });
    release?.();
    expect(await second).toEqual({ kind: "found", disabled: false, validSince: undefined });
    expect(tokens).toBe(1);
  });

  it("concurrent cold callers share one token mint; a failed mint does not poison the next caller", async () => {
    const f = fake([user({}), user({})]);
    const accounts = new IdentityToolkitAccounts(config, { fetch: f.fetchFn });
    await Promise.all([accounts.lookupSessionState("u1", AbortSignal.timeout(3000)), accounts.lookupSessionState("u1", AbortSignal.timeout(3000))]);
    expect(f.tokens()).toBe(1);

    let fail = true;
    let exchanges = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      if (String(input).includes("oauth2")) {
        exchanges += 1;
        return fail ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify(user({}).json), { status: 200 });
    }) as typeof fetch;
    const flaky = new IdentityToolkitAccounts(config, { fetch: fetchFn });
    expect(await flaky.lookupSessionState("u1", AbortSignal.timeout(3000))).toEqual({ kind: "unavailable" });
    fail = false;
    expect(await flaky.lookupSessionState("u1", AbortSignal.timeout(3000))).toEqual({ kind: "found", disabled: false, validSince: undefined });
    expect(exchanges).toBe(2);
  });

  it("failure logs carry no uid, token or body, and are throttled", async () => {
    const { Logger } = await import("@nestjs/common");
    const { vi } = await import("vitest");
    const spy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      let clock = 1_000_000;
      const fetchFn = (async (input: string | URL | Request) =>
        String(input).includes("oauth2")
          ? new Response(JSON.stringify({ access_token: "secret-token", expires_in: 3600 }), { status: 200 })
          : new Response(JSON.stringify({ error: { message: "PERMISSION_DENIED : secret detail" } }), { status: 403 })) as typeof fetch;
      const accounts = new IdentityToolkitAccounts(config, { fetch: fetchFn, now: () => clock });
      for (let i = 0; i < 5; i += 1) await accounts.lookupSessionState("uid-secret", AbortSignal.timeout(3000));
      expect(spy).toHaveBeenCalledTimes(1);
      clock += 31_000;
      await accounts.lookupSessionState("uid-secret", AbortSignal.timeout(3000));
      expect(spy).toHaveBeenCalledTimes(2);
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines[0]).toContain("status=403");
      expect(lines[0]).toContain("PERMISSION_DENIED");
      expect(lines[1]).toContain("4 similar suppressed");
      for (const line of lines) expect(line).not.toMatch(/uid-secret|secret-token|secret detail/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("firebaseAccountsFor", () => {
  it("without configuration answers not_configured", async () => {
    expect(await firebaseAccountsFor(undefined).ensureEmailVerified("u1", null)).toEqual({ kind: "not_configured" });
    expect(await firebaseAccountsFor(undefined).lookupSessionState("u1", AbortSignal.timeout(3000))).toEqual({ kind: "not_configured" });
  });

  it("the emulator form looks up session state with Bearer owner and no token exchange", async () => {
    const f = fake([user({ validSince: "5" })]);
    const accounts = firebaseAccountsFor({ kind: "emulator", projectId: "demo-airplane-games", host: "127.0.0.1:9199" }, { fetch: f.fetchFn });
    expect(await accounts.lookupSessionState("u1", AbortSignal.timeout(3000))).toEqual({ kind: "found", disabled: false, validSince: 5 });
    expect(f.seen[0]).toMatchObject({
      url: "http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/projects/demo-airplane-games/accounts:lookup",
      auth: "Bearer owner",
    });
    expect(f.tokens()).toBe(0);
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
