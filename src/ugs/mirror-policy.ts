import type { PlayerRow } from "../db/schema.js";
import { progressView } from "../players/progress-view.js";
import type { Rank } from "../rules/ranks.js";
import { REQUEST_TIMEOUT_MS } from "./ugs-client.js";

/**
 * The value of the Protected Cloud Save item `progress`. Field names and values match GET /v1/me/progress
 * where they overlap. There is no writeLock: Postgres is the only writer. The game orders two copies (or a copy and
 * a server answer) by `version`: it goes up by one with every change visible here, Active Rank changes included (D-1).
 * `updatedAt` is informational.
 */
export type MirrorSnapshot = {
  schemaVersion: 1;
  version: number;
  statusPoints: number;
  miles: number;
  hints: number;
  perfectStreak: number;
  certifiedRank: Rank;
  activeRank: Rank;
  /** ISO 8601 or null. The time-dependent `firstClassPass` flag is not mirrored; derive it from this. */
  firstClassUntil: string | null;
  /** ISO 8601, the server time of the player's last change. Informational; order by `version`. */
  updatedAt: string;
};

export function mirrorSnapshot(player: PlayerRow, now: Date): MirrorSnapshot {
  const view = progressView(player, now);
  return {
    schemaVersion: 1,
    version: player.version,
    statusPoints: view.statusPoints,
    miles: view.miles,
    hints: view.hints,
    perfectStreak: view.perfectStreak,
    certifiedRank: view.certifiedRank,
    activeRank: view.activeRank,
    firstClassUntil: player.firstClassUntil ? player.firstClassUntil.toISOString() : null,
    updatedAt: player.updatedAt.toISOString(),
  };
}

/**
 * Token bucket: `perMin` tokens per minute, burst of at most min(perMin, 10) so a backlog never spikes past the
 * UGS budget (about 33/min sustained). Time is passed in, so it is deterministic in tests.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  readonly capacity: number;

  constructor(
    private readonly perMin: number,
    now: number,
    capacity: number = Math.min(perMin, 10),
  ) {
    this.capacity = capacity;
    this.tokens = this.capacity;
    this.last = now;
  }

  /** Back to a full bucket at `now` (tests). */
  reset(now: number): void {
    this.tokens = this.capacity;
    this.last = now;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.last);
    this.last = Math.max(this.last, now);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.perMin) / 60_000);
  }

  /** Whole tokens available right now. */
  available(now: number): number {
    this.refill(now);
    return Math.floor(this.tokens);
  }

  /** Take one token if there is one. */
  take(now: number): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** In-memory sliding window per key (e.g. a principal). Single instance only, like the global rate limiter. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record a hit at `now`. Returns 0 when allowed, else the seconds until the oldest hit expires (hit not counted). */
  hit(key: string, now: number): number {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil(((recent[0] ?? now) + this.windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.every((t) => t <= now - this.windowMs)) this.hits.delete(k);
    }
    return 0;
  }
}

/** Player Auth admin calls (link proofs) per minute, process-wide: under its 500 / 30 min limit. */
export const PROOF_CALLS_PER_MIN = 12;
/** Link proofs per principal per hour (calls that reach the Player Auth admin API). */
export const LINK_PROOFS_PER_HOUR = 5;

/** Rows one tick may claim. */
export const BATCH_MAX = 20;
/**
 * A claimed row stays invisible to other workers this long (a crash returns it to the queue after this). A tick
 * handles its claimed rows one after another, each at most one request timeout, so the lease must outlast the
 * whole batch or another instance reclaims a row that is still being written. The margin covers database round
 * trips between requests.
 */
export const LEASE_MARGIN_MS = 60_000;
export const LEASE_MS = BATCH_MAX * REQUEST_TIMEOUT_MS + LEASE_MARGIN_MS;

/**
 * When a deletion queued at `now` may run: after any write that was in flight at `now` (claimed at most LEASE_MS
 * earlier, so it ends within LEASE_MS + one request timeout of `now`) has finished or lost its lease. Otherwise a
 * stale write on another instance could recreate the copy after the deletion.
 */
export function mirrorDeletionDueAt(now: Date): Date {
  return new Date(now.getTime() + LEASE_MS + REQUEST_TIMEOUT_MS);
}

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 15 * 60_000;
/** A 4xx other than 429 will not fix itself quickly: retry after an hour. */
export const REJECTED_BACKOFF_MS = 60 * 60_000;
/** A write rejected with a 4xx this many times is dropped (logged once); the next progress change queues it afresh. */
export const MAX_REJECTED_ATTEMPTS = 3;
/** A deletion is never dropped (privacy), but after this many 4xx rejections it is retried daily, not hourly. */
export const DEAD_DELETION_BACKOFF_MS = 24 * 60 * 60_000;
/** Our own service-account credentials were refused (401/403): pause the whole worker this long. */
export const CREDENTIALS_PAUSE_MS = 15 * 60_000;

/** Delay before retry number `attempts` (1-based) after a 5xx or network failure: 5 s doubling, capped at 15 min. */
export function backoffMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 20);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exponent);
}
