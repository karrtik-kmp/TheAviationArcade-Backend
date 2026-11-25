import { CODE_SEARCH_LADDER, MAX_GRID_SIDE } from "./code-search-ladder.js";
import { RANK_CATALOG } from "./catalog.js";
import { DEALER_RNG } from "./dealer-fixture.js";
import { drawGridBoards, gridCoverage, GRID_DEAL_POLICY } from "./grid-draw.js";
import { MODULE_IDS } from "./modules.js";
import { RANKS, type Rank } from "./ranks.js";
import { FLIGHTS_PER_TRIP } from "./trips.js";

/**
 * The case source for `contracts/grid.v1.json` and its renderer (the same arrangement as `dealer-fixture.ts`: it lives
 * under `src/` so `nest build` compiles it for `scripts/write-contracts.mjs`).
 *
 * Expected draws are NOT hand-written: they come from `drawGridBoards`. The pool is synthetic (`FIXTURE-` ids, which the
 * importer refuses) and carries only `id` and `rank`, because the draw ignores a board's content.
 */

export const GRID_FORMAT = "grid.v1";
export const GRID_RNG = DEALER_RNG;
export const GRID_DRAW_RECIPE =
  "grid-draw.v1: keep the pool's boards of the rank in the given order (the server passes the rank's approved boards sorted by id); rng = DeckRandom(fnv1a32(seed)); " +
  "for i in 0..9: j = i + (nextUInt() % (n - i)); swap(order[i], order[j]); deal order[0..9]. " +
  "Fewer than flightsPerTrip boards at the rank deals nothing.";

export type GridFixtureBoard = { readonly id: string; readonly rank: Rank };

const PREFIX: Readonly<Record<Rank, string>> = { trainee: "TR", "first-officer": "FO", captain: "CA", "check-airman": "CH", "chief-pilot": "CP" };
/** Boards per rank: Trainee and First Officer can deal (14, exactly 10); the others cannot (9, 3, 1). */
const COUNTS: Readonly<Record<Rank, number>> = { trainee: 14, "first-officer": 10, captain: 9, "check-airman": 3, "chief-pilot": 1 };

function buildPool(): GridFixtureBoard[] {
  const pool: GridFixtureBoard[] = [];
  for (const rank of RANKS) {
    for (let n = 1; n <= COUNTS[rank]; n++) pool.push({ id: `FIXTURE-${PREFIX[rank]}-${String(n).padStart(2, "0")}`, rank });
  }
  // Natural id order (what the server sorts the pool into), not rank order.
  return pool.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const GRID_POOL: readonly GridFixtureBoard[] = buildPool();

const SEEDS = ["trip-1", "trip-2", "trip-3"] as const;
/** Seed edge cases (empty string, non-ASCII UTF-16), drawn at Trainee. */
const EDGE_SEEDS = ["", "Zürich-✈"] as const;

export type GridCase = { readonly name: string; readonly rank: Rank; readonly seed: string; readonly boardIds: readonly string[] };

function makeCase(rank: Rank, seed: string): GridCase {
  return {
    name: `fixture/${GRID_DEAL_POLICY["code-search"]}/${rank}/${seed === "" ? "(empty seed)" : seed}`,
    rank,
    seed,
    boardIds: drawGridBoards(GRID_POOL, rank, seed).map((b) => b.id),
  };
}

/** Every case, in published order. Expected `boardIds` come from `drawGridBoards`; an empty list means "cannot deal". */
export function gridCases(): GridCase[] {
  const cases: GridCase[] = [];
  for (const rank of RANKS) for (const seed of SEEDS) cases.push(makeCase(rank, seed));
  for (const seed of EDGE_SEEDS) cases.push(makeCase("trainee", seed));
  return cases;
}

/**
 * The published grid contract (`contracts/grid.v1.json`): format, RNG, draw recipe, Trip size, the ladder, the policy per
 * Module, the synthetic pool, the golden cases and the pool's coverage. Stable key order, 2-space indent, LF, one trailing newline.
 */
export function renderGridJson(): string {
  const grid = {
    format: GRID_FORMAT,
    rng: GRID_RNG,
    draw: GRID_DRAW_RECIPE,
    flightsPerTrip: FLIGHTS_PER_TRIP,
    maxGridSide: MAX_GRID_SIDE,
    ladder: RANKS.map((rank) => {
      const rung = CODE_SEARCH_LADDER[rank];
      return {
        rank,
        unity: RANK_CATALOG[rank].unity,
        gridSide: rung.gridSide,
        targetCount: rung.targetCount,
        cityClues: rung.cityClues,
        durationSeconds: rung.durationSeconds,
        directions: [...rung.directions],
      };
    }),
    modulePolicy: Object.fromEntries(MODULE_IDS.flatMap((id) => (GRID_DEAL_POLICY[id] ? [[id, GRID_DEAL_POLICY[id]]] : []))),
    pool: GRID_POOL.map((b) => ({ id: b.id, rank: b.rank })),
    cases: gridCases(),
    coverage: { perRank: gridCoverage(GRID_POOL) },
  };
  return `${JSON.stringify(grid, null, 2)}\n`;
}
