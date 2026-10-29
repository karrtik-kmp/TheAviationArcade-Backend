import { Inject, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { ApiError } from "../common/errors.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";

const STAFF_ONLY = "staffOnly";

/** Marks a route (or controller) as staff-only. Enforced by StaffGuard, after authentication. */
export const StaffOnly = (): ClassDecorator & MethodDecorator => SetMetadata(STAFF_ONLY, true);

/**
 * Staff = a verified token email that is in the server-side allowlist (same rule as the website).
 * Case-insensitive match. A client-supplied role, name or unverified email never counts, and the
 * allowlist comes from server configuration only.
 */
export function isStaff(email: string | undefined, emailVerified: boolean | undefined, allowlist: readonly string[]): boolean {
  if (emailVerified !== true || typeof email !== "string") return false;
  return allowlist.includes(email.trim().toLowerCase());
}

/**
 * Registered globally (APP_GUARD) after FirebaseAuthGuard, so a missing or invalid token is still 401
 * first. Routes without @StaffOnly() pass untouched. A staff caller needs no player row.
 */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const staffOnly = this.reflector.getAllAndOverride<boolean | undefined>(STAFF_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!staffOnly) return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (!isStaff(req.email, req.emailVerified, this.config.staffEmails)) {
      throw new ApiError(403, "forbidden", "Staff only.");
    }
    return true;
  }
}
