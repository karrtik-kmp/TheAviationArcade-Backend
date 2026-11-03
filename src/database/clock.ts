import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Database, Tx } from "./database.module.js";

/**
 * THE clock of every player-facing write (A3, Phase 6). The database server's, so that several backend instances agree:
 * a Round issued on one instance and resulted on another is timed by one clock, and process clocks never decide expiry,
 * the answer-time floor, First Class, the local-date window or a stored timestamp.
 *
 * `clock_timestamp()`, not `transaction_timestamp()`/`now()`: those are the instant the transaction BEGAN, which is
 * before the wait for the player's row lock. A call that waited behind another write would then be stamped EARLIER than
 * the write it follows (older issued_at / evaluatedAt than a committed neighbour), and `evaluatedAt` could not order
 * copies. `clock_timestamp()` read after the lock is the real instant of the judgement. It is wall-clock time, not a
 * monotonic counter: an NTP step or a failover to another server can move it backwards, so nothing here assumes it never
 * does (order stored changes by `players.version` first, and treat `evaluatedAt` as the tiebreak). Truncated to
 * milliseconds, which is what JavaScript Dates and the API carry. Same function as
 * `withLiveStreak`'s `evaluatedAt` (95408e8) and `ugs_budget` (S7).
 *
 * Take it ONCE per transaction, after the player lock (PlayerBalance does, and hands it on as `locked.now`).
 */
export function databaseClock(): SQL {
  return sql`date_trunc('milliseconds', clock_timestamp() + ${testSkewMs}::double precision * interval '1 millisecond')`;
}

/**
 * The same clock at full microsecond precision, as a timestamptz SQL fragment. For stamps that are later compared with
 * `>` against another stamp of the same clock inside SQL (content import receipts vs item edits): at millisecond
 * precision two writes that commit one after the other could share a stamp.
 */
export function databaseClockMicros(): SQL {
  return sql`clock_timestamp() + ${testSkewMs}::double precision * interval '1 millisecond'`;
}

/** The database instant, milliseconds. Prefer `locked.now` inside PlayerBalance.update; this is for the one statement a write makes itself. */
export async function databaseNow(db: Database | Tx): Promise<Date> {
  const result = await db.execute(sql`SELECT ${databaseClock()} AS at`);
  return new Date((result.rows[0] as { at: Date | string }).at);
}

// TEST SEAM. Zero in production and unreachable there. A test shifts "database time" by a fixed offset to show that
// judgements follow it and not the process clock; the offset is added in SQL, so every instance in the process sees it.
let testSkewMs = 0;

/**
 * Test-only: shift the database clock seen by the app by `ms` (0 resets). Refused when APP_ENV is "production" (the
 * codebase's production switch, src/config/config.module.ts) and, as a second guard, when NODE_ENV is "production".
 */
export function setTestDatabaseClockSkew(ms: number): void {
  if (process.env.APP_ENV === "production" || process.env.NODE_ENV === "production") {
    throw new Error("The test clock skew is not available in production.");
  }
  if (!Number.isFinite(ms)) throw new Error("Clock skew must be a finite number of milliseconds.");
  testSkewMs = ms;
}
