import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTVerifyGetKey } from "jose";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { AuthUnavailableError } from "../src/auth/firebase.js";
import { APP_CONFIG } from "../src/config/config.module.js";
import { DatabaseService } from "../src/database/database.module.js";
import { MIN_ROUND_MS } from "../src/rounds/rounds.service.js";
import { LEASE_MS, TokenBucket } from "../src/ugs/mirror-policy.js";
import { MirrorWorker } from "../src/ugs/mirror-worker.js";
import { enqueueMirror } from "../src/ugs/outbox.js";
import { REQUEST_TIMEOUT_MS } from "../src/ugs/ugs-client.js";
import { UGS_ISSUER } from "../src/ugs/ugs-token.js";
import { UGS_CLIENT, UGS_FETCH, UGS_KEYS, UGS_PROOF_BUCKET, UGS_WORKER_OPTIONS } from "../src/ugs/ugs.tokens.js";
import { emulatorToken } from "./tokens.js";

// The UGS progress mirror against the real test database. UGS itself is a stub injected as the fetcher and the
// key set: this file never touches the network.

const PROJECT = "11111111-2222-3333-4444-555555555555";
const ENV = "66666666-7777-8888-9999-000000000000";
const PROVIDER = "oidc-firebase";
const PREFIX = "firebase:demo-airplane-games:";

type Call = { method: string; url: string; auth: string | null; body: any };
type Handler = (call: Call) => Response | Promise<Response>;

const calls: Call[] = [];
let handler: Handler = () => new Response("{}", { status: 200 });
let keysImpl: JWTVerifyGetKey;
let privateKey: CryptoKey;
let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;
let worker: MirrorWorker;
/** Big burst so tests that link many players are not throttled by the process-wide proof budget; one test drains it. */
const proofBucket = new TokenBucket(12, Date.now(), 1000);
const savedEnv = { ...process.env };

/** UGS identity table for the stub: ugsPlayerId -> externalIds. */
const identities = new Map<string, { externalId: string; providerId: string }[]>();

const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const defaultHandler: Handler = (call) => {
  if (call.method === "GET") {
    const id = decodeURIComponent(call.url.split("/users/")[1] ?? "");
    const externalIds = identities.get(id);
    return externalIds ? json(200, { id, externalIds }) : json(404);
  }
  return json(200, { writeLock: "w" });
};

beforeAll(async () => {
  Object.assign(process.env, {
    UGS_PROJECT_ID: PROJECT,
    UGS_ENVIRONMENT_ID: ENV,
    UGS_SERVICE_ACCOUNT_KEY_ID: "key-id",
    UGS_SERVICE_ACCOUNT_SECRET: "test-secret",
    UGS_OIDC_PROVIDER: PROVIDER,
    UGS_MIRROR_MAX_PER_MIN: "33",
  });
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const local = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "public:e2e", alg: "RS256", use: "sig" }] });
  keysImpl = local;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(UGS_FETCH)
    .useValue(async (url: string, init: RequestInit) => {
      const call: Call = {
        method: init.method ?? "GET",
        url,
        auth: new Headers(init.headers).get("authorization"),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return handler(call);
    })
    .overrideProvider(UGS_KEYS)
    .useValue(((header: any, token: any) => keysImpl(header, token)) as JWTVerifyGetKey)
    .overrideProvider(UGS_PROOF_BUCKET)
    .useValue(proofBucket)
    .overrideProvider(UGS_WORKER_OPTIONS)
    .useValue({ autoStart: false, intervalMs: 1000, clock: () => Date.now() })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  worker = app.get(MirrorWorker);
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});

afterAll(async () => {
  await sql?.end();
  await app?.close();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

beforeEach(async () => {
  calls.length = 0;
  handler = defaultHandler;
  identities.clear();
  proofBucket.reset(Date.now());
  await sql.query("DELETE FROM ugs_mirror_outbox");
  await sql.query("DELETE FROM ugs_mirror_deletions");
});

async function ugsToken(sub: string, claims: Record<string, unknown> = { project_id: PROJECT, envId: ENV }, expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "public:e2e" })
    .setIssuer(UGS_ISSUER)
    .setSubject(sub)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + expiresIn)
    .sign(privateKey);
}

async function newPlayer(options: { link?: boolean } = {}) {
  const uid = `uid-${randomUUID()}`;
  const principal = `${PREFIX}${uid}`;
  const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
  const created = await request(server).put("/v1/me").set(auth);
  expect(created.status).toBe(201);
  const ugsId = `ugs${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const player = {
    uid,
    principal,
    auth,
    ugsId,
    link: async (id = ugsId, proveUid = uid) => {
      identities.set(id, [{ externalId: proveUid, providerId: PROVIDER }]);
      return request(server).put("/v1/me/ugs-link").set(auth).send({ ugsToken: await ugsToken(id) });
    },
  };
  if (options.link) expect((await player.link()).status).toBe(201);
  return player;
}

type Player = Awaited<ReturnType<typeof newPlayer>>;

async function bankRound(player: Player) {
  const issued = await request(server).post("/v1/rounds").set(player.auth).send({ module: "identifier" });
  expect(issued.status).toBe(201);
  const roundId = issued.body.round.roundId as string;
  await sql.query("UPDATE rounds SET issued_at = issued_at - ($1::int * interval '1 millisecond') WHERE id = $2", [MIN_ROUND_MS * 2, roundId]);
  const res = await request(server)
    .post(`/v1/rounds/${roundId}/result`)
    .set(player.auth)
    .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9 });
  expect(res.status).toBe(200);
  return { roundId, response: res };
}

const outbox = async (principal: string) =>
  (await sql.query("SELECT * FROM ugs_mirror_outbox WHERE player_id = $1", [principal])).rows[0];
const versionOf = async (principal: string) =>
  (await sql.query<{ version: number }>("SELECT version FROM players WHERE id = $1", [principal])).rows[0]?.version;
const count = async (table: string) => (await sql.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0]?.n;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let clock = 0;
/** A distinct, increasing "now" one hour apart, so each tick's token bucket is full and old backoffs have lapsed. */
const nextNow = () => Date.now() + 3_600_000 * (++clock + 1);

describe("PUT /v1/me/ugs-link", () => {
  it("links with server-side proof: 201, a link row, an immediate outbox row; the proof uses service-account Basic auth", async () => {
    const player = await newPlayer();
    const res = await player.link();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ link: { linkedAt: expect.any(String) } });
    expect(res.headers["cache-control"]).toBe("no-store");
    const proof = calls.find((c) => c.method === "GET");
    expect(proof?.url).toContain(`/player-identity/v1/projects/${PROJECT}/users/${player.ugsId}`);
    expect(proof?.auth).toBe(`Basic ${Buffer.from("key-id:test-secret").toString("base64")}`);
    const link = (await sql.query("SELECT * FROM ugs_links WHERE player_id = $1", [player.principal])).rows[0];
    expect(link.ugs_player_id).toBe(player.ugsId);
    expect(await outbox(player.principal)).toMatchObject({ version: 1, attempts: 0 });
    expect(await versionOf(player.principal)).toBe(1); // linking is not a balance change
  });

  it("is idempotent for the same UGS player (200, same linkedAt, one row each)", async () => {
    const player = await newPlayer();
    const first = await player.link();
    const again = await player.link();
    expect(again.status).toBe(200);
    expect(again.body.link.linkedAt).toBe(first.body.link.linkedAt);
    expect((await sql.query("SELECT 1 FROM ugs_links WHERE player_id = $1", [player.principal])).rowCount).toBe(1);
    expect((await sql.query("SELECT 1 FROM ugs_mirror_outbox WHERE player_id = $1", [player.principal])).rowCount).toBe(1);
  });

  it("replaces the link for a different UGS id (200), keeps version and progress, queues deleting the old copy", async () => {
    const player = await newPlayer({ link: true });
    await bankRound(player);
    const before = await versionOf(player.principal);
    const other = `ugs${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const res = await player.link(other);
    expect(res.status).toBe(200);
    expect((await sql.query("SELECT ugs_player_id FROM ugs_links WHERE player_id = $1", [player.principal])).rows[0].ugs_player_id).toBe(other);
    expect(await versionOf(player.principal)).toBe(before);
    expect((await sql.query("SELECT 1 FROM ugs_mirror_deletions WHERE ugs_player_id = $1", [player.ugsId])).rowCount).toBe(1);
  });

  it("403 forbidden without proof: no identity, wrong provider, someone else's uid, or an unknown UGS player", async () => {
    const player = await newPlayer();
    const attempt = async (id: string) =>
      request(server).put("/v1/me/ugs-link").set(player.auth).send({ ugsToken: await ugsToken(id) });
    identities.set("ugsNoIdentity", []);
    identities.set("ugsWrongProvider", [{ externalId: player.uid, providerId: "oidc-other" }]);
    identities.set("ugsOtherUid", [{ externalId: "someone-else", providerId: PROVIDER }]);
    for (const id of ["ugsNoIdentity", "ugsWrongProvider", "ugsOtherUid", "ugsUnknown"]) {
      const res = await attempt(id);
      expect(res.status, id).toBe(403);
      expect(res.body.error).toMatchObject({ code: "forbidden", message: "UGS account is not linked to this sign-in" });
    }
    expect((await sql.query("SELECT 1 FROM ugs_links WHERE player_id = $1", [player.principal])).rowCount).toBe(0);
  });

  it("409 ugs_link_conflict when the UGS player is already linked to another principal", async () => {
    const first = await newPlayer({ link: true });
    const second = await newPlayer();
    identities.set(first.ugsId, [
      { externalId: first.uid, providerId: PROVIDER },
      { externalId: second.uid, providerId: PROVIDER },
    ]);
    const res = await request(server).put("/v1/me/ugs-link").set(second.auth).send({ ugsToken: await ugsToken(first.ugsId) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ugs_link_conflict");
    expect((await sql.query("SELECT 1 FROM ugs_links WHERE player_id = $1", [second.principal])).rowCount).toBe(0);
  });

  it("400 invalid_request for a bad UGS token (clear message), a wrong project, an expired token and a bad body; 401 only for Firebase", async () => {
    const player = await newPlayer();
    const put = (body: unknown, headers = player.auth) => request(server).put("/v1/me/ugs-link").set(headers).send(body as object);
    const wrongProject = await put({ ugsToken: await ugsToken("ugsX", { project_id: "another", envId: ENV }) });
    expect(wrongProject.status).toBe(400);
    expect(wrongProject.body.error).toMatchObject({ code: "invalid_request", message: "UGS token rejected: wrong project." });
    const expired = await put({ ugsToken: await ugsToken("ugsX", undefined, -120) });
    expect(expired.body.error.message).toBe("UGS token rejected: expired.");
    expect((await put({ ugsToken: "garbage" })).body.error.message).toBe("UGS token rejected: malformed.");
    expect((await put({ ugsToken: "x", playerId: "ugs-chosen-by-client" })).status).toBe(400); // strict body
    expect((await put({})).status).toBe(400);
    expect(calls).toEqual([]); // nothing reached UGS for a rejected token
    const noAuth = await request(server).put("/v1/me/ugs-link").send({ ugsToken: "x" });
    expect(noAuth.status).toBe(401);
  });

  it("404 player_not_found before any UGS call when PUT /v1/me was never made", async () => {
    const auth = { Authorization: `Bearer ${emulatorToken(`uid-${randomUUID()}`)}` };
    const res = await request(server).put("/v1/me/ugs-link").set(auth).send({ ugsToken: await ugsToken("ugsY") });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("player_not_found");
    expect(calls).toEqual([]);
  });

  it("503 auth_unavailable when the UGS signing keys cannot be fetched; 503 service_unavailable when the admin API fails", async () => {
    const player = await newPlayer();
    const token = await ugsToken(player.ugsId);
    const real = keysImpl;
    keysImpl = async () => {
      throw new AuthUnavailableError();
    };
    const keysDown = await request(server).put("/v1/me/ugs-link").set(player.auth).send({ ugsToken: token });
    keysImpl = real;
    expect(keysDown.status).toBe(503);
    expect(keysDown.body.error.code).toBe("auth_unavailable");
    expect(keysDown.headers["retry-after"]).toBe("5");

    for (const failing of [() => json(500), () => json(401), () => json(429), () => { throw new TypeError("fetch failed"); }]) {
      handler = failing;
      const res = await request(server).put("/v1/me/ugs-link").set(player.auth).send({ ugsToken: token });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("service_unavailable");
    }
    expect((await sql.query("SELECT 1 FROM ugs_links WHERE player_id = $1", [player.principal])).rowCount).toBe(0);
  });

  it("an already-linked principal with a valid token for the same UGS player gets 200 without a Player Auth admin call", async () => {
    const player = await newPlayer({ link: true });
    calls.length = 0;
    const again = await request(server).put("/v1/me/ugs-link").set(player.auth).send({ ugsToken: await ugsToken(player.ugsId) });
    expect(again.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("a stale holder loses the link: when the UGS player no longer carries the holder's uid, it moves to the caller", async () => {
    const holder = await newPlayer({ link: true });
    await bankRound(holder);
    const caller = await newPlayer();
    identities.set(holder.ugsId, [{ externalId: caller.uid, providerId: PROVIDER }]); // re-linked to the caller in UGS
    calls.length = 0;
    const res = await request(server).put("/v1/me/ugs-link").set(caller.auth).send({ ugsToken: await ugsToken(holder.ugsId) });
    expect(res.status).toBe(201);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1); // the one proof is re-used for the holder check
    const links = (await sql.query("SELECT player_id FROM ugs_links WHERE ugs_player_id = $1", [holder.ugsId])).rows;
    expect(links).toEqual([{ player_id: caller.principal }]);
    expect(await outbox(holder.principal)).toBeUndefined();
    expect(await outbox(caller.principal)).toBeDefined();
    expect(await count("ugs_mirror_deletions")).toBe(0); // the UGS player is the caller's: nothing to delete
  });

  it("a stale holder move that replaces the caller's own older link also queues deleting that older copy", async () => {
    const holder = await newPlayer({ link: true });
    const caller = await newPlayer({ link: true });
    identities.set(holder.ugsId, [{ externalId: caller.uid, providerId: PROVIDER }]);
    const res = await request(server).put("/v1/me/ugs-link").set(caller.auth).send({ ugsToken: await ugsToken(holder.ugsId) });
    expect(res.status).toBe(200);
    const row = (await sql.query("SELECT ugs_player_id FROM ugs_links WHERE player_id = $1", [caller.principal])).rows[0];
    expect(row.ugs_player_id).toBe(holder.ugsId);
    expect((await sql.query("SELECT 1 FROM ugs_links WHERE player_id = $1", [holder.principal])).rowCount).toBe(0);
    expect((await sql.query("SELECT 1 FROM ugs_mirror_deletions WHERE ugs_player_id = $1", [caller.ugsId])).rowCount).toBe(1);
  });

  it("429 rate_limited after 5 proofs per hour for one principal; idempotent re-links do not count", async () => {
    const player = await newPlayer();
    for (let i = 0; i < 5; i += 1) {
      const res = await player.link(`ugsThrottle${i}${randomUUID().replace(/-/g, "").slice(0, 8)}`);
      expect(res.status).toBe(i === 0 ? 201 : 200);
    }
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(5);
    const sixth = await player.link(`ugsThrottle6${randomUUID().replace(/-/g, "").slice(0, 8)}`);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe("rate_limited");
    expect(Number(sixth.headers["retry-after"])).toBeGreaterThan(0);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(5); // refused before any admin call
    const current = (await sql.query("SELECT ugs_player_id FROM ugs_links WHERE player_id = $1", [player.principal])).rows[0].ugs_player_id;
    calls.length = 0;
    const same = await request(server).put("/v1/me/ugs-link").set(player.auth).send({ ugsToken: await ugsToken(current) });
    expect(same.status).toBe(200);
    expect(calls).toHaveLength(0);
    const other = await newPlayer(); // a different principal is unaffected
    expect((await other.link()).status).toBe(201);
  });

  it("503 service_unavailable with Retry-After when the process-wide Player Auth budget is empty; no admin call", async () => {
    const player = await newPlayer();
    while (proofBucket.take(Date.now())) {
      // drain
    }
    identities.set(player.ugsId, [{ externalId: player.uid, providerId: PROVIDER }]);
    calls.length = 0;
    const res = await request(server).put("/v1/me/ugs-link").set(player.auth).send({ ugsToken: await ugsToken(player.ugsId) });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("service_unavailable");
    expect(res.headers["retry-after"]).toBe("5");
    expect(calls).toHaveLength(0);
    proofBucket.reset(Date.now());
    expect((await player.link()).status).toBe(201);
  });

  it("ASSUMPTION (UNVERIFIED): the OIDC link's externalId is the Firebase uid, and providerId is UGS_OIDC_PROVIDER", async () => {
    const player = await newPlayer();
    identities.set(player.ugsId, [{ externalId: player.principal, providerId: PROVIDER }]); // the full principal is NOT the uid
    const res = await request(server).put("/v1/me/ugs-link").set(player.auth).send({ ugsToken: await ugsToken(player.ugsId) });
    expect(res.status).toBe(403);
  });
});

describe("outbox: every progress write enqueues in its own transaction, for linked players only", () => {
  it("banked Round: one row at the new version; none for an unlinked player; the Round replay adds nothing", async () => {
    const linked = await newPlayer({ link: true });
    const unlinked = await newPlayer();
    await sql.query("DELETE FROM ugs_mirror_outbox"); // drop the on-link row to observe the Round's own
    const { roundId } = await bankRound(linked);
    await bankRound(unlinked);
    expect(await outbox(linked.principal)).toMatchObject({ version: 2 });
    expect(await outbox(unlinked.principal)).toBeUndefined();
    const genBefore = (await outbox(linked.principal)).generation;
    const replay = await request(server)
      .post(`/v1/rounds/${roundId}/result`)
      .set(linked.auth)
      .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9 });
    expect(replay.body.replayed).toBe(true);
    expect((await outbox(linked.principal)).generation).toBe(genBefore);
  });

  it("coalesces: two Rounds leave one row at the latest version", async () => {
    const player = await newPlayer({ link: true });
    await sql.query("DELETE FROM ugs_mirror_outbox");
    await bankRound(player);
    const firstGeneration = Number((await outbox(player.principal)).generation);
    await bankRound(player);
    const rows = (await sql.query("SELECT * FROM ugs_mirror_outbox WHERE player_id = $1", [player.principal])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 3 });
    expect(Number(rows[0].generation)).toBeGreaterThan(firstGeneration);
    expect(await versionOf(player.principal)).toBe(3);
  });

  it("a refused write (round_too_fast) enqueues nothing", async () => {
    const player = await newPlayer({ link: true });
    await sql.query("DELETE FROM ugs_mirror_outbox");
    const issued = await request(server).post("/v1/rounds").set(player.auth).send({ module: "identifier" });
    const res = await request(server)
      .post(`/v1/rounds/${issued.body.round.roundId}/result`)
      .set(player.auth)
      .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9 });
    expect(res.status).toBe(429); // round_too_fast: refused without writing anything
    expect(await outbox(player.principal)).toBeUndefined();
  });

  it("hint spend enqueues (version + 1); a replayed spend does not", async () => {
    const player = await newPlayer({ link: true });
    await sql.query("DELETE FROM ugs_mirror_outbox");
    const issued = await request(server).post("/v1/rounds").set(player.auth).send({ module: "identifier" });
    const path = `/v1/rounds/${issued.body.round.roundId}/hint`;
    expect((await request(server).post(path).set(player.auth)).status).toBe(200);
    const row = await outbox(player.principal);
    expect(row).toMatchObject({ version: 2 });
    expect((await request(server).post(path).set(player.auth)).body.hint.replayed).toBe(true);
    expect((await outbox(player.principal)).generation).toBe(row.generation);
  });

  it("hint-pack purchase enqueues (version + 1); a replayed key does not; unlinked players get no row", async () => {
    const linked = await newPlayer({ link: true });
    const unlinked = await newPlayer();
    for (const player of [linked, unlinked]) {
      await sql.query("UPDATE players SET miles = miles + 5000 WHERE id = $1", [player.principal]);
      await sql.query("INSERT INTO miles_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, 5000, 'round_award', $2, now())", [player.principal, randomUUID()]);
    }
    await sql.query("DELETE FROM ugs_mirror_outbox");
    const buy = (player: Player) => request(server).post("/v1/shop/miles-hint-pack").set(player.auth).set("Idempotency-Key", "pack-1");
    expect((await buy(linked)).status).toBe(200);
    expect((await buy(unlinked)).status).toBe(200);
    const row = await outbox(linked.principal);
    expect(row).toMatchObject({ version: 2 });
    expect(await outbox(unlinked.principal)).toBeUndefined();
    expect((await buy(linked)).body.purchase.replayed).toBe(true);
    expect((await outbox(linked.principal)).generation).toBe(row.generation);
  });

  it("Active Rank change bumps players.version and enqueues (D-1)", async () => {
    const player = await newPlayer({ link: true });
    await sql.query("UPDATE players SET status_points = 10000 WHERE id = $1", [player.principal]); // First Officer
    await sql.query("DELETE FROM ugs_mirror_outbox");
    const res = await request(server).put("/v1/me/active-rank").set(player.auth).send({ rank: "trainee" });
    expect(res.status).toBe(200);
    expect(await versionOf(player.principal)).toBe(2);
    expect(await outbox(player.principal)).toMatchObject({ version: 2 });
    // A refused change (above Certified) writes nothing.
    await sql.query("DELETE FROM ugs_mirror_outbox");
    expect((await request(server).put("/v1/me/active-rank").set(player.auth).send({ rank: "captain" })).status).toBe(403);
    expect(await outbox(player.principal)).toBeUndefined();
    // Choosing the rank already in force (Trainee, now dialled) changes nothing and enqueues nothing.
    expect((await request(server).put("/v1/me/active-rank").set(player.auth).send({ rank: "trainee" })).status).toBe(200);
    expect(await outbox(player.principal)).toBeUndefined();
  });

  it("a rolled-back transaction leaves no outbox row (the enqueue shares the writer's transaction)", async () => {
    const player = await newPlayer({ link: true });
    await sql.query("DELETE FROM ugs_mirror_outbox");
    const database = app.get(DatabaseService);
    await expect(
      database.withTransaction(async (tx) => {
        await enqueueMirror(tx, player.principal, 9, new Date());
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await outbox(player.principal)).toBeUndefined();
    await database.withTransaction(async (tx) => {
      await enqueueMirror(tx, player.principal, 9, new Date());
    });
    expect(await outbox(player.principal)).toMatchObject({ version: 9 });
  });


  it("PUT /v1/me create enqueues nothing (a new player cannot be linked)", async () => {
    const player = await newPlayer();
    expect(await outbox(player.principal)).toBeUndefined();
  });
});

describe("mirror worker (stubbed UGS)", () => {
  const writes = () => calls.filter((c) => c.method === "POST");

  it("writes the Protected progress item with the documented value, then deletes the row", async () => {
    const player = await newPlayer({ link: true });
    await bankRound(player);
    calls.length = 0;
    const summary = await worker.tick(nextNow());
    expect(summary).toMatchObject({ written: 1, retried: 0, rateLimited: false });
    expect(writes()).toHaveLength(1);
    const call = writes()[0]!;
    expect(call.url).toBe(`https://services.api.unity.com/cloud-save/v1/data/projects/${PROJECT}/environments/${ENV}/players/${player.ugsId}/protected/items`);
    expect(call.auth).toBe(`Basic ${Buffer.from("key-id:test-secret").toString("base64")}`);
    expect(call.body.key).toBe("progress");
    expect(call.body).not.toHaveProperty("writeLock");
    const progress = (await request(server).get("/v1/me/progress").set(player.auth)).body.progress;
    expect(Object.keys(call.body.value)).toEqual([
      "schemaVersion", "version", "statusPoints", "miles", "hints", "perfectStreak",
      "certifiedRank", "activeRank", "firstClassUntil", "updatedAt",
    ]);
    expect(call.body.value).toMatchObject({
      schemaVersion: 1,
      version: 2,
      statusPoints: progress.statusPoints,
      miles: progress.miles,
      hints: progress.hints,
      perfectStreak: progress.perfectStreak,
      certifiedRank: progress.certifiedRank,
      activeRank: progress.activeRank,
      firstClassUntil: null,
    });
    expect(call.body.value.updatedAt).toEqual(expect.any(String));
    expect(await outbox(player.principal)).toBeUndefined();
  });

  it("a change made while the write is in flight keeps the row, due now (no lost update)", async () => {
    const player = await newPlayer({ link: true });
    const inflight = deferred();
    const gate = deferred();
    handler = async (call) => {
      if (call.method === "POST") {
        inflight.resolve();
        await gate.promise;
      }
      return json(200);
    };
    const now = nextNow();
    const tick = worker.tick(now);
    await inflight.promise;
    const claimed = await outbox(player.principal);
    expect(claimed.claim_id).not.toBeNull();
    await bankRound(player); // a real concurrent enqueue through the API, while the write is in flight
    const bumped = await outbox(player.principal);
    expect(Number(bumped.generation)).toBeGreaterThan(Number(claimed.generation));
    gate.resolve();
    expect((await tick).written).toBe(1);
    const row = await outbox(player.principal);
    expect(row).toBeDefined();
    expect(row.version).toBe(2);
    expect(row.claim_id).toBeNull();
    expect(new Date(row.due_at).getTime()).toBeLessThanOrEqual(now);
    handler = defaultHandler;
    expect((await worker.tick(nextNow())).written).toBe(1);
    expect(await outbox(player.principal)).toBeUndefined();
  });

  it("lease expiry: a stale worker cannot delete a row another claim (or a re-inserted row) owns, and generations never repeat", async () => {
    const player = await newPlayer({ link: true });
    const inflight = deferred();
    const gate = deferred();
    let first = true;
    handler = async (call) => {
      if (call.method === "POST" && first) {
        first = false;
        inflight.resolve();
        await gate.promise;
      }
      return json(200);
    };
    const t0 = nextNow();
    const stale = worker.tick(t0);
    await inflight.promise;
    const claimedA = await outbox(player.principal);
    // The lease runs out; another pass claims the row, writes it and removes it.
    expect((await worker.tick(t0 + LEASE_MS + 1_000)).written).toBe(1);
    expect(await outbox(player.principal)).toBeUndefined();
    // A new change re-inserts the row. A restarting counter would hand out the stale worker's generation again.
    await bankRound(player);
    const rowB = await outbox(player.principal);
    expect(Number(rowB.generation)).toBeGreaterThan(Number(claimedA.generation));
    gate.resolve();
    await stale;
    const after = await outbox(player.principal);
    expect(after).toBeDefined();
    expect(after.claim_id).toBe(rowB.claim_id);
    expect(after.generation).toBe(rowB.generation);
    expect(new Date(after.due_at).getTime()).toBe(new Date(rowB.due_at).getTime());
  });

  it("429 pauses the whole worker for Retry-After and keeps every row; it resumes afterwards", async () => {
    const a = await newPlayer({ link: true });
    const b = await newPlayer({ link: true });
    handler = () => json(429, {}, { "retry-after": "30" });
    const now = nextNow();
    const first = await worker.tick(now);
    expect(first.rateLimited).toBe(true);
    expect(writes()).toHaveLength(1); // the second row was not even attempted
    expect(await count("ugs_mirror_outbox")).toBe(2);
    calls.length = 0;
    expect((await worker.tick(now + 10_000)).written).toBe(0); // still paused
    expect(calls).toHaveLength(0);
    const dueAt = new Date((await outbox(a.principal)).due_at).getTime();
    expect(dueAt).toBeGreaterThanOrEqual(now + 30_000 - 1000);
    expect((await outbox(a.principal)).attempts).toBe(0);
    handler = defaultHandler;
    const resumed = await worker.tick(now + 31_000);
    expect(resumed.written).toBe(2);
    expect(await outbox(b.principal)).toBeUndefined();
  });

  it("5xx and network errors back off per row (5 s, then 10 s), keep the row and record a short status only", async () => {
    const player = await newPlayer({ link: true });
    handler = () => json(503, { message: "secret body that must never be stored" });
    let now = nextNow();
    expect((await worker.tick(now)).retried).toBe(1);
    let row = await outbox(player.principal);
    expect(row).toMatchObject({ attempts: 1, last_error: "http 503" });
    expect(new Date(row.due_at).getTime()).toBe(now + 5_000);
    calls.length = 0;
    expect((await worker.tick(now + 1_000)).retried).toBe(0); // not due yet
    expect(calls).toHaveLength(0);
    handler = () => {
      throw new TypeError("fetch failed");
    };
    now += 6_000;
    await worker.tick(now);
    row = await outbox(player.principal);
    expect(row).toMatchObject({ attempts: 2, last_error: "http network" });
    expect(new Date(row.due_at).getTime()).toBe(now + 10_000);
    handler = defaultHandler;
    expect((await worker.tick(now + 11_000)).written).toBe(1);
    expect(await outbox(player.principal)).toBeUndefined();
  });

  it("another 4xx backs off for an hour, once-logged, and does not block other players", async () => {
    const bad = await newPlayer({ link: true });
    const good = await newPlayer({ link: true });
    handler = (call) => (call.url.includes(`/players/${bad.ugsId}/`) ? json(400) : json(200));
    const now = nextNow();
    const summary = await worker.tick(now);
    expect(summary).toMatchObject({ written: 1, rejected: 1 });
    const row = await outbox(bad.principal);
    expect(row).toMatchObject({ attempts: 1, last_error: "http 400" });
    expect(new Date(row.due_at).getTime()).toBe(now + 3_600_000);
    expect(await outbox(good.principal)).toBeUndefined();
  });

  it("paces itself with the token bucket: no more writes in a tick than tokens, the rest stay due", async () => {
    const players = [];
    for (let i = 0; i < 12; i += 1) players.push(await newPlayer({ link: true }));
    const now = nextNow();
    expect((await worker.tick(now)).written).toBe(10); // UGS_MIRROR_MAX_PER_MIN=33 -> burst of 10
    expect(await count("ugs_mirror_outbox")).toBe(2);
    expect((await worker.tick(now + 100)).written).toBe(0); // bucket still empty a moment later
    expect((await worker.tick(now + 60_000)).written).toBe(2); // a minute later the rest go
  });

  it("a player deleted after queueing is dropped without a UGS call", async () => {
    const player = await newPlayer({ link: true });
    await sql.query("DELETE FROM ugs_links WHERE player_id = $1", [player.principal]);
    calls.length = 0;
    await worker.tick(nextNow());
    expect(writes()).toHaveLength(0);
    expect(await outbox(player.principal)).toBeUndefined();
  });

  it("two workers claiming at once never take the same row (SKIP LOCKED lease)", async () => {
    for (let i = 0; i < 4; i += 1) await newPlayer({ link: true });
    const now = nextNow();
    const [a, b] = await Promise.all([worker.tick(now), worker.tick(now)]);
    expect(a.written + b.written).toBe(4);
    expect(writes()).toHaveLength(4);
    expect(new Set(writes().map((c) => c.url)).size).toBe(4);
  });
});

describe("mirror worker resilience", () => {
  const writes = () => calls.filter((c) => c.method === "POST");
  const deletes = () => calls.filter((c) => c.method === "DELETE");
  const events = (spy: { mock: { calls: unknown[][] } }, event: string) =>
    spy.mock.calls.map((c) => c[0]).filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null && (m as { event?: unknown }).event === event);
  const fresh = () => new MirrorWorker(app.get(DatabaseService), app.get(UGS_CLIENT), app.get(UGS_WORKER_OPTIONS), app.get(APP_CONFIG));

  // Own worker (own token bucket and pause state): these tests tick far into the future.
  let w: MirrorWorker;
  beforeEach(() => {
    w = fresh();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a deletion is not due until any write in flight at deletion time must have ended, so it cannot be undone by a stale write", async () => {
    const player = await newPlayer({ link: true });
    const inflight = deferred();
    const gate = deferred();
    handler = async (call) => {
      if (call.method === "POST") {
        inflight.resolve();
        await gate.promise;
      }
      return json(200);
    };
    const stale = w.tick(nextNow()); // claims the row; its write is now stuck in flight
    await inflight.promise;
    const before = Date.now();
    expect((await request(server).delete("/v1/me").set(player.auth)).status).toBe(204);
    const deletion = (await sql.query("SELECT due_at FROM ugs_mirror_deletions WHERE ugs_player_id = $1", [player.ugsId])).rows[0];
    const dueAt = new Date(deletion.due_at).getTime();
    expect(dueAt).toBeGreaterThanOrEqual(before + LEASE_MS + REQUEST_TIMEOUT_MS);
    expect(dueAt).toBeLessThan(Date.now() + LEASE_MS + REQUEST_TIMEOUT_MS + 5_000);

    const other = fresh(); // own token bucket, so real-time ticks are possible
    expect((await other.tick(before + LEASE_MS)).deleted).toBe(0); // too early: a stale write could still land
    expect(deletes()).toHaveLength(0);
    gate.resolve();
    await stale; // the stale write lands (and finds nothing to remove)
    expect((await other.tick(before + LEASE_MS + REQUEST_TIMEOUT_MS + 5_000)).deleted).toBe(1);
    expect(deletes()).toHaveLength(1);
    expect(calls.findIndex((c) => c.method === "DELETE")).toBeGreaterThan(calls.findIndex((c) => c.method === "POST"));
  });

  it("our own credentials refused (401): the whole worker pauses 15 minutes with ONE error log; rows are kept without attempts", async () => {
    const a = await newPlayer({ link: true });
    const b = await newPlayer({ link: true });
    const error = vi.spyOn(Logger.prototype, "error");
    handler = () => json(401);
    const now = nextNow();
    const first = await w.tick(now);
    expect(first).toMatchObject({ credentialsRejected: true, written: 0 });
    expect(writes()).toHaveLength(1); // the second row was not even tried
    expect(events(error, "ugs_mirror_credentials_rejected")).toHaveLength(1);
    for (const p of [a, b]) {
      const row = await outbox(p.principal);
      expect(row).toMatchObject({ attempts: 0 });
      expect(new Date(row.due_at).getTime()).toBe(now + 15 * 60_000);
    }
    calls.length = 0;
    await w.tick(now + 60_000);
    await w.tick(now + 14 * 60_000);
    expect(calls).toHaveLength(0);
    expect(events(error, "ugs_mirror_credentials_rejected")).toHaveLength(1);
    handler = defaultHandler;
    expect((await w.tick(now + 15 * 60_000 + 1_000)).written).toBe(2);
  });

  it("a write rejected with a 4xx is dropped after 3 attempts, logged once as rejected and once as dropped; the next change queues it afresh", async () => {
    const player = await newPlayer({ link: true });
    const warn = vi.spyOn(Logger.prototype, "warn");
    handler = () => json(400);
    const now = nextNow();
    await w.tick(now);
    expect(await outbox(player.principal)).toMatchObject({ attempts: 1, last_error: "http 400" });
    await w.tick(now + 3_600_000 + 1_000);
    expect(await outbox(player.principal)).toMatchObject({ attempts: 2 });
    await w.tick(now + 2 * (3_600_000 + 1_000));
    expect(await outbox(player.principal)).toBeUndefined();
    expect(events(warn, "ugs_mirror_rejected")).toHaveLength(1);
    expect(events(warn, "ugs_mirror_dropped")).toHaveLength(1);
    handler = defaultHandler;
    await bankRound(player);
    expect((await w.tick(nextNow())).written).toBe(1);
  });

  it("a rejected deletion is never dropped: it is retried daily after the cap; the once-log resets after success", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn");
    const ugsId = `ugsdel${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const queue = () =>
      sql.query("INSERT INTO ugs_mirror_deletions (ugs_player_id, due_at, created_at) VALUES ($1, now(), now())", [ugsId]);
    await queue();
    handler = () => json(400);
    const now = nextNow();
    for (let i = 0; i < 3; i += 1) await w.tick(now + i * (3_600_000 + 1_000));
    const row = (await sql.query("SELECT * FROM ugs_mirror_deletions WHERE ugs_player_id = $1", [ugsId])).rows[0];
    expect(row).toMatchObject({ attempts: 3 });
    expect(new Date(row.due_at).getTime()).toBe(now + 2 * (3_600_000 + 1_000) + 24 * 3_600_000);
    expect(events(warn, "ugs_mirror_rejected")).toHaveLength(1);
    handler = defaultHandler;
    expect((await w.tick(now + 3 * 24 * 3_600_000)).deleted).toBe(1);
    await queue(); // the same id again: the earlier "already logged" entry must be gone
    handler = () => json(400);
    await w.tick(now + 4 * 24 * 3_600_000);
    expect(events(warn, "ugs_mirror_rejected")).toHaveLength(2);
  });

  it("logs the backlog and oldest lag on every tick with due rows, even while throttled or paused", async () => {
    const log = vi.spyOn(Logger.prototype, "log");
    for (let i = 0; i < 12; i += 1) await newPlayer({ link: true });
    const now = nextNow();
    expect((await w.tick(now)).written).toBe(10);
    log.mockClear();
    const throttled = await w.tick(now + 100); // bucket empty: nothing is taken, two rows are still due
    expect(throttled).toMatchObject({ written: 0, backlog: 2 });
    expect(throttled.lagMs).toBeGreaterThanOrEqual(0);
    expect(events(log, "ugs_mirror_batch")).toHaveLength(1);
    expect(events(log, "ugs_mirror_batch")[0]).toMatchObject({ backlog: 2, paused: false });

    // Paused by a 429: a row queued meanwhile is due and is reported.
    handler = () => json(429, {}, { "retry-after": "60" });
    await w.tick(now + 60_000);
    handler = defaultHandler;
    const extra = await newPlayer({ link: true });
    await bankRound(extra);
    log.mockClear();
    const paused = await w.tick(now + 61_000);
    expect(paused.written).toBe(0);
    expect(paused.backlog).toBeGreaterThanOrEqual(1);
    expect(events(log, "ugs_mirror_batch")[0]).toMatchObject({ paused: true });
    expect(JSON.stringify(log.mock.calls)).not.toContain(extra.ugsId); // counts only, never ids
  });
});

describe("account deletion", () => {
  it("DELETE /v1/me removes the link and outbox row, records the UGS id for deletion, and the worker deletes the copy", async () => {
    const player = await newPlayer({ link: true });
    await bankRound(player);
    expect((await request(server).delete("/v1/me").set(player.auth)).status).toBe(204);
    expect((await sql.query("SELECT 1 FROM ugs_links WHERE player_id = $1", [player.principal])).rowCount).toBe(0);
    expect(await outbox(player.principal)).toBeUndefined();
    const deletion = (await sql.query("SELECT * FROM ugs_mirror_deletions WHERE ugs_player_id = $1", [player.ugsId])).rows[0];
    expect(deletion).toBeDefined();
    calls.length = 0;
    const summary = await worker.tick(nextNow());
    expect(summary.deleted).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "DELETE" });
    expect(calls[0]?.url).toBe(`https://services.api.unity.com/cloud-save/v1/data/projects/${PROJECT}/environments/${ENV}/players/${player.ugsId}/protected/items/progress`);
    expect(await count("ugs_mirror_deletions")).toBe(0);
  });

  it("deleting an unlinked account records nothing; a failed UGS delete is retried with backoff", async () => {
    const unlinked = await newPlayer();
    await request(server).delete("/v1/me").set(unlinked.auth);
    expect(await count("ugs_mirror_deletions")).toBe(0);

    const player = await newPlayer({ link: true });
    await request(server).delete("/v1/me").set(player.auth);
    handler = () => json(500);
    const now = nextNow();
    expect((await worker.tick(now)).retried).toBe(1);
    const row = (await sql.query("SELECT * FROM ugs_mirror_deletions")).rows[0];
    expect(row).toMatchObject({ attempts: 1, last_error: "http 500" });
    handler = defaultHandler;
    expect((await worker.tick(now + 6_000)).deleted).toBe(1);
  });

  it("re-linking the same UGS player after a deletion cancels the pending deletion", async () => {
    const player = await newPlayer({ link: true });
    await request(server).delete("/v1/me").set(player.auth);
    expect(await count("ugs_mirror_deletions")).toBe(1);
    expect((await request(server).put("/v1/me").set(player.auth)).status).toBe(201); // fresh player, same uid
    expect((await player.link()).status).toBe(201);
    expect(await count("ugs_mirror_deletions")).toBe(0);
  });
});

describe("mirror disabled", () => {
  it("PUT /v1/me/ugs-link is 404 not_found and no write path enqueues when UGS_* is not configured", async () => {
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith("UGS_")) delete process.env[key];
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(UGS_FETCH)
      .useValue(async () => {
        throw new Error("no network in tests");
      })
      .compile();
    const off = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApp(off);
    await off.listen(0, "127.0.0.1");
    try {
      const auth = { Authorization: `Bearer ${emulatorToken(`uid-${randomUUID()}`)}` };
      await request(off.getHttpServer()).put("/v1/me").set(auth);
      const res = await request(off.getHttpServer()).put("/v1/me/ugs-link").set(auth).send({ ugsToken: "x" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    } finally {
      await off.close();
      Object.assign(process.env, saved);
    }
  });
});
