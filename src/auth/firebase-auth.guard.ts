import { Inject, Injectable, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { ApiError } from "../common/errors.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { AuthUnavailableError, verifyFirebaseToken } from "./firebase.js";
import { IS_PUBLIC } from "./public.decorator.js";

const UNAUTHORIZED_HEADERS = { "WWW-Authenticate": "Bearer" } as const;

/**
 * Registered globally (APP_GUARD): requires a verified Firebase ID token on every route not marked
 * @Public(). The principal is the only identity handlers see; no
 * client-supplied ID, role or name is ever trusted.
 */
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<Request>();
    // The scheme name is case-insensitive (RFC 9110); exactly one space, then a token with no spaces.
    const match = /^bearer (\S+)$/i.exec(req.header("authorization") ?? "");
    if (!match?.[1]) throw new ApiError(401, "unauthorized", "Sign in required.", UNAUTHORIZED_HEADERS);
    try {
      const identity = await verifyFirebaseToken(match[1], {
        projectId: this.config.firebaseProjectId,
        emulator: this.config.emulatorTokens,
      });
      req.principal = identity.principal;
      req.email = identity.email;
      req.emailVerified = identity.emailVerified;
    } catch (error) {
      // Google's keys being unreachable is our outage, not a bad token: tell the client to retry.
      if (error instanceof AuthUnavailableError) {
        throw new ApiError(503, "auth_unavailable", "Sign-in is temporarily unavailable. Retry shortly.", {
          "Retry-After": "5",
        });
      }
      throw new ApiError(401, "unauthorized", "Sign in required.", UNAUTHORIZED_HEADERS);
    }
    return true;
  }
}

/** The verified principal (firebase:<project>:<uid>). Only valid on routes behind FirebaseAuthGuard. */
export const Principal = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const principal = context.switchToHttp().getRequest<Request>().principal;
  if (!principal) throw new Error("Principal read on a public route.");
  return principal;
});
