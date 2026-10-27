import { defineConfig } from "vitest/config";

// Unit tests: rules, config, token verification, error mapping, guard and filter. No database.
export default defineConfig({
  test: {
    include: [
      "test/rules.test.ts",
      "test/firebase.test.ts",
      "test/config.test.ts",
      "test/database-errors.test.ts",
      "test/guard-filter.test.ts",
      "test/platform.test.ts",
    ],
  },
});
