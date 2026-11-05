import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setTestDatabaseClockSkew } from "../src/database/clock.js";
import { verifyCdnToken } from "../src/platform/cdn-signer.js";
import { CDN_HOST, CDN_KEY, Fixtures, boot, goodData, keyPaths } from "./editorial-helpers.js";
import type { Booted, PublishedMedia } from "./editorial-helpers.js";
import { emulatorToken } from "./tokens.js";

// Wave W1 (docs/plans/website-content.md §1.2, §1.4): GET /v1/public/plane-of-the-day for anonymous guests. The desks build the fixtures.
// Items are dated far in the past (always due) or far in the future (never due), except the clock-seam tests, which move the
// DATABASE clock to a fixed instant and use dates around it.

const PATH = "/v1/public/plane-of-the-day";
const desk = "/v1/admin/editorial/plane-of-the-day/items";
const MARKS = { correctAnswer: "ANSWER-MARK", distractors: ["DISTRACT-ONE", "DISTRACT-TWO", "DISTRACT-THREE"], factualSource: "https://example.com/FACT-MARK", credit: "STAFF-TYPED-CREDIT" };

let app: Booted;
let demoApp: Booted;
let gated: Booted;
let noCdn: Booted;
let limited: Booted;
let sql: pg.Pool;
let fx: Fixtures;
let media: PublishedMedia;

type Feature = { id: string; date: string; title: string; image: { version: number; url: string | null; licence: { credit: string | null } } };
const read = (query = "", b: Booted = app) => request(b.server).get(`${PATH}${query}`);
const ids = (res: { body: { features: Feature[] } }) => res.body.features.map((f) => f.id);
const zone = (z: string) => `?timeZone=${encodeURIComponent(z)}`;

/** A scheduled or published Plane of the Day item on `date` with distinctive staff-only marks. */
async function feature(date: string, over: { status?: string; title?: string; media?: PublishedMedia } = {}): Promise<string> {
  const m = over.media ?? media;
  const made = await request(app.server).post(desk).set(fx.admin.auth).send({ mediaId: m.id });
  expect(made.status).toBe(201);
  const item = made.body.item;
  const saved = await request(app.server)
    .put(`${desk}/${item.id}`)
    .set(fx.admin.auth)
    .send({ version: 1, status: over.status ?? "published", data: goodData({ ...MARKS, title: over.title ?? "A Plane Title" }), dateKey: date });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return item.id;
}

/** Move the database clock to a fixed instant (the seam shifts it by a constant, so it keeps ticking). */
const clockAt = (iso: string) => setTestDatabaseClockSkew(Date.parse(iso) - Date.now());

afterEach(() => setTestDatabaseClockSkew(0));

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  app = await boot();
  fx = new Fixtures(sql, () => app.server);
  await fx.init();
  media = await fx.publishedMedia("Licence Credit");
  demoApp = await boot({ demoPrincipal: fx.owner.principal });
  gated = await boot({ minClientBuild: 20 });
  noCdn = await boot({ cdn: undefined });
  limited = await boot({ rateLimitStore: "memory", rateLimitPublicPerMin: 3, rateLimitAuthPerMin: 1000 });
});

afterAll(async () => {
  setTestDatabaseClockSkew(0);
  await fx.cleanup();
  await sql.end();
  for (const b of [app, demoApp, gated, noCdn, limited]) await b.app.close();
});

describe("GET /v1/public/plane-of-the-day", () => {
  it("answers 200 with no token, { day, features }, and today's UTC date by default", async () => {
    const before = new Date().toISOString().slice(0, 10);
    const res = await read();
    const after = new Date().toISOString().slice(0, 10);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.body).sort()).toEqual(["day", "features"]);
    expect([before, after]).toContain(res.body.day);
    expect(Array.isArray(res.body.features)).toBe(true);
    const utc = await read(zone("UTC"));
    expect(utc.body.day).toBe(res.body.day);
  });

  it("ignores the Authorization header: garbage, malformed and wrong-project tokens all still answer 200", async () => {
    const id = await feature("2020-04-01");
    const plain = await read();
    expect(ids(plain)).toContain(id);
    for (const header of ["garbage", "Bearer not.a.jwt", "Bearer ", `Bearer ${emulatorToken("x", "some-other-project", "password")}`]) {
      const res = await read("").set("Authorization", header);
      expect(res.status, header).toBe(200);
      expect(ids(res)).toContain(id);
    }
  });

  it("needs no client version even when the build gate is on", async () => {
    const res = await read("", gated);
    expect(res.status).toBe(200);
    const signedIn = await request(gated.server).get("/v1/media?ids=med-1").set(fx.player.auth);
    expect(signedIn.status).toBe(426);
  });

  it("shows only due, scheduled or published items whose photo is published, with a credit, and not demo-owned", async () => {
    const due = await feature("2020-05-01");
    const scheduledDue = await feature("2020-05-02", { status: "scheduled" });
    const future = await feature("2099-12-31");
    const archived = await feature("2020-05-03", { status: "archived" });
    const draftOnly = (await request(app.server).post(desk).set(fx.admin.auth).send({ mediaId: media.id })).body.item.id as string;
    const withdrawnMedia = await fx.publishedMedia();
    const withdrawn = await feature("2020-05-04", { media: withdrawnMedia });
    const creditless = await fx.publishedMedia("Temporary Credit");
    const noCredit = await feature("2020-05-05", { media: creditless });
    await fx.republishWithCredit(creditless, null);
    await fx.withdraw(withdrawnMedia.id, withdrawnMedia.revision);

    const res = await read();
    expect(res.status).toBe(200);
    const got = ids(res);
    expect(got).toContain(due);
    expect(got).toContain(scheduledDue);
    for (const hidden of [future, archived, draftOnly, withdrawn, noCredit]) expect(got, hidden).not.toContain(hidden);

    // The same data through an app that treats the photographer as the shared demo account: nothing of theirs is public.
    const asDemo = await read("", demoApp);
    expect(asDemo.status).toBe(200);
    for (const id of [due, scheduledDue]) expect(ids(asDemo)).not.toContain(id);
  });

  it("returns the public shape only, with the one public credit being image.licence.credit", async () => {
    const id = await feature("2020-06-01", { title: "Shape Title" });
    const res = await read();
    const f = res.body.features.find((x: Feature) => x.id === id);
    expect(f).toBeDefined();
    expect(Object.keys(f).sort()).toEqual(["aircraft", "date", "description", "id", "image", "instagram", "photographer", "title"]);
    expect(f).toMatchObject({ id, date: "2020-06-01", title: "Shape Title", aircraft: "Boeing 787-9", photographer: "A. Pilot", instagram: "@a.pilot" });
    expect(Object.keys(f.image).sort()).toEqual(["contentType", "expiresAt", "height", "licence", "mediaId", "reason", "sha256", "url", "version", "width"]);
    expect(f.image).toMatchObject({ mediaId: media.id, version: 1, sha256: media.sha256, contentType: "image/png", width: 64, height: 48, reason: null });
    expect(f.image.licence.credit).toBe("Licence Credit");
    expect(new URL(f.image.url).host).toBe(CDN_HOST);
    expect(verifyCdnToken(f.image.url, CDN_KEY, new Date())).toBe(true);
  });

  it("exposes no owner, principal, rights, answer, distractor, difficulty, source, status or version, and no credit outside image.licence", async () => {
    await feature("2020-06-02");
    const res = await read();
    expect(res.body.features.length).toBeGreaterThan(0);
    const paths = keyPaths(res.body);
    expect(paths).toContain("features.image.licence.credit"); // the scan sees nested keys
    for (const path of paths) {
      const key = path.split(".").pop() as string;
      for (const forbidden of ["owner", "createdBy", "updatedBy", "statedBy", "rights", "correctAnswer", "distractors", "factualSource", "difficulty", "status", "kind", "dateKey", "data", "createdAt", "updatedAt"]) {
        expect(key, path).not.toBe(forbidden);
      }
      if (key === "credit") expect(path).toBe("features.image.licence.credit");
      if (key === "version") expect(path).toBe("features.image.version");
      if (key === "description") expect(path).toBe("features.description"); // never the media's staff description
    }
    const text = JSON.stringify(res.body);
    for (const secret of [MARKS.credit, MARKS.correctAnswer, ...MARKS.distractors, "FACT-MARK", fx.admin.principal, fx.owner.principal, CDN_KEY]) expect(text, secret).not.toContain(secret);
  });

  it("is newest first: date, then last updated, then id; several items on one date all appear", async () => {
    const a = await feature("2020-07-05");
    const s = await feature("2020-07-04", { status: "scheduled" });
    const b = await feature("2020-07-06");
    const c1 = await feature("2020-07-06");
    const c2 = await feature("2020-07-06");
    const res = await read();
    const mine = new Set([a, s, b, c1, c2]);
    // Created in order b, c1, c2, so the one saved last is first within the date.
    expect(ids(res).filter((id) => mine.has(id))).toEqual([c2, c1, b, a, s]);
    // Touching b (now at version 2) makes it the most recently updated of its date.
    const bump = await request(app.server).put(`${desk}/${b}`).set(fx.admin.auth).send({ version: 2, status: "published", data: goodData({ ...MARKS, title: "Bumped Title" }), dateKey: "2020-07-06" });
    expect(bump.status, JSON.stringify(bump.body)).toBe(200);
    expect(ids(await read()).filter((id) => mine.has(id))).toEqual([b, c2, c1, a, s]);
  });

  it("a withdrawn photo disappears at once, and comes back when it is published again", async () => {
    const m = await fx.publishedMedia("Round Trip");
    const id = await feature("2020-08-01", { media: m });
    expect(ids(await read())).toContain(id);
    const revision = await fx.withdraw(m.id, m.revision);
    expect(ids(await read())).not.toContain(id);
    await fx.publish(m.id, revision);
    expect(ids(await read())).toContain(id);
  });

  it("ASSUMPTION: the feature follows the media's current published version (not pinned)", async () => {
    const m = await fx.publishedMedia("First Credit");
    const id = await feature("2020-08-02", { media: m });
    const first = (await read()).body.features.find((f: Feature) => f.id === id) as Feature;
    expect(first.image).toMatchObject({ version: 1 });
    expect(first.image.licence.credit).toBe("First Credit");
    await fx.republishWithCredit(m, "Second Credit");
    const second = (await read()).body.features.find((f: Feature) => f.id === id) as Feature;
    expect(second.image.version).toBe(2);
    expect(second.image.licence.credit).toBe("Second Credit");
    const row = (await sql.query("SELECT version FROM editorial_items WHERE id = $1", [Number(id.slice(3))])).rows[0];
    expect(row.version).toBe(2); // nothing was rewritten on the item
  });

  it("answers url null and reason cdn_not_configured without a CDN", async () => {
    const id = await feature("2020-08-03");
    const f = (await read("", noCdn)).body.features.find((x: Feature) => x.id === id) as Feature;
    expect(f.image).toMatchObject({ url: null, expiresAt: null, reason: "cdn_not_configured" });
  });

  it.each([
    ["+2359", "an offset zone Node accepts"],
    ["+23:59", "an offset zone Node accepts"],
    ["+14", "an offset zone Node accepts"],
    ["-05", "a negative offset"],
    ["Etc/../x", "a path trick"],
    ["a".repeat(65), "65 characters"],
    ["Nowhere/City", "not a zone"],
    ["", "empty"],
    [" UTC", "a leading space"],
  ])("is 400 invalid_request for timeZone %j (%s)", async (value) => {
    const res = await read(`?timeZone=${encodeURIComponent(value)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it.each([["an unknown key", "?foo=bar"], ["an extra key", "?timeZone=UTC&x=1"], ["a repeated timeZone", "?timeZone=UTC&timeZone=UTC"]])("is 400 invalid_request for %s", async (_name, query) => {
    const res = await read(query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("is rate limited per IP on the public tier: 429 rate_limited with Retry-After after the limit", async () => {
    for (let i = 0; i < 3; i += 1) expect((await read("", limited)).status).toBe(200);
    const res = await read("", limited);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate_limited");
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });
});

describe("the viewer's day, with the database clock moved (the clock seam)", () => {
  let x10: string;
  let x11: string;
  let x12: string;
  let x13: string;
  beforeAll(async () => {
    x10 = await feature("2031-03-10");
    x11 = await feature("2031-03-11");
    x12 = await feature("2031-03-12");
    x13 = await feature("2031-03-13");
  });
  const mine = (res: { body: { features: Feature[] } }) => ids(res).filter((id) => [x10, x11, x12, x13].includes(id));
  const named = (res: { body: { features: Feature[] } }) => mine(res).map((id) => ({ [x10]: "x10", [x11]: "x11", [x12]: "x12", [x13]: "x13" })[id]);

  it("23:30 UTC on 10 March: each zone sees its own date, never a later one", async () => {
    clockAt("2031-03-10T23:30:00Z");
    const utc = await read(zone("UTC"));
    expect(utc.body.day).toBe("2031-03-10");
    expect(named(utc)).toEqual(["x10"]);
    const auckland = await read(zone("Pacific/Auckland")); // UTC+13 (NZDT) until April
    expect(auckland.body.day).toBe("2031-03-11");
    expect(named(auckland)).toEqual(["x11", "x10"]);
    const la = await read(zone("America/Los_Angeles")); // PDT, UTC-7
    expect(la.body.day).toBe("2031-03-10");
    expect(named(la)).toEqual(["x10"]);
    const kiritimati = await read(zone("Pacific/Kiritimati")); // UTC+14
    expect(kiritimati.body.day).toBe("2031-03-11");
    expect(named(kiritimati)).toEqual(["x11", "x10"]);
    const samoa = await read(zone("Pacific/Pago_Pago")); // UTC-11: still the morning of the 10th
    expect(samoa.body.day).toBe("2031-03-10");
    // No zone sees the 12th or 13th at this instant.
    for (const res of [utc, auckland, la, kiritimati, samoa]) expect(named(res)).not.toContain("x12");
  });

  it("midnight crossing: one minute either side of 00:00 UTC changes UTC's day and nobody else's early", async () => {
    clockAt("2031-03-10T23:59:00Z");
    expect((await read(zone("UTC"))).body.day).toBe("2031-03-10");
    clockAt("2031-03-11T00:01:00Z");
    const utc = await read(zone("UTC"));
    expect(utc.body.day).toBe("2031-03-11");
    expect(named(utc)).toEqual(["x11", "x10"]);
    // The default zone is UTC.
    expect((await read()).body.day).toBe("2031-03-11");
  });

  it("ASSUMPTION: a UTC+14 viewer sees the next UTC date's feature, never the one after", async () => {
    clockAt("2031-03-11T09:57:00Z"); // 23:57 on the 11th in UTC+14
    const early = await read(zone("Pacific/Kiritimati"));
    expect(early.body.day).toBe("2031-03-11");
    expect(named(early)).toEqual(["x11", "x10"]);
    clockAt("2031-03-11T10:00:40Z"); // past local midnight in UTC+14: the 12th
    const late = await read(zone("Pacific/Kiritimati"));
    expect(late.body.day).toBe("2031-03-12");
    expect(named(late)).toEqual(["x12", "x11", "x10"]);
    expect(named(late)).not.toContain("x13");
    // Every zone at that instant: nobody is past the 12th, and UTC is still on the 11th.
    for (const z of ["Pacific/Kiritimati", "Pacific/Auckland", "Pacific/Apia", "Asia/Tokyo", "UTC", "America/New_York", "Pacific/Pago_Pago"]) {
      expect(named(await read(zone(z))), z).not.toContain("x13");
    }
    expect((await read(zone("UTC"))).body.day).toBe("2031-03-11");
  });

  it("an offset zone cannot reach tomorrow's feature early (+23:59 is refused, not honoured)", async () => {
    clockAt("2031-03-11T00:01:00Z");
    const res = await read(zone("+23:59"));
    expect(res.status).toBe(400);
  });
});

// Last: it adds more than 100 features.
describe("the public list is capped", () => {
  it("returns at most 100 features, newest first", async () => {
    const mediaNum = Number(media.id.slice(4));
    const data = JSON.stringify(goodData({ ...MARKS, title: "Bulk Title" }));
    await sql.query(
      `INSERT INTO editorial_items (kind, media_id, status, date_key, data, created_at, updated_at, created_by, updated_by)
       SELECT 'plane-of-the-day', $1, 'published', DATE '2019-01-01' + g, $2::jsonb, now(), now(), $3, $3 FROM generate_series(1, 101) AS g`,
      [mediaNum, data, fx.admin.principal],
    );
    try {
      const res = await read();
      expect(res.status).toBe(200);
      expect(res.body.features).toHaveLength(100);
      const dates = res.body.features.map((f: Feature) => f.date);
      expect([...dates].sort().reverse()).toEqual(dates);
    } finally {
      await sql.query("DELETE FROM editorial_items WHERE data->>'title' = 'Bulk Title' AND date_key < DATE '2019-06-01'");
    }
  });
});
