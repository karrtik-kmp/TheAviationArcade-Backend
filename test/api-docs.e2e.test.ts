import { readFileSync } from "node:fs";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { apiDocsSpecPath } from "../src/config/config.module.js";

// Swagger UI for docs/openapi.yaml: local only, exact paths, same origin (src/platform/api-docs.ts).

const specPath = apiDocsSpecPath();
const specBytes = readFileSync(specPath);

async function start(apiDocs: boolean): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app, apiDocs ? { apiDocs: { specPath } } : {});
  await app.listen(0, "127.0.0.1");
  return app;
}

let on: NestExpressApplication;
let off: NestExpressApplication;

beforeAll(async () => {
  on = await start(true);
  off = await start(false);
});

afterAll(async () => {
  await on.close();
  await off.close();
});

const PATHS: ReadonlyArray<readonly [string, RegExp]> = [
  ["/docs", /^text\/html; charset=utf-8$/],
  ["/docs/", /^text\/html; charset=utf-8$/],
  ["/docs/init.js", /^text\/javascript; charset=utf-8$/],
  ["/docs/swagger-ui.css", /^text\/css; charset=utf-8$/],
  ["/docs/swagger-ui-bundle.js", /^text\/javascript; charset=utf-8$/],
  ["/docs/openapi.yaml", /^application\/yaml; charset=utf-8$/],
];

describe("API docs (Swagger UI)", () => {
  it.each(PATHS)("GET %s answers 200 with its content type, no-store, nosniff and a request id", async (path, type) => {
    const res = await request(on.getHttpServer()).get(path).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(type);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect((res.body as Buffer).length).toBeGreaterThan(0);
  });

  it.each(PATHS)("HEAD %s answers 200 with the same headers and no body", async (path, type) => {
    const res = await request(on.getHttpServer()).head(path);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(type);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text ?? "").toBe("");
  });

  it("serves the spec file byte for byte, as YAML whose first server is the same origin", async () => {
    const res = await request(on.getHttpServer())
      .get("/docs/openapi.yaml")
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(Buffer.compare(res.body as Buffer, specBytes)).toBe(0);
    const spec: any = parse((res.body as Buffer).toString("utf8"));
    expect(spec.servers[0].url).toBe("/");
    expect(spec.openapi).toMatch(/^3\./);
  });

  it("serves a page with no inline script and no inline event handler, loading only /docs files", async () => {
    const html = (await request(on.getHttpServer()).get("/docs")).text;
    expect(html).toContain("<title>Airplane Games API (local)</title>");
    expect(html).toContain('<div id="swagger-ui">');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/\son\w+=/i);
    for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) expect(url).toMatch(/^\/docs\//);
  });

  it("configures Swagger UI to load the same-origin spec and ignore query-string config", async () => {
    const js = (await request(on.getHttpServer()).get("/docs/init.js")).text;
    expect(js).toContain('url: "/docs/openapi.yaml"');
    expect(js).toContain("queryConfigEnabled: false");
    expect(js).toContain("persistAuthorization: false");
  });

  it("leaves the global CSP unchanged", async () => {
    const health = await request(on.getHttpServer()).get("/v1/health");
    const docs = await request(on.getHttpServer()).get("/docs");
    expect(docs.headers["content-security-policy"]).toBeTruthy();
    expect(docs.headers["content-security-policy"]).toBe(health.headers["content-security-policy"]);
  });

  it.each([
    ["POST", "/docs"],
    ["PUT", "/docs/openapi.yaml"],
    ["GET", "/docs/index.html"],
    ["GET", "/docs/swagger-initializer.js"],
    ["GET", "/docs/../package.json"],
    ["GET", "/docs/%2e%2e/package.json"],
    ["GET", "/docs/SWAGGER-UI.CSS"],
    ["GET", "/DOCS"],
    ["GET", "/docs/swagger-ui.css.map"],
  ])("%s %s is the standard 404 envelope", async (method, path) => {
    const res = await request(on.getHttpServer())[method.toLowerCase() as "get" | "post" | "put"](path);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("serves nothing under /docs when switched off", async () => {
    for (const path of ["/docs", "/docs/openapi.yaml", "/docs/init.js"]) {
      const res = await request(off.getHttpServer()).get(path);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
  });
});
