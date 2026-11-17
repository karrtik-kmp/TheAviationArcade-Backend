import { readFileSync } from "node:fs";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { apiDocsSpecPath } from "../src/config/config.module.js";

// Swagger UI for docs/openapi.yaml: exact paths, same origin, relative references so it works under the dev /api/ prefix (src/platform/api-docs.ts).

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

  it.each(["get", "head"] as const)("%s /docs redirects to the relative docs/ with no body", async (method) => {
    const res = await request(on.getHttpServer())[method]("/docs").redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("docs/");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.headers["content-length"]).toBe("0");
    expect(res.text ?? "").toBe("");
  });

  it("resolves the redirect to /docs/ locally and /api/docs/ behind the proxy prefix", () => {
    expect(new URL("docs/", "https://h/api/docs").pathname).toBe("/api/docs/");
    expect(new URL("docs/", "http://h/docs").pathname).toBe("/docs/");
  });

  it("serves the spec file byte for byte, as YAML whose first server is relative to the document", async () => {
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
    expect(spec.servers[0].url).toBe("..");
    expect(spec.openapi).toMatch(/^3\./);
  });

  const expectRelative = (ref: string): void => {
    expect(ref.startsWith("/")).toBe(false);
    expect(ref).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
    expect(new URL(ref, "https://h/api/docs/").pathname.startsWith("/api/docs/")).toBe(true);
  };

  it("serves a page with no inline script and no inline event handler, loading only relative docs files", async () => {
    const html = (await request(on.getHttpServer()).get("/docs/")).text;
    expect(html).toContain("<title>Airplane Games API</title>");
    expect(html).toContain('<div id="swagger-ui">');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/\son\w+=/i);
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.sort()).toEqual(["init.js", "swagger-ui-bundle.js", "swagger-ui.css"]);
    for (const ref of refs) expectRelative(ref);
  });

  it("configures Swagger UI to load the relative spec and ignore query-string config", async () => {
    const js = (await request(on.getHttpServer()).get("/docs/init.js")).text;
    const url = /url: "([^"]+)"/.exec(js)?.[1];
    expect(url).toBe("openapi.yaml");
    expectRelative(url!);
    expect(js).toContain("queryConfigEnabled: false");
    expect(js).toContain("persistAuthorization: false");
    expect(js).toContain("validatorUrl: null");
  });

  it("leaves the global CSP unchanged", async () => {
    const health = await request(on.getHttpServer()).get("/v1/health");
    const docs = await request(on.getHttpServer()).get("/docs/");
    expect(docs.headers["content-security-policy"]).toBeTruthy();
    expect(docs.headers["content-security-policy"]).toBe(health.headers["content-security-policy"]);
  });

  it.each([
    ["POST", "/docs"],
    ["POST", "/docs/"],
    ["PUT", "/docs/openapi.yaml"],
    ["GET", "/docs/index.html"],
    ["GET", "/docs/swagger-initializer.js"],
    ["GET", "/docs/../package.json"],
    ["GET", "/docs/%2e%2e/package.json"],
    ["GET", "/docs/SWAGGER-UI.CSS"],
    ["GET", "/DOCS"],
    ["GET", "/docs/swagger-ui.css.map"],
    ["GET", "/docs//"],
    ["GET", "/docs/./init.js"],
  ])("%s %s is the standard 404 envelope", async (method, path) => {
    const res = await request(on.getHttpServer())[method.toLowerCase() as "get" | "post" | "put"](path);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("serves nothing under /docs when switched off", async () => {
    for (const path of ["/docs", "/docs/", "/docs/openapi.yaml", "/docs/init.js"]) {
      const res = await request(off.getHttpServer()).get(path);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
  });
});
