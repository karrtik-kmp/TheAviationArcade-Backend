/**
 * Where uploaded files live (staff xlsx imports today). Bunny Storage in deployment, memory locally and in
 * tests. Postgres keeps only the key. Keys are relative; the store prepends its own prefix.
 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** The object's bytes, or null when it does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}

/** Nest provider token for the active BlobStore. */
export const BLOB_STORE = Symbol("BLOB_STORE");

/** The store is unreachable, timed out, answered 5xx/429, or is switched off. The caller should retry later (503). */
export class StorageUnavailableError extends Error {
  constructor(message = "File storage is unavailable.") {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

/** The store refused a request for a reason a retry will not fix (bad credentials, bad key). Carries only the status. */
export class StorageRequestError extends Error {
  constructor(readonly status: number) {
    super(`File storage request failed (${status}).`);
    this.name = "StorageRequestError";
  }
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Keys are relative paths like imports/<module>/<sha256>.xlsx: non-empty segments of letters, digits and
 * . _ - (not starting with a dot), no leading or trailing slash, no backslashes, no control characters,
 * no "." or ".." segments. Stricter than Bunny needs, so a key can never escape the prefix.
 */
export function validateBlobKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > 512 || !key.split("/").every((s) => SEGMENT.test(s))) {
    throw new TypeError("Invalid file storage key.");
  }
}
