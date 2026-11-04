import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { APP_CONFIG } from "../../config/config.module.js";
import type { AppConfig } from "../../config/config.module.js";
import { ApiError } from "../../common/errors.js";
import { DatabaseService, ExpectedRollback } from "../../database/database.module.js";
import type { Database, Tx } from "../../database/database.module.js";
import { databaseNow } from "../../database/clock.js";
import type { MediaPublishableRights } from "../../db/enums.js";
import { adminAudit, mediaItems, mediaUploadKeys, mediaVersions } from "../../db/schema.js";
import { BLOB_STORE, StorageUnavailableError } from "../../storage/blob-store.js";
import { storageApiError } from "../import-blob.js";
import type { BlobStore } from "../../storage/blob-store.js";
import { sniffImage } from "./image-sniff.js";
import { toImageRef } from "./image-ref.js";
import type { ImageRefView } from "./image-ref.js";
import { mediaIdOf, toItemView, toVersionView } from "./media-view.js";
import type { MediaItemRow, MediaItemView, MediaVersionRow, MediaVersionView } from "./media-view.js";

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const MEDIA_CONTENT_TYPES_ACCEPTED = ["image/jpeg", "image/png"] as const;
const EXTENSION = { "image/jpeg": "jpg", "image/png": "png" } as const;

/** What a PATCH may change: licence fields and/or the description (`null` clears it; an absent key keeps the stored value). */
export type MediaEdit = { licence?: MediaLicenceEdit | undefined; description?: string | null | undefined };

/** An image that passed `MediaService.checkImage`. */
export type CheckedImage = { sha256: string; contentType: "image/jpeg" | "image/png"; width: number; height: number; byteSize: number };

export type MediaUploadResult ={ item: MediaItemView; replayed: boolean };

/** The licence fields a PATCH may change; an absent key keeps the stored value and `null` clears it. */
export type MediaLicenceEdit = {
  credit?: string | null | undefined;
  licenceName?: string | null | undefined;
  licenceUrl?: string | null | undefined;
  sourceUrl?: string | null | undefined;
  attributionText?: string | null | undefined;
  creditRequired?: boolean | undefined;
};

const PUBLISHABLE_RIGHTS: readonly string[] = ["v1_own", "v1_authorised"] satisfies readonly MediaPublishableRights[];

/** The result of a write that can be refused. Refusals are returned (not thrown) from inside a transaction. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/** Licence field name -> column of `media_versions`. */
const LICENCE_COLUMNS = {
  credit: "creditName",
  licenceName: "licenceName",
  licenceUrl: "licenceUrl",
  sourceUrl: "sourceUrl",
  attributionText: "attributionText",
  creditRequired: "creditRequired",
} as const;
type LicenceField = keyof typeof LICENCE_COLUMNS;
const LICENCE_FIELDS = Object.keys(LICENCE_COLUMNS) as LicenceField[];

/** A concurrent request with the same (principal, Idempotency-Key) won the unique insert: roll this one back and replay. */
class KeyAlreadyClaimed extends ExpectedRollback {}

export type MediaListView = { items: MediaItemView[]; nextCursor: string | null };
export type MediaDetailView = { item: MediaItemView; versions: MediaVersionView[]; preview: ImageRefView };

const CURSOR = /^m1\.([a-z]+|-)\.([1-9][0-9]{0,14})$/;

/** Opaque to clients: base64url of `m1.<state or ->.<last id>`. */
function encodeCursor(lastId: number, state: string | undefined): string {
  return Buffer.from(`m1.${state ?? "-"}.${lastId}`).toString("base64url");
}

/** The last id, or undefined when the text is not a cursor made under this state filter. */
function decodeCursor(cursor: string, state: string | undefined): number | undefined {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(cursor)) return undefined;
  const match = CURSOR.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match || match[1] !== (state ?? "-")) return undefined;
  const id = Number(match[2]);
  return encodeCursor(id, state) === cursor ? id : undefined; // refuses non-canonical base64url spellings
}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const notFound = () => new ApiError(404, "not_found", "No such media item.");

/** A caller who may see the item but does not own it: file uploads and rights statements are the owner's alone. */
const notOwner = (isAdmin: boolean) =>
  isAdmin ? new ApiError(403, "forbidden", "Only the photographer who owns this item can upload files or state rights for it.") : notFound();

const staleRevision = (item: MediaItemRow, expected: number) =>
  new ApiError(
    409,
    "version_conflict",
    `The item is ${item.state} at revision ${item.revision}, not ${expected}. Reload it and decide again. Nothing was changed.`,
  );

/** Staff media (plan docs/plans/media-pipeline.md, ADR-0001). T3: upload a new item. T4: new version, licence edit, publish, withdraw. */
@Injectable()
export class MediaService {
  private readonly logger = new Logger("Media");

  constructor(
    private readonly database: DatabaseService,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * One page of items, newest first (by id, which never changes, so new uploads cannot shift a page). A non-admin sees only their
   * own. The cursor names the last id returned and the state filter it was made under; anything else is 400.
   */
  async list(
    principal: string,
    isAdmin: boolean,
    state: MediaItemRow["state"] | undefined,
    cursor: string | undefined,
    limit: number,
    pending = false,
  ): Promise<MediaListView> {
    // `pending` (published items whose draft is ahead of the published version) is its own cursor filter key.
    const filterKey = pending ? "pending" : state;
    let before: number | undefined;
    if (cursor !== undefined) {
      before = decodeCursor(cursor, filterKey);
      if (before === undefined) throw new ApiError(400, "invalid_request", "Not a cursor this route returned (or the state filter changed). Start again without cursor.");
    }
    const rows = await this.database.db
      .select({ item: mediaItems, draft: mediaVersions })
      .from(mediaItems)
      .innerJoin(mediaVersions, and(eq(mediaVersions.mediaId, mediaItems.id), eq(mediaVersions.version, mediaItems.draftVersion)))
      .where(
        and(
          isAdmin ? undefined : eq(mediaItems.owner, principal),
          pending ? eq(mediaItems.state, "published") : state === undefined ? undefined : eq(mediaItems.state, state),
          pending ? sql`${mediaItems.draftVersion} > ${mediaItems.publishedVersion}` : undefined,
          before === undefined ? undefined : lt(mediaItems.id, before),
        ),
      )
      .orderBy(desc(mediaItems.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toItemView(r.item, r.draft, isAdmin)),
      nextCursor: rows.length > limit && last ? encodeCursor(last.item.id, filterKey) : null,
    };
  }

  /** One item, every version (oldest first) and a preview link for the draft, signed in any state. 404 for another's item (non-admin). */
  async get(principal: string, mediaId: number, isAdmin: boolean): Promise<MediaDetailView> {
    const [item] = await this.database.db.select().from(mediaItems).where(eq(mediaItems.id, mediaId)).limit(1);
    if (!item || (!isAdmin && item.owner !== principal)) throw notFound();
    // Versions are only ever added, so reading them after the item always includes the item's draft.
    const versions = await this.database.db.select().from(mediaVersions).where(eq(mediaVersions.mediaId, mediaId)).orderBy(asc(mediaVersions.version));
    const draft = versions.find((v) => v.version === item.draftVersion);
    if (!draft) throw new Error("Media item names a missing version.");
    const now = await databaseNow(this.database.db);
    return {
      item: toItemView(item, draft, isAdmin),
      versions: versions.map((v) => toVersionView(v, isAdmin)),
      preview: toImageRef(mediaId, draft, this.config.cdn, now),
    };
  }

  /**
   * The PUBLISHED version of each requested item that is published, in the order of `ids` (already de-duplicated). Others are
   * absent. One read joins the item to its published version; links are signed per file against one database instant.
   */
  async published(ids: readonly number[]): Promise<ImageRefView[]> {
    if (ids.length === 0) return [];
    const rows = await this.database.db
      .select({ id: mediaItems.id, version: mediaVersions })
      .from(mediaItems)
      .innerJoin(mediaVersions, and(eq(mediaVersions.mediaId, mediaItems.id), eq(mediaVersions.version, mediaItems.publishedVersion)))
      .where(and(inArray(mediaItems.id, [...ids]), eq(mediaItems.state, "published")));
    const byId = new Map(rows.map((r) => [r.id, r.version]));
    const now = await databaseNow(this.database.db);
    const refs: ImageRefView[] = [];
    for (const id of ids) {
      const version = byId.get(id);
      if (version) refs.push(toImageRef(id, version, this.config.cdn, now));
    }
    return refs;
  }

  /**
   * Create a media item from raw image bytes. The Idempotency-Key is looked up FIRST (this route has no revision fence): a
   * stored key with the same operation and bytes replays the item as it is now (200); any other use of the key is 422
   * `idempotency_key_reused`. Otherwise: sniff, store the file under its digest, read it back and compare, then ONE
   * transaction inserts the item and version 1, claims the key (the unique insert decides a concurrent duplicate) and writes
   * the audit row. Storage trouble is 503 `storage_unavailable` before anything is written to the database.
   */
  async create(
    principal: string,
    key: string,
    bytes: Uint8Array,
    declaredType: string,
    includeOwner: boolean,
    statement: MediaPublishableRights,
  ): Promise<MediaUploadResult> {
    const sha256 = sha256Of(bytes);
    const claimed = await this.findClaim(this.database.db, principal, key);
    if (claimed) return this.replay(claimed, "create", null, sha256, includeOwner, statement);

    const image = this.inspect(bytes, declaredType);
    await this.store(`content/photos/${sha256}.${EXTENSION[image.contentType]}`, bytes, image.contentType, sha256);
    const { contentType, width, height } = image;

    try {
      const created = await this.database.withTransaction(async (tx) => {
        const now = await databaseNow(tx);
        const [item] = await tx
          .insert(mediaItems)
          .values({
            owner: principal,
            state: "unverified",
            draftVersion: 1,
            publishedVersion: null,
            createdBy: principal,
            updatedBy: principal,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!item) throw new Error("Media item was not stored.");
        const version = await this.insertVersion(tx, {
          mediaId: item.id,
          version: 1,
          sha256,
          contentType,
          byteSize: bytes.length,
          width,
          height,
          // A licence starts empty. Credit is required until staff decide otherwise, so an unfilled item cannot be published
          // without a credit by accident.
          creditRequired: true,
          // Sending the header is the uploader's consent to the statement (docs/plans/media-rights-and-public.md).
          rightsStatement: statement,
          rightsStatedBy: principal,
          rightsStatedAt: now,
          createdBy: principal,
          createdAt: now,
        });
        await this.claimKey(tx, { principal, idempotencyKey: key, operation: "create", mediaId: item.id, version: 1, sha256, createdAt: now });
        await tx.insert(adminAudit).values({
          actor: principal,
          action: "media_upload",
          target: mediaIdOf(item.id),
          detail: { mediaId: mediaIdOf(item.id), version: 1, sha256, contentType, byteSize: bytes.length, width, height, rightsStatement: statement },
          createdAt: now,
        });
        return toItemView(item, version, includeOwner);
      });
      return { item: created, replayed: false };
    } catch (error) {
      if (!(error instanceof KeyAlreadyClaimed)) throw error;
      // Lost the race: the winner's transaction has committed, so its key is visible now.
      const winner = await this.findClaim(this.database.db, principal, key);
      if (!winner) throw this.retryShortly();
      return this.replay(winner, "create", null, sha256, includeOwner, statement);
    }
  }

  /**
   * Add a new file version to an item. OWNER ONLY (user 2026-11-04): another photographer's item is 404, and an admin who is not
   * the owner gets 403 `forbidden`. Order: the
   * Idempotency-Key first (a replay needs the same operation, item and bytes, else 422 `idempotency_key_reused`; it answers
   * even after the item's revision has moved on), then visibility (404), then the `revision` fence (409), then the image
   * check and storage (503 before any database write). One transaction then re-reads the item under its row lock, re-checks the
   * fence, inserts the version (empty licence, `creditRequired` true, the previous draft's description, the uploader's rights
   * statement), claims the key, moves the draft pointer and audits.
   * The published version, the state and the live credit do not change.
   */
  async addVersion(
    principal: string,
    key: string,
    mediaId: number,
    expectedRevision: number,
    bytes: Uint8Array,
    declaredType: string,
    isAdmin: boolean,
    statement: MediaPublishableRights,
  ): Promise<MediaUploadResult> {
    const sha256 = sha256Of(bytes);
    const claimed = await this.findClaim(this.database.db, principal, key);
    if (claimed) return this.replay(claimed, "version", mediaId, sha256, isAdmin, statement);

    const [seen] = await this.database.db.select().from(mediaItems).where(eq(mediaItems.id, mediaId)).limit(1);
    if (!seen) throw notFound();
    if (seen.owner !== principal) throw notOwner(isAdmin);
    if (seen.revision !== expectedRevision) {
      // A twin of this request may have committed between the key lookup above and this read: that is a replay, not a conflict.
      const twin = await this.findClaim(this.database.db, principal, key);
      if (twin) return this.replay(twin, "version", mediaId, sha256, isAdmin, statement);
      throw staleRevision(seen, expectedRevision);
    }

    const image = this.inspect(bytes, declaredType);
    await this.store(`content/photos/${sha256}.${EXTENSION[image.contentType]}`, bytes, image.contentType, sha256);
    const { contentType, width, height } = image;

    try {
      const outcome = await this.database.withTransaction(async (tx): Promise<Outcome<MediaItemView>> => {
        const item = await this.lockItem(tx, mediaId, principal, true);
        if (!item) return { ok: false, error: notFound() };
        if (item.owner !== principal) return { ok: false, error: notOwner(isAdmin) };
        // A duplicate that waited on the row lock sees the winner's committed key here and replays instead of conflicting: the key
        // is decided before the fence, as on the unlocked path above.
        if (await this.findClaim(tx, principal, key)) throw new KeyAlreadyClaimed();
        if (item.revision !== expectedRevision) return { ok: false, error: staleRevision(item, expectedRevision) };
        const now = await databaseNow(tx);
        const version = item.draftVersion + 1;
        const previous = await this.readVersion(tx, mediaId, item.draftVersion);
        const row = await this.insertVersion(tx, {
          mediaId,
          version,
          sha256,
          contentType,
          byteSize: bytes.length,
          width,
          height,
          creditRequired: true,
          description: previous.description, // the licence starts empty; the description carries forward (user 2026-11-04)
          rightsStatement: statement,
          rightsStatedBy: principal,
          rightsStatedAt: now,
          createdBy: principal,
          createdAt: now,
        });
        await this.claimKey(tx, { principal, idempotencyKey: key, operation: "version", mediaId, version, sha256, createdAt: now });
        const updated = await this.bump(tx, item, principal, now, { draftVersion: version });
        await tx.insert(adminAudit).values({
          actor: principal,
          action: "media_version",
          target: mediaIdOf(mediaId),
          detail: {
            mediaId: mediaIdOf(mediaId),
            version,
            previousDraftVersion: item.draftVersion,
            revision: updated.revision,
            sha256,
            contentType,
            byteSize: bytes.length,
            width,
            height,
            rightsStatement: statement,
          },
          createdAt: now,
        });
        return { ok: true, value: toItemView(updated, row, isAdmin) };
      });
      if (!outcome.ok) throw outcome.error;
      return { item: outcome.value, replayed: false };
    } catch (error) {
      if (!(error instanceof KeyAlreadyClaimed)) throw error;
      const winner = await this.findClaim(this.database.db, principal, key);
      if (!winner) throw this.retryShortly();
      return this.replay(winner, "version", mediaId, sha256, isAdmin, statement);
    }
  }

  /**
   * Edit the draft version's licence and/or description. The live (published) version is never touched: when the draft IS the published version,
   * or the draft was live once before (a withdrawn item), the edit makes a NEW draft version with the same file (version + 1);
   * otherwise the unpublished draft is edited in place. A new version copies the rights statement (an edit never changes it).
   * Stored values sent back are a no-op: 200, no change, no new revision.
   */
  async edit(
    principal: string,
    mediaId: number,
    isAdmin: boolean,
    expectedRevision: number,
    wanted: MediaEdit,
    note: string | null,
  ): Promise<MediaItemView> {
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome<MediaItemView>> => {
      const item = await this.lockItem(tx, mediaId, principal, isAdmin);
      if (!item) return { ok: false, error: notFound() };
      if (item.revision !== expectedRevision) return { ok: false, error: staleRevision(item, expectedRevision) };
      const draft = await this.readVersion(tx, mediaId, item.draftVersion);

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const merged: Record<string, unknown> = {};
      for (const field of LICENCE_FIELDS) {
        const column = LICENCE_COLUMNS[field];
        const from = draft[column];
        const asked = wanted.licence?.[field];
        const to = asked === undefined ? from : asked;
        merged[column] = to;
        if (to !== from) changes[field] = { from, to };
      }
      const description = wanted.description === undefined ? draft.description : wanted.description;
      merged.description = description;
      if (description !== draft.description) changes.description = { from: draft.description, to: description };
      if (!isAdmin && changes.creditRequired) {
        return { ok: false, error: new ApiError(403, "forbidden", "Only an admin can change creditRequired. Nothing was changed.") };
      }
      if (Object.keys(changes).length === 0) return { ok: true, value: toItemView(item, draft, isAdmin) };

      const now = await databaseNow(tx);
      let updatedDraft: MediaVersionRow;
      let updatedItem: MediaItemRow;
      const newVersion = item.draftVersion === item.publishedVersion || draft.publishedAt !== null;
      if (newVersion) {
        updatedDraft = await this.insertVersion(tx, {
          mediaId,
          version: item.draftVersion + 1,
          sha256: draft.sha256,
          contentType: draft.contentType,
          byteSize: draft.byteSize,
          width: draft.width,
          height: draft.height,
          creditName: merged.creditName as string | null,
          creditRequired: merged.creditRequired as boolean,
          licenceName: merged.licenceName as string | null,
          licenceUrl: merged.licenceUrl as string | null,
          sourceUrl: merged.sourceUrl as string | null,
          attributionText: merged.attributionText as string | null,
          description,
          rightsStatement: draft.rightsStatement,
          rightsStatedBy: draft.rightsStatedBy,
          rightsStatedAt: draft.rightsStatedAt,
          createdBy: principal,
          createdAt: now,
        });
        updatedItem = await this.bump(tx, item, principal, now, { draftVersion: item.draftVersion + 1 });
      } else {
        const [row] = await tx
          .update(mediaVersions)
          .set(merged)
          .where(and(eq(mediaVersions.mediaId, mediaId), eq(mediaVersions.version, item.draftVersion)))
          .returning();
        if (!row) throw new Error("Media version was not updated.");
        updatedDraft = row;
        updatedItem = await this.bump(tx, item, principal, now, {});
      }
      await tx.insert(adminAudit).values({
        actor: principal,
        action: "media_edit",
        target: mediaIdOf(mediaId),
        detail: {
          mediaId: mediaIdOf(mediaId),
          fromVersion: item.draftVersion,
          version: updatedDraft.version,
          newVersion,
          revision: updatedItem.revision,
          changes,
          note,
        },
        createdAt: now,
      });
      return { ok: true, value: toItemView(updatedItem, updatedDraft, isAdmin) };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * Admin: make the draft version the published one (its licence is frozen with it). 409 `version_conflict` for a stale
   * revision, 409 `nothing_to_publish` when the draft already is the published version, 422 `content_invalid` when the
   * draft's licence is not publishable. Nothing is written on a refusal.
   */
  async publish(principal: string, mediaId: number, expectedRevision: number): Promise<MediaItemView> {
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome<MediaItemView>> => {
      const item = await this.lockItem(tx, mediaId, principal, true);
      if (!item) return { ok: false, error: notFound() };
      if (item.revision !== expectedRevision) return { ok: false, error: staleRevision(item, expectedRevision) };
      if (item.publishedVersion === item.draftVersion) {
        return { ok: false, error: new ApiError(409, "nothing_to_publish", "The draft is already the published version; nothing to publish.") };
      }
      const draft = await this.readVersion(tx, mediaId, item.draftVersion);
      if (!draft.licenceName) {
        return { ok: false, error: new ApiError(422, "content_invalid", "The draft's licence needs a licence name before it can be published.") };
      }
      if (draft.creditRequired && !draft.creditName) {
        return { ok: false, error: new ApiError(422, "content_invalid", "The draft's licence needs a credit (credit is required) before it can be published.") };
      }
      // Checked before any UPDATE of a version row: a pre-0019 row without a statement would otherwise hit the publishable CHECK
      // (NOT VALID, but still enforced on update), a 23514 that would surface as a 500.
      if (draft.rightsStatement === null || !PUBLISHABLE_RIGHTS.includes(draft.rightsStatement)) {
        return { ok: false, error: new ApiError(422, "content_invalid", "The photographer's rights statement is missing; it must be stated before the draft can be published.") };
      }
      const now = await databaseNow(tx);
      const [published] = await tx
        .update(mediaVersions)
        // The FIRST go-live time is kept when a withdrawn draft is published again.
        .set({ publishedAt: sql`COALESCE(${mediaVersions.publishedAt}, ${now.toISOString()}::timestamptz)` })
        .where(and(eq(mediaVersions.mediaId, mediaId), eq(mediaVersions.version, draft.version)))
        .returning();
      if (!published) throw new Error("Media version was not published.");
      const updated = await this.bump(tx, item, principal, now, { state: "published", publishedVersion: draft.version });
      await tx.insert(adminAudit).values({
        actor: principal,
        action: "media_publish",
        target: mediaIdOf(mediaId),
        detail: {
          mediaId: mediaIdOf(mediaId),
          fromState: item.state,
          previousPublishedVersion: item.publishedVersion,
          publishedVersion: draft.version,
          revision: updated.revision,
          sha256: draft.sha256,
        },
        createdAt: now,
      });
      return { ok: true, value: toItemView(updated, published, true) };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** Admin: `published` to `withdrawn` (`publishedVersion` becomes null). Any other state, or a stale revision, is 409 `version_conflict`. */
  async withdraw(principal: string, mediaId: number, expectedRevision: number): Promise<MediaItemView> {
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome<MediaItemView>> => {
      const item = await this.lockItem(tx, mediaId, principal, true);
      if (!item) return { ok: false, error: notFound() };
      if (item.revision !== expectedRevision) return { ok: false, error: staleRevision(item, expectedRevision) };
      if (item.state !== "published") {
        return {
          ok: false,
          error: new ApiError(409, "version_conflict", `The item is ${item.state} at revision ${item.revision}; only a published item can be withdrawn. Nothing was changed.`),
        };
      }
      const draft = await this.readVersion(tx, mediaId, item.draftVersion);
      const now = await databaseNow(tx);
      const updated = await this.bump(tx, item, principal, now, { state: "withdrawn", publishedVersion: null });
      await tx.insert(adminAudit).values({
        actor: principal,
        action: "media_withdraw",
        target: mediaIdOf(mediaId),
        detail: { mediaId: mediaIdOf(mediaId), fromState: item.state, withdrawnVersion: item.publishedVersion, revision: updated.revision },
        createdAt: now,
      });
      return { ok: true, value: toItemView(updated, draft, true) };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * State the rights for the DRAFT of an item that has none yet (an imported photo, or a pre-0019 row). Owner only: another
   * photographer's item is 404, an admin who is not the owner gets 403 `forbidden`. Then the revision fence (409
   * `version_conflict`), then eligibility: the draft's statement must be null or `d1_private_review` and the draft must never have been
   * published, else 409 `rights_already_stated`. Written in place; the revision moves.
   */
  async setRights(principal: string, mediaId: number, isAdmin: boolean, expectedRevision: number, statement: MediaPublishableRights): Promise<MediaItemView> {
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome<MediaItemView>> => {
      const item = await this.lockItem(tx, mediaId, principal, isAdmin);
      if (!item) return { ok: false, error: notFound() };
      if (item.owner !== principal) return { ok: false, error: notOwner(isAdmin) };
      if (item.revision !== expectedRevision) return { ok: false, error: staleRevision(item, expectedRevision) };
      const draft = await this.readVersion(tx, mediaId, item.draftVersion);
      const open = draft.rightsStatement === null || draft.rightsStatement === "d1_private_review";
      const neverPublished = item.draftVersion !== item.publishedVersion && draft.publishedAt === null;
      if (!open || !neverPublished) {
        return {
          ok: false,
          error: new ApiError(409, "rights_already_stated", "The draft already has a rights statement or has been published; a statement cannot be changed. Nothing was changed."),
        };
      }
      const now = await databaseNow(tx);
      const [row] = await tx
        .update(mediaVersions)
        .set({ rightsStatement: statement, rightsStatedBy: principal, rightsStatedAt: now })
        .where(and(eq(mediaVersions.mediaId, mediaId), eq(mediaVersions.version, item.draftVersion)))
        .returning();
      if (!row) throw new Error("Media version was not updated.");
      const updated = await this.bump(tx, item, principal, now, {});
      await tx.insert(adminAudit).values({
        actor: principal,
        action: "media_rights",
        target: mediaIdOf(mediaId),
        detail: {
          mediaId: mediaIdOf(mediaId),
          version: row.version,
          statement,
          previousStatement: draft.rightsStatement,
          revision: updated.revision,
        },
        createdAt: now,
      });
      return { ok: true, value: toItemView(updated, row, isAdmin) };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * The upload checks without any write, for callers that do not go through the HTTP body parser (the D1 import command): at most
   * 5 MB, a JPEG or PNG by its bytes (not its name), the declared type equal to the sniffed one, each side within the limit.
   * Throws 422 `media_invalid`. Returns what a version row needs, plus the digest.
   */
  checkImage(bytes: Uint8Array, declaredType: string): CheckedImage {
    if (bytes.length > MAX_MEDIA_BYTES) throw new ApiError(422, "media_invalid", `The file is larger than ${MAX_MEDIA_BYTES} bytes.`);
    const { contentType, width, height } = this.inspect(bytes, declaredType);
    return { sha256: sha256Of(bytes), contentType, width, height, byteSize: bytes.length };
  }

  /** Put a checked image under its digest and read it back (the same `store` the upload routes use). 503 on any storage trouble. */
  async storeImage(bytes: Uint8Array, image: CheckedImage): Promise<void> {
    await this.store(`content/photos/${image.sha256}.${EXTENSION[image.contentType]}`, bytes, image.contentType, image.sha256);
  }

  // ---- helpers ----

  private inspect(bytes: Uint8Array, declaredType: string) {
    const sniffed = sniffImage(bytes);
    if (!sniffed.ok) throw new ApiError(422, "media_invalid", `Not an accepted image: ${sniffed.reason}.`);
    if (sniffed.contentType !== declaredType) {
      throw new ApiError(422, "media_invalid", `The bytes are a ${sniffed.contentType} image, not ${declaredType}.`);
    }
    return sniffed;
  }

  private retryShortly() {
    return new ApiError(503, "service_unavailable", "Service temporarily unavailable. Retry shortly.", { "Retry-After": "1" });
  }

  /** The item row, locked FOR UPDATE; null when it does not exist or the caller (not an admin) does not own it. */
  private async lockItem(tx: Tx, id: number, principal: string, isAdmin: boolean): Promise<MediaItemRow | null> {
    const [item] = await tx.select().from(mediaItems).where(eq(mediaItems.id, id)).for("update").limit(1);
    if (!item || (!isAdmin && item.owner !== principal)) return null;
    return item;
  }

  private async readVersion(db: Pick<Database, "select">, mediaId: number, version: number): Promise<MediaVersionRow> {
    const [row] = await db
      .select()
      .from(mediaVersions)
      .where(and(eq(mediaVersions.mediaId, mediaId), eq(mediaVersions.version, version)))
      .limit(1);
    if (!row) throw new Error("Media item names a missing version.");
    return row;
  }

  private async insertVersion(tx: Tx, values: typeof mediaVersions.$inferInsert): Promise<MediaVersionRow> {
    const [row] = await tx.insert(mediaVersions).values(values).returning();
    if (!row) throw new Error("Media version was not stored.");
    return row;
  }

  /** Claim the key with ON CONFLICT DO NOTHING; a loss rolls the transaction back (KeyAlreadyClaimed). */
  private async claimKey(tx: Tx, values: typeof mediaUploadKeys.$inferInsert): Promise<void> {
    const won = await tx.insert(mediaUploadKeys).values(values).onConflictDoNothing().returning({ key: mediaUploadKeys.idempotencyKey });
    if (won.length !== 1) throw new KeyAlreadyClaimed();
  }

  /** Apply `patch` to the locked item with revision + 1; the WHERE repeats the fence. */
  private async bump(
    tx: Tx,
    item: MediaItemRow,
    principal: string,
    now: Date,
    patch: Partial<Pick<typeof mediaItems.$inferInsert, "state" | "draftVersion" | "publishedVersion">>,
  ): Promise<MediaItemRow> {
    const [row] = await tx
      .update(mediaItems)
      .set({ ...patch, revision: sql`${mediaItems.revision} + 1`, updatedAt: now, updatedBy: principal })
      .where(and(eq(mediaItems.id, item.id), eq(mediaItems.revision, item.revision)))
      .returning();
    if (!row) throw new Error("Media item was not updated."); // the row lock makes this unreachable
    return row;
  }

  private async findClaim(db: Pick<Database, "select">, principal: string, key: string) {
    const [row] = await db
      .select()
      .from(mediaUploadKeys)
      .where(and(eq(mediaUploadKeys.principal, principal), eq(mediaUploadKeys.idempotencyKey, key)))
      .limit(1);
    return row;
  }

  /** Same operation, item (version uploads) and bytes: the item as stored now. Anything else with this key is a different intent. */
  private async replay(
    claim: typeof mediaUploadKeys.$inferSelect,
    operation: "create" | "version",
    mediaId: number | null,
    sha256: string,
    includeOwner: boolean,
    statement: MediaPublishableRights,
  ): Promise<MediaUploadResult> {
    // The claimed version's statement is stable: an uploaded version always has a v1_* statement and setRights never rewrites one.
    const sameIntent = claim.operation === operation && claim.sha256 === sha256 && (mediaId === null || claim.mediaId === mediaId);
    const claimedVersion = sameIntent ? await this.readVersion(this.database.db, claim.mediaId, claim.version) : null;
    if (claimedVersion === null || claimedVersion.rightsStatement !== statement) {
      throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key already stored a different upload; use a new key.");
    }
    const [item] = await this.database.db.select().from(mediaItems).where(eq(mediaItems.id, claim.mediaId)).limit(1);
    if (!item) throw new Error("Idempotency key names a missing media item.");
    const draft = await this.readVersion(this.database.db, item.id, item.draftVersion);
    return { item: toItemView(item, draft, includeOwner), replayed: true };
  }

  /** Put the file, read it back and compare digests. Any trouble is a 503 and nothing is in the database yet. */
  private async store(blobKey: string, bytes: Uint8Array, contentType: string, sha256: string): Promise<void> {
    let back: Uint8Array | null;
    try {
      await this.blobs.put(blobKey, bytes, contentType);
      back = await this.blobs.get(blobKey);
    } catch (error) {
      throw storageApiError(error, this.logger, "media upload") ?? error;
    }
    if (back === null || sha256Of(back) !== sha256) {
      this.logger.error("file storage read-back did not match the uploaded media");
      throw storageApiError(new StorageUnavailableError(), this.logger, "media upload")!;
    }
  }
}
