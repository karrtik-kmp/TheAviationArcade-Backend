import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { MIN_ROUND_MS } from "../src/rounds/rounds.service.js";
import { emulatorToken } from "./tokens.js";
import { factsFor, newKey, openBody } from "./trip-helpers.js";

// Regression coverage for the API/interface review; real Nest routes and the dedicated test database.

const PREFIX = "firebase:demo-airplane-games:";

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

async function newPlayer() {
  const uid = `uid-${randomUUID()}`;
  const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
  const created = await request(server).put("/v1/me").set(auth);
  expect(created.status).toBe(201);
  const principal = `${PREFIX}${uid}`;
  return { uid, auth, principal };
}

const open = (p: Player, module = "atc-match", key: string = newKey(), overrides: Record<string, unknown> = {}) =>
  request(server).post("/v1/trips").set(p.auth).set("Idempotency-Key", key).send(openBody(module, overrides));
const issue = (p: Player, tripId: string) => request(server).post("/v1/rounds").set(p.auth).send({ tripId });
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


const ageTrip = (tripId: string) => sql.query("UPDATE trips SET opened_at=opened_at-interval '31 minutes', expires_at=expires_at-interval '31 minutes' WHERE id=$1", [tripId]);

describe("API review regressions", () => {
  it("a banked Flight replay normalizes progress after its Trip expires", async () => {
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const { roundId } = await bank(p, tripId);
    await ageTrip(tripId);
    const replay = await result(p, roundId);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.trip.perfectStreak).toBe(0);
    expect(replay.body.progress.perfectStreak).toBe(0);
    expect(replay.body.progress.perfectStreak).toBe((await progress(p)).perfectStreak);
    await expectLedgersBalanced(p);
  });

  it("D-1 amended (user ruling 2026-11-02): expiry evaluations at one stored version are ordered by database-clock evaluatedAt across API and UGS snapshots", async () => {
    const { PlayersService } = await import("../src/players/players.service.js");
    const { mirrorSnapshot } = await import("../src/ugs/mirror-policy.js");
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const { res } = await bank(p, tripId);
    const before = res.body.progress;
    expect(before.perfectStreak).toBe(1);
    await ageTrip(tripId);
    const after = await progress(p);
    expect(after.version).toBe(before.version);
    expect(after.perfectStreak).toBe(0);
    expect(typeof before.evaluatedAt).toBe("string");
    expect(Date.parse(after.evaluatedAt)).toBeGreaterThan(Date.parse(before.evaluatedAt));
    const service = app.get(PlayersService);
    const player = await service.getPlayer(p.principal);
    const mirror = mirrorSnapshot(await service.live(player!));
    expect(mirror.version).toBe(after.version);
    expect(mirror.perfectStreak).toBe(0);
    expect(Date.parse(mirror.evaluatedAt)).toBeGreaterThanOrEqual(Date.parse(after.evaluatedAt));
    // Sanity bracket only: on one host the process and database clocks agree, so this cannot prove which one stamped it
    // (the process-clock-skew tests do: issueRound and the Round tests pass a skewed clock and still get database-time answers).
    const dbNow = new Date((await sql.query("SELECT clock_timestamp() AS t")).rows[0].t).getTime();
    expect(dbNow - Date.parse(mirror.evaluatedAt)).toBeLessThan(5_000);
    expect(Date.parse(mirror.evaluatedAt)).toBeLessThanOrEqual(dbNow);
    expect(await versionOf(p)).toBe(before.version);
  });

  it.each([
    { module: "identifier" },
    { contentVersion: "another-pack" },
    { utcOffsetMinutes: 60 },
    { localDate: "2020-01-01" },
  ])("U14 (user ruling 2026-11-02): a Trip key reused with a changed module, localDate, utcOffsetMinutes or contentVersion is 422 idempotency_key_reused: %j", async (changes) => {
    const p = await newPlayer();
    const key = newKey();
    const opened = await open(p, "atc-match", key);
    const original = await tripRow(opened.body.trip.tripId);
    const version = await versionOf(p);
    const refused = await open(p, "atc-match", key, changes);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("idempotency_key_reused");
    expect(await tripRow(opened.body.trip.tripId)).toEqual(original);
    expect(await versionOf(p)).toBe(version);
    expect(await openTrips(p)).toBe(1);
    expect((await open(p, "atc-match", key)).status).toBe(200);
  });

  it("time-derived First Class status at one version carries its evaluation time", async () => {
    const { progressView } = await import("../src/players/progress-view.js");
    const { mirrorSnapshot } = await import("../src/ugs/mirror-policy.js");
    const { PlayersService } = await import("../src/players/players.service.js");
    const p = await newPlayer();
    const stored = (await app.get(PlayersService).getPlayer(p.principal))!;
    const player = { ...stored, firstClassUntil: new Date("2026-10-29T12:00:00Z") };
    const before = progressView({ ...player, evaluatedAt: new Date("2026-10-29T11:59:59Z") });
    const after = progressView({ ...player, evaluatedAt: new Date("2026-10-29T12:00:00Z") });
    expect(before.firstClassPass).toBe(true);
    expect(after.firstClassPass).toBe(false);
    expect(after.version).toBe(before.version);
    expect(before.evaluatedAt).toBe("2026-10-29T11:59:59.000Z");
    expect(after.evaluatedAt).toBe("2026-10-29T12:00:00.000Z");
    expect(mirrorSnapshot({ ...player, evaluatedAt: new Date(after.evaluatedAt) }).evaluatedAt).toBe(after.evaluatedAt);
  });

  it("D-1 amended: issuing a Round never lets one version read streak 0 and then non-zero, even from a process whose clock lags", async () => {
    const { RoundsService } = await import("../src/rounds/rounds.service.js");
    const p = await newPlayer();
    const tripId = await openTrip(p);
    await bank(p, tripId);
    // Still live: issuing moves the segment's expiry without a version bump, and the streak never drops.
    const live = await progress(p);
    expect(live.perfectStreak).toBe(1);
    expect((await issue(p, tripId)).status).toBe(201);
    const stillLive = await progress(p);
    expect(stillLive.version).toBe(live.version);
    expect(stillLive.perfectStreak).toBe(1);

    // Expired by the database clock: a read judges 0 at this version...
    await ageTrip(tripId);
    const expired = await progress(p);
    expect(expired.perfectStreak).toBe(0);
    // ...and a process clock an hour behind must NOT be able to extend the segment (issueRound judges by the database
    // clock too). It answers trip_expired, so the streak cannot come back at this version.
    const lagging = new Date(Date.now() - 3_600_000);
    const outcome = await app.get(RoundsService).issueRound(p.principal, tripId, lagging);
    expect(outcome.kind).toBe("trip_expired");
    const later = await progress(p);
    expect(later.perfectStreak).toBe(0);
    expect(later.version).toBeGreaterThanOrEqual(expired.version);
    expect(Date.parse(later.evaluatedAt)).toBeGreaterThan(Date.parse(expired.evaluatedAt));
  });

  it("a Round is judged by the database clock: a process clock a few seconds off neither refuses nor under-floors it", async () => {
    const { RoundsService } = await import("../src/rounds/rounds.service.js");
    const rounds = app.get(RoundsService);
    const body = { finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9, ...factsFor("atc-match") } as never;
    const p = await newPlayer();
    const tripId = await openTrip(p);
    const issued = await issue(p, tripId);
    const roundId = issued.body.round.roundId as string;
    // Process clock 10 s AHEAD: the 3 s floor must still apply (issued_at is database time).
    const ahead = await rounds.completeRound(p.principal, roundId, body, new Date(Date.now() + 10_000));
    expect(ahead.kind).toBe("too_fast");
    // Process clock 10 s BEHIND, after the real floor has passed: must bank, not report too_fast or invalid facts.
    await new Promise(r => setTimeout(r, MIN_ROUND_MS + 200));
    const behind = await rounds.completeRound(p.principal, roundId, body, new Date(Date.now() - 10_000));
    expect(behind.kind).toBe("completed");
    // spendHint takes a process clock too: a clock far ahead must not expire a live Round.
    const next = await issue(p, tripId);
    const hint = await rounds.spendHint(p.principal, next.body.round.roundId as string, new Date(Date.now() + 3_600_000));
    expect(hint.kind).toBe("spent");
    await expectLedgersBalanced(p);
  });

  it("concurrent uses of one key with different payloads open only the winning intent", async () => {
    const p = await newPlayer();
    const key = newKey();
    const replies = await Promise.all([
      open(p, "atc-match", key, { contentVersion: "pack-A" }),
      open(p, "atc-match", key, { contentVersion: "pack-B" }),
    ]);
    expect(replies.map(r => r.status).sort()).toEqual([201, 422]);
    expect(replies.find(r => r.status === 422)!.body.error.code).toBe("idempotency_key_reused");
    const winner = replies.find(r => r.status === 201)!;
    const replay = await open(p, "atc-match", key, { contentVersion: winner.body.trip.contentVersion });
    expect(replay.status).toBe(200);
    expect(replay.body.trip.tripId).toBe(winner.body.trip.tripId);
    expect(await openTrips(p)).toBe(1);
  });

});
