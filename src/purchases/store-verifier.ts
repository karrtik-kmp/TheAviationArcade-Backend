/**
 * The store verifier port (brief S8, docs/plans/purchases.md). The server never trusts a client claim: it asks the store. The
 * adapters are the fake (tests, demo projects), Apple (P2) and Google (P3), reached through the `stores` composite. `verify` and
 * `acknowledge` are network calls and are never made inside a database transaction. Adapters never throw to the service: they
 * return results (`invalid` only when the store itself says the purchase is bad; every failure that can be ours is `transient`).
 */

import type { StoreProductKind } from "../db/enums.js";

export type StoreName = "apple" | "google";

/** What the app sent: the store's own reference of a purchase it holds. */
export type StoreReference =
  | { store: "apple"; productId: string; transactionId: string; jws?: string }
  | { store: "google"; productId: string; purchaseToken: string };

export type VerifiedTransaction = {
  store: StoreName;
  environment: "production" | "sandbox" | "fake";
  productId: string;
  /** Idempotency key within the store. Apple: transactionId. Google one-time: purchaseToken; subscription: per-renewal orderId. */
  transactionRef: string;
  /**
   * Subscriptions only: the first transaction of the chain (Apple originalTransactionId; Google: the purchase token this reference carries; linked-token chains are decided in P4). Adapters set
   * null for consumables even when the store supplies an original id (Apple does); the grant ignores it for consumables anyway.
   */
  originalRef: string | null;
  orderId: string | null;
  /** The buyer's commerce token as the store carries it (any case, with or without hyphens), or null when absent. */
  accountToken: string | null;
  purchasedAt: Date;
  /** Subscriptions only: the store's expiry for this transaction. */
  expiresAt: Date | null;
  revoked: boolean;
  /** Google's acknowledgement state at verify time (acknowledge is skipped when true). Null for Apple and the fake. */
  acknowledged: boolean | null;
  /** The Google purchase token that `acknowledge` uses (never `originalRef`). Null for Apple; the fake sets it for google only. */
  storeToken: string | null;
};

/** What the service already knows about the product the app claims (the catalog kind; immutable after create). */
export type VerifyContext = { kind: StoreProductKind };

export type VerifyResult =
  | { kind: "valid"; transaction: VerifiedTransaction }
  | { kind: "invalid"; reason: string }
  | { kind: "transient"; retryAfterMs?: number };

export type AcknowledgeResult = { kind: "ok" } | { kind: "transient" };

export interface StoreVerifier {
  verify(reference: StoreReference, context: VerifyContext, signal: AbortSignal): Promise<VerifyResult>;
  /** Google only: acknowledge a granted purchase within the store's window. Apple answers ok. */
  acknowledge(transaction: VerifiedTransaction, signal: AbortSignal): Promise<AcknowledgeResult>;
}

/** Nest injection token of the configured verifier (`STORE_VERIFIER=none|fake|stores`). */
export const STORE_VERIFIER = Symbol("STORE_VERIFIER");

/** Account tokens compare lower-cased with hyphens stripped (Apple sends a UUID, Google 32 hex digits). */
export function normalizeAccountToken(token: string): string {
  return token.toLowerCase().replaceAll("-", "");
}
