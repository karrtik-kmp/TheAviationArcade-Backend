import { Inject, Injectable } from "@nestjs/common";
import { ThrottlerStorage } from "@nestjs/throttler";
import { ApiError } from "../common/errors.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { ipBucket } from "../platform/ip-bucket.js";

const WINDOW_MS = 60 * 60 * 1000;
/** Its own throttler name: its own rows and refusal cache in the shared store, never the request limit's `default`. */
const THROTTLER_NAME = "guest-create";

/**
 * G3 (docs/plans/guest-callsign.md): new guest players per client IP per hour, in the shared rate-limit store (Postgres in
 * production, so every instance counts together). Called only when an anonymous PUT /v1/me is about to create a row. Two
 * concurrent first calls of one guest may both count: accepted (it errs towards refusing). Over the limit: 429 `rate_limited`
 * with Retry-After, and the caller writes nothing.
 */
@Injectable()
export class GuestCreationLimit {
  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, "guestCreatePerIpPerHour">,
  ) {}

  async count(ip: string | undefined): Promise<void> {
    const limit = this.config.guestCreatePerIpPerHour;
    const record = await this.storage.increment(`${THROTTLER_NAME}:ip:${ipBucket(ip)}`, WINDOW_MS, limit, 0, THROTTLER_NAME);
    if (record.isBlocked) {
      const seconds = Math.max(1, Math.ceil(record.timeToBlockExpire));
      throw new ApiError(429, "rate_limited", "Too many new guests from this network. Retry later.", { "Retry-After": String(seconds) });
    }
  }
}
