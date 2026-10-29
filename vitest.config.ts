import { defineConfig } from "vitest/config";

// Unit tests: rules, config, token verification, error mapping, guards, storage, xlsx and content mapping. No database.
export default defineConfig({
  test: {
    include: [
      "test/rules.test.ts",
      "test/firebase.test.ts",
      "test/config.test.ts",
      "test/database-errors.test.ts",
      "test/guard-filter.test.ts",
      "test/platform.test.ts",
      "test/staff.test.ts",
      "test/blob-store.test.ts",
      "test/xlsx.test.ts",
      "test/military-mapping.test.ts",
      "test/catalog.test.ts",
      "test/contracts.test.ts",
      "test/import-plan.test.ts",
      "test/ugs.test.ts",
      "test/mirror-worker.test.ts",
      "test/balance-guard.test.ts",
      "test/schema-parity.test.ts",
      "test/trips.test.ts",
      "test/trip-segments.test.ts",
      "test/field-awards.test.ts",
    ],
  },
});
