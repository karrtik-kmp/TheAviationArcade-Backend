import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { PlayerBalance } from "../balance/player-balance.js";
import { DatabaseService } from "../database/database.module.js";
import type { BalanceChange, Step } from "../balance/player-balance.js";
import { trips } from "../db/schema.js";
import type { PlayerRow } from "../db/schema.js";
import type { ModuleId } from "../rules/modules.js";
import { activeRankFor, certifiedRankFor, isPleasureCruise } from "../rules/ranks.js";
import { FLIGHTS_PER_TRIP, localDateMatches } from "../rules/trips.js";
import {
  abandonOpenRounds,
  abandonTrip,
  goneReason,
  isExpired,
  isFull,
  lockOpenTrip,
  lockTrip,
  newExpiry,
  streakReset,
  tripView,
  withLiveStreak,
} from "./trip-store.js";
import type { TripView } from "./trip-store.js";
import { completeFullTrip, completionChange, storedCompletion } from "./trip-completion.js";
import type { CompletionLists } from "./trip-completion.js";

export type OpenTripInput = {
  module: ModuleId;
  localDate: string;
  utcOffsetMinutes: number;
  contentVersion: string;
};

export type OpenTripOutcome =
  | { kind: "opened" | "replayed"; trip: TripView; player: PlayerRow }
  | { kind: "no_player" }
  | { kind: "local_date_mismatch" }
  /** The Idempotency-Key was used before with a different request (U14: a key names one intent). */
  | { kind: "idempotency_key_reused" };

export type AbandonTripOutcome =
  | { kind: "abandoned"; trip: TripView; replayed: boolean; player: PlayerRow }
  | { kind: "not_found" }
  | { kind: "full" }
  | { kind: "closed" };

export type CompleteTripOutcome =
  | { kind: "completed"; completion: CompletionLists; replayed: boolean; player: PlayerRow }
  | { kind: "not_found" }
  /** Fewer than ten banked Rounds (409 trip_incomplete). */
  | { kind: "incomplete" }
  /** Open with fewer than ten banked Rounds and past its expiry (410 trip_expired); it is marked abandoned. */
  | { kind: "expired" }
  /** Abandoned (or superseded): 410 trip_closed. */
  | { kind: "closed" };

/**
 * Flight Segment lifecycle (Unity "Trip"): open, abandon and complete. Rounds join a segment in RoundsService. Every
 * write goes through PlayerBalance.update, which takes the player row lock first; the segment row is locked next and
 * the Round after it (player -> trip -> Round -> counters / Cards / awards).
 */
@Injectable()
export class TripsService {
  constructor(
    private readonly balance: PlayerBalance,
    private readonly database: DatabaseService,
  ) {}

  /** Every Progress this service returns reads the Perfect Streak through withLiveStreak (U13, lazy expiry), replays included. */
  private live(player: PlayerRow, now: Date): Promise<PlayerRow> {
    return withLiveStreak(this.database.db, player, now);
  }

  /**
   * Open a segment at the player's Active Rank (Pleasure Cruise snapshotted with it). The player's open segment is
   * abandoned with its open Round and the Perfect Streak starts at 0 (D-3; the stored streak is reset only when it is
   * not already 0, so an opening that changes nothing visible does not bump the version).
   *
   * Idempotency-Key (U14): the key is stored on the segment, UNIQUE per player. A repeat answers with that segment as it
   * stands now and changes nothing, before any other check (a retry after a dropped response must not abandon what it
   * just opened, even when its `localDate` has since aged out of the tolerance).
   *
   * A full open segment (ten banked Rounds) is COMPLETED first, in the same transaction (design 2 rule 4, U4): its Cards,
   * counters, awards and Trip hint are recorded exactly as `POST /v1/trips/{id}/complete` would, and that endpoint then
   * answers the stored lists as a replay. The opening response does not carry them. A segment with fewer than ten Rounds
   * is abandoned as before.
   */
  async openTrip(principal: string, idempotencyKey: string, input: OpenTripInput, now: Date): Promise<OpenTripOutcome> {
    type Inner =
      | { kind: "opened"; trip: TripView }
      | { kind: "replayed"; trip: TripView }
      | { kind: "local_date_mismatch" }
      | { kind: "idempotency_key_reused" };
    const result = await this.balance.update<Inner>(principal, now, async ({ player, tx }): Promise<Step<Inner>> => {
      const [existing] = await tx
        .select()
        .from(trips)
        .where(and(eq(trips.playerId, principal), eq(trips.idempotencyKey, idempotencyKey)))
        .for("update");
      if (existing) {
        // Compare the immutable intent before date freshness: unchanged retries still replay after midnight.
        // flightCount is fixed by the boundary schema; the remaining request fields are stored on the Trip.
        if (
          existing.module !== input.module ||
          existing.localDate !== input.localDate ||
          existing.utcOffsetMinutes !== input.utcOffsetMinutes ||
          existing.contentVersion !== input.contentVersion
        ) return { value: { kind: "idempotency_key_reused" } };
        return { value: { kind: "replayed", trip: await tripView(tx, existing, player.perfectStreak, now) } };
      }

      if (!localDateMatches(input.localDate, now, input.utcOffsetMinutes)) return { value: { kind: "local_date_mismatch" } };

      const open = await lockOpenTrip(tx, principal);
      let change: BalanceChange | undefined = streakReset(player).change;
      let completed = false;
      if (open && isFull(open)) {
        const done = await completeFullTrip(tx, principal, open, now);
        change = completionChange(player, done.postings);
        completed = true;
      } else if (open) {
        await abandonTrip(tx, principal, open, now);
      }
      // A stray open Round of a pre-segment dev row would break the one-open-Round index.
      await abandonOpenRounds(tx, principal);

      const rank = activeRankFor(player.statusPoints, player.activeRank);
      const [row] = await tx
        .insert(trips)
        .values({
          id: randomUUID(),
          playerId: principal,
          idempotencyKey,
          module: input.module,
          rank,
          pleasureCruise: isPleasureCruise(certifiedRankFor(player.statusPoints), rank),
          status: "open",
          flightCount: FLIGHTS_PER_TRIP,
          roundsBanked: 0,
          localDate: input.localDate,
          utcOffsetMinutes: input.utcOffsetMinutes,
          contentVersion: input.contentVersion,
          openedAt: now,
          expiresAt: newExpiry(now),
        })
        .returning();
      if (!row) throw new Error("Flight Segment was not stored.");
      return {
        value: { kind: "opened", trip: await tripView(tx, row, 0, now) },
        ...(change ? { change } : {}),
        // The "write at Trip end" trigger: the completed segment's copy is due now (C3).
        ...(completed ? { republish: true as const, mirrorNow: true as const } : {}),
      };
    });
    if (result.kind === "no_player") return { kind: "no_player" };
    // Neither an open (which may post a trip_grant hint through the implicit completion) nor a Trip hint can be refused for funds: only additions post.
    if (result.kind === "insufficient") throw new Error("Opening a Flight Segment was refused for funds.");
    const value = result.value;
    if (value.kind === "opened") return { kind: "opened", trip: value.trip, player: await this.live(result.player, now) };
    if (value.kind === "replayed") return { kind: "replayed", trip: value.trip, player: await this.live(result.player, now) };
    return value;
  }

  /**
   * Abandon the player's own segment. banked < 10: abandoned (its open Round too, Perfect Streak back to 0), or a
   * replay when it is already abandoned or expired. All ten banked: `full` (complete it instead). Completed: `closed`.
   * A segment of another player, or one that does not exist, is `not_found`.
   */
  async abandonTrip(principal: string, tripId: string, now: Date): Promise<AbandonTripOutcome> {
    type Inner = Exclude<AbandonTripOutcome, { kind: "abandoned" }> | { kind: "abandoned"; trip: TripView; replayed: boolean };
    const result = await this.balance.update<Inner>(principal, now, async ({ player, tx }) => {
      const trip = await lockTrip(tx, principal, tripId);
      if (!trip) return { value: { kind: "not_found" } };
      if (trip.status === "completed") return { value: { kind: "closed" } };
      if (trip.status === "abandoned") {
        return { value: { kind: "abandoned", replayed: true, trip: await tripView(tx, trip, 0, now) } };
      }
      if (isFull(trip)) return { value: { kind: "full" } };

      const replayed = isExpired(trip, now);
      await abandonTrip(tx, principal, trip, now);
      const [closed] = await tx.select().from(trips).where(eq(trips.id, trip.id));
      if (!closed) throw new Error("Flight Segment vanished under its lock.");
      return { value: { kind: "abandoned", replayed, trip: await tripView(tx, closed, 0, now) }, ...streakReset(player) };
    });
    if (result.kind === "no_player") return { kind: "not_found" };
    if (result.kind === "insufficient") throw new Error("Abandoning a Flight Segment was refused for funds.");
    const value = result.value;
    if (value.kind === "abandoned") return { ...value, player: await this.live(result.player, now) };
    return value;
  }

  /**
   * Complete the player's own segment (slice T3). All ten Rounds banked: in this one transaction the outcome, the
   * counters (Go Around, Red-Eye ...), the Clipper Cards, all 28 Field Awards and the Trip hint (+1 on every 4th
   * completed segment, `trip_grant`, ref = tripId) are written, the Perfect Streak returns to 0, and the UGS copy is
   * republished at once (`mirrorNow`, the "write at Trip end" trigger). The player lock serialises concurrent calls:
   * exactly one completes, the rest find it completed and replay.
   *
   * Idempotent: a completed segment answers the stored lists (same awards, Cards and hint, read back from the tables) with
   * `replayed: true` and writes nothing. A full segment completes even after `expiresAt`. Fewer than ten banked Rounds:
   * `incomplete`, except that an open segment past its expiry is `expired` (and is marked abandoned, releasing the streak,
   * as every route does). An abandoned segment is `closed`. ASSUMPTION: expiry wins over incomplete.
   */
  async completeTrip(principal: string, tripId: string, now: Date): Promise<CompleteTripOutcome> {
    type Inner =
      | Exclude<CompleteTripOutcome, { kind: "completed" } | { kind: "closed" } | { kind: "expired" }>
      | { kind: "expired" }
      | { kind: "closed" }
      | { kind: "completed"; completion: CompletionLists; replayed: boolean };
    const result = await this.balance.update<Inner>(principal, now, async (locked): Promise<Step<Inner>> => {
      const { player, tx } = locked;
      const trip = await lockTrip(tx, principal, tripId);
      if (!trip) return { value: { kind: "not_found" } };
      if (trip.status === "completed") {
        return { value: { kind: "completed", replayed: true, completion: await storedCompletion(locked, principal, trip) } };
      }
      if (trip.status === "abandoned") {
        return { value: { kind: goneReason(trip, now) === "expired" ? "expired" : "closed" } };
      }
      if (!isFull(trip)) {
        if (isExpired(trip, now)) {
          await abandonTrip(tx, principal, trip, now);
          return { value: { kind: "expired" }, ...streakReset(player) };
        }
        return { value: { kind: "incomplete" } };
      }
      const done = await completeFullTrip(tx, principal, trip, now);
      const change = completionChange(player, done.postings);
      return {
        value: { kind: "completed", replayed: false, completion: done.completion },
        ...(change ? { change } : {}),
        republish: true,
        mirrorNow: true,
      };
    });
    if (result.kind === "no_player") return { kind: "not_found" };
    // A Trip hint only adds hints, so the step can never be refused for funds.
    if (result.kind === "insufficient") throw new Error("Completing a Flight Segment was refused for funds.");
    const value = result.value;
    if (value.kind === "completed") return { ...value, player: await this.live(result.player, now) };
    return value;
  }
}
