import type http from "node:http";

/**
 * Node's defaults (keep-alive 5 s) are shorter than a typical load balancer's idle timeout (AWS ALB and
 * most proxies: 60 s), so the proxy can reuse a connection Node has just closed and the client sees a
 * spurious 502. Keep-alive must therefore outlast the proxy idle timeout, and headersTimeout must exceed
 * keepAliveTimeout (Node can otherwise drop a keep-alive connection while it waits for the next request).
 * requestTimeout may not be below headersTimeout; 70 s is still a hard bound on a slow request (bodies
 * here are at most 16 KB).
 */
export const SERVER_TIMEOUTS = {
  keepAliveTimeout: 65_000,
  headersTimeout: 66_000,
  requestTimeout: 70_000,
} as const;

export function applyServerTimeouts(server: http.Server): void {
  server.keepAliveTimeout = SERVER_TIMEOUTS.keepAliveTimeout;
  server.headersTimeout = SERVER_TIMEOUTS.headersTimeout;
  server.requestTimeout = SERVER_TIMEOUTS.requestTimeout;
}
