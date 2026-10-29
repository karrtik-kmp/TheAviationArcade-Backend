import { describe, expect, it } from "vitest";
import { bankRound } from "../src/rules/banking.js";
import { SEED_COMMERCIAL_CARD_KEYS } from "../src/rules/aircraft-tags.js";
import { ANSWER_MS_SLACK, checkFlightFacts } from "../src/rules/flight-facts.js";
import type { FlightFactsInput } from "../src/rules/flight-facts.js";
import {
  EMPTY_COUNTERS,
  isCalendarDate,
  localDateMatches,
  OPENING_TRIP_STREAK,
  recordPlayedDay,
} from "../src/rules/trips.js";

// Slice T2 pure rules: the localDate check (U12), the per-segment Perfect Streak through bankRound (D-3), the Flight
// facts rules and the day-streak hint cadence the Round result applies. The e2e twin is test/trips.e2e.test.ts.

describe("localDate check (U12)", () => {
  const noon = new Date("2026-10-29T12:00:00Z");

  it("accepts the local date of server time plus the offset", () => {
    expect(localDateMatches("2026-10-29", noon, 0)).toBe(true);
    expect(localDateMatches("2026-10-29", noon, 330)).toBe(true); // 17:30 in UTC+05:30
  });

  it("rejects a different day", () => {
    expect(localDateMatches("2026-10-28", noon, 0)).toBe(false);
    expect(localDateMatches("2026-10-30", noon, 0)).toBe(false);
    expect(localDateMatches("2026-10-29", new Date("2026-10-29T23:00:00Z"), 330)).toBe(false); // already the 30th there
  });

  it("allows 15 minutes either side of local midnight, not 16", () => {
    const justBefore = new Date("2026-10-29T23:50:00Z"); // 10 minutes before the 30th in UTC
    expect(localDateMatches("2026-10-29", justBefore, 0)).toBe(true);
    expect(localDateMatches("2026-10-30", justBefore, 0)).toBe(true);
    const sixteenBefore = new Date("2026-10-29T23:44:00Z");
    expect(localDateMatches("2026-10-30", sixteenBefore, 0)).toBe(false);
    expect(localDateMatches("2026-10-29", sixteenBefore, 0)).toBe(true);
    expect(localDateMatches("2026-10-29", new Date("2026-10-30T00:10:00Z"), 0)).toBe(true);
    expect(localDateMatches("2026-10-29", new Date("2026-10-30T00:16:00Z"), 0)).toBe(false);
  });

  it("works across the extreme offsets", () => {
    expect(localDateMatches("2026-10-30", new Date("2026-10-29T10:00:00Z"), 840)).toBe(true); // UTC+14 is 00:00 on the 30th
    expect(localDateMatches("2026-10-29", new Date("2026-10-30T10:00:00Z"), -720)).toBe(true); // UTC-12 is 22:00 on the 29th
  });

  it("isCalendarDate rejects impossible dates", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("nope")).toBe(false);
  });
});

describe("D-3 per-segment Perfect Streak through bankRound", () => {
  const state = (perfectStreak: number) => ({ statusPoints: 0, perfectStreak, firstClassUntil: null });
  const input = { finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.1, pleasureCruise: false, hintPaid: false };
  const NOW = new Date("2026-10-29T12:00:00Z");

  it("a new segment starts at the opening streak: no streak Miles on its first Round even after a long earlier streak", () => {
    expect(OPENING_TRIP_STREAK).toBe(0);
    const carried = bankRound(state(8), input, NOW);
    const fresh = bankRound(state(OPENING_TRIP_STREAK), input, NOW);
    expect(carried.award.streakMiles).toBe(25);
    expect(fresh.award.streakMiles).toBe(0);
    expect(fresh.streak).toBe(1);
  });

  it("the streak a Round returns feeds the next Round of the same segment", () => {
    let streak = OPENING_TRIP_STREAK;
    const miles: number[] = [];
    for (let n = 0; n < 4; n += 1) {
      const banked = bankRound(state(streak), input, NOW);
      miles.push(banked.award.streakMiles);
      streak = banked.streak;
    }
    expect(miles).toEqual([0, 5, 10, 15]);
  });
});

describe("Flight facts rules (design 3.2)", () => {
  const base: FlightFactsInput = {
    module: "identifier",
    finished: true,
    errorCount: 0,
    attempts: 1,
    answerMs: 1500,
    aircraftKey: "787",
  };
  const check = (over: Partial<FlightFactsInput>, elapsedMs = 6000) => checkFlightFacts({ ...base, ...over }, elapsedMs);

  it("accepts a seeded commercial family for identifier", () => {
    expect(check({})).toEqual({ ok: true, commercialKey: "787", militaryItemId: null });
    for (const family of SEED_COMMERCIAL_CARD_KEYS) expect(check({ aircraftKey: family }).ok, family).toBe(true);
  });

  it("rejects identifier keys outside the seeded catalog: a case variant, a typo, a Military key, an empty value", () => {
    for (const aircraftKey of ["a320", "A32O", "mil:eurofighter typhoon", "mil-a4", "9999", ""]) {
      expect(check({ aircraftKey }).ok, aircraftKey).toBe(false);
    }
    expect(check({ aircraftKey: null }).ok).toBe(false);
  });

  it("identifier needs its key even on a timeout (finished false)", () => {
    expect(check({ finished: false, attempts: 0 }).ok).toBe(true);
    expect(check({ finished: false, attempts: 0, aircraftKey: null }).ok).toBe(false);
  });

  it("Military asks for the content item id and leaves the lookup to the caller", () => {
    expect(check({ module: "aircraft-identifier-military", aircraftKey: "mil-a4" })).toEqual({
      ok: true,
      commercialKey: null,
      militaryItemId: "mil-a4",
    });
    expect(check({ module: "aircraft-identifier-military", aircraftKey: null }).ok).toBe(false);
  });

  it("every other module takes a null key and nothing else", () => {
    for (const module of ["airport-spotter", "atc-match", "call-sign-match", "code-search", "runway-identifier", "tail-identifier"] as const) {
      expect(check({ module, aircraftKey: null }), module).toEqual({ ok: true, commercialKey: null, militaryItemId: null });
      expect(check({ module, aircraftKey: "787" }).ok, module).toBe(false);
    }
  });

  it("ASSUMPTION A4: attempts >= errorCount, and >= 1 when finished", () => {
    expect(check({ errorCount: 2, attempts: 1 }).ok).toBe(false);
    expect(check({ errorCount: 2, attempts: 3 }).ok).toBe(true);
    expect(check({ finished: true, attempts: 0 }).ok).toBe(false);
    expect(check({ finished: false, errorCount: 0, attempts: 0 }).ok).toBe(true);
  });

  it("ASSUMPTION A5: answerMs may exceed the server's elapsed time by at most 2 s", () => {
    expect(ANSWER_MS_SLACK).toBe(2000);
    expect(check({ answerMs: 8000 }, 6000).ok).toBe(true);
    expect(check({ answerMs: 8001 }, 6000).ok).toBe(false);
    expect(check({ answerMs: 0 }, 0).ok).toBe(true);
  });
});

describe("day streak and the 7-day hint as the Round result applies them", () => {
  it("seven consecutive local days grant exactly one hint, on the 7th and again on the 14th", () => {
    let counters = EMPTY_COUNTERS;
    const grants: number[] = [];
    for (let day = 1; day <= 14; day += 1) {
      const played = recordPlayedDay(counters, `2026-10-${String(day).padStart(2, "0")}`);
      counters = played.counters;
      if (played.hintGrant === 1) grants.push(day);
    }
    expect(grants).toEqual([7, 14]);
    expect(counters.dayStreak).toBe(14);
  });

  it("a second Round on the same local day grants nothing and a gap restarts the streak", () => {
    let c = recordPlayedDay(EMPTY_COUNTERS, "2026-10-01").counters;
    const again = recordPlayedDay(c, "2026-10-01");
    expect(again.hintGrant).toBe(0);
    expect(again.counters.flightsOnLastPlayedDate).toBe(2);
    c = recordPlayedDay(again.counters, "2026-10-04").counters;
    expect(c.dayStreak).toBe(1);
  });
});
