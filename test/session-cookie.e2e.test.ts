import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { RequestMethod } from "@nestjs/common";
import { DiscoveryService, ModulesContainer } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FIREBASE_ACCOUNTS } from "../src/accounts/firebase-accounts.js";
import type { FirebaseAccounts, SessionStateResult } from "../src/accounts/firebase-accounts.js";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { SESSION_COOKIE_ALLOWED } from "../src/auth/session-cookie.decorator.js";
import { APP_CONFIG, loadConfig } from "../src/config/config.module.js";
import type { AppConfig } from "../src/config/config.module.js";
import { MEDIA_V2_STATEMENT } from "../src/db/enums.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorSessionCookie, emulatorToken } from "./tokens.js";

// docs/plans/session-cookies.md C4-C9: a Firebase session cookie as a website credential, against the real Nest app and the test database.
// The Auth Emulator issues unsigned (`alg: none`) cookies, so these are emulator-style cookies under emulatorTokensAllowed; revocation
// is answered by a FAKE FirebaseAccounts (never a network) behind the real SessionRevocation (so its cache and deadline logic are the
// production ones). Every uid is fresh, so the 60 s revocation cache never carries over between tests.

const MEDIA = "/v1/admin/media";
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A minimal valid PNG; `extra` varies the bytes. */
function png(extra: number): Buffer {
  const ancillary = [...be32(extra), 0x74, 0x45, 0x58, 0x74, ...Array<number>(extra).fill(65), 0, 0, 0, 0];
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(64), ...be32(48), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...ancillary,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}
let counter = 0;
const freshPng = () => png(2000 + ++counter + Math.floor(Math.random() * 1e5) * 10);
const key = () => `sc-${randomUUID().slice(0, 8)}-${counter++}`;

/** The fake Firebase Admin side: per-uid answers and a record of every lookup. */
class FakeAccounts implements FirebaseAccounts {
  readonly lookups: string[] = [];
  readonly answers = new Map<string, SessionStateResult>();
  async ensureEmailVerified(): Promise<{ kind: "not_configured" }> {
    return { kind: "not_configured" };
  }
  async lookupSessionState(uid: string): Promise<SessionStateResult> {
    this.lookups.push(uid);
    return this.answers.get(uid) ?? { kind: "found", disabled: false, validSince: undefined };
  }
  count(uid: string): number {
    return this.lookups.filter((u) => u === uid).length;
  }
}

type Srv = ReturnType<NestExpressApplication["getHttpServer"]>;
const apps: NestExpressApplication[] = [];
let sql: pg.Pool;
let accounts: FakeAccounts;
let main: Srv;
let mainApp: NestExpressApplication;
let limited: Srv;
let noAdmin: Srv;
const principals: string[] = [];

async function buildApp(overrides: Partial<AppConfig>): Promise<NestExpressApplication> {
  const config: AppConfig = { ...loadConfig(process.env), rateLimitStore: "memory", ...overrides };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(FIREBASE_ACCOUNTS)
    .useValue(accounts)
    .compile();
  const built = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(built);
  await built.listen(0, "127.0.0.1");
  apps.push(built);
  return built;
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  accounts = new FakeAccounts();
  mainApp = await buildApp({ rateLimitAuthPerMin: 100_000, rateLimitPublicPerMin: 100_000 });
  main = mainApp.getHttpServer();
  // The session-cookie path needs an Admin credential; the e2e config gives the emulator one. Assert it so a change shows here.
  expect(mainApp.get<AppConfig>(APP_CONFIG).firebaseAdmin).toBeDefined();
  limited = (await buildApp({ rateLimitAuthPerMin: 1, rateLimitPublicPerMin: 100_000 })).getHttpServer();
  noAdmin = (await buildApp({ firebaseAdmin: undefined, rateLimitAuthPerMin: 100_000, rateLimitPublicPerMin: 100_000 })).getHttpServer();
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
  for (const app of apps) await app.close();
});

afterEach(() => {
  accounts.lookups.length = 0;
});

const cookie = (uid: string) => ({ Authorization: `Bearer ${emulatorSessionCookie(uid)}` });
const idToken = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid)}` });
const newUid = (label: string) => `sc-${label}-${randomUUID()}`;

async function photographer(label = "photo"): Promise<string> {
  const uid = newUid(label);
  const principal = demoPrincipal(uid);
  principals.push(principal);
  await seedRole(sql, principal, "photographer");
  return uid;
}

const uploadWith = (server: Srv, auth: { Authorization: string }, bytes: Buffer = freshPng()) =>
  request(server).post(MEDIA).set(auth).set("Content-Type", "image/png").set("Idempotency-Key", key()).set("X-Rights-Statement", "v1_own").send(bytes);

/**
 * POST with a cookie, a declared Content-Length over the limit and a body that never ends; resolves with the status. Raw http, not
 * supertest: the server may answer and close while the body is still being sent, which supertest reports as a reset. A reader that
 * waited for the body would hang here instead of answering 401 (an oversize body would be 413).
 */
function rawStatus(uid: string, path: string, headers: Record<string, string>, declaredLength: number): Promise<number> {
  const { port } = (main as { address(): AddressInfo }).address();
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path, headers: { ...cookie(uid), ...headers, "Content-Length": String(declaredLength) } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", (error) => reject(error));
    req.write(Buffer.alloc(64 * 1024, 1));
    setTimeout(() => req.destroy(), 5_000).unref();
  });
}
describe("the nine allowed routes accept a session cookie", () => {
  it("GET /v1/me/roles, GET /v1/me/progress", async () => {
    const uid = newUid("me");
    const roles = await request(main).get("/v1/me/roles").set(cookie(uid));
    expect(roles.status).toBe(200);
    expect(roles.body.roles).toEqual(expect.any(Array));
    // No player row for this uid: 404 player_not_found proves auth passed and the handler ran.
    const progress = await request(main).get("/v1/me/progress").set(cookie(uid));
    expect(progress.status).toBe(404);
    expect(progress.body.error.code).toBe("player_not_found");
  });

  it("POST /v1/me/roles/photographer turns the role on for a verified cookie", async () => {
    const uid = newUid("self");
    principals.push(demoPrincipal(uid));
    const res = await request(main).post("/v1/me/roles/photographer").set(cookie(uid));
    expect(res.status).toBe(201);
    expect(res.body.changed).toBe(true);
  });

  it("the six media routes: list, upload, detail, patch, new version, rights", async () => {
    const uid = await photographer();
    const auth = cookie(uid);
    expect((await request(main).get(MEDIA).set(auth)).status).toBe(200);
    const created = await uploadWith(main, auth);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    expect((await request(main).get(`${MEDIA}/${id}`).set(auth)).status).toBe(200);
    const patched = await request(main).patch(`${MEDIA}/${id}`).set(auth).send({ revision: created.body.revision, title: "Cookie title" });
    expect(patched.status).toBe(200);
    const version = await request(main)
      .post(`${MEDIA}/${id}/versions?revision=${patched.body.revision}`)
      .set(auth)
      .set("Content-Type", "image/png")
      .set("Idempotency-Key", key())
      .set("X-Rights-Statement", "v1_own")
      .send(freshPng());
    expect(version.status).toBe(201);
    const rights = await request(main)
      .put(`${MEDIA}/${id}/rights`)
      .set(auth)
      .send({
        revision: version.body.revision,
        statement: MEDIA_V2_STATEMENT,
        submission: { fullName: "Pat Plain", title: "Ramp at dusk", credit: "P. Plain" },
      });
    expect(rights.status).toBe(200);
  });

  it("each request of a valid account asks Firebase at most once per minute (cache), and a good cookie is never refused", async () => {
    const uid = newUid("cache");
    for (let i = 0; i < 3; i++) expect((await request(main).get("/v1/me/roles").set(cookie(uid))).status).toBe(200);
    expect(accounts.count(uid)).toBe(1);
  });

  it("one revocation lookup per successful upload: the guard behind the pre-reader is served from the cache", async () => {
    const uid = await photographer("one-lookup");
    const res = await uploadWith(main, cookie(uid));
    expect(res.status).toBe(201);
    expect(accounts.count(uid)).toBe(1);
  });
});

describe("a session cookie is refused everywhere else, with no lookup", () => {
  it.each([
    ["PUT /v1/me", (uid: string) => request(main).put("/v1/me").set(cookie(uid))],
    ["POST /v1/rounds", (uid: string) => request(main).post("/v1/rounds").set(cookie(uid)).send({})],
    ["DELETE /v1/me", (uid: string) => request(main).delete("/v1/me").set(cookie(uid))],
    ["POST /v1/admin/media/:id/publish", (uid: string) => request(main).post(`${MEDIA}/med-1/publish`).set(cookie(uid)).send({})],
    ["POST /v1/admin/media/:id/review", (uid: string) => request(main).post(`${MEDIA}/med-1/review`).set(cookie(uid)).send({})],
    ["POST /v1/admin/media/:id/withdraw", (uid: string) => request(main).post(`${MEDIA}/med-1/withdraw`).set(cookie(uid)).send({})],
    ["GET /v1/admin/role-requests", (uid: string) => request(main).get("/v1/admin/role-requests").set(cookie(uid))],
  ])("%s -> 401 and zero lookups", async (_name, call) => {
    const uid = newUid("deny");
    const res = await call(uid);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(accounts.lookups).toEqual([]);
  });

  it("the xlsx import route: 401, no lookup, no body read", async () => {
    const uid = newUid("xlsx");
    // A declared length far over any import limit and a body that never ends: a 401 (not a 413, not a hang) proves no body was read.
    const status = await rawStatus(
      uid,
      "/v1/admin/content/aircraft-identifier/imports",
      { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      512 * 1024 * 1024,
    );
    expect(status).toBe(401);
    expect(accounts.lookups).toEqual([]);
  });

  it("the other role-protected body readers (coverage, FAQ import) refuse a cookie the same way", async () => {
    const uid = newUid("readers");
    const coverage = await request(main).post("/v1/admin/content/aircraft-identifier/trip-coverage").set(cookie(uid)).send({});
    const faq = await request(main).post("/v1/admin/content/documents/faq/import").set(cookie(uid)).send({});
    expect([coverage.status, faq.status]).toEqual([401, 401]);
    expect(accounts.lookups).toEqual([]);
  });
});

describe("revocation answers", () => {
  it("revoked (auth_time < validSince) -> 401, and the answer is cached", async () => {
    const uid = newUid("revoked");
    accounts.answers.set(uid, { kind: "found", disabled: false, validSince: Math.floor(Date.now() / 1000) + 5 });
    const res = await request(main).get("/v1/me/roles").set(cookie(uid));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect((await request(main).get("/v1/me/roles").set(cookie(uid))).status).toBe(401);
    expect(accounts.count(uid)).toBe(1);
  });

  it("validSince before the cookie's auth_time still passes", async () => {
    const uid = newUid("old-revoke");
    accounts.answers.set(uid, { kind: "found", disabled: false, validSince: Math.floor(Date.now() / 1000) - 3600 });
    expect((await request(main).get("/v1/me/roles").set(cookie(uid))).status).toBe(200);
  });

  it("disabled -> 401", async () => {
    const uid = newUid("disabled");
    accounts.answers.set(uid, { kind: "found", disabled: true, validSince: undefined });
    expect((await request(main).get("/v1/me/roles").set(cookie(uid))).status).toBe(401);
  });

  it("account not found -> 401", async () => {
    const uid = newUid("gone");
    accounts.answers.set(uid, { kind: "not_found" });
    expect((await request(main).get("/v1/me/roles").set(cookie(uid))).status).toBe(401);
  });

  it("lookup unavailable -> 503 auth_unavailable with Retry-After 5, and it is not cached", async () => {
    const uid = newUid("unavailable");
    accounts.answers.set(uid, { kind: "unavailable" });
    const res = await request(main).get("/v1/me/roles").set(cookie(uid));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("auth_unavailable");
    expect(res.headers["retry-after"]).toBe("5");
    accounts.answers.delete(uid);
    expect((await request(main).get("/v1/me/roles").set(cookie(uid))).status).toBe(200);
    expect(accounts.count(uid)).toBe(2);
  });

  it("no Admin credential -> 503 auth_unavailable with Retry-After 60 and no lookup", async () => {
    const uid = newUid("noadmin");
    const res = await request(noAdmin).get("/v1/me/roles").set(cookie(uid));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("auth_unavailable");
    expect(res.headers["retry-after"]).toBe("60");
    expect(accounts.lookups).toEqual([]);
    // ID tokens do not need the credential.
    expect((await request(noAdmin).get("/v1/me/roles").set(idToken(uid))).status).toBe(200);
  });

  it("an unavailable lookup repeated: 503 once, then 429 with no second lookup (the count happens before revocation)", async () => {
    const uid = newUid("flood");
    // "unavailable" is never cached, so a second lookup would happen if the request were not counted first.
    accounts.answers.set(uid, { kind: "unavailable" });
    const first = await request(limited).get("/v1/me/roles").set(cookie(uid));
    expect(first.status).toBe(503);
    const second = await request(limited).get("/v1/me/roles").set(cookie(uid));
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("rate_limited");
    expect(second.headers["retry-after"]).toBeDefined();
    expect(accounts.count(uid)).toBe(1);
  });

  it("an upload with a revoked cookie is 401 before the body is read (an oversize body is not a 413)", async () => {
    const uid = await photographer("revoked-upload");
    accounts.answers.set(uid, { kind: "found", disabled: true, validSince: undefined });
    const status = await rawStatus(uid, MEDIA, { "Content-Type": "image/png", "Idempotency-Key": key(), "X-Rights-Statement": "v1_own" }, 6 * 1024 * 1024);
    expect(status).toBe(401);
  });

  it("an upload by a cookie whose account is not a photographer is 403 (the role check still runs), not stored", async () => {
    const uid = newUid("no-role");
    const res = await uploadWith(main, cookie(uid));
    expect(res.status).toBe(403);
  });

  it("a cookie upload counts once against the rate limit (pre-reader and guard share one count)", async () => {
    const uid = await photographer("count-once");
    // limit 1 per minute: the one request must pass; a second is the 429.
    const first = await uploadWith(limited, cookie(uid));
    expect(first.status).toBe(201);
    expect((await uploadWith(limited, cookie(uid))).status).toBe(429);
  });
});

describe("ID tokens are unchanged", () => {
  it("an ID token works on the same routes with zero revocation lookups", async () => {
    const uid = await photographer("idtoken");
    expect((await request(main).get("/v1/me/roles").set(idToken(uid))).status).toBe(200);
    expect((await request(main).get(MEDIA).set(idToken(uid))).status).toBe(200);
    expect((await uploadWith(main, idToken(uid))).status).toBe(201);
    expect((await request(main).get("/v1/me/progress").set(idToken(uid))).status).toBe(404);
    expect(accounts.lookups).toEqual([]);
  });

  it("ID-token refusals keep their answers: bad token 401 with WWW-Authenticate, no token 401, publish needs admin (403)", async () => {
    const uid = await photographer("idtoken-403");
    const bad = await request(main).get("/v1/me/roles").set("Authorization", "Bearer not.a.token");
    expect(bad.status).toBe(401);
    expect(bad.headers["www-authenticate"]).toBe("Bearer");
    expect((await request(main).get("/v1/me/roles")).status).toBe(401);
    const publish = await request(main).post(`${MEDIA}/med-1/publish`).set(idToken(uid)).send({});
    expect(publish.status).toBe(403);
  });

  it("an ID token in the xlsx reader still goes through the role check (non-admin is 403)", async () => {
    const uid = newUid("idtoken-xlsx");
    const res = await request(main)
      .post("/v1/admin/content/aircraft-identifier/imports")
      .set(idToken(uid))
      .set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .send(Buffer.from("x"));
    expect(res.status).toBe(403);
  });
});

describe("logs", () => {
  it("the request log line carries no bearer value", async () => {
    const uid = newUid("log");
    const bearerValue = emulatorSessionCookie(uid);
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
      const res = await request(main).get("/v1/me/roles").set({ Authorization: `Bearer ${bearerValue}` });
      expect(res.status).toBe(200);
      // The log line is written on "close", which can follow the response by a tick.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.stdout.write = original;
    }
    const all = written.join("");
    expect(all).toContain('"route":"/v1/me/roles"');
    expect(all).not.toContain(bearerValue);
    expect(all).not.toContain(bearerValue.split(".")[1]);
    expect(all.toLowerCase()).not.toContain("bearer ");
  });
});

describe("the allowlist is pinned", () => {
  it("exactly nine handlers carry @SessionCookieAllowed(), none on a class", () => {
    const found: string[] = [];
    for (const wrapper of new DiscoveryService(mainApp.get(ModulesContainer)).getControllers()) {
      const { metatype, instance } = wrapper;
      if (!metatype || !instance) continue;
      expect(Reflect.getMetadata(SESSION_COOKIE_ALLOWED, metatype), `${metatype.name} must not carry the decorator on the class`).toBeUndefined();
      const controllerPath = String(Reflect.getMetadata("path", metatype) ?? "");
      const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (typeof handler !== "function" || name === "constructor") continue;
        if (Reflect.getMetadata(SESSION_COOKIE_ALLOWED, handler) !== true) continue;
        const method = RequestMethod[Reflect.getMetadata("method", handler) as number];
        const handlerPath = String(Reflect.getMetadata("path", handler) ?? "");
        found.push(`${method} /${[controllerPath, handlerPath === "/" ? "" : handlerPath].filter(Boolean).join("/")}`);
      }
    }
    expect(found.sort()).toEqual(
      [
        "GET /v1/me/roles",
        "POST /v1/me/roles/photographer",
        "GET /v1/me/progress",
        "GET /v1/admin/media",
        "GET /v1/admin/media/:mediaId",
        "POST /v1/admin/media",
        "POST /v1/admin/media/:mediaId/versions",
        "PATCH /v1/admin/media/:mediaId",
        "PUT /v1/admin/media/:mediaId/rights",
      ].sort(),
    );
  });
});
