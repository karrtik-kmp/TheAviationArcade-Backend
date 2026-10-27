/**
 * The Flight Crew Hierarchy, lowest first. Array order is load-bearing: Active Rank may be dialled
 * down but never above Certified Rank, and Pleasure Cruise is Active below Certified. Both are
 * comparisons on rankIndex(). Mirrors the Unity FlightRank enum.
 */
export const RANKS = ["trainee", "first-officer", "captain", "check-airman", "chief-pilot"] as const;
export type Rank = (typeof RANKS)[number];

/**
 * Lifetime Status Points needed to be certified at each rank (docs/points-progression.md §5).
 *
 * ASSUMPTION: Chief Pilot is 200,000 SP. The source spec says 200,000 in the detailed milestone
 * table and 400,000 in the diagram. 200,000 is used because the same table's "~2,500+ games"
 * estimate only reconciles with it. Still open for Josh; locked by a named test.
 */
export const RANK_THRESHOLDS: Readonly<Record<Rank, number>> = {
  trainee: 0,
  "first-officer": 10_000,
  captain: 50_000,
  "check-airman": 100_000,
  "chief-pilot": 200_000,
};

export function isRank(value: unknown): value is Rank {
  return typeof value === "string" && (RANKS as readonly string[]).includes(value);
}

export function rankIndex(rank: Rank): number {
  return RANKS.indexOf(rank);
}

/** Certified Rank is derived from lifetime SP. SP never decreases, so this never drops. */
export function certifiedRankFor(statusPoints: number): Rank {
  let certified: Rank = "trainee";
  for (const rank of RANKS) {
    if (statusPoints >= RANK_THRESHOLDS[rank]) certified = rank;
  }
  return certified;
}

export function nextRankFor(statusPoints: number): { rank: Rank; statusPoints: number } | null {
  const next = RANKS[rankIndex(certifiedRankFor(statusPoints)) + 1];
  return next ? { rank: next, statusPoints: RANK_THRESHOLDS[next] } : null;
}

/**
 * The rank actually flown. A stored Active Rank above Certified cannot happen through the API,
 * but is clamped anyway so a bad row can never raise difficulty or escape the Pleasure Cruise cap.
 */
export function activeRankFor(statusPoints: number, storedActive: string | null): Rank {
  const certified = certifiedRankFor(statusPoints);
  if (!isRank(storedActive) || rankIndex(storedActive) > rankIndex(certified)) return certified;
  return storedActive;
}
