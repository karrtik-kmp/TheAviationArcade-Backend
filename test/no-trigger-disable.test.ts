import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Migration 0027 (docs/plans/schema-hardening.md): the append-only triggers guard the data against bugs in the app. No code under
// src/ may switch them off. Tests and manual cleanup do that themselves (test/frozen-cleanup.ts), never the application.

const SRC = join(import.meta.dirname, "..", "src");
const FORBIDDEN = /DISABLE\s+TRIGGER|session_replication_role/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("no code under src/ disables a trigger", () => {
  it("scans every file under src/ for DISABLE TRIGGER and session_replication_role", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(50); // not vacuous
    const found = files.filter((file) => FORBIDDEN.test(readFileSync(file, "utf8"))).map((file) => relative(SRC, file));
    expect(found).toEqual([]);
  });

  it("the pattern matches the spellings it must forbid", () => {
    for (const text of ["ALTER TABLE t DISABLE TRIGGER x", "alter table t disable   trigger all", "SET session_replication_role = replica", "SET SESSION_REPLICATION_ROLE TO replica"]) {
      expect(FORBIDDEN.test(text), text).toBe(true);
    }
    expect(FORBIDDEN.test("ENABLE TRIGGER")).toBe(false);
  });
});
