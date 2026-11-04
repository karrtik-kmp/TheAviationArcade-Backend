import { Inject, Injectable, SetMetadata, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Request } from "express";
import { isDemoPrincipal } from "../accounts/account-principal.js";
import { ApiError } from "../common/errors.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { DatabaseService } from "../database/database.module.js";
import { ACCOUNT_ROLES } from "../db/enums.js";
import type { AccountRole } from "../db/enums.js";
import { accountRoles } from "../db/schema.js";

/**
 * Role-based access (Backend ADR-0002). Privilege comes ONLY from an `active` row in `account_roles` for the verified
 * principal. No environment list, email, header, query or body field grants anything.
 */

const ROLES_KEY = "requiredRoles";

/** Roles that also need `email_verified === true` (and an email claim) in the verified token. */
const VERIFIED_EMAIL_ROLES: ReadonlySet<AccountRole> = new Set(["photographer", "admin"]);

/**
 * Marks a route (or controller) as needing at least ONE of `roles` (any-of). Enforced by RolesGuard, after
 * authentication and the rate limit. `admin` satisfies `photographer`.
 */
export const Roles = (...roles: AccountRole[]): ClassDecorator & MethodDecorator => {
  if (roles.length === 0) throw new Error("@Roles() needs at least one role.");
  for (const role of roles) if (!ACCOUNT_ROLES.includes(role)) throw new Error(`@Roles(): unknown role "${String(role)}".`);
  return SetMetadata(ROLES_KEY, Object.freeze([...roles]));
};

/** The roles a route requires, method metadata first, then the controller's. Undefined = no role rule. */
export function requiredRoles(reflector: Reflector, context: ExecutionContext): readonly AccountRole[] | undefined {
  return reflector.getAllAndOverride<readonly AccountRole[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
}

/** The caller's verified token facts the role rule needs. */
export type VerifiedCaller = { emailVerified: boolean | undefined; email: string | undefined };

/** Whether an ACTIVE role list holds `role`: exactly, or `admin` for `photographer` (ADR-0002, decision 3). */
function holds(active: readonly AccountRole[], role: AccountRole): boolean {
  return active.includes(role) || (role === "photographer" && active.includes("admin"));
}

/**
 * Pure rule: does a caller with these ACTIVE roles and this verified token satisfy any of `required`? A photographer or
 * admin requirement also needs `email_verified === true` and an email claim. An empty `required` never passes (a route
 * cannot be "role-protected" by nothing).
 */
export function satisfiesRoles(required: readonly AccountRole[], active: readonly AccountRole[], caller: VerifiedCaller): boolean {
  const verifiedEmail = caller.emailVerified === true && typeof caller.email === "string" && caller.email.length > 0;
  return required.some((role) => holds(active, role) && (!VERIFIED_EMAIL_ROLES.has(role) || verifiedEmail));
}

/** 403 for a signed-in caller without the role. Same shape everywhere (guard and the pre-auth body readers). */
export function forbidden(required: readonly AccountRole[]): ApiError {
  return new ApiError(403, "forbidden", `Requires the ${required.join(" or ")} role.`);
}

/** Reads the caller's roles. One indexed query (the primary key starts with principal); never cached. */
@Injectable()
export class RolesService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, "demoPrincipal">,
  ) {}

  /** ACTIVE roles of exactly this principal, in ACCOUNT_ROLES order. An unknown value (impossible under the CHECK) is dropped. */
  async activeRoles(principal: string): Promise<AccountRole[]> {
    const rows = await this.database.db
      .select({ role: accountRoles.role })
      .from(accountRoles)
      .where(and(eq(accountRoles.principal, principal), eq(accountRoles.state, "active")));
    const found = new Set(rows.map((row) => row.role));
    return ACCOUNT_ROLES.filter((role) => found.has(role));
  }

  /** Load the roles, record them on the request and enforce `required`. Throws 403 `forbidden`. */
  async authorize(req: Request, required: readonly AccountRole[]): Promise<readonly AccountRole[]> {
    // A role route behind @Public() has no verified principal: refuse rather than guess.
    if (!req.principal) throw forbidden(required);
    const rows = await this.activeRoles(req.principal);
    // The shared demo account holds no privileged role whatever the table says (ADR-0002 follow-up, incident 2026-11-04).
    const active = isDemoPrincipal(this.config, req.principal) ? rows.filter((role) => !VERIFIED_EMAIL_ROLES.has(role)) : rows;
    req.roles = active;
    if (!satisfiesRoles(required, active, { emailVerified: req.emailVerified, email: req.email })) throw forbidden(required);
    return active;
  }
}

/**
 * Registered globally (APP_GUARD) after FirebaseAuthGuard and RateLimitGuard, so a missing or invalid token is 401 first
 * and a refused caller still counts against the rate limit. Routes without @Roles() pass untouched and cost no query.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly roles: RolesService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = requiredRoles(this.reflector, context);
    if (!required) return true;
    await this.roles.authorize(context.switchToHttp().getRequest<Request>(), required);
    return true;
  }
}

/** The caller's ACTIVE roles as RolesGuard read them for this request. Only valid on a @Roles() route. */
export const CallerRoles = createParamDecorator((_data: unknown, context: ExecutionContext): readonly AccountRole[] => {
  const roles = context.switchToHttp().getRequest<Request>().roles;
  if (!roles) throw new Error("CallerRoles read on a route without @Roles().");
  return roles;
});
