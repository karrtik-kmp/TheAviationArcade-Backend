import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { and, asc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { ApiError } from "../common/errors.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { demoAccountError, isDemoPrincipal, uidOfAccountPrincipal } from "./account-principal.js";
import { FIREBASE_ACCOUNTS, firebaseAccountsFor } from "./firebase-accounts.js";
import type { EmailVerification, FirebaseAccounts } from "./firebase-accounts.js";
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

export type GrantOutcome = { ok: true; row: RoleRow; changed: boolean } | { ok: false; error: ApiError };

/** An admin grant also reports what happened to the account's Firebase email (ADR-0002 follow-up 2026-11-19). */
export type GrantAdminOutcome = { ok: true; row: RoleRow; emailVerification: EmailVerification } | { ok: false; error: ApiError };

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

function firebaseUnavailable(kind: "unavailable" | "not_configured"): ApiError {
  return new ApiError(
    503,
    "service_unavailable",
    kind === "not_configured"
      ? "Granting admin needs Firebase admin access, which this backend does not have configured. Nothing was changed."
      : "Firebase could not mark the account's email verified, so admin was not granted. Try again later. Nothing was changed.",
    { "Retry-After": kind === "not_configured" ? "60" : "5" },
  );
}

/** The admin grant's refusal for each Firebase outcome other than ok. Nothing is written in any of them. */
function firebaseRefusal(kind: "not_found" | "disabled" | "email_mismatch" | "unavailable" | "not_configured"): ApiError {
  switch (kind) {
    case "not_found":
      return new ApiError(404, "not_found", "There is no Firebase account with that uid in this project. Nothing was changed.");
    case "disabled":
      return new ApiError(409, "account_disabled", "This Firebase account is disabled, so it cannot be made admin. Nothing was changed.");
    case "email_mismatch":
      return new ApiError(
        409,
        "account_email_mismatch",
        "The email you typed is not this account's sign-in email, so admin was not granted. Check the address with the account's owner, or grant without an email. Nothing was changed.",
      );
    default:
      return firebaseUnavailable(kind);
  }
}

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

/** Active admins, not counting the shared demo account's row: it holds no real privilege, so it never keeps "an admin" alive. */
async function activeAdminCount(tx: Database | Tx, demoPrincipal?: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(accountRoles)
    .where(
      and(
        eq(accountRoles.role, "admin"),
        eq(accountRoles.state, "active"),
        demoPrincipal === undefined ? undefined : ne(accountRoles.principal, demoPrincipal),
      ),
    );
  return row?.n ?? 0;
}

/** The acting admin must still hold an ACTIVE admin row now, under the lock. The operator is exempt. */
async function actorStillAdmin(tx: Database | Tx, actor: RoleActor): Promise<boolean> {
  if (actor.kind === "operator") return true;
  return (await readRow(tx, actor.principal, "admin"))?.state === "active";
}

/**
 * Every reason the role state refuses an admin grant, in one place. It runs once without the lock before Firebase is contacted (so a
 * grant that would be refused never touches the account) and again under the role lock before the write.
 */
async function adminGrantRefusal(
  tx: Database | Tx,
  actor: RoleActor,
  principal: string,
  demoPrincipal: string | undefined,
  onlyIfNoActiveAdmin: boolean,
): Promise<ApiError | undefined> {
  if (!(await actorStillAdmin(tx, actor))) return new ApiError(403, "forbidden", "Requires the admin role.");
  // The operator command (first admin / recovery) passes onlyIfNoActiveAdmin.
  if (onlyIfNoActiveAdmin && (await activeAdminCount(tx, demoPrincipal)) > 0) {
    return new ApiError(409, "version_conflict", "An active admin already exists; grant admin through the admin API. Nothing was changed.");
  }
  if ((await readRow(tx, principal, "photographer"))?.state === "blocked") {
    return new ApiError(
      409,
      "version_conflict",
      "This account is blocked from the photographer role, so it cannot be made admin; unblock it first. Nothing was changed.",
    );
  }
  const current = await readRow(tx, principal, "admin");
  if (current && current.state !== "revoked") {
    return conflict("admin", current, "it cannot be granted (only a missing or revoked admin row can be)");
  }
  return undefined;
}

export type RoleQueueFilter = { state: RoleState; limit: number; after?: { requestedAt: string; principal: string; role: AccountRole } };
export type RoleQueuePage = { rows: (RoleRow & { requestedKey: string })[]; hasMore: boolean };

@Injectable()
export class RoleStore {
  private readonly logger = new Logger("RoleStore");
  private readonly accounts: FirebaseAccounts;

  /**
   * Only `grantAdmin` needs `config.firebaseProjectId` and `accounts`; without them an admin grant answers 503, so scripts and tests
   * that never grant admin may leave them out.
   */
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, "demoPrincipal"> & Partial<Pick<AppConfig, "firebaseProjectId">>,
    @Optional() @Inject(FIREBASE_ACCOUNTS) accounts?: FirebaseAccounts,
  ) {
    this.accounts = accounts ?? firebaseAccountsFor(undefined);
  }

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
    // The shared demo account never holds a staff role: refused before any read or write.
    if (isDemoPrincipal(this.config, principal)) return { ok: false, error: demoAccountError() };
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
    // Approving would make the shared demo account a photographer. Reject, revoke and (via setBlocked) block stay allowed for cleanup.
    if (decision === "approve" && isDemoPrincipal(this.config, principal)) return { ok: false, error: demoAccountError() };
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
      if (role === "admin" && decision === "revoke" && (await activeAdminCount(tx, this.config.demoPrincipal)) < 2) {
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
   *
   * The grant also marks the account's Firebase email verified (ADR-0002 follow-up 2026-11-19), by the uid of a principal of the
   * configured project only, never by email. Order: every role-state refusal is checked first without the lock, then Firebase, then
   * the locked transaction checks again and writes. Firebase is never called under the role lock (first sign-ups take it too). If
   * Firebase refuses or cannot be reached, nothing is written (404 no such account, 503 unavailable or not configured). A typed email
   * that is not the account's Firebase email is 409 `account_email_mismatch` (the admin must name the address they vouch for), a
   * disabled account 409 `account_disabled`. An account without an email is granted and reported `no_email`. If the role state
   * changes between the first check and the lock, the email stays verified and the grant is refused (logged): an admin vouched for it.
   */
  async grantAdmin(
    actor: RoleActor,
    principal: string,
    note: string | null,
    options?: { onlyIfNoActiveAdmin?: boolean; email?: string | null },
  ): Promise<GrantAdminOutcome> {
    // The shared demo account never becomes admin, whoever asks (API admin or operator command): refused before any write.
    if (isDemoPrincipal(this.config, principal)) return { ok: false, error: demoAccountError() };
    const projectId = this.config.firebaseProjectId;
    if (projectId === undefined) return { ok: false, error: firebaseUnavailable("not_configured") };
    const uid = uidOfAccountPrincipal(principal, projectId);
    if (uid === undefined) {
      return { ok: false, error: new ApiError(400, "invalid_request", `Expected a principal of the form firebase:${projectId}:<uid>.`) };
    }
    const onlyIfNoActiveAdmin = options?.onlyIfNoActiveAdmin === true;
    const early = await adminGrantRefusal(this.database.db, actor, principal, this.config.demoPrincipal, onlyIfNoActiveAdmin);
    if (early) return { ok: false, error: early };

    const typedEmail = options?.email ?? null;
    const firebase = await this.accounts.ensureEmailVerified(uid, typedEmail);
    if (firebase.kind !== "ok") return { ok: false, error: firebaseRefusal(firebase.kind) };
    const { emailVerification } = firebase;

    const outcome = await this.database.withTransaction(async (tx): Promise<DecisionOutcome> => {
      await lockAccountRoles(tx);
      const refusal = await adminGrantRefusal(tx, actor, principal, this.config.demoPrincipal, onlyIfNoActiveAdmin);
      if (refusal) return { ok: false, error: refusal };
      const at = await databaseNow(tx);
      const before = await readRow(tx, principal, "admin");
      const by = actorName(actor);
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
      if (!row) throw new Error("Admin grant was not stored."); // the lock and the re-check make this unreachable
      // No email in the audit row: only whether the account's email is verified after the grant, and how.
      await tx.insert(adminAudit).values({
        actor: by,
        action: "role_grant",
        target: principal,
        detail: {
          role: "admin",
          from: before ? snapshot(before) : null,
          to: snapshot(row),
          note,
          emailVerifiedAtGrant: emailVerification !== "no_email",
          emailVerification,
        },
        createdAt: at,
      });
      return { ok: true, row };
    });
    if (!outcome.ok) {
      if (emailVerification === "verified") {
        this.logger.warn(`admin grant refused under the role lock after Firebase marked the email verified (status=${outcome.error.status}); the email stays verified`);
      }
      return outcome;
    }
    return { ok: true, row: outcome.row, emailVerification };
  }

  /**
   * Operator-only grant of `photographer` by Firebase UID (user ruling 2026-11-16, ADR-0002 follow-up; the dev demo seed). An
   * `admin` actor is refused 403: the API keeps request + approve. Only from NO row (inserted `active`) or `pending` (becomes
   * `active`, revision + 1, `requestEmail` kept). `active` is a no-op (`changed: false`, nothing written). `rejected`, `revoked`
   * and `blocked` mean an admin decided this: 409, nothing written, so a re-run never overturns a staff decision. The demo
   * principal is refused before any read. One `role_grant` audit row per change, actor `operator:<id>`.
   */
  async grantPhotographer(actor: RoleActor, principal: string, note: string | null): Promise<GrantOutcome> {
    if (actor.kind !== "operator") {
      return { ok: false, error: new ApiError(403, "forbidden", "Only the operator command grants photographer directly; admins approve a request. Nothing was changed.") };
    }
    if (isDemoPrincipal(this.config, principal)) return { ok: false, error: demoAccountError() };
    return this.database.withTransaction(async (tx): Promise<GrantOutcome> => {
      await lockAccountRoles(tx);
      const at = await databaseNow(tx);
      const by = actorName(actor);
      const before = await readRow(tx, principal, "photographer");
      if (before?.state === "active") return { ok: true, row: before, changed: false };
      if (before && before.state !== "pending") {
        return {
          ok: false,
          error: new ApiError(
            409,
            "version_conflict",
            `The photographer role is ${before.state} at revision ${before.revision}: an admin decided this, so it must be decided again in the Admin. Nothing was changed.`,
          ),
        };
      }
      let row: RoleRow | undefined;
      if (!before) {
        [row] = await tx
          .insert(accountRoles)
          .values({ principal, role: "photographer", state: "active", requestedAt: at, decidedAt: at, decidedBy: by, note })
          .returning();
      } else {
        [row] = await tx
          .update(accountRoles)
          .set({ state: "active", decidedAt: at, decidedBy: by, note, revision: sql`${accountRoles.revision} + 1` })
          .where(
            and(
              eq(accountRoles.principal, principal),
              eq(accountRoles.role, "photographer"),
              eq(accountRoles.state, "pending"),
              eq(accountRoles.revision, before.revision),
            ),
          )
          .returning();
      }
      if (!row) throw new Error("Role grant was not stored."); // the lock makes this unreachable
      await audit(tx, { actor: by, action: "role_grant", principal, role: "photographer", from: before ? snapshot(before) : null, to: snapshot(row), note, at });
      return { ok: true, row, changed: true };
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
