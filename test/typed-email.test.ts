import { describe, expect, it } from "vitest";
import { ApiError } from "../src/common/errors.js";
import { normalizeTypedEmail } from "../src/accounts/typed-email.js";

// Plan R-d: the one validator for an email typed by an admin or the operator.

const refused = (value: unknown) => {
  try {
    normalizeTypedEmail(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: "invalid_request" });
    return true;
  }
  return false;
};

describe("normalizeTypedEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeTypedEmail("  Boss@Example.TEST \n")).toBe("boss@example.test");
    expect(normalizeTypedEmail("a@b")).toBe("a@b");
  });

  it("accepts up to 320 code points and refuses 321 (astral characters count once)", () => {
    expect(normalizeTypedEmail(`${"x".repeat(64)}@${"y".repeat(255)}`)).toHaveLength(320);
    expect(refused(`${"x".repeat(64)}@${"y".repeat(256)}`)).toBe(true);
    expect([...normalizeTypedEmail(`${"\u{1F600}".repeat(150)}@${"z".repeat(100)}`)]).toHaveLength(251);
    expect(refused(`${"\u{1F600}".repeat(200)}@${"z".repeat(121)}`)).toBe(true);
  });

  it("refuses non-strings, too short, no or several @, empty sides, whitespace and control characters", () => {
    for (const bad of [undefined, null, 7, {}, [], "", " ", "ab", "plain", "a@@b", "a@b@c", "@b", "a@", "a b@c", "a@b c", "a@b\tc", "a@b\u0000c", "a@b\u007fc", "a@b c"]) {
      expect(refused(bad), JSON.stringify(bad)).toBe(true);
    }
  });

  it("refuses a huge string without processing it", () => {
    expect(refused("a@".repeat(5_000_000))).toBe(true);
  });
});
