import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { MIN_ROUND_MS } from "../src/rounds/rounds.service.js";
import { emulatorToken } from "./tokens.js";

const PRINCIPAL_PREFIX = "firebase:demo-airplane-games:";

let app: INestApplication;
let server: ReturnType<INestApplication["getHttpServer"]>;
// Test-side connection for arranging and inspecting rows; the app has its own pool.
let sql: pg.Pool;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: ["error"] });
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
  let req = request(server)[method.toLowerCase() as "get" | "put" | "post"](path).set(headers);
  if (body !== undefined) req = req.send(body as object);
  const res = await req;
  return { status: res.status, body: res.body, headers: res.headers as Record<string, string> };
}

// Each test signs in as a fresh uid, so tests never share a player row.
function newPlayer() {
  const uid = `uid-${randomUUID()}`;
  const token = emulatorToken(uid);
  const call = (method: string, path: string, body?: unknown) =>
    send(method, path, { Authorization: `Bearer ${token}` }, body);
  return { uid, principal: `${PRINCIPAL_PREFIX}${uid}`, call };
}

async function json(response: Reply): Promise<any> {
  return response.body;
}

type Call = ReturnType<typeof newPlayer>["call"];

const PERFECT_FAST = { finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9 };

/** Make the player's open Round look like it was issued long enough ago to pass MIN_ROUND_MS. */
async function backdate(principal: string) {
  await sql.query(
    "UPDATE rounds SET issued_at = issued_at - ($1::int * interval '1 millisecond') WHERE player_id = $2 AND status = 'open'",
    [MIN_ROUND_MS * 2, principal],
  );
}

async function startRound(call: Call, module = "atc-match") {
  return (await json(await call("POST", "/v1/rounds", { module }))).round.roundId as string;
}

async function playRound(
  { call, principal }: { call: Call; principal: string },
  result: typeof PERFECT_FAST = PERFECT_FAST,
) {
  const roundId = await startRound(call);
  await backdate(principal);
  return call("POST", `/v1/rounds/${roundId}/result`, result);
}

/** Ledger invariant: completed Rounds account for every SP and Mile above the starting balance. */
async function expectLedgerBalanced(principal: string, baseline = { statusPoints: 0, miles: 0 }) {
  const sums = (
    await sql.query<{ sp: number; miles: number }>(
      `SELECT COALESCE(SUM(sp_awarded), 0)::int AS sp, COALESCE(SUM(miles_awarded), 0)::int AS miles
       FROM rounds WHERE player_id = $1 AND status = 'completed'`,
      [principal],
    )
  ).rows[0];
  const player = (
    await sql.query<{ status_points: number; miles: number }>(
      "SELECT status_points, miles FROM players WHERE id = $1",
      [principal],
    )
  ).rows[0];
  expect(player?.status_points).toBe(baseline.statusPoints + (sums?.sp ?? NaN));
  expect(player?.miles).toBe(baseline.miles + (sums?.miles ?? NaN));
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
      await playRound(player, { finished: true, errorCount: 2, usedHint: false, timeRemainingFraction: 0.1 }),
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
    await sql.query("UPDATE rounds SET expires_at = $1 WHERE id = $2 AND player_id = $3", [
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
    const started = await json(await call("POST", "/v1/rounds", { module: "atc-match" }));
    expect(new Date(started.round.expiresAt).toISOString()).toBe(started.round.expiresAt);
  });

  it("rejects unknown modules and client-supplied economy fields", async () => {
    const { call } = newPlayer();
    await call("PUT", "/v1/me");
    expect((await call("POST", "/v1/rounds", { module: "space-invaders" })).status).toBe(400);
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
