import { createHash } from "node:crypto";
import type { CardModule, CardRecord } from "../rules/clipper-cards.js";
import { evaluateFieldAwards } from "../rules/field-awards.js";
import type { FieldAwardDefinition, FieldAwardId } from "../rules/field-awards.js";
import type { AircraftTagTable } from "../rules/aircraft-tags.js";
import type { ModuleId } from "../rules/modules.js";
import type { PlayerCounters, TripOutcome } from "../rules/trips.js";

/**
 * Pure builders for `GET /v1/me/logbook` (design 6, slice T5). Nothing here reads a clock, the database or the request: the
 * view is a function of the stored rows and the catalog in force, which is what lets the ETag below be honest.
 */

/** Most recent completed segments the Logbook lists (Unity `RecentFlightsLog.Capacity`). */
export const RECENT_TRIPS = 20;

/** Bump when the response SHAPE or the way a value is derived changes without a stored row changing, so old ETags die. */
export const LOGBOOK_FORMAT = 1;

export type LogbookTripRow = {
  tripId: string;
  module: ModuleId;
  localDate: string;
  flights: number;
  correct: number;
  miles: number;
  statusPoints: number;
  completedAt: string;
};

export type LogbookCardRecord = {
  key: string;
  module: CardModule;
  firstCollectedAt: string;
  timesIdentified: number;
  everPerfect: boolean;
};

export type LogbookAward = {
  id: FieldAwardId;
  current: number;
  target: number;
  earned: boolean;
  earnedAt: string | null;
};

export type Logbook = {
  /** `players.logbook_version`: the Logbook's own counter, NOT Progress.version. */
  version: number;
  recentTrips: LogbookTripRow[];
  daily: { lastPlayedDate: string | null; flightsOnLastPlayedDate: number; streakDays: number; bestStreakDays: number };
  lifetime: {
    trips: number;
    flights: number;
    correct: number;
    allCorrectTrips: number;
    bestTripStreak: number;
    miles: number;
  };
  counters: {
    identifierFullTrips: number;
    perfectFlightStreak: number;
    bestPerfectFlightStreak: number;
    hintFreeTripStreak: number;
    bestHintFreeTripStreak: number;
    nightTrips: number;
    goArounds: number;
    previousTripOutcome: TripOutcome | null;
  };
  clipperCards: LogbookCardRecord[];
  fieldAwards: { catalogVersion: number; earned: number; total: number; awards: LogbookAward[] };
};

export type LogbookInputs = {
  logbookVersion: number;
  counters: PlayerCounters;
  /** The 20 newest completed segments, newest first, already mapped. */
  recentTrips: LogbookTripRow[];
  /** Every collected Card, oldest first. */
  cards: readonly (CardRecord & { firstCollectedAt: Date })[];
  /** Stored earned rows (the ONLY source of `earned`). */
  earned: ReadonlyMap<FieldAwardId, Date>;
  catalog: { version: number; awards: readonly FieldAwardDefinition[]; tags: AircraftTagTable };
};

export function buildLogbook(input: LogbookInputs): Logbook {
  const { counters: c } = input;
  // `current` / `target` come from the evaluator (metric capped at the effective target). Its own `earned` is ignored: an
  // award is earned iff a stored row says so (design 6). So a raised target reads earned with current < target, and a
  // lowered target reads unearned with current = target until the next completion stores it.
  const evaluation = evaluateFieldAwards(input.catalog.awards, { counters: c, cards: input.cards, tags: input.catalog.tags });
  const awards: LogbookAward[] = evaluation.awards.map((p) => {
    const at = input.earned.get(p.id);
    return { id: p.id, current: p.current, target: p.target, earned: at !== undefined, earnedAt: at ? at.toISOString() : null };
  });
  return {
    version: input.logbookVersion,
    recentTrips: input.recentTrips,
    daily: {
      lastPlayedDate: c.lastPlayedDate,
      flightsOnLastPlayedDate: c.flightsOnLastPlayedDate,
      streakDays: c.dayStreak,
      bestStreakDays: c.bestDayStreak,
    },
    lifetime: {
      trips: c.tripsCompleted,
      flights: c.flightsCompleted,
      correct: c.correctFlights,
      allCorrectTrips: c.allCorrectTrips,
      bestTripStreak: c.bestTripStreak,
      miles: c.milesEarned,
    },
    counters: {
      identifierFullTrips: c.identifierFullTrips,
      perfectFlightStreak: c.perfectFlightStreak,
      bestPerfectFlightStreak: c.bestPerfectFlightStreak,
      hintFreeTripStreak: c.hintFreeTripStreak,
      bestHintFreeTripStreak: c.bestHintFreeTripStreak,
      nightTrips: c.nightTrips,
      goArounds: c.goArounds,
      previousTripOutcome: c.previousTripOutcome,
    },
    clipperCards: input.cards.map((card) => ({
      key: card.key,
      module: card.module,
      firstCollectedAt: card.firstCollectedAt.toISOString(),
      timesIdentified: card.timesIdentified,
      everPerfect: card.everPerfect,
    })),
    fieldAwards: {
      catalogVersion: input.catalog.version,
      earned: awards.filter((a) => a.earned).length,
      total: awards.length,
      awards,
    },
  };
}

/**
 * The Logbook's strong ETag. The body is a pure function of (this player's stored rows, the field-awards document in force,
 * the aircraft-tags document in force), so the tag names exactly those:
 *
 * - `logbookVersion` rises on every write that changes the stored rows the body reads (PlayerBalance `Step.logbook`);
 * - the two document versions move the body without any player write (a publish changes `fieldAwards`; a tag edit moves the
 *   tag-derived `current` values);
 * - the player id and `createdAt` make a deleted-and-recreated account (whose counter restarts at 1) or another player never
 *   share a tag with it;
 * - `LOGBOOK_FORMAT` retires every tag when the code's derivation changes.
 *
 * No field of the body depends on the clock: `daily` is stored data (the app decides what "today" is), `recentTrips` holds
 * completed segments only (an open or expiring one never appears), and nothing is stamped with the request time. A clock
 * dependence would have to enter this hash too, and the tests pin that the body has none.
 */
export function logbookEtag(parts: {
  playerId: string;
  createdAt: Date;
  logbookVersion: number;
  awardsVersion: number;
  tagsVersion: number;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([LOGBOOK_FORMAT, parts.playerId, parts.createdAt.getTime(), parts.logbookVersion, parts.awardsVersion, parts.tagsVersion]),
    )
    .digest("hex")
    .slice(0, 32);
  return `"lb-${digest}"`;
}
