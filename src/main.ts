import "reflect-metadata";
import { ConsoleLogger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";
import { loadConfig } from "./config/config.module.js";
import { installShutdown } from "./platform/shutdown.js";
import { applyServerTimeouts } from "./platform/server-timeouts.js";

// Local convenience: Node 22+ reads .env itself. Never in production, where the real environment is
// the only source of configuration (a stray .env must not be able to change it).
if (process.env.APP_ENV !== "production") {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file.
  }
}

async function bootstrap(): Promise<void> {
  // Fail fast on bad configuration before opening any connection.
  const config = loadConfig(process.env);
  // Structured JSON logs without colour codes, matching the per-request log lines.
  const logger = new ConsoleLogger({ json: true, colors: false });
  // bodyParser: false, because configureApp registers the only body parser (JSON, 16 KB).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger });
  configureApp(app, { trustProxy: config.trustProxy });
  applyServerTimeouts(app.getHttpServer());
  // SIGTERM/SIGINT drain in-flight requests (bounded by SHUTDOWN_DRAIN_MS), which also closes the pg pool
  // (DatabaseModule.onApplicationShutdown).
  installShutdown(app, logger, { prestopMs: config.shutdownPrestopMs, drainMs: config.shutdownDrainMs });
  if (config.emulatorTokens) {
    logger.warn(
      "ALLOW_EMULATOR_TOKENS is enabled: unsigned Firebase Auth Emulator tokens are accepted. Local development only.",
      "Bootstrap",
    );
  }
  if (config.appEnv === "production" && config.trustProxy === false) {
    logger.warn(
      "TRUST_PROXY is off in production: req.ip is the proxy address, so all public-route clients share one rate limit bucket and logs show the proxy IP. Set TRUST_PROXY to the number of proxy hops if behind a load balancer.",
      "Bootstrap",
    );
  }
  await app.listen(config.port, config.host);
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
