import { randomBytes, randomInt } from "node:crypto";
import { APIError, APIException } from "@apple/app-store-server-library";
import { importPKCS8, SignJWT } from "jose";
import { parseStoresEnv } from "../config/config.module.js";
import type { AppleStoreConfig, GoogleStoreConfig } from "../config/config.module.js";
import { DEMO_PRODUCTS } from "../store/demo-products.js";
import { createAppleTransactionClient } from "./apple-store-verifier.js";

/**
 * Credential check behind `npm run stores:check` / `node scripts/stores-check.mjs` (wave P-K, docs/plans/purchases.md).
 *
 * READ-ONLY and secret-free by construction: the only requests are `POST oauth2.googleapis.com/token`, `GET`s to
 * `androidpublisher.googleapis.com` (monetization list reads and two purchase-token probes for a made-up token) and Apple Get
 * Transaction Info `GET`s for a made-up numeric id. No acknowledge, no database, no Pub/Sub. The output is statuses, short reason
 * strings and the six catalog product ids: never a token, a key, key contents, a path or a JWT.
 *
 * Sources checked 2026-11-06 (Context7 /websites/developers_google_android-publisher, mirroring developers.google.com):
 *  - monetization.onetimeproducts.list: `GET /androidpublisher/v3/applications/{packageName}/oneTimeProducts` (pageSize up to 1000,
 *    pageToken); `{ oneTimeProducts: [{ productId, purchaseOptions: [{ purchaseOptionId, state }] }], nextPageToken }`;
 *    purchase option state DRAFT | ACTIVE | INACTIVE | INACTIVE_PUBLISHED.
 *  - monetization.subscriptions.list: `GET /androidpublisher/v3/applications/{packageName}/subscriptions`; `{ subscriptions: [{ productId,
 *    basePlans: [{ basePlanId, state }] }], nextPageToken }`; base plan state DRAFT | ACTIVE | INACTIVE.
 *  - purchases.productsv2.getproductpurchasev2 and purchases.subscriptionsv2.get: `GET .../purchases/{productsv2|subscriptionsv2}/tokens/{token}`;
 *    errors per the subscriptionsv2 reference: 400 invalidValue (malformed token), 404 notFound, 410 purchaseTokenNoLongerValid.
 *  - @apple/app-store-server-library 3.1.0: a non-2xx answer throws `APIException { httpStatusCode, apiError: number | null }`; the code
 *    comes from the body's `errorCode`, so a 401 with no body has `apiError` null. TRANSACTION_ID_NOT_FOUND = 4040010,
 *    INVALID_TRANSACTION_ID = 4000006.
 */

const API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TIMEOUT_MS = 15_000;
const MAX_LIST_PAGES = 10;

export type CheckResult = { code: number; lines: string[] };
export type RunOptions = {
  /** The effective user id; defaults to `process.getuid?.()`. 0 (root) is refused. */
  uid?: number | undefined;
};

type Json = Record<string, unknown>;

/** The catalog the check expects Google to hold: the six ids and their types (src/store/demo-products.ts). */
const EXPECTED = DEMO_PRODUCTS.map((product) => ({ productId: product.productId, subscription: product.kind === "first_class_pass" }));

class Report {
  readonly lines: string[] = [];
  private failures = 0;

  info(text: string): void {
    this.lines.push(text);
  }
  pass(text: string): void {
    this.lines.push(`PASS  ${text}`);
  }
  fail(text: string): void {
    this.failures += 1;
    this.lines.push(`FAIL  ${text}`);
  }
  inconclusive(text: string): void {
    this.failures += 1;
    this.lines.push(`INCONCLUSIVE  ${text}`);
  }
  warn(text: string): void {
    this.lines.push(`WARN  ${text}`);
  }
  get ok(): boolean {
    return this.failures === 0;
  }
}

/** A store-supplied string reaches the output only as a short printable fragment; anything that looks like a token is redacted. */
function safeText(value: unknown): string {
  if (typeof value !== "string") return "none";
  const printable = value.replace(/[^\x20-\x7e]/g, " ").replace(/[A-Za-z0-9._~+/=-]{32,}/g, "[redacted]").replace(/\s+/g, " ").trim();
  return printable === "" ? "none" : printable.slice(0, 200);
}

function safeCode(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : "none";
}

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function readJson(response: Response): Promise<Json | undefined> {
  try {
    return asObject(await response.json());
  } catch {
    return undefined;
  }
}

type GoogleCall =
  | { kind: "ok"; body: Json }
  | { kind: "http"; status: number; reason: string; message: string }
  | { kind: "failed" };

function googleError(status: number, body: Json | undefined): GoogleCall {
  const error = asObject(body?.error);
  const first = asObject(asArray(error?.errors)[0]);
  const detail = asObject(asArray(error?.details)[0]);
  const reason = [first?.reason, detail?.reason, error?.status].map(safeCode).find((candidate) => candidate !== "none") ?? "none";
  return { kind: "http", status, reason, message: safeText(error?.message) };
}

function describeCall(call: GoogleCall): string {
  if (call.kind === "ok") return "HTTP 200";
  if (call.kind === "failed") return "no usable answer (network error or timeout)";
  return `HTTP ${call.status} reason=${call.reason}${call.message === "none" ? "" : ` (${call.message})`}`;
}

async function googleGet(fetchFn: typeof fetch, accessToken: string, path: string): Promise<GoogleCall> {
  try {
    const response = await fetchFn(`${API_BASE}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Seen live 2026-11-06: before the Play invite grants product access, the list reads answer 204 No Content (no body) where an
    // empty list would be 200 `{}`. A 204 proves nothing, so it is never "ok".
    if (response.status === 204) return { kind: "http", status: 204, reason: "noContent", message: "no body; the service account may not be allowed to view this app's products yet" };
    const body = await readJson(response);
    return response.ok ? { kind: "ok", body: body ?? {} } : googleError(response.status, body);
  } catch {
    return { kind: "failed" };
  }
}

/** Reads every page of a monetization list. A page that fails ends the read with that failure. */
async function googleList(fetchFn: typeof fetch, accessToken: string, base: string, field: string): Promise<{ kind: "ok"; items: Json[]; note?: string } | Exclude<GoogleCall, { kind: "ok" }>> {
  const items: Json[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const query = `pageSize=1000${pageToken === undefined ? "" : `&pageToken=${encodeURIComponent(pageToken)}`}`;
    const call = await googleGet(fetchFn, accessToken, `${base}?${query}`);
    if (call.kind !== "ok") return call;
    for (const item of asArray(call.body[field])) {
      const object = asObject(item);
      if (object) items.push(object);
    }
    const next = call.body.nextPageToken;
    if (typeof next !== "string" || next === "") return { kind: "ok", items };
    if (seen.has(next)) return { kind: "ok", items, note: "list stopped: nextPageToken repeated" };
    seen.add(next);
    pageToken = next;
  }
  return { kind: "ok", items, note: `list truncated after ${MAX_LIST_PAGES} pages` };
}

async function exchangeToken(fetchFn: typeof fetch, config: GoogleStoreConfig, report: Report): Promise<string | undefined> {
  try {
    const key = await importPKCS8(config.privateKeyPem, "RS256");
    const iat = Math.floor(Date.now() / 1000) - 30;
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: config.privateKeyId })
      .setIssuer(config.clientEmail)
      .setAudience(TOKEN_URL)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(key);
    const response = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await readJson(response);
    if (!response.ok) {
      report.fail(`Google token exchange: HTTP ${response.status} error=${safeCode(body?.error)} description=${safeText(body?.error_description)}`);
      return undefined;
    }
    const token = body?.access_token;
    if (typeof token !== "string" || token === "") {
      report.fail("Google token exchange: HTTP 200 but the answer has no access_token");
      return undefined;
    }
    report.pass("Google token exchange: the service-account key is accepted");
    return token;
  } catch {
    report.fail("Google token exchange: key import, signing or network failure (no detail is printed)");
    return undefined;
  }
}

const isActive = (value: unknown): boolean => asObject(value)?.state === "ACTIVE";

function reportCatalog(report: Report, oneTime: Json[], subscriptions: Json[]): void {
  const oneTimeById = new Map(oneTime.map((item) => [item.productId, item] as const));
  const subscriptionById = new Map(subscriptions.map((item) => [item.productId, item] as const));
  let attention = 0;
  for (const { productId, subscription } of EXPECTED) {
    const own = (subscription ? subscriptionById : oneTimeById).get(productId);
    const other = (subscription ? oneTimeById : subscriptionById).get(productId);
    const expectedKind = subscription ? "subscription" : "one-time product";
    if (own !== undefined) {
      const active = subscription ? asArray(own.basePlans).some(isActive) : asArray(own.purchaseOptions).some(isActive);
      if (active) {
        report.info(`        ${productId}: ${expectedKind}, ${subscription ? "base plan" : "purchase option"} ACTIVE`);
      } else {
        attention += 1;
        report.warn(`${productId}: ${expectedKind} exists but has no ACTIVE ${subscription ? "base plan" : "purchase option"}`);
      }
    } else if (other !== undefined) {
      attention += 1;
      report.warn(`${productId}: WRONG TYPE, it exists as a ${subscription ? "one-time product" : "subscription"} but the catalog expects a ${expectedKind}`);
    } else {
      attention += 1;
      report.warn(`${productId}: MISSING in Play (expected a ${expectedKind})`);
    }
  }
  if (attention > 0) report.warn(`${attention} of ${EXPECTED.length} catalog product ids need attention in Play Console (this does not change the exit code)`);
}

// 400 invalid ("Invalid Value") is what Google actually answered for a made-up token on the live run of 2026-11-06, once the
// service account could read orders (it was 401 permissionDenied before); the reference documents invalidValue.
const REASON_PASS = new Set(["400:invalidValue", "400:invalid", "404:notFound", "410:purchaseTokenNoLongerValid"]);

async function checkGoogle(fetchFn: typeof fetch, config: GoogleStoreConfig, report: Report): Promise<void> {
  report.info(`Google Play, package ${config.packageName}`);
  const token = await exchangeToken(fetchFn, config, report);
  if (token === undefined) {
    report.info("      the Play checks are skipped: there is no access token");
    return;
  }
  const pkg = encodeURIComponent(config.packageName);

  // Access proof: the monetization list reads need Play Console access to this very app, which a purchase-token probe does not prove.
  const [oneTime, subscriptions] = [
    await googleList(fetchFn, token, `/applications/${pkg}/oneTimeProducts`, "oneTimeProducts"),
    await googleList(fetchFn, token, `/applications/${pkg}/subscriptions`, "subscriptions"),
  ];
  const lists: [string, typeof oneTime][] = [
    ["one-time product list", oneTime],
    ["subscription list", subscriptions],
  ];
  let proven = true;
  for (const [name, call] of lists) {
    if (call.kind === "ok") continue;
    proven = false;
    if (call.kind === "http" && (call.status === 401 || call.status === 403)) {
      report.fail(`Play access, ${name}: ${describeCall(call)}. Check that the Android Publisher API is enabled for the key's project and that the service account's Play Console invite is accepted and active.`);
    } else if (call.kind === "http" && call.status === 404) {
      report.fail(`Play access, ${name}: ${describeCall(call)}. ${call.reason === "applicationNotFound" ? "Check GOOGLE_PLAY_PACKAGE_NAME." : "The package or the resource was not found."}`);
    } else {
      report.inconclusive(`Play access not proven by this check (${name}: ${describeCall(call)})`);
    }
  }
  if (proven && oneTime.kind === "ok" && subscriptions.kind === "ok") {
    report.pass(`Play access: the package is readable (${oneTime.items.length} one-time product(s), ${subscriptions.items.length} subscription(s) listed)`);
    for (const [name, call] of lists) if (call.kind === "ok" && call.note) report.warn(`${name}: ${call.note}; the catalog report below may be incomplete`);
    reportCatalog(report, oneTime.items, subscriptions.items);
  }

  // Token probe: a made-up token must be answered as "unknown token", which proves auth and the purchases API without reading a purchase.
  const probe = `stores-check-${randomBytes(16).toString("hex")}`;
  for (const [name, segment] of [["productsv2", "productsv2"], ["subscriptionsv2", "subscriptionsv2"]] as const) {
    const call = await googleGet(fetchFn, token, `/applications/${pkg}/purchases/${segment}/tokens/${probe}`);
    if (call.kind === "http" && REASON_PASS.has(`${call.status}:${call.reason}`)) {
      report.pass(`token probe ${name}: ${describeCall(call)} (auth and API work, the made-up token is unknown, as expected)`);
    } else if (call.kind === "http" && (call.status === 401 || call.status === 403)) {
      report.fail(`token probe ${name}: ${describeCall(call)}`);
    } else {
      report.inconclusive(`token probe ${name}: ${describeCall(call)}`);
    }
  }
}

async function checkApple(fetchFn: typeof fetch, config: AppleStoreConfig, report: Report): Promise<void> {
  report.info(`Apple App Store Server API, bundle ${config.bundleId}`);
  for (const environment of ["production", "sandbox"] as const) {
    const transactionId = String(randomInt(100_000_000_000_000, 300_000_000_000_000));
    try {
      const client = createAppleTransactionClient(environment, config, fetchFn);
      await client.getTransactionInfo(transactionId, AbortSignal.timeout(TIMEOUT_MS));
      report.inconclusive(`Apple ${environment}: HTTP 200 for a made-up transaction id (unexpected)`);
    } catch (error) {
      if (error instanceof APIException) {
        const code = typeof error.apiError === "number" ? error.apiError : null;
        if (code === APIError.TRANSACTION_ID_NOT_FOUND) {
          report.pass(`Apple ${environment}: HTTP ${error.httpStatusCode} code=${code} (JWT accepted, the made-up transaction is unknown, as expected)`);
        } else if (code === APIError.INVALID_TRANSACTION_ID) {
          report.inconclusive(`Apple ${environment}: HTTP ${error.httpStatusCode} code=${code} (auth ok, but the probe id was refused as malformed; use a numeric id)`);
        } else if (error.httpStatusCode === 401 || error.httpStatusCode === 403) {
          report.fail(`Apple ${environment}: HTTP ${error.httpStatusCode} code=${code ?? "none"} (JWT rejected: check the key, Key ID, Issuer ID and bundle id)`);
        } else {
          report.inconclusive(`Apple ${environment}: HTTP ${error.httpStatusCode} code=${code ?? "none"}`);
        }
      } else if (error instanceof Error && error.name === "AppleRateLimitedError") {
        report.inconclusive(`Apple ${environment}: HTTP 429 (rate limited)`);
      } else {
        report.inconclusive(`Apple ${environment}: no usable answer (${error instanceof Error ? safeCode(error.name) : "unknown"}); network, or the key could not sign`);
      }
    }
  }
  report.info("      not covered here: APPLE_APP_APPLE_ID, the root certificates and OCSP; the first real sandbox purchase exercises them");
}

/**
 * Runs the check against the stores configured in `env` (the same variables and rules as the server; STORE_VERIFIER is taken as
 * `stores`). Never throws: setting problems and failures come back as lines and a non-zero code. Exit code 0 only when every
 * configured store passes.
 */
export async function run(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, options: RunOptions = {}): Promise<CheckResult> {
  const uid = "uid" in options ? options.uid : process.getuid?.();
  if (uid === 0) {
    return { code: 1, lines: ["Refusing to run as root: a pass as root does not prove that the app user can read the key file. No request was sent."] };
  }
  // APP_ENV goes through unchanged: a missing or odd value is refused exactly as loadConfig refuses it.
  if (env.APP_ENV === "test") {
    return { code: 1, lines: ["Refusing APP_ENV=test: pass a real FIREBASE_PROJECT_ID and run with APP_ENV=local (or production). No request was sent."] };
  }
  let stores: Awaited<ReturnType<typeof parseStoresEnv>>;
  try {
    stores = await parseStoresEnv({ ...env, STORE_VERIFIER: "stores" });
  } catch (error) {
    // The messages name settings only (config.module.ts), never a value, a path or key content.
    return { code: 1, lines: [`${error instanceof Error ? error.message : "Invalid environment configuration."}. No request was sent.`] };
  }
  const report = new Report();
  if (env.STORE_VERIFIER?.trim() !== "stores") {
    report.warn("STORE_VERIFIER in the environment is not `stores`: the server will not use these settings (or will refuse to start)");
  }
  try {
    if (stores.google) await checkGoogle(fetchImpl, stores.google, report);
    if (stores.apple) await checkApple(fetchImpl, stores.apple, report);
  } catch {
    report.fail("the check stopped unexpectedly (no detail is printed)");
  }
  report.info(report.ok ? "stores check passed" : "stores check did NOT pass");
  return { code: report.ok ? 0 : 1, lines: report.lines };
}
