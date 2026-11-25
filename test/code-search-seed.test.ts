import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkCodeSearchPack,
  codeSearchSeedRefusal,
  packToSheetRows,
  rankOfUnityName,
  sheetFileName,
} from "../src/content/code-search-seed.js";
import type { CodeSearchPack } from "../src/content/code-search-seed.js";
import { codeSearchMapping } from "../src/content/modules/code-search.js";
import { MAX_UNPACKED_BYTES, MAX_UPLOAD_BYTES, assertSafeToUnpack, readFirstSheet, writeSheet } from "../src/content/xlsx.js";

// The dev Code Search seed's pure parts (docs/plans/code-search.md section 4 and G): refusals, pack checks, pack to sheet.

const sample = JSON.parse(readFileSync(new URL("./fixtures/code-search-sample.json", import.meta.url), "utf8")) as CodeSearchPack;
const REAL_PACK = "C:/Unity/Projects/AviationArcade_v2/Assets/_Project/Resources/ClientContent/Arcade/code_search_master.json";
const haveReal = existsSync(REAL_PACK);
const copy = (): Record<string, unknown> => structuredClone(sample) as unknown as Record<string, unknown>;
const recordsOf = (pack: Record<string, unknown>) => pack["records"] as Record<string, unknown>[];

describe("codeSearchSeedRefusal", () => {
  const local = { appEnv: "local", blobStore: "memory" } as const;
  const refusal = (config: Parameters<typeof codeSearchSeedRefusal>[0], db: string | null | undefined, yes = false) => codeSearchSeedRefusal(config, db, { yes });

  it("allows a dry run on a local or test database, with any blob store", () => {
    for (const blobStore of ["memory", "none", "bunny"] as const) {
      expect(refusal({ appEnv: "local", blobStore }, "airplane_games_test")).toBeNull();
      expect(refusal({ appEnv: "test", blobStore }, "airplane_games_test")).toBeNull();
    }
  });

  it("refuses a missing database name and any _prod name, in every environment", () => {
    expect(refusal(local, null)).toContain("names no database");
    expect(refusal(local, "")).toContain("names no database");
    expect(refusal(local, "airplane_games_prod")).toContain("production database");
    expect(refusal({ appEnv: "production", blobStore: "bunny" }, "airplane_games_prod", true)).toContain("production database");
  });

  it("under APP_ENV=production allows only a _dev database", () => {
    expect(refusal({ appEnv: "production", blobStore: "bunny" }, "airplane_games")).toContain("ends _dev");
    expect(refusal({ appEnv: "production", blobStore: "bunny" }, "airplane_games_dev")).toBeNull();
    expect(refusal({ appEnv: "production", blobStore: "none" }, "airplane_games_dev")).toBeNull(); // a dry run
  });

  it("--yes under production needs BLOB_STORE=bunny", () => {
    expect(refusal({ appEnv: "production", blobStore: "memory" }, "airplane_games_dev", true)).toContain("BLOB_STORE=bunny");
    expect(refusal({ appEnv: "production", blobStore: "bunny" }, "airplane_games_dev", true)).toBeNull();
  });

  it("--yes with BLOB_STORE=none is refused anywhere; memory is fine outside production", () => {
    expect(refusal({ appEnv: "local", blobStore: "none" }, "airplane_games_test", true)).toContain("needs a blob store");
    expect(refusal({ appEnv: "test", blobStore: "none" }, "airplane_games_test", true)).toContain("needs a blob store");
    expect(refusal({ appEnv: "local", blobStore: "memory" }, "airplane_games_test", true)).toBeNull();
    expect(refusal({ appEnv: "local", blobStore: "bunny" }, "airplane_games_test", true)).toBeNull();
  });
});

describe("checkCodeSearchPack", () => {
  it("accepts the sample pack", () => {
    expect(checkCodeSearchPack(sample)).toEqual([]);
  });

  it("refuses what is not an object", () => {
    for (const bad of [null, [], "x", 3]) expect(checkCodeSearchPack(bad)).toEqual(["The pack must be a JSON object."]);
  });

  it("refuses a wrong schemaVersion, moduleId and reviewState", () => {
    expect(checkCodeSearchPack({ ...copy(), schemaVersion: 1 }).join(" ")).toContain("schemaVersion must be 2");
    expect(checkCodeSearchPack({ ...copy(), moduleId: "other" }).join(" ")).toContain("moduleId must be");
    expect(checkCodeSearchPack({ ...copy(), reviewState: "draft" }).join(" ")).toContain("reviewState must be");
  });

  it("refuses a bad sourceSha256 and blank packId / contentVersion", () => {
    for (const sha of ["", "abc", "g".repeat(64), "A".repeat(64), 5]) expect(checkCodeSearchPack({ ...copy(), sourceSha256: sha }).join(" "), String(sha)).toContain("sourceSha256");
    expect(checkCodeSearchPack({ ...copy(), packId: " " }).join(" ")).toContain("packId must be");
    expect(checkCodeSearchPack({ ...copy(), contentVersion: 3 }).join(" ")).toContain("contentVersion must be");
  });

  it("refuses a rank table that differs from the ladder", () => {
    const pack = copy();
    (pack["ranks"] as Record<string, unknown>[])[0]!["gridSide"] = 9;
    expect(checkCodeSearchPack(pack).join(" ")).toContain("rules differ from the ladder");
    expect(checkCodeSearchPack({ ...copy(), ranks: [] }).join(" ")).toContain("misses a rank");
  });

  it("refuses records that are not a list", () => {
    expect(checkCodeSearchPack({ ...copy(), records: {} })).toContain("records must be a list.");
  });

  it("refuses a repeated id, an unknown key and a non-object record", () => {
    const pack = copy();
    const records = recordsOf(pack);
    records.push({ ...(records[0] as Record<string, unknown>) });
    expect(checkCodeSearchPack(pack).join(" ")).toContain(`${String(records[0]?.["id"])} is listed twice.`);
    const extra = copy();
    recordsOf(extra)[0]!["note"] = "x";
    expect(checkCodeSearchPack(extra).join(" ")).toContain("unknown key 'note'");
    expect(checkCodeSearchPack({ ...copy(), records: [5] }).join(" ")).toContain("must be an object");
  });

  it("refuses a rank that is not a Unity enum name (display names and rank ids included)", () => {
    for (const rank of ["First Officer", "first-officer", "Pilot", 3]) {
      const pack = copy();
      recordsOf(pack)[0]!["rank"] = rank;
      expect(checkCodeSearchPack(pack).join(" "), String(rank)).toContain("unknown rank");
    }
  });

  it("refuses a record whose board fails the rules or its rung", () => {
    const lower = copy();
    const first = recordsOf(lower)[0]!;
    first["letters"] = String(first["letters"]).toLowerCase();
    expect(checkCodeSearchPack(lower).join(" ")).toContain("upper case");
    const prefix = copy();
    const own = recordsOf(prefix)[0]!;
    own["rank"] = own["rank"] === "Trainee" ? "Captain" : "Trainee"; // a board named for another rung
    expect(checkCodeSearchPack(prefix).join(" ")).toContain("does not match its rank");
    const fixture = copy();
    recordsOf(fixture)[0]!["id"] = "FIXTURE-TR-0001";
    expect(checkCodeSearchPack(fixture).join(" ")).toContain("must look like CS-TR-0001");
  });

  it("names the record in every record problem", () => {
    const pack = copy();
    recordsOf(pack)[0]!["letters"] = "ABC";
    const id = String(recordsOf(pack)[0]?.["id"]);
    const problems = checkCodeSearchPack(pack);
    expect(problems.length).toBeGreaterThan(0);
    for (const p of problems) expect(p.startsWith(id)).toBe(true);
  });
});

describe("pack to sheet", () => {
  it("rankOfUnityName maps the five Unity names and nothing else", () => {
    expect(["Trainee", "FirstOfficer", "Captain", "CheckAirman", "ChiefPilot"].map(rankOfUnityName)).toEqual(["trainee", "first-officer", "captain", "check-airman", "chief-pilot"]);
    expect(rankOfUnityName("First Officer")).toBeUndefined();
    expect(rankOfUnityName(undefined)).toBeUndefined();
  });

  it("the sheet has the client header and one row per record with display-name levels", () => {
    const rows = packToSheetRows(sample);
    expect(rows[0]).toEqual(["Game ID", "Level", "Letters", "Targets"]);
    expect(rows).toHaveLength(61);
    const levels = new Set(rows.slice(1).map((r) => r[1]));
    expect(levels).toEqual(new Set(["Trainee", "First Officer", "Captain", "Check Airman", "Chief Pilot"]));
    expect(rows[1]?.[0]).toBe(sample.records[0]?.id);
    expect(rows[1]?.[3]).toBe(JSON.stringify(sample.records[0]?.targets));
  });

  it("the generated sheet parses back to exactly the pack's boards", async () => {
    const parsed = codeSearchMapping.parse(await readFirstSheet(await writeSheet(packToSheetRows(sample))));
    expect(parsed.kind).toBe("client_sheet");
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows.map((r) => r.naturalKey)).toEqual(sample.records.map((r) => r.id));
    expect(parsed.rows.map((r) => r.data)).toEqual(sample.records.map((r) => ({ letters: r.letters, targets: r.targets })));
  });

  it("the file name carries the content version and the first 12 hex of the source digest", () => {
    expect(sheetFileName({ contentVersion: "2026-11-17-revised", sourceSha256: "7b727c43f66333747546488adc818692946c79e6db2c69f4e19aac6535bd0c4c" })).toBe("code-search-2026-11-17-revised-7b727c43f663.xlsx");
    expect(sheetFileName({ contentVersion: "a b/c", sourceSha256: "0".repeat(64) })).toBe(`code-search-a_b_c-${"0".repeat(12)}.xlsx`);
  });
});

describe.skipIf(!haveReal)("the real master pack", () => {
  const real = haveReal ? (JSON.parse(readFileSync(REAL_PACK, "utf8")) as CodeSearchPack) : undefined;

  it("passes the pack checks with 3,740 boards", () => {
    expect(checkCodeSearchPack(real)).toEqual([]);
    expect(real?.records).toHaveLength(3740);
  });

  it("the generated import sheet and an export of every board stay under the upload and unpacked limits", async () => {
    const pack = real as CodeSearchPack;
    const sheet = await writeSheet(packToSheetRows(pack));
    expect(sheet.length).toBeLessThan(MAX_UPLOAD_BYTES);
    expect(() => assertSafeToUnpack(sheet)).not.toThrow();
    const items = pack.records.map((r, i) => ({
      id: r.id,
      rank: rankOfUnityName(r.rank) ?? "trainee",
      status: "approved" as const,
      version: i + 1,
      data: { letters: r.letters, targets: r.targets },
    }));
    const exportRows = codeSearchMapping.exportRows(items).map((line, i) => [...line, i === 0 ? "Media Id" : ""]);
    const exported = await writeSheet(exportRows);
    expect(exported.length).toBeLessThan(MAX_UPLOAD_BYTES);
    expect(() => assertSafeToUnpack(exported)).not.toThrow();
    expect(MAX_UNPACKED_BYTES).toBeGreaterThan(exported.length);
    const back = codeSearchMapping.parse(await readFirstSheet(exported));
    expect(back.issues).toEqual([]);
    expect(back.rows).toHaveLength(3740);
  });
});
