import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { isDemoPrincipal, uidOfAccountPrincipal } from "../../accounts/account-principal.js";
import { ApiError } from "../../common/errors.js";
import type { AppConfig } from "../../config/config.module.js";
import { databaseNow } from "../../database/clock.js";
import { DatabaseService, ExpectedRollback } from "../../database/database.module.js";
import type { Database, Tx } from "../../database/database.module.js";
import { accountRoles, adminAudit, mediaImports, mediaItems, mediaVersions } from "../../db/schema.js";
import type { BlobStore } from "../../storage/blob-store.js";
import { normaliseMediaDescription } from "./media-description.js";
import { mediaIdOf } from "./media-view.js";
import { MAX_MEDIA_BYTES, MediaService } from "./media.service.js";
import type { CheckedImage } from "./media.service.js";

/**
 * The D1 photo import (docs/plans/media-import.md, Wave I of media-rights-and-public.md): an operator command, never a route.
 * This file is the testable core: parse a bundle (a directory with `manifest.json` and the image files), report what would happen
 * (dry run, writes nothing anywhere), or apply it (one transaction per entry, the blob written and read back first).
 *
 * Each imported photo becomes an `unverified` item owned by the manifest `owner`, with version 1 carrying the rights statement
 * `d1_private_review` (the D1 consent covered private editorial review only, so there is NO licence and the item cannot be
 * published until its owner states rights v1 and a licence is set). The contact email is not part of the manifest and is never stored.
 */

export const MANIFEST_FILE = "manifest.json";
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const SOURCE_SYSTEM = "d1";
const CREDIT_MAX = 200;

/** D1 `submissions.status` values. `rejected` is refused per entry (ruling 2026-11-04); the rest are imported. */
export const D1_STATUSES = ["pending", "changes_requested", "approved", "rejected"] as const;
/**
 * Manifest values of the rights basis. NOT the D1 spelling: D1 stores `payload.rightsBasis` as `owner | authorized`, and the
 * website's export maps `owner` to `own`. Audit only.
 */
export const D1_RIGHTS_BASES = ["own", "authorized"] as const;

const optionalText = z.string().optional();

const entrySchema = z.strictObject({
  sourceId: z.string().min(1).max(128),
  owner: z.string().min(1).max(512),
  status: z.enum(D1_STATUSES),
  file: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  sha256: z.string().min(1).max(100),
  credit: optionalText,
  rightsBasis: z.enum(D1_RIGHTS_BASES),
  submittedAt: z.string().min(1).max(64),
  description: optionalText,
  aircraft: optionalText,
  airline: optionalText,
  registration: optionalText,
  location: optionalText,
  airportCode: optionalText,
  capturedOn: optionalText,
  title: optionalText,
  factualSource: optionalText,
  rightsEvidence: optionalText,
});

const manifestSchema = z.strictObject({
  version: z.literal(1),
  source: z.literal("d1"),
  entries: z.array(entrySchema).max(MAX_ENTRIES),
});

export type ImportEntry = z.infer<typeof entrySchema>;
export type ImportManifest = z.infer<typeof manifestSchema>;

export type ManifestResult = { ok: true; manifest: ImportManifest } | { ok: false; error: string };

/** Parse and validate manifest text. Unknown keys anywhere are refused (so an `email` key can never slip through). */
export function parseManifest(text: string): ManifestResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "manifest.json is not valid JSON." };
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.length > 0 ? i.path.join(".") : "(manifest)"}: ${i.message}`);
    return { ok: false, error: `manifest.json does not match the schema (${issues.join("; ")}).` };
  }
  const seen = new Set<string>();
  for (const entry of parsed.data.entries) {
    if (seen.has(entry.sourceId)) return { ok: false, error: `manifest.json lists sourceId "${entry.sourceId}" more than once.` };
    seen.add(entry.sourceId);
  }
  return { ok: true, manifest: parsed.data };
}

/** Read `<dir>/manifest.json` (a plain file, at most 10 MB) and parse it. */
export async function loadBundle(dir: string): Promise<ManifestResult> {
  const read = await readRegularFile(path.join(dir, MANIFEST_FILE), MAX_MANIFEST_BYTES);
  if (!read.ok) return { ok: false, error: `${MANIFEST_FILE}: ${read.detail}` };
  return parseManifest(Buffer.from(read.bytes).toString("utf8"));
}

export type FileRead = { ok: true; bytes: Uint8Array } | { ok: false; code: "bad_path" | "file_missing" | "too_large"; detail: string };

/**
 * Read a plain file of at most `cap` bytes without following a symbolic link, closing the gap between a check and the read: lstat
 * first (the only link check on Windows), then open with O_NOFOLLOW where the platform has it, stat the OPEN handle (regular file,
 * size) and read at most cap + 1 bytes from that handle, so a file that grew after the check is still refused.
 */
export async function readRegularFile(file: string, cap: number): Promise<FileRead> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) return { ok: false, code: "bad_path", detail: "file is a symbolic link." };
    if (!info.isFile()) return { ok: false, code: "bad_path", detail: "file is not a regular file." };
  } catch {
    return { ok: false, code: "file_missing", detail: "file is not in the bundle." };
  }
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    return code === "ELOOP" ? { ok: false, code: "bad_path", detail: "file is a symbolic link." } : { ok: false, code: "file_missing", detail: "file could not be opened." };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, code: "bad_path", detail: "file is not a regular file." };
    if (info.size > cap) return { ok: false, code: "too_large", detail: `file is ${info.size} bytes; the limit is ${cap}.` };
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > cap) return { ok: false, code: "too_large", detail: `file is larger than the limit of ${cap} bytes.` };
    return { ok: true, bytes: new Uint8Array(buffer.subarray(0, length)) };
  } catch {
    return { ok: false, code: "file_missing", detail: "file could not be read." };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// ---- pure checks ----

const CONTROL = /\p{Cc}/u;
const codePoints = (value: string): number => [...value].length;

/**
 * `file` must be a bare filename inside the bundle: no path separator of either kind, no `.` or `..`, no drive or stream colon, no
 * NUL or control character, not absolute on any platform.
 */
export function isBareFilename(file: string): boolean {
  if (file === "." || file === ".." || file.trim() !== file) return false;
  if (/[\\/:]/.test(file) || CONTROL.test(file)) return false;
  return !path.posix.isAbsolute(file) && !path.win32.isAbsolute(file) && path.basename(file) === file;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** An ISO-8601 UTC instant (`...Z`) that is a real calendar time and not after `now`; otherwise a reason. */
export function parseSubmittedAt(value: string, now: Date): { ok: true; at: Date } | { ok: false; reason: string } {
  if (!ISO_UTC.test(value)) return { ok: false, reason: "submittedAt must be an ISO 8601 UTC time such as 2026-10-01T12:00:00Z." };
  const at = new Date(value);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    return { ok: false, reason: "submittedAt is not a real calendar time." };
  }
  if (at.getTime() > now.getTime()) return { ok: false, reason: "submittedAt is in the future." };
  return { ok: true, at };
}

/** The labelled one-line fields, in the order they appear in the composed description. */
const LABELLED = [
  ["aircraft", "Aircraft"],
  ["airline", "Airline"],
  ["registration", "Registration"],
  ["location", "Location"],
  ["airportCode", "Airport"],
  ["capturedOn", "Captured on"],
] as const;

export const TITLE_MAX = 160;
export const FACTUAL_SOURCE_MAX = 600;
export const RIGHTS_EVIDENCE_MAX = 2400;

/**
 * D1 allowed internal newlines in `title` and `factualSource`; rather than refuse the photo, every whitespace run (newlines and
 * tabs included) becomes one space and the ends are trimmed. Another control character still refuses. null = empty after collapsing.
 */
function collapseLine(raw: string): { ok: true; value: string | null } | { ok: false } {
  const value = raw.replace(/\s+/gu, " ").trim();
  if (CONTROL.test(value)) return { ok: false };
  return { ok: true, value: value === "" ? null : value };
}

/**
 * `rightsEvidence` is kept verbatim (CRLF to LF, trimmed) in the audit detail, NOT in the description (it may exceed its cap).
 * `\n` and `\t` are allowed; any other control character refuses (NUL cannot be stored in JSONB anyway). Empty = absent (null).
 */
export function normaliseRightsEvidence(raw: string | undefined): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, value: null };
  const unified = raw.replace(/\r\n/g, "\n");
  if (/[^\P{Cc}\n\t]/u.test(unified)) return { ok: false, reason: "rightsEvidence holds a control character other than a newline or tab." };
  const text = unified.trim();
  if (codePoints(text) > RIGHTS_EVIDENCE_MAX) return { ok: false, reason: `rightsEvidence is over ${RIGHTS_EVIDENCE_MAX} characters.` };
  return { ok: true, value: text === "" ? null : text };
}

type ComposeResult = { ok: true; value: string | null } | { ok: false; code: "bad_description" | "bad_title" | "bad_factual_source"; reason: string };

/**
 * The stored description of an imported photo: the free description (if any), then, after one blank line, one labelled line per
 * present field: "Title: …", "Aircraft: …", "Airline: …", "Registration: …", "Location: …", "Airport: …", "Captured on: …",
 * "Facts source: …" (title first, facts source last). A labelled value is one line: a control character (a newline included)
 * refuses it, except `title` and `factualSource`, whose whitespace runs are collapsed to one space (max 160 / 600 code points after
 * collapsing, else refused). A value that is only whitespace counts as absent. The free description may hold newlines. The whole text
 * goes through `normaliseMediaDescription` (1-2000 code points, `\n` the only control character); anything else is refused, never
 * truncated or stripped. `value: null` = nothing to store.
 */
export function composeImportDescription(entry: ImportEntry): ComposeResult {
  const lines: string[] = [];
  if (entry.title !== undefined) {
    const title = collapseLine(entry.title);
    if (!title.ok) return { ok: false, code: "bad_title", reason: "title holds a control character." };
    if (title.value !== null) {
      if (codePoints(title.value) > TITLE_MAX) return { ok: false, code: "bad_title", reason: `title is over ${TITLE_MAX} characters.` };
      lines.push(`Title: ${title.value}`);
    }
  }
  for (const [key, label] of LABELLED) {
    const raw = entry[key];
    if (raw === undefined || raw.trim() === "") continue;
    if (CONTROL.test(raw)) return { ok: false, code: "bad_description", reason: `${key} holds a control character (labelled fields must be one line).` };
    lines.push(`${label}: ${raw.trim()}`);
  }
  if (entry.factualSource !== undefined) {
    const source = collapseLine(entry.factualSource);
    if (!source.ok) return { ok: false, code: "bad_factual_source", reason: "factualSource holds a control character." };
    if (source.value !== null) {
      if (codePoints(source.value) > FACTUAL_SOURCE_MAX) {
        return { ok: false, code: "bad_factual_source", reason: `factualSource is over ${FACTUAL_SOURCE_MAX} characters.` };
      }
      lines.push(`Facts source: ${source.value}`);
    }
  }
  // A control character other than a newline is refused wherever it is, even at an edge that trimming would remove.
  if (entry.description !== undefined && /[^\P{Cc}\n]/u.test(entry.description.replace(/\r\n/g, "\n"))) {
    return { ok: false, code: "bad_description", reason: "the description holds a control character other than a newline." };
  }
  const free = entry.description !== undefined && entry.description.trim() !== "" ? entry.description.trim() : undefined;
  const parts: string[] = [];
  if (free !== undefined) parts.push(free);
  if (lines.length > 0) parts.push(lines.join("\n"));
  if (parts.length === 0) return { ok: true, value: null };
  const normalised = normaliseMediaDescription(parts.join("\n\n"));
  if (normalised === null) return { ok: false, code: "bad_description", reason: "the description has a control character other than a newline, or is over 2000 characters." };
  return { ok: true, value: normalised };
}

// ---- report ----

export type EntryStatus = "imported" | "would_import" | "already_imported" | "refused" | "failed";

export type RefusalCode =
  | "rejected"
  | "conflict"
  | "wrong_project"
  | "demo_account"
  | "no_photographer_role"
  | "bad_path"
  | "file_missing"
  | "too_large"
  | "sha_mismatch"
  | "content_type_mismatch"
  | "not_an_image"
  | "bad_submitted_at"
  | "bad_description"
  | "bad_credit"
  | "bad_title"
  | "bad_factual_source"
  | "bad_rights_evidence"
  | "storage";

export type EntryReport = { sourceId: string; status: EntryStatus; code?: RefusalCode | "unexpected"; detail?: string; mediaId?: string };

export type ImportReport = {
  mode: "dry-run" | "apply";
  entries: EntryReport[];
  counts: Record<EntryStatus, number>;
};

/**
 * Exit code of a finished run: 0 nothing wrong (imported, would import or already imported); 3 some entries refused and none
 * imported; 4 partial success (something imported, something refused or failed); 1 entries failed unexpectedly and none imported.
 * (2 is the CLI's own: bad arguments, settings or manifest.)
 */
export function exitCodeOf(report: ImportReport): 0 | 1 | 3 | 4 {
  const { imported, refused, failed } = report.counts;
  if (refused === 0 && failed === 0) return 0;
  if (imported > 0) return 4;
  return failed > 0 ? 1 : 3;
}

/** Why `--yes` must not run with this configuration (null = fine). A memory store is per process, so a CLI write would be lost. */
export function applyRefusal(config: Pick<AppConfig, "blobStore">): string | null {
  return config.blobStore === "bunny"
    ? null
    : `--yes needs BLOB_STORE=bunny (this run has "${config.blobStore}"): the images must go to the real store, and a memory store is lost when the command ends.`;
}

// ---- the run ----

export type ImportContext = {
  database: DatabaseService;
  blobs: BlobStore;
  config: AppConfig;
  /** The OS user running the command; audit actor and created_by become `operator:<operator>`. */
  operator: string;
  /** Test seam; defaults to the process clock. */
  now?: () => Date;
};

type Refusal = { ok: false; code: RefusalCode; detail: string };
type Prepared = {
  ok: true;
  bytes: Uint8Array;
  image: CheckedImage;
  submittedAt: Date;
  description: string | null;
  credit: string | null;
  rightsEvidence: string | null;
};

class ClaimLost extends ExpectedRollback {}

const refuse = (code: RefusalCode, detail: string): Refusal => ({ ok: false, code, detail });
const DEMO_OWNER_DETAIL = "the owner is the shared demo account, which cannot own imported photos (it never holds the photographer role).";
const operatorName = (operator: string): string => `operator:${operator}`.slice(0, 256);

/**
 * Whether the account has an ACTIVE `photographer` role, or an ACTIVE `admin` one: the API's `holds()` (src/auth/roles.ts,
 * ADR-0002 decision 3) treats admin as holding photographer, and this check follows it. A revoked, blocked, pending or rejected row
 * does not count. The email-verified condition of the API cannot apply here: there is no token.
 */
async function holdsPhotographer(db: Pick<Database, "select">, principal: string): Promise<boolean> {
  const rows = await db
    .select({ role: accountRoles.role })
    .from(accountRoles)
    .where(and(eq(accountRoles.principal, principal), eq(accountRoles.state, "active"), inArray(accountRoles.role, ["photographer", "admin"])))
    .limit(1)
    // FOR SHARE: inside the entry's transaction this waits for a concurrent revoke or block of the row and then sees its result.
    .for("share");
  return rows.length > 0;
}

async function findClaim(db: Pick<Database, "select">, sourceId: string) {
  const [row] = await db
    .select()
    .from(mediaImports)
    .where(and(eq(mediaImports.sourceSystem, SOURCE_SYSTEM), eq(mediaImports.sourceId, sourceId)))
    .limit(1);
  return row;
}

/** Same owner and sha256 = already imported; anything else is a conflict. */
function classifyClaim(claim: NonNullable<Awaited<ReturnType<typeof findClaim>>>, owner: string, sha256: string): { same: boolean; mediaId: string } {
  return { same: claim.owner === owner && claim.sha256 === sha256, mediaId: mediaIdOf(claim.mediaId) };
}

function describeFailure(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  // Safe fields only (never a stack, URL or config), as scripts/roles-grant.mjs does.
  const name = error instanceof Error ? error.constructor.name : "Error";
  const code = error !== null && typeof error === "object" && "code" in error && (typeof error.code === "string" || typeof error.code === "number") ? ` code ${error.code}` : "";
  return `Unexpected ${name}${code}.`;
}

/**
 * Check one entry against the bundle files, the configured project and the database, without writing anything. Order: the
 * rejected status; an existing claim for the sourceId (re-runs answer "already imported" before anything else); the owner; the
 * photographer role; the cheap value checks; then the file (path, symlink, size, digest, type, image).
 */
async function prepare(entry: ImportEntry, dir: string, ctx: ImportContext, service: MediaService): Promise<Refusal | Prepared | { ok: "already"; mediaId: string }> {
  if (entry.status === "rejected") return refuse("rejected", "D1 status is rejected; rejected proposals are not imported.");
  const claim = await findClaim(ctx.database.db, entry.sourceId);
  if (claim) {
    const c = classifyClaim(claim, entry.owner, entry.sha256);
    return c.same
      ? { ok: "already", mediaId: c.mediaId }
      : refuse("conflict", `sourceId is already imported as ${c.mediaId} with a different owner or file; nothing was changed.`);
  }
  if (uidOfAccountPrincipal(entry.owner, ctx.config.firebaseProjectId) === undefined) {
    return refuse("wrong_project", `owner is not firebase:${ctx.config.firebaseProjectId}:<uid> (another project, or not a principal).`);
  }
  if (isDemoPrincipal(ctx.config, entry.owner)) return refuse("demo_account", DEMO_OWNER_DETAIL);
  if (!(await holdsPhotographer(ctx.database.db, entry.owner))) {
    return refuse("no_photographer_role", "the owner has no active photographer role (revoked, blocked, pending, rejected or no row).");
  }
  const submitted = parseSubmittedAt(entry.submittedAt, (ctx.now ?? (() => new Date()))());
  if (!submitted.ok) return refuse("bad_submitted_at", submitted.reason);
  const description = composeImportDescription(entry);
  if (!description.ok) return refuse(description.code, description.reason);
  const evidence = normaliseRightsEvidence(entry.rightsEvidence);
  if (!evidence.ok) return refuse("bad_rights_evidence", evidence.reason);
  // A credit that is empty after trimming counts as absent (like the labelled fields); otherwise it must be a clean one-liner.
  const credit = entry.credit === undefined || entry.credit.trim() === "" ? null : entry.credit;
  if (credit !== null && (credit.trim() !== credit || CONTROL.test(credit) || codePoints(credit) > CREDIT_MAX)) {
    return refuse("bad_credit", `credit must be 1-${CREDIT_MAX} characters on one line without surrounding whitespace.`);
  }
  if (!isBareFilename(entry.file)) return refuse("bad_path", "file must be a bare filename inside the bundle.");
  const read = await readRegularFile(path.join(dir, entry.file), MAX_MEDIA_BYTES);
  if (!read.ok) return refuse(read.code, read.detail);
  const bytes = read.bytes;
  let image: CheckedImage;
  try {
    image = service.checkImage(bytes, entry.contentType);
  } catch (error) {
    if (error instanceof ApiError) return refuse(/^The bytes are a /.test(error.message) ? "content_type_mismatch" : "not_an_image", error.message);
    throw error;
  }
  if (image.sha256 !== entry.sha256) return refuse("sha_mismatch", "the file's sha256 differs from the manifest's.");
  return { ok: true, bytes, image, submittedAt: submitted.at, description: description.value, credit, rightsEvidence: evidence.value };
}

/** Write one prepared entry: blob first (read back), then one transaction. Returns the media id, or a report for a lost race. */
async function writeEntry(entry: ImportEntry, prepared: Prepared, ctx: ImportContext, service: MediaService): Promise<EntryReport> {
  await service.storeImage(prepared.bytes, prepared.image);
  const by = operatorName(ctx.operator);
  const { image } = prepared;
  try {
    const outcome = await ctx.database.withTransaction(async (tx: Tx): Promise<{ mediaId: number } | Refusal> => {
      // Re-checked in the transaction: a role revoked since the plan check must not receive an item.
      if (isDemoPrincipal(ctx.config, entry.owner)) return refuse("demo_account", DEMO_OWNER_DETAIL);
      if (!(await holdsPhotographer(tx, entry.owner))) return refuse("no_photographer_role", "the owner has no active photographer role.");
      const now = await databaseNow(tx);
      const [item] = await tx
        .insert(mediaItems)
        .values({ owner: entry.owner, state: "unverified", draftVersion: 1, publishedVersion: null, createdBy: by, updatedBy: by, createdAt: now, updatedAt: now })
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
        creditName: prepared.credit,
        creditRequired: true,
        // No licence: the D1 consent covered private editorial review only.
        licenceName: null,
        description: prepared.description,
        rightsStatement: "d1_private_review",
        rightsStatedBy: entry.owner,
        rightsStatedAt: prepared.submittedAt,
        createdBy: by,
        createdAt: now,
      });
      const won = await tx
        .insert(mediaImports)
        .values({ sourceSystem: SOURCE_SYSTEM, sourceId: entry.sourceId, mediaId: item.id, owner: entry.owner, sha256: image.sha256, importedAt: now })
        .onConflictDoNothing()
        .returning({ mediaId: mediaImports.mediaId });
      if (won.length !== 1) throw new ClaimLost(); // another run claimed it first: roll the item back
      await tx.insert(adminAudit).values({
        actor: by,
        action: "media_import",
        target: mediaIdOf(item.id),
        detail: {
          sourceId: entry.sourceId,
          owner: entry.owner,
          status: entry.status,
          rightsBasis: entry.rightsBasis,
          submittedAt: prepared.submittedAt.toISOString(),
          mediaId: mediaIdOf(item.id),
          ...(prepared.rightsEvidence !== null ? { rightsEvidence: prepared.rightsEvidence } : {}),
          note: `Imported D1 proposal: submitted for private editorial review only; no publishing licence granted (rightsBasis: ${entry.rightsBasis}).`,
        },
        createdAt: now,
      });
      return { mediaId: item.id };
    });
    if ("ok" in outcome) return { sourceId: entry.sourceId, status: "refused", code: outcome.code, detail: outcome.detail };
    return { sourceId: entry.sourceId, status: "imported", mediaId: mediaIdOf(outcome.mediaId) };
  } catch (error) {
    if (!(error instanceof ClaimLost)) throw error;
    const claim = await findClaim(ctx.database.db, entry.sourceId);
    if (!claim) throw new Error("Import claim vanished after a lost race.");
    const c = classifyClaim(claim, entry.owner, image.sha256);
    return c.same
      ? { sourceId: entry.sourceId, status: "already_imported", mediaId: c.mediaId }
      : { sourceId: entry.sourceId, status: "refused", code: "conflict", detail: `sourceId was imported meanwhile as ${c.mediaId} with a different owner or file.` };
  }
}

/**
 * Run a manifest. `dry-run` reads (database, bundle files) and never writes a row, a blob or an audit entry; `apply` imports each
 * entry that passes, in manifest order, one transaction each. An entry that fails unexpectedly is reported `failed` and the run
 * goes on; entries never affect each other.
 */
export async function runMediaImport(dir: string, manifest: ImportManifest, mode: "dry-run" | "apply", ctx: ImportContext): Promise<ImportReport> {
  const service = new MediaService(ctx.database, ctx.blobs, ctx.config);
  const entries: EntryReport[] = [];
  for (const entry of manifest.entries) {
    const sourceId = entry.sourceId;
    try {
      const prepared = await prepare(entry, dir, ctx, service);
      if (prepared.ok === "already") entries.push({ sourceId, status: "already_imported", mediaId: prepared.mediaId });
      else if (!prepared.ok) entries.push({ sourceId, status: "refused", code: prepared.code, detail: prepared.detail });
      else if (mode === "dry-run") entries.push({ sourceId, status: "would_import" });
      else entries.push(await writeEntry(entry, prepared, ctx, service));
    } catch (error) {
      const storage = error instanceof ApiError && error.status === 503;
      entries.push({ sourceId, status: "failed", code: storage ? "storage" : "unexpected", detail: describeFailure(error) });
    }
  }
  const counts: Record<EntryStatus, number> = { imported: 0, would_import: 0, already_imported: 0, refused: 0, failed: 0 };
  for (const e of entries) counts[e.status] += 1;
  return { mode, entries, counts };
}
