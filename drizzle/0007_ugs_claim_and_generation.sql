CREATE SEQUENCE "public"."ugs_mirror_generation_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "ugs_mirror_outbox" ALTER COLUMN "generation" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ugs_mirror_outbox" ALTER COLUMN "generation" SET DEFAULT nextval('ugs_mirror_generation_seq');--> statement-breakpoint
ALTER TABLE "ugs_mirror_deletions" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
ALTER TABLE "ugs_mirror_outbox" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
-- Existing rows (dev databases only) keep their generation; the sequence continues above them.
SELECT setval('"public"."ugs_mirror_generation_seq"', GREATEST(1, COALESCE((SELECT max("generation") FROM "ugs_mirror_outbox"), 0) + 1), false);
