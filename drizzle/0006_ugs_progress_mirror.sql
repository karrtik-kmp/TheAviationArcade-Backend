CREATE TABLE "ugs_links" (
	"player_id" text PRIMARY KEY NOT NULL,
	"ugs_player_id" text NOT NULL,
	"linked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ugs_mirror_deletions" (
	"ugs_player_id" text PRIMARY KEY NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ugs_mirror_deletions_last_error_check" CHECK ("ugs_mirror_deletions"."last_error" IS NULL OR length("ugs_mirror_deletions"."last_error") <= 80)
);
--> statement-breakpoint
CREATE TABLE "ugs_mirror_outbox" (
	"player_id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "ugs_mirror_outbox_attempts_check" CHECK ("ugs_mirror_outbox"."attempts" >= 0),
	CONSTRAINT "ugs_mirror_outbox_last_error_check" CHECK ("ugs_mirror_outbox"."last_error" IS NULL OR length("ugs_mirror_outbox"."last_error") <= 80)
);
--> statement-breakpoint
ALTER TABLE "ugs_links" ADD CONSTRAINT "ugs_links_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ugs_mirror_outbox" ADD CONSTRAINT "ugs_mirror_outbox_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ugs_links_ugs_player_id" ON "ugs_links" USING btree ("ugs_player_id");--> statement-breakpoint
CREATE INDEX "ugs_mirror_deletions_due" ON "ugs_mirror_deletions" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "ugs_mirror_outbox_due" ON "ugs_mirror_outbox" USING btree ("due_at");