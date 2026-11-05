import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { exportPKCS8, generateKeyPair } from "jose";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { APP_CONFIG, loadConfig } from "../src/config/config.module.js";
import type { GoogleStoreConfig } from "../src/config/config.module.js";
import { GoogleStoreVerifier } from "../src/purchases/google-store-verifier.js";
import { STORE_VERIFIER } from "../src/purchases/store-verifier.js";
import { StoresVerifier } from "../src/purchases/stores-verifier.js";
import { seedProduct } from "./store-helpers.js";
import { emulatorToken } from "./tokens.js";

// Wave P2-P3 integration: the real HTTP route and PurchasesService with the composite verifier and the real Google adapter, whose
// `fetch` is an in-test stub of the OAuth token endpoint and the Android Publisher API (shapes from test/fixtures/google-play).
// docs/plans/purchases.md "Wave P2-P3". Apple is not configured in the composite here (case 5).

const PREFIX = "firebase:demo-airplane-games:";
const DAY_MS = 86_400_000;
const PACKAGE = "com.example.aviationarcade";

type Srv = ReturnType<NestExpressApplication["getHttpServer"]>;
type Call = { method: string; url: string; authorization: string | null; body: string | undefined };
type Answer = { status: number; body: unknown };

let sql: pg.Pool;
let app: NestExpressApplication;
let server: Srv;
let googleConfig: GoogleStoreConfig;
const accessToken = `ya29.stub-${randomUUID()}`;

/** What the stub knows, by purchase token. A missing entry is a Google "notFound" 404. */
const products = new Map<string, Answer>();
const subscriptions = new Map<string, Answer>();
let calls: Call[] = [];

const NOT_FOUND: Answer = { status: 404, body: { error: { code: 404, message: "The purchase token was not found.", errors: [{ domain: "global", reason: "notFound" }], status: "NOT_FOUND" } } };
const FORBIDDEN: Answer = { status: 403, body: { error: { code: 403, message: "The caller does not have permission", errors: [{ domain: "global", reason: "forbidden" }], status: "PERMISSION_DENIED" } } };

const json = (answer: Answer) => new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });

const stubFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === "string" ? init.body : undefined;
  const method = init?.method ?? "GET";
  if (url === "https://oauth2.googleapis.com/token") {
    return json({ status: 200, body: { access_token: accessToken, expires_in: 3600, token_type: "Bearer" } });
  }
  calls.push({ method, url, authorization: headers.get("authorization"), body });
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/purchases/`;
  if (!url.startsWith(base)) return json({ status: 404, body: {} });
  const rest = url.slice(base.length);
  if (method === "POST" && rest.endsWith(":acknowledge")) return json({ status: 200, body: {} });
  const match = /^(productsv2|subscriptionsv2)\/tokens\/(.+)$/.exec(rest);
  if (method !== "GET" || !match) return json({ status: 404, body: {} });
  const table = match[1] === "productsv2" ? products : subscriptions;
  return json(table.get(decodeURIComponent(match[2]!)) ?? NOT_FOUND);
};

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  googleConfig = { packageName: PACKAGE, clientEmail: "play@demo-project.iam.gserviceaccount.com", privateKeyId: "test-key-id", privateKeyPem: await exportPKCS8(privateKey) };
  const verifier = new StoresVerifier(undefined, new GoogleStoreVerifier(googleConfig, { fetch: stubFetch }));
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue({ ...loadConfig(process.env), storeVerifier: "stores" })
    .overrideProvider(STORE_VERIFIER)
    .useValue(verifier)
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

afterEach(() => {
  products.clear();
  subscriptions.clear();
  calls = [];
  vi.restoreAllMocks();
});

async function newPlayer() {
  const uid = `uid-${randomUUID()}`;
  const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
  expect((await request(server).put("/v1/me").set(auth)).status).toBe(201);
  return { uid, auth, principal: `${PREFIX}${uid}` };
}
type Player = Awaited<ReturnType<typeof newPlayer>>;

async function newProduct(kind: "hint_pack" | "first_class_pass") {
  const productId = `test.${kind === "hint_pack" ? "hints" : "pass"}.${randomUUID().replaceAll("-", "")}`;
  await seedProduct(sql, { productId, kind, ...(kind === "hint_pack" ? { hints: 7 } : { passPeriod: "P1M" as const }) });
  return productId;
}

const newToken = () => `tok_${randomUUID().replaceAll("-", "")}`;

async function buy(player: Player, productId: string, purchaseToken: string, store: "google" | "apple" = "google") {
  const payload = store === "google" ? { store, productId, purchaseToken } : { store, productId, transactionId: purchaseToken };
  return request(server).post("/v1/purchases").set(player.auth).send(payload);
}

async function commerceToken(player: Player): Promise<string> {
  const res = await request(server).get("/v1/me/entitlements").set(player.auth);
  expect(res.status).toBe(200);
  return res.body.commerceToken as string;
}

const count = async (query: string, params: unknown[]) => (await sql.query(query, params)).rows[0].n as number;
const playerRow = async (principal: string) => (await sql.query("SELECT * FROM players WHERE id = $1", [principal])).rows[0];
const txCountFor = (principal: string) => count("SELECT count(*)::int AS n FROM store_transactions WHERE player_id = $1", [principal]);
const claimsFor = (refs: string[]) => count("SELECT count(*)::int AS n FROM store_claims WHERE ref = ANY($1::text[])", [refs]);

function productAnswer(productId: string): Answer {
  return {
    status: 200,
    body: {
      kind: "androidpublisher#productPurchaseV2",
      orderId: `GPA.${randomUUID()}`,
      productLineItem: [{ productId, productOfferDetails: { quantity: 1, refundableQuantity: 1 } }],
      purchaseStateContext: { purchaseState: "PURCHASED" },
      purchaseCompletionTime: new Date().toISOString(),
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    },
  };
}

function subscriptionAnswer(options: { productId: string; orderId: string; expiresAt: Date; accountToken?: string }): Answer {
  return {
    status: 200,
    body: {
      kind: "androidpublisher#subscriptionPurchaseV2",
      startTime: new Date(Date.now() - DAY_MS).toISOString(),
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
      ...(options.accountToken ? { externalAccountIdentifiers: { obfuscatedExternalAccountId: options.accountToken.replaceAll("-", "") } } : {}),
      lineItems: [{ productId: options.productId, expiryTime: options.expiresAt.toISOString(), latestSuccessfulOrderId: options.orderId }],
    },
  };
}

describe("Google adapter through POST /v1/purchases", () => {
  it("1: a hint pack grants, records the environment, is acknowledged exactly once, and no secret reaches the logs", async () => {
    const player = await newPlayer();
    const productId = await newProduct("hint_pack");
    const purchaseToken = newToken();
    products.set(purchaseToken, productAnswer(productId));
    const logged: string[] = [];
    for (const level of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const before = (await playerRow(player.principal)).hints as number;

    const res = await buy(player, productId, purchaseToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: "granted",
      replayed: false,
      storePurchase: { store: "google", productId, kind: "hint_pack", environment: "production", grantedHints: 7, grantedUntil: null },
      progress: { hints: before + 7 },
    });
    expect((await playerRow(player.principal)).hints).toBe(before + 7);
    expect(await count("SELECT count(*)::int AS n FROM store_transactions WHERE player_id = $1 AND environment = 'production'", [player.principal])).toBe(1);

    const acks = calls.filter((c) => c.method === "POST");
    expect(acks).toHaveLength(1);
    expect(acks[0]!.url).toBe(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/purchases/products/${productId}/tokens/${purchaseToken}:acknowledge`);
    expect(acks[0]!.authorization).toBe(`Bearer ${accessToken}`);
    // Only the product endpoint was asked for a hint pack.
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);

    expect(logged.length).toBeGreaterThan(0);
    const all = logged.join("\n");
    expect(all).not.toContain(accessToken);
    expect(all).not.toContain(purchaseToken);
    expect(all).not.toContain("ya29");
  });

  it("2: a Pass grants firstClassPass, a renewal raises firstClassUntil, and another player sending the token gets 409 with nothing granted", async () => {
    const [owner, other] = [await newPlayer(), await newPlayer()];
    const productId = await newProduct("first_class_pass");
    const purchaseToken = newToken();
    const orderPrefix = `GPA.${randomUUID()}`;
    const account = await commerceToken(owner);
    const firstExpiry = new Date(Date.now() + 30 * DAY_MS);
    const secondExpiry = new Date(Date.now() + 60 * DAY_MS);

    subscriptions.set(purchaseToken, subscriptionAnswer({ productId, orderId: `${orderPrefix}-0`, expiresAt: firstExpiry, accountToken: account }));
    const first = await buy(owner, productId, purchaseToken);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      status: "granted",
      replayed: false,
      storePurchase: { store: "google", kind: "first_class_pass", productId, grantedUntil: firstExpiry.toISOString() },
      progress: { firstClassPass: true },
    });
    expect(((await playerRow(owner.principal)).first_class_until as Date).toISOString()).toBe(firstExpiry.toISOString());
    // A subscription is acknowledged on the subscriptions endpoint, with the product id.
    const ack = calls.find((c) => c.method === "POST");
    expect(ack?.url).toBe(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/purchases/subscriptions/${productId}/tokens/${purchaseToken}:acknowledge`);

    subscriptions.set(purchaseToken, subscriptionAnswer({ productId, orderId: `${orderPrefix}-1`, expiresAt: secondExpiry, accountToken: account }));
    const renewal = await buy(owner, productId, purchaseToken);
    expect(renewal.status, JSON.stringify(renewal.body)).toBe(200);
    expect(renewal.body).toMatchObject({ status: "granted", replayed: false, storePurchase: { grantedUntil: secondExpiry.toISOString() } });
    expect(((await playerRow(owner.principal)).first_class_until as Date).toISOString()).toBe(secondExpiry.toISOString());
    expect(await count("SELECT count(*)::int AS n FROM store_subscriptions WHERE player_id = $1", [owner.principal])).toBe(1);
    expect(await txCountFor(owner.principal)).toBe(2);

    // The same token from another player, after the renewal moved the latest order on (GPA...-2).
    subscriptions.set(purchaseToken, subscriptionAnswer({ productId, orderId: `${orderPrefix}-2`, expiresAt: new Date(Date.now() + 90 * DAY_MS), accountToken: account }));
    const otherBefore = await playerRow(other.principal);
    const stolen = await buy(other, productId, purchaseToken);
    expect(stolen.status).toBe(409);
    expect(stolen.body.error.code).toBe("purchase_owned_by_other");
    const otherAfter = await playerRow(other.principal);
    expect(otherAfter.first_class_until).toBeNull();
    expect(otherAfter.version).toBe(otherBefore.version);
    expect(await txCountFor(other.principal)).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM store_subscriptions WHERE player_id = $1", [other.principal])).toBe(0);
    expect(await claimsFor([`${orderPrefix}-2`])).toBe(0);
    // The owner is untouched by the attempt.
    expect(((await playerRow(owner.principal)).first_class_until as Date).toISOString()).toBe(secondExpiry.toISOString());
  });

  describe("3: a catalog mistake is 200 pending with nothing written", () => {
    it("(a) a hint pack whose token is a subscription", async () => {
      const player = await newPlayer();
      const productId = await newProduct("hint_pack");
      const purchaseToken = newToken();
      const orderId = `GPA.${randomUUID()}-0`;
      subscriptions.set(purchaseToken, subscriptionAnswer({ productId, orderId, expiresAt: new Date(Date.now() + 30 * DAY_MS) }));
      const before = await playerRow(player.principal);
      vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

      const res = await buy(player, productId, purchaseToken);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: "pending", storePurchase: null });
      // Asked the product endpoint first, then the subscription one; never acknowledged.
      expect(calls.map((c) => `${c.method} ${/purchases\/(\w+)\//.exec(c.url)?.[1]}`)).toEqual(["GET productsv2", "GET subscriptionsv2"]);
      const after = await playerRow(player.principal);
      expect(after.hints).toBe(before.hints);
      expect(after.version).toBe(before.version);
      expect(await txCountFor(player.principal)).toBe(0);
      expect(await claimsFor([orderId, purchaseToken])).toBe(0);
      expect(await count("SELECT count(*)::int AS n FROM store_subscriptions WHERE player_id = $1", [player.principal])).toBe(0);
    });

    it("(b) a Pass product whose token is a one-time purchase", async () => {
      const player = await newPlayer();
      const productId = await newProduct("first_class_pass");
      const purchaseToken = newToken();
      products.set(purchaseToken, productAnswer(productId));
      const before = await playerRow(player.principal);
      vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

      const res = await buy(player, productId, purchaseToken);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: "pending", storePurchase: null });
      expect(calls.map((c) => `${c.method} ${/purchases\/(\w+)\//.exec(c.url)?.[1]}`)).toEqual(["GET subscriptionsv2", "GET productsv2"]);
      const after = await playerRow(player.principal);
      expect(after.first_class_until).toBeNull();
      expect(after.version).toBe(before.version);
      expect(await txCountFor(player.principal)).toBe(0);
      expect(await claimsFor([purchaseToken])).toBe(0);
    });
  });

  it("4: a token unknown on both endpoints is 422 purchase_invalid; a 403 is 503 store_unavailable; nothing is written either way", async () => {
    const player = await newPlayer();
    const hints = await newProduct("hint_pack");
    const pass = await newProduct("first_class_pass");
    const before = await playerRow(player.principal);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    for (const productId of [hints, pass]) {
      const res = await buy(player, productId, newToken());
      expect(res.status, productId).toBe(422);
      expect(res.body.error.code).toBe("purchase_invalid");
    }

    const denied = newToken();
    products.set(denied, FORBIDDEN);
    const forbidden = await buy(player, hints, denied);
    expect(forbidden.status).toBe(503);
    expect(forbidden.body.error.code).toBe("store_unavailable");
    expect(Number(forbidden.headers["retry-after"])).toBeGreaterThan(0);

    // One endpoint says "no such token" and the other says forbidden: still not the player's fault.
    const mixed = newToken();
    subscriptions.set(mixed, FORBIDDEN);
    const mixedRes = await buy(player, hints, mixed);
    expect(mixedRes.status).toBe(503);
    expect(mixedRes.body.error.code).toBe("store_unavailable");

    const after = await playerRow(player.principal);
    expect(after.hints).toBe(before.hints);
    expect(after.version).toBe(before.version);
    expect(await txCountFor(player.principal)).toBe(0);
  });

  it("5: a store missing from the composite is 503 store_unavailable and Google is never called", async () => {
    const player = await newPlayer();
    const productId = await newProduct("hint_pack");
    const before = await playerRow(player.principal);
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const res = await buy(player, productId, newToken(), "apple");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("store_unavailable");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
    const after = await playerRow(player.principal);
    expect(after.hints).toBe(before.hints);
    expect(after.version).toBe(before.version);
    expect(await txCountFor(player.principal)).toBe(0);
  });
});
