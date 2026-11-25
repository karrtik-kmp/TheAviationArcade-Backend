import { readFileSync } from "node:fs";
import type pg from "pg";
import { RANK_CATALOG } from "../src/rules/catalog.js";
import { RANKS } from "../src/rules/ranks.js";
import type { Rank } from "../src/rules/ranks.js";
import { resetTripDeckCaches } from "../src/trips/trip-deck.js";

/**
 * Code Search test rows: real boards from the client's master pack (`test/fixtures/code-search-sample.json`, 12 per rank, client
 * content for tests only), inserted straight into `content_items` so a Trip-open test needs neither the importer nor the full pack.
 * The pack's `rank` is Unity's enum name (`FirstOfficer`); the table's is the rank id (`first-officer`).
 */

export type PackRecord = { id: string; rank: string; letters: string; targets: unknown[] };

const SAMPLE = new URL("./fixtures/code-search-sample.json", import.meta.url);

export function loadSampleRecords(): PackRecord[] | undefined {
  try {
    return (JSON.parse(readFileSync(SAMPLE, "utf8")) as { records: PackRecord[] }).records;
  } catch {
    return undefined;
  }
}

export function rankOfRecord(record: PackRecord): Rank {
  const rank = RANKS.find((r) => RANK_CATALOG[r].unity === record.rank);
  if (!rank) throw new Error(`Unknown pack rank ${record.rank}`);
  return rank;
}

/** Every code-search row removed (the module's rows belong to the test that runs; e2e files never run in parallel). */
export async function clearCodeSearchItems(sql: pg.Pool): Promise<void> {
  await sql.query("DELETE FROM content_items WHERE module = 'code-search'");
  // Re-inserted rows restart at version 1: the in-process board memo must not answer for the deleted ones.
  resetTripDeckCaches();
}

/** Insert `records` as approved version-1 rows. */
export async function insertCodeSearchItems(sql: pg.Pool, records: readonly PackRecord[]): Promise<void> {
  for (const record of records) {
    await sql.query(
      `INSERT INTO content_items (module, id, rank, status, source, data, version, created_at, updated_at, updated_by, created_by)
       VALUES ('code-search', $1, $2, 'approved', 'client_sheet', $3::jsonb, 1, now(), now(), 'test', 'test')`,
      [record.id, rankOfRecord(record), JSON.stringify({ letters: record.letters, targets: record.targets })],
    );
  }
}
