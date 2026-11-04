CREATE TABLE "store_accounts" (
	"player_id" text PRIMARY KEY NOT NULL,
	"commerce_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_accounts_commerce_token_unique" UNIQUE("commerce_token")
);
--> statement-breakpoint
CREATE TABLE "store_claims" (
	"store" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_claims_pk" PRIMARY KEY("store","kind","ref"),
	CONSTRAINT "store_claims_store_check" CHECK ("store_claims"."store" IN ('apple', 'google')),
	CONSTRAINT "store_claims_kind_check" CHECK ("store_claims"."kind" IN ('transaction', 'subscription'))
);
--> statement-breakpoint
CREATE TABLE "store_products" (
	"product_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"hints" integer,
	"pass_period" text,
	"title" text NOT NULL,
	"demo" boolean NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_products_product_id_check" CHECK ("store_products"."product_id" ~ '^[a-z0-9][a-z0-9._]{0,99}$'),
	CONSTRAINT "store_products_kind_check" CHECK ("store_products"."kind" IN ('hint_pack', 'first_class_pass')),
	CONSTRAINT "store_products_pass_period_check" CHECK ("store_products"."pass_period" IN ('P1M', 'P1Y')),
	CONSTRAINT "store_products_status_check" CHECK ("store_products"."status" IN ('active', 'retired')),
	CONSTRAINT "store_products_title_check" CHECK (length("store_products"."title") BETWEEN 1 AND 100),
	CONSTRAINT "store_products_version_check" CHECK ("store_products"."version" >= 1),
	CONSTRAINT "store_products_kind_rule_check" CHECK (("store_products"."kind" = 'hint_pack' AND "store_products"."hints" IS NOT NULL AND "store_products"."hints" BETWEEN 1 AND 1000 AND "store_products"."pass_period" IS NULL) OR ("store_products"."kind" = 'first_class_pass' AND "store_products"."hints" IS NULL AND "store_products"."pass_period" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "store_subscriptions" (
	"store" text NOT NULL,
	"original_ref" text NOT NULL,
	"player_id" text NOT NULL,
	"product_id" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_subscriptions_pk" PRIMARY KEY("store","original_ref"),
	CONSTRAINT "store_subscriptions_store_check" CHECK ("store_subscriptions"."store" IN ('apple', 'google')),
	CONSTRAINT "store_subscriptions_status_check" CHECK ("store_subscriptions"."status" IN ('active', 'grace', 'billing_retry', 'on_hold', 'expired', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "store_transactions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "store_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store" text NOT NULL,
	"transaction_ref" text NOT NULL,
	"player_id" text NOT NULL,
	"product_id" text NOT NULL,
	"kind" text NOT NULL,
	"environment" text NOT NULL,
	"order_id" text,
	"original_ref" text,
	"purchased_at" timestamp with time zone NOT NULL,
	"granted_hints" integer,
	"granted_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_transactions_store_check" CHECK ("store_transactions"."store" IN ('apple', 'google')),
	CONSTRAINT "store_transactions_kind_check" CHECK ("store_transactions"."kind" IN ('hint_pack', 'first_class_pass')),
	CONSTRAINT "store_transactions_environment_check" CHECK ("store_transactions"."environment" IN ('production', 'sandbox', 'fake')),
	CONSTRAINT "store_transactions_granted_hints_check" CHECK ("store_transactions"."granted_hints" IS NULL OR "store_transactions"."granted_hints" > 0),
	CONSTRAINT "store_transactions_kind_rule_check" CHECK (("store_transactions"."kind" = 'hint_pack' AND "store_transactions"."granted_hints" IS NOT NULL AND "store_transactions"."granted_until" IS NULL AND "store_transactions"."original_ref" IS NULL) OR ("store_transactions"."kind" = 'first_class_pass' AND "store_transactions"."granted_hints" IS NULL AND "store_transactions"."granted_until" IS NOT NULL AND "store_transactions"."original_ref" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "admin_audit" DROP CONSTRAINT "admin_audit_action_check";--> statement-breakpoint
ALTER TABLE "hint_ledger" DROP CONSTRAINT "hint_ledger_kind_check";--> statement-breakpoint
ALTER TABLE "store_accounts" ADD CONSTRAINT "store_accounts_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_subscriptions" ADD CONSTRAINT "store_subscriptions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_subscriptions" ADD CONSTRAINT "store_subscriptions_product_id_store_products_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."store_products"("product_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_transactions" ADD CONSTRAINT "store_transactions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_transactions" ADD CONSTRAINT "store_transactions_product_id_store_products_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."store_products"("product_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_subscriptions_player" ON "store_subscriptions" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_transactions_store_ref" ON "store_transactions" USING btree ("store","transaction_ref");--> statement-breakpoint
CREATE INDEX "store_transactions_player" ON "store_transactions" USING btree ("player_id");--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_action_check" CHECK ("admin_audit"."action" IN ('content_import', 'content_publish', 'content_edit', 'content_retire', 'content_restore', 'role_request', 'role_approve', 'role_reject', 'role_grant', 'role_revoke', 'role_block', 'role_unblock', 'role_email_edit', 'media_upload', 'media_version', 'media_edit', 'media_publish', 'media_withdraw', 'content_media_link', 'media_rights', 'media_import', 'store_product_create', 'store_product_edit', 'store_product_retire', 'store_product_restore'));--> statement-breakpoint
ALTER TABLE "hint_ledger" ADD CONSTRAINT "hint_ledger_kind_check" CHECK ("hint_ledger"."kind" IN ('starter', 'hint_pack', 'round_spend', 'trip_grant', 'day_streak_grant', 'store_purchase'));