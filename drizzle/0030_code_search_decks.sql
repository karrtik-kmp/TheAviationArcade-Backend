CREATE TABLE "trip_decks" (
	"trip_id" uuid PRIMARY KEY NOT NULL,
	"format" text NOT NULL,
	"deck" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trip_decks_format_check" CHECK ("trip_decks"."format" IN ('grid.v1')),
	CONSTRAINT "trip_decks_deck_check" CHECK (jsonb_typeof("trip_decks"."deck") = 'array' AND jsonb_array_length("trip_decks"."deck") = 10)
);
--> statement-breakpoint
ALTER TABLE "trip_decks" ADD CONSTRAINT "trip_decks_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Hand edit: a dealt deck is never changed (pattern of 0011, 0024 and 0027; drizzle-kit does not model triggers, so the snapshot is unaffected).
-- UPDATE and TRUNCATE are refused; a DELETE only through the ON DELETE CASCADE of its Trip (and so of the player): the parent Trip row is
-- already gone when the cascade's row trigger fires. A guard against bugs only: the application's database role owns the table and could
-- disable it, and no code under src/ does (test/no-trigger-disable.test.ts).
CREATE FUNCTION "trip_decks_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "trips" WHERE "id" = OLD."trip_id") THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'trip_decks rows are immutable (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trip_decks_guard" BEFORE UPDATE OR DELETE ON "trip_decks" FOR EACH ROW EXECUTE FUNCTION "trip_decks_guard"();--> statement-breakpoint
CREATE TRIGGER "trip_decks_no_truncate" BEFORE TRUNCATE ON "trip_decks" FOR EACH STATEMENT EXECUTE FUNCTION "append_only_refuse"();
