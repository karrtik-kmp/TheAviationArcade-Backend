import { commercialCardKey, militaryCardKey } from "./clipper-cards.js";

/**
 * Aircraft tags behind the tag-based Field Awards, seeded from Unity AircraftTags.cs (design U8, J5).
 * AUTHORED BY US, NOT THE CLIENT: the sheet names the categories, not the members, except two client rulings
 * (2026-10-28): quad-engine is four-engine JETS only (no A400M, turboprop or piston) and heavy is exactly the
 * sheet's Heavy Metal list (747, 767, 777, 787, A300, A310, A330, A340, A350). Every other tag and every
 * manufacturer is `provisional` until the client's attribute grid replaces it (J5).
 *
 * Keyed by CARD KEY (clipper-cards.ts), not by Unity's letters-and-digits name: commercial rows use the Unity family
 * ids, Military rows `mil:` + the normalised client answer text. Unity's prefix lookup ("Boeing 737-700" -> "737") is not
 * needed because the Card key is already the family.
 */
export const AIRCRAFT_TAGS = [
  "quad-engine",
  "regional-jet",
  "fighter-attack",
  "military-rotary",
  "vtol",
  "piston",
  "heavy",
] as const;
export type AircraftTag = (typeof AIRCRAFT_TAGS)[number];

export type TagSource = "client_sheet" | "client_ruling" | "provisional";

export type AircraftTagEntry = {
  cardKey: string;
  manufacturer: string | null;
  manufacturerSource: TagSource | null;
  tags: readonly { tag: AircraftTag; source: TagSource }[];
};

export type AircraftTagTable = ReadonlyMap<string, AircraftTagEntry>;

const Q: AircraftTag = "quad-engine";
const R: AircraftTag = "regional-jet";
const F: AircraftTag = "fighter-attack";
const ROT: AircraftTag = "military-rotary";
const V: AircraftTag = "vtol";
const P: AircraftTag = "piston";
const HV: AircraftTag = "heavy";

/** The client's rulings cover exactly these two tags; everything else about an aircraft is provisional. */
const RULED: ReadonlySet<AircraftTag> = new Set<AircraftTag>([Q, HV]);

function entry(cardKey: string, manufacturer: string, tags: readonly AircraftTag[]): AircraftTagEntry {
  return {
    cardKey,
    manufacturer: manufacturer || null,
    manufacturerSource: manufacturer ? "provisional" : null,
    tags: tags.map((tag) => ({ tag, source: RULED.has(tag) ? "client_ruling" : "provisional" })),
  };
}

/** Commercial Cards: the Unity families (identifier_questions.json today, plus the catalog ids Unity pre-tagged). */
const COMMERCIAL: readonly [family: string, maker: string, tags: readonly AircraftTag[]][] = [
  ["707", "Boeing", []],
  ["717", "Boeing", []],
  ["727", "Boeing", []],
  ["737", "Boeing", []],
  ["747", "Boeing", [Q, HV]],
  ["757", "Boeing", []],
  ["767", "Boeing", [HV]],
  ["777", "Boeing", [HV]],
  ["787", "Boeing", [HV]],
  ["A220", "Airbus", []],
  ["A300", "Airbus", [HV]],
  ["A310", "Airbus", [HV]],
  ["A318", "Airbus", []],
  ["A319", "Airbus", []],
  ["A320", "Airbus", []],
  ["A321", "Airbus", []],
  ["A330", "Airbus", [HV]],
  ["A340", "Airbus", [Q, HV]],
  ["A350", "Airbus", [HV]],
  ["A380", "Airbus", [Q]],
  ["E175", "Embraer", [R]],
  ["CRJ", "Bombardier", [R]],
  // Not in today's questions; Unity tags it so a future delivery needs no code change.
  ["DC-8", "Douglas", [Q]],
];

/**
 * Military Cards: the 27 distinct values of the "Correct Answer" column of Military Airplane Identifier v1.xlsx (the
 * client's text; 31 rows), then the aircraft Unity pre-tagged that are not correct answers in the sheet (keys are our
 * guess of the client's wording; provisional).
 * Beriev A-50 is left untagged for quad-engine pending the client's answer (CLIENT_CONTENT_IMPORT).
 */
const MILITARY: readonly [answer: string, maker: string, tags: readonly AircraftTag[]][] = [
  ["AgustaWestland AW139", "AgustaWestland", [ROT, V]],
  ["Beriev A-50 Mainstay", "Beriev", []],
  ["Boeing B-29 Superfortress", "Boeing", [P]],
  ["Boeing C-17 Globemaster III", "Boeing", [Q]],
  ["Boeing F/A-18E/F Super Hornet", "Boeing", [F]],
  ["C-47 Skytrain", "Douglas", [P]],
  ["CAC Wirraway", "CAC", [P]],
  ["Chance Vought F4U Corsair", "Chance Vought", [F, P]],
  ["Chengdu FT-7BGI", "Chengdu", [F]],
  ["Consolidated PBY Catalina", "Consolidated", [P]],
  ["Dassault Mirage IIIE", "Dassault", [F]],
  ["Eurocopter AS332 Super Puma", "Eurocopter", [ROT, V]],
  ["Eurofighter Typhoon", "Eurofighter", [F]],
  ["Grumman TBF / TBM Avenger", "Grumman", [P]],
  ["Hawker Hurricane", "Hawker", [F, P]],
  ["Lockheed C-130 Hercules", "Lockheed", []],
  ["Lockheed Martin C-130J Super Hercules", "Lockheed Martin", []],
  ["Lockheed Martin F-16", "Lockheed Martin", [F]],
  ["Lockheed Martin F-22 Raptor", "Lockheed Martin", [F]],
  ["Lockheed Martin F-35A Lightning II", "Lockheed Martin", [F]],
  ["Lockheed Martin HC-130J Combat King II", "Lockheed Martin", []],
  ["Mikoyan MiG-29UB Fulcrum-B", "Mikoyan", [F]],
  ["North American T-28 Trojan", "North American", [P]],
  ["North American T-6 Texan", "North American", [P]],
  ["Northrop Grumman B-2 Spirit", "Northrop Grumman", []],
  ["Rockwell B-1B Lancer", "Rockwell", []],
  ["Warthog A-10 Thunderbolt II", "Fairchild Republic", [F]],
  // Pre-tagged by Unity, not in the sheet yet.
  ["Lockheed C-5 Galaxy", "Lockheed", [Q]],
  ["Ilyushin Il-76", "Ilyushin", [Q]],
  ["Bell Boeing V-22 Osprey", "Bell Boeing", [ROT, V]],
  ["Boeing AH-64 Apache", "Boeing", [ROT, V]],
  ["Boeing CH-47 Chinook", "Boeing", [ROT, V]],
  ["Sikorsky UH-60 Black Hawk", "Sikorsky", [ROT, V]],
  ["Lockheed Martin F-35B Lightning II", "Lockheed Martin", [F, V]],
  ["McDonnell Douglas AV-8B Harrier II", "McDonnell Douglas", [F, V]],
  // Unity pre-tagged this spelling, but it is NOT a client correct answer: in Military Airplane Identifier v1.xlsx it
  // only appears as a wrong option (mil-a4). The sheet's answer is "Boeing F/A-18E/F Super Hornet". Kept (provisional)
  // so a future delivery that uses this spelling needs no code change; Unity should drop or move its line (J2).
  ["Boeing F/A-18 Super Hornet", "Boeing", [F]],
];

/** The seeded commercial Card catalog (U9): the keys a commercial `aircraftKey` must be (`cardKeyFor`). */
export const SEED_COMMERCIAL_CARD_KEYS: ReadonlySet<string> = new Set(COMMERCIAL.map(([family]) => commercialCardKey(family)));

export const SEED_AIRCRAFT_TAG_ENTRIES: readonly AircraftTagEntry[] = [
  ...COMMERCIAL.map(([family, maker, tags]) => entry(commercialCardKey(family), maker, tags)),
  ...MILITARY.map(([answer, maker, tags]) => entry(militaryCardKey(answer), maker, tags)),
];

export function buildTagTable(entries: readonly AircraftTagEntry[]): AircraftTagTable {
  return new Map(entries.map((e) => [e.cardKey, e]));
}

export const SEED_AIRCRAFT_TAG_TABLE: AircraftTagTable = buildTagTable(SEED_AIRCRAFT_TAG_ENTRIES);

export function hasTag(table: AircraftTagTable, cardKey: string, tag: AircraftTag): boolean {
  return table.get(cardKey)?.tags.some((t) => t.tag === tag) ?? false;
}

/** A fighter JET: fighter-attack and not piston (Unity IsFighterJet; Bogey Identified). */
export function isFighterJet(table: AircraftTagTable, cardKey: string): boolean {
  return hasTag(table, cardKey, "fighter-attack") && !hasTag(table, cardKey, "piston");
}
