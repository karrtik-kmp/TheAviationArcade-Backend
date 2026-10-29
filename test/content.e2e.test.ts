import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { sanitiseFileName } from "../src/content/content.controller.js";
import { XLSX_MIME, readFirstSheet } from "../src/content/xlsx.js";
import { BLOB_STORE, StorageRequestError } from "../src/storage/blob-store.js";
import { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { CLIENT_HEADER, clientRow, clientSheet, xlsx } from "./fixtures.js";
import type { TestCell } from "./fixtures.js";
import { emulatorToken } from "./tokens.js";

// Phase 5.0 admin content store: staff gate, import/export semantics, idempotency, storage failure.
// STAFF_EMAILS comes from vitest.e2e.config.ts: staff@sites.test and Other.Staff@Sites.Test.

const MODULE = "aircraft-identifier-military";
const STAFF_PRINCIPAL = "firebase:demo-airplane-games:staff";
const IMPORTS = `/v1/admin/content/${MODULE}/imports`;
const ITEMS = `/v1/admin/content/${MODULE}/items`;
const EXPORT = `/v1/admin/content/${MODULE}/export`;

const staff = { Authorization: `Bearer ${emulatorToken("staff")}` };
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const apps: NestExpressApplication[] = [];
const savedEnv = { ...process.env };
let sql: pg.Pool;

async function buildApp(env: Record<string, string> = {}) {
  Object.assign(process.env, env);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  return { app, server: app.getHttpServer(), blobs: app.get<MemoryBlobStore>(BLOB_STORE) };
}

let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let blobs: MemoryBlobStore;

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  ({ server, blobs } = await buildApp());
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  // The e2e database is shared across runs: start each test from no content.
  await sql.query("DELETE FROM content_items");
  await sql.query("DELETE FROM content_imports");
  await sql.query("DELETE FROM admin_audit");
  blobs.clear();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const upload = (bytes: Buffer, query = "", headers: Record<string, string> = staff, target = server) =>
  request(target).post(`${IMPORTS}${query}`).set(headers).set("Content-Type", XLSX_MIME).send(bytes);

async function download(headers = staff, target = server): Promise<{ bytes: Buffer; res: request.Response }> {
  const res = await request(target)
    .get(EXPORT)
    .set(headers)
    .buffer(true)
    .parse((response, done) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => done(null, Buffer.concat(chunks)));
    });
  return { bytes: res.body as Buffer, res };
}

const count = async (table: string) => (await sql.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0]?.n;

/** Export rows as TestCells (header first), ready to edit and re-upload. */
async function exportedRows(): Promise<TestCell[][]> {
  const { bytes } = await download();
  return (await readFirstSheet(bytes)) as TestCell[][];
}

describe("staff gate", () => {
  const routes = [
    ["get", "/v1/admin/me"],
    ["get", ITEMS],
    ["get", EXPORT],
    ["post", IMPORTS],
  ] as const;

  it("no token is 401 first, on every admin route", async () => {
    for (const [method, path] of routes) {
      const res = await request(server)[method](path);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
      expect(res.headers["www-authenticate"]).toBe("Bearer");
    }
    expect((await request(server).get("/v1/admin/me").set("Authorization", "Bearer garbage")).status).toBe(401);
  });

  it("a signed-in caller who is not on the allowlist is 403 forbidden 'Staff only.'", async () => {
    const caller = bearer(emulatorToken(`uid-${randomUUID()}`));
    for (const [method, path] of routes) {
      const res = await request(server)[method](path).set(caller);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error).toMatchObject({ code: "forbidden", message: "Staff only." });
    }
    // Importing is refused before the file is looked at: nothing stored, nothing written.
    const res = await upload(await clientSheet(), "", caller);
    expect(res.status).toBe(403);
    expect(await count("content_imports")).toBe(0);
    expect(blobs.size).toBe(0);
  });

  it("a listed email whose address is not verified is 403", async () => {
    const res = await request(server)
      .get("/v1/admin/me")
      .set(bearer(emulatorToken("staff", "demo-airplane-games", "password", { emailVerified: false })));
    expect(res.status).toBe(403);
  });

  it("a token with no email claim is 403, and a client-chosen role or header grants nothing", async () => {
    const noEmail = bearer(emulatorToken("staff", "demo-airplane-games", "password", { email: null }));
    expect((await request(server).get("/v1/admin/me").set(noEmail)).status).toBe(403);
    const res = await request(server)
      .get("/v1/admin/me")
      .set(bearer(emulatorToken(`uid-${randomUUID()}`)))
      .set("X-Role", "admin")
      .set("X-Staff-Email", "staff@sites.test")
      .query({ role: "admin", email: "staff@sites.test" });
    expect(res.status).toBe(403);
  });

  it("the allowlist match is case-insensitive", async () => {
    const res = await request(server)
      .get("/v1/admin/me")
      .set(bearer(emulatorToken("someone-else", "demo-airplane-games", "google.com", { email: "OTHER.STAFF@sites.test" })));
    expect(res.status).toBe(200);
    expect(res.body.staff).toBe(true);
  });

  it("a verified listed caller gets { principal, staff: true } and needs no player row", async () => {
    const res = await request(server).get("/v1/admin/me").set(staff);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ principal: STAFF_PRINCIPAL, staff: true });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((await sql.query("SELECT 1 FROM players WHERE id = $1", [STAFF_PRINCIPAL])).rowCount).toBe(0);
  });

  it("the client version gate does not apply to /v1/admin/*", async () => {
    const gated = await buildApp({ MIN_CLIENT_BUILD: "100" });
    const control = await request(gated.server).get("/v1/me/progress").set(staff);
    expect(control.status).toBe(426);
    for (const [method, path] of routes.filter(([, path]) => path !== IMPORTS)) {
      const res = await request(gated.server)[method](path).set(staff);
      expect(res.status, `${method} ${path}`).toBe(200);
    }
    expect((await upload(await clientSheet(2), "?dryRun=true", staff, gated.server)).status).toBe(200);
  });
});

describe("import validation", () => {
  it("a module without a mapping, or an unknown one, is 404 not_found", async () => {
    for (const module of ["atc-match", "identifier", "bogus"]) {
      for (const [method, suffix] of [["post", "imports"], ["get", "items"], ["get", "export"]] as const) {
        const call = request(server)[method](`/v1/admin/content/${module}/${suffix}`).set(staff);
        const res = await (method === "post" ? call.set("Content-Type", XLSX_MIME).send(await clientSheet(1)) : call);
        expect(res.status, `${module} ${suffix}`).toBe(404);
        expect(res.body.error.code).toBe("not_found");
      }
    }
  });

  it("anything but an xlsx body is 400 invalid_request", async () => {
    const json = await request(server).post(IMPORTS).set(staff).send({ hello: "world" });
    expect(json.status).toBe(400);
    expect(json.body.error.code).toBe("invalid_request");
    const noBody = await request(server).post(IMPORTS).set(staff).set("Content-Type", XLSX_MIME);
    expect(noBody.status).toBe(400);
    const garbage = await upload(Buffer.from("this is not a spreadsheet"));
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe("invalid_request");
    const wrongType = await request(server).post(IMPORTS).set(staff).set("Content-Type", "text/csv").send("a,b");
    expect(wrongType.status).toBe(400);
  });

  it("an upload over 5 MB is 413, and the 16 KB JSON limit still holds elsewhere", async () => {
    const big = await upload(Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("invalid_request");
    const json = await request(server).post("/v1/rounds").set(staff).send({ module: "atc-match", pad: "x".repeat(20_000) });
    expect(json.status).toBe(413);
    // The raw parser is not mounted anywhere else.
    const elsewhere = await request(server).post("/v1/rounds").set(staff).set("Content-Type", XLSX_MIME).send(Buffer.alloc(100));
    expect(elsewhere.status).toBe(400);
  });

  it("an anonymous upload is refused as 401 without the body being read", async () => {
    const res = await request(server).post(IMPORTS).set("Content-Type", XLSX_MIME).send(await clientSheet(1));
    expect(res.status).toBe(401);
  });

  it("dryRun must be exactly true or false, and no other query is accepted", async () => {
    const bytes = await clientSheet(2);
    expect((await upload(bytes, "?dryRun=maybe")).status).toBe(400);
    expect((await upload(bytes, "?dryRun=true&dryRun=false")).status).toBe(400);
    expect((await upload(bytes, "?force=true")).status).toBe(400);
    expect((await upload(bytes, "?confirm=not-a-hash")).status).toBe(400);
    expect((await upload(bytes, `?dryRun=true&confirm=${"a".repeat(64)}`)).status).toBe(400);
    expect((await upload(bytes, "?dryRun=false")).status).toBe(201);
  });

  it("a zip bomb is 400 'too large when unpacked' and writes nothing", async () => {
    const { zipSync } = await import("fflate");
    const bomb = Buffer.from(zipSync({ "xl/worksheets/sheet1.xml": new Uint8Array(60 * 1024 * 1024) }, { level: 9 }));
    const res = await upload(bomb);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Spreadsheet is too large when unpacked.");
    expect(await count("content_imports")).toBe(0);
  });

  it("sanitises the uploaded file name", () => {
    expect(sanitiseFileName("../../etc/Military v1.xlsx")).toBe("Military v1.xlsx");
    expect(sanitiseFileName("C:\\Users\\me\\sheet?.xlsx")).toBe("sheet_.xlsx");
    expect(sanitiseFileName("<script>alert(1)</script>.xlsx")).toBe("script_.xlsx");
    expect(sanitiseFileName(undefined)).toBe("import.xlsx");
    expect(sanitiseFileName("   ")).toBe("import.xlsx");
    expect(sanitiseFileName("x".repeat(300)).length).toBe(200);
  });
});

describe("import, replay and listing", () => {
  it("dryRun plans 31 creates with the warnings and writes and stores nothing", async () => {
    const res = await upload(await clientSheet(31), "?dryRun=true");
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.counts).toEqual({ created: 31, updated: 0, unchanged: 0, retired: 0 });
    expect(res.body).toMatchObject({ kind: "client_sheet", requiresConfirm: false, retirements: [] });
    expect(res.body.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.rows).toHaveLength(31);
    expect(res.body.rows[0]).toEqual({ row: 4, id: "mil-a1", action: "create" });
    expect(res.body.warnings.map((w: { row: number }) => w.row)).toEqual([35, 36]);
    expect(await count("content_items")).toBe(0);
    expect(await count("content_imports")).toBe(0);
    expect(await count("admin_audit")).toBe(0);
    expect(blobs.size).toBe(0);
  });

  it("applies: 201 summary, original bytes stored by sha256, approved items, one audit row, no email stored", async () => {
    const bytes = await clientSheet(31);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const res = await upload(bytes).set("X-File-Name", "../Military Airplane Identifier v1.xlsx");
    expect(res.status).toBe(201);
    expect(res.body.replayed).toBe(false);
    expect(res.body.import).toMatchObject({
      module: MODULE,
      fileName: "Military Airplane Identifier v1.xlsx",
      sha256: sha,
      byteSize: bytes.length,
      created: 31,
      updated: 0,
      unchanged: 0,
      retired: 0,
    });
    expect(res.body.warnings).toHaveLength(2);

    const stored = await blobs.get(`imports/${MODULE}/${sha}.xlsx`);
    expect(Buffer.from(stored ?? []).equals(bytes)).toBe(true);
    expect(blobs.contentTypeOf(`imports/${MODULE}/${sha}.xlsx`)).toBe(XLSX_MIME);
    const receipt = (await sql.query("SELECT blob_key, imported_by FROM content_imports")).rows[0];
    expect(receipt).toEqual({ blob_key: `imports/${MODULE}/${sha}.xlsx`, imported_by: STAFF_PRINCIPAL });

    const list = await request(server).get(ITEMS).set(staff);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(31);
    // Natural order: mil-a2 before mil-a10.
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual(Array.from({ length: 31 }, (_, i) => `mil-a${i + 1}`));
    expect(list.body.items[0]).toMatchObject({
      id: "mil-a1",
      rank: "trainee",
      status: "approved",
      source: "client_sheet",
      version: 1,
      data: { answer: "Aircraft 1", wrong: ["Wrong 1a", "Wrong 1b", "Wrong 1c"], sourceFile: "MA_test_1.jpg", photographer: "Photographer 1" },
    });
    expect(typeof list.body.items[0].updatedAt).toBe("string");
    expect((await sql.query("SELECT DISTINCT updated_by, import_id FROM content_items")).rows).toEqual([
      { updated_by: STAFF_PRINCIPAL, import_id: res.body.import.id },
    ]);

    const audit = (await sql.query("SELECT actor, action, target, detail FROM admin_audit")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: STAFF_PRINCIPAL, action: "content_import", target: MODULE });
    expect(audit[0].detail).toMatchObject({ importId: res.body.import.id, sha256: sha, created: 31 });
    // No email anywhere in what was written.
    const everything = JSON.stringify([
      (await sql.query("SELECT * FROM content_items")).rows,
      (await sql.query("SELECT * FROM content_imports")).rows,
      audit,
    ]);
    expect(everything).not.toContain("@");
  });

  it("identical bytes replay: 200 replayed:true, the same receipt, no new rows", async () => {
    const bytes = await clientSheet(5);
    const first = await upload(bytes);
    const second = await upload(bytes);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.import).toEqual(first.body.import);
    expect(await count("content_imports")).toBe(1);
    expect(await count("content_items")).toBe(5);
    expect(await count("admin_audit")).toBe(1);
  });

  it("an empty module lists no items", async () => {
    const list = await request(server).get(ITEMS).set(staff);
    expect(list.body).toEqual({ items: [] });
  });

  it("any row error is 422 import_invalid with the report, and nothing is written or stored", async () => {
    const bytes = await clientSheet(4, (rows) => {
      rows[4] = ["Admiral", "A", "B", "C", "D", "x.jpg", "P"]; // mil-a2: unknown Level
      rows[5] = ["Captain", "Dup", "Dup", "C", "D", "x.jpg", "P"]; // mil-a3: repeated answer
    });
    for (const query of ["", "?dryRun=true"]) {
      const res = await upload(bytes, query);
      expect(res.status, query).toBe(422);
      expect(res.body.error.code).toBe("import_invalid");
      expect(res.body.error.requestId).toBeTruthy();
      const errors = res.body.report.filter((r: { level: string }) => r.level === "error");
      // A client sheet has no ids until the whole file is valid, so errors are located by sheet row.
      expect(errors.map((r: { row: number }) => r.row)).toEqual([5, 6]);
    }
    expect(await count("content_items")).toBe(0);
    expect(await count("content_imports")).toBe(0);
    expect(blobs.size).toBe(0);
  });

  it("a repeated Id in one file is an error", async () => {
    const bytes = await xlsx([["Id", ...CLIENT_HEADER], ["mil-a1", ...clientRow(1)], ["mil-a1", ...clientRow(2)]]);
    const res = await upload(bytes);
    expect(res.status).toBe(422);
    expect(res.body.report).toEqual([{ row: 3, id: "mil-a1", level: "error", message: "Duplicate id (first used on row 2)." }]);
  });

  it("an Id-column file whose content differs from stored content, without a Version, is a conflict, never an overwrite", async () => {
    await upload(await clientSheet(3));
    const rows = await exportedRows();
    rows[1]![1] = null; // drop the Version of mil-a1 ...
    rows[1]![3] = "Someone Else"; // ... and change it
    const res = await upload(await xlsx(rows));
    expect(res.status).toBe(422);
    expect(res.body.report.filter((r: { level: string }) => r.level === "conflict")).toEqual([
      expect.objectContaining({ row: 2, id: "mil-a1", level: "conflict", message: expect.stringContaining("export, edit and re-import") }),
    ]);
    expect((await sql.query("SELECT data->>'answer' AS a FROM content_items WHERE id = 'mil-a1'")).rows[0].a).toBe("Aircraft 1");
    expect(await count("content_imports")).toBe(1);
  });

  it("no storage configured (BLOB_STORE=none): apply is 503 storage_unavailable with Retry-After, dryRun still works", async () => {
    const none = await buildApp({ BLOB_STORE: "none" });
    const bytes = await clientSheet(3);
    const res = await upload(bytes, "", staff, none.server);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("storage_unavailable");
    expect(res.headers["retry-after"]).toBe("5");
    expect(await count("content_items")).toBe(0);
    expect(await count("content_imports")).toBe(0);
    expect((await upload(bytes, "?dryRun=true", staff, none.server)).status).toBe(200);
  });

  it("a storage refusal that a retry will not fix (Bunny 401/403) is 503 storage_unavailable without Retry-After", async () => {
    const own = await buildApp();
    own.blobs.put = async () => {
      throw new StorageRequestError(403);
    };
    const res = await upload(await clientSheet(3), "", staff, own.server);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("storage_unavailable");
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(await count("content_items")).toBe(0);
    expect(await count("content_imports")).toBe(0);
  });

  it("concurrent identical uploads: exactly one 201; the rest replay (200) or are told to retry (409 import_in_progress)", async () => {
    const bytes = await clientSheet(31);
    const results = await Promise.all(Array.from({ length: 4 }, () => upload(bytes)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect([200, 409]).toContain(r.status);
      if (r.status === 409) {
        expect(r.body.error.code).toBe("import_in_progress");
        expect(r.headers["retry-after"]).toBe("2");
      }
    }
    expect(await count("content_imports")).toBe(1);
    expect(await count("content_items")).toBe(31);
    expect(await count("admin_audit")).toBe(1);
  });

  it("concurrent imports of two different files into an empty module: one wins; the other is refused (422 plan or 409 busy); nothing is half-written", async () => {
    const a = await clientSheet(10);
    const b = await clientSheet(10, (rows) => {
      rows[3] = ["Trainee", "Different", "x", "y", "z", "a.jpg", "P"];
    });
    const results = await Promise.all([upload(a), upload(b)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect([409, 422]).toContain(results.find((r) => r.status !== 201)?.status);
    expect(await count("content_items")).toBe(10);
    expect(await count("content_imports")).toBe(1);
    const winner = results.find((r) => r.status === 201);
    const stored = (await sql.query("SELECT data->>'answer' AS a FROM content_items WHERE id = 'mil-a1'")).rows[0].a;
    expect(stored).toBe(winner === results[0] ? "Aircraft 1" : "Different");
  });

  it("keeps Unicode intact from sheet to database to export", async () => {
    const bytes = await clientSheet(2, (rows) => {
      rows[3] = ["Captain", "Hartsfield\u2013Jackson \u2014 Atlanta", "Caf\u00e9 \u00dcber", "\u65e5\u672c\u8a9e", "\u00d1and\u00fa", "u.jpg", "Zo\u00eb"];
    });
    expect((await upload(bytes)).status).toBe(201);
    const item = (await request(server).get(ITEMS).set(staff)).body.items[0];
    expect(item.data.answer).toBe("Hartsfield\u2013Jackson \u2014 Atlanta");
    const rows = await exportedRows();
    expect(rows[1]?.[3]).toBe("Hartsfield\u2013Jackson \u2014 Atlanta");
    expect(rows[1]?.[8]).toBe("Zo\u00eb");
  });
});

describe("export and round trip", () => {
  it("exports xlsx with the client's columns and wording, natural id order and download headers", async () => {
    await upload(await clientSheet(12));
    const { res } = await download();
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_MIME);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-disposition"]).toMatch(new RegExp(`^attachment; filename="${MODULE}-\\d{4}-\\d{2}-\\d{2}\\.xlsx"$`));
    const rows = await exportedRows();
    expect(rows[0]).toEqual(["Id", "Version", "Level", "Correct Answer", "Wrong Answer 1", "Wrong Answer 2", "Wrong Answer 3", "file", "Photographer", "Status"]);
    expect(rows.slice(1).map((r) => r[0])).toEqual(Array.from({ length: 12 }, (_, i) => `mil-a${i + 1}`));
    expect(rows[1]).toEqual(["mil-a1", 1, "Trainee", "Aircraft 1", "Wrong 1a", "Wrong 1b", "Wrong 1c", "MA_test_1.jpg", "Photographer 1", "approved"]);
    expect(rows[4]?.[2]).toBe("Check Airman");
    expect(rows[5]?.[2]).toBe("Chief Pilot");
  });

  it("an empty module exports just the header row", async () => {
    const rows = await exportedRows();
    expect(rows).toHaveLength(1);
  });

  it("import -> export -> re-import -> edit one cell -> stale re-import, with replay and conflict rules", async () => {
    const original = await clientSheet(31);
    expect((await upload(original)).status).toBe(201);

    // Re-importing the export changes nothing: every row unchanged (a new receipt, but no writes to items).
    const exported = await download();
    const same = await upload(exported.bytes);
    expect(same.status).toBe(201);
    expect(same.body.import).toMatchObject({ created: 0, updated: 0, unchanged: 31 });
    expect((await sql.query("SELECT COUNT(*)::int AS n FROM content_items WHERE version = 1 AND source = 'client_sheet'")).rows[0].n).toBe(31);

    // The same export bytes again are a replay.
    const replay = await upload(exported.bytes);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.import.id).toBe(same.body.import.id);

    // Edit one cell (Correct Answer of mil-a3) in the export and import: exactly one update.
    const edited = await exportedRows();
    expect(edited[3]?.[0]).toBe("mil-a3");
    edited[3]![3] = "Edited Answer";
    const editedBytes = await xlsx(edited);
    const update = await upload(editedBytes);
    expect(update.status).toBe(201);
    expect(update.body.import).toMatchObject({ created: 0, updated: 1, unchanged: 30 });
    const item = (await request(server).get(ITEMS).set(staff)).body.items.find((i: { id: string }) => i.id === "mil-a3");
    expect(item).toMatchObject({ version: 2, source: "admin", data: { answer: "Edited Answer" } });
    expect(await count("admin_audit")).toBe(3);

    // The new export carries Version 2 for that row and round-trips as all-unchanged again.
    const after = await exportedRows();
    expect(after[3]?.[1]).toBe(2);
    expect(after[1]?.[1]).toBe(1);
    expect((await upload(await xlsx(after))).body.import).toMatchObject({ updated: 0, unchanged: 31 });

    // A stale copy (Version 1 for mil-a3) with another edit is a conflict; the stored row is untouched.
    const stale = await exportedRows();
    stale[3]![1] = 1;
    stale[3]![3] = "Stale Edit";
    const conflict = await upload(await xlsx(stale));
    expect(conflict.status).toBe(422);
    expect(conflict.body.error.code).toBe("import_invalid");
    expect(conflict.body.report).toEqual([
      expect.objectContaining({ row: 4, id: "mil-a3", level: "conflict", message: expect.stringContaining("out of date") }),
    ]);
    expect((await sql.query("SELECT data->>'answer' AS a, version FROM content_items WHERE id = 'mil-a3'")).rows[0]).toEqual({
      a: "Edited Answer",
      version: 2,
    });
  });

  it("ASSUMPTION: replay applies only while the receipt is the module's latest import; the old export's bytes after later edits are planned (and conflict), never replayed", async () => {
    await upload(await clientSheet(5));
    const oldExport = (await download()).bytes;
    const recorded = await upload(oldExport);
    expect(recorded.status).toBe(201); // all unchanged, recorded
    // Latest receipt: a dry run says it would replay, and so does the apply.
    const dry = await upload(oldExport, "?dryRun=true");
    expect(dry.body).toMatchObject({ dryRun: true, replay: true, import: { id: recorded.body.import.id } });
    expect((await upload(oldExport)).body.replayed).toBe(true);

    const edited = await exportedRows();
    edited[2]![3] = "Changed";
    expect((await upload(await xlsx(edited))).body.import.updated).toBe(1);

    // No longer the latest: the dry run and the apply both plan it, and the stale Version 1 is a conflict.
    for (const query of ["?dryRun=true", ""]) {
      const again = await upload(oldExport, query);
      expect(again.status, query).toBe(422);
      expect(again.body.report).toEqual([expect.objectContaining({ id: "mil-a2", level: "conflict" })]);
    }
    expect((await sql.query("SELECT data->>'answer' AS a FROM content_items WHERE id = 'mil-a2'")).rows[0].a).toBe("Changed");
  });

  it("re-importing earlier bytes that still plan cleanly refreshes their receipt and makes it the latest again", async () => {
    const first = await clientSheet(3);
    const second = await clientSheet(4); // adds one row
    const one = await upload(first);
    expect((await upload(second)).status).toBe(201);
    // `first` again is not the latest, so it is planned: the 4th question is no longer listed -> retire, needs confirm.
    const plan = await upload(first, "?dryRun=true");
    expect(plan.body).toMatchObject({ replay: false, requiresConfirm: true, counts: { retired: 1 } });
    const again = await upload(first, `?confirm=${plan.body.planHash}`);
    expect(again.status).toBe(201);
    expect(again.body.import.id).toBe(one.body.import.id); // same (module, sha256) receipt, refreshed
    expect(await count("content_imports")).toBe(2);
    expect((await upload(first, "?dryRun=true")).body).toMatchObject({ replay: true });
    expect(await count("admin_audit")).toBe(3);
  });

  it("an Id-column file may not reuse another question's file name, blank one, or jump ahead in ids", async () => {
    await upload(await clientSheet(3));
    const rows = await exportedRows();
    rows[2]![7] = rows[1]![7]!; // mil-a2 takes mil-a1's file name
    const clash = await upload(await xlsx(rows));
    expect(clash.status).toBe(422);
    expect(clash.body.report).toEqual([expect.objectContaining({ row: 3, id: "mil-a2", level: "error", message: expect.stringContaining("already used by mil-a1") })]);

    const blank = await exportedRows();
    blank[3]![7] = null;
    const blankReport = (await upload(await xlsx(blank))).body.report as { level: string }[];
    expect(blankReport.filter((r) => r.level === "error")).toEqual([expect.objectContaining({ row: 4, id: "mil-a3", message: expect.stringContaining("File name is empty") })]);

    const jump = await exportedRows();
    jump.push(["mil-a900", null, ...clientRow(9)]);
    const far = await upload(await xlsx(jump));
    expect(far.status).toBe(422);
    expect(far.body.report).toEqual([expect.objectContaining({ id: "mil-a900", message: expect.stringContaining("continue the existing sequence") })]);
    expect(await count("content_items")).toBe(3);
  });

  it("rows absent from a later file are left alone (no deletes), and new rows can be added", async () => {
    await upload(await clientSheet(5));
    const rows = await exportedRows();
    const partial = await xlsx([rows[0]!, rows[1]!, [...["mil-a6", null], ...clientRow(6)]]);
    const res = await upload(partial);
    expect(res.status).toBe(201);
    expect(res.body.import).toMatchObject({ created: 1, updated: 0, unchanged: 1 });
    expect(await count("content_items")).toBe(6);
  });

  it("a Version for an id that does not exist is a conflict", async () => {
    const res = await upload(await xlsx([["Id", "Version", ...CLIENT_HEADER], ["mil-a1", 1, ...clientRow(1)]]));
    expect(res.status).toBe(422);
    expect(res.body.report[0]).toMatchObject({ level: "conflict", id: "mil-a1" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The client's own sheet (no Id column) is authoritative. These are the rules the user ruled on 2026-10-28.

/** The sheet's data row n is rows[n + 2]; Correct Answer is column 1. */
const answerOf = (n: number) => (rows: TestCell[][]) => {
  rows[n + 2]![1] = `Edited ${n}`;
};
/** A different byte stream with the same parsed content, so it is not an idempotent replay. */
const reshaped = (count: number, edit?: (rows: TestCell[][]) => void) =>
  clientSheet(count, (rows) => {
    rows[rows.length - 1] = ["First Officer", null, null, null, null, null, null]; // the Level-only placeholder
    edit?.(rows);
  });

type Row = { id: string; status: string; version: number; source: string; data: { answer: string } };
async function itemMap(): Promise<Map<string, Row>> {
  const list = await request(server).get(ITEMS).set(staff);
  return new Map((list.body.items as Row[]).map((i) => [i.id, i]));
}
const planOf = async (bytes: Buffer) => (await upload(bytes, "?dryRun=true")).body;

describe("client sheet is authoritative", () => {
  it("first import into an empty module: ids by row order, source client_sheet, no confirm", async () => {
    const res = await upload(await clientSheet(5));
    expect(res.status).toBe(201);
    const items = await itemMap();
    expect([...items.keys()]).toEqual(["mil-a1", "mil-a2", "mil-a3", "mil-a4", "mil-a5"]);
    expect(items.get("mil-a3")).toMatchObject({ status: "approved", version: 1, source: "client_sheet", data: { answer: "Aircraft 3" } });
  });

  it("re-importing the original sheet shape is all unchanged: no confirm, no updates, no retirements", async () => {
    await upload(await clientSheet(31));
    const bytes = await reshaped(31);
    const plan = await planOf(bytes);
    expect(plan.counts).toEqual({ created: 0, updated: 0, unchanged: 31, retired: 0 });
    expect(plan.requiresConfirm).toBe(false);
    const res = await upload(bytes);
    expect(res.status).toBe(201);
    expect(res.body.import).toMatchObject({ created: 0, updated: 0, unchanged: 31, retired: 0 });
    expect((await sql.query("SELECT COUNT(*)::int AS n FROM content_items WHERE version = 1 AND status = 'approved'")).rows[0].n).toBe(31);
  });

  it("a row inserted mid-sheet keeps every existing id; the new row takes the next free id", async () => {
    await upload(await clientSheet(5));
    const bytes = await clientSheet(5, (rows) => {
      rows.splice(5, 0, clientRow(99)); // between data rows 2 and 3
    });
    const plan = await planOf(bytes);
    expect(plan.counts).toEqual({ created: 1, updated: 0, unchanged: 5, retired: 0 });
    expect(plan.requiresConfirm).toBe(false);
    expect(plan.rows.map((r: { id: string }) => r.id)).toEqual(["mil-a1", "mil-a2", "mil-a6", "mil-a3", "mil-a4", "mil-a5"]);
    expect((await upload(bytes)).status).toBe(201); // creates only: no confirm
    const items = await itemMap();
    expect(items.get("mil-a3")?.data.answer).toBe("Aircraft 3");
    expect(items.get("mil-a6")?.data.answer).toBe("Aircraft 99");
    expect(items.get("mil-a3")?.version).toBe(1);
  });

  it("a changed answer shows a field diff and needs the dry run's confirm; apply writes version 2 with source client_sheet", async () => {
    await upload(await clientSheet(5));
    const bytes = await clientSheet(5, answerOf(2));
    const plan = await planOf(bytes);
    expect(plan.counts).toEqual({ created: 0, updated: 1, unchanged: 4, retired: 0 });
    expect(plan.requiresConfirm).toBe(true);
    expect(plan.rows.find((r: { id: string }) => r.id === "mil-a2")).toEqual({
      row: 5,
      id: "mil-a2",
      action: "update",
      diff: [{ field: "answer", from: "Aircraft 2", to: "Edited 2" }],
    });

    // No confirm: 422 saying a dry run is required; nothing written, nothing stored.
    const before = blobs.size;
    const missing = await upload(bytes);
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe("import_invalid");
    expect(missing.body.error.message).toContain("dryRun=true");
    expect(blobs.size).toBe(before);
    expect(await count("content_imports")).toBe(1);
    expect((await itemMap()).get("mil-a2")?.data.answer).toBe("Aircraft 2");

    const res = await upload(bytes, `?confirm=${plan.planHash}`);
    expect(res.status).toBe(201);
    expect(res.body.import).toMatchObject({ created: 0, updated: 1, unchanged: 4, retired: 0 });
    expect((await itemMap()).get("mil-a2")).toMatchObject({ version: 2, source: "client_sheet", data: { answer: "Edited 2" } });
    expect((await sql.query("SELECT updated_by FROM content_items WHERE id = 'mil-a2'")).rows[0].updated_by).toBe(STAFF_PRINCIPAL);
    const audit = (await sql.query("SELECT detail FROM admin_audit ORDER BY id DESC LIMIT 1")).rows[0].detail;
    expect(audit).toMatchObject({ kind: "client_sheet", updated: 1, updatedIds: ["mil-a2"], retiredIds: [] });
  });

  it("a rank change is an update too, with the rank in the diff", async () => {
    await upload(await clientSheet(3));
    const bytes = await clientSheet(3, (rows) => {
      rows[3]![0] = "Chief Pilot"; // data row 1 was Trainee
    });
    const plan = await planOf(bytes);
    expect(plan.rows[0]).toMatchObject({ id: "mil-a1", action: "update", diff: [{ field: "rank", from: "trainee", to: "chief-pilot" }] });
  });

  it("a stale or foreign confirm is 409 plan_changed and writes nothing", async () => {
    await upload(await clientSheet(5));
    const editA = await clientSheet(5, answerOf(2));
    const editB = await clientSheet(5, answerOf(3));
    const planA = await planOf(editA);
    const planB = await planOf(editB);

    // A hash from another file's dry run does not authorise this file.
    const foreign = await upload(editA, `?confirm=${planB.planHash}`);
    expect(foreign.status).toBe(409);
    expect(foreign.body.error.code).toBe("plan_changed");
    // Nor does a made-up one.
    expect((await upload(editA, `?confirm=${"0".repeat(64)}`)).status).toBe(409);
    expect(await count("content_imports")).toBe(1);

    // Data changes after the dry run: B is applied first, so A's reviewed plan is stale (mil-a3 moved on).
    expect((await upload(editB, `?confirm=${planB.planHash}`)).status).toBe(201);
    const stale = await upload(editA, `?confirm=${planA.planHash}`);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("plan_changed");
    expect(stale.body.error.requestId).toBeTruthy();
    const items = await itemMap();
    expect(items.get("mil-a2")?.data.answer).toBe("Aircraft 2");
    expect(items.get("mil-a3")?.data.answer).toBe("Edited 3");
    expect(await count("content_imports")).toBe(2);

    // A fresh dry run of the same file gives a hash that works.
    const fresh = await planOf(editA);
    expect(fresh.planHash).not.toBe(planA.planHash);
    expect((await upload(editA, `?confirm=${fresh.planHash}`)).status).toBe(201);
  });

  it("retires rows the file no longer lists, then brings them back as approved when they reappear", async () => {
    await upload(await clientSheet(5));
    const fewer = await clientSheet(3);
    const plan = await planOf(fewer);
    expect(plan.counts).toEqual({ created: 0, updated: 0, unchanged: 3, retired: 2 });
    expect(plan.retirements).toEqual([
      { id: "mil-a4", naturalKey: "MA_test_4.jpg" },
      { id: "mil-a5", naturalKey: "MA_test_5.jpg" },
    ]);
    expect(plan.requiresConfirm).toBe(true);
    expect((await upload(fewer)).status).toBe(422);

    const retired = await upload(fewer, `?confirm=${plan.planHash}`);
    expect(retired.status).toBe(201);
    expect(retired.body.import).toMatchObject({ created: 0, updated: 0, unchanged: 3, retired: 2 });
    let items = await itemMap();
    expect(items.get("mil-a4")).toMatchObject({ status: "retired", version: 2, source: "client_sheet" });
    expect(items.get("mil-a5")).toMatchObject({ status: "retired", version: 2 });
    expect(items.get("mil-a1")).toMatchObject({ status: "approved", version: 1 });
    expect(items.size).toBe(5); // retired rows stay in the list, they are not deleted
    const audit = (await sql.query("SELECT detail FROM admin_audit ORDER BY id DESC LIMIT 1")).rows[0].detail;
    expect(audit.retiredIds).toEqual(["mil-a4", "mil-a5"]);

    // The export carries them with a Status column.
    const rows = await exportedRows();
    expect(rows.slice(1).map((r) => [r[0], r[9]])).toEqual([
      ["mil-a1", "approved"],
      ["mil-a2", "approved"],
      ["mil-a3", "approved"],
      ["mil-a4", "retired"],
      ["mil-a5", "retired"],
    ]);

    // A retired question that is not listed again is left alone (not retired a second time).
    const again = await planOf(await reshaped(3));
    expect(again.counts).toEqual({ created: 0, updated: 0, unchanged: 3, retired: 0 });

    // Listed again: back to approved, version + 1, even though its content is unchanged.
    const back = await reshaped(5);
    const backPlan = await planOf(back);
    expect(backPlan.counts).toEqual({ created: 0, updated: 2, unchanged: 3, retired: 0 });
    expect(backPlan.rows.find((r: { id: string }) => r.id === "mil-a4").diff).toEqual([{ field: "status", from: "retired", to: "approved" }]);
    expect((await upload(back)).status).toBe(422);
    expect((await upload(back, `?confirm=${backPlan.planHash}`)).status).toBe(201);
    items = await itemMap();
    expect(items.get("mil-a4")).toMatchObject({ status: "approved", version: 3, source: "client_sheet" });
    expect(items.get("mil-a5")).toMatchObject({ status: "approved", version: 3 });
  });

  it("an admin-export import never retires anything and ignores the Status column", async () => {
    await upload(await clientSheet(5));
    const rows = await exportedRows();
    // Keep only the header and the first three rows, and claim Status "retired" on a kept row.
    const partial = [rows[0]!, rows[1]!, rows[2]!, rows[3]!];
    partial[1]![9] = "retired";
    const plan = await planOf(await xlsx(partial));
    expect(plan.kind).toBe("admin_export");
    expect(plan.counts).toEqual({ created: 0, updated: 0, unchanged: 3, retired: 0 });
    expect(plan.retirements).toEqual([]);
    expect(plan.requiresConfirm).toBe(false);
    const res = await upload(await xlsx(partial));
    expect(res.status).toBe(201);
    const items = await itemMap();
    expect([...items.values()].every((i) => i.status === "approved" && i.version === 1)).toBe(true);
  });

  it("admin-export creates and updates are source admin and need no confirm (the Version check guards them)", async () => {
    await upload(await clientSheet(3));
    const rows = await exportedRows();
    rows[1]![3] = "Admin Edit";
    rows.push(["mil-a4", null, ...clientRow(9), null]);
    const bytes = await xlsx(rows);
    const plan = await planOf(bytes);
    expect(plan.counts).toEqual({ created: 1, updated: 1, unchanged: 2, retired: 0 });
    expect(plan.requiresConfirm).toBe(false);
    expect(plan.rows[0].diff).toEqual([{ field: "answer", from: "Aircraft 1", to: "Admin Edit" }]);
    expect((await upload(bytes)).status).toBe(201);
    const items = await itemMap();
    expect(items.get("mil-a1")).toMatchObject({ source: "admin", version: 2 });
    expect(items.get("mil-a4")).toMatchObject({ source: "admin", version: 1, status: "approved" });
  });

  it("a missing or repeated file name is a row error into an EMPTY module too (user, 2026-10-28)", async () => {
    const repeated = await clientSheet(3, (rows) => {
      rows[5]![5] = "MA_test_1.jpg";
    });
    const blank = await clientSheet(3, (rows) => {
      rows[4]![5] = null;
    });
    for (const bytes of [repeated, blank]) {
      for (const query of ["", "?dryRun=true"]) {
        const res = await upload(bytes, query);
        expect(res.status, query).toBe(422);
        expect(res.body.error.code).toBe("import_invalid");
        expect(res.body.report.filter((r: { level: string }) => r.level === "error")).toHaveLength(1);
      }
    }
    expect(await count("content_items")).toBe(0);
    expect(await count("content_imports")).toBe(0);
  });

  it("a missing or repeated file name is a row error when the module already has questions", async () => {
    await upload(await clientSheet(3));
    const repeated = await clientSheet(3, (rows) => {
      rows[5]![5] = "MA_test_1.jpg"; // data row 3 reuses data row 1's file name
    });
    for (const query of ["", "?dryRun=true"]) {
      const res = await upload(repeated, query);
      expect(res.status, query).toBe(422);
      expect(res.body.error.code).toBe("import_invalid");
      expect(res.body.report.filter((r: { level: string }) => r.level === "error")).toEqual([
        expect.objectContaining({ row: 6, level: "error", message: expect.stringContaining('"MA_test_1.jpg" is repeated (first used on row 4)') }),
      ]);
    }
    const blank = await clientSheet(3, (rows) => {
      rows[4]![5] = null;
    });
    const res = await upload(blank);
    expect(res.status).toBe(422);
    expect(res.body.report.filter((r: { level: string }) => r.level === "error")).toEqual([
      expect.objectContaining({ row: 5, message: expect.stringContaining("File name is empty") }),
    ]);
    expect(await count("content_imports")).toBe(1);
    expect(await count("admin_audit")).toBe(1);
  });

  it("identical bytes replay before any confirm is asked for", async () => {
    await upload(await clientSheet(3));
    const bytes = await clientSheet(3, answerOf(1));
    const plan = await planOf(bytes);
    expect((await upload(bytes, `?confirm=${plan.planHash}`)).status).toBe(201);
    const again = await upload(bytes); // no confirm, but it is the same bytes
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect((await itemMap()).get("mil-a1")?.version).toBe(2); // not applied twice
  });

  it("the audit row and the item list say what happened; no email is stored", async () => {
    await upload(await clientSheet(3));
    const bytes = await clientSheet(2, answerOf(1));
    const plan = await planOf(bytes);
    await upload(bytes, `?confirm=${plan.planHash}`);
    const everything = JSON.stringify([
      (await sql.query("SELECT * FROM content_items")).rows,
      (await sql.query("SELECT * FROM admin_audit")).rows,
    ]);
    expect(everything).not.toContain("@");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The 5 MB body is read only after the token and staff rule have passed.

/** POST headers plus the start of a body that never ends; resolves with the response status. */
function unfinishedUpload(headers: Record<string, string>): Promise<number> {
  const { port } = (server as { address(): AddressInfo }).address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: IMPORTS, headers: { ...headers, "Content-Type": XLSX_MIME, "Content-Length": String(50 * 1024 * 1024) } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      },
    );
    req.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
    req.write(Buffer.alloc(1024)); // headers go out; the other 50 MB never does
  });
}

describe("auth before the upload body", () => {
  it("a junk token is 401 while the body is still unsent: it is never read", async () => {
    expect(await unfinishedUpload({ Authorization: "Bearer junk" })).toBe(401);
  });

  it("a valid token that is not staff is 403 before the body is read", async () => {
    expect(await unfinishedUpload(bearer(emulatorToken(`uid-${randomUUID()}`)))).toBe(403);
  });

  it("an oversized body from a junk token is 401 (with WWW-Authenticate), not 413", async () => {
    const res = await request(server)
      .post(IMPORTS)
      .set({ Authorization: "Bearer junk" })
      .set("Content-Type", XLSX_MIME)
      .send(Buffer.alloc(6 * 1024 * 1024))
      .catch((e: Error) => e);
    if (res instanceof Error) return; // the server may close the socket before the client finishes sending
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
  });

  it("staff still gets the 413 for an oversized body", async () => {
    const res = await upload(Buffer.alloc(6 * 1024 * 1024)).catch((e: Error) => e);
    if (!(res instanceof Error)) expect(res.status).toBe(413);
  });
});
