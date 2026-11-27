import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { firebaseAccountsFor, IdentityToolkitAccounts } from "../src/accounts/firebase-accounts.js";
import type { FirebaseAccounts, SessionStateResult } from "../src/accounts/firebase-accounts.js";
import { SessionRevocation } from "../src/accounts/session-revocation.js";
import type { AppConfig, FirebaseAdminConfig } from "../src/config/config.module.js";

// SessionRevocation (docs/plans/session-cookies.md C5): verdict, cache, in-flight sharing and the deadline.

const PROJECT = "airplane-games-9fe1e";
const admin: FirebaseAdminConfig = { kind: "emulator", projectId: "demo-airplane-games", host: "127.0.0.1:9199" };
const appConfig = (firebaseAdmin: FirebaseAdminConfig | undefined) => ({ firebaseAdmin }) as Pick<AppConfig, "firebaseAdmin">;

/** A scripted FirebaseAccounts: each call answers the next reply (the last one repeats). */
function scripted(...replies: SessionStateResult[]) {
  const calls: string[] = [];
  const accounts: FirebaseAccounts = {
    ensureEmailVerified: async () => ({ kind: "not_configured" }),
    lookupSessionState: async (uid) => {
      calls.push(uid);
      return replies[Math.min(calls.length - 1, replies.length - 1)] ?? { kind: "unavailable" };
    },
  };
  return { accounts, calls };
}

function build(accounts: FirebaseAccounts, options?: { deadlineMs?: number }) {
  let clock = 1_000_000;
  const revocation = new SessionRevocation(accounts, appConfig(admin), { now: () => clock, ...options });
  return { revocation, advance: (ms: number) => (clock += ms) };
}

const found = (validSince?: number, disabled = false): SessionStateResult => ({ kind: "found", disabled, validSince });

afterEach(() => vi.restoreAllMocks());

describe("SessionRevocation verdicts", () => {
  it("ok when not disabled and validSince is absent", async () => {
    expect(await build(scripted(found()).accounts).revocation.check("u1", 100)).toBe("ok");
  });

  it("revoked only when auth_time is before validSince (equal is ok)", async () => {
    const { revocation } = build(scripted(found(1000)).accounts);
    expect(await revocation.check("u1", 999)).toBe("revoked");
    expect(await revocation.check("u1", 1000)).toBe("ok");
    expect(await revocation.check("u1", 1001)).toBe("ok");
  });

  it("disabled is revoked", async () => {
    expect(await build(scripted(found(undefined, true)).accounts).revocation.check("u1", 100)).toBe("revoked");
  });

  it("ASSUMPTION: an account that is not found is revoked (firebase-admin also refuses it)", async () => {
    expect(await build(scripted({ kind: "not_found" }).accounts).revocation.check("u1", 100)).toBe("revoked");
  });

  it("unavailable and a throwing lookup are unavailable", async () => {
    expect(await build(scripted({ kind: "unavailable" }).accounts).revocation.check("u1", 100)).toBe("unavailable");
    const throwing: FirebaseAccounts = { ensureEmailVerified: async () => ({ kind: "not_configured" }), lookupSessionState: async () => Promise.reject(new Error("boom")) };
    expect(await build(throwing).revocation.check("u1", 100)).toBe("unavailable");
  });
});

describe("SessionRevocation not configured", () => {
  it("without a Firebase Admin config answers not_configured, never looks up, and logs one error at construction", async () => {
    const { Logger } = await import("@nestjs/common");
    const spy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const accounts = firebaseAccountsFor(undefined);
    const lookup = vi.spyOn(accounts, "lookupSessionState");
    const revocation = new SessionRevocation(accounts, appConfig(undefined));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await revocation.check("u1", 1)).toBe("not_configured");
    expect(await revocation.check("u1", 1)).toBe("not_configured");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("SessionRevocation cache", () => {
  it("reuses an OK within 60 s and fetches again after", async () => {
    const s = scripted(found());
    const { revocation, advance } = build(s.accounts);
    await revocation.check("u1", 1);
    advance(59_000);
    await revocation.check("u1", 1);
    expect(s.calls).toHaveLength(1);
    advance(1_001);
    await revocation.check("u1", 1);
    expect(s.calls).toHaveLength(2);
  });

  it("compares each request's own auth_time with the cached validSince", async () => {
    const s = scripted(found(500));
    const { revocation } = build(s.accounts);
    expect(await revocation.check("u1", 600)).toBe("ok");
    expect(await revocation.check("u1", 400)).toBe("revoked");
    expect(await revocation.check("u1", 500)).toBe("ok");
    expect(s.calls).toHaveLength(1);
  });

  it("disabled and not_found are cached as refusals, never as ok", async () => {
    for (const reply of [found(undefined, true), { kind: "not_found" } as const]) {
      const s = scripted(reply, found());
      const { revocation } = build(s.accounts);
      expect(await revocation.check("u1", 100)).toBe("revoked");
      expect(await revocation.check("u1", 100)).toBe("revoked");
      expect(s.calls).toHaveLength(1);
    }
  });

  it("unavailable is never cached", async () => {
    const s = scripted({ kind: "unavailable" }, found());
    const { revocation } = build(s.accounts);
    expect(await revocation.check("u1", 100)).toBe("unavailable");
    expect(await revocation.check("u1", 100)).toBe("ok");
    expect(s.calls).toHaveLength(2);
  });

  it("is keyed per uid", async () => {
    const s = scripted(found());
    const { revocation } = build(s.accounts);
    await revocation.check("u1", 1);
    await revocation.check("u2", 1);
    expect(s.calls).toEqual(["u1", "u2"]);
  });

  it("holds at most 10,000 entries, evicting the oldest", async () => {
    const s = scripted(found());
    const { revocation } = build(s.accounts);
    for (let i = 0; i < 10_001; i += 1) await revocation.check(`u${i}`, 1);
    expect(s.calls).toHaveLength(10_001);
    await revocation.check("u10000", 1); // newest: still cached
    expect(s.calls).toHaveLength(10_001);
    await revocation.check("u0", 1); // oldest: evicted
    expect(s.calls).toHaveLength(10_002);
  }, 30_000);
});

describe("SessionRevocation in flight and deadline", () => {
  it("concurrent callers for one uid share one lookup", async () => {
    let resolve: ((r: SessionStateResult) => void) | undefined;
    let calls = 0;
    const accounts: FirebaseAccounts = {
      ensureEmailVerified: async () => ({ kind: "not_configured" }),
      lookupSessionState: () => {
        calls += 1;
        return new Promise<SessionStateResult>((r) => (resolve = r));
      },
    };
    const { revocation } = build(accounts);
    const all = [revocation.check("u1", 1), revocation.check("u1", 1), revocation.check("u1", 1)];
    await Promise.resolve();
    resolve?.(found());
    expect(await Promise.all(all)).toEqual(["ok", "ok", "ok"]);
    expect(calls).toBe(1);
  });

  it("passes a live deadline signal to the lookup (the slow-call tests below prove it fires)", async () => {
    let seen: AbortSignal | undefined;
    const accounts: FirebaseAccounts = {
      ensureEmailVerified: async () => ({ kind: "not_configured" }),
      lookupSessionState: async (_uid, signal) => {
        seen = signal;
        return found();
      },
    };
    await build(accounts).revocation.check("u1", 1);
    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(false);
  });
});

describe("SessionRevocation with the real client", () => {
  let config: Extract<FirebaseAdminConfig, { kind: "service_account" }>;
  beforeAll(async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    config = { kind: "service_account", projectId: PROJECT, clientEmail: "bot@airplane-games-9fe1e.iam.gserviceaccount.com", privateKeyId: "k", privateKeyPem: await exportPKCS8(privateKey) };
  });

  it("two concurrent cold calls make one token POST and one lookup", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      await new Promise((r) => setTimeout(r, 10));
      return url.includes("oauth2")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 })
        : new Response(JSON.stringify({ users: [{ localId: "u1", validSince: "100" }] }), { status: 200 });
    }) as typeof fetch;
    const revocation = new SessionRevocation(new IdentityToolkitAccounts(config, { fetch: fetchFn }), appConfig(config));
    expect(await Promise.all([revocation.check("u1", 200), revocation.check("u1", 50)])).toEqual(["ok", "revoked"]);
    expect(urls.filter((u) => u.includes("oauth2"))).toHaveLength(1);
    expect(urls.filter((u) => u.includes("accounts:lookup"))).toHaveLength(1);
  });

  it("a slow token mint is unavailable within the deadline", async () => {
    const fetchFn = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const revocation = new SessionRevocation(new IdentityToolkitAccounts(config, { fetch: fetchFn }), appConfig(config), { deadlineMs: 50 });
    const started = Date.now();
    expect(await revocation.check("u1", 1)).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a slow lookup is unavailable within the deadline and is not cached", async () => {
    let lookups = 0;
    const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("oauth2")) return Promise.resolve(new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 }));
      lookups += 1;
      if (lookups > 1) return Promise.resolve(new Response(JSON.stringify({ users: [{ localId: "u1" }] }), { status: 200 }));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as typeof fetch;
    const revocation = new SessionRevocation(new IdentityToolkitAccounts(config, { fetch: fetchFn }), appConfig(config), { deadlineMs: 50 });
    expect(await revocation.check("u1", 1)).toBe("unavailable");
    expect(await revocation.check("u1", 1)).toBe("ok");
  });

  it("the emulator config uses the emulator host with Bearer owner", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ users: [{ localId: "u1" }] }), { status: 200 });
    }) as typeof fetch;
    const revocation = new SessionRevocation(firebaseAccountsFor(admin, { fetch: fetchFn }), appConfig(admin));
    expect(await revocation.check("u1", 1)).toBe("ok");
    expect(seen).toEqual([{ url: "http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/projects/demo-airplane-games/accounts:lookup", auth: "Bearer owner" }]);
  });
});
