import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { Roles, RolesGuard, RolesService, satisfiesRoles } from "../src/auth/roles.js";
import { ApiError } from "../src/common/errors.js";
import type { DatabaseService } from "../src/database/database.module.js";
import { ACCOUNT_ROLES, ADMIN_AUDIT_ACTIONS, ROLE_STATES } from "../src/db/enums.js";
import type { AccountRole } from "../src/db/enums.js";

// Backend ADR-0002: privilege comes only from ACTIVE account_roles rows. Unit tests of the pure rule, the decorator and the
// guard (with the database read stubbed); test/roles.e2e.test.ts runs the same rules against the real database.

describe("role enums", () => {
  it("lists the three roles and five states of ADR-0002 (plus `blocked`, plan R-d)", () => {
    expect(ACCOUNT_ROLES).toEqual(["player", "photographer", "admin"]);
    expect(ROLE_STATES).toEqual(["pending", "active", "rejected", "revoked", "blocked"]);
  });

  it("audits every role change", () => {
    for (const action of ["role_request", "role_approve", "role_reject", "role_grant", "role_revoke", "role_block", "role_unblock", "role_email_edit"]) {
      expect(ADMIN_AUDIT_ACTIONS).toContain(action);
    }
  });
});

describe("satisfiesRoles", () => {
  const verified = { emailVerified: true, email: "a@sites.test" };

  it("admin needs an active admin role and a verified email", () => {
    expect(satisfiesRoles(["admin"], ["admin"], verified)).toBe(true);
    expect(satisfiesRoles(["admin"], [], verified)).toBe(false);
    expect(satisfiesRoles(["admin"], ["player", "photographer"], verified)).toBe(false);
    expect(satisfiesRoles(["admin"], ["admin"], { emailVerified: false, email: "a@sites.test" })).toBe(false);
    expect(satisfiesRoles(["admin"], ["admin"], { emailVerified: undefined, email: "a@sites.test" })).toBe(false);
  });

  it("a verified flag without an email claim does not count as a verified email", () => {
    expect(satisfiesRoles(["admin"], ["admin"], { emailVerified: true, email: undefined })).toBe(false);
    expect(satisfiesRoles(["admin"], ["admin"], { emailVerified: true, email: "" })).toBe(false);
  });

  it("admin satisfies photographer; photographer never satisfies admin", () => {
    expect(satisfiesRoles(["photographer"], ["admin"], verified)).toBe(true);
    expect(satisfiesRoles(["photographer"], ["photographer"], verified)).toBe(true);
    expect(satisfiesRoles(["photographer"], ["photographer"], { emailVerified: false, email: "a@sites.test" })).toBe(false);
    expect(satisfiesRoles(["admin"], ["photographer"], verified)).toBe(false);
  });

  it("player needs no verified email; admin does not imply player", () => {
    expect(satisfiesRoles(["player"], ["player"], { emailVerified: false, email: undefined })).toBe(true);
    expect(satisfiesRoles(["player"], ["admin"], verified)).toBe(false);
  });

  it("several required roles are any-of; none required never passes", () => {
    expect(satisfiesRoles(["photographer", "admin"], ["photographer"], verified)).toBe(true);
    expect(satisfiesRoles(["player", "admin"], ["player"], { emailVerified: false, email: undefined })).toBe(true);
    expect(satisfiesRoles([], ["admin"], verified)).toBe(false);
  });
});

describe("@Roles()", () => {
  it("refuses no roles and an unknown role at declaration time", () => {
    expect(() => Roles()).toThrow(/at least one role/);
    expect(() => Roles("staff" as AccountRole)).toThrow(/unknown role/);
  });
});

class Plain {
  handler() {}
}
@Roles("admin")
class AdminOnly {
  handler() {}
}
class MethodLevel {
  @Roles("photographer")
  handler() {}
}

function context(target: { prototype: { handler(): void } }, req: object): ExecutionContext {
  return {
    getHandler: () => target.prototype.handler,
    getClass: () => target,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** A RolesService whose database read is a fixed table, counting lookups. */
class StubRoles extends RolesService {
  lookups: string[] = [];
  constructor(private readonly table: Record<string, AccountRole[]>) {
    super({} as DatabaseService);
  }
  override async activeRoles(principal: string): Promise<AccountRole[]> {
    this.lookups.push(principal);
    return this.table[principal] ?? [];
  }
}

async function forbidden(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("expected 403");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "forbidden" });
  }
}

describe("RolesGuard", () => {
  const admin = "firebase:demo-airplane-games:admin";
  const photographer = "firebase:demo-airplane-games:photo";
  const make = () => {
    const roles = new StubRoles({ [admin]: ["admin"], [photographer]: ["photographer"] });
    return { roles, guard: new RolesGuard(roles, new Reflector()) };
  };
  const verified = (principal: string) => ({ principal, email: "x@sites.test", emailVerified: true });

  it("lets routes without @Roles() through without reading the database", async () => {
    const { roles, guard } = make();
    expect(await guard.canActivate(context(Plain, {}))).toBe(true);
    expect(roles.lookups).toEqual([]);
  });

  it("lets an active verified admin through, reading the roles once, and exposes them on the request", async () => {
    const { roles, guard } = make();
    const req: Record<string, unknown> = verified(admin);
    expect(await guard.canActivate(context(AdminOnly, req))).toBe(true);
    expect(roles.lookups).toEqual([admin]);
    expect(req["roles"]).toEqual(["admin"]);
  });

  it("reads method-level metadata (admin satisfies photographer)", async () => {
    const { guard } = make();
    expect(await guard.canActivate(context(MethodLevel, verified(admin)))).toBe(true);
    expect(await guard.canActivate(context(MethodLevel, verified(photographer)))).toBe(true);
  });

  it("answers 403 forbidden for no role, the wrong role, an unverified email, and no principal", async () => {
    const { guard } = make();
    await forbidden(guard.canActivate(context(AdminOnly, verified("firebase:demo-airplane-games:nobody"))));
    await forbidden(guard.canActivate(context(AdminOnly, verified(photographer))));
    await forbidden(guard.canActivate(context(AdminOnly, { principal: admin, email: "x@sites.test", emailVerified: false })));
    await forbidden(guard.canActivate(context(AdminOnly, { email: "x@sites.test", emailVerified: true })));
  });

  it("never trusts a role named by the client: only the database read counts", async () => {
    const { guard } = make();
    const req = { ...verified("firebase:demo-airplane-games:nobody"), roles: ["admin"], headers: { "x-role": "admin" } };
    await forbidden(guard.canActivate(context(AdminOnly, req)));
    expect(req.roles).toEqual([]);
  });
});

describe("STAFF_EMAILS is retired", () => {
  const root = join(import.meta.dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });

  it("no source, script, config or env example mentions it", () => {
    const sources = [
      ...files(join(root, "src")),
      ...files(join(root, "scripts")),
      join(root, ".env.example"),
      join(root, "vitest.config.ts"),
      join(root, "vitest.e2e.config.ts"),
    ];
    const hits = sources.filter((path) => /STAFF_EMAILS|staffEmails|StaffOnly|StaffGuard/.test(readFileSync(path, "utf8")));
    expect(hits).toEqual([]);
  });
});
