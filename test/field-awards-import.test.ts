import { describe, expect, it } from "vitest";
import { buildFieldAwardsBody } from "../src/content/documents/documents.js";
import {
  fieldAwardsPlanHash,
  normaliseName,
  parseFieldAwardsSheet,
  planFieldAwardsImport,
  targetFromThreshold,
} from "../src/content/documents/field-awards-import.js";
import type { BaseAward, SheetAward } from "../src/content/documents/field-awards-import.js";
import { SpreadsheetError } from "../src/content/xlsx.js";
import { FIELD_AWARD_CATALOG } from "../src/rules/field-award-catalog.js";

// Slice A2: the pure planner of the Field Awards sheet re-import (no database, no files).

const HEADER = ["Field Award", "Current criteria", "Threshold"];

/** The awards as the seeded version 1 holds them. */
const BASE: BaseAward[] = (buildFieldAwardsBody(1).awards as { id: string; title: string; criteria: string; target: number; thresholdCell: string }[]).map((a) => ({
  ...a,
  names: [normaliseName(a.title)],
}));

/** The sheet rows the catalog would produce: the client's own cells. */
const sheetOf = (edit?: (rows: SheetAward[]) => SheetAward[]): SheetAward[] => {
  const rows = FIELD_AWARD_CATALOG.map((d, i) => ({ row: i + 2, name: d.title, criteria: d.criteria, threshold: d.thresholdCell }));
  return edit ? edit(rows) : rows;
};
const plan = (rows: SheetAward[], base = BASE) => planFieldAwardsImport(rows, [], base);
const withRow = (rows: SheetAward[], title: string, patch: Partial<SheetAward>) => rows.map((r) => (r.name === title ? { ...r, ...patch } : r));

describe("parseFieldAwardsSheet", () => {
  it("reads the client's three columns, trims, skips blank lines and numbers rows from 1", () => {
    const parsed = parseFieldAwardsSheet([HEADER, ["  First Solo ", " Complete your first Trip. ", "1 Trip"], [null, null, null], ["Frequent Flyer", "Complete 25 Trips in total.", 25]]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toEqual([
      { row: 2, name: "First Solo", criteria: "Complete your first Trip.", threshold: "1 Trip" },
      { row: 4, name: "Frequent Flyer", criteria: "Complete 25 Trips in total.", threshold: "25" },
    ]);
  });

  it("finds columns by header, in any order, ignoring extra columns", () => {
    const parsed = parseFieldAwardsSheet([["Notes", "threshold", "FIELD AWARD", "Criteria"], ["x", "1 Trip", "First Solo", "Complete your first Trip."]]);
    expect(parsed.rows).toEqual([{ row: 2, name: "First Solo", criteria: "Complete your first Trip.", threshold: "1 Trip" }]);
  });

  it("a missing header is a file-level SpreadsheetError, an empty sheet too", () => {
    expect(() => parseFieldAwardsSheet([["Name", "Text"], ["a", "b"]])).toThrow(SpreadsheetError);
    expect(() => parseFieldAwardsSheet([])).toThrow(SpreadsheetError);
  });

  it("a missing cell is a row error that names the row", () => {
    const parsed = parseFieldAwardsSheet([HEADER, ["First Solo", null, "1 Trip"], ["Frequent Flyer", "c", null], [null, "c", "1"]]);
    expect(parsed.rows).toEqual([]);
    expect(parsed.issues.map((i) => i.row)).toEqual([2, 3, 4]);
    expect(parsed.issues.every((i) => i.level === "error")).toBe(true);
  });
});

describe("targetFromThreshold", () => {
  it("reads the leading whole number, with thousands separators", () => {
    expect(targetFromThreshold("100,000 Miles")).toEqual({ target: 100000 });
    expect(targetFromThreshold("24901 miles")).toEqual({ target: 24901 });
    expect(targetFromThreshold("7-day streak")).toEqual({ target: 7 });
  });
  it("refuses a fraction, no number, zero and absurd values; never guesses", () => {
    for (const cell of ["2.5 Trips", "2,5 Trips", "10 Boeing + 10 Airbus", "Get a full green trip", "0 Trips", "-3 Trips", "99999999999999999999 Miles"]) {
      expect(targetFromThreshold(cell), cell).toHaveProperty("error");
    }
  });
});

describe("planFieldAwardsImport", () => {
  it("the catalog's own sheet plans nothing (all 28 rows match, all 10 differing ids included)", () => {
    const planned = plan(sheetOf());
    expect(planned.issues).toEqual([]);
    expect(planned.awards).toEqual([]);
    expect(planned.counts).toEqual({ rows: 28, awardsChanged: 0, awardsUnchanged: 28, fieldChanges: 0 });
    expect(FIELD_AWARD_CATALOG.filter((d) => d.id !== d.sheetId)).toHaveLength(10);
  });

  it("matches by name to the Unity code id, not to the sheet's own slug", () => {
    const planned = plan(withRow(sheetOf(), "First Solo", { criteria: "Complete your first Trip, any game." }));
    expect(planned.awards).toEqual([{ id: "first-flight", changes: [{ field: "criteria", from: "Complete your first Trip.", to: "Complete your first Trip, any game." }] }]);
  });

  it("matches case-insensitively and with collapsed spaces, and reports the new spelling as a title change", () => {
    const planned = plan(withRow(sheetOf(), "Line Pilot", { name: "line  pilot" }));
    expect(planned.awards).toEqual([{ id: "week-on-the-line", changes: [{ field: "title", from: "Line Pilot", to: "line  pilot" }] }]);
  });

  it("title, criteria and target diffs come out in catalog order with from and to", () => {
    const rows = withRow(withRow(sheetOf(), "Logbook 100", { threshold: "150 Flights", criteria: "Complete 150 Flights." }), "First Solo", { name: "FIRST SOLO" });
    const planned = plan(rows);
    expect(planned.awards).toEqual([
      { id: "first-flight", changes: [{ field: "title", from: "First Solo", to: "FIRST SOLO" }] },
      {
        id: "century",
        changes: [
          { field: "criteria", from: FIELD_AWARD_CATALOG.find((d) => d.id === "century")!.criteria, to: "Complete 150 Flights." },
          { field: "target", from: 100, to: 150 },
          { field: "thresholdCell", from: "100 Flights", to: "150 Flights" },
        ],
      },
    ]);
    expect(planned.issues).toEqual([]);
  });

  it("an unchanged Threshold cell keeps the target (rulings such as Go Around = 1 live there); a changed one is read", () => {
    const goAround = FIELD_AWARD_CATALOG.find((d) => d.id === "go-around")!;
    expect(goAround.thresholdCell).toMatch(/^Get a full green/);
    expect(plan(sheetOf()).awards).toEqual([]);
    const changed = plan(withRow(sheetOf(), goAround.title, { threshold: "2 full green trips" }));
    expect(changed.awards).toEqual([{ id: "go-around", changes: [{ field: "target", from: 1, to: 2 }, { field: "thresholdCell", from: goAround.thresholdCell, to: "2 full green trips" }] }]);
    // The cell wording alone moves the cell, not the target.
    expect(plan(withRow(sheetOf(), "Frequent Flyer", { threshold: "25 Trips in all" })).awards).toEqual([
      { id: "frequent-flyer", changes: [{ field: "thresholdCell", from: "25 Trips", to: "25 Trips in all" }] },
    ]);
    const broken = plan(withRow(sheetOf(), goAround.title, { threshold: "A full green trip, twice" }));
    expect(broken.issues).toHaveLength(1);
    expect(broken.issues[0]).toMatchObject({ id: "go-around", level: "error" });
  });

  it("a changed cell with more than one number is a row error, never a guess; a boolean or date cell is 'not text'", () => {
    const issues = plan(withRow(sheetOf(), "The Great Rivalry", { threshold: "15 Boeing + 20 Airbus" })).issues;
    expect(issues).toEqual([expect.objectContaining({ id: "the-great-rivalry", level: "error", message: expect.stringContaining("more than one number") })]);
    expect(targetFromThreshold("15 Boeing + 20 Airbus")).toHaveProperty("error");
    expect(targetFromThreshold("1,000 Miles")).toEqual({ target: 1000 });
    expect(parseFieldAwardsSheet([["Field Award", "Current criteria", "Threshold"], ["X", "c", true]]).issues).toEqual([
      expect.objectContaining({ row: 2, message: "X: the threshold is not text." }),
    ]);
  });

  it("errors: unknown award, missing award, duplicate row, non-integer, zero target and over-long text", () => {
    const rows = sheetOf();
    const unknown = plan([...rows, { row: 40, name: "Space Cadet", criteria: "c", threshold: "1" }]);
    expect(unknown.issues).toEqual([expect.objectContaining({ row: 40, level: "error", message: expect.stringContaining("Space Cadet") })]);

    const missing = plan(rows.filter((r) => r.name !== "Rotorhead"));
    expect(missing.issues).toEqual([expect.objectContaining({ row: 0, id: "rotorhead", level: "error", message: expect.stringContaining("missing from the sheet") })]);

    const twice = plan([...rows, { row: 41, name: "First Solo", criteria: "again", threshold: "1 Trip" }]);
    expect(twice.issues).toEqual([expect.objectContaining({ row: 41, id: "first-flight", message: expect.stringContaining("listed twice") })]);

    expect(plan(withRow(rows, "Frequent Flyer", { threshold: "2.5 Trips" })).issues).toEqual([expect.objectContaining({ id: "frequent-flyer" })]);
    expect(plan(withRow(rows, "Frequent Flyer", { threshold: "0 Trips" })).issues).toEqual([expect.objectContaining({ id: "frequent-flyer" })]);
    expect(plan(withRow(rows, "Frequent Flyer", { criteria: "x".repeat(2001) })).issues).toEqual([expect.objectContaining({ id: "frequent-flyer", message: expect.stringContaining("criteria") })]);
    expect(plan(withRow(rows, "Frequent Flyer", { threshold: "2,000,000,000 Trips" })).issues).toEqual([expect.objectContaining({ id: "frequent-flyer", message: expect.stringContaining("target") })]);
  });

  it("an award found by its title in force or by a draft title is matched too", () => {
    const renamed = BASE.map((a) => (a.id === "century" ? { ...a, title: "Century Club", names: [...a.names, normaliseName("Century Club")] } : a));
    const rows = withRow(sheetOf(), "Logbook 100", { name: "Century Club" });
    expect(planFieldAwardsImport(rows, [], renamed).awards).toEqual([]);
    expect(planFieldAwardsImport(sheetOf(), [], renamed).awards).toEqual([{ id: "century", changes: [{ field: "title", from: "Century Club", to: "Logbook 100" }] }]);
  });

  it("an ambiguous name (two awards answer to it) is an error, never a pick", () => {
    const twin = BASE.map((a) => (a.id === "regular" ? { ...a, names: [...a.names, normaliseName("Line Pilot")] } : a));
    const planned = planFieldAwardsImport(sheetOf(), [], twin);
    expect(planned.issues.some((i) => /more than one Field Award/.test(i.message))).toBe(true);
  });

  it("carries the parse issues through", () => {
    const planned = planFieldAwardsImport(sheetOf(), [{ row: 9, level: "error", message: "bad" }], BASE);
    expect(planned.issues).toEqual([{ row: 9, level: "error", message: "bad" }]);
  });
});

describe("fieldAwardsPlanHash", () => {
  const changed = () => plan(withRow(sheetOf(), "Logbook 100", { threshold: "150 Flights" }));
  const basis = { publishedVersion: 1, draftVersion: 0 };

  it("is stable for the same plan and basis, and a sha256", () => {
    expect(fieldAwardsPlanHash(basis, changed())).toBe(fieldAwardsPlanHash(basis, changed()));
    expect(fieldAwardsPlanHash(basis, changed())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with any change, the draft revision and the version in force", () => {
    const base = fieldAwardsPlanHash(basis, changed());
    expect(fieldAwardsPlanHash({ ...basis, draftVersion: 1 }, changed())).not.toBe(base);
    expect(fieldAwardsPlanHash({ ...basis, publishedVersion: 2 }, changed())).not.toBe(base);
    expect(fieldAwardsPlanHash(basis, plan(withRow(sheetOf(), "Logbook 100", { threshold: "151 Flights" })))).not.toBe(base);
    expect(fieldAwardsPlanHash(basis, plan(sheetOf()))).not.toBe(base);
  });

  it("does not depend on the sheet's row numbers or on property order", () => {
    const shifted = plan(withRow(sheetOf(), "Logbook 100", { threshold: "150 Flights" }).map((r) => ({ ...r, row: r.row + 10 })));
    expect(fieldAwardsPlanHash(basis, shifted)).toBe(fieldAwardsPlanHash(basis, changed()));
  });
});
