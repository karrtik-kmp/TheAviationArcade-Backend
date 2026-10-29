import { Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DatabaseService, ExpectedRollback } from "../database/database.module.js";
import type { Tx } from "../database/database.module.js";
import { hintLedger, milesLedger, players } from "../db/schema.js";
import type { PlayerRow } from "../db/schema.js";
import type { Rank } from "../rules/ranks.js";
import { enqueueMirror } from "../ugs/outbox.js";
import type { HintKind, MilesKind } from "./ledger-kinds.js";

/** One ledger entry. `delta` is signed and relative; a zero delta writes nothing (the table CHECKs delta <> 0). */
export type Posting =
  | { account: "miles"; delta: number; kind: MilesKind; ref: string }
  | { account: "hints"; delta: number; kind: HintKind; ref: string };

/** A progress event: balance and counters. Presence of a `change` bumps the version, even if it is all zeros. */
export type BalanceChange = {
  postings?: Posting[];
  /** Status Points to credit, >= 0. Status Points have no ledger (rounds.sp_awarded is the record). */
  statusPoints?: number;
  /** Absolute value. */
  perfectStreak?: number;
  /** Absolute value. Reserved for the First Class Pass purchase (C4). */
  firstClassUntil?: Date | null;
};

/** Visible profile state. A value that differs from the stored one is a progress event too (D-1). */
export type ProfileChange = {
  /** Stored Active Rank: null means "follow Certified". */
  activeRank?: Rank | null;
};

export interface LockedPlayer {
  /** The row as locked, before this call's changes. */
  readonly player: PlayerRow;
  /** The open transaction, for the caller's own rows (rounds, links, later trips). Lock them after the player. */
  readonly tx: Tx;
  /** The delta of a ledger entry already posted under (kind, ref), or null. For idempotent replays. */
  posted(account: "miles", kind: MilesKind, ref: string): Promise<number | null>;
  posted(account: "hints", kind: HintKind, ref: string): Promise<number | null>;
}

export type Step<T> = {
  value: T;
  change?: BalanceChange;
  profile?: ProfileChange;
  /** Queue a mirror write at the current version without changing anything. */
  republish?: true;
};

export type UpdateResult<T> =
  | { kind: "ok"; value: T; player: PlayerRow }
  | { kind: "no_player" }
  | { kind: "insufficient"; account: "miles" | "hints" };

/** Thrown after `fn` returns, so the caller's writes roll back too; the pooled connection is kept. */
class InsufficientBalance extends ExpectedRollback {
  constructor(readonly account: "miles" | "hints") {
    super(`Insufficient ${account}.`);
  }
}

/**
 * Every write to a player's balance goes through `update`. Invariants, all held inside this module:
 *
 * 1. The player row is locked FOR UPDATE first, always, so the caller locks its own rows (a Round) after it and the
 *    lock order stays player -> Round. `open()` (ensurePlayer: INSERT ... ON CONFLICT DO NOTHING) is the one
 *    exception, because it creates the row; `erase()` (deletePlayer) locks first like `update`. Both still live in
 *    PlayersService until slice S3 moves them here.
 * 2. At most one UPDATE players per call. Ledger postings and Status Points are relative increments (defence in
 *    depth if the lock were ever lost); the Perfect Streak and firstClassUntil are absolute writes under the same lock.
 * 3. players.version += 1 when the step carries a `change` (even an all-zero one: a completed Round is a progress
 *    event whether or not it pays), or a `profile` whose value differs from the stored one (D-1: every change visible
 *    in the UGS copy bumps the version, so it is a total order). A step with neither changes nothing.
 * 4. One ledger row per nonzero posting. Zero deltas are skipped. UNIQUE (player, kind, ref) violations propagate.
 * 5. Any applied change, or `republish`, calls enqueueMirror(tx, id, newVersion, now) in the same transaction.
 * 6. A posting that would take a balance below 0 rolls back the whole transaction, including the caller's own
 *    writes through `tx`, and comes back as { kind: "insufficient" }.
 * 7. After commit, players.miles = SUM(miles_ledger.delta) and players.hints = SUM(hint_ledger.delta).
 * 8. No network calls inside `fn`.
 *
 * DB errors propagate unchanged (lock_timeout 55P03 is a 503 via database-errors.ts). One adapter (Postgres) on
 * purpose: callers share the transaction for their own tables, so this is a deep module, not a seam.
 */
@Injectable()
export class PlayerBalance {
  constructor(private readonly database: DatabaseService) {}

  async update<T>(
    principal: string,
    now: Date,
    fn: (locked: LockedPlayer) => Promise<Step<T>>,
  ): Promise<UpdateResult<T>> {
    try {
      return await this.database.withTransaction(async (tx): Promise<UpdateResult<T>> => {
        const [player] = await tx.select().from(players).where(eq(players.id, principal)).for("update");
        if (!player) return { kind: "no_player" };

        const locked: LockedPlayer = {
          player,
          tx,
          posted: async (account: "miles" | "hints", kind: string, ref: string) => {
            const table = account === "miles" ? milesLedger : hintLedger;
            const [row] = await tx
              .select({ delta: table.delta })
              .from(table)
              .where(and(eq(table.playerId, principal), eq(table.kind, kind), eq(table.ref, ref)));
            return row?.delta ?? null;
          },
        };
        const step = await fn(locked);

        const profileChanged = step.profile?.activeRank !== undefined && step.profile.activeRank !== player.activeRank;
        if (!step.change && !profileChanged) {
          if (step.republish) await enqueueMirror(tx, principal, player.version, now);
          return { kind: "ok", value: step.value, player };
        }

        const change = step.change ?? {};
        const statusPoints = change.statusPoints ?? 0;
        if (!Number.isInteger(statusPoints) || statusPoints < 0) throw new Error("Status Points credit must be >= 0.");
        const postings = (change.postings ?? []).filter((posting) => {
          if (!Number.isInteger(posting.delta)) throw new Error("Ledger delta must be an integer.");
          return posting.delta !== 0;
        });
        const sum = (account: "miles" | "hints") =>
          postings.filter((posting) => posting.account === account).reduce((total, posting) => total + posting.delta, 0);
        const miles = sum("miles");
        const hints = sum("hints");
        // Checked before any ledger insert, so a refusal is never masked by a ledger UNIQUE violation.
        if (player.miles + miles < 0) throw new InsufficientBalance("miles");
        if (player.hints + hints < 0) throw new InsufficientBalance("hints");
        for (const posting of postings) {
          const table = posting.account === "miles" ? milesLedger : hintLedger;
          await tx
            .insert(table)
            .values({ playerId: principal, delta: posting.delta, kind: posting.kind, ref: posting.ref, createdAt: now });
        }

        const [updated] = await tx
          .update(players)
          .set({
            statusPoints: sql`${players.statusPoints} + ${statusPoints}`,
            miles: sql`${players.miles} + ${miles}`,
            hints: sql`${players.hints} + ${hints}`,
            ...(change.perfectStreak !== undefined ? { perfectStreak: change.perfectStreak } : {}),
            ...(change.firstClassUntil !== undefined ? { firstClassUntil: change.firstClassUntil } : {}),
            ...(profileChanged ? { activeRank: step.profile?.activeRank ?? null } : {}),
            version: sql`${players.version} + 1`,
            updatedAt: now,
          })
          .where(eq(players.id, principal))
          .returning();
        // The row is locked, so it cannot vanish between the SELECT and the UPDATE.
        if (!updated) throw new Error("Locked player row was not updated.");
        await enqueueMirror(tx, principal, updated.version, now);
        return { kind: "ok", value: step.value, player: updated };
      });
    } catch (error) {
      if (error instanceof InsufficientBalance) return { kind: "insufficient", account: error.account };
      throw error;
    }
  }
}
