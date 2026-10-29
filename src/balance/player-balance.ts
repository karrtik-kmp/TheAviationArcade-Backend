import { Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { DatabaseService, ExpectedRollback } from "../database/database.module.js";
import type { Tx } from "../database/database.module.js";
import { hintLedger, milesLedger, players, ugsLinks } from "../db/schema.js";
import type { PlayerRow } from "../db/schema.js";
import type { Rank } from "../rules/ranks.js";
import type { HintKind, MilesKind } from "./ledger-kinds.js";
import { cancelMirrorDeletion, dropMirror, enqueueMirror, queueMirrorDeletion } from "./mirror-outbox.js";

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

export type OpenResult = { player: PlayerRow; created: boolean };

/** Outcome of recording a proven UGS link. `held`: another player holds the UGS id (nothing was written). */
export type LinkResult =
  | { kind: "linked"; created: boolean; linkedAt: Date }
  | { kind: "no_player" }
  | { kind: "held"; holder: string };

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
 *    lock order stays player -> Round. `open()` (INSERT ... ON CONFLICT DO NOTHING) is the one exception, because it
 *    creates the row; `erase()` and `linkUgs()` lock first like `update` (linkUgs locks two players in id order when
 *    it moves a stale link). Nothing outside src/balance locks a player row, writes a ledger, or touches the mirror
 *    queue (test/balance-guard.test.ts). enqueueMirror and the ugs_mirror_deletions writes are private to this module.
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
 * 8. No network calls inside `fn` (or inside linkUgs: the UGS proof happens before it is called).
 * 9. open() creates the player at version 1: the starter postings, their ledger rows and the mirror enqueue are
 *    written by the one creating caller only; everyone else gets the existing row, unchanged.
 * 10. erase() deletes the player (Rounds, ledgers, link and queued mirror cascade) and, if it was linked, records the
 *    UGS player for deletion first. Idempotent; a missing player is `false`.
 * 11. UGS link versions (D-1): a first link enqueues at the CURRENT version and does not bump it (there was no earlier
 *    copy to disagree with). Re-linking to a DIFFERENT UGS player bumps players.version and enqueues. Re-linking the
 *    same UGS player changes nothing (UgsLinkService answers that before any admin call; a race that lands here only
 *    republishes at the current version). A stale-holder move bumps the caller's version; the old holder gets no
 *    bump, it just loses the link and its queued mirror.
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

  /**
   * Create the player on first sign-in. Idempotent and race-safe: ON CONFLICT DO NOTHING means exactly one concurrent
   * caller sees created = true, writes the starter postings and enqueues; an existing player is returned unchanged.
   * The one write that does not lock first, because there is no row to lock yet.
   */
  async open(principal: string, now: Date, starter: BalanceChange): Promise<OpenResult> {
    const postings = (starter.postings ?? []).filter((posting) => {
      if (!Number.isInteger(posting.delta)) throw new Error("Ledger delta must be an integer.");
      return posting.delta !== 0;
    });
    const sum = (account: "miles" | "hints") =>
      postings.filter((posting) => posting.account === account).reduce((total, posting) => total + posting.delta, 0);
    const miles = sum("miles");
    const hints = sum("hints");
    if (miles < 0 || hints < 0) throw new Error("A starting balance cannot be negative.");
    return this.database.withTransaction(async (tx) => {
      const inserted = await tx
        .insert(players)
        .values({ id: principal, miles, hints, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning({ id: players.id, version: players.version });
      const created = inserted.length === 1;
      if (inserted[0]) {
        for (const posting of postings) {
          const table = posting.account === "miles" ? milesLedger : hintLedger;
          await tx
            .insert(table)
            .values({ playerId: principal, delta: posting.delta, kind: posting.kind, ref: posting.ref, createdAt: now });
        }
        // A brand-new player has no UGS link yet (a deleted account's link went with it), so this is a no-op today;
        // it keeps every progress-creating write on the same rule.
        await enqueueMirror(tx, principal, inserted[0].version, now);
      }
      const [player] = await tx.select().from(players).where(eq(players.id, principal));
      if (!player) throw new Error("Player row missing after insert.");
      return { player, created };
    });
  }

  /**
   * Erase this backend data for the principal. Locks the player row first, like every progress write, so an
   * in-flight Round result either commits before the delete or finds no player afterwards (404). The UGS copy cannot
   * be deleted inside this lock (no network), so the UGS id is recorded and the mirror worker deletes the item later.
   * Idempotent. Returns whether a player existed.
   */
  async erase(principal: string, now: Date): Promise<boolean> {
    return this.database.withTransaction(async (tx) => {
      const [player] = await tx.select({ id: players.id }).from(players).where(eq(players.id, principal)).for("update");
      if (!player) return false;
      const [link] = await tx.select().from(ugsLinks).where(eq(ugsLinks.playerId, principal));
      if (link) await queueMirrorDeletion(tx, link.ugsPlayerId, now);
      await tx.delete(players).where(eq(players.id, principal));
      return true;
    });
  }

  /**
   * Record a link that the caller has already PROVEN against UGS (the network proof stays outside; nothing here
   * calls out). `moveFrom` is a stale holder whose link moves to the caller. See invariant 11 for version rules.
   * `held` is returned before anything is written when another player holds the UGS id and is not `moveFrom`.
   * A UNIQUE violation (a racing link of the same UGS id) propagates as a DB error.
   */
  async linkUgs(principal: string, ugsPlayerId: string, now: Date, moveFrom?: string): Promise<LinkResult> {
    return this.database.withTransaction(async (tx): Promise<LinkResult> => {
      // Both players are locked in id order so two opposite moves cannot deadlock.
      const ids = moveFrom ? [principal, moveFrom] : [principal];
      const locked = await tx.select().from(players).where(inArray(players.id, ids)).orderBy(asc(players.id)).for("update");
      const player = locked.find((row) => row.id === principal);
      if (!player) return { kind: "no_player" };

      const [taken] = await tx
        .select({ playerId: ugsLinks.playerId })
        .from(ugsLinks)
        .where(and(eq(ugsLinks.ugsPlayerId, ugsPlayerId), ne(ugsLinks.playerId, principal)));
      if (taken && taken.playerId !== moveFrom) return { kind: "held", holder: taken.playerId };
      if (taken) {
        // The stale holder loses the link and its queued mirror, with no version bump. No deletion is queued: the UGS
        // player is the caller's now, and the caller's next write replaces the item.
        await tx.delete(ugsLinks).where(eq(ugsLinks.playerId, taken.playerId));
        await dropMirror(tx, taken.playerId);
      }

      const [existing] = await tx.select().from(ugsLinks).where(eq(ugsLinks.playerId, principal));
      if (existing && existing.ugsPlayerId === ugsPlayerId) {
        // Already this UGS player (a race): nothing changes, but the copy is republished at the current version.
        await enqueueMirror(tx, principal, player.version, now);
        return { kind: "linked", created: false, linkedAt: existing.linkedAt };
      }
      if (existing) {
        // Replaced: the old UGS player copy is stale and no longer ours to keep.
        await queueMirrorDeletion(tx, existing.ugsPlayerId, now);
        await tx.update(ugsLinks).set({ ugsPlayerId, linkedAt: now }).where(eq(ugsLinks.playerId, principal));
      } else {
        await tx.insert(ugsLinks).values({ playerId: principal, ugsPlayerId, linkedAt: now });
      }
      await cancelMirrorDeletion(tx, ugsPlayerId);

      // D-1: the copy target changed for a re-link to a different UGS player and for a stale-holder move, so those
      // bump the version. A first link has no earlier copy to disagree with: enqueue at the current version, no bump.
      let version = player.version;
      if (existing || taken) {
        const [updated] = await tx
          .update(players)
          .set({ version: sql`${players.version} + 1`, updatedAt: now })
          .where(eq(players.id, principal))
          .returning({ version: players.version });
        if (!updated) throw new Error("Locked player row was not updated.");
        version = updated.version;
      }
      await enqueueMirror(tx, principal, version, now);
      return { kind: "linked", created: !existing, linkedAt: now };
    });
  }
}
