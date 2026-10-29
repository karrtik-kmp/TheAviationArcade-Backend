import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planImport } from "../src/content/import-plan.js";
import type { ExistingItem } from "../src/content/import-plan.js";
import { MILITARY_EXPORT_HEADER, militaryMapping } from "../src/content/modules/military.js";
import { readFirstSheet } from "../src/content/xlsx.js";
import { CLIENT_HEADER, clientRow, clientSheet, xlsx } from "./fixtures.js";
import type { TestCell } from "./fixtures.js";

const CLIENT_FILE = new URL("../../docs/Military Airplane Identifier v1.xlsx", import.meta.url);

async function parseBytes(bytes: Buffer) {
  return militaryMapping.parse(await readFirstSheet(bytes));
}

const withHeader = (rows: TestCell[][]) => xlsx([CLIENT_HEADER, ...rows]);

describe("Military mapping: the client's sheet", () => {
  // Skipped (not failed) on a machine without ../docs, e.g. CI.
  it.skipIf(!existsSync(CLIENT_FILE))("parses the real client file: 31 items, rows 35-36 skipped", async () => {
    const { kind, rows, issues } = await parseBytes(readFileSync(CLIENT_FILE));
    expect(kind).toBe("client_sheet"); // no Id column
    expect(rows).toHaveLength(31);
    expect(rows.every((r) => r.id === undefined)).toBe(true); // ids are the planner's job
    expect(rows.map((r) => r.row)).toEqual(Array.from({ length: 31 }, (_, i) => i + 4));
    // First import into an empty module: ids by row order, mil-a1..mil-a31 (the Unity ids).
    const first = planImport(rows, new Map(), { kind, mapping: militaryMapping });
    expect(first.issues).toEqual([]); // the real sheet has 31 unique, non-blank file names (rule of 2026-10-28)
    expect(first.rows.map((r) => r.id)).toEqual(Array.from({ length: 31 }, (_, i) => `mil-a${i + 1}`));
    // ASSUMPTION: mil-a5 (sheet row 8) is the Boeing C-17 Globemaster III, matching Unity's military_questions.json.
    const c17 = first.rows.find((r) => r.id === "mil-a5");
    expect(c17?.data).toMatchObject({ answer: "Boeing C-17 Globemaster III", sourceFile: "MA_globemaster_102326_1.jpg" });
    expect(c17?.rank).toBe("trainee");
    // The two Level-only rows (35, 36) are skipped with a warning and do not consume an id.
    expect(issues.filter((i) => i.message.startsWith("Placeholder")).map((i) => i.row)).toEqual([35, 36]);
    expect(first.rows.some((r) => r.id === "mil-a32")).toBe(false);
    // Re-importing the original sheet against what that import stored is all unchanged: no updates, no retirements.
    const stored = new Map<string, ExistingItem>(
      first.rows.map((r) => [r.id, { id: r.id, rank: r.rank, status: "approved", version: 1, data: r.data }]),
    );
    const again = planImport(rows, stored, { kind, mapping: militaryMapping });
    expect(again.counts).toEqual({ created: 0, updated: 0, unchanged: 31, retired: 0 });
    expect(again.requiresConfirm).toBe(false);
    // Nothing blocks the import.
    expect(issues.filter((i) => i.level !== "warning")).toEqual([]);
    // Photographers are trimmed; the typos are kept as written and reported.
    expect(rows.every((r) => r.data.photographer === String(r.data.photographer).trim())).toBe(true);
    expect(rows[30]?.data).toMatchObject({ sourceFile: "MA_Hawker_102426_1.jpog" });
    expect(rows[2]?.data).toMatchObject({ sourceFile: "MA_f22_10_23_26_1" });
    const warned = issues.filter((i) => i.message.includes("no .jpg/.jpeg/.png extension")).map((i) => i.row);
    expect(warned).toContain(6); // mil-a3, the f22 file
    expect(warned).toContain(34); // mil-a31, the .jpog Hawker
    expect(issues.filter((i) => i.message === "Photographer is missing.").length).toBeGreaterThan(0);
    // Ranks: first rows are Trainee, First Officer, Trainee, Captain.
    expect(rows.slice(0, 4).map((r) => r.rank)).toEqual(["trainee", "first-officer", "trainee", "captain"]);
    expect(rows[9]?.rank).toBe("check-airman"); // sheet row 13, Beriev A-50
    expect(rows[6]?.rank).toBe("chief-pilot"); // sheet row 10, Rockwell B-1B
  });

  it("builds ids, ranks and payload from a client-shaped file", async () => {
    const { kind, rows, issues } = await parseBytes(await clientSheet(31));
    expect(kind).toBe("client_sheet");
    expect(rows).toHaveLength(31);
    expect(rows[0]).toMatchObject({
      row: 4,
      id: undefined,
      naturalKey: "MA_test_1.jpg",
      version: undefined,
      rank: "trainee",
      data: { answer: "Aircraft 1", wrong: ["Wrong 1a", "Wrong 1b", "Wrong 1c"], sourceFile: "MA_test_1.jpg", photographer: "Photographer 1" },
    });
    expect(rows.slice(0, 5).map((r) => r.rank)).toEqual(["trainee", "first-officer", "captain", "check-airman", "chief-pilot"]);
    expect(issues.filter((i) => i.level === "warning").map((i) => i.row)).toEqual([35, 36]);
  });

  it("ASSUMPTION: Level-only placeholder rows are skipped with a warning and consume no id", async () => {
    const bytes = await withHeader([clientRow(1), ["Trainee", null, null, null, null, null, null], clientRow(2)]);
    const { kind, rows, issues } = await parseBytes(bytes);
    const planned = planImport(rows, new Map(), { kind, mapping: militaryMapping });
    expect(planned.rows.map((r) => r.id)).toEqual(["mil-a1", "mil-a2"]);
    expect(issues).toEqual([{ row: 3, level: "warning", message: "Placeholder row (no answers) skipped." }]);
  });

  it("a client-sheet row with an error is reported by sheet row (no id: ids are assigned only when the whole file is valid)", async () => {
    const bad = [...clientRow(2)];
    bad[0] = "Admiral";
    const { rows, issues } = await parseBytes(await withHeader([clientRow(1), bad, clientRow(3)]));
    expect(rows.map((r) => r.row)).toEqual([2, 4]);
    expect(issues.find((i) => i.level === "error")).toEqual(expect.objectContaining({ row: 3 }));
    expect(issues.find((i) => i.level === "error")).not.toHaveProperty("id");
  });

  it("finds the header within the first 10 rows, whatever the column order and case", async () => {
    const bytes = await xlsx([
      ["Military sheet"],
      ["PHOTOGRAPHER", "file", "wrong answer 3", " Wrong Answer 2 ", "Wrong Answer 1", "Correct Answer", "level"],
      ["P. Pilot", "x.png", "C", "B", "A", "Right", "Check  Airman"],
    ]);
    const { rows, issues } = await parseBytes(bytes);
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({
      id: undefined,
      rank: "check-airman",
      data: { answer: "Right", wrong: ["A", "B", "C"], sourceFile: "x.png", photographer: "P. Pilot" },
    });
  });

  it("rejects a file with no header row", async () => {
    await expect(parseBytes(await xlsx([["Level", "Answer"], ["Trainee", "x"]]))).rejects.toThrow("header row");
  });

  it("reports an unknown Level, missing and duplicate answers as errors", async () => {
    const { rows, issues } = await parseBytes(
      await withHeader([
        ["Admiral", "A", "B", "C", "D", "a.jpg", "P"],
        ["Trainee", "A", "B", "c", "C", "a.jpg", "P"],
        ["Trainee", "A", null, "C", "D", "a.jpg", "P"],
        ["Trainee", "A", "B", "C", "D", "a.jpg", "P"],
      ]),
    );
    expect(rows.map((r) => r.row)).toEqual([5]);
    const errors = issues.filter((i) => i.level === "error");
    expect(errors.map((e) => e.row)).toEqual([2, 3, 4]);
    expect(errors[0]?.message).toContain("Level");
    expect(errors[1]?.message).toContain("different");
    expect(errors[2]?.message).toContain("Wrong Answer 1 is missing");
  });

  it("stores values as written except surrounding whitespace; a missing Photographer is a warning", async () => {
    const { rows, issues } = await parseBytes(
      await withHeader([["Trainee", "  Keep  inner  spaces ", "B", "C", "D", " MA_x.jpog ", "\n Name With Newline"], ["Trainee", "A2", "B2", "C2", "D2", "b.JPG", null]]),
    );
    expect(rows[0]?.data).toEqual({ answer: "Keep  inner  spaces", wrong: ["B", "C", "D"], sourceFile: "MA_x.jpog", photographer: "Name With Newline" });
    expect(rows[1]?.data).toMatchObject({ photographer: "" });
    expect(issues.map((i) => [i.row, i.level, i.message])).toEqual([
      [2, "warning", "File name has no .jpg/.jpeg/.png extension."],
      [3, "warning", "Photographer is missing."],
    ]);
  });

  it("ASSUMPTION: when an Id column is present every data row needs a valid Id; Version is optional per row", async () => {
    const header = ["Id", "Version", ...CLIENT_HEADER];
    const bytes = await xlsx([
      header,
      ["mil-a7", 3, ...clientRow(7)],
      ["mil-a8", null, ...clientRow(8)],
      [null, null, ...clientRow(9)],
      ["plane-1", null, ...clientRow(10)],
      ["mil-a11", "x", ...clientRow(11)],
    ]);
    const { kind, rows, issues } = await parseBytes(bytes);
    expect(kind).toBe("admin_export");
    expect(rows.map((r) => [r.id, r.version])).toEqual([["mil-a7", 3], ["mil-a8", undefined]]);
    expect(issues.filter((i) => i.level === "error").map((i) => i.row)).toEqual([4, 5, 6]);
  });
});

describe("Military mapping: export", () => {
  it("writes the header, ids, versions, the client's Level wording and the Status", () => {
    const out = militaryMapping.exportRows([
      { id: "mil-a1", rank: "check-airman", status: "retired", version: 2, data: { answer: "A", wrong: ["B", "C", "D"], sourceFile: "a.jpg", photographer: "P" } },
    ]);
    expect(out[0]).toEqual([...MILITARY_EXPORT_HEADER]);
    expect(out[0]).toEqual(["Id", "Version", "Level", "Correct Answer", "Wrong Answer 1", "Wrong Answer 2", "Wrong Answer 3", "file", "Photographer", "Status"]);
    expect(out[1]).toEqual(["mil-a1", 2, "Check Airman", "A", "B", "C", "D", "a.jpg", "P", "retired"]);
  });
});

describe("Military mapping: natural key and ids", () => {
  it("the natural key is the trimmed file name, and ids are mil-a<N>", () => {
    expect(militaryMapping.naturalKey({ sourceFile: " MA_x.jpg " })).toBe("MA_x.jpg");
    expect(militaryMapping.naturalKey(null)).toBe("");
    expect(militaryMapping.formatId(12)).toBe("mil-a12");
    expect(militaryMapping.idNumber("mil-a12")).toBe(12);
    expect(militaryMapping.idNumber("plane-1")).toBeUndefined();
  });

  it("formatId refuses numbers an id cannot express", () => {
    expect(militaryMapping.formatId(999999)).toBe("mil-a999999");
    for (const n of [0, -1, 1_000_000, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(militaryMapping.formatId(n), String(n)).toBeUndefined();
    }
  });

  it("file names are matched in Unicode NFC form", async () => {
    const decomposed = "Café.jpg";
    const { rows } = await parseBytes(await xlsx([CLIENT_HEADER, [...clientRow(1).slice(0, 5), decomposed, "P"]]));
    expect(rows[0]?.naturalKey).toBe("Café.jpg");
    expect(militaryMapping.naturalKey({ sourceFile: decomposed })).toBe("Café.jpg");
  });

  it("answers that differ only by inner whitespace or case are duplicates", async () => {
    const { issues } = await parseBytes(await xlsx([CLIENT_HEADER, ["Trainee", "F-16  Falcon", "f-16 falcon", "B", "C", "x.jpg", "P"]]));
    expect(issues.find((i) => i.level === "error")?.message).toContain("different");
  });

  it("ignores a Status column on import (informational in the export)", async () => {
    const bytes = await xlsx([
      ["Id", "Version", ...CLIENT_HEADER, "Status"],
      ["mil-a1", 1, ...clientRow(1), "retired"],
    ]);
    const { rows, issues } = await parseBytes(bytes);
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({ id: "mil-a1", version: 1 });
    expect(rows[0]?.data).not.toHaveProperty("status");
  });
});
