import { defineConfig } from "vitest/config";

// Unit tests: pure rules and the Firebase verifier. No database, no Nest.
export default defineConfig({
  test: {
    include: ["test/rules.test.ts", "test/firebase.test.ts"],
  },
});
