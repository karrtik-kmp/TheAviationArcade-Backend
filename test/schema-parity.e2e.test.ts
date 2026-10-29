import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { compareChecks, extractLiterals } from "./schema-parity.js";

// The LIVE test database after migrations: every enumerated CHECK as Postgres stores it (pg_get_constraintdef)
// must equal the TypeScript list, so a migration that drifted from schema.ts is caught too.

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

describe("migrated database CHECK lists equal the TypeScript lists", () => {
  it("matches for every enumerated CHECK", async () => {
    const { rows } = await pool.query<{ tbl: string; name: string; def: string }>(
      `SELECT c.relname AS tbl, k.conname AS name, pg_get_constraintdef(k.oid) AS def
         FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE k.contype = 'c' AND n.nspname = current_schema()
        ORDER BY 1, 2`,
    );
    const live: Record<string, string[]> = {};
    for (const r of rows) {
      // Postgres stores IN lists as = ANY (ARRAY[...]), or as = 'x'::text for a single value; other CHECKs (>= 0, the sha256 regex, the 'completed' guard) are not enumerations.
      if (!/= ANY \(\(?ARRAY\[|= '[^']*'::text/i.test(r.def)) continue;
      live[`${r.tbl}.${r.name}`] = extractLiterals(r.def);
    }
    const problems = compareChecks(live, undefined, "the migrated database");
    expect(problems, `\n${problems.join("\n\n")}\n`).toEqual([]);
  });
});
