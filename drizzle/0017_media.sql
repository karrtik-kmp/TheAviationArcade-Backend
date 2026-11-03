CREATE TABLE "media_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "media_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner" text NOT NULL,
	"state" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"draft_version" integer NOT NULL,
	"published_version" integer,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "media_items_owner_check" CHECK (length("media_items"."owner") BETWEEN 1 AND 256),
	CONSTRAINT "media_items_state_check" CHECK ("media_items"."state" IN ('unverified', 'published', 'withdrawn')),
	CONSTRAINT "media_items_revision_check" CHECK ("media_items"."revision" >= 1),
	CONSTRAINT "media_items_draft_version_check" CHECK ("media_items"."draft_version" >= 1),
	CONSTRAINT "media_items_published_version_check" CHECK ("media_items"."published_version" IS NULL OR "media_items"."published_version" BETWEEN 1 AND "media_items"."draft_version"),
	CONSTRAINT "media_items_published_state_check" CHECK (("media_items"."state" = 'published') = ("media_items"."published_version" IS NOT NULL)),
	CONSTRAINT "media_items_created_by_check" CHECK (length("media_items"."created_by") BETWEEN 1 AND 256),
	CONSTRAINT "media_items_updated_by_check" CHECK (length("media_items"."updated_by") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE TABLE "media_upload_keys" (
	"principal" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation" text NOT NULL,
	"media_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "media_upload_keys_pk" PRIMARY KEY("principal","idempotency_key"),
	CONSTRAINT "media_upload_keys_principal_check" CHECK (length("media_upload_keys"."principal") BETWEEN 1 AND 256),
	CONSTRAINT "media_upload_keys_idempotency_key_check" CHECK ("media_upload_keys"."idempotency_key" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "media_upload_keys_operation_check" CHECK ("media_upload_keys"."operation" IN ('create', 'version')),
	CONSTRAINT "media_upload_keys_sha256_check" CHECK ("media_upload_keys"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "media_versions" (
	"media_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"credit_name" text,
	"credit_required" boolean NOT NULL,
	"licence_name" text,
	"licence_url" text,
	"source_url" text,
	"attribution_text" text,
	"published_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "media_versions_pk" PRIMARY KEY("media_id","version"),
	CONSTRAINT "media_versions_version_check" CHECK ("media_versions"."version" >= 1),
	CONSTRAINT "media_versions_sha256_check" CHECK ("media_versions"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_versions_content_type_check" CHECK ("media_versions"."content_type" IN ('image/jpeg', 'image/png')),
	CONSTRAINT "media_versions_byte_size_check" CHECK ("media_versions"."byte_size" BETWEEN 1 AND 5242880),
	CONSTRAINT "media_versions_width_check" CHECK ("media_versions"."width" BETWEEN 1 AND 4096),
	CONSTRAINT "media_versions_height_check" CHECK ("media_versions"."height" BETWEEN 1 AND 4096),
	CONSTRAINT "media_versions_credit_name_check" CHECK ("media_versions"."credit_name" IS NULL OR length("media_versions"."credit_name") BETWEEN 1 AND 200),
	CONSTRAINT "media_versions_licence_name_check" CHECK ("media_versions"."licence_name" IS NULL OR length("media_versions"."licence_name") BETWEEN 1 AND 200),
	CONSTRAINT "media_versions_licence_url_check" CHECK ("media_versions"."licence_url" IS NULL OR ("media_versions"."licence_url" ~ '^https?://' AND length("media_versions"."licence_url") <= 2048)),
	CONSTRAINT "media_versions_source_url_check" CHECK ("media_versions"."source_url" IS NULL OR ("media_versions"."source_url" ~ '^https?://' AND length("media_versions"."source_url") <= 2048)),
	CONSTRAINT "media_versions_attribution_check" CHECK ("media_versions"."attribution_text" IS NULL OR length("media_versions"."attribution_text") <= 1000),
	CONSTRAINT "media_versions_created_by_check" CHECK (length("media_versions"."created_by") BETWEEN 1 AND 256),
	CONSTRAINT "media_versions_publishable_check" CHECK ("media_versions"."published_at" IS NULL OR ("media_versions"."licence_name" IS NOT NULL AND (NOT "media_versions"."credit_required" OR "media_versions"."credit_name" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "admin_audit" DROP CONSTRAINT "admin_audit_action_check";--> statement-breakpoint
ALTER TABLE "account_roles" ADD COLUMN "request_email" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "media_id" bigint;--> statement-breakpoint
ALTER TABLE "media_upload_keys" ADD CONSTRAINT "media_upload_keys_version_fk" FOREIGN KEY ("media_id","version") REFERENCES "public"."media_versions"("media_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_versions" ADD CONSTRAINT "media_versions_media_id_media_items_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_items_owner_id" ON "media_items" USING btree ("owner","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "media_items_state_id" ON "media_items" USING btree ("state","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "media_versions_sha256" ON "media_versions" USING btree ("sha256");--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_media_id_media_items_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_items_media_id" ON "content_items" USING btree ("media_id");--> statement-breakpoint
ALTER TABLE "account_roles" ADD CONSTRAINT "account_roles_request_email_check" CHECK ("account_roles"."request_email" IS NULL OR length("account_roles"."request_email") BETWEEN 3 AND 320);--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_action_check" CHECK ("admin_audit"."action" IN ('content_import', 'content_publish', 'content_edit', 'content_retire', 'content_restore', 'role_request', 'role_approve', 'role_reject', 'role_grant', 'role_revoke', 'media_upload', 'media_version', 'media_edit', 'media_publish', 'media_withdraw', 'content_media_link'));