import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { APP_CONFIG, loadConfig } from "../src/config/config.module.js";
import type { AppConfig } from "../src/config/config.module.js";
import { emulatorToken, guestToken, linkedToken } from "./tokens.js";

// docs/plans/guest-callsign.md G1-G4, G7: Firebase Anonymous guests as players, against the real Nest app and the test database. Every
// app here counts in a process-local rate-limit store, so guest creations from 127.0.0.1 never pile up in the shared test database.

const PREFIX = "firebase:demo-airplane-games:";
type Srv = ReturnType<NestExpressApplication["getHttpServer"]>;

let sql: pg.Pool;
let guestsOn: NestExpressApplication;
let guestsOff: NestExpressApplication;
let on: Srv;
let off: Srv;
const apps: NestExpressApplication[] = [];

async function buildApp(overrides: Partial<AppConfig>) {
  const config: AppConfig = { ...loadConfig(process.env), rateLimitStore: "memory", ...overrides };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(APP_CONFIG).useValue(config).compile();
  const built = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(built);
  await built.listen(0, "127.0.0.1");
  apps.push(built);
  return built;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const uid = () => `uid-${randomUUID()}`;
const row = async (u: string) => (await sql.query("SELECT * FROM players WHERE id = $1", [PREFIX + u])).rows[0];

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  guestsOn = await buildApp({ anonymousPlayers: true, guestCreatePerIpPerHour: 100_000 });
  guestsOff = await buildApp({ anonymousPlayers: false });
  on = guestsOn.getHttpServer();
  off = guestsOff.getHttpServer();
});

afterAll(async () => {
  for (const app of apps) await app.close();
  await sql.end();
});

describe("guests (G1, G2)", () => {
  it("a guest's PUT /v1/me is 201 then 200 for the same player, stamped anonymous_since, with profile { callsign: null, guest: true }", async () => {
    const u = uid();
    const first = await request(on).put("/v1/me").set(bearer(guestToken(u)));
    expect(first.status).toBe(201);
    expect(first.body.profile).toEqual({ callsign: null, guest: true });
    expect(first.body.progress).toMatchObject({ version: 1, hints: 5, miles: 0 });
    const created = await row(u);
    expect(created.anonymous_since).toBeInstanceOf(Date);
    const again = await request(on).put("/v1/me").set(bearer(guestToken(u)));
    expect(again.status).toBe(200);
    expect(again.body.profile).toEqual({ callsign: null, guest: true });
    expect((await row(u)).anonymous_since).toEqual(created.anonymous_since);
    // A guest plays like anyone else: progress is served.
    expect((await request(on).get("/v1/me/progress").set(bearer(guestToken(u)))).status).toBe(200);
  });

  it("with FIREBASE_ANONYMOUS_PLAYERS off a guest token is 401 unauthorized and nothing is written", async () => {
    const u = uid();
    const res = await request(off).put("/v1/me").set(bearer(guestToken(u)));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
    expect(await row(u)).toBeUndefined();
  });

  it("after the link (same uid, password token) it is the same player: anonymous_since cleared, version and progress unchanged", async () => {
    const u = uid();
    const guest = await request(on).put("/v1/me").set(bearer(guestToken(u)));
    expect(guest.status).toBe(201);
    const linked = await request(on).put("/v1/me").set(bearer(linkedToken(u)));
    expect(linked.status).toBe(200);
    expect(linked.body.profile).toEqual({ callsign: null, guest: false });
    expect(linked.body.progress.version).toBe(guest.body.progress.version);
    const after = await row(u);
    expect(after.anonymous_since).toBeNull();
    expect(after.version).toBe(1);
    expect(after.logbook_version).toBe(1);
    // A stale guest token used after the link never stamps the row again.
    const stale = await request(on).put("/v1/me").set(bearer(guestToken(u)));
    expect(stale.status).toBe(200);
    expect(stale.body.profile.guest).toBe(true);
    expect((await row(u)).anonymous_since).toBeNull();
  });

  it("a linked token that still names sign_in_provider anonymous is an account, even with guests switched off", async () => {
    const u = uid();
    expect((await request(on).put("/v1/me").set(bearer(guestToken(u)))).status).toBe(201);
    const stillAnonymous = emulatorToken(u, "demo-airplane-games", "anonymous", { identities: { email: [`${u}@sites.test`] } });
    const res = await request(off).put("/v1/me").set(bearer(stillAnonymous));
    expect(res.status).toBe(200);
    expect(res.body.profile.guest).toBe(false);
    expect((await row(u)).anonymous_since).toBeNull();
  });

  it("an account's first PUT /v1/me is not stamped", async () => {
    const u = uid();
    expect((await request(on).put("/v1/me").set(bearer(emulatorToken(u)))).status).toBe(201);
    expect((await row(u)).anonymous_since).toBeNull();
  });

  it("DELETE /v1/me is 204 for a guest and erases the player", async () => {
    const u = uid();
    expect((await request(on).put("/v1/me").set(bearer(guestToken(u)))).status).toBe(201);
    expect((await request(on).delete("/v1/me").set(bearer(guestToken(u)))).status).toBe(204);
    expect(await row(u)).toBeUndefined();
  });
});

describe("account_required (G4)", () => {
  it("a guest gets 403 account_required on purchases, the Miles shop and the photographer role; nothing is written", async () => {
    const u = uid();
    const auth = bearer(guestToken(u));
    expect((await request(on).put("/v1/me").set(auth)).status).toBe(201);
    const routes: [string, request.Test][] = [
      ["purchases", request(on).post("/v1/purchases").set(auth).send({ store: "apple", productId: "x", transactionId: "1" })],
      ["shop", request(on).post("/v1/shop/miles-hint-pack").set(auth).set("Idempotency-Key", "k1")],
      ["photographer", request(on).post("/v1/me/roles/photographer").set(auth)],
    ];
    for (const [label, pending] of routes) {
      const res = await pending;
      expect(res.status, label).toBe(403);
      expect(res.body.error.code, label).toBe("account_required");
    }
    expect((await sql.query("SELECT role FROM account_roles WHERE principal = $1 ORDER BY role", [PREFIX + u])).rows).toEqual([
      { role: "player" },
    ]);
    // Reads stay open: entitlements and the account's own roles.
    expect((await request(on).get("/v1/me/entitlements").set(auth)).status).toBe(200);
    expect((await request(on).get("/v1/me/roles").set(auth)).status).toBe(200);
  });

  it("after the link the same player passes the guard (the shop answers on its own terms)", async () => {
    const u = uid();
    expect((await request(on).put("/v1/me").set(bearer(guestToken(u)))).status).toBe(201);
    const res = await request(on).post("/v1/shop/miles-hint-pack").set(bearer(linkedToken(u))).set("Idempotency-Key", "k1");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("insufficient_miles");
  });

  it("a guest is refused on admin routes as before (403 forbidden)", async () => {
    const res = await request(on).get("/v1/admin/role-requests").set(bearer(guestToken(uid())));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });
});

describe("guest creation per IP (G3)", () => {
  it("ASSUMPTION: the limit counts only NEW guests: over it, 429 rate_limited with Retry-After and no player or role row", async () => {
    const limited = (await buildApp({ anonymousPlayers: true, guestCreatePerIpPerHour: 2 })).getHttpServer();
    const first = uid();
    expect((await request(limited).put("/v1/me").set(bearer(guestToken(first)))).status).toBe(201);
    expect((await request(limited).put("/v1/me").set(bearer(guestToken(uid())))).status).toBe(201);
    // An existing guest signing in again is never counted, nor is an account's creation.
    expect((await request(limited).put("/v1/me").set(bearer(guestToken(first)))).status).toBe(200);
    expect((await request(limited).put("/v1/me").set(bearer(emulatorToken(uid())))).status).toBe(201);
    const third = uid();
    const refused = await request(limited).put("/v1/me").set(bearer(guestToken(third)));
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe("rate_limited");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(3000);
    expect(await row(third)).toBeUndefined();
    expect((await sql.query("SELECT 1 FROM account_roles WHERE principal = $1", [PREFIX + third])).rowCount).toBe(0);
    // The existing guest still signs in.
    expect((await request(limited).put("/v1/me").set(bearer(guestToken(first)))).status).toBe(200);
  });
});
