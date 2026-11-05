CREATE TABLE "editorial_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "editorial_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"media_id" bigint NOT NULL,
	"status" text NOT NULL,
	"date_key" date,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "editorial_items_kind_check" CHECK ("editorial_items"."kind" IN ('identifier', 'plane-of-the-day')),
	CONSTRAINT "editorial_items_status_check" CHECK ("editorial_items"."status" IN ('draft', 'scheduled', 'published', 'archived')),
	CONSTRAINT "editorial_items_version_check" CHECK ("editorial_items"."version" >= 1),
	CONSTRAINT "editorial_items_created_by_check" CHECK (length("editorial_items"."created_by") BETWEEN 1 AND 256),
	CONSTRAINT "editorial_items_updated_by_check" CHECK (length("editorial_items"."updated_by") BETWEEN 1 AND 256),
	CONSTRAINT "editorial_items_identifier_rule_check" CHECK ("editorial_items"."kind" <> 'identifier' OR ("editorial_items"."date_key" IS NULL AND "editorial_items"."status" <> 'scheduled')),
	CONSTRAINT "editorial_items_potd_rule_check" CHECK ("editorial_items"."kind" <> 'plane-of-the-day' OR ("editorial_items"."status" <> 'scheduled' AND "editorial_items"."status" <> 'published') OR "editorial_items"."date_key" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "admin_audit" DROP CONSTRAINT "admin_audit_action_check";--> statement-breakpoint
ALTER TABLE "editorial_items" ADD CONSTRAINT "editorial_items_media_id_media_items_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "editorial_items_kind_date" ON "editorial_items" USING btree ("kind","date_key" DESC NULLS LAST) WHERE "editorial_items"."status" IN ('scheduled', 'published');--> statement-breakpoint
CREATE INDEX "editorial_items_kind_updated" ON "editorial_items" USING btree ("kind","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "editorial_items_media_id" ON "editorial_items" USING btree ("media_id");--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_action_check" CHECK ("admin_audit"."action" IN ('content_import', 'content_publish', 'content_edit', 'content_retire', 'content_restore', 'role_request', 'role_approve', 'role_reject', 'role_grant', 'role_revoke', 'role_block', 'role_unblock', 'role_email_edit', 'media_upload', 'media_version', 'media_edit', 'media_publish', 'media_withdraw', 'content_media_link', 'media_rights', 'media_import', 'store_product_create', 'store_product_edit', 'store_product_retire', 'store_product_restore', 'editorial_create', 'editorial_save'));