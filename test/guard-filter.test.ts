import { Reflector } from "@nestjs/core";
import type { ArgumentsHost, ExecutionContext } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { describe, expect, it, vi } from "vitest";
import { ApiExceptionFilter } from "../src/common/api-exception.filter.js";
import { ApiError } from "../src/common/errors.js";
import type { AppConfig } from "../src/config/config.module.js";

// Replace only the verifier; keep the real error classes so instanceof checks line up.
vi.mock("../src/auth/firebase.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/firebase.js")>()),
  verifyCredential: vi.fn(),
}));

const { AuthUnavailableError, InvalidTokenError, verifyCredential } = await import("../src/auth/firebase.js");
const { SessionCookieAllowed } = await import("../src/auth/session-cookie.decorator.js");
const { FirebaseAuthGuard } = await import("../src/auth/firebase-auth.guard.js");

const config = { firebaseProjectId: "demo-airplane-games", emulatorTokens: false, firebaseAdmin: { kind: "emulator" }, rateLimitAuthPerMin: 100 } as unknown as AppConfig;
const check = vi.fn();
const storage = { increment: vi.fn(async () => ({ isBlocked: false, timeToBlockExpire: 0 })) } as unknown as ThrottlerStorage;
const identity = { principal: "firebase:demo-airplane-games:u1", uid: "u1", emailVerified: true, email: "u1@sites.test", anonymous: false, authTime: 1 };

function contextWith(authorization: string, handler: () => void = () => undefined): ExecutionContext {
  const req: Record<string, unknown> = { header: () => authorization };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected a rejection");
}

describe("FirebaseAuthGuard", () => {
  const guard = new FirebaseAuthGuard(config, new Reflector(), { check } as never, storage);

  it("turns AuthUnavailableError into 503 auth_unavailable with Retry-After", async () => {
    vi.mocked(verifyCredential).mockRejectedValueOnce(new AuthUnavailableError());
    const error = await rejection(guard.canActivate(contextWith("Bearer abc")));
    expect(error).toMatchObject({ status: 503, code: "auth_unavailable", headers: { "Retry-After": "5" } });
  });

  it("a session cookie on a handler without @SessionCookieAllowed() is 401 before any revocation lookup", async () => {
    check.mockClear();
    vi.mocked(verifyCredential).mockResolvedValueOnce({ identity, kind: "sessionCookie" });
    const error = await rejection(guard.canActivate(contextWith("Bearer abc")));
    expect(error).toMatchObject({ status: 401, code: "unauthorized", headers: { "WWW-Authenticate": "Bearer" } });
    expect(check).not.toHaveBeenCalled();
  });

  it("a session cookie on an allowed handler is checked for revocation once and sets credentialKind", async () => {
    check.mockReset().mockResolvedValue("ok");
    const handler = () => undefined;
    SessionCookieAllowed()({}, "handler", { value: handler });
    vi.mocked(verifyCredential).mockResolvedValueOnce({ identity, kind: "sessionCookie" });
    const context = contextWith("Bearer abc", handler);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(check).toHaveBeenCalledWith("u1", 1);
    expect(context.switchToHttp().getRequest()).toMatchObject({ principal: identity.principal, credentialKind: "sessionCookie" });
  });

  it("an ID token never touches revocation", async () => {
    check.mockClear();
    vi.mocked(verifyCredential).mockResolvedValueOnce({ identity, kind: "idToken" });
    await expect(guard.canActivate(contextWith("Bearer abc"))).resolves.toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it("turns a bad token into 401 with WWW-Authenticate", async () => {
    vi.mocked(verifyCredential).mockRejectedValueOnce(new InvalidTokenError());
    const error = await rejection(guard.canActivate(contextWith("Bearer abc")));
    expect(error).toMatchObject({ status: 401, code: "unauthorized", headers: { "WWW-Authenticate": "Bearer" } });
  });
});

function hostFor() {
  const sent: { status?: number; body?: any; headers: Record<string, string> } = { headers: {} };
  const res = {
    setHeader: (name: string, value: string) => void (sent.headers[name] = value),
    hasHeader: (name: string) => name in sent.headers,
    status: (code: number) => {
      sent.status = code;
      return { json: (body: unknown) => void (sent.body = body) };
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ requestId: "rid-12345678" }), getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { sent, host };
}

describe("ApiExceptionFilter", () => {
  it("maps database unavailability to 503 service_unavailable with Retry-After and no SQL", () => {
    const cause = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    const error = new Error("Failed query: update players set x = $1 params: secret-param", { cause });
    const { sent, host } = hostFor();
    new ApiExceptionFilter().catch(error, host);
    expect(sent.status).toBe(503);
    expect(sent.headers["Retry-After"]).toBe("5");
    expect(sent.body.error.code).toBe("service_unavailable");
    expect(JSON.stringify(sent.body)).not.toContain("secret-param");
  });

  it("extra body fields can never replace the error object", () => {
    const { sent, host } = hostFor();
    const error = new ApiError(422, "import_invalid", "x", {}, { report: [], error: "overridden" });
    new ApiExceptionFilter().catch(error, host);
    expect(sent.body.report).toEqual([]);
    expect(sent.body.error).toMatchObject({ code: "import_invalid", requestId: "rid-12345678" });
  });
});
