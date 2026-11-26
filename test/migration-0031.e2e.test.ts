import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0031 (docs/plans/self-serve-photographer.md, S5): over rows that exist at 0030, in a throwaway `_test` database that is dropped
// afterwards. Proves every photographer row still `pending` with a request email becomes `active` with one exact `role_self_activate` audit row
// (one shared timestamp, millisecond precision), every other row (pending without an email, rejected, revoked, blocked, active, admin, player)
// and every earlier audit row stays byte-identical, the new action is accepted by the CHECK and the append-only triggers survive.

const DB = "airplane_games_mig0031_test";
const T1 = "2026-11-01T10:00:00.000Z";
const T2 = "2026-11-02T10:00:00.000Z";
const PREFIX = "firebase:demo-airplane-games:mig31-";
const SYSTEM = "system:self-serve-0031";
let admin: pg.Client;
let dir: string;
let pool: pg.Pool;

beforeAll(async () => {
  const base = new URL(process.env.DATABASE_URL ?? "");
  const target = new URL(base.toString());
  target.pathname = `/${DB}`;
  admin = new pg.Client({ connectionString: new URL("/postgres", base).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DB}"`);
  // A copy of the migrations folder whose journal stops at 0030.
  dir = mkdtempSync(join(tmpdir(), "mig0031-"));
  cpSync("drizzle", dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0031");
  expect(journal.entries.at(-1).tag.startsWith("0030")).toBe(true);
  writeFileSync(journalPath, JSON.stringify(journal));
  pool = new pg.Pool({ connectionString: target.toString() });
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

type Seed = { key: string; role: string; state: string; revision: number; requestEmail?: string | null; grantEmail?: string | null };
const SEEDS: Seed[] = [
  { key: "pend-a", role: "photographer", state: "pending", revision: 1, requestEmail: "a@example.test" },
  { key: "pend-b", role: "photographer", state: "pending", revision: 4, requestEmail: "b@example.test" },
  { key: "pend-null", role: "photographer", state: "pending", revision: 2, requestEmail: null },
  { key: "rejected", role: "photographer", state: "rejected", revision: 2, requestEmail: "r@example.test" },
  { key: "revoked", role: "photographer", state: "revoked", revision: 3, requestEmail: "v@example.test" },
  { key: "blocked", role: "photographer", state: "blocked", revision: 2, requestEmail: "k@example.test" },
  { key: "active", role: "photographer", state: "active", revision: 2, requestEmail: "c@example.test" },
  { key: "admin", role: "admin", state: "active", revision: 1, grantEmail: "boss@example.test" },
  { key: "player", role: "player", state: "active", revision: 1 },
];
const principalOf = (key: string) => `${PREFIX}${key}`;

async function seed(): Promise<void> {
  for (const s of SEEDS) {
    const decided = s.state !== "pending";
    await pool.query(
      `INSERT INTO account_roles (principal, role, state, requested_at, decided_at, decided_by, updated_at, revision, request_email, grant_email, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        principalOf(s.key),
        s.role,
        s.state,
        T1,
        decided ? T1 : null,
        decided ? "firebase:demo-airplane-games:some-admin" : null,
        T2,
        s.revision,
        s.requestEmail ?? null,
        s.grantEmail ?? null,
        decided ? "kept note" : null,
      ],
    );
  }
  await pool.query(
    `INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES
       ('x', 'role_request', $1, '{"role":"photographer","from":null,"to":{"state":"pending","revision":1},"note":null}'::jsonb, $3),
       ('x', 'role_reject', $2, '{"role":"photographer"}'::jsonb, $3)`,
    [principalOf("pend-a"), principalOf("rejected"), T1],
  );
}

const rolesJson = async () =>
  new Map(
    (await pool.query("SELECT principal, to_jsonb(r) AS j FROM account_roles r WHERE principal LIKE $1 ORDER BY principal, role", [`${PREFIX}%`])).rows.map((r) => [
      `${r.principal}|${r.j.role}`,
      r.j as Record<string, unknown>,
    ]),
  );

describe("migration 0031", () => {
  it("activates the pending photographer rows that carry an email with one exact audit row each, and leaves every other row byte-identical", async () => {
    await migrate(drizzle({ client: pool }), { migrationsFolder: dir });
    await seed();
    const before = await rolesJson();
    const auditBefore = (await pool.query("SELECT to_jsonb(a) AS j FROM admin_audit a ORDER BY id")).rows.map((r) => r.j);
    expect(before.size).toBe(SEEDS.length);
    expect(auditBefore).toHaveLength(2);

    await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" }); // to head

    // Untouched rows: identical in every column.
    const after = await rolesJson();
    for (const key of ["pend-null", "rejected", "revoked", "blocked", "active", "admin", "player"]) {
      const role = SEEDS.find((s) => s.key === key)!.role;
      expect(after.get(`${principalOf(key)}|${role}`), key).toEqual(before.get(`${principalOf(key)}|${role}`));
    }

    // Activated rows: state, revision + 1, decided_at, decided_by, updated_at change; requested_at, emails, note and the rest keep their values.
    const audits = (await pool.query("SELECT * FROM admin_audit WHERE actor = $1 ORDER BY target", [SYSTEM])).rows;
    expect(audits).toHaveLength(2);
    const stamp = audits[0].created_at as Date;
    for (const [key, from] of [["pend-a", 1], ["pend-b", 4]] as const) {
      const old = before.get(`${principalOf(key)}|photographer`)!;
      const now = after.get(`${principalOf(key)}|photographer`)!;
      const audit = audits.find((a) => a.target === principalOf(key));
      expect(audit, key).toBeDefined();
      // One stamp for the whole migration, at the app clock's precision (milliseconds), on the row and on the audit row.
      expect(audit.created_at.getTime()).toBe(stamp.getTime());
      expect(now).toEqual({
        ...old,
        state: "active",
        revision: from + 1,
        decided_at: now.decided_at, // equals the stamp: checked in SQL below (the JSON text drops a zero fraction)
        decided_by: SYSTEM,
        updated_at: now.updated_at,
      });
      expect(audit).toMatchObject({ actor: SYSTEM, action: "role_self_activate", target: principalOf(key) });
      expect(audit.detail).toEqual({ role: "photographer", from: { state: "pending", revision: from }, to: { state: "active", revision: from + 1 }, note: null });
      expect(JSON.stringify(audit)).not.toContain("example.test");
    }
    expect(stamp.getTime()).toBeGreaterThan(new Date(T2).getTime());
    const precision = await pool.query(
      "SELECT bool_and(created_at = date_trunc('milliseconds', created_at)) AS ok FROM admin_audit WHERE actor = $1",
      [SYSTEM],
    );
    expect(precision.rows[0].ok).toBe(true);
    const rowStamps = await pool.query(
      "SELECT bool_and(decided_at = $2::timestamptz AND updated_at = $2::timestamptz) AS ok FROM account_roles WHERE decided_by = $1",
      [SYSTEM, stamp],
    );
    expect(rowStamps.rows[0].ok).toBe(true);

    // Earlier audit rows are untouched and no other row was added.
    const auditAfter = (await pool.query("SELECT to_jsonb(a) AS j FROM admin_audit a WHERE actor <> $1 ORDER BY id", [SYSTEM])).rows.map((r) => r.j);
    expect(auditAfter).toEqual(auditBefore);
    expect((await pool.query("SELECT count(*)::int AS n FROM admin_audit")).rows[0].n).toBe(4);

    // No photographer row with an email is pending any more; the one without stays pending (its next POST activates it).
    const pending = (await pool.query("SELECT principal FROM account_roles WHERE state = 'pending' AND principal LIKE $1", [`${PREFIX}%`])).rows;
    expect(pending).toEqual([{ principal: principalOf("pend-null") }]);
  });

  it("the audit CHECK is validated and accepts role_self_activate, refuses an unknown action, and the append-only triggers survive", async () => {
    const check = (await pool.query("SELECT convalidated FROM pg_constraint WHERE conname = 'admin_audit_action_check'")).rows;
    expect(check).toEqual([{ convalidated: true }]);
    const audit1 = (action: string) => pool.query(`INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ('y', $1, 't', '{}'::jsonb, now())`, [action]);
    expect(await violated(audit1("role_self_activate"))).toBeNull();
    expect(await violated(audit1("role_request"))).toBeNull(); // historical actions stay valid
    expect(await violated(audit1("role_approve"))).toBeNull();
    expect(await violated(audit1("role_self_activate_typo"))).toBe("admin_audit_action_check");
    expect(await violated(pool.query(`UPDATE admin_audit SET target = 'z' WHERE actor = 'y'`))).toBe("23001");
    expect(await violated(pool.query(`DELETE FROM admin_audit WHERE actor = 'y'`))).toBe("23001");
    const triggers = (
      await pool.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgrelid::regclass::text = 'admin_audit' ORDER BY tgname`)
    ).rows.map((r) => r.tgname);
    expect(triggers).toEqual(["admin_audit_append_only", "admin_audit_no_truncate"]);
  });
});
