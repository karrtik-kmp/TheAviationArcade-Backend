import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../database/database.module.js";
import { hintLedger, players, ugsLinks, ugsMirrorDeletions } from "../db/schema.js";
import type { PlayerRow } from "../db/schema.js";
import { STARTER_HINTS } from "../rules/hints.js";
import { certifiedRankFor, rankIndex } from "../rules/ranks.js";
import type { Rank } from "../rules/ranks.js";
import { mirrorDeletionDueAt } from "../ugs/mirror-policy.js";
import { enqueueMirror } from "../ugs/outbox.js";

export type SetActiveRankOutcome =
  | { kind: "set"; player: PlayerRow }
  | { kind: "no_player" }
  | { kind: "above_certified"; certified: Rank };

@Injectable()
export class PlayersService {
  constructor(private readonly database: DatabaseService) {}

  async getPlayer(principal: string): Promise<PlayerRow | null> {
    const [player] = await this.database.db.select().from(players).where(eq(players.id, principal));
    return player ?? null;
  }

  /**
   * Create the player on first sign-in. Idempotent and race-safe: ON CONFLICT DO NOTHING means exactly
   * one concurrent caller sees created = true, and an existing player is returned unchanged. The starter
   * hints and their ledger entry are written in the same transaction as the row, by that one caller only.
   */
  async ensurePlayer(principal: string, now: Date): Promise<{ player: PlayerRow; created: boolean }> {
    return this.database.withTransaction(async (tx) => {
      const inserted = await tx
        .insert(players)
        .values({ id: principal, hints: STARTER_HINTS, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning({ id: players.id });
      if (inserted.length === 1) {
        await tx
          .insert(hintLedger)
          .values({ playerId: principal, delta: STARTER_HINTS, kind: "starter", ref: "starter", createdAt: now });
        // A brand-new player has no UGS link yet (a deleted account's link went with it), so this is a no-op
        // today; it keeps every progress-creating write on the same rule.
        await enqueueMirror(tx, principal, 1, now);
      }
      const [player] = await tx.select().from(players).where(eq(players.id, principal));
      if (!player) throw new Error("Player row missing after insert.");
      return { player, created: inserted.length === 1 };
    });
  }

  /**
   * Dial Active Rank. Choosing Certified clears the stored value so Active follows future promotions again.
   * Runs under the player row lock like every other progress write, so the existence check, the ceiling check and
   * the UGS mirror enqueue see one consistent row; a player deleted while this waited for the lock is `no_player`.
   * The version is deliberately NOT bumped yet: Round scoring uses the rank snapshotted at issue, and this is not a
   * balance change (D-1, 2026-10-29, moves the bump into PlayerBalance in S2/S3). The mirror still carries Active
   * Rank, so it is enqueued (its generation, not the version, records the change).
   */
  async setActiveRank(principal: string, rank: Rank, now: Date): Promise<SetActiveRankOutcome> {
    return this.database.withTransaction(async (tx) => {
      const [locked] = await tx.select().from(players).where(eq(players.id, principal)).for("update");
      if (!locked) return { kind: "no_player" };
      const certified = certifiedRankFor(locked.statusPoints);
      if (rankIndex(rank) > rankIndex(certified)) return { kind: "above_certified", certified };
      const stored = rank === certified ? null : rank;
      const [updated] = await tx
        .update(players)
        .set({ activeRank: stored, updatedAt: now })
        .where(eq(players.id, principal))
        .returning();
      // The row is locked, so it cannot vanish between the SELECT and the UPDATE.
      if (!updated) throw new Error("Locked player row was not updated.");
      if (locked.activeRank !== stored) await enqueueMirror(tx, updated.id, updated.version, now);
      return { kind: "set", player: updated };
    });
  }

  /**
   * Erase this backend's data for the principal: the player row, and its Rounds and ledgers via ON DELETE CASCADE.
   * Takes the same player row lock as completeRound/issueRound first, so an in-flight Round result
   * either commits before the delete or finds no player afterwards (404). Idempotent: deleting a
   * missing player is a no-op. Returns whether a player existed.
   */
  async deletePlayer(principal: string, now: Date = new Date()): Promise<boolean> {
    return this.database.withTransaction(async (tx) => {
      const [player] = await tx
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, principal))
        .for("update");
      if (!player) return false;
      // The UGS copy cannot be deleted inside this lock (no network here): record the UGS id, and the mirror
      // worker deletes the Cloud Save item. The link and any outbox row go with the player (cascade). Due only
      // after any write another instance has in flight can have finished, so it cannot recreate the copy.
      const [link] = await tx.select().from(ugsLinks).where(eq(ugsLinks.playerId, principal));
      if (link) {
        await tx
          .insert(ugsMirrorDeletions)
          .values({ ugsPlayerId: link.ugsPlayerId, dueAt: mirrorDeletionDueAt(now), createdAt: now })
          .onConflictDoUpdate({ target: ugsMirrorDeletions.ugsPlayerId, set: { dueAt: mirrorDeletionDueAt(now) } });
      }
      await tx.delete(players).where(eq(players.id, principal));
      return true;
    });
  }
}
