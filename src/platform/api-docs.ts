import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { NextFunction, Request, Response } from "express";
import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * Swagger UI for docs/openapi.yaml, served same-origin under /docs/ (config API_DOCS). Local by default; on the hosted dev backend only
 * with an explicit API_DOCS=true on a _dev database and a loopback HOST, behind the proxy that strips /api (so it is /api/docs/
 * there); never production (config refuses it). "Try it out" then needs no CORS and no change to the global CSP: the page loads only
 * its own files, no inline script. Every reference in the page is relative so it works under any prefix.
 *
 * It is a plain middleware, not a Nest controller, so it adds no route (the route-count tests stay as they are). Consequences, both
 * deliberate: docs requests are not throttled (not a Nest route; they are static in-memory buffers, accepted for dev by ruling
 * 2026-11-17) and the request log shows route "(unmatched)". Only the exact paths below answer, GET and HEAD only; everything else
 * falls through to the global filter's 404. The page is at /docs/ only; /docs redirects to it (relative Location, so a proxy prefix
 * is kept).
 *
 * swagger-ui-dist is a dependency: it is resolved only here, only when docs are on, and never imported at module load.
 */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Airplane Games API</title>
<link rel="stylesheet" href="swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="swagger-ui-bundle.js"></script>
<script src="init.js"></script>
</body>
</html>
`;

// Options checked against swagger-ui 5.34.1 (docs/usage/configuration): url, dom_id, presets, layout, validatorUrl (null = no
// validator badge, no call to a third party), queryConfigEnabled (false = a link cannot inject config such as another spec url),
// persistAuthorization (false = a pasted token is not kept in browser storage), deepLinking.
const INIT_JS = `window.ui = SwaggerUIBundle({
  url: "openapi.yaml",
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
    throw new Error("API_DOCS is on but swagger-ui-dist is not installed (it is a dependency; run npm install)");
  }
  if (!existsSync(options.specPath)) {
    throw new Error(`API_DOCS is on but docs/openapi.yaml is missing at ${options.specPath}`);
  }
  const files = new Map<string, { type: string; body: Buffer }>([
    ["/docs/", { type: "text/html; charset=utf-8", body: Buffer.from(PAGE) }],
    ["/docs/init.js", { type: "text/javascript; charset=utf-8", body: Buffer.from(INIT_JS) }],
    ["/docs/swagger-ui.css", { type: "text/css; charset=utf-8", body: Buffer.from(stripSourceMap(readFileSync(join(dist, "swagger-ui.css"), "utf8"))) }],
    ["/docs/swagger-ui-bundle.js", { type: "text/javascript; charset=utf-8", body: Buffer.from(stripSourceMap(readFileSync(join(dist, "swagger-ui-bundle.js"), "utf8"))) }],
    ["/docs/openapi.yaml", { type: "application/yaml; charset=utf-8", body: readFileSync(options.specPath) }],
  ]);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path === "/docs") {
      // Relative Location resolves to /docs/ here and /api/docs/ behind the proxy. Set by hand, not res.redirect (absolute-ises/encodes).
      res.status(302);
      res.setHeader("Location", "docs/");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Length", 0);
      res.end();
      return;
    }
    const file = files.get(req.path);
    if (!file) return next();
    res.status(200);
    res.setHeader("Content-Type", file.type);
    res.setHeader("Content-Length", file.body.length);
    res.setHeader("Cache-Control", "no-store");
    res.end(req.method === "HEAD" ? undefined : file.body);
  });
}
