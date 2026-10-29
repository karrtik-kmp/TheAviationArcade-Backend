import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
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
import type { AdminAuditAction, ContentSource, ContentStatus, RoundCompletion, RoundStatus } from "./enums.js";

/**
 * Player progress. One row per server principal: firebase:<project>:<uid>.
 * No email, display name or Callsign is stored here (see README.md).
 * Timestamps are timestamptz; the API converts to ISO strings at the edge.
 */

const RANK_LIST = sql`('trainee', 'first-officer', 'captain', 'check-airman', 'chief-pilot')`;

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
    // Bumped on every change visible in progress or the UGS copy (PlayerBalance owns the bump).
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("players_status_points_check", sql`${t.statusPoints} >= 0`),
    check("players_miles_check", sql`${t.miles} >= 0`),
    check("players_hints_check", sql`${t.hints} >= 0`),
    check("players_perfect_streak_check", sql`${t.perfectStreak} >= 0`),
    check("players_active_rank_check", sql`${t.activeRank} IS NULL OR ${t.activeRank} IN ${RANK_LIST}`),
    check("players_version_check", sql`${t.version} >= 1`),
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
  },
  (t) => [
    index("rounds_player").on(t.playerId, t.issuedAt),
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
    check("miles_ledger_kind_check", sql`${t.kind} IN ('round_award', 'hint_pack')`),
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
    check("hint_ledger_kind_check", sql`${t.kind} IN ('starter', 'hint_pack', 'round_spend')`),
  ],
);

const MODULE_LIST = sql`('airport-spotter', 'atc-match', 'call-sign-match', 'identifier',
  'aircraft-identifier-military', 'code-search', 'runway-identifier', 'tail-identifier')`;

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    primaryKey({ name: "content_items_pk", columns: [t.module, t.id] }),
    check("content_items_module_check", sql`${t.module} IN ${MODULE_LIST}`),
    check("content_items_rank_check", sql`${t.rank} IN ${RANK_LIST}`),
    check("content_items_status_check", sql`${t.status} IN ('approved', 'retired')`),
    check("content_items_source_check", sql`${t.source} IN ('client_sheet', 'admin')`),
    check("content_items_version_check", sql`${t.version} >= 1`),
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
  (t) => [check("admin_audit_action_check", sql`${t.action} IN ('content_import')`)],
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

export type PlayerRow = typeof players.$inferSelect;
export type RoundRow = typeof rounds.$inferSelect;
export type ContentItemRow = typeof contentItems.$inferSelect;
export type ContentImportRow = typeof contentImports.$inferSelect;
