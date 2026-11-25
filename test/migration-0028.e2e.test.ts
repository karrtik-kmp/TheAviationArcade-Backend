import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0028 (docs/plans/photo-submission-v2.md): over rows that exist at 0027, in a throwaway `_test` database that is dropped
// afterwards. Proves the existing media rows are untouched (including updated_at), the new columns start empty, the publishable CHECK
// stays NOT VALID with the v2 code in its list while the other new checks are validated, and the new table and checks enforce.

const DB = "airplane_games_mig0028_test";
const SHA = "c".repeat(64);
const V2 = "v2_agreement_2026-12-01";
const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";
const T3 = "2026-01-03T00:00:00.000Z";
let admin: pg.Client;
let dir: string;
let url: string;
let pool: pg.Pool;
let preStatement = 0; // published before 0019: no rights statement
let publishedV1 = 0; // published with a v1 statement
let draftV1 = 0; // an unpublished draft with a v1 statement and a key

beforeAll(async () => {
  const base = new URL(process.env.DATABASE_URL ?? "");
  const target = new URL(base.toString());
  target.pathname = `/${DB}`;
  url = target.toString();
  admin = new pg.Client({ connectionString: new URL("/postgres", base).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DB}"`);
  // A copy of the migrations folder whose journal stops at 0027.
  dir = mkdtempSync(join(tmpdir(), "mig0028-"));
  cpSync("drizzle", dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0028");
  expect(journal.entries.at(-1).tag.startsWith("0027")).toBe(true);
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

async function seedPre0028(): Promise<void> {
  await pool.query(
    `INSERT INTO media_items (owner, state, draft_version, published_version, created_by, updated_by, created_at, updated_at)
     VALUES ('o', 'published', 1, 1, 'photog-a', 'photog-a', $1, $1), ('o', 'published', 1, 1, 'photog-b', 'photog-b', $1, $1),
            ('o', 'unverified', 1, NULL, 'photog-c', 'photog-c', $1, $1)`,
    [T1],
  );
  const ids = (await pool.query<{ id: string }>("SELECT id FROM media_items ORDER BY id")).rows.map((r) => Number(r.id));
  preStatement = ids[0]!;
  publishedV1 = ids[1]!;
  draftV1 = ids[2]!;
  // A pre-0019 published version cannot be inserted at 0027 (the publishable CHECK is enforced on INSERT), so the CHECK is dropped for the
  // seed and restored exactly as 0027 left it (NOT VALID).
  await pool.query(`ALTER TABLE media_versions DROP CONSTRAINT media_versions_publishable_check`);
  await pool.query(
    `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_name, credit_required, licence_name, published_at,
        created_by, created_at, updated_at, updated_by, rights_statement, rights_stated_by, rights_stated_at, description)
     VALUES ($1, 1, $4, 'image/png', 100, 64, 48, 'Credit', true, 'CC BY 4.0', $3, 'photog-a', $2, $3, 'admin-z', NULL, NULL, NULL, NULL),
            ($5, 1, $4, 'image/png', 100, 64, 48, 'Credit B', true, 'CC BY 4.0', $3, 'photog-b', $2, $3, 'admin-z', 'v1_own', 'photog-b', $2, 'A described photo'),
            ($6, 1, $4, 'image/png', 100, 64, 48, NULL, true, NULL, NULL, 'photog-c', $2, $7, 'photog-c', 'v1_authorised', 'photog-c', $2, NULL)`,
    [preStatement, T1, T2, SHA, publishedV1, draftV1, T3],
  );
  await pool.query(
    `ALTER TABLE media_versions ADD CONSTRAINT media_versions_publishable_check CHECK ("published_at" IS NULL OR (("licence_name" IS NOT NULL OR "licence_waiver" IS NOT NULL) AND (NOT "credit_required" OR "credit_name" IS NOT NULL) AND "rights_statement" IS NOT NULL AND "rights_statement" IN ('v1_own', 'v1_authorised'))) NOT VALID`,
  );
  await pool.query(
    `INSERT INTO media_upload_keys (principal, idempotency_key, operation, media_id, version, sha256, created_at) VALUES ('photog-c', 'k-1', 'create', $1, 1, $2, $3)`,
    [draftV1, SHA, T1],
  );
}

const snapshot = async () =>
  (await pool.query("SELECT to_jsonb(v) AS j FROM media_versions v ORDER BY media_id, version")).rows.map((r) => r.j as Record<string, unknown>);

describe("migration 0028", () => {
  it("keeps every existing row byte-identical, adds empty columns, keeps the publishable CHECK NOT VALID with v2 and enforces the rest", async () => {
    await migrate(drizzle({ client: pool }), { migrationsFolder: dir });
    expect((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'media_versions' AND column_name = 'title'")).rowCount).toBe(0);
    expect((await pool.query("SELECT to_regclass('media_submissions') AS t")).rows[0].t).toBeNull();
    await seedPre0028();
    const before = await snapshot();
    const items = (await pool.query("SELECT to_jsonb(i) AS j FROM media_items i ORDER BY id")).rows.map((r) => r.j);
    const keys = (await pool.query("SELECT to_jsonb(k) AS j FROM media_upload_keys k")).rows.map((r) => r.j as Record<string, unknown>);
    expect(before).toHaveLength(3);

    await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" }); // to head

    // Rows: identical in every old column (updated_at and updated_by included); the new title is NULL.
    const after = await snapshot();
    expect(after.map(({ title, ...rest }) => rest)).toEqual(before);
    expect(after.every((r) => r.title === null)).toBe(true);
    // 0029 adds the five review columns (null); every other column is unchanged.
    expect((await pool.query("SELECT to_jsonb(i) AS j FROM media_items i ORDER BY id")).rows.map((r) => r.j)).toEqual(
      items.map((i) => ({ ...i, review_decision: null, review_reason: null, review_version: null, review_decided_by: null, review_decided_at: null })),
    );
    expect((await pool.query("SELECT to_jsonb(k) AS j FROM media_upload_keys k")).rows.map((r) => r.j)).toEqual(keys.map((k) => ({ ...k, submission_sha256: null })));
    expect((await pool.query("SELECT count(*)::int AS n FROM media_submissions")).rows[0].n).toBe(0);

    // The new columns and their nullability.
    for (const [table, column, nullable] of [
      ["media_versions", "title", "YES"],
      ["media_upload_keys", "submission_sha256", "YES"],
      ["media_submissions", "full_name", "YES"],
      ["media_submissions", "instagram_handle", "YES"],
      ["media_submissions", "instagram_display_consent", "NO"],
      ["media_submissions", "updated_at", "NO"],
      ["media_submissions", "updated_by", "NO"],
    ] as const) {
      const r = await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = $2", [table, column]);
      expect(r.rows, `${table}.${column}`).toEqual([{ is_nullable: nullable }]);
    }

    // Validation state: the publishable CHECK stays NOT VALID (pre-0019 rows), every new CHECK is validated.
    const checks = (
      await pool.query(
        `SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('media_versions_publishable_check', 'media_versions_rights_statement_check',
           'media_versions_title_check', 'media_versions_v2_submission_check', 'media_upload_keys_submission_sha256_check', 'media_submissions_full_name_check',
           'media_submissions_instagram_handle_check', 'media_submissions_consent_check', 'media_submissions_updated_by_check') ORDER BY conname`,
      )
    ).rows;
    expect(checks).toEqual([
      { conname: "media_submissions_consent_check", convalidated: true },
      { conname: "media_submissions_full_name_check", convalidated: true },
      { conname: "media_submissions_instagram_handle_check", convalidated: true },
      { conname: "media_submissions_updated_by_check", convalidated: true },
      { conname: "media_upload_keys_submission_sha256_check", convalidated: true },
      { conname: "media_versions_publishable_check", convalidated: false },
      { conname: "media_versions_rights_statement_check", convalidated: true },
      { conname: "media_versions_title_check", convalidated: true },
      { conname: "media_versions_v2_submission_check", convalidated: true },
    ]);
    const def = (await pool.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'media_versions_publishable_check'")).rows[0].d as string;
    expect(def).toContain(V2);
    expect(def).toContain("licence_waiver IS NOT NULL");
    expect(def).toContain("NOT VALID");

    // New rows are held to the CHECKs (the old pre-0019 published row stayed).
    expect((await pool.query("SELECT count(*)::int AS n FROM media_versions WHERE media_id = $1", [preStatement])).rows[0].n).toBe(1);
    const version = (v: number, o: { statement: string | null; title?: string | null; credit?: string | null; licence?: string | null; required?: boolean; published?: boolean }) =>
      pool.query(
        `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_name, credit_required, licence_name, title, published_at,
            created_by, created_at, updated_at, updated_by, rights_statement, rights_stated_by, rights_stated_at)
         VALUES ($1, $2, $3, 'image/png', 100, 64, 48, $4, $5, $6, $7, $8, 'x', now(), now(), 'x', $9, $10, $11)`,
        [
          draftV1,
          v,
          SHA,
          o.credit === undefined ? "C" : o.credit,
          o.required ?? true,
          o.licence === undefined ? "L" : o.licence,
          o.title === undefined ? "T" : o.title,
          o.published ? T3 : null,
          o.statement,
          o.statement === null ? null : "x",
          o.statement === null ? null : T3,
        ],
      );
    expect(await violated(version(2, { statement: V2, title: null }))).toBe("media_versions_v2_submission_check");
    expect(await violated(version(3, { statement: V2, credit: null }))).toBe("media_versions_v2_submission_check");
    expect(await violated(version(4, { statement: V2, licence: null }))).toBe("media_versions_v2_submission_check");
    expect(await violated(version(5, { statement: V2, required: false }))).toBe("media_versions_v2_submission_check");
    expect(await violated(version(6, { statement: "v2_agreement_2099-01-01" }))).toBe("media_versions_rights_statement_check");
    expect(await violated(version(7, { statement: "v1_own", title: "" }))).toBe("media_versions_title_check");
    expect(await violated(version(8, { statement: null, published: true }))).toBe("media_versions_publishable_check");
    expect(await violated(version(9, { statement: V2, published: true }))).toBeNull(); // v2 is publishable
    expect(await violated(version(10, { statement: "v1_own", title: null, credit: null, licence: null, required: false }))).toBeNull();

    // The new table: one row per item, strict values, a real foreign key.
    const sub = (id: number, name: string | null, handle: string | null, consent: boolean) =>
      pool.query(`INSERT INTO media_submissions (media_id, full_name, instagram_handle, instagram_display_consent, updated_at, updated_by) VALUES ($1, $2, $3, $4, now(), 'x')`, [id, name, handle, consent]);
    expect(await violated(sub(draftV1, "N", null, true))).toBe("media_submissions_consent_check");
    expect(await violated(sub(draftV1, "N", "bad handle", false))).toBe("media_submissions_instagram_handle_check");
    expect(await violated(sub(draftV1, "", null, false))).toBe("media_submissions_full_name_check");
    expect(await violated(sub(draftV1, "N", "ok.handle", true))).toBeNull();
    expect(await violated(sub(draftV1, "N", null, false))).toBe("media_submissions_pkey");
    expect(await violated(sub(999999, "N", null, false))).toBe("media_submissions_media_id_media_items_id_fk");
    // No freeze trigger: the row is edited in place and erased.
    expect(await violated(pool.query(`UPDATE media_submissions SET full_name = NULL, instagram_handle = NULL, instagram_display_consent = false WHERE media_id = $1`, [draftV1]))).toBeNull();
    // A published version is still frozen (0027 trigger intact).
    expect(await violated(pool.query(`UPDATE media_versions SET title = 'x' WHERE media_id = $1 AND version = 1`, [publishedV1]))).toBe("23001");
    // Keys: the digest is a 64-character lowercase hex or NULL.
    expect(await violated(pool.query(`UPDATE media_upload_keys SET submission_sha256 = 'XYZ'`))).toBe("media_upload_keys_submission_sha256_check");
    expect(await violated(pool.query(`UPDATE media_upload_keys SET submission_sha256 = $1`, ["a".repeat(64)]))).toBeNull();

    // The migration left every trigger on media_versions enabled.
    const triggers = (await pool.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgrelid::regclass::text = 'media_versions'`)).rows[0].n;
    expect(triggers).toBe(2); // the published-frozen row trigger and the TRUNCATE trigger
  });
});
