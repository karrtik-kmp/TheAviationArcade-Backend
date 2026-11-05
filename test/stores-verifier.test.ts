import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { FakeStoreVerifier, fakeReference } from "../src/purchases/fake-store-verifier.js";
import { StoresVerifier } from "../src/purchases/stores-verifier.js";
import type { StoreReference, StoreVerifier, VerifiedTransaction, VerifyContext } from "../src/purchases/store-verifier.js";

// The `stores` composite: dispatch on the store, and a store without an adapter is transient with a rate-limited error log.

const signal = new AbortController().signal;
const context: VerifyContext = { kind: "hint_pack" };

function recorder(name: string): StoreVerifier & { calls: string[]; contexts: VerifyContext[] } {
  const real = new FakeStoreVerifier();
  const calls: string[] = [];
  const contexts: VerifyContext[] = [];
  return {
    calls,
    contexts,
    verify: (reference, ctx, sig) => {
      calls.push(`${name}.verify`);
      contexts.push(ctx);
      return real.verify(reference as StoreReference);
    },
    acknowledge: (transaction: VerifiedTransaction, sig) => {
      calls.push(`${name}.acknowledge`);
      return real.acknowledge(transaction);
    },
  };
}

const ref = fakeReference({ productId: "aa.hints.5", purchasedAtSec: 1 });
const appleRef: StoreReference = { store: "apple", productId: "aa.hints.5", transactionId: ref };
const googleRef: StoreReference = { store: "google", productId: "aa.hints.5", purchaseToken: ref };

afterEach(() => vi.restoreAllMocks());

describe("StoresVerifier", () => {
  it("sends each reference to its own store's adapter, with the context", async () => {
    const apple = recorder("apple");
    const google = recorder("google");
    const stores = new StoresVerifier(apple, google);
    const a = await stores.verify(appleRef, context, signal);
    const g = await stores.verify(googleRef, context, signal);
    expect(a.kind === "valid" && a.transaction.store).toBe("apple");
    expect(g.kind === "valid" && g.transaction.store).toBe("google");
    expect(apple.calls).toEqual(["apple.verify"]);
    expect(google.calls).toEqual(["google.verify"]);
    expect(apple.contexts).toEqual([context]);
    if (g.kind !== "valid") throw new Error("expected valid");
    await stores.acknowledge(g.transaction, signal);
    expect(google.calls).toEqual(["google.verify", "google.acknowledge"]);
    expect(apple.calls).toEqual(["apple.verify"]);
  });

  it("a store without an adapter is transient for verify and for acknowledge, and the other store still works", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const google = recorder("google");
    const stores = new StoresVerifier(undefined, google);
    expect(await stores.verify(appleRef, context, signal)).toEqual({ kind: "transient", retryAfterMs: 60_000 });
    expect((await stores.verify(googleRef, context, signal)).kind).toBe("valid");
    const transaction = { store: "apple" } as VerifiedTransaction;
    expect(await stores.acknowledge(transaction, signal)).toEqual({ kind: "transient" });
    expect(google.calls).toEqual(["google.verify"]);
  });

  it("logs a missing store as an error at most once a minute per store", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    let now = 1_000_000;
    const stores = new StoresVerifier(undefined, undefined, () => now);
    await stores.verify(appleRef, context, signal);
    await stores.verify(appleRef, context, signal);
    expect(error).toHaveBeenCalledTimes(1);
    await stores.verify(googleRef, context, signal); // another store logs on its own
    expect(error).toHaveBeenCalledTimes(2);
    now += 59_999;
    await stores.verify(appleRef, context, signal);
    expect(error).toHaveBeenCalledTimes(2);
    now += 1;
    await stores.verify(appleRef, context, signal);
    expect(error).toHaveBeenCalledTimes(3);
    expect(String(error.mock.calls[0]?.[0])).toContain("apple");
  });
});
