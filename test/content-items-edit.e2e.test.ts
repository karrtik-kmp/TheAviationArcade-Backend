import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { XLSX_MIME, readFirstSheet } from "../src/content/xlsx.js";
import { MIN_ROUND_MS } from "../src/rounds/rounds.service.js";
import { militaryCardKey } from "../src/rules/clipper-cards.js";
import { BLOB_STORE } from "../src/storage/blob-store.js";
import type { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { clientSheet } from "./fixtures.js";
import { factsFor, newKey, openBody } from "./trip-helpers.js";
import { seedAdmins } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";

// A1: staff edit-in-place of content items (PATCH .../items/:id, POST .../retire, POST .../restore).

const MODULE = "aircraft-identifier-military";
const STAFF_PRINCIPAL = "firebase:demo-airplane-games:staff";
const BASE = `/v1/admin/content/${MODULE}`;
const staff = { Authorization: `Bearer ${emulatorToken("staff")}` };
const nonStaff = { Authorization: `Bearer ${emulatorToken("player-1")}` };

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // Admin access comes from account_roles only (Backend ADR-0002).
  await seedAdmins(sql, "staff");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

beforeEach(async () => {
  await sql.query("DELETE FROM content_items");
  await sql.query("DELETE FROM content_imports");
  await sql.query("DELETE FROM admin_audit");
  app.get<MemoryBlobStore>(BLOB_STORE).clear();
  const res = await request(server).post(`${BASE}/imports`).set(staff).set("Content-Type", XLSX_MIME).send(await clientSheet(6));
  expect(res.status).toBe(201);
});

const ITEM = (id: string) => `${BASE}/items/${id}`;
const patch = (id: string, body: unknown, headers: Record<string, string> = staff) => request(server).patch(ITEM(id)).set(headers).send(body as object);
const retire = (id: string, body: unknown = { version: 1 }, headers: Record<string, string> = staff) =>
  request(server).post(`${ITEM(id)}/retire`).set(headers).send(body as object);
const restore = (id: string, body: unknown = { version: 1 }, headers: Record<string, string> = staff) =>
  request(server).post(`${ITEM(id)}/restore`).set(headers).send(body as object);

async function row(id: string) {
  return (await sql.query("SELECT * FROM content_items WHERE module = $1 AND id = $2", [MODULE, id])).rows[0];
}
async function audits(action?: string) {
  return (await sql.query("SELECT * FROM admin_audit WHERE ($1::text IS NULL OR action = $1) AND action <> 'content_import' ORDER BY id", [action ?? null])).rows;
}
const dataOf = (id: string) => row(id).then((r) => r.data as { answer: string; wrong: string[]; sourceFile: string; photographer: string });
const with_ = async (id: string, change: Record<string, unknown>) => ({ ...(await dataOf(id)), ...change });

describe("edit routes: gate and lookups", () => {
  it("401 without a token and 403 for a non-staff caller, on all three routes", async () => {
    const routes = [
      () => request(server).patch(ITEM("mil-a1")).send({ version: 1 }),
      () => request(server).post(`${ITEM("mil-a1")}/retire`).send({ version: 1 }),
      () => request(server).post(`${ITEM("mil-a1")}/restore`).send({ version: 1 }),
    ];
    for (const call of routes) {
      const res = await call();
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
    }
    for (const res of [await patch("mil-a1", { version: 1 }, nonStaff), await retire("mil-a1", { version: 1 }, nonStaff), await restore("mil-a1", { version: 1 }, nonStaff)]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
    expect((await row("mil-a1")).version).toBe(1);
  });

  it("an unknown module mapping or unknown item id is 404 not_found, on every route", async () => {
    const other = "/v1/admin/content/atc-match/items/mil-a1";
    for (const res of [
      await request(server).patch(other).set(staff).send({ version: 1 }),
      await request(server).post(`${other}/retire`).set(staff).send({ version: 1 }),
      await request(server).post(`${other}/restore`).set(staff).send({ version: 1 }),
      await patch("mil-a99", { version: 1 }),
      await retire("mil-a99"),
      await restore("mil-a99"),
      await patch("x".repeat(200), { version: 1 }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
    expect(await audits()).toHaveLength(0);
  });

  it("the body is strict: an extra field, a missing or non-integer version, a bad rank or non-object data is 400", async () => {
    const bad: unknown[] = [
      {}, { version: 0 }, { version: 1.5 }, { version: "1" }, { version: 1, extra: true }, { version: 1, rank: "admiral" },
      { version: 1, data: "x" }, { version: 1, data: [] }, { version: 1, data: null }, { version: 1, status: "retired" }, { version: 1, id: "mil-a2" },
    ];
    for (const body of bad) {
      const res = await patch("mil-a1", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    for (const body of [{}, { version: 1, extra: 1 }, { version: -1 }]) {
      expect((await retire("mil-a1", body)).status).toBe(400);
      expect((await restore("mil-a1", body)).status).toBe(400);
    }
    expect((await row("mil-a1")).version).toBe(1);
  });
});

describe("PATCH an item", () => {
  it("applies the edit: version + 1, source admin, updated_by, a field diff in the response and one audit row", async () => {
    const before = await row("mil-a2");
    const data = await with_("mil-a2", { answer: "  Edited Answer " });
    const res = await patch("mil-a2", { version: 1, rank: "captain", data });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.item).toMatchObject({ id: "mil-a2", rank: "captain", status: "approved", source: "admin", version: 2 });
    expect(res.body.item.data.answer).toBe("Edited Answer"); // trimmed like a sheet cell
    expect(res.body.diff).toEqual([
      { field: "answer", from: "Aircraft 2", to: "Edited Answer" },
      { field: "rank", from: before.rank, to: "captain" },
    ]);
    const stored = await row("mil-a2");
    expect(stored).toMatchObject({ version: 2, source: "admin", updated_by: STAFF_PRINCIPAL, rank: "captain" });
    expect(stored.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: STAFF_PRINCIPAL, action: "content_edit", target: MODULE });
    expect(log[0].detail).toEqual({ id: "mil-a2", fromVersion: 1, version: 2, diff: res.body.diff });
    expect((await row("mil-a3")).version).toBe(1); // nothing else moved
  });

  it("rank alone and data alone both work", async () => {
    const rankOnly = await patch("mil-a1", { version: 1, rank: "chief-pilot" });
    expect(rankOnly.body.diff).toEqual([{ field: "rank", from: "trainee", to: "chief-pilot" }]);
    const dataOnly = await patch("mil-a1", { version: 2, data: await with_("mil-a1", { photographer: "New Person" }) });
    expect(dataOnly.body.item).toMatchObject({ version: 3, rank: "chief-pilot" });
    expect(dataOnly.body.diff).toEqual([{ field: "photographer", from: "Photographer 1", to: "New Person" }]);
  });

  it("a stale version is 409 version_conflict and nothing changes", async () => {
    expect((await patch("mil-a1", { version: 1, rank: "captain" })).status).toBe(200);
    const stale = await patch("mil-a1", { version: 1, rank: "trainee" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    const ahead = await patch("mil-a1", { version: 9, rank: "trainee" });
    expect(ahead.status).toBe(409);
    expect(await row("mil-a1")).toMatchObject({ version: 2, rank: "captain" });
    expect(await audits()).toHaveLength(1);
  });

  it("an unchanged edit is 200 changed:false with no bump and no audit row", async () => {
    for (const body of [{ version: 1 }, { version: 1, rank: "trainee" }, { version: 1, data: await dataOf("mil-a1"), rank: "trainee" }]) {
      const res = await patch("mil-a1", body);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ changed: false, diff: [], item: { id: "mil-a1", version: 1 } });
    }
    // Spacing the sheet would trim away is also no change.
    const padded = await with_("mil-a1", { answer: "  Aircraft 1  " });
    expect((await patch("mil-a1", { version: 1, data: padded })).body.changed).toBe(false);
    expect((await row("mil-a1")).version).toBe(1);
    expect(await audits()).toHaveLength(0);
  });

  it("an invalid payload is 422 import_invalid and nothing changes (the sheet's own rules)", async () => {
    const good = await dataOf("mil-a1");
    const cases: Record<string, unknown>[] = [
      { ...good, answer: "   " },
      { ...good, wrong: ["", "b", "c"] },
      { ...good, wrong: ["a", "b"] },
      { ...good, wrong: [good.answer.toUpperCase(), "b", "c"] },
      { ...good, extra: 1 },
      { ...good, answer: 5 },
    ];
    for (const data of cases) {
      const res = await patch("mil-a1", { version: 1, data });
      expect(res.status, JSON.stringify(data)).toBe(422);
      expect(res.body.error.code).toBe("import_invalid");
    }
    expect(await row("mil-a1")).toMatchObject({ version: 1 });
    expect(await audits()).toHaveLength(0);
  });

  it("a blank or duplicate file name is 422 import_invalid, retired items included", async () => {
    const blank = await patch("mil-a1", { version: 1, data: await with_("mil-a1", { sourceFile: "   " }) });
    expect(blank.status).toBe(422);
    expect(blank.body.error.code).toBe("import_invalid");
    const clash = await patch("mil-a1", { version: 1, data: await with_("mil-a1", { sourceFile: "MA_test_2.jpg" }) });
    expect(clash.status).toBe(422);
    expect(clash.body.error.message).toContain("mil-a2");
    expect((await retire("mil-a2")).status).toBe(200);
    const retiredClash = await patch("mil-a1", { version: 1, data: await with_("mil-a1", { sourceFile: " MA_test_2.jpg " }) });
    expect(retiredClash.status).toBe(422);
    // Renaming to a free name is fine.
    const free = await patch("mil-a1", { version: 1, data: await with_("mil-a1", { sourceFile: "MA_free.jpg" }) });
    expect(free.status).toBe(200);
    expect((await row("mil-a1")).version).toBe(2);
    expect(await audits("content_edit")).toHaveLength(1);
  });

  it("editing a retired item keeps it retired", async () => {
    expect((await retire("mil-a3")).status).toBe(200);
    const res = await patch("mil-a3", { version: 2, rank: "captain", data: await with_("mil-a3", { answer: "Edited while retired" }) });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ status: "retired", version: 3, source: "admin" });
    expect((await row("mil-a3")).status).toBe("retired");
  });

  it("the Clipper Card key is frozen: an answer edit never changes card_key", async () => {
    const before = (await row("mil-a4")).card_key;
    expect(before).toBe(militaryCardKey("Aircraft 4"));
    const res = await patch("mil-a4", { version: 1, data: await with_("mil-a4", { answer: "A Totally Different Aircraft" }) });
    expect(res.status).toBe(200);
    const after = await row("mil-a4");
    expect(after.data.answer).toBe("A Totally Different Aircraft");
    expect(after.card_key).toBe(before);
    expect((await retire("mil-a4", { version: 2 })).status).toBe(200);
    expect((await row("mil-a4")).card_key).toBe(before);
  });

  it("a Military item with no stored card_key (older than migration 0009) freezes the key of the PRE-edit answer", async () => {
    await sql.query("UPDATE content_items SET card_key = NULL WHERE module = $1 AND id = 'mil-a4'", [MODULE]);
    const res = await patch("mil-a4", { version: 1, data: await with_("mil-a4", { answer: "A Totally Different Aircraft" }) });
    expect(res.status).toBe(200);
    const after = await row("mil-a4");
    expect(after.data.answer).toBe("A Totally Different Aircraft");
    expect(after.card_key).toBe(militaryCardKey("Aircraft 4"));
    // a rank-only edit of another null-key item also freezes it, from its unchanged answer
    await sql.query("UPDATE content_items SET card_key = NULL WHERE module = $1 AND id = 'mil-a5'", [MODULE]);
    expect((await patch("mil-a5", { version: 1, rank: "captain" })).status).toBe(200);
    expect((await row("mil-a5")).card_key).toBe(militaryCardKey("Aircraft 5"));
    // an unchanged request writes nothing, so the key stays null
    await sql.query("UPDATE content_items SET card_key = NULL WHERE module = $1 AND id = 'mil-a6'", [MODULE]);
    expect((await patch("mil-a6", { version: 1 })).body.changed).toBe(false);
    expect((await row("mil-a6")).card_key).toBeNull();
  });

  it("the export and the list reflect the edit, with the new version", async () => {
    await patch("mil-a2", { version: 1, data: await with_("mil-a2", { answer: "Exported Edit" }) });
    const res = await request(server)
      .get(`${BASE}/export`)
      .set(staff)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => done(null, Buffer.concat(chunks)));
      });
    const rows = (await readFirstSheet(res.body as Buffer)) as (string | number)[][];
    const line = rows.find((r) => r[0] === "mil-a2");
    expect(line?.[1]).toBe(2);
    expect(line?.[3]).toBe("Exported Edit");
    const list = await request(server).get(`${BASE}/items`).set(staff);
    expect(list.body.items.find((i: { id: string }) => i.id === "mil-a2")).toMatchObject({ version: 2, source: "admin" });
  });
});

describe("retire and restore", () => {
  it("round-trips: retired then approved, version + 1 each, one audit row each, repeats are changed:false", async () => {
    const out = await retire("mil-a5");
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ changed: true, item: { id: "mil-a5", status: "retired", version: 2, source: "admin" } });
    expect(out.body.diff).toEqual([{ field: "status", from: "approved", to: "retired" }]);
    expect(await row("mil-a5")).toMatchObject({ status: "retired", version: 2, updated_by: STAFF_PRINCIPAL });

    const again = await retire("mil-a5", { version: 2 });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ changed: false, diff: [], item: { status: "retired", version: 2 } });

    const back = await restore("mil-a5", { version: 2 });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ changed: true, item: { status: "approved", version: 3 } });
    expect(back.body.diff).toEqual([{ field: "status", from: "retired", to: "approved" }]);

    const repeat = await restore("mil-a5", { version: 3 });
    expect(repeat.body).toMatchObject({ changed: false, item: { status: "approved", version: 3 } });

    const log = await audits();
    expect(log.map((r) => r.action)).toEqual(["content_retire", "content_restore"]);
    expect(log[0].detail).toEqual({ id: "mil-a5", fromVersion: 1, version: 2, diff: out.body.diff });
    expect(log.every((r) => r.actor === STAFF_PRINCIPAL && r.target === MODULE)).toBe(true);
  });

  it("a stale version is 409 version_conflict, also for a no-op state", async () => {
    expect((await retire("mil-a5")).status).toBe(200);
    for (const res of [await retire("mil-a5", { version: 1 }), await restore("mil-a5", { version: 1 }), await restore("mil-a5", { version: 7 })]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("version_conflict");
    }
    expect(await row("mil-a5")).toMatchObject({ status: "retired", version: 2 });
    expect(await audits()).toHaveLength(1);
  });

  it("a retired item no longer counts in Trip coverage, and counts again once restored", async () => {
    const coverage = async () =>
      (await request(server).post(`${BASE}/trip-coverage`).set(staff).send({ itemIds: ["mil-a1"] })).body.ranks.find((r: { rank: string }) => r.rank === "trainee").dealable;
    const before = await coverage();
    expect(before).toBeGreaterThan(0);
    await retire("mil-a1");
    expect(await coverage()).toBe(before - 1);
    await restore("mil-a1", { version: 2 });
    expect(await coverage()).toBe(before);
  });
});

describe("re-uploading the client sheet after a staff change", () => {
  const upload = (bytes: Buffer, query = "") => request(server).post(`${BASE}/imports${query}`).set(staff).set("Content-Type", XLSX_MIME).send(bytes);

  it("with no staff change the identical sheet is still a replay (dry run and apply)", async () => {
    const bytes = await clientSheet(6);
    const dry = await upload(bytes, "?dryRun=true");
    expect(dry.body).toMatchObject({ dryRun: true, replay: true });
    const res = await upload(bytes);
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
  });

  it("the real lazy card_key freeze (a Round on a Military item with no key) is not an edit: updated_at stays and the sheet still replays", async () => {
    const bytes = await clientSheet(6);
    // A row older than migration 0009: no frozen key. Set directly, leaving updated_at alone.
    await sql.query("UPDATE content_items SET card_key = NULL WHERE module = $1 AND id = 'mil-a1'", [MODULE]);
    const before = await row("mil-a1");
    expect(before.card_key).toBeNull();

    const uid = `uid-${randomUUID()}`;
    const player = { Authorization: `Bearer ${emulatorToken(uid)}` };
    expect((await request(server).put("/v1/me").set(player)).status).toBe(201);
    const trip = await request(server).post("/v1/trips").set(player).set("Idempotency-Key", newKey()).send(openBody(MODULE));
    expect(trip.status, JSON.stringify(trip.body)).toBe(201);
    const issued = await request(server).post("/v1/rounds").set(player).send({ tripId: trip.body.trip.tripId });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const roundId = issued.body.round.roundId as string;
    await sql.query("UPDATE rounds SET issued_at = issued_at - ($1::int * interval '1 millisecond') WHERE id = $2", [MIN_ROUND_MS * 2, roundId]);
    const banked = await request(server)
      .post(`/v1/rounds/${roundId}/result`)
      .set(player)
      .send({ finished: true, errorCount: 0, usedHint: false, timeRemainingFraction: 0.9, ...factsFor(MODULE, { aircraftKey: "mil-a1" }) });
    expect(banked.status, JSON.stringify(banked.body)).toBe(200);

    const after = await row("mil-a1");
    expect(after.card_key).toBe(militaryCardKey(String(before.data.answer))); // the freeze really ran
    expect(after.updated_at).toEqual(before.updated_at);
    expect(after.version).toBe(before.version);
    expect((await upload(bytes)).body.replayed).toBe(true);
  });

  it("an edit stamped by the database clock still ends the replay when the process clock is a day behind", async () => {
    const bytes = await clientSheet(6);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 24 * 3_600_000 });
    try {
      const original = await dataOf("mil-a2");
      // The staff token is minted on the same (faked) clock, so the request is accepted as of a day ago.
      const dayAgo = { Authorization: `Bearer ${emulatorToken("staff")}` };
      expect((await patch("mil-a2", { version: 1, data: { ...original, answer: "Staff Wording" } }, dayAgo)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    const edited = await row("mil-a2");
    const receipt = (await sql.query("SELECT created_at FROM content_imports WHERE module = $1", [MODULE])).rows[0];
    expect(edited.updated_at.getTime()).toBeGreaterThanOrEqual(receipt.created_at.getTime()); // not a day earlier
    const dry = await upload(bytes, "?dryRun=true");
    expect(dry.body.replay).toBe(false);
  });

  it("a staff restore also counts: the same sheet is planned afterwards, not replayed", async () => {
    const bytes = await clientSheet(6);
    expect((await retire("mil-a3")).status).toBe(200);
    expect((await restore("mil-a3", { version: 2 })).status).toBe(200);
    const dry = await upload(bytes, "?dryRun=true");
    expect(dry.body.replay).toBe(false);
    const res = await upload(bytes, dry.body.requiresConfirm ? `?confirm=${dry.body.planHash}` : "");
    expect(res.status).toBe(201);
    expect(res.body.replayed).toBe(false);
    expect(await row("mil-a3")).toMatchObject({ status: "approved", version: 3 });
  });

  it("a retired item comes back to approved when the same sheet is uploaded again (confirm flow)", async () => {
    const bytes = await clientSheet(6);
    expect((await retire("mil-a3")).status).toBe(200);
    const dry = await upload(bytes, "?dryRun=true");
    expect(dry.status).toBe(200);
    expect(dry.body.replay).toBe(false);
    expect(dry.body.requiresConfirm).toBe(true);
    expect(dry.body.rows.find((r: { id: string }) => r.id === "mil-a3")).toMatchObject({ action: "update" });
    expect((await upload(bytes)).status).toBe(422);
    const res = await upload(bytes, `?confirm=${dry.body.planHash}`);
    expect(res.status).toBe(201);
    expect(res.body.replayed).toBe(false);
    expect(await row("mil-a3")).toMatchObject({ status: "approved", version: 3, source: "client_sheet" });
    expect((await upload(bytes)).body.replayed).toBe(true); // nothing changed since: a replay again
  });

  it("an edited item is restored to the client's data when the same sheet is uploaded again", async () => {
    const bytes = await clientSheet(6);
    const original = await dataOf("mil-a2");
    expect((await patch("mil-a2", { version: 1, data: { ...original, answer: "Staff Wording" } })).status).toBe(200);
    const dry = await upload(bytes, "?dryRun=true");
    expect(dry.body.replay).toBe(false);
    expect(dry.body.requiresConfirm).toBe(true);
    const res = await upload(bytes, `?confirm=${dry.body.planHash}`);
    expect(res.status).toBe(201);
    expect(await dataOf("mil-a2")).toEqual(original);
    expect(await row("mil-a2")).toMatchObject({ version: 3, source: "client_sheet" });
  });
});

describe("concurrency and the module lock", () => {
  it("two edits with the same version: exactly one wins, the other is a 409 and nothing is applied twice", async () => {
    const [a, b] = await Promise.all([
      patch("mil-a1", { version: 1, rank: "captain" }),
      patch("mil-a1", { version: 1, rank: "check-airman" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(["version_conflict", "import_in_progress"]).toContain(loser.body.error.code);
    expect((await row("mil-a1")).version).toBe(2);
    expect(await audits("content_edit")).toHaveLength(1);
  });

  it("many concurrent retire/edit calls with one version still produce exactly one winner", async () => {
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => retire("mil-a2")),
      ...Array.from({ length: 4 }, () => patch("mil-a2", { version: 1, rank: "captain" })),
    ]);
    expect(results.filter((r) => r.status === 200 && r.body.changed === true)).toHaveLength(1);
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect((await row("mil-a2")).version).toBe(2);
  });

  it("an edit while the module lock is held (an import applying) is 409 import_in_progress with Retry-After, then works", async () => {
    const holder = await sql.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`content-import:${MODULE}`]);
      for (const res of [await patch("mil-a1", { version: 1, rank: "captain" }), await retire("mil-a1")]) {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("import_in_progress");
        expect(res.headers["retry-after"]).toBe("2");
      }
      expect((await row("mil-a1")).version).toBe(1);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect((await patch("mil-a1", { version: 1, rank: "captain" })).status).toBe(200);
  });

  it("an import after an edit plans against the edited row", async () => {
    await patch("mil-a1", { version: 1, rank: "captain" });
    // A different sheet from the first import (so it is not a replay): row 6 gets a new photographer.
    const sheet = await clientSheet(6, (rows) => { rows[8]![6] = "Someone Else"; });
    const dry = await request(server).post(`${BASE}/imports?dryRun=true`).set(staff).set("Content-Type", XLSX_MIME).send(sheet);
    expect(dry.status).toBe(200);
    expect(dry.body.counts.updated).toBe(2); // mil-a1: the sheet says Trainee, the edit made it Captain; mil-a6: the photographer
    expect(dry.body.rows.find((r: { id: string }) => r.id === "mil-a1").diff).toEqual([{ field: "rank", from: "captain", to: "trainee" }]);
  });
});
