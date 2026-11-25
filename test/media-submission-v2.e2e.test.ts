import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { submissionDigest } from "../src/content/media/media-submission.js";
import { MEDIA_V2_LICENCE_NAME, MEDIA_V2_STATEMENT } from "../src/db/enums.js";
import { BLOB_STORE } from "../src/storage/blob-store.js";
import type { BlobStore } from "../src/storage/blob-store.js";
import { demoPrincipal, seedRole } from "./roles-helpers.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { emulatorToken } from "./tokens.js";

// Photo submission v2 (docs/plans/photo-submission-v2.md, migration 0028, API 0.29.0): X-Submission on uploads, the v2 move through
// PUT rights, the PATCH submission fields, the publish gate, privacy and the access log. Roles are seeded in account_roles; the blob
// store is the in-process MemoryBlobStore. Every test uses fresh owners and the suite deletes only its own rows.

const PATH = "/v1/admin/media";
const V2 = MEDIA_V2_STATEMENT;
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A minimal valid PNG; `extra` varies the bytes (an ancillary chunk after IHDR). */
function png(extra: number): Buffer {
  const ancillary = [...be32(extra), 0x74, 0x45, 0x58, 0x74, ...Array<number>(extra).fill(65), 0, 0, 0, 0];
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(64), ...be32(48), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...ancillary,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

const bearer = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid, "demo-airplane-games", "password")}` });
let keyCounter = 0;
const newKey = () => `s2-${randomUUID().slice(0, 8)}-${keyCounter++}`;
let bytesCounter = 0;
const freshPng = () => png(3000 + ++bytesCounter + Math.floor(Math.random() * 1e5) * 10);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const idOf = (id: string) => Number(id.slice(4));
const enc = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64url");

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;
const principals: string[] = [];

type Actor = { uid: string; principal: string; auth: { Authorization: string } };

async function actor(role: "photographer" | "admin" | null): Promise<Actor> {
  const uid = `mediasub-${role ?? "none"}-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  principals.push(principal);
  if (role) await seedRole(sql, principal, role);
  return { uid, principal, auth: bearer(uid) };
}

const NAME = "Zoë Ångström";
const SUB = { fullName: NAME, title: "Sunrise over LAX", credit: "Z. Ångström", instagramHandle: "zoe.flies", instagramDisplayConsent: true };
const SUB_MIN = { fullName: "Pat Plain", title: "Ramp at dusk", credit: "P. Plain" };

type Item = {
  id: string;
  state: string;
  revision: number;
  draftVersion: number;
  publishedVersion: number | null;
  draft: Record<string, any>;
  submission: { fullName: string | null; instagramHandle: string | null; instagramDisplayConsent: boolean } | null;
  owner?: string;
};

const upload = (who: Actor, bytes: Buffer, o: { key?: string; statement?: string | null; submission?: unknown; header?: string | null } = {}) => {
  let req = request(server).post(PATH).set(who.auth).set("Content-Type", "image/png").set("Idempotency-Key", o.key ?? newKey());
  const statement = o.statement === undefined ? V2 : o.statement;
  if (statement !== null) req = req.set("X-Rights-Statement", statement);
  const header = o.header === undefined ? (o.submission === null ? null : enc(o.submission ?? SUB)) : o.header;
  if (header !== null) req = req.set("X-Submission", header);
  return req.send(bytes);
};
const addVersion = (who: Actor, id: string, revision: number, bytes: Buffer, o: { key?: string; statement?: string; submission?: unknown } = {}) => {
  const statement = o.statement ?? V2;
  let req = request(server).post(`${PATH}/${id}/versions?revision=${revision}`).set(who.auth).set("Content-Type", "image/png").set("Idempotency-Key", o.key ?? newKey()).set("X-Rights-Statement", statement);
  if (statement === V2) req = req.set("X-Submission", enc(o.submission ?? SUB));
  return req.send(bytes);
};
const uploadV1 = (who: Actor, key = newKey()) =>
  request(server).post(PATH).set(who.auth).set("Content-Type", "image/png").set("Idempotency-Key", key).set("X-Rights-Statement", "v1_own").send(freshPng());
const patch = (who: Actor, id: string, body: unknown) => request(server).patch(`${PATH}/${id}`).set(who.auth).send(body as object);
const publish = (who: Actor, id: string, body: unknown) => request(server).post(`${PATH}/${id}/publish`).set(who.auth).send(body as object);
const putRights = (who: Actor, id: string, body: unknown) => request(server).put(`${PATH}/${id}/rights`).set(who.auth).send(body as object);
const detail = (who: Actor, id: string) => request(server).get(`${PATH}/${id}`).set(who.auth);
const list = (who: Actor, query = "") => request(server).get(`${PATH}${query}`).set(who.auth);

/** Every item of a list query, following nextCursor to the end, so an assertion never depends on the page size or on other files' rows. */
async function listAll(who: Actor, query = ""): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | null = null;
  do {
    const sep = query.includes("?") ? "&" : "?";
    const res: request.Response = await list(who, `${query}${sep}limit=100${cursor ? `&cursor=${cursor}` : ""}`);
    expect(res.status).toBe(200);
    items.push(...(res.body.items as Item[]));
    cursor = res.body.nextCursor ?? null;
  } while (cursor);
  return items;
}

const FULL_LICENCE = { credit: "A. Photographer", licenceName: "CC BY 4.0", licenceUrl: "https://creativecommons.org/licenses/by/4.0/", creditRequired: true };

/** A v1 item with a publishable licence (unpublished). */
async function v1Item(owner: Actor): Promise<Item> {
  const created = await uploadV1(owner);
  expect(created.status).toBe(201);
  const edited = await patch(owner, created.body.id, { revision: created.body.revision, licence: FULL_LICENCE });
  expect(edited.status).toBe(200);
  return edited.body as Item;
}

const count = async (table: string, where = "", params: unknown[] = []) =>
  (await sql.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} ${where}`, params)).rows[0]?.n;
const versionsOf = (id: string) => count("media_versions", "WHERE media_id = $1", [idOf(id)]);
const keysOf = (id: string) => count("media_upload_keys", "WHERE media_id = $1", [idOf(id)]);
const auditOf = (id: string, action: string) => count("admin_audit", "WHERE target = $1 AND action = $2", [id, action]);
const itemRow = async (id: string) => (await sql.query("SELECT * FROM media_items WHERE id = $1", [idOf(id)])).rows[0];
const versionJson = async (id: string, version: number) =>
  (await sql.query("SELECT to_jsonb(v) AS j FROM media_versions v WHERE media_id = $1 AND version = $2", [idOf(id), version])).rows[0]?.j;
const submissionRow = async (id: string) => (await sql.query("SELECT * FROM media_submissions WHERE media_id = $1", [idOf(id)])).rows[0];

/** Every key anywhere in a JSON value. */
function keysDeep(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, into));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysDeep(v, into);
    }
  }
  return into;
}

async function violated(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    return err.constraint ?? err.code ?? "unknown";
  }
}

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
  await sql.query(`DELETE FROM media_submissions WHERE media_id IN ${owned}`, [principals]);
  await frozenDelete(sql, "media_versions", `media_id IN ${owned}`, [principals]);
  await sql.query("DELETE FROM media_items WHERE owner = ANY($1)", [principals]);
  await frozenDelete(sql, "admin_audit", "actor = ANY($1)", [principals]);
  await sql.query("DELETE FROM account_roles WHERE principal = ANY($1)", [principals]);
  await sql.end();
  await app.close();
});

describe("v2 upload (POST /v1/admin/media)", () => {
  it("201: title, credit, licence and rights on the version; the submission on the item; the key holds the digest", async () => {
    const photographer = await actor("photographer");
    const res = await upload(photographer, freshPng());
    expect(res.status).toBe(201);
    const item = res.body as Item;
    expect(item.draft).toMatchObject({
      version: 1,
      title: "Sunrise over LAX",
      licence: { credit: "Z. Ångström", licenceName: MEDIA_V2_LICENCE_NAME, licenceUrl: null, sourceUrl: null, attributionText: null, creditRequired: true },
      description: null,
      rights: { statement: V2 },
    });
    expect(item.draft.rights.statedAt).toEqual(expect.any(String));
    expect(item.submission).toEqual({ fullName: NAME, instagramHandle: "zoe.flies", instagramDisplayConsent: true });
    expect(Object.keys(item.draft.rights).sort()).toEqual(["statedAt", "statement"]); // no agreementVersion

    const row = await sql.query("SELECT * FROM media_versions WHERE media_id = $1", [idOf(item.id)]);
    expect(row.rows[0]).toMatchObject({ title: "Sunrise over LAX", credit_name: "Z. Ångström", licence_name: MEDIA_V2_LICENCE_NAME, credit_required: true, rights_statement: V2, rights_stated_by: photographer.principal });
    expect(await submissionRow(item.id)).toMatchObject({ full_name: NAME, instagram_handle: "zoe.flies", instagram_display_consent: true, updated_by: photographer.principal });
    const key = await sql.query("SELECT submission_sha256 FROM media_upload_keys WHERE media_id = $1", [idOf(item.id)]);
    expect(key.rows[0].submission_sha256).toBe(submissionDigest({ ...SUB }));
    const audit = await sql.query("SELECT detail FROM admin_audit WHERE target = $1 AND action = 'media_upload'", [item.id]);
    expect(audit.rows[0].detail).toMatchObject({ rightsStatement: V2 });
  });

  it("a minimal submission defaults the handle to null and consent to false; an @ is stripped and an empty handle is none", async () => {
    const photographer = await actor("photographer");
    const minimal = await upload(photographer, freshPng(), { submission: SUB_MIN });
    expect(minimal.status).toBe(201);
    expect(minimal.body.submission).toEqual({ fullName: "Pat Plain", instagramHandle: null, instagramDisplayConsent: false });
    const at = await upload(photographer, freshPng(), { submission: { ...SUB_MIN, instagramHandle: " @pat.flies " } });
    expect(at.body.submission.instagramHandle).toBe("pat.flies");
    const none = await upload(photographer, freshPng(), { submission: { ...SUB_MIN, instagramHandle: "@" } });
    expect(none.status).toBe(201);
    expect(none.body.submission.instagramHandle).toBeNull();
  });

  it("round-trips a non-ASCII name and title exactly", async () => {
    const photographer = await actor("photographer");
    const wide = { fullName: "山田 太郎 · Ünïcode", title: "Ñandú ✈ 🛩️", credit: "Çredit ©" };
    const res = await upload(photographer, freshPng(), { submission: wide });
    expect(res.status).toBe(201);
    expect(res.body.submission.fullName).toBe(wide.fullName);
    expect(res.body.draft.title).toBe(wide.title);
    expect(res.body.draft.licence.credit).toBe(wide.credit);
    const back = await detail(photographer, res.body.id);
    expect(back.body.item.submission.fullName).toBe(wide.fullName);
  });

  it("every undecodable or invalid X-Submission is 400 invalid_request that never echoes it; nothing is written", async () => {
    const photographer = await actor("photographer");
    const good = Buffer.from(JSON.stringify(SUB));
    const standardB64 = Buffer.from(JSON.stringify({ ...SUB_MIN, fullName: "???>>>" })).toString("base64");
    const body = Buffer.from(JSON.stringify(SUB_MIN));
    const canonical = body.toString("base64url");
    const sibling = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("").find((c) => c !== canonical.at(-1) && Buffer.from(canonical.slice(0, -1) + c, "base64url").equals(body))!;
    const cases: Record<string, string> = {
      plus: enc(good).replace(/./, "+"),
      slash: `${enc(good)}/`,
      padding: `${enc(good)}=`,
      space: `${enc(good)} `,
      standardBase64: standardB64,
      nonCanonicalLastChar: canonical.slice(0, -1) + sibling,
      invalidUtf8: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]).toString("base64url"),
      bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]).toString("base64url"),
      loneSurrogate: enc(`{"fullName":"\\ud800","title":"T","credit":"C"}`),
      over6144: "A".repeat(6145),
      badJson: enc("{not json"),
      notAnObject: enc("[]"),
      unknownKey: enc({ ...SUB_MIN, extra: 1 }),
      longField: enc({ ...SUB_MIN, title: "a".repeat(201) }),
      emptyField: enc({ ...SUB_MIN, credit: "  " }),
      controlChar: enc({ ...SUB_MIN, fullName: "a\u0007b" }),
      badHandle: enc({ ...SUB_MIN, instagramHandle: "not a handle" }),
      consentWithoutHandle: enc({ ...SUB_MIN, instagramDisplayConsent: true }),
      consentWithEmptyHandle: enc({ ...SUB_MIN, instagramHandle: "@", instagramDisplayConsent: true }),
      empty: "",
    };
    for (const [name, header] of Object.entries(cases)) {
      const res = await upload(photographer, freshPng(), { header });
      expect(res.status, name).toBe(400);
      expect(res.body.error.code, name).toBe("invalid_request");
      expect(JSON.stringify(res.body), name).not.toContain(NAME);
      if (header.length > 0) expect(JSON.stringify(res.body), name).not.toContain(header);
    }
    expect(await count("media_items", "WHERE owner = $1", [photographer.principal])).toBe(0);
    expect(await count("media_upload_keys", "WHERE principal = $1", [photographer.principal])).toBe(0);
  });

  it("a missing header with the v2 statement is 400; v1 with any X-Submission is 400; nothing is written", async () => {
    const photographer = await actor("photographer");
    expect((await upload(photographer, freshPng(), { submission: null })).status).toBe(400);
    for (const statement of ["v1_own", "v1_authorised"]) {
      const res = await upload(photographer, freshPng(), { statement, header: enc(SUB) });
      expect(res.status, statement).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
      expect((await upload(photographer, freshPng(), { statement, header: "" })).status).toBe(400);
    }
    const made = await uploadV1(photographer);
    expect(made.status).toBe(201);
    const v1WithHeader = await request(server)
      .post(`${PATH}/${made.body.id}/versions?revision=${made.body.revision}`)
      .set(photographer.auth)
      .set("Content-Type", "image/png")
      .set("Idempotency-Key", newKey())
      .set("X-Rights-Statement", "v1_own")
      .set("X-Submission", enc(SUB))
      .send(freshPng());
    expect(v1WithHeader.status).toBe(400);
    const v2Missing = await request(server)
      .post(`${PATH}/${made.body.id}/versions?revision=${made.body.revision}`)
      .set(photographer.auth)
      .set("Content-Type", "image/png")
      .set("Idempotency-Key", newKey())
      .set("X-Rights-Statement", V2)
      .send(freshPng());
    expect(v2Missing.status).toBe(400);
    expect(await count("media_items", "WHERE owner = $1", [photographer.principal])).toBe(1);
    expect(await versionsOf(made.body.id)).toBe(1);
  });

  it("a header sent twice (joined with ', ' by Node) is 400", async () => {
    const photographer = await actor("photographer");
    const { port } = (server as { address(): AddressInfo }).address();
    const bytes = freshPng();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path: PATH, headers: { ...photographer.auth, "Content-Type": "image/png", "Content-Length": String(bytes.length), "Idempotency-Key": newKey(), "X-Rights-Statement": V2 } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      // Two header lines with the same name.
      req.setHeader("X-Submission", [enc(SUB), enc(SUB)]);
      req.end(bytes);
    });
    expect(status).toBe(400);
    expect(await count("media_items", "WHERE owner = $1", [photographer.principal])).toBe(0);
  });

  it("v1 uploads still work as in 0.28.0 (no submission, title null) and show submission: null", async () => {
    const photographer = await actor("photographer");
    const made = await uploadV1(photographer);
    expect(made.status).toBe(201);
    expect(made.body.submission).toBeNull();
    expect(made.body.draft.title).toBeNull();
    expect(made.body.draft.licence).toMatchObject({ credit: null, licenceName: null, creditRequired: true });
    expect(await submissionRow(made.body.id)).toBeUndefined();
    const key = await sql.query("SELECT submission_sha256 FROM media_upload_keys WHERE media_id = $1", [idOf(made.body.id)]);
    expect(key.rows[0].submission_sha256).toBeNull();
  });
});

describe("v2 replay (Idempotency-Key)", () => {
  it("same bytes, statement and submission: 200 with the same item; reordered JSON keys and a differently spelled handle replay too", async () => {
    const photographer = await actor("photographer");
    const bytes = freshPng();
    const key = newKey();
    const first = await upload(photographer, bytes, { key, submission: SUB });
    expect(first.status).toBe(201);
    const again = await upload(photographer, bytes, { key, submission: SUB });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    const reordered = { instagramDisplayConsent: true, credit: SUB.credit, instagramHandle: "@zoe.flies", title: SUB.title, fullName: ` ${NAME} ` };
    const third = await upload(photographer, bytes, { key, header: enc(JSON.stringify(reordered)) });
    expect(third.status).toBe(200);
    expect(third.body.id).toBe(first.body.id);
    expect(await count("media_items", "WHERE owner = $1", [photographer.principal])).toBe(1);
  });

  it("a different submission, or v1 for the same key and bytes, is 422 idempotency_key_reused", async () => {
    const photographer = await actor("photographer");
    const bytes = freshPng();
    const key = newKey();
    expect((await upload(photographer, bytes, { key })).status).toBe(201);
    for (const other of [{ ...SUB, fullName: "Someone Else" }, { ...SUB, title: "Other" }, { ...SUB, credit: "Other" }, { ...SUB, instagramHandle: "other" }, { ...SUB, instagramDisplayConsent: false }]) {
      const res = await upload(photographer, bytes, { key, submission: other });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("idempotency_key_reused");
    }
    const asV1 = await upload(photographer, bytes, { key, statement: "v1_own", submission: null });
    expect(asV1.status).toBe(422);
    expect(await count("media_items", "WHERE owner = $1", [photographer.principal])).toBe(1);
  });

  it("a v1 upload still replays 200 and a v2 request over a v1 key is 422", async () => {
    const photographer = await actor("photographer");
    const bytes = freshPng();
    const key = newKey();
    const first = await upload(photographer, bytes, { key, statement: "v1_own", submission: null });
    expect(first.status).toBe(201);
    expect((await upload(photographer, bytes, { key, statement: "v1_own", submission: null })).status).toBe(200);
    expect((await upload(photographer, bytes, { key })).status).toBe(422);
  });
});

describe("version uploads and the D6 guard", () => {
  it("v2 on a v1 item and v2 on a v2 item are 201; the submission is replaced and the title and credit come from it", async () => {
    const photographer = await actor("photographer");
    const item = await v1Item(photographer);
    const first = await addVersion(photographer, item.id, item.revision, freshPng(), { submission: SUB });
    expect(first.status).toBe(201);
    expect(first.body.draft).toMatchObject({ version: 2, title: SUB.title, rights: { statement: V2 }, licence: { credit: SUB.credit, licenceName: MEDIA_V2_LICENCE_NAME, creditRequired: true } });
    expect(first.body.submission.fullName).toBe(NAME);
    const next = { ...SUB_MIN, fullName: "Replaced Name" };
    const second = await addVersion(photographer, item.id, first.body.revision, freshPng(), { submission: next });
    expect(second.status).toBe(201);
    expect(second.body.draft.version).toBe(3);
    expect(second.body.submission).toEqual({ fullName: "Replaced Name", instagramHandle: null, instagramDisplayConsent: false }); // fully replaced
    expect(await versionsOf(item.id)).toBe(3);
    expect(await versionJson(item.id, 1)).toMatchObject({ rights_statement: "v1_own", title: null });
  });

  it("v1 on a v2 item is 409 rights_already_stated before storage, with nothing claimed; v1 on a v1 item copies the title forward", async () => {
    const photographer = await actor("photographer");
    const made = await upload(photographer, freshPng());
    const key = newKey();
    const put = vi.spyOn(app.get(BLOB_STORE) as BlobStore, "put");
    const res = await addVersion(photographer, made.body.id, made.body.revision, freshPng(), { statement: "v1_own", key });
    const written = put.mock.calls.length;
    put.mockRestore();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("rights_already_stated");
    expect(written).toBe(0); // refused before any blob was written
    expect(await versionsOf(made.body.id)).toBe(1);
    expect(await count("media_upload_keys", "WHERE principal = $1 AND idempotency_key = $2", [photographer.principal, key])).toBe(0);

    // v1 over v1 copies a title that an edit gave the item
    const v1 = await v1Item(photographer);
    const titled = await patch(photographer, v1.id, { revision: v1.revision, title: "A v1 title" });
    expect(titled.status).toBe(200);
    expect(titled.body.draft.title).toBe("A v1 title");
    const next = await addVersion(photographer, v1.id, titled.body.revision, freshPng(), { statement: "v1_own" });
    expect(next.status).toBe(201);
    expect(next.body.draft).toMatchObject({ version: 2, title: "A v1 title" });
  });

  it("an earlier v1 key replayed after the move to v2 is still 200 (the guard sits after the key lookup)", async () => {
    const photographer = await actor("photographer");
    const bytes = freshPng();
    const key = newKey();
    const first = await upload(photographer, bytes, { key, statement: "v1_own", submission: null });
    expect(first.status).toBe(201);
    const moved = await putRights(photographer, first.body.id, { revision: first.body.revision, statement: V2, submission: SUB });
    expect(moved.status).toBe(200);
    const replay = await upload(photographer, bytes, { key, statement: "v1_own", submission: null });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.draft.rights.statement).toBe(V2); // the item as it is now
    // a NEW v1 upload to the item is refused
    const refused = await addVersion(photographer, first.body.id, moved.body.revision, freshPng(), { statement: "v1_own" });
    expect(refused.status).toBe(409);
  });

  it("an earlier v1 addVersion key replayed after the move to v2 is still 200 (the D6 guard sits after the key lookup)", async () => {
    const photographer = await actor("photographer");
    const item = await v1Item(photographer);
    const bytes = freshPng();
    const key = newKey();
    const first = await addVersion(photographer, item.id, item.revision, bytes, { statement: "v1_own", key });
    expect(first.status).toBe(201);
    const moved = await putRights(photographer, item.id, { revision: first.body.revision, statement: V2, submission: SUB });
    expect(moved.status).toBe(200);
    // same key, same bytes, the OLD revision and the v1 header
    const replay = await addVersion(photographer, item.id, item.revision, bytes, { statement: "v1_own", key });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(item.id);
    expect(replay.body).toEqual((await detail(photographer, item.id)).body.item); // the item as stored now
    expect(replay.body.draft.rights.statement).toBe(V2);
    expect(await versionsOf(item.id)).toBe(3); // upload, the v1 addVersion, the v2 move: the replay adds none
  });

  it("a v1 version upload racing the move to v2 never leaves a v1 draft over v2: either the move or the upload loses", async () => {
    const photographer = await actor("photographer");
    const item = await v1Item(photographer);
    const [a, b] = await Promise.all([
      putRights(photographer, item.id, { revision: item.revision, statement: V2, submission: SUB }),
      addVersion(photographer, item.id, item.revision, freshPng(), { statement: "v1_own" }),
    ]);
    // The row lock serialises them: the move wins (200) and the upload is refused (409), or the upload wins (201) and the move sees a stale revision (409).
    expect([a.status, b.status].sort()).toSatisfy((got: number[]) => (got[0] === 200 && got[1] === 409) || (got[0] === 201 && got[1] === 409));
    // whichever order won, the invariant holds
    const rows = await sql.query("SELECT version, rights_statement FROM media_versions WHERE media_id = $1 ORDER BY version", [idOf(item.id)]);
    const stored = await itemRow(item.id);
    const draft = rows.rows.find((r) => r.version === stored.draft_version);
    const anyV2 = rows.rows.some((r) => r.rights_statement === V2);
    if (anyV2) expect(draft.rights_statement).toBe(V2);
  });
});

describe("PUT /v1/admin/media/{id}/rights with the v2 statement", () => {
  it("over an unpublished v1 draft: a NEW version, the old row unchanged, the statement and licence from the submission", async () => {
    const photographer = await actor("photographer");
    const item = await v1Item(photographer);
    const described = await patch(photographer, item.id, {
      revision: item.revision,
      description: "Keep me",
      licence: { sourceUrl: "https://example.com/src", attributionText: "Attr" },
    });
    const before = await versionJson(item.id, 1);
    const res = await putRights(photographer, item.id, { revision: described.body.revision, statement: V2, submission: SUB });
    expect(res.status).toBe(200);
    expect(res.body.draftVersion).toBe(2);
    expect(res.body.revision).toBe(described.body.revision + 1);
    expect(res.body.draft).toMatchObject({
      version: 2,
      description: "Keep me",
      title: SUB.title,
      rights: { statement: V2 },
      licence: { credit: SUB.credit, licenceName: MEDIA_V2_LICENCE_NAME, licenceUrl: null, sourceUrl: "https://example.com/src", attributionText: "Attr", creditRequired: true },
    });
    expect(res.body.submission).toEqual({ fullName: NAME, instagramHandle: "zoe.flies", instagramDisplayConsent: true });
    expect(await versionJson(item.id, 1)).toEqual(before); // byte-identical, updated_at included
    const v1 = await versionJson(item.id, 1);
    const v2 = await versionJson(item.id, 2);
    expect(v2).toMatchObject({ sha256: v1.sha256, content_type: v1.content_type, byte_size: v1.byte_size, width: v1.width, height: v1.height, rights_stated_by: photographer.principal });
    expect(await versionsOf(item.id)).toBe(2);
  });

  it("audit: version written, fromVersion, previous statement/time/principal, change from/to values for credit, licence and title, flags only for the submission", async () => {
    const photographer = await actor("photographer");
    const item = await v1Item(photographer);
    const stated = await versionJson(item.id, 1);
    const res = await putRights(photographer, item.id, { revision: item.revision, statement: V2, submission: SUB });
    expect(res.status).toBe(200);
    const audit = await sql.query("SELECT actor, detail FROM admin_audit WHERE target = $1 AND action = 'media_rights'", [item.id]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor).toBe(photographer.principal);
    expect(audit.rows[0].detail).toMatchObject({
      version: 2,
      fromVersion: 1,
      newVersion: true,
      statement: V2,
      previousStatement: "v1_own",
      previousStatedBy: photographer.principal,
      revision: res.body.revision,
      changes: {
        credit: { from: "A. Photographer", to: SUB.credit },
        licenceName: { from: "CC BY 4.0", to: MEDIA_V2_LICENCE_NAME },
        licenceUrl: { from: "https://creativecommons.org/licenses/by/4.0/", to: null },
        title: { from: null, to: SUB.title },
      },
      submission: { fullNameChanged: true, instagramChanged: true },
    });
    expect(new Date(audit.rows[0].detail.previousStatedAt).toISOString()).toBe(new Date(stated.rights_stated_at).toISOString());
    const text = JSON.stringify(audit.rows[0].detail);
    expect(text).not.toContain(NAME);
    expect(text).not.toContain("zoe.flies");
  });

  it("over a published v1 version: a new draft, the published row byte-identical, pending, and the admin's publish makes v2 live", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const item = await v1Item(photographer);
    const live = await publish(admin, item.id, { revision: item.revision });
    expect(live.status).toBe(200);
    const before = await versionJson(item.id, 1);
    expect(before.published_at).not.toBeNull();

    const moved = await putRights(photographer, item.id, { revision: live.body.revision, statement: V2, submission: SUB });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ state: "published", publishedVersion: 1, draftVersion: 2 });
    expect(await versionJson(item.id, 1)).toEqual(before);
    expect((await listAll(admin, "?pending=true")).map((i) => i.id)).toContain(item.id);

    const published = await publish(admin, item.id, { revision: moved.body.revision });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ publishedVersion: 2, draftVersion: 2 });
    expect(published.body.draft.rights.statement).toBe(V2);
    expect(published.body.submission.fullName).toBe(NAME);
    expect(await versionJson(item.id, 1)).toEqual(before);
    expect((await listAll(admin, "?pending=true")).map((i) => i.id)).not.toContain(item.id);
  });

  it("over a d1_private_review draft: a new version, the imported row unchanged", async () => {
    const photographer = await actor("photographer");
    // An imported-style item written as raw SQL (the D1 import marks its rows d1_private_review).
    const item = await sql.query<{ id: string }>(
      `INSERT INTO media_items (owner, state, draft_version, published_version, created_by, updated_by, created_at, updated_at)
       VALUES ($1, 'unverified', 1, NULL, $1, $1, clock_timestamp(), clock_timestamp()) RETURNING id`,
      [photographer.principal],
    );
    const id = `med-${item.rows[0]!.id}`;
    const bytes = freshPng();
    await sql.query(
      `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_name, credit_required, licence_name,
          created_by, created_at, updated_at, updated_by, rights_statement, rights_stated_by, rights_stated_at)
       VALUES ($1, 1, $2, 'image/png', $3, 64, 48, 'Imported Credit', true, 'CC BY 4.0', $4, clock_timestamp(), clock_timestamp(), $4, 'd1_private_review', 'system:import', clock_timestamp())`,
      [idOf(id), sha(bytes), bytes.length, photographer.principal],
    );
    const before = await versionJson(id, 1);
    const res = await putRights(photographer, id, { revision: 1, statement: V2, submission: SUB_MIN });
    expect(res.status).toBe(200);
    expect(res.body.draft).toMatchObject({ version: 2, rights: { statement: V2 }, title: SUB_MIN.title });
    expect(await versionJson(id, 1)).toEqual(before);
    const audit = await sql.query("SELECT detail FROM admin_audit WHERE target = $1 AND action = 'media_rights'", [id]);
    expect(audit.rows[0].detail).toMatchObject({ previousStatement: "d1_private_review", previousStatedBy: "system:import" });
  });

  it("over an item with no statement at all (pre-0019 draft): a new version", async () => {
    const photographer = await actor("photographer");
    const item = await sql.query<{ id: string }>(
      `INSERT INTO media_items (owner, state, draft_version, published_version, created_by, updated_by, created_at, updated_at)
       VALUES ($1, 'unverified', 1, NULL, $1, $1, clock_timestamp(), clock_timestamp()) RETURNING id`,
      [photographer.principal],
    );
    const id = `med-${item.rows[0]!.id}`;
    const bytes = freshPng();
    await sql.query(
      `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_required, created_by, created_at, updated_at, updated_by)
       VALUES ($1, 1, $2, 'image/png', $3, 64, 48, true, $4, clock_timestamp(), clock_timestamp(), $4)`,
      [idOf(id), sha(bytes), bytes.length, photographer.principal],
    );
    const res = await putRights(photographer, id, { revision: 1, statement: V2, submission: SUB });
    expect(res.status).toBe(200);
    expect(res.body.draftVersion).toBe(2);
    expect((await versionJson(id, 1)).rights_statement).toBeNull();
  });

  it("v2 over v2 and v1 over v2 are 409 rights_already_stated and change nothing", async () => {
    const photographer = await actor("photographer");
    const made = await upload(photographer, freshPng());
    const revision = made.body.revision;
    for (const body of [
      { revision, statement: V2, submission: SUB_MIN },
      { revision, statement: "v1_own" },
      { revision, statement: "v1_authorised" },
    ]) {
      const res = await putRights(photographer, made.body.id, body);
      expect(res.status, JSON.stringify(body.statement)).toBe(409);
      expect(res.body.error.code).toBe("rights_already_stated");
    }
    expect(await versionsOf(made.body.id)).toBe(1);
    expect((await itemRow(made.body.id)).revision).toBe(revision);
    expect(await auditOf(made.body.id, "media_rights")).toBe(0);
    expect((await submissionRow(made.body.id)).full_name).toBe(NAME); // not replaced by the refused request
  });

  it("precise 400s: v2 without or with a bad submission, v1 with a submission, unknown keys; nothing changes", async () => {
    const photographer = await actor("photographer");
    const item = await v1Item(photographer);
    const r = item.revision;
    const bad: unknown[] = [
      { revision: r, statement: V2 },
      { revision: r, statement: V2, submission: null },
      { revision: r, statement: V2, submission: {} },
      { revision: r, statement: V2, submission: { ...SUB, extra: true } },
      { revision: r, statement: V2, submission: { ...SUB, instagramDisplayConsent: true, instagramHandle: undefined } },
      { revision: r, statement: V2, submission: { ...SUB, title: "" } },
      { revision: r, statement: V2, submission: { ...SUB, fullName: "x".repeat(201) } },
      { revision: r, statement: V2, submission: { ...SUB, instagramHandle: "bad handle" } },
      { revision: r, statement: V2, submission: SUB, extra: 1 },
      { revision: r, statement: "v1_own", submission: SUB },
      { revision: r, statement: "v1_authorised", submission: SUB_MIN },
      { revision: r, statement: "v2_agreement_2026-12-02", submission: SUB },
      { revision: r, statement: "d1_private_review" },
      { statement: V2, submission: SUB },
    ];
    for (const body of bad) {
      const res = await putRights(photographer, item.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
    expect(await versionsOf(item.id)).toBe(1);
    expect((await itemRow(item.id)).revision).toBe(r);
  });

  it("another admin is 403, another photographer 404, a stale revision 409 version_conflict; none writes", async () => {
    const photographer = await actor("photographer");
    const stranger = await actor("photographer");
    const admin = await actor("admin");
    const item = await v1Item(photographer);
    const asAdmin = await putRights(admin, item.id, { revision: item.revision, statement: V2, submission: SUB });
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.error.code).toBe("forbidden");
    expect((await putRights(stranger, item.id, { revision: item.revision, statement: V2, submission: SUB })).status).toBe(404);
    const stale = await putRights(photographer, item.id, { revision: item.revision + 5, statement: V2, submission: SUB });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect(await versionsOf(item.id)).toBe(1);
    expect(await submissionRow(item.id)).toBeUndefined();
  });

  it("two concurrent moves: one 200, one 409, one new version, one audit row", async () => {
    const photographer = await actor("photographer");
    const item = await v1Item(photographer);
    const results = await Promise.all(
      [SUB, { ...SUB, fullName: "Other Name" }].map((submission) => putRights(photographer, item.id, { revision: item.revision, statement: V2, submission })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await versionsOf(item.id)).toBe(2);
    expect(await auditOf(item.id, "media_rights")).toBe(1);
  });

  it("the old v1 body keeps working exactly as in 0.28.0 for a draft with no statement", async () => {
    const photographer = await actor("photographer");
    const item = await sql.query<{ id: string }>(
      `INSERT INTO media_items (owner, state, draft_version, published_version, created_by, updated_by, created_at, updated_at)
       VALUES ($1, 'unverified', 1, NULL, $1, $1, clock_timestamp(), clock_timestamp()) RETURNING id`,
      [photographer.principal],
    );
    const id = `med-${item.rows[0]!.id}`;
    const bytes = freshPng();
    await sql.query(
      `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_required, created_by, created_at, updated_at, updated_by)
       VALUES ($1, 1, $2, 'image/png', $3, 64, 48, true, $4, clock_timestamp(), clock_timestamp(), $4)`,
      [idOf(id), sha(bytes), bytes.length, photographer.principal],
    );
    const res = await putRights(photographer, id, { revision: 1, statement: "v1_own" });
    expect(res.status).toBe(200);
    expect(res.body.draftVersion).toBe(1); // in place
    expect(res.body.draft.rights.statement).toBe("v1_own");
    expect(res.body.submission).toBeNull();
  });
});

describe("PATCH with v2 drafts, title and the submission fields", () => {
  it("a v2 draft keeps its licence name and URL: a change is 422, the stored value is a 200 no-op", async () => {
    const photographer = await actor("photographer");
    const made = await upload(photographer, freshPng());
    const r = made.body.revision;
    for (const licence of [{ licenceName: "CC BY 4.0" }, { licenceName: null }, { licenceUrl: "https://example.com/l" }]) {
      const res = await patch(photographer, made.body.id, { revision: r, licence });
      expect(res.status, JSON.stringify(licence)).toBe(422);
      expect(res.body.error.code).toBe("content_invalid");
    }
    const same = await patch(photographer, made.body.id, { revision: r, licence: { licenceName: MEDIA_V2_LICENCE_NAME, licenceUrl: null } });
    expect(same.status).toBe(200);
    expect(same.body.revision).toBe(r); // no-op: no new revision
    expect(await versionsOf(made.body.id)).toBe(1);
  });

  it("title and credit cannot become null on a v2 draft (422, no 500); credit, title, sourceUrl and attribution stay editable", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const made = await upload(photographer, freshPng());
    const r = made.body.revision;
    expect((await patch(photographer, made.body.id, { revision: r, title: null })).status).toBe(422);
    expect((await patch(photographer, made.body.id, { revision: r, licence: { credit: null } })).status).toBe(422);
    expect((await patch(photographer, made.body.id, { revision: r, licence: { creditRequired: false } })).status).toBe(403);
    // an admin may try creditRequired false: the v2 CHECK needs it true, so 422, not a 500
    expect((await patch(admin, made.body.id, { revision: r, licence: { creditRequired: false } })).status).toBe(422);
    expect((await patch(admin, made.body.id, { revision: r, licence: { creditRequired: true } })).status).toBe(200);
    const ok = await patch(photographer, made.body.id, {
      revision: r,
      title: "Renamed",
      licence: { credit: "New Credit", sourceUrl: "https://example.com/s", attributionText: "More" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.draft).toMatchObject({ title: "Renamed", licence: { credit: "New Credit", sourceUrl: "https://example.com/s", attributionText: "More" } });
    expect(ok.body.draftVersion).toBe(1); // unpublished draft, in place
  });

  it("title on a v1 draft may be set and cleared; an invalid title is 400", async () => {
    const photographer = await actor("photographer");
    const item = await v1Item(photographer);
    const set = await patch(photographer, item.id, { revision: item.revision, title: "  Spaced  " });
    expect(set.body.draft.title).toBe("Spaced");
    const cleared = await patch(photographer, item.id, { revision: set.body.revision, title: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.draft.title).toBeNull();
    for (const title of ["", "   ", "a".repeat(201), "a\u0000"]) {
      expect((await patch(photographer, item.id, { revision: cleared.body.revision, title })).status).toBe(400);
    }
  });

  it("the owner sets, changes and clears fullName and Instagram; consent without a handle is 400; the body keys are strict", async () => {
    const photographer = await actor("photographer");
    const item = await v1Item(photographer);
    const set = await patch(photographer, item.id, { revision: item.revision, fullName: "Pat Plain", instagram: { handle: "@pat", displayConsent: true } });
    expect(set.status).toBe(200);
    expect(set.body.submission).toEqual({ fullName: "Pat Plain", instagramHandle: "pat", instagramDisplayConsent: true });
    expect(set.body.draftVersion).toBe(item.draftVersion); // submission-only: no version
    expect(set.body.revision).toBe(item.revision + 1);
    expect(await versionsOf(item.id)).toBe(1);
    const bad: unknown[] = [
      { instagram: { handle: null, displayConsent: true } },
      { instagram: { handle: "@", displayConsent: true } },
      { instagram: { handle: "pat" } },
      { instagram: { displayConsent: false } },
      { instagram: { handle: "pat", displayConsent: false, extra: 1 } },
      { instagram: { handle: "no good", displayConsent: false } },
      { fullName: "" },
      { fullName: "x".repeat(201) },
      { fullName: 5 },
    ];
    for (const extra of bad) {
      const res = await patch(photographer, item.id, { revision: set.body.revision, ...(extra as object) });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    const cleared = await patch(photographer, item.id, { revision: set.body.revision, fullName: null, instagram: { handle: null, displayConsent: false } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.submission).toEqual({ fullName: null, instagramHandle: null, instagramDisplayConsent: false });
    expect(await submissionRow(item.id)).toMatchObject({ full_name: null, instagram_handle: null, instagram_display_consent: false });
  });

  it("a non-owner admin may only remove: setting a name or handle or turning consent on is 403; clearing is 200; stored values are a 200 no-op", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const made = await upload(photographer, freshPng(), { submission: { ...SUB, instagramDisplayConsent: false } });
    let r = made.body.revision;
    const forbidden: unknown[] = [
      { fullName: "Admin Typed" },
      { instagram: { handle: "other", displayConsent: false } },
      { instagram: { handle: "zoe.flies", displayConsent: true } }, // consent ON
    ];
    for (const body of forbidden) {
      const res = await patch(admin, made.body.id, { revision: r, ...(body as object) });
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
    expect((await itemRow(made.body.id)).revision).toBe(r);
    // stored values sent back: no-op
    const noop = await patch(admin, made.body.id, { revision: r, fullName: NAME, instagram: { handle: "zoe.flies", displayConsent: false } });
    expect(noop.status).toBe(200);
    expect(noop.body.revision).toBe(r);
    // the owner turns consent on, then the admin turns it off (a removal)
    const on = await patch(photographer, made.body.id, { revision: r, instagram: { handle: "zoe.flies", displayConsent: true } });
    expect(on.status).toBe(200);
    r = on.body.revision;
    const off = await patch(admin, made.body.id, { revision: r, instagram: { handle: "zoe.flies", displayConsent: false } });
    expect(off.status).toBe(200);
    expect(off.body.submission.instagramDisplayConsent).toBe(false);
    r = off.body.revision;
    const clearHandle = await patch(admin, made.body.id, { revision: r, instagram: { handle: null, displayConsent: false } });
    expect(clearHandle.status).toBe(200);
    expect(clearHandle.body.submission.instagramHandle).toBeNull();
    const clearName = await patch(admin, made.body.id, { revision: clearHandle.body.revision, fullName: null });
    expect(clearName.status).toBe(200);
    expect(clearName.body.submission).toEqual({ fullName: null, instagramHandle: null, instagramDisplayConsent: false });
    expect(await versionsOf(made.body.id)).toBe(1);
  });

  it("a PATCH with only submission fields on a published item makes no version, leaves it out of ?pending=true and does not touch the published row", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const made = await upload(photographer, freshPng());
    const live = await publish(admin, made.body.id, { revision: made.body.revision });
    expect(live.status).toBe(200);
    const before = await versionJson(made.body.id, 1);
    const res = await patch(photographer, made.body.id, { revision: live.body.revision, instagram: { handle: "zoe.flies", displayConsent: false } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "published", publishedVersion: 1, draftVersion: 1, revision: live.body.revision + 1 });
    expect(res.body.submission.instagramDisplayConsent).toBe(false);
    expect(await versionsOf(made.body.id)).toBe(1);
    expect(await versionJson(made.body.id, 1)).toEqual(before);
    expect((await listAll(admin, "?pending=true")).map((i) => i.id)).not.toContain(made.body.id);
    // a name or handle of a PUBLISHED v2 item can be cleared
    const cleared = await patch(photographer, made.body.id, { revision: res.body.revision, fullName: null, instagram: { handle: null, displayConsent: false } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.submission).toEqual({ fullName: null, instagramHandle: null, instagramDisplayConsent: false });
    expect(await versionsOf(made.body.id)).toBe(1);
  });

  it("an edit that makes a new version of a published v2 item copies title, credit and statement; mixed edits still follow the version rule", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const made = await upload(photographer, freshPng());
    const live = await publish(admin, made.body.id, { revision: made.body.revision });
    const edited = await patch(photographer, made.body.id, { revision: live.body.revision, description: "New words", fullName: "Changed Name" });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ publishedVersion: 1, draftVersion: 2 });
    expect(edited.body.draft).toMatchObject({ version: 2, title: SUB.title, description: "New words", rights: { statement: V2 }, licence: { credit: SUB.credit, licenceName: MEDIA_V2_LICENCE_NAME } });
    expect(edited.body.submission.fullName).toBe("Changed Name");
    expect((await versionJson(made.body.id, 2)).title).toBe(SUB.title);
    const audit = await sql.query("SELECT detail FROM admin_audit WHERE target = $1 AND action = 'media_edit'", [made.body.id]);
    expect(audit.rows[0].detail).toMatchObject({ newVersion: true, fromVersion: 1, version: 2, submission: { fullNameChanged: true, instagramChanged: false, consentFrom: true, consentTo: true } });
  });

  it("at least one of licence, description, title, fullName and instagram is required", async () => {
    const photographer = await actor("photographer");
    const made = await upload(photographer, freshPng());
    for (const body of [{ revision: made.body.revision }, { revision: made.body.revision, note: "n" }]) {
      expect((await patch(photographer, made.body.id, body)).status).toBe(400);
    }
    expect((await patch(photographer, made.body.id, { revision: made.body.revision, fullName: NAME })).status).toBe(200); // stored value
  });
});

describe("publish gate and database checks for v2", () => {
  it("a v2 draft with nothing typed publishes; with the full name erased it is 422 content_invalid until the name is back", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const made = await upload(photographer, freshPng());
    const erased = await patch(photographer, made.body.id, { revision: made.body.revision, fullName: null });
    expect(erased.status).toBe(200);
    const refused = await publish(admin, made.body.id, { revision: erased.body.revision });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("content_invalid");
    expect((await itemRow(made.body.id)).state).toBe("unverified");
    const back = await patch(photographer, made.body.id, { revision: erased.body.revision, fullName: "Back Again" });
    const ok = await publish(admin, made.body.id, { revision: back.body.revision });
    expect(ok.status).toBe(200);
    expect(ok.body.draft.publishedAt).not.toBeNull();

    const plain = await upload(photographer, freshPng());
    expect((await publish(admin, plain.body.id, { revision: plain.body.revision })).status).toBe(200);
  });

  it("the database refuses a v2 version row without title, credit, licence name or credit_required, and a bad title or statement", async () => {
    const photographer = await actor("photographer");
    const made = await upload(photographer, freshPng());
    const id = idOf(made.body.id);
    const insert = (v: number, o: { title?: string | null; credit?: string | null; licence?: string | null; required?: boolean; statement?: string; stamp?: boolean }) =>
      sql.query(
        `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_name, credit_required, licence_name, title,
            created_by, created_at, updated_at, updated_by, rights_statement, rights_stated_by, rights_stated_at)
         VALUES ($1, $2, $3, 'image/png', 100, 64, 48, $4, $5, $6, $7, 'x', now(), now(), 'x', $8, 'x', now())`,
        [id, v, "e".repeat(64), o.credit === undefined ? "C" : o.credit, o.required ?? true, o.licence === undefined ? "L" : o.licence, o.title === undefined ? "T" : o.title, o.statement ?? V2],
      );
    expect(await violated(insert(10, { title: null }))).toBe("media_versions_v2_submission_check");
    expect(await violated(insert(11, { credit: null }))).toBe("media_versions_v2_submission_check");
    expect(await violated(insert(12, { licence: null }))).toBe("media_versions_v2_submission_check");
    expect(await violated(insert(13, { required: false }))).toBe("media_versions_v2_submission_check");
    expect(await violated(insert(14, { title: "" }))).toBe("media_versions_title_check");
    expect(await violated(insert(15, { title: "x".repeat(201) }))).toBe("media_versions_title_check");
    expect(await violated(insert(16, { statement: "v2_agreement_2026-12-02" }))).toBe("media_versions_rights_statement_check");
    // a v1 row needs none of it
    expect(await violated(insert(17, { title: null, credit: null, licence: null, required: false, statement: "v1_own" }))).toBeNull();
    expect(await violated(insert(18, {}))).toBeNull();
    // the publishable CHECK accepts a v2 version
    expect(await violated(sql.query(`UPDATE media_versions SET published_at = now() WHERE media_id = $1 AND version = 18`, [id]))).toBeNull();
  });

  it("media_submissions and media_upload_keys checks", async () => {
    const photographer = await actor("photographer");
    const made = await uploadV1(photographer);
    const id = idOf(made.body.id);
    const ins = (name: string | null, handle: string | null, consent: boolean) =>
      sql.query(
        `INSERT INTO media_submissions (media_id, full_name, instagram_handle, instagram_display_consent, updated_at, updated_by) VALUES ($1, $2, $3, $4, now(), 'x')`,
        [id, name, handle, consent],
      );
    expect(await violated(ins("", null, false))).toBe("media_submissions_full_name_check");
    expect(await violated(ins("x".repeat(201), null, false))).toBe("media_submissions_full_name_check");
    expect(await violated(ins("N", "bad handle", false))).toBe("media_submissions_instagram_handle_check");
    expect(await violated(ins("N", "a".repeat(31), false))).toBe("media_submissions_instagram_handle_check");
    expect(await violated(ins("N", null, true))).toBe("media_submissions_consent_check");
    expect(await violated(ins("N", "ok.handle_1", true))).toBeNull();
    expect(await violated(ins("N", null, false))).toBe("media_submissions_pkey"); // one row per item
    expect(await violated(sql.query(`INSERT INTO media_submissions (media_id, updated_at, updated_by) VALUES (999999999, now(), 'x')`))).toBe("media_submissions_media_id_media_items_id_fk");
    expect(await violated(sql.query(`UPDATE media_upload_keys SET submission_sha256 = 'nothex' WHERE media_id = $1`, [id]))).toBe("media_upload_keys_submission_sha256_check");
    expect(await violated(sql.query(`UPDATE media_upload_keys SET submission_sha256 = $2 WHERE media_id = $1`, [id, "a".repeat(64)]))).toBeNull();
  });
});

describe("staff views and privacy", () => {
  it("MediaItem.submission and MediaVersion.title are in list and detail for the owner and for admins", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const v2 = await upload(photographer, freshPng());
    const v1 = await uploadV1(photographer);
    const expected = { fullName: NAME, instagramHandle: "zoe.flies", instagramDisplayConsent: true };
    for (const viewer of [photographer, admin]) {
      const listed = await listAll(viewer);
      const find = (id: string) => listed.find((i) => i.id === id) as Item;
      expect(find(v2.body.id).submission).toEqual(expected);
      expect(find(v2.body.id).draft.title).toBe(SUB.title);
      expect(find(v1.body.id).submission).toBeNull();
      expect(find(v1.body.id).draft.title).toBeNull();
      const one = await detail(viewer, v2.body.id);
      expect(one.body.item.submission).toEqual(expected);
      expect(one.body.versions[0].title).toBe(SUB.title);
      expect(Object.keys(one.body.versions[0])).toContain("title");
      expect(Object.keys(one.body.item)).toContain("submission");
    }
  });

  it("neither ImageRef route (signed-in, guest) nor any player-visible shape carries fullName, instagram, title, submission or rights", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const made = await upload(photographer, freshPng());
    const described = await patch(photographer, made.body.id, { revision: made.body.revision, description: "Staff only note" });
    const live = await publish(admin, made.body.id, { revision: described.body.revision });
    expect(live.status).toBe(200);
    const signedIn = await request(server).get(`/v1/media?ids=${made.body.id}`).set(photographer.auth);
    const guest = await request(server).get(`/v1/public/media?ids=${made.body.id}`);
    for (const res of [signedIn, guest]) {
      expect(res.status).toBe(200);
      expect(res.body.images).toHaveLength(1);
      const keys = keysDeep(res.body);
      for (const forbidden of ["fullName", "instagram", "instagramHandle", "instagramDisplayConsent", "title", "submission", "rights", "statement", "description", "owner"]) {
        expect(keys.has(forbidden), forbidden).toBe(false);
      }
      const text = JSON.stringify(res.body);
      for (const secret of [NAME, "zoe.flies", SUB.title, V2, "Staff only note"]) expect(text).not.toContain(secret);
    }
    expect(guest.body).toEqual(signedIn.body);
    // the credit and licence are public, as for v1
    expect(signedIn.body.images[0].licence).toMatchObject({ credit: SUB.credit, licenceName: MEDIA_V2_LICENCE_NAME });
  });

  it("admin_audit never holds the name or the handle, whatever the write", async () => {
    const photographer = await actor("photographer");
    const admin = await actor("admin");
    const secretName = "Quentin Zxyqwv";
    const secretHandle = "qzx.secret";
    const made = await upload(photographer, freshPng(), { submission: { ...SUB, fullName: secretName, instagramHandle: secretHandle } });
    const e1 = await patch(photographer, made.body.id, { revision: made.body.revision, fullName: "Renamed Qzx", instagram: { handle: "qzx.second", displayConsent: true } });
    const e2 = await patch(admin, made.body.id, { revision: e1.body.revision, instagram: { handle: null, displayConsent: false }, fullName: null });
    expect(e2.status).toBe(200);
    const more = await addVersion(photographer, made.body.id, e2.body.revision, freshPng(), { submission: { ...SUB, fullName: "Third Qzx", instagramHandle: "qzx.third" } });
    expect(more.status).toBe(201);
    const v1 = await v1Item(photographer);
    expect((await putRights(photographer, v1.id, { revision: v1.revision, statement: V2, submission: { ...SUB, fullName: "Fourth Qzx", instagramHandle: "qzx.fourth" } })).status).toBe(200);
    const rows = await sql.query("SELECT detail FROM admin_audit WHERE actor = ANY($1)", [[photographer.principal, admin.principal]]);
    expect(rows.rowCount).toBeGreaterThan(4);
    const text = JSON.stringify(rows.rows);
    for (const secret of [secretName, secretHandle, "Renamed Qzx", "qzx.second", "Third Qzx", "qzx.third", "Fourth Qzx", "qzx.fourth", NAME, "zoe.flies"]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});

describe("access log (D9)", () => {
  it("the request log lines of a v2 upload and of a 400 on X-Submission hold neither the header value nor the decoded name", async () => {
    const photographer = await actor("photographer");
    const secretName = "Logcheck Nameson";
    const header = enc({ ...SUB, fullName: secretName });
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
    let ok: request.Response;
    let bad: request.Response;
    const badHeader = `${header}+`;
    try {
      ok = await upload(photographer, freshPng(), { header });
      bad = await upload(photographer, freshPng(), { header: badHeader });
    } finally {
      spy.mockRestore();
    }
    expect(ok.status).toBe(201);
    expect(bad.status).toBe(400);
    const log = written.join("");
    expect(log).toContain(`"status":201`);
    expect(log).toContain(`"status":400`);
    expect(log).toContain(`"route":"/v1/admin/media"`);
    for (const secret of [header, badHeader, secretName, Buffer.from(secretName).toString("base64"), "zoe.flies", SUB.title, SUB.credit]) {
      expect(log, secret).not.toContain(secret);
    }
  });
});
