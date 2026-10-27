import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DATABASE } from "../database/database.module.js";
import type { Database } from "../database/database.module.js";
import { players, rounds } from "../db/schema.js";
import type { PlayerRow, RoundRow } from "../db/schema.js";
import { hasFirstClassPass } from "../players/progress-view.js";
import type { ModuleId } from "../rules/modules.js";
import { activeRankFor, certifiedRankFor, rankIndex } from "../rules/ranks.js";
import type { Rank } from "../rules/ranks.js";
import { nextPerfectStreak, scoreRound } from "../rules/scoring.js";
import type { Completion, RoundAward } from "../rules/scoring.js";

export const ROUND_TTL_SECONDS = 30 * 60;

/**
 * PROVISIONAL. A result arriving sooner than this after the Round was issued is refused as
 * impossibly fast. Per-module and per-rank timer lengths are not specified yet (only ATC Match and
 * Call Sign Match have one), so this is a single floor to stop instant-submit farming. Needs Josh.
 */
export const MIN_ROUND_MS = 3000;

export type IssuedRound = {
  roundId: string;
  module: ModuleId;
  rank: Rank;
  pleasureCruise: boolean;
  expiresAt: string;
};

export type RoundResultInput = {
  finished: boolean;
  errorCount: number;
  usedHint: boolean;
  timeRemainingFraction: number;
};

export type CompletedRound = {
  award: RoundAward & { firstClassPass: boolean; pleasureCruise: boolean };
  player: PlayerRow;
  promotion: { from: Rank; to: Rank } | null;
  replayed: boolean;
};

export type CompleteRoundOutcome =
  | { kind: "completed"; result: CompletedRound }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "closed" }
  | { kind: "too_fast" };

function storedAward(round: RoundRow): CompletedRound["award"] {
  return {
    completion: (round.completion as Completion | null) ?? "unfinished",
    speedBonus: round.speedBonus === true,
    streakMiles: round.streakMiles ?? 0,
    statusPoints: round.spAwarded ?? 0,
    miles: round.milesAwarded ?? 0,
    firstClassPass: round.firstClassPass === true,
    pleasureCruise: round.pleasureCruise,
  };
}

/**
 * Round lifecycle. Both writes run in one transaction that first takes the player's row lock
 * (SELECT ... FOR UPDATE), so all writes for one player are serialised and a result can never build
 * on a stale streak or balance. Nothing is ever retried or overwritten.
 */
@Injectable()
export class RoundsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Issue a Round. The player's other open Rounds are abandoned in the same transaction, so only one
   * Round can be in flight and a pile of unplayed Rounds cannot be banked later. Completed Rounds are
   * untouched, so their replays keep working. Returns null if the player does not exist.
   */
  async issueRound(principal: string, module: ModuleId, now: Date): Promise<IssuedRound | null> {
    return this.db.transaction(async (tx) => {
      const [player] = await tx.select().from(players).where(eq(players.id, principal)).for("update");
      if (!player) return null;

      const rank = activeRankFor(player.statusPoints, player.activeRank);
      const pleasureCruise = rankIndex(rank) < rankIndex(certifiedRankFor(player.statusPoints));
      const roundId = randomUUID();
      const expiresAt = new Date(now.getTime() + ROUND_TTL_SECONDS * 1000);

      await tx
        .update(rounds)
        .set({ status: "abandoned" })
        .where(and(eq(rounds.playerId, principal), eq(rounds.status, "open")));
      await tx.insert(rounds).values({
        id: roundId,
        playerId: principal,
        module,
        rank,
        pleasureCruise,
        issuedAt: now,
        expiresAt,
      });
      return { roundId, module, rank, pleasureCruise, expiresAt: expiresAt.toISOString() };
    });
  }

  /**
   * Score and bank a Round. A Round belonging to another player is reported as not found. Resubmitting
   * a completed Round returns the stored award without paying again, so a client retry after a dropped
   * response is safe.
   */
  async completeRound(
    principal: string,
    roundId: string,
    input: RoundResultInput,
    now: Date,
  ): Promise<CompleteRoundOutcome> {
    return this.db.transaction(async (tx): Promise<CompleteRoundOutcome> => {
      // Lock order is always player, then round (issueRound does the same), so no deadlocks.
      const [player] = await tx.select().from(players).where(eq(players.id, principal)).for("update");
      if (!player) return { kind: "not_found" };
      const [round] = await tx
        .select()
        .from(rounds)
        .where(and(eq(rounds.id, roundId), eq(rounds.playerId, principal)))
        .for("update");
      if (!round) return { kind: "not_found" };

      if (round.status === "completed") {
        return {
          kind: "completed",
          result: {
            award: storedAward(round),
            player,
            promotion:
              round.promotedFrom && round.promotedTo
                ? { from: round.promotedFrom as Rank, to: round.promotedTo as Rank }
                : null,
            replayed: true,
          },
        };
      }
      if (round.status === "abandoned") return { kind: "closed" };
      if (now.getTime() > round.expiresAt.getTime()) return { kind: "expired" };
      // Refused without closing the Round, so the client can retry after a moment.
      if (now.getTime() < round.issuedAt.getTime() + MIN_ROUND_MS) return { kind: "too_fast" };

      const firstClassPass = hasFirstClassPass(player, now);
      const award = scoreRound({
        ...input,
        perfectStreak: player.perfectStreak,
        firstClassPass,
        pleasureCruise: round.pleasureCruise,
      });
      const streak = nextPerfectStreak(player.perfectStreak, award.completion);
      // The player row is locked, so the balance read above is the balance this credit lands on.
      const from = certifiedRankFor(player.statusPoints);
      const to = certifiedRankFor(player.statusPoints + award.statusPoints);
      const promotion = from === to ? null : { from, to };

      await tx
        .update(rounds)
        .set({
          status: "completed",
          completionId: randomUUID(),
          completedAt: now,
          finished: input.finished,
          errorCount: input.errorCount,
          usedHint: input.usedHint,
          timeRemaining: input.timeRemainingFraction,
          completion: award.completion,
          speedBonus: award.speedBonus,
          streakMiles: award.streakMiles,
          firstClassPass,
          spAwarded: award.statusPoints,
          milesAwarded: award.miles,
          promotedFrom: promotion?.from ?? null,
          promotedTo: promotion?.to ?? null,
        })
        .where(eq(rounds.id, roundId));

      const [updated] = await tx
        .update(players)
        .set({
          statusPoints: player.statusPoints + award.statusPoints,
          miles: player.miles + award.miles,
          perfectStreak: streak,
          version: player.version + 1,
          updatedAt: now,
        })
        .where(eq(players.id, principal))
        .returning();
      if (!updated) throw new Error("Player row missing after credit.");

      return {
        kind: "completed",
        result: {
          award: { ...award, firstClassPass, pleasureCruise: round.pleasureCruise },
          player: updated,
          promotion,
          replayed: false,
        },
      };
    });
  }
}
