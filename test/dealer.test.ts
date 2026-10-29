import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { militaryMapping } from "../src/content/modules/military.js";
import { readFirstSheet } from "../src/content/xlsx.js";
import { FLIGHTS_PER_TRIP, MAX_FLIGHTS_AT_OWN_RANK, RANK_CATALOG } from "../src/rules/catalog.js";
import { militaryCardKey } from "../src/rules/clipper-cards.js";
import {
  DEAL_POLICY,
  DealNotSupportedError,
  DeckRandom,
  dealAnswerKey,
  dealAnswerKeyIsPortable,
  dealablePool,
  dealTrip,
  dealTripWithPolicy,
  fnv1a,
  tripCoverage,
  type DealItem,
  type DealPolicy,
  type DealtFlight,
} from "../src/rules/dealer.js";
import { MODULE_IDS, type ModuleId } from "../src/rules/modules.js";
import { DEALER_POOLS, dealerCases, renderDealerJson } from "./dealer-cases.js";
import { RANKS, rankIndex, type Rank } from "../src/rules/ranks.js";

// Mirrors Unity MilitaryMockDeckTests and InProcessMockDeckParityTests (names kept aligned), on in-memory pools.

const MILITARY = "aircraft-identifier-military" as const;
const COMMERCIAL = "identifier" as const;

function item(id: string, rank: Rank, answer: string, photoKey = `photo-${id}`): DealItem {
  return { id, rank, photoKey, answer, wrong: [`${id}-w1`, `${id}-w2`, `${id}-w3`] };
}

/** `perRank` items for every rank, ids `Rank-n`, distinct answers and photos. */
function evenPool(perRank: number): DealItem[] {
  const pool: DealItem[] = [];
  for (const rank of RANKS) for (let i = 0; i < perRank; i++) pool.push(item(`${rank}-${i}`, rank, `${rank} aircraft ${i}`));
  return pool;
}

/** Items by rank index list, ids q0.. (the same pools the independent reference port dealt for the goldens). */
function indexedPool(ranks: readonly number[]): DealItem[] {
  return ranks.map((r, i) => ({
    id: `q${i}`,
    rank: RANKS[r] as Rank,
    photoKey: `p${i}`,
    answer: `Ans ${i}`,
    wrong: [`w${i}a`, `w${i}b`, `w${i}c`] as const,
  }));
}

const byId = (pool: readonly DealItem[]) => new Map(pool.map((p) => [p.id, p]));
const seeds = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
const flat = (deck: readonly DealtFlight[]) => deck.map((f) => `${f.itemId}:${f.correctIndex}:${f.choices.join(",")}`).join("/");

// ---- the client's Military sheet, when the docs folder is present ----

const CLIENT_FILE = new URL("../../docs/Military Airplane Identifier v1.xlsx", import.meta.url);
const haveSheet = existsSync(CLIENT_FILE);
let sheetPool: DealItem[] = [];
let sheetAnswers: string[] = [];

beforeAll(async () => {
  if (!haveSheet) return;
  const parsed = militaryMapping.parse(await readFirstSheet(readFileSync(CLIENT_FILE)));
  sheetPool = parsed.rows.map((row, i) => {
    const data = row.data as { answer: string; wrong: [string, string, string]; sourceFile: string };
    return { id: `mil-a${i + 1}`, rank: row.rank, photoKey: data.sourceFile, answer: data.answer, wrong: data.wrong };
  });
  sheetAnswers = sheetPool.map((p) => p.answer);
});

describe("RNG: Unity Fnv1a and DeckRandom", () => {
  it("FNV-1a 32 over UTF-16 code units", () => {
    expect(fnv1a("")).toBe(2166136261);
    expect(fnv1a("a")).toBe(0xe40c292c); // published FNV-1a test vector
    expect(fnv1a("trip-1")).toBe(3993263260); // from an independent Python port
    // Code units, not UTF-8 bytes: U+00E9 is one unit (0xE9), U+1F600 is two surrogate units.
    expect(fnv1a("é")).toBe(Math.imul(2166136261 ^ 0xe9, 16777619) >>> 0); // a single unit 0xE9
    expect(fnv1a("\u{1F600}")).not.toBe(fnv1a("é"));
  });

  it("a blank seed is a valid seed and deals", () => {
    expect(dealTrip(MILITARY, evenPool(4), "captain", "")).toHaveLength(FLIGHTS_PER_TRIP);
  });
});

describe("dealAnswerKey: byte-exact port of MilitaryContent.NormalizeAnswer", () => {
  it("keeps letters and digits only, lower-cased; empty stays empty", () => {
    expect(dealAnswerKey("Eurofighter Typhoon")).toBe("eurofightertyphoon");
    expect(dealAnswerKey("eurofighter  TYPHOON.")).toBe("eurofightertyphoon");
    expect(dealAnswerKey("Boeing C-17 Globemaster III")).toBe("boeingc17globemasteriii");
    expect(dealAnswerKey("")).toBe("");
    expect(dealAnswerKey(" -./ ")).toBe("");
  });

  it("ASSUMPTION: NFC and NFD forms of the same text give different keys (no normalisation, as in C#)", () => {
    expect(dealAnswerKey("é")).toBe("é");
    expect(dealAnswerKey("é")).toBe("e"); // the combining mark (Mn) is dropped, the base letter stays
    expect(dealAnswerKey("Café")).not.toBe(dealAnswerKey("Café"));
  });

  it("ASSUMPTION: U+0130 stays as it is (.NET ToLowerInvariant does not map it to i); JS toLowerCase would", () => {
    expect(dealAnswerKey("İ")).toBe("İ");
    expect(dealAnswerKey("Iİ")).toBe("iİ");
    expect("İ".toLowerCase()).toBe("i̇"); // the JS behaviour the port deliberately does not use
    expect(dealAnswerKey("İstanbul")).not.toBe(dealAnswerKey("istanbul"));
  });

  it("works per UTF-16 code unit: supplementary-plane letters and digits are dropped, as C# char tests drop them", () => {
    expect(dealAnswerKey("a\u{1D7CE}b")).toBe("ab"); // MATHEMATICAL BOLD DIGIT ZERO is Nd in code points, two surrogates in UTF-16
    expect(dealAnswerKey("x\u{20000}y")).toBe("xy"); // CJK extension B ideograph
  });

  it("lower-cases each unit alone: no final sigma, no context", () => {
    expect(dealAnswerKey("ΟΔΟΣ")).toBe("οδοσ"); // sigma, not final sigma
    expect(dealAnswerKey("Ａ１")).toBe("ａ１"); // fullwidth A and 1 are Lu and Nd
  });

  it("keeps other decimal digits (Nd) and drops numbers that are not (Nl, No)", () => {
    expect(dealAnswerKey("٣")).toBe("٣"); // Arabic-Indic digit three
    expect(dealAnswerKey("Ⅷ")).toBe(""); // Roman numeral eight (Nl)
    expect(dealAnswerKey("²")).toBe(""); // superscript two (No)
  });

  it.skipIf(!haveSheet)("on the military-v1 rows, an equal Card key implies an equal deal key", () => {
    expect(sheetAnswers.length).toBeGreaterThanOrEqual(31);
    const groups = new Map<string, Set<string>>();
    for (const answer of sheetAnswers) {
      const card = militaryCardKey(answer);
      const set = groups.get(card) ?? new Set<string>();
      set.add(dealAnswerKey(answer));
      groups.set(card, set);
    }
    for (const [card, keys] of groups) expect([...keys], card).toHaveLength(1);
    // And the deal key is the coarser one on these rows: it never splits what the Card key joins.
    expect(new Set(sheetAnswers.map(dealAnswerKey)).size).toBeLessThanOrEqual(groups.size);
  });
});

describe("Military dealer (nearest-ranks): MilitaryMockDeckTests", () => {
  it.skipIf(!haveSheet)("Every_rank_gets_ten_distinct_photos_and_answers (client sheet, 31 rows)", () => {
    for (const rank of RANKS) {
      for (const seed of seeds(`dev-mock-mil-${rank}`, 25)) {
        const deck = dealTrip(MILITARY, sheetPool, rank, seed);
        const by = byId(sheetPool);
        expect(deck, rank).toHaveLength(FLIGHTS_PER_TRIP);
        expect(new Set(deck.map((f) => by.get(f.itemId)?.photoKey)).size, rank).toBe(FLIGHTS_PER_TRIP);
        expect(new Set(deck.map((f) => dealAnswerKey(by.get(f.itemId)?.answer ?? ""))).size, rank).toBe(FLIGHTS_PER_TRIP);
      }
    }
  });

  it("Every_rank_gets_ten_distinct_photos_and_answers (synthetic pool)", () => {
    const pool = evenPool(4);
    for (const rank of RANKS) {
      for (const seed of seeds("dev-mock-mil", 25)) {
        const deck = dealTrip(MILITARY, pool, rank, seed);
        const by = byId(pool);
        expect(deck).toHaveLength(FLIGHTS_PER_TRIP);
        expect(new Set(deck.map((f) => by.get(f.itemId)?.photoKey)).size).toBe(FLIGHTS_PER_TRIP);
        expect(new Set(deck.map((f) => dealAnswerKey(by.get(f.itemId)?.answer ?? ""))).size).toBe(FLIGHTS_PER_TRIP);
      }
    }
  });

  it("Own_rank_comes_first_and_thin_ranks_fill_from_higher_ranks_too", () => {
    const pool = [...RANKS.flatMap((rank, r) => Array.from({ length: r === 0 ? 4 : 8 }, (_, i) => item(`${rank}-${i}`, rank, `${rank} ${i}`)))];
    const by = byId(pool);
    for (const rank of RANKS) {
      const own = pool.filter((p) => p.rank === rank).length;
      const deck = dealTrip(MILITARY, pool, rank, `dev-mock-mil-rank-${rank}`);
      expect(deck.filter((f) => by.get(f.itemId)?.rank === rank).length, rank).toBe(Math.min(own, FLIGHTS_PER_TRIP));
    }
    const trainee = dealTrip(MILITARY, pool, "trainee", "dev-mock-mil-thin");
    expect(trainee.filter((f) => rankIndex(by.get(f.itemId)?.rank as Rank) > 0).length).toBeGreaterThan(0);
  });

  it("Fill_prefers_the_nearest_ranks", () => {
    const pool = evenPool(3);
    const by = byId(pool);
    const deck = dealTrip(MILITARY, pool, "captain", "dev-mock-mil-near");
    const levels = deck.map((f) => by.get(f.itemId)?.rank);
    expect(levels.filter((l) => l === "captain")).toHaveLength(3);
    expect(levels.filter((l) => l === "first-officer")).toHaveLength(3);
    expect(levels.filter((l) => l === "check-airman")).toHaveLength(3);
    expect(levels.filter((l) => l === "trainee" || l === "chief-pilot")).toHaveLength(1);
  });

  it("A_repeated_correct_answer_is_asked_at_most_once_per_trip", () => {
    const pool = Array.from({ length: 12 }, (_, i) => item(`d${i}`, "trainee", i < 4 ? "Eurofighter Typhoon" : `Aircraft ${i}`));
    pool[1] = item("d1", "trainee", "eurofighter  TYPHOON.");
    for (const seed of seeds("dev-mock-mil-dup", 20)) {
      const deck = dealTrip(MILITARY, pool, "trainee", seed);
      expect(deck, "12 questions hold only 9 distinct answers").toHaveLength(9);
      const by = byId(pool);
      const keys = deck.map((f) => dealAnswerKey(by.get(f.itemId)?.answer ?? ""));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("Options_are_the_rows_own_four_with_the_answer_always_present", () => {
    const pool = evenPool(4);
    const by = byId(pool);
    for (const rank of RANKS) {
      for (const flight of dealTrip(MILITARY, pool, rank, `dev-mock-mil-options-${rank}`)) {
        const source = by.get(flight.itemId) as DealItem;
        expect(flight.choices).toHaveLength(4);
        expect([...flight.choices].sort()).toEqual([source.answer, ...source.wrong].sort());
        expect(flight.choices[flight.correctIndex]).toBe(source.answer);
      }
    }
  });

  it("Options_are_reshuffled_between_trips", () => {
    const orders = new Set(seeds("dev-mock-mil-shuffle", 12).map((s) => dealTrip(MILITARY, evenPool(4), "captain", s).map((f) => f.choices.join(",")).join("|")));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("Answer_slots_are_balanced_across_A_to_D", () => {
    for (const rank of RANKS) {
      for (const seed of seeds(`dev-mock-mil-slots-${rank}`, 10)) {
        const deck = dealTrip(MILITARY, evenPool(4), rank, seed);
        for (let slot = 0; slot < 4; slot++) {
          const n = deck.filter((f) => f.correctIndex === slot).length;
          expect(n, `${rank} ${seed} slot ${slot}`).toBeGreaterThanOrEqual(2);
          expect(n, `${rank} ${seed} slot ${slot}`).toBeLessThanOrEqual(3);
        }
      }
    }
  });

  it("Same_session_id_deals_the_same_trip_and_other_ids_differ", () => {
    const pool = evenPool(4);
    const deal = (id: string) => flat(dealTrip(MILITARY, pool, "captain", id));
    expect(deal("dev-mock-mil-fixed")).toBe(deal("dev-mock-mil-fixed"));
    expect(new Set(seeds("dev-mock-mil", 8).map(deal)).size).toBeGreaterThan(1);
  });

  it("does not mutate the pool it is given", () => {
    const pool = evenPool(4);
    const before = JSON.stringify(pool);
    dealTrip(MILITARY, pool, "captain", "x");
    expect(JSON.stringify(pool)).toBe(before);
  });
});

describe("Commercial dealer (lower-ranks): InProcessMockDeckParityTests", () => {
  const pool = evenPool(20);
  const by = byId(pool);
  const levelOf = (f: DealtFlight) => rankIndex(by.get(f.itemId)?.rank as Rank);

  it("A_trip_is_ten_flights_at_every_rank", () => {
    for (const rank of RANKS) expect(dealTrip(COMMERCIAL, pool, rank, `dev-mock-seed-${rank}`)).toHaveLength(FLIGHTS_PER_TRIP);
  });

  it("Every_flight_offers_four_distinct_choices_including_its_answer", () => {
    for (const seed of seeds("dev-mock-seed", 64)) {
      for (const flight of dealTrip(COMMERCIAL, pool, "captain", seed)) {
        const source = by.get(flight.itemId) as DealItem;
        expect(new Set(flight.choices).size).toBe(4);
        expect(flight.choices[flight.correctIndex]).toBe(source.answer);
      }
    }
  });

  it("Answers_are_spread_across_A_to_D_in_every_trip", () => {
    for (const seed of seeds("dev-mock-seed", 64)) {
      expect(new Set(dealTrip(COMMERCIAL, pool, "trainee", seed).map((f) => f.correctIndex)).size, seed).toBe(4);
    }
  });

  it("A_photo_is_never_dealt_twice_in_a_trip", () => {
    const shared = evenPool(20).map((p, i) => ({ ...p, photoKey: `photo-${i % 12}` })); // photos repeat across items
    const sharedBy = byId(shared);
    for (const rank of RANKS) {
      for (const seed of seeds("dev-mock-seed", 64)) {
        const photos = dealTrip(COMMERCIAL, shared, rank, seed).map((f) => sharedBy.get(f.itemId)?.photoKey);
        expect(new Set(photos).size, `${seed} at ${rank}`).toBe(photos.length);
      }
    }
  });

  it("A_trip_deals_only_the_players_rank_and_below_with_at_most_six_at_the_rank", () => {
    for (const rank of RANKS) {
      for (const seed of seeds("dev-mock-seed", 64)) {
        const levels = dealTrip(COMMERCIAL, pool, rank, seed).map(levelOf);
        expect(Math.max(...levels), seed).toBeLessThanOrEqual(rankIndex(rank));
        if (rank !== "trainee") {
          const own = levels.filter((l) => l === rankIndex(rank)).length;
          expect(own, seed).toBeGreaterThanOrEqual(1);
          expect(own, seed).toBeLessThanOrEqual(MAX_FLIGHTS_AT_OWN_RANK);
        }
      }
    }
  });

  it("The_deck_is_deterministic_for_a_seed_and_varies_between_seeds", () => {
    const fingerprint = (s: string) => flat(dealTrip(COMMERCIAL, pool, "captain", s));
    expect(fingerprint("dev-mock-seed")).toBe(fingerprint("dev-mock-seed"));
    expect(new Set(seeds("dev-mock-seed", 64).map(fingerprint)).size).toBeGreaterThan(1);
  });

  it("a pool thin below the rank tops up from the rank itself (own rank past six)", () => {
    const thin = [...Array.from({ length: 12 }, (_, i) => item(`c${i}`, "captain", `Captain ${i}`)), item("t0", "trainee", "Trainee 0")];
    const thinBy = byId(thin);
    const deck = dealTrip(COMMERCIAL, thin, "captain", "thin");
    expect(deck).toHaveLength(FLIGHTS_PER_TRIP);
    expect(deck.filter((f) => thinBy.get(f.itemId)?.rank === "captain")).toHaveLength(9);
  });
});

describe("ASSUMPTION: C13/J8 behaviour, pinned to Unity today (a product ruling may change it)", () => {
  it("ASSUMPTION: Military deals higher ranks, nearest first, and ties go to the lower rank", () => {
    // Own rank captain has 2 items; every other rank has 4. Ten Flights: 2 own, then both distance-1 ranks
    // (first-officer below, check-airman ABOVE: 8 items) fill the rest, and the farther ranks are not reached.
    const pool = [
      ...Array.from({ length: 2 }, (_, i) => item(`cap${i}`, "captain", `Captain ${i}`)),
      ...Array.from({ length: 4 }, (_, i) => item(`fo${i}`, "first-officer", `FO ${i}`)),
      ...Array.from({ length: 4 }, (_, i) => item(`ca${i}`, "check-airman", `CA ${i}`)),
      ...Array.from({ length: 4 }, (_, i) => item(`tr${i}`, "trainee", `Trainee ${i}`)),
      ...Array.from({ length: 4 }, (_, i) => item(`cp${i}`, "chief-pilot", `Chief ${i}`)),
    ];
    const by = byId(pool);
    const ranks = (seed: string) => dealTrip(MILITARY, pool, "captain", seed).map((f) => by.get(f.itemId)?.rank);
    for (const seed of seeds("tie", 20)) {
      const dealt = ranks(seed);
      expect(dealt.filter((r) => r === "captain")).toHaveLength(2);
      expect(dealt.filter((r) => r === "first-officer")).toHaveLength(4); // distance 1, lower
      expect(dealt.filter((r) => r === "check-airman")).toHaveLength(4); // distance 1, HIGHER rank dealt
      expect(dealt.filter((r) => r === "trainee" || r === "chief-pilot")).toHaveLength(0);
    }
    // Tie at the cut: own 0, distance 1 has 6 + 6, a Trip takes 10 -> all 6 of the lower rank first, then 4 higher.
    const tie = [
      ...Array.from({ length: 6 }, (_, i) => item(`fo${i}`, "first-officer", `FO ${i}`)),
      ...Array.from({ length: 6 }, (_, i) => item(`ca${i}`, "check-airman", `CA ${i}`)),
    ];
    const tieBy = byId(tie);
    for (const seed of seeds("tie2", 20)) {
      const dealt = dealTrip(MILITARY, tie, "captain", seed).map((f) => tieBy.get(f.itemId)?.rank);
      expect(dealt.filter((r) => r === "first-officer")).toHaveLength(6);
      expect(dealt.filter((r) => r === "check-airman")).toHaveLength(4);
    }
  });

  it("ASSUMPTION: Military has no own-rank cap of 6 (all ten Flights can be the own rank)", () => {
    const pool = evenPool(12);
    const by = byId(pool);
    for (const seed of seeds("nocap", 10)) {
      const dealt = dealTrip(MILITARY, pool, "captain", seed).map((f) => by.get(f.itemId)?.rank);
      expect(dealt.filter((r) => r === "captain")).toHaveLength(FLIGHTS_PER_TRIP);
    }
    // The commercial rule, on the same pool, stops at the cap and goes below.
    const commercial = dealTrip(COMMERCIAL, pool, "captain", "nocap").map((f) => by.get(f.itemId)?.rank);
    expect(commercial.filter((r) => r === "captain")).toHaveLength(MAX_FLIGHTS_AT_OWN_RANK);
  });

  it("ASSUMPTION: rows without a photo cannot be dealt: dealablePool drops them and tripCoverage counts only that", () => {
    const pool = [...evenPool(3), item("nophoto", "trainee", "No Photo Aircraft", ""), item("blank", "trainee", "Blank Photo Aircraft", "  ")];
    expect(dealablePool(pool).map((p) => p.id)).toEqual(evenPool(3).map((p) => p.id));
    for (const policy of ["lower-ranks", "nearest-ranks"] as const) {
      for (const seed of seeds("nophoto", 10)) {
        const ids = dealTripWithPolicy(policy, dealablePool(pool), "trainee", seed).map((f) => f.itemId);
        expect(ids, policy).not.toContain("nophoto");
        expect(ids, policy).not.toContain("blank");
      }
    }
    const withBoth = tripCoverage(MILITARY, pool);
    expect(withBoth).toEqual(tripCoverage(MILITARY, evenPool(3)));
  });

  it("ASSUMPTION: the commercial rule does not dedupe answers; it dedupes by photo only", () => {
    const pool = Array.from({ length: 12 }, (_, i) => item(`s${i}`, "trainee", "Airbus A320"));
    expect(dealTrip(COMMERCIAL, pool, "trainee", "same-answers")).toHaveLength(FLIGHTS_PER_TRIP);
    expect(dealTrip(MILITARY, pool, "trainee", "same-answers")).toHaveLength(1);
    // Same photo, different answers: the commercial rule still deals each photo once.
    const photos = Array.from({ length: 12 }, (_, i) => item(`s${i}`, "trainee", `Answer ${i}`, "one-photo"));
    expect(dealTrip(COMMERCIAL, photos, "trainee", "same-photo")).toHaveLength(1);
  });
});

describe("pools the dealer cannot fill", () => {
  it("a thin pool deals shorter than a Trip, never padded or repeated", () => {
    const pool = evenPool(1); // 5 items in all
    for (const policy of ["lower-ranks", "nearest-ranks"] as const) {
      const deck = dealTripWithPolicy(policy, pool, "chief-pilot", "thin");
      expect(deck.length).toBeLessThan(FLIGHTS_PER_TRIP);
      expect(new Set(deck.map((f) => f.itemId)).size).toBe(deck.length);
    }
    expect(dealTrip(COMMERCIAL, pool, "chief-pilot", "thin")).toHaveLength(5); // lower ranks: all four below, plus own
    expect(dealTrip(COMMERCIAL, pool, "trainee", "thin")).toHaveLength(1); // nothing below, only the one trainee
  });

  it("a too-small pool (empty, or all one rank above) deals no Flights", () => {
    expect(dealTrip(MILITARY, [], "captain", "x")).toEqual([]);
    expect(dealTrip(COMMERCIAL, [], "captain", "x")).toEqual([]);
    // The commercial rule never deals above the rank, so a chief-pilot-only pool gives a trainee nothing.
    expect(dealTrip(COMMERCIAL, [item("c", "chief-pilot", "Chief")], "trainee", "x")).toEqual([]);
    expect(dealTrip(MILITARY, [item("c", "chief-pilot", "Chief")], "trainee", "x")).toHaveLength(1);
  });
});

describe("tripCoverage", () => {
  it("counts Flights dealable per rank, capped at a Trip", () => {
    expect(tripCoverage(MILITARY, evenPool(4))).toEqual({ trainee: 10, "first-officer": 10, captain: 10, "check-airman": 10, "chief-pilot": 10 });
    expect(tripCoverage(COMMERCIAL, evenPool(1))).toEqual({ trainee: 1, "first-officer": 2, captain: 3, "check-airman": 4, "chief-pilot": 5 });
    expect(tripCoverage(MILITARY, evenPool(1))).toEqual({ trainee: 5, "first-officer": 5, captain: 5, "check-airman": 5, "chief-pilot": 5 });
    expect(tripCoverage(MILITARY, [])).toEqual({ trainee: 0, "first-officer": 0, captain: 0, "check-airman": 0, "chief-pilot": 0 });
  });

  it("under nearest-ranks the count can vary by seed when one photo carries two answer keys", () => {
    const pool = [item("a", "trainee", "X", "p1"), item("b", "trainee", "Y", "p1"), item("c", "trainee", "X", "p2")];
    expect(dealTripWithPolicy("nearest-ranks", pool, "trainee", "t0")).toHaveLength(1);
    expect(dealTripWithPolicy("nearest-ranks", pool, "trainee", "t2")).toHaveLength(2);
    // Under lower-ranks it is seed-independent: the distinct photos.
    for (const seed of seeds("cov", 20)) expect(dealTripWithPolicy("lower-ranks", pool, "trainee", seed)).toHaveLength(2);
  });

  it("the two rules differ on the same pool (Military fills from higher ranks)", () => {
    const pool = [...Array.from({ length: 5 }, (_, i) => item(`t${i}`, "trainee", `T ${i}`)), ...Array.from({ length: 8 }, (_, i) => item(`f${i}`, "first-officer", `F ${i}`))];
    expect(tripCoverage(COMMERCIAL, pool).trainee).toBe(5);
    expect(tripCoverage(MILITARY, pool).trainee).toBe(10);
  });

  it.skipIf(!haveSheet)("the client's Military sheet covers a full Trip at every rank", () => {
    for (const count of Object.values(tripCoverage(MILITARY, sheetPool))) expect(count).toBe(FLIGHTS_PER_TRIP);
  });
});

describe("modules the server does not deal", () => {
  const dealt: ModuleId[] = [COMMERCIAL, MILITARY];

  it("DEAL_POLICY v1 covers exactly identifier (lower-ranks) and aircraft-identifier-military (nearest-ranks)", () => {
    expect(DEAL_POLICY).toEqual({ identifier: "lower-ranks", "aircraft-identifier-military": "nearest-ranks" } satisfies Partial<Record<ModuleId, DealPolicy>>);
  });

  it("ASSUMPTION: a Module without a policy throws DealNotSupportedError from dealTrip and tripCoverage", () => {
    for (const moduleId of MODULE_IDS.filter((m) => !dealt.includes(m))) {
      expect(() => dealTrip(moduleId, evenPool(4), "captain", "x"), moduleId).toThrow(DealNotSupportedError);
      expect(() => tripCoverage(moduleId, evenPool(4)), moduleId).toThrow(DealNotSupportedError);
    }
    expect(() => dealTrip("tail-identifier", [], "trainee", "x")).toThrow(/not dealt by the server/);
    // Prototype keys are not modules.
    expect(() => dealTrip("constructor" as ModuleId, evenPool(4), "captain", "x")).toThrow(DealNotSupportedError);
  });
});

describe("blank photos inside dealTrip behave like Unity (the filter is dealablePool's job)", () => {
  const photoless = (): DealItem[] => indexedPool([0, 0, 0]).map((p, i) => (i === 0 ? { ...p, photoKey: "" } : p));

  it("golden: a blank PhotoId is dealt and takes its place in the RNG stream (verified against the real C#)", () => {
    for (const moduleId of [COMMERCIAL, MILITARY] as const) {
      const deck = dealTrip(moduleId, photoless(), "trainee", "trip-1");
      expect(deck.map((f) => `${f.itemId}:${f.correctIndex}`), moduleId).toEqual(["q1:1", "q2:0", "q0:2"]);
      expect(deck[0]?.choices).toEqual(["w1b", "Ans 1", "w1a", "w1c"]);
      expect(deck[2]?.choices).toEqual(["w0b", "w0a", "Ans 0", "w0c"]);
    }
  });

  it("later blank photos dedupe on the empty string", () => {
    const pool = indexedPool([0, 0, 0]).map((p, i) => (i < 2 ? { ...p, photoKey: "" } : p));
    expect(dealTrip(COMMERCIAL, pool, "trainee", "x")).toHaveLength(2);
  });
});

describe("RNG seed 0 and item shape", () => {
  it("seed 0 is replaced by 0x9E3779B9 (golden xorshift32 outputs from an independent port)", () => {
    const zero = new DeckRandom(0);
    expect([zero.nextUInt(), zero.nextUInt()]).toEqual([1359758873, 3761132862]);
    const explicit = new DeckRandom(0x9e3779b9);
    expect([explicit.nextUInt(), explicit.nextUInt()]).toEqual([1359758873, 3761132862]);
    expect(new DeckRandom(1).nextUInt()).toBe(270369); // plain seed, no substitution
  });

  it("throws unless every item has exactly three wrong answers", () => {
    const bad = { ...item("bad", "trainee", "Bad"), wrong: ["a", "b"] } as unknown as DealItem;
    expect(() => dealTrip(COMMERCIAL, [bad], "trainee", "x")).toThrow(/exactly 3 wrong/);
    expect(() => dealTrip(MILITARY, [bad], "trainee", "x")).toThrow(/exactly 3 wrong/);
    const four = { ...item("four", "trainee", "Four"), wrong: ["a", "b", "c", "d"] } as unknown as DealItem;
    expect(() => dealTrip(MILITARY, [four], "trainee", "x")).toThrow(/exactly 3 wrong/);
  });
});

describe("dealAnswerKey portability", () => {
  it("ASSUMPTION: U+01C5 is lower-cased by Node but left unchanged by Unity Mono (known divergence, outside the portable range)", () => {
    expect(dealAnswerKey("\u01c5")).toBe("\u01c6"); // Node output; Mono keeps U+01C5
    expect(dealAnswerKeyIsPortable("\u01c5")).toBe(false);
  });

  it("dealAnswerKeyIsPortable is true only for UTF-16 units in U+0000 to U+01C4", () => {
    expect(dealAnswerKeyIsPortable("")).toBe(true);
    expect(dealAnswerKeyIsPortable("Eurofighter Typhoon \u0130 \u01c4")).toBe(true);
    expect(dealAnswerKeyIsPortable("a\u{1F600}")).toBe(false);
  });

  it.skipIf(!haveSheet)("the client's Military rows are portable today", () => {
    for (const answer of sheetAnswers) expect(dealAnswerKeyIsPortable(answer), answer).toBe(true);
  });
});

describe("golden decks: hand-checked against an independent Python port of the Unity code", () => {
  it("one commercial item, seed s1 (only the distractor shuffle consumes the RNG)", () => {
    expect(dealTrip(COMMERCIAL, indexedPool([0]), "trainee", "s1")).toEqual([
      { itemId: "q0", choices: ["Ans 0", "w0a", "w0c", "w0b"], correctIndex: 0 },
    ]);
  });

  it("commercial, captain, twelve items over three ranks, seed trip-1", () => {
    const deck = dealTrip(COMMERCIAL, indexedPool([2, 2, 2, 1, 1, 0, 0, 0, 2, 1, 0, 2]), "captain", "trip-1");
    expect(deck.map((f) => `${f.itemId}:${f.correctIndex}`)).toEqual(["q6:3", "q8:3", "q9:0", "q11:2", "q1:1", "q2:0", "q10:1", "q5:0", "q0:2", "q7:1"]);
    expect(deck[0]?.choices).toEqual(["w6b", "w6c", "w6a", "Ans 6"]);
    expect(deck[9]?.choices).toEqual(["w7a", "Ans 7", "w7c", "w7b"]);
  });

  it("military, first officer, twelve items over five ranks, seed trip-1", () => {
    const deck = dealTrip(MILITARY, indexedPool([0, 1, 2, 3, 4, 1, 0, 2, 3, 4, 1, 2]), "first-officer", "trip-1");
    expect(deck.map((f) => `${f.itemId}:${f.correctIndex}`)).toEqual(["q3:3", "q10:3", "q8:0", "q5:2", "q6:1", "q1:0", "q11:1", "q2:0", "q0:2", "q7:1"]);
    expect(deck[0]?.choices).toEqual(["w3b", "w3c", "w3a", "Ans 3"]);
  });

  it("military, trainee, twelve items over five ranks, empty seed (xorshift seed 0 path is not hit: FNV of empty is the offset basis)", () => {
    const deck = dealTrip(MILITARY, indexedPool([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 0, 1]), "trainee", "");
    expect(deck.map((f) => `${f.itemId}:${f.correctIndex}`)).toEqual(["q0:2", "q5:2", "q7:3", "q3:3", "q2:0", "q10:1", "q6:0", "q1:1", "q11:0", "q4:1"]);
    expect(deck[9]?.choices).toEqual(["w4a", "Ans 4", "w4b", "w4c"]);
  });
});

describe("contracts/dealer.v1.json cases (B4): self-consistency", () => {
  const cases = dealerCases();
  const published = JSON.parse(renderDealerJson()) as { cases: typeof cases; pools: Record<string, DealItem[]>; coverage: { pool: string; policy: DealPolicy; perRank: Record<Rank, number> }[] };

  it("replays every fixture case through dealTripWithPolicy to the same deck", () => {
    expect(published.cases.length).toBe(cases.length);
    expect(new Set(published.cases.map((c) => c.name)).size).toBe(published.cases.length);
    for (const c of published.cases) {
      const deck = dealTripWithPolicy(c.policy, published.pools[c.pool] as DealItem[], c.rank, c.seed);
      expect(deck.map((f) => ({ itemId: f.itemId, choices: [...f.choices], correctIndex: f.correctIndex })), c.name).toEqual(c.expect.deck);
    }
  });

  it("covers every rank x 3 seeds x both policies on military-v1 and each synthetic pool", () => {
    for (const policy of ["lower-ranks", "nearest-ranks"] as const) {
      for (const rank of RANKS) {
        const seeds = cases.filter((c) => c.pool === "military-v1" && c.policy === policy && c.rank === rank).map((c) => c.seed);
        expect(seeds.length, `${policy} ${rank}`).toBeGreaterThanOrEqual(3);
        for (const pool of ["thin-trainee", "duplicate-answers", "duplicate-photos", "too-small"]) {
          expect(cases.some((c) => c.pool === pool && c.policy === policy && c.rank === rank), `${pool} ${policy} ${rank}`).toBe(true);
        }
      }
    }
  });

  it("no pool has a blank or whitespace photoKey, and every string is portable for dealAnswerKey", () => {
    for (const [name, pool] of Object.entries(DEALER_POOLS)) {
      expect(new Set(pool.map((p) => p.id)).size, `${name} ids`).toBe(pool.length);
      for (const p of pool) {
        expect(p.photoKey.trim(), `${name} ${p.id} photoKey`).not.toBe("");
        expect(p.wrong.length).toBe(3);
        for (const text of [p.answer, ...p.wrong]) expect(dealAnswerKeyIsPortable(text), `${name} ${p.id} ${text}`).toBe(true);
      }
      expect(dealablePool(pool).length, name).toBe(pool.length);
    }
  });

  it("the synthetic pools exercise what they are named for", () => {
    const lower = (pool: string, rank: Rank) => dealTripWithPolicy("lower-ranks", DEALER_POOLS[pool] as DealItem[], rank, "trip-1");
    const nearest = (pool: string, rank: Rank) => dealTripWithPolicy("nearest-ranks", DEALER_POOLS[pool] as DealItem[], rank, "trip-1");
    expect(lower("thin-trainee", "trainee").length).toBe(3);
    expect(nearest("thin-trainee", "trainee").length).toBe(FLIGHTS_PER_TRIP);
    const keys = nearest("duplicate-answers", "trainee").map((f) => dealAnswerKey(f.choices[f.correctIndex] as string));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(FLIGHTS_PER_TRIP);
    const photoOf = new Map(DEALER_POOLS["duplicate-photos"]!.map((p) => [p.id, p.photoKey]));
    for (const policy of ["lower-ranks", "nearest-ranks"] as const) {
      const photos = dealTripWithPolicy(policy, DEALER_POOLS["duplicate-photos"] as DealItem[], "captain", "trip-1").map((f) => photoOf.get(f.itemId));
      expect(new Set(photos).size).toBe(photos.length);
    }
    for (const rank of RANKS) expect(lower("too-small", rank).length).toBeLessThan(FLIGHTS_PER_TRIP);
    expect(nearest("too-small", "trainee").length).toBe(9);
  });

  it("publishes military-v1 coverage for both policies, equal to tripCoverage", () => {
    expect(published.coverage.map((c) => `${c.pool}/${c.policy}`)).toEqual(["military-v1/lower-ranks", "military-v1/nearest-ranks"]);
    expect(published.coverage[0]!.perRank).toEqual(tripCoverage(COMMERCIAL, DEALER_POOLS["military-v1"] as DealItem[]));
    expect(published.coverage[1]!.perRank).toEqual(tripCoverage(MILITARY, DEALER_POOLS["military-v1"] as DealItem[]));
  });

  const UNITY_MILITARY = "C:/Unity/Projects/AviationArcade_v2/Assets/_Project/Resources/ClientContent/military_questions.json";
  it.skipIf(!existsSync(UNITY_MILITARY))("military-v1 equals Unity's bundled military_questions.json (this machine only)", () => {
    const unity = (JSON.parse(readFileSync(UNITY_MILITARY, "utf8")) as { questions: { id: string; photoId: string; level: string; answer: string; wrong: string[] }[] }).questions;
    const unityName = (rank: Rank) => RANK_CATALOG[rank].unity;
    expect((DEALER_POOLS["military-v1"] as DealItem[]).map((p) => ({ id: p.id, photoId: p.photoKey, level: unityName(p.rank), answer: p.answer, wrong: [...p.wrong] }))).toEqual(
      unity.map((q) => ({ id: q.id, photoId: q.photoId, level: q.level, answer: q.answer, wrong: q.wrong })),
    );
  });
});
