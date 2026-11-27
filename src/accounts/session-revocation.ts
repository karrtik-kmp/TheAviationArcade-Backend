import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { FIREBASE_ACCOUNTS } from "./firebase-accounts.js";
import type { FirebaseAccounts, SessionStateResult } from "./firebase-accounts.js";

/**
 * Is a verified Firebase session cookie still allowed? (docs/plans/session-cookies.md C5.) A cookie stays valid while its account
 * exists, is not disabled and `auth_time >= validSince` (seconds; undefined = never revoked), the same rule as firebase-admin's
 * `verifySessionCookie(cookie, true)`.
 *
 * Answers:
 *  - `ok`: allowed;
 *  - `revoked`: account disabled, account not found (ASSUMPTION: firebase-admin also refuses these), or `auth_time < validSince`;
 *  - `unavailable`: Firebase could not answer within the deadline (caller answers 503, never caches);
 *  - `not_configured`: no Admin credential (config `firebaseAdmin` undefined); caller answers 503.
 *
 * Definitive answers are cached per `projectId:uid` for 60 s (max 10,000 entries, oldest evicted): an OK keeps its `validSince` so
 * every request still compares its own `auth_time`; disabled / not found are cached as refusals. Errors are never cached. A disable
 * or revoke therefore bites within 60 s of a cached OK. One lookup per uid is in flight at a time, shared by concurrent callers.
 * Nothing here imports `src/auth`.
 */

export type RevocationVerdict = "ok" | "revoked" | "unavailable" | "not_configured";

/** Optional Nest provider (test seam); absent in production. */
export const SESSION_REVOCATION_OPTIONS = Symbol("SESSION_REVOCATION_OPTIONS");
export interface SessionRevocationOptions {
  now?: () => number;
  deadlineMs?: number;
}

const DEADLINE_MS = 3_000;
const TTL_MS = 60_000;
const MAX_ENTRIES = 10_000;

type Entry = { expiresAt: number; refused: true } | { expiresAt: number; refused: false; validSince: number | undefined };

@Injectable()
export class SessionRevocation {
  private readonly logger = new Logger("SessionRevocation");
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly projectId: string | undefined;
  /** Insertion-ordered: the first key is the oldest. */
  private readonly cache = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<SessionStateResult>>();

  constructor(
    @Inject(FIREBASE_ACCOUNTS) private readonly accounts: FirebaseAccounts,
    @Inject(APP_CONFIG) config: Pick<AppConfig, "firebaseAdmin">,
    @Optional() @Inject(SESSION_REVOCATION_OPTIONS) options?: SessionRevocationOptions,
  ) {
    this.now = options?.now ?? Date.now;
    this.deadlineMs = options?.deadlineMs ?? DEADLINE_MS;
    this.projectId = config.firebaseAdmin?.projectId;
    if (config.firebaseAdmin === undefined) {
      this.logger.error("Session cookies are refused with 503: no Firebase Admin credential (set FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE)");
    }
  }

  /** `authTime` is the cookie's `auth_time` claim in seconds. */
  async check(uid: string, authTime: number): Promise<RevocationVerdict> {
    if (this.projectId === undefined) return "not_configured";
    const key = `${this.projectId}:${uid}`;
    const cached = this.read(key);
    if (cached) return this.verdict(cached, authTime);

    let pending = this.inFlight.get(key);
    if (pending === undefined) {
      pending = this.fetchAndCache(key, uid).finally(() => {
        this.inFlight.delete(key);
      });
      this.inFlight.set(key, pending);
    }
    const result = await pending;
    switch (result.kind) {
      case "found":
        return result.disabled ? "revoked" : this.verdict({ expiresAt: 0, refused: false, validSince: result.validSince }, authTime);
      case "not_found":
        return "revoked";
      case "not_configured":
        return "not_configured";
      default:
        return "unavailable";
    }
  }

  private verdict(entry: Entry, authTime: number): "ok" | "revoked" {
    if (entry.refused) return "revoked";
    return entry.validSince !== undefined && authTime < entry.validSince ? "revoked" : "ok";
  }

  private read(key: string): Entry | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Never rejects: any failure is `unavailable` and uncached. */
  private async fetchAndCache(key: string, uid: string): Promise<SessionStateResult> {
    let result: SessionStateResult;
    try {
      result = await this.accounts.lookupSessionState(uid, AbortSignal.timeout(this.deadlineMs));
    } catch {
      return { kind: "unavailable" };
    }
    const expiresAt = this.now() + TTL_MS;
    if (result.kind === "found") {
      this.store(key, result.disabled ? { expiresAt, refused: true } : { expiresAt, refused: false, validSince: result.validSince });
    } else if (result.kind === "not_found") {
      this.store(key, { expiresAt, refused: true });
    }
    return result;
  }

  private store(key: string, entry: Entry): void {
    this.cache.delete(key); // re-insert so the map order is insertion time
    this.cache.set(key, entry);
    while (this.cache.size > MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}
