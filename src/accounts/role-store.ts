import { Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { ApiError } from "../common/errors.js";
import { DatabaseService } from "../database/database.module.js";
import type { Database, Tx } from "../database/database.module.js";
import { databaseNow } from "../database/clock.js";
import { ACCOUNT_ROLES } from "../db/enums.js";
import type { AccountRole, AdminAuditAction, RoleState } from "../db/enums.js";
import { accountRoles, adminAudit } from "../db/schema.js";

/**
 * The role store (Backend ADR-0002, plan R-b): every write to `account_roles`. One transaction-scoped advisory lock is taken
 * by EVERY role change (request, approve, reject, grant, revoke, signup `player`, the operator command), so the "at least one
 * active admin" rule and the acting admin's own standing are checked against the same state the write then changes. Each
 * transition is a conditional UPDATE fenced by state AND revision, bumps `revision`, stamps `decided_at` from the database
 * clock, and writes one `admin_audit` row in the same transaction. A refusal or a no-op writes nothing.
 */

export type RoleRow = typeof accountRoles.$inferSelect;
export type RoleSnapshot = { state: RoleState; revision: number };

/** Who changes the roles: an admin (re-checked under the lock) or the operator command (exempt, audited as `operator:<id>`). */
export type RoleActor = { kind: "admin"; principal: string } | { kind: "operator"; id: string };

const actorName = (actor: RoleActor): string => (actor.kind === "admin" ? actor.principal : `operator:${actor.id}`.slice(0, 256));

/** The signup actor of the `player` role. */
export const SIGNUP_ACTOR = "system:signup";

/** The decisions an admin can make about a photographer request or an active role. */
export type Decision = "approve" | "reject" | "revoke";

type Transition = { from: RoleState; to: RoleState; action: AdminAuditAction };

const TRANSITIONS: Record<Decision, Transition> = {
  approve: { from: "pending", to: "active", action: "role_approve" },
  reject: { from: "pending", to: "rejected", action: "role_reject" },
  revoke: { from: "active", to: "revoked", action: "role_revoke" },
};

/** Roles each decision may name: photographer for all three, `admin` for revoke only; `player` is never decided (user, 2026-11-03). */
const DECIDABLE: Record<Decision, readonly AccountRole[]> = {
  approve: ["photographer"],
  reject: ["photographer"],
  revoke: ["photographer", "admin"],
};

export type DecisionOutcome = { ok: true; row: RoleRow } | { ok: false; error: ApiError };
export type RequestOutcome = { ok: true; row: RoleRow; changed: boolean } | { ok: false; error: ApiError };

const blockedError = (): ApiError => new ApiError(403, "forbidden", "This account is blocked from the photographer role.");

const ADVISORY_LOCK = sql`SELECT pg_advisory_xact_lock(hashtextextended('account-roles', 0))`;

/** Takes the role lock for the rest of the transaction. Blocks (bounded by the pool's lock_timeout, a retryable 503) rather than failing. */
export async function lockAccountRoles(tx: Tx): Promise<void> {
  await tx.execute(ADVISORY_LOCK);
}

const snapshot = (row: RoleRow): RoleSnapshot => ({ state: row.state, revision: row.revision });

function conflict(role: AccountRole, current: RoleRow, wanted: string): ApiError {
  return new ApiError(
    409,
    "version_conflict",
    `The ${role} role is ${current.state} at revision ${current.revision}, so ${wanted}. Reload it and decide again. Nothing was changed.`,
  );
}

const notFound = (role: AccountRole): ApiError => new ApiError(404, "not_found", `There is no ${role} role row for that account.`);

type AuditInput = {
  actor: string;
  action: AdminAuditAction;
  principal: string;
  role: AccountRole;
  from: RoleSnapshot | null;
  to: RoleSnapshot;
  note: string | null;
  at: Date;
};

async function audit(tx: Tx, input: AuditInput): Promise<void> {
  await tx.insert(adminAudit).values({
    actor: input.actor,
    action: input.action,
    target: input.principal,
    detail: { role: input.role, from: input.from, to: input.to, note: input.note },
    createdAt: input.at,
  });
}

async function readRow(tx: Database | Tx, principal: string, role: AccountRole): Promise<RoleRow | undefined> {
  const [row] = await tx
    .select()
    .from(accountRoles)
    .where(and(eq(accountRoles.principal, principal), eq(accountRoles.role, role)));
  return row;
}

async function activeAdminCount(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(accountRoles)
    .where(and(eq(accountRoles.role, "admin"), eq(accountRoles.state, "active")));
  return row?.n ?? 0;
}

/** The acting admin must still hold an ACTIVE admin row now, under the lock. The operator is exempt. */
async function actorStillAdmin(tx: Tx, actor: RoleActor): Promise<boolean> {
  if (actor.kind === "operator") return true;
  return (await readRow(tx, actor.principal, "admin"))?.state === "active";
}

export type RoleQueueFilter = { state: RoleState; limit: number; after?: { requestedAt: string; principal: string; role: AccountRole } };
export type RoleQueuePage = { rows: (RoleRow & { requestedKey: string })[]; hasMore: boolean };

@Injectable()
export class RoleStore {
  constructor(private readonly database: DatabaseService) {}

  /** The caller's own rows, in ACCOUNT_ROLES order. */
  async rolesOf(principal: string): Promise<RoleRow[]> {
    const rows = await this.database.db.select().from(accountRoles).where(eq(accountRoles.principal, principal));
    return [...rows].sort((a, b) => ACCOUNT_ROLES.indexOf(a.role) - ACCOUNT_ROLES.indexOf(b.role));
  }

  /**
   * Issue `player` at signup: INSERT ... ON CONFLICT DO NOTHING under the role lock, in its own short transaction (run after
   * PlayerBalance.open). One `role_grant` audit row only when a row was inserted; an existing row, a revoked one included,
   * is never touched. Returns whether a row was inserted.
   */
  async issuePlayer(principal: string): Promise<boolean> {
    // A cheap read first: after the first sign-in every later one finds the row and never takes the global lock.
    if (await readRow(this.database.db, principal, "player")) return false;
    return this.database.withTransaction(async (tx) => {
      await lockAccountRoles(tx);
      const at = await databaseNow(tx);
      const inserted = await tx
        .insert(accountRoles)
        .values({ principal, role: "player", state: "active", requestedAt: at, decidedAt: at, decidedBy: SIGNUP_ACTOR })
        .onConflictDoNothing()
        .returning();
      const row = inserted[0];
      if (!row) return false;
      await audit(tx, {
        actor: SIGNUP_ACTOR,
        action: "role_grant",
        principal,
        role: "player",
        from: null,
        to: snapshot(row),
        note: null,
        at,
      });
      return true;
    });
  }

  /**
   * The account asks for `photographer`, storing its verified token `email` for admins (never for authorisation). Only a missing, `rejected` or `revoked` row becomes `pending` (a new row, or the
   * same row at revision + 1 with the previous decision cleared); a pending or active row is never touched: that is a no-op
   * returning the current row. Audit `role_request` (actor = the account) only when a row changed.
   */
  async requestPhotographer(principal: string, email: string): Promise<RequestOutcome> {
    // Unlocked pre-read, as in issuePlayer: pending and active rows only leave under an admin decision, so a stale read of
    // either is harmless and a repeat request never takes the global lock.
    // A `blocked` row is deliberately NOT short-circuited: it is refused under the lock, where a block landing between this
    // read and the lock is seen too.
    const existing = await readRow(this.database.db, principal, "photographer");
    if (existing && (existing.state === "pending" || existing.state === "active")) return { ok: true, row: existing, changed: false };
    return this.database.withTransaction(async (tx): Promise<RequestOutcome> => {
      await lockAccountRoles(tx);
      const at = await databaseNow(tx);
      const before = await readRow(tx, principal, "photographer");
      if (before?.state === "blocked") return { ok: false, error: blockedError() };
      const [row] = await tx
        .insert(accountRoles)
        .values({ principal, role: "photographer", state: "pending", requestedAt: at, requestEmail: email })
        .onConflictDoUpdate({
          target: [accountRoles.principal, accountRoles.role],
          set: {
            state: "pending",
            requestedAt: at,
            requestEmail: email,
            decidedAt: null,
            decidedBy: null,
            note: null,
            revision: sql`${accountRoles.revision} + 1`,
          },
          setWhere: inArray(accountRoles.state, ["rejected", "revoked"]),
        })
        .returning();
      if (!row) {
        const current = await readRow(tx, principal, "photographer");
        if (!current) throw new Error("Role row missing after a no-op request.");
        if (current.state === "blocked") return { ok: false, error: blockedError() }; // defensive: the lock makes this unreachable
        return { ok: true, row: current, changed: false };
      }
      await audit(tx, {
        actor: principal,
        action: "role_request",
        principal,
        role: "photographer",
        from: before ? snapshot(before) : null,
        to: snapshot(row),
        note: null,
        at,
      });
      return { ok: true, row, changed: true };
    });
  }

  /**
   * Approve, reject or revoke `role` of `principal` at `revision`. The legal transitions only (see TRANSITIONS); anything else,
   * a stale revision included, is 409 `version_conflict` naming the current state and revision; no row is 404. Revoking the
   * last active admin is refused. The acting admin is re-checked under the lock (403 `forbidden`, nothing written).
   */
  async decide(actor: RoleActor, principal: string, role: AccountRole, decision: Decision, revision: number, note: string | null): Promise<DecisionOutcome> {
    const transition = TRANSITIONS[decision];
    if (!DECIDABLE[decision].includes(role)) {
      return { ok: false, error: new ApiError(404, "not_found", "No such endpoint.") };
    }
    return this.database.withTransaction(async (tx): Promise<DecisionOutcome> => {
      await lockAccountRoles(tx);
      if (!(await actorStillAdmin(tx, actor))) {
        return { ok: false, error: new ApiError(403, "forbidden", "Requires the admin role.") };
      }
      const at = await databaseNow(tx);
      const current = await readRow(tx, principal, role);
      if (!current) return { ok: false, error: notFound(role) };
      const wanted = `it cannot be ${decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "revoked"} (needs ${transition.from} at revision ${revision})`;
      if (current.state !== transition.from || current.revision !== revision) {
        return { ok: false, error: conflict(role, current, wanted) };
      }
      if (role === "admin" && decision === "revoke" && (await activeAdminCount(tx)) < 2) {
        return {
          ok: false,
          error: new ApiError(
            409,
            "version_conflict",
            "Revoking this admin would leave no active admin; grant admin to someone else first. Nothing was changed.",
          ),
        };
      }
      const [row] = await tx
        .update(accountRoles)
        .set({ state: transition.to, decidedAt: at, decidedBy: actorName(actor), note, revision: sql`${accountRoles.revision} + 1` })
        .where(
          and(
            eq(accountRoles.principal, principal),
            eq(accountRoles.role, role),
            eq(accountRoles.state, transition.from),
            eq(accountRoles.revision, revision),
          ),
        )
        .returning();
      if (!row) throw new Error("Role update was not stored."); // the lock makes this unreachable
      await audit(tx, { actor: actorName(actor), action: transition.action, principal, role, from: snapshot(current), to: snapshot(row), note, at });
      return { ok: true, row };
    });
  }

  /**
   * Grant `admin` (an admin, or the operator command). A missing row is inserted `active`; a `revoked` row becomes `active`
   * (updated, never a second insert, revision + 1). An active, pending or rejected row is 409 `version_conflict`, and so is an
   * account whose photographer row is `blocked` (block and admin stay apart, plan R-d). `options.email` is the TYPED, already
   * normalised email: inserted as given; a re-grant replaces it when given and keeps the stored one otherwise.
   */
  async grantAdmin(
    actor: RoleActor,
    principal: string,
    note: string | null,
    options?: { onlyIfNoActiveAdmin?: boolean; email?: string | null },
  ): Promise<DecisionOutcome> {
    return this.database.withTransaction(async (tx): Promise<DecisionOutcome> => {
      await lockAccountRoles(tx);
      if (!(await actorStillAdmin(tx, actor))) {
        return { ok: false, error: new ApiError(403, "forbidden", "Requires the admin role.") };
      }
      // The operator command (first admin / recovery) passes this: checked under the same lock as the write.
      if (options?.onlyIfNoActiveAdmin && (await activeAdminCount(tx)) > 0) {
        return {
          ok: false,
          error: new ApiError(409, "version_conflict", "An active admin already exists; grant admin through the admin API. Nothing was changed."),
        };
      }
      if ((await readRow(tx, principal, "photographer"))?.state === "blocked") {
        return {
          ok: false,
          error: new ApiError(
            409,
            "version_conflict",
            "This account is blocked from the photographer role, so it cannot be made admin; unblock it first. Nothing was changed.",
          ),
        };
      }
      const at = await databaseNow(tx);
      const before = await readRow(tx, principal, "admin");
      const by = actorName(actor);
      const typedEmail = options?.email ?? null;
      const [row] = await tx
        .insert(accountRoles)
        .values({ principal, role: "admin", state: "active", requestedAt: at, decidedAt: at, decidedBy: by, note, grantEmail: typedEmail })
        .onConflictDoUpdate({
          target: [accountRoles.principal, accountRoles.role],
          set: {
            state: "active",
            decidedAt: at,
            decidedBy: by,
            note,
            ...(typedEmail === null ? {} : { grantEmail: typedEmail }),
            revision: sql`${accountRoles.revision} + 1`,
          },
          setWhere: eq(accountRoles.state, "revoked"),
        })
        .returning();
      if (!row) {
        const current = await readRow(tx, principal, "admin");
        if (!current) throw new Error("Role row missing after a refused grant.");
        return { ok: false, error: conflict("admin", current, "it cannot be granted (only a missing or revoked admin row can be)") };
      }
      await audit(tx, { actor: by, action: "role_grant", principal, role: "admin", from: before ? snapshot(before) : null, to: snapshot(row), note, at });
      return { ok: true, row };
    });
  }

  /**
   * Block (a `pending`, `active`, `rejected` or `revoked` photographer row becomes `blocked`) or unblock (`blocked` becomes
   * `revoked`, so the account may request again; it was not necessarily ever approved). Photographer only and never through
   * `decide`, so the last-admin invariant cannot be touched. An account with an ACTIVE admin row cannot be blocked (409:
   * revoke admin first). Same lock, actor re-check, state-and-revision fence, 404/409 rules and audit shape as `decide`.
   */
  async setBlocked(actor: RoleActor, principal: string, kind: "block" | "unblock", revision: number, note: string | null): Promise<DecisionOutcome> {
    const blocking = kind === "block";
    return this.database.withTransaction(async (tx): Promise<DecisionOutcome> => {
      await lockAccountRoles(tx);
      if (!(await actorStillAdmin(tx, actor))) {
        return { ok: false, error: new ApiError(403, "forbidden", "Requires the admin role.") };
      }
      const at = await databaseNow(tx);
      const current = await readRow(tx, principal, "photographer");
      if (!current) return { ok: false, error: notFound("photographer") };
      const stateOk = blocking ? current.state !== "blocked" : current.state === "blocked";
      if (!stateOk || current.revision !== revision) {
        const wanted = blocking
          ? `it cannot be blocked (needs a state other than blocked at revision ${revision})`
          : `it cannot be unblocked (needs blocked at revision ${revision})`;
        return { ok: false, error: conflict("photographer", current, wanted) };
      }
      if (blocking && (await readRow(tx, principal, "admin"))?.state === "active") {
        return {
          ok: false,
          error: new ApiError(
            409,
            "version_conflict",
            "This account is an active admin, so it cannot be blocked from the photographer role; revoke admin first. Nothing was changed.",
          ),
        };
      }
      const [row] = await tx
        .update(accountRoles)
        .set({ state: blocking ? "blocked" : "revoked", decidedAt: at, decidedBy: actorName(actor), note, revision: sql`${accountRoles.revision} + 1` })
        .where(
          and(
            eq(accountRoles.principal, principal),
            eq(accountRoles.role, "photographer"),
            eq(accountRoles.state, current.state),
            eq(accountRoles.revision, revision),
          ),
        )
        .returning();
      if (!row) throw new Error("Role update was not stored."); // the lock makes this unreachable
      await audit(tx, {
        actor: actorName(actor),
        action: blocking ? "role_block" : "role_unblock",
        principal,
        role: "photographer",
        from: snapshot(current),
        to: snapshot(row),
        note,
        at,
      });
      return { ok: true, row };
    });
  }

  /**
   * Correct (or clear, with null) the typed email of an `active` or `revoked` admin row. Display only; revision-fenced; bumps
   * `revision`; an unchanged value is a no-op returning the current row (nothing written, no audit). The audit row says
   * `emailChanged: true` and never carries an email.
   */
  async editAdminEmail(actor: RoleActor, principal: string, revision: number, email: string | null): Promise<DecisionOutcome> {
    return this.database.withTransaction(async (tx): Promise<DecisionOutcome> => {
      await lockAccountRoles(tx);
      if (!(await actorStillAdmin(tx, actor))) {
        return { ok: false, error: new ApiError(403, "forbidden", "Requires the admin role.") };
      }
      const at = await databaseNow(tx);
      const current = await readRow(tx, principal, "admin");
      if (!current) return { ok: false, error: notFound("admin") };
      if ((current.state !== "active" && current.state !== "revoked") || current.revision !== revision) {
        return { ok: false, error: conflict("admin", current, `its email cannot be edited (needs active or revoked at revision ${revision})`) };
      }
      if (current.grantEmail === email) return { ok: true, row: current };
      const [row] = await tx
        .update(accountRoles)
        .set({ grantEmail: email, revision: sql`${accountRoles.revision} + 1` })
        .where(
          and(
            eq(accountRoles.principal, principal),
            eq(accountRoles.role, "admin"),
            eq(accountRoles.state, current.state),
            eq(accountRoles.revision, revision),
          ),
        )
        .returning();
      if (!row) throw new Error("Role update was not stored."); // the lock makes this unreachable
      await tx.insert(adminAudit).values({
        actor: actorName(actor),
        action: "role_email_edit",
        target: principal,
        detail: { role: "admin", from: snapshot(current), to: snapshot(row), emailChanged: true },
        createdAt: at,
      });
      return { ok: true, row };
    });
  }

  /**
   * Account deletion: clear the emails kept on role rows (a photographer's request email, an admin's typed email). Role rows and
   * audit rows stay (ADR-0002, decision 1); no state or revision changes, so this is not a role change and takes no role lock.
   * Idempotent.
   */
  async clearEmails(principal: string): Promise<void> {
    await this.database.db
      .update(accountRoles)
      .set({ requestEmail: null, grantEmail: null })
      .where(and(eq(accountRoles.principal, principal), or(isNotNull(accountRoles.requestEmail), isNotNull(accountRoles.grantEmail))));
  }

  /** The admin queue, oldest request first (requested_at, principal, role). Reads `limit + 1` rows to know whether more follow. */
  async queue(filter: RoleQueueFilter): Promise<RoleQueuePage> {
    const { state, limit, after } = filter;
    const rows = await this.database.db
      .select({ row: accountRoles, requestedKey: sql<string>`${accountRoles.requestedAt}::text` })
      .from(accountRoles)
      .where(
        and(
          eq(accountRoles.state, state),
          inArray(accountRoles.role, ["photographer", "admin"]),
          after
            ? sql`(${accountRoles.requestedAt}, ${accountRoles.principal}, ${accountRoles.role}) > (${after.requestedAt}::timestamptz, ${after.principal}, ${after.role})`
            : undefined,
        ),
      )
      .orderBy(asc(accountRoles.requestedAt), asc(accountRoles.principal), asc(accountRoles.role))
      .limit(limit + 1);
    const page = rows.slice(0, limit).map((r) => ({ ...r.row, requestedKey: r.requestedKey }));
    return { rows: page, hasMore: rows.length > limit };
  }
}
