import { hasFirstClassPass } from "./first-class.js";
import { certifiedRankFor } from "./ranks.js";
import type { Rank } from "./ranks.js";
import { nextPerfectStreak, scoreRound } from "./scoring.js";
import type { RoundAward } from "./scoring.js";

/** What the player had before the Round. */
export type BankState = {
  statusPoints: number;
  /** Consecutive Perfect Completions before this Round. */
  perfectStreak: number;
  firstClassUntil: Date | null;
};

/** The Round facts the client reports, plus the two the server already knows about the Round. */
export type BankInput = {
  finished: boolean;
  errorCount: number;
  /** Claimed by the client. */
  usedHint: boolean;
  timeRemainingFraction: number;
  /** Snapshotted when the Round was issued. */
  pleasureCruise: boolean;
  /** The server charged a hint for this Round (rounds.hintUsed). */
  hintPaid: boolean;
};

export type BankedRound = {
  award: RoundAward & { firstClassPass: boolean; pleasureCruise: boolean };
  /** Paid OR claimed: a hint the player paid for cannot be hidden by the client. */
  usedHint: boolean;
  balanceDelta: { statusPoints: number; miles: number };
  /** The Perfect Streak after this Round. */
  streak: number;
  promotion: { from: Rank; to: Rank } | null;
};

/**
 * Server composition of ScoreCalculator + promotion: the one place a Round's award, streak and promotion
 * are decided. Pure; the caller holds the player lock, so `state` is the balance this lands on.
 *
 * Perfect Streak is still global (carried across Rounds and modules). The per-Trip streak (D-3) will change
 * what `state.perfectStreak` means and when `streak` resets, here and in the caller's streak store.
 */
export function bankRound(state: BankState, input: BankInput, now: Date): BankedRound {
  const firstClassPass = hasFirstClassPass(state.firstClassUntil, now);
  // Claiming a hint that was never paid for only lowers the player's own award.
  const usedHint = input.usedHint || input.hintPaid;
  const award = scoreRound({
    finished: input.finished,
    errorCount: input.errorCount,
    usedHint,
    timeRemainingFraction: input.timeRemainingFraction,
    perfectStreak: state.perfectStreak,
    firstClassPass,
    pleasureCruise: input.pleasureCruise,
  });
  const from = certifiedRankFor(state.statusPoints);
  const to = certifiedRankFor(state.statusPoints + award.statusPoints);
  return {
    award: { ...award, firstClassPass, pleasureCruise: input.pleasureCruise },
    usedHint,
    balanceDelta: { statusPoints: award.statusPoints, miles: award.miles },
    streak: nextPerfectStreak(state.perfectStreak, award.completion),
    promotion: from === to ? null : { from, to },
  };
}
