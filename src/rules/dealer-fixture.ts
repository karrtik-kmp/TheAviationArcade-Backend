import { DEAL_POLICY, dealTripWithPolicy, tripCoverage, type DealItem, type DealPolicy } from "./dealer.js";
import { FLIGHTS_PER_TRIP, MAX_FLIGHTS_AT_OWN_RANK } from "./catalog.js";
import { MODULE_IDS, type ModuleId } from "./modules.js";
import { RANKS, type Rank } from "./ranks.js";

/**
 * The frozen case source for `contracts/dealer.v1.json` (slice B4) and its renderer. It lives under `src/` rather
 * than `test/` because `nest build` compiles only `src/`, and `scripts/write-contracts.mjs` imports the compiled
 * `dist/rules/dealer-fixture.js` (the same arrangement as `catalog.ts`). `test/dealer-cases.ts` re-exports it.
 *
 * Expected decks are NOT hand-written: they come from `dealTripWithPolicy`, so the file says what the backend deals.
 * Unity's EditMode `DealerContractParityTests` (XU2) is the authority that its own mock dealers agree.
 *
 * Pools:
 *  - `military-v1`  the 30 photographed rows exactly as Unity bundles them (`Resources/ClientContent/military_questions.json`,
 *                   C-17 `mil-a5` is not in the bundle), in file order. `photoKey` = the row's `photoId` (what Unity's
 *                   `PickMilitaryQuestions` dedupes on); level enum names mapped to kebab ids through `RANK_CATALOG`.
 *  - `identifier-v1` the 31 commercial rows Unity bundles (`identifier_questions.json`), file order, 29 distinct photos.
 *  - synthetic: `thin-trainee`, `duplicate-answers`, `duplicate-photos`, `too-small`. Invented only to exercise dealer
 *    rules (never content a player sees).
 * Never edit the two frozen pools by hand: re-freeze from Unity when the client delivers new rows.
 */

function row(id: string, rank: Rank, photoKey: string, answer: string, wrong: readonly [string, string, string]): DealItem {
  return { id, rank, photoKey, answer, wrong };
}

/** The Military rows as Unity bundles them (30), in Unity's pool order. */
const MILITARY_V1: readonly DealItem[] = [
  row("mil-a1", "trainee", "mil-a1", "Warthog A-10 Thunderbolt II", ["Sukhoi Su-25 Frogfoot", "Ilyushin Il-102", "Northrop YA-9"]),
  row("mil-a2", "first-officer", "mil-a2", "Lockheed Martin F-16", ["Saab JAS 39 Gripen", "Chengdu J-10", "Dassault Mirage 2000"]),
  row("mil-a3", "trainee", "mil-a3", "Lockheed Martin F-22 Raptor", ["Lockheed Martin F-35", "Northrop YF-23", "Chengdu J-20"]),
  row("mil-a4", "captain", "mil-a4", "Eurofighter Typhoon", ["Dassault Rafale", "Saab JAS 39 Gripen", "Boeing F/A-18 Super Hornet"]),
  row("mil-a6", "captain", "mil-a6", "Lockheed Martin F-35A Lightning II", ["Boeing X-32", "Shenyang J-35", "Sukhoi Su-75"]),
  row("mil-a7", "chief-pilot", "mil-a7", "Rockwell B-1B Lancer", ["Tupolev Tu-160", "Tupolev Tu-22M", "General Dynamics F-111"]),
  row("mil-a8", "check-airman", "mil-a8", "Eurofighter Typhoon", ["Dassault Rafale", "Saab JAS 39 Gripen", "Boeing F/A-18E/F Super Hornet"]),
  row("mil-a9", "check-airman", "mil-a9", "Boeing F/A-18E/F Super Hornet", ["McDonnell Douglas F/A-18C/D Hornet", "Dassault Rafale M", "Mikoyan MiG-29K"]),
  row("mil-a10", "check-airman", "mil-a10", "Beriev A-50 Mainstay", ["Boeing E-3 Sentry", "Xi'an KJ-2000", "Beriev A-100 Premier"]),
  row("mil-a11", "chief-pilot", "mil-a11", "Eurocopter AS332 Super Puma", ["KAI KUH-1 Surion", "Sikorsky UH-60 Black Hawk", "NHIndustries NH90"]),
  row("mil-a12", "captain", "mil-a12", "Lockheed C-130 Hercules", ["Antonov An-12 Cub", "Alenia C-27J Spartan", "Airbus A400M Atlas"]),
  row("mil-a13", "captain", "mil-a13", "Chance Vought F4U Corsair", ["Grumman F6F Hellcat", "Hawker Sea Fury", "Grumman F8F Bearcat"]),
  row("mil-a14", "check-airman", "mil-a14", "CAC Wirraway", ["CAC Boomerang", "Curtiss-Wright CW-22 Falcon", "Miles Master"]),
  row("mil-a15", "chief-pilot", "mil-a15", "C-47 Skytrain", ["Curtiss C-46 Commando", "Lockheed Model 18 Lodestar", "Lisunov Li-2 Cab"]),
  row("mil-a16", "first-officer", "mil-a16", "Lockheed Martin HC-130J Combat King II", ["Lockheed Martin KC-130J", "Embraer C-390 Millennium", "Airbus A400M Atlas"]),
  row("mil-a17", "check-airman", "mil-a17", "North American T-28 Trojan", ["North American T-6 Texan", "Beechcraft T-34 Mentor", "Yakovlev Yak-52"]),
  row("mil-a18", "first-officer", "mil-a18", "Lockheed Martin C-130J Super Hercules", ["Alenia C-27J Spartan", "Embraer C-390 Millennium", "Shaanxi Y-9"]),
  row("mil-a19", "check-airman", "mil-a19", "Mikoyan MiG-29UB Fulcrum-B", ["McDonnell Douglas F-15D Eagle", "Boeing F/A-18B/D Hornet", "Shenyang J-16"]),
  row("mil-a20", "captain", "mil-a20", "North American T-6 Texan", ["CAC Wirraway", "Vultee BT-13 Valiant", "North American T-28 Trojan"]),
  row("mil-a21", "chief-pilot", "mil-a21", "Chengdu FT-7BGI", ["Mikoyan-Gurevich MiG-21UM", "Northrop T-38 Talon", "Dassault Mirage III B"]),
  row("mil-a22", "chief-pilot", "mil-a22", "AgustaWestland AW139", ["Airbus Helicopters H160", "Eurocopter AS365 Dauphin", "Sikorsky S-76"]),
  row("mil-a23", "first-officer", "mil-a23", "North American T-28 Trojan", ["North American T-6 Texan", "Beechcraft T-34 Mentor", "Yakovlev Yak-52"]),
  row("mil-a24", "trainee", "mil-a24", "Northrop Grumman B-2 Spirit", ["Northrop Grumman B-21 Raider", "Lockheed F-117 Nighthawk", "Xi'an H-20"]),
  row("mil-a25", "chief-pilot", "mil-a25", "Grumman TBF / TBM Avenger", ["Curtiss SB2C Helldiver", "Douglas TBD Devastator", "Douglas A-1 Skyraider"]),
  row("mil-a26", "trainee", "mil-a26", "Eurofighter Typhoon", ["Dassault Rafale", "Boeing F/A-18E/F Super Hornet", "Saab JAS 39 Gripen"]),
  row("mil-a27", "check-airman", "mil-a27", "AgustaWestland AW139", ["Airbus Helicopters H160", "Sikorsky S-76", "Bell 412"]),
  row("mil-a28", "captain", "mil-a28", "Consolidated PBY Catalina", ["Martin PBM Mariner", "Short Sunderland", "Canadair CL-215"]),
  row("mil-a29", "trainee", "mil-a29", "Boeing B-29 Superfortress", ["Convair B-36 Peacemaker", "Avro Lincoln", "Tupolev Tu-4 Bull"]),
  row("mil-a30", "first-officer", "mil-a30", "Dassault Mirage IIIE", ["Saab 35 Draken", "Convair F-106 Delta Dart", "IAI Nesher"]),
  row("mil-a31", "check-airman", "mil-a31", "Hawker Hurricane", ["Supermarine Spitfire", "Messerschmitt Bf 109", "Curtiss P-40 Warhawk"]),
];

/** The commercial Identifier rows as Unity bundles them (31), in Unity's pool order. */
const IDENTIFIER_V1: readonly DealItem[] = [
  row("ai-a1", "captain", "ai-a1", "Boeing 787-10", ["Boeing 787-9", "Boeing 787-8", "Boeing 767-200"]),
  row("ai-a2", "trainee", "ai-a2", "Boeing 787", ["Boeing 767", "Airbus A330", "Boeing 757"]),
  row("ai-a3", "trainee", "ai-a3", "Airbus A319", ["Airbus A320", "Airbus A321", "Boeing 737"]),
  row("ai-a4", "chief-pilot", "ai-a4", "Airbus A319-115", ["Airbus A319-151N", "Airbus A319-171N", "Airbus ACJ319"]),
  row("ai-a5", "trainee", "ai-a5", "Airbus A380", ["Boeing 747", "Airbus A330", "Airbus A340"]),
  row("ai-a6", "captain", "ai-a6", "Embraer E175", ["Bombardier CRJ900", "Embraer E195", "Airbus A220"]),
  row("ai-a7", "trainee", "ai-a7", "Boeing 737", ["Airbus A320", "Airbus A321", "Boeing 727"]),
  row("ai-a9", "first-officer", "ai-a9", "Airbus A320neo", ["Airbus A320ceo", "Boeing 737NG", "Boeing 737-MAX"]),
  row("ai-a10", "check-airman", "ai-a10", "Airbus A320neo", ["Boeing 737-700", "Boeing 737-MAX", "Airbus A320ceo"]),
  row("ai-a11", "trainee", "ai-a11", "Airbus A321", ["Boeing 737", "Airbus A319", "Boeing 717"]),
  row("ai-a11-2", "chief-pilot", "ai-a11", "Airbus A321neo", ["Airbus A321ceo", "Airbus A320neo", "Airbus A320ceo"]),
  row("ai-a12", "trainee", "ai-a12", "Airbus A319", ["Airbus A320", "Airbus A321", "Boeing 737"]),
  row("ai-a13", "first-officer", "ai-a13", "Boeing 777-200ER", ["Boeing 777-300", "Boeing 777-8", "Boeing 777-9"]),
  row("ai-a15", "first-officer", "ai-a15", "Boeing 787", ["Boeing 777", "Boeing 767", "Boeing 757"]),
  row("ai-a16", "chief-pilot", "ai-a16", "Boeing 737", ["Airbus A319", "Airbus A320", "Airbus A321"]),
  row("ai-a17", "check-airman", "ai-a17", "Boeing 767-300ER", ["Boeing 777-300", "Boeing 777-200ER", "Boeing 767-400ER"]),
  row("ai-a18", "check-airman", "ai-a18", "Embraer ERJ-175LR", ["Embraer ERJ-175", "Embraer E175-E2", "Embraer ERJ-195"]),
  row("ai-a18-2", "first-officer", "ai-a18", "Embraer ERJ-175", ["Airbus A220", "Boeing 717", "Embraer ERJ-195"]),
  row("ai-a19", "first-officer", "ai-a19", "Airbus A320neo", ["Airbus A321neo", "Airbus A320ceo", "Boeing 737-MAX"]),
  row("ai-a20", "captain", "ai-a20", "Airbus A320neo", ["Airbus A321neo", "Airbus A320ceo", "Boeing 737-MAX"]),
  row("ai-a21", "first-officer", "ai-a21", "Boeing 737-700", ["Boeing 737-800", "Boeing 737-MAX8", "Boeing 737-MAX7"]),
  row("ai-a22", "trainee", "ai-a22", "Boeing 737", ["Airbus A319", "Airbus A320", "Airbus A321"]),
  row("ai-a23", "trainee", "ai-a23", "Boeing 787", ["Boeing 777", "Boeing 767", "Boeing 757"]),
  row("ai-a24", "trainee", "ai-a24", "Boeing 787", ["Boeing 777", "Airbus A350", "Boeing 767"]),
  row("ai-a25", "captain", "ai-a25", "Boeing 787-9", ["Boeing 787-8", "Boeing 787-10", "Airbus A350"]),
  row("ai-a26", "chief-pilot", "ai-a26", "Boeing 787", ["Boeing 777", "Airbus A350", "Boeing 767"]),
  row("ai-a27", "trainee", "ai-a27", "Airbus A320neo", ["Boeing 737-MAX8", "Airbus A220-300", "Boeing 737-800"]),
  row("ai-a28", "captain", "ai-a28", "Airbus A320neo", ["Airbus A220-300", "Boeing 737-800", "Boeing 737-MAX8"]),
  row("ai-a29", "check-airman", "ai-a29", "Boeing 757-200", ["Boeing 757-300", "Boeing 737-900", "Boeing 737-MAX10"]),
  row("ai-a30", "trainee", "ai-a30", "Airbus A320", ["Airbus A220", "Boeing 737", "Boeing 757"]),
  row("ai-a31", "captain", "ai-a31", "Airbus A330", ["Boeing 777", "Boeing 767", "Airbus A340"]),
];

function synth(id: string, rank: Rank, answer: string, photoKey = `${id}-photo`): DealItem {
  return row(id, rank, photoKey, answer, [`${answer} (wrong 1)`, `${answer} (wrong 2)`, `${answer} (wrong 3)`]);
}

/** Thin at Trainee (3 rows), fuller above: lower-ranks cannot fill a Trainee Trip, nearest-ranks can. 23 rows. */
const THIN_TRAINEE: readonly DealItem[] = [
  ...[1, 2, 3].map((n) => synth(`tt-t${n}`, "trainee", `Thin Trainee Aircraft ${n}`)),
  ...[1, 2, 3, 4, 5, 6].map((n) => synth(`tt-f${n}`, "first-officer", `Thin First Officer Aircraft ${n}`)),
  ...[1, 2, 3, 4, 5, 6].map((n) => synth(`tt-c${n}`, "captain", `Thin Captain Aircraft ${n}`)),
  ...[1, 2, 3, 4].map((n) => synth(`tt-k${n}`, "check-airman", `Thin Check Airman Aircraft ${n}`)),
  ...[1, 2, 3, 4].map((n) => synth(`tt-p${n}`, "chief-pilot", `Thin Chief Pilot Aircraft ${n}`)),
];

/** Answers that differ only by case, punctuation and spacing: nearest-ranks deals one of each, lower-ranks does not dedupe. */
const DUPLICATE_ANSWERS: readonly DealItem[] = [
  synth("da-1", "trainee", "F-16 Fighting Falcon"),
  synth("da-2", "trainee", "f16 fighting falcon"),
  synth("da-3", "first-officer", "F 16 FIGHTING FALCON"),
  synth("da-4", "first-officer", "A-10 Warthog"),
  synth("da-5", "captain", "a10 warthog"),
  synth("da-6", "captain", "Eurofighter Typhoon"),
  synth("da-7", "captain", "Dassault Rafale"),
  synth("da-8", "check-airman", "Saab Gripen"),
  synth("da-9", "check-airman", "Su-27 Flanker"),
  synth("da-10", "chief-pilot", "B-2 Spirit"),
  synth("da-11", "chief-pilot", "B-52 Stratofortress"),
  synth("da-12", "trainee", "T-38 Talon"),
  synth("da-13", "first-officer", "C-130 Hercules"),
  synth("da-14", "trainee", "KC-135 Stratotanker"),
  synth("da-15", "captain", "E-3 Sentry"),
  synth("da-16", "trainee", "Dassault Rafale!"),
];

/** Rows that share a photo (with different answers): a Trip deals each photo at most once. 16 rows, 13 photos. */
const DUPLICATE_PHOTOS: readonly DealItem[] = [
  synth("dp-1", "trainee", "Photo Twin Alpha", "dp-photo-1"),
  synth("dp-2", "trainee", "Photo Twin Bravo", "dp-photo-1"),
  synth("dp-3", "first-officer", "Photo Triplet Alpha", "dp-photo-2"),
  synth("dp-4", "first-officer", "Photo Triplet Bravo", "dp-photo-2"),
  synth("dp-5", "captain", "Photo Triplet Charlie", "dp-photo-2"),
  ...[6, 7, 8].map((n) => synth(`dp-${n}`, "trainee", `Solo Trainee Aircraft ${n}`)),
  ...[9, 10, 11].map((n) => synth(`dp-${n}`, "first-officer", `Solo First Officer Aircraft ${n}`)),
  ...[12, 13].map((n) => synth(`dp-${n}`, "captain", `Solo Captain Aircraft ${n}`)),
  synth("dp-14", "check-airman", "Solo Check Airman Aircraft 14"),
  synth("dp-15", "check-airman", "Solo Check Airman Aircraft 15"),
  synth("dp-16", "chief-pilot", "Solo Chief Pilot Aircraft 16"),
];

/** Fewer than 10 distinct photos at any rank: no Trip can be filled; a Trip is shorter than 10. 10 rows, 9 photos. */
const TOO_SMALL: readonly DealItem[] = [
  synth("ts-1", "trainee", "Small Pool Aircraft 1"),
  synth("ts-2", "trainee", "Small Pool Aircraft 2"),
  synth("ts-3", "first-officer", "Small Pool Aircraft 3"),
  synth("ts-4", "first-officer", "Small Pool Aircraft 4"),
  synth("ts-5", "captain", "Small Pool Aircraft 5"),
  synth("ts-6", "captain", "Small Pool Aircraft 6"),
  synth("ts-7", "check-airman", "Small Pool Aircraft 7"),
  synth("ts-8", "check-airman", "Small Pool Aircraft 8"),
  synth("ts-9", "chief-pilot", "Small Pool Aircraft 9"),
  synth("ts-10", "trainee", "Small Pool Aircraft 10", "ts-1-photo"),
];

/** The named pools, in the order they are published. */
export const DEALER_POOLS: Readonly<Record<string, readonly DealItem[]>> = {
  "military-v1": MILITARY_V1,
  "identifier-v1": IDENTIFIER_V1,
  "thin-trainee": THIN_TRAINEE,
  "duplicate-answers": DUPLICATE_ANSWERS,
  "duplicate-photos": DUPLICATE_PHOTOS,
  "too-small": TOO_SMALL,
};

export const DEALER_FORMAT = "dealer.v1";
/** The RNG, as the consumer must implement it: FNV-1a 32 over UTF-16 code units seeds xorshift32. */
export const DEALER_RNG = "fnv1a32-utf16+xorshift32";

/** Seeds every rank is dealt with on the two frozen pools. */
const SEEDS = ["trip-1", "trip-2", "trip-3"] as const;
/** Seed edge cases (empty string, non-ASCII UTF-16), dealt at one rank per policy on `military-v1`. */
const EDGE_SEEDS = ["", "Zürich-✈"] as const;

export type DealerCase = {
  readonly name: string;
  readonly pool: string;
  readonly policy: DealPolicy;
  readonly rank: Rank;
  readonly seed: string;
  readonly expect: {
    readonly deck: readonly { readonly itemId: string; readonly choices: readonly string[]; readonly correctIndex: number }[];
  };
};

const POLICIES: readonly DealPolicy[] = ["lower-ranks", "nearest-ranks"];

function makeCase(pool: string, policy: DealPolicy, rank: Rank, seed: string): DealerCase {
  const deck = dealTripWithPolicy(policy, DEALER_POOLS[pool] as readonly DealItem[], rank, seed);
  return {
    name: `${pool}/${policy}/${rank}/${seed === "" ? "(empty seed)" : seed}`,
    pool,
    policy,
    rank,
    seed,
    expect: { deck: deck.map((f) => ({ itemId: f.itemId, choices: [...f.choices], correctIndex: f.correctIndex })) },
  };
}

/** Every case, in published order. Expected decks come from `dealTripWithPolicy`. */
export function dealerCases(): DealerCase[] {
  const cases: DealerCase[] = [];
  for (const policy of POLICIES) for (const rank of RANKS) for (const seed of SEEDS) cases.push(makeCase("military-v1", policy, rank, seed));
  for (const policy of POLICIES) for (const seed of EDGE_SEEDS) cases.push(makeCase("military-v1", policy, "trainee", seed));
  for (const rank of RANKS) for (const seed of SEEDS) cases.push(makeCase("identifier-v1", "lower-ranks", rank, seed));
  for (const pool of ["thin-trainee", "duplicate-answers", "duplicate-photos", "too-small"]) {
    for (const policy of POLICIES) for (const rank of RANKS) cases.push(makeCase(pool, policy, rank, "trip-1"));
  }
  return cases;
}

/** The Module whose `DEAL_POLICY` entry is `policy` (coverage is asked per Module). */
function moduleFor(policy: DealPolicy): ModuleId {
  const found = MODULE_IDS.find((id) => DEAL_POLICY[id] === policy);
  if (!found) throw new Error(`No Module is dealt by ${policy}.`);
  return found;
}

/** Coverage published for a pool under a policy: Flights a Trip would hold per rank (`tripCoverage`, capped at 10). */
function coverageFor(pool: string, policy: DealPolicy): { pool: string; policy: DealPolicy; perRank: Record<Rank, number> } {
  return { pool, policy, perRank: tripCoverage(moduleFor(policy), DEALER_POOLS[pool] as readonly DealItem[]) };
}

/**
 * The published dealer contract (`contracts/dealer.v1.json`): format, RNG, Trip constants, the policy per dealt
 * Module, the pools, the golden cases and the coverage of `military-v1` under both policies. Stable key order,
 * 2-space indent, LF, one trailing newline.
 */
export function renderDealerJson(): string {
  const dealer = {
    format: DEALER_FORMAT,
    rng: DEALER_RNG,
    flightsPerTrip: FLIGHTS_PER_TRIP,
    maxFlightsAtOwnRank: MAX_FLIGHTS_AT_OWN_RANK,
    modulePolicy: Object.fromEntries(MODULE_IDS.flatMap((id) => (DEAL_POLICY[id] ? [[id, DEAL_POLICY[id]]] : []))),
    pools: Object.fromEntries(
      Object.entries(DEALER_POOLS).map(([name, items]) => [
        name,
        items.map((i) => ({ id: i.id, rank: i.rank, photoKey: i.photoKey, answer: i.answer, wrong: [...i.wrong] })),
      ]),
    ),
    cases: dealerCases(),
    coverage: POLICIES.map((policy) => coverageFor("military-v1", policy)),
  };
  return `${JSON.stringify(dealer, null, 2)}\n`;
}
