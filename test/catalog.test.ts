import { describe, expect, it } from "vitest";
import {
  FLIGHTS_PER_TRIP,
  MAX_FLIGHTS_AT_OWN_RANK,
  MODULE_CATALOG,
  RANK_CATALOG,
  modulesInTicketOrder,
  rankDisplayName,
  rankFromDisplayName,
} from "../src/rules/catalog.js";
import { MODULE_IDS } from "../src/rules/modules.js";
import { RANKS } from "../src/rules/ranks.js";

describe("catalog mirrors the Unity ModuleRegistry and FlightRank names", () => {
  it("covers every rank and every module, and nothing else", () => {
    expect(Object.keys(RANK_CATALOG).sort()).toEqual([...RANKS].sort());
    expect(Object.keys(MODULE_CATALOG).sort()).toEqual([...MODULE_IDS].sort());
  });

  it("has the Unity enum names", () => {
    expect(RANKS.map((r) => RANK_CATALOG[r].unity)).toEqual(["Trainee", "FirstOfficer", "Captain", "CheckAirman", "ChiefPilot"]);
    expect(modulesInTicketOrder().map((m) => MODULE_CATALOG[m].unity)).toEqual([
      "AircraftIdentifier",
      "AircraftIdentifierMilitary",
      "TailIdentifier",
      "AirportSpotter",
      "AtcMatch",
      "CallSignMatch",
      "CodeSearch",
      "RunwayIdentifier",
    ]);
  });

  it("has unique Unity names, slugs and display names", () => {
    const unique = (values: string[]) => expect(new Set(values).size).toBe(values.length);
    unique(RANKS.map((r) => RANK_CATALOG[r].unity));
    unique(RANKS.map((r) => RANK_CATALOG[r].name));
    unique(MODULE_IDS.map((m) => MODULE_CATALOG[m].unity));
    unique(MODULE_IDS.map((m) => MODULE_CATALOG[m].slug));
  });

  it("has unique tickets running 1..8 in ticket order", () => {
    const tickets = MODULE_IDS.map((m) => MODULE_CATALOG[m].ticket);
    expect(new Set(tickets).size).toBe(tickets.length);
    expect(modulesInTicketOrder().map((m) => MODULE_CATALOG[m].ticket)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(modulesInTicketOrder()[0]).toBe("identifier");
    expect(modulesInTicketOrder()[7]).toBe("runway-identifier");
  });

  it("round-trips rank display names", () => {
    for (const rank of RANKS) expect(rankFromDisplayName(rankDisplayName(rank))).toBe(rank);
    expect(RANKS.map(rankDisplayName)).toEqual(["Trainee", "First Officer", "Captain", "Check Airman", "Chief Pilot"]);
  });

  it("matches display names ignoring case and extra whitespace, as the Military sheet import did", () => {
    expect(rankFromDisplayName("  check   AIRMAN ")).toBe("check-airman");
  });

  it("returns undefined for unknown display text", () => {
    expect(rankFromDisplayName("")).toBeUndefined();
    expect(rankFromDisplayName("Student Pilot")).toBeUndefined();
    expect(rankFromDisplayName("first-officer")).toBeUndefined();
  });

  it("carries the Trip constants", () => {
    expect(FLIGHTS_PER_TRIP).toBe(10);
    expect(MAX_FLIGHTS_AT_OWN_RANK).toBe(6);
  });
});
