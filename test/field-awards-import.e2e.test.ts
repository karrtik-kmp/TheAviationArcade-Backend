import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { resetDocumentMemo } from "../src/content/documents/document-store.js";
import { XLSX_MIME, readFirstSheet } from "../src/content/xlsx.js";
import { BLOB_STORE } from "../src/storage/blob-store.js";
import { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import type { TestCell } from "./fixtures.js";
import { xlsx } from "./fixtures.js";
import { emulatorToken } from "./tokens.js";

// Slice A2: re-importing a later Field Awards sheet through plan, confirm and apply into the field-awards DRAFT.
// The real Nest app against the real test database; the client's real sheet is the baseline.

const BASE = "/v1/admin/content/documents";
const IMPORTS = `${BASE}/field-awards/imports`;
const MANIFEST = "/v1/content/manifest";
const PREFIX = "firebase:demo-airplane-games:";
const STAFF_PRINCIPAL = `${PREFIX}staff`;

const SHEET_CANDIDATES = ["../../../docs/Field Awards #1.xlsx", "../../docs/Field Awards #1.xlsx", "../docs/Field Awards #1.xlsx"].map((p) => path.resolve(import.meta.dirname, p));
const SHEET_PATH = SHEET_CANDIDATES.find((p) => existsSync(p));
if (!SHEET_PATH) throw new Error(`The client's Field Awards #1.xlsx was not found in: ${SHEET_CANDIDATES.join(", ")}`);
const REAL_SHEET = readFileSync(SHEET_PATH);

const staff: Record<string, string> = { Authorization: `Bearer ${emulatorToken("staff")}`, "X-Client": "web" };
const otherStaff = { Authorization: `Bearer ${emulatorToken("second", undefined, undefined, { email: "other.staff@sites.test" })}` };
const nonStaff = { Authorization: `Bearer ${emulatorToken("player-1")}` };
const unverifiedStaff = { Authorization: `Bearer ${emulatorToken("unverified", undefined, undefined, { email: "staff@sites.test", emailVerified: false })}` };

let sql: pg.Pool;
let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let blobs: MemoryBlobStore;

async function reset() {
  await sql.query("DELETE FROM content_drafts");
  await sql.query("DELETE FROM admin_audit WHERE action = 'content_publish'");
  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE content_documents DISABLE TRIGGER content_documents_immutable");
    await client.query("DELETE FROM content_documents WHERE version > 1 AND name <> 'clipper-cards'");
    await client.query("ALTER TABLE content_documents ENABLE TRIGGER content_documents_immutable");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  resetDocumentMemo();
  blobs.clear();
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  blobs = app.get<MemoryBlobStore>(BLOB_STORE);
  await reset();
});
afterEach(reset);
afterAll(async () => {
  await app.close();
  await sql.end();
});

const upload = (bytes: Buffer, query = "", headers: Record<string, string> = staff) =>
  request(server).post(`${IMPORTS}${query}`).set(headers).set("Content-Type", XLSX_MIME).send(bytes);
const dry = (bytes: Buffer, headers = staff) => upload(bytes, "?dryRun=true", headers);
const draft = () => request(server).get(`${BASE}/field-awards/draft`).set(staff);
const editAward = (draftVersion: number, award: Record<string, unknown>, h = staff) =>
  request(server).patch(`${BASE}/field-awards/draft`).set(h).send({ draftVersion, awards: [award] });
const publish = (draftVersion: number) => request(server).post(`${BASE}/field-awards/publish`).set(staff).send({ draftVersion });
const rows = async <T = Record<string, any>>(query: string, params: unknown[] = []) => (await sql.query(query, params)).rows as T[];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const manifestEntry = async () => {
  const res = await request(server).get(MANIFEST).set({ Authorization: `Bearer ${emulatorToken(`uid-${randomUUID()}`)}` });
  return res.body.documents.find((d: { name: string }) => d.name === "field-awards");
};

/** The client's real sheet as rows, edited, and written again with the repo's xlsx writer. */
async function modifiedSheet(edit: (rows: TestCell[][]) => TestCell[][] | void): Promise<Buffer> {
  const original = (await readFirstSheet(REAL_SHEET)) as TestCell[][];
  const copy = original.map((r) => [...r]);
  return xlsx(edit(copy) ?? copy);
}
const rowOf = (all: TestCell[][], name: string) => {
  const row = all.find((r) => r[0] === name);
  if (!row) throw new Error(`no row ${name}`);
  return row;
};

/** A modified copy that changes three awards in the three importable fields. */
const EDITED = (all: TestCell[][]) => {
  rowOf(all, "Logbook 100")[1] = "Complete 150 Flights, counted across completed Trips.";
  rowOf(all, "Logbook 100")[2] = "150 Flights";
  rowOf(all, "High Flyer")[2] = "250,000 Miles";
  rowOf(all, "Regional")[0] = "REGIONAL"; // the same award, written differently
};
const EXPECTED = [
  {
    id: "century",
    changes: [
      { field: "criteria", from: "Complete 100 Flights, counted across completed Trips. Correct answers are not required for every Flight.", to: "Complete 150 Flights, counted across completed Trips." },
      { field: "target", from: 100, to: 150 },
    ],
  },
  { id: "high-flyer", changes: [{ field: "target", from: 100000, to: 250000 }] },
  { id: "regional", changes: [{ field: "title", from: "Regional", to: "REGIONAL" }] },
];

const noWrites = async () => {
  expect((await rows("SELECT COUNT(*)::int AS n FROM content_drafts"))[0]!["n"]).toBe(0);
  expect(blobs.size).toBe(0);
};

describe("staff only", () => {
  it("401 without a token or with a junk one; 403 for a player, an unverified staff address and no email; nothing is written", async () => {
    const noEmail = { Authorization: `Bearer ${emulatorToken("noemail", undefined, undefined, { email: null })}` };
    for (const query of ["", "?dryRun=true"]) {
      const none = await request(server).post(`${IMPORTS}${query}`).set("Content-Type", XLSX_MIME).send(REAL_SHEET);
      expect(none.status).toBe(401);
      expect(none.body.error.code).toBe("unauthorized");
      expect((await upload(REAL_SHEET, query, { Authorization: "Bearer junk" })).status).toBe(401);
      for (const who of [nonStaff, unverifiedStaff, noEmail]) {
        const res = await upload(REAL_SHEET, query, who);
        expect(res.status, query).toBe(403);
        expect(res.body.error.code).toBe("forbidden");
      }
    }
    await noWrites();
  });
});

describe("the client's real sheet", () => {
  it("a dry run on a fresh database plans zero changes (the seeded v1 came from this sheet)", async () => {
    const res = await dry(REAL_SHEET);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({
      dryRun: true,
      publishedVersion: 1,
      draftVersion: 0,
      requiresConfirm: false,
      awards: [],
      counts: { rows: 28, awardsChanged: 0, awardsUnchanged: 28, fieldChanges: 0 },
    });
    expect(res.body.planHash).toMatch(/^[0-9a-f]{64}$/);
    await noWrites();
  });

  it("applying it changes nothing: 200 applied false, no draft revision, no stored file", async () => {
    const res = await upload(REAL_SHEET);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ applied: false, draftVersion: 0, awards: [] });
    expect(res.body.file).toBeUndefined();
    await noWrites();
  });
});

describe("a modified copy: plan, confirm, apply, publish", () => {
  it("plans the expected diffs and writes nothing on a dry run", async () => {
    const res = await dry(await modifiedSheet(EDITED));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.awards).toEqual(EXPECTED);
    expect(res.body).toMatchObject({ requiresConfirm: true, counts: { rows: 28, awardsChanged: 3, awardsUnchanged: 25, fieldChanges: 4 } });
    // The same file again gives the same hash.
    expect((await dry(await modifiedSheet(EDITED))).body.planHash).toBe(res.body.planHash);
    await noWrites();
  });

  it("apply needs the dry run's hash: missing is 422 import_invalid, a wrong one is 409 plan_changed, and neither writes", async () => {
    const bytes = await modifiedSheet(EDITED);
    const missing = await upload(bytes);
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe("import_invalid");
    const wrong = await upload(bytes, `?confirm=${"0".repeat(64)}`);
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe("plan_changed");
    expect((await upload(bytes, "?confirm=nothex")).status).toBe(400);
    expect((await upload(bytes, `?dryRun=true&confirm=${"0".repeat(64)}`)).status).toBe(400);
    await noWrites();
  });

  it("confirm writes the draft (revision, history with principal, import and file digest), keeps the file, and changes nothing for players until a publish", async () => {
    const bytes = await modifiedSheet(EDITED);
    const planned = await dry(bytes);
    const before = { manifest: await manifestEntry() };
    const applied = await upload(bytes, `?confirm=${planned.body.planHash}`);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect(applied.body).toMatchObject({ applied: true, draftVersion: 1, publishedVersion: 1, awards: EXPECTED });
    expect(applied.body.file).toEqual({ fileName: "import.xlsx", sha256: sha(bytes), byteSize: bytes.length, blobKey: `imports/field-awards/${sha(bytes)}.xlsx` });

    // The original upload is kept, content-addressed.
    expect(blobs.size).toBe(1);
    expect(Buffer.from((await blobs.get(applied.body.file.blobKey))!).equals(bytes)).toBe(true);

    // The draft: the overlay holds the changed fields, the history names the principal, "import" and the digest.
    const read = await draft();
    expect(read.body.draftVersion).toBe(1);
    expect(read.body.edits.awards).toEqual({
      century: { criteria: "Complete 150 Flights, counted across completed Trips.", target: 150 },
      "high-flyer": { target: 250000 },
      regional: { title: "REGIONAL" },
    });
    expect(read.body.edits.history).toEqual([{ principal: STAFF_PRINCIPAL, action: "import", at: expect.any(String), draftVersion: 1, fileSha256: sha(bytes) }]);
    expect(read.body.changeCount).toBe(4);
    expect((await rows("SELECT updated_by FROM content_drafts WHERE name = 'field-awards'"))[0]).toEqual({ updated_by: STAFF_PRINCIPAL });

    // Nothing reached players.
    expect(await manifestEntry()).toEqual(before.manifest);
    expect((await rows("SELECT COUNT(*)::int AS n FROM content_documents WHERE name = 'field-awards'"))[0]!["n"]).toBe(1);

    // The same sheet now plans nothing (the draft already holds it); applying it again is a no-op.
    const again = await dry(bytes);
    expect(again.body).toMatchObject({ awards: [], requiresConfirm: false, draftVersion: 1 });
    expect((await upload(bytes)).body).toMatchObject({ applied: false, draftVersion: 1 });
    expect((await draft()).body.draftVersion).toBe(1);
  });

  it("then the ordinary publish serves it: the manifest version changes and the Logbook targets move; the audit row keeps the import", async () => {
    const bytes = await modifiedSheet(EDITED);
    const uid = `uid-${randomUUID()}`;
    const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
    expect((await request(server).put("/v1/me").set(auth)).status).toBe(201);
    const logbook = () => request(server).get("/v1/me/logbook").set(auth);
    const before = { entry: await manifestEntry(), lb: await logbook() };
    expect(before.lb.body.logbook.fieldAwards.awards.find((a: { id: string }) => a.id === "century").target).toBe(100);

    const planned = await dry(bytes);
    const applied = await upload(bytes, `?confirm=${planned.body.planHash}`);
    expect(applied.status).toBe(201);
    const published = await publish(applied.body.draftVersion);
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(published.body).toMatchObject({ name: "field-awards", version: 2, previousVersion: 1, changeCount: 4 });

    const entry = await manifestEntry();
    expect(entry.version).toBe(2);
    expect(entry.sha256).not.toBe(before.entry.sha256);
    const served = await request(server).get("/v1/content/documents/field-awards/2").set(auth);
    const award = (id: string) => served.body.awards.find((a: { id: string }) => a.id === id);
    expect(award("century")).toMatchObject({ target: 150, criteria: "Complete 150 Flights, counted across completed Trips." });
    expect(award("high-flyer").target).toBe(250000);
    expect(award("regional").title).toBe("REGIONAL");
    expect(award("regional")).toMatchObject({ thresholdCell: "5 Regional Cards", target: 5 });

    const lb = await logbook();
    expect(lb.body.logbook.fieldAwards.catalogVersion).toBe(2);
    expect(lb.body.logbook.fieldAwards.awards.find((a: { id: string }) => a.id === "century").target).toBe(150);

    const audit = (await rows("SELECT detail FROM admin_audit WHERE action = 'content_publish'"))[0]!["detail"];
    expect(audit.history).toEqual([{ principal: STAFF_PRINCIPAL, action: "import", at: expect.any(String), draftVersion: 1, fileSha256: sha(bytes) }]);
    expect(audit.editors).toEqual([STAFF_PRINCIPAL]);

    // Against the new version in force the same sheet is a no-op.
    expect((await dry(bytes)).body).toMatchObject({ awards: [], publishedVersion: 2, draftVersion: 2 });
  });

  it("a sheet applied on top of a staff draft edit shows the draft value as `from` and the sheet wins", async () => {
    expect((await editAward(0, { id: "high-flyer", target: 120000 })).status).toBe(200);
    const bytes = await modifiedSheet(EDITED);
    const planned = await dry(bytes);
    expect(planned.body.awards.find((a: { id: string }) => a.id === "high-flyer").changes).toEqual([{ field: "target", from: 120000, to: 250000 }]);
    expect(planned.body.draftVersion).toBe(1);
    const applied = await upload(bytes, `?confirm=${planned.body.planHash}`);
    expect(applied.status).toBe(201);
    const read = await draft();
    expect(read.body.draftVersion).toBe(2);
    expect(read.body.edits.awards["high-flyer"]).toEqual({ target: 250000 });
    expect(read.body.edits.history.map((h: { action: string }) => h.action)).toEqual(["edit", "import"]);
  });
});

describe("a stale plan or a concurrent edit never loses work", () => {
  it("an edit between the dry run and the apply makes the confirm stale: 409 plan_changed, the edit stays, nothing else is written", async () => {
    const bytes = await modifiedSheet(EDITED);
    const planned = await dry(bytes);
    expect((await editAward(0, { id: "heavy-metal", target: 6 })).status).toBe(200);
    const res = await upload(bytes, `?confirm=${planned.body.planHash}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("plan_changed");
    expect(blobs.size).toBe(0);
    const read = await draft();
    expect(read.body.draftVersion).toBe(1);
    expect(read.body.edits.awards).toEqual({ "heavy-metal": { target: 6 } });
  });

  it("a publish between the dry run and the apply makes the confirm stale too", async () => {
    const bytes = await modifiedSheet(EDITED);
    const planned = await dry(bytes);
    const edited = await editAward(0, { id: "heavy-metal", target: 6 });
    expect((await publish(edited.body.draftVersion)).status).toBe(201);
    const res = await upload(bytes, `?confirm=${planned.body.planHash}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("plan_changed");
  });

  it("an apply racing a PATCH of the same revision: exactly one lands, and whatever landed is in the draft", async () => {
    const bytes = await modifiedSheet(EDITED);
    for (let round = 0; round < 3; round += 1) {
      await reset();
      const planned = await dry(bytes);
      const [applied, patched] = await Promise.all([
        upload(bytes, `?confirm=${planned.body.planHash}`),
        editAward(0, { id: "heavy-metal", target: 6 }, otherStaff),
      ]);
      const read = await draft();
      expect(read.body.draftVersion).toBe(1);
      if (applied.status === 201) {
        expect(patched.status).toBe(409);
        expect(patched.body.error.code).toBe("version_conflict");
        expect(read.body.edits.awards["high-flyer"]).toEqual({ target: 250000 });
        expect(read.body.edits.awards["heavy-metal"]).toBeUndefined();
      } else {
        expect(applied.status).toBe(409);
        expect(applied.body.error.code).toBe("plan_changed");
        expect(patched.status).toBe(200);
        expect(read.body.edits.awards).toEqual({ "heavy-metal": { target: 6 } });
        // The file may already be stored (content-addressed, harmless, like the content import); the draft is what counts.
      }
    }
  });

  it("two applies of the same confirmed plan at once: one writes, the other is stale or a no-op, never a second revision", async () => {
    const bytes = await modifiedSheet(EDITED);
    const planned = await dry(bytes);
    const [a, b] = await Promise.all([upload(bytes, `?confirm=${planned.body.planHash}`), upload(bytes, `?confirm=${planned.body.planHash}`, otherStaff)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((await draft()).body.draftVersion).toBe(1);
  });
});

describe("errors write nothing", () => {
  const bad: [string, (all: TestCell[][]) => TestCell[][] | void, RegExp][] = [
    ["an award the catalog does not have", (all) => void all.push(["Space Cadet", "Fly to orbit.", "1 Trip"]), /Space Cadet/],
    ["an award missing from the sheet", (all) => all.filter((r) => r[0] !== "Rotorhead"), /Rotorhead is missing/],
    ["a duplicate row", (all) => void all.push([...rowOf(all, "First Solo")]), /listed twice/],
    ["a fractional target", (all) => void (rowOf(all, "Frequent Flyer")[2] = "2.5 Trips"), /whole number/],
    ["a zero target", (all) => void (rowOf(all, "Frequent Flyer")[2] = "0 Trips"), /at least 1/],
    ["a threshold with no number", (all) => void (rowOf(all, "Frequent Flyer")[2] = "Many Trips"), /whole number/],
    ["a blank criteria cell", (all) => void (rowOf(all, "Frequent Flyer")[1] = null), /criteria are missing/],
    ["criteria over the limit", (all) => void (rowOf(all, "Frequent Flyer")[1] = "x".repeat(2001)), /criteria/],
  ];

  it.each(bad)("%s: 422 import_invalid with a row report, on a dry run and on an apply", async (_label, edit, message) => {
    const bytes = await modifiedSheet((all) => {
      EDITED(all);
      return edit(all);
    });
    for (const query of ["?dryRun=true", ""]) {
      const res = await upload(bytes, query);
      expect(res.status, `${query} ${JSON.stringify(res.body)}`).toBe(422);
      expect(res.body.error.code).toBe("import_invalid");
      expect(res.body.report.length).toBeGreaterThan(0);
      expect(res.body.report.every((i: { level: string }) => i.level === "error")).toBe(true);
      expect(res.body.report.map((i: { message: string }) => i.message).join(" | ")).toMatch(message);
    }
    await noWrites();
  });

  it("the report names the sheet row and the award id", async () => {
    const bytes = await modifiedSheet((all) => void (rowOf(all, "High Flyer")[2] = "lots"));
    const res = await dry(bytes);
    expect(res.status).toBe(422);
    const at = (await readFirstSheet(REAL_SHEET)).findIndex((r) => r[0] === "High Flyer") + 1;
    expect(res.body.report).toEqual([{ row: at, id: "high-flyer", level: "error", message: expect.stringContaining("High Flyer") }]);
  });

  it("not an xlsx, an empty body and a sheet without the header are 400", async () => {
    expect((await upload(Buffer.from("not a zip"))).status).toBe(400);
    expect((await request(server).post(IMPORTS).set(staff).set("Content-Type", XLSX_MIME)).status).toBe(400);
    const headless = await xlsx([["Name", "Text"], ["a", "b"]]);
    const res = await dry(headless);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
    expect((await request(server).post(`${IMPORTS}?dryRun=maybe`).set(staff).set("Content-Type", XLSX_MIME).send(REAL_SHEET)).status).toBe(400);
    await noWrites();
  });

  it("a stored draft that does not validate is refused (422 content_invalid) and left alone", async () => {
    await sql.query(
      "INSERT INTO content_drafts (name, version, edits, updated_by) VALUES ('field-awards', 1, $1::jsonb, 'x')",
      [JSON.stringify({ awards: { century: { target: 0 } } })],
    );
    const res = await dry(await modifiedSheet(EDITED));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("content_invalid");
    expect(blobs.size).toBe(0);
  });
});
