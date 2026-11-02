import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOGBOOK_FORMAT, RECENT_TRIPS, buildLogbook, logbookEtag } from "../src/logbook/logbook.js";
import type { LogbookInputs } from "../src/logbook/logbook.js";
import { SEED_AIRCRAFT_TAG_TABLE } from "../src/rules/aircraft-tags.js";
import { FIELD_AWARD_CATALOG } from "../src/rules/field-award-catalog.js";
import type { FieldAwardId } from "../src/rules/field-awards.js";
import { EMPTY_COUNTERS } from "../src/rules/trips.js";

// Slice T5, the pure part: the builders in src/logbook/logbook.ts and the structural promise that the read path writes and
// locks nothing. The route itself is test/logbook.e2e.test.ts.

/** Blank the comments (strings stay), so prose that names a forbidden call is not mistaken for one. Same tokens as balance-guard. */
const stripComments = (source: string) =>
  source.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => (str ? m : m.replace(/[^\n]/g, " ")));

const catalog = { version: 1, awards: FIELD_AWARD_CATALOG, tags: SEED_AIRCRAFT_TAG_TABLE };
const base = (over: Partial<LogbookInputs> = {}): LogbookInputs => ({
  logbookVersion: 1,
  counters: EMPTY_COUNTERS,
  recentTrips: [],
  cards: [],
  earned: new Map(),
  catalog,
  ...over,
});
const award = (lb: ReturnType<typeof buildLogbook>, id: string) => lb.fieldAwards.awards.find((a) => a.id === id)!;

describe("buildLogbook", () => {
  it("an empty history: 28 locked awards in catalog order, zeros, no Cards", () => {
    const lb = buildLogbook(base());
    expect(lb.fieldAwards.awards.map((a) => a.id)).toEqual(FIELD_AWARD_CATALOG.map((d) => d.id));
    expect(lb.fieldAwards).toMatchObject({ catalogVersion: 1, earned: 0, total: 28 });
    expect(lb.fieldAwards.awards.every((a) => !a.earned && a.earnedAt === null && a.current === 0)).toBe(true);
    expect(lb.daily).toEqual({ lastPlayedDate: null, flightsOnLastPlayedDate: 0, streakDays: 0, bestStreakDays: 0 });
    expect(lb.clipperCards).toEqual([]);
    expect(lb.version).toBe(1);
  });

  it("earned comes from the stored row, never from current >= target", () => {
    const at = new Date("2026-11-01T10:00:00.000Z");
    const counters = { ...EMPTY_COUNTERS, tripsCompleted: 30 };
    // Reached but not stored (a lowered target, or a publish before the next completion): unearned.
    const reached = buildLogbook(base({ counters }));
    expect(award(reached, "first-flight")).toMatchObject({ current: 1, target: 1, earned: false, earnedAt: null });
    expect(award(reached, "frequent-flyer")).toMatchObject({ current: 25, target: 25, earned: false });
    expect(reached.fieldAwards.earned).toBe(0);
    // Stored but no longer reached (a raised target): earned, current below target.
    const raised = buildLogbook(
      base({
        counters: { ...EMPTY_COUNTERS, tripsCompleted: 1 },
        earned: new Map<FieldAwardId, Date>([["first-flight", at]]),
        catalog: { ...catalog, awards: catalog.awards.map((d) => (d.id === "first-flight" ? { ...d, target: 5 } : d)) },
      }),
    );
    expect(award(raised, "first-flight")).toEqual({ id: "first-flight", current: 1, target: 5, earned: true, earnedAt: at.toISOString() });
    expect(raised.fieldAwards.earned).toBe(1);
  });

  it("current is the metric capped at the effective target; a bad catalog target is clamped, not served raw", () => {
    const lb = buildLogbook(
      base({
        counters: { ...EMPTY_COUNTERS, tripsCompleted: 99 },
        catalog: { ...catalog, awards: catalog.awards.map((d) => (d.id === "first-flight" ? { ...d, target: 0 } : d)) },
      }),
    );
    expect(award(lb, "first-flight")).toMatchObject({ current: 1, target: 1 });
    expect(award(lb, "frequent-flyer")).toMatchObject({ current: 25, target: 25 });
  });

  it("maps the counters, daily log and lifetime totals field for field", () => {
    const counters = {
      ...EMPTY_COUNTERS,
      tripsCompleted: 4, flightsCompleted: 40, correctFlights: 33, allCorrectTrips: 2, milesEarned: 9000, bestTripStreak: 10,
      identifierFullTrips: 1, perfectFlightStreak: 3, bestPerfectFlightStreak: 6, hintFreeTripStreak: 2, bestHintFreeTripStreak: 4,
      nightTrips: 1, goArounds: 1, previousTripOutcome: "not_all_correct" as const,
      lastPlayedDate: "2026-11-01", flightsOnLastPlayedDate: 7, dayStreak: 3, bestDayStreak: 5,
    };
    const lb = buildLogbook(base({ counters, logbookVersion: 17 }));
    expect(lb.version).toBe(17);
    expect(lb.daily).toEqual({ lastPlayedDate: "2026-11-01", flightsOnLastPlayedDate: 7, streakDays: 3, bestStreakDays: 5 });
    expect(lb.lifetime).toEqual({ trips: 4, flights: 40, correct: 33, allCorrectTrips: 2, bestTripStreak: 10, miles: 9000 });
    expect(lb.counters).toEqual({
      identifierFullTrips: 1, perfectFlightStreak: 3, bestPerfectFlightStreak: 6, hintFreeTripStreak: 2, bestHintFreeTripStreak: 4,
      nightTrips: 1, goArounds: 1, previousTripOutcome: "not_all_correct",
    });
  });

  it("every Card is listed as stored, in the order given, whether or not any document knows its key", () => {
    const cards = [
      { key: "787", module: "identifier" as const, timesIdentified: 3, everPerfect: true, everHintFree: true, fastestCorrectMs: 800, firstCollectedAt: new Date("2026-10-01T00:00:00Z") },
      { key: "mil:not in any document", module: "aircraft-identifier-military" as const, timesIdentified: 1, everPerfect: false, everHintFree: false, fastestCorrectMs: null, firstCollectedAt: new Date("2026-10-02T00:00:00Z") },
    ];
    const lb = buildLogbook(base({ cards }));
    expect(lb.clipperCards).toEqual([
      { key: "787", module: "identifier", firstCollectedAt: "2026-10-01T00:00:00.000Z", timesIdentified: 3, everPerfect: true },
      { key: "mil:not in any document", module: "aircraft-identifier-military", firstCollectedAt: "2026-10-02T00:00:00.000Z", timesIdentified: 1, everPerfect: false },
    ]);
    expect(award(lb, "first-card")).toMatchObject({ current: 1, earned: false });
  });

  it("the size is bounded by the shape: 28 awards whatever the history", () => {
    expect(buildLogbook(base({ counters: { ...EMPTY_COUNTERS, tripsCompleted: 1_000_000, milesEarned: 1e12 } })).fieldAwards.awards).toHaveLength(28);
    expect(RECENT_TRIPS).toBe(20);
  });
});

describe("logbookEtag", () => {
  const parts = { playerId: "firebase:p:u", createdAt: new Date("2026-10-01T00:00:00Z"), logbookVersion: 4, awardsVersion: 1, tagsVersion: 1 };

  it("is a strong, quoted, deterministic tag", () => {
    expect(logbookEtag(parts)).toMatch(/^"lb-[0-9a-f]{32}"$/);
    expect(logbookEtag({ ...parts })).toBe(logbookEtag(parts));
  });

  it("changes with each input: the player, the incarnation, the counter and both catalog documents", () => {
    const seen = new Set([logbookEtag(parts)]);
    for (const changed of [
      { playerId: "firebase:p:v" },
      { createdAt: new Date("2026-10-01T00:00:00.001Z") },
      { logbookVersion: 5 },
      { awardsVersion: 2 },
      { tagsVersion: 2 },
    ]) {
      seen.add(logbookEtag({ ...parts, ...changed }));
    }
    expect(seen.size).toBe(6);
    expect(LOGBOOK_FORMAT).toBe(1);
  });

  it("does not confuse neighbouring numbers (awards 1 / tags 12 against awards 11 / tags 2)", () => {
    expect(logbookEtag({ ...parts, awardsVersion: 1, tagsVersion: 12 })).not.toBe(logbookEtag({ ...parts, awardsVersion: 11, tagsVersion: 2 }));
  });
});

describe("the read path writes and locks nothing", () => {
  const dir = join(import.meta.dirname, "..", "src", "logbook");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it("src/logbook holds no insert/update/delete, no row lock, no PlayerBalance and no raw write", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const code = stripComments(readFileSync(join(dir, file), "utf8"));
      expect(code, file).not.toMatch(/\b(?:tx|db)\s*\.\s*(?:insert|update|delete)\(/);
      expect(code, file).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
      expect(code, file).not.toMatch(/\.for\(/);
      expect(code, file).not.toMatch(/\bfor\s+(no\s+key\s+)?update\b/i);
      expect(code, file).not.toMatch(/\b(insert\s+into|delete\s+from)\b/i);
      expect(code, file).not.toMatch(/PlayerBalance|enqueueMirror/);
    }
  });

  it("the service reads in one REPEATABLE READ, READ ONLY transaction", () => {
    const code = stripComments(readFileSync(join(dir, "logbook.service.ts"), "utf8"));
    expect(code).toMatch(/isolationLevel:\s*"repeatable read"/);
    expect(code).toMatch(/accessMode:\s*"read only"/);
  });
});
