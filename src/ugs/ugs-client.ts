/**
 * Unity Gaming Services admin HTTP client (service account, Basic auth). The fetcher is injected so tests stub
 * it and no test ever reaches the network. Never logs or returns request bodies, the secret or response bodies.
 *
 * Endpoints, verified 2026-10-28 from the UGS docs:
 * - Cloud Save, player data Protected class (player reads own, server writes only):
 *   POST   /cloud-save/v1/data/projects/{projectId}/environments/{environmentId}/players/{playerId}/protected/items
 *          body { key, value, writeLock? } -> { writeLock }; value JSON <= 5 MB; role Cloud Save Editor.
 *   DELETE .../players/{playerId}/protected/items/{key}
 * - Player Auth admin: GET /player-identity/v1/projects/{projectId}/users/{playerId} -> externalIds[].
 * Rate limits: Cloud Save admin 60 req/s and 1000 per 30 min per project and IP; Player Auth admin 10 req/s and
 * 500 per 30 min.
 */
export type UgsFetch = (url: string, init: RequestInit) => Promise<Response>;

export const UGS_API_BASE = "https://services.api.unity.com";
export const REQUEST_TIMEOUT_MS = 10_000;
export const PROGRESS_KEY = "progress";

export type UgsClientConfig = {
  projectId: string;
  environmentId: string;
  serviceAccountKeyId: string;
  serviceAccountSecret: string;
};

export type ExternalId = { externalId: string; providerId: string };

export type IdentityResult =
  | { kind: "ok"; externalIds: ExternalId[] }
  | { kind: "not_found" }
  /** UGS did not answer usefully (network, 5xx, 429, or our own credentials rejected). Retry later. */
  | { kind: "unavailable"; status: number | "network" };

export type WriteResult =
  | { kind: "ok" }
  | { kind: "rate_limited"; retryAfterMs: number }
  /** 5xx or network: back off and retry. */
  | { kind: "transient"; status: number | "network" }
  /** Our own service-account credentials were refused (401/403): operator problem, affects every row. */
  | { kind: "auth_failed"; status: number }
  /** Other 4xx: retrying soon will not help. */
  | { kind: "rejected"; status: number };

const DEFAULT_RETRY_AFTER_MS = 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** Retry-After as delta-seconds (integer or decimal, e.g. "1.5") or an HTTP date; else a minute. Clamped to 1 s .. 1 h. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number {
  if (header === null) return DEFAULT_RETRY_AFTER_MS;
  const text = header.trim();
  let ms: number;
  if (/^\d{1,10}(\.\d{1,6})?$/.test(text)) ms = Number(text) * 1000;
  else {
    const date = Date.parse(text);
    ms = Number.isNaN(date) ? DEFAULT_RETRY_AFTER_MS : date - now;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, ms));
}

/** Release the connection: we never read these bodies (they may echo input), so cancel instead of leaving them open. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already consumed or closed.
  }
}

export class UgsClient {
  constructor(
    private readonly config: UgsClientConfig,
    private readonly fetcher: UgsFetch,
  ) {}

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.config.serviceAccountKeyId}:${this.config.serviceAccountSecret}`).toString("base64")}`;
  }

  private playerItemsUrl(ugsPlayerId: string): string {
    const { projectId, environmentId } = this.config;
    return `${UGS_API_BASE}/cloud-save/v1/data/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(environmentId)}/players/${encodeURIComponent(ugsPlayerId)}/protected/items`;
  }

  private async send(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response | "network"> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      return await this.fetcher(url, {
        ...init,
        headers: { Authorization: this.authHeader(), Accept: "application/json", ...(init.headers ?? {}) },
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch {
      return "network";
    }
  }

  /** Player Auth admin: the external identities linked to a UGS player (used as the server-side link proof). */
  async getExternalIds(ugsPlayerId: string, signal?: AbortSignal): Promise<IdentityResult> {
    const url = `${UGS_API_BASE}/player-identity/v1/projects/${encodeURIComponent(this.config.projectId)}/users/${encodeURIComponent(ugsPlayerId)}`;
    const res = await this.send(url, { method: "GET" }, signal);
    if (res === "network") return { kind: "unavailable", status: "network" };
    if (res.status === 404) {
      await discard(res);
      return { kind: "not_found" };
    }
    if (!res.ok) {
      await discard(res);
      return { kind: "unavailable", status: res.status };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: "unavailable", status: res.status };
    }
    const raw = (body as { externalIds?: unknown } | null)?.externalIds;
    const externalIds: ExternalId[] = [];
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const { externalId, providerId } = (entry ?? {}) as { externalId?: unknown; providerId?: unknown };
        if (typeof externalId === "string" && typeof providerId === "string") externalIds.push({ externalId, providerId });
      }
    }
    return { kind: "ok", externalIds };
  }

  private async classify(res: Response | "network"): Promise<WriteResult> {
    if (res === "network") return { kind: "transient", status: "network" };
    await discard(res);
    if (res.ok) return { kind: "ok" };
    if (res.status === 429) return { kind: "rate_limited", retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) };
    if (res.status >= 500) return { kind: "transient", status: res.status };
    if (res.status === 401 || res.status === 403) return { kind: "auth_failed", status: res.status };
    return { kind: "rejected", status: res.status };
  }

  /** Cloud Save admin write of the Protected `progress` item. No writeLock: Postgres is the only writer. */
  async writeProgress(ugsPlayerId: string, value: unknown, signal?: AbortSignal): Promise<WriteResult> {
    const res = await this.send(
      this.playerItemsUrl(ugsPlayerId),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: PROGRESS_KEY, value }) },
      signal,
    );
    return this.classify(res);
  }

  /** Delete the Protected `progress` item. 404 (already gone) counts as done. */
  async deleteProgress(ugsPlayerId: string, signal?: AbortSignal): Promise<WriteResult> {
    const res = await this.send(`${this.playerItemsUrl(ugsPlayerId)}/${PROGRESS_KEY}`, { method: "DELETE" }, signal);
    if (res !== "network" && res.status === 404) {
      await discard(res);
      return { kind: "ok" };
    }
    return this.classify(res);
  }
}
