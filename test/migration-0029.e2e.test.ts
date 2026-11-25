import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0029 (docs/plans/media-review-feedback.md): over rows that exist at 0028, in a throwaway `_test` database that is dropped
// afterwards. Proves the existing media and audit rows are untouched, the five review columns start NULL, every new CHECK is validated and
// refuses exactly its own violation, `media_review` is an accepted audit action and the append-only triggers survive.

const DB = "airplane_games_mig0029_test";
const SHA = "d".repeat(64);
const V1 = "v1_own";
const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";
const REVIEW_COLUMNS = ["review_decision", "review_reason", "review_version", "review_decided_by", "review_decided_at"] as const;
let admin: pg.Client;
let dir: string;
let url: string;
let pool: pg.Pool;
let unverified = 0; // draft 1, never published
let pending = 0; // published v1 with a pending draft v2
let withdrawn = 0; // withdrawn, version 1 was live once

beforeAll(async () => {
  const base = new URL(process.env.DATABASE_URL ?? "");
  const target = new URL(base.toString());
  target.pathname = `/${DB}`;
  url = target.toString();
  admin = new pg.Client({ connectionString: new URL("/postgres", base).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DB}"`);
  // A copy of the migrations folder whose journal stops at 0028.
  dir = mkdtempSync(join(tmpdir(), "mig0029-"));
  cpSync("drizzle", dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0029");
  expect(journal.entries.at(-1).tag.startsWith("0028")).toBe(true);
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

async function seedPre0029(): Promise<void> {
  await pool.query(
    `INSERT INTO media_items (owner, state, draft_version, published_version, created_by, updated_by, created_at, updated_at)
     VALUES ('o1', 'unverified', 1, NULL, 'o1', 'o1', $1, $1), ('o2', 'published', 2, 1, 'o2', 'o2', $1, $2), ('o3', 'withdrawn', 1, NULL, 'o3', 'o3', $1, $2)`,
    [T1, T2],
  );
  const ids = (await pool.query<{ id: string }>("SELECT id FROM media_items ORDER BY id")).rows.map((r) => Number(r.id));
  [unverified, pending, withdrawn] = ids as [number, number, number];
  const version = (mediaId: number, v: number, publishedAt: string | null) =>
    pool.query(
      `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_name, credit_required, licence_name, published_at,
          created_by, created_at, updated_at, updated_by, rights_statement, rights_stated_by, rights_stated_at)
       VALUES ($1, $2, $3, 'image/png', 100, 64, 48, 'Credit', true, 'CC BY 4.0', $4, 'x', $5, $5, 'x', $6, 'x', $5)`,
      [mediaId, v, SHA, publishedAt, T1, V1],
    );
  await version(unverified, 1, null);
  await version(pending, 1, T2);
  await version(pending, 2, null);
  await version(withdrawn, 1, T2);
  await pool.query(
    `INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ('o1', 'media_upload', 'med-1', '{"mediaId":"med-1"}'::jsonb, $1), ('o2', 'media_publish', 'med-2', '{"k":1}'::jsonb, $1)`,
    [T1],
  );
}

describe("migration 0029", () => {
  it("keeps every existing row byte-identical, adds five NULL columns, validates every new CHECK and enforces each on its own", async () => {
    await migrate(drizzle({ client: pool }), { migrationsFolder: dir });
    expect((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'media_items' AND column_name = 'review_decision'")).rowCount).toBe(0);
    await seedPre0029();
    const items = (await pool.query("SELECT to_jsonb(i) AS j FROM media_items i ORDER BY id")).rows.map((r) => r.j as Record<string, unknown>);
    const versions = (await pool.query("SELECT to_jsonb(v) AS j FROM media_versions v ORDER BY media_id, version")).rows.map((r) => r.j);
    const audit = (await pool.query("SELECT to_jsonb(a) AS j FROM admin_audit a ORDER BY id")).rows.map((r) => r.j);
    expect(items).toHaveLength(3);
    expect(audit).toHaveLength(2);

    await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" }); // to head

    // Rows: identical in every old column (updated_at and updated_by included); the review columns are NULL.
    const after = (await pool.query("SELECT to_jsonb(i) AS j FROM media_items i ORDER BY id")).rows.map((r) => r.j as Record<string, unknown>);
    expect(after.every((row) => REVIEW_COLUMNS.every((c) => row[c] === null))).toBe(true);
    const stripped = after.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !(REVIEW_COLUMNS as readonly string[]).includes(k))));
    expect(stripped).toEqual(items);
    expect((await pool.query("SELECT to_jsonb(v) AS j FROM media_versions v ORDER BY media_id, version")).rows.map((r) => r.j)).toEqual(versions);
    expect((await pool.query("SELECT to_jsonb(a) AS j FROM admin_audit a ORDER BY id")).rows.map((r) => r.j)).toEqual(audit);

    // The new columns: all nullable, with their types.
    const columns = (
      await pool.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'media_items' AND column_name LIKE 'review_%' ORDER BY column_name`)
    ).rows;
    expect(columns).toEqual([
      { column_name: "review_decided_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "review_decided_by", data_type: "text", is_nullable: "YES" },
      { column_name: "review_decision", data_type: "text", is_nullable: "YES" },
      { column_name: "review_reason", data_type: "text", is_nullable: "YES" },
      { column_name: "review_version", data_type: "integer", is_nullable: "YES" },
    ]);

    // Validation state: every new CHECK is validated (no NOT VALID), the new action list included.
    const checks = (
      await pool.query(
        `SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE 'media_items_review_%' OR conname = 'admin_audit_action_check' ORDER BY conname`,
      )
    ).rows;
    expect(checks).toEqual([
      { conname: "admin_audit_action_check", convalidated: true },
      { conname: "media_items_review_all_or_none_check", convalidated: true },
      { conname: "media_items_review_declined_check", convalidated: true },
      { conname: "media_items_review_decided_by_check", convalidated: true },
      { conname: "media_items_review_decision_check", convalidated: true },
      { conname: "media_items_review_pending_check", convalidated: true },
      { conname: "media_items_review_reason_check", convalidated: true },
      { conname: "media_items_review_version_check", convalidated: true },
    ].sort((a, b) => (a.conname < b.conname ? -1 : 1)));

    // One violation per CHECK: each update breaks exactly one rule.
    const set = (id: number, o: { decision?: string | null; reason?: string | null; version?: number | null; by?: string | null; at?: string | null }) =>
      pool.query(
        `UPDATE media_items SET review_decision = $2, review_reason = $3, review_version = $4, review_decided_by = $5, review_decided_at = $6 WHERE id = $1`,
        [id, o.decision ?? null, o.reason ?? null, o.version ?? null, o.by ?? null, o.at ?? null],
      );
    const good = { decision: "changes_requested", reason: "Fix it.", version: 1, by: "admin", at: T2 };
    expect(await violated(set(unverified, { ...good, decision: "bogus" }))).toBe("media_items_review_decision_check");
    expect(await violated(set(unverified, { ...good, reason: "" }))).toBe("media_items_review_reason_check");
    expect(await violated(set(unverified, { ...good, reason: "r".repeat(501) }))).toBe("media_items_review_reason_check");
    expect(await violated(set(unverified, { ...good, by: "" }))).toBe("media_items_review_decided_by_check");
    expect(await violated(set(unverified, { ...good, by: "b".repeat(257) }))).toBe("media_items_review_decided_by_check");
    expect(await violated(set(unverified, { decision: "changes_requested" }))).toBe("media_items_review_all_or_none_check");
    expect(await violated(set(unverified, { ...good, at: null }))).toBe("media_items_review_all_or_none_check");
    expect(await violated(set(unverified, { ...good, version: 0 }))).toBe("media_items_review_version_check");
    expect(await violated(set(unverified, { ...good, version: 2 }))).toBe("media_items_review_version_check"); // beyond draft_version 1
    expect(await violated(set(pending, { ...good, version: 1 }))).toBe("media_items_review_pending_check"); // not newer than the live version
    expect(await violated(set(pending, { ...good, decision: "declined", version: 2 }))).toBe("media_items_review_declined_check");
    expect(await violated(set(withdrawn, { ...good, decision: "declined" }))).toBe("media_items_review_declined_check");

    // And the valid states are accepted.
    expect(await violated(set(unverified, { ...good, decision: "declined", reason: "r".repeat(500) }))).toBeNull();
    expect(await violated(set(pending, { ...good, version: 2 }))).toBeNull();
    expect(await violated(set(withdrawn, good))).toBeNull();
    expect(await violated(set(unverified, {}))).toBeNull(); // all five NULL again
    // A state change that would leave a declined review on a published item is refused too.
    await set(unverified, { ...good, decision: "declined" });
    expect(await violated(pool.query(`UPDATE media_items SET state = 'published', published_version = 1 WHERE id = $1`, [unverified]))).toBe("media_items_review_declined_check");

    // Audit: the new action is accepted, an unknown one is refused, and the append-only triggers are intact.
    const audit1 = (action: string) => pool.query(`INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ('x', $1, 'med-1', '{}'::jsonb, now())`, [action]);
    expect(await violated(audit1("media_review"))).toBeNull();
    expect(await violated(audit1("media_review_typo"))).toBe("admin_audit_action_check");
    expect(await violated(pool.query(`UPDATE admin_audit SET target = 'med-9' WHERE actor = 'x'`))).toBe("23001");
    expect(await violated(pool.query(`DELETE FROM admin_audit WHERE actor = 'x'`))).toBe("23001");
    const triggers = (
      await pool.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgrelid::regclass::text = 'admin_audit' ORDER BY tgname`)
    ).rows.map((r) => r.tgname);
    expect(triggers).toEqual(["admin_audit_append_only", "admin_audit_no_truncate"]);
  });
});
