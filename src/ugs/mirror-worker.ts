import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { rootCause } from "../database/database-errors.js";
import { DatabaseService } from "../database/database.module.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import {
  BACKOFF_CAP_MS,
  BATCH_MAX,
  CREDENTIALS_PAUSE_MS,
  DEAD_DELETION_BACKOFF_MS,
  MAX_REJECTED_ATTEMPTS,
  REJECTED_BACKOFF_MS,
  TokenBucket,
  backoffMs,
} from "./mirror-policy.js";
import { UgsClient } from "./ugs-client.js";
import { CopyDeletionQueue, ProgressWriteQueue } from "./mirror-queue.js";
import type { Claimed, MirrorQueue } from "./mirror-queue.js";
import { UGS_CLIENT, UGS_MIRROR_QUEUES, UGS_WORKER_OPTIONS } from "./ugs.tokens.js";
import type { UgsWorkerOptions } from "./ugs.tokens.js";

/** The production queues in priority order: deletions first (privacy-relevant), then writes. */
export function defaultMirrorQueues(database: DatabaseService, client: UgsClient): readonly MirrorQueue[] {
  return [new CopyDeletionQueue(database, client), new ProgressWriteQueue(database, client)];
}

export type TickSummary = {
  written: number;
  deleted: number;
  retried: number;
  rejected: number;
  rateLimited: boolean;
  /** Our own UGS credentials were refused (401/403): the whole worker is paused. */
  credentialsRejected: boolean;
  /** Rows due at the start of the tick (outbox + deletions), whether or not this tick could take them. */
  backlog: number;
  /** How long the oldest due row had been due, in ms (0 when nothing was due). */
  lagMs: number;
};

/**
 * One-way, server-written progress mirror to UGS Cloud Save (Protected `progress` item). Postgres is the only
 * writer of progress and nothing is ever read back from UGS.
 *
 * Each tick claims due outbox rows with `FOR UPDATE SKIP LOCKED` in a single UPDATE that moves `due_at` to a
 * lease, so several instances can run it and no network call happens while a row lock or a player lock is held.
 * The claim also stamps a fresh `claim_id`; every later change by this worker (delete, release, back off) only
 * matches its own claim, so a worker whose lease expired cannot disturb a row another one has claimed since.
 * Success deletes the row only if its generation (a never-repeating sequence value) is unchanged; otherwise it is
 * due again at once. The worker owns policy only; the two queues (src/ugs/mirror-queue.ts: deletions, then writes)
 * own their tables. Pacing is a token bucket (UGS_MIRROR_MAX_PER_MIN). A 429 pauses the whole worker for
 * Retry-After. Our own credentials refused (401/403) pause it for 15 minutes with one error log. 5xx or network
 * failures back off per row (5 s doubling to 15 min); another 4xx backs off for an hour, is logged once, and the
 * write is dropped after MAX_REJECTED_ATTEMPTS (a deletion is kept and retried daily). Every tick with due rows
 * logs the backlog and the oldest lag. Logs carry counts only: never values, tokens or ids.
 */
@Injectable()
export class MirrorWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("UgsMirror");
  private readonly bucket: TokenBucket | undefined;
  private readonly queues: readonly MirrorQueue[] | undefined;
  private pausedUntil = 0;
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<unknown> | undefined;
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly rejectedLogged = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    @Inject(UGS_CLIENT) private readonly client: UgsClient | null,
    @Inject(UGS_WORKER_OPTIONS) private readonly options: UgsWorkerOptions,
    @Inject(APP_CONFIG) config: AppConfig,
    /** Tests inject in-memory queues; production builds the two Postgres adapters. Priority order: deletions, writes. */
    @Optional() @Inject(UGS_MIRROR_QUEUES) queues?: readonly MirrorQueue[],
  ) {
    this.bucket = config.ugs ? new TokenBucket(config.ugs.mirrorMaxPerMin, options.clock()) : undefined;
    this.queues = queues ?? (client ? defaultMirrorQueues(database, client) : undefined);
  }

  onModuleInit(): void {
    if (!this.client || !this.options.autoStart) return;
    this.schedule();
  }

  /** Runs before the pool closes (module destroy precedes application shutdown): stop, abort fetches, wait. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.abort.abort();
    await this.inflight;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inflight = this.tick()
        .catch((error: unknown) => {
          const root = rootCause(error);
          this.logger.warn(`mirror tick failed: ${root instanceof Error ? root.message : "unknown error"}`);
        })
        .finally(() => {
          this.inflight = undefined;
          this.schedule();
        });
    }, this.options.intervalMs);
    this.timer.unref();
  }

  /** One pass. Public so tests drive it with an explicit clock. */
  async tick(nowMs: number = this.options.clock()): Promise<TickSummary> {
    const summary: TickSummary = {
      written: 0,
      deleted: 0,
      retried: 0,
      rejected: 0,
      rateLimited: false,
      credentialsRejected: false,
      backlog: 0,
      lagMs: 0,
    };
    if (!this.queues || !this.bucket) return summary;
    const now = new Date(nowMs);
    ({ backlog: summary.backlog, lagMs: summary.lagMs } = await this.backlog(now));
    if (this.isPaused(nowMs)) return this.finish(summary, nowMs);
    let budget = Math.min(this.bucket.available(nowMs), BATCH_MAX);
    if (budget <= 0) return this.finish(summary, nowMs);

    // Priority order: deletions first (the privacy-relevant ones), then writes.
    const pending: { queue: MirrorQueue; claimed: Claimed }[] = [];
    for (const queue of this.queues) {
      if (budget <= 0) break;
      const rows = await queue.claim(budget, now);
      budget -= rows.length;
      for (const claimed of rows) pending.push({ queue, claimed });
    }

    let haltUntil: number | undefined;
    for (const { queue, claimed } of pending) {
      if (this.stopped || haltUntil !== undefined) {
        await queue.release(claimed, new Date(haltUntil ?? nowMs));
        continue;
      }
      if (!this.takeToken(nowMs)) {
        await queue.release(claimed, now);
        continue;
      }
      const result = await queue.process(claimed, now, this.abort.signal);
      if (result === "done") {
        this.rejectedLogged.delete(`${queue.op}:${claimed.key}`);
        if (queue.op === "delete") summary.deleted += 1;
        else summary.written += 1;
      } else if (result.kind === "rate_limited") {
        summary.rateLimited = true;
        haltUntil = nowMs + result.retryAfterMs;
        this.pause(haltUntil);
        await queue.release(claimed, new Date(haltUntil));
      } else if (result.kind === "auth_failed") {
        // Our own credentials: every row would fail the same way, so stop calling UGS and say so once.
        summary.credentialsRejected = true;
        haltUntil = nowMs + CREDENTIALS_PAUSE_MS;
        this.pause(haltUntil);
        this.logger.error({ event: "ugs_mirror_credentials_rejected", status: result.status, pausedMs: CREDENTIALS_PAUSE_MS });
        await queue.release(claimed, new Date(haltUntil));
      } else if (result.kind === "rejected") {
        summary.rejected += 1;
        await this.reject(queue, claimed, result.status, nowMs);
      } else {
        summary.retried += 1;
        const delay = Math.min(BACKOFF_CAP_MS, backoffMs(claimed.attempts + 1));
        await queue.fail(claimed, new Date(nowMs + delay), `http ${result.status}`);
      }
    }
    return this.finish(summary, nowMs);
  }

  // Budget and pause state. Per process in S6; S7 replaces these three with a shared Postgres budget row
  // (reserve before claiming, refund unused tokens, a pause visible to every instance).
  private isPaused(nowMs: number): boolean {
    return nowMs < this.pausedUntil;
  }

  private takeToken(nowMs: number): boolean {
    return this.bucket!.take(nowMs);
  }

  private pause(untilMs: number): void {
    this.pausedUntil = untilMs;
  }

  /** One JSON line per tick that had due rows or did something, even while throttled or paused. */
  private finish(summary: TickSummary, nowMs: number): TickSummary {
    const active = summary.written + summary.deleted + summary.retried + summary.rejected > 0 || summary.rateLimited;
    if (active || summary.backlog > 0) {
      this.logger.log({ event: "ugs_mirror_batch", ...summary, paused: this.isPaused(nowMs) });
    }
    return summary;
  }

  /** Rows due right now across both queues, and how long the oldest has been due. */
  private async backlog(now: Date): Promise<{ backlog: number; lagMs: number }> {
    let backlog = 0;
    let oldest: Date | null = null;
    for (const queue of this.queues ?? []) {
      const due = await queue.backlog(now);
      backlog += due.count;
      if (due.oldest && (!oldest || due.oldest < oldest)) oldest = due.oldest;
    }
    return { backlog, lagMs: oldest ? Math.max(0, now.getTime() - oldest.getTime()) : 0 };
  }

  /** A 4xx other than 429/401/403: back off, log once, and cap the retries. */
  private async reject(queue: MirrorQueue, claimed: Claimed, status: number, nowMs: number): Promise<void> {
    const attempts = claimed.attempts + 1;
    const dead = attempts >= MAX_REJECTED_ATTEMPTS;
    const logKey = `${queue.op}:${claimed.key}`;
    if (queue.op === "write" && dead) {
      // Give up on this snapshot; the next progress change queues the player afresh with a clean slate.
      await queue.drop(claimed);
      this.rejectedLogged.delete(logKey);
      this.logger.warn({ event: "ugs_mirror_dropped", status, op: queue.op, attempts });
      return;
    }
    const delay = queue.op === "delete" && dead ? DEAD_DELETION_BACKOFF_MS : REJECTED_BACKOFF_MS;
    await queue.fail(claimed, new Date(nowMs + delay), `http ${status}`);
    // One log line per row until it succeeds: the long backoff makes repeats rare.
    if (!this.rejectedLogged.has(logKey)) {
      this.rejectedLogged.add(logKey);
      this.logger.warn({ event: "ugs_mirror_rejected", status, op: queue.op });
    }
  }
}
