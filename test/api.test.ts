import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { MIN_ROUND_MS } from "../src/rounds/rounds.service.js";
import { MODULE_IDS } from "../src/rules/modules.js";
import { emulatorToken } from "./tokens.js";
import { ensureMilitaryItem, factsFor, newKey, openBody } from "./trip-helpers.js";

const PRINCIPAL_PREFIX = "firebase:demo-airplane-games:";

let app: NestExpressApplication;
let server: ReturnType<INestApplication["getHttpServer"]>;
// Test-side connection for arranging and inspecting rows; the app has its own pool.
let sql: pg.Pool;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ["error"], bodyParser: false });
  configureApp(app);
  // A real listening socket, so concurrent requests really are concurrent connections.
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});

afterAll(async () => {
  await sql.end();
  await app.close();
});

type Reply = { status: number; body: any; headers: Record<string, string> };

async function send(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Reply> {
  let req = request(server)[method.toLowerCase() as "get" | "put" | "post" | "delete"](path).set(headers);
  if (body !== undefined) req = req.send(body as object);
  const res = await req;
  return { status: res.status, body: res.body, headers: res.headers as Record<string, string> };
}

// Each test signs in as a fresh uid, so tests never share a player row.
function newPlayer() {
  const uid = `uid-${randomUUID()}`;
  const token = emulatorToken(uid);
  const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    send(method, path, { Authorization: `Bearer ${token}`, ...extra }, body);
  return { uid, principal: `${PRINCIPAL_PREFIX}${uid}`, call };
}

async function json(response: Reply): Promise<any> {
  return response.body;
}

type Call = ReturnType<typeof newPlayer>["call"];

// T2: a result also carries the Flight facts (aircraftKey, answerMs, attempts). atc-match takes aircraftKey null.
const PERFECT_FAST = { finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9, ...factsFor("atc-match") };

/** Make the player's open Round look like it was issued long enough ago to pass MIN_ROUND_MS. */
async function backdate(principal: string) {
  await sql.query(
    "UPDATE rounds SET issued_at = issued_at - ($1::int * interval '1 millisecond') WHERE player_id = $2 AND status = 'open'",
    [MIN_ROUND_MS * 2, principal],
  );
}

// Since T2 a Round belongs to an open Flight Segment. The helpers keep one segment per player (per module), like the app:
// several Rounds of one test share it, so the Perfect Streak accumulates, and a different module opens a new segment.
const segmentOf = new WeakMap<Call, { id: string; module: string }>();

async function openSegment(call: Call, module = "atc-match", overrides: Record<string, unknown> = {}) {
  const res = await call("POST", "/v1/trips", openBody(module, overrides), { "Idempotency-Key": newKey() });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.trip.tripId as string;
  segmentOf.set(call, { id, module });
  return id;
}

async function startRound(call: Call, module = "atc-match") {
  let segment = segmentOf.get(call);
  if (!segment || segment.module !== module) segment = { id: await openSegment(call, module), module };
  let issued = await call("POST", "/v1/rounds", { tripId: segment.id });
  if (issued.status === 409 && issued.body.error.code === "trip_full") {
    // Arrangement: these economy tests do not model the Trip hint (+1 per 4th completed segment) that `complete` grants,
    // so they close a full segment by hand. The complete route has its own tests (trips.e2e.test.ts, slice T3).
    await sql.query("UPDATE trips SET status = 'abandoned', closed_at = now() WHERE id = $1", [segment.id]);
    segment = { id: await openSegment(call, module), module };
    issued = await call("POST", "/v1/rounds", { tripId: segment.id });
  }
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  return issued.body.round.roundId as string;
}

async function playRound(
  { call, principal }: { call: Call; principal: string },
  result: { finished: boolean; errorCount: number; usedHint: boolean; timeRemainingFraction: number; attempts?: number } = PERFECT_FAST,
) {
  const roundId = await startRound(call);
  await backdate(principal);
  return call("POST", `/v1/rounds/${roundId}/result`, { ...factsFor("atc-match"), ...result });
}

/**
 * Ledger invariants: completed Rounds account for every SP above the starting balance, and the append-only
 * ledgers account for every Mile and hint (players.miles = SUM(miles_ledger), players.hints =
 * SUM(hint_ledger)). Each Round that paid Miles has exactly one round_award entry for exactly that amount.
 * `baseline` is for balances arranged by raw SQL without a ledger entry.
 */
async function expectLedgerBalanced(principal: string, baseline = { statusPoints: 0, miles: 0 }) {
  const sums = (
    await sql.query<{ sp: number; miles: number }>(
      `SELECT COALESCE(SUM(sp_awarded), 0)::int AS sp, COALESCE(SUM(miles_awarded), 0)::int AS miles
       FROM rounds WHERE player_id = $1 AND status = 'completed'`,
      [principal],
    )
  ).rows[0];
  const player = (
    await sql.query<{ status_points: number; miles: number; hints: number }>(
      "SELECT status_points, miles, hints FROM players WHERE id = $1",
      [principal],
    )
  ).rows[0];
  const ledger = (
    await sql.query<{ miles: number; hints: number; awards: number; award_miles: number }>(
      `SELECT (SELECT COALESCE(SUM(delta), 0)::int FROM miles_ledger WHERE player_id = $1) AS miles,
              (SELECT COALESCE(SUM(delta), 0)::int FROM hint_ledger WHERE player_id = $1) AS hints,
              (SELECT COUNT(*)::int FROM miles_ledger l JOIN rounds r ON r.id = l.ref
                 WHERE l.player_id = $1 AND l.kind = 'round_award') AS awards,
              (SELECT COALESCE(SUM(l.delta), 0)::int FROM miles_ledger l JOIN rounds r ON r.id = l.ref
                 WHERE l.player_id = $1 AND l.kind = 'round_award' AND r.miles_awarded = l.delta) AS award_miles`,
      [principal],
    )
  ).rows[0];
  const paying = (
    await sql.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM rounds WHERE player_id = $1 AND status = 'completed' AND miles_awarded > 0",
      [principal],
    )
  ).rows[0];
  expect(player?.status_points).toBe(baseline.statusPoints + (sums?.sp ?? NaN));
  expect(player?.miles).toBe(baseline.miles + (ledger?.miles ?? NaN));
  expect(player?.hints).toBe(ledger?.hints);
  expect(ledger?.awards).toBe(paying?.n);
  expect(ledger?.award_miles).toBe(sums?.miles);
}

/** Arrange a Miles balance the honest way: balance and ledger entry together, so the invariant still holds. */
async function grantMiles(principal: string, amount: number) {
  await sql.query("UPDATE players SET miles = miles + $1 WHERE id = $2", [amount, principal]);
  await sql.query(
    "INSERT INTO miles_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, $2, 'round_award', $3, now())",
    [principal, amount, `arranged-${randomUUID()}`],
  );
}

/** Arrange a hint balance (balance and ledger entry together). */
async function setHints(principal: string, target: number) {
  const current = (await sql.query("SELECT hints FROM players WHERE id = $1", [principal])).rows[0].hints as number;
  if (current === target) return;
  await sql.query("UPDATE players SET hints = $1 WHERE id = $2", [target, principal]);
  await sql.query(
    "INSERT INTO hint_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, $2, 'hint_pack', $3, now())",
    [principal, target - current, `arranged-${randomUUID()}`],
  );
}

describe("auth", () => {
  it("health is public", async () => {
    const response = await send("GET", "/v1/health", {});
    expect(response.status).toBe(200);
  });

  it("rejects requests without a token", async () => {
    const response = await send("PUT", "/v1/me", {});
    expect(response.status).toBe(401);
  });

  it("rejects a token for a different project", async () => {
    const response = await send("PUT", "/v1/me", {
      Authorization: `Bearer ${emulatorToken("x", "demo-other-project")}`,
    });
    expect(response.status).toBe(401);
  });
});

describe("player identity", () => {
  it("PUT /v1/me creates the player once, then returns it unchanged", async () => {
    const { principal, call } = newPlayer();
    const first = await call("PUT", "/v1/me");
    expect(first.status).toBe(201);
    expect((await json(first)).progress).toMatchObject({
      statusPoints: 0,
      miles: 0,
      certifiedRank: "trainee",
      activeRank: "trainee",
      pleasureCruise: false,
      selectableRanks: ["trainee"],
      nextRank: { rank: "first-officer", statusPoints: 10_000 },
    });
    expect((await call("PUT", "/v1/me")).status).toBe(200);
    const rows = (
      await sql.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM players WHERE id = $1", [principal])
    ).rows[0];
    expect(rows?.n).toBe(1);
  });

  it("progress needs a registered player", async () => {
    const { call } = newPlayer();
    expect((await call("GET", "/v1/me/progress")).status).toBe(404);
  });
});

describe("account deletion", () => {
  const countRows = async (table: "players" | "rounds", column: "id" | "player_id", principal: string) =>
    (await sql.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} = $1`, [principal])).rows[0]
      .n as number;

  it("DELETE /v1/me removes the player and cascades its rounds, leaving others untouched", async () => {
    const doomed = newPlayer();
    const other = newPlayer();
    await doomed.call("PUT", "/v1/me");
    await other.call("PUT", "/v1/me");
    await playRound(doomed);
    await startRound(doomed.call);
    await playRound(other);
    expect(await countRows("rounds", "player_id", doomed.principal)).toBe(2);

    const response = await doomed.call("DELETE", "/v1/me");
    expect(response.status).toBe(204);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect((await doomed.call("GET", "/v1/me/progress")).status).toBe(404);
    expect(await countRows("players", "id", doomed.principal)).toBe(0);
    expect(await countRows("rounds", "player_id", doomed.principal)).toBe(0);

    expect(await countRows("rounds", "player_id", other.principal)).toBe(1);
    expect((await other.call("GET", "/v1/me/progress")).body.progress.statusPoints).toBe(70);
    await expectLedgerBalanced(other.principal);
  });

  it("is 204 when no player exists, and again when repeated", async () => {
    const never = newPlayer();
    expect((await never.call("DELETE", "/v1/me")).status).toBe(204);
    const twice = newPlayer();
    await twice.call("PUT", "/v1/me");
    expect((await twice.call("DELETE", "/v1/me")).status).toBe(204);
    expect((await twice.call("DELETE", "/v1/me")).status).toBe(204);
  });

  it("a fresh PUT /v1/me after deletion creates a new player at zero", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await playRound(player);
    await player.call("DELETE", "/v1/me");
    const again = await player.call("PUT", "/v1/me");
    expect(again.status).toBe(201);
    expect(again.body.progress).toMatchObject({ statusPoints: 0, miles: 0, perfectStreak: 0 });
  });

  it("a round and a result submitted after deletion are clean 404s", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    const roundId = await startRound(player.call);
    await backdate(player.principal);
    await player.call("DELETE", "/v1/me");
    const result = await player.call("POST", `/v1/rounds/${roundId}/result`, PERFECT_FAST);
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("round_not_found");
    const issue = await player.call("POST", "/v1/rounds", { tripId: randomUUID() });
    expect(issue.status).toBe(404);
    expect(issue.body.error.code).toBe("player_not_found");
  });
});

describe("rounds", () => {
  it("a perfect fast round banks 70 SP and 70 Miles", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    const response = await playRound(player);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.award).toMatchObject({ completion: "perfect", speedBonus: true, statusPoints: 70, miles: 70 });
    expect(body.progress).toMatchObject({ statusPoints: 70, miles: 70, perfectStreak: 1 });
    await expectLedgerBalanced(player.principal);
  });

  it("the server, not the client, applies the perfect streak", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await playRound(player);
    const second = await json(await playRound(player));
    expect(second.award).toMatchObject({ streakMiles: 5, miles: 75, statusPoints: 70 });
    const broken = await json(
      // attempts: 3 = the two misses plus the right answer (A4: attempts >= errorCount).
      await playRound(player, { finished: true, errorCount: 2, usedHint: false, timeRemainingFraction: 0.1, attempts: 3 }),
    );
    expect(broken.progress.perfectStreak).toBe(0);
    await expectLedgerBalanced(player.principal);
  });

  it("an unfinished round pays nothing", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    const body = await json(
      await playRound(player, { finished: false, errorCount: 0, usedHint: false, timeRemainingFraction: 0 }),
    );
    expect(body.award).toMatchObject({ completion: "unfinished", statusPoints: 0, miles: 0 });
    await expectLedgerBalanced(player.principal);
  });

  it("resubmitting a result replays the stored award without paying twice", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const roundId = await startRound(call, "code-search");
    await backdate(principal);
    const path = `/v1/rounds/${roundId}/result`;
    await call("POST", path, PERFECT_FAST);
    const replay = await json(await call("POST", path, { ...PERFECT_FAST, timeRemainingFraction: 0 }));
    expect(replay.replayed).toBe(true);
    expect(replay.award.statusPoints).toBe(70);
    expect(replay.progress.statusPoints).toBe(70);
    await expectLedgerBalanced(principal);
  });

  it("the same round submitted three times at once banks exactly once", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const roundId = await startRound(call);
    await backdate(principal);
    const responses = await Promise.all(
      [0, 1, 2].map(() => call("POST", `/v1/rounds/${roundId}/result`, PERFECT_FAST)),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    const bodies = await Promise.all(responses.map(json));
    expect(bodies.filter((b) => b.replayed === false)).toHaveLength(1);
    expect(bodies.filter((b) => b.replayed === true)).toHaveLength(2);
    const progress = (await json(await call("GET", "/v1/me/progress"))).progress;
    expect(progress.statusPoints).toBe(70);
    await expectLedgerBalanced(principal);
  });

  it("starting a round abandons the previous open one", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const first = await startRound(call);
    const second = await startRound(call);
    await backdate(principal);
    const stale = await call("POST", `/v1/rounds/${first}/result`, PERFECT_FAST);
    expect(stale.status).toBe(410);
    expect((await json(stale)).error.code).toBe("round_closed");
    const fresh = await call("POST", `/v1/rounds/${second}/result`, PERFECT_FAST);
    expect(fresh.status).toBe(200);
    expect((await json(fresh)).progress.statusPoints).toBe(70);
    await expectLedgerBalanced(principal);
  });

  it("a completed round can still be replayed after a newer round supersedes it", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const first = await startRound(call);
    await backdate(principal);
    await call("POST", `/v1/rounds/${first}/result`, PERFECT_FAST);
    await startRound(call);
    const replay = await call("POST", `/v1/rounds/${first}/result`, PERFECT_FAST);
    expect(replay.status).toBe(200);
    expect(await json(replay)).toMatchObject({ replayed: true, award: { statusPoints: 70 } });
    await expectLedgerBalanced(principal);
  });

  it("a result that arrives too fast is refused, leaves the round open, and succeeds later", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const roundId = await startRound(call);
    const early = await call("POST", `/v1/rounds/${roundId}/result`, PERFECT_FAST);
    expect(early.status).toBe(429);
    expect((await json(early)).error.code).toBe("round_too_fast");
    const row = (
      await sql.query<{ status: string }>("SELECT status FROM rounds WHERE id = $1", [roundId])
    ).rows[0];
    expect(row?.status).toBe("open");
    await backdate(principal);
    expect((await call("POST", `/v1/rounds/${roundId}/result`, PERFECT_FAST)).status).toBe(200);
    await expectLedgerBalanced(principal);
  });

  it("First Class multiplies a perfect fast round to 105 SP and 105 Miles", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await sql.query("UPDATE players SET first_class_until = $1 WHERE id = $2", [
      new Date(Date.now() + 3_600_000),
      player.principal,
    ]);
    const body = await json(await playRound(player));
    expect(body.award).toMatchObject({ firstClassPass: true, statusPoints: 105, miles: 105 });
    await expectLedgerBalanced(player.principal);
  });

  it("another player's round is not found", async () => {
    const owner = newPlayer();
    const intruder = newPlayer();
    await owner.call("PUT", "/v1/me");
    await intruder.call("PUT", "/v1/me");
    const roundId = await startRound(owner.call);
    const response = await intruder.call("POST", `/v1/rounds/${roundId}/result`, {
      ...PERFECT_FAST,
      timeRemainingFraction: 1,
    });
    expect(response.status).toBe(404);
  });

  it("an expired round is refused", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const roundId = await startRound(call);
    // Both timestamps move into the past: the schema requires expires_at > issued_at.
    await sql.query("UPDATE rounds SET issued_at = $1, expires_at = $2 WHERE id = $3 AND player_id = $4", [
      new Date(Date.UTC(1999, 0, 1)),
      new Date(Date.UTC(2000, 0, 1)),
      roundId,
      principal,
    ]);
    const response = await call("POST", `/v1/rounds/${roundId}/result`, PERFECT_FAST);
    expect(response.status).toBe(410);
    expect((await json(response)).error.code).toBe("round_expired");
  });

  it("returns the expiry as an ISO string", async () => {
    const { call } = newPlayer();
    await call("PUT", "/v1/me");
    const started = await json(await call("POST", "/v1/rounds", { tripId: await openSegment(call) }));
    expect(new Date(started.round.expiresAt).toISOString()).toBe(started.round.expiresAt);
  });

  it("issues and banks a Round for every Unity ModuleRegistry BackendId", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await ensureMilitaryItem(sql);
    for (const module of MODULE_IDS) {
      const roundId = await startRound(player.call, module);
      await backdate(player.principal);
      const facts = { ...PERFECT_FAST, ...factsFor(module) };
      expect((await player.call("POST", `/v1/rounds/${roundId}/result`, facts)).status, module).toBe(200);
    }
  });

  it("rejects unknown modules and client-supplied economy fields", async () => {
    const { call } = newPlayer();
    await call("PUT", "/v1/me");
    // T2: the module is chosen when the Flight Segment opens (POST /v1/trips); a Round only names its segment.
    const open = (module: string) => call("POST", "/v1/trips", openBody(module), { "Idempotency-Key": newKey() });
    expect((await open("space-invaders")).status).toBe(400);
    // The pre-split Military id; Unity sends aircraft-identifier-military.
    expect((await open("military-identifier")).status).toBe(400);
    expect((await call("POST", "/v1/rounds", { module: "atc-match" })).status).toBe(400);
    const roundId = await startRound(call);
    const response = await call("POST", `/v1/rounds/${roundId}/result`, {
      ...PERFECT_FAST,
      timeRemainingFraction: 1,
      perfectStreak: 99,
    });
    expect(response.status).toBe(400);
  });
});

describe("active rank and pleasure cruise", () => {
  async function promotedPlayer(statusPoints: number) {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await sql.query("UPDATE players SET status_points = $1 WHERE id = $2", [statusPoints, player.principal]);
    return player;
  }

  it("cannot dial above certified rank", async () => {
    const { call } = newPlayer();
    await call("PUT", "/v1/me");
    expect((await call("PUT", "/v1/me/active-rank", { rank: "captain" })).status).toBe(403);
  });

  it("dialling down enters a pleasure cruise and caps the round payout", async () => {
    const player = await promotedPlayer(60_000);
    const { call } = player;
    const dialled = await json(await call("PUT", "/v1/me/active-rank", { rank: "trainee" }));
    expect(dialled.progress).toMatchObject({
      certifiedRank: "captain",
      activeRank: "trainee",
      pleasureCruise: true,
      selectableRanks: ["captain", "first-officer", "trainee"],
    });
    const body = await json(await playRound(player));
    expect(body.award).toMatchObject({ pleasureCruise: true, statusPoints: 10, miles: 10 });
    await expectLedgerBalanced(player.principal, { statusPoints: 60_000, miles: 0 });
  });

  it("choosing certified rank again ends the cruise and follows future promotions", async () => {
    const { principal, call } = await promotedPlayer(60_000);
    await call("PUT", "/v1/me/active-rank", { rank: "trainee" });
    await call("PUT", "/v1/me/active-rank", { rank: "captain" });
    await sql.query("UPDATE players SET status_points = $1 WHERE id = $2", [100_000, principal]);
    const progress = (await json(await call("GET", "/v1/me/progress"))).progress;
    expect(progress).toMatchObject({ certifiedRank: "check-airman", activeRank: "check-airman", pleasureCruise: false });
  });

  it("a round that crosses a threshold reports the promotion", async () => {
    const player = await promotedPlayer(9_990);
    const body = await json(await playRound(player));
    expect(body.promotion).toEqual({ from: "trainee", to: "first-officer" });
    expect(body.progress.certifiedRank).toBe("first-officer");
    await expectLedgerBalanced(player.principal, { statusPoints: 9_990, miles: 0 });
  });

  it("replaying a promoting round reports the same promotion", async () => {
    const { principal, call } = await promotedPlayer(9_990);
    const roundId = await startRound(call);
    await backdate(principal);
    const path = `/v1/rounds/${roundId}/result`;
    const first = await json(await call("POST", path, PERFECT_FAST));
    const replay = await json(await call("POST", path, PERFECT_FAST));
    expect(replay.replayed).toBe(true);
    expect(replay.promotion).toEqual(first.promotion);
    expect(replay.promotion).toEqual({ from: "trainee", to: "first-officer" });
  });

  it("progress carries version; an Active Rank change bumps it, the same value again does not (D-1)", async () => {
    const { principal, call } = await promotedPlayer(60_000);
    expect((await json(await call("GET", "/v1/me/progress"))).progress.version).toBe(1);
    const dialled = await json(await call("PUT", "/v1/me/active-rank", { rank: "trainee" }));
    expect(dialled.progress.version).toBe(2);
    const same = await json(await call("PUT", "/v1/me/active-rank", { rank: "trainee" }));
    expect(same.progress.version).toBe(2);
    expect(await versionOf(principal)).toBe(2);
  });

  it("dialling the active rank does not disturb an in-flight round", async () => {
    const { principal, call } = await promotedPlayer(60_000);
    const roundId = await startRound(call);
    await backdate(principal);
    await call("PUT", "/v1/me/active-rank", { rank: "trainee" });
    const body = await json(await call("POST", `/v1/rounds/${roundId}/result`, PERFECT_FAST));
    // Scored at the rank snapshotted at issue (Captain, no cruise), not the new Active Rank.
    expect(body.award).toMatchObject({ pleasureCruise: false, statusPoints: 70 });
  });
});

describe("request ids, errors and routing", () => {
  const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("error bodies carry a requestId that matches the echoed X-Request-Id header", async () => {
    const response = await send("PUT", "/v1/me", {});
    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ code: "unauthorized" });
    expect(response.body.error.requestId).toMatch(ID_PATTERN);
    expect(response.headers["x-request-id"]).toBe(response.body.error.requestId);
  });

  it("honours a well-formed incoming X-Request-Id and replaces a malformed one", async () => {
    const honoured = await send("PUT", "/v1/me", { "X-Request-Id": "client-req-12345" });
    expect(honoured.headers["x-request-id"]).toBe("client-req-12345");
    expect(honoured.body.error.requestId).toBe("client-req-12345");

    const replaced = await send("GET", "/v1/health", { "X-Request-Id": "bad id!" });
    expect(replaced.headers["x-request-id"]).toMatch(ID_PATTERN);
  });

  it("malformed JSON is 400 invalid_request in the standard error shape", async () => {
    const { uid } = newPlayer();
    const response = await request(server)
      .put("/v1/me/active-rank")
      .set("Authorization", `Bearer ${emulatorToken(uid)}`)
      .set("Content-Type", "application/json")
      .send("{ not json");
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: "invalid_request" });
    expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
  });

  it("an unknown route is 404 not_found", async () => {
    const { call } = newPlayer();
    const response = await call("GET", "/v1/nope");
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: "not_found" });
    expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
  });
});

describe("request hardening", () => {
  it("sends no X-Powered-By and marks /v1 responses no-store, except health", async () => {
    const { call } = newPlayer();
    const me = await call("PUT", "/v1/me");
    expect(me.headers["x-powered-by"]).toBeUndefined();
    expect(me.headers["cache-control"]).toBe("no-store");
    const unauthorized = await send("GET", "/v1/me/progress", {});
    expect(unauthorized.headers["cache-control"]).toBe("no-store");
    const health = await send("GET", "/v1/health", {});
    expect(health.headers["x-powered-by"]).toBeUndefined();
    expect(health.headers["cache-control"]).toBeUndefined();
  });

  it("rejects a body over 16 KB as 413 invalid_request", async () => {
    const { uid } = newPlayer();
    const response = await request(server)
      .put("/v1/me/active-rank")
      .set("Authorization", `Bearer ${emulatorToken(uid)}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ rank: "x".repeat(17 * 1024) }));
    expect(response.status).toBe(413);
    expect(response.body.error).toMatchObject({ code: "invalid_request", message: "Request could not be read." });
    expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
  });

  it("rejects an unsupported charset as 415 invalid_request", async () => {
    const response = await request(server)
      .put("/v1/me/active-rank")
      .set("Content-Type", "application/json; charset=latin1")
      .send('{"rank":"trainee"}');
    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe("invalid_request");
  });

  it("rejects an unsupported Content-Encoding as 415 invalid_request", async () => {
    const response = await request(server)
      .put("/v1/me/active-rank")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "compress")
      .send('{"rank":"trainee"}');
    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe("invalid_request");
  });

  it("does not accept urlencoded bodies", async () => {
    const { uid } = newPlayer();
    const response = await request(server)
      .put("/v1/me/active-rank")
      .set("Authorization", `Bearer ${emulatorToken(uid)}`)
      .type("form")
      .send("rank=trainee");
    expect([400, 415]).toContain(response.status);
    expect(response.body.error.code).toBe("invalid_request");
  });

  it("a non-UUID round id is 404 round_not_found", async () => {
    const { call } = newPlayer();
    await call("PUT", "/v1/me");
    const response = await call("POST", "/v1/rounds/not-a-uuid/result", PERFECT_FAST);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("round_not_found");
  });
});

describe("authorization header and global guard", () => {
  it("accepts the Bearer scheme case-insensitively", async () => {
    const { uid } = newPlayer();
    const response = await send("PUT", "/v1/me", { Authorization: `bearer ${emulatorToken(uid)}` });
    expect(response.status).toBe(201);
  });

  it.each([["Bearer"], ["Bearer  x"], ["Basic x"], ["Bearer a b"]])(
    "rejects Authorization: %s with 401 and WWW-Authenticate",
    async (header) => {
      const response = await send("PUT", "/v1/me", { Authorization: header });
      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toBe("Bearer");
      expect(response.body.error.code).toBe("unauthorized");
    },
  );

  it("every route except the health routes returns 401 without a token", async () => {
    const router = (app.getHttpAdapter().getInstance() as any).router;
    const routes: { method: string; path: string }[] = [];
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ method: method.toUpperCase(), path: String(layer.route.path) });
      }
    }
    // Guard against the enumeration silently finding nothing: 16 guarded routes (incl. 4 admin, 3 trips) plus two health routes.
    expect(routes.length).toBe(18);
    for (const { method, path } of routes) {
      const concrete = path.replace(":roundId", randomUUID()).replace(":tripId", randomUUID()).replace(":module", "aircraft-identifier-military");
      const response = await send(method, concrete, {});
      const expected = path.startsWith("/v1/health") ? 200 : 401;
      expect(response.status, `${method} ${path}`).toBe(expected);
    }
  });
});

describe("schema constraints", () => {
  it("the database refuses a second open round for one player", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    await startRound(call);
    const now = new Date();
    await expect(
      sql.query(
        `INSERT INTO rounds (id, player_id, module, rank, pleasure_cruise, status, issued_at, expires_at)
         VALUES ($1, $2, 'atc-match', 'trainee', false, 'open', $3, $4)`,
        [randomUUID(), principal, now, new Date(now.getTime() + 60_000)],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "rounds_one_open_per_player" });
  });

  it("the database refuses out-of-range round and player values", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const roundId = await startRound(call);
    await expect(sql.query("UPDATE rounds SET time_remaining = 2 WHERE id = $1", [roundId])).rejects.toMatchObject({
      code: "23514",
    });
    await expect(sql.query("UPDATE rounds SET error_count = -1 WHERE id = $1", [roundId])).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      sql.query("UPDATE rounds SET expires_at = issued_at WHERE id = $1", [roundId]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(sql.query("UPDATE players SET version = 0 WHERE id = $1", [principal])).rejects.toMatchObject({
      code: "23514",
    });
  });
});

describe("player row lock and concurrency", () => {
  const SETTLE_MS = 300;
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

  /** Hold the player's row lock on a separate connection, as a concurrent writer would. */
  async function lockPlayer(principal: string) {
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM players WHERE id = $1 FOR UPDATE", [principal]);
    return {
      release: async () => {
        await holder.query("COMMIT");
        await holder.end();
      },
    };
  }

  it("a result waits for the player row lock, then banks", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const roundId = await startRound(call);
    await backdate(principal);
    const lock = await lockPlayer(principal);
    let settled = false;
    const pending = call("POST", `/v1/rounds/${roundId}/result`, PERFECT_FAST).finally(() => (settled = true));
    await sleep(SETTLE_MS);
    expect(settled).toBe(false);
    await lock.release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body.progress.statusPoints).toBe(70);
    await expectLedgerBalanced(principal);
  });

  it("issuing a round waits for the player row lock, then succeeds", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const tripId = await openSegment(call);
    const lock = await lockPlayer(principal);
    let settled = false;
    const pending = call("POST", "/v1/rounds", { tripId }).finally(() => (settled = true));
    await sleep(SETTLE_MS);
    expect(settled).toBe(false);
    await lock.release();
    expect((await pending).status).toBe(201);
  });

  it("account deletion waits for the player row lock, and the late result is then a clean 404", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const roundId = await startRound(call);
    await backdate(principal);
    const lock = await lockPlayer(principal);
    let settled = false;
    const pending = call("DELETE", "/v1/me").finally(() => (settled = true));
    await sleep(SETTLE_MS);
    expect(settled).toBe(false);
    await lock.release();
    expect((await pending).status).toBe(204);
    const late = await call("POST", `/v1/rounds/${roundId}/result`, PERFECT_FAST);
    expect(late.status).toBe(404);
    expect(late.body.error.code).toBe("round_not_found");
  });

  it("an Active Rank change queued behind an account deletion is 404 player_not_found", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const lock = await lockPlayer(principal);
    const deletion = call("DELETE", "/v1/me");
    await sleep(SETTLE_MS);
    const dial = call("PUT", "/v1/me/active-rank", { rank: "trainee" });
    await sleep(SETTLE_MS);
    await lock.release();
    expect((await deletion).status).toBe(204);
    const response = await dial;
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("player_not_found");
  });

  it("six concurrent PUT /v1/me create the player exactly once", async () => {
    const { principal, call } = newPlayer();
    const responses = await Promise.all(Array.from({ length: 6 }, () => call("PUT", "/v1/me")));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    const count = (await sql.query("SELECT COUNT(*)::int AS n FROM players WHERE id = $1", [principal])).rows[0];
    expect(count.n).toBe(1);
  });

  it("a completed Round bumps the version once even when it pays nothing (an unfinished Round)", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const roundId = await startRound(call);
    await backdate(principal);
    const before = await versionOf(principal);
    const response = await call("POST", `/v1/rounds/${roundId}/result`, { ...PERFECT_FAST, finished: false });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.award).toMatchObject({ statusPoints: 0, miles: 0 });
    expect(await versionOf(principal)).toBe(before + 1);
    expect(body.progress.version).toBe(before + 1);
  });

  it("a storm of interleaved issue and result calls keeps the ledger and one-open-round invariants", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const first = await startRound(call);
    await backdate(principal);
    const results = Array.from({ length: 4 }, () => call("POST", `/v1/rounds/${first}/result`, PERFECT_FAST));
    const tripId = segmentOf.get(call)?.id;
    const issues = Array.from({ length: 4 }, () => call("POST", "/v1/rounds", { tripId }));
    const [resultReplies, issueReplies] = await Promise.all([Promise.all(results), Promise.all(issues)]);
    // Banked (200) if the result won the lock, closed (410) if an issue superseded the Round first.
    for (const response of resultReplies) expect([200, 410]).toContain(response.status);
    for (const response of issueReplies) expect(response.status).toBe(201);
    const open = (
      await sql.query("SELECT COUNT(*)::int AS n FROM rounds WHERE player_id = $1 AND status = 'open'", [principal])
    ).rows[0];
    expect(open.n).toBe(1);
    const completed = (
      await sql.query("SELECT COUNT(*)::int AS n FROM rounds WHERE player_id = $1 AND status = 'completed'", [
        principal,
      ])
    ).rows[0];
    const player = (await sql.query("SELECT version FROM players WHERE id = $1", [principal])).rows[0];
    expect(player.version).toBe(1 + completed.n);
    await expectLedgerBalanced(principal);
  });

  it("a database failure is a generic 500 internal_error with no SQL, and the player is not stuck", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const roundId = await startRound(call);
    await backdate(principal);
    // The credit would overflow the integer column: a real driver error inside the transaction.
    await sql.query("UPDATE players SET status_points = 2147483647 WHERE id = $1", [principal]);
    const response = await call("POST", `/v1/rounds/${roundId}/result`, PERFECT_FAST);
    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({ code: "internal_error", message: "Something went wrong." });
    const text = JSON.stringify(response.body).toLowerCase();
    for (const leak of ["update", "players", "select", "status_points", "2147483647", "$1"]) {
      expect(text).not.toContain(leak);
    }
    // Rolled back: the Round is still open, and the player's row is unlocked and readable.
    const row = (await sql.query("SELECT status FROM rounds WHERE id = $1", [roundId])).rows[0];
    expect(row.status).toBe("open");
    expect((await call("GET", "/v1/me/progress")).status).toBe(200);
  });
});

const HINT_PACK_KEY = () => `key-${randomUUID()}`;

/** Rows of one ledger for a principal, oldest first, optionally one kind. */
async function ledgerRows(table: "miles_ledger" | "hint_ledger", principal: string, kind?: string) {
  const result = await sql.query(
    `SELECT delta, kind, ref FROM ${table} WHERE player_id = $1 ${kind ? "AND kind = $2" : ""} ORDER BY id`,
    kind ? [principal, kind] : [principal],
  );
  return result.rows as { delta: number; kind: string; ref: string }[];
}

async function versionOf(principal: string): Promise<number> {
  return (await sql.query("SELECT version FROM players WHERE id = $1", [principal])).rows[0].version;
}

describe("miles ledger", () => {
  it("a paying Round writes one round_award entry with the Round id, and a replay writes no second", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const roundId = await startRound(call);
    await backdate(principal);
    await call("POST", `/v1/rounds/${roundId}/result`, PERFECT_FAST);
    await call("POST", `/v1/rounds/${roundId}/result`, PERFECT_FAST);
    expect(await ledgerRows("miles_ledger", principal)).toEqual([{ delta: 70, kind: "round_award", ref: roundId }]);
    await expectLedgerBalanced(principal);
  });

  it("an unfinished Round pays no Miles and writes no entry", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await playRound(player, { finished: false, errorCount: 0, usedHint: false, timeRemainingFraction: 0 });
    expect(await ledgerRows("miles_ledger", player.principal)).toEqual([]);
    await expectLedgerBalanced(player.principal);
  });

  it("the database refuses a zero delta, an unknown kind and a duplicate idempotency key", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const insert = (delta: number, kind: string, ref: string) =>
      sql.query(
        "INSERT INTO miles_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, $2, $3, $4, now())",
        [principal, delta, kind, ref],
      );
    await expect(insert(0, "round_award", "a")).rejects.toThrow();
    await expect(insert(5, "bonus", "a")).rejects.toThrow();
    await insert(5, "round_award", "a");
    await expect(insert(5, "round_award", "a")).rejects.toThrow();
    // The key is per kind: the same ref under another kind is a different entry.
    await insert(5, "hint_pack", "a");
  });
});

describe("hints", () => {
  const spend = (roundId: string) => `/v1/rounds/${roundId}/hint`;

  it("a new player starts with 5 hints and one starter ledger entry, and signing in again adds none", async () => {
    const { principal, call } = newPlayer();
    const created = await call("PUT", "/v1/me");
    expect(created.status).toBe(201);
    expect(created.body.progress.hints).toBe(5);
    await call("PUT", "/v1/me");
    expect((await call("GET", "/v1/me/progress")).body.progress.hints).toBe(5);
    expect(await ledgerRows("hint_ledger", principal)).toEqual([{ delta: 5, kind: "starter", ref: "starter" }]);
    await expectLedgerBalanced(principal);
  });

  it("a hint request with a body field is 400 and spends nothing", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    const roundId = await startRound(player.call);
    const response = await player.call("POST", spend(roundId), { anything: 1 });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
    expect((await player.call("POST", spend(roundId), {})).status).toBe(200);
    expect((await player.call("GET", "/v1/me/progress")).body.progress.hints).toBe(4);
  });

  // Full erasure keeps no record of the starter grant, so a new account gets it again. Open for Josh.
  it("ASSUMPTION: deleting the account and signing up again re-grants the starter hints", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await player.call("POST", spend(await startRound(player.call)));
    await player.call("DELETE", "/v1/me");
    expect((await player.call("PUT", "/v1/me")).body.progress.hints).toBe(5);
    await expectLedgerBalanced(player.principal);
  });

  it("six concurrent sign-ins write the starter entry exactly once", async () => {
    const { principal, call } = newPlayer();
    await Promise.all(Array.from({ length: 6 }, () => call("PUT", "/v1/me")));
    expect(await ledgerRows("hint_ledger", principal)).toHaveLength(1);
    await expectLedgerBalanced(principal);
  });

  it("spending debits once, and a repeat is a 200 replay with no second debit", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const roundId = await startRound(call);
    const versionBefore = await versionOf(principal);

    const first = await call("POST", spend(roundId));
    expect(first.status).toBe(200);
    expect(first.body.hint).toEqual({ roundId, replayed: false });
    expect(first.body.progress.hints).toBe(4);

    const again = await call("POST", spend(roundId));
    expect(again.status).toBe(200);
    expect(again.body.hint).toEqual({ roundId, replayed: true });
    expect(again.body.progress.hints).toBe(4);

    expect(await ledgerRows("hint_ledger", principal, "round_spend")).toEqual([
      { delta: -1, kind: "round_spend", ref: roundId },
    ]);
    expect(await versionOf(principal)).toBe(versionBefore + 1);
    const row = (await sql.query("SELECT hint_used FROM rounds WHERE id = $1", [roundId])).rows[0];
    expect(row.hint_used).toBe(true);
    await expectLedgerBalanced(principal);
  });

  it("three concurrent spends on one Round debit exactly once", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const roundId = await startRound(call);
    const responses = await Promise.all([0, 1, 2].map(() => call("POST", spend(roundId))));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(responses.filter((r) => r.body.hint.replayed === false)).toHaveLength(1);
    expect(responses.filter((r) => r.body.hint.replayed === true)).toHaveLength(2);
    expect((await call("GET", "/v1/me/progress")).body.progress.hints).toBe(4);
    await expectLedgerBalanced(principal);
  });

  it("with no hints left it is 409 insufficient_hints and changes nothing; a Round that has its hint still replays", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    await setHints(principal, 0);
    const roundId = await startRound(call);
    const versionBefore = await versionOf(principal);
    const refused = await call("POST", spend(roundId));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("insufficient_hints");
    const row = (await sql.query("SELECT hint_used FROM rounds WHERE id = $1", [roundId])).rows[0];
    expect(row.hint_used).toBe(false);
    expect(await ledgerRows("hint_ledger", principal, "round_spend")).toEqual([]);
    expect(await versionOf(principal)).toBe(versionBefore);

    // Spend the last hint: the balance is 0 again, yet the same Round still answers its replay.
    await setHints(principal, 1);
    expect((await call("POST", spend(roundId))).body.progress.hints).toBe(0);
    const replay = await call("POST", spend(roundId));
    expect(replay.status).toBe(200);
    expect(replay.body.hint.replayed).toBe(true);
    await expectLedgerBalanced(principal);
  });

  it("the database refuses a negative hint balance", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    await expect(sql.query("UPDATE players SET hints = -1 WHERE id = $1", [principal])).rejects.toThrow();
  });

  it("an expired Round is 410 round_expired and keeps its hint", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const roundId = await startRound(call);
    await sql.query("UPDATE rounds SET issued_at = $1, expires_at = $2 WHERE id = $3", [
      new Date(Date.UTC(1999, 0, 1)),
      new Date(Date.UTC(2000, 0, 1)),
      roundId,
    ]);
    const response = await call("POST", spend(roundId));
    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe("round_expired");
    expect((await call("GET", "/v1/me/progress")).body.progress.hints).toBe(5);
    await expectLedgerBalanced(principal);
  });

  it("a superseded or already banked Round is 410 round_closed and keeps its hint", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const superseded = await startRound(call);
    const banked = await startRound(call);
    const stale = await call("POST", spend(superseded));
    expect(stale.status).toBe(410);
    expect(stale.body.error.code).toBe("round_closed");

    await backdate(principal);
    await call("POST", `/v1/rounds/${banked}/result`, PERFECT_FAST);
    const late = await call("POST", spend(banked));
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe("round_closed");
    expect((await call("GET", "/v1/me/progress")).body.progress.hints).toBe(5);
    await expectLedgerBalanced(principal);
  });

  it("another player's Round, an unknown Round and a non-UUID id are 404 round_not_found", async () => {
    const owner = newPlayer();
    const intruder = newPlayer();
    await owner.call("PUT", "/v1/me");
    await intruder.call("PUT", "/v1/me");
    const roundId = await startRound(owner.call);
    for (const id of [roundId, randomUUID(), "not-a-uuid"]) {
      const response = await intruder.call("POST", spend(id));
      expect(response.status, id).toBe(404);
      expect(response.body.error.code).toBe("round_not_found");
    }
    expect((await owner.call("GET", "/v1/me/progress")).body.progress.hints).toBe(5);
    expect((await intruder.call("GET", "/v1/me/progress")).body.progress.hints).toBe(5);
  });

  it("a player who was never registered gets 404 round_not_found", async () => {
    const response = await newPlayer().call("POST", spend(randomUUID()));
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("round_not_found");
  });

  it("a paid hint forces a Standard award and breaks the streak even if the client says usedHint false", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    expect((await json(await playRound(player))).progress.perfectStreak).toBe(1);

    const roundId = await startRound(player.call);
    await player.call("POST", spend(roundId));
    await backdate(player.principal);
    const body = await json(await player.call("POST", `/v1/rounds/${roundId}/result`, PERFECT_FAST));
    // Standard 30 + speed 20 = 50 SP; Miles also carry the streak-1 bonus of 5.
    expect(body.award).toMatchObject({ completion: "standard", statusPoints: 50, miles: 55 });
    expect(body.progress.perfectStreak).toBe(0);
    const row = (await sql.query("SELECT used_hint FROM rounds WHERE id = $1", [roundId])).rows[0];
    expect(row.used_hint).toBe(true);
    await expectLedgerBalanced(player.principal);
  });

  it("claiming an unpaid hint only lowers the player's own award and costs no hint", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    const body = await json(await playRound(player, { ...PERFECT_FAST, usedHint: true }));
    expect(body.award).toMatchObject({ completion: "standard", statusPoints: 50, miles: 50 });
    expect(body.progress.hints).toBe(5);
    expect(await ledgerRows("hint_ledger", player.principal, "round_spend")).toEqual([]);
    await expectLedgerBalanced(player.principal);
  });

  it("a Round that paid for its hint and also reports one is a Standard award", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    const roundId = await startRound(player.call);
    await player.call("POST", spend(roundId));
    await backdate(player.principal);
    const body = await json(
      await player.call("POST", `/v1/rounds/${roundId}/result`, { ...PERFECT_FAST, usedHint: true }),
    );
    expect(body.award.completion).toBe("standard");
    await expectLedgerBalanced(player.principal);
  });

  it("a hint can still be replayed after the Round is banked", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    const roundId = await startRound(player.call);
    await player.call("POST", spend(roundId));
    await backdate(player.principal);
    await player.call("POST", `/v1/rounds/${roundId}/result`, PERFECT_FAST);
    const replay = await player.call("POST", spend(roundId));
    expect(replay.status).toBe(200);
    expect(replay.body.hint.replayed).toBe(true);
    expect(replay.body.progress.hints).toBe(4);
    await expectLedgerBalanced(player.principal);
  });
});

describe("miles hint pack", () => {
  const PACK = "/v1/shop/miles-hint-pack";
  const buy = (player: ReturnType<typeof newPlayer>, key: string | undefined, body?: unknown) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${emulatorToken(player.uid)}` };
    if (key !== undefined) headers["Idempotency-Key"] = key;
    return send("POST", PACK, headers, body);
  };

  it("below 5,000 Miles it is 409 insufficient_miles and changes nothing", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await grantMiles(player.principal, 4999);
    const versionBefore = await versionOf(player.principal);
    const response = await buy(player, HINT_PACK_KEY());
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("insufficient_miles");
    const row = (await sql.query("SELECT miles, hints, version FROM players WHERE id = $1", [player.principal]))
      .rows[0];
    expect(row).toEqual({ miles: 4999, hints: 5, version: versionBefore });
    expect(await ledgerRows("miles_ledger", player.principal, "hint_pack")).toEqual([]);
    expect(await ledgerRows("hint_ledger", player.principal, "hint_pack")).toEqual([]);
    await expectLedgerBalanced(player.principal);
  });

  it("with 5,000 Miles it moves 5,000 Miles into 10 hints, and the same key still answers at 0 Miles", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await grantMiles(player.principal, 5000);
    const key = HINT_PACK_KEY();
    const versionBefore = await versionOf(player.principal);

    const bought = await buy(player, key);
    expect(bought.status).toBe(200);
    expect(bought.body.purchase).toEqual({ hints: 10, priceMiles: 5000, replayed: false });
    expect(bought.body.progress).toMatchObject({ miles: 0, hints: 15 });
    expect(await ledgerRows("miles_ledger", player.principal, "hint_pack")).toEqual([
      { delta: -5000, kind: "hint_pack", ref: key },
    ]);
    expect(await ledgerRows("hint_ledger", player.principal, "hint_pack")).toEqual([
      { delta: 10, kind: "hint_pack", ref: key },
    ]);
    expect(await versionOf(player.principal)).toBe(versionBefore + 1);

    // Now at 0 Miles: the same key is still the original receipt, not a 409.
    const replay = await buy(player, key);
    expect(replay.status).toBe(200);
    expect(replay.body.purchase).toEqual({ hints: 10, priceMiles: 5000, replayed: true });
    expect(replay.body.progress).toMatchObject({ miles: 0, hints: 15 });
    await expectLedgerBalanced(player.principal);
  });

  it("the same key replays without a second debit", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await grantMiles(player.principal, 12_000);
    const key = HINT_PACK_KEY();
    await buy(player, key);
    const replay = await buy(player, key);
    expect(replay.body.purchase.replayed).toBe(true);
    expect(replay.body.progress).toMatchObject({ miles: 7000, hints: 15 });
    await expectLedgerBalanced(player.principal);
  });

  it("three concurrent requests with one key bank exactly once", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await grantMiles(player.principal, 12_000);
    const key = HINT_PACK_KEY();
    const responses = await Promise.all([0, 1, 2].map(() => buy(player, key)));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(responses.filter((r) => r.body.purchase.replayed === false)).toHaveLength(1);
    expect(responses.filter((r) => r.body.purchase.replayed === true)).toHaveLength(2);
    expect((await player.call("GET", "/v1/me/progress")).body.progress).toMatchObject({ miles: 7000, hints: 15 });
    await expectLedgerBalanced(player.principal);
  });

  it("different keys are different purchases", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await grantMiles(player.principal, 10_000);
    expect((await buy(player, HINT_PACK_KEY())).body.purchase.replayed).toBe(false);
    expect((await buy(player, HINT_PACK_KEY())).body.purchase.replayed).toBe(false);
    expect((await player.call("GET", "/v1/me/progress")).body.progress).toMatchObject({ miles: 0, hints: 25 });
    expect((await buy(player, HINT_PACK_KEY())).status).toBe(409);
    await expectLedgerBalanced(player.principal);
  });

  it("two players may use the same key independently", async () => {
    const a = newPlayer();
    const b = newPlayer();
    for (const p of [a, b]) {
      await p.call("PUT", "/v1/me");
      await grantMiles(p.principal, 5000);
    }
    const key = HINT_PACK_KEY();
    expect((await buy(a, key)).body.purchase.replayed).toBe(false);
    expect((await buy(b, key)).body.purchase.replayed).toBe(false);
    await expectLedgerBalanced(a.principal);
    await expectLedgerBalanced(b.principal);
  });

  it("bought hints can be spent on a Round", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await setHints(player.principal, 0);
    await grantMiles(player.principal, 5000);
    await buy(player, HINT_PACK_KEY());
    const roundId = await startRound(player.call);
    const spent = await player.call("POST", `/v1/rounds/${roundId}/hint`);
    expect(spent.body.progress).toMatchObject({ miles: 0, hints: 9 });
    await expectLedgerBalanced(player.principal);
  });

  it("a missing or malformed Idempotency-Key is 400 invalid_request and charges nothing", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await grantMiles(player.principal, 5000);
    for (const key of [undefined, "", "has space", "bad/key", "a".repeat(129)]) {
      const response = await buy(player, key);
      expect(response.status, String(key)).toBe(400);
      expect(response.body.error.code).toBe("invalid_request");
    }
    expect((await player.call("GET", "/v1/me/progress")).body.progress).toMatchObject({ miles: 5000, hints: 5 });
    // The longest allowed key works.
    expect((await buy(player, "a".repeat(128))).status).toBe(200);
    await expectLedgerBalanced(player.principal);
  });

  it("an extra body field is 400, while an empty object or no body is accepted", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await grantMiles(player.principal, 15_000);
    for (const body of [{ priceMiles: 1 }, { hints: 100 }, []]) {
      const response = await buy(player, HINT_PACK_KEY(), body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error.code).toBe("invalid_request");
    }
    expect((await buy(player, HINT_PACK_KEY(), {})).status).toBe(200);
    expect((await buy(player, HINT_PACK_KEY())).status).toBe(200);
    expect((await player.call("GET", "/v1/me/progress")).body.progress.miles).toBe(5000);
    await expectLedgerBalanced(player.principal);
  });

  it("an unregistered player gets 404 player_not_found", async () => {
    const response = await buy(newPlayer(), HINT_PACK_KEY());
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("player_not_found");
  });

  it("waits for the player row lock, then buys", async () => {
    const player = newPlayer();
    await player.call("PUT", "/v1/me");
    await grantMiles(player.principal, 5000);
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM players WHERE id = $1 FOR UPDATE", [player.principal]);
    let settled = false;
    const pending = buy(player, HINT_PACK_KEY()).finally(() => (settled = true));
    await new Promise((done) => setTimeout(done, 300));
    expect(settled).toBe(false);
    await holder.query("COMMIT");
    await holder.end();
    expect((await pending).status).toBe(200);
    await expectLedgerBalanced(player.principal);
  });
});

describe("ledgers and account deletion", () => {
  it("DELETE /v1/me cascades both ledgers and leaves other players' untouched", async () => {
    const doomed = newPlayer();
    const other = newPlayer();
    await doomed.call("PUT", "/v1/me");
    await other.call("PUT", "/v1/me");
    for (const p of [doomed, other]) {
      await playRound(p);
      const roundId = await startRound(p.call);
      await p.call("POST", `/v1/rounds/${roundId}/hint`);
    }
    expect(await ledgerRows("miles_ledger", doomed.principal)).toHaveLength(1);
    expect(await ledgerRows("hint_ledger", doomed.principal)).toHaveLength(2);

    expect((await doomed.call("DELETE", "/v1/me")).status).toBe(204);
    expect(await ledgerRows("miles_ledger", doomed.principal)).toEqual([]);
    expect(await ledgerRows("hint_ledger", doomed.principal)).toEqual([]);
    expect(await ledgerRows("miles_ledger", other.principal)).toHaveLength(1);
    expect(await ledgerRows("hint_ledger", other.principal)).toHaveLength(2);
    await expectLedgerBalanced(other.principal);

    // A fresh sign-in starts over: 5 starter hints, one starter entry, no old history.
    const again = await doomed.call("PUT", "/v1/me");
    expect(again.body.progress).toMatchObject({ miles: 0, hints: 5 });
    expect(await ledgerRows("hint_ledger", doomed.principal)).toEqual([{ delta: 5, kind: "starter", ref: "starter" }]);
  });
});
