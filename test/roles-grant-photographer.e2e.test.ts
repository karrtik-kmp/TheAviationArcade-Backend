import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoleStore } from "../src/accounts/role-store.js";
import type { RoleActor } from "../src/accounts/role-store.js";
import { DatabaseService } from "../src/database/database.module.js";
import { clearRoles, demoPrincipal, seedRole } from "./roles-helpers.js";

// ADR-0002 follow-up (2026-11-16): RoleStore.grantPhotographer, the operator-only grant used by the dev demo seed.

let sql: pg.Pool;
let store: RoleStore;
const created: string[] = [];
const operator: RoleActor = { kind: "operator", id: "seed-test" };

const fresh = (): string => {
  const principal = demoPrincipal(`gp-${randomUUID()}`);
  created.push(principal);
  return principal;
};

beforeAll(() => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  store = new RoleStore(new DatabaseService(sql), { demoPrincipal: demoPrincipal("the-demo-account") });
});

afterAll(async () => {
  await sql.query("DELETE FROM admin_audit WHERE target = ANY($1::text[])", [created]);
  await clearRoles(sql, ...created);
  await sql.end();
});

const row = async (principal: string) =>
  (
    await sql.query(
      "SELECT state, revision, decided_by, decided_at, requested_at, request_email, note FROM account_roles WHERE principal = $1 AND role = 'photographer'",
      [principal],
    )
  ).rows[0];
const audits = async (principal: string) =>
  (await sql.query("SELECT actor, action, detail FROM admin_audit WHERE target = $1 ORDER BY id", [principal])).rows;

describe("RoleStore.grantPhotographer", () => {
  it("no row: inserts active at revision 0 with one role_grant audit row by the operator", async () => {
    const p = fresh();
    const outcome = await store.grantPhotographer(operator, p, "demo seed");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.changed).toBe(true);
    const r = await row(p);
    expect(r).toMatchObject({ state: "active", decided_by: "operator:seed-test", note: "demo seed" });
    expect(r.decided_at).not.toBeNull();
    expect(r.requested_at).not.toBeNull();
    const revision = r.revision as number;
    const a = await audits(p);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      actor: "operator:seed-test",
      action: "role_grant",
      detail: { role: "photographer", from: null, to: { state: "active", revision }, note: "demo seed" },
    });
  });

  it("pending: becomes active at revision + 1, keeps request_email, one audit row with from and to", async () => {
    const p = fresh();
    await sql.query("INSERT INTO account_roles (principal, role, state, requested_at, request_email) VALUES ($1, 'photographer', 'pending', now(), 'req@example.test')", [p]);
    const before = await row(p);
    const outcome = await store.grantPhotographer(operator, p, null);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.changed).toBe(true);
      expect(outcome.row.revision).toBe(before.revision + 1);
    }
    const after = await row(p);
    expect(after).toMatchObject({ state: "active", revision: before.revision + 1, decided_by: "operator:seed-test", request_email: "req@example.test" });
    expect(after.decided_at).not.toBeNull();
    const a = await audits(p);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      actor: "operator:seed-test",
      action: "role_grant",
      detail: { role: "photographer", from: { state: "pending", revision: before.revision }, to: { state: "active", revision: before.revision + 1 } },
    });
  });

  it("active: no-op, changed false, same revision, no audit row; a repeat after a grant also writes nothing", async () => {
    const p = fresh();
    await seedRole(sql, p, "photographer", "active");
    const before = await row(p);
    const outcome = await store.grantPhotographer(operator, p, "again");
    expect(outcome).toMatchObject({ ok: true, changed: false });
    expect(await row(p)).toEqual(before);
    expect(await audits(p)).toEqual([]);

    const q = fresh();
    await store.grantPhotographer(operator, q, null);
    const second = await store.grantPhotographer(operator, q, null);
    expect(second).toMatchObject({ ok: true, changed: false });
    expect(await audits(q)).toHaveLength(1);
  });

  for (const state of ["rejected", "revoked", "blocked"] as const) {
    it(`${state}: refused 409 version_conflict naming the Admin, nothing written`, async () => {
      const p = fresh();
      await seedRole(sql, p, "photographer", state);
      const before = await row(p);
      const outcome = await store.grantPhotographer(operator, p, null);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.status).toBe(409);
        expect(outcome.error.code).toBe("version_conflict");
        expect(outcome.error.message).toContain("Admin");
        expect(outcome.error.message).toContain(state);
      }
      expect(await row(p)).toEqual(before);
      expect(await audits(p)).toEqual([]);
    });
  }

  it("the demo principal is refused 403 before any read; no row, no audit", async () => {
    const demo = demoPrincipal("the-demo-account");
    created.push(demo);
    const outcome = await store.grantPhotographer(operator, demo, null);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.status).toBe(403);
    expect(await row(demo)).toBeUndefined();
    expect(await audits(demo)).toEqual([]);
  });

  it("an admin actor is refused 403, even an active admin; nothing written", async () => {
    const admin = fresh();
    await seedRole(sql, admin, "admin", "active");
    const p = fresh();
    const outcome = await store.grantPhotographer({ kind: "admin", principal: admin }, p, null);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.status).toBe(403);
      expect(outcome.error.code).toBe("forbidden");
    }
    expect(await row(p)).toBeUndefined();
    expect(await audits(p)).toEqual([]);
  });
});
