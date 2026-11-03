import { and, eq, sql } from "drizzle-orm";
import type { BalanceChange } from "../balance/player-balance.js";
import { databaseClock } from "../database/clock.js";
import type { Database, Tx } from "../database/database.module.js";
import { rounds, trips } from "../db/schema.js";
import type { PlayerRow, TripRow } from "../db/schema.js";
import type { ModuleId } from "../rules/modules.js";
import type { Rank } from "../rules/ranks.js";
import { FLIGHTS_PER_TRIP } from "../rules/trips.js";

/**
 * Shared Flight Segment (Unity "Trip") persistence helpers for TripsService and RoundsService. Plain functions over the
 * caller's transaction: every caller is inside PlayerBalance.update, so the player row is already locked and the lock
 * order is player -> trip -> Round. Nothing here opens a transaction, locks a player or writes a balance.
 */
export const TRIP_TTL_SECONDS = 30 * 60;

export type TripStatusView = "open" | "completed" | "abandoned";

/** A segment as the API returns it (`FlightSegment`). */
export type TripView = {
  tripId: string;
  module: ModuleId;
  rank: Rank;
  pleasureCruise: boolean;
  status: TripStatusView;
  flightCount: number;
  roundsBanked: number;
  currentRoundId: string | null;
  perfectStreak: number;
  localDate: string;
  utcOffsetMinutes: number;
  contentVersion: string;
  openedAt: string;
  expiresAt: string;
  closedAt: string | null;
};

export function isFull(trip: Pick<TripRow, "roundsBanked">): boolean {
  return trip.roundsBanked >= FLIGHTS_PER_TRIP;
}

/**
 * U4: an open segment with fewer than ten banked Rounds is expired once `now` passes `expiresAt`. A full one never
 * expires (it waits to be completed). Expiry is lazy: nothing sweeps, every route that touches the segment decides.
 */
export function isExpired(trip: Pick<TripRow, "status" | "roundsBanked" | "expiresAt">, now: Date): boolean {
  return trip.status === "open" && !isFull(trip) && now.getTime() > trip.expiresAt.getTime();
}

/** Why a segment that is no longer usable is gone: it expired (also when closed by a later write) or was closed. */
export function goneReason(trip: TripRow, now: Date): "expired" | "closed" {
  if (isExpired(trip, now)) return "expired";
  // A lazily expired segment is closed at its `expiresAt`; a player's abandon or a newer segment closes it earlier.
  if (trip.status === "abandoned" && trip.closedAt && trip.closedAt.getTime() >= trip.expiresAt.getTime()) return "expired";
  return "closed";
}

export function newExpiry(now: Date): Date {
  return new Date(now.getTime() + TRIP_TTL_SECONDS * 1000);
}

/** Lock the player's own segment (SELECT ... FOR UPDATE). null: unknown or not this player's. */
export async function lockTrip(tx: Tx, principal: string, tripId: string): Promise<TripRow | null> {
  const [trip] = await tx
    .select()
    .from(trips)
    .where(and(eq(trips.id, tripId), eq(trips.playerId, principal)))
    .for("update");
  return trip ?? null;
}

/** Lock the player's open segment, if any (at most one: a unique partial index). */
export async function lockOpenTrip(tx: Tx, principal: string): Promise<TripRow | null> {
  const [trip] = await tx
    .select()
    .from(trips)
    .where(and(eq(trips.playerId, principal), eq(trips.status, "open")))
    .for("update");
  return trip ?? null;
}

/** Abandon every open Round of the player: one in flight at a time (the Round index), and none outlives its segment. */
export async function abandonOpenRounds(tx: Tx, principal: string): Promise<void> {
  await tx
    .update(rounds)
    .set({ status: "abandoned" })
    .where(and(eq(rounds.playerId, principal), eq(rounds.status, "open")));
}

/**
 * Close an open segment as abandoned. An expired segment is closed AT its expiry (so later calls can tell trip_expired
 * from trip_closed) and its open Round is left alone: that Round ran out by its own clock and keeps answering
 * round_expired. Otherwise it is closed now, together with its open Round.
 */
export async function abandonTrip(tx: Tx, principal: string, trip: TripRow, now: Date): Promise<void> {
  const expired = isExpired(trip, now);
  await tx
    .update(trips)
    .set({ status: "abandoned", closedAt: expired ? trip.expiresAt : now })
    .where(eq(trips.id, trip.id));
  if (!expired) await abandonOpenRounds(tx, principal);
}

/** D-3: the stored streak is the open segment's, so closing a segment resets it. Only a nonzero streak is a change. */
export function streakReset(player: Pick<PlayerRow, "perfectStreak">): { change?: BalanceChange } {
  return player.perfectStreak === 0 ? {} : { change: { perfectStreak: 0 } };
}

export async function openRoundId(tx: Tx, tripId: string): Promise<string | null> {
  const [round] = await tx
    .select({ id: rounds.id })
    .from(rounds)
    .where(and(eq(rounds.tripId, tripId), eq(rounds.status, "open")));
  return round?.id ?? null;
}

/**
 * The API view of a segment as of `now` (an expired one reads `abandoned`). `liveStreak` is the player's stored
 * streak: it belongs to the segment only while the segment is open.
 */
export async function tripView(tx: Tx, trip: TripRow, liveStreak: number, now: Date): Promise<TripView> {
  const expired = isExpired(trip, now);
  const status: TripStatusView = expired ? "abandoned" : trip.status;
  const open = status === "open";
  return {
    tripId: trip.id,
    module: trip.module as ModuleId,
    rank: trip.rank as Rank,
    pleasureCruise: trip.pleasureCruise,
    status,
    flightCount: trip.flightCount,
    roundsBanked: trip.roundsBanked,
    currentRoundId: open ? await openRoundId(tx, trip.id) : null,
    perfectStreak: open ? liveStreak : 0,
    localDate: trip.localDate,
    utcOffsetMinutes: trip.utcOffsetMinutes,
    contentVersion: trip.contentVersion,
    openedAt: trip.openedAt.toISOString(),
    expiresAt: trip.expiresAt.toISOString(),
    closedAt: (expired ? trip.expiresAt : trip.closedAt)?.toISOString() ?? null,
  };
}

/** A player row evaluated at one database instant: the Perfect Streak and `evaluatedAt` below are judged at that instant. */
export type LivePlayer = PlayerRow & { evaluatedAt: Date };

/**
 * U13 with lazy expiry: the stored Perfect Streak belongs to the open Flight Segment, so it shows as 0 when no segment is
 * open or the open one has expired and no write has marked it yet. EVERY place that builds a Progress view (the routes and
 * the UGS mirror snapshot) passes the player row through here, so they all agree with GET /v1/me/progress.
 *
 * The instant is the DATABASE clock (`clock_timestamp()` truncated to milliseconds), taken once in the same statement that
 * judges the expiry, and returned as `evaluatedAt`: the stamp and the judgement are one instant, and every instance shares
 * one clock (process clocks can disagree; same reasoning as the ugs_budget). Costs one query per response, streak or not.
 */
export async function withLiveStreak(db: Database | Tx, player: PlayerRow): Promise<LivePlayer> {
  const result = await db.execute(sql`
    SELECT t.at AS at,
           ${player.perfectStreak}::int > 0 AND EXISTS (
             SELECT 1 FROM trips
             WHERE trips.player_id = ${player.id} AND trips.status = 'open'
               AND (trips.expires_at >= t.at OR trips.rounds_banked >= trips.flight_count)
           ) AS open
    FROM (SELECT ${databaseClock()} AS at) t
  `);
  const row = result.rows[0] as { at: Date | string; open: boolean };
  const evaluatedAt = new Date(row.at);
  return { ...player, perfectStreak: row.open ? player.perfectStreak : 0, evaluatedAt };
}

