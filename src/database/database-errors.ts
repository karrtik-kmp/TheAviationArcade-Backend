/**
 * Database trouble that is our infrastructure's fault, not the request's: the client should retry
 * shortly, so it maps to 503 service_unavailable instead of a 500.
 */

const UNAVAILABLE_SQLSTATES = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "57014", // query_canceled (statement_timeout)
  "55P03", // lock_not_available (lock_timeout)
  "53300", // too_many_connections
]);

const UNAVAILABLE_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);

// pg raises these without a code: pool connect timeout, dropped connection, client-side query_timeout.
const UNAVAILABLE_MESSAGES = [
  "timeout exceeded when trying to connect",
  "Connection terminated",
  "Query read timeout",
];

/** The innermost error. Drizzle wraps driver errors, and its own message embeds the SQL parameters. */
export function rootCause(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error && current.cause !== undefined; depth++) {
    current = current.cause;
  }
  return current;
}

/** True for pool timeouts, lost connections, SQLSTATE class 08, shutdowns and the timeouts above. */
export function isDatabaseUnavailable(error: unknown): boolean {
  const root = rootCause(error);
  if (!(root instanceof Error)) return false;
  const code = (root as { code?: unknown }).code;
  if (typeof code === "string") {
    if (UNAVAILABLE_SQLSTATES.has(code) || UNAVAILABLE_NETWORK_CODES.has(code) || code.startsWith("08")) {
      return true;
    }
  }
  // Node reports a refused connect to a name with several addresses as an AggregateError.
  if (root instanceof AggregateError) {
    return root.errors.some((inner: unknown) => isDatabaseUnavailable(inner));
  }
  return UNAVAILABLE_MESSAGES.some((message) => root.message.includes(message));
}
