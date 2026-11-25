import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.module.js";
import type { AppConfig } from "../src/config/config.module.js";
import { checkCodeSearchPack, exitCodeOf, loadCodeSearchPack, runCodeSearchSeed } from "../src/content/code-search-seed.js";
import type { CodeSearchPack, SeedReport } from "../src/content/code-search-seed.js";
import { ContentItemEditService } from "../src/content/content-item-edit.service.js";
import { ContentService } from "../src/content/content.service.js";
import { acquireRunLock } from "../src/content/demo-seed.js";
import { ContentDocumentsService } from "../src/content/documents/content-documents.service.js";
import { codeSearchMapping } from "../src/content/modules/code-search.js";
import { DatabaseService } from "../src/database/database.module.js";
import { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { UnavailableBlobStore } from "../src/storage/unavailable-blob-store.js";
import { frozenDelete } from "./frozen-cleanup.js";

// The dev Code Search seed core, in-process against the test database with a memory blob store (nothing reaches Bunny): the sample
// pack (60 boards copied from the client's master pack) and, when present, the full pack of 3,740.

const REAL_PACK = "C:/Unity/Projects/AviationArcade_v2/Assets/_Project/Resources/ClientContent/Arcade/code_search_master.json";
const haveReal = existsSync(REAL_PACK);
const sample = JSON.parse(readFileSync(new URL("./fixtures/code-search-sample.json", import.meta.url), "utf8")) as CodeSearchPack;

let sql: pg.Pool;
let database: DatabaseService;
let config: AppConfig;
let blobs: MemoryBlobStore;

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  database = new DatabaseService(sql);
  config = loadConfig({ ...process.env, APP_ENV: "test", BLOB_STORE: "memory" });
});

afterAll(async () => {
  await clean();
  await sql.end();
});

async function clean(): Promise<void> {
  await sql.query("DELETE FROM content_items WHERE module = 'code-search'");
  await sql.query("DELETE FROM content_imports WHERE module = 'code-search'");
  await frozenDelete(sql, "admin_audit");
}

beforeEach(async () => {
  await clean();
  blobs = new MemoryBlobStore();
});

const count = async (table: string, where = "") => (await sql.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} ${where}`)).rows[0]!.n;
const written = async () => ({
  items: await count("content_items", "WHERE module = 'code-search'"),
  imports: await count("content_imports", "WHERE module = 'code-search'"),
  audit: await count("admin_audit"),
});
const run = (pack: CodeSearchPack, mode: "dry-run" | "apply", store: MemoryBlobStore | UnavailableBlobStore = blobs) =>
  runCodeSearchSeed(pack, mode, { database, blobs: store, operator: "tester", pool: sql });
const statusLine = (report: SeedReport, status: string) => report.lines.find((l) => l.subject === "code-search" && l.status === status);
const pack = (records: CodeSearchPack["records"]): CodeSearchPack => ({ ...sample, records });

describe("seed core on the sample pack", () => {
  it("a dry run reports 60 creates and writes nothing (no row, receipt, audit row or blob)", async () => {
    const before = await written();
    const report = await run(sample, "dry-run", new UnavailableBlobStore());
    expect(statusLine(report, "would")?.detail).toContain("would create 60 boards");
    expect(report.lines.filter((l) => l.subject.startsWith("code-search ") && l.status === "note").map((l) => l.detail)).toEqual(Array(5).fill("12 to create, 0 already stored"));
    expect(exitCodeOf(report)).toBe(0);
    expect(await written()).toEqual(before);
  });

  it("apply creates 60 boards and one receipt named after the pack; the second apply writes nothing", async () => {
    const first = await run(sample, "apply");
    expect(exitCodeOf(first)).toBe(0);
    expect(statusLine(first, "done")?.detail).toContain("created 60 boards");
    const after = await written();
    expect(after.items).toBe(60);
    expect(after.imports).toBe(1);
    expect(after.audit).toBeGreaterThan(0);
    const receipt = (await sql.query("SELECT file_name, created, updated, retired FROM content_imports WHERE module = 'code-search'")).rows[0];
    expect(receipt.file_name).toBe(`code-search-${sample.contentVersion}-${sample.sourceSha256.slice(0, 12)}.xlsx`);
    expect([receipt.created, receipt.updated, receipt.retired]).toEqual([60, 0, 0]);
    const ranks = (await sql.query("SELECT rank, COUNT(*)::int AS n FROM content_items WHERE module = 'code-search' GROUP BY rank ORDER BY rank")).rows;
    expect(ranks.map((r) => r.n)).toEqual([12, 12, 12, 12, 12]);
    expect(blobs.size).toBe(1);

    const second = await run(sample, "apply");
    expect(exitCodeOf(second)).toBe(0);
    // Equal bytes within one second replay; the zip is stamped with the time, so either answer is "unchanged".
    expect(statusLine(second, "unchanged")).toBeDefined();
    expect(statusLine(second, "done")).toBeUndefined();
    expect(await written()).toEqual(after);
    expect(blobs.size).toBe(1);

    // The same boards in another order are different bytes (never a replay): planned, all unchanged, no receipt, no audit row.
    const reordered = await run(pack([...sample.records].reverse()), "apply");
    expect(exitCodeOf(reordered)).toBe(0);
    expect(statusLine(reordered, "unchanged")?.detail).toContain("60 boards already stored");
    expect(statusLine(reordered, "done")).toBeUndefined();
    expect(await written()).toEqual(after);
    expect(blobs.size).toBe(1);

    const dry = await run(sample, "dry-run", new UnavailableBlobStore());
    expect(statusLine(dry, "unchanged")).toBeDefined();
    expect(await written()).toEqual(after);
  });

  it("a partly stored module: the dry run counts only the missing boards, apply creates just those", async () => {
    await run(pack(sample.records.slice(0, 20)), "apply");
    // 20 stored; the full pack lists them again (unchanged) and adds 40.
    const dry = await run(sample, "dry-run", new UnavailableBlobStore());
    expect(statusLine(dry, "would")?.detail).toContain("would create 40 boards (20 already stored)");
    const applied = await run(sample, "apply");
    expect(statusLine(applied, "done")?.detail).toContain("created 40 boards, unchanged 20");
    expect((await written()).items).toBe(60);
  });

  it("a staff edit of a stored board makes the next run refuse (an update), exit 3, overwriting nothing", async () => {
    await run(sample, "apply");
    const target = sample.records[0]!;
    const edits = new ContentItemEditService(database, config);
    const changed = target.targets.map((t, i) => (i === 0 ? { ...(t as Record<string, unknown>), clue: `${String((t as Record<string, unknown>)["clue"])} X` } : t));
    await edits.edit(codeSearchMapping, target.id, 1, { data: { letters: target.letters, targets: changed } }, "staff");
    const before = await written();
    for (const mode of ["dry-run", "apply"] as const) {
      const report = await run(sample, mode, mode === "apply" ? blobs : new UnavailableBlobStore());
      const refused = statusLine(report, "refused");
      expect(refused?.detail, mode).toContain("1 to update, 0 to retire");
      expect(refused?.detail).toContain(`${target.id} (`);
      expect(exitCodeOf(report)).toBe(3);
    }
    expect(await written()).toEqual(before);
    expect((await sql.query("SELECT version FROM content_items WHERE module = 'code-search' AND id = $1", [target.id])).rows[0].version).toBe(2);
  });

  it("a staff retire makes the next run refuse (the board would come back: an update)", async () => {
    await run(sample, "apply");
    const target = sample.records[3]!;
    await new ContentItemEditService(database, config).setStatus("code-search", target.id, 1, "retired", "staff");
    const report = await run(sample, "apply");
    expect(statusLine(report, "refused")?.detail).toContain("1 to update");
    expect(exitCodeOf(report)).toBe(3);
  });

  it("a pack that no longer lists a stored board would retire it: refused with the count", async () => {
    await run(sample, "apply");
    const before = await written();
    const report = await run(pack(sample.records.slice(1)), "apply");
    expect(statusLine(report, "refused")?.detail).toContain("0 to update, 1 to retire");
    expect(exitCodeOf(report)).toBe(3);
    expect(await written()).toEqual(before);
  });

  it("apply refuses to start while another run holds the lock", async () => {
    const lock = await acquireRunLock(sql);
    expect(lock).toBeDefined();
    try {
      const report = await run(sample, "apply");
      expect(report.lines[0]?.status).toBe("refused");
      expect(report.lines[0]?.subject).toBe("run lock");
      expect((await written()).items).toBe(0);
    } finally {
      await lock?.release();
    }
  });

  it("an apply with the dry-run store is not possible: the blob put fails the run, nothing is stored", async () => {
    const report = await run(sample, "apply", new UnavailableBlobStore());
    expect(statusLine(report, "failed") ?? statusLine(report, "refused")).toBeDefined();
    expect(exitCodeOf(report)).not.toBe(0);
    expect((await written()).items).toBe(0);
  });
});

describe.skipIf(!haveReal)("seed core on the real master pack", () => {
  it("loads and checks the file, and a dry run on an empty module says would create 3740 boards with the per-rank counts", async () => {
    const loaded = await loadCodeSearchPack(REAL_PACK);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(checkCodeSearchPack(loaded.pack)).toEqual([]);
    const before = await written();
    const report = await run(loaded.pack, "dry-run", new UnavailableBlobStore());
    expect(statusLine(report, "would")?.detail).toContain("would create 3740 boards");
    expect(report.lines.filter((l) => l.subject.startsWith("code-search ") && l.status === "note").map((l) => l.detail)).toEqual([
      "748 to create, 0 already stored",
      "742 to create, 0 already stored",
      "750 to create, 0 already stored",
      "750 to create, 0 already stored",
      "750 to create, 0 already stored",
    ]);
    expect(await written()).toEqual(before);
  });

  it("apply stores all 3,740, a second apply is unchanged, and coverage is 10 at every rank", async () => {
    const loaded = await loadCodeSearchPack(REAL_PACK);
    if (!loaded.ok) throw new Error(loaded.errors.join("; "));
    const first = await run(loaded.pack, "apply");
    expect(statusLine(first, "done")?.detail).toContain("created 3740 boards");
    const after = await written();
    expect(after.items).toBe(3740);
    const second = await run(loaded.pack, "apply");
    expect(statusLine(second, "unchanged")).toBeDefined();
    expect(await written()).toEqual(after);
    const content = new ContentService(database, blobs, new ContentDocumentsService(database));
    const coverage = await content.tripCoverage("code-search");
    expect(coverage.policy).toBe("grid-draw.v1");
    expect(coverage.ranks.map((r) => r.dealable)).toEqual([10, 10, 10, 10, 10]);
  }, 120_000);
});
