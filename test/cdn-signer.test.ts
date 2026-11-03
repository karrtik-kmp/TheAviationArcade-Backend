import { describe, expect, it } from "vitest";
import { computeCdnToken, signCdnUrl, verifyCdnToken } from "../src/platform/cdn-signer.js";

// Algorithm: https://bunny.net/docs/cdn/security/token-authentication/advanced.md (checked 2026-11-03).
// token = "HS256-" + Base64URL(HMAC-SHA256(key, signature_path + expires + signing_data)).
// All expected tokens below are hard-coded literals; none is computed with the code under test.
const KEY = "test-signing-key-not-a-secret";
const HOST = "cdn.example.test";
const PATH = `/backend/content/photos/${"a".repeat(64)}.jpg`;
const NOW = new Date("2026-11-03T12:00:00Z");
const EXP = new Date("2026-11-04T12:00:00Z");
const EXP_UNIX = EXP.getTime() / 1000;

type Input = Parameters<typeof signCdnUrl>[0];
const sign = (over: Partial<Input> = {}) =>
  signCdnUrl({ host: HOST, path: PATH, key: KEY, expiresAt: EXP, now: NOW, ...over });
const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

describe("signCdnUrl", () => {
  it("matches Bunny's official vector (BunnyWay/BunnyCDN.TokenAuthentication e2e/vectors.json, case \"plain\")", () => {
    // https://github.com/BunnyWay/BunnyCDN.TokenAuthentication/blob/main/e2e/vectors.json
    // signedUrl https://token-tester.b-cdn.net/300kb.jpg?token=HS256-o10J...&expires=1598024587, key "SecurityKey".
    // computeCdnToken has no path guard, because /300kb.jpg is outside the allow-list that signCdnUrl enforces.
    expect(computeCdnToken("SecurityKey", "/300kb.jpg", 1598024587)).toBe("HS256-o10JRWlsAItyAsdKS6jJKjabHN4FrFsplDHPV1idcX4");
  });

  it("pins literal tokens for photo paths", () => {
    const r = sign();
    expect(r.url).toBe(`https://${HOST}${PATH}?token=HS256-JOwUJLvrzqgQ0SHDS5yMzEzsDYS2rNzncZ6aZdi3CBM&expires=1793793600`);
    expect(r.expiresAt.getTime()).toBe(1793793600 * 1000);
    const path2 = `/backend/content/photos/${"0123456789abcdef".repeat(4)}.png`;
    expect(
      signCdnUrl({ host: HOST, path: path2, key: "another key with spaces", expiresAt: new Date(2000000000 * 1000), now: NOW }).url,
    ).toBe(`https://${HOST}${path2}?token=HS256-tqqq4zEqUotfttiPTQvpt3Oe68BzIqGmF0r50GuQUeE&expires=2000000000`);
  });

  it("produces HS256- plus 43 base64url characters", () => {
    expect(tokenOf(sign().url)).toMatch(/^HS256-[A-Za-z0-9_-]{43}$/);
  });

  it("emits Base64URL with no +, / or =", () => {
    for (let i = 0; i < 200; i++) {
      const t = tokenOf(sign({ path: `/backend/content/photos/${i.toString(16).padStart(64, "0")}.png`, expiresAt: new Date(EXP.getTime() + i * 1000) }).url);
      expect(t.slice(6)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("changes the token with the path, expiry and key", () => {
    const base = tokenOf(sign().url);
    expect(tokenOf(sign({ path: `/backend/content/photos/${"b".repeat(64)}.jpg` }).url)).not.toBe(base);
    expect(tokenOf(sign({ expiresAt: new Date(EXP.getTime() + 1000) }).url)).not.toBe(base);
    expect(tokenOf(sign({ key: "other" }).url)).not.toBe(base);
  });

  it("floors sub-second expiries", () => {
    expect(sign({ expiresAt: new Date(EXP.getTime() + 999) }).url).toContain(`expires=${EXP_UNIX}`);
  });

  it.each([
    "/backend/content/other/a.jpg",
    "/other/a.jpg",
    "backend/content/photos/a.jpg",
    "/backend/content/photos/../photos/a.jpg",
    "/backend/content/photos//a.jpg",
    "/backend/content/photos/a.jpg?x=1",
    "/backend/content/photos/a#.jpg",
    "/backend/content/photos/a%2e.jpg",
    "/backend/content/photos/a\\b.jpg",
    "/backend/content/photos/a\n.jpg",
    "/backend/content/photos/a\u0000.jpg",
    "/backend/content/photos/a.gif",
    `/backend/content/photos/${"a".repeat(64)}.gif`,
    `/backend/content/photos/${"a".repeat(64)} .jpg`,
    `/backend/content/photos/${"a".repeat(63)}é.jpg`,
    `/backend/content/photos/${"a".repeat(64)};.jpg`,
    `/backend/content/photos/${"a".repeat(64)}&.jpg`,
    `/backend/content/photos/${"a".repeat(64)}'.jpg`,
    `/backend/content/photos/./${"a".repeat(64)}.jpg`,
    `/backend/content/./photos/${"a".repeat(64)}.jpg`,
    `/backend/content/photos/${"A".repeat(64)}.jpg`,
    `/backend/content/photos/${"a".repeat(63)}.jpg`,
    `/backend/content/photos/${"a".repeat(65)}.jpg`,
    `/backend/content/photos/${"a".repeat(64)}.jpg
`,
    "/backend/content/photos/a.jpg.exe",
    "/backend/content/photos/",
    "",
  ])("refuses path %j", (path) => {
    expect(() => sign({ path })).toThrow(TypeError);
  });

  it.each(["", "a b", "https://x.test", "x.test/path", "x.test:443", "-bad.test", "x_y.test", "x.test?a=1", "@x.test"])(
    "refuses host %j",
    (host) => {
      expect(() => sign({ host })).toThrow(TypeError);
    },
  );

  it("refuses an empty key and a non-future expiry", () => {
    expect(() => sign({ key: "" })).toThrow(TypeError);
    expect(() => sign({ expiresAt: NOW })).toThrow(TypeError);
    expect(() => sign({ expiresAt: new Date(NOW.getTime() - 1000) })).toThrow(TypeError);
    expect(() => sign({ expiresAt: new Date(NOW.getTime() + 500) })).toThrow(TypeError);
    expect(() => sign({ expiresAt: new Date(NaN) })).toThrow(TypeError);
  });
});

describe("verifyCdnToken", () => {
  it("round-trips", () => {
    expect(verifyCdnToken(sign().url, KEY, NOW)).toBe(true);
  });

  it("rejects a wrong key, tampering, expiry, extra params and junk", () => {
    const { url } = sign();
    expect(verifyCdnToken(url, "wrong", NOW)).toBe(false);
    expect(verifyCdnToken(url, "", NOW)).toBe(false);
    expect(verifyCdnToken(url.replace(".jpg", ".png"), KEY, NOW)).toBe(false);
    expect(verifyCdnToken(url.replace(`expires=${EXP_UNIX}`, `expires=${EXP_UNIX + 1}`), KEY, NOW)).toBe(false);
    expect(verifyCdnToken(url, KEY, EXP)).toBe(false);
    expect(verifyCdnToken(url + "&x=1", KEY, NOW)).toBe(false);
    expect(verifyCdnToken(url.replace("token=", "t="), KEY, NOW)).toBe(false);
    expect(verifyCdnToken("not a url", KEY, NOW)).toBe(false);
    expect(verifyCdnToken(url.replace(/token=[^&]*/, "token=HS256-"), KEY, NOW)).toBe(false);
  });
});
