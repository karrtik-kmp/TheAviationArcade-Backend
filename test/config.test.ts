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
      databaseSsl: "disable",
      databaseCaCert: undefined,
      trustProxy: false,
      shutdownDrainMs: 10_000,
      shutdownPrestopMs: 0,
      rateLimitAuthPerMin: 120,
      rateLimitPublicPerMin: 60,
      minClientBuild: undefined,
      staffEmails: [],
      blobStore: "memory",
      bunny: undefined,
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

  describe("DATABASE_SSL", () => {
    const CA = "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----";

    it("defaults to disable outside production and verify-full in production", () => {
      expect(loadConfig(local).databaseSsl).toBe("disable");
      expect(loadConfig(production).databaseSsl).toBe("verify-full");
    });

    it("accepts require and verify-full, and rejects anything else", () => {
      expect(loadConfig({ ...local, DATABASE_SSL: "require" }).databaseSsl).toBe("require");
      expect(message({ ...local, DATABASE_SSL: "prefer" })).toContain("DATABASE_SSL");
    });

    it("refuses anything but verify-full in production", () => {
      expect(message({ ...production, DATABASE_SSL: "disable" })).toContain("DATABASE_SSL");
      expect(message({ ...production, DATABASE_SSL: "require" })).toContain("DATABASE_SSL");
      expect(loadConfig({ ...production, DATABASE_SSL: "verify-full" }).databaseSsl).toBe("verify-full");
    });

    it("reads a PEM CA, turning literal backslash-n into newlines", () => {
      const config = loadConfig({ ...production, DATABASE_CA_CERT: CA });
      expect(config.databaseCaCert).toBe("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----");
    });

    it("rejects a CA that is not PEM or is set without verify-full, without echoing it", () => {
      const notPem = message({ ...production, DATABASE_CA_CERT: "hunter2-not-pem" });
      expect(notPem).toContain("DATABASE_CA_CERT");
      expect(notPem).not.toContain("hunter2");
      expect(message({ ...local, DATABASE_CA_CERT: CA })).toContain("DATABASE_CA_CERT");
    });

    it("rejects ssl options inside DATABASE_URL, which pg would let override DATABASE_SSL", () => {
      for (const query of ["sslmode=require", "ssl=true", "sslrootcert=x", "sslnegotiation=direct", "uselibpqcompat=true"]) {
        expect(message({ ...local, DATABASE_URL: `${local.DATABASE_URL}?${query}` }), query).toContain("DATABASE_URL");
      }
    });

    it("rejects them in the empty-host form that new URL() refuses but pg's parser accepts", () => {
      const url = "postgres://u:s3cret-pass@/db?host=dbhost&sslmode=disable";
      const text = message({ ...production, DATABASE_URL: url });
      expect(text).toContain("DATABASE_URL");
      expect(text).not.toContain("s3cret-pass");
    });

    it("accepts an empty-host URL without ssl parameters", () => {
      expect(loadConfig({ ...local, DATABASE_URL: "postgres://u:p@/db?host=dbhost" }).databaseSsl).toBe("disable");
    });
  });

  describe("TRUST_PROXY", () => {
    it("is off by default and accepts false or a hop count", () => {
      expect(loadConfig(local).trustProxy).toBe(false);
      expect(loadConfig({ ...local, TRUST_PROXY: "false" }).trustProxy).toBe(false);
      expect(loadConfig({ ...local, TRUST_PROXY: "1" }).trustProxy).toBe(1);
      expect(loadConfig({ ...local, TRUST_PROXY: "2" }).trustProxy).toBe(2);
    });

    it("refuses true, zero, negative and address lists (trusting every hop lets clients spoof their IP)", () => {
      for (const value of ["true", "0", "-1", "100", "1.5", "loopback", "10.0.0.0/8"]) {
        expect(message({ ...local, TRUST_PROXY: value }), value).toContain("TRUST_PROXY");
      }
    });
  });

  describe("limits and gates", () => {
    it("reads SHUTDOWN_DRAIN_MS and the rate limits", () => {
      expect(
        loadConfig({
          ...local,
          SHUTDOWN_DRAIN_MS: "20000",
          RATE_LIMIT_AUTH_PER_MIN: "300",
          RATE_LIMIT_PUBLIC_PER_MIN: "30",
        }),
      ).toMatchObject({ shutdownDrainMs: 20_000, rateLimitAuthPerMin: 300, rateLimitPublicPerMin: 30 });
      expect(message({ ...local, RATE_LIMIT_AUTH_PER_MIN: "0" })).toContain("RATE_LIMIT_AUTH_PER_MIN");
      expect(message({ ...local, SHUTDOWN_DRAIN_MS: "10" })).toContain("SHUTDOWN_DRAIN_MS");
    });

    it("SHUTDOWN_PRESTOP_MS defaults to 5 s in production and 0 elsewhere, and must be below the drain budget", () => {
      expect(loadConfig(production).shutdownPrestopMs).toBe(5000);
      expect(loadConfig(local).shutdownPrestopMs).toBe(0);
      expect(loadConfig({ ...local, SHUTDOWN_PRESTOP_MS: "3000" }).shutdownPrestopMs).toBe(3000);
      expect(message({ ...local, SHUTDOWN_PRESTOP_MS: "10000" })).toContain("SHUTDOWN_PRESTOP_MS");
      // Production default (5 s) with a drain budget that cannot hold it.
      expect(message({ ...production, SHUTDOWN_DRAIN_MS: "4000" })).toContain("SHUTDOWN_PRESTOP_MS");
    });

    it("MIN_CLIENT_BUILD: unset or empty means the gate is off; otherwise a positive integer", () => {
      expect(loadConfig(local).minClientBuild).toBeUndefined();
      expect(loadConfig({ ...local, MIN_CLIENT_BUILD: "" }).minClientBuild).toBeUndefined();
      expect(loadConfig({ ...local, MIN_CLIENT_BUILD: "42" }).minClientBuild).toBe(42);
      expect(loadConfig({ ...local, MIN_CLIENT_BUILD: "999999999" }).minClientBuild).toBe(999_999_999);
      for (const value of ["0", "-3", "1.5", "abc", "1000000000"]) {
        expect(message({ ...local, MIN_CLIENT_BUILD: value }), value).toContain("MIN_CLIENT_BUILD");
      }
    });
  });

  describe("STAFF_EMAILS", () => {
    it("is empty when unset or blank", () => {
      expect(loadConfig(local).staffEmails).toEqual([]);
      expect(loadConfig({ ...local, STAFF_EMAILS: "  ,, " }).staffEmails).toEqual([]);
    });

    it("trims, lowercases, drops empty entries and duplicates", () => {
      expect(loadConfig({ ...local, STAFF_EMAILS: " Josh@Example.com, ,hiren@KMPHITECH.com,josh@example.com," }).staffEmails).toEqual([
        "josh@example.com",
        "hiren@kmphitech.com",
      ]);
    });
  });

  describe("BLOB_STORE", () => {
    const bunny = {
      BLOB_STORE: "bunny",
      BUNNY_STORAGE_ZONE: "aviation-arcade-website",
      BUNNY_STORAGE_PASSWORD: "pw-secret-value-1",
    };

    it("defaults to memory outside production and none in production", () => {
      expect(loadConfig(local).blobStore).toBe("memory");
      expect(loadConfig({ ...local, APP_ENV: "test" }).blobStore).toBe("memory");
      expect(loadConfig(production).blobStore).toBe("none");
    });

    it("refuses memory in production, and unknown kinds", () => {
      expect(message({ ...production, BLOB_STORE: "memory" })).toContain("BLOB_STORE");
      expect(message({ ...local, BLOB_STORE: "s3" })).toContain("BLOB_STORE");
      expect(loadConfig({ ...production, BLOB_STORE: "none" }).blobStore).toBe("none");
    });

    it("bunny needs a zone and a password, and names the missing one without values", () => {
      expect(message({ ...local, BLOB_STORE: "bunny", BUNNY_STORAGE_PASSWORD: "pw-secret-value-1" })).toContain("BUNNY_STORAGE_ZONE");
      const text = message({ ...local, BLOB_STORE: "bunny", BUNNY_STORAGE_ZONE: "aviation-arcade-website" });
      expect(text).toContain("BUNNY_STORAGE_PASSWORD");
      expect(message({ ...local, BLOB_STORE: "bunny", BUNNY_STORAGE_ZONE: "aviation-arcade-website", BUNNY_STORAGE_PASSWORD: "   " })).toContain(
        "BUNNY_STORAGE_PASSWORD",
      );
    });

    it("the Bunny password is used byte for byte (not trimmed); whitespace alone still counts as missing", () => {
      expect(loadConfig({ ...local, ...bunny, BUNNY_STORAGE_PASSWORD: "  pw with edges  " }).bunny?.password).toBe("  pw with edges  ");
    });

    it("BUNNY_* set while BLOB_STORE is not bunny fails fast, naming variables but not values", () => {
      const text = message({ ...local, BUNNY_STORAGE_ZONE: "aviation-arcade-website", BUNNY_STORAGE_PASSWORD: "pw-secret-value-1" });
      expect(text).toContain("BUNNY_STORAGE_ZONE");
      expect(text).toContain("BUNNY_STORAGE_PASSWORD");
      expect(text).not.toContain("pw-secret-value-1");
      expect(message({ ...local, BLOB_STORE: "memory", BUNNY_STORAGE_PREFIX: "backend/" })).toContain("BUNNY_STORAGE_PREFIX");
      expect(message({ ...production, BLOB_STORE: "none", BUNNY_STORAGE_REGION: "ny" })).toContain("BUNNY_STORAGE_REGION");
      expect(loadConfig({ ...local, BUNNY_STORAGE_ZONE: " ", BUNNY_STORAGE_PASSWORD: "  " }).bunny).toBeUndefined();
    });

    it("bunny applies the defaults: region de and prefix backend/", () => {
      expect(loadConfig({ ...local, ...bunny }).bunny).toEqual({
        zone: "aviation-arcade-website",
        password: "pw-secret-value-1",
        region: "de",
        prefix: "backend/",
      });
      expect(loadConfig({ ...production, ...bunny }).blobStore).toBe("bunny");
    });

    it("validates the zone, region and prefix, never echoing the password", () => {
      for (const zone of ["Bad_Zone", "-lead", "trail-", "a b"]) {
        const text = message({ ...local, ...bunny, BUNNY_STORAGE_ZONE: zone });
        expect(text, zone).toContain("BUNNY_STORAGE_ZONE");
        expect(text).not.toContain("pw-secret-value-1");
      }
      const region = message({ ...local, ...bunny, BUNNY_STORAGE_REGION: "mars" });
      expect(region).toContain("BUNNY_STORAGE_REGION");
      expect(region).not.toContain("pw-secret-value-1");
      expect(loadConfig({ ...local, ...bunny, BUNNY_STORAGE_REGION: "ny" }).bunny?.region).toBe("ny");
      for (const prefix of ["/backend/", "backend", "back/../end/", "../", "Backend/", "a//b/", "a b/", "/", "café/"]) {
        const text = message({ ...local, ...bunny, BUNNY_STORAGE_PREFIX: prefix });
        expect(text, prefix).toContain("BUNNY_STORAGE_PREFIX");
        expect(text).not.toContain("pw-secret-value-1");
      }
      expect(loadConfig({ ...local, ...bunny, BUNNY_STORAGE_PREFIX: "backend/staging/" }).bunny?.prefix).toBe("backend/staging/");
    });

    it("refuses Bunny settings when another store is chosen (covered above); a blank one is ignored", () => {
      expect(message({ ...local, BLOB_STORE: "memory", BUNNY_STORAGE_PASSWORD: "pw" })).toContain("BUNNY_STORAGE_PASSWORD");
      expect(loadConfig({ ...local, BLOB_STORE: "memory", BUNNY_STORAGE_PASSWORD: "" }).bunny).toBeUndefined();
    });
  });
});
