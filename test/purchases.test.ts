import { describe, expect, it } from "vitest";
import { FakeStoreVerifier, fakeReference, parseFakeReference } from "../src/purchases/fake-store-verifier.js";
import { NoneStoreVerifier } from "../src/purchases/none-store-verifier.js";
import { normalizeAccountToken } from "../src/purchases/store-verifier.js";
import { isReferenceConflict } from "../src/purchases/purchases.service.js";

// Slice P-C, pure parts: the fake store's reference format, the none verifier, the token comparison. No database.

const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("fake store reference parser", () => {
  it("parses a hint pack reference with no token and a Pass reference with a token and an expiry", () => {
    expect(parseFakeReference("fake~ok~aa.hints.5~none~1700000000")).toEqual({
      outcome: "ok",
      productId: "aa.hints.5",
      token: null,
      purchasedAtSec: 1_700_000_000,
      expiresAtSec: null,
    });
    expect(parseFakeReference(`fake~revoked~aa.firstclass.monthly~${TOKEN}~1700000000~1702592000`)).toEqual({
      outcome: "revoked",
      productId: "aa.firstclass.monthly",
      token: TOKEN,
      purchasedAtSec: 1_700_000_000,
      expiresAtSec: 1_702_592_000,
    });
  });

  it("splits on the tilde, so product ids with several dots survive intact", () => {
    expect(parseFakeReference("fake~ok~a.b.c.d.e~none~1")?.productId).toBe("a.b.c.d.e");
  });

  it("every outcome is recognised, anything else is malformed", () => {
    for (const outcome of ["ok", "invalid", "transient", "revoked"] as const) {
      expect(parseFakeReference(`fake~${outcome}~aa.hints.5~none~1`)?.outcome).toBe(outcome);
    }
    for (const bad of [
      "",
      "fake",
      "fake~ok~aa.hints.5~none",
      "fake~ok~aa.hints.5~none~1~2~3",
      "real~ok~aa.hints.5~none~1",
      "fake~maybe~aa.hints.5~none~1",
      "fake~ok~AA.hints.5~none~1",
      "fake~ok~.hints~none~1",
      "fake~ok~aa.hints.5~bad token~1",
      "fake~ok~aa.hints.5~none~-1",
      "fake~ok~aa.hints.5~none~1.5",
      "fake~ok~aa.hints.5~none~x",
      "fake~ok~aa.hints.5~none~1~x",
      "fake~ok~~none~1",
    ]) {
      expect(parseFakeReference(bad), bad).toBeNull();
    }
  });

  it("fakeReference and parseFakeReference round-trip", () => {
    const ref = fakeReference({ outcome: "ok", productId: "aa.firstclass.yearly", token: TOKEN, purchasedAtSec: 10, expiresAtSec: 20 });
    expect(ref).toBe(`fake~ok~aa.firstclass.yearly~${TOKEN}~10~20`);
    expect(parseFakeReference(ref)).toMatchObject({ productId: "aa.firstclass.yearly", token: TOKEN, purchasedAtSec: 10, expiresAtSec: 20 });
  });
});

describe("FakeStoreVerifier", () => {
  const verifier = new FakeStoreVerifier();

  it("a one-time purchase has no original reference and no expiry; the reference is the transaction reference", async () => {
    const ref = fakeReference({ productId: "aa.hints.15", token: TOKEN, purchasedAtSec: 1_700_000_000 });
    const result = await verifier.verify({ store: "apple", productId: "aa.hints.15", transactionId: ref });
    expect(result).toEqual({
      kind: "valid",
      transaction: {
        store: "apple",
        environment: "fake",
        productId: "aa.hints.15",
        transactionRef: ref,
        originalRef: null,
        orderId: null,
        accountToken: TOKEN,
        purchasedAt: new Date(1_700_000_000_000),
        expiresAt: null,
        revoked: false,
        acknowledged: null,
        storeToken: null,
      },
    });
  });

  it("a Google reference carries its purchase token as storeToken (what acknowledge uses); Apple carries none", async () => {
    const ref = fakeReference({ productId: "aa.hints.15", token: TOKEN, purchasedAtSec: 1_700_000_000 });
    const google = await verifier.verify({ store: "google", productId: "aa.hints.15", purchaseToken: ref });
    const apple = await verifier.verify({ store: "apple", productId: "aa.hints.15", transactionId: ref });
    if (google.kind !== "valid" || apple.kind !== "valid") throw new Error("expected valid");
    expect(google.transaction).toMatchObject({ storeToken: ref, acknowledged: null });
    expect(apple.transaction).toMatchObject({ storeToken: null, acknowledged: null });
  });

  it("references that differ only in their times are renewals of one subscription chain", async () => {
    const a = fakeReference({ productId: "aa.firstclass.monthly", token: TOKEN, purchasedAtSec: 100, expiresAtSec: 200 });
    const b = fakeReference({ productId: "aa.firstclass.monthly", token: TOKEN, purchasedAtSec: 200, expiresAtSec: 300 });
    const first = await verifier.verify({ store: "google", productId: "aa.firstclass.monthly", purchaseToken: a });
    const second = await verifier.verify({ store: "google", productId: "aa.firstclass.monthly", purchaseToken: b });
    if (first.kind !== "valid" || second.kind !== "valid") throw new Error("expected valid");
    expect(first.transaction.originalRef).toBe(`fake~aa.firstclass.monthly~${TOKEN}`);
    expect(second.transaction.originalRef).toBe(first.transaction.originalRef);
    expect(first.transaction.transactionRef).not.toBe(second.transaction.transactionRef);
    expect(second.transaction.expiresAt).toEqual(new Date(300_000));
  });

  it("the chain of a tokenless Pass names none", async () => {
    const ref = fakeReference({ productId: "aa.firstclass.yearly", purchasedAtSec: 1, expiresAtSec: 2 });
    const result = await verifier.verify({ store: "apple", productId: "aa.firstclass.yearly", transactionId: ref });
    if (result.kind !== "valid") throw new Error("expected valid");
    expect(result.transaction.originalRef).toBe("fake~aa.firstclass.yearly~none");
    expect(result.transaction.accountToken).toBeNull();
  });

  it("outcomes map to invalid, transient (with a retry hint) and revoked", async () => {
    const call = (outcome: "invalid" | "transient" | "revoked") =>
      verifier.verify({ store: "apple", productId: "aa.hints.5", transactionId: fakeReference({ outcome, productId: "aa.hints.5", purchasedAtSec: 1 }) });
    expect((await call("invalid")).kind).toBe("invalid");
    expect(await call("transient")).toEqual({ kind: "transient", retryAfterMs: 3000 });
    const revoked = await call("revoked");
    expect(revoked.kind === "valid" && revoked.transaction.revoked).toBe(true);
  });

  it("a malformed reference is invalid", async () => {
    expect((await verifier.verify({ store: "google", productId: "aa.hints.5", purchaseToken: "not-a-fake" })).kind).toBe("invalid");
  });

  it("acknowledge records the transaction reference", async () => {
    const fake = new FakeStoreVerifier();
    const result = await fake.verify({ store: "google", productId: "aa.hints.5", purchaseToken: fakeReference({ productId: "aa.hints.5", purchasedAtSec: 5 }) });
    if (result.kind !== "valid") throw new Error("expected valid");
    expect(await fake.acknowledge(result.transaction)).toEqual({ kind: "ok" });
    expect(fake.acknowledged).toEqual([result.transaction.transactionRef]);
  });
});

describe("NoneStoreVerifier", () => {
  it("never verifies: it is transient with a retry hint, and never acknowledges", async () => {
    const none = new NoneStoreVerifier();
    expect(await none.verify()).toEqual({ kind: "transient", retryAfterMs: 60_000 });
    expect(await none.acknowledge()).toEqual({ kind: "transient" });
  });
});

describe("account token comparison", () => {
  it("is case-insensitive and ignores hyphens, so Apple's UUID matches Google's 32 hex digits", () => {
    expect(normalizeAccountToken(TOKEN.toUpperCase())).toBe(normalizeAccountToken(TOKEN.replaceAll("-", "")));
    expect(normalizeAccountToken(TOKEN)).toBe("3f2504e04f8941d39a0c0305e82c3301");
    expect(normalizeAccountToken(TOKEN)).not.toBe(normalizeAccountToken("3f2504e0-4f89-41d3-9a0c-0305e82c3302"));
  });
});

describe("isReferenceConflict (which unique violations mean 'this store reference is taken')", () => {
  const violation = (constraint: string | undefined, code = "23505") => {
    const driver = Object.assign(new Error("duplicate key value violates unique constraint"), { code, constraint });
    return new Error("Failed query: insert ...", { cause: driver });
  };

  it("is true for the three reference constraints, through the wrapped driver error", () => {
    for (const constraint of ["store_transactions_store_ref", "store_subscriptions_pk", "store_claims_pk"]) {
      expect(isReferenceConflict(violation(constraint)), constraint).toBe(true);
    }
  });

  it("is false for any other unique violation, another SQLSTATE, or an error without a constraint", () => {
    expect(isReferenceConflict(violation("hint_ledger_ref_unique"))).toBe(false);
    expect(isReferenceConflict(violation(undefined))).toBe(false);
    expect(isReferenceConflict(violation("store_claims_pk", "23503"))).toBe(false);
    expect(isReferenceConflict(new Error("boom"))).toBe(false);
    expect(isReferenceConflict(null)).toBe(false);
  });
});
