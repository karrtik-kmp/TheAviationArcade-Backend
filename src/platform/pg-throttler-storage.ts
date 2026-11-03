import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { ThrottlerStorageService } from "@nestjs/throttler";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { sql } from "drizzle-orm";
import pg from "pg";
import type { AppConfig } from "../config/config.module.js";
import { DatabaseService, limiterPoolOptions } from "../database/database.module.js";

/** After a failed counter call, use the per-process fallback this long before trying the database again. */
export const COUNTER_RETRY_MS = 5_000;
/** While the counter stays down, repeat the warning at most this often. */
export const DEGRADED_REMINDER_MS = 5 * 60_000;
/** At most one cleanup pass per process per interval; a pass loops batches of CLEANUP_BATCH rows within CLEANUP_BUDGET_MS. */
export const CLEANUP_INTERVAL_MS = 60_000;
export const CLEANUP_BATCH = 500;
export const CLEANUP_BUDGET_MS = 200;
/** After a pass that ran out of budget with rows left, the next pass may start this soon instead of after the interval. */
export const CLEANUP_BACKLOG_RETRY_MS = 5_000;
/** Upper bound on remembered refusals per process (entries also expire on their own). */
export const LOCAL_REFUSAL_MAX = 10_000;

/** The library does not export its record type from the package root. */
export type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage["increment"]>>;

type CounterRow = { total_hits: number; time_to_expire: number; is_blocked: boolean; time_to_block_expire: number };

type LocalRefusal = {
  limit: number;
  /** Local instant until which the shared store is certain to still refuse this key. */
  safeUntil: number;
  /** Upper estimate of when the block ends, for Retry-After. */
  estimatedEnd: number;
  totalHits: number;
  timeToExpire: number;
  recordedAt: number;
};

/** The row key: sha256 hex of the tracker key, so the raw principal or IP never reaches the table. */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Rate-limit counters shared by every instance. `increment` is one call to the SQL function rate_limit_increment (migration
 * 0014): a row-locked, atomic port of the library's own ThrottlerStorageService.increment, evaluated on the database clock,
 * so results match the in-memory store for the same sequence of requests.
 *
 * Isolation from gameplay: in the app this runs on its own small pool (limiterPoolOptions: 250 ms to get a connection,
 * 500 ms statement and lock timeout), so a flood of limiter calls cannot take connections from, or wait on locks held by,
 * gameplay transactions. Within one process, calls for the same key run one after another (the row lock would serialise
 * them in the database anyway), so a flood from one key holds at most one pool connection.
 *
 * Local short-circuit: when the database refuses a key, this process remembers "refused until T" and refuses that key again
 * without a database call until T. T is computed so the shared store cannot admit the key sooner: a refusal means the live
 * hits are at the limit (or a block is active), the live set only shrinks as hits expire, the oldest expires
 * `timeToBlockExpire` seconds (rounded up, by the database clock) after the decision, and the decision happened no earlier
 * than this call started. So T = start + (seconds - 1) s is always before the real release (durations only, no clock
 * comparison with the database). Refused calls are not counted by the store, so skipping them changes no state. It applies
 * only to refusals already seen, never to a count this process infers itself: counting admitted hits locally cannot be
 * made safe, because hits from other instances and clock skew could let it refuse requests the shared store admits. The
 * remembered refusal is dropped if the limit differs, and it is kept only for blockDuration 0 (the only mode the app uses;
 * the library reports repeated refusals differently under a punitive block, so that mode always asks the database). It is not consulted while degraded. If someone deletes the row
 * by hand, a locally remembered refusal can outlast it by up to one window.
 *
 * Failure policy: FAIL OPEN, to the library's in-memory store. If the counter call fails (database down, pool exhausted,
 * timeout), requests are not refused and are not delayed again for COUNTER_RETRY_MS: they are counted per process instead,
 * so limits degrade to per-instance rather than disappearing, and a limiter fault never takes the API down. Failing closed
 * would turn a counter outage into an outage of every route. A warning is logged when the counter fails, repeated at most
 * every DEGRADED_REMINDER_MS while it stays down, and one line when it recovers. `degradedSince` is exposed (readiness
 * body). Readiness is not failed for it: the API still serves and limits still hold per instance, and a failing probe
 * would pull every instance out of rotation for a fault that taking them out cannot fix.
 *
 * Cleanup of expired rows is opportunistic: a bounded, fire-and-forget pass at most once per CLEANUP_INTERVAL_MS per
 * process that deletes batches until one comes back short or CLEANUP_BUDGET_MS has passed. Its failure is ignored.
 */
export class PostgresThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger("RateLimit");
  private readonly fallback = new ThrottlerStorageService();
  private degradedUntil = 0;
  private degradedSinceMs: number | undefined;
  private lastWarn = 0;
  private lastCleanup = 0;
  private cleaning = false;
  private backlog = false;
  private readonly refusals = new Map<string, LocalRefusal>();
  private readonly chains = new Map<string, Promise<unknown>>();

  /** `ownedPool`, when given, is closed on shutdown. */
  constructor(
    private readonly database: Pick<DatabaseService, "db">,
    private readonly ownedPool?: pg.Pool,
  ) {}

  /** When the shared counter was first found unavailable (ms since epoch), or undefined while it works. */
  get degradedSince(): number | undefined {
    return this.degradedSinceMs;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const id = `${throttlerName}\u0000${key}`;
    const quick = this.quickAnswer(id, key, ttl, limit, blockDuration, throttlerName);
    if (quick) return quick;
    const previous = this.chains.get(id);
    const run = (async () => {
      if (previous) await previous;
      // Earlier calls for this key may have found it refused, or the counter down, while this one waited.
      return (
        this.quickAnswer(id, key, ttl, limit, blockDuration, throttlerName) ??
        this.count(id, key, ttl, limit, blockDuration, throttlerName)
      );
    })();
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(id, tail);
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id);
    });
    return run;
  }

  /** The per-process fallback while degraded, or a remembered refusal; undefined when the database must be asked. */
  private quickAnswer(
    id: string,
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> | ThrottlerStorageRecord | undefined {
    const now = Date.now();
    if (now < this.degradedUntil) return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    const refusal = this.refusals.get(id);
    if (!refusal) return undefined;
    if (refusal.limit !== limit || now >= refusal.safeUntil) {
      this.refusals.delete(id);
      return undefined;
    }
    return {
      totalHits: refusal.totalHits,
      timeToExpire: Math.max(0, refusal.timeToExpire - Math.floor((now - refusal.recordedAt) / 1000)),
      isBlocked: true,
      timeToBlockExpire: Math.max(1, Math.ceil((refusal.estimatedEnd - now) / 1000)),
    };
  }

  private async count(
    id: string,
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const startedAt = Date.now();
    try {
      const result = await this.database.db.execute(
        sql`SELECT * FROM rate_limit_increment(${throttlerName}, ${hashKey(key)}, ${ttl}::bigint, ${limit}::integer, ${blockDuration}::bigint)`,
      );
      const row = result.rows[0] as CounterRow | undefined;
      if (!row) throw new Error("rate_limit_increment returned no row");
      if (this.degradedSinceMs !== undefined) {
        this.logger.log(
          `Shared rate-limit counter recovered after ${Math.round((Date.now() - this.degradedSinceMs) / 1000)} s.`,
        );
        this.degradedSinceMs = undefined;
      }
      this.maybeCleanup();
      const record = {
        totalHits: Number(row.total_hits),
        timeToExpire: Number(row.time_to_expire),
        isBlocked: row.is_blocked,
        timeToBlockExpire: Number(row.time_to_block_expire),
      };
      if (record.isBlocked && blockDuration <= 0) this.rememberRefusal(id, limit, startedAt, record);
      else this.refusals.delete(id);
      return record;
    } catch (error) {
      const now = Date.now();
      this.degradedUntil = now + COUNTER_RETRY_MS;
      if (this.degradedSinceMs === undefined || now - this.lastWarn >= DEGRADED_REMINDER_MS) {
        const reason = error instanceof Error ? error.message : String(error);
        const since =
          this.degradedSinceMs === undefined ? "" : ` (degraded for ${Math.round((now - this.degradedSinceMs) / 1000)} s)`;
        this.degradedSinceMs ??= now;
        this.lastWarn = now;
        this.logger.warn(`Shared rate-limit counter unavailable (${reason}); counting per instance until it recovers${since}.`);
      }
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  private rememberRefusal(id: string, limit: number, startedAt: number, record: ThrottlerStorageRecord): void {
    const seconds = Math.ceil(record.timeToBlockExpire);
    if (!(seconds >= 2)) {
      this.refusals.delete(id);
      return;
    }
    if (this.refusals.size >= LOCAL_REFUSAL_MAX) {
      const now = Date.now();
      for (const [k, v] of this.refusals) if (now >= v.safeUntil) this.refusals.delete(k);
      if (this.refusals.size >= LOCAL_REFUSAL_MAX) return;
    }
    this.refusals.set(id, {
      limit,
      safeUntil: startedAt + (seconds - 1) * 1000,
      estimatedEnd: startedAt + seconds * 1000,
      totalHits: record.totalHits,
      timeToExpire: record.timeToExpire,
      recordedAt: startedAt,
    });
  }

  private maybeCleanup(): void {
    const now = Date.now();
    const wait = this.backlog ? CLEANUP_BACKLOG_RETRY_MS : CLEANUP_INTERVAL_MS;
    if (this.cleaning || now - this.lastCleanup < wait) return;
    this.cleaning = true;
    this.lastCleanup = now;
    void this.cleanup()
      .catch(() => undefined)
      .finally(() => {
        this.cleaning = false;
      });
  }

  /**
   * Delete rows with no live hit and no active block, CLEANUP_BATCH at a time, until a batch comes back short or
   * `budgetMs` has passed (at least one batch always runs). Returns the number deleted.
   */
  async cleanup(budgetMs = CLEANUP_BUDGET_MS): Promise<number> {
    const started = performance.now();
    let total = 0;
    for (;;) {
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
      const deleted = result.rowCount ?? 0;
      total += deleted;
      if (deleted < CLEANUP_BATCH) {
        this.backlog = false;
        return total;
      }
      if (performance.now() - started >= budgetMs) {
        this.backlog = true;
        return total;
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.fallback.onApplicationShutdown();
    if (this.ownedPool) await this.ownedPool.end().catch(() => undefined);
  }
}

/** The storage the app uses: counters on a dedicated small pool (see limiterPoolOptions), closed with the storage. */
export function createPostgresThrottlerStorage(
  config: Pick<AppConfig, "databaseUrl" | "databaseSsl" | "databaseCaCert" | "rateLimitPoolMax">,
): PostgresThrottlerStorage {
  const pool = new pg.Pool(limiterPoolOptions(config));
  // An idle client dying (DB restart) must not crash the process; the pool replaces it.
  pool.on("error", (error) => new Logger("RateLimit").warn(`idle limiter client error: ${error.message}`));
  return new PostgresThrottlerStorage(new DatabaseService(pool), pool);
}
