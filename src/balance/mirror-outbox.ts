import { eq, sql } from "drizzle-orm";
import type { Tx } from "../database/database.module.js";
import { ugsMirrorDeletions, ugsMirrorOutbox } from "../db/schema.js";
import { mirrorDeletionDueAt } from "../ugs/mirror-policy.js";

// PRIVATE to src/balance: only PlayerBalance imports this file (test/balance-guard.test.ts enforces it). Every
// write to the mirror queue tables happens here, inside a PlayerBalance transaction. The mirror worker only
// claims, updates and deletes the rows these helpers create.

export type EnqueueOptions = {
  /** UGS_MIRROR_MIN_INTERVAL_SEC (C3): the least time between two copy writes for one player; 0 = no delay. */
  minIntervalSec: number;
  /**
   * The hook for a write that must not wait (the "write at Trip end" trigger, set by completing a Flight Segment): the row is due
   * at `now` even inside the interval. A waiting row (not claimed, not backing off) is pulled forward to `now`; a
   * claimed row cannot be (due_at is its lease), so the request is kept in `urgent` and the worker's "changed while
   * writing" reset makes it due now.
   */
  dueNow?: boolean;
};

/**
 * Queue a progress mirror for a player. Call it inside the same transaction as the change, after the player row
 * is locked and updated, for EVERY write that changes what GET /v1/me/progress or the mirror shows (balances,
 * hints, streak, Active Rank). A no-op for a player without a UGS link, so unlinked players cost nothing.
 *
 * One row per player (coalescing). `generation` comes from a sequence on insert and on every conflict, so it is
 * unique over the table's whole life: the worker can tell whether anything changed while it was writing, and a row
 * deleted and re-inserted can never repeat a generation a stale worker still holds. On conflict the version keeps
 * its maximum and `claim_id` is left alone. A row that is claimed or backing off (attempts > 0) keeps its `due_at`; a
 * waiting row (unclaimed, attempts 0) takes the EARLIER of its due time and the one this enqueue computes, which
 * is the same time for a Round on the same link (coalescing: one write at the latest version when the interval is up) but
 * earlier after a re-link or link move (no pace row for the new UGS player: due now, so the first write after a link is
 * immediate) and for an urgent enqueue. An urgent enqueue that lands on a claimed row sets `urgent` (see the column).
 *
 * C3 interval: a new row is due at GREATEST(now, last_mirrored_at + interval) where last_mirrored_at comes from
 * ugs_mirror_pace for the CURRENT link. No pace row for this UGS player (never written since the link, a re-link, a
 * link move) means due now, so the first write after a link is immediate. The same rule is mirrorDueAt() in
 * src/ugs/mirror-policy.ts, which tests pin to this SQL.
 */
export async function enqueueMirror(tx: Tx, playerId: string, version: number, now: Date, options: EnqueueOptions): Promise<void> {
  const nowIso = now.toISOString();
  const urgent = options.dueNow === true;
  await tx.execute(sql`
    INSERT INTO ugs_mirror_outbox (player_id, version, due_at, attempts, last_error)
    SELECT l.player_id, ${version},
      CASE WHEN ${urgent}::boolean OR ${options.minIntervalSec}::int <= 0 OR pace.last_mirrored_at IS NULL
        THEN ${nowIso}::timestamptz
        ELSE GREATEST(${nowIso}::timestamptz, pace.last_mirrored_at + ${options.minIntervalSec}::int * interval '1 second')
      END,
      0, NULL
    FROM ugs_links l
    LEFT JOIN ugs_mirror_pace pace ON pace.player_id = l.player_id AND pace.ugs_player_id = l.ugs_player_id
    WHERE l.player_id = ${playerId}
    ON CONFLICT (player_id) DO UPDATE
      SET version = GREATEST(ugs_mirror_outbox.version, EXCLUDED.version),
          generation = nextval('ugs_mirror_generation_seq'),
          due_at = CASE
            WHEN ugs_mirror_outbox.claim_id IS NULL AND ugs_mirror_outbox.attempts = 0
              THEN LEAST(ugs_mirror_outbox.due_at, EXCLUDED.due_at)
            ELSE ugs_mirror_outbox.due_at
          END,
          urgent = ugs_mirror_outbox.urgent OR (${urgent}::boolean AND ugs_mirror_outbox.claim_id IS NOT NULL)
  `);
}

/**
 * Record that a UGS player's Cloud Save copy must be deleted. The UGS item cannot be deleted inside a player lock (no
 * network there), so the mirror worker does it later. Due only after any write another instance has in flight can
 * have finished (mirrorDeletionDueAt), so that write cannot recreate the copy. Re-queuing the same UGS id moves its due time.
 */
export async function queueMirrorDeletion(tx: Tx, ugsPlayerId: string, now: Date): Promise<void> {
  await tx
    .insert(ugsMirrorDeletions)
    .values({ ugsPlayerId, dueAt: mirrorDeletionDueAt(now), createdAt: now })
    .onConflictDoUpdate({ target: ugsMirrorDeletions.ugsPlayerId, set: { dueAt: mirrorDeletionDueAt(now) } });
}

/** A deletion queued for this UGS id (an earlier account) must not wipe a mirror we are about to write. */
export async function cancelMirrorDeletion(tx: Tx, ugsPlayerId: string): Promise<void> {
  await tx.delete(ugsMirrorDeletions).where(eq(ugsMirrorDeletions.ugsPlayerId, ugsPlayerId));
}

/** Drop a player's queued mirror (a stale link holder that lost its UGS player). */
export async function dropMirror(tx: Tx, playerId: string): Promise<void> {
  await tx.delete(ugsMirrorOutbox).where(eq(ugsMirrorOutbox.playerId, playerId));
}
