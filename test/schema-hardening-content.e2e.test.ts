import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { XLSX_MIME } from "../src/content/xlsx.js";
import { MIN_ROUND_MS } from "../src/rounds/rounds.service.js";
import { clientSheet } from "./fixtures.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { seedAdmins } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";
import { factsFor, newKey, openBody } from "./trip-helpers.js";

// Migration 0027 (docs/plans/schema-hardening.md), app-level behaviour: C1 and C2 (content receipts and item creators),
// C5 (Card last_identified_at), C8 (abandoned_at), C10/C11 (completed segment and Round CHECKs) and the ledger triggers
// against the app's own account erase. The trigger and backfill proofs themselves live in migration-0027.e2e.test.ts.

const MODULE = "aircraft-identifier-military";
const IMPORTS = `/v1/admin/content/${MODULE}/imports`;
const ITEM = (id: string) => `/v1/admin/content/${MODULE}/items/${id}`;
const PREFIX = "firebase:demo-airplane-games:";
const STAFF_A = `${PREFIX}hardening-a`;
const STAFF_B = `${PREFIX}hardening-b`;
const as = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid)}` });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ["error"], bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await seedAdmins(sql, "hardening-a", "hardening-b");
});

afterAll(async () => {
  await sql.end();
  await app.close();
});

const upload = (bytes: Buffer, uid: string, query = "") =>
  request(server).post(`${IMPORTS}${query}`).set(as(uid)).set("Content-Type", XLSX_MIME).send(bytes);

const rowsOf = async <T = Record<string, any>>(query: string, params: unknown[] = []) => (await sql.query(query, params)).rows as T[];
const one = async <T = Record<string, any>>(query: string, params: unknown[] = []) => (await rowsOf<T>(query, params))[0] as T;

describe("C1 and C2: content receipts and item creators", () => {
  beforeEach(async () => {
    await sql.query("DELETE FROM content_items");
    await sql.query("DELETE FROM content_imports");
    await frozenDelete(sql, "admin_audit");
  });

  it("C1: re-importing older bytes keeps created_at and imported_by and moves last_applied_*; replay detection still works", async () => {
    const first = await clientSheet(3);
    const second = await clientSheet(4);
    const a = await upload(first, "hardening-a");
    expect(a.status).toBe(201);
    const receipt = await one("SELECT * FROM content_imports WHERE id = $1", [a.body.import.id]);
    expect(receipt.imported_by).toBe(STAFF_A);
    expect(receipt.last_applied_by).toBe(STAFF_A);
    expect(receipt.last_applied_at.getTime()).toBe(receipt.created_at.getTime()); // a new receipt: first apply is the last apply
    expect(a.body.import.createdAt).toBe(receipt.last_applied_at.toISOString());

    await sleep(20);
    expect((await upload(second, "hardening-a")).status).toBe(201);
    await sleep(20);
    const plan = await upload(first, "hardening-b", "?dryRun=true");
    expect(plan.body).toMatchObject({ replay: false, requiresConfirm: true });
    const again = await upload(first, "hardening-b", `?confirm=${plan.body.planHash}`);
    expect(again.status).toBe(201);
    expect(again.body.import.id).toBe(a.body.import.id); // the same (module, sha256) receipt

    const after = await one("SELECT * FROM content_imports WHERE id = $1", [a.body.import.id]);
    expect(after.created_at.getTime()).toBe(receipt.created_at.getTime()); // the first import's time is kept
    expect(after.imported_by).toBe(STAFF_A); // and its actor
    expect(after.last_applied_by).toBe(STAFF_B);
    expect(after.last_applied_at.getTime()).toBeGreaterThan(receipt.last_applied_at.getTime());
    expect(again.body.import.createdAt).toBe(after.last_applied_at.toISOString()); // the summary reports the last apply

    // It is the module's latest import again: identical bytes replay, and a dry run says so.
    expect((await upload(first, "hardening-b", "?dryRun=true")).body).toMatchObject({ replay: true });
    const replay = await upload(first, "hardening-a");
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    const afterReplay = await one("SELECT * FROM content_imports WHERE id = $1", [a.body.import.id]);
    expect(afterReplay.last_applied_at.getTime()).toBe(after.last_applied_at.getTime()); // a replay writes nothing
  });

  it("C2: import-created items carry created_by and created_import_id, which later imports and edits never change; the audit lists createdIds", async () => {
    const a = await upload(await clientSheet(3), "hardening-a");
    expect(a.status).toBe(201);
    const importId = a.body.import.id as string;
    const created = await rowsOf("SELECT id, created_by, created_import_id, updated_by FROM content_items ORDER BY id");
    expect(created.map((r) => r.id)).toEqual(["mil-a1", "mil-a2", "mil-a3"]);
    for (const r of created) expect(r).toMatchObject({ created_by: STAFF_A, created_import_id: importId });

    const audit = await one("SELECT detail FROM admin_audit WHERE action = 'content_import' AND (detail->>'importId') = $1", [importId]);
    expect(audit.detail.createdIds).toEqual(["mil-a1", "mil-a2", "mil-a3"]);

    // A later import by another admin: adds mil-a4 (its own receipt) and changes one answer of an existing item.
    const changed = await clientSheet(4, (rows) => { rows[3]![1] = "Changed By B"; }); // mil-a1's Correct Answer
    const changePlan = await upload(changed, "hardening-b", "?dryRun=true");
    const b = await upload(changed, "hardening-b", `?confirm=${changePlan.body.planHash}`);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.import).toMatchObject({ created: 1, updated: 1 });
    const mid = await rowsOf("SELECT id, created_by, created_import_id, updated_by FROM content_items ORDER BY id");
    expect(mid.find((r) => r.id === "mil-a1")).toMatchObject({ created_by: STAFF_A, created_import_id: importId, updated_by: STAFF_B });
    expect(mid.find((r) => r.id === "mil-a4")).toMatchObject({ created_by: STAFF_B, created_import_id: b.body.import.id });
    const auditB = await one("SELECT detail FROM admin_audit WHERE action = 'content_import' AND (detail->>'importId') = $1", [b.body.import.id]);
    expect(auditB.detail.createdIds).toEqual(["mil-a4"]);

    // An edit through the desk (a third write) leaves the creator alone too.
    const item = (await request(server).get(`/v1/admin/content/${MODULE}/items`).set(as("hardening-a"))).body.items.find((i: { id: string }) => i.id === "mil-a2");
    const edit = await request(server).patch(ITEM("mil-a2")).set(as("hardening-b")).send({ version: item.version, data: { ...item.data, answer: "Desk Edit" } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(await one("SELECT created_by, created_import_id, updated_by FROM content_items WHERE id = 'mil-a2'")).toEqual({
      created_by: STAFF_A,
      created_import_id: importId,
      updated_by: STAFF_B,
    });
  });
});

// ---- Rounds, segments, Cards (C5, C8, C10, C11) and the ledger triggers -------------------------------------------------

async function newPlayer() {
  const uid = `uid-${randomUUID()}`;
  const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
  expect((await request(server).put("/v1/me").set(auth)).status).toBe(201);
  return { auth, principal: `${PREFIX}${uid}` };
}
type Player = Awaited<ReturnType<typeof newPlayer>>;

const open = (p: Player, module: string) => request(server).post("/v1/trips").set(p.auth).set("Idempotency-Key", newKey()).send(openBody(module));
const issue = async (p: Player, tripId: string) => {
  const res = await request(server).post("/v1/rounds").set(p.auth).send({ tripId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.round.roundId as string;
};
async function bank(p: Player, tripId: string, roundId: string, module: string) {
  await sql.query("UPDATE rounds SET issued_at = issued_at - ($1::int * interval '1 millisecond') WHERE id = $2", [MIN_ROUND_MS * 2, roundId]);
  const res = await request(server)
    .post(`/v1/rounds/${roundId}/result`)
    .set(p.auth)
    .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9, ...factsFor(module) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
/** Play and complete one 10-Flight Identifier segment on the commercial family 787; returns its trip id. */
async function completeIdentifierTrip(p: Player): Promise<string> {
  const opened = await open(p, "identifier");
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const tripId = opened.body.trip.tripId as string;
  for (let i = 0; i < 10; i++) await bank(p, tripId, await issue(p, tripId), "identifier");
  const done = await request(server).post(`/v1/trips/${tripId}/complete`).set(p.auth);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return tripId;
}

describe("C5: player_clipper_cards.last_identified_at", () => {
  it("is set when the Card is first collected and moves on a later identification, while first_collected_at stays", async () => {
    const p = await newPlayer();
    const t1 = await completeIdentifierTrip(p);
    const first = await one("SELECT * FROM player_clipper_cards WHERE player_id = $1 AND card_key = '787'", [p.principal]);
    expect(first.last_identified_at).toBeInstanceOf(Date);
    expect(first.last_identified_at.getTime()).toBe(first.first_collected_at.getTime()); // inserted by the same completion
    expect(first.first_trip_id).toBe(t1);
    await sleep(20);
    await completeIdentifierTrip(p);
    const later = await one("SELECT * FROM player_clipper_cards WHERE player_id = $1 AND card_key = '787'", [p.principal]);
    expect(later.times_identified).toBeGreaterThan(first.times_identified);
    expect(later.first_collected_at.getTime()).toBe(first.first_collected_at.getTime());
    expect(later.last_identified_at.getTime()).toBeGreaterThan(first.last_identified_at.getTime());
    const t2 = await one("SELECT closed_at FROM trips WHERE player_id = $1 AND id <> $2 AND status = 'completed'", [p.principal, t1]);
    expect(later.last_identified_at.getTime()).toBe(t2.closed_at.getTime()); // the segment-completion time
  });
});

describe("C8: rounds.abandoned_at", () => {
  it("an abandoned Round gets abandoned_at, capped at its own expiry; banked Rounds never have it", async () => {
    const p = await newPlayer();
    const tripId = (await open(p, "atc-match")).body.trip.tripId as string;
    const banked = await issue(p, tripId);
    await bank(p, tripId, banked, "atc-match");
    const openRound = await issue(p, tripId);
    const before = Date.now();
    const res = await request(server).post(`/v1/trips/${tripId}/abandon`).set(p.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = await one("SELECT status, abandoned_at, expires_at FROM rounds WHERE id = $1", [openRound]);
    expect(r.status).toBe("abandoned");
    expect(r.abandoned_at).toBeInstanceOf(Date);
    expect(r.abandoned_at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(r.abandoned_at.getTime()).toBeLessThanOrEqual(r.expires_at.getTime());
    const done = await one("SELECT status, abandoned_at, completed_at FROM rounds WHERE id = $1", [banked]);
    expect(done.status).toBe("completed");
    expect(done.abandoned_at).toBeNull();
    expect(done.completed_at).toBeInstanceOf(Date);
  });

  it("abandoned_at is LEAST(now, expires_at): a Round already past its expiry records the expiry, not now", async () => {
    const p = await newPlayer();
    const tripId = (await open(p, "atc-match")).body.trip.tripId as string;
    const roundId = await issue(p, tripId);
    await sql.query("UPDATE rounds SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1", [roundId]);
    // Opening a newer segment abandons the open segment and its open Round.
    expect((await open(p, "atc-match")).status).toBe(201);
    const r = await one("SELECT status, abandoned_at, expires_at FROM rounds WHERE id = $1", [roundId]);
    expect(r.status).toBe("abandoned");
    expect(r.abandoned_at.getTime()).toBe(r.expires_at.getTime());
  });

  it("the database refuses an abandoned Round with no abandoned_at, and abandoned_at on an open one", async () => {
    const p = await newPlayer();
    const tripId = (await open(p, "atc-match")).body.trip.tripId as string;
    const roundId = await issue(p, tripId);
    await expect(sql.query("UPDATE rounds SET status = 'abandoned' WHERE id = $1", [roundId])).rejects.toMatchObject({ code: "23514", constraint: "rounds_abandoned_at_check" });
    await expect(sql.query("UPDATE rounds SET abandoned_at = now() WHERE id = $1", [roundId])).rejects.toMatchObject({ code: "23514", constraint: "rounds_abandoned_at_check" });
  });
});

describe("C10 and C11: completed segments and Rounds written by the app satisfy the new CHECKs", () => {
  it("a completed segment has every result column and each of its Rounds has completed_at and local_date", async () => {
    const p = await newPlayer();
    const tripId = await completeIdentifierTrip(p);
    const t = await one("SELECT * FROM trips WHERE id = $1", [tripId]);
    expect(t.status).toBe("completed");
    for (const column of ["correct", "hint_used", "best_streak", "miles", "status_points", "go_around", "night_trip", "completion_local_date", "catalog_version"]) {
      expect(t[column], column).not.toBeNull();
    }
    const rounds = await rowsOf("SELECT status, completed_at, local_date, abandoned_at FROM rounds WHERE trip_id = $1", [tripId]);
    expect(rounds).toHaveLength(10);
    for (const r of rounds) {
      expect(r.status).toBe("completed");
      expect(r.completed_at).toBeInstanceOf(Date);
      expect(r.local_date).not.toBeNull();
      expect(r.abandoned_at).toBeNull();
    }
  });

  it("the database refuses a completed segment missing a result column, and a completed Round missing completed_at or local_date", async () => {
    const p = await newPlayer();
    const tripId = await completeIdentifierTrip(p);
    await expect(sql.query("UPDATE trips SET catalog_version = NULL WHERE id = $1", [tripId])).rejects.toMatchObject({ code: "23514", constraint: "trips_completed_result_check" });
    await expect(sql.query("UPDATE trips SET night_trip = NULL WHERE id = $1", [tripId])).rejects.toMatchObject({ code: "23514", constraint: "trips_completed_result_check" });
    await expect(sql.query("UPDATE rounds SET completed_at = NULL WHERE trip_id = $1", [tripId])).rejects.toMatchObject({ code: "23514", constraint: "rounds_completed_at_check" });
    await expect(sql.query("UPDATE rounds SET local_date = NULL WHERE trip_id = $1", [tripId])).rejects.toMatchObject({ code: "23514", constraint: "rounds_completed_at_check" });
  });
});

describe("ledger triggers: the app's own account erase", () => {
  it("DELETE /v1/me succeeds with Miles, Hint and link-event rows present, and removes them all", async () => {
    const p = await newPlayer();
    await completeIdentifierTrip(p);
    await sql.query("INSERT INTO ugs_link_events (player_id, kind, ugs_player_id) VALUES ($1, 'linked', $2)", [p.principal, `ugs-${randomUUID()}`]);
    const has = async (table: string) => Number((await one(`SELECT COUNT(*) AS n FROM ${table} WHERE player_id = $1`, [p.principal])).n);
    expect(await has("miles_ledger")).toBeGreaterThan(0);
    expect(await has("hint_ledger")).toBeGreaterThan(0);
    expect(await has("ugs_link_events")).toBe(1);

    expect((await request(server).delete("/v1/me").set(p.auth)).status).toBe(204);
    for (const table of ["miles_ledger", "hint_ledger", "ugs_link_events", "trips", "rounds"]) expect(await has(table), table).toBe(0);
    expect(Number((await one("SELECT COUNT(*) AS n FROM players WHERE id = $1", [p.principal])).n)).toBe(0);
  });
});
