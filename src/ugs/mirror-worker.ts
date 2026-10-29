import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { rootCause } from "../database/database-errors.js";
import { DatabaseService } from "../database/database.module.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { players, ugsLinks, ugsMirrorDeletions, ugsMirrorOutbox } from "../db/schema.js";
import {
  BACKOFF_CAP_MS,
  BATCH_MAX,
  CREDENTIALS_PAUSE_MS,
  DEAD_DELETION_BACKOFF_MS,
  LEASE_MS,
  MAX_REJECTED_ATTEMPTS,
  REJECTED_BACKOFF_MS,
  TokenBucket,
  backoffMs,
  mirrorSnapshot,
} from "./mirror-policy.js";
import { UgsClient } from "./ugs-client.js";
import type { WriteResult } from "./ugs-client.js";
import { UGS_CLIENT, UGS_WORKER_OPTIONS } from "./ugs.tokens.js";
import type { UgsWorkerOptions } from "./ugs.tokens.js";

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

type Kind = "write" | "delete";
type Claimed = { key: string; generation: number; claimId: string; attempts: number };

/**
 * One-way, server-written progress mirror to UGS Cloud Save (Protected `progress` item). Postgres is the only
 * writer of progress and nothing is ever read back from UGS.
 *
 * Each tick claims due outbox rows with `FOR UPDATE SKIP LOCKED` in a single UPDATE that moves `due_at` to a
 * lease, so several instances can run it and no network call happens while a row lock or a player lock is held.
 * The claim also stamps a fresh `claim_id`; every later change by this worker (delete, release, back off) only
 * matches its own claim, so a worker whose lease expired cannot disturb a row another one has claimed since.
 * Success deletes the row only if its generation (a never-repeating sequence value) is unchanged; otherwise it is
 * due again at once. Pacing is a token bucket (UGS_MIRROR_MAX_PER_MIN). A 429 pauses the whole worker for
 * Retry-After. Our own credentials refused (401/403) pause it for 15 minutes with one error log. 5xx or network
 * failures back off per row (5 s doubling to 15 min); another 4xx backs off for an hour, is logged once, and the
 * write is dropped after MAX_REJECTED_ATTEMPTS (a deletion is kept and retried daily). Every tick with due rows
 * logs the backlog and the oldest lag. Logs carry counts only: never values, tokens or ids.
 */
@Injectable()
export class MirrorWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("UgsMirror");
  private readonly bucket: TokenBucket | undefined;
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
  ) {
    this.bucket = config.ugs ? new TokenBucket(config.ugs.mirrorMaxPerMin, options.clock()) : undefined;
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
    if (!this.client || !this.bucket) return summary;
    const now = new Date(nowMs);
    ({ backlog: summary.backlog, lagMs: summary.lagMs } = await this.backlog(now));
    if (nowMs < this.pausedUntil) return this.finish(summary, nowMs);
    let budget = Math.min(this.bucket.available(nowMs), BATCH_MAX);
    if (budget <= 0) return this.finish(summary, nowMs);

    // Deletions first: they are the privacy-relevant ones.
    const deletions = await this.claim("ugs_mirror_deletions", "ugs_player_id", budget, now);
    budget -= deletions.length;
    const rows = budget > 0 ? await this.claim("ugs_mirror_outbox", "player_id", budget, now) : [];

    const pending = [
      ...deletions.map((c) => ({ c, kind: "delete" as const })),
      ...rows.map((c) => ({ c, kind: "write" as const })),
    ];
    let haltUntil: number | undefined;
    for (const entry of pending) {
      if (this.stopped || haltUntil !== undefined) {
        await this.release(entry.kind, entry.c, new Date(haltUntil ?? nowMs));
        continue;
      }
      if (!this.bucket.take(nowMs)) {
        await this.release(entry.kind, entry.c, now);
        continue;
      }
      const result = entry.kind === "delete" ? await this.processDeletion(entry.c) : await this.processWrite(entry.c, now);
      if (result === "done") {
        this.rejectedLogged.delete(`${entry.kind}:${entry.c.key}`);
        if (entry.kind === "delete") summary.deleted += 1;
        else summary.written += 1;
      } else if (result.kind === "rate_limited") {
        summary.rateLimited = true;
        haltUntil = nowMs + result.retryAfterMs;
        this.pausedUntil = haltUntil;
        await this.release(entry.kind, entry.c, new Date(haltUntil));
      } else if (result.kind === "auth_failed") {
        // Our own credentials: every row would fail the same way, so stop calling UGS and say so once.
        summary.credentialsRejected = true;
        haltUntil = nowMs + CREDENTIALS_PAUSE_MS;
        this.pausedUntil = haltUntil;
        this.logger.error({ event: "ugs_mirror_credentials_rejected", status: result.status, pausedMs: CREDENTIALS_PAUSE_MS });
        await this.release(entry.kind, entry.c, new Date(haltUntil));
      } else if (result.kind === "rejected") {
        summary.rejected += 1;
        await this.reject(entry.kind, entry.c, result.status, nowMs);
      } else {
        summary.retried += 1;
        const delay = Math.min(BACKOFF_CAP_MS, backoffMs(entry.c.attempts + 1));
        await this.fail(entry.kind, entry.c, new Date(nowMs + delay), `http ${result.status}`);
      }
    }
    return this.finish(summary, nowMs);
  }

  /** One JSON line per tick that had due rows or did something, even while throttled or paused. */
  private finish(summary: TickSummary, nowMs: number): TickSummary {
    const active = summary.written + summary.deleted + summary.retried + summary.rejected > 0 || summary.rateLimited;
    if (active || summary.backlog > 0) {
      this.logger.log({ event: "ugs_mirror_batch", ...summary, paused: nowMs < this.pausedUntil });
    }
    return summary;
  }

  /** Rows due right now across both queues, and how long the oldest has been due. */
  private async backlog(now: Date): Promise<{ backlog: number; lagMs: number }> {
    const at = now.toISOString();
    const result = await this.database.db.execute(sql`
      SELECT count(*)::int AS n, min(due_at) AS oldest FROM (
        SELECT due_at FROM ugs_mirror_outbox WHERE due_at <= ${at}::timestamptz
        UNION ALL
        SELECT due_at FROM ugs_mirror_deletions WHERE due_at <= ${at}::timestamptz
      ) due
    `);
    const row = result.rows[0] as { n: number; oldest: Date | string | null } | undefined;
    return {
      backlog: Number(row?.n ?? 0),
      lagMs: row?.oldest ? Math.max(0, now.getTime() - new Date(row.oldest).getTime()) : 0,
    };
  }

  /** A 4xx other than 429/401/403: back off, log once, and cap the retries. */
  private async reject(kind: Kind, claimed: Claimed, status: number, nowMs: number): Promise<void> {
    const attempts = claimed.attempts + 1;
    const dead = attempts >= MAX_REJECTED_ATTEMPTS;
    const logKey = `${kind}:${claimed.key}`;
    if (kind === "write" && dead) {
      // Give up on this snapshot; the next progress change queues the player afresh with a clean slate.
      await this.database.db
        .delete(ugsMirrorOutbox)
        .where(and(eq(ugsMirrorOutbox.playerId, claimed.key), eq(ugsMirrorOutbox.claimId, claimed.claimId)));
      this.rejectedLogged.delete(logKey);
      this.logger.warn({ event: "ugs_mirror_dropped", status, op: kind, attempts });
      return;
    }
    const delay = kind === "delete" && dead ? DEAD_DELETION_BACKOFF_MS : REJECTED_BACKOFF_MS;
    await this.fail(kind, claimed, new Date(nowMs + delay), `http ${status}`);
    // One log line per row until it succeeds: the long backoff makes repeats rare.
    if (!this.rejectedLogged.has(logKey)) {
      this.rejectedLogged.add(logKey);
      this.logger.warn({ event: "ugs_mirror_rejected", status, op: kind });
    }
  }

  /** Claim up to `limit` due rows: due_at becomes a lease and claim_id a fresh uuid. SKIP LOCKED makes it safe across instances. */
  private async claim(table: "ugs_mirror_outbox" | "ugs_mirror_deletions", keyColumn: string, limit: number, now: Date): Promise<Claimed[]> {
    const lease = new Date(now.getTime() + LEASE_MS);
    const result = await this.database.db.execute(sql`
      WITH picked AS (
        SELECT ${sql.identifier(keyColumn)} AS k
        FROM ${sql.identifier(table)}
        WHERE due_at <= ${now.toISOString()}::timestamptz
        ORDER BY due_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${sql.identifier(table)} AS t
      SET due_at = ${lease.toISOString()}::timestamptz, claim_id = gen_random_uuid()
      FROM picked
      WHERE t.${sql.identifier(keyColumn)} = picked.k
      RETURNING t.${sql.identifier(keyColumn)} AS key,
                ${table === "ugs_mirror_outbox" ? sql`t.generation` : sql`0`} AS generation,
                t.claim_id AS claim_id,
                t.attempts AS attempts
    `);
    return (result.rows as { key: string; generation: string | number; claim_id: string; attempts: number }[]).map((row) => ({
      key: row.key,
      generation: Number(row.generation),
      claimId: row.claim_id,
      attempts: Number(row.attempts),
    }));
  }

  private async processWrite(claimed: Claimed, now: Date): Promise<"done" | Exclude<WriteResult, { kind: "ok" }>> {
    const mine = and(eq(ugsMirrorOutbox.playerId, claimed.key), eq(ugsMirrorOutbox.claimId, claimed.claimId));
    const [row] = await this.database.db
      .select({ player: players, ugsPlayerId: ugsLinks.ugsPlayerId })
      .from(players)
      .innerJoin(ugsLinks, eq(ugsLinks.playerId, players.id))
      .where(eq(players.id, claimed.key));
    if (!row) {
      // Deleted or unlinked since it was queued: nothing to mirror.
      await this.database.db.delete(ugsMirrorOutbox).where(mine);
      return "done";
    }
    const result = await this.client!.writeProgress(row.ugsPlayerId, mirrorSnapshot(row.player, now), this.abort.signal);
    if (result.kind !== "ok") return result;
    // Only our own claim, and only if nothing was queued meanwhile (a generation is never reused).
    const removed = await this.database.db
      .delete(ugsMirrorOutbox)
      .where(and(mine, eq(ugsMirrorOutbox.generation, claimed.generation)))
      .returning({ playerId: ugsMirrorOutbox.playerId });
    if (removed.length === 0) {
      // Changed while we were writing: due again now. If our claim was lost (lease expired), this matches nothing.
      await this.database.db
        .update(ugsMirrorOutbox)
        .set({ dueAt: now, attempts: 0, lastError: null, claimId: null })
        .where(mine);
    }
    return "done";
  }

  private async processDeletion(claimed: Claimed): Promise<"done" | Exclude<WriteResult, { kind: "ok" }>> {
    // If the same UGS id was linked again meanwhile, its mirror is live again: drop the stale deletion.
    const [linked] = await this.database.db.select({ id: ugsLinks.playerId }).from(ugsLinks).where(eq(ugsLinks.ugsPlayerId, claimed.key));
    if (!linked) {
      const result = await this.client!.deleteProgress(claimed.key, this.abort.signal);
      if (result.kind !== "ok") return result;
    }
    await this.database.db
      .delete(ugsMirrorDeletions)
      .where(and(eq(ugsMirrorDeletions.ugsPlayerId, claimed.key), eq(ugsMirrorDeletions.claimId, claimed.claimId)));
    return "done";
  }

  /** Give a claimed row back (budget spent, paused or stopping) without counting an attempt. Only our own claim. */
  private async release(kind: Kind, claimed: Claimed, dueAt: Date): Promise<void> {
    if (kind === "write") {
      await this.database.db
        .update(ugsMirrorOutbox)
        .set({ dueAt, claimId: null })
        .where(and(eq(ugsMirrorOutbox.playerId, claimed.key), eq(ugsMirrorOutbox.claimId, claimed.claimId)));
    } else {
      await this.database.db
        .update(ugsMirrorDeletions)
        .set({ dueAt, claimId: null })
        .where(and(eq(ugsMirrorDeletions.ugsPlayerId, claimed.key), eq(ugsMirrorDeletions.claimId, claimed.claimId)));
    }
  }

  private async fail(kind: Kind, claimed: Claimed, dueAt: Date, label: string): Promise<void> {
    if (kind === "write") {
      await this.database.db
        .update(ugsMirrorOutbox)
        .set({ dueAt, attempts: sql`${ugsMirrorOutbox.attempts} + 1`, lastError: label, claimId: null })
        .where(and(eq(ugsMirrorOutbox.playerId, claimed.key), eq(ugsMirrorOutbox.claimId, claimed.claimId)));
    } else {
      await this.database.db
        .update(ugsMirrorDeletions)
        .set({ dueAt, attempts: sql`${ugsMirrorDeletions.attempts} + 1`, lastError: label, claimId: null })
        .where(and(eq(ugsMirrorDeletions.ugsPlayerId, claimed.key), eq(ugsMirrorDeletions.claimId, claimed.claimId)));
    }
  }
}
