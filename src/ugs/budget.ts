import { sql } from "drizzle-orm";
import type { DatabaseService } from "../database/database.module.js";
import { bucketCapacity, refillTokens, TokenBucket } from "./mirror-policy.js";

/**
 * The shared budget for one scarce UGS admin API (D-4). Every backend instance reserves from the same budget before it
 * calls UGS, so the sum of grants across instances is at most `capacity + rate x elapsed`, and a pause set by one
 * instance (a 429, or our credentials refused) stops all of them.
 *
 * Adapters: PostgresUgsBudget (one row of `ugs_budget`, production) and InMemoryUgsBudget (one process: unit tests, and a
 * single-instance fallback). Both share the pure refill step `refillTokens`; test/ugs-budget-contract.ts runs the same
 * contract against both.
 */
export interface UgsBudget {
  /** Take up to `n` whole tokens. Returns 0..n; always 0 while paused. Time is passed in, so tests are deterministic. */
  reserve(n: number, nowMs: number): Promise<number>;
  /** Give back tokens that were reserved but not used (no UGS call was made). Never raises the balance above capacity. */
  refund(n: number, nowMs: number): Promise<void>;
  /**
   * Stop all reservations until `untilMs` (a deadline on the caller's clock, where `nowMs` is "now"). A pause never gets
   * shorter: an earlier deadline than the current one is ignored. The database adapter keeps only the duration
   * `untilMs - nowMs` and applies it to database time, so a process whose clock is off pauses everyone for the right time.
   */
  pause(untilMs: number, nowMs: number): Promise<void>;
  /** True while a pause is in force at `nowMs` (for logging; reserve() already returns 0 then). */
  isPaused(nowMs: number): Promise<boolean>;
}

/** Row names in `ugs_budget`. */
export const CLOUD_SAVE_BUDGET = "cloud_save_admin";
export const PLAYER_AUTH_BUDGET = "player_auth_admin";

/** One process. Wraps the TokenBucket and a pause deadline. */
export class InMemoryUgsBudget implements UgsBudget {
  private readonly bucket: TokenBucket;
  private pausedUntil = 0;

  constructor(perMin: number, now: number, capacity: number = bucketCapacity(perMin)) {
    this.bucket = new TokenBucket(perMin, now, capacity);
  }

  /** Full bucket, no pause (tests). */
  reset(now: number): void {
    this.bucket.reset(now);
    this.pausedUntil = 0;
  }

  async reserve(n: number, nowMs: number): Promise<number> {
    if (nowMs < this.pausedUntil) return 0;
    return this.bucket.takeUpTo(n, nowMs);
  }

  async refund(n: number, nowMs: number): Promise<void> {
    this.bucket.giveBack(n, nowMs);
  }

  async pause(untilMs: number, _nowMs: number): Promise<void> {
    this.pausedUntil = Math.max(this.pausedUntil, untilMs);
  }

  async isPaused(nowMs: number): Promise<boolean> {
    return nowMs < this.pausedUntil;
  }
}

type BudgetRow = { tokens: number; refilled_at: Date | string; paused_until: Date | string | null; db_now: Date | string };

/**
 * Whose clock PostgresUgsBudget uses for refill and pause arithmetic. "database" (production): `clock_timestamp()` of the
 * database server, one clock for every instance, so a process with a wrong clock cannot freeze or inflate the shared
 * budget; the `nowMs` arguments are ignored (except `pause`, which takes the duration from them). "caller": the
 * `nowMs` passed in; only for tests with an explicit clock.
 */
export type BudgetTime = "database" | "caller";

/**
 * One row of `ugs_budget`, shared by every instance. `reserve` runs in one short transaction: SELECT ... FOR UPDATE on
 * the row, the pure refill step, UPDATE. No network call happens while the row is locked (nothing here calls UGS).
 * `refund` and `pause` are single atomic statements. Rate and burst come from configuration, not from the row, so every
 * instance must run the same UGS_MIRROR_MAX_PER_MIN. The row is created on first use, full.
 */
export class PostgresUgsBudget implements UgsBudget {
  constructor(
    private readonly database: DatabaseService,
    private readonly name: string,
    private readonly perMin: number,
    private readonly capacity: number = bucketCapacity(perMin),
    private readonly time: BudgetTime = "database",
  ) {}

  /** SQL for "now": database time or the caller's. */
  private nowSql(nowMs: number) {
    return this.time === "database" ? sql`clock_timestamp()` : sql`${new Date(nowMs).toISOString()}::timestamptz`;
  }

  async reserve(n: number, nowMs: number): Promise<number> {
    const want = Math.floor(n);
    if (want <= 0) return 0;
    return this.database.withTransaction(async (tx) => {
      const lock = () =>
        tx.execute(sql`
          SELECT tokens, refilled_at, paused_until, ${this.nowSql(nowMs)} AS db_now FROM ugs_budget WHERE name = ${this.name} FOR UPDATE
        `);
      let [row] = (await lock()).rows as BudgetRow[];
      if (!row) {
        await tx.execute(sql`
          INSERT INTO ugs_budget (name, tokens, refilled_at)
          VALUES (${this.name}, ${this.capacity}, ${this.nowSql(nowMs)})
          ON CONFLICT (name) DO NOTHING
        `);
        [row] = (await lock()).rows as BudgetRow[];
      }
      if (!row) throw new Error("ugs_budget row missing after insert.");
      // Evaluated after the row lock, so successive reservations see a non-decreasing clock.
      const now = new Date(row.db_now).getTime();
      const refilled = refillTokens(Number(row.tokens), new Date(row.refilled_at).getTime(), now, this.perMin, this.capacity);
      const pausedUntil = row.paused_until ? new Date(row.paused_until).getTime() : 0;
      const granted = now < pausedUntil ? 0 : Math.min(want, Math.floor(refilled.tokens));
      await tx.execute(sql`
        UPDATE ugs_budget
        SET tokens = ${Math.max(0, refilled.tokens - granted)}, refilled_at = ${new Date(refilled.last).toISOString()}::timestamptz
        WHERE name = ${this.name}
      `);
      return granted;
    });
  }

  async refund(n: number, _nowMs: number): Promise<void> {
    const back = Math.floor(n);
    if (back <= 0) return;
    // Tokens only ever go back up to capacity; refilled_at is untouched (tokens are "as of refilled_at").
    await this.database.db.execute(sql`
      UPDATE ugs_budget SET tokens = LEAST(${this.capacity}::double precision, tokens + ${back}) WHERE name = ${this.name}
    `);
  }

  async pause(untilMs: number, nowMs: number): Promise<void> {
    const until =
      this.time === "database"
        ? sql`clock_timestamp() + ${Math.max(0, untilMs - nowMs)}::double precision * interval '1 millisecond'`
        : sql`${new Date(untilMs).toISOString()}::timestamptz`;
    await this.database.db.execute(sql`
      INSERT INTO ugs_budget (name, tokens, refilled_at, paused_until)
      VALUES (${this.name}, ${this.capacity}, ${this.nowSql(nowMs)}, ${until})
      ON CONFLICT (name) DO UPDATE
        SET paused_until = GREATEST(coalesce(ugs_budget.paused_until, EXCLUDED.paused_until), EXCLUDED.paused_until)
    `);
  }

  async isPaused(nowMs: number): Promise<boolean> {
    const result = await this.database.db.execute(
      sql`SELECT coalesce(paused_until > ${this.nowSql(nowMs)}, false) AS paused FROM ugs_budget WHERE name = ${this.name}`,
    );
    return (result.rows[0] as { paused: boolean } | undefined)?.paused === true;
  }
}
