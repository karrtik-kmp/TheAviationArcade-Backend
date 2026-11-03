import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../src/database/database.module.js";
import { COUNTER_RETRY_MS, hashKey, PostgresThrottlerStorage } from "../src/platform/pg-throttler-storage.js";

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
