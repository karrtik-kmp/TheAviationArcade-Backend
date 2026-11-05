import { randomInt, randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { APP_CONFIG, loadConfig } from "../src/config/config.module.js";
import type { AppConfig } from "../src/config/config.module.js";
import { MIN_ROUND_MS } from "../src/rounds/rounds.service.js";
import { FakeStoreVerifier, fakeReference } from "../src/purchases/fake-store-verifier.js";
import { STORE_VERIFIER } from "../src/purchases/store-verifier.js";
import type { StoreVerifier } from "../src/purchases/store-verifier.js";
import { DEMO_HINT_15, DEMO_HINT_5, DEMO_MILES_25000, DEMO_MILES_5000, DEMO_PASS_MONTHLY, DEMO_PASS_YEARLY, seedDemoProducts, seedProduct } from "./store-helpers.js";
import { emulatorToken } from "./tokens.js";
import { factsFor, issueRound } from "./trip-helpers.js";

// Slice P-C: POST /v1/purchases and GET /v1/me/entitlements against the real Nest app and test database, with the fake store.
// docs/plans/purchases.md "Tests". The fake needs STORE_VERIFIER=fake, which the app config allows under APP_ENV=test.

const PREFIX = "firebase:demo-airplane-games:";
const DAY = 86_400;

let sql: pg.Pool;
let app: NestExpressApplication; // fake store
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let fake: FakeStoreVerifier;
const extraApps: NestExpressApplication[] = [];

async function buildApp(overrides: Partial<AppConfig>, verifier?: StoreVerifier) {
  const config = { ...loadConfig(process.env), ...overrides };
  let builder = Test.createTestingModule({ imports: [AppModule] }).overrideProvider(APP_CONFIG).useValue(config);
  if (verifier) builder = builder.overrideProvider(STORE_VERIFIER).useValue(verifier);
  const moduleRef = await builder.compile();
  const built = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(built);
  await built.listen(0, "127.0.0.1");
  return built;
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await seedDemoProducts(sql);
  app = await buildApp({ storeVerifier: "fake" });
  server = app.getHttpServer();
  fake = app.get(STORE_VERIFIER, { strict: false }) as FakeStoreVerifier;
});

afterAll(async () => {
  for (const extra of extraApps) await extra.close();
  await app.close();
  await sql.end();
});

type Srv = ReturnType<NestExpressApplication["getHttpServer"]>;

async function newPlayer(options: { create?: boolean; linked?: boolean; on?: Srv } = {}) {
  const on = options.on ?? server;
  const uid = `uid-${randomUUID()}`;
  const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
  const principal = `${PREFIX}${uid}`;
  if (options.create !== false) {
    const created = await request(on).put("/v1/me").set(auth);
    expect(created.status).toBe(201);
    if (options.linked) await sql.query("INSERT INTO ugs_links (player_id, ugs_player_id, linked_at) VALUES ($1, $2, now())", [principal, `ugs-${uid}`]);
  }
  return { uid, auth, principal };
}
type Player = Awaited<ReturnType<typeof newPlayer>>;

const nowSec = () => Math.floor(Date.now() / 1000);
/** A purchase time no other test uses, so a hint pack reference is unique across tests and runs. */
const uniqueSec = () => 1_000_000_000 + randomInt(900_000_000);

function body(store: "apple" | "google", productId: string, ref: string) {
  return store === "apple" ? { store, productId, transactionId: ref } : { store, productId, purchaseToken: ref };
}

async function buy(player: Player, store: "apple" | "google", productId: string, ref: string, on: Srv = server) {
  return request(on).post("/v1/purchases").set(player.auth).send(body(store, productId, ref));
}

async function token(player: Player, on: Srv = server): Promise<string> {
  const res = await request(on).get("/v1/me/entitlements").set(player.auth);
  expect(res.status).toBe(200);
  return res.body.commerceToken as string;
}

async function progress(player: Player) {
  const res = await request(server).get("/v1/me/progress").set(player.auth);
  expect(res.status).toBe(200);
  return res.body.progress as { version: number; hints: number; firstClassPass: boolean };
}

const count = async (query: string, params: unknown[]) => (await sql.query(query, params)).rows[0].n as number;
const txCount = (ref: string) => count("SELECT count(*)::int AS n FROM store_transactions WHERE transaction_ref = $1", [ref]);
const playerTxCount = (principal: string) => count("SELECT count(*)::int AS n FROM store_transactions WHERE player_id = $1", [principal]);
const hintRows = (principal: string) => count("SELECT count(*)::int AS n FROM hint_ledger WHERE player_id = $1 AND kind = 'store_purchase'", [principal]);
const playerRow = async (principal: string) => (await sql.query("SELECT * FROM players WHERE id = $1", [principal])).rows[0];

const milesRows = (principal: string) => count("SELECT count(*)::int AS n FROM miles_ledger WHERE player_id = $1 AND kind = 'store_purchase'", [principal]);

/** A fresh catalog product, so subscription chains and references of one test never meet another test's. */
async function newProduct(kind: "hint_pack" | "miles_pack" | "first_class_pass", options: { demo?: boolean; status?: "active" | "retired" } = {}) {
  const label = kind === "hint_pack" ? "hints" : kind === "miles_pack" ? "miles" : "pass";
  const productId = `test.${label}.${randomUUID().replaceAll("-", "")}`;
  await seedProduct(sql, {
    productId,
    kind,
    ...(kind === "hint_pack" ? { hints: 7 } : kind === "miles_pack" ? { miles: 1234 } : { passPeriod: "P1M" as const }),
    ...options,
  });
  return productId;
}

describe("GET /v1/me/entitlements", () => {
  it("404 player_not_found before PUT /v1/me", async () => {
    const stranger = await newPlayer({ create: false });
    const res = await request(server).get("/v1/me/entitlements").set(stranger.auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("player_not_found");
  });

  it("creates the token on the first read and returns the same one afterwards; no Pass yet", async () => {
    const player = await newPlayer();
    const first = await request(server).get("/v1/me/entitlements").set(player.auth);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      commerceToken: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      firstClassPass: false,
      firstClassUntil: null,
      productId: null,
      evaluatedAt: expect.any(String),
    });
    expect(first.headers["cache-control"]).toContain("no-store");
    expect(await token(player)).toBe(first.body.commerceToken);
    expect(first.body.commerceToken).not.toContain(player.uid);
  });

  it("is a read: it does not bump the progress version", async () => {
    const player = await newPlayer();
    const before = (await progress(player)).version;
    await token(player);
    expect((await progress(player)).version).toBe(before);
  });

  it("concurrent first reads create exactly one token", async () => {
    const player = await newPlayer();
    const replies = await Promise.all(Array.from({ length: 6 }, () => request(server).get("/v1/me/entitlements").set(player.auth)));
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(new Set(replies.map((r) => r.body.commerceToken)).size).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM store_accounts WHERE player_id = $1", [player.principal])).toBe(1);
  });

  it("two players never share a token", async () => {
    const [a, b] = [await newPlayer(), await newPlayer()];
    expect(await token(a)).not.toBe(await token(b));
  });
});

describe("POST /v1/purchases: request shape", () => {
  it("404 player_not_found before PUT /v1/me", async () => {
    const stranger = await newPlayer({ create: false });
    const res = await buy(stranger, "apple", DEMO_HINT_5, fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() }));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("player_not_found");
  });

  it("is strict: unknown keys, the other store's field, bad patterns and missing fields are 400", async () => {
    const player = await newPlayer();
    const ref = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    for (const bad of [
      { store: "apple", productId: DEMO_HINT_5, transactionId: ref, extra: 1 },
      { store: "apple", productId: DEMO_HINT_5, purchaseToken: ref },
      { store: "google", productId: DEMO_HINT_5, transactionId: ref },
      { store: "apple", productId: DEMO_HINT_5, transactionId: "has space" },
      { store: "apple", productId: DEMO_HINT_5, transactionId: "x".repeat(257) },
      { store: "google", productId: DEMO_HINT_5, purchaseToken: "" },
      { store: "google", productId: DEMO_HINT_5, purchaseToken: "bad/char" },
      { store: "google", productId: DEMO_HINT_5, purchaseToken: "x".repeat(1025) },
      { store: "apple", productId: "Not A Product", transactionId: ref },
      { store: "apple", transactionId: ref },
      { store: "windows", productId: DEMO_HINT_5, transactionId: ref },
      {},
    ]) {
      const res = await request(server).post("/v1/purchases").set(player.auth).send(bad);
      expect(res.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    // The longest accepted Google token passes the schema (the fake store then calls it malformed).
    const longest = await request(server).post("/v1/purchases").set(player.auth).send(body("google", DEMO_HINT_5, "x".repeat(1024)));
    expect(longest.status).toBe(422);
    // A jws over its 16 KB schema limit never reaches the grant: the app-wide 16 KB JSON body limit (413) answers first.
    const huge = await request(server).post("/v1/purchases").set(player.auth).send({ ...body("apple", DEMO_HINT_5, ref), jws: "j".repeat(16385) });
    expect([400, 413]).toContain(huge.status);
    expect(await playerTxCount(player.principal)).toBe(0);
  });

  it("accepts an optional jws and ignores any Idempotency-Key header", async () => {
    const player = await newPlayer();
    const ref = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    const first = await request(server).post("/v1/purchases").set(player.auth).set("Idempotency-Key", "same-key").send({ ...body("apple", DEMO_HINT_5, ref), jws: "eyJ.x.y" });
    expect(first.status).toBe(200);
    // A different key does not make it a new purchase, and a malformed key is not rejected either.
    const second = await request(server).post("/v1/purchases").set(player.auth).set("Idempotency-Key", "another key!").send(body("apple", DEMO_HINT_5, ref));
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
  });
});

describe("POST /v1/purchases: hint packs", () => {
  it("grants the catalog's hints, snapshots the grant, bumps the version once and writes one ledger row", async () => {
    const player = await newPlayer({ linked: true });
    const before = await progress(player);
    const ref = fakeReference({ productId: DEMO_HINT_15, purchasedAtSec: uniqueSec() });
    const res = await buy(player, "apple", DEMO_HINT_15, ref);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body).toMatchObject({
      status: "granted",
      replayed: false,
      storePurchase: { store: "apple", productId: DEMO_HINT_15, kind: "hint_pack", environment: "fake", grantedHints: 15, grantedUntil: null },
      progress: { hints: before.hints + 15, version: before.version + 1 },
    });
    expect(res.body.storePurchase.purchasedAt).toMatch(/Z$/);
    const stored = await playerRow(player.principal);
    expect(stored.hints).toBe(before.hints + 15);
    expect(stored.version).toBe(before.version + 1);
    const ledger = (await sql.query("SELECT delta, ref FROM hint_ledger WHERE player_id = $1 AND kind = 'store_purchase'", [player.principal])).rows;
    expect(ledger).toEqual([{ delta: 15, ref: `apple:${ref}` }]);
    const sum = (await sql.query("SELECT COALESCE(SUM(delta), 0)::int AS s FROM hint_ledger WHERE player_id = $1", [player.principal])).rows[0].s;
    expect(sum).toBe(stored.hints);
    // The Cloud Save mirror is queued at the new version.
    const queued = (await sql.query("SELECT version FROM ugs_mirror_outbox WHERE player_id = $1", [player.principal])).rows;
    expect(queued).toEqual([{ version: before.version + 1 }]);
  });

  it("a Google hint pack grants and is acknowledged; an Apple one is not", async () => {
    const player = await newPlayer();
    const googleRef = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    const appleRef = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    expect((await buy(player, "google", DEMO_HINT_5, googleRef)).status).toBe(200);
    expect((await buy(player, "apple", DEMO_HINT_5, appleRef)).status).toBe(200);
    expect(fake.acknowledged).toContain(googleRef);
    expect(fake.acknowledged).not.toContain(appleRef);
    // The same reference on the other store is a different transaction: the key is (store, reference).
    const cross = await buy(player, "apple", DEMO_HINT_5, googleRef);
    expect(cross.body).toMatchObject({ status: "granted", replayed: false });
  });

  it("a replay is 200 granted with replayed true, the recorded grant, no new hints and no version bump", async () => {
    const player = await newPlayer({ linked: true });
    const ref = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    const first = await buy(player, "apple", DEMO_HINT_5, ref);
    await sql.query("DELETE FROM ugs_mirror_outbox WHERE player_id = $1", [player.principal]);
    const replay = await buy(player, "apple", DEMO_HINT_5, ref);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: "granted", replayed: true, storePurchase: first.body.storePurchase });
    expect(replay.body.progress.hints).toBe(first.body.progress.hints);
    expect(replay.body.progress.version).toBe(first.body.progress.version);
    expect((await playerRow(player.principal)).version).toBe(first.body.progress.version);
    expect(await hintRows(player.principal)).toBe(1);
    expect(await txCount(ref)).toBe(1);
    // No change, so nothing is queued for the mirror either.
    expect((await sql.query("SELECT 1 FROM ugs_mirror_outbox WHERE player_id = $1", [player.principal])).rowCount).toBe(0);
  });

  it("a replay is acknowledged again for Google", async () => {
    const player = await newPlayer();
    const ref = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    await buy(player, "google", DEMO_HINT_5, ref);
    fake.acknowledged.length = 0;
    const replay = await buy(player, "google", DEMO_HINT_5, ref);
    expect(replay.body.replayed).toBe(true);
    expect(fake.acknowledged).toEqual([ref]);
  });

  it("the grant snapshot survives a catalog edit", async () => {
    const player = await newPlayer();
    const productId = await newProduct("hint_pack");
    const ref = fakeReference({ productId, purchasedAtSec: uniqueSec() });
    expect((await buy(player, "apple", productId, ref)).body.storePurchase.grantedHints).toBe(7);
    await sql.query("UPDATE store_products SET hints = 99, version = version + 1 WHERE product_id = $1", [productId]);
    const replay = await buy(player, "apple", productId, ref);
    expect(replay.body).toMatchObject({ replayed: true, storePurchase: { grantedHints: 7 } });
    const next = await buy(player, "apple", productId, fakeReference({ productId, purchasedAtSec: uniqueSec() }));
    expect(next.body.storePurchase.grantedHints).toBe(99);
  });

  it("the same reference sent concurrently by one player grants once", async () => {
    const player = await newPlayer();
    const before = await progress(player);
    const ref = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    const replies = await Promise.all(Array.from({ length: 5 }, () => buy(player, "apple", DEMO_HINT_5, ref)));
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(replies.filter((r) => r.body.replayed === false)).toHaveLength(1);
    expect(replies.filter((r) => r.body.replayed === true)).toHaveLength(4);
    expect(await txCount(ref)).toBe(1);
    expect(await hintRows(player.principal)).toBe(1);
    expect(await progress(player)).toMatchObject({ hints: before.hints + 5, version: before.version + 1 });
  });

  it("two players racing one reference: one grant, one 409 purchase_owned_by_other, nothing else changes", async () => {
    const [a, b] = [await newPlayer(), await newPlayer()];
    const beforeA = await progress(a);
    const beforeB = await progress(b);
    const ref = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    const replies = await Promise.all([buy(a, "apple", DEMO_HINT_5, ref), buy(b, "apple", DEMO_HINT_5, ref)]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    const [winner, loser] = replies[0]!.status === 200 ? [a, b] : [b, a];
    const lost = replies[0]!.status === 200 ? replies[1]! : replies[0]!;
    expect(lost.body.error.code).toBe("purchase_owned_by_other");
    expect(await txCount(ref)).toBe(1);
    expect((await sql.query("SELECT player_id FROM store_transactions WHERE transaction_ref = $1", [ref])).rows[0].player_id).toBe(winner.principal);
    const after = { a: await progress(a), b: await progress(b) };
    const [winnerBefore, winnerAfter] = winner === a ? [beforeA, after.a] : [beforeB, after.b];
    const [loserBefore, loserAfter] = loser === a ? [beforeA, after.a] : [beforeB, after.b];
    expect(winnerAfter).toMatchObject({ hints: winnerBefore.hints + 5, version: winnerBefore.version + 1 });
    expect(loserAfter).toMatchObject({ hints: loserBefore.hints, version: loserBefore.version });
    expect(await hintRows(loser.principal)).toBe(0);
  });
});

describe("POST /v1/purchases: Miles packs", () => {
  const MILES_ROWS = "SELECT delta, ref FROM miles_ledger WHERE player_id = $1 AND kind = 'store_purchase'";

  it("grants the catalog's Miles exactly once: one ledger row, one version bump, grantedMiles in the response", async () => {
    const player = await newPlayer({ linked: true });
    const before = await progress(player);
    const beforeRow = await playerRow(player.principal);
    const ref = fakeReference({ productId: DEMO_MILES_5000, purchasedAtSec: uniqueSec() });
    const res = await buy(player, "apple", DEMO_MILES_5000, ref);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "granted",
      replayed: false,
      storePurchase: { store: "apple", productId: DEMO_MILES_5000, kind: "miles_pack", environment: "fake", grantedHints: null, grantedMiles: 5000, grantedUntil: null },
      progress: { version: before.version + 1, hints: before.hints },
    });
    const stored = await playerRow(player.principal);
    expect(stored.miles).toBe(beforeRow.miles + 5000);
    expect(stored.hints).toBe(beforeRow.hints);
    expect(stored.version).toBe(before.version + 1);
    expect((await sql.query(MILES_ROWS, [player.principal])).rows).toEqual([{ delta: 5000, ref: `apple:${ref}` }]);
    expect(await hintRows(player.principal)).toBe(0);
    const sum = (await sql.query("SELECT COALESCE(SUM(delta), 0)::int AS s FROM miles_ledger WHERE player_id = $1", [player.principal])).rows[0].s;
    expect(sum).toBe(stored.miles);
    expect((await sql.query("SELECT granted_miles, granted_hints FROM store_transactions WHERE transaction_ref = $1", [ref])).rows).toEqual([
      { granted_miles: 5000, granted_hints: null },
    ]);
    expect((await sql.query("SELECT version FROM ugs_mirror_outbox WHERE player_id = $1", [player.principal])).rows).toEqual([{ version: before.version + 1 }]);
  });

  it("a Google Miles pack grants and is acknowledged; the larger demo pack grants 25,000", async () => {
    const player = await newPlayer();
    const ref = fakeReference({ productId: DEMO_MILES_25000, purchasedAtSec: uniqueSec() });
    const res = await buy(player, "google", DEMO_MILES_25000, ref);
    expect(res.body).toMatchObject({ status: "granted", storePurchase: { grantedMiles: 25000 } });
    expect(fake.acknowledged).toContain(ref);
    expect((await playerRow(player.principal)).miles).toBe(25000);
  });

  it("a replay is 200 replayed true with the recorded grant, no new ledger row and no version bump", async () => {
    const player = await newPlayer({ linked: true });
    const ref = fakeReference({ productId: DEMO_MILES_5000, purchasedAtSec: uniqueSec() });
    const first = await buy(player, "apple", DEMO_MILES_5000, ref);
    await sql.query("DELETE FROM ugs_mirror_outbox WHERE player_id = $1", [player.principal]);
    const replay = await buy(player, "apple", DEMO_MILES_5000, ref);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: "granted", replayed: true, storePurchase: first.body.storePurchase });
    expect(replay.body.progress.version).toBe(first.body.progress.version);
    const stored = await playerRow(player.principal);
    expect(stored.version).toBe(first.body.progress.version);
    expect(stored.miles).toBe(5000);
    expect(await milesRows(player.principal)).toBe(1);
    expect(await txCount(ref)).toBe(1);
    expect((await sql.query("SELECT 1 FROM ugs_mirror_outbox WHERE player_id = $1", [player.principal])).rowCount).toBe(0);
  });

  it("another player gets 409 purchase_owned_by_other and nothing is written for them", async () => {
    const [owner, other] = [await newPlayer(), await newPlayer()];
    const ref = fakeReference({ productId: DEMO_MILES_5000, purchasedAtSec: uniqueSec() });
    expect((await buy(owner, "apple", DEMO_MILES_5000, ref)).status).toBe(200);
    const late = await buy(other, "apple", DEMO_MILES_5000, ref);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("purchase_owned_by_other");
    expect((await playerRow(other.principal)).miles).toBe(0);
    expect(await milesRows(other.principal)).toBe(0);
  });

  it("a deleted owner's receipt is remembered: the same reference is 409 for the re-created account and grants no Miles", async () => {
    const owner = await newPlayer();
    const ref = fakeReference({ productId: DEMO_MILES_5000, purchasedAtSec: uniqueSec() });
    expect((await buy(owner, "apple", DEMO_MILES_5000, ref)).status).toBe(200);
    expect((await request(server).delete("/v1/me").set(owner.auth)).status).toBe(204);
    expect(await txCount(ref)).toBe(0);
    expect((await request(server).put("/v1/me").set(owner.auth)).status).toBe(201);
    const again = await buy(owner, "apple", DEMO_MILES_5000, ref);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("purchase_owned_by_other");
    expect((await playerRow(owner.principal)).miles).toBe(0);
    expect(await milesRows(owner.principal)).toBe(0);
    expect(await txCount(ref)).toBe(0);
  });

  it("the grant snapshot survives a catalog edit of miles", async () => {
    const player = await newPlayer();
    const productId = await newProduct("miles_pack");
    const ref = fakeReference({ productId, purchasedAtSec: uniqueSec() });
    expect((await buy(player, "apple", productId, ref)).body.storePurchase.grantedMiles).toBe(1234);
    await sql.query("UPDATE store_products SET miles = 9999, version = version + 1 WHERE product_id = $1", [productId]);
    const replay = await buy(player, "apple", productId, ref);
    expect(replay.body).toMatchObject({ replayed: true, storePurchase: { grantedMiles: 1234 } });
    expect((await sql.query("SELECT granted_miles FROM store_transactions WHERE transaction_ref = $1", [ref])).rows[0].granted_miles).toBe(1234);
    const next = await buy(player, "apple", productId, fakeReference({ productId, purchasedAtSec: uniqueSec() }));
    expect(next.body.storePurchase.grantedMiles).toBe(9999);
    expect((await playerRow(player.principal)).miles).toBe(1234 + 9999);
  });

  it("a Miles pack whose store transaction has an expiry is a catalog mistake: 200 pending, nothing written, logged as an error", async () => {
    const player = await newPlayer();
    const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const ref = fakeReference({ productId: DEMO_MILES_5000, purchasedAtSec: nowSec(), expiresAtSec: nowSec() + 30 * DAY });
      const res = await buy(player, "apple", DEMO_MILES_5000, ref);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "pending", storePurchase: null });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(DEMO_MILES_5000));
      expect(await txCount(ref)).toBe(0);
      expect(await count("SELECT count(*)::int AS n FROM store_claims WHERE ref = $1", [ref])).toBe(0);
    } finally {
      logged.mockRestore();
    }
    expect(await playerTxCount(player.principal)).toBe(0);
    expect(await milesRows(player.principal)).toBe(0);
    expect((await playerRow(player.principal)).miles).toBe(0);
  });

  it("a hint pack whose store transaction has an expiry is the same catalog mistake: pending, nothing written", async () => {
    const player = await newPlayer();
    const before = await progress(player);
    const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const ref = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: nowSec(), expiresAtSec: nowSec() + 30 * DAY });
      const res = await buy(player, "apple", DEMO_HINT_5, ref);
      expect(res.body).toMatchObject({ status: "pending", storePurchase: null });
      expect(await txCount(ref)).toBe(0);
    } finally {
      logged.mockRestore();
    }
    expect(await progress(player)).toMatchObject({ hints: before.hints, version: before.version });
  });

  it("ASSUMPTION: a First Class Pass holder gets exactly the pack's Miles, with no +50% on bought Miles", async () => {
    const player = await newPlayer();
    const t = await token(player);
    const start = nowSec();
    const passRef = fakeReference({ productId: DEMO_PASS_MONTHLY, token: t, purchasedAtSec: start, expiresAtSec: start + 30 * DAY });
    expect((await buy(player, "apple", DEMO_PASS_MONTHLY, passRef)).body.progress.firstClassPass).toBe(true);
    const beforeMiles = (await playerRow(player.principal)).miles;
    const res = await buy(player, "apple", DEMO_MILES_5000, fakeReference({ productId: DEMO_MILES_5000, token: t, purchasedAtSec: uniqueSec() }));
    expect(res.body).toMatchObject({ status: "granted", storePurchase: { grantedMiles: 5000 }, progress: { firstClassPass: true } });
    expect((await playerRow(player.principal)).miles).toBe(beforeMiles + 5000);
    expect((await sql.query(MILES_ROWS, [player.principal])).rows.map((r) => r.delta)).toEqual([5000]);
  });

  it("ASSUMPTION: bought Miles touch Miles only: Status Points, ranks, counters (miles_earned) and Field Awards are unchanged", async () => {
    const player = await newPlayer();
    // Play one Round first so Status Points, Miles and the counters are non-trivial.
    const issued = await issueRound(server, player.auth);
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    await sql.query("UPDATE rounds SET issued_at = issued_at - ($1::int * interval '1 millisecond') WHERE player_id = $2 AND status = 'open'", [MIN_ROUND_MS * 2, player.principal]);
    const played = await request(server)
      .post(`/v1/rounds/${issued.body.round.roundId}/result`)
      .set(player.auth)
      .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9, ...factsFor("atc-match") });
    expect(played.status, JSON.stringify(played.body)).toBe(200);

    const snapshot = async () => ({
      player: (({ status_points, active_rank, perfect_streak, hints }) => ({ status_points, active_rank, perfect_streak, hints }))(await playerRow(player.principal)),
      counters: (await sql.query("SELECT * FROM player_counters WHERE player_id = $1", [player.principal])).rows,
      awards: (await sql.query("SELECT award_id FROM player_field_awards WHERE player_id = $1 ORDER BY award_id", [player.principal])).rows,
      progress: await request(server).get("/v1/me/progress").set(player.auth).then((r) => ({ ...r.body.progress, miles: undefined, version: undefined, evaluatedAt: undefined })),
    });
    const before = await snapshot();
    const milesBefore = (await playerRow(player.principal)).miles;
    expect(before.player.status_points).toBeGreaterThan(0);

    const res = await buy(player, "apple", DEMO_MILES_25000, fakeReference({ productId: DEMO_MILES_25000, purchasedAtSec: uniqueSec() }));
    expect(res.body.status).toBe("granted");
    expect((await playerRow(player.principal)).miles).toBe(milesBefore + 25000);
    expect(await snapshot()).toEqual(before);
  });

  it("Miles near the int4 limit: the grant is a 500, and no transaction row, tombstone, ledger row or balance change is left behind", async () => {
    const player = await newPlayer();
    await sql.query("UPDATE players SET miles = 2147483000 WHERE id = $1", [player.principal]);
    const before = await playerRow(player.principal);
    const ref = fakeReference({ productId: DEMO_MILES_5000, purchasedAtSec: uniqueSec() });
    const res = await buy(player, "apple", DEMO_MILES_5000, ref);
    expect(res.status).toBe(500);
    expect(await txCount(ref)).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM store_claims WHERE ref = $1", [ref])).toBe(0);
    expect(await milesRows(player.principal)).toBe(0);
    const after = await playerRow(player.principal);
    expect(after.miles).toBe(2147483000);
    expect(after.version).toBe(before.version);
  });
});

describe("POST /v1/purchases: ownership by account token", () => {
  it("a token that is not the caller's is 409 and writes nothing; the buyer's own token (any spelling) grants", async () => {
    const [buyer, other] = [await newPlayer(), await newPlayer()];
    const buyerToken = await token(buyer);
    await token(other);
    const ref = fakeReference({ productId: DEMO_HINT_5, token: buyerToken, purchasedAtSec: uniqueSec() });

    const refused = await buy(other, "apple", DEMO_HINT_5, ref);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("purchase_owned_by_other");
    expect(await txCount(ref)).toBe(0);

    expect((await buy(buyer, "apple", DEMO_HINT_5, ref)).body).toMatchObject({ status: "granted", replayed: false });
    // Google carries the token as 32 hex digits, Apple's uppercase: all spellings are the same token.
    const hex = fakeReference({ productId: DEMO_HINT_5, token: buyerToken.replaceAll("-", ""), purchasedAtSec: uniqueSec() });
    const upper = fakeReference({ productId: DEMO_HINT_5, token: buyerToken.toUpperCase(), purchasedAtSec: uniqueSec() });
    expect((await buy(buyer, "google", DEMO_HINT_5, hex)).status).toBe(200);
    expect((await buy(buyer, "apple", DEMO_HINT_5, upper)).status).toBe(200);
  });

  it("a tokened purchase from a player who never asked for a token is 409", async () => {
    const [buyer, tokenless] = [await newPlayer(), await newPlayer()];
    const ref = fakeReference({ productId: DEMO_HINT_5, token: await token(buyer), purchasedAtSec: uniqueSec() });
    expect((await buy(tokenless, "apple", DEMO_HINT_5, ref)).status).toBe(409);
    expect(await playerTxCount(tokenless.principal)).toBe(0);
  });

  it("a purchase with no account token belongs to the first verified caller; a second player gets 409", async () => {
    const [first, second] = [await newPlayer(), await newPlayer()];
    const ref = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    expect((await buy(first, "apple", DEMO_HINT_5, ref)).status).toBe(200);
    const late = await buy(second, "apple", DEMO_HINT_5, ref);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("purchase_owned_by_other");
    // The owner, set once, still replays it.
    expect((await buy(first, "apple", DEMO_HINT_5, ref)).body.replayed).toBe(true);
  });

  it("account deletion is final: a re-created account has a new token and the old receipt answers 409", async () => {
    const player = await newPlayer();
    const oldToken = await token(player);
    const ref = fakeReference({ productId: DEMO_HINT_5, token: oldToken, purchasedAtSec: uniqueSec() });
    const passProduct = await newProduct("first_class_pass");
    const passRef = fakeReference({ productId: passProduct, token: oldToken, purchasedAtSec: nowSec(), expiresAtSec: nowSec() + 30 * DAY });
    expect((await buy(player, "apple", DEMO_HINT_5, ref)).status).toBe(200);
    expect((await buy(player, "apple", passProduct, passRef)).status).toBe(200);

    expect((await request(server).delete("/v1/me").set(player.auth)).status).toBe(204);
    for (const table of ["store_accounts", "store_transactions", "store_subscriptions"]) {
      expect(await count(`SELECT count(*)::int AS n FROM ${table} WHERE player_id = $1`, [player.principal]), table).toBe(0);
    }

    expect((await request(server).put("/v1/me").set(player.auth)).status).toBe(201);
    const newToken = await token(player);
    expect(newToken).not.toBe(oldToken);
    const old = await buy(player, "apple", DEMO_HINT_5, ref);
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe("purchase_owned_by_other");
    expect((await buy(player, "apple", passProduct, passRef)).status).toBe(409);
    expect((await progress(player)).firstClassPass).toBe(false);
  });

  it("a tokenless hint pack is remembered: after deletion the same player, and any other player, get 409 and no hints", async () => {
    const [owner, other] = [await newPlayer(), await newPlayer()];
    const ref = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    expect((await buy(owner, "apple", DEMO_HINT_5, ref)).status).toBe(200);
    const claim = (kind: string, value: string) =>
      count("SELECT count(*)::int AS n FROM store_claims WHERE store = 'apple' AND kind = $1 AND ref = $2", [kind, value]);
    expect(await claim("transaction", ref)).toBe(1);

    expect((await request(server).delete("/v1/me").set(owner.auth)).status).toBe(204);
    expect(await txCount(ref)).toBe(0);
    expect(await claim("transaction", ref)).toBe(1); // the tombstone outlives the account

    expect((await request(server).put("/v1/me").set(owner.auth)).status).toBe(201);
    const before = await progress(owner);
    const again = await buy(owner, "apple", DEMO_HINT_5, ref);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("purchase_owned_by_other");
    expect(await progress(owner)).toMatchObject({ hints: before.hints, version: before.version });
    expect(await hintRows(owner.principal)).toBe(0);
    expect(await txCount(ref)).toBe(0); // the row was rolled back

    const late = await buy(other, "apple", DEMO_HINT_5, ref);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("purchase_owned_by_other");
    expect(await hintRows(other.principal)).toBe(0);
  });

  it("a tokenless Pass chain is remembered after its owner is deleted: a renewal or the first receipt is 409 for anyone", async () => {
    const [owner, other] = [await newPlayer(), await newPlayer()];
    const productId = await newProduct("first_class_pass");
    const start = nowSec();
    const first = fakeReference({ productId, purchasedAtSec: start, expiresAtSec: start + 30 * DAY });
    const renewal = fakeReference({ productId, purchasedAtSec: start + 30 * DAY, expiresAtSec: start + 60 * DAY });
    expect((await buy(owner, "apple", productId, first)).status).toBe(200);
    expect((await request(server).delete("/v1/me").set(owner.auth)).status).toBe(204);
    expect(await count("SELECT count(*)::int AS n FROM store_subscriptions WHERE product_id = $1", [productId])).toBe(0);

    // The renewal is a new transaction reference but an old chain: the chain tombstone refuses it. The first receipt is refused
    // by its transaction tombstone.
    for (const ref of [renewal, first]) {
      const refused = await buy(other, "apple", productId, ref);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("purchase_owned_by_other");
      expect(await txCount(ref)).toBe(0);
    }
    expect(await count("SELECT count(*)::int AS n FROM store_subscriptions WHERE product_id = $1", [productId])).toBe(0);
    expect((await playerRow(other.principal)).first_class_until).toBeNull();
    expect((await progress(other)).firstClassPass).toBe(false);
  });

  it("a renewal of the caller's live chain keeps one chain tombstone and adds one per transaction", async () => {
    const player = await newPlayer();
    const productId = await newProduct("first_class_pass");
    const start = nowSec();
    const chain = `fake~${productId}~none`;
    const first = fakeReference({ productId, purchasedAtSec: start, expiresAtSec: start + 30 * DAY });
    const renewal = fakeReference({ productId, purchasedAtSec: start + 30 * DAY, expiresAtSec: start + 60 * DAY });
    expect((await buy(player, "apple", productId, first)).status).toBe(200);
    expect((await buy(player, "apple", productId, renewal)).body).toMatchObject({ status: "granted", replayed: false });
    expect(await count("SELECT count(*)::int AS n FROM store_claims WHERE kind = 'subscription' AND ref = $1", [chain])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM store_claims WHERE kind = 'transaction' AND ref = ANY($1)", [[first, renewal]])).toBe(2);
    expect((await buy(player, "apple", productId, renewal)).body.replayed).toBe(true);
  });
});

describe("POST /v1/purchases: what the store says", () => {
  it("invalid, malformed and a productId that differs from the store's are 422 purchase_invalid and write nothing", async () => {
    const player = await newPlayer();
    const before = await progress(player);
    const good = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    for (const attempt of [
      buy(player, "apple", DEMO_HINT_5, fakeReference({ outcome: "invalid", productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() })),
      buy(player, "google", DEMO_HINT_5, "not-a-fake-reference"),
      buy(player, "apple", DEMO_HINT_15, good), // the store's reference is for aa.hints.5
      buy(player, "google", DEMO_HINT_15, good),
    ]) {
      const res = await attempt;
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("purchase_invalid");
    }
    expect(await txCount(good)).toBe(0);
    expect(await progress(player)).toMatchObject({ hints: before.hints, version: before.version });
  });

  it("a Pass product whose store transaction has no expiry is a catalog mistake: 200 pending, nothing written, logged as an error", async () => {
    const player = await newPlayer();
    const before = await progress(player);
    const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const ref = fakeReference({ productId: DEMO_PASS_MONTHLY, purchasedAtSec: uniqueSec() });
      const res = await buy(player, "apple", DEMO_PASS_MONTHLY, ref);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "pending", storePurchase: null });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(DEMO_PASS_MONTHLY));
      expect(await txCount(ref)).toBe(0);
      expect(await count("SELECT count(*)::int AS n FROM store_claims WHERE ref = $1", [ref])).toBe(0);
    } finally {
      logged.mockRestore();
    }
    expect(await playerTxCount(player.principal)).toBe(0);
    expect(await progress(player)).toMatchObject({ hints: before.hints, version: before.version, firstClassPass: false });
  });

  it("a transient store failure is 503 store_unavailable with Retry-After and nothing written", async () => {
    const player = await newPlayer();
    const before = await progress(player);
    const ref = fakeReference({ outcome: "transient", productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    const res = await buy(player, "apple", DEMO_HINT_5, ref);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("store_unavailable");
    expect(res.headers["retry-after"]).toBe("3");
    expect(await txCount(ref)).toBe(0);
    expect(await progress(player)).toMatchObject({ hints: before.hints, version: before.version });
  });

  it("a revoked purchase is 422 purchase_revoked and grants nothing", async () => {
    const player = await newPlayer();
    const before = await progress(player);
    const ref = fakeReference({ outcome: "revoked", productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    const res = await buy(player, "apple", DEMO_HINT_5, ref);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("purchase_revoked");
    expect(await txCount(ref)).toBe(0);
    expect(await progress(player)).toMatchObject({ hints: before.hints, version: before.version });
  });

  it("an adapter that throws is a 503, not a 500", async () => {
    const throwing: StoreVerifier = {
      verify: async () => {
        throw new Error("store exploded");
      },
      acknowledge: async () => ({ kind: "ok" }),
    };
    const broken = await buildApp({ storeVerifier: "fake" }, throwing);
    extraApps.push(broken);
    const player = await newPlayer({ on: broken.getHttpServer() });
    const res = await buy(player, "apple", DEMO_HINT_5, "anything", broken.getHttpServer());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("store_unavailable");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("a failing acknowledge is logged and does not fail the purchase", async () => {
    const real = new FakeStoreVerifier();
    const failing: StoreVerifier = {
      verify: (ref) => real.verify(ref),
      acknowledge: async () => {
        throw new Error("play is down");
      },
    };
    const withFailingAck = await buildApp({ storeVerifier: "fake" }, failing);
    extraApps.push(withFailingAck);
    const on = withFailingAck.getHttpServer();
    const player = await newPlayer({ on });
    const ref = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    const res = await buy(player, "google", DEMO_HINT_5, ref, on);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("granted");
    expect(await txCount(ref)).toBe(1);
  });
});

describe("POST /v1/purchases: the catalog decides", () => {
  it("an unknown product is 200 pending with nothing written; once the product exists a resend grants", async () => {
    const player = await newPlayer();
    const before = await progress(player);
    const productId = `test.late.${randomUUID().replaceAll("-", "")}`;
    const ref = fakeReference({ productId, purchasedAtSec: uniqueSec() });
    const pending = await buy(player, "apple", productId, ref);
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ status: "pending", replayed: false, storePurchase: null, progress: { hints: before.hints, version: before.version } });
    expect(await txCount(ref)).toBe(0);
    expect(fake.acknowledged).not.toContain(ref);

    await seedProduct(sql, { productId, kind: "hint_pack", hints: 3 });
    const granted = await buy(player, "apple", productId, ref);
    expect(granted.body).toMatchObject({ status: "granted", replayed: false, storePurchase: { grantedHints: 3 } });
    expect(granted.body.progress.hints).toBe(before.hints + 3);
  });

  it("a pending Google purchase is not acknowledged", async () => {
    const player = await newPlayer();
    const productId = `test.ack.${randomUUID().replaceAll("-", "")}`;
    const ref = fakeReference({ productId, purchasedAtSec: uniqueSec() });
    expect((await buy(player, "google", productId, ref)).body.status).toBe("pending");
    expect(fake.acknowledged).not.toContain(ref);
  });

  it("a retired product still grants", async () => {
    const player = await newPlayer();
    const productId = await newProduct("hint_pack", { status: "retired" });
    const res = await buy(player, "apple", productId, fakeReference({ productId, purchasedAtSec: uniqueSec() }));
    expect(res.body).toMatchObject({ status: "granted", storePurchase: { grantedHints: 7 } });
  });

  it("a demo product is pending in production and grants elsewhere; a real product grants in production", async () => {
    const production = await buildApp({ storeVerifier: "fake", appEnv: "production" });
    extraApps.push(production);
    const on = production.getHttpServer();
    const player = await newPlayer({ on });
    const demo = await newProduct("hint_pack", { demo: true });
    const real = await newProduct("hint_pack", { demo: false });

    const demoRef = fakeReference({ productId: demo, purchasedAtSec: uniqueSec() });
    const pending = await buy(player, "apple", demo, demoRef, on);
    expect(pending.body).toMatchObject({ status: "pending", storePurchase: null });
    expect(await txCount(demoRef)).toBe(0);
    expect((await buy(player, "apple", real, fakeReference({ productId: real, purchasedAtSec: uniqueSec() }), on)).body.status).toBe("granted");

    // The same demo reference grants on the test app (APP_ENV=test).
    expect((await buy(player, "apple", demo, demoRef)).body).toMatchObject({ status: "granted", replayed: false });
  });
});

describe("POST /v1/purchases: First Class Pass", () => {
  it("sets firstClassUntil, turns progress.firstClassPass on, and the next Round pays +50% (R2)", async () => {
    const player = await newPlayer({ linked: true });
    const before = await progress(player);
    expect(before.firstClassPass).toBe(false);
    const token_ = await token(player);
    const expires = nowSec() + 30 * DAY;
    const ref = fakeReference({ productId: DEMO_PASS_MONTHLY, token: token_, purchasedAtSec: nowSec(), expiresAtSec: expires });
    const res = await buy(player, "apple", DEMO_PASS_MONTHLY, ref);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "granted",
      replayed: false,
      storePurchase: { kind: "first_class_pass", productId: DEMO_PASS_MONTHLY, grantedHints: null, grantedUntil: new Date(expires * 1000).toISOString() },
      progress: { firstClassPass: true, version: before.version + 1, hints: before.hints },
    });
    expect((await playerRow(player.principal)).first_class_until.toISOString()).toBe(new Date(expires * 1000).toISOString());
    expect((await sql.query("SELECT version FROM ugs_mirror_outbox WHERE player_id = $1", [player.principal])).rows).toEqual([{ version: before.version + 1 }]);

    const entitlements = await request(server).get("/v1/me/entitlements").set(player.auth);
    expect(entitlements.body).toMatchObject({ commerceToken: token_, firstClassPass: true, firstClassUntil: new Date(expires * 1000).toISOString(), productId: DEMO_PASS_MONTHLY });

    // A perfect fast Round: 70 SP and Miles without a Pass, 105 with it (+50%).
    const issued = await issueRound(server, player.auth);
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    await sql.query("UPDATE rounds SET issued_at = issued_at - ($1::int * interval '1 millisecond') WHERE player_id = $2 AND status = 'open'", [MIN_ROUND_MS * 2, player.principal]);
    const result = await request(server)
      .post(`/v1/rounds/${issued.body.round.roundId}/result`)
      .set(player.auth)
      .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9, ...factsFor("atc-match") });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.award).toMatchObject({ firstClassPass: true, statusPoints: 105, miles: 105 });
  });

  it("a replay of a Pass changes nothing", async () => {
    const player = await newPlayer();
    const t = await token(player);
    const ref = fakeReference({ productId: DEMO_PASS_YEARLY, token: t, purchasedAtSec: nowSec(), expiresAtSec: nowSec() + 365 * DAY });
    const first = await buy(player, "google", DEMO_PASS_YEARLY, ref);
    const replay = await buy(player, "google", DEMO_PASS_YEARLY, ref);
    expect(replay.body).toMatchObject({ replayed: true, storePurchase: first.body.storePurchase });
    expect(replay.body.progress.version).toBe(first.body.progress.version);
    expect(await count("SELECT count(*)::int AS n FROM store_subscriptions WHERE player_id = $1", [player.principal])).toBe(1);
  });

  it("renewals are one subscription row and one transaction row each; the expiry never moves back; one version bump per grant", async () => {
    const player = await newPlayer();
    const t = await token(player);
    const start = nowSec();
    const make = (purchasedAtSec: number, expiresAtSec: number) =>
      fakeReference({ productId: DEMO_PASS_MONTHLY, token: t, purchasedAtSec, expiresAtSec });
    const until = async () => ((await playerRow(player.principal)).first_class_until as Date).getTime() / 1000;
    const base = await progress(player);

    expect((await buy(player, "apple", DEMO_PASS_MONTHLY, make(start, start + 30 * DAY))).status).toBe(200);
    expect(await until()).toBe(start + 30 * DAY);
    expect((await buy(player, "apple", DEMO_PASS_MONTHLY, make(start + 30 * DAY, start + 60 * DAY))).status).toBe(200);
    expect(await until()).toBe(start + 60 * DAY);
    // An older, out-of-order renewal is a new transaction row but never lowers the expiry.
    const older = await buy(player, "apple", DEMO_PASS_MONTHLY, make(start - DAY, start + 10 * DAY));
    expect(older.body).toMatchObject({ status: "granted", replayed: false });
    expect(await until()).toBe(start + 60 * DAY);

    const subs = (await sql.query("SELECT expires_at, status FROM store_subscriptions WHERE player_id = $1", [player.principal])).rows;
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("active");
    expect(subs[0].expires_at.getTime() / 1000).toBe(start + 60 * DAY);
    expect(await playerTxCount(player.principal)).toBe(3);
    expect((await progress(player)).version).toBe(base.version + 3);
  });

  it("two different Pass subscriptions: firstClassUntil is the latest expiry, and entitlements name that product", async () => {
    const player = await newPlayer();
    const t = await token(player);
    const start = nowSec();
    await buy(player, "apple", DEMO_PASS_MONTHLY, fakeReference({ productId: DEMO_PASS_MONTHLY, token: t, purchasedAtSec: start, expiresAtSec: start + 30 * DAY }));
    await buy(player, "google", DEMO_PASS_YEARLY, fakeReference({ productId: DEMO_PASS_YEARLY, token: t, purchasedAtSec: start, expiresAtSec: start + 365 * DAY }));
    expect(await count("SELECT count(*)::int AS n FROM store_subscriptions WHERE player_id = $1", [player.principal])).toBe(2);
    const stored = (await playerRow(player.principal)).first_class_until as Date;
    expect(stored.getTime() / 1000).toBe(start + 365 * DAY);
    const entitlements = await request(server).get("/v1/me/entitlements").set(player.auth);
    expect(entitlements.body).toMatchObject({ firstClassPass: true, productId: DEMO_PASS_YEARLY });
  });

  it("a subscription chain owned by another player is 409 and its transaction row is rolled back", async () => {
    const [owner, intruder] = [await newPlayer(), await newPlayer()];
    const productId = await newProduct("first_class_pass");
    const start = nowSec();
    const first = fakeReference({ productId, purchasedAtSec: start, expiresAtSec: start + 30 * DAY });
    const renewal = fakeReference({ productId, purchasedAtSec: start + 30 * DAY, expiresAtSec: start + 60 * DAY });
    expect((await buy(owner, "apple", productId, first)).status).toBe(200);

    const before = await progress(intruder);
    const refused = await buy(intruder, "apple", productId, renewal);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("purchase_owned_by_other");
    expect(await txCount(renewal)).toBe(0); // the insert was undone, so the owner can still submit it
    expect(await progress(intruder)).toMatchObject({ version: before.version, firstClassPass: false });
    expect((await playerRow(intruder.principal)).first_class_until).toBeNull();
    expect((await buy(owner, "apple", productId, renewal)).body).toMatchObject({ status: "granted", replayed: false });
    // The pool survived the rollback: the intruder can still buy.
    expect((await buy(intruder, "apple", DEMO_HINT_5, fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() }))).status).toBe(200);
  });
});

describe("POST /v1/purchases: no store configured", () => {
  it("STORE_VERIFIER=none is 503 store_unavailable with Retry-After and nothing written; no player is still 404", async () => {
    const none = await buildApp({ storeVerifier: "none" });
    extraApps.push(none);
    const on = none.getHttpServer();
    const player = await newPlayer({ on });
    const before = await progress(player);
    const ref = fakeReference({ productId: DEMO_HINT_5, purchasedAtSec: uniqueSec() });
    const res = await buy(player, "apple", DEMO_HINT_5, ref, on);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("store_unavailable");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(await txCount(ref)).toBe(0);
    expect(await progress(player)).toMatchObject({ hints: before.hints, version: before.version });

    const stranger = await newPlayer({ create: false, on });
    expect((await buy(stranger, "apple", DEMO_HINT_5, ref, on)).status).toBe(404);
  });
});
