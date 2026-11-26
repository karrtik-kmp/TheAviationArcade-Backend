import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0033 (docs/plans/guest-callsign.md G2, C1): over a database seeded at 0032, in a throwaway `_test` database that is dropped
// afterwards. Four nullable columns: every existing player row keeps its values and reads NULL in each; the unique index is
// case-sensitive on purpose (the CHECK admits upper case only, so it is case-insensitive in effect); the CHECKs hold.

const DB = "airplane_games_mig0033_test";
const T1 = "2026-01-01T00:00:00.000Z";
let admin: pg.Client;
let dir: string;
let url: string;
let pool: pg.Pool;

beforeAll(async () => {
  const base = new URL(process.env.DATABASE_URL ?? "");
  const target = new URL(base.toString());
  target.pathname = `/${DB}`;
  url = target.toString();
  admin = new pg.Client({ connectionString: new URL("/postgres", base).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DB}"`);
  // A copy of the migrations folder whose journal stops at 0032.
  dir = mkdtempSync(join(tmpdir(), "mig0033-"));
  cpSync("drizzle", dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0033");
  expect(journal.entries.at(-1).tag.startsWith("0032")).toBe(true);
  writeFileSync(journalPath, JSON.stringify(journal));
  pool = new pg.Pool({ connectionString: url });
});

afterAll(async () => {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.end();
  rmSync(dir, { recursive: true, force: true });
});

async function violated(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    return err.constraint ?? err.code ?? "unknown";
  }
}

const setCallsign = (id: string, callsign: string | null, claimedAt: string | null = callsign === null ? null : T1, changedAt: string | null = null) =>
  pool.query("UPDATE players SET callsign = $2, callsign_claimed_at = $3, callsign_changed_at = $4 WHERE id = $1", [id, callsign, claimedAt, changedAt]);

describe("migration 0033", () => {
  it("adds four NULL columns without touching existing rows, a unique Callsign index and the Callsign CHECKs", async () => {
    await migrate(drizzle({ client: pool }), { migrationsFolder: dir });
    for (const id of ["firebase:p:a", "firebase:p:b"]) {
      await pool.query(
        "INSERT INTO players (id, status_points, miles, hints, version, created_at, updated_at) VALUES ($1, 120, 30, 5, 3, $2, $2)",
        [id, T1],
      );
    }
    const before = (await pool.query("SELECT to_jsonb(p) AS j FROM players p ORDER BY id")).rows.map((r) => r.j);

    await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" }); // to head

    const after = (await pool.query("SELECT to_jsonb(p) AS j FROM players p ORDER BY id")).rows.map((r) => r.j);
    expect(after).toEqual(
      before.map((row) => ({ ...row, anonymous_since: null, callsign: null, callsign_claimed_at: null, callsign_changed_at: null })),
    );

    const index = (await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'players_callsign_unique'")).rows[0];
    expect(index?.indexdef).toContain("CREATE UNIQUE INDEX players_callsign_unique ON public.players USING btree (callsign)");
    const checks = (
      await pool.query(
        "SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE 'players_callsign%' ORDER BY conname",
      )
    ).rows.map((c) => [c.conname, c.convalidated]);
    expect(checks).toEqual([
      ["players_callsign_changed_at_check", true],
      ["players_callsign_check", true],
      ["players_callsign_claimed_at_check", true],
    ]);

    expect(await violated(setCallsign("firebase:p:a", "SKYWARD42"))).toBeNull();
    expect(await violated(setCallsign("firebase:p:b", "SKYWARD42"))).toBe("players_callsign_unique");
    for (const bad of ["skyward42", "SK", "A".repeat(17), "SKY WARD", "SKY-1", "ÄBC"]) {
      expect(await violated(setCallsign("firebase:p:b", bad)), bad).toBe("players_callsign_check");
    }
    expect(await violated(setCallsign("firebase:p:b", "VALID1", null))).toBe("players_callsign_claimed_at_check");
    expect(await violated(setCallsign("firebase:p:b", null, T1))).toBe("players_callsign_claimed_at_check");
    expect(await violated(setCallsign("firebase:p:b", null, null, T1))).toBe("players_callsign_changed_at_check");
    expect(await violated(setCallsign("firebase:p:b", "VALID1", T1, T1))).toBeNull();
    // Deleting the player frees the value.
    await pool.query("DELETE FROM players WHERE id = 'firebase:p:a'");
    expect(await violated(setCallsign("firebase:p:b", "SKYWARD42"))).toBeNull();
  });
});
