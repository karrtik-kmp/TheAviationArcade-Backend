import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";
import { loadConfig } from "./config/config.module.js";

// Local convenience: Node 22+ reads .env itself. Real environments set variables directly.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file.
}

async function bootstrap(): Promise<void> {
  // Fail fast on bad configuration before opening any connection.
  const { port } = loadConfig(process.env);
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  // SIGTERM/SIGINT close the app, which drains the pg pool (DatabaseModule.onApplicationShutdown).
  app.enableShutdownHooks();
  await app.listen(port);
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
