import { Controller, Get } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { sql } from "drizzle-orm";
import { Public } from "../auth/public.decorator.js";
import { ApiError } from "../common/errors.js";
import { DatabaseService } from "../database/database.module.js";
import { SkipClientVersion } from "../platform/client-version.js";
import { DrainState } from "../platform/drain-state.js";

/** The readiness probe must answer quickly: a slow database is "not ready", not a hung probe. */
export const READY_TIMEOUT_MS = 2000;
/** How long a readiness answer is reused, so probes cannot turn into a stream of queries. */
export const READY_CACHE_MS = 1000;

/** Public probes. Exempt from the client version gate (callers are infrastructure, not the app). */
@SkipClientVersion()
@Controller("v1/health")
export class HealthController {
  private inflight: Promise<boolean> | undefined;
  private cached: { ok: boolean; at: number } | undefined;

  constructor(
    private readonly database: DatabaseService,
    private readonly drainState: DrainState,
  ) {}

  /** Liveness: the process is up and serving. Deliberately does not touch the database, and is not rate limited. */
  @Public()
  @SkipThrottle()
  @Get()
  health() {
    return { ok: true };
  }

  /**
   * Readiness: the database answers SELECT 1 within READY_TIMEOUT_MS. 503 with Retry-After otherwise, and
   * once shutdown has begun. Not rate limited: behind a load balancer with TRUST_PROXY unset every probe
   * (and every attacker) shares one IP, so a limit here could take the instance out of rotation. The
   * database is protected instead by sharing one in-flight query and caching the answer for 1 s.
   */
  @Public()
  @SkipThrottle()
  @Get("ready")
  async ready() {
    if (this.drainState.draining || !(await this.databaseOk())) {
      throw new ApiError(503, "service_unavailable", "Not ready.", { "Retry-After": "5" });
    }
    return { status: "ready" };
  }

  private databaseOk(): Promise<boolean> {
    if (this.cached && Date.now() - this.cached.at < READY_CACHE_MS) return Promise.resolve(this.cached.ok);
    this.inflight ??= this.databaseAnswers()
      .then((ok) => {
        this.cached = { ok, at: Date.now() };
        return ok;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  private async databaseAnswers(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const query = this.database.db.execute(sql`select 1`).then(
      () => true,
      () => false,
    );
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
    });
    try {
      return await Promise.race([query, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
