CREATE TABLE "content_drafts" (
	"name" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"edits" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "content_drafts_name_check" CHECK ("content_drafts"."name" IN ('field-awards', 'clipper-cards', 'aircraft-tags')),
	CONSTRAINT "content_drafts_version_check" CHECK ("content_drafts"."version" >= 1),
	CONSTRAINT "content_drafts_edits_check" CHECK ("content_drafts"."edits" @> '{}'::jsonb),
	CONSTRAINT "content_drafts_updated_by_check" CHECK (length("content_drafts"."updated_by") BETWEEN 1 AND 256)
);
--> statement-breakpoint
ALTER TABLE "admin_audit" DROP CONSTRAINT "admin_audit_action_check";--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_action_check" CHECK ("admin_audit"."action" IN ('content_import', 'content_publish'));