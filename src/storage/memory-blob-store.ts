import { validateBlobKey } from "./blob-store.js";
import type { BlobStore } from "./blob-store.js";

/** Process-local store for local development and tests. Production config refuses it. */
export class MemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  constructor(private readonly prefix = "") {}

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    validateBlobKey(key);
    this.objects.set(this.prefix + key, { bytes: new Uint8Array(bytes), contentType });
  }

  async get(key: string): Promise<Uint8Array | null> {
    validateBlobKey(key);
    const found = this.objects.get(this.prefix + key);
    return found ? new Uint8Array(found.bytes) : null;
  }

  async delete(key: string): Promise<void> {
    validateBlobKey(key);
    this.objects.delete(this.prefix + key);
  }

  /** Test helper: the content type stored with a key. */
  contentTypeOf(key: string): string | undefined {
    return this.objects.get(this.prefix + key)?.contentType;
  }

  /** Test helper: drop everything. */
  clear(): void {
    this.objects.clear();
  }

  /** Test helper: how many objects are stored. */
  get size(): number {
    return this.objects.size;
  }
}
