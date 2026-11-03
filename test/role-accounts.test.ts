import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accountPrincipalFor, requireAccountPrincipal, uidOfAccountPrincipal } from "../src/accounts/account-principal.js";
import { RolesService, satisfiesRoles } from "../src/auth/roles.js";
import type { DatabaseService } from "../src/database/database.module.js";

// Plan R-b: the shared principal validator (also used by the operator command, R-c) and the "pending grants nothing" guard rule.

const PROJECT = "demo-airplane-games";
const principal = (uid: string, project = PROJECT) => `firebase:${project}:${uid}`;

describe("principal validator: exactly firebase:<configured project>:<uid>", () => {
  it("accepts a uid of 1 to 128 characters of the configured project", () => {
    expect(uidOfAccountPrincipal(principal("abc"), PROJECT)).toBe("abc");
    expect(uidOfAccountPrincipal(principal("a"), PROJECT)).toBe("a");
    expect(uidOfAccountPrincipal(principal("x".repeat(128)), PROJECT)).toBe("x".repeat(128));
    expect(uidOfAccountPrincipal(principal("with space inside"), PROJECT)).toBe("with space inside");
    expect(requireAccountPrincipal(principal("abc"), PROJECT)).toBe(principal("abc"));
  });

  it.each([
    ["an empty uid", principal("")],
    ["a uid over 128 characters", principal("x".repeat(129))],
    ["another project", principal("abc", "airplane-games-auth-20261022")],
    ["no prefix", "abc"],
    ["a different scheme", `google:${PROJECT}:abc`],
    ["a colon in the uid", principal("a:b")],
    ["a slash in the uid", principal("a/b")],
    ["a leading space", principal(" abc")],
    ["a trailing space", principal("abc ")],
    ["a trailing newline", principal("abc\n")],
    ["a NUL", principal("a\u0000b")],
    ["a tab", principal("a\tb")],
    ["a C1 control character", principal("a\u0085b")],
    ["a surrounding space on the whole value", ` ${principal("abc")}`],
    ["the project as a prefix of a longer project", `firebase:${PROJECT}-x:abc`],
  ])("rejects %s", (_label, value) => {
    expect(uidOfAccountPrincipal(value, PROJECT)).toBeUndefined();
    expect(() => requireAccountPrincipal(value, PROJECT)).toThrowError(expect.objectContaining({ status: 400, code: "invalid_request" }));
  });

  it("rejects a value that is not a string", () => {
    for (const value of [undefined, null, 5, {}, ["a"]]) expect(uidOfAccountPrincipal(value, PROJECT)).toBeUndefined();
  });

  it("builds a principal from a uid with the same rules", () => {
    expect(accountPrincipalFor("abc", PROJECT)).toBe(principal("abc"));
    expect(accountPrincipalFor("a:b", PROJECT)).toBeUndefined();
    expect(accountPrincipalFor("", PROJECT)).toBeUndefined();
    expect(accountPrincipalFor(" abc", PROJECT)).toBeUndefined();
  });
});

describe("a pending, rejected or revoked role grants nothing", () => {
  it("the guard reads ONLY state = 'active' rows", async () => {
    let captured: SQL | undefined;
    const database = {
      db: { select: () => ({ from: () => ({ where: (condition: SQL) => { captured = condition; return Promise.resolve([]); } }) }) },
    } as unknown as DatabaseService;
    expect(await new RolesService(database).activeRoles(principal("abc"))).toEqual([]);
    const query = new PgDialect().sqlToQuery(captured as SQL);
    expect(query.sql).toContain('"state" = $');
    expect(query.params).toEqual([principal("abc"), "active"]);
  });

  it("the rule passes only for roles in the ACTIVE list", () => {
    const caller = { emailVerified: true, email: "a@b.test" };
    expect(satisfiesRoles(["admin"], [], caller)).toBe(false);
    expect(satisfiesRoles(["photographer"], ["player"], caller)).toBe(false);
    expect(satisfiesRoles(["admin"], ["admin"], caller)).toBe(true);
  });
});
