import { Reflector } from "@nestjs/core";
import { ThrottlerStorageService } from "@nestjs/throttler";
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { ApiError } from "../src/common/errors.js";
import type { AppConfig } from "../src/config/config.module.js";
import { poolOptions } from "../src/database/database.module.js";
import { ClientVersionGuard, SkipClientVersion } from "../src/platform/client-version.js";
import { throttlerOptions } from "../src/platform/rate-limit.js";
import { SERVER_TIMEOUTS } from "../src/platform/server-timeouts.js";

function contextWith(header: string | undefined, handler: () => void = () => undefined): ExecutionContext {
  const req = { header: (name: string) => (name === "x-client-version" ? header : undefined) };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function gate(minClientBuild: number | undefined) {
  return new ClientVersionGuard({ minClientBuild } as AppConfig, new Reflector());
}

function rejection(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected a rejection");
}

describe("ClientVersionGuard", () => {
  it("is off when MIN_CLIENT_BUILD is unset, whatever the header says", () => {
    expect(gate(undefined).canActivate(contextWith(undefined))).toBe(true);
    expect(gate(undefined).canActivate(contextWith("garbage"))).toBe(true);
  });

  it("accepts the minimum and anything above it", () => {
    expect(gate(10).canActivate(contextWith("10"))).toBe(true);
    expect(gate(10).canActivate(contextWith(" 11 "))).toBe(true);
    expect(gate(10).canActivate(contextWith("999999999"))).toBe(true);
  });

  it("rejects a lower, missing or malformed build with 426 client_update_required", () => {
    for (const header of [undefined, "", "9", "0", "-10", "10.5", "1e3", "0x10", "abc", "10, 11", "0010", "1234567890"]) {
      const error = rejection(() => gate(10).canActivate(contextWith(header)));
      expect(error, String(header)).toMatchObject({ status: 426, code: "client_update_required" });
    }
  });

  it("skips routes marked @SkipClientVersion()", () => {
    const handler = () => undefined;
    SkipClientVersion()(handler, "handler", { value: handler });
    expect(gate(10).canActivate(contextWith(undefined, handler))).toBe(true);
  });
});

describe("server timeouts", () => {
  it("keep-alive outlasts a 60 s proxy idle timeout and headersTimeout exceeds keep-alive", () => {
    expect(SERVER_TIMEOUTS.keepAliveTimeout).toBeGreaterThan(60_000);
    expect(SERVER_TIMEOUTS.headersTimeout).toBeGreaterThan(SERVER_TIMEOUTS.keepAliveTimeout);
    expect(SERVER_TIMEOUTS.requestTimeout).toBeGreaterThanOrEqual(SERVER_TIMEOUTS.headersTimeout);
  });
});

describe("poolOptions ssl", () => {
  const base = { databaseUrl: "postgres://u:p@h/db", dbPoolMax: 5 };

  it("maps DATABASE_SSL to pg's ssl option", () => {
    expect(poolOptions({ ...base, databaseSsl: "disable", databaseCaCert: undefined }).ssl).toBe(false);
    expect(poolOptions({ ...base, databaseSsl: "require", databaseCaCert: undefined }).ssl).toEqual({
      rejectUnauthorized: false,
    });
    expect(poolOptions({ ...base, databaseSsl: "verify-full", databaseCaCert: undefined }).ssl).toEqual({
      rejectUnauthorized: true,
    });
    expect(poolOptions({ ...base, databaseSsl: "verify-full", databaseCaCert: "PEM" }).ssl).toEqual({
      rejectUnauthorized: true,
      ca: "PEM",
    });
  });
});

describe("rate limit semantics", () => {
  it("configures no punitive block (blockDuration 0) on a 60 s window", () => {
    const options = throttlerOptions({ rateLimitAuthPerMin: 5, rateLimitPublicPerMin: 2 });
    const [throttler] = (options as { throttlers: { ttl: number; blockDuration: number }[] }).throttlers;
    expect(throttler).toMatchObject({ ttl: 60_000, blockDuration: 0 });
  });

  it("with blockDuration 0 the library rejects only while over the limit, then lets requests through again", async () => {
    const storage = new ThrottlerStorageService();
    try {
      const hit = () => storage.increment("k", 300, 2, 0, "default");
      expect((await hit()).isBlocked).toBe(false);
      expect((await hit()).isBlocked).toBe(false);
      const over = await hit();
      expect(over.isBlocked).toBe(true);
      expect(over.timeToBlockExpire).toBeGreaterThanOrEqual(0);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await hit()).isBlocked).toBe(false);
    } finally {
      storage.onApplicationShutdown?.();
    }
  });
});
