import { randomUUID } from "node:crypto";
import { Controller, Get, Logger } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { ThrottlerStorage, ThrottlerStorageService } from "@nestjs/throttler";
import { sql } from "drizzle-orm";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { Public } from "../src/auth/public.decorator.js";
import { DatabaseService } from "../src/database/database.module.js";
import {
  CLEANUP_BATCH,
  createPostgresThrottlerStorage,
  hashKey,
  PostgresThrottlerStorage,
} from "../src/platform/pg-throttler-storage.js";
import { emulatorToken } from "./tokens.js";

// A4: the Postgres rate-limit store. Parity with the library's in-memory store, then the shared-store behaviour through
// real apps on one database. No test sleeps: time is moved by shifting the stored instants (Postgres) and Date.now (memory).

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const database = new DatabaseService(pool);
const apps: NestExpressApplication[] = [];
const savedEnv = { ...process.env };

beforeEach(async () => {
  await pool.query("TRUNCATE rate_limit_hits");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});
afterAll(() => pool.end());

/** Move every stored instant of this key back by `ms`, i.e. make `ms` of real time pass. */
async function shiftRow(key: string, ms: number): Promise<void> {
  await pool.query(
    `UPDATE rate_limit_hits SET
       hit_expiries = ARRAY(SELECT e - $2 * interval '1 millisecond' FROM unnest(hit_expiries) AS e ORDER BY 1),
       window_expires_at = window_expires_at - $2 * interval '1 millisecond',
       block_expires_at = block_expires_at - $2 * interval '1 millisecond'
     WHERE key_hash = $1`,
    [hashKey(key), ms],
  );
}

describe("PostgresThrottlerStorage matches the library in-memory ThrottlerStorageService", () => {
  type Step = { hit: true } | { advance: number };
  const sequences: Record<string, { limit: number; ttl: number; block: number; steps: Step[] }> = {
    "no block: fill, refuse, refuse again (refused hits are not counted)": {
      limit: 3, ttl: 60_000, block: 0,
      steps: [{ hit: true }, { hit: true }, { hit: true }, { hit: true }, { hit: true }, { advance: 30_000 }, { hit: true }],
    },
    "no block: hits expire one by one, not as a whole window": {
      limit: 3, ttl: 60_000, block: 0,
      steps: [
        { hit: true }, { advance: 20_000 }, { hit: true }, { hit: true }, { hit: true }, { hit: true },
        { advance: 41_000 }, { hit: true }, { hit: true }, { advance: 100_000 }, { hit: true },
      ],
    },
    "no block: limit 1": {
      limit: 1, ttl: 10_000, block: 0,
      steps: [{ hit: true }, { hit: true }, { advance: 10_500 }, { hit: true }],
    },
    "block: over the limit blocks for blockDuration, then the next hit starts afresh": {
      limit: 2, ttl: 60_000, block: 120_000,
      steps: [
        { hit: true }, { hit: true }, { hit: true }, { hit: true }, { advance: 90_000 }, { hit: true },
        { advance: 31_000 }, { hit: true }, { hit: true },
      ],
    },
    "block: a block shorter than the ttl": {
      limit: 2, ttl: 60_000, block: 5_000,
      steps: [{ hit: true }, { hit: true }, { hit: true }, { advance: 6_000 }, { hit: true }, { hit: true }, { hit: true }],
    },
  };

  for (const [name, seq] of Object.entries(sequences)) {
    it(name, async () => {
      const key = `parity:${randomUUID()}`;
      let skew = 0;
      const monotonicBase = performance.now();
      const store = new PostgresThrottlerStorage(database, undefined, () => monotonicBase + skew);
      const memory = new ThrottlerStorageService();
      const base = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => base + skew);
      try {
        for (const step of seq.steps) {
          if ("advance" in step) {
            skew += step.advance;
            await shiftRow(key, step.advance);
            continue;
          }
          const a = await store.increment(key, seq.ttl, seq.limit, seq.block, "default");
          const b = await memory.increment(key, seq.ttl, seq.limit, seq.block, "default");
          expect(a.totalHits).toBe(b.totalHits);
          expect(a.isBlocked).toBe(b.isBlocked);
          expect(Math.abs(a.timeToExpire - b.timeToExpire)).toBeLessThanOrEqual(1);
          // Only meaningful (and only read by the guard) while blocked; the library reports a huge negative number otherwise.
          if (b.isBlocked) expect(Math.abs(a.timeToBlockExpire - b.timeToBlockExpire)).toBeLessThanOrEqual(1);
        }
      } finally {
        memory.onApplicationShutdown();
        store.onApplicationShutdown();
      }
    });
  }

  it("keeps separate counters per throttler name", async () => {
    const key = `names:${randomUUID()}`;
    const store = new PostgresThrottlerStorage(database);
    expect((await store.increment(key, 60_000, 1, 0, "a")).isBlocked).toBe(false);
    expect((await store.increment(key, 60_000, 1, 0, "b")).isBlocked).toBe(false);
    expect((await store.increment(key, 60_000, 1, 0, "a")).isBlocked).toBe(true);
    store.onApplicationShutdown();
  });

  it("is atomic: concurrent increments of one key from two stores admit exactly the limit", async () => {
    const key = `race:${randomUUID()}`;
    const stores = [new PostgresThrottlerStorage(database), new PostgresThrottlerStorage(database)];
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => stores[i % 2]!.increment(key, 60_000, 5, 0, "default")),
    );
    expect(results.filter((r) => !r.isBlocked)).toHaveLength(5);
    expect(results.filter((r) => r.isBlocked)).toHaveLength(35);
    stores.forEach((s) => s.onApplicationShutdown());
  });

  it("stores only the sha256 of the key, never the key", async () => {
    const key = `default:principal:firebase:demo-airplane-games:uid-${randomUUID()}`;
    const store = new PostgresThrottlerStorage(database);
    await store.increment(key, 60_000, 5, 0, "default");
    const { rows } = await pool.query("SELECT key_hash, to_jsonb(rate_limit_hits)::text AS whole FROM rate_limit_hits");
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).toBe(hashKey(key));
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].whole).not.toContain("uid-");
    expect(rows[0].whole).not.toContain("principal");
    store.onApplicationShutdown();
  });

  it("cleanup removes rows with no live hit and no active block, and keeps live and blocked ones", async () => {
    const store = new PostgresThrottlerStorage(database);
    const dead = `dead:${randomUUID()}`;
    const live = `live:${randomUUID()}`;
    const blocked = `blocked:${randomUUID()}`;
    await store.increment(dead, 60_000, 5, 0, "default");
    await store.increment(live, 60_000, 5, 0, "default");
    for (let i = 0; i < 3; i += 1) await store.increment(blocked, 60_000, 1, 600_000, "default");
    await shiftRow(dead, 61_000);
    await shiftRow(blocked, 61_000); // hits and window gone, block (600 s) still active
    expect(await store.cleanup()).toBe(1);
    const { rows } = await pool.query("SELECT key_hash FROM rate_limit_hits");
    expect(rows.map((r) => r.key_hash).sort()).toEqual([hashKey(live), hashKey(blocked)].sort());
    store.onApplicationShutdown();
  });
});

@Controller("v1/test")
class PublicProbeController {
  @Public()
  @Get("public")
  ping() {
    return { ok: true };
  }
}

async function buildApp(env: Record<string, string>) {
  Object.assign(process.env, env);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers: [PublicProbeController] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app, { trustProxy: false });
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  return app.getHttpServer();
}

const bearer = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid)}` });

describe("rate limits across app instances", () => {
  it("two instances on one database share one limit, for public IPs and for principals", async () => {
    const env = { RATE_LIMIT_STORE: "postgres", RATE_LIMIT_PUBLIC_PER_MIN: "3", RATE_LIMIT_AUTH_PER_MIN: "4" };
    const a = await buildApp(env);
    const b = await buildApp(env);
    expect((await request(a).get("/v1/test/public")).status).toBe(200);
    expect((await request(b).get("/v1/test/public")).status).toBe(200);
    expect((await request(a).get("/v1/test/public")).status).toBe(200);
    const limited = await request(b).get("/v1/test/public");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);

    const alice = bearer(`uid-${randomUUID()}`);
    for (const server of [a, b, a, b]) expect((await request(server).get("/v1/me/progress").set(alice)).status).not.toBe(429);
    expect((await request(a).get("/v1/me/progress").set(alice)).status).toBe(429);
    expect((await request(b).get("/v1/me/progress").set(alice)).status).toBe(429);
    expect((await request(a).get("/v1/me/progress").set(bearer(`uid-${randomUUID()}`))).status).not.toBe(429);
  });

  it("the shared rows hold no raw IP or principal", async () => {
    const server = await buildApp({ RATE_LIMIT_STORE: "postgres", RATE_LIMIT_AUTH_PER_MIN: "100", RATE_LIMIT_PUBLIC_PER_MIN: "100" });
    const uid = `uid-${randomUUID()}`;
    await request(server).get("/v1/me/progress").set(bearer(uid));
    await request(server).get("/v1/test/public");
    const { rows } = await pool.query("SELECT to_jsonb(rate_limit_hits)::text AS whole FROM rate_limit_hits");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.whole).not.toContain(uid);
      expect(r.whole).not.toContain("127.0.0.1");
      expect(r.whole).not.toContain("principal");
    }
  });

  it("a refused caller is admitted again once its hits have expired (rows shifted in SQL)", async () => {
    const server = await buildApp({ RATE_LIMIT_STORE: "postgres", RATE_LIMIT_PUBLIC_PER_MIN: "2" });
    expect((await request(server).get("/v1/test/public")).status).toBe(200);
    expect((await request(server).get("/v1/test/public")).status).toBe(200);
    expect((await request(server).get("/v1/test/public")).status).toBe(429);
    // Time passes for the process too (a refusal remembered locally lasts until just before the release). The store reads
    // the monotonic clock, so that is the one to move.
    const realNow = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => realNow() + 61_000);
    await pool.query(
      `UPDATE rate_limit_hits SET
         hit_expiries = ARRAY(SELECT e - interval '61 seconds' FROM unnest(hit_expiries) AS e),
         window_expires_at = window_expires_at - interval '61 seconds'`,
    );
    expect((await request(server).get("/v1/test/public")).status).toBe(200);
  });

  it("RATE_LIMIT_STORE=memory keeps counters per process and writes nothing to the database", async () => {
    const env = { RATE_LIMIT_STORE: "memory", RATE_LIMIT_PUBLIC_PER_MIN: "2" };
    const a = await buildApp(env);
    const b = await buildApp(env);
    expect((await request(a).get("/v1/test/public")).status).toBe(200);
    expect((await request(a).get("/v1/test/public")).status).toBe(200);
    expect((await request(a).get("/v1/test/public")).status).toBe(429);
    // The second instance has its own counter.
    expect((await request(b).get("/v1/test/public")).status).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS n FROM rate_limit_hits")).rows[0].n).toBe(0);
  });

  it("the default store is postgres", async () => {
    const server = await buildApp({ RATE_LIMIT_PUBLIC_PER_MIN: "5" });
    await request(server).get("/v1/test/public");
    expect((await pool.query("SELECT count(*)::int AS n FROM rate_limit_hits")).rows[0].n).toBe(1);
  });
});

const limiterConfig = () => ({
  databaseUrl: process.env.DATABASE_URL!,
  databaseSsl: "disable" as const,
  databaseCaCert: undefined,
  rateLimitPoolMax: 3,
});

describe("cleanup throughput and the increment/cleanup race", () => {
  it("one pass removes far more than one batch of expired rows, and a zero budget removes exactly one batch", async () => {
    const store = new PostgresThrottlerStorage(database);
    await pool.query(
      `INSERT INTO rate_limit_hits (throttler_name, key_hash, window_expires_at, hit_expiries)
       SELECT 'default', lpad(to_hex(g), 64, '0'), now() - interval '1 minute', ARRAY[now() - interval '1 minute']
       FROM generate_series(1, $1::int) AS g`,
      [CLEANUP_BATCH * 4 + 300],
    );
    expect(await store.cleanup(0)).toBe(CLEANUP_BATCH);
    expect(await store.cleanup(10_000)).toBe(CLEANUP_BATCH * 3 + 300);
    expect((await pool.query("SELECT count(*)::int AS n FROM rate_limit_hits")).rows[0].n).toBe(0);
    await store.onApplicationShutdown();
  });

  it("an increment racing cleanup on expired rows never loses its hit (probabilistic: 15 rounds of real concurrency, a rare interleaving may not occur)", async () => {
    const store = new PostgresThrottlerStorage(database);
    for (let round = 0; round < 15; round += 1) {
      const keys = Array.from({ length: 12 }, () => `race:${randomUUID()}`);
      await Promise.all(keys.map((k) => store.increment(k, 60_000, 5, 0, "default")));
      for (const k of keys) await shiftRow(k, 61_000);
      const results = await Promise.all([
        store.cleanup(),
        store.cleanup(),
        ...keys.map((k) => store.increment(k, 60_000, 5, 0, "default")),
      ]);
      for (const r of results.slice(2) as Array<{ totalHits: number; timeToExpire: number }>) {
        expect(r.totalHits).toBe(1);
        expect(r.timeToExpire).toBeGreaterThan(0);
      }
      const { rows } = await pool.query(
        "SELECT cardinality(hit_expiries) AS n FROM rate_limit_hits WHERE key_hash = ANY($1)",
        [keys.map(hashKey)],
      );
      expect(rows).toHaveLength(keys.length);
      expect(rows.every((r) => r.n === 1)).toBe(true);
    }
    await store.onApplicationShutdown();
  });
});

/** Backend pids of limiter connections, so a test counts only its own (other tests' apps may keep an idle one). */
async function limiterPids(): Promise<Set<number>> {
  const { rows } = await pool.query(
    "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'airplane-games-backend-ratelimit'",
  );
  return new Set(rows.map((r) => Number(r.pid)));
}

describe("limiter isolation from gameplay", () => {
  it("with every limiter connection stuck on a locked row, calls fail open within the short timeout; gameplay on a 3-connection pool of its own is not delayed, and the limiter connections are separate (pg_stat_activity)", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const before = await limiterPids();
    const store = createPostgresThrottlerStorage(limiterConfig());
    // Three keys, so the flood needs all three limiter connections (calls for one key run one at a time).
    const keys = Array.from({ length: 3 }, () => `flood:${randomUUID()}`);
    for (const key of keys) await store.increment(key, 60_000, 5, 0, "default");
    const gameplayPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, application_name: "gameplay-test" });
    const gameplay = new DatabaseService(gameplayPool);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM rate_limit_hits WHERE key_hash = ANY($1) FOR UPDATE", [keys.map(hashKey)]);
      const startedAt = performance.now();
      const flood = keys.flatMap((key) => Array.from({ length: 70 }, () => store.increment(key, 60_000, 5, 0, "default")));
      await new Promise((resolve) => setTimeout(resolve, 100));
      // All three of this store's limiter connections are in use, and they are not the gameplay connections.
      expect([...(await limiterPids())].filter((pid) => !before.has(pid))).toHaveLength(3);
      const gameplayStart = performance.now();
      await Promise.all(
        [1, 2, 3].map(() =>
          gameplay.withTransaction(async (tx) => {
            await tx.execute(sql`select 1`);
          }),
        ),
      );
      const gameplayMs = performance.now() - gameplayStart;
      const { rows: gameplayRows } = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'gameplay-test'",
      );
      expect(gameplayRows[0].n).toBeGreaterThan(0);
      const results = await Promise.all(flood);
      const floodMs = performance.now() - startedAt;
      expect(gameplayMs).toBeLessThan(150);
      // Fail-open fired at the 500 ms lock timeout, not after 5 s, and every call was answered.
      expect(floodMs).toBeLessThan(2500);
      expect(results).toHaveLength(210);
      expect(store.degradedSince).toBeDefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await gameplayPool.end();
      await store.onApplicationShutdown();
    }
  });

  it("a busy limiter pool fails only the waiting request open: no process-wide degrade, the next request asks the database", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const tiny = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 100 });
    const store = new PostgresThrottlerStorage(new DatabaseService(tiny), tiny);
    const key = `busy:${randomUUID()}`;
    const held = await tiny.connect();
    try {
      const during = await store.increment(key, 60_000, 5, 0, "default"); // waits 100 ms for the only client, then falls back
      expect(during.isBlocked).toBe(false);
      expect(store.degradedSince).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      held.release();
    }
    await store.increment(key, 60_000, 5, 0, "default");
    expect(store.degradedSince).toBeUndefined();
    const { rows } = await pool.query("SELECT cardinality(hit_expiries) AS n FROM rate_limit_hits WHERE key_hash = $1", [hashKey(key)]);
    expect(rows[0].n).toBe(1); // only the second request reached the shared store
    await store.onApplicationShutdown();
  });

  it("an unreachable database degrades the process (connection failure, not a busy pool)", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const dead = new pg.Pool({ connectionString: "postgres://x:y@127.0.0.1:1/none", max: 1, connectionTimeoutMillis: 500 });
    dead.on("error", () => undefined);
    const store = new PostgresThrottlerStorage(new DatabaseService(dead), dead);
    await store.increment(`dead:${randomUUID()}`, 60_000, 5, 0, "default");
    expect(store.degradedSince).toBeDefined();
    await store.onApplicationShutdown();
  });

  it("the limiter pool is closed on shutdown", async () => {
    const before = await limiterPids();
    const store = createPostgresThrottlerStorage(limiterConfig());
    await store.increment(`close:${randomUUID()}`, 60_000, 5, 0, "default");
    const during = await limiterPids();
    expect([...during].filter((pid) => !before.has(pid)).length).toBeGreaterThan(0);
    await store.onApplicationShutdown();
    const after = await limiterPids();
    expect([...after].filter((pid) => !before.has(pid))).toHaveLength(0);
  });
});

describe("local refusal against the real store", () => {
  it("a refused key is refused locally with a Retry-After that does not undershoot, and is admitted again when released", async () => {
    let skew = 0;
    const base = performance.now();
    const store = new PostgresThrottlerStorage(database, undefined, () => base + skew);
    const key = `local:${randomUUID()}`;
    for (let i = 0; i < 2; i += 1) expect((await store.increment(key, 60_000, 2, 0, "default")).isBlocked).toBe(false);
    const refused = await store.increment(key, 60_000, 2, 0, "default");
    expect(refused.isBlocked).toBe(true);
    // The row is gone, yet this process still refuses until just before the release: no database call was made.
    await pool.query("TRUNCATE rate_limit_hits");
    skew += 10_000;
    const local = await store.increment(key, 60_000, 2, 0, "default");
    expect(local.isBlocked).toBe(true);
    expect(local.timeToBlockExpire).toBeGreaterThanOrEqual(refused.timeToBlockExpire - 10);
    expect(local.timeToBlockExpire).toBeLessThanOrEqual(refused.timeToBlockExpire - 9);
    // Past the earliest possible release the database decides again.
    skew += 60_000;
    expect((await store.increment(key, 60_000, 2, 0, "default")).isBlocked).toBe(false);
    await store.onApplicationShutdown();
  });

  it("readiness stays 200 and says so when the shared counter has failed open", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const server = await buildApp({ RATE_LIMIT_STORE: "postgres" });
    const storage = apps.at(-1)!.get(ThrottlerStorage) as PostgresThrottlerStorage;
    expect((await request(server).get("/v1/health/ready")).body).toEqual({ status: "ready" });
    const key = `ready:${randomUUID()}`;
    await storage.increment(key, 60_000, 5, 0, "default");
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM rate_limit_hits WHERE key_hash = $1 FOR UPDATE", [hashKey(key)]);
      await storage.increment(key, 60_000, 5, 0, "default");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    const ready = await request(server).get("/v1/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ready", rateLimit: "degraded" });
  });
});
