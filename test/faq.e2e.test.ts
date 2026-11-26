import { createHash, randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { canonicalBytes } from "../src/content/documents/canonical.js";
import { faqContentSha256 } from "../src/content/documents/faq.js";
import { resetDocumentMemo } from "../src/content/documents/document-store.js";
import { APP_CONFIG, loadConfig } from "../src/config/config.module.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { demoPrincipal, seedAdmins, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";

// docs/plans/faq-cms.md: the FAQ site document. Staff edit by operations on the existing draft routes, publish writes an immutable version,
// GET /v1/public/faq serves it to guests. The real Nest app against the real test database.

const BASE = "/v1/admin/content/documents";
const FAQ = `${BASE}/faq`;
const PUBLIC = "/v1/public/faq";
const PREFIX = "firebase:demo-airplane-games:";
const STAFF_PRINCIPAL = `${PREFIX}faq-staff`;
const staff: Record<string, string> = { Authorization: `Bearer ${emulatorToken("faq-staff")}`, "X-Client": "web" };
const staffTwo: Record<string, string> = { Authorization: `Bearer ${emulatorToken("faq-staff-2")}`, "X-Client": "web" };
const photographerUid = `faq-photo-${randomUUID()}`;
const photographer = { Authorization: `Bearer ${emulatorToken(photographerUid)}` };
const playerUid = `faq-player-${randomUUID()}`;
const player = { Authorization: `Bearer ${emulatorToken(playerUid)}` };

// The shared demo account (config demoPrincipal): the roles guard ignores its admin row (incident 2026-11-04), so staff routes are 403 (F8).
const demoUid = `faq-demo-${randomUUID()}`;
const demo = { Authorization: `Bearer ${emulatorToken(demoUid)}`, "X-Client": "web" };

let sql: pg.Pool;
let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let limited: NestExpressApplication;
let demoApp: NestExpressApplication;

/** Remove every FAQ row, draft and publish audit row this suite (or a crashed earlier run) left in the shared test database. */
async function reset() {
  await sql.query("DELETE FROM content_drafts WHERE name = 'faq'");
  await frozenDelete(sql, "admin_audit", "action IN ('content_publish', 'content_import') AND target = 'faq'");
  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE content_documents DISABLE TRIGGER content_documents_immutable");
    await client.query("DELETE FROM content_documents WHERE name = 'faq'");
    await client.query("ALTER TABLE content_documents ENABLE TRIGGER content_documents_immutable");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  resetDocumentMemo();
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await seedAdmins(sql, "faq-staff", "faq-staff-2");
  await seedRole(sql, demoPrincipal(photographerUid), "photographer");
  await seedRole(sql, demoPrincipal(demoUid), "admin"); // a stray row, as in the incident
  await reset();
  const build = async (overrides: Record<string, unknown> = {}) => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue({ ...loadConfig(process.env), ...overrides })
      .compile();
    const built = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApp(built);
    await built.listen(0, "127.0.0.1");
    return built;
  };
  app = await build();
  server = app.getHttpServer();
  limited = await build({ rateLimitStore: "memory", rateLimitPublicPerMin: 3, rateLimitAuthPerMin: 1000 });
  demoApp = await build({ demoPrincipal: demoPrincipal(demoUid) });
});

afterEach(reset);

afterAll(async () => {
  await reset();
  await sql.query("DELETE FROM account_roles WHERE principal = ANY($1)", [[STAFF_PRINCIPAL, `${PREFIX}faq-staff-2`, demoPrincipal(photographerUid), demoPrincipal(demoUid)]]);
  await frozenDelete(sql, "admin_audit", "actor = ANY($1)", [[STAFF_PRINCIPAL, `${PREFIX}faq-staff-2`]]);
  await Promise.all([app.close(), limited.close(), demoApp.close()]);
  await sql.end();
});

const draft = (h = staff) => request(server).get(`${FAQ}/draft`).set(h);
const patch = (body: unknown, h = staff) => request(server).patch(`${FAQ}/draft`).set(h).send(body as object);
const discard = (draftVersion: number, h = staff) => request(server).post(`${FAQ}/draft/discard`).set(h).send({ draftVersion });
const publish = (body: unknown, h = staff) => request(server).post(`${FAQ}/publish`).set(h).send(body as object);
const guest = (headers: Record<string, string> = {}) => request(server).get(PUBLIC).set(headers);
const rows = async <T = Record<string, any>>(query: string, params: unknown[] = []) => (await sql.query(query, params)).rows as T[];
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const cat = (id: string, title = `Title ${id}`) => ({ op: "upsertCategory", id, title });
const ent = (categoryId: string, id: string, extra: Record<string, unknown> = {}) => ({ op: "upsertEntry", categoryId, id, question: `Question ${id}?`, answer: `Answer ${id}.`, ...extra });

/** Edit at `draftVersion` and return the response; asserts 200. */
async function edit(draftVersion: number, ...operations: unknown[]) {
  const res = await patch({ draftVersion, operations });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { draftVersion: number; changed: boolean; changeCount: number; changes: any[]; edits: any; publishedVersion: number | null };
}

/** One category with one entry, published; returns the publish response body. */
async function publishFirst(note?: string) {
  const v = await edit(0, cat("general"), ent("general", "what-is-it"));
  const res = await publish({ draftVersion: v.draftVersion, ...(note ? { note } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe("staff draft: the first draft starts from the empty base (F4)", () => {
  it("reads as an empty faq.v1 before anything exists", async () => {
    const res = await draft();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "faq", publishedVersion: null, draftVersion: 0, changed: false, changeCount: 0, changes: [], edits: {} });
    expect(res.body.body).toEqual({ format: "faq.v1", version: 1, categories: [] });
  });

  it("the first PATCH needs no seed and returns the view with the working body in edits.faq", async () => {
    const v = await edit(0, cat("general", "General"), ent("general", "e1"));
    expect(v).toMatchObject({ draftVersion: 1, changed: true, publishedVersion: null });
    expect(v.edits.faq).toEqual({ format: "faq.v1", categories: [{ id: "general", title: "General", entries: [{ id: "e1", question: "Question e1?", answer: "Answer e1." }] }] });
    expect(v.edits.history).toHaveLength(1);
    expect(v.changes.map((c) => c.kind)).toEqual(["category-added", "entry-added"]);
    const read = await draft();
    expect(read.body.body).toMatchObject({ format: "faq.v1", version: 1, categories: [{ id: "general" }] });
  });

  it("is admin only: no token 401, a player and a photographer 403 on every staff route", async () => {
    const body = { draftVersion: 0, operations: [cat("a")] };
    expect((await request(server).get(`${FAQ}/draft`)).status).toBe(401);
    for (const h of [player, photographer]) {
      expect((await draft(h)).status).toBe(403);
      expect((await patch(body, h)).status).toBe(403);
      expect((await discard(0, h)).status).toBe(403);
      expect((await publish({ draftVersion: 0 }, h)).status).toBe(403);
    }
    expect(await rows("SELECT 1 FROM content_drafts WHERE name = 'faq'")).toHaveLength(0);
  });

  it("the shared demo account is 403 on read, PATCH, discard and publish, whatever its role rows say (F8)", async () => {
    const via = (build: (s: ReturnType<NestExpressApplication["getHttpServer"]>) => request.Test) => build(demoApp.getHttpServer());
    expect((await via((s) => request(s).get(`${FAQ}/draft`).set(demo))).status).toBe(403);
    const edited = await via((s) => request(s).patch(`${FAQ}/draft`).set(demo).send({ draftVersion: 0, operations: [cat("a")] }));
    expect(edited.status).toBe(403);
    expect(edited.body.error.code).toBe("forbidden");
    expect((await via((s) => request(s).post(`${FAQ}/draft/discard`).set(demo).send({ draftVersion: 0 }))).status).toBe(403);
    const published = await via((s) => request(s).post(`${FAQ}/publish`).set(demo).send({ draftVersion: 0 }));
    expect(published.status).toBe(403);
    expect(published.body.error.code).toBe("forbidden");
    expect(await rows("SELECT 1 FROM content_drafts WHERE name = 'faq'")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM content_documents WHERE name = 'faq'")).toHaveLength(0);
  });

  it("an unknown document name is still 404", async () => {
    expect((await request(server).get(`${BASE}/nope/draft`).set(staff)).status).toBe(404);
  });
});

describe("PATCH by operations (F5)", () => {
  it("refuses a bad shape with 400 invalid_request and writes nothing", async () => {
    const bad: unknown[] = [
      { draftVersion: 0 },
      { draftVersion: 0, operations: [] },
      { draftVersion: 0, operations: Array(26).fill(cat("a")) },
      { draftVersion: 0, operations: [{ op: "explode", id: "a" }] },
      { draftVersion: 0, operations: [{ ...cat("a"), extra: 1 }] },
      { draftVersion: 0, operations: [cat("Bad Id")] },
      { draftVersion: 0, operations: [cat("a", "tab\there")] },
      { draftVersion: 0, operations: [cat("a", "two\nlines")] },
      { draftVersion: 0, operations: [cat("a", "x".repeat(81))] },
      { draftVersion: 0, operations: [ent("a", "e", { question: "two\nlines" })] },
      { draftVersion: 0, operations: [ent("a", "e", { answer: "bell\u0007" })] },
      { draftVersion: 0, operations: [ent("a", "e", { answer: "nul\u0000" })] },
      { draftVersion: 0, operations: [ent("a", "e", { answer: "x".repeat(2001) })] },
      { draftVersion: 0, operations: [ent("a", "e", { answer: "" })] },
      { draftVersion: 0, operations: [{ op: "moveCategory", id: "a", position: 30 }] },
      { draftVersion: 0, operations: [{ op: "moveEntry", id: "e", categoryId: "a", position: 300 }] },
      { draftVersion: 0, operations: [cat("a", "line\u2028separator")] },
      { draftVersion: 0, operations: [cat("a", "para\u2029separator")] },
      { draftVersion: 0, operations: [ent("a", "e", { question: "rtl\u202eoverride?" })] },
      { draftVersion: 0, operations: [ent("a", "e", { answer: "isolate\u2066x\u2069" })] },
      { draftVersion: 0, operations: [ent("a", "e", { answer: "mark\u200e" })] },
      { draftVersion: 0, operations: [ent("a", "e", { answer: "mark\u200f" })] },
      { draftVersion: 0, operations: [ent("a", "e", { answer: "letter\u061c" })] },
      { operations: [cat("a")] },
      { draftVersion: 0, awards: [] },
    ];
    for (const body of bad) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    expect(await rows("SELECT 1 FROM content_drafts WHERE name = 'faq'")).toHaveLength(0);
  });

  it("normalises CRLF/CR to LF and trims, keeps blank lines inside an answer", async () => {
    const v = await edit(0, cat("a"), ent("a", "e", { answer: "  one\r\n\r\ntwo\rthree  " }));
    expect(v.edits.faq.categories[0].entries[0].answer).toBe("one\n\ntwo\nthree");
  });

  it("accepts 2000 astral code points in an answer (8000 bytes) and publishes it", async () => {
    const answer = "\u{1F6E9}".repeat(2000);
    const v = await edit(0, cat("a"), ent("a", "e", { answer }));
    expect(v.edits.faq.categories[0].entries[0].answer).toBe(answer);
    const res = await publish({ draftVersion: v.draftVersion });
    expect(res.status).toBe(201);
    expect((await guest()).body.categories[0].entries[0].answer).toBe(answer);
  });

  it("refuses with 422 content_invalid naming the failing operation, and leaves the draft untouched (all or nothing)", async () => {
    const v = await edit(0, cat("a"), ent("a", "e1"));
    const res = await patch({ draftVersion: v.draftVersion, operations: [cat("b"), ent("b", "e2"), { op: "removeEntry", id: "missing" }, cat("c")] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("content_invalid");
    expect(res.body.error.message).toContain("Operation 2");
    const after = await draft();
    expect(after.body.draftVersion).toBe(v.draftVersion);
    expect(after.body.body.categories.map((c: { id: string }) => c.id)).toEqual(["a"]);
  });

  it("each semantic refusal is 422 content_invalid", async () => {
    const v = await edit(0, cat("a"), cat("b"), ent("a", "e1"));
    const refused: unknown[][] = [
      [{ op: "removeCategory", id: "a" }], // not empty
      [{ op: "removeCategory", id: "zz" }],
      [{ op: "moveCategory", id: "a", position: 2 }],
      [ent("b", "e1")], // lives in a: use moveEntry
      [ent("zz", "e9")],
      [{ op: "removeEntry", id: "zz" }],
      [{ op: "moveEntry", id: "e1", categoryId: "b", position: 2 }],
      [{ op: "moveEntry", id: "e1", categoryId: "zz", position: 0 }],
    ];
    for (const operations of refused) {
      const res = await patch({ draftVersion: v.draftVersion, operations });
      expect(res.status, JSON.stringify(operations)).toBe(422);
      expect(res.body.error.code).toBe("content_invalid");
      expect(res.body.error.message).toContain("Operation 0");
    }
  });

  it("applies every operation: rename, move, cross-category move, remove", async () => {
    let v = await edit(0, cat("a"), cat("b"), cat("c"), ent("a", "e1"), ent("a", "e2"), ent("b", "e3"));
    v = await edit(v.draftVersion, { op: "upsertCategory", id: "a", title: "Renamed" }, { op: "moveCategory", id: "c", position: 0 }, { op: "moveEntry", id: "e1", categoryId: "b", position: 0 }, { op: "removeEntry", id: "e2" });
    const body = (await draft()).body.body;
    expect(body.categories.map((c: any) => `${c.id}:${c.title}:${c.entries.map((e: any) => e.id).join(",")}`)).toEqual(["c:Title c:", "a:Renamed:", "b:Title b:e1,e3"]);
    v = await edit(v.draftVersion, { op: "removeCategory", id: "a" }, { op: "removeCategory", id: "c" });
    expect((await draft()).body.body.categories.map((c: { id: string }) => c.id)).toEqual(["b"]);
  });

  it("holds 30 categories and 300 entries, an entry id is unique across categories", async () => {
    let v = await edit(0, ...Array.from({ length: 25 }, (_, i) => cat(`c${i}`)));
    v = await edit(v.draftVersion, ...Array.from({ length: 5 }, (_, i) => cat(`c${25 + i}`)));
    const over = await patch({ draftVersion: v.draftVersion, operations: [cat("c30")] });
    expect(over.status).toBe(422);
    let n = 0;
    for (let batch = 0; batch < 12; batch++) {
      v = await edit(v.draftVersion, ...Array.from({ length: 25 }, () => ent("c0", `e${n++}`)));
    }
    expect(n).toBe(300);
    const more = await patch({ draftVersion: v.draftVersion, operations: [ent("c1", "one-more")] });
    expect(more.status).toBe(422);
    expect(more.body.error.message).toContain("300");
    // The same id in a second category is the move-instead refusal, not a duplicate in the body.
    expect((await patch({ draftVersion: v.draftVersion, operations: [ent("c1", "e0")] })).status).toBe(422);
  });

  it("a stale draftVersion is 409 version_conflict; two PATCHes at one version, one wins", async () => {
    const v = await edit(0, cat("a"));
    const [one, two] = await Promise.all([
      patch({ draftVersion: v.draftVersion, operations: [cat("b")] }),
      patch({ draftVersion: v.draftVersion, operations: [cat("c")] }, staffTwo),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect([one, two].find((r) => r.status === 409)!.body.error.code).toBe("version_conflict");
    const after = (await draft()).body;
    expect(after.draftVersion).toBe(v.draftVersion + 1);
    expect(after.body.categories).toHaveLength(2);
    const stale = await patch({ draftVersion: 0, operations: [cat("d")] });
    expect(stale.status).toBe(409);
  });

  it("the history records every editor", async () => {
    const v = await edit(0, cat("a"));
    const res = await patch({ draftVersion: v.draftVersion, operations: [cat("b")] }, staffTwo);
    expect(res.body.edits.history.map((h: { principal: string; action: string }) => [h.principal, h.action])).toEqual([
      [STAFF_PRINCIPAL, "edit"],
      [`${PREFIX}faq-staff-2`, "edit"],
    ]);
  });

  it("a hand-corrupted stored draft is 422 and discard is the way out", async () => {
    await sql.query(`INSERT INTO content_drafts (name, version, edits, updated_by) VALUES ('faq', 1, $1::jsonb, 'test')`, [JSON.stringify({ faq: { format: "faq.v1", categories: [{ id: "A B", title: "x", entries: [] }] } })]);
    expect((await draft()).status).toBe(422);
    expect((await patch({ draftVersion: 1, operations: [cat("a")] })).status).toBe(422);
    expect((await discard(1)).status).toBe(200);
    expect((await draft()).status).toBe(200);
  });
});

describe("discard and publish (F6)", () => {
  it("discard resets the draft to the empty base and keeps who edited", async () => {
    const v = await edit(0, cat("a"), ent("a", "e1"));
    const res = await discard(v.draftVersion);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ draftVersion: v.draftVersion + 1, changed: false, changeCount: 0 });
    expect(res.body.edits.faq).toBeUndefined();
    expect(res.body.edits.history.map((h: { action: string }) => h.action)).toEqual(["edit", "discard"]);
    expect((await draft()).body.body.categories).toEqual([]);
    expect((await discard(0)).status).toBe(409);
  });

  it("publishing zero entries is 409 nothing_to_publish, also with empty categories and an empty draft", async () => {
    expect((await publish({ draftVersion: 0 })).status).toBe(409);
    const v = await edit(0, cat("a"));
    const res = await publish({ draftVersion: v.draftVersion });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("nothing_to_publish");
    expect(await rows("SELECT 1 FROM content_documents WHERE name = 'faq'")).toHaveLength(0);
  });

  it("publish writes immutable version 1 with its digest, one audit row with the change list, and resets the draft", async () => {
    const v = await edit(0, cat("general", "General"), ent("general", "e1", { answer: "Line one.\n\nLine two." }));
    const res = await publish({ draftVersion: v.draftVersion, note: "first" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ name: "faq", version: 1, previousVersion: null, draftVersion: v.draftVersion + 1, changeCount: 2 });
    const stored = (await rows("SELECT body, sha256, byte_size, format, created_by, note FROM content_documents WHERE name = 'faq'"))[0]!;
    const bytes = canonicalBytes(stored["body"]);
    expect(stored).toMatchObject({ format: "faq.v1", created_by: STAFF_PRINCIPAL, note: "first", sha256: sha(bytes), byte_size: bytes.length });
    expect(res.body.sha256).toBe(stored["sha256"]);
    const audit = await rows("SELECT actor, target, detail FROM admin_audit WHERE action = 'content_publish' AND target = 'faq'");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: STAFF_PRINCIPAL, target: "faq" });
    expect(audit[0]!["detail"]).toMatchObject({
      name: "faq",
      version: 1,
      previousVersion: null,
      sha256: stored["sha256"],
      draftVersion: v.draftVersion,
      editors: [STAFF_PRINCIPAL],
      note: "first",
      changeCount: 2,
      changes: [
        { kind: "category-added", key: "general", to: "General" },
        { kind: "entry-added", key: "e1", to: "Question e1?" },
      ],
    });
    const after = (await draft()).body;
    expect(after).toMatchObject({ publishedVersion: 1, changed: false, changeCount: 0, draftVersion: v.draftVersion + 1 });
    expect(after.body.version).toBe(2);
  });

  it("an unchanged draft is 409; publish then edit then publish makes version 2", async () => {
    await publishFirst();
    const current = (await draft()).body.draftVersion;
    expect((await publish({ draftVersion: current })).status).toBe(409);
    const v = await edit(current, { op: "upsertEntry", categoryId: "general", id: "what-is-it", question: "Question?", answer: "Changed." });
    expect(v).toMatchObject({ changed: true, publishedVersion: 1, changeCount: 2 });
    const res = await publish({ draftVersion: v.draftVersion });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ version: 2, previousVersion: 1, changeCount: 2 });
    expect(await rows("SELECT version FROM content_documents WHERE name = 'faq' ORDER BY version")).toEqual([{ version: 1 }, { version: 2 }]);
    // Editing back to the published text is "unchanged" again.
    const back = await edit(res.body.draftVersion, { op: "upsertEntry", categoryId: "general", id: "what-is-it", question: "Question?", answer: "Changed." });
    expect(back.changed).toBe(false);
  });

  it("removing every entry after a publish is 409 (zero entries)", async () => {
    await publishFirst();
    const current = (await draft()).body.draftVersion;
    const v = await edit(current, { op: "removeEntry", id: "what-is-it" });
    expect(v.changed).toBe(true);
    const res = await publish({ draftVersion: v.draftVersion });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("nothing_to_publish");
  });

  it("a stale publish is 409 version_conflict", async () => {
    const v = await edit(0, cat("a"), ent("a", "e1"));
    await edit(v.draftVersion, ent("a", "e2"));
    const res = await publish({ draftVersion: v.draftVersion });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("version_conflict");
  });
});

describe("game documents are untouched (F1)", () => {
  it("the staff list is still the three game documents", async () => {
    await publishFirst();
    const res = await request(server).get(BASE).set(staff);
    expect(res.status).toBe(200);
    expect(res.body.documents.map((d: { name: string }) => d.name)).toEqual(["field-awards", "clipper-cards", "aircraft-tags"]);
  });

  it("a FAQ publish leaves the manifest bytes, the catalog version and a Logbook ETag unchanged; faq is 404 on the player route", async () => {
    const uid = `faq-lb-${randomUUID()}`;
    const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
    expect((await request(server).put("/v1/me").set(auth)).status).toBe(201);
    const manifestBefore = await request(server).get("/v1/content/manifest").set(auth);
    const logbookBefore = await request(server).get("/v1/me/logbook").set(auth);
    expect(manifestBefore.status).toBe(200);
    expect(logbookBefore.status).toBe(200);
    expect(manifestBefore.body.documents.map((d: { name: string }) => d.name)).not.toContain("faq");

    await publishFirst();

    const manifestAfter = await request(server).get("/v1/content/manifest").set(auth);
    const logbookAfter = await request(server).get("/v1/me/logbook").set(auth);
    expect(manifestAfter.text).toBe(manifestBefore.text);
    expect(manifestAfter.headers["etag"]).toBe(manifestBefore.headers["etag"]);
    expect(logbookAfter.headers["etag"]).toBe(logbookBefore.headers["etag"]);
    expect(logbookAfter.body.logbook.fieldAwards.catalogVersion).toBe(logbookBefore.body.logbook.fieldAwards.catalogVersion);
    const direct = await request(server).get("/v1/content/documents/faq/1").set(auth);
    expect(direct.status).toBe(404);
    expect(direct.body.error.code).toBe("not_found");
  });
});

describe("GET /v1/public/faq (F7)", () => {
  it("is 404 not_found with no-store before the first publish", async () => {
    const res = await guest();
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });

  it("serves the version in force: shape, quoted sha256 ETag of the canonical bytes, no-cache", async () => {
    await publishFirst();
    const res = await guest();
    expect(res.status).toBe(200);
    const stored = (await rows("SELECT body, sha256, created_at FROM content_documents WHERE name = 'faq'"))[0]!;
    expect(Object.keys(res.body).sort()).toEqual(["categories", "format", "publishedAt", "version"]);
    expect(res.body).toEqual({
      format: "faq.v1",
      version: 1,
      publishedAt: new Date(stored["created_at"] as Date).toISOString(),
      categories: [{ id: "general", title: "Title general", entries: [{ id: "what-is-it", question: "Question what-is-it?", answer: "Answer what-is-it." }] }],
    });
    expect(res.headers["etag"]).toBe(`"${stored["sha256"]}"`);
    expect(res.headers["etag"]).toBe(`"${sha(canonicalBytes(stored["body"]))}"`);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(JSON.stringify(res.body)).not.toMatch(/createdBy|principal|note|history/);
  });

  it("answers 304 with no body on a matching If-None-Match, 200 on a different one, and a new ETag after a second publish", async () => {
    await publishFirst();
    const first = await guest();
    const etag = first.headers["etag"] as string;
    const same = await guest({ "If-None-Match": etag });
    expect(same.status).toBe(304);
    expect(same.text).toBe("");
    expect(same.headers["etag"]).toBe(etag);
    expect(same.headers["cache-control"]).toBe("no-cache");
    expect((await guest({ "If-None-Match": '"other"' })).status).toBe(200);
    expect((await guest({ "If-None-Match": `W/${etag}` })).status).toBe(304);

    const current = (await draft()).body.draftVersion;
    const v = await edit(current, ent("general", "second"));
    expect((await publish({ draftVersion: v.draftVersion })).status).toBe(201);
    const next = await guest({ "If-None-Match": etag });
    expect(next.status).toBe(200);
    expect(next.headers["etag"]).not.toBe(etag);
    expect(next.body.version).toBe(2);
    expect(next.body.categories[0].entries.map((e: { id: string }) => e.id)).toEqual(["what-is-it", "second"]);
  });

  it("serves the published version, not the draft", async () => {
    await publishFirst();
    const current = (await draft()).body.draftVersion;
    await edit(current, ent("general", "draft-only"));
    expect((await guest()).body.categories[0].entries.map((e: { id: string }) => e.id)).toEqual(["what-is-it"]);
  });

  it("ignores an Authorization header, valid or not, and needs no client version", async () => {
    await publishFirst();
    const plain = await guest();
    for (const header of [`Bearer ${emulatorToken("anyone")}`, "Bearer garbage", "Basic x"]) {
      const res = await guest({ Authorization: header });
      expect(res.status, header).toBe(200);
      expect(res.text).toBe(plain.text);
    }
  });

  it("falls back to the previous version when the newest row is invalid, like the other documents", async () => {
    await publishFirst();
    const current = (await draft()).body.draftVersion;
    const v = await edit(current, ent("general", "second"));
    expect((await publish({ draftVersion: v.draftVersion })).status).toBe(201);
    // Corrupt version 2's digest behind the immutability trigger (test only).
    const client = await sql.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE content_documents DISABLE TRIGGER content_documents_immutable");
      await client.query("UPDATE content_documents SET sha256 = repeat('0', 64) WHERE name = 'faq' AND version = 2");
      await client.query("ALTER TABLE content_documents ENABLE TRIGGER content_documents_immutable");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    resetDocumentMemo();
    expect((await guest()).body.version).toBe(1);
  });

  it("is rate limited on the public tier: the fourth request in a minute is 429", async () => {
    await publishFirst();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await request(limited.getHttpServer()).get(PUBLIC)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe("export and import between hosts (F10)", () => {
  const exportFile = (h = staff) => request(server).get(`${FAQ}/export`).set(h);
  const importFile = (draftVersion: number, file: unknown, h = staff) => request(server).post(`${FAQ}/import`).set(h).send({ draftVersion, file } as object);
  /** A valid export file for the given categories, with its real digest. */
  const fileOf = (categories: unknown[], patch: Record<string, unknown> = {}) => ({
    kind: "faq-export",
    format: "faq.v1",
    sourceHost: "dev.api.example.com",
    sourceVersion: 3,
    publishedAt: "2026-11-26T10:00:00.000Z",
    sha256: faqContentSha256(categories as never),
    categories,
    ...patch,
  });
  const one = [{ id: "general", title: "General", entries: [{ id: "e1", question: "Q1?", answer: "Line one.\n\nLine two." }] }];

  it("export is 404 before the first publish and admin only", async () => {
    const res = await exportFile();
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
    await publishFirst();
    expect((await request(server).get(`${FAQ}/export`)).status).toBe(401);
    for (const h of [player, photographer]) {
      expect((await exportFile(h)).status).toBe(403);
      expect((await importFile(0, fileOf(one), h)).status).toBe(403);
    }
    expect((await request(server).post(`${FAQ}/import`).send({ draftVersion: 0, file: fileOf(one) })).status).toBe(401);
  });

  it("exports the published version (not the draft) with its envelope, a content digest and download headers", async () => {
    const v = await edit(0, cat("general", "General"), ent("general", "e1"));
    await publish({ draftVersion: v.draftVersion });
    const current = (await draft()).body.draftVersion;
    const v2 = await edit(current, ent("general", "e2"));
    await publish({ draftVersion: v2.draftVersion });
    await edit((await draft()).body.draftVersion, ent("general", "draft-only"));
    const res = await exportFile();
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["categories", "format", "kind", "publishedAt", "sha256", "sourceHost", "sourceVersion"]);
    expect(res.body).toMatchObject({ kind: "faq-export", format: "faq.v1", sourceVersion: 2, sourceHost: "127.0.0.1" });
    expect(res.body.categories[0].entries.map((e: { id: string }) => e.id)).toEqual(["e1", "e2"]);
    expect(res.body.sha256).toBe(sha(canonicalBytes({ format: "faq.v1", categories: res.body.categories })));
    expect(res.headers["content-disposition"]).toBe('attachment; filename="faq-v2.json"');
    expect(res.headers["cache-control"]).toBe("no-store");
    const stored = (await rows("SELECT created_at FROM content_documents WHERE name = 'faq' AND version = 2"))[0]!;
    expect(res.body.publishedAt).toBe(new Date(stored["created_at"] as Date).toISOString());
  });

  it("round trip between two states: export, wipe, import into the empty draft, publish: same digest and categories", async () => {
    const a = await edit(0, cat("general", "General"), cat("second", "Second"), ent("general", "e1", { answer: "One.\n\nTwo." }), ent("second", "e2"));
    await publish({ draftVersion: a.draftVersion });
    const a2 = await edit((await draft()).body.draftVersion, ent("second", "e3"));
    await publish({ draftVersion: a2.draftVersion });
    const exported = (await exportFile()).body;
    expect(exported.sourceVersion).toBe(2);

    await reset(); // "the other host": no FAQ at all
    expect((await guest()).status).toBe(404);
    const imported = await importFile(0, exported);
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    expect(imported.body).toMatchObject({ draftVersion: 1, changed: true, publishedVersion: null });
    expect(imported.body.edits.history).toEqual([expect.objectContaining({ principal: STAFF_PRINCIPAL, action: "import", draftVersion: 1, fileSha256: exported.sha256 })]);
    expect((await guest()).status).toBe(404); // an import only writes the draft
    const res = await publish({ draftVersion: 1 });
    expect(res.status).toBe(201);
    const again = (await exportFile()).body;
    expect(again.sourceVersion).toBe(1);
    expect(again.sha256).toBe(exported.sha256);
    expect(again.categories).toEqual(exported.categories);
    expect((await guest()).body.categories).toEqual(exported.categories);
  });

  it("an import replaces the whole draft, never the version in force, and audits content_import", async () => {
    await publishFirst();
    const current = (await draft()).body.draftVersion;
    await edit(current, ent("general", "to-be-lost"));
    const live = (await guest()).text;
    const draftNow = (await draft()).body.draftVersion;
    const res = await importFile(draftNow, fileOf(one));
    expect(res.status).toBe(200);
    expect(res.body.draftVersion).toBe(draftNow + 1);
    expect(res.body.edits.faq.categories).toEqual(one);
    expect((await draft()).body.body.categories).toEqual(one);
    expect((await guest()).text).toBe(live);
    const audit = await rows("SELECT actor, target, detail FROM admin_audit WHERE action = 'content_import' AND target = 'faq'");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: STAFF_PRINCIPAL, target: "faq" });
    expect(audit[0]!["detail"]).toEqual({ document: "faq", sourceHost: "dev.api.example.com", sourceVersion: 3, sha256: faqContentSha256(one as never), draftVersion: draftNow + 1 });
    expect((await publish({ draftVersion: draftNow + 1 })).status).toBe(201);
    expect((await guest()).body.categories).toEqual(one);
  });

  it("refuses a tampered file, a wrong kind or format, a wrong shape and invalid text with 422 and writes nothing", async () => {
    const good = fileOf(one);
    const edited = JSON.parse(JSON.stringify(good));
    edited.categories[0].entries[0].answer = "Tampered.";
    const entry = (answer: string, id = "e") => ({ id, question: "Q", answer });
    const bad: unknown[] = [
      edited, // digest no longer matches the categories
      { ...good, sha256: "0".repeat(64) },
      { ...good, kind: "faq-backup" },
      { ...good, kind: undefined },
      { ...good, format: "faq.v2" },
      { ...good, extra: 1 },
      { ...good, sourceVersion: 0 },
      { ...good, sourceHost: "bad host/with slash" },
      fileOf([{ id: "A B", title: "x", entries: [] }]),
      fileOf([{ id: "a", title: "x", entries: [entry("tab\there")] }]),
      fileOf([{ id: "a", title: "x", entries: [entry("CR\rLF")] }]),
      fileOf([{ id: "a", title: "x", entries: [entry(" padded")] }]),
      fileOf([{ id: "a", title: "x", entries: [entry("rtl\u202eoverride")] }]),
      fileOf([{ id: "a", title: "x\u2028y", entries: [] }]),
      fileOf([{ id: "a", title: "x", entries: [entry("A")] }, { id: "b", title: "y", entries: [entry("A")] }]),
      fileOf([{ id: "a", title: "x", entries: [entry("x".repeat(2001))] }]),
      fileOf(Array.from({ length: 31 }, (_, i) => ({ id: `c${i}`, title: "t", entries: [] }))),
    ];
    for (const file of bad) {
      const res = await importFile(0, file);
      expect(res.status, JSON.stringify(file).slice(0, 100)).toBe(422);
      expect(res.body.error.code).toBe("content_invalid");
    }
    expect(await rows("SELECT 1 FROM content_drafts WHERE name = 'faq'")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM admin_audit WHERE action = 'content_import' AND target = 'faq'")).toHaveLength(0);
  });

  it("a bad frame is 400 invalid_request", async () => {
    for (const body of [{ file: fileOf(one) }, { draftVersion: 0 }, { draftVersion: 0, file: [] }, { draftVersion: 0, file: "x" }, { draftVersion: 0, file: fileOf(one), extra: 1 }, { draftVersion: -1, file: fileOf(one) }]) {
      const res = await request(server).post(`${FAQ}/import`).set(staff).send(body as object);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
  });

  it("a stale draftVersion is 409 version_conflict and writes nothing", async () => {
    const v = await edit(0, cat("a"));
    const res = await importFile(0, fileOf(one));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("version_conflict");
    expect((await draft()).body).toMatchObject({ draftVersion: v.draftVersion });
    expect((await draft()).body.body.categories.map((c: { id: string }) => c.id)).toEqual(["a"]);
    expect(await rows("SELECT 1 FROM admin_audit WHERE action = 'content_import' AND target = 'faq'")).toHaveLength(0);
  });

  it("a 1 MB valid file is accepted on the import route while the same size on PATCH is 413", async () => {
    const answer = "\u{1F6E9}".repeat(2000); // 8000 bytes
    const big = Array.from({ length: 130 }, (_, i) => ({ id: `e${i}`, question: `Q${i}?`, answer }));
    const file = fileOf([{ id: "big", title: "Big", entries: big }]);
    expect(Buffer.byteLength(JSON.stringify({ draftVersion: 0, file }))).toBeGreaterThan(1_000_000);
    const res = await importFile(0, file);
    expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(200);
    expect(res.body.edits.faq.categories[0].entries).toHaveLength(130);
    const patched = await request(server).patch(`${FAQ}/draft`).set(staff).send({ draftVersion: 1, operations: [ent("big", "x", { answer: "x".repeat(1_000_000) })] });
    expect(patched.status).toBe(413);
    // Another route keeps the 16 KB cap, and so does an import over 3 MB.
    const publishBig = await request(server).post(`${FAQ}/publish`).set(staff).send({ draftVersion: 1, note: "x".repeat(20_000) });
    expect(publishBig.status).toBe(413);
    const tooBig = await request(server).post(`${FAQ}/import`).set(staff).send({ draftVersion: 1, file: { pad: "x".repeat(3_200_000) } });
    expect(tooBig.status).toBe(413);
  });

  it("the import body is not read for a caller without the admin role", async () => {
    const huge = { draftVersion: 0, file: { pad: "x".repeat(2_000_000) } };
    expect((await request(server).post(`${FAQ}/import`).set(player).send(huge)).status).toBe(403);
    expect((await request(server).post(`${FAQ}/import`).send(huge)).status).toBe(413); // anonymous: left to the global 16 KB cap, never buffered to 3 MB
  });

  it("the 3 MB parser is not widened: a ~1 MB body to any other route is 413, for admins too", async () => {
    const pad = "x".repeat(1_000_000);
    const body = { draftVersion: 0, operations: [ent("a", "e", { answer: pad })] };
    for (const path of [`${FAQ}/draft`, `${BASE}/field-awards/draft`]) {
      const res = await request(server).patch(path).set(staff).send(body);
      expect(res.status, path).toBe(413);
    }
    for (const path of [`${FAQ}/publish`, `${FAQ}/draft/discard`, `${BASE}/field-awards/publish`]) {
      const res = await request(server).post(path).set(staff).send({ draftVersion: 0, note: pad });
      expect(res.status, path).toBe(413);
    }
  });

  it("a case or trailing-slash variant of the import path lets no non-admin through and never reads a big body", async () => {
    const huge = { draftVersion: 0, file: { pad: "x".repeat(2_000_000) } };
    for (const path of [`${FAQ}/import/`, `${BASE}/FAQ/import`, `${BASE}/faq/IMPORT`, `${BASE}/faq//import`, `${FAQ}/import/x`]) {
      for (const h of [player, photographer, undefined]) {
        const call = request(server).post(path);
        const res = await (h ? call.set(h) : call).send(huge);
        expect(res.status, `${path} ${h ? "signed in" : "anonymous"}`).not.toBe(200);
        expect([403, 404, 413], `${path} ${h ? "signed in" : "anonymous"} -> ${res.status}`).toContain(res.status);
      }
    }
    expect(await rows("SELECT 1 FROM content_drafts WHERE name = 'faq'")).toHaveLength(0);
  });

  it("the shared demo account is 403 on the import route even with a stray admin row", async () => {
    expect((await request(demoApp.getHttpServer()).post(`${FAQ}/import`).set(demo).send({ draftVersion: 0, file: fileOf(one) })).status).toBe(403);
    expect((await request(demoApp.getHttpServer()).get(`${FAQ}/export`).set(demo)).status).toBe(403);
  });
});

describe("a FAQ row is not a game document (the manifest seed)", () => {
  const dbName = "airplane_games_faq_seed_test";
  const urlOf = (name: string) => {
    const url = new URL(process.env.DATABASE_URL as string);
    url.pathname = `/${name}`;
    return url.toString();
  };
  const withAdmin = async (fn: (admin: pg.Client) => Promise<void>) => {
    const admin = new pg.Client({ connectionString: urlOf("postgres") });
    await admin.connect();
    try {
      await fn(admin);
    } finally {
      await admin.end();
    }
  };
  const dropDb = () => withAdmin(async (admin) => void (await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)));

  it("with only a faq row and the game tables empty, the manifest read still runs the seed", async () => {
    await dropDb();
    await withAdmin(async (admin) => void (await admin.query(`CREATE DATABASE "${dbName}"`)));
    const saved = process.env["DATABASE_URL"];
    let built: NestExpressApplication | undefined;
    const pool = new pg.Pool({ connectionString: urlOf(dbName) });
    try {
      const migrator = drizzle({ client: pool });
      await migrate(migrator, { migrationsFolder: "./drizzle" });
      // Only a faq row: the boot seed would see "no game document" and seed, so insert the row AFTER the boot and empty the game rows.
      process.env["DATABASE_URL"] = urlOf(dbName);
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      built = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
      configureApp(built);
      await built.listen(0, "127.0.0.1");
      const body = { format: "faq.v1", version: 1, categories: [{ id: "general", title: "General", entries: [{ id: "e1", question: "Q?", answer: "A." }] }] };
      const bytes = canonicalBytes(body);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("ALTER TABLE content_documents DISABLE TRIGGER content_documents_immutable");
        await client.query("DELETE FROM content_documents");
        await client.query("ALTER TABLE content_documents ENABLE TRIGGER content_documents_immutable");
        await client.query("INSERT INTO content_documents (name, version, format, body, sha256, byte_size, created_by) VALUES ('faq', 1, 'faq.v1', $1::jsonb, $2, $3, 'test')", [
          JSON.stringify(body),
          createHash("sha256").update(bytes).digest("hex"),
          bytes.length,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      expect((await pool.query("SELECT name FROM content_documents ORDER BY name")).rows).toEqual([{ name: "faq" }]);
      const res = await request(built.getHttpServer()).get("/v1/content/manifest").set({ Authorization: `Bearer ${emulatorToken(`faq-seed-${randomUUID()}`)}` });
      expect(res.status).toBe(200);
      expect(res.body.documents.map((d: { name: string }) => d.name)).toEqual(["aircraft-tags", "field-awards"]);
      expect((await pool.query("SELECT name FROM content_documents ORDER BY name")).rows.map((r) => r.name)).toEqual(["aircraft-tags", "faq", "field-awards"]);
    } finally {
      if (saved === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = saved;
      await built?.close();
      await pool.end();
      await dropDb();
    }
  });
});
