import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import { accountPrincipalFor, isDemoPrincipal, uidOfAccountPrincipal } from "../accounts/account-principal.js";
import { RoleStore } from "../accounts/role-store.js";
import { ApiError } from "../common/errors.js";
import type { AppConfig } from "../config/config.module.js";
import { devDatabaseRefusal } from "../config/dev-database.js";
import { databaseNow } from "../database/clock.js";
import { DatabaseService, ExpectedRollback } from "../database/database.module.js";
import type { Database, Tx } from "../database/database.module.js";
import { accountRoles, adminAudit, editorialItems, mediaImports, mediaItems, mediaVersions, players } from "../db/schema.js";
import type { BlobStore } from "../storage/blob-store.js";
import { ContentDocumentsService } from "./documents/content-documents.service.js";
import { ContentItemEditService } from "./content-item-edit.service.js";
import type { ContentModuleMapping } from "./content-module.js";
import { contentMappingFor } from "./content-modules.js";
import { ContentService } from "./content.service.js";
import type { DryRunResult } from "./content.service.js";
import { discoverSources, listPhotoFiles, matchPhoto, parsePlaneOfTheDay, potdCredit, readSheetFile } from "./demo-seed-sources.js";
import type { PhotoMatch, PotdEntry, PotdIssue, SeedKind, SeedSources } from "./demo-seed-sources.js";
import { EditorialService } from "./editorial/editorial.service.js";
import { blankEditorialData } from "./editorial/editorial-rules.js";
import type { EditorialData } from "./editorial/editorial-rules.js";
import { parseMediaId } from "./item-media-id.js";
import { ClaimLost, describeFailure, findClaim, holdsPhotographer, operatorName, readRegularFile } from "./media/media-import.js";
import type { MEDIA_IMPORT_SOURCE_SYSTEMS } from "./media/media-import.js";
import { sniffImage } from "./media/image-sniff.js";
import { mediaIdOf } from "./media/media-view.js";
import { MAX_MEDIA_BYTES, MediaService } from "./media/media.service.js";
import type { CheckedImage } from "./media/media.service.js";
import { readFirstSheet } from "./xlsx.js";

/**
 * The dev demo seed (scenario E4, docs/plans/demo-seed.md section S4 and the binding section G): load the client's Military and
 * Aircraft Identifier questions, their photos and the five Plane of the Day entries into a DEV backend, through the same write
 * paths the Admin uses (content import, the staff item link, the editorial desk, the operator photographer grant) and one operator
 * photo writer like the D1 import's. This file is the testable core; `scripts/demo-seed-content.mjs` is the shell around it.
 *
 * It publishes nothing. Every photo is an `unverified` draft; a Plane of the Day draft is created only once its photo is published
 * by a person in the Admin. A second run writes nothing.
 */

export const SOURCE_SYSTEM = "demo-seed" satisfies (typeof MEDIA_IMPORT_SOURCE_SYSTEMS)[number];
export const UNSPLASH_LICENCE = "Unsplash License";
export const IDENTIFIER_CREDIT = "Josh M (@iamjoshmark)";
const CREDIT_MAX = 200;
const MILITARY_MODULE = "aircraft-identifier-military";
const IDENTIFIER_MODULE = "identifier";
const RUN_LOCK_NAME = "demo-seed-content";
const MAX_LISTED = 20;

// ---- refusals before anything is contacted ----

export type SeedConfig = Pick<AppConfig, "firebaseProjectId" | "appEnv" | "blobStore" | "demoPrincipal">;
export type SeedArgs = { owner: string; photographers: readonly string[]; yes: boolean };

export type PrincipalResolution = { ok: true; principal: string } | { ok: false; reason: string };

/**
 * A `--owner` / `--photographer` value as a principal of the configured project. A bare value is a Firebase uid bound to the
 * configured project; a full `firebase:<project>:<uid>` of that project is accepted; a full principal of another project, a value
 * that is not a valid uid, and the shared demo account are refused. Whether the uid exists in Firebase cannot be known here.
 */
export function resolveSeedPrincipal(config: Pick<SeedConfig, "firebaseProjectId" | "demoPrincipal">, value: string): PrincipalResolution {
  if (value === "") return { ok: false, reason: "is empty" };
  let principal: string | undefined;
  if (value.startsWith("firebase:")) {
    principal = uidOfAccountPrincipal(value, config.firebaseProjectId) === undefined ? undefined : value;
    if (principal === undefined) return { ok: false, reason: `is a principal of another project (or malformed); only firebase:${config.firebaseProjectId}:<uid> or a bare uid is accepted` };
  } else {
    principal = accountPrincipalFor(value, config.firebaseProjectId);
    if (principal === undefined) return { ok: false, reason: "is not a valid Firebase uid (1-128 characters, no ':' or '/', no control characters)" };
  }
  if (isDemoPrincipal(config, principal)) return { ok: false, reason: "is the shared demo account, which never holds photographer or admin" };
  return { ok: true, principal };
}

/**
 * Why the seed must not run with this configuration, database and arguments (null = fine). Pure; the CLI exits 2 on any answer
 * BEFORE connecting. The database name comes from DATABASE_URL.
 */
export function seedRefusal(config: SeedConfig, dbName: string | null | undefined, args: SeedArgs): string | null {
  if (config.firebaseProjectId.startsWith("demo-")) {
    return `FIREBASE_PROJECT_ID is ${config.firebaseProjectId}, a demo- project: the seed loads content for a real project only (airplane-games-9fe1e).`;
  }
  const database = devDatabaseRefusal(dbName, config.appEnv === "production");
  if (database === "no-database") return "DATABASE_URL names no database; the seed needs to know which one it writes to.";
  if (database === "prod") return `The database "${dbName}" is a production database (name ends _prod); the demo seed never runs against it.`;
  if (database === "not-dev") return `APP_ENV=production runs the seed only against a database whose name ends _dev; this one is "${dbName}".`;
  if (args.yes && config.blobStore !== "bunny") {
    return `--yes needs BLOB_STORE=bunny (this run has "${config.blobStore}"): the images must go to the real store, and a memory store is lost when the command ends.`;
  }
  if (args.yes && config.demoPrincipal === undefined) {
    return "--yes needs DEMO_ACCOUNT_UID set: the refusal to give the shared demo account a staff role only means something when it is known.";
  }
  const named: [string, string][] = [["--owner", args.owner], ...args.photographers.map((p): [string, string] => ["--photographer", p])];
  for (const [flag, value] of named) {
    const resolved = resolveSeedPrincipal(config, value);
    if (!resolved.ok) return `${flag} ${resolved.reason}.`;
  }
  return null;
}

// ---- report ----

export type LineStatus = "done" | "would" | "unchanged" | "waiting" | "note" | "refused" | "failed";
export type Section = "run" | "role" | "content" | "photo" | "link" | "entry";
export type ReportLine = { section: Section; subject: string; status: LineStatus; detail?: string; mediaId?: string };

export type SeedReport = {
  mode: "dry-run" | "apply";
  lines: ReportLine[];
  counts: Record<LineStatus, number>;
};

/**
 * Exit code of a finished run, as `media:import`: 0 nothing wrong (done, would, unchanged, waiting, notes); 3 something refused and
 * nothing done; 4 partial (something done, something refused or failed); 1 something failed and nothing done. 2 is the CLI's own.
 */
export function exitCodeOf(report: SeedReport): 0 | 1 | 3 | 4 {
  const { done, refused, failed } = report.counts;
  if (refused === 0 && failed === 0) return 0;
  if (done > 0) return 4;
  return failed > 0 ? 1 : 3;
}

function finish(mode: SeedReport["mode"], lines: ReportLine[]): SeedReport {
  const counts: Record<LineStatus, number> = { done: 0, would: 0, unchanged: 0, waiting: 0, note: 0, refused: 0, failed: 0 };
  for (const line of lines) counts[line.status] += 1;
  return { mode, lines, counts };
}

// ---- inputs ----

type FolderInput = { fileName: string; bytes: Uint8Array; files: string[]; ignored: string[]; dir: string };
export type SeedInputs = {
  military: FolderInput;
  identifier: FolderInput;
  potd: FolderInput & { entries: PotdEntry[]; issues: PotdIssue[] };
};

async function folderInput(folder: { sheet: string; photoDir: string }): Promise<{ ok: true; input: FolderInput } | { ok: false; error: string }> {
  const sheet = await readSheetFile(folder.sheet);
  if (!sheet.ok) return sheet;
  let listed;
  try {
    listed = await listPhotoFiles(folder.photoDir);
  } catch {
    return { ok: false, error: `${folder.photoDir} is not a readable folder.` };
  }
  return { ok: true, input: { fileName: path.basename(folder.sheet), bytes: sheet.bytes, files: listed.files, ignored: listed.ignored, dir: folder.photoDir } };
}

/** Find and read everything the seed needs from the two folders (read-only). An error means exit 2 before any connection. */
export async function loadSeedInputs(docs: string, delivery: string): Promise<{ ok: true; inputs: SeedInputs } | { ok: false; error: string }> {
  const found = await discoverSources(docs, delivery);
  if (!found.ok) return found;
  return loadFromSources(found.sources);
}

export async function loadFromSources(sources: SeedSources): Promise<{ ok: true; inputs: SeedInputs } | { ok: false; error: string }> {
  const military = await folderInput(sources.military);
  if (!military.ok) return military;
  const identifier = await folderInput(sources.identifier);
  if (!identifier.ok) return identifier;
  const potd = await folderInput(sources.potd);
  if (!potd.ok) return potd;
  let parsed;
  try {
    parsed = parsePlaneOfTheDay(await readFirstSheet(potd.input.bytes));
  } catch (error) {
    return { ok: false, error: `${potd.input.fileName}: ${error instanceof Error ? error.message : "not readable"}` };
  }
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, inputs: { military: military.input, identifier: identifier.input, potd: { ...potd.input, entries: parsed.entries, issues: parsed.issues } } };
}

// ---- pure helpers ----

/** `<mil|ai|potd>/<file name>`: the claim's source id. Null when it would not fit the 128-character column. */
export function photoSourceId(kind: SeedKind, file: string): string | null {
  const id = `${kind}/${file}`;
  return id.length <= 128 ? id : null;
}

/** The Plane of the Day entry's draft data (plan G): title, aircraft, photographer, Instagram URL, credit `@handle`, description. */
export function potdEntryData(entry: PotdEntry): EditorialData {
  return {
    ...blankEditorialData(),
    title: entry.title,
    aircraft: entry.aircraft,
    photographer: entry.photographer,
    instagram: entry.instagram,
    credit: entry.handle === "" ? "" : `@${entry.handle}`,
    description: entry.description,
  };
}

/** A credit that is empty after trimming is none; otherwise it must be a clean one-liner of at most 200 characters. */
export function cleanCredit(raw: string | null | undefined): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw.trim() === "") return { ok: true, value: null };
  const value = raw.trim();
  if (/\p{Cc}/u.test(value) || [...value].length > CREDIT_MAX) return { ok: false, reason: `credit must be 1-${CREDIT_MAX} characters on one line.` };
  return { ok: true, value };
}

// ---- run context and lock ----

export type SeedContext = {
  database: DatabaseService;
  blobs: BlobStore;
  config: AppConfig;
  /** The OS user running the command; every write is by `operator:<operator>`. */
  operator: string;
  /** The pool behind `database`; `--yes` holds one connection of it for the run lock. */
  pool?: pg.Pool;
};

export type RunLock = { release: () => Promise<void> };

/** A session advisory lock on a dedicated pooled connection, or undefined when another run holds it. Never waits. */
export async function acquireRunLock(pool: pg.Pool): Promise<RunLock | undefined> {
  const client = await pool.connect();
  let released = false;
  try {
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [RUN_LOCK_NAME]);
    if (result.rows[0]?.locked !== true) {
      client.release();
      return undefined;
    }
  } catch (error) {
    client.release(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [RUN_LOCK_NAME]);
        client.release();
      } catch (error) {
        client.release(error instanceof Error ? error : new Error(String(error))); // destroying the connection drops the lock
      }
    },
  };
}

/** Principals the backend has never seen (no players row and no account_roles row): the operator reads this before `--yes`. */
export async function unseenPrincipals(db: Database, principals: readonly string[]): Promise<string[]> {
  if (principals.length === 0) return [];
  const list = [...principals];
  const seenPlayers = await db.select({ id: players.id }).from(players).where(inArray(players.id, list));
  const seenRoles = await db.select({ id: accountRoles.principal }).from(accountRoles).where(inArray(accountRoles.principal, list));
  const seen = new Set([...seenPlayers.map((r) => r.id), ...seenRoles.map((r) => r.id)]);
  return list.filter((p) => !seen.has(p));
}

// ---- the run ----

type Item = { id: string; version: number; data: Record<string, unknown>; mediaId: number | null; planned: boolean; prepared: boolean };
type ModuleState = {
  module: string;
  /** The sheet differs from stored content (diff refusal) or the content step failed: nothing is linked. */
  refused: boolean;
  /** The content step itself failed (invalid sheet, lock, plan changed, storage): the module's photos are not uploaded. */
  failed: boolean;
  items: Item[];
  /** The sheet's own rows (payloads), parsed from the bytes; the source of credits, whatever is stored. */
  sheet: Record<string, unknown>[];
};
type PhotoOutcome = { mediaId?: number; usable: boolean };


const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;
const fileOfItem = (item: Item): string => (typeof item.data["sourceFile"] === "string" ? (item.data["sourceFile"] as string).trim() : "");

function failureLine(section: Section, subject: string, error: unknown): ReportLine {
  if (isApiError(error) && error.status < 500) return { section, subject, status: "refused", detail: error.message };
  return { section, subject, status: "failed", detail: describeFailure(error) };
}

function reportOf(error: ApiError): string {
  const report = error.extra["report"];
  if (!Array.isArray(report)) return error.message;
  const shown = report.slice(0, 5).map((r: { row?: number; message?: string }) => `row ${r.row ?? "?"}: ${r.message ?? ""}`);
  return `${error.message} ${shown.join(" | ")}${report.length > 5 ? ` | ... ${report.length - 5} more` : ""}`;
}

/**
 * Run the seed. `dry-run` reads the database and the files and writes nothing (no row, blob, audit or receipt); `apply` writes, and
 * refuses to start while another `--yes` run holds the run lock. Order: photographer grants; Military and Identifier content;
 * photos; links; Plane of the Day drafts. An expected refusal or an unexpected failure of one step is reported and the run goes on
 * with the steps that do not depend on it.
 */
export async function runDemoSeed(
  inputs: SeedInputs,
  owner: string,
  photographers: readonly string[],
  mode: "dry-run" | "apply",
  ctx: SeedContext,
): Promise<SeedReport> {
  const lines: ReportLine[] = [];
  const push = (line: ReportLine) => void lines.push(line);
  let lock: RunLock | undefined;
  if (mode === "apply") {
    if (!ctx.pool) throw new Error("An apply run needs the pool for its run lock.");
    lock = await acquireRunLock(ctx.pool);
    if (!lock) {
      push({ section: "run", subject: "run lock", status: "refused", detail: "another demo seed run holds the run lock; nothing was written." });
      return finish(mode, lines);
    }
  }
  try {
    await steps(inputs, owner, photographers, mode, ctx, push);
  } finally {
    await lock?.release();
  }
  return finish(mode, lines);
}

async function steps(
  inputs: SeedInputs,
  owner: string,
  photographers: readonly string[],
  mode: "dry-run" | "apply",
  ctx: SeedContext,
  push: (line: ReportLine) => void,
): Promise<void> {
  const by = operatorName(ctx.operator);
  const content = new ContentService(ctx.database, ctx.blobs, new ContentDocumentsService(ctx.database));
  const edits = new ContentItemEditService(ctx.database, ctx.config);
  const editorial = new EditorialService(ctx.database, ctx.config);
  const media = new MediaService(ctx.database, ctx.blobs, ctx.config);
  const roles = new RoleStore(ctx.database, ctx.config);
  const apply = mode === "apply";

  // 1. Roles.
  const grantedInRun = new Set<string>();
  for (const principal of [...new Set(photographers)]) {
    try {
      if (!apply) {
        const row = (await roles.rolesOf(principal)).find((r) => r.role === "photographer");
        if (!row) {
          grantedInRun.add(principal);
          push({ section: "role", subject: principal, status: "would", detail: "would grant photographer" });
        } else if (row.state === "pending") {
          grantedInRun.add(principal);
          push({ section: "role", subject: principal, status: "would", detail: "would approve the pending photographer request" });
        } else if (row.state === "active") {
          push({ section: "role", subject: principal, status: "unchanged", detail: "photographer already active" });
        } else {
          push({ section: "role", subject: principal, status: "refused", detail: `photographer is ${row.state}: an admin decided this; decide again in the Admin` });
        }
        continue;
      }
      const result = await roles.grantPhotographer({ kind: "operator", id: ctx.operator }, principal, "dev demo seed");
      if (!result.ok) push(failureLine("role", principal, result.error));
      else push({ section: "role", subject: principal, status: result.changed ? "done" : "unchanged", detail: result.changed ? "photographer granted" : "photographer already active" });
    } catch (error) {
      push(failureLine("role", principal, error));
    }
  }

  // 2. Content.
  const military = await seedModule(MILITARY_MODULE, inputs.military, mode, content, ctx, by, push);
  const identifier = await seedModule(IDENTIFIER_MODULE, inputs.identifier, mode, content, ctx, by, push);

  // 3. Photos.
  const milMatches = matchItems(military.items, inputs.military.files);
  const aiMatches = matchItems(identifier.items, inputs.identifier.files);
  noteUnmatched(military, milMatches, "mil", push);
  noteUnmatched(identifier, aiMatches, "ai", push);
  const potdMatches = new Map<string, PotdEntry>();
  for (const entry of inputs.potd.entries) {
    const match = matchPhoto(entry.image, inputs.potd.files);
    if (match.kind === "exact" || match.kind === "case_insensitive" || match.kind === "extension") {
      if (match.kind !== "exact" && /\.[A-Za-z0-9]{1,6}$/.test(entry.image)) push({ section: "photo", subject: `potd ${entry.image}`, status: "note", detail: `matched ${match.file} (${describeMatch(match)})` });
      potdMatches.set(match.file, entry);
    } else {
      push({ section: "photo", subject: `potd ${entry.image}`, status: "note", detail: match.kind === "ambiguous" ? `more than one photo file fits: ${match.files.join(", ")}` : "no photo file in the folder" });
    }
  }
  for (const issue of inputs.potd.issues) push({ section: "entry", subject: `potd row ${issue.row}`, status: "note", detail: issue.message });
  for (const name of [...inputs.military.ignored, ...inputs.identifier.ignored, ...inputs.potd.ignored]) {
    push({ section: "photo", subject: name, status: "note", detail: "not an image file (.jpg, .jpeg, .png); ignored" });
  }

  for (const state of [military, identifier]) {
    if (state.failed) push({ section: "photo", subject: state.module, status: "failed", detail: "content step failed; photos not uploaded, re-run" });
  }
  const outcomes = new Map<string, PhotoOutcome>();
  const owners = { owner, grantedInRun };
  const plans: PhotoPlan[] = [
    ...(military.failed ? [] : inputs.military.files).map((file): PhotoPlan => {
      const items = military.items.filter((i) => milMatches.get(i.id)?.file === file);
      // The credit is the SHEET's Photographer for the row naming this file (never a stored, possibly staff-edited value).
      const credit =
        military.sheet
          .filter((row) => {
            const m = matchPhoto(String(row["sourceFile"] ?? ""), inputs.military.files);
            return "file" in m && m.file === file;
          })
          .map((row) => String(row["photographer"] ?? "").trim())
          .find((c) => c !== "") ?? "";
      // DEV_DEMO_WAIVER: a photo a question uses, whose sheet row names no photographer, is loaded with credit not required (never a
      // made-up name). A photo no question uses is left as it was.
      const waiveCredit = credit === "" && items.length > 0 && ctx.config.devDemoWaiver === "dev-demo";
      const noCreditNote = items.length === 0 ? "no question uses this photo, so no credit" : waiveCredit ? "no credit in the client's sheet; credit not required (dev-demo waiver)" : "no credit in the client's sheet";
      return { kind: "mil", dir: inputs.military.dir, file, credit, licence: UNSPLASH_LICENCE, noCreditNote, waiveCredit, unused: items.length === 0 ? "no question" : undefined };
    }),
    ...(identifier.failed ? [] : inputs.identifier.files).map((file): PhotoPlan => {
      const items = identifier.items.filter((i) => aiMatches.get(i.id)?.file === file);
      return { kind: "ai", dir: inputs.identifier.dir, file, credit: IDENTIFIER_CREDIT, licence: null, noCreditNote: "", unused: items.length === 0 ? "no question (row left out)" : undefined };
    }),
    ...inputs.potd.files.map((file): PhotoPlan => {
      const entry = potdMatches.get(file);
      return { kind: "potd", dir: inputs.potd.dir, file, credit: entry ? potdCredit(entry) : "", licence: null, noCreditNote: entry ? "no photographer in the client's sheet" : "no sheet row names this photo", unused: entry ? undefined : "no Plane of the Day row" };
    }),
  ];
  for (const plan of plans) {
    const subject = `${plan.kind}/${plan.file}`;
    const result = await seedPhoto(plan, owners, mode, ctx, media, by);
    push({ section: "photo", subject, status: result.status, ...(result.detail !== undefined ? { detail: result.detail } : {}), ...(result.mediaId !== undefined ? { mediaId: mediaIdOf(result.mediaId) } : {}) });
    outcomes.set(subject, { usable: result.status === "done" || result.status === "unchanged" || result.status === "would", ...(result.mediaId !== undefined ? { mediaId: result.mediaId } : {}) });
    if (result.status !== "refused" && result.status !== "failed") {
      if (plan.unused !== undefined) push({ section: "photo", subject, status: "note", detail: `photo has ${plan.unused}` });
      if (plan.credit === "" && plan.noCreditNote !== "") {
        // The credit setting is written only when this run inserts the version; an already uploaded photo keeps what it has, so the
        // note must not claim the waiver (or its absence) for it.
        const detail =
          result.status === "unchanged" && plan.unused === undefined
            ? "no credit in the client's sheet; already uploaded, so this run did not change whether a credit is required"
            : plan.noCreditNote;
        push({ section: "photo", subject, status: "note", detail });
      }
    }
  }

  // 4. Links.
  for (const [state, matches, kind] of [
    [military, milMatches, "mil"],
    [identifier, aiMatches, "ai"],
  ] as const) {
    if (state.refused) {
      push({ section: "link", subject: state.module, status: "note", detail: "module refused above; no photo is linked" });
      continue;
    }
    for (const item of state.items) {
      const match = matches.get(item.id);
      if (!match) continue;
      const subject = `${state.module} ${item.id}`;
      const photo = outcomes.get(`${kind}/${match.file}`);
      try {
        push(await linkItem(state.module, item, match.file, photo, mode, ctx, edits, by, subject));
      } catch (error) {
        push(failureLine("link", subject, error));
      }
    }
  }

  // 5. Plane of the Day drafts.
  for (const entry of inputs.potd.entries) {
    const subject = `plane-of-the-day ${entry.image}`;
    const file = [...potdMatches.entries()].find(([, e]) => e === entry)?.[0];
    const photo = file === undefined ? undefined : outcomes.get(`potd/${file}`);
    try {
      push(await potdEntry(entry, subject, photo, mode, ctx, editorial, by));
    } catch (error) {
      push(failureLine("entry", subject, error));
    }
    push({ section: "entry", subject, status: "note", detail: "no factual source in the client's sheet (publishing needs an https one)" });
  }
}

function describeMatch(match: PhotoMatch): string {
  switch (match.kind) {
    case "exact":
      return "exact name";
    case "case_insensitive":
      return "same name, different letter case";
    case "extension":
      return "same name with the image extension";
    default:
      return match.kind;
  }
}

/** Match each item's sheet file name to a photo file; a non-exact match is not reported here (see noteUnmatched). */
function matchItems(items: readonly Item[], files: readonly string[]): Map<string, Extract<PhotoMatch, { file: string }>> {
  const result = new Map<string, Extract<PhotoMatch, { file: string }>>();
  for (const item of items) {
    const match = matchPhoto(fileOfItem(item), files);
    if (match.kind === "exact" || match.kind === "case_insensitive" || match.kind === "extension") result.set(item.id, match);
  }
  return result;
}

function noteUnmatched(state: ModuleState, matches: Map<string, Extract<PhotoMatch, { file: string }>>, kind: SeedKind, push: (line: ReportLine) => void): void {
  for (const item of state.items) {
    const wanted = fileOfItem(item);
    const match = matches.get(item.id);
    const subject = `${state.module} ${item.id}`;
    if (match) {
      if (match.kind !== "exact") push({ section: "photo", subject, status: "note", detail: `sheet says "${wanted}", matched ${kind}/${match.file} (${describeMatch(match)})` });
    } else {
      push({ section: "photo", subject, status: "note", detail: wanted === "" ? "the sheet names no photo file" : `no photo for "${wanted}" in the folder; nothing is substituted` });
    }
  }
}

// ---- content ----

async function seedModule(
  module: string,
  input: FolderInput,
  mode: "dry-run" | "apply",
  content: ContentService,
  ctx: SeedContext,
  by: string,
  push: (line: ReportLine) => void,
): Promise<ModuleState> {
  const mapping = contentMappingFor(module) as ContentModuleMapping;
  const state: ModuleState = { module, refused: false, failed: false, items: [], sheet: [] };
  let dry;
  try {
    dry = await content.dryRun(mapping, input.bytes);
  } catch (error) {
    state.refused = true;
    state.failed = true;
    push(isApiError(error) && error.status < 500 ? { section: "content", subject: module, status: "refused", detail: reportOf(error) } : failureLine("content", module, error));
    return state;
  }
  state.sheet = mapping.parse(await readFirstSheet(input.bytes)).rows.map((r) => r.data);
  let planned: DryRunResult | undefined;
  if (dry.replay) {
    push({ section: "content", subject: module, status: "unchanged", detail: `same file as the last import (${dry.import.id}); nothing to do` });
  } else {
    planned = dry;
    for (const w of dry.warnings.filter((issue) => issue.level === "warning").slice(0, 60)) {
      push({ section: "content", subject: `${module} row ${w.row}`, status: "note", detail: w.message });
    }
    const { created, updated, unchanged, retired } = dry.counts;
    if (updated > 0 || retired > 0) {
      state.refused = true;
      const changed = dry.rows.filter((r) => r.action === "update").map((r) => `${r.id} (${(r.diff ?? []).map((d) => d.field).join(", ") || "changed"})`);
      const retiring = dry.retirements.map((r) => `${r.id} (retire)`);
      const all = [...changed, ...retiring];
      push({
        section: "content",
        subject: module,
        status: "refused",
        detail: `the sheet differs from stored content (${updated} to update, ${retired} to retire): ${all.slice(0, MAX_LISTED).join("; ")}${all.length > MAX_LISTED ? `; ... ${all.length - MAX_LISTED} more` : ""}. The seed never overwrites stored content; import it in the Admin.`,
      });
    } else if (created === 0) {
      push({ section: "content", subject: module, status: "unchanged", detail: `${unchanged} questions already stored as in the sheet` });
    } else if (mode === "dry-run") {
      push({ section: "content", subject: module, status: "would", detail: `would create ${created} questions (${unchanged} already stored)` });
    } else {
      try {
        const applied = await content.apply(mapping, input.bytes, input.fileName, by, dry.planHash);
        const counts = applied.import;
        push({ section: "content", subject: module, status: applied.replayed ? "unchanged" : "done", detail: `created ${counts.created}, unchanged ${counts.unchanged} (import ${counts.id})` });
      } catch (error) {
        state.refused = true;
        state.failed = true;
        push(failureLine("content", module, error));
        return state;
      }
    }
  }

  const stored = (await content.listItems(module)).filter((i) => i.status === "approved");
  for (const i of stored) {
    state.items.push({ id: i.id, version: i.version, data: i.data as Record<string, unknown>, mediaId: i.mediaId === null ? null : (parseMediaId(i.mediaId) ?? null), planned: false, prepared: i.preparation !== null });
  }
  if (planned && mode === "dry-run" && planned.counts.created > 0 && !state.refused) {
    const parsed = mapping.parse(await readFirstSheet(input.bytes));
    const byRow = new Map(parsed.rows.map((r) => [r.row, r]));
    const known = new Set(state.items.map((i) => i.id));
    for (const r of planned.rows) {
      const row = byRow.get(r.row);
      if (r.action === "create" && row && !known.has(r.id)) state.items.push({ id: r.id, version: 1, data: row.data, mediaId: null, planned: true, prepared: false });
    }
  }
  return state;
}

// ---- photos ----

type PhotoPlan = {
  kind: SeedKind;
  dir: string;
  file: string;
  /** "" = none. */
  credit: string;
  licence: string | null;
  noCreditNote: string;
  /** True only under DEV_DEMO_WAIVER for a Military photo with no credit in the sheet: version 1 gets creditRequired false. */
  waiveCredit?: boolean;
  /** Why no question or entry uses this photo, or undefined when one does. */
  unused: string | undefined;
};
type PhotoResult = { status: LineStatus; detail?: string; mediaId?: number };


/**
 * One photo: the file is read (no link, 5 MB cap), checked by its bytes (type, 4096 px) and matched against the claim for
 * `<kind>/<file name>`. The same owner and sha256 is "already uploaded"; any other claim is a refused conflict (a changed owner or
 * file is never duplicated). A new photo: blob stored and read back, then ONE transaction that re-checks the owner (active
 * photographer or admin, FOR SHARE), inserts the unverified item and version 1 (credit, licence and the operator's v1_authorised
 * statement set at insert), claims the source id and writes the `media_import` audit row.
 */
async function seedPhoto(
  plan: PhotoPlan,
  who: { owner: string; grantedInRun: ReadonlySet<string> },
  mode: "dry-run" | "apply",
  ctx: SeedContext,
  media: MediaService,
  by: string,
): Promise<PhotoResult> {
  try {
    const sourceId = photoSourceId(plan.kind, plan.file);
    if (sourceId === null) return { status: "refused", detail: "the source id (kind/file name) is longer than 128 characters." };
    const credit = cleanCredit(plan.credit);
    if (!credit.ok) return { status: "refused", detail: credit.reason };
    const read = await readRegularFile(path.join(plan.dir, plan.file), MAX_MEDIA_BYTES);
    if (!read.ok) return { status: "refused", detail: read.detail };
    const sniffed = sniffImage(read.bytes);
    if (!sniffed.ok) return { status: "refused", detail: `not an accepted image: ${sniffed.reason}.` };
    let image: CheckedImage;
    try {
      image = media.checkImage(read.bytes, sniffed.contentType);
    } catch (error) {
      if (isApiError(error)) return { status: "refused", detail: error.message };
      throw error;
    }
    const claim = await findClaim(ctx.database.db, SOURCE_SYSTEM, sourceId);
    if (claim) {
      return claim.owner === who.owner && claim.sha256 === image.sha256
        ? { status: "unchanged", detail: "already uploaded", mediaId: claim.mediaId }
        : { status: "refused", detail: `${sourceId} is already uploaded as ${mediaIdOf(claim.mediaId)} with a different owner or file; nothing was changed.` };
    }
    if (isDemoPrincipal(ctx.config, who.owner)) return { status: "refused", detail: "the owner is the shared demo account." };
    const holds = who.grantedInRun.has(who.owner) || (await holdsPhotographer(ctx.database.db, who.owner));
    if (!holds) return { status: "refused", detail: "the owner has no active photographer or admin role (grant it with --photographer, or in the Admin)." };
    if (mode === "dry-run") return { status: "would", detail: `would upload (${image.width}x${image.height} ${image.contentType})` };

    await media.storeImage(read.bytes, image);
    try {
      const outcome = await ctx.database.withTransaction(async (tx: Tx): Promise<{ mediaId: number } | { refused: string }> => {
        if (isDemoPrincipal(ctx.config, who.owner)) return { refused: "the owner is the shared demo account." };
        if (!(await holdsPhotographer(tx, who.owner))) return { refused: "the owner has no active photographer or admin role." };
        const now = await databaseNow(tx);
        const [item] = await tx
          .insert(mediaItems)
          .values({ owner: who.owner, state: "unverified", draftVersion: 1, publishedVersion: null, createdBy: by, updatedBy: by, createdAt: now, updatedAt: now })
          .returning();
        if (!item) throw new Error("Media item was not stored.");
        await tx.insert(mediaVersions).values({
          mediaId: item.id,
          version: 1,
          sha256: image.sha256,
          contentType: image.contentType,
          byteSize: image.byteSize,
          width: image.width,
          height: image.height,
          creditName: credit.value,
          creditRequired: plan.waiveCredit !== true,
          licenceName: plan.licence,
          rightsStatement: "v1_authorised",
          // The operator states the client's licence, not the photographer.
          rightsStatedBy: by,
          rightsStatedAt: now,
          createdBy: by,
          createdAt: now,
          updatedBy: by,
          updatedAt: now,
        });
        const won = await tx
          .insert(mediaImports)
          .values({ sourceSystem: SOURCE_SYSTEM, sourceId, mediaId: item.id, owner: who.owner, sha256: image.sha256, importedAt: now })
          .onConflictDoNothing()
          .returning({ mediaId: mediaImports.mediaId });
        if (won.length !== 1) throw new ClaimLost();
        await tx.insert(adminAudit).values({
          actor: by,
          action: "media_import",
          target: mediaIdOf(item.id),
          detail: {
            source: SOURCE_SYSTEM,
            sourceId,
            owner: who.owner,
            mediaId: mediaIdOf(item.id),
            rightsStatement: "v1_authorised",
            credit: credit.value,
            licence: plan.licence,
            ...(plan.waiveCredit === true ? { creditWaived: "dev-demo" } : {}),
            note: "Loaded by the dev demo seed as an unverified draft; the operator stated the client's licence (v1_authorised). Nothing is published.",
          },
          createdAt: now,
        });
        return { mediaId: item.id };
      });
      if ("refused" in outcome) return { status: "refused", detail: outcome.refused };
      return { status: "done", detail: `uploaded (${image.width}x${image.height} ${image.contentType})`, mediaId: outcome.mediaId };
    } catch (error) {
      if (!(error instanceof ClaimLost)) throw error;
      const lost = await findClaim(ctx.database.db, SOURCE_SYSTEM, sourceId);
      if (!lost) throw new Error("Import claim vanished after a lost race.");
      return lost.owner === who.owner && lost.sha256 === image.sha256
        ? { status: "unchanged", detail: "already uploaded (a parallel run won)", mediaId: lost.mediaId }
        : { status: "refused", detail: `${sourceId} was uploaded meanwhile as ${mediaIdOf(lost.mediaId)} with a different owner or file.` };
    }
  } catch (error) {
    return { status: isApiError(error) && error.status < 500 ? "refused" : "failed", detail: describeFailure(error) };
  }
}

// ---- links ----

async function hasStaffLinkAudit(db: Pick<Database, "select">, module: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: adminAudit.id })
    .from(adminAudit)
    .where(and(inArray(adminAudit.action, ["content_media_link", "content_prepare"]), eq(adminAudit.target, module), sql`${adminAudit.detail}->>'id' = ${id}`))
    .limit(1);
  return rows.length > 0;
}

/** Link the item to its photo only when it has no photo AND staff never linked or cleared one (no content_media_link audit row). */
async function linkItem(
  module: string,
  item: Item,
  file: string,
  photo: PhotoOutcome | undefined,
  mode: "dry-run" | "apply",
  ctx: SeedContext,
  edits: ContentItemEditService,
  by: string,
  subject: string,
): Promise<ReportLine> {
  const mediaId = photo?.mediaId;
  if (photo === undefined || !photo.usable) {
    return { section: "link", subject, status: "note", detail: `its photo ${file} could not be used in this run; not linked` };
  }
  if (item.mediaId !== null) {
    return mediaId !== undefined && item.mediaId === mediaId
      ? { section: "link", subject, status: "unchanged", detail: `already linked to ${mediaIdOf(item.mediaId)}`, mediaId: mediaIdOf(item.mediaId) }
      : { section: "link", subject, status: "note", detail: `linked to ${mediaIdOf(item.mediaId)}, which is not this photo; left alone` };
  }
  if (item.prepared) {
    return { section: "link", subject, status: "note", detail: "staff prepared this item; link left alone" };
  }
  if (!item.planned && (await hasStaffLinkAudit(ctx.database.db, module, item.id))) {
    return { section: "link", subject, status: "note", detail: "staff linked, cleared or prepared a photo for this item before; left alone" };
  }
  if (mode === "dry-run" || mediaId === undefined) {
    return { section: "link", subject, status: "would", detail: `would link to ${mediaId === undefined ? `the new photo ${file}` : mediaIdOf(mediaId)}`, ...(mediaId !== undefined ? { mediaId: mediaIdOf(mediaId) } : {}) };
  }
  const change = await edits.setMedia(module, item.id, item.version, mediaIdOf(mediaId), by);
  return { section: "link", subject, status: change.changed ? "done" : "unchanged", detail: `linked to ${mediaIdOf(mediaId)}`, mediaId: mediaIdOf(mediaId) };
}

// ---- Plane of the Day ----

/**
 * A Plane of the Day draft is created only when its photo is PUBLISHED (the desk's rule; the seed never relaxes it) and no
 * `plane-of-the-day` editorial row has that photo (any status, a staff-made one included). Otherwise "waiting" or "unchanged".
 */
async function potdEntry(
  entry: PotdEntry,
  subject: string,
  photo: PhotoOutcome | undefined,
  mode: "dry-run" | "apply",
  ctx: SeedContext,
  editorial: EditorialService,
  by: string,
): Promise<ReportLine> {
  const mediaId = photo?.mediaId;
  if (mediaId === undefined) {
    return { section: "entry", subject, status: "waiting", detail: `waiting for its photo (${entry.image}) to be uploaded and published` };
  }
  const db = ctx.database.db;
  const [existing] = await db
    .select({ id: editorialItems.id, status: editorialItems.status })
    .from(editorialItems)
    .where(and(eq(editorialItems.kind, "plane-of-the-day"), eq(editorialItems.mediaId, mediaId)))
    .limit(1);
  if (existing) return { section: "entry", subject, status: "unchanged", detail: `already there as ed-${existing.id} (${existing.status})`, mediaId: mediaIdOf(mediaId) };
  const [row] = await db.select({ state: mediaItems.state, publishedVersion: mediaItems.publishedVersion }).from(mediaItems).where(eq(mediaItems.id, mediaId)).limit(1);
  if (!row || row.state !== "published" || row.publishedVersion === null) {
    return { section: "entry", subject, status: "waiting", detail: `waiting for ${mediaIdOf(mediaId)} to be published (set its licence name, then publish it in the Admin)`, mediaId: mediaIdOf(mediaId) };
  }
  if (mode === "dry-run") return { section: "entry", subject, status: "would", detail: `would create a draft for ${mediaIdOf(mediaId)}`, mediaId: mediaIdOf(mediaId) };
  const created = await editorial.create("plane-of-the-day", mediaId, potdEntryData(entry), by);
  return { section: "entry", subject, status: "done", detail: `draft ${created.id} created for ${mediaIdOf(mediaId)}`, mediaId: mediaIdOf(mediaId) };
}


