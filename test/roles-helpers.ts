import type pg from "pg";
import type { AccountRole, RoleState } from "../src/db/enums.js";

// e2e helper (Backend ADR-0002): seed account_roles rows directly in the test database. Privilege in tests comes from these rows
// only, never from an environment list. The e2e database is shared across files and runs, so seeding is an upsert.

export const DEMO_PREFIX = "firebase:demo-airplane-games:";

/** The principal of an emulator token minted for `uid` in the demo project (test/tokens.ts). */
export const demoPrincipal = (uid: string): string => `${DEMO_PREFIX}${uid}`;

/** Insert or overwrite the (principal, role) row with `state`. Non-pending rows get decided_at and decided_by (the table requires both). */
export async function seedRole(sql: pg.Pool | pg.Client, principal: string, role: AccountRole, state: RoleState = "active"): Promise<void> {
  const decided = state !== "pending";
  await sql.query(
    `INSERT INTO account_roles (principal, role, state, requested_at, decided_at, decided_by)
     VALUES ($1, $2, $3, now(), CASE WHEN $4::boolean THEN now() END, CASE WHEN $4::boolean THEN 'test:seed' END)
     ON CONFLICT (principal, role) DO UPDATE SET state = EXCLUDED.state, decided_at = EXCLUDED.decided_at, decided_by = EXCLUDED.decided_by`,
    [principal, role, state, decided],
  );
}

/** Active admin for each demo uid (the admin e2e suites use "staff" and "second"). */
export async function seedAdmins(sql: pg.Pool | pg.Client, ...uids: string[]): Promise<void> {
  for (const uid of uids) await seedRole(sql, demoPrincipal(uid), "admin");
}

/** Remove every role row of these principals. */
export async function clearRoles(sql: pg.Pool | pg.Client, ...principals: string[]): Promise<void> {
  await sql.query("DELETE FROM account_roles WHERE principal = ANY($1::text[])", [principals]);
}
