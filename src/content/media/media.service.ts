import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { DatabaseService, ExpectedRollback } from "../../database/database.module.js";
import { databaseNow } from "../../database/clock.js";
import { adminAudit, mediaItems, mediaUploadKeys, mediaVersions } from "../../db/schema.js";
import { BLOB_STORE, StorageUnavailableError } from "../../storage/blob-store.js";
import { storageApiError } from "../import-blob.js";
import type { BlobStore } from "../../storage/blob-store.js";
import { sniffImage } from "./image-sniff.js";
import { mediaIdOf, toItemView } from "./media-view.js";
import type { MediaItemView } from "./media-view.js";

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const MEDIA_CONTENT_TYPES_ACCEPTED = ["image/jpeg", "image/png"] as const;
const EXTENSION = { "image/jpeg": "jpg", "image/png": "png" } as const;

export type MediaUploadResult = { item: MediaItemView; replayed: boolean };

/** A concurrent request with the same (principal, Idempotency-Key) won the unique insert: roll this one back and replay. */
class KeyAlreadyClaimed extends ExpectedRollback {}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Staff media (plan docs/plans/media-pipeline.md, ADR-0001). T3: upload a new item. */
@Injectable()
export class MediaService {
  private readonly logger = new Logger("Media");

  constructor(
    private readonly database: DatabaseService,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
  ) {}

  /**
   * Create a media item from raw image bytes. The Idempotency-Key is looked up FIRST (this route has no revision fence): a
   * stored key with the same operation and bytes replays the item as it is now (200); any other use of the key is 422
   * `idempotency_key_reused`. Otherwise: sniff, store the file under its digest, read it back and compare, then ONE
   * transaction inserts the item and version 1, claims the key (the unique insert decides a concurrent duplicate) and writes
   * the audit row. Storage trouble is 503 `storage_unavailable` before anything is written to the database.
   */
  async create(principal: string, key: string, bytes: Uint8Array, declaredType: string, includeOwner: boolean): Promise<MediaUploadResult> {
    const sha256 = sha256Of(bytes);
    const claimed = await this.findClaim(principal, key);
    if (claimed) return this.replay(claimed, sha256, includeOwner);

    const sniffed = sniffImage(bytes);
    if (!sniffed.ok) throw new ApiError(422, "media_invalid", `Not an accepted image: ${sniffed.reason}.`);
    if (sniffed.contentType !== declaredType) {
      throw new ApiError(422, "media_invalid", `The bytes are a ${sniffed.contentType} image, not ${declaredType}.`);
    }
    const { contentType, width, height } = sniffed;
    await this.store(`content/photos/${sha256}.${EXTENSION[contentType]}`, bytes, contentType, sha256);

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
        const [version] = await tx
          .insert(mediaVersions)
          .values({
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
            createdBy: principal,
            createdAt: now,
          })
          .returning();
        if (!version) throw new Error("Media version was not stored.");
        const won = await tx
          .insert(mediaUploadKeys)
          .values({ principal, idempotencyKey: key, operation: "create", mediaId: item.id, version: 1, sha256, createdAt: now })
          .onConflictDoNothing()
          .returning({ key: mediaUploadKeys.idempotencyKey });
        if (won.length !== 1) throw new KeyAlreadyClaimed();
        await tx.insert(adminAudit).values({
          actor: principal,
          action: "media_upload",
          target: mediaIdOf(item.id),
          detail: { mediaId: mediaIdOf(item.id), version: 1, sha256, contentType, byteSize: bytes.length, width, height },
          createdAt: now,
        });
        return toItemView(item, version, includeOwner);
      });
      return { item: created, replayed: false };
    } catch (error) {
      if (!(error instanceof KeyAlreadyClaimed)) throw error;
      // Lost the race: the winner's transaction has committed, so its key is visible now.
      const winner = await this.findClaim(principal, key);
      if (!winner) throw new ApiError(503, "service_unavailable", "Service temporarily unavailable. Retry shortly.", { "Retry-After": "1" });
      return this.replay(winner, sha256, includeOwner);
    }
  }

  private async findClaim(principal: string, key: string) {
    const [row] = await this.database.db
      .select()
      .from(mediaUploadKeys)
      .where(and(eq(mediaUploadKeys.principal, principal), eq(mediaUploadKeys.idempotencyKey, key)))
      .limit(1);
    return row;
  }

  /** Same operation and bytes: the item as stored now. Anything else with this key is a different intent. */
  private async replay(claim: typeof mediaUploadKeys.$inferSelect, sha256: string, includeOwner: boolean): Promise<MediaUploadResult> {
    if (claim.operation !== "create" || claim.sha256 !== sha256) {
      throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key already stored a different upload; use a new key.");
    }
    const [item] = await this.database.db.select().from(mediaItems).where(eq(mediaItems.id, claim.mediaId)).limit(1);
    if (!item) throw new Error("Idempotency key names a missing media item.");
    const [draft] = await this.database.db
      .select()
      .from(mediaVersions)
      .where(and(eq(mediaVersions.mediaId, item.id), eq(mediaVersions.version, item.draftVersion)))
      .limit(1);
    if (!draft) throw new Error("Media item names a missing draft version.");
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
