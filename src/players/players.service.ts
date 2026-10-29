import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { PlayerBalance } from "../balance/player-balance.js";
import { DatabaseService } from "../database/database.module.js";
import { players } from "../db/schema.js";
import type { PlayerRow } from "../db/schema.js";
import { STARTER_HINTS } from "../rules/hints.js";
import { certifiedRankFor, rankIndex } from "../rules/ranks.js";
import type { Rank } from "../rules/ranks.js";

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

  /** Create the player on first sign-in (idempotent and race-safe; see PlayerBalance.open). Starter hints are ledgered. */
  async ensurePlayer(principal: string, now: Date): Promise<{ player: PlayerRow; created: boolean }> {
    return this.balance.open(principal, now, {
      postings: [{ account: "hints", delta: STARTER_HINTS, kind: "starter", ref: "starter" }],
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

  /** Erase this backend data for the principal (PlayerBalance.erase). Idempotent. Returns whether a player existed. */
  async deletePlayer(principal: string, now: Date): Promise<boolean> {
    return this.balance.erase(principal, now);
  }
}
