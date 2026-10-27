CREATE TABLE "players" (
	"id" text PRIMARY KEY NOT NULL,
	"status_points" integer DEFAULT 0 NOT NULL,
	"miles" integer DEFAULT 0 NOT NULL,
	"perfect_streak" integer DEFAULT 0 NOT NULL,
	"active_rank" text,
	"first_class_until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "players_status_points_check" CHECK ("players"."status_points" >= 0),
	CONSTRAINT "players_miles_check" CHECK ("players"."miles" >= 0),
	CONSTRAINT "players_perfect_streak_check" CHECK ("players"."perfect_streak" >= 0),
	CONSTRAINT "players_active_rank_check" CHECK ("players"."active_rank" IS NULL OR "players"."active_rank" IN ('trainee', 'first-officer', 'captain', 'check-airman', 'chief-pilot'))
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"module" text NOT NULL,
	"rank" text NOT NULL,
	"pleasure_cruise" boolean NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completion_id" text,
	"completed_at" timestamp with time zone,
	"finished" boolean,
	"error_count" integer,
	"used_hint" boolean,
	"time_remaining" double precision,
	"completion" text,
	"speed_bonus" boolean,
	"streak_miles" integer,
	"first_class_pass" boolean,
	"sp_awarded" integer,
	"miles_awarded" integer,
	"promoted_from" text,
	"promoted_to" text,
	CONSTRAINT "rounds_module_check" CHECK ("rounds"."module" IN ('airport-spotter', 'atc-match', 'call-sign-match', 'identifier',
        'military-identifier', 'code-search', 'runway-identifier', 'tail-identifier')),
	CONSTRAINT "rounds_rank_check" CHECK ("rounds"."rank" IN ('trainee', 'first-officer', 'captain', 'check-airman', 'chief-pilot')),
	CONSTRAINT "rounds_status_check" CHECK ("rounds"."status" IN ('open', 'completed', 'abandoned')),
	CONSTRAINT "rounds_completion_check" CHECK ("rounds"."completion" IS NULL OR "rounds"."completion" IN ('perfect', 'standard', 'unfinished')),
	CONSTRAINT "rounds_promoted_from_check" CHECK ("rounds"."promoted_from" IS NULL OR "rounds"."promoted_from" IN ('trainee', 'first-officer', 'captain', 'check-airman', 'chief-pilot')),
	CONSTRAINT "rounds_promoted_to_check" CHECK ("rounds"."promoted_to" IS NULL OR "rounds"."promoted_to" IN ('trainee', 'first-officer', 'captain', 'check-airman', 'chief-pilot')),
	CONSTRAINT "rounds_completed_has_award_check" CHECK ("rounds"."status" <> 'completed'
        OR ("rounds"."completion_id" IS NOT NULL AND "rounds"."sp_awarded" IS NOT NULL AND "rounds"."miles_awarded" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rounds_player" ON "rounds" USING btree ("player_id","issued_at");--> statement-breakpoint
CREATE INDEX "rounds_open" ON "rounds" USING btree ("player_id") WHERE "rounds"."status" = 'open';