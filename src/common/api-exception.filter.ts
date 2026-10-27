import { randomUUID } from "node:crypto";
import { Catch, HttpException, Logger } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiError } from "./errors.js";
import type { ErrorCode } from "./errors.js";

type Shaped = { status: number; code: ErrorCode; message: string; headers: Readonly<Record<string, string>> };

function shape(error: unknown): Shaped | null {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, message: error.message, headers: error.headers };
  }
  if (error instanceof HttpException && error.getStatus() === 404) {
    return { status: 404, code: "not_found", message: "No such endpoint.", headers: {} };
  }
  // Nest wraps Express body-parser failures (malformed JSON, bad charset, oversized body) in an
  // HttpException; nothing else in this app throws one for a client error. Unreadable body = bad request.
  if (error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500) {
    return { status: 400, code: "invalid_request", message: "Request body could not be read.", headers: {} };
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
      const root = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      this.logger.error(`rid=${requestId} ${root instanceof Error ? (root.stack ?? root.message) : String(root)}`);
      shaped = { status: 500, code: "internal_error", message: "Something went wrong.", headers: {} };
    }

    for (const [name, value] of Object.entries(shaped.headers)) res.setHeader(name, value);
    if (!res.hasHeader("X-Request-Id")) res.setHeader("X-Request-Id", requestId);
    res.status(shaped.status).json({ error: { code: shaped.code, message: shaped.message, requestId } });
  }
}
