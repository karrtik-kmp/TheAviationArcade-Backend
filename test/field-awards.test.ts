import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  awardCountLabel,
  effectiveTarget,
  evaluateFieldAwards,
  FIELD_AWARD_CATALOG,
  FIELD_AWARD_IDS,
  FIELD_AWARD_METRICS,
  metricValue,
  nearlyThere,
  QUICK_ID_MS,
} from "../src/rules/field-awards.js";
import type { AwardInputs, FieldAwardDefinition, FieldAwardId } from "../src/rules/field-awards.js";
import {
  buildTagTable,
  hasTag,
  isFighterJet,
  SEED_AIRCRAFT_TAG_ENTRIES,
  SEED_AIRCRAFT_TAG_TABLE,
  SEED_COMMERCIAL_CARD_KEYS,
} from "../src/rules/aircraft-tags.js";
import { militaryMapping } from "../src/content/modules/military.js";
import { readFirstSheet } from "../src/content/xlsx.js";
import {
  cardKeyFor,
  cardKeySource,
  commercialCardKey,
  MILITARY_KEY_PREFIX,
  militaryCardKey,
  normalizeAnswerText,
  recordSighting,
} from "../src/rules/clipper-cards.js";
import type { CardRecord } from "../src/rules/clipper-cards.js";
import { EMPTY_COUNTERS, withTrip } from "../src/rules/trips.js";
import type { PlayerCounters } from "../src/rules/trips.js";

// Names mirror Unity FieldAwardsTests / AchievementBoardTests / AircraftTagsTests / LogbookCollectionTests.
// "ASSUMPTION" tests are rules neither the client nor the user stated (design section 12).

const tags = SEED_AIRCRAFT_TAG_TABLE;
/** A character by code point, so the test source holds no invisible or look-alike characters. */
const ch = (...codes: number[]) => String.fromCodePoint(...codes);
const SHEET = new URL("../../docs/Military Airplane Identifier v1.xlsx", import.meta.url);

function counters(over: Partial<PlayerCounters> = {}): PlayerCounters {
  return { ...EMPTY_COUNTERS, ...over };
}
function com(family: string, over: Partial<CardRecord> = {}): CardRecord {
  return { key: commercialCardKey(family), module: "identifier", timesIdentified: 1, everPerfect: true, everHintFree: true, fastestCorrectMs: 5000, ...over };
}
function mil(answer: string, over: Partial<CardRecord> = {}): CardRecord {
  return { key: militaryCardKey(answer), module: "aircraft-identifier-military", timesIdentified: 1, everPerfect: true, everHintFree: true, fastestCorrectMs: 5000, ...over };
}
function inputs(over: Partial<AwardInputs> = {}): AwardInputs {
  return { counters: EMPTY_COUNTERS, cards: [], tags, ...over };
}
const value = (id: FieldAwardId, i: AwardInputs) => {
  const def = FIELD_AWARD_CATALOG.find((d) => d.id === id);
  if (!def) throw new Error(id);
  return metricValue(def.metric, i);
};
const progress = (i: AwardInputs, earned: ReadonlySet<FieldAwardId> = new Set()) => evaluateFieldAwards(FIELD_AWARD_CATALOG, i, earned);

// ---- Catalog -----------------------------------------------------------------------------------------------------

describe("Field Award catalog", () => {
  it("The_catalog_is_the_clients_28_award_sheet_in_sheet_order", () => {
    expect(FIELD_AWARD_CATALOG).toHaveLength(28);
    expect(FIELD_AWARD_CATALOG.map((d) => d.id)).toEqual([...FIELD_AWARD_IDS]);
    expect(FIELD_AWARD_CATALOG.map((d) => d.sheetRow)).toEqual(Array.from({ length: 28 }, (_, i) => i + 2));
    expect(new Set(FIELD_AWARD_CATALOG.map((d) => d.id)).size).toBe(28);
    expect(FIELD_AWARD_METRICS).toHaveLength(19);
    for (const d of FIELD_AWARD_CATALOG) expect(FIELD_AWARD_METRICS).toContain(d.metric);
  });

  it("Starter_ids_are_kept_for_the_awards_that_match (the Unity code ids, not the sheet ids)", () => {
    const pairs: [string, string, string][] = [
      ["first-flight", "first-solo", "First Solo"],
      ["frequent-flyer", "frequent-flyer", "Frequent Flyer"],
      ["century", "logbook-100", "Logbook 100"],
      ["sharp-eyes", "vfr-certified", "VFR Certified"],
      ["flawless-five", "five-by-five", "Five-by-Five"],
      ["five-in-a-row", "ace-in-the-cockpit", "Ace in the Cockpit"],
      ["week-on-the-line", "line-pilot", "Line Pilot"],
      ["regular", "30-days-on-the-ramp", "30 Days on the Ramp"],
      ["first-card", "first-clipper-card", "First Clipper Card"],
      ["collector", "curator-of-the-skies", "Curator of the Skies"],
      ["textbook", "textbook-landing", "Textbook Landing"],
    ];
    for (const [id, sheetId, title] of pairs) {
      const d = FIELD_AWARD_CATALOG.find((x) => x.id === id);
      expect(d?.sheetId, id).toBe(sheetId);
      expect(d?.title, id).toBe(title);
    }
    expect(FIELD_AWARD_CATALOG.filter((d) => d.id !== d.sheetId)).toHaveLength(10);
  });

  it("Quad_engine_royalty_heavy_metal_and_go_around_are_the_sheets_rows (text verbatim, typos included)", () => {
    const by = (id: FieldAwardId) => FIELD_AWARD_CATALOG.find((d) => d.id === id) as FieldAwardDefinition;
    expect(by("quad-engine-royalty")).toMatchObject({ title: "Quad-Engine Royalty", target: 2, metric: "quad-engine-cards", thresholdCell: "2 Quad-jet Cards" });
    expect(by("quad-engine-royalty").criteria).toContain("Airbus A400M Atlas");
    expect(by("heavy-metal")).toMatchObject({ title: "Heavy Metal", target: 5, metric: "heavy-cards" });
    expect(by("heavy-metal").criteria).toBe(
      "Collect Clipper Cards for Heavy Aircraft (• Boeing: 747, 767, 777, and 787, Airbus: A300, A310, A330, A340, and A350",
    );
    expect(by("go-around")).toMatchObject({ title: "Go Around", target: 1, metric: "go-arounds" });
    expect(by("go-around").criteria).toContain("fligfhts");
    expect(by("fleet-admiral").thresholdCell).toBe("50 unique airfract");
    expect(by("regular").criteria).toBe("Play on thirty consecutive local calendar days");
  });

  it("Each_award_has_the_clients_metric_and_threshold (targets match the sheet and the client's rulings)", () => {
    const targets = Object.fromEntries(FIELD_AWARD_CATALOG.map((d) => [d.id, d.target]));
    expect(targets).toEqual({
      "first-flight": 1, "frequent-flyer": 25, century: 100, "sharp-eyes": 1, "flawless-five": 5, "five-in-a-row": 5,
      "week-on-the-line": 7, regular: 30, "first-card": 1, collector: 25, textbook: 10, "high-flyer": 100000,
      "coast-to-coast": 10000, "no-instrument-flight": 5, "red-eye-special": 1, "fleet-admiral": 50,
      "centennial-streak": 100, "go-around": 1, "globe-trotter": 24901, "quad-engine-royalty": 2,
      "the-great-rivalry": 10, "heavy-metal": 5, regional: 5, "bogey-identified": 1, "top-gun-ace": 10,
      rotorhead: 4, "vertical-horizon": 1, "executive-platinum": 100,
    });
  });

  it("No_award_is_hidden_and_30_days_on_the_ramp_is_visible", () => {
    expect(FIELD_AWARD_CATALOG.every((d) => !d.hidden)).toBe(true);
  });

  it("the tag-based awards (U8) and only those are marked provisional", () => {
    expect(FIELD_AWARD_CATALOG.filter((d) => d.provisional).map((d) => d.id)).toEqual([
      "quad-engine-royalty", "the-great-rivalry", "heavy-metal", "regional", "bogey-identified", "top-gun-ace", "rotorhead", "vertical-horizon",
    ]);
  });

  const SNAPSHOT = "C:/Unity/Projects/AviationArcade_v2/Assets/_Project/Content/ClientContent/Snapshots/field-awards.json";
  // Skipped (shown as skipped, not silently passed) on a machine without the Unity checkout; the pinned tests above still run.
  it.skipIf(!existsSync(SNAPSHOT))("matches the Unity snapshot field-awards.json (title, criteria, threshold cell verbatim)", () => {
    const path = SNAPSHOT;
    const snap = JSON.parse(readFileSync(path, "utf8")) as {
      sourceSha256: string;
      awards: { id: string; sheetRow: number; name: string; criteria: string; thresholdCell: string; hidden: boolean }[];
    };
    expect(snap.awards).toHaveLength(28);
    snap.awards.forEach((a, i) => {
      const d = FIELD_AWARD_CATALOG[i] as FieldAwardDefinition;
      expect([d.sheetId, d.sheetRow, d.title, d.criteria, d.thresholdCell, d.hidden]).toEqual([a.id, a.sheetRow, a.name, a.criteria, a.thresholdCell, a.hidden]);
    });
  });
});

// ---- Metrics from counters ---------------------------------------------------------------------------------------

describe("counter metrics", () => {
  it("read the right counter (PilotRecord.Value)", () => {
    const c = counters({
      tripsCompleted: 3, flightsCompleted: 30, identifierFullTrips: 2, bestPerfectFlightStreak: 6, bestDayStreak: 9,
      milesEarned: 12345, bestHintFreeTripStreak: 4, nightTrips: 1, goArounds: 2,
    });
    const i = inputs({ counters: c });
    expect(value("first-flight", i)).toBe(3);
    expect(value("century", i)).toBe(30);
    expect(value("sharp-eyes", i)).toBe(2);
    expect(value("five-in-a-row", i)).toBe(6);
    expect(value("regular", i)).toBe(9);
    expect(value("globe-trotter", i)).toBe(12345);
    expect(value("no-instrument-flight", i)).toBe(4);
    expect(value("red-eye-special", i)).toBe(1);
    expect(value("go-around", i)).toBe(2);
  });

  it("ASSUMPTION J10: the three Miles awards share one metric, Miles earned in COMPLETED Trips only (Globe Trotter's 'lifetime Miles earned' might include abandoned-segment Rounds)", () => {
    const i = inputs({ counters: counters({ milesEarned: 24901 }) });
    const p = progress(i);
    const earned = new Set(p.awards.filter((a) => a.earned).map((a) => a.id));
    expect(earned.has("globe-trotter")).toBe(true);
    expect(earned.has("coast-to-coast")).toBe(true);
    expect(earned.has("high-flyer")).toBe(false);
  });
});

// ---- Cards and tags ----------------------------------------------------------------------------------------------

describe("Card metrics", () => {
  it("cards-collected counts distinct Cards, commercial and Military (First Clipper Card, Curator, Fleet Admiral, Executive Platinum)", () => {
    const i = inputs({ cards: [com("787"), com("A320"), mil("Eurofighter Typhoon")] });
    expect(value("first-card", i)).toBe(3);
    expect(value("collector", i)).toBe(3);
  });

  it("Card_tags_count_quad_regional_and_manufacturer_from_names_and_ids", () => {
    const i = inputs({ cards: [com("747"), com("A380"), com("737"), com("A320"), com("E175"), com("CRJ")] });
    expect(value("quad-engine-royalty", i)).toBe(2);
    expect(value("regional", i)).toBe(2);
    expect(value("the-great-rivalry", i)).toBe(2);
  });

  it("The_great_rivalry_needs_both_makers", () => {
    const boeing = ["707", "717", "727", "737", "757", "767", "777", "787", "747"].map((f) => com(f));
    const airbus = ["A220", "A300", "A310", "A318", "A319", "A320", "A321", "A330", "A340", "A350", "A380"].map((f) => com(f));
    expect(value("the-great-rivalry", inputs({ cards: boeing }))).toBe(0);
    expect(value("the-great-rivalry", inputs({ cards: airbus }))).toBe(0);
    expect(value("the-great-rivalry", inputs({ cards: [...boeing.slice(0, 9), ...airbus.slice(0, 9)] }))).toBe(9);
    expect(value("the-great-rivalry", inputs({ cards: [...boeing, ...airbus] }))).toBe(9);
  });

  it("heavy-cards counts exactly the sheet's list; A380 is quad but not heavy", () => {
    const heavies = ["747", "767", "777", "787", "A300", "A310", "A330", "A340", "A350"].map((f) => com(f));
    expect(value("heavy-metal", inputs({ cards: heavies }))).toBe(9);
    expect(value("heavy-metal", inputs({ cards: [com("A380"), com("737"), com("A320"), com("E175")] }))).toBe(0);
    expect(hasTag(tags, "A380", "quad-engine")).toBe(true);
    expect(hasTag(tags, "A380", "heavy")).toBe(false);
  });

  it("textbook: perfect-cards counts Cards that were ever perfect", () => {
    const cards = [com("787"), com("A320", { everPerfect: false }), mil("Eurofighter Typhoon")];
    expect(value("textbook", inputs({ cards }))).toBe(2);
  });

  it("a Card with no tag entry counts for cards-collected but for no tag", () => {
    const i = inputs({ cards: [com("MYSTERY")] });
    expect(value("first-card", i)).toBe(1);
    expect(value("regional", i)).toBe(0);
  });

  it("ASSUMPTION A16: a Military Card counts once in perfect-cards (no separate Military counter, Unity MilitaryPerfect dropped)", () => {
    expect(value("textbook", inputs({ cards: [mil("Lockheed Martin F-16"), mil("Eurofighter Typhoon", { everPerfect: false })] }))).toBe(1);
  });
});

describe("Military-only awards (A12: only Military Cards)", () => {
  it("Bogey_identified_is_strictly_under_two_seconds", () => {
    expect(QUICK_ID_MS).toBe(2000);
    for (const [ms, quick] of [[1990, 1], [1000, 1], [2000, 0], [2010, 0]] as const) {
      expect(value("bogey-identified", inputs({ cards: [mil("Lockheed Martin F-22 Raptor", { fastestCorrectMs: ms })] })), String(ms)).toBe(quick);
    }
  });

  it("Bogey_needs_a_correct_military_fighter_jet", () => {
    const cards = [
      mil("Boeing C-17 Globemaster III", { fastestCorrectMs: 1000 }), // not a fighter
      mil("Chance Vought F4U Corsair", { fastestCorrectMs: 1000 }), // piston, not a jet
      mil("Lockheed Martin F-22 Raptor", { fastestCorrectMs: null }), // no correct time recorded
      { ...com("A320"), fastestCorrectMs: 1000 }, // commercial Cards never count
    ];
    expect(value("bogey-identified", inputs({ cards }))).toBe(0);
    expect(isFighterJet(tags, militaryCardKey("Chance Vought F4U Corsair"))).toBe(false);
    expect(isFighterJet(tags, militaryCardKey("Lockheed Martin F-22 Raptor"))).toBe(true);
  });

  it("Top_gun_ace_counts_distinct_fighters_identified_without_a_hint (a hint on every sighting excludes it; a second guess does not)", () => {
    const names = [
      "Lockheed Martin F-16", "Lockheed Martin F-22 Raptor", "Lockheed Martin F-35A Lightning II", "Eurofighter Typhoon",
      "Dassault Mirage IIIE", "Boeing F/A-18E/F Super Hornet", "Warthog A-10 Thunderbolt II", "Mikoyan MiG-29UB Fulcrum-B",
      "Chengdu FT-7BGI", "Hawker Hurricane",
    ];
    const ten = names.map((n) => mil(n, { everPerfect: false }));
    expect(value("top-gun-ace", inputs({ cards: ten }))).toBe(10);
    expect(value("top-gun-ace", inputs({ cards: ten.slice(0, 9) }))).toBe(9);
    const withHint = [...ten.slice(0, 9), mil("Chance Vought F4U Corsair", { everHintFree: false }), mil("Boeing C-17 Globemaster III")];
    expect(value("top-gun-ace", inputs({ cards: withHint }))).toBe(9);
  });

  it("Rotorhead_counts_distinct_military_rotary_cards / Vertical_horizon_counts_a_vtol_and_military_only", () => {
    const cards = [mil("AgustaWestland AW139"), mil("Eurocopter AS332 Super Puma"), mil("Lockheed Martin F-16")];
    expect(value("rotorhead", inputs({ cards }))).toBe(2);
    expect(value("vertical-horizon", inputs({ cards }))).toBe(2);
    expect(value("vertical-horizon", inputs({ cards: [mil("Lockheed Martin F-35A Lightning II")] }))).toBe(0);
    expect(value("vertical-horizon", inputs({ cards: [mil("Lockheed Martin F-35B Lightning II")] }))).toBe(1);
    // a commercial Card carrying a military tag (cannot happen with the seed, but the scope rule is explicit)
    const odd = buildTagTable([{ cardKey: "AW139", manufacturer: null, manufacturerSource: null, tags: [{ tag: "military-rotary", source: "provisional" }, { tag: "vtol", source: "provisional" }] }]);
    expect(value("rotorhead", inputs({ cards: [com("AW139")], tags: odd }))).toBe(0);
    expect(value("vertical-horizon", inputs({ cards: [com("AW139")], tags: odd }))).toBe(0);
  });

  it("ASSUMPTION A12: quad, heavy, regional and rivalry count every Card, so a Military C-17 counts as quad-engine (J3)", () => {
    expect(value("quad-engine-royalty", inputs({ cards: [com("747"), mil("Boeing C-17 Globemaster III")] }))).toBe(2);
    expect(value("quad-engine-royalty", inputs({ cards: [com("747"), mil("Boeing B-29 Superfortress"), mil("Lockheed C-130 Hercules")] }))).toBe(1);
  });

  it("ASSUMPTION J3: a Boeing-made Military Card counts toward The Great Rivalry as a Boeing Card (every-Card reading)", () => {
    const cards = [mil("Boeing C-17 Globemaster III"), com("A320")];
    expect(value("the-great-rivalry", inputs({ cards }))).toBe(1);
  });
});

// ---- Evaluation --------------------------------------------------------------------------------------------------

describe("evaluateFieldAwards", () => {
  it("Evaluate_keeps_catalog_order and An_empty_pilot_has_every_award_locked_at_zero", () => {
    const p = progress(inputs());
    expect(p.awards.map((a) => a.id)).toEqual([...FIELD_AWARD_IDS]);
    expect(p.awards.every((a) => !a.earned && a.current === 0)).toBe(true);
    expect(p.newlyEarned).toEqual([]);
    expect(awardCountLabel(p)).toBe("0 / 28");
  });

  it("Evaluate_of_a_missing_or_empty_catalog_is_empty", () => {
    const p = evaluateFieldAwards([], inputs());
    expect(p.awards).toEqual([]);
    expect(awardCountLabel(p)).toBe("0 / 0");
  });

  it("Current_is_capped_at_the_target_and_the_award_is_earned / An_award_one_short_is_not_earned", () => {
    const over = progress(inputs({ counters: counters({ tripsCompleted: 99 }) }));
    expect(over.awards.find((a) => a.id === "frequent-flyer")).toMatchObject({ current: 25, target: 25, earned: true });
    const short = progress(inputs({ counters: counters({ tripsCompleted: 24 }) }));
    expect(short.awards.find((a) => a.id === "frequent-flyer")).toMatchObject({ current: 24, earned: false });
    expect(short.awards.find((a) => a.id === "first-flight")?.earned).toBe(true);
  });

  it("newlyEarned lists only awards with no stored row, in catalog order, and replays nothing", () => {
    const i = inputs({ counters: counters({ tripsCompleted: 25 }) });
    const first = progress(i);
    expect(first.newlyEarned).toEqual(["first-flight", "frequent-flyer"]);
    const again = progress(i, new Set(first.newlyEarned));
    expect(again.newlyEarned).toEqual([]);
    expect(again.earnedCount).toBe(2);
  });

  it("an award never un-earns: a raised target or a tag correction keeps a stored award earned (U7)", () => {
    const raised = FIELD_AWARD_CATALOG.map((d) => (d.id === "frequent-flyer" ? { ...d, target: 50 } : d));
    const i = inputs({ counters: counters({ tripsCompleted: 25 }) });
    expect(evaluateFieldAwards(raised, i, new Set()).awards.find((a) => a.id === "frequent-flyer")?.earned).toBe(false);
    expect(evaluateFieldAwards(raised, i, new Set<FieldAwardId>(["frequent-flyer"])).awards.find((a) => a.id === "frequent-flyer")?.earned).toBe(true);
  });

  it("L5: a stored award keeps earned: true with current below a raised target (current is reported as is)", () => {
    const raised = FIELD_AWARD_CATALOG.map((d) => (d.id === "frequent-flyer" ? { ...d, target: 50 } : d));
    const p = evaluateFieldAwards(raised, inputs({ counters: counters({ tripsCompleted: 25 }) }), new Set<FieldAwardId>(["frequent-flyer"]));
    expect(p.awards.find((a) => a.id === "frequent-flyer")).toMatchObject({ current: 25, target: 50, earned: true, newlyEarned: false });
  });

  it("targets are integers >= 1: 0 or a negative becomes 1, a fraction rounds up, NaN and infinity throw; nearlyThere never divides by 0", () => {
    expect([effectiveTarget(0), effectiveTarget(-5), effectiveTarget(1), effectiveTarget(3.2), effectiveTarget(24901)]).toEqual([1, 1, 1, 4, 24901]);
    expect(() => effectiveTarget(Number.NaN)).toThrow(RangeError);
    expect(() => effectiveTarget(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    const zero = FIELD_AWARD_CATALOG.map((d) => (d.id === "frequent-flyer" ? { ...d, target: 0 } : d));
    const p = evaluateFieldAwards(zero, inputs());
    expect(p.awards.find((a) => a.id === "frequent-flyer")).toMatchObject({ target: 1, current: 0, earned: false }); // not earned by everybody at zero
    const hand = { awards: [{ id: "century", current: 3, target: 0, earned: false, newlyEarned: false }], newlyEarned: [], earnedCount: 0 } as const;
    expect(nearlyThere(FIELD_AWARD_CATALOG, hand)).toBeNull();
  });

  it("U7: a lowered target is awarded at the next evaluation", () => {
    const lowered = FIELD_AWARD_CATALOG.map((d) => (d.id === "frequent-flyer" ? { ...d, target: 3 } : d));
    const p = evaluateFieldAwards(lowered, inputs({ counters: counters({ tripsCompleted: 3 }) }));
    expect(p.newlyEarned).toContain("frequent-flyer");
  });

  it("unearnable-today awards stay locked with progress and advance when content appears (J6)", () => {
    const fourteenCards = ["787", "A320", "A380", "E175", "737", "777", "767", "757", "A330"].map((f) => com(f));
    const p = progress(inputs({ cards: fourteenCards }));
    const fleet = p.awards.find((a) => a.id === "fleet-admiral");
    expect(fleet).toMatchObject({ current: 9, target: 50, earned: false });
    // more content appears: the same awards, evaluated again, advance with no code change
    const more = [...fourteenCards, ...Array.from({ length: 41 }, (_, k) => com(`X${k}`))];
    expect(progress(inputs({ cards: more })).awards.find((a) => a.id === "fleet-admiral")).toMatchObject({ current: 50, earned: true });
    expect(p.awards.find((a) => a.id === "regional")).toMatchObject({ current: 1, target: 5, earned: false });
  });

  it("nearlyThere picks the visible unearned award with the most progress, catalog order on a tie, null when none", () => {
    expect(nearlyThere(FIELD_AWARD_CATALOG, progress(inputs()))).toBeNull();
    const p = progress(inputs({ counters: counters({ tripsCompleted: 20, bestDayStreak: 5 }) }));
    expect(nearlyThere(FIELD_AWARD_CATALOG, p)?.id).toBe("frequent-flyer"); // 20/25 beats 5/7? 0.8 vs 0.71
    const ahead = progress(inputs({ counters: counters({ tripsCompleted: 5, bestDayStreak: 1 }) }));
    expect(nearlyThere(FIELD_AWARD_CATALOG, ahead)?.id).toBe("frequent-flyer"); // 5/25 = 0.2 beats 1/7 = 0.14
    // a real tie: Five-by-Five 1/5 and Frequent Flyer 5/25 are both 0.2; the earlier catalog entry (Frequent Flyer) wins
    const tie = progress(inputs({ counters: counters({ identifierFullTrips: 1, tripsCompleted: 5 }) }));
    expect(tie.awards.find((a) => a.id === "flawless-five")).toMatchObject({ current: 1, target: 5 });
    expect(tie.awards.find((a) => a.id === "frequent-flyer")).toMatchObject({ current: 5, target: 25 });
    expect(nearlyThere(FIELD_AWARD_CATALOG, tie)?.id).toBe("frequent-flyer");
    const hiddenCatalog = FIELD_AWARD_CATALOG.map((d) => (d.id === "frequent-flyer" ? { ...d, hidden: true } : d));
    expect(nearlyThere(hiddenCatalog, p)?.id).toBe("week-on-the-line");
  });
});

// ---- Whole-history scenario --------------------------------------------------------------------------------------

describe("segment history to awards", () => {
  it("ASSUMPTION A18 (J12): counters from completed segments plus Cards earn First Solo, VFR Certified and First Clipper Card; Go Around needs the sequence and any correct Flight counts as green", () => {
    const flights = Array.from({ length: 10 }, () => ({ correct: true, perfect: true, hintUsed: false }));
    const bad = [...flights.slice(0, 9), { correct: false, perfect: false, hintUsed: false }];
    let c = EMPTY_COUNTERS;
    const log = { module: "identifier", miles: 500, completedLocal: { date: "2026-10-29", hour: 23, minute: 0 } } as const;
    c = withTrip(c, { ...log, flights: bad });
    const afterBad = progress(inputs({ counters: c, cards: [com("787")] }));
    expect(afterBad.newlyEarned).toEqual(["first-flight", "five-in-a-row", "first-card", "red-eye-special"]);
    c = withTrip(c, { ...log, flights });
    const earned = new Set(afterBad.newlyEarned);
    const afterGreen = progress(inputs({ counters: c, cards: [com("787")] }), earned);
    expect(afterGreen.newlyEarned).toEqual(["sharp-eyes", "go-around"]);
  });
});

// ---- Card keys ---------------------------------------------------------------------------------------------------

describe("Clipper Card keys", () => {
  const catalog = SEED_COMMERCIAL_CARD_KEYS;

  it("commercial keys are the Unity family; Military keys are mil: + the normalised client answer text", () => {
    expect(cardKeyFor("identifier", "787", catalog)).toEqual({ kind: "card", key: "787" });
    expect(cardKeyFor("identifier", " A320 ", catalog)).toEqual({ kind: "card", key: "A320" });
    expect(cardKeyFor("aircraft-identifier-military", "  Eurofighter   Typhoon ", catalog)).toEqual({ kind: "card", key: "mil:eurofighter typhoon" });
    expect(MILITARY_KEY_PREFIX).toBe("mil:");
    expect(cardKeySource("identifier")).toBe("unity_family");
    expect(cardKeySource("aircraft-identifier-military")).toBe("client_answer_text");
  });

  it("repeated rows share one Card (Typhoon x3) and variants stay separate (the three C-130 answers)", () => {
    const typhoons = ["Eurofighter Typhoon", "eurofighter typhoon", "Eurofighter  Typhoon", "EUROFIGHTER" + ch(9) + "TYPHOON" + ch(10)];
    expect(new Set(typhoons.map(militaryCardKey)).size).toBe(1);
    expect(militaryCardKey("Boeing F/A-18 Super Hornet")).not.toBe(militaryCardKey("Boeing F/A-18E/F Super Hornet"));
    expect(
      new Set(["Lockheed C-130 Hercules", "Lockheed Martin C-130J Super Hercules", "Lockheed Martin HC-130J Combat King II"].map(militaryCardKey)).size,
    ).toBe(3);
  });

  it("modules without Cards, empty values and a missing value give no Card", () => {
    const none = { kind: "no_card" };
    expect(cardKeyFor("tail-identifier", "787", catalog)).toEqual(none);
    expect(cardKeyFor("identifier", null, catalog)).toEqual(none);
    expect(cardKeyFor("identifier", "  ", catalog)).toEqual(none);
    expect(cardKeyFor("aircraft-identifier-military", "   ", catalog)).toEqual(none);
    expect(cardKeyFor("aircraft-identifier-military", undefined, catalog)).toEqual(none);
    expect(cardKeyFor("aircraft-identifier-military", ch(0x200b, 0xad), catalog)).toEqual(none); // only format characters
  });

  it("a commercial value must be a key of the seeded Card catalog: case variants and unknown families are rejected, never a second Card", () => {
    expect(cardKeyFor("identifier", "a320", catalog)).toEqual({ kind: "unknown_aircraft", value: "a320" });
    expect(cardKeyFor("identifier", "e175", catalog)).toEqual({ kind: "unknown_aircraft", value: "e175" });
    expect(cardKeyFor("identifier", "7478", catalog)).toEqual({ kind: "unknown_aircraft", value: "7478" });
    expect(cardKeyFor("identifier", "mil:eurofighter typhoon", catalog)).toEqual({ kind: "unknown_aircraft", value: "mil:eurofighter typhoon" });
    for (const k of catalog) expect(cardKeyFor("identifier", k, catalog)).toEqual({ kind: "card", key: k });
    expect(catalog.has("787") && catalog.has("A320") && catalog.has("CRJ") && catalog.has("DC-8")).toBe(true);
  });

  it("ASSUMPTION A20: Military keys are namespaced, so no Military key can equal a commercial family key", () => {
    for (const e of SEED_AIRCRAFT_TAG_ENTRIES) {
      const military = e.cardKey.startsWith(MILITARY_KEY_PREFIX);
      expect(catalog.has(e.cardKey), e.cardKey).toBe(!military);
    }
    // even an answer that is literally a family id cannot collide
    for (const family of ["787", "A320", "CRJ", "DC-8"]) {
      expect(militaryCardKey(family)).toBe("mil:" + family.toLowerCase());
      expect(militaryCardKey(family)).not.toBe(family);
      expect(catalog.has(militaryCardKey(family))).toBe(false);
    }
    expect(militaryCardKey("   ")).toBe("");
  });

  it("ASSUMPTION A14: normalisation = NFC, drop format characters, fold dashes, collapse Unicode whitespace, trim, simple lower-casing, NFC", () => {
    expect(normalizeAnswerText("Cafe" + ch(0x301) + " Racer")).toBe("caf" + ch(0xe9) + " racer"); // decomposed e + acute -> precomposed
    expect(normalizeAnswerText("A" + ch(0xa0, 0xa0) + "B")).toBe("a b");
    expect(normalizeAnswerText(ch(0x3000) + "A " + ch(0x2003) + " B" + ch(0x2028))).toBe("a b");
    expect(normalizeAnswerText("MiG-29UB")).toBe("mig-29ub"); // punctuation kept: not Unity's letters-and-digits tag key
    expect(normalizeAnswerText("STRASSE")).toBe("strasse"); // no full case folding: sharp s is not expanded
    expect(normalizeAnswerText("Stra" + ch(0xdf) + "e")).toBe("stra" + ch(0xdf) + "e");
    expect(militaryCardKey("T-28 Trojan")).toBe(militaryCardKey("t-28   TROJAN "));
  });

  it("ASSUMPTION A14: format characters (Cf) vanish: zero-width space, soft hyphen, BOM, joiners, bidi marks", () => {
    for (const cf of [0x200b, 0x00ad, 0xfeff, 0x200c, 0x200d, 0x2060, 0x200e, 0x202a]) {
      expect(normalizeAnswerText("Euro" + ch(cf) + "fighter Typhoon" + ch(cf)), cf.toString(16)).toBe("eurofighter typhoon");
    }
    expect(militaryCardKey(ch(0xfeff) + "Eurofighter Typhoon")).toBe(militaryCardKey("Eurofighter Typhoon"));
  });

  it("ASSUMPTION A14: every Unicode whitespace character, NEL (U+0085) included, is a space", () => {
    const spaces = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
    for (const sp of spaces) expect(normalizeAnswerText("North" + ch(sp) + "American" + ch(sp, sp) + "T-6"), sp.toString(16)).toBe("north american t-6");
    expect(normalizeAnswerText(ch(0x85) + "x" + ch(0x85))).toBe("x");
  });

  it("ASSUMPTION A14: dash variants fold to a hyphen-minus (U+2010..U+2015, U+2212, U+FE58, U+FE63, U+FF0D)", () => {
    for (const d of [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe58, 0xfe63, 0xff0d]) {
      expect(normalizeAnswerText("MiG" + ch(d) + "29UB Fulcrum" + ch(d) + "B"), d.toString(16)).toBe("mig-29ub fulcrum-b");
    }
    expect(militaryCardKey("Lockheed C" + ch(0x2013) + "130 Hercules")).toBe(militaryCardKey("Lockheed C-130 Hercules"));
  });

  it("ASSUMPTION A14: spaces around a slash are removed (Grumman TBF / TBM Avenger = TBF/TBM)", () => {
    expect(normalizeAnswerText("Grumman TBF / TBM Avenger")).toBe("grumman tbf/tbm avenger");
    expect(normalizeAnswerText("Grumman TBF/TBM Avenger")).toBe("grumman tbf/tbm avenger");
    expect(normalizeAnswerText("Grumman TBF  /  TBM Avenger")).toBe("grumman tbf/tbm avenger");
    expect(normalizeAnswerText("Grumman TBF" + ch(0xa0) + "/" + ch(0x2003) + "TBM Avenger")).toBe("grumman tbf/tbm avenger");
    expect(militaryCardKey("Boeing F/A-18E/F Super Hornet")).toBe("mil:boeing f/a-18e/f super hornet");
  });

  it("recordSighting: first sighting collects; later ones count up, latch perfect/hint-free and keep the fastest time", () => {
    const first = recordSighting(null, "x", "identifier", { perfect: false, hintUsed: true, answerMs: 4000 });
    expect(first).toMatchObject({ collected: true, card: { timesIdentified: 1, everPerfect: false, everHintFree: false, fastestCorrectMs: 4000 } });
    const second = recordSighting(first.card, "x", "identifier", { perfect: true, hintUsed: false, answerMs: 6000 });
    expect(second).toMatchObject({ collected: false, card: { timesIdentified: 2, everPerfect: true, everHintFree: true, fastestCorrectMs: 4000 } });
    const third = recordSighting(second.card, "x", "identifier", { perfect: false, hintUsed: true, answerMs: 1500 });
    expect(third.card).toMatchObject({ timesIdentified: 3, everPerfect: true, everHintFree: true, fastestCorrectMs: 1500 });
    expect(recordSighting(null, "y", "identifier", { perfect: true, hintUsed: false, answerMs: null }).card.fastestCorrectMs).toBeNull();
  });
});

// ---- Tag seed ----------------------------------------------------------------------------------------------------

describe("Aircraft tag seed (provisional, U8)", () => {
  const COMMERCIAL_FAMILIES = ["787", "A320", "A380", "E175", "737", "777", "767", "757", "A330"]; // identifier_questions.json today
  /** The 27 distinct values of the "Correct Answer" column of Military Airplane Identifier v1.xlsx (31 rows). */
  const MILITARY_ANSWERS = [
    "AgustaWestland AW139", "Beriev A-50 Mainstay", "Boeing B-29 Superfortress", "Boeing C-17 Globemaster III",
    "Boeing F/A-18E/F Super Hornet", "C-47 Skytrain", "CAC Wirraway", "Chance Vought F4U Corsair",
    "Chengdu FT-7BGI", "Consolidated PBY Catalina", "Dassault Mirage IIIE", "Eurocopter AS332 Super Puma", "Eurofighter Typhoon",
    "Grumman TBF / TBM Avenger", "Hawker Hurricane", "Lockheed C-130 Hercules", "Lockheed Martin C-130J Super Hercules",
    "Lockheed Martin F-16", "Lockheed Martin F-22 Raptor", "Lockheed Martin F-35A Lightning II", "Lockheed Martin HC-130J Combat King II",
    "Mikoyan MiG-29UB Fulcrum-B", "North American T-28 Trojan", "North American T-6 Texan", "Northrop Grumman B-2 Spirit",
    "Rockwell B-1B Lancer", "Warthog A-10 Thunderbolt II",
  ];

  it("Every_commercial_answer_is_in_the_tag_table_with_a_manufacturer", () => {
    for (const f of COMMERCIAL_FAMILIES) expect(tags.get(f)?.manufacturer, f).toBeTruthy();
  });

  it("Every_military_answer_is_in_the_tag_table (27 client correct answers, every key namespaced)", () => {
    expect(MILITARY_ANSWERS).toHaveLength(27);
    expect(new Set(MILITARY_ANSWERS.map(militaryCardKey)).size).toBe(27);
    for (const a of MILITARY_ANSWERS) {
      expect(tags.has(militaryCardKey(a)), a).toBe(true);
      expect(militaryCardKey(a).startsWith(MILITARY_KEY_PREFIX), a).toBe(true);
    }
  });

  // Skipped (shown as skipped) on a machine without ../docs, e.g. CI.
  it.skipIf(!existsSync(SHEET))("the 27 answers are exactly the distinct Correct Answer values of the client's real sheet (31 rows)", async () => {
    const { rows } = await militaryMapping.parse(await readFirstSheet(readFileSync(SHEET)));
    expect(rows).toHaveLength(31);
    const fromSheet = new Set(rows.map((r) => militaryCardKey(String(r.data.answer))));
    expect(fromSheet.size).toBe(27);
    expect(fromSheet).toEqual(new Set(MILITARY_ANSWERS.map(militaryCardKey)));
    // "Boeing F/A-18 Super Hornet" is only a wrong option (mil-a4): not a Card of the sheet.
    expect(fromSheet.has(militaryCardKey("Boeing F/A-18 Super Hornet"))).toBe(false);
    expect(fromSheet.has(militaryCardKey("Boeing F/A-18E/F Super Hornet"))).toBe(true);
  });

  it("the pre-tagged Unity aircraft that are not client correct answers stay in the table, provisional (incl. the F/A-18 spelling that is only a wrong option)", () => {
    const notInSheet = [
      "Lockheed C-5 Galaxy", "Ilyushin Il-76", "Bell Boeing V-22 Osprey", "Boeing AH-64 Apache", "Boeing CH-47 Chinook",
      "Sikorsky UH-60 Black Hawk", "Lockheed Martin F-35B Lightning II", "McDonnell Douglas AV-8B Harrier II", "Boeing F/A-18 Super Hornet",
    ];
    const sheet = new Set(MILITARY_ANSWERS.map(militaryCardKey));
    for (const a of notInSheet) {
      expect(tags.has(militaryCardKey(a)), a).toBe(true);
      expect(sheet.has(militaryCardKey(a)), a).toBe(false);
      expect(tags.get(militaryCardKey(a))?.manufacturerSource, a).toBe("provisional");
    }
  });

  it("with the client's 27 answers Rotorhead (needs 4) can reach only 2 rotary Cards, and Vertical Horizon's only VTOL tags are those same two helicopters (J5)", () => {
    const keys = MILITARY_ANSWERS.map(militaryCardKey);
    expect(keys.filter((k) => hasTag(tags, k, "military-rotary"))).toHaveLength(2);
    const vtol = keys.filter((k) => hasTag(tags, k, "vtol"));
    expect(vtol).toHaveLength(2);
    expect(vtol.every((k) => hasTag(tags, k, "military-rotary"))).toBe(true);
  });

  it("every entry is provisional except the two client-ruled tags", () => {
    for (const e of SEED_AIRCRAFT_TAG_ENTRIES) {
      if (e.manufacturer) expect(e.manufacturerSource).toBe("provisional");
      for (const t of e.tags) expect(t.source).toBe(t.tag === "quad-engine" || t.tag === "heavy" ? "client_ruling" : "provisional");
    }
  });

  it("Four_engine_jets_are_quad / Turboprops_pistons_and_twins_are_not_quad", () => {
    for (const k of ["747", "A340", "A380", "DC-8", militaryCardKey("Boeing C-17 Globemaster III"), militaryCardKey("Lockheed C-5 Galaxy"), militaryCardKey("Ilyushin Il-76")])
      expect(hasTag(tags, k, "quad-engine"), k).toBe(true);
    for (const a of ["Boeing B-29 Superfortress", "Lockheed C-130 Hercules", "Lockheed Martin C-130J Super Hercules", "Beriev A-50 Mainstay", "Lockheed Martin F-16"])
      expect(hasTag(tags, militaryCardKey(a), "quad-engine"), a).toBe(false);
    for (const k of ["737", "A320", "777", "787", "E175"]) expect(hasTag(tags, k, "quad-engine"), k).toBe(false);
  });

  it("The_sheets_heavy_list_is_heavy / Everything_else_is_not_heavy", () => {
    for (const k of ["747", "767", "777", "787", "A300", "A310", "A330", "A340", "A350"]) expect(hasTag(tags, k, "heavy"), k).toBe(true);
    for (const k of ["707", "717", "727", "737", "757", "A220", "A318", "A319", "A320", "A321", "A380", "E175", "CRJ", "DC-8"])
      expect(hasTag(tags, k, "heavy"), k).toBe(false);
  });

  it("A320_737_and_E175_are_neither quad nor heavy", () => {
    for (const k of ["A320", "737", "E175"]) {
      expect(hasTag(tags, k, "quad-engine")).toBe(false);
      expect(hasTag(tags, k, "heavy")).toBe(false);
    }
  });

  it("an unknown key is unknown: no tags, no manufacturer", () => {
    expect(tags.get("7478")).toBeUndefined();
    expect(hasTag(tags, "7478", "quad-engine")).toBe(false);
    expect(new Set(SEED_AIRCRAFT_TAG_ENTRIES.map((e) => e.cardKey)).size).toBe(SEED_AIRCRAFT_TAG_ENTRIES.length);
  });

  it("Beriev A-50 stays untagged for quad-engine pending the client (J4); helicopters are rotary and VTOL (J5)", () => {
    expect(hasTag(tags, militaryCardKey("Beriev A-50 Mainstay"), "quad-engine")).toBe(false);
    for (const a of ["AgustaWestland AW139", "Eurocopter AS332 Super Puma"]) {
      expect(hasTag(tags, militaryCardKey(a), "military-rotary")).toBe(true);
      expect(hasTag(tags, militaryCardKey(a), "vtol")).toBe(true);
    }
  });
});
