import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ApiError } from "../../common/errors.js";
import { DatabaseService } from "../../database/database.module.js";
import { DocumentIntegrityError, anyDocument, documentsInForce, findDocument, seedContentDocuments, verifiedBytes } from "./document-store.js";
import { DocumentValidationError } from "./documents.js";
import type { ContentDocumentName } from "./documents.js";
import { buildManifest } from "./manifest.js";
import type { ContentManifest } from "./manifest.js";

export type ServedDocument = { sha256: string; load: () => Buffer };

/** The content manifest and the immutable documents it lists (slice T4). Reads only; every write is document-store.ts. */
@Injectable()
export class ContentDocumentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("ContentDocuments");
  private stopped = false;
  private retry: NodeJS.Timeout | undefined;

  constructor(private readonly database: DatabaseService) {}

  /**
   * Seeds version 1 of each document that has no row yet and WAITS for it, so the documents exist once the server is
   * listening. A database that is down at boot must not stop the process (readiness reports it, /v1/health/ready is 503): the
   * failure is logged and the seed is retried in the background (1 s, doubling to 30 s) until it succeeds.
   */
  async onModuleInit(): Promise<void> {
    await this.seedOrRetry(1000);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
  }

  private async seedOrRetry(delayMs: number): Promise<void> {
    try {
      const { seeded } = await seedContentDocuments(this.database);
      if (seeded.length > 0) this.logger.log(`seeded content documents: ${seeded.join(", ")}`);
    } catch (error) {
      this.logger.error(`could not seed content documents (retrying in ${delayMs} ms): ${error instanceof Error ? error.message : String(error)}`);
      if (this.stopped) return;
      this.retry = setTimeout(() => void this.seedOrRetry(Math.min(delayMs * 2, 30_000)), delayMs);
      this.retry.unref();
    }
  }

  /**
   * Called after a successful content import: a database that had no Military items at boot can now seal clipper-cards v1.
   * Never fails the import (it already committed); the next boot would try again.
   */
  async afterImport(): Promise<void> {
    try {
      const { seeded } = await seedContentDocuments(this.database);
      if (seeded.length > 0) this.logger.log(`seeded content documents after an import: ${seeded.join(", ")}`);
    } catch (error) {
      this.logger.error(`could not seed content documents after an import: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The manifest of the documents IN FORCE (the same selection as `catalogInForce`). It never fails because a seed failed:
   * it lists what exists. Only when the table has no row at all (the boot seed has not succeeded yet) does it try the seed
   * once, and a failure of that is logged, not raised.
   */
  async manifest(): Promise<ContentManifest> {
    const db = this.database.db;
    if (!(await anyDocument(db))) {
      try {
        await seedContentDocuments(this.database);
      } catch (error) {
        this.logger.error(`could not seed content documents on a manifest read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return buildManifest(await documentsInForce(db));
  }

  /**
   * One stored version, or 404. `sha256` is known without touching the body (for If-None-Match); `load()` re-validates the
   * body and re-checks the digest and length of the canonical bytes, and a mismatch is a 500 (a corrupted or hand-edited row),
   * never a response whose bytes disagree with the published digest.
   */
  async document(name: ContentDocumentName, version: number): Promise<ServedDocument> {
    const row = await findDocument(this.database.db, name, version);
    if (!row) throw new ApiError(404, "not_found", "No such document.");
    return {
      sha256: row.sha256,
      load: () => {
        try {
          return verifiedBytes(row);
        } catch (error) {
          if (error instanceof DocumentIntegrityError || error instanceof DocumentValidationError) {
            this.logger.error(`stored document ${name} v${version} is unusable: ${error.message}`);
          }
          throw error;
        }
      },
    };
  }
}
