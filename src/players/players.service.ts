import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../database/database.module.js";
import { players } from "../db/schema.js";
import type { PlayerRow } from "../db/schema.js";
import { certifiedRankFor, rankIndex } from "../rules/ranks.js";
import type { Rank } from "../rules/ranks.js";

@Injectable()
export class PlayersService {
  constructor(private readonly database: DatabaseService) {}

  async getPlayer(principal: string): Promise<PlayerRow | null> {
    const [player] = await this.database.db.select().from(players).where(eq(players.id, principal));
    return player ?? null;
  }

  /**
   * Create the player on first sign-in. Idempotent and race-safe: ON CONFLICT DO NOTHING means exactly
   * one concurrent caller sees created = true, and an existing player is returned unchanged.
   */
  async ensurePlayer(principal: string, now: Date): Promise<{ player: PlayerRow; created: boolean }> {
    return this.database.withTransaction(async (tx) => {
      const inserted = await tx
        .insert(players)
        .values({ id: principal, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning({ id: players.id });
      const [player] = await tx.select().from(players).where(eq(players.id, principal));
      if (!player) throw new Error("Player row missing after insert.");
      return { player, created: inserted.length === 1 };
    });
  }

  /**
   * Dial Active Rank. Returns null when the rank is above Certified. Choosing Certified clears the
   * stored value so Active follows future promotions again. No lock is needed for the ceiling check
   * because Certified Rank never drops. The version is deliberately NOT bumped: Round scoring uses the
   * rank snapshotted at issue, and this is not a balance change.
   */
  async setActiveRank(player: PlayerRow, rank: Rank, now: Date): Promise<PlayerRow | null> {
    const certified = certifiedRankFor(player.statusPoints);
    if (rankIndex(rank) > rankIndex(certified)) return null;
    const stored = rank === certified ? null : rank;
    const [updated] = await this.database.db
      .update(players)
      .set({ activeRank: stored, updatedAt: now })
      .where(eq(players.id, player.id))
      .returning();
    return updated ?? null;
  }

  /**
   * Erase this backend's data for the principal: the player row, and its Rounds via ON DELETE CASCADE.
   * Takes the same player row lock as completeRound/issueRound first, so an in-flight Round result
   * either commits before the delete or finds no player afterwards (404). Idempotent: deleting a
   * missing player is a no-op. Returns whether a player existed.
   */
  async deletePlayer(principal: string): Promise<boolean> {
    return this.database.withTransaction(async (tx) => {
      const [player] = await tx
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, principal))
        .for("update");
      if (!player) return false;
      await tx.delete(players).where(eq(players.id, principal));
      return true;
    });
  }
}
