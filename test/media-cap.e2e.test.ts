import { createHash, randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { MEDIA_V2_STATEMENT } from "../src/db/enums.js";
import { BLOB_STORE } from "../src/storage/blob-store.js";
import type { BlobStore } from "../src/storage/blob-store.js";
import { demoPrincipal, seedRole } from "./roles-helpers.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { emulatorToken } from "./tokens.js";

// Cap on photos waiting for review (docs/plans/self-serve-photographer.md S7): a non-admin owner may have at most 20 items that are
// `unverified` and not `declined`; a new upload over it is 429 `submission_limit` with nothing written. Roles are seeded in
// account_roles; the blob store is the in-process MemoryBlobStore. Every test uses fresh actors and the suite deletes only its own rows.

const PATH = "/v1/admin/media";
const V2 = MEDIA_V2_STATEMENT;
const CAP = 20;
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

const bearer = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid, "demo-airplane-games", "password")}` });
let keyCounter = 0;
const newKey = () => `cap-${randomUUID().slice(0, 8)}-${keyCounter++}`;
let bytesCounter = 0;
const freshPng = () => png(20_000 + ++bytesCounter + Math.floor(Math.random() * 1e5) * 10);
const enc = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;
let blobs: BlobStore;
const principals: string[] = [];

type Actor = { uid: string; principal: string; auth: { Authorization: string } };

async function actor(role: "photographer" | "admin"): Promise<Actor> {
  const uid = `mediacap-${role}-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  principals.push(principal);
  await seedRole(sql, principal, role);
  return { uid, principal, auth: bearer(uid) };
}

const SUB = { fullName: "Cap Tester", title: "Dawn departure", credit: "C. Tester", instagramHandle: "cap.tester", instagramDisplayConsent: true };

type Item = { id: string; state: string; revision: number };

const upload = (who: Actor, bytes: Buffer = freshPng(), key = newKey()) =>
  request(server).post(PATH).set(who.auth).set("Content-Type", "image/png").set("Idempotency-Key", key).set("X-Rights-Statement", V2).set("X-Submission", enc(SUB)).send(bytes);
const addVersion = (who: Actor, id: string, revision: number) =>
  request(server)
    .post(`${PATH}/${id}/versions?revision=${revision}`)
    .set(who.auth)
    .set("Content-Type", "image/png")
    .set("Idempotency-Key", newKey())
    .set("X-Rights-Statement", V2)
    .set("X-Submission", enc(SUB))
    .send(freshPng());
const review = (who: Actor, id: string, body: unknown) => request(server).post(`${PATH}/${id}/review`).set(who.auth).send(body as object);
const publish = (who: Actor, id: string, revision: number) => request(server).post(`${PATH}/${id}/publish`).set(who.auth).send({ revision });
const withdraw = (who: Actor, id: string, revision: number) => request(server).post(`${PATH}/${id}/withdraw`).set(who.auth).send({ revision });

/** `n` accepted uploads by `who`, in order. */
async function fill(who: Actor, n: number): Promise<Item[]> {
  const items: Item[] = [];
  for (let i = 0; i < n; i++) {
    const res = await upload(who);
    expect(res.status, `upload ${i + 1}`).toBe(201);
    items.push(res.body as Item);
  }
  return items;
}

const written = async (who: Actor) => ({
  items: (await sql.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM media_items WHERE owner = $1", [who.principal])).rows[0]!.n,
  keys: (await sql.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM media_upload_keys WHERE principal = $1", [who.principal])).rows[0]!.n,
  audit: (await sql.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM admin_audit WHERE actor = $1", [who.principal])).rows[0]!.n,
});

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  blobs = app.get<BlobStore>(BLOB_STORE);
});

afterAll(async () => {
  const owned = "(SELECT id FROM media_items WHERE owner = ANY($1))";
  await sql.query(`DELETE FROM media_upload_keys WHERE media_id IN ${owned}`, [principals]);
  await sql.query(`DELETE FROM media_submissions WHERE media_id IN ${owned}`, [principals]);
  await frozenDelete(sql, "media_versions", `media_id IN ${owned}`, [principals]);
  await sql.query("DELETE FROM media_items WHERE owner = ANY($1)", [principals]);
  await frozenDelete(sql, "admin_audit", "actor = ANY($1)", [principals]);
  await sql.query("DELETE FROM account_roles WHERE principal = ANY($1)", [principals]);
  await sql.end();
  await app.close();
});

describe("photo submission cap (S7)", () => {
  it("the 20th upload is accepted and the 21st is 429 submission_limit with nothing written", async () => {
    const owner = await actor("photographer");
    await fill(owner, CAP);
    const before = await written(owner);
    expect(before.items).toBe(CAP);

    const bytes = freshPng();
    const sha = createHash("sha256").update(bytes).digest("hex");
    const res = await upload(owner, bytes);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("submission_limit");
    expect(res.body.error.message).toContain(String(CAP));
    expect(await written(owner)).toEqual(before);
    expect(await blobs.get(`content/photos/${sha}.png`)).toBeNull();
  });

  it("declined items do not count: declining one frees a slot", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const items = await fill(owner, CAP);
    expect((await upload(owner)).status).toBe(429);
    const declined = await review(admin, items[0]!.id, { revision: items[0]!.revision, decision: "declined", reason: "Not an aviation photo." });
    expect(declined.status).toBe(200);
    expect((await upload(owner)).status).toBe(201);
    expect((await upload(owner)).status).toBe(429);
  });

  it("changes_requested items still count", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const items = await fill(owner, CAP);
    const asked = await review(admin, items[0]!.id, { revision: items[0]!.revision, decision: "changes_requested", reason: "Please fix the credit." });
    expect(asked.status).toBe(200);
    expect((await upload(owner)).status).toBe(429);
  });

  it("published and withdrawn items do not count", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const items = await fill(owner, CAP);
    expect((await upload(owner)).status).toBe(429);

    const live = await publish(admin, items[0]!.id, items[0]!.revision);
    expect(live.status).toBe(200);
    expect((await upload(owner)).status).toBe(201); // back at the cap
    expect((await upload(owner)).status).toBe(429);

    const gone = await withdraw(admin, items[0]!.id, live.body.revision);
    expect(gone.status).toBe(200);
    expect(gone.body.state).toBe("withdrawn");
    expect((await upload(owner)).status).toBe(429); // the withdrawn item stays out of the count, nothing new freed
  });

  it("an admin is exempt", async () => {
    const admin = await actor("admin");
    await fill(admin, CAP + 1);
    expect((await written(admin)).items).toBe(CAP + 1);
  });

  it("another account's items do not count against this one", async () => {
    const full = await actor("photographer");
    const other = await actor("photographer");
    await fill(full, CAP);
    expect((await upload(other)).status).toBe(201);
  });

  it("a replay of an existing Idempotency-Key at the cap is still answered 200", async () => {
    const owner = await actor("photographer");
    const bytes = freshPng();
    const key = newKey();
    const first = await upload(owner, bytes, key);
    expect(first.status).toBe(201);
    await fill(owner, CAP - 1);
    expect((await upload(owner)).status).toBe(429);

    const again = await upload(owner, bytes, key);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect((await written(owner)).items).toBe(CAP);
  });

  it("new versions at the cap are not capped", async () => {
    const owner = await actor("photographer");
    const items = await fill(owner, CAP);
    expect((await upload(owner)).status).toBe(429);
    const more = await addVersion(owner, items[0]!.id, items[0]!.revision);
    expect(more.status).toBe(201);
    expect(more.body.draftVersion).toBe(2);
  });

  it("two parallel uploads at 19 items: one 201, one 429, 20 items stored", async () => {
    const owner = await actor("photographer");
    await fill(owner, CAP - 1);
    const results = await Promise.all([upload(owner), upload(owner)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 429]);
    const refused = results.find((r) => r.status === 429)!;
    expect(refused.body.error.code).toBe("submission_limit");
    expect((await written(owner)).items).toBe(CAP);
  });
});
