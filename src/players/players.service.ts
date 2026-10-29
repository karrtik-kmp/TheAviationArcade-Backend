import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { PlayerBalance } from "../balance/player-balance.js";
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
  constructor(
    private readonly database: DatabaseService,
    private readonly balance: PlayerBalance,
  ) {}

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
   * Runs through PlayerBalance.update (player row lock first), so the existence check, the ceiling check and the
   * UGS mirror enqueue see one consistent row; a player deleted while this waited for the lock is `no_player`.
   * A changed stored value bumps `version` (D-1, 2026-10-29: every change visible in the UGS copy does); setting
   * the value it already has changes nothing and queues nothing.
   */
  async setActiveRank(principal: string, rank: Rank, now: Date): Promise<SetActiveRankOutcome> {
    const result = await this.balance.update<{ aboveCertified: Rank | null }>(principal, now, async ({ player }) => {
      const certified = certifiedRankFor(player.statusPoints);
      if (rankIndex(rank) > rankIndex(certified)) return { value: { aboveCertified: certified } };
      return { value: { aboveCertified: null }, profile: { activeRank: rank === certified ? null : rank } };
    });
    if (result.kind === "no_player") return { kind: "no_player" };
    // A rank change posts nothing, so it can never be refused for funds.
    if (result.kind === "insufficient") throw new Error("Active Rank change was refused for funds.");
    if (result.value.aboveCertified) return { kind: "above_certified", certified: result.value.aboveCertified };
    return { kind: "set", player: result.player };
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
