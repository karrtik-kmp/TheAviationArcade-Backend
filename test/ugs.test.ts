import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { AuthUnavailableError } from "../src/auth/firebase.js";
import { loadConfig } from "../src/config/config.module.js";
import type { PlayerRow } from "../src/db/schema.js";
import {
  BACKOFF_CAP_MS,
  BATCH_MAX,
  LEASE_MARGIN_MS,
  LEASE_MS,
  SlidingWindowLimiter,
  TokenBucket,
  backoffMs,
  mirrorDeletionDueAt,
  mirrorSnapshot,
} from "../src/ugs/mirror-policy.js";
import { REQUEST_TIMEOUT_MS, UGS_API_BASE, UgsClient, parseRetryAfter } from "../src/ugs/ugs-client.js";
import { InvalidUgsTokenError, UGS_ISSUER, verifyUgsToken } from "../src/ugs/ugs-token.js";

const PROJECT = "11111111-2222-3333-4444-555555555555";
const ENV = "66666666-7777-8888-9999-000000000000";
const OPTIONS = { projectId: PROJECT, environmentId: ENV };

let privateKey: CryptoKey;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "public:test", alg: "RS256", use: "sig" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

async function ugsToken(
  claims: Record<string, unknown> = { project_id: PROJECT, envId: ENV },
  opts: { issuer?: string; sub?: string; expiresIn?: number; notBefore?: number } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "public:test" })
    .setIssuer(opts.issuer ?? UGS_ISSUER)
    .setSubject(opts.sub ?? "ugsPlayer123")
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (opts.expiresIn ?? 3600));
  if (opts.notBefore !== undefined) jwt.setNotBefore(now + opts.notBefore);
  return jwt.sign(privateKey);
}

async function reason(token: string): Promise<string> {
  try {
    await verifyUgsToken(token, OPTIONS, keys);
  } catch (error) {
    if (error instanceof InvalidUgsTokenError) return error.reason;
    throw error;
  }
  throw new Error("token was accepted");
}

describe("verifyUgsToken", () => {
  it("accepts a valid token and returns the subject as the UGS player id", async () => {
    await expect(verifyUgsToken(await ugsToken(), OPTIONS, keys)).resolves.toEqual({ ugsPlayerId: "ugsPlayer123" });
  });

  it("ASSUMPTION (UNVERIFIED claim names): the project claim may be `upid` instead of `project_id`", async () => {
    await expect(verifyUgsToken(await ugsToken({ upid: PROJECT, envId: ENV }), OPTIONS, keys)).resolves.toBeTruthy();
  });

  it("ASSUMPTION (UNVERIFIED): envId is checked when present and not required when absent", async () => {
    await expect(verifyUgsToken(await ugsToken({ project_id: PROJECT }), OPTIONS, keys)).resolves.toBeTruthy();
    expect(await reason(await ugsToken({ project_id: PROJECT, envId: "someone-elses-env" }))).toBe("wrong environment");
  });

  it("rejects a wrong project, a missing project claim, and a conflicting second project claim", async () => {
    expect(await reason(await ugsToken({ project_id: "other", envId: ENV }))).toBe("wrong project");
    expect(await reason(await ugsToken({ envId: ENV }))).toBe("no project claim");
    expect(await reason(await ugsToken({ project_id: PROJECT, upid: "other" }))).toBe("wrong project");
  });

  it("rejects a wrong issuer, an expired token, a not-yet-valid token and a bad subject", async () => {
    expect(await reason(await ugsToken(undefined, { issuer: "https://evil.example" }))).toBe("wrong issuer");
    expect(await reason(await ugsToken(undefined, { expiresIn: -120 }))).toBe("expired");
    expect(await reason(await ugsToken(undefined, { notBefore: 600 }))).toBe("signature or claims invalid");
    expect(await reason(await ugsToken(undefined, { sub: "../admin" }))).toBe("bad subject");
  });

  it("rejects garbage, an unsigned token and a token signed by another key", async () => {
    expect(await reason("not-a-jwt")).toBe("malformed");
    const b64 = (text: string) => btoa(text).replace(/=+$/, "");
    const unsigned = `${b64('{"alg":"none"}')}.${b64('{"sub":"x"}')}.`;
    expect(await reason(unsigned)).toBe("unsupported algorithm");
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ project_id: PROJECT })
      .setProtectedHeader({ alg: "RS256", kid: "public:test" })
      .setIssuer(UGS_ISSUER)
      .setSubject("ugsPlayer123")
      .setExpirationTime("1h")
      .sign(other.privateKey);
    expect(await reason(forged)).toBe("signature or claims invalid");
  });

  it("unreachable keys are AuthUnavailableError, never a bad-token error", async () => {
    const broken: JWTVerifyGetKey = async () => {
      throw new AuthUnavailableError();
    };
    await expect(verifyUgsToken(await ugsToken(), OPTIONS, broken)).rejects.toBeInstanceOf(AuthUnavailableError);
  });
});

describe("UgsClient (stubbed fetch, no network)", () => {
  const config = { projectId: PROJECT, environmentId: ENV, serviceAccountKeyId: "key-id", serviceAccountSecret: "s3cret" };
  const respond = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers });

  it("parses externalIds for the link proof and sends Basic service-account auth", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const client = new UgsClient(config, async (url, init) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      return respond(200, { id: "p", externalIds: [{ externalId: "uid-1", providerId: "oidc-firebase" }, { nope: 1 }, "x"] });
    });
    expect(await client.getExternalIds("abc")).toEqual({
      kind: "ok",
      externalIds: [{ externalId: "uid-1", providerId: "oidc-firebase" }],
    });
    expect(seen[0]?.url).toBe(`${UGS_API_BASE}/player-identity/v1/projects/${PROJECT}/users/abc`);
    expect(seen[0]?.auth).toBe(`Basic ${Buffer.from("key-id:s3cret").toString("base64")}`);
  });

  it("maps identity lookups: 404 not_found, 401/429/5xx/network unavailable, missing externalIds is ok-empty", async () => {
    const run = (fetcher: ConstructorParameters<typeof UgsClient>[1]) => new UgsClient(config, fetcher).getExternalIds("abc");
    expect(await run(async () => respond(404))).toEqual({ kind: "not_found" });
    expect(await run(async () => respond(401))).toEqual({ kind: "unavailable", status: 401 });
    expect(await run(async () => respond(429))).toEqual({ kind: "unavailable", status: 429 });
    expect(await run(async () => respond(503))).toEqual({ kind: "unavailable", status: 503 });
    expect(await run(async () => { throw new TypeError("fetch failed"); })).toEqual({ kind: "unavailable", status: "network" });
    expect(await run(async () => respond(200, {}))).toEqual({ kind: "ok", externalIds: [] });
  });

  it("writes the Protected progress item without a writeLock, and classifies failures", async () => {
    const calls: { url: string; method?: string; body: unknown }[] = [];
    const reply = { current: respond(200, { writeLock: "x" }) };
    const client = new UgsClient(config, async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return reply.current;
    });
    expect(await client.writeProgress("abc", { schemaVersion: 1 })).toEqual({ kind: "ok" });
    expect(calls[0]).toEqual({
      url: `${UGS_API_BASE}/cloud-save/v1/data/projects/${PROJECT}/environments/${ENV}/players/abc/protected/items`,
      method: "POST",
      body: { key: "progress", value: { schemaVersion: 1 } },
    });
    reply.current = respond(429, {}, { "retry-after": "7" });
    expect(await client.writeProgress("abc", {})).toEqual({ kind: "rate_limited", retryAfterMs: 7000 });
    reply.current = respond(502);
    expect(await client.writeProgress("abc", {})).toEqual({ kind: "transient", status: 502 });
    reply.current = respond(403);
    expect(await client.writeProgress("abc", {})).toEqual({ kind: "auth_failed", status: 403 });
    reply.current = respond(401);
    expect(await client.writeProgress("abc", {})).toEqual({ kind: "auth_failed", status: 401 });
    reply.current = respond(400);
    expect(await client.writeProgress("abc", {})).toEqual({ kind: "rejected", status: 400 });
  });

  it("cancels response bodies it does not read (write, delete, identity failures)", async () => {
    let cancelled = 0;
    const withBody = (status: number) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
          },
          cancel() {
            cancelled += 1;
          },
        }),
        { status },
      );
    const client = (status: number) => new UgsClient(config, async () => withBody(status));
    await client(200).writeProgress("abc", {});
    await client(500).writeProgress("abc", {});
    await client(404).deleteProgress("abc");
    await client(200).deleteProgress("abc");
    await client(404).getExternalIds("abc");
    await client(503).getExternalIds("abc");
    expect(cancelled).toBe(6);
  });

  it("deletes the progress item; 404 counts as done", async () => {
    const calls: { url: string; method?: string }[] = [];
    let status = 204;
    const client = new UgsClient(config, async (url, init) => {
      calls.push({ url, method: init.method });
      return respond(status);
    });
    expect(await client.deleteProgress("abc")).toEqual({ kind: "ok" });
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toMatch(/\/players\/abc\/protected\/items\/progress$/);
    status = 404;
    expect(await client.deleteProgress("abc")).toEqual({ kind: "ok" });
  });

  it("parseRetryAfter: seconds, HTTP date, junk and clamping", () => {
    expect(parseRetryAfter("1.5")).toBe(1_500);
    expect(parseRetryAfter("2.25")).toBe(2_250);
    expect(parseRetryAfter("0.2")).toBe(1_000); // clamped up
    expect(parseRetryAfter(null)).toBe(60_000);
    expect(parseRetryAfter("soon")).toBe(60_000);
    expect(parseRetryAfter("0")).toBe(1000);
    expect(parseRetryAfter("99999999")).toBe(60 * 60_000);
    expect(parseRetryAfter(new Date(1_000_000 + 30_000).toUTCString(), 1_000_000)).toBeGreaterThan(25_000);
  });
});

describe("mirror policy", () => {
  it("TokenBucket allows a burst up to min(perMin, 10) then refills at perMin per minute", () => {
    const bucket = new TokenBucket(25, 0);
    expect(bucket.capacity).toBe(10);
    expect(bucket.available(0)).toBe(10);
    for (let i = 0; i < 10; i += 1) expect(bucket.take(0)).toBe(true);
    expect(bucket.take(0)).toBe(false);
    // 25 per minute is one token per 2.4 s.
    expect(bucket.take(2_000)).toBe(false);
    expect(bucket.take(2_500)).toBe(true);
    expect(bucket.available(60_000)).toBe(10); // capped at capacity
    // Over a long run it never exceeds the configured rate.
    const slow = new TokenBucket(30, 0);
    let taken = 0;
    for (let t = 0; t <= 600_000; t += 100) while (slow.take(t)) taken += 1;
    expect(taken).toBeLessThanOrEqual(10 + 30 * 10); // burst + 10 minutes at 30/min
    expect(new TokenBucket(3, 0).capacity).toBe(3);
  });

  it("TokenBucket ignores a clock that moves backwards", () => {
    const bucket = new TokenBucket(10, 1_000_000);
    expect(bucket.take(1_000_000)).toBe(true);
    expect(bucket.available(0)).toBe(9);
  });

  it("SlidingWindowLimiter allows `limit` hits per window and reports when the oldest expires", () => {
    const limiter = new SlidingWindowLimiter(2, 60_000);
    expect(limiter.hit("a", 0)).toBe(0);
    expect(limiter.hit("a", 1_000)).toBe(0);
    expect(limiter.hit("a", 2_000)).toBe(58); // oldest (t=0) expires at 60 s
    expect(limiter.hit("b", 2_000)).toBe(0); // keys are independent
    expect(limiter.hit("a", 60_001)).toBe(0); // t=0 expired; the refused hit was not counted
  });

  it("TokenBucket takes an explicit capacity and can be reset", () => {
    const bucket = new TokenBucket(12, 0, 3);
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, true, false]);
    bucket.reset(0);
    expect(bucket.available(0)).toBe(3);
  });

  it("the claim lease outlasts a whole batch of slow requests, and a deletion waits out any in-flight write", () => {
    expect(LEASE_MS).toBeGreaterThanOrEqual(BATCH_MAX * REQUEST_TIMEOUT_MS + LEASE_MARGIN_MS);
    expect(LEASE_MARGIN_MS).toBeGreaterThanOrEqual(30_000);
    const now = new Date("2026-10-29T10:00:00Z");
    expect(mirrorDeletionDueAt(now).getTime() - now.getTime()).toBe(LEASE_MS + REQUEST_TIMEOUT_MS);
  });

  it("backoff doubles from 5 s and is capped at 15 minutes", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(backoffMs(30)).toBe(BACKOFF_CAP_MS);
    expect(BACKOFF_CAP_MS).toBe(900_000);
    expect(backoffMs(0)).toBe(5_000);
  });

  it("snapshot has exactly the documented fields, the progress-view values, and ISO dates", () => {
    const player: PlayerRow = {
      id: "firebase:p:u",
      statusPoints: 5_000,
      miles: 120,
      hints: 7,
      perfectStreak: 3,
      activeRank: "trainee",
      firstClassUntil: new Date("2026-12-01T00:00:00.000Z"),
      version: 9,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedAt: new Date("2026-10-28T12:00:00.000Z"),
    };
    const snapshot = mirrorSnapshot(player, new Date("2026-10-28T13:00:00.000Z"));
    expect(Object.keys(snapshot)).toEqual([
      "schemaVersion", "version", "statusPoints", "miles", "hints", "perfectStreak",
      "certifiedRank", "activeRank", "firstClassUntil", "updatedAt",
    ]);
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      version: 9,
      statusPoints: 5_000,
      miles: 120,
      hints: 7,
      perfectStreak: 3,
      activeRank: "trainee",
      firstClassUntil: "2026-12-01T00:00:00.000Z",
      updatedAt: "2026-10-28T12:00:00.000Z",
    });
    expect(typeof snapshot.certifiedRank).toBe("string");
    expect(mirrorSnapshot({ ...player, firstClassUntil: null }, new Date()).firstClassUntil).toBeNull();
  });
});

describe("UGS config", () => {
  const base = { APP_ENV: "local", DATABASE_URL: "postgres://u:p@127.0.0.1:5433/db", FIREBASE_PROJECT_ID: "demo-airplane-games" };
  const full = {
    UGS_PROJECT_ID: PROJECT,
    UGS_ENVIRONMENT_ID: ENV,
    UGS_SERVICE_ACCOUNT_KEY_ID: "key-id",
    UGS_SERVICE_ACCOUNT_SECRET: "super-secret-value",
    UGS_OIDC_PROVIDER: "oidc-firebase",
  };
  const failure = (env: NodeJS.ProcessEnv): string => {
    try {
      loadConfig(env);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("did not throw");
  };

  it("is off when nothing (or only blanks) is set, and complete when all five are", () => {
    expect(loadConfig(base).ugs).toBeUndefined();
    expect(loadConfig({ ...base, UGS_PROJECT_ID: "  ", UGS_MIRROR_MAX_PER_MIN: "" }).ugs).toBeUndefined();
    expect(loadConfig({ ...base, ...full }).ugs).toEqual({
      projectId: PROJECT,
      environmentId: ENV,
      serviceAccountKeyId: "key-id",
      serviceAccountSecret: "super-secret-value",
      oidcProvider: "oidc-firebase",
      mirrorMaxPerMin: 25,
    });
    expect(loadConfig({ ...base, ...full, UGS_MIRROR_MAX_PER_MIN: "12" }).ugs?.mirrorMaxPerMin).toBe(12);
  });

  it("UGS_MIRROR_MAX_PER_MIN alone is partial config: it fails instead of silently leaving the mirror off", () => {
    const message = failure({ ...base, UGS_MIRROR_MAX_PER_MIN: "10" });
    for (const name of ["UGS_PROJECT_ID", "UGS_ENVIRONMENT_ID", "UGS_SERVICE_ACCOUNT_KEY_ID", "UGS_SERVICE_ACCOUNT_SECRET", "UGS_OIDC_PROVIDER"]) {
      expect(message).toContain(name);
    }
  });

  it("partial config fails fast naming the missing variables, never the secret", () => {
    const message = failure({ ...base, UGS_SERVICE_ACCOUNT_SECRET: "super-secret-value", UGS_PROJECT_ID: PROJECT });
    expect(message).toContain("UGS_ENVIRONMENT_ID");
    expect(message).toContain("UGS_SERVICE_ACCOUNT_KEY_ID");
    expect(message).toContain("UGS_OIDC_PROVIDER");
    expect(message).not.toContain("super-secret-value");
  });

  it("rejects a bad provider prefix or length, a key id with a colon, odd project ids and an over-budget rate", () => {
    expect(failure({ ...base, ...full, UGS_OIDC_PROVIDER: "firebase" })).toContain("UGS_OIDC_PROVIDER");
    expect(failure({ ...base, ...full, UGS_OIDC_PROVIDER: "oidc-this-is-way-too-long" })).toContain("UGS_OIDC_PROVIDER");
    expect(failure({ ...base, ...full, UGS_SERVICE_ACCOUNT_KEY_ID: "a:b" })).toContain("UGS_SERVICE_ACCOUNT_KEY_ID");
    expect(failure({ ...base, ...full, UGS_PROJECT_ID: "../x" })).toContain("UGS_PROJECT_ID");
    expect(failure({ ...base, ...full, UGS_MIRROR_MAX_PER_MIN: "34" })).toContain("UGS_MIRROR_MAX_PER_MIN");
    expect(failure({ ...base, ...full, UGS_MIRROR_MAX_PER_MIN: "0" })).toContain("UGS_MIRROR_MAX_PER_MIN");
    expect(failure({ ...base, ...full, UGS_OIDC_PROVIDER: "firebase" })).not.toContain("super-secret-value");
  });
});
