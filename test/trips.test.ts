import { describe, expect, it } from "vitest";
import {
  addDays,
  applyCompletedTrip,
  bestTripStreak,
  DAYS_PER_HINT,
  deriveDayLog,
  deriveTripCounters,
  EMPTY_COUNTERS,
  flightFact,
  FLIGHTS_PER_TRIP,
  flightsToday,
  isNightHour,
  liveDayStreak,
  localDateTimeOf,
  nextTripStreak,
  OPENING_TRIP_STREAK,
  recordPlayedDay,
  tripHintGrant,
  tripOutcome,
  TRIPS_PER_HINT,
  withTrip,
} from "../src/rules/trips.js";
import type { CompletedTrip, FlightFact, PlayerCounters } from "../src/rules/trips.js";
import type { ModuleId } from "../src/rules/modules.js";
import { bankRound } from "../src/rules/banking.js";

// Names mirror Unity: FieldAwardsTests (AwardCounters), HintBankTests, DailyFlightLogTests. Rules the user or the
// client did not state are named "ASSUMPTION: ..." and tied to design section 12 (A-items, J-items).

const COM: ModuleId = "identifier";
const MIL: ModuleId = "aircraft-identifier-military";
const NOON = { date: "2026-10-26", hour: 12, minute: 0 };

const perfect: FlightFact = { correct: true, perfect: true, hintUsed: false };
const secondTry: FlightFact = { correct: true, perfect: false, hintUsed: false };
const hinted: FlightFact = { correct: true, perfect: false, hintUsed: true };
const miss: FlightFact = { correct: false, perfect: false, hintUsed: false };

function trip(flights: readonly FlightFact[], module: ModuleId = COM, over: Partial<CompletedTrip> = {}): CompletedTrip {
  return { module, flights, miles: 100, completedLocal: NOON, ...over };
}
const many = (n: number, f: FlightFact = perfect) => Array.from({ length: n }, () => f);
const fullTrip = (module: ModuleId = COM, f: FlightFact = perfect) => trip(many(FLIGHTS_PER_TRIP, f), module);
const notGreen = (module: ModuleId = COM) => trip([...many(9), miss], module);

describe("constants", () => {
  it("a Trip is ten Flights, a hint every 4 Trips and every 7 days (TripProfiles, HintBank)", () => {
    expect([FLIGHTS_PER_TRIP, TRIPS_PER_HINT, DAYS_PER_HINT]).toEqual([10, 4, 7]);
  });
});

describe("per-Trip Perfect Streak (D-3)", () => {
  it("a new segment starts at zero and the streak runs only inside it", () => {
    expect(OPENING_TRIP_STREAK).toBe(0);
    let s = OPENING_TRIP_STREAK;
    for (const c of ["perfect", "perfect", "perfect"] as const) s = nextTripStreak(s, c);
    expect(s).toBe(3);
    expect(nextTripStreak(s, "standard")).toBe(0);
    expect(nextTripStreak(s, "unfinished")).toBe(0);
    // the next segment does not inherit it
    expect(nextTripStreak(OPENING_TRIP_STREAK, "perfect")).toBe(1);
  });

  it("feeds bankRound unchanged: Streak Miles pay on the streak carried into the Round", () => {
    const input = { finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.2, pleasureCruise: false, hintPaid: false };
    const base = { statusPoints: 0, firstClassUntil: null };
    const now = new Date("2026-10-29T10:00:00Z");
    const fresh = bankRound({ ...base, perfectStreak: OPENING_TRIP_STREAK }, input, now);
    expect(fresh.award.streakMiles).toBe(0);
    const third = bankRound({ ...base, perfectStreak: 3 }, input, now);
    expect(third.award.streakMiles).toBe(15);
    expect(third.streak).toBe(4);
  });

  it("the best streak inside a segment is read from its Rounds in flight order", () => {
    expect(bestTripStreak([perfect, perfect, perfect, secondTry, perfect, perfect])).toBe(3);
    expect(bestTripStreak(many(10))).toBe(10);
    expect(bestTripStreak([miss, miss])).toBe(0);
    expect(bestTripStreak([])).toBe(0);
  });

  it("flightFact: perfect needs finished, no errors and no hint (paid or claimed)", () => {
    expect(flightFact({ finished: true, errorCount: 0, usedHint: false })).toEqual(perfect);
    expect(flightFact({ finished: true, errorCount: 1, usedHint: false })).toEqual(secondTry);
    expect(flightFact({ finished: true, errorCount: 0, usedHint: true })).toEqual(hinted);
    expect(flightFact({ finished: false, errorCount: 0, usedHint: false })).toEqual(miss);
  });
});

describe("Trip outcome", () => {
  it("A_fully_correct_identifier_trip_counts_even_with_hints_and_second_tries", () => {
    const flights = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? perfect : hinted));
    expect(tripOutcome(flights)).toBe("all_correct");
    expect(applyCompletedTrip(EMPTY_COUNTERS, trip(flights)).counters.identifierFullTrips).toBe(1);
    expect(applyCompletedTrip(EMPTY_COUNTERS, fullTrip(MIL)).counters.identifierFullTrips).toBe(1);
  });

  it("A_trip_with_one_miss_or_another_game_does_not_count", () => {
    expect(tripOutcome([...many(4), miss, ...many(5)])).toBe("not_all_correct");
    expect(applyCompletedTrip(EMPTY_COUNTERS, trip([...many(4), miss, ...many(5)])).counters.identifierFullTrips).toBe(0);
    const tail = applyCompletedTrip(EMPTY_COUNTERS, fullTrip("tail-identifier")).counters;
    expect(tail.identifierFullTrips).toBe(0);
    expect(tail.allCorrectTrips).toBe(1);
  });

  it("An_empty_trip_changes_nothing", () => {
    expect(tripOutcome([])).toBeNull();
    // Unity ignores an empty Trip; the backend refuses to complete one (ASSUMPTION A15: an empty segment is a caller bug).
    expect(() => applyCompletedTrip(EMPTY_COUNTERS, trip([]))).toThrow(RangeError);
  });
});

describe("Perfect Flight streak (Ace in the Cockpit)", () => {
  it("The_perfect_streak_runs_across_trips_and_resets_on_a_non_perfect_flight", () => {
    let c = withTrip(EMPTY_COUNTERS, trip(many(3)));
    c = withTrip(c, trip(many(2)));
    expect(c.bestPerfectFlightStreak).toBe(5);
    c = withTrip(c, trip([hinted, perfect, perfect]));
    expect(c.perfectFlightStreak).toBe(2);
    expect(c.bestPerfectFlightStreak).toBe(5);
  });

  it("A_miss_resets_the_streak", () => {
    const c = withTrip(EMPTY_COUNTERS, trip([perfect, perfect, perfect, perfect, miss, perfect]));
    expect(c.bestPerfectFlightStreak).toBe(4);
    expect(c.perfectFlightStreak).toBe(1);
  });

  it("Other_games_neither_extend_nor_break_the_flight_streak", () => {
    let c = withTrip(EMPTY_COUNTERS, trip(many(4)));
    c = withTrip(c, trip([miss, miss, miss], "tail-identifier"));
    c = withTrip(c, trip(many(1), "atc-match"));
    expect(c.perfectFlightStreak).toBe(4);
    expect(withTrip(c, trip(many(2))).perfectFlightStreak).toBe(6);
  });

  it("ASSUMPTION A10: Both_identifiers_share_one_flight_streak", () => {
    const c = withTrip(withTrip(EMPTY_COUNTERS, trip(many(3), COM)), trip(many(2), MIL));
    expect(c.bestPerfectFlightStreak).toBe(5);
  });
});

describe("No-Instrument Flight (hint-free Trips)", () => {
  it("Five_consecutive_hint_free_trips_across_every_game_earn_no_instrument", () => {
    let c = EMPTY_COUNTERS;
    for (let i = 0; i < 4; i += 1) c = withTrip(c, fullTrip("atc-match", secondTry));
    expect(c.bestHintFreeTripStreak).toBe(4);
    c = withTrip(c, fullTrip());
    expect(c.bestHintFreeTripStreak).toBe(5);
  });

  it("One_hint_resets_the_hint_free_streak_but_keeps_the_best", () => {
    let c = EMPTY_COUNTERS;
    for (let i = 0; i < 3; i += 1) c = withTrip(c, fullTrip());
    c = withTrip(c, trip([...many(9), hinted]));
    expect(c.hintFreeTripStreak).toBe(0);
    expect(c.bestHintFreeTripStreak).toBe(3);
  });
});

describe("Red-Eye window", () => {
  // ASSUMPTION A19: the sheet says "between 10:00 PM and 5:00 AM"; 22:00 inclusive and 05:00 EXCLUSIVE is Unity's
  // reading (FieldAwardsTests.Red_eye_is_22_00_inclusive_to_05_00_exclusive), not a client ruling.
  it.each([
    [22, true],
    [23, true],
    [0, true],
    [4, true],
    [5, false],
    [12, false],
    [21, false],
  ])("ASSUMPTION A19: Red_eye_is_22_00_inclusive_to_05_00_exclusive (hour %i night=%s)", (hour, night) => {
    expect(isNightHour(hour)).toBe(night);
    const r = applyCompletedTrip(EMPTY_COUNTERS, { ...fullTrip(), completedLocal: { ...NOON, hour } });
    expect(r.nightTrip).toBe(night);
    expect(r.counters.nightTrips).toBe(night ? 1 : 0);
  });

  it("ASSUMPTION A3: local time = the instant plus the offset given at open; the phone clock never enters", () => {
    // 2026-10-29 23:30 UTC in UTC+5:30 is 05:00 next day (not night); in UTC-5 it is 18:30 (not night); UTC+0 is night.
    const at = new Date("2026-10-29T23:30:00Z");
    expect(isNightHour(localDateTimeOf(at, 0).hour)).toBe(true);
    expect(localDateTimeOf(at, 330)).toEqual({ date: "2026-10-30", hour: 5, minute: 0 });
    expect(isNightHour(localDateTimeOf(at, 330).hour)).toBe(false);
    expect(localDateTimeOf(at, -300)).toEqual({ date: "2026-10-29", hour: 18, minute: 30 });
  });
});

// ASSUMPTION A18 / J12: the client wrote "a full green trip (10 green fligfhts)". Unity paints only a PERFECT Flight
// green (first pick, no hint) and a hinted or second-try Flight yellow, yet Unity's AwardCounters counts any correct
// Flight as green. We keep the Unity counting rule (a Trip is green when every Flight was answered correctly) until
// the client answers J12, so every Go Around test below is an ASSUMPTION. Names mirror Unity GoAroundCounterTests.
describe("Go Around (a full green Trip right after one that was not)", () => {
  it("ASSUMPTION A18 (J12): Red_then_green_is_one_go_around: a green Trip straight after a completed Trip that was not green", () => {
    let c = withTrip(EMPTY_COUNTERS, notGreen());
    expect(c.goArounds).toBe(0);
    const r = applyCompletedTrip(c, fullTrip(COM, secondTry));
    expect(r.goAround).toBe(true);
    expect(r.counters.goArounds).toBe(1);
    c = r.counters;
    // two greens in a row: the second is not a Go Around
    expect(applyCompletedTrip(c, fullTrip()).counters.goArounds).toBe(1);
  });

  it("ASSUMPTION A18 (J12): 10 correct Flights that all used a hint, after a non-full Trip, still earn Go Around (any correct Flight counts as green)", () => {
    const afterMiss = withTrip(EMPTY_COUNTERS, notGreen());
    const allHinted = fullTrip(COM, hinted);
    expect(allHinted.flights.every((f) => f.correct && f.hintUsed && !f.perfect)).toBe(true);
    const r = applyCompletedTrip(afterMiss, allHinted);
    expect(r).toMatchObject({ outcome: "all_correct", goAround: true });
    expect(r.counters.goArounds).toBe(1);
    // the stricter reading (perfect Flights only) would give 0 here; if the client rules it, only tripOutcome changes
    expect(r.counters.bestPerfectFlightStreak).toBe(afterMiss.bestPerfectFlightStreak);
  });

  it("ASSUMPTION A18 (J12): The_first_trip_ever_never_counts_even_when_green", () => {
    expect(applyCompletedTrip(EMPTY_COUNTERS, fullTrip()).goAround).toBe(false);
    expect(applyCompletedTrip(EMPTY_COUNTERS, notGreen()).counters.goArounds).toBe(0);
  });

  it("ASSUMPTION A18 (J12): Green_then_red_does_not_count, and the next green after the red is a Go Around", () => {
    let c = withTrip(EMPTY_COUNTERS, fullTrip());
    c = withTrip(c, notGreen());
    expect(c.goArounds).toBe(0);
    expect(withTrip(c, fullTrip()).goArounds).toBe(1);
  });

  it("ASSUMPTION A13 / J1: Any_arcade_game_counts_and_mixed_games, on both sides of the pair (one counter across all games)", () => {
    const c = withTrip(EMPTY_COUNTERS, notGreen("tail-identifier"));
    expect(withTrip(c, fullTrip("atc-match")).goArounds).toBe(1);
    const mixed = withTrip(withTrip(EMPTY_COUNTERS, notGreen(COM)), fullTrip(MIL));
    expect(mixed.goArounds).toBe(1);
  });

  // The HTTP twin is trips.e2e.test.ts "Go Around sequence" (open, abandon, complete). Here it only pins the one pure
  // fact that e2e relies on: applyCompletedTrip is the sole writer of previousTripOutcome.
  it("ASSUMPTION A13 (placeholder for T2/T3 e2e): only COMPLETED Trips set the previous outcome; an abandoned segment never reaches here", () => {
    const afterMiss = withTrip(EMPTY_COUNTERS, notGreen());
    expect(afterMiss.previousTripOutcome).toBe("not_all_correct");
    expect(withTrip(afterMiss, fullTrip()).previousTripOutcome).toBe("all_correct");
  });
});

describe("Trip totals", () => {
  it("counts trips, flights, correct, all-correct trips, Miles and the best in-Trip streak", () => {
    const c = deriveTripCounters([
      trip([perfect, perfect, perfect, miss, secondTry], COM, { miles: 120 }),
      trip(many(10), "atc-match", { miles: 80 }),
    ]);
    expect(c).toMatchObject({
      tripsCompleted: 2,
      flightsCompleted: 15,
      correctFlights: 14,
      allCorrectTrips: 1,
      milesEarned: 200,
      bestTripStreak: 10,
      identifierFullTrips: 0,
    });
  });

  it("applyCompletedTrip never mutates its input", () => {
    const before = JSON.stringify(EMPTY_COUNTERS);
    applyCompletedTrip(EMPTY_COUNTERS, fullTrip());
    expect(JSON.stringify(EMPTY_COUNTERS)).toBe(before);
  });
});

describe("Trip hint grant (HintBank.CompleteTrip)", () => {
  it("Every_four_completed_Trips_earns_one", () => {
    const grants: number[] = [];
    let c = EMPTY_COUNTERS;
    for (let i = 0; i < 12; i += 1) {
      const r = applyCompletedTrip(c, fullTrip());
      grants.push(r.hintGrant);
      c = r.counters;
    }
    expect(grants).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(tripHintGrant(0)).toBe(0);
  });

  it("ASSUMPTION A1: every completed Trip counts for the hint cadence, any module, Pleasure Cruise included", () => {
    let c = EMPTY_COUNTERS;
    let last = 0;
    for (const m of ["atc-match", "identifier", "tail-identifier", "aircraft-identifier-military"] as const) {
      const r = applyCompletedTrip(c, notGreen(m));
      last = r.hintGrant;
      c = r.counters;
    }
    expect(last).toBe(1);
  });
});

describe("Day log and the 7-day hint", () => {
  const play = (c: PlayerCounters, day: string) => recordPlayedDay(c, day);

  it("The_first_flight_of_a_new_site_day_starts_today_at_one / One_flown_day_is_a_one_day_streak", () => {
    const r = play(EMPTY_COUNTERS, "2026-10-20");
    expect(r.counters).toMatchObject({ lastPlayedDate: "2026-10-20", flightsOnLastPlayedDate: 1, dayStreak: 1, bestDayStreak: 1 });
    const r2 = play(r.counters, "2026-10-20");
    expect(r2.counters).toMatchObject({ flightsOnLastPlayedDate: 2, dayStreak: 1 });
    expect(r2.newDay).toBe(false);
  });

  it("Consecutive_flown_days_extend_the_streak and Multiple_Flights_on_one_day_do_not_advance_the_day_streak", () => {
    let c = EMPTY_COUNTERS;
    for (const d of ["2026-10-20", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-22"]) c = play(c, d).counters;
    expect(c.dayStreak).toBe(3);
    expect(c.flightsOnLastPlayedDate).toBe(2);
  });

  it("Missing_a_whole_site_day_resets / Flying_after_a_missed_day_starts_a_new_streak_at_one, keeping the best", () => {
    let c = EMPTY_COUNTERS;
    for (const d of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-24"]) c = play(c, d).counters;
    expect(c.dayStreak).toBe(1);
    expect(c.bestDayStreak).toBe(3);
  });

  it("A_clock_set_backwards_neither_resets_nor_rewinds_the_streak", () => {
    let c = EMPTY_COUNTERS;
    for (const d of ["2026-10-20", "2026-10-21", "2026-10-22"]) c = play(c, d).counters;
    const r = play(c, "2026-10-19");
    expect(r.counters).toMatchObject({ lastPlayedDate: "2026-10-22", dayStreak: 3, flightsOnLastPlayedDate: 2 });
    expect(r.hintGrant).toBe(0);
    expect(r.newDay).toBe(false);
  });

  it("The_streak_survives_a_month_and_a_year_boundary", () => {
    let c = EMPTY_COUNTERS;
    for (const d of ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]) c = play(c, d).counters;
    expect(c.dayStreak).toBe(4);
    let leap = EMPTY_COUNTERS;
    for (const d of ["2028-02-28", "2028-02-29", "2028-03-01"]) leap = play(leap, d).counters;
    expect(leap.dayStreak).toBe(3);
  });

  it("Every_seven_consecutive_played_days_earns_one (and again at 14, 21)", () => {
    const grants: string[] = [];
    let c = EMPTY_COUNTERS;
    for (let i = 0; i < 21; i += 1) {
      const day = addDays("2026-10-01", i);
      const r = play(c, day);
      if (r.hintGrant) grants.push(day);
      c = r.counters;
    }
    expect(grants).toEqual(["2026-10-07", "2026-10-14", "2026-10-21"]);
  });

  it("Multiple_Flights_on_one_day cannot grant the 7-day hint twice, and a missed day restarts the count", () => {
    let c = EMPTY_COUNTERS;
    for (let i = 0; i < 6; i += 1) c = play(c, addDays("2026-10-01", i)).counters;
    const seventh = play(c, "2026-10-07");
    expect(seventh.hintGrant).toBe(1);
    expect(play(seventh.counters, "2026-10-07").hintGrant).toBe(0);
    const restarted = play(seventh.counters, "2026-10-09").counters;
    expect(restarted.dayStreak).toBe(1);
  });

  it("Today_not_yet_flown_keeps_yesterdays_streak_alive; Missing_a_whole_site_day_resets_the_streak_to_zero", () => {
    const c = deriveDayLog(["2026-10-20", "2026-10-21", "2026-10-22"]);
    expect(liveDayStreak(c, "2026-10-22")).toBe(3);
    expect(liveDayStreak(c, "2026-10-23")).toBe(3);
    expect(liveDayStreak(c, "2026-10-24")).toBe(0);
    expect(liveDayStreak(EMPTY_COUNTERS, "2026-10-24")).toBe(0);
  });

  it("Every_banked_flight_counts_toward_today", () => {
    const c = deriveDayLog(["2026-10-22", "2026-10-22", "2026-10-22"]);
    expect(flightsToday(c, "2026-10-22")).toBe(3);
    expect(flightsToday(c, "2026-10-23")).toBe(0);
    expect(flightsToday(EMPTY_COUNTERS, "2026-10-23")).toBe(0);
  });

  it("Today_resets_at_local_midnight_in_any_zone / East_of_Greenwich_the_new_day_starts_before_UTC_midnight", () => {
    const at = new Date("2026-10-28T23:59:00Z");
    expect(localDateTimeOf(at, 0).date).toBe("2026-10-28");
    expect(localDateTimeOf(at, 1).date).toBe("2026-10-29");
    expect(localDateTimeOf(at, 840).date).toBe("2026-10-29");
    expect(localDateTimeOf(at, -1).date).toBe("2026-10-28");
    expect(localDateTimeOf(new Date("2026-10-29T00:00:00Z"), -1)).toMatchObject({ date: "2026-10-28", hour: 23, minute: 59 });
    expect(localDateTimeOf(new Date("2026-10-29T00:00:00Z"), -720).date).toBe("2026-10-28");
  });

  it("Two_flights_on_either_side_of_local_midnight_are_consecutive_days", () => {
    const a = localDateTimeOf(new Date("2026-10-28T23:50:00Z"), 0).date;
    const b = localDateTimeOf(new Date("2026-10-29T00:10:00Z"), 0).date;
    expect(deriveDayLog([a, b]).dayStreak).toBe(2);
  });

  // The HTTP twin is trips.e2e.test.ts "ASSUMPTION A2" (an abandoned segment's banked Round moves the day streak). The
  // pure function takes only a day, so it cannot see whether the segment later completes; the e2e proves the caller calls it.
  it("ASSUMPTION A2 (placeholder for T2/T3 e2e): a Round of an abandoned segment still counts as play (recordPlayedDay takes only a day)", () => {
    expect(recordPlayedDay(EMPTY_COUNTERS, "2026-10-01").counters.dayStreak).toBe(1);
  });

  it("ASSUMPTION: a changed offset can at most move the day forward (rewound dates count on the last day)", () => {
    const first = localDateTimeOf(new Date("2026-10-28T22:00:00Z"), 600).date; // 2026-10-29 in UTC+10
    const later = localDateTimeOf(new Date("2026-10-28T22:30:00Z"), -600).date; // 2026-10-28 in UTC-10
    expect(first).toBe("2026-10-29");
    expect(later).toBe("2026-10-28");
    const c = deriveDayLog([first, later]);
    expect(c).toMatchObject({ lastPlayedDate: "2026-10-29", dayStreak: 1, flightsOnLastPlayedDate: 2 });
  });

  it("rejects dates that are not calendar dates", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
    expect(() => addDays("not-a-date", 1)).toThrow(RangeError);
  });
});
