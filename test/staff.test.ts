import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { StaffGuard, StaffOnly, isStaff } from "../src/auth/staff.js";
import { ApiError } from "../src/common/errors.js";
import type { AppConfig } from "../src/config/config.module.js";

const allow = ["staff@sites.test", "other@sites.test"];

describe("isStaff", () => {
  it("needs a verified email that is on the allowlist", () => {
    expect(isStaff("staff@sites.test", true, allow)).toBe(true);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(isStaff("STAFF@Sites.Test", true, allow)).toBe(true);
    expect(isStaff("  staff@sites.test ", true, allow)).toBe(true);
  });

  it("refuses an unverified email even if listed", () => {
    expect(isStaff("staff@sites.test", false, allow)).toBe(false);
    expect(isStaff("staff@sites.test", undefined, allow)).toBe(false);
  });

  it("refuses an email that is not listed, a missing email, and an empty allowlist", () => {
    expect(isStaff("nobody@sites.test", true, allow)).toBe(false);
    expect(isStaff("staff@sites.test.evil.com", true, allow)).toBe(false);
    expect(isStaff(undefined, true, allow)).toBe(false);
    expect(isStaff("staff@sites.test", true, [])).toBe(false);
  });
});

class Plain {
  handler() {}
}
@StaffOnly()
class Guarded {
  handler() {}
}

function context(target: new () => { handler(): void }, req: object): ExecutionContext {
  return {
    getHandler: () => target.prototype.handler,
    getClass: () => target,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("StaffGuard", () => {
  const guard = new StaffGuard({ staffEmails: allow } as unknown as AppConfig, new Reflector());

  it("lets routes without @StaffOnly() through, whoever calls", () => {
    expect(guard.canActivate(context(Plain, {}))).toBe(true);
  });

  it("lets a verified listed email through a @StaffOnly() route", () => {
    expect(guard.canActivate(context(Guarded, { email: "Staff@sites.test", emailVerified: true }))).toBe(true);
  });

  it("answers 403 forbidden 'Staff only.' otherwise", () => {
    for (const req of [{}, { email: "staff@sites.test", emailVerified: false }, { email: "nobody@sites.test", emailVerified: true }]) {
      try {
        guard.canActivate(context(Guarded, req));
        throw new Error("expected 403");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({ status: 403, code: "forbidden", message: "Staff only." });
      }
    }
  });
});
