import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { RoleStore } from "../src/accounts/role-store.js";
import { APP_CONFIG, loadConfig } from "../src/config/config.module.js";
import type { AppConfig } from "../src/config/config.module.js";
import { runMediaImport } from "../src/content/media/media-import.js";
import type { ImportManifest } from "../src/content/media/media-import.js";
import { DatabaseService } from "../src/database/database.module.js";
import { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { clearRoles, demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";

// Incident 2026-11-04 (ADR-0002 follow-up): the configured shared demo account (DEMO_ACCOUNT_UID) can never hold photographer or
// admin. Defence in depth, each layer tested on its own: the roles guard, the role store (API and operator), the built
// `roles:grant` command, and the D1 import. Every principal is a demo-airplane-games one with a fresh uid.

process.env.BLOB_STORE = "memory";
for (const name of Object.keys(process.env)) if (name.startsWith("BUNNY_")) delete process.env[name];

const enc = (principal: string) => encodeURIComponent(principal);
const bearer = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid)}` });
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function png(extra: number): Buffer {
  const ancillary = [...be32(extra), 0x74, 0x45, 0x58, 0x74, ...Array<number>(extra).fill(65), 0, 0, 0, 0];
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(64), ...be32(48), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...ancillary,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

let sql: pg.Pool;
let database: DatabaseService;
let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let config: AppConfig;
const demoUid = `demo-shared-${randomUUID()}`;
const demo = demoPrincipal(demoUid);
const principals: string[] = [demo];
const dirs: string[] = [];

beforeAll(async () => {
  // The CLI imports the compiled code, so build the current source first.
  const build = spawnSync(process.execPath, ["node_modules/@nestjs/cli/bin/nest.js", "build"], { encoding: "utf8" });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  database = new DatabaseService(sql);
  config = { ...loadConfig(process.env), demoPrincipal: demo };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(APP_CONFIG).useValue(config).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
});

afterAll(async () => {
  await sql.query("DELETE FROM media_imports WHERE owner = ANY($1::text[])", [principals]);
  await sql.query("DELETE FROM admin_audit WHERE target = ANY($1::text[])", [principals]);
  await clearRoles(sql, ...principals);
  await app.close();
  await sql.end();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A fresh, ordinary active admin (the acting admin of the API calls). */
async function admin(): Promise<{ uid: string; principal: string }> {
  const uid = `demoacct-admin-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  principals.push(principal);
  await seedRole(sql, principal, "admin");
  return { uid, principal };
}

const roleRows = async (principal: string) =>
  (await sql.query("SELECT role, state, revision FROM account_roles WHERE principal = $1 AND role <> 'player' ORDER BY role", [principal])).rows;
const auditCount = async (principal: string) => (await sql.query("SELECT count(*)::int AS n FROM admin_audit WHERE target = $1", [principal])).rows[0].n as number;

async function resetDemo(): Promise<void> {
  await clearRoles(sql, demo);
  await sql.query("DELETE FROM admin_audit WHERE target = $1", [demo]);
}

describe("the roles guard ignores privileged rows of the demo account", () => {
  it("an active admin AND photographer row still gets 403 on admin and photographer routes, while the rows stay visible", async () => {
    await resetDemo();
    await seedRole(sql, demo, "admin");
    await seedRole(sql, demo, "photographer");
    const h = bearer(demoUid);
    for (const route of ["/v1/admin/me", "/v1/admin/media", "/v1/admin/role-requests", "/v1/admin/content/documents"]) {
      const res = await request(server).get(route).set(h);
      expect(res.status, route).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
    // No data change: the raw rows are still reported to the account itself.
    const mine = await request(server).get("/v1/me/roles").set(h);
    expect(mine.status).toBe(200);
    expect(mine.body.roles.map((r: { role: string }) => r.role)).toEqual(expect.arrayContaining(["photographer", "admin"]));
  });

  it("an ordinary admin is unaffected by the setting", async () => {
    const a = await admin();
    expect((await request(server).get("/v1/admin/me").set(bearer(a.uid))).status).toBe(200);
  });
});

describe("the role store refuses the demo account and writes nothing", () => {
  it("API admin grant: 403, no row, no audit row", async () => {
    await resetDemo();
    const a = await admin();
    const res = await request(server).post(`/v1/admin/accounts/${enc(demo)}/roles/admin/grant`).set(bearer(a.uid)).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
    expect(res.body.error.message).toContain("demo account");
    expect(await roleRows(demo)).toEqual([]);
    expect(await auditCount(demo)).toBe(0);
  });

  it("operator grant (the roles:grant store call), with and without onlyIfNoActiveAdmin: 403, nothing written", async () => {
    await resetDemo();
    const store = new RoleStore(database, config);
    for (const options of [undefined, { onlyIfNoActiveAdmin: true }]) {
      const outcome = await store.grantAdmin({ kind: "operator", id: "test" }, demo, null, options);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatchObject({ status: 403, code: "forbidden" });
    }
    expect(await roleRows(demo)).toEqual([]);
    expect(await auditCount(demo)).toBe(0);
  });

  it("photographer request by the demo account: 403, no row; a pending row seeded behind the API cannot be approved", async () => {
    await resetDemo();
    const req = await request(server).post("/v1/me/roles/photographer").set(bearer(demoUid));
    expect(req.status).toBe(403);
    expect(req.body.error.code).toBe("forbidden");
    expect(req.body.error.message).toContain("demo account");
    expect(await roleRows(demo)).toEqual([]);
    expect(await auditCount(demo)).toBe(0);

    await seedRole(sql, demo, "photographer", "pending");
    const a = await admin();
    const approve = await request(server).post(`/v1/admin/accounts/${enc(demo)}/roles/photographer/approve`).set(bearer(a.uid)).send({ revision: 1 });
    expect(approve.status).toBe(403);
    expect(approve.body.error.code).toBe("forbidden");
    expect(await roleRows(demo)).toEqual([{ role: "photographer", state: "pending", revision: 1 }]);
    expect(await auditCount(demo)).toBe(0);
  });

  it("cleanup stays possible: reject, revoke and block of demo rows work", async () => {
    await resetDemo();
    const a = await admin();
    const h = bearer(a.uid);
    const base = `/v1/admin/accounts/${enc(demo)}/roles`;

    await seedRole(sql, demo, "photographer", "pending");
    expect((await request(server).post(`${base}/photographer/reject`).set(h).send({ revision: 1 })).status).toBe(200);
    expect(await roleRows(demo)).toEqual([{ role: "photographer", state: "rejected", revision: 2 }]);

    await seedRole(sql, demo, "admin", "active"); // a stray row, as in the incident
    const revoked = await request(server).post(`${base}/admin/revoke`).set(h).send({ revision: 1 });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.role.state).toBe("revoked");

    await seedRole(sql, demo, "photographer", "active");
    const row = (await roleRows(demo)).find((r) => r.role === "photographer");
    expect((await request(server).post(`${base}/photographer/revoke`).set(h).send({ revision: row.revision })).status).toBe(200);
    const blocked = (await roleRows(demo)).find((r) => r.role === "photographer");
    expect((await request(server).post(`${base}/photographer/block`).set(h).send({ revision: blocked.revision })).status).toBe(200);
    expect((await roleRows(demo)).find((r) => r.role === "photographer")).toMatchObject({ state: "blocked" });
  });
});

describe("the demo admin row never counts as an active admin", () => {
  /** Sets every active admin row except `keep` aside (revoked) while `fn` runs; the shared test database may hold others. */
  async function onlyAdmins(keep: string[], fn: () => Promise<void>): Promise<void> {
    const others = (await sql.query("SELECT principal FROM account_roles WHERE role = 'admin' AND state = 'active' AND NOT principal = ANY($1::text[])", [keep])).rows.map(
      (r) => r.principal as string,
    );
    await sql.query("UPDATE account_roles SET state = 'revoked' WHERE role = 'admin' AND principal = ANY($1::text[])", [others]);
    try {
      await fn();
    } finally {
      await sql.query("UPDATE account_roles SET state = 'active' WHERE role = 'admin' AND principal = ANY($1::text[])", [others]);
    }
  }

  it("revoking the only real admin is 409 (last admin) although a stray active demo admin row exists", async () => {
    await resetDemo();
    const a = await admin();
    await seedRole(sql, demo, "admin");
    await onlyAdmins([a.principal, demo], async () => {
      const res = await request(server).post(`/v1/admin/accounts/${enc(a.principal)}/roles/admin/revoke`).set(bearer(a.uid)).send({ revision: 1 });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.message).toContain("no active admin");
    });
    expect((await roleRows(a.principal)).find((r) => r.role === "admin")).toMatchObject({ state: "active", revision: 1 });
  });

  it("roles:grant recovery (onlyIfNoActiveAdmin) succeeds for a new uid when the only other active admin row is the demo one", async () => {
    await resetDemo();
    await seedRole(sql, demo, "admin");
    const uid = `demoacct-new-${randomUUID()}`;
    const target = demoPrincipal(uid);
    principals.push(target);
    await onlyAdmins([demo], async () => {
      const outcome = await new RoleStore(database, config).grantAdmin({ kind: "operator", id: "test" }, target, null, { onlyIfNoActiveAdmin: true });
      expect(outcome.ok).toBe(true);
    });
    expect((await roleRows(target)).find((r) => r.role === "admin")).toMatchObject({ state: "active" });
  });
});

describe("pre-body role check", () => {
  it("POST /v1/admin/media as the demo account (active photographer row, verified email) is 403 before the body is used", async () => {
    await resetDemo();
    await seedRole(sql, demo, "photographer");
    const res = await request(server).post("/v1/admin/media").set(bearer(demoUid)).set("Content-Type", "image/png").send(png(3000));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });
});

describe("npm run roles:grant (scripts/roles-grant.mjs)", () => {
  function run(args: string[], env: Record<string, string> = {}) {
    // From the system temp directory: the script reads ".env" from its cwd and a developer's real one must never reach a test.
    const result = spawnSync(process.execPath, [path.resolve("scripts/roles-grant.mjs"), ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      cwd: tmpdir(),
      timeout: 20_000,
    });
    return { status: result.status, out: result.stdout, err: result.stderr };
  }

  it("refuses the demo uid, and the same account as a full principal, with exit 2 before connecting", async () => {
    await resetDemo();
    for (const target of [demoUid, demo]) {
      const r = run([target, "--yes"], { DEMO_ACCOUNT_UID: demoUid });
      expect(r.status, r.err).toBe(2);
      expect(r.err).toContain("demo account");
      expect(r.out).not.toContain("Target database");
    }
    expect(await roleRows(demo)).toEqual([]);
    expect(await auditCount(demo)).toBe(0);
  });

  it("names the full principal it is about to grant, and still needs --yes (exit 2)", () => {
    const other = `demoacct-cli-${randomUUID()}`;
    const r = run([other], { DEMO_ACCOUNT_UID: demoUid });
    expect(r.status).toBe(2);
    expect(r.out).toContain(`Principal about to be granted admin: ${demoPrincipal(other)}`);
    expect(r.err).toContain("--yes");
    expect(r.out).not.toContain("DEMO_ACCOUNT_UID is not set");
  });

  it("prints a notice when DEMO_ACCOUNT_UID is not set (exit code unchanged)", () => {
    const r = run([`demoacct-cli-${randomUUID()}`], { DEMO_ACCOUNT_UID: "" });
    expect(r.status).toBe(2);
    expect(r.out).toContain("Note: DEMO_ACCOUNT_UID is not set, so the shared demo account is not recognised here.");
  });

  it("a bad DEMO_ACCOUNT_UID fails the settings check (exit 2) without echoing the value", () => {
    const r = run(["whoever", "--yes"], { DEMO_ACCOUNT_UID: "bad:secret-uid" });
    expect(r.status).toBe(2);
    expect(r.err).toContain("DEMO_ACCOUNT_UID");
    expect(r.err + r.out).not.toContain("secret-uid");
  });
});

describe("media:import refuses the demo account as an owner", () => {
  it("an active photographer row for the demo account does not let it own imported photos (dry run and apply)", async () => {
    await resetDemo();
    await seedRole(sql, demo, "photographer");
    const bytes = png(3000 + Math.floor(Math.random() * 1e6));
    const sourceId = `d1-${randomUUID()}`;
    const file = `${sourceId}.png`;
    const entry = {
      sourceId,
      owner: demo,
      status: "approved" as const,
      file,
      contentType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      credit: "Credit",
      rightsBasis: "own" as const,
      submittedAt: "2026-10-01T12:00:00Z",
    };
    const dir = await mkdtemp(path.join(tmpdir(), "demo-import-"));
    dirs.push(dir);
    await writeFile(path.join(dir, file), bytes);
    const manifest: ImportManifest = { version: 1, source: "d1", entries: [entry] };
    for (const mode of ["dry-run", "apply"] as const) {
      const report = await runMediaImport(dir, manifest, mode, { database, blobs: new MemoryBlobStore(), config, operator: "tester" });
      expect(report.entries).toEqual([{ sourceId, status: "refused", code: "demo_account", detail: expect.stringContaining("demo account") }]);
      expect(report.counts.refused).toBe(1);
    }
    expect((await sql.query("SELECT count(*)::int AS n FROM media_items WHERE owner = $1", [demo])).rows[0].n).toBe(0);
    expect((await sql.query("SELECT count(*)::int AS n FROM media_imports WHERE owner = $1", [demo])).rows[0].n).toBe(0);
  });
});
