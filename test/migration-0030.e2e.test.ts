import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0030 (docs/plans/code-search.md section G): the `trip_decks` table, over a database that has a Trip at 0029, in a throwaway
// `_test` database that is dropped afterwards. Proves the existing Trip is untouched and gets no deck, each CHECK refuses exactly its own
// violation, the guard refuses UPDATE, a direct DELETE and TRUNCATE, and a Trip delete cascades.

const DB = "airplane_games_mig0030_test";
const T1 = "2026-01-05T10:00:00.000Z";
const T2 = "2026-01-05T10:30:00.000Z";
const TRIP = "00000000-0000-4000-8000-000000000001";
const TRIP_2 = "00000000-0000-4000-8000-000000000002";
const TRIP_3 = "00000000-0000-4000-8000-000000000003";
const RESTRICT_VIOLATION = "23001"; // restrict_violation, the ERRCODE the trigger raises
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
  // A copy of the migrations folder whose journal stops at 0029.
  dir = mkdtempSync(join(tmpdir(), "mig0030-"));
  cpSync("drizzle", dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0030");
  expect(journal.entries.at(-1).tag.startsWith("0029")).toBe(true);
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

const deck = (n = 10) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ itemId: `CS-TR-000${i}`, itemVersion: 1, board: { id: `CS-TR-000${i}` } })));
const insertDeck = (tripId: string, format: string, body: string) =>
  pool.query("INSERT INTO trip_decks (trip_id, format, deck, created_at) VALUES ($1, $2, $3::jsonb, $4)", [tripId, format, body, T1]);
const insertTrip = (id: string, key: string) =>
  pool.query(
    `INSERT INTO trips (id, player_id, idempotency_key, module, rank, pleasure_cruise, status, rounds_banked, local_date, utc_offset_minutes, content_version, opened_at, expires_at)
     VALUES ($1, 'p1', $2, 'code-search', 'trainee', false, 'open', 0, '2026-01-05', 0, 'v1', $3, $4)`,
    [id, key, T1, T2],
  );

describe("migration 0030", () => {
  it("adds trip_decks without touching an existing Trip, enforces each CHECK, refuses UPDATE, DELETE and TRUNCATE, cascades a Trip delete", async () => {
    await migrate(drizzle({ client: pool }), { migrationsFolder: dir });
    expect((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'trip_decks'")).rowCount).toBe(0);
    await pool.query("INSERT INTO players (id, created_at, updated_at) VALUES ('p1', $1, $1)", [T1]);
    await insertTrip(TRIP, "k1");
    const before = (await pool.query("SELECT to_jsonb(t) AS j FROM trips t")).rows.map((r) => r.j);

    await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" }); // to head

    expect((await pool.query("SELECT to_jsonb(t) AS j FROM trips t")).rows.map((r) => r.j)).toEqual(before);
    expect((await pool.query("SELECT count(*)::int AS n FROM trip_decks")).rows[0].n).toBe(0);
    const columns = (
      await pool.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'trip_decks' ORDER BY column_name`)
    ).rows;
    expect(columns).toEqual([
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "deck", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "format", data_type: "text", is_nullable: "NO" },
      { column_name: "trip_id", data_type: "uuid", is_nullable: "NO" },
    ]);
    const checks = (await pool.query(`SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'trip_decks'::regclass AND contype = 'c' ORDER BY conname`)).rows;
    expect(checks).toEqual([
      { conname: "trip_decks_deck_check", convalidated: true },
      { conname: "trip_decks_format_check", convalidated: true },
    ]);

    // Each CHECK refuses exactly its own violation.
    expect(await violated(insertDeck(TRIP, "grid.v2", deck()))).toBe("trip_decks_format_check");
    expect(await violated(insertDeck(TRIP, "", deck()))).toBe("trip_decks_format_check");
    expect(await violated(insertDeck(TRIP, "grid.v1", deck(9)))).toBe("trip_decks_deck_check");
    expect(await violated(insertDeck(TRIP, "grid.v1", deck(11)))).toBe("trip_decks_deck_check");
    expect(await violated(insertDeck(TRIP, "grid.v1", "[]"))).toBe("trip_decks_deck_check");
    expect(await violated(insertDeck(TRIP, "grid.v1", JSON.stringify({ a: 1 })))).toBe("trip_decks_deck_check");
    expect(await violated(insertDeck(TRIP, "grid.v1", "null"))).not.toBeNull(); // jsonb null is not an array (and a SQL NULL is refused as well)
    expect(await violated(pool.query("INSERT INTO trip_decks (trip_id, format, deck, created_at) VALUES ($1, 'grid.v1', NULL, $2)", [TRIP, T1]))).toBe("23502");
    expect(await violated(insertDeck(TRIP_2, "grid.v1", deck()))).toBe("trip_decks_trip_id_trips_id_fk"); // no such Trip
    expect((await pool.query("SELECT count(*)::int AS n FROM trip_decks")).rows[0].n).toBe(0);

    // A valid deck, then one per Trip only.
    expect(await violated(insertDeck(TRIP, "grid.v1", deck()))).toBeNull();
    expect(await violated(insertDeck(TRIP, "grid.v1", deck()))).toBe("trip_decks_pkey");

    // The trigger refuses every UPDATE, including a no-op and a change the CHECKs would accept.
    expect(await violated(pool.query("UPDATE trip_decks SET created_at = $2 WHERE trip_id = $1", [TRIP, T2]))).toBe(RESTRICT_VIOLATION);
    expect(await violated(pool.query("UPDATE trip_decks SET deck = $2::jsonb WHERE trip_id = $1", [TRIP, deck()]))).toBe(RESTRICT_VIOLATION);
    expect(await violated(pool.query("UPDATE trip_decks SET format = format"))).toBe(RESTRICT_VIOLATION);
    const triggers = (
      await pool.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgrelid = 'trip_decks'::regclass ORDER BY tgname`)
    ).rows.map((r) => r.tgname);
    expect(triggers).toEqual(["trip_decks_guard", "trip_decks_no_truncate"]);

    // A direct DELETE or TRUNCATE is refused too: a deck goes only with its Trip.
    expect(await violated(pool.query("DELETE FROM trip_decks WHERE trip_id = $1", [TRIP]))).toBe(RESTRICT_VIOLATION);
    expect(await violated(pool.query("TRUNCATE trip_decks"))).toBe(RESTRICT_VIOLATION);
    expect((await pool.query("SELECT count(*)::int AS n FROM trip_decks")).rows[0].n).toBe(1);

    // Deleting the Trip removes its deck (the cascade is allowed); so does deleting the player.
    await pool.query("DELETE FROM trips WHERE id = $1", [TRIP]);
    expect((await pool.query("SELECT count(*)::int AS n FROM trip_decks")).rows[0].n).toBe(0);
    await insertTrip(TRIP_3, "k3");
    await insertDeck(TRIP_3, "grid.v1", deck());
    await pool.query("DELETE FROM players WHERE id = 'p1'");
    expect((await pool.query("SELECT count(*)::int AS n FROM trips")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM trip_decks")).rows[0].n).toBe(0);
  });
});
