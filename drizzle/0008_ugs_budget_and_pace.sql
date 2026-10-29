CREATE TABLE "ugs_budget" (
	"name" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"refilled_at" timestamp with time zone NOT NULL,
	"paused_until" timestamp with time zone,
	CONSTRAINT "ugs_budget_tokens_check" CHECK ("ugs_budget"."tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ugs_mirror_pace" (
	"player_id" text PRIMARY KEY NOT NULL,
	"ugs_player_id" text NOT NULL,
	"last_mirrored_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ugs_mirror_outbox" ADD COLUMN "urgent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ugs_mirror_pace" ADD CONSTRAINT "ugs_mirror_pace_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;