// Pure unit test (no database).
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/common/errors.js";
import { decodeSubmissionHeader, submissionDigest, SUBMISSION_HEADER_MAX } from "../src/content/media/media-submission.js";

// Photo submission v2 (docs/plans/photo-submission-v2.md D2, D10): the X-Submission decoder and the normalised digest.

const enc = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64url");
const encBytes = (bytes: number[]) => Buffer.from(bytes).toString("base64url");
const BASE = { fullName: "Zoë Ångström", title: "Sunrise over LAX", credit: "Z. Ångström" };

function refused(header: string): ApiError {
  try {
    decodeSubmissionHeader(header);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected the header to be refused");
}

describe("decodeSubmissionHeader", () => {
  it("decodes the three required fields with defaults written out", () => {
    expect(decodeSubmissionHeader(enc(BASE))).toEqual({ ...BASE, instagramHandle: null, instagramDisplayConsent: false });
  });

  it("round-trips non-ASCII text and emoji (unescaped UTF-8)", () => {
    const wide = { fullName: "山田 太郎", title: "Ünïcode ✈ 🛩️", credit: "Çredit" };
    expect(decodeSubmissionHeader(enc(wide))).toMatchObject(wide);
  });

  it("trims, strips one leading @ from the handle and keeps consent", () => {
    expect(decodeSubmissionHeader(enc({ ...BASE, fullName: "  Pat  ", instagramHandle: " @pat.flies ", instagramDisplayConsent: true }))).toEqual({
      ...BASE,
      fullName: "Pat",
      instagramHandle: "pat.flies",
      instagramDisplayConsent: true,
    });
  });

  it.each(["", "@", "  @  "])("treats the handle %j as none", (handle) => {
    expect(decodeSubmissionHeader(enc({ ...BASE, instagramHandle: handle })).instagramHandle).toBeNull();
  });

  it("refuses a second @ and bad handle characters", () => {
    for (const handle of ["@@pat", "pat flies", "pat!", "a".repeat(31), "päť"]) {
      expect(refused(enc({ ...BASE, instagramHandle: handle })).code).toBe("invalid_request");
    }
    expect(decodeSubmissionHeader(enc({ ...BASE, instagramHandle: "a".repeat(30) })).instagramHandle).toBe("a".repeat(30));
  });

  it("refuses consent without a handle (also an empty one)", () => {
    expect(refused(enc({ ...BASE, instagramDisplayConsent: true })).status).toBe(400);
    expect(refused(enc({ ...BASE, instagramHandle: "@", instagramDisplayConsent: true })).status).toBe(400);
  });

  it("refuses characters outside the base64url alphabet", () => {
    const good = enc({ ...BASE, fullName: "??>>??" }); // JSON that encodes to a string with - and _ characters
    for (const bad of [`${good}+`, `${good}/`, `${good}=`, `${good} `, ` ${good}`, `${good}, ${good}`, "", "ab\ncd"]) {
      expect(refused(bad).status, JSON.stringify(bad)).toBe(400);
    }
    // standard base64 spelling of the same bytes uses + and /
    const standard = Buffer.from(JSON.stringify({ ...BASE, fullName: "???>>>" })).toString("base64");
    expect(standard).toMatch(/[+/]/);
    expect(refused(standard).status).toBe(400);
  });

  it("refuses a non-canonical last character (trailing bits set)", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    // Only a length that is not a multiple of 4 has spare bits; BASE's length is chosen below to make sure of it.
    const body = Buffer.from(JSON.stringify(BASE));
    const text = body.toString("base64url");
    const last = text.at(-1)!;
    expect(text.length % 4).not.toBe(0);
    const sibling = alphabet.split("").find((c) => c !== last && Buffer.from(text.slice(0, -1) + c, "base64url").equals(body));
    expect(sibling, "a different last character that decodes to the same bytes").toBeDefined();
    expect(refused(text.slice(0, -1) + sibling).status).toBe(400);
  });

  it("refuses invalid UTF-8, a BOM, and lone surrogates", () => {
    expect(refused(encBytes([0x7b, 0xff, 0xfe, 0x7d])).status).toBe(400);
    expect(refused(encBytes([0xef, 0xbb, 0xbf, ...Buffer.from(JSON.stringify(BASE))])).status).toBe(400);
    expect(refused(enc(`{"fullName":"\\ud800","title":"T","credit":"C"}`)).status).toBe(400);
    expect(refused(enc(`{"fullName":"N","title":"\\udfff","credit":"C"}`)).status).toBe(400);
    // a well-formed surrogate pair is fine
    expect(decodeSubmissionHeader(enc(`{"fullName":"\\ud83d\\ude00","title":"T","credit":"C"}`)).fullName).toBe("😀");
  });

  it("refuses bad JSON, non-objects, unknown keys, wrong types and missing fields", () => {
    for (const body of ["{", "null", "[]", "42", '"x"', "", "{} extra"]) {
      expect(refused(enc(body)).status, body).toBe(400);
    }
    expect(refused(enc({ ...BASE, extra: 1 })).status).toBe(400);
    expect(refused(enc({ ...BASE, fullName: 5 })).status).toBe(400);
    expect(refused(enc({ ...BASE, instagramDisplayConsent: "true" })).status).toBe(400);
    expect(refused(enc({ title: "T", credit: "C" })).status).toBe(400);
  });

  it("accepts a null instagramHandle as none, digesting the same as absent", () => {
    const withNull = decodeSubmissionHeader(enc({ ...BASE, instagramHandle: null }));
    expect(withNull.instagramHandle).toBeNull();
    expect(submissionDigest(withNull)).toBe(submissionDigest(decodeSubmissionHeader(enc(BASE))));
    expect(refused(enc({ ...BASE, instagramHandle: null, instagramDisplayConsent: true })).status).toBe(400);
  });

  it("refuses missing required fields", () => {
    expect(refused(enc({ fullName: "N", credit: "C" })).status).toBe(400);
    expect(refused(enc({ fullName: "N", title: "T" })).status).toBe(400);
  });

  it("refuses empty, over-long and control-character fields; counts code points", () => {
    for (const field of ["fullName", "title", "credit"] as const) {
      expect(refused(enc({ ...BASE, [field]: "   " })).status, field).toBe(400);
      expect(refused(enc({ ...BASE, [field]: "a".repeat(201) })).status, field).toBe(400);
      expect(refused(enc({ ...BASE, [field]: "a\u0000b" })).status, field).toBe(400);
      expect(refused(enc({ ...BASE, [field]: "a\nb" })).status, field).toBe(400);
      expect(decodeSubmissionHeader(enc({ ...BASE, [field]: "a".repeat(200) }))[field]).toHaveLength(200);
    }
    // 200 emoji are 200 code points (400 UTF-16 units): accepted; 201 are refused.
    expect(decodeSubmissionHeader(enc({ ...BASE, title: "😀".repeat(200) })).title).toBe("😀".repeat(200));
    expect(refused(enc({ ...BASE, title: "😀".repeat(201) })).status).toBe(400);
  });

  it("refuses a header over 6144 characters, and accepts one exactly at the limit when valid", () => {
    expect(SUBMISSION_HEADER_MAX).toBe(6144);
    expect(refused("A".repeat(SUBMISSION_HEADER_MAX + 1)).status).toBe(400);
    expect(refused("A".repeat(SUBMISSION_HEADER_MAX)).status).toBe(400); // right length, not a submission
  });

  it("tolerates duplicate JSON keys (the last wins; the digest is over the normalised object)", () => {
    const dup = `{"fullName":"First","fullName":"Second","title":"T","credit":"C"}`;
    expect(decodeSubmissionHeader(enc(dup)).fullName).toBe("Second");
  });

  it("never echoes a value in its message", () => {
    const secret = "Zzyzx Qwertyuiop";
    for (const header of [enc({ ...BASE, fullName: secret, extra: 1 }), enc({ ...BASE, fullName: secret, instagramDisplayConsent: true }), enc(`{"fullName":"${secret}`)]) {
      const error = refused(header);
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(header);
      expect(error.code).toBe("invalid_request");
    }
  });
});

describe("submissionDigest", () => {
  const FULL = { fullName: "Zoë Ångström", title: "Sunrise over LAX", credit: "Z. Ångström", instagramHandle: "zoe.flies", instagramDisplayConsent: true };

  it("is pinned to a fixed digest (changing it would break replays of stored keys)", () => {
    expect(submissionDigest(FULL)).toBe("f02d1dc98943a4f6c97a15125cf061ef7e4567319ddf80a6af91fdba8d063385");
    expect(submissionDigest({ fullName: "A", title: "B", credit: "C", instagramHandle: null, instagramDisplayConsent: false })).toBe(
      "2a1bdf54d70f1de365d0f01e3af5be8ff1b0f6a70d7514bf2f9497634c493dda",
    );
  });

  it("is the same whatever order the client wrote its keys or however it spelled the handle", () => {
    const a = decodeSubmissionHeader(enc({ fullName: "N", title: "T", credit: "C", instagramHandle: "@pat", instagramDisplayConsent: true }));
    const b = decodeSubmissionHeader(enc({ instagramDisplayConsent: true, credit: " C ", instagramHandle: "pat", title: "T", fullName: "N" }));
    expect(submissionDigest(a)).toBe(submissionDigest(b));
    // defaults written out: an absent handle and consent equal their explicit defaults
    expect(submissionDigest(decodeSubmissionHeader(enc(BASE)))).toBe(
      submissionDigest(decodeSubmissionHeader(enc({ ...BASE, instagramHandle: "@", instagramDisplayConsent: false }))),
    );
  });

  it("differs when any field differs", () => {
    const base = submissionDigest(FULL);
    for (const change of [{ fullName: "X" }, { title: "X" }, { credit: "X" }, { instagramHandle: "x" }, { instagramDisplayConsent: false }]) {
      expect(submissionDigest({ ...FULL, ...change })).not.toBe(base);
    }
  });
});
