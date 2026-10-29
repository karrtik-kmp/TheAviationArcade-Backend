// The frozen dealer case source lives in src/rules/dealer-fixture.ts so that `nest build` compiles it and
// scripts/write-contracts.mjs can import it. This module is the test-side name for it.
export * from "../src/rules/dealer-fixture.js";
