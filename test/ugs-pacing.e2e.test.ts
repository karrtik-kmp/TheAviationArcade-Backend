import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTVerifyGetKey } from "jose";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PlayerBalance } from "../src/balance/player-balance.js";
import { APP_CONFIG } from "../src/config/config.module.js";
import { DatabaseService } from "../src/database/database.module.js";
import { MIN_ROUND_MS } from "../src/rounds/rounds.service.js";
import { CLOUD_SAVE_BUDGET, InMemoryUgsBudget, PLAYER_AUTH_BUDGET, PostgresUgsBudget } from "../src/ugs/budget.js";
import type { UgsBudget } from "../src/ugs/budget.js";
import { LEASE_MS, mirrorDueAt } from "../src/ugs/mirror-policy.js";
import { MirrorWorker } from "../src/ugs/mirror-worker.js";
import { REQUEST_TIMEOUT_MS } from "../src/ugs/ugs-client.js";
import { UGS_ISSUER } from "../src/ugs/ugs-token.js";
import { UGS_BUDGET, UGS_CLIENT, UGS_FETCH, UGS_KEYS, UGS_WORKER_OPTIONS } from "../src/ugs/ugs.tokens.js";
import { emulatorToken } from "./tokens.js";
import { budgetContract } from "./ugs-budget-contract.js";

// D-4 (shared UGS budget in Postgres) and C3 (minimum interval between copy writes) against the real test database.
// UGS is a stub injected as the fetcher: nothing here touches the network. Ticks use explicit clocks.

const PROJECT = "11111111-2222-3333-4444-555555555555";
const ENV = "66666666-7777-8888-9999-000000000000";
const PROVIDER = "oidc-firebase";
const PREFIX = "firebase:demo-airplane-games:";
const INTERVAL_SEC = 300;
const INTERVAL_MS = INTERVAL_SEC * 1000;

type Call = { method: string; url: string; body: any };
type Handler = (call: Call) => Response | Promise<Response>;

const calls: Call[] = [];
const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
let handler: Handler = () => json(200, { writeLock: "w" });
const identities = new Map<string, { externalId: string; providerId: string }[]>();

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;
let privateKey: CryptoKey;
let keysImpl: JWTVerifyGetKey;
let worker: MirrorWorker;
const savedEnv = { ...process.env };

beforeAll(async () => {
  Object.assign(process.env, {
    UGS_PROJECT_ID: PROJECT,
    UGS_ENVIRONMENT_ID: ENV,
    UGS_SERVICE_ACCOUNT_KEY_ID: "key-id",
    UGS_SERVICE_ACCOUNT_SECRET: "test-secret",
    UGS_OIDC_PROVIDER: PROVIDER,
    UGS_MIRROR_MAX_PER_MIN: "33", // burst of 10
    UGS_MIRROR_MIN_INTERVAL_SEC: String(INTERVAL_SEC),
  });
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  keysImpl = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "public:e2e", alg: "RS256", use: "sig" }] });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(UGS_FETCH)
    .useValue(async (url: string, init: RequestInit) => {
      const call: Call = { method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      if (call.method === "GET") {
        const id = decodeURIComponent(url.split("/users/")[1] ?? "");
        const externalIds = identities.get(id);
        return externalIds ? json(200, { id, externalIds }) : json(404);
      }
      return handler(call);
    })
    .overrideProvider(UGS_KEYS)
    .useValue(((header: any, token: any) => keysImpl(header, token)) as JWTVerifyGetKey)
    .overrideProvider(UGS_WORKER_OPTIONS)
    .useValue({ autoStart: false, intervalMs: 1000, clock: () => Date.now(), budgetTime: "caller" })
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
  handler = () => json(200, { writeLock: "w" });
  identities.clear();
  await sql.query("DELETE FROM ugs_mirror_outbox");
  await sql.query("DELETE FROM ugs_mirror_deletions");
  await sql.query("DELETE FROM ugs_mirror_pace");
  await sql.query("DELETE FROM ugs_budget");
});

let clock = 0;
/** A distinct, increasing "now" an hour apart and ahead of the real clock, so queued rows are due and old pauses have lapsed. */
const nextNow = () => Date.now() + 3_600_000 * (++clock + 1);

const database = () => app.get(DatabaseService);
const newWorker = (budget: UgsBudget) =>
  new MirrorWorker(database(), app.get(UGS_CLIENT), app.get(UGS_WORKER_OPTIONS), app.get(APP_CONFIG), budget);
/** The shared row on the caller's clock: these tests drive ticks with explicit, far-future clocks. Production uses database time. */
const callerBudget = (name = CLOUD_SAVE_BUDGET) => new PostgresUgsBudget(database(), name, 33, undefined, "caller");
const writes = () => calls.filter((c) => c.method === "POST");

async function ugsToken(sub: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ project_id: PROJECT, envId: ENV })
    .setProtectedHeader({ alg: "RS256", kid: "public:e2e" })
    .setIssuer(UGS_ISSUER)
    .setSubject(sub)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

/** A player created through the API; `link()` proves a UGS id through the (stubbed) Player Auth admin API. */
async function newPlayer() {
  const uid = `uid-${randomUUID()}`;
  const principal = `${PREFIX}${uid}`;
  const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
  expect((await request(server).put("/v1/me").set(auth)).status).toBe(201);
  const ugsId = `ugs${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  return {
    uid,
    principal,
    auth,
    ugsId,
    link: async (id = ugsId) => {
      identities.set(id, [{ externalId: uid, providerId: PROVIDER }]);
      return request(server).put("/v1/me/ugs-link").set(auth).send({ ugsToken: await ugsToken(id) });
    },
  };
}
type Player = Awaited<ReturnType<typeof newPlayer>>;

/** A linked player with a due outbox row, without calling the link API (no proof budget used). */
async function seedLinked(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const player = await newPlayer();
    await sql.query("INSERT INTO ugs_links (player_id, ugs_player_id, linked_at) VALUES ($1, $2, now())", [player.principal, player.ugsId]);
    await sql.query("INSERT INTO ugs_mirror_outbox (player_id, version, due_at) VALUES ($1, 1, now())", [player.principal]);
    ids.push(player.principal);
  }
  return ids;
}

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
}

const outbox = async (principal: string) => (await sql.query("SELECT * FROM ugs_mirror_outbox WHERE player_id = $1", [principal])).rows[0];
const pace = async (principal: string) => (await sql.query("SELECT * FROM ugs_mirror_pace WHERE player_id = $1", [principal])).rows[0];
const budgetRow = async (name: string) => (await sql.query("SELECT * FROM ugs_budget WHERE name = $1", [name])).rows[0];
const count = async (table: string) => (await sql.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0]?.n;
const time = (value: Date | string) => new Date(value).getTime();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// The same contract the in-memory adapter passes in test/ugs.test.ts, against the real table (on the caller's clock; database time has its own tests below).
budgetContract("PostgresUgsBudget", async (perMin, capacity) => {
  await sql.query("DELETE FROM ugs_budget WHERE name = 'contract'");
  return new PostgresUgsBudget(database(), "contract", perMin, capacity, "caller");
});

describe("shared Cloud Save budget (D-4)", () => {
  it("separate PostgresUgsBudget objects on one row share it: concurrent reservations never exceed the burst", async () => {
    const t = nextNow();
    const budgets = Array.from({ length: 6 }, () => callerBudget());
    const grants = await Promise.all(budgets.map((b) => b.reserve(7, t)));
    expect(grants.reduce((a, b) => a + b, 0)).toBe(10); // capacity = min(33, 10)
    expect((await budgetRow(CLOUD_SAVE_BUDGET)).tokens).toBe(0);
    expect(await budgets[0]!.reserve(1, t + 100)).toBe(0);
    expect(await budgets[3]!.reserve(5, t + 60_000)).toBe(5); // a minute at 33/min refills to the cap of 10; 5 taken
  });

  it("two workers on the shared row write at most the burst in total; the same load on separate buckets writes more (control)", async () => {
    await seedLinked(25);
    const t = nextNow();
    const a = newWorker(callerBudget());
    const b = newWorker(callerBudget());
    const [x, y] = await Promise.all([a.tick(t), b.tick(t)]);
    expect(x.written + y.written).toBe(10);
    expect(writes()).toHaveLength(10);
    expect(await count("ugs_mirror_outbox")).toBe(15);
    const [x2, y2] = await Promise.all([a.tick(t), b.tick(t)]);
    expect(x2.written + y2.written).toBe(0); // still empty at the same instant, on either instance
    const [x3, y3] = await Promise.all([a.tick(t + 60_000), b.tick(t + 60_000)]);
    expect(x3.written + y3.written).toBe(10); // a minute later the bucket is full again, again shared

    // Control: if each instance has its own bucket (the S6 per-process pacing), the same scenario overshoots.
    calls.length = 0;
    await sql.query("DELETE FROM ugs_mirror_outbox");
    await seedLinked(25);
    const t2 = nextNow();
    const c = newWorker(new InMemoryUgsBudget(33, 0));
    const d = newWorker(new InMemoryUgsBudget(33, 0));
    const [m, n] = await Promise.all([c.tick(t2), d.tick(t2)]);
    expect(m.written + n.written).toBe(20);
  });

  it("refunds what it did not use: 3 due rows spend 3 tokens and leave 7 in the shared row", async () => {
    await seedLinked(3);
    const t = nextNow();
    expect((await newWorker(callerBudget()).tick(t)).written).toBe(3);
    expect((await budgetRow(CLOUD_SAVE_BUDGET)).tokens).toBeCloseTo(7, 5);
    expect(await callerBudget().reserve(20, t)).toBe(7);
  });

  it("a 429 seen by one instance pauses the other: no claim, no call, until Retry-After has passed", async () => {
    await seedLinked(3);
    const t = nextNow();
    const a = newWorker(callerBudget());
    const b = newWorker(callerBudget());
    handler = () => json(429, {}, { "retry-after": "60" });
    expect(await a.tick(t)).toMatchObject({ rateLimited: true, written: 0 });
    expect(writes()).toHaveLength(1);
    expect(time((await budgetRow(CLOUD_SAVE_BUDGET)).paused_until)).toBe(t + 60_000);
    handler = () => json(200);
    await seedLinked(1); // a row that IS due while the shared budget is paused
    const blocked = await b.tick(t + 1_000);
    expect(blocked).toMatchObject({ written: 0, backlog: 1 });
    expect(writes()).toHaveLength(1); // B made no UGS call ...
    expect((await sql.query("SELECT 1 FROM ugs_mirror_outbox WHERE claim_id IS NOT NULL")).rowCount).toBe(0); // ... and claimed nothing
    expect((await b.tick(t + 61_000)).written).toBe(4);
  });

  it("refused credentials (401) on one instance pause the other for 15 minutes", async () => {
    await seedLinked(2);
    const t = nextNow();
    const a = newWorker(callerBudget());
    const b = newWorker(callerBudget());
    handler = () => json(401);
    expect(await a.tick(t)).toMatchObject({ credentialsRejected: true });
    handler = () => json(200);
    await seedLinked(1);
    expect(await b.tick(t + 60_000)).toMatchObject({ written: 0, backlog: 1 });
    expect(writes()).toHaveLength(1);
    expect((await b.tick(t + 15 * 60_000 + 1_000)).written).toBe(3);
  });

  it("link proofs draw from their own row: linking does not touch the Cloud Save budget, and the proof row is shared too", async () => {
    const player = await newPlayer();
    expect((await player.link()).status).toBe(201);
    const proofRow = await budgetRow(PLAYER_AUTH_BUDGET);
    expect(proofRow).toBeDefined();
    expect(proofRow.tokens).toBeLessThan(10);
    expect(await budgetRow(CLOUD_SAVE_BUDGET)).toBeUndefined();
    expect(app.get(UGS_BUDGET)).toBeInstanceOf(PostgresUgsBudget);
  });
});

describe("shared budget on database time", () => {
  const dbBudget = (name = "dbtime") => new PostgresUgsBudget(database(), name, 33); // default: database time
  beforeEach(async () => {
    await sql.query("DELETE FROM ugs_budget WHERE name = 'dbtime'");
  });

  it("ignores the caller's clock: a process whose clock is hours ahead mints nothing and freezes no one", async () => {
    const budget = dbBudget();
    expect(await budget.reserve(100, 0)).toBe(10); // the caller's "now" (the epoch) is irrelevant
    expect(await budget.reserve(5, Date.now() + 10 * 3_600_000)).toBe(0); // ten hours ahead: still empty
    const row = await sql.query("SELECT (refilled_at <= now() + interval '5 seconds') AS sane FROM ugs_budget WHERE name = 'dbtime'");
    expect(row.rows[0].sane).toBe(true); // refilled_at is database time, not the caller's
    await sql.query("UPDATE ugs_budget SET refilled_at = now() - interval '30 seconds' WHERE name = 'dbtime'");
    expect(await budget.reserve(100, Date.now() - 10 * 3_600_000)).toBe(10); // 33/min for 30 s refills the burst of 10 (capped)
  });

  it("a stored refill time in the future (written by a forward-jumped clock) is clamped, so refills are not frozen beyond the clamp", async () => {
    const budget = dbBudget();
    expect(await budget.reserve(10, 0)).toBe(10);
    await sql.query("UPDATE ugs_budget SET refilled_at = now() + interval '3 hours' WHERE name = 'dbtime'");
    expect(await budget.reserve(5, 0)).toBe(0); // no time has elapsed from the budget's point of view; the row is clamped back to now
    const clamped = await sql.query("SELECT (refilled_at <= now() + interval '5 seconds') AS sane FROM ugs_budget WHERE name = 'dbtime'");
    expect(clamped.rows[0].sane).toBe(true);
    await sql.query("UPDATE ugs_budget SET refilled_at = now() - interval '1 minute' WHERE name = 'dbtime'");
    expect(await budget.reserve(5, 0)).toBe(5); // and it refills again from there
    // Within the clamp (skew of a minute between writers) the stored time is kept.
    await sql.query("UPDATE ugs_budget SET tokens = 0, refilled_at = now() + interval '1 minute' WHERE name = 'dbtime'");
    expect(await budget.reserve(5, 0)).toBe(0);
  });

  it("pause applies the duration to database time, never shortens, and isPaused reads database time", async () => {
    const budget = dbBudget();
    const wrongNow = Date.now() + 10 * 3_600_000; // this process believes it is ten hours later
    await budget.pause(wrongNow + 60_000, wrongNow);
    const row = await sql.query(
      "SELECT extract(epoch FROM (paused_until - now())) AS secs FROM ugs_budget WHERE name = 'dbtime'",
    );
    expect(Number(row.rows[0].secs)).toBeGreaterThan(55);
    expect(Number(row.rows[0].secs)).toBeLessThanOrEqual(60);
    expect(await budget.isPaused(0)).toBe(true);
    expect(await budget.reserve(5, wrongNow + 3_600_000)).toBe(0); // the caller's clock cannot lift it
    await budget.pause(wrongNow + 1_000, wrongNow); // shorter: ignored
    expect(Number((await sql.query("SELECT extract(epoch FROM (paused_until - now())) AS secs FROM ugs_budget WHERE name = 'dbtime'")).rows[0].secs)).toBeGreaterThan(50);
    await sql.query("UPDATE ugs_budget SET paused_until = now() - interval '1 second' WHERE name = 'dbtime'");
    expect(await budget.isPaused(wrongNow)).toBe(false);
    expect(await budget.reserve(5, 0)).toBe(5); // the row was created full by the pause
  });

  it("database time is the default; only an explicit option (tests) switches to the caller's clock", () => {
    expect((dbBudget() as unknown as { time: string }).time).toBe("database");
    expect((callerBudget() as unknown as { time: string }).time).toBe("caller");
  });
});

describe("idle ticks and reservation size", () => {
  it("an idle tick (nothing due) does not touch ugs_budget at all", async () => {
    const w = newWorker(callerBudget());
    expect((await w.tick(nextNow())).backlog).toBe(0);
    expect(await budgetRow(CLOUD_SAVE_BUDGET)).toBeUndefined();
    await seedLinked(2);
    expect((await w.tick(nextNow())).written).toBe(2);
    const before = await budgetRow(CLOUD_SAVE_BUDGET);
    await w.tick(nextNow()); // idle again: row untouched
    expect(await budgetRow(CLOUD_SAVE_BUDGET)).toEqual(before);
  });
});

describe("minimum interval between copy writes (C3)", () => {
  it("two Rounds inside the interval produce ONE write at the later version, once the interval has passed", async () => {
    const player = await newPlayer();
    expect((await player.link()).status).toBe(201); // version 1
    const t = nextNow();
    expect((await worker.tick(t)).written).toBe(1); // the first write after the link is immediate
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.body.value.version).toBe(1);
    expect(time((await pace(player.principal)).last_mirrored_at)).toBe(t);

    await bankRound(player); // version 2
    await bankRound(player); // version 3, coalesced into the same waiting row
    expect(time((await outbox(player.principal)).due_at)).toBe(t + INTERVAL_MS);
    expect(await worker.tick(t + INTERVAL_MS - 1_000)).toMatchObject({ written: 0, backlog: 0 }); // waiting is not lag
    expect(writes()).toHaveLength(1);
    expect((await worker.tick(t + INTERVAL_MS)).written).toBe(1);
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.body.value.version).toBe(3);
    expect(await outbox(player.principal)).toBeUndefined();
  });

  it("the first write after a link, a re-link to another UGS player, and a link move are immediate, even inside the interval", async () => {
    const player = await newPlayer();
    expect((await player.link()).status).toBe(201);
    const t = nextNow();
    expect((await worker.tick(t)).written).toBe(1);

    const other = `ugs${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    expect((await player.link(other)).status).toBe(200); // replaced: version bump + enqueue
    const row = await outbox(player.principal);
    expect(time(row.due_at)).toBeLessThanOrEqual(Date.now() + 5_000); // due at the real "now", not at t + interval
    expect((await worker.tick(t + 1_000)).written).toBe(1);
    expect(writes().at(-1)?.url).toContain(`/players/${other}/`);
    expect(writes().at(-1)?.body.value.version).toBe(2);
    expect((await pace(player.principal)).ugs_player_id).toBe(other);
  });

  it("a re-link while a row waits makes it due now; a Round on the same link still waits", async () => {
    const player = await newPlayer();
    expect((await player.link()).status).toBe(201);
    const t = nextNow();
    expect((await worker.tick(t)).written).toBe(1);
    await bankRound(player); // inside the interval: waits
    const waiting = time((await outbox(player.principal)).due_at);
    expect(waiting).toBeGreaterThan(Date.now() + INTERVAL_MS - 10_000);
    await bankRound(player); // same link: still waits, same due time (coalesced)
    expect(time((await outbox(player.principal)).due_at)).toBe(waiting);

    const other = `ugs${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    expect((await player.link(other)).status).toBe(200); // re-link while the row waits
    const row = await outbox(player.principal);
    expect(time(row.due_at)).toBeLessThanOrEqual(Date.now() + 5_000); // pulled forward to now
    expect(row).toMatchObject({ attempts: 0, claim_id: null });
    calls.length = 0;
    expect((await worker.tick(nextNow())).written).toBe(1);
    expect(writes()[0]?.url).toContain(`/players/${other}/`);
    expect(writes()[0]?.body.value.version).toBe(4); // two Rounds and the re-link bump
  });

  it("a re-link while the write is in flight: the changed row is due now, not one interval after the old write", async () => {
    const player = await newPlayer();
    expect((await player.link()).status).toBe(201);
    const inflight = deferred();
    const gate = deferred();
    handler = async () => {
      inflight.resolve();
      await gate.promise;
      return json(200);
    };
    const t = nextNow();
    const running = worker.tick(t);
    await inflight.promise;
    const other = `ugs${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    expect((await player.link(other)).status).toBe(200); // moves the link while the old UGS player is being written
    gate.resolve();
    expect((await running).written).toBe(1);
    expect(await pace(player.principal)).toBeUndefined(); // the write went to a UGS player that is no longer the link
    const row = await outbox(player.principal);
    expect(row).toMatchObject({ attempts: 0, claim_id: null, urgent: false });
    expect(time(row.due_at)).toBe(t); // now, not t + interval
    handler = () => json(200);
    calls.length = 0;
    expect((await worker.tick(t + 1_000)).written).toBe(1);
    expect(writes()[0]?.url).toContain(`/players/${other}/`);
    expect((await pace(player.principal)).ugs_player_id).toBe(other);
  });

  it("an urgent (Trip end) enqueue while the row is claimed is persisted and honoured: due now, flag cleared", async () => {
    const player = await newPlayer();
    expect((await player.link()).status).toBe(201);
    const balance = app.get(PlayerBalance);
    const inflight = deferred();
    const gate = deferred();
    handler = async () => {
      inflight.resolve();
      await gate.promise;
      return json(200);
    };
    const t = nextNow();
    const running = worker.tick(t);
    await inflight.promise;
    await balance.update(player.principal, new Date(), async () => ({ value: 0, republish: true, mirrorNow: true }));
    expect(await outbox(player.principal)).toMatchObject({ urgent: true }); // kept: due_at is the lease while claimed
    gate.resolve();
    expect((await running).written).toBe(1);
    const row = await outbox(player.principal);
    expect(row).toMatchObject({ attempts: 0, claim_id: null, urgent: false });
    expect(time(row.due_at)).toBe(t); // not t + interval
    handler = () => json(200);
    expect((await worker.tick(t + 1_000)).written).toBe(1);
    expect(await outbox(player.principal)).toBeUndefined();
  });

  it("a plain (not urgent) change while claimed does not set the flag", async () => {
    const player = await newPlayer();
    expect((await player.link()).status).toBe(201);
    const inflight = deferred();
    const gate = deferred();
    handler = async () => {
      inflight.resolve();
      await gate.promise;
      return json(200);
    };
    const running = worker.tick(nextNow());
    await inflight.promise;
    await bankRound(player);
    expect(await outbox(player.principal)).toMatchObject({ urgent: false });
    gate.resolve();
    await running;
  });

  it("a deletion is not delayed by the interval: its due time is the in-flight-write rule only", async () => {
    const player = await newPlayer();
    expect((await player.link()).status).toBe(201);
    const t = nextNow();
    await worker.tick(t);
    await bankRound(player); // a copy write now waits out the interval
    const before = Date.now();
    expect((await request(server).delete("/v1/me").set(player.auth)).status).toBe(204);
    expect(await outbox(player.principal)).toBeUndefined();
    const due = time((await sql.query("SELECT due_at FROM ugs_mirror_deletions WHERE ugs_player_id = $1", [player.ugsId])).rows[0].due_at);
    expect(due).toBeGreaterThanOrEqual(before + LEASE_MS + REQUEST_TIMEOUT_MS);
    expect(due).toBeLessThan(Date.now() + LEASE_MS + REQUEST_TIMEOUT_MS + 5_000);
    calls.length = 0;
    expect((await worker.tick(due + 1)).deleted).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("a Round that commits while the write is in flight is due one interval after that write, not at once", async () => {
    const player = await newPlayer();
    expect((await player.link()).status).toBe(201);
    const inflight = deferred();
    const gate = deferred();
    handler = async () => {
      inflight.resolve();
      await gate.promise;
      return json(200);
    };
    const t = nextNow();
    const running = worker.tick(t);
    await inflight.promise;
    await bankRound(player); // version 2, while version 1 is being written
    gate.resolve();
    expect((await running).written).toBe(1);
    const row = await outbox(player.principal);
    expect(row).toMatchObject({ attempts: 0, claim_id: null });
    expect(time(row.due_at)).toBe(t + INTERVAL_MS);
    handler = () => json(200);
    expect((await worker.tick(t + INTERVAL_MS - 1_000)).written).toBe(0);
    expect((await worker.tick(t + INTERVAL_MS)).written).toBe(1);
    expect(writes().at(-1)?.body.value.version).toBe(2);
  });

  it("the enqueue SQL is mirrorDueAt(): inside the interval, after it, never written, and the dueNow (Trip end) hook", async () => {
    const player = await newPlayer();
    expect((await player.link()).status).toBe(201);
    const balance = app.get(PlayerBalance);
    const now = new Date();
    const cases: { last: Date | null; dueNow: boolean }[] = [
      { last: null, dueNow: false },
      { last: new Date(now.getTime() - 100_000), dueNow: false },
      { last: new Date(now.getTime() - 400_000), dueNow: false },
      { last: new Date(now.getTime() - 100_000), dueNow: true },
    ];
    for (const { last, dueNow } of cases) {
      await sql.query("DELETE FROM ugs_mirror_outbox");
      await sql.query("DELETE FROM ugs_mirror_pace");
      if (last) {
        await sql.query("INSERT INTO ugs_mirror_pace (player_id, ugs_player_id, last_mirrored_at) VALUES ($1, $2, $3)", [player.principal, player.ugsId, last]);
      }
      await balance.update(player.principal, now, async () => ({ value: 0, republish: true, ...(dueNow ? { mirrorNow: true as const } : {}) }));
      expect(time((await outbox(player.principal)).due_at)).toBe(mirrorDueAt(now, last, INTERVAL_SEC, dueNow).getTime());
    }
  });

  it("dueNow pulls a waiting row forward but leaves a row that is backing off alone", async () => {
    const player = await newPlayer();
    expect((await player.link()).status).toBe(201);
    const balance = app.get(PlayerBalance);
    await sql.query("INSERT INTO ugs_mirror_pace (player_id, ugs_player_id, last_mirrored_at) VALUES ($1, $2, now())", [player.principal, player.ugsId]);
    await sql.query("DELETE FROM ugs_mirror_outbox");
    await balance.update(player.principal, new Date(), async () => ({ value: 0, republish: true }));
    const waiting = time((await outbox(player.principal)).due_at);
    expect(waiting).toBeGreaterThan(Date.now() + INTERVAL_MS - 10_000);
    await balance.update(player.principal, new Date(), async () => ({ value: 0, republish: true })); // coalesces, still waiting
    expect(time((await outbox(player.principal)).due_at)).toBe(waiting);
    const now = new Date();
    await balance.update(player.principal, now, async () => ({ value: 0, republish: true, mirrorNow: true }));
    expect(time((await outbox(player.principal)).due_at)).toBe(now.getTime());

    await sql.query("UPDATE ugs_mirror_outbox SET due_at = now() + interval '1 hour', attempts = 2 WHERE player_id = $1", [player.principal]);
    const backing = time((await outbox(player.principal)).due_at);
    await balance.update(player.principal, new Date(), async () => ({ value: 0, republish: true, mirrorNow: true }));
    expect(time((await outbox(player.principal)).due_at)).toBe(backing);
  });

  it("the pace record goes with the player (account deletion) and a fresh account starts with an immediate first write", async () => {
    const player = await newPlayer();
    expect((await player.link()).status).toBe(201);
    await worker.tick(nextNow());
    expect(await pace(player.principal)).toBeDefined();
    await request(server).delete("/v1/me").set(player.auth);
    expect(await pace(player.principal)).toBeUndefined();
  });
});
