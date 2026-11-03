import type { Logger } from "@nestjs/common";
import { ApiError } from "../common/errors.js";
import { StorageRequestError, StorageUnavailableError } from "../storage/blob-store.js";
import type { BlobStore } from "../storage/blob-store.js";
import { XLSX_MIME } from "./xlsx.js";

/**
 * The one mapping from a file-storage failure to the API answer, shared by the import routes and the media upload so the
 * messages and the Retry-After rule cannot drift. Unreachable or timed out: 503 `storage_unavailable` with Retry-After. Refused
 * for a reason a retry will not fix (e.g. bad credentials; our configuration, not the caller's): 503 without Retry-After, and
 * only the status is logged (`what` names the operation, e.g. "import upload"). Any other error is not a storage failure: null.
 */
export function storageApiError(error: unknown, logger: Logger, what: string): ApiError | null {
  if (error instanceof StorageUnavailableError) {
    return new ApiError(503, "storage_unavailable", "File storage is unavailable. Retry shortly.", { "Retry-After": "5" });
  }
  if (error instanceof StorageRequestError) {
    logger.error(`file storage refused the ${what} (status ${error.status})`);
    return new ApiError(503, "storage_unavailable", "File storage is unavailable.");
  }
  return null;
}

/**
 * Keeps an uploaded import file in the BlobStore (content-addressed by the caller's key, so an orphan after a failed commit is
 * harmless). Storage trouble is a 503 `storage_unavailable` and nothing else has been written yet. Shared by the item import
 * and the Field Awards import.
 */
export async function storeImportBlob(blobs: BlobStore, logger: Logger, key: string, bytes: Uint8Array): Promise<void> {
  try {
    await blobs.put(key, bytes, XLSX_MIME);
  } catch (error) {
    throw storageApiError(error, logger, "import upload") ?? error;
  }
}
