import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ImportIssue } from "../src/content/content-module.js";
import { planImport } from "../src/content/import-plan.js";
import type { ExistingItem } from "../src/content/import-plan.js";
import { contentMappingFor } from "../src/content/content-modules.js";
import { IDENTIFIER_EXPORT_HEADER, IDENTIFIER_ID, aircraftIdentifierMapping } from "../src/content/modules/aircraft-identifier.js";
import { SpreadsheetError, readFirstSheet } from "../src/content/xlsx.js";
import { xlsx } from "./fixtures.js";
import type { TestCell } from "./fixtures.js";

// The client's 2026-09-28 sheet and Unity's import of it (read-only; both tests skip when the files are absent).
const CLIENT_FILE = "C:/Unity/Projects/AviationArcade_v2/docs/client-content/2026-09-28/Airplane Identifier v1.xlsx";
const UNITY_JSON = "C:/Unity/Projects/AviationArcade_v2/Assets/_Project/Resources/ClientContent/identifier_questions.json";

const HEADER = ["Level", "Correct Answer", "Wrong Answer 1", "Wrong Answer 2", "Wrong Answer 3", "file", "folder", "H/V", "Resolution"];
const withHeader = (rows: TestCell[][]) => xlsx([[null], [null], HEADER, ...rows]);
const parseBytes = async (bytes: Buffer) => aircraftIdentifierMapping.parse(await readFirstSheet(bytes));
/** A data row with the four labels distinct unless overridden. */
const q = (file: string, level = "Trainee", answer = "Boeing 737", wrong: [string, string, string] = ["Airbus A320", "Airbus A321", "Boeing 757"]): TestCell[] => [
  level,
  answer,
  ...wrong,
  file,
];

const UNITY_RANK: Record<string, string> = {
  Trainee: "trainee",
  FirstOfficer: "first-officer",
  Captain: "captain",
  CheckAirman: "check-airman",
  ChiefPilot: "chief-pilot",
};

const warnings = (issues: ImportIssue[], prefix: string) => issues.filter((i) => i.level === "warning" && i.message.startsWith(prefix));

describe("Identifier mapping: the client's real sheet", () => {
  it.skipIf(!existsSync(CLIENT_FILE))("parses 31 questions: Unity's ids, its five fixes and its two left-out rows", async () => {
    const { kind, rows, issues } = await parseBytes(readFileSync(CLIENT_FILE));
    expect(kind).toBe("client_sheet");
    expect(issues.filter((i) => i.level !== "warning")).toEqual([]);
    expect(rows).toHaveLength(31);

    const expectedIds: string[] = [];
    for (let n = 1; n <= 31; n++) {
      if (n === 8 || n === 14) continue;
      expectedIds.push(`ai-a${n}`);
      if (n === 11 || n === 18) expectedIds.push(`ai-a${n}-2`);
    }
    expect(rows.map((r) => r.naturalKey)).toEqual(expectedIds);

    const left = warnings(issues, "Left out:");
    expect(left.map((i) => i.row)).toEqual([11, 18]);
    expect(left[0]?.message).toContain("two wrong answers are the same");
    expect(left[1]?.message).toContain("the correct answer `Boeing 787-9` is also listed as a wrong answer");

    const fixed = warnings(issues, "Corrected on import:");
    expect(fixed.map((i) => i.row)).toEqual([4, 8, 10, 28, 35]);
    expect(fixed.filter((i) => i.message.includes('"Boing" corrected to "Boeing"'))).toHaveLength(4);
    expect(fixed.find((i) => i.row === 28)?.message).toContain("`ai-a23/jpg` corrected to `ai-a23.jpg`");
    expect(rows.find((r) => r.naturalKey === "ai-a23")?.data).toMatchObject({ sourceFile: "ai-a23.jpg" });
    expect(rows.find((r) => r.naturalKey === "ai-a1")?.data).toEqual({ answer: "Boeing 787-10", wrong: ["Boeing 787-9", "Boeing 787-8", "Boeing 767-200"], sourceFile: "ai-a1.jpg" });
    // Nothing else was rewritten: every photo has an image extension, so no extension warning remains.
    expect(issues.filter((i) => i.message.includes("has no .jpg"))).toEqual([]);

    // The planner takes the ids as they are, and a re-import is all unchanged.
    const first = planImport(rows, new Map(), { kind, mapping: aircraftIdentifierMapping });
    expect(first.issues).toEqual([]);
    expect(first.rows.map((r) => r.id)).toEqual(expectedIds);
    const stored = new Map<string, ExistingItem>(first.rows.map((r) => [r.id, { id: r.id, rank: r.rank, status: "approved", version: 1, data: r.data }]));
    const again = planImport(rows, stored, { kind, mapping: aircraftIdentifierMapping });
    expect(again.counts).toEqual({ created: 0, updated: 0, unchanged: 31, retired: 0 });
  });

  it.skipIf(!existsSync(CLIENT_FILE) || !existsSync(UNITY_JSON))("matches Unity's identifier_questions.json: same ids, ranks, answers and wrong answers, in order", async () => {
    const { rows } = await parseBytes(readFileSync(CLIENT_FILE));
    const unity = JSON.parse(readFileSync(UNITY_JSON, "utf8").replace(/^\uFEFF/, "")) as {
      questions: { id: string; photoId: string; level: string; answer: string; wrong: string[] }[];
    };
    expect(unity.questions).toHaveLength(31);
    expect(rows.map((r) => r.naturalKey)).toEqual(unity.questions.map((u) => u.id));
    for (const [i, u] of unity.questions.entries()) {
      const mine = rows[i];
      expect(mine?.rank, u.id).toBe(UNITY_RANK[u.level]);
      expect(mine?.data["answer"], u.id).toBe(u.answer);
      expect(mine?.data["wrong"], u.id).toEqual(u.wrong);
      expect(String(mine?.data["sourceFile"]).replace(/\.[a-z]+$/, ""), u.id).toBe(u.photoId);
    }
  });
});

describe("Identifier mapping: header and shape", () => {
  it("is registered as module identifier, with keyIsId", () => {
    expect(contentMappingFor("identifier")).toBe(aircraftIdentifierMapping);
    expect(aircraftIdentifierMapping.module).toBe("identifier");
    expect(aircraftIdentifierMapping.keyIsId).toBe(true);
  });

  it("finds the header below the title rows, ignores folder / H/V / Resolution, rows keep their sheet row numbers", async () => {
    const { kind, rows, issues } = await parseBytes(await withHeader([q("ai-a1.jpg", "Captain"), q("ai-a2.jpg", "Chief Pilot")]));
    expect(kind).toBe("client_sheet");
    expect(issues).toEqual([]);
    expect(rows.map((r) => [r.row, r.id, r.naturalKey, r.rank])).toEqual([
      [4, undefined, "ai-a1", "captain"],
      [5, undefined, "ai-a2", "chief-pilot"],
    ]);
    expect(rows[0]?.data).toEqual({ answer: "Boeing 737", wrong: ["Airbus A320", "Airbus A321", "Boeing 757"], sourceFile: "ai-a1.jpg" });
  });

  it("a sheet without the header row is a SpreadsheetError", async () => {
    await expect(parseBytes(await xlsx([["Level", "Correct Answer"], ["Trainee", "x"]]))).rejects.toBeInstanceOf(SpreadsheetError);
  });

  it("rows with neither answer nor file are skipped (a Level or wrong answer alone gets a placeholder warning, a blank row none)", async () => {
    const { rows, issues } = await parseBytes(
      await withHeader([["Trainee", null, null, null, null, null], [null, null, null, null, null, null], [null, null, "x", null, null, null], q("ai-a1.jpg")]),
    );
    expect(rows).toHaveLength(1);
    expect(issues.map((i) => [i.row, i.level])).toEqual([
      [4, "warning"],
      [6, "warning"],
    ]);
    expect(issues[0]?.message).toContain("Placeholder row");
  });

  it("the id pattern", () => {
    for (const ok of ["ai-a1", "ai-a31", "ai-a11-2", "ai-a11-9", "ai-a11-10", "ai-a11-999"]) expect(IDENTIFIER_ID.test(ok), ok).toBe(true);
    for (const bad of ["ai-a0", "ai-a01", "ai-a11-1", "ai-a11-0", "ai-a11-1000", "ai-a11-", "ai-a1.jpg", "mil-a1", "AI-A1", "ai-a1234567"]) expect(IDENTIFIER_ID.test(bad), bad).toBe(false);
    expect(aircraftIdentifierMapping.formatId(12)).toBe("ai-a12");
    expect(aircraftIdentifierMapping.idNumber("ai-a11-2")).toBe(11);
    expect(aircraftIdentifierMapping.idNumber("ai-a11")).toBe(11);
    expect(aircraftIdentifierMapping.idNumber("mil-a1")).toBeUndefined();
  });
});

describe("Identifier mapping: Unity's two fixes", () => {
  it('"Boing" becomes "Boeing" as a whole word in all four labels, one warning per label', async () => {
    const { rows, issues } = await parseBytes(await withHeader([q("ai-a1.jpg", "Trainee", "Boing 737", ["Boing 747", "Boinger 1", "Airbus A320"])]));
    expect(rows[0]?.data).toMatchObject({ answer: "Boeing 737", wrong: ["Boeing 747", "Boinger 1", "Airbus A320"] });
    const fixes = warnings(issues, "Corrected on import:");
    expect(fixes.map((i) => i.message.split(" ").slice(3, 5).join(" "))).toEqual(["Correct Answer", "Wrong Answer"]);
    expect(fixes.every((i) => i.row === 4 && i.id === "ai-a1")).toBe(true);
    expect(fixes[0]?.message).toContain("`Boing 737`");
  });

  it("a slash typed for the dot before jpg/jpeg/png is fixed (either slash, any case, extension lower-cased)", async () => {
    const { rows, issues } = await parseBytes(
      await withHeader([q("ai-a1/jpg"), q("ai-a2\\JPEG"), q("ai-a3/PNG")]),
    );
    expect(rows.map((r) => [r.naturalKey, r.data["sourceFile"]])).toEqual([
      ["ai-a1", "ai-a1.jpg"],
      ["ai-a2", "ai-a2.jpeg"],
      ["ai-a3", "ai-a3.png"],
    ]);
    expect(warnings(issues, "Corrected on import:")).toHaveLength(3);
  });

  it("nothing else is rewritten: another extension case, a missing extension, inner spacing and other typos stay as written", async () => {
    const { rows, issues } = await parseBytes(
      await withHeader([q("ai-a1.JPG", "Trainee", "Boeing  737", ["Airbuss A320", "Airbus A321", "boeing 757"]), q("ai-a2"), q("ai-a3/gif")]),
    );
    expect(rows.map((r) => r.naturalKey)).toEqual(["ai-a1", "ai-a2"]); // "ai-a3/gif" is not a fixable name: not a valid id
    expect(rows[0]?.data).toEqual({ answer: "Boeing  737", wrong: ["Airbuss A320", "Airbus A321", "boeing 757"], sourceFile: "ai-a1.JPG" });
    expect(warnings(issues, "Corrected on import:")).toEqual([]);
    expect(issues.filter((i) => i.row === 5 && i.level === "warning").map((i) => i.message)).toEqual(["File name has no .jpg/.jpeg/.png extension."]);
    expect(issues.filter((i) => i.level === "error").map((i) => i.row)).toEqual([6]);
  });

  it("an admin export (Id column) is taken as written: no fixes, no leave-outs", async () => {
    const bytes = await xlsx([
      ["Id", "Version", "Level", "Correct Answer", "Wrong Answer 1", "Wrong Answer 2", "Wrong Answer 3", "file", "Status"],
      ["ai-a7", 2, "Trainee", "Boing 737", "Airbus A320", "Airbus A321", "Boeing 757", "ai-a7/jpg", "approved"],
      ["ai-a8", null, "Trainee", "Boeing 737", "Airbus A320", "Airbus A321", "airbus a321", "ai-a8.jpg", "approved"],
    ]);
    const { kind, rows, issues } = await parseBytes(bytes);
    expect(kind).toBe("admin_export");
    expect(rows.map((r) => [r.id, r.naturalKey, r.version, r.data["answer"], r.data["sourceFile"]])).toEqual([["ai-a7", "ai-a7", 2, "Boing 737", "ai-a7/jpg"]]);
    expect(issues.filter((i) => i.level === "error").map((i) => [i.row, i.id])).toEqual([[3, "ai-a8"]]); // refused by validatePayload, not dropped
    expect(warnings(issues, "Corrected on import:")).toEqual([]);
    expect(warnings(issues, "Left out:")).toEqual([]);
  });
});

describe("Identifier mapping: rows Unity leaves out", () => {
  it.each([
    ["an empty wrong answer", q("ai-a1.jpg", "Trainee", "Boeing 737", ["Airbus A320", "", "Boeing 757"]), "an answer cell is empty"],
    ["an empty correct answer", q("ai-a1.jpg", "Trainee", "", ["Airbus A320", "Airbus A321", "Boeing 757"]), "an answer cell is empty"],
    ["the correct answer repeated, other case", q("ai-a1.jpg", "Trainee", "Boeing 737", ["Airbus A320", "BOEING 737", "Boeing 757"]), "is also listed as a wrong answer"],
    ["two equal wrong answers, other case", q("ai-a1.jpg", "Trainee", "Boeing 737", ["Airbus A320", "Airbus A321", "airbus a321"]), "two wrong answers are the same"],
  ])("%s is left out with a warning and takes no id", async (_name, bad, reason) => {
    const { rows, issues } = await parseBytes(await withHeader([bad, q("ai-a1.jpg", "Captain")]));
    expect(rows.map((r) => [r.row, r.naturalKey, r.rank])).toEqual([[5, "ai-a1", "captain"]]); // the next row on the photo is plain ai-a1, not -2
    const left = warnings(issues, "Left out:");
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ row: 4 });
    expect(left[0]?.message).toContain(reason);
    expect(left[0]?.message).toContain("Answers:");
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("the Boing fix runs before the check: a label that becomes a duplicate is left out", async () => {
    const { rows, issues } = await parseBytes(await withHeader([q("ai-a1.jpg", "Trainee", "Boing 737", ["Airbus A320", "Boeing 737", "Boeing 757"])]));
    expect(rows).toEqual([]);
    expect(warnings(issues, "Left out:")).toHaveLength(1);
    expect(warnings(issues, "Corrected on import:")).toHaveLength(1);
  });

  it("the leave-out check runs before the level: a left-out row with a bad level is not an error", async () => {
    const { rows, issues } = await parseBytes(await withHeader([q("ai-a1.jpg", "Admiral", "Boeing 737", ["Airbus A320", "Airbus A320", "Boeing 757"])]));
    expect(rows).toEqual([]);
    expect(issues.map((i) => i.level)).toEqual(["warning"]);
  });

  it("a row Unity keeps but validatePayload refuses (labels differing only in inner spacing) is an error, never dropped", async () => {
    const { rows, issues } = await parseBytes(await withHeader([q("ai-a1.jpg", "Trainee", "Boeing 737", ["Airbus  A320", "Airbus A320", "Boeing 757"])]));
    expect(rows).toEqual([]);
    expect(warnings(issues, "Left out:")).toEqual([]);
    expect(issues).toEqual([expect.objectContaining({ row: 4, id: "ai-a1", level: "error", message: expect.stringContaining("must all be different") })]);
  });

  it("the Level is checked for a kept row: missing or unknown is an error", async () => {
    const { rows, issues } = await parseBytes(await withHeader([q("ai-a1.jpg", ""), q("ai-a2.jpg", "Admiral")]));
    expect(rows).toEqual([]);
    expect(issues.map((i) => i.message)).toEqual(["Level is missing.", expect.stringContaining("Level is not one of")]);
  });
});

describe("Identifier mapping: ids", () => {
  it("the k-th kept row on a photo gets -k, in sheet order, whatever sits between", async () => {
    const { rows } = await parseBytes(await withHeader([q("ai-a5.jpg"), q("ai-a6.jpg"), q("ai-a5.jpg", "Captain"), q("ai-a5.jpg", "Chief Pilot")]));
    expect(rows.map((r) => r.naturalKey)).toEqual(["ai-a5", "ai-a6", "ai-a5-2", "ai-a5-3"]);
  });

  it("a file name that gives no valid id, or none, is a row error", async () => {
    const { rows, issues } = await parseBytes(await withHeader([q("photo1.jpg"), q(""), q("AI-A3.jpg"), q("ai-a04.jpg")]));
    expect(rows).toEqual([]);
    expect(issues.filter((i) => i.level === "error").map((i) => i.row)).toEqual([4, 5, 6, 7]);
    expect(issues[1]?.message).toContain("File name is empty");
  });

  it("a stem that collides with a generated -k id is a repeated key for the planner", async () => {
    const { rows, kind } = await parseBytes(await withHeader([q("ai-a5.jpg"), q("ai-a5.jpg", "Captain"), q("ai-a5-2.jpg", "Chief Pilot")]));
    const p = planImport(rows, new Map(), { kind, mapping: aircraftIdentifierMapping });
    expect(p.issues).toEqual([expect.objectContaining({ row: 6, level: "error" })]);
  });
});

describe("Identifier mapping: payload and export", () => {
  it("validatePayload: strict keys, four distinct answers after trim, collapse and lower-case", () => {
    const ok = aircraftIdentifierMapping.validatePayload({ answer: " A ", wrong: ["b", "c", "d"], sourceFile: " ai-a1.jpg " });
    expect(ok).toEqual({ data: { answer: "A", wrong: ["b", "c", "d"], sourceFile: "ai-a1.jpg" }, problems: [] });
    expect(aircraftIdentifierMapping.validatePayload({ answer: "A", wrong: ["b", "c", "d"], sourceFile: "x", photographer: "p" }).problems).toEqual(["Unknown field(s): photographer."]);
    expect(aircraftIdentifierMapping.validatePayload({ answer: "A", wrong: ["a", "c", "d"], sourceFile: "x" }).problems).toEqual(["The correct and wrong answers must all be different."]);
    expect(aircraftIdentifierMapping.validatePayload({ answer: "A", wrong: ["b", "c"], sourceFile: "x" }).problems).toContain("wrong must be exactly three answers.");
    expect(aircraftIdentifierMapping.validatePayload([]).problems).toHaveLength(1);
  });

  it("exports Id, Version, Level, answers, file, Status, and the export re-imports as an admin export", async () => {
    const rows = aircraftIdentifierMapping.exportRows([
      { id: "ai-a11-2", rank: "chief-pilot", status: "approved", version: 3, data: { answer: "A", wrong: ["b", "c", "d"], sourceFile: "ai-a11.jpg" } },
    ]);
    expect(rows[0]).toEqual([...IDENTIFIER_EXPORT_HEADER]);
    expect(rows[1]).toEqual(["ai-a11-2", 3, "Chief Pilot", "A", "b", "c", "d", "ai-a11.jpg", "approved"]);
    const parsed = await parseBytes(await xlsx(rows));
    expect(parsed.kind).toBe("admin_export");
    expect(parsed.rows).toEqual([expect.objectContaining({ id: "ai-a11-2", version: 3, rank: "chief-pilot" })]);
  });
});

describe("Identifier mapping: ASSUMPTION: fixing or removing an earlier left-out row on a shared photo renumbers the later -k ids", () => {
  // Ids follow the kept rows on a photo in sheet order, as in Unity. A later sheet that changes which earlier rows are kept
  // therefore moves the ids of the rows after it; against stored content that is an update/retire (and the Military-style
  // seed refuses it), never a silent rewrite. This pins the behaviour so a change is a conscious one.
  const bad = q("ai-a5.jpg", "Trainee", "Boeing 737", ["Airbus A320", "Airbus A320", "Boeing 757"]); // left out
  const fixedBad = q("ai-a5.jpg", "Trainee", "Boeing 737", ["Airbus A320", "Airbus A321", "Boeing 757"]);
  const second = q("ai-a5.jpg", "Captain", "Airbus A320", ["Boeing 737", "Boeing 757", "Boeing 767"]);
  const third = q("ai-a5.jpg", "Chief Pilot", "Airbus A321", ["Boeing 737", "Boeing 757", "Boeing 767"]);

  const store = (rows: { id: string; rank: ExistingItem["rank"]; data: Record<string, unknown> }[]) =>
    new Map<string, ExistingItem>(rows.map((r) => [r.id, { ...r, status: "approved", version: 1 }]));
  const planOf = async (existing: Map<string, ExistingItem>, rows: TestCell[][]) => {
    const parsed = await parseBytes(await withHeader(rows));
    return planImport(parsed.rows, existing, { kind: parsed.kind, mapping: aircraftIdentifierMapping });
  };

  it("fixing the left-out first row: every later id moves up, so two updates and a create", async () => {
    const first = await parseBytes(await withHeader([bad, second, third]));
    expect(first.rows.map((r) => r.naturalKey)).toEqual(["ai-a5", "ai-a5-2"]);
    const existing = store(first.rows.map((r) => ({ id: r.naturalKey, rank: r.rank, data: r.data })));
    const p = await planOf(existing, [fixedBad, second, third]);
    expect(p.issues).toEqual([]);
    expect(p.rows.map((r) => [r.id, r.action])).toEqual([
      ["ai-a5", "update"],
      ["ai-a5-2", "update"],
      ["ai-a5-3", "create"],
    ]);
    expect(p.requiresConfirm).toBe(true);
  });

  it("leaving a kept first row out: later ids move down, so updates and a retirement", async () => {
    const first = await parseBytes(await withHeader([fixedBad, second, third]));
    expect(first.rows.map((r) => r.naturalKey)).toEqual(["ai-a5", "ai-a5-2", "ai-a5-3"]);
    const existing = store(first.rows.map((r) => ({ id: r.naturalKey, rank: r.rank, data: r.data })));
    const p = await planOf(existing, [bad, second, third]);
    expect(p.rows.map((r) => [r.id, r.action])).toEqual([
      ["ai-a5", "update"],
      ["ai-a5-2", "update"],
    ]);
    expect(p.retirements.map((r) => r.id)).toEqual(["ai-a5-3"]);
    expect(p.requiresConfirm).toBe(true);
  });
});
