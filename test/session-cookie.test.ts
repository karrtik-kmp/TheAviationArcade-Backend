import { errors, SignJWT } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AuthUnavailableError, InvalidTokenError, sessionCookieKeys, verifyCredential } from "../src/auth/firebase.js";
import { emulatorSessionCookie, emulatorToken, makeSessionKey, signedSessionCookie } from "./tokens.js";
import type { SessionTestKey } from "./tokens.js";

// Session-cookie verification (docs/plans/session-cookies.md C1-C3, C7). Signing keys are generated locally; the key
// endpoint is a fake fetch and the resolver's clock is injected.

const PROJECT = "airplane-games-9fe1e";
const DEMO = "demo-airplane-games";
const production = { projectId: PROJECT, emulator: false };
let key: SessionTestKey;
let otherKey: SessionTestKey;
let sessionKeys: JWTVerifyGetKey;
let idKeys: JWTVerifyGetKey;

beforeAll(() => {
  key = makeSessionKey("cookie-key");
  otherKey = makeSessionKey("other-key");
  sessionKeys = async () => key.publicKey;
  idKeys = async () => otherKey.publicKey;
});

const verify = (token: string, options: Parameters<typeof verifyCredential>[1] = production) =>
  verifyCredential(token, options, { idToken: idKeys, sessionCookie: sessionKeys });

describe("verifyCredential: session cookies", () => {
  it.each(["password", "google.com", "apple.com"])("accepts a valid %s cookie and reports kind sessionCookie", async (provider) => {
    const { identity, kind } = await verify(await signedSessionCookie(key, PROJECT, { provider }));
    expect(kind).toBe("sessionCookie");
    expect(identity.principal).toBe(`firebase:${PROJECT}:uid-123`);
    expect(identity.anonymous).toBe(false);
    expect(identity.emailVerified).toBe(true);
  });

  it("reports kind idToken for an ID token", async () => {
    const { identity, kind } = await verifyCredential(emulatorToken("uid-9", DEMO), { projectId: DEMO, emulator: true });
    expect(kind).toBe("idToken");
    expect(identity.principal).toBe(`firebase:${DEMO}:uid-9`);
  });

  it("refuses a cookie issued for another project (issuer)", async () => {
    // The unverified issuer is not ours, so it takes the ID-token path. Both resolvers hold the signing key, so only the issuer can refuse it.
    const token = await signedSessionCookie(key, PROJECT, { issuerProject: "someone-else" });
    const holdsKey: JWTVerifyGetKey = async () => key.publicKey;
    await expect(verifyCredential(token, production, { idToken: holdsKey, sessionCookie: holdsKey })).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("refuses a wrong audience", async () => {
    await expect(verify(await signedSessionCookie(key, PROJECT, { audience: "someone-else" }))).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it("refuses an expired cookie", async () => {
    await expect(verify(await signedSessionCookie(key, PROJECT, { iat: -400, exp: -1 }))).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("refuses exp <= iat", async () => {
    // iat is inside the 60 s clock skew and exp is in the future, so only the exp <= iat rule can refuse these.
    await expect(verify(await signedSessionCookie(key, PROJECT, { iat: 30, exp: 30 }))).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verify(await signedSessionCookie(key, PROJECT, { iat: 30, exp: 20 }))).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("refuses a lifetime over 14 days and accepts exactly 14 days", async () => {
    await expect(verify(await signedSessionCookie(key, PROJECT, { iat: -60, exp: -60 + 1_209_601 }))).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    const { kind } = await verify(await signedSessionCookie(key, PROJECT, { iat: -60, exp: -60 + 1_209_600 }));
    expect(kind).toBe("sessionCookie");
  });

  it("refuses a cookie signed by a key the resolver does not hold", async () => {
    await expect(verify(await signedSessionCookie(otherKey, PROJECT))).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("refuses an auth_time far in the future", async () => {
    await expect(verify(await signedSessionCookie(key, PROJECT, { authTime: 3_600 }))).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("refuses a missing kid, an empty kid and a 129-char kid before any key fetch", async () => {
    const fetchFake = vi.fn();
    const real = sessionCookieKeys({ fetch: fetchFake as unknown as typeof fetch });
    for (const kid of [null, "", "k".repeat(129)]) {
      const token = await signedSessionCookie(key, PROJECT, { kid });
      await expect(verifyCredential(token, production, { sessionCookie: real })).rejects.toBeInstanceOf(InvalidTokenError);
    }
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('answers 401 (not a crash, not a 503) for kid "__proto__" after a fresh fetch', async () => {
    const fetchFake = keyFetch(() => ({ [key.kid]: key.certPem }));
    const resolver = sessionCookieKeys({ fetch: fetchFake, now: () => 1_000_000 });
    const token = await signedSessionCookie(key, PROJECT, { kid: "__proto__" });
    await expect(verifyCredential(token, production, { sessionCookie: resolver })).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("never verifies a cookie with the ID-token key, nor an ID token with the cookie key", async () => {
    // A cookie signed by the ID-token key: the cookie resolver holds only `key`.
    await expect(verify(await signedSessionCookie(otherKey, PROJECT))).rejects.toBeInstanceOf(InvalidTokenError);
    // An ID token (securetoken issuer) signed by the cookie key: the ID resolver holds only `otherKey`.
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ auth_time: now - 60, firebase: { sign_in_provider: "password" } })
      .setProtectedHeader({ alg: "RS256", kid: key.kid })
      .setIssuer(`https://securetoken.google.com/${PROJECT}`)
      .setAudience(PROJECT)
      .setSubject("uid-123")
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 3600)
      .sign(key.privateKey);
    await expect(verify(idToken)).rejects.toBeInstanceOf(InvalidTokenError);
    // The same ID token with its own key verifies, so the refusal above is the key, not the token.
    const ok = await verifyCredential(idToken, production, { idToken: async () => key.publicKey, sessionCookie: sessionKeys });
    expect(ok.kind).toBe("idToken");
  });

  it("refuses a guest cookie and a linked-anonymous cookie even with anonymousPlayers on", async () => {
    const on = { ...production, anonymousPlayers: true };
    await expect(verify(await signedSessionCookie(key, PROJECT, { provider: "anonymous", identities: {} }), on)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    await expect(
      verify(await signedSessionCookie(key, PROJECT, { provider: "anonymous", identities: { email: ["a@b.test"] } }), on),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("refuses a provider outside the product logins", async () => {
    await expect(verify(await signedSessionCookie(key, PROJECT, { provider: "phone" }))).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("refuses malformed input", async () => {
    await expect(verify("not-a-jwt")).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verify("")).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe("verifyCredential: emulator cookies", () => {
  const demo = { projectId: DEMO, emulator: true };

  it("accepts an unsigned cookie only with the emulator flag and the demo project", async () => {
    const cookie = emulatorSessionCookie("uid-5", DEMO);
    const { kind, identity } = await verifyCredential(cookie, demo);
    expect(kind).toBe("sessionCookie");
    expect(identity.principal).toBe(`firebase:${DEMO}:uid-5`);
    await expect(verifyCredential(cookie, { projectId: DEMO, emulator: false })).rejects.toBeInstanceOf(InvalidTokenError);
    const prod = emulatorSessionCookie("uid-5", PROJECT);
    await expect(verifyCredential(prod, { projectId: PROJECT, emulator: true })).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("applies the claim rules to the unsigned path too", async () => {
    const tooLong = emulatorSessionCookie("u", DEMO, "password", { lifetimeSeconds: 1_209_601 });
    await expect(verifyCredential(tooLong, demo)).rejects.toBeInstanceOf(InvalidTokenError);
    const guest = emulatorSessionCookie("u", DEMO, "anonymous", { identities: {} });
    await expect(verifyCredential(guest, { ...demo, anonymousPlayers: true })).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

// ---- key resolver ----

type KeyBody = Record<string, string>;

/** A fake fetch answering the X.509 key map. `calls` counts requests. */
function keyFetch(body: () => KeyBody | Response, cacheControl = "public, max-age=3600, must-revalidate") {
  const calls = { count: 0, urls: [] as string[] };
  const fake = vi.fn(async (url: string | URL | Request) => {
    calls.count += 1;
    calls.urls.push(String(url));
    const result = body();
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "cache-control": cacheControl, "content-type": "application/json" },
    });
  });
  return Object.assign(fake as unknown as typeof fetch, { calls });
}

const call = (resolver: JWTVerifyGetKey, kid?: string) =>
  resolver({ alg: "RS256", ...(kid === undefined ? {} : { kid }) }, { payload: "", signature: "" } as never);

describe("sessionCookieKeys", () => {
  it("fetches the X.509 endpoint once and serves from cache until max-age", async () => {
    let t = 1_000_000;
    const f = keyFetch(() => ({ [key.kid]: key.certPem }), "public, max-age=3600");
    const r = sessionCookieKeys({ fetch: f, now: () => t });
    await call(r, key.kid);
    t += 3_599_000;
    await call(r, key.kid);
    expect(f.calls.count).toBe(1);
    expect(f.calls.urls[0]).toBe("https://www.googleapis.com/identitytoolkit/v3/relyingparty/publicKeys");
    t += 2_000;
    await call(r, key.kid);
    expect(f.calls.count).toBe(2);
  });

  it.each([
    ["max-age=5", 60_000],
    ["max-age=999999999", 86_400_000],
    ["public", 60_000],
    ["s-maxage=3600", 60_000],
    ["max-age=abc", 60_000],
  ])("clamps Cache-Control %s to %i ms (60 s .. 24 h, 60 s without a max-age directive)", async (cc, expectedMs) => {
    let t = 0;
    const f = keyFetch(() => ({ [key.kid]: key.certPem }), cc);
    const r = sessionCookieKeys({ fetch: f, now: () => t });
    await call(r, key.kid);
    t = expectedMs - 1;
    await call(r, key.kid);
    expect(f.calls.count).toBe(1);
    t = expectedMs + 1;
    await call(r, key.kid);
    expect(f.calls.count).toBe(2);
  });

  it("returns keys that verify a cookie signed under that kid, and not under another", async () => {
    const f = keyFetch(() => ({ [key.kid]: key.certPem, [otherKey.kid]: otherKey.certPem }));
    const r = sessionCookieKeys({ fetch: f, now: () => 5 });
    const token = await signedSessionCookie(key, PROJECT);
    expect((await verifyCredential(token, production, { sessionCookie: r })).kind).toBe("sessionCookie");
    // A cookie claiming the other kid but signed by `key` fails signature verification.
    const wrong = await signedSessionCookie(key, PROJECT, { kid: otherKey.kid });
    await expect(verifyCredential(wrong, production, { sessionCookie: r })).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("unknown kid on a cold cache: one fetch, then 401 (JWKSNoMatchingKey)", async () => {
    const f = keyFetch(() => ({ [key.kid]: key.certPem }));
    const r = sessionCookieKeys({ fetch: f, now: () => 0 });
    await expect(call(r, "unknown")).rejects.toBeInstanceOf(errors.JWKSNoMatchingKey);
    expect(f.calls.count).toBe(1);
  });

  it("unknown kid after the 60 s cooldown refetches once; a rotated-in key is then found", async () => {
    let t = 0;
    let body: KeyBody = { [key.kid]: key.certPem };
    const f = keyFetch(() => body);
    const r = sessionCookieKeys({ fetch: f, now: () => t });
    await call(r, key.kid);
    body = { [key.kid]: key.certPem, [otherKey.kid]: otherKey.certPem };
    t = 61_000;
    await expect(call(r, otherKey.kid)).resolves.toBeDefined();
    expect(f.calls.count).toBe(2);
    await expect(call(r, "still-unknown")).rejects.toBeInstanceOf(AuthUnavailableError); // inside the cooldown
    t = 125_000;
    await expect(call(r, "still-unknown")).rejects.toBeInstanceOf(errors.JWKSNoMatchingKey);
    expect(f.calls.count).toBe(3);
  });

  it("unknown kid inside the cooldown is a 503 with no fetch", async () => {
    let t = 0;
    const f = keyFetch(() => ({ [key.kid]: key.certPem }));
    const r = sessionCookieKeys({ fetch: f, now: () => t });
    await call(r, key.kid);
    t = 30_000;
    await expect(call(r, "random")).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(f.calls.count).toBe(1);
    // Through the verifier it is a 503 too, never a 401.
    const token = await signedSessionCookie(key, PROJECT, { kid: "random" });
    await expect(verifyCredential(token, production, { sessionCookie: r })).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it.each([
    ["non-200", () => new Response("nope", { status: 500 })],
    ["bad JSON", () => new Response("{", { status: 200 })],
    ["an array", () => new Response("[]", { status: 200 })],
    ["a non-string value", () => new Response(JSON.stringify({ a: 1 }), { status: 200 })],
    ["an empty map", () => new Response("{}", { status: 200 })],
    ["a bad certificate", () => new Response(JSON.stringify({ a: "not a pem" }), { status: 200 })],
  ])("a key fetch failure (%s) is AuthUnavailableError, not a 401", async (_name, body) => {
    const r = sessionCookieKeys({ fetch: keyFetch(body), now: () => 0 });
    await expect(call(r, key.kid)).rejects.toBeInstanceOf(AuthUnavailableError);
    const token = await signedSessionCookie(key, PROJECT);
    const fresh = sessionCookieKeys({ fetch: keyFetch(body), now: () => 0 });
    await expect(verifyCredential(token, production, { sessionCookie: fresh })).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it("a network error is AuthUnavailableError", async () => {
    const r = sessionCookieKeys({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      now: () => 0,
    });
    await expect(call(r, key.kid)).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it("backs off 5 s after a failure with no usable set: one fetch, then another", async () => {
    let t = 0;
    const f = keyFetch(() => new Response("x", { status: 503 }));
    const r = sessionCookieKeys({ fetch: f, now: () => t });
    await expect(call(r, key.kid)).rejects.toBeInstanceOf(AuthUnavailableError);
    t = 4_999;
    await expect(call(r, key.kid)).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(f.calls.count).toBe(1);
    t = 5_000;
    await expect(call(r, key.kid)).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(f.calls.count).toBe(2);
  });

  it("serves the last good set after a failed refresh, for at most its expiry plus 1 h", async () => {
    let t = 0;
    let fail = false;
    const f = keyFetch(() => (fail ? new Response("x", { status: 500 }) : { [key.kid]: key.certPem }), "max-age=3600");
    const r = sessionCookieKeys({ fetch: f, now: () => t });
    await call(r, key.kid);
    fail = true;
    t = 3_600_001;
    await expect(call(r, key.kid)).resolves.toBeDefined();
    expect(f.calls.count).toBe(2);
    // A kid the stale set lacks is undecidable: 503, not 401.
    await expect(call(r, "other")).rejects.toBeInstanceOf(AuthUnavailableError);
    t = 7_200_000 - 1;
    await expect(call(r, key.kid)).resolves.toBeDefined();
    t = 7_200_000 + 1;
    await expect(call(r, key.kid)).rejects.toBeInstanceOf(AuthUnavailableError);
    // Recovery: a later successful refresh serves again.
    fail = false;
    t += 10_000;
    await expect(call(r, key.kid)).resolves.toBeDefined();
  });

  it("shares one fetch between concurrent callers", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ [key.kid]: key.certPem }), { status: 200, headers: { "cache-control": "max-age=3600" } });
    });
    const r = sessionCookieKeys({ fetch: f as unknown as typeof fetch, now: () => 0 });
    const all = Promise.all([call(r, key.kid), call(r, key.kid), call(r, key.kid), call(r, key.kid)]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await all;
    expect(f).toHaveBeenCalledTimes(1);
  });
});
