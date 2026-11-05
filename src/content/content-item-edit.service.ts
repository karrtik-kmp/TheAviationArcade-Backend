import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { isDemoPrincipal } from "../accounts/account-principal.js";
import { ApiError } from "../common/errors.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { DatabaseService } from "../database/database.module.js";
import type { Tx } from "../database/database.module.js";
import type { AdminAuditAction, ContentStatus, PrepStage } from "../db/enums.js";
import { adminAudit, contentItems, mediaItems } from "../db/schema.js";
import type { ContentItemRow } from "../db/schema.js";
import { militaryCardKey } from "../rules/clipper-cards.js";
import { isRank } from "../rules/ranks.js";
import type { Rank } from "../rules/ranks.js";
import type { ContentModuleMapping } from "./content-module.js";
import { lockContentModule, readContentStamp } from "./content-lock.js";
import { canonicalJson, diffItem, planImport } from "./import-plan.js";
import type { ExistingItem, FieldDiff } from "./import-plan.js";
import type { ItemView } from "./content.service.js";
import { formatMediaId, parseMediaId } from "./item-media-id.js";
import {
  MILITARY_MODULE,
  changedEvidenceFields,
  guardsMedia,
  mediaGuardProblems,
  preparationErrors,
  preparationView,
} from "./preparation/military-preparation.js";
import type { PreparationBody, PrepEvidence } from "./preparation/military-preparation.js";

const MILITARY = MILITARY_MODULE;

/** 422 `content_invalid`; the reasons are in `errors[]` next to `error`. */
function invalid(errors: string[]): ApiError {
  return new ApiError(422, "content_invalid", `The item is not valid: ${errors.join(" ")} Nothing was changed.`, {}, { errors });
}

/** The Card key of the answer as stored (null when there is none, as the lazy freeze treats it). */
function militaryKeyOfStored(data: unknown): string | null {
  const answer = (data as { answer?: unknown } | null)?.answer;
  return (typeof answer === "string" ? militaryCardKey(answer) : "") || null;
}

export type ItemEdit = { rank?: Rank | undefined; data?: unknown };

export type ItemChange = { changed: boolean; item: ItemView; diff: FieldDiff[] };

function view(row: ContentItemRow): ItemView {
  return {
    id: row.id,
    rank: row.rank,
    status: row.status,
    source: row.source,
    version: row.version,
    data: row.data,
    mediaId: formatMediaId(row.mediaId),
    preparation: preparationView(row),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Outcome = { ok: true; value: ItemChange } | { ok: false; error: ApiError };

/**
 * Staff edit-in-place of one content item: edit (rank / payload), retire, restore. Each is optimistic (the caller's
 * `version` must equal the stored one) and runs in one transaction under the module lock the import apply uses.
 * A change bumps the version, records source `admin` and the actor, and appends one admin_audit row with the
 * field-level diff. A Clipper Card key is frozen at first import and an edit never moves it; the one exception is a Military item
 * with no stored key (a row older than migration 0009), which gets the key of its PRE-edit answer in the same UPDATE. An unchanged
 * request writes nothing: no bump, no audit row. A retired item stays retired when edited.
 */
@Injectable()
export class ContentItemEditService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async edit(mapping: ContentModuleMapping, id: string, expectedVersion: number, change: ItemEdit, principal: string): Promise<ItemChange> {
    // The payload rules are the mapping's own (the sheet parser calls the same function), checked before any lock.
    let checked: { data: Record<string, unknown> } | undefined;
    if (change.data !== undefined) {
      const result = mapping.validatePayload(change.data);
      if (result.problems.length > 0) {
        throw new ApiError(422, "import_invalid", `The item is not valid: ${result.problems.join(" ")} Nothing was changed.`);
      }
      checked = { data: result.data };
    }
    return this.run(mapping.module, id, expectedVersion, principal, async (tx, stored, existing, now) => {
      const rank = change.rank ?? (isRank(stored.rank) ? stored.rank : undefined);
      if (!rank) throw new ApiError(422, "import_invalid", "The stored rank is not valid; send a rank. Nothing was changed.");
      const data = checked?.data ?? (stored.data as Record<string, unknown>);
      if (rank === stored.rank && canonicalJson(data) === canonicalJson(stored.data)) return { kind: "unchanged" };
      // The natural-key rule lives in the planner (non-blank, unique across the module, retired items included):
      // plan this one row as an admin-export update against the locked rows and take any error it finds.
      const plan = planImport(
        [{ row: 1, id, naturalKey: mapping.naturalKey(data), version: stored.version, rank, data }],
        existing,
        { kind: "admin_export", mapping },
      );
      const problem = plan.issues.find((issue) => issue.level !== "warning");
      if (problem) throw new ApiError(422, "import_invalid", `${problem.message} Nothing was changed.`);
      const diff = diffItem(stored, { rank, data });
      const [row] = await tx
        .update(contentItems)
        .set({
          rank,
          data,
          // A Military row older than migration 0009 has no frozen key; freeze it from the STORED answer so this edit
          // cannot move it (the lazy freeze in rounds / the Card catalog would otherwise read the new answer).
          ...(mapping.module === MILITARY && stored.cardKey === null ? { cardKey: militaryKeyOfStored(stored.data) } : {}),
          version: sql`${contentItems.version} + 1`,
          source: "admin",
          updatedAt: now,
          updatedBy: principal,
        })
        .where(and(eq(contentItems.module, mapping.module), eq(contentItems.id, id), eq(contentItems.version, stored.version)))
        .returning();
      return { kind: "changed", row, diff, action: "content_edit" };
    });
  }

  /** retire → `retired`, restore → `approved`. Already in that state is `changed: false`. */
  async setStatus(module: string, id: string, expectedVersion: number, status: ContentStatus, principal: string): Promise<ItemChange> {
    return this.run(module, id, expectedVersion, principal, async (tx, stored, _existing, now) => {
      if (stored.status === status) return { kind: "unchanged" };
      const [row] = await tx
        .update(contentItems)
        .set({ status, version: sql`${contentItems.version} + 1`, source: "admin", updatedAt: now, updatedBy: principal })
        .where(and(eq(contentItems.module, module), eq(contentItems.id, id), eq(contentItems.version, stored.version)))
        .returning();
      return {
        kind: "changed",
        row,
        diff: [{ field: "status", from: stored.status, to: status }],
        action: status === "retired" ? "content_retire" : "content_restore",
      };
    });
  }

  /**
   * Link the item to a media item (`med-<n>`) or, with null, remove the link. Any existing media item may be linked, whatever its
   * state: the contract does not restrict it, and readers only ever see the published version. Linking the stored value is
   * `changed: false`. The link is a staff write (version bump, source `admin`, `updated_at`), so it also ends a client-sheet replay.
   */
  async setMedia(module: string, id: string, expectedVersion: number, mediaId: string | null, principal: string): Promise<ItemChange> {
    const wanted = mediaId === null ? null : parseMediaId(mediaId);
    if (wanted === undefined) throw new ApiError(422, "media_invalid", "mediaId must be a media id such as med-12, or null.");
    return this.run(module, id, expectedVersion, principal, async (tx, stored, _existing, now) => {
      let media: { state: string; publishedVersion: number | null; owner: string } | undefined;
      if (wanted !== null) {
        // FOR SHARE: a concurrent withdraw waits for this transaction (and the other way round), so the guard below holds at commit.
        [media] = await tx
          .select({ state: mediaItems.state, publishedVersion: mediaItems.publishedVersion, owner: mediaItems.owner })
          .from(mediaItems)
          .where(eq(mediaItems.id, wanted))
          .limit(1)
          .for("share");
        if (!media) throw new ApiError(422, "media_invalid", "No such media item. Nothing was changed.");
      }
      if (stored.mediaId === wanted) return { kind: "unchanged" };
      // Military at or past Rights checked: the link must be a published, non-demo photo (W3). At stage 0, or with no
      // preparation, any existing media may be linked as before.
      if (media && module === MILITARY && stored.prepStage !== null && guardsMedia(stored.prepStage)) {
        const problems = mediaGuardProblems({ state: media.state, publishedVersion: media.publishedVersion, ownerIsDemo: isDemoPrincipal(this.config, media.owner) });
        if (problems.length > 0) throw invalid(problems);
      }
      const [row] = await tx
        .update(contentItems)
        .set({ mediaId: wanted, version: sql`${contentItems.version} + 1`, source: "admin", updatedAt: now, updatedBy: principal })
        .where(and(eq(contentItems.module, module), eq(contentItems.id, id), eq(contentItems.version, stored.version)))
        .returning();
      return {
        kind: "changed",
        row,
        diff: [{ field: "media", from: formatMediaId(stored.mediaId), to: formatMediaId(wanted) }],
        action: "content_media_link",
      };
    });
  }

  /**
   * Save the Military preparation of one item (docs/plans/website-content.md W3): stage, evidence and the linked photo in ONE write.
   * Only the Military module has it (any other module is 404). The rules are the pure ones in `military-preparation.ts`; the media
   * is read FOR SHARE and, from Rights checked on, must be published and not demo-owned. A save sets `media_id`, bumps the item
   * version and sets `prep_version` to the new version, so any later import, edit, relink, retire or restore makes it stale. An
   * unchanged save of a current preparation writes nothing; re-saving a STALE preparation unchanged re-confirms it (a write).
   */
  async prepare(module: string, id: string, body: PreparationBody, principal: string): Promise<{ changed: boolean; item: ItemView }> {
    if (module !== MILITARY) throw new ApiError(404, "not_found", "No such endpoint.");
    const wanted = body.mediaId === null ? null : parseMediaId(body.mediaId);
    if (wanted === undefined) throw new ApiError(422, "media_invalid", "mediaId must be a media id such as med-12, or null.");
    const evidence: PrepEvidence = body.evidence;
    const result = await this.run(module, id, body.version, principal, async (tx, stored, _existing, now) => {
      const stale = stored.prepVersion !== null && stored.prepVersion !== stored.version;
      const errors = preparationErrors(
        { status: stored.status, stale },
        { stage: stored.prepStage as PrepStage | null, evidence: stored.prepEvidence, mediaId: stored.mediaId },
        { stage: body.stage, evidence, mediaId: wanted },
      );
      if (wanted !== null && stored.status !== "retired") {
        const [media] = await tx
          .select({ state: mediaItems.state, publishedVersion: mediaItems.publishedVersion, owner: mediaItems.owner })
          .from(mediaItems)
          .where(eq(mediaItems.id, wanted))
          .limit(1)
          .for("share");
        if (!media) errors.push("No such media item.");
        else if (guardsMedia(body.stage)) {
          errors.push(...mediaGuardProblems({ state: media.state, publishedVersion: media.publishedVersion, ownerIsDemo: isDemoPrincipal(this.config, media.owner) }));
        }
      }
      if (errors.length > 0) throw invalid(errors);
      const same = stored.prepStage === body.stage && stored.mediaId === wanted && canonicalJson(stored.prepEvidence) === canonicalJson(evidence);
      if (same && !stale) return { kind: "unchanged" };
      const [row] = await tx
        .update(contentItems)
        .set({
          prepStage: body.stage,
          prepEvidence: evidence,
          mediaId: wanted,
          version: sql`${contentItems.version} + 1`,
          prepVersion: sql`${contentItems.version} + 1`,
          source: "admin",
          updatedAt: now,
          updatedBy: principal,
        })
        .where(and(eq(contentItems.module, module), eq(contentItems.id, id), eq(contentItems.version, stored.version)))
        .returning();
      const fields = [
        ...(stored.prepStage !== body.stage ? ["stage"] : []),
        ...changedEvidenceFields(stored.prepEvidence, evidence),
        ...(stored.mediaId !== wanted ? ["media"] : []),
      ];
      return {
        kind: "changed",
        row,
        diff: [],
        action: "content_prepare",
        detail: {
          id,
          fromVersion: stored.version,
          version: row?.version,
          fromStage: stored.prepStage,
          stage: body.stage,
          media: stored.mediaId === wanted ? null : { from: formatMediaId(stored.mediaId), to: formatMediaId(wanted) },
          fields,
          ...(same ? { reconfirmed: true } : {}),
        },
      };
    });
    return { changed: result.changed, item: result.item };
  }

  private async run(
    module: string,
    id: string,
    expectedVersion: number,
    principal: string,
    step: (
      tx: Tx,
      stored: ContentItemRow,
      existing: Map<string, ExistingItem>,
      now: SQL,
    ) => Promise<
      | { kind: "unchanged" }
      | { kind: "changed"; row: ContentItemRow | undefined; diff: FieldDiff[]; action: AdminAuditAction; detail?: Record<string, unknown> }
    >,
  ): Promise<ItemChange> {
    // Expected refusals are returned, not thrown, so the connection goes back to the pool instead of being destroyed.
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome> => {
      try {
        await lockContentModule(tx, module);
        const now = await readContentStamp(tx); // one database instant after the lock; see readContentStamp
        const rows = await tx.select().from(contentItems).where(eq(contentItems.module, module));
        const stored = rows.find((r) => r.id === id);
        if (!stored) return { ok: false, error: new ApiError(404, "not_found", "No such item.") };
        if (stored.version !== expectedVersion) {
          return {
            ok: false,
            error: new ApiError(409, "version_conflict", `The item is at version ${stored.version}, not ${expectedVersion}. Reload it and apply the change again. Nothing was changed.`),
          };
        }
        const existing = new Map<string, ExistingItem>();
        for (const r of rows) if (isRank(r.rank)) existing.set(r.id, { id: r.id, rank: r.rank, status: r.status, version: r.version, data: r.data });
        const result = await step(tx, stored, existing, now);
        if (result.kind === "unchanged") return { ok: true, value: { changed: false, item: view(stored), diff: [] } };
        if (!result.row) throw new Error("Item update was not stored."); // the advisory lock makes this unreachable
        await tx.insert(adminAudit).values({
          actor: principal,
          action: result.action,
          target: module,
          detail: result.detail ?? { id, fromVersion: stored.version, version: result.row.version, diff: result.diff },
          createdAt: now,
        });
        return { ok: true, value: { changed: true, item: view(result.row), diff: result.diff } };
      } catch (error) {
        if (error instanceof ApiError) return { ok: false, error }; // every ApiError is raised before the first write
        throw error;
      }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}
