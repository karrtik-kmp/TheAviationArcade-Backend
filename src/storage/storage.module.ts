import { Global, Module } from "@nestjs/common";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { BLOB_STORE } from "./blob-store.js";
import type { BlobStore } from "./blob-store.js";
import { BunnyBlobStore } from "./bunny-blob-store.js";
import { MemoryBlobStore } from "./memory-blob-store.js";
import { UnavailableBlobStore } from "./unavailable-blob-store.js";

/** Picks the BlobStore from config (BLOB_STORE). Provided globally under the BLOB_STORE token. */
export function createBlobStore(config: Pick<AppConfig, "blobStore" | "bunny">): BlobStore {
  if (config.blobStore === "bunny" && config.bunny) return new BunnyBlobStore(config.bunny);
  if (config.blobStore === "memory") return new MemoryBlobStore();
  return new UnavailableBlobStore();
}

@Global()
@Module({
  providers: [{ provide: BLOB_STORE, inject: [APP_CONFIG], useFactory: createBlobStore }],
  exports: [BLOB_STORE],
})
export class StorageModule {}
