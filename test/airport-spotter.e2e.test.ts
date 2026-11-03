import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { MAX_UPLOAD_BYTES, XLSX_MIME, readFirstSheet } from "../src/content/xlsx.js";
import { BLOB_STORE } from "../src/storage/blob-store.js";
import type { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { emulatorToken } from "./tokens.js";
import { xlsx } from "./fixtures.js";
import type { TestCell } from "./fixtures.js";

// I1: the Airport Spotter importer end to end, on the client's real sheet.

const MODULE = "airport-spotter";
const BASE = `/v1/admin/content/${MODULE}`;
const staff = { Authorization: `Bearer ${emulatorToken("staff")}` };

const docsDir = process.env["CLIENT_DOCS_DIR"];
const REAL_SHEET = docsDir ? new URL(`file:///${join(docsDir, "Airport Spotter v1.xlsx").replaceAll("\\", "/")}`) : new URL("../../docs/Airport Spotter v1.xlsx", import.meta.url);
const haveSheet = existsSync(REAL_SHEET);

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;
let blobs: MemoryBlobStore;
/** The real sheet's cell values re-saved WITHOUT the embedded photos (the file as delivered is 13 MB; the upload cap is 5 MB). */
let stripped: Buffer;

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  blobs = app.get<MemoryBlobStore>(BLOB_STORE);
  if (haveSheet) {
    const rows = (await readFirstSheet(readFileSync(REAL_SHEET))) as TestCell[][];
    stripped = await xlsx(rows.map((r) => r.slice(0, 6))); // the Image column holds no values, only embedded pictures
  }
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

beforeEach(async () => {
  await sql.query("DELETE FROM content_items");
  await sql.query("DELETE FROM content_imports");
  await sql.query("DELETE FROM admin_audit");
  blobs.clear();
});

const upload = (bytes: Buffer, query = "") => request(server).post(`${BASE}/imports${query}`).set(staff).set("Content-Type", XLSX_MIME).send(bytes);
const exportBytes = async (): Promise<Buffer> => {
  const res = await request(server)
    .get(`${BASE}/export`)
    .set(staff)
    .buffer(true)
    .parse((response, done) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => done(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  return res.body as Buffer;
};

/** The same cells with an extra blank "Image" header: different bytes, so it is planned rather than replayed. */
async function resavedCopy(): Promise<Buffer> {
  return xlsx([[null], [null], ["LEVEL", "Correct Airport", "Wrong Airport 1", "Wrong Airport 2", "Wrong Airport 3", "File name", "Image"], ...((await readFirstSheet(stripped)) as TestCell[][]).slice(3)]);
}

describe.skipIf(!haveSheet)("Airport Spotter import of the client's real sheet", () => {
  it("dry run plans 45 creates apt-a1..apt-a45 with the seven corrections as warnings, and writes nothing", async () => {
    const res = await upload(stripped, "?dryRun=true");
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ created: 45, updated: 0, unchanged: 0, retired: 0 });
    expect(res.body.rows[0]).toEqual({ row: 4, id: "apt-a1", action: "create" });
    expect(res.body.rows[44]).toEqual({ row: 48, id: "apt-a45", action: "create" });
    const corrected = res.body.warnings.filter((w: { message: string }) => w.message.startsWith("Corrected on import"));
    expect(corrected.map((w: { row: number }) => w.row)).toEqual([9, 17, 21, 24, 32, 40, 44]);
    expect((await sql.query("SELECT COUNT(*)::int AS n FROM content_items")).rows[0].n).toBe(0);
  });

  it("apply stores 45 approved items (no card_key), re-import is a replay, a re-saved copy is all unchanged", async () => {
    const res = await upload(stripped);
    expect(res.status).toBe(201);
    expect(res.body.import).toMatchObject({ module: MODULE, created: 45, updated: 0, unchanged: 0, retired: 0 });
    expect(res.body.warnings.filter((w: { message: string }) => w.message.startsWith("Corrected on import"))).toHaveLength(7);

    const rows = (await sql.query("SELECT id, rank, status, card_key, data FROM content_items WHERE module = $1", [MODULE])).rows;
    expect(rows).toHaveLength(45);
    expect(rows.every((r) => r.status === "approved" && r.card_key === null)).toBe(true);
    const perRank: Record<string, number> = {};
    for (const r of rows) perRank[r.rank] = (perRank[r.rank] ?? 0) + 1;
    expect(perRank).toEqual({ trainee: 4, "first-officer": 15, captain: 10, "check-airman": 14, "chief-pilot": 2 });
    expect(rows.find((r) => r.id === "apt-a41")?.data).toEqual({ answer: "FRA", wrong: ["MUC", "LHR", "ORY"], sourceFile: "api_fra_10_22_26_1.jpg" });

    const replay = await upload(stripped);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);

    // Different bytes, same content (the client re-saves the sheet): nothing changes, nothing retires.
    const again = await upload(await resavedCopy());
    expect(again.status).toBe(201);
    expect(again.body.import).toMatchObject({ created: 0, updated: 0, unchanged: 45, retired: 0 });
  });

  it("export round-trips: the export re-imports as all unchanged, and one edited cell is one update", async () => {
    await upload(stripped);
    const bytes = await exportBytes();
    const sheet = (await readFirstSheet(bytes)) as TestCell[][];
    expect(sheet[0]).toEqual(["Id", "Version", "LEVEL", "Correct Airport", "Wrong Airport 1", "Wrong Airport 2", "Wrong Airport 3", "File name", "Status"]);
    expect(sheet).toHaveLength(46);
    expect(sheet[1]?.slice(0, 8)).toEqual(["apt-a1", 1, "Captain", "LAX", "DEN", "LAS", "PIT", "api_lax_10_22_26_1.jpg"]);
    const same = await upload(bytes);
    expect(same.body.import).toMatchObject({ created: 0, updated: 0, unchanged: 45 });

    const edited = sheet.map((r) => [...r]);
    (edited[2] as TestCell[])[4] = "OAK"; // apt-a2 Wrong Airport 1
    const res = await upload(await xlsx(edited));
    expect(res.status).toBe(201);
    expect(res.body.import).toMatchObject({ created: 0, updated: 1, unchanged: 44 });
    expect((await sql.query("SELECT data FROM content_items WHERE module = $1 AND id = 'apt-a2'", [MODULE])).rows[0].data.wrong[0]).toBe("OAK");
  });

  it("staff edit route: PATCH an airport item; a bad code is 422 and nothing changes", async () => {
    await upload(stripped);
    const item = (id: string) => `${BASE}/items/${id}`;
    const bad = await request(server).patch(item("apt-a1")).set(staff).send({ version: 1, data: { answer: "LAX", wrong: ["DEN", "LAS", "PITT"], sourceFile: "api_lax_10_22_26_1.jpg" } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toContain("3-letter airport code");
    const extra = await request(server).patch(item("apt-a1")).set(staff).send({ version: 1, data: { answer: "LAX", wrong: ["DEN", "LAS", "PIT"], sourceFile: "x.jpg", photographer: "p" } });
    expect(extra.status).toBe(422);

    const ok = await request(server).patch(item("apt-a1")).set(staff).send({ version: 1, rank: "chief-pilot", data: { answer: "lax", wrong: ["DEN", "LAS", "SEA"], sourceFile: "api_lax_10_22_26_1.jpg" } });
    expect(ok.status).toBe(200);
    expect(ok.body.item).toMatchObject({ id: "apt-a1", version: 2, rank: "chief-pilot", source: "admin", data: { answer: "LAX", wrong: ["DEN", "LAS", "SEA"] } });
    expect((await sql.query("SELECT card_key FROM content_items WHERE module = $1 AND id = 'apt-a1'", [MODULE])).rows[0].card_key).toBeNull();
    // A client sheet re-import now sees the edit as a change to confirm (the sheet is authoritative).
    const reimport = await upload(await resavedCopy(), "?dryRun=true");
    expect(reimport.body.counts).toMatchObject({ updated: 1, unchanged: 44 });
    expect(reimport.body.requiresConfirm).toBe(true);
  });

  it("trip-coverage has no deal policy for this module: 404 not_found, like any module without dealing", async () => {
    await upload(stripped);
    const res = await request(server).post(`${BASE}/trip-coverage`).set(staff).send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("the sheet as delivered (13 MB with the photos) is over the 5 MB upload cap", async () => {
    const real = readFileSync(REAL_SHEET);
    expect(real.length).toBeGreaterThan(MAX_UPLOAD_BYTES);
    const res = await upload(real);
    expect(res.status).toBe(413);
    expect((await sql.query("SELECT COUNT(*)::int AS n FROM content_items")).rows[0].n).toBe(0);
  });
});

describe("Airport Spotter module routes", () => {
  it("lists the module as importable (empty), exports a header-only file, and other modules without a mapping stay 404", async () => {
    expect((await request(server).get(`${BASE}/items`).set(staff)).body).toEqual({ items: [] });
    expect(((await readFirstSheet(await exportBytes())) as TestCell[][]).length).toBe(1);
    expect((await request(server).get("/v1/admin/content/atc-match/items").set(staff)).status).toBe(404);
  });
});
