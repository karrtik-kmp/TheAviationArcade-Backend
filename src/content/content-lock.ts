import { sql } from "drizzle-orm";
import { ApiError } from "../common/errors.js";
import type { Tx } from "../database/database.module.js";

/**
 * The per-module lock that serialises everything writing a module's content_items: import apply and the staff
 * item edits. Try, never wait: a waiting request would hold a pooled connection, so a busy module is a
 * retryable 409 `import_in_progress` instead.
 */
export async function lockContentModule(tx: Tx, module: string): Promise<void> {
  const lock = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`content-import:${module}`}, 0)) AS locked`,
  );
  if (lock.rows[0]?.locked !== true) {
    throw new ApiError(409, "import_in_progress", "Another import or edit for this module is running. Retry shortly.", { "Retry-After": "2" });
  }
}
