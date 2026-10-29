import { randomUUID } from "node:crypto";
import { Catch, HttpException, Logger } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiError } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import { isDatabaseUnavailable, rootCause } from "../database/database-errors.js";

type Shaped = {
  status: number;
  code: ErrorCode;
  message: string;
  headers: Readonly<Record<string, string>>;
  extra?: Readonly<Record<string, unknown>>;
};

const UNREADABLE = "Request could not be read.";

/**
 * Express body-parser (http-errors) failures: a 4xx `status`, `expose: true` and a string `type`, e.g.
 * entity.too.large, charset.unsupported, encoding.unsupported, request.aborted.
 */
function isHttpError(error: unknown): error is { status: number } {
  if (typeof error !== "object" || error === null) return false;
  const { status, expose, type } = error as { status?: unknown; expose?: unknown; type?: unknown };
  return typeof status === "number" && status >= 400 && status < 500 && expose === true && typeof type === "string";
}

function shape(error: unknown): Shaped | null {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, message: error.message, headers: error.headers, extra: error.extra };
  }
  if (error instanceof HttpException && error.getStatus() === 404) {
    return { status: 404, code: "not_found", message: "No such endpoint.", headers: {} };
  }
  // Too large / unsupported charset or encoding keep their real status; everything else unreadable is 400.
  if (isHttpError(error)) {
    const status = error.status === 413 || error.status === 415 ? error.status : 400;
    return { status, code: "invalid_request", message: UNREADABLE, headers: {} };
  }
  // Nest maps the body parser's SyntaxError (malformed JSON) and URIError to a BadRequestException;
  // nothing else in this app throws an HttpException for a client error.
  if (error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500) {
    return { status: 400, code: "invalid_request", message: UNREADABLE, headers: {} };
  }
  if (error instanceof SyntaxError || error instanceof URIError) {
    return { status: 400, code: "invalid_request", message: UNREADABLE, headers: {} };
  }
  return null;
}

/** The one place errors become responses: { error: { code, message, requestId } } with a real status. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Unhandled");

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const requestId = req.requestId ?? randomUUID();

    let shaped = shape(error);
    if (!shaped) {
      // Log server-side only. Drizzle's own message embeds the SQL parameters, so log the driver
      // error underneath it, never the request.
      const root = rootCause(error);
      if (isDatabaseUnavailable(error)) {
        // Expected under load or a DB restart: a warning with the driver's code and message, no stack.
        const code = (root as { code?: unknown }).code;
        const detail = root instanceof Error ? root.message : String(root);
        this.logger.warn(`rid=${requestId} database unavailable${typeof code === "string" ? ` code=${code}` : ""}: ${detail}`);
        shaped = {
          status: 503,
          code: "service_unavailable",
          message: "Service temporarily unavailable. Retry shortly.",
          headers: { "Retry-After": "5" },
        };
      } else {
        this.logger.error(`rid=${requestId} ${root instanceof Error ? (root.stack ?? root.message) : String(root)}`);
        shaped = { status: 500, code: "internal_error", message: "Something went wrong.", headers: {} };
      }
    }

    for (const [name, value] of Object.entries(shaped.headers)) res.setHeader(name, value);
    if (!res.hasHeader("X-Request-Id")) res.setHeader("X-Request-Id", requestId);
    res.status(shaped.status).json({ ...shaped.extra, error: { code: shaped.code, message: shaped.message, requestId } });
  }
}
