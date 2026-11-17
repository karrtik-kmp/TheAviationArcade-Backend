import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { NextFunction, Request, Response } from "express";
import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * Swagger UI for docs/openapi.yaml, served same-origin at /docs for local development only (config API_DOCS, refused in production).
 * "Try it out" then needs no CORS and no change to the global CSP: the page loads only its own files, no inline script.
 *
 * It is a plain middleware, not a Nest controller, so it adds no route (the route-count tests stay as they are). Consequences, both
 * deliberate: docs requests are not throttled (not a Nest route; the server is loopback only) and the request log shows route
 * "(unmatched)". Only the exact paths below answer, GET and HEAD only; everything else falls through to the global filter's 404.
 *
 * swagger-ui-dist is a devDependency: it is resolved only here, only when docs are on, and never imported at module load.
 */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Airplane Games API (local)</title>
<link rel="stylesheet" href="/docs/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="/docs/swagger-ui-bundle.js"></script>
<script src="/docs/init.js"></script>
</body>
</html>
`;

// Options checked against swagger-ui 5.34.1 (docs/usage/configuration): url, dom_id, presets, layout, validatorUrl (null = no
// validator badge, no call to a third party), queryConfigEnabled (false = a link cannot inject config such as another spec url),
// persistAuthorization (false = a pasted token is not kept in browser storage), deepLinking.
const INIT_JS = `window.ui = SwaggerUIBundle({
  url: "/docs/openapi.yaml",
  dom_id: "#swagger-ui",
  presets: [SwaggerUIBundle.presets.apis],
  layout: "BaseLayout",
  validatorUrl: null,
  queryConfigEnabled: false,
  persistAuthorization: false,
  deepLinking: true,
});
`;

/** Drops a trailing `//# sourceMappingURL=` / `/*# sourceMappingURL= *\/` comment: the map is not served, so devtools would only 404. */
function stripSourceMap(text: string): string {
  return text.replace(/\n?(?:\/\/# sourceMappingURL=[^\n]*|\/\*# sourceMappingURL=[^\n]*?\*\/)\s*$/, "\n");
}

export function mountApiDocs(app: NestExpressApplication, options: { specPath: string }): void {
  let dist: string;
  try {
    dist = dirname(createRequire(import.meta.url).resolve("swagger-ui-dist/package.json"));
  } catch {
    throw new Error("API_DOCS is on but swagger-ui-dist is not installed (it is a devDependency)");
  }
  if (!existsSync(options.specPath)) {
    throw new Error(`API_DOCS is on but docs/openapi.yaml is missing at ${options.specPath}`);
  }
  const files = new Map<string, { type: string; body: Buffer }>([
    ["/docs", { type: "text/html; charset=utf-8", body: Buffer.from(PAGE) }],
    ["/docs/", { type: "text/html; charset=utf-8", body: Buffer.from(PAGE) }],
    ["/docs/init.js", { type: "text/javascript; charset=utf-8", body: Buffer.from(INIT_JS) }],
    ["/docs/swagger-ui.css", { type: "text/css; charset=utf-8", body: Buffer.from(stripSourceMap(readFileSync(join(dist, "swagger-ui.css"), "utf8"))) }],
    ["/docs/swagger-ui-bundle.js", { type: "text/javascript; charset=utf-8", body: Buffer.from(stripSourceMap(readFileSync(join(dist, "swagger-ui-bundle.js"), "utf8"))) }],
    ["/docs/openapi.yaml", { type: "application/yaml; charset=utf-8", body: readFileSync(options.specPath) }],
  ]);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const file = req.method === "GET" || req.method === "HEAD" ? files.get(req.path) : undefined;
    if (!file) return next();
    res.status(200);
    res.setHeader("Content-Type", file.type);
    res.setHeader("Content-Length", file.body.length);
    res.setHeader("Cache-Control", "no-store");
    res.end(req.method === "HEAD" ? undefined : file.body);
  });
}
