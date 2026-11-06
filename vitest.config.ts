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
      "test/roles.test.ts",
      "test/blob-store.test.ts",
      "test/xlsx.test.ts",
      "test/military-mapping.test.ts",
      "test/airport-spotter-mapping.test.ts",
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
      "test/dealer.test.ts",
      "test/deal-items.test.ts",
      "test/content-documents.test.ts",
      "test/logbook.test.ts",
      "test/content-publish.test.ts", "test/rate-limit-store.test.ts",
      "test/field-awards-import.test.ts", "test/content-item-edit.test.ts", "test/clock.test.ts",
      "test/image-sniff.test.ts", "test/cdn-signer.test.ts", "test/role-accounts.test.ts",
      "test/typed-email.test.ts", "test/store-catalog.test.ts", "test/purchases.test.ts", "test/stores-verifier.test.ts", "test/apple-store-verifier.test.ts", "test/google-store-verifier.test.ts", "test/stores-check.test.ts", "test/key-folder.test.ts",
      "test/editorial-rules.test.ts", "test/local-day.test.ts", "test/military-preparation.test.ts", "test/release-rules.test.ts",
    ],
  },
});
