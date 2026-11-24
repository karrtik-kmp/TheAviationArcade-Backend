import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0027 (docs/plans/schema-hardening.md): over rows that exist at 0026, in a throwaway `_test` database that is dropped
// afterwards. Proves each backfill, the NOT NULL columns, the NOT VALID exemption of old rows next to enforcement for new rows, every
// append-only trigger refusal (UPDATE, DELETE, TRUNCATE) and the players-cascade pass-through.

const DB = "airplane_games_mig0027_test";
const SHA = "d".repeat(64);
const RESTRICT = "23001"; // restrict_violation, what every trigger raises
const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";
const T3 = "2026-01-03T00:00:00.000Z";
const T4 = "2026-01-04T00:00:00.000Z";
const T5 = "2026-01-05T00:00:00.000Z";
const T6 = "2026-01-06T00:00:00.000Z";
const TRIP_ID = "00000000-0000-4000-8000-000000000001";
const TRIP_LEGACY_ID = "00000000-0000-4000-8000-000000000002";
const TRIP_NEW_ID = "00000000-0000-4000-8000-000000000003";
let admin: pg.Client;
let dir: string;
let url: string;
let pool: pg.Pool;
let m1 = 0; // published before 0019: no rights statement
let m2 = 0; // a draft with a stated right and an audit row
let m3 = 0; // a draft with no audit row

beforeAll(async () => {
  const base = new URL(process.env.DATABASE_URL ?? "");
  const target = new URL(base.toString());
  target.pathname = `/${DB}`;
  url = target.toString();
  admin = new pg.Client({ connectionString: new URL("/postgres", base).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DB}"`);
  // A copy of the migrations folder whose journal stops at 0026.
  dir = mkdtempSync(join(tmpdir(), "mig0027-"));
  cpSync("drizzle", dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0027");
  expect(journal.entries.at(-1).tag.startsWith("0026")).toBe(true);
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

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);

async function seedPre0027(): Promise<void> {
  await pool.query(
    `INSERT INTO players (id, created_at, updated_at) VALUES ('p1', $1, $1), ('p2', $1, $1), ('p3', $1, $1), ('p4', $1, $1)`,
    [T1],
  );
  // Content: a receipt refreshed after its first import, items at version 1 and later.
  await pool.query(
    `INSERT INTO content_imports (id, module, file_name, sha256, byte_size, blob_key, created, updated, unchanged, imported_by, created_at)
     VALUES ('imp1', 'identifier', 'a.xlsx', $1, 10, 'k', 1, 2, 3, 'staff-a', $2)`,
    [SHA, T3],
  );
  await pool.query(
    `INSERT INTO content_items (module, id, rank, status, source, data, version, created_at, updated_at, updated_by, import_id)
     VALUES ('identifier', 'ci1', 'trainee', 'approved', 'admin', '{}', 1, $1, $1, 'staff-b', 'imp1'),
            ('identifier', 'ci2', 'trainee', 'approved', 'admin', '{}', 3, $1, $1, 'staff-c', 'imp1')`,
    [T1],
  );
  // Media: m1 published before 0019 (no rights statement) with a publish audit row; m2 a draft with a rights audit row; m3 no audit.
  await pool.query(
    `INSERT INTO media_items (owner, state, draft_version, published_version, created_by, updated_by, created_at, updated_at)
     VALUES ('o', 'published', 1, 1, 'photog-a', 'photog-a', $1, $1), ('o', 'unverified', 1, NULL, 'photog-a', 'photog-a', $1, $1),
            ('o', 'unverified', 1, NULL, 'photog-c', 'photog-c', $1, $1)`,
    [T1],
  );
  const mediaIds = (await pool.query<{ id: string }>("SELECT id FROM media_items ORDER BY id")).rows.map((r) => Number(r.id));
  m1 = mediaIds[0]!;
  m2 = mediaIds[1]!;
  m3 = mediaIds[2]!;
  // A pre-0019 published version cannot be inserted at 0026 (the publishable CHECK is enforced on INSERT), so the CHECK is dropped for the
  // seed and restored exactly as 0026 left it (NOT VALID).
  await pool.query(`ALTER TABLE media_versions DROP CONSTRAINT media_versions_publishable_check`);
  await pool.query(
    `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_name, credit_required, licence_name, published_at,
        created_by, created_at, rights_statement, rights_stated_by, rights_stated_at)
     VALUES ($1, 1, $4, 'image/png', 100, 64, 48, 'Credit', true, 'CC BY 4.0', $3, 'photog-a', $2, NULL, NULL, NULL),
            ($5, 1, $4, 'image/png', 100, 64, 48, NULL, true, NULL, NULL, 'photog-a', $2, 'v1_own', 'photog-a', $6),
            ($7, 1, $4, 'image/png', 100, 64, 48, NULL, true, NULL, NULL, 'photog-c', $2, NULL, NULL, NULL)`,
    [m1, T1, T4, SHA, m2, T2, m3],
  );
  await pool.query(
    `ALTER TABLE media_versions ADD CONSTRAINT media_versions_publishable_check CHECK ("published_at" IS NULL OR (("licence_name" IS NOT NULL OR "licence_waiver" IS NOT NULL) AND (NOT "credit_required" OR "credit_name" IS NOT NULL) AND "rights_statement" IS NOT NULL AND "rights_statement" IN ('v1_own', 'v1_authorised'))) NOT VALID`,
  );
  // Roles with and without an audit row.
  await pool.query(
    `INSERT INTO account_roles (principal, role, state, requested_at, decided_at, decided_by, revision)
     VALUES ('pA', 'photographer', 'active', $1, $2, 'admin-z', 2), ('pA', 'player', 'active', $1, $1, 'system:signup', 1),
            ('pB', 'player', 'active', $1, $1, 'system:signup', 1)`,
    [T1, T2],
  );
  // Store catalog: audited and unaudited products.
  await pool.query(
    `INSERT INTO store_products (product_id, kind, hints, title, demo, status)
     VALUES ('prod.a', 'hint_pack', 5, 'A', true, 'active'), ('prod.b', 'hint_pack', 5, 'B', true, 'active')`,
  );
  // Audit rows: media, roles and store, plus an extra one that must be ignored (another target).
  await pool.query(
    `INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES
       ('photog-b', 'media_rights', 'med-${m2}', '{"version":1}', $1),
       ('admin-z', 'media_publish', 'med-${m1}', '{"publishedVersion":1}', $2),
       ('admin-y', 'media_publish', 'med-${m1}', '{"publishedVersion":1}', $3),
       ('ignored', 'media_edit', 'med-${m3}', '{"version":9}', $2),
       ('admin-z', 'role_approve', 'pA', '{"role":"photographer"}', $3),
       ('staff-1', 'store_product_create', 'prod.a', '{}', $1),
       ('staff-2', 'store_product_edit', 'prod.a', '{}', $2)`,
    [T3, T4, T5],
  );
  // Trips and Rounds: a completed segment with a Round that identified Card mil:x, a legacy completed segment with no result columns,
  // an abandoned Round and a legacy completed Round with no completed_at.
  await pool.query(
    `INSERT INTO trips (id, player_id, idempotency_key, module, rank, pleasure_cruise, status, rounds_banked, local_date, utc_offset_minutes, content_version,
        opened_at, expires_at, closed_at, outcome, correct, hint_used, best_streak, miles, status_points, go_around, night_trip, completion_local_date, catalog_version)
     VALUES ($1, 'p1', 'k1', 'aircraft-identifier-military', 'trainee', false, 'completed', 10, '2026-01-06', 0, 'v1', $2, $3, $3, 'all_correct', 10, false, 10, 100, 100, false, false, '2026-01-06', 1)`,
    [TRIP_ID, T5, T6],
  );
  await pool.query(
    `INSERT INTO trips (id, player_id, idempotency_key, module, rank, pleasure_cruise, status, rounds_banked, local_date, utc_offset_minutes, content_version,
        opened_at, expires_at, closed_at, outcome)
     VALUES ($1, 'p1', 'k2', 'identifier', 'trainee', false, 'completed', 10, '2026-01-06', 0, 'v1', $2, $3, $3, 'not_all_correct')`,
    [TRIP_LEGACY_ID, T5, T6],
  );
  await pool.query(
    `INSERT INTO rounds (id, player_id, module, rank, pleasure_cruise, status, issued_at, expires_at, completion_id, sp_awarded, miles_awarded, finished, card_key,
        trip_id, flight_number, completed_at, local_date)
     VALUES ('r-done', 'p1', 'aircraft-identifier-military', 'trainee', false, 'completed', $1, $2, 'c1', 10, 10, true, 'mil:x', $3, 1, $2, '2026-01-06'),
            ('r-legacy', 'p1', 'identifier', 'trainee', false, 'completed', $1, $2, 'c2', 10, 10, true, NULL, NULL, NULL, NULL, NULL),
            ('r-aband', 'p1', 'identifier', 'trainee', false, 'abandoned', $1, $2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    [T5, T6, TRIP_ID],
  );
  await pool.query(
    `INSERT INTO player_clipper_cards (player_id, card_key, module, first_collected_at, first_trip_id, times_identified, ever_perfect, ever_hint_free)
     VALUES ('p1', 'mil:x', 'aircraft-identifier-military', $1, $2, 2, true, true), ('p1', 'mil:y', 'aircraft-identifier-military', $1, $2, 1, true, true)`,
    [T2, TRIP_ID],
  );
  await pool.query(`INSERT INTO ugs_mirror_outbox (player_id, version, due_at) VALUES ('p1', 1, $1)`, [T1]);
  // Ledgers and a purchase for players that will be deleted (p2) and kept (p1, p3, p4).
  for (const p of ["p1", "p2", "p3", "p4"]) {
    await pool.query(`INSERT INTO miles_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, 5, 'round_award', 'x', $2)`, [p, T1]);
    await pool.query(`INSERT INTO hint_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, 5, 'starter', 'x', $2)`, [p, T1]);
    await pool.query(
      `INSERT INTO store_transactions (store, transaction_ref, player_id, product_id, kind, environment, purchased_at, granted_hints)
       VALUES ('apple', $1, $3, 'prod.a', 'hint_pack', 'fake', $2, 5)`,
      [`tx-${p}`, T1, p],
    );
  }
  await pool.query(
    `INSERT INTO content_documents (name, version, format, body, sha256, byte_size, created_by) VALUES ('field-awards', 1, 'field-awards.v1', '{}', $1, 2, 'staff')`,
    [SHA],
  );
}

describe("migration 0027", () => {
  it("backfills pre-0027 rows exactly, then enforces NOT NULL, the NOT VALID CHECKs and the append-only triggers", async () => {
    await migrate(drizzle({ client: pool }), { migrationsFolder: dir });
    expect((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'rounds' AND column_name = 'abandoned_at'")).rowCount).toBe(0);
    await seedPre0027();
    const auditBefore = (await pool.query("SELECT count(*)::int AS n FROM admin_audit")).rows[0].n;

    await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" }); // to head

    // C1
    const imp = (await pool.query("SELECT * FROM content_imports WHERE id = 'imp1'")).rows[0];
    expect(iso(imp.last_applied_at)).toBe(T3);
    expect(imp.last_applied_by).toBe("staff-a");
    expect(iso(imp.created_at)).toBe(T3);
    // C2
    const items = (await pool.query("SELECT id, created_by, created_import_id FROM content_items ORDER BY id")).rows;
    expect(items).toEqual([
      { id: "ci1", created_by: "staff-b", created_import_id: "imp1" }, // version 1: its import_id is the creating import
      { id: "ci2", created_by: "system:pre-0027", created_import_id: null },
    ]);
    // C3
    const versions = (await pool.query("SELECT media_id, updated_at, updated_by FROM media_versions ORDER BY media_id")).rows.map((r) => ({
      id: Number(r.media_id),
      at: iso(r.updated_at),
      by: r.updated_by,
    }));
    expect(versions).toEqual([
      { id: m1, at: T4, by: "admin-z" }, // the FIRST media_publish (a later re-publish by admin-y never changed the row)
      { id: m2, at: T3, by: "photog-b" }, // the media_rights audit row: its time and its actor, one event
      { id: m3, at: T1, by: "photog-c" }, // no audit row for version 1 (the version-9 row is another version): created_by
    ]);
    // C4
    const roles = (await pool.query("SELECT principal, role, updated_at FROM account_roles ORDER BY principal, role")).rows;
    expect(roles.map((r) => [r.principal, r.role, iso(r.updated_at)])).toEqual([
      ["pA", "photographer", T5], // the role_approve audit row (detail.role = photographer) is the latest
      ["pA", "player", T1], // the same principal's photographer audit row does not touch the player row
      ["pB", "player", T1],
    ]);
    // C5: the completed, finished Round of a completed segment sets mil:x; mil:y has none, so its first collection stays.
    const cards = (await pool.query("SELECT card_key, last_identified_at FROM player_clipper_cards ORDER BY card_key")).rows;
    expect(cards.map((r) => [r.card_key, iso(r.last_identified_at)])).toEqual([
      ["mil:x", T6],
      ["mil:y", T2],
    ]);
    // C6: the migration instant (after the seed).
    const outbox = (await pool.query("SELECT first_enqueued_at > $1::timestamptz AS later FROM ugs_mirror_outbox", [T6])).rows;
    expect(outbox).toEqual([{ later: true }]);
    // C7
    const products = (await pool.query("SELECT product_id, created_by, updated_by FROM store_products ORDER BY product_id")).rows;
    expect(products).toEqual([
      { product_id: "prod.a", created_by: "staff-1", updated_by: "staff-2" },
      { product_id: "prod.b", created_by: "system:pre-0027", updated_by: "system:pre-0027" },
    ]);
    // C8 backfill is NULL.
    expect((await pool.query("SELECT abandoned_at FROM rounds WHERE id = 'r-aband'")).rows[0].abandoned_at).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM admin_audit")).rows[0].n).toBe(auditBefore);

    // NOT NULL.
    const notNull: Array<[string, string]> = [
      ["content_imports", "last_applied_at"],
      ["content_imports", "last_applied_by"],
      ["content_items", "created_by"],
      ["media_versions", "updated_at"],
      ["media_versions", "updated_by"],
      ["account_roles", "updated_at"],
      ["player_clipper_cards", "last_identified_at"],
      ["ugs_mirror_outbox", "first_enqueued_at"],
      ["store_products", "created_by"],
      ["store_products", "updated_by"],
    ];
    for (const [table, column] of notNull) {
      const r = await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = $2", [table, column]);
      expect(r.rows, `${table}.${column}`).toEqual([{ is_nullable: "NO" }]);
    }
    // Nullable by design.
    for (const [table, column] of [["content_items", "created_import_id"], ["rounds", "abandoned_at"]]) {
      const r = await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = $2", [table, column]);
      expect(r.rows, `${table}.${column}`).toEqual([{ is_nullable: "YES" }]);
    }

    // The CHECKs are NOT VALID (publishable included) except the new table's own.
    const checks = (
      await pool.query(
        `SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('media_versions_publishable_check', 'rounds_abandoned_at_check', 'rounds_completed_at_check',
           'trips_completed_result_check', 'ugs_link_events_kind_check') ORDER BY conname`,
      )
    ).rows;
    expect(checks).toEqual([
      { conname: "media_versions_publishable_check", convalidated: false },
      { conname: "rounds_abandoned_at_check", convalidated: false },
      { conname: "rounds_completed_at_check", convalidated: false },
      { conname: "trips_completed_result_check", convalidated: false },
      { conname: "ugs_link_events_kind_check", convalidated: true },
    ]);
    // The publishable CHECK still has its 0026 definition (a licence or a waiver).
    const def = (await pool.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'media_versions_publishable_check'")).rows[0].d as string;
    expect(def).toContain("licence_waiver IS NOT NULL");
    expect(def).toContain("NOT VALID");

    // Old rows (exempt) survived; new rows are held to the CHECKs.
    expect((await pool.query("SELECT count(*)::int AS n FROM rounds WHERE id IN ('r-legacy', 'r-aband')")).rows[0].n).toBe(2);
    expect((await pool.query("SELECT count(*)::int AS n FROM trips WHERE id = $1", [TRIP_LEGACY_ID])).rows[0].n).toBe(1);
    const round = (id: string, o: { status: string; abandonedAt?: string | null; completedAt?: string | null; localDate?: string | null }) =>
      pool.query(
        `INSERT INTO rounds (id, player_id, module, rank, pleasure_cruise, status, issued_at, expires_at, completion_id, sp_awarded, miles_awarded, abandoned_at, completed_at, local_date)
         VALUES ($1, 'p3', 'identifier', 'trainee', false, $2, $3, $4, $5, $6, $6, $7, $8, $9)`,
        [id, o.status, T5, T6, o.status === "completed" ? `c-${id}` : null, o.status === "completed" ? 1 : null, o.abandonedAt ?? null, o.completedAt ?? null, o.localDate ?? null],
      );
    expect(await violated(round("n1", { status: "abandoned" }))).toBe("rounds_abandoned_at_check");
    expect(await violated(round("n2", { status: "open", abandonedAt: T6 }))).toBe("rounds_abandoned_at_check");
    expect(await violated(round("n3", { status: "completed", completedAt: null, localDate: "2026-01-06" }))).toBe("rounds_completed_at_check");
    expect(await violated(round("n4", { status: "completed", completedAt: T6, localDate: null }))).toBe("rounds_completed_at_check");
    expect(await violated(round("n5", { status: "abandoned", abandonedAt: T6 }))).toBeNull();
    expect(await violated(round("n6", { status: "completed", completedAt: T6, localDate: "2026-01-06" }))).toBeNull();
    const trip = (key: string, id: string, o: { catalogVersion: number | null }) =>
      pool.query(
        `INSERT INTO trips (id, player_id, idempotency_key, module, rank, pleasure_cruise, status, rounds_banked, local_date, utc_offset_minutes, content_version,
            opened_at, expires_at, closed_at, outcome, correct, hint_used, best_streak, miles, status_points, go_around, night_trip, completion_local_date, catalog_version)
         VALUES ($1, 'p3', $2, 'identifier', 'trainee', false, 'completed', 10, '2026-01-06', 0, 'v1', $3, $4, $4, 'all_correct', 10, false, 10, 1, 1, false, false, '2026-01-06', $5)`,
        [id, key, T5, T6, o.catalogVersion],
      );
    expect(await violated(trip("k3", TRIP_NEW_ID, { catalogVersion: null }))).toBe("trips_completed_result_check");
    expect(await violated(trip("k3", TRIP_NEW_ID, { catalogVersion: 1 }))).toBeNull();
    // A new media version is held to the (re-added) publishable CHECK.
    expect(
      await violated(
        pool.query(
          `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_required, published_at, created_by, created_at, updated_at, updated_by)
           VALUES ($1, 2, $2, 'image/png', 100, 64, 48, false, now(), 'x', now(), now(), 'x')`,
          [m3, SHA],
        ),
      ),
    ).toBe("media_versions_publishable_check");
    // The new ugs_link_events kind CHECK and its NOT NULLs.
    expect(await violated(pool.query(`INSERT INTO ugs_link_events (player_id, kind, ugs_player_id) VALUES ('p3', 'bogus', 'u')`))).toBe("ugs_link_events_kind_check");
    expect(await violated(pool.query(`INSERT INTO ugs_link_events (player_id, kind, ugs_player_id) VALUES ('p3', 'linked', 'u3')`))).toBeNull();
    expect(await violated(pool.query(`INSERT INTO ugs_link_events (player_id, kind, ugs_player_id) VALUES ('p2', 'linked', 'u2')`))).toBeNull();
    expect(
      await violated(pool.query(`INSERT INTO ugs_link_events (player_id, kind, ugs_player_id, previous_ugs_player_id) VALUES ('p3', 'replaced', 'u4', 'u3')`)),
    ).toBeNull();

    // Indexes.
    const idx = (await pool.query("SELECT indexname FROM pg_indexes WHERE indexname IN ('store_transactions_product', 'store_subscriptions_product', 'ugs_link_events_player') ORDER BY 1")).rows;
    expect(idx.map((r) => r.indexname)).toEqual(["store_subscriptions_product", "store_transactions_product", "ugs_link_events_player"]);

    // Triggers: UPDATE, DELETE and TRUNCATE refused per table.
    const sets: Record<string, string> = {
      miles_ledger: "delta = 6",
      hint_ledger: "delta = 6",
      store_transactions: "granted_hints = 6",
      ugs_link_events: "ugs_player_id = 'z'",
      admin_audit: "actor = 'z'",
      content_documents: "created_by = 'z'",
    };
    for (const [table, set] of Object.entries(sets)) {
      expect(await violated(pool.query(`UPDATE ${table} SET ${set}`)), `UPDATE ${table}`).toBe(RESTRICT);
      expect(await violated(pool.query(`DELETE FROM ${table}`)), `DELETE ${table}`).toBe(RESTRICT);
      expect(await violated(pool.query(`TRUNCATE ${table}`)), `TRUNCATE ${table}`).toBe(RESTRICT);
    }
    // Rows are all still there.
    expect((await pool.query("SELECT count(*)::int AS n FROM miles_ledger")).rows[0].n).toBe(4);
    expect((await pool.query("SELECT count(*)::int AS n FROM content_documents")).rows[0].n).toBe(1);

    // Media: a published version is frozen, a draft is not.
    expect(await violated(pool.query(`UPDATE media_versions SET description = 'x' WHERE media_id = $1 AND version = 1`, [m1]))).toBe(RESTRICT);
    expect(await violated(pool.query(`DELETE FROM media_versions WHERE media_id = $1 AND version = 1`, [m1]))).toBe(RESTRICT);
    // A plain TRUNCATE is already refused by Postgres (content_release_items references the table); CASCADE reaches the triggers.
    expect(await violated(pool.query(`TRUNCATE media_versions`))).not.toBeNull();
    expect(await violated(pool.query(`TRUNCATE media_versions CASCADE`))).toBe(RESTRICT);
    expect(await violated(pool.query(`UPDATE media_versions SET description = 'edited', updated_at = now(), updated_by = 'u' WHERE media_id = $1 AND version = 1`, [m2]))).toBeNull();
    expect((await pool.query(`SELECT description FROM media_versions WHERE media_id = $1`, [m2])).rows[0].description).toBe("edited");
    // A draft may still be deleted (the trigger only protects published versions), so a failed upload can be cleaned up.
    expect(await violated(pool.query(`DELETE FROM media_versions WHERE media_id = $1 AND version = 1`, [m3]))).toBeNull();

    // Player deletion: the direct DELETE of a ledger row is refused, so is the one hidden in the same statement as a players CTE.
    expect(await violated(pool.query(`DELETE FROM miles_ledger WHERE player_id = 'p4'`))).toBe(RESTRICT);
    expect(
      await violated(pool.query(`WITH d AS (DELETE FROM players WHERE id = 'p4' RETURNING id) DELETE FROM miles_ledger WHERE player_id = 'p4'`)),
    ).toBe(RESTRICT);
    expect(await violated(pool.query(`WITH d AS (DELETE FROM players WHERE id = 'p4' RETURNING id) DELETE FROM store_transactions WHERE player_id = 'p4'`))).toBe(RESTRICT);
    expect((await pool.query("SELECT count(*)::int AS n FROM players WHERE id = 'p4'")).rows[0].n).toBe(1);
    // The cascade of an account deletion passes through every append-only table.
    for (const table of ["miles_ledger", "hint_ledger", "store_transactions", "ugs_link_events"]) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE player_id = 'p2'`)).rows[0].n, `${table} before`).toBeGreaterThan(0);
    }
    expect(await violated(pool.query(`DELETE FROM players WHERE id = 'p2'`))).toBeNull();
    for (const table of ["miles_ledger", "hint_ledger", "store_transactions", "ugs_link_events"]) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE player_id = 'p2'`)).rows[0].n, `${table} after`).toBe(0);
    }
    // Other players' rows untouched.
    expect((await pool.query("SELECT count(*)::int AS n FROM miles_ledger")).rows[0].n).toBe(3);
    // TRUNCATE ... CASCADE from players reaches the append-only tables and is refused.
    expect(await violated(pool.query(`TRUNCATE players CASCADE`))).toBe(RESTRICT);
    expect((await pool.query("SELECT count(*)::int AS n FROM players")).rows[0].n).toBe(3);

    // Triggers present, and the migration left every trigger enabled.
    const triggers = (
      await pool.query(
        `SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'
           AND tgrelid::regclass::text IN ('miles_ledger', 'hint_ledger', 'store_transactions', 'ugs_link_events', 'admin_audit', 'media_versions', 'content_documents')`,
      )
    ).rows[0].n;
    expect(triggers).toBe(14); // 7 row triggers (6 tables + content_documents' own) + 7 TRUNCATE triggers
  });
});
