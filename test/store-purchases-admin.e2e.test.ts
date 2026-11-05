import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { APP_CONFIG, loadConfig } from "../src/config/config.module.js";
import { fakeReference } from "../src/purchases/fake-store-verifier.js";
import { setTestDatabaseClockSkew } from "../src/database/clock.js";
import { fingerprint } from "../src/store/store-purchases-admin.service.js";
import { clearRoles, demoPrincipal, seedAdmins, seedRole } from "./roles-helpers.js";
import { DEMO_HINT_15, DEMO_HINT_5, DEMO_MILES_25000, DEMO_MILES_5000, DEMO_PASS_MONTHLY, DEMO_PASS_YEARLY, seedDemoProducts } from "./store-helpers.js";
import { emulatorToken } from "./tokens.js";

// Wave P-D: GET /v1/admin/store/purchases and GET /v1/admin/store/players/{principal}/entitlements (docs/plans/purchases.md).
// Rows are inserted directly so every field (order ids, Google tokens) is under the test's control; every list call filters by
// `player` because the e2e database is shared.

const staff = { Authorization: `Bearer ${emulatorToken("staff")}` };
const player = { Authorization: `Bearer ${emulatorToken("player-1")}` };
const LIST = "/v1/admin/store/purchases";
const entitlementsUrl = (principal: string) => `/v1/admin/store/players/${encodeURIComponent(principal)}/entitlements`;
const DAY = 86_400_000;

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;
const created: string[] = [];
const extraAdmins: string[] = [];

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await seedAdmins(sql, "staff");
  await seedDemoProducts(sql);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
});

afterEach(() => setTestDatabaseClockSkew(0));

afterAll(async () => {
  setTestDatabaseClockSkew(0);
  await sql.query("DELETE FROM players WHERE id = ANY($1::text[])", [created]);
  await clearRoles(sql, ...extraAdmins);
  await app.close();
  await sql.end();
});

async function newPlayer(): Promise<string> {
  const uid = `pd-${randomUUID()}`;
  const res = await request(server).put("/v1/me").set({ Authorization: `Bearer ${emulatorToken(uid)}` });
  expect(res.status).toBe(201);
  const principal = demoPrincipal(uid);
  created.push(principal);
  return principal;
}

type Tx = {
  store?: "apple" | "google";
  ref?: string;
  productId?: string;
  kind?: "hint_pack" | "miles_pack" | "first_class_pass";
  orderId?: string | null;
  originalRef?: string | null;
  hints?: number;
  miles?: number;
  until?: Date;
  environment?: "production" | "sandbox" | "fake";
};

/** Inserts one store transaction and returns its id. */
async function addTx(principal: string, t: Tx = {}): Promise<number> {
  const kind = t.kind ?? "hint_pack";
  const res = await sql.query(
    `INSERT INTO store_transactions (store, transaction_ref, player_id, product_id, kind, environment, order_id, original_ref, purchased_at, granted_hints, granted_until, granted_miles)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10, $11) RETURNING id`,
    [
      t.store ?? "apple",
      t.ref ?? `tx-${randomUUID()}`,
      principal,
      t.productId ?? (kind === "hint_pack" ? DEMO_HINT_5 : kind === "miles_pack" ? DEMO_MILES_5000 : DEMO_PASS_MONTHLY),
      kind,
      t.environment ?? "sandbox",
      t.orderId ?? null,
      kind === "first_class_pass" ? (t.originalRef ?? `orig-${randomUUID()}`) : null,
      kind === "hint_pack" ? (t.hints ?? 5) : null,
      kind === "first_class_pass" ? (t.until ?? new Date(Date.now() + 30 * DAY)) : null,
      kind === "miles_pack" ? (t.miles ?? 5000) : null,
    ],
  );
  return Number(res.rows[0].id);
}

const list = (query: string, headers: Record<string, string> = staff) => request(server).get(`${LIST}${query}`).set(headers);
const q = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`;

async function addSubscription(principal: string, over: Partial<{ store: string; originalRef: string; productId: string; status: string; expiresAt: Date }> = {}) {
  await sql.query(
    `INSERT INTO store_subscriptions (store, original_ref, player_id, product_id, status, expires_at, last_event_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [
      over.store ?? "apple",
      over.originalRef ?? `sub-${randomUUID()}`,
      principal,
      over.productId ?? DEMO_PASS_MONTHLY,
      over.status ?? "active",
      over.expiresAt ?? new Date(Date.now() + 30 * DAY),
    ],
  );
}

describe("access", () => {
  it("401 without a token, 403 for a player and for an admin without a verified email, on both routes", async () => {
    const principal = await newPlayer();
    const unverified = `pd-unverified-${randomUUID()}`;
    extraAdmins.push(demoPrincipal(unverified));
    await seedRole(sql, demoPrincipal(unverified), "admin");
    const unverifiedHeaders = { Authorization: `Bearer ${emulatorToken(unverified, undefined, undefined, { emailVerified: false })}` };
    for (const url of [LIST, entitlementsUrl(principal)]) {
      expect((await request(server).get(url)).status, url).toBe(401);
      const asPlayer = await request(server).get(url).set(player);
      expect(asPlayer.status, url).toBe(403);
      expect(asPlayer.body.error.code).toBe("forbidden");
      expect((await request(server).get(url).set(unverifiedHeaders)).status, url).toBe(403);
    }
  });
});

describe("GET /v1/admin/store/purchases", () => {
  it("pages newest first with limit=1 and returns the exact id sequence", async () => {
    const principal = await newPlayer();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push(await addTx(principal));
    const expected = [...ids].sort((a, b) => b - a);

    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res: request.Response = await list(q({ player: principal, limit: "1", ...(cursor ? { cursor } : {}) }));
      expect(res.status).toBe(200);
      expect(res.body.purchases.length).toBeLessThanOrEqual(1);
      seen.push(...res.body.purchases.map((p: { id: number }) => p.id));
      cursor = res.body.nextCursor;
      if (cursor === null) break;
      expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
    }
    expect(seen).toEqual(expected);

    const all = await list(q({ player: principal }));
    expect(all.body.purchases.map((p: { id: number }) => p.id)).toEqual(expected);
    expect(all.body.nextCursor).toBeNull();
    const two = await list(q({ player: principal, limit: "2" }));
    expect(two.body.purchases.map((p: { id: number }) => p.id)).toEqual(expected.slice(0, 2));
    expect(two.body.nextCursor).not.toBeNull();
  });

  it("a row inserted after the first page does not shift the next page", async () => {
    const principal = await newPlayer();
    for (let i = 0; i < 3; i++) await addTx(principal);
    const first = await list(q({ player: principal, limit: "2" }));
    const late = await addTx(principal);
    const second = await list(q({ player: principal, limit: "2", cursor: first.body.nextCursor }));
    const ids = [...first.body.purchases, ...second.body.purchases].map((p: { id: number }) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(late);
    expect(ids).toHaveLength(3);
  });

  it("a cursor replayed under any other filter set is 400, and an edited cursor is 400", async () => {
    const principal = await newPlayer();
    for (let i = 0; i < 3; i++) await addTx(principal, { productId: DEMO_HINT_15, hints: 15 });
    const first = await list(q({ player: principal, productId: DEMO_HINT_15, limit: "1" }));
    expect(first.status).toBe(200);
    const cursor: string = first.body.nextCursor;
    expect(cursor).toBeTruthy();
    const ok = await list(q({ player: principal, productId: DEMO_HINT_15, limit: "1", cursor }));
    expect(ok.status).toBe(200);
    const other = await newPlayer();
    const replays: Record<string, string>[] = [
      {},
      { player: principal },
      { player: other, productId: DEMO_HINT_15 },
      { player: principal, productId: DEMO_HINT_5 },
      { player: principal, productId: DEMO_HINT_15, store: "apple" },
      { player: principal, productId: DEMO_HINT_15, transactionRef: "abc" },
      { player: principal, productId: DEMO_HINT_15, orderId: "abc" },
    ];
    for (const params of replays) {
      const res = await list(q({ ...params, limit: "1", cursor }));
      expect(res.status, JSON.stringify(params)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }

    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [tag, id, digest] = decoded.split(".") as [string, string, string];
    const forged = [
      Buffer.from(`${tag}.${Number(id) + 1}.${digest}`).toString("base64url"), // well-formed, canonical, but a different digest check still passes: same filters
      Buffer.from(`${tag}.${id}.${digest.slice(0, 21)}`).toString("base64url"), // short digest
      Buffer.from(`sp2.${id}.${digest}`).toString("base64url"),
      Buffer.from(`${tag}.0${id}.${digest}`).toString("base64url"), // leading zero
      `${cursor}=`, // padding: non-canonical spelling
      `${cursor}A`,
      "!!!",
      Buffer.from("m1.-.5").toString("base64url"),
    ];
    // The first forged cursor is a valid cursor under the same filters (any id is accepted); every other one must fail.
    expect((await list(q({ player: principal, productId: DEMO_HINT_15, limit: "1", cursor: forged[0]! }))).status).toBe(200);
    for (const bad of forged.slice(1)) {
      const res = await list(q({ player: principal, productId: DEMO_HINT_15, limit: "1", cursor: bad }));
      expect(res.status, bad).toBe(400);
    }
    // Fixed payload `sp1.1234.<22-char digest>` is 31 bytes, so its last base64url character carries 4 unused bits (always zero in the
    // canonical spelling). Setting one of them decodes to the same bytes but is a different spelling: refused.
    const fixed = Buffer.from(`sp1.1234.${digest}`).toString("base64url");
    expect(fixed).toHaveLength(42);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const bumped = fixed.slice(0, -1) + alphabet[alphabet.indexOf(fixed.slice(-1)) + 1]!;
    expect(Buffer.from(bumped, "base64url").toString("utf8")).toBe(`sp1.1234.${digest}`);
    expect((await list(q({ player: principal, productId: DEMO_HINT_15, limit: "1", cursor: fixed }))).status).toBe(200);
    expect((await list(q({ player: principal, productId: DEMO_HINT_15, limit: "1", cursor: bumped }))).status).toBe(400);
  });

  it("repeated keys, empty values, unknown keys and bad limits are 400", async () => {
    const principal = await newPlayer();
    const bad = [
      `?player=${encodeURIComponent(principal)}&player=${encodeURIComponent(principal)}`,
      "?productId=a&productId=b",
      "?limit=1&limit=2",
      "?store=apple&store=google",
      "?player=",
      "?productId=",
      "?store=",
      "?transactionRef=",
      "?orderId=",
      "?cursor=",
      "?limit=",
      "?bogus=1",
      "?player[x]=1",
      "?store=amazon",
      "?limit=0",
      "?limit=101",
      "?limit=-1",
      "?limit=1.5",
      "?limit=abc",
      "?limit=1000",
      "?productId=Bad.Id",
      "?transactionRef=has space",
      "?orderId=has%20space",
    ];
    for (const query of bad) {
      const res = await list(query);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code, query).toBe("invalid_request");
    }
    expect((await list("?limit=100")).status).toBe(200);
    expect((await list("?limit=1")).status).toBe(200);
  });

  it("another project's principal is 400; a well-formed unknown player or product is 200 and empty", async () => {
    const foreign = await list(q({ player: "firebase:some-other-project:abc" }));
    expect(foreign.status).toBe(400);
    expect((await list(q({ player: "not-a-principal" }))).status).toBe(400);
    const unknown = await list(q({ player: demoPrincipal(`nobody-${randomUUID()}`) }));
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ purchases: [], nextCursor: null });
    const unknownProduct = await list(q({ productId: `nosuch.product.${randomUUID().slice(0, 8)}` }));
    expect(unknownProduct.status).toBe(200);
    expect(unknownProduct.body).toEqual({ purchases: [], nextCursor: null });
  });

  it("exact lookup by transactionRef and by orderId, composable with store", async () => {
    const principal = await newPlayer();
    const ref = `lookup-${randomUUID()}`;
    const order = `GPA.${randomUUID().slice(0, 18)}`;
    const target = await addTx(principal, { store: "apple", ref });
    const googleTarget = await addTx(principal, { store: "google", ref: `gtoken-${randomUUID()}`, orderId: order });
    await addTx(principal);

    const byRef = await list(q({ transactionRef: ref }));
    expect(byRef.body.purchases.map((p: { id: number }) => p.id)).toEqual([target]);
    const byRefWrongStore = await list(q({ transactionRef: ref, store: "google" }));
    expect(byRefWrongStore.body.purchases).toEqual([]);
    const byOrder = await list(q({ orderId: order }));
    expect(byOrder.body.purchases.map((p: { id: number }) => p.id)).toEqual([googleTarget]);
    const partial = await list(q({ transactionRef: ref.slice(0, ref.length - 2) }));
    expect(partial.body.purchases).toEqual([]);
    const byStore = await list(q({ player: principal, store: "google" }));
    expect(byStore.body.purchases.map((p: { id: number }) => p.id)).toEqual([googleTarget]);
  });

  it("response shapes: Apple hint pack, Apple Pass, Google hint pack and Google Pass", async () => {
    const principal = await newPlayer();
    const appleRef = `apple-${randomUUID()}`;
    const appleOriginal = `apple-orig-${randomUUID()}`;
    const googleToken = `google-token-${randomUUID()}`;
    const googleOriginal = `google-orig-token-${randomUUID()}`;
    const until = new Date(Date.now() + 40 * DAY);
    await addTx(principal, { store: "apple", ref: appleRef, hints: 15, productId: DEMO_HINT_15 });
    await addTx(principal, { store: "apple", kind: "first_class_pass", productId: DEMO_PASS_YEARLY, originalRef: appleOriginal, until, environment: "production" });
    await addTx(principal, { store: "google", ref: googleToken, orderId: "GPA.1111-2222-3333-44444", hints: 5 });
    await addTx(principal, { store: "google", kind: "first_class_pass", ref: "GPA.9999-8888-7777-66666", orderId: "GPA.9999-8888-7777-66666", originalRef: googleOriginal, until });

    const res = await list(q({ player: principal }));
    expect(res.status).toBe(200);
    const [gPass, gPack, aPass, aPack] = res.body.purchases;
    expect(aPack).toEqual({
      id: expect.any(Number),
      store: "apple",
      principal,
      productId: DEMO_HINT_15,
      kind: "hint_pack",
      environment: "sandbox",
      transactionId: appleRef,
      originalTransactionId: null,
      orderId: null,
      tokenFingerprint: null,
      originalFingerprint: null,
      purchasedAt: expect.any(String),
      grant: { type: "hints", hints: 15 },
      createdAt: expect.any(String),
    });
    expect(aPass).toMatchObject({
      store: "apple",
      kind: "first_class_pass",
      environment: "production",
      transactionId: expect.any(String),
      originalTransactionId: appleOriginal,
      originalFingerprint: null,
      grant: { type: "first_class_pass", until: until.toISOString() },
    });
    expect(gPack).toMatchObject({
      store: "google",
      transactionId: null,
      originalTransactionId: null,
      orderId: "GPA.1111-2222-3333-44444",
      tokenFingerprint: fingerprint(googleToken),
      originalFingerprint: null,
      grant: { type: "hints", hints: 5 },
    });
    expect(gPass).toMatchObject({
      store: "google",
      transactionId: null,
      orderId: "GPA.9999-8888-7777-66666",
      tokenFingerprint: null,
      originalFingerprint: fingerprint(googleOriginal),
      grant: { type: "first_class_pass", until: until.toISOString() },
    });
    expect(fingerprint(googleToken)).toMatch(/^[0-9a-f]{12}$/);
    for (const p of res.body.purchases) {
      expect(Object.keys(p).sort()).toEqual(Object.keys(aPack).sort());
      expect(p).not.toHaveProperty("commerceToken");
      expect(p).not.toHaveProperty("playerId");
    }
  });

  it("a Miles pack row's grant is { type: miles, miles }; a Google Miles row has a token fingerprint and an Apple one does not", async () => {
    const principal = await newPlayer();
    const googleToken = `google-miles-token-${randomUUID()}`;
    const appleRef = `apple-miles-${randomUUID()}`;
    await addTx(principal, { store: "apple", kind: "miles_pack", ref: appleRef });
    await addTx(principal, { store: "google", kind: "miles_pack", ref: googleToken, productId: DEMO_MILES_25000, miles: 25000 });
    const res = await list(q({ player: principal }));
    expect(res.status).toBe(200);
    const [google, apple] = res.body.purchases;
    expect(apple).toMatchObject({
      store: "apple",
      kind: "miles_pack",
      productId: DEMO_MILES_5000,
      transactionId: appleRef,
      tokenFingerprint: null,
      originalFingerprint: null,
      grant: { type: "miles", miles: 5000 },
    });
    expect(google).toMatchObject({
      store: "google",
      kind: "miles_pack",
      productId: DEMO_MILES_25000,
      transactionId: null,
      tokenFingerprint: fingerprint(googleToken),
      originalFingerprint: null,
      grant: { type: "miles", miles: 25000 },
    });
    expect(JSON.stringify(res.body)).not.toContain(googleToken);
  });

  it("Google rows never contain the raw purchase token (or the original token) anywhere in the response", async () => {
    const principal = await newPlayer();
    const token = `rawtoken.${randomUUID()}`;
    const original = `raworiginal.${randomUUID()}`;
    await addTx(principal, { store: "google", ref: token });
    await addTx(principal, { store: "google", kind: "first_class_pass", ref: `order-${randomUUID()}`, originalRef: original });
    await addSubscription(principal, { store: "google", originalRef: original });
    const text = JSON.stringify((await list(q({ player: principal }))).body);
    expect(text).not.toContain(token);
    expect(text).not.toContain(original);
    expect(text).toContain(fingerprint(token));
    expect(text).toContain(fingerprint(original));
    // Looking a row up by its raw token works (exact transactionRef) but still never echoes it.
    const byToken = await list(q({ transactionRef: token }));
    expect(byToken.body.purchases).toHaveLength(1);
    expect(JSON.stringify(byToken.body)).not.toContain(token);
    const ent = JSON.stringify((await request(server).get(entitlementsUrl(principal)).set(staff)).body);
    expect(ent).not.toContain(original);
    expect(ent).toContain(fingerprint(original));
  });

  it("a deleted player's rows are absent, and no tombstone field appears anywhere", async () => {
    const principal = await newPlayer();
    const ref = `deleted-${randomUUID()}`;
    await addTx(principal, { ref });
    await sql.query("INSERT INTO store_claims (store, kind, ref) VALUES ('apple', 'transaction', $1) ON CONFLICT DO NOTHING", [ref]);
    try {
      expect((await list(q({ transactionRef: ref }))).body.purchases).toHaveLength(1);
      await sql.query("DELETE FROM players WHERE id = $1", [principal]);
      const after = await list(q({ transactionRef: ref }));
      expect(after.status).toBe(200);
      expect(after.body).toEqual({ purchases: [], nextCursor: null });
      const byPlayer = await list(q({ player: principal }));
      expect(byPlayer.body).toEqual({ purchases: [], nextCursor: null });
      expect(JSON.stringify(after.body).toLowerCase()).not.toContain("claim");
      expect((await request(server).get(entitlementsUrl(principal)).set(staff)).status).toBe(404);
    } finally {
      await sql.query("DELETE FROM store_claims WHERE store = 'apple' AND kind = 'transaction' AND ref = $1", [ref]);
    }
  });

  it("reading changes nothing: no version bump and no store account", async () => {
    const principal = await newPlayer();
    await addTx(principal);
    const before = await sql.query("SELECT version FROM players WHERE id = $1", [principal]);
    await list(q({ player: principal }));
    const after = await sql.query("SELECT version FROM players WHERE id = $1", [principal]);
    expect(after.rows[0].version).toBe(before.rows[0].version);
    expect((await sql.query("SELECT 1 FROM store_accounts WHERE player_id = $1", [principal])).rowCount).toBe(0);
  });
});

describe("GET /v1/admin/store/players/{principal}/entitlements", () => {
  it("404 player_not_found for an unknown player; 400 for a malformed or foreign principal and for any query", async () => {
    const unknown = await request(server).get(entitlementsUrl(demoPrincipal(`nobody-${randomUUID()}`))).set(staff);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("player_not_found");
    for (const bad of ["not-a-principal", "firebase:other-project:abc", `${demoPrincipal("a")}:b`]) {
      const res = await request(server).get(entitlementsUrl(bad)).set(staff);
      expect(res.status, bad).toBe(400);
    }
    const principal = await newPlayer();
    expect((await request(server).get(`${entitlementsUrl(principal)}?x=1`).set(staff)).status).toBe(400);
  });

  it("a player with no store account: hasStoreAccount false, no token row created, no commerceToken in the body", async () => {
    const principal = await newPlayer();
    const res = await request(server).get(entitlementsUrl(principal)).set(staff);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      principal,
      firstClassPass: false,
      firstClassUntil: null,
      productId: null,
      evaluatedAt: expect.any(String),
      hasStoreAccount: false,
      subscriptions: [],
    });
    expect(JSON.stringify(res.body)).not.toContain("commerceToken");
    expect((await sql.query("SELECT 1 FROM store_accounts WHERE player_id = $1", [principal])).rowCount).toBe(0);
    await request(server).get(entitlementsUrl(principal)).set(staff);
    expect((await sql.query("SELECT 1 FROM store_accounts WHERE player_id = $1", [principal])).rowCount).toBe(0);
  });

  it("hasStoreAccount is true once the player has read their own entitlements, and the token is still not returned", async () => {
    const uid = `pd-${randomUUID()}`;
    const principal = demoPrincipal(uid);
    created.push(principal);
    const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
    await request(server).put("/v1/me").set(auth);
    const own = await request(server).get("/v1/me/entitlements").set(auth);
    expect(own.status).toBe(200);
    const res = await request(server).get(entitlementsUrl(principal)).set(staff);
    expect(res.body.hasStoreAccount).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(own.body.commerceToken);
  });

  it("lists active and expired subscriptions (latest expiry first, then original ref) and reports the current Pass", async () => {
    const principal = await newPlayer();
    const future = new Date(Date.now() + 20 * DAY);
    const past = new Date(Date.now() - 20 * DAY);
    const u = randomUUID();
    await addSubscription(principal, { store: "apple", originalRef: `x-${u}`, productId: DEMO_PASS_YEARLY, status: "active", expiresAt: future });
    // Four rows with one expiry: the order is original ref, then store (the same ref under both stores is allowed by the key).
    await addSubscription(principal, { store: "apple", originalRef: `n-${u}`, status: "expired", expiresAt: past });
    await addSubscription(principal, { store: "google", originalRef: `m-${u}`, status: "revoked", expiresAt: past });
    await addSubscription(principal, { store: "apple", originalRef: `m-${u}`, status: "expired", expiresAt: past });
    await addSubscription(principal, { store: "google", originalRef: `a-${u}`, status: "revoked", expiresAt: past });
    await sql.query("UPDATE players SET first_class_until = $2 WHERE id = $1", [principal, future]);

    const res = await request(server).get(entitlementsUrl(principal)).set(staff);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      principal,
      firstClassPass: true,
      firstClassUntil: future.toISOString(),
      productId: DEMO_PASS_YEARLY,
      hasStoreAccount: false,
    });
    expect(res.body.subscriptions).toHaveLength(5);
    expect(res.body.subscriptions[0]).toEqual({
      store: "apple",
      originalTransactionId: `x-${u}`,
      originalFingerprint: null,
      productId: DEMO_PASS_YEARLY,
      status: "active",
      expiresAt: future.toISOString(),
      lastEventAt: expect.any(String),
      createdAt: expect.any(String),
    });
    const rest = res.body.subscriptions.slice(1) as { store: string; originalTransactionId: string | null; originalFingerprint: string | null }[];
    // Equal expiry: original ref ascending (raw stored value), then store ascending. Google rows show only the fingerprint.
    expect(rest.map((s) => [s.store, s.originalTransactionId ?? s.originalFingerprint])).toEqual([
      ["google", fingerprint(`a-${u}`)],
      ["apple", `m-${u}`],
      ["google", fingerprint(`m-${u}`)],
      ["apple", `n-${u}`],
    ]);
  });

  it("grace counts as the current Pass; a player whose only subscription expired has no Pass and no productId", async () => {
    const graceful = await newPlayer();
    const future = new Date(Date.now() + 5 * DAY);
    await addSubscription(graceful, { originalRef: `g-${randomUUID()}`, status: "grace", expiresAt: future, productId: DEMO_PASS_YEARLY });
    await sql.query("UPDATE players SET first_class_until = $2 WHERE id = $1", [graceful, future]);
    const g = await request(server).get(entitlementsUrl(graceful)).set(staff);
    expect(g.body).toMatchObject({ firstClassPass: true, productId: DEMO_PASS_YEARLY });
    expect(g.body.subscriptions[0].status).toBe("grace");

    const lapsed = await newPlayer();
    const past = new Date(Date.now() - 3 * DAY);
    await addSubscription(lapsed, { originalRef: `l-${randomUUID()}`, status: "expired", expiresAt: past });
    await sql.query("UPDATE players SET first_class_until = $2 WHERE id = $1", [lapsed, past]);
    const l = await request(server).get(entitlementsUrl(lapsed)).set(staff);
    expect(l.body).toMatchObject({ firstClassPass: false, firstClassUntil: past.toISOString(), productId: null });
    expect(l.body.subscriptions[0].status).toBe("expired");
  });

  it("database clock skew flips firstClassPass while firstClassUntil stays", async () => {
    const principal = await newPlayer();
    const until = new Date(Date.now() + 2 * DAY);
    await addSubscription(principal, { originalRef: `skew-${randomUUID()}`, expiresAt: until });
    await sql.query("UPDATE players SET first_class_until = $2 WHERE id = $1", [principal, until]);
    const now = await request(server).get(entitlementsUrl(principal)).set(staff);
    expect(now.body).toMatchObject({ firstClassPass: true, productId: DEMO_PASS_MONTHLY });

    setTestDatabaseClockSkew(3 * DAY);
    const later = await request(server).get(entitlementsUrl(principal)).set(staff);
    expect(later.body.firstClassPass).toBe(false);
    expect(later.body.firstClassUntil).toBe(until.toISOString());
    expect(later.body.productId).toBeNull();
    expect(Date.parse(later.body.evaluatedAt)).toBeGreaterThan(Date.parse(now.body.evaluatedAt) + 2 * DAY);
  });
});

describe("transactionRef lookup of a Google purchase token", () => {
  it("finds a stored one-time row by its raw token (colons, long), and never echoes the token", async () => {
    const principal = await newPlayer();
    const token = `${randomUUID()}:${"abcDEF012._~-".repeat(40)}`; // 520+ characters, contains ':'
    const id = await addTx(principal, { store: "google", ref: token });
    const found = await list(q({ transactionRef: token }));
    expect(found.status).toBe(200);
    expect(found.body.purchases.map((p: { id: number }) => p.id)).toEqual([id]);
    expect(JSON.stringify(found.body)).not.toContain(token);
    expect((await list(q({ transactionRef: "x".repeat(1025) }))).status).toBe(400);
  });
});

describe("fake-store references never reveal the commerce token", () => {
  let fakeApp: NestExpressApplication;
  let fakeServer: ReturnType<NestExpressApplication["getHttpServer"]>;

  beforeAll(async () => {
    const config = { ...loadConfig(process.env), storeVerifier: "fake" as const };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(APP_CONFIG).useValue(config).compile();
    fakeApp = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureApp(fakeApp);
    await fakeApp.listen(0, "127.0.0.1");
    fakeServer = fakeApp.getHttpServer();
  });
  afterAll(async () => {
    await fakeApp.close();
  });

  it("an Apple hint pack and an Apple Pass bought with the commerce token show the token in no spelling", async () => {
    const uid = `pd-fake-${randomUUID()}`;
    const principal = demoPrincipal(uid);
    created.push(principal);
    const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
    expect((await request(fakeServer).put("/v1/me").set(auth)).status).toBe(201);
    const own = await request(fakeServer).get("/v1/me/entitlements").set(auth);
    expect(own.status).toBe(200);
    const token: string = own.body.commerceToken;

    const sec = 1_000_000_000 + Math.floor(Math.random() * 900_000_000);
    const pack = fakeReference({ productId: DEMO_HINT_5, token, purchasedAtSec: sec });
    const pass = fakeReference({ productId: DEMO_PASS_MONTHLY, token, purchasedAtSec: sec, expiresAtSec: Math.floor(Date.now() / 1000) + 30 * 86_400 });
    for (const [productId, ref] of [
      [DEMO_HINT_5, pack],
      [DEMO_PASS_MONTHLY, pass],
    ] as const) {
      const bought = await request(fakeServer).post("/v1/purchases").set(auth).send({ store: "apple", productId, transactionId: ref });
      expect(bought.status, JSON.stringify(bought.body)).toBe(200);
      expect(bought.body.status).toBe("granted");
    }

    const listed = await request(fakeServer).get(`${LIST}${q({ player: principal })}`).set(staff);
    expect(listed.status).toBe(200);
    expect(listed.body.purchases).toHaveLength(2);
    const ent = await request(fakeServer).get(entitlementsUrl(principal)).set(staff);
    expect(ent.status).toBe(200);
    expect(ent.body.subscriptions).toHaveLength(1);
    const byRef = await request(fakeServer).get(`${LIST}${q({ transactionRef: pack })}`).set(staff);
    expect(byRef.body.purchases).toHaveLength(1);

    const spellings = [token, token.toUpperCase(), token.replace(/-/g, ""), token.replace(/-/g, "").toUpperCase()];
    for (const body of [listed.body, ent.body, byRef.body]) {
      const text = JSON.stringify(body);
      for (const spelling of spellings) expect(text.toLowerCase()).not.toContain(spelling.toLowerCase());
    }
    // The masked reference keeps its shape with the token segment replaced by the fingerprint.
    const packRow = listed.body.purchases.find((p: { kind: string }) => p.kind === "hint_pack");
    expect(packRow.transactionId).toBe(`fake~ok~${DEMO_HINT_5}~${fingerprint(token)}~${sec}`);
    const passRow = listed.body.purchases.find((p: { kind: string }) => p.kind === "first_class_pass");
    expect(passRow.originalTransactionId).toBe(`fake~${DEMO_PASS_MONTHLY}~${fingerprint(token)}`);
    expect(ent.body.subscriptions[0].originalTransactionId).toBe(`fake~${DEMO_PASS_MONTHLY}~${fingerprint(token)}`);
  });
});
