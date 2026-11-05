import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { isDemoPrincipal } from "../../accounts/account-principal.js";
import { ApiError } from "../../common/errors.js";
import { APP_CONFIG } from "../../config/config.module.js";
import type { AppConfig } from "../../config/config.module.js";
import { databaseNow } from "../../database/clock.js";
import { DatabaseService } from "../../database/database.module.js";
import type { Tx } from "../../database/database.module.js";
import type { EditorialKind, EditorialStatus } from "../../db/enums.js";
import { adminAudit, editorialItems, mediaItems, mediaVersions } from "../../db/schema.js";
import { canonicalJson } from "../import-plan.js";
import { mediaIdOf } from "../media/media-view.js";
import {
  EDITORIAL_LIST_LIMIT,
  blankEditorialData,
  changedFields,
  dateKeyErrors,
  formatEditorialId,
  normaliseEditorialData,
  publishErrors,
} from "./editorial-rules.js";
import type { EditorialData } from "./editorial-rules.js";
import { toEditorialView, toPublicFeature } from "./editorial-view.js";
import type { EditorialItemView, PublicFeatureView } from "./editorial-view.js";
import { parseTimeZone, viewerDay } from "./local-day.js";

/** What the public read returns at most (pagination deferred). */
export const PUBLIC_FEATURE_LIMIT = 100;

export type EditorialSave = { version: number; status: EditorialStatus; data: unknown; dateKey: string | null };
export type EditorialChange = { changed: boolean; item: EditorialItemView };

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ApiError };

const notFound = () => new ApiError(404, "not_found", "No such item.");

/** 422 `content_invalid`; the reasons are in `errors[]` next to `error`. */
function invalid(errors: string[]): ApiError {
  return new ApiError(422, "content_invalid", `The item is not valid: ${errors.join(" ")} Nothing was changed.`, {}, { errors });
}

/**
 * The staff editorial desks (Aircraft Identifier and Plane of the Day; docs/plans/website-content.md W1) and the public Plane of
 * the Day read. Each write is one transaction with a version compare-and-set (`UPDATE ... WHERE version = expected` is repeated on
 * the write), one `admin_audit` row, and a database-clock stamp. Expected refusals are returned, not thrown, so the connection goes
 * back to the pool (as `ContentItemEditService.run`). There are no usage offers (ruling WC-1): "the photo is published, not owned
 * by the demo account, and its licence credit is set" is the whole photo rule. Lock order is item FOR UPDATE, then media FOR SHARE;
 * the media service never takes an editorial lock, so the two cannot deadlock.
 */
@Injectable()
export class EditorialService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The desk list: newest `updated_at` first, at most EDITORIAL_LIST_LIMIT (ASSUMPTION). */
  async list(kind: EditorialKind): Promise<EditorialItemView[]> {
    const rows = await this.database.db
      .select()
      .from(editorialItems)
      .where(eq(editorialItems.kind, kind))
      .orderBy(desc(editorialItems.updatedAt), desc(editorialItems.id))
      .limit(EDITORIAL_LIST_LIMIT);
    return rows.map(toEditorialView);
  }

  /**
   * Create a draft v1 for `mediaId`, which is fixed for the item's life. The media is read FOR SHARE: it must exist, be published
   * and not be demo-owned. `data` absent stores the blank shape; nothing is prefilled from the media.
   */
  async create(kind: EditorialKind, mediaId: number, data: unknown, principal: string): Promise<EditorialItemView> {
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome<EditorialItemView>> => {
      try {
        const shape = data === undefined ? { data: blankEditorialData(), errors: [] as string[] } : normaliseEditorialData(data);
        const problems = await this.mediaProblems(tx, mediaId, false);
        const errors = [...problems, ...shape.errors];
        if (errors.length > 0 || shape.data === null) return { ok: false, error: invalid(errors) };
        const now = await databaseNow(tx);
        const [row] = await tx
          .insert(editorialItems)
          .values({ kind, mediaId, status: "draft", dateKey: null, data: shape.data, version: 1, createdAt: now, updatedAt: now, createdBy: principal, updatedBy: principal })
          .returning();
        if (!row) throw new Error("Editorial item was not stored.");
        await tx.insert(adminAudit).values({
          actor: principal,
          action: "editorial_create",
          target: kind,
          detail: { id: formatEditorialId(row.id), mediaId: mediaIdOf(mediaId) },
          createdAt: now,
        });
        return { ok: true, value: toEditorialView(row) };
      } catch (error) {
        if (error instanceof ApiError) return { ok: false, error }; // raised before the first write
        throw error;
      }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * Save the whole editable state (status, data, dateKey) of one item. The item is locked FOR UPDATE first: a different kind is
   * 404, a stale `version` is 409 `version_conflict`. Then every problem is collected (422 `content_invalid`, `errors[]`); a
   * scheduled or published item also needs the photo rule. A save that changes nothing writes nothing: no bump, no audit row.
   */
  async save(kind: EditorialKind, id: number, change: EditorialSave, principal: string): Promise<EditorialChange> {
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome<EditorialChange>> => {
      try {
        const [stored] = await tx.select().from(editorialItems).where(eq(editorialItems.id, id)).for("update");
        if (!stored || stored.kind !== kind) return { ok: false, error: notFound() };
        if (stored.version !== change.version) {
          return {
            ok: false,
            error: new ApiError(409, "version_conflict", `The item is at version ${stored.version}, not ${change.version}. Reload it and apply the change again. Nothing was changed.`),
          };
        }
        const shape = normaliseEditorialData(change.data);
        const errors = [...shape.errors, ...dateKeyErrors(kind, change.dateKey)];
        if (shape.data !== null) {
          errors.push(...publishErrors(kind, change.status, shape.data, change.dateKey));
          if (change.status === "scheduled" || change.status === "published") errors.push(...(await this.mediaProblems(tx, stored.mediaId, true)));
        }
        if (errors.length > 0 || shape.data === null) return { ok: false, error: invalid(errors) };
        const before = stored.data as EditorialData;
        const unchanged =
          stored.status === change.status && stored.dateKey === change.dateKey && canonicalJson(before) === canonicalJson(shape.data);
        if (unchanged) return { ok: true, value: { changed: false, item: toEditorialView(stored) } };
        const now = await databaseNow(tx);
        const [row] = await tx
          .update(editorialItems)
          .set({
            status: change.status,
            dateKey: change.dateKey,
            data: shape.data,
            version: sql`${editorialItems.version} + 1`,
            updatedAt: now,
            updatedBy: principal,
          })
          .where(and(eq(editorialItems.id, id), eq(editorialItems.version, stored.version)))
          .returning();
        if (!row) throw new Error("Editorial item update was not stored."); // the row lock makes this unreachable
        const fields = [
          ...(stored.status !== change.status ? ["status"] : []),
          ...(stored.dateKey !== change.dateKey ? ["dateKey"] : []),
          ...changedFields(before, shape.data).map((f) => `data.${f}`),
        ];
        await tx.insert(adminAudit).values({
          actor: principal,
          action: "editorial_save",
          target: kind,
          detail: {
            id: formatEditorialId(id),
            fromVersion: stored.version,
            version: row.version,
            fromStatus: stored.status,
            status: change.status,
            fromDateKey: stored.dateKey,
            dateKey: change.dateKey,
            fields,
          },
          createdAt: now,
        });
        return { ok: true, value: { changed: true, item: toEditorialView(row) } };
      } catch (error) {
        if (error instanceof ApiError) return { ok: false, error };
        throw error;
      }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * The Plane of the Day features a viewer in `timeZone` may see (default UTC): scheduled or published items dated on or before the
   * viewer's day, whose media is published, not demo-owned and has a licence credit. One read, so the answer is one snapshot. The
   * day is computed here from ONE database instant (never a client clock) and clamped to the furthest-ahead zone's date.
   */
  async planeOfTheDay(timeZone: string | undefined): Promise<{ day: string; features: PublicFeatureView[] }> {
    const zone = parseTimeZone(timeZone ?? "UTC");
    if (zone === undefined) throw new ApiError(400, "invalid_request", "timeZone must be an IANA time zone name such as Europe/London, not an offset.");
    const now = await databaseNow(this.database.db);
    const day = viewerDay(zone, now);
    const demo = this.config.demoPrincipal;
    const rows = await this.database.db
      .select({ item: editorialItems, version: mediaVersions })
      .from(editorialItems)
      .innerJoin(mediaItems, eq(mediaItems.id, editorialItems.mediaId))
      .innerJoin(mediaVersions, and(eq(mediaVersions.mediaId, mediaItems.id), eq(mediaVersions.version, mediaItems.publishedVersion)))
      .where(
        and(
          eq(editorialItems.kind, "plane-of-the-day"),
          inArray(editorialItems.status, ["scheduled", "published"]),
          lte(editorialItems.dateKey, day),
          eq(mediaItems.state, "published"),
          demo === undefined ? undefined : sql`${mediaItems.owner} <> ${demo}`,
          sql`${mediaVersions.creditName} ~ '[^[:space:]]'`,
        ),
      )
      .orderBy(desc(editorialItems.dateKey), desc(editorialItems.updatedAt), desc(editorialItems.id))
      .limit(PUBLIC_FEATURE_LIMIT);
    return { day, features: rows.map((r) => toPublicFeature(r.item, r.version, this.config.cdn, now)) };
  }

  /**
   * Why `mediaId` cannot be used now. Reads the media row FOR SHARE (a concurrent withdraw or licence edit waits for this
   * transaction, and the other way round). The shared rule of create (published, not demo-owned) and of a scheduled or published
   * save (also: the published version's licence credit is set).
   */
  private async mediaProblems(tx: Tx, mediaId: number, needCredit: boolean): Promise<string[]> {
    const [media] = await tx.select().from(mediaItems).where(eq(mediaItems.id, mediaId)).for("share");
    if (!media) return ["No such media item."];
    const problems: string[] = [];
    const published = media.state === "published" && media.publishedVersion !== null;
    if (!published) problems.push("The linked photo must be a published photo.");
    if (isDemoPrincipal(this.config, media.owner)) problems.push("The linked photo belongs to the shared demo account and cannot be used.");
    if (needCredit && published) {
      const [version] = await tx
        .select({ credit: mediaVersions.creditName })
        .from(mediaVersions)
        .where(and(eq(mediaVersions.mediaId, mediaId), eq(mediaVersions.version, media.publishedVersion as number)));
      if (!version || (version.credit ?? "").trim() === "") problems.push("The linked photo's licence needs a credit before it can be shown publicly.");
    }
    return problems;
  }
}
