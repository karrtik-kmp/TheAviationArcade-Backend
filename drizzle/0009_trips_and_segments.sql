CREATE TABLE "player_counters" (
	"player_id" text PRIMARY KEY NOT NULL,
	"trips_completed" integer DEFAULT 0 NOT NULL,
	"flights_completed" integer DEFAULT 0 NOT NULL,
	"correct_flights" integer DEFAULT 0 NOT NULL,
	"all_correct_trips" integer DEFAULT 0 NOT NULL,
	"miles_earned" bigint DEFAULT 0 NOT NULL,
	"best_trip_streak" integer DEFAULT 0 NOT NULL,
	"identifier_full_trips" integer DEFAULT 0 NOT NULL,
	"perfect_flight_streak" integer DEFAULT 0 NOT NULL,
	"best_perfect_flight_streak" integer DEFAULT 0 NOT NULL,
	"hint_free_trip_streak" integer DEFAULT 0 NOT NULL,
	"best_hint_free_trip_streak" integer DEFAULT 0 NOT NULL,
	"night_trips" integer DEFAULT 0 NOT NULL,
	"go_arounds" integer DEFAULT 0 NOT NULL,
	"previous_trip_outcome" text,
	"last_played_date" date,
	"flights_on_last_played_date" integer DEFAULT 0 NOT NULL,
	"day_streak" integer DEFAULT 0 NOT NULL,
	"best_day_streak" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "player_counters_nonnegative_check" CHECK ("player_counters"."trips_completed" >= 0 AND "player_counters"."flights_completed" >= 0 AND "player_counters"."correct_flights" >= 0
        AND "player_counters"."all_correct_trips" >= 0 AND "player_counters"."miles_earned" >= 0 AND "player_counters"."best_trip_streak" >= 0
        AND "player_counters"."identifier_full_trips" >= 0 AND "player_counters"."perfect_flight_streak" >= 0 AND "player_counters"."best_perfect_flight_streak" >= 0
        AND "player_counters"."hint_free_trip_streak" >= 0 AND "player_counters"."best_hint_free_trip_streak" >= 0 AND "player_counters"."night_trips" >= 0
        AND "player_counters"."go_arounds" >= 0 AND "player_counters"."flights_on_last_played_date" >= 0 AND "player_counters"."day_streak" >= 0
        AND "player_counters"."best_day_streak" >= 0),
	CONSTRAINT "player_counters_previous_outcome_check" CHECK ("player_counters"."previous_trip_outcome" IS NULL OR "player_counters"."previous_trip_outcome" IN ('all_correct', 'not_all_correct'))
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"module" text NOT NULL,
	"rank" text NOT NULL,
	"pleasure_cruise" boolean NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"flight_count" integer DEFAULT 10 NOT NULL,
	"rounds_banked" integer DEFAULT 0 NOT NULL,
	"local_date" date NOT NULL,
	"utc_offset_minutes" integer NOT NULL,
	"content_version" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"outcome" text,
	"correct" integer,
	"hint_used" boolean,
	"best_streak" integer,
	"miles" integer,
	"status_points" integer,
	"go_around" boolean,
	"night_trip" boolean,
	"completion_local_date" date,
	"catalog_version" integer,
	CONSTRAINT "trips_module_check" CHECK ("trips"."module" IN ('airport-spotter', 'atc-match', 'call-sign-match', 'identifier',
  'aircraft-identifier-military', 'code-search', 'runway-identifier', 'tail-identifier')),
	CONSTRAINT "trips_rank_check" CHECK ("trips"."rank" IN ('trainee', 'first-officer', 'captain', 'check-airman', 'chief-pilot')),
	CONSTRAINT "trips_status_check" CHECK ("trips"."status" IN ('open', 'completed', 'abandoned')),
	CONSTRAINT "trips_idempotency_key_check" CHECK ("trips"."idempotency_key" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "trips_flight_count_check" CHECK ("trips"."flight_count" = 10),
	CONSTRAINT "trips_rounds_banked_check" CHECK ("trips"."rounds_banked" BETWEEN 0 AND 10),
	CONSTRAINT "trips_utc_offset_check" CHECK ("trips"."utc_offset_minutes" BETWEEN -720 AND 840),
	CONSTRAINT "trips_content_version_check" CHECK (length("trips"."content_version") BETWEEN 1 AND 64),
	CONSTRAINT "trips_expires_after_open_check" CHECK ("trips"."expires_at" > "trips"."opened_at"),
	CONSTRAINT "trips_closed_at_check" CHECK (("trips"."status" <> 'open') = ("trips"."closed_at" IS NOT NULL)),
	CONSTRAINT "trips_outcome_check" CHECK ("trips"."outcome" IS NULL OR "trips"."outcome" IN ('all_correct', 'not_all_correct')),
	CONSTRAINT "trips_correct_check" CHECK ("trips"."correct" IS NULL OR "trips"."correct" BETWEEN 0 AND 10),
	CONSTRAINT "trips_best_streak_check" CHECK ("trips"."best_streak" IS NULL OR "trips"."best_streak" BETWEEN 0 AND 10),
	CONSTRAINT "trips_miles_check" CHECK ("trips"."miles" IS NULL OR "trips"."miles" >= 0),
	CONSTRAINT "trips_status_points_check" CHECK ("trips"."status_points" IS NULL OR "trips"."status_points" >= 0),
	CONSTRAINT "trips_completed_check" CHECK ("trips"."status" <> 'completed' OR ("trips"."rounds_banked" = 10 AND "trips"."outcome" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "hint_ledger" DROP CONSTRAINT "hint_ledger_kind_check";--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "card_key" text;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "trip_id" uuid;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "flight_number" integer;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "aircraft_key" text;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "card_key" text;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "answer_ms" integer;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "attempts" integer;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "local_date" date;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "day_streak_grant" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "player_counters" ADD CONSTRAINT "player_counters_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trips_idempotency" ON "trips" USING btree ("player_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "trips_one_open_per_player" ON "trips" USING btree ("player_id") WHERE "trips"."status" = 'open';--> statement-breakpoint
CREATE INDEX "trips_player_completed" ON "trips" USING btree ("player_id","closed_at") WHERE "trips"."status" = 'completed';--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rounds_trip" ON "rounds" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_trip_flight_banked" ON "rounds" USING btree ("trip_id","flight_number") WHERE "rounds"."status" = 'completed';--> statement-breakpoint
ALTER TABLE "hint_ledger" ADD CONSTRAINT "hint_ledger_kind_check" CHECK ("hint_ledger"."kind" IN ('starter', 'hint_pack', 'round_spend', 'trip_grant', 'day_streak_grant'));--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_flight_number_check" CHECK ("rounds"."flight_number" IS NULL OR "rounds"."flight_number" BETWEEN 1 AND 10);--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_trip_flight_check" CHECK (("rounds"."trip_id" IS NULL) = ("rounds"."flight_number" IS NULL));--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_answer_ms_check" CHECK ("rounds"."answer_ms" IS NULL OR "rounds"."answer_ms" BETWEEN 0 AND 1800000);--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_attempts_check" CHECK ("rounds"."attempts" IS NULL OR "rounds"."attempts" >= 0);