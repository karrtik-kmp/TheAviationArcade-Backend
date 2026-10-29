/**
 * TypeScript source of truth for the enumerated SQL CHECK lists in schema.ts that have no other home (modules,
 * ranks and ledger kinds live in rules/ and balance/). The CHECKs are written out as literals in schema.ts and in
 * the generated migrations; test/schema-parity.test.ts (schema.ts) and test/schema-parity.e2e.test.ts (the live
 * database) fail until a list here, the schema.ts literal and a generated migration all agree.
 */
export const ROUND_STATUSES = ["open", "completed", "abandoned"] as const;
export const ROUND_COMPLETIONS = ["perfect", "standard", "unfinished"] as const;
export const CONTENT_STATUSES = ["approved", "retired"] as const;
export const CONTENT_SOURCES = ["client_sheet", "admin"] as const;
export const ADMIN_AUDIT_ACTIONS = ["content_import"] as const;
export const TRIP_STATUSES = ["open", "completed", "abandoned"] as const;
export const TRIP_OUTCOMES = ["all_correct", "not_all_correct"] as const;

export type RoundStatus = (typeof ROUND_STATUSES)[number];
export type RoundCompletion = (typeof ROUND_COMPLETIONS)[number];
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
export type ContentSource = (typeof CONTENT_SOURCES)[number];
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];
export type TripStatus = (typeof TRIP_STATUSES)[number];
export type TripOutcome = (typeof TRIP_OUTCOMES)[number];
