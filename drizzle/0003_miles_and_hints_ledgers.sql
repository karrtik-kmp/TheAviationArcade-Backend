CREATE TABLE "hint_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hint_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" text NOT NULL,
	"delta" integer NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hint_ledger_delta_check" CHECK ("hint_ledger"."delta" <> 0),
	CONSTRAINT "hint_ledger_kind_check" CHECK ("hint_ledger"."kind" IN ('starter', 'hint_pack', 'round_spend'))
);
--> statement-breakpoint
CREATE TABLE "miles_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "miles_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" text NOT NULL,
	"delta" integer NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "miles_ledger_delta_check" CHECK ("miles_ledger"."delta" <> 0),
	CONSTRAINT "miles_ledger_kind_check" CHECK ("miles_ledger"."kind" IN ('round_award', 'hint_pack'))
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "hints" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "hint_used" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hint_ledger" ADD CONSTRAINT "hint_ledger_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "miles_ledger" ADD CONSTRAINT "miles_ledger_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hint_ledger_idempotency" ON "hint_ledger" USING btree ("player_id","kind","ref");--> statement-breakpoint
CREATE INDEX "hint_ledger_player_time" ON "hint_ledger" USING btree ("player_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "miles_ledger_idempotency" ON "miles_ledger" USING btree ("player_id","kind","ref");--> statement-breakpoint
CREATE INDEX "miles_ledger_player_time" ON "miles_ledger" USING btree ("player_id","created_at");--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_hints_check" CHECK ("players"."hints" >= 0);--> statement-breakpoint
-- Backfill (hand-written): existing players never received starter hints, so they get STARTER_HINTS (5),
-- and every banked Round that paid Miles gets its round_award ledger row.
UPDATE "players" SET "hints" = 5;--> statement-breakpoint
INSERT INTO "hint_ledger" ("player_id", "delta", "kind", "ref", "created_at")
SELECT "id", 5, 'starter', 'starter', "created_at" FROM "players";--> statement-breakpoint
INSERT INTO "miles_ledger" ("player_id", "delta", "kind", "ref", "created_at")
SELECT "player_id", "miles_awarded", 'round_award', "id", COALESCE("completed_at", "issued_at")
FROM "rounds" WHERE "status" = 'completed' AND "miles_awarded" > 0;
