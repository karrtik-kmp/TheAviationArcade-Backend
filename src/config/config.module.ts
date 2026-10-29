import { Global, Module } from "@nestjs/common";
import { parse as parseConnectionString } from "pg-connection-string";
import { z } from "zod";
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
  /** Lowest accepted X-Client-Version build number. Undefined = the gate is off. */
  minClientBuild: number | undefined;
  /** Lowercased emails that may call staff-only (admin) routes, together with a verified token email. Never logged. */
  staffEmails: readonly string[];
  /** Where staff-uploaded files go: none = refuse (503), memory = process-local (local/test only), bunny = Bunny Storage. */
  blobStore: BlobStoreKind;
  /** Present only when blobStore is "bunny". The password is a secret: never log or echo it. */
  bunny: BunnyConfig | undefined;
  /** Present only when every UGS_* setting is given: the one-way progress mirror to Unity Gaming Services. */
  ugs: UgsConfig | undefined;
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

export type BlobStoreKind = "none" | "memory" | "bunny";

export type BunnyConfig = {
  zone: string;
  password: string;
  /** Bunny Storage region code; the S3 endpoint is https://<region>-s3.storage.bunnycdn.com. */
  region: BunnyRegion;
  /** Key prefix inside the (shared) zone, always ending in "/". */
  prefix: string;
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

/** Comma-separated emails: trimmed, lowercased, empty entries dropped, duplicates removed. */
function parseStaffEmails(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  const emails = raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
  return [...new Set(emails)];
}

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
  MIN_CLIENT_BUILD: optionalInt(1, 999_999_999),
  /** Server-only allowlist for staff routes. Unset = nobody is staff. */
  STAFF_EMAILS: z.string().optional(),
  /** Default depends on APP_ENV (memory locally, none in production), so it is applied after parsing. */
  BLOB_STORE: z.enum(["none", "memory", "bunny"]).optional(),
  BUNNY_STORAGE_ZONE: z.string().trim().optional(),
  /** Not trimmed: a password is used byte for byte. Blank (whitespace only) counts as unset. */
  BUNNY_STORAGE_PASSWORD: z.string().optional(),
  /** Defaults (de, backend/) are applied only for BLOB_STORE=bunny, so "was it set at all" stays visible. */
  BUNNY_STORAGE_REGION: z.enum(BUNNY_REGIONS).optional(),
  BUNNY_STORAGE_PREFIX: z.string().trim().optional(),
  /** UGS progress mirror: all-or-none (UGS_MIRROR_MAX_PER_MIN and UGS_MIRROR_MIN_INTERVAL_SEC are optional with defaults). */
  UGS_PROJECT_ID: optionalText,
  UGS_ENVIRONMENT_ID: optionalText,
  UGS_SERVICE_ACCOUNT_KEY_ID: optionalText,
  UGS_SERVICE_ACCOUNT_SECRET: optionalText,
  UGS_OIDC_PROVIDER: optionalText,
  UGS_MIRROR_MAX_PER_MIN: optionalInt(1, 33),
  UGS_MIRROR_MIN_INTERVAL_SEC: optionalInt(0, 3600),
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
    DATABASE_CA_CERT,
    TRUST_PROXY,
    SHUTDOWN_DRAIN_MS,
    SHUTDOWN_PRESTOP_MS,
    RATE_LIMIT_AUTH_PER_MIN,
    RATE_LIMIT_PUBLIC_PER_MIN,
    MIN_CLIENT_BUILD,
    STAFF_EMAILS,
    BUNNY_STORAGE_ZONE,
    BUNNY_STORAGE_PASSWORD,
    BUNNY_STORAGE_REGION,
    BUNNY_STORAGE_PREFIX,
    UGS_PROJECT_ID,
    UGS_ENVIRONMENT_ID,
    UGS_SERVICE_ACCOUNT_KEY_ID,
    UGS_SERVICE_ACCOUNT_SECRET,
    UGS_OIDC_PROVIDER,
    UGS_MIRROR_MAX_PER_MIN,
    UGS_MIRROR_MIN_INTERVAL_SEC,
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
  const ugs = parseUgsConfig({
    UGS_PROJECT_ID,
    UGS_ENVIRONMENT_ID,
    UGS_SERVICE_ACCOUNT_KEY_ID,
    UGS_SERVICE_ACCOUNT_SECRET,
    UGS_OIDC_PROVIDER,
    UGS_MIRROR_MAX_PER_MIN,
    UGS_MIRROR_MIN_INTERVAL_SEC,
  });
  return {
    appEnv: APP_ENV,
    databaseUrl: DATABASE_URL,
    firebaseProjectId: FIREBASE_PROJECT_ID,
    emulatorTokens: emulatorTokensAllowed(FIREBASE_PROJECT_ID, ALLOW_EMULATOR_TOKENS),
    port: PORT,
    host: HOST,
    dbPoolMax: DB_POOL_MAX,
    databaseSsl,
    databaseCaCert: caCert,
    trustProxy: TRUST_PROXY,
    shutdownDrainMs: SHUTDOWN_DRAIN_MS,
    shutdownPrestopMs: prestopMs,
    rateLimitAuthPerMin: RATE_LIMIT_AUTH_PER_MIN,
    rateLimitPublicPerMin: RATE_LIMIT_PUBLIC_PER_MIN,
    minClientBuild: MIN_CLIENT_BUILD,
    staffEmails: parseStaffEmails(STAFF_EMAILS),
    blobStore,
    bunny,
    ugs,
  };
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
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
