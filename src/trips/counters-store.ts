import type { PlayerCountersRow } from "../db/schema.js";
import type { PlayerCounters } from "../rules/trips.js";

/** The `player_counters` row as the pure rules' `PlayerCounters` (no `updated_at`). Read-only: writers live elsewhere. */
export function toCounters(row: PlayerCountersRow): PlayerCounters {
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
