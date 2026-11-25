import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEAL_POLICY, DeckRandom, fnv1a } from "../src/rules/dealer.js";
import { drawGridBoards, gridCoverage, GRID_DEAL_POLICY } from "../src/rules/grid-draw.js";
import { GRID_POOL, gridCases } from "../src/rules/grid-fixture.js";
import { RANKS, type Rank } from "../src/rules/ranks.js";

type Board = { id: string; rank: Rank };

function pool(counts: Partial<Record<Rank, number>>): Board[] {
  const out: Board[] = [];
  for (const rank of RANKS) for (let n = 1; n <= (counts[rank] ?? 0); n++) out.push({ id: `${rank}-${String(n).padStart(3, "0")}`, rank });
  return out;
}

describe("grid-draw.v1", () => {
  const big = pool({ trainee: 40, "first-officer": 12, captain: 10, "check-airman": 9, "chief-pilot": 0 });

  it("is the policy of code-search only, and not a DealPolicy", () => {
    expect(GRID_DEAL_POLICY).toEqual({ "code-search": "grid-draw.v1" });
    expect(DEAL_POLICY["code-search"]).toBeUndefined();
  });

  it("deals ten distinct boards of the rank, deterministically", () => {
    const a = drawGridBoards(big, "trainee", "trip-1");
    expect(a).toHaveLength(10);
    expect(new Set(a.map((b) => b.id)).size).toBe(10);
    expect(a.every((b) => b.rank === "trainee")).toBe(true);
    expect(drawGridBoards(big, "trainee", "trip-1")).toEqual(a);
  });

  it("changes with the seed", () => {
    const ids = (seed: string) => drawGridBoards(big, "trainee", seed).map((b) => b.id).join();
    expect(new Set(["trip-1", "trip-2", "trip-3", "trip-4"].map(ids)).size).toBe(4);
  });

  it("is the partial Fisher-Yates over the rank's boards in the given order", () => {
    const own = big.filter((b) => b.rank === "trainee");
    const random = new DeckRandom(fnv1a("probe"));
    const order = [...own];
    for (let i = 0; i < 10; i++) {
      const j = i + random.nextIndex(order.length - i);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    expect(drawGridBoards(big, "trainee", "probe")).toEqual(order.slice(0, 10));
  });

  it("depends on the pool order, not on other ranks' boards", () => {
    const own = big.filter((b) => b.rank === "captain");
    expect(drawGridBoards(own, "captain", "s")).toEqual(drawGridBoards(big, "captain", "s"));
    expect(drawGridBoards([...own].reverse(), "captain", "s")).not.toEqual(drawGridBoards(own, "captain", "s"));
  });

  it("deals exactly ten when there are exactly ten, in some order", () => {
    const deck = drawGridBoards(big, "captain", "x");
    expect(deck.map((b) => b.id).sort()).toEqual(big.filter((b) => b.rank === "captain").map((b) => b.id).sort());
  });

  it("deals nothing below ten boards at the rank", () => {
    expect(drawGridBoards(big, "check-airman", "x")).toEqual([]);
    expect(drawGridBoards(big, "chief-pilot", "x")).toEqual([]);
  });

  it("does not mutate the pool", () => {
    const copy = big.map((b) => ({ ...b }));
    drawGridBoards(big, "trainee", "x");
    expect(big).toEqual(copy);
  });

  it("reports coverage as min(10, boards at the rank)", () => {
    expect(gridCoverage(big)).toEqual({ trainee: 10, "first-officer": 10, captain: 10, "check-airman": 9, "chief-pilot": 0 });
  });

  it("matches contracts/grid.v1.json", () => {
    const file = JSON.parse(readFileSync(new URL("../contracts/grid.v1.json", import.meta.url), "utf8")) as {
      pool: Board[];
      cases: { rank: Rank; seed: string; boardIds: string[] }[];
      coverage: { perRank: Record<Rank, number> };
    };
    expect(file.cases.length).toBeGreaterThan(0);
    for (const c of file.cases) expect(drawGridBoards(file.pool, c.rank, c.seed).map((b) => b.id), `${c.rank}/${c.seed}`).toEqual(c.boardIds);
    expect(gridCoverage(file.pool)).toEqual(file.coverage.perRank);
  });

  it("fixture pool: cases cover can-deal and cannot-deal ranks, with FIXTURE ids in natural order", () => {
    expect(GRID_POOL.every((b) => b.id.startsWith("FIXTURE-"))).toBe(true);
    const cases = gridCases();
    expect(cases.find((c) => c.rank === "trainee")!.boardIds).toHaveLength(10);
    expect(cases.find((c) => c.rank === "captain")!.boardIds).toEqual([]);
    expect(GRID_POOL.map((b) => b.id)).toEqual([...GRID_POOL.map((b) => b.id)].sort());
  });
});
