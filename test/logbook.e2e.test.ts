import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { ContentDocumentsService } from "../src/content/documents/content-documents.service.js";
import { insertDocument } from "../src/content/documents/document-store.js";
import { buildAircraftTagsBody, buildFieldAwardsBody } from "../src/content/documents/documents.js";
import { DatabaseService } from "../src/database/database.module.js";
import { MIN_ROUND_MS } from "../src/rounds/rounds.service.js";
import { recordSighting } from "../src/rules/clipper-cards.js";
import type { CardRecord } from "../src/rules/clipper-cards.js";
import { evaluateFieldAwards } from "../src/rules/field-awards.js";
import { deriveDayLog, deriveTripCounters, flightFact, localDateTimeOf } from "../src/rules/trips.js";
import type { CompletedTrip } from "../src/rules/trips.js";
import { catalogInForce } from "../src/trips/catalog-in-force.js";
import { emulatorToken } from "./tokens.js";
import { ensureMilitaryItem, factsFor, newKey, openBody } from "./trip-helpers.js";

// Slice T5: GET /v1/me/logbook. The real Nest app against the real test database. The pure builders have their own unit
// tests (logbook.test.ts); the contract twin (a real response validated against openapi.yaml) is in openapi.e2e.test.ts.

const PREFIX = "firebase:demo-airplane-games:";
const LOGBOOK = "/v1/me/logbook";
const PRIVATE_NO_CACHE = "private, no-cache";

const apps: NestExpressApplication[] = [];
const savedEnv = { ...process.env };
let sql: pg.Pool;
let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;

async function buildApp(env: Record<string, string> = {}, stubSeed = false) {
  Object.assign(process.env, env);
  let builder = Test.createTestingModule({ imports: [AppModule] });
  // A stand-in that never seeds, so a database with no documents stays unseeded (the 503 case).
  if (stubSeed) builder = builder.overrideProvider(ContentDocumentsService).useValue({ onModuleInit() {}, onModuleDestroy() {} });
  const moduleRef = await builder.compile();
  const built = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(built);
  await built.listen(0, "127.0.0.1");
  apps.push(built);
  return { app: built, server: built.getHttpServer() };
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
}

/** Immutability is a trigger; a test that published a document version removes it by switching the trigger off in one transaction. */
async function removeTestVersions() {
  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE content_documents DISABLE TRIGGER content_documents_immutable");
    await client.query("DELETE FROM content_documents WHERE version > 1");
    await client.query("ALTER TABLE content_documents ENABLE TRIGGER content_documents_immutable");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await removeTestVersions();
  ({ app, server } = await buildApp());
});

afterEach(async () => {
  await removeTestVersions();
  restoreEnv();
});

afterAll(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await sql.end();
});

type Player = Awaited<ReturnType<typeof newPlayer>>;

async function newPlayer(options: { statusPoints?: number } = {}, target = server) {
  const uid = `uid-${randomUUID()}`;
  const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
  const created = await request(target).put("/v1/me").set(auth);
  expect(created.status).toBe(201);
  const principal = `${PREFIX}${uid}`;
  if (options.statusPoints) await sql.query("UPDATE players SET status_points = $1 WHERE id = $2", [options.statusPoints, principal]);
  return { uid, auth, principal };
}

const open = (p: Player, module = "atc-match", overrides: Record<string, unknown> = {}) =>
  request(server).post("/v1/trips").set(p.auth).set("Idempotency-Key", newKey()).send(openBody(module, overrides));
const issue = (p: Player, tripId: string) => request(server).post("/v1/rounds").set(p.auth).send({ tripId });
const abandon = (p: Player, tripId: string) => request(server).post(`/v1/trips/${tripId}/abandon`).set(p.auth);
const complete = (p: Player, tripId: string) => request(server).post(`/v1/trips/${tripId}/complete`).set(p.auth);
const result = (p: Player, roundId: string, body: Record<string, unknown> = {}) =>
  request(server)
    .post(`/v1/rounds/${roundId}/result`)
    .set(p.auth)
    .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9, ...factsFor("atc-match"), ...body });

async function backdateRound(roundId: string) {
  await sql.query("UPDATE rounds SET issued_at = issued_at - ($1::int * interval '1 millisecond') WHERE id = $2", [MIN_ROUND_MS * 2, roundId]);
}

async function issueBacked(p: Player, tripId: string) {
  const issued = await issue(p, tripId);
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  const roundId = issued.body.round.roundId as string;
  await backdateRound(roundId);
  return roundId;
}

async function bank(p: Player, tripId: string, body: Record<string, unknown> = {}) {
  const roundId = await issueBacked(p, tripId);
  const res = await result(p, roundId, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { roundId, res };
}

function localClock(hour: number) {
  const now = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let offset = hour * 60 + 30 - utcMinutes;
  if (offset > 840) offset -= 1440;
  if (offset < -720) offset += 1440;
  return { utcOffsetMinutes: offset, localDate: new Date(now.getTime() + offset * 60_000).toISOString().slice(0, 10) };
}

const identifierFacts = (key: string, body: Record<string, unknown> = {}) => ({ ...factsFor("identifier", { aircraftKey: key }), ...body });
const militaryFacts = (itemId: string, body: Record<string, unknown> = {}) =>
  ({ ...factsFor("aircraft-identifier-military", { aircraftKey: itemId }), ...body });
const MISS = { finished: false, errorCount: 1, attempts: 1 };
const tenOf = (body: Record<string, unknown> = {}) => Array.from({ length: 10 }, () => body);

async function play(p: Player, module: string, bodies: Record<string, unknown>[], hour = 12) {
  const opened = await open(p, module, localClock(hour));
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const tripId = opened.body.trip.tripId as string;
  for (const body of bodies) await bank(p, tripId, body);
  return tripId;
}

async function completeOk(p: Player, tripId: string) {
  const res = await complete(p, tripId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** One finished segment, ready to read: ten correct atc-match Rounds, completed. */
async function completedTrip(p: Player, module = "atc-match", bodies: Record<string, unknown>[] = tenOf()) {
  return completeOk(p, await play(p, module, bodies));
}

const getLogbook = (p: Player, inm?: string) => {
  const req = request(server).get(LOGBOOK).set(p.auth);
  return inm === undefined ? req : req.set("If-None-Match", inm);
};

/** 200 with an ETag. */
async function read(p: Player) {
  const res = await getLogbook(p);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { etag: res.headers["etag"] as string, body: res.body.logbook, text: res.text };
}

const row = async <T = Record<string, any>>(query: string, params: unknown[]) => (await sql.query(query, params)).rows[0] as T;
const versions = async (p: Player) =>
  row<{ version: number; logbook_version: number }>("SELECT version, logbook_version FROM players WHERE id = $1", [p.principal]);

// ---------------------------------------------------------------------------------------------------------------------

describe("the route: auth, player, shape", () => {
  it("401 without a token or with junk, under no-store", async () => {
    for (const req of [request(server).get(LOGBOOK), request(server).get(LOGBOOK).set("Authorization", "Bearer junk")]) {
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(String(res.headers["etag"] ?? "")).not.toContain("lb-"); // Express adds a weak tag to any JSON body; none is a Logbook tag
    }
  });

  it("404 player_not_found before PUT /v1/me, under no-store, and it creates nothing", async () => {
    const uid = `uid-${randomUUID()}`;
    const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
    const res = await request(server).get(LOGBOOK).set(auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("player_not_found");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(String(res.headers["etag"] ?? "")).not.toContain("lb-"); // Express adds a weak tag to any JSON body; none is a Logbook tag
    expect((await row("SELECT COUNT(*)::int AS n FROM players WHERE id = $1", [`${PREFIX}${uid}`])).n).toBe(0);
    // An If-None-Match cannot turn the 404 into a 304.
    expect((await request(server).get(LOGBOOK).set(auth).set("If-None-Match", "*")).status).toBe(404);
  });

  it("a new player: 200 with the empty Logbook, 28 locked awards, a strong ETag and private, no-cache", async () => {
    const p = await newPlayer();
    const res = await getLogbook(p);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(PRIVATE_NO_CACHE);
    expect(res.headers["etag"]).toMatch(/^"lb-[0-9a-f]{32}"$/);
    expect(res.headers["x-request-id"]).toBeTruthy();
    const lb = res.body.logbook;
    expect(Object.keys(res.body)).toEqual(["logbook"]);
    expect(lb).toMatchObject({
      version: 1,
      recentTrips: [],
      daily: { lastPlayedDate: null, flightsOnLastPlayedDate: 0, streakDays: 0, bestStreakDays: 0 },
      lifetime: { trips: 0, flights: 0, correct: 0, allCorrectTrips: 0, bestTripStreak: 0, miles: 0 },
      counters: {
        identifierFullTrips: 0, perfectFlightStreak: 0, bestPerfectFlightStreak: 0, hintFreeTripStreak: 0,
        bestHintFreeTripStreak: 0, nightTrips: 0, goArounds: 0, previousTripOutcome: null,
      },
      clipperCards: [],
    });
    expect(lb.fieldAwards).toMatchObject({ catalogVersion: 1, earned: 0, total: 28 });
    expect(lb.fieldAwards.awards).toHaveLength(28);
    for (const a of lb.fieldAwards.awards) expect(a).toMatchObject({ current: 0, earned: false, earnedAt: null });
    expect(lb.fieldAwards.awards[0]).toMatchObject({ id: "first-flight", target: 1 });
  });

  it("a read writes nothing and takes no lock: row versions are untouched, and a held player lock does not block it", async () => {
    const p = await newPlayer();
    await completedTrip(p);
    const snapshot = () =>
      row(
        `SELECT pl.xmin::text AS player_xmin, pl.version, pl.logbook_version, pl.updated_at,
                (SELECT xmin::text FROM player_counters WHERE player_id = pl.id) AS counters_xmin,
                (SELECT COUNT(*)::int FROM ugs_mirror_outbox WHERE player_id = pl.id) AS outbox,
                (SELECT COUNT(*)::int FROM miles_ledger WHERE player_id = pl.id) AS miles_rows,
                (SELECT COUNT(*)::int FROM hint_ledger WHERE player_id = pl.id) AS hint_rows
           FROM players pl WHERE pl.id = $1`,
        [p.principal],
      );
    const before = await snapshot();
    const first = await read(p);
    for (let i = 0; i < 3; i += 1) await getLogbook(p);
    expect((await getLogbook(p, first.etag)).status).toBe(304);
    expect(await snapshot()).toEqual(before);

    const holder = await sql.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM players WHERE id = $1 FOR UPDATE", [p.principal]);
      const started = Date.now();
      const res = await getLogbook(p);
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(3000); // lock_timeout is 5 s: a blocked read would 503, not 200
      expect(res.headers["etag"]).toBe(first.etag);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("503 service_unavailable with Retry-After while the content documents are unseeded (the catalogInForce path); 404 still comes first", async () => {
    const name = "airplane_games_logbook_unseeded_test";
    const url = new URL(process.env.DATABASE_URL as string);
    const admin = new pg.Client({ connectionString: new URL("/postgres", url).toString() });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
    url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    try {
      await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
      const unseeded = await buildApp({ DATABASE_URL: url.toString() }, true);
      const uid = `uid-${randomUUID()}`;
      const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
      expect((await request(unseeded.server).get(LOGBOOK).set(auth)).status).toBe(404);
      expect((await request(unseeded.server).put("/v1/me").set(auth)).status).toBe(201);
      const res = await request(unseeded.server).get(LOGBOOK).set(auth);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("service_unavailable");
      expect(res.headers["retry-after"]).toBe("5");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(String(res.headers["etag"] ?? "")).not.toContain("lb-"); // Express adds a weak tag to any JSON body; none is a Logbook tag
      // An If-None-Match cannot turn it into a 304 either.
      expect((await request(unseeded.server).get(LOGBOOK).set(auth).set("If-None-Match", "*")).status).toBe(503);
      // The failure left the pool healthy: the same app still answers.
      expect((await request(unseeded.server).get("/v1/me/progress").set(auth)).status).toBe(200);
    } finally {
      await Promise.all(apps.splice(1).map((a) => a.close()));
      await pool.end();
      const cleanup = new pg.Client({ connectionString: new URL("/postgres", url).toString() });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    }
  }, 60_000);
});

describe("426 and 429 behave as on every other route", () => {
  it("426 client_update_required runs before the token and is skipped for X-Client: web", async () => {
    const gated = await buildApp({ MIN_CLIENT_BUILD: "20" });
    const uid = `uid-${randomUUID()}`;
    const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
    for (const version of [undefined, "19", "abc"]) {
      let req = request(gated.server).get(LOGBOOK).set(auth);
      if (version !== undefined) req = req.set("X-Client-Version", version);
      const res = await req;
      expect(res.status, String(version)).toBe(426);
      expect(res.body.error.code).toBe("client_update_required");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect((await request(gated.server).get(LOGBOOK).set("X-Client-Version", "1")).status).toBe(426); // before auth
    expect((await request(gated.server).get(LOGBOOK).set("X-Client-Version", "20")).status).toBe(401);
    await request(gated.server).put("/v1/me").set(auth).set("X-Client", "web");
    expect((await request(gated.server).get(LOGBOOK).set(auth).set("X-Client-Version", "20")).status).toBe(200);
    expect((await request(gated.server).get(LOGBOOK).set(auth).set("X-Client", "web")).status).toBe(200);
  });

  it("429 rate_limited with Retry-After after the per-principal limit; a 304 counts too", async () => {
    const limited = await buildApp({ RATE_LIMIT_AUTH_PER_MIN: "4", RATE_LIMIT_PUBLIC_PER_MIN: "1000" });
    const uid = `uid-${randomUUID()}`;
    const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
    expect((await request(limited.server).put("/v1/me").set(auth)).status).toBe(201);
    const first = await request(limited.server).get(LOGBOOK).set(auth);
    expect(first.status).toBe(200);
    expect((await request(limited.server).get(LOGBOOK).set(auth).set("If-None-Match", first.headers["etag"] as string)).status).toBe(304);
    expect((await request(limited.server).get(LOGBOOK).set(auth)).status).toBe(200);
    const over = await request(limited.server).get(LOGBOOK).set(auth).set("If-None-Match", first.headers["etag"] as string);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe("rate_limited");
    expect(over.headers["retry-after"]).toMatch(/^[0-9]+$/);
    expect(over.headers["cache-control"]).toBe("no-store");
  });
});

describe("ETag and 304", () => {
  it("If-None-Match: exact tag, weak tag, a list and * give 304 with the validators and no body; a stale tag gives 200", async () => {
    const p = await newPlayer();
    const { etag } = await read(p);
    for (const header of [etag, `W/${etag}`, `"nope", ${etag}`, "*"]) {
      const res = await getLogbook(p, header);
      expect(res.status, header).toBe(304);
      expect(res.text).toBe("");
      expect(res.headers["etag"]).toBe(etag);
      expect(res.headers["cache-control"]).toBe(PRIVATE_NO_CACHE);
    }
    const stale = await getLogbook(p, '"lb-00000000000000000000000000000000"');
    expect(stale.status).toBe(200);
    expect(stale.headers["etag"]).toBe(etag);
    // A garbage header is just a miss.
    expect((await getLogbook(p, "not an etag")).status).toBe(200);
  });

  it("the same state gives the same bytes and tag, however many reads or seconds apart (nothing in the body depends on the clock)", async () => {
    const p = await newPlayer();
    await play(p, "atc-match", [{}, {}, {}]); // an open segment with banked Rounds
    const a = await read(p);
    await new Promise((done) => setTimeout(done, 1100));
    const b = await read(p);
    expect(b.etag).toBe(a.etag);
    expect(b.text).toBe(a.text);
    // The open segment running out is time passing, not a stored change: neither the body nor the tag move.
    await sql.query("UPDATE trips SET expires_at = now() - interval '31 minutes', opened_at = now() - interval '90 minutes' WHERE player_id = $1 AND status = 'open'", [p.principal]);
    const c = await read(p);
    expect(c.etag).toBe(a.etag);
    expect(c.text).toBe(a.text);
  });

  it("every write that changes the response changes the tag, by exactly one logbook_version; reads and no-op requests change nothing", async () => {
    const p = await newPlayer({ statusPoints: 10_000 }); // certified above Trainee, so the Active Rank can be dialled
    let current = await read(p);
    let v = await versions(p);
    const step = async (what: string, act: () => Promise<unknown>, expected: "same" | "changes") => {
      await act();
      const next = await read(p);
      const nv = await versions(p);
      if (expected === "same") {
        expect(next.etag, `${what}: tag`).toBe(current.etag);
        expect(next.text, `${what}: body`).toBe(current.text);
        expect(nv.logbook_version, `${what}: logbook_version`).toBe(v.logbook_version);
      } else {
        expect(next.etag, `${what}: tag`).not.toBe(current.etag);
        expect(next.body.version, `${what}: Logbook.version`).toBe(current.body.version + 1);
        expect(nv.logbook_version, `${what}: logbook_version`).toBe(v.logbook_version + 1);
      }
      expect(next.body.version).toBe(nv.logbook_version);
      current = next;
      v = nv;
      return nv;
    };

    // Requests that change nothing the Logbook shows.
    await step("PUT /v1/me again", () => request(server).put("/v1/me").set(p.auth), "same");
    await step("GET progress", () => request(server).get("/v1/me/progress").set(p.auth), "same");
    const rankBefore = await versions(p);
    await step("Active Rank change (bumps Progress.version, not the Logbook)", () => request(server).put("/v1/me/active-rank").set(p.auth).send({ rank: "trainee" }), "same");
    expect((await versions(p)).version).toBe(rankBefore.version + 1);
    await step("Active Rank back to Certified", () => request(server).put("/v1/me/active-rank").set(p.auth).send({ rank: "first-officer" }), "same");

    const opened = await open(p, "atc-match");
    expect(opened.status).toBe(201);
    const tripId = opened.body.trip.tripId as string;
    await step("open a segment", async () => undefined, "same");
    const roundId = await issueBacked(p, tripId);
    await step("issue a Round (already done above; read only)", async () => undefined, "same");
    const hintBefore = await versions(p);
    await step("spend the Round's hint (Progress.hints and version move, the Logbook does not)", () => request(server).post(`/v1/rounds/${roundId}/hint`).set(p.auth), "same");
    expect((await versions(p)).version).toBe(hintBefore.version + 1);
    await step("a replayed hint", () => request(server).post(`/v1/rounds/${roundId}/hint`).set(p.auth), "same");

    // A refused result changes nothing either (impossible facts; and a too-fast one is refused unbanked).
    await step("a Round result refused for its facts", () => result(p, roundId, { aircraftKey: "not-allowed-for-atc-match" }), "same");

    // Banking a Round: the daily log moves.
    await step("ASSUMPTION: banking a Round moves the daily log, so it bumps", () => result(p, roundId), "changes");
    expect(current.body.daily).toMatchObject({ flightsOnLastPlayedDate: 1, streakDays: 1, bestStreakDays: 1 });
    await step("the same result replayed", () => result(p, roundId), "same");
    await step("a different Idempotency-Key header on the replay", () => result(p, roundId).set("Idempotency-Key", "other"), "same");

    await step("issue the next Round (abandons nothing banked)", () => issue(p, tripId), "same");
    // Abandoning an unfinished segment: its Rounds were banked (and counted) already; the abandon itself shows nothing.
    await step("ASSUMPTION: abandoning a Trip does not bump (nothing the Logbook shows moves)", () => abandon(p, tripId), "same");
    await step("abandoning it again", () => abandon(p, tripId), "same");

    // A segment that is completed.
    const second = await play(p, "atc-match", tenOf());
    current = await read(p);
    v = await versions(p);
    expect(current.body.lifetime.trips).toBe(0); // ten banked Rounds, not completed yet
    await step("complete on an unknown segment (404)", () => complete(p, "00000000-0000-4000-8000-000000000000"), "same");
    await step("complete a segment", () => complete(p, second), "changes");
    expect(current.body.lifetime.trips).toBe(1);
    expect(current.body.recentTrips.map((t: { tripId: string }) => t.tripId)).toEqual([second]);
    await step("complete replayed", () => complete(p, second), "same");
    await step("complete replayed, concurrently", () => Promise.all([complete(p, second), complete(p, second), complete(p, second)]), "same");
    await step("abandon after completion is refused", () => abandon(p, second), "same");
  });

  it("a completion that pays no hint and resets no streak bumps logbook_version but not players.version (user ruling 2026-10-29)", async () => {
    const p = await newPlayer();
    const tripId = await play(p, "atc-match", tenOf(MISS)); // every Round missed: the streak is 0 throughout
    const before = await versions(p);
    const etagBefore = (await read(p)).etag;
    const done = await completeOk(p, tripId);
    expect(done.hintGrants).toEqual([]);
    expect(done.progress.perfectStreak).toBe(0);
    const after = await versions(p);
    expect(after.version).toBe(before.version); // U2 stands: nothing in Progress moved
    expect(after.logbook_version).toBe(before.logbook_version + 1);
    expect(done.progress.version).toBe(before.version);
    const lb = await read(p);
    expect(lb.etag).not.toBe(etagBefore);
    expect(lb.body.version).toBe(after.logbook_version);
    expect(lb.body.lifetime).toMatchObject({ trips: 1, flights: 10, correct: 0, allCorrectTrips: 0 });
    expect(lb.body.recentTrips[0]).toMatchObject({ tripId, correct: 0 });
  });

  it("a completion with a Trip hint and a streak reset bumps each counter once (one UPDATE, not two)", async () => {
    const p = await newPlayer();
    await sql.query("INSERT INTO player_counters (player_id, trips_completed, updated_at) VALUES ($1, 3, now())", [p.principal]);
    const tripId = await play(p, "atc-match", tenOf());
    const before = await versions(p);
    const done = await completeOk(p, tripId);
    expect(done.hintGrants).toHaveLength(1);
    const after = await versions(p);
    expect(after.version).toBe(before.version + 1);
    expect(after.logbook_version).toBe(before.logbook_version + 1);
  });

  it("a lazy completion inside POST /v1/trips bumps and puts the segment in the Logbook; its replay through complete does not", async () => {
    const p = await newPlayer();
    const full = await play(p, "atc-match", tenOf());
    const before = await read(p);
    expect(before.body.recentTrips).toEqual([]);
    const reopened = await open(p, "atc-match");
    expect(reopened.status).toBe(201);
    const after = await read(p);
    expect(after.etag).not.toBe(before.etag);
    expect(after.body.version).toBe(before.body.version + 1);
    expect(after.body.recentTrips.map((t: { tripId: string }) => t.tripId)).toEqual([full]);
    expect(after.body.lifetime.trips).toBe(1);
    const replay = await complete(p, full);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect((await read(p)).etag).toBe(after.etag);
    // Opening yet another segment abandons the (partial) open one: nothing in the Logbook moves.
    expect((await open(p, "atc-match")).status).toBe(201);
    expect((await read(p)).etag).toBe(after.etag);
  });

  it("concurrent completes bump the counter once", async () => {
    const p = await newPlayer();
    const tripId = await play(p, "atc-match", tenOf());
    const before = await versions(p);
    const burst = await Promise.all(Array.from({ length: 6 }, () => complete(p, tripId)));
    expect(burst.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(burst.filter((r) => r.body.replayed === false)).toHaveLength(1);
    expect((await versions(p)).logbook_version).toBe(before.logbook_version + 1);
  });

  it("two players with the same history, and a deleted-and-recreated account at the same counter, never share a tag", async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    await completedTrip(a);
    await completedTrip(b);
    const ra = await read(a);
    const rb = await read(b);
    expect(ra.body.version).toBe(rb.body.version);
    expect(ra.etag).not.toBe(rb.etag);
    expect((await getLogbook(b, ra.etag)).status).toBe(200); // another player's tag is a miss, not a 304

    const del = await request(server).delete("/v1/me").set(a.auth);
    expect(del.status).toBe(204);
    expect((await getLogbook(a)).status).toBe(404); // the cascade: nothing is left to read
    await new Promise((done) => setTimeout(done, 5));
    expect((await request(server).put("/v1/me").set(a.auth)).status).toBe(201);
    await completedTrip(a);
    const again = await read(a);
    expect(again.body.version).toBe(ra.body.version); // the counter restarted and caught up
    expect(again.etag).not.toBe(ra.etag); // ASSUMPTION: the incarnation (createdAt) is part of the tag
    expect((await getLogbook(a, ra.etag)).status).toBe(200);
  });
});

describe("a catalog publish changes the tag with no player write", () => {
  it("field-awards v2: the tag, fieldAwards.catalogVersion and targets move; logbook_version and players.version do not", async () => {
    const p = await newPlayer();
    await completedTrip(p);
    const before = await read(p);
    const vBefore = await versions(p);
    expect(before.body.fieldAwards.catalogVersion).toBe(1);

    const dbs = app.get(DatabaseService);
    const v2 = buildFieldAwardsBody(2) as { awards: { id: string; target: number }[] };
    v2.awards.find((a) => a.id === "century")!.target = 150;
    await insertDocument(dbs.db, { name: "field-awards", version: 2, body: v2, createdBy: "test", note: "T5 test" });

    const after = await read(p);
    expect(after.etag).not.toBe(before.etag);
    expect((await getLogbook(p, before.etag)).status).toBe(200); // the old tag no longer validates
    expect((await getLogbook(p, after.etag)).status).toBe(304);
    expect(await versions(p)).toEqual(vBefore); // no player write happened
    expect(after.body.version).toBe(before.body.version);
    expect(after.body.fieldAwards.catalogVersion).toBe(2);
    expect(after.body.fieldAwards.awards.find((a: { id: string }) => a.id === "century").target).toBe(150);
    // Everything but the catalog part is identical.
    expect({ ...after.body, fieldAwards: null }).toEqual({ ...before.body, fieldAwards: null });
  });

  it("aircraft-tags v2 moves a tag-derived `current` and the tag; the awards version is unchanged", async () => {
    const p = await newPlayer();
    await completedTrip(p, "identifier", tenOf(identifierFacts("787")));
    const before = await read(p);
    const regional = (lb: any) => lb.fieldAwards.awards.find((a: { id: string }) => a.id === "regional");
    expect(regional(before.body).current).toBe(0);

    const tags = buildAircraftTagsBody(2) as { entries: { cardKey: string; tags: { tag: string; source: string }[] }[] };
    tags.entries.find((e) => e.cardKey === "787")!.tags = [{ tag: "regional-jet", source: "client_sheet" }];
    await insertDocument(app.get(DatabaseService).db, { name: "aircraft-tags", version: 2, body: tags, createdBy: "test" });

    const after = await read(p);
    expect(after.etag).not.toBe(before.etag);
    expect(after.body.fieldAwards.catalogVersion).toBe(1);
    expect(regional(after.body).current).toBe(1);
    expect(after.body.version).toBe(before.body.version);
  });

  it("a newest document that is invalid is not in force: the tag and the body stay as they were", async () => {
    const p = await newPlayer();
    await completedTrip(p);
    const before = await read(p);
    const broken = buildFieldAwardsBody(2) as { awards: { target: number }[] };
    broken.awards[1]!.target = 0;
    await sql.query(
      "INSERT INTO content_documents (name, version, format, body, sha256, byte_size, created_by) VALUES ('field-awards', 2, 'field-awards.v1', $1::jsonb, $2, 10, 'test')",
      [JSON.stringify(broken), "0".repeat(64)],
    );
    const after = await read(p);
    expect(after.etag).toBe(before.etag);
    expect(after.text).toBe(before.text);
  });
});

describe("Field Awards: earned is the stored fact", () => {
  it("earned, then the target raised: earned stays true with current < target; locked ones follow the new target", async () => {
    const p = await newPlayer();
    await completedTrip(p);
    const before = await read(p);
    const first = (lb: any) => lb.fieldAwards.awards.find((a: { id: string }) => a.id === "first-flight");
    expect(first(before.body)).toMatchObject({ earned: true, current: 1, target: 1 });
    const earnedAt = first(before.body).earnedAt as string;
    expect(Date.parse(earnedAt)).not.toBeNaN();

    const v2 = buildFieldAwardsBody(2) as { awards: { id: string; target: number }[] };
    v2.awards.find((a) => a.id === "first-flight")!.target = 5; // staff raised First Solo from 1 to 5
    await insertDocument(app.get(DatabaseService).db, { name: "field-awards", version: 2, body: v2, createdBy: "test" });
    const after = await read(p);
    expect(first(after.body)).toEqual({ id: "first-flight", current: 1, target: 5, earned: true, earnedAt });
    expect(after.body.fieldAwards.earned).toBe(1);
    expect(after.body.fieldAwards.total).toBe(28);
    // Nothing stored changed: the row still says catalog_version 1.
    expect((await row("SELECT catalog_version FROM player_field_awards WHERE player_id = $1 AND award_id = 'first-flight'", [p.principal])).catalog_version).toBe(1);
  });

  it("ASSUMPTION: a lowered target reads unearned (current = target) until the next completion stores it", async () => {
    const p = await newPlayer();
    await completedTrip(p);
    const ff = (lb: any) => lb.fieldAwards.awards.find((a: { id: string }) => a.id === "frequent-flyer");
    expect(ff((await read(p)).body)).toMatchObject({ earned: false, current: 1, target: 25 });

    const v2 = buildFieldAwardsBody(2) as { awards: { id: string; target: number }[] };
    v2.awards.find((a) => a.id === "frequent-flyer")!.target = 1;
    await insertDocument(app.get(DatabaseService).db, { name: "field-awards", version: 2, body: v2, createdBy: "test" });
    const lowered = await read(p);
    expect(ff(lowered.body)).toEqual({ id: "frequent-flyer", current: 1, target: 1, earned: false, earnedAt: null }); // reached, not stored
    expect(lowered.body.fieldAwards.earned).toBe(1);

    const done = await completedTrip(p); // the next completion judges against v2 and stores it
    expect(done.fieldAwards.map((a: { id: string }) => a.id)).toContain("frequent-flyer");
    const stored = await read(p);
    expect(ff(stored.body)).toMatchObject({ earned: true, target: 1 });
    expect(stored.body.fieldAwards.earned).toBe(2);
  });
});

describe("Clipper Cards", () => {
  it("lists every stored Card with a safe fallback: a key no document names still appears, oldest first", async () => {
    const p = await newPlayer();
    await completedTrip(p, "identifier", tenOf(identifierFacts("787")));
    // A Card whose key is in no clipper-cards document (a retired Military item's answer, or a family added later).
    const orphan = "mil:retired thing that no document names";
    await sql.query(
      `INSERT INTO player_clipper_cards (player_id, card_key, module, first_collected_at, first_trip_id, times_identified, ever_perfect, ever_hint_free, fastest_correct_ms)
       VALUES ($1, $2, 'aircraft-identifier-military', now() + interval '1 hour', $3, 2, true, false, 900)`,
      [p.principal, orphan, randomUUID()],
    );
    const lb = (await read(p)).body;
    expect(lb.clipperCards.map((c: { key: string }) => c.key)).toEqual(["787", orphan]);
    expect(lb.clipperCards[1]).toEqual({
      key: orphan, module: "aircraft-identifier-military", firstCollectedAt: expect.any(String), timesIdentified: 2, everPerfect: true,
    });
    expect(lb.clipperCards[0]).toMatchObject({ key: "787", module: "identifier", timesIdentified: 10, everPerfect: true });
    // The unknown key carries no tags and breaks no award.
    expect(lb.fieldAwards.awards).toHaveLength(28);
    expect(lb.fieldAwards.awards.find((a: { id: string }) => a.id === "first-card")).toMatchObject({ earned: true, current: 1 }); // capped at the target of 1
  });

  it("ASSUMPTION: Cards come from the player's stored rows alone: no clipper-cards document is needed or consulted", async () => {
    const p = await newPlayer();
    await completedTrip(p, "identifier", tenOf(identifierFacts("A320")));
    const lb = (await read(p)).body;
    expect(lb.clipperCards).toEqual([
      { key: "A320", module: "identifier", firstCollectedAt: expect.any(String), timesIdentified: 10, everPerfect: true },
    ]);
    expect(Object.keys(lb.clipperCards[0]).sort()).toEqual(["everPerfect", "firstCollectedAt", "key", "module", "timesIdentified"]);
  });
});

describe("bounds", () => {
  it("lists at most 20 recent Trips, newest first, while the lifetime totals count them all", async () => {
    const p = await newPlayer();
    const base = Date.now() - 100 * 86_400_000;
    await sql.query(
      `INSERT INTO player_counters (player_id, trips_completed, flights_completed, correct_flights, all_correct_trips, miles_earned, best_trip_streak, updated_at)
       VALUES ($1, 25, 250, 250, 25, 25000, 10, now())`,
      [p.principal],
    );
    // Synthetic completed segments (the shape the completion writes), 25 of them, one per day.
    for (let i = 0; i < 25; i += 1) {
      const at = new Date(base + i * 86_400_000).toISOString();
      await sql.query(
        `INSERT INTO trips (id, player_id, idempotency_key, module, rank, pleasure_cruise, status, flight_count, rounds_banked, local_date,
                            utc_offset_minutes, content_version, opened_at, expires_at, closed_at, outcome, correct, hint_used, best_streak, miles,
                            status_points, go_around, night_trip, completion_local_date, catalog_version)
         VALUES ($1, $2, $3, 'atc-match', 'trainee', false, 'completed', 10, 10, $4::date, 0, 'synthetic', $5::timestamptz - interval '10 minutes',
                 $5::timestamptz, $5::timestamptz, 'all_correct', 10, false, 10, 1000, 100, false, false, $4::date, 1)`,
        [randomUUID(), p.principal, `synthetic-${i}`, at.slice(0, 10), at],
      );
    }
    const lb = (await read(p)).body;
    expect(lb.recentTrips).toHaveLength(20);
    const times = lb.recentTrips.map((t: { completedAt: string }) => Date.parse(t.completedAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(new Date(times[0]).toISOString().slice(0, 10)).toBe(new Date(base + 24 * 86_400_000).toISOString().slice(0, 10));
    expect(lb.lifetime.trips).toBe(25);
    expect(lb.fieldAwards.awards).toHaveLength(28);
    expect(Buffer.byteLength(JSON.stringify(lb))).toBeLessThan(20_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("a seeded history, re-derived from the stored segments, Rounds and Cards", () => {
  it("the Logbook equals what the pure rules fold out of trips + rounds + cards", async () => {
    const p = await newPlayer();
    for (const [id, answer] of Object.entries({ "mil-a80": "Eurofighter Typhoon", "mil-a81": "Lockheed Martin F-16" })) {
      await sql.query("DELETE FROM content_items WHERE module = 'aircraft-identifier-military' AND id = $1", [id]);
      await ensureMilitaryItem(sql, id, answer);
    }
    const tripIds: string[] = [];
    const run = async (module: string, bodies: Record<string, unknown>[], hour = 12) => tripIds.push((await completeOk(p, await play(p, module, bodies, hour))).trip.tripId);
    await run(
      "identifier",
      [
        ...[0, 1, 2, 3].map(() => identifierFacts("787")),
        identifierFacts("A320", { usedHint: true }),
        identifierFacts("A320"),
        identifierFacts("747", { finished: false, errorCount: 2, attempts: 3 }),
        ...Array(3).fill(identifierFacts("747")),
      ],
      23,
    );
    await run("aircraft-identifier-military", Array.from({ length: 10 }, (_, i) => militaryFacts(i % 2 === 0 ? "mil-a80" : "mil-a81", { answerMs: 1200 })), 3);
    await play(p, "identifier", [identifierFacts("A320"), identifierFacts("707")]); // abandoned by the next open
    await run("atc-match", tenOf({ usedHint: true }));
    await run("identifier", tenOf(identifierFacts("787")));
    await play(p, "atc-match", [{}, {}]); // an open segment with two banked Rounds: counted in the daily log only

    const got = await read(p);

    // --- re-derivation from the stored rows, with the pure rules ---------------------------------------------------
    const dbs = app.get(DatabaseService);
    const catalog = await catalogInForce(dbs.db);
    const tripRows = (
      await sql.query("SELECT *, to_char(completion_local_date, 'YYYY-MM-DD') AS completion_day FROM trips WHERE player_id = $1 AND status = 'completed' ORDER BY closed_at", [p.principal])
    ).rows;
    expect(tripRows).toHaveLength(4);
    const roundDays = (
      await sql.query("SELECT to_char(local_date, 'YYYY-MM-DD') AS day FROM rounds WHERE player_id = $1 AND status = 'completed' ORDER BY completed_at, id", [p.principal])
    ).rows.map((r) => r.day as string);
    const history: CompletedTrip[] = [];
    const cards = new Map<string, CardRecord>();
    const firstSeen = new Map<string, { at: number; key: string }>();
    for (const t of tripRows) {
      const rs = (await sql.query("SELECT * FROM rounds WHERE trip_id = $1 AND status = 'completed' ORDER BY flight_number", [t.id])).rows;
      const flights = rs.map((r) => flightFact({ finished: r.finished, errorCount: r.error_count, usedHint: r.used_hint }));
      history.push({
        module: t.module,
        flights,
        miles: rs.reduce((n, r) => n + r.miles_awarded, 0),
        completedLocal: localDateTimeOf(rs[rs.length - 1].completed_at, t.utc_offset_minutes),
      });
      rs.forEach((r, i) => {
        if (!r.finished || !r.card_key) return;
        const seen = recordSighting(cards.get(r.card_key) ?? null, r.card_key, t.module, { perfect: flights[i]!.perfect, hintUsed: flights[i]!.hintUsed, answerMs: r.answer_ms });
        if (seen.collected) firstSeen.set(r.card_key, { at: t.closed_at.getTime(), key: r.card_key });
        cards.set(r.card_key, seen.card);
      });
    }
    const derived = deriveTripCounters(history, deriveDayLog(roundDays));

    expect(got.body.counters).toEqual({
      identifierFullTrips: derived.identifierFullTrips,
      perfectFlightStreak: derived.perfectFlightStreak,
      bestPerfectFlightStreak: derived.bestPerfectFlightStreak,
      hintFreeTripStreak: derived.hintFreeTripStreak,
      bestHintFreeTripStreak: derived.bestHintFreeTripStreak,
      nightTrips: derived.nightTrips,
      goArounds: derived.goArounds,
      previousTripOutcome: derived.previousTripOutcome,
    });
    expect(got.body.daily).toEqual({
      lastPlayedDate: derived.lastPlayedDate,
      flightsOnLastPlayedDate: derived.flightsOnLastPlayedDate,
      streakDays: derived.dayStreak,
      bestStreakDays: derived.bestDayStreak,
    });
    expect(got.body.lifetime).toEqual({
      trips: derived.tripsCompleted,
      flights: derived.flightsCompleted,
      correct: derived.correctFlights,
      allCorrectTrips: derived.allCorrectTrips,
      bestTripStreak: derived.bestTripStreak,
      miles: derived.milesEarned,
    });
    // ... and an independent SQL aggregate agrees with the totals.
    const agg = await row(
      `SELECT COUNT(*)::int AS trips, COALESCE(SUM(correct), 0)::int AS correct, COALESCE(SUM(miles), 0)::int AS miles,
              COUNT(*) FILTER (WHERE outcome = 'all_correct')::int AS perfect, COALESCE(MAX(best_streak), 0)::int AS best,
              (SELECT COUNT(*)::int FROM rounds r JOIN trips t2 ON t2.id = r.trip_id WHERE t2.player_id = $1 AND t2.status = 'completed' AND r.status = 'completed') AS flights
         FROM trips WHERE player_id = $1 AND status = 'completed'`,
      [p.principal],
    );
    expect(got.body.lifetime).toEqual({ trips: agg.trips, flights: agg.flights, correct: agg.correct, allCorrectTrips: agg.perfect, bestTripStreak: agg.best, miles: agg.miles });

    expect(got.body.recentTrips).toEqual(
      [...tripRows].reverse().map((t) => ({
        tripId: t.id, module: t.module, localDate: t.completion_day, flights: 10, correct: t.correct, miles: t.miles, statusPoints: t.status_points, completedAt: t.closed_at.toISOString(),
      })),
    );
    expect(got.body.recentTrips.map((t: { tripId: string }) => t.tripId)).toEqual([...tripIds].reverse());

    const expectedCards = [...cards.values()]
      .sort((a, b) => firstSeen.get(a.key)!.at - firstSeen.get(b.key)!.at || (a.key < b.key ? -1 : 1))
      .map((c) => c.key);
    expect(got.body.clipperCards.map((c: { key: string }) => c.key)).toEqual(expectedCards);
    for (const c of got.body.clipperCards as { key: string; module: string; timesIdentified: number; everPerfect: boolean }[]) {
      const d = cards.get(c.key)!;
      expect(c).toMatchObject({ module: d.module, timesIdentified: d.timesIdentified, everPerfect: d.everPerfect });
    }

    const evaluation = evaluateFieldAwards(catalog.awards, { counters: derived, cards: [...cards.values()], tags: catalog.tags });
    const stored = new Map((await sql.query("SELECT award_id, earned_at FROM player_field_awards WHERE player_id = $1", [p.principal])).rows.map((r) => [r.award_id as string, r.earned_at as Date]));
    expect(got.body.fieldAwards.awards).toEqual(
      evaluation.awards.map((a) => ({ id: a.id, current: a.current, target: a.target, earned: stored.has(a.id), earnedAt: stored.get(a.id)?.toISOString() ?? null })),
    );
    expect(got.body.fieldAwards.awards.filter((a: { earned: boolean }) => a.earned).map((a: { id: string }) => a.id)).toEqual(
      evaluation.awards.filter((a) => a.earned).map((a) => a.id), // reached = stored, as no catalog changed
    );
    expect(got.body.fieldAwards.earned).toBe(stored.size);
    expect(got.body.fieldAwards.awards.map((a: { id: string }) => a.id)).toEqual(catalog.awards.map((a) => a.id));
    expect(stored.size).toBeGreaterThanOrEqual(3);

    // The Logbook version equals the number of writes that moved it: one per banked Round (all 42 of them, abandoned and open
    // segments included) and one per completion.
    const bankedRounds = (await row("SELECT COUNT(*)::int AS n FROM rounds WHERE player_id = $1 AND status = 'completed'", [p.principal])).n;
    expect(bankedRounds).toBe(4 * 10 + 2 + 2);
    expect(got.body.version).toBe(1 + bankedRounds + 4);
    expect((await versions(p)).logbook_version).toBe(got.body.version);
  });
});

describe("consistent snapshot", () => {
  it("under concurrent completions every response is one coherent state, and one tag always names one body", async () => {
    const p = await newPlayer();
    const trips: string[] = [];
    for (let i = 0; i < 3; i += 1) trips.push(await play(p, "atc-match", tenOf()));
    const seen = new Map<string, string>();
    const incoherent: string[] = [];
    // One read, checked for coherence. Deterministic: a read before the first completion, every completion gated on a fresh read and
    // overlapped with reads until it returns, and reads after the last one until the final state (3 Trips) is seen.
    const check = async () => {
      const res = await getLogbook(p);
      if (res.status !== 200) {
        incoherent.push(`status ${res.status}`);
        return undefined;
      }
      const lb = res.body.logbook;
      const etag = res.headers["etag"] as string;
      const prior = seen.get(etag);
      if (prior !== undefined && prior !== res.text) incoherent.push(`tag ${etag} named two bodies`);
      seen.set(etag, res.text);
      const first = lb.fieldAwards.awards.find((a: { id: string }) => a.id === "first-flight");
      if (lb.recentTrips.length !== lb.lifetime.trips) incoherent.push(`trips ${lb.recentTrips.length} vs lifetime ${lb.lifetime.trips}`);
      if (first.earned !== lb.lifetime.trips >= 1) incoherent.push("first-flight earned out of step with lifetime.trips");
      if (lb.lifetime.flights !== lb.lifetime.trips * 10) incoherent.push("flights out of step with trips");
      return lb;
    };
    await check();
    for (const tripId of trips) {
      await check();
      let finished = false;
      const completing = completeOk(p, tripId).then(() => {
        finished = true;
      });
      while (!finished) await check();
      await completing;
    }
    let last: any;
    for (let i = 0; i < 50 && last?.lifetime.trips !== 3; i += 1) last = await check();
    expect(last?.lifetime.trips).toBe(3);
    expect(incoherent).toEqual([]);
    expect(seen.size).toBeGreaterThanOrEqual(2);
    expect((await read(p)).body.lifetime.trips).toBe(3);
  });
});

describe("schema", () => {
  it("players.logbook_version is integer NOT NULL default 1 with a >= 1 CHECK (migration 0012), and a new player starts at 1", async () => {
    const col = await row(
      "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'players' AND column_name = 'logbook_version'",
      [],
    );
    expect(col).toEqual({ data_type: "integer", is_nullable: "NO", column_default: "1" });
    const p = await newPlayer();
    expect((await versions(p)).logbook_version).toBe(1);
    await expect(sql.query("UPDATE players SET logbook_version = 0 WHERE id = $1", [p.principal])).rejects.toMatchObject({ constraint: "players_logbook_version_check" });
  });
});
