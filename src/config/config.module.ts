import { Global, Module } from "@nestjs/common";
import { z } from "zod";
import { emulatorTokensAllowed } from "../auth/firebase.js";

export const APP_CONFIG = Symbol("APP_CONFIG");

export type AppConfig = {
  databaseUrl: string;
  firebaseProjectId: string;
  /** Unsigned Auth Emulator tokens accepted. True only for exactly demo-airplane-games. */
  emulatorTokens: boolean;
  port: number;
};

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  FIREBASE_PROJECT_ID: z.string().trim().min(1),
  /** "true" accepts unsigned Auth Emulator tokens, and only for demo-airplane-games. Local only. */
  ALLOW_EMULATOR_TOKENS: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

/** Parse the environment once. Fails fast, naming the bad variables but never their values. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid environment configuration: ${names.join(", ")}`);
  }
  const { DATABASE_URL, FIREBASE_PROJECT_ID, ALLOW_EMULATOR_TOKENS, PORT } = parsed.data;
  return {
    databaseUrl: DATABASE_URL,
    firebaseProjectId: FIREBASE_PROJECT_ID,
    emulatorTokens: emulatorTokensAllowed(FIREBASE_PROJECT_ID, ALLOW_EMULATOR_TOKENS),
    port: PORT,
  };
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
