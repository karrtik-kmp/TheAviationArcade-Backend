/** Stable error codes. The Unity client switches on these; never repurpose one. */
export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "auth_unavailable",
  "invalid_request",
  "player_not_found",
  "round_not_found",
  "round_expired",
  "round_closed",
  "round_too_fast",
  "trip_not_found",
  "trip_expired",
  "trip_closed",
  "trip_full",
  "trip_incomplete",
  "local_date_mismatch",
  "idempotency_key_reused",
  "rank_not_certified",
  "insufficient_hints",
  "insufficient_miles",
  "not_found",
  "rate_limited",
  "client_update_required",
  "import_invalid",
  "plan_changed",
  "import_in_progress",
  "ugs_link_conflict",
  "storage_unavailable",
  "service_unavailable",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The one error type the API throws on purpose. The global filter turns it into the response body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    /** Extra response headers, e.g. Retry-After. */
    readonly headers: Readonly<Record<string, string>> = {},
    /** Extra top-level body fields next to `error` (e.g. an import's row report). Never secrets. */
    readonly extra: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}
