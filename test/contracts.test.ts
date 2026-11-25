import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderCatalogJson } from "../src/rules/catalog.js";
import { renderDealerJson } from "../src/rules/dealer-fixture.js";
import { renderGridJson } from "../src/rules/grid-fixture.js";
import { RANKS } from "../src/rules/ranks.js";

type CatalogFile = {
  format: string;
  modules: { id: string; unity: string; slug: string; ticket: number }[];
  ranks: { id: string; unity: string; name: string; statusPoints: number }[];
  trip: { flightsPerTrip: number; maxFlightsAtOwnRank: number };
};

const file = new URL("../contracts/catalog.v1.json", import.meta.url);

describe("contracts/catalog.v1.json", () => {
  it("is exactly what renderCatalogJson() produces (byte for byte)", () => {
    const committed = readFileSync(file, "utf8");
    expect(
      committed === renderCatalogJson(),
      "contracts/catalog.v1.json is out of date. Run `npm run contracts:write` and commit the result; never hand-edit it.",
    ).toBe(true);
  });

  it("is stable: 2-space indent, LF, one trailing newline, format tag first", () => {
    const text = renderCatalogJson();
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toContain("\r");
    expect(text.startsWith('{\n  "format": "catalog.v1",\n')).toBe(true);
    expect(renderCatalogJson()).toBe(text);
  });

  describe("invariants", () => {
    const catalog = JSON.parse(renderCatalogJson()) as CatalogFile;

    it("has unique ids, unity names and slugs", () => {
      for (const list of [catalog.modules, catalog.ranks]) {
        expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
        expect(new Set(list.map((x) => x.unity)).size).toBe(list.length);
      }
      expect(new Set(catalog.modules.map((m) => m.slug)).size).toBe(catalog.modules.length);
    });

    it("lists ranks lowest first, thresholds strictly ascending from trainee = 0", () => {
      expect(catalog.ranks.map((r) => r.id)).toEqual([...RANKS]);
      expect(catalog.ranks[0]).toMatchObject({ id: "trainee", statusPoints: 0 });
      for (let i = 1; i < catalog.ranks.length; i += 1) {
        expect(catalog.ranks[i]!.statusPoints).toBeGreaterThan(catalog.ranks[i - 1]!.statusPoints);
      }
    });

    it("lists modules in ticket order, tickets 1..8", () => {
      expect(catalog.modules.map((m) => m.ticket)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("carries the trip constants", () => {
      expect(catalog.trip).toEqual({ flightsPerTrip: 10, maxFlightsAtOwnRank: 6 });
      expect(catalog.format).toBe("catalog.v1");
    });
  });
});

const dealerFile = new URL("../contracts/dealer.v1.json", import.meta.url);

describe("contracts/dealer.v1.json", () => {
  it("is exactly what renderDealerJson() produces (byte for byte)", () => {
    const committed = readFileSync(dealerFile, "utf8");
    expect(
      committed === renderDealerJson(),
      "contracts/dealer.v1.json is out of date. Run `npm run contracts:write` and commit the result; never hand-edit it.",
    ).toBe(true);
  });

  it("is stable: 2-space indent, LF, one trailing newline, format tag first", () => {
    const text = renderDealerJson();
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toContain("\r");
    expect(text.startsWith('{\n  "format": "dealer.v1",\n  "rng": "fnv1a32-utf16+xorshift32",\n')).toBe(true);
    expect(renderDealerJson()).toBe(text);
  });
});

const gridFile = new URL("../contracts/grid.v1.json", import.meta.url);

describe("contracts/grid.v1.json", () => {
  it("is exactly what renderGridJson() produces (byte for byte)", () => {
    const committed = readFileSync(gridFile, "utf8");
    expect(
      committed === renderGridJson(),
      "contracts/grid.v1.json is out of date. Run `npm run contracts:write` and commit the result; never hand-edit it.",
    ).toBe(true);
  });

  it("is stable: 2-space indent, LF, one trailing newline, format tag first", () => {
    const text = renderGridJson();
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toContain("\r");
    expect(text.startsWith('{\n  "format": "grid.v1",\n  "rng": "fnv1a32-utf16+xorshift32",\n')).toBe(true);
    expect(renderGridJson()).toBe(text);
  });

  it("carries the ladder, the policy and a pool that exercises both can-deal and cannot-deal ranks", () => {
    const grid = JSON.parse(renderGridJson()) as {
      flightsPerTrip: number;
      ladder: { rank: string; unity: string; gridSide: number; directions: string[] }[];
      modulePolicy: Record<string, string>;
      pool: { id: string; rank: string }[];
      coverage: { perRank: Record<string, number> };
    };
    expect(grid.flightsPerTrip).toBe(10);
    expect(grid.ladder.map((r) => r.rank)).toEqual([...RANKS]);
    expect(grid.ladder.map((r) => r.unity)).toEqual(["Trainee", "FirstOfficer", "Captain", "CheckAirman", "ChiefPilot"]);
    expect(grid.ladder.map((r) => r.gridSide)).toEqual([6, 7, 8, 8, 8]);
    expect(grid.modulePolicy).toEqual({ "code-search": "grid-draw.v1" });
    expect(grid.pool.every((b) => b.id.startsWith("FIXTURE-"))).toBe(true);
    const counts = RANKS.map((rank) => grid.pool.filter((b) => b.rank === rank).length);
    expect(counts.every((n) => n > 0)).toBe(true);
    expect(counts.some((n) => n >= 10)).toBe(true);
    expect(counts.some((n) => n < 10)).toBe(true);
    expect(grid.coverage.perRank.trainee).toBe(10);
  });

  it("leaves dealer.v1.json without a grid policy", () => {
    expect(JSON.parse(readFileSync(dealerFile, "utf8")).modulePolicy).not.toHaveProperty("code-search");
  });
});
