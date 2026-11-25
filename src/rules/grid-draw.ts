import { DeckRandom, fnv1a } from "./dealer.js";
import { type ModuleId } from "./modules.js";
import { RANKS, type Rank } from "./ranks.js";
import { FLIGHTS_PER_TRIP } from "./trips.js";

/**
 * Rule `grid-draw.v1`: how a Code Search Trip's ten boards are drawn. The same loop as Unity
 * `CodeSearchContent.Deal` (partial Fisher-Yates), with `System.Random` replaced by the shared dealer RNG
 * (`DeckRandom(fnv1a(seed))`), so the server and Unity can agree (`contracts/grid.v1.json`). It is separate from
 * `DealPolicy` (choice modules only) so `dealer.v1.json` stays byte-identical.
 *
 * Pure: no clock, no randomness beyond the seed, no I/O. The caller passes the pool in natural id order.
 */
export type GridPolicy = "grid-draw.v1";

export const GRID_DEAL_POLICY: Partial<Readonly<Record<ModuleId, GridPolicy>>> = {
  "code-search": "grid-draw.v1",
};

/**
 * The boards of `rank` only, in the given order, then `for i in 0..9: j = i + next(n - i); swap(i, j)` on a
 * `DeckRandom` seeded with `fnv1a(seed)`; the first ten. Fewer than FLIGHTS_PER_TRIP boards at the rank deals
 * nothing (empty). Does not mutate `pool`.
 */
export function drawGridBoards<T extends { readonly id: string; readonly rank: Rank }>(pool: readonly T[], rank: Rank, seed: string): T[] {
  const order = pool.filter((board) => board.rank === rank);
  const n = order.length;
  if (n < FLIGHTS_PER_TRIP) return [];
  const random = new DeckRandom(fnv1a(seed));
  for (let i = 0; i < FLIGHTS_PER_TRIP; i++) {
    const j = i + random.nextIndex(n - i);
    const held = order[i] as T;
    order[i] = order[j] as T;
    order[j] = held;
  }
  return order.slice(0, FLIGHTS_PER_TRIP);
}

/**
 * Boards per rank, capped at FLIGHTS_PER_TRIP: `min(10, count at the rank)`. Below 10 the rank cannot deal
 * (`drawGridBoards` returns an empty list there), so a count under 10 means "not enough boards", not a short Trip.
 */
export function gridCoverage(pool: readonly { readonly rank: Rank }[]): Record<Rank, number> {
  const out = {} as Record<Rank, number>;
  for (const rank of RANKS) out[rank] = Math.min(FLIGHTS_PER_TRIP, pool.filter((board) => board.rank === rank).length);
  return out;
}
