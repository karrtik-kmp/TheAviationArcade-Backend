import { createHash, randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { canonicalBytes } from "../src/content/documents/canonical.js";
import { documentInForce, resetDocumentMemo, seedContentDocuments } from "../src/content/documents/document-store.js";
import { buildFieldAwardsBody } from "../src/content/documents/documents.js";
import { DatabaseService } from "../src/database/database.module.js";
import { MIN_ROUND_MS } from "../src/rounds/rounds.service.js";
import { FIELD_AWARD_CATALOG } from "../src/rules/field-award-catalog.js";
import { militaryCardKey } from "../src/rules/clipper-cards.js";
import { catalogInForce } from "../src/trips/catalog-in-force.js";
import { seedAdmins } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";
import { factsFor, newKey, openBody } from "./trip-helpers.js";

// Slice T6: staff edit and publish of the published documents. The real Nest app against the real test database.

const BASE = "/v1/admin/content/documents";
const MANIFEST = "/v1/content/manifest";
const PREFIX = "firebase:demo-airplane-games:";
const STAFF_PRINCIPAL = `${PREFIX}staff`;
const MILITARY = "aircraft-identifier-military";

const CENTURY = FIELD_AWARD_CATALOG.find((a) => a.id === "century")!.title;
const staff: Record<string, string> = { Authorization: `Bearer ${emulatorToken("staff")}`, "X-Client": "web" };
const otherStaff = { Authorization: `Bearer ${emulatorToken("second", undefined, undefined, { email: "other.staff@sites.test" })}` };
const nonStaff = { Authorization: `Bearer ${emulatorToken("player-1")}` };
const unverifiedStaff = { Authorization: `Bearer ${emulatorToken("unverified", undefined, undefined, { email: "staff@sites.test", emailVerified: false })}` };

const apps: NestExpressApplication[] = [];
let sql: pg.Pool;
let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let database: DatabaseService;

async function buildApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const built = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(built);
  await built.listen(0, "127.0.0.1");
  apps.push(built);
  return built;
}

async function withTriggerOff(fn: (client: pg.PoolClient) => Promise<void>) {
  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE content_documents DISABLE TRIGGER content_documents_immutable");
    await fn(client);
    await client.query("ALTER TABLE content_documents ENABLE TRIGGER content_documents_immutable");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Put the shared test database back: no drafts, no published version above 1 (clipper-cards tests restore their own rows), no publish audit. */
async function reset() {
  await sql.query("DELETE FROM content_drafts");
  await sql.query("DELETE FROM admin_audit WHERE action = 'content_publish'");
  await withTriggerOff((c) => c.query("DELETE FROM content_documents WHERE version > 1 AND name <> 'clipper-cards'").then(() => undefined));
  resetDocumentMemo();
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // Admin access comes from account_roles only (Backend ADR-0002).
  await seedAdmins(sql, "staff", "second", "unverified", "noemail");
  await reset();
  app = await buildApp();
  server = app.getHttpServer();
  database = app.get(DatabaseService);
});

afterEach(reset);

afterAll(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await sql.end();
});

const list = (h = staff) => request(server).get(BASE).set(h);
const draft = (name: string, h = staff) => request(server).get(`${BASE}/${name}/draft`).set(h);
const edit = (name: string, body: unknown, h = staff) => request(server).patch(`${BASE}/${name}/draft`).set(h).send(body as object);
const discard = (name: string, draftVersion: number, h = staff) => request(server).post(`${BASE}/${name}/draft/discard`).set(h).send({ draftVersion });
const publish = (name: string, body: unknown, h = staff) => request(server).post(`${BASE}/${name}/publish`).set(h).send(body as object);

const editAward = (draftVersion: number, award: Record<string, unknown>) => edit("field-awards", { draftVersion, awards: [award] });
const rows = async <T = Record<string, any>>(query: string, params: unknown[] = []) => (await sql.query(query, params)).rows as T[];
const count = async (table: string, where = "TRUE") => (await rows<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`))[0]!.n;
const manifestOf = async () => (await request(server).get(MANIFEST).set({ Authorization: `Bearer ${emulatorToken(`uid-${randomUUID()}`)}` })).body;
const entry = (manifest: any, name: string) => manifest.documents.find((d: { name: string }) => d.name === name);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function newPlayer() {
  const uid = `uid-${randomUUID()}`;
  const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
  expect((await request(server).put("/v1/me").set(auth)).status).toBe(201);
  return { uid, auth, principal: `${PREFIX}${uid}` };
}
type Player = Awaited<ReturnType<typeof newPlayer>>;

function localClock(hour: number) {
  const now = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let offset = hour * 60 + 30 - utcMinutes;
  if (offset > 840) offset -= 1440;
  if (offset < -720) offset += 1440;
  return { utcOffsetMinutes: offset, localDate: new Date(now.getTime() + offset * 60_000).toISOString().slice(0, 10) };
}

/** Ten correct atc-match Rounds in a fresh segment, completed; returns the `complete` response body. */
async function finishedTrip(p: Player, date: Record<string, unknown> = localClock(12)) {
  const opened = await request(server).post("/v1/trips").set(p.auth).set("Idempotency-Key", newKey()).send(openBody("atc-match", date));
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const tripId = opened.body.trip.tripId as string;
  for (let i = 0; i < 10; i++) {
    const issued = await request(server).post("/v1/rounds").set(p.auth).send({ tripId });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const roundId = issued.body.round.roundId as string;
    await sql.query("UPDATE rounds SET issued_at = issued_at - ($1::int * interval '1 millisecond') WHERE id = $2", [MIN_ROUND_MS * 2, roundId]);
    const banked = await request(server)
      .post(`/v1/rounds/${roundId}/result`)
      .set(p.auth)
      .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9, ...factsFor("atc-match") });
    expect(banked.status, JSON.stringify(banked.body)).toBe(200);
  }
  const done = await request(server).post(`/v1/trips/${tripId}/complete`).set(p.auth);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return { tripId, text: done.text, body: done.body };
}

const logbook = (p: Player) => request(server).get("/v1/me/logbook").set(p.auth);

// ---------------------------------------------------------------------------------------------------------------------

describe("staff only: 401, 403, and the staff identity comes from the token", () => {
  const calls: [string, () => request.Test][] = [
    ["GET list", () => request(server).get(BASE)],
    ["GET draft", () => request(server).get(`${BASE}/field-awards/draft`)],
    ["PATCH draft", () => request(server).patch(`${BASE}/field-awards/draft`).send({ draftVersion: 0, awards: [{ id: "century", title: "x" }] })],
    ["POST discard", () => request(server).post(`${BASE}/field-awards/draft/discard`).send({ draftVersion: 0 })],
    ["POST publish", () => request(server).post(`${BASE}/field-awards/publish`).send({ draftVersion: 0 })],
  ];

  it("401 without a token or with a junk one, under no-store", async () => {
    for (const [label, call] of calls) {
      const none = await call();
      expect(none.status, label).toBe(401);
      expect(none.body.error.code).toBe("unauthorized");
      expect(none.headers["cache-control"]).toBe("no-store");
      expect((await call().set("Authorization", "Bearer junk")).status, label).toBe(401);
    }
  });

  it("403 for a signed-in player, for the staff address with an unverified email, and for no email at all; nothing is written", async () => {
    const noEmail = { Authorization: `Bearer ${emulatorToken("noemail", undefined, undefined, { email: null })}` };
    for (const [label, call] of calls) {
      for (const who of [nonStaff, unverifiedStaff, noEmail]) {
        const res = await call().set(who);
        expect(res.status, label).toBe(403);
        expect(res.body.error.code).toBe("forbidden");
      }
    }
    expect(await count("content_drafts")).toBe(0);
    expect(await count("content_documents", "version > 1 AND name <> 'clipper-cards'")).toBe(0);
  });

  it("an admin caller needs no player row and no app build number (both callers hold seeded admin rows)", async () => {
    expect((await list(otherStaff)).status).toBe(200);
    expect((await list()).status).toBe(200);
  });

  it("the audit actor is the verified token's principal; a body field cannot name another", async () => {
    const v = (await draft("field-awards")).body.draftVersion;
    expect((await edit("field-awards", { draftVersion: v, awards: [{ id: "century", title: "Century Club" }], actor: "firebase:x:evil" })).status).toBe(400);
    const edited = await editAward(v, { id: "century", title: "Century Club" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const done = await publish("field-awards", { draftVersion: edited.body.draftVersion, note: "typo", createdBy: "x" });
    expect(done.status).toBe(400);
    const ok = await publish("field-awards", { draftVersion: edited.body.draftVersion, note: "title wording" }, otherStaff);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const audit = await rows("SELECT actor FROM admin_audit WHERE action = 'content_publish'");
    expect(audit).toEqual([{ actor: `${PREFIX}second` }]);
    expect((await rows("SELECT created_by FROM content_documents WHERE name = 'field-awards' AND version = 2"))[0]!["created_by"]).toBe(`${PREFIX}second`);
  });
});

describe("reading drafts", () => {
  it("lists every document with the version in force, the draft revision and whether anything would change", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.documents.map((d: { name: string }) => d.name)).toEqual(["field-awards", "clipper-cards", "aircraft-tags"]);
    const awards = res.body.documents.find((d: { name: string }) => d.name === "field-awards");
    expect(awards).toMatchObject({ publishedVersion: 1, draftVersion: 0, changed: false, edits: {}, changeCount: 0, changes: [] });
  });

  it("returns the document a publish would write, as the next version, and 404 for an unknown name", async () => {
    const res = await draft("field-awards");
    expect(res.status).toBe(200);
    expect(res.body.body.version).toBe(2);
    expect(res.body.body.awards).toHaveLength(28);
    expect(res.body.changed).toBe(false);
    expect((await draft("nope")).status).toBe(404);
    expect((await edit("nope", {})).status).toBe(404);
    expect((await publish("nope", { draftVersion: 0 })).status).toBe(404);
    expect((await discard("nope", 0)).status).toBe(404);
  });
});

describe("an edit is invisible to players until it is published", () => {
  it("changes the draft only: no manifest, document, catalog or Logbook change, and no player write", async () => {
    const p = await newPlayer();
    const before = { manifest: await manifestOf(), lb: await logbook(p) };
    const playerRow = (await rows("SELECT version, logbook_version, updated_at FROM players WHERE id = $1", [p.principal]))[0];

    const edited = await editAward(0, { id: "century", title: "Century Club", target: 150 });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ name: "field-awards", publishedVersion: 1, draftVersion: 1, changed: true, changeCount: 2 });
    expect(edited.body.changes).toEqual([
      { kind: "award", key: "century", field: "title", from: CENTURY, to: "Century Club" },
      { kind: "award", key: "century", field: "target", from: 100, to: 150 },
    ]);

    const after = { manifest: await manifestOf(), lb: await logbook(p) };
    expect(after.manifest).toEqual(before.manifest);
    expect(after.lb.headers["etag"]).toBe(before.lb.headers["etag"]);
    expect(after.lb.text).toBe(before.lb.text);
    expect((await request(server).get("/v1/content/documents/field-awards/2").set(p.auth)).status).toBe(404);
    expect((await catalogInForce(database.db)).version).toBe(1);
    expect((await rows("SELECT version, logbook_version, updated_at FROM players WHERE id = $1", [p.principal]))[0]).toEqual(playerRow);
    expect(await count("content_documents", "name = 'field-awards'")).toBe(1);

    const read = await draft("field-awards");
    expect(read.body.draftVersion).toBe(1);
    expect(read.body.edits).toMatchObject({ awards: { century: { title: "Century Club", target: 150 } } });
    expect(read.body.edits.history).toEqual([{ principal: STAFF_PRINCIPAL, action: "edit", at: expect.any(String), draftVersion: 1 }]);
    const century = read.body.body.awards.find((a: { id: string }) => a.id === "century");
    expect(century).toMatchObject({ title: "Century Club", target: 150, metric: expect.any(String) });
  });

  it("an edit that restores the published values leaves nothing to publish", async () => {
    const a = await editAward(0, { id: "century", title: "Temp" });
    const b = await editAward(a.body.draftVersion, { id: "century", title: CENTURY });
    expect(b.status).toBe(200);
    expect(b.body.changed).toBe(false);
    const refused = await publish("field-awards", { draftVersion: b.body.draftVersion });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("nothing_to_publish");
    expect(await count("content_documents", "name = 'field-awards'")).toBe(1);
    expect(await count("admin_audit", "action = 'content_publish'")).toBe(0);
  });

  it("a publish with no draft at all is refused the same way (the defined refusal for an unchanged draft)", async () => {
    const refused = await publish("field-awards", { draftVersion: 0 });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("nothing_to_publish");
    expect(await count("content_drafts")).toBe(0);
  });
});

describe("edit validation: only title, criteria, target and hidden; nothing invalid is stored", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["id and metric are not editable", { id: "century", metric: "trips-completed", title: "x" }],
    ["sheet text is not editable", { id: "century", thresholdCell: "x" }],
    ["target 0", { id: "century", target: 0 }],
    ["target -3", { id: "century", target: -3 }],
    ["fractional target", { id: "century", target: 1.5 }],
    ["target above the limit", { id: "century", target: 1_000_000_001 }],
    ["target as text", { id: "century", target: "5" }],
    ["empty title", { id: "century", title: "   " }],
    ["title over 200", { id: "century", title: "x".repeat(201) }],
    ["criteria over 2000", { id: "century", criteria: "x".repeat(2001) }],
    ["title with U+0000", { id: "century", title: "a\u0000b" }],
    ["an unpaired surrogate", { id: "century", title: "a\ud800b" }],
    ["hidden as text", { id: "century", hidden: "yes" }],
    ["an unknown award id", { id: "not-an-award", title: "x" }],
    ["no field at all", { id: "century" }],
  ];
  for (const [label, award] of bad) {
    it(`400 and no draft: ${label}`, async () => {
      const res = await editAward(0, award);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
      expect(await count("content_drafts")).toBe(0);
    });
  }

  it("400 for an empty list, a repeated award, a missing or negative draftVersion, or an unknown top-level field", async () => {
    for (const body of [
      { draftVersion: 0, awards: [] },
      { draftVersion: 0, awards: [{ id: "century", title: "a" }, { id: "century", title: "b" }] },
      { awards: [{ id: "century", title: "a" }] },
      { draftVersion: -1, awards: [{ id: "century", title: "a" }] },
      { draftVersion: 0, awards: [{ id: "century", title: "a" }], extra: 1 },
    ]) {
      expect((await edit("field-awards", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await count("content_drafts")).toBe(0);
  });

  it("hidden, criteria and title are edited and trimmed; typos are fixed by staff (U10)", async () => {
    const res = await editAward(0, { id: "sharp-eyes", title: "  Sharp Eyes  ", criteria: "Identify ten aircraft in a row.", hidden: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.edits.awards["sharp-eyes"]).toEqual({ title: "Sharp Eyes", criteria: "Identify ten aircraft in a row.", hidden: true });
  });
});

describe("publish: a new immutable version, one audit row, and everything players see moves with it", () => {
  it("writes version 2 with the edit, one content_publish audit row, and changes the manifest, catalogInForce and the Logbook ETag with no player write", async () => {
    const p = await newPlayer();
    const before = { manifest: await manifestOf(), lb: await logbook(p) };
    const playerRow = (await rows("SELECT version, logbook_version, updated_at FROM players WHERE id = $1", [p.principal]))[0];
    const edited = await editAward(0, { id: "century", title: "Century Club", target: 150, criteria: "Fly 150 Flights.", hidden: true });
    expect(edited.status).toBe(200);

    const done = await publish("field-awards", { draftVersion: edited.body.draftVersion, note: "wording and target" });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.headers["cache-control"]).toBe("no-store");
    expect(done.body).toMatchObject({ name: "field-awards", version: 2, previousVersion: 1, draftVersion: 2, changeCount: 4 });

    // The manifest names the new version and the digest of the bytes a player downloads.
    const manifest = await manifestOf();
    expect(manifest.version).not.toBe(before.manifest.version);
    expect(done.body.manifestVersion).toBe(manifest.version);
    const listed = entry(manifest, "field-awards");
    expect(listed).toMatchObject({ version: 2, sha256: done.body.sha256, byteSize: done.body.byteSize, url: "/v1/content/documents/field-awards/2" });
    const served = await request(server).get(listed.url).set(p.auth).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(sha(served.body as Buffer)).toBe(listed.sha256);
    const body = JSON.parse((served.body as Buffer).toString("utf8"));
    expect(body.version).toBe(2);
    expect(body.awards.find((a: { id: string }) => a.id === "century")).toMatchObject({ title: "Century Club", target: 150, criteria: "Fly 150 Flights.", hidden: true });
    // Version 1 is untouched and still served.
    const v1 = await request(server).get("/v1/content/documents/field-awards/1").set(p.auth);
    expect(v1.body.awards.find((a: { id: string }) => a.id === "century").title).toBe(CENTURY);
    // The bytes are the canonical bytes of the stored body.
    const stored = (await rows("SELECT body, sha256 FROM content_documents WHERE name = 'field-awards' AND version = 2"))[0]!;
    expect(sha(canonicalBytes(stored["body"]))).toBe(stored["sha256"]);

    expect((await catalogInForce(database.db)).version).toBe(2);
    expect((await catalogInForce(database.db)).awards.find((a) => a.id === "century")?.target).toBe(150);
    const lb = await logbook(p);
    expect(lb.headers["etag"]).not.toBe(before.lb.headers["etag"]);
    expect(lb.body.logbook.fieldAwards.catalogVersion).toBe(2);
    expect((await rows("SELECT version, logbook_version, updated_at FROM players WHERE id = $1", [p.principal]))[0]).toEqual(playerRow);

    // Exactly one audit row, with the actor, the target and what changed.
    const audit = await rows("SELECT actor, action, target, detail FROM admin_audit WHERE action = 'content_publish'");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: STAFF_PRINCIPAL, action: "content_publish", target: "field-awards" });
    expect(audit[0]!["detail"]).toMatchObject({
      name: "field-awards",
      version: 2,
      previousVersion: 1,
      sha256: done.body.sha256,
      byteSize: done.body.byteSize,
      draftVersion: 1,
      note: "wording and target",
      changeCount: 4,
    });
    expect(audit[0]!["detail"].changes).toEqual(
      expect.arrayContaining([
        { kind: "award", key: "century", field: "title", from: CENTURY, to: "Century Club" },
        { kind: "award", key: "century", field: "target", from: 100, to: 150 },
        { kind: "award", key: "century", field: "hidden", from: false, to: true },
      ]),
    );
    expect((await rows("SELECT created_by, note FROM content_documents WHERE name = 'field-awards' AND version = 2"))[0]).toEqual({ created_by: STAFF_PRINCIPAL, note: "wording and target" });

    // The draft restarts from the published document at a higher revision.
    const after = await draft("field-awards");
    expect(after.body).toMatchObject({ publishedVersion: 2, draftVersion: 2, changed: false, edits: {} });
    expect(after.body.body.version).toBe(3);
  });

  it("a second publish is version 3, and a retried publish (same draftVersion) is a 409, never a second row", async () => {
    const a = await editAward(0, { id: "century", title: "One" });
    const first = await publish("field-awards", { draftVersion: a.body.draftVersion });
    expect(first.status).toBe(201);
    const retry = await publish("field-awards", { draftVersion: a.body.draftVersion });
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe("version_conflict");
    const b = await editAward(first.body.draftVersion, { id: "century", title: "Two" });
    const second = await publish("field-awards", { draftVersion: b.body.draftVersion });
    expect(second.body).toMatchObject({ version: 3, previousVersion: 2 });
    expect(await count("content_documents", "name = 'field-awards'")).toBe(3);
    expect(await count("admin_audit", "action = 'content_publish'")).toBe(2);
  });

  it("discard throws the edits away, and a discard of a draft that was never made changes nothing", async () => {
    const a = await editAward(0, { id: "century", title: "Gone" });
    const gone = await discard("field-awards", a.body.draftVersion);
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ draftVersion: 2, changed: false, edits: {} });
    expect((await discard("field-awards", 1)).status).toBe(409);
    await sql.query("DELETE FROM content_drafts");
    const none = await discard("field-awards", 0);
    expect(none.status).toBe(200);
    expect(none.body.draftVersion).toBe(0);
    expect(await count("content_drafts")).toBe(0);
  });
});

describe("recorded effects on players: earned awards never un-earn, replays are unchanged, later completions record the new version", () => {
  it("U7: a raised target keeps the award earned; the old completion replays byte for byte; the next completion records catalog_version 2", async () => {
    const p = await newPlayer();
    const first = await finishedTrip(p);
    expect(first.body.fieldAwards.map((a: { id: string }) => a.id)).toContain("first-flight");
    expect((await rows("SELECT catalog_version FROM trips WHERE id = $1", [first.tripId]))[0]!["catalog_version"]).toBe(1);

    const edited = await editAward(0, { id: "first-flight", target: 25, title: "First Flight (renamed)" });
    expect((await publish("field-awards", { draftVersion: edited.body.draftVersion })).status).toBe(201);

    // Replay of the old completion: identical bytes, nothing paid, nothing re-judged.
    const replay = await request(server).post(`/v1/trips/${first.tripId}/complete`).set(p.auth);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect({ ...replay.body, replayed: false, progress: null }).toEqual({ ...first.body, replayed: false, progress: null });
    expect(replay.body.fieldAwards).toEqual(first.body.fieldAwards);
    expect((await rows("SELECT catalog_version FROM trips WHERE id = $1", [first.tripId]))[0]!["catalog_version"]).toBe(1);

    // The award is still earned although its target is now 25; the Logbook says so.
    const lb = (await logbook(p)).body.logbook;
    const award = lb.fieldAwards.awards.find((a: { id: string }) => a.id === "first-flight");
    expect(award).toMatchObject({ earned: true, target: 25 });
    expect(award.current).toBeLessThan(25);
    expect(lb.fieldAwards.catalogVersion).toBe(2);

    // The next completion is judged by version 2, records it, and does not award first-flight again.
    const second = await finishedTrip(p);
    expect(second.body.fieldAwards.map((a: { id: string }) => a.id)).not.toContain("first-flight");
    expect((await rows("SELECT catalog_version FROM trips WHERE id = $1", [second.tripId]))[0]!["catalog_version"]).toBe(2);
    expect((await rows("SELECT catalog_version FROM player_field_awards WHERE player_id = $1 AND award_id = 'first-flight'", [p.principal]))[0]!["catalog_version"]).toBe(1);
    const again = (await logbook(p)).body.logbook.fieldAwards.awards.find((a: { id: string }) => a.id === "first-flight");
    expect(again.earned).toBe(true);
    // The old completion is still the same after the new one.
    const replayAgain = await request(server).post(`/v1/trips/${first.tripId}/complete`).set(p.auth);
    expect(replayAgain.body.fieldAwards).toEqual(first.body.fieldAwards);
  });
});

describe("a stale version never overwrites another editor (409 version_conflict)", () => {
  it("two editors who read the same revision: the second is refused and the first edit stays", async () => {
    const v = (await draft("field-awards")).body.draftVersion;
    const one = await editAward(v, { id: "century", title: "Editor one" });
    expect(one.status).toBe(200);
    const two = await edit("field-awards", { draftVersion: v, awards: [{ id: "century", title: "Editor two" }] }, otherStaff);
    expect(two.status).toBe(409);
    expect(two.body.error.code).toBe("version_conflict");
    expect((await draft("field-awards")).body.edits.awards).toEqual({ century: { title: "Editor one" } });
    // With the new revision the second editor may edit another field of the same award; the first value is kept.
    const retried = await edit("field-awards", { draftVersion: one.body.draftVersion, awards: [{ id: "century", target: 120 }] }, otherStaff);
    expect(retried.status).toBe(200);
    expect(retried.body.edits.awards.century).toEqual({ title: "Editor one", target: 120 });
  });

  it("publish and discard are version checked too", async () => {
    const one = await editAward(0, { id: "century", title: "One" });
    expect((await publish("field-awards", { draftVersion: 0 })).status).toBe(409);
    expect((await discard("field-awards", 0)).status).toBe(409);
    await editAward(one.body.draftVersion, { id: "century", title: "Two" }, );
    const stale = await publish("field-awards", { draftVersion: one.body.draftVersion });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect(await count("content_documents", "name = 'field-awards'")).toBe(1);
  });

  it("concurrent edits at one revision: exactly one wins", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => editAward(0, { id: "century", title: `Racer ${i}` })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const winner = results.find((r) => r.status === 200)!;
    expect((await draft("field-awards")).body.edits).toEqual(winner.body.edits);
    expect(winner.body.edits.history).toHaveLength(1);
    expect(await count("content_drafts")).toBe(1);
  });

  it("concurrent publishes of one draft: one version is written, once, with one audit row", async () => {
    const edited = await editAward(0, { id: "century", title: "Raced" });
    const results = await Promise.all(Array.from({ length: 8 }, () => publish("field-awards", { draftVersion: edited.body.draftVersion })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    for (const r of results.filter((x) => x.status === 409)) expect(["version_conflict", "nothing_to_publish"]).toContain(r.body.error.code);
    expect(await rows("SELECT version FROM content_documents WHERE name = 'field-awards' ORDER BY version")).toEqual([{ version: 1 }, { version: 2 }]);
    expect(await count("admin_audit", "action = 'content_publish'")).toBe(1);
  });

  it("a publish racing an edit never loses the edit: either the edit is in the published version, or it is refused", async () => {
    for (let round = 0; round < 5; round++) {
      await reset();
      const base = await editAward(0, { id: "century", title: `Base ${round}` });
      const [pub, ed] = await Promise.all([
        publish("field-awards", { draftVersion: base.body.draftVersion }),
        editAward(base.body.draftVersion, { id: "frequent-flyer", title: `Raced ${round}` }),
      ]);
      const published = (await rows("SELECT body FROM content_documents WHERE name = 'field-awards' AND version = 2"))[0]?.["body"] as any;
      const draftNow = await draft("field-awards");
      const titleOf = (id: string) => draftNow.body.body.awards.find((a: { id: string }) => a.id === id).title;
      if (pub.status === 201 && ed.status === 200) {
        // The edit ran after the publish saw the draft: impossible, the edit's revision was consumed. So the edit must be refused.
        throw new Error("both succeeded at one revision");
      }
      if (pub.status === 201) {
        expect(ed.status).toBe(409);
        expect(published.awards.find((a: { id: string }) => a.id === "century").title).toBe(`Base ${round}`);
        expect(published.awards.find((a: { id: string }) => a.id === "frequent-flyer").title).not.toBe(`Raced ${round}`);
      } else {
        expect(ed.status).toBe(200);
        expect(pub.status).toBe(409);
        expect(published).toBeUndefined();
        expect(titleOf("frequent-flyer")).toBe(`Raced ${round}`);
        expect(titleOf("century")).toBe(`Base ${round}`);
      }
    }
  });
});

describe("the publish check rejects a bad document before anything is written", () => {
  async function corrupt(edits: unknown) {
    await sql.query("INSERT INTO content_drafts (name, version, edits, updated_by) VALUES ('field-awards', 1, $1::jsonb, 'test') ON CONFLICT (name) DO UPDATE SET edits = EXCLUDED.edits", [JSON.stringify(edits)]);
  }

  it("a stored draft with target 0, a fraction, an unknown field or a metric is 422 content_invalid; no version, no audit, draft untouched", async () => {
    for (const edits of [
      { awards: { century: { target: 0 } } },
      { awards: { century: { target: 2.5 } } },
      { awards: { century: { metric: "other" } } },
      { awards: { "not-an-award": { title: "x" } } },
      { somethingElse: 1 },
    ]) {
      await sql.query("DELETE FROM content_drafts");
      await corrupt(edits);
      const res = await publish("field-awards", { draftVersion: 1 });
      expect(res.status, JSON.stringify(edits)).toBe(422);
      expect(res.body.error.code).toBe("content_invalid");
      expect(await count("content_documents", "name = 'field-awards'")).toBe(1);
      expect(await count("admin_audit", "action = 'content_publish'")).toBe(0);
      expect((await rows("SELECT version FROM content_drafts"))[0]).toEqual({ version: 1 });
      expect((await draft("field-awards")).status).toBe(422);
      expect((await editAward(1, { id: "century", title: "x" })).status).toBe(422);
    }
  });

  it("discard is the way out of a draft that no longer validates", async () => {
    await corrupt({ awards: { century: { target: 0 } } });
    const out = await discard("field-awards", 1);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ draftVersion: 2, edits: {}, changed: false });
    expect((await draft("field-awards")).status).toBe(200);
  });

  it("the publish check also covers the whole document: 28 ids once, the id's own metric, integer targets >= 1 (the existing validators)", async () => {
    // The draft is an overlay, so ids and metrics cannot be changed through it; prove the validator the publish runs rejects them.
    const { validateDocument } = await import("../src/content/documents/documents.js");
    const good = buildFieldAwardsBody(2) as { awards: Record<string, unknown>[] };
    expect(() => validateDocument("field-awards", good, 2)).not.toThrow();
    const dup = { ...good, awards: [...good.awards.slice(0, 27), good.awards[0]] };
    expect(() => validateDocument("field-awards", dup, 2)).toThrow();
    const metric = { ...good, awards: good.awards.map((a, i) => (i === 3 ? { ...a, metric: "trips-completed" } : a)) };
    expect(() => validateDocument("field-awards", metric, 2)).toThrow();
    for (const target of [0, -1, 1.5]) {
      const t = { ...good, awards: good.awards.map((a, i) => (i === 3 ? { ...a, target } : a)) };
      expect(() => validateDocument("field-awards", t, 2), String(target)).toThrow();
    }
  });
});

describe("process-local memoisation stays correct across a publish", () => {
  it("a process that memoised version 1 sees version 2 at once; a process that never saw it, or a restarted one, agrees", async () => {
    const warm = await documentInForce(database.db, "field-awards");
    expect(warm?.meta.version).toBe(1); // memoised in this process
    await catalogInForce(database.db);

    const edited = await editAward(0, { id: "century", title: "Memo" });
    expect((await publish("field-awards", { draftVersion: edited.body.draftVersion })).status).toBe(201);

    const without = await documentInForce(database.db, "field-awards"); // memo still holds version 1's verdict
    expect(without?.meta.version).toBe(2);
    expect(without?.value.awards.find((a) => a.id === "century")?.title).toBe("Memo");
    const fresh = await buildApp(); // a second instance: its own boot, the same database
    const m1 = await manifestOf();
    const m2 = (await request(fresh.getHttpServer()).get(MANIFEST).set({ Authorization: `Bearer ${emulatorToken("x")}` })).body;
    expect(m2).toEqual(m1);
    resetDocumentMemo(); // a restarted process
    expect((await documentInForce(database.db, "field-awards"))?.meta.version).toBe(2);
    expect((await catalogInForce(database.db)).version).toBe(2);
    // Version 1's verdict is still right: rows are immutable.
    expect(entry(await manifestOf(), "field-awards").sha256).toBe(without?.meta.sha256);
  });
});

describe("clipper-cards and aircraft-tags: Card names, tags, and re-sealing from the content as it is now", () => {
  const ITEMS = ["mil-a9001", "mil-a9002", "mil-a9003", "mil-a9004"] as const;
  const ANSWERS: Record<string, string> = { "mil-a9001": "T6 Alpha", "mil-a9002": "T6 Bravo", "mil-a9003": "T6 Charlie", "mil-a9004": "t6  ALPHA " };
  let savedDocs: Record<string, unknown>[] = [];
  let approvedBefore: string[] = [];

  async function addItem(id: string) {
    await sql.query(
      `INSERT INTO content_items (module, id, rank, status, source, data, version, created_at, updated_at, updated_by)
       VALUES ($3, $1, 'trainee', 'approved', 'client_sheet', $2::jsonb, 1, now(), now(), 'test')
       ON CONFLICT (module, id) DO UPDATE SET status = 'approved'`,
      [id, JSON.stringify({ answer: ANSWERS[id], wrong: ["a", "b", "c"], sourceFile: `${id}.jpg`, photographer: "T" }), MILITARY],
    );
  }
  const retire = (id: string) => sql.query("UPDATE content_items SET status = 'retired' WHERE module = $1 AND id = $2", [MILITARY, id]);

  beforeAll(async () => {
    savedDocs = await rows("SELECT * FROM content_documents WHERE name = 'clipper-cards'");
    approvedBefore = (await rows<{ id: string }>("SELECT id FROM content_items WHERE module = $1 AND status = 'approved'", [MILITARY])).map((r) => r.id);
    await sql.query("UPDATE content_items SET status = 'retired' WHERE module = $1", [MILITARY]);
    await withTriggerOff((c) => c.query("DELETE FROM content_documents WHERE name = 'clipper-cards'").then(() => undefined));
    resetDocumentMemo();
  });

  afterAll(async () => {
    await sql.query("DELETE FROM content_drafts");
    await sql.query("DELETE FROM content_items WHERE module = $1 AND id = ANY($2)", [MILITARY, [...ITEMS]]);
    if (approvedBefore.length) await sql.query("UPDATE content_items SET status = 'approved' WHERE module = $1 AND id = ANY($2)", [MILITARY, approvedBefore]);
    await withTriggerOff(async (c) => {
      await c.query("DELETE FROM content_documents WHERE name = 'clipper-cards'");
      for (const r of savedDocs) {
        await c.query(
          "INSERT INTO content_documents (name, version, format, body, sha256, byte_size, created_at, created_by, note) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)",
          [r["name"], r["version"], r["format"], JSON.stringify(r["body"]), r["sha256"], r["byte_size"], r["created_at"], r["created_by"], r["note"]],
        );
      }
    });
    resetDocumentMemo();
  });

  const cards = async (version: number) => {
    const res = await request(server).get(`/v1/content/documents/clipper-cards/${version}`).set(nonStaff);
    expect(res.status).toBe(200);
    return res.body.cards as { key: string; name: string; module: string; itemIds: string[] }[];
  };
  const military = <T extends { module: string }>(list: T[]) => list.filter((c) => c.module === MILITARY);

  it("there is nothing to seal without approved Military items (409 nothing_to_publish), and the draft reads as unchanged", async () => {
    const read = await draft("clipper-cards");
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ publishedVersion: null, changed: false, draftVersion: 0 });
    const res = await publish("clipper-cards", { draftVersion: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("nothing_to_publish");
  });

  it("a v1 sealed from two items is brought up to date by one publish; names edited by staff and a retired item survive republishing", async () => {
    await addItem("mil-a9001");
    await addItem("mil-a9002");
    expect((await seedContentDocuments(database)).seeded).toEqual(["clipper-cards"]);
    expect(military(await cards(1)).map((c) => c.name)).toEqual(["T6 Alpha", "T6 Bravo"]);
    expect(entry(await manifestOf(), "clipper-cards").version).toBe(1);

    const player = await newPlayer();
    const logbookBefore = await logbook(player);
    expect(logbookBefore.headers["vary"]).toMatch(/Authorization/i);
    // The content moves on: two more approved items (one shares Alpha's Card key).
    await addItem("mil-a9003");
    await addItem("mil-a9004");
    expect(militaryCardKey(ANSWERS["mil-a9004"]!)).toBe(militaryCardKey("T6 Alpha"));
    const read = await draft("clipper-cards");
    expect(read.body).toMatchObject({ publishedVersion: 1, changed: true, draftVersion: 0 });
    expect(read.body.changes).toEqual(
      expect.arrayContaining([
        { kind: "card-added", key: militaryCardKey("T6 Charlie"), to: "T6 Charlie" },
        { kind: "card-items", key: militaryCardKey("T6 Alpha"), field: "itemIds", from: ["mil-a9001"], to: ["mil-a9001", "mil-a9004"] },
      ]),
    );
    // Not yet served.
    expect(entry(await manifestOf(), "clipper-cards").version).toBe(1);

    const renamed = await edit("clipper-cards", { draftVersion: 0, names: [{ key: militaryCardKey("T6 Charlie"), name: "T6 Charlie (renamed)" }] });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const done = await publish("clipper-cards", { draftVersion: renamed.body.draftVersion });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({ version: 2, previousVersion: 1 });
    const v2 = military(await cards(2));
    expect(v2.map((c) => c.name)).toEqual(["T6 Alpha", "T6 Bravo", "T6 Charlie (renamed)"]);
    expect(v2[0]!.itemIds).toEqual(["mil-a9001", "mil-a9004"]);
    expect(entry(await manifestOf(), "clipper-cards").version).toBe(2);
    // The Logbook never reads clipper-cards, so publishing it leaves the Logbook ETag and body alone.
    const logbookAfter = await logbook(player);
    expect(logbookAfter.headers["etag"]).toBe(logbookBefore.headers["etag"]);
    expect(logbookAfter.text).toBe(logbookBefore.text);
    expect((await cards(2)).filter((c) => c.module === "identifier").length).toBe(23);

    // Republish after a retirement: the card goes, the renamed card keeps its staff name.
    await retire("mil-a9002");
    const unacknowledged = await publish("clipper-cards", { draftVersion: done.body.draftVersion });
    expect(unacknowledged.status).toBe(422);
    expect(unacknowledged.body.error.code).toBe("content_invalid");
    expect(unacknowledged.body.error.message).toContain("acknowledgeCardRemoval");
    expect(entry(await manifestOf(), "clipper-cards").version).toBe(2);
    expect(await count("admin_audit", "action = 'content_publish' AND target = 'clipper-cards'")).toBe(1);
    const again = await publish("clipper-cards", { draftVersion: done.body.draftVersion, acknowledgeCardRemoval: true });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(military(await cards(3)).map((c) => c.name)).toEqual(["T6 Alpha", "T6 Charlie (renamed)"]);
    const audit = await rows("SELECT detail FROM admin_audit WHERE action = 'content_publish' AND target = 'clipper-cards' ORDER BY id");
    expect(audit).toHaveLength(2);
    expect(audit[1]!["detail"].acknowledgedCardRemoval).toBe(true);
    expect(audit[0]!["detail"].acknowledgedCardRemoval).toBeUndefined();
    expect(audit[1]!["detail"].changes).toEqual([{ kind: "card-removed", key: militaryCardKey("T6 Bravo"), from: "T6 Bravo" }]);
    // Nothing more to publish.
    expect((await publish("clipper-cards", { draftVersion: again.body.draftVersion })).body.error.code).toBe("nothing_to_publish");
  });

  it("422 content_invalid for a Card that does not exist, and 400 for an over-long or empty name; no draft is stored", async () => {
    const unknown = await edit("clipper-cards", { draftVersion: 0, names: [{ key: "mil:no such card", name: "x" }] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("content_invalid");
    expect((await edit("clipper-cards", { draftVersion: 0, names: [{ key: militaryCardKey("T6 Alpha"), name: "" }] })).status).toBe(400);
    expect((await edit("clipper-cards", { draftVersion: 0, names: [{ key: militaryCardKey("T6 Alpha"), name: "n".repeat(501) }] })).status).toBe(400);
    expect(await count("content_drafts", "name = 'clipper-cards'")).toBe(0);
  });

  it("tags: staff set a Card's tags; existing tags keep their source, new ones are provisional; an unknown Card is 422", async () => {
    const key = militaryCardKey("T6 Alpha");
    const unknown = await edit("aircraft-tags", { draftVersion: 0, entries: [{ cardKey: "mil:no such card", tags: ["heavy"] }] });
    expect(unknown.status).toBe(422);
    expect((await edit("aircraft-tags", { draftVersion: 0, entries: [{ cardKey: key, tags: ["heavy", "heavy"] }] })).status).toBe(400);
    expect((await edit("aircraft-tags", { draftVersion: 0, entries: [{ cardKey: key, tags: ["not-a-tag"] }] })).status).toBe(400);

    const seedEntry = (await request(server).get("/v1/content/documents/aircraft-tags/1").set(nonStaff)).body.entries.find((e: any) => e.tags.length > 0);
    const extra = seedEntry.tags.some((t: any) => t.tag === "piston") ? "vtol" : "piston";
    const res = await edit("aircraft-tags", {
      draftVersion: 0,
      entries: [
        { cardKey: key, tags: ["heavy"] },
        { cardKey: seedEntry.cardKey, tags: [...seedEntry.tags.map((t: any) => t.tag), extra] },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.changes).toEqual(
      expect.arrayContaining([
        { kind: "tags", key, from: [], to: ["heavy"] },
        expect.objectContaining({ kind: "tags", key: seedEntry.cardKey }),
      ]),
    );
    const done = await publish("aircraft-tags", { draftVersion: res.body.draftVersion });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const v2 = (await request(server).get("/v1/content/documents/aircraft-tags/2").set(nonStaff)).body;
    expect(v2.entries.find((e: any) => e.cardKey === key)).toEqual({ cardKey: key, manufacturer: null, manufacturerSource: null, tags: [{ tag: "heavy", source: "provisional" }] });
    const updated = v2.entries.find((e: any) => e.cardKey === seedEntry.cardKey);
    expect(updated.manufacturer).toBe(seedEntry.manufacturer);
    for (const t of seedEntry.tags) expect(updated.tags).toContainEqual(t);
    expect(updated.tags).toContainEqual({ tag: extra, source: "provisional" });
    // catalogInForce reads the new tags; the Logbook tag follows the tags version too.
    expect((await catalogInForce(database.db)).tagsVersion).toBe(2);
  });
});

describe("every editor is recorded, discards too, and the list reaches the publish audit row", () => {
  it("history survives a discard and is copied into content_publish detail, then cleared", async () => {
    const a = await editAward(0, { id: "century", title: "A" });
    const b = await edit("field-awards", { draftVersion: a.body.draftVersion, awards: [{ id: "century", title: "B" }] }, otherStaff);
    expect(b.status).toBe(200);
    const d = await discard("field-awards", b.body.draftVersion);
    expect(d.status).toBe(200);
    expect(d.body.edits.history.map((h: { action: string }) => h.action)).toEqual(["edit", "edit", "discard"]);
    const c = await edit("field-awards", { draftVersion: d.body.draftVersion, awards: [{ id: "century", title: "C" }] }, otherStaff);
    const done = await publish("field-awards", { draftVersion: c.body.draftVersion });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const detail = (await rows("SELECT actor, detail FROM admin_audit WHERE action = 'content_publish'"))[0]!;
    expect(detail["actor"]).toBe(STAFF_PRINCIPAL);
    expect(detail["detail"].editors).toEqual([STAFF_PRINCIPAL, `${PREFIX}second`]);
    expect(detail["detail"].history.map((h: any) => [h.principal, h.action])).toEqual([
      [STAFF_PRINCIPAL, "edit"],
      [`${PREFIX}second`, "edit"],
      [STAFF_PRINCIPAL, "discard"],
      [`${PREFIX}second`, "edit"],
    ]);
    expect((await draft("field-awards")).body.edits).toEqual({});
  });

  it("discarding a draft that no longer validates still records who discarded", async () => {
    await sql.query("INSERT INTO content_drafts (name, version, edits, updated_by) VALUES ('field-awards', 1, $1::jsonb, 'test')", [
      JSON.stringify({ awards: { century: { target: 0 } }, history: [{ principal: "p1", action: "edit", at: "2026-11-02T00:00:00.000Z", draftVersion: 1 }] }),
    ]);
    const out = await discard("field-awards", 1);
    expect(out.status).toBe(200);
    expect(out.body.edits.history.map((h: any) => [h.principal, h.action])).toEqual([
      ["p1", "edit"],
      [STAFF_PRINCIPAL, "discard"],
    ]);
  });
});

describe("removing a client-supplied tag needs an explicit acknowledgement", () => {
  async function clientTagged() {
    const doc = (await request(server).get("/v1/content/documents/aircraft-tags/1").set(nonStaff)).body;
    const found = doc.entries.find((e: any) => e.tags.some((t: any) => t.source !== "provisional"));
    expect(found, "the seed has a client-sourced tag").toBeDefined();
    const kept = found.tags.filter((t: any) => t.source === "provisional").map((t: any) => t.tag);
    const removed = found.tags.filter((t: any) => t.source !== "provisional").map((t: any) => t.tag);
    return { key: found.cardKey as string, kept, removed };
  }

  it("is refused without it (422, nothing stored), accepted with it, recorded in the change and the audit row", async () => {
    const { key, kept, removed } = await clientTagged();
    const refused = await edit("aircraft-tags", { draftVersion: 0, entries: [{ cardKey: key, tags: kept }] });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("content_invalid");
    expect(refused.body.error.message).toContain("acknowledgeClientTagRemoval");
    expect(await count("content_drafts")).toBe(0);

    const ok = await edit("aircraft-tags", { draftVersion: 0, entries: [{ cardKey: key, tags: kept, acknowledgeClientTagRemoval: true }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.changes).toEqual([expect.objectContaining({ kind: "tags", key, removedClientTags: removed, acknowledgedRemoval: true })]);

    // A later edit of the same Card without the flag asks again, and the draft stays as it was.
    const again = await edit("aircraft-tags", { draftVersion: ok.body.draftVersion, entries: [{ cardKey: key, tags: kept }] });
    expect(again.status).toBe(422);
    expect((await draft("aircraft-tags")).body.edits.ackClientTagRemoval).toEqual({ [key]: true });

    const done = await publish("aircraft-tags", { draftVersion: ok.body.draftVersion });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const audit = (await rows("SELECT detail FROM admin_audit WHERE action = 'content_publish'"))[0]!["detail"];
    expect(audit.changes).toEqual([expect.objectContaining({ key, removedClientTags: removed, acknowledgedRemoval: true })]);
  });

  it("adding a tag needs no acknowledgement", async () => {
    const { key, kept, removed } = await clientTagged();
    const add = await edit("aircraft-tags", { draftVersion: 0, entries: [{ cardKey: key, tags: [...kept, ...removed, "piston"] }] });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(add.body.changes[0].removedClientTags).toBeUndefined();
  });

  it("a stored draft that removes a client tag without the acknowledgement cannot be published", async () => {
    const { key, kept } = await clientTagged();
    await sql.query("INSERT INTO content_drafts (name, version, edits, updated_by) VALUES ('aircraft-tags', 1, $1::jsonb, 'test')", [JSON.stringify({ tags: { [key]: kept } })]);
    const res = await publish("aircraft-tags", { draftVersion: 1 });
    expect(res.status).toBe(422);
    expect(await count("content_documents", "name = 'aircraft-tags' AND version > 1")).toBe(0);
  });
});

describe("a publish over an invalid newest row", () => {
  it("the version in force is the last valid one; the publish takes the next free number and becomes the one in force", async () => {
    await sql.query(
      `INSERT INTO content_documents (name, version, format, body, sha256, byte_size, created_by)
       VALUES ('field-awards', 2, 'field-awards.v1', '{"format":"field-awards.v1","version":2,"awards":[]}', repeat('0', 64), 10, 'test')`,
    );
    resetDocumentMemo();
    expect((await catalogInForce(database.db)).version).toBe(1);
    const read = await draft("field-awards");
    expect(read.body.publishedVersion).toBe(1);
    expect(read.body.body.version).toBe(3);
    const edited = await editAward(0, { id: "century", title: "Over the bad row" });
    const done = await publish("field-awards", { draftVersion: edited.body.draftVersion });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({ version: 3, previousVersion: 1 });
    expect(entry(await manifestOf(), "field-awards").version).toBe(3);
    expect((await catalogInForce(database.db)).version).toBe(3);
  });
});

describe("a publish racing the seed", () => {
  it("never writes version 1 of clipper-cards twice and never loses or invents an audit row", async () => {
    const saved = await rows("SELECT * FROM content_documents WHERE name = 'clipper-cards'");
    const approved = (await rows<{ id: string }>("SELECT id FROM content_items WHERE module = $1 AND status = 'approved'", [MILITARY])).map((r) => r.id);
    await sql.query("UPDATE content_items SET status = 'retired' WHERE module = $1", [MILITARY]);
    await sql.query(
      `INSERT INTO content_items (module, id, rank, status, source, data, version, created_at, updated_at, updated_by)
       VALUES ($1, 'mil-a9101', 'trainee', 'approved', 'client_sheet', '{"answer":"Race One","wrong":["a","b","c"],"sourceFile":"r.jpg","photographer":"T"}', 1, now(), now(), 'test')
       ON CONFLICT (module, id) DO UPDATE SET status = 'approved'`,
      [MILITARY],
    );
    try {
      for (let round = 0; round < 6; round++) {
        await reset();
        await withTriggerOff((c) => c.query("DELETE FROM content_documents WHERE name = 'clipper-cards'").then(() => undefined));
        resetDocumentMemo();
        const [pub, seeded] = await Promise.all([publish("clipper-cards", { draftVersion: 0 }), seedContentDocuments(database)]);
        expect(await rows("SELECT version FROM content_documents WHERE name = 'clipper-cards'")).toEqual([{ version: 1 }]);
        if (pub.status === 201) {
          expect(seeded.seeded).toEqual([]);
          expect(await count("admin_audit", "action = 'content_publish'")).toBe(1);
        } else {
          expect(pub.status).toBe(409);
          expect(["version_conflict", "nothing_to_publish"]).toContain(pub.body.error.code);
          expect(seeded.seeded).toEqual(["clipper-cards"]);
          expect(await count("admin_audit", "action = 'content_publish'")).toBe(0);
        }
      }
    } finally {
      await sql.query("DELETE FROM content_items WHERE module = $1 AND id = 'mil-a9101'", [MILITARY]);
      if (approved.length) await sql.query("UPDATE content_items SET status = 'approved' WHERE module = $1 AND id = ANY($2)", [MILITARY, approved]);
      await withTriggerOff(async (c) => {
        await c.query("DELETE FROM content_documents WHERE name = 'clipper-cards'");
        for (const r of saved) {
          await c.query(
            "INSERT INTO content_documents (name, version, format, body, sha256, byte_size, created_at, created_by, note) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)",
            [r["name"], r["version"], r["format"], JSON.stringify(r["body"]), r["sha256"], r["byte_size"], r["created_at"], r["created_by"], r["note"]],
          );
        }
      });
      resetDocumentMemo();
    }
  });
});

describe("storage rules", () => {
  it("content_drafts has CHECKs on name, version and edits; content_publish is an accepted audit action and nothing else is", async () => {
    await expect(sql.query("INSERT INTO content_drafts (name, version, edits, updated_by) VALUES ('nope', 1, '{}', 'x')")).rejects.toThrow();
    await expect(sql.query("INSERT INTO content_drafts (name, version, edits, updated_by) VALUES ('field-awards', 0, '{}', 'x')")).rejects.toThrow();
    await expect(sql.query("INSERT INTO content_drafts (name, version, edits, updated_by) VALUES ('field-awards', 1, '[]', 'x')")).rejects.toThrow();
    await expect(sql.query("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ('a', 'content_delete', 't', '{}', now())")).rejects.toThrow();
    await sql.query("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ('a', 'content_publish', 't', '{}', now())");
  });

  it("published documents stay immutable: the trigger refuses an update of a version staff published", async () => {
    const edited = await editAward(0, { id: "century", title: "Immutable" });
    await publish("field-awards", { draftVersion: edited.body.draftVersion });
    await expect(sql.query("UPDATE content_documents SET note = 'x' WHERE name = 'field-awards' AND version = 2")).rejects.toThrow();
  });
});
