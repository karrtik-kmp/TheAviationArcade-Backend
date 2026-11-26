import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.module.js";
import type { AppConfig } from "../src/config/config.module.js";
import { RoleStore } from "../src/accounts/role-store.js";
import { ContentItemEditService } from "../src/content/content-item-edit.service.js";
import { contentMappingFor } from "../src/content/content-modules.js";
import { acquireRunLock, exitCodeOf, loadSeedInputs, runDemoSeed, unseenPrincipals } from "../src/content/demo-seed.js";
import type { SeedInputs, SeedReport } from "../src/content/demo-seed.js";
import { ContentService } from "../src/content/content.service.js";
import { ContentDocumentsService } from "../src/content/documents/content-documents.service.js";
import { EditorialService } from "../src/content/editorial/editorial.service.js";
import { MediaService } from "../src/content/media/media.service.js";
import { DatabaseService } from "../src/database/database.module.js";
import { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { xlsx, clientSheet } from "./fixtures.js";
import type { TestCell } from "./fixtures.js";
import { seedRole } from "./roles-helpers.js";

// Scenario E4 (docs/plans/demo-seed.md): the dev demo seed core run in-process against the test database with a memory blob store and
// a configuration for a REAL (non-demo) Firebase project, on synthetic folders and, when present, the client's real files; plus the
// built CLI in a child process for the refusals. The seed never touches Bunny here: the blob store is injected.

const PROJECT = "airplane-games-9fe1e";
const MIL = "aircraft-identifier-military";
const AI = "identifier";
const REAL_DOCS = "H:/Work/TheAviationArcade/docs";
const REAL_DELIVERY = "C:/Unity/Projects/AviationArcade_v2/docs/client-content/2026-09-28";
const haveReal = existsSync(`${REAL_DOCS}/Military Airplane Identifier v1.xlsx`) && existsSync(`${REAL_DELIVERY}/Airplane Identifier v1.xlsx`);

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
let pngCounter = 0;
/** A tiny valid PNG (64x48) made distinct by a text chunk, so every file has its own digest. */
function png(): Buffer {
  const extra = 3000 + ++pngCounter;
  const ancillary = [...be32(extra), 0x74, 0x45, 0x58, 0x74, ...Array<number>(extra).fill(65), 0, 0, 0, 0];
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(64), ...be32(48), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...ancillary,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

let sql: pg.Pool;
let database: DatabaseService;
let config: AppConfig;
let blobs: MemoryBlobStore;
const dirs: string[] = [];
const principals: string[] = [];
const principalOf = (uid: string) => `firebase:${PROJECT}:${uid}`;
const newPrincipal = (label: string) => {
  const principal = principalOf(`seed-${label}-${randomUUID()}`);
  principals.push(principal);
  return principal;
};
const OWNER = newPrincipal("owner");
const OWNER2 = newPrincipal("owner2");
const P_NEW = newPrincipal("new");
const P_PENDING = newPrincipal("pending");
const P_ACTIVE = newPrincipal("active");
const P_REVOKED = newPrincipal("revoked");
const ADMIN = newPrincipal("admin");
const PHOTOGRAPHERS = [P_NEW, P_PENDING, P_ACTIVE];

const TABLES = ["content_items", "content_imports", "media_items", "media_versions", "media_imports", "editorial_items", "account_roles", "admin_audit"] as const;
const count = async (table: string, where = "", params: unknown[] = []) => (await sql.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} ${where}`, params)).rows[0]!.n;
async function counts(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of TABLES) result[table] = await count(table);
  return result;
}

const ctx = (store = blobs) => ({ database, blobs: store, config, operator: "tester", pool: sql });
const seed = (inputs: SeedInputs, mode: "dry-run" | "apply", owner = OWNER, photographers: readonly string[] = PHOTOGRAPHERS, store = blobs) =>
  runDemoSeed(inputs, owner, photographers, mode, ctx(store));
const lines = (report: SeedReport, section: string, status?: string) => report.lines.filter((l) => l.section === section && (status === undefined || l.status === status));
const line = (report: SeedReport, subject: string) => {
  const found = report.lines.find((l) => l.subject === subject);
  if (!found) throw new Error(`no report line for ${subject}: ${report.lines.map((l) => l.subject).join(", ")}`);
  return found;
};
const hasNote = (report: SeedReport, subject: string, text: string) => report.lines.some((l) => l.subject === subject && l.status === "note" && (l.detail ?? "").includes(text));

// ---- synthetic folders ----

const POTD_HEADER = ["Image #", "H/V", "resolution", "Photographer", "Instagram", "Title", "Manufacturer", "Model", "Description"];
const AI_HEADER = ["Level", "Correct Answer", "Wrong Answer 1", "Wrong Answer 2", "Wrong Answer 3", "file", "folder"];

async function put(dir: string, files: Record<string, Buffer>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(dir, name), bytes);
}

/**
 * Military: five rows (a name with no extension, a different letter case, a file nobody photographed, a row with no photographer) and
 * five photo files (one used by no question). Identifier: ai-a1 and ai-a1-2 share a photo, ai-a2, and a left-out row whose photo is
 * still a file. Plane of the Day: two entries.
 */
async function syntheticFolders(): Promise<{ docs: string; delivery: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "demo-seed-"));
  dirs.push(root);
  const docs = path.join(root, "docs");
  const delivery = path.join(root, "delivery");
  await put(docs, {
    "Military Airplane Identifier v1.xlsx": await clientSheet(5, (rows) => {
      (rows[4] as TestCell[])[5] = "MA_test_2"; // no extension
      (rows[5] as TestCell[])[5] = "ma_TEST_3.JPG"; // another letter case
      (rows[6] as TestCell[])[5] = "MA_missing.jpg"; // no such photo
      (rows[7] as TestCell[])[6] = null; // no photographer
    }),
  });
  await put(path.join(docs, "Military Airplane Identifier - Pictures -2026-001", "Military Airplane Identifier - Pictures_"), {
    "MA_test_1.jpg": png(),
    "MA_test_2.jpg": png(),
    "MA_test_3.jpg": png(),
    "MA_test_5.jpg": png(),
    "MA_extra.png": png(),
  });
  await put(delivery, {
    "Airplane Identifier v1.xlsx": await xlsx([
      [null],
      [null],
      AI_HEADER,
      ["Trainee", "Boeing 737", "Airbus A320", "Airbus A321", "Boeing 757", "ai-a1.jpg", null],
      ["Captain", "Boeing 787", "Boeing 767", "Airbus A330", "Boeing 777", "ai-a1.jpg", null],
      ["Trainee", "Airbus A350", "Airbus A340", "Boeing 747", "Airbus A380", "ai-a2.jpg", null],
      ["Trainee", "Boeing 747", "Boeing 747", "Airbus A380", "Boeing 767", "ai-a3.jpg", null], // correct answer repeated: left out
    ]),
    "Airplane Games - Game Play.xlsx": await xlsx([
      [null],
      [null],
      [null],
      POTD_HEADER,
      ["pod-1", "Horizonal", "2000x2500", "Josh M", "https://www.instagram.com/iamjoshmark/", "Beneath the Heartbeat", "Boeing", 737, "Framed from directly beneath the glide path, a Boeing 737."],
      ["pod-2", "Horizonal", "2000x2500", "Josh M", "https://www.instagram.com/iamjoshmark/", "Golden Superjumbo", "Airbus", "A380", "A Qantas Airbus A380 lines up on short final."],
    ]),
  });
  await put(path.join(delivery, "Airplane Identifier-2026-001", "Airplane Identifier"), { "ai-a1.jpg": png(), "ai-a2.jpg": png(), "ai-a3.jpg": png() });
  await put(path.join(delivery, "Plane of the Day-2026-001", "Plane of the Day"), { "pod-1.jpg": png(), "pod-2.jpg": png() });
  return { docs, delivery };
}

async function loaded(folders: { docs: string; delivery: string }): Promise<SeedInputs> {
  const result = await loadSeedInputs(folders.docs, folders.delivery);
  if (!result.ok) throw new Error(result.error);
  return result.inputs;
}

async function mediaIdOfFile(source: string): Promise<number> {
  return (await sql.query<{ media_id: number }>("SELECT media_id FROM media_imports WHERE source_system = 'demo-seed' AND source_id = $1", [source])).rows[0]!.media_id;
}

/** What staff do in the Admin: set a licence name on the draft, then publish it. */
async function publishPhoto(mediaId: number): Promise<void> {
  const media = new MediaService(database, blobs, config);
  const edited = await media.edit(ADMIN, mediaId, true, 1, { licence: { licenceName: "Test Licence" } }, null);
  await media.publish(ADMIN, mediaId, edited.revision);
}

async function clean(): Promise<void> {
  await sql.query("DELETE FROM editorial_items");
  await sql.query("DELETE FROM content_items");
  await sql.query("DELETE FROM content_imports");
  await sql.query("DELETE FROM media_imports WHERE source_system = 'demo-seed' OR owner = ANY($1)", [principals]);
  await frozenDelete(sql, "media_versions", "media_id IN (SELECT id FROM media_items WHERE owner = ANY($1))", [principals]);
  await sql.query("DELETE FROM media_items WHERE owner = ANY($1)", [principals]);
  await frozenDelete(sql, "admin_audit");
  await sql.query("DELETE FROM account_roles WHERE principal = ANY($1)", [principals]);
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  database = new DatabaseService(sql);
  config = loadConfig({ ...process.env, FIREBASE_PROJECT_ID: PROJECT, ALLOW_EMULATOR_TOKENS: "false", FIREBASE_AUTH_EMULATOR_HOST: undefined, APP_ENV: "test", DEMO_ACCOUNT_UID: "seed-demo-account", BLOB_STORE: "memory" });
  expect(config.firebaseProjectId).toBe(PROJECT);
  expect(config.demoPrincipal).toBe(principalOf("seed-demo-account"));
});

afterAll(async () => {
  await clean();
  await sql.end();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await clean();
  blobs = new MemoryBlobStore();
  await seedRole(sql, OWNER, "photographer");
  await seedRole(sql, OWNER2, "photographer");
  await seedRole(sql, P_PENDING, "photographer", "pending");
  await seedRole(sql, P_ACTIVE, "photographer");
});

describe("dry run", () => {
  it("reports what it would do and writes nothing: no row, audit entry, receipt or blob", async () => {
    const inputs = await loaded(await syntheticFolders());
    const before = await counts();
    const report = await seed(inputs, "dry-run");
    expect(await counts()).toEqual(before);
    expect(blobs.size).toBe(0);
    expect(report.mode).toBe("dry-run");
    expect(exitCodeOf(report)).toBe(0);
    expect(report.counts.done).toBe(0);
    expect(line(report, P_NEW)).toMatchObject({ section: "role", status: "would" });
    expect(line(report, P_PENDING)).toMatchObject({ status: "would", detail: expect.stringContaining("pending") });
    expect(line(report, P_ACTIVE)).toMatchObject({ status: "unchanged" });
    expect(line(report, MIL)).toMatchObject({ section: "content", status: "would", detail: expect.stringContaining("5 questions") });
    expect(line(report, AI)).toMatchObject({ status: "would", detail: expect.stringContaining("3 questions") });
    expect(lines(report, "photo", "would")).toHaveLength(10);
    expect(lines(report, "link", "would").map((l) => l.subject)).toEqual([
      `${MIL} mil-a1`,
      `${MIL} mil-a2`,
      `${MIL} mil-a3`,
      `${MIL} mil-a5`,
      `${AI} ai-a1`,
      `${AI} ai-a1-2`,
      `${AI} ai-a2`,
    ]);
    expect(lines(report, "entry", "waiting")).toHaveLength(2);
  });

  it("treats an owner who will be granted by this run as holding the role, and refuses one with no role", async () => {
    const inputs = await loaded(await syntheticFolders());
    const newcomer = await seed(inputs, "dry-run", P_NEW, [P_NEW]);
    expect(lines(newcomer, "photo", "would")).toHaveLength(10);
    const nobody = await seed(inputs, "dry-run", P_NEW, []);
    expect(lines(nobody, "photo", "refused")).toHaveLength(10);
    expect(lines(nobody, "photo", "refused")[0]?.detail).toMatch(/no active photographer or admin role/);
    expect(exitCodeOf(nobody)).toBe(3);
  });
});

describe("apply on synthetic folders", () => {
  it("creates the questions, the photos with their credit and licence, the links, the role grants and the audit trail", async () => {
    const inputs = await loaded(await syntheticFolders());
    const report = await seed(inputs, "apply");
    expect(report.lines.filter((l) => l.status === "failed" || l.status === "refused")).toEqual([]);
    expect(exitCodeOf(report)).toBe(0);

    // Roles.
    expect(line(report, P_NEW)).toMatchObject({ status: "done" });
    expect(line(report, P_PENDING)).toMatchObject({ status: "done" });
    expect(line(report, P_ACTIVE)).toMatchObject({ status: "unchanged" });
    const roles = (await sql.query("SELECT principal, state, decided_by FROM account_roles WHERE principal = ANY($1) AND role = 'photographer' ORDER BY principal", [[P_NEW, P_PENDING, P_ACTIVE]])).rows;
    expect(roles.map((r) => r.state)).toEqual(["active", "active", "active"]);
    expect(await count("admin_audit", "WHERE action = 'role_grant' AND target = ANY($1)", [[P_NEW, P_PENDING]])).toBe(2);

    // Content: 5 Military, 3 Identifier (ai-a1-2 is the second question on the first photo; the left-out row takes no id).
    expect(await count("content_items", "WHERE module = $1", [MIL])).toBe(5);
    const aiIds = (await sql.query("SELECT id FROM content_items WHERE module = $1 ORDER BY id", [AI])).rows.map((r) => r.id);
    expect(aiIds).toEqual(["ai-a1", "ai-a1-2", "ai-a2"]);
    expect(await count("content_imports")).toBe(2);
    expect(hasNote(report, `${AI} row 7`, "Left out")).toBe(true);

    // Photos: ten drafts owned by the staff photographer, never published; operator-stated rights; one claim and audit row each.
    expect(await count("media_items", "WHERE owner = $1", [OWNER])).toBe(10);
    expect(await count("media_items", "WHERE owner = $1 AND state = 'unverified' AND published_version IS NULL AND created_by = 'operator:tester' AND updated_by = 'operator:tester'", [OWNER])).toBe(10);
    expect(await count("media_imports", "WHERE source_system = 'demo-seed' AND owner = $1", [OWNER])).toBe(10);
    expect(await count("admin_audit", "WHERE action = 'media_import' AND detail->>'source' = 'demo-seed' AND actor = 'operator:tester'")).toBe(10);
    expect(blobs.size).toBeGreaterThanOrEqual(10);
    const version = async (source: string) =>
      (
        await sql.query(
          `SELECT v.credit_name, v.licence_name, v.rights_statement, v.rights_stated_by, v.created_by, v.version, v.published_at
           FROM media_imports i JOIN media_versions v ON v.media_id = i.media_id WHERE i.source_id = $1`,
          [source],
        )
      ).rows;
    for (const source of ["mil/MA_test_1.jpg", "ai/ai-a1.jpg", "potd/pod-1.jpg"]) {
      expect(await version(source), source).toHaveLength(1);
    }
    expect((await version("mil/MA_test_1.jpg"))[0]).toMatchObject({
      credit_name: "Photographer 1",
      licence_name: "Unsplash License",
      rights_statement: "v1_authorised",
      rights_stated_by: "operator:tester",
      created_by: "operator:tester",
      published_at: null,
    });
    expect((await version("mil/MA_test_5.jpg"))[0]).toMatchObject({ credit_name: null, licence_name: "Unsplash License" });
    expect(hasNote(report, "mil/MA_test_5.jpg", "no credit in the client's sheet")).toBe(true);
    expect((await version("ai/ai-a1.jpg"))[0]).toMatchObject({ credit_name: "Josh M (@iamjoshmark)", licence_name: null, rights_statement: "v1_authorised" });
    expect((await version("potd/pod-1.jpg"))[0]).toMatchObject({ credit_name: "Josh M (@iamjoshmark)", licence_name: null });
    expect(hasNote(report, "mil/MA_extra.png", "no question")).toBe(true);
    expect(hasNote(report, "ai/ai-a3.jpg", "no question (row left out)")).toBe(true);
    expect(hasNote(report, `${MIL} mil-a4`, "no photo for")).toBe(true);
    expect(hasNote(report, `${MIL} mil-a2`, "no extension") || hasNote(report, `${MIL} mil-a2`, "image extension")).toBe(true);
    expect(hasNote(report, `${MIL} mil-a3`, "letter case")).toBe(true);

    // Links: every matched item, the two questions of one photo share it, the item with no photo has none.
    const links = Object.fromEntries((await sql.query("SELECT module, id, media_id FROM content_items")).rows.map((r) => [`${r.module}/${r.id}`, r.media_id as number | null]));
    expect(links[`${MIL}/mil-a4`]).toBeNull();
    expect(links[`${MIL}/mil-a1`]).toBe(await mediaIdOfFile("mil/MA_test_1.jpg"));
    expect(links[`${MIL}/mil-a2`]).toBe(await mediaIdOfFile("mil/MA_test_2.jpg"));
    expect(links[`${MIL}/mil-a3`]).toBe(await mediaIdOfFile("mil/MA_test_3.jpg"));
    expect(links[`${MIL}/mil-a5`]).toBe(await mediaIdOfFile("mil/MA_test_5.jpg"));
    expect(links[`${AI}/ai-a1`]).toBe(await mediaIdOfFile("ai/ai-a1.jpg"));
    expect(links[`${AI}/ai-a1-2`]).toBe(links[`${AI}/ai-a1`]);
    expect(await count("admin_audit", "WHERE action = 'content_media_link' AND actor = 'operator:tester'")).toBe(7);

    // Plane of the Day: nothing yet, the photos are drafts.
    expect(await count("editorial_items")).toBe(0);
    expect(lines(report, "entry", "waiting")).toHaveLength(2);
    expect(hasNote(report, "plane-of-the-day pod-1", "no factual source")).toBe(true);
  });

  it("a second apply changes nothing", async () => {
    const inputs = await loaded(await syntheticFolders());
    await seed(inputs, "apply");
    const before = await counts();
    const mediaBefore = (await sql.query("SELECT id, revision, updated_at FROM media_items ORDER BY id")).rows;
    const itemsBefore = (await sql.query("SELECT module, id, version, media_id, updated_at FROM content_items ORDER BY module, id")).rows;
    const again = await seed(inputs, "apply");
    expect(await counts()).toEqual(before);
    expect((await sql.query("SELECT id, revision, updated_at FROM media_items ORDER BY id")).rows).toEqual(mediaBefore);
    expect((await sql.query("SELECT module, id, version, media_id, updated_at FROM content_items ORDER BY module, id")).rows).toEqual(itemsBefore);
    expect(again.counts.done).toBe(0);
    expect(again.counts.refused + again.counts.failed).toBe(0);
    expect(exitCodeOf(again)).toBe(0);
    expect(line(again, MIL).status).toBe("unchanged");
    expect(line(again, AI).status).toBe("unchanged");
    expect(lines(again, "photo", "unchanged")).toHaveLength(10);
    expect(lines(again, "link", "unchanged")).toHaveLength(7);
    // A dry run after an apply says there is nothing to do.
    const dry = await seed(inputs, "dry-run");
    expect(dry.counts.would).toBe(0);
  });

  it("never refills a credit staff cleared, and never relinks an item staff unlinked", async () => {
    const inputs = await loaded(await syntheticFolders());
    await seed(inputs, "apply");
    const media = new MediaService(database, blobs, config);
    const id = await mediaIdOfFile("mil/MA_test_1.jpg");
    await media.edit(ADMIN, id, true, 1, { licence: { credit: null } }, null);
    const edits = new ContentItemEditService(database, config);
    const stored = (await sql.query("SELECT version FROM content_items WHERE module = $1 AND id = 'mil-a2'", [MIL])).rows[0];
    await edits.setMedia(MIL, "mil-a2", stored.version, null, "staff");
    const before = await counts();
    const again = await seed(inputs, "apply");
    expect(await counts()).toEqual(before);
    expect((await sql.query("SELECT credit_name FROM media_versions WHERE media_id = $1 ORDER BY version DESC LIMIT 1", [id])).rows[0].credit_name).toBeNull();
    expect((await sql.query("SELECT media_id FROM content_items WHERE module = $1 AND id = 'mil-a2'", [MIL])).rows[0].media_id).toBeNull();
    expect(hasNote(again, `${MIL} mil-a2`, "left alone")).toBe(true);
    expect(again.counts.done).toBe(0);
  });

  it("refuses a module that staff edited and lists the difference, and writes nothing to it", async () => {
    const inputs = await loaded(await syntheticFolders());
    await seed(inputs, "apply");
    const edits = new ContentItemEditService(database, config);
    const mapping = contentMappingFor(MIL)!;
    const stored = (await sql.query("SELECT version, data FROM content_items WHERE module = $1 AND id = 'mil-a1'", [MIL])).rows[0];
    await edits.edit(mapping, "mil-a1", stored.version, { data: { ...stored.data, answer: "Staff Edited Answer" } }, "staff");
    const before = await counts();
    const report = await seed(inputs, "apply");
    expect(await counts()).toEqual(before);
    expect(line(report, MIL)).toMatchObject({ section: "content", status: "refused", detail: expect.stringContaining("mil-a1") });
    expect(line(report, MIL).detail).toContain("never overwrites");
    expect(line(report, AI).status).toBe("unchanged");
    expect(report.lines.some((l) => l.section === "link" && l.subject === MIL && l.status === "note")).toBe(true);
    expect((await sql.query("SELECT data->>'answer' AS answer FROM content_items WHERE module = $1 AND id = 'mil-a1'", [MIL])).rows[0].answer).toBe("Staff Edited Answer");
    expect(exitCodeOf(report)).toBe(3);
  });

  it("still uploads the photos of a refused module (files, not content) but links none of its items", async () => {
    const folders = await syntheticFolders();
    const inputs = await loaded(folders);
    // Staff import something different first, so the seed's sheet would update stored content.
    const edited = await clientSheet(5, (rows) => {
      (rows[3] as TestCell[])[1] = "Different Answer";
    });
    await new ContentService(database, blobs, new ContentDocumentsService(database)).apply(contentMappingFor(MIL)!, edited, "staff.xlsx", "staff");
    const report = await seed(inputs, "apply");
    expect(line(report, MIL).status).toBe("refused");
    expect(lines(report, "photo", "done").filter((l) => l.subject.startsWith("mil/"))).toHaveLength(5);
    expect((await sql.query("SELECT COUNT(*)::int AS n FROM content_items WHERE module = $1 AND media_id IS NOT NULL", [MIL])).rows[0].n).toBe(0);
    expect(line(report, AI).status).toBe("done");
  });

  it("refuses a changed owner on a second run instead of duplicating the photos", async () => {
    const inputs = await loaded(await syntheticFolders());
    await seed(inputs, "apply");
    const before = await counts();
    const report = await seed(inputs, "apply", OWNER2, []);
    expect(await counts()).toEqual(before);
    expect(lines(report, "photo", "refused")).toHaveLength(10);
    expect(lines(report, "photo", "refused")[0]?.detail).toMatch(/different owner or file/);
    expect(exitCodeOf(report)).toBe(3);
  });

  it("refuses a changed photo file instead of uploading a second copy", async () => {
    const folders = await syntheticFolders();
    const inputs = await loaded(folders);
    await seed(inputs, "apply");
    const aiDir = path.join(folders.delivery, "Airplane Identifier-2026-001", "Airplane Identifier");
    await writeFile(path.join(aiDir, "ai-a2.jpg"), png());
    const before = await counts();
    const report = await seed(inputs, "apply");
    expect(await counts()).toEqual(before);
    expect(line(report, "ai/ai-a2.jpg")).toMatchObject({ status: "refused" });
  });

  it("never overturns a staff decision on a photographer role", async () => {
    await seedRole(sql, P_REVOKED, "photographer", "revoked");
    const inputs = await loaded(await syntheticFolders());
    const report = await seed(inputs, "apply", OWNER, [...PHOTOGRAPHERS, P_REVOKED]);
    expect(line(report, P_REVOKED)).toMatchObject({ section: "role", status: "refused", detail: expect.stringContaining("an admin decided this") });
    expect(line(report, P_REVOKED).detail).toContain("activate the role itself");
    expect((await sql.query("SELECT state FROM account_roles WHERE principal = $1 AND role = 'photographer'", [P_REVOKED])).rows[0].state).toBe("revoked");
    expect(await count("admin_audit", "WHERE action = 'role_grant' AND target = $1", [P_REVOKED])).toBe(0);
    expect(exitCodeOf(report)).toBe(4); // the rest was done
  });

  it("refuses the photos of an owner who holds no photographer role, and stores no blob", async () => {
    const nobody = newPrincipal("norole");
    const inputs = await loaded(await syntheticFolders());
    const report = await seed(inputs, "apply", nobody, []);
    expect(lines(report, "photo", "refused")).toHaveLength(10);
    expect(await count("media_items", "WHERE owner = $1", [nobody])).toBe(0);
    expect(blobs.size).toBe(2); // the two question sheets only; no photo went to the store
    // The questions are still stored; nothing is linked.
    expect(await count("content_items")).toBe(8);
    expect(await count("content_items", "WHERE media_id IS NOT NULL")).toBe(0);
  });

  it("refuses the demo account as owner at write time", async () => {
    const demo = config.demoPrincipal!;
    principals.push(demo);
    await seedRole(sql, demo, "photographer"); // a stale row from before the incident must not matter
    const inputs = await loaded(await syntheticFolders());
    const report = await seed(inputs, "apply", demo, []);
    expect(lines(report, "photo", "refused")).toHaveLength(10);
    expect(lines(report, "photo", "refused")[0]?.detail).toMatch(/demo account/);
    expect(await count("media_items", "WHERE owner = $1", [demo])).toBe(0);
  });

  it("refuses a second concurrent run: the run lock is held for the whole --yes run", async () => {
    const inputs = await loaded(await syntheticFolders());
    const held = await acquireRunLock(sql);
    expect(held).toBeDefined();
    try {
      const before = await counts();
      const report = await seed(inputs, "apply");
      expect(await counts()).toEqual(before);
      expect(report.lines).toHaveLength(1);
      expect(report.lines[0]).toMatchObject({ section: "run", status: "refused" });
      expect(exitCodeOf(report)).toBe(3);
      // A dry run takes no lock and still works.
      expect((await seed(inputs, "dry-run")).counts.refused).toBe(0);
    } finally {
      await held!.release();
    }
    const after = await seed(inputs, "apply");
    expect(after.counts.done).toBeGreaterThan(0);
    // The lock was released by that run too: a further one gets it.
    const third = await acquireRunLock(sql);
    expect(third).toBeDefined();
    await third!.release();
  });
});

describe("DEV_DEMO_WAIVER: no credit on dev for Military photos the client's sheet gives no photographer", () => {
  const creditRows = async (source: string) =>
    (
      await sql.query(
        `SELECT v.credit_name, v.credit_required, v.licence_name, v.licence_waiver, i.media_id, a.detail
         FROM media_imports i JOIN media_versions v ON v.media_id = i.media_id
         LEFT JOIN admin_audit a ON a.action = 'media_import' AND a.target = 'med-' || i.media_id
         WHERE i.source_id = $1`,
        [source],
      )
    ).rows;

  it("with the switch: that photo gets creditRequired false, no name, the audit flag and a note; every other photo is unchanged; an admin can publish it", async () => {
    const saved = config;
    config = { ...config, devDemoWaiver: "dev-demo" };
    try {
      const report = await seed(await loaded(await syntheticFolders()), "apply");
      expect(report.lines.filter((l) => l.status === "failed" || l.status === "refused")).toEqual([]);
      const waived = (await creditRows("mil/MA_test_5.jpg"))[0]!;
      expect(waived).toMatchObject({ credit_name: null, credit_required: false, licence_name: "Unsplash License", licence_waiver: null });
      expect(waived.detail).toMatchObject({ creditWaived: "dev-demo", credit: null });
      expect(hasNote(report, "mil/MA_test_5.jpg", "credit not required (dev-demo waiver)")).toBe(true);
      // Everything else: credit still required, no flag. The unused Military photo and the Identifier and Plane of the Day photos included.
      for (const source of ["mil/MA_test_1.jpg", "mil/MA_extra.png", "ai/ai-a1.jpg", "potd/pod-1.jpg"]) {
        const row = (await creditRows(source))[0]!;
        expect(row.credit_required, source).toBe(true);
        expect(row.detail, source).not.toHaveProperty("creditWaived");
      }
      expect(await count("media_versions v JOIN media_imports i ON i.media_id = v.media_id", "WHERE i.source_system = 'demo-seed' AND NOT v.credit_required")).toBe(1);

      const mediaId = waived.media_id as number;
      const revision = (await sql.query("SELECT revision FROM media_items WHERE id = $1", [mediaId])).rows[0].revision as number;
      await new MediaService(database, blobs, config).publish(ADMIN, mediaId, revision);
      expect((await sql.query("SELECT state FROM media_items WHERE id = $1", [mediaId])).rows[0].state).toBe("published");
    } finally {
      config = saved;
    }
  });

  it("without the switch the same photo stays creditRequired true, has no flag, and cannot be published", async () => {
    const report = await seed(await loaded(await syntheticFolders()), "apply");
    const row = (await creditRows("mil/MA_test_5.jpg"))[0]!;
    expect(row).toMatchObject({ credit_name: null, credit_required: true });
    expect(row.detail).not.toHaveProperty("creditWaived");
    expect(hasNote(report, "mil/MA_test_5.jpg", "no credit in the client's sheet")).toBe(true);
    expect(hasNote(report, "mil/MA_test_5.jpg", "dev-demo")).toBe(false);
    const revision = (await sql.query("SELECT revision FROM media_items WHERE id = $1", [row.media_id])).rows[0].revision as number;
    await expect(new MediaService(database, blobs, config).publish(ADMIN, row.media_id as number, revision)).rejects.toMatchObject({ status: 422 });
  });

  it("a re-run with the switch turned on after the upload reports the stored setting honestly and changes nothing", async () => {
    const folders = await syntheticFolders();
    await seed(await loaded(folders), "apply");
    const saved = config;
    config = { ...config, devDemoWaiver: "dev-demo" };
    try {
      const again = await seed(await loaded(folders), "apply");
      expect((await creditRows("mil/MA_test_5.jpg"))[0]).toMatchObject({ credit_required: true });
      expect(hasNote(again, "mil/MA_test_5.jpg", "already uploaded, so this run did not change whether a credit is required")).toBe(true);
      expect(hasNote(again, "mil/MA_test_5.jpg", "dev-demo")).toBe(false);
    } finally {
      config = saved;
    }
  });
});

describe("review fixes", () => {
  it("a failed content step uploads none of that module's photos and says so; the other module goes on", async () => {
    const inputs = await loaded(await syntheticFolders());
    const holder = await sql.connect();
    try {
      // Another transaction holds the Military module lock, so the apply is refused (409 import_in_progress) after a clean dry run.
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`content-import:${MIL}`]);
      const report = await seed(inputs, "apply");
      expect(line(report, MIL)).toMatchObject({ section: "content", status: "refused" });
      expect(report.lines.find((l) => l.section === "photo" && l.subject === MIL)).toMatchObject({ status: "failed", detail: expect.stringContaining("photos not uploaded") });
      expect(await count("media_imports", "WHERE source_system = 'demo-seed' AND source_id LIKE 'mil/%'")).toBe(0);
      expect(await count("media_imports", "WHERE source_system = 'demo-seed' AND source_id LIKE 'ai/%'")).toBe(3);
      expect(await count("content_items", "WHERE module = $1", [MIL])).toBe(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    // The re-run then loads Military with the sheet's credit, which was never lost.
    await seed(inputs, "apply");
    const credit = (await sql.query("SELECT v.credit_name FROM media_imports i JOIN media_versions v ON v.media_id = i.media_id WHERE i.source_id = 'mil/MA_test_1.jpg'")).rows[0];
    expect(credit.credit_name).toBe("Photographer 1");
  });

  it("takes the Military credit from the sheet even when staff already stored a different photographer", async () => {
    const inputs = await loaded(await syntheticFolders());
    const staffSheet = await clientSheet(5, (rows) => {
      (rows[3] as TestCell[])[6] = "Someone Else";
    });
    await new ContentService(database, blobs, new ContentDocumentsService(database)).apply(contentMappingFor(MIL)!, staffSheet, "staff.xlsx", "staff");
    await seed(inputs, "apply");
    const credit = (await sql.query("SELECT v.credit_name FROM media_imports i JOIN media_versions v ON v.media_id = i.media_id WHERE i.source_id = 'mil/MA_test_1.jpg'")).rows[0];
    expect(credit.credit_name).toBe("Photographer 1");
  });

  it("leaves an item alone that staff prepared, or that has a content_prepare audit row", async () => {
    const inputs = await loaded(await syntheticFolders());
    await seed(inputs, "apply");
    // mil-a1: a saved preparation and no photo; mil-a2: only a content_prepare audit row, photo cleared.
    await sql.query(
      "UPDATE content_items SET media_id = NULL, prep_stage = 'missing_photo', prep_evidence = '{}'::jsonb, prep_version = version WHERE module = $1 AND id = 'mil-a1'",
      [MIL],
    );
    await sql.query("UPDATE content_items SET media_id = NULL WHERE module = $1 AND id = 'mil-a2'", [MIL]);
    await sql.query("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ('staff', 'content_prepare', $1, '{\"id\": \"mil-a2\"}'::jsonb, now())", [MIL]);
    const before = await counts();
    const prepBefore = (await sql.query("SELECT version, prep_version FROM content_items WHERE module = $1 AND id = 'mil-a1'", [MIL])).rows[0];
    const report = await seed(inputs, "apply");
    expect(await counts()).toEqual(before);
    expect(hasNote(report, `${MIL} mil-a1`, "staff prepared this item")).toBe(true);
    expect(hasNote(report, `${MIL} mil-a2`, "left alone")).toBe(true);
    const rows = (await sql.query("SELECT id, media_id, version, prep_version FROM content_items WHERE module = $1 AND id IN ('mil-a1', 'mil-a2')", [MIL])).rows;
    expect(rows.every((r) => r.media_id === null)).toBe(true);
    expect(rows.find((r) => r.id === "mil-a1")).toMatchObject(prepBefore); // the preparation did not go stale
  });
});

describe("Plane of the Day", () => {
  it("waits for a published photo, then creates exactly that draft once", async () => {
    const inputs = await loaded(await syntheticFolders());
    const first = await seed(inputs, "apply");
    expect(lines(first, "entry", "waiting")).toHaveLength(2);
    expect(await count("editorial_items")).toBe(0);

    const pod1 = await mediaIdOfFile("potd/pod-1.jpg");
    await publishPhoto(pod1);
    const second = await seed(inputs, "apply");
    expect(line(second, "plane-of-the-day pod-1")).toMatchObject({ section: "entry", status: "done", mediaId: `med-${pod1}` });
    expect(line(second, "plane-of-the-day pod-2").status).toBe("waiting");
    expect(await count("editorial_items")).toBe(1);
    const row = (await sql.query("SELECT * FROM editorial_items")).rows[0];
    expect(row).toMatchObject({ kind: "plane-of-the-day", media_id: pod1, status: "draft", date_key: null, version: 1, created_by: "operator:tester", updated_by: "operator:tester" });
    expect(row.data).toEqual({
      title: "Beneath the Heartbeat",
      aircraft: "Boeing 737",
      photographer: "Josh M",
      instagram: "https://www.instagram.com/iamjoshmark/",
      credit: "@iamjoshmark",
      description: "Framed from directly beneath the glide path, a Boeing 737.",
      correctAnswer: "",
      distractors: ["", "", ""],
      difficulty: "",
      factualSource: "",
    });
    expect(await count("admin_audit", "WHERE action = 'editorial_create' AND actor = 'operator:tester'")).toBe(1);

    const before = await counts();
    const third = await seed(inputs, "apply");
    expect(await counts()).toEqual(before);
    expect(line(third, "plane-of-the-day pod-1")).toMatchObject({ status: "unchanged", detail: expect.stringContaining("already there") });
  });

  it("counts an archived or staff-made item for the photo as already there", async () => {
    const inputs = await loaded(await syntheticFolders());
    await seed(inputs, "apply");
    const pod2 = await mediaIdOfFile("potd/pod-2.jpg");
    await publishPhoto(pod2);
    const editorial = new EditorialService(database, config);
    const made = await editorial.create("plane-of-the-day", pod2, undefined, ADMIN);
    const id = Number(made.id.slice(3));
    await editorial.save("plane-of-the-day", id, { version: 1, status: "archived", data: made.data, dateKey: null }, ADMIN);
    const report = await seed(inputs, "apply");
    expect(line(report, "plane-of-the-day pod-2")).toMatchObject({ status: "unchanged", detail: expect.stringContaining("archived") });
    expect(await count("editorial_items")).toBe(1);
  });

  it("a dry run reports the draft it would create for a published photo, and creates nothing", async () => {
    const inputs = await loaded(await syntheticFolders());
    await seed(inputs, "apply");
    await publishPhoto(await mediaIdOfFile("potd/pod-1.jpg"));
    const report = await seed(inputs, "dry-run");
    expect(line(report, "plane-of-the-day pod-1").status).toBe("would");
    expect(await count("editorial_items")).toBe(0);
  });
});

describe("unseenPrincipals", () => {
  it("lists a principal with no player and no role row", async () => {
    const ghost = newPrincipal("ghost");
    expect(await unseenPrincipals(database.db, [OWNER, ghost])).toEqual([ghost]);
    expect(await unseenPrincipals(database.db, [])).toEqual([]);
  });
});

describe("RoleStore through the seed", () => {
  it("uses the operator-only grant (an admin actor is refused)", async () => {
    const store = new RoleStore(database, config);
    const result = await store.grantPhotographer({ kind: "admin", principal: ADMIN }, newPrincipal("x"), null);
    expect(result.ok).toBe(false);
  });
});

describe.skipIf(!haveReal)("the client's real files", () => {
  it("dry run writes nothing; apply loads 31 + 31 questions, 66 photos and the links; a second apply changes nothing; a published photo gets its draft", async () => {
    const result = await loadSeedInputs(REAL_DOCS, REAL_DELIVERY);
    if (!result.ok) throw new Error(result.error);
    const inputs = result.inputs;
    expect(inputs.military.files).toHaveLength(30);
    expect(inputs.identifier.files).toHaveLength(31);
    expect(inputs.potd.files).toHaveLength(5);

    const before = await counts();
    const dry = await seed(inputs, "dry-run");
    expect(await counts()).toEqual(before);
    expect(blobs.size).toBe(0);
    expect(dry.counts.refused + dry.counts.failed).toBe(0);
    expect(lines(dry, "photo", "would")).toHaveLength(66);

    const report = await seed(inputs, "apply");
    expect(report.lines.filter((l) => l.status === "refused" || l.status === "failed")).toEqual([]);
    expect(exitCodeOf(report)).toBe(0);
    expect(await count("content_items", "WHERE module = $1", [MIL])).toBe(31);
    expect(await count("content_items", "WHERE module = $1", [AI])).toBe(31);
    expect(await count("media_items", "WHERE owner = $1", [OWNER])).toBe(66);
    expect(await count("media_imports", "WHERE source_system = 'demo-seed' AND source_id LIKE 'mil/%'")).toBe(30);
    expect(await count("media_imports", "WHERE source_system = 'demo-seed' AND source_id LIKE 'ai/%'")).toBe(31);
    expect(await count("media_imports", "WHERE source_system = 'demo-seed' AND source_id LIKE 'potd/%'")).toBe(5);
    expect(await count("media_items", "WHERE owner = $1 AND state <> 'unverified'", [OWNER])).toBe(0);

    // Military: 30 linked, mil-a5 (the C-17) has no photo. Identifier: 31 linked; ai-a11 and ai-a11-2 share one photo.
    expect(await count("content_items", "WHERE module = $1 AND media_id IS NOT NULL", [MIL])).toBe(30);
    expect((await sql.query("SELECT media_id FROM content_items WHERE module = $1 AND id = 'mil-a5'", [MIL])).rows[0].media_id).toBeNull();
    expect(await count("content_items", "WHERE module = $1 AND media_id IS NOT NULL", [AI])).toBe(31);
    const shared = (await sql.query("SELECT id, media_id FROM content_items WHERE module = $1 AND id IN ('ai-a11', 'ai-a11-2')", [AI])).rows;
    expect(shared).toHaveLength(2);
    expect(shared[0].media_id).toBe(shared[1].media_id);
    expect(hasNote(report, `${MIL} mil-a5`, "no photo for")).toBe(true);
    expect(hasNote(report, "ai/ai-a8.jpg", "no question (row left out)")).toBe(true);
    expect(hasNote(report, "ai/ai-a14.jpg", "no question (row left out)")).toBe(true);
    expect(report.lines.filter((l) => l.section === "photo" && l.status === "note" && l.subject.startsWith(`${MIL} `) && !/no photo for/.test(l.detail ?? "")).length).toBe(3); // the three non-exact matches
    expect(report.lines.filter((l) => l.section === "entry" && l.status === "waiting")).toHaveLength(5);

    const credits = (await sql.query("SELECT v.credit_name, v.licence_name, i.source_id FROM media_imports i JOIN media_versions v ON v.media_id = i.media_id WHERE i.source_system = 'demo-seed'")).rows;
    expect(credits.filter((r) => r.source_id.startsWith("mil/") && r.licence_name === "Unsplash License")).toHaveLength(30);
    // The client's sheet names no photographer for four Military rows: no credit, and each is reported.
    expect(credits.filter((r) => r.source_id.startsWith("mil/") && r.credit_name === null)).toHaveLength(4);
    expect(report.lines.filter((l) => l.section === "photo" && l.status === "note" && l.subject.startsWith("mil/") && (l.detail ?? "").includes("no credit in the client's sheet"))).toHaveLength(4);
    expect(credits.filter((r) => r.source_id.startsWith("ai/") && r.credit_name === "Josh M (@iamjoshmark)" && r.licence_name === null)).toHaveLength(31);
    expect(credits.filter((r) => r.source_id.startsWith("potd/") && r.credit_name === "Josh M (@iamjoshmark)" && r.licence_name === null)).toHaveLength(5);

    const applied = await counts();
    const again = await seed(inputs, "apply");
    expect(await counts()).toEqual(applied);
    expect(again.counts.done).toBe(0);
    expect(exitCodeOf(again)).toBe(0);

    // Licence, publish, and the next run creates that draft only.
    const pod4 = await mediaIdOfFile("potd/pod-4.jpg");
    await publishPhoto(pod4);
    const third = await seed(inputs, "apply");
    expect(line(third, "plane-of-the-day pod-4").status).toBe("done");
    expect(lines(third, "entry", "waiting")).toHaveLength(4);
    expect(await count("editorial_items")).toBe(1);
    const data = (await sql.query("SELECT data FROM editorial_items")).rows[0].data;
    expect(data).toMatchObject({ title: "Beneath the Heartbeat", aircraft: "Boeing 737", photographer: "Josh M", credit: "@iamjoshmark", instagram: "https://www.instagram.com/iamjoshmark/" });
  }, 180_000);

  it("with DEV_DEMO_WAIVER the four Military photos with no photographer in the sheet (rows 17, 26, 28, 29) need no credit and publish; the other 62 are unchanged", async () => {
    const saved = config;
    config = { ...config, devDemoWaiver: "dev-demo" };
    try {
      const result = await loadSeedInputs(REAL_DOCS, REAL_DELIVERY);
      if (!result.ok) throw new Error(result.error);
      const report = await seed(result.inputs, "apply");
      expect(report.lines.filter((l) => l.status === "refused" || l.status === "failed")).toEqual([]);
      const rows = (
        await sql.query(
          `SELECT i.source_id, i.media_id, v.credit_name, v.credit_required, a.detail->>'creditWaived' AS waived
           FROM media_imports i JOIN media_versions v ON v.media_id = i.media_id
           LEFT JOIN admin_audit a ON a.action = 'media_import' AND a.target = 'med-' || i.media_id
           WHERE i.source_system = 'demo-seed'`,
        )
      ).rows;
      expect(rows).toHaveLength(66);
      const noCredit = rows.filter((r) => r.source_id.startsWith("mil/") && r.credit_name === null);
      expect(noCredit).toHaveLength(4);
      expect(noCredit.every((r) => r.credit_required === false && r.waived === "dev-demo")).toBe(true);
      const others = rows.filter((r) => !noCredit.includes(r));
      expect(others).toHaveLength(62);
      expect(others.every((r) => r.credit_required === true && r.waived === null)).toBe(true);
      expect(report.lines.filter((l) => l.status === "note" && (l.detail ?? "").includes("credit not required (dev-demo waiver)"))).toHaveLength(4);
      const media = new MediaService(database, blobs, config);
      for (const r of noCredit) {
        const revision = (await sql.query("SELECT revision FROM media_items WHERE id = $1", [r.media_id])).rows[0].revision as number;
        await media.publish(ADMIN, r.media_id as number, revision);
      }
      expect(await count("media_items", "WHERE owner = $1 AND state = 'published'", [OWNER])).toBe(4);
    } finally {
      config = saved;
    }
  }, 180_000);
});

describe("scripts/demo-seed-content.mjs", () => {
  const script = path.resolve("scripts/demo-seed-content.mjs");
  const baseEnv = {
    ...process.env,
    ALLOW_EMULATOR_TOKENS: "false",
    FIREBASE_AUTH_EMULATOR_HOST: undefined, // the e2e emulator belongs to the demo project only
    BLOB_STORE: "none",
    DATABASE_URL: "postgres://nobody:not-a-real-password@127.0.0.1:5433/airplane_games_prod",
  };
  const run = (env: Record<string, string>, extra: string[] = ["--docs", "docs", "--delivery", "delivery", "--owner", "owner-uid"]) =>
    // From the temp directory so a developer's .env never reaches it.
    spawnSync(process.execPath, [script, ...extra], { encoding: "utf8", cwd: tmpdir(), timeout: 30_000, env: { ...baseEnv, ...env } });

  beforeAll(() => {
    // The script imports the compiled code, so build the current source first (as roles-grant.e2e.test.ts does).
    const build = spawnSync(process.execPath, ["node_modules/@nestjs/cli/bin/nest.js", "build"], { encoding: "utf8" });
    expect(build.status, build.stdout + build.stderr).toBe(0);
  }, 120_000);

  it("refuses APP_ENV=production with a database ending _prod, exit 2, before connecting", () => {
    const result = run({
      APP_ENV: "production",
      FIREBASE_PROJECT_ID: PROJECT,
      BUNNY_CDN_HOST: "my-zone.b-cdn.net",
      BUNNY_CDN_TOKEN_KEY: "0123456789abcdef-secret-key",
      DATABASE_SSL: "verify-full",
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("_prod");
    expect(result.stdout).not.toContain("Target database");
    expect(result.stderr + result.stdout).not.toContain("not-a-real-password");
  });

  it("refuses a demo- project, exit 2, before connecting", () => {
    const result = run({ APP_ENV: "local", FIREBASE_PROJECT_ID: "demo-airplane-games", DATABASE_URL: "postgres://nobody:not-a-real-password@127.0.0.1:5433/airplane_games_dev" });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("demo- project");
    expect(result.stdout).not.toContain("Target database");
  });

  it("refuses --yes without Bunny, and a missing --owner or an unknown argument, exit 2", () => {
    const env = { APP_ENV: "local", FIREBASE_PROJECT_ID: PROJECT, DATABASE_URL: "postgres://nobody:not-a-real-password@127.0.0.1:5433/airplane_games_dev" };
    const yes = run({ ...env, BLOB_STORE: "memory" }, ["--docs", "docs", "--delivery", "delivery", "--owner", "owner-uid", "--yes"]);
    expect(yes.status, yes.stderr).toBe(2);
    expect(yes.stderr).toContain("BLOB_STORE=bunny");
    const noOwner = run(env, ["--docs", "docs", "--delivery", "delivery"]);
    expect(noOwner.status).toBe(2);
    expect(noOwner.stderr).toContain("--owner");
    const unknown = run(env, ["--docs", "docs", "--delivery", "delivery", "--owner", "x", "--bogus"]);
    expect(unknown.status).toBe(2);
    const demoOwner = run({ ...env, DEMO_ACCOUNT_UID: "the-demo" }, ["--docs", "docs", "--delivery", "delivery", "--owner", "the-demo"]);
    expect(demoOwner.status).toBe(2);
    expect(demoOwner.stderr).toContain("demo account");
  });

  it("refuses a DATABASE_URL that names no database (trailing slash), exit 2 and not a crash", () => {
    const result = run(
      { APP_ENV: "local", FIREBASE_PROJECT_ID: PROJECT, DATABASE_URL: "postgres://nobody:not-a-real-password@127.0.0.1:5433/" },
      ["--docs", "docs", "--delivery", "delivery", "--owner", "owner-uid"],
    );
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("names no database");
  });

  it("refuses folders that are not the client's, exit 2, before connecting", () => {
    const result = run(
      { APP_ENV: "local", FIREBASE_PROJECT_ID: PROJECT, DATABASE_URL: "postgres://nobody:not-a-real-password@127.0.0.1:5433/airplane_games_dev" },
      ["--docs", tmpdir(), "--delivery", tmpdir(), "--owner", "owner-uid"],
    );
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).not.toContain("Target database");
  });
});
