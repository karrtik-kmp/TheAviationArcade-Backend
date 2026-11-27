import { Logger } from "@nestjs/common";
import { importPKCS8, SignJWT } from "jose";
import type { FirebaseAdminConfig } from "../config/config.module.js";

/**
 * Firebase Authentication admin calls (ADR-0002 follow-up, user ruling 2026-11-19): granting `admin` marks the account's email
 * verified, because staff needs `email_verified` in the token and editors are email/password accounts the Admin never verifies.
 *
 * Plain `fetch` to the Identity Toolkit v1 REST API, no Google SDK (same pattern as the Google Play adapter):
 *  - `POST /v1/projects/{project}/accounts:lookup` `{ localId: [uid] }` answers `users[]` (absent when there is no such account);
 *  - `POST /v1/projects/{project}/accounts:update` `{ localId, emailVerified: true }` answers the account; a missing one is
 *    400 `USER_NOT_FOUND`.
 * A real project uses an OAuth access token minted from a service-account key (JWT bearer grant, scope cloud-platform; the
 * account needs the Firebase Authentication Admin role). A demo- project uses the Auth Emulator at
 * `http://<host>/identitytoolkit.googleapis.com/...` with `Authorization: Bearer owner`.
 *
 * Sources checked 2026-11-19: docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/update and
 * .../lookup (fields, scopes identitytoolkit or cloud-platform, permissions firebaseauth.users.update / .get, held by the role
 * roles/firebaseauth.admin); the error body shape from firebase.google.com/docs/reference/rest/auth; the emulator's routing,
 * `Bearer owner` and its answers (no `users` when nothing matches, `USER_NOT_FOUND` on update) from firebase-tools
 * src/emulator/auth/{server,operations}.ts. The real API's answer fields are not listed in its reference, so an update answer
 * without `emailVerified: true` is confirmed by a second lookup, and an account without an email is never updated.
 *
 * Only ever by uid of the configured project, never by email. Never throws to the caller. Logs carry the call, HTTP status and
 * Google's error code only: never a uid, email, token, key or body.
 */

/** What the grant reports and audits: set by this grant, already verified, or not possible (the account has no email). */
export type EmailVerification = "verified" | "already_verified" | "no_email";

export type EnsureVerifiedResult =
  | { kind: "ok"; emailVerification: EmailVerification }
  /** No Firebase account with that uid in the project. */
  | { kind: "not_found" }
  /** The Firebase account is disabled: nothing is changed. */
  | { kind: "disabled" }
  /** The granting admin typed an email that is not the account's Firebase email: nothing is changed. */
  | { kind: "email_mismatch" }
  /** Firebase refused, timed out or could not be reached; nothing is known to be changed. */
  | { kind: "unavailable" }
  /** No admin access configured (config `firebaseAdmin` undefined). */
  | { kind: "not_configured" };

export interface FirebaseAccounts {
  /**
   * Mark the account of `uid` verified. `expectedEmail` is the email the granting admin typed (already normalised), or null: when
   * given, the account's email must be exactly that address (compared lowercased), so an admin never vouches for an address they
   * did not name.
   */
  ensureEmailVerified(uid: string, expectedEmail: string | null): Promise<EnsureVerifiedResult>;
  /**
   * Session-cookie revocation state (docs/plans/session-cookies.md C5): the account's `disabled` flag and `validSince` (seconds;
   * undefined = never revoked). One try, no retry; `signal` bounds the OAuth token mint and the lookup together. The not-configured
   * stub answers `not_configured`; the real client never does.
   */
  lookupSessionState(uid: string, signal: AbortSignal): Promise<SessionStateResult>;
}

export type SessionStateResult =
  | { kind: "found"; disabled: boolean; validSince: number | undefined }
  | { kind: "not_found" }
  | { kind: "unavailable" }
  | { kind: "not_configured" };

/** At most one failure log per key, then a suppressed count every 30 s. */
const LOG_THROTTLE_MS = 30_000;

/** Nest token of the FirebaseAccounts provider (AccountsModule). */
export const FIREBASE_ACCOUNTS = Symbol("FIREBASE_ACCOUNTS");

const API_HOST = "https://identitytoolkit.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const CALL_TIMEOUT_MS = 5_000;
const EXPIRY_MARGIN_MS = 60_000;
const IAT_SKEW_S = 30;
const JWT_LIFETIME_S = 3600;

type Json = Record<string, unknown>;
/** `body` is undefined when a 200 answer was not a JSON object. */
type Call = { kind: "ok"; body: Json | undefined } | { kind: "http"; status: number; code: string } | { kind: "failed" };
type Account = { email: string | undefined; emailVerified: boolean; disabled: boolean };

/** The configured client, or one that always answers `not_configured`. */
export function firebaseAccountsFor(config: FirebaseAdminConfig | undefined, options?: { fetch?: typeof fetch; now?: () => number }): FirebaseAccounts {
  return config === undefined
    ? { ensureEmailVerified: async () => ({ kind: "not_configured" }), lookupSessionState: async () => ({ kind: "not_configured" }) }
    : new IdentityToolkitAccounts(config, options);
}

/** Resolves to `undefined` as soon as `signal` aborts; otherwise to the promise's value. Never rejects (the promise must not). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(undefined);
      },
    );
  });
}

export class IdentityToolkitAccounts implements FirebaseAccounts {
  private readonly logger = new Logger("FirebaseAccounts");
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly base: string;
  private cached: { value: string; expiresAt: number } | undefined;
  private keyPromise: Promise<CryptoKey> | undefined;
  /** The one token mint in flight, shared by all callers. Never rejects. */
  private minting: Promise<string | undefined> | undefined;
  private readonly logState = new Map<string, { lastAt: number; suppressed: number }>();

  constructor(
    private readonly config: FirebaseAdminConfig,
    options?: { fetch?: typeof fetch; now?: () => number },
  ) {
    this.fetchFn = options?.fetch ?? ((input, init) => fetch(input, init));
    this.now = options?.now ?? Date.now;
    const host = config.kind === "emulator" ? `http://${config.host}/identitytoolkit.googleapis.com` : API_HOST;
    this.base = `${host}/v1/projects/${encodeURIComponent(config.projectId)}`;
  }

  async ensureEmailVerified(uid: string, expectedEmail: string | null): Promise<EnsureVerifiedResult> {
    try {
      const before = await this.lookup(uid);
      if (before.kind !== "found") return before;
      const { account } = before;
      if (account.disabled) return { kind: "disabled" };
      if (expectedEmail !== null && account.email?.toLowerCase() !== expectedEmail.toLowerCase()) return { kind: "email_mismatch" };
      if (account.email === undefined) return { kind: "ok", emailVerification: "no_email" };
      if (account.emailVerified) return { kind: "ok", emailVerification: "already_verified" };

      // The checked address is sent with the flag, so an email changed between the lookup and this call is never the one verified.
      const update = await this.call("accounts:update", { localId: uid, email: account.email, emailVerified: true });
      if (update.kind === "http" && update.code === "USER_NOT_FOUND") return { kind: "not_found" };
      if (update.kind !== "ok") return this.unavailable("accounts:update", update);
      if (update.body?.emailVerified === true) return { kind: "ok", emailVerification: "verified" };
      // The answer did not carry the flag: read the account back, so the grant never reports a verification that did not happen.
      const after = await this.lookup(uid);
      if (after.kind !== "found") return after.kind === "not_found" ? after : { kind: "unavailable" };
      if (after.account.emailVerified) return { kind: "ok", emailVerification: "verified" };
      this.logger.error("accounts:update answered 200 but the account is still unverified (outcome=unavailable)");
      return { kind: "unavailable" };
    } catch {
      this.logger.error("Firebase account update failed unexpectedly (outcome=unavailable)");
      return { kind: "unavailable" };
    }
  }

  private async lookup(uid: string): Promise<{ kind: "found"; account: Account } | { kind: "not_found" } | { kind: "unavailable" }> {
    const call = await this.call("accounts:lookup", { localId: [uid] });
    if (call.kind !== "ok") return this.unavailable("accounts:lookup", call);
    const rawUsers = call.body?.users;
    const users: unknown[] = Array.isArray(rawUsers) ? rawUsers : [];
    const user = users.find((u): u is Json => typeof u === "object" && u !== null && (u as Json).localId === uid);
    if (!user) return { kind: "not_found" };
    return {
      kind: "found",
      account: {
        email: typeof user.email === "string" && user.email.length > 0 ? user.email : undefined,
        emailVerified: user.emailVerified === true,
        disabled: user.disabled === true,
      },
    };
  }

  private unavailable(event: string, call: Exclude<Call, { kind: "ok" }>): { kind: "unavailable" } {
    if (call.kind === "http") {
      const hint = call.status === 401 || call.status === 403 ? " (check FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE and its Firebase Authentication Admin role)" : "";
      this.logger.error(`${event} outcome=unavailable status=${call.status} code=${call.code}${hint}`);
    } else {
      this.logger.error(`${event} outcome=unavailable network_or_token_failure`);
    }
    return { kind: "unavailable" };
  }

  /**
   * One authorised POST, tried at most twice: again after a network failure, a 5xx or a 401 (which drops the cached token). Both
   * calls are idempotent (a lookup, and setting the flag to true). Never throws.
   */
  private async call(method: "accounts:lookup" | "accounts:update", body: Json): Promise<Call> {
    const first = await this.callOnce(method, body);
    const retry = first.kind === "failed" || (first.kind === "http" && (first.status === 401 || first.status >= 500));
    return retry ? this.callOnce(method, body) : first;
  }

  /** `signal` (the request path's deadline) bounds both the token mint wait and the POST; without it each has its own 5 s timeout. */
  private async callOnce(method: "accounts:lookup" | "accounts:update", body: Json, signal?: AbortSignal): Promise<Call> {
    const token = await this.accessToken(signal);
    if (token === undefined) return { kind: "failed" };
    try {
      const response = await this.fetchFn(`${this.base}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (response.status === 401) this.cached = undefined;
      const parsed = await readJson(response);
      if (response.ok) return { kind: "ok", body: parsed };
      return { kind: "http", status: response.status, code: errorCode(parsed) };
    } catch {
      return { kind: "failed" };
    }
  }

  async lookupSessionState(uid: string, signal: AbortSignal): Promise<SessionStateResult> {
    try {
      const call = await this.callOnce("accounts:lookup", { localId: [uid] }, signal);
      if (call.kind === "failed") return this.sessionUnavailable("network_token_or_deadline");
      if (call.kind === "http") return this.sessionUnavailable(`status=${call.status} code=${call.code}`);
      const body = call.body;
      if (body === undefined) return this.sessionUnavailable("malformed_body");
      const rawUsers = body.users;
      if (rawUsers !== undefined && !Array.isArray(rawUsers)) return this.sessionUnavailable("malformed_users");
      const users: unknown[] = rawUsers ?? [];
      const user = users.find((u): u is Json => typeof u === "object" && u !== null && (u as Json).localId === uid);
      if (!user) return { kind: "not_found" };
      const disabled = user.disabled === undefined ? false : typeof user.disabled === "boolean" ? user.disabled : undefined;
      if (disabled === undefined) return this.sessionUnavailable("malformed_disabled");
      let validSince: number | undefined;
      if (user.validSince !== undefined) {
        if (typeof user.validSince !== "string" || !/^[0-9]{1,15}$/.test(user.validSince)) return this.sessionUnavailable("malformed_valid_since");
        validSince = Number(user.validSince);
      }
      return { kind: "found", disabled, validSince };
    } catch {
      return this.sessionUnavailable("unexpected");
    }
  }

  private sessionUnavailable(detail: string): { kind: "unavailable" } {
    this.logThrottled("session_lookup", `accounts:lookup (session state) outcome=unavailable ${detail}`);
    return { kind: "unavailable" };
  }

  /** The first failure of a kind logs at once; later ones are counted and reported at most every 30 s. */
  private logThrottled(key: string, message: string): void {
    const now = this.now();
    const state = this.logState.get(key);
    if (state === undefined) {
      this.logState.set(key, { lastAt: now, suppressed: 0 });
      this.logger.error(message);
    } else if (now - state.lastAt >= LOG_THROTTLE_MS) {
      const count = state.suppressed;
      state.lastAt = now;
      state.suppressed = 0;
      this.logger.error(count > 0 ? `${message} (+${count} similar suppressed)` : message);
    } else {
      state.suppressed += 1;
    }
  }

  /** `owner` for the emulator; otherwise a cached OAuth access token shared by all callers. Undefined when it cannot be minted (logged) or `signal` aborts first. */
  private async accessToken(signal?: AbortSignal): Promise<string | undefined> {
    if (this.config.kind === "emulator") return "owner";
    const cached = this.cached;
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > this.now()) return cached.value;
    // One mint in flight for everyone: a caller whose signal aborts stops waiting but never cancels it for the others.
    this.minting ??= this.mint().finally(() => {
      this.minting = undefined;
    });
    return signal === undefined ? this.minting : raceAbort(this.minting, signal);
  }

  /** Mints a token (its own 5 s timeout) and caches it. Never rejects. */
  private async mint(): Promise<string | undefined> {
    if (this.config.kind === "emulator") return "owner";
    const config = this.config;
    try {
      this.keyPromise ??= importPKCS8(config.privateKeyPem, "RS256");
      let key: CryptoKey;
      try {
        key = await this.keyPromise;
      } catch (error) {
        this.keyPromise = undefined;
        throw error;
      }
      const iat = Math.floor(this.now() / 1000) - IAT_SKEW_S;
      const assertion = await new SignJWT({ scope: SCOPE })
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: config.privateKeyId })
        .setIssuer(config.clientEmail)
        .setAudience(TOKEN_URL)
        .setIssuedAt(iat)
        .setExpirationTime(iat + JWT_LIFETIME_S)
        .sign(key);
      const response = await this.fetchFn(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const parsed = await readJson(response);
      const value = typeof parsed?.access_token === "string" && parsed.access_token.length > 0 ? parsed.access_token : undefined;
      const expiresIn = typeof parsed?.expires_in === "number" ? parsed.expires_in : 0;
      if (!response.ok || value === undefined || expiresIn <= 0) {
        this.logThrottled("mint", `firebase-admin token exchange failed status=${response.status} (check FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE)`);
        return undefined;
      }
      this.cached = { value, expiresAt: this.now() + expiresIn * 1000 };
      return value;
    } catch {
      this.logThrottled("mint", "firebase-admin token exchange failed (key import, signing or network); check FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE");
      return undefined;
    }
  }
}

/**
 * Identity Toolkit errors are `{ error: { code, message, status } }` where `message` is a code such as `USER_NOT_FOUND`, sometimes
 * followed by ` : <detail>`. Only the leading code reaches logs, and only when it looks like one.
 */
function errorCode(body: Json | undefined): string {
  const error = body?.error;
  const message = typeof error === "object" && error !== null ? (error as Json).message : undefined;
  const code = typeof message === "string" ? (message.split(" ")[0] ?? "") : "";
  return /^[A-Z_]{1,64}$/.test(code) ? code : "none";
}

async function readJson(response: Response): Promise<Json | undefined> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}
