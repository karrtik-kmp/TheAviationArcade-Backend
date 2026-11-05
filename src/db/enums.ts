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
  "role_block",
  "role_unblock",
  "role_email_edit",
  "media_upload",
  "media_version",
  "media_edit",
  "media_publish",
  "media_withdraw",
  "content_media_link",
  "media_rights",
  "media_import",
  "store_product_create",
  "store_product_edit",
  "store_product_retire",
  "store_product_restore",
  "editorial_create",
  "editorial_save",
  "content_prepare",
  "release_create",
  "release_activate",
  "release_restore",
] as const;
export const TRIP_STATUSES = ["open", "completed", "abandoned"] as const;
export const TRIP_OUTCOMES = ["all_correct", "not_all_correct"] as const;
export const CONTENT_DOCUMENT_NAMES = ["field-awards", "clipper-cards", "aircraft-tags"] as const;
/** Account roles (Backend ADR-0002). Only an `active` row grants anything (`blocked` is a photographer-only state, plan R-d); `admin` includes every `photographer` permission. */
export const ACCOUNT_ROLES = ["player", "photographer", "admin"] as const;
export const ROLE_STATES = ["pending", "active", "rejected", "revoked", "blocked"] as const;
/** Media pipeline (docs/plans/media-pipeline.md, T2). `published` exactly while `media_items.published_version` is set. */
export const MEDIA_STATES = ["unverified", "published", "withdrawn"] as const;
export const MEDIA_CONTENT_TYPES = ["image/jpeg", "image/png"] as const;
export const MEDIA_UPLOAD_OPERATIONS = ["create", "version"] as const;
/**
 * The photographer's rights statement on a file version (docs/plans/media-rights-and-public.md). Wire spelling = database
 * spelling. `d1_private_review` is set only by the D1 import command and is never accepted on the wire.
 */
export const MEDIA_RIGHTS_STATEMENTS = ["v1_own", "v1_authorised", "d1_private_review"] as const;
/** The statements a published version may carry (the publishable CHECK). Also the only ones the API accepts. */
export const MEDIA_PUBLISHABLE_RIGHTS = ["v1_own", "v1_authorised"] as const;
/** Store catalog and purchases (docs/plans/purchases.md, migration 0020). */
export const STORE_PRODUCT_KINDS = ["hint_pack", "first_class_pass", "miles_pack"] as const;
export const STORE_PRODUCT_STATUSES = ["active", "retired"] as const;
/** Informational only for a Pass: the store's expiry is authoritative. ISO 8601 durations. */
export const STORE_PASS_PERIODS = ["P1M", "P1Y"] as const;
export const STORES = ["apple", "google"] as const;
export const STORE_ENVIRONMENTS = ["production", "sandbox", "fake"] as const;
/** Pinned now for the notification wave (P4); the purchase route only writes `active`. */
export const STORE_CLAIM_KINDS = ["transaction", "subscription"] as const;
export const STORE_SUBSCRIPTION_STATUSES = ["active", "grace", "billing_retry", "on_hold", "expired", "revoked"] as const;

/** Editorial desks (docs/plans/website-content.md W1, migration 0022). Own literals: Plane of the Day is not a Module, so this is never derived from MODULE_IDS. */
export const EDITORIAL_KINDS = ["identifier", "plane-of-the-day"] as const;
export const EDITORIAL_STATUSES = ["draft", "scheduled", "published", "archived"] as const;

/** Military preparation stages, in order (docs/plans/website-content.md W3, migration 0023; website/lib/military.ts). */
export const PREP_STAGES = ["missing_photo", "rights_checked", "content_prepared", "previewed", "approved"] as const;

/** Military releases (docs/plans/website-content.md W3 commit 2, migration 0024). v1 records one deal rule and one Flight kind. */
export const RELEASE_DEAL_RULES = ["nearest-ranks"] as const;
export const RELEASE_FLIGHT_KINDS = ["choice"] as const;
export const RELEASE_ACTIVATION_KINDS = ["activate", "restore"] as const;

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
export type MediaRightsStatement = (typeof MEDIA_RIGHTS_STATEMENTS)[number];
export type MediaPublishableRights = (typeof MEDIA_PUBLISHABLE_RIGHTS)[number];
export type MediaUploadOperation = (typeof MEDIA_UPLOAD_OPERATIONS)[number];
export type StoreProductKind = (typeof STORE_PRODUCT_KINDS)[number];
export type StoreProductStatus = (typeof STORE_PRODUCT_STATUSES)[number];
export type StorePassPeriod = (typeof STORE_PASS_PERIODS)[number];
export type StoreName = (typeof STORES)[number];
export type StoreEnvironment = (typeof STORE_ENVIRONMENTS)[number];
export type StoreClaimKind = (typeof STORE_CLAIM_KINDS)[number];
export type PrepStage = (typeof PREP_STAGES)[number];
export type ReleaseDealRule = (typeof RELEASE_DEAL_RULES)[number];
export type ReleaseFlightKind = (typeof RELEASE_FLIGHT_KINDS)[number];
export type ReleaseActivationKind = (typeof RELEASE_ACTIVATION_KINDS)[number];
export type EditorialKind = (typeof EDITORIAL_KINDS)[number];
export type EditorialStatus = (typeof EDITORIAL_STATUSES)[number];
export type StoreSubscriptionStatus = (typeof STORE_SUBSCRIPTION_STATUSES)[number];
