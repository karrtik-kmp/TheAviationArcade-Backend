import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0019 (docs/plans/media-rights-and-public.md): over media rows that exist at 0018, in a throwaway `_test` database that
// is dropped afterwards. The re-added publishable CHECK is NOT VALID, so old published rows (no rights statement) survive while
// every new or changed row is held to it.

const DB = "airplane_games_mig0019_test";
const SHA = "b".repeat(64);
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
  // A copy of the migrations folder whose journal stops at 0018.
  dir = mkdtempSync(join(tmpdir(), "mig0019-"));
  cpSync("drizzle", dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0019");
  expect(journal.entries.at(-1).tag.startsWith("0018")).toBe(true);
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

describe("migration 0019", () => {
  it("keeps old published and draft media rows unchanged (no statement, no description) and still blocks new violations", async () => {
    const pool = new pg.Pool({ connectionString: url });
    try {
      await migrate(drizzle({ client: pool }), { migrationsFolder: dir });
      expect((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'media_versions' AND column_name = 'rights_statement'")).rowCount).toBe(0);

      // Two items as they exist at 0018: one published (publishable licence, no statement), one unpublished draft.
      await pool.query(
        `INSERT INTO media_items (owner, state, draft_version, published_version, created_by, updated_by, created_at, updated_at)
         VALUES ('mig-owner', 'published', 1, 1, 'mig-owner', 'mig-owner', now(), now()),
                ('mig-owner', 'unverified', 1, NULL, 'mig-owner', 'mig-owner', now(), now())`,
      );
      const ids = (await pool.query<{ id: string }>("SELECT id FROM media_items ORDER BY id")).rows.map((r) => Number(r.id));
      await pool.query(
        `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_name, credit_required, licence_name, published_at, created_by, created_at)
         VALUES ($1, 1, $3, 'image/png', 100, 64, 48, 'Credit', true, 'CC BY 4.0', now(), 'mig-owner', now()),
                ($2, 1, $3, 'image/png', 100, 64, 48, NULL, true, NULL, NULL, 'mig-owner', now())`,
        [ids[0], ids[1], SHA],
      );
      const items = (await pool.query("SELECT * FROM media_items ORDER BY id")).rows;
      const versions = (await pool.query("SELECT * FROM media_versions ORDER BY media_id")).rows;
      const audit = (await pool.query("SELECT count(*)::int AS n FROM admin_audit")).rows[0].n;

      await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" }); // to head

      expect((await pool.query("SELECT * FROM media_items ORDER BY id")).rows).toEqual(items);
      const after = (await pool.query("SELECT * FROM media_versions ORDER BY media_id")).rows;
      expect(after.map(({ rights_statement, rights_stated_by, rights_stated_at, description, ...rest }) => rest)).toEqual(versions);
      expect(after.every((r) => r.rights_statement === null && r.rights_stated_by === null && r.rights_stated_at === null && r.description === null)).toBe(true);
      expect((await pool.query("SELECT count(*)::int AS n FROM admin_audit")).rows[0].n).toBe(audit);

      // The re-added constraint is NOT VALID: present, but never validated against the old rows.
      const check = (await pool.query("SELECT convalidated FROM pg_constraint WHERE conname = 'media_versions_publishable_check'")).rows;
      expect(check).toEqual([{ convalidated: false }]);

      const insert = (mediaId: number, version: number, o: { rights: string | null; published: boolean; licence?: string | null }) =>
        pool.query(
          `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_name, credit_required, licence_name, published_at,
              created_by, created_at, rights_statement, rights_stated_by, rights_stated_at)
           VALUES ($1, $2, $3, 'image/png', 100, 64, 48, 'Credit', true, $4, ${o.published ? "now()" : "NULL"}, 'mig-owner', now(),
              $5::text, CASE WHEN $5::text IS NULL THEN NULL ELSE 'mig-owner' END, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)`,
          [mediaId, version, SHA, o.licence === undefined ? "CC BY 4.0" : o.licence, o.rights],
        );
      // New rows: published needs a v1_* statement (null and the import's d1_private_review do not count).
      expect(await violated(insert(ids[1]!, 2, { rights: null, published: true }))).toBe("media_versions_publishable_check");
      expect(await violated(insert(ids[1]!, 3, { rights: "d1_private_review", published: true }))).toBe("media_versions_publishable_check");
      expect(await violated(insert(ids[1]!, 4, { rights: "v1_own", published: true, licence: null }))).toBe("media_versions_publishable_check");
      expect(await violated(insert(ids[1]!, 5, { rights: "v1_own", published: true }))).toBeNull();
      expect(await violated(insert(ids[1]!, 6, { rights: null, published: false }))).toBeNull(); // a draft may lack it
      expect(await violated(insert(ids[1]!, 7, { rights: "other", published: false }))).toBe("media_versions_rights_statement_check");

      // The old published row is left alone until it is UPDATED (then the check applies to it): why the service gates publish first.
      expect(await violated(pool.query("UPDATE media_versions SET byte_size = 101 WHERE media_id = $1 AND version = 1", [ids[0]]))).toBe(
        "media_versions_publishable_check",
      );
      expect(await violated(pool.query("UPDATE media_items SET revision = revision + 1 WHERE id = $1", [ids[0]]))).toBeNull();

      // The new audit actions and the imports table exist.
      expect(
        await violated(pool.query("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ('op', 'media_rights', 'med-1', '{}', now()), ('op', 'media_import', 'med-1', '{}', now())")),
      ).toBeNull();
      expect((await pool.query("SELECT count(*)::int AS n FROM media_imports")).rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
