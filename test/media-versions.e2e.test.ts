import { createHash, randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { BLOB_STORE, StorageUnavailableError } from "../src/storage/blob-store.js";
import { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";
import { unfinishedUpload } from "./upload-helpers.js";

// Media plan T4 (docs/plans/media-pipeline.md): new version, licence edit, publish, withdraw. Roles are seeded in account_roles; the
// blob store is the in-process MemoryBlobStore. Every test uses fresh owners, and the suite deletes only its own rows.

const PATH = "/v1/admin/media";
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];

/** A minimal valid PNG; `extra` varies the bytes (an ancillary chunk after IHDR). */
function png(w = 64, h = 48, extra = 0): Buffer {
  const ancillary = extra === 0 ? [] : [...be32(extra), 0x74, 0x45, 0x58, 0x74, ...Array<number>(extra).fill(65), 0, 0, 0, 0];
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...ancillary,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bearer = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid, "demo-airplane-games", "password")}` });
let keyCounter = 0;
const newKey = () => `t4-${randomUUID().slice(0, 8)}-${keyCounter++}`;
const idOf = (item: { id: string }) => Number(item.id.slice(4));

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let blobs: MemoryBlobStore;
let sql: pg.Pool;
const principals: string[] = [];

type Actor = { uid: string; principal: string; auth: { Authorization: string } };

async function actor(role: "photographer" | "admin" | null): Promise<Actor> {
  const uid = `media4-${role ?? "none"}-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  principals.push(principal);
  if (role) await seedRole(sql, principal, role);
  return { uid, principal, auth: bearer(uid) };
}

const create = (who: Actor, bytes: Buffer, key = newKey()) =>
  request(server).post(PATH).set(who.auth).set("Content-Type", "image/png").set("Idempotency-Key", key).send(bytes);
const addVersion = (who: Actor, id: string, revision: number | string | null, bytes: Buffer, key: string | null = newKey(), type = "image/png") => {
  let req = request(server).post(`${PATH}/${id}/versions${revision === null ? "" : `?revision=${revision}`}`).set(who.auth).set("Content-Type", type);
  if (key !== null) req = req.set("Idempotency-Key", key);
  return req.send(bytes);
};
const patch = (who: Actor, id: string, body: unknown) => request(server).patch(`${PATH}/${id}`).set(who.auth).send(body as object);
const publish = (who: Actor, id: string, body: unknown) => request(server).post(`${PATH}/${id}/publish`).set(who.auth).send(body as object);
const withdraw = (who: Actor, id: string, body: unknown) => request(server).post(`${PATH}/${id}/withdraw`).set(who.auth).send(body as object);

const FULL_LICENCE = { credit: "A. Photographer", licenceName: "CC BY 4.0", licenceUrl: "https://creativecommons.org/licenses/by/4.0/", creditRequired: true };

/** A new item owned by `owner`, with a publishable licence applied. Returns the item as of the last write. */
async function licensedItem(owner: Actor, bytes = png(64, 48, Math.floor(Math.random() * 1e6) + 1)) {
  const created = await create(owner, bytes);
  expect(created.status).toBe(201);
  const edited = await patch(owner, created.body.id, { revision: created.body.revision, licence: FULL_LICENCE });
  expect(edited.status).toBe(200);
  return edited.body as Item;
}

type Item = { id: string; state: string; revision: number; draftVersion: number; publishedVersion: number | null; draft: Record<string, any>; owner?: string };

const count = async (table: string, where = "", params: unknown[] = []) =>
  (await sql.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} ${where}`, params)).rows[0]?.n;
const versionsOf = (id: string) => count("media_versions", "WHERE media_id = $1", [idOf({ id })]);
const auditOf = (id: string, action?: string) =>
  count("admin_audit", `WHERE target = $1${action ? " AND action = $2" : ""}`, action ? [id, action] : [id]);
const row = async (id: string) => (await sql.query("SELECT * FROM media_items WHERE id = $1", [idOf({ id })])).rows[0];
/** Wait until at least `n` backends of this database wait for a row lock (FOR UPDATE queues on tuple / transactionid locks). Throws if they never do. */
async function waitQueued(n: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await sql.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype IN ('tuple', 'transactionid') AND NOT granted AND pid <> pg_backend_pid() AND (database IS NULL OR database = (SELECT oid FROM pg_database WHERE datname = current_database()))",
    );
    if ((rows[0]?.n ?? 0) >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Fewer than ${n} requests reached the item row lock.`);
}
const versionRow = async (id: string, version: number) =>
  (await sql.query("SELECT * FROM media_versions WHERE media_id = $1 AND version = $2", [idOf({ id }), version])).rows[0];

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  blobs = app.get<MemoryBlobStore>(BLOB_STORE);
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe("POST /v1/admin/media/{id}/versions", () => {
  it("adds version 2 as the draft: empty licence, revision + 1, one audit row, published version and state untouched", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer);
    const published = await publish(admin, item.id, { revision: item.revision });
    expect(published.status).toBe(200);
    const bytes = png(70, 50, 11);
    const key = newKey();
    const res = await addVersion(photographer, item.id, published.body.revision, bytes, key);
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({
      id: item.id,
      state: "published",
      revision: published.body.revision + 1,
      draftVersion: 2,
      publishedVersion: 1,
      draft: {
        version: 2,
        sha256: sha(bytes),
        contentType: "image/png",
        byteSize: bytes.length,
        width: 70,
        height: 50,
        licence: { credit: null, licenceName: null, licenceUrl: null, sourceUrl: null, attributionText: null, creditRequired: true },
        publishedAt: null,
      },
    });
    expect(res.body).not.toHaveProperty("owner");
    const stored = await blobs.get(`content/photos/${sha(bytes)}.png`);
    expect(stored && Buffer.from(stored).equals(bytes)).toBe(true);
    // The live version and its credit are exactly as published.
    const live = await versionRow(item.id, 1);
    expect(live).toMatchObject({ credit_name: "A. Photographer", licence_name: "CC BY 4.0" });
    expect(live.published_at).not.toBeNull();
    const keys = await sql.query("SELECT * FROM media_upload_keys WHERE principal = $1 AND idempotency_key = $2", [photographer.principal, key]);
    expect(keys.rows).toMatchObject([{ operation: "version", media_id: String(idOf(item)), version: 2, sha256: sha(bytes) }]);
    expect(await auditOf(item.id, "media_version")).toBe(1);
    const audit = await sql.query("SELECT * FROM admin_audit WHERE target = $1 AND action = 'media_version'", [item.id]);
    expect(audit.rows[0]).toMatchObject({ actor: photographer.principal });
    expect(audit.rows[0].detail).toMatchObject({ mediaId: item.id, version: 2, previousDraftVersion: 1, sha256: sha(bytes) });
    expect(JSON.stringify(audit.rows) + JSON.stringify(res.body) + JSON.stringify(res.headers)).not.toMatch(/photos|content\/|backend\//);
    const dbItem = await row(item.id);
    expect(dbItem).toMatchObject({ state: "published", draft_version: 2, published_version: 1, updated_by: photographer.principal });
  });

  it("an admin sees owner in the response; an admin may add a version to another's item", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const created = await create(photographer, png(71, 51, 1));
    const res = await addVersion(admin, created.body.id, created.body.revision, png(72, 52, 1));
    expect(res.status).toBe(201);
    expect(res.body.owner).toBe(photographer.principal);
  });

  it("who may: 401 without a token, 403 without the role, 404 for another photographer's item or an unknown or malformed id", async () => {
    const owner = await actor("photographer");
    const other = await actor("photographer");
    const none = await actor(null);
    const created = await create(owner, png(73, 53, 1));
    const bytes = png(74, 54, 1);
    expect((await request(server).post(`${PATH}/${created.body.id}/versions?revision=1`).set("Content-Type", "image/png").set("Idempotency-Key", newKey()).send(bytes)).status).toBe(401);
    expect((await addVersion(none, created.body.id, 1, bytes)).status).toBe(403);
    const foreign = await addVersion(other, created.body.id, 1, bytes);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("not_found");
    for (const id of ["med-999999999", "med-0", "med-01", "x", "med-1x"]) {
      const res = await addVersion(owner, id, 1, bytes);
      expect(res.status, id).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
    expect(await versionsOf(created.body.id)).toBe(1);
    // A foreign id and an unknown id are not told apart.
    const unknown = await addVersion(other, "med-999999998", 1, bytes);
    expect(unknown.body).toMatchObject({ error: { code: "not_found", message: foreign.body.error.message } });
  });

  it("the 5 MB body is read only for a verified photographer or admin: refused callers get their answer without a body", async () => {
    const none = await actor(null);
    const headers = { "Idempotency-Key": newKey() };
    const path = `${PATH}/med-1/versions?revision=1`;
    expect(await unfinishedUpload(server, headers, path, "image/png")).toBe(401);
    expect(await unfinishedUpload(server, { ...headers, ...none.auth }, path, "image/png")).toBe(403);
  });

  it("accepts an image over 16 KB and rejects one over 5 MB (413) before anything is written", async () => {
    const photographer = await actor("photographer");
    const created = await create(photographer, png(75, 55, 1));
    const big = png(76, 56, 20_000);
    expect(big.length).toBeGreaterThan(16 * 1024);
    const ok = await addVersion(photographer, created.body.id, 1, big);
    expect(ok.status).toBe(201);
    const over = await addVersion(photographer, created.body.id, 2, Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    expect(over.status).toBe(413);
    expect(over.body.error.code).toBe("invalid_request");
    expect(await versionsOf(created.body.id)).toBe(2);
  });

  it("is strict about the request: revision (400), Idempotency-Key (400), empty body (400), Content-Type (415), bad image (422)", async () => {
    const photographer = await actor("photographer");
    const created = await create(photographer, png(77, 57, 1));
    const id = created.body.id as string;
    const bytes = png(78, 58, 1);
    for (const revision of [null, "abc", "0", "-1", "1.5", "2147483648", "01", "1&x=1"]) {
      const res = await addVersion(photographer, id, revision, bytes);
      expect(res.status, String(revision)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    for (const key of [null, "has space", "x".repeat(129)]) {
      expect((await addVersion(photographer, id, 1, bytes, key)).status, String(key)).toBe(400);
    }
    expect((await addVersion(photographer, id, 1, Buffer.alloc(0))).status).toBe(400);
    expect((await addVersion(photographer, id, 1, bytes, newKey(), "image/gif")).status).toBe(415);
    const full = png(79, 59, 3);
    const cases: [string, Buffer, string][] = [
      ["truncated", full.subarray(0, full.length - 5), "image/png"],
      ["not an image", Buffer.from("not an image"), "image/png"],
      ["png declared as jpeg", full, "image/jpeg"],
      ["too large a side", png(4097, 10), "image/png"],
    ];
    for (const [name, data, type] of cases) {
      const res = await addVersion(photographer, id, 1, data, newKey(), type);
      expect(res.status, name).toBe(422);
      expect(res.body.error.code, name).toBe("media_invalid");
    }
    expect(await versionsOf(id)).toBe(1);
    expect(await auditOf(id, "media_version")).toBe(0);
    expect((await row(id)).revision).toBe(1);
  });

  it("the revision fence: a stale revision is 409 version_conflict and nothing changes (no version, key, audit or revision bump)", async () => {
    const photographer = await actor("photographer");
    const created = await create(photographer, png(80, 60, 1));
    const first = await addVersion(photographer, created.body.id, 1, png(81, 61, 1));
    expect(first.status).toBe(201);
    const before = blobs.size;
    const stale = await addVersion(photographer, created.body.id, 1, png(82, 62, 1));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect(stale.body.error.message).toMatch(/revision 2/);
    expect(await versionsOf(created.body.id)).toBe(2);
    expect(await count("media_upload_keys", "WHERE media_id = $1", [idOf(created.body)])).toBe(2);
    expect(await auditOf(created.body.id, "media_version")).toBe(1);
    expect((await row(created.body.id)).revision).toBe(2);
    // The fence is checked before the file is stored.
    expect(blobs.size).toBe(before);
  });

  it("the fence is re-checked under the row lock: a concurrent write that moved the revision makes this request 409", async () => {
    const photographer = await actor("photographer");
    const created = await create(photographer, png(83, 63, 1));
    const client = await sql.connect();
    let pending: Promise<request.Response> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM media_items WHERE id = $1 FOR UPDATE", [idOf(created.body)]);
      pending = addVersion(photographer, created.body.id, 1, png(84, 64, 1)).then((r) => r);
      // Wait until the request is blocked on our row lock, then move the revision and commit.
      await waitQueued(1);
      await client.query("UPDATE media_items SET revision = revision + 1 WHERE id = $1", [idOf(created.body)]);
      await client.query("COMMIT");
      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("version_conflict");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      await pending?.catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    expect(await versionsOf(created.body.id)).toBe(1);
    expect(await auditOf(created.body.id, "media_version")).toBe(0);
  });

  it("the key is re-checked under the row lock: two same-key uploads queued on the item lock make one version (201 + 200)", async () => {
    const photographer = await actor("photographer");
    const created = await create(photographer, png(104, 84, 1));
    const bytes = png(105, 85, 1);
    const key = newKey();
    const client = await sql.connect();
    let pending: Promise<request.Response[]> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM media_items WHERE id = $1 FOR UPDATE", [idOf(created.body)]);
      // Both pass the unlocked key lookup and the revision pre-check (nothing has changed), then queue on the row lock.
      pending = Promise.all([addVersion(photographer, created.body.id, 1, bytes, key), addVersion(photographer, created.body.id, 1, bytes, key)]);
      await waitQueued(2);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      await pending?.catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const results = await pending!;
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await versionsOf(created.body.id)).toBe(2);
    expect(await auditOf(created.body.id, "media_version")).toBe(1);
    expect((await row(created.body.id)).revision).toBe(2);
  });

  it("a withdrawn item may get a version, and the item stays withdrawn", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer);
    const live = await publish(admin, item.id, { revision: item.revision });
    const gone = await withdraw(admin, item.id, { revision: live.body.revision });
    expect(gone.body.state).toBe("withdrawn");
    const res = await addVersion(photographer, item.id, gone.body.revision, png(85, 65, 1));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: "withdrawn", publishedVersion: null, draftVersion: 2 });
  });

  it("ASSUMPTION: a new version starts with creditRequired true even when the previous version was set to false", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const created = await create(photographer, png(86, 66, 1));
    const off = await patch(admin, created.body.id, { revision: 1, licence: { creditRequired: false } });
    expect(off.body.draft.licence.creditRequired).toBe(false);
    const res = await addVersion(photographer, created.body.id, off.body.revision, png(87, 67, 1));
    expect(res.body.draft.licence.creditRequired).toBe(true);
  });

  it("storage trouble is 503 and nothing is written; the same key then succeeds", async () => {
    const photographer = await actor("photographer");
    const created = await create(photographer, png(88, 68, 1));
    const bytes = png(89, 69, 1);
    const key = newKey();
    const put = vi.spyOn(blobs, "put").mockRejectedValue(new StorageUnavailableError());
    const down = await addVersion(photographer, created.body.id, 1, bytes, key);
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("storage_unavailable");
    expect(down.headers["retry-after"]).toBeTruthy();
    put.mockRestore();
    const get = vi.spyOn(blobs, "get").mockResolvedValue(new Uint8Array([1, 2, 3]));
    expect((await addVersion(photographer, created.body.id, 1, bytes, key)).status).toBe(503);
    get.mockRestore();
    expect(await versionsOf(created.body.id)).toBe(1);
    expect((await row(created.body.id)).revision).toBe(1);
    expect(await auditOf(created.body.id, "media_version")).toBe(0);
    expect((await addVersion(photographer, created.body.id, 1, bytes, key)).status).toBe(201);
  });
});

describe("POST /v1/admin/media/{id}/versions: Idempotency-Key", () => {
  it("a replay is looked up before the revision fence: same key, item and bytes answers 200 with the item as stored now, writing nothing", async () => {
    const photographer = await actor("photographer");
    const created = await create(photographer, png(90, 70, 1));
    const bytes = png(91, 71, 1);
    const key = newKey();
    const first = await addVersion(photographer, created.body.id, 1, bytes, key);
    expect(first.status).toBe(201);
    // The item moves on: the revision the retry still carries (1) is stale, but the key decides first.
    const moved = await patch(photographer, created.body.id, { revision: first.body.revision, licence: { credit: "Later" } });
    expect(moved.status).toBe(200);
    vi.spyOn(blobs, "put").mockRejectedValue(new StorageUnavailableError());
    vi.spyOn(blobs, "get").mockRejectedValue(new StorageUnavailableError());
    const replay = await addVersion(photographer, created.body.id, 1, bytes, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(moved.body);
    expect(replay.body.revision).toBe(3);
    expect(await versionsOf(created.body.id)).toBe(2);
    expect(await count("media_upload_keys", "WHERE media_id = $1", [idOf(created.body)])).toBe(2);
    expect(await auditOf(created.body.id, "media_version")).toBe(1);
    expect(replay.body).not.toHaveProperty("owner");
  });

  it("an admin's replay shows the owner", async () => {
    const admin = await actor("admin");
    const created = await create(admin, png(102, 82, 1));
    const bytes = png(103, 83, 1);
    const key = newKey();
    expect((await addVersion(admin, created.body.id, 1, bytes, key)).status).toBe(201);
    const replay = await addVersion(admin, created.body.id, 1, bytes, key);
    expect(replay.status).toBe(200);
    expect(replay.body.owner).toBe(admin.principal);
  });

  it("the same key with other bytes, another item, or the create operation is 422 idempotency_key_reused", async () => {
    const photographer = await actor("photographer");
    const a = await create(photographer, png(92, 72, 1));
    const b = await create(photographer, png(93, 73, 1));
    const key = newKey();
    const bytes = png(94, 74, 1);
    expect((await addVersion(photographer, a.body.id, 1, bytes, key)).status).toBe(201);
    for (const res of [
      await addVersion(photographer, a.body.id, 2, png(95, 75, 1), key), // other bytes
      await addVersion(photographer, a.body.id, 2, Buffer.from("garbage"), key), // reuse wins over a bad image
      await addVersion(photographer, b.body.id, 1, bytes, key), // another item
    ]) {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("idempotency_key_reused");
    }
    // A key that created an item cannot be a version upload, and the other way round.
    const createKey = newKey();
    const createdWithKey = await create(photographer, png(96, 76, 1), createKey);
    expect(createdWithKey.status).toBe(201);
    const cross = await addVersion(photographer, createdWithKey.body.id, 1, png(96, 76, 1), createKey);
    expect(cross.status).toBe(422);
    expect(cross.body.error.code).toBe("idempotency_key_reused");
    const back = await create(photographer, bytes, key);
    expect(back.status).toBe(422);
    expect(back.body.error.code).toBe("idempotency_key_reused");
    expect(await versionsOf(a.body.id)).toBe(2);
    expect(await versionsOf(b.body.id)).toBe(1);
  });

  it("two callers may use the same key independently", async () => {
    const a = await actor("photographer");
    const b = await actor("photographer");
    const ia = await create(a, png(97, 77, 1));
    const ib = await create(b, png(98, 78, 1));
    const key = newKey();
    expect((await addVersion(a, ia.body.id, 1, png(99, 79, 1), key)).status).toBe(201);
    expect((await addVersion(b, ib.body.id, 1, png(99, 79, 1), key)).status).toBe(201);
  });

  it("a concurrent duplicate (same key and revision, in parallel) makes exactly one version", async () => {
    const photographer = await actor("photographer");
    const created = await create(photographer, png(100, 80, 1));
    const bytes = png(101, 81, 1);
    const key = newKey();
    const results = await Promise.all(Array.from({ length: 8 }, () => addVersion(photographer, created.body.id, 1, bytes, key)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(7);
    expect(await versionsOf(created.body.id)).toBe(2);
    expect(await auditOf(created.body.id, "media_version")).toBe(1);
    expect((await row(created.body.id)).revision).toBe(2);
  });
});

describe("PATCH /v1/admin/media/{id}", () => {
  it("edits an unpublished draft in place: same version, revision + 1, one audit row with the field diff and the note", async () => {
    const photographer = await actor("photographer");
    const created = await create(photographer, png(110, 90, 1));
    const res = await patch(photographer, created.body.id, {
      revision: 1,
      licence: { credit: "  A. Photographer  ", licenceName: "CC BY 4.0", sourceUrl: "https://example.com/p/1", attributionText: "Photo by A." },
      note: "  first pass ",
    });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({
      revision: 2,
      draftVersion: 1,
      publishedVersion: null,
      state: "unverified",
      draft: {
        version: 1,
        licence: { credit: "A. Photographer", licenceName: "CC BY 4.0", licenceUrl: null, sourceUrl: "https://example.com/p/1", attributionText: "Photo by A.", creditRequired: true },
      },
    });
    expect(await versionsOf(created.body.id)).toBe(1);
    const audit = await sql.query("SELECT * FROM admin_audit WHERE target = $1 AND action = 'media_edit'", [created.body.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor: photographer.principal });
    expect(audit.rows[0].detail).toMatchObject({
      mediaId: created.body.id,
      version: 1,
      newVersion: false,
      revision: 2,
      note: "first pass",
      changes: { credit: { from: null, to: "A. Photographer" }, licenceName: { from: null, to: "CC BY 4.0" } },
    });
    expect(Object.keys(audit.rows[0].detail.changes).sort()).toEqual(["attributionText", "credit", "licenceName", "sourceUrl"]);
  });

  it("absent keeps, null clears, creditRequired toggles; repeating the stored values is 200 with no new revision, version or audit row", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer);
    const cleared = await patch(admin, item.id, { revision: item.revision, licence: { credit: null, creditRequired: false } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.draft.licence).toMatchObject({ credit: null, creditRequired: false, licenceName: "CC BY 4.0" });
    expect(cleared.body.revision).toBe(item.revision + 1);
    const audits = await auditOf(item.id, "media_edit");
    const same = await patch(admin, item.id, { revision: cleared.body.revision, licence: { credit: null, creditRequired: false, licenceName: "CC BY 4.0" }, note: "no change" });
    expect(same.status).toBe(200);
    expect(same.body).toEqual(cleared.body);
    expect(await auditOf(item.id, "media_edit")).toBe(audits);
    expect(await versionsOf(item.id)).toBe(1);
    expect((await row(item.id)).revision).toBe(cleared.body.revision);
    // The fence still applies to a no-op.
    const stale = await patch(photographer, item.id, { revision: item.revision, licence: { credit: null } });
    expect(stale.status).toBe(409);
  });

  it("a licence edit on a published item never touches the live version: it makes version + 1 with the same file", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const bytes = png(111, 91, 5);
    const item = await licensedItem(photographer, bytes);
    const live = await publish(admin, item.id, { revision: item.revision });
    const liveBefore = await versionRow(item.id, 1);
    const res = await patch(photographer, item.id, { revision: live.body.revision, licence: { credit: "Renamed", attributionText: "New text" }, note: "typo" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: "published",
      revision: live.body.revision + 1,
      draftVersion: 2,
      publishedVersion: 1,
      draft: {
        version: 2,
        sha256: sha(bytes),
        contentType: "image/png",
        byteSize: bytes.length,
        width: 111,
        height: 91,
        licence: { credit: "Renamed", licenceName: "CC BY 4.0", attributionText: "New text", creditRequired: true },
        publishedAt: null,
      },
    });
    expect(await versionRow(item.id, 1)).toEqual(liveBefore);
    expect(await versionsOf(item.id)).toBe(2);
    const audit = await sql.query("SELECT detail FROM admin_audit WHERE target = $1 AND action = 'media_edit'", [item.id]);
    expect(audit.rows.at(-1)!.detail).toMatchObject({ fromVersion: 1, version: 2, newVersion: true, note: "typo" });
    // A second edit now edits the unpublished draft (version 2) in place.
    const again = await patch(photographer, item.id, { revision: res.body.revision, licence: { credit: "Renamed again" } });
    expect(again.body).toMatchObject({ draftVersion: 2, publishedVersion: 1, revision: res.body.revision + 1 });
    expect(await versionsOf(item.id)).toBe(2);
    expect(await versionRow(item.id, 1)).toEqual(liveBefore);
  });

  it("an item that was live once and is now withdrawn is not rewritten in place: the edit makes a new version", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer);
    const live = await publish(admin, item.id, { revision: item.revision });
    const gone = await withdraw(admin, item.id, { revision: live.body.revision });
    const liveRow = await versionRow(item.id, 1);
    const res = await patch(photographer, item.id, { revision: gone.body.revision, licence: { licenceName: null } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "withdrawn", draftVersion: 2, publishedVersion: null });
    expect(res.body.draft.licence.licenceName).toBeNull();
    expect(await versionRow(item.id, 1)).toEqual(liveRow);
  });

  it("is strict: licence is required and non-empty, no unknown keys, typed and bounded text, no control characters", async () => {
    const photographer = await actor("photographer");
    const created = await create(photographer, png(112, 92, 1));
    const id = created.body.id as string;
    const bad: [string, unknown][] = [
      ["no licence", { revision: 1 }],
      ["note only", { revision: 1, note: "x" }],
      ["empty licence", { revision: 1, licence: {} }],
      ["no revision", { licence: { credit: "x" } }],
      ["revision 0", { revision: 0, licence: { credit: "x" } }],
      ["revision float", { revision: 1.5, licence: { credit: "x" } }],
      ["revision string", { revision: "1", licence: { credit: "x" } }],
      ["revision too big", { revision: 2147483648, licence: { credit: "x" } }],
      ["unknown top key", { revision: 1, licence: { credit: "x" }, owner: "x" }],
      ["unknown licence key", { revision: 1, licence: { owner: "x" } }],
      ["empty credit", { revision: 1, licence: { credit: "" } }],
      ["blank credit", { revision: 1, licence: { credit: "   " } }],
      ["credit too long", { revision: 1, licence: { credit: "c".repeat(201) } }],
      ["control char", { revision: 1, licence: { credit: "a\u0007b" } }],
      ["newline inside", { revision: 1, licence: { credit: "a\nb" } }],
      ["control in attribution", { revision: 1, licence: { attributionText: "a\tb" } }],
      ["ftp url", { revision: 1, licence: { licenceUrl: "ftp://x.example" } }],
      ["relative url", { revision: 1, licence: { sourceUrl: "/x" } }],
      ["url too long", { revision: 1, licence: { sourceUrl: `https://x.example/${"a".repeat(2040)}` } }],
      ["attribution too long", { revision: 1, licence: { attributionText: "a".repeat(1001) } }],
      ["creditRequired null", { revision: 1, licence: { creditRequired: null } }],
      ["creditRequired string", { revision: 1, licence: { creditRequired: "yes" } }],
      ["empty note", { revision: 1, licence: { credit: "x" }, note: "" }],
      ["note too long", { revision: 1, licence: { credit: "x" }, note: "n".repeat(501) }],
      ["licence null", { revision: 1, licence: null }],
    ];
    for (const [name, body] of bad) {
      const res = await patch(photographer, id, body);
      expect(res.status, name).toBe(400);
      expect(res.body.error.code, name).toBe("invalid_request");
    }
    const noBody = await request(server).patch(`${PATH}/${id}`).set(photographer.auth);
    expect(noBody.status).toBe(400);
    expect((await request(server).patch(`${PATH}/${id}?x=1`).set(photographer.auth).send({ revision: 1, licence: { credit: "x" } })).status).toBe(400);
    expect((await row(id)).revision).toBe(1);
    expect(await auditOf(id, "media_edit")).toBe(0);
    // Boundaries that are fine: exactly 200 code points, a 2048-character URL, an empty attribution text.
    const ok = await patch(photographer, id, {
      revision: 1,
      licence: { credit: "\u{1F600}".repeat(200), licenceUrl: `https://x.example/${"a".repeat(2048 - 18)}`, attributionText: "" },
    });
    expect(ok.status).toBe(200);
    expect([...ok.body.draft.licence.credit]).toHaveLength(200);
  });

  it("who may: 401 without a token, 403 without the role, 404 for another photographer's or an unknown or malformed id; an admin may edit anyone's", async () => {
    const owner = await actor("photographer");
    const other = await actor("photographer");
    const none = await actor(null);
    const admin = await actor("admin");
    const created = await create(owner, png(113, 93, 1));
    const body = { revision: 1, licence: { credit: "x" } };
    expect((await request(server).patch(`${PATH}/${created.body.id}`).send(body)).status).toBe(401);
    expect((await patch(none, created.body.id, body)).status).toBe(403);
    const foreign = await patch(other, created.body.id, body);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("not_found");
    for (const id of ["med-999999999", "med-0", "nope"]) expect((await patch(owner, id, body)).status, id).toBe(404);
    expect((await row(created.body.id)).revision).toBe(1);
    const byAdmin = await patch(admin, created.body.id, body);
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.owner).toBe(owner.principal);
    const byOwner = await patch(owner, created.body.id, { revision: 2, licence: { credit: "y" } });
    expect(byOwner.body).not.toHaveProperty("owner");
  });

  it("a stale revision is 409 version_conflict and changes nothing", async () => {
    const photographer = await actor("photographer");
    const created = await create(photographer, png(114, 94, 1));
    expect((await patch(photographer, created.body.id, { revision: 1, licence: { credit: "one" } })).status).toBe(200);
    const stale = await patch(photographer, created.body.id, { revision: 1, licence: { credit: "two" } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect((await versionRow(created.body.id, 1)).credit_name).toBe("one");
    expect(await auditOf(created.body.id, "media_edit")).toBe(1);
  });

  it("creditRequired: a photographer owner cannot change it (403 forbidden, nothing written); the stored value alongside another field is fine; an admin may change it", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const created = await create(photographer, png(117, 97, 1));
    const id = created.body.id as string;
    const versionBefore = await versionRow(id, 1);
    const itemBefore = await row(id);
    const denied = await patch(photographer, id, { revision: 1, licence: { creditRequired: false, credit: "Sneaky" } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("forbidden");
    expect(denied.body.error.message).toMatch(/creditRequired/);
    expect(await versionRow(id, 1)).toEqual(versionBefore);
    expect(await row(id)).toEqual(itemBefore);
    expect(await versionsOf(id)).toBe(1);
    expect(await auditOf(id, "media_edit")).toBe(0);

    const kept = await patch(photographer, id, { revision: 1, licence: { creditRequired: true, credit: "Real Credit" } });
    expect(kept.status).toBe(200);
    expect(kept.body.draft.licence).toMatchObject({ creditRequired: true, credit: "Real Credit" });
    expect(await auditOf(id, "media_edit")).toBe(1);

    const byAdmin = await patch(admin, id, { revision: kept.body.revision, licence: { creditRequired: false } });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.draft.licence.creditRequired).toBe(false);
    // Once an admin turned it off, the photographer sending the stored false is a no-op; flipping it back is refused.
    const same = await patch(photographer, id, { revision: byAdmin.body.revision, licence: { creditRequired: false } });
    expect(same.status).toBe(200);
    expect(same.body.revision).toBe(byAdmin.body.revision);
    expect(same.body.draftVersion).toBe(byAdmin.body.draftVersion);
    expect(await auditOf(id, "media_edit")).toBe(2);
    const flip = await patch(photographer, id, { revision: byAdmin.body.revision, licence: { creditRequired: true } });
    expect(flip.status).toBe(403);
    expect(flip.body.error.code).toBe("forbidden");
    expect((await row(id)).revision).toBe(byAdmin.body.revision);
    expect((await versionRow(id, byAdmin.body.draftVersion)).credit_required).toBe(false);
    expect(await auditOf(id, "media_edit")).toBe(2);
  });

  it("creditRequired: another photographer's item is still 404 and a stale revision still 409, both before the 403", async () => {
    const owner = await actor("photographer");
    const other = await actor("photographer");
    const created = await create(owner, png(118, 98, 1));
    const foreign = await patch(other, created.body.id, { revision: 1, licence: { creditRequired: false } });
    expect(foreign.status).toBe(404);
    const stale = await patch(owner, created.body.id, { revision: 7, licence: { creditRequired: false } });
    expect(stale.status).toBe(409);
    expect((await row(created.body.id)).revision).toBe(1);
  });

  it("refusals do not leak connections: more refused writes than the pool size still all succeed", async () => {
    const photographer = await actor("photographer");
    const created = await create(photographer, png(115, 95, 1));
    for (let n = 0; n < 30; n += 1) {
      expect((await patch(photographer, created.body.id, { revision: 99, licence: { credit: "x" } })).status).toBe(409);
    }
    expect((await patch(photographer, created.body.id, { revision: 1, licence: { credit: "x" } })).status).toBe(200);
  });

  it("timestamps come from the database clock", async () => {
    const photographer = await actor("photographer");
    const created = await create(photographer, png(116, 96, 1));
    const stamp = async () => (await sql.query<{ t: Date }>("SELECT date_trunc('milliseconds', clock_timestamp()) AS t")).rows[0]!.t;
    const before = await stamp();
    const res = await patch(photographer, created.body.id, { revision: 1, licence: { credit: "x" } });
    const after = await stamp();
    expect(res.status).toBe(200);
    const item = await row(created.body.id);
    const audit = (await sql.query("SELECT created_at FROM admin_audit WHERE target = $1 AND action = 'media_edit'", [created.body.id])).rows[0];
    for (const at of [item.updated_at as Date, audit.created_at as Date]) {
      expect(at.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(at.getTime()).toBeLessThanOrEqual(after.getTime());
    }
    expect(res.body.updatedAt).toBe(item.updated_at.toISOString());
  });
});

describe("POST /v1/admin/media/{id}/publish and /withdraw", () => {
  it("publishes the draft: state, publishedVersion, publishedAt, revision + 1, one audit row; the response says 200", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer);
    const res = await publish(admin, item.id, { revision: item.revision });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ state: "published", draftVersion: 1, publishedVersion: 1, revision: item.revision + 1, owner: photographer.principal });
    expect(res.body.draft.publishedAt).toEqual(expect.any(String));
    expect(await auditOf(item.id, "media_publish")).toBe(1);
    const audit = (await sql.query("SELECT * FROM admin_audit WHERE target = $1 AND action = 'media_publish'", [item.id])).rows[0];
    expect(audit.actor).toBe(admin.principal);
    expect(audit.detail).toMatchObject({ fromState: "unverified", previousPublishedVersion: null, publishedVersion: 1 });
    const stored = await versionRow(item.id, 1);
    expect(stored.published_at.toISOString()).toBe(res.body.draft.publishedAt);
  });

  it("only an admin: a photographer (even the owner) is 403, no token 401, no role 403; unknown or malformed ids are 404", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const none = await actor(null);
    const item = await licensedItem(photographer);
    for (const fn of [publish, withdraw]) {
      expect((await fn(photographer, item.id, { revision: item.revision })).status).toBe(403);
      expect((await fn(none, item.id, { revision: item.revision })).status).toBe(403);
      expect((await request(server).post(`${PATH}/${item.id}/${fn === publish ? "publish" : "withdraw"}`).send({ revision: 1 })).status).toBe(401);
      for (const id of ["med-999999999", "med-0", "nope"]) {
        const res = await fn(admin, id, { revision: 1 });
        expect(res.status, id).toBe(404);
        expect(res.body.error.code).toBe("not_found");
      }
    }
    expect((await row(item.id)).state).toBe("unverified");
  });

  it("strict body: { revision } and nothing else", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer);
    for (const fn of [publish, withdraw]) {
      for (const body of [{}, { revision: 0 }, { revision: "1" }, { revision: 1, note: "x" }, { revision: 1.5 }, { revision: 2147483648 }]) {
        expect((await fn(admin, item.id, body)).status, JSON.stringify(body)).toBe(400);
      }
    }
    expect((await row(item.id)).revision).toBe(item.revision);
  });

  it("a licence without a name, or without a credit when one is required, is 422 content_invalid and nothing is written", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const created = await create(photographer, png(120, 100, 1));
    const empty = await publish(admin, created.body.id, { revision: 1 });
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe("content_invalid");
    const named = await patch(photographer, created.body.id, { revision: 1, licence: { licenceName: "CC0" } });
    const noCredit = await publish(admin, created.body.id, { revision: named.body.revision });
    expect(noCredit.status).toBe(422);
    expect(noCredit.body.error.code).toBe("content_invalid");
    expect(noCredit.body.error.message).toMatch(/credit/);
    const row1 = await row(created.body.id);
    expect(row1).toMatchObject({ state: "unverified", revision: named.body.revision, published_version: null });
    expect(await auditOf(created.body.id, "media_publish")).toBe(0);
    // Credit not required: a licence name alone is enough.
    const relaxed = await patch(admin, created.body.id, { revision: named.body.revision, licence: { creditRequired: false } });
    const ok = await publish(admin, created.body.id, { revision: relaxed.body.revision });
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe("published");
  });

  it("publishing an unchanged published draft is 409 nothing_to_publish; a stale revision is 409 version_conflict (checked first)", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer);
    const live = await publish(admin, item.id, { revision: item.revision });
    const again = await publish(admin, item.id, { revision: live.body.revision });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("nothing_to_publish");
    const stale = await publish(admin, item.id, { revision: item.revision });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect(await auditOf(item.id, "media_publish")).toBe(1);
    expect((await row(item.id)).revision).toBe(live.body.revision);
  });

  it("a new version or licence edit goes live only when an admin publishes it; the old version stays as history", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer);
    const live = await publish(admin, item.id, { revision: item.revision });
    const next = await addVersion(photographer, item.id, live.body.revision, png(121, 101, 1));
    // Unlicensed: cannot go live.
    const refused = await publish(admin, item.id, { revision: next.body.revision });
    expect(refused.status).toBe(422);
    const licensed = await patch(photographer, item.id, { revision: next.body.revision, licence: FULL_LICENCE });
    expect(licensed.body).toMatchObject({ draftVersion: 2, publishedVersion: 1 });
    const went = await publish(admin, item.id, { revision: licensed.body.revision });
    expect(went.status).toBe(200);
    expect(went.body).toMatchObject({ state: "published", draftVersion: 2, publishedVersion: 2 });
    expect((await versionRow(item.id, 1)).published_at).not.toBeNull();
    expect(await auditOf(item.id, "media_publish")).toBe(2);
    expect((await sql.query("SELECT detail FROM admin_audit WHERE target = $1 AND action = 'media_publish' ORDER BY id DESC LIMIT 1", [item.id])).rows[0].detail).toMatchObject({
      previousPublishedVersion: 1,
      publishedVersion: 2,
    });
  });

  it("withdraws a published item (publishedVersion null, revision + 1, one audit row); anything not published is 409; a stale revision is 409", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer);
    const notYet = await withdraw(admin, item.id, { revision: item.revision });
    expect(notYet.status).toBe(409);
    expect(notYet.body.error.code).toBe("version_conflict");
    expect(notYet.body.error.message).toMatch(/unverified/);
    const live = await publish(admin, item.id, { revision: item.revision });
    const stale = await withdraw(admin, item.id, { revision: item.revision });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect((await row(item.id)).state).toBe("published");
    const gone = await withdraw(admin, item.id, { revision: live.body.revision });
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ state: "withdrawn", publishedVersion: null, draftVersion: 1, revision: live.body.revision + 1 });
    expect(await auditOf(item.id, "media_withdraw")).toBe(1);
    const audit = (await sql.query("SELECT * FROM admin_audit WHERE target = $1 AND action = 'media_withdraw'", [item.id])).rows[0];
    expect(audit.actor).toBe(admin.principal);
    expect(audit.detail).toMatchObject({ fromState: "published", withdrawnVersion: 1 });
    // Twice is a conflict, not a second audit row.
    const twice = await withdraw(admin, item.id, { revision: gone.body.revision });
    expect(twice.status).toBe(409);
    expect(await auditOf(item.id, "media_withdraw")).toBe(1);
  });

  it("a withdrawn item can be published again (new version first, or the same draft)", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer);
    const live = await publish(admin, item.id, { revision: item.revision });
    const gone = await withdraw(admin, item.id, { revision: live.body.revision });
    const firstLive = (await versionRow(item.id, 1)).published_at as Date;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const back = await publish(admin, item.id, { revision: gone.body.revision });
    expect(back.status).toBe(200);
    // publishedAt is when the version FIRST went live: a second publish of the same draft keeps it.
    expect((await versionRow(item.id, 1)).published_at.getTime()).toBe(firstLive.getTime());
    expect(back.body.draft.publishedAt).toBe(firstLive.toISOString());
    expect(back.body).toMatchObject({ state: "published", publishedVersion: 1, draftVersion: 1 });
    const gone2 = await withdraw(admin, item.id, { revision: back.body.revision });
    const v2 = await addVersion(photographer, item.id, gone2.body.revision, png(122, 102, 1));
    const lic = await patch(photographer, item.id, { revision: v2.body.revision, licence: FULL_LICENCE });
    const back2 = await publish(admin, item.id, { revision: lic.body.revision });
    expect(back2.status).toBe(200);
    expect(back2.body).toMatchObject({ state: "published", publishedVersion: 2, draftVersion: 2 });
  });

  it("concurrent publishes of the same revision: exactly one wins", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await licensedItem(photographer);
    const results = await Promise.all(Array.from({ length: 6 }, () => publish(admin, item.id, { revision: item.revision })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await auditOf(item.id, "media_publish")).toBe(1);
  });
});

describe("the versions route: rate limit", () => {
  it("counts against the rate limit before the body is read: a refused caller gets 429 without sending the body", async () => {
    const saved = process.env.RATE_LIMIT_AUTH_PER_MIN;
    process.env.RATE_LIMIT_AUTH_PER_MIN = "4";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const limited = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApp(limited);
    await limited.listen(0, "127.0.0.1");
    if (saved === undefined) delete process.env.RATE_LIMIT_AUTH_PER_MIN;
    else process.env.RATE_LIMIT_AUTH_PER_MIN = saved;
    try {
      const photographer = await actor("photographer");
      const target = limited.getHttpServer();
      const made = await request(target).post(PATH).set(photographer.auth).set("Content-Type", "image/png").set("Idempotency-Key", newKey()).send(png(130, 110, 1));
      expect(made.status).toBe(201);
      for (let n = 0; n < 3; n += 1) {
        const res = await request(target)
          .post(`${PATH}/${made.body.id}/versions?revision=${made.body.revision + n}`)
          .set(photographer.auth)
          .set("Content-Type", "image/png")
          .set("Idempotency-Key", newKey())
          .send(png(131 + n, 111, 1));
        expect(res.status).toBe(201);
      }
      const status = await unfinishedUpload(target, { ...photographer.auth, "Idempotency-Key": newKey() }, `${PATH}/${made.body.id}/versions?revision=1`, "image/png");
      expect(status).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
