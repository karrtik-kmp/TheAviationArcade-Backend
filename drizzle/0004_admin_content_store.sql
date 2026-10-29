CREATE TABLE "admin_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "admin_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_audit_action_check" CHECK ("admin_audit"."action" IN ('content_import'))
);
--> statement-breakpoint
CREATE TABLE "content_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"module" text NOT NULL,
	"file_name" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"blob_key" text NOT NULL,
	"created" integer NOT NULL,
	"updated" integer NOT NULL,
	"unchanged" integer NOT NULL,
	"imported_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "content_imports_module_check" CHECK ("content_imports"."module" IN ('airport-spotter', 'atc-match', 'call-sign-match', 'identifier',
  'aircraft-identifier-military', 'code-search', 'runway-identifier', 'tail-identifier')),
	CONSTRAINT "content_imports_sha256_check" CHECK ("content_imports"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "content_imports_byte_size_check" CHECK ("content_imports"."byte_size" > 0),
	CONSTRAINT "content_imports_counts_check" CHECK ("content_imports"."created" >= 0 AND "content_imports"."updated" >= 0 AND "content_imports"."unchanged" >= 0)
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"module" text NOT NULL,
	"id" text NOT NULL,
	"rank" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"import_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "content_items_pk" PRIMARY KEY("module","id"),
	CONSTRAINT "content_items_module_check" CHECK ("content_items"."module" IN ('airport-spotter', 'atc-match', 'call-sign-match', 'identifier',
  'aircraft-identifier-military', 'code-search', 'runway-identifier', 'tail-identifier')),
	CONSTRAINT "content_items_rank_check" CHECK ("content_items"."rank" IN ('trainee', 'first-officer', 'captain', 'check-airman', 'chief-pilot')),
	CONSTRAINT "content_items_status_check" CHECK ("content_items"."status" IN ('approved')),
	CONSTRAINT "content_items_source_check" CHECK ("content_items"."source" IN ('client_sheet', 'admin')),
	CONSTRAINT "content_items_version_check" CHECK ("content_items"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_import_id_content_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."content_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_imports_module_sha256" ON "content_imports" USING btree ("module","sha256");