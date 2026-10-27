import type { NextFunction, Request, Response } from "express";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { requestContext } from "./common/request-context.js";

/** API responses are per-player and must never be stored by a cache. Health is the one exception. */
function noStore(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith("/v1/") && req.path !== "/v1/health") res.setHeader("Cache-Control", "no-store");
  next();
}

/**
 * Wiring shared by the real server and the e2e tests. Create the app with `{ bodyParser: false }`:
 * the body parser is registered here, in order, so nothing else is ever parsed. Everything uses
 * app.use() before Nest initialises so it runs ahead of the router; module-level middleware would run
 * after the body parser and miss requests that fail to parse.
 */
export function configureApp(app: NestExpressApplication): void {
  // First, so even a rejected body is logged and carries a request id.
  app.use(requestContext);
  // Default headers, and no X-Powered-By. Before the body parser so a 413 carries them too.
  app.useSecurityHeaders();
  // JSON only (no urlencoded). Round results are a few hundred bytes; 16 KB is generous.
  app.useBodyParser("json", { limit: "16kb" });
  app.use(noStore);
}
