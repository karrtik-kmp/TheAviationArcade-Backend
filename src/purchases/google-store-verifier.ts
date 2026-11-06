import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import { importPKCS8, SignJWT } from "jose";
import type { GoogleStoreConfig } from "../config/config.module.js";
import type { StoreProductKind } from "../db/enums.js";
import type { AcknowledgeResult, StoreReference, StoreVerifier, VerifiedTransaction, VerifyContext, VerifyResult } from "./store-verifier.js";

/**
 * Google Play adapter (P3, docs/plans/purchases.md). Plain `fetch` to the Android Publisher API with an OAuth access token minted
 * from the service-account key; no Google SDK.
 *
 * Sources checked 2026-11-05 (Context7 /websites/developers_google_android-publisher, which mirrors developers.google.com):
 *  - purchases.productsv2.getproductpurchasev2: `GET .../androidpublisher/v3/applications/{packageName}/purchases/productsv2/tokens/{token}`
 *    (no productId in the path). ProductPurchaseV2: `productLineItem[]` in the reference, `productLineItems` in its sample (both parsed),
 *    ProductLineItem `productId` + `productOfferDetails` (the sample says `offerDetails`; both parsed) with `quantity`, `refundableQuantity`;
 *    `purchaseStateContext.purchaseState`, `testPurchaseContext`, `purchaseCompletionTime`, `acknowledgementState`,
 *    `obfuscatedExternalAccountId`, `orderId`.
 *  - purchases.subscriptionsv2.get: `GET .../applications/{packageName}/purchases/subscriptionsv2/tokens/{token}`; SubscriptionPurchaseV2
 *    `subscriptionState` (SUBSCRIPTION_STATE_*), `lineItems[].productId / expiryTime / latestSuccessfulOrderId`,
 *    `externalAccountIdentifiers.obfuscatedExternalAccountId`, `testPurchase`, `startTime`, `acknowledgementState`, `linkedPurchaseToken`.
 *  - purchases.products.acknowledge: `POST .../applications/{packageName}/purchases/products/{productId}/tokens/{token}:acknowledge`.
 *  - purchases.subscriptions.acknowledge: `POST .../applications/{packageName}/purchases/subscriptions/{subscriptionId}/tokens/{token}:acknowledge`
 *    (subscriptionId is optional since 2025-05-21; it is sent).
 *  - OAuth 2.0 for service accounts (developers.google.com/identity/protocols/oauth2/service-account): JWT header RS256 + kid, claims
 *    iss = client_email, scope, aud = https://oauth2.googleapis.com/token, iat, exp (at most iat + 3600); POST form
 *    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>`; the answer carries `access_token` and `expires_in`.
 *
 * Never throws to the caller. `invalid` only when both endpoints say the token does not exist. Logs carry status, reason, productId,
 * outcome and a 12-hex hash of the token: never a token, JWT, URL, header or body.
 */

const API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const EXCHANGE_TIMEOUT_MS = 5_000;
const EXPIRY_MARGIN_MS = 60_000;
const IAT_SKEW_S = 30;
const JWT_LIFETIME_S = 3600;

/**
 * ASSUMPTION: the reason strings Google gives when a token does not exist or is no longer valid. Taken from the Play Developer API
 * error reference (developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2, fetched 2026-11-06:
 * notFound 404, purchaseTokenNoLongerValid 410, subscriptionNoLongerAvailable 410, purchaseTokenMismatch 400); confirmed by the first
 * real sandbox call. Only 404 / 410 with one of these (on both endpoints) is `invalid`, so the 400 `purchaseTokenMismatch` never
 * matches today: a 400 stays transient, which fails safe.
 */
const TOKEN_LEVEL_REASONS: ReadonlySet<string> = new Set([
  "notFound",
  "purchaseTokenNoLongerValid",
  "subscriptionNoLongerAvailable",
  "purchaseTokenMismatch",
]);

const VALID_SUBSCRIPTION_STATES: ReadonlySet<string> = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  "SUBSCRIPTION_STATE_CANCELED",
  "SUBSCRIPTION_STATE_EXPIRED",
  "SUBSCRIPTION_STATE_ON_HOLD",
  "SUBSCRIPTION_STATE_PAUSED",
]);

type Json = Record<string, unknown>;

type Call =
  | { kind: "ok"; body: Json }
  | { kind: "http"; status: number; reason: string | null; retryAfterMs?: number }
  | { kind: "failed" };

type Mapped = { kind: "valid"; transaction: VerifiedTransaction } | { kind: "invalid"; reason: string } | { kind: "transient" };

type CachedToken = { value: string; expiresAt: number };

export class GoogleStoreVerifier implements StoreVerifier {
  private readonly logger = new Logger("GoogleStore");
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private cached: CachedToken | undefined;
  private inflight: Promise<CachedToken | undefined> | undefined;
  private keyPromise: Promise<CryptoKey> | undefined;

  constructor(
    private readonly config: GoogleStoreConfig,
    options?: { fetch?: typeof fetch; now?: () => number },
  ) {
    this.fetchFn = options?.fetch ?? ((input, init) => fetch(input, init));
    this.now = options?.now ?? Date.now;
  }

  async verify(reference: StoreReference, context: VerifyContext, signal: AbortSignal): Promise<VerifyResult> {
    try {
      if (reference.store !== "google") return { kind: "transient" };
      return await this.doVerify(reference, context.kind, signal);
    } catch {
      this.logger.error(`google verify failed unexpectedly (outcome=transient, productId=${safe(reference.productId)})`);
      return { kind: "transient" };
    }
  }

  async acknowledge(transaction: VerifiedTransaction, signal: AbortSignal): Promise<AcknowledgeResult> {
    try {
      if (transaction.acknowledged === true) return { kind: "ok" };
      const token = transaction.storeToken;
      if (!token) {
        this.logger.error(`google acknowledge has no purchase token (outcome=transient, productId=${safe(transaction.productId)})`);
        return { kind: "transient" };
      }
      // A subscription transaction carries originalRef (the purchase token); a one-time purchase does not.
      const subscription = transaction.originalRef !== null;
      const pkg = encodeURIComponent(this.config.packageName);
      const product = encodeURIComponent(transaction.productId);
      const path = subscription
        ? `/applications/${pkg}/purchases/subscriptions/${product}/tokens/${encodeURIComponent(token)}:acknowledge`
        : `/applications/${pkg}/purchases/products/${product}/tokens/${encodeURIComponent(token)}:acknowledge`;
      const call = await this.request("POST", path, signal, "{}");
      const hash = hash12(token);
      if (call.kind === "ok") {
        this.logger.log(`purchase.acknowledge outcome=ok productId=${safe(transaction.productId)} token=${hash}`);
        return { kind: "ok" };
      }
      this.logCall("purchase.acknowledge", call, transaction.productId, hash, "transient");
      return { kind: "transient" };
    } catch {
      this.logger.error(`google acknowledge failed unexpectedly (outcome=transient, productId=${safe(transaction.productId)})`);
      return { kind: "transient" };
    }
  }

  private async doVerify(reference: Extract<StoreReference, { store: "google" }>, kind: StoreProductKind, signal: AbortSignal): Promise<VerifyResult> {
    const hash = hash12(reference.purchaseToken);
    const first: Shape = kind === "first_class_pass" ? "subscription" : "product";
    const second: Shape = first === "product" ? "subscription" : "product";

    const c1 = await this.lookup(first, reference, signal);
    if (c1.kind === "ok") return this.finish(first, c1.body, reference, hash);
    if (signal.aborted) return this.transientWith(c1, reference.productId, hash);

    if (c1.kind === "http" && (c1.status === 400 || c1.status === 404 || c1.status === 410)) {
      const c2 = await this.lookup(second, reference, signal);
      if (c2.kind === "ok") {
        this.logger.error(`google purchase answered on the ${second} endpoint, not ${first} (catalog kind mismatch; outcome=mapped, productId=${safe(reference.productId)}, token=${hash})`);
        return this.finish(second, c2.body, reference, hash);
      }
      if (isTokenLevel(c1) && isTokenLevel(c2)) {
        this.logger.warn(`purchase.verify outcome=invalid store=google reason=purchase_token_not_found (token unknown on both endpoints; status=${(c1 as HttpCall).status}/${(c2 as HttpCall).status}, store_reason=${(c1 as HttpCall).reason}/${(c2 as HttpCall).reason}, productId=${safe(reference.productId)}, token=${hash})`);
        return { kind: "invalid", reason: "purchase_token_not_found" };
      }
      return this.transientWith(c2.kind === "http" && !isTokenLevel(c2) ? c2 : c1, reference.productId, hash);
    }
    return this.transientWith(c1, reference.productId, hash);
  }

  private lookup(shape: Shape, reference: { productId: string; purchaseToken: string }, signal: AbortSignal): Promise<Call> {
    const pkg = encodeURIComponent(this.config.packageName);
    const token = encodeURIComponent(reference.purchaseToken);
    const segment = shape === "product" ? "productsv2" : "subscriptionsv2";
    return this.request("GET", `/applications/${pkg}/purchases/${segment}/tokens/${token}`, signal);
  }

  private finish(shape: Shape, body: Json, reference: { productId: string; purchaseToken: string }, hash: string): VerifyResult {
    const mapped = shape === "product" ? this.mapProduct(body, reference) : this.mapSubscription(body, reference, hash);
    if (mapped.kind === "valid") {
      this.logger.log(`purchase.verify outcome=valid environment=${mapped.transaction.environment} productId=${safe(reference.productId)} token=${hash}`);
    } else if (mapped.kind === "invalid") {
      this.logger.warn(`purchase.verify outcome=invalid store=google reason=${mapped.reason} productId=${safe(reference.productId)} token=${hash}`);
    }
    return mapped;
  }

  private mapProduct(body: Json, reference: { productId: string; purchaseToken: string }): Mapped {
    const state = asString(asObject(body.purchaseStateContext)?.purchaseState);
    if (state === "CANCELLED") return { kind: "invalid", reason: "purchase_cancelled" };
    if (state === "PENDING") return this.shape("one-time purchase is pending", reference);
    if (state !== "PURCHASED") return this.shape(`one-time purchase has an unexpected state`, reference);

    const items = [...asArray(body.productLineItems), ...asArray(body.productLineItem)];
    const matching = items.length === 1 ? asObject(items[0]) : undefined;
    const offer = asObject(matching?.productOfferDetails) ?? asObject(matching?.offerDetails);
    if (!matching || matching.productId !== reference.productId || offer?.quantity !== 1) {
      return this.shape("one-time purchase has not exactly one line item of the claimed product with quantity 1", reference);
    }
    const purchasedAt = asDate(body.purchaseCompletionTime);
    if (!purchasedAt) return this.shape("completed one-time purchase has no purchaseCompletionTime", reference);

    return {
      kind: "valid",
      transaction: {
        store: "google",
        environment: body.testPurchaseContext != null ? "sandbox" : "production",
        productId: reference.productId,
        transactionRef: reference.purchaseToken,
        originalRef: null,
        orderId: asString(body.orderId) ?? null,
        accountToken: asString(body.obfuscatedExternalAccountId) ?? null,
        purchasedAt,
        expiresAt: null,
        revoked: offer.refundableQuantity === 0,
        acknowledged: ackState(body.acknowledgementState),
        storeToken: reference.purchaseToken,
      },
    };
  }

  private mapSubscription(body: Json, reference: { productId: string; purchaseToken: string }, hash: string): Mapped {
    const state = asString(body.subscriptionState);
    if (!state || !VALID_SUBSCRIPTION_STATES.has(state)) {
      return this.shape(`subscription is in a state that does not grant (${state ? safe(state) : "absent"})`, reference);
    }
    const items = asArray(body.lineItems).map(asObject).filter((item) => item?.productId === reference.productId);
    const item = items.length === 1 ? items[0] : undefined;
    if (!item) return this.shape("subscription has not exactly one line item of the claimed product", reference);
    const orderId = asString(item.latestSuccessfulOrderId);
    if (!orderId) return this.shape("subscription line item has no latestSuccessfulOrderId", reference);
    const expiresAt = asDate(item.expiryTime);
    const purchasedAt = asDate(body.startTime);
    if (!expiresAt || !purchasedAt) return this.shape("subscription has no usable expiryTime or startTime", reference);
    if (asString(body.linkedPurchaseToken)) {
      this.logger.log(`google subscription links an earlier purchase (linked=${hash12(asString(body.linkedPurchaseToken) as string)}, productId=${safe(reference.productId)}, token=${hash})`);
    }

    return {
      kind: "valid",
      transaction: {
        store: "google",
        environment: body.testPurchase != null ? "sandbox" : "production",
        productId: reference.productId,
        transactionRef: orderId,
        originalRef: reference.purchaseToken,
        orderId,
        accountToken: asString(asObject(body.externalAccountIdentifiers)?.obfuscatedExternalAccountId) ?? null,
        purchasedAt,
        expiresAt,
        revoked: false,
        acknowledged: ackState(body.acknowledgementState),
        storeToken: reference.purchaseToken,
      },
    };
  }

  /** An unexpected shape or state is ours to look at, never the player's loss. */
  private shape(text: string, reference: { productId: string; purchaseToken: string }): Mapped {
    this.logger.error(`google purchase cannot be granted: ${text} (outcome=transient, productId=${safe(reference.productId)}, token=${hash12(reference.purchaseToken)})`);
    return { kind: "transient" };
  }

  private transientWith(call: Call, productId: string, hash: string): VerifyResult {
    this.logCall("purchase.verify", call, productId, hash, "transient");
    return call.kind === "http" && call.retryAfterMs !== undefined ? { kind: "transient", retryAfterMs: call.retryAfterMs } : { kind: "transient" };
  }

  private logCall(event: string, call: Call, productId: string, hash: string, outcome: string): void {
    if (call.kind === "http") {
      const hint = call.status === 401 || call.status === 403 ? " (check the service account, its Play Console permissions and GOOGLE_PLAY_PACKAGE_NAME)" : call.status === 404 && call.reason === "applicationNotFound" ? " (check GOOGLE_PLAY_PACKAGE_NAME)" : "";
      this.logger.error(`${event} outcome=${outcome} status=${call.status} reason=${call.reason ?? "none"} productId=${safe(productId)} token=${hash}${hint}`);
    } else {
      this.logger.error(`${event} outcome=${outcome} network_or_token_failure productId=${safe(productId)} token=${hash}`);
    }
  }

  /** One authorised call. Never throws; a 401 drops the cached token. */
  private async request(method: "GET" | "POST", path: string, signal: AbortSignal, body?: string): Promise<Call> {
    const token = await this.accessToken(signal);
    if (!token) return { kind: "failed" };
    try {
      const response = await this.fetchFn(`${API_BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token.value}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body }),
        signal,
      });
      if (response.status === 401 && this.cached === token) this.cached = undefined;
      const parsed = await readJson(response);
      if (response.ok) return { kind: "ok", body: parsed ?? {} };
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        kind: "http",
        status: response.status,
        reason: errorReason(parsed),
        ...(Number.isFinite(retryAfter) && retryAfter > 0 && response.headers.get("retry-after") !== null ? { retryAfterMs: retryAfter * 1000 } : {}),
      };
    } catch {
      return { kind: "failed" };
    }
  }

  /** Single-flight access token. Each caller races its own signal; the exchange has its own timeout and a failure is never cached. */
  private async accessToken(signal: AbortSignal): Promise<CachedToken | undefined> {
    if (signal.aborted) return undefined;
    const cached = this.cached;
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > this.now()) return cached;
    if (!this.inflight) {
      const exchange = this.exchange().finally(() => {
        if (this.inflight === exchange) this.inflight = undefined;
      });
      this.inflight = exchange;
    }
    const result = await raceSignal(this.inflight, signal);
    return result ?? undefined;
  }

  private async exchange(): Promise<CachedToken | undefined> {
    try {
      this.keyPromise ??= importPKCS8(this.config.privateKeyPem, "RS256");
      let key: CryptoKey;
      try {
        key = await this.keyPromise;
      } catch (error) {
        this.keyPromise = undefined;
        throw error;
      }
      const iat = Math.floor(this.now() / 1000) - IAT_SKEW_S;
      const assertion = await new SignJWT({ scope: SCOPE })
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: this.config.privateKeyId })
        .setIssuer(this.config.clientEmail)
        .setAudience(TOKEN_URL)
        .setIssuedAt(iat)
        .setExpirationTime(iat + JWT_LIFETIME_S)
        .sign(key);
      const response = await this.fetchFn(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
      const parsed = await readJson(response);
      if (!response.ok) {
        this.logger.error(`google.token.exchange failed status=${response.status} reason=${safeReason(asString(parsed?.error))} (check GOOGLE_PLAY_SERVICE_ACCOUNT_*)`);
        return undefined;
      }
      const value = asString(parsed?.access_token);
      const expiresIn = typeof parsed?.expires_in === "number" ? parsed.expires_in : 0;
      if (!value || expiresIn <= 0) {
        this.logger.error("google.token.exchange failed: the answer has no usable access_token or expires_in");
        return undefined;
      }
      this.cached = { value, expiresAt: this.now() + expiresIn * 1000 };
      return this.cached;
    } catch {
      this.logger.error("google.token.exchange failed (key import, signing or network); check GOOGLE_PLAY_SERVICE_ACCOUNT_*");
      return undefined;
    }
  }
}

type Shape = "product" | "subscription";
type HttpCall = Extract<Call, { kind: "http" }>;

function isTokenLevel(call: Call): boolean {
  return call.kind === "http" && (call.status === 404 || call.status === 410) && call.reason !== null && TOKEN_LEVEL_REASONS.has(call.reason);
}

function ackState(value: unknown): boolean | null {
  if (value === "ACKNOWLEDGED" || value === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED") return true;
  if (value === "PENDING" || value === "ACKNOWLEDGEMENT_STATE_PENDING" || value === "ACKNOWLEDGEMENT_STATE_UNSPECIFIED") return false;
  return null;
}

function hash12(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Store-controlled strings only reach logs as short identifiers. */
function safe(value: string): string {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : "unprintable";
}

function safeReason(value: string | undefined): string {
  return value !== undefined && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : "none";
}

function errorReason(body: Json | undefined): string | null {
  const first = asObject(asArray(asObject(body?.error)?.errors)[0]);
  const reason = asString(first?.reason);
  return reason !== undefined && /^[A-Za-z0-9_]{1,64}$/.test(reason) ? reason : null;
}

async function readJson(response: Response): Promise<Json | undefined> {
  try {
    return asObject(await response.json());
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asDate(value: unknown): Date | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Resolves with the promise, or null as soon as the signal aborts (the promise itself keeps running for other callers). */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null);
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
