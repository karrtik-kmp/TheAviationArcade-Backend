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
export const ADMIN_AUDIT_ACTIONS = [
  "content_import",
  "content_publish",
  "content_edit",
  "content_retire",
  "content_restore",
  "role_request",
  "role_approve",
  "role_reject",
  "role_grant",
  "role_revoke",
  "media_upload",
  "media_version",
  "media_edit",
  "media_publish",
  "media_withdraw",
  "content_media_link",
] as const;
export const TRIP_STATUSES = ["open", "completed", "abandoned"] as const;
export const TRIP_OUTCOMES = ["all_correct", "not_all_correct"] as const;
export const CONTENT_DOCUMENT_NAMES = ["field-awards", "clipper-cards", "aircraft-tags"] as const;
/** Account roles (Backend ADR-0002). Only an `active` row grants anything; `admin` includes every `photographer` permission. */
export const ACCOUNT_ROLES = ["player", "photographer", "admin"] as const;
export const ROLE_STATES = ["pending", "active", "rejected", "revoked"] as const;
/** Media pipeline (docs/plans/media-pipeline.md, T2). `published` exactly while `media_items.published_version` is set. */
export const MEDIA_STATES = ["unverified", "published", "withdrawn"] as const;
export const MEDIA_CONTENT_TYPES = ["image/jpeg", "image/png"] as const;
export const MEDIA_UPLOAD_OPERATIONS = ["create", "version"] as const;

export type RoundStatus = (typeof ROUND_STATUSES)[number];
export type RoundCompletion = (typeof ROUND_COMPLETIONS)[number];
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
export type ContentSource = (typeof CONTENT_SOURCES)[number];
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];
export type TripStatus = (typeof TRIP_STATUSES)[number];
export type TripOutcome = (typeof TRIP_OUTCOMES)[number];
export type ContentDocumentName = (typeof CONTENT_DOCUMENT_NAMES)[number];
export type AccountRole = (typeof ACCOUNT_ROLES)[number];
export type RoleState = (typeof ROLE_STATES)[number];
export type MediaState = (typeof MEDIA_STATES)[number];
export type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];
export type MediaUploadOperation = (typeof MEDIA_UPLOAD_OPERATIONS)[number];
