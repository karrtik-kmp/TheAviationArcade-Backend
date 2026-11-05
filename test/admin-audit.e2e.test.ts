import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { ADMIN_AUDIT_ACTIONS, MEDIA_RIGHTS_STATEMENTS } from "../src/db/enums.js";
import type { AdminAuditAction } from "../src/db/enums.js";
import { clearRoles, demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";

// Wave W4 (docs/plans/website-content.md, ruling WC-4): GET /v1/admin/audit, the newest 50 admin_audit rows, admin only. The real Nest app
// against the real test database. The table is shared with other suites, so every assertion is about the rows this file seeded.

const AUDIT = "/v1/admin/audit";
const ACTOR = "firebase:demo-airplane-games:w4-staff";

type Event = { id: string; entity: string; action: string; actor: string; detail: Record<string, unknown>; createdAt: string };

let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
let sql: pg.Pool;
const principals: string[] = [];
const seededIds: number[] = [];

const bearer = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid)}` });

async function caller(role: "admin" | "photographer"): Promise<{ Authorization: string }> {
  const uid = `w4-${role}-${randomUUID()}`;
  principals.push(demoPrincipal(uid));
  await seedRole(sql, demoPrincipal(uid), role);
  return bearer(uid);
}

async function seed(action: string, target: string, detail: unknown, actor = ACTOR): Promise<number> {
  const { rows } = await sql.query(
    "INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ($1, $2, $3, $4::jsonb, now()) RETURNING id",
    [actor, action, target, JSON.stringify(detail)],
  );
  const id = Number(rows[0].id);
  seededIds.push(id);
  return id;
}

const read = async (headers: Record<string, string>): Promise<Event[]> => {
  const res = await request(server).get(AUDIT).set(headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.events as Event[];
};
const wire = (id: number) => `aud-${id}`;

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
});

afterAll(async () => {
  if (seededIds.length > 0) await sql.query("DELETE FROM admin_audit WHERE id = ANY($1::bigint[])", [seededIds]);
  await clearRoles(sql, ...principals);
  await app.close();
  await sql.end();
});

describe("who may read the audit desk", () => {
  it("no token is 401, a photographer is 403, an admin is 200", async () => {
    expect((await request(server).get(AUDIT)).status).toBe(401);
    const photographer = await request(server).get(AUDIT).set(await caller("photographer"));
    expect(photographer.status).toBe(403);
    expect(photographer.body.error.code).toBe("forbidden");
    const admin = await request(server).get(AUDIT).set(await caller("admin"));
    expect(admin.status).toBe(200);
    expect(Array.isArray(admin.body.events)).toBe(true);
    expect(Object.keys(admin.body)).toEqual(["events"]);
  });

  it("takes no query parameters: any key is 400", async () => {
    const admin = await caller("admin");
    for (const query of ["?limit=10", "?cursor=x", "?action=media_import", "?x="]) {
      const res = await request(server).get(`${AUDIT}${query}`).set(admin);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
  });
});

describe("the page", () => {
  it("is the newest 50 by id, newest first: exactly 50 of 60 rows", async () => {
    const admin = await caller("admin");
    const ids: number[] = [];
    for (let i = 1; i <= 60; i += 1) ids.push(await seed("role_grant", `w4-order-${i}`, { role: "admin", from: null, to: { state: "active", revision: 1 }, note: null }));
    const events = await read(admin);
    expect(events).toHaveLength(50);
    expect(events.map((e) => e.id)).toEqual(ids.slice(10).reverse().map(wire)); // the newest 50 of mine are the newest 50 overall
    expect(events[0]?.entity).toBe("w4-order-60");
    expect(events[49]?.entity).toBe("w4-order-11");
  });

  it("has exactly the contract fields: entity is the stored target, actor the stored string as-is, createdAt an ISO instant", async () => {
    const admin = await caller("admin");
    const id = await seed("store_product_edit", "hints-10", { fromVersion: 1, version: 2, diff: [{ field: "title", from: "A", to: "B" }] }, "operator:josh");
    const [event] = await read(admin);
    expect(event).toBeDefined();
    expect(Object.keys(event as Event).sort()).toEqual(["action", "actor", "createdAt", "detail", "entity", "id"]);
    expect(event).toMatchObject({ id: wire(id), entity: "hints-10", action: "store_product_edit", actor: "operator:josh" });
    expect(new Date((event as Event).createdAt).toISOString()).toBe((event as Event).createdAt);
  });
});

describe("the media_import projection", () => {
  it("ASSUMPTION: rightsEvidence is not shown on the audit desk", async () => {
    const admin = await caller("admin");
    const evidence = "Photo taken by me, contact jo@example.com or +1 555 0100 \u{1F600}"; // an emoji is one code point, two UTF-16 units
    const detail = { sourceId: "d1-7", owner: "firebase:demo-airplane-games:u1", status: "unverified", rightsBasis: "own", mediaId: "med-9", rightsEvidence: evidence, note: "Imported." };
    const id = await seed("media_import", "med-9", detail);
    const events = await read(admin);
    const shown = events.find((e) => e.id === wire(id));
    expect(shown?.detail).toEqual({
      sourceId: "d1-7",
      owner: "firebase:demo-airplane-games:u1",
      status: "unverified",
      rightsBasis: "own",
      mediaId: "med-9",
      note: "Imported.",
      rightsEvidenceLength: [...evidence].length,
    });
    expect([...evidence].length).toBe(evidence.length - 1);
    expect(JSON.stringify(shown)).not.toContain("jo@example.com");
    expect(JSON.stringify(shown)).not.toContain("rightsEvidence\"");
    // The stored row is untouched: the projection is read-side only.
    const stored = await sql.query("SELECT detail FROM admin_audit WHERE id = $1", [id]);
    expect(stored.rows[0].detail.rightsEvidence).toBe(evidence);
  });

  it("ASSUMPTION: a photographer's media_edit note is not shown on the audit desk", async () => {
    const admin = await caller("admin");
    const note = "Fixed the credit, ask me on pat@example.com \u{1F600}";
    const changes = { description: { from: null, to: "A Cessna." }, credit: { from: null, to: "A. Photographer" } };
    const detail = { mediaId: "med-12", fromVersion: 1, version: 2, newVersion: true, revision: 3, changes, note };
    const id = await seed("media_edit", "med-12", detail, "firebase:demo-airplane-games:w4-photographer");
    const shown = (await read(admin)).find((e) => e.id === wire(id));
    expect(shown?.detail).toEqual({ mediaId: "med-12", fromVersion: 1, version: 2, newVersion: true, revision: 3, changes, noteLength: [...note].length });
    expect([...note].length).toBe(note.length - 1);
    expect(JSON.stringify(shown)).not.toContain("pat@example.com");
    const stored = await sql.query("SELECT detail FROM admin_audit WHERE id = $1", [id]);
    expect(stored.rows[0].detail.note).toBe(note);
  });

  it("a media_edit row with no note passes through unchanged", async () => {
    const admin = await caller("admin");
    const detail = { mediaId: "med-13", fromVersion: 1, version: 1, newVersion: false, revision: 2, changes: { description: { from: "a", to: "b" } }, note: null };
    const id = await seed("media_edit", "med-13", detail);
    expect((await read(admin)).find((e) => e.id === wire(id))?.detail).toEqual(detail);
  });

  it("a media_import row without rightsEvidence passes through unchanged", async () => {
    const admin = await caller("admin");
    const detail = { sourceId: "d1-8", owner: "firebase:demo-airplane-games:u1", status: "unverified", rightsBasis: "own", mediaId: "med-10", note: "Imported." };
    const id = await seed("media_import", "med-10", detail);
    expect((await read(admin)).find((e) => e.id === wire(id))?.detail).toEqual(detail);
  });

  it("is pinned to its actions: rightsEvidence and note keys under any other action are passed through", async () => {
    const admin = await caller("admin");
    const detail = { mediaId: "med-11", rightsEvidence: "kept", rightsEvidenceLength: 99, note: "kept too" };
    const id = await seed("media_rights", "med-11", detail);
    expect((await read(admin)).find((e) => e.id === wire(id))?.detail).toEqual(detail);
    const noted = await seed("role_approve", "w4-noted", { role: "photographer", note: "kept" });
    expect((await read(admin)).find((e) => e.id === wire(noted))?.detail).toEqual({ role: "photographer", note: "kept" });
  });
});

// A detail per action that MIRRORS what its writer stores (see src/**); the writers are not run here. Free text is allowed through, so none of it holds an email.
const SHA = "a".repeat(64);
const [OWN, AUTHORISED, D1_REVIEW] = MEDIA_RIGHTS_STATEMENTS;
const principal = "firebase:demo-airplane-games:w4-subject";
const DETAILS: Record<AdminAuditAction, { target: string; detail: Record<string, unknown>; actor?: string }> = {
  content_import: { target: "aircraft-identifier", detail: { importId: 3, sha256: SHA, fileName: "Aircraft v2.xlsx", kind: "client_sheet", added: 1, updated: 2, retired: 0, retiredIds: [], updatedIds: ["a1"] } },
  content_publish: { target: "field-awards", detail: { name: "field-awards", version: 2, previousVersion: 1, sha256: SHA, byteSize: 900, draftVersion: 4, editors: [ACTOR], history: [{ principal: ACTOR, action: "import", at: "2026-10-01T10:00:00.000Z", draftVersion: 4, fileSha256: SHA }], acknowledgedCardRemoval: true, note: "Tags tidied.", changeCount: 1, changes: [{ kind: "card-tag", key: "c-1", field: "tags", from: ["a"], to: ["b"], removedClientTags: ["a"], acknowledgedRemoval: true }] } },
  content_edit: { target: "aircraft-identifier", detail: { id: "a1", fromVersion: 1, version: 2, diff: [{ field: "rank", from: "trainee", to: "captain" }] } },
  content_retire: { target: "aircraft-identifier", detail: { id: "a1", fromVersion: 2, version: 3, diff: [{ field: "status", from: "approved", to: "retired" }] } },
  content_restore: { target: "aircraft-identifier", detail: { id: "a1", fromVersion: 3, version: 4, diff: [{ field: "status", from: "retired", to: "approved" }] } },
  role_request: { target: principal, detail: { role: "photographer", from: null, to: { state: "pending", revision: 1 }, note: null }, actor: principal },
  role_approve: { target: principal, detail: { role: "photographer", from: { state: "pending", revision: 1 }, to: { state: "active", revision: 2 }, note: null } },
  role_reject: { target: principal, detail: { role: "photographer", from: { state: "pending", revision: 1 }, to: { state: "rejected", revision: 2 }, note: "Not now." } },
  role_grant: { target: principal, detail: { role: "admin", from: null, to: { state: "active", revision: 1 }, note: null }, actor: "operator:josh" },
  role_revoke: { target: principal, detail: { role: "admin", from: { state: "active", revision: 1 }, to: { state: "revoked", revision: 2 }, note: null } },
  role_block: { target: principal, detail: { role: "photographer", from: { state: "active", revision: 2 }, to: { state: "blocked", revision: 3 }, note: "Spam." } },
  role_unblock: { target: principal, detail: { role: "photographer", from: { state: "blocked", revision: 3 }, to: { state: "active", revision: 4 }, note: null } },
  role_email_edit: { target: principal, detail: { role: "admin", from: { state: "active", revision: 1 }, to: { state: "active", revision: 2 }, emailChanged: true } },
  media_upload: { target: "med-1", detail: { mediaId: "med-1", version: 1, sha256: SHA, contentType: "image/jpeg", byteSize: 1000, width: 800, height: 600, rightsStatement: OWN } },
  media_version: { target: "med-1", detail: { mediaId: "med-1", version: 2, previousDraftVersion: 1, revision: 2, sha256: SHA, contentType: "image/jpeg", byteSize: 1000, width: 800, height: 600, rightsStatement: OWN } },
  media_edit: { target: "med-1", detail: { mediaId: "med-1", fromVersion: 1, version: 2, newVersion: true, revision: 3, changes: { description: { from: null, to: "A Cessna on the apron." }, credit: { from: null, to: "A. Photographer" } }, note: "Fixed the credit." } },
  media_publish: { target: "med-1", detail: { mediaId: "med-1", fromState: "unverified", previousPublishedVersion: null, publishedVersion: 1, revision: 4, sha256: SHA } },
  media_withdraw: { target: "med-1", detail: { mediaId: "med-1", fromState: "published", withdrawnVersion: 1, revision: 5 } },
  content_media_link: { target: "aircraft-identifier", detail: { id: "a1", fromVersion: 4, version: 5, diff: [{ field: "media", from: null, to: "med-1" }] } },
  media_rights: { target: "med-1", detail: { mediaId: "med-1", version: 1, statement: AUTHORISED, previousStatement: D1_REVIEW, revision: 6 } },
  media_import: { target: "med-2", detail: { sourceId: "d1-1", owner: principal, status: "unverified", rightsBasis: "own", submittedAt: "2026-10-01T10:00:00.000Z", mediaId: "med-2", rightsEvidence: "My own photo; call me on 555 0100.", note: "Imported D1 proposal." }, actor: "operator:josh" },
  store_product_create: { target: "hints-10", detail: { version: 1, kind: "hint_pack", title: "10 hints", hints: 10, miles: null, passPeriod: null, demo: false } },
  store_product_edit: { target: "hints-10", detail: { fromVersion: 1, version: 2, diff: [{ field: "title", from: "10 hints", to: "Ten hints" }] } },
  store_product_retire: { target: "hints-10", detail: { fromVersion: 2, version: 3, diff: [{ field: "status", from: "active", to: "retired" }] } },
  store_product_restore: { target: "hints-10", detail: { fromVersion: 3, version: 4, diff: [{ field: "status", from: "retired", to: "active" }] } },
  editorial_create: { target: "plane-of-the-day", detail: { id: "ed-1", mediaId: "med-1" } },
  editorial_save: { target: "plane-of-the-day", detail: { id: "ed-1", fromVersion: 1, version: 2, fromStatus: "draft", status: "draft", fromDateKey: null, dateKey: null, fields: ["status", "data.title"] } },
  content_prepare: { target: "aircraft-identifier-military", detail: { id: "mil-a1", fromVersion: 1, version: 2, fromStage: "missing_photo", stage: "rights_checked", media: { from: null, to: "med-1" }, fields: ["permission"] } },
  release_create: { target: "aircraft-identifier-military", detail: { release: 1, itemCount: 31, basis: "mil-a1:2,mil-a2:2" } },
  release_activate: { target: "aircraft-identifier-military", detail: { release: 1, previous: null, itemCount: 31, sequence: 1 } },
  release_restore: { target: "aircraft-identifier-military", detail: { release: 1, replaced: 2, sequence: 3 } },
};

/** Every key anywhere in the value, with the path to it. */
function keysOf(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => keysOf(item, `${path}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) => [`${path}.${key}`, ...keysOf(inner, `${path}.${key}`)]);
}
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

describe("leak test: what the desk can show", () => {
  it("seeds one row per ADMIN_AUDIT_ACTIONS entry (the list is covered)", () => {
    expect(Object.keys(DETAILS).sort()).toEqual([...ADMIN_AUDIT_ACTIONS].sort());
  });

  it("shows no key matching email|token|secret|password (allow-list: emailChanged) and no email address in any value", async () => {
    const admin = await caller("admin");
    const ids = new Map<string, number>();
    // Seeded in batches of at most 50 rows, each read straight after, so every row is on the newest-50 page when it is read.
    const actions = ADMIN_AUDIT_ACTIONS.slice();
    const seen: Event[] = [];
    for (let at = 0; at < actions.length; at += 20) {
      const batch = actions.slice(at, at + 20);
      for (const action of batch) {
        const entry = DETAILS[action];
        ids.set(action, await seed(action, entry.target, entry.detail, entry.actor));
      }
      const mine = new Set(batch.map((action) => wire(ids.get(action) as number)));
      seen.push(...(await read(admin)).filter((e) => mine.has(e.id)));
    }
    expect(seen.map((e) => e.action).sort()).toEqual([...ADMIN_AUDIT_ACTIONS].sort());

    const ALLOWED_KEYS = new Set(["emailChanged"]);
    const FORBIDDEN = /email|token|secret|password/i;
    const offending: string[] = [];
    for (const event of seen) {
      for (const path of keysOf(event.detail)) {
        const key = path.slice(path.lastIndexOf(".") + 1);
        if (FORBIDDEN.test(key) && !ALLOWED_KEYS.has(key)) offending.push(`${event.action}${path}`);
      }
      expect(Object.keys(event).some((k) => FORBIDDEN.test(k))).toBe(false);
    }
    expect(offending).toEqual([]);
    // emailChanged is a flag, never an address.
    const edit = seen.find((e) => e.action === "role_email_edit");
    expect(edit?.detail.emailChanged).toBe(true);
    // The values: no address anywhere (the projected media_import row held a phone number and, in the seed above, no email either; the
    // projection test covers an address inside rightsEvidence).
    for (const event of seen) {
      for (const text of [event.actor, event.entity, ...stringsOf(event.detail)]) expect(text, `${event.action}: ${text}`).not.toMatch(/@/);
    }
    const imported = seen.find((e) => e.action === "media_import");
    expect(imported?.detail.rightsEvidence).toBeUndefined();
    expect(seen.find((e) => e.action === "media_edit")?.detail.note).toBeUndefined();
    expect(seen.find((e) => e.action === "media_edit")?.detail.noteLength).toBe([...String(DETAILS.media_edit.detail.note)].length);
    expect(imported?.detail.rightsEvidenceLength).toBe([...String(DETAILS.media_import.detail.rightsEvidence)].length);
    // The actor is the stored principal-style string, never an email or a name.
    expect(seen.find((e) => e.action === "role_grant")?.actor).toBe("operator:josh");
    expect(seen.find((e) => e.action === "content_edit")?.actor).toBe(ACTOR);
  });
});
