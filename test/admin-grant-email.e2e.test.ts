import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Ajv2020 } from "ajv/dist/2020.js";
import pg from "pg";
import request from "supertest";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIREBASE_ACCOUNTS, firebaseAccountsFor } from "../src/accounts/firebase-accounts.js";
import type { FirebaseAccounts } from "../src/accounts/firebase-accounts.js";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { createFirebaseUser, getFirebaseUser, setFirebaseEmail } from "./auth-emulator.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { clearRoles, demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";

// ADR-0002 follow-up (user rulings 2026-11-19): granting `admin` marks the account's Firebase email verified, against the real Auth
// Emulator (test/global-setup.ts). Firebase is asked before the grant is written; if it refuses or cannot be reached, nothing is
// written. A typed email must be the account's own. A second app swaps the Firebase client to test the unreachable and race paths.

const PROJECT = "demo-airplane-games";
const spec: any = parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ $id: "spec", components: spec.components });
const check = (schema: string, value: unknown) => {
  const validate = ajv.compile({ $ref: `spec#/components/schemas/${schema}` });
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
};

let sql: pg.Pool;
const apps: NestExpressApplication[] = [];
const seeded: string[] = [];
const emulator = () => firebaseAccountsFor({ kind: "emulator", projectId: PROJECT, host: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "" });

/** Hook run inside the Firebase step of the swapped app (the race test sets it). */
let duringFirebase: (() => Promise<void>) | undefined;

async function start(accounts?: FirebaseAccounts): Promise<ReturnType<NestExpressApplication["getHttpServer"]>> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (accounts) builder.overrideProvider(FIREBASE_ACCOUNTS).useValue(accounts);
  const app = (await builder.compile()).createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  return app.getHttpServer();
}

let server: Awaited<ReturnType<typeof start>>;
let downServer: Awaited<ReturnType<typeof start>>;
let hookedServer: Awaited<ReturnType<typeof start>>;

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  server = await start();
  // Nothing listens on port 9: every Firebase call fails as unreachable.
  downServer = await start(firebaseAccountsFor({ kind: "emulator", projectId: PROJECT, host: "127.0.0.1:9" }));
  const real = emulator();
  hookedServer = await start({
    ensureEmailVerified: async (uid, email) => {
      const result = await real.ensureEmailVerified(uid, email);
      await duringFirebase?.();
      return result;
    },
  });
});

afterAll(async () => {
  await frozenDelete(sql, "admin_audit", "target = ANY($1::text[]) OR actor = ANY($1::text[])", [seeded]);
  await clearRoles(sql, ...seeded);
  for (const app of apps) await app.close();
  await sql.end();
});

type Who = { uid: string; principal: string; headers: Record<string, string> };

/** A uid with an admin token; `firebase: null` gives it no Firebase account at all. */
async function who(firebase: Parameters<typeof createFirebaseUser>[1] | null = {}): Promise<Who> {
  const uid = `ge-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  seeded.push(principal);
  if (firebase !== null) await createFirebaseUser(uid, firebase);
  return { uid, principal, headers: { Authorization: `Bearer ${emulatorToken(uid)}` } };
}

async function boss(): Promise<Who> {
  const w = await who();
  await seedRole(sql, w.principal, "admin");
  return w;
}

const grant = (srv: typeof server, by: Who, target: string, body: object = {}) =>
  request(srv).post(`/v1/admin/accounts/${encodeURIComponent(target)}/roles/admin/grant`).set(by.headers).send(body);
const adminRow = async (principal: string) =>
  (await sql.query("SELECT state, revision, grant_email FROM account_roles WHERE principal = $1 AND role = 'admin'", [principal])).rows[0];
const grants = async (principal: string) =>
  (await sql.query("SELECT detail FROM admin_audit WHERE target = $1 AND action = 'role_grant' ORDER BY id", [principal])).rows.map((r) => r.detail);

describe("admin grant marks the Firebase email verified", () => {
  it("an unverified email/password account: verified, granted, audited without the email", async () => {
    const b = await boss();
    const t = await who();
    expect((await getFirebaseUser(t.uid))?.emailVerified).toBe(false);
    const res = await grant(server, b, t.principal, { note: "editor" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    check("AdminGrantEnvelope", res.body);
    expect(res.body.emailVerification).toBe("verified");
    expect((await getFirebaseUser(t.uid))?.emailVerified).toBe(true);
    const [detail] = await grants(t.principal);
    expect(detail).toEqual({ role: "admin", from: null, to: { state: "active", revision: 1 }, note: "editor", emailVerifiedAtGrant: true, emailVerification: "verified" });
    expect(JSON.stringify(detail)).not.toContain("@");
  });

  it("an already verified account (e.g. Google) is granted as it is: already_verified", async () => {
    const b = await boss();
    const t = await who({ emailVerified: true });
    const res = await grant(server, b, t.principal);
    expect(res.status).toBe(200);
    expect(res.body.emailVerification).toBe("already_verified");
    expect((await grants(t.principal))[0]).toMatchObject({ emailVerifiedAtGrant: true, emailVerification: "already_verified" });
  });

  it("an account without an email is granted and reported no_email (it cannot be verified)", async () => {
    const b = await boss();
    const t = await who({ email: null });
    const res = await grant(server, b, t.principal);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.emailVerification).toBe("no_email");
    expect(await adminRow(t.principal)).toMatchObject({ state: "active" });
    expect((await grants(t.principal))[0]).toMatchObject({ emailVerifiedAtGrant: false, emailVerification: "no_email" });
    expect((await getFirebaseUser(t.uid))?.emailVerified).not.toBe(true);
  });

  it("a typed email must be the account's own (case-insensitive); a different one is 409 account_email_mismatch, nothing changed", async () => {
    const b = await boss();
    const t = await who({ email: "editor@example.test" });
    const wrong = await grant(server, b, t.principal, { email: "someone.else@example.test" });
    expect(wrong.status).toBe(409);
    check("Error", wrong.body);
    expect(wrong.body.error.code).toBe("account_email_mismatch");
    expect(wrong.body.error.message).toContain("not this account's sign-in email");
    expect(await adminRow(t.principal)).toBeUndefined();
    expect(await grants(t.principal)).toEqual([]);
    expect((await getFirebaseUser(t.uid))?.emailVerified).toBe(false);

    const right = await grant(server, b, t.principal, { email: " Editor@Example.TEST " });
    expect(right.status, JSON.stringify(right.body)).toBe(200);
    expect(right.body.role).toMatchObject({ grantEmail: "editor@example.test" });
    expect(right.body.emailVerification).toBe("verified");
  });

  it("a typed email for an account without an email is a mismatch too", async () => {
    const b = await boss();
    const t = await who({ email: null });
    const res = await grant(server, b, t.principal, { email: "editor@example.test" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("account_email_mismatch");
    expect(await adminRow(t.principal)).toBeUndefined();
  });

  it("no Firebase account with that uid: 404 not_found, nothing written", async () => {
    const b = await boss();
    const t = await who(null);
    const res = await grant(server, b, t.principal);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "not_found", message: expect.stringContaining("no Firebase account") });
    expect(await adminRow(t.principal)).toBeUndefined();
    expect(await grants(t.principal)).toEqual([]);
  });

  it("a disabled Firebase account: 409 account_disabled, nothing written", async () => {
    const b = await boss();
    const t = await who({ disabled: true });
    const res = await grant(server, b, t.principal);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("account_disabled");
    expect(await adminRow(t.principal)).toBeUndefined();
    expect((await getFirebaseUser(t.uid))?.emailVerified).toBe(false);
  });

  it("Firebase unreachable: 503 service_unavailable, nothing written, the email stays unverified", async () => {
    const b = await boss();
    const t = await who();
    const res = await grant(downServer, b, t.principal);
    expect(res.status).toBe(503);
    check("Error", res.body);
    expect(res.body.error.code).toBe("service_unavailable");
    expect(await adminRow(t.principal)).toBeUndefined();
    expect(await grants(t.principal)).toEqual([]);
    expect((await getFirebaseUser(t.uid))?.emailVerified).toBe(false);
  });

  it("a grant the role state refuses never touches Firebase (already active: 409, still unverified)", async () => {
    const b = await boss();
    const t = await who();
    await seedRole(sql, t.principal, "admin", "active");
    const res = await grant(server, b, t.principal);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("version_conflict");
    expect((await getFirebaseUser(t.uid))?.emailVerified).toBe(false);
  });

  it("race: the row changes after the first check; the locked check refuses (409), the email stays verified", async () => {
    const b = await boss();
    const t = await who();
    duringFirebase = async () => seedRole(sql, t.principal, "admin", "active");
    try {
      const res = await grant(hookedServer, b, t.principal);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("version_conflict");
    } finally {
      duringFirebase = undefined;
    }
    expect(await grants(t.principal)).toEqual([]);
    expect((await getFirebaseUser(t.uid))?.emailVerified).toBe(true);
  });

  it("the typed email can be corrected later without Firebase (display only); a new grant re-checks it", async () => {
    const b = await boss();
    const t = await who({ email: "first@example.test" });
    expect((await grant(server, b, t.principal, { email: "first@example.test" })).status).toBe(200);
    await setFirebaseEmail(t.uid, "second@example.test");
    // Revoke needs a second active admin besides b, which b and others in the shared database provide.
    const revoke = await request(server)
      .post(`/v1/admin/accounts/${encodeURIComponent(t.principal)}/roles/admin/revoke`)
      .set(b.headers)
      .send({ revision: 1 });
    expect(revoke.status).toBe(200);
    const stale = await grant(server, b, t.principal, { email: "first@example.test" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("account_email_mismatch");
    expect(await adminRow(t.principal)).toMatchObject({ state: "revoked", revision: 2 });
  });
});
