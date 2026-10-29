import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { HINT_LEDGER_KINDS, MILES_LEDGER_KINDS } from "../src/balance/ledger-kinds.js";
import {
  ADMIN_AUDIT_ACTIONS,
  CONTENT_SOURCES,
  CONTENT_STATUSES,
  ROUND_COMPLETIONS,
  ROUND_STATUSES,
  TRIP_OUTCOMES,
  TRIP_STATUSES,
} from "../src/db/enums.js";
import * as schema from "../src/db/schema.js";
import { CARD_MODULES } from "../src/rules/clipper-cards.js";
import { FIELD_AWARD_IDS } from "../src/rules/field-awards.js";
import { MODULE_IDS } from "../src/rules/modules.js";
import { RANKS } from "../src/rules/ranks.js";

/** Every enumerated (IN-list) CHECK constraint, keyed "table.constraint", with its TypeScript source of truth. */
export const EXPECTED_ENUM_CHECKS: Readonly<Record<string, readonly string[]>> = {
  "players.players_active_rank_check": RANKS,
  "rounds.rounds_module_check": MODULE_IDS,
  "rounds.rounds_rank_check": RANKS,
  "rounds.rounds_status_check": ROUND_STATUSES,
  "rounds.rounds_completion_check": ROUND_COMPLETIONS,
  "rounds.rounds_promoted_from_check": RANKS,
  "rounds.rounds_promoted_to_check": RANKS,
  "miles_ledger.miles_ledger_kind_check": MILES_LEDGER_KINDS,
  "hint_ledger.hint_ledger_kind_check": HINT_LEDGER_KINDS,
  "content_imports.content_imports_module_check": MODULE_IDS,
  "content_items.content_items_module_check": MODULE_IDS,
  "content_items.content_items_rank_check": RANKS,
  "content_items.content_items_status_check": CONTENT_STATUSES,
  "content_items.content_items_source_check": CONTENT_SOURCES,
  "admin_audit.admin_audit_action_check": ADMIN_AUDIT_ACTIONS,
  "trips.trips_module_check": MODULE_IDS,
  "trips.trips_rank_check": RANKS,
  "trips.trips_status_check": TRIP_STATUSES,
  "trips.trips_outcome_check": TRIP_OUTCOMES,
  "player_counters.player_counters_previous_outcome_check": TRIP_OUTCOMES,
  "player_clipper_cards.player_clipper_cards_module_check": CARD_MODULES,
  "player_field_awards.player_field_awards_award_id_check": FIELD_AWARD_IDS,
};

/** The quoted string literals of a CHECK expression, in order. Works on schema.ts text and on pg_get_constraintdef output. */
export function extractLiterals(expression: string): string[] {
  return [...expression.matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] ?? "").replace(/''/g, "'"));
}

/** Human-readable difference between two lists compared as sets; null when equal (a duplicate counts as a difference). */
export function diffLists(actual: readonly string[], expected: readonly string[]): string | null {
  const missing = expected.filter((v) => !actual.includes(v));
  const extra = actual.filter((v) => !expected.includes(v));
  const duplicated = actual.filter((v, i) => actual.indexOf(v) !== i);
  if (!missing.length && !extra.length && !duplicated.length) return null;
  const lines = [
    `  expected (TypeScript): ${JSON.stringify([...expected])}`,
    `  actual   (SQL CHECK): ${JSON.stringify([...actual])}`,
  ];
  if (missing.length) lines.push(`  missing from the CHECK: ${JSON.stringify(missing)}`);
  if (extra.length) lines.push(`  in the CHECK but not in TypeScript: ${JSON.stringify(extra)}`);
  if (duplicated.length) lines.push(`  duplicated in the CHECK: ${JSON.stringify([...new Set(duplicated)])}`);
  return lines.join("\n");
}

/** Compare actual lists (by "table.constraint") with the expectations; one readable message per problem. */
export function compareChecks(
  actual: Readonly<Record<string, readonly string[]>>,
  expected: Readonly<Record<string, readonly string[]>> = EXPECTED_ENUM_CHECKS,
  where = "schema.ts",
): string[] {
  const problems: string[] = [];
  for (const [key, list] of Object.entries(expected)) {
    const found = actual[key];
    if (!found) {
      problems.push(`${key}: no enumerated CHECK found in ${where}`);
      continue;
    }
    const d = diffLists(found, list);
    if (d) problems.push(`${key}: ${where} differs from TypeScript\n${d}`);
  }
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) {
      problems.push(`${key}: enumerated CHECK in ${where} has no TypeScript list (add it to EXPECTED_ENUM_CHECKS)`);
    }
  }
  return problems;
}

/** Enumerated CHECKs declared in schema.ts, rendered to SQL and reduced to their literals. */
export function schemaEnumChecks(): Record<string, string[]> {
  const dialect = new PgDialect();
  const out: Record<string, string[]> = {};
  for (const value of Object.values(schema)) {
    if (typeof value !== "object" || value === null) continue;
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as PgTable);
    } catch {
      continue; // not a table (sequence, ...)
    }
    for (const c of config.checks) {
      const { sql } = dialect.sqlToQuery(c.value);
      if (/\bIN\b/i.test(sql) && extractLiterals(sql).length > 0) out[`${config.name}.${c.name}`] = extractLiterals(sql);
    }
  }
  return out;
}
