import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../database/database.module.js";
import { contentDrafts } from "../../db/schema.js";
import type { ContentDocumentName } from "../../db/enums.js";
import type { Reader } from "./document-store.js";

/**
 * The ONLY file that writes `content_drafts` (test/content-publish.test.ts keeps it so). Drafts are mutable, one row per document
 * name; every write here happens in a transaction that holds `lockDraft(name)`, so edits, discards and publishes of one name are
 * serialised and the editors' version check (`version`) can never be raced past. No row = draft version 0.
 */
export type DraftRow = { name: ContentDocumentName; version: number; edits: unknown; updatedAt: Date; updatedBy: string };

/**
 * Transaction-scoped advisory lock for a name. Blocks (bounded by the pool's lock_timeout, which maps to a retryable 503) rather
 * than failing: the critical sections are a few statements. The same lock orders a publish after the edits that precede it.
 */
export async function lockDraft(tx: Tx, name: ContentDocumentName): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`content-draft:${name}`}, 0))`);
}

export async function findDraft(db: Reader, name: ContentDocumentName): Promise<DraftRow | undefined> {
  const [row] = await db.select().from(contentDrafts).where(eq(contentDrafts.name, name));
  return row;
}

/**
 * Stores `edits` as draft revision `currentVersion + 1` (creating the row when `currentVersion` is 0). The caller holds the lock
 * and has compared `currentVersion` with the version the editor saw. Returns the new revision.
 */
export async function saveDraft(tx: Tx, name: ContentDocumentName, currentVersion: number, edits: unknown, updatedBy: string): Promise<number> {
  const version = currentVersion + 1;
  if (currentVersion === 0) {
    await tx.insert(contentDrafts).values({ name, version, edits: edits as object, updatedBy });
  } else {
    const written = await tx
      .update(contentDrafts)
      .set({ version, edits: edits as object, updatedAt: sql`now()`, updatedBy })
      .where(eq(contentDrafts.name, name))
      .returning({ version: contentDrafts.version });
    if (written.length !== 1) throw new Error(`content_drafts ${name}: the row vanished under the lock`);
  }
  return version;
}
