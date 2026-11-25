import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { MEDIA_V2_STATEMENT } from "../src/db/enums.js";
import { demoPrincipal, seedRole } from "./roles-helpers.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { emulatorToken } from "./tokens.js";

// Photo review feedback (docs/plans/media-review-feedback.md, migration 0029, API 0.30.0): POST /v1/admin/media/{id}/review, who clears
// a decision, what a declined item blocks, who sees the reason, the `?review=` queue filter and the races. Roles are seeded in
// account_roles; the blob store is the in-process MemoryBlobStore. Every test uses fresh actors and the suite deletes only its own rows.

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
const newKey = () => `rv-${randomUUID().slice(0, 8)}-${keyCounter++}`;
let bytesCounter = 0;
const freshPng = () => png(9000 + ++bytesCounter + Math.floor(Math.random() * 1e5) * 10);
const idOf = (id: string) => Number(id.slice(4));
const enc = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;
const principals: string[] = [];

type Actor = { uid: string; principal: string; auth: { Authorization: string } };

async function actor(role: "photographer" | "admin" | null): Promise<Actor> {
  const uid = `mediarev-${role ?? "none"}-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  principals.push(principal);
  if (role) await seedRole(sql, principal, role);
  return { uid, principal, auth: bearer(uid) };
}

const SUB = { fullName: "Rae Reviewer", title: "Sunrise over LAX", credit: "R. Reviewer", instagramHandle: "rae.reviews", instagramDisplayConsent: true };

type ReviewView = { decision: string; reason: string; version: number; decidedAt: string; decidedBy?: string };
type Item = {
  id: string;
  state: string;
  revision: number;
  draftVersion: number;
  publishedVersion: number | null;
  draft: Record<string, any>;
  submission: { fullName: string | null; instagramHandle: string | null; instagramDisplayConsent: boolean } | null;
  review: ReviewView | null;
  owner?: string;
};

const uploadV2 = (who: Actor, bytes: Buffer = freshPng(), key = newKey()) =>
  request(server).post(PATH).set(who.auth).set("Content-Type", "image/png").set("Idempotency-Key", key).set("X-Rights-Statement", V2).set("X-Submission", enc(SUB)).send(bytes);
const addVersion = (who: Actor, id: string, revision: number, o: { key?: string; bytes?: Buffer; statement?: string } = {}) => {
  const statement = o.statement ?? V2;
  let req = request(server).post(`${PATH}/${id}/versions?revision=${revision}`).set(who.auth).set("Content-Type", "image/png").set("Idempotency-Key", o.key ?? newKey()).set("X-Rights-Statement", statement);
  if (statement === V2) req = req.set("X-Submission", enc(SUB));
  return req.send(o.bytes ?? freshPng());
};
const patch = (who: Actor, id: string, body: unknown) => request(server).patch(`${PATH}/${id}`).set(who.auth).send(body as object);
const publish = (who: Actor, id: string, revision: number) => request(server).post(`${PATH}/${id}/publish`).set(who.auth).send({ revision });
const withdraw = (who: Actor, id: string, revision: number) => request(server).post(`${PATH}/${id}/withdraw`).set(who.auth).send({ revision });
const putRights = (who: Actor, id: string, body: unknown) => request(server).put(`${PATH}/${id}/rights`).set(who.auth).send(body as object);
const review = (who: Actor, id: string, body: unknown) => request(server).post(`${PATH}/${id}/review`).set(who.auth).send(body as object);
const detail = (who: Actor, id: string) => request(server).get(`${PATH}/${id}`).set(who.auth);
const list = (who: Actor, query = "") => request(server).get(`${PATH}${query}`).set(who.auth);

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

const REASON = "The credit line is wrong; please use your full name.";

/** A v2 item (publishable as uploaded) owned by `owner`. */
async function v2Item(owner: Actor): Promise<Item> {
  const res = await uploadV2(owner);
  expect(res.status).toBe(201);
  return res.body as Item;
}

/** A published item with a pending draft (the owner changed the credit after it went live). Returns the pending item. */
async function pendingItem(owner: Actor, admin: Actor): Promise<Item> {
  const created = await v2Item(owner);
  const live = await publish(admin, created.id, created.revision);
  expect(live.status).toBe(200);
  const moved = await patch(owner, created.id, { revision: live.body.revision, licence: { credit: "R. Reviewer II" } });
  expect(moved.status).toBe(200);
  expect(moved.body.draftVersion).toBe(2);
  expect(moved.body.publishedVersion).toBe(1);
  return moved.body as Item;
}

const count = async (table: string, where = "", params: unknown[] = []) =>
  (await sql.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} ${where}`, params)).rows[0]?.n;
const versionsOf = (id: string) => count("media_versions", "WHERE media_id = $1", [idOf(id)]);
const keysOf = (id: string) => count("media_upload_keys", "WHERE media_id = $1", [idOf(id)]);
const auditRows = async (id: string, action: string) =>
  (await sql.query("SELECT detail, actor FROM admin_audit WHERE target = $1 AND action = $2 ORDER BY id", [id, action])).rows as { detail: Record<string, any>; actor: string }[];
const itemRow = async (id: string) => (await sql.query("SELECT * FROM media_items WHERE id = $1", [idOf(id)])).rows[0];

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

describe("POST /v1/admin/media/{id}/review", () => {
  it("changes_requested on an unverified item: 200, the review is in the item, one revision, one audit row without the reason text", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await v2Item(owner);
    const res = await review(admin, item.id, { revision: item.revision, decision: "changes_requested", reason: REASON });
    expect(res.status).toBe(200);
    expect(res.body.review).toEqual({ decision: "changes_requested", reason: REASON, version: 1, decidedAt: expect.any(String), decidedBy: admin.principal });
    expect(res.body).toMatchObject({ state: "unverified", revision: item.revision + 1, draftVersion: 1, publishedVersion: null });
    const rows = await auditRows(item.id, "media_review");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(admin.principal);
    expect(rows[0]!.detail).toEqual({
      mediaId: item.id,
      decision: "changes_requested",
      previousDecision: null,
      reviewedVersion: 1,
      revision: item.revision + 1,
      fromState: "unverified",
      reasonLength: [...REASON].length,
    });
    expect(JSON.stringify(rows[0]!.detail)).not.toContain(REASON);
    expect(await count("admin_audit", "WHERE target = $1", [item.id])).toBe(2); // the upload and the review
  });

  it("declined on an unverified item: 200; declined on a published item: 409 and nothing changes", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await v2Item(owner);
    const declined = await review(admin, item.id, { revision: item.revision, decision: "declined", reason: "Not an aviation photo." });
    expect(declined.status).toBe(200);
    expect(declined.body.review).toMatchObject({ decision: "declined", reason: "Not an aviation photo.", version: 1 });

    const other = await v2Item(owner);
    const live = await publish(admin, other.id, other.revision);
    expect(live.status).toBe(200);
    const refused = await review(admin, other.id, { revision: live.body.revision, decision: "declined", reason: "No." });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("version_conflict");
    expect((await itemRow(other.id)).review_decision).toBeNull();
    expect((await itemRow(other.id)).revision).toBe(live.body.revision);
    expect(await auditRows(other.id, "media_review")).toHaveLength(0);
  });

  it("changes_requested on a published item's pending draft: 200, and the live version stays as it was", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const pending = await pendingItem(owner, admin);
    const res = await review(admin, pending.id, { revision: pending.revision, decision: "changes_requested", reason: "The new credit needs the full name." });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "published", publishedVersion: 1, draftVersion: 2, review: { decision: "changes_requested", version: 2 } });
    const row = await itemRow(pending.id);
    expect(row.published_version).toBe(1);
    expect((await auditRows(pending.id, "media_review"))[0]!.detail).toMatchObject({ fromState: "published", reviewedVersion: 2 });
  });

  it("a published item with no pending draft, and a withdrawn item, are not reviewable (409); stale revision is 409; unknown item is 404", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await v2Item(owner);
    const live = await publish(admin, item.id, item.revision);
    const nothing = await review(admin, item.id, { revision: live.body.revision, decision: "changes_requested", reason: "x" });
    expect(nothing.status).toBe(409);
    expect(nothing.body.error.code).toBe("version_conflict");

    const gone = await withdraw(admin, item.id, live.body.revision);
    expect(gone.status).toBe(200);
    const withdrawn = await review(admin, item.id, { revision: gone.body.revision, decision: "changes_requested", reason: "x" });
    expect(withdrawn.status).toBe(409);
    expect(withdrawn.body.error.message).toContain("withdrawn");

    const fresh = await v2Item(owner);
    const stale = await review(admin, fresh.id, { revision: fresh.revision + 5, decision: "changes_requested", reason: "x" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect((await review(admin, "med-999999999", { revision: 1, decision: null })).status).toBe(404);
    expect(await count("admin_audit", "WHERE action = 'media_review' AND target = ANY($1)", [[item.id, fresh.id]])).toBe(0);
  });

  it("is admin only: the owner photographer gets 403, a stranger photographer 403, no token 401", async () => {
    const owner = await actor("photographer");
    const stranger = await actor("photographer");
    const item = await v2Item(owner);
    const body = { revision: item.revision, decision: "changes_requested", reason: "x" };
    expect((await review(owner, item.id, body)).status).toBe(403);
    expect((await review(stranger, item.id, body)).status).toBe(403);
    expect((await request(server).post(`${PATH}/${item.id}/review`).send(body)).status).toBe(401);
    expect((await itemRow(item.id)).review_decision).toBeNull();
  });

  it("a repeat of the same decision, reason and draft version is a no-op: 200, no revision, no audit row, decidedBy stays the first admin", async () => {
    const owner = await actor("photographer");
    const first = await actor("admin");
    const second = await actor("admin");
    const item = await v2Item(owner);
    const done = await review(first, item.id, { revision: item.revision, decision: "changes_requested", reason: REASON });
    expect(done.status).toBe(200);
    const again = await review(second, item.id, { revision: done.body.revision, decision: "changes_requested", reason: `  ${REASON}\n` }); // normalises to the same text
    expect(again.status).toBe(200);
    expect(again.body.revision).toBe(done.body.revision);
    expect(again.body.review.decidedBy).toBe(first.principal);
    expect(again.body.review.decidedAt).toBe(done.body.review.decidedAt);
    expect(await auditRows(item.id, "media_review")).toHaveLength(1);
    expect((await itemRow(item.id)).revision).toBe(done.body.revision);
    // A retry with the old revision (a lost response) is a stale 409, like publish and withdraw.
    const lost = await review(first, item.id, { revision: item.revision, decision: "changes_requested", reason: REASON });
    expect(lost.status).toBe(409);
    expect(lost.body.error.code).toBe("version_conflict");
  });

  it("is not a no-op once the draft version has moved past the reviewed one", async () => {
    const owner = await actor("admin"); // an admin who owns a declined item can still upload; the decline stays
    const admin = await actor("admin");
    const item = await v2Item(owner);
    const done = await review(admin, item.id, { revision: item.revision, decision: "declined", reason: REASON });
    expect(done.status).toBe(200);
    const up = await addVersion(owner, item.id, done.body.revision);
    expect(up.status).toBe(201);
    expect(up.body.draftVersion).toBe(2);
    expect(up.body.review).toMatchObject({ decision: "declined", version: 1 });
    const again = await review(admin, item.id, { revision: up.body.revision, decision: "declined", reason: REASON });
    expect(again.status).toBe(200);
    expect(again.body.revision).toBe(up.body.revision + 1);
    expect(again.body.review).toMatchObject({ version: 2 });
    expect(again.body.review.decidedAt).not.toBe(done.body.review.decidedAt);
    expect(await auditRows(item.id, "media_review")).toHaveLength(2);
  });

  it("a new decision replaces the current one; declined reopens as changes_requested; the audit row names the previous decision", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await v2Item(owner);
    const a = await review(admin, item.id, { revision: item.revision, decision: "declined", reason: "Not suitable." });
    const b = await review(admin, item.id, { revision: a.body.revision, decision: "changes_requested", reason: "Reconsidered: fix the title." });
    expect(b.status).toBe(200);
    expect(b.body.review).toMatchObject({ decision: "changes_requested", reason: "Reconsidered: fix the title." });
    const c = await review(admin, item.id, { revision: b.body.revision, decision: "changes_requested", reason: "Fix the title and the credit." });
    expect(c.status).toBe(200);
    expect(c.body.review.reason).toBe("Fix the title and the credit.");
    const rows = await auditRows(item.id, "media_review");
    expect(rows.map((r) => [r.detail.decision, r.detail.previousDecision])).toEqual([
      ["declined", null],
      ["changes_requested", "declined"],
      ["changes_requested", "changes_requested"],
    ]);
  });

  it("decision null withdraws the decision and erases the reason; with nothing to withdraw it is a no-op", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await v2Item(owner);
    const empty = await review(admin, item.id, { revision: item.revision, decision: null });
    expect(empty.status).toBe(200);
    expect(empty.body.revision).toBe(item.revision);
    expect(await auditRows(item.id, "media_review")).toHaveLength(0);

    const set = await review(admin, item.id, { revision: item.revision, decision: "declined", reason: REASON });
    const cleared = await review(admin, item.id, { revision: set.body.revision, decision: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.review).toBeNull();
    expect(cleared.body.revision).toBe(set.body.revision + 1);
    const row = await itemRow(item.id);
    expect([row.review_decision, row.review_reason, row.review_version, row.review_decided_by, row.review_decided_at]).toEqual([null, null, null, null, null]);
    const rows = await auditRows(item.id, "media_review");
    expect(rows[1]!.detail).toMatchObject({ decision: null, previousDecision: "declined", reasonLength: 0 });
    expect(JSON.stringify(rows)).not.toContain(REASON);
  });

  it("a decision on a published item's pending draft can be withdrawn after the item is withdrawn; a new decision on it is then refused", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const pending = await pendingItem(owner, admin);
    const asked = await review(admin, pending.id, { revision: pending.revision, decision: "changes_requested", reason: REASON });
    expect(asked.status).toBe(200);
    const gone = await withdraw(admin, pending.id, asked.body.revision);
    expect(gone.status).toBe(200);
    expect(gone.body.state).toBe("withdrawn");
    expect(gone.body.review.decision).toBe("changes_requested");
    const refused = await review(admin, pending.id, { revision: gone.body.revision, decision: "changes_requested", reason: REASON });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("version_conflict");
    const cleared = await review(admin, pending.id, { revision: gone.body.revision, decision: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.review).toBeNull();
    const row = await itemRow(pending.id);
    expect([row.review_decision, row.review_reason, row.review_version, row.review_decided_by, row.review_decided_at]).toEqual([null, null, null, null, null]);
    const rows = await auditRows(pending.id, "media_review");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.detail).toMatchObject({ fromState: "withdrawn", decision: null, previousDecision: "changes_requested", reviewedVersion: 2 });
  });

  it("reason rules: 1-500 code points, newlines kept (CRLF to LF), trimmed, other control characters and lone surrogates refused", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await v2Item(owner);
    let revision = item.revision;
    const bad = async (reason: unknown) => {
      const res = await review(admin, item.id, { revision, decision: "changes_requested", reason });
      expect(res.status, JSON.stringify(reason)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    };
    await bad("");
    await bad("   ");
    await bad("a".repeat(501));
    await bad("tab\there");
    await bad("lone\rcarriage");
    await bad(123);
    // A lone surrogate cannot be built through JSON.stringify of a normal string in all cases: send the escaped text by hand.
    const raw = await request(server).post(`${PATH}/${item.id}/review`).set(admin.auth).set("Content-Type", "application/json").send(`{"revision":${revision},"decision":"changes_requested","reason":"bad \\ud800 half"}`);
    expect(raw.status).toBe(400);
    expect((await itemRow(item.id)).review_decision).toBeNull();

    const max = "é".repeat(500);
    const okMax = await review(admin, item.id, { revision, decision: "changes_requested", reason: max });
    expect(okMax.status).toBe(200);
    expect(okMax.body.review.reason).toBe(max);
    revision = okMax.body.revision;
    const multi = await review(admin, item.id, { revision, decision: "changes_requested", reason: "  Line one\r\nLine two\n\nLine four 🛩️  " });
    expect(multi.status).toBe(200);
    expect(multi.body.review.reason).toBe("Line one\nLine two\n\nLine four 🛩️");
    expect((await sql.query("SELECT review_reason FROM media_items WHERE id = $1", [idOf(item.id)])).rows[0].review_reason).toBe("Line one\nLine two\n\nLine four 🛩️");
  });

  it("the body is strict: a union on decision, no extra keys, no reason with null, a reason is needed otherwise, no query", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await v2Item(owner);
    const r = item.revision;
    for (const body of [
      { revision: r, decision: "changes_requested" },
      { revision: r, decision: "declined" },
      { revision: r, decision: null, reason: "x" },
      { revision: r, decision: "changes_requested", reason: "x", extra: 1 },
      { revision: r, decision: "approved", reason: "x" },
      { revision: r },
      { decision: "declined", reason: "x" },
      { revision: 0, decision: null },
      {},
    ]) {
      expect((await review(admin, item.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(server).post(`${PATH}/${item.id}/review?x=1`).set(admin.auth).send({ revision: r, decision: null })).status).toBe(400);
    expect((await itemRow(item.id)).revision).toBe(r);
  });

  it("an admin may review their own upload", async () => {
    const admin = await actor("admin");
    const mine = await v2Item(admin);
    const res = await review(admin, mine.id, { revision: mine.revision, decision: "changes_requested", reason: "Check the credit." });
    expect(res.status).toBe(200);
  });
});

describe("what clears a review", () => {
  async function requested(owner: Actor, admin: Actor): Promise<Item> {
    const item = await v2Item(owner);
    const res = await review(admin, item.id, { revision: item.revision, decision: "changes_requested", reason: REASON });
    expect(res.status).toBe(200);
    return res.body as Item;
  }

  it("an owner's new file version clears changes_requested: back in ?review=none, audit reviewCleared, one UPDATE (revision + 1)", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await requested(owner, admin);
    expect((await listAll(admin, "?state=unverified&review=none")).map((i) => i.id)).not.toContain(item.id);
    const res = await addVersion(owner, item.id, item.revision);
    expect(res.status).toBe(201);
    expect(res.body.review).toBeNull();
    expect(res.body.revision).toBe(item.revision + 1);
    expect((await listAll(admin, "?state=unverified&review=none")).map((i) => i.id)).toContain(item.id);
    expect((await auditRows(item.id, "media_version"))[0]!.detail).toMatchObject({ reviewCleared: "changes_requested" });
    const row = await itemRow(item.id);
    expect(row.review_reason).toBeNull();
  });

  it("an owner PATCH that changes something clears it (a submission-only change counts); a no-op PATCH does not", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await requested(owner, admin);
    // Stored values sent back: the early no-op return, no revision, no audit row, the request stays.
    const noop = await patch(owner, item.id, { revision: item.revision, title: SUB.title, fullName: SUB.fullName });
    expect(noop.status).toBe(200);
    expect(noop.body.revision).toBe(item.revision);
    expect(noop.body.review).toMatchObject({ decision: "changes_requested" });
    expect(await auditRows(item.id, "media_edit")).toHaveLength(0);

    const submissionOnly = await patch(owner, item.id, { revision: item.revision, fullName: "Rae R. Reviewer" });
    expect(submissionOnly.status).toBe(200);
    expect(submissionOnly.body.review).toBeNull();
    expect(submissionOnly.body.draftVersion).toBe(1);
    expect((await auditRows(item.id, "media_edit"))[0]!.detail).toMatchObject({ reviewCleared: "changes_requested" });

    const second = await requested(owner, admin);
    const content = await patch(owner, second.id, { revision: second.revision, description: "Fixed." });
    expect(content.status).toBe(200);
    expect(content.body.review).toBeNull();
  });

  it("an owner's rights statement (the v2 move) clears it", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const created = await request(server).post(PATH).set(owner.auth).set("Content-Type", "image/png").set("Idempotency-Key", newKey()).set("X-Rights-Statement", "v1_own").send(freshPng());
    expect(created.status).toBe(201);
    const asked = await review(admin, created.body.id, { revision: created.body.revision, decision: "changes_requested", reason: "Please accept the agreement." });
    const moved = await putRights(owner, created.body.id, { revision: asked.body.revision, statement: V2, submission: SUB });
    expect(moved.status).toBe(200);
    expect(moved.body.review).toBeNull();
    expect((await auditRows(created.body.id, "media_rights"))[0]!.detail).toMatchObject({ reviewCleared: "changes_requested" });
  });

  it("a replay of a key claimed before the review answers 200 and does not clear it", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const key = newKey();
    const bytes = freshPng();
    const first = await uploadV2(owner, bytes, key);
    expect(first.status).toBe(201);
    const asked = await review(admin, first.body.id, { revision: first.body.revision, decision: "changes_requested", reason: REASON });
    const replay = await uploadV2(owner, bytes, key);
    expect(replay.status).toBe(200);
    expect(replay.body.review).toMatchObject({ decision: "changes_requested" });
    expect(replay.body.review.decidedBy).toBeUndefined(); // the owner never sees who decided
    expect(replay.body.revision).toBe(asked.body.revision);

    // The same for a version upload replayed with its old revision.
    const vKey = newKey();
    const vBytes = freshPng();
    const added = await addVersion(owner, first.body.id, asked.body.revision, { key: vKey, bytes: vBytes });
    expect(added.status).toBe(201);
    expect(added.body.review).toBeNull();
    const again = await review(admin, first.body.id, { revision: added.body.revision, decision: "changes_requested", reason: REASON });
    const vReplay = await addVersion(owner, first.body.id, asked.body.revision, { key: vKey, bytes: vBytes });
    expect(vReplay.status).toBe(200);
    expect(vReplay.body.review).toMatchObject({ decision: "changes_requested" });
    expect((await itemRow(first.body.id)).revision).toBe(again.body.revision);
  });

  it("a non-owner admin's PATCH never clears it", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await requested(owner, admin);
    const fixed = await patch(admin, item.id, { revision: item.revision, description: "Admin typo fix." });
    expect(fixed.status).toBe(200);
    expect(fixed.body.revision).toBe(item.revision + 1);
    expect(fixed.body.review).toMatchObject({ decision: "changes_requested", version: 1 });
    expect((await auditRows(item.id, "media_edit"))[0]!.detail.reviewCleared).toBeUndefined();
  });

  it("a publish clears either decision in the same write and its audit row says which", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const asked = await requested(owner, admin);
    const live = await publish(admin, asked.id, asked.revision);
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ state: "published", review: null });
    expect((await auditRows(asked.id, "media_publish"))[0]!.detail).toMatchObject({ reviewCleared: "changes_requested" });

    const item = await v2Item(owner);
    const declined = await review(admin, item.id, { revision: item.revision, decision: "declined", reason: "Not suitable." });
    const published = await publish(admin, item.id, declined.body.revision);
    expect(published.status).toBe(200);
    expect(published.body.review).toBeNull();
    expect((await auditRows(item.id, "media_publish"))[0]!.detail).toMatchObject({ reviewCleared: "declined" });

    // Nothing to clear: the key is absent.
    const plain = await v2Item(owner);
    await publish(admin, plain.id, plain.revision);
    expect((await auditRows(plain.id, "media_publish"))[0]!.detail.reviewCleared).toBeUndefined();

    // A publish of a pending draft clears a changes_requested on that draft.
    const pending = await pendingItem(owner, admin);
    const sent = await review(admin, pending.id, { revision: pending.revision, decision: "changes_requested", reason: "Credit?" });
    const again = await publish(admin, pending.id, sent.body.revision);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ publishedVersion: 2, review: null });
  });

  it("an admin who owns the item clears their own changes_requested by writing (identity, not role)", async () => {
    const admin = await actor("admin");
    const reviewer = await actor("admin");
    const mine = await v2Item(admin);
    const asked = await review(reviewer, mine.id, { revision: mine.revision, decision: "changes_requested", reason: "Check." });
    const res = await patch(admin, mine.id, { revision: asked.body.revision, title: "A better title" });
    expect(res.status).toBe(200);
    expect(res.body.review).toBeNull();
    expect((await auditRows(mine.id, "media_edit"))[0]!.detail).toMatchObject({ reviewCleared: "changes_requested" });
  });
});

describe("a declined item", () => {
  async function declinedItem(owner: Actor, admin: Actor): Promise<Item> {
    const item = await v2Item(owner);
    const res = await review(admin, item.id, { revision: item.revision, decision: "declined", reason: "Not an aviation photo." });
    expect(res.status).toBe(200);
    return res.body as Item;
  }

  it("blocks its owner's version upload, PATCH and rights statement with 409 media_declined; nothing is stored or written", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await declinedItem(owner, admin);
    const versions = await versionsOf(item.id);
    const keys = await keysOf(item.id);
    const audits = await count("admin_audit", "WHERE target = $1", [item.id]);

    const up = await addVersion(owner, item.id, item.revision);
    const edit = await patch(owner, item.id, { revision: item.revision, description: "Please reconsider." });
    const noop = await patch(owner, item.id, { revision: item.revision, title: SUB.title });
    const rights = await putRights(owner, item.id, { revision: item.revision, statement: "v1_own" });
    for (const res of [up, edit, noop, rights]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("media_declined");
      expect(JSON.stringify(res.body)).not.toContain("aviation photo"); // the reason is in the item, never in the message
    }
    expect(await versionsOf(item.id)).toBe(versions);
    expect(await keysOf(item.id)).toBe(keys);
    expect(await count("admin_audit", "WHERE target = $1", [item.id])).toBe(audits);
    const row = await itemRow(item.id);
    expect(row.revision).toBe(item.revision);
    expect(row.review_decision).toBe("declined");
  });

  it("lets the owner REMOVE private fields (erasure): 200, still declined; setting one is blocked", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await declinedItem(owner, admin);
    const set = await patch(owner, item.id, { revision: item.revision, instagram: { handle: "someone.else", displayConsent: true } });
    expect(set.status).toBe(409);
    const mixed = await patch(owner, item.id, { revision: item.revision, instagram: { handle: null, displayConsent: false }, description: "and also this" });
    expect(mixed.status).toBe(409);
    const removed = await patch(owner, item.id, { revision: item.revision, instagram: { handle: null, displayConsent: false } });
    expect(removed.status).toBe(200);
    expect(removed.body.submission).toMatchObject({ instagramHandle: null, instagramDisplayConsent: false });
    expect(removed.body.review).toMatchObject({ decision: "declined" });
    expect(removed.body.revision).toBe(item.revision + 1);
    expect((await auditRows(item.id, "media_edit"))[0]!.detail.reviewCleared).toBeUndefined();
    const nameRemoved = await patch(owner, item.id, { revision: removed.body.revision, fullName: null });
    expect(nameRemoved.status).toBe(200);
    expect(nameRemoved.body.review).toMatchObject({ decision: "declined" });
  });

  it("does not block an admin who owns it", async () => {
    const admin = await actor("admin");
    const other = await actor("admin");
    const mine = await v2Item(admin);
    const declined = await review(other, mine.id, { revision: mine.revision, decision: "declined", reason: "No." });
    expect((await patch(admin, mine.id, { revision: declined.body.revision, description: "Admin owner edit." })).status).toBe(200);
    const stillDeclined = await detail(admin, mine.id);
    expect(stillDeclined.body.item.review).toMatchObject({ decision: "declined" }); // an admin-owner write never clears declined
    const up = await addVersion(admin, mine.id, stillDeclined.body.item.revision);
    expect(up.status).toBe(201);
  });

  it("precedence: stale revision beats it, a v1 upload over v2 reports media_declined, a non-owner admin upload is 403, a stranger 404", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const stranger = await actor("photographer");
    const item = await declinedItem(owner, admin);
    const stale = await addVersion(owner, item.id, item.revision - 1);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect((await patch(owner, item.id, { revision: item.revision + 3, description: "x" })).body.error.code).toBe("version_conflict");
    const v1 = await addVersion(owner, item.id, item.revision, { statement: "v1_own" });
    expect(v1.status).toBe(409);
    expect(v1.body.error.code).toBe("media_declined"); // not rights_already_stated
    const asAdmin = await addVersion(admin, item.id, item.revision);
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.error.code).toBe("forbidden");
    expect((await addVersion(stranger, item.id, item.revision)).status).toBe(404);
  });

  it("an admin can PATCH it, reopen it with changes_requested (the owner is unblocked), or publish it", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await declinedItem(owner, admin);
    const fixed = await patch(admin, item.id, { revision: item.revision, description: "Admin edit." });
    expect(fixed.status).toBe(200);
    expect(fixed.body.review).toMatchObject({ decision: "declined" });
    const reopened = await review(admin, item.id, { revision: fixed.body.revision, decision: "changes_requested", reason: "Try again with a clearer shot." });
    expect(reopened.status).toBe(200);
    const up = await addVersion(owner, item.id, reopened.body.revision);
    expect(up.status).toBe(201);
    expect(up.body.review).toBeNull();

    const other = await declinedItem(owner, admin);
    expect((await publish(admin, other.id, other.revision)).status).toBe(200);
  });
});

describe("who sees the review", () => {
  it("the owner sees reason, decision, version and decidedAt (no decidedBy) in get, list and a replay; an admin also sees decidedBy", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const item = await v2Item(owner);
    const asked = await review(admin, item.id, { revision: item.revision, decision: "changes_requested", reason: REASON });
    const view = { decision: "changes_requested", reason: REASON, version: 1, decidedAt: asked.body.review.decidedAt };

    const got = await detail(owner, item.id);
    expect(got.body.item.review).toEqual(view);
    expect(Object.keys(got.body.item.review)).not.toContain("decidedBy");
    const mine = (await listAll(owner)).find((i) => i.id === item.id);
    expect(mine?.review).toEqual(view);
    expect(mine?.owner).toBeUndefined();

    expect((await detail(admin, item.id)).body.item.review).toEqual({ ...view, decidedBy: admin.principal });
    expect((await listAll(admin, "?review=changes_requested")).find((i) => i.id === item.id)?.review).toEqual({ ...view, decidedBy: admin.principal });
    expect((await detail(admin, item.id)).body.item.owner).toBe(owner.principal);
  });

  it("every other item has review: null; the reason never reaches an ImageRef, GET /v1/media, GET /v1/public/media, the audit rows or the access log", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const secret = "Zxqv-secret-review-reason-4821";
    const plain = await v2Item(owner);
    expect(plain.review).toBeNull();
    const pending = await pendingItem(owner, admin);
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
    let asked: request.Response;
    let signedIn: request.Response;
    let publicRes: request.Response;
    let detailRes: request.Response;
    try {
      asked = await review(admin, pending.id, { revision: pending.revision, decision: "changes_requested", reason: secret });
      signedIn = await request(server).get(`/v1/media?ids=${pending.id}`).set(owner.auth);
      publicRes = await request(server).get(`/v1/public/media?ids=${pending.id}`);
      detailRes = await detail(admin, pending.id);
    } finally {
      spy.mockRestore();
    }
    expect(asked.status).toBe(200);
    for (const res of [signedIn, publicRes]) {
      expect(res.status).toBe(200);
      expect(res.body.images).toHaveLength(1);
      expect(JSON.stringify(res.body)).not.toContain(secret);
      expect(JSON.stringify(res.body)).not.toContain("review");
    }
    expect(JSON.stringify(detailRes.body.preview)).not.toContain(secret); // the preview is an ImageRef
    expect(JSON.stringify(detailRes.body.preview)).not.toContain("review");
    expect(JSON.stringify(await auditRows(pending.id, "media_review"))).not.toContain(secret);
    expect(JSON.stringify((await sql.query("SELECT detail FROM admin_audit WHERE target = $1", [pending.id])).rows)).not.toContain(secret);
    expect(written.join("")).not.toContain(secret);
    expect(written.join("")).toContain(`"route":"/v1/admin/media/:mediaId/review"`);
  });
});

describe("GET /v1/admin/media?review=", () => {
  it("filters by none | changes_requested | declined, with state and pending", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const fresh = await v2Item(owner);
    const asked = await v2Item(owner);
    await review(admin, asked.id, { revision: asked.revision, decision: "changes_requested", reason: "x" });
    const declined = await v2Item(owner);
    await review(admin, declined.id, { revision: declined.revision, decision: "declined", reason: "x" });
    const pending = await pendingItem(owner, admin);
    const pendingAsked = await pendingItem(owner, admin);
    await review(admin, pendingAsked.id, { revision: pendingAsked.revision, decision: "changes_requested", reason: "x" });

    const ids = async (query: string) => (await listAll(owner, query)).map((i) => i.id).sort();
    const expectIds = (items: Item[]) => items.map((i) => i.id).sort();
    expect(await ids("?state=unverified&review=none")).toEqual(expectIds([fresh]));
    expect(await ids("?state=unverified&review=changes_requested")).toEqual(expectIds([asked]));
    expect(await ids("?state=unverified&review=declined")).toEqual(expectIds([declined]));
    expect(await ids("?pending=true&review=none")).toEqual(expectIds([pending]));
    expect(await ids("?pending=true&review=changes_requested")).toEqual(expectIds([pendingAsked]));
    expect(await ids("?pending=true&review=declined")).toEqual([]);
    expect(await ids("?review=declined")).toEqual(expectIds([declined]));
    expect(await ids("?state=published&review=none")).toEqual(expectIds([pending]));
    expect(await ids("")).toHaveLength(5);
    expect((await list(owner, "?review=other")).status).toBe(400);
  });

  it("cursors: a 0.29.0 cursor still decodes; a review cursor needs the same review filter and the reverse is 400", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    for (let i = 0; i < 3; i++) {
      const item = await v2Item(owner);
      if (i > 0) await review(admin, item.id, { revision: item.revision, decision: "changes_requested", reason: "x" });
    }
    const old = (n: number, key: string) => Buffer.from(`m1.${key}.${n}`).toString("base64url");
    const top = Number((await itemRow((await list(owner)).body.items[0].id)).id);
    expect((await list(owner, `?cursor=${old(top + 1, "-")}`)).status).toBe(200);
    expect((await list(owner, `?state=unverified&cursor=${old(top + 1, "unverified")}`)).status).toBe(200);
    expect((await list(owner, `?pending=true&cursor=${old(top + 1, "pending")}`)).status).toBe(200);
    expect((await list(owner, `?pending=true&state=published&cursor=${old(top + 1, "pending")}`)).status).toBe(200); // the two spellings share a key

    const page = await list(owner, "?review=changes_requested&limit=1");
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).not.toBeNull();
    const cursor = page.body.nextCursor as string;
    expect(Buffer.from(cursor, "base64url").toString()).toMatch(/^m1\.-\+changes_requested\.[1-9][0-9]*$/);
    const next = await list(owner, `?review=changes_requested&limit=1&cursor=${cursor}`);
    expect(next.status).toBe(200);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
    expect((await list(owner, `?cursor=${cursor}`)).status).toBe(400);
    expect((await list(owner, `?review=none&cursor=${cursor}`)).status).toBe(400);
    expect((await list(owner, `?review=declined&cursor=${cursor}`)).status).toBe(400);
    expect((await list(owner, `?state=unverified&review=changes_requested&cursor=${cursor}`)).status).toBe(400);
    expect((await list(owner, `?review=none&cursor=${old(top + 1, "-")}`)).status).toBe(400); // an unfiltered cursor on a review list
    const withPending = await list(owner, "?pending=true&review=none&limit=1");
    expect(withPending.status).toBe(200);
    // A review key is canonical only: a non-canonical spelling and a bad suffix are refused.
    for (const text of ["m1.-+.5", "m1.-+Declined.5", "m1.-+declined+none.5", "m1.+declined.5"]) {
      expect((await list(owner, `?review=declined&cursor=${Buffer.from(text).toString("base64url")}`)).status, text).toBe(400);
    }
    expect((await list(owner, `?review=declined&cursor=${old(5, "-+declined")}`)).status).toBe(200);
  });
});

describe("races at one revision: exactly one wins", () => {
  it("a review against an owner PATCH, an owner version upload, an owner rights statement and a publish", async () => {
    const owner = await actor("photographer");
    const admin = await actor("admin");
    const attempts: [string, (item: Item) => Promise<request.Response>][] = [
      ["PATCH", (item) => patch(owner, item.id, { revision: item.revision, description: "Racing edit." })],
      ["version", (item) => addVersion(owner, item.id, item.revision)],
      ["publish", (item) => publish(admin, item.id, item.revision)],
    ];
    for (const [name, other] of attempts) {
      const item = await v2Item(owner);
      const [a, b] = await Promise.all([review(admin, item.id, { revision: item.revision, decision: "changes_requested", reason: REASON }), other(item)]);
      expect([a.status, b.status].filter((s) => s < 300), name).toHaveLength(1);
      expect([a.status, b.status].filter((s) => s === 409), name).toHaveLength(1);
      const row = await itemRow(item.id);
      expect(row.revision, name).toBe(item.revision + 1);
      // Whichever won, the stored state is consistent: a review only if the review won.
      expect(row.review_decision !== null, name).toBe(a.status === 200);
    }
    // A v1 item for the rights statement.
    const v1 = await request(server).post(PATH).set(owner.auth).set("Content-Type", "image/png").set("Idempotency-Key", newKey()).set("X-Rights-Statement", "v1_own").send(freshPng());
    const [a, b] = await Promise.all([
      review(admin, v1.body.id, { revision: v1.body.revision, decision: "changes_requested", reason: REASON }),
      putRights(owner, v1.body.id, { revision: v1.body.revision, statement: V2, submission: SUB }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await itemRow(v1.body.id)).review_decision !== null).toBe(a.status === 200);
  });
});
