import { describe, expect, it } from "vitest";
import { isDatabaseUnavailable } from "../src/database/database-errors.js";

function pgError(code: string, message = "boom"): Error {
  return Object.assign(new Error(message), { code });
}

describe("isDatabaseUnavailable", () => {
  it.each([
    ["statement timeout", "57014"],
    ["lock timeout", "55P03"],
    ["too many connections", "53300"],
    ["admin shutdown", "57P01"],
    ["crash shutdown", "57P02"],
    ["cannot connect now", "57P03"],
    ["connection exception class", "08006"],
    ["connection failure", "08001"],
    ["refused", "ECONNREFUSED"],
    ["reset", "ECONNRESET"],
  ])("%s (%s) is a 503", (_name, code) => {
    expect(isDatabaseUnavailable(pgError(code))).toBe(true);
  });

  it("recognises pool connect, dropped-connection and query timeouts that carry no code", () => {
    expect(isDatabaseUnavailable(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isDatabaseUnavailable(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isDatabaseUnavailable(new Error("Query read timeout"))).toBe(true);
  });

  it("looks through the drizzle wrapper to the driver error", () => {
    const wrapped = new Error("Failed query: select ... params: secret", { cause: pgError("57014") });
    expect(isDatabaseUnavailable(wrapped)).toBe(true);
  });

  it("recognises an AggregateError of refused connections", () => {
    const aggregate = new AggregateError([pgError("ECONNREFUSED"), pgError("ECONNREFUSED")], "");
    expect(isDatabaseUnavailable(aggregate)).toBe(true);
  });

  it("does not treat ordinary failures as unavailability", () => {
    expect(isDatabaseUnavailable(pgError("23505"))).toBe(false); // unique violation
    expect(isDatabaseUnavailable(pgError("23514"))).toBe(false); // check violation
    expect(isDatabaseUnavailable(new Error("Player row missing after credit."))).toBe(false);
    expect(isDatabaseUnavailable("text")).toBe(false);
  });
});
