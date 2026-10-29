/**
 * Ledger entry kinds. The SQL CHECK lists in src/db/schema.ts (miles_ledger_kind_check, hint_ledger_kind_check) are
 * the only database-side guard and are written out there as literals: adding a kind here needs a generated migration
 * that changes the CHECK. Keep both lists equal (a parity test is brief slice S5).
 */
export const MILES_LEDGER_KINDS = ["round_award", "hint_pack"] as const;
export const HINT_LEDGER_KINDS = ["starter", "hint_pack", "round_spend"] as const;

export type MilesKind = (typeof MILES_LEDGER_KINDS)[number];
export type HintKind = (typeof HINT_LEDGER_KINDS)[number];
