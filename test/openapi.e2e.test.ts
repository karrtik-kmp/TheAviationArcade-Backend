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
import { MODULE_IDS } from "../src/rules/modules.js";
import { RANKS } from "../src/rules/ranks.js";
import { XLSX_MIME } from "../src/content/xlsx.js";
import { mirrorSnapshot } from "../src/ugs/mirror-policy.js";
import { clientSheet } from "./fixtures.js";
import { emulatorToken } from "./tokens.js";

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

function specRoutes(): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method)) {
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

/** Every `x-error-codes` list in paths and components, plus the Error schema's enum. */
function collectErrorCodes(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectErrorCodes(item, found);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "x-error-codes") for (const code of value as string[]) found.add(code);
      else collectErrorCodes(value, found);
    }
  }
}

describe("openapi contract parity", () => {
  it("documents exactly the routes Express registers", () => {
    const registered = expressRoutes();
    // Guard against the enumeration silently finding nothing.
    expect(registered.length).toBeGreaterThan(0);
    expect(specRoutes()).toEqual(registered);
  });

  it("uses exactly the ErrorCode values, and its Error enum lists them all", () => {
    const used = new Set<string>();
    collectErrorCodes({ paths: spec.paths, responses: spec.components.responses }, used);
    expect([...used].sort()).toEqual([...ERROR_CODES].sort());
    expect([...spec.components.schemas.Error.properties.error.properties.code.enum].sort()).toEqual(
      [...ERROR_CODES].sort(),
    );
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

    const issued = await request(server).post("/v1/rounds").set(auth).send({ module: "identifier" });
    expect(issued.status).toBe(201);
    check("RoundEnvelope", issued.body);
    const roundId = issued.body.round.roundId as string;

    await sql.query(
      "UPDATE rounds SET issued_at = issued_at - interval '10 seconds' WHERE id = $1",
      [roundId],
    );
    const result = { finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9 };
    const banked = await request(server).post(`/v1/rounds/${roundId}/result`).set(auth).send(result);
    expect(banked.status).toBe(200);
    check("RoundResultResponse", banked.body);
    expect(banked.body.replayed).toBe(false);
    const replay = await request(server).post(`/v1/rounds/${roundId}/result`).set(auth).send(result);
    check("RoundResultResponse", replay.body);
    expect(replay.body.replayed).toBe(true);

    const next = await request(server).post("/v1/rounds").set(auth).send({ module: "identifier" });
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
    const second = await request(server).post("/v1/rounds").set(auth).send({ module: "identifier" });
    const dry = await request(server).post(`/v1/rounds/${second.body.round.roundId}/hint`).set(auth);
    expect(dry.status).toBe(409);
    check("Error", dry.body);
    expect(dry.body.error.code).toBe("insufficient_hints");

    const rankUp = await request(server).put("/v1/me/active-rank").set(auth).send({ rank: "captain" });
    expect(rankUp.status).toBe(403);
    check("Error", rankUp.body);
    expect(rankUp.body.error.code).toBe("rank_not_certified");
    expect(rankUp.headers["x-request-id"]).toBe(rankUp.body.error.requestId);

    const unauth = await request(server).get("/v1/me/progress");
    expect(unauth.status).toBe(401);
    check("Error", unauth.body);
    expect(unauth.headers["www-authenticate"]).toBe("Bearer");

    const unknown = await request(server).get("/v1/nope").set(auth);
    expect(unknown.status).toBe(404);
    check("Error", unknown.body);

    expect((await request(server).delete("/v1/me").set(auth)).status).toBe(204);
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
    const result = { finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.5 };
    const cases: { schema: string; body: unknown; ok: boolean }[] = [
      { schema: "RoundResultRequest", body: result, ok: true },
      { schema: "RoundResultRequest", body: { ...result, errorCount: 1000 }, ok: true },
      { schema: "RoundResultRequest", body: { ...result, errorCount: 1001 }, ok: false },
      { schema: "RoundResultRequest", body: { ...result, errorCount: 1.5 }, ok: false },
      { schema: "RoundResultRequest", body: { ...result, timeRemainingFraction: 1.01 }, ok: false },
      { schema: "RoundResultRequest", body: { ...result, extra: 1 }, ok: false },
      { schema: "SetActiveRankRequest", body: { rank: "trainee" }, ok: true },
      { schema: "SetActiveRankRequest", body: { rank: "admiral" }, ok: false },
      { schema: "StartRoundRequest", body: { module: "bogus" }, ok: false },
      { schema: "StartRoundRequest", body: { module: "atc-match", extra: true }, ok: false },
    ];
    const player = { Authorization: `Bearer ${emulatorToken(`uid-${randomUUID()}`)}` };
    await request(server).put("/v1/me").set(player);
    for (const { schema, body, ok } of cases) {
      const validate = ajv.compile({ $ref: `spec#/components/schemas/${schema}` });
      expect(validate(body), `${schema} ${JSON.stringify(body)}`).toBe(ok);
      const path =
        schema === "RoundResultRequest"
          ? `/v1/rounds/${randomUUID()}/result`
          : schema === "SetActiveRankRequest"
            ? "/v1/me/active-rank"
            : "/v1/rounds";
      const method = schema === "SetActiveRankRequest" ? "put" : "post";
      const res = await request(server)[method](path).set(player).send(body as object);
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
