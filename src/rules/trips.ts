import type { ModuleId } from "./modules.js";
import { nextPerfectStreak } from "./scoring.js";
import type { Completion } from "./scoring.js";

/**
 * Flight Segment ("Trip" in Unity) rules, pure. Ports of Unity:
 *   - TripProfiles.cs                    (10 Flights per Trip)
 *   - HintBank.cs                        (+1 hint per 4 completed Trips, +1 per 7 consecutive played days)
 *   - DailyFlightLog.cs                  (the local-day log and day streak)
 *   - AwardCounters.cs                   (WithTrip: the Field Award counters, Go Around, Red-Eye window)
 * Design: docs/design/trips-awards-logbook.md sections 3.1, 3.3, 3.4, 3.7. No database, no clock, no Nest:
 * the caller (slices T2/T3) passes already-loaded state and writes the result inside PlayerBalance.update.
 *
 * Vocabulary: a backend Round is one Unity Flight; a Flight Segment is a Unity Trip (ADR-0007). Names here keep
 * the Unity words where the awards and the Logbook do ("trip", "flight") because they mirror those tests.
 */
export const FLIGHTS_PER_TRIP = 10;
export const TRIPS_PER_HINT = 4;
export const DAYS_PER_HINT = 7;
/** Red-Eye window: 22:00 inclusive to 05:00 exclusive, local time (AwardCounters.NightStartHour/NightEndHour). */
export const NIGHT_START_HOUR = 22;
export const NIGHT_END_HOUR = 5;

export type TripOutcome = "all_correct" | "not_all_correct";

/** The two Identifier modules share the Ace streak and the "identify every aircraft" Trip count (Unity IsIdentifier). */
export function isIdentifierModule(module: ModuleId): boolean {
  return module === "identifier" || module === "aircraft-identifier-military";
}

// ---- Perfect Streak per Trip (D-3) -----------------------------------------------------------------------

/**
 * The per-Trip Perfect Streak is `nextPerfectStreak` with the segment's own streak as input, starting from
 * `OPENING_TRIP_STREAK` at every new segment (D-3, design 3.1). `bankRound` is unchanged in T1: it already
 * takes the streak as `state.perfectStreak`, so T2 passes the segment's streak (open = 0, then `streak` from the
 * previous `BankedRound`) and resets the stored streak at open, complete and abandon. This is the function T2 calls
 * to recompute it from stored Rounds.
 */
export const OPENING_TRIP_STREAK = 0;

/** The streak after a Round of the segment; same rule as the economy streak, only the starting point differs. */
export function nextTripStreak(current: number, completion: Completion): number {
  return nextPerfectStreak(current, completion);
}

// ---- A settled Flight and the Trip outcome -----------------------------------------------------------------

/** One banked Round, as the Field Awards see it (Unity FlightFact minus the aircraft, which lives on the Card). */
export type FlightFact = {
  /** Unity `Correct`: the Round was finished (server `finished`). */
  correct: boolean;
  /** Correct, no errors, no hint (paid or claimed). Unity `Perfect`. */
  perfect: boolean;
  hintUsed: boolean;
};

/** Builds a fact from what the Round result stores (`finished`, `errorCount`, paid-or-claimed hint). */
export function flightFact(round: { finished: boolean; errorCount: number; usedHint: boolean }): FlightFact {
  return {
    correct: round.finished,
    perfect: round.finished && round.errorCount === 0 && !round.usedHint,
    hintUsed: round.usedHint,
  };
}

/**
 * "Fully correct" (a green Trip): at least one Flight and every Flight correct. Hints and second tries still count
 * (the sheet: "Hints and second attempts are currently allowed"). Callers pass the segment's ten Rounds.
 */
export function tripOutcome(flights: readonly FlightFact[]): TripOutcome | null {
  if (flights.length === 0) return null;
  return flights.every((f) => f.correct) ? "all_correct" : "not_all_correct";
}

/** The longest Perfect Streak inside one segment (the Logbook's bestTripStreak), from the Rounds in flight order. */
export function bestTripStreak(flights: readonly FlightFact[]): number {
  let streak = OPENING_TRIP_STREAK;
  let best = 0;
  for (const f of flights) {
    const completion: Completion = !f.correct ? "unfinished" : f.perfect ? "perfect" : "standard";
    streak = nextTripStreak(streak, completion);
    if (streak > best) best = streak;
  }
  return best;
}

// ---- Local days ---------------------------------------------------------------------------------------------

/** `YYYY-MM-DD`. */
export type LocalDate = string;

export type LocalDateTime = { date: LocalDate; hour: number; minute: number };

const DAY_MS = 86_400_000;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Server instant plus the segment's reported offset (design 3.3). The phone clock never enters. */
export function localDateTimeOf(instant: Date, utcOffsetMinutes: number): LocalDateTime {
  const shifted = new Date(instant.getTime() + utcOffsetMinutes * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function dayNumber(date: LocalDate): number {
  const m = LOCAL_DATE.exec(date);
  if (!m) throw new RangeError(`not a LocalDate: ${date}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(ms).toISOString().slice(0, 10) !== date) throw new RangeError(`not a calendar date: ${date}`);
  return ms / DAY_MS;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return dayNumber(b) - dayNumber(a);
}

/** Red-Eye Special: 22:00 inclusive to 05:00 exclusive (AwardCounters.IsNight). */
export function isNightHour(hour: number): boolean {
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

// ---- Counters ----------------------------------------------------------------------------------------------

/** The `player_counters` row (design 4), as plain numbers. */
export type PlayerCounters = {
  tripsCompleted: number;
  flightsCompleted: number;
  correctFlights: number;
  allCorrectTrips: number;
  milesEarned: number;
  bestTripStreak: number;
  identifierFullTrips: number;
  perfectFlightStreak: number;
  bestPerfectFlightStreak: number;
  hintFreeTripStreak: number;
  bestHintFreeTripStreak: number;
  nightTrips: number;
  goArounds: number;
  previousTripOutcome: TripOutcome | null;
  lastPlayedDate: LocalDate | null;
  flightsOnLastPlayedDate: number;
  dayStreak: number;
  bestDayStreak: number;
};

export const EMPTY_COUNTERS: PlayerCounters = Object.freeze({
  tripsCompleted: 0,
  flightsCompleted: 0,
  correctFlights: 0,
  allCorrectTrips: 0,
  milesEarned: 0,
  bestTripStreak: 0,
  identifierFullTrips: 0,
  perfectFlightStreak: 0,
  bestPerfectFlightStreak: 0,
  hintFreeTripStreak: 0,
  bestHintFreeTripStreak: 0,
  nightTrips: 0,
  goArounds: 0,
  previousTripOutcome: null,
  lastPlayedDate: null,
  flightsOnLastPlayedDate: 0,
  dayStreak: 0,
  bestDayStreak: 0,
});

// ---- Day log and the 7-day hint (DailyFlightLog + HintBank.RecordFlight) ----------------------------------

export type PlayedDayResult = {
  counters: PlayerCounters;
  /** True when this Round started a new local day or extended the streak (day > last). */
  newDay: boolean;
  /** 1 when the streak reached a multiple of 7 on this Round, else 0. Ref for the ledger row = the local date. */
  hintGrant: 0 | 1;
};

/**
 * Records one banked Round on `localDay` (the Round's local day, `localDateTimeOf(...).date`). The same rule as
 * `HintBank.RecordFlight` and `DailyFlightLog.RecordFlight`: a day on or before the last played day is counted on the
 * last day and changes no streak (a rewound clock or offset cannot make an earlier day "new"); the next day extends
 * the streak; any later day restarts it at 1. A hint is due each time the streak lands on a multiple of 7.
 */
export function recordPlayedDay(counters: PlayerCounters, localDay: LocalDate): PlayedDayResult {
  const last = counters.lastPlayedDate;
  if (last !== null && daysBetween(last, localDay) <= 0) {
    return {
      counters: { ...counters, flightsOnLastPlayedDate: counters.flightsOnLastPlayedDate + 1 },
      newDay: false,
      hintGrant: 0,
    };
  }
  const dayStreak = last !== null && daysBetween(last, localDay) === 1 ? counters.dayStreak + 1 : 1;
  return {
    counters: {
      ...counters,
      lastPlayedDate: localDay,
      flightsOnLastPlayedDate: 1,
      dayStreak,
      bestDayStreak: Math.max(counters.bestDayStreak, dayStreak),
    },
    newDay: true,
    hintGrant: dayStreak % DAYS_PER_HINT === 0 ? 1 : 0,
  };
}

/** Flights banked today (DailyFlightLog.FlightsToday): 0 unless the last played day is `today`. */
export function flightsToday(counters: PlayerCounters, today: LocalDate): number {
  return counters.lastPlayedDate === today ? counters.flightsOnLastPlayedDate : 0;
}

/** The live day streak (DailyFlightLog.StreakDays): alive while the last played day is today or yesterday. */
export function liveDayStreak(counters: PlayerCounters, today: LocalDate): number {
  const last = counters.lastPlayedDate;
  if (last === null) return 0;
  return daysBetween(last, today) <= 1 ? counters.dayStreak : 0;
}

/** Rebuilds the day fields from every banked Round's local day, oldest first (the T3 re-derivation test). */
export function deriveDayLog(roundLocalDays: readonly LocalDate[], start: PlayerCounters = EMPTY_COUNTERS): PlayerCounters {
  return roundLocalDays.reduce((c, day) => recordPlayedDay(c, day).counters, start);
}

// ---- Trip hint grant (HintBank.CompleteTrip) ---------------------------------------------------------------

/** 1 when `tripsCompleted` (after counting this Trip) is a multiple of 4. Ref for the ledger row = the tripId. */
export function tripHintGrant(tripsCompleted: number): 0 | 1 {
  return tripsCompleted > 0 && tripsCompleted % TRIPS_PER_HINT === 0 ? 1 : 0;
}

// ---- A completed Trip (AwardCounters.WithTrip + LifetimeFlightStats.RecordTrip) ---------------------------

export type CompletedTrip = {
  module: ModuleId;
  /** The segment's Rounds in flight order. */
  flights: readonly FlightFact[];
  /** Miles banked by the segment's Rounds. */
  miles: number;
  /** The completion time on the segment's local clock (design A3: server time of the last Round + offset). */
  completedLocal: LocalDateTime;
};

export type CompletedTripResult = {
  counters: PlayerCounters;
  outcome: TripOutcome;
  /** This Trip was fully correct right after a completed Trip that was not. */
  goAround: boolean;
  nightTrip: boolean;
  hintFree: boolean;
  /** 1 when this Trip makes `tripsCompleted` a multiple of 4. */
  hintGrant: 0 | 1;
  bestStreak: number;
};

/**
 * The counters after one COMPLETED Trip. Scope (Unity AwardCounters, user-approved): trip, hint-free, night and
 * Go Around counters see every module; the Perfect Flight streak and the full-Trip count see the two Identifier
 * modules only (another module neither extends nor breaks the streak). Go Around: a green Trip (>= 1 Flight, all
 * correct, any module) right after a completed Trip that was not green; the first Trip ever never counts.
 * Unity's `WithTrip` ignores an empty Trip; here an empty segment throws (RangeError), because a segment completes
 * only with its ten banked Rounds and skipping would hide a caller bug.
 */
export function applyCompletedTrip(counters: PlayerCounters, trip: CompletedTrip): CompletedTripResult {
  const outcome = tripOutcome(trip.flights);
  if (outcome === null) throw new RangeError("a completed Trip has at least one Flight");

  const identifier = isIdentifierModule(trip.module);
  let perfectStreak = counters.perfectFlightStreak;
  let bestPerfect = counters.bestPerfectFlightStreak;
  if (identifier) {
    for (const f of trip.flights) {
      perfectStreak = f.perfect ? perfectStreak + 1 : 0;
      bestPerfect = Math.max(bestPerfect, perfectStreak);
    }
  }

  const allCorrect = outcome === "all_correct";
  const hintFree = !trip.flights.some((f) => f.hintUsed);
  const hintFreeStreak = hintFree ? counters.hintFreeTripStreak + 1 : 0;
  const nightTrip = isNightHour(trip.completedLocal.hour);
  const goAround = allCorrect && counters.previousTripOutcome === "not_all_correct";
  const tripsCompleted = counters.tripsCompleted + 1;
  const bestStreak = bestTripStreak(trip.flights);

  return {
    counters: {
      ...counters,
      tripsCompleted,
      flightsCompleted: counters.flightsCompleted + trip.flights.length,
      correctFlights: counters.correctFlights + trip.flights.filter((f) => f.correct).length,
      allCorrectTrips: counters.allCorrectTrips + (allCorrect ? 1 : 0),
      milesEarned: counters.milesEarned + trip.miles,
      bestTripStreak: Math.max(counters.bestTripStreak, bestStreak),
      identifierFullTrips: counters.identifierFullTrips + (identifier && allCorrect ? 1 : 0),
      perfectFlightStreak: perfectStreak,
      bestPerfectFlightStreak: bestPerfect,
      hintFreeTripStreak: hintFreeStreak,
      bestHintFreeTripStreak: Math.max(counters.bestHintFreeTripStreak, hintFreeStreak),
      nightTrips: counters.nightTrips + (nightTrip ? 1 : 0),
      goArounds: counters.goArounds + (goAround ? 1 : 0),
      previousTripOutcome: outcome,
    },
    outcome,
    goAround,
    nightTrip,
    hintFree,
    hintGrant: tripHintGrant(tripsCompleted),
    bestStreak,
  };
}

/** Counters only (Unity `WithTrip`). */
export function withTrip(counters: PlayerCounters, trip: CompletedTrip): PlayerCounters {
  return applyCompletedTrip(counters, trip).counters;
}

/** Rebuilds the Trip counters from the completed segments in completion order (the T3 re-derivation test). */
export function deriveTripCounters(trips: readonly CompletedTrip[], start: PlayerCounters = EMPTY_COUNTERS): PlayerCounters {
  return trips.reduce((c, t) => withTrip(c, t), start);
}
