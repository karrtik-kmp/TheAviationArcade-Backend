/**
 * Ledger entry kinds. The SQL CHECK lists in src/db/schema.ts (miles_ledger_kind_check, hint_ledger_kind_check) are
 * the only database-side guard and are written out there as literals: adding a kind here needs a generated migration
 * that changes the CHECK. Keep both lists equal (test/schema-parity.test.ts and .e2e.test.ts enforce it).
 */
export const MILES_LEDGER_KINDS = [
  "round_award", // credit: Miles earned by a Round
  "hint_pack", // debit: the Miles hint pack (/v1/shop/miles-hint-pack), Miles spent on hints
  "store_purchase", // credit: a store Miles pack
] as const;
export const HINT_LEDGER_KINDS = ["starter", "hint_pack", "round_spend", "trip_grant", "day_streak_grant", "store_purchase"] as const;

export type MilesKind = (typeof MILES_LEDGER_KINDS)[number];
export type HintKind = (typeof HINT_LEDGER_KINDS)[number];
