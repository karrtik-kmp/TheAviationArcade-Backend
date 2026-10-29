import { eq, sql } from "drizzle-orm";
import type { Tx } from "../database/database.module.js";
import { ugsMirrorDeletions, ugsMirrorOutbox } from "../db/schema.js";
import { mirrorDeletionDueAt } from "../ugs/mirror-policy.js";

// PRIVATE to src/balance: only PlayerBalance imports this file (test/balance-guard.test.ts enforces it). Every
// write to the mirror queue tables happens here, inside a PlayerBalance transaction. The mirror worker only
// claims, updates and deletes the rows these helpers create.

/**
 * Queue a progress mirror for a player. Call it inside the same transaction as the change, after the player row
 * is locked and updated, for EVERY write that changes what GET /v1/me/progress or the mirror shows (balances,
 * hints, streak, Active Rank). A no-op for a player without a UGS link, so unlinked players cost nothing.
 *
 * One row per player (coalescing). `generation` comes from a sequence on insert and on every conflict, so it is
 * unique over the table's whole life: the worker can tell whether anything changed while it was writing, and a row
 * deleted and re-inserted can never repeat a generation a stale worker still holds. On conflict the version keeps
 * its maximum; `due_at` and `claim_id` are left alone so a row that is backing off or claimed stays so.
 */
export async function enqueueMirror(tx: Tx, playerId: string, version: number, now: Date): Promise<void> {
  await tx.execute(sql`
    INSERT INTO ugs_mirror_outbox (player_id, version, due_at, attempts, last_error)
    SELECT ${playerId}, ${version}, ${now.toISOString()}::timestamptz, 0, NULL
    WHERE EXISTS (SELECT 1 FROM ugs_links WHERE player_id = ${playerId})
    ON CONFLICT (player_id) DO UPDATE
      SET version = GREATEST(ugs_mirror_outbox.version, EXCLUDED.version),
          generation = nextval('ugs_mirror_generation_seq')
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
