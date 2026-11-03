import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { ThrottlerStorageService } from "@nestjs/throttler";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { sql } from "drizzle-orm";
import type { DatabaseService } from "../database/database.module.js";

/** After a failed counter call, use the per-process fallback this long before trying the database again. */
export const COUNTER_RETRY_MS = 5_000;
/** At most one cleanup pass per process per interval, and at most this many rows per pass. */
export const CLEANUP_INTERVAL_MS = 60_000;
export const CLEANUP_BATCH = 500;

/** The library does not export its record type from the package root. */
export type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage["increment"]>>;

type CounterRow = { total_hits: number; time_to_expire: number; is_blocked: boolean; time_to_block_expire: number };

/** The row key: sha256 hex of the tracker key, so the raw principal or IP never reaches the table. */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Rate-limit counters shared by every instance. `increment` is one call to the SQL function rate_limit_increment (migration
 * 0014): a row-locked, atomic port of the library's own ThrottlerStorageService.increment, evaluated on the database clock,
 * so results match the in-memory store for the same sequence of requests.
 *
 * Failure policy: FAIL OPEN, to the library's in-memory store. If the counter call fails (database down, pool exhausted,
 * timeout), requests are not refused and are not delayed again for COUNTER_RETRY_MS: they are counted per process instead,
 * so limits degrade to per-instance rather than disappearing, and a limiter fault never takes the API down. Failing closed
 * would turn a counter outage into an outage of every route. One warning is logged when the counter fails and one when it
 * recovers, never one per request.
 *
 * Cleanup of expired rows is opportunistic: a bounded, fire-and-forget DELETE at most once per CLEANUP_INTERVAL_MS per
 * process, whose failure is ignored.
 */
export class PostgresThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger("RateLimit");
  private readonly fallback = new ThrottlerStorageService();
  private degradedUntil = 0;
  private degraded = false;
  private lastCleanup = 0;
  private cleaning = false;

  constructor(private readonly database: DatabaseService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (Date.now() < this.degradedUntil) return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    try {
      const result = await this.database.db.execute(
        sql`SELECT * FROM rate_limit_increment(${throttlerName}, ${hashKey(key)}, ${ttl}::bigint, ${limit}::integer, ${blockDuration}::bigint)`,
      );
      const row = result.rows[0] as CounterRow | undefined;
      if (!row) throw new Error("rate_limit_increment returned no row");
      if (this.degraded) {
        this.degraded = false;
        this.logger.log("Shared rate-limit counter recovered.");
      }
      this.maybeCleanup();
      return {
        totalHits: Number(row.total_hits),
        timeToExpire: Number(row.time_to_expire),
        isBlocked: row.is_blocked,
        timeToBlockExpire: Number(row.time_to_block_expire),
      };
    } catch (error) {
      this.degradedUntil = Date.now() + COUNTER_RETRY_MS;
      if (!this.degraded) {
        this.degraded = true;
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Shared rate-limit counter unavailable (${reason}); counting per instance until it recovers.`);
      }
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  private maybeCleanup(): void {
    const now = Date.now();
    if (this.cleaning || now - this.lastCleanup < CLEANUP_INTERVAL_MS) return;
    this.cleaning = true;
    this.lastCleanup = now;
    void this.cleanup()
      .catch(() => undefined)
      .finally(() => {
        this.cleaning = false;
      });
  }

  /** Delete up to CLEANUP_BATCH rows with no live hit and no active block. Returns the number deleted. */
  async cleanup(): Promise<number> {
    const result = await this.database.db.execute(sql`
      DELETE FROM rate_limit_hits WHERE (throttler_name, key_hash) IN (
        SELECT throttler_name, key_hash FROM rate_limit_hits
        WHERE window_expires_at < clock_timestamp()
          AND (NOT blocked OR block_expires_at IS NULL OR block_expires_at < clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM unnest(hit_expiries) AS e WHERE e > clock_timestamp())
        LIMIT ${CLEANUP_BATCH}
        FOR UPDATE SKIP LOCKED
      )
    `);
    return result.rowCount ?? 0;
  }

  onApplicationShutdown(): void {
    this.fallback.onApplicationShutdown();
  }
}
