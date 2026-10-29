import type { PlayerRow } from "../db/schema.js";
import { progressView } from "../players/progress-view.js";
import type { Rank } from "../rules/ranks.js";
import { REQUEST_TIMEOUT_MS } from "./ugs-client.js";

/**
 * The value of the Protected Cloud Save item `progress`. Field names and values match GET /v1/me/progress
 * where they overlap. There is no writeLock: Postgres is the only writer. The game orders two copies (or a copy and
 * a server answer) by `version`: it goes up by one with every change visible here, Active Rank changes included (D-1).
 * `updatedAt` is informational. `uid` names the owner (schemaVersion 2, user ruling 2026-10-29): a UGS player can
 * still hold a previous owner's copy after a link moves or an account is deleted and re-linked, so the game shows a
 * copy only when `uid` is the signed-in Firebase user, and `version` is compared only between copies of one owner.
 */
export type MirrorSnapshot = {
  schemaVersion: 2;
  /** Firebase uid of the player this copy belongs to. */
  uid: string;
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

/** The Firebase uid inside a principal `firebase:<projectId>:<uid>` (project ids contain no colon). */
export function uidOfPrincipal(principal: string): string {
  const match = /^firebase:[^:]+:(.+)$/.exec(principal);
  if (!match?.[1]) throw new Error("Not a Firebase principal.");
  return match[1];
}

export function mirrorSnapshot(player: PlayerRow, now: Date): MirrorSnapshot {
  const view = progressView(player, now);
  return {
    schemaVersion: 2,
    uid: uidOfPrincipal(player.id),
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

/** Burst size of a bucket: at most 10, so a backlog never spikes past the UGS budget (about 33/min sustained). */
export function bucketCapacity(perMin: number): number {
  return Math.min(perMin, 10);
}

/**
 * How far past `now` a stored refill time may be before it is treated as a clock error. A forward-jumping clock on
 * one process (the in-memory budget, or a process-time Postgres budget) stamps a refill time in the future; without
 * a bound every other caller would see "no time elapsed" until real time catches up, freezing the budget. Within the
 * bound (ordinary skew between instances) the stored time is kept, so two slightly different clocks mint nothing.
 */
export const MAX_CLOCK_LEAD_MS = 5 * 60_000;

/**
 * The pure refill step shared by the in-memory TokenBucket and the shared Postgres budget row (src/ugs/budget.ts):
 * `perMin` tokens per minute since `last`, capped at `capacity`. A clock that moves backwards adds nothing and does
 * not move `last` back, so two instances with slightly different clocks cannot mint tokens. A `last` more than
 * MAX_CLOCK_LEAD_MS ahead of `now` is clamped to `now` (still minting nothing), so one wrong clock freezes the
 * budget for at most that long.
 */
export function refillTokens(
  tokens: number,
  last: number,
  now: number,
  perMin: number,
  capacity: number,
): { tokens: number; last: number } {
  const from = last - now > MAX_CLOCK_LEAD_MS ? now : last;
  const elapsed = Math.max(0, now - from);
  return { tokens: Math.min(capacity, tokens + (elapsed * perMin) / 60_000), last: Math.max(from, now) };
}

/**
 * Token bucket: `perMin` tokens per minute, burst of at most min(perMin, 10) so a backlog never spikes past the
 * UGS budget (about 33/min sustained). Time is passed in, so it is deterministic in tests. Per process: the
 * cross-instance budget is PostgresUgsBudget; this class is its in-memory twin (InMemoryUgsBudget) and the math is
 * shared through refillTokens.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  readonly capacity: number;

  constructor(
    private readonly perMin: number,
    now: number,
    capacity: number = bucketCapacity(perMin),
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
    ({ tokens: this.tokens, last: this.last } = refillTokens(this.tokens, this.last, now, this.perMin, this.capacity));
  }

  /** Whole tokens available right now. */
  available(now: number): number {
    this.refill(now);
    return Math.floor(this.tokens);
  }

  /** Take one token if there is one. */
  take(now: number): boolean {
    return this.takeUpTo(1, now) === 1;
  }

  /** Take up to `n` whole tokens; returns how many were taken. */
  takeUpTo(n: number, now: number): number {
    this.refill(now);
    const granted = Math.max(0, Math.min(Math.floor(n), Math.floor(this.tokens)));
    this.tokens -= granted;
    return granted;
  }

  /** Give back `n` unused tokens (never above capacity). */
  giveBack(n: number, now: number): void {
    this.refill(now);
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, n));
  }
}

/**
 * In-memory sliding window per key (e.g. a principal). Deliberately per process (D-4 note): the 5 link proofs per hour
 * per principal is a fairness limit, not the UGS budget; N instances allow at most N x 5. The scarce Player Auth
 * admin calls themselves are bounded across instances by the shared `player_auth_admin` budget row.
 */
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

/** Player Auth admin calls (link proofs) per minute across all instances: under its 500 / 30 min limit. */
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

/**
 * When a progress write queued at `now` may run (C3). Exempt, so due at once: the first write after a link (and after
 * any re-link or link move: `lastMirroredAt` is null then), an `urgent` enqueue (the hook for a write at Trip end,
 * later), and an interval of 0. Otherwise no earlier than `lastMirroredAt + minIntervalSec`. This is the spec of the
 * SQL in src/balance/mirror-outbox.ts enqueueMirror (an e2e test pins them together); deletions never use it.
 */
export function mirrorDueAt(now: Date, lastMirroredAt: Date | null, minIntervalSec: number, urgent = false): Date {
  if (urgent || minIntervalSec <= 0 || lastMirroredAt === null) return now;
  return new Date(Math.max(now.getTime(), lastMirroredAt.getTime() + minIntervalSec * 1000));
}
