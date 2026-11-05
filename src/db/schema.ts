import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  uuid,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  AccountRole,
  AdminAuditAction,
  ContentDocumentName,
  ContentSource,
  ContentStatus,
  EditorialKind,
  PrepStage,
  EditorialStatus,
  MediaContentType,
  MediaRightsStatement,
  MediaState,
  MediaUploadOperation,
  RoleState,
  RoundCompletion,
  RoundStatus,
  StoreEnvironment,
  StoreName,
  StorePassPeriod,
  StoreProductKind,
  StoreProductStatus,
  StoreClaimKind,
  StoreSubscriptionStatus,
  TripOutcome,
  TripStatus,
} from "./enums.js";

/**
 * Player progress. One row per server principal: firebase:<project>:<uid>.
 * No email, display name or Callsign is stored here (see README.md).
 * Timestamps are timestamptz; the API converts to ISO strings at the edge.
 */

const RANK_LIST = sql`('trainee', 'first-officer', 'captain', 'check-airman', 'chief-pilot')`;

const MODULE_LIST = sql`('airport-spotter', 'atc-match', 'call-sign-match', 'identifier',
  'aircraft-identifier-military', 'code-search', 'runway-identifier', 'tail-identifier')`;

export const players = pgTable(
  "players",
  {
    id: text("id").primaryKey(),
    statusPoints: integer("status_points").notNull().default(0),
    miles: integer("miles").notNull().default(0),
    // Co-Pilot hint balance. Created with STARTER_HINTS by PUT /v1/me (the column default is only a floor).
    hints: integer("hints").notNull().default(0),
    perfectStreak: integer("perfect_streak").notNull().default(0),
    // NULL means "fly at Certified Rank" and follows promotions. A value is a dialled-down Active Rank.
    activeRank: text("active_rank"),
    // Set only by a future verified store purchase. Never client-writable.
    firstClassUntil: timestamp("first_class_until", { withTimezone: true }),
    // Bumped on every STORED progress change (PlayerBalance owns the bump). It orders stored changes; evaluatedAt (database
    // clock) orders time-derived views at one version, e.g. lazy Trip expiry. Game rule: order by (version, evaluatedAt).
    version: integer("version").notNull().default(1),
    // Freshness of GET /v1/me/logbook (T5; user ruling 2026-10-29): bumped by PlayerBalance.update, in the same UPDATE, by
    // exactly the writes that change what the Logbook returns (a banked Round, a completed segment). It is NOT `version`:
    // a completion that pays no hint and resets no streak changes the Logbook but not Progress. Never client-visible
    // except inside the Logbook ETag and `Logbook.version`.
    logbookVersion: integer("logbook_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("players_status_points_check", sql`${t.statusPoints} >= 0`),
    check("players_logbook_version_check", sql`${t.logbookVersion} >= 1`),
    check("players_miles_check", sql`${t.miles} >= 0`),
    check("players_hints_check", sql`${t.hints} >= 0`),
    check("players_perfect_streak_check", sql`${t.perfectStreak} >= 0`),
    check("players_active_rank_check", sql`${t.activeRank} IS NULL OR ${t.activeRank} IN ${RANK_LIST}`),
    check("players_version_check", sql`${t.version} >= 1`),
  ],
);

/**
 * A server-issued Flight Segment (Unity "Trip"): ten Rounds of one module. Module, Active Rank and Pleasure Cruise are
 * snapshotted at open for the whole segment. One open segment per player. `idempotency_key` is the open request's
 * Idempotency-Key (U14): the same key replays the segment it opened. The result columns (outcome ... catalog_version)
 * are written at completion (slice T3, trip-completion.ts). Written only inside PlayerBalance.update (lock order: player, trip, Round).
 */
export const trips = pgTable(
  "trips",
  {
    id: uuid("id").primaryKey(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    module: text("module").notNull(),
    rank: text("rank").notNull(),
    pleasureCruise: boolean("pleasure_cruise").notNull(),
    status: text("status").$type<TripStatus>().notNull().default("open"),
    flightCount: integer("flight_count").notNull().default(10),
    roundsBanked: integer("rounds_banked").notNull().default(0),
    localDate: date("local_date", { mode: "string" }).notNull(),
    utcOffsetMinutes: integer("utc_offset_minutes").notNull(),
    contentVersion: text("content_version").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    // 30 minutes after the last activity (open, Round issue, Round result). Expiry is lazy: there is no sweeper.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    outcome: text("outcome").$type<TripOutcome>(),
    correct: integer("correct"),
    hintUsed: boolean("hint_used"),
    bestStreak: integer("best_streak"),
    miles: integer("miles"),
    statusPoints: integer("status_points"),
    goAround: boolean("go_around"),
    nightTrip: boolean("night_trip"),
    completionLocalDate: date("completion_local_date", { mode: "string" }),
    catalogVersion: integer("catalog_version"),
  },
  (t) => [
    uniqueIndex("trips_idempotency").on(t.playerId, t.idempotencyKey),
    // At most one open segment per player, enforced by the database.
    uniqueIndex("trips_one_open_per_player").on(t.playerId).where(sql`${t.status} = 'open'`),
    index("trips_player_completed").on(t.playerId, t.closedAt).where(sql`${t.status} = 'completed'`),
    check("trips_module_check", sql`${t.module} IN ${MODULE_LIST}`),
    check("trips_rank_check", sql`${t.rank} IN ${RANK_LIST}`),
    check("trips_status_check", sql`${t.status} IN ('open', 'completed', 'abandoned')`),
    check("trips_idempotency_key_check", sql`${t.idempotencyKey} ~ '^[A-Za-z0-9_-]{1,128}$'`),
    check("trips_flight_count_check", sql`${t.flightCount} = 10`),
    check("trips_rounds_banked_check", sql`${t.roundsBanked} BETWEEN 0 AND 10`),
    check("trips_utc_offset_check", sql`${t.utcOffsetMinutes} BETWEEN -720 AND 840`),
    check("trips_content_version_check", sql`length(${t.contentVersion}) BETWEEN 1 AND 64`),
    check("trips_expires_after_open_check", sql`${t.expiresAt} > ${t.openedAt}`),
    check("trips_closed_at_check", sql`(${t.status} <> 'open') = (${t.closedAt} IS NOT NULL)`),
    check("trips_outcome_check", sql`${t.outcome} IS NULL OR ${t.outcome} IN ('all_correct', 'not_all_correct')`),
    check("trips_correct_check", sql`${t.correct} IS NULL OR ${t.correct} BETWEEN 0 AND 10`),
    check("trips_best_streak_check", sql`${t.bestStreak} IS NULL OR ${t.bestStreak} BETWEEN 0 AND 10`),
    check("trips_miles_check", sql`${t.miles} IS NULL OR ${t.miles} >= 0`),
    check("trips_status_points_check", sql`${t.statusPoints} IS NULL OR ${t.statusPoints} >= 0`),
    check(
      "trips_completed_check",
      sql`${t.status} <> 'completed' OR (${t.roundsBanked} = 10 AND ${t.outcome} IS NOT NULL)`,
    ),
  ],
);

/**
 * A server-issued, single-use Round. Rank and Pleasure Cruise are snapshotted at issue.
 * Starting a Round abandons the player's other open Rounds; completed Rounds are never abandoned.
 */
export const rounds = pgTable(
  "rounds",
  {
    id: text("id").primaryKey(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    module: text("module").notNull(),
    rank: text("rank").notNull(),
    pleasureCruise: boolean("pleasure_cruise").notNull(),
    status: text("status").$type<RoundStatus>().notNull().default("open"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completionId: text("completion_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    finished: boolean("finished"),
    errorCount: integer("error_count"),
    // What the client reported (OR-ed with hintUsed at submit); NULL until the result arrives.
    usedHint: boolean("used_hint"),
    // Set by POST /v1/rounds/:roundId/hint when a hint was paid for. A paid hint cannot be hidden at submit.
    hintUsed: boolean("hint_used").notNull().default(false),
    timeRemaining: doublePrecision("time_remaining"),
    completion: text("completion").$type<RoundCompletion>(),
    speedBonus: boolean("speed_bonus"),
    streakMiles: integer("streak_miles"),
    firstClassPass: boolean("first_class_pass"),
    spAwarded: integer("sp_awarded"),
    milesAwarded: integer("miles_awarded"),
    // Certified Rank before and after this Round, set only when it promoted the player, so a replay
    // reports the same promotion.
    promotedFrom: text("promoted_from"),
    promotedTo: text("promoted_to"),
    // Flight Segment membership (T2). NULL only for pre-segment dev rows; every new Round has both.
    tripId: uuid("trip_id").references(() => trips.id, { onDelete: "cascade" }),
    flightNumber: integer("flight_number"),
    // Flight facts reported with the result (T2): the wire `aircraftKey` (commercial family or Military item id), the
    // Card key the server derived from it (null for modules without Cards), time-to-answer and answers submitted.
    aircraftKey: text("aircraft_key"),
    cardKey: text("card_key"),
    answerMs: integer("answer_ms"),
    attempts: integer("attempts"),
    // The Round's local day (server time of the result + the segment's offset); set when banked.
    localDate: date("local_date", { mode: "string" }),
    // This Round's result began the 7th consecutive local day and granted the day_streak_grant hint (for replays).
    dayStreakGrant: boolean("day_streak_grant").notNull().default(false),
  },
  (t) => [
    index("rounds_player").on(t.playerId, t.issuedAt),
    index("rounds_trip").on(t.tripId),
    uniqueIndex("rounds_trip_flight_banked").on(t.tripId, t.flightNumber).where(sql`${t.status} = 'completed'`),
    check("rounds_flight_number_check", sql`${t.flightNumber} IS NULL OR ${t.flightNumber} BETWEEN 1 AND 10`),
    check("rounds_trip_flight_check", sql`(${t.tripId} IS NULL) = (${t.flightNumber} IS NULL)`),
    check("rounds_answer_ms_check", sql`${t.answerMs} IS NULL OR ${t.answerMs} BETWEEN 0 AND 1800000`),
    check("rounds_attempts_check", sql`${t.attempts} IS NULL OR ${t.attempts} >= 0`),
    // At most one in-flight Round per player, enforced by the database, not just by issueRound.
    uniqueIndex("rounds_one_open_per_player").on(t.playerId).where(sql`${t.status} = 'open'`),
    check(
      "rounds_module_check",
      sql`${t.module} IN ('airport-spotter', 'atc-match', 'call-sign-match', 'identifier',
        'aircraft-identifier-military', 'code-search', 'runway-identifier', 'tail-identifier')`,
    ),
    check("rounds_rank_check", sql`${t.rank} IN ${RANK_LIST}`),
    check("rounds_status_check", sql`${t.status} IN ('open', 'completed', 'abandoned')`),
    check(
      "rounds_completion_check",
      sql`${t.completion} IS NULL OR ${t.completion} IN ('perfect', 'standard', 'unfinished')`,
    ),
    check(
      "rounds_promoted_from_check",
      sql`${t.promotedFrom} IS NULL OR ${t.promotedFrom} IN ${RANK_LIST}`,
    ),
    check("rounds_promoted_to_check", sql`${t.promotedTo} IS NULL OR ${t.promotedTo} IN ${RANK_LIST}`),
    check("rounds_error_count_check", sql`${t.errorCount} IS NULL OR ${t.errorCount} >= 0`),
    check(
      "rounds_time_remaining_check",
      sql`${t.timeRemaining} IS NULL OR ${t.timeRemaining} BETWEEN 0 AND 1`,
    ),
    check("rounds_sp_awarded_check", sql`${t.spAwarded} IS NULL OR ${t.spAwarded} >= 0`),
    check("rounds_miles_awarded_check", sql`${t.milesAwarded} IS NULL OR ${t.milesAwarded} >= 0`),
    check("rounds_streak_miles_check", sql`${t.streakMiles} IS NULL OR ${t.streakMiles} >= 0`),
    check("rounds_expires_after_issue_check", sql`${t.expiresAt} > ${t.issuedAt}`),
    check(
      "rounds_completed_has_award_check",
      sql`${t.status} <> 'completed'
        OR (${t.completionId} IS NOT NULL AND ${t.spAwarded} IS NOT NULL AND ${t.milesAwarded} IS NOT NULL)`,
    ),
  ],
);

/**
 * Append-only Miles ledger. players.miles = SUM(delta) per player. UNIQUE (player_id, kind, ref) is the
 * idempotency key: a Round pays once (ref = roundId), a hint pack bills once per Idempotency-Key.
 */
export const milesLedger = pgTable(
  "miles_ledger",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("miles_ledger_idempotency").on(t.playerId, t.kind, t.ref),
    index("miles_ledger_player_time").on(t.playerId, t.createdAt),
    check("miles_ledger_delta_check", sql`${t.delta} <> 0`),
    check("miles_ledger_kind_check", sql`${t.kind} IN ('round_award', 'hint_pack', 'store_purchase')`),
  ],
);

/** Append-only hint ledger, same shape as the Miles one. players.hints = SUM(delta) per player. */
export const hintLedger = pgTable(
  "hint_ledger",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("hint_ledger_idempotency").on(t.playerId, t.kind, t.ref),
    index("hint_ledger_player_time").on(t.playerId, t.createdAt),
    check("hint_ledger_delta_check", sql`${t.delta} <> 0`),
    check(
      "hint_ledger_kind_check",
      sql`${t.kind} IN ('starter', 'hint_pack', 'round_spend', 'trip_grant', 'day_streak_grant', 'store_purchase')`,
    ),
  ],
);

/**
 * One staff xlsx import (Phase 5.0). The original file lives in blob storage under blob_key; this row is the
 * receipt. UNIQUE (module, sha256) is the idempotency key: identical bytes replay the earlier result.
 */
export const contentImports = pgTable(
  "content_imports",
  {
    id: text("id").primaryKey(),
    module: text("module").notNull(),
    fileName: text("file_name").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    blobKey: text("blob_key").notNull(),
    created: integer("created").notNull(),
    updated: integer("updated").notNull(),
    unchanged: integer("unchanged").notNull(),
    // Items a client-sheet import retired because the file no longer lists them.
    retired: integer("retired").notNull().default(0),
    importedBy: text("imported_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("content_imports_module_sha256").on(t.module, t.sha256),
    check("content_imports_module_check", sql`${t.module} IN ${MODULE_LIST}`),
    check("content_imports_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("content_imports_byte_size_check", sql`${t.byteSize} > 0`),
    check("content_imports_counts_check", sql`${t.created} >= 0 AND ${t.updated} >= 0 AND ${t.unchanged} >= 0 AND ${t.retired} >= 0`),
  ],
);

/**
 * Media pipeline (docs/plans/media-pipeline.md, ADR-0001). One row per image; the bytes live in Bunny Storage under a key
 * derived from the version's sha256 and content type (not stored). `revision` is the optimistic fence for every write
 * (licence, state, new version). `draft_version` is the latest upload; `published_version` is what players and releases see and
 * stays live until an admin publishes a change (user 2026-11-03). `state = 'published'` exactly while `published_version` is set.
 * No foreign key from here to media_versions (it would be circular): the service keeps both pointers on existing versions,
 * and a test checks it. Media is never deleted. Timestamps come from the database clock (src/database/clock.ts): no default.
 * Rendered `med-<id>` in the API.
 */
export const mediaItems = pgTable(
  "media_items",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    // The uploader's principal (firebase:<projectId>:<uid>), from the verified token.
    owner: text("owner").notNull(),
    state: text("state").$type<MediaState>().notNull(),
    revision: integer("revision").notNull().default(1),
    draftVersion: integer("draft_version").notNull(),
    publishedVersion: integer("published_version"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("media_items_owner_id").on(t.owner, t.id.desc()),
    index("media_items_state_id").on(t.state, t.id.desc()),
    check("media_items_owner_check", sql`length(${t.owner}) BETWEEN 1 AND 256`),
    check("media_items_state_check", sql`${t.state} IN ('unverified', 'published', 'withdrawn')`),
    check("media_items_revision_check", sql`${t.revision} >= 1`),
    check("media_items_draft_version_check", sql`${t.draftVersion} >= 1`),
    check(
      "media_items_published_version_check",
      sql`${t.publishedVersion} IS NULL OR ${t.publishedVersion} BETWEEN 1 AND ${t.draftVersion}`,
    ),
    check("media_items_published_state_check", sql`(${t.state} = 'published') = (${t.publishedVersion} IS NOT NULL)`),
    check("media_items_created_by_check", sql`length(${t.createdBy}) BETWEEN 1 AND 256`),
    check("media_items_updated_by_check", sql`length(${t.updatedBy}) BETWEEN 1 AND 256`),
  ],
);

/**
 * One uploaded file of a media item, with the licence that applies to it (so a published credit is frozen with its file).
 * `published_at` is stamped by the publish step on the version that goes live; the publishable CHECK makes the database
 * refuse a published version without a licence name and, when credit is required, a credit name. Licence fields are
 * nullable while the version is still a draft.
 */
export const mediaVersions = pgTable(
  "media_versions",
  {
    mediaId: bigint("media_id", { mode: "number" })
      .notNull()
      .references(() => mediaItems.id),
    version: integer("version").notNull(),
    sha256: text("sha256").notNull(),
    contentType: text("content_type").$type<MediaContentType>().notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    creditName: text("credit_name"),
    creditRequired: boolean("credit_required").notNull(),
    licenceName: text("licence_name"),
    licenceUrl: text("licence_url"),
    sourceUrl: text("source_url"),
    attributionText: text("attribution_text"),
    // The photographer's rights statement for this file (docs/plans/media-rights-and-public.md): all three set or all null. Null
    // only on rows from before migration 0019. Staff-only: never part of an ImageRef.
    rightsStatement: text("rights_statement").$type<MediaRightsStatement>(),
    rightsStatedBy: text("rights_stated_by"),
    rightsStatedAt: timestamp("rights_stated_at", { withTimezone: true }),
    // Staff-only photo description (1-2000 characters, newlines allowed).
    description: text("description"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: "media_versions_pk", columns: [t.mediaId, t.version] }),
    index("media_versions_sha256").on(t.sha256),
    check("media_versions_version_check", sql`${t.version} >= 1`),
    check("media_versions_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("media_versions_content_type_check", sql`${t.contentType} IN ('image/jpeg', 'image/png')`),
    check("media_versions_byte_size_check", sql`${t.byteSize} BETWEEN 1 AND 5242880`),
    check("media_versions_width_check", sql`${t.width} BETWEEN 1 AND 4096`),
    check("media_versions_height_check", sql`${t.height} BETWEEN 1 AND 4096`),
    check("media_versions_credit_name_check", sql`${t.creditName} IS NULL OR length(${t.creditName}) BETWEEN 1 AND 200`),
    check("media_versions_licence_name_check", sql`${t.licenceName} IS NULL OR length(${t.licenceName}) BETWEEN 1 AND 200`),
    check(
      "media_versions_licence_url_check",
      sql`${t.licenceUrl} IS NULL OR (${t.licenceUrl} ~ '^https?://' AND length(${t.licenceUrl}) <= 2048)`,
    ),
    check(
      "media_versions_source_url_check",
      sql`${t.sourceUrl} IS NULL OR (${t.sourceUrl} ~ '^https?://' AND length(${t.sourceUrl}) <= 2048)`,
    ),
    check("media_versions_attribution_check", sql`${t.attributionText} IS NULL OR length(${t.attributionText}) <= 1000`),
    check("media_versions_created_by_check", sql`length(${t.createdBy}) BETWEEN 1 AND 256`),
    check("media_versions_rights_statement_check", sql`${t.rightsStatement} IN ('v1_own', 'v1_authorised', 'd1_private_review')`),
    check(
      "media_versions_rights_all_or_none_check",
      sql`(${t.rightsStatement} IS NULL) = (${t.rightsStatedBy} IS NULL) AND (${t.rightsStatement} IS NULL) = (${t.rightsStatedAt} IS NULL)`,
    ),
    check("media_versions_description_check", sql`${t.description} IS NULL OR length(${t.description}) BETWEEN 1 AND 2000`),
    // A NULL statement would pass an IN test (NULL is not false), hence the explicit IS NOT NULL.
    // Migration 0019 adds this constraint NOT VALID (by hand; drizzle cannot emit it): published rows from before 0019 have no
    // statement and stay as they are, while every new or changed row must satisfy it.
    check(
      "media_versions_publishable_check",
      sql`${t.publishedAt} IS NULL OR (${t.licenceName} IS NOT NULL AND (NOT ${t.creditRequired} OR ${t.creditName} IS NOT NULL) AND ${t.rightsStatement} IS NOT NULL AND ${t.rightsStatement} IN ('v1_own', 'v1_authorised'))`,
    ),
  ],
);

/**
 * Which external photo each imported media item came from (the D1 import command). One media item per source row, and one source
 * row per media item; the claim is inserted in the same transaction as the item, so a repeated import finds it and does nothing.
 */
export const mediaImports = pgTable(
  "media_imports",
  {
    sourceSystem: text("source_system").notNull(),
    sourceId: text("source_id").notNull(),
    mediaId: bigint("media_id", { mode: "number" })
      .notNull()
      .unique("media_imports_media_id_unique")
      .references(() => mediaItems.id),
    owner: text("owner").notNull(),
    sha256: text("sha256").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: "media_imports_pk", columns: [t.sourceSystem, t.sourceId] }),
    check("media_imports_source_system_check", sql`${t.sourceSystem} = 'd1'`),
    check("media_imports_source_id_check", sql`length(${t.sourceId}) BETWEEN 1 AND 128`),
    check("media_imports_owner_check", sql`length(${t.owner}) BETWEEN 1 AND 256`),
    check("media_imports_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Idempotency claims for media uploads: the same (principal, Idempotency-Key) replays the item/version it created. Claimed with
 * INSERT ... ON CONFLICT DO NOTHING RETURNING after the item/version insert, in the same transaction. The key is scoped to the
 * principal, so two accounts may use the same key. `sha256` is the uploaded bytes' digest (equal = replay, else 422).
 */
export const mediaUploadKeys = pgTable(
  "media_upload_keys",
  {
    principal: text("principal").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    operation: text("operation").$type<MediaUploadOperation>().notNull(),
    mediaId: bigint("media_id", { mode: "number" }).notNull(),
    version: integer("version").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: "media_upload_keys_pk", columns: [t.principal, t.idempotencyKey] }),
    foreignKey({
      name: "media_upload_keys_version_fk",
      columns: [t.mediaId, t.version],
      foreignColumns: [mediaVersions.mediaId, mediaVersions.version],
    }),
    check("media_upload_keys_principal_check", sql`length(${t.principal}) BETWEEN 1 AND 256`),
    check("media_upload_keys_idempotency_key_check", sql`${t.idempotencyKey} ~ '^[A-Za-z0-9_-]{1,128}$'`),
    check("media_upload_keys_operation_check", sql`${t.operation} IN ('create', 'version')`),
    check("media_upload_keys_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Admin-curated question content: the source of truth for the website admin and, later, Unity. One row per
 * (module, id). `data` is the module payload, validated by that module's mapping before every write. No
 * email is stored: updated_by is the staff principal.
 */
export const contentItems = pgTable(
  "content_items",
  {
    module: text("module").notNull(),
    id: text("id").notNull(),
    rank: text("rank").notNull(),
    // approved | retired. A client-sheet import retires rows its file no longer lists; drafts come later.
    status: text("status").$type<ContentStatus>().notNull(),
    source: text("source").$type<ContentSource>().notNull(),
    data: jsonb("data").notNull(),
    version: integer("version").notNull().default(1),
    importId: text("import_id").references(() => contentImports.id),
    // Military only: the Clipper Card key (`mil:` + normalised answer), computed once and FROZEN here (design 3.5): set by
    // the importer on create, or by the first Round that uses an older row. Staff text edits never move it.
    cardKey: text("card_key"),
    // The linked image, if any (PUT /v1/admin/content/.../media). Media is never deleted, so no ON DELETE action.
    mediaId: bigint("media_id", { mode: "number" }).references(() => mediaItems.id),
    // Military preparation (docs/plans/website-content.md W3, migration 0023): all three null (never prepared) or all set. `prep_version`
    // is the item version the preparation save produced; any later import, edit, relink, retire or restore bumps `version` past it, so
    // the preparation is then stale. Staff evidence only; never a question, answer or hint.
    prepStage: text("prep_stage").$type<PrepStage>(),
    prepEvidence: jsonb("prep_evidence"),
    prepVersion: integer("prep_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    primaryKey({ name: "content_items_pk", columns: [t.module, t.id] }),
    index("content_items_media_id").on(t.mediaId),
    check("content_items_module_check", sql`${t.module} IN ${MODULE_LIST}`),
    check("content_items_rank_check", sql`${t.rank} IN ${RANK_LIST}`),
    check("content_items_status_check", sql`${t.status} IN ('approved', 'retired')`),
    check("content_items_source_check", sql`${t.source} IN ('client_sheet', 'admin')`),
    check("content_items_version_check", sql`${t.version} >= 1`),
    // Rule, not an enumeration (see RULE_CHECKS in test/schema-parity.ts): the three preparation columns are all null or all set.
    check(
      "content_items_prep_all_or_none_check",
      sql`(${t.prepStage} IS NULL AND ${t.prepEvidence} IS NULL AND ${t.prepVersion} IS NULL) OR (${t.prepStage} IS NOT NULL AND ${t.prepEvidence} IS NOT NULL AND ${t.prepVersion} IS NOT NULL)`,
    ),
    check("content_items_prep_stage_check", sql`${t.prepStage} IN ('missing_photo', 'rights_checked', 'content_prepared', 'previewed', 'approved')`),
  ],
);

/** Append-only record of staff actions. Principal only, never an email. */
export const adminAudit = pgTable(
  "admin_audit",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    actor: text("actor").notNull(),
    action: text("action").$type<AdminAuditAction>().notNull(),
    target: text("target").notNull(),
    detail: jsonb("detail").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "admin_audit_action_check",
      sql`${t.action} IN ('content_import', 'content_publish', 'content_edit', 'content_retire', 'content_restore', 'role_request', 'role_approve', 'role_reject', 'role_grant', 'role_revoke', 'role_block', 'role_unblock', 'role_email_edit', 'media_upload', 'media_version', 'media_edit', 'media_publish', 'media_withdraw', 'content_media_link', 'media_rights', 'media_import', 'store_product_create', 'store_product_edit', 'store_product_retire', 'store_product_restore', 'editorial_create', 'editorial_save', 'content_prepare')`,
    ),
  ],
);

/**
 * Staff editorial desks (docs/plans/website-content.md W1, migration 0022): the Aircraft Identifier desk and Plane of the Day.
 * One table, `kind` tells them apart. NOT dealable content: `data` holds only what staff typed (the Identifier desk's answer and
 * distractors are editorial and never reach the dealer, the manifest or a release). `media_id` is fixed at create and must be a
 * published photo; the public read re-checks the media every time. `date_key` is the Plane of the Day date (a plain calendar
 * date, no zone); several items may share one date, so there is no unique index on it. Timestamps come from the database clock.
 * Rendered `ed-<id>` in the API.
 */
export const editorialItems = pgTable(
  "editorial_items",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind").$type<EditorialKind>().notNull(),
    mediaId: bigint("media_id", { mode: "number" })
      .notNull()
      .references(() => mediaItems.id),
    status: text("status").$type<EditorialStatus>().notNull(),
    dateKey: date("date_key", { mode: "string" }),
    data: jsonb("data").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    index("editorial_items_kind_date").on(t.kind, t.dateKey.desc()).where(sql`${t.status} IN ('scheduled', 'published')`),
    index("editorial_items_kind_updated").on(t.kind, t.updatedAt.desc()),
    index("editorial_items_media_id").on(t.mediaId),
    check("editorial_items_kind_check", sql`${t.kind} IN ('identifier', 'plane-of-the-day')`),
    check("editorial_items_status_check", sql`${t.status} IN ('draft', 'scheduled', 'published', 'archived')`),
    check("editorial_items_version_check", sql`${t.version} >= 1`),
    check("editorial_items_created_by_check", sql`length(${t.createdBy}) BETWEEN 1 AND 256`),
    check("editorial_items_updated_by_check", sql`length(${t.updatedBy}) BETWEEN 1 AND 256`),
    // Rules, not enumerations (see RULE_CHECKS in test/schema-parity.ts): an Identifier item has no date and is never scheduled;
    // a scheduled or published Plane of the Day item has a date.
    check("editorial_items_identifier_rule_check", sql`${t.kind} <> 'identifier' OR (${t.dateKey} IS NULL AND ${t.status} <> 'scheduled')`),
    check(
      "editorial_items_potd_rule_check",
      sql`${t.kind} <> 'plane-of-the-day' OR (${t.status} <> 'scheduled' AND ${t.status} <> 'published') OR ${t.dateKey} IS NOT NULL`,
    ),
  ],
);

/**
 * Account roles (Backend ADR-0002): the ONLY source of privilege. One row per (principal, role); the principal is the
 * verified `firebase:<projectId>:<uid>`, never an email. Separate from `players` (no foreign key), so deleting game data
 * never removes a role and an admin needs no player row. Only `state = 'active'` grants anything; RolesGuard reads the
 * caller's active roles on every protected request through the primary key (principal first), so a revoke takes effect on
 * the next call. Every change is audited in `admin_audit` (role_* actions). Timestamps come from the database clock.
 */
export const accountRoles = pgTable(
  "account_roles",
  {
    principal: text("principal").notNull(),
    role: text("role").$type<AccountRole>().notNull(),
    state: text("state").$type<RoleState>().notNull(),
    // No default: writers stamp it from the database clock (src/database/clock.ts), not the transaction-start now().
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // The deciding admin's principal, `operator:<os user>` for the one-time grant command, or `system:signup`. NULL while pending.
    decidedBy: text("decided_by"),
    note: text("note"),
    // Optimistic fence for decisions: every transition bumps it, so a stale decision cannot overwrite a newer one.
    revision: integer("revision").notNull().default(1),
    // A photographer request's verified token email, shown to admins only and never used for authorisation (user ruling
    // 2026-11-03). NULL on every other row. DELETE /v1/me clears it; the role and audit rows stay (ADR-0002).
    requestEmail: text("request_email"),
    // An admin row's email, TYPED by the granting admin (or the operator command): unverified, display only, never used for
    // authorisation, editable by an admin (plan R-d). NULL on every other row. DELETE /v1/me clears it (clearEmails).
    grantEmail: text("grant_email"),
  },
  (t) => [
    primaryKey({ name: "account_roles_pk", columns: [t.principal, t.role] }),
    check("account_roles_role_check", sql`${t.role} IN ('player', 'photographer', 'admin')`),
    check("account_roles_state_check", sql`${t.state} IN ('pending', 'active', 'rejected', 'revoked', 'blocked')`),
    // Pending exactly while undecided: every non-pending row carries both decided_at and decided_by.
    check("account_roles_decided_check", sql`(${t.state} = 'pending' AND ${t.decidedAt} IS NULL AND ${t.decidedBy} IS NULL) OR (${t.state} <> 'pending' AND ${t.decidedAt} IS NOT NULL AND ${t.decidedBy} IS NOT NULL)`),
    // Only a photographer request is ever pending; admin and player rows are issued directly.
    check("account_roles_pending_role_check", sql`${t.state} <> 'pending' OR ${t.role} = 'photographer'`),
    check("account_roles_revision_check", sql`${t.revision} >= 1`),
    // The admin queue: oldest pending request first.
    index("account_roles_pending_queue").on(t.requestedAt, t.principal).where(sql`${t.state} = 'pending'`),
    check("account_roles_principal_check", sql`length(${t.principal}) BETWEEN 1 AND 256`),
    check("account_roles_decided_by_check", sql`${t.decidedBy} IS NULL OR length(${t.decidedBy}) BETWEEN 1 AND 256`),
    check("account_roles_note_check", sql`${t.note} IS NULL OR length(${t.note}) <= 500`),
    check("account_roles_request_email_check", sql`${t.requestEmail} IS NULL OR length(${t.requestEmail}) BETWEEN 3 AND 320`),
    // `blocked` is a photographer-only state (R-d); a typed email lives on admin rows only (same length limit as request_email).
    check("account_roles_blocked_role_check", sql`${t.state} <> 'blocked' OR ${t.role} = 'photographer'`),
    check("account_roles_grant_email_check", sql`${t.grantEmail} IS NULL OR (${t.role} = 'admin' AND char_length(${t.grantEmail}) BETWEEN 3 AND 320)`),
    index("account_roles_blocked_queue").on(t.requestedAt, t.principal).where(sql`${t.state} = 'blocked'`),
  ],
);

/**
 * Phase 5.1: the link between a player and their Unity Gaming Services player id, proven server-side at link
 * time (never client-supplied). One UGS id belongs to at most one player. Deleted with the player.
 */
export const ugsLinks = pgTable(
  "ugs_links",
  {
    playerId: text("player_id")
      .primaryKey()
      .references(() => players.id, { onDelete: "cascade" }),
    ugsPlayerId: text("ugs_player_id").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("ugs_links_ugs_player_id").on(t.ugsPlayerId)],
);

/**
 * One row per player: the day log (T2) and the Field Award counters (T3), a cache of what stored segments and Rounds
 * already say. The Round result writes the day fields (last_played_date ... best_day_streak); `complete` (T3) writes the rest. Written only inside PlayerBalance.update.
 */
export const playerCounters = pgTable(
  "player_counters",
  {
    playerId: text("player_id")
      .primaryKey()
      .references(() => players.id, { onDelete: "cascade" }),
    tripsCompleted: integer("trips_completed").notNull().default(0),
    flightsCompleted: integer("flights_completed").notNull().default(0),
    correctFlights: integer("correct_flights").notNull().default(0),
    allCorrectTrips: integer("all_correct_trips").notNull().default(0),
    milesEarned: bigint("miles_earned", { mode: "number" }).notNull().default(0),
    bestTripStreak: integer("best_trip_streak").notNull().default(0),
    identifierFullTrips: integer("identifier_full_trips").notNull().default(0),
    perfectFlightStreak: integer("perfect_flight_streak").notNull().default(0),
    bestPerfectFlightStreak: integer("best_perfect_flight_streak").notNull().default(0),
    hintFreeTripStreak: integer("hint_free_trip_streak").notNull().default(0),
    bestHintFreeTripStreak: integer("best_hint_free_trip_streak").notNull().default(0),
    nightTrips: integer("night_trips").notNull().default(0),
    goArounds: integer("go_arounds").notNull().default(0),
    previousTripOutcome: text("previous_trip_outcome").$type<TripOutcome>(),
    lastPlayedDate: date("last_played_date", { mode: "string" }),
    flightsOnLastPlayedDate: integer("flights_on_last_played_date").notNull().default(0),
    dayStreak: integer("day_streak").notNull().default(0),
    bestDayStreak: integer("best_day_streak").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "player_counters_nonnegative_check",
      sql`${t.tripsCompleted} >= 0 AND ${t.flightsCompleted} >= 0 AND ${t.correctFlights} >= 0
        AND ${t.allCorrectTrips} >= 0 AND ${t.milesEarned} >= 0 AND ${t.bestTripStreak} >= 0
        AND ${t.identifierFullTrips} >= 0 AND ${t.perfectFlightStreak} >= 0 AND ${t.bestPerfectFlightStreak} >= 0
        AND ${t.hintFreeTripStreak} >= 0 AND ${t.bestHintFreeTripStreak} >= 0 AND ${t.nightTrips} >= 0
        AND ${t.goArounds} >= 0 AND ${t.flightsOnLastPlayedDate} >= 0 AND ${t.dayStreak} >= 0
        AND ${t.bestDayStreak} >= 0`,
    ),
    check(
      "player_counters_previous_outcome_check",
      sql`${t.previousTripOutcome} IS NULL OR ${t.previousTripOutcome} IN ('all_correct', 'not_all_correct')`,
    ),
  ],
);

/**
 * Clipper Card progress (design 3.5): one row per player and Card key, written at `complete` only (A7). `first_trip_id`
 * names the segment that collected it, so a replay of `complete` reports the same list. No foreign key on it: the row
 * belongs to the player (cascade), not to the segment. Written only inside PlayerBalance.update.
 */
export const playerClipperCards = pgTable(
  "player_clipper_cards",
  {
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    cardKey: text("card_key").notNull(),
    module: text("module").notNull(),
    firstCollectedAt: timestamp("first_collected_at", { withTimezone: true }).notNull(),
    firstTripId: uuid("first_trip_id").notNull(),
    timesIdentified: integer("times_identified").notNull(),
    everPerfect: boolean("ever_perfect").notNull(),
    everHintFree: boolean("ever_hint_free").notNull(),
    fastestCorrectMs: integer("fastest_correct_ms"),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.cardKey] }),
    index("player_clipper_cards_first_trip").on(t.playerId, t.firstTripId),
    check("player_clipper_cards_module_check", sql`${t.module} IN ('identifier', 'aircraft-identifier-military')`),
    check("player_clipper_cards_key_check", sql`length(${t.cardKey}) BETWEEN 1 AND 512`),
    check("player_clipper_cards_times_check", sql`${t.timesIdentified} >= 1`),
    check("player_clipper_cards_fastest_check", sql`${t.fastestCorrectMs} IS NULL OR ${t.fastestCorrectMs} BETWEEN 0 AND 1800000`),
  ],
);

/**
 * Earned Field Awards (design 3.6): a row is never removed (an award never un-earns). Inserted by the `complete` that
 * earned it; `trip_id` and `catalog_version` record which segment and which catalog. Written only inside
 * PlayerBalance.update.
 */
export const playerFieldAwards = pgTable(
  "player_field_awards",
  {
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    awardId: text("award_id").notNull(),
    earnedAt: timestamp("earned_at", { withTimezone: true }).notNull(),
    tripId: uuid("trip_id").notNull(),
    catalogVersion: integer("catalog_version").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.awardId] }),
    index("player_field_awards_trip").on(t.playerId, t.tripId),
    check("player_field_awards_award_id_check", sql`${t.awardId} IN ('first-flight', 'frequent-flyer', 'century', 'sharp-eyes', 'flawless-five', 'five-in-a-row', 'week-on-the-line', 'regular', 'first-card', 'collector', 'textbook', 'high-flyer', 'coast-to-coast', 'no-instrument-flight', 'red-eye-special', 'fleet-admiral', 'centennial-streak', 'go-around', 'globe-trotter', 'quad-engine-royalty', 'the-great-rivalry', 'heavy-metal', 'regional', 'bogey-identified', 'top-gun-ace', 'rotorhead', 'vertical-horizon', 'executive-platinum')`),
    check("player_field_awards_catalog_version_check", sql`${t.catalogVersion} >= 1`),
  ],
);

/**
 * Published, versioned data documents the app pulls through the content manifest (design 7; slice T4). A row is IMMUTABLE:
 * a change is a new `version` for that name, and old versions stay fetchable. Enforced by convention (only
 * `src/content/documents/document-store.ts` writes it, test/content-documents.test.ts), by the migration's
 * BEFORE UPDATE/DELETE trigger, and by never exposing an update path.
 *
 * The served bytes are NOT stored: jsonb keeps neither key order nor whitespace. They are the canonical serialisation of
 * `body` (`canonicalBytes`: keys sorted recursively, no whitespace, UTF-8, integers only), and `sha256` / `byte_size` are
 * that serialisation's digest and length, written at insert and re-checked at every read.
 */
export const contentDocuments = pgTable(
  "content_documents",
  {
    name: text("name").$type<ContentDocumentName>().notNull(),
    version: integer("version").notNull(),
    format: text("format").notNull(),
    body: jsonb("body").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    // Database clock (default now()), never a process clock: instances' clocks can disagree and the manifest's
    // generatedAtUtc is derived from it.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    note: text("note"),
  },
  (t) => [
    primaryKey({ name: "content_documents_pk", columns: [t.name, t.version] }),
    check("content_documents_name_check", sql`${t.name} IN ('field-awards', 'clipper-cards', 'aircraft-tags')`),
    check("content_documents_version_check", sql`${t.version} >= 1`),
    check("content_documents_format_check", sql`${t.format} = ${t.name} || '.v1'`),
    check("content_documents_body_check", sql`${t.body} @> '{}'::jsonb`),
    check("content_documents_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("content_documents_byte_size_check", sql`${t.byteSize} > 0`),
    check("content_documents_created_by_check", sql`length(${t.createdBy}) BETWEEN 1 AND 256`),
    check("content_documents_note_check", sql`${t.note} IS NULL OR length(${t.note}) <= 500`),
  ],
);

/**
 * Staff drafts of the published documents (slice T6): MUTABLE, one row per document name, created by the first edit. `edits` is an
 * overlay on the document in force (field-awards: per-award field values; clipper-cards: Card names; aircraft-tags: tag lists),
 * not a copy of it, so a draft never goes stale against a newer version. `version` is the draft revision the editors' version
 * check compares (no row = 0): every edit, discard and publish raises it. Written only by
 * `src/content/documents/draft-store.ts`, always under the per-name advisory lock. Players never read it.
 */
export const contentDrafts = pgTable(
  "content_drafts",
  {
    name: text("name").$type<ContentDocumentName>().primaryKey(),
    version: integer("version").notNull(),
    edits: jsonb("edits").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    check("content_drafts_name_check", sql`${t.name} IN ('field-awards', 'clipper-cards', 'aircraft-tags')`),
    check("content_drafts_version_check", sql`${t.version} >= 1`),
    check("content_drafts_edits_check", sql`${t.edits} @> '{}'::jsonb`),
    check("content_drafts_updated_by_check", sql`length(${t.updatedBy}) BETWEEN 1 AND 256`),
  ],
);

/** Source of `ugs_mirror_outbox.generation`: never restarts, so a row deleted and re-inserted gets a new value. */
export const ugsMirrorGeneration = pgSequence("ugs_mirror_generation_seq");

/**
 * Coalesced mirror queue: at most one row per linked player. Written in the same transaction as every
 * progress change. `version` is the highest players.version seen (informational); `generation` comes from a
 * sequence and changes on every enqueue (including ones that do not bump players.version, e.g. a first link or a repeated same-value write), so
 * the worker deletes a row only if nothing changed since it claimed it. `claim_id` is set when a worker claims
 * the row (due_at is then a lease); the worker's later delete/release/fail only match that claim, so a worker
 * whose lease expired cannot touch a row another worker has since claimed. `last_error` is a short status
 * such as "http 503", never a body, token or value.
 */
export const ugsMirrorOutbox = pgTable(
  "ugs_mirror_outbox",
  {
    playerId: text("player_id")
      .primaryKey()
      .references(() => players.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull().default(sql`nextval('ugs_mirror_generation_seq')`),
    claimId: uuid("claim_id"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /**
     * An urgent enqueue (the "write at Trip end" hook) landed while this row was claimed. due_at is the lease while a
     * row is claimed, so it cannot carry the request; the worker's "changed while writing" reset reads this flag and
     * makes the row due now instead of one interval later, and clears it. Release and fail clear it as well.
     */
    urgent: boolean("urgent").notNull().default(false),
  },
  (t) => [
    index("ugs_mirror_outbox_due").on(t.dueAt),
    check("ugs_mirror_outbox_attempts_check", sql`${t.attempts} >= 0`),
    check("ugs_mirror_outbox_last_error_check", sql`${t.lastError} IS NULL OR length(${t.lastError}) <= 80`),
  ],
);

/**
 * UGS copies to delete after an account deletion (the link row is gone by then, so the UGS id is kept here).
 * Written in the deleting transaction; the worker deletes the Cloud Save item. No player reference, no PII:
 * a UGS player id is not a credential.
 */
export const ugsMirrorDeletions = pgTable(
  "ugs_mirror_deletions",
  {
    ugsPlayerId: text("ugs_player_id").primaryKey(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    /** Set when a worker claims the row; later changes by that worker only match this claim. */
    claimId: uuid("claim_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ugs_mirror_deletions_due").on(t.dueAt),
    check("ugs_mirror_deletions_last_error_check", sql`${t.lastError} IS NULL OR length(${t.lastError}) <= 80`),
  ],
);

/**
 * Per linked player, when the mirror last wrote a Cloud Save copy and for which UGS player (C3, UGS_MIRROR_MIN_INTERVAL_SEC).
 * Written by the mirror worker after a successful write, read by the enqueue helper to compute `due_at`. It is a
 * separate table, not a column on ugs_links, because ugs_links is written only by PlayerBalance (balance guard) and
 * the worker's success path must record this. A row whose `ugs_player_id` differs from the current link (a re-link or
 * a link move) counts as "never written": the first write after a link is never delayed. Deleted with the player.
 */
export const ugsMirrorPace = pgTable("ugs_mirror_pace", {
  playerId: text("player_id")
    .primaryKey()
    .references(() => players.id, { onDelete: "cascade" }),
  ugsPlayerId: text("ugs_player_id").notNull(),
  lastMirroredAt: timestamp("last_mirrored_at", { withTimezone: true }).notNull(),
});

/**
 * Token buckets shared by every backend instance for the scarce UGS admin APIs (D-4): 'cloud_save_admin' paces
 * Cloud Save writes and deletions, 'player_auth_admin' paces link proofs. `tokens` is the balance as of
 * `refilled_at`; rate and burst come from configuration (every instance must use the same values). `paused_until`
 * is a shared pause: a 429 or refused credentials seen by one instance stops them all. Rows are created on first use.
 */
export const ugsBudget = pgTable(
  "ugs_budget",
  {
    name: text("name").primaryKey(),
    tokens: doublePrecision("tokens").notNull(),
    refilledAt: timestamp("refilled_at", { withTimezone: true }).notNull(),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
  },
  (t) => [check("ugs_budget_tokens_check", sql`${t.tokens} >= 0`)],
);

/**
 * Shared rate-limit state (A4): one row per (throttler name, sha256 of the key), so several instances enforce one limit.
 * `hit_expiries` holds the expiry instant of every counted hit (the built-in store's per-hit sliding window; its length is
 * the hit count). The write is the SQL function rate_limit_increment (migration 0014), on the database clock. The raw
 * principal or IP is never stored, only its sha256.
 */
export const rateLimitHits = pgTable(
  "rate_limit_hits",
  {
    throttlerName: text("throttler_name").notNull(),
    keyHash: text("key_hash").notNull(),
    hitExpiries: timestamp("hit_expiries", { withTimezone: true }).array().notNull().default(sql`'{}'::timestamptz[]`),
    windowExpiresAt: timestamp("window_expires_at", { withTimezone: true }).notNull(),
    blocked: boolean("blocked").notNull().default(false),
    blockExpiresAt: timestamp("block_expires_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.throttlerName, t.keyHash] }),
    index("rate_limit_hits_window_expires_at_idx").on(t.windowExpiresAt),
    check("rate_limit_hits_key_hash_check", sql`${t.keyHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * The store catalog (docs/plans/purchases.md, migration 0020): staff-editable, one row per store product id (the same id in the
 * App Store and Google Play). `title` is a staff label only, never shown to players. `demo` rows carry placeholder store ids:
 * never listed and never sold in production. A product is never deleted (transactions reference it); `retired` stops listing but
 * a retired product still grants, so an old receipt is honoured. `pass_period` is informational: the store's expiry is authoritative.
 */
export const storeProducts = pgTable(
  "store_products",
  {
    productId: text("product_id").primaryKey(),
    kind: text("kind").$type<StoreProductKind>().notNull(),
    // hint_pack only (1..1000), else NULL.
    hints: integer("hints"),
    // miles_pack only (1..1,000,000), else NULL.
    miles: integer("miles"),
    // first_class_pass only, else NULL.
    passPeriod: text("pass_period").$type<StorePassPeriod>(),
    title: text("title").notNull(),
    demo: boolean("demo").notNull(),
    status: text("status").$type<StoreProductStatus>().notNull(),
    // Optimistic fence for staff edits, like content_items.version.
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("store_products_product_id_check", sql`${t.productId} ~ '^[a-z0-9][a-z0-9._]{0,99}$'`),
    check("store_products_kind_check", sql`${t.kind} IN ('hint_pack', 'first_class_pass', 'miles_pack')`),
    check("store_products_pass_period_check", sql`${t.passPeriod} IN ('P1M', 'P1Y')`),
    check("store_products_status_check", sql`${t.status} IN ('active', 'retired')`),
    check("store_products_title_check", sql`length(${t.title}) BETWEEN 1 AND 100`),
    check("store_products_version_check", sql`${t.version} >= 1`),
    // A hint pack has a hint count only; a Miles pack a Miles amount only; a Pass a period only. (`IS NOT NULL` is explicit: a NULL BETWEEN would pass a CHECK.)
    check(
      "store_products_kind_rule_check",
      sql`(${t.kind} = 'hint_pack' AND ${t.hints} IS NOT NULL AND ${t.hints} BETWEEN 1 AND 1000 AND ${t.miles} IS NULL AND ${t.passPeriod} IS NULL) OR (${t.kind} = 'miles_pack' AND ${t.miles} IS NOT NULL AND ${t.miles} BETWEEN 1 AND 1000000 AND ${t.hints} IS NULL AND ${t.passPeriod} IS NULL) OR (${t.kind} = 'first_class_pass' AND ${t.hints} IS NULL AND ${t.miles} IS NULL AND ${t.passPeriod} IS NOT NULL)`,
    ),
  ],
);

/**
 * The per-player token handed to the stores (Apple appAccountToken, Google obfuscatedExternalAccountId) so a purchase can be tied
 * to its buyer without the Firebase uid reaching a store. Random, created on first read of GET /v1/me/entitlements, never derived
 * from the uid. Deleted with the player (user ruling R4: account deletion is final).
 */
export const storeAccounts = pgTable("store_accounts", {
  playerId: text("player_id")
    .primaryKey()
    .references(() => players.id, { onDelete: "cascade" }),
  commerceToken: uuid("commerce_token").notNull().unique().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One verified store transaction, granted once. UNIQUE (store, transaction_ref) is the idempotency key across every player: the
 * second claimant of a reference is refused. `granted_hints` / `granted_miles` / `granted_until` snapshot what was granted, so a later catalog edit
 * never changes a past grant. Apple: transaction_ref = transactionId, original_ref = originalTransactionId. Written only by
 * src/purchases/purchase-grant.ts inside PlayerBalance.update.
 */
export const storeTransactions = pgTable(
  "store_transactions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    store: text("store").$type<StoreName>().notNull(),
    transactionRef: text("transaction_ref").notNull(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => storeProducts.productId, { onDelete: "restrict" }),
    kind: text("kind").$type<StoreProductKind>().notNull(),
    environment: text("environment").$type<StoreEnvironment>().notNull(),
    orderId: text("order_id"),
    // Subscriptions only: the first transaction of the chain (Apple originalTransactionId; Google first purchaseToken).
    originalRef: text("original_ref"),
    purchasedAt: timestamp("purchased_at", { withTimezone: true }).notNull(),
    grantedHints: integer("granted_hints"),
    grantedMiles: integer("granted_miles"),
    grantedUntil: timestamp("granted_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("store_transactions_store_ref").on(t.store, t.transactionRef),
    index("store_transactions_player").on(t.playerId),
    check("store_transactions_store_check", sql`${t.store} IN ('apple', 'google')`),
    check("store_transactions_kind_check", sql`${t.kind} IN ('hint_pack', 'first_class_pass', 'miles_pack')`),
    check("store_transactions_environment_check", sql`${t.environment} IN ('production', 'sandbox', 'fake')`),
    check("store_transactions_granted_hints_check", sql`${t.grantedHints} IS NULL OR ${t.grantedHints} > 0`),
    check("store_transactions_granted_miles_check", sql`${t.grantedMiles} IS NULL OR ${t.grantedMiles} > 0`),
    check(
      "store_transactions_kind_rule_check",
      sql`(${t.kind} = 'hint_pack' AND ${t.grantedHints} IS NOT NULL AND ${t.grantedMiles} IS NULL AND ${t.grantedUntil} IS NULL AND ${t.originalRef} IS NULL) OR (${t.kind} = 'miles_pack' AND ${t.grantedMiles} IS NOT NULL AND ${t.grantedHints} IS NULL AND ${t.grantedUntil} IS NULL AND ${t.originalRef} IS NULL) OR (${t.kind} = 'first_class_pass' AND ${t.grantedHints} IS NULL AND ${t.grantedMiles} IS NULL AND ${t.grantedUntil} IS NOT NULL AND ${t.originalRef} IS NOT NULL)`,
    ),
  ],
);

/**
 * One Pass subscription chain per (store, original_ref); the owner is set once (a later claim by another player is refused).
 * `players.first_class_until` is recomputed from the player's `active` and `grace` rows. Statuses beyond `active` are written by
 * the store-notification wave (P4); they are pinned here so that wave needs no CHECK change.
 */
export const storeSubscriptions = pgTable(
  "store_subscriptions",
  {
    store: text("store").$type<StoreName>().notNull(),
    originalRef: text("original_ref").notNull(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => storeProducts.productId, { onDelete: "restrict" }),
    status: text("status").$type<StoreSubscriptionStatus>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "store_subscriptions_pk", columns: [t.store, t.originalRef] }),
    index("store_subscriptions_player").on(t.playerId),
    check("store_subscriptions_store_check", sql`${t.store} IN ('apple', 'google')`),
    check(
      "store_subscriptions_status_check",
      sql`${t.status} IN ('active', 'grace', 'billing_retry', 'on_hold', 'expired', 'revoked')`,
    ),
  ],
);

/**
 * A tombstone of every store reference ever granted (docs/plans/purchases.md R4): no player data, no foreign key, never cascaded.
 * `kind` transaction = a store_transactions reference, subscription = a store_subscriptions original_ref. Account deletion removes
 * the purchase rows but not this one, so an old receipt can never be granted a second time to a new account. Written only by
 * src/purchases/purchase-grant.ts.
 */
export const storeClaims = pgTable(
  "store_claims",
  {
    store: text("store").$type<StoreName>().notNull(),
    kind: text("kind").$type<StoreClaimKind>().notNull(),
    ref: text("ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "store_claims_pk", columns: [t.store, t.kind, t.ref] }),
    check("store_claims_store_check", sql`${t.store} IN ('apple', 'google')`),
    check("store_claims_kind_check", sql`${t.kind} IN ('transaction', 'subscription')`),
  ],
);

export type PlayerRow = typeof players.$inferSelect;
export type RoundRow = typeof rounds.$inferSelect;
export type TripRow = typeof trips.$inferSelect;
export type PlayerCountersRow = typeof playerCounters.$inferSelect;
export type ClipperCardRow = typeof playerClipperCards.$inferSelect;
export type FieldAwardRow = typeof playerFieldAwards.$inferSelect;
export type ContentItemRow = typeof contentItems.$inferSelect;
export type EditorialItemRow = typeof editorialItems.$inferSelect;
export type ContentDocumentRow = typeof contentDocuments.$inferSelect;
export type ContentImportRow = typeof contentImports.$inferSelect;
export type StoreProductRow = typeof storeProducts.$inferSelect;
export type StoreTransactionRow = typeof storeTransactions.$inferSelect;
export type StoreSubscriptionRow = typeof storeSubscriptions.$inferSelect;
