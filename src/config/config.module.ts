import { createPrivateKey } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Global, Module } from "@nestjs/common";
import { importPKCS8 } from "jose";
import { parse as parseConnectionString } from "pg-connection-string";
import { z } from "zod";
import { accountPrincipalFor } from "../accounts/account-principal.js";
import { emulatorTokensAllowed } from "../auth/firebase.js";

export const APP_CONFIG = Symbol("APP_CONFIG");

export type AppEnv = "local" | "test" | "production";

export type AppConfig = {
  appEnv: AppEnv;
  databaseUrl: string;
  firebaseProjectId: string;
  /** Unsigned Auth Emulator tokens accepted. True only for exactly demo-airplane-games. */
  emulatorTokens: boolean;
  port: number;
  /** Interface to listen on. Loopback by default; a deployment must opt in to anything wider. */
  host: string;
  /** Maximum pg pool connections. */
  dbPoolMax: number;
  /** Size of the rate limiter's own pool (used when rateLimitStore is postgres). */
  rateLimitPoolMax: number;
  /** TLS to Postgres. verify-full checks the certificate chain and hostname; require encrypts only. */
  databaseSsl: DatabaseSsl;
  /** PEM bundle trusted for the Postgres server certificate (verify-full only). Undefined = system roots. */
  databaseCaCert: string | undefined;
  /** Express `trust proxy`: false (use the socket address) or how many proxy hops to trust. */
  trustProxy: false | number;
  /** Total SIGTERM budget: pre-stop wait plus draining in-flight requests, then the process exits anyway. */
  shutdownDrainMs: number;
  /** Part of that budget spent serving /ready as 503 before the listener closes, so load balancers notice. */
  shutdownPrestopMs: number;
  /** Requests per minute per verified principal, and per client IP on public routes. */
  rateLimitAuthPerMin: number;
  rateLimitPublicPerMin: number;
  /** Where rate-limit counters live: postgres = shared by every instance (default), memory = per process. */
  rateLimitStore: RateLimitStoreKind;
  /** Lowest accepted X-Client-Version build number. Undefined = the gate is off. */
  minClientBuild: number | undefined;
  /** Where admin-uploaded files go: none = refuse (503), memory = process-local (local/test only), bunny = Bunny Storage. */
  blobStore: BlobStoreKind;
  /** Store-receipt verifier for purchases (docs/plans/purchases.md). `fake` only outside production and on a test or demo- project. */
  storeVerifier: StoreVerifierKind;
  /** Present only with STORE_VERIFIER=stores and every APPLE_* setting given. Holds a private key: never log or echo it. */
  apple: AppleStoreConfig | undefined;
  /** Present only with STORE_VERIFIER=stores and every GOOGLE_PLAY_* setting given. Holds a private key: never log or echo it. */
  google: GoogleStoreConfig | undefined;
  /** Present only when blobStore is "bunny". The password is a secret: never log or echo it. */
  bunny: BunnyConfig | undefined;
  /** Present only when both BUNNY_CDN_* settings are given; without it image previews carry `url: null` (reason `cdn_not_configured`). */
  cdn: CdnConfig | undefined;
  /** Present only when every UGS_* setting is given: the one-way progress mirror to Unity Gaming Services. */
  ugs: UgsConfig | undefined;
  /**
   * `firebase:<FIREBASE_PROJECT_ID>:<DEMO_ACCOUNT_UID>` of the shared demo account (a password handed to testers), or undefined
   * when none is configured. It can never hold `photographer` or `admin` (ADR-0002 follow-up, incident 2026-11-04). Not a secret,
   * but nothing needs it in logs.
   */
  demoPrincipal?: string | undefined;
};

export type AppleStoreConfig = {
  bundleId: string;
  /** App Store Connect In-App Purchase key id (10 upper-case letters or digits). */
  keyId: string;
  issuerId: string;
  /** Numeric Apple id of the app (App Store Connect); the production verifier needs it in every APP_ENV. */
  appAppleId: number;
  /** PKCS#8 PEM of the .p8 key (ES256). A secret. */
  privateKeyPem: string;
};

export type GoogleStoreConfig = {
  packageName: string;
  /** Service-account email (not a secret; it is logged at start-up). */
  clientEmail: string;
  privateKeyId: string;
  /** PKCS#8 PEM of the service-account key (RS256). A secret. */
  privateKeyPem: string;
};

export type UgsConfig = {
  projectId: string;
  environmentId: string;
  /** Service account key id (Basic auth user). */
  serviceAccountKeyId: string;
  /** Service account secret (Basic auth password): never log or echo it. */
  serviceAccountSecret: string;
  /** Player Auth OIDC provider id (for example oidc-firebase) the Firebase link is proven against. */
  oidcProvider: string;
  /** Mirror writes per minute (token bucket). UGS admin APIs allow about 33/min sustained per project and IP. */
  mirrorMaxPerMin: number;
  /** Least seconds between two Cloud Save copy writes for one player (C3); 0 disables the delay. Deletions are never delayed. */
  mirrorMinIntervalSec: number;
};

export type RateLimitStoreKind = "postgres" | "memory";

export type BlobStoreKind = "none" | "memory" | "bunny";
/** Which store-receipt verifier POST /v1/purchases uses. `none` answers 503 store_unavailable; `fake` is the deterministic test double (never in production). */
export type StoreVerifierKind = "none" | "fake" | "stores";

export type BunnyConfig = {
  zone: string;
  password: string;
  /** Bunny Storage region code; the S3 endpoint is https://<region>-s3.storage.bunnycdn.com. */
  region: BunnyRegion;
  /** Key prefix inside the (shared) zone, always ending in "/". */
  prefix: string;
};

export type CdnConfig = {
  /** Plain hostname of the token-protected pull zone, for example `name.b-cdn.net`. */
  host: string;
  /** Bunny advanced token authentication security key. A secret: never log or echo it. */
  tokenKey: string;
};

export const BUNNY_REGIONS = ["de", "ny", "la", "sg", "syd", "uk", "se", "jh"] as const;
export type BunnyRegion = (typeof BUNNY_REGIONS)[number];

export type DatabaseSsl = "disable" | "require" | "verify-full";

/** Optional env integer: unset or empty means "not set". */
const optionalInt = (min: number, max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(min).max(max).optional(),
  );

/** "false" (or unset) or a proxy hop count. `true` and address lists are refused: trusting every hop lets a client spoof its IP. */
const trustProxySchema = z
  .string()
  .trim()
  .regex(/^(false|[1-9]\d?)$/)
  .transform((value): false | number => (value === "false" ? false : Number(value)));

/**
 * Connection string parameters that would override DATABASE_SSL, because pg lets the connection string
 * win. Parsed with the same parser pg uses, which also accepts forms `new URL()` rejects (for example an
 * empty host, `postgres://u:p@/db?host=h&sslmode=disable`). Fails closed: unparseable counts as set.
 */
const URL_SSL_PARAMS = ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslnegotiation", "uselibpqcompat"];

function databaseUrlSetsSsl(databaseUrl: string): boolean {
  try {
    const parsed = parseConnectionString(databaseUrl) as Record<string, unknown>;
    return URL_SSL_PARAMS.some((name) => name in parsed);
  } catch {
    return true;
  }
}

/** Trimmed env string where unset and empty mean "not set". */
const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional(),
);

/** Ids that end up in UGS URL paths: restricted so nothing can alter the path. */
const UGS_ID = /^[A-Za-z0-9-]{1,64}$/;
const UGS_OIDC_PROVIDER = /^oidc-[a-z0-9_-]{1,15}$/;
/** Basic auth is `keyId:secret`, so the key id can contain neither a colon nor whitespace. */
const UGS_KEY_ID = /^[^\s:]{1,128}$/;

/** Same zone-name rule as the website's Bunny client. */
const BUNNY_ZONE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Relative key prefix: lowercase segments joined and ended by "/", so no leading "/", no "//", no "..". */
const BUNNY_PREFIX = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\/$/;

/** Plain lower-case hostname (no scheme, port, path or userinfo), the shape the CDN link signer accepts. */
const CDN_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** The security key is a printable token without whitespace; Bunny's are 36-character GUIDs, so 16 is a floor, not a format. */
const CDN_TOKEN_KEY = /^[!-~]{16,256}$/;

const envSchema = z.object({
  /** Where this process runs. Required, so a deployment can never fall back to local behaviour. */
  APP_ENV: z.enum(["local", "test", "production"]),
  DATABASE_URL: z.string().min(1),
  FIREBASE_PROJECT_ID: z.string().trim().min(1),
  /** "true" accepts unsigned Auth Emulator tokens, and only for demo-airplane-games. Local only. */
  ALLOW_EMULATOR_TOKENS: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  RATE_LIMIT_POOL_MAX: z.coerce.number().int().min(1).max(10).default(3),
  /** Default depends on APP_ENV (verify-full in production), so it is applied after parsing. */
  DATABASE_SSL: z.enum(["disable", "require", "verify-full"]).optional(),
  /** PEM text. Literal backslash-n sequences are accepted for platforms that cannot hold multi-line values. */
  DATABASE_CA_CERT: z.string().trim().optional(),
  TRUST_PROXY: trustProxySchema.default(false),
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
  /** Default depends on APP_ENV (5 s in production), so it is applied after parsing. */
  SHUTDOWN_PRESTOP_MS: optionalInt(0, 60_000),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(1).max(100_000).default(120),
  RATE_LIMIT_PUBLIC_PER_MIN: z.coerce.number().int().min(1).max(100_000).default(60),
  /** postgres (default, correct with several instances) or memory (one instance only). */
  RATE_LIMIT_STORE: z.enum(["postgres", "memory"]).default("postgres"),
  MIN_CLIENT_BUILD: optionalInt(1, 999_999_999),
  /** Default depends on APP_ENV (memory locally, none in production), so it is applied after parsing. */
  BLOB_STORE: z.enum(["none", "memory", "bunny"]).optional(),
  /** none (default: purchases answer 503) | fake (deterministic test double; refused in production and unless FIREBASE_PROJECT_ID starts with demo-) | stores (Apple and/or Google). */
  STORE_VERIFIER: z.enum(["none", "fake", "stores"]).default("none"),
  /** Production with stores: the stores that must be live (comma list of apple, google), matching the configured ones. */
  STORE_ENABLED: optionalText,
  APPLE_BUNDLE_ID: optionalText,
  APPLE_IAP_KEY_ID: optionalText,
  APPLE_IAP_ISSUER_ID: optionalText,
  APPLE_APP_APPLE_ID: optionalText,
  APPLE_IAP_KEY_FILE: optionalText,
  APPLE_IAP_KEY: optionalText,
  GOOGLE_PLAY_PACKAGE_NAME: optionalText,
  GOOGLE_PLAY_SERVICE_ACCOUNT_FILE: optionalText,
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: optionalText,
  BUNNY_STORAGE_ZONE: z.string().trim().optional(),
  /** Not trimmed: a password is used byte for byte. Blank (whitespace only) counts as unset. */
  BUNNY_STORAGE_PASSWORD: z.string().optional(),
  /** Defaults (de, backend/) are applied only for BLOB_STORE=bunny, so "was it set at all" stays visible. */
  BUNNY_STORAGE_REGION: z.enum(BUNNY_REGIONS).optional(),
  BUNNY_STORAGE_PREFIX: z.string().trim().optional(),
  /** Pull zone hostname and token key for signed image links: both or neither (docs/adr/ADR-0001). Blank counts as unset. */
  BUNNY_CDN_HOST: optionalText,
  BUNNY_CDN_TOKEN_KEY: optionalText,
  /** UGS progress mirror: all-or-none (UGS_MIRROR_MAX_PER_MIN and UGS_MIRROR_MIN_INTERVAL_SEC are optional with defaults). */
  UGS_PROJECT_ID: optionalText,
  UGS_ENVIRONMENT_ID: optionalText,
  UGS_SERVICE_ACCOUNT_KEY_ID: optionalText,
  UGS_SERVICE_ACCOUNT_SECRET: optionalText,
  UGS_OIDC_PROVIDER: optionalText,
  UGS_MIRROR_MAX_PER_MIN: optionalInt(1, 33),
  UGS_MIRROR_MIN_INTERVAL_SEC: optionalInt(0, 3600),
  /** Firebase uid of the website's shared demo account. Optional; when set, that account can never hold photographer/admin. */
  DEMO_ACCOUNT_UID: optionalText,
});

/** Parse the environment once. Fails fast, naming the bad variables but never their values. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid environment configuration: ${names.join(", ")}`);
  }
  const {
    APP_ENV,
    DATABASE_URL,
    FIREBASE_PROJECT_ID,
    ALLOW_EMULATOR_TOKENS,
    PORT,
    HOST,
    DB_POOL_MAX,
    RATE_LIMIT_POOL_MAX,
    DATABASE_CA_CERT,
    TRUST_PROXY,
    SHUTDOWN_DRAIN_MS,
    SHUTDOWN_PRESTOP_MS,
    RATE_LIMIT_AUTH_PER_MIN,
    RATE_LIMIT_PUBLIC_PER_MIN,
    RATE_LIMIT_STORE,
    MIN_CLIENT_BUILD,
    STORE_VERIFIER,
    BUNNY_STORAGE_ZONE,
    BUNNY_STORAGE_PASSWORD,
    BUNNY_STORAGE_REGION,
    BUNNY_STORAGE_PREFIX,
    BUNNY_CDN_HOST,
    BUNNY_CDN_TOKEN_KEY,
    UGS_PROJECT_ID,
    UGS_ENVIRONMENT_ID,
    UGS_SERVICE_ACCOUNT_KEY_ID,
    UGS_SERVICE_ACCOUNT_SECRET,
    UGS_OIDC_PROVIDER,
    UGS_MIRROR_MAX_PER_MIN,
    UGS_MIRROR_MIN_INTERVAL_SEC,
    DEMO_ACCOUNT_UID,
  } = parsed.data;
  const databaseSsl: DatabaseSsl = parsed.data.DATABASE_SSL ?? (APP_ENV === "production" ? "verify-full" : "disable");
  const caCert = DATABASE_CA_CERT ? DATABASE_CA_CERT.replace(/\\n/g, "\n") : undefined;
  const prestopMs = SHUTDOWN_PRESTOP_MS ?? (APP_ENV === "production" ? 5000 : 0);
  if (prestopMs >= SHUTDOWN_DRAIN_MS) {
    throw new Error("Invalid environment configuration: SHUTDOWN_PRESTOP_MS must be less than SHUTDOWN_DRAIN_MS");
  }
  if (databaseUrlSetsSsl(DATABASE_URL)) {
    throw new Error("Invalid environment configuration: DATABASE_URL must not set ssl options; use DATABASE_SSL");
  }
  if (caCert !== undefined) {
    if (databaseSsl !== "verify-full") {
      throw new Error("Invalid environment configuration: DATABASE_CA_CERT needs DATABASE_SSL=verify-full");
    }
    if (!caCert.includes("-----BEGIN CERTIFICATE-----")) {
      throw new Error("Invalid environment configuration: DATABASE_CA_CERT is not PEM");
    }
  }
  if (APP_ENV === "production") {
    // Only verify-full: a private CA is covered by DATABASE_CA_CERT, so there is no reason to skip verification.
    if (databaseSsl !== "verify-full") {
      throw new Error("Invalid environment configuration: DATABASE_SSL must be verify-full when APP_ENV=production");
    }
    // Names only, never values. Production must verify real signatures against the real project.
    if (ALLOW_EMULATOR_TOKENS?.trim().toLowerCase() === "true") {
      throw new Error("Invalid environment configuration: ALLOW_EMULATOR_TOKENS is not allowed when APP_ENV=production");
    }
    if (FIREBASE_PROJECT_ID.startsWith("demo-")) {
      throw new Error("Invalid environment configuration: FIREBASE_PROJECT_ID must not be a demo- project when APP_ENV=production");
    }
  }
  // The fake verifier accepts any reference that names an "ok" outcome, so it must not run where real money or real accounts exist:
  // never in production, and in every APP_ENV only against a demo- project (same shape as the emulator-token rule). Names only.
  if (STORE_VERIFIER === "fake" && (APP_ENV === "production" || !FIREBASE_PROJECT_ID.startsWith("demo-"))) {
    throw new Error("Invalid environment configuration: STORE_VERIFIER=fake is not allowed in production or with a real FIREBASE_PROJECT_ID");
  }
  const { apple, google } = parseStoresConfig(parsed.data, APP_ENV, FIREBASE_PROJECT_ID);
  const blobStore: BlobStoreKind = parsed.data.BLOB_STORE ?? (APP_ENV === "production" ? "none" : "memory");
  if (APP_ENV === "production" && blobStore === "memory") {
    throw new Error("Invalid environment configuration: BLOB_STORE=memory is not allowed when APP_ENV=production");
  }
  let bunny: BunnyConfig | undefined;
  const passwordGiven = (BUNNY_STORAGE_PASSWORD ?? "").trim() !== "";
  if (blobStore !== "bunny") {
    // A half-configured Bunny store is a mistake worth failing on, not silently ignoring. Names only.
    const stray = [
      ...(BUNNY_STORAGE_ZONE ? ["BUNNY_STORAGE_ZONE"] : []),
      ...(passwordGiven ? ["BUNNY_STORAGE_PASSWORD"] : []),
      ...(BUNNY_STORAGE_REGION !== undefined ? ["BUNNY_STORAGE_REGION"] : []),
      ...(BUNNY_STORAGE_PREFIX ? ["BUNNY_STORAGE_PREFIX"] : []),
    ];
    if (stray.length > 0) {
      throw new Error(`Invalid environment configuration: ${stray.join(", ")} set but BLOB_STORE is not bunny`);
    }
  } else {
    // Names only, never values: the password must not appear in any error.
    const missing = [
      ...(BUNNY_STORAGE_ZONE ? [] : ["BUNNY_STORAGE_ZONE"]),
      ...(passwordGiven ? [] : ["BUNNY_STORAGE_PASSWORD"]),
    ];
    if (missing.length > 0) {
      throw new Error(`Invalid environment configuration: ${missing.join(", ")} required when BLOB_STORE=bunny`);
    }
    if (!BUNNY_ZONE.test(BUNNY_STORAGE_ZONE ?? "")) {
      throw new Error("Invalid environment configuration: BUNNY_STORAGE_ZONE");
    }
    const prefix = BUNNY_STORAGE_PREFIX || "backend/";
    if (!BUNNY_PREFIX.test(prefix)) {
      throw new Error(
        "Invalid environment configuration: BUNNY_STORAGE_PREFIX must be lowercase [a-z0-9_-] segments ending in /",
      );
    }
    bunny = {
      zone: BUNNY_STORAGE_ZONE ?? "",
      password: BUNNY_STORAGE_PASSWORD ?? "",
      region: BUNNY_STORAGE_REGION ?? "de",
      prefix,
    };
  }
  // Both or neither, in every environment: signing needs the pair, and without it previews say so (no 500). Production
  // requires both, so published images never silently ship with url null. Names only.
  let cdn: CdnConfig | undefined;
  if (APP_ENV === "production" && BUNNY_CDN_HOST === undefined && BUNNY_CDN_TOKEN_KEY === undefined) {
    throw new Error("Invalid environment configuration: BUNNY_CDN_HOST, BUNNY_CDN_TOKEN_KEY required when APP_ENV=production");
  }
  if ((BUNNY_CDN_HOST === undefined) !== (BUNNY_CDN_TOKEN_KEY === undefined)) {
    const missing = BUNNY_CDN_HOST === undefined ? "BUNNY_CDN_HOST" : "BUNNY_CDN_TOKEN_KEY";
    throw new Error(`Invalid environment configuration: ${missing} required when the other BUNNY_CDN_* setting is given`);
  }
  if (BUNNY_CDN_HOST !== undefined && BUNNY_CDN_TOKEN_KEY !== undefined) {
    const bad = [...(CDN_HOST.test(BUNNY_CDN_HOST) ? [] : ["BUNNY_CDN_HOST"]), ...(CDN_TOKEN_KEY.test(BUNNY_CDN_TOKEN_KEY) ? [] : ["BUNNY_CDN_TOKEN_KEY"])];
    if (bad.length > 0) throw new Error(`Invalid environment configuration: ${bad.join(", ")}`);
    cdn = { host: BUNNY_CDN_HOST, tokenKey: BUNNY_CDN_TOKEN_KEY };
  }
  // The signer's path allow-list (src/platform/cdn-signer.ts) is /backend/content/photos/..., i.e. tied to the default storage
  // prefix: with another prefix the files would be stored where signed links do not point.
  if (cdn !== undefined && bunny !== undefined && bunny.prefix !== "backend/") {
    throw new Error("Invalid environment configuration: BUNNY_STORAGE_PREFIX must be backend/ when BUNNY_CDN_* is configured");
  }
  const ugs = parseUgsConfig({
    UGS_PROJECT_ID,
    UGS_ENVIRONMENT_ID,
    UGS_SERVICE_ACCOUNT_KEY_ID,
    UGS_SERVICE_ACCOUNT_SECRET,
    UGS_OIDC_PROVIDER,
    UGS_MIRROR_MAX_PER_MIN,
    UGS_MIRROR_MIN_INTERVAL_SEC,
  });
  // UGS settings point at a real project: a demo player must never write a copy there. Tests use fake settings and a
  // stubbed fetcher, and vitest.e2e.config.ts drops any real ones read from .env. Names only.
  if (ugs !== undefined && APP_ENV !== "test" && FIREBASE_PROJECT_ID.startsWith("demo-")) {
    throw new Error("Invalid environment configuration: UGS_* settings are not allowed with a demo- FIREBASE_PROJECT_ID");
  }
  // Same uid rules as every principal (1-128 characters, no ':' or '/', no control characters). Name only, never the value.
  let demoPrincipal: string | undefined;
  if (DEMO_ACCOUNT_UID !== undefined) {
    demoPrincipal = accountPrincipalFor(DEMO_ACCOUNT_UID, FIREBASE_PROJECT_ID);
    if (demoPrincipal === undefined) throw new Error("Invalid environment configuration: DEMO_ACCOUNT_UID");
  }
  return {
    appEnv: APP_ENV,
    databaseUrl: DATABASE_URL,
    firebaseProjectId: FIREBASE_PROJECT_ID,
    emulatorTokens: emulatorTokensAllowed(FIREBASE_PROJECT_ID, ALLOW_EMULATOR_TOKENS),
    port: PORT,
    host: HOST,
    dbPoolMax: DB_POOL_MAX,
    rateLimitPoolMax: RATE_LIMIT_POOL_MAX,
    databaseSsl,
    databaseCaCert: caCert,
    trustProxy: TRUST_PROXY,
    shutdownDrainMs: SHUTDOWN_DRAIN_MS,
    shutdownPrestopMs: prestopMs,
    rateLimitAuthPerMin: RATE_LIMIT_AUTH_PER_MIN,
    rateLimitPublicPerMin: RATE_LIMIT_PUBLIC_PER_MIN,
    rateLimitStore: RATE_LIMIT_STORE,
    minClientBuild: MIN_CLIENT_BUILD,
    blobStore,
    storeVerifier: STORE_VERIFIER,
    apple,
    google,
    bunny,
    cdn,
    ugs,
    demoPrincipal,
  };
}

const STORE_NAMES = ["apple", "google"] as const;
const APPLE_KEY_ID = /^[A-Z0-9]{10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPLE_BUNDLE_ID = /^(?=.{3,155}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const APPLE_APP_APPLE_ID = /^[1-9][0-9]{0,14}$/;
const ANDROID_PACKAGE = /^(?=.{3,255}$)[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SERVICE_ACCOUNT_EMAIL = /^[^\s@:/]{1,100}@[A-Za-z0-9.-]{1,200}$/;
const PRIVATE_KEY_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Name-only error for every store setting problem, so no key content or file content can reach a message. */
function storeConfigError(detail: string): Error {
  return new Error(`Invalid environment configuration: ${detail}`);
}

type StoreEnv = {
  STORE_VERIFIER: StoreVerifierKind;
  STORE_ENABLED?: string | undefined;
  APPLE_BUNDLE_ID?: string | undefined;
  APPLE_IAP_KEY_ID?: string | undefined;
  APPLE_IAP_ISSUER_ID?: string | undefined;
  APPLE_APP_APPLE_ID?: string | undefined;
  APPLE_IAP_KEY_FILE?: string | undefined;
  APPLE_IAP_KEY?: string | undefined;
  GOOGLE_PLAY_PACKAGE_NAME?: string | undefined;
  GOOGLE_PLAY_SERVICE_ACCOUNT_FILE?: string | undefined;
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?: string | undefined;
};

const INSIDE_REPO = "must point outside the working directory";

/** True when `real` is a root itself or below it. A file named `..key.p8` inside a root is inside (only `..` or `../` segments leave). */
export function isInsideAnyRoot(real: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, real);
    const outside = rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
    return !outside;
  });
}

/** The repo root from this module's location (src/config or dist/config, both two levels below it). */
function repoRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

/** A key file must sit outside the repo (both the working directory and the repo root), so a key can never be where git or the Docker context sees it. */
function readKeyFile(setting: string, path: string): string {
  let real: string;
  try {
    real = realpathSync(resolve(path));
    if (isInsideAnyRoot(real, [realpathSync(process.cwd()), realpathSync(repoRoot())])) real = "";
  } catch {
    throw storeConfigError(setting);
  }
  if (real === "") throw storeConfigError(`${setting} ${INSIDE_REPO}`);
  try {
    return readFileSync(real, "utf8");
  } catch {
    // No cause, no path: a read error names only the setting.
    throw storeConfigError(setting);
  }
}

/** Sync shape check of a PKCS#8 PEM; the async jose import follows in `importStoreKeys`. */
function checkPem(setting: string, pem: string, type: "ec" | "rsa"): void {
  let ok = false;
  try {
    if (pem.includes("-----BEGIN PRIVATE KEY-----")) {
      const key = createPrivateKey({ key: pem, format: "pem" });
      ok = key.asymmetricKeyType === type && (type !== "ec" || key.asymmetricKeyDetails?.namedCurve === "prime256v1");
    }
  } catch {
    ok = false;
  }
  if (!ok) throw storeConfigError(setting);
}

function parseStoresConfig(
  env: StoreEnv,
  appEnv: AppEnv,
  firebaseProjectId: string,
): { apple: AppleStoreConfig | undefined; google: GoogleStoreConfig | undefined } {
  const appleNames = ["APPLE_BUNDLE_ID", "APPLE_IAP_KEY_ID", "APPLE_IAP_ISSUER_ID", "APPLE_APP_APPLE_ID", "APPLE_IAP_KEY_FILE", "APPLE_IAP_KEY"] as const;
  const googleNames = ["GOOGLE_PLAY_PACKAGE_NAME", "GOOGLE_PLAY_SERVICE_ACCOUNT_FILE", "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"] as const;
  const appleGiven = appleNames.filter((name) => env[name] !== undefined);
  const googleGiven = googleNames.filter((name) => env[name] !== undefined);

  let enabled: Set<string> | undefined;
  if (env.STORE_ENABLED !== undefined) {
    const parts = env.STORE_ENABLED.split(",").map((part) => part.trim());
    if (!parts.every((part) => (STORE_NAMES as readonly string[]).includes(part))) throw storeConfigError("STORE_ENABLED");
    enabled = new Set(parts);
  }

  if (env.STORE_VERIFIER !== "stores") {
    // Same rule as the Bunny settings: a half-wired store is a mistake worth failing on. Names only.
    const stray = [...appleGiven, ...googleGiven];
    if (stray.length > 0) throw storeConfigError(`${stray.join(", ")} set but STORE_VERIFIER is not stores`);
    return { apple: undefined, google: undefined };
  }
  if (appleGiven.length === 0 && googleGiven.length === 0) {
    throw storeConfigError("STORE_VERIFIER=stores needs the APPLE_* or GOOGLE_PLAY_* settings of at least one store");
  }
  // Like the UGS rule: real store settings never run under a demo- project (tests set APP_ENV=test).
  if (appEnv !== "test" && firebaseProjectId.startsWith("demo-")) {
    throw storeConfigError("STORE_VERIFIER=stores is not allowed with a demo- FIREBASE_PROJECT_ID");
  }

  let apple: AppleStoreConfig | undefined;
  if (appleGiven.length > 0) {
    const missing = [
      ...(["APPLE_BUNDLE_ID", "APPLE_IAP_KEY_ID", "APPLE_IAP_ISSUER_ID", "APPLE_APP_APPLE_ID"] as const).filter((name) => env[name] === undefined),
      ...(env.APPLE_IAP_KEY_FILE === undefined && env.APPLE_IAP_KEY === undefined ? ["APPLE_IAP_KEY_FILE or APPLE_IAP_KEY"] : []),
    ];
    if (missing.length > 0) throw storeConfigError(`${missing.join(", ")} required when any APPLE_* setting is given`);
    if (env.APPLE_IAP_KEY_FILE !== undefined && env.APPLE_IAP_KEY !== undefined) {
      throw storeConfigError("APPLE_IAP_KEY_FILE, APPLE_IAP_KEY: set exactly one");
    }
    const bad = [
      ...(APPLE_BUNDLE_ID.test(env.APPLE_BUNDLE_ID ?? "") ? [] : ["APPLE_BUNDLE_ID"]),
      ...(APPLE_KEY_ID.test(env.APPLE_IAP_KEY_ID ?? "") ? [] : ["APPLE_IAP_KEY_ID"]),
      ...(UUID.test(env.APPLE_IAP_ISSUER_ID ?? "") ? [] : ["APPLE_IAP_ISSUER_ID"]),
      ...(APPLE_APP_APPLE_ID.test(env.APPLE_APP_APPLE_ID ?? "") ? [] : ["APPLE_APP_APPLE_ID"]),
    ];
    if (bad.length > 0) throw storeConfigError(bad.join(", "));
    const setting = env.APPLE_IAP_KEY_FILE !== undefined ? "APPLE_IAP_KEY_FILE" : "APPLE_IAP_KEY";
    const pem = env.APPLE_IAP_KEY_FILE !== undefined ? readKeyFile(setting, env.APPLE_IAP_KEY_FILE) : (env.APPLE_IAP_KEY ?? "").replace(/\\n/g, "\n");
    checkPem(setting, pem, "ec");
    apple = {
      bundleId: env.APPLE_BUNDLE_ID ?? "",
      keyId: env.APPLE_IAP_KEY_ID ?? "",
      issuerId: env.APPLE_IAP_ISSUER_ID ?? "",
      appAppleId: Number(env.APPLE_APP_APPLE_ID),
      privateKeyPem: pem,
    };
  }

  let google: GoogleStoreConfig | undefined;
  if (googleGiven.length > 0) {
    const missing = [
      ...(env.GOOGLE_PLAY_PACKAGE_NAME === undefined ? ["GOOGLE_PLAY_PACKAGE_NAME"] : []),
      ...(env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE === undefined && env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON === undefined
        ? ["GOOGLE_PLAY_SERVICE_ACCOUNT_FILE or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"]
        : []),
    ];
    if (missing.length > 0) throw storeConfigError(`${missing.join(", ")} required when any GOOGLE_PLAY_* setting is given`);
    if (env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE !== undefined && env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON !== undefined) {
      throw storeConfigError("GOOGLE_PLAY_SERVICE_ACCOUNT_FILE, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: set exactly one");
    }
    if (!ANDROID_PACKAGE.test(env.GOOGLE_PLAY_PACKAGE_NAME ?? "")) throw storeConfigError("GOOGLE_PLAY_PACKAGE_NAME");
    const setting = env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE !== undefined ? "GOOGLE_PLAY_SERVICE_ACCOUNT_FILE" : "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON";
    const text = env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE !== undefined ? readKeyFile(setting, env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE) : (env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ?? "");
    let json: Record<string, unknown> | undefined;
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) json = value as Record<string, unknown>;
    } catch {
      // V8 JSON.parse messages quote the input, so nothing of the caught error is carried.
      json = undefined;
    }
    const { type, client_email: clientEmail, private_key_id: privateKeyId, private_key: privateKey } = json ?? {};
    if (
      type !== "service_account" ||
      typeof clientEmail !== "string" ||
      !SERVICE_ACCOUNT_EMAIL.test(clientEmail) ||
      typeof privateKeyId !== "string" ||
      !PRIVATE_KEY_ID.test(privateKeyId) ||
      typeof privateKey !== "string"
    ) {
      throw storeConfigError(setting);
    }
    checkPem(setting, privateKey, "rsa");
    google = { packageName: env.GOOGLE_PLAY_PACKAGE_NAME ?? "", clientEmail, privateKeyId, privateKeyPem: privateKey };
  }

  // Production: a forgotten store must fail at start, not leave its purchases pending. STORE_ENABLED names the stores that must be live.
  if (appEnv === "production") {
    if (enabled === undefined) throw storeConfigError("STORE_ENABLED required when APP_ENV=production and STORE_VERIFIER=stores");
    const configured = new Set<string>([...(apple ? ["apple"] : []), ...(google ? ["google"] : [])]);
    if (configured.size !== enabled.size || [...configured].some((name) => !enabled.has(name))) {
      throw storeConfigError("STORE_ENABLED does not match the configured stores");
    }
  }
  return { apple, google };
}

/**
 * Import the configured keys with jose (ES256 for the Apple .p8, RS256 for the Google key), the call the adapters make.
 * `loadConfig` is synchronous and has already checked shape and key type; this proves the import, at start (ConfigModule factory).
 * Errors carry the setting name only, never a cause or key content.
 */
export async function importStoreKeys(config: Pick<AppConfig, "apple" | "google">): Promise<void> {
  if (config.apple) {
    try {
      await importPKCS8(config.apple.privateKeyPem, "ES256");
    } catch {
      throw storeConfigError("APPLE_IAP_KEY_FILE or APPLE_IAP_KEY");
    }
  }
  if (config.google) {
    try {
      await importPKCS8(config.google.privateKeyPem, "RS256");
    } catch {
      throw storeConfigError("GOOGLE_PLAY_SERVICE_ACCOUNT_FILE or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
    }
  }
}

const UGS_REQUIRED = [
  "UGS_PROJECT_ID",
  "UGS_ENVIRONMENT_ID",
  "UGS_SERVICE_ACCOUNT_KEY_ID",
  "UGS_SERVICE_ACCOUNT_SECRET",
  "UGS_OIDC_PROVIDER",
] as const;

/** All-or-none. Errors name variables only, never values (the secret must not appear anywhere). */
function parseUgsConfig(
  env: Partial<Record<(typeof UGS_REQUIRED)[number], string>> & { UGS_MIRROR_MAX_PER_MIN?: number; UGS_MIRROR_MIN_INTERVAL_SEC?: number },
): UgsConfig | undefined {
  // The two tuning knobs are optional (defaults 25/min and 300 s) and not required to enable the mirror, but setting
  // either one alone counts as "given": a stray knob must not silently leave the mirror off.
  const given = UGS_REQUIRED.filter((name) => env[name] !== undefined);
  if (given.length === 0 && env.UGS_MIRROR_MAX_PER_MIN === undefined && env.UGS_MIRROR_MIN_INTERVAL_SEC === undefined) return undefined;
  const missing = UGS_REQUIRED.filter((name) => env[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Invalid environment configuration: ${missing.join(", ")} required when any UGS_* setting is given`);
  }
  const bad = [
    ...(UGS_ID.test(env.UGS_PROJECT_ID ?? "") ? [] : ["UGS_PROJECT_ID"]),
    ...(UGS_ID.test(env.UGS_ENVIRONMENT_ID ?? "") ? [] : ["UGS_ENVIRONMENT_ID"]),
    ...(UGS_KEY_ID.test(env.UGS_SERVICE_ACCOUNT_KEY_ID ?? "") ? [] : ["UGS_SERVICE_ACCOUNT_KEY_ID"]),
    ...(UGS_OIDC_PROVIDER.test(env.UGS_OIDC_PROVIDER ?? "") ? [] : ["UGS_OIDC_PROVIDER"]),
  ];
  if (bad.length > 0) throw new Error(`Invalid environment configuration: ${bad.join(", ")}`);
  return {
    projectId: env.UGS_PROJECT_ID ?? "",
    environmentId: env.UGS_ENVIRONMENT_ID ?? "",
    serviceAccountKeyId: env.UGS_SERVICE_ACCOUNT_KEY_ID ?? "",
    serviceAccountSecret: env.UGS_SERVICE_ACCOUNT_SECRET ?? "",
    oidcProvider: env.UGS_OIDC_PROVIDER ?? "",
    mirrorMaxPerMin: env.UGS_MIRROR_MAX_PER_MIN ?? 25,
    mirrorMinIntervalSec: env.UGS_MIRROR_MIN_INTERVAL_SEC ?? 300,
  };
}

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      // Async so the store keys are imported (jose) before the app serves anything; a bad key stops the start.
      useFactory: async (): Promise<AppConfig> => {
        const config = loadConfig(process.env);
        await importStoreKeys(config);
        return config;
      },
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
