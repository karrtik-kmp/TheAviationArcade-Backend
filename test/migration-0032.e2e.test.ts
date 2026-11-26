import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0032 (docs/plans/faq-cms.md): over a database seeded at 0031, in a throwaway `_test` database that is dropped afterwards. The
// two name CHECKs gain 'faq' and nothing else changes: every existing row is byte-identical, both checks are validated, 'faq' is accepted,
// an unknown name is refused, and the immutability triggers survive.

const DB = "airplane_games_mig0032_test";
const SHA = "e".repeat(64);
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
  // A copy of the migrations folder whose journal stops at 0031.
  dir = mkdtempSync(join(tmpdir(), "mig0032-"));
  cpSync("drizzle", dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0032");
  expect(journal.entries.at(-1).tag.startsWith("0031")).toBe(true);
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

const document = (name: string, version: number) =>
  pool.query(
    `INSERT INTO content_documents (name, version, format, body, sha256, byte_size, created_at, created_by, note) VALUES ($1, $2, $3, $4::jsonb, $5, 10, $6, 'seed', 'n')`,
    [name, version, `${name}.v1`, JSON.stringify({ format: `${name}.v1`, version }), SHA, T1],
  );
const draftRow = (name: string) =>
  pool.query(`INSERT INTO content_drafts (name, version, edits, updated_at, updated_by) VALUES ($1, 1, '{}'::jsonb, $2, 'seed')`, [name, T1]);

describe("migration 0032", () => {
  it("keeps every existing row byte-identical, validates both name CHECKs, accepts faq and refuses an unknown name", async () => {
    await migrate(drizzle({ client: pool }), { migrationsFolder: dir });
    expect(await violated(document("faq", 1))).toBe("content_documents_name_check"); // not at 0031
    expect(await violated(draftRow("faq"))).toBe("content_drafts_name_check");

    await document("field-awards", 1);
    await document("aircraft-tags", 1);
    await draftRow("field-awards");
    await draftRow("clipper-cards");
    const documents = (await pool.query("SELECT to_jsonb(d) AS j FROM content_documents d ORDER BY name, version")).rows.map((r) => r.j);
    const drafts = (await pool.query("SELECT to_jsonb(d) AS j FROM content_drafts d ORDER BY name")).rows.map((r) => r.j);
    expect(documents).toHaveLength(2);
    expect(drafts).toHaveLength(2);

    await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" }); // to head

    expect((await pool.query("SELECT to_jsonb(d) AS j FROM content_documents d ORDER BY name, version")).rows.map((r) => r.j)).toEqual(documents);
    expect((await pool.query("SELECT to_jsonb(d) AS j FROM content_drafts d ORDER BY name")).rows.map((r) => r.j)).toEqual(drafts);

    const checks = (
      await pool.query(`SELECT conname, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('content_documents_name_check', 'content_drafts_name_check') ORDER BY conname`)
    ).rows;
    expect(checks.map((c) => [c.conname, c.convalidated])).toEqual([
      ["content_documents_name_check", true],
      ["content_drafts_name_check", true],
    ]);
    for (const c of checks) {
      for (const name of ["field-awards", "clipper-cards", "aircraft-tags", "faq"]) expect(c.def).toContain(`'${name}'`);
    }

    expect(await violated(document("faq", 1))).toBeNull();
    expect(await violated(draftRow("faq"))).toBeNull();
    expect(await violated(document("faqs", 1))).toBe("content_documents_name_check");
    expect(await violated(draftRow("nope"))).toBe("content_drafts_name_check");

    // The other CHECKs are untouched: the format must still be `<name>.v1`.
    expect(
      await violated(pool.query(`INSERT INTO content_documents (name, version, format, body, sha256, byte_size, created_by) VALUES ('faq', 2, 'faq.v2', '{}'::jsonb, $1, 10, 'x')`, [SHA])),
    ).toBe("content_documents_format_check");

    // Immutability survives.
    expect(await violated(pool.query(`UPDATE content_documents SET note = 'changed' WHERE name = 'faq'`))).toBe("23001");
    expect(await violated(pool.query(`DELETE FROM content_documents WHERE name = 'faq'`))).toBe("23001");
    const triggers = (
      await pool.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgrelid::regclass::text = 'content_documents' ORDER BY tgname`)
    ).rows.map((r) => r.tgname);
    expect(triggers).toEqual(["content_documents_immutable", "content_documents_no_truncate"]);
  });
});
