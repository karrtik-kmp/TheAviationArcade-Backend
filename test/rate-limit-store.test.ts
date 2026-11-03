import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../src/database/database.module.js";
import {
  CLEANUP_BATCH,
  COUNTER_RETRY_MS,
  DEGRADED_REMINDER_MS,
  hashKey,
  PostgresThrottlerStorage,
} from "../src/platform/pg-throttler-storage.js";

const blockedRow = (seconds: number) => ({
  rows: [{ total_hits: 4, time_to_expire: 60, is_blocked: true, time_to_block_expire: seconds }],
  rowCount: 1,
});
const okRow = { rows: [{ total_hits: 1, time_to_expire: 60, is_blocked: false, time_to_block_expire: 0 }], rowCount: 1 };

afterEach(() => vi.restoreAllMocks());

describe("PostgresThrottlerStorage failure policy", () => {
  it("fails open to a per-process counter, does not hit the database again for a while, and logs once", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const execute = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const store = new PostgresThrottlerStorage({ db: { execute } } as unknown as DatabaseService);
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await store.increment("k", 60_000, 3, 0, "default"));
    // Never an error; limits still hold per process (3 admitted, then refused).
    expect(results.map((r) => r.isBlocked)).toEqual([false, false, false, true, true]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    store.onApplicationShutdown();
  });

  it("retries the database after the retry delay and logs recovery once", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const now = vi.spyOn(Date, "now");
    const t0 = Date.now();
    now.mockReturnValue(t0);
    let up = false;
    const execute = vi.fn(async () => {
      if (!up) throw new Error("down");
      return { rows: [{ total_hits: 1, time_to_expire: 60, is_blocked: false, time_to_block_expire: 0 }], rowCount: 1 };
    });
    const store = new PostgresThrottlerStorage({ db: { execute } } as unknown as DatabaseService);
    await store.increment("k", 60_000, 3, 0, "default");
    up = true;
    now.mockReturnValue(t0 + COUNTER_RETRY_MS - 1);
    await store.increment("k", 60_000, 3, 0, "default");
    expect(execute).toHaveBeenCalledTimes(1);
    now.mockReturnValue(t0 + COUNTER_RETRY_MS + 1);
    const record = await store.increment("k", 60_000, 3, 0, "default");
    // The successful counter call plus the opportunistic cleanup it triggers (first run in this process).
    expect(execute).toHaveBeenCalledTimes(3);
    expect(record).toEqual({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 });
    expect(log).toHaveBeenCalledTimes(1);
    store.onApplicationShutdown();
  });

  it("hashKey is sha256 hex", () => {
    expect(hashKey("x")).toBe("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
  });
});

describe("PostgresThrottlerStorage degraded reminders", () => {
  it("warns again at most every DEGRADED_REMINDER_MS while the counter stays down, and exposes degradedSince", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const now = vi.spyOn(Date, "now");
    const t0 = Date.now();
    now.mockReturnValue(t0);
    const execute = vi.fn(async () => {
      throw new Error("function rate_limit_increment does not exist");
    });
    const store = new PostgresThrottlerStorage({ db: { execute } } as unknown as Pick<DatabaseService, "db">);
    expect(store.degradedSince).toBeUndefined();
    await store.increment("k", 60_000, 3, 0, "default");
    expect(store.degradedSince).toBe(t0);
    for (let t = COUNTER_RETRY_MS + 1; t < DEGRADED_REMINDER_MS; t += COUNTER_RETRY_MS + 1) {
      now.mockReturnValue(t0 + t);
      await store.increment("k", 60_000, 3, 0, "default");
    }
    expect(warn).toHaveBeenCalledTimes(1);
    now.mockReturnValue(t0 + DEGRADED_REMINDER_MS + COUNTER_RETRY_MS + 1);
    await store.increment("k", 60_000, 3, 0, "default");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]![0])).toContain("degraded for");
    expect(store.degradedSince).toBe(t0);
    await store.onApplicationShutdown();
  });
});

describe("PostgresThrottlerStorage local refusal", () => {
  /** A store whose opportunistic cleanup never fires, so the mock sees only counter calls. */
  const make = (execute: ReturnType<typeof vi.fn>) => {
    const store = new PostgresThrottlerStorage({ db: { execute } } as unknown as Pick<DatabaseService, "db">);
    (store as unknown as { lastCleanup: number }).lastCleanup = Number.MAX_SAFE_INTEGER;
    return store;
  };

  it("refuses a key the database refused without asking again, until just before the release, with a Retry-After at least the true one", async () => {
    const now = vi.spyOn(Date, "now");
    const t0 = Date.now();
    now.mockReturnValue(t0);
    const execute = vi.fn(async () => blockedRow(30));
    const store = make(execute);
    const first = await store.increment("k", 60_000, 3, 0, "default");
    expect(first).toMatchObject({ isBlocked: true, timeToBlockExpire: 30 });
    const callsAfterFirst = execute.mock.calls.length;
    now.mockReturnValue(t0 + 10_000);
    const local = await store.increment("k", 60_000, 3, 0, "default");
    expect(local).toMatchObject({ isBlocked: true, totalHits: 4 });
    expect(local.timeToBlockExpire).toBeGreaterThanOrEqual(20); // true remaining is 20 s
    expect(local.timeToBlockExpire).toBeLessThanOrEqual(21);
    expect(execute).toHaveBeenCalledTimes(callsAfterFirst);
    // Another key, another limit, and the last second all go to the database.
    await store.increment("other", 60_000, 3, 0, "default");
    expect(execute).toHaveBeenCalledTimes(callsAfterFirst + 1);
    await store.increment("k", 60_000, 4, 0, "default");
    expect(execute).toHaveBeenCalledTimes(callsAfterFirst + 2);
    now.mockReturnValue(t0 + 29_000);
    await store.increment("k", 60_000, 3, 0, "default");
    expect(execute).toHaveBeenCalledTimes(callsAfterFirst + 3);
    await store.onApplicationShutdown();
  });

  it("forgets the refusal once the database admits the key", async () => {
    const answers = [blockedRow(30), okRow, blockedRow(30)];
    const execute = vi.fn(async () => answers.shift() ?? okRow);
    const store = make(execute);
    await store.increment("k", 60_000, 3, 0, "default");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 29_500);
    expect((await store.increment("k", 60_000, 3, 0, "default")).isBlocked).toBe(false);
    await store.onApplicationShutdown();
  });

  it("runs calls for one key one at a time, so a flood holds one connection and the later calls reuse the first refusal", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const execute = vi.fn(async () => {
      await gate;
      return blockedRow(30);
    });
    const store = make(execute);
    const flood = Array.from({ length: 50 }, () => store.increment("k", 60_000, 3, 0, "default"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(execute).toHaveBeenCalledTimes(1);
    release();
    const results = await Promise.all(flood);
    expect(results.every((r) => r.isBlocked)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    await store.onApplicationShutdown();
  });

  it("a queued call that waited through a counter failure uses the fallback instead of asking again", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const execute = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("timeout");
    });
    const store = make(execute);
    await Promise.all(Array.from({ length: 10 }, () => store.increment("k", 60_000, 3, 0, "default")));
    expect(execute).toHaveBeenCalledTimes(1);
    await store.onApplicationShutdown();
  });
});

describe("PostgresThrottlerStorage cleanup batches", () => {
  const make = (execute: ReturnType<typeof vi.fn>) =>
    new PostgresThrottlerStorage({ db: { execute } } as unknown as Pick<DatabaseService, "db">);

  it("loops until a batch comes back short", async () => {
    const counts = [CLEANUP_BATCH, CLEANUP_BATCH, 120];
    const execute = vi.fn(async () => ({ rows: [], rowCount: counts.shift() ?? 0 }));
    const store = make(execute);
    expect(await store.cleanup(10_000)).toBe(2 * CLEANUP_BATCH + 120);
    expect(execute).toHaveBeenCalledTimes(3);
    await store.onApplicationShutdown();
  });

  it("stops after the time budget even with rows left, but always runs one batch", async () => {
    const execute = vi.fn(async () => ({ rows: [], rowCount: CLEANUP_BATCH }));
    const store = make(execute);
    expect(await store.cleanup(0)).toBe(CLEANUP_BATCH);
    expect(execute).toHaveBeenCalledTimes(1);
    await store.onApplicationShutdown();
  });
});
