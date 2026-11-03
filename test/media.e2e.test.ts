import { createHash, randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { BLOB_STORE, StorageRequestError, StorageUnavailableError } from "../src/storage/blob-store.js";
import { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";
import { unfinishedUpload } from "./upload-helpers.js";

// Media plan T3 (docs/plans/media-pipeline.md): POST /v1/admin/media. Roles are seeded in account_roles; the blob store is the
// in-process MemoryBlobStore. Every test uses fresh owners, and the suite deletes only its own rows.

const PATH = "/v1/admin/media";
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];

/** A minimal valid PNG; `extra` varies the bytes (an ancillary chunk after IHDR) without changing the size. */
function png(w = 64, h = 48, extra = 0): Buffer {
  const ancillary = extra === 0 ? [] : [...be32(extra), 0x74, 0x45, 0x58, 0x74, ...Array<number>(extra).fill(65), 0, 0, 0, 0];
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...ancillary,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

function jpeg(w = 64, h = 48, scan = 0): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, ...be16(11), 8, ...be16(h), ...be16(w), 1, 1, 0x11, 0,
    0xff, 0xda, ...be16(4), 0, 0, 1, 2, scan & 255, 0xff, 0xd9,
  ]);
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bearer = (uid: string, options: { emailVerified?: boolean } = {}) => ({ Authorization: `Bearer ${emulatorToken(uid, "demo-airplane-games", "password", options)}` });
let keyCounter = 0;
const newKey = () => `t3-${randomUUID().slice(0, 8)}-${keyCounter++}`;

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let blobs: MemoryBlobStore;
let sql: pg.Pool;
const principals: string[] = [];

/** A new uid holding the given role (active). */
async function actor(role: "photographer" | "admin" | null): Promise<{ uid: string; principal: string; auth: { Authorization: string } }> {
  const uid = `media-${role ?? "none"}-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  principals.push(principal);
  if (role) await seedRole(sql, principal, role);
  return { uid, principal, auth: bearer(uid) };
}

const upload = (auth: Record<string, string>, bytes: Buffer, key: string | null = newKey(), type = "image/png") => {
  let req = request(server).post(PATH).set(auth).set("Content-Type", type);
  if (key !== null) req = req.set("Idempotency-Key", key);
  return req.send(bytes);
};

const count = async (table: string, where = "", params: unknown[] = []) =>
  (await sql.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} ${where}`, params)).rows[0]?.n;
const itemsOf = (principal: string) => count("media_items", "WHERE owner = $1", [principal]);

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

describe("POST /v1/admin/media: who may upload", () => {
  it("no token is 401, a signed-in caller without a role is 403, a pending photographer is 403, and nothing is stored", async () => {
    const bytes = png();
    expect((await request(server).post(PATH).set("Content-Type", "image/png").set("Idempotency-Key", newKey()).send(bytes)).status).toBe(401);
    const none = await actor(null);
    const res = await upload(none.auth, bytes);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
    const pending = await actor(null);
    await seedRole(sql, pending.principal, "photographer", "pending");
    expect((await upload(pending.auth, bytes)).status).toBe(403);
    expect(await itemsOf(none.principal)).toBe(0);
    expect(await itemsOf(pending.principal)).toBe(0);
  });

  it("a photographer whose email is not verified is 403", async () => {
    const photographer = await actor("photographer");
    const res = await upload(bearer(photographer.uid, { emailVerified: false }), png());
    expect(res.status).toBe(403);
    expect(await itemsOf(photographer.principal)).toBe(0);
  });

  it("the large body is read only after the token and the role are checked: refused callers get their answer without a body", async () => {
    const none = await actor(null);
    const headers = { "Idempotency-Key": newKey() };
    expect(await unfinishedUpload(server, headers, PATH, "image/png")).toBe(401);
    expect(await unfinishedUpload(server, { ...headers, ...none.auth }, PATH, "image/png")).toBe(403);
  });

  it("a photographer and an admin can upload; owner is shown to the admin only", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const first = await upload(photographer.auth, png(10, 10));
    expect(first.status).toBe(201);
    expect(first.body).not.toHaveProperty("owner");
    const second = await upload(admin.auth, png(11, 11));
    expect(second.status).toBe(201);
    expect(second.body.owner).toBe(admin.principal);
    // A replay by the photographer still hides the owner.
    const key = newKey();
    expect((await upload(photographer.auth, png(12, 12), key)).status).toBe(201);
    const replay = await upload(photographer.auth, png(12, 12), key);
    expect(replay.status).toBe(200);
    expect(replay.body).not.toHaveProperty("owner");
  });
});

describe("POST /v1/admin/media: create", () => {
  it("answers 201 with the item, stores the file under its digest, and writes the item, version 1, the key and one audit row", async () => {
    const photographer = await actor("photographer");
    const bytes = png(640, 480, 7);
    const key = newKey();
    const res = await upload(photographer.auth, bytes, key);
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.body).toMatchObject({
      state: "unverified",
      revision: 1,
      draftVersion: 1,
      publishedVersion: null,
      draft: {
        version: 1,
        sha256: sha(bytes),
        contentType: "image/png",
        byteSize: bytes.length,
        width: 640,
        height: 480,
        licence: { credit: null, licenceName: null, licenceUrl: null, sourceUrl: null, attributionText: null, creditRequired: true },
        publishedAt: null,
      },
    });
    expect(res.body.id).toMatch(/^med-[1-9][0-9]{0,14}$/);
    expect(Object.keys(res.body).sort()).toEqual(["createdAt", "draft", "draftVersion", "id", "publishedVersion", "revision", "state", "updatedAt"]);

    const stored = await blobs.get(`content/photos/${sha(bytes)}.png`);
    expect(stored && Buffer.from(stored).equals(bytes)).toBe(true);
    expect(blobs.contentTypeOf(`content/photos/${sha(bytes)}.png`)).toBe("image/png");

    const id = Number(String(res.body.id).slice(4));
    const items = await sql.query("SELECT * FROM media_items WHERE id = $1", [id]);
    expect(items.rows[0]).toMatchObject({ owner: photographer.principal, state: "unverified", revision: 1, draft_version: 1, published_version: null, created_by: photographer.principal, updated_by: photographer.principal });
    const versions = await sql.query("SELECT * FROM media_versions WHERE media_id = $1", [id]);
    expect(versions.rows).toHaveLength(1);
    expect(versions.rows[0]).toMatchObject({ version: 1, sha256: sha(bytes), created_by: photographer.principal });
    const keys = await sql.query("SELECT * FROM media_upload_keys WHERE principal = $1", [photographer.principal]);
    expect(keys.rows).toMatchObject([{ idempotency_key: key, operation: "create", media_id: String(id), version: 1, sha256: sha(bytes) }]);
    const audit = await sql.query("SELECT * FROM admin_audit WHERE actor = $1", [photographer.principal]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: "media_upload", target: res.body.id });
    expect(audit.rows[0].detail).toMatchObject({ mediaId: res.body.id, version: 1, sha256: sha(bytes), contentType: "image/png", width: 640, height: 480 });
  });

  it("accepts a JPEG and stores it as .jpg", async () => {
    const photographer = await actor("photographer");
    const bytes = jpeg(800, 600, 3);
    const res = await upload(photographer.auth, bytes, newKey(), "image/jpeg");
    expect(res.status).toBe(201);
    expect(res.body.draft).toMatchObject({ contentType: "image/jpeg", width: 800, height: 600, sha256: sha(bytes) });
    expect(await blobs.get(`content/photos/${sha(bytes)}.jpg`)).not.toBeNull();
  });

  it("no response and no audit row contains the storage path", async () => {
    const photographer = await actor("photographer");
    const bytes = png(21, 22, 5);
    const key = newKey();
    const created = await upload(photographer.auth, bytes, key);
    const replay = await upload(photographer.auth, bytes, key);
    expect([created.status, replay.status]).toEqual([201, 200]);
    vi.spyOn(blobs, "put").mockRejectedValue(new StorageUnavailableError());
    const down = await upload(photographer.auth, png(23, 24, 5));
    for (const res of [created, replay, down]) {
      const text = JSON.stringify(res.body) + JSON.stringify(res.headers);
      expect(text).not.toMatch(/photos|content\/|backend\//);
    }
    const audit = await sql.query("SELECT detail FROM admin_audit WHERE actor = $1", [photographer.principal]);
    expect(JSON.stringify(audit.rows)).not.toMatch(/photos|content\/|backend\//);
  });

  it("is strict about the request: a missing or malformed Idempotency-Key is 400, an empty body is 400, another Content-Type is 415", async () => {
    const photographer = await actor("photographer");
    const bytes = png(30, 30);
    for (const key of [null, "has space", "x".repeat(129), "semi;colon"]) {
      const res = await upload(photographer.auth, bytes, key);
      expect(res.status, String(key)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    const empty = await upload(photographer.auth, Buffer.alloc(0));
    expect(empty.status).toBe(400);
    for (const type of ["text/plain", "application/json", "image/gif", "application/octet-stream"]) {
      const res = await request(server).post(PATH).set(photographer.auth).set("Idempotency-Key", newKey()).set("Content-Type", type).send(type === "application/json" ? "{}" : bytes);
      expect(res.status, type).toBe(415);
      expect(res.body.error.code).toBe("invalid_request");
    }
    expect(await itemsOf(photographer.principal)).toBe(0);
  });
});

describe("POST /v1/admin/media: bad images and size", () => {
  it("a bad image is 422 media_invalid, and nothing is stored or written", async () => {
    const photographer = await actor("photographer");
    const full = png(40, 40, 9);
    const before = blobs.size;
    const cases: [string, Buffer, string][] = [
      ["truncated png", full.subarray(0, full.length - 5), "image/png"],
      ["not an image", Buffer.from("this is not an image at all"), "image/png"],
      ["png bytes declared as jpeg", full, "image/jpeg"],
      ["jpeg bytes declared as png", jpeg(), "image/png"],
      ["too large a side", png(4097, 10), "image/png"],
      ["zero side", png(0, 10), "image/png"],
    ];
    for (const [name, bytes, type] of cases) {
      const res = await upload(photographer.auth, bytes, newKey(), type);
      expect(res.status, name).toBe(422);
      expect(res.body.error.code, name).toBe("media_invalid");
    }
    expect(await itemsOf(photographer.principal)).toBe(0);
    expect(await count("admin_audit", "WHERE actor = $1", [photographer.principal])).toBe(0);
    expect(blobs.size).toBe(before);
  });

  it("a body over 5 MB is 413; exactly 5 MB passes the reader and is judged by the sniffer", async () => {
    const photographer = await actor("photographer");
    const over = await upload(photographer.auth, Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    expect(over.status).toBe(413);
    expect(over.body.error.code).toBe("invalid_request");
    const exact = await upload(photographer.auth, Buffer.alloc(5 * 1024 * 1024, 1));
    expect(exact.status).toBe(422);
    expect(exact.body.error.code).toBe("media_invalid");
    expect(await itemsOf(photographer.principal)).toBe(0);
  });
});

describe("POST /v1/admin/media: Idempotency-Key", () => {
  it("the same key and bytes replay the item as stored now (200), and write nothing new", async () => {
    const photographer = await actor("photographer");
    const bytes = png(50, 50, 2);
    const key = newKey();
    const first = await upload(photographer.auth, bytes, key);
    expect(first.status).toBe(201);
    const id = Number(String(first.body.id).slice(4));
    // The item moves on (a later write bumps it); the replay shows it as it is now, not as created.
    await sql.query("UPDATE media_items SET revision = 4, state = 'withdrawn', updated_at = updated_at + interval '1 minute' WHERE id = $1", [id]);
    const replay = await upload(photographer.auth, bytes, key);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body).toMatchObject({ state: "withdrawn", revision: 4 });
    expect(replay.body.draft).toEqual(first.body.draft);
    expect(await itemsOf(photographer.principal)).toBe(1);
    expect(await count("media_upload_keys", "WHERE principal = $1", [photographer.principal])).toBe(1);
    expect(await count("admin_audit", "WHERE actor = $1", [photographer.principal])).toBe(1);
  });

  it("the key is looked up first: a replay needs no storage and answers even when storage is down", async () => {
    const photographer = await actor("photographer");
    const bytes = png(51, 51);
    const key = newKey();
    expect((await upload(photographer.auth, bytes, key)).status).toBe(201);
    vi.spyOn(blobs, "put").mockRejectedValue(new StorageUnavailableError());
    vi.spyOn(blobs, "get").mockRejectedValue(new StorageUnavailableError());
    expect((await upload(photographer.auth, bytes, key)).status).toBe(200);
  });

  it("the same key with other bytes is 422 idempotency_key_reused and nothing is written", async () => {
    const photographer = await actor("photographer");
    const key = newKey();
    expect((await upload(photographer.auth, png(52, 52), key)).status).toBe(201);
    const other = await upload(photographer.auth, png(53, 53), key);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe("idempotency_key_reused");
    // Reuse wins even when the new bytes are not an image: the key is looked up first.
    const garbage = await upload(photographer.auth, Buffer.from("garbage"), key);
    expect(garbage.status).toBe(422);
    expect(garbage.body.error.code).toBe("idempotency_key_reused");
    expect(await itemsOf(photographer.principal)).toBe(1);
  });

  it("the same key already used for another operation is 422 idempotency_key_reused", async () => {
    const photographer = await actor("photographer");
    const bytes = png(54, 54);
    const first = await upload(photographer.auth, bytes, newKey());
    const id = Number(String(first.body.id).slice(4));
    // A version upload (plan T4) stored this key against the same item and the same bytes: still not a create.
    const key = newKey();
    await sql.query(
      "INSERT INTO media_upload_keys (principal, idempotency_key, operation, media_id, version, sha256, created_at) VALUES ($1, $2, 'version', $3, 1, $4, now())",
      [photographer.principal, key, id, sha(bytes)],
    );
    const res = await upload(photographer.auth, bytes, key);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("idempotency_key_reused");
    expect(await itemsOf(photographer.principal)).toBe(1);
  });

  it("two callers may use the same key independently", async () => {
    const a = await actor("photographer");
    const b = await actor("photographer");
    const key = newKey();
    const bytes = png(55, 55);
    const first = await upload(a.auth, bytes, key);
    const second = await upload(b.auth, bytes, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });

  it("a concurrent duplicate (same key, in parallel) makes exactly one item", async () => {
    const photographer = await actor("photographer");
    const bytes = png(56, 56, 4);
    const key = newKey();
    const results = await Promise.all(Array.from({ length: 8 }, () => upload(photographer.auth, bytes, key)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(7);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await itemsOf(photographer.principal)).toBe(1);
    expect(await count("media_upload_keys", "WHERE principal = $1", [photographer.principal])).toBe(1);
    expect(await count("admin_audit", "WHERE actor = $1", [photographer.principal])).toBe(1);
    expect(await count("media_versions", "WHERE media_id = $1", [Number(String(results[0]!.body.id).slice(4))])).toBe(1);
  });

  it("a different file under a new key is a new item, even with the same bytes already stored (content-addressed)", async () => {
    const photographer = await actor("photographer");
    const bytes = png(57, 57);
    const a = await upload(photographer.auth, bytes);
    const b = await upload(photographer.auth, bytes);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.id).not.toBe(a.body.id);
  });
});

describe("POST /v1/admin/media: storage trouble", () => {
  it("storage down is 503 storage_unavailable with Retry-After, and nothing is written", async () => {
    const photographer = await actor("photographer");
    vi.spyOn(blobs, "put").mockRejectedValue(new StorageUnavailableError());
    const res = await upload(photographer.auth, png(60, 60));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("storage_unavailable");
    expect(res.headers["retry-after"]).toBeTruthy();
    expect(await itemsOf(photographer.principal)).toBe(0);
    expect(await count("media_upload_keys", "WHERE principal = $1", [photographer.principal])).toBe(0);
    expect(await count("admin_audit", "WHERE actor = $1", [photographer.principal])).toBe(0);
  });

  it("a storage refusal a retry will not fix is 503 without Retry-After", async () => {
    const photographer = await actor("photographer");
    vi.spyOn(blobs, "put").mockRejectedValue(new StorageRequestError(403));
    const res = await upload(photographer.auth, png(61, 61));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("storage_unavailable");
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(await itemsOf(photographer.principal)).toBe(0);
  });

  it("a read-back that is missing or differs is 503 and nothing is written", async () => {
    const photographer = await actor("photographer");
    const get = vi.spyOn(blobs, "get").mockResolvedValue(null);
    const missing = await upload(photographer.auth, png(62, 62));
    expect(missing.status).toBe(503);
    expect(missing.body.error.code).toBe("storage_unavailable");
    get.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const different = await upload(photographer.auth, png(63, 63));
    expect(different.status).toBe(503);
    get.mockRejectedValue(new StorageUnavailableError());
    expect((await upload(photographer.auth, png(64, 64))).status).toBe(503);
    expect(await itemsOf(photographer.principal)).toBe(0);
    expect(await count("media_upload_keys", "WHERE principal = $1", [photographer.principal])).toBe(0);
  });

  it("after a storage failure the same key can be retried and then succeeds", async () => {
    const photographer = await actor("photographer");
    const bytes = png(65, 65);
    const key = newKey();
    const put = vi.spyOn(blobs, "put").mockRejectedValueOnce(new StorageUnavailableError());
    expect((await upload(photographer.auth, bytes, key)).status).toBe(503);
    put.mockRestore();
    expect((await upload(photographer.auth, bytes, key)).status).toBe(201);
    expect(await itemsOf(photographer.principal)).toBe(1);
  });
});

// ---- the lost-race branch, deterministically ----

/** Wait until some backend is blocked on a lock (the upload's key claim waiting for our uncommitted key row). */
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const { rows } = await sql.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'",
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the upload never blocked on the key row");
}

/**
 * Hold (principal, key) as an UNCOMMITTED claim of `seedBytes` in an open transaction, fire an upload of `sendBytes` with that key,
 * wait until it is blocked on the unique insert, then COMMIT. The upload then loses the race, which is the KeyAlreadyClaimed branch.
 */
async function race(photographer: { principal: string; auth: Record<string, string> }, key: string, seedBytes: Buffer, sendBytes: Buffer) {
  const client = await sql.connect();
  let pending: Promise<request.Response> | undefined;
  try {
    await client.query("BEGIN");
    const item = await client.query<{ id: string }>(
      `INSERT INTO media_items (owner, state, draft_version, created_by, updated_by, created_at, updated_at)
       VALUES ($1, 'unverified', 1, $1, $1, clock_timestamp(), clock_timestamp()) RETURNING id`,
      [photographer.principal],
    );
    const id = Number(item.rows[0]!.id);
    await client.query(
      `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_required, created_by, created_at)
       VALUES ($1, 1, $2, 'image/png', $3, 64, 48, true, $4, clock_timestamp())`,
      [id, sha(seedBytes), seedBytes.length, photographer.principal],
    );
    await client.query(
      "INSERT INTO media_upload_keys (principal, idempotency_key, operation, media_id, version, sha256, created_at) VALUES ($1, $2, 'create', $3, 1, $4, clock_timestamp())",
      [photographer.principal, key, id, sha(seedBytes)],
    );
    pending = upload(photographer.auth, sendBytes, key).then((r) => r);
    await waitForLockWait();
    await client.query("COMMIT");
    return { id, res: await pending };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await pending?.catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe("POST /v1/admin/media: losing the key race", () => {
  it("a duplicate blocked on the key claim replays the winner's item (200) and writes nothing of its own", async () => {
    const photographer = await actor("photographer");
    const bytes = png(70, 70, 1);
    const { id, res } = await race(photographer, newKey(), bytes, bytes);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(`med-${id}`);
    expect(await itemsOf(photographer.principal)).toBe(1);
    expect(await count("media_versions", "WHERE media_id = $1", [id])).toBe(1);
    expect(await count("media_upload_keys", "WHERE principal = $1", [photographer.principal])).toBe(1);
    expect(await count("admin_audit", "WHERE actor = $1", [photographer.principal])).toBe(0);
  });

  it("the same race with other bytes is 422 idempotency_key_reused and writes nothing", async () => {
    const photographer = await actor("photographer");
    const { id, res } = await race(photographer, newKey(), png(71, 71, 1), png(72, 72, 1));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("idempotency_key_reused");
    expect(await itemsOf(photographer.principal)).toBe(1);
    expect(await count("media_versions", "WHERE media_id = $1", [id])).toBe(1);
    expect(await count("admin_audit", "WHERE actor = $1", [photographer.principal])).toBe(0);
  });

  it("no connection leaks: more lost races and plain uploads than the pool size still all succeed", async () => {
    const photographer = await actor("photographer");
    for (let n = 0; n < 12; n += 1) {
      const bytes = png(80 + n, 80, 1);
      expect((await race(photographer, newKey(), bytes, bytes)).res.status).toBe(200);
    }
    for (let n = 0; n < 12; n += 1) expect((await upload(photographer.auth, png(100 + n, 90, 1))).status).toBe(201);
    expect(await itemsOf(photographer.principal)).toBe(24);
  });
});

// ---- routing, limits and timestamps ----

describe("POST /v1/admin/media: reader scope, rate limit and clock", () => {
  it("an admin can upload a real image over 16 KB (admin satisfies the photographer reader)", async () => {
    const admin = await actor("admin");
    const big = png(90, 90, 20_000);
    expect(big.length).toBeGreaterThan(16 * 1024);
    const res = await upload(admin.auth, big);
    expect(res.status).toBe(201);
    expect(res.body.draft.byteSize).toBe(big.length);
  });

  it("the 5 MB reader is mounted on the collection and on /med-<n>/versions only: any other sub-route is not read (404, not 413)", async () => {
    const admin = await actor("admin");
    const headers = { ...admin.auth, "Idempotency-Key": newKey() };
    expect(await unfinishedUpload(server, headers, `${PATH}/med-1/other`, "image/png")).toBe(404);
    expect(await unfinishedUpload(server, headers, `${PATH}/not-an-id/versions`, "image/png")).toBe(404);
    expect(await unfinishedUpload(server, headers, `${PATH}/med-1/versions/extra`, "image/png")).toBe(404);
    const small = await request(server).post(`${PATH}/med-1/other`).set(admin.auth).set("Content-Type", "image/png").send(png(10, 10, 20_000));
    expect(small.status).toBe(404);
    // Contrast: the same oversize image on the exact path is refused by the 5 MB reader (413, covered above); on a sub-route the
    // reader is not mounted, so the body is never buffered and the route answers 404.
    // The server may answer before the client has finished sending and drop the connection (ECONNRESET): that also means unread.
    const oversize = await request(server)
      .post(`${PATH}/med-1/other`)
      .set(admin.auth)
      .set("Content-Type", "image/png")
      .send(Buffer.alloc(5 * 1024 * 1024 + 1, 1))
      .then((res) => res.status, (error: NodeJS.ErrnoException) => error.code);
    expect([404, "ECONNRESET", "EPIPE"]).toContain(oversize);
  });

  it("the request counts against the rate limit before the body is read: a refused caller gets 429 without sending the body", async () => {
    const saved = process.env.RATE_LIMIT_AUTH_PER_MIN;
    process.env.RATE_LIMIT_AUTH_PER_MIN = "3";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const limited = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApp(limited);
    await limited.listen(0, "127.0.0.1");
    if (saved === undefined) delete process.env.RATE_LIMIT_AUTH_PER_MIN;
    else process.env.RATE_LIMIT_AUTH_PER_MIN = saved;
    try {
      const photographer = await actor("photographer");
      const target = limited.getHttpServer();
      for (let n = 0; n < 3; n += 1) {
        const res = await request(target).post(PATH).set(photographer.auth).set("Content-Type", "image/png").set("Idempotency-Key", newKey()).send(png(110 + n, 40));
        expect(res.status).toBe(201);
      }
      const status = await unfinishedUpload(target, { ...photographer.auth, "Idempotency-Key": newKey() }, PATH, "image/png");
      expect(status).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it("created_at and updated_at come from the database clock: between database now() read before and after the request", async () => {
    const photographer = await actor("photographer");
    const stamp = async () => (await sql.query<{ t: Date }>("SELECT date_trunc('milliseconds', clock_timestamp()) AS t")).rows[0]!.t;
    const before = await stamp();
    const res = await upload(photographer.auth, png(120, 120, 1));
    const after = await stamp();
    expect(res.status).toBe(201);
    const id = Number(String(res.body.id).slice(4));
    const item = (await sql.query<{ created_at: Date; updated_at: Date }>("SELECT created_at, updated_at FROM media_items WHERE id = $1", [id])).rows[0]!;
    const version = (await sql.query<{ created_at: Date }>("SELECT created_at FROM media_versions WHERE media_id = $1", [id])).rows[0]!;
    const audit = (await sql.query<{ created_at: Date }>("SELECT created_at FROM admin_audit WHERE actor = $1", [photographer.principal])).rows[0]!;
    const key = (await sql.query<{ created_at: Date }>("SELECT created_at FROM media_upload_keys WHERE media_id = $1", [id])).rows[0]!;
    for (const at of [item.created_at, item.updated_at, version.created_at, audit.created_at, key.created_at]) {
      expect(at.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(at.getTime()).toBeLessThanOrEqual(after.getTime());
    }
    expect(res.body.createdAt).toBe(item.created_at.toISOString());
  });

  it("ASSUMPTION: a new item's version 1 starts with creditRequired true (the contract does not say)", async () => {
    const photographer = await actor("photographer");
    const res = await upload(photographer.auth, png(130, 130, 1));
    expect(res.body.draft.licence.creditRequired).toBe(true);
  });
});
