CREATE TABLE "account_roles" (
	"principal" text NOT NULL,
	"role" text NOT NULL,
	"state" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"note" text,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "account_roles_pk" PRIMARY KEY("principal","role"),
	CONSTRAINT "account_roles_role_check" CHECK ("account_roles"."role" IN ('player', 'photographer', 'admin')),
	CONSTRAINT "account_roles_state_check" CHECK ("account_roles"."state" IN ('pending', 'active', 'rejected', 'revoked')),
	CONSTRAINT "account_roles_decided_check" CHECK (("account_roles"."state" = 'pending' AND "account_roles"."decided_at" IS NULL AND "account_roles"."decided_by" IS NULL) OR ("account_roles"."state" <> 'pending' AND "account_roles"."decided_at" IS NOT NULL AND "account_roles"."decided_by" IS NOT NULL)),
	CONSTRAINT "account_roles_pending_role_check" CHECK ("account_roles"."state" <> 'pending' OR "account_roles"."role" = 'photographer'),
	CONSTRAINT "account_roles_revision_check" CHECK ("account_roles"."revision" >= 1),
	CONSTRAINT "account_roles_principal_check" CHECK (length("account_roles"."principal") BETWEEN 1 AND 256),
	CONSTRAINT "account_roles_decided_by_check" CHECK ("account_roles"."decided_by" IS NULL OR length("account_roles"."decided_by") BETWEEN 1 AND 256),
	CONSTRAINT "account_roles_note_check" CHECK ("account_roles"."note" IS NULL OR length("account_roles"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "admin_audit" DROP CONSTRAINT "admin_audit_action_check";--> statement-breakpoint
CREATE INDEX "account_roles_pending_queue" ON "account_roles" USING btree ("requested_at","principal") WHERE "account_roles"."state" = 'pending';--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_action_check" CHECK ("admin_audit"."action" IN ('content_import', 'content_publish', 'content_edit', 'content_retire', 'content_restore', 'role_request', 'role_approve', 'role_reject', 'role_grant', 'role_revoke'));