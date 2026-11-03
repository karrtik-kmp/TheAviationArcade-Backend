import { describe, expect, it } from "vitest";
import { diffItem, planImport } from "../src/content/import-plan.js";
import type { ExistingItem } from "../src/content/import-plan.js";
import { militaryMapping } from "../src/content/modules/military.js";
import { readFirstSheet } from "../src/content/xlsx.js";
import { CLIENT_HEADER, xlsx } from "./fixtures.js";

// A1: the one Military payload validator (shared by the sheet parser and PATCH .../items/:id) and the edit diff.

const good = { answer: "Boeing B-52", wrong: ["Boeing B-1", "Boeing B-2", "Boeing B-17"], sourceFile: "a.jpg", photographer: "P" };

describe("militaryMapping.validatePayload", () => {
  it("accepts a full payload and trims every text value", () => {
    const result = militaryMapping.validatePayload({ answer: "  X  ", wrong: [" a", "b ", " c "], sourceFile: " f.jpg ", photographer: " Q " });
    expect(result.problems).toEqual([]);
    expect(result.data).toEqual({ answer: "X", wrong: ["a", "b", "c"], sourceFile: "f.jpg", photographer: "Q" });
  });

  it("lists a blank answer and each blank wrong answer", () => {
    const { problems } = militaryMapping.validatePayload({ ...good, answer: "  ", wrong: ["", "b", " "] });
    expect(problems).toEqual(["Correct Answer is missing.", "Wrong Answer 1 is missing.", "Wrong Answer 3 is missing."]);
  });

  it("requires all four options distinct after normalising case and spacing", () => {
    const { problems } = militaryMapping.validatePayload({ ...good, wrong: ["boeing   b-52", "x", "y"] });
    expect(problems).toEqual(["The correct and wrong answers must all be different."]);
  });

  it("rejects the wrong shape: not an object, unknown keys, non-text values, not exactly three wrong answers", () => {
    for (const bad of [null, "x", [], 5]) expect(militaryMapping.validatePayload(bad).problems).toHaveLength(1);
    expect(militaryMapping.validatePayload({ ...good, extra: 1 }).problems[0]).toContain("Unknown field(s): extra");
    expect(militaryMapping.validatePayload({ ...good, answer: 5 }).problems).toContain("Correct Answer must be text.");
    expect(militaryMapping.validatePayload({ ...good, wrong: ["a", "b"] }).problems).toContain("wrong must be exactly three answers.");
    expect(militaryMapping.validatePayload({ ...good, wrong: "abc" }).problems).toContain("wrong must be exactly three answers.");
    const { sourceFile: _s, ...noFile } = good;
    expect(militaryMapping.validatePayload(noFile).problems).toEqual(["file must be text."]);
  });

  it("tolerates a blank file and photographer (the planner enforces a unique file name)", () => {
    expect(militaryMapping.validatePayload({ ...good, sourceFile: "", photographer: "" }).problems).toEqual([]);
  });

  it("is the same function the sheet parser uses: a sheet row and a payload with the same fault give the same message", async () => {
    const rows = await militaryMapping.parse(
      await readFirstSheet(await xlsx([CLIENT_HEADER, ["Trainee", "A", "a", "B", "C", "f.jpg", "P"]])),
    );
    expect(rows.rows).toHaveLength(0);
    expect(rows.issues[0]?.message).toBe("The correct and wrong answers must all be different.");
    expect(militaryMapping.validatePayload({ answer: "A", wrong: ["a", "B", "C"], sourceFile: "f.jpg", photographer: "P" }).problems).toEqual([
      "The correct and wrong answers must all be different.",
    ]);
  });
});

describe("edit diff and natural key through the planner", () => {
  const stored: ExistingItem = { id: "mil-a1", rank: "trainee", status: "approved", version: 3, data: good };
  const other: ExistingItem = { id: "mil-a2", rank: "captain", status: "retired", version: 1, data: { ...good, sourceFile: "b.jpg" } };
  const plan = (data: Record<string, unknown>) =>
    planImport([{ row: 1, id: "mil-a1", naturalKey: militaryMapping.naturalKey(data), version: 3, rank: "trainee", data }], new Map([[stored.id, stored], [other.id, other]]), {
      kind: "admin_export",
      mapping: militaryMapping,
    });

  it("diffItem names each changed field with from and to", () => {
    expect(diffItem(stored, { rank: "captain", data: { ...good, answer: "Y", wrong: ["Boeing B-1", "Z", "Boeing B-17"] } })).toEqual([
      { field: "answer", from: "Boeing B-52", to: "Y" },
      { field: "rank", from: "trainee", to: "captain" },
      { field: "wrong[1]", from: "Boeing B-2", to: "Z" },
    ]);
    expect(diffItem(stored, { rank: "trainee", data: { ...good } })).toEqual([]);
  });

  it("a blank or retired-duplicate file name is an error issue", () => {
    expect(plan({ ...good, sourceFile: "" }).issues.some((i) => i.level === "error" && i.message.includes("empty"))).toBe(true);
    expect(plan({ ...good, sourceFile: "b.jpg" }).issues.some((i) => i.level === "error" && i.message.includes("mil-a2"))).toBe(true);
    expect(plan({ ...good, answer: "New", sourceFile: "a.jpg" }).issues).toEqual([]);
  });
});
