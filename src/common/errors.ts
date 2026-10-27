/** Stable error codes. The Unity client switches on these; never repurpose one. */
export type ErrorCode =
  | "unauthorized"
  | "auth_unavailable"
  | "invalid_request"
  | "player_not_found"
  | "round_not_found"
  | "round_expired"
  | "round_closed"
  | "round_too_fast"
  | "rank_not_certified"
  | "not_found"
  | "internal_error";

/** The one error type the API throws on purpose. The global filter turns it into the response body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    /** Extra response headers, e.g. Retry-After. */
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}
