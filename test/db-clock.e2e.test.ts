import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { setTestDatabaseClockSkew } from "../src/database/clock.js";
import { MIN_ROUND_MS } from "../src/rounds/rounds.service.js";
import { emulatorToken } from "./tokens.js";
import { factsFor, newKey, openBody } from "./trip-helpers.js";

// A3: every time judgement and stored timestamp of the player-facing writes is ONE database instant per transaction.
// The process clock (Date) is never consulted, so the only way to move "now" is the database clock, which these tests
// shift with the test seam (src/database/clock.ts). Two Nest apps on one database stand for two backend instances.

const MINUTE = 60_000;

async function boot() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ["error"], bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  return app;
}

let appA: NestExpressApplication;
let appB: NestExpressApplication;
let sql: pg.Pool;
const serverOf = (app: NestExpressApplication) => app.getHttpServer();

beforeAll(async () => {
  appA = await boot();
  appB = await boot();
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});

afterEach(() => setTestDatabaseClockSkew(0));

afterAll(async () => {
  await sql.end();
  await appB.close();
  await appA.close();
});

async function newPlayer(app = appA) {
  const uid = `uid-${randomUUID()}`;
  const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
  const created = await request(serverOf(app)).put("/v1/me").set(auth);
  expect(created.status).toBe(201);
  return { uid, auth, principal: `firebase:demo-airplane-games:${uid}` };
}
type Player = Awaited<ReturnType<typeof newPlayer>>;

const dbMs = async () => new Date((await sql.query("SELECT clock_timestamp() AS t")).rows[0].t).getTime();
const open = (p: Player, app = appA, overrides: Record<string, unknown> = {}) =>
  request(serverOf(app)).post("/v1/trips").set(p.auth).set("Idempotency-Key", newKey()).send(openBody("atc-match", overrides));
const issue = (p: Player, tripId: string, app = appA) => request(serverOf(app)).post("/v1/rounds").set(p.auth).send({ tripId });
const result = (p: Player, roundId: string, app = appA) =>
  request(serverOf(app))
    .post(`/v1/rounds/${roundId}/result`)
    .set(p.auth)
    .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9, ...factsFor("atc-match") });
const hint = (p: Player, roundId: string, app = appA) => request(serverOf(app)).post(`/v1/rounds/${roundId}/hint`).set(p.auth);
const progress = async (p: Player, app = appA) => (await request(serverOf(app)).get("/v1/me/progress").set(p.auth)).body.progress;
const near = (actual: number, expected: number, toleranceMs = 5_000) => expect(Math.abs(actual - expected)).toBeLessThan(toleranceMs);

describe("the database clock decides (A3)", () => {
  it("stamps player creation, ledgers and a Trip with database time, whatever the process clock says", async () => {
    setTestDatabaseClockSkew(7 * 60 * MINUTE);
    const skewedNow = (await dbMs()) + 7 * 60 * MINUTE;
    const p = await newPlayer();
    const created = (await sql.query("SELECT created_at FROM players WHERE id = $1", [p.principal])).rows[0];
    near(new Date(created.created_at).getTime(), skewedNow);
    const ledger = (await sql.query("SELECT created_at FROM hint_ledger WHERE player_id = $1", [p.principal])).rows[0];
    near(new Date(ledger.created_at).getTime(), skewedNow);
    // The local-date window is database time too: open with the date the skewed database clock reports.
    const localDate = new Date(skewedNow).toISOString().slice(0, 10);
    const opened = await open(p, appA, { localDate });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    near(Date.parse(opened.body.trip.openedAt), skewedNow);
    near(Date.parse(opened.body.progress.evaluatedAt), skewedNow);
    expect(Date.parse(opened.body.trip.expiresAt) - Date.parse(opened.body.trip.openedAt)).toBe(30 * MINUTE);
  });

  it("the 15 minute local-date window is judged by database time", async () => {
    const p = await newPlayer();
    // The process clock says "today"; the database clock two days ahead disagrees: the date is refused.
    setTestDatabaseClockSkew(48 * 60 * MINUTE);
    const stale = await open(p);
    expect(stale.status).toBe(422);
    expect(stale.body.error.code).toBe("local_date_mismatch");
    // The date of database time is accepted although the process clock disagrees with it.
    const localDate = new Date((await dbMs()) + 48 * 60 * MINUTE).toISOString().slice(0, 10);
    expect((await open(p, appA, { localDate })).status).toBe(201);
  });

  it("Trip expiry and the live Perfect Streak follow database time, not the process clock", async () => {
    const p = await newPlayer();
    const tripId = (await open(p)).body.trip.tripId as string;
    const issued = await issue(p, tripId);
    expect(issued.status).toBe(201);
    await sql.query("UPDATE rounds SET issued_at = issued_at - ($1::int * interval '1 millisecond') WHERE id = $2", [MIN_ROUND_MS * 2, issued.body.round.roundId]);
    expect((await result(p, issued.body.round.roundId)).status).toBe(200);
    expect((await progress(p)).perfectStreak).toBe(1);

    // The database clock moves 31 minutes on (the process clock does not): the segment is expired for every route.
    setTestDatabaseClockSkew(31 * MINUTE);
    const later = await progress(p);
    expect(later.perfectStreak).toBe(0);
    near(Date.parse(later.evaluatedAt), (await dbMs()) + 31 * MINUTE);

    // Back at the true database time the segment is live again: a read judges expiry lazily and writes nothing.
    setTestDatabaseClockSkew(0);
    expect((await progress(p)).perfectStreak).toBe(1);

    // A write at skewed database time refuses by the same judgement (and marks the segment abandoned, as every route does).
    setTestDatabaseClockSkew(31 * MINUTE);
    const refused = await issue(p, tripId);
    expect(refused.status).toBe(410);
    expect(refused.body.error.code).toBe("trip_expired");
  });

  it("a Round's lifetime and its answer-time floor follow database time", async () => {
    const p = await newPlayer();
    const tripId = (await open(p)).body.trip.tripId as string;
    const roundId = (await issue(p, tripId)).body.round.roundId as string;
    // Immediately: below the 3 s floor in database time.
    expect((await result(p, roundId)).body.error.code).toBe("round_too_fast");
    // 31 minutes of database time later the Round is gone.
    setTestDatabaseClockSkew(31 * MINUTE);
    const gone = await result(p, roundId);
    expect(gone.status).toBe(410);
    expect(gone.body.error.code).toBe("round_expired");
  });

  it("a hint on a Round older than its lifetime in database time is refused; at true database time it spends", async () => {
    const p = await newPlayer();
    const tripId = (await open(p)).body.trip.tripId as string;
    const roundId = (await issue(p, tripId)).body.round.roundId as string;
    setTestDatabaseClockSkew(31 * MINUTE);
    expect((await hint(p, roundId)).status).toBe(410);
    setTestDatabaseClockSkew(0);
    expect((await hint(p, roundId)).status).toBe(200);
  });

  it("a hint pack purchase is stamped with database time", async () => {
    const p = await newPlayer();
    await sql.query("UPDATE players SET miles = 5000 WHERE id = $1", [p.principal]);
    await sql.query("INSERT INTO miles_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, 5000, 'round_award', 'seed', now())", [p.principal]);
    setTestDatabaseClockSkew(3 * 60 * MINUTE);
    const bought = await request(serverOf(appA)).post("/v1/shop/miles-hint-pack").set(p.auth).set("Idempotency-Key", newKey());
    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    const stamped = (await sql.query("SELECT created_at FROM miles_ledger WHERE player_id = $1 AND kind = 'hint_pack'", [p.principal])).rows[0];
    near(new Date(stamped.created_at).getTime(), (await dbMs()) + 3 * 60 * MINUTE);
  });
});

describe("two instances on one database agree (A3)", () => {
  it("a Round issued on instance A is timed, banked and replayed identically on instance B", async () => {
    const p = await newPlayer(appA);
    const opened = await open(p, appA);
    expect(opened.status).toBe(201);
    const tripId = opened.body.trip.tripId as string;
    const roundId = (await issue(p, tripId, appA)).body.round.roundId as string;

    // B judges the floor against issued_at that A stamped from the database clock.
    const tooFast = await result(p, roundId, appB);
    expect(tooFast.status).toBe(429);
    expect(tooFast.body.error.code).toBe("round_too_fast");

    await new Promise((r) => setTimeout(r, MIN_ROUND_MS + 200));
    const banked = await result(p, roundId, appB);
    expect(banked.status, JSON.stringify(banked.body)).toBe(200);
    expect(banked.body.replayed).toBe(false);
    // A replays B's write, at the same version.
    const replay = await result(p, roundId, appA);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect((await progress(p, appA)).version).toBe(banked.body.progress.version);

    // Both instances see the segment expire at the same database instant.
    setTestDatabaseClockSkew(31 * MINUTE);
    expect((await issue(p, tripId, appA)).body.error.code).toBe("trip_expired");
    expect((await issue(p, tripId, appB)).body.error.code).toBe("trip_expired");
    expect((await progress(p, appB)).perfectStreak).toBe(0);
  });
});
