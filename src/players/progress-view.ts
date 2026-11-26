import type { PlayerRow } from "../db/schema.js";
import type { LivePlayer } from "../trips/trip-store.js";
import { hasFirstClassPass } from "../rules/first-class.js";
import { activeRankFor, certifiedRankFor, isPleasureCruise, nextRankFor, rankIndex, RANKS } from "../rules/ranks.js";
import type { Rank } from "../rules/ranks.js";

export type ProgressView = {
  /** Stored progress revision: it orders stored changes (D-1, amended 2026-11-02). */
  version: number;
  /**
   * The DATABASE instant at which the time-derived fields (lazy Trip expiry, firstClassPass) were judged. It orders
   * changes that need no write, at one `version`: the game orders copies by (version, evaluatedAt).
   */
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

/** The player's profile on PUT /v1/me (0.34.0, plan C1): not progress, so not in Progress or the UGS copy. */
export type PlayerProfile = {
  /** Null until the player claims one: the app shows the Callsign screen then. */
  callsign: string | null;
  /** This request's token is a Firebase Anonymous guest. */
  guest: boolean;
};

export function profileView(player: Pick<PlayerRow, "callsign">, guest: boolean): PlayerProfile {
  return { callsign: player.callsign, guest };
}

/** Pure: the instant is the player's own `evaluatedAt`, stamped from the database clock by withLiveStreak. */
export function progressView(player: LivePlayer): ProgressView {
  const evaluatedAt = player.evaluatedAt;
  const certifiedRank = certifiedRankFor(player.statusPoints);
  const activeRank = activeRankFor(player.statusPoints, player.activeRank);
  return {
    version: player.version,
    evaluatedAt: evaluatedAt.toISOString(),
    statusPoints: player.statusPoints,
    miles: player.miles,
    hints: player.hints,
    certifiedRank,
    activeRank,
    pleasureCruise: isPleasureCruise(certifiedRank, activeRank),
    selectableRanks: RANKS.slice(0, rankIndex(certifiedRank) + 1).reverse(),
    nextRank: nextRankFor(player.statusPoints),
    perfectStreak: player.perfectStreak,
    firstClassPass: hasFirstClassPass(player.firstClassUntil, evaluatedAt),
  };
}
