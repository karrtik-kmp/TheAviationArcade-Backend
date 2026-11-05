import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import {
  APIError,
  APIException,
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  Type,
  VerificationException,
  VerificationStatus,
} from "@apple/app-store-server-library";
import type { JWSTransactionDecodedPayload, TransactionInfoResponse } from "@apple/app-store-server-library";
import type { AppleStoreConfig } from "../config/config.module.js";
import type { AcknowledgeResult, StoreReference, StoreVerifier, VerifiedTransaction, VerifyContext, VerifyResult } from "./store-verifier.js";

/**
 * Apple adapter (P2, docs/plans/purchases.md). The grant comes only from the App Store Server API's answer for the transaction id
 * the app sent, decoded and signature-checked by the library's `SignedDataVerifier` against Apple's root certificate.
 *
 * `invalid` (HTTP 422) makes the app finish the store transaction, so it is returned only when Apple itself says the purchase is
 * bad: the transaction does not exist in either environment, the id is malformed to Apple, or the product or transaction id
 * differs from what the app claimed. Everything that can be ours (key, bundle id, root certificate, clock, OCSP, network, an
 * unexpected shape) is `transient` plus an error log naming the setting. This class never throws to the caller.
 */

type AppleEnvironmentName = "production" | "sandbox";

/** The one API call the adapter makes. The default implementation carries the caller's abort signal into the HTTP request. */
export interface AppleTransactionClient {
  getTransactionInfo(transactionId: string, signal: AbortSignal): Promise<TransactionInfoResponse>;
}

/** The one verifier method the adapter uses (the library's `SignedDataVerifier` satisfies it). */
export interface AppleSignedDataVerifier {
  verifyAndDecodeTransaction(signedTransactionInfo: string): Promise<JWSTransactionDecodedPayload>;
}

export type AppleStoreVerifierOptions = {
  /** Builds the API client of one environment. Default: a client whose HTTP goes through global fetch with the caller's signal. */
  createClient?: (environment: AppleEnvironmentName, config: AppleStoreConfig) => AppleTransactionClient;
  /** Builds the signed-data verifier of one environment. Default: the library's, with Apple's roots. */
  createVerifier?: (
    environment: AppleEnvironmentName,
    config: AppleStoreConfig,
    rootCertificates: Buffer[],
    enableOnlineChecks: boolean,
  ) => AppleSignedDataVerifier;
  /** OCSP revocation checks and "now" as the certificate date. Default true; tests turn it off to stay offline. */
  enableOnlineChecks?: boolean;
  /** DER root certificates. Default: every `*.cer` in `certs/apple`, resolved from this module's location. */
  loadRootCertificates?: () => Buffer[];
};

const ENVIRONMENTS: readonly AppleEnvironmentName[] = ["production", "sandbox"];
const LIBRARY_ENVIRONMENT: Record<AppleEnvironmentName, Environment> = {
  production: Environment.PRODUCTION,
  sandbox: Environment.SANDBOX,
};
const HTTP_TIMEOUT_MS = 15_000;

class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

/** A 429 whose Retry-After header the library would drop (its APIException carries no header). */
class AppleRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("rate limited");
    this.name = "AppleRateLimitedError";
  }
}

/** Rejects as soon as the signal aborts; the late result of the underlying promise is swallowed. */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new AbortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The library's HTTP uses node-fetch with no signal and a 30 s timeout. Its `makeFetchRequest` is protected in 3.1.0, so this
 * subclass routes it through global fetch with the signal of the call in progress (an AsyncLocalStorage, so concurrent verifies
 * never share a signal).
 */
class SignalingAppStoreServerAPIClient extends AppStoreServerAPIClient implements AppleTransactionClient {
  private readonly signals = new AsyncLocalStorage<AbortSignal>();

  getTransactionInfo(transactionId: string, signal?: AbortSignal): Promise<TransactionInfoResponse> {
    if (signal === undefined) return super.getTransactionInfo(transactionId);
    return this.signals.run(signal, () => super.getTransactionInfo(transactionId));
  }

  // The return type is left to inference on purpose: the base declares node-fetch's Response (a transitive dependency we do not
  // import). The library only reads `ok`, `status` and `json()`, which the global Response has too.
  protected override async makeFetchRequest(
    path: string,
    parsedQueryParameters: URLSearchParams,
    method: string,
    requestBody: string | Buffer | undefined,
    headers: { [key: string]: string },
  ) {
    const callerSignal = this.signals.getStore();
    const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
    const url = (this as unknown as { urlBase: string }).urlBase + path + "?" + parsedQueryParameters.toString();
    const response = await fetch(url, {
      method,
      headers,
      body: requestBody as BodyInit | undefined,
      signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout,
    });
    if (response.status === 429) {
      const header = response.headers.get("retry-after");
      const seconds = header === null || header.trim() === "" ? Number.NaN : Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) throw new AppleRateLimitedError(seconds);
    }
    return response as never;
  }
}

function defaultRootCertificates(): Buffer[] {
  const directory = fileURLToPath(new URL("../../certs/apple/", import.meta.url));
  return readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith(".cer"))
    .sort()
    .map((name) => readFileSync(`${directory}${name}`));
}

function hashed(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

type Lookup =
  | { kind: "found"; signedTransactionInfo: string }
  | { kind: "not_found" }
  | { kind: "result"; result: VerifyResult };

export class AppleStoreVerifier implements StoreVerifier {
  private readonly logger = new Logger("Purchases");
  private readonly clients: Record<AppleEnvironmentName, AppleTransactionClient>;
  private readonly verifiers: Record<AppleEnvironmentName, AppleSignedDataVerifier>;

  constructor(
    private readonly config: AppleStoreConfig,
    options: AppleStoreVerifierOptions = {},
  ) {
    const enableOnlineChecks = options.enableOnlineChecks ?? true;
    const roots = (options.loadRootCertificates ?? defaultRootCertificates)();
    if (roots.length === 0) throw new Error("No Apple root certificates found (certs/apple)");
    const createClient =
      options.createClient ??
      ((environment, apple) =>
        new SignalingAppStoreServerAPIClient(apple.privateKeyPem, apple.keyId, apple.issuerId, apple.bundleId, LIBRARY_ENVIRONMENT[environment]));
    const createVerifier =
      options.createVerifier ??
      ((environment, apple, rootCertificates, online) =>
        new SignedDataVerifier(
          rootCertificates,
          online,
          LIBRARY_ENVIRONMENT[environment],
          apple.bundleId,
          environment === "production" ? apple.appAppleId : undefined,
        ));
    this.clients = { production: createClient("production", config), sandbox: createClient("sandbox", config) };
    this.verifiers = {
      production: createVerifier("production", config, roots, enableOnlineChecks),
      sandbox: createVerifier("sandbox", config, roots, enableOnlineChecks),
    };
  }

  async verify(reference: StoreReference, _context: VerifyContext, signal: AbortSignal): Promise<VerifyResult> {
    const started = performance.now();
    let result: VerifyResult;
    let environment = "none";
    let reason = "";
    try {
      if (reference.store !== "apple") {
        this.logger.error("purchase.verify store=apple outcome=transient reason=wrong_store");
        return { kind: "transient" };
      }
      const outcome = await this.verifyApple(reference, signal);
      result = outcome.result;
      environment = outcome.environment;
      reason = outcome.reason;
    } catch (error) {
      result = { kind: "transient" };
      reason = error instanceof AbortedError ? "aborted" : "unexpected_" + (error instanceof Error ? error.name : "unknown");
      if (!(error instanceof AbortedError)) this.logger.error(`purchase.verify store=apple reason=${reason} (adapter bug or an unexpected library failure)`);
    }
    const latencyMs = Math.round(performance.now() - started);
    // Fixed marker text for invalid outcomes so a burst can be alerted on later.
    const head = result.kind === "invalid" ? "purchase.verify outcome=invalid store=apple" : `purchase.verify store=apple outcome=${result.kind}`;
    this.logger.log(
      `${head} environment=${environment} reason=${reason || "-"} productId=${reference.productId} ref=${hashed(reference.store === "apple" ? reference.transactionId : "")} latencyMs=${latencyMs}`,
    );
    return result;
  }

  /** Apple has no server-side finish step: the app finishes the transaction after the 200. */
  acknowledge(_transaction: VerifiedTransaction, _signal: AbortSignal): Promise<AcknowledgeResult> {
    return Promise.resolve({ kind: "ok" });
  }

  private async verifyApple(
    reference: Extract<StoreReference, { store: "apple" }>,
    signal: AbortSignal,
  ): Promise<{ result: VerifyResult; environment: string; reason: string }> {
    let answered: AppleEnvironmentName | undefined;
    let signedTransactionInfo: string | undefined;
    for (const environment of ENVIRONMENTS) {
      const lookup = await this.lookup(environment, reference.transactionId, signal);
      if (lookup.kind === "result") return { result: lookup.result, environment, reason: reasonOf(lookup.result) };
      if (lookup.kind === "found") {
        answered = environment;
        signedTransactionInfo = lookup.signedTransactionInfo;
        break;
      }
    }

    if (answered === undefined || signedTransactionInfo === undefined) {
      return this.notFoundInBoth(reference, signal);
    }
    return this.decodeAndMap(answered, signedTransactionInfo, reference, signal);
  }

  private async lookup(environment: AppleEnvironmentName, transactionId: string, signal: AbortSignal): Promise<Lookup> {
    try {
      const response = await raceSignal(this.clients[environment].getTransactionInfo(transactionId, signal), signal);
      const signed = response.signedTransactionInfo;
      if (typeof signed !== "string" || signed.length === 0) {
        this.logger.error(`purchase.verify store=apple environment=${environment} reason=empty_transaction_info`);
        return { kind: "result", result: { kind: "transient" } };
      }
      return { kind: "found", signedTransactionInfo: signed };
    } catch (error) {
      if (error instanceof AbortedError) throw error;
      if (error instanceof AppleRateLimitedError) {
        return { kind: "result", result: { kind: "transient", retryAfterMs: error.retryAfterSeconds * 1000 } };
      }
      if (error instanceof APIException) {
        const code = typeof error.apiError === "number" ? error.apiError : null;
        if (code === APIError.TRANSACTION_ID_NOT_FOUND) return { kind: "not_found" };
        if (code === APIError.INVALID_TRANSACTION_ID) {
          return { kind: "result", result: { kind: "invalid", reason: "invalid_transaction_id" } };
        }
        if (error.httpStatusCode === 401 || error.httpStatusCode === 403) {
          this.logger.error(
            `purchase.verify store=apple environment=${environment} status=${error.httpStatusCode} code=${code ?? "-"} reason=apple_rejected_credentials (check APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID, APPLE_IAP_KEY_FILE/APPLE_IAP_KEY, APPLE_BUNDLE_ID)`,
          );
        } else if (error.httpStatusCode !== 429 && error.httpStatusCode < 500) {
          this.logger.error(`purchase.verify store=apple environment=${environment} status=${error.httpStatusCode} code=${code ?? "-"} reason=unexpected_api_error`);
        }
        return { kind: "result", result: { kind: "transient" } };
      }
      // Network failure, timeout, a malformed response, or a signing-key problem (the library signs its JWT per request).
      this.logger.error(`purchase.verify store=apple environment=${environment} reason=api_call_failed error=${error instanceof Error ? error.name : "unknown"} (network, or check APPLE_IAP_KEY_FILE/APPLE_IAP_KEY)`);
      return { kind: "result", result: { kind: "transient" } };
    }
  }

  /** Not found in both places. `invalid` unless the client's own jws proves a genuine Apple purchase the API has not caught up with. */
  private async notFoundInBoth(
    reference: Extract<StoreReference, { store: "apple" }>,
    signal: AbortSignal,
  ): Promise<{ result: VerifyResult; environment: string; reason: string }> {
    if (reference.jws !== undefined) {
      let appIdentifierMismatch = false;
      for (const environment of ENVIRONMENTS) {
        try {
          const payload = await raceSignal(this.verifiers[environment].verifyAndDecodeTransaction(reference.jws), signal);
          if (payload.transactionId === reference.transactionId) {
            return { result: { kind: "transient" }, environment, reason: "not_found_but_jws_verifies" };
          }
        } catch (error) {
          if (error instanceof AbortedError) throw error;
          if (error instanceof VerificationException && error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
            this.logger.error(`purchase.verify store=apple environment=${environment} reason=jws_check_retryable (OCSP or network)`);
            return { result: { kind: "transient" }, environment, reason: "jws_check_retryable" };
          }
          if (error instanceof VerificationException && error.status === VerificationStatus.INVALID_APP_IDENTIFIER) {
            // A genuine jws for another app id means our APPLE_BUNDLE_ID is likely wrong: that is ours, not a bad purchase.
            appIdentifierMismatch = true;
          }
          // Not verifiable in this environment: try the other, then fall through.
        }
      }
      if (appIdentifierMismatch) {
        this.logger.error("purchase.verify store=apple reason=jws_app_identifier_mismatch (check APPLE_BUNDLE_ID)");
        return { result: { kind: "transient" }, environment: "none", reason: "jws_app_identifier_mismatch" };
      }
    }
    return { result: { kind: "invalid", reason: "transaction_not_found" }, environment: "none", reason: "transaction_not_found" };
  }

  private async decodeAndMap(
    environment: AppleEnvironmentName,
    signedTransactionInfo: string,
    reference: Extract<StoreReference, { store: "apple" }>,
    signal: AbortSignal,
  ): Promise<{ result: VerifyResult; environment: string; reason: string }> {
    const transient = (reason: string, message?: string): { result: VerifyResult; environment: string; reason: string } => {
      if (message) this.logger.error(`purchase.verify store=apple environment=${environment} reason=${reason} (${message})`);
      return { result: { kind: "transient" }, environment, reason };
    };

    let payload: JWSTransactionDecodedPayload;
    try {
      payload = await raceSignal(this.verifiers[environment].verifyAndDecodeTransaction(signedTransactionInfo), signal);
    } catch (error) {
      if (error instanceof AbortedError) throw error;
      const status = error instanceof VerificationException ? VerificationStatus[error.status] : "UNKNOWN";
      return transient(
        `verification_${status}`,
        status === "INVALID_APP_IDENTIFIER"
          ? "check APPLE_BUNDLE_ID and APPLE_APP_APPLE_ID"
          : "check the Apple root certificates in certs/apple, the server clock, and outbound access to Apple's OCSP responder",
      );
    }

    if (payload.transactionId !== reference.transactionId) {
      return { result: { kind: "invalid", reason: "transaction_id_mismatch" }, environment, reason: "transaction_id_mismatch" };
    }
    if (payload.productId !== reference.productId) {
      return { result: { kind: "invalid", reason: "product_mismatch" }, environment, reason: "product_mismatch" };
    }
    if (payload.bundleId !== this.config.bundleId) return transient("bundle_mismatch", "check APPLE_BUNDLE_ID");

    const payloadEnvironment = payload.environment === Environment.PRODUCTION ? "production" : payload.environment === Environment.SANDBOX ? "sandbox" : null;
    if (payloadEnvironment === null) return transient("unknown_environment", "unexpected environment in the signed transaction");
    if (payload.purchaseDate === undefined) return transient("missing_purchase_date", "the signed transaction has no purchaseDate");

    let originalRef: string | null = null;
    let expiresAt: Date | null = null;
    if (payload.type === Type.AUTO_RENEWABLE_SUBSCRIPTION) {
      if (payload.originalTransactionId === undefined || payload.expiresDate === undefined) {
        return transient("incomplete_subscription", "the signed subscription has no originalTransactionId or expiresDate");
      }
      originalRef = payload.originalTransactionId;
      expiresAt = new Date(payload.expiresDate);
    } else if (payload.type !== Type.CONSUMABLE) {
      return transient("unsupported_product_type", `Apple type ${String(payload.type)} for ${reference.productId}: the catalog and App Store Connect disagree`);
    }

    const transaction: VerifiedTransaction = {
      store: "apple",
      environment: payloadEnvironment,
      productId: payload.productId,
      transactionRef: payload.transactionId,
      originalRef,
      orderId: null,
      accountToken: payload.appAccountToken ?? null,
      purchasedAt: new Date(payload.purchaseDate),
      expiresAt,
      revoked: payload.revocationDate !== undefined,
      acknowledged: null,
      storeToken: null,
    };
    return { result: { kind: "valid", transaction }, environment: payloadEnvironment, reason: transaction.revoked ? "revoked" : "ok" };
  }
}

function reasonOf(result: VerifyResult): string {
  return result.kind === "invalid" ? result.reason : result.kind === "transient" ? "api_error" : "ok";
}
