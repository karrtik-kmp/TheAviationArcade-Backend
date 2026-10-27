import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRemoteJWKSet, errors, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuthUnavailableError,
  emulatorTokensAllowed,
  failClosedKeys,
  InvalidTokenError,
  verifyFirebaseToken,
} from "../src/auth/firebase.js";
import { emulatorToken } from "./tokens.js";

const PROJECT = "airplane-games-auth-20261022";
let privateKey: CryptoKey;
let resolver: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  resolver = async () => pair.publicKey;
});

async function signed(claims: Record<string, unknown> = {}, projectId = PROJECT, expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ auth_time: now - 60, firebase: { sign_in_provider: "password" }, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(`https://securetoken.google.com/${projectId}`)
    .setAudience(projectId)
    .setSubject("uid-123")
    .setIssuedAt(now - 60)
    .setExpirationTime(now + expiresIn)
    .sign(privateKey);
}

/** Signs a token with full control over the claims Firebase requires, so each can be broken alone. */
async function build(
  opts: {
    sub?: string | null;
    iatOffset?: number;
    authTimeOffset?: number | null;
    issuerProject?: string;
    audience?: string;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    ...(opts.authTimeOffset === null ? {} : { auth_time: now + (opts.authTimeOffset ?? -60) }),
    firebase: { sign_in_provider: "password" },
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(`https://securetoken.google.com/${opts.issuerProject ?? PROJECT}`)
    .setAudience(opts.audience ?? PROJECT)
    .setIssuedAt(now + (opts.iatOffset ?? -60))
    .setExpirationTime(now + 3600);
  if (opts.sub !== null) jwt.setSubject(opts.sub ?? "uid-123");
  return jwt.sign(privateKey);
}

const production = { projectId: PROJECT, emulator: false };

describe("verifyFirebaseToken", () => {
  it("accepts a signed token and returns the project-scoped principal", async () => {
    const identity = await verifyFirebaseToken(await signed(), production, resolver);
    expect(identity.principal).toBe(`firebase:${PROJECT}:uid-123`);
  });

  it("rejects a token for another project", async () => {
    await expect(
      verifyFirebaseToken(await signed({}, "someone-else"), production, resolver),
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await signed({}, PROJECT, -1);
    await expect(verifyFirebaseToken(token, production, resolver)).rejects.toThrow();
  });

  it("rejects sign-in providers other than email/password and Google", async () => {
    const token = await signed({ firebase: { sign_in_provider: "anonymous" } });
    await expect(verifyFirebaseToken(token, production, resolver)).rejects.toThrow();
  });

  it("accepts Google sign-in", async () => {
    const token = await signed({ firebase: { sign_in_provider: "google.com" } });
    await expect(verifyFirebaseToken(token, production, resolver)).resolves.toBeTruthy();
  });

  it("rejects unsigned tokens unless emulator mode is on", async () => {
    const token = emulatorToken("uid-123", PROJECT);
    await expect(verifyFirebaseToken(token, production, resolver)).rejects.toThrow();
  });

  it("rejects garbage", async () => {
    await expect(verifyFirebaseToken("not.a.jwt", production, resolver)).rejects.toThrow();
  });

  it("rejects an HS256 token signed with an HMAC secret", async () => {
    const secret = new TextEncoder().encode("an-hmac-secret-that-is-long-enough!");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ auth_time: now - 60, firebase: { sign_in_provider: "password" } })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(`https://securetoken.google.com/${PROJECT}`)
      .setAudience(PROJECT)
      .setSubject("uid-123")
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 3600)
      .sign(secret);
    await expect(verifyFirebaseToken(token, production, resolver)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects a missing, empty or oversized sub", async () => {
    for (const sub of [null, "", "x".repeat(129)]) {
      await expect(verifyFirebaseToken(await build({ sub }), production, resolver)).rejects.toBeInstanceOf(
        InvalidTokenError,
      );
    }
    await expect(
      verifyFirebaseToken(await build({ sub: "x".repeat(128) }), production, resolver),
    ).resolves.toBeTruthy();
  });

  it("rejects a missing auth_time", async () => {
    await expect(
      verifyFirebaseToken(await build({ authTimeOffset: null }), production, resolver),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects the right audience with the wrong issuer", async () => {
    await expect(
      verifyFirebaseToken(await build({ issuerProject: "someone-else" }), production, resolver),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("allows 60 s of clock skew on iat and auth_time, but not more", async () => {
    await expect(
      verifyFirebaseToken(await build({ iatOffset: 30, authTimeOffset: 30 }), production, resolver),
    ).resolves.toBeTruthy();
    await expect(
      verifyFirebaseToken(await build({ iatOffset: 120 }), production, resolver),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(
      verifyFirebaseToken(await build({ authTimeOffset: 120 }), production, resolver),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects an oversized token", async () => {
    const token = await signed({ padding: "x".repeat(24_000) });
    expect(token.length).toBeGreaterThan(24_000);
    await expect(verifyFirebaseToken(token, production, resolver)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("reports a key-fetch timeout as AuthUnavailableError", async () => {
    const timeout: JWTVerifyGetKey = async () => {
      throw new errors.JWKSTimeout();
    };
    await expect(verifyFirebaseToken(await signed(), production, timeout)).rejects.toBeInstanceOf(
      AuthUnavailableError,
    );
  });

  it("reports a network failure (fetch TypeError) as AuthUnavailableError", async () => {
    const offline: JWTVerifyGetKey = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(verifyFirebaseToken(await signed(), production, offline)).rejects.toBeInstanceOf(
      AuthUnavailableError,
    );
  });

  it("reports an unknown key id as an invalid token, not an outage", async () => {
    const noKey: JWTVerifyGetKey = async () => {
      throw new errors.JWKSNoMatchingKey();
    };
    await expect(verifyFirebaseToken(await signed(), production, noKey)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });
});

describe("emulator tokens", () => {
  const demo = { projectId: "demo-airplane-games", emulator: true };

  it("accepts an unsigned demo-airplane-games token when emulator mode is on", async () => {
    const identity = await verifyFirebaseToken(emulatorToken("uid-123"), demo);
    expect(identity.principal).toBe("firebase:demo-airplane-games:uid-123");
  });

  it("rejects an unsigned token for the production project even with emulator=true", async () => {
    await expect(
      verifyFirebaseToken(emulatorToken("uid-123", PROJECT), { projectId: PROJECT, emulator: true }),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects an unsigned token for any other demo- project", async () => {
    await expect(
      verifyFirebaseToken(emulatorToken("uid-123", "demo-other"), { projectId: "demo-other", emulator: true }),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe("emulatorTokensAllowed", () => {
  it("is never allowed for a non-demo project, even with the flag set", () => {
    expect(emulatorTokensAllowed(PROJECT, "true")).toBe(false);
  });

  it("is not allowed for other demo- projects", () => {
    expect(emulatorTokensAllowed("demo-other", "true")).toBe(false);
  });

  it("needs both the flag and the demo-airplane-games project", () => {
    expect(emulatorTokensAllowed("demo-airplane-games", "true")).toBe(true);
    expect(emulatorTokensAllowed("demo-airplane-games", undefined)).toBe(false);
  });
});

describe("failClosedKeys (remote key fetch)", () => {
  // A local stub standing in for Google's JWKS endpoint. The production path uses the same wrapper
  // around createRemoteJWKSet pointed at Google's fixed URL.
  let stub: Server;
  let base: string;
  let mode: "http500" | "badjson" | "empty" | "ok" = "ok";
  let publicJwk: object;

  beforeAll(async () => {
    publicJwk = { ...(await exportJWK((await generateKeyPair("RS256", { extractable: true })).publicKey)), kid: "other" };
    stub = createServer((_req, res) => {
      if (mode === "http500") {
        res.writeHead(500).end("nope");
      } else if (mode === "badjson") {
        res.writeHead(200, { "content-type": "application/json" }).end("{ not json");
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ keys: mode === "empty" ? [] : [publicJwk] }),
        );
      }
    });
    await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/jwks`;
  });

  afterAll(async () => {
    await new Promise((done) => stub.close(done));
  });

  // A fresh resolver per case: createRemoteJWKSet caches successful fetches.
  const resolverFor = (timeoutDuration = 1000) =>
    failClosedKeys(createRemoteJWKSet(new URL(base), { timeoutDuration }));

  it("reports an HTTP 500 from the key endpoint as AuthUnavailableError", async () => {
    mode = "http500";
    await expect(verifyFirebaseToken(await signed(), production, resolverFor())).rejects.toBeInstanceOf(
      AuthUnavailableError,
    );
  });

  it("reports malformed JSON from the key endpoint as AuthUnavailableError", async () => {
    mode = "badjson";
    await expect(verifyFirebaseToken(await signed(), production, resolverFor())).rejects.toBeInstanceOf(
      AuthUnavailableError,
    );
  });

  it("reports an unreachable key endpoint as AuthUnavailableError", async () => {
    const dead = failClosedKeys(createRemoteJWKSet(new URL("http://127.0.0.1:1/jwks"), { timeoutDuration: 500 }));
    await expect(verifyFirebaseToken(await signed(), production, dead)).rejects.toBeInstanceOf(
      AuthUnavailableError,
    );
  });

  it("keeps an unknown kid a token problem, not an outage", async () => {
    mode = "ok";
    await expect(verifyFirebaseToken(await signed(), production, resolverFor())).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });
});
