import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import type pg from "pg";
import request from "supertest";
import { expect } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { APP_CONFIG, loadConfig } from "../src/config/config.module.js";
import type { EditorialData } from "../src/content/editorial/editorial-rules.js";
import { demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";

// Shared fixtures of the editorial e2e suites (docs/plans/website-content.md W1): a booted app, actors with seeded roles, and
// media driven through the REAL media routes (upload, licence edit, publish, withdraw), so the desks see exactly what production has.

export const STAFF_MEDIA = "/v1/admin/media";
export const CDN_HOST = "ed-zone.b-cdn.net";
export const CDN_KEY = "ed-test-signing-key-0123456789abcdef";

type Server = ReturnType<NestExpressApplication["getHttpServer"]>;
export type Booted = { app: NestExpressApplication; server: Server };

export async function boot(overrides: Record<string, unknown> = {}): Promise<Booted> {
  const base = loadConfig(process.env);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue({ ...base, cdn: { host: CDN_HOST, tokenKey: CDN_KEY }, ...overrides })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  return { app, server: app.getHttpServer() };
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function png(w: number, h: number, extra: number): Buffer {
  const ancillary = [...be32(extra), 0x74, 0x45, 0x58, 0x74, ...Array<number>(extra).fill(65), 0, 0, 0, 0];
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...ancillary,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

export const bearer = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid, "demo-airplane-games", "password")}` });

export type Actor = { principal: string; auth: { Authorization: string } };
export type PublishedMedia = { id: string; revision: number; sha256: string };

/** A well-formed `data` object; override any field. */
export function goodData(over: Partial<EditorialData> = {}): EditorialData {
  return {
    title: "Sunrise departure",
    aircraft: "Boeing 787-9",
    photographer: "A. Pilot",
    instagram: "@a.pilot",
    credit: "STAFF-TYPED-CREDIT",
    description: "A factual description of the photo that is long enough.",
    correctAnswer: "Boeing 787",
    distractors: ["Airbus A350", "Boeing 777", "Airbus A330"],
    difficulty: "captain",
    factualSource: "https://example.com/source",
    ...over,
  };
}

export class Fixtures {
  readonly principals: string[] = [];
  owner!: Actor;
  admin!: Actor;
  player!: Actor;
  private extra = 2000 + Math.floor(Math.random() * 100_000);
  private keys = 0;

  constructor(
    readonly sql: pg.Pool,
    private readonly serverOf: () => Server,
  ) {}

  async init(): Promise<void> {
    this.owner = await this.actor("photographer");
    this.admin = await this.actor("admin");
    this.player = await this.actor(null);
  }

  async actor(role: "photographer" | "admin" | null): Promise<Actor> {
    const uid = `editorial-${role ?? "none"}-${randomUUID()}`;
    const principal = demoPrincipal(uid);
    this.principals.push(principal);
    if (role) await seedRole(this.sql, principal, role);
    return { principal, auth: bearer(uid) };
  }

  private get server(): Server {
    return this.serverOf();
  }

  /** Upload a photo as the photographer (rights v1_own). Not yet published. */
  async upload(): Promise<{ id: string; revision: number }> {
    const res = await request(this.server)
      .post(STAFF_MEDIA)
      .set(this.owner.auth)
      .set("Content-Type", "image/png")
      .set("Idempotency-Key", `ed-${randomUUID().slice(0, 8)}-${this.keys++}`)
      .set("X-Rights-Statement", "v1_own")
      .send(png(64, 48, this.extra++));
    expect(res.status).toBe(201);
    return { id: res.body.id, revision: res.body.revision };
  }

  /** Edit the draft licence as an admin (only an admin may change creditRequired). Returns the new revision. */
  async editLicence(id: string, revision: number, licence: Record<string, unknown>): Promise<number> {
    const res = await request(this.server).patch(`${STAFF_MEDIA}/${id}`).set(this.admin.auth).send({ revision, licence });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.revision;
  }

  async publish(id: string, revision: number): Promise<number> {
    const res = await request(this.server).post(`${STAFF_MEDIA}/${id}/publish`).set(this.admin.auth).send({ revision });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.revision;
  }

  async withdraw(id: string, revision: number): Promise<number> {
    const res = await request(this.server).post(`${STAFF_MEDIA}/${id}/withdraw`).set(this.admin.auth).send({ revision });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.revision;
  }

  /** Upload, set the licence (credit `credit`, or none with creditRequired false), publish. */
  async publishedMedia(credit: string | null = "Licence Credit"): Promise<PublishedMedia> {
    const item = await this.upload();
    const licence =
      credit === null
        ? { licenceName: "CC0", creditRequired: false }
        : { credit, licenceName: "CC BY 4.0", licenceUrl: "https://example.com/l", attributionText: "By A." };
    const edited = await this.editLicence(item.id, item.revision, licence);
    const revision = await this.publish(item.id, edited);
    const detail = await request(this.server).get(`${STAFF_MEDIA}/${item.id}`).set(this.admin.auth);
    return { id: item.id, revision, sha256: detail.body.item.draft.sha256 };
  }

  /** Publish a NEW version of an already published item with another credit. Returns the new revision. */
  async republishWithCredit(media: PublishedMedia, credit: string | null): Promise<number> {
    const licence = credit === null ? { credit: null, creditRequired: false } : { credit };
    const edited = await this.editLicence(media.id, media.revision, licence);
    return this.publish(media.id, edited);
  }

  /** Remove everything the suites created (editorial rows first: they reference media). */
  async cleanup(): Promise<void> {
    const owned = "(SELECT id FROM media_items WHERE owner = ANY($1))";
    await this.sql.query(`DELETE FROM editorial_items WHERE created_by = ANY($1) OR media_id IN ${owned}`, [this.principals]);
    await this.sql.query(`DELETE FROM media_upload_keys WHERE media_id IN ${owned}`, [this.principals]);
    await this.sql.query(`DELETE FROM media_versions WHERE media_id IN ${owned}`, [this.principals]);
    await this.sql.query("DELETE FROM media_items WHERE owner = ANY($1)", [this.principals]);
    await this.sql.query("DELETE FROM admin_audit WHERE actor = ANY($1)", [this.principals]);
    await this.sql.query("DELETE FROM account_roles WHERE principal = ANY($1)", [this.principals]);
  }
}

/** Every key of a JSON value with its dotted path (array indices are not part of the path). */
export function keyPaths(value: unknown, path = "", out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keyPaths(v, path, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(path === "" ? k : `${path}.${k}`);
      keyPaths(v, path === "" ? k : `${path}.${k}`, out);
    }
  }
  return out;
}
