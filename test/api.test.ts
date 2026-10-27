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
import { emulatorToken } from "./tokens.js";

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
    const issue = await player.call("POST", "/v1/rounds", { module: "atc-match" });
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
    // Guard against the enumeration silently finding nothing: 6 guarded routes plus two health routes.
    expect(routes.length).toBe(8);
    for (const { method, path } of routes) {
      const concrete = path.replace(":roundId", randomUUID());
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
    const lock = await lockPlayer(principal);
    let settled = false;
    const pending = call("POST", "/v1/rounds", { module: "atc-match" }).finally(() => (settled = true));
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

  it("six concurrent PUT /v1/me create the player exactly once", async () => {
    const { principal, call } = newPlayer();
    const responses = await Promise.all(Array.from({ length: 6 }, () => call("PUT", "/v1/me")));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    const count = (await sql.query("SELECT COUNT(*)::int AS n FROM players WHERE id = $1", [principal])).rows[0];
    expect(count.n).toBe(1);
  });

  it("a storm of interleaved issue and result calls keeps the ledger and one-open-round invariants", async () => {
    const { principal, call } = newPlayer();
    await call("PUT", "/v1/me");
    const first = await startRound(call);
    await backdate(principal);
    const results = Array.from({ length: 4 }, () => call("POST", `/v1/rounds/${first}/result`, PERFECT_FAST));
    const issues = Array.from({ length: 4 }, () => call("POST", "/v1/rounds", { module: "atc-match" }));
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
