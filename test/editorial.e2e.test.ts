import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blankEditorialData } from "../src/content/editorial/editorial-rules.js";
import { Fixtures, boot, goodData } from "./editorial-helpers.js";
import type { Booted, PublishedMedia } from "./editorial-helpers.js";
import { seedRole } from "./roles-helpers.js";

// Wave W1 (docs/plans/website-content.md): the staff editorial desks, /v1/admin/editorial/{kind}/items. Media is built through the real
// media routes. Every ASSUMPTION is a test named "ASSUMPTION: ...".

const POTD = "plane-of-the-day";
const IDENT = "identifier";
const desk = (kind: string) => `/v1/admin/editorial/${kind}/items`;
const PUBLISHED_REFUSAL = "The linked photo must be a published photo.";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let app: Booted;
let demoApp: Booted; // the same database, but fx.owner is "the shared demo account"
let sql: pg.Pool;
let fx: Fixtures;

type Item = { id: string; kind: string; mediaId: string; status: string; dateKey: string | null; version: number; data: Record<string, unknown> };

const create = (who: { auth: object }, kind: string, body: unknown, b = app) => request(b.server).post(desk(kind)).set(who.auth as Record<string, string>).send(body as object);
const put = (who: { auth: object }, kind: string, id: string, body: unknown, b = app) =>
  request(b.server).put(`${desk(kind)}/${id}`).set(who.auth as Record<string, string>).send(body as object);
const list = (who: { auth: object }, kind: string) => request(app.server).get(desk(kind)).set(who.auth as Record<string, string>);

/** A body for PUT: the item's current version, with overrides. */
const saveBody = (item: Item, over: Record<string, unknown> = {}) => ({ version: item.version, status: "draft", data: goodData(), dateKey: null, ...over });

async function draft(kind: string, media?: PublishedMedia, data?: unknown): Promise<{ media: PublishedMedia; item: Item }> {
  const m = media ?? (await fx.publishedMedia());
  const res = await create(fx.admin, kind, data === undefined ? { mediaId: m.id } : { mediaId: m.id, data });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { media: m, item: res.body.item };
}

async function auditRows(itemId: string, action?: string) {
  const { rows } = await sql.query(
    "SELECT actor, action, target, detail FROM admin_audit WHERE detail->>'id' = $1 AND action LIKE 'editorial_%' AND ($2::text IS NULL OR action = $2) ORDER BY id",
    [itemId, action ?? null],
  );
  return rows as { actor: string; action: string; target: string; detail: Record<string, unknown> }[];
}

const rowOf = async (itemId: string) => (await sql.query("SELECT * FROM editorial_items WHERE id = $1", [Number(itemId.slice(3))])).rows[0];

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  app = await boot();
  fx = new Fixtures(sql, () => app.server);
  await fx.init();
  demoApp = await boot({ demoPrincipal: fx.owner.principal });
});

afterAll(async () => {
  await fx.cleanup();
  await sql.end();
  await app.app.close();
  await demoApp.app.close();
});

describe("who may use the desks", () => {
  it("no token is 401, a photographer and a plain player are 403, an admin is 200", async () => {
    expect((await request(app.server).get(desk(POTD))).status).toBe(401);
    expect((await request(app.server).post(desk(POTD)).send({})).status).toBe(401);
    expect((await request(app.server).put(`${desk(POTD)}/ed-1`).send({})).status).toBe(401);
    for (const who of [fx.owner, fx.player]) {
      expect((await list(who, POTD)).status).toBe(403);
      expect((await create(who, POTD, { mediaId: "med-1" })).status).toBe(403);
      expect((await put(who, POTD, "ed-1", saveBody({ version: 1 } as Item))).status).toBe(403);
    }
    expect((await list(fx.admin, POTD)).status).toBe(200);
  });

  it("an unknown kind and a malformed or unknown id are 404", async () => {
    const m = await fx.publishedMedia();
    expect((await request(app.server).get(desk("airport-spotter")).set(fx.admin.auth)).status).toBe(404);
    expect((await create(fx.admin, "military", { mediaId: m.id })).status).toBe(404);
    expect((await put(fx.admin, POTD, "xyz", saveBody({ version: 1 } as Item))).status).toBe(404);
    expect((await put(fx.admin, POTD, "ed-0", saveBody({ version: 1 } as Item))).status).toBe(404);
    expect((await put(fx.admin, POTD, "ed-999999999999", saveBody({ version: 1 } as Item))).status).toBe(404);
  });
});

describe("create", () => {
  it("makes a draft v1 from published media: 201, the blank shape, one audit row, no principal in the body", async () => {
    const m = await fx.publishedMedia();
    const res = await create(fx.admin, POTD, { mediaId: m.id });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(["item"]);
    const item: Item = res.body.item;
    expect(item).toMatchObject({ kind: POTD, mediaId: m.id, status: "draft", dateKey: null, version: 1, data: blankEditorialData() });
    expect(item.id).toMatch(/^ed-[1-9][0-9]*$/);
    expect(Object.keys(item).sort()).toEqual(["createdAt", "data", "dateKey", "id", "kind", "mediaId", "status", "updatedAt", "version"]);
    expect(JSON.stringify(res.body)).not.toContain(fx.admin.principal);
    const audit = await auditRows(item.id);
    expect(audit).toEqual([{ actor: fx.admin.principal, action: "editorial_create", target: POTD, detail: { id: item.id, mediaId: m.id } }]);
    const row = await rowOf(item.id);
    expect(row.created_by).toBe(fx.admin.principal);
    expect(row.updated_by).toBe(fx.admin.principal);
  });

  it("stores sent data normalised (ASSUMPTION: text trimmed on store) and never prefills from the media", async () => {
    const m = await fx.publishedMedia("Prefill Check Credit");
    const res = await create(fx.admin, IDENT, { mediaId: m.id, data: goodData({ title: "  Padded title  ", description: "line one\r\nline two" }) });
    expect(res.status).toBe(201);
    expect(res.body.item.data.title).toBe("Padded title");
    expect(res.body.item.data.description).toBe("line one\nline two");
    const blank = await create(fx.admin, IDENT, { mediaId: m.id });
    expect(blank.body.item.data.credit).toBe(""); // the media's credit is not copied into the staff field
    expect(blank.body.item.data.photographer).toBe("");
  });

  it("refuses media that is unpublished, withdrawn or missing with 422 content_invalid and errors[], writing nothing", async () => {
    const unpublished = await fx.upload();
    const gone = await fx.publishedMedia();
    await fx.withdraw(gone.id, gone.revision);
    for (const mediaId of [unpublished.id, gone.id]) {
      const res = await create(fx.admin, POTD, { mediaId });
      expect(res.status, mediaId).toBe(422);
      expect(res.body.error.code).toBe("content_invalid");
      expect(res.body.errors).toEqual([PUBLISHED_REFUSAL]);
      expect(Number((await sql.query("SELECT count(*) FROM editorial_items WHERE media_id = $1", [Number(mediaId.slice(4))])).rows[0].count)).toBe(0);
    }
    const missing = await create(fx.admin, POTD, { mediaId: "med-999999999999" });
    expect(missing.status).toBe(422);
    expect(missing.body.errors).toEqual(["No such media item."]);
  });

  it("collects the media and the shape problems together", async () => {
    const unpublished = await fx.upload();
    const res = await create(fx.admin, POTD, { mediaId: unpublished.id, data: goodData({ distractors: ["a", "b"], difficulty: "ace" }) });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveLength(3);
    expect(res.body.errors[0]).toBe(PUBLISHED_REFUSAL);
  });

  it("ASSUMPTION: demo-owned media is refused at create", async () => {
    const m = await fx.publishedMedia(); // owned by fx.owner, who is "the demo account" in demoApp
    const res = await create(fx.admin, POTD, { mediaId: m.id }, demoApp);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(["The linked photo belongs to the shared demo account and cannot be used."]);
    expect((await create(fx.admin, POTD, { mediaId: m.id })).status).toBe(201); // the same media is fine for a normal app
  });

  it("is strict: imageUrl anywhere, unknown keys, bad ids and shapes are 400 invalid_request", async () => {
    const m = await fx.publishedMedia();
    const bad: [string, unknown][] = [
      ["imageUrl in data", { mediaId: m.id, data: { ...goodData(), imageUrl: "https://example.com/x.png" } }],
      ["imageUrl at the top", { mediaId: m.id, imageUrl: "https://example.com/x.png" }],
      ["unknown top-level key", { mediaId: m.id, status: "published" }],
      ["no mediaId", {}],
      ["mediaId with a leading zero", { mediaId: "med-01" }],
      ["mediaId wrong prefix", { mediaId: "mid-1" }],
      ["mediaId a number", { mediaId: 5 }],
      ["data with a key missing", { mediaId: m.id, data: { title: "x" } }],
      ["data field not text", { mediaId: m.id, data: { ...goodData(), title: 5 } }],
      ["distractors not an array", { mediaId: m.id, data: { ...goodData(), distractors: "a,b,c" } }],
      ["distractors 21 long", { mediaId: m.id, data: { ...goodData(), distractors: Array(21).fill("a") } }],
    ];
    for (const [name, body] of bad) {
      const res = await create(fx.admin, POTD, body);
      expect(res.status, name).toBe(400);
      expect(res.body.error.code, name).toBe("invalid_request");
    }
  });
});

describe("save", () => {
  it("changes the item: version + 1, one audit row naming the fields (no text bodies), database-clock timestamps", async () => {
    const { item } = await draft(POTD);
    const res = await put(fx.admin, POTD, item.id, saveBody(item, { data: goodData({ title: "Audit Title Text" }) }));
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.item).toMatchObject({ id: item.id, version: 2, status: "draft", dateKey: null });
    expect(res.body.item.data.title).toBe("Audit Title Text");
    expect(Date.parse(res.body.item.updatedAt)).toBeGreaterThanOrEqual(Date.parse(res.body.item.createdAt));
    const audit = await auditRows(item.id, "editorial_save");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: fx.admin.principal, action: "editorial_save", target: POTD });
    const fields = Object.keys(goodData()).filter((k) => JSON.stringify((goodData() as Record<string, unknown>)[k]) !== JSON.stringify((blankEditorialData() as Record<string, unknown>)[k]));
    expect(audit[0]!.detail).toEqual({
      id: item.id,
      fromVersion: 1,
      version: 2,
      fromStatus: "draft",
      status: "draft",
      fromDateKey: null,
      dateKey: null,
      fields: fields.map((f) => `data.${f}`),
    });
    expect(JSON.stringify(audit[0]!.detail)).not.toContain("Audit Title Text");
  });

  it("a stale version is 409 version_conflict and writes nothing (item and audit unchanged)", async () => {
    const { item } = await draft(POTD);
    const first = await put(fx.admin, POTD, item.id, saveBody(item, { data: goodData({ title: "First writer" }) }));
    expect(first.status).toBe(200);
    const stale = await put(fx.admin, POTD, item.id, saveBody(item, { data: goodData({ title: "Second writer, stale" }) }));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    const row = await rowOf(item.id);
    expect(row.version).toBe(2);
    expect(row.data.title).toBe("First writer");
    expect(await auditRows(item.id, "editorial_save")).toHaveLength(1);
  });

  it("an unchanged save is changed:false with no bump and no audit row (judged on the trimmed data)", async () => {
    const { item } = await draft(POTD);
    const saved = await put(fx.admin, POTD, item.id, saveBody(item));
    expect(saved.body.item.version).toBe(2);
    const before = await rowOf(item.id);
    const again = await put(fx.admin, POTD, item.id, { ...saveBody(saved.body.item), data: goodData({ title: `  ${goodData().title}  ` }) });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(again.body.item.version).toBe(2);
    const after = await rowOf(item.id);
    expect(after.version).toBe(2);
    expect(after.updated_at).toEqual(before.updated_at);
    expect(await auditRows(item.id, "editorial_save")).toHaveLength(1);
  });

  it("two saves at the same version at once: exactly one wins, the other is 409 and writes nothing", async () => {
    const { item } = await draft(POTD);
    const results = await Promise.all([
      put(fx.admin, POTD, item.id, saveBody(item, { data: goodData({ title: "Racer A" }) })),
      put(fx.admin, POTD, item.id, saveBody(item, { data: goodData({ title: "Racer B" }) })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await rowOf(item.id)).version).toBe(2);
    expect(await auditRows(item.id, "editorial_save")).toHaveLength(1);
  });

  it("publishing an incomplete Plane of the Day lists every reason at once", async () => {
    const m = await fx.publishedMedia(null); // published, but its licence has no credit
    const { item } = await draft(POTD, m);
    const res = await put(fx.admin, POTD, item.id, saveBody(item, { status: "published", data: blankEditorialData(), dateKey: null }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("content_invalid");
    expect(res.body.errors).toEqual([
      "Add a descriptive title (at least 3 characters).",
      "Add an https factual source.",
      "Add the photo's factual context (at least 15 characters).",
      "Choose the date this Plane of the Day is for.",
      "The linked photo's licence needs a credit before it can be shown publicly.",
    ]);
    expect((await rowOf(item.id)).status).toBe("draft");
    expect(await auditRows(item.id, "editorial_save")).toHaveLength(0);
  });

  it("a complete Plane of the Day schedules and publishes, with a date; drafts and archives need only the shape", async () => {
    const { item } = await draft(POTD, undefined, goodData());
    const scheduled = await put(fx.admin, POTD, item.id, saveBody(item, { status: "scheduled", dateKey: "2031-05-06" }));
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
    expect(scheduled.body.item).toMatchObject({ status: "scheduled", dateKey: "2031-05-06", version: 2 });
    const published = await put(fx.admin, POTD, item.id, saveBody(scheduled.body.item, { status: "published", dateKey: "2031-05-06" }));
    expect(published.body.item).toMatchObject({ status: "published", version: 3 });
    // Any status may move to any other (website parity).
    let current: Item = published.body.item;
    for (const status of ["archived", "draft", "scheduled", "published", "draft"]) {
      const res = await put(fx.admin, POTD, item.id, saveBody(current, { status, dateKey: "2031-05-06" }));
      expect(res.status, status).toBe(200);
      current = res.body.item;
      expect(current.status).toBe(status);
    }
    // A draft with blank content is fine.
    const blank = await put(fx.admin, POTD, item.id, saveBody(current, { status: "archived", data: blankEditorialData(), dateKey: null }));
    expect(blank.status).toBe(200);
    const audit = await auditRows(item.id, "editorial_save");
    expect(audit.length).toBe(8);
    expect(audit[0]!.detail).toMatchObject({ fromStatus: "draft", status: "scheduled", fromDateKey: null, dateKey: "2031-05-06", fields: ["status", "dateKey"] });
  });

  it("rejects dates that are not real calendar dates with 422, and a malformed date with 400", async () => {
    const { item } = await draft(POTD);
    const feb = await put(fx.admin, POTD, item.id, saveBody(item, { dateKey: "2026-02-29" }));
    expect(feb.status).toBe(422);
    expect(feb.body.errors).toEqual(["dateKey must be a real calendar date (YYYY-MM-DD)."]);
    for (const dateKey of ["tomorrow", "2026-2-3", "2026-11-05T00:00:00Z", 20261105]) {
      const res = await put(fx.admin, POTD, item.id, saveBody(item, { dateKey }));
      expect(res.status, String(dateKey)).toBe(400);
    }
  });

  it("Aircraft Identifier: scheduled is refused, a date is refused, a complete item publishes", async () => {
    const { item } = await draft(IDENT);
    const scheduled = await put(fx.admin, IDENT, item.id, saveBody(item, { status: "scheduled" }));
    expect(scheduled.status).toBe(422);
    expect(scheduled.body.errors).toEqual(["Aircraft Identifier supports draft or published content, not daily scheduling."]);
    const dated = await put(fx.admin, IDENT, item.id, saveBody(item, { status: "published", dateKey: "2031-05-06" }));
    expect(dated.status).toBe(422);
    expect(dated.body.errors).toEqual(["An Aircraft Identifier item has no date."]);
    const dup = await put(fx.admin, IDENT, item.id, saveBody(item, { status: "published", data: goodData({ distractors: ["Airbus A350", "boeing 787 ", "Airbus A330"] }) }));
    expect(dup.status).toBe(422);
    expect(dup.body.errors).toEqual(["All answer choices must be different."]);
    const ok = await put(fx.admin, IDENT, item.id, saveBody(item, { status: "published" }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.item).toMatchObject({ status: "published", dateKey: null });
    // dateKey absent is the same as null.
    const { dateKey: _dateKey, ...withoutDate } = saveBody(ok.body.item, { status: "archived" });
    expect((await put(fx.admin, IDENT, item.id, withoutDate)).status).toBe(200);
  });

  it("an item of the other kind is 404, not editable through this kind's path", async () => {
    const { item } = await draft(IDENT);
    const res = await put(fx.admin, POTD, item.id, saveBody(item));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
    expect((await list(fx.admin, POTD)).body.items.map((i: Item) => i.id)).not.toContain(item.id);
    expect((await list(fx.admin, IDENT)).body.items.map((i: Item) => i.id)).toContain(item.id);
    expect((await rowOf(item.id)).version).toBe(1);
  });

  it("is strict: imageUrl and unknown keys are 400, so the image can only be the linked media", async () => {
    const { item } = await draft(POTD);
    const bad: [string, unknown][] = [
      ["imageUrl in data", saveBody(item, { data: { ...goodData(), imageUrl: "https://example.com/x.png" } })],
      ["imageUrl at the top", saveBody(item, { imageUrl: "https://example.com/x.png" })],
      ["mediaId (fixed at create)", saveBody(item, { mediaId: "med-1" })],
      ["no data", { version: 1, status: "draft" }],
      ["no status", { version: 1, data: goodData() }],
      ["status unknown", saveBody(item, { status: "live" })],
      ["version 0", saveBody(item, { version: 0 })],
      ["version a string", saveBody(item, { version: "1" })],
    ];
    for (const [name, body] of bad) {
      const res = await put(fx.admin, POTD, item.id, body);
      expect(res.status, name).toBe(400);
      expect(res.body.error.code, name).toBe("invalid_request");
    }
    expect((await rowOf(item.id)).version).toBe(1);
  });

  it("ASSUMPTION: several Plane of the Day items per date are allowed and all publish", async () => {
    const a = await draft(POTD);
    const b = await draft(POTD);
    const c = await draft(POTD, a.media); // even the same photo twice
    for (const { item } of [a, b, c]) {
      const res = await put(fx.admin, POTD, item.id, saveBody(item, { status: "published", dateKey: "2031-07-08" }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const { rows } = await sql.query("SELECT count(*)::int AS n FROM editorial_items WHERE date_key = '2031-07-08' AND status = 'published' AND created_by = $1", [fx.admin.principal]);
    expect(rows[0].n).toBe(3);
  });

  it("ASSUMPTION: demo-owned media is refused at publish", async () => {
    const { item } = await draft(POTD);
    const res = await put(fx.admin, POTD, item.id, saveBody(item, { status: "published", dateKey: "2031-07-09" }), demoApp);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(["The linked photo belongs to the shared demo account and cannot be used."]);
    expect((await put(fx.admin, POTD, item.id, saveBody(item, { status: "draft" }), demoApp)).status).toBe(200); // a draft needs no photo rule
  });

  it("a withdrawn photo cannot be scheduled or published, but a draft save still works", async () => {
    const m = await fx.publishedMedia();
    const { item } = await draft(POTD, m);
    await fx.withdraw(m.id, m.revision);
    const refused = await put(fx.admin, POTD, item.id, saveBody(item, { status: "published", dateKey: "2031-07-10" }));
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([PUBLISHED_REFUSAL]);
    expect((await put(fx.admin, POTD, item.id, saveBody(item, { status: "draft" }))).status).toBe(200);
  });
});

describe("a media withdraw racing a publish is serialised (the media is read FOR SHARE)", () => {
  it("a publish waits behind an uncommitted withdraw, then sees it and is refused", async () => {
    const m = await fx.publishedMedia();
    const { item } = await draft(POTD, m);
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("UPDATE media_items SET state = 'withdrawn', published_version = NULL, revision = revision + 1 WHERE id = $1", [Number(m.id.slice(4))]);
      let settled = false;
      const pending = put(fx.admin, POTD, item.id, saveBody(item, { status: "published", dateKey: "2031-08-01" })).then((r) => {
        settled = true;
        return r;
      });
      await sleep(500);
      expect(settled, "the save must wait for the withdraw's row lock").toBe(false);
      await holder.query("COMMIT");
      const res = await pending;
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([PUBLISHED_REFUSAL]);
      expect((await rowOf(item.id)).status).toBe("draft");
    } finally {
      await holder.end();
    }
  });

  it("the real withdraw route and a publish at once end consistent: the withdrawn photo is never public", async () => {
    const m = await fx.publishedMedia();
    const { item } = await draft(POTD, m);
    const [save, withdraw] = await Promise.all([
      put(fx.admin, POTD, item.id, saveBody(item, { status: "published", dateKey: "2020-01-02" })),
      request(app.server).post(`/v1/admin/media/${m.id}/withdraw`).set(fx.admin.auth).send({ revision: m.revision }),
    ]);
    expect(withdraw.status).toBe(200);
    expect([200, 422]).toContain(save.status);
    const row = await rowOf(item.id);
    expect(row.status).toBe(save.status === 200 ? "published" : "draft");
    const pub = await request(app.server).get("/v1/public/plane-of-the-day?timeZone=UTC");
    expect(pub.body.features.map((f: { id: string }) => f.id)).not.toContain(item.id);
  });
});

describe("the database rules behind the desks", () => {
  const insert = (kind: string, mediaId: number, status: string, dateKey: string | null, version = 1) =>
    sql.query(
      `INSERT INTO editorial_items (kind, media_id, status, date_key, data, version, created_at, updated_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, '{"bulk": 0}', $5, now(), now(), $6, $6) RETURNING id`,
      [kind, mediaId, status, dateKey, version, fx.admin.principal],
    );
  let mediaNum: number;
  beforeAll(async () => {
    mediaNum = Number((await fx.publishedMedia()).id.slice(4));
  });

  it("an Identifier item has no date and is never scheduled", async () => {
    await expect(insert(IDENT, mediaNum, "draft", "2031-01-01")).rejects.toMatchObject({ code: "23514", constraint: "editorial_items_identifier_rule_check" });
    await expect(insert(IDENT, mediaNum, "scheduled", null)).rejects.toMatchObject({ code: "23514", constraint: "editorial_items_identifier_rule_check" });
    await expect(insert(IDENT, mediaNum, "published", null)).resolves.toBeTruthy();
    await expect(insert(IDENT, mediaNum, "archived", null)).resolves.toBeTruthy();
  });

  it("a scheduled or published Plane of the Day item has a date; a draft or archived one may not", async () => {
    await expect(insert(POTD, mediaNum, "scheduled", null)).rejects.toMatchObject({ code: "23514", constraint: "editorial_items_potd_rule_check" });
    await expect(insert(POTD, mediaNum, "published", null)).rejects.toMatchObject({ code: "23514", constraint: "editorial_items_potd_rule_check" });
    await expect(insert(POTD, mediaNum, "draft", null)).resolves.toBeTruthy();
    await expect(insert(POTD, mediaNum, "archived", null)).resolves.toBeTruthy();
    await expect(insert(POTD, mediaNum, "published", "2031-01-01")).resolves.toBeTruthy();
    await expect(insert(POTD, mediaNum, "published", "2031-01-01")).resolves.toBeTruthy(); // no unique index on the date
  });

  it("refuses an unknown kind or status, version 0 and a media id that does not exist", async () => {
    await expect(insert("military", mediaNum, "draft", null)).rejects.toMatchObject({ code: "23514", constraint: "editorial_items_kind_check" });
    await expect(insert(IDENT, mediaNum, "live", null)).rejects.toMatchObject({ code: "23514", constraint: "editorial_items_status_check" });
    await expect(insert(IDENT, mediaNum, "draft", null, 0)).rejects.toMatchObject({ code: "23514", constraint: "editorial_items_version_check" });
    await expect(insert(IDENT, 999_999_999_999, "draft", null)).rejects.toMatchObject({ code: "23503" });
  });

  it("the audit table accepts the two editorial actions and refuses others", async () => {
    for (const action of ["editorial_create", "editorial_save"]) {
      await sql.query("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ($1, $2, 'x', '{}', now())", [fx.admin.principal, action]);
    }
    await expect(sql.query("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ($1, 'editorial_delete', 'x', '{}', now())", [fx.admin.principal])).rejects.toMatchObject({
      code: "23514",
      constraint: "admin_audit_action_check",
    });
  });
});

// Last: it fills the identifier desk with more than 200 rows.
describe("the desk list", () => {
  it("is newest updated first and scoped to its kind", async () => {
    const a = await draft(POTD);
    const b = await draft(POTD);
    const other = await draft(IDENT);
    await put(fx.admin, POTD, a.item.id, saveBody(a.item, { data: goodData({ title: "Touched last" }) }));
    const ids = (await list(fx.admin, POTD)).body.items.map((i: Item) => i.id);
    expect(ids.indexOf(a.item.id)).toBeLessThan(ids.indexOf(b.item.id));
    expect(ids).not.toContain(other.item.id);
    expect(ids.indexOf(a.item.id)).toBe(0);
  });

  it("ASSUMPTION: the list returns at most 200 items", async () => {
    const m = await fx.publishedMedia();
    const mediaNum = Number(m.id.slice(4));
    await sql.query(
      `INSERT INTO editorial_items (kind, media_id, status, date_key, data, created_at, updated_at, created_by, updated_by)
       SELECT 'identifier', $1, 'draft', NULL, '{"bulk": 1}', now(), now(), $2, $2 FROM generate_series(1, 201)`,
      [mediaNum, fx.admin.principal],
    );
    const res = await list(fx.admin, IDENT);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(200);
    await sql.query("DELETE FROM editorial_items WHERE data->>'bulk' = '1'");
  });
});

// Not a request: the role rows a test needs are plain rows, never an env list.
describe("roles", () => {
  it("a revoked admin loses the desk on the next call", async () => {
    const temp = await fx.actor("admin");
    expect((await list(temp, POTD)).status).toBe(200);
    await seedRole(sql, temp.principal, "admin", "revoked");
    expect((await list(temp, POTD)).status).toBe(403);
  });
});
