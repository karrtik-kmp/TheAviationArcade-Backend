import { describe, expect, it } from "vitest";
import {
  cell as C,
  ensureValidPuzzle,
  findOccurrences,
  GRID_DIRECTIONS,
  isValidPuzzle,
  line,
  makePuzzle,
  makeTarget,
  read,
  tryResolve,
  validatePuzzle,
  type GridCell,
  type GridDirection,
  type WordGridPuzzle,
  type WordGridTarget,
} from "../src/rules/word-grid.js";

// Ported from Unity WordGridPuzzleValidatorTests (and the CodeSearchRoundTests sample it uses).
const SAMPLE_LETTERS = "LAXQQJ" + "QQQQQF" + "DQQQQK" + "QXQQQQ" + "QQBQQQ" + "QQQTRN";

function sampleTargets(): WordGridTarget[] {
  return [
    makeTarget("3484", "LAX", "Los Angeles", [C(0, 0), C(0, 1), C(0, 2)]),
    makeTarget("3622", "JFK", "New York", [C(0, 5), C(1, 5), C(2, 5)]),
    makeTarget("2207", "DXB", "Dubai", [C(2, 0), C(3, 1), C(4, 2)]),
    makeTarget("5241", "NRT", "Tokyo Narita", [C(5, 5), C(5, 4), C(5, 3)]),
  ];
}

const samplePuzzle = (): WordGridPuzzle => makePuzzle("cs-sample", 6, 6, SAMPLE_LETTERS, sampleTargets());
const withTargets = (letters: string, ...targets: WordGridTarget[]): WordGridPuzzle => makePuzzle("cs-test", 6, 6, letters, targets);

function replacing(index: number, replacement: WordGridTarget, letters = SAMPLE_LETTERS): WordGridPuzzle {
  const targets = sampleTargets();
  targets[index] = replacement;
  return withTargets(letters, ...targets);
}

function setLetter(letters: string, c: GridCell, letter: string): string {
  const chars = letters.split("");
  chars[c.row * 6 + c.column] = letter;
  return chars.join("");
}

function assertRejected(puzzle: WordGridPuzzle, fragment: string): void {
  const errors = validatePuzzle(puzzle);
  expect(
    errors.some((e) => e.toLowerCase().includes(fragment.toLowerCase())),
    `Expected an error containing '${fragment}', got: ${errors.join(" | ")}`,
  ).toBe(true);
  expect(isValidPuzzle(puzzle)).toBe(false);
  expect(() => ensureValidPuzzle(puzzle)).toThrow();
}

describe("WordGridPuzzleValidator (port of WordGridPuzzleValidatorTests)", () => {
  it("The sample puzzle is valid", () => {
    expect(validatePuzzle(samplePuzzle())).toEqual([]);
    expect(() => ensureValidPuzzle(samplePuzzle())).not.toThrow();
  });

  it("A null puzzle is rejected", () => {
    expect(validatePuzzle(null)).toEqual(["Puzzle is null."]);
  });

  it("A puzzle without targets is rejected", () => {
    assertRejected(withTargets(SAMPLE_LETTERS), "at least one target");
  });

  it("A non letter cell is rejected", () => {
    const puzzle = makePuzzle("cs-test", 6, 6, setLetter(setLetter(SAMPLE_LETTERS, C(3, 3), "7"), C(4, 4), "9"), sampleTargets());
    assertRejected(puzzle, "A-Z");
    expect(validatePuzzle(puzzle).filter((e) => e.startsWith("Cell "))).toEqual(["Cell 21 holds '7', not a letter A-Z."]);
  });

  it("A path off the grid is rejected", () => {
    const puzzle = replacing(0, makeTarget("3484", "LAX", "Los Angeles", [C(0, -1), C(0, 0), C(0, 1)]));
    assertRejected(puzzle, "leaves");
    expect(validatePuzzle(puzzle)[0]).toBe("Target 0 (LAX) path leaves the 6x6 grid at (0,-1).");
  });

  it("A path with a gap is rejected", () => {
    assertRejected(replacing(0, makeTarget("3484", "LAX", "Los Angeles", [C(0, 0), C(0, 2), C(0, 4)])), "contiguous");
  });

  it("A bent path is rejected", () => {
    assertRejected(replacing(0, makeTarget("3484", "LAX", "Los Angeles", [C(0, 0), C(0, 1), C(1, 2)])), "straight");
  });

  it("A path that does not spell its code is rejected", () => {
    assertRejected(replacing(0, makeTarget("3484", "LAX", "Los Angeles", [C(1, 0), C(1, 1), C(1, 2)])), "spell");
  });

  it("A path of the wrong length is rejected", () => {
    assertRejected(replacing(0, makeTarget("3484", "LAX", "Los Angeles", [C(0, 0), C(0, 1)])), "cells for a 3-letter code");
  });

  it("An empty path has no first letter hint", () => {
    const puzzle = replacing(0, makeTarget("3484", "LAX", "Los Angeles", []));
    assertRejected(puzzle, "first-letter hint");
    // Same order as C#: the path message, then the hint message.
    expect(validatePuzzle(puzzle)).toEqual([
      "Target 0 (LAX) path has 0 cells for a 3-letter code.",
      "Target 0 (LAX) has no resolvable first-letter hint cell.",
    ]);
  });

  it("A second accidental occurrence is rejected", () => {
    // Spell LAX again down column 3.
    let letters = SAMPLE_LETTERS;
    letters = setLetter(letters, C(1, 3), "L");
    letters = setLetter(letters, C(2, 3), "A");
    letters = setLetter(letters, C(3, 3), "X");
    const puzzle = withTargets(letters, ...sampleTargets());
    assertRejected(puzzle, "appears 2 times");
    expect(validatePuzzle(puzzle)).toEqual(["Target 0 (LAX) appears 2 times in the grid; it must appear once."]);
  });

  it("An accidental reverse occurrence is rejected", () => {
    // X A L across row 1 reads LAX right to left.
    let letters = SAMPLE_LETTERS;
    letters = setLetter(letters, C(1, 1), "X");
    letters = setLetter(letters, C(1, 2), "A");
    letters = setLetter(letters, C(1, 3), "L");
    assertRejected(withTargets(letters, ...sampleTargets()), "appears 2 times");
  });

  it("A repeated airport is rejected", () => {
    const puzzle = replacing(1, makeTarget("3484", "JFK", "New York", [C(0, 5), C(1, 5), C(2, 5)]));
    assertRejected(puzzle, "repeats airport");
    expect(validatePuzzle(puzzle)).toEqual(["Target 1 (JFK) repeats airport '3484'."]);
  });

  it("A repeated code is rejected", () => {
    assertRejected(replacing(1, makeTarget("9999", "LAX", "Elsewhere", [C(0, 0), C(0, 1), C(0, 2)])), "repeats code");
  });

  it("Codes that mirror each other are rejected", () => {
    // XAL sits on LAX's cells read backwards, so one selection would find both.
    assertRejected(replacing(1, makeTarget("9999", "XAL", "Mirror City", [C(0, 2), C(0, 1), C(0, 0)])), "reverse");
  });

  it("A repeated city clue is rejected", () => {
    assertRejected(replacing(2, makeTarget("2207", "DXB", "new york", [C(2, 0), C(3, 1), C(4, 2)])), "repeats the clue");
  });

  it("City clues compare case-insensitively per UTF-16 unit (accented letters)", () => {
    for (const [a, b] of [
      ["Álvaro", "álvaro"],
      ["Íle", "íLE"],
    ] as const) {
      const targets = sampleTargets();
      targets[0] = makeTarget("3484", "LAX", a, [C(0, 0), C(0, 1), C(0, 2)]);
      targets[2] = makeTarget("2207", "DXB", b, [C(2, 0), C(3, 1), C(4, 2)]);
      assertRejected(withTargets(SAMPLE_LETTERS, ...targets), "repeats the clue");
    }
    // Different letters are not a repeat.
    expect(validatePuzzle(replacing(2, makeTarget("2207", "DXB", "Álvaro", [C(2, 0), C(3, 1), C(4, 2)])))).toEqual([]);
  });

  it("City clues that name the airport tell a shared city apart", () => {
    const targets = sampleTargets();
    targets[1] = makeTarget("3622", "JFK", "New York JFK", targets[1]!.path);
    targets[2] = makeTarget("2207", "DXB", "New York Dubai", targets[2]!.path);
    expect(isValidPuzzle(withTargets(SAMPLE_LETTERS, ...targets))).toBe(true);
  });

  it("A blank clue or airport is rejected", () => {
    assertRejected(replacing(0, makeTarget("3484", "LAX", " ", sampleTargets()[0]!.path)), "no clue");
    assertRejected(replacing(0, makeTarget("", "LAX", "Los Angeles", sampleTargets()[0]!.path)), "no airport id");
  });

  it("A code that is not letters is rejected", () => {
    assertRejected(replacing(0, makeTarget("3484", "L4X", "Los Angeles", [C(0, 0), C(0, 1), C(0, 2)])), "letters A-Z");
  });

  it("A direction the puzzle does not allow is rejected", () => {
    const straightOnly: GridDirection[] = ["East", "West", "North", "South"];
    const errors = validatePuzzle(samplePuzzle(), straightOnly);
    expect(errors).toEqual(["Target 2 (DXB) runs SouthEast, which this puzzle does not allow."]);
  });

  it("The puzzle constructor refuses a misshapen grid", () => {
    const targets = sampleTargets();
    expect(() => makePuzzle("cs", 6, 6, "ABC", targets)).toThrow();
    expect(() => makePuzzle(" ", 6, 6, SAMPLE_LETTERS, targets)).toThrow();
    expect(() => makePuzzle("cs", 0, 6, "", targets)).toThrow(RangeError);
    expect(() => makePuzzle("cs", 6, 6, SAMPLE_LETTERS, null)).toThrow(TypeError);
  });

  it("Occurrences count a line and its mirror once", () => {
    const puzzle = samplePuzzle();
    expect(findOccurrences(puzzle, "LAX")).toHaveLength(1);
    expect(findOccurrences(puzzle, "XAL")).toHaveLength(1);
    expect(read(puzzle, C(5, 5), C(5, 3))).toBe("NRT");
    expect(read(puzzle, C(0, 0), C(1, 2))).toBeUndefined();
  });
});

describe("word grid helpers (ports of GridDirections, GridCell, constructors)", () => {
  it("lists the eight directions in Unity enum order", () => {
    expect([...GRID_DIRECTIONS]).toEqual(["East", "SouthEast", "South", "SouthWest", "West", "NorthWest", "North", "NorthEast"]);
  });

  it("tryResolve gives direction and cell count, and refuses same cell, off-line cells", () => {
    expect(tryResolve(C(0, 0), C(0, 2))).toEqual({ direction: "East", length: 3 });
    expect(tryResolve(C(0, 0), C(2, 2))).toEqual({ direction: "SouthEast", length: 3 });
    expect(tryResolve(C(2, 0), C(0, 0))).toEqual({ direction: "North", length: 3 });
    expect(tryResolve(C(1, 1), C(0, 2))).toEqual({ direction: "NorthEast", length: 2 });
    expect(tryResolve(C(1, 1), C(1, 1))).toBeUndefined();
    expect(tryResolve(C(0, 0), C(1, 2))).toBeUndefined();
  });

  it("line lists the cells start to end", () => {
    expect(line(C(5, 5), C(5, 3))).toEqual([C(5, 5), C(5, 4), C(5, 3)]);
    expect(line(C(0, 0), C(1, 2))).toBeUndefined();
  });

  it("the constructors normalise: letters upper-cased, code trimmed and upper-cased, clue trimmed", () => {
    const target = makeTarget("1", " lax ", "  Los Angeles ", [C(0, 0), C(0, 1), C(0, 2)]);
    expect(target.code).toBe("LAX");
    expect(target.clue).toBe("Los Angeles");
    expect(makePuzzle("p", 2, 1, "ab", [target]).letters).toBe("AB");
    expect(makeTarget(null, null, null, []).airportId).toBe("");
  });

  it("a single-letter word is found once per cell", () => {
    expect(findOccurrences(samplePuzzle(), "J")).toHaveLength(1);
    expect(findOccurrences(samplePuzzle(), "")).toEqual([]);
  });
});
