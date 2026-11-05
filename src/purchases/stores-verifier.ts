import { Logger } from "@nestjs/common";
import type { AcknowledgeResult, StoreName, StoreReference, StoreVerifier, VerifiedTransaction, VerifyContext, VerifyResult } from "./store-verifier.js";

const MISSING_STORE_RETRY_MS = 60_000;
const LOG_EVERY_MS = 60_000;

/**
 * `STORE_VERIFIER=stores`: dispatches to the Apple or Google adapter on `reference.store` / `transaction.store`. A store whose
 * settings are not given has no adapter: the answer is `transient` (the app keeps the purchase pending) and an error log naming
 * the store, at most once a minute per store.
 */
export class StoresVerifier implements StoreVerifier {
  private readonly logger = new Logger("Purchases");
  private readonly lastLogged = new Map<StoreName, number>();

  constructor(
    private readonly apple?: StoreVerifier,
    private readonly google?: StoreVerifier,
    private readonly now: () => number = Date.now,
  ) {}

  verify(reference: StoreReference, context: VerifyContext, signal: AbortSignal): Promise<VerifyResult> {
    const adapter = this.adapterFor(reference.store);
    if (!adapter) return Promise.resolve({ kind: "transient", retryAfterMs: MISSING_STORE_RETRY_MS });
    return adapter.verify(reference, context, signal);
  }

  acknowledge(transaction: VerifiedTransaction, signal: AbortSignal): Promise<AcknowledgeResult> {
    const adapter = this.adapterFor(transaction.store);
    if (!adapter) return Promise.resolve({ kind: "transient" });
    return adapter.acknowledge(transaction, signal);
  }

  private adapterFor(store: StoreName): StoreVerifier | undefined {
    const adapter = store === "apple" ? this.apple : this.google;
    if (adapter) return adapter;
    const now = this.now();
    const last = this.lastLogged.get(store);
    if (last === undefined || now - last >= LOG_EVERY_MS) {
      this.lastLogged.set(store, now);
      this.logger.error(`a ${store} purchase arrived but the ${store} store is not configured (settings ${store === "apple" ? "APPLE_*" : "GOOGLE_PLAY_*"})`);
    }
    return undefined;
  }
}
