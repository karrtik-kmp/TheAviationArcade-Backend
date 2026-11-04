import { createHash, randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { normaliseMediaDescription } from "../src/content/media/media-description.js";
import { BLOB_STORE } from "../src/storage/blob-store.js";
import { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";

// Wave R (docs/plans/media-rights-and-public.md): rights statement on upload, owner-only file uploads, PUT rights, the publish
// gate, the staff-only description. Roles are seeded in account_roles; the blob store is the in-process MemoryBlobStore.

const PATH = "/v1/admin/media";
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A minimal valid PNG; `extra` varies the bytes (an ancillary chunk after IHDR). */
function png(extra: number): Buffer {
  const ancillary = [...be32(extra), 0x74, 0x45, 0x58, 0x74, ...Array<number>(extra).fill(65), 0, 0, 0, 0];
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(64), ...be32(48), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...ancillary,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bearer = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid, "demo-airplane-games", "password")}` });
let keyCounter = 0;
const newKey = () => `r-${randomUUID().slice(0, 8)}-${keyCounter++}`;
let bytesCounter = 0;
const freshPng = () => png(2000 + ++bytesCounter + Math.floor(Math.random() * 1e5) * 10);
const idOf = (id: string) => Number(id.slice(4));

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;
const principals: string[] = [];

type Actor = { uid: string; principal: string; auth: { Authorization: string } };

async function actor(role: "photographer" | "admin" | null): Promise<Actor> {
  const uid = `mediar-${role ?? "none"}-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  principals.push(principal);
  if (role) await seedRole(sql, principal, role);
  return { uid, principal, auth: bearer(uid) };
}

type Item = { id: string; state: string; revision: number; draftVersion: number; publishedVersion: number | null; draft: Record<string, any>; owner?: string };

const upload = (who: Actor, bytes: Buffer, o: { key?: string; statement?: string | null } = {}) => {
  let req = request(server).post(PATH).set(who.auth).set("Content-Type", "image/png").set("Idempotency-Key", o.key ?? newKey());
  if (o.statement !== null) req = req.set("X-Rights-Statement", o.statement ?? "v1_own");
  return req.send(bytes);
};
const addVersion = (who: Actor, id: string, revision: number, bytes: Buffer, o: { key?: string; statement?: string | null } = {}) => {
  let req = request(server).post(`${PATH}/${id}/versions?revision=${revision}`).set(who.auth).set("Content-Type", "image/png").set("Idempotency-Key", o.key ?? newKey());
  if (o.statement !== null) req = req.set("X-Rights-Statement", o.statement ?? "v1_own");
  return req.send(bytes);
};
const patch = (who: Actor, id: string, body: unknown) => request(server).patch(`${PATH}/${id}`).set(who.auth).send(body as object);
const publish = (who: Actor, id: string, body: unknown) => request(server).post(`${PATH}/${id}/publish`).set(who.auth).send(body as object);
const withdraw = (who: Actor, id: string, body: unknown) => request(server).post(`${PATH}/${id}/withdraw`).set(who.auth).send(body as object);
const putRights = (who: Actor, id: string, body: unknown) => request(server).put(`${PATH}/${id}/rights`).set(who.auth).send(body as object);
const detail = (who: Actor, id: string) => request(server).get(`${PATH}/${id}`).set(who.auth);

const FULL_LICENCE = { credit: "A. Photographer", licenceName: "CC BY 4.0", licenceUrl: "https://creativecommons.org/licenses/by/4.0/", creditRequired: true };

async function licensedItem(owner: Actor, statement = "v1_own"): Promise<Item> {
  const created = await upload(owner, freshPng(), { statement });
  expect(created.status).toBe(201);
  const edited = await patch(owner, created.body.id, { revision: created.body.revision, licence: FULL_LICENCE });
  expect(edited.status).toBe(200);
  return edited.body as Item;
}

const count = async (table: string, where = "", params: unknown[] = []) =>
  (await sql.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} ${where}`, params)).rows[0]?.n;
const versionsOf = (id: string) => count("media_versions", "WHERE media_id = $1", [idOf(id)]);
const auditOf = (id: string, action: string) => count("admin_audit", "WHERE target = $1 AND action = $2", [id, action]);
const itemRow = async (id: string) => (await sql.query("SELECT * FROM media_items WHERE id = $1", [idOf(id)])).rows[0];
const versionRow = async (id: string, version: number) =>
  (await sql.query("SELECT * FROM media_versions WHERE media_id = $1 AND version = $2", [idOf(id), version])).rows[0];

interface RawItem {
  state?: "unverified" | "published" | "withdrawn";
  draft?: number;
  published?: number | null;
  rights?: string | null;
  everPublished?: boolean;
}

/**
 * An item written as raw SQL, the way an old (pre-0019) or imported one looks: `rights` null = no statement. Its draft version
 * carries a publishable licence. A published row without a statement needs the NOT VALID constraint out of the way for the insert.
 */
async function rawItem(owner: Actor, o: RawItem = {}): Promise<string> {
  const rights = o.rights === undefined ? null : o.rights;
  const state = o.state ?? "unverified";
  const draft = o.draft ?? 1;
  const published = o.published === undefined ? (state === "published" ? draft : null) : o.published;
  const stamp = rights === null ? null : "clock_timestamp()";
  const by = rights === null ? null : owner.principal;
  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    const def = (await client.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'media_versions_publishable_check'")).rows[0]!.def.replace(/ NOT VALID$/, "");
    await client.query("ALTER TABLE media_versions DROP CONSTRAINT media_versions_publishable_check");
    const item = await client.query<{ id: string }>(
      `INSERT INTO media_items (owner, state, draft_version, published_version, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $1, $1, clock_timestamp(), clock_timestamp()) RETURNING id`,
      [owner.principal, state, draft, published],
    );
    const id = Number(item.rows[0]!.id);
    for (let v = 1; v <= draft; v += 1) {
      const live = (o.everPublished === true && v === draft) || v === published;
      const bytes = freshPng();
      await client.query(
        `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_name, credit_required, licence_name,
            published_at, created_by, created_at, rights_statement, rights_stated_by, rights_stated_at)
         VALUES ($1, $2, $3, 'image/png', $4, 64, 48, 'Raw Credit', true, 'CC BY 4.0', ${live ? "clock_timestamp()" : "NULL"}, $5, clock_timestamp(), $6, $7, ${stamp ?? "NULL"})`,
        [id, v, sha(bytes), bytes.length, owner.principal, rights, by],
      );
    }
    await client.query(`ALTER TABLE media_versions ADD CONSTRAINT media_versions_publishable_check ${def} NOT VALID`);
    await client.query("COMMIT");
    return `med-${id}`;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Every key anywhere in a JSON value. */
function keysDeep(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, into));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysDeep(v, into);
    }
  }
  return into;
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  app.get<MemoryBlobStore>(BLOB_STORE);
});

afterAll(async () => {
  const owned = "(SELECT id FROM media_items WHERE owner = ANY($1))";
  await sql.query(`DELETE FROM media_upload_keys WHERE media_id IN ${owned}`, [principals]);
  await sql.query(`DELETE FROM media_versions WHERE media_id IN ${owned}`, [principals]);
  await sql.query("DELETE FROM media_items WHERE owner = ANY($1)", [principals]);
  await sql.query("DELETE FROM admin_audit WHERE actor = ANY($1)", [principals]);
  await sql.query("DELETE FROM account_roles WHERE principal = ANY($1)", [principals]);
  await sql.end();
  await app.close();
});

describe("R2: X-Rights-Statement on upload", () => {
  it("a missing or unknown header is 400 invalid_request on both uploads and nothing is stored", async () => {
    const photographer = await actor("photographer");
    for (const statement of [null, "", "own", "V1_OWN", "v1_own,v1_own", "d1_private_review", "v2_own"]) {
      const res = await upload(photographer, freshPng(), { statement });
      expect(res.status, String(statement)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    const made = await upload(photographer, freshPng());
    expect(made.status).toBe(201);
    for (const statement of [null, "d1_private_review", "nope"]) {
      const res = await addVersion(photographer, made.body.id, made.body.revision, freshPng(), { statement });
      expect(res.status, String(statement)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    expect(await versionsOf(made.body.id)).toBe(1);
    expect(await count("media_items", "WHERE owner = $1", [photographer.principal])).toBe(1);
  });

  it("stores the statement with the uploader and the database time, and shows it to staff (statedBy to admins only)", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const own = await upload(photographer, freshPng(), { statement: "v1_authorised" });
    expect(own.status).toBe(201);
    expect(own.body.draft.rights).toEqual({ statement: "v1_authorised", statedAt: expect.any(String) });
    expect(own.body.draft.rights.statedBy).toBeUndefined();
    const stored = await versionRow(own.body.id, 1);
    expect(stored).toMatchObject({ rights_statement: "v1_authorised", rights_stated_by: photographer.principal });
    expect(stored.rights_stated_at.toISOString()).toBe(own.body.draft.rights.statedAt);

    const asAdmin = await detail(admin, own.body.id);
    expect(asAdmin.body.item.draft.rights).toMatchObject({ statement: "v1_authorised", statedBy: photographer.principal });
    expect(asAdmin.body.versions[0].rights.statedBy).toBe(photographer.principal);
    const asOwner = await detail(photographer, own.body.id);
    expect(keysDeep(asOwner.body).has("statedBy")).toBe(false);
    const audit = await sql.query("SELECT detail FROM admin_audit WHERE target = $1 AND action = 'media_upload'", [own.body.id]);
    expect(audit.rows[0].detail).toMatchObject({ rightsStatement: "v1_authorised" });
  });

  it("POST versions is owner only: a non-owner admin gets 403 forbidden, a non-owner photographer 404, and nothing is claimed", async () => {
    const owner = await actor("photographer");
    const other = await actor("photographer");
    const admin = await actor("admin");
    const made = await upload(owner, freshPng());
    const adminKey = newKey();
    const asAdmin = await addVersion(admin, made.body.id, made.body.revision, freshPng(), { key: adminKey });
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.error.code).toBe("forbidden");
    const asOther = await addVersion(other, made.body.id, made.body.revision, freshPng());
    expect(asOther.status).toBe(404);
    expect(await versionsOf(made.body.id)).toBe(1);
    expect(await count("media_upload_keys", "WHERE principal = $1", [admin.principal])).toBe(0);
    const asOwner = await addVersion(owner, made.body.id, made.body.revision, freshPng());
    expect(asOwner.status).toBe(201);
  });

  it("create replay: the same key, bytes and statement is 200; another statement is 422 idempotency_key_reused", async () => {
    const photographer = await actor("photographer");
    const bytes = freshPng();
    const key = newKey();
    const first = await upload(photographer, bytes, { key, statement: "v1_own" });
    expect(first.status).toBe(201);
    const again = await upload(photographer, bytes, { key, statement: "v1_own" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    const changed = await upload(photographer, bytes, { key, statement: "v1_authorised" });
    expect(changed.status).toBe(422);
    expect(changed.body.error.code).toBe("idempotency_key_reused");
    expect(await count("media_items", "WHERE owner = $1", [photographer.principal])).toBe(1);
  });

  it("version replay: the same key, bytes and statement is 200; another statement is 422 idempotency_key_reused", async () => {
    const photographer = await actor("photographer");
    const made = await upload(photographer, freshPng());
    const bytes = freshPng();
    const key = newKey();
    const first = await addVersion(photographer, made.body.id, made.body.revision, bytes, { key, statement: "v1_authorised" });
    expect(first.status).toBe(201);
    const again = await addVersion(photographer, made.body.id, made.body.revision, bytes, { key, statement: "v1_authorised" });
    expect(again.status).toBe(200);
    const changed = await addVersion(photographer, made.body.id, made.body.revision, bytes, { key, statement: "v1_own" });
    expect(changed.status).toBe(422);
    expect(changed.body.error.code).toBe("idempotency_key_reused");
    expect(await versionsOf(made.body.id)).toBe(2);
  });
});

describe("R3: statement and description across versions", () => {
  it("a licence-only edit of a published item makes a new version that keeps the statement, stater and description", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer, "v1_authorised");
    const described = await patch(photographer, item.id, { revision: item.revision, description: "Piper over the bay" });
    expect(described.status).toBe(200);
    const live = await publish(admin, item.id, { revision: described.body.revision });
    expect(live.status).toBe(200);

    const edited = await patch(photographer, item.id, { revision: live.body.revision, licence: { credit: "B. Photographer" } });
    expect(edited.status).toBe(200);
    expect(edited.body.draftVersion).toBe(2);
    expect(edited.body.draft.description).toBe("Piper over the bay");
    const v1 = await versionRow(item.id, 1);
    const v2 = await versionRow(item.id, 2);
    expect(v2).toMatchObject({ rights_statement: "v1_authorised", rights_stated_by: photographer.principal, description: "Piper over the bay" });
    expect(v2.rights_stated_at.toISOString()).toBe(v1.rights_stated_at.toISOString());
  });

  it("an in-place edit of an unpublished draft never touches the statement", async () => {
    const photographer = await actor("photographer");
    const made = await upload(photographer, freshPng(), { statement: "v1_authorised" });
    const before = await versionRow(made.body.id, 1);
    const edited = await patch(photographer, made.body.id, { revision: made.body.revision, licence: FULL_LICENCE, description: "x" });
    expect(edited.status).toBe(200);
    expect(edited.body.draftVersion).toBe(1);
    const after = await versionRow(made.body.id, 1);
    expect(after).toMatchObject({ rights_statement: "v1_authorised", rights_stated_by: before.rights_stated_by, description: "x" });
    expect(after.rights_stated_at.toISOString()).toBe(before.rights_stated_at.toISOString());
  });

  it("a new file version copies the description forward, not the licence, and takes its own statement from the header", async () => {
    const photographer = await actor("photographer");
    const item = await licensedItem(photographer, "v1_own");
    const described = await patch(photographer, item.id, { revision: item.revision, description: "Line one\nLine two" });
    const res = await addVersion(photographer, item.id, described.body.revision, freshPng(), { statement: "v1_authorised" });
    expect(res.status).toBe(201);
    expect(res.body.draft.description).toBe("Line one\nLine two");
    expect(res.body.draft.licence).toMatchObject({ credit: null, licenceName: null });
    expect(res.body.draft.rights.statement).toBe("v1_authorised");
    expect((await versionRow(item.id, 1)).rights_statement).toBe("v1_own"); // the earlier version is not rewritten
  });
});

describe("R4: PUT /v1/admin/media/{id}/rights", () => {
  it("the owner states rights on a draft without one (null, or the import's d1_private_review): 200, in place, revision + 1, one audit row", async () => {
    const owner = await actor("photographer");
    for (const [n, existing] of [null, "d1_private_review"].entries()) {
      const id = await rawItem(owner, { rights: existing });
      const before = await itemRow(id);
      const res = await putRights(owner, id, { revision: before.revision, statement: n === 0 ? "v1_own" : "v1_authorised" });
      expect(res.status, String(existing)).toBe(200);
      expect(res.body.revision).toBe(before.revision + 1);
      expect(res.body.draftVersion).toBe(1);
      expect(res.body.draft.rights).toMatchObject({ statement: n === 0 ? "v1_own" : "v1_authorised" });
      expect(await versionsOf(id)).toBe(1);
      expect(await versionRow(id, 1)).toMatchObject({
        rights_statement: n === 0 ? "v1_own" : "v1_authorised",
        rights_stated_by: owner.principal,
      });
      expect(await auditOf(id, "media_rights")).toBe(1);
      const audit = await sql.query("SELECT detail FROM admin_audit WHERE target = $1 AND action = 'media_rights'", [id]);
      expect(audit.rows[0].detail).toMatchObject({ statement: n === 0 ? "v1_own" : "v1_authorised", previousStatement: existing, revision: before.revision + 1 });
    }
  });

  it("a non-owner admin gets 403 forbidden, a non-owner photographer 404, nothing changes; an unknown item is 404", async () => {
    const owner = await actor("photographer");
    const other = await actor("photographer");
    const admin = await actor("admin");
    const id = await rawItem(owner);
    const before = await itemRow(id);
    const asAdmin = await putRights(admin, id, { revision: before.revision, statement: "v1_own" });
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.error.code).toBe("forbidden");
    expect((await putRights(other, id, { revision: before.revision, statement: "v1_own" })).status).toBe(404);
    expect((await putRights(owner, "med-999999999", { revision: 1, statement: "v1_own" })).status).toBe(404);
    expect((await putRights(owner, "not-an-id", { revision: 1, statement: "v1_own" })).status).toBe(404);
    expect((await itemRow(id)).revision).toBe(before.revision);
    expect((await versionRow(id, 1)).rights_statement).toBeNull();
    expect(await auditOf(id, "media_rights")).toBe(0);
  });

  it("an admin who owns the item may state rights", async () => {
    const admin = await actor("admin");
    const id = await rawItem(admin);
    const res = await putRights(admin, id, { revision: 1, statement: "v1_own" });
    expect(res.status).toBe(200);
    expect(res.body.draft.rights.statedBy).toBe(admin.principal);
  });

  it("a stale revision is 409 version_conflict (checked before eligibility)", async () => {
    const owner = await actor("photographer");
    const id = await rawItem(owner);
    const stale = await putRights(owner, id, { revision: 7, statement: "v1_own" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    const stated = await upload(owner, freshPng());
    const staleAndStated = await putRights(owner, stated.body.id, { revision: 99, statement: "v1_own" });
    expect(staleAndStated.body.error.code).toBe("version_conflict");
    expect(await auditOf(id, "media_rights")).toBe(0);
  });

  it("409 rights_already_stated when the draft has a v1 statement, was published, or is the published version", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const stated = await upload(owner, freshPng());
    const again = await putRights(owner, stated.body.id, { revision: stated.body.revision, statement: "v1_authorised" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("rights_already_stated");

    // The draft IS the published version (an old row without a statement).
    const livePre = await rawItem(owner, { state: "published", rights: null });
    const live = await putRights(owner, livePre, { revision: 1, statement: "v1_own" });
    expect(live.status).toBe(409);
    expect(live.body.error.code).toBe("rights_already_stated");

    // The draft was published once and withdrawn (draft version != published version, but published_at is set).
    const wasLive = await rawItem(owner, { state: "withdrawn", published: null, rights: "d1_private_review", everPublished: true });
    const withdrawn = await putRights(owner, wasLive, { revision: 1, statement: "v1_own" });
    expect(withdrawn.status).toBe(409);
    expect(withdrawn.body.error.code).toBe("rights_already_stated");

    // A newer, never-published draft WITHOUT a statement on a published item is eligible (the live version is not touched).
    const olderLive = await rawItem(owner, { state: "published", draft: 2, published: 1, rights: null });
    const eligible = await putRights(owner, olderLive, { revision: 1, statement: "v1_own" });
    expect(eligible.status).toBe(200);
    expect(eligible.body.publishedVersion).toBe(1);
    expect(eligible.body.draftVersion).toBe(2);
    expect(await auditOf(olderLive, "media_rights")).toBe(1);

    // A newer draft made by an upload already carries its uploader's v1 statement, so it is not eligible.
    const published = await licensedItem(owner);
    const pub = await publish(admin, published.id, { revision: published.revision });
    const moved = await addVersion(owner, published.id, pub.body.revision, freshPng());
    expect(moved.status).toBe(201);
    expect((await putRights(owner, published.id, { revision: moved.body.revision, statement: "v1_own" })).body.error.code).toBe("rights_already_stated");

    for (const res of [again, live, withdrawn]) expect(res.body.error.message).toMatch(/Nothing was changed/);
    expect(await auditOf(stated.body.id, "media_rights")).toBe(0);
  });

  it("rejects bad bodies: d1_private_review, unknown statements, missing or extra keys, a query string", async () => {
    const owner = await actor("photographer");
    const id = await rawItem(owner);
    for (const body of [
      { revision: 1, statement: "d1_private_review" },
      { revision: 1, statement: "own" },
      { revision: 1 },
      { statement: "v1_own" },
      { revision: 1, statement: "v1_own", extra: true },
      { revision: "1", statement: "v1_own" },
    ]) {
      const res = await putRights(owner, id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    const withQuery = await request(server).put(`${PATH}/${id}/rights?x=1`).set(owner.auth).send({ revision: 1, statement: "v1_own" });
    expect(withQuery.status).toBe(400);
    expect((await versionRow(id, 1)).rights_statement).toBeNull();
  });

  it("two concurrent calls at one revision: one 200, one 409, one audit row", async () => {
    const owner = await actor("photographer");
    const id = await rawItem(owner);
    const results = await Promise.all([
      putRights(owner, id, { revision: 1, statement: "v1_own" }),
      putRights(owner, id, { revision: 1, statement: "v1_authorised" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await auditOf(id, "media_rights")).toBe(1);
    expect((await itemRow(id)).revision).toBe(2);
    const winner = results.find((r) => r.status === 200)!;
    expect((await versionRow(id, 1)).rights_statement).toBe(winner.body.draft.rights.statement);
  });
});

describe("R5: the publish gate", () => {
  it("a draft without a v1 statement is 422 content_invalid and nothing changes; after PUT rights it publishes", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    for (const rights of [null, "d1_private_review"]) {
      const id = await rawItem(owner, { rights });
      const res = await publish(admin, id, { revision: 1 });
      expect(res.status, String(rights)).toBe(422);
      expect(res.body.error.code).toBe("content_invalid");
      expect(res.body.error.message).toMatch(/rights statement/);
      expect(await itemRow(id)).toMatchObject({ state: "unverified", revision: 1, published_version: null });
      expect((await versionRow(id, 1)).published_at).toBeNull();
      expect((await putRights(owner, id, { revision: 1, statement: "v1_own" })).status).toBe(200);
      const ok = await publish(admin, id, { revision: 2 });
      expect(ok.status).toBe(200);
      expect(ok.body.state).toBe("published");
    }
  });

  it("a pre-0019 published row (no statement): withdraw works, publish again is 422 (not a database error) and changes nothing", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const id = await rawItem(owner, { state: "published", rights: null });
    const old = await versionRow(id, 1);
    expect(old.published_at).not.toBeNull();
    const out = await withdraw(admin, id, { revision: 1 });
    expect(out.status).toBe(200);
    const again = await publish(admin, id, { revision: out.body.revision });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe("content_invalid");
    expect(await itemRow(id)).toMatchObject({ state: "withdrawn", revision: 2, published_version: null });
    expect((await versionRow(id, 1)).published_at.toISOString()).toBe(old.published_at.toISOString());
    expect(await auditOf(id, "media_publish")).toBe(0);
  });
});

describe("R6: description", () => {
  it("a description-only PATCH changes the draft in place and is audited; the same value again is a no-op", async () => {
    const photographer = await actor("photographer");
    const made = await upload(photographer, freshPng());
    const res = await patch(photographer, made.body.id, { revision: made.body.revision, description: "  A Cessna on final  " });
    expect(res.status).toBe(200);
    expect(res.body.draft.description).toBe("A Cessna on final");
    expect(res.body.revision).toBe(made.body.revision + 1);
    expect(res.body.draftVersion).toBe(1);
    const audit = await sql.query("SELECT detail FROM admin_audit WHERE target = $1 AND action = 'media_edit'", [made.body.id]);
    expect(audit.rows[0].detail.changes).toEqual({ description: { from: null, to: "A Cessna on final" } });

    const same = await patch(photographer, made.body.id, { revision: res.body.revision, description: "A Cessna on final" });
    expect(same.status).toBe(200);
    expect(same.body.revision).toBe(res.body.revision);
    expect(await auditOf(made.body.id, "media_edit")).toBe(1);

    const cleared = await patch(photographer, made.body.id, { revision: res.body.revision, description: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.draft.description).toBeNull();
  });

  it("PATCH needs at least one of licence and description", async () => {
    const photographer = await actor("photographer");
    const made = await upload(photographer, freshPng());
    for (const body of [{ revision: made.body.revision }, { revision: made.body.revision, note: "hi" }, { revision: made.body.revision, licence: {} }]) {
      const res = await patch(photographer, made.body.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    const both = await patch(photographer, made.body.id, { revision: made.body.revision, licence: { credit: "C" }, description: "D" });
    expect(both.status).toBe(200);
    expect(both.body.draft).toMatchObject({ description: "D", licence: { credit: "C" } });
  });

  it("normalises CRLF to LF and keeps newlines; refuses tabs, lone CR and other control characters, empty and over-long text", async () => {
    const photographer = await actor("photographer");
    const made = await upload(photographer, freshPng());
    const ok = await patch(photographer, made.body.id, { revision: made.body.revision, description: "one\r\ntwo\nthree" });
    expect(ok.status).toBe(200);
    expect(ok.body.draft.description).toBe("one\ntwo\nthree");
    expect((await versionRow(made.body.id, 1)).description).toBe("one\ntwo\nthree");

    // Leading and trailing control characters are refused too, never trimmed away.
    for (const bad of ["a\tb", "a\rb", "a\u0000b", "a\u001bb", "a\u0085b", "\ta", "a\t", "a\r", "\u000ba", "", "   ", "x".repeat(2001), 5, ["x"]]) {
      const res = await patch(photographer, made.body.id, { revision: ok.body.revision, description: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    const max = await patch(photographer, made.body.id, { revision: ok.body.revision, description: "x".repeat(2000) });
    expect(max.status).toBe(200);
    const emoji = await patch(photographer, made.body.id, { revision: max.body.revision, description: "\u{1F6E9}".repeat(2000) });
    expect(emoji.status).toBe(200); // code points, not UTF-16 units
  });

  it("the shared validator (reused by the D1 import) gives the same answers", () => {
    expect(normaliseMediaDescription(" a\r\nb ")).toBe("a\nb");
    expect(normaliseMediaDescription("a\tb")).toBeNull();
    expect(normaliseMediaDescription("a\rb")).toBeNull();
    expect(normaliseMediaDescription("")).toBeNull();
    expect(normaliseMediaDescription("x".repeat(2001))).toBeNull();
    expect(normaliseMediaDescription("x".repeat(2000))).toBe("x".repeat(2000));
  });

  it("an admin may edit another photographer's description; another photographer may not (404)", async () => {
    const owner = await actor("photographer");
    const other = await actor("photographer");
    const admin = await actor("admin");
    const made = await upload(owner, freshPng());
    expect((await patch(other, made.body.id, { revision: made.body.revision, description: "no" })).status).toBe(404);
    const res = await patch(admin, made.body.id, { revision: made.body.revision, description: "Edited by staff" });
    expect(res.status).toBe(200);
    expect(res.body.draft.description).toBe("Edited by staff");
  });

  it("a description edit of a published item makes a new version (the live one is untouched)", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer);
    const live = await publish(admin, item.id, { revision: item.revision });
    const edited = await patch(photographer, item.id, { revision: live.body.revision, description: "Added later" });
    expect(edited.status).toBe(200);
    expect(edited.body.draftVersion).toBe(2);
    expect(edited.body.publishedVersion).toBe(1);
    expect((await versionRow(item.id, 1)).description).toBeNull();
    expect((await versionRow(item.id, 2)).description).toBe("Added later");
  });

  it("neither ImageRef routes (signed-in, guest) nor the player-visible shapes carry description, rights or statedBy; staff views do", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer, "v1_authorised");
    const described = await patch(photographer, item.id, { revision: item.revision, description: "Secret staff note" });
    const live = await publish(admin, item.id, { revision: described.body.revision });
    expect(live.status).toBe(200);

    const signedIn = await request(server).get(`/v1/media?ids=${item.id}`).set(photographer.auth);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.images).toHaveLength(1);
    const guest = await request(server).get(`/v1/public/media?ids=${item.id}`);
    expect(guest.status).toBe(200);
    expect(guest.body.images).toHaveLength(1);
    expect(guest.body).toEqual(signedIn.body);
    for (const body of [signedIn.body, guest.body]) {
      const keys = keysDeep(body);
      for (const forbidden of ["description", "rights", "statedBy", "statedAt", "statement", "owner", "createdBy"]) expect(keys.has(forbidden), forbidden).toBe(false);
      expect(JSON.stringify(body)).not.toMatch(/Secret staff note|v1_authorised|firebase:/);
    }

    // Staff: the owner sees description and rights without statedBy; an admin also sees statedBy.
    const asOwner = await detail(photographer, item.id);
    expect(asOwner.body.item.draft).toMatchObject({ description: "Secret staff note", rights: { statement: "v1_authorised" } });
    expect(keysDeep(asOwner.body).has("statedBy")).toBe(false);
    const asAdmin = await detail(admin, item.id);
    expect(asAdmin.body.item.draft.rights.statedBy).toBe(photographer.principal);
    const list = await request(server).get(PATH).set(photographer.auth);
    expect(keysDeep(list.body).has("statedBy")).toBe(false);
    expect(list.body.items.find((i: Item) => i.id === item.id).draft.description).toBe("Secret staff note");
  });
});
