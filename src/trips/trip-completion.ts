import { and, asc, eq, inArray } from "drizzle-orm";
import type { BalanceChange, LockedPlayer, Posting } from "../balance/player-balance.js";
import type { Tx } from "../database/database.module.js";
import { playerClipperCards, playerCounters, playerFieldAwards, rounds, trips } from "../db/schema.js";
import type { ClipperCardRow, PlayerRow, TripRow } from "../db/schema.js";
import { recordSighting } from "../rules/clipper-cards.js";
import type { CardModule, CardRecord } from "../rules/clipper-cards.js";
import { evaluateFieldAwards } from "../rules/field-awards.js";
import type { FieldAwardId } from "../rules/field-awards.js";
import type { ModuleId } from "../rules/modules.js";
import type { Rank } from "../rules/ranks.js";
import { EMPTY_COUNTERS, FLIGHTS_PER_TRIP, applyCompletedTrip, flightFact, localDateTimeOf } from "../rules/trips.js";
import type { FlightFact, TripOutcome } from "../rules/trips.js";
import { catalogInForce } from "./catalog-in-force.js";
import { toCounters } from "./counters-store.js";
import { streakReset } from "./trip-store.js";

/**
 * Completion of a full Flight Segment (design 2, 3.4-3.7; slice T3). Plain functions over the caller's transaction, like
 * trip-store.ts: every caller is inside PlayerBalance.update, so the player row is locked and the order is
 * player -> trip -> Round -> counters / Cards / awards. It writes the segment's result columns, `player_counters`, the
 * Card records and the earned Field Awards, and RETURNS the hint posting for PlayerBalance to apply. No network call.
 *
 * Two callers: `POST /v1/trips/{id}/complete` and `POST /v1/trips` (a full open segment is completed first, U4).
 */

/** A completed segment as the API returns it (`FlightSegmentSummary`). */
export type TripSummary = {
  tripId: string;
  module: ModuleId;
  rank: Rank;
  pleasureCruise: boolean;
  flights: number;
  correct: number;
  outcome: TripOutcome;
  hintUsed: boolean;
  goAround: boolean;
  nightTrip: boolean;
  bestStreak: number;
  miles: number;
  statusPoints: number;
  /** The local calendar day the segment was completed on (server time of the 10th banked Round + the segment's offset). */
  localDate: string;
  completedAt: string;
  catalogVersion: number;
};

export type HintGrantView = { kind: "trip_grant"; hints: number; ref: string };

export type CompletionLists = {
  trip: TripSummary;
  fieldAwards: { id: FieldAwardId; earnedAt: string }[];
  clipperCards: { key: string; module: CardModule; firstCollectedAt: string }[];
  hintGrants: HintGrantView[];
};

function cardRecord(row: ClipperCardRow): CardRecord {
  return {
    key: row.cardKey,
    module: row.module as CardModule,
    timesIdentified: row.timesIdentified,
    everPerfect: row.everPerfect,
    everHintFree: row.everHintFree,
    fastestCorrectMs: row.fastestCorrectMs,
  };
}

/** Same order on the first answer and on every replay: by Card key (code point order). */
const byKey = <T extends { key: string }>(a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export function summaryOf(trip: TripRow): TripSummary {
  if (
    trip.status !== "completed" ||
    trip.outcome === null ||
    trip.correct === null ||
    trip.hintUsed === null ||
    trip.bestStreak === null ||
    trip.miles === null ||
    trip.statusPoints === null ||
    trip.goAround === null ||
    trip.nightTrip === null ||
    trip.completionLocalDate === null ||
    trip.catalogVersion === null ||
    trip.closedAt === null
  ) {
    throw new Error("Completed Flight Segment is missing its result columns.");
  }
  return {
    tripId: trip.id,
    module: trip.module as ModuleId,
    rank: trip.rank as Rank,
    pleasureCruise: trip.pleasureCruise,
    flights: trip.flightCount,
    correct: trip.correct,
    outcome: trip.outcome,
    hintUsed: trip.hintUsed,
    goAround: trip.goAround,
    nightTrip: trip.nightTrip,
    bestStreak: trip.bestStreak,
    miles: trip.miles,
    statusPoints: trip.statusPoints,
    localDate: trip.completionLocalDate,
    completedAt: trip.closedAt.toISOString(),
    catalogVersion: trip.catalogVersion,
  };
}

/**
 * What a completed segment reports, read back from the tables: the Cards it collected first (`first_trip_id`), the awards
 * it earned (`trip_id`) and the Trip hint (`grantedHints`: the delta of its `trip_grant` ledger row, or null). The first
 * answer and every replay use this one function, so they are the same lists by construction.
 */
async function readCompletion(
  tx: Tx,
  principal: string,
  trip: TripRow,
  grantedHints: number | null,
): Promise<CompletionLists> {
  const cards = await tx
    .select()
    .from(playerClipperCards)
    .where(and(eq(playerClipperCards.playerId, principal), eq(playerClipperCards.firstTripId, trip.id)));
  const awards = await tx
    .select()
    .from(playerFieldAwards)
    .where(and(eq(playerFieldAwards.playerId, principal), eq(playerFieldAwards.tripId, trip.id)));
  const order = new Map(catalogInForce().awards.map((a, i) => [a.id as string, i]));
  return {
    trip: summaryOf(trip),
    fieldAwards: awards
      .map((a) => ({ id: a.awardId as FieldAwardId, earnedAt: a.earnedAt.toISOString() }))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
    clipperCards: cards
      .map((c) => ({ key: c.cardKey, module: c.module as CardModule, firstCollectedAt: c.firstCollectedAt.toISOString() }))
      .sort(byKey),
    hintGrants: grantedHints === null ? [] : [{ kind: "trip_grant", hints: grantedHints, ref: trip.id }],
  };
}

/** The stored answer of an already completed segment (a replay): the hint comes from the ledger. */
export async function storedCompletion(locked: LockedPlayer, principal: string, trip: TripRow): Promise<CompletionLists> {
  return readCompletion(locked.tx, principal, trip, await locked.posted("hints", "trip_grant", trip.id));
}

export type FullTripCompletion = {
  /** The postings PlayerBalance must apply with the step (the Trip hint). */
  postings: Posting[];
  completion: CompletionLists;
};

/**
 * Completes a FULL, open, locked segment. The caller has checked: owned, open, ten banked Rounds. Updates the segment
 * row, the counters, the Cards and the earned awards through `tx`, in one pass over the segment's ten banked Rounds in
 * flight order (Unity `WithTrip`). Reached once per segment: afterwards it is `completed`, and a second caller finds that
 * under the player lock.
 */
export async function completeFullTrip(tx: Tx, principal: string, trip: TripRow, now: Date): Promise<FullTripCompletion> {
  const banked = await tx
    .select()
    .from(rounds)
    .where(and(eq(rounds.tripId, trip.id), eq(rounds.status, "completed")))
    .orderBy(asc(rounds.flightNumber))
    .for("update");
  const last = banked[banked.length - 1];
  if (banked.length !== FLIGHTS_PER_TRIP || !last?.completedAt) {
    throw new Error("A full Flight Segment must hold ten banked Rounds.");
  }
  const flights: FlightFact[] = banked.map((r) =>
    flightFact({ finished: r.finished === true, errorCount: r.errorCount ?? 0, usedHint: r.usedHint === true }),
  );
  const miles = banked.reduce((n, r) => n + (r.milesAwarded ?? 0), 0);
  const statusPoints = banked.reduce((n, r) => n + (r.spAwarded ?? 0), 0);
  const completedLocal = localDateTimeOf(last.completedAt, trip.utcOffsetMinutes);

  // Counters (Unity WithTrip). The day fields were kept up to date by the Round results; the row exists once a Round banked.
  const [counterRow] = await tx.select().from(playerCounters).where(eq(playerCounters.playerId, principal));
  const applied = applyCompletedTrip(counterRow ? toCounters(counterRow) : EMPTY_COUNTERS, {
    module: trip.module as ModuleId,
    flights,
    miles,
    completedLocal,
  });
  const c = applied.counters;
  const fields = {
    tripsCompleted: c.tripsCompleted,
    flightsCompleted: c.flightsCompleted,
    correctFlights: c.correctFlights,
    allCorrectTrips: c.allCorrectTrips,
    milesEarned: c.milesEarned,
    bestTripStreak: c.bestTripStreak,
    identifierFullTrips: c.identifierFullTrips,
    perfectFlightStreak: c.perfectFlightStreak,
    bestPerfectFlightStreak: c.bestPerfectFlightStreak,
    hintFreeTripStreak: c.hintFreeTripStreak,
    bestHintFreeTripStreak: c.bestHintFreeTripStreak,
    nightTrips: c.nightTrips,
    goArounds: c.goArounds,
    previousTripOutcome: c.previousTripOutcome,
    updatedAt: now,
  };
  await tx
    .insert(playerCounters)
    .values({
      playerId: principal,
      ...fields,
      lastPlayedDate: c.lastPlayedDate,
      flightsOnLastPlayedDate: c.flightsOnLastPlayedDate,
      dayStreak: c.dayStreak,
      bestDayStreak: c.bestDayStreak,
    })
    .onConflictDoUpdate({ target: playerCounters.playerId, set: fields });

  // Clipper Cards (design 3.5, A7): every finished Round with a Card key, in flight order.
  const cardKeys = [...new Set(banked.flatMap((r) => (r.finished === true && r.cardKey ? [r.cardKey] : [])))];
  const existing = new Map<string, CardRecord>();
  if (cardKeys.length > 0) {
    const rows = await tx
      .select()
      .from(playerClipperCards)
      .where(and(eq(playerClipperCards.playerId, principal), inArray(playerClipperCards.cardKey, cardKeys)));
    for (const row of rows) existing.set(row.cardKey, cardRecord(row));
  }
  const cardModule = trip.module as CardModule;
  const touched = new Map<string, { record: CardRecord; collected: boolean }>();
  banked.forEach((round, i) => {
    const key = round.cardKey;
    const fact = flights[i];
    if (round.finished !== true || !key || !fact) return;
    const prior = touched.get(key);
    const { card, collected } = recordSighting(prior?.record ?? existing.get(key) ?? null, key, cardModule, {
      perfect: fact.perfect,
      hintUsed: fact.hintUsed,
      answerMs: round.answerMs,
    });
    touched.set(key, { record: card, collected: prior ? prior.collected : collected });
  });
  for (const [key, { record, collected }] of touched) {
    const state = {
      timesIdentified: record.timesIdentified,
      everPerfect: record.everPerfect,
      everHintFree: record.everHintFree,
      fastestCorrectMs: record.fastestCorrectMs,
    };
    if (collected) {
      await tx
        .insert(playerClipperCards)
        .values({ playerId: principal, cardKey: key, module: record.module, firstCollectedAt: now, firstTripId: trip.id, ...state });
    } else {
      await tx
        .update(playerClipperCards)
        .set(state)
        .where(and(eq(playerClipperCards.playerId, principal), eq(playerClipperCards.cardKey, key)));
    }
  }

  // Field Awards (design 3.6): all 28 against the catalog in force; an earned row is never removed.
  const catalog = catalogInForce();
  const allCards = (await tx.select().from(playerClipperCards).where(eq(playerClipperCards.playerId, principal))).map(cardRecord);
  const earnedRows = await tx
    .select({ awardId: playerFieldAwards.awardId })
    .from(playerFieldAwards)
    .where(eq(playerFieldAwards.playerId, principal));
  const evaluation = evaluateFieldAwards(
    catalog.awards,
    { counters: c, cards: allCards, tags: catalog.tags },
    new Set(earnedRows.map((r) => r.awardId as FieldAwardId)),
  );
  for (const id of evaluation.newlyEarned) {
    await tx
      .insert(playerFieldAwards)
      .values({ playerId: principal, awardId: id, earnedAt: now, tripId: trip.id, catalogVersion: catalog.version });
  }

  const [done] = await tx
    .update(trips)
    .set({
      status: "completed",
      closedAt: now,
      outcome: applied.outcome,
      correct: flights.filter((f) => f.correct).length,
      hintUsed: !applied.hintFree,
      bestStreak: applied.bestStreak,
      miles,
      statusPoints,
      goAround: applied.goAround,
      nightTrip: applied.nightTrip,
      completionLocalDate: completedLocal.date,
      catalogVersion: catalog.version,
    })
    .where(eq(trips.id, trip.id))
    .returning();
  if (!done) throw new Error("Flight Segment vanished under its lock.");

  const postings: Posting[] =
    applied.hintGrant === 1 ? [{ account: "hints", delta: 1, kind: "trip_grant", ref: trip.id }] : [];
  return { postings, completion: await readCompletion(tx, principal, done, postings.length > 0 ? 1 : null) };
}

/**
 * The balance change of a completion: the Trip hint and the Perfect Streak back to 0 (D-3). Undefined when neither moves,
 * so a completion that grants nothing and finds the streak already 0 does not bump `players.version` (U2).
 */
export function completionChange(player: Pick<PlayerRow, "perfectStreak">, postings: Posting[]): BalanceChange | undefined {
  const reset = streakReset(player).change;
  if (postings.length === 0) return reset;
  return { postings, ...(reset ?? {}) };
}
