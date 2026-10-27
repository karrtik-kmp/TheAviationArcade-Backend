import { Reflector } from "@nestjs/core";
import type { ArgumentsHost, ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ApiExceptionFilter } from "../src/common/api-exception.filter.js";
import type { ApiError } from "../src/common/errors.js";
import type { AppConfig } from "../src/config/config.module.js";

// Replace only the verifier; keep the real error classes so instanceof checks line up.
vi.mock("../src/auth/firebase.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/firebase.js")>()),
  verifyFirebaseToken: vi.fn(),
}));

const { AuthUnavailableError, InvalidTokenError, verifyFirebaseToken } = await import("../src/auth/firebase.js");
const { FirebaseAuthGuard } = await import("../src/auth/firebase-auth.guard.js");

const config = { firebaseProjectId: "demo-airplane-games", emulatorTokens: false } as AppConfig;

function contextWith(authorization: string): ExecutionContext {
  const req = { header: () => authorization };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
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
  const guard = new FirebaseAuthGuard(config, new Reflector());

  it("turns AuthUnavailableError into 503 auth_unavailable with Retry-After", async () => {
    vi.mocked(verifyFirebaseToken).mockRejectedValueOnce(new AuthUnavailableError());
    const error = await rejection(guard.canActivate(contextWith("Bearer abc")));
    expect(error).toMatchObject({ status: 503, code: "auth_unavailable", headers: { "Retry-After": "5" } });
  });

  it("turns a bad token into 401 with WWW-Authenticate", async () => {
    vi.mocked(verifyFirebaseToken).mockRejectedValueOnce(new InvalidTokenError());
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
});
