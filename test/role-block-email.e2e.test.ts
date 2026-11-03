import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Ajv2020 } from "ajv/dist/2020.js";
import pg from "pg";
import request from "supertest";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import type { AccountRole, RoleState } from "../src/db/enums.js";
import { clearRoles, demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";
import { unfinishedUpload } from "./upload-helpers.js";

// Plan R-d: the photographer `blocked` state, the typed admin email and its edit, the cleared emails on account deletion.
// Every test uses fresh uids; the e2e database is shared, so nothing here depends on which other admins exist.

const spec: any = parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ $id: "spec", components: spec.components });
const check = (schema: string, value: unknown) => {
  const validate = ajv.compile({ $ref: `spec#/components/schemas/${schema}` });
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
};

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
  await sql.query("DELETE FROM admin_audit WHERE target = ANY($1::text[]) OR actor = ANY($1::text[])", [seeded]);
  await clearRoles(sql, ...seeded);
  await sql.query("DELETE FROM players WHERE id = ANY($1::text[])", [seeded]);
  await app.close();
  await sql.end();
});

type Who = { uid: string; principal: string; headers: Record<string, string> };

async function who(roles: [AccountRole, RoleState][] = [], token: { email?: string | null; emailVerified?: boolean } = {}): Promise<Who> {
  const uid = `rd-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  seeded.push(principal);
  const headers = { Authorization: `Bearer ${emulatorToken(uid, undefined, undefined, token)}` };
  for (const [role, state] of roles) await seedRole(sql, principal, role, state);
  return { uid, principal, headers };
}

const admin = () => who([["admin", "active"]]);
const enc = (principal: string) => encodeURIComponent(principal);
const rolePath = (target: string, tail: string) => `/v1/admin/accounts/${enc(target)}/roles/${tail}`;
const post = (w: Who, path: string, body?: unknown) => {
  const r = request(server).post(path).set(w.headers);
  return body === undefined ? r : r.send(body as object);
};
const put = (w: Who, path: string, body?: unknown) => request(server).put(path).set(w.headers).send(body as object);

async function row(principal: string, role: string) {
  return (await sql.query("SELECT * FROM account_roles WHERE principal = $1 AND role = $2", [principal, role])).rows[0] as any;
}
async function auditRows(target: string, action?: string) {
  return (await sql.query(`SELECT * FROM admin_audit WHERE target = $1 ${action ? "AND action = $2" : ""} ORDER BY id`, action ? [target, action] : [target]))
    .rows as any[];
}
/** supertest requests are lazy: this sends one now. */
const fire = <T extends PromiseLike<unknown>>(req: T): Promise<Awaited<T>> => Promise.resolve(req) as Promise<Awaited<T>>;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Waits until `n` backends in this database are queued on the advisory lock (so the requests really are in line, in order). */
async function waitQueued(n: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await sql.query(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    );
    if (rows[0].n >= n) return;
    await sleep(25);
  }
  throw new Error(`Fewer than ${n} requests reached the role lock.`);
}

/**
 * Holds the role lock while `fn` fires requests (they queue behind it, in order), then commits and returns what `fn` returned
 * once awaited (`fn` returns a function so its promise is not awaited before the commit). `fn` may also change rows through `holder` before the lock is released.
 */
async function withLockHeld<T>(fn: (holder: pg.Client) => Promise<() => Promise<T>>): Promise<T> {
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('account-roles', 0))");
    const result = await fn(holder);
    await holder.query("COMMIT");
    return await result();
  } finally {
    await holder.end();
  }
}

const block = (boss: Who, target: string, revision: number, note?: string) => post(boss, rolePath(target, "photographer/block"), { revision, ...(note ? { note } : {}) });
const unblock = (boss: Who, target: string, revision: number) => post(boss, rolePath(target, "photographer/unblock"), { revision });

describe("block: POST .../roles/photographer/block", () => {
  it("blocks from each of pending, active, rejected and revoked: revision + 1, decided_by the admin, one role_block audit row", async () => {
    const boss = await admin();
    for (const from of ["pending", "active", "rejected", "revoked"] as const) {
      const w = await who([["photographer", from]]);
      const res = await block(boss, w.principal, 1, `why ${from}`);
      expect(res.status, `${from}: ${JSON.stringify(res.body)}`).toBe(200);
      check("AdminRoleEnvelope", res.body);
      expect(res.body.role).toMatchObject({ principal: w.principal, role: "photographer", state: "blocked", revision: 2, decidedBy: boss.principal, note: `why ${from}` });
      expect(await row(w.principal, "photographer")).toMatchObject({ state: "blocked", revision: 2, decided_by: boss.principal });
      const audits = await auditRows(w.principal, "role_block");
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actor: boss.principal, target: w.principal });
      expect(audits[0].detail).toEqual({ role: "photographer", from: { state: from, revision: 1 }, to: { state: "blocked", revision: 2 }, note: `why ${from}` });
    }
  });

  it("is 409 for a blocked row, a stale revision, and an active admin; 404 with no photographer row; nothing is written", async () => {
    const boss = await admin();
    const w = await who([["photographer", "pending"]]);
    expect((await block(boss, w.principal, 1)).status).toBe(200);
    const again = await block(boss, w.principal, 2);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("version_conflict");
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "blocked", revision: 2 });
    expect(await auditRows(w.principal, "role_block")).toHaveLength(1);

    const stale = await who([["photographer", "active"]]);
    expect((await block(boss, stale.principal, 7)).status).toBe(409);
    expect(await row(stale.principal, "photographer")).toMatchObject({ state: "active", revision: 1 });

    const none = await who();
    const missing = await block(boss, none.principal, 1);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");

    // Block and admin stay apart: an active admin cannot be blocked, not even by themselves; a revoked admin can be.
    const both = await who([["admin", "active"], ["photographer", "active"]]);
    for (const actor of [boss, both]) {
      const refused = await block(actor, both.principal, 1);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("version_conflict");
      expect(refused.body.error.message).toContain("admin");
    }
    expect(await row(both.principal, "photographer")).toMatchObject({ state: "active", revision: 1 });
    expect(await auditRows(both.principal, "role_block")).toHaveLength(0);
    await sql.query("UPDATE account_roles SET state = 'revoked' WHERE principal = $1 AND role = 'admin'", [both.principal]);
    expect((await block(boss, both.principal, 1)).status).toBe(200);
  });

  it("revoke, approve and reject of a blocked row are 409", async () => {
    const boss = await admin();
    const w = await who([["photographer", "blocked"]]);
    for (const tail of ["photographer/approve", "photographer/reject", "photographer/revoke"]) {
      const res = await post(boss, rolePath(w.principal, tail), { revision: 1 });
      expect(res.status, tail).toBe(409);
      expect(res.body.error.code).toBe("version_conflict");
    }
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "blocked", revision: 1 });
  });

  it("block, unblock and email bodies carrying a role, a state or any extra field are 400; the query too", async () => {
    const boss = await admin();
    const w = await who([["photographer", "pending"], ["admin", "revoked"]]);
    for (const body of [{ revision: 1, role: "admin" }, { revision: 1, state: "blocked" }, { note: "x" }, {}, { revision: "1" }]) {
      for (const tail of ["photographer/block", "photographer/unblock"]) {
        const res = await post(boss, rolePath(w.principal, tail), body);
        expect(res.status, `${tail} ${JSON.stringify(body)}`).toBe(400);
        expect(res.body.error.code).toBe("invalid_request");
      }
    }
    for (const body of [{ revision: 1, email: null, role: "admin" }, { revision: 1, email: null, state: "active" }, { email: null }, { revision: 1 }, { revision: 1, email: 5 }]) {
      expect((await put(boss, rolePath(w.principal, "admin/email"), body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await post(boss, `${rolePath(w.principal, "photographer/block")}?role=admin`, { revision: 1 })).status).toBe(400);
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "pending", revision: 1 });
    expect(await row(w.principal, "admin")).toMatchObject({ state: "revoked", revision: 1, grant_email: null });
  });

  it("a note with a control character is 400 on block, unblock, approve and grant, and writes nothing", async () => {
    const boss = await admin();
    const w = await who([["photographer", "pending"]]);
    for (const note of ["bad\u0000note", "tab\tnote", "line\nbreak"]) {
      for (const tail of ["photographer/block", "photographer/unblock", "photographer/approve"]) {
        const res = await post(boss, rolePath(w.principal, tail), { revision: 1, note });
        expect(res.status, `${tail} ${JSON.stringify(note)}`).toBe(400);
        expect(res.body.error.code).toBe("invalid_request");
      }
      expect((await post(boss, rolePath(w.principal, "admin/grant"), { note })).status).toBe(400);
    }
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "pending", revision: 1 });
    expect(await auditRows(w.principal)).toHaveLength(0);
  });

  it("only an admin can block or unblock (a photographer and an anonymous caller cannot)", async () => {
    const photographer = await who([["photographer", "active"]]);
    const target = await who([["photographer", "pending"]]);
    expect((await block(photographer, target.principal, 1)).status).toBe(403);
    expect((await request(server).post(rolePath(target.principal, "photographer/block")).send({ revision: 1 })).status).toBe(401);
    expect(await row(target.principal, "photographer")).toMatchObject({ state: "pending" });
  });
});

describe("unblock: POST .../roles/photographer/unblock", () => {
  it("blocked becomes revoked at revision + 1 with a role_unblock audit row; anything else is 409; no row is 404", async () => {
    const boss = await admin();
    const w = await who([["photographer", "blocked"]]);
    const res = await unblock(boss, w.principal, 1);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.role).toMatchObject({ state: "revoked", revision: 2, decidedBy: boss.principal });
    const audits = await auditRows(w.principal, "role_unblock");
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toEqual({ role: "photographer", from: { state: "blocked", revision: 1 }, to: { state: "revoked", revision: 2 }, note: null });

    expect((await unblock(boss, w.principal, 2)).status).toBe(409); // not blocked any more
    const pending = await who([["photographer", "pending"]]);
    expect((await unblock(boss, pending.principal, 1)).status).toBe(409);
    expect((await unblock(boss, (await who([["photographer", "blocked"]])).principal, 9)).status).toBe(409); // stale revision
    expect((await unblock(boss, (await who()).principal, 1)).status).toBe(404);
  });

  it("end to end: block, refused request, unblock, request again, approve; GET /v1/me/roles shows blocked", async () => {
    const boss = await admin();
    const w = await who([], { email: "Flyer@Example.test" });
    expect((await post(w, "/v1/me/roles/photographer")).status).toBe(201);
    expect((await block(boss, w.principal, 1)).status).toBe(200);

    const mine = await request(server).get("/v1/me/roles").set(w.headers);
    check("OwnRolesEnvelope", mine.body);
    expect(mine.body.roles.find((r: any) => r.role === "photographer")).toMatchObject({ state: "blocked", revision: 2 });

    const refused = await post(w, "/v1/me/roles/photographer");
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("forbidden");

    expect((await unblock(boss, w.principal, 2)).status).toBe(200);
    const again = await post(w, "/v1/me/roles/photographer");
    expect(again.status).toBe(201);
    expect(again.body.role).toMatchObject({ state: "pending", revision: 4 });
    const approved = await post(boss, rolePath(w.principal, "photographer/approve"), { revision: 4 });
    expect(approved.status).toBe(200);
    expect(approved.body.role).toMatchObject({ state: "active", revision: 5 });
  });
});

describe("a blocked account", () => {
  it("a request while blocked is 403 and changes nothing: request_email, revision and the audit count stay", async () => {
    const w = await who([["photographer", "blocked"]], { email: "new@example.test" });
    await sql.query("UPDATE account_roles SET request_email = 'old@example.test' WHERE principal = $1 AND role = 'photographer'", [w.principal]);
    const audits = (await auditRows(w.principal)).length;
    const res = await post(w, "/v1/me/roles/photographer");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "blocked", revision: 1, request_email: "old@example.test" });
    expect(await auditRows(w.principal)).toHaveLength(audits);
  });

  it("a block landing between the request's unlocked read and the lock still refuses it (403, nothing written)", async () => {
    const w = await who([["photographer", "revoked"]], { email: "race@example.test" });
    const res = await withLockHeld(async (holder) => {
      const pending = fire(post(w, "/v1/me/roles/photographer"));
      await waitQueued(1); // the request has read `revoked` and waits on the lock
      await holder.query(
        "UPDATE account_roles SET state = 'blocked', revision = revision + 1, decided_at = now(), decided_by = 'test:holder' WHERE principal = $1 AND role = 'photographer'",
        [w.principal],
      );
      return () => pending;
    });
    expect(res.status).toBe(403);
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "blocked", revision: 2, request_email: null });
    expect(await auditRows(w.principal, "role_request")).toHaveLength(0);
  });

  it("a blocked photographer is refused on POST /v1/admin/media (403) before the body is read", async () => {
    const w = await who([["photographer", "blocked"]]);
    expect(await unfinishedUpload(server, { ...w.headers, "Idempotency-Key": randomUUID() }, "/v1/admin/media", "image/png")).toBe(403);
    const active = await who([["photographer", "active"]]);
    const ok = await request(server)
      .post("/v1/admin/media")
      .set(active.headers)
      .set("Content-Type", "image/png")
      .set("Idempotency-Key", randomUUID())
      .send(Buffer.from("not an image"));
    expect(ok.status).not.toBe(403); // an active photographer passes the guard (the body is then refused on its merits)
  });

  it("admin cannot be granted to a blocked account: 409, no admin row, no audit row; after an unblock it can", async () => {
    const boss = await admin();
    const w = await who([["photographer", "blocked"]]);
    const res = await post(boss, rolePath(w.principal, "admin/grant"), { email: "x@example.test" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("version_conflict");
    expect(await row(w.principal, "admin")).toBeUndefined();
    expect(await auditRows(w.principal, "role_grant")).toHaveLength(0);
    expect((await unblock(boss, w.principal, 1)).status).toBe(200);
    expect((await post(boss, rolePath(w.principal, "admin/grant"), {})).status).toBe(200);
  });

  it("the queue lists ?state=blocked photographer rows only, oldest request first, and pages with a cursor", async () => {
    const boss = await admin();
    const mine: Who[] = [];
    for (let i = 0; i < 3; i += 1) {
      mine.push(await who([["photographer", "blocked"]]));
      await sleep(5);
    }
    const seen: any[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200; page += 1) {
      const res: any = await request(server).get(`/v1/admin/role-requests?state=blocked&limit=2${cursor ? `&cursor=${cursor}` : ""}`).set(boss.headers);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      check("RoleRequestList", res.body);
      seen.push(...res.body.requests);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen.every((r) => r.role === "photographer" && r.state === "blocked")).toBe(true);
    const order = mine.map((w) => seen.findIndex((r) => r.principal === w.principal));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("races", () => {
  it("block vs request on a revoked row, both orders: the lock serialises them and the loser changes nothing", async () => {
    const boss = await admin();
    // Block first: the request then finds `blocked`.
    const a = await who([["photographer", "revoked"]], { email: "a@example.test" });
    const blockFirst = await withLockHeld(async () => {
      const blocking = fire(block(boss, a.principal, 1));
      await waitQueued(1);
      const requesting = fire(post(a, "/v1/me/roles/photographer"));
      await waitQueued(2);
      return () => Promise.all([blocking, requesting]);
    });
    expect(blockFirst.map((r) => r.status)).toEqual([200, 403]);
    expect(await row(a.principal, "photographer")).toMatchObject({ state: "blocked", revision: 2 });

    // Request first: the block (at the revision it read) is then stale.
    const b = await who([["photographer", "revoked"]], { email: "b@example.test" });
    const requestFirst = await withLockHeld(async () => {
      const requesting = fire(post(b, "/v1/me/roles/photographer"));
      await waitQueued(1);
      const blocking = fire(block(boss, b.principal, 1));
      await waitQueued(2);
      return () => Promise.all([requesting, blocking]);
    });
    expect(requestFirst.map((r) => r.status)).toEqual([201, 409]);
    expect(await row(b.principal, "photographer")).toMatchObject({ state: "pending", revision: 2 });
  });

  it("block vs approve at one revision: exactly one wins, the other is 409", async () => {
    const boss = await admin();
    const second = await admin();
    const w = await who([["photographer", "pending"]]);
    const [x, y] = await Promise.all([block(boss, w.principal, 1), post(second, rolePath(w.principal, "photographer/approve"), { revision: 1 })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const stored = await row(w.principal, "photographer");
    expect(stored.revision).toBe(2);
    expect(["blocked", "active"]).toContain(stored.state);
    expect((await auditRows(w.principal)).filter((r) => r.action === "role_block" || r.action === "role_approve")).toHaveLength(1);
  });

  it("two admins racing to block, and racing to unblock, the same row at one revision: one 200, one 409", async () => {
    const one = await admin();
    const two = await admin();
    const w = await who([["photographer", "active"]]);
    const [x, y] = await Promise.all([block(one, w.principal, 1), block(two, w.principal, 1)]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(await auditRows(w.principal, "role_block")).toHaveLength(1);
    const [p, q] = await Promise.all([unblock(one, w.principal, 2), unblock(two, w.principal, 2)]);
    expect([p.status, q.status].sort()).toEqual([200, 409]);
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "revoked", revision: 3 });
    expect(await auditRows(w.principal, "role_unblock")).toHaveLength(1);
  });

  it("an admin revoked while a block waits for the lock cannot commit it: 403, nothing written", async () => {
    const a = await admin();
    const w = await who([["photographer", "pending"]]);
    const res = await withLockHeld(async (holder) => {
      const pending = fire(block(a, w.principal, 1));
      await waitQueued(1);
      await holder.query("UPDATE account_roles SET state = 'revoked' WHERE principal = $1 AND role = 'admin'", [a.principal]);
      return () => pending;
    });
    expect(res.status).toBe(403);
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "pending", revision: 1 });
    expect(await auditRows(w.principal, "role_block")).toHaveLength(0);
  });
});

describe("typed admin email: grant", () => {
  it("stores a trimmed, lowercased email; the views show grantEmail, email and emailSource typed", async () => {
    const boss = await admin();
    const t = await who();
    const res = await post(boss, rolePath(t.principal, "admin/grant"), { email: "  New.Admin@Example.TEST ", note: "welcome" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    check("AdminRoleEnvelope", res.body);
    expect(res.body.role).toMatchObject({ role: "admin", state: "active", requestEmail: null, grantEmail: "new.admin@example.test", email: "new.admin@example.test", emailSource: "typed" });
    expect(await row(t.principal, "admin")).toMatchObject({ grant_email: "new.admin@example.test", request_email: null });
    const queue = await request(server).get("/v1/admin/role-requests?state=active&limit=100").set(boss.headers);
    check("RoleRequestList", queue.body);
  });

  it("without an email the fields are null; a photographer row shows emailSource verified_at_request", async () => {
    const boss = await admin();
    const t = await who();
    const res = await post(boss, rolePath(t.principal, "admin/grant"), {});
    expect(res.body.role).toMatchObject({ grantEmail: null, email: null, emailSource: null });
    const p = await who([], { email: "Photo@Example.test" });
    await post(p, "/v1/me/roles/photographer");
    const approved = await post(boss, rolePath(p.principal, "photographer/approve"), { revision: 1 });
    expect(approved.body.role).toMatchObject({ requestEmail: "Photo@Example.test", grantEmail: null, email: "Photo@Example.test", emailSource: "verified_at_request" });
  });

  it("an invalid email is 400 and nothing is written: non-string, too long, control characters, spaces inside, no or two @", async () => {
    const boss = await admin();
    const t = await who();
    const bad: unknown[] = [
      42,
      null,
      "",
      "ab",
      `${"x".repeat(320)}@a.test`,
      "x".repeat(5000),
      "a@b\u0000.test",
      "a@b\n.test",
      "a b@example.test",
      "plainaddress",
      "a@@b.test",
      "a@b@c.test",
      "@b.test",
      "a@",
    ];
    for (const email of bad) {
      const res = await post(boss, rolePath(t.principal, "admin/grant"), { email });
      expect(res.status, JSON.stringify(email)?.slice(0, 60)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    expect(await row(t.principal, "admin")).toBeUndefined();
    expect(await auditRows(t.principal)).toHaveLength(0);
    // The longest accepted address (320 characters) is fine.
    const longest = `${"x".repeat(64)}@${"y".repeat(255)}`;
    expect(longest).toHaveLength(320);
    expect((await post(boss, rolePath(t.principal, "admin/grant"), { email: longest })).status).toBe(200);
  });

  it("a re-grant from revoked replaces the email when one is given and keeps it otherwise; after DELETE /v1/me it stays null", async () => {
    const boss = await admin();
    const t = await who();
    expect((await post(boss, rolePath(t.principal, "admin/grant"), { email: "one@example.test" })).status).toBe(200);
    expect((await post(boss, rolePath(t.principal, "admin/revoke"), { revision: 1 })).status).toBe(200);
    const kept = await post(boss, rolePath(t.principal, "admin/grant"), {});
    expect(kept.body.role).toMatchObject({ state: "active", revision: 3, grantEmail: "one@example.test" });
    expect((await post(boss, rolePath(t.principal, "admin/revoke"), { revision: 3 })).status).toBe(200);
    const replaced = await post(boss, rolePath(t.principal, "admin/grant"), { email: "Two@Example.test" });
    expect(replaced.body.role).toMatchObject({ revision: 5, grantEmail: "two@example.test" });

    expect((await post(boss, rolePath(t.principal, "admin/revoke"), { revision: 5 })).status).toBe(200);
    expect((await request(server).delete("/v1/me").set(t.headers)).status).toBe(204);
    expect((await row(t.principal, "admin")).grant_email).toBeNull();
    const regrant = await post(boss, rolePath(t.principal, "admin/grant"), {});
    expect(regrant.body.role).toMatchObject({ state: "active", grantEmail: null });
  });
});

describe("typed admin email: PUT .../roles/admin/email", () => {
  it("corrects the email, bumps the revision, audits emailChanged without the value; an unchanged value is a 200 no-op", async () => {
    const boss = await admin();
    const t = await who();
    await post(boss, rolePath(t.principal, "admin/grant"), { email: "typo@example.test" });
    const res = await put(boss, rolePath(t.principal, "admin/email"), { revision: 1, email: " Fixed@Example.TEST" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    check("AdminRoleEnvelope", res.body);
    expect(res.body.role).toMatchObject({ state: "active", revision: 2, grantEmail: "fixed@example.test", emailSource: "typed" });
    const audits = await auditRows(t.principal, "role_email_edit");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: boss.principal, target: t.principal });
    expect(audits[0].detail).toEqual({ role: "admin", from: { state: "active", revision: 1 }, to: { state: "active", revision: 2 }, emailChanged: true });

    const same = await put(boss, rolePath(t.principal, "admin/email"), { revision: 2, email: "fixed@example.test" });
    expect(same.status).toBe(200);
    expect(same.body.role).toMatchObject({ revision: 2, grantEmail: "fixed@example.test" });
    expect(await auditRows(t.principal, "role_email_edit")).toHaveLength(1);
    expect(await row(t.principal, "admin")).toMatchObject({ revision: 2 });
  });

  it("is fenced by revision (409), clears with null, works on a revoked admin, is 404 without an admin row, 400 for a bad email", async () => {
    const boss = await admin();
    const t = await who();
    await post(boss, rolePath(t.principal, "admin/grant"), { email: "keep@example.test" });
    const stale = await put(boss, rolePath(t.principal, "admin/email"), { revision: 5, email: "other@example.test" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect((await row(t.principal, "admin")).grant_email).toBe("keep@example.test");

    expect((await put(boss, rolePath(t.principal, "admin/email"), { revision: 1, email: "no spaces@example.test" })).status).toBe(400);
    expect((await put(boss, rolePath(t.principal, "admin/email"), { revision: 1, email: "x".repeat(321) })).status).toBe(400);

    const cleared = await put(boss, rolePath(t.principal, "admin/email"), { revision: 1, email: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.role).toMatchObject({ revision: 2, grantEmail: null, email: null, emailSource: null });

    await post(boss, rolePath(t.principal, "admin/revoke"), { revision: 2 });
    const onRevoked = await put(boss, rolePath(t.principal, "admin/email"), { revision: 3, email: "back@example.test" });
    expect(onRevoked.status).toBe(200);
    expect(onRevoked.body.role).toMatchObject({ state: "revoked", revision: 4, grantEmail: "back@example.test" });

    const none = await who([["photographer", "active"]]);
    expect((await put(boss, rolePath(none.principal, "admin/email"), { revision: 1, email: "a@b.test" })).status).toBe(404);
  });

  it("is admin only and re-checks the acting admin under the lock", async () => {
    const boss = await admin();
    const t = await who();
    await post(boss, rolePath(t.principal, "admin/grant"), { email: "keep@example.test" });
    const photographer = await who([["photographer", "active"]]);
    expect((await put(photographer, rolePath(t.principal, "admin/email"), { revision: 1, email: "x@y.test" })).status).toBe(403);
    expect((await request(server).put(rolePath(t.principal, "admin/email")).send({ revision: 1, email: null })).status).toBe(401);

    const a = await admin();
    const res = await withLockHeld(async (holder) => {
      const pending = fire(put(a, rolePath(t.principal, "admin/email"), { revision: 1, email: "late@example.test" }));
      await waitQueued(1);
      await holder.query("UPDATE account_roles SET state = 'revoked' WHERE principal = $1 AND role = 'admin'", [a.principal]);
      return () => pending;
    });
    expect(res.status).toBe(403);
    expect((await row(t.principal, "admin")).grant_email).toBe("keep@example.test");
  });

  it("no audit row ever carries an email: grant, edit, request, block and unblock rows of these accounts", async () => {
    const boss = await admin();
    const t = await who([], { email: "Token.Email@Example.test" });
    await post(boss, rolePath(t.principal, "admin/grant"), { email: "typed.one@example.test", note: "n" });
    await put(boss, rolePath(t.principal, "admin/email"), { revision: 1, email: "typed.two@example.test" });
    await put(boss, rolePath(t.principal, "admin/email"), { revision: 2, email: null });
    await post(boss, rolePath(t.principal, "admin/revoke"), { revision: 3 }); // an active admin cannot be blocked
    await post(t, "/v1/me/roles/photographer");
    await block(boss, t.principal, 1, "note");
    await unblock(boss, t.principal, 2);
    const all = await auditRows(t.principal);
    expect(all.map((r) => r.action).sort()).toEqual(["role_block", "role_email_edit", "role_email_edit", "role_grant", "role_request", "role_revoke", "role_unblock"]);
    for (const r of all) {
      const text = JSON.stringify(r).toLowerCase();
      expect(text, r.action).not.toContain("example.test");
      expect(`${r.actor}${r.target}`).not.toContain("@");
    }
  });
});

describe("DELETE /v1/me clears both emails", () => {
  it("clears request_email and grant_email on every role row, keeping the rows, revisions and audit rows", async () => {
    const boss = await admin();
    const t = await who([], { email: "both@example.test" });
    await request(server).put("/v1/me").set(t.headers);
    await post(t, "/v1/me/roles/photographer");
    await post(boss, rolePath(t.principal, "admin/grant"), { email: "typed@example.test" });
    expect(await row(t.principal, "photographer")).toMatchObject({ request_email: "both@example.test" });
    expect(await row(t.principal, "admin")).toMatchObject({ grant_email: "typed@example.test" });
    const audits = (await auditRows(t.principal)).length;

    expect((await request(server).delete("/v1/me").set(t.headers)).status).toBe(204);
    expect(await row(t.principal, "photographer")).toMatchObject({ state: "pending", revision: 1, request_email: null, grant_email: null });
    expect(await row(t.principal, "admin")).toMatchObject({ state: "active", revision: 1, request_email: null, grant_email: null });
    expect(await auditRows(t.principal)).toHaveLength(audits);
    expect((await request(server).delete("/v1/me").set(t.headers)).status).toBe(204); // idempotent
  });
});
