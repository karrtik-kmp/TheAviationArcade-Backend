import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { ApiError } from "../common/errors.js";
import { DatabaseService } from "../database/database.module.js";
import type { Tx } from "../database/database.module.js";
import { adminAudit, contentImports, contentItems } from "../db/schema.js";
import type { ContentImportRow } from "../db/schema.js";
import { isRank } from "../rules/ranks.js";
import { BLOB_STORE, StorageRequestError, StorageUnavailableError } from "../storage/blob-store.js";
import type { BlobStore } from "../storage/blob-store.js";
import type { ContentModuleMapping, ImportIssue, ParsedSheet, StoredItem } from "./content-module.js";
import { compareIds } from "./content-modules.js";
import { planHash, planImport } from "./import-plan.js";
import { CONTENT_STATUSES, type ContentStatus } from "../db/enums.js";
import type { ExistingItem, FieldDiff, ImportPlan } from "./import-plan.js";
import { SpreadsheetError, XLSX_MIME, readFirstSheet, writeSheet } from "./xlsx.js";

const BATCH = 500;
const PLAN_CHANGED_MESSAGE =
  "Stored content changed since the dry run, so the confirmed plan no longer applies. Run a new dry run and review it. Nothing was imported.";

function isStatus(value: string): value is ContentStatus {
  return (CONTENT_STATUSES as readonly string[]).includes(value);
}

export type ImportSummary = {
  id: string;
  module: string;
  fileName: string;
  sha256: string;
  byteSize: number;
  created: number;
  updated: number;
  unchanged: number;
  retired: number;
  createdAt: string;
};

/** A dry run of bytes that a real import would replay (the module's latest import): no plan, just the receipt. */
export type DryRunReplay = { dryRun: true; replay: true; import: ImportSummary };

export type DryRunResult = {
  dryRun: true;
  /** False: a real import of these bytes would be planned and applied, not replayed. */
  replay: false;
  /** client_sheet (no Id column, authoritative) or admin_export (Id column, never retires). */
  kind: ImportPlan["kind"];
  counts: ImportPlan["counts"];
  /** Present this as ?confirm= when applying a plan that has requiresConfirm. */
  planHash: string;
  requiresConfirm: boolean;
  rows: { row: number; id: string; action: "create" | "update" | "unchanged"; diff?: FieldDiff[] }[];
  /** Stored items the apply would retire (client sheets only). */
  retirements: { id: string; naturalKey: string }[];
  warnings: ImportIssue[];
};

export type ApplyResult =
  | { replayed: true; import: ImportSummary }
  | { replayed: false; import: ImportSummary; warnings: ImportIssue[] };

export type ItemView = {
  id: string;
  rank: string;
  status: string;
  source: string;
  version: number;
  data: unknown;
  updatedAt: string;
};

function summary(row: ContentImportRow): ImportSummary {
  return {
    id: row.id,
    module: row.module,
    fileName: row.fileName,
    sha256: row.sha256,
    byteSize: row.byteSize,
    created: row.created,
    updated: row.updated,
    unchanged: row.unchanged,
    retired: row.retired,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Admin content: import a staff xlsx into content_items, list items, export them again. */
@Injectable()
export class ContentService {
  private readonly logger = new Logger("Content");

  constructor(
    private readonly database: DatabaseService,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
  ) {}

  /**
   * Validate and plan without writing or storing anything. Same 400/422 outcomes as a real import, and
   * `replay: true` (receipt only) when a real import of these bytes would replay.
   */
  async dryRun(mapping: ContentModuleMapping, bytes: Uint8Array): Promise<DryRunResult | DryRunReplay> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const latest = await this.latestImport(mapping.module);
    if (latest?.sha256 === sha256) return { dryRun: true, replay: true, import: summary(latest) };
    const parsed = await this.parse(mapping, bytes);
    const { plan, warnings } = this.check(mapping, parsed, await this.loadExisting(mapping.module));
    return {
      dryRun: true,
      replay: false,
      kind: plan.kind,
      counts: plan.counts,
      planHash: planHash(plan),
      requiresConfirm: plan.requiresConfirm,
      rows: plan.rows.map(({ row, id, action, diff }) => ({ row, id, action, ...(diff ? { diff } : {}) })),
      retirements: plan.retirements.map(({ id, naturalKey }) => ({ id, naturalKey })),
      warnings,
    };
  }

  /**
   * Apply an import. Identical bytes replay the earlier result (no writes) only while that receipt is the
   * module's LATEST import; once a later import exists the same bytes are planned like any other file (an
   * old export then conflicts on stale versions instead of silently "succeeding"), and a successful apply
   * refreshes the existing receipt (the (module, sha256) pair is unique) so it is the latest again. Otherwise
   * the original file is stored first (content-addressed by sha256, so an orphan after a failed commit is
   * harmless), then one transaction under a per-module advisory lock re-plans against the rows as they are
   * now and writes the import receipt, the items and the audit row together.
   *
   * A client-sheet import that would update or retire stored content must carry `confirm` = the planHash of
   * a dry run; it is compared against the re-plan under the lock, so data that changed since the dry run is
   * 409 plan_changed and nothing is written. Creates-only imports and admin-export imports need no confirm.
   */
  async apply(
    mapping: ContentModuleMapping,
    bytes: Uint8Array,
    fileName: string,
    principal: string,
    now: Date,
    confirm?: string,
  ): Promise<ApplyResult> {
    const module = mapping.module;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const latest = await this.latestImport(module);
    if (latest?.sha256 === sha256) return { replayed: true, import: summary(latest) };

    const parsed = await this.parse(mapping, bytes);
    const early = this.check(mapping, parsed, await this.loadExisting(module));
    this.assertConfirmed(early.plan, confirm); // fail before storing anything
    const warnings = early.warnings;
    const blobKey = `imports/${module}/${sha256}.xlsx`;
    try {
      await this.blobs.put(blobKey, bytes, XLSX_MIME);
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw new ApiError(503, "storage_unavailable", "File storage is unavailable. Retry shortly.", { "Retry-After": "5" });
      }
      if (error instanceof StorageRequestError) {
        // Refused for a reason a retry will not fix (e.g. bad credentials): our configuration, not the caller's. Status only in the log.
        this.logger.error(`file storage refused the import upload (status ${error.status})`);
        throw new ApiError(503, "storage_unavailable", "File storage is unavailable.");
      }
      throw error;
    }

    return this.database.withTransaction(async (tx): Promise<ApplyResult> => {
      // Serialises imports per module, so two uploads can never plan against the same stale rows. Try, never
      // wait: a waiting import would hold a pooled connection, so a busy module is a retryable 409 instead.
      const lock = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`content-import:${module}`}, 0)) AS locked`,
      );
      if (lock.rows[0]?.locked !== true) {
        throw new ApiError(409, "import_in_progress", "Another import for this module is running. Retry shortly.", { "Retry-After": "2" });
      }
      const raced = await this.latestImport(module, tx);
      if (raced?.sha256 === sha256) return { replayed: true, import: summary(raced) };

      // Plan again against the locked, current rows: never overwrite a version that changed since the first look.
      const current = await this.loadExisting(module, tx);
      const { plan: locked } = this.check(mapping, parsed, current);
      this.assertConfirmed(locked, confirm);
      const candidateId = randomUUID();
      const [receipt] = await tx
        .insert(contentImports)
        .values({
          id: candidateId,
          module,
          fileName,
          sha256,
          byteSize: bytes.length,
          blobKey,
          created: locked.counts.created,
          updated: locked.counts.updated,
          unchanged: locked.counts.unchanged,
          retired: locked.counts.retired,
          importedBy: principal,
          createdAt: now,
        })
        // Same bytes imported before but no longer the latest: this run refreshes that receipt.
        .onConflictDoUpdate({
          target: [contentImports.module, contentImports.sha256],
          set: {
            fileName,
            byteSize: bytes.length,
            blobKey,
            created: locked.counts.created,
            updated: locked.counts.updated,
            unchanged: locked.counts.unchanged,
            retired: locked.counts.retired,
            importedBy: principal,
            createdAt: now,
          },
        })
        .returning();
      if (!receipt) throw new Error("Import receipt was not stored.");
      const importId = receipt.id; // the existing receipt's id when the same bytes were imported before

      const creates = locked.rows.filter((r) => r.action === "create");
      for (let start = 0; start < creates.length; start += BATCH) {
        await tx.insert(contentItems).values(
          creates.slice(start, start + BATCH).map((r) => ({
            module,
            id: r.id,
            rank: r.rank,
            status: "approved" as const,
            source: locked.source,
            data: r.data,
            version: 1,
            importId,
            createdAt: now,
            updatedAt: now,
            updatedBy: principal,
          })),
        );
      }
      for (const r of locked.rows.filter((row) => row.action === "update")) {
        const written = await tx
          .update(contentItems)
          .set({
            rank: r.rank,
            data: r.data,
            version: sql`${contentItems.version} + 1`,
            source: locked.source,
            // A client sheet is authoritative: a retired item it lists again comes back. Admin exports leave status alone.
            ...(r.reactivate ? { status: "approved" } : {}),
            importId,
            updatedAt: now,
            updatedBy: principal,
          })
          .where(and(eq(contentItems.module, module), eq(contentItems.id, r.id), eq(contentItems.version, r.expectedVersion ?? -1)))
          .returning({ id: contentItems.id });
        if (written.length !== 1) {
          // Unreachable while the advisory lock serialises importers; fail closed rather than overwrite.
          throw new ApiError(422, "import_invalid", "The import conflicts with stored content; nothing was imported.", {}, {
            report: [{ row: r.row, id: r.id, level: "conflict", message: "Changed while importing; export, edit and re-import." }],
          });
        }
      }
      for (const r of locked.retirements) {
        const written = await tx
          .update(contentItems)
          .set({
            status: "retired",
            version: sql`${contentItems.version} + 1`,
            source: locked.source,
            importId,
            updatedAt: now,
            updatedBy: principal,
          })
          .where(and(eq(contentItems.module, module), eq(contentItems.id, r.id), eq(contentItems.version, r.expectedVersion)))
          .returning({ id: contentItems.id });
        if (written.length !== 1) throw new ApiError(409, "plan_changed", PLAN_CHANGED_MESSAGE);
      }
      await tx.insert(adminAudit).values({
        actor: principal,
        action: "content_import",
        target: module,
        detail: {
          importId,
          sha256,
          fileName,
          kind: locked.kind,
          ...locked.counts,
          retiredIds: locked.retirements.map((r) => r.id),
          updatedIds: locked.rows.filter((r) => r.action === "update").map((r) => r.id),
        },
        createdAt: now,
      });
      return { replayed: false, import: summary(receipt), warnings };
    });
  }

  async listItems(module: string): Promise<ItemView[]> {
    const rows = await this.database.db.select().from(contentItems).where(eq(contentItems.module, module));
    return rows
      .sort((a, b) => compareIds(a.id, b.id))
      .map((r) => ({
        id: r.id,
        rank: r.rank,
        status: r.status,
        source: r.source,
        version: r.version,
        data: r.data,
        updatedAt: r.updatedAt.toISOString(),
      }));
  }

  /** The module's items as an xlsx in the client's column wording, natural id order. */
  async exportWorkbook(mapping: ContentModuleMapping): Promise<Buffer> {
    const rows = await this.database.db.select().from(contentItems).where(eq(contentItems.module, mapping.module));
    const items: StoredItem[] = rows
      .sort((a, b) => compareIds(a.id, b.id))
      .flatMap((r) =>
        isRank(r.rank) && isStatus(r.status) ? [{ id: r.id, rank: r.rank, status: r.status, version: r.version, data: r.data }] : [],
      );
    return writeSheet(mapping.exportRows(items));
  }

  /** Read and map the sheet. File-level problems (not an xlsx, too big, no header row) are 400. */
  private async parse(mapping: ContentModuleMapping, bytes: Uint8Array): Promise<ParsedSheet> {
    try {
      return mapping.parse(await readFirstSheet(bytes));
    } catch (error) {
      if (error instanceof SpreadsheetError) throw new ApiError(400, "invalid_request", error.message);
      throw error;
    }
  }

  /** Plan against stored rows; any row error or conflict is a 422 with the full report and nothing is written. */
  private check(
    mapping: ContentModuleMapping,
    parsed: ParsedSheet,
    existing: Map<string, ExistingItem>,
  ): { plan: ImportPlan; warnings: ImportIssue[] } {
    const plan = planImport(parsed.rows, existing, { kind: parsed.kind, mapping });
    const all = [...parsed.issues, ...plan.issues].sort((a, b) => a.row - b.row);
    const blocking = all.filter((issue) => issue.level !== "warning");
    if (blocking.length > 0) {
      const errors = blocking.filter((issue) => issue.level === "error").length;
      const conflicts = blocking.length - errors;
      throw new ApiError(
        422,
        "import_invalid",
        `The import has ${errors} error(s) and ${conflicts} conflict(s); nothing was imported.`,
        {},
        { report: all },
      );
    }
    return { plan, warnings: all };
  }

  /**
   * A client sheet that overwrites or retires stored content needs the dry run's planHash. Missing is a 422
   * (do a dry run first); a hash that no longer matches the plan is 409 plan_changed. A hash given for a plan
   * that needs none is still checked.
   */
  private assertConfirmed(plan: ImportPlan, confirm: string | undefined): void {
    if (confirm === undefined) {
      if (!plan.requiresConfirm) return;
      throw new ApiError(
        422,
        "import_invalid",
        `This import would update ${plan.counts.updated} and retire ${plan.counts.retired} stored question(s). ` +
          "Run it with ?dryRun=true first, review the changes, then repeat it with ?confirm=<planHash> from that dry run. Nothing was imported.",
      );
    }
    if (confirm !== planHash(plan)) throw new ApiError(409, "plan_changed", PLAN_CHANGED_MESSAGE);
  }

  private async loadExisting(module: string, tx?: Tx): Promise<Map<string, ExistingItem>> {
    const rows = await (tx ?? this.database.db)
      .select({
        id: contentItems.id,
        rank: contentItems.rank,
        status: contentItems.status,
        version: contentItems.version,
        data: contentItems.data,
      })
      .from(contentItems)
      .where(eq(contentItems.module, module));
    const map = new Map<string, ExistingItem>();
    for (const r of rows) {
      if (isRank(r.rank) && isStatus(r.status)) map.set(r.id, { id: r.id, rank: r.rank, status: r.status, version: r.version, data: r.data });
    }
    return map;
  }

  /** The module's most recent import receipt (ties broken by id, so the order is always defined). */
  private async latestImport(module: string, tx?: Tx): Promise<ContentImportRow | undefined> {
    const [row] = await (tx ?? this.database.db)
      .select()
      .from(contentImports)
      .where(eq(contentImports.module, module))
      .orderBy(desc(contentImports.createdAt), desc(contentImports.id))
      .limit(1);
    return row;
  }
}
