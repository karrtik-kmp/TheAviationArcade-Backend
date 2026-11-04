import type { AcknowledgeResult, StoreVerifier, VerifyResult } from "./store-verifier.js";

/** No store is configured (`STORE_VERIFIER=none`, the default): every purchase answers 503 `store_unavailable`, nothing is written. */
export class NoneStoreVerifier implements StoreVerifier {
  async verify(): Promise<VerifyResult> {
    return { kind: "transient", retryAfterMs: 60_000 };
  }

  async acknowledge(): Promise<AcknowledgeResult> {
    return { kind: "transient" };
  }
}
