import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Ajv2020 } from "ajv/dist/2020.js";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { ERROR_CODES } from "../src/common/errors.js";
import { SEED_COMMERCIAL_CARD_KEYS } from "../src/rules/aircraft-tags.js";
import { MODULE_IDS } from "../src/rules/modules.js";
import { RANKS } from "../src/rules/ranks.js";
import { XLSX_MIME } from "../src/content/xlsx.js";
import { mirrorSnapshot } from "../src/ugs/mirror-policy.js";
import { clientSheet } from "./fixtures.js";
import { emulatorToken } from "./tokens.js";
import { factsFor, newKey, openBody } from "./trip-helpers.js";

// docs/openapi.yaml is the client contract. These tests fail when it and the code drift.

const spec: any = parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});

afterAll(async () => {
  await sql.end();
  await app.close();
});

/** `x-planned: true` marks a designed but not yet built operation, schema, parameter, header or response. */
const isPlanned = (node: unknown): boolean =>
  !!node && typeof node === "object" && (node as Record<string, unknown>)["x-planned"] === true;

/** Built operations by default; with `planned`, only the x-planned ones. */
function specRoutes(which: "built" | "planned" = "built"): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method) && isPlanned(item[method]) === (which === "planned")) {
        out.push(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`);
      }
    }
  }
  return out.sort();
}

function expressRoutes(): string[] {
  const router = (app.getHttpAdapter().getInstance() as any).router;
  const out: string[] = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      out.push(`${method.toUpperCase()} ${String(layer.route.path)}`);
    }
  }
  return out.sort();
}

/**
 * Every `x-error-codes` list in paths and components. Codes under an `x-planned` node count as planned only:
 * by default they are skipped, with `planned` only they are collected.
 */
function collectErrorCodes(node: unknown, found: Set<string>, planned = false, inPlanned = false): void {
  if (Array.isArray(node)) {
    for (const item of node) collectErrorCodes(item, found, planned, inPlanned);
  } else if (node && typeof node === "object") {
    const here = inPlanned || isPlanned(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "x-error-codes") {
        if (here === planned) for (const code of value as string[]) found.add(code);
      } else collectErrorCodes(value, found, planned, here);
    }
  }
}

/** Sample values for path parameters of planned operations. */
const PLANNED_PATH_SAMPLES: Record<string, string> = { name: "field-awards", version: "1" };

describe("openapi contract parity", () => {
  it("documents exactly the routes Express registers (x-planned operations excluded)", () => {
    const registered = expressRoutes();
    // Guard against the enumeration silently finding nothing.
    expect(registered.length).toBeGreaterThan(0);
    expect(specRoutes()).toEqual(registered);
  });

  it("x-planned operations are not served yet: not registered, and 404 not_found", async () => {
    const planned = specRoutes("planned");
    expect(planned.length).toBeGreaterThan(0);
    const registered = new Set(expressRoutes());
    const auth = { Authorization: `Bearer ${emulatorToken(`uid-${randomUUID()}`)}` };
    for (const route of planned) {
      expect(registered.has(route), `${route} is registered: drop its x-planned mark`).toBe(false);
      const [method, path] = route.split(" ") as [string, string];
      const url = path.replace(/:(\w+)/g, (_match, param: string) => PLANNED_PATH_SAMPLES[param] ?? randomUUID());
      const res = await (request(server) as any)[method.toLowerCase()](url).set(auth);
      expect(res.status, `${route} -> ${res.status}`).toBe(404);
      expect(res.body.error.code, route).toBe("not_found");
    }
    // Every planned operation says why it is not built and where it is designed.
    for (const item of Object.values<any>(spec.paths)) {
      for (const method of Object.keys(item).filter((m) => HTTP_METHODS.includes(m))) {
        if (isPlanned(item[method])) expect(typeof item[method]["x-planned-note"]).toBe("string");
      }
    }
  });

  it("uses exactly the ErrorCode values, and its Error enum lists them all (planned codes apart)", () => {
    const used = new Set<string>();
    collectErrorCodes({ paths: spec.paths, responses: spec.components.responses }, used);
    expect([...used].sort()).toEqual([...ERROR_CODES].sort());
    expect([...spec.components.schemas.Error.properties.error.properties.code.enum].sort()).toEqual(
      [...ERROR_CODES].sort(),
    );
  });

  it("planned-only error codes are listed in x-planned-enum and are not ErrorCode values yet", () => {
    const known = new Set<string>(ERROR_CODES);
    const used = new Set<string>();
    collectErrorCodes({ paths: spec.paths, responses: spec.components.responses }, used, true);
    const plannedOnly = [...used].filter((code) => !known.has(code)).sort();
    const listed: string[] = spec.components.schemas.Error.properties.error.properties.code["x-planned-enum"] ?? [];
    expect([...listed].sort()).toEqual(plannedOnly);
    for (const code of listed) expect(known.has(code), `${code} is built: move it to enum`).toBe(false);
  });

  it("UgsMirrorProgress matches the value the mirror writes", () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ $id: "spec", components: spec.components });
    const validate = ajv.compile({ $ref: "spec#/components/schemas/UgsMirrorProgress" });
    const player = {
      id: "firebase:demo-airplane-games:u1", statusPoints: 1200, miles: 30, hints: 5, perfectStreak: 2, activeRank: null,
      firstClassUntil: null, version: 4, createdAt: new Date(), updatedAt: new Date(),
    };
    const value = mirrorSnapshot(player, new Date());
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(mirrorSnapshot({ ...player, firstClassUntil: new Date() }, new Date()))).toBe(true);
    expect(validate({ ...value, extra: 1 })).toBe(false);
    expect(validate({ ...value, schemaVersion: 1 })).toBe(false);
    const { uid: _uid, ...withoutOwner } = value;
    expect(validate(withoutOwner)).toBe(false);
  });

  it("rank and module enums match src/rules", () => {
    expect(spec.components.schemas.Rank.enum).toEqual([...RANKS]);
    expect(spec.components.schemas.ModuleId.enum).toEqual([...MODULE_IDS]);
  });

  it("every path response and status code is declared (no route lacks a 2xx)", () => {
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const method of Object.keys(item).filter((m) => HTTP_METHODS.includes(m))) {
        const statuses = Object.keys(item[method].responses);
        expect(statuses.some((s) => s.startsWith("2")), `${method} ${path}`).toBe(true);
      }
    }
  });
});

describe("openapi contract: real responses validate against the spec", () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  ajv.addSchema({ $id: "spec", components: spec.components });
  const check = (schemaName: string, value: unknown) => {
    const validate = ajv.compile({ $ref: `spec#/components/schemas/${schemaName}` });
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  };
  const rejects = (schemaName: string, value: unknown) => {
    const validate = ajv.compile({ $ref: `spec#/components/schemas/${schemaName}` });
    expect(validate(value), schemaName).toBe(false);
  };

  const uid = `uid-${randomUUID()}`;
  const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };

  it("health, progress, issued round, banked result and replay, errors", async () => {
    const live = await request(server).get("/v1/health");
    check("Liveness", live.body);
    const ready = await request(server).get("/v1/health/ready");
    check("Readiness", ready.body);

    const created = await request(server).put("/v1/me").set(auth);
    expect(created.status).toBe(201);
    check("ProgressEnvelope", created.body);
    const progress = await request(server).get("/v1/me/progress").set(auth);
    check("ProgressEnvelope", progress.body);

    // T2: a Round belongs to a Flight Segment. Open one (201, then the same Idempotency-Key replays it with 200).
    const key = newKey();
    const opened = await request(server).post("/v1/trips").set(auth).set("Idempotency-Key", key).send(openBody("identifier"));
    expect(opened.status).toBe(201);
    check("FlightSegmentEnvelope", opened.body);
    const tripId = opened.body.trip.tripId as string;
    const reopened = await request(server).post("/v1/trips").set(auth).set("Idempotency-Key", key).send(openBody("identifier"));
    expect(reopened.status).toBe(200);
    check("FlightSegmentEnvelope", reopened.body);
    expect(reopened.body.trip.tripId).toBe(tripId);

    const issued = await request(server).post("/v1/rounds").set(auth).send({ tripId });
    expect(issued.status).toBe(201);
    check("RoundEnvelope", issued.body);
    expect(issued.body.round).toMatchObject({ tripId, flightNumber: 1, module: "identifier" });
    const roundId = issued.body.round.roundId as string;

    await sql.query(
      "UPDATE rounds SET issued_at = issued_at - interval '10 seconds' WHERE id = $1",
      [roundId],
    );
    const result = { finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9, ...factsFor("identifier") };
    // The Unity outbox sends an Idempotency-Key here; it is documented as accepted and ignored.
    const banked = await request(server)
      .post(`/v1/rounds/${roundId}/result`).set(auth).set("Idempotency-Key", "outbox-r1").send(result);
    expect(banked.status).toBe(200);
    check("RoundResultResponse", banked.body);
    expect(banked.body.replayed).toBe(false);
    expect(banked.body.trip).toEqual({ tripId, roundsBanked: 1, perfectStreak: 1 });
    expect(banked.body.hintGrants).toEqual([]);
    const replay = await request(server)
      .post(`/v1/rounds/${roundId}/result`).set(auth).set("Idempotency-Key", "a-different-key").send(result);
    check("RoundResultResponse", replay.body);
    expect(replay.body.replayed).toBe(true);

    const next = await request(server).post("/v1/rounds").set(auth).send({ tripId });
    expect(next.body.round.flightNumber).toBe(2);
    const hintPath = `/v1/rounds/${next.body.round.roundId}/hint`;
    const spent = await request(server).post(hintPath).set(auth);
    expect(spent.status).toBe(200);
    check("HintResponse", spent.body);
    expect(spent.body.hint.replayed).toBe(false);
    const respent = await request(server).post(hintPath).set(auth);
    check("HintResponse", respent.body);
    expect(respent.body.hint.replayed).toBe(true);

    const poor = await request(server).post("/v1/shop/miles-hint-pack").set(auth).set("Idempotency-Key", "k1");
    expect(poor.status).toBe(409);
    check("Error", poor.body);
    expect(poor.body.error.code).toBe("insufficient_miles");
    // Arrange the balance with its ledger row, so players.miles = SUM(miles_ledger.delta) still holds.
    const principal = `firebase:demo-airplane-games:${uid}`;
    await sql.query("UPDATE players SET miles = miles + 5000 WHERE id = $1", [principal]);
    await sql.query(
      "INSERT INTO miles_ledger (player_id, delta, kind, ref, created_at) VALUES ($1, 5000, 'round_award', $2, now())",
      [principal, randomUUID()],
    );
    const bought = await request(server).post("/v1/shop/miles-hint-pack").set(auth).set("Idempotency-Key", "k1");
    expect(bought.status).toBe(200);
    check("PurchaseResponse", bought.body);
    expect(bought.body.purchase.replayed).toBe(false);
    const rebought = await request(server).post("/v1/shop/miles-hint-pack").set(auth).set("Idempotency-Key", "k1");
    check("PurchaseResponse", rebought.body);
    expect(rebought.body.purchase.replayed).toBe(true);
    const keyless = await request(server).post("/v1/shop/miles-hint-pack").set(auth);
    expect(keyless.status).toBe(400);
    check("Error", keyless.body);

    await sql.query("UPDATE players SET hints = 0 WHERE id = $1", [`firebase:demo-airplane-games:${uid}`]);
    const second = await request(server).post("/v1/rounds").set(auth).send({ tripId });
    const dry = await request(server).post(`/v1/rounds/${second.body.round.roundId}/hint`).set(auth);
    expect(dry.status).toBe(409);
    check("Error", dry.body);
    expect(dry.body.error.code).toBe("insufficient_hints");

    const rankUp = await request(server).put("/v1/me/active-rank").set(auth).send({ rank: "captain" });
    expect(rankUp.status).toBe(403);
    check("Error", rankUp.body);
    expect(rankUp.body.error.code).toBe("rank_not_certified");
    expect(rankUp.headers["x-request-id"]).toBe(rankUp.body.error.requestId);

    // Segment errors validate against Error; abandon answers FlightSegmentAbandoned (and again as a replay).
    const missing = await request(server).post(`/v1/trips/${randomUUID()}/abandon`).set(auth);
    expect(missing.status).toBe(404);
    check("Error", missing.body);
    expect(missing.body.error.code).toBe("trip_not_found");
    const badDate = await request(server).post("/v1/trips").set(auth).set("Idempotency-Key", newKey())
      .send(openBody("identifier", { localDate: "2001-01-01" }));
    expect(badDate.status).toBe(422);
    check("Error", badDate.body);
    expect(badDate.body.error.code).toBe("local_date_mismatch");
    const abandoned = await request(server).post(`/v1/trips/${tripId}/abandon`).set(auth);
    expect(abandoned.status).toBe(200);
    check("FlightSegmentAbandoned", abandoned.body);
    expect(abandoned.body).toMatchObject({ replayed: false, trip: { status: "abandoned", perfectStreak: 0 } });
    const abandonedAgain = await request(server).post(`/v1/trips/${tripId}/abandon`).set(auth);
    check("FlightSegmentAbandoned", abandonedAgain.body);
    expect(abandonedAgain.body.replayed).toBe(true);
    const gone = await request(server).post("/v1/rounds").set(auth).send({ tripId });
    expect(gone.status).toBe(410);
    check("Error", gone.body);
    expect(gone.body.error.code).toBe("trip_closed");

    const unauth = await request(server).get("/v1/me/progress");
    expect(unauth.status).toBe(401);
    check("Error", unauth.body);
    expect(unauth.headers["www-authenticate"]).toBe("Bearer");

    const unknown = await request(server).get("/v1/nope").set(auth);
    expect(unknown.status).toBe(404);
    check("Error", unknown.body);

    expect((await request(server).delete("/v1/me").set(auth)).status).toBe(204);
  });

  it("complete: the completion, its replay and trip_incomplete validate against the spec", async () => {
    const player = { Authorization: `Bearer ${emulatorToken(`uid-${randomUUID()}`)}` };
    expect((await request(server).put("/v1/me").set(player)).status).toBe(201);
    const opened = await request(server).post("/v1/trips").set(player).set("Idempotency-Key", newKey()).send(openBody("identifier"));
    expect(opened.status).toBe(201);
    const tripId = opened.body.trip.tripId as string;
    const bankOne = async () => {
      const issued = await request(server).post("/v1/rounds").set(player).send({ tripId });
      const roundId = issued.body.round.roundId as string;
      await sql.query("UPDATE rounds SET issued_at = issued_at - interval '10 seconds' WHERE id = $1", [roundId]);
      const res = await request(server)
        .post(`/v1/rounds/${roundId}/result`)
        .set(player)
        .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9, ...factsFor("identifier", { aircraftKey: "747" }) });
      expect(res.status).toBe(200);
    };
    await bankOne();
    const early = await request(server).post(`/v1/trips/${tripId}/complete`).set(player);
    expect(early.status).toBe(409);
    check("Error", early.body);
    expect(early.body.error.code).toBe("trip_incomplete");
    for (let n = 2; n <= 10; n += 1) await bankOne();

    const done = await request(server).post(`/v1/trips/${tripId}/complete`).set(player);
    expect(done.status).toBe(200);
    check("FlightSegmentCompletion", done.body);
    expect(done.body.replayed).toBe(false);
    expect(done.body.clipperCards).toMatchObject([{ key: "747", module: "identifier" }]);
    expect(done.body.fieldAwards.length).toBeGreaterThan(0);
    const replay = await request(server).post(`/v1/trips/${tripId}/complete`).set(player);
    check("FlightSegmentCompletion", replay.body);
    expect(replay.body).toEqual({ ...done.body, replayed: true });
    expect(done.headers["cache-control"]).toBe("no-store");
    rejects("FlightSegmentCompletion", { ...done.body, extra: 1 });
    rejects("FlightSegmentCompletion", { ...done.body, fieldAwards: [{ id: "made-up", earnedAt: "2026-10-29T12:00:00Z" }] });

    const fourth = await request(server).post("/v1/trips").set(player).set("Idempotency-Key", newKey()).send(openBody("identifier"));
    expect(fourth.status).toBe(201);
    check("FlightSegmentEnvelope", fourth.body);
    const gone = await request(server).post(`/v1/trips/${randomUUID()}/complete`).set(player);
    expect(gone.status).toBe(404);
    check("Error", gone.body);
    expect((await request(server).delete("/v1/me").set(player)).status).toBe(204);
  });

  it("admin routes: staff responses and errors validate against the spec", async () => {
    const staff = { Authorization: `Bearer ${emulatorToken("staff")}` };
    const module = "aircraft-identifier-military";
    await sql.query("DELETE FROM content_items");
    await sql.query("DELETE FROM content_imports");
    await sql.query("DELETE FROM admin_audit");
    const upload = (bytes: Buffer, query = "") =>
      request(server).post(`/v1/admin/content/${module}/imports${query}`).set(staff).set("Content-Type", XLSX_MIME).send(bytes);

    const me = await request(server).get("/v1/admin/me").set(staff);
    expect(me.status).toBe(200);
    check("AdminMe", me.body);
    const notStaff = await request(server).get("/v1/admin/me").set(auth);
    expect(notStaff.status).toBe(403);
    check("Error", notStaff.body);
    expect(notStaff.body.error.code).toBe("forbidden");

    const bytes = await clientSheet(6);
    const dry = await upload(bytes, "?dryRun=true");
    expect(dry.status).toBe(200);
    check("ImportDryRun", dry.body);
    const applied = await upload(bytes);
    expect(applied.status).toBe(201);
    check("ImportApplied", applied.body);
    const replayed = await upload(bytes);
    expect(replayed.status).toBe(200);
    check("ImportReplayed", replayed.body);

    const items = await request(server).get(`/v1/admin/content/${module}/items`).set(staff);
    check("ContentItemList", items.body);
    expect(items.body.items).toHaveLength(6);
    const exported = await request(server).get(`/v1/admin/content/${module}/export`).set(staff);
    expect(exported.status).toBe(200);
    expect(exported.headers["content-type"]).toContain(XLSX_MIME);

    const invalid = await upload(await clientSheet(2, (rows) => { rows[3] = ["Admiral", "A", "B", "C", "D", "x.jpg", "P"]; }));
    expect(invalid.status).toBe(422);
    check("ImportInvalid", invalid.body);
    expect(invalid.body.error.code).toBe("import_invalid");
    const garbage = await upload(Buffer.from("nope"));
    expect(garbage.status).toBe(400);
    check("Error", garbage.body);
    const unknownModule = await request(server).get("/v1/admin/content/atc-match/items").set(staff);
    expect(unknownModule.status).toBe(404);
    check("Error", unknownModule.body);
    rejects("ImportInvalid", { error: invalid.body.error });
    rejects("AdminMe", { principal: "x", staff: false });
  });

  it("request schemas accept and reject the same bodies as the server", async () => {
    const result = { finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.5, ...factsFor("atc-match") };
    const open = openBody("atc-match");
    const facts = "RoundResultWithFlightFactsRequest";
    const cases: { schema: string; body: unknown; ok: boolean }[] = [
      { schema: facts, body: result, ok: true },
      { schema: facts, body: { ...result, errorCount: 1000, attempts: 1000 }, ok: true },
      { schema: facts, body: { ...result, errorCount: 1001 }, ok: false },
      { schema: facts, body: { ...result, errorCount: 1.5 }, ok: false },
      { schema: facts, body: { ...result, timeRemainingFraction: 1.01 }, ok: false },
      { schema: facts, body: { ...result, extra: 1 }, ok: false },
      { schema: facts, body: { ...result, answerMs: 1_800_001 }, ok: false },
      { schema: facts, body: { ...result, aircraftKey: "" }, ok: false },
      { schema: facts, body: { finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.5 }, ok: false },
      { schema: "SetActiveRankRequest", body: { rank: "trainee" }, ok: true },
      { schema: "SetActiveRankRequest", body: { rank: "admiral" }, ok: false },
      { schema: "StartRoundInSegmentRequest", body: { tripId: randomUUID() }, ok: true },
      { schema: "StartRoundInSegmentRequest", body: { module: "atc-match" }, ok: false },
      { schema: "StartRoundInSegmentRequest", body: { tripId: randomUUID(), module: "atc-match" }, ok: false },
      { schema: "OpenFlightSegmentRequest", body: open, ok: true },
      { schema: "OpenFlightSegmentRequest", body: { ...open, module: "bogus" }, ok: false },
      { schema: "OpenFlightSegmentRequest", body: { ...open, flightCount: 9 }, ok: false },
      { schema: "OpenFlightSegmentRequest", body: { ...open, utcOffsetMinutes: 841 }, ok: false },
      { schema: "OpenFlightSegmentRequest", body: { ...open, utcOffsetMinutes: -721 }, ok: false },
      { schema: "OpenFlightSegmentRequest", body: { ...open, localDate: "29/10/2026" }, ok: false },
      { schema: "OpenFlightSegmentRequest", body: { ...open, rank: "captain" }, ok: false },
    ];
    const player = { Authorization: `Bearer ${emulatorToken(`uid-${randomUUID()}`)}` };
    await request(server).put("/v1/me").set(player);
    for (const { schema, body, ok } of cases) {
      const validate = ajv.compile({ $ref: `spec#/components/schemas/${schema}` });
      expect(validate(body), `${schema} ${JSON.stringify(body)}`).toBe(ok);
      const path =
        schema === facts
          ? `/v1/rounds/${randomUUID()}/result`
          : schema === "SetActiveRankRequest"
            ? "/v1/me/active-rank"
            : schema === "OpenFlightSegmentRequest"
              ? "/v1/trips"
              : "/v1/rounds";
      const method = schema === "SetActiveRankRequest" ? "put" : "post";
      const res = await request(server)[method](path).set(player).set("Idempotency-Key", newKey()).send(body as object);
      // Server-side: invalid bodies are 400; valid ones get past validation (any non-400 status).
      expect(res.status === 400, `server ${schema} ${JSON.stringify(body)} -> ${res.status}`).toBe(!ok);
    }
  });

  it("response schemas are strict: an extra field or wrong enum fails validation", () => {
    rejects("ProgressEnvelope", { progress: { nope: 1 } });
    rejects("PurchaseResponse", { purchase: { hints: 10, priceMiles: 5000 }, progress: {} });
    rejects("Error", { error: { code: "made_up", message: "x", requestId: "y" } });
  });
});

describe("openapi contract: planned schemas are coherent (not served yet)", () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  ajv.addSchema({ $id: "spec", components: spec.components });
  const valid = (schemaName: string, value: unknown) =>
    ajv.compile({ $ref: `spec#/components/schemas/${schemaName}` })(value) as boolean;

  it("planned request bodies are strict", () => {
    const open = { module: "identifier", flightCount: 10, localDate: "2026-10-29", utcOffsetMinutes: 330, contentVersion: "2026-10-28+a41ae3b7" };
    expect(valid("OpenFlightSegmentRequest", open)).toBe(true);
    expect(valid("OpenFlightSegmentRequest", { ...open, flightCount: 9 })).toBe(false);
    expect(valid("OpenFlightSegmentRequest", { ...open, utcOffsetMinutes: 841 })).toBe(false);
    expect(valid("OpenFlightSegmentRequest", { ...open, localDate: "29/10/2026" })).toBe(false);
    expect(valid("OpenFlightSegmentRequest", { ...open, rank: "captain" })).toBe(false);

    const tripId = randomUUID();
    expect(valid("StartRoundInSegmentRequest", { tripId })).toBe(true);
    expect(valid("StartRoundInSegmentRequest", { module: "identifier" })).toBe(false);
    expect(valid("StartRoundInSegmentRequest", { tripId, module: "identifier" })).toBe(false);

    const facts = { finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.8, aircraftKey: "787", answerMs: 1500, attempts: 1 };
    expect(valid("RoundResultWithFlightFactsRequest", facts)).toBe(true);
    expect(valid("RoundResultWithFlightFactsRequest", { ...facts, aircraftKey: null })).toBe(true);
    expect(valid("RoundResultWithFlightFactsRequest", { ...facts, aircraftKey: "mil-a4" })).toBe(true);
    expect(valid("RoundResultWithFlightFactsRequest", { ...facts, aircraftKey: "" })).toBe(false);
    expect(valid("RoundResultWithFlightFactsRequest", { ...facts, answerMs: -1 })).toBe(false);
    const { attempts: _attempts, ...withoutAttempts } = facts;
    expect(valid("RoundResultWithFlightFactsRequest", withoutAttempts)).toBe(false);
    expect(valid("RoundResultWithFlightFactsRequest", { ...facts, extra: 1 })).toBe(false);
  });

  it("the documented commercial key list equals the seeded Card catalog exactly", () => {
    const text: string = spec.components.schemas.RoundResultWithFlightFactsRequest.description;
    const listed = /\(U9: ([^)]*)\)/.exec(text.replace(/\s+/g, " "))?.[1]?.split(" ") ?? [];
    expect([...listed].sort()).toEqual([...SEED_COMMERCIAL_CARD_KEYS].sort());
  });

  it("the manifest keeps Unity's ManifestWire and ModuleWire fields (ApiWireModels.cs)", () => {
    const manifest = spec.components.schemas.ContentManifest;
    for (const field of ["version", "generatedAtUtc", "modules"]) expect(manifest.required).toContain(field);
    expect(Object.keys(spec.components.schemas.ManifestModule.properties).sort()).toEqual(
      ["assetBundleUrl", "contentVersion", "enabled", "id"],
    );
    const sample = {
      version: "m-3f2a9c",
      generatedAtUtc: "2026-10-29T12:00:00Z",
      modules: MODULE_IDS.map((id) => ({ id, enabled: true, contentVersion: null, assetBundleUrl: null })),
      documents: [
        { name: "field-awards", format: "field-awards.v1", version: 1, sha256: "a".repeat(64), byteSize: 9000, url: "/v1/content/documents/field-awards/1" },
      ],
    };
    expect(valid("ContentManifest", sample)).toBe(true);
    expect(valid("ContentManifest", { ...sample, modules: [{ id: "identifier", enabled: false, contentVersion: null, assetBundleUrl: null }] })).toBe(false);
  });

  it("the Field Award catalog keys the 28 Unity code ids", () => {
    const ids: string[] = spec.components.schemas.FieldAwardId.enum;
    expect(ids).toHaveLength(28);
    expect(new Set(ids).size).toBe(28);
    const award = {
      id: "first-flight", sheetId: "first-solo", sheetRow: 2, title: "First Solo", criteria: "Complete your first Trip.",
      thresholdCell: "1 Trip", target: 1, metric: "trips-completed", hidden: false, rulings: [],
    };
    const doc = {
      format: "field-awards.v1", version: 1, awards: [award],
      source: { file: "Field Awards #1.xlsx", sha256: "a41ae3b7a4d9a237c0aa4bb1919e77934484e61c511ccb641d053a7a0a76e593", importDate: "2026-10-28" },
    };
    expect(valid("FieldAwardCatalogDocument", doc)).toBe(true);
    expect(valid("FieldAwardCatalogDocument", { ...doc, awards: [{ ...award, id: "first-solo" }] })).toBe(false);
    expect(valid("FieldAwardCatalogDocument", { ...doc, awards: [{ ...award, miles: 100 }] })).toBe(false);
  });

  it("planned response samples validate", () => {
    const progress = {
      version: 3, statusPoints: 1200, miles: 300, hints: 6, certifiedRank: "trainee", activeRank: "trainee", pleasureCruise: false,
      selectableRanks: ["trainee"], nextRank: { rank: "first-officer", statusPoints: 10000 }, perfectStreak: 0, firstClassPass: false,
    };
    const trip = {
      tripId: randomUUID(), module: "aircraft-identifier-military", rank: "trainee", pleasureCruise: false, flights: 10, correct: 10,
      outcome: "all_correct", hintUsed: false, goAround: true, nightTrip: false, bestStreak: 10, miles: 900, statusPoints: 1000,
      localDate: "2026-10-29", completedAt: "2026-10-29T12:00:00Z", catalogVersion: 1,
    };
    const completion = {
      trip,
      fieldAwards: [{ id: "go-around", earnedAt: "2026-10-29T12:00:00Z" }],
      clipperCards: [{ key: "eurofighter typhoon", module: "aircraft-identifier-military", firstCollectedAt: "2026-10-29T12:00:00Z" }],
      hintGrants: [{ kind: "trip_grant", hints: 1, ref: trip.tripId }],
      replayed: false,
      progress,
    };
    expect(valid("FlightSegmentCompletion", completion)).toBe(true);
    expect(valid("FlightSegmentCompletion", { ...completion, hintGrants: [{ kind: "starter", hints: 5, ref: "x" }] })).toBe(false);
    expect(valid("ProgressEnvelope", { progress })).toBe(true);
  });
});
