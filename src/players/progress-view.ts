import type { PlayerRow } from "../db/schema.js";
import { activeRankFor, certifiedRankFor, nextRankFor, rankIndex, RANKS } from "../rules/ranks.js";
import type { Rank } from "../rules/ranks.js";

export type ProgressView = {
  statusPoints: number;
  miles: number;
  certifiedRank: Rank;
  activeRank: Rank;
  pleasureCruise: boolean;
  /** Ranks the player may fly, Certified down to Trainee (the Pleasure Cruise picker). */
  selectableRanks: Rank[];
  nextRank: { rank: Rank; statusPoints: number } | null;
  perfectStreak: number;
  firstClassPass: boolean;
};

export function hasFirstClassPass(player: PlayerRow, now: Date): boolean {
  return player.firstClassUntil !== null && player.firstClassUntil.getTime() > now.getTime();
}

export function progressView(player: PlayerRow, now: Date): ProgressView {
  const certifiedRank = certifiedRankFor(player.statusPoints);
  const activeRank = activeRankFor(player.statusPoints, player.activeRank);
  return {
    statusPoints: player.statusPoints,
    miles: player.miles,
    certifiedRank,
    activeRank,
    pleasureCruise: rankIndex(activeRank) < rankIndex(certifiedRank),
    selectableRanks: RANKS.slice(0, rankIndex(certifiedRank) + 1).reverse(),
    nextRank: nextRankFor(player.statusPoints),
    perfectStreak: player.perfectStreak,
    firstClassPass: hasFirstClassPass(player, now),
  };
}
