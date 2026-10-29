import { StorageUnavailableError } from "./blob-store.js";
import type { BlobStore } from "./blob-store.js";

/** BLOB_STORE=none: no file storage is configured, so every call fails as "unavailable" (503). */
export class UnavailableBlobStore implements BlobStore {
  async put(): Promise<void> {
    throw new StorageUnavailableError("File storage is not configured.");
  }
  async get(): Promise<Uint8Array | null> {
    throw new StorageUnavailableError("File storage is not configured.");
  }
  async delete(): Promise<void> {
    throw new StorageUnavailableError("File storage is not configured.");
  }
}
