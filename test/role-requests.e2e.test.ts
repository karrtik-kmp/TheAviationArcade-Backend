import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Ajv2020 } from "ajv/dist/2020.js";
import pg from "pg";
import request from "supertest";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import type { AccountRole, RoleState } from "../src/db/enums.js";
import { createFirebaseUser } from "./auth-emulator.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { clearRoles, demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";

// Backend ADR-0002 / plan R-b (amended 2026-11-26, docs/plans/self-serve-photographer.md): photographer self-activation and admin decisions
// against the real Nest app and the real test database.
// Every test uses fresh uids. Tests of the "at least one admin" rule isolate the shared admin rows (see onlyAdmins).

const spec: any = parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ $id: "spec", components: spec.components });
const check = (schema: string, value: unknown) => {
  const validate = ajv.compile({ $ref: `spec#/components/schemas/${schema}` });
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
};

/** A minimal valid 64x48 PNG (signature, IHDR, IEND); the server checks the signature and dimensions only. */
function tinyPng(): Buffer {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const unique = [...randomUUID().replace(/-/g, "")].map((c) => c.charCodeAt(0));
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(64), ...be32(48), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...be32(unique.length), 0x74, 0x45, 0x58, 0x74, ...unique, 0, 0, 0, 0,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

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
  await frozenDelete(sql, "admin_audit", "target = ANY($1::text[]) OR actor = ANY($1::text[])", [seeded]);
  await clearRoles(sql, ...seeded);
  await sql.query("DELETE FROM players WHERE id = ANY($1::text[])", [seeded]);
  await app.close();
  await sql.end();
});

type Who = { uid: string; principal: string; headers: Record<string, string> };

function who(roles: [AccountRole, RoleState][] = [], token: { email?: string | null; emailVerified?: boolean } = {}): Promise<Who> {
  const uid = `rb-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  seeded.push(principal);
  const headers = { Authorization: `Bearer ${emulatorToken(uid, undefined, undefined, token)}` };
  return (async () => {
    // The Firebase account behind the token (an admin grant marks its email verified): same email as the token, unverified.
    await createFirebaseUser(uid, { email: token.email === undefined ? undefined : token.email });
    for (const [role, state] of roles) await seedRole(sql, principal, role, state);
    return { uid, principal, headers };
  })();
}

const admin = () => who([["admin", "active"]]);
const enc = (principal: string) => encodeURIComponent(principal);
const rolePath = (target: string, tail: string) => `/v1/admin/accounts/${enc(target)}/roles/${tail}`;
const post = (w: Who, path: string, body?: unknown) => {
  const r = request(server).post(path).set(w.headers);
  return body === undefined ? r : r.send(body as object);
};

async function row(principal: string, role: string) {
  return (await sql.query("SELECT * FROM account_roles WHERE principal = $1 AND role = $2", [principal, role])).rows[0] as any;
}
async function auditRows(target: string, action?: string) {
  return (
    await sql.query(`SELECT * FROM admin_audit WHERE target = $1 ${action ? "AND action = $2" : ""} ORDER BY id`, action ? [target, action] : [target])
  ).rows as any[];
}

/** Turn on the photographer role as `w`; returns the row's revision. */
async function requestRole(w: Who): Promise<number> {
  const res = await post(w, "/v1/me/roles/photographer");
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  return res.body.role.revision;
}

/** Run `fn` with `keep` as the only active admins (the e2e database is shared), then restore the others. */
async function onlyAdmins(keep: string[], fn: () => Promise<void>): Promise<void> {
  const others = (
    await sql.query("SELECT principal FROM account_roles WHERE role = 'admin' AND state = 'active' AND principal <> ALL($1::text[])", [keep])
  ).rows.map((r) => r.principal as string);
  await sql.query("UPDATE account_roles SET state = 'revoked' WHERE role = 'admin' AND principal = ANY($1::text[])", [others]);
  try {
    await fn();
  } finally {
    await sql.query("UPDATE account_roles SET state = 'active' WHERE role = 'admin' AND principal = ANY($1::text[])", [others]);
  }
}

describe("self-activation: POST /v1/me/roles/photographer", () => {
  it("activates at once with the token email, no player row, one audit row; asking again is a 200 no-op", async () => {
    const w = await who([], { email: "Pilot@Example.test" });
    const first = await post(w, "/v1/me/roles/photographer");
    expect(first.status).toBe(201);
    check("PhotographerRequestResult", first.body);
    expect(first.body).toMatchObject({ changed: true, role: { role: "photographer", state: "active", revision: 1 } });
    expect(typeof first.body.role.decidedAt).toBe("string");
    const stored = await row(w.principal, "photographer");
    expect(stored).toMatchObject({ state: "active", decided_by: w.principal, note: null, request_email: "Pilot@Example.test" });
    expect(stored.decided_at).not.toBeNull();
    expect((await sql.query("SELECT 1 FROM players WHERE id = $1", [w.principal])).rowCount).toBe(0);
    const audits = await auditRows(w.principal, "role_self_activate");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: w.principal, target: w.principal });
    expect(audits[0].detail).toEqual({ role: "photographer", from: null, to: { state: "active", revision: 1 }, note: null });
    expect(JSON.stringify(audits[0]).toLowerCase()).not.toContain("example.test");

    const again = await post(w, "/v1/me/roles/photographer");
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ changed: false, role: { state: "active", revision: 1 } });
    expect(await auditRows(w.principal, "role_self_activate")).toHaveLength(1);
    expect(await row(w.principal, "photographer")).toMatchObject({ revision: 1, updated_at: stored.updated_at });
  });

  it("needs a verified email: unverified or no email claim is 403 and writes nothing", async () => {
    for (const token of [{ emailVerified: false }, { email: null }]) {
      const w = await who([], token);
      const res = await post(w, "/v1/me/roles/photographer");
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
      expect(await row(w.principal, "photographer")).toBeUndefined();
      expect(await auditRows(w.principal)).toHaveLength(0);
    }
  });

  it("a body or query naming a role or state is 400 and writes nothing", async () => {
    const w = await who();
    for (const body of [{ role: "admin" }, { state: "active" }, { role: "photographer" }, { revision: 1 }]) {
      const res = await post(w, "/v1/me/roles/photographer", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    for (const query of ["?role=admin", "?state=active"]) {
      expect((await post(w, `/v1/me/roles/photographer${query}`)).status, query).toBe(400);
      expect((await request(server).get(`/v1/me/roles${query}`).set(w.headers)).status, query).toBe(400);
    }
    expect(await row(w.principal, "photographer")).toBeUndefined();
    // An empty object is tolerated, like the other no-body POSTs.
    expect((await post(w, "/v1/me/roles/photographer", {})).status).toBe(201);
  });

  it("an active row is never touched: 200, same revision, decided_by and updated_at, no audit row", async () => {
    const w = await who([["photographer", "active"]]);
    const before = await row(w.principal, "photographer");
    const res = await post(w, "/v1/me/roles/photographer");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: false, role: { state: "active", revision: before.revision } });
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "active", revision: before.revision, decided_by: before.decided_by, updated_at: before.updated_at });
    expect(await auditRows(w.principal)).toHaveLength(0);
  });

  it("a pending, rejected or revoked row becomes active at revision + 1: decision replaced, note cleared, new email, updated_at moved", async () => {
    for (const state of ["pending", "rejected", "revoked"] as const) {
      const w = await who([["photographer", state]], { email: "new@example.test" });
      await sql.query("UPDATE account_roles SET note = 'old note', request_email = 'old@example.test' WHERE principal = $1 AND role = 'photographer'", [w.principal]);
      const before = await row(w.principal, "photographer");
      await new Promise((done) => setTimeout(done, 5));
      const res = await post(w, "/v1/me/roles/photographer");
      expect(res.status, state).toBe(201);
      expect(res.body.role).toMatchObject({ state: "active", revision: 2 });
      expect(res.body.role.decidedAt).not.toBeNull();
      const stored = await row(w.principal, "photographer");
      expect(stored).toMatchObject({ state: "active", decided_by: w.principal, note: null, request_email: "new@example.test", revision: 2 });
      expect(stored.decided_at).not.toBeNull();
      expect(stored.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
      const audits = await auditRows(w.principal, "role_self_activate");
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actor: w.principal, target: w.principal });
      expect(audits[0].detail).toEqual({ role: "photographer", from: { state, revision: 1 }, to: { state: "active", revision: 2 }, note: null });
    }
  });

  it("a blocked account is refused 403 and nothing is written", async () => {
    const w = await who([["photographer", "blocked"]], { email: "b@example.test" });
    const before = await row(w.principal, "photographer");
    const res = await post(w, "/v1/me/roles/photographer");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
    expect(await row(w.principal, "photographer")).toEqual(before);
    expect(await auditRows(w.principal)).toHaveLength(0);
  });

  it("a repeat call for an active or blocked row does not wait on the role lock; a first call and a pending row do", async () => {
    const activeW = await who([["photographer", "active"]]);
    const blockedW = await who([["photographer", "blocked"]]);
    const pendingW = await who([["photographer", "pending"]]);
    const first = await who();
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended('account-roles', 0))");
      for (const [w, status] of [[activeW, 200], [blockedW, 403]] as const) {
        const res = await Promise.race([post(w, "/v1/me/roles/photographer").then((r) => r), new Promise<null>((done) => setTimeout(() => done(null), 3000))]);
        expect(res, "the no-op call waited on the lock").not.toBeNull();
        expect(res!.status).toBe(status);
      }
      const waiting = [first, pendingW].map((w) => post(w, "/v1/me/roles/photographer").then((r) => r));
      const early = await Promise.race([Promise.all(waiting), new Promise<null>((done) => setTimeout(() => done(null), 500))]);
      expect(early, "a first call and a pending row must wait for the lock").toBeNull();
      await holder.query("SELECT pg_advisory_unlock(hashtextextended('account-roles', 0))");
      expect((await Promise.all(waiting)).map((r) => r.status)).toEqual([201, 201]);
    } finally {
      await holder.end();
    }
  });

  it("two parallel self-activations from revoked: one 201, one 200, one audit row, revision + 1 once", async () => {
    const w = await who([["photographer", "revoked"]]);
    const results = await Promise.all([post(w, "/v1/me/roles/photographer").then((r) => r), post(w, "/v1/me/roles/photographer").then((r) => r)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(results.map((r) => r.body.changed).sort()).toEqual([false, true]);
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "active", revision: 2 });
    expect(await auditRows(w.principal, "role_self_activate")).toHaveLength(1);
  });

  it("an astral-plane email of 2 code points (4 UTF-16 units) is 403, not a 500", async () => {
    // test/tokens.ts uses btoa (Latin-1 only), so re-encode the claims segment as UTF-8 here.
    const w = await who([], { email: "placeholder@example.test" });
    const [header, claims] = w.headers.Authorization!.slice("Bearer ".length).split(".") as [string, string];
    const forged = { ...JSON.parse(Buffer.from(claims, "base64url").toString("utf8")), email: "\u{1F600}\u{1F600}" };
    w.headers = { Authorization: `Bearer ${header}.${Buffer.from(JSON.stringify(forged), "utf8").toString("base64url")}.` };
    const res = await post(w, "/v1/me/roles/photographer");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
    expect(await row(w.principal, "photographer")).toBeUndefined();
  });

  it("GET /v1/me/roles lists the caller's own rows in every state, in a fixed order", async () => {
    const w = await who([["photographer", "pending"], ["player", "active"]]);
    const res = await request(server).get("/v1/me/roles").set(w.headers);
    expect(res.status).toBe(200);
    check("OwnRolesEnvelope", res.body);
    expect(res.body.roles.map((r: any) => [r.role, r.state])).toEqual([["player", "active"], ["photographer", "pending"]]);
    expect(JSON.stringify(res.body)).not.toContain(w.principal);
    const other = await who();
    expect((await request(server).get("/v1/me/roles").set(other.headers)).body).toEqual({ roles: [] });
  });

  it("a pending photographer row grants nothing until the account activates it", async () => {
    const w = await who([["photographer", "pending"]]);
    expect((await request(server).get("/v1/admin/me").set(w.headers)).status).toBe(403);
    expect((await request(server).get("/v1/admin/role-requests").set(w.headers)).status).toBe(403);
    expect((await row(w.principal, "photographer")).state).toBe("pending");
  });

  it("a fresh verified account activates the role and then uploads, with no admin step", async () => {
    const w = await who([], { email: "fresh@example.test" });
    expect((await post(w, "/v1/me/roles/photographer")).status).toBe(201);
    const res = await request(server)
      .post("/v1/admin/media")
      .set(w.headers)
      .set("Content-Type", "image/png")
      .set("Idempotency-Key", randomUUID())
      .set("X-Rights-Statement", "v1_own")
      .send(tinyPng());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: "unverified" });
    const owned = "(SELECT id FROM media_items WHERE owner = $1)";
    await sql.query(`DELETE FROM media_upload_keys WHERE media_id IN ${owned}`, [w.principal]);
    await frozenDelete(sql, "media_versions", `media_id IN ${owned}`, [w.principal]);
    await sql.query("DELETE FROM media_items WHERE owner = $1", [w.principal]);
  });
});

describe("decisions: revoke, and the removed approve and reject routes", () => {
  it("approve and reject are gone: 404 for an admin whatever the body, and nothing changes", async () => {
    const boss = await admin();
    const w = await who([["photographer", "pending"]]);
    for (const tail of ["photographer/approve", "photographer/reject"]) {
      for (const body of [{ revision: 1 }, {}, { revision: 1, note: "x" }]) {
        const res = await post(boss, rolePath(w.principal, tail), body);
        expect(res.status, `${tail} ${JSON.stringify(body)}`).toBe(404);
      }
    }
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "pending", revision: 1 });
    expect(await auditRows(w.principal)).toHaveLength(0);
  });

  it("revoke then self-activate works; block then self-activate is 403; unblock then self-activate works", async () => {
    const boss = await admin();
    const w = await who([], { email: "cycle@example.test" });
    expect(await requestRole(w)).toBe(1);
    const revoked = await post(boss, rolePath(w.principal, "photographer/revoke"), { revision: 1 });
    expect(revoked.status).toBe(200);
    expect(revoked.body.role).toMatchObject({ state: "revoked", revision: 2 });
    const back = await post(w, "/v1/me/roles/photographer");
    expect(back.status).toBe(201);
    expect(back.body.role).toMatchObject({ state: "active", revision: 3 });

    expect((await post(boss, rolePath(w.principal, "photographer/block"), { revision: 3 })).status).toBe(200);
    const refused = await post(w, "/v1/me/roles/photographer");
    expect(refused.status).toBe(403);
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "blocked", revision: 4 });

    expect((await post(boss, rolePath(w.principal, "photographer/unblock"), { revision: 4 })).status).toBe(200);
    const again = await post(w, "/v1/me/roles/photographer");
    expect(again.status).toBe(201);
    expect(again.body.role).toMatchObject({ state: "active", revision: 6 });
    expect((await auditRows(w.principal)).map((r) => r.action)).toEqual([
      "role_self_activate", "role_revoke", "role_self_activate", "role_block", "role_unblock", "role_self_activate",
    ]);
  });

  it("only revoke exists: anything but an active row is 409, a missing row is 404", async () => {
    const boss = await admin();
    const active = await who([["photographer", "active"]]);
    const pending = await who([["photographer", "pending"]]);
    const rejected = await who([["photographer", "rejected"]]);
    const none = await who();
    const revoke = (t: Who, role = "photographer", revision = 1) => post(boss, rolePath(t.principal, `${role}/revoke`), { revision });
    for (const res of [await revoke(pending), await revoke(rejected), await revoke(active, "photographer", 2)]) {
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe("version_conflict");
    }
    for (const res of [await revoke(none), await revoke(none, "admin")]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
    // `player` is never decided; unknown roles are not routes.
    const player = await who([["player", "active"]]);
    for (const role of ["player", "root"]) expect((await revoke(player, role)).status).toBe(404);
    expect(await row(player.principal, "player")).toMatchObject({ state: "active", revision: 1 });
    // None of the refusals wrote anything.
    for (const t of [active, pending, rejected, none, player]) expect(await auditRows(t.principal)).toHaveLength(0);
  });

  it("revoke: active to revoked, effective on the very next request", async () => {
    const boss = await admin();
    const other = await admin();
    expect((await request(server).get("/v1/admin/me").set(other.headers)).status).toBe(200);
    const res = await post(boss, rolePath(other.principal, "admin/revoke"), { revision: 1, note: "left" });
    expect(res.status).toBe(200);
    expect(res.body.role).toMatchObject({ state: "revoked", revision: 2 });
    expect((await request(server).get("/v1/admin/me").set(other.headers)).status).toBe(403);
    expect((await auditRows(other.principal, "role_revoke"))[0].detail).toEqual({
      role: "admin", from: { state: "active", revision: 1 }, to: { state: "revoked", revision: 2 }, note: "left",
    });
    const ph = await who([["photographer", "active"]]);
    expect((await post(boss, rolePath(ph.principal, "photographer/revoke"), { revision: 1 })).body.role.state).toBe("revoked");
    expect((await request(server).get("/v1/me/roles").set(ph.headers)).body.roles[0].state).toBe("revoked");
  });

  it("bodies are strict: extra fields, a missing or bad revision, a long note are 400; query parameters too", async () => {
    const boss = await admin();
    const w = await who([["photographer", "active"]]);
    const path = rolePath(w.principal, "photographer/revoke");
    for (const body of [{}, { revision: 1, role: "admin" }, { revision: 1, state: "active" }, { revision: 0 }, { revision: 1.5 }, { revision: "1" }, { revision: 1, note: "x".repeat(501) }, { revision: 1, note: "" }]) {
      const res = await post(boss, path, body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    expect((await post(boss, `${path}?role=admin`, { revision: 1 })).status).toBe(400);
    expect((await post(boss, rolePath(w.principal, "admin/grant"), { revision: 1 })).status).toBe(400);
    expect((await row(w.principal, "photographer")).state).toBe("active");
  });

  it("a caller without an active admin (verified, photographer, unverified admin) is 403 on every route", async () => {
    const w = await who([["photographer", "pending"]]);
    const plain = await who();
    const phot = await who([["photographer", "active"]]);
    const unverified = await who([["admin", "active"]], { emailVerified: false });
    for (const caller of [plain, phot, unverified]) {
      const calls = [
        request(server).get("/v1/admin/role-requests").set(caller.headers),
        post(caller, rolePath(w.principal, "photographer/revoke"), { revision: 1 }),
        post(caller, rolePath(w.principal, "photographer/block"), { revision: 1 }),
        post(caller, rolePath(w.principal, "admin/grant"), {}),
      ];
      for (const res of await Promise.all(calls)) expect(res.status).toBe(403);
    }
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "pending", revision: 1 });
    expect(await row(w.principal, "admin")).toBeUndefined();
  });

  it("the {principal} must be exactly firebase:<configured project>:<uid>", async () => {
    const boss = await admin();
    const bad = [
      "firebase:airplane-games-auth-20261022:abc",
      "abc",
      "firebase:demo-airplane-games:",
      "firebase:demo-airplane-games:a:b",
      "firebase:demo-airplane-games: abc",
      "firebase:demo-airplane-games:abc ",
      "firebase:demo-airplane-games:a/b",
      "firebase:demo-airplane-games:a\nb",
      `firebase:demo-airplane-games:${"x".repeat(129)}`,
    ];
    for (const target of bad) {
      for (const tail of ["photographer/block", "photographer/revoke", "admin/grant"]) {
        const res = await post(boss, rolePath(target, tail), tail === "admin/grant" ? {} : { revision: 1 });
        expect(res.status, `${JSON.stringify(target)} ${tail}`).toBe(400);
        expect(res.body.error.code).toBe("invalid_request");
      }
    }
  });
});

describe("admin grant", () => {
  it("grants admin to a missing row (active, revision 1) and again to a revoked one (same row, revision + 1); an active one is 409", async () => {
    const boss = await admin();
    const target = await who();
    const granted = await post(boss, rolePath(target.principal, "admin/grant"), { note: "welcome" });
    expect(granted.status).toBe(200);
    check("AdminGrantEnvelope", granted.body);
    expect(granted.body.role).toMatchObject({ role: "admin", state: "active", revision: 1, decidedBy: boss.principal, note: "welcome" });
    expect((await request(server).get("/v1/admin/me").set(target.headers)).status).toBe(200);
    expect(granted.body.emailVerification).toBe("verified");
    expect((await auditRows(target.principal, "role_grant"))[0].detail).toEqual({
      role: "admin",
      from: null,
      to: { state: "active", revision: 1 },
      note: "welcome",
      emailVerifiedAtGrant: true,
      emailVerification: "verified",
    });

    const twice = await post(boss, rolePath(target.principal, "admin/grant"), {});
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("version_conflict");

    expect((await post(boss, rolePath(target.principal, "admin/revoke"), { revision: 1 })).status).toBe(200);
    const again = await post(boss, rolePath(target.principal, "admin/grant"), {});
    expect(again.status).toBe(200);
    expect(again.body.role).toMatchObject({ state: "active", revision: 3 });
    expect(again.body.emailVerification).toBe("already_verified");
    expect((await sql.query("SELECT count(*)::int AS n FROM account_roles WHERE principal = $1 AND role = 'admin'", [target.principal])).rows[0].n).toBe(1);
    expect((await auditRows(target.principal, "role_grant"))[1].detail.from).toEqual({ state: "revoked", revision: 2 });
  });

  it("photographer is never granted: there is no such route", async () => {
    const boss = await admin();
    const target = await who();
    expect((await post(boss, rolePath(target.principal, "photographer/grant"), {})).status).toBe(404);
    expect(await row(target.principal, "photographer")).toBeUndefined();
  });
});

describe("at least one active admin, always", () => {
  it("the last admin cannot be revoked (not even by themselves); with a second admin, self-revoke works", async () => {
    const a = await admin();
    const b = await who();
    await onlyAdmins([a.principal], async () => {
      const refused = await post(a, rolePath(a.principal, "admin/revoke"), { revision: 1 });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("version_conflict");
      expect(refused.body.error.message).toContain("no active admin");
      expect(await row(a.principal, "admin")).toMatchObject({ state: "active", revision: 1 });
      expect(await auditRows(a.principal, "role_revoke")).toHaveLength(0);

      expect((await post(a, rolePath(b.principal, "admin/grant"), {})).status).toBe(200);
      expect((await post(a, rolePath(a.principal, "admin/revoke"), { revision: 1 })).status).toBe(200);
      expect((await request(server).get("/v1/admin/me").set(a.headers)).status).toBe(403);
      // b is now the only one.
      expect((await post(b, rolePath(b.principal, "admin/revoke"), { revision: 1 })).status).toBe(409);
      expect((await request(server).get("/v1/admin/me").set(b.headers)).status).toBe(200);
    });
  });

  it("two admins revoking each other at once leave exactly one admin", async () => {
    const a = await admin();
    const b = await admin();
    await onlyAdmins([a.principal, b.principal], async () => {
      const [x, y] = await Promise.all([
        post(a, rolePath(b.principal, "admin/revoke"), { revision: 1 }),
        post(b, rolePath(a.principal, "admin/revoke"), { revision: 1 }),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 403]);
      const active = (await sql.query("SELECT count(*)::int AS n FROM account_roles WHERE role = 'admin' AND state = 'active'")).rows[0].n;
      expect(active).toBe(1);
      expect((await auditRows(a.principal, "role_revoke")).length + (await auditRows(b.principal, "role_revoke")).length).toBe(1);
    });
  });

  it("an admin revoked while their decision waits for the lock cannot commit it: 403, nothing written", async () => {
    const a = await admin();
    const w = await who([["photographer", "active"]]);
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('account-roles', 0))");
      const pending = post(a, rolePath(w.principal, "photographer/revoke"), { revision: 1 }).then((r) => r);
      await new Promise((done) => setTimeout(done, 400)); // the request has passed the guard and waits on the lock
      await holder.query("UPDATE account_roles SET state = 'revoked' WHERE principal = $1 AND role = 'admin'", [a.principal]);
      await holder.query("COMMIT");
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    } finally {
      await holder.end();
    }
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "active", revision: 1 });
    expect(await auditRows(w.principal, "role_revoke")).toHaveLength(0);
  });
});

describe("queue: GET /v1/admin/role-requests", () => {
  it("lists pending rows oldest first with the requester email, pages with an opaque cursor, and rejects bad input", async () => {
    const boss = await admin();
    const mine: Who[] = [];
    // Nothing creates a pending row any more (0.32.0); these are old rows, seeded directly.
    for (let i = 0; i < 3; i += 1) {
      const w = await who([["photographer", "pending"]], { email: `queue-${i}@example.test` });
      await sql.query("UPDATE account_roles SET request_email = $2 WHERE principal = $1 AND role = 'photographer'", [w.principal, `queue-${i}@example.test`]);
      mine.push(w);
      await new Promise((done) => setTimeout(done, 5));
    }
    const seen: any[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200; page += 1) {
      const res: any = await request(server).get(`/v1/admin/role-requests?limit=2${cursor ? `&cursor=${cursor}` : ""}`).set(boss.headers);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      check("RoleRequestList", res.body);
      expect(res.body.requests.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.requests);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    const keys = seen.map((r) => `${r.principal}|${r.role}`);
    expect(new Set(keys).size).toBe(keys.length);
    const order = mine.map((w) => keys.indexOf(`${w.principal}|photographer`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(seen.find((r) => r.principal === mine[1]?.principal)).toMatchObject({ state: "pending", requestEmail: "queue-1@example.test", decidedBy: null, revision: 1 });
    for (let i = 1; i < seen.length; i += 1) expect(Date.parse(seen[i].requestedAt)).toBeGreaterThanOrEqual(Date.parse(seen[i - 1].requestedAt));

    // Forged cursors: right shape, not a real instant. They must be 400, not a 500 from the ::timestamptz cast.
    const forged = (at: string) => `?cursor=${Buffer.from(JSON.stringify([at, boss.principal, "photographer"]), "utf8").toString("base64url")}`;
    const forgedQueries = [
      "2026-13-45 99:99:99+00",
      "2026-13-10 10:00:00+00",
      "2026-11-32 10:00:00+00",
      "2026-11-03 25:00:00+00",
      "2026-02-30 10:00:00+00",
      "2026-11-03 10:00:00+99",
      "2026-11-03 10:00:00+00:99",
    ].map(forged);
    for (const query of [...forgedQueries, "?cursor=%25%25", "?cursor=bm90IGpzb24", "?limit=0", "?limit=101", "?limit=x", "?state=maybe", "?role=admin", "?cursor="]) {
      const res = await request(server).get(`/v1/admin/role-requests${query}`).set(boss.headers);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    // A pending row the account then activates leaves the pending queue and shows under active.
    expect((await post(mine[0]!, "/v1/me/roles/photographer")).status).toBe(201);
    const active = await request(server).get("/v1/admin/role-requests?state=active&limit=100").set(boss.headers);
    expect(active.body.requests.some((r: any) => r.principal === mine[0]!.principal)).toBe(true);
    const pending = await request(server).get("/v1/admin/role-requests?limit=100").set(boss.headers);
    expect(pending.body.requests.some((r: any) => r.principal === mine[0]!.principal)).toBe(false);
  });
});

describe("player role at sign-in: PUT /v1/me", () => {
  it("N concurrent sign-ins give one player row and one role_grant audit row", async () => {
    const w = await who();
    const results = await Promise.all(Array.from({ length: 6 }, () => request(server).put("/v1/me").set(w.headers)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect((await sql.query("SELECT count(*)::int AS n FROM account_roles WHERE principal = $1 AND role = 'player'", [w.principal])).rows[0].n).toBe(1);
    const audits = await auditRows(w.principal, "role_grant");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "system:signup" });
    expect(audits[0].detail).toEqual({ role: "player", from: null, to: { state: "active", revision: 1 }, note: null });
    expect(await row(w.principal, "player")).toMatchObject({ state: "active", decided_by: "system:signup" });
    await request(server).put("/v1/me").set(w.headers);
    expect(await auditRows(w.principal, "role_grant")).toHaveLength(1);
  });

  it("an existing player gets the role on the next sign-in; a revoked player role is never reactivated", async () => {
    const w = await who();
    await request(server).put("/v1/me").set(w.headers);
    await sql.query("DELETE FROM account_roles WHERE principal = $1", [w.principal]);
    expect((await request(server).put("/v1/me").set(w.headers)).status).toBe(200);
    expect((await row(w.principal, "player")).state).toBe("active");
    await sql.query("UPDATE account_roles SET state = 'revoked', revision = 2 WHERE principal = $1 AND role = 'player'", [w.principal]);
    const grants = (await auditRows(w.principal, "role_grant")).length;
    await request(server).put("/v1/me").set(w.headers);
    expect(await row(w.principal, "player")).toMatchObject({ state: "revoked", revision: 2 });
    expect(await auditRows(w.principal, "role_grant")).toHaveLength(grants);
  });

  it("DELETE /v1/me clears the account's email and keeps role rows and audit rows", async () => {
    const w = await who([], { email: "gone@example.test" });
    await request(server).put("/v1/me").set(w.headers);
    await requestRole(w);
    expect((await row(w.principal, "photographer")).request_email).toBe("gone@example.test");
    const auditCount = (await auditRows(w.principal)).length;
    expect(auditCount).toBe(2);
    const before = await row(w.principal, "photographer");
    expect((await request(server).delete("/v1/me").set(w.headers)).status).toBe(204);
    expect((await sql.query("SELECT 1 FROM players WHERE id = $1", [w.principal])).rowCount).toBe(0);
    expect(await row(w.principal, "photographer")).toMatchObject({ state: "active", revision: 2, request_email: null });
    // Changed by design (0027, C4): clearing an email bumps the revision and updated_at, so an editor holding the old row is fenced.
    expect((await row(w.principal, "photographer")).updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(await row(w.principal, "player")).toMatchObject({ state: "active" });
    expect(await auditRows(w.principal)).toHaveLength(auditCount);
    // Deleting again, or an account with no player, is still 204.
    expect((await request(server).delete("/v1/me").set(w.headers)).status).toBe(204);
    // The admin queue now shows no email for it.
    const boss = await admin();
    const list = await request(server).get("/v1/admin/role-requests?limit=100").set(boss.headers);
    const mine = list.body.requests.find((r: any) => r.principal === w.principal);
    if (mine) expect(mine.requestEmail).toBeNull();
  });
});
