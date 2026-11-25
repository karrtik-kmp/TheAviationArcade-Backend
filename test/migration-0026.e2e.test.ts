import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0026 (docs/plans/dev-licence-waiver.md): over media rows that exist at 0025, in a throwaway `_test` database that is
// dropped afterwards. The publishable CHECK is re-added NOT VALID (as 0019 did), so older published rows survive while every new or
// changed row is held to "a licence name or a waiver".

const DB = "airplane_games_mig0026_test";
const SHA = "c".repeat(64);
let admin: pg.Client;
let dir: string;
let url: string;

beforeAll(async () => {
  const base = new URL(process.env.DATABASE_URL ?? "");
  const target = new URL(base.toString());
  target.pathname = `/${DB}`;
  url = target.toString();
  admin = new pg.Client({ connectionString: new URL("/postgres", base).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DB}"`);
  // A copy of the migrations folder whose journal stops at 0025.
  dir = mkdtempSync(join(tmpdir(), "mig0026-"));
  cpSync("drizzle", dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0026");
  expect(journal.entries.at(-1).tag.startsWith("0025")).toBe(true);
  writeFileSync(journalPath, JSON.stringify(journal));
});

afterAll(async () => {
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

describe("migration 0026", () => {
  it("adds licence_waiver, keeps older rows, leaves the publishable CHECK NOT VALID and accepts a licence or a waiver", async () => {
    const pool = new pg.Pool({ connectionString: url });
    try {
      await migrate(drizzle({ client: pool }), { migrationsFolder: dir });
      expect((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'media_versions' AND column_name = 'licence_waiver'")).rowCount).toBe(0);

      await pool.query(
        `INSERT INTO media_items (owner, state, draft_version, published_version, created_by, updated_by, created_at, updated_at)
         VALUES ('mig-owner', 'published', 1, 1, 'mig-owner', 'mig-owner', now(), now()),
                ('mig-owner', 'unverified', 1, NULL, 'mig-owner', 'mig-owner', now(), now())`,
      );
      const ids = (await pool.query<{ id: string }>("SELECT id FROM media_items ORDER BY id")).rows.map((r) => Number(r.id));
      // A published version with a licence and a v1 statement, and an unpublished draft.
      await pool.query(
        `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_name, credit_required, licence_name, published_at,
            created_by, created_at, rights_statement, rights_stated_by, rights_stated_at)
         VALUES ($1, 1, $3, 'image/png', 100, 64, 48, 'Credit', true, 'CC BY 4.0', now(), 'mig-owner', now(), 'v1_own', 'mig-owner', now()),
                ($2, 1, $3, 'image/png', 100, 64, 48, NULL, true, NULL, NULL, 'mig-owner', now(), NULL, NULL, NULL)`,
        [ids[0], ids[1], SHA],
      );
      const items = (await pool.query("SELECT * FROM media_items ORDER BY id")).rows;
      const versions = (await pool.query("SELECT * FROM media_versions ORDER BY media_id")).rows;
      const audit = (await pool.query("SELECT count(*)::int AS n FROM admin_audit")).rows[0].n;

      await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" }); // to head

      // 0029 adds the five review columns (null); every other column is unchanged.
      expect((await pool.query("SELECT * FROM media_items ORDER BY id")).rows).toEqual(
        items.map((i) => ({ ...i, review_decision: null, review_reason: null, review_version: null, review_decided_by: null, review_decided_at: null })),
      );
      const after = (await pool.query("SELECT * FROM media_versions ORDER BY media_id")).rows;
      // 0027 adds updated_at/updated_by (backfilled) and 0028 adds title (null); every other column is unchanged.
      expect(after.map(({ licence_waiver, updated_at, updated_by, title, ...rest }) => rest)).toEqual(versions);
      expect(after.every((r) => r.updated_at instanceof Date && r.updated_by === "mig-owner")).toBe(true);
      expect(after.every((r) => r.licence_waiver === null)).toBe(true);
      expect((await pool.query("SELECT count(*)::int AS n FROM admin_audit")).rows[0].n).toBe(audit);

      // Still NOT VALID (never validated against older rows); the new waiver CHECKs validate normally.
      const checks = (await pool.query("SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE 'media_versions_%' AND conname IN ('media_versions_publishable_check', 'media_versions_licence_waiver_check', 'media_versions_licence_waiver_rule_check') ORDER BY conname")).rows;
      expect(checks).toEqual([
        { conname: "media_versions_licence_waiver_check", convalidated: true },
        { conname: "media_versions_licence_waiver_rule_check", convalidated: true },
        { conname: "media_versions_publishable_check", convalidated: false },
      ]);

      const insert = (version: number, o: { licence: string | null; waiver: string | null; published: boolean; rights?: string | null }) =>
        pool.query(
          `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_name, credit_required, licence_name, licence_waiver,
              published_at, created_by, created_at, updated_at, updated_by, rights_statement, rights_stated_by, rights_stated_at)
           VALUES ($1, $2, $3, 'image/png', 100, 64, 48, 'Credit', true, $4, $5, ${o.published ? "now()" : "NULL"}, 'mig-owner', now(), now(), 'mig-owner', $6::text, CASE WHEN $6::text IS NULL THEN NULL ELSE 'mig-owner' END, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END)`,
          [ids[1], version, SHA, o.licence, o.waiver, o.rights === undefined ? "v1_own" : o.rights],
        );
      // Neither a licence name nor a waiver on a published version: refused (the constraint is enforced from now on).
      expect(await violated(insert(2, { licence: null, waiver: null, published: true }))).toBe("media_versions_publishable_check");
      expect(await violated(insert(3, { licence: "CC0", waiver: null, published: true }))).toBeNull();
      expect(await violated(insert(4, { licence: null, waiver: "dev-demo", published: true }))).toBeNull();
      // A waiver never sits next to a licence name, an unpublished version, or another value; the other publishable terms still hold.
      expect(await violated(insert(5, { licence: "CC0", waiver: "dev-demo", published: true }))).toBe("media_versions_licence_waiver_rule_check");
      expect(await violated(insert(6, { licence: null, waiver: "dev-demo", published: false }))).toBe("media_versions_licence_waiver_rule_check");
      expect(await violated(insert(7, { licence: null, waiver: "other", published: true }))).toBe("media_versions_licence_waiver_check");
      expect(await violated(insert(8, { licence: null, waiver: "dev-demo", published: true, rights: null }))).toBe("media_versions_publishable_check");
      expect(await violated(insert(9, { licence: null, waiver: "dev-demo", published: true, rights: "d1_private_review" }))).toBe("media_versions_publishable_check");
    } finally {
      await pool.end();
    }
  });
});
