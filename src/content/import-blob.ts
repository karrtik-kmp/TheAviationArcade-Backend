import type { Logger } from "@nestjs/common";
import { ApiError } from "../common/errors.js";
import { StorageRequestError, StorageUnavailableError } from "../storage/blob-store.js";
import type { BlobStore } from "../storage/blob-store.js";
import { XLSX_MIME } from "./xlsx.js";

/**
 * Keeps an uploaded import file in the BlobStore (content-addressed by the caller's key, so an orphan after a failed commit is
 * harmless). Storage trouble is a 503 `storage_unavailable` and nothing else has been written yet. Shared by the item import
 * and the Field Awards import.
 */
export async function storeImportBlob(blobs: BlobStore, logger: Logger, key: string, bytes: Uint8Array): Promise<void> {
  try {
    await blobs.put(key, bytes, XLSX_MIME);
  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      throw new ApiError(503, "storage_unavailable", "File storage is unavailable. Retry shortly.", { "Retry-After": "5" });
    }
    if (error instanceof StorageRequestError) {
      // Refused for a reason a retry will not fix (e.g. bad credentials): our configuration, not the caller's. Status only in the log.
      logger.error(`file storage refused the import upload (status ${error.status})`);
      throw new ApiError(503, "storage_unavailable", "File storage is unavailable.");
    }
    throw error;
  }
}
