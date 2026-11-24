import { existsSync, readFileSync } from "node:fs";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { XLSX_MIME, readFirstSheet } from "../src/content/xlsx.js";
import { BLOB_STORE } from "../src/storage/blob-store.js";
import type { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { seedAdmins } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";
import { xlsx } from "./fixtures.js";
import type { TestCell } from "./fixtures.js";

// I3: the commercial Aircraft Identifier (module `identifier`) imported end to end: ids come from the sheet.

const MODULE = "identifier";
const BASE = `/v1/admin/content/${MODULE}`;
const staff = { Authorization: `Bearer ${emulatorToken("staff")}` };
const REAL_SHEET = "C:/Unity/Projects/AviationArcade_v2/docs/client-content/2026-09-28/Airplane Identifier v1.xlsx";
const haveSheet = existsSync(REAL_SHEET);

const HEADER = ["Level", "Correct Answer", "Wrong Answer 1", "Wrong Answer 2", "Wrong Answer 3", "file", "folder"];
/** Eight sheet rows: two on ai-a11, one left out (row 6), one with a "Boing", one with a slash file name. */
const FIXTURE_ROWS: TestCell[][] = [
  ["Captain", "Boeing 787-10", "Boeing 787-9", "Boeing 787-8", "Boing 767-200", "ai-a1.jpg", null], // row 4: Boing fix
  ["Trainee", "Boeing 787", "Boeing 767", "Airbus A330", "Boeing 757", "ai-a2.jpg", null], // row 5
  ["Captain", "Boeing 787-9", "Boeing 787-10", "Boeing 787-10", "Airbus A330", "ai-a8.jpg", null], // row 6: left out
  ["Trainee", "Airbus A321", "Boeing 737", "Airbus A319", "Boeing 717", "ai-a11.jpg", null], // row 7
  ["Chief Pilot", "Airbus A321neo", "Airbus A321ceo", "Airbus A320neo", "Airbus A320ceo", "ai-a11.jpg", null], // row 8: ai-a11-2
  ["Trainee", "Boeing 787", "Boeing 777", "Boeing 767", "Boeing 757", "ai-a23/jpg", null], // row 9: file fix
];
const FIXTURE_IDS = ["ai-a1", "ai-a2", "ai-a11", "ai-a11-2", "ai-a23"];

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;
let blobs: MemoryBlobStore;
let fixture: Buffer;

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await seedAdmins(sql, "staff");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  blobs = app.get<MemoryBlobStore>(BLOB_STORE);
  fixture = await xlsx([[null], [null], HEADER, ...FIXTURE_ROWS]);
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

beforeEach(async () => {
  await sql.query("DELETE FROM content_items");
  await sql.query("DELETE FROM content_imports");
  await frozenDelete(sql, "admin_audit");
  blobs.clear();
});

const upload = (bytes: Buffer, query = "") => request(server).post(`${BASE}/imports${query}`).set(staff).set("Content-Type", XLSX_MIME).send(bytes);
const items = async () => (await request(server).get(`${BASE}/items`).set(staff)).body.items as { id: string; version: number; rank: string; data: Record<string, unknown> }[];
const coverage = (body: unknown = {}) => request(server).post(`${BASE}/trip-coverage`).set(staff).send(body as object);
/** The same cells plus an extra blank column: different bytes, so it is planned rather than replayed. */
const resaved = () => xlsx([[null], [null], [...HEADER, "Resolution"], ...FIXTURE_ROWS.map((r) => [...r, null])]);

describe("Identifier import: a fixture sheet", () => {
  it("dry run lists the ids Unity gives, with the fixes and the left-out row as warnings, and writes nothing", async () => {
    const res = await upload(fixture, "?dryRun=true");
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ created: 5, updated: 0, unchanged: 0, retired: 0 });
    expect(res.body.rows.map((r: { id: string }) => r.id)).toEqual(FIXTURE_IDS);
    expect(res.body.rows.map((r: { row: number }) => r.row)).toEqual([4, 5, 7, 8, 9]);
    const messages = res.body.warnings.map((w: { row: number; message: string }) => [w.row, w.message.split(":")[0]]);
    expect(messages).toEqual([
      [4, "Corrected on import"],
      [6, "Left out"],
      [9, "Corrected on import"],
    ]);
    expect((await sql.query("SELECT COUNT(*)::int AS n FROM content_items")).rows[0].n).toBe(0);
  });

  it("apply stores the five items (no card key), the items list shows the ids, a re-import of the same bytes replays", async () => {
    const res = await upload(fixture);
    expect(res.status).toBe(201);
    expect(res.body.import).toMatchObject({ module: MODULE, created: 5, updated: 0, unchanged: 0, retired: 0 });

    const stored = await items();
    expect(stored.map((i) => i.id)).toEqual(FIXTURE_IDS);
    expect(stored.find((i) => i.id === "ai-a1")).toMatchObject({
      rank: "captain",
      data: { answer: "Boeing 787-10", wrong: ["Boeing 787-9", "Boeing 787-8", "Boeing 767-200"], sourceFile: "ai-a1.jpg" },
    });
    expect(stored.find((i) => i.id === "ai-a11-2")).toMatchObject({ rank: "chief-pilot", data: { sourceFile: "ai-a11.jpg" } });
    expect(stored.find((i) => i.id === "ai-a23")?.data["sourceFile"]).toBe("ai-a23.jpg");
    const rows = (await sql.query("SELECT id, status, source, card_key FROM content_items WHERE module = $1", [MODULE])).rows;
    expect(rows.every((r) => r.status === "approved" && r.source === "client_sheet" && r.card_key === null)).toBe(true);

    const replay = await upload(fixture);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    // Same content in different bytes: all unchanged, nothing retires.
    const again = await upload(await resaved());
    expect(again.status).toBe(201);
    expect(again.body.import).toMatchObject({ created: 0, updated: 0, unchanged: 5, retired: 0 });
  });

  it("PATCH ai-a11 changes it without a 422 against ai-a11-2 (same photo), and the next sheet import sees the edit as an update to confirm", async () => {
    await upload(fixture);
    const before = (await items()).find((i) => i.id === "ai-a11");
    const res = await request(server)
      .patch(`${BASE}/items/ai-a11`)
      .set(staff)
      .send({ version: before?.version, data: { answer: "Airbus A321", wrong: ["Boeing 737", "Airbus A319", "Boeing 727"], sourceFile: "ai-a11.jpg" } });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ id: "ai-a11", version: 2, source: "admin" });
    expect((await items()).find((i) => i.id === "ai-a11-2")?.version).toBe(1);

    const dry = await upload(await resaved(), "?dryRun=true");
    expect(dry.body.counts).toMatchObject({ updated: 1, unchanged: 4, retired: 0 });
    expect(dry.body.requiresConfirm).toBe(true);
    expect(dry.body.rows.find((r: { action: string }) => r.action === "update")).toMatchObject({ id: "ai-a11" });
  });

  it("PATCH refuses an invalid payload (a duplicate answer) and a photographer key: 422, nothing changes", async () => {
    await upload(fixture);
    const dup = await request(server).patch(`${BASE}/items/ai-a2`).set(staff).send({ version: 1, data: { answer: "A", wrong: ["a", "c", "d"], sourceFile: "ai-a2.jpg" } });
    expect(dup.status).toBe(422);
    const extra = await request(server).patch(`${BASE}/items/ai-a2`).set(staff).send({ version: 1, data: { answer: "A", wrong: ["b", "c", "d"], sourceFile: "ai-a2.jpg", photographer: "P" } });
    expect(extra.status).toBe(422);
    expect((await items()).find((i) => i.id === "ai-a2")?.version).toBe(1);
  });

  it("PATCH refuses a blank file name (422 'File name is empty'), nothing changes", async () => {
    await upload(fixture);
    for (const sourceFile of ["", "   "]) {
      const res = await request(server).patch(`${BASE}/items/ai-a2`).set(staff).send({ version: 1, data: { answer: "Boeing 787", wrong: ["Boeing 767", "Airbus A330", "Boeing 757"], sourceFile } });
      expect(res.status, JSON.stringify(sourceFile)).toBe(422);
      expect(res.body.error.message).toContain("File name is empty");
    }
    expect((await items()).find((i) => i.id === "ai-a2")?.version).toBe(1);
  });

  it("export round-trips: Id, Version, Level, answers, file, Status, Media Id; re-importing it is all unchanged; one cell is one update; a new id of the right shape is created", async () => {
    await upload(fixture);
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
    const sheet = (await readFirstSheet(exported.body as Buffer)) as TestCell[][];
    expect(sheet[0]).toEqual(["Id", "Version", "Level", "Correct Answer", "Wrong Answer 1", "Wrong Answer 2", "Wrong Answer 3", "file", "Status", "Media Id"]);
    expect(sheet.slice(1).map((r) => r[0])).toEqual(FIXTURE_IDS);

    const same = await upload(exported.body as Buffer);
    expect(same.body.import).toMatchObject({ created: 0, updated: 0, unchanged: 5, retired: 0 });

    const edited = sheet.map((r) => [...r]);
    (edited[2] as TestCell[])[4] = "Boeing 747"; // ai-a2 Wrong Answer 1
    edited.push(["ai-a40", null, "Trainee", "Boeing 737", "Airbus A320", "Airbus A321", "Boeing 757", "ai-a40.jpg", "approved", null]);
    const res = await upload(await xlsx(edited));
    expect(res.status).toBe(201);
    expect(res.body.import).toMatchObject({ created: 1, updated: 1, unchanged: 4 });
    expect((await items()).map((i) => i.id)).toEqual([...FIXTURE_IDS.slice(0, 2), "ai-a11", "ai-a11-2", "ai-a23", "ai-a40"].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
  });

  it("trip-coverage answers for identifier (lower-ranks): distinct photos at the own and lower ranks", async () => {
    await upload(fixture);
    const res = await coverage();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ module: MODULE, policy: "lower-ranks" });
    // trainee: ai-a2, ai-a11, ai-a23 (3); captain adds ai-a1 (4); chief pilot adds only a second question on ai-a11 (still 4)
    const dealable = Object.fromEntries((res.body.ranks as { rank: string; dealable: number }[]).map((r) => [r.rank, r.dealable]));
    expect(dealable).toEqual({ trainee: 3, "first-officer": 3, captain: 4, "check-airman": 4, "chief-pilot": 4 });
  });

  it("release routes still refuse identifier (they are Military-only): 404 not_found", async () => {
    await upload(fixture);
    const list = await request(server).get(`${BASE}/releases`).set(staff);
    expect(list.status).toBe(404);
    expect(list.body.error.code).toBe("not_found");
    const create = await request(server).post(`${BASE}/releases`).set(staff).send({ itemIds: ["ai-a1"], basis: "x", previewed: true });
    expect(create.status).toBe(404);
    expect((await request(server).post(`${BASE}/releases/1/activate`).set(staff).send({ expectedPointerVersion: 0 })).status).toBe(404);
    expect((await request(server).post(`${BASE}/releases/restore`).set(staff).send({ expectedPointerVersion: 0 })).status).toBe(404);
  });

  it("a sheet whose earlier left-out row is fixed renumbers ai-a11-2 and is an update to confirm, not a silent rewrite", async () => {
    // ASSUMPTION (see aircraft-identifier-mapping.test.ts): ids follow the kept rows on a photo in sheet order.
    const leftOut = ["Trainee", "Airbus A321", "Boeing 737", "Boeing 737", "Boeing 717", "ai-a11.jpg", null];
    const sheet1 = await xlsx([[null], [null], HEADER, leftOut, FIXTURE_ROWS[3] as TestCell[], FIXTURE_ROWS[4] as TestCell[]]);
    expect((await upload(sheet1)).status).toBe(201);
    expect((await items()).map((i) => i.id)).toEqual(["ai-a11", "ai-a11-2"]);

    const fixed = [...leftOut];
    fixed[3] = "Airbus A320";
    const sheet2 = await xlsx([[null], [null], HEADER, fixed, FIXTURE_ROWS[3] as TestCell[], FIXTURE_ROWS[4] as TestCell[]]);
    const dry = await upload(sheet2, "?dryRun=true");
    expect(dry.status).toBe(200);
    expect(dry.body.counts).toEqual({ created: 1, updated: 2, unchanged: 0, retired: 0 });
    expect(dry.body.requiresConfirm).toBe(true);
    const unconfirmed = await upload(sheet2);
    expect(unconfirmed.status).toBe(422);
    expect((await items()).map((i) => i.id)).toEqual(["ai-a11", "ai-a11-2"]);
  });

  it("another module is untouched, and a module with no mapping is still 404", async () => {
    await upload(fixture);
    expect((await request(server).get("/v1/admin/content/aircraft-identifier-military/items").set(staff)).body).toEqual({ items: [] });
    expect((await request(server).get("/v1/admin/content/atc-match/items").set(staff)).status).toBe(404);
  });
});

describe.skipIf(!haveSheet)("Identifier import: the client's real sheet", () => {
  it("dry run plans 31 creates with Unity's ids; apply stores them; coverage answers", async () => {
    const real = readFileSync(REAL_SHEET);
    const dry = await upload(real, "?dryRun=true");
    expect(dry.status).toBe(200);
    expect(dry.body.counts).toEqual({ created: 31, updated: 0, unchanged: 0, retired: 0 });
    const ids = dry.body.rows.map((r: { id: string }) => r.id);
    expect(ids).toHaveLength(31);
    expect(ids).toContain("ai-a11-2");
    expect(ids).toContain("ai-a18-2");
    expect(ids).not.toContain("ai-a8");
    expect(ids).not.toContain("ai-a14");
    expect(dry.body.warnings.filter((w: { message: string }) => w.message.startsWith("Corrected on import:"))).toHaveLength(5);
    expect(dry.body.warnings.filter((w: { message: string }) => w.message.startsWith("Left out:")).map((w: { row: number }) => w.row)).toEqual([11, 18]);
    expect((await sql.query("SELECT COUNT(*)::int AS n FROM content_items")).rows[0].n).toBe(0);

    const applied = await upload(real);
    expect(applied.status).toBe(201);
    expect(applied.body.import).toMatchObject({ created: 31 });
    expect((await items()).map((i) => i.id).sort()).toEqual([...ids].sort());
    expect((await upload(real)).body.replayed).toBe(true);

    const cov = await coverage();
    expect(cov.status).toBe(200);
    expect(cov.body.policy).toBe("lower-ranks");
    const dealable = (cov.body.ranks as { rank: string; dealable: number }[]).find((r) => r.rank === "chief-pilot");
    expect(dealable?.dealable).toBe(10); // 29 distinct photos, capped at a Trip's ten Flights
  });
});
