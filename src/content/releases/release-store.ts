import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { isDemoPrincipal } from "../../accounts/account-principal.js";
import { ApiError } from "../../common/errors.js";
import { APP_CONFIG } from "../../config/config.module.js";
import type { AppConfig } from "../../config/config.module.js";
import { DatabaseService } from "../../database/database.module.js";
import type { Tx } from "../../database/database.module.js";
import { adminAudit, contentItems, contentReleaseActivations, contentReleaseItems, contentReleases, mediaItems, mediaVersions } from "../../db/schema.js";
import type { Rank } from "../../rules/ranks.js";
import { lockContentModule, readContentStamp } from "../content-lock.js";
import { compareIds } from "../content-modules.js";
import { rowToDealItem } from "../deal-items.js";
import {
  BASIS_CHANGED_MESSAGE,
  CANNOT_RELEASE_MESSAGE,
  CHANGED_SINCE_UPLOAD_MESSAGE,
  NOT_PREVIEWED_MESSAGE,
  RELEASES_LISTED,
  RELEASE_MODULE,
  RESTORE_PHOTOS_MESSAGE,
  SAME_AS_CURRENT_MESSAGE,
  activationGuardErrors,
  cleanNote,
  coverageErrors,
  ownRankCounts,
  pointerOf,
  planActivate,
  planRestore,
  readinessErrors,
  releaseBasis,
  releaseCardKey,
  releaseCoverage,
  restoreGuardErrors,
  selectionErrors,
} from "./release-rules.js";
import type { CurrentItem, FrozenItem, MediaFact, Pointer, Refusal, ReleaseItemRow, ReleaseStatus, UploadBody } from "./release-rules.js";

export type ReleaseSummary = {
  number: number;
  basis: string;
  aircraft: number;
  createdAt: string;
  note: string | null;
  status: ReleaseStatus;
};

export type ReleaseState = { pointer: Pointer; releases: ReleaseSummary[] };
export type ReleaseList = ReleaseState & { ownRankCounts: Record<Rank, number> };

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ApiError };

function refusalError(refusal: Refusal): ApiError {
  return new ApiError(refusal.status, refusal.code, `${refusal.message} Nothing was changed.`, {}, refusal.errors ? { errors: refusal.errors } : {});
}

const invalid = (message: string, errors: string[]): ApiError => new ApiError(422, "content_invalid", `${message} Nothing was changed.`, {}, { errors });

/**
 * THE per-module release try-lock (`content-release:<module>`), taken before the module lock. Try, never wait: a waiting request
 * would hold a pooled connection, so a busy release is a retryable 409 `release_in_progress`.
 */
async function lockRelease(tx: Tx, module: string): Promise<void> {
  const lock = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`content-release:${module}`}, 0)) AS locked`);
  if (lock.rows[0]?.locked !== true) {
    throw new ApiError(409, "release_in_progress", "Another release step for this module is running. Retry shortly.", { "Retry-After": "2" });
  }
}

/**
 * Military releases (docs/plans/website-content.md W3 commit 2): upload a selection of approved items as an immutable candidate,
 * make a candidate current (activate) and step back (restore). RECORDED, NOT DELIVERED: no player route reads these rows and nothing
 * deals from them. This class is the ONLY writer of `content_releases`, `content_release_items` and `content_release_activations`
 * (a source-scan test enforces it); every write is one transaction under the release lock (and, for upload and activate, the module
 * write lock too) and appends one `admin_audit` row. Expected refusals are returned inside the transaction and thrown after it, as
 * in ContentItemEditService.run, so a healthy connection goes back to the pool.
 */
@Injectable()
export class ReleaseStore {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The pointer, the newest releases and the own-rank counts. A plain read (nothing locked). */
  async list(): Promise<ReleaseList> {
    const state = await this.state(this.database.db);
    const rows = await this.database.db
      .select({ rank: contentItems.rank, status: contentItems.status, version: contentItems.version, prepStage: contentItems.prepStage, prepVersion: contentItems.prepVersion })
      .from(contentItems)
      .where(eq(contentItems.module, RELEASE_MODULE));
    return { ...state, ownRankCounts: ownRankCounts(rows) };
  }

  /** Upload a selection as a new release (status `uploaded`, not live). */
  async upload(body: UploadBody, principal: string): Promise<ReleaseSummary> {
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome<ReleaseSummary>> => {
      try {
        await lockRelease(tx, RELEASE_MODULE);
        await lockContentModule(tx, RELEASE_MODULE);
        const now = await readContentStamp(tx);
        const all = await tx
          .select({
            id: contentItems.id,
            rank: contentItems.rank,
            status: contentItems.status,
            version: contentItems.version,
            data: contentItems.data,
            cardKey: contentItems.cardKey,
            prepStage: contentItems.prepStage,
            prepVersion: contentItems.prepVersion,
            mediaId: contentItems.mediaId,
          })
          .from(contentItems)
          .where(eq(contentItems.module, RELEASE_MODULE));
        const byId = new Map<string, ReleaseItemRow>(all.map((r) => [r.id, r]));

        const selection = selectionErrors(body.itemIds, byId);
        if (selection.unknown.length > 0) {
          const shown = selection.unknown.slice(0, 10).join(", ");
          throw new ApiError(422, "unknown_item_ids", `${selection.unknown.length} item id(s) are not stored for this module: ${shown}${selection.unknown.length > 10 ? ", ..." : ""}.`);
        }
        if (selection.errors.length > 0) throw invalid("The selection is not valid.", selection.errors);
        const chosen = [...new Set(body.itemIds)].map((id) => byId.get(id) as ReleaseItemRow).sort((a, b) => compareIds(a.id, b.id));

        const basis = releaseBasis(chosen);
        if (body.basis !== basis) throw new ApiError(409, "version_conflict", `${BASIS_CHANGED_MESSAGE} Nothing was changed.`);
        if (body.previewed !== true) throw new ApiError(422, "content_invalid", `${NOT_PREVIEWED_MESSAGE} Nothing was changed.`, {}, { errors: [NOT_PREVIEWED_MESSAGE] });

        const pointer = await this.pointer(tx);
        const current = pointer.current === null ? undefined : await this.release(tx, pointer.current);
        if (current && current.basis === basis) throw new ApiError(409, "nothing_to_publish", `${SAME_AS_CURRENT_MESSAGE} Nothing was changed.`);

        // The photos, FOR SHARE in id order: a concurrent withdraw waits for this transaction (and the other way round), so what is
        // frozen here is what is published at commit.
        const media = await this.mediaFacts(tx, chosen.flatMap((r) => (r.mediaId === null ? [] : [r.mediaId])));
        const errors = readinessErrors(chosen, media);
        // Coverage over the rows already read, with the pure dealer rule: never a second pooled connection.
        const coverage = releaseCoverage(chosen);
        errors.push(...coverageErrors(coverage));
        if (errors.length > 0) throw invalid(CANNOT_RELEASE_MESSAGE, errors);

        const [top] = await tx.select({ top: sql<number>`coalesce(max(${contentReleases.version}), 0)` }).from(contentReleases).where(eq(contentReleases.module, RELEASE_MODULE));
        const next = Number(top?.top ?? 0) + 1;
        const [release] = await tx
          .insert(contentReleases)
          .values({ module: RELEASE_MODULE, version: next, basis, itemCount: chosen.length, dealRule: "nearest-ranks", flightKind: "choice", createdAt: now, createdBy: principal, note: cleanNote(body.note) })
          .returning();
        if (!release) throw new Error("The release was not stored.");
        await tx.insert(contentReleaseItems).values(
          chosen.map((row, index) => {
            const fact = media.get(row.mediaId as number) as MediaFact;
            const deal = rowToDealItem(row);
            if (!deal) throw new Error("A chosen item lost its question after the coverage check."); // coverageErrors already refused it
            return {
              module: RELEASE_MODULE,
              releaseVersion: next,
              itemId: row.id,
              itemVersion: row.version,
              position: index + 1,
              rank: row.rank,
              // A missing key is frozen into the release row ONLY: the item is not rewritten and its version does not move.
              cardKey: releaseCardKey(row),
              mediaId: row.mediaId as number,
              mediaVersion: fact.publishedVersion as number,
              photoSha256: fact.sha256 as string,
              credit: fact.credit,
              deal: { answer: deal.answer, wrong: [...deal.wrong] },
            };
          }),
        );
        await tx.insert(adminAudit).values({
          actor: principal,
          action: "release_create",
          target: RELEASE_MODULE,
          detail: { release: next, itemCount: chosen.length, basis },
          createdAt: now,
        });
        return { ok: true, value: summarise(release, "uploaded") };
      } catch (error) {
        if (error instanceof ApiError) return { ok: false, error }; // every ApiError is raised before the first write
        throw error;
      }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** Make an uploaded release current. Guarded at commit under both locks (a), (b), (c); see `activationGuardErrors`. */
  async activate(version: number, expectedPointerVersion: number, note: string | undefined, principal: string): Promise<ReleaseState> {
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome<void>> => {
      try {
        await lockRelease(tx, RELEASE_MODULE);
        await lockContentModule(tx, RELEASE_MODULE);
        const now = await readContentStamp(tx);
        const pointer = await this.pointer(tx);
        const candidate = await this.release(tx, version);
        const released = candidate ? await this.wasActivated(tx, version) : false;
        const current = pointer.current === null ? undefined : await this.release(tx, pointer.current);
        const plan = planActivate(
          pointer,
          expectedPointerVersion,
          candidate ? { version, basis: candidate.basis, status: released ? "released" : "uploaded" } : undefined,
          current?.basis,
        );
        if ("refusal" in plan) throw refusalError(plan.refusal);

        const frozen = await this.frozenItems(tx, version);
        const rows = await tx
          .select({ id: contentItems.id, status: contentItems.status, version: contentItems.version })
          .from(contentItems)
          .where(and(eq(contentItems.module, RELEASE_MODULE), inArray(contentItems.id, frozen.map((f) => f.itemId))));
        const currentItems = new Map<string, CurrentItem>(rows.map((r) => [r.id, { status: r.status, version: r.version }]));
        const media = await this.mediaFacts(tx, frozen.map((f) => f.mediaId));
        const errors = activationGuardErrors(frozen, currentItems, media);
        if (errors.length > 0) {
          throw new ApiError(409, "version_conflict", `${CHANGED_SINCE_UPLOAD_MESSAGE} Nothing was changed.`, {}, { errors });
        }

        await tx.insert(contentReleaseActivations).values({
          module: RELEASE_MODULE,
          sequence: plan.next.version,
          kind: "activate",
          releaseVersion: version,
          history: plan.next.history,
          createdAt: now,
          createdBy: principal,
          note: cleanNote(note),
        });
        await tx.insert(adminAudit).values({
          actor: principal,
          action: "release_activate",
          target: RELEASE_MODULE,
          detail: { release: version, previous: pointer.current, itemCount: candidate?.itemCount ?? frozen.length, sequence: plan.next.version },
          createdAt: now,
        });
        return { ok: true, value: undefined };
      } catch (error) {
        if (error instanceof ApiError) return { ok: false, error };
        throw error;
      }
    });
    if (!outcome.ok) throw outcome.error;
    return this.state(this.database.db);
  }

  /** Step back: the most recent earlier current becomes current again. Refused when one of its photos is no longer published. */
  async restore(expectedPointerVersion: number, note: string | undefined, principal: string): Promise<ReleaseState> {
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome<void>> => {
      try {
        await lockRelease(tx, RELEASE_MODULE);
        const now = await readContentStamp(tx);
        const pointer = await this.pointer(tx);
        const plan = planRestore(pointer, expectedPointerVersion);
        if ("refusal" in plan) throw refusalError(plan.refusal);
        const target = plan.next.current as number;
        const frozen = await this.frozenItems(tx, target);
        const media = await this.mediaFacts(tx, frozen.map((f) => f.mediaId));
        const errors = restoreGuardErrors(frozen, media);
        if (errors.length > 0) throw invalid(RESTORE_PHOTOS_MESSAGE, errors);

        await tx.insert(contentReleaseActivations).values({
          module: RELEASE_MODULE,
          sequence: plan.next.version,
          kind: "restore",
          releaseVersion: target,
          history: plan.next.history,
          createdAt: now,
          createdBy: principal,
          note: cleanNote(note),
        });
        await tx.insert(adminAudit).values({
          actor: principal,
          action: "release_restore",
          target: RELEASE_MODULE,
          detail: { release: target, replaced: pointer.current, sequence: plan.next.version },
          createdAt: now,
        });
        return { ok: true, value: undefined };
      } catch (error) {
        if (error instanceof ApiError) return { ok: false, error };
        throw error;
      }
    });
    if (!outcome.ok) throw outcome.error;
    return this.state(this.database.db);
  }

  // ---- reads (a transaction or the pool) ----

  private async state(db: Pick<Tx, "select" | "selectDistinct">): Promise<ReleaseState> {
    const pointer = await this.pointer(db);
    const rows = await db
      .select()
      .from(contentReleases)
      .where(eq(contentReleases.module, RELEASE_MODULE))
      .orderBy(desc(contentReleases.version))
      .limit(RELEASES_LISTED);
    const versions = rows.map((r) => r.version);
    const activated = versions.length
      ? await db
          .selectDistinct({ version: contentReleaseActivations.releaseVersion })
          .from(contentReleaseActivations)
          .where(and(eq(contentReleaseActivations.module, RELEASE_MODULE), eq(contentReleaseActivations.kind, "activate"), inArray(contentReleaseActivations.releaseVersion, versions)))
      : [];
    const released = new Set(activated.map((a) => a.version));
    return { pointer, releases: rows.map((r) => summarise(r, released.has(r.version) ? "released" : "uploaded")) };
  }

  private async pointer(db: Pick<Tx, "select" | "selectDistinct">): Promise<Pointer> {
    const [newest] = await db
      .select({ sequence: contentReleaseActivations.sequence, releaseVersion: contentReleaseActivations.releaseVersion, history: contentReleaseActivations.history })
      .from(contentReleaseActivations)
      .where(eq(contentReleaseActivations.module, RELEASE_MODULE))
      .orderBy(desc(contentReleaseActivations.sequence))
      .limit(1);
    return pointerOf(newest);
  }

  private async release(tx: Tx, version: number) {
    const [row] = await tx
      .select()
      .from(contentReleases)
      .where(and(eq(contentReleases.module, RELEASE_MODULE), eq(contentReleases.version, version)));
    return row;
  }

  /** True when an `activate` row names the release: it has been made live once, so it can only be restored, never activated again. */
  private async wasActivated(tx: Tx, version: number): Promise<boolean> {
    const rows = await tx
      .select({ id: contentReleaseActivations.id })
      .from(contentReleaseActivations)
      .where(and(eq(contentReleaseActivations.module, RELEASE_MODULE), eq(contentReleaseActivations.kind, "activate"), eq(contentReleaseActivations.releaseVersion, version)))
      .limit(1);
    return rows.length > 0;
  }

  private async frozenItems(tx: Tx, version: number): Promise<FrozenItem[]> {
    return tx
      .select({
        itemId: contentReleaseItems.itemId,
        itemVersion: contentReleaseItems.itemVersion,
        mediaId: contentReleaseItems.mediaId,
        mediaVersion: contentReleaseItems.mediaVersion,
        photoSha256: contentReleaseItems.photoSha256,
      })
      .from(contentReleaseItems)
      .where(and(eq(contentReleaseItems.module, RELEASE_MODULE), eq(contentReleaseItems.releaseVersion, version)))
      .orderBy(asc(contentReleaseItems.position));
  }

  /**
   * The photos, locked FOR SHARE in id order (a fixed order, so two transactions cannot deadlock), with the hash and credit of the
   * PUBLISHED version. Only the media row is locked: `media_versions` rows are never changed.
   */
  private async mediaFacts(tx: Tx, ids: readonly number[]): Promise<Map<number, MediaFact>> {
    const unique = [...new Set(ids)].sort((a, b) => a - b);
    if (unique.length === 0) return new Map();
    const rows = await tx
      .select({
        id: mediaItems.id,
        state: mediaItems.state,
        publishedVersion: mediaItems.publishedVersion,
        owner: mediaItems.owner,
        sha256: mediaVersions.sha256,
        credit: mediaVersions.creditName,
      })
      .from(mediaItems)
      .leftJoin(mediaVersions, and(eq(mediaVersions.mediaId, mediaItems.id), eq(mediaVersions.version, mediaItems.publishedVersion)))
      .where(inArray(mediaItems.id, unique))
      .orderBy(asc(mediaItems.id))
      .for("share", { of: mediaItems });
    return new Map(
      rows.map((r) => [r.id, { id: r.id, state: r.state, publishedVersion: r.publishedVersion, ownerIsDemo: isDemoPrincipal(this.config, r.owner), sha256: r.sha256, credit: r.credit }]),
    );
  }
}

function summarise(row: { version: number; basis: string; itemCount: number; createdAt: Date; note: string | null }, status: ReleaseStatus): ReleaseSummary {
  return { number: row.version, basis: row.basis, aircraft: row.itemCount, createdAt: row.createdAt.toISOString(), note: row.note, status };
}
