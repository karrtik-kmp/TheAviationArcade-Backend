import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CODE_SEARCH_ID,
  checkBoardFit,
  checkBoardPayload,
  gridBoardMemoSize,
  pruneGridBoardMemo,
  rankOfBoardId,
  rowToGridBoard,
  toWireBoard,
  type StoredGridBoard,
  type StoredGridTarget,
} from "../src/content/grid-boards.js";
import { RANK_CATALOG } from "../src/rules/catalog.js";
import { CODE_SEARCH_LADDER } from "../src/rules/code-search-ladder.js";
import { RANKS, type Rank } from "../src/rules/ranks.js";
import type { GridDirection } from "../src/rules/word-grid.js";

const CODES = ["LAX", "JFK", "DXB", "NRT", "SIN", "SYD", "CDG", "LHR"];
const CLUES = ["Los Angeles", "New York", "Dubai", "Tokyo Narita", "Singapore", "Sydney", "Paris", "London"];
const PREFIX: Record<Rank, string> = { trainee: "TR", "first-officer": "FO", captain: "CA", "check-airman": "CH", "chief-pilot": "CP" };

type Spec = { code: string; row: number; column: number; direction: GridDirection; city?: boolean };

/** A board of `side` x `side` Q filler with the given targets written in (no accidental second occurrences). */
function build(side: number, specs: Spec[]): StoredGridBoard {
  const letters = new Array<string>(side * side).fill("Q");
  const targets: StoredGridTarget[] = specs.map((s, t) => {
    const dr = { East: 0, SouthEast: 1, South: 1, SouthWest: 1, West: 0, NorthWest: -1, North: -1, NorthEast: -1 }[s.direction];
    const dc = { East: 1, SouthEast: 1, South: 0, SouthWest: -1, West: -1, NorthWest: -1, North: 0, NorthEast: 1 }[s.direction];
    for (let i = 0; i < s.code.length; i++) letters[(s.row + dr * i) * side + s.column + dc * i] = s.code[i] as string;
    return {
      airportId: `AP${t}`,
      code: s.code,
      clue: CLUES[CODES.indexOf(s.code)] as string,
      city: s.city ?? false,
      row: s.row,
      column: s.column,
      direction: s.direction,
    };
  });
  return { letters: letters.join(""), targets };
}

/** A board that exactly fits the rank's rung: one East code per row, the first `cityClues` showing the city. */
function fitting(rank: Rank): StoredGridBoard {
  const rung = CODE_SEARCH_LADDER[rank];
  const specs: Spec[] = [];
  for (let t = 0; t < rung.targetCount; t++) {
    specs.push({ code: CODES[t] as string, row: t, column: 0, direction: "East", city: t < rung.cityClues });
  }
  return build(rung.gridSide, specs);
}

const idFor = (rank: Rank, n = 1) => `CS-${PREFIX[rank]}-${String(n).padStart(4, "0")}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("Code Search ids", () => {
  it("accepts the five prefixes with four digits and names the rank", () => {
    for (const rank of RANKS) {
      expect(CODE_SEARCH_ID.test(idFor(rank, 748))).toBe(true);
      expect(rankOfBoardId(idFor(rank, 748))).toBe(rank);
    }
    for (const bad of ["CS-XX-0001", "CS-TR-001", "CS-TR-00001", "cs-tr-0001", "CS-TR-0001 ", "FIXTURE-TR-01", ""]) {
      expect(CODE_SEARCH_ID.test(bad), bad).toBe(false);
      expect(rankOfBoardId(bad)).toBeUndefined();
    }
  });
});

describe("checkBoardPayload", () => {
  it("accepts a board that fits each rung", () => {
    for (const rank of RANKS) expect(checkBoardPayload(fitting(rank)), rank).toEqual([]);
  });

  it("accepts every direction (rank-free)", () => {
    const board = build(8, [
      { code: "LAX", row: 0, column: 0, direction: "East" },
      { code: "JFK", row: 7, column: 7, direction: "West" },
      { code: "DXB", row: 0, column: 7, direction: "SouthWest" },
      { code: "NRT", row: 7, column: 0, direction: "NorthEast" },
    ]);
    expect(checkBoardPayload(board)).toEqual([]);
  });

  it("refuses a payload that is not an object with exactly letters and targets", () => {
    for (const bad of [null, undefined, 7, "x", [], []]) expect(checkBoardPayload(bad)).toHaveLength(1);
    const board = fitting("trainee");
    expect(checkBoardPayload({ ...board, extra: 1 })).toEqual(["The board has an unknown key 'extra'."]);
    expect(checkBoardPayload({ letters: board.letters })).toEqual(["The board is missing 'targets'.", "targets must be a list."]);
  });

  it("refuses letters that are not a non-empty square with a side of 1 to 8", () => {
    const board = fitting("trainee");
    for (const letters of ["", "ABC", "A".repeat(81), "A".repeat(35), 5, null]) {
      expect(checkBoardPayload({ ...board, letters }).length, String(letters)).toBeGreaterThan(0);
    }
    expect(checkBoardPayload({ ...board, letters: "A".repeat(81) })[0]).toContain("side of 1 to 8");
  });

  it("refuses lower case and untrimmed text instead of normalising it", () => {
    const board = fitting("trainee");
    expect(checkBoardPayload({ ...board, letters: board.letters.toLowerCase() })).toEqual(["letters must be stored in upper case."]);
    for (const [key, value, message] of [
      ["code", "lax", "Target 0 code must be stored trimmed and upper case."],
      ["code", " LAX", "Target 0 code must be stored trimmed and upper case."],
      ["clue", " Los Angeles", "Target 0 clue must be stored trimmed."],
      ["clue", "Los Angeles\n", "Target 0 clue must be stored trimmed."],
    ] as const) {
      const copy = clone(board);
      (copy.targets[0] as Record<string, unknown>)[key] = value;
      expect(checkBoardPayload(copy), `${key}=${JSON.stringify(value)}`).toEqual([message]);
    }
  });

  it("refuses misshapen targets: unknown keys, wrong types, bad direction, fractional cells", () => {
    const board = fitting("trainee");
    const broken = (patch: Record<string, unknown>) => {
      const copy = clone(board);
      Object.assign(copy.targets[1] as Record<string, unknown>, patch);
      return checkBoardPayload(copy);
    };
    expect(broken({ extra: true })).toEqual(["Target 1 has an unknown key 'extra'."]);
    expect(broken({ airportId: 5 })).toEqual(["Target 1 airportId must be a string."]);
    expect(broken({ city: "no" })).toEqual(["Target 1 city must be true or false."]);
    expect(broken({ row: 1.5 })).toEqual(["Target 1 row must be an integer."]);
    expect(broken({ column: "2" })).toEqual(["Target 1 column must be an integer."]);
    expect(broken({ direction: "east" })[0]).toContain("direction must be one of East, SouthEast");
    expect(broken({ code: "L".repeat(40) })[0]).toContain("longer than");
    const copy = clone(board);
    delete (copy.targets[2] as Partial<StoredGridTarget>).clue;
    expect(checkBoardPayload(copy)[0]).toBe("Target 2 is missing 'clue'.");
    expect(checkBoardPayload({ ...board, targets: "x" })).toEqual(["targets must be a list."]);
    expect(checkBoardPayload({ ...board, targets: [1] })).toEqual(["Target 0 must be an object."]);
  });

  it("reports the puzzle rules in Unity's words", () => {
    const board = fitting("trainee");
    expect(checkBoardPayload({ ...board, targets: [] })).toEqual(["A puzzle needs at least one target."]);

    const nonLetter = clone(board);
    nonLetter.letters = nonLetter.letters.slice(0, 21) + "7" + nonLetter.letters.slice(22);
    expect(checkBoardPayload(nonLetter)).toEqual(["Cell 21 holds '7', not a letter A-Z."]);

    const notSpelled = clone(board);
    notSpelled.letters = "Z" + notSpelled.letters.slice(1);
    expect(checkBoardPayload(notSpelled)).toEqual([
      "Target 0 (LAX) path does not spell its code.",
      "Target 0 (LAX) has no resolvable first-letter hint cell.",
    ]);

    const offGrid = clone(board);
    offGrid.targets[0]!.column = 5;
    expect(checkBoardPayload(offGrid)).toContain("Target 0 (LAX) path leaves the 6x6 grid at (0,6).");

    const repeatedClue = clone(board);
    repeatedClue.targets[1]!.clue = repeatedClue.targets[0]!.clue.toUpperCase();
    expect(checkBoardPayload(repeatedClue)).toEqual(["Target 1 (JFK) repeats the clue 'LOS ANGELES'."]);

    const twice = clone(board);
    twice.letters = twice.letters.slice(0, 5 * 6) + "LAX" + twice.letters.slice(5 * 6 + 3);
    expect(checkBoardPayload(twice)).toEqual(["Target 0 (LAX) appears 2 times in the grid; it must appear once."]);
  });
});

describe("checkBoardFit", () => {
  it("accepts a fitting board at every rank", () => {
    for (const rank of RANKS) expect(checkBoardFit(idFor(rank), rank, fitting(rank)), rank).toEqual([]);
  });

  it("refuses an id that is not a Code Search id or whose prefix names another rank", () => {
    const board = fitting("trainee");
    expect(checkBoardFit("FIXTURE-TR-01", "trainee", board)[0]).toContain("must look like CS-TR-0001");
    expect(checkBoardFit(idFor("captain"), "trainee", board)).toEqual([`Board '${idFor("captain")}' has an id prefix that does not match its rank.`]);
  });

  it("refuses a side or target count that is not the rung's", () => {
    const wide = build(7, [{ code: "LAX", row: 0, column: 0, direction: "East" }]);
    const id = idFor("trainee");
    expect(checkBoardFit(id, "trainee", wide)).toContain(`Board '${id}' does not fit its rank's grid or target count.`);
    const short = clone(fitting("trainee"));
    short.targets.pop();
    expect(checkBoardFit(id, "trainee", short)).toContain(`Board '${id}' does not fit its rank's grid or target count.`);
    // A Captain board is not a Trainee board and vice versa.
    expect(checkBoardFit(idFor("captain"), "captain", fitting("trainee")).length).toBeGreaterThan(0);
  });

  it("refuses a city count that is not the rung's", () => {
    const id = idFor("first-officer");
    const board = clone(fitting("first-officer"));
    board.targets[2]!.city = true;
    expect(checkBoardFit(id, "first-officer", board)).toEqual([`Board '${id}' shows 3 cities; its rank shows 2.`]);
    const none = clone(fitting("first-officer"));
    none.targets.forEach((t) => (t.city = false));
    expect(checkBoardFit(id, "first-officer", none)).toEqual([`Board '${id}' shows 0 cities; its rank shows 2.`]);
  });

  it("refuses a direction the rung does not allow, and only that", () => {
    const moved = build(6, [
      { code: "LAX", row: 0, column: 0, direction: "East" },
      { code: "JFK", row: 1, column: 0, direction: "SouthEast" },
      { code: "DXB", row: 5, column: 0, direction: "East" },
      { code: "NRT", row: 4, column: 3, direction: "East" },
    ]);
    const id = idFor("trainee");
    expect(checkBoardPayload(moved)).toEqual([]);
    expect(checkBoardFit(id, "trainee", moved)).toEqual(["Target 1 (JFK) runs SouthEast, which this puzzle does not allow."]);
    // At another rung the side and target count are wrong too.
    expect(checkBoardFit(idFor("first-officer"), "first-officer", moved).some((m) => m.includes("grid or target count"))).toBe(true);
  });

  it("returns the shape problems for a misshapen payload", () => {
    expect(checkBoardFit(idFor("trainee"), "trainee", { letters: 1 }).length).toBeGreaterThan(0);
  });
});

describe("toWireBoard", () => {
  it("builds Unity's CodeSearchBoardWire with the key order of ApiWireModels", () => {
    const id = idFor("first-officer", 12);
    const wire = toWireBoard(id, "first-officer", fitting("first-officer"));
    expect(Object.keys(wire)).toEqual(["id", "width", "height", "letters", "durationSeconds", "clueMode", "targets"]);
    expect(Object.keys(wire.targets[0]!)).toEqual(["airportId", "code", "clue", "cityClue", "cells"]);
    expect(Object.keys(wire.targets[0]!.cells[0]!)).toEqual(["row", "column"]);
    expect(wire).toMatchObject({ id, width: 7, height: 7, durationSeconds: 75, clueMode: "Mixed" });
    expect(wire.targets.map((t) => t.cityClue)).toEqual([true, true, false, false, false, false]);
    expect(wire.targets[0]).toMatchObject({ airportId: "AP0", code: "LAX", clue: "Los Angeles" });
  });

  it("lists cells in reading order whichever way the code runs", () => {
    const board = build(6, [
      { code: "LAX", row: 0, column: 2, direction: "West" },
      { code: "JFK", row: 5, column: 5, direction: "North" },
      { code: "DXB", row: 5, column: 0, direction: "NorthEast" },
    ]);
    const wire = toWireBoard(idFor("trainee"), "trainee", board);
    expect(wire.targets[0]!.cells).toEqual([
      { row: 0, column: 2 },
      { row: 0, column: 1 },
      { row: 0, column: 0 },
    ]);
    expect(wire.targets[1]!.cells.map((c) => c.row)).toEqual([5, 4, 3]);
    expect(wire.targets[2]!.cells).toEqual([
      { row: 5, column: 0 },
      { row: 4, column: 1 },
      { row: 3, column: 2 },
    ]);
  });

  it("derives the clue mode and the clock from the cities and the rung", () => {
    expect(toWireBoard(idFor("trainee"), "trainee", fitting("trainee"))).toMatchObject({ clueMode: "Code", durationSeconds: 60 });
    expect(toWireBoard(idFor("check-airman"), "check-airman", fitting("check-airman"))).toMatchObject({ clueMode: "City", width: 8, durationSeconds: 90 });
    expect(toWireBoard(idFor("chief-pilot"), "chief-pilot", fitting("chief-pilot"))).toMatchObject({ clueMode: "City", durationSeconds: 75 });
    expect(toWireBoard(idFor("captain"), "captain", fitting("captain")).clueMode).toBe("Mixed");
  });
});

describe("rowToGridBoard", () => {
  beforeEach(() => pruneGridBoardMemo(new Set()));

  const row = (rank: Rank, n = 1, version = 1, data: unknown = fitting(rank)) => ({ id: idFor(rank, n), rank, version, data });

  it("returns a deeply frozen wire board", () => {
    const board = rowToGridBoard(row("trainee"))!;
    expect(board.id).toBe("CS-TR-0001");
    expect(Object.isFrozen(board)).toBe(true);
    expect(Object.isFrozen(board.targets[0])).toBe(true);
    expect(Object.isFrozen(board.targets[0]!.cells[0])).toBe(true);
    expect(() => {
      (board as { letters: string }).letters = "x";
    }).toThrow();
  });

  it("is undefined when the payload, the fit or the id prefix fails", () => {
    expect(rowToGridBoard({ ...row("trainee"), data: { letters: "x" } })).toBeUndefined();
    expect(rowToGridBoard(row("captain", 1, 1, fitting("trainee")))).toBeUndefined();
    expect(rowToGridBoard({ ...row("trainee", 2), rank: "captain", data: fitting("captain") })).toBeUndefined();
  });

  it("memoises by id and version, and prunes", () => {
    const first = rowToGridBoard(row("trainee", 1, 1))!;
    expect(rowToGridBoard(row("trainee", 1, 1, { letters: "garbage" }))).toBe(first);
    const second = rowToGridBoard(row("trainee", 1, 2))!;
    expect(second).not.toBe(first);
    expect(gridBoardMemoSize()).toBe(2);
    expect(rowToGridBoard({ ...row("trainee", 3, 1), data: null })).toBeUndefined();
    expect(gridBoardMemoSize()).toBe(3);
    pruneGridBoardMemo(new Set(["CS-TR-0001:2"]));
    expect(gridBoardMemoSize()).toBe(1);
    expect(rowToGridBoard(row("trainee", 1, 2, { letters: "garbage" }))).toBe(second);
  });

  it("re-judges a memoised id and version when its rank differs", () => {
    expect(rowToGridBoard(row("trainee"))).toBeDefined();
    expect(rowToGridBoard({ ...row("trainee"), rank: "captain" })).toBeUndefined();
  });
});

const PACK = "C:\\Unity\\Projects\\AviationArcade_v2\\Assets\\_Project\\Resources\\ClientContent\\Arcade\\code_search_master.json";

describe.skipIf(!existsSync(PACK))("the client's code_search_master.json", () => {
  type Record = { id: string; rank: string; letters: string; targets: StoredGridTarget[] };
  const pack = existsSync(PACK) ? (JSON.parse(readFileSync(PACK, "utf8")) as { records: Record[]; droppedBoards: string[] }) : undefined;
  const rankOf = (unity: string): Rank => RANKS.find((r) => RANK_CATALOG[r].unity === unity) as Rank;
  const rows = (pack?.records ?? []).map((r) => ({ id: r.id, rank: rankOf(r.rank), data: { letters: r.letters, targets: r.targets } }));

  it("holds 3,740 boards, every one valid and fitting its rung", () => {
    expect(rows).toHaveLength(3740);
    const failures: string[] = [];
    for (const r of rows) {
      const problems = [...checkBoardPayload(r.data), ...checkBoardFit(r.id, r.rank, r.data)];
      if (problems.length > 0) failures.push(`${r.id}: ${problems.join(" | ")}`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it("holds 748 / 742 / 750 / 750 / 750 boards per rank, and none of the dropped ones", () => {
    expect(RANKS.map((rank) => rows.filter((r) => r.rank === rank).length)).toEqual([748, 742, 750, 750, 750]);
    expect(pack!.droppedBoards).toHaveLength(10);
    const ids = new Set(rows.map((r) => r.id));
    for (const dropped of pack!.droppedBoards) expect(ids.has(dropped), dropped).toBe(false);
  });

  it("builds a wire board for every record", () => {
    for (const r of rows.filter((_, i) => i % 37 === 0)) {
      const wire = rowToGridBoard({ ...r, version: 1 })!;
      expect(wire, r.id).toBeDefined();
      expect(wire.width).toBe(CODE_SEARCH_LADDER[r.rank].gridSide);
      for (const t of wire.targets) expect(t.cells.map((c) => wire.letters[c.row * wire.width + c.column]).join("")).toBe(t.code);
    }
  });

  it("fails a hand-broken copy of a real board with Unity's message", () => {
    const real = rows.find((r) => r.rank === "trainee")!;
    const broken = clone(real.data);
    const target = broken.targets[0]!;
    const index = target.row * 6 + target.column;
    broken.letters = broken.letters.slice(0, index) + (target.code[0] === "Q" ? "Z" : "Q") + broken.letters.slice(index + 1);
    expect(checkBoardPayload(real.data)).toEqual([]);
    expect(checkBoardPayload(broken)).toContain(`Target 0 (${target.code}) path does not spell its code.`);
    expect(rowToGridBoard({ ...real, version: 99, data: broken })).toBeUndefined();
  });
});
