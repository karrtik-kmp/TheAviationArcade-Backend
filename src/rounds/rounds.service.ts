import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { PlayerBalance } from "../balance/player-balance.js";
import { DatabaseService } from "../database/database.module.js";
import type { Tx } from "../database/database.module.js";
import type { Posting } from "../balance/player-balance.js";
import { contentItems, playerCounters, rounds, trips } from "../db/schema.js";
import type { PlayerCountersRow, PlayerRow, RoundRow } from "../db/schema.js";
import { militaryCardKey } from "../rules/clipper-cards.js";
import { checkFlightFacts } from "../rules/flight-facts.js";
import type { ModuleId } from "../rules/modules.js";
import { HINTS_PER_ROUND } from "../rules/hints.js";
import { bankRound } from "../rules/banking.js";
import type { Rank } from "../rules/ranks.js";
import type { Completion, RoundAward } from "../rules/scoring.js";
import { EMPTY_COUNTERS, localDateTimeOf, recordPlayedDay } from "../rules/trips.js";
import type { PlayerCounters } from "../rules/trips.js";
import {
  abandonOpenRounds,
  abandonTrip,
  goneReason,
  isExpired,
  isFull,
  lockTrip,
  newExpiry,
  streakReset,
  withLiveStreak,
} from "../trips/trip-store.js";

export const ROUND_TTL_SECONDS = 30 * 60;

/**
 * PROVISIONAL. A result arriving sooner than this after the Round was issued is refused as
 * impossibly fast. Per-module and per-rank timer lengths are not specified yet (only ATC Match and
 * Call Sign Match have one), so this is a single floor to stop instant-submit farming. Needs Josh.
 */
export const MIN_ROUND_MS = 3000;

export type IssuedRound = {
  roundId: string;
  module: ModuleId;
  rank: Rank;
  pleasureCruise: boolean;
  expiresAt: string;
  tripId: string;
  /** 1-10: the Round's place in its Flight Segment (Unity "Flight n of the Trip"). */
  flightNumber: number;
};

/** The Flight facts of a result (design 3.2). `aircraftKey` and the module rules are checked in checkFlightFacts. */
export type RoundResultInput = {
  finished: boolean;
  errorCount: number;
  usedHint: boolean;
  timeRemainingFraction: number;
  aircraftKey: string | null;
  answerMs: number;
  attempts: number;
};

export type HintGrant = { kind: "trip_grant" | "day_streak_grant"; hints: number; ref: string };

export type RoundTripState = { tripId: string; roundsBanked: number; perfectStreak: number };

export type CompletedRound = {
  award: RoundAward & { firstClassPass: boolean; pleasureCruise: boolean };
  player: PlayerRow;
  promotion: { from: Rank; to: Rank } | null;
  replayed: boolean;
  hintGrants: HintGrant[];
  /** Where the Flight Segment stands after this Round (on a replay: where it stands now). null: a pre-segment dev row. */
  trip: RoundTripState | null;
};

export type IssueRoundOutcome =
  | { kind: "issued"; round: IssuedRound }
  | { kind: "no_player" }
  | { kind: "trip_not_found" }
  | { kind: "trip_full" }
  | { kind: "trip_expired" }
  | { kind: "trip_closed" };

export type CompleteRoundOutcome =
  | { kind: "completed"; result: CompletedRound }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "closed" }
  | { kind: "trip_expired" }
  | { kind: "too_fast" }
  /** The Flight facts break a module rule (400 invalid_request); nothing was banked. */
  | { kind: "invalid_facts"; reason: string };

export type SpendHintOutcome =
  | { kind: "spent"; player: PlayerRow; replayed: boolean }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "closed" }
  | { kind: "no_hints" };

function storedAward(round: RoundRow): CompletedRound["award"] {
  return {
    completion: (round.completion as Completion | null) ?? "unfinished",
    speedBonus: round.speedBonus === true,
    streakMiles: round.streakMiles ?? 0,
    statusPoints: round.spAwarded ?? 0,
    miles: round.milesAwarded ?? 0,
    firstClassPass: round.firstClassPass === true,
    pleasureCruise: round.pleasureCruise,
  };
}

function toCounters(row: PlayerCountersRow): PlayerCounters {
  return {
    tripsCompleted: row.tripsCompleted,
    flightsCompleted: row.flightsCompleted,
    correctFlights: row.correctFlights,
    allCorrectTrips: row.allCorrectTrips,
    milesEarned: row.milesEarned,
    bestTripStreak: row.bestTripStreak,
    identifierFullTrips: row.identifierFullTrips,
    perfectFlightStreak: row.perfectFlightStreak,
    bestPerfectFlightStreak: row.bestPerfectFlightStreak,
    hintFreeTripStreak: row.hintFreeTripStreak,
    bestHintFreeTripStreak: row.bestHintFreeTripStreak,
    nightTrips: row.nightTrips,
    goArounds: row.goArounds,
    previousTripOutcome: row.previousTripOutcome,
    lastPlayedDate: row.lastPlayedDate,
    flightsOnLastPlayedDate: row.flightsOnLastPlayedDate,
    dayStreak: row.dayStreak,
    bestDayStreak: row.bestDayStreak,
  };
}

/**
 * Round lifecycle inside a Flight Segment. Every write goes through PlayerBalance.update, which first takes the player's
 * row lock (SELECT ... FOR UPDATE), so all writes for one player are serialised and a result can never build on a stale
 * streak or balance. The segment row is locked next and the Round after it: lock order is always player, trip, Round.
 * Nothing is ever retried or overwritten.
 */
@Injectable()
export class RoundsService {
  constructor(
    private readonly balance: PlayerBalance,
    private readonly database: DatabaseService,
  ) {}

  /**
   * Issue a Round in an open Flight Segment (module, rank and Pleasure Cruise come from the segment's snapshot). The
   * Round is the segment's next flight number (banked + 1); issuing while the segment's current Round is still open
   * abandons that Round and the new one keeps the same number (U5; a spent hint is not refunded). The player's other
   * open Rounds are abandoned in the same transaction, so only one Round can be in flight. A full segment refuses
   * (`trip_full`: complete it). The segment's 30 minute expiry restarts here (U4).
   */
  async issueRound(principal: string, tripId: string, now: Date): Promise<IssueRoundOutcome> {
    const result = await this.balance.update<IssueRoundOutcome>(principal, now, async ({ player, tx }) => {
      const trip = await lockTrip(tx, principal, tripId);
      if (!trip) return { value: { kind: "trip_not_found" } };
      if (trip.status !== "open") {
        return { value: { kind: goneReason(trip, now) === "expired" ? "trip_expired" : "trip_closed" } };
      }
      if (isFull(trip)) return { value: { kind: "trip_full" } };
      if (isExpired(trip, now)) {
        // Marked now so the Perfect Streak (the segment's) is released; the answer is the same for every later call.
        await abandonTrip(tx, principal, trip, now);
        return { value: { kind: "trip_expired" }, ...streakReset(player) };
      }

      const roundId = randomUUID();
      const flightNumber = trip.roundsBanked + 1;
      const expiresAt = new Date(now.getTime() + ROUND_TTL_SECONDS * 1000);
      await abandonOpenRounds(tx, principal);
      await tx.insert(rounds).values({
        id: roundId,
        playerId: principal,
        module: trip.module,
        rank: trip.rank,
        pleasureCruise: trip.pleasureCruise,
        tripId: trip.id,
        flightNumber,
        issuedAt: now,
        expiresAt,
      });
      await tx.update(trips).set({ expiresAt: newExpiry(now) }).where(eq(trips.id, trip.id));
      // Lock only: issuing a Round changes nothing the player sees.
      return {
        value: {
          kind: "issued",
          round: {
            roundId,
            module: trip.module as ModuleId,
            rank: trip.rank as Rank,
            pleasureCruise: trip.pleasureCruise,
            expiresAt: expiresAt.toISOString(),
            tripId: trip.id,
            flightNumber,
          },
        },
      };
    });
    if (result.kind === "no_player") return { kind: "no_player" };
    if (result.kind === "insufficient") throw new Error("Issuing a Round was refused for funds.");
    return result.value;
  }

  /**
   * Score and bank a Round. A Round belonging to another player is reported as not found. Resubmitting
   * a completed Round returns the stored award without paying again, so a client retry after a dropped
   * response is safe. A completed Round is a progress event: it bumps the version and queues the UGS copy
   * even when it pays nothing.
   *
   * The award is computed from the segment's own Perfect Streak (D-3: the stored streak is reset whenever a segment
   * opens or closes). The Round's local day (server time + the segment's offset) feeds the day streak, and every 7th
   * consecutive day posts one `day_streak_grant` hint in the same transaction. The Flight facts are checked against the
   * module rules before anything is written; a failing fact banks nothing.
   */
  async completeRound(
    principal: string,
    roundId: string,
    input: RoundResultInput,
    now: Date,
  ): Promise<CompleteRoundOutcome> {
    type Inner =
      | Exclude<CompleteRoundOutcome, { kind: "completed" }>
      | { kind: "completed"; result: Omit<CompletedRound, "player"> };
    const result = await this.balance.update<Inner>(principal, now, async ({ player, tx }) => {
      // Lock order player -> trip -> Round: find the segment first, lock it, then lock the Round.
      const [peek] = await tx
        .select({ tripId: rounds.tripId })
        .from(rounds)
        .where(and(eq(rounds.id, roundId), eq(rounds.playerId, principal)));
      if (!peek) return { value: { kind: "not_found" } };
      const trip = peek.tripId ? await lockTrip(tx, principal, peek.tripId) : null;
      const [round] = await tx
        .select()
        .from(rounds)
        .where(and(eq(rounds.id, roundId), eq(rounds.playerId, principal)))
        .for("update");
      if (!round) return { value: { kind: "not_found" } };

      if (round.status === "completed") {
        return {
          value: {
            kind: "completed",
            result: {
              award: storedAward(round),
              promotion:
                round.promotedFrom && round.promotedTo
                  ? { from: round.promotedFrom as Rank, to: round.promotedTo as Rank }
                  : null,
              replayed: true,
              hintGrants:
                round.dayStreakGrant && round.localDate
                  ? [{ kind: "day_streak_grant", hints: 1, ref: round.localDate }]
                  : [],
              trip: trip
                ? {
                    tripId: trip.id,
                    roundsBanked: trip.roundsBanked,
                    perfectStreak: trip.status === "open" && !isExpired(trip, now) ? player.perfectStreak : 0,
                  }
                : null,
            },
          },
        };
      }
      // A Round without a segment predates Flight Segments (local dev data) and can no longer be banked.
      if (!trip || round.flightNumber === null) return { value: { kind: "closed" } };
      // The Round's own clock decides first and stays decided: a retry says round_expired whatever happened to the segment
      // since (marked abandoned, replaced by a newer segment, the Round itself abandoned by that).
      if (now.getTime() > round.expiresAt.getTime()) {
        // The segment's clock restarted when this Round was issued, so it ran out too. Release the streak.
        if (isExpired(trip, now)) {
          await abandonTrip(tx, principal, trip, now);
          return { value: { kind: "expired" }, ...streakReset(player) };
        }
        return { value: { kind: "expired" } };
      }
      // Defensive (the Round's and the segment's clocks share the same start, so this is not a normal outcome): the segment
      // ran out although this Round did not.
      if (isExpired(trip, now)) {
        await abandonTrip(tx, principal, trip, now);
        return { value: { kind: "trip_expired" }, ...streakReset(player) };
      }
      // Superseded Round, or its segment was closed: a segment that expired keeps saying trip_expired, not closed.
      if (round.status === "abandoned" || trip.status !== "open") {
        return { value: { kind: goneReason(trip, now) === "expired" ? "trip_expired" : "closed" } };
      }
      // Refused without closing the Round, so the client can retry after a moment.
      if (now.getTime() < round.issuedAt.getTime() + MIN_ROUND_MS) return { value: { kind: "too_fast" } };
      // Defence in depth: a Round banks only into the slot it was issued for.
      if (round.flightNumber !== trip.roundsBanked + 1) return { value: { kind: "closed" } };

      const checked = checkFlightFacts(
        {
          module: round.module as ModuleId,
          finished: input.finished,
          errorCount: input.errorCount,
          attempts: input.attempts,
          answerMs: input.answerMs,
          aircraftKey: input.aircraftKey,
        },
        now.getTime() - round.issuedAt.getTime(),
      );
      if (!checked.ok) return { value: { kind: "invalid_facts", reason: checked.reason } };
      let cardKey = checked.commercialKey;
      if (checked.militaryItemId !== null) {
        cardKey = await militaryKeyOf(tx, checked.militaryItemId);
        if (cardKey === null) return { value: { kind: "invalid_facts", reason: "aircraftKey is not a known Military question." } };
      }

      const banked = bankRound(
        { statusPoints: player.statusPoints, perfectStreak: player.perfectStreak, firstClassUntil: player.firstClassUntil },
        {
          finished: input.finished,
          errorCount: input.errorCount,
          usedHint: input.usedHint,
          timeRemainingFraction: input.timeRemainingFraction,
          pleasureCruise: round.pleasureCruise,
          hintPaid: round.hintUsed,
        },
        now,
      );
      const { award, promotion } = banked;

      // The local day and the day streak (design 3.3). The phone clock never enters: server time + the segment's offset.
      const localDay = localDateTimeOf(now, trip.utcOffsetMinutes).date;
      const [countersRow] = await tx.select().from(playerCounters).where(eq(playerCounters.playerId, principal));
      const played = recordPlayedDay(countersRow ? toCounters(countersRow) : EMPTY_COUNTERS, localDay);
      const dayFields = {
        lastPlayedDate: played.counters.lastPlayedDate,
        flightsOnLastPlayedDate: played.counters.flightsOnLastPlayedDate,
        dayStreak: played.counters.dayStreak,
        bestDayStreak: played.counters.bestDayStreak,
        updatedAt: now,
      };
      await tx
        .insert(playerCounters)
        .values({ playerId: principal, ...dayFields })
        .onConflictDoUpdate({ target: playerCounters.playerId, set: dayFields });

      await tx
        .update(rounds)
        .set({
          status: "completed",
          completionId: randomUUID(),
          completedAt: now,
          finished: input.finished,
          errorCount: input.errorCount,
          usedHint: banked.usedHint,
          timeRemaining: input.timeRemainingFraction,
          completion: award.completion,
          speedBonus: award.speedBonus,
          streakMiles: award.streakMiles,
          firstClassPass: award.firstClassPass,
          spAwarded: award.statusPoints,
          milesAwarded: award.miles,
          promotedFrom: promotion?.from ?? null,
          promotedTo: promotion?.to ?? null,
          aircraftKey: input.aircraftKey,
          cardKey,
          answerMs: input.answerMs,
          attempts: input.attempts,
          localDate: localDay,
          dayStreakGrant: played.hintGrant === 1,
        })
        .where(eq(rounds.id, roundId));
      await tx
        .update(trips)
        .set({ roundsBanked: trip.roundsBanked + 1, expiresAt: newExpiry(now) })
        .where(eq(trips.id, trip.id));

      const postings: Posting[] = [{ account: "miles", delta: banked.balanceDelta.miles, kind: "round_award", ref: roundId }];
      const hintGrants: HintGrant[] = [];
      if (played.hintGrant === 1) {
        postings.push({ account: "hints", delta: 1, kind: "day_streak_grant", ref: localDay });
        hintGrants.push({ kind: "day_streak_grant", hints: 1, ref: localDay });
      }

      return {
        value: {
          kind: "completed",
          result: {
            award,
            promotion,
            replayed: false,
            hintGrants,
            trip: { tripId: trip.id, roundsBanked: trip.roundsBanked + 1, perfectStreak: banked.streak },
          },
        },
        // One ledger entry per Round (the unique key makes a double pay impossible); a zero award writes none.
        change: {
          postings,
          statusPoints: banked.balanceDelta.statusPoints,
          perfectStreak: banked.streak,
        },
      };
    });
    // A Round result for a deleted player is a missing Round (asserted contract: 404 round_not_found).
    if (result.kind !== "ok") return { kind: "not_found" };
    const value = result.value;
    if (value.kind === "completed") return { kind: "completed", result: { ...value.result, player: result.player } };
    return value;
  }

  /**
   * Spend the Round's one hint (HINTS_PER_ROUND). Idempotent: a Round that already has its hint answers
   * with replayed = true and debits nothing, whatever state the Round has moved on to. Otherwise only the
   * player's own open, unexpired Round qualifies. A debit the balance cannot cover rolls back the Round's
   * hintUsed mark with it.
   */
  async spendHint(principal: string, roundId: string, now: Date): Promise<SpendHintOutcome> {
    type Inner = Exclude<SpendHintOutcome, { kind: "spent" }> | { kind: "spent"; replayed: boolean };
    const result = await this.balance.update<Inner>(principal, now, async ({ tx }) => {
      // Lock order player -> trip -> Round.
      const [peek] = await tx
        .select({ tripId: rounds.tripId })
        .from(rounds)
        .where(and(eq(rounds.id, roundId), eq(rounds.playerId, principal)));
      if (!peek) return { value: { kind: "not_found" } };
      const trip = peek.tripId ? await lockTrip(tx, principal, peek.tripId) : null;
      const [round] = await tx
        .select()
        .from(rounds)
        .where(and(eq(rounds.id, roundId), eq(rounds.playerId, principal)))
        .for("update");
      if (!round) return { value: { kind: "not_found" } };

      if (round.hintUsed) return { value: { kind: "spent", replayed: true } };
      if (round.status !== "open") return { value: { kind: "closed" } };
      if (now.getTime() > round.expiresAt.getTime()) return { value: { kind: "expired" } };
      // A hint is spent inside a live segment only.
      if (trip && trip.status !== "open") return { value: { kind: "closed" } };
      if (trip && isExpired(trip, now)) return { value: { kind: "expired" } };

      await tx.update(rounds).set({ hintUsed: true }).where(eq(rounds.id, roundId));
      return {
        value: { kind: "spent", replayed: false },
        change: { postings: [{ account: "hints", delta: -HINTS_PER_ROUND, kind: "round_spend", ref: roundId }] },
      };
    });
    if (result.kind === "no_player") return { kind: "not_found" };
    if (result.kind === "insufficient") return { kind: "no_hints" };
    const value = result.value;
    if (value.kind === "spent") {
      return { kind: "spent", player: await withLiveStreak(this.database.db, result.player, now), replayed: value.replayed };
    }
    return value;
  }
}

/**
 * The Clipper Card key of a Military question (design 3.5): the key FROZEN on the content item. An item imported before
 * the key existed gets it now, from its answer text as stored at this moment, and keeps it from then on (staff text
 * edits never move it). null: no such item (approved or retired both count, A6) or an item without an answer.
 */
async function militaryKeyOf(tx: Tx, itemId: string): Promise<string | null> {
  const where = and(eq(contentItems.module, "aircraft-identifier-military"), eq(contentItems.id, itemId));
  const [item] = await tx.select({ cardKey: contentItems.cardKey, data: contentItems.data }).from(contentItems).where(where);
  if (!item) return null;
  if (item.cardKey) return item.cardKey;
  const answer = (item.data as { answer?: unknown } | null)?.answer;
  const key = typeof answer === "string" ? militaryCardKey(answer) : "";
  if (key === "") return null;
  const [frozen] = await tx
    .update(contentItems)
    .set({ cardKey: key })
    .where(and(where, isNull(contentItems.cardKey)))
    .returning({ cardKey: contentItems.cardKey });
  if (frozen?.cardKey) return frozen.cardKey;
  // Frozen by someone else between our read and write: theirs wins.
  const [again] = await tx.select({ cardKey: contentItems.cardKey }).from(contentItems).where(where);
  return again?.cardKey ?? key;
}
