CREATE TABLE "media_imports" (
	"source_system" text NOT NULL,
	"source_id" text NOT NULL,
	"media_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"sha256" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "media_imports_pk" PRIMARY KEY("source_system","source_id"),
	CONSTRAINT "media_imports_media_id_unique" UNIQUE("media_id"),
	CONSTRAINT "media_imports_source_system_check" CHECK ("media_imports"."source_system" = 'd1'),
	CONSTRAINT "media_imports_source_id_check" CHECK (length("media_imports"."source_id") BETWEEN 1 AND 128),
	CONSTRAINT "media_imports_owner_check" CHECK (length("media_imports"."owner") BETWEEN 1 AND 256),
	CONSTRAINT "media_imports_sha256_check" CHECK ("media_imports"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "admin_audit" DROP CONSTRAINT "admin_audit_action_check";--> statement-breakpoint
ALTER TABLE "media_versions" DROP CONSTRAINT "media_versions_publishable_check";--> statement-breakpoint
ALTER TABLE "media_versions" ADD COLUMN "rights_statement" text;--> statement-breakpoint
ALTER TABLE "media_versions" ADD COLUMN "rights_stated_by" text;--> statement-breakpoint
ALTER TABLE "media_versions" ADD COLUMN "rights_stated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_versions" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "media_imports" ADD CONSTRAINT "media_imports_media_id_media_items_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_action_check" CHECK ("admin_audit"."action" IN ('content_import', 'content_publish', 'content_edit', 'content_retire', 'content_restore', 'role_request', 'role_approve', 'role_reject', 'role_grant', 'role_revoke', 'role_block', 'role_unblock', 'role_email_edit', 'media_upload', 'media_version', 'media_edit', 'media_publish', 'media_withdraw', 'content_media_link', 'media_rights', 'media_import'));--> statement-breakpoint
ALTER TABLE "media_versions" ADD CONSTRAINT "media_versions_rights_statement_check" CHECK ("media_versions"."rights_statement" IN ('v1_own', 'v1_authorised', 'd1_private_review'));--> statement-breakpoint
ALTER TABLE "media_versions" ADD CONSTRAINT "media_versions_rights_all_or_none_check" CHECK (("media_versions"."rights_statement" IS NULL) = ("media_versions"."rights_stated_by" IS NULL) AND ("media_versions"."rights_statement" IS NULL) = ("media_versions"."rights_stated_at" IS NULL));--> statement-breakpoint
ALTER TABLE "media_versions" ADD CONSTRAINT "media_versions_description_check" CHECK ("media_versions"."description" IS NULL OR length("media_versions"."description") BETWEEN 1 AND 2000);--> statement-breakpoint
-- Hand edit (drizzle cannot emit NOT VALID): media versions published before this migration have no rights statement, so the
-- re-added constraint must not be checked against them. NOT VALID still enforces it on every INSERT and UPDATE from now on
-- (an UPDATE of an old published row must satisfy it, which is why the service refuses to publish without a statement first).
-- Do not VALIDATE it until those rows are backfilled or retired.
ALTER TABLE "media_versions" ADD CONSTRAINT "media_versions_publishable_check" CHECK ("media_versions"."published_at" IS NULL OR ("media_versions"."licence_name" IS NOT NULL AND (NOT "media_versions"."credit_required" OR "media_versions"."credit_name" IS NOT NULL) AND "media_versions"."rights_statement" IS NOT NULL AND "media_versions"."rights_statement" IN ('v1_own', 'v1_authorised'))) NOT VALID;