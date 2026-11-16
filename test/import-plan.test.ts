import { describe, expect, it } from "vitest";
import type { ParsedRow, SheetKind } from "../src/content/content-module.js";
import { canonicalJson, diffItem, planHash, planImport } from "../src/content/import-plan.js";
import type { ExistingItem } from "../src/content/import-plan.js";
import { compareIds } from "../src/content/content-modules.js";
import { aircraftIdentifierMapping } from "../src/content/modules/aircraft-identifier.js";
import { militaryMapping } from "../src/content/modules/military.js";

const data = (answer: string, n = 0) => ({ answer, wrong: ["b", "c", "d"], sourceFile: `f${n}.jpg`, photographer: "P" });

/** An admin-export row: has an Id (and maybe a Version). */
const row = (n: number, answer = `A${n}`, version?: number, rank: ParsedRow["rank"] = "trainee"): ParsedRow => ({
  row: n + 3,
  id: `mil-a${n}`,
  naturalKey: `f${n}.jpg`,
  version,
  rank,
  data: data(answer, n),
});
/** A client-sheet row: no Id, matched by its file name. */
const sheetRow = (n: number, answer = `A${n}`, rank: ParsedRow["rank"] = "trainee", file = `f${n}.jpg`): ParsedRow => ({
  row: n + 3,
  id: undefined,
  naturalKey: file,
  version: undefined,
  rank,
  data: { ...data(answer, n), sourceFile: file },
});
const stored = (n: number, answer = `A${n}`, version = 1, rank: ExistingItem["rank"] = "trainee", status: ExistingItem["status"] = "approved"): [string, ExistingItem] => [
  `mil-a${n}`,
  { id: `mil-a${n}`, rank, status, version, data: data(answer, n) },
];

const plan = (rows: ParsedRow[], existing: [string, ExistingItem][], kind: SheetKind) =>
  planImport(rows, new Map(existing), { kind, mapping: militaryMapping });
const admin = (rows: ParsedRow[], existing: [string, ExistingItem][] = []) => plan(rows, existing, "admin_export");
const sheet = (rows: ParsedRow[], existing: [string, ExistingItem][] = []) => plan(rows, existing, "client_sheet");

describe("planImport: admin export (Id column)", () => {
  it("creates new ids and counts them", () => {
    const p = admin([row(1), row(2)]);
    expect(p.rows.map((r) => r.action)).toEqual(["create", "create"]);
    expect(p.counts).toEqual({ created: 2, updated: 0, unchanged: 0, retired: 0 });
    expect(p.issues).toEqual([]);
    expect(p.source).toBe("admin");
    expect(p.requiresConfirm).toBe(false);
  });

  it("without a Version: identical content is unchanged, different content is a conflict (never overwritten)", () => {
    const p = admin([row(1), row(2, "Changed")], [stored(1), stored(2)]);
    expect(p.rows.map((r) => [r.id, r.action])).toEqual([["mil-a1", "unchanged"]]);
    expect(p.issues).toEqual([
      expect.objectContaining({ row: 5, id: "mil-a2", level: "conflict", message: expect.stringContaining("export, edit and re-import") }),
    ]);
  });

  it("a differing rank counts as different content", () => {
    expect(admin([row(1, "A1", undefined, "captain")], [stored(1)]).issues).toHaveLength(1);
  });

  it("with a matching Version: update (with a field diff) when content differs, unchanged when it does not", () => {
    const p = admin([row(1, "New", 1), row(2, "A2", 1)], [stored(1), stored(2)]);
    expect(p.rows).toMatchObject([
      { id: "mil-a1", action: "update", expectedVersion: 1, diff: [{ field: "answer", from: "A1", to: "New" }] },
      { id: "mil-a2", action: "unchanged" },
    ]);
    expect(p.counts).toEqual({ created: 0, updated: 1, unchanged: 1, retired: 0 });
    expect(p.requiresConfirm).toBe(false); // admin exports keep the Version check instead
  });

  it("with a stale Version, or a Version for an id that does not exist: conflict", () => {
    const p = admin([row(1, "New", 1), row(9, "X", 1)], [stored(1, "A1", 2)]);
    expect(p.rows).toEqual([]);
    expect(p.issues.map((i) => [i.id, i.level])).toEqual([
      ["mil-a1", "conflict"],
      ["mil-a9", "conflict"],
    ]);
    expect(p.issues[0]?.message).toContain("out of date");
  });

  it("a repeated id in one file is an error on the later row", () => {
    const p = admin([row(1), { ...row(2), id: "mil-a1" }]);
    expect(p.rows).toHaveLength(1);
    expect(p.issues).toEqual([{ row: 5, id: "mil-a1", level: "error", message: "Duplicate id (first used on row 4)." }]);
  });

  it("never retires: stored items absent from the file are left alone", () => {
    const p = admin([row(1)], [stored(1), stored(2)]);
    expect(p.rows.map((r) => r.id)).toEqual(["mil-a1"]);
    expect(p.retirements).toEqual([]);
    expect(p.counts.retired).toBe(0);
  });

  it("a retired item given unchanged stays unchanged: Status is not an input", () => {
    const p = admin([row(1, "A1", 1)], [stored(1, "A1", 1, "trainee", "retired")]);
    expect(p.rows.map((r) => r.action)).toEqual(["unchanged"]);
  });
});

describe("planImport: admin export natural keys and id sequence", () => {
  it("a blank file name on a created or updated row is an error", () => {
    const blank = { ...row(1), naturalKey: "", data: { ...data("A1", 1), sourceFile: "" } };
    expect(admin([blank]).issues).toEqual([expect.objectContaining({ row: 4, id: "mil-a1", level: "error", message: expect.stringContaining("File name is empty") })]);
    const update = { ...row(1, "Edited", 1), naturalKey: " ", data: { ...data("Edited", 1), sourceFile: " " } };
    expect(admin([update], [stored(1)]).issues).toHaveLength(1);
  });

  it("a file name shared with a stored item (retired too) is an error, on a create and on an update", () => {
    const clash = { ...row(2), naturalKey: "f1.jpg", data: { ...data("A2", 2), sourceFile: "f1.jpg" } };
    const created = admin([clash], [stored(1, "A1", 1, "trainee", "retired")]);
    expect(created.issues).toEqual([expect.objectContaining({ row: 5, id: "mil-a2", level: "error", message: expect.stringContaining("already used by mil-a1") })]);
    const moved = { ...row(2, "A2", 1), naturalKey: "f1.jpg", data: { ...data("A2", 2), sourceFile: "f1.jpg" } };
    expect(admin([moved], [stored(1), stored(2)]).issues).toHaveLength(1);
  });

  it("two rows of one file taking the same file name are both errors; swapping two names in one file is fine", () => {
    const a = { ...row(1, "A1", 1), naturalKey: "f2.jpg", data: { ...data("A1", 1), sourceFile: "f2.jpg" } };
    const b = { ...row(2, "A2", 1), naturalKey: "f1.jpg", data: { ...data("A2", 2), sourceFile: "f1.jpg" } };
    expect(admin([a, b], [stored(1), stored(2)]).issues).toEqual([]);
    const c = { ...row(3), naturalKey: "f9.jpg", data: { ...data("A3", 3), sourceFile: "f9.jpg" } };
    const d = { ...row(4), naturalKey: "f9.jpg", data: { ...data("A4", 4), sourceFile: "f9.jpg" } };
    expect(admin([c, d]).issues.map((i) => i.row)).toEqual([6, 7]);
  });

  it("new ids may not jump past the highest stored id plus the rows in the file", () => {
    expect(admin([row(6)], [stored(1), stored(2), stored(3), stored(4), stored(5)]).issues).toEqual([]);
    const far = admin([row(500)], [stored(1)]);
    expect(far.issues).toEqual([expect.objectContaining({ id: "mil-a500", level: "error", message: expect.stringContaining("continue the existing sequence") })]);
    // Two rows into an empty module: ids up to mil-a2 only.
    expect(admin([row(3), row(4)]).issues.map((i) => i.id)).toEqual(["mil-a3", "mil-a4"]);
    expect(admin([row(2), row(1)]).issues).toEqual([]);
  });

  it("a client sheet with no id left (beyond mil-a999999) is a row error, not a crash", () => {
    const p = sheet([sheetRow(1)], [stored(999999)]);
    expect(p.rows).toEqual([]);
    expect(p.issues).toEqual([expect.objectContaining({ row: 4, level: "error", message: expect.stringContaining("Too many questions") })]);
  });
});

describe("planImport: client sheet (no Id column, authoritative)", () => {
  it("into an empty module: ids by row order, mil-a1 upward, creates only, no confirm needed", () => {
    const p = sheet([sheetRow(1), sheetRow(2), sheetRow(3)]);
    expect(p.rows.map((r) => [r.id, r.action])).toEqual([["mil-a1", "create"], ["mil-a2", "create"], ["mil-a3", "create"]]);
    expect(p.source).toBe("client_sheet");
    expect(p.requiresConfirm).toBe(false);
  });

  it("into an empty module a repeated file name is a row error on the later row (user, 2026-10-28)", () => {
    const p = sheet([sheetRow(1, "A", "trainee", "same.jpg"), sheetRow(2, "B", "trainee", "same.jpg")]);
    expect(p.issues).toEqual([expect.objectContaining({ row: 5, level: "error", message: expect.stringContaining('"same.jpg" is repeated (first used on row 4)') })]);
  });

  it("into an empty module a blank or whitespace-only file name is a row error", () => {
    const p = sheet([sheetRow(1), sheetRow(2, "B", "trainee", "")]);
    expect(p.issues).toEqual([expect.objectContaining({ row: 5, level: "error", message: expect.stringContaining("File name is empty") })]);
  });

  it("re-importing the same rows is all unchanged: nothing to confirm, nothing retired", () => {
    const p = sheet([sheetRow(1), sheetRow(2)], [stored(1), stored(2)]);
    expect(p.rows.map((r) => [r.id, r.action])).toEqual([["mil-a1", "unchanged"], ["mil-a2", "unchanged"]]);
    expect(p.counts).toEqual({ created: 0, updated: 0, unchanged: 2, retired: 0 });
    expect(p.requiresConfirm).toBe(false);
  });

  it("a row inserted mid-sheet keeps every existing id; the new row gets the next free id", () => {
    // Sheet order is now f1, NEW, f2, f3: positional ids would shift f2 and f3.
    const p = sheet([sheetRow(1), sheetRow(9, "New", "captain", "new.jpg"), sheetRow(2), sheetRow(3)], [stored(1), stored(2), stored(3)]);
    expect(p.rows.map((r) => [r.id, r.action])).toEqual([
      ["mil-a1", "unchanged"],
      ["mil-a4", "create"],
      ["mil-a2", "unchanged"],
      ["mil-a3", "unchanged"],
    ]);
  });

  it("new ids continue after the highest numeric suffix, including gaps and retired items, in sheet order", () => {
    const p = sheet(
      [sheetRow(1), sheetRow(7, "X", "trainee", "x.jpg"), sheetRow(8, "Y", "trainee", "y.jpg")],
      [stored(1), stored(12, "A12", 1, "trainee", "retired")],
    );
    expect(p.rows.map((r) => [r.id, r.action])).toEqual([["mil-a1", "unchanged"], ["mil-a13", "create"], ["mil-a14", "create"]]);
  });

  it("a changed answer or rank is an update with a field-level diff, and needs confirmation", () => {
    const p = sheet([sheetRow(1, "New answer", "captain"), sheetRow(2)], [stored(1), stored(2)]);
    expect(p.rows[0]).toMatchObject({
      id: "mil-a1",
      action: "update",
      expectedVersion: 1,
      diff: [
        { field: "answer", from: "A1", to: "New answer" },
        { field: "rank", from: "trainee", to: "captain" },
      ],
    });
    expect(p.counts).toEqual({ created: 0, updated: 1, unchanged: 1, retired: 0 });
    expect(p.requiresConfirm).toBe(true);
  });

  it("diffs array elements by index", () => {
    const changed = { ...sheetRow(1), data: { ...data("A1", 1), wrong: ["b", "X", "d"] } };
    expect(sheet([changed], [stored(1)]).rows[0]?.diff).toEqual([{ field: "wrong[1]", from: "c", to: "X" }]);
    expect(diffItem({ rank: "trainee", data: { a: 1 } }, { rank: "trainee", data: { a: 1 } })).toEqual([]);
  });

  it("stored approved items missing from the file are retired and listed; already-retired ones are not touched", () => {
    const p = sheet([sheetRow(1)], [stored(1), stored(2), stored(3), stored(4, "A4", 3, "trainee", "retired")]);
    expect(p.retirements).toEqual([
      { id: "mil-a2", naturalKey: "f2.jpg", expectedVersion: 1 },
      { id: "mil-a3", naturalKey: "f3.jpg", expectedVersion: 1 },
    ]);
    expect(p.counts.retired).toBe(2);
    expect(p.requiresConfirm).toBe(true);
  });

  it("a retired item that reappears is updated back to approved (a status diff), and needs confirmation", () => {
    const p = sheet([sheetRow(1)], [stored(1, "A1", 4, "trainee", "retired")]);
    expect(p.rows[0]).toMatchObject({ id: "mil-a1", action: "update", reactivate: true, expectedVersion: 4 });
    expect(p.rows[0]?.diff).toEqual([{ field: "status", from: "retired", to: "approved" }]);
    expect(p.requiresConfirm).toBe(true);
  });

  it("into a non-empty module a repeated file name is a row error on the later row", () => {
    const p = sheet([sheetRow(1), sheetRow(2, "Other", "trainee", "f1.jpg")], [stored(1)]);
    expect(p.issues).toEqual([expect.objectContaining({ row: 5, level: "error", message: expect.stringContaining('"f1.jpg" is repeated (first used on row 4)') })]);
  });

  it("into a non-empty module a missing file name is a row error (never guessed)", () => {
    const p = sheet([sheetRow(1), sheetRow(2, "B", "trainee", "")], [stored(1)]);
    expect(p.issues).toEqual([expect.objectContaining({ row: 5, level: "error", message: expect.stringContaining("File name is empty") })]);
  });

  it("two stored items sharing a file name make a row that matches them ambiguous: an error", () => {
    const twin: [string, ExistingItem] = ["mil-a2", { id: "mil-a2", rank: "trainee", status: "approved", version: 1, data: data("A2", 1) }];
    const p = sheet([sheetRow(1)], [stored(1), twin]);
    expect(p.issues).toEqual([expect.objectContaining({ row: 4, level: "error", message: expect.stringContaining("mil-a1, mil-a2") })]);
  });

  it("file names match exactly: a different case is a new question (and the old one is retired)", () => {
    const p = sheet([sheetRow(1, "A1", "trainee", "F1.jpg")], [stored(1)]);
    expect(p.rows.map((r) => r.action)).toEqual(["create"]);
    expect(p.retirements.map((r) => r.id)).toEqual(["mil-a1"]);
  });
});

describe("planHash", () => {
  const base = () => sheet([sheetRow(1, "New"), sheetRow(2)], [stored(1), stored(2), stored(3)]);

  it("is a sha256 hex, stable for the same plan, ignoring sheet row numbers", () => {
    expect(planHash(base())).toMatch(/^[0-9a-f]{64}$/);
    expect(planHash(base())).toBe(planHash(base()));
    const moved = sheet([{ ...sheetRow(1, "New"), row: 40 }, sheetRow(2)], [stored(1), stored(2), stored(3)]);
    expect(planHash(moved)).toBe(planHash(base()));
  });

  it("changes when the stored version, the incoming content, the retirements or the kind change", () => {
    const original = planHash(base());
    expect(planHash(sheet([sheetRow(1, "New"), sheetRow(2)], [stored(1, "A1", 2), stored(2), stored(3)]))).not.toBe(original);
    expect(planHash(sheet([sheetRow(1, "Newer"), sheetRow(2)], [stored(1), stored(2), stored(3)]))).not.toBe(original);
    expect(planHash(sheet([sheetRow(1, "New"), sheetRow(2)], [stored(1), stored(2)]))).not.toBe(original);
    expect(planHash(sheet([sheetRow(1, "New"), sheetRow(2)], [stored(1), stored(2), stored(3, "A3", 2)]))).not.toBe(original);
  });
});

describe("helpers", () => {
  it("canonicalJson ignores key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });

  it("compareIds sorts naturally: mil-a2 before mil-a10", () => {
    expect(["mil-a10", "mil-a2", "mil-a1"].sort(compareIds)).toEqual(["mil-a1", "mil-a2", "mil-a10"]);
  });
});

describe("planImport: keyIsId modules (Identifier: the id comes from the sheet)", () => {
  const idata = (answer: string, file: string) => ({ answer, wrong: ["b", "c", "d"], sourceFile: file });
  /** A client-sheet row: the parser puts the id it derived in naturalKey. */
  const irow = (key: string, answer = "A", rank: ParsedRow["rank"] = "trainee", file = "ai-a1.jpg"): ParsedRow => ({
    row: 4,
    id: undefined,
    naturalKey: key,
    version: undefined,
    rank,
    data: idata(answer, file),
  });
  const istored = (id: string, answer = "A", file = "ai-a1.jpg", version = 1, status: ExistingItem["status"] = "approved"): [string, ExistingItem] => [
    id,
    { id, rank: "trainee", status, version, data: idata(answer, file) },
  ];
  const iplan = (rows: ParsedRow[], existing: [string, ExistingItem][], kind: SheetKind) =>
    planImport(rows, new Map(existing), { kind, mapping: aircraftIdentifierMapping });

  it("a client sheet creates each row under the id it carries, with gaps and a -2 suffix, no sequence", () => {
    const p = iplan([irow("ai-a1"), irow("ai-a11", "B"), irow("ai-a11-2", "C"), irow("ai-a31", "D")], [], "client_sheet");
    expect(p.issues).toEqual([]);
    expect(p.rows.map((r) => [r.id, r.action])).toEqual([
      ["ai-a1", "create"],
      ["ai-a11", "create"],
      ["ai-a11-2", "create"],
      ["ai-a31", "create"],
    ]);
    expect(p.counts).toEqual({ created: 4, updated: 0, unchanged: 0, retired: 0 });
  });

  it("a key that is not an id of the module is a row error, never guessed", () => {
    const p = iplan([irow("mil-a1"), irow("ai-a0"), irow("ai-a5-1")], [], "client_sheet");
    expect(p.rows).toEqual([]);
    expect(p.issues.map((i) => [i.level, i.message])).toEqual([
      ["error", expect.stringContaining('"mil-a1" is not a valid id')],
      ["error", expect.stringContaining('"ai-a0" is not a valid id')],
      ["error", expect.stringContaining('"ai-a5-1" is not a valid id')],
    ]);
  });

  it("a repeated key is a row error on the later row; a blank one too", () => {
    const p = iplan([irow("ai-a1"), irow("ai-a1", "B"), irow("")], [], "client_sheet");
    expect(p.rows.map((r) => r.id)).toEqual(["ai-a1"]);
    expect(p.issues).toHaveLength(2);
    expect(p.issues.every((i) => i.level === "error")).toBe(true);
  });

  it("matches stored items by id, not by file: two stored items on one photo are not ambiguous", () => {
    const existing = [istored("ai-a11", "A", "ai-a11.jpg"), istored("ai-a11-2", "B", "ai-a11.jpg")];
    const p = iplan([irow("ai-a11", "A", "trainee", "ai-a11.jpg"), irow("ai-a11-2", "B", "trainee", "ai-a11.jpg")], existing, "client_sheet");
    expect(p.issues).toEqual([]);
    expect(p.rows.map((r) => [r.id, r.action, r.expectedVersion])).toEqual([
      ["ai-a11", "unchanged", 1],
      ["ai-a11-2", "unchanged", 1],
    ]);
    expect(p.requiresConfirm).toBe(false);
  });

  it("a changed answer is an update with a diff (and needs confirmation); a changed file name is an update too, not a new item", () => {
    const p = iplan([irow("ai-a1", "Changed", "trainee", "ai-a1.png")], [istored("ai-a1")], "client_sheet");
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ id: "ai-a1", action: "update", expectedVersion: 1 });
    expect(p.rows[0]?.diff?.map((d) => d.field)).toEqual(["answer", "sourceFile"]);
    expect(p.requiresConfirm).toBe(true);
  });

  it("approved items the sheet no longer lists are retired, reported by id, in id order; retired ones return as approved", () => {
    const p = iplan([irow("ai-a2")], [istored("ai-a1"), istored("ai-a2"), istored("ai-a10"), istored("ai-a10-2"), istored("ai-a3", "A", "x.jpg", 1, "retired")], "client_sheet");
    expect(p.retirements).toEqual([
      { id: "ai-a1", naturalKey: "ai-a1", expectedVersion: 1 },
      { id: "ai-a10", naturalKey: "ai-a10", expectedVersion: 1 },
      { id: "ai-a10-2", naturalKey: "ai-a10-2", expectedVersion: 1 },
    ]);
    const back = iplan([irow("ai-a3", "A", "trainee", "x.jpg")], [istored("ai-a3", "A", "x.jpg", 1, "retired")], "client_sheet");
    expect(back.rows[0]).toMatchObject({ id: "ai-a3", action: "update", reactivate: true });
  });

  it("an admin export may add any id of the right shape (no sequence ceiling) and the file name need not be unique", () => {
    const rows: ParsedRow[] = [
      { ...irow("ai-a900", "N", "trainee", "ai-a1.jpg"), id: "ai-a900" },
      { ...irow("ai-a1", "A", "trainee", "ai-a1.jpg"), id: "ai-a1" },
    ];
    const p = iplan(rows, [istored("ai-a1")], "admin_export");
    expect(p.issues).toEqual([]);
    expect(p.rows.map((r) => [r.id, r.action])).toEqual([
      ["ai-a900", "create"],
      ["ai-a1", "unchanged"],
    ]);
  });

  it("an admin export refuses an id of the wrong shape, and editing one item beside another on the same photo is not a conflict", () => {
    const bad = iplan([{ ...irow("x", "N"), id: "ai-a-9" }], [], "admin_export");
    expect(bad.issues).toEqual([expect.objectContaining({ level: "error", id: "ai-a-9", message: expect.stringContaining("not a valid id") })]);

    const existing = [istored("ai-a11", "A", "ai-a11.jpg"), istored("ai-a11-2", "B", "ai-a11.jpg")];
    const edit = iplan([{ ...irow("ai-a11", "Edited", "trainee", "ai-a11.jpg"), id: "ai-a11", version: 1 }], existing, "admin_export");
    expect(edit.issues).toEqual([]);
    expect(edit.rows[0]).toMatchObject({ id: "ai-a11", action: "update" });
  });
});
