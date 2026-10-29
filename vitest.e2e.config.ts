import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile(".env");
} catch {
  // Fine: fall back to the local default below.
}

// Local throwaway default (matches docker-compose.yml). Never the dev database.
const DEFAULT_TEST_DATABASE_URL =
  "postgres://airplane:airplane_local_only@127.0.0.1:5433/airplane_games_test";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
// globalSetup runs in this process, so it must see the test URL, never the dev DATABASE_URL from .env.
process.env.DATABASE_URL = TEST_DATABASE_URL;

// API tests: the real Nest app against the real test database. SWC emits the decorator metadata
// that Nest's constructor injection needs (esbuild, Vitest's default, does not).
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["test/api.test.ts", "test/*.e2e.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      // Tests never touch the real Firebase project: demo- project with emulator tokens.
      FIREBASE_PROJECT_ID: "demo-airplane-games",
      ALLOW_EMULATOR_TOKENS: "true",
      APP_ENV: "test",
      // Staff allowlist for the admin tests: the second entry checks trimming and case-insensitive matching.
      STAFF_EMAILS: " staff@sites.test , Other.Staff@Sites.Test ",
      // test/api.test.ts sends far more than the default per-minute limits from one IP and one principal.
      // The rate limit tests build their own app with low limits.
      RATE_LIMIT_AUTH_PER_MIN: "100000",
      RATE_LIMIT_PUBLIC_PER_MIN: "100000",
    },
  },
});
