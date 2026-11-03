import { randomUUID } from "node:crypto";
import { Controller, Get } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { ThrottlerStorageService } from "@nestjs/throttler";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { Public } from "../src/auth/public.decorator.js";
import { DatabaseService } from "../src/database/database.module.js";
import { hashKey, PostgresThrottlerStorage } from "../src/platform/pg-throttler-storage.js";
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
      const store = new PostgresThrottlerStorage(database);
      const memory = new ThrottlerStorageService();
      let skew = 0;
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
