import { createHash, generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { APIError, APIException } from "@apple/app-store-server-library";
import { KEYUTIL, KJUR } from "jsrsasign";
import { SignJWT, importPKCS8 } from "jose";
import { AppleStoreVerifier } from "../src/purchases/apple-store-verifier.js";
import type { AppleSignedDataVerifier, AppleTransactionClient } from "../src/purchases/apple-store-verifier.js";
import type { StoreReference, VerifyResult } from "../src/purchases/store-verifier.js";
import type { AppleStoreConfig } from "../src/config/config.module.js";

// The Apple adapter, offline. A generated root / intermediate / leaf chain carrying Apple's marker OIDs (library 3.1.0
// jws_verification.js: leaf 1.2.840.113635.100.6.11.1, intermediate 1.2.840.113635.100.6.2.1) feeds the REAL SignedDataVerifier
// with online checks off. The App Store Server API is a fake client, except where the HTTP layer itself is under test.

const BUNDLE = "com.example.arcade";
const APP_APPLE_ID = 1234567890;
const config = (privateKeyPem = "unused"): AppleStoreConfig => ({
  bundleId: BUNDLE,
  keyId: "ABCDE12345",
  issuerId: "11111111-2222-3333-4444-555555555555",
  appAppleId: APP_APPLE_ID,
  privateKeyPem,
});

// ---- chain generation ----

type TestChain = { rootDer: Buffer; x5c: string[]; leafPem: string };

function marker(oid: string): unknown {
  return { extname: oid, extn: "0500" };
}

function makeChain(name: string): TestChain {
  const gen = () => KEYUTIL.generateKeypair("EC", "secp256r1");
  const rootKeys = gen();
  const interKeys = gen();
  const leafKeys = gen();
  const cert = (serial: number, issuer: string, subject: string, pub: unknown, signKey: unknown, ext: unknown[]) =>
    new KJUR.asn1.x509.Certificate({
      version: 3,
      serial: { int: serial },
      issuer: { str: issuer },
      notbefore: "200101000000Z",
      notafter: "400101000000Z",
      subject: { str: subject },
      sbjpubkey: pub,
      ext,
      sigalg: "SHA256withECDSA",
      cakey: signKey,
    } as never);
  const root = cert(1, `/CN=${name} Root`, `/CN=${name} Root`, rootKeys.pubKeyObj, rootKeys.prvKeyObj, [{ extname: "basicConstraints", cA: true }]);
  const inter = cert(2, `/CN=${name} Root`, `/CN=${name} Intermediate`, interKeys.pubKeyObj, rootKeys.prvKeyObj, [
    { extname: "basicConstraints", cA: true },
    marker("1.2.840.113635.100.6.2.1"),
  ]);
  const leaf = cert(3, `/CN=${name} Intermediate`, `/CN=${name} Leaf`, leafKeys.pubKeyObj, interKeys.prvKeyObj, [marker("1.2.840.113635.100.6.11.1")]);
  const der = (c: { getEncodedHex(): string }) => Buffer.from(c.getEncodedHex(), "hex");
  return {
    rootDer: der(root),
    x5c: [der(leaf), der(inter), der(root)].map((b) => b.toString("base64")),
    leafPem: KEYUTIL.getPEM(leafKeys.prvKeyObj, "PKCS8PRV"),
  };
}

const chain = makeChain("Apple Test");
const foreignChain = makeChain("Foreign");

type Payload = Record<string, unknown>;

async function sign(payload: Payload, via: TestChain = chain): Promise<string> {
  const key = await importPKCS8(via.leafPem, "ES256");
  return new SignJWT(payload as never).setProtectedHeader({ alg: "ES256", x5c: via.x5c }).sign(key);
}

const NOW = Date.now();
function consumable(over: Payload = {}): Payload {
  return {
    transactionId: "2000000111",
    originalTransactionId: "2000000111",
    bundleId: BUNDLE,
    productId: "hint.pack.small",
    purchaseDate: NOW - 60_000,
    originalPurchaseDate: NOW - 60_000,
    quantity: 1,
    type: "Consumable",
    appAccountToken: "6F9619FF-8B86-D011-B42D-00C04FC964FF",
    signedDate: NOW,
    environment: "Production",
    ...over,
  };
}
function pass(over: Payload = {}): Payload {
  return consumable({
    transactionId: "2000000222",
    originalTransactionId: "2000000100",
    productId: "first.class.pass.month",
    type: "Auto-Renewable Subscription",
    expiresDate: NOW + 30 * 86_400_000,
    ...over,
  });
}

// ---- fakes ----

type Answer = string | Error;
function fakeClient(answers: { production?: Answer | (() => Promise<never>); sandbox?: Answer | (() => Promise<never>) }) {
  const calls: string[] = [];
  const factory = (environment: "production" | "sandbox"): AppleTransactionClient => ({
    getTransactionInfo: async () => {
      calls.push(environment);
      const answer = answers[environment] ?? new APIException(404, APIError.TRANSACTION_ID_NOT_FOUND);
      if (typeof answer === "function") return answer();
      if (answer instanceof Error) throw answer;
      return { signedTransactionInfo: answer };
    },
  });
  return { calls, factory };
}

const notFound = () => new APIException(404, APIError.TRANSACTION_ID_NOT_FOUND, "not found");

function verifierWith(answers: Parameters<typeof fakeClient>[0]) {
  const client = fakeClient(answers);
  const verifier = new AppleStoreVerifier(config(), {
    createClient: client.factory,
    enableOnlineChecks: false,
    loadRootCertificates: () => [chain.rootDer],
  });
  return { verifier, calls: client.calls };
}

const signal = () => new AbortController().signal;
const context = { kind: "hint_pack" } as const;
const ref = (over: Partial<Extract<StoreReference, { store: "apple" }>> = {}): StoreReference => ({
  store: "apple",
  productId: "hint.pack.small",
  transactionId: "2000000111",
  ...over,
});

function expectValid(result: VerifyResult) {
  if (result.kind !== "valid") throw new Error(`expected valid, got ${JSON.stringify(result)}`);
  return result.transaction;
}

beforeEach(() => {
  for (const level of ["log", "warn", "error", "debug", "verbose"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Apple adapter: mapping", () => {
  it("maps a production consumable and never asks the sandbox", async () => {
    const { verifier, calls } = verifierWith({ production: await sign(consumable()) });
    const t = expectValid(await verifier.verify(ref(), context, signal()));
    expect(calls).toEqual(["production"]);
    expect(t).toEqual({
      store: "apple",
      environment: "production",
      productId: "hint.pack.small",
      transactionRef: "2000000111",
      originalRef: null, // consumables: Apple supplies an original id, the adapter nulls it
      orderId: null,
      accountToken: "6F9619FF-8B86-D011-B42D-00C04FC964FF",
      purchasedAt: new Date(NOW - 60_000),
      expiresAt: null,
      revoked: false,
      acknowledged: null,
      storeToken: null,
    });
  });

  it("falls back to the sandbox on TRANSACTION_ID_NOT_FOUND (4040010), production first", async () => {
    const { verifier, calls } = verifierWith({ sandbox: await sign(consumable({ environment: "Sandbox" })) });
    const t = expectValid(await verifier.verify(ref(), context, signal()));
    expect(calls).toEqual(["production", "sandbox"]);
    expect(t.environment).toBe("sandbox");
  });

  it("maps an auto-renewable Pass: originalRef and expiresAt", async () => {
    const payload = pass();
    const { verifier } = verifierWith({ production: await sign(payload) });
    const t = expectValid(await verifier.verify(ref({ productId: "first.class.pass.month", transactionId: "2000000222" }), { kind: "first_class_pass" }, signal()));
    expect(t.originalRef).toBe("2000000100");
    expect(t.transactionRef).toBe("2000000222");
    expect(t.expiresAt).toEqual(new Date(payload.expiresDate as number));
    expect(t.revoked).toBe(false);
  });

  it("an expired Pass renewal is still valid", async () => {
    const { verifier } = verifierWith({ production: await sign(pass({ expiresDate: NOW - 86_400_000 })) });
    const t = expectValid(await verifier.verify(ref({ productId: "first.class.pass.month", transactionId: "2000000222" }), { kind: "first_class_pass" }, signal()));
    expect(t.expiresAt!.getTime()).toBeLessThan(NOW);
  });

  it("revocationDate marks the transaction revoked", async () => {
    const { verifier } = verifierWith({ production: await sign(consumable({ revocationDate: NOW - 1000, revocationReason: 0 })) });
    expect(expectValid(await verifier.verify(ref(), context, signal())).revoked).toBe(true);
  });

  it("absent appAccountToken maps to null", async () => {
    const { verifier } = verifierWith({ production: await sign(consumable({ appAccountToken: undefined })) });
    expect(expectValid(await verifier.verify(ref(), context, signal())).accountToken).toBeNull();
  });

  it.each(["Non-Consumable", "Non-Renewing Subscription", "Something New"])("type %s is transient (catalog mismatch)", async (type) => {
    const { verifier } = verifierWith({ production: await sign(consumable({ type })) });
    expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
  });

  it("a subscription without expiresDate or originalTransactionId is transient", async () => {
    for (const over of [{ expiresDate: undefined }, { originalTransactionId: undefined }]) {
      const { verifier } = verifierWith({ production: await sign(pass(over)) });
      expect((await verifier.verify(ref({ productId: "first.class.pass.month", transactionId: "2000000222" }), { kind: "first_class_pass" }, signal())).kind).toBe("transient");
    }
  });

  it("a missing purchaseDate is transient", async () => {
    const { verifier } = verifierWith({ production: await sign(consumable({ purchaseDate: undefined })) });
    expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
  });
});

describe("Apple adapter: mismatches", () => {
  it("another transaction id than asked is invalid", async () => {
    const { verifier } = verifierWith({ production: await sign(consumable({ transactionId: "2000000999" })) });
    expect(await verifier.verify(ref(), context, signal())).toEqual({ kind: "invalid", reason: "transaction_id_mismatch" });
  });

  it("another product than the app claimed is invalid", async () => {
    const { verifier } = verifierWith({ production: await sign(consumable({ productId: "hint.pack.large" })) });
    expect(await verifier.verify(ref(), context, signal())).toEqual({ kind: "invalid", reason: "product_mismatch" });
  });

  it("a bundle id that differs from APPLE_BUNDLE_ID is transient (our setting), not invalid", async () => {
    const { verifier } = verifierWith({ production: await sign(consumable({ bundleId: "com.other.app" })) });
    expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
  });

  it("a sandbox payload answered by the production endpoint fails the environment check: transient", async () => {
    const { verifier } = verifierWith({ production: await sign(consumable({ environment: "Sandbox" })) });
    expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
  });

  it("a payload signed under a foreign root is transient (our root setting), never granted", async () => {
    const { verifier } = verifierWith({ production: await sign(consumable(), foreignChain) });
    expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
  });

  it("a chain outside its validity at signedDate is transient", async () => {
    const { verifier } = verifierWith({ production: await sign(consumable({ signedDate: Date.parse("2050-01-01T00:00:00Z") })) });
    expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
  });

  it("an unsigned or malformed signedTransactionInfo is transient", async () => {
    for (const bad of ["not-a-jws", "a.b.c", ""]) {
      const { verifier } = verifierWith({ production: bad });
      expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
    }
  });
});

describe("Apple adapter: not found in both environments", () => {
  it("without a jws it is invalid", async () => {
    const { verifier, calls } = verifierWith({});
    expect(await verifier.verify(ref(), context, signal())).toEqual({ kind: "invalid", reason: "transaction_not_found" });
    expect(calls).toEqual(["production", "sandbox"]);
  });

  it("with a jws that verifies for the same transaction (either environment) it is transient: Apple's API can lag", async () => {
    const { verifier } = verifierWith({});
    const jws = await sign(consumable({ environment: "Sandbox" }));
    expect((await verifier.verify(ref({ jws }), context, signal())).kind).toBe("transient");
    const prod = await sign(consumable());
    expect((await verifier.verify(ref({ jws: prod }), context, signal())).kind).toBe("transient");
  });

  it("a genuine jws for another bundle id (our APPLE_BUNDLE_ID may be wrong) is transient, never invalid", async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, "error").mockImplementation((message: unknown) => void lines.push(String(message)));
    const { verifier } = verifierWith({});
    const jws = await sign(consumable({ bundleId: "com.other.app" }));
    expect(await verifier.verify(ref({ jws }), context, signal())).toEqual({ kind: "transient" });
    const text = lines.join("\n");
    expect(text).toContain("check APPLE_BUNDLE_ID");
    expect(text).not.toContain("com.other.app");
    expect(text).not.toContain("2000000111");
  });

  it("an invalid outcome logs the fixed alert marker 'purchase.verify outcome=invalid store=apple'", async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void lines.push(String(message)));
    await verifierWith({}).verifier.verify(ref(), context, signal());
    expect(lines.filter((l) => l.includes("purchase.verify outcome=invalid store=apple"))).toHaveLength(1);
    lines.length = 0;
    await verifierWith({ production: await sign(consumable()) }).verifier.verify(ref(), context, signal());
    expect(lines.some((l) => l.includes("outcome=invalid"))).toBe(false);
  });

  it("a jws for a different transaction id is invalid", async () => {
    const { verifier } = verifierWith({});
    const jws = await sign(consumable({ transactionId: "2000000999" }));
    expect((await verifier.verify(ref({ jws }), context, signal())).kind).toBe("invalid");
  });

  it("a forged jws (foreign root, or garbage) is invalid", async () => {
    const { verifier } = verifierWith({});
    expect((await verifier.verify(ref({ jws: await sign(consumable(), foreignChain) }), context, signal())).kind).toBe("invalid");
    expect((await verifier.verify(ref({ jws: "x.y.z" }), context, signal())).kind).toBe("invalid");
  });

  it("a sandbox miss with a production error answers that error, not a fallback", async () => {
    const { verifier, calls } = verifierWith({ production: new APIException(500, 5000000) });
    expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
    expect(calls).toEqual(["production"]);
  });

  it("a sandbox error after a production not-found is transient, never invalid", async () => {
    const { verifier } = verifierWith({ sandbox: new APIException(503) });
    expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
  });
});

describe("Apple adapter: production refused until the first release", () => {
  const WARN_LINE = (status: number) =>
    `purchase.verify store=apple environment=production status=${status} reason=production_refused_falling_back_to_sandbox (expected until the app has a production release; an error follows if the sandbox cannot settle it)`;

  it.each([401, 403])("production %i then sandbox finds the transaction: granted from the sandbox, with one warn line", async (status) => {
    const warns: string[] = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => void warns.push(String(message)));
    const { verifier, calls } = verifierWith({ production: new APIException(status), sandbox: await sign(consumable({ environment: "Sandbox" })) });
    const t = expectValid(await verifier.verify(ref(), context, signal()));
    expect(t.environment).toBe("sandbox");
    expect(calls).toEqual(["production", "sandbox"]);
    expect(warns).toEqual([WARN_LINE(status)]);
  });

  it("production 401 then a sandbox payload that says Production is transient (the environment check still applies)", async () => {
    const { verifier } = verifierWith({ production: new APIException(401), sandbox: await sign(consumable()) });
    expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
  });

  it.each([401, 403])("production %i then sandbox %i is transient with the credentials error log", async (status) => {
    const errors: string[] = [];
    vi.spyOn(Logger.prototype, "error").mockImplementation((message: unknown) => void errors.push(String(message)));
    const { verifier, calls } = verifierWith({ production: new APIException(status), sandbox: new APIException(status) });
    expect(await verifier.verify(ref(), context, signal())).toEqual({ kind: "transient" });
    expect(calls).toEqual(["production", "sandbox"]);
    expect(errors.some((l) => l.includes("environment=sandbox") && l.includes("reason=apple_rejected_credentials"))).toBe(true);
  });

  it.each([401, 403])("ASSUMPTION: production refused (%i) and sandbox not found is transient, never invalid", async (status) => {
    const logs: string[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(String(message)));
    const { verifier, calls } = verifierWith({ production: new APIException(status) });
    const jws = await sign(consumable({ transactionId: "2000000999" }));
    for (const r of [ref(), ref({ jws })]) {
      expect(await verifier.verify(r, context, signal())).toEqual({ kind: "transient" });
    }
    expect(calls).toEqual(["production", "sandbox", "production", "sandbox"]);
    expect(logs.some((l) => l.includes("reason=production_unverifiable"))).toBe(true);
    expect(logs.some((l) => l.includes("outcome=invalid"))).toBe(false);
  });

  it("production refused and sandbox not found also logs the production_unverifiable ERROR line", async () => {
    const errors: string[] = [];
    vi.spyOn(Logger.prototype, "error").mockImplementation((message: unknown) => void errors.push(String(message)));
    await verifierWith({ production: new APIException(401) }).verifier.verify(ref(), context, signal());
    expect(errors).toContain(
      "purchase.verify store=apple environment=production reason=production_unverifiable (production refused the JWT while sandbox accepted it: expected until the app has a production release; after release this means production purchases cannot be verified, check APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID, APPLE_BUNDLE_ID and the App Store Connect agreements)",
    );
  });

  it("production 401 then sandbox INVALID_TRANSACTION_ID is invalid (the one way a refused production still ends invalid)", async () => {
    const { verifier } = verifierWith({ production: new APIException(401), sandbox: new APIException(400, APIError.INVALID_TRANSACTION_ID, "bad") });
    expect(await verifier.verify(ref(), context, signal())).toEqual({ kind: "invalid", reason: "invalid_transaction_id" });
  });

  it("production 401 then a sandbox 5xx is transient", async () => {
    const { verifier } = verifierWith({ production: new APIException(401), sandbox: new APIException(503) });
    expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
  });

  it("the real HTTP client: production 401 with no body, sandbox 200, is granted", async () => {
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jws = await sign(consumable({ environment: "Sandbox" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("https://api.storekit.apple.com/") ? new Response(null, { status: 401 }) : new Response(JSON.stringify({ signedTransactionInfo: jws }), { status: 200 }),
      ),
    );
    const verifier = new AppleStoreVerifier(config(key), { enableOnlineChecks: false, loadRootCertificates: () => [chain.rootDer] });
    expect(expectValid(await verifier.verify(ref(), context, signal())).environment).toBe("sandbox");
  });
});

describe("Apple adapter: API errors", () => {
  it("INVALID_TRANSACTION_ID (4000006) is invalid", async () => {
    const { verifier } = verifierWith({ production: new APIException(400, APIError.INVALID_TRANSACTION_ID, "bad") });
    expect(await verifier.verify(ref(), context, signal())).toEqual({ kind: "invalid", reason: "invalid_transaction_id" });
  });

  it.each([
    ["401", new APIException(401)],
    ["403", new APIException(403)],
    ["429", new APIException(429, APIError.RATE_LIMIT_EXCEEDED)],
    ["500", new APIException(500, APIError.GENERAL_INTERNAL)],
    ["503", new APIException(503)],
    ["retryable code", new APIException(404, APIError.ORIGINAL_TRANSACTION_ID_NOT_FOUND_RETRYABLE)],
    ["app not found retryable", new APIException(404, APIError.APP_NOT_FOUND_RETRYABLE)],
    ["unexpected 4xx", new APIException(400, APIError.GENERAL_BAD_REQUEST)],
    ["network", new TypeError("fetch failed")],
    ["signing key", new Error("secretOrPrivateKey must be an asymmetric key when using ES256")],
  ])("%s is transient", async (_name, error) => {
    const { verifier } = verifierWith({ production: error });
    expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
  });

  it("an empty signedTransactionInfo is transient", async () => {
    const { verifier } = verifierWith({ production: "" });
    expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
  });

  it("an abort mid-call is transient at once, even if the library call never settles", async () => {
    const controller = new AbortController();
    const { verifier } = verifierWith({ production: () => new Promise<never>(() => undefined) });
    const pending = verifier.verify(ref(), context, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: "transient" });
  });

  it("an already-aborted signal makes no result other than transient", async () => {
    const controller = new AbortController();
    controller.abort();
    const { verifier } = verifierWith({ production: await sign(consumable()) });
    expect((await verifier.verify(ref(), context, controller.signal)).kind).toBe("transient");
  });

  it("a non-apple reference is transient and never throws", async () => {
    const { verifier } = verifierWith({});
    const result = await verifier.verify({ store: "google", productId: "x", purchaseToken: "t" }, context, signal());
    expect(result.kind).toBe("transient");
  });

  it("acknowledge is ok (Apple has no server finish step)", async () => {
    const { verifier } = verifierWith({});
    const t = expectValid(await verifierWith({ production: await sign(consumable()) }).verifier.verify(ref(), context, signal()));
    expect(await verifier.acknowledge(t, signal())).toEqual({ kind: "ok" });
  });
});

describe("Apple adapter: the real HTTP client", () => {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const realClientVerifier = () =>
    new AppleStoreVerifier(config(key), { enableOnlineChecks: false, loadRootCertificates: () => [chain.rootDer] });

  it("uses global fetch with the caller's signal; production URL first, sandbox on 4040010; Authorization is a signed bearer", async () => {
    const jws = await sign(consumable({ environment: "Sandbox" }));
    const seen: { url: string; signal: AbortSignal | undefined; auth: string | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { signal?: AbortSignal; headers: Record<string, string> }) => {
        seen.push({ url, signal: init.signal, auth: init.headers.Authorization });
        if (url.startsWith("https://api.storekit.apple.com/")) {
          return new Response(JSON.stringify({ errorCode: 4040010, errorMessage: "nf" }), { status: 404 });
        }
        return new Response(JSON.stringify({ signedTransactionInfo: jws }), { status: 200 });
      }),
    );
    const controller = new AbortController();
    const t = expectValid(await realClientVerifier().verify(ref(), context, controller.signal));
    expect(t.environment).toBe("sandbox");
    expect(seen.map((s) => s.url)).toEqual([
      "https://api.storekit.apple.com/inApps/v1/transactions/2000000111?",
      "https://api.storekit-sandbox.apple.com/inApps/v1/transactions/2000000111?",
    ]);
    expect(seen.every((s) => s.auth?.startsWith("Bearer ey"))).toBe(true);
    // The signal handed to fetch follows the caller's: aborting the caller aborts the HTTP request.
    controller.abort();
    expect(seen.every((s) => s.signal?.aborted === true)).toBe(true);
  });

  it("a 429 with Retry-After seconds becomes retryAfterMs in milliseconds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "7" } })));
    expect(await realClientVerifier().verify(ref(), context, signal())).toEqual({ kind: "transient", retryAfterMs: 7000 });
  });

  it("a 429 without Retry-After is transient without a delay", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errorCode: 4290000 }), { status: 429 })));
    expect(await realClientVerifier().verify(ref(), context, signal())).toEqual({ kind: "transient" });
  });

  it("a fetch aborted by the caller is transient", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))),
    );
    const controller = new AbortController();
    const pending = realClientVerifier().verify(ref(), context, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: "transient" });
  });

  it("an unparsable key is transient (the library signs per request)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const verifier = new AppleStoreVerifier(config("not a pem"), { enableOnlineChecks: false, loadRootCertificates: () => [chain.rootDer] });
    expect((await verifier.verify(ref(), context, signal())).kind).toBe("transient");
  });
});

describe("Apple adapter: construction and logging", () => {
  it("builds exactly the PRODUCTION and SANDBOX verifiers, with the app id only for production, online checks on by default", () => {
    const calls: [string, boolean][] = [];
    const created: string[] = [];
    new AppleStoreVerifier(config(), {
      createClient: (environment) => {
        created.push(environment);
        return { getTransactionInfo: () => Promise.reject(new Error("unused")) };
      },
      createVerifier: (environment, _config, roots, online): AppleSignedDataVerifier => {
        calls.push([environment, online]);
        expect(roots.length).toBeGreaterThan(0);
        return { verifyAndDecodeTransaction: () => Promise.reject(new Error("unused")) };
      },
      loadRootCertificates: () => [chain.rootDer],
    });
    expect(calls).toEqual([
      ["production", true],
      ["sandbox", true],
    ]);
    expect(created).toEqual(["production", "sandbox"]);
  });

  it("the default root loader reads certs/apple and the default verifiers construct with real library classes", () => {
    expect(() => new AppleStoreVerifier(config())).not.toThrow();
  });

  it("no roots found fails at construction, not per purchase", () => {
    expect(() => new AppleStoreVerifier(config(), { loadRootCertificates: () => [] })).toThrow(/root certificates/);
  });

  it("logs carry only a 12-hex hash of the transaction id: never the id, the jws, or the key", async () => {
    const lines: string[] = [];
    for (const level of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => void lines.push(String(message)));
    }
    const jws = await sign(consumable());
    const hash = createHash("sha256").update("2000000111").digest("hex").slice(0, 12);
    // success, a mismatch, an API failure and a foreign root all log
    await verifierWith({ production: jws }).verifier.verify(ref(), context, signal());
    await verifierWith({ production: await sign(consumable(), foreignChain) }).verifier.verify(ref({ jws }), context, signal());
    await verifierWith({ production: new APIException(401) }).verifier.verify(ref({ jws }), context, signal());
    await verifierWith({}).verifier.verify(ref({ jws }), context, signal());
    const text = lines.join("\n");
    expect(text).toContain(hash);
    expect(text).not.toContain("2000000111");
    expect(text).not.toContain(jws);
    expect(text).not.toMatch(/eyJ/);
    expect(text).not.toContain("6F9619FF");
  });
});

describe("Apple root certificates", () => {
  it("every certs/apple/*.cer matches the SHA-256 recorded in certs/apple/README.md", () => {
    const directory = new URL("../certs/apple/", import.meta.url);
    const readme = readFileSync(new URL("README.md", directory), "utf8");
    const files = readdirSync(directory).filter((name) => name.endsWith(".cer"));
    expect(files).toContain("AppleRootCA-G3.cer");
    for (const file of files) {
      const hash = createHash("sha256").update(readFileSync(new URL(file, directory))).digest("hex");
      const row = readme.split(/\r?\n/).find((line) => line.includes(`\`${file}\``));
      expect(row, `${file} is not recorded in README.md`).toBeDefined();
      expect(row, `${file} hash is not on the same README.md row as its name`).toContain(hash);
    }
  });

  it("the shipped Apple Root CA - G3 has the documented fingerprint (published by Apple Support)", () => {
    const der = readFileSync(new URL("../certs/apple/AppleRootCA-G3.cer", import.meta.url));
    expect(createHash("sha256").update(der).digest("hex")).toBe("63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179");
  });
});
