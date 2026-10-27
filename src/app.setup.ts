import type { INestApplication } from "@nestjs/common";
import { requestContext } from "./common/request-context.js";

/**
 * Wiring shared by the real server and the e2e tests. The request-id/log middleware is added with
 * app.use() before Nest initialises so it runs ahead of the body parser; module-level middleware would
 * run after it and miss requests that fail to parse.
 */
export function configureApp(app: INestApplication): void {
  app.use(requestContext);
}
