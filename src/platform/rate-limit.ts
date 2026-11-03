import { Injectable } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { ThrottlerLimitDetail, ThrottlerModuleOptions, ThrottlerStorage } from "@nestjs/throttler";
import type { Request } from "express";
import { ApiError } from "../common/errors.js";
import type { AppConfig } from "../config/config.module.js";

const WINDOW_MS = 60_000;
const THROTTLER_NAME = "default";

/** Requests already counted by the pre-body role check (app.setup.ts); RateLimitGuard must not count them again. */
const countedEarly = new WeakSet<object>();

/**
 * The rate-limit count for an authenticated request that is answered or read before Nest's guards run (the upload
 * pre-reader). Same storage, window, limit, key and 429 as RateLimitGuard, so a request counts exactly once: this marks `req`
 * and the guard then skips it. Throws the 429 ApiError (with Retry-After) when the principal's window is full.
 */
export async function countAuthenticatedRequest(
  storage: ThrottlerStorage,
  config: Pick<AppConfig, "rateLimitAuthPerMin">,
  principal: string,
  req: object,
): Promise<void> {
  const limit = config.rateLimitAuthPerMin;
  const record = await storage.increment(`${THROTTLER_NAME}:principal:${principal}`, WINDOW_MS, limit, 0, THROTTLER_NAME);
  countedEarly.add(req);
  if (record.isBlocked) throw rateLimited(record.timeToBlockExpire);
}

function rateLimited(timeToBlockExpire: number): ApiError {
  const seconds = Math.max(1, Math.ceil(timeToBlockExpire));
  return new ApiError(429, "rate_limited", "Too many requests. Slow down.", { "Retry-After": String(seconds) });
}

/**
 * One sliding window per tracker, shared by every route (not per route, which is the library default),
 * with the limit chosen per request: authenticated callers get the larger one. Each hit expires WINDOW_MS
 * after it was made. blockDuration 0 means no punitive lockout: a request over the limit is rejected
 * (and not counted) only while the window is full, and Retry-After is the time until the oldest hit
 * expires. (The library default blocks the caller for a whole extra window after the first excess.)
 * The store is RATE_LIMIT_STORE: postgres (PostgresThrottlerStorage, shared by every instance) or memory (the
 * library's own store, one process only). With no `storage` argument the library's in-memory store is used.
 */
export function throttlerOptions(
  config: Pick<AppConfig, "rateLimitAuthPerMin" | "rateLimitPublicPerMin">,
  storage?: ThrottlerStorage,
): ThrottlerModuleOptions {
  return {
    ...(storage ? { storage } : {}),
    throttlers: [
      {
        ttl: WINDOW_MS,
        blockDuration: 0,
        limit: (context: ExecutionContext) =>
          context.switchToHttp().getRequest<Request>().principal
            ? config.rateLimitAuthPerMin
            : config.rateLimitPublicPerMin,
      },
    ],
  };
}

/**
 * Registered globally (APP_GUARD) AFTER FirebaseAuthGuard, so `req.principal` is already the verified
 * principal: it is the key for authenticated routes, and req.ip (see TRUST_PROXY) for public ones.
 * Requests that fail authentication never reach this guard; token verification is a local signature
 * check, so that is cheap, but it means a flood of bad tokens is not counted here.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return countedEarly.has(context.switchToHttp().getRequest<object>());
  }

  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const principal = (req as Request).principal;
    // Prefixes keep a principal and an IP from ever sharing a bucket.
    return principal ? `principal:${principal}` : `ip:${await super.getTracker(req)}`;
  }

  protected override generateKey(_context: ExecutionContext, tracker: string, name: string): string {
    return `${name}:${tracker}`;
  }

  protected override async throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw rateLimited(detail.timeToBlockExpire);
  }
}
