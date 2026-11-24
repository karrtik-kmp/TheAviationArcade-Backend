import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";

// Schema hardening wave (docs/plans/schema-hardening.md), C3: media_versions.updated_at / updated_by, and the freeze of published
// versions. Real HTTP against the real test database; every test uses fresh owners and the suite deletes only its own rows.

const PATH = "/v1/admin/media";
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function png(extra: number): Buffer {
  const ancillary = [...be32(extra), 0x74, 0x45, 0x58, 0x74, ...Array<number>(extra).fill(65), 0, 0, 0, 0];
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(64), ...be32(48), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...ancillary,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}
const fresh = () => png(Math.floor(Math.random() * 1e6) + 1);
const bearer = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid, "demo-airplane-games", "password")}` });
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));

type Actor = { principal: string; auth: { Authorization: string } };
let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;
const principals: string[] = [];

async function actor(role: "photographer" | "admin"): Promise<Actor> {
  const uid = `sh-media-${role}-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  principals.push(principal);
  await seedRole(sql, principal, role);
  return { principal, auth: bearer(uid) };
}

const upload = (who: Actor, statement: string | null = "v1_own") => {
  let req = request(server).post(PATH).set(who.auth).set("Content-Type", "image/png").set("Idempotency-Key", `sh-${randomUUID().slice(0, 12)}`);
  if (statement !== null) req = req.set("X-Rights-Statement", statement);
  return req.send(fresh());
};
const patch = (who: Actor, id: string, body: unknown) => request(server).patch(`${PATH}/${id}`).set(who.auth).send(body as object);
const publish = (who: Actor, id: string, revision: number) => request(server).post(`${PATH}/${id}/publish`).set(who.auth).send({ revision });
const withdraw = (who: Actor, id: string, revision: number) => request(server).post(`${PATH}/${id}/withdraw`).set(who.auth).send({ revision });
const putRights = (who: Actor, id: string, body: unknown) => request(server).put(`${PATH}/${id}/rights`).set(who.auth).send(body as object);
const versionRow = async (id: string, version = 1) =>
  (await sql.query("SELECT * FROM media_versions WHERE media_id = $1 AND version = $2", [Number(id.slice(4)), version])).rows[0];

const LICENCE = { credit: "A. Photographer", licenceName: "CC BY 4.0", licenceUrl: "https://creativecommons.org/licenses/by/4.0/", creditRequired: true };

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
});

afterAll(async () => {
  const owned = "(SELECT id FROM media_items WHERE owner = ANY($1))";
  await sql.query(`DELETE FROM media_upload_keys WHERE media_id IN ${owned}`, [principals]);
  await frozenDelete(sql, "media_versions", `media_id IN ${owned}`, [principals]);
  await sql.query("DELETE FROM media_items WHERE owner = ANY($1)", [principals]);
  await frozenDelete(sql, "admin_audit", "actor = ANY($1)", [principals]);
  await sql.query("DELETE FROM account_roles WHERE principal = ANY($1)", [principals]);
  await sql.end();
  await app.close();
});

describe("C3: media_versions.updated_at / updated_by", () => {
  it("an upload sets updated_at / updated_by equal to created_at / created_by", async () => {
    const owner = await actor("photographer");
    const created = await upload(owner);
    expect(created.status).toBe(201);
    const v = await versionRow(created.body.id);
    expect(v.created_by).toBe(owner.principal);
    expect(v.updated_by).toBe(owner.principal);
    expect(v.updated_at.getTime()).toBe(v.created_at.getTime());
  });

  it("an in-place draft edit moves updated_at / updated_by to the acting principal", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const created = await upload(owner);
    const before = await versionRow(created.body.id);
    await pause();
    const edited = await patch(admin, created.body.id, { revision: created.body.revision, licence: LICENCE });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.draftVersion).toBe(1); // in place, no new version
    const after = await versionRow(created.body.id);
    expect(after.updated_by).toBe(admin.principal);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after.created_by).toBe(owner.principal);
    expect(after.created_at.getTime()).toBe(before.created_at.getTime());
    expect(after.licence_name).toBe("CC BY 4.0"); // the draft really was edited through the API
  });

  it("stating rights moves updated_at / updated_by to the acting principal", async () => {
    const owner = await actor("photographer");
    const created = await upload(owner);
    expect(created.status).toBe(201);
    // An old-style draft with no statement (the API always takes one on upload); a draft is editable, so raw SQL may clear it.
    await sql.query("UPDATE media_versions SET rights_statement = NULL, rights_stated_by = NULL, rights_stated_at = NULL WHERE media_id = $1", [Number(created.body.id.slice(4))]);
    const before = await versionRow(created.body.id);
    expect(before.rights_statement).toBeNull();
    await pause();
    const res = await putRights(owner, created.body.id, { revision: created.body.revision, statement: "v1_own" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await versionRow(created.body.id);
    expect(after.rights_statement).toBe("v1_own");
    expect(after.updated_by).toBe(owner.principal);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it("publishing a never-published draft sets published_at and updated_at / updated_by (the publisher)", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const created = await upload(owner);
    const edited = await patch(owner, created.body.id, { revision: created.body.revision, licence: LICENCE });
    const before = await versionRow(created.body.id);
    expect(before.published_at).toBeNull();
    await pause();
    const res = await publish(admin, created.body.id, edited.body.revision);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await versionRow(created.body.id);
    expect(after.published_at).not.toBeNull();
    expect(after.published_at.toISOString()).toBe(res.body.draft.publishedAt);
    expect(after.updated_by).toBe(admin.principal);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it("re-publishing a withdrawn version leaves the version row untouched and the API still shows the original published_at", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const other = await actor("admin");
    const created = await upload(owner);
    const edited = await patch(owner, created.body.id, { revision: created.body.revision, licence: LICENCE });
    const live = await publish(admin, created.body.id, edited.body.revision);
    expect(live.status).toBe(200);
    const originalPublishedAt = live.body.draft.publishedAt as string;
    const gone = await withdraw(admin, created.body.id, live.body.revision);
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    const frozen = await versionRow(created.body.id);
    await pause();
    const again = await publish(other, created.body.id, gone.body.revision);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.state).toBe("published");
    expect(again.body.draft.publishedAt).toBe(originalPublishedAt);
    const after = await versionRow(created.body.id);
    expect(after).toEqual(frozen); // not one column of the version row changed
    expect(after.published_at.toISOString()).toBe(originalPublishedAt);
    expect(after.updated_by).toBe(admin.principal); // the first publisher, not `other`
  });

  it("the app can never update or delete a published version (23001), while a draft stays editable through the API", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const created = await upload(owner);
    const edited = await patch(owner, created.body.id, { revision: created.body.revision, licence: LICENCE });
    const id = Number(created.body.id.slice(4));
    // A draft is still editable (API and raw SQL both).
    const again = await patch(owner, created.body.id, { revision: edited.body.revision, licence: { credit: "Edited draft" } });
    expect(again.status).toBe(200);
    expect((await versionRow(created.body.id)).credit_name).toBe("Edited draft");
    await expect(sql.query("UPDATE media_versions SET description = 'x' WHERE media_id = $1", [id])).resolves.toBeDefined();

    const live = await publish(admin, created.body.id, again.body.revision);
    expect(live.status).toBe(200);
    const before = await versionRow(created.body.id);
    await expect(sql.query("UPDATE media_versions SET description = 'y' WHERE media_id = $1 AND version = 1", [id])).rejects.toMatchObject({ code: "23001" });
    await expect(sql.query("UPDATE media_versions SET published_at = NULL WHERE media_id = $1 AND version = 1", [id])).rejects.toMatchObject({ code: "23001" });
    await expect(sql.query("DELETE FROM media_versions WHERE media_id = $1 AND version = 1", [id])).rejects.toMatchObject({ code: "23001" });
    expect(await versionRow(created.body.id)).toEqual(before);
  });
});



