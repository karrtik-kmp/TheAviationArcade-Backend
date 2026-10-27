import "reflect-metadata";
import { ConsoleLogger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";
import { loadConfig } from "./config/config.module.js";

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
  configureApp(app);
  // SIGTERM/SIGINT close the app, which drains the pg pool (DatabaseModule.onApplicationShutdown).
  app.enableShutdownHooks();
  if (config.emulatorTokens) {
    logger.warn(
      "ALLOW_EMULATOR_TOKENS is enabled: unsigned Firebase Auth Emulator tokens are accepted. Local development only.",
      "Bootstrap",
    );
  }
  await app.listen(config.port, config.host);
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
