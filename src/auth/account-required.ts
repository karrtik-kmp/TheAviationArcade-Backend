import { Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { ApiError } from "../common/errors.js";

const ACCOUNT_REQUIRED = "accountRequired";

/**
 * Marks a route a Firebase Anonymous guest may not use (docs/plans/guest-callsign.md G4; user ruling 2026-11-26 "guests cannot
 * buy"): purchases, the Miles shop and the photographer role. The guest links the account in the app first (the uid stays).
 */
export const AccountRequired = (): ClassDecorator & MethodDecorator => SetMetadata(ACCOUNT_REQUIRED, true);

/** The 403 a guest gets on an @AccountRequired() route. */
export function accountRequired(): ApiError {
  return new ApiError(403, "account_required", "Save your progress with an email or Google account first.");
}

/**
 * Registered globally (APP_GUARD) after FirebaseAuthGuard and RateLimitGuard (a refused guest still counts against the rate limit)
 * and before RolesGuard. Reads only the verified token's guest flag; routes without the marker pass untouched.
 */
@Injectable()
export class AccountRequiredGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(ACCOUNT_REQUIRED, [context.getHandler(), context.getClass()]);
    if (!required) return true;
    const req = context.switchToHttp().getRequest<Request>();
    // A marked route behind @Public() has no verified token: refuse rather than guess.
    if (!req.principal || req.anonymous !== false) throw accountRequired();
    return true;
  }
}
