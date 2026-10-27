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
};

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
  };
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
