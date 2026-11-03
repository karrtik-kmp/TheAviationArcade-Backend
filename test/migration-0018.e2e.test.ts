import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Plan R-d: migration 0018 over rows that exist at 0017, in a throwaway `_test` database that is dropped afterwards.

const DB = "airplane_games_mig0018_test";
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
  // A copy of the migrations folder whose journal stops at 0017.
  dir = mkdtempSync(join(tmpdir(), "mig0018-"));
  cpSync("drizzle", dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0018");
  expect(journal.entries.at(-1).tag.startsWith("0017")).toBe(true);
  writeFileSync(journalPath, JSON.stringify(journal));
});

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.end();
  rmSync(dir, { recursive: true, force: true });
});

const COLUMNS = "principal, role, state, revision, requested_at, decided_at, decided_by, note, request_email";

describe("migration 0018", () => {
  it("keeps every role row (any role and state) and a media row unchanged, with grant_email NULL", async () => {
    const pool = new pg.Pool({ connectionString: url });
    try {
      await migrate(drizzle({ client: pool }), { migrationsFolder: dir });
      expect((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'account_roles' AND column_name = 'grant_email'")).rowCount).toBe(0);

      const seeds: [string, string, string][] = [
        ["pl", "player", "active"],
        ["pl-revoked", "player", "revoked"],
        ["ph-pending", "photographer", "pending"],
        ["ph-active", "photographer", "active"],
        ["ph-rejected", "photographer", "rejected"],
        ["ph-revoked", "photographer", "revoked"],
        ["ad-active", "admin", "active"],
        ["ad-revoked", "admin", "revoked"],
      ];
      for (const [principal, role, state] of seeds) {
        const decided = state !== "pending";
        await pool.query(
          `INSERT INTO account_roles (principal, role, state, requested_at, decided_at, decided_by, request_email, revision)
           VALUES ($1, $2, $3, now(), $4, $5, $6, 3)`,
          [principal, role, state, decided ? new Date() : null, decided ? "seed" : null, role === "photographer" ? `${state}@x.test` : null],
        );
      }
      await pool.query(
        `INSERT INTO media_items (owner, state, draft_version, published_version, created_by, updated_by, created_at, updated_at)
         VALUES ('mig-owner', 'unverified', 1, NULL, 'mig-owner', 'mig-owner', now(), now())`,
      );
      const before = (await pool.query(`SELECT ${COLUMNS} FROM account_roles ORDER BY principal, role`)).rows;
      const media = (await pool.query("SELECT * FROM media_items")).rows;
      expect(before).toHaveLength(seeds.length);

      await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" }); // to head

      const after = (await pool.query(`SELECT ${COLUMNS}, grant_email FROM account_roles ORDER BY principal, role`)).rows;
      expect(after.map(({ grant_email: _ignored, ...rest }) => rest)).toEqual(before);
      expect(after.every((r) => r.grant_email === null)).toBe(true);
      expect((await pool.query("SELECT * FROM media_items")).rows).toEqual(media);

      // The new rules hold on the migrated table.
      await pool.query("UPDATE account_roles SET state = 'blocked' WHERE principal = 'ph-active' AND role = 'photographer'");
      await expect(pool.query("UPDATE account_roles SET state = 'blocked' WHERE principal = 'ad-active' AND role = 'admin'")).rejects.toMatchObject({
        constraint: "account_roles_blocked_role_check",
      });
      await expect(pool.query("UPDATE account_roles SET grant_email = 'a@b.test' WHERE principal = 'ph-pending'")).rejects.toMatchObject({
        constraint: "account_roles_grant_email_check",
      });
    } finally {
      await pool.end();
    }
  });
});
