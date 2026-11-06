import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair, importSPKI, jwtVerify, exportSPKI } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleStoreVerifier } from "../src/purchases/google-store-verifier.js";
import type { StoreReference, VerifiedTransaction } from "../src/purchases/store-verifier.js";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/google-play/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
}

const PACKAGE = "com.example.aviation";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.aviation";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PURCHASE_TOKEN = "tok/en+with=odd:chars";
const ENC_TOKEN = encodeURIComponent(PURCHASE_TOKEN);

const productRef: StoreReference = { store: "google", productId: "miles_pack_small", purchaseToken: PURCHASE_TOKEN };
const passRef: StoreReference = { store: "google", productId: "pass_monthly", purchaseToken: PURCHASE_TOKEN };
const signal = () => new AbortController().signal;

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

let privatePem = "";
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privatePem = await exportPKCS8(pair.privateKey);
  publicKey = await importSPKI(await exportSPKI(pair.publicKey), "RS256");
});

beforeEach(() => {
  for (const method of ["log", "warn", "error", "debug", "verbose"] as const) vi.spyOn(Logger.prototype, method).mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

/** A fake network: the token endpoint plus a handler for androidpublisher. */
function harness(handler: (call: Call) => Response | Promise<Response>, options: { now?: () => number; exchange?: (n: number) => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  let exchanges = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    if (url === TOKEN_URL) {
      exchanges += 1;
      return options.exchange ? options.exchange(exchanges) : json(200, { access_token: `access-${exchanges}`, expires_in: 3600, token_type: "Bearer" });
    }
    return handler(call);
  }) as typeof fetch;
  const verifier = new GoogleStoreVerifier(
    { packageName: PACKAGE, clientEmail: "svc@proj.iam.gserviceaccount.com", privateKeyId: "kid123", privateKeyPem: privatePem },
    { fetch: fetchFn, ...(options.now ? { now: options.now } : {}) },
  );
  return { verifier, calls, api: () => calls.filter((c) => c.url !== TOKEN_URL), exchanges: () => exchanges };
}

const byPath = (routes: Record<string, () => Response>) => (call: Call): Response => {
  const path = call.url.replace(API, "");
  const route = routes[path];
  if (!route) throw new Error(`unexpected request ${call.method} ${path}`);
  return route();
};

const PRODUCT_GET = `/purchases/productsv2/tokens/${ENC_TOKEN}`;
const SUB_GET = `/purchases/subscriptionsv2/tokens/${ENC_TOKEN}`;

describe("GoogleStoreVerifier one-time purchases", () => {
  it("maps a PURCHASED productsv2 purchase (fixture shape, productLineItem)", async () => {
    const h = harness(byPath({ [PRODUCT_GET]: () => json(200, fixture("product-purchased")) }));
    const result = await h.verifier.verify(productRef, { kind: "miles_pack" }, signal());
    expect(result).toEqual({
      kind: "valid",
      transaction: {
        store: "google",
        environment: "production",
        productId: "miles_pack_small",
        transactionRef: PURCHASE_TOKEN,
        originalRef: null,
        orderId: "GPA.3300-1111-2222-33333",
        accountToken: "0123456789abcdef0123456789abcdef",
        purchasedAt: new Date("2026-11-05T10:00:00.123Z"),
        expiresAt: null,
        revoked: false,
        acknowledged: false,
        storeToken: PURCHASE_TOKEN,
      },
    });
    expect(h.api()).toHaveLength(1);
    expect(h.api()[0]).toMatchObject({ method: "GET", headers: { authorization: "Bearer access-1" } });
  });

  it("also parses the productLineItems / offerDetails sample shape, test purchases, ACKNOWLEDGED, missing order id and account id", async () => {
    const body = {
      ...fixture("product-purchased"),
      productLineItem: undefined,
      productLineItems: [{ productId: "miles_pack_small", offerDetails: { quantity: 1 } }],
      testPurchaseContext: { fopType: "TEST" },
      acknowledgementState: "ACKNOWLEDGED",
      orderId: undefined,
      obfuscatedExternalAccountId: undefined,
    };
    const h = harness(byPath({ [PRODUCT_GET]: () => json(200, body) }));
    const result = await h.verifier.verify(productRef, { kind: "miles_pack" }, signal());
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.transaction).toMatchObject({ environment: "sandbox", orderId: null, accountToken: null, acknowledged: true, revoked: false });
  });

  it("flags a fully refunded purchase as revoked (refundableQuantity 0)", async () => {
    const body = fixture("product-purchased");
    (body.productLineItem as { productOfferDetails: { refundableQuantity: number } }[])[0]!.productOfferDetails.refundableQuantity = 0;
    const h = harness(byPath({ [PRODUCT_GET]: () => json(200, body) }));
    const result = await h.verifier.verify(productRef, { kind: "hint_pack" }, signal());
    expect(result.kind === "valid" && result.transaction.revoked).toBe(true);
  });

  it("ASSUMPTION: an absent refundableQuantity (Google may omit zero-valued fields) is NOT revoked; confirm against a refunded sandbox purchase before P4", async () => {
    // Current behaviour: revoked only when refundableQuantity is explicitly 0. If Google omits the field on a full
    // refund, a refund would go unnoticed here. Verify with a real refunded sandbox purchase before P4 (refund handling).
    const body = fixture("product-purchased");
    delete (body.productLineItem as { productOfferDetails: { refundableQuantity?: number } }[])[0]!.productOfferDetails.refundableQuantity;
    const h = harness(byPath({ [PRODUCT_GET]: () => json(200, body) }));
    const result = await h.verifier.verify(productRef, { kind: "hint_pack" }, signal());
    expect(result.kind).toBe("valid");
    expect(result.kind === "valid" && result.transaction.revoked).toBe(false);
  });

  it("PENDING is transient, CANCELLED is invalid, an unknown state is transient", async () => {
    const run = async (state: unknown) => {
      const body = { ...fixture("product-purchased"), purchaseStateContext: { purchaseState: state } };
      return harness(byPath({ [PRODUCT_GET]: () => json(200, body) })).verifier.verify(productRef, { kind: "miles_pack" }, signal());
    };
    expect(await run("PENDING")).toEqual({ kind: "transient" });
    expect((await run("CANCELLED")).kind).toBe("invalid");
    expect(await run("PURCHASE_STATE_UNSPECIFIED")).toEqual({ kind: "transient" });
    expect(await run(undefined)).toEqual({ kind: "transient" });
  });

  it("quantity other than 1, missing quantity, another product, or several line items are transient (never one pack for N paid)", async () => {
    const item = (productId: string, quantity?: number) => ({ productId, productOfferDetails: quantity === undefined ? {} : { quantity, refundableQuantity: quantity } });
    const cases: unknown[][] = [
      [item("miles_pack_small", 2)],
      [item("miles_pack_small")],
      [item("other_product", 1)],
      [item("miles_pack_small", 1), item("miles_pack_small", 1)],
      [],
    ];
    for (const lineItems of cases) {
      const body = { ...fixture("product-purchased"), productLineItem: lineItems };
      const result = await harness(byPath({ [PRODUCT_GET]: () => json(200, body) })).verifier.verify(productRef, { kind: "miles_pack" }, signal());
      expect(result).toEqual({ kind: "transient" });
    }
  });

  it("a PURCHASED purchase without purchaseCompletionTime is transient", async () => {
    const body = { ...fixture("product-purchased"), purchaseCompletionTime: undefined };
    const result = await harness(byPath({ [PRODUCT_GET]: () => json(200, body) })).verifier.verify(productRef, { kind: "miles_pack" }, signal());
    expect(result).toEqual({ kind: "transient" });
  });
});

describe("GoogleStoreVerifier subscriptions", () => {
  it("maps an active subscription: per-renewal order id is the transaction ref, the token is the original ref", async () => {
    const h = harness(byPath({ [SUB_GET]: () => json(200, fixture("subscription-active")) }));
    const result = await h.verifier.verify(passRef, { kind: "first_class_pass" }, signal());
    expect(result).toEqual({
      kind: "valid",
      transaction: {
        store: "google",
        environment: "production",
        productId: "pass_monthly",
        transactionRef: "GPA.3345-1234-5678-90124..1",
        originalRef: PURCHASE_TOKEN,
        orderId: "GPA.3345-1234-5678-90124..1",
        accountToken: "fedcba9876543210fedcba9876543210",
        purchasedAt: new Date("2026-11-01T10:00:00Z"),
        expiresAt: new Date("2026-12-01T10:00:00Z"),
        revoked: false,
        acknowledged: false,
        storeToken: PURCHASE_TOKEN,
      },
    });
    expect(h.api()).toHaveLength(1);
  });

  it.each(["ACTIVE", "IN_GRACE_PERIOD", "CANCELED", "EXPIRED", "ON_HOLD", "PAUSED"])("SUBSCRIPTION_STATE_%s is valid", async (state) => {
    const body = { ...fixture("subscription-active"), subscriptionState: `SUBSCRIPTION_STATE_${state}` };
    const result = await harness(byPath({ [SUB_GET]: () => json(200, body) })).verifier.verify(passRef, { kind: "first_class_pass" }, signal());
    expect(result.kind).toBe("valid");
  });

  it.each(["SUBSCRIPTION_STATE_PENDING", "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED", "SUBSCRIPTION_STATE_UNSPECIFIED", "SUBSCRIPTION_STATE_NEW_THING", undefined])(
    "state %s is transient",
    async (state) => {
      const body = { ...fixture("subscription-active"), subscriptionState: state };
      const result = await harness(byPath({ [SUB_GET]: () => json(200, body) })).verifier.verify(passRef, { kind: "first_class_pass" }, signal());
      expect(result).toEqual({ kind: "transient" });
    },
  );

  it("test purchases are sandbox, ACKNOWLEDGED is recorded, linkedPurchaseToken is not an error", async () => {
    const body = { ...fixture("subscription-active"), testPurchase: {}, acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", linkedPurchaseToken: "old-token" };
    const result = await harness(byPath({ [SUB_GET]: () => json(200, body) })).verifier.verify(passRef, { kind: "first_class_pass" }, signal());
    expect(result.kind === "valid" && result.transaction).toMatchObject({ environment: "sandbox", acknowledged: true, originalRef: PURCHASE_TOKEN });
  });

  it("missing latestSuccessfulOrderId (never the token), missing expiry/start, another product, are transient", async () => {
    const base = fixture("subscription-active");
    const lineItem = (patch: Record<string, unknown>) => ({ ...(base.lineItems as Record<string, unknown>[])[0], ...patch });
    const bodies = [
      { ...base, lineItems: [lineItem({ latestSuccessfulOrderId: undefined })] },
      { ...base, lineItems: [lineItem({ expiryTime: undefined })] },
      { ...base, startTime: undefined },
      { ...base, lineItems: [lineItem({ productId: "another_pass" })] },
      { ...base, lineItems: [] },
    ];
    for (const body of bodies) {
      const result = await harness(byPath({ [SUB_GET]: () => json(200, body) })).verifier.verify(passRef, { kind: "first_class_pass" }, signal());
      expect(result).toEqual({ kind: "transient" });
    }
  });
});

describe("GoogleStoreVerifier endpoint choice and the other-endpoint retry", () => {
  it("a Pass id marked consumable: 404 on productsv2, then the subscription answer is mapped", async () => {
    const h = harness(byPath({ [PRODUCT_GET]: () => json(404, fixture("error-not-found")), [SUB_GET]: () => json(200, fixture("subscription-active")) }));
    const result = await h.verifier.verify(passRef, { kind: "miles_pack" }, signal());
    expect(result.kind).toBe("valid");
    expect(h.api().map((c) => c.url.replace(API, ""))).toEqual([PRODUCT_GET, SUB_GET]);
  });

  it("a consumable marked subscription: 400 on subscriptionsv2, then the one-time answer is mapped", async () => {
    const h = harness(byPath({ [SUB_GET]: () => json(400, fixture("error-bad-request")), [PRODUCT_GET]: () => json(200, fixture("product-purchased")) }));
    const result = await h.verifier.verify(productRef, { kind: "first_class_pass" }, signal());
    expect(result.kind).toBe("valid");
    expect(h.api().map((c) => c.url.replace(API, ""))).toEqual([SUB_GET, PRODUCT_GET]);
  });

  it("invalid only when both endpoints answer 404/410 with a token-level reason", async () => {
    const h = harness(byPath({ [PRODUCT_GET]: () => json(404, fixture("error-not-found")), [SUB_GET]: () => json(410, fixture("error-token-no-longer-valid")) }));
    const result = await h.verifier.verify(productRef, { kind: "miles_pack" }, signal());
    expect(result.kind).toBe("invalid");
    expect(h.api()).toHaveLength(2);
  });

  it("ASSUMPTION: the documented token-level reasons (notFound, purchaseTokenNoLongerValid, subscriptionNoLongerAvailable) are what Google sends; the two strings the adapter once named are not accepted", async () => {
    const reason = (status: number, text: string) => json(status, { error: { code: status, errors: [{ reason: text }] } });
    const both = async (first: Response, second: Response) => {
      const h = harness(byPath({ [PRODUCT_GET]: () => first, [SUB_GET]: () => second }));
      return h.verifier.verify(productRef, { kind: "miles_pack" }, signal());
    };
    expect((await both(reason(404, "notFound"), reason(410, "subscriptionNoLongerAvailable"))).kind).toBe("invalid");
    expect((await both(reason(410, "purchaseTokenNoLongerValid"), reason(410, "subscriptionNoLongerAvailable"))).kind).toBe("invalid");
    // The old, undocumented strings do not make a token invalid.
    expect(await both(reason(404, "notFound"), reason(410, "subscriptionPurchaseNoLongerAvailable"))).toEqual({ kind: "transient" });
    expect(await both(reason(404, "notFound"), reason(404, "purchaseTokenDoesNotMatchProductId"))).toEqual({ kind: "transient" });
    // purchaseTokenMismatch is documented as 400, and a 400 is never token-level here (fails safe).
    expect(await both(reason(400, "purchaseTokenMismatch"), reason(400, "purchaseTokenMismatch"))).toEqual({ kind: "transient" });
  });

  it("ASSUMPTION: token-level reason strings (notFound, purchaseTokenNoLongerValid) are what Google sends; confirm on the first real sandbox call", async () => {
    // Fixtures above are the recorded strings. A 404 on both without a token-level reason is ours to fix, never invalid.
    const h = harness(byPath({ [PRODUCT_GET]: () => json(404, fixture("error-application-not-found")), [SUB_GET]: () => json(404, fixture("error-application-not-found")) }));
    expect(await h.verifier.verify(productRef, { kind: "miles_pack" }, signal())).toEqual({ kind: "transient" });
  });

  it("404 token-level on one endpoint and a non-token answer on the other is transient", async () => {
    const h = harness(byPath({ [PRODUCT_GET]: () => json(404, fixture("error-not-found")), [SUB_GET]: () => json(403, fixture("error-permission")) }));
    expect(await h.verifier.verify(productRef, { kind: "miles_pack" }, signal())).toEqual({ kind: "transient" });
  });

  it("a 400 on the first and a token-level 404 on the second is transient, not invalid", async () => {
    const h = harness(byPath({ [PRODUCT_GET]: () => json(400, fixture("error-bad-request")), [SUB_GET]: () => json(404, fixture("error-not-found")) }));
    expect(await h.verifier.verify(productRef, { kind: "miles_pack" }, signal())).toEqual({ kind: "transient" });
  });
});

describe("GoogleStoreVerifier error mapping", () => {
  const cases: [number, string][] = [[401, "x"], [403, "error-permission"], [400, "error-bad-request"], [429, "x"], [500, "x"], [503, "x"]];

  it.each(cases)("HTTP %i is transient and does not ask the other endpoint (except 400)", async (status, name) => {
    const body = name === "x" ? { error: { code: status, errors: [{ reason: "backendError" }] } } : fixture(name);
    const h = harness(() => json(status, body));
    const result = await h.verifier.verify(productRef, { kind: "miles_pack" }, signal());
    expect(result).toEqual({ kind: "transient" });
    expect(h.api()).toHaveLength(status === 400 ? 2 : 1);
  });

  it("429 carries Retry-After as retryAfterMs", async () => {
    const h = harness(() => json(429, { error: {} }, { "retry-after": "7" }));
    expect(await h.verifier.verify(productRef, { kind: "miles_pack" }, signal())).toEqual({ kind: "transient", retryAfterMs: 7000 });
  });

  it("a 404 applicationNotFound is transient", async () => {
    const h = harness(() => json(404, fixture("error-application-not-found")));
    expect(await h.verifier.verify(passRef, { kind: "first_class_pass" }, signal())).toEqual({ kind: "transient" });
  });

  it("network failure, non-JSON error bodies and an abort are transient; the adapter never throws", async () => {
    const down = harness(() => {
      throw new TypeError("fetch failed");
    });
    expect(await down.verifier.verify(productRef, { kind: "miles_pack" }, signal())).toEqual({ kind: "transient" });
    const html = harness(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await html.verifier.verify(productRef, { kind: "miles_pack" }, signal())).toEqual({ kind: "transient" });
    const controller = new AbortController();
    controller.abort();
    const aborted = harness(() => json(200, fixture("product-purchased")));
    expect(await aborted.verifier.verify(productRef, { kind: "miles_pack" }, controller.signal)).toEqual({ kind: "transient" });
    expect(aborted.api()).toHaveLength(0);
  });

  it("an Apple reference is transient", async () => {
    const h = harness(() => json(200, {}));
    expect(await h.verifier.verify({ store: "apple", productId: "p", transactionId: "1" }, { kind: "first_class_pass" }, signal())).toEqual({ kind: "transient" });
  });

  it("URL-encodes every path segment", async () => {
    const h = harness(() => json(404, fixture("error-not-found")));
    await h.verifier.verify({ store: "google", productId: "p", purchaseToken: "a/b?c#d" }, { kind: "miles_pack" }, signal());
    expect(h.api()[0]!.url).toBe(`${API}/purchases/productsv2/tokens/a%2Fb%3Fc%23d`);
  });

  it("every invalid outcome logs the fixed alert marker 'purchase.verify outcome=invalid store=google'", async () => {
    const lines: string[] = [];
    for (const method of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    }
    const marker = "purchase.verify outcome=invalid store=google";
    // token unknown on both endpoints
    await harness(byPath({ [PRODUCT_GET]: () => json(404, fixture("error-not-found")), [SUB_GET]: () => json(404, fixture("error-not-found")) })).verifier.verify(
      productRef,
      { kind: "miles_pack" },
      signal(),
    );
    expect(lines.filter((l) => l.includes(marker))).toHaveLength(1);
    // CANCELLED purchase
    const cancelled = { ...fixture("product-purchased"), purchaseStateContext: { purchaseState: "CANCELLED" } };
    await harness(byPath({ [PRODUCT_GET]: () => json(200, cancelled) })).verifier.verify(productRef, { kind: "miles_pack" }, signal());
    expect(lines.filter((l) => l.includes(marker))).toHaveLength(2);
  });

  it("logs carry no token, JWT, URL or body", async () => {
    const lines: string[] = [];
    for (const method of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    }
    await harness(() => json(403, fixture("error-permission"))).verifier.verify(productRef, { kind: "miles_pack" }, signal());
    await harness(byPath({ [PRODUCT_GET]: () => json(404, fixture("error-not-found")), [SUB_GET]: () => json(404, fixture("error-not-found")) })).verifier.verify(
      productRef,
      { kind: "miles_pack" },
      signal(),
    );
    await harness(byPath({ [PRODUCT_GET]: () => json(200, fixture("product-purchased")) })).verifier.verify(productRef, { kind: "miles_pack" }, signal());
    const text = lines.join("\n");
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(PURCHASE_TOKEN);
    expect(text).not.toContain(ENC_TOKEN);
    expect(text).not.toContain("access-1");
    expect(text).not.toContain("googleapis.com");
    expect(text).not.toContain("BEGIN PRIVATE KEY");
    expect(text).toContain(createHash("sha256").update(PURCHASE_TOKEN).digest("hex").slice(0, 12));
  });
});

describe("GoogleStoreVerifier access token", () => {
  it("signs an RS256 service-account JWT with the plan's header and claims and posts it to the fixed token endpoint", async () => {
    const nowMs = Date.UTC(2026, 10, 5, 12, 0, 0);
    const h = harness(byPath({ [PRODUCT_GET]: () => json(200, fixture("product-purchased")) }), { now: () => nowMs });
    await h.verifier.verify(productRef, { kind: "miles_pack" }, signal());
    const exchange = h.calls.find((c) => c.url === TOKEN_URL)!;
    expect(exchange.method).toBe("POST");
    expect(exchange.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(exchange.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const jwt = form.get("assertion")!;
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "RS256", kid: "kid123" });
    const claims = decodeJwt(jwt);
    const iat = nowMs / 1000 - 30;
    expect(claims).toMatchObject({
      iss: "svc@proj.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    });
    await jwtVerify(jwt, publicKey, { currentDate: new Date(nowMs), audience: "https://oauth2.googleapis.com/token" });
  });

  it("two parallel calls share one exchange; a cached token is reused", async () => {
    const h = harness(byPath({ [PRODUCT_GET]: () => json(200, fixture("product-purchased")) }));
    const [a, b] = await Promise.all([
      h.verifier.verify(productRef, { kind: "miles_pack" }, signal()),
      h.verifier.verify(productRef, { kind: "miles_pack" }, signal()),
    ]);
    expect([a.kind, b.kind]).toEqual(["valid", "valid"]);
    expect(h.exchanges()).toBe(1);
    await h.verifier.verify(productRef, { kind: "miles_pack" }, signal());
    expect(h.exchanges()).toBe(1);
  });

  it("a failed exchange is transient, is never cached, and the next call exchanges again", async () => {
    const h = harness(byPath({ [PRODUCT_GET]: () => json(200, fixture("product-purchased")) }), {
      exchange: (n) => (n === 1 ? json(400, { error: "invalid_grant" }) : json(200, { access_token: "access-2", expires_in: 3600 })),
    });
    expect(await h.verifier.verify(productRef, { kind: "miles_pack" }, signal())).toEqual({ kind: "transient" });
    expect(h.api()).toHaveLength(0);
    expect((await h.verifier.verify(productRef, { kind: "miles_pack" }, signal())).kind).toBe("valid");
    expect(h.exchanges()).toBe(2);
  });

  it("an exchange answer without access_token is transient", async () => {
    const h = harness(() => json(200, fixture("product-purchased")), { exchange: () => json(200, { expires_in: 3600 }) });
    expect(await h.verifier.verify(productRef, { kind: "miles_pack" }, signal())).toEqual({ kind: "transient" });
  });

  it("a 401 from androidpublisher drops the cached token so the next call exchanges again", async () => {
    let status = 401;
    const h = harness(() => (status === 401 ? json(401, { error: { code: 401 } }) : json(200, fixture("product-purchased"))));
    expect(await h.verifier.verify(productRef, { kind: "miles_pack" }, signal())).toEqual({ kind: "transient" });
    status = 200;
    const result = await h.verifier.verify(productRef, { kind: "miles_pack" }, signal());
    expect(result.kind).toBe("valid");
    expect(h.exchanges()).toBe(2);
    expect(h.api()[1]!.headers.authorization).toBe("Bearer access-2");
  });

  it("refreshes 60 s before expiry", async () => {
    let now = 1_000_000_000_000;
    const h = harness(byPath({ [PRODUCT_GET]: () => json(200, fixture("product-purchased")) }), { now: () => now });
    await h.verifier.verify(productRef, { kind: "miles_pack" }, signal());
    now += 3600_000 - 61_000;
    await h.verifier.verify(productRef, { kind: "miles_pack" }, signal());
    expect(h.exchanges()).toBe(1);
    now += 2_000;
    await h.verifier.verify(productRef, { kind: "miles_pack" }, signal());
    expect(h.exchanges()).toBe(2);
  });

  it("one caller aborting does not cancel the shared exchange for the other", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness(byPath({ [PRODUCT_GET]: () => json(200, fixture("product-purchased")) }), {
      exchange: async () => {
        await gate;
        return json(200, { access_token: "access-1", expires_in: 3600 });
      },
    });
    const abort = new AbortController();
    const first = h.verifier.verify(productRef, { kind: "miles_pack" }, abort.signal);
    const second = h.verifier.verify(productRef, { kind: "miles_pack" }, signal());
    abort.abort();
    expect(await first).toEqual({ kind: "transient" });
    release();
    expect((await second).kind).toBe("valid");
    expect(h.exchanges()).toBe(1);
  });
});

describe("GoogleStoreVerifier acknowledge", () => {
  const tx = (patch: Partial<VerifiedTransaction>): VerifiedTransaction => ({
    store: "google",
    environment: "production",
    productId: "miles_pack_small",
    transactionRef: PURCHASE_TOKEN,
    originalRef: null,
    orderId: null,
    accountToken: null,
    purchasedAt: new Date(),
    expiresAt: null,
    revoked: false,
    acknowledged: false,
    storeToken: PURCHASE_TOKEN,
    ...patch,
  });

  it("is skipped (no network) when already acknowledged", async () => {
    const h = harness(() => json(200, {}));
    expect(await h.verifier.acknowledge(tx({ acknowledged: true }), signal())).toEqual({ kind: "ok" });
    expect(h.calls).toHaveLength(0);
  });

  it("one-time purchase: POST products/{productId}/tokens/{token}:acknowledge", async () => {
    const h = harness(() => new Response(null, { status: 204 }));
    expect(await h.verifier.acknowledge(tx({}), signal())).toEqual({ kind: "ok" });
    expect(h.api()).toHaveLength(1);
    expect(h.api()[0]).toMatchObject({ method: "POST", url: `${API}/purchases/products/miles_pack_small/tokens/${ENC_TOKEN}:acknowledge` });
  });

  it("subscription: POST subscriptions/{productId}/tokens/{token}:acknowledge on the purchase token", async () => {
    const h = harness(() => json(200, {}));
    expect(await h.verifier.acknowledge(tx({ productId: "pass_monthly", originalRef: PURCHASE_TOKEN, transactionRef: "GPA.1", acknowledged: null }), signal())).toEqual({ kind: "ok" });
    expect(h.api()[0]).toMatchObject({ method: "POST", url: `${API}/purchases/subscriptions/pass_monthly/tokens/${ENC_TOKEN}:acknowledge` });
  });

  it("failures are transient: 5xx, 403, network, abort, missing token, failed exchange; 401 drops the token", async () => {
    expect(await harness(() => json(500, {})).verifier.acknowledge(tx({}), signal())).toEqual({ kind: "transient" });
    expect(await harness(() => json(403, fixture("error-permission"))).verifier.acknowledge(tx({}), signal())).toEqual({ kind: "transient" });
    const down = harness(() => {
      throw new TypeError("fetch failed");
    });
    expect(await down.verifier.acknowledge(tx({}), signal())).toEqual({ kind: "transient" });
    const controller = new AbortController();
    controller.abort();
    expect(await harness(() => json(200, {})).verifier.acknowledge(tx({}), controller.signal)).toEqual({ kind: "transient" });
    expect(await harness(() => json(200, {})).verifier.acknowledge(tx({ storeToken: null }), signal())).toEqual({ kind: "transient" });
    expect(await harness(() => json(200, {}), { exchange: () => json(500, {}) }).verifier.acknowledge(tx({}), signal())).toEqual({ kind: "transient" });
    const unauthorized = harness(() => json(401, {}));
    await unauthorized.verifier.acknowledge(tx({}), signal());
    await unauthorized.verifier.acknowledge(tx({}), signal());
    expect(unauthorized.exchanges()).toBe(2);
  });
});

// Not covered here (lead's e2e through the real service): another player sending the same subscription token after a renewal -> 409,
// and the Pass-id-marked-consumable / reverse cases ending as `pending`.
void PACKAGE;
