import { describe, expect, it } from "vitest";
import { RANK_CATALOG } from "../src/rules/catalog.js";
import { CODE_SEARCH_LADDER, MAX_GRID_SIDE, checkRankTable } from "../src/rules/code-search-ladder.js";
import { RANKS } from "../src/rules/ranks.js";
import { GRID_DIRECTIONS } from "../src/rules/word-grid.js";

// Aligned with Unity CodeSearchLadderTests (the dealing tests live in grid-draw.test.ts / grid-boards.test.ts).
function table() {
  return RANKS.map((rank) => {
    const rung = CODE_SEARCH_LADDER[rank];
    return {
      rank: RANK_CATALOG[rank].unity,
      gridSide: rung.gridSide,
      targetCount: rung.targetCount,
      cityClues: rung.cityClues,
      durationSeconds: rung.durationSeconds,
      directions: [...rung.directions],
    };
  });
}

describe("CodeSearchLadder (port of CodeSearchLadderTests)", () => {
  it("Rungs follow the ruled table", () => {
    const expected = {
      trainee: [6, 4, 0, 60],
      "first-officer": [7, 6, 2, 75],
      captain: [8, 7, 4, 90],
      "check-airman": [8, 7, 7, 90],
      "chief-pilot": [8, 8, 8, 75],
    } as const;
    for (const rank of RANKS) {
      const rung = CODE_SEARCH_LADDER[rank];
      expect([rung.gridSide, rung.targetCount, rung.cityClues, rung.durationSeconds], rank).toEqual(expected[rank]);
      expect(rung.gridSide).toBeLessThanOrEqual(MAX_GRID_SIDE);
    }
    expect(MAX_GRID_SIDE).toBe(8);
  });

  it("Directions widen with rank", () => {
    expect([...CODE_SEARCH_LADDER.trainee.directions].sort()).toEqual(["East", "South"]);
    expect([...CODE_SEARCH_LADDER["first-officer"].directions].sort()).toEqual(["East", "South", "SouthEast", "SouthWest"]);
    for (const rank of ["captain", "check-airman", "chief-pilot"] as const) {
      expect([...CODE_SEARCH_LADDER[rank].directions].sort(), rank).toEqual([...GRID_DIRECTIONS].sort());
    }
  });
});

describe("checkRankTable (port of CodeSearchContent.CheckRankTable)", () => {
  it("accepts the ladder's own table", () => {
    expect(checkRankTable(table())).toEqual([]);
  });

  it("accepts the directions in any order", () => {
    const t = table();
    t[1]!.directions.reverse();
    expect(checkRankTable(t)).toEqual([]);
  });

  it("refuses a rung that differs from the ladder, naming the Unity rank", () => {
    for (const [key, value] of [
      ["gridSide", 5],
      ["targetCount", 9],
      ["cityClues", 3],
      ["durationSeconds", 61],
      ["directions", ["East"]],
      ["directions", ["East", "East", "South", "SouthWest"]],
      ["directions", ["East", "South", "Up", "SouthWest"]],
    ] as const) {
      const t = table();
      (t[1] as Record<string, unknown>)[key] = value;
      expect(checkRankTable(t), `${key}=${JSON.stringify(value)}`).toEqual(["The Code Search pack's FirstOfficer rules differ from the ladder."]);
    }
  });

  it("refuses an unknown, kebab-case, numeric or repeated rank", () => {
    for (const name of ["Admiral", "first-officer", "1", "trainee", null]) {
      const t = table();
      (t[1] as Record<string, unknown>).rank = name;
      expect(checkRankTable(t), String(name)).toContain("The Code Search rank table names an unknown or repeated rank.");
    }
    const repeated = table();
    repeated[1] = { ...repeated[0]! };
    expect(checkRankTable(repeated)).toContain("The Code Search rank table names an unknown or repeated rank.");
  });

  it("refuses a table that misses a rank, is not a list, or holds junk", () => {
    expect(checkRankTable(table().slice(0, 4))).toEqual(["The Code Search rank table misses a rank."]);
    expect(checkRankTable([])).toEqual(["The Code Search rank table misses a rank."]);
    expect(checkRankTable(undefined)).toHaveLength(1);
    expect(checkRankTable({})).toHaveLength(1);
    expect(checkRankTable([...table(), null, 7])).toHaveLength(2);
  });
});
