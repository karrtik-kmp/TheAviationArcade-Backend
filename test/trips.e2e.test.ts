import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { MIN_ROUND_MS } from "../src/rounds/rounds.service.js";
import { addDays } from "../src/rules/trips.js";
import { emulatorToken } from "./tokens.js";
import { ensureMilitaryItem, factsFor, newKey, openBody, utcToday } from "./trip-helpers.js";

// Slice T2: Flight Segments (Unity Trips) and the Round routes that run inside them. The real Nest app against the real
// test database. Pure rules have their own tests (trip-segments.test.ts); the contract twin is openapi.e2e.test.ts.

const PREFIX = "firebase:demo-airplane-games:";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ["error"], bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});

afterAll(async () => {
  await sql.end();
  await app.close();
});

type Player = Awaited<ReturnType<typeof newPlayer>>;

async function newPlayer(options: { statusPoints?: number } = {}) {
  const uid = `uid-${randomUUID()}`;
  const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
  const created = await request(server).put("/v1/me").set(auth);
  expect(created.status).toBe(201);
  const principal = `${PREFIX}${uid}`;
  if (options.statusPoints) await sql.query("UPDATE players SET status_points = $1 WHERE id = $2", [options.statusPoints, principal]);
  return { uid, auth, principal };
}

const open = (p: Player, module = "atc-match", key: string = newKey(), overrides: Record<string, unknown> = {}) =>
  request(server).post("/v1/trips").set(p.auth).set("Idempotency-Key", key).send(openBody(module, overrides));
const issue = (p: Player, tripId: string) => request(server).post("/v1/rounds").set(p.auth).send({ tripId });
const abandon = (p: Player, tripId: string) => request(server).post(`/v1/trips/${tripId}/abandon`).set(p.auth);
const progress = async (p: Player) => (await request(server).get("/v1/me/progress").set(p.auth)).body.progress;
const result = (p: Player, roundId: string, body: Record<string, unknown> = {}) =>
  request(server)
    .post(`/v1/rounds/${roundId}/result`)
    .set(p.auth)
    .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9, ...factsFor("atc-match"), ...body });

async function backdateRound(roundId: string) {
  await sql.query("UPDATE rounds SET issued_at = issued_at - ($1::int * interval '1 millisecond') WHERE id = $2", [MIN_ROUND_MS * 2, roundId]);
}

/** Issue and bank one Round in `tripId`. */
async function bank(p: Player, tripId: string, body: Record<string, unknown> = {}) {
  const issued = await issue(p, tripId);
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  const roundId = issued.body.round.roundId as string;
  await backdateRound(roundId);
  const res = await result(p, roundId, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { roundId, res };
}

async function openTrip(p: Player, module = "atc-match") {
  const res = await open(p, module);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.trip.tripId as string;
}

const row = async <T = Record<string, any>>(query: string, params: unknown[]) => (await sql.query(query, params)).rows[0] as T;
const count = async (query: string, params: unknown[]) => Number((await row<{ n: string }>(query, params)).n);
const tripRow = (tripId: string) => row("SELECT * FROM trips WHERE id = $1", [tripId]);
const versionOf = async (p: Player) => (await row("SELECT version FROM players WHERE id = $1", [p.principal])).version as number;
const openTrips = (p: Player) => count("SELECT COUNT(*) AS n FROM trips WHERE player_id = $1 AND status = 'open'", [p.principal]);
const openRounds = (p: Player) => count("SELECT COUNT(*) AS n FROM rounds WHERE player_id = $1 AND status = 'open'", [p.principal]);

/** Ledger invariants after a test: balances equal their ledgers. */
async function expectLedgersBalanced(p: Player) {
  const r = await row(
    `SELECT pl.miles, pl.hints,
            (SELECT COALESCE(SUM(delta), 0)::int FROM miles_ledger WHERE player_id = pl.id) AS miles_sum,
            (SELECT COALESCE(SUM(delta), 0)::int FROM hint_ledger WHERE player_id = pl.id) AS hints_sum
       FROM players pl WHERE pl.id = $1`,
    [p.principal],
  );
  expect(r.miles).toBe(r.miles_sum);
  expect(r.hints).toBe(r.hints_sum);
}

describe("open a Flight Segment", () => {
  it("opens at the Active Rank with a Pleasure Cruise snapshot, a 30 minute expiry and a zero streak", async () => {
    const p = await newPlayer({ statusPoints: 60_000 }); // Captain
    await request(server).put("/v1/me/active-rank").set(p.auth).send({ rank: "trainee" });
    const res = await open(p, "identifier");
    expect(res.status).toBe(201);
    const { trip, progress: view } = res.body;
    expect(trip).toMatchObject({
      module: "identifier",
      rank: "trainee",
      pleasureCruise: true,
      status: "open",
      flightCount: 10,
      roundsBanked: 0,
      currentRoundId: null,
      perfectStreak: 0,
      localDate: utcToday(),
      utcOffsetMinutes: 0,
      contentVersion: "test-pack-1",
      closedAt: null,
    });
    expect(new Date(trip.expiresAt).getTime() - new Date(trip.openedAt).getTime()).toBe(30 * 60_000);
    expect(view).toMatchObject({ certifiedRank: "captain", activeRank: "trainee", perfectStreak: 0 });
    const stored = await tripRow(trip.tripId);
    expect(stored).toMatchObject({ player_id: p.principal, module: "identifier", rank: "trainee", pleasure_cruise: true, status: "open" });
  });

  it("ASSUMPTION A8: the rank is fixed at open even if Active Rank changes mid-segment", async () => {
    const p = await newPlayer({ statusPoints: 60_000 });
    const tripId = await openTrip(p);
    expect((await tripRow(tripId)).rank).toBe("captain");
    await request(server).put("/v1/me/active-rank").set(p.auth).send({ rank: "trainee" });
    const issued = await issue(p, tripId);
    expect(issued.body.round).toMatchObject({ rank: "captain", pleasureCruise: false, module: "atc-match", tripId, flightNumber: 1 });
  });

  it("needs an Idempotency-Key of 1-128 of A-Za-z0-9_- (U14) and a strict body", async () => {
    const p = await newPlayer();
    for (const key of [undefined, "", "has space", "bad/key", "a".repeat(129)]) {
      const req = request(server).post("/v1/trips").set(p.auth);
      if (key !== undefined) req.set("Idempotency-Key", key);
      const res = await req.send(openBody());
      expect(res.status, String(key)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    for (const bad of [
      { module: "bogus" },
      { flightCount: 9 },
      { flightCount: "10" },
      { localDate: "29/10/2026" },
      { localDate: "2026-02-30" },
      { utcOffsetMinutes: 841 },
      { utcOffsetMinutes: -721 },
      { utcOffsetMinutes: 5.5 },
      { contentVersion: "" },
      { contentVersion: "x".repeat(65) },
      { contentVersion: "has space" },
      { rank: "captain" },
    ]) {
      const res = await open(p, "atc-match", newKey(), bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await count("SELECT COUNT(*) AS n FROM trips WHERE player_id = $1", [p.principal])).toBe(0);
    expect((await open(p, "atc-match", "a".repeat(128))).status).toBe(201);
  });

  it("an unregistered player is 404 player_not_found", async () => {
    const auth = { Authorization: `Bearer ${emulatorToken(`uid-${randomUUID()}`)}` };
    const res = await request(server).post("/v1/trips").set(auth).set("Idempotency-Key", newKey()).send(openBody());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("player_not_found");
  });

  it("U12: a localDate more than 15 minutes off server time plus the offset is 422 local_date_mismatch and writes nothing", async () => {
    const p = await newPlayer();
    const first = await openTrip(p);
    const before = await versionOf(p);
    for (const localDate of [utcToday(-2 * 24 * 60), utcToday(2 * 24 * 60)]) {
      const res = await open(p, "atc-match", newKey(), { localDate });
      expect(res.status, localDate).toBe(422);
      expect(res.body.error.code).toBe("local_date_mismatch");
    }
    // The failed attempts neither abandoned the open segment nor stored a row.
    expect((await tripRow(first)).status).toBe("open");
    expect(await count("SELECT COUNT(*) AS n FROM trips WHERE player_id = $1", [p.principal])).toBe(1);
    expect(await versionOf(p)).toBe(before);
  });

  it("U12: the offset moves the expected date (UTC+14 and UTC-12 are accepted for their own date)", async () => {
    const p = await newPlayer();
    const ahead = await open(p, "atc-match", newKey(), { utcOffsetMinutes: 840, localDate: utcToday(840) });
    expect(ahead.status, JSON.stringify(ahead.body)).toBe(201);
    const behind = await open(p, "atc-match", newKey(), { utcOffsetMinutes: -720, localDate: utcToday(-720) });
    expect(behind.status, JSON.stringify(behind.body)).toBe(201);
    expect(behind.body.trip.utcOffsetMinutes).toBe(-720);
  });
});

describe("U14: Idempotency-Key replay", () => {
  it("the same key answers 200 with the segment it opened and opens nothing", async () => {
    const p = await newPlayer();
    const key = newKey();
    const first = await open(p, "identifier", key);
    expect(first.status).toBe(201);
    const again = await open(p, "identifier", key);
    expect(again.status).toBe(200);
    expect(again.body.trip).toEqual(first.body.trip);
    expect(await count("SELECT COUNT(*) AS n FROM trips WHERE player_id = $1", [p.principal])).toBe(1);
  });

  it("a retry after a newer segment replaced the first does not reopen or abandon anything", async () => {
    const p = await newPlayer();
    const keyA = newKey();
    const a = await open(p, "atc-match", keyA);
    const b = await open(p, "identifier");
    expect(b.status).toBe(201);
    const retryA = await open(p, "atc-match", keyA);
    expect(retryA.status).toBe(200);
    expect(retryA.body.trip.tripId).toBe(a.body.trip.tripId);
    expect(retryA.body.trip.status).toBe("abandoned");
    expect((await tripRow(b.body.trip.tripId)).status).toBe("open");
    expect(await openTrips(p)).toBe(1);
  });

  it("a replay is answered even when its localDate has aged out", async () => {
    const p = await newPlayer();
    const key = newKey();
    const first = await open(p, "atc-match", key);
    await sql.query("UPDATE trips SET local_date = '2020-01-01' WHERE id = $1", [first.body.trip.tripId]);
    const again = await open(p, "atc-match", key, { localDate: "2020-01-01" });
    expect(again.status).toBe(200);
    expect(again.body.trip.tripId).toBe(first.body.trip.tripId);
  });

  it("six concurrent requests with one key open exactly one segment", async () => {
    const p = await newPlayer();
    const key = newKey();
    const replies = await Promise.all(Array.from({ length: 6 }, () => open(p, "atc-match", key)));
    expect(replies.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(replies.map((r) => r.body.trip.tripId)).size).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM trips WHERE player_id = $1", [p.principal])).toBe(1);
  });

  it("two players may use the same key", async () => {
    const [a, b] = [await newPlayer(), await newPlayer()];
    const key = newKey();
    const ra = await open(a, "atc-match", key);
    const rb = await open(b, "atc-match", key);
    expect([ra.status, rb.status]).toEqual([201, 201]);
    expect(ra.body.trip.tripId).not.toBe(rb.body.trip.tripId);
  });

  it("the database refuses a second segment with one key for one player", async () => {
    const p = await newPlayer();
    const key = newKey();
    await open(p, "atc-match", key);
    await expect(
      sql.query(
        `INSERT INTO trips (id, player_id, idempotency_key, module, rank, pleasure_cruise, status, local_date, utc_offset_minutes,
                            content_version, opened_at, expires_at, closed_at)
         VALUES ($1, $2, $3, 'atc-match', 'trainee', false, 'abandoned', '2026-10-29', 0, 'x', now(), now() + interval '1 minute', now())`,
        [randomUUID(), p.principal, key],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "trips_idempotency" });
  });
});

describe("one open segment per player: supersede", () => {
  it("opening a newer segment abandons the open one and its open Round", async () => {
    const p = await newPlayer();
    const a = await openTrip(p);
    const round = (await issue(p, a)).body.round.roundId as string;
    const b = await open(p, "identifier");
    expect(b.status).toBe(201);
    expect(await openTrips(p)).toBe(1);
    const old = await tripRow(a);
    expect(old.status).toBe("abandoned");
    expect(old.closed_at).not.toBeNull();
    expect(await openRounds(p)).toBe(0);

    await backdateRound(round);
    const stale = await result(p, round);
    expect(stale.status).toBe(410);
    expect(stale.body.error.code).toBe("round_closed");
    const gone = await issue(p, a);
    expect(gone.status).toBe(410);
    expect(gone.body.error.code).toBe("trip_closed");
    expect((await issue(p, b.body.trip.tripId)).status).toBe(201);
  });

  it("two concurrent opens (different keys) leave exactly one open segment", async () => {
    const p = await newPlayer();
    const replies = await Promise.all(Array.from({ length: 5 }, () => open(p, "atc-match")));
    expect(replies.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(await openTrips(p)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM trips WHERE player_id = $1", [p.principal])).toBe(5);
    expect(await count("SELECT COUNT(*) AS n FROM trips WHERE player_id = $1 AND status = 'abandoned'", [p.principal])).toBe(4);
  });

  it("the database refuses a second open segment", async () => {
    const p = await newPlayer();
    await openTrip(p);
    await expect(
      sql.query(
        `INSERT INTO trips (id, player_id, idempotency_key, module, rank, pleasure_cruise, local_date, utc_offset_minutes,
                            content_version, opened_at, expires_at)
         VALUES ($1, $2, $3, 'atc-match', 'trainee', false, '2026-10-29', 0, 'x', now(), now() + interval '1 minute')`,
        [randomUUID(), p.principal, newKey()],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "trips_one_open_per_player" });
  });

  it("a stray open Round without a segment (pre-T2 dev row) is abandoned by an open and can no longer be banked", async () => {
    const p = await newPlayer();
    const legacy = randomUUID();
    await sql.query(
      `INSERT INTO rounds (id, player_id, module, rank, pleasure_cruise, status, issued_at, expires_at)
       VALUES ($1, $2, 'atc-match', 'trainee', false, 'open', now() - interval '1 minute', now() + interval '10 minutes')`,
      [legacy, p.principal],
    );
    const banked = await result(p, legacy);
    expect(banked.status).toBe(410);
    expect(banked.body.error.code).toBe("round_closed");
    await openTrip(p);
    expect(await openRounds(p)).toBe(0);
  });
});

describe("abandon", () => {
  it("abandons the segment and its open Round, resets the streak, and replays as 200", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    await bank(p, tripId);
    expect((await progress(p)).perfectStreak).toBe(1);
    const round = (await issue(p, tripId)).body.round.roundId as string;
    const before = await versionOf(p);

    const res = await abandon(p, tripId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ replayed: false, trip: { tripId, status: "abandoned", perfectStreak: 0, roundsBanked: 1 } });
    expect(res.body.trip.closedAt).not.toBeNull();
    expect(res.body.progress.perfectStreak).toBe(0);
    expect(await versionOf(p)).toBe(before + 1); // the visible streak changed
    expect(await openRounds(p)).toBe(0);
    expect((await result(p, round)).body.error.code).toBe("round_closed");

    const again = await abandon(p, tripId);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(await versionOf(p)).toBe(before + 1);
    // Rounds already banked keep their Miles and Status Points.
    expect((await progress(p)).statusPoints).toBe(70);
    await expectLedgersBalanced(p);
  });

  it("an abandon that changes nothing visible does not bump the version", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const before = await versionOf(p);
    expect((await abandon(p, tripId)).status).toBe(200);
    expect(await versionOf(p)).toBe(before);
  });

  it("another player's, an unknown and a non-UUID segment are 404 trip_not_found", async () => {
    const owner = await newPlayer();
    const intruder = await newPlayer();
    const tripId = await openTrip(owner);
    for (const id of [tripId, randomUUID(), "not-a-uuid"]) {
      const res = await abandon(intruder, id);
      expect(res.status, id).toBe(404);
      expect(res.body.error.code).toBe("trip_not_found");
    }
    expect((await tripRow(tripId)).status).toBe("open");
    const issueElsewhere = await issue(intruder, tripId);
    expect(issueElsewhere.status).toBe(404);
    expect(issueElsewhere.body.error.code).toBe("trip_not_found");
    const notUuid = await issue(intruder, "not-a-uuid");
    expect(notUuid.status).toBe(404);
    expect(notUuid.body.error.code).toBe("trip_not_found");
  });

  it("a completed segment is 410 trip_closed (arranged: completion itself is slice T3)", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    await sql.query(
      "UPDATE trips SET status = 'completed', rounds_banked = 10, outcome = 'all_correct', closed_at = now() WHERE id = $1",
      [tripId],
    );
    const res = await abandon(p, tripId);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("trip_closed");
    expect((await issue(p, tripId)).body.error.code).toBe("trip_closed");
  });

  it("a request body field is 400", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const res = await request(server).post(`/v1/trips/${tripId}/abandon`).set(p.auth).send({ anything: 1 });
    expect(res.status).toBe(400);
    expect((await request(server).post(`/v1/trips/${tripId}/abandon`).set(p.auth).send({})).status).toBe(200);
  });

  it("issue racing abandon ends consistent: the Round is open only when the segment is", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const p = await newPlayer();
      const tripId = await openTrip(p);
      const [issued, abandoned] = await Promise.all([issue(p, tripId), abandon(p, tripId)]);
      expect(abandoned.status).toBe(200);
      expect([201, 410]).toContain(issued.status);
      expect((await tripRow(tripId)).status).toBe("abandoned");
      expect(await openRounds(p)).toBe(0);
      if (issued.status === 410) expect(issued.body.error.code).toBe("trip_closed");
    }
  });
});

describe("Rounds inside a segment", () => {
  it("numbers Rounds 1..n, keeps the number when a Round is re-issued, and counts only banked Rounds", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const first = await issue(p, tripId);
    expect(first.body.round.flightNumber).toBe(1);
    const reissued = await issue(p, tripId);
    expect(reissued.body.round.flightNumber).toBe(1); // U5
    expect(reissued.body.round.roundId).not.toBe(first.body.round.roundId);
    expect((await tripRow(tripId)).rounds_banked).toBe(0);
    await backdateRound(reissued.body.round.roundId);
    const banked = await result(p, reissued.body.round.roundId);
    expect(banked.body.trip).toEqual({ tripId, roundsBanked: 1, perfectStreak: 1 });
    const second = await issue(p, tripId);
    expect(second.body.round.flightNumber).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM rounds WHERE trip_id = $1 AND status = 'completed'", [tripId])).toBe(1);
  });

  it("the module comes from the segment: the old { module } body is 400", async () => {
    const p = await newPlayer();
    await openTrip(p);
    expect((await request(server).post("/v1/rounds").set(p.auth).send({ module: "atc-match" })).status).toBe(400);
    expect((await request(server).post("/v1/rounds").set(p.auth).send({})).status).toBe(400);
  });

  it("ASSUMPTION (interim until T3): a full segment refuses another Round and a newer segment, and cannot be abandoned", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    for (let n = 1; n <= 10; n += 1) {
      const { res } = await bank(p, tripId);
      expect(res.body.trip.roundsBanked).toBe(n);
    }
    const full = await issue(p, tripId);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("trip_full");

    const before = await versionOf(p);
    const opened = await open(p, "identifier");
    expect(opened.status).toBe(409);
    expect(opened.body.error.code).toBe("trip_full");
    expect(opened.body.tripId).toBe(tripId);
    expect((await tripRow(tripId)).status).toBe("open");
    expect(await count("SELECT COUNT(*) AS n FROM trips WHERE player_id = $1", [p.principal])).toBe(1);

    const abandoned = await abandon(p, tripId);
    expect(abandoned.status).toBe(409);
    expect(abandoned.body.error.code).toBe("trip_full");
    expect(await versionOf(p)).toBe(before);
    // 10 perfect Rounds in a row: the streak stays with the full segment until it is completed (T3).
    expect((await progress(p)).perfectStreak).toBe(10);
    await expectLedgersBalanced(p);
  });

  it("a full segment never expires by the clock (it waits for completion)", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    for (let n = 1; n <= 10; n += 1) await bank(p, tripId);
    await sql.query("UPDATE trips SET opened_at = now() - interval '3 hours', expires_at = now() - interval '2 hours' WHERE id = $1", [tripId]);
    const res = await issue(p, tripId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("trip_full");
    expect((await tripRow(tripId)).status).toBe("open");
  });

  it("ASSUMPTION A2: a Round of an abandoned segment still counts for the day streak, and keeps its Miles", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    await bank(p, tripId);
    await abandon(p, tripId);
    const counters = await row("SELECT * FROM player_counters WHERE player_id = $1", [p.principal]);
    expect(counters).toMatchObject({ day_streak: 1, flights_on_last_played_date: 1, best_day_streak: 1 });
    expect(counters.last_played_date).toBeDefined();
    expect((await progress(p)).miles).toBe(70);
  });
});

describe("U4: expiry 30 minutes after the last activity", () => {
  const age = (tripId: string, minutes = 31) =>
    sql.query(
      `UPDATE trips SET opened_at = opened_at - ($2::int * interval '1 minute'), expires_at = expires_at - ($2::int * interval '1 minute')
        WHERE id = $1`,
      [tripId, minutes],
    );

  it("issuing and banking both restart the 30 minute clock", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    await age(tripId, 20);
    const stale = new Date((await tripRow(tripId)).expires_at).getTime();
    const issued = await issue(p, tripId);
    const afterIssue = new Date((await tripRow(tripId)).expires_at).getTime();
    expect(afterIssue).toBeGreaterThan(stale + 19 * 60_000);
    expect(afterIssue - Date.now()).toBeGreaterThan(29 * 60_000);
    await age(tripId, 20);
    await backdateRound(issued.body.round.roundId);
    expect((await result(p, issued.body.round.roundId)).status).toBe(200);
    expect(new Date((await tripRow(tripId)).expires_at).getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
  });

  it("an expired segment answers 410 trip_expired, is closed at its expiry, and releases the streak", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    await bank(p, tripId);
    expect((await progress(p)).perfectStreak).toBe(1);
    await age(tripId);

    // Reads already show no streak, before any write marks the segment.
    expect((await progress(p)).perfectStreak).toBe(0);
    expect((await row("SELECT perfect_streak FROM players WHERE id = $1", [p.principal])).perfect_streak).toBe(1);

    const expired = await issue(p, tripId);
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe("trip_expired");
    const stored = await tripRow(tripId);
    expect(stored.status).toBe("abandoned");
    expect(new Date(stored.closed_at).getTime()).toBe(new Date(stored.expires_at).getTime());
    expect((await row("SELECT perfect_streak FROM players WHERE id = $1", [p.principal])).perfect_streak).toBe(0);

    // Every later call keeps saying expired, not closed.
    expect((await issue(p, tripId)).body.error.code).toBe("trip_expired");
    const replay = await abandon(p, tripId);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.trip.status).toBe("abandoned");
  });

  it("ASSUMPTION: an expired Round's result says round_expired and marks the segment; trip_expired is the defensive answer for a live Round in an expired segment", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const issued = await issue(p, tripId);
    const roundId = issued.body.round.roundId as string;
    await backdateRound(roundId);
    // Only the segment's clock ran out: its Round is still inside its own 30 minutes.
    await age(tripId);
    const res = await result(p, roundId);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("trip_expired");
    expect((await tripRow(tripId)).status).toBe("abandoned");
    expect(await count("SELECT COUNT(*) AS n FROM rounds WHERE id = $1 AND status = 'completed'", [roundId])).toBe(0);

    // Both clocks out: the Round's own answer wins (contract: round_expired).
    const q = await newPlayer();
    const t2 = await openTrip(q);
    const r2 = (await issue(q, t2)).body.round.roundId as string;
    await sql.query("UPDATE rounds SET issued_at = issued_at - interval '40 minutes', expires_at = expires_at - interval '40 minutes' WHERE id = $1", [r2]);
    await age(t2, 40);
    const both = await result(q, r2);
    expect(both.status).toBe(410);
    expect(both.body.error.code).toBe("round_expired");
    expect((await tripRow(t2)).status).toBe("abandoned");
  });

  it("a new segment can be opened over an expired one, closing it at its expiry", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    await age(tripId);
    const next = await open(p, "atc-match");
    expect(next.status).toBe(201);
    const stored = await tripRow(tripId);
    expect(stored.status).toBe("abandoned");
    expect(new Date(stored.closed_at).getTime()).toBe(new Date(stored.expires_at).getTime());
    expect((await issue(p, tripId)).body.error.code).toBe("trip_expired");
    expect(await openTrips(p)).toBe(1);
  });

  it("the replay of an Idempotency-Key reads an expired segment as abandoned", async () => {
    const p = await newPlayer();
    const key = newKey();
    const first = await open(p, "atc-match", key);
    await age(first.body.trip.tripId);
    const again = await open(p, "atc-match", key);
    expect(again.status).toBe(200);
    expect(again.body.trip).toMatchObject({ status: "abandoned", currentRoundId: null, perfectStreak: 0 });
  });
});

describe("D-3: the Perfect Streak belongs to the segment", () => {
  it("starts at 0, accumulates inside the segment and pays streak Miles from the segment's own streak", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const first = (await bank(p, tripId)).res.body;
    expect(first.award.streakMiles).toBe(0);
    const second = (await bank(p, tripId)).res.body;
    expect(second.award.streakMiles).toBe(5);
    expect(second.trip.perfectStreak).toBe(2);
    expect((await progress(p)).perfectStreak).toBe(2);
    expect((await tripRow(tripId)).rounds_banked).toBe(2);
  });

  it("opening a new segment resets the streak (and bumps the version only because it changed); the first Round pays no streak Miles", async () => {
    const p = await newPlayer();
    const a = await openTrip(p);
    await bank(p, a);
    await bank(p, a);
    const before = await versionOf(p);
    const b = await open(p, "atc-match");
    expect(b.status).toBe(201);
    expect(b.body.progress.perfectStreak).toBe(0);
    expect(await versionOf(p)).toBe(before + 1);
    const fresh = (await bank(p, b.body.trip.tripId)).res.body;
    expect(fresh.award.streakMiles).toBe(0);
    expect(fresh.trip.perfectStreak).toBe(1);

    // A segment opened while the streak is already 0 changes nothing visible: no version bump.
    const p2 = await newPlayer();
    const v = await versionOf(p2);
    await openTrip(p2);
    await openTrip(p2);
    expect(await versionOf(p2)).toBe(v);
  });

  it("a non-perfect Round breaks the streak inside the segment", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    await bank(p, tripId);
    const broken = (await bank(p, tripId, { errorCount: 1, attempts: 2 })).res.body;
    expect(broken.trip.perfectStreak).toBe(0);
    expect(broken.award.completion).toBe("standard");
  });

  it("U13: progress reads 0 when no segment is open, whatever the stored value", async () => {
    const p = await newPlayer();
    await sql.query("UPDATE players SET perfect_streak = 4 WHERE id = $1", [p.principal]);
    expect((await progress(p)).perfectStreak).toBe(0);
    await openTrip(p);
    expect((await progress(p)).perfectStreak).toBe(0); // opening resets the stored value too
  });
});

describe("Flight facts and the commercial key gate", () => {
  it("rejects an identifier key outside the seeded catalog with 400 and banks nothing", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p, "identifier");
    const issued = await issue(p, tripId);
    const roundId = issued.body.round.roundId as string;
    await backdateRound(roundId);
    const before = await versionOf(p);
    for (const aircraftKey of ["a320", "A32O", "mil:eurofighter typhoon", "mil-a4", "9999", null]) {
      const res = await result(p, roundId, { ...factsFor("identifier"), aircraftKey });
      expect(res.status, String(aircraftKey)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    // Nothing banked: the Round is still open, the segment and the balances are untouched, no Card-ish data stored.
    const stored = await row("SELECT status, aircraft_key, card_key FROM rounds WHERE id = $1", [roundId]);
    expect(stored).toEqual({ status: "open", aircraft_key: null, card_key: null });
    expect((await tripRow(tripId)).rounds_banked).toBe(0);
    expect(await versionOf(p)).toBe(before);
    expect(await count("SELECT COUNT(*) AS n FROM miles_ledger WHERE player_id = $1", [p.principal])).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM player_counters WHERE player_id = $1", [p.principal])).toBe(0);

    // The same Round banks once the key is right, and stores the facts.
    const ok = await result(p, roundId, factsFor("identifier", { aircraftKey: "A320", answerMs: 2500, attempts: 2, errorCount: 1 }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await row("SELECT aircraft_key, card_key, answer_ms, attempts FROM rounds WHERE id = $1", [roundId])).toEqual({
      aircraft_key: "A320",
      card_key: "A320",
      answer_ms: 2500,
      attempts: 2,
    });
  });

  it("module rules: a key for a module without Cards, attempts below errorCount, an answerMs longer than the Round", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p, "atc-match");
    const roundId = (await issue(p, tripId)).body.round.roundId as string;
    await backdateRound(roundId);
    const bad: Record<string, unknown>[] = [
      { aircraftKey: "787" },
      { errorCount: 2, attempts: 1 },
      { finished: true, attempts: 0 },
      { answerMs: 6000 + 2001 + 1000 }, // backdated 6 s plus the 2 s slack
      { answerMs: 1_800_001 },
      { attempts: 1001 },
    ];
    for (const body of bad) {
      const res = await result(p, roundId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await versionOf(p)).toBe(1);
    // finished false needs no attempt; an unfinished Round banks and pays nothing.
    const timeout = await result(p, roundId, { finished: false, attempts: 0 });
    expect(timeout.status).toBe(200);
    expect(timeout.body.award).toMatchObject({ completion: "unfinished", miles: 0 });
  });

  it("a missing Flight fact is 400 (the old four-field body no longer banks)", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const roundId = (await issue(p, tripId)).body.round.roundId as string;
    await backdateRound(roundId);
    const res = await request(server)
      .post(`/v1/rounds/${roundId}/result`)
      .set(p.auth)
      .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("ASSUMPTION A6: Military: the key is a stored question id; unknown ids are 400, retired ones are accepted", async () => {
    const p = await newPlayer();
    await ensureMilitaryItem(sql, "mil-a77", "Eurofighter Typhoon");
    await sql.query("UPDATE content_items SET status = 'retired' WHERE module = 'aircraft-identifier-military' AND id = 'mil-a77'");
    const tripId = await openTrip(p, "aircraft-identifier-military");
    const roundId = (await issue(p, tripId)).body.round.roundId as string;
    await backdateRound(roundId);
    const unknown = await result(p, roundId, factsFor("aircraft-identifier-military", { aircraftKey: "mil-a99999" }));
    expect(unknown.status).toBe(400);
    const ok = await result(p, roundId, factsFor("aircraft-identifier-military", { aircraftKey: "mil-a77" }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await row("SELECT card_key, aircraft_key FROM rounds WHERE id = $1", [roundId]))).toEqual({
      card_key: "mil:eurofighter typhoon",
      aircraft_key: "mil-a77",
    });
  });

  it("ASSUMPTION: Military: the Card key is frozen at first use (runtime freeze) on the item, so a later text edit does not move it", async () => {
    const p = await newPlayer();
    await ensureMilitaryItem(sql, "mil-a78", "Lockheed Martin F-16");
    const tripId = await openTrip(p, "aircraft-identifier-military");
    const facts = factsFor("aircraft-identifier-military", { aircraftKey: "mil-a78" });
    await bank(p, tripId, facts);
    expect((await row("SELECT card_key FROM content_items WHERE id = 'mil-a78'", [])).card_key).toBe("mil:lockheed martin f-16");
    // A staff typo fix (here: a different spelling) leaves the frozen key alone.
    await sql.query(`UPDATE content_items SET data = jsonb_set(data, '{answer}', '"General Dynamics F-16"') WHERE id = 'mil-a78'`);
    const second = await bank(p, tripId, facts);
    expect((await row("SELECT card_key FROM rounds WHERE id = $1", [second.roundId])).card_key).toBe("mil:lockheed martin f-16");
  });

  it("Military: the importer freezes the key on create", async () => {
    // The staff import path is covered by content.e2e.test.ts; here the stored shape is checked on a created row.
    const staff = { Authorization: `Bearer ${emulatorToken("staff")}` };
    const { clientSheet } = await import("./fixtures.js");
    const { XLSX_MIME } = await import("../src/content/xlsx.js");
    await sql.query("DELETE FROM content_items WHERE module = 'aircraft-identifier-military'");
    await sql.query("DELETE FROM content_imports WHERE module = 'aircraft-identifier-military'");
    const res = await request(server)
      .post("/v1/admin/content/aircraft-identifier-military/imports")
      .set(staff)
      .set("Content-Type", XLSX_MIME)
      .send(await clientSheet(3));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const keys = (await sql.query("SELECT id, card_key FROM content_items WHERE module = 'aircraft-identifier-military' ORDER BY id")).rows;
    expect(keys).toEqual([
      { id: "mil-a1", card_key: "mil:aircraft 1" },
      { id: "mil-a2", card_key: "mil:aircraft 2" },
      { id: "mil-a3", card_key: "mil:aircraft 3" },
    ]);
    await sql.query("DELETE FROM content_items WHERE module = 'aircraft-identifier-military'");
    await sql.query("DELETE FROM content_imports WHERE module = 'aircraft-identifier-military'");
  });
});

describe("day streak and the 7-day hint grant", () => {
  const arrangeCounters = (p: Player, lastPlayedDate: string, dayStreak: number, best = dayStreak) =>
    sql.query(
      `INSERT INTO player_counters (player_id, last_played_date, flights_on_last_played_date, day_streak, best_day_streak, updated_at)
       VALUES ($1, $2, 3, $3, $4, now())
       ON CONFLICT (player_id) DO UPDATE SET last_played_date = $2, flights_on_last_played_date = 3, day_streak = $3, best_day_streak = $4`,
      [p.principal, lastPlayedDate, dayStreak, best],
    );

  it("the first Round starts the day streak at 1 and grants nothing", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const { res } = await bank(p, tripId);
    expect(res.body.hintGrants).toEqual([]);
    expect(await row("SELECT day_streak, best_day_streak, flights_on_last_played_date FROM player_counters WHERE player_id = $1", [p.principal])).toEqual({
      day_streak: 1,
      best_day_streak: 1,
      flights_on_last_played_date: 1,
    });
  });

  it("the 7th consecutive local day grants one day_streak_grant hint, once, and a replay reports the same grant", async () => {
    const p = await newPlayer();
    const today = utcToday();
    await arrangeCounters(p, addDays(today, -1), 6);
    const tripId = await openTrip(p);
    const hintsBefore = (await progress(p)).hints;
    const versionBefore = await versionOf(p);

    const first = await bank(p, tripId);
    expect(first.res.body.hintGrants).toEqual([{ kind: "day_streak_grant", hints: 1, ref: today }]);
    expect(first.res.body.progress.hints).toBe(hintsBefore + 1);
    expect(await versionOf(p)).toBe(versionBefore + 1); // one Round, one bump, the grant rides along
    expect((await row("SELECT day_streak, best_day_streak FROM player_counters WHERE player_id = $1", [p.principal]))).toEqual({
      day_streak: 7,
      best_day_streak: 7,
    });
    const ledger = (await sql.query("SELECT delta, kind, ref FROM hint_ledger WHERE player_id = $1 AND kind = 'day_streak_grant'", [p.principal])).rows;
    expect(ledger).toEqual([{ delta: 1, kind: "day_streak_grant", ref: today }]);

    // Replay of the granting Round: same grant, nothing paid again.
    const replay = await result(p, first.roundId);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.hintGrants).toEqual([{ kind: "day_streak_grant", hints: 1, ref: today }]);
    expect(replay.body.progress.hints).toBe(hintsBefore + 1);

    // A second Round the same day grants nothing, and neither does its replay.
    const second = await bank(p, tripId);
    expect(second.res.body.hintGrants).toEqual([]);
    expect((await result(p, second.roundId)).body.hintGrants).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM hint_ledger WHERE player_id = $1 AND kind = 'day_streak_grant'", [p.principal])).toBe(1);
    expect(await row("SELECT flights_on_last_played_date AS n FROM player_counters WHERE player_id = $1", [p.principal])).toEqual({ n: 2 });
    await expectLedgersBalanced(p);
  });

  it("the 14th day grants again, a gap restarts the streak, and a day streak of 5 grants nothing", async () => {
    const p = await newPlayer();
    const today = utcToday();
    await arrangeCounters(p, addDays(today, -1), 13);
    const t1 = await openTrip(p);
    expect((await bank(p, t1)).res.body.hintGrants).toHaveLength(1);

    const q = await newPlayer();
    await arrangeCounters(q, addDays(today, -3), 6, 6); // a gap of three days
    const t2 = await openTrip(q);
    expect((await bank(q, t2)).res.body.hintGrants).toEqual([]);
    expect(await row("SELECT day_streak, best_day_streak FROM player_counters WHERE player_id = $1", [q.principal])).toEqual({ day_streak: 1, best_day_streak: 6 });

    const r = await newPlayer();
    await arrangeCounters(r, addDays(today, -1), 4);
    const t3 = await openTrip(r);
    expect((await bank(r, t3)).res.body.hintGrants).toEqual([]);
    expect((await row("SELECT day_streak FROM player_counters WHERE player_id = $1", [r.principal])).day_streak).toBe(5);
  });

  it("the server clock decides: a last played day in the future counts the Round on that day and changes no streak", async () => {
    const p = await newPlayer();
    const future = addDays(utcToday(), 3);
    await arrangeCounters(p, future, 6);
    const tripId = await openTrip(p);
    const { res } = await bank(p, tripId);
    expect(res.body.hintGrants).toEqual([]);
    const c = await row("SELECT last_played_date::text AS last, day_streak, flights_on_last_played_date AS n FROM player_counters WHERE player_id = $1", [p.principal]);
    expect(c).toEqual({ last: future, day_streak: 6, n: 4 });
  });

  it("the segment's offset decides the local day of a Round", async () => {
    const p = await newPlayer();
    const tripId = (await open(p, "atc-match", newKey(), { utcOffsetMinutes: 840, localDate: utcToday(840) })).body.trip.tripId as string;
    const { roundId } = await bank(p, tripId);
    expect((await row("SELECT local_date::text AS d FROM rounds WHERE id = $1", [roundId])).d).toBe(utcToday(840));
  });

  it("the database accepts the two new hint kinds and refuses unknown ones", async () => {
    const p = await newPlayer();
    const insert = (kind: string) =>
      sql.query("INSERT INTO hint_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, 1, $2, $3, now())", [p.principal, kind, newKey()]);
    await insert("trip_grant");
    await insert("day_streak_grant");
    await expect(insert("bonus")).rejects.toMatchObject({ code: "23514" });
    await sql.query("DELETE FROM hint_ledger WHERE player_id = $1 AND kind IN ('trip_grant', 'day_streak_grant')", [p.principal]);
  });
});

describe("integrity", () => {
  it("a Round result queued behind the player lock banks into the right segment", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const roundId = (await issue(p, tripId)).body.round.roundId as string;
    await backdateRound(roundId);
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM players WHERE id = $1 FOR UPDATE", [p.principal]);
    let settled = false;
    const pending = result(p, roundId).then((r) => {
      settled = true;
      return r;
    });
    await sleep(300);
    expect(settled).toBe(false);
    await holder.query("COMMIT");
    await holder.end();
    expect((await pending).status).toBe(200);
    expect((await tripRow(tripId)).rounds_banked).toBe(1);
  });

  it("the same Round banked by three concurrent results counts once in the segment and the day log", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const roundId = (await issue(p, tripId)).body.round.roundId as string;
    await backdateRound(roundId);
    const replies = await Promise.all([0, 1, 2].map(() => result(p, roundId)));
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(replies.filter((r) => r.body.replayed === false)).toHaveLength(1);
    expect((await tripRow(tripId)).rounds_banked).toBe(1);
    expect((await row("SELECT flights_on_last_played_date AS n FROM player_counters WHERE player_id = $1", [p.principal])).n).toBe(1);
    await expectLedgersBalanced(p);
  });

  it("the database refuses out-of-range segment and Round values", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    for (const statement of [
      "UPDATE trips SET rounds_banked = 11",
      "UPDATE trips SET rounds_banked = -1",
      "UPDATE trips SET flight_count = 9",
      "UPDATE trips SET utc_offset_minutes = 841",
      "UPDATE trips SET status = 'weird'",
      "UPDATE trips SET status = 'completed'", // completed needs 10 banked Rounds and an outcome
      "UPDATE trips SET closed_at = now()", // an open segment has no closed_at
      "UPDATE trips SET status = 'abandoned'", // a closed segment has a closed_at
      "UPDATE trips SET expires_at = opened_at",
    ]) {
      await expect(sql.query(`${statement} WHERE id = $1`, [tripId]), statement).rejects.toMatchObject({ code: "23514" });
    }
    const roundId = (await issue(p, tripId)).body.round.roundId as string;
    for (const statement of [
      "UPDATE rounds SET flight_number = 11",
      "UPDATE rounds SET flight_number = NULL",
      "UPDATE rounds SET answer_ms = 1800001",
      "UPDATE rounds SET attempts = -1",
    ]) {
      await expect(sql.query(`${statement} WHERE id = $1`, [roundId]), statement).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("two banked Rounds cannot share a flight number in one segment", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const { roundId } = await bank(p, tripId);
    const dup = randomUUID();
    await expect(
      sql.query(
        `INSERT INTO rounds (id, player_id, module, rank, pleasure_cruise, status, issued_at, expires_at, trip_id, flight_number,
                             completion_id, sp_awarded, miles_awarded)
         SELECT $1, player_id, module, rank, pleasure_cruise, 'completed', issued_at, expires_at, trip_id, flight_number, 'c', 0, 0
           FROM rounds WHERE id = $2`,
        [dup, roundId],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "rounds_trip_flight_banked" });
  });

  it("deleting the account removes its segments and day log", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    await bank(p, tripId);
    expect((await request(server).delete("/v1/me").set(p.auth)).status).toBe(204);
    expect(await count("SELECT COUNT(*) AS n FROM trips WHERE player_id = $1", [p.principal])).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM player_counters WHERE player_id = $1", [p.principal])).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM rounds WHERE trip_id = $1", [tripId])).toBe(0);
  });
});

const ageTrip = (tripId: string, minutes = 31) =>
  sql.query(
    `UPDATE trips SET opened_at = opened_at - ($2::int * interval '1 minute'), expires_at = expires_at - ($2::int * interval '1 minute')
      WHERE id = $1`,
    [tripId, minutes],
  );
const ageRound = (roundId: string, minutes = 40) =>
  sql.query(
    `UPDATE rounds SET issued_at = issued_at - ($2::int * interval '1 minute'), expires_at = expires_at - ($2::int * interval '1 minute')
      WHERE id = $1`,
    [roundId, minutes],
  );

describe("a retried result keeps its answer (review fix)", () => {
  async function expiredRound() {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const roundId = (await issue(p, tripId)).body.round.roundId as string;
    await ageRound(roundId);
    await ageTrip(tripId, 40);
    return { p, tripId, roundId };
  }

  it("round_expired stays round_expired on a retry after the segment was marked", async () => {
    const { p, roundId } = await expiredRound();
    expect((await result(p, roundId)).body.error.code).toBe("round_expired");
    expect((await result(p, roundId)).body.error.code).toBe("round_expired");
  });

  it("round_expired stays after an issue found the segment expired (trip_expired)", async () => {
    const { p, tripId, roundId } = await expiredRound();
    const issued = await issue(p, tripId);
    expect(issued.status).toBe(410);
    expect(issued.body.error.code).toBe("trip_expired");
    const retry = await result(p, roundId);
    expect(retry.status).toBe(410);
    expect(retry.body.error.code).toBe("round_expired");
  });

  it("round_expired stays after a new segment opens over the expired one", async () => {
    const { p, roundId } = await expiredRound();
    expect((await open(p, "atc-match")).status).toBe(201);
    expect(await openRounds(p)).toBe(0);
    expect((await result(p, roundId)).body.error.code).toBe("round_expired");
    expect((await result(p, roundId)).body.error.code).toBe("round_expired");
  });

  it("ASSUMPTION: trip_expired on a result is defensive and stays trip_expired after a new segment opens", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const roundId = (await issue(p, tripId)).body.round.roundId as string;
    await backdateRound(roundId);
    await ageTrip(tripId); // only the segment's clock ran out
    expect((await result(p, roundId)).body.error.code).toBe("trip_expired");
    expect((await open(p, "atc-match")).status).toBe(201);
    const retry = await result(p, roundId);
    expect(retry.status).toBe(410);
    expect(retry.body.error.code).toBe("trip_expired");
  });

  it("a Round superseded inside a live segment stays round_closed", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const first = (await issue(p, tripId)).body.round.roundId as string;
    await issue(p, tripId);
    expect((await result(p, first)).body.error.code).toBe("round_closed");
    expect((await result(p, first)).body.error.code).toBe("round_closed");
  });
});

describe("a hint needs a live segment (review fix)", () => {
  const spend = (p: Player, roundId: string) => request(server).post(`/v1/rounds/${roundId}/hint`).set(p.auth);

  it("is refused when the Round's segment is closed or expired, and costs nothing", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const roundId = (await issue(p, tripId)).body.round.roundId as string;
    await ageTrip(tripId);
    const expired = await spend(p, roundId);
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe("round_expired");

    // Segment closed by hand while the Round row stays open (the Round alone would still pass).
    const q = await newPlayer();
    const t2 = await openTrip(q);
    const r2 = (await issue(q, t2)).body.round.roundId as string;
    await sql.query("UPDATE trips SET status = 'abandoned', closed_at = now() WHERE id = $1", [t2]);
    const closed = await spend(q, r2);
    expect(closed.status).toBe(410);
    expect(closed.body.error.code).toBe("round_closed");
    for (const player of [p, q]) {
      expect((await progress(player)).hints).toBe(5);
      expect(await count("SELECT COUNT(*) AS n FROM hint_ledger WHERE player_id = $1 AND kind = 'round_spend'", [player.principal])).toBe(0);
    }
  });

  it("still spends inside a live segment", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const roundId = (await issue(p, tripId)).body.round.roundId as string;
    expect((await spend(p, roundId)).status).toBe(200);
  });
});

describe("every Progress view agrees on the live streak (review fix)", () => {
  it("PUT /v1/me, PUT /v1/me/active-rank and the shop read 0 when the stored streak belongs to an expired segment", async () => {
    const p = await newPlayer({ statusPoints: 60_000 });
    const tripId = await openTrip(p);
    await bank(p, tripId);
    expect((await progress(p)).perfectStreak).toBe(1);
    await ageTrip(tripId);
    expect((await row("SELECT perfect_streak FROM players WHERE id = $1", [p.principal])).perfect_streak).toBe(1);

    expect((await request(server).put("/v1/me").set(p.auth)).body.progress.perfectStreak).toBe(0);
    const dial = await request(server).put("/v1/me/active-rank").set(p.auth).send({ rank: "trainee" });
    expect(dial.body.progress.perfectStreak).toBe(0);
    await sql.query("UPDATE players SET miles = miles + 5000 WHERE id = $1", [p.principal]);
    await sql.query("INSERT INTO miles_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, 5000, 'round_award', $2, now())", [p.principal, newKey()]);
    const bought = await request(server).post("/v1/shop/miles-hint-pack").set(p.auth).set("Idempotency-Key", newKey());
    expect(bought.status).toBe(200);
    expect(bought.body.progress.perfectStreak).toBe(0);
    // The stored value is untouched by reads; a live segment still shows its streak everywhere.
    const live = await newPlayer();
    const t2 = await openTrip(live);
    await bank(live, t2);
    expect((await request(server).put("/v1/me").set(live.auth)).body.progress.perfectStreak).toBe(1);
  });

  it("the UGS mirror snapshot uses the same rule", async () => {
    const { withLiveStreak } = await import("../src/trips/trip-store.js");
    const { mirrorSnapshot } = await import("../src/ugs/mirror-policy.js");
    const p = await newPlayer();
    const tripId = await openTrip(p);
    await bank(p, tripId);
    await ageTrip(tripId);
    const player = (await sql.query("SELECT id, status_points AS \"statusPoints\" FROM players WHERE id = $1", [p.principal])).rows[0];
    void player;
    const full = (await sql.query("SELECT * FROM players WHERE id = $1", [p.principal])).rows[0];
    const asRow = {
      id: full.id, statusPoints: full.status_points, miles: full.miles, hints: full.hints, perfectStreak: full.perfect_streak,
      activeRank: full.active_rank, firstClassUntil: full.first_class_until, version: full.version, createdAt: full.created_at, updatedAt: full.updated_at,
    };
    expect(mirrorSnapshot(asRow, new Date()).perfectStreak).toBe(1);
    const { DatabaseService } = await import("../src/database/database.module.js");
    const db = app.get(DatabaseService).db;
    expect(mirrorSnapshot(await withLiveStreak(db, asRow, new Date()), new Date()).perfectStreak).toBe(0);
  });
});

describe("Idempotency-Key reuse with another module (review fix)", () => {
  it("is 422 idempotency_key_reused, opens nothing and changes nothing", async () => {
    const p = await newPlayer();
    const key = newKey();
    const first = await open(p, "atc-match", key);
    expect(first.status).toBe(201);
    const reused = await open(p, "identifier", key);
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe("idempotency_key_reused");
    expect(await count("SELECT COUNT(*) AS n FROM trips WHERE player_id = $1", [p.principal])).toBe(1);
    expect((await tripRow(first.body.trip.tripId)).status).toBe("open");
    // The same module still replays.
    expect((await open(p, "atc-match", key)).status).toBe(200);
  });
});

describe("a re-issued Round keeps the Perfect Streak", () => {
  it("ASSUMPTION A9: abandoning a Round by re-issuing it neither breaks nor extends the streak", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    await bank(p, tripId); // streak 1
    await issue(p, tripId);
    const again = await issue(p, tripId);
    expect((await progress(p)).perfectStreak).toBe(1);
    await backdateRound(again.body.round.roundId);
    const res = await result(p, again.body.round.roundId);
    expect(res.body.award.streakMiles).toBe(5);
    expect(res.body.trip.perfectStreak).toBe(2);
  });
});
