import { Inject, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { ApiError } from "../common/errors.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";

const SKIP_CLIENT_VERSION = "skipClientVersion";

/** Marks a route (or controller) the client version gate never applies to: health probes, not the app. */
export const SkipClientVersion = (): ClassDecorator & MethodDecorator => SetMetadata(SKIP_CLIENT_VERSION, true);

/** A positive integer build number, no sign, no decimals, at most 9 digits. */
const BUILD_NUMBER = /^[1-9]\d{0,8}$/;

/** `X-Client` value the website's server sends; it has no app build, so the gate does not apply. */
const WEB_CLIENT = "web";

/**
 * Registered globally (APP_GUARD) BEFORE the auth guard, so an outdated client is told to update without
 * the server verifying its token first. Off unless MIN_CLIENT_BUILD is set. When on, a missing,
 * malformed or too-low X-Client-Version is 426 client_update_required. The website's server calls with
 * `X-Client: web` and is skipped: it has no app build. This is a compatibility gate, not authorization, so
 * claiming "web" grants nothing. The token is still verified next.
 */
@Injectable()
export class ClientVersionGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const min = this.config.minClientBuild;
    if (min === undefined) return true;
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(SKIP_CLIENT_VERSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (request.header("x-client")?.trim().toLowerCase() === WEB_CLIENT) return true;
    const header = request.header("x-client-version");
    if (header !== undefined && BUILD_NUMBER.test(header.trim()) && Number(header.trim()) >= min) return true;
    throw new ApiError(426, "client_update_required", "Update the app to continue.");
  }
}
