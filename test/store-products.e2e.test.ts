import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql as drizzleSql } from "drizzle-orm";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { DEMO_PRODUCTS } from "../src/store/demo-products.js";
import type { DemoProduct } from "../src/store/demo-products.js";
import { seedDemoCatalog } from "../src/store/seed-demo.js";
import { StoreCatalogService } from "../src/store/store-catalog.service.js";
import { DatabaseService } from "../src/database/database.module.js";
import { seedAdmins, demoPrincipal } from "./roles-helpers.js";
import { DEMO_HINT_5, DEMO_PASS_MONTHLY, seedDemoProducts, seedProduct } from "./store-helpers.js";
import { emulatorToken } from "./tokens.js";

// Slice P-B: the store catalog (GET /v1/store/products, /v1/admin/store/products, seed command core).

const staff = { Authorization: `Bearer ${emulatorToken("staff")}` };
const player = { Authorization: `Bearer ${emulatorToken("player-1")}` };
const STAFF_PRINCIPAL = demoPrincipal("staff");
const ADMIN = "/v1/admin/store/products";
const NEW_ID = "pbtest.hints.7";
const PASS_ID = "pbtest.pass.week";

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await seedAdmins(sql, "staff");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
});

afterAll(async () => {
  await sql.query("DELETE FROM store_products WHERE product_id LIKE 'pbtest.%'");
  await app.close();
  await sql.end();
});

beforeEach(async () => {
  await sql.query("DELETE FROM store_products WHERE product_id LIKE 'pbtest.%'");
  await sql.query("DELETE FROM admin_audit WHERE action LIKE 'store_product_%'");
  await seedDemoProducts(sql);
});

const put = (id: string, body: unknown, headers: Record<string, string> = staff) =>
  request(server).put(`${ADMIN}/${id}`).set(headers).send(body as object);
const retire = (id: string, body: unknown, headers: Record<string, string> = staff) =>
  request(server).post(`${ADMIN}/${id}/retire`).set(headers).send(body as object);
const restore = (id: string, body: unknown, headers: Record<string, string> = staff) =>
  request(server).post(`${ADMIN}/${id}/restore`).set(headers).send(body as object);
const pack = (over: Record<string, unknown> = {}) => ({ kind: "hint_pack", title: "Seven hints", hints: 7, demo: false, ...over });
const pass = (over: Record<string, unknown> = {}) => ({ kind: "first_class_pass", title: "Weekly pass", passPeriod: "P1M", demo: false, ...over });

async function stored(id: string) {
  return (await sql.query("SELECT * FROM store_products WHERE product_id = $1", [id])).rows[0];
}
async function audits() {
  return (await sql.query("SELECT * FROM admin_audit WHERE action LIKE 'store_product_%' ORDER BY id")).rows;
}

describe("access", () => {
  it("401 without a token, 403 for a player on every admin route", async () => {
    const calls = [
      () => request(server).get(ADMIN),
      () => request(server).put(`${ADMIN}/${NEW_ID}`).send(pack()),
      () => request(server).post(`${ADMIN}/${DEMO_HINT_5}/retire`).send({ version: 1 }),
      () => request(server).post(`${ADMIN}/${DEMO_HINT_5}/restore`).send({ version: 1 }),
    ];
    for (const call of calls) expect((await call()).status).toBe(401);
    expect((await request(server).get(ADMIN).set(player)).status).toBe(403);
    expect((await put(NEW_ID, pack(), player)).status).toBe(403);
    expect((await retire(DEMO_HINT_5, { version: 1 }, player)).status).toBe(403);
    expect((await restore(DEMO_HINT_5, { version: 1 }, player)).status).toBe(403);
    expect(await stored(NEW_ID)).toBeUndefined();
    expect(await audits()).toHaveLength(0);
  });

  it("the player listing needs a token", async () => {
    expect((await request(server).get("/v1/store/products")).status).toBe(401);
  });
});

describe("create and edit", () => {
  it("creates a hint pack (201), writes one create audit row from the verified principal, and lists it to the player", async () => {
    const res = await put(NEW_ID, pack());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ productId: NEW_ID, kind: "hint_pack", hints: 7, passPeriod: null, title: "Seven hints", demo: false, status: "active", version: 1 });
    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: STAFF_PRINCIPAL, action: "store_product_create", target: NEW_ID });
    expect(log[0].detail).toMatchObject({ version: 1, kind: "hint_pack", hints: 7 });

    const list = await request(server).get("/v1/store/products").set(player);
    expect(list.status).toBe(200);
    expect(list.body.products).toContainEqual({ productId: NEW_ID, kind: "hint_pack", hints: 7 });
  });

  it("creates a Pass with passPeriod and no hints", async () => {
    const res = await put(PASS_ID, pass());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "first_class_pass", hints: null, passPeriod: "P1M" });
    const list = await request(server).get("/v1/store/products").set(player);
    expect(list.body.products).toContainEqual({ productId: PASS_ID, kind: "first_class_pass", passPeriod: "P1M" });
  });

  it("creating an existing id without a version is 409 version_conflict and writes nothing", async () => {
    await put(NEW_ID, pack());
    const res = await put(NEW_ID, pack({ title: "Other" }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("version_conflict");
    expect((await stored(NEW_ID)).title).toBe("Seven hints");
    expect(await audits()).toHaveLength(1);
  });

  it("edits with the right version (200): bumps version, one edit audit row with the diff", async () => {
    await put(NEW_ID, pack());
    const res = await put(NEW_ID, pack({ version: 1, title: "Eight hints", hints: 8 }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 2, title: "Eight hints", hints: 8 });
    const log = await audits();
    expect(log.map((r) => r.action)).toEqual(["store_product_create", "store_product_edit"]);
    expect(log[1]).toMatchObject({ actor: STAFF_PRINCIPAL, target: NEW_ID });
    expect(log[1].detail).toMatchObject({
      fromVersion: 1,
      version: 2,
      diff: [
        { field: "title", from: "Seven hints", to: "Eight hints" },
        { field: "hints", from: 7, to: 8 },
      ],
    });
  });

  it("sending the stored values back is a 200 with no change: no bump, no audit row", async () => {
    await put(NEW_ID, pack());
    const res = await put(NEW_ID, pack({ version: 1 }));
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(await audits()).toHaveLength(1);
  });

  it("a stale version is 409 version_conflict and nothing is written", async () => {
    await put(NEW_ID, pack());
    await put(NEW_ID, pack({ version: 1, title: "Eight hints" }));
    const res = await put(NEW_ID, pack({ version: 1, title: "Nine hints" }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("version_conflict");
    expect((await stored(NEW_ID)).title).toBe("Eight hints");
    expect(await audits()).toHaveLength(2);
  });

  it("an edit with a version for an unknown product is 404 not_found", async () => {
    const res = await put("pbtest.missing", pack({ version: 1 }));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("two concurrent edits at the same version: one 200, one 409", async () => {
    await put(NEW_ID, pack());
    const [a, b] = await Promise.all([put(NEW_ID, pack({ version: 1, title: "A" })), put(NEW_ID, pack({ version: 1, title: "B" }))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await stored(NEW_ID)).version).toBe(2);
    expect(await audits()).toHaveLength(2);
  });

  it("kind and demo are immutable (422 content_invalid), nothing is written", async () => {
    await put(NEW_ID, pack());
    const kind = await put(NEW_ID, pass({ version: 1 }));
    expect(kind.status).toBe(422);
    expect(kind.body.error.code).toBe("content_invalid");
    const demo = await put(NEW_ID, pack({ version: 1, demo: true }));
    expect(demo.status).toBe(422);
    expect(demo.body.error.code).toBe("content_invalid");
    const row = await stored(NEW_ID);
    expect(row).toMatchObject({ kind: "hint_pack", demo: false, version: 1 });
    expect(await audits()).toHaveLength(1);
  });

  it("an edit never changes status (a retired product stays retired)", async () => {
    await put(NEW_ID, pack());
    await retire(NEW_ID, { version: 1 });
    const res = await put(NEW_ID, pack({ version: 2, title: "Renamed" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "retired", version: 3 });
  });
});

describe("validation", () => {
  it("rejects unknown fields, a bad id, and fields that do not fit the kind", async () => {
    expect((await put(NEW_ID, { ...pack(), extra: 1 })).status).toBe(400);
    expect((await put(NEW_ID, { kind: "hint_pack", hints: 7, demo: false })).status).toBe(400); // no title
    expect((await put(NEW_ID, pack({ hints: 0 }))).status).toBe(400);
    expect((await put(NEW_ID, pack({ hints: 1001 }))).status).toBe(400);
    expect((await put(NEW_ID, pack({ version: 0 }))).status).toBe(400);
    expect((await put("Bad-Id", pack())).status).toBe(400);
    expect((await put("pbtest.x", { ...pack(), kind: "gold" })).status).toBe(400);
    for (const bad of [pack({ hints: undefined }), pack({ passPeriod: "P1M" }), pass({ hints: 3 }), pass({ passPeriod: undefined })]) {
      const res = await put("pbtest.bad", bad);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("content_invalid");
    }
    expect(await stored("pbtest.bad")).toBeUndefined();
    expect(await stored(NEW_ID)).toBeUndefined();
    expect(await audits()).toHaveLength(0);
  });

  it("retire and restore need exactly { version }", async () => {
    expect((await retire(DEMO_HINT_5, {})).status).toBe(400);
    expect((await retire(DEMO_HINT_5, { version: 1, extra: true })).status).toBe(400);
    expect((await restore(DEMO_HINT_5, { version: "1" })).status).toBe(400);
  });
});

describe("retire and restore", () => {
  it("retire hides the product from the player list, restore brings it back; one audit row each", async () => {
    await put(NEW_ID, pack());
    const r1 = await retire(NEW_ID, { version: 1 });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ status: "retired", version: 2 });
    let list = await request(server).get("/v1/store/products").set(player);
    expect(list.body.products.map((p: { productId: string }) => p.productId)).not.toContain(NEW_ID);
    // Staff still see it.
    const all = await request(server).get(ADMIN).set(staff);
    expect(all.body.products.find((p: { productId: string }) => p.productId === NEW_ID)).toMatchObject({ status: "retired" });

    const r2 = await restore(NEW_ID, { version: 2 });
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ status: "active", version: 3 });
    list = await request(server).get("/v1/store/products").set(player);
    expect(list.body.products.map((p: { productId: string }) => p.productId)).toContain(NEW_ID);

    const log = await audits();
    expect(log.map((r) => r.action)).toEqual(["store_product_create", "store_product_retire", "store_product_restore"]);
    expect(log[1]).toMatchObject({ actor: STAFF_PRINCIPAL, target: NEW_ID });
    expect(log[1].detail).toMatchObject({ fromVersion: 1, version: 2, diff: [{ field: "status", from: "active", to: "retired" }] });
  });

  it("already in that state is 200 with no change (version still checked)", async () => {
    await put(NEW_ID, pack());
    const noop = await restore(NEW_ID, { version: 1 });
    expect(noop.status).toBe(200);
    expect(noop.body).toMatchObject({ status: "active", version: 1 });
    await retire(NEW_ID, { version: 1 });
    const again = await retire(NEW_ID, { version: 2 });
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(2);
    expect(await audits()).toHaveLength(2); // create + the one real retire
    const stale = await retire(NEW_ID, { version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
  });

  it("a stale version is 409 and an unknown product is 404", async () => {
    await put(NEW_ID, pack());
    const stale = await retire(NEW_ID, { version: 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect((await stored(NEW_ID)).status).toBe("active");
    for (const call of [retire, restore]) {
      const res = await call("pbtest.unknown", { version: 1 });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
    expect((await retire("Not A Valid Id", { version: 1 })).status).toBe(404);
  });
});

describe("listings", () => {
  it("the player list carries only productId, kind and hints or passPeriod (no title, no price, no staff fields)", async () => {
    const res = await request(server).get("/v1/store/products").set(player);
    expect(res.status).toBe(200);
    const byId = new Map<string, Record<string, unknown>>(res.body.products.map((p: { productId: string }) => [p.productId, p]));
    expect(byId.get(DEMO_HINT_5)).toEqual({ productId: DEMO_HINT_5, kind: "hint_pack", hints: 5 });
    expect(byId.get(DEMO_PASS_MONTHLY)).toEqual({ productId: DEMO_PASS_MONTHLY, kind: "first_class_pass", passPeriod: "P1M" });
    const ids = res.body.products.map((p: { productId: string }) => p.productId);
    expect(ids).toEqual([...ids].sort());
  });

  it("the admin list shows every product with staff fields", async () => {
    await put(NEW_ID, pack());
    await retire(NEW_ID, { version: 1 });
    const res = await request(server).get(ADMIN).set(staff);
    expect(res.status).toBe(200);
    const row = res.body.products.find((p: { productId: string }) => p.productId === NEW_ID);
    expect(row).toMatchObject({ title: "Seven hints", demo: false, status: "retired", version: 2 });
    expect(typeof row.createdAt).toBe("string");
    expect(res.body.products.map((p: { productId: string }) => p.productId)).toEqual(expect.arrayContaining(DEMO_PRODUCTS.map((p) => p.productId)));
  });

  it("demo products are hidden from the player list in production, and a non-demo product is not", async () => {
    const catalog = app.get(StoreCatalogService);
    await seedProduct(sql, { productId: NEW_ID, kind: "hint_pack", hints: 7 });
    const test = (await catalog.listListed("test")).map((p) => p.productId);
    const prod = (await catalog.listListed("production")).map((p) => p.productId);
    for (const demo of DEMO_PRODUCTS) {
      expect(test).toContain(demo.productId);
      expect(prod).not.toContain(demo.productId);
    }
    expect(prod).toContain(NEW_ID);
  });

  it("creating demo: true in production is 422 content_invalid and writes nothing", async () => {
    const catalog = app.get(StoreCatalogService);
    await expect(catalog.put(STAFF_PRINCIPAL, NEW_ID, undefined, { kind: "hint_pack", title: "x", hints: 1, demo: true }, "production")).rejects.toMatchObject({
      status: 422,
      code: "content_invalid",
    });
    expect(await stored(NEW_ID)).toBeUndefined();
    expect(await audits()).toHaveLength(0);
    // The same body is fine outside production.
    const ok = await put(NEW_ID, pack({ demo: true }));
    expect(ok.status).toBe(201);
  });
});

const countOf = async (ids: string[]) => (await sql.query("SELECT count(*)::int AS n FROM store_products WHERE product_id = ANY($1::text[])", [ids])).rows[0].n as number;

/** A fresh seed list (unique ids per call), so the insert path is exercised whatever the shared database already holds. */
function freshProducts(): DemoProduct[] {
  const tag = randomUUID().replaceAll("-", "").slice(0, 12);
  return [
    { productId: `pbtest.seed.${tag}.a`, kind: "hint_pack", hints: 3, passPeriod: null, title: "Seed A", demo: true, status: "active" },
    { productId: `pbtest.seed.${tag}.b`, kind: "first_class_pass", hints: null, passPeriod: "P1Y", title: "Seed B", demo: true, status: "active" },
  ];
}

describe("seed demo catalog", () => {
  it("inserts every missing row, is idempotent, and never edits an existing row", async () => {
    const db = app.get(DatabaseService).db;
    const list = freshProducts();
    const ids = list.map((p) => p.productId);
    const first = await seedDemoCatalog(db, "test", list);
    expect(first.sort()).toEqual([...ids].sort());
    expect(await countOf(ids)).toBe(2);
    expect(await stored(ids[0] as string)).toMatchObject({ hints: 3, demo: true, status: "active", version: 1 });

    // Staff edit one; a re-run neither inserts nor reverts it.
    const edited = await put(ids[0] as string, { kind: "hint_pack", title: "Three hints", hints: 4, demo: true, version: 1 });
    expect(edited.status).toBe(200);
    expect(await seedDemoCatalog(db, "test", list)).toEqual([]);
    expect(await stored(ids[0] as string)).toMatchObject({ hints: 4, title: "Three hints", version: 2 });
    expect(await countOf(ids)).toBe(2);
  });

  it("inserts a single missing row and leaves the others alone", async () => {
    const db = app.get(DatabaseService).db;
    const list = freshProducts();
    const [a, b] = list as [DemoProduct, DemoProduct];
    await seedDemoCatalog(db, "test", [a]);
    await sql.query("UPDATE store_products SET title = 'Kept' WHERE product_id = $1", [a.productId]);
    expect(await seedDemoCatalog(db, "test", list)).toEqual([b.productId]);
    expect((await stored(a.productId)).title).toBe("Kept");
    expect(await countOf([a.productId, b.productId])).toBe(2);
  });

  it("the default list is the real DEMO_PRODUCTS: in a rolled-back transaction with the demo rows removed, a default call inserts all of them", async () => {
    const db = app.get(DatabaseService).db;
    const demoIds = DEMO_PRODUCTS.map((p) => p.productId);
    const idList = drizzleSql.join(demoIds.map((id) => drizzleSql`${id}`), drizzleSql`, `);
    let inserted: string[] = [];
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(drizzleSql`DELETE FROM store_transactions WHERE product_id IN (${idList})`);
        await tx.execute(drizzleSql`DELETE FROM store_subscriptions WHERE product_id IN (${idList})`);
        await tx.execute(drizzleSql`DELETE FROM store_products WHERE product_id IN (${idList})`);
        inserted = await seedDemoCatalog(tx, "test");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(inserted.sort()).toEqual([...demoIds].sort());
    expect(await countOf(demoIds)).toBe(DEMO_PRODUCTS.length); // the rollback restored the shared rows
  });

  it("is refused in production and writes nothing", async () => {
    const db = app.get(DatabaseService).db;
    const list = freshProducts();
    await expect(seedDemoCatalog(db, "production", list)).rejects.toThrow(/production/);
    expect(await countOf(list.map((p) => p.productId))).toBe(0);
  });
});

describe("scripts/store-seed-demo.mjs", () => {
  it("refuses APP_ENV=production with exit 2 before connecting, and writes nothing", async () => {
    // The script imports the compiled code, so build the current source first (as roles-grant.e2e.test.ts does).
    const build = spawnSync(process.execPath, ["node_modules/@nestjs/cli/bin/nest.js", "build"], { encoding: "utf8" });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const before = await sql.query("SELECT product_id, version, updated_at FROM store_products ORDER BY product_id");
    // From the temp directory so a developer's .env never reaches it; a valid production configuration, so the refusal under
    // test is the script's own and not a config error.
    const result = spawnSync(process.execPath, [path.resolve("scripts/store-seed-demo.mjs")], {
      encoding: "utf8",
      cwd: tmpdir(),
      timeout: 20_000,
      env: {
        ...process.env,
        APP_ENV: "production",
        FIREBASE_PROJECT_ID: "airplane-games-auth-20261022",
        ALLOW_EMULATOR_TOKENS: "false",
        BLOB_STORE: "none",
        BUNNY_CDN_HOST: "my-zone.b-cdn.net",
        BUNNY_CDN_TOKEN_KEY: "0123456789abcdef-secret-key",
        DATABASE_SSL: "verify-full",
      },
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("The demo catalog cannot be seeded when APP_ENV=production");
    expect(result.stdout).not.toContain("Target database");
    const after = await sql.query("SELECT product_id, version, updated_at FROM store_products ORDER BY product_id");
    expect(after.rows).toEqual(before.rows);
  });
});
