import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Fixtures, STAFF_MEDIA, boot, goodData } from "./editorial-helpers.js";
import type { Booted } from "./editorial-helpers.js";

// DEV_DEMO_WAIVER=dev-demo (docs/plans/dev-licence-waiver.md): a photo may go live with no licence name and a Plane of the Day item
// with no factual source. Two apps on the same test database: one built from an environment with the switch on (APP_ENV=test with
// the demo project, the startup guard's test exemption), one without. The waiver is in the database column and the audit details only;
// no API response carries it.

const POTD = "plane-of-the-day";
const IDENT = "identifier";
const desk = (kind: string) => `/v1/admin/editorial/${kind}/items`;

let on: Booted;
let off: Booted;
let sql: pg.Pool;
let fx: Fixtures;

async function bootWith(waiver: string | undefined): Promise<Booted> {
  const before = process.env.DEV_DEMO_WAIVER;
  if (waiver === undefined) delete process.env.DEV_DEMO_WAIVER;
  else process.env.DEV_DEMO_WAIVER = waiver;
  try {
    return await boot();
  } finally {
    if (before === undefined) delete process.env.DEV_DEMO_WAIVER;
    else process.env.DEV_DEMO_WAIVER = before;
  }
}

const num = (id: string) => Number(id.slice(4));
const publishOn = (b: Booted, id: string, revision: number) => request(b.server).post(`${STAFF_MEDIA}/${id}/publish`).set(fx.admin.auth).send({ revision });
const withdrawOn = (b: Booted, id: string, revision: number) => request(b.server).post(`${STAFF_MEDIA}/${id}/withdraw`).set(fx.admin.auth).send({ revision });
const versionRow = async (id: string, version = 1) =>
  (await sql.query("SELECT licence_name, licence_waiver, published_at FROM media_versions WHERE media_id = $1 AND version = $2", [num(id), version])).rows[0] as
    | { licence_name: string | null; licence_waiver: string | null; published_at: Date | null }
    | undefined;
const audit = async (action: string, target: string) =>
  (await sql.query("SELECT detail FROM admin_audit WHERE action = $1 AND target = $2 ORDER BY id", [action, target])).rows.map((r) => r.detail as Record<string, unknown>);

/** An uploaded photo with a credit and no licence name (what the seed's Identifier and Plane of the Day photos look like). */
async function unlicensed(): Promise<{ id: string; revision: number }> {
  const item = await fx.upload();
  return { id: item.id, revision: await fx.editLicence(item.id, item.revision, { credit: "Credit X" }) };
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  on = await bootWith("dev-demo");
  off = await bootWith(undefined);
  fx = new Fixtures(sql, () => on.server);
  await fx.init();
});

afterAll(async () => {
  await fx.cleanup();
  await sql.end();
  await on.app.close();
  await off.app.close();
});

describe("publishing a photo with no licence name", () => {
  it("without the switch: 422 and nothing is written; with it: 200, the version carries the waiver, the audit says so, the API does not", async () => {
    const photo = await unlicensed();
    const refused = await publishOn(off, photo.id, photo.revision);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("content_invalid");
    expect(await versionRow(photo.id)).toMatchObject({ licence_name: null, licence_waiver: null, published_at: null });
    expect(await audit("media_publish", photo.id)).toEqual([]);

    const ok = await publishOn(on, photo.id, photo.revision);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await versionRow(photo.id)).toMatchObject({ licence_name: null, licence_waiver: "dev-demo" });
    expect((await versionRow(photo.id))!.published_at).not.toBeNull();
    const [detail] = await audit("media_publish", photo.id);
    expect(detail).toMatchObject({ publishedVersion: 1, licenceWaived: "dev-demo" });
    const staff = await request(on.server).get(`${STAFF_MEDIA}/${photo.id}`).set(fx.admin.auth);
    expect(staff.status).toBe(200);
    expect(JSON.stringify(staff.body)).not.toMatch(/licenceWaiv|licence_waiv|dev-demo/);
    expect(JSON.stringify(ok.body)).not.toMatch(/licenceWaiv|licence_waiv|dev-demo/);
  });

  it("a draft with a licence name never gets the waiver, switch on or not", async () => {
    const item = await fx.upload();
    const revision = await fx.editLicence(item.id, item.revision, { credit: "Credit Y", licenceName: "CC BY 4.0" });
    expect((await publishOn(on, item.id, revision)).status).toBe(200);
    expect(await versionRow(item.id)).toMatchObject({ licence_name: "CC BY 4.0", licence_waiver: null });
    expect(await audit("media_publish", item.id)).toEqual([expect.not.objectContaining({ licenceWaived: expect.anything() })]);
  });

  it("withdraw and republish keep the waiver and the first published_at; with the switch off the republish is 422 and writes nothing", async () => {
    const photo = await unlicensed();
    const first = await publishOn(on, photo.id, photo.revision);
    expect(first.status).toBe(200);
    const publishedAt = (await versionRow(photo.id))!.published_at;
    const withdrawn = await withdrawOn(on, photo.id, first.body.revision);
    expect(withdrawn.status).toBe(200);

    const refused = await publishOn(off, photo.id, withdrawn.body.revision);
    expect(refused.status).toBe(422);
    expect(await audit("media_publish", photo.id)).toHaveLength(1);
    const state = await request(off.server).get(`${STAFF_MEDIA}/${photo.id}`).set(fx.admin.auth);
    expect(state.body.item.state).toBe("withdrawn");

    const again = await publishOn(on, photo.id, withdrawn.body.revision);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const row = await versionRow(photo.id);
    expect(row).toMatchObject({ licence_name: null, licence_waiver: "dev-demo" });
    expect(row!.published_at!.getTime()).toBe(publishedAt!.getTime());
  });

  it("editing a waived published version makes a new draft with no waiver; its publish needs a licence again when the switch is off", async () => {
    const photo = await unlicensed();
    const live = await publishOn(on, photo.id, photo.revision);
    expect(live.status).toBe(200);
    const edited = await request(on.server).patch(`${STAFF_MEDIA}/${photo.id}`).set(fx.admin.auth).send({ revision: live.body.revision, licence: { credit: "Credit Z" } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(await versionRow(photo.id, 1)).toMatchObject({ licence_waiver: "dev-demo" });
    expect(await versionRow(photo.id, 2)).toMatchObject({ licence_name: null, licence_waiver: null, published_at: null });
    expect((await publishOn(off, photo.id, edited.body.revision)).status).toBe(422);
    expect(await versionRow(photo.id, 2)).toMatchObject({ licence_waiver: null, published_at: null });
  });
});

describe("the database CHECKs", () => {
  it("refuse a waiver next to a licence name, an unwaived publish with neither, and another waiver value", async () => {
    const photo = await unlicensed();
    const set = (cols: string) => sql.query(`UPDATE media_versions SET ${cols} WHERE media_id = $1 AND version = 1`, [num(photo.id)]);
    const code = async (run: Promise<unknown>) => {
      try {
        await run;
        return null;
      } catch (e) {
        return (e as { constraint?: string }).constraint ?? "unknown";
      }
    };
    expect(await code(set("licence_name = 'CC0', licence_waiver = 'dev-demo', published_at = now()"))).toBe("media_versions_licence_waiver_rule_check");
    expect(await code(set("licence_waiver = 'dev-demo'"))).toBe("media_versions_licence_waiver_rule_check"); // never published
    expect(await code(set("licence_waiver = 'other', published_at = now()"))).toBe("media_versions_licence_waiver_check");
    expect(await code(set("published_at = now()"))).toBe("media_versions_publishable_check"); // neither a licence nor a waiver
    expect(await versionRow(photo.id)).toMatchObject({ licence_name: null, licence_waiver: null, published_at: null });
  });
});

describe("Plane of the Day with no factual source", () => {
  async function potdDraft(): Promise<{ id: string; version: number }> {
    const photo = await unlicensed();
    expect((await publishOn(on, photo.id, photo.revision)).status).toBe(200); // the photo goes live under the waiver
    const res = await request(on.server).post(desk(POTD)).set(fx.admin.auth).send({ mediaId: photo.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201); // a draft can be made from the waived photo
    return { id: res.body.item.id, version: res.body.item.version };
  }
  const save = (b: Booted, kind: string, item: { id: string; version: number }, over: Record<string, unknown>) =>
    request(b.server).put(`${desk(kind)}/${item.id}`).set(fx.admin.auth).send({ version: item.version, status: "published", dateKey: "2026-11-05", data: goodData({ factualSource: "" }), ...over });
  const saveAudit = async (id: string) =>
    (await sql.query("SELECT detail FROM admin_audit WHERE action = 'editorial_save' AND detail->>'id' = $1 ORDER BY id", [id])).rows.map((r) => r.detail as Record<string, unknown>);

  it("with the switch an empty source publishes and schedules, and the audit says so; the source stays empty", async () => {
    const published = await potdDraft();
    const res = await save(on, POTD, published, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.item.status).toBe("published");
    expect(res.body.item.data.factualSource).toBe("");
    expect(await saveAudit(published.id)).toEqual([expect.objectContaining({ status: "published", factualSourceWaived: "dev-demo" })]);

    const scheduled = await potdDraft();
    const sched = await save(on, POTD, scheduled, { status: "scheduled", dateKey: "2999-01-01" });
    expect(sched.status, JSON.stringify(sched.body)).toBe(200);
    expect((await saveAudit(scheduled.id))[0]).toMatchObject({ status: "scheduled", factualSourceWaived: "dev-demo" });
  });

  it("a draft save, and a save with an https source, carry no waiver flag", async () => {
    const item = await potdDraft();
    const draft = await save(on, POTD, item, { status: "draft", dateKey: null });
    expect(draft.status).toBe(200);
    const withSource = await save(on, POTD, { id: item.id, version: draft.body.item.version }, { data: goodData({ factualSource: "https://example.com/s" }) });
    expect(withSource.status, JSON.stringify(withSource.body)).toBe(200);
    for (const detail of await saveAudit(item.id)) expect(detail).not.toHaveProperty("factualSourceWaived");
  });

  it("a non-empty source that is not https is still 422, switch on", async () => {
    const item = await potdDraft();
    for (const factualSource of ["http://example.com/s", "example.com"]) {
      const res = await save(on, POTD, item, { data: goodData({ factualSource }) });
      expect(res.status, factualSource).toBe(422);
      expect(res.body.error.code).toBe("content_invalid");
    }
    expect(await saveAudit(item.id)).toEqual([]);
  });

  it("the Aircraft Identifier kind still needs a source, switch on", async () => {
    const photo = await unlicensed();
    expect((await publishOn(on, photo.id, photo.revision)).status).toBe(200);
    const created = await request(on.server).post(desk(IDENT)).set(fx.admin.auth).send({ mediaId: photo.id });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const res = await save(on, IDENT, { id: created.body.item.id, version: created.body.item.version }, { dateKey: null });
    expect(res.status).toBe(422);
  });

  it("without the switch an empty source is 422 as today", async () => {
    const item = await potdDraft();
    const res = await save(off, POTD, item, {});
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("https factual source");
    expect(await saveAudit(item.id)).toEqual([]);
  });
});
