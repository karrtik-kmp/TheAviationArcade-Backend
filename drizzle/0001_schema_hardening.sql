DROP INDEX "rounds_open";--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_one_open_per_player" ON "rounds" USING btree ("player_id") WHERE "rounds"."status" = 'open';--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_version_check" CHECK ("players"."version" >= 1);--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_error_count_check" CHECK ("rounds"."error_count" IS NULL OR "rounds"."error_count" >= 0);--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_time_remaining_check" CHECK ("rounds"."time_remaining" IS NULL OR "rounds"."time_remaining" BETWEEN 0 AND 1);--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_sp_awarded_check" CHECK ("rounds"."sp_awarded" IS NULL OR "rounds"."sp_awarded" >= 0);--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_miles_awarded_check" CHECK ("rounds"."miles_awarded" IS NULL OR "rounds"."miles_awarded" >= 0);--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_streak_miles_check" CHECK ("rounds"."streak_miles" IS NULL OR "rounds"."streak_miles" >= 0);--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_expires_after_issue_check" CHECK ("rounds"."expires_at" > "rounds"."issued_at");