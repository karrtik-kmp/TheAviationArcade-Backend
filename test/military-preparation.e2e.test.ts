import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { XLSX_MIME } from "../src/content/xlsx.js";
import { BLANK_EVIDENCE, NOT_PUBLISHED_MESSAGE, RETIRED_MESSAGE, STALE_APPROVED_MESSAGE } from "../src/content/preparation/military-preparation.js";
import type { PrepEvidence } from "../src/content/preparation/military-preparation.js";
import { Fixtures, boot } from "./editorial-helpers.js";
import type { Booted, PublishedMedia } from "./editorial-helpers.js";
import { clientSheet } from "./fixtures.js";

// Wave W3, commit 1 (docs/plans/website-content.md 3.3): Military preparation. PUT .../items/:id/preparation, the guarded
// PUT .../items/:id/media, and `preparation` on GET .../items. Media is built through the real media routes.

const MODULE = "aircraft-identifier-military";
const BASE = `/v1/admin/content/${MODULE}`;
const ITEM = (id: string) => `${BASE}/items/${id}`;

let app: Booted;
let demoApp: Booted; // the same database, but fx.owner is "the shared demo account"
let sql: pg.Pool;
let fx: Fixtures;
let sheet: Buffer;

const admin = () => fx.admin.auth as Record<string, string>;
const evidence = (over: Partial<PrepEvidence> = {}): PrepEvidence => ({
  ...BLANK_EVIDENCE,
  photoSource: "media",
  permission: "Client supplied under licence",
  attribution: "A. Pilot",
  ...over,
});
const withReference = (over: Partial<PrepEvidence> = {}) => evidence({ referenceUrl: "https://example.com/ref", ...over });
const crop = { identity: false, answers: false, crop: true, clipperCard: false };
const full = { identity: true, answers: true, crop: true, clipperCard: true };

const prepare = (id: string, body: Record<string, unknown>, b: Booted = app, headers: Record<string, string> = admin()) =>
  request(b.server).put(`${ITEM(id)}/preparation`).set(headers).send(body);
const link = (id: string, body: unknown, b: Booted = app) => request(b.server).put(`${ITEM(id)}/media`).set(admin()).send(body as object);
const list = () => request(app.server).get(`${BASE}/items`).set(admin());
const upload = (bytes: Buffer, query = "") => request(app.server).post(`${BASE}/imports${query}`).set(admin()).set("Content-Type", XLSX_MIME).send(bytes);

const row = async (id: string) => (await sql.query("SELECT * FROM content_items WHERE module = $1 AND id = $2", [MODULE, id])).rows[0];
const audits = async (action = "content_prepare") =>
  (await sql.query("SELECT actor, action, target, detail FROM admin_audit WHERE action = $1 AND target = $2 ORDER BY id", [action, MODULE])).rows as {
    actor: string;
    action: string;
    target: string;
    detail: Record<string, unknown>;
  }[];
const itemOf = async (id: string) => ((await list()).body.items as { id: string; version: number; mediaId: string | null; preparation: { stage: string; evidence: PrepEvidence; stale: boolean } | null }[]).find((i) => i.id === id)!;

/** Save at `stage` with a valid body for it (media linked). */
async function save(id: string, stage: string, media: PublishedMedia | null, over: Partial<PrepEvidence> = {}) {
  const item = await itemOf(id);
  const extra: Partial<PrepEvidence> =
    stage === "rights_checked" ? {} : stage === "content_prepared" ? { referenceUrl: "https://example.com/ref" } : stage === "previewed" ? { referenceUrl: "https://example.com/ref", checklist: crop } : stage === "approved" ? { referenceUrl: "https://example.com/ref", checklist: full } : {};
  return prepare(id, { version: item.version, stage, evidence: evidence({ ...extra, ...over }), mediaId: media?.id ?? null });
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  app = await boot();
  fx = new Fixtures(sql, () => app.server);
  await fx.init();
  demoApp = await boot({ demoPrincipal: fx.owner.principal });
});

afterAll(async () => {
  await sql.query("DELETE FROM content_items");
  await fx.cleanup();
  await app.app.close();
  await demoApp.app.close();
  await sql.end();
});

beforeEach(async () => {
  await sql.query("DELETE FROM content_items");
  await sql.query("DELETE FROM content_imports");
  await sql.query("DELETE FROM admin_audit WHERE action IN ('content_prepare', 'content_import', 'content_media_link', 'content_retire', 'content_restore')");
  sheet = await clientSheet(6);
  const res = await upload(sheet);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
});

describe("PUT .../preparation: gate and shape", () => {
  const body = () => ({ version: 1, stage: "missing_photo", evidence: evidence(), mediaId: null });

  it("401 without a token; 403 for a player and for a photographer", async () => {
    expect((await request(app.server).put(`${ITEM("mil-a1")}/preparation`).send(body())).status).toBe(401);
    expect((await prepare("mil-a1", body(), app, fx.player.auth as Record<string, string>)).status).toBe(403);
    expect((await prepare("mil-a1", body(), app, fx.owner.auth as Record<string, string>)).status).toBe(403);
    expect((await row("mil-a1")).version).toBe(1);
  });

  it("any other module, an unknown module, an unknown item and an over-long id are 404", async () => {
    expect((await request(app.server).put("/v1/admin/content/airport-spotter/items/mil-a1/preparation").set(admin()).send(body())).status).toBe(404);
    expect((await request(app.server).put("/v1/admin/content/atc-match/items/mil-a1/preparation").set(admin()).send(body())).status).toBe(404);
    expect((await prepare("mil-a99", body())).status).toBe(404);
    expect((await prepare("x".repeat(200), body())).status).toBe(404);
    expect(await audits()).toHaveLength(0);
  });

  it("the body is strict: answer-like fields, extra keys and malformed values are 400", async () => {
    const bad: unknown[] = [
      {},
      { ...body(), extra: 1 },
      { ...body(), evidence: { ...evidence(), answer: "x" } },
      { ...body(), evidence: { ...evidence(), distractors: [] } },
      { ...body(), evidence: { ...evidence(), hint: "x" } },
      { ...body(), evidence: { ...evidence(), photoSource: "submission" } },
      { ...body(), stage: "done" },
      { ...body(), mediaId: "x" },
      { ...body(), version: 0 },
    ];
    for (const b of bad) {
      const res = await prepare("mil-a1", b as Record<string, unknown>);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    expect((await row("mil-a1")).version).toBe(1);
  });
});

describe("saving a preparation", () => {
  it("stores stage, evidence and media in one write: version + 1, prep_version = the new version, one audit row, source admin", async () => {
    const media = await fx.publishedMedia();
    const res = await prepare("mil-a2", { version: 1, stage: "rights_checked", evidence: evidence(), mediaId: media.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.item).toMatchObject({ id: "mil-a2", version: 2, source: "admin", mediaId: media.id, preparation: { stage: "rights_checked", stale: false } });
    expect(res.body.item.preparation.evidence).toEqual(evidence());
    expect(await row("mil-a2")).toMatchObject({ version: 2, prep_version: 2, prep_stage: "rights_checked", media_id: media.id.slice(4), source: "admin", updated_by: fx.admin.principal });
    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: fx.admin.principal, action: "content_prepare", target: MODULE });
    expect(log[0]!.detail).toEqual({
      id: "mil-a2",
      fromVersion: 1,
      version: 2,
      fromStage: null,
      stage: "rights_checked",
      media: { from: null, to: media.id },
      fields: ["stage", "evidence.photoSource", "evidence.permission", "evidence.attribution", "media"],
    });
    expect(JSON.stringify(log[0]!.detail)).not.toContain("Client supplied"); // fields only, never the text
    expect((await row("mil-a3")).version).toBe(1);
  });

  it("a stale version is 409 version_conflict and writes nothing; two saves with one version have one winner", async () => {
    const media = await fx.publishedMedia();
    expect((await save("mil-a1", "rights_checked", media)).status).toBe(200);
    const stale = await prepare("mil-a1", { version: 1, stage: "rights_checked", evidence: evidence({ notes: "late" }), mediaId: media.id });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect((await row("mil-a1")).version).toBe(2);
    expect(await audits()).toHaveLength(1);

    const [a, b] = await Promise.all([
      prepare("mil-a4", { version: 1, stage: "rights_checked", evidence: evidence({ notes: "a" }), mediaId: media.id }),
      prepare("mil-a4", { version: 1, stage: "rights_checked", evidence: evidence({ notes: "b" }), mediaId: media.id }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await row("mil-a4")).version).toBe(2);
    expect(await audits()).toHaveLength(2);
  });

  it("an unchanged save writes nothing: no bump, no audit row", async () => {
    const media = await fx.publishedMedia();
    const first = await save("mil-a1", "rights_checked", media);
    const again = await prepare("mil-a1", { version: 2, stage: "rights_checked", evidence: evidence(), mediaId: media.id });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ changed: false, item: { version: 2, preparation: { stale: false } } });
    expect(first.body.item.updatedAt).toBe(again.body.item.updatedAt);
    expect((await row("mil-a1")).version).toBe(2);
    expect(await audits()).toHaveLength(1);
  });

  it("moves forward one stage at a time and may step back to any earlier stage", async () => {
    const media = await fx.publishedMedia();
    const skip = await save("mil-a1", "content_prepared", media);
    expect(skip.status).toBe(422);
    expect(skip.body.error.code).toBe("content_invalid");
    expect(skip.body.errors).toEqual(["Move to Rights checked before Content prepared."]);
    for (const stage of ["rights_checked", "content_prepared", "previewed", "approved"]) {
      const res = await save("mil-a1", stage, media);
      expect(res.status, `${stage}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.item.preparation.stage).toBe(stage);
    }
    expect((await row("mil-a1")).version).toBe(5);
    const back = await save("mil-a1", "rights_checked", media);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.item.preparation.stage).toBe("rights_checked");
    const down = await save("mil-a1", "missing_photo", media);
    expect(down.status).toBe(200);
    expect((await audits()).map((a) => a.detail.stage)).toEqual(["rights_checked", "content_prepared", "previewed", "approved", "rights_checked", "missing_photo"]);
  });

  it("the stage rules are cumulative and every reason is listed at once", async () => {
    const media = await fx.publishedMedia();
    const res = await prepare("mil-a1", { version: 1, stage: "rights_checked", evidence: evidence({ permission: "short", attribution: "" }), mediaId: media.id });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(["Record the permission or license terms in at least 10 characters.", "Add the attribution to display."]);
    const noMedia = await prepare("mil-a1", { version: 1, stage: "rights_checked", evidence: evidence(), mediaId: null });
    expect(noMedia.body.errors).toEqual(["Link the backend photo that supplies the photograph."]);
    // licensed needs an https licenseUrl; a linked photo is optional (guarded if set)
    const licensed = await prepare("mil-a1", { version: 1, stage: "rights_checked", evidence: evidence({ photoSource: "licensed", licenseUrl: "https://example.com/licence" }), mediaId: null });
    expect(licensed.status, JSON.stringify(licensed.body)).toBe(200);
    expect(await audits()).toHaveLength(1);
  });

  it("an approved package cannot change evidence or photo in place; stepping back to previewed first works", async () => {
    const media = await fx.publishedMedia();
    const other = await fx.publishedMedia();
    for (const stage of ["rights_checked", "content_prepared", "previewed", "approved"]) expect((await save("mil-a1", stage, media)).status).toBe(200);
    const version = (await itemOf("mil-a1")).version;
    const edit = await prepare("mil-a1", { version, stage: "approved", evidence: evidence({ referenceUrl: "https://example.com/ref", checklist: full, notes: "edit" }), mediaId: media.id });
    expect(edit.status).toBe(422);
    expect(edit.body.errors).toEqual(["Step an approved package back to Previewed before changing it."]);
    const relink = await prepare("mil-a1", { version, stage: "approved", evidence: evidence({ referenceUrl: "https://example.com/ref", checklist: full }), mediaId: other.id });
    expect(relink.status).toBe(422);
    expect((await itemOf("mil-a1")).version).toBe(version);
    const same = await prepare("mil-a1", { version, stage: "approved", evidence: evidence({ referenceUrl: "https://example.com/ref", checklist: full }), mediaId: media.id });
    expect(same.body.changed).toBe(false);
    const back = await save("mil-a1", "previewed", media, { notes: "edit" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
  });
});

describe("the media guard", () => {
  it("from rights_checked the photo must be published: unverified and withdrawn photos are 422, a published one is saved", async () => {
    const draft = await fx.upload();
    const res = await prepare("mil-a1", { version: 1, stage: "rights_checked", evidence: evidence(), mediaId: draft.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("content_invalid");
    expect(res.body.errors).toEqual([NOT_PUBLISHED_MESSAGE]);

    const gone = await fx.publishedMedia();
    await fx.withdraw(gone.id, gone.revision);
    expect((await prepare("mil-a1", { version: 1, stage: "rights_checked", evidence: evidence(), mediaId: gone.id })).body.errors).toEqual([NOT_PUBLISHED_MESSAGE]);
    expect((await row("mil-a1")).version).toBe(1);
    expect(await audits()).toHaveLength(0);

    const ok = await fx.publishedMedia();
    expect((await prepare("mil-a1", { version: 1, stage: "rights_checked", evidence: evidence(), mediaId: ok.id })).status).toBe(200);
  });

  it("at missing_photo any existing photo may be linked (no guard); an unknown photo is still refused", async () => {
    const draft = await fx.upload();
    const res = await prepare("mil-a1", { version: 1, stage: "missing_photo", evidence: evidence(), mediaId: draft.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.item.mediaId).toBe(draft.id);
    const unknown = await prepare("mil-a2", { version: 1, stage: "missing_photo", evidence: evidence(), mediaId: "med-999999999" });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors).toEqual(["No such media item."]);
    // ... and the save at missing_photo with no photo unlinks it.
    const unlink = await prepare("mil-a1", { version: 2, stage: "missing_photo", evidence: evidence(), mediaId: null });
    expect(unlink.body.item.mediaId).toBeNull();
  });

  it("an unpublished photo linked at missing_photo cannot be carried into rights_checked", async () => {
    const draft = await fx.upload();
    expect((await prepare("mil-a1", { version: 1, stage: "missing_photo", evidence: evidence(), mediaId: draft.id })).status).toBe(200);
    const res = await prepare("mil-a1", { version: 2, stage: "rights_checked", evidence: evidence(), mediaId: draft.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("content_invalid");
    expect(res.body.errors).toEqual([NOT_PUBLISHED_MESSAGE]);
    expect((await row("mil-a1")).prep_stage).toBe("missing_photo");
  });

  it("a demo-owned photo is refused from rights_checked", async () => {
    const media = await fx.publishedMedia(); // owned by fx.owner, which demoApp treats as the shared demo account
    const refused = await prepare("mil-a1", { version: 1, stage: "rights_checked", evidence: evidence(), mediaId: media.id }, demoApp);
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual(["The linked photo belongs to the shared demo account and cannot be used."]);
    expect((await prepare("mil-a1", { version: 1, stage: "rights_checked", evidence: evidence(), mediaId: media.id })).status).toBe(200);
  });
});

describe("PUT .../items/:id/media is guarded at stage rights_checked and later only", () => {
  it("with no preparation or at missing_photo any existing media links, as before", async () => {
    const draft = await fx.upload();
    const res = await link("mil-a1", { mediaId: draft.id, expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // missing_photo stage
    const prep = await prepare("mil-a1", { version: 2, stage: "missing_photo", evidence: evidence(), mediaId: draft.id });
    expect(prep.status).toBe(200);
    const other = await fx.upload();
    expect((await link("mil-a1", { mediaId: other.id, expectedVersion: 3 })).status).toBe(200);
  });

  it("from rights_checked an unpublished, withdrawn or demo-owned photo is 422 content_invalid with errors; a published one links", async () => {
    const media = await fx.publishedMedia();
    expect((await save("mil-a1", "rights_checked", media)).status).toBe(200);
    const draft = await fx.upload();
    const bad = await link("mil-a1", { mediaId: draft.id, expectedVersion: 2 });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("content_invalid");
    expect(bad.body.errors).toEqual([NOT_PUBLISHED_MESSAGE]);
    const gone = await fx.publishedMedia();
    await fx.withdraw(gone.id, gone.revision);
    expect((await link("mil-a1", { mediaId: gone.id, expectedVersion: 2 })).body.errors).toEqual([NOT_PUBLISHED_MESSAGE]);
    const owned = await fx.publishedMedia(); // fx.owner is the demo account in demoApp
    const demo = await link("mil-a1", { mediaId: owned.id, expectedVersion: 2 }, demoApp);
    expect(demo.status).toBe(422);
    expect(demo.body.errors).toEqual(["The linked photo belongs to the shared demo account and cannot be used."]);
    expect((await row("mil-a1")).version).toBe(2);
    expect(await audits("content_media_link")).toHaveLength(0);

    const next = await fx.publishedMedia();
    const ok = await link("mil-a1", { mediaId: next.id, expectedVersion: 2 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.item.mediaId).toBe(next.id);
    // the relink bumped the version past prep_version: the preparation is stale
    expect(ok.body.item.preparation).toMatchObject({ stage: "rights_checked", stale: true });
    // unlinking is never guarded
    expect((await link("mil-a1", { mediaId: null, expectedVersion: 3 })).status).toBe(200);
  });
});

describe("GET .../items carries the preparation", () => {
  it("is null for an item never prepared and { stage, evidence, stale } after a save", async () => {
    const media = await fx.publishedMedia();
    expect((await save("mil-a2", "rights_checked", media)).status).toBe(200);
    const items = (await list()).body.items as { id: string; preparation: unknown }[];
    expect(items.find((i) => i.id === "mil-a1")!.preparation).toBeNull();
    expect(items.find((i) => i.id === "mil-a2")!.preparation).toEqual({ stage: "rights_checked", evidence: evidence(), stale: false });
  });
});

describe("module lock and staleness", () => {
  it("a save made during the module lock (an import applying) is 409 import_in_progress, then works", async () => {
    const media = await fx.publishedMedia();
    const holder = await sql.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`content-import:${MODULE}`]);
      const res = await prepare("mil-a1", { version: 1, stage: "rights_checked", evidence: evidence(), mediaId: media.id });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("import_in_progress");
      expect((await row("mil-a1")).version).toBe(1);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect((await save("mil-a1", "rights_checked", media)).status).toBe(200);
  });

  it("ASSUMPTION: a sheet re-import that changes an item makes its preparation stale", async () => {
    const media = await fx.publishedMedia();
    for (const id of ["mil-a1", "mil-a2"]) expect((await save(id, "rights_checked", media)).status).toBe(200);
    expect((await itemOf("mil-a1")).preparation!.stale).toBe(false);

    // The client's sheet again with item 1's answer changed (matched by its file name), and item 2 untouched.
    const changed = await clientSheet(6, (rows) => {
      rows[3]![1] = "Changed Aircraft 1";
    });
    const dry = await upload(changed, "?dryRun=true");
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.counts.updated).toBe(1);
    const applied = await upload(changed, `?confirm=${dry.body.planHash}`);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);

    const one = await itemOf("mil-a1");
    expect(one.version).toBe(3);
    expect(one.preparation).toMatchObject({ stage: "rights_checked", stale: true });
    expect((await row("mil-a1")).prep_version).toBe(2);
    const two = await itemOf("mil-a2");
    expect(two.preparation).toMatchObject({ stage: "rights_checked", stale: false });

    // Saving the preparation again (even unchanged) re-confirms it: a write, version + 1, no longer stale.
    const again = await prepare("mil-a1", { version: 3, stage: "rights_checked", evidence: evidence(), mediaId: media.id });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ changed: true, item: { version: 4, preparation: { stale: false } } });
  });

  it("every other staff write (edit, retire, restore) also makes it stale", async () => {
    const media = await fx.publishedMedia();
    expect((await save("mil-a3", "rights_checked", media)).status).toBe(200);
    const retired = await request(app.server).post(`${ITEM("mil-a3")}/retire`).set(admin()).send({ version: 2 });
    expect(retired.status).toBe(200);
    expect(retired.body.item.preparation.stale).toBe(true);
    const restored = await request(app.server).post(`${ITEM("mil-a3")}/restore`).set(admin()).send({ version: 3 });
    expect(restored.body.item.preparation).toMatchObject({ stage: "rights_checked", stale: true });
    const edited = await request(app.server)
      .patch(ITEM("mil-a3"))
      .set(admin())
      .send({ version: 4, rank: "captain" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.item.preparation.stale).toBe(true);
  });

  describe("a stale approved package cannot be re-confirmed in place", () => {
    const approvedEvidence = () => evidence({ referenceUrl: "https://example.com/ref", checklist: full });
    async function approveWith(media: PublishedMedia) {
      for (const stage of ["rights_checked", "content_prepared", "previewed", "approved"]) expect((await save("mil-a1", stage, media)).status).toBe(200);
      return itemOf("mil-a1");
    }
    const reconfirm = async (mediaId: string | null) => {
      const item = await itemOf("mil-a1");
      expect(item.preparation!.stale).toBe(true);
      return prepare("mil-a1", { version: item.version, stage: "approved", evidence: approvedEvidence(), mediaId });
    };

    it("after a relink to another published photo", async () => {
      const a = await fx.publishedMedia();
      const b = await fx.publishedMedia();
      const item = await approveWith(a);
      expect((await link("mil-a1", { mediaId: b.id, expectedVersion: item.version })).status).toBe(200);
      const res = await reconfirm(b.id);
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([STALE_APPROVED_MESSAGE]);
      expect((await row("mil-a1")).media_id).toBe(b.id.slice(4));
    });

    it("after a sheet re-import that changes the item", async () => {
      const a = await fx.publishedMedia();
      await approveWith(a);
      const changed = await clientSheet(6, (rows) => {
        rows[3]![1] = "Changed Aircraft 1";
      });
      const dry = await upload(changed, "?dryRun=true");
      expect((await upload(changed, `?confirm=${dry.body.planHash}`)).status).toBe(201);
      const res = await reconfirm(a.id);
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([STALE_APPROVED_MESSAGE]);
    });

    it("after an edit, and stepping back to previewed then works and clears the stale flag", async () => {
      const a = await fx.publishedMedia();
      const item = await approveWith(a);
      const edit = await request(app.server).patch(ITEM("mil-a1")).set(admin()).send({ version: item.version, rank: "captain" });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      const res = await reconfirm(a.id);
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([STALE_APPROVED_MESSAGE]);
      expect(await audits()).toHaveLength(4);
      const back = await save("mil-a1", "previewed", a);
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      expect(back.body.item.preparation.stale).toBe(false);
    });
  });

  it("re-confirming a stale preparation below approved is a write and the audit row says reconfirmed", async () => {
    const media = await fx.publishedMedia();
    expect((await save("mil-a2", "rights_checked", media)).status).toBe(200);
    expect((await request(app.server).patch(ITEM("mil-a2")).set(admin()).send({ version: 2, rank: "captain" })).status).toBe(200);
    const res = await prepare("mil-a2", { version: 3, stage: "rights_checked", evidence: evidence(), mediaId: media.id });
    expect(res.body).toMatchObject({ changed: true, item: { version: 4, preparation: { stale: false } } });
    const log = await audits();
    expect(log[1]!.detail).toMatchObject({ reconfirmed: true, fields: [], media: null });
    expect(log[0]!.detail).not.toHaveProperty("reconfirmed");
  });

  it("ASSUMPTION: preparation on a retired item is refused", async () => {
    const media = await fx.publishedMedia();
    expect((await request(app.server).post(`${ITEM("mil-a1")}/retire`).set(admin()).send({ version: 1 })).status).toBe(200);
    const res = await prepare("mil-a1", { version: 2, stage: "rights_checked", evidence: evidence(), mediaId: media.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("content_invalid");
    expect(res.body.errors).toEqual([RETIRED_MESSAGE]);
    expect((await row("mil-a1")).prep_stage).toBeNull();
    expect(await audits()).toHaveLength(0);
  });
});

describe("the database refuses a half-set preparation and an unknown stage", () => {
  it("all three prep columns are null or all set, and the stage is one of the five", async () => {
    const attempt = (set: string) => sql.query(`UPDATE content_items SET ${set} WHERE module = $1 AND id = 'mil-a1'`, [MODULE]);
    await expect(attempt("prep_stage = 'approved'")).rejects.toMatchObject({ code: "23514", constraint: "content_items_prep_all_or_none_check" });
    await expect(attempt("prep_stage = 'approved', prep_evidence = '{}'::jsonb")).rejects.toMatchObject({ code: "23514", constraint: "content_items_prep_all_or_none_check" });
    await expect(attempt("prep_version = 1")).rejects.toMatchObject({ code: "23514", constraint: "content_items_prep_all_or_none_check" });
    await expect(attempt("prep_stage = 'done', prep_evidence = '{}'::jsonb, prep_version = 1")).rejects.toMatchObject({ code: "23514", constraint: "content_items_prep_stage_check" });
    await attempt("prep_stage = 'approved', prep_evidence = '{}'::jsonb, prep_version = 1");
    await attempt("prep_stage = NULL, prep_evidence = NULL, prep_version = NULL");
  });
});
