import { RANKS, RANK_THRESHOLDS, type Rank } from "./ranks.js";
import { MODULE_IDS, type ModuleId } from "./modules.js";
import { FLIGHTS_PER_TRIP } from "./trips.js";

/**
 * The Unity-side names for each Rank and Module. This is a mirror, not an origin: Unity `ModuleRegistry`
 * and `FlightRank` / `FlightRankExtensions.DisplayName` own these values; change both together.
 * `RANKS` and `MODULE_IDS` stay the literal tuples (types, openapi enum order and CHECK text depend on them);
 * these Records are typed over them, so a missing or extra key fails typecheck.
 */

/** `unity` is the FlightRank enum name; `name` is the player-facing title (also the client's sheet "Level" wording). */
export const RANK_CATALOG: Readonly<Record<Rank, { readonly unity: string; readonly name: string }>> = {
  trainee: { unity: "Trainee", name: "Trainee" },
  "first-officer": { unity: "FirstOfficer", name: "First Officer" },
  captain: { unity: "Captain", name: "Captain" },
  "check-airman": { unity: "CheckAirman", name: "Check Airman" },
  "chief-pilot": { unity: "ChiefPilot", name: "Chief Pilot" },
};

/**
 * `unity` is the ModuleId enum name, `slug` the ModuleRegistry public slug, `ticket` the 1-based position in
 * the approved ticket order. The key is the backend id (ModuleRegistry BackendId).
 */
export const MODULE_CATALOG: Readonly<Record<ModuleId, { readonly unity: string; readonly slug: string; readonly ticket: number }>> = {
  identifier: { unity: "AircraftIdentifier", slug: "aircraft-identifier", ticket: 1 },
  "aircraft-identifier-military": { unity: "AircraftIdentifierMilitary", slug: "aircraft-identifier-military", ticket: 2 },
  "tail-identifier": { unity: "TailIdentifier", slug: "tail-identifier", ticket: 3 },
  "airport-spotter": { unity: "AirportSpotter", slug: "airport-spotter", ticket: 4 },
  "atc-match": { unity: "AtcMatch", slug: "atc-match", ticket: 5 },
  "call-sign-match": { unity: "CallSignMatch", slug: "call-sign-match", ticket: 6 },
  "code-search": { unity: "CodeSearch", slug: "code-search", ticket: 7 },
  "runway-identifier": { unity: "RunwayIdentifier", slug: "runway-identifier", ticket: 8 },
};

/** A Trip is this many Flights (re-exported from trips.ts so the catalog has one place to read it). */
export { FLIGHTS_PER_TRIP };

/**
 * The first-pass cap on own-rank Flights in a Trip under the commercial rule (Unity `PickQuestions`: up to 6 at
 * own rank, then lower ranks, then an own-rank top-up when the pool is thin below). Unity's Military
 * dealer has no such cap today (C13/J8); the dealer slice B3 pins that as an ASSUMPTION test.
 */
export const MAX_FLIGHTS_AT_OWN_RANK = 6;

/** The title shown to players for a rank ("Check Airman"). */
export function rankDisplayName(rank: Rank): string {
  return RANK_CATALOG[rank].name;
}

function normaliseDisplay(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The rank a display title means, ignoring case and extra whitespace; undefined when it is none of the five. */
export function rankFromDisplayName(text: string): Rank | undefined {
  const wanted = normaliseDisplay(text);
  return RANKS.find((rank) => normaliseDisplay(RANK_CATALOG[rank].name) === wanted);
}

/** Module ids in Unity ticket order. */
export function modulesInTicketOrder(): readonly ModuleId[] {
  return [...MODULE_IDS].sort((a, b) => MODULE_CATALOG[a].ticket - MODULE_CATALOG[b].ticket);
}

/** The contract format tag. A breaking change (rename, removal, reorder) becomes `catalog.v2`, a new file. */
export const CATALOG_FORMAT = "catalog.v1";

/**
 * The published catalog contract (`contracts/catalog.v1.json`), derived only from `RANKS`, `RANK_THRESHOLDS`,
 * `RANK_CATALOG`, `MODULE_CATALOG` and the trip constants. Ranks go lowest first and modules in Unity ticket
 * order; both orders are load-bearing for consumers. Stable key order, 2-space indent, trailing newline.
 */
export function renderCatalogJson(): string {
  const catalog = {
    format: CATALOG_FORMAT,
    modules: modulesInTicketOrder().map((id) => ({
      id,
      unity: MODULE_CATALOG[id].unity,
      slug: MODULE_CATALOG[id].slug,
      ticket: MODULE_CATALOG[id].ticket,
    })),
    ranks: RANKS.map((id) => ({
      id,
      unity: RANK_CATALOG[id].unity,
      name: RANK_CATALOG[id].name,
      statusPoints: RANK_THRESHOLDS[id],
    })),
    trip: { flightsPerTrip: FLIGHTS_PER_TRIP, maxFlightsAtOwnRank: MAX_FLIGHTS_AT_OWN_RANK },
  };
  return `${JSON.stringify(catalog, null, 2)}
`;
}
