import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { PlayerBalance } from "../balance/player-balance.js";
import { trips } from "../db/schema.js";
import type { PlayerRow } from "../db/schema.js";
import type { ModuleId } from "../rules/modules.js";
import { activeRankFor, certifiedRankFor, isPleasureCruise } from "../rules/ranks.js";
import { FLIGHTS_PER_TRIP, localDateMatches } from "../rules/trips.js";
import {
  abandonOpenRounds,
  abandonTrip,
  isExpired,
  isFull,
  lockOpenTrip,
  lockTrip,
  newExpiry,
  streakReset,
  tripView,
} from "./trip-store.js";
import type { TripView } from "./trip-store.js";

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
  /** The Idempotency-Key was used before for a different module (U14: a key names one request). */
  | { kind: "idempotency_key_reused" }
  /** Interim (T2): the player's open segment has all ten Rounds banked and only `complete` (slice T3) may close it. */
  | { kind: "trip_full"; tripId: string };

export type AbandonTripOutcome =
  | { kind: "abandoned"; trip: TripView; replayed: boolean; player: PlayerRow }
  | { kind: "not_found" }
  | { kind: "full" }
  | { kind: "closed" };

/**
 * Flight Segment lifecycle (Unity "Trip"): open and abandon. Rounds join a segment in RoundsService. Every write goes
 * through PlayerBalance.update, which takes the player row lock first; the segment row is locked next and the Round
 * after it (player -> trip -> Round). Completion is slice T3.
 */
@Injectable()
export class TripsService {
  constructor(private readonly balance: PlayerBalance) {}

  /**
   * Open a segment at the player's Active Rank (Pleasure Cruise snapshotted with it). The player's open segment is
   * abandoned with its open Round and the Perfect Streak starts at 0 (D-3; the stored streak is reset only when it is
   * not already 0, so an opening that changes nothing visible does not bump the version).
   *
   * Idempotency-Key (U14): the key is stored on the segment, UNIQUE per player. A repeat answers with that segment as it
   * stands now and changes nothing, before any other check (a retry after a dropped response must not abandon what it
   * just opened, even when its `localDate` has since aged out of the tolerance).
   *
   * T2 interim: a full open segment (ten banked Rounds) is completed by `POST /v1/trips/{id}/complete`, which arrives
   * with slice T3. Until then opening is refused with `trip_full`; the design's "complete it first" hook is T3's job and
   * abandoning would wrongly throw away its Cards, counters and awards.
   */
  async openTrip(principal: string, idempotencyKey: string, input: OpenTripInput, now: Date): Promise<OpenTripOutcome> {
    type Inner =
      | { kind: "opened"; trip: TripView }
      | { kind: "replayed"; trip: TripView }
      | { kind: "local_date_mismatch" }
      | { kind: "idempotency_key_reused" }
      | { kind: "trip_full"; tripId: string };
    const result = await this.balance.update<Inner>(principal, now, async ({ player, tx }) => {
      const [existing] = await tx
        .select()
        .from(trips)
        .where(and(eq(trips.playerId, principal), eq(trips.idempotencyKey, idempotencyKey)))
        .for("update");
      if (existing) {
        if (existing.module !== input.module) return { value: { kind: "idempotency_key_reused" } };
        return { value: { kind: "replayed", trip: await tripView(tx, existing, player.perfectStreak, now) } };
      }

      if (!localDateMatches(input.localDate, now, input.utcOffsetMinutes)) return { value: { kind: "local_date_mismatch" } };

      const open = await lockOpenTrip(tx, principal);
      if (open && isFull(open)) return { value: { kind: "trip_full", tripId: open.id } };
      if (open) await abandonTrip(tx, principal, open, now);
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
      return { value: { kind: "opened", trip: await tripView(tx, row, 0, now) }, ...streakReset(player) };
    });
    if (result.kind === "no_player") return { kind: "no_player" };
    // A segment open posts nothing, so it can never be refused for funds.
    if (result.kind === "insufficient") throw new Error("Opening a Flight Segment was refused for funds.");
    const value = result.value;
    if (value.kind === "opened") return { kind: "opened", trip: value.trip, player: result.player };
    if (value.kind === "replayed") return { kind: "replayed", trip: value.trip, player: result.player };
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
    if (value.kind === "abandoned") return { ...value, player: result.player };
    return value;
  }
}
