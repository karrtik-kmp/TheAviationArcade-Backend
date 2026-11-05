import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importStoreKeys, isInsideAnyRoot, loadConfig } from "../src/config/config.module.js";

const local = {
  APP_ENV: "local",
  DATABASE_URL: "postgres://user:s3cret-pass@127.0.0.1:5433/db",
  FIREBASE_PROJECT_ID: "demo-airplane-games",
  ALLOW_EMULATOR_TOKENS: "true",
};

/** Production without the CDN pair, which production requires. */
const productionNoCdn = {
  APP_ENV: "production",
  DATABASE_URL: "postgres://user:s3cret-pass@db.internal:5432/db",
  FIREBASE_PROJECT_ID: "airplane-games-auth-20261022",
};

const production = { ...productionNoCdn, BUNNY_CDN_HOST: "my-zone.b-cdn.net", BUNNY_CDN_TOKEN_KEY: "0123456789abcdef-secret-key" };

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
      rateLimitPoolMax: 3,
      databaseSsl: "disable",
      databaseCaCert: undefined,
      trustProxy: false,
      shutdownDrainMs: 10_000,
      shutdownPrestopMs: 0,
      rateLimitAuthPerMin: 120,
      rateLimitPublicPerMin: 60,
      rateLimitStore: "postgres",
      minClientBuild: undefined,
      blobStore: "memory",
      storeVerifier: "none",
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

  describe("DEMO_ACCOUNT_UID", () => {
    it("is unset by default and when blank", () => {
      expect(loadConfig(local).demoPrincipal).toBeUndefined();
      expect(loadConfig({ ...local, DEMO_ACCOUNT_UID: "  " }).demoPrincipal).toBeUndefined();
    });

    it("derives firebase:<project>:<uid>, trimming the uid", () => {
      expect(loadConfig({ ...local, DEMO_ACCOUNT_UID: " demo-shared-uid " }).demoPrincipal).toBe("firebase:demo-airplane-games:demo-shared-uid");
      expect(loadConfig({ ...production, DEMO_ACCOUNT_UID: "AbC123" }).demoPrincipal).toBe("firebase:airplane-games-auth-20261022:AbC123");
      expect(loadConfig({ ...local, DEMO_ACCOUNT_UID: "x".repeat(128) }).demoPrincipal).toBe(`firebase:demo-airplane-games:${"x".repeat(128)}`);
    });

    it("refuses a uid the principal rules refuse, naming the variable and never the value", () => {
      for (const bad of ["a:b", "a/b", "x".repeat(129), "a\u0000b", "a\tb", "firebase:demo-airplane-games:abc"]) {
        const text = message({ ...local, DEMO_ACCOUNT_UID: bad });
        expect(text, JSON.stringify(bad)).toContain("DEMO_ACCOUNT_UID");
      }
      expect(message({ ...local, DEMO_ACCOUNT_UID: "secret:uid" })).not.toContain("secret");
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

    it("RATE_LIMIT_STORE defaults to postgres and accepts only postgres or memory", () => {
      expect(loadConfig(local).rateLimitStore).toBe("postgres");
      expect(loadConfig({ ...local, RATE_LIMIT_STORE: "memory" }).rateLimitStore).toBe("memory");
      expect(message({ ...local, RATE_LIMIT_STORE: "redis" })).toContain("RATE_LIMIT_STORE");
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

  describe("STAFF_EMAILS (retired by Backend ADR-0002)", () => {
    it("is not read: setting it changes nothing in the config, and no email list exists to grant anything", () => {
      const withList = loadConfig({ ...local, STAFF_EMAILS: "staff@sites.test" });
      expect(withList).toEqual(loadConfig(local));
      expect(JSON.stringify(withList)).not.toContain("staff@sites.test");
      expect(Object.keys(withList).some((key) => /staff|email/i.test(key))).toBe(false);
    });
  });

  describe("BUNNY_CDN_HOST / BUNNY_CDN_TOKEN_KEY (signed image links)", () => {
    const cdn = { BUNNY_CDN_HOST: "my-zone.b-cdn.net", BUNNY_CDN_TOKEN_KEY: "0123456789abcdef-secret-key" };

    it("are off when neither is given (blank counts as unset) outside production", () => {
      expect(loadConfig(local).cdn).toBeUndefined();
      expect(loadConfig({ ...local, APP_ENV: "test" }).cdn).toBeUndefined();
      expect(loadConfig({ ...local, BUNNY_CDN_HOST: " ", BUNNY_CDN_TOKEN_KEY: "" }).cdn).toBeUndefined();
    });

    it("are both required when APP_ENV=production, naming the variables without values", () => {
      const none = message(productionNoCdn);
      expect(none).toContain("BUNNY_CDN_HOST");
      expect(none).toContain("BUNNY_CDN_TOKEN_KEY");
      expect(message({ ...productionNoCdn, BUNNY_CDN_HOST: " ", BUNNY_CDN_TOKEN_KEY: "" })).toContain("BUNNY_CDN_HOST");
      expect(message({ ...productionNoCdn, BUNNY_CDN_HOST: cdn.BUNNY_CDN_HOST })).toContain("BUNNY_CDN_TOKEN_KEY");
      const noHost = message({ ...productionNoCdn, BUNNY_CDN_TOKEN_KEY: cdn.BUNNY_CDN_TOKEN_KEY });
      expect(noHost).toContain("BUNNY_CDN_HOST");
      expect(noHost).not.toContain(cdn.BUNNY_CDN_TOKEN_KEY);
      expect(loadConfig({ ...productionNoCdn, ...cdn }).cdn?.host).toBe(cdn.BUNNY_CDN_HOST);
    });

    it("refuse a BUNNY_STORAGE_PREFIX other than backend/ while configured (the signer path is tied to it)", () => {
      const bunny = { BLOB_STORE: "bunny", BUNNY_STORAGE_ZONE: "aviation-arcade-website", BUNNY_STORAGE_PASSWORD: "pw-secret-value-1" };
      const text = message({ ...local, ...bunny, ...cdn, BUNNY_STORAGE_PREFIX: "other/" });
      expect(text).toContain("BUNNY_STORAGE_PREFIX");
      expect(text).not.toContain("pw-secret-value-1");
      expect(text).not.toContain(cdn.BUNNY_CDN_TOKEN_KEY);
      expect(loadConfig({ ...local, ...bunny, ...cdn, BUNNY_STORAGE_PREFIX: " backend/ " }).bunny?.prefix).toBe("backend/");
      expect(loadConfig({ ...local, ...bunny, ...cdn }).bunny?.prefix).toBe("backend/");
      expect(loadConfig({ ...local, ...bunny, BUNNY_STORAGE_PREFIX: "other/" }).bunny?.prefix).toBe("other/");
    });

    it("are read together, trimmed, and allowed in production", () => {
      expect(loadConfig({ ...local, ...cdn }).cdn).toEqual({ host: "my-zone.b-cdn.net", tokenKey: "0123456789abcdef-secret-key" });
      expect(loadConfig({ ...production, BUNNY_CDN_HOST: " my-zone.b-cdn.net ", BUNNY_CDN_TOKEN_KEY: " 0123456789abcdef-secret-key " }).cdn).toEqual({
        host: "my-zone.b-cdn.net",
        tokenKey: "0123456789abcdef-secret-key",
      });
    });

    it("one without the other fails, naming the missing variable and never a value", () => {
      const noKey = message({ ...local, BUNNY_CDN_HOST: cdn.BUNNY_CDN_HOST });
      expect(noKey).toContain("BUNNY_CDN_TOKEN_KEY");
      const noHost = message({ ...local, BUNNY_CDN_TOKEN_KEY: cdn.BUNNY_CDN_TOKEN_KEY });
      expect(noHost).toContain("BUNNY_CDN_HOST");
      expect(noHost).not.toContain(cdn.BUNNY_CDN_TOKEN_KEY);
    });

    it("rejects a host that is not a plain hostname and a short or spaced key, without echoing values", () => {
      for (const host of ["https://my-zone.b-cdn.net", "my-zone.b-cdn.net/x", "my-zone.b-cdn.net:8443", "user@my-zone.b-cdn.net", "localhost", "My-Zone.b-cdn.net", "-bad.b-cdn.net", "a b.b-cdn.net"]) {
        const text = message({ ...local, ...cdn, BUNNY_CDN_HOST: host });
        expect(text, host).toContain("BUNNY_CDN_HOST");
        expect(text, host).not.toContain(host);
      }
      for (const key of ["short", "has a space-0123456789", "tab	separated-0123456789"]) {
        const text = message({ ...local, ...cdn, BUNNY_CDN_TOKEN_KEY: key });
        expect(text, key).toContain("BUNNY_CDN_TOKEN_KEY");
        expect(text, key).not.toContain(key);
      }
    });
  });

  describe("STORE_VERIFIER", () => {
    it("defaults to none everywhere", () => {
      expect(loadConfig(local).storeVerifier).toBe("none");
      expect(loadConfig({ ...local, APP_ENV: "test" }).storeVerifier).toBe("none");
      expect(loadConfig(production).storeVerifier).toBe("none");
    });

    it("accepts fake locally on a demo- project and in tests, rejects unknown kinds", () => {
      expect(loadConfig({ ...local, STORE_VERIFIER: "fake" }).storeVerifier).toBe("fake");
      expect(loadConfig({ ...local, APP_ENV: "test", STORE_VERIFIER: "fake" }).storeVerifier).toBe("fake");
      expect(message({ ...local, STORE_VERIFIER: "apple" })).toContain("STORE_VERIFIER");
    });

    it("refuses fake in production", () => {
      expect(message({ ...production, STORE_VERIFIER: "fake" })).toContain("STORE_VERIFIER");
    });

    it("refuses fake against a real Firebase project in every APP_ENV, tests included", () => {
      const realLocal = { ...local, FIREBASE_PROJECT_ID: "airplane-games-auth-20261022", ALLOW_EMULATOR_TOKENS: undefined };
      expect(message({ ...realLocal, STORE_VERIFIER: "fake" })).toContain("STORE_VERIFIER");
      expect(loadConfig({ ...realLocal, STORE_VERIFIER: "none" }).storeVerifier).toBe("none");
      expect(message({ ...realLocal, APP_ENV: "test", STORE_VERIFIER: "fake" })).toContain("STORE_VERIFIER");
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

describe("STORE_VERIFIER=stores", () => {
  const realLocal = { ...local, FIREBASE_PROJECT_ID: "airplane-games-auth-20261022", ALLOW_EMULATOR_TOKENS: undefined };
  const dir = mkdtempSync(join(tmpdir(), "store-config-"));
  let ecPem = "";
  let rsaPem = "";
  const SECRET_MARKER = "SUPER-SECRET-KEY-BYTES-0123456789";
  const appleBase = {
    APPLE_BUNDLE_ID: "com.example.aviationarcade",
    APPLE_IAP_KEY_ID: "ABCDE12345",
    APPLE_IAP_ISSUER_ID: "69a6de70-03db-47e3-e053-5b8c7c11a4d1",
    APPLE_APP_APPLE_ID: "1234567890",
  };
  let apple: Record<string, string> = {};
  let google: Record<string, string> = {};
  let googleJson: Record<string, string> = {};
  const stores = (extra: Record<string, string | undefined>) => ({ ...realLocal, STORE_VERIFIER: "stores", ...extra });
  const escaped = (pem: string) => pem.trim().replaceAll("\n", "\\n");

  beforeAll(async () => {
    const ec = await generateKeyPair("ES256", { extractable: true });
    ecPem = await exportPKCS8(ec.privateKey);
    const rsa = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
    rsaPem = await exportPKCS8(rsa.privateKey);
    apple = { ...appleBase, APPLE_IAP_KEY: escaped(ecPem) };
    googleJson = {
      type: "service_account",
      client_email: "play@example-project.iam.gserviceaccount.com",
      private_key_id: "0123456789abcdef0123456789abcdef01234567",
      private_key: rsaPem,
    };
    google = { GOOGLE_PLAY_PACKAGE_NAME: "com.example.aviationarcade", GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify(googleJson) };
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const file = (name: string, content: string) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };
  const googleWith = (extra: Record<string, string | undefined>) => stores({ GOOGLE_PLAY_PACKAGE_NAME: google.GOOGLE_PLAY_PACKAGE_NAME, ...extra });

  it("exposes parsed Apple and Google settings for the adapters (inline PEM with backslash-n escapes)", () => {
    const config = loadConfig(stores({ ...apple, ...google }));
    expect(config.storeVerifier).toBe("stores");
    expect(config.apple).toEqual({
      bundleId: "com.example.aviationarcade",
      keyId: "ABCDE12345",
      issuerId: appleBase.APPLE_IAP_ISSUER_ID,
      appAppleId: 1_234_567_890,
      privateKeyPem: ecPem.trim(),
    });
    expect(config.google).toEqual({
      packageName: "com.example.aviationarcade",
      clientEmail: googleJson.client_email,
      privateKeyId: googleJson.private_key_id,
      privateKeyPem: rsaPem,
    });
  });

  it("one store alone is enough; the other side stays undefined", () => {
    expect(loadConfig(stores(apple))).toMatchObject({ google: undefined });
    expect(loadConfig(stores(google))).toMatchObject({ apple: undefined });
  });

  it("reads key files from outside the working directory", () => {
    const config = loadConfig(
      stores({
        ...appleBase,
        APPLE_IAP_KEY_FILE: file("AuthKey_ABCDE12345.p8", ecPem),
        GOOGLE_PLAY_PACKAGE_NAME: google.GOOGLE_PLAY_PACKAGE_NAME,
        GOOGLE_PLAY_SERVICE_ACCOUNT_FILE: file("sa.json", JSON.stringify(googleJson)),
      }),
    );
    expect(config.apple?.privateKeyPem.trim()).toBe(ecPem.trim());
    expect(config.google?.clientEmail).toBe(googleJson.client_email);
  });

  it("refuses to start with stores and no store configured", () => {
    expect(message(stores({}))).toContain("STORE_VERIFIER=stores");
  });

  it("stray APPLE_* and GOOGLE_PLAY_* settings with another STORE_VERIFIER are refused, naming the settings", () => {
    for (const kind of [undefined, "none", "fake"]) {
      const msg = message({ ...local, STORE_VERIFIER: kind, ...apple, ...google });
      expect(msg).toContain("APPLE_IAP_KEY_ID");
      expect(msg).toContain("GOOGLE_PLAY_PACKAGE_NAME");
      expect(msg).toContain("STORE_VERIFIER is not stores");
      expect(msg).not.toContain("BEGIN");
    }
  });

  describe("Apple", () => {
    it("all or none: a missing setting is named", () => {
      expect(message(stores({ APPLE_BUNDLE_ID: appleBase.APPLE_BUNDLE_ID }))).toMatch(
        /APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID, APPLE_APP_APPLE_ID, APPLE_IAP_KEY_FILE or APPLE_IAP_KEY required/,
      );
      expect(message(stores({ ...apple, APPLE_APP_APPLE_ID: undefined }))).toContain("APPLE_APP_APPLE_ID required");
      expect(message(stores({ ...apple, APPLE_IAP_KEY: undefined }))).toContain("APPLE_IAP_KEY_FILE or APPLE_IAP_KEY");
    });

    it("exactly one of the key file and the inline key", () => {
      expect(message(stores({ ...apple, APPLE_IAP_KEY_FILE: file("both.p8", ecPem) }))).toContain("set exactly one");
    });

    it("checks every format", () => {
      expect(message(stores({ ...apple, APPLE_BUNDLE_ID: "nodots" }))).toContain("APPLE_BUNDLE_ID");
      expect(message(stores({ ...apple, APPLE_IAP_KEY_ID: "abcde12345" }))).toContain("APPLE_IAP_KEY_ID");
      expect(message(stores({ ...apple, APPLE_IAP_KEY_ID: "ABCDE1234" }))).toContain("APPLE_IAP_KEY_ID");
      expect(message(stores({ ...apple, APPLE_IAP_ISSUER_ID: "not-a-uuid" }))).toContain("APPLE_IAP_ISSUER_ID");
      expect(message(stores({ ...apple, APPLE_APP_APPLE_ID: "0" }))).toContain("APPLE_APP_APPLE_ID");
      expect(message(stores({ ...apple, APPLE_APP_APPLE_ID: "12ab" }))).toContain("APPLE_APP_APPLE_ID");
    });

    it("a key that is not an EC P-256 PKCS#8 PEM is refused (an RSA key too)", () => {
      expect(message(stores({ ...apple, APPLE_IAP_KEY: "not a pem" }))).toContain("APPLE_IAP_KEY");
      expect(message(stores({ ...apple, APPLE_IAP_KEY: escaped(rsaPem) }))).toContain("APPLE_IAP_KEY");
    });

    it("a corrupt key file is refused by setting name and none of its bytes appear in the error", () => {
      const path = file("corrupt.p8", `-----BEGIN PRIVATE KEY-----\n${SECRET_MARKER}\n-----END PRIVATE KEY-----\n`);
      const msg = message(stores({ ...appleBase, APPLE_IAP_KEY_FILE: path }));
      expect(msg).toBe("Invalid environment configuration: APPLE_IAP_KEY_FILE");
      expect(msg).not.toContain(SECRET_MARKER);
      expect(msg).not.toContain(dir);
    });

    it("an unreadable key file path names the setting only", () => {
      expect(message(stores({ ...appleBase, APPLE_IAP_KEY_FILE: join(dir, "missing.p8") }))).toBe("Invalid environment configuration: APPLE_IAP_KEY_FILE");
    });

    it("a key path inside the repo working directory is refused", () => {
      const inside = join(process.cwd(), ".tmp-store-key-test.p8");
      writeFileSync(inside, ecPem);
      try {
        expect(message(stores({ ...appleBase, APPLE_IAP_KEY_FILE: inside }))).toContain("must point outside the working directory");
        expect(message(stores({ ...appleBase, APPLE_IAP_KEY_FILE: ".tmp-store-key-test.p8" }))).toContain("must point outside the working directory");
      } finally {
        rmSync(inside, { force: true });
      }
    });

    it("a key file named `..key.p8` inside the repo is still inside (only a `..` path segment leaves)", () => {
      const inside = join(process.cwd(), "..key-store-test.p8");
      writeFileSync(inside, ecPem);
      try {
        expect(message(stores({ ...appleBase, APPLE_IAP_KEY_FILE: inside }))).toContain("must point outside the working directory");
      } finally {
        rmSync(inside, { force: true });
      }
    });

    it("a key under the repo root is refused even when the working directory is elsewhere", () => {
      const repo = process.cwd();
      const inside = join(repo, ".tmp-store-key-cwd.p8");
      writeFileSync(inside, ecPem);
      try {
        process.chdir(dir);
        expect(message(stores({ ...appleBase, APPLE_IAP_KEY_FILE: inside }))).toContain("must point outside the working directory");
      } finally {
        process.chdir(repo);
        rmSync(inside, { force: true });
      }
    });

    it("isInsideAnyRoot: root itself and children are inside; siblings, parents and `..name` files are judged by segment", () => {
      const root = join(dir, "repo");
      expect(isInsideAnyRoot(root, [root])).toBe(true);
      expect(isInsideAnyRoot(join(root, "a", "k.p8"), [root])).toBe(true);
      expect(isInsideAnyRoot(join(root, "..k.p8"), [root])).toBe(true);
      expect(isInsideAnyRoot(join(dir, "repo-other", "k.p8"), [root])).toBe(false);
      expect(isInsideAnyRoot(dir, [root])).toBe(false);
      expect(isInsideAnyRoot(join(dir, "k.p8"), [root])).toBe(false);
      expect(isInsideAnyRoot(join(dir, "k.p8"), [root, dir])).toBe(true);
    });
  });

  describe("Google", () => {
    it("all or none: a missing setting is named, and exactly one of file and JSON", () => {
      expect(message(stores({ GOOGLE_PLAY_PACKAGE_NAME: google.GOOGLE_PLAY_PACKAGE_NAME }))).toContain(
        "GOOGLE_PLAY_SERVICE_ACCOUNT_FILE or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON required",
      );
      expect(message(stores({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: google.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON }))).toContain("GOOGLE_PLAY_PACKAGE_NAME required");
      expect(message(stores({ ...google, GOOGLE_PLAY_SERVICE_ACCOUNT_FILE: file("two.json", "{}") }))).toContain("set exactly one");
    });

    it("checks the package name and the service-account fields", () => {
      expect(message(stores({ ...google, GOOGLE_PLAY_PACKAGE_NAME: "nodots" }))).toContain("GOOGLE_PLAY_PACKAGE_NAME");
      expect(message(stores({ ...google, GOOGLE_PLAY_PACKAGE_NAME: "1bad.package" }))).toContain("GOOGLE_PLAY_PACKAGE_NAME");
      const bad = (patch: Record<string, unknown>) =>
        message(googleWith({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...googleJson, ...patch }) }));
      expect(bad({ type: "authorized_user" })).toBe("Invalid environment configuration: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
      expect(bad({ client_email: undefined })).toContain("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
      expect(bad({ private_key_id: "" })).toContain("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
      expect(bad({ private_key: undefined })).toContain("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
      expect(bad({ private_key: ecPem })).toContain("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"); // an EC key is not RS256
    });

    it("bad JSON and a corrupt key never put their bytes in the error", () => {
      const withText = (text: string) => message(googleWith({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: text }));
      const badJson = withText(`{"private_key": "${SECRET_MARKER}`);
      expect(badJson).toBe("Invalid environment configuration: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
      expect(badJson).not.toContain(SECRET_MARKER);
      const badKey = withText(JSON.stringify({ ...googleJson, private_key: `-----BEGIN PRIVATE KEY-----\n${SECRET_MARKER}\n-----END PRIVATE KEY-----\n` }));
      expect(badKey).toBe("Invalid environment configuration: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
      expect(badKey).not.toContain(SECRET_MARKER);
      const badFile = message(googleWith({ GOOGLE_PLAY_SERVICE_ACCOUNT_FILE: file("corrupt.json", `{ not json ${SECRET_MARKER}`) }));
      expect(badFile).toBe("Invalid environment configuration: GOOGLE_PLAY_SERVICE_ACCOUNT_FILE");
      expect(badFile).not.toContain(SECRET_MARKER);
    });

    it("a key path inside the repo working directory is refused", () => {
      const inside = join(process.cwd(), ".tmp-store-sa-test.json");
      writeFileSync(inside, JSON.stringify(googleJson));
      try {
        expect(message(googleWith({ GOOGLE_PLAY_SERVICE_ACCOUNT_FILE: inside }))).toContain("must point outside the working directory");
      } finally {
        rmSync(inside, { force: true });
      }
    });
  });

  it("stores with a demo- project is refused unless APP_ENV=test", () => {
    const demo = { ...local, STORE_VERIFIER: "stores", ...apple };
    expect(message(demo)).toContain("demo- FIREBASE_PROJECT_ID");
    expect(loadConfig({ ...demo, APP_ENV: "test" }).apple?.keyId).toBe("ABCDE12345");
  });

  describe("production", () => {
    const prod = (extra: Record<string, string | undefined>) => ({ ...production, STORE_VERIFIER: "stores", ...extra });

    it("needs STORE_ENABLED, and it must match exactly the configured stores", () => {
      expect(message(prod({ ...apple, ...google }))).toContain("STORE_ENABLED required");
      expect(message(prod({ ...apple, ...google, STORE_ENABLED: "apple" }))).toContain("STORE_ENABLED does not match");
      expect(message(prod({ ...apple, STORE_ENABLED: "apple,google" }))).toContain("STORE_ENABLED does not match");
      expect(message(prod({ ...apple, STORE_ENABLED: "apple,banana" }))).toContain("STORE_ENABLED");
      expect(loadConfig(prod({ ...apple, ...google, STORE_ENABLED: "google, apple" })).google).toBeDefined();
      expect(loadConfig(prod({ ...apple, STORE_ENABLED: "apple" })).apple).toBeDefined();
    });
  });

  it("importStoreKeys imports both keys with jose, and a key it cannot import names the setting only", async () => {
    const config = loadConfig(stores({ ...apple, ...google }));
    await expect(importStoreKeys(config)).resolves.toBeUndefined();
    const broken = {
      apple: { ...config.apple!, privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${SECRET_MARKER}\n-----END PRIVATE KEY-----` },
      google: undefined,
    };
    const error = (await importStoreKeys(broken).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe("Invalid environment configuration: APPLE_IAP_KEY_FILE or APPLE_IAP_KEY");
    expect(error.message).not.toContain(SECRET_MARKER);
    expect(error.cause).toBeUndefined();
  });
});
