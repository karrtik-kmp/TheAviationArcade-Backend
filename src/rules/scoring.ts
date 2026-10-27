/**
 * Per-Round earn rates from docs/points-progression.md §2, ported from the Unity ScoreCalculator.
 * Keep the two in step: the app shows these numbers, the server is the one that banks them.
 *
 * Spec ambiguities resolved by assumption (Unity ADR-0004), each locked by a named test:
 *   1. The speed bonus is ADDITIVE with the completion award (the spec's worked example implies it).
 *   2. The Pleasure Cruise cap is applied BEFORE the First Class multiplier.
 *   3. An Unfinished Round pays nothing and breaks the Perfect Streak. The spec never mentions the
 *      failure case; this is the Unity prototype's ruling (CONTEXT.md), not Josh's.
 */
export const PERFECT_COMPLETION = 50;
export const STANDARD_COMPLETION = 30;
export const SPEED_BONUS = 20;
export const STREAK_MILES_PER_ROUND = 5;
export const STREAK_MILES_CAP = 25;
export const FIRST_CLASS_MULTIPLIER = 1.5;
export const PLEASURE_CRUISE_CAP = 10;

export type RoundInput = {
  finished: boolean;
  errorCount: number;
  usedHint: boolean;
  /** 0..1. The speed bonus needs strictly more than half the clock left. */
  timeRemainingFraction: number;
  /** Consecutive Perfect Completions before this Round. */
  perfectStreak: number;
  firstClassPass: boolean;
  pleasureCruise: boolean;
};

export type Completion = "perfect" | "standard" | "unfinished";

export type RoundAward = {
  completion: Completion;
  speedBonus: boolean;
  streakMiles: number;
  statusPoints: number;
  miles: number;
};

export function scoreRound(input: RoundInput): RoundAward {
  if (!input.finished) {
    return { completion: "unfinished", speedBonus: false, streakMiles: 0, statusPoints: 0, miles: 0 };
  }

  const perfect = input.errorCount === 0 && !input.usedHint;
  const award = perfect ? PERFECT_COMPLETION : STANDARD_COMPLETION;
  const speedBonus = input.timeRemainingFraction > 0.5;

  let statusPoints = award + (speedBonus ? SPEED_BONUS : 0);
  let miles = statusPoints;

  // The streak bonus is Miles-only: the spec's table marks Status Points as "-". Like the Unity
  // port, it pays on the streak carried into this Round even if this Round breaks it. Open for Josh.
  const streakMiles = Math.min(input.perfectStreak * STREAK_MILES_PER_ROUND, STREAK_MILES_CAP);
  miles += streakMiles;

  if (input.pleasureCruise) {
    statusPoints = Math.min(statusPoints, PLEASURE_CRUISE_CAP);
    miles = Math.min(miles, PLEASURE_CRUISE_CAP);
  }

  if (input.firstClassPass) {
    // Inputs are non-negative integers, so Math.round is round-half-up like the Unity port.
    statusPoints = Math.round(statusPoints * FIRST_CLASS_MULTIPLIER);
    miles = Math.round(miles * FIRST_CLASS_MULTIPLIER);
  }

  return {
    completion: perfect ? "perfect" : "standard",
    speedBonus,
    streakMiles,
    statusPoints,
    miles,
  };
}

/** The Perfect Streak after this Round: extended by a Perfect Completion, otherwise reset. */
export function nextPerfectStreak(current: number, completion: Completion): number {
  return completion === "perfect" ? current + 1 : 0;
}
