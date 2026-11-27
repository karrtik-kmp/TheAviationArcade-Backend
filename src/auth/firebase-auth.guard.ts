import { Inject, Injectable, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ThrottlerStorage } from "@nestjs/throttler";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { SessionRevocation } from "../accounts/session-revocation.js";
import { ApiError } from "../common/errors.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { authenticate } from "./authenticate.js";
import { IS_PUBLIC } from "./public.decorator.js";
import { SESSION_COOKIE_ALLOWED } from "./session-cookie.decorator.js";

const UNAUTHORIZED_HEADERS = { "WWW-Authenticate": "Bearer" } as const;

/**
 * Registered globally (APP_GUARD): requires a verified Firebase ID token on every route not marked
 * @Public(), or a Firebase session cookie on the nine routes marked @SessionCookieAllowed()
 * (docs/plans/session-cookies.md; see authenticate()). The principal is the only identity handlers see; no
 * client-supplied ID, role or name is ever trusted.
 */
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
    private readonly revocation: SessionRevocation,
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
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
    // Handler metadata only (plan C4): a session cookie is allowed per route, never by a class decorator.
    const sessionCookieAllowed = this.reflector.get<boolean | undefined>(SESSION_COOKIE_ALLOWED, context.getHandler()) === true;
    const { identity, kind } = await authenticate(
      match[1],
      { config: this.config, revocation: this.revocation, storage: this.storage },
      req,
      sessionCookieAllowed,
    );
    req.principal = identity.principal;
    req.email = identity.email;
    req.emailVerified = identity.emailVerified;
    req.anonymous = identity.anonymous;
    req.credentialKind = kind;
    return true;
  }
}

/** The verified principal (firebase:<project>:<uid>). Only valid on routes behind FirebaseAuthGuard. */
export const Principal = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const principal = context.switchToHttp().getRequest<Request>().principal;
  if (!principal) throw new Error("Principal read on a public route.");
  return principal;
});
