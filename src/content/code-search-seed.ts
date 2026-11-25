import { devDatabaseRefusal } from "../config/dev-database.js";
import type { AppConfig } from "../config/config.module.js";
import { ApiError } from "../common/errors.js";
import type { DatabaseService } from "../database/database.module.js";
import { RANKS } from "../rules/ranks.js";
import type { Rank } from "../rules/ranks.js";
import { rankDisplayName } from "../rules/catalog.js";
import { checkRankTable, rankFromUnityName } from "../rules/code-search-ladder.js";
import type { BlobStore } from "../storage/blob-store.js";
import { ContentService } from "./content.service.js";
import type { DryRunResult } from "./content.service.js";
import { acquireRunLock, exitCodeOf } from "./demo-seed.js";
import type { LineStatus, ReportLine, RunLock, SeedReport } from "./demo-seed.js";
import { ContentDocumentsService } from "./documents/content-documents.service.js";
import { checkBoardFit, checkBoardPayload, rankOfBoardId } from "./grid-boards.js";
import { codeSearchMapping, targetsCell, CODE_SEARCH_CLIENT_HEADER } from "./modules/code-search.js";
import { operatorName, readRegularFile } from "./media/media-import.js";
import { writeSheet } from "./xlsx.js";
import type pg from "pg";

/**
 * The dev Code Search seed (docs/plans/code-search.md section 4 and G): load the client's master pack (Unity's
 * `code_search_master.json`, schemaVersion 2) into a DEV backend through the same write path the Admin uses. The pack is turned into
 * the client sheet (`Game ID | Level | Letters | Targets`), planned with `ContentService.dryRun` and applied with the plan's hash.
 * It never overwrites or retires stored content: any update or retirement is refused with the counts. This file is the testable
 * core; `scripts/demo-seed-code-search.mjs` is the shell around it.
 */

export { exitCodeOf };
export type { ReportLine, SeedReport };

/** The pack file cap. The real pack is about 3 MB. */
export const MAX_PACK_BYTES = 16 * 1024 * 1024;
const MAX_CELL_CHARS = 32_000;
export const MAX_LISTED = 20;
const MODULE = "code-search";

// ---- refusals before anything is contacted ----

export type CodeSearchSeedConfig = Pick<AppConfig, "appEnv" | "blobStore">;

/**
 * Why the seed must not run with this configuration and database (null = fine). Pure; the CLI exits 2 on any answer BEFORE
 * connecting. A `demo-` Firebase project and a memory blob store are allowed for a dry run (no principals, no photos); `--yes`
 * needs a blob store that outlives the command (the import receipt stores the generated sheet).
 */
export function codeSearchSeedRefusal(config: CodeSearchSeedConfig, dbName: string | null | undefined, args: { yes: boolean }): string | null {
  const production = config.appEnv === "production";
  const database = devDatabaseRefusal(dbName, production);
  if (database === "no-database") return "DATABASE_URL names no database; the seed needs to know which one it writes to.";
  if (database === "prod") return `The database "${dbName}" is a production database (name ends _prod); the seed never runs against it.`;
  if (database === "not-dev") return `APP_ENV=production runs the seed only against a database whose name ends _dev; this one is "${dbName}".`;
  if (args.yes && config.blobStore === "none") return "--yes needs a blob store (BLOB_STORE=none here): the import receipt stores the generated sheet.";
  if (args.yes && production && config.blobStore !== "bunny") {
    return `--yes under APP_ENV=production needs BLOB_STORE=bunny (this run has "${config.blobStore}"): the receipt's file must outlive the command.`;
  }
  return null;
}

// ---- the pack ----

export type PackRecord = { id: string; rank: string; letters: string; targets: unknown[] };
export type CodeSearchPack = {
  schemaVersion: 2;
  packId: string;
  contentVersion: string;
  moduleId: "code-search";
  reviewState: "client-supplied";
  sourceSha256: string;
  ranks: unknown;
  records: PackRecord[];
};

const RECORD_KEYS = ["id", "rank", "letters", "targets"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The rank a pack record's Unity enum name (`FirstOfficer`) names, or undefined (the ladder's own mapping). */
export const rankOfUnityName = rankFromUnityName;

/** Every problem with a parsed pack (empty = usable). Pure. */
export function checkCodeSearchPack(json: unknown): string[] {
  if (!isRecord(json)) return ["The pack must be a JSON object."];
  const problems: string[] = [];
  if (json["schemaVersion"] !== 2) problems.push(`schemaVersion must be 2; got ${JSON.stringify(json["schemaVersion"])}.`);
  if (json["moduleId"] !== MODULE) problems.push(`moduleId must be "${MODULE}".`);
  if (json["reviewState"] !== "client-supplied") problems.push('reviewState must be "client-supplied".');
  if (typeof json["sourceSha256"] !== "string" || !/^[0-9a-f]{64}$/.test(json["sourceSha256"])) problems.push("sourceSha256 must be 64 lower-case hex characters.");
  for (const key of ["packId", "contentVersion"] as const) {
    if (typeof json[key] !== "string" || (json[key] as string).trim() === "") problems.push(`${key} must be a non-blank string.`);
  }
  problems.push(...checkRankTable(json["ranks"]));
  const records = json["records"];
  if (!Array.isArray(records)) {
    problems.push("records must be a list.");
    return problems;
  }
  const seen = new Set<string>();
  records.forEach((raw: unknown, index) => {
    const where = isRecord(raw) && typeof raw["id"] === "string" ? raw["id"] : `record ${index}`;
    if (!isRecord(raw)) {
      problems.push(`${where} must be an object.`);
      return;
    }
    const extra = Object.keys(raw).filter((key) => !RECORD_KEYS.includes(key));
    if (extra.length > 0) problems.push(`${where} has an unknown key '${extra[0]}'.`);
    const id = raw["id"];
    if (typeof id !== "string") {
      problems.push(`${where} has no string id.`);
      return;
    }
    if (seen.has(id)) problems.push(`${id} is listed twice.`);
    seen.add(id);
    const rank = rankOfUnityName(raw["rank"]);
    if (!rank) {
      problems.push(`${id} has an unknown rank ${JSON.stringify(raw["rank"])}.`);
      return;
    }
    const data = { letters: raw["letters"], targets: raw["targets"] };
    const found = [...new Set([...checkBoardPayload(data), ...checkBoardFit(id, rank, data)])];
    for (const message of found) problems.push(`${id}: ${message}`);
    if (found.length === 0 && targetsCell(raw["targets"]).length > MAX_CELL_CHARS) problems.push(`${id}: the Targets cell would be longer than ${MAX_CELL_CHARS} characters.`);
  });
  return problems;
}

/** Read and check the pack file. An error means exit 2 before any connection. */
export async function loadCodeSearchPack(file: string): Promise<{ ok: true; pack: CodeSearchPack } | { ok: false; errors: string[] }> {
  const read = await readRegularFile(file, MAX_PACK_BYTES);
  if (!read.ok) return { ok: false, errors: [`${file}: ${read.detail}`] };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(read.bytes).toString("utf8"));
  } catch {
    return { ok: false, errors: [`${file} is not valid JSON.`] };
  }
  const problems = checkCodeSearchPack(json);
  if (problems.length > 0) return { ok: false, errors: problems };
  return { ok: true, pack: json as CodeSearchPack };
}

/** The client-sheet rows (header, then one row per record) the importer reads. The pack must have passed `checkCodeSearchPack`. */
export function packToSheetRows(pack: Pick<CodeSearchPack, "records">): string[][] {
  const rows: string[][] = [[...CODE_SEARCH_CLIENT_HEADER]];
  for (const record of pack.records) {
    const rank = rankOfUnityName(record.rank);
    if (!rank) throw new Error(`Unknown pack rank ${record.rank}.`);
    rows.push([record.id, rankDisplayName(rank), record.letters, targetsCell(record.targets)]);
  }
  return rows;
}

/** `code-search-<contentVersion>-<first 12 of sourceSha256>.xlsx`, recorded on the import receipt. */
export function sheetFileName(pack: Pick<CodeSearchPack, "contentVersion" | "sourceSha256">): string {
  const version = pack.contentVersion.replace(/[^A-Za-z0-9._-]/g, "_");
  return `code-search-${version}-${pack.sourceSha256.slice(0, 12)}.xlsx`;
}

// ---- the run ----

export type CodeSearchSeedContext = {
  database: DatabaseService;
  blobs: BlobStore;
  /** The OS user running the command; the write is by `operator:<operator>`. */
  operator: string;
  /** The pool behind `database`; apply mode holds one connection of it for the run lock. */
  pool?: pg.Pool;
};

function finish(mode: SeedReport["mode"], lines: ReportLine[]): SeedReport {
  const counts: Record<LineStatus, number> = { done: 0, would: 0, unchanged: 0, waiting: 0, note: 0, refused: 0, failed: 0 };
  for (const line of lines) counts[line.status] += 1;
  return { mode, lines, counts };
}

function describeApiError(error: ApiError): string {
  const report = error.extra["report"];
  if (!Array.isArray(report)) return error.message;
  const shown = report.slice(0, 5).map((r: { row?: number; message?: string }) => `row ${r.row ?? "?"}: ${r.message ?? ""}`);
  return `${error.message} ${shown.join(" | ")}${report.length > 5 ? ` | ... ${report.length - 5} more` : ""}`;
}

function failureLine(subject: string, error: unknown): ReportLine {
  if (error instanceof ApiError && error.status < 500) return { section: "content", subject, status: "refused", detail: describeApiError(error) };
  const name = error instanceof Error ? error.constructor.name : "Error";
  const code = error !== null && typeof error === "object" && "code" in error && (typeof error.code === "string" || typeof error.code === "number") ? ` code ${error.code}` : "";
  return { section: "content", subject, status: "failed", detail: `Unexpected ${name}${code}.` };
}

/** Boards per rank in a plan, by action, from the ids' prefixes. */
function perRank(dry: DryRunResult): { rank: Rank; create: number; unchanged: number; update: number }[] {
  return RANKS.map((rank) => {
    const mine = dry.rows.filter((r) => rankOfBoardId(r.id) === rank);
    return {
      rank,
      create: mine.filter((r) => r.action === "create").length,
      unchanged: mine.filter((r) => r.action === "unchanged").length,
      update: mine.filter((r) => r.action === "update").length,
    };
  });
}

/**
 * Run the seed. `dry-run` reads the database and writes nothing (no row, blob, audit or receipt). `apply` runs under the run lock and
 * applies only a plan that creates boards and nothing else: a replay, an all-unchanged plan (no receipt, no audit row), an update
 * or a retirement is not applied (the last is refused, exit 3). Never relies on byte replay: the generated zip is not byte-stable.
 */
export async function runCodeSearchSeed(pack: CodeSearchPack, mode: "dry-run" | "apply", ctx: CodeSearchSeedContext): Promise<SeedReport> {
  const lines: ReportLine[] = [];
  const push = (line: ReportLine) => void lines.push(line);
  let lock: RunLock | undefined;
  if (mode === "apply") {
    if (!ctx.pool) throw new Error("An apply run needs the pool for its run lock.");
    lock = await acquireRunLock(ctx.pool);
    if (!lock) {
      push({ section: "run", subject: "run lock", status: "refused", detail: "another seed run holds the run lock; nothing was written." });
      return finish(mode, lines);
    }
  }
  try {
    await steps(pack, mode, ctx, push);
  } finally {
    await lock?.release();
  }
  return finish(mode, lines);
}

async function steps(pack: CodeSearchPack, mode: "dry-run" | "apply", ctx: CodeSearchSeedContext, push: (line: ReportLine) => void): Promise<void> {
  const content = new ContentService(ctx.database, ctx.blobs, new ContentDocumentsService(ctx.database));
  const bytes = await writeSheet(packToSheetRows(pack));
  const fileName = sheetFileName(pack);
  let dry;
  try {
    dry = await content.dryRun(codeSearchMapping, bytes);
  } catch (error) {
    push(failureLine(MODULE, error));
    return;
  }
  if (dry.replay) {
    push({ section: "content", subject: MODULE, status: "unchanged", detail: `same file as the last import (${dry.import.id}); nothing to do` });
    return;
  }
  for (const w of dry.warnings.filter((issue) => issue.level === "warning").slice(0, 60)) {
    push({ section: "content", subject: `${MODULE} row ${w.row}`, status: "note", detail: w.message });
  }
  for (const r of perRank(dry)) {
    push({ section: "content", subject: `${MODULE} ${rankDisplayName(r.rank)}`, status: "note", detail: `${r.create} to create, ${r.unchanged} already stored${r.update > 0 ? `, ${r.update} to update` : ""}` });
  }
  const { created, updated, unchanged, retired } = dry.counts;
  if (updated > 0 || retired > 0) {
    const changed = dry.rows.filter((r) => r.action === "update").map((r) => `${r.id} (${(r.diff ?? []).map((d) => d.field).join(", ") || "changed"})`);
    const retiring = dry.retirements.map((r) => `${r.id} (retire)`);
    const all = [...changed, ...retiring];
    push({
      section: "content",
      subject: MODULE,
      status: "refused",
      detail: `the pack differs from stored content (${updated} to update, ${retired} to retire): ${all.slice(0, MAX_LISTED).join("; ")}${all.length > MAX_LISTED ? `; ... ${all.length - MAX_LISTED} more` : ""}. The seed never overwrites stored content; import it in the Admin.`,
    });
    return;
  }
  if (created === 0) {
    push({ section: "content", subject: MODULE, status: "unchanged", detail: `${unchanged} boards already stored as in the pack` });
    return;
  }
  if (mode === "dry-run") {
    push({ section: "content", subject: MODULE, status: "would", detail: `would create ${created} boards (${unchanged} already stored)` });
    return;
  }
  try {
    const applied = await content.apply(codeSearchMapping, bytes, fileName, operatorName(ctx.operator), dry.planHash);
    const counts = applied.import;
    push({ section: "content", subject: MODULE, status: applied.replayed ? "unchanged" : "done", detail: `created ${counts.created} boards, unchanged ${counts.unchanged} (import ${counts.id})` });
  } catch (error) {
    push(failureLine(MODULE, error));
  }
}
