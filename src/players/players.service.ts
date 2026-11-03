import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { RoleStore } from "../accounts/role-store.js";
import { PlayerBalance } from "../balance/player-balance.js";
import { DatabaseService } from "../database/database.module.js";
import { players } from "../db/schema.js";
import type { PlayerRow } from "../db/schema.js";
import { STARTER_HINTS } from "../rules/hints.js";
import { certifiedRankFor, rankIndex } from "../rules/ranks.js";
import type { Rank } from "../rules/ranks.js";
import { withLiveStreak } from "../trips/trip-store.js";
import type { LivePlayer } from "../trips/trip-store.js";

export type SetActiveRankOutcome =
  | { kind: "set"; player: PlayerRow }
  | { kind: "no_player" }
  | { kind: "above_certified"; certified: Rank };

@Injectable()
export class PlayersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly balance: PlayerBalance,
    private readonly roles: RoleStore,
  ) {}

  async getPlayer(principal: string): Promise<PlayerRow | null> {
    const [player] = await this.database.db.select().from(players).where(eq(players.id, principal));
    return player ?? null;
  }

  /**
   * The Perfect Streak to show (U13): the stored streak belongs to the open Flight Segment, so it reads 0 when no segment
   * is open or the open one has expired (expiry is lazy and the stored value is only reset by the next write). Stamped
   * with the database clock (`evaluatedAt`), the same instant that judged the expiry.
   */
  live(player: PlayerRow): Promise<LivePlayer> {
    return withLiveStreak(this.database.db, player);
  }

  /** Create the player on first sign-in (idempotent and race-safe; see PlayerBalance.open). Starter hints are ledgered. Also issues the `player` role. */
  async ensurePlayer(principal: string): Promise<{ player: PlayerRow; created: boolean }> {
    const opened = await this.balance.open(principal, {
      postings: [{ account: "hints", delta: STARTER_HINTS, kind: "starter", ref: "starter" }],
    });
    // Every sign-in issues the informational `player` role (Backend ADR-0002), in its own short transaction after the player
    // exists. Existing players get it on their next sign-in; a revoked one is never reactivated. Nothing requires it yet.
    await this.roles.issuePlayer(principal);
    return opened;
  }

  /**
   * Dial Active Rank. Choosing Certified clears the stored value so Active follows future promotions again.
   * Runs through PlayerBalance.update (player row lock first), so the existence check, the ceiling check and the
   * UGS mirror enqueue see one consistent row; a player deleted while this waited for the lock is `no_player`.
   * A changed stored value bumps `version` (D-1: version orders stored changes, evaluatedAt the time-derived ones); setting
   * the value it already has changes nothing and queues nothing.
   */
  async setActiveRank(principal: string, rank: Rank): Promise<SetActiveRankOutcome> {
    const result = await this.balance.update<{ aboveCertified: Rank | null }>(principal, async ({ player }) => {
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
  async deletePlayer(principal: string): Promise<boolean> {
    // The requester email kept on a photographer request goes with the account; role rows and audit rows stay.
    await this.roles.clearRequestEmail(principal);
    return this.balance.erase(principal);
  }
}
