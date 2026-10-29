import { describe, expect, it } from "vitest";
import { compareChecks, diffLists, EXPECTED_ENUM_CHECKS, extractLiterals, schemaEnumChecks } from "./schema-parity.js";

// src/db/schema.ts writes every enumerated CHECK as a SQL literal list. These tests fail, with a readable diff,
// when a list drifts from its TypeScript source of truth. Adding a module, rank, status or ledger kind needs the
// TS list, the schema.ts literal and a generated migration; the e2e twin checks the migrated database.

describe("schema.ts CHECK lists equal their TypeScript lists", () => {
  it("has no mismatch and no enumerated CHECK without a TypeScript list", () => {
    const problems = compareChecks(schemaEnumChecks());
    expect(problems, `\n${problems.join("\n\n")}\n`).toEqual([]);
  });

  it("finds every expected constraint", () => {
    expect(Object.keys(schemaEnumChecks()).sort()).toEqual(Object.keys(EXPECTED_ENUM_CHECKS).sort());
  });
});

describe("parity comparison helper", () => {
  const expected = { "t.c": ["a", "b", "c"] } as const;

  it("accepts equal lists in any order", () => {
    expect(compareChecks({ "t.c": ["c", "a", "b"] }, expected)).toEqual([]);
  });

  it("reports a value missing from the CHECK", () => {
    const [problem] = compareChecks({ "t.c": ["a", "b"] }, expected);
    expect(problem).toContain("t.c");
    expect(problem).toContain('missing from the CHECK: ["c"]');
  });

  it("reports a value only in the CHECK", () => {
    const [problem] = compareChecks({ "t.c": ["a", "b", "c", "d"] }, expected);
    expect(problem).toContain('in the CHECK but not in TypeScript: ["d"]');
  });

  it("reports a duplicate, a missing constraint and an unlisted constraint", () => {
    expect(diffLists(["a", "a", "b", "c"], expected["t.c"])).toContain("duplicated");
    expect(compareChecks({}, expected)[0]).toContain("no enumerated CHECK found");
    expect(compareChecks({ "t.c": ["a", "b", "c"], "t.x": ["z"] }, expected)[0]).toContain("no TypeScript list");
  });

  it("extracts literals from schema SQL and from pg_get_constraintdef output", () => {
    expect(extractLiterals(`"m" IN ('a', 'b-c', 'it''s')`)).toEqual(["a", "b-c", "it's"]);
    expect(extractLiterals(`CHECK (((x IS NULL) OR (x = ANY (ARRAY['a'::text, 'b'::text]))))`)).toEqual(["a", "b"]);
  });
});
