import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { canonicalBytes, canonicalJson, sha256Hex } from "../src/content/documents/canonical.js";
import { documentsInForce, insertDocument, militaryCardItems, resetDocumentMemo, seedContentDocuments, validationCount } from "../src/content/documents/document-store.js";
import {
  buildAircraftTagsBody,
  buildClipperCardsBody,
  buildFieldAwardsBody,
  parseClipperCards,
  parseFieldAwards,
} from "../src/content/documents/documents.js";
import { XLSX_MIME } from "../src/content/xlsx.js";
import { DatabaseService } from "../src/database/database.module.js";
import { MIN_ROUND_MS } from "../src/rounds/rounds.service.js";
import { MODULE_IDS } from "../src/rules/modules.js";
import { catalogInForce } from "../src/trips/catalog-in-force.js";
import { clientSheet } from "./fixtures.js";
import { seedAdmins } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";
import { factsFor, localClock, newKey, openBody } from "./trip-helpers.js";

// Slice T4: the content manifest, the immutable documents, the v1 seed and catalogInForce reading them. The real Nest app
// against the real test database; the "fresh database" cases use throwaway databases of their own (names end `_test`).

const MANIFEST = "/v1/content/manifest";
const doc = (name: string, version: number | string) => `/v1/content/documents/${name}/${version}`;
const PREFIX = "firebase:demo-airplane-games:";
const staff = { Authorization: `Bearer ${emulatorToken("staff")}` };
const bearer = () => ({ Authorization: `Bearer ${emulatorToken(`uid-${randomUUID()}`)}` });

const apps: NestExpressApplication[] = [];
const savedEnv = { ...process.env };
let sql: pg.Pool;
let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;

async function buildApp(env: Record<string, string> = {}) {
  Object.assign(process.env, env);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const built = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(built);
  await built.listen(0, "127.0.0.1");
  apps.push(built);
  return { app: built, server: built.getHttpServer() };
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
}

/** Immutability is a trigger; a test that inserted a row removes it by switching the trigger off inside one transaction. */
async function removeTestVersions(pool: pg.Pool = sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE content_documents DISABLE TRIGGER content_documents_immutable");
    await client.query("DELETE FROM content_documents WHERE version > 1");
    await client.query("ALTER TABLE content_documents ENABLE TRIGGER content_documents_immutable");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // Admin access comes from account_roles only (Backend ADR-0002).
  await seedAdmins(sql, "staff");
  await removeTestVersions(); // a crashed earlier run must not leave a version 2 behind
  ({ app, server } = await buildApp());
});

afterEach(async () => {
  await removeTestVersions();
  restoreEnv();
});

afterAll(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await sql.end();
});

const rawBody = (res: request.Response) => Buffer.from(res.text, "utf8");

describe("sign-in is required (U11)", () => {
  it("the manifest and a document answer 401 without a token, under no-store", async () => {
    for (const path of [MANIFEST, doc("field-awards", 1)]) {
      const res = await request(server).get(path);
      expect(res.status, path).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect((await request(server).get(MANIFEST).set("Authorization", "Bearer junk")).status).toBe(401);
  });

  it("any signed-in player may read them (no staff rule)", async () => {
    expect((await request(server).get(MANIFEST).set(bearer())).status).toBe(200);
    expect((await request(server).get(doc("aircraft-tags", 1)).set(bearer())).status).toBe(200);
  });
});

describe("GET /v1/content/manifest", () => {
  it("keeps Unity's ManifestWire and ModuleWire fields and adds documents[]", async () => {
    const res = await request(server).get(MANIFEST).set(bearer());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    const m = res.body;
    expect(Object.keys(m).sort()).toEqual(["documents", "generatedAtUtc", "modules", "version"]);
    expect(typeof m.version).toBe("string");
    expect(m.version).toMatch(/^m-[0-9a-f]{16}$/);
    expect(new Date(m.generatedAtUtc).toISOString()).toBe(m.generatedAtUtc);
    expect(m.modules).toHaveLength(8);
    expect(m.modules.map((x: { id: string }) => x.id).sort()).toEqual([...MODULE_IDS].sort());
    for (const mod of m.modules) {
      expect(Object.keys(mod).sort()).toEqual(["assetBundleUrl", "contentVersion", "enabled", "id"]);
      expect(mod.enabled).toBe(true);
      expect(mod.contentVersion).toBeNull();
      expect(mod.assetBundleUrl).toBeNull();
    }
    const names = m.documents.map((d: { name: string }) => d.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining(["aircraft-tags", "field-awards"]));
    for (const d of m.documents) {
      expect(Object.keys(d).sort()).toEqual(["byteSize", "format", "name", "sha256", "url", "version"]);
      expect(d.url).toBe(`/v1/content/documents/${d.name}/${d.version}`);
      expect(d.format).toBe(`${d.name}.v1`);
    }
  });

  it("lists the golden v1 digests of the two code-derived documents", async () => {
    const m = (await request(server).get(MANIFEST).set(bearer())).body;
    for (const [name, body] of [["field-awards", buildFieldAwardsBody(1)], ["aircraft-tags", buildAircraftTagsBody(1)]] as const) {
      const entry = m.documents.find((d: { name: string }) => d.name === name);
      expect(entry.version).toBe(1);
      expect(entry.sha256).toBe(sha256Hex(canonicalBytes(body)));
      expect(entry.byteSize).toBe(canonicalBytes(body).length);
    }
  });

  it("Cache-Control is no-cache, the ETag is the quoted version, and only these routes are exceptions to no-store", async () => {
    const res = await request(server).get(MANIFEST).set(bearer());
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["etag"]).toBe(`"${res.body.version}"`);
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect((await request(server).get("/v1/me/progress").set(bearer())).headers["cache-control"]).toBe("no-store");
    expect((await request(server).get("/v1/health")).headers["cache-control"]).toBeUndefined();
  });

  it("is 304 with no body for a matching If-None-Match, with the same headers", async () => {
    const first = await request(server).get(MANIFEST).set(bearer());
    const etag = first.headers["etag"] as string;
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const res = await request(server).get(MANIFEST).set(bearer()).set("If-None-Match", header);
      expect(res.status, header).toBe(304);
      expect(res.text).toBe("");
      expect(res.headers["etag"]).toBe(etag);
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.headers["x-request-id"]).toBeTruthy();
    }
    const stale = await request(server).get(MANIFEST).set(bearer()).set("If-None-Match", '"m-0000000000000000"');
    expect(stale.status).toBe(200);
    expect(stale.body.version).toBe(first.body.version);
  });

  it("is stable: the same bytes and ETag on every read, on another instance and after a restart", async () => {
    const a = await request(server).get(MANIFEST).set(bearer());
    const b = await request(server).get(MANIFEST).set(bearer());
    expect(b.text).toBe(a.text);
    const second = await buildApp(); // another instance of the same code on the same database
    const c = await request(second.server).get(MANIFEST).set(bearer());
    expect(c.text).toBe(a.text);
    expect(c.headers["etag"]).toBe(a.headers["etag"]);
    await second.app.close();
    apps.splice(apps.indexOf(second.app), 1);
    const restarted = await buildApp();
    const d = await request(restarted.server).get(MANIFEST).set(bearer());
    expect(d.text).toBe(a.text);
  });

  // ASSUMPTION (not ruled): generatedAtUtc is the newest created_at of the listed documents, so it cannot change the strong ETag.
  it("ASSUMPTION: generatedAtUtc is the newest created_at among the listed documents", async () => {
    const res = await request(server).get(MANIFEST).set(bearer());
    const newest = (await sql.query("SELECT max(created_at) AS at FROM (SELECT DISTINCT ON (name) name, created_at FROM content_documents ORDER BY name, version DESC) latest")).rows[0].at as Date;
    expect(res.body.generatedAtUtc).toBe(newest.toISOString());
  });

  it("ASSUMPTION: lists only the highest version of each name; older versions stay fetchable", async () => {
    const dbs = app.get(DatabaseService);
    const before = (await request(server).get(MANIFEST).set(bearer())).body;
    const v2 = buildFieldAwardsBody(2);
    expect(await insertDocument(dbs.db, { name: "field-awards", version: 2, body: v2, createdBy: "test" })).toBe(true);
    const after = (await request(server).get(MANIFEST).set(bearer())).body;
    expect(after.version).not.toBe(before.version); // a new document version changes the manifest version
    expect(after.documents.filter((d: { name: string }) => d.name === "field-awards")).toHaveLength(1);
    const entry = after.documents.find((d: { name: string }) => d.name === "field-awards");
    expect(entry.version).toBe(2);
    expect(entry.sha256).toBe(sha256Hex(canonicalBytes(v2)));
    expect((await request(server).get(doc("field-awards", 1)).set(bearer())).status).toBe(200);
    expect((await request(server).get(doc("field-awards", 2)).set(bearer())).status).toBe(200);
    // The old ETag no longer revalidates, the new one does.
    expect((await request(server).get(MANIFEST).set(bearer()).set("If-None-Match", `"${before.version}"`)).status).toBe(200);
    expect((await request(server).get(MANIFEST).set(bearer()).set("If-None-Match", `"${after.version}"`)).status).toBe(304);
    await removeTestVersions();
    expect((await request(server).get(MANIFEST).set(bearer())).body.version).toBe(before.version);
  });
});

describe("GET /v1/content/documents/{name}/{version}", () => {
  it("serves bytes that hash to the published sha256 and match the published size, for every listed document", async () => {
    const manifest = (await request(server).get(MANIFEST).set(bearer())).body;
    expect(manifest.documents.length).toBeGreaterThanOrEqual(2);
    for (const d of manifest.documents) {
      const res = await request(server).get(d.url).set(bearer());
      expect(res.status, d.url).toBe(200);
      const bytes = rawBody(res);
      expect(sha256Hex(bytes), d.url).toBe(d.sha256);
      expect(bytes.length, d.url).toBe(d.byteSize);
      expect(res.headers["etag"]).toBe(`"${d.sha256}"`);
      expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(res.headers["content-type"]).toMatch(/^application\/json; charset=utf-8/);
      // The canonical serialisation, exactly: no pretty-printing, no BOM, no trailing newline.
      expect(bytes.toString("utf8")).toBe(canonicalJson(JSON.parse(bytes.toString("utf8"))));
      expect(bytes[0]).toBe(0x7b);
      expect(bytes[bytes.length - 1]).toBe(0x7d);
    }
  });

  it("serves the v1 seed bytes exactly as the generator writes them, although jsonb lost key order and whitespace", async () => {
    const awards = await request(server).get(doc("field-awards", 1)).set(bearer());
    expect(rawBody(awards).equals(canonicalBytes(buildFieldAwardsBody(1)))).toBe(true);
    const tags = await request(server).get(doc("aircraft-tags", 1)).set(bearer());
    expect(rawBody(tags).equals(canonicalBytes(buildAircraftTagsBody(1)))).toBe(true);
    const parsed = parseFieldAwards(JSON.parse(awards.text), 1);
    expect(parsed.awards).toHaveLength(28);
    expect(JSON.parse(awards.text).awards[0].title).toBe("First Solo"); // the client's sheet text, verbatim
  });

  it("is 304 for the sha256 ETag (immutable headers kept) and 200 for another tag", async () => {
    const first = await request(server).get(doc("aircraft-tags", 1)).set(bearer());
    const etag = first.headers["etag"] as string;
    for (const header of [etag, `W/${etag}`, "*"]) {
      const res = await request(server).get(doc("aircraft-tags", 1)).set(bearer()).set("If-None-Match", header);
      expect(res.status, header).toBe(304);
      expect(res.text).toBe("");
      expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(res.headers["etag"]).toBe(etag);
    }
    expect((await request(server).get(doc("aircraft-tags", 1)).set(bearer()).set("If-None-Match", `"${"0".repeat(64)}"`)).status).toBe(200);
  });

  it("an unknown name or version is 404 not_found under no-store", async () => {
    for (const path of [doc("nope", 1), doc("field-awards", 99), doc("field-awards", 3), doc("clipper-cards", 99)]) {
      const res = await request(server).get(path).set(bearer());
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["etag"] ?? "").not.toMatch(/^"[0-9a-f]{64}"$/); // only Express's weak tag for the error body
    }
  });

  // ASSUMPTION (not ruled): a version that is not a canonical positive integer is "unknown", 404, not 400.
  it("ASSUMPTION: a malformed version is 404 not_found, not 400", async () => {
    for (const version of ["0", "-1", "abc", "01", "1.5", "1e1", "1234567890", "%20"]) {
      const res = await request(server).get(doc("field-awards", version)).set(bearer());
      expect(res.status, version).toBe(404);
      expect(res.body.error.code, version).toBe("not_found");
    }
  });

  it("a stored row whose digest does not match its canonical bytes is never served: 500 under no-store", async () => {
    const body = buildAircraftTagsBody(2);
    await sql.query(
      `INSERT INTO content_documents (name, version, format, body, sha256, byte_size, created_by) VALUES ('aircraft-tags', 2, 'aircraft-tags.v1', $1::jsonb, $2, 10, 'test')`,
      [JSON.stringify(body), "0".repeat(64)],
    );
    const res = await request(server).get(doc("aircraft-tags", 2)).set(bearer());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal_error");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["etag"] ?? "").not.toMatch(/^"[0-9a-f]{64}"$/); // only Express's weak tag for the error body
    // ...and catalogInForce does not use it either: the next valid version (1) stays in force.
    expect((await catalogInForce(app.get(DatabaseService).db)).version).toBe(1);
    expect((await request(server).get(doc("aircraft-tags", 1)).set(bearer())).status).toBe(200);
  });
});

describe("the client version gate and the rate limiter apply", () => {
  it("426 without a build number when MIN_CLIENT_BUILD is set; the app and the website's server pass", async () => {
    const gated = await buildApp({ MIN_CLIENT_BUILD: "20" });
    const player = bearer();
    for (const path of [MANIFEST, doc("field-awards", 1)]) {
      expect((await request(gated.server).get(path).set(player)).status, path).toBe(426);
      expect((await request(gated.server).get(path).set(player).set("X-Client-Version", "19")).status).toBe(426);
      expect((await request(gated.server).get(path).set(player).set("X-Client-Version", "20")).status).toBe(200);
      expect((await request(gated.server).get(path).set(player).set("X-Client", "web")).status).toBe(200);
    }
    restoreEnv();
  });

  it("every read counts against the per-player limit, a 304 included", async () => {
    const limited = await buildApp({ RATE_LIMIT_AUTH_PER_MIN: "3" });
    const player = bearer();
    const first = await request(limited.server).get(MANIFEST).set(player);
    expect(first.status).toBe(200);
    const etag = first.headers["etag"] as string;
    expect((await request(limited.server).get(MANIFEST).set(player).set("If-None-Match", etag)).status).toBe(304);
    expect((await request(limited.server).get(doc("field-awards", 1)).set(player)).status).toBe(200);
    const over = await request(limited.server).get(MANIFEST).set(player).set("If-None-Match", etag);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe("rate_limited");
    restoreEnv();
  });
});

describe("the table", () => {
  it("rows are immutable: UPDATE and DELETE are refused by the trigger, a duplicate version by the key", async () => {
    await expect(sql.query("UPDATE content_documents SET note = 'x' WHERE name = 'field-awards' AND version = 1")).rejects.toMatchObject({ code: "23001" });
    await expect(sql.query("DELETE FROM content_documents WHERE name = 'field-awards' AND version = 1")).rejects.toMatchObject({ code: "23001" });
    await expect(sql.query("UPDATE content_documents SET body = '{}'::jsonb")).rejects.toMatchObject({ code: "23001" });
    const dbs = app.get(DatabaseService);
    expect(await insertDocument(dbs.db, { name: "field-awards", version: 1, body: buildFieldAwardsBody(1), createdBy: "test" })).toBe(false); // ON CONFLICT DO NOTHING
    const same = (await sql.query("SELECT sha256 FROM content_documents WHERE name = 'field-awards' AND version = 1")).rows[0].sha256 as string;
    expect(same).toBe(sha256Hex(canonicalBytes(buildFieldAwardsBody(1))));
  });

  it("CHECKs refuse a bad name, version, format, body, digest, size, author and note", async () => {
    const insert = (over: Partial<Record<string, unknown>>) => {
      const v = { name: "field-awards", version: 7, format: "field-awards.v1", body: "{}", sha256: "a".repeat(64), byte_size: 2, created_by: "t", note: null, ...over };
      return sql.query(
        "INSERT INTO content_documents (name, version, format, body, sha256, byte_size, created_by, note) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)",
        [v.name, v.version, v.format, v.body, v.sha256, v.byte_size, v.created_by, v.note],
      );
    };
    for (const [why, over] of [
      ["name", { name: "other" }],
      ["version 0", { version: 0 }],
      ["format for another name", { format: "clipper-cards.v1" }],
      ["format v2", { format: "field-awards.v2" }],
      ["array body", { body: "[]" }],
      ["scalar body", { body: "1" }],
      ["short digest", { sha256: "abc" }],
      ["upper-case digest", { sha256: "A".repeat(64) }],
      ["size 0", { byte_size: 0 }],
      ["empty author", { created_by: "" }],
      ["long note", { note: "x".repeat(501) }],
    ] as const) {
      await expect(insert(over), why).rejects.toMatchObject({ code: "23514" });
    }
    await expect(insert({ name: "field-awards", version: 1 })).rejects.toMatchObject({ code: "23505" });
  });

  it("insertDocument validates before it writes (a bad body never reaches the table)", async () => {
    const dbs = app.get(DatabaseService);
    const bad = buildFieldAwardsBody(2) as { awards: { target: number }[] };
    bad.awards[0]!.target = 0;
    await expect(insertDocument(dbs.db, { name: "field-awards", version: 2, body: bad, createdBy: "test" })).rejects.toThrow();
    await expect(insertDocument(dbs.db, { name: "field-awards", version: 2, body: buildFieldAwardsBody(3), createdBy: "test" })).rejects.toThrow(/version/);
    expect(Number((await sql.query("SELECT count(*) AS n FROM content_documents WHERE version > 1")).rows[0].n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// catalogInForce reads the documents

async function newPlayer() {
  const uid = `uid-${randomUUID()}`;
  const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
  expect((await request(server).put("/v1/me").set(auth)).status).toBe(201);
  return { auth, principal: `${PREFIX}${uid}` };
}

/** Opens a segment, banks ten correct Rounds and completes it; returns the completion body. */
async function completeATrip(p: Awaited<ReturnType<typeof newPlayer>>) {
  // Midday local time, so Red-Eye Special (22:00-05:00) never joins the expected awards whatever the UTC time of the run.
  const opened = await request(server).post("/v1/trips").set(p.auth).set("Idempotency-Key", newKey()).send(openBody("atc-match", localClock(12)));
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const tripId = opened.body.trip.tripId as string;
  for (let i = 0; i < 10; i++) {
    const issued = await request(server).post("/v1/rounds").set(p.auth).send({ tripId });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const roundId = issued.body.round.roundId as string;
    await sql.query("UPDATE rounds SET issued_at = issued_at - ($1::int * interval '1 millisecond') WHERE id = $2", [MIN_ROUND_MS * 2, roundId]);
    const res = await request(server)
      .post(`/v1/rounds/${roundId}/result`)
      .set(p.auth)
      .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9, ...factsFor("atc-match") });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  const done = await request(server).post(`/v1/trips/${tripId}/complete`).set(p.auth);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return { tripId, body: done.body };
}

describe("catalogInForce reads the highest valid documents", () => {
  it("version 1 (the seed) is what T3 used: 28 awards, the seed tag table, recorded catalog_version 1", async () => {
    const catalog = await catalogInForce(app.get(DatabaseService).db);
    expect(catalog.version).toBe(1);
    expect(catalog.awards).toHaveLength(28);
    const p = await newPlayer();
    const { tripId, body } = await completeATrip(p);
    expect(body.trip.catalogVersion).toBe(1);
    expect(body.fieldAwards.map((a: { id: string }) => a.id)).toEqual(["first-flight"]);
    expect((await sql.query("SELECT catalog_version FROM trips WHERE id = $1", [tripId])).rows[0].catalog_version).toBe(1);
  });

  it("a new document version changes what the next completion judges against and what it records", async () => {
    const dbs = app.get(DatabaseService);
    const v2 = buildFieldAwardsBody(2) as { awards: { id: string; target: number }[] };
    v2.awards.find((a) => a.id === "frequent-flyer")!.target = 1; // staff lowered Frequent Flyer from 25 to 1
    await insertDocument(dbs.db, { name: "field-awards", version: 2, body: v2, createdBy: "test", note: "T4 test" });
    const catalog = await catalogInForce(dbs.db);
    expect(catalog.version).toBe(2);
    expect(catalog.awards.find((a) => a.id === "frequent-flyer")?.target).toBe(1);

    const p = await newPlayer();
    const { tripId, body } = await completeATrip(p);
    expect(body.trip.catalogVersion).toBe(2);
    expect(body.fieldAwards.map((a: { id: string }) => a.id)).toEqual(["first-flight", "frequent-flyer"]); // catalog order
    const stored = await sql.query("SELECT award_id, catalog_version FROM player_field_awards WHERE player_id = $1 ORDER BY award_id", [p.principal]);
    expect(stored.rows).toEqual([
      { award_id: "first-flight", catalog_version: 2 },
      { award_id: "frequent-flyer", catalog_version: 2 },
    ]);
    // A replay reads the tables back: the same answer, whatever the catalog in force is by then.
    await insertDocument(dbs.db, { name: "field-awards", version: 3, body: buildFieldAwardsBody(3), createdBy: "test" });
    const replay = await request(server).post(`/v1/trips/${tripId}/complete`).set(p.auth);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.fieldAwards).toEqual(body.fieldAwards);
    expect(replay.body.trip.catalogVersion).toBe(2);
  });

  it("a new tag version is used for the tag awards too", async () => {
    const dbs = app.get(DatabaseService);
    const tags = buildAircraftTagsBody(2) as { entries: { cardKey: string; tags: { tag: string; source: string }[] }[] };
    tags.entries.find((e) => e.cardKey === "787")!.tags = [{ tag: "regional-jet", source: "client_sheet" }];
    await insertDocument(dbs.db, { name: "aircraft-tags", version: 2, body: tags, createdBy: "test" });
    const catalog = await catalogInForce(dbs.db);
    expect(catalog.version).toBe(1); // the awards document is still v1: catalog_version names the awards document
    expect(catalog.tags.get("787")?.tags).toEqual([{ tag: "regional-jet", source: "client_sheet" }]);
  });

  it("the manifest and catalogInForce agree: a bad newest row is absent from the manifest and the previous version applies to both", async () => {
    const broken = buildFieldAwardsBody(2) as { awards: { target: number }[] };
    broken.awards[1]!.target = 0;
    const bytes = canonicalBytes(broken);
    await sql.query(
      "INSERT INTO content_documents (name, version, format, body, sha256, byte_size, created_by) VALUES ('field-awards', 2, 'field-awards.v1', $1::jsonb, $2, $3, 'test')",
      [bytes.toString("utf8"), sha256Hex(bytes), bytes.length],
    );
    const manifest = (await request(server).get(MANIFEST).set(bearer())).body;
    const entry = manifest.documents.find((d: { name: string }) => d.name === "field-awards");
    expect(entry.version).toBe(1);
    expect((await catalogInForce(app.get(DatabaseService).db)).version).toBe(entry.version);
    expect((await request(server).get(entry.url).set(bearer())).status).toBe(200); // everything it lists can be fetched
    // A valid v3 on top of the bad v2 is the one in force for both.
    await insertDocument(app.get(DatabaseService).db, { name: "field-awards", version: 3, body: buildFieldAwardsBody(3), createdBy: "test" });
    const after = (await request(server).get(MANIFEST).set(bearer())).body;
    expect(after.documents.find((d: { name: string }) => d.name === "field-awards").version).toBe(3);
    expect((await catalogInForce(app.get(DatabaseService).db)).version).toBe(3);
  });

  it("memoises: a second catalogInForce (and manifest) validates nothing again; an unseen row is validated once", async () => {
    const db = app.get(DatabaseService).db;
    resetDocumentMemo();
    const before = validationCount();
    await catalogInForce(db);
    expect(validationCount()).toBe(before + 2); // field-awards and aircraft-tags, once each
    await request(server).get(MANIFEST).set(bearer()); // may validate clipper-cards once, if the table has it
    await catalogInForce(db);
    const settled = validationCount();
    expect(settled).toBeLessThanOrEqual(before + 3);
    await catalogInForce(db);
    await request(server).get(MANIFEST).set(bearer());
    expect(validationCount()).toBe(settled);
    await insertDocument(db, { name: "field-awards", version: 2, body: buildFieldAwardsBody(2), createdBy: "test" });
    await catalogInForce(db);
    expect(validationCount()).toBe(settled + 1);
    await catalogInForce(db);
    expect(validationCount()).toBe(settled + 1);
  });

  // ASSUMPTION (not ruled): a newer row that is not a valid document is skipped (error logged) and the highest valid version
  // applies, so one bad row cannot stop every Trip from completing. The recorded version is the one actually applied.
  it("ASSUMPTION: a bad newest row is skipped; the recorded catalog_version is the version actually applied", async () => {
    const good = canonicalBytes(buildFieldAwardsBody(2));
    // A body that passes every CHECK but is not a catalog: a zero target.
    const broken = buildFieldAwardsBody(2) as { awards: { target: number }[] };
    broken.awards[1]!.target = 0;
    const brokenBytes = canonicalBytes(broken);
    await sql.query(
      `INSERT INTO content_documents (name, version, format, body, sha256, byte_size, created_by) VALUES ('field-awards', 2, 'field-awards.v1', $1::jsonb, $2, $3, 'test')`,
      [brokenBytes.toString("utf8"), sha256Hex(brokenBytes), brokenBytes.length],
    );
    expect(good.equals(brokenBytes)).toBe(false);
    const dbs = app.get(DatabaseService);
    expect((await catalogInForce(dbs.db)).version).toBe(1);
    const p = await newPlayer();
    const { body } = await completeATrip(p);
    expect(body.trip.catalogVersion).toBe(1);
    expect(body.fieldAwards.map((a: { id: string }) => a.id)).toEqual(["first-flight"]);
  });

});

// ---------------------------------------------------------------------------------------------------------------------
// The seed: a fresh database, an existing one, idempotence, concurrency

const DB_FRESH = "airplane_games_seed_fresh_test";
const DB_EXISTING = "airplane_games_seed_existing_test";
const DB_RACE = "airplane_games_seed_race_test";

function urlOf(name: string): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${name}`;
  return url.toString();
}

async function recreateDatabase(name: string): Promise<void> {
  if (!name.endsWith("_test")) throw new Error("refusing");
  const admin = new pg.Client({ connectionString: urlOf("postgres") });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: urlOf(name) });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: urlOf("postgres") });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function withDatabase<T>(name: string, fn: (pool: pg.Pool, dbs: DatabaseService) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: urlOf(name) });
  try {
    return await fn(pool, new DatabaseService(pool));
  } finally {
    await pool.end();
  }
}

const rows = async (pool: pg.Pool) =>
  (await pool.query("SELECT name, version, sha256, byte_size, created_by, body FROM content_documents ORDER BY name, version")).rows as {
    name: string; version: number; sha256: string; byte_size: number; created_by: string; body: unknown;
  }[];

async function insertMilitary(pool: pg.Pool, items: [id: string, answer: string][]) {
  for (const [id, answer] of items) {
    await pool.query(
      `INSERT INTO content_items (module, id, rank, status, source, data, version, created_at, updated_at, updated_by)
       VALUES ('aircraft-identifier-military', $1, 'trainee', 'approved', 'client_sheet', $2::jsonb, 1, now(), now(), 'test')`,
      [id, JSON.stringify({ answer, wrong: ["a", "b", "c"], sourceFile: `${id}.jpg`, photographer: "T" })],
    );
  }
}

describe("the v1 seed", () => {
  beforeAll(async () => {
    await Promise.all([recreateDatabase(DB_FRESH), recreateDatabase(DB_EXISTING), recreateDatabase(DB_RACE)]);
  }, 60_000);
  afterAll(async () => {
    await Promise.all([DB_FRESH, DB_EXISTING, DB_RACE].map(dropDatabase));
  }, 60_000);

  const GOLDEN_AWARDS = sha256Hex(canonicalBytes(buildFieldAwardsBody(1)));
  const GOLDEN_TAGS = sha256Hex(canonicalBytes(buildAircraftTagsBody(1)));

  it("catalogInForce answers a retryable 503 on a database with no valid document (never a silent default)", async () => {
    await withDatabase(DB_RACE, async (_pool, dbs) => {
      await expect(catalogInForce(dbs.db)).rejects.toMatchObject({ status: 503, code: "service_unavailable", headers: { "Retry-After": "5" } }); // retryable, not a plain 500
    });
  });

  it("FRESH database: field-awards v1 and aircraft-tags v1 at once; clipper-cards waits for Military content, then seals v1 once", async () => {
    await withDatabase(DB_FRESH, async (pool, dbs) => {
      expect(await rows(pool)).toEqual([]);
      const first = await seedContentDocuments(dbs);
      expect(first.seeded.sort()).toEqual(["aircraft-tags", "field-awards"]);
      const afterBoot = await rows(pool);
      expect(afterBoot.map((r) => [r.name, r.version, r.created_by])).toEqual([["aircraft-tags", 1, "system:seed"], ["field-awards", 1, "system:seed"]]);
      expect(afterBoot.find((r) => r.name === "field-awards")?.sha256).toBe(GOLDEN_AWARDS);
      expect(afterBoot.find((r) => r.name === "aircraft-tags")?.sha256).toBe(GOLDEN_TAGS);

      // Idempotent: a second boot adds nothing and changes no byte.
      expect((await seedContentDocuments(dbs)).seeded).toEqual([]);
      expect(await rows(pool)).toEqual(afterBoot);

      // Military content arrives after migrating (the first import): now clipper-cards v1 can be sealed, with the items.
      await insertMilitary(pool, [["mil-a1", "Eurofighter Typhoon"], ["mil-a2", "Boeing C-17 Globemaster III"], ["mil-a10", "Eurofighter Typhoon"]]);
      expect((await seedContentDocuments(dbs)).seeded).toEqual(["clipper-cards"]);
      const sealed = (await rows(pool)).find((r) => r.name === "clipper-cards")!;
      expect(sealed.version).toBe(1);
      const body = sealed.body as { cards: { key: string; name: string; itemIds: string[] }[] };
      parseClipperCards(body, 1);
      const typhoon = body.cards.find((c) => c.key === "mil:eurofighter typhoon")!;
      expect(typhoon.itemIds).toEqual(["mil-a1", "mil-a10"]); // natural id order: a2 before a10
      expect(typhoon.name).toBe("Eurofighter Typhoon");
      expect(body.cards.some((c) => c.key === "787")).toBe(true);
      expect(sealed.sha256).toBe(sha256Hex(canonicalBytes(sealed.body))); // jsonb round trip keeps the digest true

      // v1 is sealed: more content later never changes it (a newer version needs a publish, T6).
      const snapshot = await rows(pool);
      await insertMilitary(pool, [["mil-a3", "Lockheed Martin F-16"]]);
      expect((await seedContentDocuments(dbs)).seeded).toEqual([]);
      expect(await rows(pool)).toEqual(snapshot);
    });
  });

  it("EXISTING database (Military content already stored): all three documents at once, and the two code-derived ones are byte-identical to the fresh path", async () => {
    await withDatabase(DB_EXISTING, async (pool, dbs) => {
      await insertMilitary(pool, [["mil-a1", "Eurofighter Typhoon"], ["mil-a2", "Boeing C-17 Globemaster III"]]);
      expect((await seedContentDocuments(dbs)).seeded.sort()).toEqual(["aircraft-tags", "clipper-cards", "field-awards"]);
      const r = await rows(pool);
      expect(r.map((x) => [x.name, x.version])).toEqual([["aircraft-tags", 1], ["clipper-cards", 1], ["field-awards", 1]]);
      expect(r.find((x) => x.name === "field-awards")?.sha256).toBe(GOLDEN_AWARDS);
      expect(r.find((x) => x.name === "aircraft-tags")?.sha256).toBe(GOLDEN_TAGS);
      expect((await militaryCardItems(dbs.db)).map((i) => i.id)).toEqual(["mil-a1", "mil-a2"]);
      expect((await seedContentDocuments(dbs)).seeded).toEqual([]);
      expect(await rows(pool)).toEqual(r);
    });
  });

  // ASSUMPTION (not ruled): retired Military items do not appear in the Card catalog; only approved ones are listed.
  it("ASSUMPTION: only approved Military items go into clipper-cards v1", async () => {
    const name = "airplane_games_seed_status_test";
    await recreateDatabase(name);
    try {
      await withDatabase(name, async (pool, dbs) => {
        await insertMilitary(pool, [["mil-a1", "Eurofighter Typhoon"], ["mil-a2", "Hawker Hurricane"]]);
        await pool.query("UPDATE content_items SET status = 'retired' WHERE id = 'mil-a2'");
        await seedContentDocuments(dbs);
        const cards = ((await rows(pool)).find((r) => r.name === "clipper-cards")!.body as { cards: { key: string }[] }).cards;
        expect(cards.some((c) => c.key === "mil:eurofighter typhoon")).toBe(true);
        expect(cards.some((c) => c.key === "mil:hawker hurricane")).toBe(false);
      });
    } finally {
      await dropDatabase(name);
    }
  });

  it("uses a frozen Card key from the item over one derived from its (later edited) answer", async () => {
    const name = "airplane_games_seed_frozen_test";
    await recreateDatabase(name);
    try {
      await withDatabase(name, async (pool, dbs) => {
        await insertMilitary(pool, [["mil-a1", "Eurofighter Typhoon (typo fixed)"]]);
        await pool.query("UPDATE content_items SET card_key = 'mil:eurofighter typhoon' WHERE id = 'mil-a1'");
        await seedContentDocuments(dbs);
        const cards = ((await rows(pool)).find((r) => r.name === "clipper-cards")!.body as { cards: { key: string; name: string }[] }).cards;
        expect(cards.find((c) => c.key === "mil:eurofighter typhoon")?.name).toBe("Eurofighter Typhoon (typo fixed)");
      });
    } finally {
      await dropDatabase(name);
    }
  });

  it("an over-limit Military item is skipped, not allowed to block the document or the other seeds", async () => {
    const name = "airplane_games_seed_limits_test";
    await recreateDatabase(name);
    try {
      await withDatabase(name, async (pool, dbs) => {
        await insertMilitary(pool, [["mil-a1", "Eurofighter Typhoon"], ["mil-a2", "X".repeat(600)], ["mil-a3", "Hawker Hurricane"]]);
        // 1002 items on one Card key: the 1001st and 1002nd exceed the per-Card limit.
        await pool.query(
          "INSERT INTO content_items (module, id, rank, status, source, data, version, created_at, updated_at, updated_by) " +
            "SELECT 'aircraft-identifier-military', 'mil-b' || g, 'trainee', 'approved', 'client_sheet', " +
            "'{\"answer\":\"Same Answer\",\"wrong\":[\"a\",\"b\",\"c\"],\"sourceFile\":\"f.jpg\"}'::jsonb, 1, now(), now(), 'test' FROM generate_series(1, 1002) g",
        );
        const result = await seedContentDocuments(dbs);
        expect(result.failed).toEqual([]);
        expect(result.seeded.sort()).toEqual(["aircraft-tags", "clipper-cards", "field-awards"]);
        const sealed = (await rows(pool)).find((r) => r.name === "clipper-cards")!;
        const body = sealed.body as { cards: { key: string; itemIds: string[] }[] };
        parseClipperCards(body, 1);
        expect(body.cards.some((c) => c.itemIds.includes("mil-a2"))).toBe(false);
        expect(body.cards.find((c) => c.key === "mil:same answer")?.itemIds).toHaveLength(1000);
        const note = (await pool.query("SELECT note FROM content_documents WHERE name = 'clipper-cards'")).rows[0].note as string;
        expect(note).toContain("1005 approved");
        expect(note).toContain("1002 sealed");
        expect(note).toContain("3 skipped");
        expect((await rows(pool)).map((r) => r.name)).toEqual(["aircraft-tags", "clipper-cards", "field-awards"]);
      });
    } finally {
      await dropDatabase(name);
    }
  });

  it("only over-limit Military items: clipper-cards waits, the other two are sealed", async () => {
    const name = "airplane_games_seed_oversize_test";
    await recreateDatabase(name);
    try {
      await withDatabase(name, async (pool, dbs) => {
        await insertMilitary(pool, [["mil-a1", "Y".repeat(600)]]);
        expect((await seedContentDocuments(dbs)).seeded.sort()).toEqual(["aircraft-tags", "field-awards"]);
      });
    } finally {
      await dropDatabase(name);
    }
  });

  it("each name is seeded in its own savepoint: one that fails cannot take the others down, and the manifest lists what exists", async () => {
    const name = "airplane_games_seed_isolate_test";
    await recreateDatabase(name);
    try {
      await withDatabase(name, async (pool, dbs) => {
        await pool.query("ALTER TABLE content_documents ADD CONSTRAINT boom CHECK (name <> 'aircraft-tags')");
        await insertMilitary(pool, [["mil-a1", "Eurofighter Typhoon"]]);
        const result = await seedContentDocuments(dbs);
        expect(result.failed).toEqual(["aircraft-tags"]);
        expect(result.seeded.sort()).toEqual(["clipper-cards", "field-awards"]);
        expect((await rows(pool)).map((r) => r.name)).toEqual(["clipper-cards", "field-awards"]);
        process.env["DATABASE_URL"] = urlOf(name);
        const built = await buildApp();
        const res = await request(built.server).get(MANIFEST).set(bearer());
        expect(res.status).toBe(200);
        expect(res.body.documents.map((d: { name: string }) => d.name)).toEqual(["clipper-cards", "field-awards"]);
        await built.app.close();
        apps.splice(apps.indexOf(built.app), 1);
      });
    } finally {
      restoreEnv();
      await dropDatabase(name);
    }
  });

  it("an empty table at manifest time: the manifest seeds once and lists the documents; it never errors", async () => {
    const name = "airplane_games_seed_empty_test";
    await recreateDatabase(name);
    try {
      process.env["DATABASE_URL"] = urlOf(name);
      const built = await buildApp();
      await withDatabase(name, async (pool) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("ALTER TABLE content_documents DISABLE TRIGGER content_documents_immutable");
          await client.query("DELETE FROM content_documents");
          await client.query("ALTER TABLE content_documents ENABLE TRIGGER content_documents_immutable");
          await client.query("COMMIT");
        } finally {
          client.release();
        }
        const res = await request(built.server).get(MANIFEST).set(bearer());
        expect(res.status).toBe(200);
        expect(res.body.documents.map((d: { name: string }) => d.name)).toEqual(["aircraft-tags", "field-awards"]);
      });
      await built.app.close();
      apps.splice(apps.indexOf(built.app), 1);
    } finally {
      restoreEnv();
      await dropDatabase(name);
    }
  });

  it("concurrent boots on a fresh database seed each document exactly once, without an error", async () => {
    await withDatabase(DB_RACE, async (pool, dbs) => {
      await insertMilitary(pool, [["mil-a1", "Eurofighter Typhoon"]]);
      const results = await Promise.all(Array.from({ length: 8 }, () => seedContentDocuments(dbs)));
      expect(results.flatMap((r) => r.seeded).sort()).toEqual(["aircraft-tags", "clipper-cards", "field-awards"]);
      expect((await rows(pool)).map((x) => [x.name, x.version])).toEqual([["aircraft-tags", 1], ["clipper-cards", 1], ["field-awards", 1]]);
    });
  });

  it("two application instances booting at once on a fresh database both come up and agree", async () => {
    const name = "airplane_games_seed_boot_test";
    await recreateDatabase(name);
    try {
      process.env["DATABASE_URL"] = urlOf(name);
      const [a, b] = await Promise.all([buildApp(), buildApp()]);
      const [ma, mb] = await Promise.all([request(a.server).get(MANIFEST).set(bearer()), request(b.server).get(MANIFEST).set(bearer())]);
      expect(ma.status).toBe(200);
      expect(ma.text).toBe(mb.text);
      expect(ma.body.documents.map((d: { name: string }) => d.name)).toEqual(["aircraft-tags", "field-awards"]); // no Military content yet
      await Promise.all([a.app.close(), b.app.close()]);
      apps.splice(apps.indexOf(a.app), 1);
      apps.splice(apps.indexOf(b.app), 1);
    } finally {
      restoreEnv();
      await dropDatabase(name);
    }
  });

  it("FRESH app: the first successful import seals clipper-cards v1 and the manifest version changes; a replay changes nothing", async () => {
    const name = "airplane_games_seed_import_test";
    await recreateDatabase(name);
    try {
      process.env["DATABASE_URL"] = urlOf(name);
      const seeder = new pg.Pool({ connectionString: urlOf(name) });
      await seedAdmins(seeder, "staff").finally(() => seeder.end());
      const fresh = await buildApp();
      const player = bearer();
      const before = (await request(fresh.server).get(MANIFEST).set(player)).body;
      expect(before.documents.map((d: { name: string }) => d.name)).toEqual(["aircraft-tags", "field-awards"]);
      expect((await request(fresh.server).get(doc("clipper-cards", 1)).set(player)).status).toBe(404);

      const sheet = await clientSheet(31);
      const imported = await request(fresh.server)
        .post("/v1/admin/content/aircraft-identifier-military/imports")
        .set(staff)
        .set("Content-Type", XLSX_MIME)
        .send(sheet);
      expect(imported.status, JSON.stringify(imported.body)).toBe(201);

      const after = (await request(fresh.server).get(MANIFEST).set(player)).body;
      expect(after.documents.map((d: { name: string }) => d.name)).toEqual(["aircraft-tags", "clipper-cards", "field-awards"]);
      expect(after.version).not.toBe(before.version);
      const cardsRes = await request(fresh.server).get(doc("clipper-cards", 1)).set(player);
      expect(cardsRes.status).toBe(200);
      const cards = JSON.parse(cardsRes.text) as { cards: { key: string; module: string; itemIds: string[] }[] };
      parseClipperCards(cards, 1);
      expect(cards.cards.filter((c) => c.module === "aircraft-identifier-military").flatMap((c) => c.itemIds)).toHaveLength(31); // every item is in one Card
      expect(sha256Hex(rawBody(cardsRes))).toBe(after.documents.find((d: { name: string }) => d.name === "clipper-cards").sha256);

      const replay = await request(fresh.server)
        .post("/v1/admin/content/aircraft-identifier-military/imports")
        .set(staff)
        .set("Content-Type", XLSX_MIME)
        .send(sheet);
      expect(replay.status).toBe(200);
      expect((await request(fresh.server).get(MANIFEST).set(player)).body.version).toBe(after.version);
      await fresh.app.close();
      apps.splice(apps.indexOf(fresh.app), 1);

      // A restart on that database (now an "existing" one) seeds nothing and serves the same manifest.
      const restarted = await buildApp();
      expect((await request(restarted.server).get(MANIFEST).set(player)).text).toBe(JSON.stringify(after));
    } finally {
      restoreEnv();
      await dropDatabase(name);
    }
  }, 60_000);

  it("latestDocuments and the builder agree on shape (the Card catalog stays valid with no Military content)", async () => {
    await withDatabase(DB_FRESH, async (_pool, dbs) => {
      expect((await documentsInForce(dbs.db)).map((d) => d.name)).toEqual(["aircraft-tags", "clipper-cards", "field-awards"]);
    });
    expect(() => parseClipperCards(buildClipperCardsBody(1, []), 1)).not.toThrow();
  });
});
