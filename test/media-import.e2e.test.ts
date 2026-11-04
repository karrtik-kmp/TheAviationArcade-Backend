import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { loadConfig } from "../src/config/config.module.js";
import type { AppConfig } from "../src/config/config.module.js";
import { DatabaseService } from "../src/database/database.module.js";
import {
  applyRefusal,
  composeImportDescription,
  exitCodeOf,
  isBareFilename,
  loadBundle,
  parseManifest,
  parseSubmittedAt,
  runMediaImport,
} from "../src/content/media/media-import.js";
import type { EntryReport, ImportEntry, ImportManifest, ImportReport } from "../src/content/media/media-import.js";
import { StorageUnavailableError } from "../src/storage/blob-store.js";
import type { BlobStore } from "../src/storage/blob-store.js";
import { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { demoPrincipal, seedRole } from "./roles-helpers.js";
import { emulatorToken } from "./tokens.js";

// Wave I (docs/plans/media-rights-and-public.md, docs/plans/media-import.md): the D1 import core run in-process with an injected
// MemoryBlobStore against the real test database, the built CLI in a child process, and the publish path through the HTTP routes.

// A local .env may name the real Bunny store (vitest.e2e.config.ts loads it). This file must never reach it: force the memory store
// and drop every BUNNY_* setting for this worker (and so for the CLI child processes, which inherit the environment).
process.env.BLOB_STORE = "memory";
for (const name of Object.keys(process.env)) if (name.startsWith("BUNNY_")) delete process.env[name];

const be32 =(n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function png(extra: number): Buffer {
  const ancillary = [...be32(extra), 0x74, 0x45, 0x58, 0x74, ...Array<number>(extra).fill(65), 0, 0, 0, 0];
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(64), ...be32(48), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...ancillary,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let bytesCounter = 0;
const freshPng = () => png(3000 + ++bytesCounter + Math.floor(Math.random() * 1e5) * 10);
const bearer = (uid: string) => ({ Authorization: `Bearer ${emulatorToken(uid, "demo-airplane-games", "password")}` });

let sql: pg.Pool;
let database: DatabaseService;
let config: AppConfig;
let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;
const principals: string[] = [];
const dirs: string[] = [];
const sourceIds: string[] = [];

type Actor = { uid: string; principal: string };
async function account(role: "photographer" | "admin" | null, state: "active" | "revoked" | "blocked" | "pending" = "active"): Promise<Actor> {
  const uid = `mimport-${role ?? "none"}-${randomUUID()}`;
  const principal = demoPrincipal(uid);
  principals.push(principal);
  if (role) await seedRole(sql, principal, role, state);
  return { uid, principal };
}

/** A bundle directory with `files` (name -> bytes) and a manifest of `entries`. */
async function bundle(entries: unknown[], files: Record<string, Uint8Array> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "media-import-"));
  dirs.push(dir);
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(dir, name), bytes);
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, source: "d1", entries }));
  return dir;
}

/** One manifest entry for `bytes` stored as `<sourceId>.png`, plus the file map. */
function made(owner: string, over: Record<string, unknown> = {}, bytes: Buffer = freshPng()) {
  const sourceId = `d1-${randomUUID()}`;
  sourceIds.push(sourceId);
  const file = `${sourceId}.png`;
  const entry = {
    sourceId,
    owner,
    status: "approved",
    file,
    contentType: "image/png",
    sha256: sha(bytes),
    credit: "Imported Credit",
    rightsBasis: "own",
    submittedAt: "2026-10-01T12:00:00Z",
    ...over,
  };
  return { entry, files: { [file]: bytes } as Record<string, Uint8Array>, bytes };
}

const ctx = (blobs: BlobStore) => ({ database, blobs, config, operator: "tester" });
async function run(entries: unknown[], files: Record<string, Uint8Array>, mode: "dry-run" | "apply", blobs: BlobStore = new MemoryBlobStore()): Promise<ImportReport> {
  const dir = await bundle(entries, files);
  const loaded = await loadBundle(dir);
  if (!loaded.ok) throw new Error(loaded.error);
  return runMediaImport(dir, loaded.manifest as ImportManifest, mode, ctx(blobs));
}
const only = (report: ImportReport): EntryReport => {
  expect(report.entries).toHaveLength(1);
  return report.entries[0]!;
};

const count = async (table: string, where = "", params: unknown[] = []) =>
  (await sql.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} ${where}`, params)).rows[0]!.n;
const itemsOf = (owner: string) => count("media_items", "WHERE owner = $1", [owner]);
const importsOf = (owner: string) => count("media_imports", "WHERE owner = $1", [owner]);
const auditOf = (owner: string) => count("admin_audit", "WHERE action = 'media_import' AND detail->>'owner' = $1", [owner]);

beforeAll(async () => {
  // The CLI tests run the compiled code, so build the current source first (as roles-grant.e2e.test.ts does).
  const build = spawnSync(process.execPath, ["node_modules/@nestjs/cli/bin/nest.js", "build"], { encoding: "utf8" });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  database = new DatabaseService(sql);
  config = loadConfig(process.env);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
});

afterAll(async () => {
  const owned = "(SELECT id FROM media_items WHERE owner = ANY($1))";
  await sql.query("DELETE FROM admin_audit WHERE action = 'media_import' AND detail->>'owner' = ANY($1)", [principals]);
  await sql.query(`DELETE FROM admin_audit WHERE target IN (SELECT 'med-' || id FROM media_items WHERE owner = ANY($1))`, [principals]);
  await sql.query("DELETE FROM media_imports WHERE owner = ANY($1) OR source_id = ANY($2)", [principals, sourceIds]);
  await sql.query(`DELETE FROM media_versions WHERE media_id IN ${owned}`, [principals]);
  await sql.query("DELETE FROM media_items WHERE owner = ANY($1)", [principals]);
  await sql.query("DELETE FROM admin_audit WHERE actor = ANY($1) OR target = ANY($1)", [principals]);
  await sql.query("DELETE FROM account_roles WHERE principal = ANY($1)", [principals]);
  await sql.end();
  await app.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("dry run", () => {
  it("reports would import and writes no row, audit entry or blob", async () => {
    const owner = await account("photographer");
    const m = made(owner.principal);
    const blobs = new MemoryBlobStore();
    const report = await run([m.entry], m.files, "dry-run", blobs);
    expect(only(report)).toMatchObject({ sourceId: m.entry.sourceId, status: "would_import" });
    expect(report.mode).toBe("dry-run");
    expect(report.counts.would_import).toBe(1);
    expect(exitCodeOf(report)).toBe(0);
    expect(await itemsOf(owner.principal)).toBe(0);
    expect(await importsOf(owner.principal)).toBe(0);
    expect(await auditOf(owner.principal)).toBe(0);
    expect(blobs.size).toBe(0);
  });
});

describe("apply", () => {
  it("imports one entry: item, version 1 with the d1_private_review statement and no licence, the claim, one audit row, the blob", async () => {
    const owner = await account("photographer");
    const m = made(owner.principal, {
      status: "pending",
      rightsBasis: "authorized",
      submittedAt: "2026-09-30T08:15:30.250Z",
      description: "  Morning departure.\r\nLine two.  ",
      aircraft: "Boeing 737-800",
      airline: "Example Air",
      registration: "N12345",
      location: "Gate 4",
      airportCode: "KSEA",
      capturedOn: "2026-09-29",
    });
    const blobs = new MemoryBlobStore();
    const report = await run([m.entry], m.files, "apply", blobs);
    const result = only(report);
    expect(result).toMatchObject({ sourceId: m.entry.sourceId, status: "imported" });
    expect(exitCodeOf(report)).toBe(0);

    const item = (await sql.query("SELECT * FROM media_items WHERE owner = $1", [owner.principal])).rows;
    expect(item).toHaveLength(1);
    expect(item[0]).toMatchObject({ state: "unverified", draft_version: 1, published_version: null, revision: 1, created_by: "operator:tester", updated_by: "operator:tester" });
    const mediaId = item[0].id as number;
    expect(result.mediaId).toBe(`med-${mediaId}`);

    const v = (await sql.query("SELECT * FROM media_versions WHERE media_id = $1", [mediaId])).rows;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      version: 1,
      sha256: m.entry.sha256,
      content_type: "image/png",
      byte_size: m.bytes.length,
      width: 64,
      height: 48,
      credit_name: "Imported Credit",
      credit_required: true,
      licence_name: null,
      licence_url: null,
      rights_statement: "d1_private_review",
      rights_stated_by: owner.principal,
      published_at: null,
      created_by: "operator:tester",
    });
    expect((v[0].rights_stated_at as Date).toISOString()).toBe("2026-09-30T08:15:30.250Z");
    expect(v[0].description).toBe(
      "Morning departure.\nLine two.\n\nAircraft: Boeing 737-800\nAirline: Example Air\nRegistration: N12345\nLocation: Gate 4\nAirport: KSEA\nCaptured on: 2026-09-29",
    );

    const claim = (await sql.query("SELECT * FROM media_imports WHERE source_id = $1", [m.entry.sourceId])).rows;
    expect(claim).toHaveLength(1);
    expect(claim[0]).toMatchObject({ source_system: "d1", media_id: mediaId, owner: owner.principal, sha256: m.entry.sha256 });

    const audit = (await sql.query("SELECT actor, action, target, detail FROM admin_audit WHERE action = 'media_import' AND detail->>'owner' = $1", [owner.principal])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: "operator:tester",
      action: "media_import",
      target: `med-${mediaId}`,
      detail: { sourceId: m.entry.sourceId, owner: owner.principal, status: "pending", rightsBasis: "authorized", submittedAt: "2026-09-30T08:15:30.250Z", mediaId: `med-${mediaId}`,
        note: "Imported D1 proposal: submitted for private editorial review only; no publishing licence granted (rightsBasis: authorized).",
      },
    });
    expect(JSON.stringify(audit[0])).not.toContain("@");

    const stored = await blobs.get(`content/photos/${m.entry.sha256}.png`);
    expect(stored).not.toBeNull();
    expect(Buffer.from(stored!).equals(m.bytes)).toBe(true);
    expect(blobs.contentTypeOf(`content/photos/${m.entry.sha256}.png`)).toBe("image/png");
  });

  it("stores no description when there is nothing to put in it, and no credit when none is given, empty or only spaces", async () => {
    for (const credit of [undefined, "", "   "]) {
      const owner = await account("photographer");
      const m = made(owner.principal, { credit, description: "   ", aircraft: "  " });
      expect(only(await run([m.entry], m.files, "apply")).status, JSON.stringify(credit)).toBe("imported");
      const v = (await sql.query("SELECT credit_name, description FROM media_versions WHERE media_id = (SELECT id FROM media_items WHERE owner = $1)", [owner.principal])).rows[0];
      expect(v, JSON.stringify(credit)).toEqual({ credit_name: null, description: null });
    }
  });

  it("a role revoked or blocked while the blob is being written is caught inside the transaction: refused, zero rows", async () => {
    for (const state of ["revoked", "blocked"] as const) {
      const owner = await account("photographer");
      const m = made(owner.principal);
      const inner = new MemoryBlobStore();
      const revoking: BlobStore = {
        put: async (key, bytes, type) => {
          await inner.put(key, bytes, type);
          await seedRole(sql, owner.principal, "photographer", state);
        },
        get: (key) => inner.get(key),
        delete: (key) => inner.delete(key),
      };
      const report = await run([m.entry], m.files, "apply", revoking);
      expect(only(report), state).toMatchObject({ status: "refused", code: "no_photographer_role" });
      expect(await itemsOf(owner.principal), state).toBe(0);
      expect(await importsOf(owner.principal), state).toBe(0);
      expect(await auditOf(owner.principal), state).toBe(0);
    }
  });

  it("an active admin owner is accepted (the API's holds(): admin holds photographer)", async () => {
    const owner = await account("admin");
    const m = made(owner.principal);
    expect(only(await run([m.entry], m.files, "apply")).status).toBe("imported");
  });

  it("a re-run reports already imported and writes nothing new", async () => {
    const owner = await account("photographer");
    const m = made(owner.principal);
    const blobs = new MemoryBlobStore();
    const dir = await bundle([m.entry], m.files);
    const loaded = (await loadBundle(dir)) as { ok: true; manifest: ImportManifest };
    const first = await runMediaImport(dir, loaded.manifest, "apply", ctx(blobs));
    expect(first.counts.imported).toBe(1);
    const before = { items: await itemsOf(owner.principal), imports: await importsOf(owner.principal), audit: await auditOf(owner.principal), blobs: blobs.size };
    const again = await runMediaImport(dir, loaded.manifest, "apply", ctx(blobs));
    expect(only(again)).toMatchObject({ status: "already_imported", mediaId: first.entries[0]!.mediaId });
    expect(exitCodeOf(again)).toBe(0);
    const dry = await runMediaImport(dir, loaded.manifest, "dry-run", ctx(blobs));
    expect(only(dry).status).toBe("already_imported");
    expect({ items: await itemsOf(owner.principal), imports: await importsOf(owner.principal), audit: await auditOf(owner.principal), blobs: blobs.size }).toEqual(before);
  });

  it("two concurrent runs of one entry import it once", async () => {
    const owner = await account("photographer");
    const m = made(owner.principal);
    const dir = await bundle([m.entry], m.files);
    const loaded = (await loadBundle(dir)) as { ok: true; manifest: ImportManifest };
    // Barrier in put(): both runs have passed their "not claimed yet" check before either reaches the transaction, so the claim
    // race (ClaimLost) is forced rather than hoped for.
    const inner = new MemoryBlobStore();
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const blobs: BlobStore = {
      put: async (key, bytes, type) => {
        await inner.put(key, bytes, type);
        arrived += 1;
        if (arrived >= 2) release();
        await gate;
      },
      get: (key) => inner.get(key),
      delete: (key) => inner.delete(key),
    };
    const [a, b] = await Promise.all([runMediaImport(dir, loaded.manifest, "apply", ctx(blobs)), runMediaImport(dir, loaded.manifest, "apply", ctx(blobs))]);
    expect(arrived).toBe(2);
    const statuses = [only(a).status, only(b).status].sort();
    expect(statuses).toEqual(["already_imported", "imported"]);
    expect(await itemsOf(owner.principal)).toBe(1);
    expect(await importsOf(owner.principal)).toBe(1);
    expect(await auditOf(owner.principal)).toBe(1);
  });

  it("the same sourceId with another owner or another file is a conflict, refused, and changes nothing", async () => {
    const owner = await account("photographer");
    const other = await account("photographer");
    const m = made(owner.principal);
    expect(only(await run([m.entry], m.files, "apply")).status).toBe("imported");

    const otherOwner = only(await run([{ ...m.entry, owner: other.principal }], m.files, "apply"));
    expect(otherOwner).toMatchObject({ status: "refused", code: "conflict" });
    const newer = freshPng();
    const otherFile = only(await run([{ ...m.entry, sha256: sha(newer) }], { [m.entry.file]: newer }, "dry-run"));
    expect(otherFile).toMatchObject({ status: "refused", code: "conflict" });
    expect(await itemsOf(other.principal)).toBe(0);
    expect(await itemsOf(owner.principal)).toBe(1);
  });

  it("a mixed run is a partial success (exit 4) and refused entries do not stop the others", async () => {
    const owner = await account("photographer");
    const good = made(owner.principal);
    const bad = made(owner.principal, { status: "rejected" });
    const report = await run([bad.entry, good.entry], { ...good.files, ...bad.files }, "apply");
    expect(report.entries.map((e) => e.status)).toEqual(["refused", "imported"]);
    expect(exitCodeOf(report)).toBe(4);
    expect(await itemsOf(owner.principal)).toBe(1);
  });

  it("a storage failure is reported failed (exit 1) and writes no row", async () => {
    const owner = await account("photographer");
    const m = made(owner.principal);
    const broken: BlobStore = {
      put: async () => {
        throw new StorageUnavailableError();
      },
      get: async () => null,
      delete: async () => undefined,
    };
    const report = await run([m.entry], m.files, "apply", broken);
    expect(only(report)).toMatchObject({ status: "failed", code: "storage" });
    expect(exitCodeOf(report)).toBe(1);
    expect(await itemsOf(owner.principal)).toBe(0);
    expect(await importsOf(owner.principal)).toBe(0);
  });
});

describe("refusals (dry run and apply agree, nothing is written)", () => {
  const refused = async (entries: unknown[], files: Record<string, Uint8Array>, code: string, owner?: string) => {
    for (const mode of ["dry-run", "apply"] as const) {
      const blobs = new MemoryBlobStore();
      const result = only(await run(entries, files, mode, blobs));
      expect(result, mode).toMatchObject({ status: "refused", code });
      expect(blobs.size, mode).toBe(0);
    }
    if (owner) {
      expect(await itemsOf(owner)).toBe(0);
      expect(await importsOf(owner)).toBe(0);
      expect(await auditOf(owner)).toBe(0);
    }
  };

  it("status rejected", async () => {
    const owner = await account("photographer");
    const m = made(owner.principal, { status: "rejected" });
    await refused([m.entry], m.files, "rejected", owner.principal);
  });

  it("a file over 5 MB", async () => {
    const owner = await account("photographer");
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 7);
    const m = made(owner.principal, {}, big);
    await refused([m.entry], m.files, "too_large", owner.principal);
  });

  it("an owner of another Firebase project, or not a principal at all", async () => {
    const uid = randomUUID();
    const m = made(`firebase:some-other-project:${uid}`);
    await refused([m.entry], m.files, "wrong_project");
    const n = made(uid);
    await refused([n.entry], n.files, "wrong_project");
    const o = made(`firebase:demo-airplane-games:bad:${uid}`);
    await refused([o.entry], o.files, "wrong_project");
    expect(await count("media_imports", "WHERE source_id = ANY($1)", [[m.entry.sourceId, n.entry.sourceId, o.entry.sourceId]])).toBe(0);
  });

  it("an owner without an active photographer role: no row, player only, revoked, blocked, pending", async () => {
    const cases: Actor[] = [
      await account(null),
      await account("photographer", "revoked"),
      await account("photographer", "blocked"),
      await account("photographer", "pending"),
      await account("admin", "revoked"),
    ];
    for (const owner of cases) {
      const m = made(owner.principal);
      await refused([m.entry], m.files, "no_photographer_role", owner.principal);
    }
    const player = await account(null);
    await seedRole(sql, player.principal, "player");
    const m = made(player.principal);
    await refused([m.entry], m.files, "no_photographer_role", player.principal);
  });

  it("file paths that are not a bare filename", async () => {
    const owner = await account("photographer");
    for (const file of ["../x.png", "..", ".", "/abs/x.png", "sub/x.png", "sub\\x.png", "C:x.png", "C:\\x.png", "x.png:stream", "a\u0000b.png", " x.png"]) {
      const m = made(owner.principal, { file });
      await refused([m.entry], m.files, "bad_path", owner.principal);
    }
  });

  it("a symbolic link, a directory and a missing file", async () => {
    const owner = await account("photographer");
    const m = made(owner.principal);
    const dir = await bundle([m.entry], {});
    await mkdir(path.join(dir, "adir.png"));
    const asDir = made(owner.principal, { file: "adir.png" });
    const missing = made(owner.principal);
    let linked = false;
    try {
      await writeFile(path.join(dir, "target.png"), m.bytes);
      await symlink(path.join(dir, "target.png"), path.join(dir, m.entry.file));
      linked = true;
    } catch {
      // Creating a symbolic link may need a privilege on Windows: the link case is skipped there.
    }
    const loaded = parseManifest(JSON.stringify({ version: 1, source: "d1", entries: [m.entry, asDir.entry, missing.entry] }));
    if (!loaded.ok) throw new Error(loaded.error);
    const report = await runMediaImport(dir, loaded.manifest, "apply", ctx(new MemoryBlobStore()));
    expect(report.entries[0]).toMatchObject(linked ? { status: "refused", code: "bad_path" } : { status: "refused", code: "file_missing" });
    expect(report.entries[1]).toMatchObject({ status: "refused", code: "bad_path" });
    expect(report.entries[2]).toMatchObject({ status: "refused", code: "file_missing" });
    expect(await itemsOf(owner.principal)).toBe(0);
  });

  it("a digest, content type or image that does not match", async () => {
    const owner = await account("photographer");
    const wrongSha = made(owner.principal, { sha256: "0".repeat(64) });
    await refused([wrongSha.entry], wrongSha.files, "sha_mismatch", owner.principal);
    const upper = made(owner.principal);
    await refused([{ ...upper.entry, sha256: upper.entry.sha256.toUpperCase() }], upper.files, "sha_mismatch", owner.principal);
    const jpegClaim = made(owner.principal, { contentType: "image/jpeg" });
    await refused([jpegClaim.entry], jpegClaim.files, "content_type_mismatch", owner.principal);
    const gif = made(owner.principal, { contentType: "image/gif" });
    await refused([gif.entry], gif.files, "content_type_mismatch", owner.principal);
    const text = Buffer.from("not an image at all");
    const notImage = made(owner.principal, {}, text);
    await refused([notImage.entry], notImage.files, "not_an_image", owner.principal);
  });

  it("a submittedAt that is future, unparseable, not UTC or not a real date", async () => {
    const owner = await account("photographer");
    for (const submittedAt of ["2099-01-01T00:00:00Z", "yesterday", "2026-10-01", "2026-10-01T12:00:00+01:00", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-01T12:00:00"]) {
      const m = made(owner.principal, { submittedAt });
      await refused([m.entry], m.files, "bad_submitted_at", owner.principal);
    }
  });

  it("a description over 2000 characters, with a tab, or a labelled field with a newline: refused, never truncated or stripped", async () => {
    const owner = await account("photographer");
    for (const over of [{ description: "x".repeat(2001) }, { description: "a\tb" }, { description: "ok", aircraft: "A\nB" }, { location: "x".repeat(2000) }, { description: "a\u0007b" }, { description: "\tedge" }, { description: "edge\r" }]) {
      const m = made(owner.principal, over);
      await refused([m.entry], m.files, "bad_description", owner.principal);
    }
    const exact = made(owner.principal, { description: "y".repeat(2000) });
    expect(only(await run([exact.entry], exact.files, "dry-run")).status).toBe("would_import");
  });

  it("a credit that is empty, over 200 characters, padded or multi-line", async () => {
    const owner = await account("photographer");
    for (const credit of ["c".repeat(201), " padded", "two\nlines"]) {
      const m = made(owner.principal, { credit });
      await refused([m.entry], m.files, "bad_credit", owner.principal);
    }
  });
});

describe("manifest", () => {
  const base = { version: 1, source: "d1" };
  const owner = "firebase:demo-airplane-games:u1";
  const e = { sourceId: "s1", owner, status: "approved", file: "a.png", contentType: "image/png", sha256: "a".repeat(64), rightsBasis: "own", submittedAt: "2026-10-01T12:00:00Z" };
  const parse = (value: unknown) => parseManifest(JSON.stringify(value));

  it("accepts the documented shape", () => {
    expect(parse({ ...base, entries: [e] }).ok).toBe(true);
    expect(parse({ ...base, entries: [] }).ok).toBe(true);
  });

  it("refuses unknown keys everywhere, so an email can never be carried in", () => {
    expect(parse({ ...base, entries: [{ ...e, email: "a@b.test" }] }).ok).toBe(false);
    expect(parse({ ...base, entries: [], extra: 1 }).ok).toBe(false);
    expect(parse({ ...base, entries: [{ ...e, displayName: "x" }] }).ok).toBe(false);
  });

  it("refuses a wrong version, source, basis spelling, status, missing field, duplicate sourceId and bad JSON", () => {
    expect(parse({ ...base, version: 2, entries: [] }).ok).toBe(false);
    expect(parse({ ...base, source: "d2", entries: [] }).ok).toBe(false);
    expect(parse({ ...base, entries: [{ ...e, rightsBasis: "authorised" }] }).ok).toBe(false);
    expect(parse({ ...base, entries: [{ ...e, rightsBasis: "owner" }] }).ok).toBe(false);
    expect(parse({ ...base, entries: [{ ...e, status: "published" }] }).ok).toBe(false);
    expect(parse({ ...base, entries: [{ ...e, sha256: undefined }] }).ok).toBe(false);
    expect(parse({ ...base, entries: [{ ...e, creditRequired: false }] }).ok).toBe(false);
    expect(parse({ ...base, entries: [e, e] }).ok).toBe(false);
    expect(parseManifest("{not json").ok).toBe(false);
  });

  it("loadBundle refuses a directory without a manifest", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "media-import-"));
    dirs.push(dir);
    expect((await loadBundle(dir)).ok).toBe(false);
  });

  it("helpers: bare filename, submittedAt, composed description", () => {
    expect(isBareFilename("photo-1.JPG")).toBe(true);
    expect(isBareFilename("a/b.png")).toBe(false);
    const now = new Date("2026-11-04T12:00:00Z");
    expect(parseSubmittedAt("2026-11-04T12:00:00Z", now).ok).toBe(true);
    expect(parseSubmittedAt("2026-11-04T12:00:01Z", now).ok).toBe(false);
    const entry = e as unknown as ImportEntry;
    expect(composeImportDescription(entry)).toEqual({ ok: true, value: null });
    expect(composeImportDescription({ ...entry, aircraft: "A320" })).toEqual({ ok: true, value: "Aircraft: A320" });
    expect(composeImportDescription({ ...entry, description: "Hello", airline: "X" })).toEqual({ ok: true, value: "Hello\n\nAirline: X" });
  });

  it("exit codes and the apply guard", () => {
    const report = (counts: Partial<ImportReport["counts"]>): ImportReport => ({ mode: "apply", entries: [], counts: { imported: 0, would_import: 0, already_imported: 0, refused: 0, failed: 0, ...counts } });
    expect(exitCodeOf(report({ imported: 2, already_imported: 1 }))).toBe(0);
    expect(exitCodeOf(report({ refused: 1 }))).toBe(3);
    expect(exitCodeOf(report({ refused: 1, imported: 1 }))).toBe(4);
    expect(exitCodeOf(report({ failed: 1 }))).toBe(1);
    expect(exitCodeOf(report({ failed: 1, refused: 1 }))).toBe(1);
    expect(applyRefusal({ blobStore: "bunny" })).toBeNull();
    expect(applyRefusal({ blobStore: "memory" })).toContain("BLOB_STORE=bunny");
    expect(applyRefusal({ blobStore: "none" })).toContain("BLOB_STORE=bunny");
  });
});

describe("an imported item through the HTTP routes", () => {
  it("is not publishable until the owner states rights v1 and a licence is set; then an admin publishes", async () => {
    const owner = await account("photographer");
    const admin = await account("admin");
    const m = made(owner.principal, { description: "From D1." });
    expect(only(await run([m.entry], m.files, "apply")).status).toBe("imported");
    const id = `med-${(await sql.query("SELECT id FROM media_items WHERE owner = $1", [owner.principal])).rows[0].id}`;
    const as = (who: Actor) => ({ Authorization: bearer(who.uid).Authorization });
    const publish = (revision: number) => request(server).post(`/v1/admin/media/${id}/publish`).set(as(admin)).send({ revision });

    const seen = await request(server).get(`/v1/admin/media/${id}`).set(as(owner));
    expect(seen.status).toBe(200);
    expect(seen.body.item.draft).toMatchObject({ description: "From D1.", rights: { statement: "d1_private_review" }, licence: { credit: "Imported Credit", licenceName: null } });
    expect(seen.body.item.draft.rights.statedBy).toBeUndefined();
    const noLicence = await publish(1);
    expect(noLicence.status).toBe(422);
    expect(noLicence.body.error.code).toBe("content_invalid");

    const licensed = await request(server)
      .patch(`/v1/admin/media/${id}`)
      .set(as(owner))
      .send({ revision: 1, licence: { licenceName: "CC BY 4.0", licenceUrl: "https://creativecommons.org/licenses/by/4.0/" } });
    expect(licensed.status).toBe(200);
    const noRights = await publish(licensed.body.revision);
    expect(noRights.status).toBe(422);
    expect(noRights.body.error.message).toContain("rights statement");

    const stated = await request(server).put(`/v1/admin/media/${id}/rights`).set(as(owner)).send({ revision: licensed.body.revision, statement: "v1_own" });
    expect(stated.status).toBe(200);
    expect(stated.body.draft.rights.statement).toBe("v1_own");
    const done = await publish(stated.body.revision);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: "published", publishedVersion: 1 });
  });
});

describe("npm run media:import (scripts/media-import.mjs)", () => {
  function cli(args: string[], env: Record<string, string> = {}) {
    // Run from the system temp directory: the script reads ".env" from its cwd, and the real one must not be loaded here.
    const result = spawnSync(process.execPath, [path.resolve("scripts/media-import.mjs"), ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      cwd: tmpdir(),
      timeout: 30_000,
    });
    return { status: result.status, out: result.stdout, err: result.stderr };
  }

  it("--yes with the memory store exits 2 before the database is contacted and writes nothing", async () => {
    const owner = await account("photographer");
    const m = made(owner.principal);
    const dir = await bundle([m.entry], m.files);
    const r = cli(["--bundle", dir, "--yes"], { BLOB_STORE: "memory" });
    expect(r.status, r.err).toBe(2);
    expect(r.err).toContain("BLOB_STORE=bunny");
    expect(r.out).not.toContain("Target database");
    expect(await itemsOf(owner.principal)).toBe(0);
    expect(await importsOf(owner.principal)).toBe(0);
  });

  it("--yes with BLOB_STORE=none (the production default) also exits 2", async () => {
    const owner = await account("photographer");
    const m = made(owner.principal);
    const dir = await bundle([m.entry], m.files);
    const r = cli([`--bundle=${dir}`, "--yes"], { BLOB_STORE: "none" });
    expect(r.status, r.err).toBe(2);
    expect(await itemsOf(owner.principal)).toBe(0);
  });

  it("a dry run on the memory store prints the report, exits 0 and writes nothing", async () => {
    const owner = await account("photographer");
    const m = made(owner.principal);
    const dir = await bundle([m.entry], m.files);
    const r = cli(["--bundle", dir], { BLOB_STORE: "memory" });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain(`${m.entry.sourceId}: would import`);
    expect(r.out).not.toContain("airplane_local_only");
    expect(await itemsOf(owner.principal)).toBe(0);
    expect(await importsOf(owner.principal)).toBe(0);
    expect(await auditOf(owner.principal)).toBe(0);
  });

  it("a dry run with a refused entry exits 3", async () => {
    const owner = await account("photographer");
    const m = made(owner.principal, { status: "rejected" });
    const dir = await bundle([m.entry], m.files);
    const r = cli(["--bundle", dir]);
    expect(r.status, r.err).toBe(3);
    expect(r.out).toContain("REFUSED");
  });

  it("bad arguments or a bad manifest exit 2", async () => {
    expect(cli([]).status).toBe(2);
    expect(cli(["--bundle"]).status).toBe(2);
    expect(cli(["--bundle", "x", "--nope"]).status).toBe(2);
    const empty = await mkdtemp(path.join(tmpdir(), "media-import-"));
    dirs.push(empty);
    expect(cli(["--bundle", empty]).status).toBe(2);
    const dir = await bundle([{ nonsense: true }], {});
    const r = cli(["--bundle", dir]);
    expect(r.status).toBe(2);
    expect(r.err).toContain("schema");
  });
});
