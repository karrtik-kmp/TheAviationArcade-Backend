import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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
    perfectStreak: integer("perfect_streak").notNull().default(0),
    // NULL means "fly at Certified Rank" and follows promotions. A value is a dialled-down Active Rank.
    activeRank: text("active_rank"),
    // Set only by a future verified store purchase. Never client-writable.
    firstClassUntil: timestamp("first_class_until", { withTimezone: true }),
    // Bumped on every balance change.
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("players_status_points_check", sql`${t.statusPoints} >= 0`),
    check("players_miles_check", sql`${t.miles} >= 0`),
    check("players_perfect_streak_check", sql`${t.perfectStreak} >= 0`),
    check("players_active_rank_check", sql`${t.activeRank} IS NULL OR ${t.activeRank} IN ${RANK_LIST}`),
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
    status: text("status").notNull().default("open"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completionId: text("completion_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    finished: boolean("finished"),
    errorCount: integer("error_count"),
    usedHint: boolean("used_hint"),
    timeRemaining: doublePrecision("time_remaining"),
    completion: text("completion"),
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
    index("rounds_open").on(t.playerId).where(sql`${t.status} = 'open'`),
    check(
      "rounds_module_check",
      sql`${t.module} IN ('airport-spotter', 'atc-match', 'call-sign-match', 'identifier',
        'military-identifier', 'code-search', 'runway-identifier', 'tail-identifier')`,
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
    check(
      "rounds_completed_has_award_check",
      sql`${t.status} <> 'completed'
        OR (${t.completionId} IS NOT NULL AND ${t.spAwarded} IS NOT NULL AND ${t.milesAwarded} IS NOT NULL)`,
    ),
  ],
);

export type PlayerRow = typeof players.$inferSelect;
export type RoundRow = typeof rounds.$inferSelect;
