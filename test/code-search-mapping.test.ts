import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codeSearchMapping, CODE_SEARCH_CLIENT_HEADER, CODE_SEARCH_EXPORT_HEADER } from "../src/content/modules/code-search.js";
import { contentMappingFor } from "../src/content/content-modules.js";
import { planImport } from "../src/content/import-plan.js";
import type { ExistingItem } from "../src/content/import-plan.js";
import { SpreadsheetError, readFirstSheet } from "../src/content/xlsx.js";
import type { SheetRow } from "../src/content/xlsx.js";
import { rankFromDisplayName } from "../src/rules/catalog.js";
import { xlsx } from "./fixtures.js";

// Code Search content mapping (docs/plans/code-search.md section 2 and G), on boards copied from the client's master pack.

type Board = { id: string; rank: string; letters: string; targets: Record<string, unknown>[] };
const sample = JSON.parse(readFileSync(new URL("./fixtures/code-search-sample.json", import.meta.url), "utf8")) as { records: Board[] };
const LEVEL: Record<string, string> = { Trainee: "Trainee", FirstOfficer: "First Officer", Captain: "Captain", CheckAirman: "Check Airman", ChiefPilot: "Chief Pilot" };
const firstOf = (rank: string) => sample.records.find((r) => r.rank === rank) as Board;
const trainee = firstOf("Trainee");
const captain = firstOf("Captain");

const clientRow = (b: Board, over: Partial<Record<"id" | "level" | "letters" | "targets", string>> = {}): string[] => [
  over.id ?? b.id,
  over.level ?? (LEVEL[b.rank] as string),
  over.letters ?? b.letters,
  over.targets ?? JSON.stringify(b.targets),
];
const clientSheet = (...rows: string[][]): SheetRow[] => [[...CODE_SEARCH_CLIENT_HEADER], ...rows];

describe("code-search mapping: registration and ids", () => {
  it("is registered and keyed by id", () => {
    expect(contentMappingFor("code-search")).toBe(codeSearchMapping);
    expect(codeSearchMapping.keyIsId).toBe(true);
  });

  it("idNumber is the four digits for a pack id and undefined for every other shape, FIXTURE- ids included", () => {
    expect(codeSearchMapping.idNumber("CS-TR-0001")).toBe(1);
    expect(codeSearchMapping.idNumber("CS-CP-0750")).toBe(750);
    for (const bad of ["FIXTURE-TR-0001", "CS-XX-0001", "CS-TR-001", "CS-TR-00012", "cs-tr-0001", "mil-a1", "CS-TR-0001-2", ""]) {
      expect(codeSearchMapping.idNumber(bad), bad).toBeUndefined();
    }
  });

  it("formatId makes no id (there is no sequence)", () => {
    expect(codeSearchMapping.formatId(1)).toBeUndefined();
  });
});

describe("code-search mapping: client sheet", () => {
  it("reads every rank, with display names, the id as natural key and the payload keys in order", () => {
    const rows = clientSheet(...sample.records.map((b) => clientRow(b)));
    const parsed = codeSearchMapping.parse(rows);
    expect(parsed.kind).toBe("client_sheet");
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(60);
    expect(new Set(parsed.rows.map((r) => r.rank))).toEqual(new Set(["trainee", "first-officer", "captain", "check-airman", "chief-pilot"]));
    const first = parsed.rows[0];
    expect(first?.id).toBeUndefined();
    expect(first?.naturalKey).toBe(sample.records[0]?.id);
    expect(first?.version).toBeUndefined();
    expect(Object.keys(first?.data ?? {})).toEqual(["letters", "targets"]);
    expect(first?.row).toBe(2);
  });

  it("finds the header in the first 10 rows and skips blank rows", () => {
    const rows: SheetRow[] = [[null], [null], [...CODE_SEARCH_CLIENT_HEADER], clientRow(trainee), [null, null, null, null], clientRow(captain)];
    const parsed = codeSearchMapping.parse(rows);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows.map((r) => r.row)).toEqual([4, 6]);
  });

  it("reads a real xlsx round trip", async () => {
    const bytes = await xlsx([[...CODE_SEARCH_CLIENT_HEADER], clientRow(trainee)]);
    const parsed = codeSearchMapping.parse(await readFirstSheet(bytes));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.data).toEqual({ letters: trainee.letters, targets: trainee.targets });
  });

  it("throws a file-level error when the header is missing or has neither Game ID nor Id", () => {
    expect(() => codeSearchMapping.parse([["a", "b"], ["c", "d"]])).toThrow(SpreadsheetError);
    expect(() => codeSearchMapping.parse([["Level", "Letters", "Targets"]])).toThrow(SpreadsheetError);
    const late: SheetRow[] = [...Array.from({ length: 10 }, () => [null] as SheetRow), [...CODE_SEARCH_CLIENT_HEADER]];
    expect(() => codeSearchMapping.parse(late)).toThrow(SpreadsheetError);
  });

  const errorOf = (row: string[]) => {
    const parsed = codeSearchMapping.parse(clientSheet(row));
    expect(parsed.rows).toEqual([]);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.level).toBe("error");
    return parsed.issues[0]?.message ?? "";
  };

  it("refuses a missing or unknown Level", () => {
    expect(errorOf(clientRow(trainee, { level: "" }))).toContain("Level is missing.");
    expect(errorOf(clientRow(trainee, { level: "Admiral" }))).toContain("Level is not one of");
  });

  it("refuses a missing, malformed or FIXTURE- id", () => {
    expect(errorOf(clientRow(trainee, { id: "" }))).toContain("Game ID is missing.");
    expect(errorOf(clientRow(trainee, { id: "CS-TR-1" }))).toContain("Id must look like CS-TR-0001");
    expect(errorOf(clientRow(trainee, { id: "FIXTURE-TR-0001" }))).toContain("Id must look like CS-TR-0001");
  });

  it("refuses an id prefix that does not match the Level", () => {
    expect(errorOf(clientRow(trainee, { level: "Captain" }))).toContain("id prefix that does not match its rank");
  });

  it("refuses bad JSON, an empty Targets cell and a Targets cell that is not a list", () => {
    expect(errorOf(clientRow(trainee, { targets: "[{" }))).toContain("not valid JSON");
    expect(errorOf(clientRow(trainee, { targets: "" }))).toContain("Targets is missing.");
    expect(errorOf(clientRow(trainee, { targets: "{}" }))).toContain("targets must be a list.");
  });

  it("refuses non-canonical input instead of normalising it", () => {
    expect(errorOf(clientRow(trainee, { letters: trainee.letters.toLowerCase() }))).toContain("upper case");
    const spaced = trainee.targets.map((t, i) => (i === 0 ? { ...t, code: ` ${String(t["code"])}` } : t));
    expect(errorOf(clientRow(trainee, { targets: JSON.stringify(spaced) }))).toContain("trimmed and upper case");
  });

  it("refuses an unknown or missing target key and a wrong type", () => {
    const extra = trainee.targets.map((t, i) => (i === 0 ? { ...t, note: "x" } : t));
    expect(errorOf(clientRow(trainee, { targets: JSON.stringify(extra) }))).toContain("unknown key 'note'");
    const { clue: _clue, ...without } = trainee.targets[0] as Record<string, unknown>;
    expect(errorOf(clientRow(trainee, { targets: JSON.stringify([without, ...trainee.targets.slice(1)]) }))).toContain("is missing 'clue'");
    const typed = trainee.targets.map((t, i) => (i === 0 ? { ...t, row: "1" } : t));
    expect(errorOf(clientRow(trainee, { targets: JSON.stringify(typed) }))).toContain("row must be an integer");
  });

  it("refuses a letters grid that is not a square of 1 to 8", () => {
    expect(errorOf(clientRow(trainee, { letters: "ABCDE" }))).toContain("square grid");
  });

  it("refuses a puzzle-rule fault (a target moved off its letters)", () => {
    const moved = trainee.targets.map((t, i) => (i === 0 ? { ...t, column: ((t["column"] as number) + 1) % 6 } : t));
    expect(errorOf(clientRow(trainee, { targets: JSON.stringify(moved) }))).not.toBe("");
  });

  it("refuses a board that does not fit its rung (right prefix, wrong target count)", () => {
    const short = trainee.targets.slice(0, 3);
    expect(errorOf(clientRow(trainee, { targets: JSON.stringify(short) }))).toContain("does not fit its rank's grid or target count");
  });

  it("refuses a city count that is not the rung's", () => {
    const allCities = trainee.targets.map((t) => ({ ...t, city: true }));
    expect(errorOf(clientRow(trainee, { targets: JSON.stringify(allCities) }))).toContain("shows 4 cities; its rank shows 0");
  });

  it("reports one message per fault (no duplicates between the payload and fit checks)", () => {
    const message = errorOf(clientRow(trainee, { letters: "ABCDE" }));
    const sentences = message.split(/(?<=\.) /);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("keeps good rows and reports the bad one with its sheet row and id", () => {
    const parsed = codeSearchMapping.parse(clientSheet(clientRow(trainee), clientRow(captain, { targets: "[" }), clientRow(captain)));
    expect(parsed.rows.map((r) => r.row)).toEqual([2, 4]);
    expect(parsed.issues).toEqual([expect.objectContaining({ row: 3, id: captain.id, level: "error" })]);
  });
});

describe("code-search mapping: admin export sheet", () => {
  const exported = (b: Board, version: number | string, status = "approved"): (string | number)[] => [b.id, version, LEVEL[b.rank] as string, b.letters, JSON.stringify(b.targets), status];

  it("is an admin export when it has an Id column; carries id and version, ignores Status", () => {
    const parsed = codeSearchMapping.parse([[...CODE_SEARCH_EXPORT_HEADER], exported(trainee, 3, "retired"), exported(captain, "")]);
    expect(parsed.kind).toBe("admin_export");
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows.map((r) => [r.id, r.naturalKey, r.version, r.rank])).toEqual([
      [trainee.id, trainee.id, 3, "trainee"],
      [captain.id, captain.id, undefined, "captain"],
    ]);
  });

  it("refuses a bad Version and a missing Id", () => {
    const bad = codeSearchMapping.parse([[...CODE_SEARCH_EXPORT_HEADER], exported(trainee, "x")]);
    expect(bad.issues[0]?.message).toContain("Version must be a whole number");
    const noId = codeSearchMapping.parse([[...CODE_SEARCH_EXPORT_HEADER], ["", 1, "Trainee", trainee.letters, JSON.stringify(trainee.targets), "approved"]]);
    expect(noId.issues[0]?.message).toContain("Id is missing.");
  });

  it("exportRows writes the header, display names, fixed key order and the status", () => {
    const shuffled = trainee.targets.map((t) => Object.fromEntries(Object.entries(t).reverse()));
    const out = codeSearchMapping.exportRows([
      { id: trainee.id, rank: "trainee", status: "approved", version: 2, data: { targets: shuffled, letters: trainee.letters } },
      { id: captain.id, rank: "captain", status: "retired", version: 1, data: { letters: captain.letters, targets: captain.targets } },
    ]);
    expect(out[0]).toEqual([...CODE_SEARCH_EXPORT_HEADER]);
    expect(out[1]).toEqual([trainee.id, 2, "Trainee", trainee.letters, JSON.stringify(trainee.targets), "approved"]);
    expect(out[2]?.[2]).toBe("Captain");
    expect(out[2]?.[5]).toBe("retired");
  });

  it("an export parses back to the same rank and payload (planner: all unchanged)", () => {
    const items = sample.records.map((b, i) => ({
      id: b.id,
      rank: rankFromDisplayName(LEVEL[b.rank] as string) ?? "trainee",
      status: "approved" as const,
      version: i + 1,
      data: { letters: b.letters, targets: b.targets },
    }));
    const parsed = codeSearchMapping.parse(codeSearchMapping.exportRows(items));
    expect(parsed.issues).toEqual([]);
    const existing = new Map<string, ExistingItem>(items.map((i) => [i.id, i]));
    const plan = planImport(parsed.rows, existing, { kind: "admin_export", mapping: codeSearchMapping });
    expect(plan.issues).toEqual([]);
    expect(plan.counts).toEqual({ created: 0, updated: 0, unchanged: 60, retired: 0 });
  });
});

describe("code-search mapping: payload and item rules", () => {
  const data = { letters: trainee.letters, targets: trainee.targets };

  it("validatePayload accepts a canonical board and returns it unchanged", () => {
    const result = codeSearchMapping.validatePayload(data);
    expect(result.problems).toEqual([]);
    expect(result.data).toBe(data);
  });

  it("validatePayload refuses what the parser refuses and never normalises", () => {
    expect(codeSearchMapping.validatePayload({ ...data, letters: data.letters.toLowerCase() }).problems.join(" ")).toContain("upper case");
    expect(codeSearchMapping.validatePayload({ ...data, extra: 1 }).problems.join(" ")).toContain("unknown key 'extra'");
    for (const bad of [null, "x", [], 5]) {
      const result = codeSearchMapping.validatePayload(bad);
      expect(result.problems.length).toBeGreaterThan(0);
      expect(result.data).toEqual({});
    }
  });

  it("validateItem: the id prefix must name the rank and the board must fit the rung", () => {
    const validate = codeSearchMapping.validateItem;
    expect(validate?.(trainee.id, "trainee", data)).toEqual([]);
    expect(validate?.(trainee.id, "captain", data).join(" ")).toContain("id prefix that does not match its rank");
    expect(validate?.(captain.id, "captain", data).join(" ")).toContain("does not fit its rank's grid or target count");
    expect(validate?.("FIXTURE-TR-0001", "trainee", data).join(" ")).toContain("must look like CS-TR-0001");
  });

  it("naturalKey is the target codes joined by a space, non-blank for a board", () => {
    const key = codeSearchMapping.naturalKey(data);
    expect(key).toBe(trainee.targets.map((t) => t["code"]).join(" "));
    expect(key).not.toBe("");
    expect(codeSearchMapping.naturalKey(null)).toBe("");
    expect(codeSearchMapping.naturalKey({ targets: "x" })).toBe("");
  });
});
