import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoleStore } from "../src/accounts/role-store.js";
import { DatabaseService } from "../src/database/database.module.js";
import { clearRoles, demoPrincipal, seedRole } from "./roles-helpers.js";

// Plan R-c: the operator command `roles:grant` (scripts/roles-grant.mjs, run from the built dist/) and the role store option it relies on.
// Active admins in the shared test database are set aside (revoked, then restored) only while a test needs "no active admin".

let sql: pg.Pool;
let store: RoleStore;
const created: string[] = [];

const fresh = (): { uid: string; principal: string } => {
  const uid = `rc-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  created.push(principal);
  return { uid, principal };
};

beforeAll(async () => {
  // The script imports the compiled code, so build the current source first.
  const build = spawnSync(process.execPath, ["node_modules/@nestjs/cli/bin/nest.js", "build"], { encoding: "utf8" });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  store = new RoleStore(new DatabaseService(sql));
});

afterAll(async () => {
  await sql.query("DELETE FROM admin_audit WHERE target = ANY($1::text[])", [created]);
  await clearRoles(sql, ...created);
  await sql.end();
});

async function withNoActiveAdmin(fn: () => Promise<void>): Promise<void> {
  const others = (await sql.query("SELECT principal FROM account_roles WHERE role = 'admin' AND state = 'active'")).rows.map((r) => r.principal as string);
  await sql.query("UPDATE account_roles SET state = 'revoked' WHERE role = 'admin' AND principal = ANY($1::text[])", [others]);
  try {
    await fn();
  } finally {
    await sql.query("UPDATE account_roles SET state = 'active' WHERE role = 'admin' AND principal = ANY($1::text[])", [others]);
  }
}

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["scripts/roles-grant.mjs", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: process.cwd(),
    timeout: 20_000,
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

const adminRow = async (principal: string) =>
  (await sql.query("SELECT state, revision, decided_by, note FROM account_roles WHERE principal = $1 AND role = 'admin'", [principal])).rows[0];
const auditRows = async (principal: string) =>
  (await sql.query("SELECT actor, action, detail FROM admin_audit WHERE target = $1 ORDER BY id", [principal])).rows;

describe("RoleStore.grantAdmin onlyIfNoActiveAdmin", () => {
  it("refuses while an active admin exists: 409, no row, no audit row", async () => {
    const existing = fresh();
    await seedRole(sql, existing.principal, "admin", "active");
    const target = fresh();
    const outcome = await store.grantAdmin({ kind: "operator", id: "test" }, target.principal, null, { onlyIfNoActiveAdmin: true });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.status).toBe(409);
    expect(await adminRow(target.principal)).toBeUndefined();
    expect(await auditRows(target.principal)).toEqual([]);
  });

  it("grants when no admin is active, with one role_grant audit row by the operator", async () => {
    const target = fresh();
    await withNoActiveAdmin(async () => {
      const outcome = await store.grantAdmin({ kind: "operator", id: "test" }, target.principal, null, { onlyIfNoActiveAdmin: true });
      expect(outcome.ok).toBe(true);
    });
    expect(await adminRow(target.principal)).toMatchObject({ state: "active", revision: 1, decided_by: "operator:test" });
    const audit = await auditRows(target.principal);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: "operator:test",
      action: "role_grant",
      detail: { role: "admin", from: null, to: { state: "active", revision: 1 }, note: null },
    });
  });

  it("without the option an operator grant still works beside an active admin (API path unchanged)", async () => {
    const existing = fresh();
    await seedRole(sql, existing.principal, "admin", "active");
    const target = fresh();
    expect((await store.grantAdmin({ kind: "operator", id: "test" }, target.principal, null)).ok).toBe(true);
  });
});

describe("npm run roles:grant (scripts/roles-grant.mjs)", () => {
  it("refuses without --yes, shows host and database but not the password, writes nothing", async () => {
    const t = fresh();
    const r = run([t.uid]);
    expect(r.status).toBe(2);
    expect(r.out).toContain("database");
    expect(r.out).not.toContain("airplane_local_only");
    expect(r.err).toContain("--yes");
    expect(await adminRow(t.principal)).toBeUndefined();
  });

  it("refuses a bad uid, a full principal of another project, and any role but admin", async () => {
    const t = fresh();
    for (const bad of ["a:b", " padded", "x".repeat(129), "firebase:other-project:abc"]) {
      const r = run([bad, "--yes"]);
      expect(r.status, bad).toBe(2);
    }
    expect(run([t.uid, "--role", "photographer", "--yes"]).status).toBe(2);
    expect(run([t.uid, "--role=player", "--yes"]).status).toBe(2);
    expect(run(["--yes"]).status).toBe(2);
    expect(await adminRow(t.principal)).toBeUndefined();
  });

  it("refuses the demo project when APP_ENV=production, before touching the database", async () => {
    const t = fresh();
    const r = run([t.uid, "--yes"], { APP_ENV: "production", FIREBASE_PROJECT_ID: "demo-airplane-games", ALLOW_EMULATOR_TOKENS: "false", DATABASE_SSL: "verify-full" });
    expect(r.status).toBe(2);
    expect(r.err).toContain("demo");
    expect(await adminRow(t.principal)).toBeUndefined();
  });

  it("refuses weaker TLS than the server: production with DATABASE_SSL=disable, and ssl options in DATABASE_URL (exit 2, no connection)", async () => {
    const t = fresh();
    const prod = run([t.uid, "--yes"], { APP_ENV: "production", FIREBASE_PROJECT_ID: "real-project", DATABASE_SSL: "disable" });
    expect(prod.status).toBe(2);
    expect(prod.err).toContain("DATABASE_SSL");
    expect(prod.out).not.toContain("Target database");
    const url = new URL(process.env.DATABASE_URL ?? "");
    url.searchParams.set("sslmode", "disable");
    const viaUrl = run([t.uid, "--yes"], { DATABASE_URL: url.toString() });
    expect(viaUrl.status).toBe(2);
    expect(viaUrl.err).toContain("DATABASE_URL");
    expect(viaUrl.out).not.toContain("Target database");
    expect(await adminRow(t.principal)).toBeUndefined();
  });

  it("a wrong password exits 1 naming the authentication failure and never the password", async () => {
    const t = fresh();
    const url = new URL(process.env.DATABASE_URL ?? "");
    const real = decodeURIComponent(url.password);
    url.password = "definitely-wrong-pw";
    const r = run([t.uid, "--yes"], { DATABASE_URL: url.toString() });
    expect(r.status, r.err).toBe(1);
    expect(r.err).toContain("28P01");
    expect(r.err + r.out).not.toContain("definitely-wrong-pw");
    if (real) expect(r.err + r.out).not.toContain(real);
    expect(await adminRow(t.principal)).toBeUndefined();
  });

  it("refuses while an active admin exists (exit 3), writes nothing", async () => {
    const existing = fresh();
    await seedRole(sql, existing.principal, "admin", "active");
    const t = fresh();
    const r = run([t.uid, "--yes"]);
    expect(r.status).toBe(3);
    expect(await adminRow(t.principal)).toBeUndefined();
    expect(await auditRows(t.principal)).toEqual([]);
  });

  it("grants the first admin and audits it; running twice refuses the second time", async () => {
    const t = fresh();
    await withNoActiveAdmin(async () => {
      const first = run([t.uid, "--yes"]);
      expect(first.status, first.err).toBe(0);
      expect(first.out).toContain("Granted");
      expect(first.out).not.toContain("airplane_local_only");
      const second = run([t.uid, "--yes"]);
      expect(second.status).toBe(3);
    });
    expect(await adminRow(t.principal)).toMatchObject({ state: "active", revision: 1 });
    const audit = await auditRows(t.principal);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: `operator:${userInfo().username}`.slice(0, 256),
      action: "role_grant",
      detail: { role: "admin", from: null, to: { state: "active", revision: 1 }, note: null },
    });
  });

  it("re-activates a revoked admin row (update at revision + 1, not a second row)", async () => {
    const t = fresh();
    await seedRole(sql, t.principal, "admin", "revoked");
    await withNoActiveAdmin(async () => {
      const r = run([t.principal, "--yes"]); // the full principal of the configured project is accepted
      expect(r.status, r.err).toBe(0);
    });
    expect((await sql.query("SELECT count(*)::int AS n FROM account_roles WHERE principal = $1 AND role = 'admin'", [t.principal])).rows[0].n).toBe(1);
    expect(await adminRow(t.principal)).toMatchObject({ state: "active", revision: 2 });
    const audit = await auditRows(t.principal);
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ from: { state: "revoked", revision: 1 }, to: { state: "active", revision: 2 } });
  });
  it("--email (and --email=) stores the normalised typed email on the admin row; the audit row carries no email", async () => {
    const t = fresh();
    const u = fresh();
    await withNoActiveAdmin(async () => {
      const first = run([t.uid, "--email", "  Ops@Example.TEST ", "--yes"]);
      expect(first.status, first.err).toBe(0);
      expect(first.out + first.err).not.toContain("ops@example.test");
    });
    expect((await sql.query("SELECT grant_email FROM account_roles WHERE principal = $1 AND role = 'admin'", [t.principal])).rows[0].grant_email).toBe("ops@example.test");
    await withNoActiveAdmin(async () => {
      expect(run([u.uid, "--email=Other@Example.test", "--yes"]).status).toBe(0);
    });
    expect((await sql.query("SELECT grant_email FROM account_roles WHERE principal = $1 AND role = 'admin'", [u.principal])).rows[0].grant_email).toBe("other@example.test");
    for (const principal of [t.principal, u.principal]) {
      const audit = await auditRows(principal);
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0]).toLowerCase()).not.toContain("example.test");
    }
  });

  it("a bad --email exits 2 before the database is contacted and writes nothing", async () => {
    const t = fresh();
    for (const bad of ["not-an-email", "a@@b.test", "has space@example.test", "", "x".repeat(400)]) {
      const r = run([t.uid, "--email", bad, "--yes"]);
      expect(r.status, JSON.stringify(bad)).toBe(2);
      expect(r.out).not.toContain("Target database");
    }
    expect(run([t.uid, "--email"]).status).toBe(2); // a missing value is the empty string
    expect(await adminRow(t.principal)).toBeUndefined();
  });

  it("refuses an account whose photographer row is blocked (exit 3, nothing written); the store refuses it too", async () => {
    const t = fresh();
    await seedRole(sql, t.principal, "photographer", "blocked");
    await withNoActiveAdmin(async () => {
      const r = run([t.uid, "--yes"]);
      expect(r.status, r.err).toBe(3);
      expect(r.err).toContain("blocked");
      const outcome = await store.grantAdmin({ kind: "operator", id: "test" }, t.principal, null);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.status).toBe(409);
    });
    expect(await adminRow(t.principal)).toBeUndefined();
    expect(await auditRows(t.principal)).toEqual([]);
  });
});
