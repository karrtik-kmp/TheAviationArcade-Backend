import { randomBytes, randomUUID } from "node:crypto";
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

// docs/plans/guest-callsign.md C1, G7: Callsigns stored on the player, for guests and accounts alike.

const PREFIX = "firebase:demo-airplane-games:";

let sql: pg.Pool;
let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const config: AppConfig = { ...loadConfig(process.env), anonymousPlayers: true, rateLimitStore: "memory", guestCreatePerIpPerHour: 100_000 };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(APP_CONFIG).useValue(config).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
/** A fresh, valid, unused Callsign: C + 12 upper-case hex characters. */
const fresh = () => `C${randomBytes(6).toString("hex").toUpperCase()}`;

async function player(kind: "guest" | "account" = "guest") {
  const uid = `uid-${randomUUID()}`;
  const auth = bearer(kind === "guest" ? guestToken(uid) : emulatorToken(uid));
  const res = await request(server).put("/v1/me").set(auth);
  expect(res.status).toBe(201);
  return { uid, auth, principal: PREFIX + uid };
}
const availability = (auth: Record<string, string>, value: string) => request(server).get(`/v1/callsigns/${encodeURIComponent(value)}/availability`).set(auth);
const claim = (auth: Record<string, string>, callsign: unknown) => request(server).post("/v1/callsigns/claim").set(auth).send({ callsign });
const stored = async (principal: string) =>
  (await sql.query("SELECT callsign, callsign_claimed_at, callsign_changed_at, version FROM players WHERE id = $1", [principal])).rows[0];

describe("GET /v1/callsigns/{value}/availability", () => {
  it("answers 200 for every status: available, yours, taken (case-insensitive), reserved and invalid", async () => {
    const holder = await player();
    const other = await player("account");
    const value = fresh();
    expect((await availability(other.auth, value.toLowerCase())).body).toEqual({
      value: value.toLowerCase(),
      normalized: value,
      available: true,
      status: "available",
    });
    expect((await claim(holder.auth, value)).status).toBe(200);
    expect((await availability(holder.auth, value)).body).toMatchObject({ available: true, status: "yours" });
    expect((await availability(other.auth, value.toLowerCase())).body).toMatchObject({ normalized: value, available: false, status: "taken" });
    expect((await availability(other.auth, "pilot")).body).toEqual({ value: "pilot", normalized: "PILOT", available: false, status: "reserved" });
    for (const bad of ["ab", "sky-ward", "sky ward", "straße", "A".repeat(17)]) {
      const res = await availability(other.auth, bad);
      expect(res.status, bad).toBe(200);
      expect(res.body, bad).toEqual({ value: bad, normalized: "", available: false, status: "invalid" });
    }
    const long = "A".repeat(200);
    expect((await availability(other.auth, long)).body).toEqual({ value: "A".repeat(64), normalized: "", available: false, status: "invalid" });
  });

  it("needs a token but no player row", async () => {
    expect((await request(server).get("/v1/callsigns/ABCD/availability")).status).toBe(401);
    const res = await availability(bearer(guestToken(`uid-${randomUUID()}`)), fresh());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("available");
  });
});

describe("POST /v1/callsigns/claim", () => {
  it("claims for a guest, shows on PUT /v1/me, and replays as changed: false; no progress version bump", async () => {
    const p = await player();
    const value = fresh();
    const first = await claim(p.auth, value.toLowerCase());
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ callsign: value, claimedAt: expect.any(String), changed: true });
    const replay = await claim(p.auth, ` ${value} `);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ callsign: value, claimedAt: first.body.claimedAt, changed: false });
    const me = await request(server).put("/v1/me").set(p.auth);
    expect(me.body.profile).toEqual({ callsign: value, guest: true });
    const row = await stored(p.principal);
    expect(row).toMatchObject({ callsign: value, callsign_changed_at: null, version: 1 });
    expect(row.callsign_claimed_at.toISOString()).toBe(first.body.claimedAt);
  });

  it("404 player_not_found before PUT /v1/me, 422 callsign_invalid, 409 callsign_taken for a held (any case) or reserved value", async () => {
    const nobody = await claim(bearer(guestToken(`uid-${randomUUID()}`)), fresh());
    expect(nobody.status).toBe(404);
    expect(nobody.body.error.code).toBe("player_not_found");
    const holder = await player();
    const p = await player("account");
    const value = fresh();
    expect((await claim(holder.auth, value)).status).toBe(200);
    for (const bad of ["ab", "sky-ward", "ſky1", ""]) {
      const res = await claim(p.auth, bad);
      expect(res.status, bad).toBe(422);
      expect(res.body.error.code, bad).toBe("callsign_invalid");
    }
    for (const unavailable of [value, value.toLowerCase(), "Admin", "GUEST"]) {
      const res = await claim(p.auth, unavailable);
      expect(res.status, unavailable).toBe(409);
      expect(res.body.error.code, unavailable).toBe("callsign_taken");
    }
    expect((await stored(p.principal)).callsign).toBeNull();
  });

  it("the body is strict: the retired Worker's deviceId, a non-string or a missing callsign is 400", async () => {
    const p = await player();
    for (const body of [{ deviceId: "d", callsign: fresh() }, { callsign: 12345 }, {}, { callsign: "A".repeat(65) }]) {
      const res = await request(server).post("/v1/callsigns/claim").set(p.auth).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
  });

  it("ASSUMPTION: the first change is free, then 409 callsign_change_too_soon with changeableAt until 30 days after it (database clock)", async () => {
    const p = await player();
    const [a, b, c] = [fresh(), fresh(), fresh()];
    expect((await claim(p.auth, a)).status).toBe(200);
    const changed = await claim(p.auth, b);
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ callsign: b, changed: true });
    const changedAt = (await stored(p.principal)).callsign_changed_at as Date;
    expect(changedAt.toISOString()).toBe(changed.body.claimedAt);
    const soon = await claim(p.auth, c);
    expect(soon.status).toBe(409);
    expect(soon.body.error.code).toBe("callsign_change_too_soon");
    expect(soon.body.changeableAt).toBe(new Date(changedAt.getTime() + 30 * 86_400_000).toISOString());
    // The value the player holds is still a no-op inside the cooldown, and the old value was freed by the change.
    expect((await claim(p.auth, b)).body.changed).toBe(false);
    expect((await availability(p.auth, a)).body.status).toBe("available");
    // Boundary on the database clock: one minute short is refused, exactly 30 days is allowed.
    await sql.query("UPDATE players SET callsign_changed_at = now() - interval '30 days' + interval '1 minute' WHERE id = $1", [p.principal]);
    expect((await claim(p.auth, c)).status).toBe(409);
    await sql.query("UPDATE players SET callsign_changed_at = now() - interval '30 days' WHERE id = $1", [p.principal]);
    const allowed = await claim(p.auth, c);
    expect(allowed.status).toBe(200);
    expect(allowed.body.callsign).toBe(c);
  });

  it("two players claiming one value at once: exactly one wins, the other is 409 callsign_taken", async () => {
    const [p, q] = [await player(), await player("account")];
    const value = fresh();
    const results = await Promise.all([claim(p.auth, value), claim(q.auth, value)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.error.code).toBe("callsign_taken");
  });

  it("two players swapping values at once never answer 500", async () => {
    const [p, q] = [await player(), await player()];
    const [x, y] = [fresh(), fresh()];
    expect((await claim(p.auth, x)).status).toBe(200);
    expect((await claim(q.auth, y)).status).toBe(200);
    const results = await Promise.all([claim(p.auth, y), claim(q.auth, x)]);
    for (const res of results) expect([200, 409]).toContain(res.status);
  });

  it("survives the link (same uid) and is freed when the player is deleted", async () => {
    const p = await player();
    const value = fresh();
    expect((await claim(p.auth, value)).status).toBe(200);
    const linked = await request(server).put("/v1/me").set(bearer(linkedToken(p.uid)));
    expect(linked.status).toBe(200);
    expect(linked.body.profile).toEqual({ callsign: value, guest: false });
    expect((await availability(bearer(linkedToken(p.uid)), value)).body.status).toBe("yours");
    expect((await request(server).delete("/v1/me").set(bearer(linkedToken(p.uid)))).status).toBe(204);
    const next = await player("account");
    expect((await availability(next.auth, value)).body.status).toBe("available");
    expect((await claim(next.auth, value)).status).toBe(200);
  });
});
