// Bunny CDN advanced token authentication, per-file (no token_path), no IP binding.
// Algorithm per https://bunny.net/docs/cdn/security/token-authentication/advanced.md (checked 2026-11-03):
//   token = "HS256-" + flags + Base64URL(HMAC-SHA256(security_key, signature_path + expires + user_ip + signing_data))
// flags and user_ip are empty here (no IP binding); signature_path is the URL path; expires is UNIX seconds;
// signing_data is the other query params sorted and joined as key=value with "&" (excluding token and expires).
// Base64URL: "+" -> "-", "/" -> "_", no "=" padding. Pure: the caller passes `now`; the clock is never read.
import { createHmac, timingSafeEqual } from "node:crypto";

export const CDN_PATH_PREFIX = "/backend/content/photos/";

export interface SignCdnUrlInput {
  host: string;
  path: string;
  key: string;
  expiresAt: Date;
  now: Date;
}

export interface SignedCdnUrl {
  url: string;
  expiresAt: Date;
}

const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// Exact allow-list: the only keys the media pipeline writes (64 lowercase hex SHA-256 + .jpg or .png).
const CDN_PATH = /^\/backend\/content\/photos\/[0-9a-f]{64}\.(?:jpg|png)$/;

function assertPath(path: string): void {
  if (typeof path !== "string" || !CDN_PATH.test(path)) {
    throw new TypeError(`CDN path must match ${CDN_PATH_PREFIX}<64 lowercase hex>.jpg or .png`);
  }
}

function assertHost(host: string): void {
  if (typeof host !== "string" || !HOST.test(host)) throw new TypeError("CDN host must be a plain hostname");
}

/** Low-level token: no path or key guard. Exported only so tests can pin Bunny's official vector; use `signCdnUrl`. */
export function computeCdnToken(key: string, path: string, expires: number): string {
  const signingData = ""; // no extra signed parameters
  return "HS256-" + createHmac("sha256", key).update(path + String(expires) + signingData).digest("base64url");
}

export function signCdnUrl(input: SignCdnUrlInput): SignedCdnUrl {
  const { host, path, key, expiresAt, now } = input;
  assertHost(host);
  assertPath(path);
  if (typeof key !== "string" || key.length === 0) throw new TypeError("CDN signing key must not be empty");
  if (!(expiresAt instanceof Date) || !(now instanceof Date) || Number.isNaN(expiresAt.getTime()) || Number.isNaN(now.getTime())) {
    throw new TypeError("expiresAt and now must be valid dates");
  }
  const expires = Math.floor(expiresAt.getTime() / 1000);
  if (expires <= Math.floor(now.getTime() / 1000)) throw new TypeError("expiresAt must be in the future");
  const token = computeCdnToken(key, path, expires);
  return { url: `https://${host}${path}?token=${token}&expires=${expires}`, expiresAt: new Date(expires * 1000) };
}

/** Test/preview helper: true when `url` carries a valid token for `key` and has not expired at `now`. Never throws. */
export function verifyCdnToken(url: string, key: string, now: Date): boolean {
  try {
    if (key.length === 0) return false;
    const u = new URL(url);
    if (u.protocol !== "https:" || [...u.searchParams.keys()].some((k) => k !== "token" && k !== "expires")) return false;
    const token = u.searchParams.get("token");
    const expiresText = u.searchParams.get("expires");
    if (token === null || expiresText === null || !/^\d{1,12}$/.test(expiresText)) return false;
    const expires = Number(expiresText);
    if (expires <= Math.floor(now.getTime() / 1000)) return false;
    assertPath(u.pathname);
    const want = Buffer.from(computeCdnToken(key, u.pathname, expires));
    const got = Buffer.from(token);
    return want.length === got.length && timingSafeEqual(want, got);
  } catch {
    return false;
  }
}
