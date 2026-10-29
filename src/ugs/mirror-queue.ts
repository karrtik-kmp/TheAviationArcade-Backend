import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { DatabaseService } from "../database/database.module.js";
import { players, ugsLinks, ugsMirrorDeletions, ugsMirrorOutbox } from "../db/schema.js";
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
  /** Give a claimed row back (budget spent, paused or stopping) without counting an attempt. Only our own claim. */
  release(claimed: Claimed, dueAt: Date): Promise<void>;
  /** Back a claimed row off: due again at `dueAt`, one more attempt, short error label. Only our own claim. */
  fail(claimed: Claimed, dueAt: Date, label: string): Promise<void>;
  /** Give up on a claimed row for good (a write rejected too often; the next progress change queues afresh). */
  drop(claimed: Claimed): Promise<void>;
  /** Rows due at `now` and the earliest due time among them. */
  backlog(now: Date): Promise<{ count: number; oldest: Date | null }>;
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
async function leaseDue(database: DatabaseService, q: QueueTable, limit: number, now: Date): Promise<Claimed[]> {
  const lease = new Date(now.getTime() + LEASE_MS);
  const result = await database.db.execute(sql`
    WITH picked AS (
      SELECT ${q.key} AS k
      FROM ${q.table}
      WHERE due_at <= ${now.toISOString()}::timestamptz
      ORDER BY due_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${q.table}
    SET due_at = ${lease.toISOString()}::timestamptz, claim_id = gen_random_uuid()
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

async function countDue(database: DatabaseService, table: PgTable, now: Date): Promise<{ count: number; oldest: Date | null }> {
  const result = await database.db.execute(sql`
    SELECT count(*)::int AS n, min(due_at) AS oldest FROM ${table} WHERE due_at <= ${now.toISOString()}::timestamptz
  `);
  const row = result.rows[0] as { n: number; oldest: Date | string | null } | undefined;
  return { count: Number(row?.n ?? 0), oldest: row?.oldest ? new Date(row.oldest) : null };
}

/** Progress writes: one `progress` item per linked player, from ugs_mirror_outbox. */
export class ProgressWriteQueue implements MirrorQueue {
  readonly op = "write" as const;

  constructor(
    private readonly database: DatabaseService,
    private readonly client: UgsClient,
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
    const result = await this.client.writeProgress(row.ugsPlayerId, mirrorSnapshot(row.player, now), signal);
    if (result.kind !== "ok") return result;
    // Only our own claim, and only if nothing was queued meanwhile (a generation is never reused).
    const removed = await this.database.db
      .delete(ugsMirrorOutbox)
      .where(and(mine, eq(ugsMirrorOutbox.generation, claimed.generation)))
      .returning({ playerId: ugsMirrorOutbox.playerId });
    if (removed.length === 0) {
      // Changed while we were writing: due again now. If our claim was lost (lease expired), this matches nothing.
      await this.database.db
        .update(ugsMirrorOutbox)
        .set({ dueAt: now, attempts: 0, lastError: null, claimId: null })
        .where(mine);
    }
    return "done";
  }

  async release(claimed: Claimed, dueAt: Date): Promise<void> {
    await this.database.db.update(ugsMirrorOutbox).set({ dueAt, claimId: null }).where(this.mine(claimed));
  }

  async fail(claimed: Claimed, dueAt: Date, label: string): Promise<void> {
    await this.database.db
      .update(ugsMirrorOutbox)
      .set({ dueAt, attempts: sql`${ugsMirrorOutbox.attempts} + 1`, lastError: label, claimId: null })
      .where(this.mine(claimed));
  }

  async drop(claimed: Claimed): Promise<void> {
    await this.database.db.delete(ugsMirrorOutbox).where(this.mine(claimed));
  }

  backlog(now: Date): Promise<{ count: number; oldest: Date | null }> {
    return countDue(this.database, ugsMirrorOutbox, now);
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

  async release(claimed: Claimed, dueAt: Date): Promise<void> {
    await this.database.db.update(ugsMirrorDeletions).set({ dueAt, claimId: null }).where(this.mine(claimed));
  }

  async fail(claimed: Claimed, dueAt: Date, label: string): Promise<void> {
    await this.database.db
      .update(ugsMirrorDeletions)
      .set({ dueAt, attempts: sql`${ugsMirrorDeletions.attempts} + 1`, lastError: label, claimId: null })
      .where(this.mine(claimed));
  }

  async drop(claimed: Claimed): Promise<void> {
    await this.database.db.delete(ugsMirrorDeletions).where(this.mine(claimed));
  }

  backlog(now: Date): Promise<{ count: number; oldest: Date | null }> {
    return countDue(this.database, ugsMirrorDeletions, now);
  }

  private mine(claimed: Claimed) {
    return and(eq(ugsMirrorDeletions.ugsPlayerId, claimed.key), eq(ugsMirrorDeletions.claimId, claimed.claimId));
  }
}
