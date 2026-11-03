import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planImport } from "../src/content/import-plan.js";
import type { ExistingItem } from "../src/content/import-plan.js";
import { contentMappingFor } from "../src/content/content-modules.js";
import { AIRPORT_SPOTTER_CORRECTIONS, AIRPORT_SPOTTER_EXPORT_HEADER, airportSpotterMapping } from "../src/content/modules/airport-spotter.js";
import { readFirstSheet } from "../src/content/xlsx.js";
import type { SheetRow } from "../src/content/xlsx.js";
import { xlsx } from "./fixtures.js";
import type { TestCell } from "./fixtures.js";

/** The client's sheet sits in ../../docs from the real repo; CLIENT_DOCS_DIR overrides it (e.g. in a worktree). */
const docsDir = process.env["CLIENT_DOCS_DIR"];
const CLIENT_FILE = docsDir ? new URL(`file:///${join(docsDir, "Airport Spotter v1.xlsx").replaceAll("\\", "/")}`) : new URL("../../docs/Airport Spotter v1.xlsx", import.meta.url);
const UNITY_PACK = "C:/Unity/Projects/AviationArcade_v2/Assets/_Project/Resources/ClientContent/Arcade/airport_questions.json";

const HEADER = ["LEVEL", "Correct Airport", "Wrong Airport 1", "Wrong Airport 2", "Wrong Airport 3", "File name", "Image"];
const withHeader = (rows: TestCell[][]) => xlsx([[null], [null], HEADER, ...rows]);
const parseBytes = async (bytes: Buffer) => airportSpotterMapping.parse(await readFirstSheet(bytes));

const UNITY_RANK: Record<string, string> = {
  Trainee: "trainee",
  FirstOfficer: "first-officer",
  Captain: "captain",
  CheckAirman: "check-airman",
  ChiefPilot: "chief-pilot",
};

describe("Airport Spotter mapping: the client's sheet", () => {
  it.skipIf(!existsSync(CLIENT_FILE))("parses the real client file: 45 items, Unity's per-rank counts, the seven corrections as warnings", async () => {
    const { kind, rows, issues } = await parseBytes(readFileSync(CLIENT_FILE));
    expect(kind).toBe("client_sheet");
    expect(rows).toHaveLength(45);
    expect(rows.map((r) => r.row)).toEqual(Array.from({ length: 45 }, (_, i) => i + 4));
    const perRank: Record<string, number> = {};
    for (const r of rows) perRank[r.rank] = (perRank[r.rank] ?? 0) + 1;
    expect(perRank).toEqual({ trainee: 4, "first-officer": 15, captain: 10, "check-airman": 14, "chief-pilot": 2 });

    expect(issues.filter((i) => i.level !== "warning")).toEqual([]);
    const corrected = issues.filter((i) => i.message.startsWith("Corrected on import"));
    expect(corrected.map((i) => i.row)).toEqual([9, 17, 21, 24, 32, 40, 44]);
    expect(corrected.find((i) => i.row === 44)?.message).toContain('Wrong Airport 1 "MUN" -> "MUC"');
    expect(corrected.find((i) => i.row === 21)?.message).toContain('Wrong Airport 2 "LAS" -> "BOS"');
    expect(corrected.find((i) => i.row === 9)?.message).toContain('File name "api_lax_10_22_26_6.jpg" -> "api_dca_10_22_26_1.jpg"');
    // After the fixes every file name carries an image extension, so no extension warning remains.
    expect(issues.filter((i) => i.message.includes("has no .jpg"))).toEqual([]);

    const byRow = new Map(rows.map((r) => [r.row, r]));
    expect(byRow.get(9)?.naturalKey).toBe("api_dca_10_22_26_1.jpg");
    expect(byRow.get(40)?.naturalKey).toBe("api_dfw_10_22_26_2.jpg");
    expect(byRow.get(32)?.data).toMatchObject({ sourceFile: "api_dca_10_22_26_3.jpg" });
    expect(byRow.get(21)?.data).toMatchObject({ answer: "LAX", wrong: ["LAS", "BOS", "PHX"] });
    expect(byRow.get(44)?.data).toMatchObject({ answer: "FRA", wrong: ["MUC", "LHR", "ORY"] });
    // Row 10 (api_lax_..._7 shows DCA) is Unity's client question, not a correction: kept as written.
    expect(byRow.get(10)?.data).toMatchObject({ answer: "DCA", sourceFile: "api_lax_10_22_26_7.jpg" });

    // Ids: apt-a1..apt-a45 in sheet order; unique non-blank file names; re-import is all unchanged.
    const first = planImport(rows, new Map(), { kind, mapping: airportSpotterMapping });
    expect(first.issues).toEqual([]);
    expect(first.rows.map((r) => r.id)).toEqual(Array.from({ length: 45 }, (_, i) => `apt-a${i + 1}`));
    const stored = new Map<string, ExistingItem>(first.rows.map((r) => [r.id, { id: r.id, rank: r.rank, status: "approved", version: 1, data: r.data }]));
    const again = planImport(rows, stored, { kind, mapping: airportSpotterMapping });
    expect(again.counts).toEqual({ created: 0, updated: 0, unchanged: 45, retired: 0 });
    expect(again.requiresConfirm).toBe(false);
  });

  it.skipIf(!existsSync(CLIENT_FILE) || !existsSync(UNITY_PACK))("matches Unity's pack: same rank, correct and wrong codes, and photo for every question", async () => {
    const { rows } = await parseBytes(readFileSync(CLIENT_FILE));
    const pack = JSON.parse(readFileSync(UNITY_PACK, "utf8").replace(/^\uFEFF/, "")) as {
      records: { rank: string; optionIds: string[]; sourceRow: number; sourceFile: string }[];
    };
    expect(pack.records).toHaveLength(rows.length);
    const byRow = new Map(rows.map((r) => [r.row, r]));
    for (const record of pack.records) {
      const ours = byRow.get(record.sourceRow);
      expect(ours, `row ${record.sourceRow}`).toBeDefined();
      expect(ours?.rank, `row ${record.sourceRow} rank`).toBe(UNITY_RANK[record.rank]);
      expect(ours?.data, `row ${record.sourceRow} codes`).toMatchObject({ answer: record.optionIds[0], wrong: record.optionIds.slice(1) });
      expect(String(ours?.data["sourceFile"]).toLowerCase(), `row ${record.sourceRow} file`).toBe(record.sourceFile.toLowerCase());
    }
  });

  it("every correction in the table is for a distinct row/field and names its original and corrected value", () => {
    expect(AIRPORT_SPOTTER_CORRECTIONS.map((c) => c.row)).toEqual([9, 17, 21, 24, 32, 40, 44]);
    for (const c of AIRPORT_SPOTTER_CORRECTIONS) {
      expect(c.from).not.toBe(c.to);
      expect(c.reason.length).toBeGreaterThan(5);
    }
  });
});

// A small sheet laid out like the client's: rows 4.. are data. Rows 9, 21 etc. are reproduced by padding.
function sheetWith(overrides: Record<number, TestCell[]>): Promise<Buffer> {
  const rows: TestCell[][] = [[null], [null], HEADER];
  for (let sheetRow = 4; sheetRow <= 48; sheetRow++) {
    rows.push(overrides[sheetRow] ?? ["Trainee", "AAA", "BBB", "CCC", "DDD", `f${sheetRow}.jpg`, null]);
  }
  return xlsx(rows);
}

describe("Airport Spotter corrections (synthetic sheet)", () => {
  it("fires only while the row still holds the original value", async () => {
    const original = await parseBytes(
      await sheetWith({
        9: ["First Officer", "DCA", "IAD", "PIT", "PHL", "api_lax_10_22_26_6.jpg", null],
        21: ["First Officer", "LAX", "LAS", "LAS", "PHX", "x21.jpg", null],
        44: ["Check Airman", "FRA", "MUN", "LHR", "ORY", "x44.jpg", null],
      }),
    );
    expect(original.issues.filter((i) => i.message.startsWith("Corrected")).map((i) => i.row)).toEqual([9, 21, 44]);
    expect(original.issues.filter((i) => i.level === "error")).toEqual([]);

    // The client fixed row 9's file and row 44's code: nothing fires for them and the values are kept.
    const fixed = await parseBytes(
      await sheetWith({
        9: ["First Officer", "DCA", "IAD", "PIT", "PHL", "api_dca_10_22_26_1.jpg", null],
        44: ["Check Airman", "FRA", "MUC", "LHR", "ORY", "x44.jpg", null],
      }),
    );
    expect(fixed.issues.filter((i) => i.message.startsWith("Corrected"))).toEqual([]);
    expect(fixed.rows.find((r) => r.row === 9)?.data).toMatchObject({ sourceFile: "api_dca_10_22_26_1.jpg" });
  });

  it("does not fire when a different airport sits on the row, or the original differs (never guessed)", async () => {
    const { rows, issues } = await parseBytes(
      await sheetWith({
        44: ["Check Airman", "LHR", "MUN", "FRA", "ORY", "x44.jpg", null], // answer is not FRA: no correction
        9: ["First Officer", "DCA", "IAD", "PIT", "PHL", "api_lax_10_22_26_66.jpg", null], // other file: kept as written
        21: ["First Officer", "LAX", "LAS", "PHX", "ZZZ", "x21.jpg", null], // LAS only once here
      }),
    );
    expect(issues.filter((i) => i.message.startsWith("Corrected"))).toEqual([]);
    expect(rows.find((r) => r.row === 44)?.data).toMatchObject({ wrong: ["MUN", "FRA", "ORY"] }); // MUN passes as a valid code shape
    expect(rows.find((r) => r.row === 9)?.data).toMatchObject({ sourceFile: "api_lax_10_22_26_66.jpg" });
  });

  it("a duplicated code outside the table is an error, not guessed", async () => {
    const { rows, issues } = await parseBytes(await sheetWith({ 5: ["Trainee", "LAX", "SAN", "SAN", "BUR", "g.jpg", null] }));
    expect(rows.some((r) => r.row === 5)).toBe(false);
    expect(issues.find((i) => i.row === 5)).toMatchObject({ level: "error", message: expect.stringContaining("different") });
  });

  it("an admin export (with an Id column) is taken as written, corrections never apply", async () => {
    const bytes = await xlsx([
      [...AIRPORT_SPOTTER_EXPORT_HEADER],
      ["apt-a1", 1, "Captain", "FRA", "MUN", "LHR", "ORY", "api_dca_10_22_26_3.JPG", "approved"],
    ]);
    const { kind, rows, issues } = await parseBytes(bytes);
    expect(kind).toBe("admin_export");
    expect(rows[0]).toMatchObject({ id: "apt-a1", version: 1, rank: "captain", data: { answer: "FRA", wrong: ["MUN", "LHR", "ORY"], sourceFile: "api_dca_10_22_26_3.JPG" } });
    expect(issues.some((i) => i.message.startsWith("Corrected"))).toBe(false);
  });
});

describe("Airport Spotter mapping: ids, export and registry", () => {
  it("is registered; ids are apt-a<N>", () => {
    expect(contentMappingFor("airport-spotter")).toBe(airportSpotterMapping);
    expect(airportSpotterMapping.formatId(7)).toBe("apt-a7");
    expect(airportSpotterMapping.formatId(10_000_000)).toBeUndefined();
    expect(airportSpotterMapping.idNumber("apt-a12")).toBe(12);
    expect(airportSpotterMapping.idNumber("mil-a12")).toBeUndefined();
    expect(airportSpotterMapping.idNumber("apt-a0")).toBeUndefined();
  });

  it("exports in the client's column wording plus Id, Version, Status, and re-parses to the same items", async () => {
    const parsed = await parseBytes(await withHeader([["Captain", "lax", " DEN", "LAS", "PIT", " api_lax_10_22_26_1.jpg ", null]]));
    expect(parsed.rows[0]?.data).toEqual({ answer: "LAX", wrong: ["DEN", "LAS", "PIT"], sourceFile: "api_lax_10_22_26_1.jpg" });
    const exported = airportSpotterMapping.exportRows([{ id: "apt-a1", rank: "captain", status: "approved", version: 3, data: parsed.rows[0]?.data }]);
    expect(exported).toEqual([
      ["Id", "Version", "LEVEL", "Correct Airport", "Wrong Airport 1", "Wrong Airport 2", "Wrong Airport 3", "File name", "Status"],
      ["apt-a1", 3, "Captain", "LAX", "DEN", "LAS", "PIT", "api_lax_10_22_26_1.jpg", "approved"],
    ]);
    const again = airportSpotterMapping.parse(exported as SheetRow[]);
    expect(again.kind).toBe("admin_export");
    expect(again.rows[0]).toMatchObject({ id: "apt-a1", version: 3, rank: "captain", data: parsed.rows[0]?.data });
  });

  it("finds the header within the first 10 rows and rejects a file without one", async () => {
    await expect(parseBytes(await xlsx([["Level", "Answer"], ["Trainee", "x"]]))).rejects.toThrow("header row");
    const { rows } = await parseBytes(await xlsx([["Airports"], ["file name", "wrong airport 3", "Wrong Airport 2", "wrong airport 1", "correct airport", "level"], ["a.jpg", "CCC", "BBB", "AAA", "XXX", "Chief Pilot"]].map((r) => r.map((c) => c as TestCell))));
    expect(rows[0]).toMatchObject({ rank: "chief-pilot", data: { answer: "XXX", wrong: ["AAA", "BBB", "CCC"], sourceFile: "a.jpg" } });
  });

  it("placeholder rows are skipped; a bad Level is an error; a missing file name is a warning at parse (planner errors)", async () => {
    const { rows, issues } = await parseBytes(
      await withHeader([
        ["Trainee", null, null, null, null, null, null],
        ["Admiral", "AAA", "BBB", "CCC", "DDD", "a.jpg", null],
        ["Trainee", "AAA", "BBB", "CCC", "DDD", null, null],
      ]),
    );
    expect(issues.map((i) => [i.row, i.level])).toEqual([[4, "warning"], [5, "error"], [6, "warning"]]);
    expect(rows.map((r) => r.row)).toEqual([6]);
    const plan = planImport(rows, new Map(), { kind: "client_sheet", mapping: airportSpotterMapping });
    expect(plan.issues[0]?.message).toContain("File name is empty");
  });
});

describe("airportSpotterMapping.validatePayload", () => {
  const good = { answer: "LAX", wrong: ["DEN", "LAS", "PIT"], sourceFile: "f.jpg" };

  it("trims and upper-cases codes", () => {
    const result = airportSpotterMapping.validatePayload({ answer: " lax ", wrong: ["den", " Las", "pit "], sourceFile: " f.jpg " });
    expect(result.problems).toEqual([]);
    expect(result.data).toEqual({ answer: "LAX", wrong: ["DEN", "LAS", "PIT"], sourceFile: "f.jpg" });
  });

  it("flags missing, malformed, duplicate and non-IATA codes", () => {
    expect(airportSpotterMapping.validatePayload({ ...good, answer: "  " }).problems).toContain("Correct Airport is missing.");
    expect(airportSpotterMapping.validatePayload({ ...good, wrong: ["DEN", "", "PIT"] }).problems).toContain("Wrong Airport 2 is missing.");
    expect(airportSpotterMapping.validatePayload({ ...good, wrong: ["DENV", "LAS", "PIT"] }).problems[0]).toContain("3-letter airport code");
    expect(airportSpotterMapping.validatePayload({ ...good, wrong: ["D3N", "LAS", "PIT"] }).problems[0]).toContain("3-letter airport code");
    expect(airportSpotterMapping.validatePayload({ ...good, wrong: ["LAX", "LAS", "PIT"] }).problems).toContain("The correct and wrong airports must all be different.");
    expect(airportSpotterMapping.validatePayload({ ...good, wrong: ["las", "LAS", "PIT"] }).problems).toContain("The correct and wrong airports must all be different.");
  });

  it("is strict about shape", () => {
    for (const bad of [null, "x", [], 5]) expect(airportSpotterMapping.validatePayload(bad).problems).toHaveLength(1);
    expect(airportSpotterMapping.validatePayload({ ...good, photographer: "x" }).problems[0]).toContain("Unknown field(s): photographer");
    expect(airportSpotterMapping.validatePayload({ ...good, answer: 5 }).problems).toContain("Correct Airport must be text.");
    expect(airportSpotterMapping.validatePayload({ ...good, wrong: ["a", "b"] }).problems).toContain("wrong must be exactly three airport codes.");
    const { sourceFile: _omit, ...noFile } = good;
    expect(airportSpotterMapping.validatePayload(noFile).problems).toEqual(["File name must be text."]);
  });
});
