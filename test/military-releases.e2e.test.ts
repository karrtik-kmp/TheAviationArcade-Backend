import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { releaseBasis } from "../src/content/releases/release-rules.js";
import { BLANK_EVIDENCE } from "../src/content/preparation/military-preparation.js";
import type { PrepEvidence } from "../src/content/preparation/military-preparation.js";
import { XLSX_MIME } from "../src/content/xlsx.js";
import { Fixtures, boot } from "./editorial-helpers.js";
import type { Booted, PublishedMedia } from "./editorial-helpers.js";
import { clientSheet } from "./fixtures.js";

// Wave W3, commit 2 (docs/plans/website-content.md 3.2 to 3.4): Military releases. RECORDED, NOT DELIVERED. Photos are built through
// the real media routes; the preparation of most items is seeded with SQL (the real route is covered by military-preparation.e2e and
// once here), so each test starts from twelve approved, current packages in a few milliseconds.

const MODULE = "aircraft-identifier-military";
const BASE = `/v1/admin/content/${MODULE}`;
const ITEMS = 12;
const LOCK_RELEASE = `content-release:${MODULE}`;
const LOCK_MODULE = `content-import:${MODULE}`;

let app: Booted;
let demoApp: Booted; // the same database, but fx.owner is "the shared demo account"
let sql: pg.Pool;
let fx: Fixtures;
let pool: PublishedMedia[] = []; // pool[i] is the photo of mil-a<i+1>

const admin = () => fx.admin.auth as Record<string, string>;
const id = (n: number) => `mil-a${n}`;
const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => id(from + i));
const evidenceOf = (over: Partial<PrepEvidence> = {}): PrepEvidence => ({
  ...BLANK_EVIDENCE,
  photoSource: "media",
  permission: "Client supplied under licence",
  attribution: "A. Pilot",
  referenceUrl: "https://example.com/ref",
  checklist: { identity: true, answers: true, crop: true, clipperCard: true },
  ...over,
});

const get = (path: string, b: Booted = app, headers: Record<string, string> = admin()) => request(b.server).get(`${BASE}${path}`).set(headers);
const post = (path: string, body: unknown, b: Booted = app, headers: Record<string, string> = admin()) => request(b.server).post(`${BASE}${path}`).set(headers).send(body as object);
const items = async () => ((await get("/items")).body.items as { id: string; version: number; status: string }[]);
const basisOf = async (selection: string[]) => releaseBasis((await items()).filter((i) => selection.includes(i.id)));
/** Upload `selection` with the current basis (override any field). */
const upload = async (selection: string[] = ids(ITEMS), over: Record<string, unknown> = {}, b: Booted = app) =>
  post("/releases", { itemIds: selection, basis: await basisOf(selection), previewed: true, ...over }, b);
const activate = (version: number, pointerVersion: number, extra: Record<string, unknown> = {}, b: Booted = app) =>
  post(`/releases/${version}/activate`, { expectedPointerVersion: pointerVersion, ...extra }, b);
const restore = (pointerVersion: number, extra: Record<string, unknown> = {}, b: Booted = app) => post("/releases/restore", { expectedPointerVersion: pointerVersion, ...extra }, b);
const state = async () => (await get("/releases")).body as { pointer: { current: number | null; history: number[]; version: number }; releases: { number: number; status: string; basis: string; aircraft: number; note: string | null; createdAt: string }[]; ownRankCounts: Record<string, number> };

const one = async (text: string, params: unknown[] = []) => (await sql.query(text, params)).rows[0];
const count = async (table: string) => Number((await one(`SELECT count(*)::int AS n FROM ${table}`)).n);
const audits = async (action: string) => (await sql.query("SELECT actor, action, target, detail FROM admin_audit WHERE action = $1 AND target = $2 ORDER BY id", [action, MODULE])).rows as { actor: string; action: string; target: string; detail: Record<string, unknown> }[];
const row = async (itemId: string) => one("SELECT * FROM content_items WHERE module = $1 AND id = $2", [MODULE, itemId]);

/** Approve every item through SQL: stage approved, current (prep_version = version), linked to its pool photo. */
async function approveAll(count = ITEMS): Promise<void> {
  for (let n = 1; n <= count; n++) {
    await sql.query("UPDATE content_items SET prep_stage = 'approved', prep_evidence = $3::jsonb, prep_version = version, media_id = $4 WHERE module = $1 AND id = $2", [
      MODULE,
      id(n),
      JSON.stringify(evidenceOf()),
      pool[n - 1]!.id.slice(4),
    ]);
  }
}

/** Remove every release row. The three tables refuse UPDATE and DELETE, so a test's cleanup disables the triggers itself. */
async function wipeReleases(): Promise<void> {
  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE content_release_activations DISABLE TRIGGER content_release_activations_immutable");
    await client.query("ALTER TABLE content_release_items DISABLE TRIGGER content_release_items_immutable");
    await client.query("ALTER TABLE content_releases DISABLE TRIGGER content_releases_immutable");
    await client.query("DELETE FROM content_release_activations");
    await client.query("DELETE FROM content_release_items");
    await client.query("DELETE FROM content_releases");
    await client.query("ALTER TABLE content_release_activations ENABLE TRIGGER content_release_activations_immutable");
    await client.query("ALTER TABLE content_release_items ENABLE TRIGGER content_release_items_immutable");
    await client.query("ALTER TABLE content_releases ENABLE TRIGGER content_releases_immutable");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Hold a session advisory lock (the same key the server try-locks) from another connection. Returns the release function. */
async function holdLock(key: string): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
  return async () => {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    await client.end();
  };
}

const tainted = new Set<number>();
async function healPool(): Promise<void> {
  for (const index of tainted) pool[index] = await fx.publishedMedia();
  tainted.clear();
}

async function reimport(sheetRows = ITEMS, edit?: Parameters<typeof clientSheet>[1]) {
  await sql.query("DELETE FROM content_items");
  await sql.query("DELETE FROM content_imports");
  const res = await request(app.server).post(`${BASE}/imports`).set(admin()).set("Content-Type", XLSX_MIME).send(await clientSheet(sheetRows, edit));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  app = await boot();
  fx = new Fixtures(sql, () => app.server);
  await fx.init();
  demoApp = await boot({ demoPrincipal: fx.owner.principal });
  for (let n = 0; n < ITEMS; n++) pool.push(await fx.publishedMedia(`Credit ${n + 1}`));
});

afterAll(async () => {
  await wipeReleases();
  await sql.query("DELETE FROM content_items");
  await fx.cleanup();
  await app.app.close();
  await demoApp.app.close();
  await sql.end();
});

beforeEach(async () => {
  await wipeReleases();
  await sql.query("DELETE FROM admin_audit WHERE target = $1 AND action LIKE 'release_%'", [MODULE]);
  await reimport();
  await approveAll();
});

afterEach(healPool);

describe("gate and shape", () => {
  it("401 without a token; 403 for a player and for a photographer, on all four routes", async () => {
    const calls = [
      (h?: Record<string, string>) => (h ? get("/releases", app, h) : request(app.server).get(`${BASE}/releases`)),
      (h?: Record<string, string>) => (h ? post("/releases", { itemIds: ["mil-a1"], basis: "x", previewed: true }, app, h) : request(app.server).post(`${BASE}/releases`).send({})),
      (h?: Record<string, string>) => (h ? post("/releases/1/activate", { expectedPointerVersion: 0 }, app, h) : request(app.server).post(`${BASE}/releases/1/activate`).send({})),
      (h?: Record<string, string>) => (h ? post("/releases/restore", { expectedPointerVersion: 0 }, app, h) : request(app.server).post(`${BASE}/releases/restore`).send({})),
    ];
    for (const call of calls) {
      expect((await call()).status).toBe(401);
      expect((await call(fx.player.auth as Record<string, string>)).status).toBe(403);
      expect((await call(fx.owner.auth as Record<string, string>)).status).toBe(403);
    }
    expect(await count("content_releases")).toBe(0);
  });

  it("any other module and an unknown module are 404 on all four routes", async () => {
    for (const module of ["airport-spotter", "atc-match", "identifier", "no-such-module"]) {
      const prefix = `/v1/admin/content/${module}`;
      const sent = [
        await request(app.server).get(`${prefix}/releases`).set(admin()),
        await request(app.server).post(`${prefix}/releases`).set(admin()).send({ itemIds: ["a"], basis: "a:1", previewed: true }),
        await request(app.server).post(`${prefix}/releases/1/activate`).set(admin()).send({ expectedPointerVersion: 0 }),
        await request(app.server).post(`${prefix}/releases/restore`).set(admin()).send({ expectedPointerVersion: 0 }),
      ];
      for (const res of sent) {
        expect(res.status, module).toBe(404);
        expect(res.body.error.code).toBe("not_found");
      }
    }
    expect(await count("content_releases")).toBe(0);
  });

  it("an unknown or malformed release number is 404 and writes nothing", async () => {
    for (const version of ["1", "99", "0", "01", "x", "1e3"]) {
      const res = await activate(version as unknown as number, 0);
      expect(res.status, version).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
    expect(await count("content_release_activations")).toBe(0);
  });

  it("bodies are strict: extra keys, empty or oversized lists, a missing flag and bad pointer versions are 400", async () => {
    const good = { itemIds: ["mil-a1"], basis: "mil-a1:1", previewed: true };
    const bad: unknown[] = [
      {},
      { ...good, extra: 1 },
      { ...good, itemIds: [] },
      // (2001 ids is refused by the schema, see release-rules.test.ts; as a request it is already over the 16 KB JSON limit, a 413)
      { itemIds: good.itemIds, basis: good.basis },
      { ...good, basis: "" },
      { ...good, note: "x".repeat(501) },
      { ...good, itemIds: ["mil-a1", 5] },
    ];
    for (const body of bad) {
      const res = await post("/releases", body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    for (const body of [{}, { expectedPointerVersion: -1 }, { expectedPointerVersion: 1.5 }, { expectedPointerVersion: "0" }, { expectedPointerVersion: 0, release: 1 }]) {
      expect((await post("/releases/1/activate", body)).status).toBe(400);
      expect((await post("/releases/restore", body)).status).toBe(400);
    }
    expect(await count("content_releases")).toBe(0);
  });
});

describe("upload: an uploaded release is recorded, not live", () => {
  it("freezes the chosen items, returns an uploaded summary, writes one audit row and leaves the pointer and the items alone", async () => {
    const before = await items();
    const res = await upload(ids(ITEMS), { note: "  First batch " });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ number: 1, aircraft: ITEMS, note: "First batch", status: "uploaded", basis: releaseBasis(before) });
    expect(typeof res.body.createdAt).toBe("string");

    const rows = (await sql.query("SELECT * FROM content_release_items WHERE module = $1 AND release_version = 1 ORDER BY position", [MODULE])).rows;
    expect(rows).toHaveLength(ITEMS);
    expect(rows.map((r) => r.item_id)).toEqual(ids(ITEMS)); // natural id order (mil-a10 after mil-a9), positions 1..n
    expect(rows.map((r) => r.position)).toEqual(Array.from({ length: ITEMS }, (_, i) => i + 1));
    const first = rows[0]!;
    expect(first).toMatchObject({ item_id: "mil-a1", item_version: 1, rank: "trainee", media_id: pool[0]!.id.slice(4), media_version: 1, photo_sha256: pool[0]!.sha256, credit: "Credit 1" });
    expect(first.deal).toEqual({ answer: "Aircraft 1", wrong: ["Wrong 1a", "Wrong 1b", "Wrong 1c"] });
    expect(first.card_key).toBeTruthy();

    expect((await state()).pointer).toEqual({ current: null, history: [], version: 0 }); // not live
    expect(await count("content_release_activations")).toBe(0);
    expect((await items()).map((i) => [i.id, i.version])).toEqual(before.map((i) => [i.id, i.version])); // no item rewritten
    const log = await audits("release_create");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: fx.admin.principal, target: MODULE });
    expect(log[0]!.detail).toEqual({ release: 1, itemCount: ITEMS, basis: releaseBasis(before) });
    expect(await audits("release_activate")).toHaveLength(0);
  });

  it("the whole flow through the REAL preparation route: approve every item, upload, activate", async () => {
    await reimport(); // never prepared, no media
    for (let n = 1; n <= ITEMS; n++) {
      const stages: [string, Partial<PrepEvidence>][] = [
        ["rights_checked", { referenceUrl: "", checklist: { identity: false, answers: false, crop: false, clipperCard: false } }],
        ["content_prepared", { checklist: { identity: false, answers: false, crop: false, clipperCard: false } }],
        ["previewed", { checklist: { identity: false, answers: false, crop: true, clipperCard: false } }],
        ["approved", {}],
      ];
      for (const [stage, over] of stages) {
        const version = (await items()).find((i) => i.id === id(n))!.version;
        const res = await request(app.server).put(`${BASE}/items/${id(n)}/preparation`).set(admin()).send({ version, stage, evidence: evidenceOf(over), mediaId: pool[n - 1]!.id });
        expect(res.status, `${id(n)} ${stage}: ${JSON.stringify(res.body)}`).toBe(200);
      }
    }
    const up = await upload();
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.status).toBe("uploaded");
    const live = await activate(1, 0);
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(live.body.pointer).toEqual({ current: 1, history: [], version: 1 });
  });

  it("freezes a missing Card key into the release row only: the item is not rewritten and its version does not move", async () => {
    await sql.query("UPDATE content_items SET card_key = NULL WHERE module = $1 AND id = 'mil-a1'", [MODULE]);
    const before = await row("mil-a1");
    expect(before.card_key).toBeNull();
    const res = await upload();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const frozen = await one("SELECT card_key FROM content_release_items WHERE module = $1 AND release_version = 1 AND item_id = 'mil-a1'", [MODULE]);
    expect(frozen.card_key).toBeTruthy();
    const after = await row("mil-a1");
    expect(after.card_key).toBeNull();
    expect(after.version).toBe(before.version);
    expect(after.updated_at).toEqual(before.updated_at);
    expect(res.body.basis).toBe(await basisOf(ids(ITEMS))); // the basis still matches: nothing was bumped
  });

  it("an item the item already keyed keeps that key in the release", async () => {
    await sql.query("UPDATE content_items SET card_key = 'kept-key' WHERE module = $1 AND id = 'mil-a2'", [MODULE]);
    expect((await upload()).status).toBe(201);
    expect((await one("SELECT card_key FROM content_release_items WHERE item_id = 'mil-a2'")).card_key).toBe("kept-key");
  });

  it("staff choose the items: leaving one out is a choice, not a retire", async () => {
    const res = await upload(ids(ITEMS - 1));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.aircraft).toBe(ITEMS - 1);
    expect(await count("content_release_items")).toBe(ITEMS - 1);
    const left = await row(id(ITEMS));
    expect(left).toMatchObject({ status: "approved", version: 1, prep_stage: "approved" });
  });

  it("the selection order does not matter: positions follow the natural id order", async () => {
    const shuffled = [...ids(ITEMS)].reverse();
    const res = await post("/releases", { itemIds: shuffled, basis: await basisOf(shuffled), previewed: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const rows = (await sql.query("SELECT item_id FROM content_release_items ORDER BY position")).rows;
    expect(rows.map((r) => r.item_id)).toEqual(ids(ITEMS));
  });

  it("a basis that is not the server's basis over the selection is 409 version_conflict and writes nothing", async () => {
    const stale = await upload(ids(ITEMS), { basis: "mil-a1:1" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect(stale.body.error.message).toContain("Packages changed since this preview");
    // a changed item changes the basis the caller previewed
    const basis = await basisOf(ids(ITEMS));
    const edit = await request(app.server).patch(`${BASE}/items/mil-a3`).set(admin()).send({ version: 1, data: { answer: "Aircraft 3 Edited", wrong: ["Wrong 3a", "Wrong 3b", "Wrong 3c"], sourceFile: "MA_test_3.jpg", photographer: "Photographer 3" } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect((await post("/releases", { itemIds: ids(ITEMS), basis, previewed: true })).status).toBe(409);
    expect(await count("content_releases")).toBe(0);
    expect(await audits("release_create")).toHaveLength(0);
  });

  it("previewed other than true is 422", async () => {
    const res = await upload(ids(ITEMS), { previewed: false });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("content_invalid");
    expect(res.body.error.message).toContain("Review the sample Trips");
    expect(await count("content_releases")).toBe(0);
  });

  it("an unknown id is 422 unknown_item_ids; a repeated id and a retired item are 422 content_invalid with errors", async () => {
    const unknown = await post("/releases", { itemIds: [...ids(ITEMS), "mil-a99"], basis: "x", previewed: true });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("unknown_item_ids");
    const repeated = await post("/releases", { itemIds: [...ids(ITEMS), "mil-a1"], basis: "x", previewed: true });
    expect(repeated.status).toBe(422);
    expect(repeated.body.error.code).toBe("content_invalid");
    expect(repeated.body.errors).toEqual(["Each item may be chosen once: mil-a1 repeated."]);
    await request(app.server).post(`${BASE}/items/mil-a2/retire`).set(admin()).send({ version: 1 });
    const retired = await upload(ids(ITEMS));
    expect(retired.status).toBe(422);
    expect(retired.body.errors).toEqual(["mil-a2: the item is retired. Restore it or leave it out."]);
    expect(await count("content_releases")).toBe(0);
  });

  it("every item must be approved: a package below approved is refused with its stage", async () => {
    await sql.query("UPDATE content_items SET prep_stage = 'previewed' WHERE module = $1 AND id = 'mil-a4'", [MODULE]);
    await sql.query("UPDATE content_items SET prep_stage = NULL, prep_evidence = NULL, prep_version = NULL WHERE module = $1 AND id = 'mil-a5'", [MODULE]);
    const res = await upload();
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("content_invalid");
    expect(res.body.errors).toContain("mil-a4: the package is not approved (it is at previewed).");
    expect(res.body.errors).toContain("mil-a5: the package is not approved (it is at no stage).");
    expect(res.body.errors).toHaveLength(2);
    expect(await count("content_releases")).toBe(0);
  });

  it("a STALE approved package is refused (version moved past prep_version) and no longer counts as approved", async () => {
    const edit = await request(app.server).patch(`${BASE}/items/mil-a6`).set(admin()).send({ version: 1, data: { answer: "Aircraft 6 Edited", wrong: ["Wrong 6a", "Wrong 6b", "Wrong 6c"], sourceFile: "MA_test_6.jpg", photographer: "Photographer 6" } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const res = await upload();
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(["mil-a6: the package changed after approval. Step it back to Previewed and approve it again."]);
    expect((await state()).ownRankCounts).toEqual({ trainee: 2, "first-officer": 3, captain: 2, "check-airman": 2, "chief-pilot": 2 }); // mil-a6 is a Trainee question
  });

  it("a licensed photograph without a linked backend photo is refused (a release needs a stored photo whatever the photo source)", async () => {
    // mil-a7 is approved with photoSource licensed and no linked photo.
    await sql.query("UPDATE content_items SET media_id = NULL, prep_evidence = $3::jsonb WHERE module = $1 AND id = $2", [
      MODULE,
      "mil-a7",
      JSON.stringify(evidenceOf({ photoSource: "licensed", licenseUrl: "https://example.com/licence" })),
    ]);
    const res = await upload();
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(["mil-a7: link a published photo. A release needs a stored photograph for every item."]);
  });

  it("the photo must be published: an unpublished, a withdrawn and a missing photo are each refused", async () => {
    const draft = await fx.upload();
    await sql.query("UPDATE content_items SET media_id = $2 WHERE module = $1 AND id = 'mil-a1'", [MODULE, draft.id.slice(4)]);
    const gone = pool[1]!;
    await fx.withdraw(gone.id, gone.revision);
    tainted.add(1);
    const res = await upload();
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([`mil-a1: the linked photo ${draft.id} is not published.`, `mil-a2: the linked photo ${gone.id} is not published.`]);
    expect(await count("content_releases")).toBe(0);
  });

  it("a demo-owned photo is refused (defence in depth: the demo account cannot link one through the desk)", async () => {
    const res = await upload(ids(ITEMS), {}, demoApp); // fx.owner owns every pool photo and is the demo account in demoApp
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveLength(ITEMS);
    expect(res.body.errors[0]).toBe(`mil-a1: the linked photo ${pool[0]!.id} belongs to the shared demo account and cannot be used.`);
    expect(await count("content_releases")).toBe(0);
  });

  it("no two items may share a photo file (photo_sha256)", async () => {
    await sql.query("UPDATE content_items SET media_id = $2 WHERE module = $1 AND id = 'mil-a8'", [MODULE, pool[0]!.id.slice(4)]);
    const res = await upload();
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(["mil-a8: uses the same photograph as mil-a1."]);
  });

  it("coverage: a Trip must be fillable at every rank, and every shortage is listed", async () => {
    const res = await upload(ids(4));
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(["trainee", "first-officer", "captain", "check-airman", "chief-pilot"].map((rank) => `${rank}: a Trip would hold 4 of 10 Flights; add more approved questions.`));
    expect(await count("content_releases")).toBe(0);
  });

  it("ASSUMPTION: Military release coverage uses nearest-ranks (C13 open)", async () => {
    // Ten questions, all Chief Pilot. The backend dealer is nearest-ranks, so a Trainee Trip is dealt from them and the release goes
    // through; the website's lower-ranks rule would refuse it. ownRankCounts still shows the own-rank shortage, without blocking.
    await reimport(10, (rows) => {
      for (let i = 3; i < 13; i++) rows[i]![0] = "Chief Pilot";
    });
    await approveAll(10);
    const res = await upload(ids(10));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await state()).ownRankCounts).toEqual({ trainee: 0, "first-officer": 0, captain: 0, "check-airman": 0, "chief-pilot": 10 });
  });

  it("the same basis as the CURRENT release is 409 nothing_to_publish; the same basis as an OLDER release is allowed", async () => {
    expect((await upload(ids(ITEMS))).status).toBe(201); // release 1: all 12
    expect((await activate(1, 0)).status).toBe(200);
    const same = await upload(ids(ITEMS));
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe("nothing_to_publish");
    expect(await count("content_releases")).toBe(1);

    expect((await upload(ids(ITEMS - 1))).status).toBe(201); // release 2: eleven
    expect((await activate(2, 1)).status).toBe(200);
    const older = await upload(ids(ITEMS)); // the basis of release 1, which is no longer current
    expect(older.status, JSON.stringify(older.body)).toBe(201);
    expect(older.body.number).toBe(3);
    const nothing = await upload(ids(ITEMS - 1)); // the basis of the current release 2
    expect(nothing.status).toBe(409);
    expect(await count("content_releases")).toBe(3);
  });

  it("release numbers go up by one and a refused upload does not use one", async () => {
    expect((await upload()).body.number).toBe(1);
    expect((await upload(ids(ITEMS), { previewed: false })).status).toBe(422);
    expect((await upload(ids(ITEMS - 1))).body.number).toBe(2);
  });

  it("a busy release lock is 409 release_in_progress (Retry-After), a busy module lock is 409 import_in_progress; nothing is written", async () => {
    const releaseLock = await holdLock(LOCK_RELEASE);
    try {
      const up = await upload();
      expect(up.status).toBe(409);
      expect(up.body.error.code).toBe("release_in_progress");
      expect(up.headers["retry-after"]).toBe("2");
      expect((await activate(1, 0)).body.error.code).toBe("release_in_progress");
      expect((await restore(0)).body.error.code).toBe("release_in_progress");
    } finally {
      await releaseLock();
    }
    const moduleLock = await holdLock(LOCK_MODULE);
    try {
      const up = await upload();
      expect(up.status).toBe(409);
      expect(up.body.error.code).toBe("import_in_progress");
      expect((await activate(1, 0)).body.error.code).toBe("import_in_progress");
    } finally {
      await moduleLock();
    }
    expect(await count("content_releases")).toBe(0);
    expect((await upload()).status).toBe(201); // the locks are gone with their holders
  });
});

describe("activate, restore and the pointer", () => {
  it("activating makes the release current (pointer version 1), marks it released and writes one audit row", async () => {
    expect((await upload()).status).toBe(201);
    const res = await activate(1, 0, { note: "go" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.pointer).toEqual({ current: 1, history: [], version: 1 });
    expect(res.body.releases).toHaveLength(1);
    expect(res.body.releases[0]).toMatchObject({ number: 1, status: "released", aircraft: ITEMS });
    expect(res.body.ownRankCounts).toBeUndefined();
    const activation = await one("SELECT * FROM content_release_activations WHERE module = $1", [MODULE]);
    expect(activation).toMatchObject({ sequence: 1, kind: "activate", release_version: 1, history: [], created_by: fx.admin.principal, note: "go" });
    const log = await audits("release_activate");
    expect(log).toHaveLength(1);
    expect(log[0]!.detail).toEqual({ release: 1, previous: null, itemCount: ITEMS, sequence: 1 });
    expect((await state()).pointer).toEqual({ current: 1, history: [], version: 1 });
  });

  it("the history stack: activate 1, activate 2, restore pops to 1, restore again is 422; an activated release cannot be activated again", async () => {
    expect((await upload(ids(ITEMS))).status).toBe(201);
    expect((await upload(ids(ITEMS - 1))).status).toBe(201);
    expect((await activate(1, 0)).body.pointer).toEqual({ current: 1, history: [], version: 1 });
    const second = await activate(2, 1);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.pointer).toEqual({ current: 2, history: [1], version: 2 });
    expect((await audits("release_activate"))[1]!.detail).toEqual({ release: 2, previous: 1, itemCount: ITEMS - 1, sequence: 2 });

    const back = await restore(2, { note: "oops" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.pointer).toEqual({ current: 1, history: [], version: 3 });
    expect(back.body.releases.map((r: { number: number; status: string }) => [r.number, r.status])).toEqual([[2, "released"], [1, "released"]]); // newest first
    const restored = await one("SELECT * FROM content_release_activations WHERE module = $1 AND sequence = 3", [MODULE]);
    expect(restored).toMatchObject({ kind: "restore", release_version: 1, history: [], note: "oops" });
    const log = await audits("release_restore");
    expect(log).toHaveLength(1);
    expect(log[0]!.detail).toEqual({ release: 1, replaced: 2, sequence: 3 });

    const none = await restore(3);
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe("content_invalid");
    expect(none.body.error.message).toContain("no earlier release");
    const again = await activate(2, 3);
    expect(again.status).toBe(422);
    expect(again.body.error.message).toContain("Only an uploaded release can be made live");
    expect(await count("content_release_activations")).toBe(3);
  });

  it("a three-deep stack pops one at a time", async () => {
    for (const selection of [ids(ITEMS), ids(ITEMS - 1), ids(ITEMS - 2)]) expect((await upload(selection)).status).toBe(201);
    expect((await activate(1, 0)).status).toBe(200);
    expect((await activate(2, 1)).status).toBe(200);
    expect((await activate(3, 2)).body.pointer).toEqual({ current: 3, history: [1, 2], version: 3 });
    expect((await restore(3)).body.pointer).toEqual({ current: 2, history: [1], version: 4 });
    expect((await restore(4)).body.pointer).toEqual({ current: 1, history: [], version: 5 });
  });

  it("a stale pointer is 409 version_conflict on activate and on restore; nothing is written", async () => {
    expect((await upload(ids(ITEMS))).status).toBe(201);
    expect((await upload(ids(ITEMS - 1))).status).toBe(201);
    expect((await activate(1, 0)).status).toBe(200);
    const stale = await activate(2, 0);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect(stale.body.error.message).toContain("Another editor changed the release");
    expect((await restore(0)).status).toBe(409);
    expect(await count("content_release_activations")).toBe(1);
    expect(await audits("release_activate")).toHaveLength(1);
  });

  it("an unknown release is 404; the same basis as the current release is 409 nothing_to_publish", async () => {
    expect((await activate(5, 0)).status).toBe(404);
    expect((await upload(ids(ITEMS))).status).toBe(201); // release 1
    expect((await upload(ids(ITEMS))).status).toBe(201); // release 2: the same basis, allowed while nothing is current
    expect((await activate(1, 0)).status).toBe(200);
    const same = await activate(2, 1);
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe("nothing_to_publish");
    expect(await count("content_release_activations")).toBe(1);
  });

  it("GET lists the pointer, the releases (newest first) and ownRankCounts; an uploaded release reads uploaded", async () => {
    expect((await upload(ids(ITEMS), { note: "one" })).status).toBe(201);
    expect((await upload(ids(ITEMS - 1))).status).toBe(201);
    expect((await activate(1, 0)).status).toBe(200);
    const listed = await state();
    expect(listed.pointer).toEqual({ current: 1, history: [], version: 1 });
    expect(listed.releases.map((r) => [r.number, r.status, r.aircraft])).toEqual([[2, "uploaded", ITEMS - 1], [1, "released", ITEMS]]);
    expect(listed.releases[1]!.note).toBe("one");
    expect(listed.releases[0]!.note).toBeNull();
    expect(listed.ownRankCounts).toEqual({ trainee: 3, "first-officer": 3, captain: 2, "check-airman": 2, "chief-pilot": 2 });
    expect(Object.keys(listed).sort()).toEqual(["ownRankCounts", "pointer", "releases"]);
  });

  it("GET with no releases is the empty pointer, and a release list is capped at the newest 50", async () => {
    const empty = await state();
    expect(empty.pointer).toEqual({ current: null, history: [], version: 0 });
    expect(empty.releases).toEqual([]);
    await sql.query(
      `INSERT INTO content_releases (module, version, basis, item_count, deal_rule, flight_kind, created_at, created_by)
       SELECT $1::text, v, 'mil-a1:1', 1, 'nearest-ranks', 'choice', now(), 'test' FROM generate_series(1, 55) v`,
      [MODULE],
    );
    const listed = await state();
    expect(listed.releases).toHaveLength(50);
    expect(listed.releases[0]!.number).toBe(55);
    expect(listed.releases[49]!.number).toBe(6);
  });

  it("two concurrent activations: one wins, the other is release_in_progress or version_conflict", async () => {
    expect((await upload(ids(ITEMS))).status).toBe(201);
    expect((await upload(ids(ITEMS - 1))).status).toBe(201);
    const [a, b] = await Promise.all([activate(1, 0), activate(2, 0)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(["release_in_progress", "version_conflict"]).toContain(loser.body.error.code);
    expect(await count("content_release_activations")).toBe(1);
    expect(await audits("release_activate")).toHaveLength(1);
    const winner = a.status === 200 ? 1 : 2;
    expect((await state()).pointer).toEqual({ current: winner, history: [], version: 1 });
  });

  it("two concurrent uploads never share a release number", async () => {
    const body = { itemIds: ids(ITEMS), basis: await basisOf(ids(ITEMS)), previewed: true };
    const [a, b] = await Promise.all([post("/releases", body), post("/releases", body)]);
    for (const res of [a, b]) {
      expect(res.status === 201 || (res.status === 409 && res.body.error.code === "release_in_progress"), JSON.stringify(res.body)).toBe(true);
    }
    const created = [a, b].filter((r) => r.status === 201).length;
    expect(created).toBeGreaterThanOrEqual(1);
    const numbers = (await sql.query("SELECT version FROM content_releases ORDER BY version")).rows.map((r) => r.version);
    expect(numbers).toEqual(Array.from({ length: created }, (_, i) => i + 1));
  });
});

describe("the activation guard, each leg separately (nothing is written when it fails)", () => {
  async function uploaded(): Promise<void> {
    expect((await upload()).status).toBe(201);
  }
  async function refused(extra: string[]): Promise<void> {
    const res = await activate(1, 0);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("version_conflict");
    expect(res.body.error.message).toContain("changed since this release was uploaded");
    expect(res.body.errors).toEqual(extra);
    expect(await count("content_release_activations")).toBe(0);
    expect(await audits("release_activate")).toHaveLength(0);
    expect((await state()).pointer).toEqual({ current: null, history: [], version: 0 });
  }

  it("(a) a retired item", async () => {
    await uploaded();
    expect((await request(app.server).post(`${BASE}/items/mil-a3/retire`).set(admin()).send({ version: 1 })).status).toBe(200);
    await refused(["mil-a3: the item is retired or no longer stored."]);
  });

  it("(a) an item that no longer exists", async () => {
    await uploaded();
    await sql.query("DELETE FROM content_items WHERE module = $1 AND id = 'mil-a4'", [MODULE]);
    await refused(["mil-a4: the item is retired or no longer stored."]);
  });

  it("(b) an item whose version moved (edited in place)", async () => {
    await uploaded();
    const edit = await request(app.server).patch(`${BASE}/items/mil-a5`).set(admin()).send({ version: 1, data: { answer: "Aircraft 5 Edited", wrong: ["Wrong 5a", "Wrong 5b", "Wrong 5c"], sourceFile: "MA_test_5.jpg", photographer: "Photographer 5" } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    await refused(["mil-a5: the item changed since the upload (version 1, now 2)."]);
  });

  it("(b) a relink of the item's photo bumps its version and blocks", async () => {
    await uploaded();
    const other = await fx.publishedMedia();
    const link = await request(app.server).put(`${BASE}/items/mil-a6/media`).set(admin()).send({ mediaId: other.id, expectedVersion: 1 });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    await refused(["mil-a6: the item changed since the upload (version 1, now 2)."]);
  });

  it("(c) a photo that was withdrawn", async () => {
    await uploaded();
    const gone = pool[6]!;
    await fx.withdraw(gone.id, gone.revision);
    tainted.add(6);
    await refused([`mil-a7: photo ${gone.id} is no longer published.`]);
  });

  it("(c) a photo that was republished at another version", async () => {
    await uploaded();
    const media = pool[7]!;
    const revision = await fx.republishWithCredit(media, "A New Credit");
    expect(revision).toBeGreaterThan(media.revision);
    tainted.add(7);
    await refused([`mil-a8: photo ${media.id} was republished (version 2, the release froze version 1).`]);
  });

  it("(c) a photo whose stored file hash differs from the frozen one", async () => {
    await uploaded();
    const media = pool[8]!;
    const original = (await one("SELECT sha256 FROM media_versions WHERE media_id = $1 AND version = 1", [media.id.slice(4)])).sha256 as string;
    await sql.query("UPDATE media_versions SET sha256 = $2 WHERE media_id = $1 AND version = 1", [media.id.slice(4), "f".repeat(64)]);
    try {
      await refused([`mil-a9: photo ${media.id} no longer matches the file the release froze.`]);
    } finally {
      await sql.query("UPDATE media_versions SET sha256 = $2 WHERE media_id = $1 AND version = 1", [media.id.slice(4), original]);
    }
  });

  it("every change is named at once", async () => {
    await uploaded();
    await request(app.server).post(`${BASE}/items/mil-a1/retire`).set(admin()).send({ version: 1 });
    const gone = pool[1]!;
    await fx.withdraw(gone.id, gone.revision);
    tainted.add(1);
    const res = await activate(1, 0);
    expect(res.status).toBe(409);
    expect(res.body.errors).toEqual(["mil-a1: the item is retired or no longer stored.", `mil-a2: photo ${gone.id} is no longer published.`]);
  });

  it("ASSUMPTION: the media revision is not compared: a draft-only edit of a photo does not block activation", async () => {
    await uploaded();
    const media = pool[9]!;
    const revision = await fx.editLicence(media.id, media.revision, { credit: "Edited on the draft only" });
    expect(revision).toBeGreaterThan(media.revision);
    const detail = await one("SELECT revision, published_version, state FROM media_items WHERE id = $1", [media.id.slice(4)]);
    expect(detail).toMatchObject({ published_version: 1, state: "published" });
    expect(detail.revision).toBeGreaterThan(media.revision);
    const res = await activate(1, 0);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.pointer.current).toBe(1);
    tainted.add(9); // the draft now differs from the published file; give later tests a clean photo
  });

  it("a release freezes what it saw: later changes leave its rows untouched", async () => {
    await uploaded();
    const before = (await sql.query("SELECT * FROM content_release_items ORDER BY position")).rows;
    await request(app.server).patch(`${BASE}/items/mil-a3`).set(admin()).send({ version: 1, data: { answer: "Changed", wrong: ["x1", "x2", "x3"], sourceFile: "MA_test_3.jpg", photographer: "P" } });
    const gone = pool[2]!;
    await fx.withdraw(gone.id, gone.revision);
    tainted.add(2);
    expect((await sql.query("SELECT * FROM content_release_items ORDER BY position")).rows).toEqual(before);
  });
});

describe("restore", () => {
  it("ASSUMPTION: restore refuses unpublished photos (422 with errors), and the pointer does not move", async () => {
    expect((await upload(ids(ITEMS))).status).toBe(201); // release 1 holds mil-a12
    expect((await upload(ids(ITEMS - 1))).status).toBe(201); // release 2 does not
    expect((await activate(1, 0)).status).toBe(200);
    expect((await activate(2, 1)).status).toBe(200);
    const gone = pool[ITEMS - 1]!;
    await fx.withdraw(gone.id, gone.revision);
    tainted.add(ITEMS - 1);
    const res = await restore(2);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe("content_invalid");
    expect(res.body.error.message).toContain("no longer published");
    expect(res.body.errors).toEqual([`mil-a12: photo ${gone.id} is no longer published.`]);
    expect((await state()).pointer).toEqual({ current: 2, history: [1], version: 2 });
    expect(await count("content_release_activations")).toBe(2);
    expect(await audits("release_restore")).toHaveLength(0);
  });

  it("ASSUMPTION: restore does not re-check the items (a retired item does not block a step back)", async () => {
    expect((await upload(ids(ITEMS))).status).toBe(201);
    expect((await upload(ids(ITEMS - 1))).status).toBe(201);
    expect((await activate(1, 0)).status).toBe(200);
    expect((await activate(2, 1)).status).toBe(200);
    await request(app.server).post(`${BASE}/items/${id(ITEMS)}/retire`).set(admin()).send({ version: 1 });
    const res = await restore(2);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.pointer).toEqual({ current: 1, history: [], version: 3 });
  });

  it("restore with nothing current is 422 (nothing earlier)", async () => {
    const res = await restore(0);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("content_invalid");
  });
});

describe("the three release tables are insert-only (triggers) and constrained", () => {
  async function seeded(): Promise<void> {
    expect((await upload()).status).toBe(201);
    expect((await activate(1, 0)).status).toBe(200);
  }

  it("UPDATE, DELETE and TRUNCATE are refused on content_releases, content_release_items and content_release_activations; the rows are unchanged", async () => {
    await seeded();
    const attempts: [string, string][] = [
      ["content_releases", "note = 'x'"],
      ["content_release_items", "item_version = item_version + 1"],
      ["content_release_activations", "note = 'x'"],
    ];
    for (const [table, set] of attempts) {
      const before = (await sql.query(`SELECT * FROM ${table} ORDER BY 1, 2`)).rows;
      await expect(sql.query(`UPDATE ${table} SET ${set}`), `UPDATE ${table}`).rejects.toMatchObject({ code: "23001", message: expect.stringContaining("immutable") });
      await expect(sql.query(`DELETE FROM ${table}`), `DELETE ${table}`).rejects.toMatchObject({ code: "23001", message: expect.stringContaining("immutable") });
      await expect(sql.query(`TRUNCATE ${table} CASCADE`), `TRUNCATE ${table}`).rejects.toMatchObject({ code: "23001", message: expect.stringContaining("immutable") });
      expect((await sql.query(`SELECT * FROM ${table} ORDER BY 1, 2`)).rows, table).toEqual(before);
    }
  });

  it("a release item needs a stored release and a stored media version (composite foreign keys)", async () => {
    await seeded();
    const sha = "a".repeat(64);
    const insert = (release: number, mediaId: string, mediaVersion: number, itemId: string, position: number, hash = sha) =>
      sql.query(
        `INSERT INTO content_release_items (module, release_version, item_id, item_version, position, rank, media_id, media_version, photo_sha256, deal)
         VALUES ($1, $2, $3, 1, $4, 'trainee', $5, $6, $7, '{}')`,
        [MODULE, release, itemId, position, mediaId, mediaVersion, hash],
      );
    const media = pool[0]!.id.slice(4);
    await expect(insert(99, media, 1, "x1", 50)).rejects.toMatchObject({ code: "23503", constraint: "content_release_items_release_fk" });
    await expect(insert(1, media, 7, "x2", 51)).rejects.toMatchObject({ code: "23503", constraint: "content_release_items_media_fk" });
    await expect(insert(1, media, 1, "mil-a1", 52, "b".repeat(64))).rejects.toMatchObject({ code: "23505" }); // primary key (module, release, item)
    await expect(insert(1, media, 1, "x3", 1, "c".repeat(64))).rejects.toMatchObject({ code: "23505", constraint: "content_release_items_position" });
    await expect(insert(1, media, 1, "x4", 53, pool[1]!.sha256)).rejects.toMatchObject({ code: "23505", constraint: "content_release_items_photo" });
    expect(await count("content_release_items")).toBe(ITEMS);
  });

  it("an activation needs a stored release and a unique sequence per module", async () => {
    await seeded();
    const insert = (release: number, sequence: number, kind = "activate") =>
      sql.query("INSERT INTO content_release_activations (module, sequence, kind, release_version, history, created_at, created_by) VALUES ($1, $2, $3, $4, '{}', now(), 'test')", [MODULE, sequence, kind, release]);
    await expect(insert(99, 5)).rejects.toMatchObject({ code: "23503", constraint: "content_release_activations_release_fk" });
    await expect(insert(1, 1)).rejects.toMatchObject({ code: "23505", constraint: "content_release_activations_sequence" });
    await expect(insert(1, 0)).rejects.toMatchObject({ code: "23514", constraint: "content_release_activations_sequence_check" });
    await expect(insert(1, 6, "deactivate")).rejects.toMatchObject({ code: "23514", constraint: "content_release_activations_kind_check" });
    expect(await count("content_release_activations")).toBe(1);
  });

  it("the CHECKs refuse an empty release, an unknown rule or Flight kind, a long note and a malformed hash", async () => {
    const release = (over: Record<string, string>) => {
      const v = { count: "1", rule: "nearest-ranks", kind: "choice", note: "null", basis: "'b'", module: `'${MODULE}'`, ...over };
      return sql.query(
        `INSERT INTO content_releases (module, version, basis, item_count, deal_rule, flight_kind, created_at, created_by, note)
         VALUES (${v.module}, 1, ${v.basis}, ${v.count}, '${v.rule}', '${v.kind}', now(), 'test', ${v.note})`,
      );
    };
    await expect(release({ count: "0" })).rejects.toMatchObject({ constraint: "content_releases_item_count_check" });
    await expect(release({ count: "2001" })).rejects.toMatchObject({ constraint: "content_releases_item_count_check" });
    await expect(release({ rule: "lower-ranks" })).rejects.toMatchObject({ constraint: "content_releases_deal_rule_check" });
    await expect(release({ kind: "grid" })).rejects.toMatchObject({ constraint: "content_releases_flight_kind_check" });
    await expect(release({ note: `'${"x".repeat(501)}'` })).rejects.toMatchObject({ constraint: "content_releases_note_check" });
    await expect(release({ basis: "''" })).rejects.toMatchObject({ constraint: "content_releases_basis_check" });
    await expect(release({ module: "'no-such-module'" })).rejects.toMatchObject({ constraint: "content_releases_module_check" });
    expect(await count("content_releases")).toBe(0);
    await seeded();
    await expect(
      sql.query(
        `INSERT INTO content_release_items (module, release_version, item_id, item_version, position, rank, media_id, media_version, photo_sha256, deal)
         VALUES ($1, 1, 'x', 1, 77, 'trainee', $2, 1, 'not-a-hash', '{}')`,
        [MODULE, pool[0]!.id.slice(4)],
      ),
    ).rejects.toMatchObject({ constraint: "content_release_items_sha256_check" });
  });
});
