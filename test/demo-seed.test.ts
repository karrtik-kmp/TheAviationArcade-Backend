import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanCredit, exitCodeOf, photoSourceId, potdEntryData, resolveSeedPrincipal, seedRefusal } from "../src/content/demo-seed.js";
import type { SeedConfig, SeedReport } from "../src/content/demo-seed.js";
import { instagramHandle, matchPhoto, parsePlaneOfTheDay, potdCredit } from "../src/content/demo-seed-sources.js";
import { readFirstSheet } from "../src/content/xlsx.js";
import { xlsx } from "./fixtures.js";
import type { TestCell } from "./fixtures.js";

// The dev demo seed's pure parts (docs/plans/demo-seed.md S4 and G): the refusals before connecting, the Plane of the Day sheet
// reader and the photo matching. The database side is test/demo-seed.e2e.test.ts.

const PROJECT = "airplane-games-9fe1e";
const DEMO_UID = "demo-account-uid";
const config = (over: Partial<SeedConfig> = {}): SeedConfig => ({
  firebaseProjectId: PROJECT,
  appEnv: "local",
  blobStore: "bunny",
  demoPrincipal: `firebase:${PROJECT}:${DEMO_UID}`,
  ...over,
});
const args = (over: Partial<{ owner: string; photographers: string[]; yes: boolean }> = {}) => ({ owner: "owner-uid", photographers: [], yes: false, ...over });

describe("seedRefusal", () => {
  it("accepts a local dry run, a --yes run on Bunny, and production against a _dev database", () => {
    expect(seedRefusal(config(), "airplane_games_dev", args())).toBeNull();
    expect(seedRefusal(config(), "airplane_games_seed_test", args({ yes: true, photographers: ["p1", `firebase:${PROJECT}:p2`] }))).toBeNull();
    expect(seedRefusal(config({ appEnv: "production" }), "airplane_games_dev", args({ yes: true }))).toBeNull();
  });

  it("refuses a demo- project, even in a test environment", () => {
    expect(seedRefusal(config({ firebaseProjectId: "demo-airplane-games" }), "airplane_games_dev", args())).toMatch(/demo- project/);
    expect(seedRefusal(config({ firebaseProjectId: "demo-airplane-games", appEnv: "test" }), "airplane_games_dev", args())).toMatch(/demo- project/);
  });

  it("refuses a missing database name", () => {
    expect(seedRefusal(config(), undefined, args())).toMatch(/names no database/);
    expect(seedRefusal(config(), "", args())).toMatch(/names no database/);
    expect(seedRefusal(config(), null, args())).toMatch(/names no database/); // postgres://u:p@host:5433/ parses to null
  });

  it("refuses a name ending _prod under every APP_ENV", () => {
    for (const appEnv of ["local", "test", "production"] as const) {
      expect(seedRefusal(config({ appEnv }), "airplane_games_prod", args()), appEnv).toMatch(/_prod/);
    }
  });

  it("under production allows only a name ending _dev", () => {
    expect(seedRefusal(config({ appEnv: "production" }), "airplane_games_prod", args({ yes: true }))).toMatch(/_prod/);
    expect(seedRefusal(config({ appEnv: "production" }), "airplane_games", args())).toMatch(/ends _dev/);
    expect(seedRefusal(config({ appEnv: "production" }), "airplane_games_test", args())).toMatch(/ends _dev/);
    expect(seedRefusal(config({ appEnv: "production" }), "airplane_games_dev", args())).toBeNull();
  });

  it("refuses --yes without Bunny, and without DEMO_ACCOUNT_UID; a dry run needs neither", () => {
    for (const blobStore of ["memory", "none"] as const) {
      expect(seedRefusal(config({ blobStore }), "airplane_games_dev", args({ yes: true }))).toMatch(/BLOB_STORE=bunny/);
      expect(seedRefusal(config({ blobStore }), "airplane_games_dev", args())).toBeNull();
    }
    expect(seedRefusal(config({ demoPrincipal: undefined }), "airplane_games_dev", args({ yes: true }))).toMatch(/DEMO_ACCOUNT_UID/);
    expect(seedRefusal(config({ demoPrincipal: undefined }), "airplane_games_dev", args())).toBeNull();
  });

  it("refuses an owner or photographer that is not a valid uid, is another project's principal, or is the demo account", () => {
    const run = (over: Parameters<typeof args>[0]) => seedRefusal(config(), "airplane_games_dev", args(over));
    expect(run({ owner: "" })).toMatch(/--owner/);
    expect(run({ owner: "has:colon" })).toMatch(/--owner .*not a valid Firebase uid/);
    expect(run({ owner: "a/b" })).toMatch(/--owner/);
    expect(run({ owner: "x".repeat(129) })).toMatch(/--owner/);
    expect(run({ owner: "firebase:airplane-games-auth-20261022:someone" })).toMatch(/--owner .*another project/);
    expect(run({ owner: "firebase:demo-airplane-games:someone" })).toMatch(/--owner .*another project/);
    expect(run({ owner: DEMO_UID })).toMatch(/--owner .*demo account/);
    expect(run({ owner: `firebase:${PROJECT}:${DEMO_UID}` })).toMatch(/--owner .*demo account/);
    expect(run({ photographers: ["good", DEMO_UID] })).toMatch(/--photographer .*demo account/);
    expect(run({ photographers: ["good", "firebase:other-project:uid"] })).toMatch(/--photographer .*another project/);
    expect(run({ photographers: ["bad:uid"] })).toMatch(/--photographer/);
  });
});

describe("resolveSeedPrincipal", () => {
  it("binds a bare uid to the configured project and accepts that project's full principal", () => {
    expect(resolveSeedPrincipal(config(), "uid1")).toEqual({ ok: true, principal: `firebase:${PROJECT}:uid1` });
    expect(resolveSeedPrincipal(config(), `firebase:${PROJECT}:uid2`)).toEqual({ ok: true, principal: `firebase:${PROJECT}:uid2` });
  });
  it("does not check the demo account when DEMO_ACCOUNT_UID is unset (a dry run)", () => {
    expect(resolveSeedPrincipal(config({ demoPrincipal: undefined }), DEMO_UID).ok).toBe(true);
  });
});

describe("exitCodeOf", () => {
  const report = (over: Partial<SeedReport["counts"]>): SeedReport => ({
    mode: "apply",
    lines: [],
    counts: { done: 0, would: 0, unchanged: 0, waiting: 0, note: 0, refused: 0, failed: 0, ...over },
  });
  it("is 0, 3, 4 or 1 like media:import", () => {
    expect(exitCodeOf(report({ done: 3, unchanged: 2, waiting: 5, note: 9, would: 1 }))).toBe(0);
    expect(exitCodeOf(report({ refused: 1 }))).toBe(3);
    expect(exitCodeOf(report({ refused: 1, done: 1 }))).toBe(4);
    expect(exitCodeOf(report({ failed: 1 }))).toBe(1);
    expect(exitCodeOf(report({ failed: 1, refused: 1 }))).toBe(1);
    expect(exitCodeOf(report({ failed: 1, done: 1 }))).toBe(4);
  });
});

describe("photo matching", () => {
  const files = ["MA_A_10_10_23_26_1.jpg", "MA_f22_10_23_26_1.jpg", "MA_Typhoon_102326_2.jpg", "MA_typhoon_102426_1.jpg", "MA_Hawker_102426_1.jpg", "dup.jpg", "dup.png"];

  it("matches the exact name first", () => {
    expect(matchPhoto("MA_A_10_10_23_26_1.jpg", files)).toEqual({ kind: "exact", file: "MA_A_10_10_23_26_1.jpg" });
  });

  it("matches ignoring letter case, reporting it as not exact", () => {
    expect(matchPhoto("ma_typhoon_102326_2.JPG", files)).toEqual({ kind: "case_insensitive", file: "MA_Typhoon_102326_2.jpg" });
  });

  it("matches a name with no extension to the one file with the same stem and an image extension", () => {
    expect(matchPhoto("MA_f22_10_23_26_1", files)).toEqual({ kind: "extension", file: "MA_f22_10_23_26_1.jpg" });
    expect(matchPhoto("MA_F22_10_23_26_1", files)).toEqual({ kind: "extension", file: "MA_f22_10_23_26_1.jpg" });
  });

  it("matches a mistyped extension (.jpog) the same way", () => {
    expect(matchPhoto("MA_Hawker_102426_1.jpog", files)).toEqual({ kind: "extension", file: "MA_Hawker_102426_1.jpg" });
  });

  it("is ambiguous, not chosen, when two files fit", () => {
    expect(matchPhoto("dup", files)).toEqual({ kind: "ambiguous", files: ["dup.jpg", "dup.png"] });
    expect(matchPhoto("DUP.jpg", ["dup.jpg", "DUP.JPG"])).toMatchObject({ kind: "ambiguous" });
  });

  it("does not swap one image extension for another, and finds nothing for an empty or unknown name", () => {
    expect(matchPhoto("MA_f22_10_23_26_1.png", files)).toEqual({ kind: "none" });
    expect(matchPhoto("", files)).toEqual({ kind: "none" });
    expect(matchPhoto("MA_globemaster_102326_1.jpg", files)).toEqual({ kind: "none" });
  });

  it("ignores non-image files for the stem rule", () => {
    expect(matchPhoto("notes", ["notes.txt"])).toEqual({ kind: "none" });
  });
});

const POTD_HEADER = ["Image #", "H/V", "resolution", "Photographer", "Instagram", "Title", "Manufacturer", "Model", "Description"];
const potdRows = (rows: TestCell[][], header: TestCell[] = POTD_HEADER): TestCell[][] => [[null], [null], [null], header, ...rows];
const parsePotd = async (rows: TestCell[][]) => parsePlaneOfTheDay(await readFirstSheet(await xlsx(rows)));

describe("Plane of the Day sheet reader", () => {
  it("reads numbers as written (737, not 737.0) and joins Manufacturer and Model with one space", async () => {
    const parsed = await parsePotd(
      potdRows([
        ["pod-4", "Horizonal", "2000x2500", "Josh M", "https://www.instagram.com/iamjoshmark/", "Beneath the Heartbeat", "Boeing", 737, "A description."],
        ["pod-5", null, null, "Josh M", "https://www.instagram.com/iamjoshmark/", "Golden Superjumbo", "Airbus", "A380", "Another."],
        ["pod-7", null, null, "Josh M", null, "Scimitar", "  Boeing ", " 737-900ER ", "Third."],
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.map((e) => [e.image, e.aircraft, e.row])).toEqual([
      ["pod-4", "Boeing 737", 5],
      ["pod-5", "Airbus A380", 6],
      ["pod-7", "Boeing 737-900ER", 7],
    ]);
    expect(parsed.entries[0]).toMatchObject({ title: "Beneath the Heartbeat", photographer: "Josh M", handle: "iamjoshmark", instagram: "https://www.instagram.com/iamjoshmark/", description: "A description." });
    expect(parsed.issues).toEqual([]);
  });

  it("uses only the non-empty parts of Manufacturer and Model, and leaves factual data out", async () => {
    const parsed = await parsePotd(potdRows([["pod-1", null, null, "A", null, "T", null, "Model only", "D"], ["pod-2", null, null, "A", null, "T", "Maker only", null, "D"], ["pod-3", null, null, "A", null, "T", null, null, "D"]]));
    expect(parsed.ok && parsed.entries.map((e) => e.aircraft)).toEqual(["Model only", "Maker only", ""]);
    expect(parsed.ok && Object.keys(parsed.entries[0] ?? {}).sort()).toEqual(["aircraft", "description", "handle", "image", "instagram", "photographer", "row", "title"]);
  });

  it("finds the header in the first 10 rows, skips rows without an Image #, and keeps the first of a repeated one", async () => {
    const parsed = await parsePotd(
      potdRows([
        ["pod-1", null, null, "A", null, "T1", "M", "1", "D1"],
        [null, null, null, "ignored", null, "no image", null, null, null],
        ["POD-1", null, null, "B", null, "T-again", "M", "2", "D2"],
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.title).toBe("T1");
    expect(parsed.issues).toEqual([{ row: 7, message: expect.stringContaining("appears again") }]);
  });

  it("refuses a sheet with no Image # header or a missing column, naming it", async () => {
    expect((await parsePotd([[null], ["Photographer", "Title"], ["x", "y"]])).ok).toBe(false);
    const missing = await parsePotd(potdRows([["pod-1", "x"]], ["Image #", "Title"]));
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('"manufacturer"') });
  });

  it("leaves a bad Instagram cell empty and reports it", async () => {
    const parsed = await parsePotd(potdRows([["pod-1", null, null, "A", "not a link", "T", "M", "1", "D"]]));
    expect(parsed.ok && parsed.entries[0]?.instagram).toBe("");
    expect(parsed.ok && parsed.issues[0]?.message).toContain("not a handle");
  });

  it("reads the client's real sheet: five entries pod-4 to pod-8 with Boeing 737 first", async () => {
    const real = "C:/Unity/Projects/AviationArcade_v2/docs/client-content/2026-09-28/Airplane Games - Game Play.xlsx";
    if (!existsSync(real)) return;
    const parsed = parsePlaneOfTheDay(await readFirstSheet(readFileSync(real)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.map((e) => e.image)).toEqual(["pod-4", "pod-5", "pod-6", "pod-7", "pod-8"]);
    expect(parsed.entries.map((e) => e.aircraft)).toEqual(["Boeing 737", "Airbus A380", "Boeing 757", "Boeing 737-900ER", "Boeing 747-8F"]);
    expect(parsed.entries.every((e) => e.photographer === "Josh M" && e.handle === "iamjoshmark")).toBe(true);
  });
});

describe("Instagram handle and credit", () => {
  it("reads a handle from @name or an instagram.com link", () => {
    expect(instagramHandle("@iamjoshmark")).toBe("iamjoshmark");
    expect(instagramHandle("https://www.instagram.com/iamjoshmark/")).toBe("iamjoshmark");
    expect(instagramHandle("https://instagram.com/some.name_1?hl=en")).toBe("some.name_1");
    expect(instagramHandle("https://example.com/iamjoshmark")).toBe("");
    expect(instagramHandle("http://www.instagram.com/x")).toBe("");
    expect(instagramHandle("")).toBe("");
  });

  it("builds the credit from the photographer and the handle", () => {
    expect(potdCredit({ photographer: "Josh M", handle: "iamjoshmark" })).toBe("Josh M (@iamjoshmark)");
    expect(potdCredit({ photographer: "Josh M", handle: "" })).toBe("Josh M");
    expect(potdCredit({ photographer: "", handle: "iamjoshmark" })).toBe("");
  });

  it("puts the @handle, the URL, the photographer and the aircraft in the editorial data, and nothing else", () => {
    const data = potdEntryData({ row: 5, image: "pod-4", title: "Beneath", aircraft: "Boeing 737", photographer: "Josh M", instagram: "https://www.instagram.com/iamjoshmark/", handle: "iamjoshmark", description: "Text." });
    expect(data).toEqual({
      title: "Beneath",
      aircraft: "Boeing 737",
      photographer: "Josh M",
      instagram: "https://www.instagram.com/iamjoshmark/",
      credit: "@iamjoshmark",
      description: "Text.",
      correctAnswer: "",
      distractors: ["", "", ""],
      difficulty: "",
      factualSource: "",
    });
  });
});

describe("source ids and credits", () => {
  it("makes <kind>/<file name> and refuses one over 128 characters", () => {
    expect(photoSourceId("mil", "MA_x.jpg")).toBe("mil/MA_x.jpg");
    expect(photoSourceId("potd", "pod-4.jpg")).toBe("potd/pod-4.jpg");
    expect(photoSourceId("ai", `${"x".repeat(124)}.jpg`)).toBeNull();
    expect(photoSourceId("ai", `${"x".repeat(120)}.jpg`)).not.toBeNull();
  });

  it("treats an empty credit as none and refuses control characters and over-long ones", () => {
    expect(cleanCredit(undefined)).toEqual({ ok: true, value: null });
    expect(cleanCredit("   ")).toEqual({ ok: true, value: null });
    expect(cleanCredit("  Josh M (@iamjoshmark) ")).toEqual({ ok: true, value: "Josh M (@iamjoshmark)" });
    expect(cleanCredit("a\nb").ok).toBe(false);
    expect(cleanCredit("x".repeat(201)).ok).toBe(false);
    expect(cleanCredit("x".repeat(200)).ok).toBe(true);
  });
});
