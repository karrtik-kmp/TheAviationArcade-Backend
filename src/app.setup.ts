import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AuthUnavailableError, verifyFirebaseToken } from "./auth/firebase.js";
import { isStaff } from "./auth/staff.js";
import { ApiError } from "./common/errors.js";
import { APP_CONFIG } from "./config/config.module.js";
import type { AppConfig } from "./config/config.module.js";
import { requestContext } from "./common/request-context.js";
import { MAX_UPLOAD_BYTES, XLSX_MIME } from "./content/xlsx.js";
import { DrainState } from "./platform/drain-state.js";

/** API responses are per-player and must never be stored by a cache. Health is the one exception. */
function noStore(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith("/v1/") && req.path !== "/v1/health") res.setHeader("Cache-Control", "no-store");
  next();
}

const readXlsx = express.raw({ type: XLSX_MIME, limit: MAX_UPLOAD_BYTES });
const UNAUTHORIZED = () => new ApiError(401, "unauthorized", "Sign in required.", { "WWW-Authenticate": "Bearer" });

/**
 * Raw xlsx bodies, for the staff import route only (POST /v1/admin/content/:module/imports). Everything
 * else keeps the 16 KB JSON-only rule. The 5 MB body is read only after this middleware has verified the
 * Firebase token and the staff rule (same helpers and the same 401/403/503 answers as the guards), so
 * neither an anonymous caller nor a signed-in non-staff caller can make the server buffer it. A request
 * without a well-formed Bearer header is passed on unread; the guards, which still run afterwards, answer it.
 */
function xlsxUpload(app: NestExpressApplication) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = /^bearer (\S+)$/i.exec(req.header("authorization") ?? "")?.[1];
    if (req.method !== "POST" || !token) return next();
    const config = app.get<AppConfig>(APP_CONFIG);
    verifyFirebaseToken(token, { projectId: config.firebaseProjectId, emulator: config.emulatorTokens }).then(
      (identity) => {
        if (!isStaff(identity.email, identity.emailVerified, config.staffEmails)) {
          return next(new ApiError(403, "forbidden", "Staff only."));
        }
        readXlsx(req, res, next);
      },
      (error: unknown) => {
        if (error instanceof AuthUnavailableError) {
          return next(new ApiError(503, "auth_unavailable", "Sign-in is temporarily unavailable. Retry shortly.", { "Retry-After": "5" }));
        }
        next(UNAUTHORIZED());
      },
    );
  };
}

/**
 * Wiring shared by the real server and the e2e tests. Create the app with `{ bodyParser: false }`:
 * the body parser is registered here, in order, so nothing else is ever parsed. Everything uses
 * app.use() before Nest initialises so it runs ahead of the router; module-level middleware would run
 * after the body parser and miss requests that fail to parse.
 *
 * `trustProxy` is Express's setting: false (default) uses the socket address as req.ip; a number trusts
 * that many proxy hops of X-Forwarded-For. req.ip feeds the request log and the public rate limit.
 */
export function configureApp(app: NestExpressApplication, options: { trustProxy?: false | number } = {}): void {
  app.set("trust proxy", options.trustProxy ?? false);
  // First, so even a rejected body is logged and carries a request id.
  app.use(requestContext);
  // While shutting down, never keep a connection alive: the proxy must open new ones elsewhere. Decided
  // when the response head is written, so a request already in flight when SIGTERM arrives is covered too.
  let drainState: DrainState | undefined;
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const writeHead = res.writeHead;
    res.writeHead = function (this: Response, ...args: Parameters<Response["writeHead"]>) {
      if (!drainState) drainState = app.get<DrainState>(DrainState);
      if (drainState.draining && !this.headersSent) this.setHeader("Connection", "close");
      return writeHead.apply(this, args);
    } as Response["writeHead"];
    next();
  });
  // Default headers, and no X-Powered-By. Before the body parser so a 413 carries them too.
  app.useSecurityHeaders();
  app.use("/v1/admin/content/:module/imports", xlsxUpload(app));
  // JSON only (no urlencoded). Round results are a few hundred bytes; 16 KB is generous.
  app.useBodyParser("json", { limit: "16kb" });
  app.use(noStore);
}
