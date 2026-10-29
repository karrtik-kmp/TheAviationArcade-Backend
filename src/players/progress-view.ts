import type { PlayerRow } from "../db/schema.js";
import { hasFirstClassPass } from "../rules/first-class.js";
import { activeRankFor, certifiedRankFor, isPleasureCruise, nextRankFor, rankIndex, RANKS } from "../rules/ranks.js";
import type { Rank } from "../rules/ranks.js";

export type ProgressView = {
  /** Stored progress revision. Order equal-version evaluations by evaluatedAt. */
  version: number;
  /** Server instant used to evaluate time-derived fields, including lazy Trip expiry. */
  evaluatedAt: string;
  statusPoints: number;
  miles: number;
  /** Co-Pilot hints left. */
  hints: number;
  certifiedRank: Rank;
  activeRank: Rank;
  pleasureCruise: boolean;
  /** Ranks the player may fly, Certified down to Trainee (the Pleasure Cruise picker). */
  selectableRanks: Rank[];
  nextRank: { rank: Rank; statusPoints: number } | null;
  perfectStreak: number;
  firstClassPass: boolean;
};

export function progressView(player: PlayerRow, now: Date): ProgressView {
  const certifiedRank = certifiedRankFor(player.statusPoints);
  const activeRank = activeRankFor(player.statusPoints, player.activeRank);
  return {
    version: player.version,
    evaluatedAt: now.toISOString(),
    statusPoints: player.statusPoints,
    miles: player.miles,
    hints: player.hints,
    certifiedRank,
    activeRank,
    pleasureCruise: isPleasureCruise(certifiedRank, activeRank),
    selectableRanks: RANKS.slice(0, rankIndex(certifiedRank) + 1).reverse(),
    nextRank: nextRankFor(player.statusPoints),
    perfectStreak: player.perfectStreak,
    firstClassPass: hasFirstClassPass(player.firstClassUntil, now),
  };
}
