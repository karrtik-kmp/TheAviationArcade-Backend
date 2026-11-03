import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { XLSX_MIME } from "../src/content/xlsx.js";
import type { AccountRole, RoleState } from "../src/db/enums.js";
import { clientSheet } from "./fixtures.js";
import { clearRoles, demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";
import { unfinishedUpload } from "./upload-helpers.js";

// Backend ADR-0002 / plan R-a: privilege comes only from ACTIVE account_roles rows for the verified principal, read on every
// request. The real Nest app against the real test database. Every test uses fresh uids, so no other suite's rows interfere.

const MODULE = "aircraft-identifier-military";
const ME = "/v1/admin/me";
const ITEMS = `/v1/admin/content/${MODULE}/items`;
const IMPORTS = `/v1/admin/content/${MODULE}/imports`;
const DOCUMENTS = "/v1/admin/content/documents";

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;
const seeded: string[] = [];

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
});

afterAll(async () => {
  await clearRoles(sql, ...seeded);
  await app.close();
  await sql.end();
});

/** A fresh demo uid holding `roles` (each with its state), and its bearer header. */
async function caller(
  roles: [AccountRole, RoleState][] = [],
  token: { email?: string | null; emailVerified?: boolean } = {},
): Promise<{ uid: string; principal: string; headers: Record<string, string> }> {
  const uid = `roles-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  seeded.push(principal);
  for (const [role, state] of roles) await seedRole(sql, principal, role, state);
  return { uid, principal, headers: { Authorization: `Bearer ${emulatorToken(uid, undefined, undefined, token)}` } };
}

const ADMIN_GETS = [ME, ITEMS, DOCUMENTS];
const adminRoutes = (h: Record<string, string>) => Promise.all(ADMIN_GETS.map(async (path) => ({ path, res: await request(server).get(path).set(h) })));

async function expectForbiddenEverywhere(h: Record<string, string>, label: string): Promise<void> {
  for (const { path, res } of await adminRoutes(h)) {
    expect(res.status, `${label} ${path}`).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  }
}

describe("roles guard: only an ACTIVE database role with a verified email grants admin", () => {
  it("an active verified admin passes every admin route, and GET /v1/admin/me lists the active roles", async () => {
    const { principal, headers } = await caller([["admin", "active"]]);
    for (const { path, res } of await adminRoutes(headers)) expect(res.status, path).toBe(200);
    const me = await request(server).get(ME).set(headers);
    expect(me.body).toEqual({ principal, staff: true, roles: ["admin"] });
  });

  it("/v1/admin/me lists every ACTIVE role in a fixed order, and none that is pending, rejected or revoked", async () => {
    const all = await caller([["admin", "active"], ["player", "active"], ["photographer", "active"]]);
    expect((await request(server).get(ME).set(all.headers)).body.roles).toEqual(["player", "photographer", "admin"]);
    const mixed = await caller([["admin", "active"], ["photographer", "pending"], ["player", "revoked"]]);
    expect((await request(server).get(ME).set(mixed.headers)).body.roles).toEqual(["admin"]);
  });

  it("a verified email with no role row is 403 (401 still comes first without a token)", async () => {
    const { headers } = await caller();
    await expectForbiddenEverywhere(headers, "no role");
    expect((await request(server).get(ME)).status).toBe(401);
    expect((await request(server).get(ME).set("Authorization", "Bearer junk")).status).toBe(401);
  });

  it("an active admin with email_verified false, or with no email claim, is 403", async () => {
    await expectForbiddenEverywhere((await caller([["admin", "active"]], { emailVerified: false })).headers, "unverified");
    await expectForbiddenEverywhere((await caller([["admin", "active"]], { email: null })).headers, "no email");
  });

  it("a rejected or revoked admin row, or a pending photographer request, is 403", async () => {
    for (const state of ["rejected", "revoked"] as const) {
      await expectForbiddenEverywhere((await caller([["admin", state]])).headers, state);
    }
    await expectForbiddenEverywhere((await caller([["photographer", "pending"]])).headers, "pending photographer");
  });

  it("revoking the role makes the very next request 403 (no caching); re-activating it lets the caller back in", async () => {
    const { principal, headers } = await caller([["admin", "active"]]);
    expect((await request(server).get(ME).set(headers)).status).toBe(200);
    await seedRole(sql, principal, "admin", "revoked");
    expect((await request(server).get(ME).set(headers)).status).toBe(403);
    expect((await request(server).get(ITEMS).set(headers)).status).toBe(403);
    await seedRole(sql, principal, "admin", "active");
    expect((await request(server).get(ME).set(headers)).status).toBe(200);
    await clearRoles(sql, principal);
    expect((await request(server).get(ME).set(headers)).status).toBe(403);
  });

  it("an active photographer or player is 403 on admin-only routes, including the pre-auth upload reader", async () => {
    const photographer = await caller([["photographer", "active"], ["player", "active"]]);
    await expectForbiddenEverywhere(photographer.headers, "photographer");
    const before = (await sql.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM content_imports")).rows[0]?.n;
    const upload = await request(server).post(`${IMPORTS}?dryRun=true`).set(photographer.headers).set("Content-Type", XLSX_MIME).send(await clientSheet(2));
    expect(upload.status).toBe(403);
    expect(upload.body.error.code).toBe("forbidden");
    expect((await sql.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM content_imports")).rows[0]?.n).toBe(before);
    // Refused while the 50 MB body is still unsent: the pre-reader's own role check, not the guard after the body.
    expect(await unfinishedUpload(server, photographer.headers)).toBe(403);
    await expectForbiddenEverywhere((await caller([["player", "active"]])).headers, "player");
  });

  it("the pre-auth upload reader lets an active admin through and refuses a revoked one", async () => {
    const { principal, headers } = await caller([["admin", "active"]]);
    const send = () => request(server).post(`${IMPORTS}?dryRun=true`).set(headers).set("Content-Type", XLSX_MIME);
    expect((await send().send(await clientSheet(2))).status).toBe(200);
    await seedRole(sql, principal, "admin", "revoked");
    expect((await send().send(await clientSheet(2))).status).toBe(403);
    expect(await unfinishedUpload(server, headers)).toBe(403);
  });

  it("a role row for the same uid under another Firebase project grants nothing", async () => {
    const uid = `roles-${randomUUID()}`;
    const foreign = `firebase:demo-other-project:${uid}`;
    seeded.push(foreign);
    await seedRole(sql, foreign, "admin", "active");
    await expectForbiddenEverywhere({ Authorization: `Bearer ${emulatorToken(uid)}` }, "foreign row");
    // And that project's own token is not accepted at all.
    expect((await request(server).get(ME).set("Authorization", `Bearer ${emulatorToken(uid, "demo-other-project")}`)).status).toBe(401);
  });

  it("a client-named role, header, query or email grants nothing", async () => {
    const { headers } = await caller([], { email: "admin@sites.test" });
    const res = await request(server).get(ME).set(headers).set("X-Role", "admin").query({ role: "admin", roles: "admin" });
    expect(res.status).toBe(403);
  });
});

describe("account_roles constraints", () => {
  const principal = demoPrincipal(`roles-${randomUUID()}`);
  beforeAll(() => seeded.push(principal));

  it("refuses an unknown role or state, a second row for the same (principal, role), and a note over 500 characters", async () => {
    const insert = (role: string, state: string, note: string | null = null) =>
      sql.query(
        `INSERT INTO account_roles (principal, role, state, requested_at, decided_at, decided_by, note)
         VALUES ($1, $2, $3, now(), CASE WHEN $3 = 'pending' THEN NULL ELSE now() END, CASE WHEN $3 = 'pending' THEN NULL ELSE 'test:seed' END, $4)`,
        [principal, role, state, note],
      );
    await expect(insert("staff", "active")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("photographer", "approved")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("photographer", "pending", "x".repeat(501))).rejects.toMatchObject({ code: "23514" });
    await insert("photographer", "pending", "x".repeat(500));
    await expect(insert("photographer", "active")).rejects.toMatchObject({ code: "23505" });
    const row = (await sql.query("SELECT state, decided_at, decided_by, requested_at, revision FROM account_roles WHERE principal = $1", [principal])).rows[0];
    expect(row).toMatchObject({ state: "pending", decided_at: null, decided_by: null, revision: 1 });
    expect(row.requested_at).toBeInstanceOf(Date);
  });

  it("ties the decision fields to the state, lets only a photographer request be pending, and requires revision >= 1", async () => {
    const p = demoPrincipal(`roles-${randomUUID()}`);
    seeded.push(p);
    const insert = (role: string, state: string, decidedAt: string | null, decidedBy: string | null, revision = 1) =>
      sql.query(
        `INSERT INTO account_roles (principal, role, state, requested_at, decided_at, decided_by, revision)
         VALUES ($1, $2, $3, now(), $4::timestamptz, $5, $6)`,
        [p, role, state, decidedAt, decidedBy, revision],
      );
    const now = new Date().toISOString();
    const refused = (constraint: string) => ({ code: "23514", constraint });
    await expect(insert("admin", "pending", null, null)).rejects.toMatchObject(refused("account_roles_pending_role_check"));
    await expect(insert("player", "pending", null, null)).rejects.toMatchObject(refused("account_roles_pending_role_check"));
    await expect(insert("admin", "active", null, null)).rejects.toMatchObject(refused("account_roles_decided_check"));
    await expect(insert("admin", "active", now, null)).rejects.toMatchObject(refused("account_roles_decided_check"));
    await expect(insert("admin", "revoked", null, "test:seed")).rejects.toMatchObject(refused("account_roles_decided_check"));
    await expect(insert("photographer", "pending", now, null)).rejects.toMatchObject(refused("account_roles_decided_check"));
    await expect(insert("photographer", "pending", null, "test:seed")).rejects.toMatchObject(refused("account_roles_decided_check"));
    await expect(insert("admin", "active", now, "test:seed", 0)).rejects.toMatchObject(refused("account_roles_revision_check"));
    await insert("admin", "active", now, "test:seed");
    await insert("photographer", "pending", null, null);
  });

  it("the audit log accepts every role action", async () => {
    const actions = ["role_request", "role_approve", "role_reject", "role_grant", "role_revoke"];
    const client = await sql.connect();
    try {
      await client.query("BEGIN");
      for (const action of actions) {
        await client.query("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ($1, $2, $3, '{}'::jsonb, now())", [principal, action, principal]);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("the upload pre-reader counts against the rate limit", () => {
  let limited: NestExpressApplication;
  let limitedServer: ReturnType<NestExpressApplication["getHttpServer"]>;
  const saved = process.env.RATE_LIMIT_AUTH_PER_MIN;

  beforeAll(async () => {
    process.env.RATE_LIMIT_AUTH_PER_MIN = "3";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    limited = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApp(limited);
    await limited.listen(0, "127.0.0.1");
    limitedServer = limited.getHttpServer();
  });

  afterAll(async () => {
    await limited.close();
    if (saved === undefined) delete process.env.RATE_LIMIT_AUTH_PER_MIN;
    else process.env.RATE_LIMIT_AUTH_PER_MIN = saved;
  });

  it("a caller without the role that loops the import path is refused 403 until the limit, then 429 rate_limited with Retry-After", async () => {
    const { headers } = await caller([["photographer", "active"]]);
    const post = () => request(limitedServer).post(IMPORTS).set(headers).set("Content-Type", XLSX_MIME).send(Buffer.alloc(8));
    for (let i = 0; i < 3; i += 1) expect((await post()).status).toBe(403);
    const refused = await post();
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe("rate_limited");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("a request counts once overall: an admin gets exactly the limit of uploads, whether they stop at the pre-reader or reach the guard", async () => {
    const { headers } = await caller([["admin", "active"]]);
    const upload = async () => (await request(limitedServer).post(`${IMPORTS}?dryRun=true`).set(headers).set("Content-Type", XLSX_MIME).send(await clientSheet(2))).status;
    for (let i = 0; i < 3; i += 1) expect(await upload()).toBe(200);
    expect(await upload()).toBe(429);
  });
});
