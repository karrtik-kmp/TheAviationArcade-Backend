import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
    /** Set by FirebaseAuthGuard from a verified token only. */
    principal?: string;
  }
}

const WELL_FORMED_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Assigns the request id (a well-formed incoming X-Request-Id is honoured, anything else is replaced),
 * echoes it, and writes ONE JSON line per request to stdout. Never logs bodies, tokens or emails.
 *
 * Registered with app.use() before Nest initialises, so it also covers requests that fail in the body
 * parser (malformed JSON) and requests for unknown routes.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("x-request-id");
  const rid = incoming && WELL_FORMED_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.requestId = rid;
  res.setHeader("X-Request-Id", rid);
  const started = process.hrtime.bigint();
  // "close" fires exactly once per response, including when the client hangs up first, so aborted
  // requests are logged too (writableFinished is false when the response never completed).
  res.on("close", () => {
    const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100;
    // Route pattern, not the raw URL, so ids in paths are not logged.
    const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : "(unmatched)";
    const line = { rid, ip: req.ip, method: req.method, route, status: res.statusCode, ms, aborted: !res.writableFinished };
    process.stdout.write(`${JSON.stringify(line)}
`);
  });
  next();
}
