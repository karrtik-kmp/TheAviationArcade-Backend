import { afterEach, describe, expect, it, vi } from "vitest";
import { setTestDatabaseClockSkew } from "../src/database/clock.js";

// The test seam must be unreachable in production. The codebase decides production with APP_ENV (config module);
// NODE_ENV is checked too.
describe("setTestDatabaseClockSkew", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setTestDatabaseClockSkew(0);
  });

  it("is refused when APP_ENV is production", () => {
    vi.stubEnv("APP_ENV", "production");
    expect(() => setTestDatabaseClockSkew(1000)).toThrow("not available in production");
  });

  it("is refused when NODE_ENV is production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => setTestDatabaseClockSkew(1000)).toThrow("not available in production");
  });

  it("works under APP_ENV=test and rejects a non-finite offset", () => {
    vi.stubEnv("APP_ENV", "test");
    expect(() => setTestDatabaseClockSkew(1000)).not.toThrow();
    expect(() => setTestDatabaseClockSkew(Number.NaN)).toThrow("finite");
  });
});
