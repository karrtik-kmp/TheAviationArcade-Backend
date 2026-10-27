import type { LoggerService } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DrainState } from "./drain-state.js";

/** How often idle keep-alive sockets are swept while the server closes. */
const IDLE_SWEEP_MS = 250;

type ShutdownTiming = { prestopMs: number; drainMs: number };

/**
 * The graceful part of shutdown, separate from process signals so it can be tested.
 * 1. Mark draining: /ready answers 503 and responses carry `Connection: close`.
 * 2. Wait `prestopMs` with the listener still open, so a load balancer sees the 503 and stops routing.
 * 3. app.close(): stop accepting, let in-flight requests finish, then close the pg pool. Node's server
 *    close only drops sockets that are idle at that moment; a connection that was mid-request becomes
 *    idle afterwards and would linger for keepAliveTimeout (65 s), so idle sockets are swept repeatedly.
 * The whole thing, prestop included, must finish within `drainMs`. Resolves true when it did.
 */
export async function drain(app: NestExpressApplication, options: ShutdownTiming): Promise<boolean> {
  const started = Date.now();
  app.get(DrainState).draining = true;
  if (options.prestopMs > 0) await new Promise((resolve) => setTimeout(resolve, options.prestopMs));

  const server = app.getHttpServer();
  const closed = app.close().then(() => true);
  server.closeIdleConnections();
  const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
  let deadline: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    deadline = setTimeout(() => resolve(false), Math.max(0, options.drainMs - (Date.now() - started)));
  });
  try {
    return await Promise.race([closed, timedOut]);
  } finally {
    clearInterval(sweep);
    clearTimeout(deadline);
  }
}

/**
 * SIGTERM/SIGINT run `drain`. On success the exit code is set and the event loop is left to empty (an
 * immediate process.exit can lose output still buffered on a pipe); an unref'd timer exits anyway if
 * something keeps the loop alive. Past the deadline the exit code is 1. A second signal exits at once.
 * Used instead of enableShutdownHooks, which has no deadline and no pre-stop.
 */
export function installShutdown(app: NestExpressApplication, logger: LoggerService, options: ShutdownTiming): void {
  let closing = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (closing) {
      logger.warn(`${signal} again: exiting now.`, "Shutdown");
      process.exit(1);
    }
    closing = true;
    logger.log(
      `${signal} received: /ready is 503 for ${options.prestopMs} ms, then draining; budget ${options.drainMs} ms.`,
      "Shutdown",
    );
    const finish = (code: number): void => {
      process.exitCode = code;
      setTimeout(() => process.exit(code), 2000).unref();
    };
    drain(app, options).then(
      (clean) => {
        if (!clean) logger.error("Drain deadline exceeded: exiting with requests still in flight.", undefined, "Shutdown");
        finish(clean ? 0 : 1);
      },
      (error: unknown) => {
        logger.error(error instanceof Error ? error.message : String(error), undefined, "Shutdown");
        finish(1);
      },
    );
  };
  process.on("SIGTERM", handle);
  process.on("SIGINT", handle);
}
