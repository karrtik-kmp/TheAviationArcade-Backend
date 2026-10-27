import type { NextFunction, Request, Response } from "express";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { requestContext } from "./common/request-context.js";
import { DrainState } from "./platform/drain-state.js";

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
  // JSON only (no urlencoded). Round results are a few hundred bytes; 16 KB is generous.
  app.useBodyParser("json", { limit: "16kb" });
  app.use(noStore);
}
