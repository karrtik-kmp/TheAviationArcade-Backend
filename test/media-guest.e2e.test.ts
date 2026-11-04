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

// Wave P (docs/plans/media-rights-and-public.md): GET /v1/public/media?ids= for anonymous guests. Staff routes build the fixtures.

const STAFF = "/v1/admin/media";
const PATH = "/v1/public/media";
const SIGNED_IN_PATH = "/v1/media";
const CDN_HOST = "wp-zone.b-cdn.net";
const CDN_KEY = "wp-test-signing-key-0123456789abcdef";
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
const newKey = () => `wp-${randomUUID().slice(0, 8)}-${keyCounter++}`;
let extra = 2000 + Math.floor(Math.random() * 100_000);

/** A well-formed emulator token whose exp is in the past. */
function expiredToken(): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://securetoken.google.com/demo-airplane-games",
    aud: "demo-airplane-games",
    sub: "expired-user",
    iat: now - 7200,
    exp: now - 3600,
    auth_time: now - 7200,
    email_verified: true,
    firebase: { sign_in_provider: "password" },
  };
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
}

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

const cdn = { host: CDN_HOST, tokenKey: CDN_KEY };
let withCdn: Booted;
let withoutCdn: Booted;
let gated: Booted;
let limited: Booted;
let sql: pg.Pool;
const principals: string[] = [];

type Actor = { principal: string; auth: { Authorization: string } };
async function actor(role: "photographer" | "admin" | null): Promise<Actor> {
  const uid = `mediawp-${role ?? "none"}-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  principals.push(principal);
  if (role) await seedRole(sql, principal, role);
  return { principal, auth: bearer(uid) };
}

type Item = { id: string; revision: number };
type Ref = { mediaId: string; url: string | null; expiresAt: string | null };
const guest = (query: string, b = withCdn) => request(b.server).get(`${PATH}${query}`);
const signedIn = (who: Actor, query: string, b = withCdn) => request(b.server).get(`${SIGNED_IN_PATH}${query}`).set(who.auth);
const stripLinks = (body: { images: Ref[] }) => body.images.map(({ url: _u, expiresAt: _e, ...rest }) => rest);
const ids = (res: { body: { images: Ref[] } }) => res.body.images.map((i) => i.mediaId);

function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysDeep(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

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
  withCdn = await boot({ cdn });
  withoutCdn = await boot({ cdn: undefined });
  gated = await boot({ cdn, minClientBuild: 20 });
  limited = await boot({ cdn, rateLimitStore: "memory", rateLimitPublicPerMin: 3, rateLimitAuthPerMin: 1000 });
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
  await limited.app.close();
});

describe("GET /v1/public/media", () => {
  it("answers 200 with no token and equals the signed-in route's body apart from link timing", async () => {
    const a = await published("First");
    const b = await published("Second");
    const q = `?ids=${b.id},${a.id}`;
    const res = await guest(q);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.body)).toEqual(["images"]);
    expect(ids(res)).toEqual([b.id, a.id]);
    expect(res.body.images[0]).toMatchObject({ version: 1, sha256: b.sha256, contentType: "image/png", width: 64, height: 48, reason: null });
    for (const ref of res.body.images as Ref[]) {
      expect(new URL(ref.url!).host).toBe(CDN_HOST);
      expect(verifyCdnToken(ref.url!, CDN_KEY, new Date())).toBe(true);
    }
    const signed = await signedIn(player, q);
    expect(signed.status).toBe(200);
    expect(stripLinks(res.body)).toEqual(stripLinks(signed.body));
    expect(res.body.images.map((i: Ref) => new URL(i.url!).pathname)).toEqual(signed.body.images.map((i: Ref) => new URL(i.url!).pathname));
  });

  it("ignores the Authorization header: garbage, malformed, wrong-project and expired tokens all still answer 200", async () => {
    const a = await published();
    const q = `?ids=${a.id}`;
    const plain = await guest(q);
    expect(plain.status).toBe(200);
    const headers = [
      "garbage",
      "Bearer not.a.jwt",
      "Bearer ",
      `Bearer ${expiredToken()}`,
      `Bearer ${emulatorToken("x", "some-other-project", "password")}`,
    ];
    for (const header of headers) {
      const res = await guest(q).set("Authorization", header);
      expect(res.status, header).toBe(200);
      expect(stripLinks(res.body)).toEqual(stripLinks(plain.body));
    }
  });

  it("needs no client version even when the build gate is on", async () => {
    const a = await published();
    const q = `?ids=${a.id}`;
    expect((await signedIn(player, q, gated)).status).toBe(426);
    const res = await guest(q, gated);
    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(1);
  });

  it("returns only published images, keeps request order and collapses duplicates", async () => {
    const live1 = await published();
    const live2 = await published();
    const draft = await upload();
    const gone = await published();
    const withdrawn = await request(withCdn.server).post(`${STAFF}/${gone.id}/withdraw`).set(admin.auth).send({ revision: gone.revision });
    expect(withdrawn.status).toBe(200);
    const res = await guest(`?ids=${live2.id},${draft.id},med-999999999999,${gone.id},${live1.id},${live2.id}`);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([live2.id, live1.id]);
    const none = await guest(`?ids=${draft.id},${gone.id}`);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ images: [] });
  });

  it("answers url null and reason cdn_not_configured without a CDN", async () => {
    const a = await published();
    const res = await guest(`?ids=${a.id}`, withoutCdn);
    expect(res.status).toBe(200);
    expect(res.body.images[0]).toMatchObject({ mediaId: a.id, url: null, expiresAt: null, reason: "cdn_not_configured" });
  });

  it("exposes no owner, createdBy, statedBy, description or rights key anywhere, and no principal or signing key", async () => {
    const a = await published();
    const res = await guest(`?ids=${a.id}`);
    expect(res.body.images).toHaveLength(1);
    const keys = keysDeep(res.body);
    expect(keys.has("licence")).toBe(true); // the scan sees nested keys
    for (const forbidden of ["owner", "createdBy", "statedBy", "description", "rights"]) expect(keys.has(forbidden), forbidden).toBe(false);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(owner.principal);
    expect(text).not.toContain(admin.principal);
    expect(text).not.toContain(CDN_KEY);
  });

  it("accepts exactly 50 ids and refuses 51", async () => {
    const a = await published();
    const fifty = [a.id, ...Array.from({ length: 49 }, (_, i) => `med-${900_000_000 + i}`)];
    const ok = await guest(`?ids=${fifty.join(",")}`);
    expect(ok.status).toBe(200);
    expect(ok.body.images).toHaveLength(1);
    const tooMany = await guest(`?ids=${[...fifty, "med-999"].join(",")}`);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe("invalid_request");
  });

  it.each([
    ["no query", ""],
    ["empty value", "?ids="],
    ["bad id", "?ids=mid-1"],
    ["leading zero", "?ids=med-01"],
    ["one bad among good", "?ids=med-1,nope"],
    ["repeated parameter", "?ids=med-1&ids=med-2"],
    ["unknown parameter", "?ids=med-1&limit=5"],
  ])("is 400 invalid_request for %s", async (_name, query) => {
    const res = await guest(query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("is rate limited per IP on the public tier: 429 rate_limited with Retry-After after the limit", async () => {
    const a = await published();
    const q = `?ids=${a.id}`;
    for (let i = 0; i < 3; i += 1) expect((await guest(q, limited)).status).toBe(200);
    const res = await guest(q, limited);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate_limited");
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(60);
  });

  it("counts a request that carries a valid token on the IP bucket, not the principal bucket", async () => {
    const booted = await boot({ cdn, rateLimitStore: "memory", rateLimitPublicPerMin: 2, rateLimitAuthPerMin: 1000 });
    try {
      const a = await published();
      const q = `?ids=${a.id}`;
      const who = await actor(null);
      // One tokened and one anonymous request share the IP bucket of 2.
      expect((await guest(q, booted).set(who.auth)).status).toBe(200);
      expect((await guest(q, booted)).status).toBe(200);
      expect((await guest(q, booted).set(who.auth)).status).toBe(429);
      // The principal's own bucket was never touched: the signed-in route still answers.
      expect((await signedIn(who, q, booted)).status).toBe(200);
    } finally {
      await booted.app.close();
    }
  });
});
