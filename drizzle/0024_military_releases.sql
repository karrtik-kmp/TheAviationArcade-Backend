CREATE TABLE "content_release_activations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "content_release_activations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"module" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"release_version" integer NOT NULL,
	"history" integer[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"note" text,
	CONSTRAINT "content_release_activations_module_check" CHECK ("content_release_activations"."module" IN ('airport-spotter', 'atc-match', 'call-sign-match', 'identifier',
  'aircraft-identifier-military', 'code-search', 'runway-identifier', 'tail-identifier')),
	CONSTRAINT "content_release_activations_sequence_check" CHECK ("content_release_activations"."sequence" >= 1),
	CONSTRAINT "content_release_activations_kind_check" CHECK ("content_release_activations"."kind" IN ('activate', 'restore')),
	CONSTRAINT "content_release_activations_created_by_check" CHECK (length("content_release_activations"."created_by") BETWEEN 1 AND 256),
	CONSTRAINT "content_release_activations_note_check" CHECK ("content_release_activations"."note" IS NULL OR length("content_release_activations"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "content_release_items" (
	"module" text NOT NULL,
	"release_version" integer NOT NULL,
	"item_id" text NOT NULL,
	"item_version" integer NOT NULL,
	"position" integer NOT NULL,
	"rank" text NOT NULL,
	"card_key" text,
	"media_id" bigint NOT NULL,
	"media_version" integer NOT NULL,
	"photo_sha256" text NOT NULL,
	"credit" text,
	"deal" jsonb NOT NULL,
	CONSTRAINT "content_release_items_pk" PRIMARY KEY("module","release_version","item_id"),
	CONSTRAINT "content_release_items_item_version_check" CHECK ("content_release_items"."item_version" >= 1),
	CONSTRAINT "content_release_items_position_check" CHECK ("content_release_items"."position" >= 1),
	CONSTRAINT "content_release_items_rank_check" CHECK ("content_release_items"."rank" IN ('trainee', 'first-officer', 'captain', 'check-airman', 'chief-pilot')),
	CONSTRAINT "content_release_items_media_version_check" CHECK ("content_release_items"."media_version" >= 1),
	CONSTRAINT "content_release_items_sha256_check" CHECK ("content_release_items"."photo_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "content_release_items_credit_check" CHECK ("content_release_items"."credit" IS NULL OR length("content_release_items"."credit") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "content_releases" (
	"module" text NOT NULL,
	"version" integer NOT NULL,
	"basis" text NOT NULL,
	"item_count" integer NOT NULL,
	"deal_rule" text NOT NULL,
	"flight_kind" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"note" text,
	CONSTRAINT "content_releases_pk" PRIMARY KEY("module","version"),
	CONSTRAINT "content_releases_module_check" CHECK ("content_releases"."module" IN ('airport-spotter', 'atc-match', 'call-sign-match', 'identifier',
  'aircraft-identifier-military', 'code-search', 'runway-identifier', 'tail-identifier')),
	CONSTRAINT "content_releases_version_check" CHECK ("content_releases"."version" >= 1),
	CONSTRAINT "content_releases_basis_check" CHECK (length("content_releases"."basis") BETWEEN 1 AND 65536),
	CONSTRAINT "content_releases_item_count_check" CHECK ("content_releases"."item_count" BETWEEN 1 AND 2000),
	CONSTRAINT "content_releases_deal_rule_check" CHECK ("content_releases"."deal_rule" IN ('nearest-ranks')),
	CONSTRAINT "content_releases_flight_kind_check" CHECK ("content_releases"."flight_kind" IN ('choice')),
	CONSTRAINT "content_releases_created_by_check" CHECK (length("content_releases"."created_by") BETWEEN 1 AND 256),
	CONSTRAINT "content_releases_note_check" CHECK ("content_releases"."note" IS NULL OR length("content_releases"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "admin_audit" DROP CONSTRAINT "admin_audit_action_check";--> statement-breakpoint
ALTER TABLE "content_release_activations" ADD CONSTRAINT "content_release_activations_release_fk" FOREIGN KEY ("module","release_version") REFERENCES "public"."content_releases"("module","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_release_items" ADD CONSTRAINT "content_release_items_release_fk" FOREIGN KEY ("module","release_version") REFERENCES "public"."content_releases"("module","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_release_items" ADD CONSTRAINT "content_release_items_media_fk" FOREIGN KEY ("media_id","media_version") REFERENCES "public"."media_versions"("media_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_release_activations_sequence" ON "content_release_activations" USING btree ("module","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "content_release_items_position" ON "content_release_items" USING btree ("module","release_version","position");--> statement-breakpoint
CREATE UNIQUE INDEX "content_release_items_photo" ON "content_release_items" USING btree ("module","release_version","photo_sha256");--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_action_check" CHECK ("admin_audit"."action" IN ('content_import', 'content_publish', 'content_edit', 'content_retire', 'content_restore', 'role_request', 'role_approve', 'role_reject', 'role_grant', 'role_revoke', 'role_block', 'role_unblock', 'role_email_edit', 'media_upload', 'media_version', 'media_edit', 'media_publish', 'media_withdraw', 'content_media_link', 'media_rights', 'media_import', 'store_product_create', 'store_product_edit', 'store_product_retire', 'store_product_restore', 'editorial_create', 'editorial_save', 'content_prepare', 'release_create', 'release_activate', 'release_restore'));
--> statement-breakpoint
-- Hand-added to the generated file (drizzle-kit does not model triggers; the snapshot is unaffected), following 0011: the three
-- release tables never change after insert. content_releases and content_release_items are insert-only (a release is frozen);
-- content_release_activations is append-only (the pointer is its newest row). A test that needs to remove rows it inserted must
-- DISABLE these triggers itself, in its own cleanup.
CREATE FUNCTION "content_release_rows_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% rows are immutable (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "content_releases_immutable" BEFORE UPDATE OR DELETE ON "content_releases" FOR EACH ROW EXECUTE FUNCTION "content_release_rows_immutable"();
--> statement-breakpoint
CREATE TRIGGER "content_release_items_immutable" BEFORE UPDATE OR DELETE ON "content_release_items" FOR EACH ROW EXECUTE FUNCTION "content_release_rows_immutable"();
--> statement-breakpoint
CREATE TRIGGER "content_release_activations_immutable" BEFORE UPDATE OR DELETE ON "content_release_activations" FOR EACH ROW EXECUTE FUNCTION "content_release_rows_immutable"();
--> statement-breakpoint
-- TRUNCATE skips row triggers, so each table also refuses it (statement-level trigger, same function).
CREATE TRIGGER "content_releases_no_truncate" BEFORE TRUNCATE ON "content_releases" FOR EACH STATEMENT EXECUTE FUNCTION "content_release_rows_immutable"();
--> statement-breakpoint
CREATE TRIGGER "content_release_items_no_truncate" BEFORE TRUNCATE ON "content_release_items" FOR EACH STATEMENT EXECUTE FUNCTION "content_release_rows_immutable"();
--> statement-breakpoint
CREATE TRIGGER "content_release_activations_no_truncate" BEFORE TRUNCATE ON "content_release_activations" FOR EACH STATEMENT EXECUTE FUNCTION "content_release_rows_immutable"();
