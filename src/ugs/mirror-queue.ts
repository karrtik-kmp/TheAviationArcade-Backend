import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { rootCause } from "../database/database-errors.js";
import type { DatabaseService } from "../database/database.module.js";
import { players, ugsLinks, ugsMirrorDeletions, ugsMirrorOutbox } from "../db/schema.js";
import { withLiveStreak } from "../trips/trip-store.js";
import { LEASE_MS, mirrorSnapshot } from "./mirror-policy.js";
import type { UgsClient, WriteResult } from "./ugs-client.js";

// The mirror worker's seam to its two queues. The worker owns policy (pacing, pauses, backoff, logging, which
// result means what); a queue owns its table: how rows are claimed, what finishing one means, how it is given back.
// Adapters: ProgressWriteQueue (ugs_mirror_outbox), CopyDeletionQueue (ugs_mirror_deletions) and, for unit tests of
// the worker, an in-memory queue (test/in-memory-mirror-queue.ts).
//
// Why the Postgres adapters live here in src/ugs and not in src/balance: they only claim, update and delete rows
// that PlayerBalance inserted (test/balance-guard.test.ts allows exactly that, per file, in READ_ONLY_IMPORTERS).
// Nothing here inserts into a queue table or calls an enqueue helper; those stay private to src/balance.

/**
 * Whose clock the Postgres queue adapters use for every time they compare or store (A3 review; same rule as the shared
 * budget, src/ugs/budget.ts). "database" (production): `clock_timestamp()` computed in SQL, so claim, lease, release,
 * back-off, the pace record and the backlog all use the clock that `enqueueMirror` and `mirrorDeletionDueAt` stamp `due_at`
 * with (the database's, since A3). The `now` arguments are then ignored, except that `release`/`fail` take the DELAY
 * (`dueAt - now`) from them and apply it to database time. "caller": the `now` passed in; only for tests that drive
 * ticks with explicit clocks.
 */
export type QueueTime = "database" | "caller";

/** SQL for "now" in the chosen mode. */
function nowSql(time: QueueTime, now: Date): SQL {
  return time === "database" ? sql`clock_timestamp()` : sql`${now.toISOString()}::timestamptz`;
}

/** SQL for the instant `dueAt` that the worker computed as `now + delay`: the same delay after database time, or `dueAt` itself. */
function dueSql(time: QueueTime, dueAt: Date, now: Date): SQL {
  if (time === "caller") return sql`${dueAt.toISOString()}::timestamptz`;
  const delayMs = Math.max(0, dueAt.getTime() - now.getTime());
  return sql`clock_timestamp() + ${delayMs}::double precision * interval '1 millisecond'`;
}

/** A row this worker has leased. `key` is the player id (writes) or the UGS player id (deletions). */
export type Claimed = { key: string; generation: number; claimId: string; attempts: number };

/** What `process` returns when UGS answered but the row is not finished (the worker decides what each means). */
export type Unfinished = Exclude<WriteResult, { kind: "ok" }>;
export type ProcessResult = "done" | Unfinished;

export interface MirrorQueue {
  /** Which kind of UGS call this queue makes; the worker keys its once-only rejection log by `${op}:${key}`. */
  readonly op: "write" | "delete";
  /** Lease up to `limit` due rows (due_at becomes now + LEASE_MS, claim_id a fresh value). Safe across instances. */
  claim(limit: number, now: Date): Promise<Claimed[]>;
  /**
   * Make the UGS call for a claimed row and finish it if it succeeded. An HTTP outcome comes back as a result, not
   * a throw; a database error still throws and rejects the whole tick (there is no per-row isolation).
   */
  process(claimed: Claimed, now: Date, signal: AbortSignal): Promise<ProcessResult>;
  /**
   * Give a claimed row back (budget spent, paused or stopping) without counting an attempt. Only our own claim.
   * `dueAt` is `now + delay` on the caller's clock; a database-clock adapter applies the delay to database time.
   */
  release(claimed: Claimed, dueAt: Date, now: Date): Promise<void>;
  /** Back a claimed row off: due again at `dueAt` (as for `release`), one more attempt, short error label. Only our own claim. */
  fail(claimed: Claimed, dueAt: Date, label: string, now: Date): Promise<void>;
  /** Give up on a claimed row for good (a write rejected too often; the next progress change queues afresh). */
  drop(claimed: Claimed): Promise<void>;
  /** Rows due at `now` and how long the oldest has been due (0 when none), measured on the queue's own clock. */
  backlog(now: Date): Promise<{ count: number; lagMs: number }>;
}

type QueueTable = {
  table: PgTable;
  /** The column the queue is keyed by. */
  key: PgColumn;
  claimId: PgColumn;
  attempts: PgColumn;
  /** What the claim reports as `generation`: the column, or a constant for a queue without generations. */
  generation: SQL;
};

/**
 * Claim up to `limit` due rows in one UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED): due_at becomes a lease and
 * claim_id a fresh uuid, so several instances never share a row and no lock is held across a network call.
 * Both queue tables name their lease columns `due_at` and `claim_id`; the rest comes from the typed handles.
 */
async function leaseDue(database: DatabaseService, q: QueueTable, limit: number, now: Date, time: QueueTime): Promise<Claimed[]> {
  const at = nowSql(time, now);
  const result = await database.db.execute(sql`
    WITH picked AS (
      SELECT ${q.key} AS k
      FROM ${q.table}
      WHERE due_at <= ${at}
      ORDER BY due_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${q.table}
    SET due_at = ${at} + ${LEASE_MS}::double precision * interval '1 millisecond', claim_id = gen_random_uuid()
    FROM picked
    WHERE ${q.key} = picked.k
    RETURNING ${q.key} AS key, ${q.generation} AS generation, ${q.claimId} AS claim_id, ${q.attempts} AS attempts
  `);
  return (result.rows as { key: string; generation: string | number; claim_id: string; attempts: number }[]).map((row) => ({
    key: row.key,
    generation: Number(row.generation),
    claimId: row.claim_id,
    attempts: Number(row.attempts),
  }));
}

async function countDue(database: DatabaseService, table: PgTable, now: Date, time: QueueTime): Promise<{ count: number; lagMs: number }> {
  const at = nowSql(time, now);
  const result = await database.db.execute(sql`
    SELECT count(*)::int AS n, coalesce(extract(epoch FROM (${at} - min(due_at))) * 1000, 0)::double precision AS lag_ms
    FROM ${table} WHERE due_at <= ${at}
  `);
  const row = result.rows[0] as { n: number; lag_ms: number | string } | undefined;
  return { count: Number(row?.n ?? 0), lagMs: Math.max(0, Math.round(Number(row?.lag_ms ?? 0))) };
}

/**
 * Progress writes: one `progress` item per linked player, from ugs_mirror_outbox. With `minIntervalSec` > 0 (C3,
 * UGS_MIRROR_MIN_INTERVAL_SEC) a successful write records `ugs_mirror_pace.last_mirrored_at`, and a row that was changed
 * while it was being written is due again as a new enqueue would be (resetChanged): `minIntervalSec` after that write, but
 * now after a re-link or when an urgent enqueue landed meanwhile. The enqueue side (src/balance) uses the
 * same record to delay a new row; deletions never wait.
 */
export class ProgressWriteQueue implements MirrorQueue {
  readonly op = "write" as const;

  constructor(
    private readonly database: DatabaseService,
    private readonly client: UgsClient,
    private readonly minIntervalSec = 0,
    private readonly time: QueueTime = "database",
  ) {}

  claim(limit: number, now: Date): Promise<Claimed[]> {
    return leaseDue(
      this.database,
      {
        table: ugsMirrorOutbox,
        key: ugsMirrorOutbox.playerId,
        claimId: ugsMirrorOutbox.claimId,
        attempts: ugsMirrorOutbox.attempts,
        generation: sql`${ugsMirrorOutbox.generation}`,
      },
      limit,
      now,
      this.time,
    );
  }

  async process(claimed: Claimed, now: Date, signal: AbortSignal): Promise<ProcessResult> {
    const mine = this.mine(claimed);
    const [row] = await this.database.db
      .select({ player: players, ugsPlayerId: ugsLinks.ugsPlayerId })
      .from(players)
      .innerJoin(ugsLinks, eq(ugsLinks.playerId, players.id))
      .where(eq(players.id, claimed.key));
    if (!row) {
      // Deleted or unlinked since it was queued: nothing to mirror.
      await this.database.db.delete(ugsMirrorOutbox).where(mine);
      return "done";
    }
    const result = await this.client.writeProgress(row.ugsPlayerId, mirrorSnapshot(await withLiveStreak(this.database.db, row.player)), signal);
    if (result.kind !== "ok") return result;
    // Recorded BEFORE the row is removed: a Round that commits in between hits the outbox conflict, and one that
    // commits after the delete inserts a row that already sees this write time.
    await this.recordWrite(claimed.key, row.ugsPlayerId, now);
    // Only our own claim, and only if nothing was queued meanwhile (a generation is never reused).
    const removed = await this.database.db
      .delete(ugsMirrorOutbox)
      .where(and(mine, eq(ugsMirrorOutbox.generation, claimed.generation)))
      .returning({ playerId: ugsMirrorOutbox.playerId });
    if (removed.length === 0) await this.resetChanged(claimed, now);
    return "done";
  }

  /**
   * The row changed while we were writing: give it back, due again as a NEW enqueue would be. Due time = `urgent` or no
   * interval: now; else mirrorDueAt() from the pace row of the player's CURRENT link, which is one interval after the
   * write we just recorded, or now when there is no matching pace row (the player re-linked or moved while we wrote,
   * so the UGS player we wrote to is no longer the link and the new one has never been written). A claim that was
   * lost (lease expired) matches nothing. Clears `urgent`.
   */
  private async resetChanged(claimed: Claimed, now: Date): Promise<void> {
    const at = nowSql(this.time, now);
    await this.database.db.execute(sql`
      UPDATE ugs_mirror_outbox o
      SET due_at = CASE
            WHEN o.urgent OR ${this.minIntervalSec}::int <= 0 THEN ${at}
            ELSE coalesce(
              (SELECT GREATEST(${at}, p.last_mirrored_at + ${this.minIntervalSec}::int * interval '1 second')
               FROM ugs_links l JOIN ugs_mirror_pace p ON p.player_id = l.player_id AND p.ugs_player_id = l.ugs_player_id
               WHERE l.player_id = o.player_id),
              ${at})
          END,
          attempts = 0, last_error = NULL, claim_id = NULL, urgent = false
      WHERE o.player_id = ${claimed.key} AND o.claim_id = ${claimed.claimId}::uuid
    `);
  }

  /**
   * Remember when this UGS player's copy was last written. Only while the player still has this very link: a player
   * deleted or re-linked while the write was in flight (the FK or the link check) simply records nothing.
   */
  private async recordWrite(playerId: string, ugsPlayerId: string, now: Date): Promise<void> {
    try {
      await this.database.db.execute(sql`
        INSERT INTO ugs_mirror_pace (player_id, ugs_player_id, last_mirrored_at)
        SELECT player_id, ugs_player_id, ${nowSql(this.time, now)}
        FROM ugs_links WHERE player_id = ${playerId} AND ugs_player_id = ${ugsPlayerId}
        ON CONFLICT (player_id) DO UPDATE SET ugs_player_id = EXCLUDED.ugs_player_id, last_mirrored_at = EXCLUDED.last_mirrored_at
      `);
    } catch (error) {
      if ((rootCause(error) as { code?: unknown } | null)?.code !== "23503") throw error; // the player vanished just now
    }
  }

  async release(claimed: Claimed, dueAt: Date, now: Date): Promise<void> {
    await this.database.db
      .update(ugsMirrorOutbox)
      .set({ dueAt: dueSql(this.time, dueAt, now), claimId: null, urgent: false })
      .where(this.mine(claimed));
  }

  async fail(claimed: Claimed, dueAt: Date, label: string, now: Date): Promise<void> {
    await this.database.db
      .update(ugsMirrorOutbox)
      .set({ dueAt: dueSql(this.time, dueAt, now), attempts: sql`${ugsMirrorOutbox.attempts} + 1`, lastError: label, claimId: null, urgent: false })
      .where(this.mine(claimed));
  }

  async drop(claimed: Claimed): Promise<void> {
    await this.database.db.delete(ugsMirrorOutbox).where(this.mine(claimed));
  }

  backlog(now: Date): Promise<{ count: number; lagMs: number }> {
    return countDue(this.database, ugsMirrorOutbox, now, this.time);
  }

  private mine(claimed: Claimed) {
    return and(eq(ugsMirrorOutbox.playerId, claimed.key), eq(ugsMirrorOutbox.claimId, claimed.claimId));
  }
}

/** Cloud Save copies to delete after an account deletion or a link move, from ugs_mirror_deletions. */
export class CopyDeletionQueue implements MirrorQueue {
  readonly op = "delete" as const;

  constructor(
    private readonly database: DatabaseService,
    private readonly client: UgsClient,
    private readonly time: QueueTime = "database",
  ) {}

  claim(limit: number, now: Date): Promise<Claimed[]> {
    return leaseDue(
      this.database,
      {
        table: ugsMirrorDeletions,
        key: ugsMirrorDeletions.ugsPlayerId,
        claimId: ugsMirrorDeletions.claimId,
        attempts: ugsMirrorDeletions.attempts,
        generation: sql`0`,
      },
      limit,
      now,
      this.time,
    );
  }

  async process(claimed: Claimed, _now: Date, signal: AbortSignal): Promise<ProcessResult> {
    // If the same UGS id was linked again meanwhile, its mirror is live again: drop the stale deletion.
    const [linked] = await this.database.db.select({ id: ugsLinks.playerId }).from(ugsLinks).where(eq(ugsLinks.ugsPlayerId, claimed.key));
    if (!linked) {
      const result = await this.client.deleteProgress(claimed.key, signal);
      if (result.kind !== "ok") return result;
    }
    await this.database.db.delete(ugsMirrorDeletions).where(this.mine(claimed));
    return "done";
  }

  async release(claimed: Claimed, dueAt: Date, now: Date): Promise<void> {
    await this.database.db
      .update(ugsMirrorDeletions)
      .set({ dueAt: dueSql(this.time, dueAt, now), claimId: null })
      .where(this.mine(claimed));
  }

  async fail(claimed: Claimed, dueAt: Date, label: string, now: Date): Promise<void> {
    await this.database.db
      .update(ugsMirrorDeletions)
      .set({ dueAt: dueSql(this.time, dueAt, now), attempts: sql`${ugsMirrorDeletions.attempts} + 1`, lastError: label, claimId: null })
      .where(this.mine(claimed));
  }

  async drop(claimed: Claimed): Promise<void> {
    await this.database.db.delete(ugsMirrorDeletions).where(this.mine(claimed));
  }

  backlog(now: Date): Promise<{ count: number; lagMs: number }> {
    return countDue(this.database, ugsMirrorDeletions, now, this.time);
  }

  private mine(claimed: Claimed) {
    return and(eq(ugsMirrorDeletions.ugsPlayerId, claimed.key), eq(ugsMirrorDeletions.claimId, claimed.claimId));
  }
}
