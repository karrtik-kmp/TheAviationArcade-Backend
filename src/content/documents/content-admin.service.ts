import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { createHash } from "node:crypto";
import { ApiError } from "../../common/errors.js";
import { DatabaseService } from "../../database/database.module.js";
import type { Tx } from "../../database/database.module.js";
import type { ContentDocumentName } from "../../db/enums.js";
import { adminAudit } from "../../db/schema.js";
import { SEED_COMMERCIAL_CARD_KEYS } from "../../rules/aircraft-tags.js";
import { FIELD_AWARD_CATALOG } from "../../rules/field-award-catalog.js";
import { BLOB_STORE } from "../../storage/blob-store.js";
import type { BlobStore } from "../../storage/blob-store.js";
import type { ImportIssue } from "../content-module.js";
import { storeImportBlob } from "../import-blob.js";
import { SpreadsheetError, readFirstSheet } from "../xlsx.js";
import { CanonicalJsonError } from "./canonical.js";
import { fieldAwardsPlanHash, normaliseName, parseFieldAwardsSheet, planFieldAwardsImport } from "./field-awards-import.js";
import type { BaseAward, FieldAwardsPlan, PlannedAward, SheetAward } from "./field-awards-import.js";
import { ContentDocumentsService } from "./content-documents.service.js";
import { findDraft, lockDraft, saveDraft } from "./draft-store.js";
import {
  MAX_LISTED_CHANGES,
  applyCardNames,
  applyFieldAwardEdits,
  applyTagEdits,
  describeChanges,
  editorsOf,
  mergeEdits,
  parseStoredEdits,
  salvageHistory,
  sameContent,
  unacknowledgedClientRemovals,
  withHistory,
  withVersion,
} from "./drafts.js";
import type { Change, DraftEdits } from "./drafts.js";
import {
  documentInForce,
  findDocument,
  insertDocument,
  lockSeed,
  militaryCardItems,
  nextDocumentVersion,
  sealableMilitaryItems,
} from "./document-store.js";
import type { Reader } from "./document-store.js";
import { CONTENT_DOCUMENT_NAMES, DocumentValidationError, buildClipperCardsBody, validateDocument } from "./documents.js";

export type DraftView = {
  name: ContentDocumentName;
  /** The version in force (what players are served); null when none exists yet (clipper-cards before its first seal). */
  publishedVersion: number | null;
  /** The revision the editors' version check compares; 0 = no draft row yet. */
  draftVersion: number;
  /** Whether publishing now would write a different document than the one in force. */
  changed: boolean;
  edits: DraftEdits;
  /** Total number of differences between the document in force and what a publish would write. */
  changeCount: number;
  /** The first `MAX_LISTED_CHANGES` of them. */
  changes: Change[];
};

export type DraftDetail = DraftView & { body: Record<string, unknown> };

export type PublishResult = {
  name: ContentDocumentName;
  version: number;
  previousVersion: number | null;
  sha256: string;
  byteSize: number;
  draftVersion: number;
  changeCount: number;
  manifestVersion: string;
};

type AwardsImportPlanned = { plan: FieldAwardsPlan; merged: DraftEdits; publishedVersion: number | null; draftVersion: number };

type AwardsImportView = {
  /** The version in force and the draft revision the plan was made against. */
  publishedVersion: number | null;
  draftVersion: number;
  counts: FieldAwardsPlan["counts"];
  /** Present this as ?confirm= when applying a plan with `requiresConfirm`. */
  planHash: string;
  requiresConfirm: boolean;
  /** Only the awards that change, in catalog order. */
  awards: PlannedAward[];
};
export type FieldAwardsImportDryRun = { dryRun: true } & AwardsImportView;
export type FieldAwardsImportApplied =
  | ({ applied: false } & AwardsImportView)
  | ({ applied: true; file: { fileName: string; sha256: string; byteSize: number; blobKey: string } } & AwardsImportView);

type Preview = {
  published: Record<string, unknown> | undefined;
  publishedVersion: number | null;
  next: number;
  body: Record<string, unknown>;
  changed: boolean;
  /** clipper-cards only: how many approved Military items the document can hold. */
  sealable: number;
};

const READ_SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

const SAVE_CONFLICT = "The draft changed since you read it (another editor, or a publish). Read it again before editing.";

/**
 * Staff edits and publishing for the published documents (slice T6, design 8). Reads draft + document in force; writes only through
 * draft-store.ts (content_drafts), document-store.ts (the one insert into content_documents) and one admin_audit row per publish.
 * Everything for one name runs under `lockDraft(name)`, so concurrent edits and publishes serialise: a stale draft version is 409
 * and never overwrites another editor, and two publishes can never write one version twice or lose an edit.
 */
@Injectable()
export class ContentAdminService {
  private readonly logger = new Logger("ContentAdmin");

  constructor(
    private readonly database: DatabaseService,
    private readonly documents: ContentDocumentsService,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
  ) {}

  async list(): Promise<DraftView[]> {
    // One snapshot, so the three entries describe one moment.
    return this.database.withTransaction(
      async (tx) => {
        const views: DraftView[] = [];
        for (const name of CONTENT_DOCUMENT_NAMES) views.push(await this.view(tx, name));
        return views;
      },
      READ_SNAPSHOT,
    );
  }

  async get(name: ContentDocumentName): Promise<DraftDetail> {
    return this.database.withTransaction(async (tx) => {
      const { edits, draftVersion } = await this.loadEdits(tx, name);
      const preview = await this.preview(tx, name, edits);
      return { ...this.toView(name, draftVersion, edits, preview), body: preview.body };
    }, READ_SNAPSHOT);
  }

  /** Merges validated edits into the overlay as the next draft revision. `request` has passed EDIT_REQUESTS[name]. */
  async edit(name: ContentDocumentName, principal: string, expected: number, request: unknown): Promise<DraftView> {
    return this.database.withTransaction(async (tx) => {
      await lockDraft(tx, name);
      const { edits, draftVersion } = await this.loadEdits(tx, name);
      if (draftVersion !== expected) throw new ApiError(409, "version_conflict", `${SAVE_CONFLICT} Current draft version: ${draftVersion}.`);
      await this.assertKnownTargets(tx, name, edits, request);
      const merged = withHistory(mergeEdits(name, edits, request), principal, "edit", draftVersion + 1, new Date());
      const preview = await this.preview(tx, name, merged);
      this.assertValid(name, preview);
      this.assertRemovalsAcknowledged(name, preview, merged);
      const saved = await saveDraft(tx, name, draftVersion, merged, principal);
      return this.toView(name, saved, merged, preview);
    });
  }

  /** Throws away the pending edits (also the way out of a draft that no longer validates). Version-checked; no draft row = nothing to do. */
  async discard(name: ContentDocumentName, principal: string, expected: number): Promise<DraftView> {
    return this.database.withTransaction(async (tx) => {
      await lockDraft(tx, name);
      const row = await findDraft(tx, name);
      const current = row?.version ?? 0;
      if (current !== expected) throw new ApiError(409, "version_conflict", `${SAVE_CONFLICT} Current draft version: ${current}.`);
      // The edits go; who edited and who discarded stays until the next publish copies it into the audit row.
      const kept = current === 0 ? {} : withHistory({ history: salvageHistory(row?.edits) }, principal, "discard", current + 1, new Date());
      const saved = current === 0 ? 0 : await saveDraft(tx, name, current, kept, principal);
      const preview = await this.preview(tx, name, kept);
      return this.toView(name, saved, kept, preview);
    });
  }

  /**
   * Writes the draft as the next immutable document version, plus exactly one `content_publish` audit row, and resets the draft
   * (revision + 1), all in one transaction. Refused before anything is written when the document would not validate (422
   * content_invalid) or equals the one in force (409 nothing_to_publish). `clipper-cards` is always rebuilt from the content
   * as it is NOW, so publishing it is how a v1 sealed from a small or trial set catches up.
   */
  async publish(name: ContentDocumentName, principal: string, expected: number, note: string | undefined, acknowledgeCardRemoval = false): Promise<PublishResult> {
    const result = await this.database.withTransaction(async (tx): Promise<Omit<PublishResult, "manifestVersion">> => {
      await lockDraft(tx, name);
      await lockSeed(tx); // a seed writing version 1 finishes first; the reads below then agree with each other
      const { edits, draftVersion } = await this.loadEdits(tx, name);
      if (draftVersion !== expected) throw new ApiError(409, "version_conflict", `${SAVE_CONFLICT} Current draft version: ${draftVersion}.`);
      const preview = await this.preview(tx, name, edits);
      if (!preview.published && name === "clipper-cards" && preview.sealable === 0) {
        throw new ApiError(409, "nothing_to_publish", "There is no approved Military content to seal yet.");
      }
      if (!preview.changed) throw new ApiError(409, "nothing_to_publish", "The draft equals the version in force; nothing to publish.");
      this.assertValid(name, preview);
      this.assertRemovalsAcknowledged(name, preview, edits);
      const changes = describeChanges(name, preview.published, preview.body, edits);
      const removedCards = changes.filter((c) => c.kind === "card-removed");
      if (removedCards.length > 0 && !acknowledgeCardRemoval) {
        throw new ApiError(
          422,
          "content_invalid",
          `This publish removes ${removedCards.length} Card(s) from the catalog (their items are no longer approved): ${removedCards.slice(0, 5).map((c) => c.key).join(", ")}. Send acknowledgeCardRemoval: true to publish anyway. Cards players already hold are not removed from their Logbooks.`,
        );
      }

      const inserted = await insertDocument(tx, {
        name,
        version: preview.next,
        body: preview.body,
        createdBy: principal,
        ...(note !== undefined ? { note } : {}),
      });
      if (!inserted) throw new ApiError(409, "version_conflict", "That version was written by someone else. Read the draft again.");

      const stored = await findDocument(tx, name, preview.next);
      if (!stored) throw new Error(`published ${name} v${preview.next} cannot be read back`);
      await tx.insert(adminAudit).values({
        actor: principal,
        action: "content_publish",
        target: name,
        detail: {
          name,
          version: preview.next,
          previousVersion: preview.publishedVersion,
          sha256: stored.sha256,
          byteSize: stored.byteSize,
          draftVersion,
          editors: editorsOf(edits),
          history: edits.history ?? [],
          ...(removedCards.length > 0 ? { acknowledgedCardRemoval: true } : {}),
          ...(note !== undefined ? { note } : {}),
          changeCount: changes.length,
          changes: changes.slice(0, MAX_LISTED_CHANGES),
        },
        createdAt: new Date(),
      });
      const next = await saveDraft(tx, name, draftVersion, {}, principal);
      return {
        name,
        version: preview.next,
        previousVersion: preview.publishedVersion,
        sha256: stored.sha256,
        byteSize: stored.byteSize,
        draftVersion: next,
        changeCount: changes.length,
      };
    });
    // Committed: report the manifest a player would be served now.
    const manifest = await this.documents.manifest();
    this.logger.log(`${principal} published ${name} v${result.version} (${result.changeCount} changes)`);
    return { ...result, manifestVersion: manifest.version };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Re-importing a later Field Awards sheet (slice A2). The sheet becomes edits in the field-awards DRAFT; publishing is the
  // ordinary publish route, so nothing reaches players until staff publish.

  /** Plans without writing or storing anything. A plan with any error is 422 import_invalid and carries the report. */
  async dryRunFieldAwardsImport(bytes: Uint8Array): Promise<FieldAwardsImportDryRun> {
    const sheet = await this.readAwardsSheet(bytes);
    return this.database.withTransaction(async (tx) => {
      const planned = await this.planAwardsImport(tx, sheet);
      return { dryRun: true, ...this.awardsImportView(planned) };
    }, READ_SNAPSHOT);
  }

  /**
   * Writes the plan into the draft. A plan that changes anything needs `confirm` = the planHash of a dry run (missing: 422
   * import_invalid; the draft or the version in force moved since: 409 plan_changed). The hash covers the draft revision, so an
   * edit that landed after the dry run can never be overwritten or silently merged: the confirm goes stale. The write is the PATCH
   * path: per-name advisory lock, draft revision + 1, a history entry (principal, action "import", the file's sha256). The original
   * file is stored first (content-addressed, kept). A plan with no change writes and stores nothing (`applied: false`).
   */
  async applyFieldAwardsImport(bytes: Uint8Array, fileName: string, principal: string, confirm?: string): Promise<FieldAwardsImportApplied> {
    const sheet = await this.readAwardsSheet(bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const early = await this.database.withTransaction(async (tx) => this.planAwardsImport(tx, sheet), READ_SNAPSHOT);
    this.assertAwardsConfirmed(early, confirm); // fail before storing anything
    if (early.plan.awards.length === 0) return { applied: false, ...this.awardsImportView(early) };

    const blobKey = `imports/field-awards/${sha256}.xlsx`;
    await storeImportBlob(this.blobs, this.logger, blobKey, bytes);

    const result = await this.database.withTransaction(async (tx) => {
      await lockDraft(tx, "field-awards");
      await lockSeed(tx);
      const { edits, draftVersion } = await this.loadEdits(tx, "field-awards");
      const locked = await this.planAwardsImport(tx, sheet, { edits, draftVersion });
      this.assertAwardsConfirmed(locked, confirm);
      if (locked.plan.awards.length === 0) return { applied: false as const, ...this.awardsImportView(locked) };
      const merged = withHistory(locked.merged as DraftEdits, principal, "import", draftVersion + 1, new Date(), sha256);
      const saved = await saveDraft(tx, "field-awards", draftVersion, merged, principal);
      this.logger.log(`${principal} imported ${fileName} (${sha256.slice(0, 12)}) into the field-awards draft: ${locked.plan.counts.fieldChanges} field change(s)`);
      return { applied: true as const, ...this.awardsImportView(locked), draftVersion: saved, file: { fileName, sha256, byteSize: bytes.length, blobKey } };
    });
    return result;
  }

  private async readAwardsSheet(bytes: Uint8Array): Promise<{ rows: SheetAward[]; issues: ImportIssue[] }> {
    try {
      return parseFieldAwardsSheet(await readFirstSheet(bytes));
    } catch (error) {
      if (error instanceof SpreadsheetError) throw new ApiError(400, "invalid_request", error.message);
      throw error;
    }
  }

  /**
   * Matches the sheet to the awards of the preview (version in force + draft overlay), diffs it, and runs the document validators on the
   * result. Any problem is 422 import_invalid with the full report. `merged` = the overlay with the plan's edits in it.
   */
  private async planAwardsImport(
    db: Reader,
    sheet: { rows: SheetAward[]; issues: ImportIssue[] },
    known?: { edits: DraftEdits; draftVersion: number },
  ): Promise<AwardsImportPlanned> {
    const { edits, draftVersion } = known ?? (await this.loadEdits(db, "field-awards"));
    const preview = await this.preview(db, "field-awards", edits);
    const catalogTitle = new Map<string, string>(FIELD_AWARD_CATALOG.map((d) => [d.id, d.title]));
    const publishedTitle = new Map<string, string>(((preview.published?.["awards"] as { id: string; title: string }[] | undefined) ?? []).map((a) => [a.id, a.title]));
    const base: BaseAward[] = (preview.body["awards"] as (Omit<BaseAward, "names"> & { title: string })[]).map((a) => ({
      id: a.id,
      title: a.title,
      criteria: a.criteria,
      target: a.target,
      thresholdCell: a.thresholdCell,
      names: [...new Set([catalogTitle.get(a.id), publishedTitle.get(a.id), a.title].filter((n): n is string => n !== undefined).map(normaliseName))],
    }));
    const plan = planFieldAwardsImport(sheet.rows, sheet.issues, base);
    let merged: DraftEdits = edits;
    if (plan.issues.length === 0 && plan.awards.length > 0) {
      merged = mergeEdits("field-awards", edits, { awards: plan.awards.map(({ id, changes }) => ({ id, ...Object.fromEntries(changes.map((c) => [c.field, c.to])) })) });
      const after = await this.preview(db, "field-awards", merged);
      try {
        validateDocument("field-awards", after.body, after.next);
      } catch (error) {
        if (!(error instanceof DocumentValidationError || error instanceof CanonicalJsonError)) throw error;
        plan.issues.push({ row: 0, level: "error", message: `The Field Awards document would not be valid: ${error.message}` });
      }
    }
    if (plan.issues.length > 0) {
      throw new ApiError(422, "import_invalid", `The import has ${plan.issues.length} error(s); nothing was imported.`, {}, { report: plan.issues });
    }
    return { plan, merged, publishedVersion: preview.publishedVersion, draftVersion };
  }

  private awardsImportView(planned: AwardsImportPlanned) {
    return {
      publishedVersion: planned.publishedVersion,
      draftVersion: planned.draftVersion,
      counts: planned.plan.counts,
      planHash: fieldAwardsPlanHash(planned, planned.plan),
      requiresConfirm: planned.plan.awards.length > 0,
      awards: planned.plan.awards,
    };
  }

  private assertAwardsConfirmed(planned: AwardsImportPlanned, confirm: string | undefined): void {
    if (confirm === undefined) {
      if (planned.plan.awards.length === 0) return;
      throw new ApiError(
        422,
        "import_invalid",
        `This import would change ${planned.plan.awards.length} Field Award(s) in the draft. Run it with ?dryRun=true first, review the changes, then repeat it with ?confirm=<planHash> from that dry run. Nothing was imported.`,
      );
    }
    if (confirm !== fieldAwardsPlanHash(planned, planned.plan)) {
      throw new ApiError(
        409,
        "plan_changed",
        "The draft or the version in force changed since the dry run, so the confirmed plan no longer applies. Run a new dry run and review it. Nothing was imported.",
      );
    }
  }

  private async view(db: Reader, name: ContentDocumentName): Promise<DraftView> {
    const { edits, draftVersion } = await this.loadEdits(db, name);
    return this.toView(name, draftVersion, edits, await this.preview(db, name, edits));
  }

  private toView(name: ContentDocumentName, draftVersion: number, edits: DraftEdits, preview: Preview): DraftView {
    const changes = preview.changed || preview.published ? describeChanges(name, preview.published, preview.body, edits) : [];
    return {
      name,
      publishedVersion: preview.publishedVersion,
      draftVersion,
      changed: preview.changed,
      edits,
      changeCount: changes.length,
      changes: changes.slice(0, MAX_LISTED_CHANGES),
    };
  }

  /** The stored overlay, validated. A row that no longer validates (hand-edited) is 422: it cannot reach a published document; discard it. */
  private async loadEdits(db: Reader, name: ContentDocumentName): Promise<{ edits: DraftEdits; draftVersion: number }> {
    const row = await findDraft(db, name);
    if (!row) return { edits: {}, draftVersion: 0 };
    try {
      return { edits: parseStoredEdits(name, row.edits), draftVersion: row.version };
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      this.logger.error(`the stored ${name} draft does not validate and is refused: ${error.issues.slice(0, 3).map((i) => i.message).join("; ")}`);
      throw new ApiError(422, "content_invalid", `The stored ${name} draft is not valid. Discard it (version ${row.version}) and edit again.`);
    }
  }

  /** What the document would be: the one in force with the overlay applied, as version `next`. Pure reads. */
  private async preview(db: Reader, name: ContentDocumentName, edits: DraftEdits): Promise<Preview> {
    const inForce = await documentInForce(db, name);
    const publishedRow = inForce ? await findDocument(db, name, inForce.meta.version) : undefined;
    const published = publishedRow ? (publishedRow.body as Record<string, unknown>) : undefined;
    if (!published && name !== "clipper-cards") {
      throw new ApiError(503, "service_unavailable", "Content is not ready yet. Retry shortly.", { "Retry-After": "5" });
    }
    const next = await nextDocumentVersion(db, name);
    let body: Record<string, unknown>;
    let sealable = 0;
    switch (name) {
      case "field-awards":
        body = applyFieldAwardEdits(published, edits);
        break;
      case "aircraft-tags":
        body = applyTagEdits(published, edits);
        break;
      case "clipper-cards": {
        const derived = await this.derivedCards(db, next);
        sealable = derived.sealable;
        body = applyCardNames(derived.body, published, edits);
        break;
      }
    }
    body = withVersion(body, next);
    const changed = published ? !sameContent(body, published) : sealable > 0;
    return { published, publishedVersion: inForce?.meta.version ?? null, next, body, changed, sealable };
  }

  /** clipper-cards as the content stands now: the commercial families plus every approved Military item the schema can hold. */
  private async derivedCards(db: Reader, version: number): Promise<{ body: Record<string, unknown>; sealable: number }> {
    const items = await militaryCardItems(db);
    const { accepted, skipped } = sealableMilitaryItems(items, SEED_COMMERCIAL_CARD_KEYS.size);
    for (const item of skipped) this.logger.warn(`clipper-cards: Military item ${item.id} is left out (${item.why})`);
    return { body: buildClipperCardsBody(version, accepted), sealable: accepted.length };
  }

  /** An edit may only name something that exists: a Card in the document (or derivable from the content), never an invented key. */
  private async assertKnownTargets(tx: Tx, name: ContentDocumentName, edits: DraftEdits, request: unknown): Promise<void> {
    if (name === "field-awards") return; // ids are an enum in the request schema
    const preview = await this.preview(tx, name === "aircraft-tags" ? "clipper-cards" : name, name === "aircraft-tags" ? {} : edits);
    const cards = new Set(((preview.body["cards"] as { key: string }[] | undefined) ?? []).map((c) => c.key));
    if (name === "clipper-cards") {
      const unknown = (request as { names: { key: string }[] }).names.filter((n) => !cards.has(n.key)).map((n) => n.key);
      if (unknown.length) throw new ApiError(422, "content_invalid", `Not a Card in the catalog: ${unknown.slice(0, 5).join(", ")}.`);
      return;
    }
    const current = await this.preview(tx, "aircraft-tags", {});
    const known = new Set(((current.body["entries"] as { cardKey: string }[]) ?? []).map((e) => e.cardKey));
    const unknown = (request as { entries: { cardKey: string }[] }).entries.filter((e) => !known.has(e.cardKey) && !cards.has(e.cardKey)).map((e) => e.cardKey);
    if (unknown.length) throw new ApiError(422, "content_invalid", `Not a Card in the catalog: ${unknown.slice(0, 5).join(", ")}.`);
  }

  /** Staff may not drop a tag the client supplied unless the edit says so (`acknowledgeClientTagRemoval`). */
  private assertRemovalsAcknowledged(name: ContentDocumentName, preview: Preview, edits: DraftEdits): void {
    if (name !== "aircraft-tags") return;
    const removals = unacknowledgedClientRemovals(preview.published, edits);
    if (removals.length === 0) return;
    const list = removals.slice(0, 5).map((r) => `${r.key}: ${r.tags.join(", ")}`).join("; ");
    throw new ApiError(422, "content_invalid", `This would remove a tag the client supplied (${list}). Send acknowledgeClientTagRemoval: true on that entry to confirm.`);
  }

  /** The publish check: the existing validators (28 ids once, metrics unchanged, integer targets >= 1, unique keys, body version). */
  private assertValid(name: ContentDocumentName, preview: Preview): void {
    try {
      validateDocument(name, preview.body, preview.next);
    } catch (error) {
      if (error instanceof DocumentValidationError || error instanceof CanonicalJsonError) {
        throw new ApiError(422, "content_invalid", `The ${name} document would not be valid: ${error.message}`);
      }
      throw error;
    }
  }
}
