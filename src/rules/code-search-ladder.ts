import { RANKS, type Rank } from "./ranks.js";
import { RANK_CATALOG } from "./catalog.js";
import { GRID_DIRECTIONS, isGridDirection, type GridDirection } from "./word-grid.js";

/**
 * The Code Search difficulty ladder: a port of Unity `CodeSearchLadder.cs` (client ruling 2026-11-19 and the master
 * pack's START HERE sheet, 2026-11-17) and of `CodeSearchContent.CheckRankTable`. Change both together; keep test
 * names aligned with `CodeSearchLadderTests`. Every target is a 3-letter IATA code at every rank.
 */

/** One rank's board: grid side, number of targets, how many show a city instead of the code, the clock, directions. */
export type CodeSearchRung = {
  readonly gridSide: number;
  readonly targetCount: number;
  /** Targets per board whose FIND entry shows the city instead of the code. */
  readonly cityClues: number;
  readonly durationSeconds: number;
  readonly directions: readonly GridDirection[];
};

/** The largest side any rung uses; the client lays out and accepts boards up to this. */
export const MAX_GRID_SIDE = 8;

const ACROSS_AND_DOWN: readonly GridDirection[] = ["East", "South"];
const DOWNWARD: readonly GridDirection[] = ["East", "SouthEast", "South", "SouthWest"];

export const CODE_SEARCH_LADDER: Readonly<Record<Rank, CodeSearchRung>> = {
  trainee: { gridSide: 6, targetCount: 4, cityClues: 0, durationSeconds: 60, directions: ACROSS_AND_DOWN },
  // 4 codes + 2 cities.
  "first-officer": { gridSide: 7, targetCount: 6, cityClues: 2, durationSeconds: 75, directions: DOWNWARD },
  // 3 codes + 4 cities.
  captain: { gridSide: 8, targetCount: 7, cityClues: 4, durationSeconds: 90, directions: GRID_DIRECTIONS },
  // Cities only.
  "check-airman": { gridSide: 8, targetCount: 7, cityClues: 7, durationSeconds: 90, directions: GRID_DIRECTIONS },
  "chief-pilot": { gridSide: 8, targetCount: 8, cityClues: 8, durationSeconds: 75, directions: GRID_DIRECTIONS },
};

export function rankFromUnityName(name: unknown): Rank | undefined {
  if (typeof name !== "string") return undefined;
  return RANKS.find((rank) => RANK_CATALOG[rank].unity === name);
}

function sameDirections(names: unknown, expected: readonly GridDirection[]): boolean {
  if (!Array.isArray(names) || names.length !== expected.length) return false;
  const wanted = new Set<GridDirection>(expected);
  for (const name of names) {
    if (!isGridDirection(name) || !wanted.delete(name)) return false;
  }
  return wanted.size === 0;
}

/**
 * Port of `CodeSearchContent.CheckRankTable`: the pack's `ranks` must be the ladder's, one entry per rank (rank names
 * are Unity enum names such as "FirstOfficer"; the rules live in code). Returns the problems, empty when it matches.
 */
export function checkRankTable(ranks: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(ranks)) return ["The Code Search rank table is not a list."];
  const seen = new Set<Rank>();
  for (const entry of ranks as unknown[]) {
    const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined;
    const rank = record ? rankFromUnityName(record.rank) : undefined;
    if (!record || !rank || seen.has(rank)) {
      problems.push("The Code Search rank table names an unknown or repeated rank.");
      continue;
    }
    seen.add(rank);
    const rung = CODE_SEARCH_LADDER[rank];
    const duration = record.durationSeconds;
    if (
      record.gridSide !== rung.gridSide ||
      record.targetCount !== rung.targetCount ||
      record.cityClues !== rung.cityClues ||
      typeof duration !== "number" ||
      Math.abs(duration - rung.durationSeconds) > 1e-6 ||
      !sameDirections(record.directions, rung.directions)
    ) {
      problems.push(`The Code Search pack's ${RANK_CATALOG[rank].unity} rules differ from the ladder.`);
    }
  }
  if (seen.size !== RANKS.length) problems.push("The Code Search rank table misses a rank.");
  return problems;
}
