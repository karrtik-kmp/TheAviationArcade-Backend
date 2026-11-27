import { describe, expect, it } from "vitest";
import { InvalidTokenError, verifyFirebaseToken } from "../src/auth/firebase.js";
import { loadConfig } from "../src/config/config.module.js";
import { isCallsignConflict } from "../src/balance/player-balance.js";
import { ipBucket } from "../src/platform/ip-bucket.js";
import {
  CALLSIGN_CHANGE_COOLDOWN_MS,
  RESERVED_CALLSIGNS,
  isReservedCallsign,
  normalizeCallsign,
} from "../src/players/callsign-rules.js";
import { emulatorToken, guestToken, linkedToken } from "./tokens.js";

// docs/plans/guest-callsign.md G1, G3, C1: the pure parts. The routes are covered by test/guests.e2e.test.ts and test/callsigns.e2e.test.ts.

const DEMO = "demo-airplane-games";
const guestsOn = { projectId: DEMO, emulator: true, anonymousPlayers: true };
const guestsOff = { projectId: DEMO, emulator: true };
const anonymous = (identities: unknown, email: string | null = null) =>
  emulatorToken("uid-g", DEMO, "anonymous", { email, emailVerified: false, identities });

describe("guest test (G1)", () => {
  it("an anonymous token with empty identities is a guest when guests are on, and 401 when they are off", async () => {
    const identity = await verifyFirebaseToken(guestToken("uid-g"), guestsOn);
    expect(identity).toMatchObject({ principal: `firebase:${DEMO}:uid-g`, anonymous: true, email: undefined, emailVerified: false });
    await expect(verifyFirebaseToken(guestToken("uid-g"), guestsOff)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("an anonymous token without an identities claim is a guest too", async () => {
    expect((await verifyFirebaseToken(anonymous(undefined), guestsOn)).anonymous).toBe(true);
  });

  // ASSUMPTION (plan G1): an `email` identity counts as linked without email_verified (a fresh email/password link is unverified).
  // It relies on Firebase adding `identities.email` only when an email credential is linked; check the real tokens on dev.
  it("ASSUMPTION: an anonymous token that holds an email or google.com identity is a linked ACCOUNT, whatever the flag says", async () => {
    for (const identities of [{ email: ["a@sites.test"] }, { "google.com": ["1234"] }, { email: ["a@sites.test"], "google.com": ["1"] }]) {
      for (const options of [guestsOn, guestsOff]) {
        const identity = await verifyFirebaseToken(anonymous(identities, "a@sites.test"), options);
        expect(identity.anonymous).toBe(false);
      }
    }
  });

  it("other identity keys (phone, ...) and empty lists leave the token a guest", async () => {
    for (const identities of [{ phone: ["+15550100"] }, { email: [] }, { "google.com": [] }, { email: [], phone: ["+1"] }, { "apple.com": [] }]) {
      expect((await verifyFirebaseToken(anonymous(identities), guestsOn)).anonymous).toBe(true);
      await expect(verifyFirebaseToken(anonymous(identities), guestsOff)).rejects.toBeInstanceOf(InvalidTokenError);
    }
  });

  it("an anonymous token with malformed identities is refused (401) even with guests on", async () => {
    for (const identities of [null, [], "email", { email: "a@sites.test" }, { email: [1] }, { "google.com": [""] }, { "apple.com": "x" }]) {
      await expect(verifyFirebaseToken(anonymous(identities), guestsOn)).rejects.toBeInstanceOf(InvalidTokenError);
    }
  });

  // ASSUMPTION (plan G1): Firebase names an Apple link `apple.com` in `identities`; check a real linked token on dev.
  it("ASSUMPTION: an anonymous token linked to Apple is a linked ACCOUNT, whatever the flag says", async () => {
    for (const identities of [{ "apple.com": ["001234.abcd"] }, { email: ["x@privaterelay.appleid.com"], "apple.com": ["1"] }]) {
      for (const options of [guestsOn, guestsOff]) {
        expect((await verifyFirebaseToken(anonymous(identities), options)).anonymous).toBe(false);
      }
    }
    await expect(verifyFirebaseToken(anonymous({ "apple.com": [""] }), guestsOn)).rejects.toBeInstanceOf(InvalidTokenError);
    expect((await verifyFirebaseToken(anonymous({ "apple.com": [] }), guestsOn)).anonymous).toBe(true);
  });

  it("apple.com tokens are accounts", async () => {
    expect((await verifyFirebaseToken(emulatorToken("uid-a", DEMO, "apple.com"), guestsOff)).anonymous).toBe(false);
  });

  it("password and google.com tokens stay accounts, with or without identities", async () => {
    expect((await verifyFirebaseToken(emulatorToken("uid-p"), guestsOn)).anonymous).toBe(false);
    expect((await verifyFirebaseToken(emulatorToken("uid-p", DEMO, "google.com"), guestsOff)).anonymous).toBe(false);
    expect((await verifyFirebaseToken(linkedToken("uid-p"), guestsOn)).anonymous).toBe(false);
  });

  it("every other provider is still refused", async () => {
    for (const provider of ["phone", "custom", "facebook.com", "Apple.com", "Anonymous"]) {
      await expect(verifyFirebaseToken(emulatorToken("uid-x", DEMO, provider), guestsOn)).rejects.toBeInstanceOf(InvalidTokenError);
    }
  });
});

describe("ipBucket (G3)", () => {
  it("keeps IPv4, and maps IPv4-mapped IPv6 to its IPv4", () => {
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("::FFFF:203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("buckets IPv6 by /64, whatever the spelling", () => {
    const bucket = "2001:0db8:0000:0001::/64";
    expect(ipBucket("2001:db8:0:1::1")).toBe(bucket);
    expect(ipBucket("2001:db8:0:1:ffff:ffff:ffff:ffff")).toBe(bucket);
    expect(ipBucket("2001:DB8:0:1:0:0:0:2")).toBe(bucket);
    expect(ipBucket("2001:db8:0:1::1%eth0")).toBe(bucket);
    expect(ipBucket("2001:db8:0:2::1")).not.toBe(bucket);
    expect(ipBucket("::1")).toBe("0000:0000:0000:0000::/64");
    expect(ipBucket("2001:db8::")).toBe("2001:0db8:0000:0000::/64");
    expect(ipBucket("64:ff9b::192.0.2.33")).toBe("0064:ff9b:0000:0000::/64");
  });

  it("puts a missing or unparseable address in one fixed bucket", () => {
    expect(ipBucket(undefined)).toBe("unknown");
    expect(ipBucket("")).toBe("unknown");
    expect(ipBucket("not-an-ip")).toBe("unknown");
  });
});

describe("Callsign rules (C1, mirrors Unity CallsignRules)", () => {
  it("trims and upper-cases 3 to 16 ASCII letters or digits", () => {
    expect(normalizeCallsign("skyward42")).toBe("SKYWARD42");
    expect(normalizeCallsign("  Sky1 ")).toBe("SKY1");
    expect(normalizeCallsign("abc")).toBe("ABC");
    expect(normalizeCallsign("A".repeat(16))).toBe("A".repeat(16));
  });

  it("refuses short, long, spaced, punctuated and non-ASCII values", () => {
    for (const raw of ["ab", "A".repeat(17), "sky ward", "sky-ward", "sky_ward", "", "   ", "straße", "skyıard", "ſky", "ÄBC", "１２３"]) {
      expect(normalizeCallsign(raw), raw).toBeNull();
    }
    expect(normalizeCallsign(" ".repeat(61) + "ABCD")).toBeNull(); // over the 64-character raw cap
  });

  it("ASSUMPTION: reserves only staff-impersonation names and the app's placeholders, matched exactly", () => {
    expect([...RESERVED_CALLSIGNS]).toEqual(["ADMIN", "ADMINISTRATOR", "MODERATOR", "STAFF", "SUPPORT", "SYSTEM", "OFFICIAL", "PILOT", "GUEST"]);
    expect(isReservedCallsign("PILOT")).toBe(true);
    expect(isReservedCallsign("PILOT1")).toBe(false);
  });

  it("a race on the Callsign index or a swap deadlock is a conflict (409 callsign_taken); other errors are not", () => {
    const wrapped = (cause: object) => Object.assign(new Error("drizzle"), { cause: Object.assign(new Error("pg"), cause) });
    expect(isCallsignConflict(wrapped({ code: "23505", constraint: "players_callsign_unique" }))).toBe(true);
    expect(isCallsignConflict(wrapped({ code: "40P01" }))).toBe(true);
    expect(isCallsignConflict(wrapped({ code: "23505", constraint: "players_pkey" }))).toBe(false);
    expect(isCallsignConflict(wrapped({ code: "23514", constraint: "players_callsign_check" }))).toBe(false);
    expect(isCallsignConflict(wrapped({ code: "55P03" }))).toBe(false);
    expect(isCallsignConflict(new Error("plain"))).toBe(false);
  });

  it("ASSUMPTION: after the free change, one change per 30 days", () => {
    expect(CALLSIGN_CHANGE_COOLDOWN_MS).toBe(30 * 24 * 3600 * 1000);
  });
});

describe("config (G1, G3)", () => {
  const base = {
    APP_ENV: "local",
    DATABASE_URL: "postgres://u:p@127.0.0.1:5433/airplane_games_test",
    FIREBASE_PROJECT_ID: DEMO,
  };
  const production = {
    APP_ENV: "production",
    DATABASE_URL: "postgres://u:p@db.internal:5432/airplane_games_dev",
    FIREBASE_PROJECT_ID: "airplane-games-9fe1e",
    BUNNY_CDN_HOST: "my-zone.b-cdn.net",
    BUNNY_CDN_TOKEN_KEY: "0123456789abcdef-secret-key",
  };

  it("guests are off by default; only the exact value true turns them on", () => {
    expect(loadConfig(base).anonymousPlayers).toBe(false);
    expect(loadConfig({ ...base, FIREBASE_ANONYMOUS_PLAYERS: "" }).anonymousPlayers).toBe(false);
    expect(loadConfig({ ...base, FIREBASE_ANONYMOUS_PLAYERS: "false" }).anonymousPlayers).toBe(false);
    expect(loadConfig({ ...base, FIREBASE_ANONYMOUS_PLAYERS: "true" }).anonymousPlayers).toBe(true);
    for (const value of ["TRUE", "1", "yes", "on"]) {
      expect(() => loadConfig({ ...base, FIREBASE_ANONYMOUS_PLAYERS: value })).toThrow("FIREBASE_ANONYMOUS_PLAYERS");
    }
  });

  it("ASSUMPTION: 20 new guests per IP per hour by default; 1 to 100000 accepted", () => {
    expect(loadConfig(base).guestCreatePerIpPerHour).toBe(20);
    expect(loadConfig({ ...base, GUEST_CREATE_PER_IP_PER_HOUR: "5" }).guestCreatePerIpPerHour).toBe(5);
    for (const value of ["0", "-1", "2.5", "abc", "100001"]) {
      expect(() => loadConfig({ ...base, GUEST_CREATE_PER_IP_PER_HOUR: value })).toThrow("GUEST_CREATE_PER_IP_PER_HOUR");
    }
  });

  it("a deployment with guests on must trust its proxy, or every guest shares the proxy's address", () => {
    expect(() => loadConfig({ ...production, FIREBASE_ANONYMOUS_PLAYERS: "true" })).toThrow("needs TRUST_PROXY");
    expect(loadConfig({ ...production, FIREBASE_ANONYMOUS_PLAYERS: "true", TRUST_PROXY: "1" }).anonymousPlayers).toBe(true);
    expect(loadConfig(production).anonymousPlayers).toBe(false);
  });
});
