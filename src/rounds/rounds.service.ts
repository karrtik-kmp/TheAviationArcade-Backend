import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { PlayerBalance } from "../balance/player-balance.js";
import { rounds } from "../db/schema.js";
import type { PlayerRow, RoundRow } from "../db/schema.js";
import type { ModuleId } from "../rules/modules.js";
import { HINTS_PER_ROUND } from "../rules/hints.js";
import { bankRound } from "../rules/banking.js";
import { activeRankFor, certifiedRankFor, isPleasureCruise } from "../rules/ranks.js";
import type { Rank } from "../rules/ranks.js";
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

export type SpendHintOutcome =
  | { kind: "spent"; player: PlayerRow; replayed: boolean }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "closed" }
  | { kind: "no_hints" };

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
 * Round lifecycle. Every write goes through PlayerBalance.update, which first takes the player's row lock
 * (SELECT ... FOR UPDATE), so all writes for one player are serialised and a result can never build on a stale
 * streak or balance. The Round row is locked inside, after the player: lock order is always player, then Round.
 * Nothing is ever retried or overwritten.
 */
@Injectable()
export class RoundsService {
  constructor(private readonly balance: PlayerBalance) {}

  /**
   * Issue a Round. The player's other open Rounds are abandoned in the same transaction, so only one
   * Round can be in flight and a pile of unplayed Rounds cannot be banked later. Completed Rounds are
   * untouched, so their replays keep working. Returns null if the player does not exist.
   */
  async issueRound(principal: string, module: ModuleId, now: Date): Promise<IssuedRound | null> {
    const result = await this.balance.update<IssuedRound>(principal, now, async ({ player, tx }) => {
      const rank = activeRankFor(player.statusPoints, player.activeRank);
      const pleasureCruise = isPleasureCruise(certifiedRankFor(player.statusPoints), rank);
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
      // Lock only: issuing a Round changes nothing the player sees.
      return { value: { roundId, module, rank, pleasureCruise, expiresAt: expiresAt.toISOString() } };
    });
    return result.kind === "ok" ? result.value : null;
  }

  /**
   * Score and bank a Round. A Round belonging to another player is reported as not found. Resubmitting
   * a completed Round returns the stored award without paying again, so a client retry after a dropped
   * response is safe. A completed Round is a progress event: it bumps the version and queues the UGS copy
   * even when it pays nothing.
   */
  async completeRound(
    principal: string,
    roundId: string,
    input: RoundResultInput,
    now: Date,
  ): Promise<CompleteRoundOutcome> {
    type Inner =
      | Exclude<CompleteRoundOutcome, { kind: "completed" }>
      | { kind: "completed"; result: Omit<CompletedRound, "player"> };
    const result = await this.balance.update<Inner>(principal, now, async ({ player, tx }) => {
      const [round] = await tx
        .select()
        .from(rounds)
        .where(and(eq(rounds.id, roundId), eq(rounds.playerId, principal)))
        .for("update");
      if (!round) return { value: { kind: "not_found" } };

      if (round.status === "completed") {
        return {
          value: {
            kind: "completed",
            result: {
              award: storedAward(round),
              promotion:
                round.promotedFrom && round.promotedTo
                  ? { from: round.promotedFrom as Rank, to: round.promotedTo as Rank }
                  : null,
              replayed: true,
            },
          },
        };
      }
      if (round.status === "abandoned") return { value: { kind: "closed" } };
      if (now.getTime() > round.expiresAt.getTime()) return { value: { kind: "expired" } };
      // Refused without closing the Round, so the client can retry after a moment.
      if (now.getTime() < round.issuedAt.getTime() + MIN_ROUND_MS) return { value: { kind: "too_fast" } };

      const banked = bankRound(
        { statusPoints: player.statusPoints, perfectStreak: player.perfectStreak, firstClassUntil: player.firstClassUntil },
        {
          finished: input.finished,
          errorCount: input.errorCount,
          usedHint: input.usedHint,
          timeRemainingFraction: input.timeRemainingFraction,
          pleasureCruise: round.pleasureCruise,
          hintPaid: round.hintUsed,
        },
        now,
      );
      const { award, promotion } = banked;

      await tx
        .update(rounds)
        .set({
          status: "completed",
          completionId: randomUUID(),
          completedAt: now,
          finished: input.finished,
          errorCount: input.errorCount,
          usedHint: banked.usedHint,
          timeRemaining: input.timeRemainingFraction,
          completion: award.completion,
          speedBonus: award.speedBonus,
          streakMiles: award.streakMiles,
          firstClassPass: award.firstClassPass,
          spAwarded: award.statusPoints,
          milesAwarded: award.miles,
          promotedFrom: promotion?.from ?? null,
          promotedTo: promotion?.to ?? null,
        })
        .where(eq(rounds.id, roundId));

      return {
        value: {
          kind: "completed",
          result: {
            award,
            promotion,
            replayed: false,
          },
        },
        // One ledger entry per Round (the unique key makes a double pay impossible); a zero award writes none.
        change: {
          postings: [{ account: "miles", delta: banked.balanceDelta.miles, kind: "round_award", ref: roundId }],
          statusPoints: banked.balanceDelta.statusPoints,
          perfectStreak: banked.streak,
        },
      };
    });
    // A Round result for a deleted player is a missing Round (asserted contract: 404 round_not_found).
    if (result.kind !== "ok") return { kind: "not_found" };
    const value = result.value;
    if (value.kind === "completed") return { kind: "completed", result: { ...value.result, player: result.player } };
    return value;
  }

  /**
   * Spend the Round's one hint (HINTS_PER_ROUND). Idempotent: a Round that already has its hint answers
   * with replayed = true and debits nothing, whatever state the Round has moved on to. Otherwise only the
   * player's own open, unexpired Round qualifies. A debit the balance cannot cover rolls back the Round's
   * hintUsed mark with it.
   */
  async spendHint(principal: string, roundId: string, now: Date): Promise<SpendHintOutcome> {
    type Inner = Exclude<SpendHintOutcome, { kind: "spent" }> | { kind: "spent"; replayed: boolean };
    const result = await this.balance.update<Inner>(principal, now, async ({ tx }) => {
      const [round] = await tx
        .select()
        .from(rounds)
        .where(and(eq(rounds.id, roundId), eq(rounds.playerId, principal)))
        .for("update");
      if (!round) return { value: { kind: "not_found" } };

      if (round.hintUsed) return { value: { kind: "spent", replayed: true } };
      if (round.status !== "open") return { value: { kind: "closed" } };
      if (now.getTime() > round.expiresAt.getTime()) return { value: { kind: "expired" } };

      await tx.update(rounds).set({ hintUsed: true }).where(eq(rounds.id, roundId));
      return {
        value: { kind: "spent", replayed: false },
        change: { postings: [{ account: "hints", delta: -HINTS_PER_ROUND, kind: "round_spend", ref: roundId }] },
      };
    });
    if (result.kind === "no_player") return { kind: "not_found" };
    if (result.kind === "insufficient") return { kind: "no_hints" };
    const value = result.value;
    if (value.kind === "spent") return { kind: "spent", player: result.player, replayed: value.replayed };
    return value;
  }
}
