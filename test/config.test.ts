import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.module.js";

const local = {
  APP_ENV: "local",
  DATABASE_URL: "postgres://user:s3cret-pass@127.0.0.1:5433/db",
  FIREBASE_PROJECT_ID: "demo-airplane-games",
  ALLOW_EMULATOR_TOKENS: "true",
};

const production = {
  APP_ENV: "production",
  DATABASE_URL: "postgres://user:s3cret-pass@db.internal:5432/db",
  FIREBASE_PROJECT_ID: "airplane-games-auth-20261022",
};

function message(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("loadConfig did not throw");
}

describe("loadConfig", () => {
  it("accepts a valid local environment and applies defaults", () => {
    expect(loadConfig(local)).toEqual({
      appEnv: "local",
      databaseUrl: local.DATABASE_URL,
      firebaseProjectId: "demo-airplane-games",
      emulatorTokens: true,
      port: 3000,
      host: "127.0.0.1",
      dbPoolMax: 10,
    });
  });

  it("reads HOST, PORT and DB_POOL_MAX", () => {
    expect(loadConfig({ ...local, HOST: "0.0.0.0", PORT: "8080", DB_POOL_MAX: "25" })).toMatchObject({
      host: "0.0.0.0",
      port: 8080,
      dbPoolMax: 25,
    });
  });

  it("accepts production with the real project and no emulator tokens", () => {
    expect(loadConfig(production)).toMatchObject({ appEnv: "production", emulatorTokens: false });
  });

  it("rejects production with emulator tokens enabled", () => {
    expect(message({ ...production, ALLOW_EMULATOR_TOKENS: "true" })).toContain("ALLOW_EMULATOR_TOKENS");
    expect(message({ ...production, ALLOW_EMULATOR_TOKENS: " TRUE " })).toContain("ALLOW_EMULATOR_TOKENS");
  });

  it("rejects production with a demo- Firebase project", () => {
    const text = message({ ...production, FIREBASE_PROJECT_ID: "demo-airplane-games" });
    expect(text).toContain("FIREBASE_PROJECT_ID");
  });

  it("names every missing variable but never prints values", () => {
    const text = message({ DATABASE_URL: local.DATABASE_URL, FIREBASE_PROJECT_ID: "" });
    expect(text).toContain("APP_ENV");
    expect(text).toContain("FIREBASE_PROJECT_ID");
    expect(text).not.toContain("s3cret-pass");
    expect(text).not.toContain("postgres://");
  });

  it("rejects an unknown APP_ENV without echoing it", () => {
    const text = message({ ...local, APP_ENV: "staging-secret-value" });
    expect(text).toContain("APP_ENV");
    expect(text).not.toContain("staging-secret-value");
  });
});
