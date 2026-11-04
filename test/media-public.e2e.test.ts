import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { APP_CONFIG, loadConfig } from "../src/config/config.module.js";
import { verifyCdnToken } from "../src/platform/cdn-signer.js";
import { demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";

// Media plan T7 (docs/plans/media-pipeline.md): GET /v1/media?ids= for any signed-in caller. Staff routes build the fixtures.

const STAFF = "/v1/admin/media";
const PATH = "/v1/media";
const CDN_HOST = "t7-zone.b-cdn.net";
const CDN_KEY = "t7-test-signing-key-0123456789abcdef";
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function png(w: number, h: number, extra: number): Buffer {
  const ancillary = [...be32(extra), 0x74, 0x45, 0x58, 0x74, ...Array<number>(extra).fill(65), 0, 0, 0, 0];
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...ancillary,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

const bearer = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid, "demo-airplane-games", "password")}` });
let keyCounter = 0;
const newKey = () => `t7-${randomUUID().slice(0, 8)}-${keyCounter++}`;
let extra = 2000 + Math.floor(Math.random() * 100_000);

type Booted = { app: NestExpressApplication; server: ReturnType<NestExpressApplication["getHttpServer"]> };
async function boot(overrides: Record<string, unknown>): Promise<Booted> {
  const base = loadConfig(process.env);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue({ ...base, ...overrides })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  return { app, server: app.getHttpServer() };
}

let withCdn: Booted;
let withoutCdn: Booted;
let gated: Booted;
let sql: pg.Pool;
const principals: string[] = [];

type Actor = { principal: string; auth: { Authorization: string } };
async function actor(role: "photographer" | "admin" | null): Promise<Actor> {
  const uid = `media7-${role ?? "none"}-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  principals.push(principal);
  if (role) await seedRole(sql, principal, role);
  return { principal, auth: bearer(uid) };
}

type Item = { id: string; revision: number };
const get = (who: Actor, query: string, b = withCdn) => request(b.server).get(`${PATH}${query}`).set(who.auth);

let owner: Actor;
let admin: Actor;
let player: Actor;

async function upload(): Promise<Item> {
  const res = await request(withCdn.server)
    .post(STAFF)
    .set(owner.auth)
    .set("Content-Type", "image/png")
    .set("Idempotency-Key", newKey()).set("X-Rights-Statement", "v1_own")
    .send(png(64, 48, extra++));
  expect(res.status).toBe(201);
  return res.body;
}

/** Upload, fill the licence, publish. */
async function published(credit = "A. Pilot"): Promise<Item & { sha256: string }> {
  const item = await upload();
  const edited = await request(withCdn.server)
    .patch(`${STAFF}/${item.id}`)
    .set(owner.auth)
    .send({ revision: item.revision, licence: { credit, licenceName: "CC BY 4.0", licenceUrl: "https://example.com/l", attributionText: "By A." } });
  expect(edited.status).toBe(200);
  const pub = await request(withCdn.server).post(`${STAFF}/${item.id}/publish`).set(admin.auth).send({ revision: edited.body.revision });
  expect(pub.status).toBe(200);
  return { id: item.id, revision: pub.body.revision, sha256: pub.body.draft.sha256 };
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  withCdn = await boot({ cdn: { host: CDN_HOST, tokenKey: CDN_KEY } });
  withoutCdn = await boot({ cdn: undefined });
  gated = await boot({ cdn: { host: CDN_HOST, tokenKey: CDN_KEY }, minClientBuild: 20 });
  owner = await actor("photographer");
  admin = await actor("admin");
  player = await actor(null);
});

afterAll(async () => {
  const owned = "(SELECT id FROM media_items WHERE owner = ANY($1))";
  await sql.query(`DELETE FROM media_upload_keys WHERE media_id IN ${owned}`, [principals]);
  await sql.query(`DELETE FROM media_versions WHERE media_id IN ${owned}`, [principals]);
  await sql.query("DELETE FROM media_items WHERE owner = ANY($1)", [principals]);
  await sql.query("DELETE FROM admin_audit WHERE actor = ANY($1)", [principals]);
  await sql.query("DELETE FROM account_roles WHERE principal = ANY($1)", [principals]);
  await sql.end();
  await withCdn.app.close();
  await withoutCdn.app.close();
  await gated.app.close();
});

describe("GET /v1/media", () => {
  it("needs a token; a signed-in caller with no role and no player row reads", async () => {
    const a = await published();
    expect((await request(withCdn.server).get(`${PATH}?ids=${a.id}`)).status).toBe(401);
    const res = await get(player, `?ids=${a.id}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.images).toHaveLength(1);
  });

  it("returns the published version in ids order with a link signed per file, and nothing internal", async () => {
    const a = await published("First");
    const b = await published("Second");
    const c = await published("Third");
    const res = await get(player, `?ids=${c.id},${a.id},${b.id}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["images"]);
    expect(res.body.images.map((i: { mediaId: string }) => i.mediaId)).toEqual([c.id, a.id, b.id]);
    const urls = new Set<string>();
    for (const [i, expected] of [c, a, b].entries()) {
      const ref = res.body.images[i];
      expect(ref).toMatchObject({ mediaId: expected.id, version: 1, sha256: expected.sha256, contentType: "image/png", width: 64, height: 48, reason: null });
      expect(Object.keys(ref).sort()).toEqual(["contentType", "expiresAt", "height", "licence", "mediaId", "reason", "sha256", "url", "version", "width"]);
      expect(ref.licence).toEqual({
        credit: ["Third", "First", "Second"][i],
        licenceName: "CC BY 4.0",
        licenceUrl: "https://example.com/l",
        sourceUrl: null,
        attributionText: "By A.",
        creditRequired: true,
      });
      const url = new URL(ref.url);
      expect(url.host).toBe(CDN_HOST);
      expect(url.pathname).toBe(`/backend/content/photos/${expected.sha256}.png`);
      expect(verifyCdnToken(ref.url, CDN_KEY, new Date())).toBe(true);
      expect(Number(url.searchParams.get("expires"))).toBe(Date.parse(ref.expiresAt) / 1000);
      urls.add(ref.url);
    }
    expect(urls.size).toBe(3);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(CDN_KEY);
    expect(text).not.toContain(owner.principal);
    expect(text).not.toContain("owner");
  });

  it("leaves out unpublished, withdrawn and unknown ids without an error", async () => {
    const live = await published();
    const draft = await upload();
    const gone = await published();
    const withdrawn = await request(withCdn.server).post(`${STAFF}/${gone.id}/withdraw`).set(admin.auth).send({ revision: gone.revision });
    expect(withdrawn.status).toBe(200);
    const res = await get(player, `?ids=${draft.id},med-999999999999,${live.id},${gone.id}`);
    expect(res.status).toBe(200);
    expect(res.body.images.map((i: { mediaId: string }) => i.mediaId)).toEqual([live.id]);
    const none = await get(player, `?ids=${draft.id},${gone.id}`);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ images: [] });
  });

  it("serves the published version while a newer draft is pending, then the new one once published", async () => {
    const a = await published("Old credit");
    const edit = await request(withCdn.server)
      .patch(`${STAFF}/${a.id}`)
      .set(owner.auth)
      .send({ revision: a.revision, licence: { credit: "New credit" } });
    expect(edit.status).toBe(200);
    expect(edit.body.draftVersion).toBe(2);
    const before = await get(player, `?ids=${a.id}`);
    expect(before.body.images[0]).toMatchObject({ version: 1, licence: { credit: "Old credit" } });
    const pub = await request(withCdn.server).post(`${STAFF}/${a.id}/publish`).set(admin.auth).send({ revision: edit.body.revision });
    expect(pub.status).toBe(200);
    const after = await get(player, `?ids=${a.id}`);
    expect(after.body.images[0]).toMatchObject({ version: 2, licence: { credit: "New credit" } });
  });

  it("collapses duplicate ids, keeping the first position", async () => {
    const a = await published();
    const b = await published();
    const res = await get(player, `?ids=${b.id},${a.id},${b.id},${a.id}`);
    expect(res.status).toBe(200);
    expect(res.body.images.map((i: { mediaId: string }) => i.mediaId)).toEqual([b.id, a.id]);
  });

  it("accepts exactly 50 ids and refuses 51", async () => {
    const a = await published();
    const fifty = [a.id, ...Array.from({ length: 49 }, (_, i) => `med-${900_000_000 + i}`)];
    const ok = await get(player, `?ids=${fifty.join(",")}`);
    expect(ok.status).toBe(200);
    expect(ok.body.images).toHaveLength(1);
    const tooMany = await get(player, `?ids=${[...fifty, "med-999"].join(",")}`);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe("invalid_request");
    // 51 as sent is refused even when duplicates would collapse below the limit.
    const dupes = await get(player, `?ids=${Array.from({ length: 51 }, () => a.id).join(",")}`);
    expect(dupes.status).toBe(400);
  });

  it.each([
    ["no query", ""],
    ["empty value", "?ids="],
    ["empty element", "?ids=med-1,,med-2"],
    ["trailing comma", "?ids=med-1,"],
    ["leading zero", "?ids=med-01"],
    ["zero", "?ids=med-0"],
    ["too many digits", "?ids=med-1234567890123456"],
    ["wrong prefix", "?ids=mid-1"],
    ["upper case", "?ids=MED-1"],
    ["spaces", "?ids=med-1,%20med-2"],
    ["bare number", "?ids=1"],
    ["repeated parameter", "?ids=med-1&ids=med-2"],
    ["array syntax", "?ids[]=med-1"],
    ["unknown parameter", "?ids=med-1&limit=5"],
    ["other parameter only", "?id=med-1"],
  ])("is 400 invalid_request for %s", async (_name, query) => {
    const res = await get(player, query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("answers with url null and reason cdn_not_configured when the CDN is not configured", async () => {
    const a = await published();
    const res = await get(player, `?ids=${a.id}`, withoutCdn);
    expect(res.status).toBe(200);
    expect(res.body.images[0]).toMatchObject({ mediaId: a.id, sha256: a.sha256, url: null, expiresAt: null, reason: "cdn_not_configured" });
  });

  it("applies the client version gate; X-Client: web and a high enough build pass", async () => {
    const a = await published();
    const q = `?ids=${a.id}`;
    const low = await get(player, q, gated);
    expect(low.status).toBe(426);
    expect(low.body.error.code).toBe("client_update_required");
    expect((await get(player, q, gated).set("X-Client-Version", "19")).status).toBe(426);
    expect((await get(player, q, gated).set("X-Client-Version", "20")).status).toBe(200);
    const web = await get(player, q, gated).set("X-Client", "web");
    expect(web.status).toBe(200);
    expect(web.body.images).toHaveLength(1);
  });
});
