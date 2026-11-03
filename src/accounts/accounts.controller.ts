import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { PipeTransform } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { Principal } from "../auth/firebase-auth.guard.js";
import { Roles } from "../auth/roles.js";
import { ApiError } from "../common/errors.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { ACCOUNT_ROLES, ROLE_STATES } from "../db/enums.js";
import type { AccountRole } from "../db/enums.js";
import { SkipClientVersion } from "../platform/client-version.js";
import { requireAccountPrincipal } from "./account-principal.js";
import { RoleStore } from "./role-store.js";
import { normalizeTypedEmail } from "./typed-email.js";
import type { Decision, RoleActor, RoleRow } from "./role-store.js";

// Every body and query below is strict: no role, state, principal or actor is ever read from a request body or query.
const emptyBody = z.strictObject({}).optional();
const emptyQuery = z.strictObject({});

// Control characters are refused (a NUL would be a Postgres error, not a 400).
const note = z.string().min(1).max(500).refine((s) => !/\p{Cc}/u.test(s));
const revisionField = z.int().min(1).max(2_147_483_647);
const decisionBody = z.strictObject({ revision: revisionField, note: note.optional() });
type DecisionBody = z.infer<typeof decisionBody>;
// The email is validated and normalised by normalizeTypedEmail (400 invalid_request); zod only bounds the raw string first.
const rawEmail = z.string().max(1000);
const grantBody = z.strictObject({ note: note.optional(), email: rawEmail.optional() });
type GrantBody = z.infer<typeof grantBody>;
const emailEditBody = z.strictObject({ revision: revisionField, email: rawEmail.nullable() });
type EmailEditBody = z.infer<typeof emailEditBody>;

export const QUEUE_DEFAULT_LIMIT = 50;
export const QUEUE_MAX_LIMIT = 100;
const queueQuery = z.strictObject({
  state: z.enum(ROLE_STATES).optional(),
  cursor: z.string().min(1).max(700).optional(),
  limit: z.string().regex(/^[0-9]{1,3}$/).optional(),
});
type QueueQuery = z.infer<typeof queueQuery>;

// PostgreSQL's text output of a timestamptz, e.g. `2026-11-03 12:00:00.123456+00`; the cursor carries it verbatim.
const PG_TIMESTAMPTZ = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?([+-])(\d{2})(?::(\d{2}))?$/;

/** True only for a real instant: the shape matches AND the calendar fields round-trip (so Feb 30, month 13, hour 25 or offset +99 are refused before the `::timestamptz` cast can throw). */
function isRealTimestamptz(value: string): boolean {
  const m = PG_TIMESTAMPTZ.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [m[1], m[2], m[3], m[4], m[5], m[6], m[8], m[9] ?? "0"].map(Number) as [
    number, number, number, number, number, number, number, number,
  ];
  if (year < 1 || hour > 23 || minute > 59 || second > 59 || offsetHour > 15 || offsetMinute > 59) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return (
    Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour
  );
}

const cursorPayload = z.tuple([
  z.string().refine(isRealTimestamptz),
  z.string().min(1).max(256),
  z.enum(ACCOUNT_ROLES),
]);

function encodeCursor(requestedKey: string, principal: string, role: AccountRole): string {
  return Buffer.from(JSON.stringify([requestedKey, principal, role]), "utf8").toString("base64url");
}

function decodeCursor(value: string): { requestedAt: string; principal: string; role: AccountRole } {
  const invalid = new ApiError(400, "invalid_request", "The cursor is not one this endpoint returned.");
  let parsed: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid;
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  const result = cursorPayload.safeParse(parsed);
  if (!result.success) throw invalid;
  return { requestedAt: result.data[0], principal: result.data[1], role: result.data[2] };
}

/** `{principal}` route parameter: URL-decoded by Express, then exactly `firebase:<configured project>:<uid>` (400 otherwise). */
@Injectable()
export class AccountPrincipalPipe implements PipeTransform<unknown, string> {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  transform(value: unknown): string {
    return requireAccountPrincipal(value, this.config.firebaseProjectId);
  }
}

/** What an account sees about its own role rows. */
function ownView(row: RoleRow) {
  return {
    role: row.role,
    state: row.state,
    revision: row.revision,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

/** What an admin sees. `decidedBy` is a principal (or `operator:` / `system:signup`); `requestEmail` is the photographer requester's verified email (null for other roles or once the account is deleted). */
function adminView(row: RoleRow) {
  return {
    principal: row.principal,
    role: row.role,
    state: row.state,
    revision: row.revision,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedBy: row.decidedBy,
    note: row.note,
    requestEmail: row.requestEmail,
    // The typed email of an admin row (unverified, display only), and the one `email` an admin screen shows with its source.
    grantEmail: row.grantEmail,
    email: row.grantEmail ?? row.requestEmail,
    emailSource: row.grantEmail !== null ? ("typed" as const) : row.requestEmail !== null ? ("verified_at_request" as const) : null,
  };
}

/** The signed-in account's own roles and its photographer request. Any signed-in caller (no @Roles). */
@Controller("v1/me/roles")
export class MyRolesController {
  constructor(private readonly roles: RoleStore) {}

  @Get()
  async mine(@Principal() principal: string, @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>) {
    return { roles: (await this.roles.rolesOf(principal)).map(ownView) };
  }

  /**
   * Ask for the `photographer` role. The role is fixed by the path; nothing in the body or query can name one. Needs a verified
   * email. 201 when a request was recorded (new, or after a rejection or revoke), 200 with the current row when one is already
   * pending or active (nothing changes). Creates no player row.
   */
  @Post("photographer")
  async requestPhotographer(
    @Principal() principal: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
    @Body(new ZodValidationPipe(emptyBody, "Expected no body.")) _body: undefined,
  ) {
    // Code points, like Postgres length() in the table's CHECK (String.length counts UTF-16 units and would let a short astral email through to a 500).
    const emailLength = typeof req.email === "string" ? [...req.email].length : 0;
    if (req.emailVerified !== true || typeof req.email !== "string" || emailLength < 3 || emailLength > 320) {
      throw new ApiError(403, "forbidden", "Requesting the photographer role needs a verified email.");
    }
    const outcome = await this.roles.requestPhotographer(principal, req.email);
    if (!outcome.ok) throw outcome.error;
    res.status(outcome.changed ? 201 : 200);
    return { role: ownView(outcome.row), changed: outcome.changed };
  }
}

/** Admin decisions about roles (Backend ADR-0002). Every route needs an active admin, re-checked under the role lock. */
@Roles("admin")
@SkipClientVersion()
@Controller("v1/admin")
export class AdminRolesController {
  constructor(private readonly roles: RoleStore) {}

  /** Role rows in one state (default `pending`), oldest request first, with an opaque cursor. */
  @Get("role-requests")
  async queue(@Query(new ZodValidationPipe(queueQuery, "Expected ?state=pending|active|rejected|revoked|blocked, ?cursor and ?limit (1-100).")) query: QueueQuery) {
    const limit = query.limit === undefined ? QUEUE_DEFAULT_LIMIT : Number(query.limit);
    if (limit < 1 || limit > QUEUE_MAX_LIMIT) throw new ApiError(400, "invalid_request", `limit must be 1 to ${QUEUE_MAX_LIMIT}.`);
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const page = await this.roles.queue({ state: query.state ?? "pending", limit, ...(after ? { after } : {}) });
    const last = page.rows[page.rows.length - 1];
    return {
      requests: page.rows.map(adminView),
      nextCursor: page.hasMore && last ? encodeCursor(last.requestedKey, last.principal, last.role) : null,
    };
  }

  @Post("accounts/:principal/roles/photographer/approve")
  @HttpCode(200)
  approve(
    @Principal() actor: string,
    @Param("principal", AccountPrincipalPipe) target: string,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
    @Body(new ZodValidationPipe(decisionBody, "Expected { revision: integer, note?: string } and nothing else.")) body: DecisionBody,
  ) {
    return this.decide(actor, target, "photographer", "approve", body);
  }

  @Post("accounts/:principal/roles/photographer/reject")
  @HttpCode(200)
  reject(
    @Principal() actor: string,
    @Param("principal", AccountPrincipalPipe) target: string,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
    @Body(new ZodValidationPipe(decisionBody, "Expected { revision: integer, note?: string } and nothing else.")) body: DecisionBody,
  ) {
    return this.decide(actor, target, "photographer", "reject", body);
  }

  /** Block a photographer row (any state but blocked) from the role. Fixed route: never the `:role` revoke route. */
  @Post("accounts/:principal/roles/photographer/block")
  @HttpCode(200)
  block(
    @Principal() actor: string,
    @Param("principal", AccountPrincipalPipe) target: string,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
    @Body(new ZodValidationPipe(decisionBody, "Expected { revision: integer, note?: string } and nothing else.")) body: DecisionBody,
  ) {
    return this.setBlocked(actor, target, "block", body);
  }

  /** Lift a block: `blocked` becomes `revoked`, so the account may request again. */
  @Post("accounts/:principal/roles/photographer/unblock")
  @HttpCode(200)
  unblock(
    @Principal() actor: string,
    @Param("principal", AccountPrincipalPipe) target: string,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
    @Body(new ZodValidationPipe(decisionBody, "Expected { revision: integer, note?: string } and nothing else.")) body: DecisionBody,
  ) {
    return this.setBlocked(actor, target, "unblock", body);
  }

  /** Revoke `photographer` or `admin` (self-revoke allowed while another admin remains). Any other role segment is 404. */
  @Post("accounts/:principal/roles/:role/revoke")
  @HttpCode(200)
  revoke(
    @Principal() actor: string,
    @Param("principal", AccountPrincipalPipe) target: string,
    @Param("role") role: string,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
    @Body(new ZodValidationPipe(decisionBody, "Expected { revision: integer, note?: string } and nothing else.")) body: DecisionBody,
  ) {
    if (role !== "photographer" && role !== "admin") throw new ApiError(404, "not_found", "No such endpoint.");
    return this.decide(actor, target, role, "revoke", body);
  }

  /** Grant `admin` (a missing or revoked admin row becomes active). Photographer always goes through request and approval. */
  @Post("accounts/:principal/roles/admin/grant")
  @HttpCode(200)
  async grant(
    @Principal() actor: string,
    @Param("principal", AccountPrincipalPipe) target: string,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
    @Body(new ZodValidationPipe(grantBody, "Expected { note?: string, email?: string } and nothing else.")) body: GrantBody,
  ) {
    const email = body.email === undefined ? null : normalizeTypedEmail(body.email);
    const outcome = await this.roles.grantAdmin(adminActor(actor), target, body.note ?? null, { email });
    if (!outcome.ok) throw outcome.error;
    return { role: adminView(outcome.row) };
  }

  /** Correct or clear the typed email of an admin row. Display only; unverified. */
  @Put("accounts/:principal/roles/admin/email")
  async editEmail(
    @Principal() actor: string,
    @Param("principal", AccountPrincipalPipe) target: string,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
    @Body(new ZodValidationPipe(emailEditBody, "Expected { revision: integer, email: string | null } and nothing else.")) body: EmailEditBody,
  ) {
    const email = body.email === null ? null : normalizeTypedEmail(body.email);
    const outcome = await this.roles.editAdminEmail(adminActor(actor), target, body.revision, email);
    if (!outcome.ok) throw outcome.error;
    return { role: adminView(outcome.row) };
  }

  private async setBlocked(actor: string, target: string, kind: "block" | "unblock", body: DecisionBody) {
    const outcome = await this.roles.setBlocked(adminActor(actor), target, kind, body.revision, body.note ?? null);
    if (!outcome.ok) throw outcome.error;
    return { role: adminView(outcome.row) };
  }

  private async decide(actor: string, target: string, role: AccountRole, decision: Decision, body: DecisionBody) {
    const outcome = await this.roles.decide(adminActor(actor), target, role, decision, body.revision, body.note ?? null);
    if (!outcome.ok) throw outcome.error;
    return { role: adminView(outcome.row) };
  }
}

const adminActor = (principal: string): RoleActor => ({ kind: "admin", principal });
