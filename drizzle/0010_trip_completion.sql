CREATE TABLE "player_clipper_cards" (
	"player_id" text NOT NULL,
	"card_key" text NOT NULL,
	"module" text NOT NULL,
	"first_collected_at" timestamp with time zone NOT NULL,
	"first_trip_id" uuid NOT NULL,
	"times_identified" integer NOT NULL,
	"ever_perfect" boolean NOT NULL,
	"ever_hint_free" boolean NOT NULL,
	"fastest_correct_ms" integer,
	CONSTRAINT "player_clipper_cards_player_id_card_key_pk" PRIMARY KEY("player_id","card_key"),
	CONSTRAINT "player_clipper_cards_module_check" CHECK ("player_clipper_cards"."module" IN ('identifier', 'aircraft-identifier-military')),
	CONSTRAINT "player_clipper_cards_key_check" CHECK (length("player_clipper_cards"."card_key") BETWEEN 1 AND 512),
	CONSTRAINT "player_clipper_cards_times_check" CHECK ("player_clipper_cards"."times_identified" >= 1),
	CONSTRAINT "player_clipper_cards_fastest_check" CHECK ("player_clipper_cards"."fastest_correct_ms" IS NULL OR "player_clipper_cards"."fastest_correct_ms" BETWEEN 0 AND 1800000)
);
--> statement-breakpoint
CREATE TABLE "player_field_awards" (
	"player_id" text NOT NULL,
	"award_id" text NOT NULL,
	"earned_at" timestamp with time zone NOT NULL,
	"trip_id" uuid NOT NULL,
	"catalog_version" integer NOT NULL,
	CONSTRAINT "player_field_awards_player_id_award_id_pk" PRIMARY KEY("player_id","award_id"),
	CONSTRAINT "player_field_awards_award_id_check" CHECK ("player_field_awards"."award_id" IN ('first-flight', 'frequent-flyer', 'century', 'sharp-eyes', 'flawless-five', 'five-in-a-row', 'week-on-the-line', 'regular', 'first-card', 'collector', 'textbook', 'high-flyer', 'coast-to-coast', 'no-instrument-flight', 'red-eye-special', 'fleet-admiral', 'centennial-streak', 'go-around', 'globe-trotter', 'quad-engine-royalty', 'the-great-rivalry', 'heavy-metal', 'regional', 'bogey-identified', 'top-gun-ace', 'rotorhead', 'vertical-horizon', 'executive-platinum')),
	CONSTRAINT "player_field_awards_catalog_version_check" CHECK ("player_field_awards"."catalog_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "player_clipper_cards" ADD CONSTRAINT "player_clipper_cards_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_field_awards" ADD CONSTRAINT "player_field_awards_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_clipper_cards_first_trip" ON "player_clipper_cards" USING btree ("player_id","first_trip_id");--> statement-breakpoint
CREATE INDEX "player_field_awards_trip" ON "player_field_awards" USING btree ("player_id","trip_id");