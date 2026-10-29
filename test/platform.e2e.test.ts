import { randomUUID } from "node:crypto";
import http from "node:http";
import { Controller, Get } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { Public } from "../src/auth/public.decorator.js";
import { drain } from "../src/platform/shutdown.js";
import { emulatorToken } from "./tokens.js";

// Production basics, rate limiting and the client version gate, each against an app built with its own
// environment (the e2e config sets very high limits for api.test.ts).

const apps: NestExpressApplication[] = [];
const savedEnv = { ...process.env };

// The only public route that is rate limited is a test one: health is exempt by design.
@Controller("v1/test")
class PublicProbeController {
  @Public()
  @Get("public")
  ping() {
    return { ok: true };
  }
}

/** Build the real app with `env` applied on top of the e2e environment. */
async function buildAppHandle(
  env: Record<string, string> = {},
  trustProxy: false | number = false,
  extra?: (app: NestExpressApplication) => void,
) {
  Object.assign(process.env, env);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [PublicProbeController],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app, { trustProxy });
  extra?.(app); // routes added here sit behind the shared middleware and ahead of Nest's router
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  return { app, server: app.getHttpServer() };
}

async function buildApp(env: Record<string, string> = {}, trustProxy: false | number = false) {
  return (await buildAppHandle(env, trustProxy)).server;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

const bearer = (uid = `uid-${randomUUID()}`) => ({ Authorization: `Bearer ${emulatorToken(uid)}` });

describe("health", () => {
  it("liveness is pure and readiness reports the database", async () => {
    const server = await buildApp();
    const live = await request(server).get("/v1/health");
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ ok: true });
    const ready = await request(server).get("/v1/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ready" });
    expect(ready.headers["cache-control"]).toBe("no-store");
  });

  it("readiness is 503 service_unavailable with Retry-After when the database is down; liveness stays 200", async () => {
    const server = await buildApp({ DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none" });
    const ready = await request(server).get("/v1/health/ready");
    expect(ready.status).toBe(503);
    expect(ready.headers["retry-after"]).toBe("5");
    expect(ready.body.error.code).toBe("service_unavailable");
    expect((await request(server).get("/v1/health")).status).toBe(200);
  });
});

describe("rate limiting", () => {
  it("limits public routes per IP with 429 rate_limited and Retry-After; health is exempt", async () => {
    const server = await buildApp({ RATE_LIMIT_PUBLIC_PER_MIN: "3" });
    for (let i = 0; i < 3; i += 1) expect((await request(server).get("/v1/test/public")).status).toBe(200);
    const limited = await request(server).get("/v1/test/public");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    expect(limited.body.error.requestId).toEqual(expect.any(String));
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);
    for (let i = 0; i < 6; i += 1) expect((await request(server).get("/v1/health")).status).toBe(200);
    // Readiness is exempt too: behind a load balancer every probe shares one IP.
    for (let i = 0; i < 6; i += 1) expect((await request(server).get("/v1/health/ready")).status).toBe(200);
  });

  it("has no punitive lockout: Retry-After is the time until room frees up, not a full extra window", async () => {
    const server = await buildApp({ RATE_LIMIT_PUBLIC_PER_MIN: "2" });
    await request(server).get("/v1/test/public");
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await request(server).get("/v1/test/public");
    const limited = await request(server).get("/v1/test/public");
    expect(limited.status).toBe(429);
    // The oldest hit is about 2 s old, so room frees up within roughly 58 s, not 60 s from now.
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(58);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("limits authenticated routes per principal, across routes, and does not share buckets between players", async () => {
    const server = await buildApp({ RATE_LIMIT_AUTH_PER_MIN: "3", RATE_LIMIT_PUBLIC_PER_MIN: "1000" });
    const alice = bearer();
    const bob = bearer();
    for (let i = 0; i < 3; i += 1) {
      const res = await request(server).get("/v1/me/progress").set(alice);
      expect(res.status).not.toBe(429);
    }
    const limited = await request(server).get("/v1/me/progress").set(alice);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    // The limit is per principal, not per route.
    expect((await request(server).post("/v1/rounds").set(alice).send({})).status).toBe(429);
    // Another player from the same IP is unaffected.
    expect((await request(server).get("/v1/me/progress").set(bob)).status).not.toBe(429);
  });

  it("does not count authenticated requests against the IP bucket used by public routes", async () => {
    const server = await buildApp({ RATE_LIMIT_AUTH_PER_MIN: "1000", RATE_LIMIT_PUBLIC_PER_MIN: "2" });
    const player = bearer();
    for (let i = 0; i < 5; i += 1) expect((await request(server).get("/v1/me/progress").set(player)).status).not.toBe(429);
    expect((await request(server).get("/v1/test/public")).status).toBe(200);
  });

  it("an unauthenticated request to a protected route is 401, not 429, and is not counted", async () => {
    const server = await buildApp({ RATE_LIMIT_PUBLIC_PER_MIN: "1" });
    for (let i = 0; i < 3; i += 1) expect((await request(server).get("/v1/me/progress")).status).toBe(401);
    expect((await request(server).get("/v1/test/public")).status).toBe(200);
  });

  it("keys public routes on req.ip: X-Forwarded-For is ignored unless TRUST_PROXY is set", async () => {
    const untrusted = await buildApp({ RATE_LIMIT_PUBLIC_PER_MIN: "1" });
    expect((await request(untrusted).get("/v1/test/public").set("X-Forwarded-For", "203.0.113.1")).status).toBe(200);
    // A different spoofed address does not get a fresh bucket.
    expect((await request(untrusted).get("/v1/test/public").set("X-Forwarded-For", "203.0.113.2")).status).toBe(429);

    const trusted = await buildApp({ RATE_LIMIT_PUBLIC_PER_MIN: "1" }, 1);
    expect((await request(trusted).get("/v1/test/public").set("X-Forwarded-For", "203.0.113.1")).status).toBe(200);
    expect((await request(trusted).get("/v1/test/public").set("X-Forwarded-For", "203.0.113.2")).status).toBe(200);
    expect((await request(trusted).get("/v1/test/public").set("X-Forwarded-For", "203.0.113.2")).status).toBe(429);
  });
});

describe("client version gate", () => {
  it("is off when MIN_CLIENT_BUILD is unset", async () => {
    const server = await buildApp();
    expect((await request(server).get("/v1/me/progress").set(bearer())).status).not.toBe(426);
  });

  it("rejects missing, malformed and lower builds with 426 and accepts the minimum or higher", async () => {
    const server = await buildApp({ MIN_CLIENT_BUILD: "20" });
    const player = bearer();
    for (const version of [undefined, "19", "abc", "20.5", "-20", "0"]) {
      let req = request(server).get("/v1/me/progress").set(player);
      if (version !== undefined) req = req.set("X-Client-Version", version);
      const res = await req;
      expect(res.status, String(version)).toBe(426);
      expect(res.body.error.code).toBe("client_update_required");
    }
    expect((await request(server).get("/v1/me/progress").set(player).set("X-Client-Version", "20")).status).not.toBe(426);
    expect((await request(server).get("/v1/me/progress").set(player).set("X-Client-Version", "21")).status).not.toBe(426);
  });

  it("runs before authentication: an outdated client with no token is told to update, not 401", async () => {
    const server = await buildApp({ MIN_CLIENT_BUILD: "20" });
    expect((await request(server).get("/v1/me/progress").set("X-Client-Version", "1")).status).toBe(426);
    const current = await request(server).get("/v1/me/progress").set("X-Client-Version", "20");
    expect(current.status).toBe(401);
  });

  it("skips the website's server (X-Client: web) but still verifies its token", async () => {
    const server = await buildApp({ MIN_CLIENT_BUILD: "20" });
    const player = bearer();
    expect((await request(server).put("/v1/me").set(player).set("X-Client", "web")).status).not.toBe(426);
    const res = await request(server).get("/v1/me/progress").set(player).set("X-Client", "web");
    expect(res.status).toBe(200);
    expect((await request(server).get("/v1/me/progress").set("X-Client", "web")).status).toBe(401);
    expect((await request(server).get("/v1/me/progress").set(player).set("X-Client", "app")).status).toBe(426);
  });

  it("does not apply to account deletion, so an outdated client can still delete its data", async () => {
    const server = await buildApp({ MIN_CLIENT_BUILD: "20" });
    const res = await request(server).delete("/v1/me").set(bearer());
    expect(res.status).toBe(204);
    // Other routes still demand the update.
    expect((await request(server).put("/v1/me").set(bearer())).status).toBe(426);
  });

  it("exempts both health routes", async () => {
    const server = await buildApp({ MIN_CLIENT_BUILD: "20" });
    expect((await request(server).get("/v1/health")).status).toBe(200);
    expect((await request(server).get("/v1/health/ready")).status).toBe(200);
  });
});

/** A plain keep-alive GET on a given agent, returning status, headers and elapsed time. */
function get(server: http.Server, agent: http.Agent, path: string) {
  const { port } = server.address() as { port: number };
  return new Promise<{ status: number; connection: string | undefined; body: string }>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, agent }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, connection: res.headers.connection, body }));
      })
      .on("error", reject);
  });
}

describe("graceful shutdown", () => {
  it("closes promptly with a keep-alive connection that was mid-request, and tells it Connection: close", async () => {
    const { app, server } = await buildAppHandle({}, false, (a) =>
      a.use("/slow", (_req: http.IncomingMessage, res: http.ServerResponse) => {
        setTimeout(() => res.end("done"), 700);
      }),
    );
    const agent = new http.Agent({ keepAlive: true });
    await get(server, agent, "/v1/health"); // leaves an idle keep-alive socket in the agent
    const slow = get(server, agent, "/slow");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = Date.now();
    const closed = drain(app, { prestopMs: 0, drainMs: 8000 });
    const reply = await slow;
    expect(reply.body).toBe("done");
    expect(reply.connection).toBe("close");
    expect(await closed).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    apps.splice(apps.indexOf(app), 1); // already closed
    agent.destroy();
  });

  it("serves /ready as 503 during the pre-stop wait while the listener is still open", async () => {
    const { app, server } = await buildAppHandle();
    const closed = drain(app, { prestopMs: 800, drainMs: 8000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const res = await request(server).get("/v1/health/ready");
    expect(res.status).toBe(503);
    expect(res.headers.connection).toBe("close");
    expect(res.body.error.code).toBe("service_unavailable");
    expect(await closed).toBe(true);
    apps.splice(apps.indexOf(app), 1);
  });

  it("reports false when requests outlast the deadline", async () => {
    const { app, server } = await buildAppHandle({}, false, (a) =>
      a.use("/stuck", (_req: http.IncomingMessage, res: http.ServerResponse) => {
        setTimeout(() => res.end("late"), 2500);
      }),
    );
    const agent = new http.Agent({ keepAlive: false });
    const stuck = get(server, agent, "/stuck").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await drain(app, { prestopMs: 0, drainMs: 500 })).toBe(false);
    await stuck;
    apps.splice(apps.indexOf(app), 1);
  });
});

describe("readiness caching", () => {
  it("shares one answer across concurrent probes", async () => {
    const server = await buildApp();
    const replies = await Promise.all(Array.from({ length: 20 }, () => request(server).get("/v1/health/ready")));
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
  });
});
