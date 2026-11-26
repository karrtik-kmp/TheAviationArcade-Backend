import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { APP_CONFIG } from "../../config/config.module.js";
import type { AppConfig } from "../../config/config.module.js";
import { ApiError } from "../../common/errors.js";
import { DatabaseService, ExpectedRollback } from "../../database/database.module.js";
import type { Database, Tx } from "../../database/database.module.js";
import { databaseNow } from "../../database/clock.js";
import { MEDIA_PUBLISHABLE_RIGHTS, MEDIA_V2_LICENCE_NAME, MEDIA_V2_STATEMENT } from "../../db/enums.js";
import type { MediaPublishableRights, MediaReviewDecision } from "../../db/enums.js";
import { adminAudit, mediaItems, mediaSubmissions, mediaUploadKeys, mediaVersions } from "../../db/schema.js";
import { BLOB_STORE, StorageUnavailableError } from "../../storage/blob-store.js";
import { storageApiError } from "../import-blob.js";
import type { BlobStore } from "../../storage/blob-store.js";
import { sniffImage } from "./image-sniff.js";
import { toImageRef } from "./image-ref.js";
import type { ImageRefView } from "./image-ref.js";
import { submissionDigest } from "./media-submission.js";
import type { Submission } from "./media-submission.js";
import { mediaIdOf, toItemView, toVersionView } from "./media-view.js";
import type { MediaItemRow, MediaItemView, MediaSubmissionRow, MediaVersionRow, MediaVersionView } from "./media-view.js";

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const MEDIA_CONTENT_TYPES_ACCEPTED = ["image/jpeg", "image/png"] as const;
const EXTENSION = { "image/jpeg": "jpg", "image/png": "png" } as const;

/**
 * What a PATCH may change (an absent key keeps the stored value, `null` clears): licence fields, the description and the title (per
 * version), and the private submission fields (`fullName`, `instagram`), which are edited in place on the item.
 */
export type MediaEdit = {
  licence?: MediaLicenceEdit | undefined;
  description?: string | null | undefined;
  title?: string | null | undefined;
  fullName?: string | null | undefined;
  instagram?: { handle: string | null; displayConsent: boolean } | undefined;
};

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

/** The statements a version may be published under: derived from the enum (the publishable CHECK), never a second list. */
const PUBLISHABLE_RIGHTS: readonly string[] = MEDIA_PUBLISHABLE_RIGHTS;

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

/** The item columns a write may move along with its revision. */
type BumpPatch = Partial<
  Pick<
    typeof mediaItems.$inferInsert,
    "state" | "draftVersion" | "publishedVersion" | "reviewDecision" | "reviewReason" | "reviewVersion" | "reviewDecidedBy" | "reviewDecidedAt"
  >
>;

/** The five review columns together (the all-or-none CHECK): a write that clears the decision spreads this into its one `bump` patch. */
const NO_REVIEW = { reviewDecision: null, reviewReason: null, reviewVersion: null, reviewDecidedBy: null, reviewDecidedAt: null } as const;

/**
 * R3/R4: a committed write by the item's OWNER (identity, whatever the caller's role) clears `changes_requested`. A non-owner admin's
 * write never does, and `declined` is cleared only by a publish.
 */
const ownerClears = (item: MediaItemRow, principal: string): boolean => item.reviewDecision === "changes_requested" && item.owner === principal;

/** The audit-detail key a clearing write adds; absent when nothing was cleared. */
const clearedNote = (cleared: boolean) => (cleared ? { reviewCleared: "changes_requested" as const } : {});

/** R5: a declined item blocks its non-admin owner (the reason is in the item, never in the message). */
const declinedBlocks = (item: MediaItemRow, principal: string, isAdmin: boolean): boolean =>
  item.reviewDecision === "declined" && item.owner === principal && !isAdmin;

const mediaDeclined = () =>
  new ApiError(409, "media_declined", "This photo was declined by an admin. It cannot be changed or replaced; see the review on the photo. Nothing was changed.");

/** A concurrent request with the same (principal, Idempotency-Key) won the unique insert: roll this one back and replay. */
class KeyAlreadyClaimed extends ExpectedRollback {}

/** The cap refused inside the transaction: an expected rollback, so the pooled connection is kept (see withTransaction). */
class CapRefused extends ExpectedRollback {
  constructor(readonly error: ApiError) {
    super(error.message);
  }
}

export type MediaListView = { items: MediaItemView[]; nextCursor: string | null };
export type MediaDetailView = { item: MediaItemView; versions: MediaVersionView[]; preview: ImageRefView };

const CURSOR = /^m1\.((?:[a-z]+|-)(?:\+[a-z_]+)?)\.([1-9][0-9]{0,14})$/;

/**
 * Opaque to clients: base64url of `m1.<filter key>.<last id>`. The filter key is `<state or pending or ->`, plus `+<review>` only when
 * the `review` filter is given, so without it the key is exactly the 0.29.0 one and old cursors still decode.
 */
function encodeCursor(lastId: number, key: string): string {
  return Buffer.from(`m1.${key}.${lastId}`).toString("base64url");
}

/** The last id, or undefined when the text is not a cursor made under this filter key. */
function decodeCursor(cursor: string, key: string): number | undefined {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(cursor)) return undefined;
  const match = CURSOR.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match || match[1] !== key) return undefined;
  const id = Number(match[2]);
  return encodeCursor(id, key) === cursor ? id : undefined; // refuses non-canonical base64url spellings
}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The version columns a v2 upload or move fills from its submission (D4): credit, the agreement's licence name, the title. */
const v2Fields = (submission: Submission) => ({
  creditName: submission.credit,
  licenceName: MEDIA_V2_LICENCE_NAME,
  licenceUrl: null,
  creditRequired: true,
  title: submission.title,
});

/** A v2 statement always comes with its submission (the controller guarantees it); anything else is a programming error. */
function submissionFor(statement: MediaPublishableRights, submission: Submission | null): Submission | null {
  if ((statement === MEDIA_V2_STATEMENT) !== (submission !== null)) throw new Error("A v2 statement needs a submission and a v1 statement must not have one.");
  return submission;
}

/** The 422 text for an edit a v2 version's CHECKs would refuse (title and credit stay set, licence name, URL and creditRequired are fixed), or null. */
function v2EditRefusal(changes: Record<string, { from: unknown; to: unknown }>): string | null {
  if (changes.title && changes.title.to === null) return "A v2 photo needs a title; it cannot be cleared. Nothing was changed.";
  if (changes.credit && changes.credit.to === null) return "A v2 photo needs a credit; it cannot be cleared. Nothing was changed.";
  if (changes.licenceName || changes.licenceUrl) return "A v2 photo's licence is the Photo Submission agreement; its licence name and URL cannot be changed. Nothing was changed.";
  if (changes.creditRequired) return "A v2 photo's credit is always required; creditRequired cannot be changed. Nothing was changed.";
  return null;
}

const notFound = () => new ApiError(404, "not_found", "No such media item.");

/** A caller who may see the item but does not own it: file uploads and rights statements are the owner's alone. */
const notOwner = (isAdmin: boolean) =>
  isAdmin ? new ApiError(403, "forbidden", "Only the photographer who owns this item can upload files or state rights for it.") : notFound();

/** D6: a v1 file upload to an item whose draft already holds v2 would break "once any version holds v2, the draft holds v2". */
const v1OverV2 = () =>
  new ApiError(409, "rights_already_stated", "The item's draft already holds the v2 agreement; a v1 upload cannot replace it. Upload with the v2 statement. Nothing was changed.");

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
    review: "none" | MediaReviewDecision | undefined = undefined,
  ): Promise<MediaListView> {
    // `pending` (published items whose draft is ahead of the published version) is its own cursor filter key; `review` adds a suffix.
    const filterKey = `${pending ? "pending" : (state ?? "-")}${review === undefined ? "" : `+${review}`}`;
    let before: number | undefined;
    if (cursor !== undefined) {
      before = decodeCursor(cursor, filterKey);
      if (before === undefined) throw new ApiError(400, "invalid_request", "Not a cursor this route returned (or the filter changed). Start again without cursor.");
    }
    const rows = await this.database.db
      .select({ item: mediaItems, draft: mediaVersions, submission: mediaSubmissions })
      .from(mediaItems)
      .innerJoin(mediaVersions, and(eq(mediaVersions.mediaId, mediaItems.id), eq(mediaVersions.version, mediaItems.draftVersion)))
      .leftJoin(mediaSubmissions, eq(mediaSubmissions.mediaId, mediaItems.id))
      .where(
        and(
          isAdmin ? undefined : eq(mediaItems.owner, principal),
          pending ? eq(mediaItems.state, "published") : state === undefined ? undefined : eq(mediaItems.state, state),
          pending ? sql`${mediaItems.draftVersion} > ${mediaItems.publishedVersion}` : undefined,
          review === undefined ? undefined : review === "none" ? isNull(mediaItems.reviewDecision) : eq(mediaItems.reviewDecision, review),
          before === undefined ? undefined : lt(mediaItems.id, before),
        ),
      )
      .orderBy(desc(mediaItems.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toItemView(r.item, r.draft, isAdmin, r.submission)),
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
    const submission = await this.readSubmission(this.database.db, mediaId);
    const now = await databaseNow(this.database.db);
    return {
      item: toItemView(item, draft, isAdmin, submission),
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
   * A v2 upload (`submission` set, D1/D2) also fills the version's title, credit and licence from it and writes the item's
   * media_submissions row in the same transaction; its key records the submission digest, which a replay must match (D10).
   */
  async create(
    principal: string,
    key: string,
    bytes: Uint8Array,
    declaredType: string,
    includeOwner: boolean,
    statement: MediaPublishableRights,
    rawSubmission: Submission | null = null,
  ): Promise<MediaUploadResult> {
    const submission = submissionFor(statement, rawSubmission);
    const digest = submission ? submissionDigest(submission) : null;
    const sha256 = sha256Of(bytes);
    const claimed = await this.findClaim(this.database.db, principal, key);
    if (claimed) return this.replay(claimed, "create", null, sha256, includeOwner, statement, digest);

    // S7: a cheap unlocked pre-check refuses an over-cap account before any blob write; the locked check below is authoritative.
    if (!includeOwner) {
      const refused = await this.overCap(this.database.db, principal);
      if (refused) throw refused;
    }

    const image = this.inspect(bytes, declaredType);
    await this.store(`content/photos/${sha256}.${EXTENSION[image.contentType]}`, bytes, image.contentType, sha256);
    const { contentType, width, height } = image;

    try {
      const created = await this.database.withTransaction(async (tx) => {
        if (!includeOwner) {
          // One lock per principal, held to commit, so two parallel uploads cannot both pass the count. A twin with this key that
          // waited on the lock replays instead of being counted. A refusal here leaves at most the content-addressed blob already put
          // (the same as any failed transaction after `store`); it is never referenced.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`media-cap:${principal}`}, 0))`);
          if (await this.findClaim(tx, principal, key)) throw new KeyAlreadyClaimed();
          const refused = await this.overCap(tx, principal);
          if (refused) throw new CapRefused(refused);
        }
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
          // A v1 licence starts empty. Credit is required until staff decide otherwise, so an unfilled item cannot be published
          // without a credit by accident. A v2 version is filled from the submission (D4).
          creditRequired: true,
          ...(submission ? v2Fields(submission) : {}),
          // Sending the header is the uploader's consent to the statement (docs/plans/media-rights-and-public.md).
          rightsStatement: statement,
          rightsStatedBy: principal,
          rightsStatedAt: now,
          createdBy: principal,
          createdAt: now,
        });
        const stored = submission ? await this.upsertSubmission(tx, item.id, submission, principal, now) : null;
        await this.claimKey(tx, { principal, idempotencyKey: key, operation: "create", mediaId: item.id, version: 1, sha256, submissionSha256: digest, createdAt: now });
        await tx.insert(adminAudit).values({
          actor: principal,
          action: "media_upload",
          target: mediaIdOf(item.id),
          detail: { mediaId: mediaIdOf(item.id), version: 1, sha256, contentType, byteSize: bytes.length, width, height, rightsStatement: statement },
          createdAt: now,
        });
        return toItemView(item, version, includeOwner, stored);
      });
      return { item: created, replayed: false };
    } catch (error) {
      if (error instanceof CapRefused) throw error.error;
      if (!(error instanceof KeyAlreadyClaimed)) throw error;
      // Lost the race: the winner's transaction has committed, so its key is visible now.
      const winner = await this.findClaim(this.database.db, principal, key);
      if (!winner) throw this.retryShortly();
      return this.replay(winner, "create", null, sha256, includeOwner, statement, digest);
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
   * v2 (`submission` set): the version's title, credit and licence come from it and the item's media_submissions row is replaced.
   * v1: the title carries forward like the description, and a v1 file for an item whose draft holds v2 is 409
   * `rights_already_stated` (D6; checked unlocked before storage, then again under the lock).
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
    rawSubmission: Submission | null = null,
  ): Promise<MediaUploadResult> {
    const submission = submissionFor(statement, rawSubmission);
    const digest = submission ? submissionDigest(submission) : null;
    const sha256 = sha256Of(bytes);
    const claimed = await this.findClaim(this.database.db, principal, key);
    if (claimed) return this.replay(claimed, "version", mediaId, sha256, isAdmin, statement, digest);

    const [seen] = await this.database.db.select().from(mediaItems).where(eq(mediaItems.id, mediaId)).limit(1);
    if (!seen) throw notFound();
    if (seen.owner !== principal) throw notOwner(isAdmin);
    if (seen.revision !== expectedRevision) {
      // A twin of this request may have committed between the key lookup above and this read: that is a replay, not a conflict.
      const twin = await this.findClaim(this.database.db, principal, key);
      if (twin) return this.replay(twin, "version", mediaId, sha256, isAdmin, statement, digest);
      throw staleRevision(seen, expectedRevision);
    }
    if (declinedBlocks(seen, principal, isAdmin)) throw mediaDeclined();
    if (submission === null && (await this.readVersion(this.database.db, mediaId, seen.draftVersion)).rightsStatement === MEDIA_V2_STATEMENT) {
      throw v1OverV2();
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
        if (declinedBlocks(item, principal, isAdmin)) return { ok: false, error: mediaDeclined() };
        const now = await databaseNow(tx);
        const version = item.draftVersion + 1;
        const previous = await this.readVersion(tx, mediaId, item.draftVersion);
        if (submission === null && previous.rightsStatement === MEDIA_V2_STATEMENT) return { ok: false, error: v1OverV2() };
        const row = await this.insertVersion(tx, {
          mediaId,
          version,
          sha256,
          contentType,
          byteSize: bytes.length,
          width,
          height,
          creditRequired: true,
          description: previous.description, // the v1 licence starts empty; the description carries forward (user 2026-11-04)
          title: previous.title, // the title carries forward like the description; a v2 upload replaces it just below
          ...(submission ? v2Fields(submission) : {}),
          rightsStatement: statement,
          rightsStatedBy: principal,
          rightsStatedAt: now,
          createdBy: principal,
          createdAt: now,
        });
        const stored = submission ? await this.upsertSubmission(tx, mediaId, submission, principal, now) : await this.readSubmission(tx, mediaId);
        await this.claimKey(tx, { principal, idempotencyKey: key, operation: "version", mediaId, version, sha256, submissionSha256: digest, createdAt: now });
        const cleared = ownerClears(item, principal);
        const updated = await this.bump(tx, item, principal, now, { draftVersion: version, ...(cleared ? NO_REVIEW : {}) });
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
            ...clearedNote(cleared),
          },
          createdAt: now,
        });
        return { ok: true, value: toItemView(updated, row, isAdmin, stored) };
      });
      if (!outcome.ok) throw outcome.error;
      return { item: outcome.value, replayed: false };
    } catch (error) {
      if (!(error instanceof KeyAlreadyClaimed)) throw error;
      const winner = await this.findClaim(this.database.db, principal, key);
      if (!winner) throw this.retryShortly();
      return this.replay(winner, "version", mediaId, sha256, isAdmin, statement, digest);
    }
  }

  /**
   * Edit the draft version's licence, description and/or title, and the item's private submission fields (D8). The live (published)
   * version is never touched: when the draft IS the published version, or the draft was live once before (a withdrawn item), a
   * change to the version's own fields makes a NEW draft version with the same file (version + 1); otherwise the unpublished draft is
   * edited in place. A new version copies the rights statement (an edit never changes it).
   * The submission fields (`fullName`, `instagram`) live in media_submissions, outside the frozen version rows: they are written in
   * place, move only the item's revision and make no version. The owner may set anything; a non-owner admin may only REMOVE (name to
   * null, handle to null, consent off), else 403. Permission is decided on actual changes against the stored values, so stored values
   * sent back are a no-op: 200, no change, no new revision. On a v2 draft the title and credit cannot become null and the licence
   * name, licence URL and creditRequired cannot change (422, decided before any UPDATE so no CHECK becomes a 500).
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
      const stored = await this.readSubmission(tx, mediaId);

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
      const title = wanted.title === undefined ? draft.title : wanted.title;
      merged.title = title;
      if (title !== draft.title) changes.title = { from: draft.title, to: title };

      const before = { fullName: stored?.fullName ?? null, handle: stored?.instagramHandle ?? null, consent: stored?.instagramDisplayConsent ?? false };
      const after = {
        fullName: wanted.fullName === undefined ? before.fullName : wanted.fullName,
        handle: wanted.instagram === undefined ? before.handle : wanted.instagram.handle,
        consent: wanted.instagram === undefined ? before.consent : wanted.instagram.displayConsent,
      };
      const fullNameChanged = after.fullName !== before.fullName;
      const handleChanged = after.handle !== before.handle;
      const consentChanged = after.consent !== before.consent;
      const submissionChanged = fullNameChanged || handleChanged || consentChanged;

      if (!isAdmin && changes.creditRequired) {
        return { ok: false, error: new ApiError(403, "forbidden", "Only an admin can change creditRequired. Nothing was changed.") };
      }
      // Only the owner may set the private fields; another admin may only remove them (a privacy request, agreement section 8).
      if (
        submissionChanged &&
        item.owner !== principal &&
        ((fullNameChanged && after.fullName !== null) || (handleChanged && after.handle !== null) || (consentChanged && after.consent))
      ) {
        return {
          ok: false,
          error: new ApiError(403, "forbidden", "Only the photographer who owns this item can set the submission's name or Instagram fields; an admin can only remove them. Nothing was changed."),
        };
      }
      // R5: a declined item blocks its non-admin owner, except an edit that only REMOVES private fields (erasure stays possible).
      if (declinedBlocks(item, principal, isAdmin)) {
        const removalOnly =
          Object.keys(changes).length === 0 &&
          submissionChanged &&
          !(fullNameChanged && after.fullName !== null) &&
          !(handleChanged && after.handle !== null) &&
          !(consentChanged && after.consent);
        if (!removalOnly) return { ok: false, error: mediaDeclined() };
      }
      if (draft.rightsStatement === MEDIA_V2_STATEMENT) {
        const refusal = v2EditRefusal(changes);
        if (refusal) return { ok: false, error: new ApiError(422, "content_invalid", refusal) };
      }
      const contentChanged = Object.keys(changes).length > 0;
      if (!contentChanged && !submissionChanged) return { ok: true, value: toItemView(item, draft, isAdmin, stored) };

      const now = await databaseNow(tx);
      let updatedDraft: MediaVersionRow = draft;
      let newVersion = false;
      let patch: BumpPatch = {};
      if (contentChanged) {
        newVersion = item.draftVersion === item.publishedVersion || draft.publishedAt !== null;
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
            title,
            rightsStatement: draft.rightsStatement,
            rightsStatedBy: draft.rightsStatedBy,
            rightsStatedAt: draft.rightsStatedAt,
            createdBy: principal,
            createdAt: now,
          });
          patch = { draftVersion: item.draftVersion + 1 };
        } else {
          const [row] = await tx
            .update(mediaVersions)
            .set({ ...merged, updatedAt: now, updatedBy: principal })
            .where(and(eq(mediaVersions.mediaId, mediaId), eq(mediaVersions.version, item.draftVersion)))
            .returning();
          if (!row) throw new Error("Media version was not updated.");
          updatedDraft = row;
        }
      }
      const storedAfter = submissionChanged
        ? await this.upsertSubmission(tx, mediaId, { fullName: after.fullName, instagramHandle: after.handle, instagramDisplayConsent: after.consent }, principal, now)
        : stored;
      const cleared = ownerClears(item, principal);
      const updatedItem = await this.bump(tx, item, principal, now, { ...patch, ...(cleared ? NO_REVIEW : {}) });
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
          // Never the name or the handle themselves (the audit log is append-only): flags and the consent switch only.
          ...(submissionChanged ? { submission: { fullNameChanged, instagramChanged: handleChanged || consentChanged, consentFrom: before.consent, consentTo: after.consent } } : {}),
          note,
          ...clearedNote(cleared),
        },
        createdAt: now,
      });
      return { ok: true, value: toItemView(updatedItem, updatedDraft, isAdmin, storedAfter) };
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
      // DEV_DEMO_WAIVER: with no licence name the version is stamped with the waiver; a draft with a licence name never is. A
      // withdrawn version that was published under the waiver keeps it (and fails here when the switch is off).
      const waived = !draft.licenceName && this.config.devDemoWaiver === "dev-demo" ? ("dev-demo" as const) : null;
      if (!draft.licenceName && waived === null) {
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
      // A v2 draft needs the photographer's full name on the item (it can be erased by the owner or an admin, agreement section 8).
      const submission = await this.readSubmission(tx, mediaId);
      if (draft.rightsStatement === MEDIA_V2_STATEMENT && !submission?.fullName) {
        return { ok: false, error: new ApiError(422, "content_invalid", "The item has no submission full name (it may have been erased); it must be set before a v2 draft can be published.") };
      }
      const now = await databaseNow(tx);
      let published: MediaVersionRow;
      if (draft.publishedAt !== null) {
        // A withdrawn version going live again: it is already frozen (migration 0027 trigger refuses any UPDATE of a published
        // version), and its FIRST go-live time and any waiver are kept. Only the media item moves.
        published = draft;
      } else {
        const [row] = await tx
          .update(mediaVersions)
          .set({ publishedAt: now, updatedAt: now, updatedBy: principal, ...(waived !== null ? { licenceWaiver: waived } : {}) })
          .where(and(eq(mediaVersions.mediaId, mediaId), eq(mediaVersions.version, draft.version)))
          .returning();
        if (!row) throw new Error("Media version was not published.");
        published = row;
      }
      // A publish clears either decision, in the same UPDATE that moves the state.
      const updated = await this.bump(tx, item, principal, now, { state: "published", publishedVersion: draft.version, ...NO_REVIEW });
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
          ...(waived !== null ? { licenceWaived: waived } : {}),
          ...(item.reviewDecision !== null ? { reviewCleared: item.reviewDecision } : {}),
        },
        createdAt: now,
      });
      return { ok: true, value: toItemView(updated, published, true, submission) };
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
      return { ok: true, value: toItemView(updated, draft, true, await this.readSubmission(tx, mediaId)) };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * Admin: decide on an item (docs/plans/media-review-feedback.md R2) or, with `decision: null`, withdraw the decision and erase its
   * reason. Order: 404, the revision fence, eligibility (409 `version_conflict` with a message). Reviewable: `unverified`, or `published`
   * with a pending draft; `declined` only on `unverified`. A new decision replaces the current one. Same decision, same normalised reason
   * and the same draft version is a no-op (200, nothing written). The columns ride the one `bump` UPDATE; the audit row never holds the
   * reason text, only its length.
   */
  async review(
    principal: string,
    mediaId: number,
    expectedRevision: number,
    wanted: { decision: MediaReviewDecision; reason: string } | { decision: null },
  ): Promise<MediaItemView> {
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome<MediaItemView>> => {
      const item = await this.lockItem(tx, mediaId, principal, true);
      if (!item) return { ok: false, error: notFound() };
      if (item.revision !== expectedRevision) return { ok: false, error: staleRevision(item, expectedRevision) };
      const draft = await this.readVersion(tx, mediaId, item.draftVersion);
      const submission = await this.readSubmission(tx, mediaId);
      const unchanged = (): Outcome<MediaItemView> => ({ ok: true, value: toItemView(item, draft, true, submission) });
      const refuse = (what: string): Outcome<MediaItemView> => ({
        ok: false,
        error: new ApiError(409, "version_conflict", `The item is ${item.state} at revision ${item.revision}; ${what} Nothing was changed.`),
      });

      if (wanted.decision === null) {
        // Withdrawing a decision is allowed whenever one stands (its reason is erased); with none it is a no-op.
        if (item.reviewDecision === null) return unchanged();
      } else {
        const pendingDraft = item.state === "published" && item.publishedVersion !== null && item.draftVersion > item.publishedVersion;
        if (item.state === "withdrawn") return refuse("a withdrawn item cannot be reviewed.");
        if (item.state === "published" && !pendingDraft) return refuse("a published item can be reviewed only while it has a newer draft.");
        if (wanted.decision === "declined" && item.state !== "unverified") return refuse("only an unverified item can be declined.");
        if (item.reviewDecision === wanted.decision && item.reviewReason === wanted.reason && item.reviewVersion === item.draftVersion) return unchanged();
      }

      const now = await databaseNow(tx);
      const patch: BumpPatch =
        wanted.decision === null
          ? NO_REVIEW
          : { reviewDecision: wanted.decision, reviewReason: wanted.reason, reviewVersion: item.draftVersion, reviewDecidedBy: principal, reviewDecidedAt: now };
      const updated = await this.bump(tx, item, principal, now, patch);
      await tx.insert(adminAudit).values({
        actor: principal,
        action: "media_review",
        target: mediaIdOf(mediaId),
        detail: {
          mediaId: mediaIdOf(mediaId),
          decision: wanted.decision,
          previousDecision: item.reviewDecision,
          // The version the decision was about; for a withdrawal, the version the withdrawn decision was about.
          reviewedVersion: wanted.decision === null ? item.reviewVersion : item.draftVersion,
          revision: updated.revision,
          fromState: item.state,
          // Never the reason text itself (the audit log is append-only and free text about a person's photo may name them).
          reasonLength: wanted.decision === null ? 0 : [...wanted.reason].length,
        },
        createdAt: now,
      });
      return { ok: true, value: toItemView(updated, draft, true, submission) };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * State the rights for the DRAFT of an item (owner only: another photographer's item is 404, an admin who is not the owner gets 403
   * `forbidden`; then the revision fence, 409 `version_conflict`).
   * v1 (`submission` null): the draft's statement must be null or `d1_private_review` and the draft must never have been published,
   * else 409 `rights_already_stated` (so v1 over v2 is refused: no downgrade). Written in place; the revision moves.
   * v2 (D5): refused 409 `rights_already_stated` when the draft already holds v2; otherwise ALWAYS a new draft version of the current
   * draft's file (description, source URL and attribution copied, title, credit and licence from the submission, the v2 statement by
   * the owner at database now), and the item's media_submissions row is replaced. Older versions, published ones included, are
   * never rewritten; the live version switches to v2 when an admin publishes the new draft.
   */
  async setRights(
    principal: string,
    mediaId: number,
    isAdmin: boolean,
    expectedRevision: number,
    statement: MediaPublishableRights,
    rawSubmission: Submission | null = null,
  ): Promise<MediaItemView> {
    const submission = submissionFor(statement, rawSubmission);
    const outcome = await this.database.withTransaction(async (tx): Promise<Outcome<MediaItemView>> => {
      const item = await this.lockItem(tx, mediaId, principal, isAdmin);
      if (!item) return { ok: false, error: notFound() };
      if (item.owner !== principal) return { ok: false, error: notOwner(isAdmin) };
      if (item.revision !== expectedRevision) return { ok: false, error: staleRevision(item, expectedRevision) };
      if (declinedBlocks(item, principal, isAdmin)) return { ok: false, error: mediaDeclined() };
      const draft = await this.readVersion(tx, mediaId, item.draftVersion);
      const cleared = ownerClears(item, principal);
      const alreadyStated = () =>
        new ApiError(409, "rights_already_stated", "The draft already has a rights statement or has been published; a statement cannot be changed. Nothing was changed.");
      if (submission === null) {
        const open = draft.rightsStatement === null || draft.rightsStatement === "d1_private_review";
        const neverPublished = item.draftVersion !== item.publishedVersion && draft.publishedAt === null;
        if (!open || !neverPublished) return { ok: false, error: alreadyStated() };
        const now = await databaseNow(tx);
        const [row] = await tx
          .update(mediaVersions)
          .set({ rightsStatement: statement, rightsStatedBy: principal, rightsStatedAt: now, updatedAt: now, updatedBy: principal })
          .where(and(eq(mediaVersions.mediaId, mediaId), eq(mediaVersions.version, item.draftVersion)))
          .returning();
        if (!row) throw new Error("Media version was not updated.");
        const updated = await this.bump(tx, item, principal, now, cleared ? NO_REVIEW : {});
        await tx.insert(adminAudit).values({
          actor: principal,
          action: "media_rights",
          target: mediaIdOf(mediaId),
          detail: {
            mediaId: mediaIdOf(mediaId),
            version: row.version,
            fromVersion: item.draftVersion,
            newVersion: false,
            statement,
            previousStatement: draft.rightsStatement,
            revision: updated.revision,
            ...clearedNote(cleared),
          },
          createdAt: now,
        });
        return { ok: true, value: toItemView(updated, row, isAdmin, await this.readSubmission(tx, mediaId)) };
      }

      // v2: a draft that already holds v2 is v2 over v2.
      if (draft.rightsStatement === MEDIA_V2_STATEMENT) return { ok: false, error: alreadyStated() };
      const now = await databaseNow(tx);
      const before = await this.readSubmission(tx, mediaId);
      const version = item.draftVersion + 1;
      const row = await this.insertVersion(tx, {
        mediaId,
        version,
        sha256: draft.sha256,
        contentType: draft.contentType,
        byteSize: draft.byteSize,
        width: draft.width,
        height: draft.height,
        sourceUrl: draft.sourceUrl,
        attributionText: draft.attributionText,
        description: draft.description,
        ...v2Fields(submission),
        rightsStatement: statement,
        rightsStatedBy: principal,
        rightsStatedAt: now,
        createdBy: principal,
        createdAt: now,
      });
      const stored = await this.upsertSubmission(tx, mediaId, submission, principal, now);
      const updated = await this.bump(tx, item, principal, now, { draftVersion: version, ...(cleared ? NO_REVIEW : {}) });
      await tx.insert(adminAudit).values({
        actor: principal,
        action: "media_rights",
        target: mediaIdOf(mediaId),
        detail: {
          mediaId: mediaIdOf(mediaId),
          version,
          fromVersion: item.draftVersion,
          newVersion: true,
          statement,
          previousStatement: draft.rightsStatement,
          previousStatedAt: draft.rightsStatedAt ? draft.rightsStatedAt.toISOString() : null,
          previousStatedBy: draft.rightsStatedBy,
          revision: updated.revision,
          changes: {
            credit: { from: draft.creditName, to: row.creditName },
            licenceName: { from: draft.licenceName, to: row.licenceName },
            licenceUrl: { from: draft.licenceUrl, to: row.licenceUrl },
            title: { from: draft.title, to: row.title },
          },
          // Never the name or the handle themselves (the audit log is append-only).
          submission: {
            fullNameChanged: (before?.fullName ?? null) !== submission.fullName,
            instagramChanged: (before?.instagramHandle ?? null) !== submission.instagramHandle || (before?.instagramDisplayConsent ?? false) !== submission.instagramDisplayConsent,
          },
          ...clearedNote(cleared),
        },
        createdAt: now,
      });
      return { ok: true, value: toItemView(updated, row, isAdmin, stored) };
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

  /** S7: 429 `submission_limit` when the owner already has the configured number of items that are unverified and not declined. */
  /** The 429 `submission_limit` refusal when the owner already has the cap of items waiting for review, else null. */
  private async overCap(db: Pick<Database, "select">, principal: string): Promise<ApiError | null> {
    const cap = this.config.mediaPendingCapPerAccount;
    const [row] = await db
      .select({ waiting: sql<number>`count(*)::int` })
      .from(mediaItems)
      .where(and(eq(mediaItems.owner, principal), eq(mediaItems.state, "unverified"), sql`${mediaItems.reviewDecision} IS DISTINCT FROM 'declined'`));
    if ((row?.waiting ?? 0) < cap) return null;
    return new ApiError(
      429,
      "submission_limit",
      `You have ${cap} photos waiting for review, which is the limit. Wait for some to be reviewed, then upload more. Nothing was uploaded.`,
    );
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

  /** The item's submission row, or null when it has none (a v1 item that never had one). */
  private async readSubmission(db: Pick<Database, "select">, mediaId: number): Promise<MediaSubmissionRow | null> {
    const [row] = await db.select().from(mediaSubmissions).where(eq(mediaSubmissions.mediaId, mediaId)).limit(1);
    return row ?? null;
  }

  /** Write the item's submission row in place (INSERT ... ON CONFLICT (media_id) DO UPDATE), in the caller's transaction. */
  private async upsertSubmission(
    tx: Tx,
    mediaId: number,
    values: { fullName: string | null; instagramHandle: string | null; instagramDisplayConsent: boolean },
    principal: string,
    now: Date,
  ): Promise<MediaSubmissionRow> {
    const set = { fullName: values.fullName, instagramHandle: values.instagramHandle, instagramDisplayConsent: values.instagramDisplayConsent, updatedAt: now, updatedBy: principal };
    const [row] = await tx
      .insert(mediaSubmissions)
      .values({ mediaId, ...set })
      .onConflictDoUpdate({ target: mediaSubmissions.mediaId, set })
      .returning();
    if (!row) throw new Error("Media submission was not stored.");
    return row;
  }

  /** Insert a version; `updated_at`/`updated_by` start equal to `created_at`/`created_by` (migration 0027). */
  private async insertVersion(tx: Tx, values: Omit<typeof mediaVersions.$inferInsert, "updatedAt" | "updatedBy">): Promise<MediaVersionRow> {
    const [row] = await tx
      .insert(mediaVersions)
      .values({ ...values, updatedAt: values.createdAt, updatedBy: values.createdBy })
      .returning();
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
    patch: BumpPatch,
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
    digest: string | null,
  ): Promise<MediaUploadResult> {
    // The claimed version's statement is stable: an uploaded version always has an upload statement (v1_* or v2) and no write ever
    // rewrites one, so a replay stays 200 after the item moved to v2. The submission must match too (the key's stored digest, D10).
    const sameIntent =
      claim.operation === operation && claim.sha256 === sha256 && claim.submissionSha256 === digest && (mediaId === null || claim.mediaId === mediaId);
    const claimedVersion = sameIntent ? await this.readVersion(this.database.db, claim.mediaId, claim.version) : null;
    if (claimedVersion === null || claimedVersion.rightsStatement !== statement) {
      throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key already stored a different upload; use a new key.");
    }
    const [item] = await this.database.db.select().from(mediaItems).where(eq(mediaItems.id, claim.mediaId)).limit(1);
    if (!item) throw new Error("Idempotency key names a missing media item.");
    const draft = await this.readVersion(this.database.db, item.id, item.draftVersion);
    return { item: toItemView(item, draft, includeOwner, await this.readSubmission(this.database.db, item.id)), replayed: true };
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
