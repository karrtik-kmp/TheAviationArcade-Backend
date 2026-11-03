import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { ApiError } from "../common/errors.js";
import { databaseClockMicros } from "../database/clock.js";
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

/**
 * THE stamp of a content write: one database instant (microseconds), read ONCE after the module lock is held and used for
 * every `created_at`/`updated_at` the transaction writes (receipt, items, audit). Both writers hold the lock, so these
 * stamps are ordered like the commits whatever the process clocks or the pool wait were. The value is a SQL fragment
 * (a timestamptz literal read from the database, never rounded through a JS Date) because the replay check compares
 * stamps in SQL with `>`: an import's items carry exactly the receipt's `created_at` (equal, not later, so they do not
 * count as edits), and a later edit's stamp is strictly greater (a commit takes far longer than one microsecond).
 */
export async function readContentStamp(tx: Tx): Promise<SQL> {
  const result = await tx.execute<{ at: string }>(
    sql`SELECT to_char((${databaseClockMicros()}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
  );
  const at = result.rows[0]?.at;
  if (!at) throw new Error("The database clock was not read.");
  return sql`${at}::timestamptz`;
}
