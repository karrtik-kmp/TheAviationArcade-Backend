import type { AcknowledgeResult, StoreReference, StoreVerifier, VerifiedTransaction, VerifyResult } from "./store-verifier.js";

/**
 * Deterministic fake store for tests and demo projects (never configurable in production, see config.module.ts). No clock, no
 * network. The reference is one `~`-separated string (product ids contain dots, tokens hyphens, neither a tilde):
 *
 *   fake~<outcome>~<productId>~<token|none>~<purchasedAtSec>[~<expiresAtSec>]
 *
 * outcome: ok | invalid | transient | revoked. An expiry makes it a subscription transaction: `originalRef` is
 * `fake~<productId>~<token|none>`, so references that differ only in their times are renewals of one subscription.
 * Anything malformed is `invalid`. The reference is the Apple `transactionId` or the Google `purchaseToken`.
 */
export type FakeOutcome = "ok" | "invalid" | "transient" | "revoked";

export type FakeReference = {
  outcome: FakeOutcome;
  productId: string;
  token: string | null;
  purchasedAtSec: number;
  expiresAtSec: number | null;
};

const OUTCOMES = new Set<string>(["ok", "invalid", "transient", "revoked"]);
const PRODUCT_ID = /^[a-z0-9][a-z0-9._]{0,99}$/;
const TOKEN = /^[A-Za-z0-9-]{1,64}$/;
const SECONDS = /^[0-9]{1,11}$/;

export function parseFakeReference(reference: string): FakeReference | null {
  const parts = reference.split("~");
  if (parts.length !== 5 && parts.length !== 6) return null;
  const [prefix, outcome, productId, token, purchasedAt, expiresAt] = parts as [string, string, string, string, string, string | undefined];
  if (prefix !== "fake" || !OUTCOMES.has(outcome) || !PRODUCT_ID.test(productId)) return null;
  if (token !== "none" && !TOKEN.test(token)) return null;
  if (!SECONDS.test(purchasedAt) || (expiresAt !== undefined && !SECONDS.test(expiresAt))) return null;
  return {
    outcome: outcome as FakeOutcome,
    productId,
    token: token === "none" ? null : token,
    purchasedAtSec: Number(purchasedAt),
    expiresAtSec: expiresAt === undefined ? null : Number(expiresAt),
  };
}

/** Build a fake reference (the tests' counterpart of `parseFakeReference`). */
export function fakeReference(parts: {
  outcome?: FakeOutcome;
  productId: string;
  token?: string | null;
  purchasedAtSec: number;
  expiresAtSec?: number;
}): string {
  const fields = ["fake", parts.outcome ?? "ok", parts.productId, parts.token ?? "none", String(parts.purchasedAtSec)];
  if (parts.expiresAtSec !== undefined) fields.push(String(parts.expiresAtSec));
  return fields.join("~");
}

export class FakeStoreVerifier implements StoreVerifier {
  /** Every transaction reference acknowledged so far (tests read it). */
  readonly acknowledged: string[] = [];

  async verify(reference: StoreReference): Promise<VerifyResult> {
    const raw = reference.store === "apple" ? reference.transactionId : reference.purchaseToken;
    const parsed = parseFakeReference(raw);
    if (!parsed) return { kind: "invalid", reason: "malformed fake reference" };
    if (parsed.outcome === "invalid") return { kind: "invalid", reason: "fake store says invalid" };
    if (parsed.outcome === "transient") return { kind: "transient", retryAfterMs: 3000 };
    const transaction: VerifiedTransaction = {
      store: reference.store,
      environment: "fake",
      productId: parsed.productId,
      transactionRef: raw,
      originalRef: parsed.expiresAtSec === null ? null : `fake~${parsed.productId}~${parsed.token ?? "none"}`,
      orderId: null,
      accountToken: parsed.token,
      purchasedAt: new Date(parsed.purchasedAtSec * 1000),
      expiresAt: parsed.expiresAtSec === null ? null : new Date(parsed.expiresAtSec * 1000),
      revoked: parsed.outcome === "revoked",
    };
    return { kind: "valid", transaction };
  }

  async acknowledge(transaction: VerifiedTransaction): Promise<AcknowledgeResult> {
    this.acknowledged.push(transaction.transactionRef);
    return { kind: "ok" };
  }
}
