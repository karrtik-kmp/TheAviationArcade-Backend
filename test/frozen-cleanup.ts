import type pg from "pg";

/**
 * Test-only access to the tables migration 0027 freezes (docs/plans/schema-hardening.md, T1). Their row triggers refuse
 * UPDATE and DELETE (published `media_versions`: UPDATE and DELETE), so a suite that removes the rows it created, or that
 * deliberately corrupts a frozen row to test a guard, turns that one trigger off inside a single transaction and back on
 * before COMMIT. ALTER TABLE is transactional: on any error the ROLLBACK restores the trigger too. E2E files run one at a
 * time (`fileParallelism: false`), and the lock_timeout makes a stray app request fail fast instead of hanging.
 *
 * Never use this pattern under src/ (a source-scan test forbids DISABLE TRIGGER there).
 */
export const FROZEN_TRIGGERS = {
  admin_audit: "admin_audit_append_only",
  miles_ledger: "miles_ledger_append_only",
  hint_ledger: "hint_ledger_append_only",
  store_transactions: "store_transactions_append_only",
  ugs_link_events: "ugs_link_events_append_only",
  media_versions: "media_versions_published_frozen",
} as const;

export type FrozenTable = keyof typeof FROZEN_TRIGGERS;

/** Run `work` on one client with the row triggers of `tables` disabled, in one transaction. */
export async function withFrozenTriggersOff<T>(pool: pg.Pool, tables: readonly FrozenTable[], work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failure: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const table of tables) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${FROZEN_TRIGGERS[table]}`);
    const result = await work(client);
    for (const table of tables) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${FROZEN_TRIGGERS[table]}`);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    // A broken connection can make ROLLBACK throw too: never let that mask the original error.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    // A failed client is destroyed, not returned to the pool in an unknown transaction state.
    client.release(failure);
  }
}

/** `DELETE FROM <table> [WHERE <where>]` past the table's append-only trigger. Returns the number of rows deleted. */
export async function frozenDelete(pool: pg.Pool, table: FrozenTable, where?: string, params: unknown[] = []): Promise<number> {
  return withFrozenTriggersOff(pool, [table], async (client) => {
    const result = await client.query(`DELETE FROM ${table}${where ? ` WHERE ${where}` : ""}`, params);
    return result.rowCount ?? 0;
  });
}
