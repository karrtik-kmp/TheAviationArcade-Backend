import { Global, Module } from "@nestjs/common";
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
};

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
});

/** Parse the environment once. Fails fast, naming the bad variables but never their values. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid environment configuration: ${names.join(", ")}`);
  }
  const { APP_ENV, DATABASE_URL, FIREBASE_PROJECT_ID, ALLOW_EMULATOR_TOKENS, PORT, HOST, DB_POOL_MAX } =
    parsed.data;
  if (APP_ENV === "production") {
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
  };
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
