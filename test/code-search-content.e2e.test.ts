import { readFileSync } from "node:fs";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { packToSheetRows } from "../src/content/code-search-seed.js";
import type { CodeSearchPack } from "../src/content/code-search-seed.js";
import { XLSX_MIME, writeSheet } from "../src/content/xlsx.js";
import { BLOB_STORE } from "../src/storage/blob-store.js";
import type { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { seedAdmins } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";

// Code Search content over HTTP (docs/plans/code-search.md section 2 and G): import, items, edit, export and trip coverage, on the
// 60-board sample copied from the client's master pack.

const MODULE = "code-search";
const BASE = `/v1/admin/content/${MODULE}`;
const staff = { Authorization: `Bearer ${emulatorToken("staff")}` };
const sample = JSON.parse(readFileSync(new URL("./fixtures/code-search-sample.json", import.meta.url), "utf8")) as CodeSearchPack;
const RANK_IDS = ["trainee", "first-officer", "captain", "check-airman", "chief-pilot"];

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;
let blobs: MemoryBlobStore;
let sheet: Buffer;

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await seedAdmins(sql, "staff");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  blobs = app.get<MemoryBlobStore>(BLOB_STORE);
  sheet = await writeSheet(packToSheetRows(sample));
});

afterAll(async () => {
  await sql.query("DELETE FROM content_items WHERE module = 'code-search'");
  await sql.query("DELETE FROM content_imports WHERE module = 'code-search'");
  await app.close();
  await sql.end();
});

beforeEach(async () => {
  await sql.query("DELETE FROM content_items WHERE module = 'code-search'");
  await sql.query("DELETE FROM content_imports WHERE module = 'code-search'");
  await frozenDelete(sql, "admin_audit");
  blobs.clear();
});

const upload = (bytes: Buffer, query = "") => request(server).post(`${BASE}/imports${query}`).set(staff).set("Content-Type", XLSX_MIME).send(bytes);
type Item = { id: string; version: number; rank: string; status: string; data: { letters: string; targets: Record<string, unknown>[] } };
const items = async () => (await request(server).get(`${BASE}/items`).set(staff)).body.items as Item[];
const coverage = (body: unknown = {}) => request(server).post(`${BASE}/trip-coverage`).set(staff).send(body as object);
const patch = (id: string, body: unknown) => request(server).patch(`${BASE}/items/${id}`).set(staff).send(body as object);
const byRank = (rank: string) => sample.records.filter((r) => r.rank === rank);
const TRAINEE_IDS = byRank("Trainee").map((r) => r.id);

async function importSample(): Promise<void> {
  const res = await upload(sheet);
  expect(res.status).toBe(201);
  expect(res.body.import.created).toBe(60);
}

describe("Code Search import", () => {
  it("dry run plans 60 creates and writes nothing; apply stores them approved at the right ranks", async () => {
    const dry = await upload(sheet, "?dryRun=true");
    expect(dry.status).toBe(200);
    expect(dry.body.kind).toBe("client_sheet");
    expect(dry.body.counts).toEqual({ created: 60, updated: 0, unchanged: 0, retired: 0 });
    expect((await sql.query("SELECT COUNT(*)::int AS n FROM content_items WHERE module = 'code-search'")).rows[0].n).toBe(0);

    await importSample();
    const stored = await items();
    expect(stored).toHaveLength(60);
    expect(stored.every((i) => i.status === "approved" && i.version === 1)).toBe(true);
    for (const [index, rank] of RANK_IDS.entries()) {
      expect(stored.filter((i) => i.rank === rank), rank).toHaveLength(12);
      expect(stored.filter((i) => i.rank === rank).every((i) => i.id.startsWith(["CS-TR", "CS-FO", "CS-CA", "CS-CH", "CS-CP"][index] as string))).toBe(true);
    }
    const first = sample.records[0];
    expect(stored.find((i) => i.id === first?.id)?.data).toEqual({ letters: first?.letters, targets: first?.targets });
  });

  it("refuses a FIXTURE- id, an id/Level mismatch and a malformed board: 422 with the row errors, nothing stored", async () => {
    const rows = packToSheetRows(sample);
    const bad = rows.map((r) => [...r]);
    bad[1] = ["FIXTURE-TR-0001", ...(bad[1] as string[]).slice(1)];
    bad[2] = [...(bad[2] as string[])];
    bad[2][1] = bad[2][1] === "Trainee" ? "Captain" : "Trainee";
    bad[3] = [...(bad[3] as string[])];
    bad[3][3] = "[";
    const res = await upload(await writeSheet(bad));
    expect(res.status).toBe(422);
    const report = JSON.stringify(res.body);
    expect(report).toContain("FIXTURE-TR-0001");
    expect(report).toContain("does not match its rank");
    expect(report).toContain("not valid JSON");
    expect((await items()).length).toBe(0);
  });

  it("an admin export re-imports as all unchanged, with the Media Id column ignored", async () => {
    await importSample();
    const exported = await request(server)
      .get(`${BASE}/export`)
      .set(staff)
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => done(null, Buffer.concat(chunks)));
      });
    expect(exported.status).toBe(200);
    const again = await upload(exported.body as Buffer, "?dryRun=true");
    expect(again.status).toBe(200);
    expect(again.body.kind).toBe("admin_export");
    expect(again.body.counts).toEqual({ created: 0, updated: 0, unchanged: 60, retired: 0 });
  });
});

describe("Code Search staff edit", () => {
  it("edits a board in place (a clue), bumps the version and keeps the board valid", async () => {
    await importSample();
    const id = TRAINEE_IDS[0] as string;
    const board = (await items()).find((i) => i.id === id) as Item;
    const targets = board.data.targets.map((t, i) => (i === 0 ? { ...t, clue: `${String(t["clue"])} X` } : t));
    const res = await patch(id, { version: 1, data: { letters: board.data.letters, targets } });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.item.version).toBe(2);
    expect(((await items()).find((i) => i.id === id) as Item).data.targets[0]?.["clue"]).toBe(`${String(board.data.targets[0]?.["clue"])} X`);
  });

  it("refuses a rank-only edit to another rung: 422 import_invalid, nothing changes", async () => {
    await importSample();
    const id = TRAINEE_IDS[0] as string;
    const res = await patch(id, { version: 1, rank: "captain" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("import_invalid");
    expect(res.body.error.message).toContain("does not match its rank");
    const after = (await items()).find((i) => i.id === id) as Item;
    expect([after.rank, after.version]).toEqual(["trainee", 1]);
  });

  it("refuses a payload that is not canonical or does not fit its rung: 422, nothing changes", async () => {
    await importSample();
    const id = TRAINEE_IDS[0] as string;
    const board = (await items()).find((i) => i.id === id) as Item;
    const lower = await patch(id, { version: 1, data: { letters: board.data.letters.toLowerCase(), targets: board.data.targets } });
    expect(lower.status).toBe(422);
    expect(lower.body.error.code).toBe("import_invalid");
    const short = await patch(id, { version: 1, data: { letters: board.data.letters, targets: board.data.targets.slice(0, 3) } });
    expect(short.status).toBe(422);
    expect(short.body.error.message).toContain("does not fit its rank's grid or target count");
    const extra = await patch(id, { version: 1, data: { letters: board.data.letters, targets: board.data.targets, note: 1 } });
    expect(extra.status).toBe(422);
    expect(((await items()).find((i) => i.id === id) as Item).version).toBe(1);
  });
});

describe("Code Search trip coverage", () => {
  it("answers policy grid-draw.v1 and 10 at every rank for the 12-per-rank sample", async () => {
    await importSample();
    const res = await coverage();
    expect(res.status).toBe(200);
    expect(res.body.module).toBe(MODULE);
    expect(res.body.policy).toBe("grid-draw.v1");
    expect(res.body.flightsPerTrip).toBe(10);
    expect(res.body.ranks).toEqual(RANK_IDS.map((rank) => ({ rank, dealable: 10 })));
  });

  it("counts only the listed ids, and fewer than ten boards at a rank is below 10", async () => {
    await importSample();
    const res = await coverage({ itemIds: TRAINEE_IDS.slice(0, 7) });
    expect(res.status).toBe(200);
    expect(res.body.ranks.map((r: { dealable: number }) => r.dealable)).toEqual([7, 0, 0, 0, 0]);
    expect((await coverage({ itemIds: TRAINEE_IDS })).body.ranks[0].dealable).toBe(10);
    const unknown = await coverage({ itemIds: ["CS-TR-9999"] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("unknown_item_ids");
  });

  it("does not count a retired board, nor a stored approved row that is malformed", async () => {
    await importSample();
    const id = TRAINEE_IDS[0] as string;
    const retired = await request(server).post(`${BASE}/items/${id}/retire`).set(staff).send({ version: 1 });
    expect(retired.status).toBe(200);
    expect((await coverage()).body.ranks[0].dealable).toBe(10); // 11 left
    expect((await coverage({ itemIds: TRAINEE_IDS })).body.ranks[0].dealable).toBe(10); // 11 left, capped
    expect((await coverage({ itemIds: TRAINEE_IDS.slice(0, 3) })).body.ranks[0].dealable).toBe(2);
    // Garbage that passed no importer (a direct write): left out, not an error.
    await sql.query(
      `INSERT INTO content_items (module, id, rank, status, source, data, version, created_at, updated_at, updated_by, created_by)
       VALUES ('code-search', 'CS-TR-9999', 'trainee', 'approved', 'client_sheet', '{"letters":"x"}'::jsonb, 1, now(), now(), 'test', 'test')`,
    );
    expect((await coverage({ itemIds: ["CS-TR-9999"] })).body.ranks[0].dealable).toBe(0);
  });

  it("an empty module answers 0 at every rank", async () => {
    const res = await coverage();
    expect(res.status).toBe(200);
    expect(res.body.ranks.every((r: { dealable: number }) => r.dealable === 0)).toBe(true);
  });
});
