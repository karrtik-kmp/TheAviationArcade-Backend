import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { APP_CONFIG, loadConfig } from "../src/config/config.module.js";
import { setTestDatabaseClockSkew } from "../src/database/clock.js";
import { verifyCdnToken } from "../src/platform/cdn-signer.js";
import { demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";

// Media plan T5 (docs/plans/media-pipeline.md): staff list and get with a signed preview link. Roles are seeded in account_roles;
// the blob store is the in-process MemoryBlobStore. Every test uses fresh owners, and the suite deletes only its own rows.

const PATH = "/v1/admin/media";
const CDN_HOST = "t5-zone.b-cdn.net";
const CDN_KEY = "t5-test-signing-key-0123456789abcdef";
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A minimal valid PNG; `extra` varies the bytes (an ancillary chunk after IHDR). */
function png(w = 64, h = 48, extra = 0): Buffer {
  const ancillary = extra === 0 ? [] : [...be32(extra), 0x74, 0x45, 0x58, 0x74, ...Array<number>(extra).fill(65), 0, 0, 0, 0];
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...ancillary,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

const bearer = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid, "demo-airplane-games", "password")}` });
let keyCounter = 0;
const newKey = () => `t5-${randomUUID().slice(0, 8)}-${keyCounter++}`;
let extra = 1000 + Math.floor(Math.random() * 100_000);
const uniquePng = () => png(64, 48, extra++);

type Booted = { app: NestExpressApplication; server: ReturnType<NestExpressApplication["getHttpServer"]> };
async function boot(cdn: boolean): Promise<Booted> {
  const base = loadConfig(process.env);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue({ ...base, cdn: cdn ? { host: CDN_HOST, tokenKey: CDN_KEY } : undefined })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  return { app, server: app.getHttpServer() };
}

let withCdn: Booted;
let withoutCdn: Booted;
let sql: pg.Pool;
const principals: string[] = [];

type Actor = { uid: string; principal: string; auth: { Authorization: string } };
async function actor(role: "photographer" | "admin" | null): Promise<Actor> {
  const uid = `media5-${role ?? "none"}-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  principals.push(principal);
  if (role) await seedRole(sql, principal, role);
  return { uid, principal, auth: bearer(uid) };
}

type Item = { id: string; state: string; revision: number; draftVersion: number; publishedVersion: number | null; owner?: string; draft: Record<string, any> };

const create = (who: Actor, bytes = uniquePng()) =>
  request(withCdn.server).post(PATH).set(who.auth).set("Content-Type", "image/png").set("Idempotency-Key", newKey()).set("X-Rights-Statement", "v1_own").send(bytes);
const list = (who: Actor, query = "", b = withCdn) => request(b.server).get(`${PATH}${query}`).set(who.auth);
const get = (who: Actor, id: string, query = "", b = withCdn) => request(b.server).get(`${PATH}/${id}${query}`).set(who.auth);
const idOf = (id: string) => Number(id.slice(4));

async function uploaded(who: Actor, n: number): Promise<Item[]> {
  const items: Item[] = [];
  for (let i = 0; i < n; i += 1) {
    const res = await create(who);
    expect(res.status).toBe(201);
    items.push(res.body);
  }
  return items;
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  withCdn = await boot(true);
  withoutCdn = await boot(false);
});

afterAll(async () => {
  setTestDatabaseClockSkew(0);
  const owned = "(SELECT id FROM media_items WHERE owner = ANY($1))";
  await sql.query(`DELETE FROM media_upload_keys WHERE media_id IN ${owned}`, [principals]);
  await sql.query(`DELETE FROM media_versions WHERE media_id IN ${owned}`, [principals]);
  await sql.query("DELETE FROM media_items WHERE owner = ANY($1)", [principals]);
  await sql.query("DELETE FROM admin_audit WHERE actor = ANY($1)", [principals]);
  await sql.query("DELETE FROM account_roles WHERE principal = ANY($1)", [principals]);
  await sql.end();
  await withCdn.app.close();
  await withoutCdn.app.close();
});

describe("GET /v1/admin/media", () => {
  it("needs a token and a photographer or admin role", async () => {
    expect((await request(withCdn.server).get(PATH)).status).toBe(401);
    expect((await list(await actor(null))).status).toBe(403);
  });

  it("lists a photographer's own items only, newest first, without the owner field", async () => {
    const mine = await actor("photographer");
    const other = await actor("photographer");
    const [a, b, c] = await uploaded(mine, 3);
    await uploaded(other, 2);
    const res = await list(mine);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.items.map((i: Item) => i.id)).toEqual([c!.id, b!.id, a!.id]);
    expect(res.body.nextCursor).toBeNull();
    for (const item of res.body.items as Item[]) {
      expect(item).not.toHaveProperty("owner");
      expect(item.draft).toMatchObject({ version: 1, contentType: "image/png" });
    }
  });

  it("shows an admin every owner's items with the owner field, and filters by state", async () => {
    const admin = await actor("admin");
    const owner = await actor("photographer");
    const [first, second] = await uploaded(owner, 2);
    const adminPublish = await request(withCdn.server)
      .patch(`${PATH}/${first!.id}`)
      .set(owner.auth)
      .send({ revision: first!.revision, licence: { credit: "A. Pilot", licenceName: "CC BY 4.0" } });
    expect(adminPublish.status).toBe(200);
    const pub = await request(withCdn.server).post(`${PATH}/${first!.id}/publish`).set(admin.auth).send({ revision: adminPublish.body.revision });
    expect(pub.status).toBe(200);

    const all = await list(admin, "?limit=100");
    expect(all.status).toBe(200);
    const mineInAll = (all.body.items as Item[]).filter((i) => [first!.id, second!.id].includes(i.id));
    expect(mineInAll.map((i) => i.owner)).toEqual([owner.principal, owner.principal]);

    const published = await list(admin, "?state=published&limit=100");
    expect((published.body.items as Item[]).every((i) => i.state === "published")).toBe(true);
    expect((published.body.items as Item[]).map((i) => i.id)).toContain(first!.id);
    expect((published.body.items as Item[]).map((i) => i.id)).not.toContain(second!.id);
    const unverified = await list(owner, "?state=unverified");
    expect((unverified.body.items as Item[]).map((i) => i.id)).toEqual([second!.id]);
  });

  it("pages with an opaque cursor that stays stable while new items are inserted", async () => {
    const who = await actor("photographer");
    const items = await uploaded(who, 5); // ids ascending
    const ids = items.map((i) => i.id).reverse(); // newest first

    const page1 = await list(who, "?limit=2");
    expect(page1.body.items.map((i: Item) => i.id)).toEqual(ids.slice(0, 2));
    expect(typeof page1.body.nextCursor).toBe("string");
    expect(page1.body.nextCursor).not.toMatch(/\d{3}/); // not a bare id or offset

    const [late] = await uploaded(who, 1); // inserted between the pages
    const page2 = await list(who, `?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items.map((i: Item) => i.id)).toEqual(ids.slice(2, 4));
    const page3 = await list(who, `?limit=2&cursor=${page2.body.nextCursor}`);
    expect(page3.body.items.map((i: Item) => i.id)).toEqual(ids.slice(4));
    expect(page3.body.nextCursor).toBeNull();

    const seen = [...page1.body.items, ...page2.body.items, ...page3.body.items].map((i: Item) => i.id);
    expect(new Set(seen).size).toBe(5);
    expect(seen).not.toContain(late!.id); // it is newer than the first page: a fresh listing shows it first
    expect((await list(who, "?limit=1")).body.items[0].id).toBe(late!.id);
  });

  it("an exact-size last page has no nextCursor", async () => {
    const who = await actor("photographer");
    await uploaded(who, 2);
    const res = await list(who, "?limit=2");
    expect(res.body.items).toHaveLength(2);
    expect(res.body.nextCursor).toBeNull();
  });

  it("is strict: limit 1 to 100 only, known parameters only, no repeats, and only a cursor this route returned", async () => {
    const who = await actor("photographer");
    const [item] = await uploaded(who, 2);
    for (const q of ["?limit=0", "?limit=101", "?limit=-1", "?limit=abc", "?limit=1.5", "?limit=010", "?limit=", "?limit=1&limit=2", "?state=live", "?state=", "?extra=1", "?cursor=", "?cursor=not-a-cursor", `?cursor=${"A".repeat(101)}`, "?cursor=%20"]) {
      const res = await list(who, q);
      expect(res.status, q).toBe(400);
      expect(res.body.error.code, q).toBe("invalid_request");
    }
    expect((await list(who, "?limit=100")).status).toBe(200);
    expect((await list(who, "?limit=1")).status).toBe(200);

    // A cursor made under one state filter is refused under another, and a hand-built cursor is refused.
    const page = await list(who, "?limit=1");
    expect(page.body.nextCursor).not.toBeNull();
    expect((await list(who, `?limit=1&state=unverified&cursor=${page.body.nextCursor}`)).status).toBe(400);
    // Cursors are unsigned by design (they grant nothing), so a hand-built CANONICAL cursor is accepted. Refused: text that does
    // not decode to `m1.<filter>.<id>`, and a non-canonical spelling of a real cursor. "m1.-.12" is 7 bytes, so its last
    // base64url character carries 4 padding bits: flipping the lowest bit decodes to the same text but is not canonical.
    expect(idOf(item!.id)).toBeGreaterThan(0);
    for (const text of ["m1.-.0", "m1.-.abc", "m2.-.12", "m1.live.12", "m1.-.12.3"]) {
      expect((await list(who, `?cursor=${Buffer.from(text).toString("base64url")}`)).status, text).toBe(400);
    }
    const canonical = Buffer.from("m1.-.12").toString("base64url");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const nonCanonical = canonical.slice(0, -1) + alphabet[alphabet.indexOf(canonical.at(-1)!) ^ 1];
    expect(Buffer.from(nonCanonical, "base64url").toString()).toBe("m1.-.12");
    expect((await list(who, `?cursor=${nonCanonical}`)).status).toBe(400);
    expect((await list(who, `?cursor=${canonical}`)).status).toBe(200);
    const stateCursor = (await list(who, "?limit=1&state=unverified")).body.nextCursor;
    expect((await list(who, `?limit=1&state=unverified&cursor=${stateCursor}`)).status).toBe(200);
  });

  describe("?pending=true", () => {
    const patchItem = (who: Actor, item: { id: string }, revision: number, licence: object) =>
      request(withCdn.server).patch(`${PATH}/${item.id}`).set(who.auth).send({ revision, licence });
    const publishItem = (who: Actor, item: { id: string }, revision: number) =>
      request(withCdn.server).post(`${PATH}/${item.id}/publish`).set(who.auth).send({ revision });
    const ids = (res: request.Response) => (res.body.items as Item[]).map((i) => i.id);

    /** Five items for one photographer: unverified, published clean, published + licence edit, published + new version, withdrawn. */
    async function seeded(photographer: Actor, admin: Actor) {
      const [unverified, clean, licenceEdit, newVersion, withdrawn] = await uploaded(photographer, 5);
      const published: Item[] = [];
      for (const item of [clean!, licenceEdit!, newVersion!, withdrawn!]) {
        const named = await patchItem(photographer, item, item.revision, { credit: "A. Pilot", licenceName: "CC BY 4.0" });
        expect(named.status).toBe(200);
        const pub = await publishItem(admin, item, named.body.revision);
        expect(pub.status).toBe(200);
        published.push(pub.body);
      }
      const edit = await patchItem(photographer, licenceEdit!, published[1]!.revision, { credit: "Renamed" });
      expect(edit.status).toBe(200);
      const version = await request(withCdn.server)
        .post(`${PATH}/${newVersion!.id}/versions?revision=${published[2]!.revision}`)
        .set(photographer.auth)
        .set("Content-Type", "image/png")
        .set("Idempotency-Key", newKey()).set("X-Rights-Statement", "v1_own")
        .send(uniquePng());
      expect(version.status).toBe(201);
      const gone = await request(withCdn.server).post(`${PATH}/${withdrawn!.id}/withdraw`).set(admin.auth).send({ revision: published[3]!.revision });
      expect(gone.status).toBe(200);
      return { unverified: unverified!, clean: clean!, licenceEdit: licenceEdit!, newVersion: newVersion!, withdrawn: withdrawn! };
    }

    it("lists only published items whose draft is ahead of the published version; photographers see only their own", async () => {
      const admin = await actor("admin");
      const photographer = await actor("photographer");
      const other = await actor("photographer");
      const s = await seeded(photographer, admin);
      const foreign = await seeded(other, admin);

      const mine = await list(photographer, "?pending=true");
      expect(mine.status).toBe(200);
      expect(ids(mine)).toEqual([s.newVersion.id, s.licenceEdit.id]);
      for (const item of mine.body.items as Item[]) {
        expect(item.state).toBe("published");
        expect(item.draftVersion).toBeGreaterThan(item.publishedVersion!);
        expect(item).not.toHaveProperty("owner");
      }
      expect(ids(await list(photographer, "?pending=true&state=published"))).toEqual([s.newVersion.id, s.licenceEdit.id]);

      const all = ids(await list(admin, "?pending=true&limit=100"));
      expect(all).toEqual(expect.arrayContaining([s.newVersion.id, s.licenceEdit.id, foreign.newVersion.id, foreign.licenceEdit.id]));
      for (const excluded of [s.unverified, s.clean, s.withdrawn, foreign.unverified, foreign.clean, foreign.withdrawn]) expect(all).not.toContain(excluded.id);
    });

    it("pages with limit=1, and a cursor is bound to the pending filter", async () => {
      const admin = await actor("admin");
      const photographer = await actor("photographer");
      const s = await seeded(photographer, admin);

      const page1 = await list(photographer, "?pending=true&limit=1");
      expect(ids(page1)).toEqual([s.newVersion.id]);
      expect(page1.body.nextCursor).not.toBeNull();
      const page2 = await list(photographer, `?pending=true&limit=1&cursor=${page1.body.nextCursor}`);
      expect(ids(page2)).toEqual([s.licenceEdit.id]);
      expect(page2.body.nextCursor).toBeNull();

      for (const q of [`?limit=1&cursor=${page1.body.nextCursor}`, `?state=published&limit=1&cursor=${page1.body.nextCursor}`]) {
        expect((await list(photographer, q)).status, q).toBe(400);
      }
      const plain = await list(photographer, "?limit=1");
      expect((await list(photographer, `?pending=true&limit=1&cursor=${plain.body.nextCursor}`)).status).toBe(400);
      const published = await list(photographer, "?state=published&limit=1");
      expect(published.body.nextCursor).not.toBeNull();
      expect((await list(photographer, `?pending=true&limit=1&cursor=${published.body.nextCursor}`)).status).toBe(400);
    });

    it("accepts only the literal true, and only with state=published or no state", async () => {
      const who = await actor("photographer");
      for (const q of ["?pending=false", "?pending=1", "?pending=", "?pending=TRUE", "?pending=true&pending=true", "?pending=true&state=unverified", "?pending=true&state=withdrawn"]) {
        const res = await list(who, q);
        expect(res.status, q).toBe(400);
        expect(res.body.error.code, q).toBe("invalid_request");
      }
      expect((await list(who, "?pending=true")).status).toBe(200);
    });
  });
});

describe("GET /v1/admin/media/{mediaId}", () => {
  it("returns the item, every version oldest first and a signed preview of the draft that verifies with the signer", async () => {
    const who = await actor("photographer");
    const [item] = await uploaded(who, 1);
    const second = uniquePng();
    const v2 = await request(withCdn.server)
      .post(`${PATH}/${item!.id}/versions?revision=${item!.revision}`)
      .set(who.auth)
      .set("Content-Type", "image/png")
      .set("Idempotency-Key", newKey()).set("X-Rights-Statement", "v1_own")
      .send(second);
    expect(v2.status).toBe(201);

    const before = (await sql.query<{ t: Date }>("SELECT clock_timestamp() AS t")).rows[0]!.t;
    const res = await get(who, item!.id);
    const after = (await sql.query<{ t: Date }>("SELECT clock_timestamp() AS t")).rows[0]!.t;
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.item).toMatchObject({ id: item!.id, state: "unverified", draftVersion: 2, publishedVersion: null });
    expect(res.body.item).not.toHaveProperty("owner");
    expect(res.body.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(res.body.versions[1]).toEqual(res.body.item.draft);

    const preview = res.body.preview;
    expect(Object.keys(preview).sort()).toEqual(
      ["contentType", "expiresAt", "height", "licence", "mediaId", "reason", "sha256", "url", "version", "width"].sort(),
    );
    expect(preview).toMatchObject({ mediaId: item!.id, version: 2, sha256: res.body.item.draft.sha256, contentType: "image/png", width: 64, height: 48, reason: null });
    expect(preview.licence).toEqual(res.body.item.draft.licence);

    // The URL is on the configured host, names the digest, and verifies with the T1 signer under the configured key.
    const url = new URL(preview.url);
    expect(url.host).toBe(CDN_HOST);
    expect(url.pathname).toBe(`/backend/content/photos/${preview.sha256}.png`);
    expect(verifyCdnToken(preview.url, CDN_KEY, new Date())).toBe(true);
    expect(verifyCdnToken(preview.url, `${CDN_KEY}x`, new Date())).toBe(false);

    // expiresAt = database now + 24 h (whole seconds), and is the signed expiry.
    const expires = Date.parse(preview.expiresAt);
    expect(Number(url.searchParams.get("expires"))).toBe(expires / 1000);
    expect(expires).toBeGreaterThanOrEqual(Math.floor((before.getTime() + 86_400_000) / 1000) * 1000);
    expect(expires).toBeLessThanOrEqual(after.getTime() + 86_400_000);
    expect(verifyCdnToken(preview.url, CDN_KEY, new Date(expires - 1000))).toBe(true);
    expect(verifyCdnToken(preview.url, CDN_KEY, new Date(expires))).toBe(false);
  });

  it("follows the database clock, not the process clock", async () => {
    const who = await actor("photographer");
    const [item] = await uploaded(who, 1);
    try {
      setTestDatabaseClockSkew(3 * 3_600_000);
      const res = await get(who, item!.id);
      const expires = Date.parse(res.body.preview.expiresAt);
      expect(expires - Date.now()).toBeGreaterThan(26.9 * 3_600_000);
      expect(expires - Date.now()).toBeLessThan(27.1 * 3_600_000);
    } finally {
      setTestDatabaseClockSkew(0);
    }
  });

  it("signs a preview in every state (unverified, published, withdrawn) and never leaks the key or a storage path", async () => {
    const admin = await actor("admin");
    const owner = await actor("photographer");
    const [item] = await uploaded(owner, 1);
    const edited = await request(withCdn.server)
      .patch(`${PATH}/${item!.id}`)
      .set(owner.auth)
      .send({ revision: item!.revision, licence: { credit: "A. Pilot", licenceName: "CC BY 4.0" } });
    const published = await request(withCdn.server).post(`${PATH}/${item!.id}/publish`).set(admin.auth).send({ revision: edited.body.revision });
    expect(published.status).toBe(200);
    const live = await get(admin, item!.id);
    expect(live.body.item.state).toBe("published");
    expect(verifyCdnToken(live.body.preview.url, CDN_KEY, new Date())).toBe(true);
    const withdrawn = await request(withCdn.server).post(`${PATH}/${item!.id}/withdraw`).set(admin.auth).send({ revision: published.body.revision });
    expect(withdrawn.status).toBe(200);

    const res = await get(owner, item!.id);
    expect(res.body.item.state).toBe("withdrawn");
    expect(verifyCdnToken(res.body.preview.url, CDN_KEY, new Date())).toBe(true);
    expect(res.body.preview.licence).toMatchObject({ credit: "A. Pilot", licenceName: "CC BY 4.0" });
    const text = JSON.stringify(res.body) + JSON.stringify((await list(owner)).body);
    expect(text).not.toContain(CDN_KEY);
    // Only the signed URL carries a path; there is no separate path or storage field anywhere.
    expect(text.match(/content\/photos\//g)).toHaveLength(1);
    expect(Object.keys(res.body.preview)).not.toContain("path");

    expect(live.body.item.owner).toBe(owner.principal);
  });

  it("a signed preview exists for an unverified item too", async () => {
    const who = await actor("photographer");
    const [item] = await uploaded(who, 1);
    const res = await get(who, item!.id);
    expect(res.body.item.state).toBe("unverified");
    expect(verifyCdnToken(res.body.preview.url, CDN_KEY, new Date())).toBe(true);
  });

  it("is 404 for another photographer's item and for unknown or malformed ids; an admin reads any item", async () => {
    const owner = await actor("photographer");
    const other = await actor("photographer");
    const admin = await actor("admin");
    const [item] = await uploaded(owner, 1);
    const hidden = await get(other, item!.id);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe("not_found");
    expect((await get(owner, "med-999999999999")).status).toBe(404);
    for (const id of ["med-0", "med-01", "med-1x", "1", "med-", "MED-1"]) {
      expect((await get(owner, id)).status, id).toBe(404);
    }
    const adminView = await get(admin, item!.id);
    expect(adminView.status).toBe(200);
    expect(adminView.body.item.owner).toBe(owner.principal);
    expect((await get(await actor(null), item!.id)).status).toBe(403);
    expect((await request(withCdn.server).get(`${PATH}/${item!.id}`)).status).toBe(401);
  });

  it("refuses query parameters", async () => {
    const who = await actor("photographer");
    const [item] = await uploaded(who, 1);
    const res = await get(who, item!.id, "?x=1");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });
});

describe("without a CDN host and key (a local run)", () => {
  it("the preview has url null, expiresAt null and reason cdn_not_configured", async () => {
    const who = await actor("photographer");
    const [item] = await uploaded(who, 1);
    const res = await get(who, item!.id, "", withoutCdn);
    expect(res.status).toBe(200);
    expect(res.body.preview).toMatchObject({ mediaId: item!.id, version: 1, url: null, expiresAt: null, reason: "cdn_not_configured" });
    expect(res.body.preview.sha256).toBe(res.body.item.draft.sha256);
    expect(res.body.item.id).toBe(item!.id);
    expect((await list(who, "", withoutCdn)).status).toBe(200);
  });
});
